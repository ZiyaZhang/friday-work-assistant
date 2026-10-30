import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineScheduler, RoutineStore } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import { DeliveryService } from '../src/core/delivery.js'
import { inspectRecoveryEvidence } from '../src/core/recovery-evidence.js'
import { UserTokenStore, USER_SCOPE_TIERS } from '../src/feishu/oauth.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { gatewayShutdown } from '../src/index.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const drain = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)) }

/** Real disk, host, signed HTTP and ACP SDK; no snapshot rewind or manufactured Run evidence. */
async function setup(options: { reflect?: boolean; admins?: string[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-shutdown-')), path = join(home, 'friday.db')
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home,
    FRIDAY_ADMINS: options.admins?.join(',') ?? '', FRIDAY_REFLECT: options.reflect ? 'on' : 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_DEFAULT_EXECUTION: 'managed' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('shutdown-test', 'error')
  const releases: (() => void)[] = []
  const inbound: InboundMessage = { eventId: 'original-event', messageId: 'original-request', chatId: 'oc_dm_alice', chatType: 'p2p',
    senderOpenId: 'ou_alice', senderType: 'user', tenantId: 'synthetic-tenant', msgType: 'text',
    text: '读取我的日历，告诉我今天接下来的一场会议。', mentions: [], createTimeMs: Date.now() }
  async function boot() {
    const registry = new Registry(path), sp = spaceDeps(registry.db)
    sp.spaces.ensure({ kind: 'p2p', chatId: inbound.chatId, openId: inbound.senderOpenId! })
    const routines = new RoutineStore(registry.db), userTokens = new UserTokenStore(registry.db, fake)
    const memory = new ChannelMemory(registry.db), messageCache = new MessageCache(registry.db)
    const messages = new MessageService(feishu, messageCache, log), todos = new Todos(registry.db), tokens = new TokenIssuer('synthetic-key')
    const execution = managedHostRuntime(registry, home, log), { runtime, managed } = execution, state = execution.peer.state
    const host = new Orchestrator({ cfg, registry, ...sp, memory, messageCache, messages, todos, routines, userTokens, feishu, runtime, managed, tokens,
      apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log,
      ingressClassifier: { classify: async () => ({ kind: 'work_request' }) } })
    const api = createInternalApi({ appId: cfg.feishu.appId, registry, ...sp, memory, messageCache, messages, todos, routines, userTokens, feishu,
      tokens, log, maxHistoryPerCall: 20, oauthRedirectUri: cfg.feishu.oauth.redirectUri, abilities: host.abilities,
      resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
      canPersistDerivedState: key => host.canPersistDerivedState(key), onExternalSourceRead: (key, source) => host.noteExternalSource(key, source) })
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
    let closed = false
    const closeDatabase = vi.fn(() => { registry.close(); closed = true })
    const exit = vi.fn(), release = vi.fn()
    const stop = async () => {
      await runtime.stop()
      api.server.closeAllConnections(); api.callbackServer.closeAllConnections()
      await Promise.all([new Promise<void>(resolve => api.server.close(() => resolve())), new Promise<void>(resolve => api.callbackServer.close(() => resolve()))])
    }
    return { registry, ...sp, userTokens, state, runtime, host, api, base, closeDatabase, exit, release, stop,
      shutdown: (timeoutMs = 1000) => gatewayShutdown({ host, api, stop, closeDatabase, release, exit, log, timeoutMs }),
      get closed() { return closed } }
  }
  let kernel = await boot()
  const close = async () => {
    if (!kernel.closed) {
      kernel.api.beginShutdown(); kernel.host.beginShutdown()
      await kernel.stop()
      expect(await kernel.api.waitForShutdown(1000)).toMatchObject({ drained: true })
      expect(await kernel.host.waitForShutdown(1000)).toMatchObject({ drained: true })
      kernel.closeDatabase()
    }
  }
  cleanup.push(async () => { releases.forEach(fn => fn()); await close(); rmSync(home, { recursive: true, force: true }) })
  fake.nextToken = { accessToken: 'synthetic-calendar', refreshToken: 'synthetic-refresh', expiresIn: 7200, refreshTokenExpiresIn: 86400,
    scope: [...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.calendar].join(' ') }
  fake.identities.set('synthetic-calendar', { openId: 'ou_alice', name: '合成用户' })
  await kernel.userTokens.complete({ openId: 'ou_alice', code: 'synthetic', redirectUri: cfg.feishu.oauth.redirectUri })
  fake.events = [{ eventId: 'synthetic-event', summary: '合成会议', startMs: Date.now() + 60_000, endMs: Date.now() + 120_000, allDay: false }]
  const post = async (route: string, body: Record<string, unknown> = {}) => {
    const servers = kernel.state.allPrompts.at(-1)!.mcpServers as { env: { name: string; value: string }[] }[]
    const token = servers[0]!.env.find(entry => entry.name === 'FRIDAY_CAP_TOKEN')!.value
    const response = await fetch(`${kernel.base}/v1/${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    await response.arrayBuffer(); return response.status
  }
  const held = () => { const d = deferred(); releases.push(d.resolve); return d }
  const runRows = () => kernel.registry.db.prepare('SELECT id,task_id,state,result_json,trigger_key FROM run_attempts ORDER BY rowid').all()
  const task = () => kernel.registry.taskForMessage(inbound.messageId)!
  const evidence = () => inspectRecoveryEvidence(kernel.registry.db, { taskId: task().id, runId: String(runRows()[0]!.id), sessionKey: task().sessionKey, actorOpenId: 'ou_alice' })
  const readHeld = async () => {
    const hold = held(), entered = deferred()
    kernel.state.script = [{ kind: 'hook', run: async () => { expect(await post('calendar/events')).toBe(200); entered.resolve(); await hold.promise } }, { kind: 'text', text: '原请求查询结果。' }]
    const first = kernel.host.handleMessage(inbound); await entered.promise
    return { first, release: hold.resolve }
  }
  const reboot = async () => {
    await close(); kernel = await boot()
    kernel.registry.failStaleTasks('synthetic restart')
    new DeliveryService(kernel.registry.db, { spaces: kernel.spaces, policy: kernel.policy, resolveContext: async () => undefined,
      send: async () => { throw new Error('startup cannot send') } }).recoverInterrupted()
    kernel.host.recoverRuns()
  }
  return { fake, inbound, post, held, readHeld, runRows, task, evidence, reboot, get k() { return kernel } }
}

describe('host shutdown keeps interruption separate from human cancellation', () => {
  it.each(['fast', 'slow'] as const)('resumes one original read without creating a %s failure notice', async speed => {
    const t = await setup(), held = await t.readHeld(), notice = t.held(), original = t.fake.sendToChat.bind(t.fake)
    let failureNotices = 0
    t.fake.sendToChat = async (chat, payload) => {
      if (JSON.stringify(payload).includes('处理失败')) { failureNotices++; if (speed === 'slow') await notice.promise }
      return original(chat, payload)
    }
    const originalTask = t.task(), shutdown = t.k.shutdown()
    expect(shutdown()).toBe(shutdown())
    await shutdown(); held.release(); await held.first
    expect(failureNotices).toBe(0)
    expect(t.k.exit).toHaveBeenCalledTimes(1); expect(t.k.closeDatabase).toHaveBeenCalledTimes(1)
    await t.reboot()
    expect(t.runRows()[0]).toMatchObject({ state: 'interrupted', result_json: expect.stringContaining('gateway_shutdown') })
    expect(t.evidence()).toMatchObject({ allowed: true, reasons: [] })
    t.k.state.script = [{ kind: 'hook', run: async () => { expect(await t.post('calendar/events')).toBe(200) } }, { kind: 'text', text: '原请求读取完成。' }]
    await t.k.host.recoverHandoffs()
    await expect.poll(() => t.runRows().at(-1)?.state).toBe('completed')
    expect(t.task()).toMatchObject({ id: originalTask.id, messageId: originalTask.messageId, sessionKey: originalTask.sessionKey })
    expect(t.k.registry.dispatches.get(originalTask.id)).toMatchObject({ generation: 1, inbound: t.inbound, resume: { reason: 'restart' } })
    await t.k.host.recoverHandoffs(); await drain()
    expect(t.runRows()).toHaveLength(2)
    expect(t.k.registry.db.prepare("SELECT delivery_key,status FROM deliveries WHERE delivery_key LIKE '%:final:%'").all())
      .toEqual([{ delivery_key: 'task:1:resume:1:final:0', status: 'sent' }])
  })

  it('retains a committed human stop across shutdown and does not revive its Work', async () => {
    const t = await setup(), held = await t.readHeld()
    await t.k.host.handleMessage({ ...t.inbound, messageId: 'human-stop', eventId: 'human-stop', text: '/stop' })
    await t.k.shutdown()(); held.release(); await held.first; await t.reboot()
    expect(t.runRows()[0]).toMatchObject({ state: 'cancelled', result_json: expect.stringContaining('user_requested') })
    expect(t.evidence().allowed).toBe(false)
    await t.k.host.recoverHandoffs(); await drain()
    expect(t.runRows()).toHaveLength(1)
  })

  it.each(['returned', 'started'] as const)('keeps a %s mutation blocked, and a timeout never closes its still-used DB', async boundary => {
    const t = await setup(), hold = t.held(), entered = deferred(), original = t.fake.createDocument.bind(t.fake)
    let request: Promise<number> | undefined
    if (boundary === 'started') t.fake.createDocument = async (...args) => { const result = await original(...args); entered.resolve(); await hold.promise; return result }
    t.k.state.script = [{ kind: 'hook', run: async () => {
      request = t.post('doc/create', { title: '合成文档', markdown: '合成正文' }).catch(() => 0)
      if (boundary === 'returned') { expect(await request).toBe(200); entered.resolve() }
      else await request
      await hold.promise
    } }]
    const first = t.k.host.handleMessage(t.inbound); await entered.promise
    await t.k.shutdown(20)()
    expect(t.k.exit).toHaveBeenCalledOnce()
    expect(t.k.closeDatabase).toHaveBeenCalledTimes(boundary === 'started' ? 0 : 1)
    if (boundary === 'started') {
      expect(t.k.registry.db.prepare('SELECT 1 AS live').get()).toEqual({ live: 1 })
      expect(await t.k.api.waitForShutdown(0)).toMatchObject({ drained: false, pending: 1 })
    }
    hold.resolve(); await first; await request
    if (boundary === 'started') expect(await t.k.api.waitForShutdown(1000)).toMatchObject({ drained: true })
    await t.reboot()
    expect(t.evidence().allowed).toBe(false)
    expect(t.evidence().reasons).toContain(boundary === 'returned' ? 'effect_unverifiable' : 'effect_unresolved')
    await t.k.host.recoverHandoffs(); await drain()
    expect(t.runRows()).toHaveLength(1); expect(t.fake.createdDocs).toHaveLength(1)
  })

  it('allows recovery of an interrupted in-flight read after its bounded HTTP drain settles', async () => {
    const t = await setup(), hold = t.held(), entered = deferred(), original = t.fake.listMyEvents.bind(t.fake)
    t.fake.listMyEvents = async (...args) => { entered.resolve(); await hold.promise; return original(...args) }
    let request: Promise<number> | undefined
    t.k.state.script = [{ kind: 'hook', run: async () => { request = t.post('calendar/events').catch(() => 0); await request } }]
    const first = t.k.host.handleMessage(t.inbound); await entered.promise
    await t.k.shutdown(10)()
    expect(t.k.closeDatabase).not.toHaveBeenCalled()
    hold.resolve(); await first; await request
    expect(await t.k.api.waitForShutdown(1000)).toMatchObject({ drained: true })
    await t.reboot()
    expect(t.evidence()).toMatchObject({ allowed: true })
    t.k.state.script = [{ kind: 'text', text: '原请求已接续。' }]
    await t.k.host.recoverHandoffs()
    await expect.poll(() => t.runRows().at(-1)?.state).toBe('completed')
    expect(t.k.registry.dispatches.get(1)?.generation).toBe(1)
  })

  it('preserves a completed final ACK and never starts reflection or another dispatch after shutdown', async () => {
    const t = await setup()
    t.k.state.script = [{ kind: 'text', text: '正常完成。' }]
    await t.k.host.handleMessage(t.inbound)
    const before = t.runRows(), messages = t.fake.sent.length
    await t.k.shutdown()()
    await expect(t.k.host.handleMessage({ ...t.inbound, messageId: 'after-close' })).rejects.toThrow('网关正在重启')
    await t.reboot(); await t.k.host.recoverHandoffs(); await drain()
    expect(t.runRows()).toEqual(before)
    expect(t.fake.sent).toHaveLength(messages)
  })

  it('does not replay an ACKed final answer whose host completion was interrupted', async () => {
    const t = await setup({ reflect: true }), original = t.fake.sendToChat.bind(t.fake)
    t.fake.sendToChat = async (chat, payload) => { const id = await original(chat, payload); t.k.host.beginShutdown(); return id }
    t.k.state.script = [{ kind: 'text', text: '已发送但收尾未结束的答案。'.repeat(100) }]
    await t.k.host.handleMessage(t.inbound)
    expect(t.runRows()[0]?.state).toBe('interrupted')
    expect(t.k.state.allPrompts).toHaveLength(1) // No reflection begins after shutdown.
    expect(t.k.registry.db.prepare("SELECT status FROM deliveries WHERE delivery_key='task:1:final:0'").get()).toEqual({ status: 'sent' })
    expect(t.evidence().reasons).toContain('effect_unverifiable')
    await t.k.shutdown()(); await t.reboot(); await t.k.host.recoverHandoffs(); await drain()
    expect(t.runRows()).toHaveLength(1)
  })

  it.each(['ok', 'failed'] as const)('owns the full scheduled tick and leaves interrupted occurrences pending after a late %s return', async status => {
    const t = await setup(), release = t.held(), entered = deferred(), now = Date.now(), store = new RoutineStore(t.k.registry.db)
    for (const name of ['first', 'second']) store.add({ kind: 'schedule', chatId: 'oc_dm_alice', chatType: 'p2p', name,
      prompt: '合成只读安排', schedule: { type: 'once', atMs: now + 1000 }, now })
    let calls = 0
    const scheduler = new RoutineScheduler({ store, now: () => now + 1000, log: createLogger('shutdown-scheduler', 'error'),
      runTick: tick => t.k.host.runWhileActive(tick), run: async () => {
        calls++; entered.resolve(); await release.promise
        if (status === 'failed') throw new Error('runtime disconnected')
        return 'ok'
      } })
    scheduler.start(); await entered.promise
    t.k.host.beginShutdown(); scheduler.stop()
    expect(await t.k.host.waitForShutdown(0)).toMatchObject({ drained: false })
    release.resolve(); expect(await t.k.host.waitForShutdown(1000)).toEqual({ drained: true, pending: 0 })
    expect(calls).toBe(1)
    expect(store.listOccurrences(1)[0]?.status).toBe('running')
    expect(store.listOccurrences(2)).toEqual([])
    expect(await scheduler.tick()).toBe(0)
    expect(store.recoverInterruptedOccurrences(now + 2000)).toMatchObject([{ status: 'interrupted' }])
    expect(store.get(1)?.enabled).toBe(false)
  })

  it('drains detached administrator-copy receipts even after their parent Run and HTTP call finished', async () => {
    const t = await setup({ admins: ['ou_ops'] }), hold = t.held(), entered = deferred(), original = t.fake.sendToUser.bind(t.fake)
    t.fake.sendToUser = async (openId, payload) => {
      const id = await original(openId, payload)
      if (openId === 'ou_ops') { entered.resolve(); await hold.promise }
      return id
    }
    t.k.state.script = [{ kind: 'hook', run: async () => {
      const task = t.task(), actor = t.k.host.resolveActorForSession(task.sessionKey)!
      t.k.host.abilities.ccRepositoryWrite({ runId: actor.runId, sessionKey: task.sessionKey, chatId: t.inbound.chatId,
        chatType: 'p2p', requesterOpenId: 'ou_alice', spaceId: t.k.spaces.byChat(t.inbound.chatId)!.id }, { repo: 'synthetic/repo', action: '更新 PR' })
      await entered.promise
    } }, { kind: 'text', text: '原请求已完成。' }]
    await t.k.host.handleMessage(t.inbound)
    expect(t.runRows()[0]?.state).toBe('completed')
    expect(t.k.registry.db.prepare("SELECT state FROM run_api_calls WHERE route='HOST /repository/admin-copy'").get()).toEqual({ state: 'started' })
    await t.k.shutdown(5)()
    expect(t.k.closeDatabase).not.toHaveBeenCalled()
    expect(await t.k.host.waitForShutdown(0)).toEqual({ drained: false, pending: 1 })
    hold.resolve()
    expect(await t.k.host.waitForShutdown(1000)).toEqual({ drained: true, pending: 0 })
    expect(t.k.registry.db.prepare("SELECT state FROM run_api_calls WHERE route='HOST /repository/admin-copy'").get()).toEqual({ state: 'returned' })
  })

  it('waits for host callbacks beyond Run termination and leaves the DB open at its bounded deadline', async () => {
    const t = await setup(), late = t.held(), entered = deferred()
    const pending = t.k.host.runWhileActive(async () => { entered.resolve(); await late.promise; t.k.registry.setKv('synthetic:late-receipt', 'ack') })
    await entered.promise
    await t.k.shutdown(5)()
    expect(t.k.closeDatabase).not.toHaveBeenCalled()
    expect(await t.k.host.waitForShutdown(0)).toEqual({ drained: false, pending: 1 })
    late.resolve(); await pending
    expect(await t.k.host.waitForShutdown(100)).toEqual({ drained: true, pending: 0 })
    expect(t.k.registry.getKv('synthetic:late-receipt')).toBe('ack')
  })
})
