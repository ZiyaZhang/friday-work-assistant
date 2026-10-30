import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import type { IngressClassifier } from '../src/acp/ingress-classifier.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { spaceScope } from '../src/core/space.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { deferred } from './helpers/model-agent.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** Actual host routing, SQLite and ACP SDK; classifier/model/platform results are synthetic. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-memory-ingress-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db)
  const sp = spaceDeps(registry.db, { admins: ['alice'] }), space = sp.spaces.ensure({ kind: 'group', chatId: 'group', openId: 'alice' })
  const fake = new FakeFeishu(); fake.members.set('group', new Set(['alice']))
  const log = createLogger('memory-ingress', 'error'), peer = createFakeAgent({ script: [] })
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: peer.app }, log,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  const classify = vi.fn<IngressClassifier['classify']>(async input => input.message.replyToRef
    ? { kind: 'amend', targetRef: input.message.replyToRef } : { kind: 'new_work' })
  const host = new Orchestrator({ cfg, registry, memory, ...sp, runtime, feishu: asFeishuClient(fake),
    ingressClassifier: { classify }, tokens: new TokenIssuer('synthetic'), apiBaseUrl: 'http://127.0.0.1:1',
    mcpServerPath: '/nonexistent', botOpenId: 'bot', log })
  cleanup.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  let serial = 0
  const message = (text: string, parentId?: string): InboundMessage => {
    const id = `synthetic-message-${++serial}`
    return { eventId: id, messageId: id, chatId: 'group', chatType: 'group', threadId: 'topic', tenantId: 'tenant',
      senderOpenId: 'alice', senderType: 'user', msgType: 'text', text, parentId,
      mentions: [{ key: '@Friday', name: 'Friday', openId: 'bot' }], createTimeMs: Date.now() }
  }
  const note = memory.add({ scope: spaceScope(space.id), kind: 'rule', title: 'synthetic rule', body: 'OLD_MEMORY_CANARY',
    status: 'confirmed', confirmation: { by: 'alice', messageId: 'proof', at: 1 } })
  return { registry, memory, fake, peer, runtime, host, classify, message, note }
}

describe('explicit amendments after memory context cancellation', () => {
  it.each(['memory_context_invalidated', 'user_requested'] as const)('requires an explicit amendment to continue stopped work with fresh memory, original reason %s', async reason => {
    const t = fixture(), entered = deferred(), release = deferred(), original = t.message('检查合成事项。')
    t.peer.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } },
      { kind: 'text', text: 'OLD_LATE_ANSWER' }]
    const pending = t.host.handleMessage(original)
    await entered.promise
    const task = t.registry.taskForMessage(original.messageId)!, oldSession = t.registry.getSession(task.sessionKey)!
    const work = t.registry.taskWork.get(task.id), oldAcp = t.peer.state.allPrompts[0]!.sessionId
    expect(t.peer.state.allPrompts[0]!.text).toContain(t.note.body)
    await t.host.handleMessage(t.message(reason === 'user_requested' ? '/stop' : `/forget ${t.note.id}`))
    release.resolve(); await pending
    if (reason === 'user_requested') await t.host.handleMessage(t.message(`/forget ${t.note.id}`))
    expect(t.registry.getTask(task.id)).toMatchObject({ status: 'cancelled', stopReason: reason })
    expect(t.memory.get(t.note.id)).toBeUndefined()
    expect(JSON.stringify(t.fake.sent)).not.toContain('OLD_LATE_ANSWER')
    const stoppedWork = t.registry.workContexts.get(work!.key)!
    expect(stoppedWork.lifecycle).toBe('open')
    if (reason === 'user_requested') expect(stoppedWork.pauseReasons).toEqual([expect.objectContaining({ reason: 'run_stop' })])
    await t.host.recoverHandoffs()
    expect(t.peer.state.allPrompts).toHaveLength(1)
    expect(t.registry.workContexts.get(work!.key)).toEqual(stoppedWork)

    t.peer.state.script = [{ kind: 'text', text: 'FRESH_CONTINUATION' }]
    const reply = t.message('继续刚才，补充一个检查步骤。', original.messageId)
    await t.host.handleMessage(reply)
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(t.classify.mock.calls[0]![0].message.replyToRef).toBeTruthy()
    const next = t.registry.taskForMessage(reply.messageId)!
    expect(next).toMatchObject({ status: 'done', sessionKey: task.sessionKey, prompt: reply.text })
    expect(t.registry.taskWork.get(next.id)).toEqual(work)
    expect(t.registry.listAmendedTasks(next.id).map(item => item.id)).toContain(task.id)
    expect(t.registry.workContexts.get(work!.key)).toMatchObject({ lifecycle: 'open', inputSeq: 2, pauseReasons: [] })
    if (reason === 'user_requested') expect(t.registry.workContexts.get(work!.key)!.controlEpoch).toBeGreaterThan(stoppedWork.controlEpoch)
    expect(t.registry.getSession(next.sessionKey)?.cwd).toBe(oldSession.cwd)
    const prompt = t.peer.state.allPrompts[1]!
    expect(prompt.sessionId).not.toBe(oldAcp)
    expect(t.peer.state.resumed).not.toContain(oldAcp)
    expect(t.peer.state.sessions.get(prompt.sessionId)?.cwd).toBe(oldSession.cwd)
    expect(prompt.text).toContain(original.text)
    expect(prompt.text).toContain(reply.text)
    expect(prompt.text).not.toContain(t.note.body)
    expect(t.fake.answers()).toContain('FRESH_CONTINUATION')
    await t.host.handleMessage(reply)
    expect(t.registry.taskForMessage(reply.messageId)?.id).toBe(next.id)
    expect(t.peer.state.allPrompts).toHaveLength(2)
    expect(t.registry.getTask(task.id)).toMatchObject({ status: 'cancelled', stopReason: reason })
  })
})
