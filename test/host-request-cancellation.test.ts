import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { withRequestLease } from '../src/core/request-lease.js'
import { RoutineStore } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import { UserTokenStore, USER_SCOPE_TIERS } from '../src/feishu/oauth.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

/** Actual SDK/runtime, host, signed HTTP, disk SQLite and delivery ledger; only providers/models are fake. */
async function setup(options: { group?: boolean; mode?: 'managed' | 'workspace'; coreOnly?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-request-cancel-'))
  const mode = options.mode ?? 'managed'
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_DEFAULT_EXECUTION: mode })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(join(home, 'db')), sp = spaceDeps(registry.db)
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('request-cancel-test', 'error')
  const inbound: InboundMessage = { eventId: 'synthetic-event', messageId: 'synthetic-request', chatId: options.group ? 'oc_group' : 'oc_dm_alice',
    chatType: options.group ? 'group' : 'p2p', senderOpenId: 'ou_alice', senderType: 'user', tenantId: 'synthetic-tenant', msgType: 'text',
    text: options.group ? '@Friday 处理这条合成反馈。' : '处理这条合成请求。',
    mentions: options.group ? [{ key: '@Friday', name: 'Friday', openId: 'ou_bot' }] : [], createTimeMs: Date.now() }
  const space = sp.spaces.ensure({ kind: inbound.chatType, chatId: inbound.chatId, openId: 'ou_alice' })
  fake.members.set(inbound.chatId, new Set(['ou_alice']))
  const memory = new ChannelMemory(registry.db), messageCache = new MessageCache(registry.db), todos = new Todos(registry.db)
  const routines = new RoutineStore(registry.db), bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs)
  const messages = new MessageService(feishu, messageCache, log), tokens = new TokenIssuer('synthetic-key')
  const userTokens = new UserTokenStore(registry.db, fake)
  fake.nextToken = { accessToken: 'synthetic-core', refreshToken: 'synthetic-refresh', expiresIn: 7200, refreshTokenExpiresIn: 86400,
    scope: [...USER_SCOPE_TIERS.core, ...(options.coreOnly ? [] : USER_SCOPE_TIERS.calendar)].join(' ') }
  fake.identities.set('synthetic-core', { openId: 'ou_alice', name: '合成用户' })
  await userTokens.complete({ openId: 'ou_alice', code: 'synthetic-code', redirectUri: cfg.feishu.oauth.redirectUri })
  const execution = managedHostRuntime(registry, home, log), { runtime, managed } = execution
  const state = (mode === 'managed' ? execution.peer : execution.workspacePeer).state
  const host = new Orchestrator({ cfg, registry, ...sp, memory, messageCache, messages, todos, routines, questions, userTokens, feishu, runtime, managed, tokens,
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log,
    ingressClassifier: { classify: async () => ({ kind: 'work_request' }) } })
  const api = createInternalApi({ appId: cfg.feishu.appId, registry, ...sp, memory, messageCache, messages, todos, routines, bugs, questions, userTokens, feishu,
    tokens, log, maxHistoryPerCall: 20, oauthRedirectUri: cfg.feishu.oauth.redirectUri, abilities: host.abilities,
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPersistDerivedState: key => host.canPersistDerivedState(key), onExternalSourceRead: (key, source) => host.noteExternalSource(key, source),
    deliverToolResult: (key, runId, input) => host.deliverToolResult(key, runId, input), isManagedRun: runId => host.isManagedRun(runId),
    askBugQuestion: (key, runId, input) => host.askBugQuestion(key, runId, input),
    onAccessBlocked: (actor, failure, purpose) => host.onAccessBlocked(actor, failure, purpose) })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const releases: (() => void)[] = []
  cleanup.push(async () => {
    releases.forEach(release => release()); api.beginShutdown(); host.beginShutdown(); await runtime.stop()
    api.server.closeAllConnections()
    await new Promise<void>(resolve => api.server.close(() => resolve()))
    expect(await api.waitForShutdown(1000)).toMatchObject({ drained: true })
    expect(await host.waitForShutdown(1000)).toMatchObject({ drained: true })
    registry.close(); rmSync(home, { recursive: true, force: true })
  })
  const held = () => { const hold = deferred(); releases.push(hold.resolve); return hold }
  const current = () => {
    const prompt = state.allPrompts.at(-1)!, session = registry.getSessionByAcpId(prompt.sessionId)!
    const servers = prompt.mcpServers as { env: { name: string; value: string }[] }[]
    return { session, actor: host.resolveActorForSession(session.sessionKey)!, token: servers[0]!.env.find(entry => entry.name === 'FRIDAY_CAP_TOKEN')!.value }
  }
  const post = async (route: string, body: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const response = await fetch(`${base}/v1/${route}`, { method: 'POST', signal,
      headers: { authorization: `Bearer ${current().token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const cancellablePost = (route: string, body: Record<string, unknown>) => {
    const controller = new AbortController(), closed = deferred()
    api.server.once('request', (_req, res) => res.once('close', closed.resolve))
    const response = post(route, body, controller.signal).then(value => ({ status: value.status }), error => ({ errorName: error.name }))
    return { response, cancel: async () => { controller.abort(); await closed.promise; expect(await response).toEqual({ errorName: 'AbortError' }) } }
  }
  const calls = () => registry.db.prepare('SELECT run_id,route,state FROM run_api_calls ORDER BY rowid').all()
  const task = () => registry.taskForMessage(inbound.messageId)!
  const runRows = () => registry.db.prepare('SELECT id,state,stage,result_json FROM run_attempts ORDER BY rowid').all()
  const file = () => {
    const cwd = current().session.cwd
    mkdirSync(join(cwd, 'downloads'), { recursive: true }); writeFileSync(join(cwd, 'downloads', 'synthetic.txt'), 'Synthetic attachment bytes')
    return { path: 'downloads/synthetic.txt' }
  }
  return { home, cfg, registry, ...sp, fake, space, todos, bugs, questions, userTokens, state, host, api, current, post, cancellablePost, calls, task, runRows, file, held, inbound }
}

describe('a cancelled HTTP request does not cancel or outlive its host authority', () => {
  it.each(['report', 'handover'] as const)('keeps the %s create ACK but prevents a later grant, while the same Run handles a new request', async what => {
    const t = await setup(), hold = t.held(), entered = deferred(), original = t.fake.createDocument.bind(t.fake)
    const todo = t.todos.add({ scope: `space:${t.space.id}`, title: 'Synthetic completed item' }); t.todos.done(todo.id, `space:${t.space.id}`)
    vi.spyOn(t.fake, 'createDocument').mockImplementation(async (...args) => { const ack = await original(...args); entered.resolve(); await hold.promise; return ack })
    t.state.script = [{ kind: 'hook', run: async () => {
      const runId = t.current().actor.runId, pending = t.cancellablePost('ability', { what })
      await entered.promise; await pending.cancel()
      expect(t.current().actor.runId).toBe(runId)
      expect(t.runRows()).toMatchObject([{ state: 'running' }])
      hold.resolve()
      await expect.poll(() => t.calls().find(row => row.route === 'POST /v1/ability')?.state).toBe('failed')
      expect(t.calls().filter(row => String(row.route).startsWith('HOST '))).toEqual([{ run_id: runId, route: 'HOST /documents/create', state: 'returned' }])
      expect(t.fake.grants).toEqual([])
      expect((await t.post('ability', { what: 'status' })).status).toBe(200)
      expect(t.current().actor.runId).toBe(runId)
    } }, { kind: 'text', text: '请求已取消；同一任务继续处理后续结果。' }]
    await t.host.handleMessage(t.inbound)
    expect(t.fake.createdDocs).toHaveLength(1)
    expect(t.runRows()).toMatchObject([{ state: 'completed' }])
    expect(t.task().status).toBe('done')
  })

  it('does not POST a bug question after cancellation during fresh audience verification', async () => {
    const t = await setup({ group: true }), hold = t.held(), entered = deferred(), original = t.fake.chatMemberOpenIds.bind(t.fake)
    t.state.script = [{ kind: 'hook', run: async () => {
      const recorded = await t.post('bug/record', { title: 'Synthetic feedback', text: 'Synthetic original report', message_id: t.inbound.messageId })
      expect(recorded.status).toBe(200)
      const bucketId = (recorded.body.bucket as { id: number }).id
      const lookup = vi.spyOn(t.fake, 'chatMemberOpenIds').mockImplementation(async (...args) => { entered.resolve(); await hold.promise; return original(...args) })
      const before = t.fake.sent.length, runId = t.current().actor.runId
      const pending = t.cancellablePost('bug/ask', { id: bucketId, question: 'Synthetic question that must not be posted.' })
      await entered.promise; await pending.cancel(); hold.resolve()
      await expect.poll(() => t.calls().find(row => row.route === 'POST /v1/bug/ask')?.state).toBe('failed')
      expect(t.fake.sent).toHaveLength(before)
      expect(t.registry.db.prepare("SELECT status FROM deliveries WHERE delivery_key GLOB 'question:*'").all()).toEqual([])
      expect(t.registry.db.prepare('SELECT resolution FROM bug_questions').all()).toEqual([{ resolution: 'cancelled' }])
      lookup.mockRestore()
      expect((await t.post('ability', { what: 'status' })).status).toBe(200)
      expect(t.current().actor.runId).toBe(runId)
    } }, { kind: 'text', text: '继续独立的合成分析。' }]
    await t.host.handleMessage(t.inbound)
    expect(t.runRows()).toMatchObject([{ state: 'completed' }])
  })

  it.each(['upload', 'send-ack'] as const)('handles file cancellation at %s without inventing or losing an external delivery', async boundary => {
    const t = await setup({ mode: 'workspace' }), hold = t.held(), entered = deferred()
    if (boundary === 'upload') {
      const original = t.fake.uploadFile.bind(t.fake)
      vi.spyOn(t.fake, 'uploadFile').mockImplementation(async (...args) => { const key = await original(...args); entered.resolve(); await hold.promise; return key })
    } else {
      const original = t.fake.sendFileToUser.bind(t.fake)
      vi.spyOn(t.fake, 'sendFileToUser').mockImplementation(async (...args) => { const ack = await original(...args); entered.resolve(); await hold.promise; return ack })
    }
    t.state.script = [{ kind: 'hook', run: async () => {
      const runId = t.current().actor.runId, pending = t.cancellablePost('file/send', t.file())
      await entered.promise; await pending.cancel(); hold.resolve()
      await expect.poll(() => t.calls().find(row => row.route === 'POST /v1/file/send')?.state).toBe('failed')
      const sends = t.fake.of('sendFileToUser')
      expect(sends).toHaveLength(boundary === 'upload' ? 0 : 1)
      expect(t.registry.db.prepare("SELECT status,remote_id FROM deliveries WHERE delivery_key LIKE '%:tool:%'").all())
        .toEqual(boundary === 'upload' ? [] : [{ status: 'sent', remote_id: sends[0]!.messageId }])
      expect((await t.post('ability', { what: 'status' })).status).toBe(200)
      expect(t.current().actor.runId).toBe(runId)
    } }, { kind: 'text', text: '同一任务继续，保留已经发生的文件交付事实。' }]
    await t.host.handleMessage(t.inbound)
    expect(t.fake.uploads).toHaveLength(1)
    expect(t.runRows()[0]?.state).toBe('completed')
  })

  it('detaches a newly persisted Task from the transient callback that admitted it', async () => {
    const t = await setup(), controller = new AbortController(), hold = t.held(), entered = deferred()
    t.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await hold.promise; expect((await t.post('ability', { what: 'status' })).status).toBe(200) } },
      { kind: 'text', text: '持久请求正常完成。' }]
    // Inject the callback lease, not a synthetic Run: real ingress/dispatch creates every business row.
    const pending = withRequestLease(controller.signal, () => t.host.handleMessage(t.inbound))
    await entered.promise
    expect(t.registry.dispatches.get(t.task().id)?.inbound.messageId).toBe(t.inbound.messageId)
    controller.abort(); hold.resolve(); await pending
    expect(t.runRows()).toMatchObject([{ state: 'completed' }])
    expect(t.registry.db.prepare("SELECT status FROM deliveries WHERE delivery_key='task:1:final:0'").get()).toEqual({ status: 'sent' })
  })

  it('detaches authorization continuation of the original Task from an ended wakeup request', async () => {
    const t = await setup({ coreOnly: true })
    t.state.script = [{ kind: 'hook', run: async () => { expect((await t.post('calendar/events')).status).toBe(403) } }, { kind: 'text', text: '等待个人日历权限。' }]
    await t.host.handleMessage(t.inbound)
    const before = t.task(), original = t.registry.dispatches.get(before.id)!
    expect(t.registry.workContexts.get(t.registry.taskWork.get(before.id)!.key)?.pauseReasons).toMatchObject([{ reason: 'authorization' }])
    t.fake.nextToken = { ...t.fake.nextToken, accessToken: 'synthetic-calendar', scope: [...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.calendar].join(' ') }
    t.fake.identities.set('synthetic-calendar', { openId: 'ou_alice', name: '合成用户' })
    await t.userTokens.complete({ openId: 'ou_alice', code: 'synthetic-calendar', redirectUri: t.cfg.feishu.oauth.redirectUri })
    const controller = new AbortController(), hold = t.held(), entered = deferred()
    t.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await hold.promise; expect((await t.post('calendar/events')).status).toBe(200) } },
      { kind: 'text', text: '已完成原来的日历查询。' }]
    await withRequestLease(controller.signal, () => t.host.resumeAuthorizedRoutines('ou_alice'))
    await entered.promise; controller.abort(); hold.resolve()
    await expect.poll(() => t.runRows().at(-1)?.state).toBe('completed')
    expect(t.task().id).toBe(before.id)
    expect(t.registry.dispatches.get(before.id)).toMatchObject({ generation: 1, inbound: original.inbound, resume: { reason: 'authorization' } })
    expect(t.runRows()).toHaveLength(2)
    expect(t.registry.db.prepare("SELECT status FROM deliveries WHERE delivery_key='task:1:resume:1:final:0'").get()).toEqual({ status: 'sent' })
  })
})
