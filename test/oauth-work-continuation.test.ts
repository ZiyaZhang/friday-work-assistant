import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
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
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function drain() { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)) }

/** Real disk SQLite, host, ACP SDK, signed read HTTP and OAuth callback. Only model/platform are synthetic. */
async function setup(initiallyConnected = true, mode: 'managed' | 'workspace' = 'managed') {
  const home = mkdtempSync(join(tmpdir(), 'friday-oauth-work-')), path = join(home, 'friday.db')
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_DEFAULT_EXECUTION: mode })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('oauth-work', 'error')
  const options = { callbackWake: true, progressQuery: false, routeAmend: false }, releases: (() => void)[] = []
  let boots = 0
  const inbound: InboundMessage = { eventId: 'original-event', messageId: 'original-request', chatId: 'oc_dm_alice', chatType: 'p2p',
    senderOpenId: 'ou_alice', senderType: 'user', tenantId: 'synthetic-tenant', msgType: 'text',
    text: '读取我的日历，并告诉我今天接下来的一场会议。', mentions: [], createTimeMs: Date.now() }
  async function boot() {
    const registry = new Registry(path), sp = spaceDeps(registry.db)
    const dm = sp.spaces.ensure({ kind: 'p2p', chatId: inbound.chatId, openId: inbound.senderOpenId! })
    const routines = new RoutineStore(registry.db), userTokens = new UserTokenStore(registry.db, fake)
    const memory = new ChannelMemory(registry.db), messageCache = new MessageCache(registry.db)
    const messages = new MessageService(feishu, messageCache, log), todos = new Todos(registry.db), tokens = new TokenIssuer('synthetic-key')
    const execution = managedHostRuntime(registry, home, log), { runtime, managed } = execution
    const state = mode === 'managed' ? execution.peer.state : execution.workspacePeer.state
    state.counter = (mode === 'managed' ? 0 : 1_000_000) + 100 * boots++
    const host = new Orchestrator({ cfg, registry, ...sp, memory, messageCache, messages, todos, routines, userTokens, feishu, runtime, managed, tokens,
      apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log,
      ingressClassifier: { classify: async input => options.progressQuery
        ? { kind: 'progress', targetRef: input.message.replyToRef ?? input.candidates[0]!.ref }
        : options.routeAmend ? { kind: 'amend', targetRef: input.message.replyToRef ?? input.candidates[0]!.ref } : { kind: 'work_request' } } })
    const api = createInternalApi({ appId: cfg.feishu.appId, registry, ...sp, memory, messageCache, messages, todos, routines, userTokens, feishu,
      tokens, log, maxHistoryPerCall: 20, oauthRedirectUri: cfg.feishu.oauth.redirectUri,
      abilities: host.abilities, onAccessBlocked: (actor, failure, purpose) => host.onAccessBlocked(actor, failure, purpose),
      onAuthorizationCompleted: openId => options.callbackWake ? host.resumeAuthorizedRoutines(openId) : Promise.resolve({ connected: true, resumed: 0, stillPaused: 0 }),
      resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
      canPersistDerivedState: (key, purpose) => host.canPersistDerivedState(key, purpose), onExternalSourceRead: (key, source) => host.noteExternalSource(key, source) })
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
    return { registry, ...sp, dm, routines, userTokens, state, runtime, host, api, base }
  }
  let kernel = await boot()
  const close = async () => {
    await kernel.runtime.stop()
    kernel.api.server.closeAllConnections()
    if (kernel.api.server.listening) await new Promise<void>(resolve => kernel.api.server.close(() => resolve()))
    kernel.registry.close()
  }
  cleanup.push(async () => { releases.forEach(release => release()); await close(); rmSync(home, { recursive: true, force: true }) })
  fake.nextToken = { accessToken: 'core-token', refreshToken: 'core-refresh', expiresIn: 7200, refreshTokenExpiresIn: 86400,
    scope: USER_SCOPE_TIERS.core.join(' ') }
  if (initiallyConnected) await kernel.userTokens.complete({ openId: 'ou_alice', code: 'initial-core', redirectUri: cfg.feishu.oauth.redirectUri })
  fake.nextToken = { ...fake.nextToken, accessToken: 'calendar-token', refreshToken: 'calendar-refresh', scope: [...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.calendar].join(' ') }
  fake.identities.set('calendar-token', { openId: 'ou_alice', name: '合成用户 Alice' })
  fake.events = [{ eventId: 'synthetic-calendar-event', summary: '原请求的后续会议', startMs: Date.now() + 60_000, endMs: Date.now() + 120_000, allDay: false }]
  const post = async (route: string, body: Record<string, unknown> = {}) => {
    const prompt = kernel.state.allPrompts.at(-1)!, servers = prompt.mcpServers as { env: { name: string; value: string }[] }[]
    const token = servers[0]!.env.find(entry => entry.name === 'FRIDAY_CAP_TOKEN')!.value
    const response = await fetch(`${kernel.base}/v1/${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const callback = () => {
    const cards = fake.of('sendToUser').filter(record => JSON.stringify(record.payload).includes('accounts.feishu.cn'))
    const url = JSON.stringify(cards.at(-1)?.payload).match(/https:\/\/accounts\.[^" ]+/)?.[0]
    if (!url) throw new Error('The real failed read did not deliver an OAuth card')
    const authorization = new URL(url), state = authorization.searchParams.get('state')!
    return { authorization, state, url: `${kernel.base}/oauth/callback?code=accepted-calendar&state=${encodeURIComponent(state)}` }
  }
  const runRows = () => kernel.registry.db.prepare('SELECT id,task_id,state,result_json,trigger_key FROM run_attempts ORDER BY rowid').all()
  const work = () => kernel.registry.workContexts.get(kernel.registry.taskWork.get(kernel.registry.taskForMessage(inbound.messageId)!.id)!.key)!
  const task = () => kernel.registry.taskForMessage(inbound.messageId)!
  const holdRead = async () => {
    const held = deferred(), entered = deferred(); releases.push(held.resolve)
    let read: Awaited<ReturnType<typeof post>> | undefined
    kernel.state.script = [{ kind: 'hook', run: async () => { read = await post('calendar/events'); entered.resolve(); await held.promise } },
      { kind: 'text', text: '已发出日历授权卡，完成后继续原请求。' }]
    const first = kernel.host.handleMessage(inbound)
    await expect.poll(() => read, { timeout: 2000 }).toBeDefined()
    expect(read).toMatchObject({ status: 403, body: { failure: { reason: initiallyConnected ? 'personal_scope_missing' : 'not_connected' } } })
    expect(work().pauseReasons.some(pause => pause.reason === 'authorization')).toBe(true)
    return { first, release: held.resolve, read: read! }
  }
  const nextScript = () => {
    const observed: { read?: Awaited<ReturnType<typeof post>> } = {}
    kernel.state.script = [{ kind: 'hook', run: async () => { observed.read = await post('calendar/events') } },
      { kind: 'text', text: '已核对日历，接下来是原请求的后续会议。' }]
    return observed
  }
  const reboot = async () => { await close(); kernel = await boot() }
  const crashSnapshot = () => {
    // Snapshot the actual live gateway DB at the crash boundary, then close the synthetic
    // process cleanly before restoring it. Never manufacture Run coverage or API receipts.
    const snapshot = join(home, 'crash-snapshot.sqlite')
    kernel.registry.db.prepare('VACUUM INTO ?').run(snapshot)
    return async () => {
      await close(); copyFileSync(snapshot, path); kernel = await boot()
      kernel.registry.failStaleTasks('synthetic-gateway-restart')
      kernel.host.recoverRuns()
    }
  }
  return { cfg, fake, options, inbound, post, callback, runRows, work, task, holdRead, nextScript, reboot, crashSnapshot,
    get k() { return kernel } }
}

describe('OAuth resumes the real original request', () => {
  it('returns the callback before the asking Run ends, then continues the same Task exactly once with separate result receipts', async () => {
    const t = await setup(), held = await t.holdRead(), callback = t.callback()
    expect(callback.authorization.searchParams.get('scope')?.split(' ')).toEqual([...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.calendar])
    const [response, concurrent] = await Promise.all([fetch(callback.url, { signal: AbortSignal.timeout(1500) }),
      fetch(callback.url, { signal: AbortSignal.timeout(1500) })])
    expect(response.status).toBe(200)
    expect(concurrent.status).toBe(200); await concurrent.text()
    expect(await response.text()).toContain('已连接')
    expect(t.runRows()).toHaveLength(1)
    expect(t.runRows()[0]?.state).toBe('running')
    const second = t.nextScript(); held.release(); await held.first
    await expect.poll(() => t.runRows().filter(run => ['completed', 'failed', 'cancelled'].includes(String(run.state))).length).toBe(2)
    expect(second.read).toMatchObject({ status: 200, body: { events: [{ summary: '原请求的后续会议' }] } })
    expect(t.task()).toMatchObject({ id: 1, status: 'done', messageId: t.inbound.messageId })
    expect(t.k.registry.listTasks(t.task().sessionKey)).toHaveLength(1)
    expect(t.runRows().map(run => run.task_id)).toEqual([1, 1])
    expect(t.k.registry.db.prepare('SELECT execution_boundary FROM run_attempts ORDER BY rowid').all())
      .toEqual([{ execution_boundary: 'managed_api_v1' }, { execution_boundary: 'managed_api_v1' }])
    expect(t.fake.exchanges.filter(exchange => exchange.code === 'accepted-calendar')).toHaveLength(1)
    expect(t.k.registry.dispatches.get(1)).toMatchObject({ generation: 1, inbound: t.inbound })
    expect(t.work().pauseReasons).toEqual([])
    const receipts = t.k.registry.db.prepare("SELECT delivery_key,status,remote_id FROM deliveries WHERE delivery_key LIKE '%:final:%' ORDER BY created_at,rowid").all()
    expect(receipts).toMatchObject([{ delivery_key: 'task:1:final:0', status: 'sent', remote_id: expect.any(String) },
      { delivery_key: 'task:1:resume:1:final:0', status: 'sent', remote_id: expect.any(String) }])
    const count = t.fake.exchanges.length
    expect((await fetch(callback.url)).status).toBe(200)
    await t.k.host.resumeAuthorizedRoutines('ou_alice'); await drain()
    expect(t.fake.exchanges).toHaveLength(count)
    expect(t.runRows()).toHaveLength(2)
    expect(t.k.registry.dispatches.get(1)?.generation).toBe(1)
  })

  it('keeps the original request waiting if the actual successful grant omitted the required calendar scope', async () => {
    const t = await setup(), held = await t.holdRead(); held.release(); await held.first
    t.fake.nextToken.scope = USER_SCOPE_TIERS.core.join(' ')
    expect((await fetch(t.callback().url)).status).toBe(200)
    await drain()
    expect(t.runRows()).toHaveLength(1)
    expect(t.k.registry.dispatches.get(1)?.generation).toBe(0)
    expect(t.work().pauseReasons.some(pause => pause.reason === 'authorization')).toBe(true)
  })

  it('does not replay a returned document creation after OAuth, even when the original ACP session still exists', async () => {
    const t = await setup()
    t.inbound.text = '创建一份合成会议文档，再读取我的日历。'
    let created: Awaited<ReturnType<typeof t.post>> | undefined
    t.k.state.script = [{ kind: 'hook', run: async () => {
      created = await t.post('doc/create', { title: '合成会议说明', markdown: '合成内容' })
      expect((await t.post('calendar/events')).status).toBe(403)
    } }, { kind: 'text', text: '文档已创建，日历需要补充授权。' }]
    await t.k.host.handleMessage(t.inbound)
    expect(created?.status).toBe(200)
    expect(t.fake.createdDocs).toHaveLength(1)
    expect(t.k.registry.db.prepare("SELECT state FROM run_api_calls WHERE route='POST /v1/doc/create'").get()?.state).toBe('returned')
    const resumed = t.nextScript()
    expect((await fetch(t.callback().url)).status).toBe(200)
    await drain()
    expect(t.runRows()).toHaveLength(1)
    expect(t.k.registry.dispatches.get(1)?.generation).toBe(0)
    expect(resumed.read).toBeUndefined()
    expect(t.fake.createdDocs).toHaveLength(1)
  })

  it('resumes the newer real input instead of appending the old request after its amendment', async () => {
    const t = await setup(), held = await t.holdRead()
    held.release(); await held.first
    t.options.routeAmend = true
    const followup: InboundMessage = { ...t.inbound, eventId: 'new-input', messageId: 'new-input',
      parentId: t.inbound.messageId, text: '改成明天的日历，今天的不用再看。' }
    await t.k.host.handleMessage(followup)
    const next = t.k.registry.taskForMessage(followup.messageId)!
    expect(next).toBeDefined()
    expect(t.k.registry.taskWork.get(next.id)?.key).toBe(t.work().workKey)
    const resumed = t.nextScript()
    expect((await fetch(t.callback().url)).status).toBe(200)
    await expect.poll(() => t.k.registry.getTask(next.id)?.status).toBe('done')
    expect(t.k.registry.dispatches.get(t.task().id)?.generation).toBe(0)
    expect(t.runRows().map(row => row.task_id)).toEqual([t.task().id, next.id])
    expect(resumed.read?.status).toBe(200)
    expect(t.k.state.allPrompts.at(-1)?.text).toContain(followup.text)
  })

  it('does not resume a first-time connection until the actual grant contains the scope needed by the original read', async () => {
    const t = await setup(false), held = await t.holdRead(); held.release(); await held.first
    t.fake.nextToken.scope = USER_SCOPE_TIERS.core.join(' ')
    expect((await fetch(t.callback().url)).status).toBe(200)
    await drain()
    expect(t.runRows()).toHaveLength(1)
    expect(t.k.registry.dispatches.get(1)?.generation).toBe(0)
    expect(t.work().pauseReasons.some(pause => pause.reason === 'authorization')).toBe(true)
  })

  it('keeps the existing grant and request waiting when the provider callback explicitly denies consent', async () => {
    const t = await setup(), held = await t.holdRead(); held.release(); await held.first
    const before = t.k.userTokens.get('ou_alice'), callback = new URL(t.callback().url)
    callback.searchParams.delete('code'); callback.searchParams.set('error', 'access_denied')
    const response = await fetch(callback)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('本次未授权')
    await drain()
    expect(t.k.userTokens.get('ou_alice')).toEqual(before)
    expect(t.runRows()).toHaveLength(1)
    expect(t.k.registry.dispatches.get(1)?.generation).toBe(0)
    expect(t.work().pauseReasons.some(pause => pause.reason === 'authorization')).toBe(true)
  })

  it.each(['stop', 'cancel', 'archive', 'wrong_identity', 'manual_pause', 'unknown_delivery'] as const)('does not resume after %s', async change => {
    const t = await setup(), held = await t.holdRead(), callback = t.callback()
    if (change === 'stop') await t.k.host.handleMessage({ ...t.inbound, messageId: 'human-stop', eventId: 'human-stop', text: '/stop' })
    if (change === 'cancel') t.k.registry.workContexts.control(t.work().workKey, { action: 'cancel', causeRef: 'human-cancel' })
    if (change === 'archive') t.k.spaces.archive(t.k.dm.id)
    if (change === 'manual_pause') t.k.registry.workContexts.control(t.work().workKey, { action: 'pause', reason: 'manual', causeRef: 'human-pause' })
    held.release(); await held.first
    if (change === 'unknown_delivery') {
      const receipt = t.k.registry.db.prepare("SELECT delivery_key FROM deliveries WHERE delivery_key LIKE 'task:1:final:%' LIMIT 1").get()
      expect(receipt).toBeDefined()
      t.k.registry.db.prepare("UPDATE deliveries SET status='unknown',remote_id=NULL WHERE delivery_key=?").run(receipt!.delivery_key)
    }
    if (change === 'wrong_identity') t.fake.identities.set('calendar-token', { openId: 'ou_bob', name: '其他用户' })
    const response = await fetch(callback.url)
    expect(response.status).toBe(change === 'wrong_identity' ? 400 : 200)
    await drain()
    expect(t.runRows()).toHaveLength(1)
    expect(t.k.registry.dispatches.get(1)?.generation).toBe(0)
    if (change === 'unknown_delivery' || change === 'manual_pause') {
      const before = t.fake.sent.length
      t.options.progressQuery = true
      await t.k.host.handleMessage({ ...t.inbound, messageId: 'progress-after-connect', eventId: 'progress-after-connect',
        parentId: t.inbound.messageId, text: '这个原请求目前是什么状态？' })
      const reply = JSON.stringify(t.fake.sent.slice(before))
      expect(reply).toContain(change === 'unknown_delivery' ? '结果待核对' : '已暂停')
      expect(reply).not.toContain('连接所需账号')
      expect(t.runRows()).toHaveLength(1)
      expect(t.work().pauseReasons.some(pause => pause.reason === 'authorization')).toBe(true)
    }
  })

  it('recovers the same request after credentials committed but the callback wakeup was lost in a restart', async () => {
    const t = await setup(), held = await t.holdRead(); held.release(); await held.first
    t.options.callbackWake = false
    expect((await fetch(t.callback().url)).status).toBe(200)
    expect(t.runRows()).toHaveLength(1)
    expect(t.k.userTokens.isConnected('ou_alice')).toBe(true)
    await t.reboot()
    const resumed = t.nextScript()
    await t.k.host.recoverHandoffs()
    await expect.poll(() => t.task().status).toBe('done')
    await expect.poll(() => t.runRows().length).toBe(2)
    await expect.poll(() => t.runRows().at(-1)?.state).toBe('completed')
    expect(resumed.read).toMatchObject({ status: 200 })
    expect(t.k.registry.dispatches.get(1)).toMatchObject({ inbound: t.inbound, generation: 1 })
    expect(t.work().pauseReasons).toEqual([])
    await t.k.host.recoverHandoffs(); await drain()
    expect(t.runRows()).toHaveLength(2)
  })

  it('recovers a managed read-only request if the gateway crashes after OAuth commits while its original Run is still alive', async () => {
    const t = await setup(), held = await t.holdRead()
    t.options.callbackWake = false
    expect((await fetch(t.callback().url)).status).toBe(200)
    expect(t.runRows()[0]?.state).toBe('running')
    const restoreCrash = t.crashSnapshot()
    held.release(); await held.first
    await restoreCrash()
    expect(t.runRows()[0]?.state).toBe('interrupted')
    const resumed = t.nextScript()
    await t.k.host.recoverHandoffs()
    await expect.poll(() => t.runRows().length).toBe(2)
    await expect.poll(() => t.runRows().at(-1)?.state).toBe('completed')
    expect(resumed.read).toMatchObject({ status: 200 })
    expect(t.k.registry.dispatches.get(1)).toMatchObject({ generation: 1, inbound: t.inbound })
    expect(t.work().pauseReasons).toEqual([])
  })

  it.each(['read_returned', 'read_pending', 'human_stop', 'archived', 'unknown_write', 'returned_write', 'workspace'] as const)
    ('ordinary restart recovery uses actual execution and API evidence: %s', async boundary => {
    const t = await setup(true, boundary === 'workspace' ? 'workspace' : 'managed')
    await t.k.userTokens.complete({ openId: 'ou_alice', code: 'initial-calendar', redirectUri: t.cfg.feishu.oauth.redirectUri })
    const entered = deferred(), release = deferred()
    let firstRead: Awaited<ReturnType<typeof t.post>> | undefined
    if (boundary === 'read_pending') {
      const original = t.fake.listMyEvents.bind(t.fake)
      t.fake.listMyEvents = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
    }
    if (boundary === 'unknown_write') {
      t.inbound.text = '请创建一份本人的会议说明文档，正文是合成内容。'
      const original = t.fake.createDocument.bind(t.fake)
      t.fake.createDocument = async (...args) => {
        // Provider accepted the document; gateway has not observed its receipt at crash time.
        const created = await original(...args); entered.resolve(); await release.promise; return created
      }
    }
    t.k.state.script = [{ kind: 'hook', run: async () => {
      if (boundary === 'unknown_write' || boundary === 'returned_write') {
        expect((await t.post('doc/create', { title: '合成会议说明', markdown: '合成内容' })).status).toBe(200)
      }
      else firstRead = await t.post('calendar/events')
      entered.resolve(); await release.promise
    } }, { kind: 'text', text: '原请求执行结果。' }]
    const first = t.k.host.handleMessage(t.inbound)
    try {
      await entered.promise
      if (boundary !== 'read_pending' && boundary !== 'unknown_write' && boundary !== 'returned_write') expect(firstRead).toMatchObject({ status: 200 })
      expect(t.work().pauseReasons).toEqual([])
      if (boundary === 'human_stop') await t.k.host.handleMessage({ ...t.inbound, messageId: 'stop-before-crash', eventId: 'stop-before-crash', text: '/stop' })
      if (boundary === 'archived') t.k.spaces.archive(t.k.dm.id)
      if (boundary === 'unknown_write') {
        expect(t.fake.createdDocs).toHaveLength(1)
        expect(t.k.registry.db.prepare("SELECT state,scopes_json FROM run_api_calls WHERE route='POST /v1/doc/create'").get())
          .toMatchObject({ state: 'started', scopes_json: expect.stringContaining('doc:write') })
      }
      if (boundary === 'returned_write') {
        expect(t.fake.createdDocs).toHaveLength(1)
        expect(t.k.registry.db.prepare("SELECT state FROM run_api_calls WHERE route='POST /v1/doc/create'").get()?.state).toBe('returned')
      }
      const restoreCrash = t.crashSnapshot()
      release.resolve(); await first
      await restoreCrash()
      const resumed = t.nextScript()
      await t.k.host.recoverHandoffs()
      if (boundary === 'read_returned' || boundary === 'read_pending') {
        await expect.poll(() => t.runRows().length).toBe(2)
        await expect.poll(() => t.runRows().at(-1)?.state).toBe('completed')
        expect(resumed.read).toMatchObject({ status: 200 })
        expect(t.k.registry.dispatches.get(1)).toMatchObject({ generation: 1, inbound: t.inbound, resume: { reason: 'restart' } })
        expect(t.k.registry.listTasks(t.task().sessionKey)).toHaveLength(1)
      } else {
        await drain()
        expect(t.runRows()).toHaveLength(1)
        expect(t.k.registry.dispatches.get(1)?.generation).toBe(0)
        expect(resumed.read).toBeUndefined()
        if (boundary === 'unknown_write' || boundary === 'returned_write') expect(t.fake.createdDocs).toHaveLength(1)
      }
    } finally { release.resolve(); await first }
  })
})
