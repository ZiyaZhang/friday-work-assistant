import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { duePreparationRecovery } from '../src/core/local-preparation-recovery.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { ChangeManager } from '../src/github/changes.js'
import { ChangePreparationOperations } from '../src/github/preparation-operations.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createInternalApi } from '../src/internal/api.js'
import { Todos } from '../src/core/todos.js'
import { createLogger } from '../src/log.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: {
    PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.test',
  } }).trim()
}
type GitMethod = (args: string[], cwd?: string, env?: Record<string, string>, check?: () => void, signal?: AbortSignal) => Promise<string>

/** Real host, managed ACP, SQLite and Git; synthetic model/provider only.
 * This exercises lifecycle ownership directly, independently of the HTTP adapter. */
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-preparation-host-review-')))
  const seed = join(home, 'seed'), bare = join(home, 'remote.git')
  mkdirSync(seed); git(seed, 'init', '-q'); git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(seed, 'README.md'), 'original\n'); git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'initial')
  git(home, 'clone', '-q', '--bare', seed, bare)
  const registry = new Registry(join(home, 'state.sqlite')), log = createLogger('preparation-host-review', 'error')
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home,
    FRIDAY_PUBLIC_MODE: 'true', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '10000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const sp = spaceDeps(registry.db), fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const userTokens = new UserTokenStore(registry.db, fake), tokens = new TokenIssuer('synthetic-key')
  const github = { repoAllowed: (repo: string) => repo === 'org/demo', repoWritable: (repo: string) => repo === 'org/demo' } as GitHubIdentity
  const changes = new ChangeManager({ db: registry.db, github, cacheDir: join(home, 'cache'), log, remoteUrlFor: () => `file://${bare}` })
  const preparations = new ChangePreparationOperations({ changes }), calls = new RunApiCalls(registry.db)
  const execution = managedHostRuntime(registry, home, log), state = execution.peer.state
  const host = new Orchestrator({ cfg, registry, ...sp, memory, messages, messageCache: cache, userTokens, feishu,
    runtime: execution.runtime, managed: execution.managed, tokens, changes, preparations,
    repositoryAllowed: repo => github.repoAllowed(repo), botOpenId: 'bot', log, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent',
    ingressClassifier: { classify: async () => ({ kind: 'work_request' }) } })
  const releases: (() => void)[] = []
  cleanups.push(async () => {
    host.beginShutdown(); preparations.beginShutdown(); releases.forEach(release => release())
    await execution.runtime.stop(); expect(await host.waitForShutdown(3000)).toMatchObject({ drained: true })
    expect(await preparations.waitForShutdown(3000)).toMatchObject({ drained: true })
    registry.close(); rmSync(home, { recursive: true, force: true })
  })
  const current = () => {
    const session = registry.getSessionByAcpId(state.allPrompts.at(-1)!.sessionId)!
    const actor = host.resolveActorForSession(session.sessionKey)!
    return { session, actor, signal: host.preparationRunSignal(session.sessionKey, actor.runId) }
  }
  const start = async () => {
    const { session, actor, signal } = current(), workKey = registry.taskWork.get(actor.taskId)!.key
    const call = calls.begin(actor.runId, 'POST /v1/github/change/start'); calls.need(call, 'github:write')
    const receipt = await preparations.start({ cwd: session.cwd, sessionKey: session.sessionKey, requesterOpenId: actor.requesterOpenId,
      workKey, repo: 'org/demo', base: 'main', operationKey: `task:${actor.taskId}:repo:org/demo`, attemptKey: actor.runId, runSignal: signal,
      assertCurrent() { if (host.resolveActorForSession(session.sessionKey)?.runId !== actor.runId) throw new Error('Run authority changed') },
      onPreparation: ref => calls.reference(call, { kind: 'github_change_preparation', id: ref.id }) })
    calls.finish(call, 'returned')
    return { receipt, signal, actor }
  }
  const holdFetch = () => {
    const entered = deferred(), release = deferred(); releases.push(release.resolve)
    const internal = changes as unknown as { git: GitMethod }, actualGit = internal.git.bind(changes)
    let signal: AbortSignal | undefined
    vi.spyOn(internal, 'git').mockImplementation(async (...args) => {
      if (args[0][0] === 'fetch') { signal = args[4]; entered.resolve(); await release.promise }
      return actualGit(...args)
    })
    return { entered, release, get signal() { return signal } }
  }
  const message: InboundMessage = { eventId: 'request', messageId: 'request', chatId: 'oc_dm_alice', chatType: 'p2p',
    senderOpenId: 'alice', senderType: 'user', tenantId: 'tenant', msgType: 'text', text: '读取仓库准备记录并继续原修改。', mentions: [], createTimeMs: Date.now() }
  const row = () => registry.db.prepare("SELECT id,state,result_json FROM run_attempts WHERE stage='task' ORDER BY rowid DESC LIMIT 1").get()!
  const startApi = async () => {
    const api = createInternalApi({ appId: cfg.feishu.appId, registry, ...sp, github, changes, preparations, tokens, feishu, log,
      memory, messageCache: cache, messages, todos: new Todos(registry.db), maxHistoryPerCall: 20,
      resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
      canPublishToRepository: (key, repo) => host.canPublishToRepository(key, repo),
      preparationRunSignal: (key, runId) => host.preparationRunSignal(key, runId) })
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
    cleanups.push(async () => {
      api.beginShutdown(); releases.forEach(release => release()); api.server.closeAllConnections()
      expect(await api.waitForShutdown(3000)).toMatchObject({ drained: true })
      await new Promise<void>(resolve => api.server.close(() => resolve()))
    })
    const post = async (route: string, signal?: AbortSignal) => {
      const servers = state.allPrompts.at(-1)!.mcpServers as { env: { name: string; value: string }[] }[]
      const token = servers[0]!.env.find(entry => entry.name === 'FRIDAY_CAP_TOKEN')!.value
      const response = await fetch(`${url}/v1/github/change/${route}`, { method: 'POST', signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repo: 'org/demo', base: 'main', wait_ms: 0 }) })
      return { status: response.status, body: await response.json() }
    }
    return { api, post }
  }
  return { cfg, registry, fake, execution, state, host, preparations, changes, start, current, holdFetch, message, row, startApi }
}

