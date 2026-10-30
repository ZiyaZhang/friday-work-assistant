import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { ExecutorClientError, type ExecutorJobInput, type ExecutorJobReceipt } from '../src/github/executor-client.js'
import { RepositoryExecutions } from '../src/github/executions.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { spaceDeps, dmScope } from './helpers/space.js'

type Observation = 'queued' | 'unknown' | 'cleanup_pending' | 'failed' | 'cancelled' | 'passed'
const tree = 'a'.repeat(40), base = 'b'.repeat(40)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function providerReceipt(id: string, input: ExecutorJobInput, observation: Exclude<Observation, 'unknown'>): ExecutorJobReceipt {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const queued: ExecutorJobReceipt = { version: 1, id, digest, state: 'queued', outcome: null, createdAt: 100,
    startedAt: null, finishedAt: null, deadline: null, cleanup: 'not_started', result: null }
  if (observation === 'queued') return queued
  return { ...queued, state: observation === 'cleanup_pending' ? 'stopping' : 'finished',
    outcome: observation === 'cancelled' ? 'cancelled' : observation === 'failed' ? 'failed' : 'passed',
    cleanup: observation === 'cleanup_pending' ? 'pending' : 'confirmed',
    startedAt: 110, deadline: 1110, finishedAt: observation === 'cleanup_pending' ? null : 120,
    result: observation === 'cancelled' ? null : {
      status: observation === 'failed' ? 'failed' : 'passed', beforeTree: tree, afterTree: tree,
      exitCode: observation === 'failed' ? 1 : 0, runtime: 'v22.19.0', phase: 'command',
      output: { stdout: 'synthetic command result', stderr: '', truncated: false },
    } }
}

/** Real managed host, Task/Work/Run stores, domain receipts and API-call ledger.
 * ACP generation and the remote execution provider are synthetic. */
function fixture(observations: Observation[], omitResolver = false) {
  const home = mkdtempSync(join(tmpdir(), 'friday-execution-outcome-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home,
    FRIDAY_DEFAULT_EXECUTION: 'managed', FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), routines = new RoutineStore(registry.db)
  const sp = spaceDeps(registry.db), feishu = new FakeFeishu(), log = createLogger('execution-outcome-test', 'error')
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_execution', openId: 'ou_alice' })
  registry.setKv(`welcomed:${dm.id}`, 'synthetic-existing-space')
  const managed = managedHostRuntime(registry, home, log)
  let providerCalls = 0
  const executions = new RepositoryExecutions({ db: registry.db,
    async snapshot(actor) { actor.assertAuthorized(); return { repo: 'org/demo', baseSha: base, inputTree: tree, patch: '' } },
    authorize: actor => actor.assertAuthorized,
    client: {
      async submit(id, input, guard) {
        guard()
        const observation = observations[providerCalls++]!
        if (observation === 'unknown') throw new ExecutorClientError('timeout', 'submit', 'unknown')
        return providerReceipt(id, input, observation)
      },
      async read() { throw new Error('No provider read is expected during host completion') },
      async stop() { throw new Error('No provider stop is expected during host completion') },
    },
  })
  const calls = new RunApiCalls(registry.db), ids: string[] = []
  const orchestrator = new Orchestrator({ cfg, registry, memory, routines, ...sp,
    messages: new MessageService(asFeishuClient(feishu), new MessageCache(registry.db), log),
    runtime: managed.runtime, managed: managed.managed, feishu: asFeishuClient(feishu), tokens: new TokenIssuer('synthetic-only'),
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent/server.js', botOpenId: 'ou_bot', log,
    executions: omitResolver ? undefined : executions,
  })
  const inbound: InboundMessage = { eventId: 'ev_execution', messageId: 'om_execution', chatId: 'oc_execution', chatType: 'p2p',
    msgType: 'text', text: '请检查这次仓库修改并告诉我执行结果。', senderOpenId: 'ou_alice', senderType: 'user', mentions: [], createTimeMs: Date.now() }
  managed.peer.state.script = [{ kind: 'hook', run: async () => {
    const acpId = managed.peer.state.allPrompts.at(-1)!.sessionId, session = registry.getSessionByAcpId(acpId)!
    const actor = orchestrator.resolveActorForSession(session.sessionKey)!, taskId = actor.taskId!
    const work = registry.taskWork.get(taskId)!
    for (let index = 0; index < observations.length; index++) {
      const call = calls.begin(actor.runId, 'POST /v1/github/execution/start')
      calls.need(call, 'github:write')
      await executions.start({ cwd: session.cwd, sessionKey: session.sessionKey, requesterOpenId: 'ou_alice',
        workKey: work.key, taskId, runId: actor.runId, assertAuthorized() {
          expect(orchestrator.resolveActorForSession(session.sessionKey)?.runId).toBe(actor.runId)
        }, onExecution(id) { ids.push(id); calls.reference(call, { kind: 'github_execution', id }) } },
      { changeId: 'synthetic-change', expectedSnapshot: tree, command: `npm run check-${index}`, timeoutMs: 1000 })
      // A successful HTTP/tool response does not imply the remote command ended.
      calls.finish(call, 'returned')
    }
  } }, { kind: 'text', text: '这是本轮检查的结果说明。' }]
  cleanups.push(async () => { await managed.runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  return { cfg, registry, memory, feishu, executions, calls, ids, orchestrator, inbound,
    get providerCalls() { return providerCalls },
    result() {
      const task = registry.taskForMessage(inbound.messageId)!
      return new RunAttempts(registry.db).latestForTask(task.id)!
    },
  }
}

describe('repository execution evidence controls host completion', () => {
  it.each(['queued', 'unknown', 'cleanup_pending', 'failed', 'cancelled'] as const)
    ('keeps a returned tool call partial when the actual execution is %s', async observation => {
      const f = fixture([observation])
      await f.orchestrator.handleMessage(f.inbound)
      const attempt = f.result()
      expect(attempt.result).toMatchObject({ outcome: 'partial', reason: 'operation_incomplete' })
      expect(f.calls.forRun(attempt.id)).toEqual([expect.objectContaining({ state: 'returned',
        operations: [{ kind: 'github_execution', id: f.ids[0] }] })])
      expect(f.feishu.reactionsOn(f.inbound.messageId)).not.toContain(f.cfg.feishu.reactions.done)
      expect(f.memory.recent(dmScope('ou_alice'))).toEqual([])
      expect(f.providerCalls).toBe(1)
    })

  it('allows completion only after the real original-input receipt proves pass and confirmed cleanup', async () => {
    const f = fixture(['passed'])
    await f.orchestrator.handleMessage(f.inbound)
    expect(f.executions.operationStatus(f.ids[0]!)).toBe('succeeded')
    expect(f.result().result).toMatchObject({ outcome: 'handled', reason: 'normal_end' })
  })

  it('does not let one passed command erase a different unresolved operation', async () => {
    const f = fixture(['passed', 'unknown'])
    await f.orchestrator.handleMessage(f.inbound)
    expect(new Set(f.ids).size).toBe(2)
    expect(f.result().result).toMatchObject({ outcome: 'partial', reason: 'operation_incomplete' })
    expect(f.calls.unresolvedTaskOperations(f.result().id, ref =>
      f.executions.operationStatus(ref.id) === 'succeeded')).toEqual([{ kind: 'github_execution', id: f.ids[1] }])
  })

  it('does not silently complete a retained execution reference when its domain service is absent', async () => {
    const f = fixture(['passed'], true)
    await f.orchestrator.handleMessage(f.inbound)
    expect(f.result().result).toMatchObject({ outcome: 'partial', reason: 'operation_incomplete' })
  })
})