describe('independent host review of Run-owned Git preparation', () => {
  it('exposes the actual ordinary task signal without requiring an explicit RunningTask kind field', async () => {
    const t = fixture(); let checked = false
    t.state.script = [{ kind: 'hook', run: () => { const current = t.current(); expect(current.signal.aborted).toBe(false); checked = true } }, { kind: 'text', text: '读取完成。' }]
    await t.host.handleMessage(t.message)
    expect(checked).toBe(true); expect(t.row().state).toBe('completed')
  })

  it('retains a model failure while aborting its still-running local Git cleanup', async () => {
    const t = fixture(), held = t.holdFetch()
    t.state.script = [{ kind: 'hook', run: async () => { await t.start(); await held.entered.promise; throw new Error('synthetic model transport failed') } }]
    const turn = t.host.handleMessage(t.message)
    await held.entered.promise
    await expect.poll(() => held.signal?.aborted).toBe(true)
    held.release.resolve(); await turn
    expect(t.row()).toMatchObject({ state: 'failed', result_json: expect.stringContaining('runtime_error') })
    expect(JSON.parse(String(t.row().result_json)).outcome).toBe('failed')
    expect(t.registry.taskForMessage('request')?.status).toBe('failed')
    expect(t.registry.db.prepare('SELECT state FROM github_change_preparations').get()?.state).toBe('cancelled')
    expect(t.fake.sent.some(item => JSON.stringify(item.payload).includes('处理失败'))).toBe(true)
  })

  it.each(['human-stop', 'shutdown'] as const)('keeps %s distinct while waiting for actual Git cleanup', async reason => {
    const t = fixture(), held = t.holdFetch(), model = deferred()
    t.state.script = [{ kind: 'hook', run: async () => { await t.start(); await held.entered.promise; await model.promise } }]
    const turn = t.host.handleMessage(t.message)
    await held.entered.promise
    if (reason === 'shutdown') t.host.beginShutdown()
    else await t.host.handleMessage({ ...t.message, messageId: 'stop-request', eventId: 'stop-request', text: '/stop' })
    expect(held.signal?.aborted).toBe(true)
    if (reason === 'shutdown') expect(await t.host.waitForShutdown(0)).toMatchObject({ drained: false })
    held.release.resolve(); model.resolve(); await turn
    expect(t.row()).toMatchObject({ state: reason === 'shutdown' ? 'interrupted' : 'cancelled' })
    expect(JSON.parse(String(t.row().result_json))).toMatchObject(reason === 'shutdown'
      ? { termination: 'gateway_shutdown', outcome: 'interrupted', reason: 'interrupted' }
      : { outcome: 'cancelled', reason: 'user_requested' })
    expect(t.registry.db.prepare('SELECT state FROM github_change_preparations').get()?.state).toBe('cancelled')
  })

  it('does not revive the old Git effect when the model budget replaces its controller for wrap-up', async () => {
    const t = fixture(), held = t.holdFetch(); t.cfg.policy.maxStepsPerTurn = 1
    let originalSignal: AbortSignal | undefined, wrapSignal: AbortSignal | undefined
    t.state.script = [{ kind: 'hook', run: async () => {
      originalSignal = (await t.start()).signal; await held.entered.promise
      t.state.script = [{ kind: 'hook', run: () => { wrapSignal = t.current().signal } }, { kind: 'text', text: '这一轮尚未完成修改。' }]
    } }, { kind: 'tool', text: 'first' }, { kind: 'tool', text: 'second' }]
    const turn = t.host.handleMessage(t.message)
    await held.entered.promise; await expect.poll(() => held.signal?.aborted).toBe(true)
    held.release.resolve(); await turn
    expect(originalSignal?.aborted).toBe(true); expect(wrapSignal).toBeDefined(); expect(wrapSignal).not.toBe(originalSignal)
    expect(JSON.parse(String(t.row().result_json))).toMatchObject({ outcome: 'partial', reason: 'step_budget' })
    expect(duePreparationRecovery(t.registry.db, Date.now() + 10_000_000, 2)).toEqual([])
    expect(t.registry.db.prepare('SELECT count(*) n FROM github_change_preparations').get()?.n).toBe(1)
  })

  it('restores an unconsumed result when the client disconnects after handler return but before response finish', async () => {
    const t = fixture(), http = await t.startApi(), modelReady = deferred(), modelRelease = deferred()
    let runId = ''
    t.state.script = [{ kind: 'hook', run: async () => {
      runId = t.current().actor.runId
      expect((await http.post('start')).status).toBe(200)
      await t.preparations.settleRun(runId)
      modelReady.resolve(); await modelRelease.promise
    } }, { kind: 'text', text: '准备结果尚未读到。' }]
    const turn = t.host.handleMessage(t.message)
    await modelReady.promise
    const formed = deferred(), closed = deferred()
    let waitingResponse: import('node:http').ServerResponse | undefined
    http.api.server.once('request', (request, response) => {
      if (request.url !== '/v1/github/change/wait') throw new Error('unexpected request')
      waitingResponse = response
      // Transport fault after the real handler has built and returned its JSON.
      // No bytes/finish event are produced; the next operation really closes the client socket.
      response.end = (() => { formed.resolve(); return response }) as typeof response.end
      response.once('close', closed.resolve)
    })
    const abort = new AbortController(), request = http.post('wait', abort.signal)
    const rejected = expect(request).rejects.toThrow()
    try {
      await formed.promise
      for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve))
      expect(waitingResponse?.writableFinished).toBe(false)
      expect(t.preparations.unobservedForRun(runId)).toBe(false)
      abort.abort(); await rejected; await closed.promise
      expect(t.preparations.unobservedForRun(runId)).toBe(true)
    } finally { abort.abort(); modelRelease.resolve(); await turn }
  })
})
