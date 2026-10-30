import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { SpaceLifecycle } from '../src/core/space-lifecycle.js'
import { AUTH_EXPIRED, RoutineStore } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

// Real localhost HTTP callback, SQLite stores, command and card handlers.
// Only the external OAuth/Feishu provider and ACP agent are synthetic.
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'friday-oauth-resume-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const log = createLogger('oauth-resume', 'error')
  const registry = new Registry(':memory:')
  const clock = { now: Date.parse('2026-09-20T06:00:00Z') }
  const sp = spaceDeps(registry.db)
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm_alice', openId: 'ou_alice' })
  const routines = new RoutineStore(registry.db)
  const feishu = new FakeFeishu()
  const userTokens = new UserTokenStore(registry.db, feishu, () => clock.now)
  const memory = new ChannelMemory(registry.db)
  const messageCache = new MessageCache(registry.db)
  const messages = new MessageService(asFeishuClient(feishu), messageCache, log)
  const todos = new Todos(registry.db)
  const tokens = new TokenIssuer('synthetic-capability-secret')
  const { app, state: agentState } = createFakeAgent()
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory, messageCache, messages, todos, routines, userTokens, ...sp, tokens, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', now: () => clock.now, log })
  const api = createInternalApi({ appId: cfg.feishu.appId, feishu: asFeishuClient(feishu), memory, registry, messages, messageCache, todos, routines, userTokens, oauthRedirectUri: cfg.feishu.oauth.redirectUri, onAuthorizationCompleted: (openId) => orchestrator.resumeAuthorizedRoutines(openId), ...sp, tokens, log, maxHistoryPerCall: 50 })
  cleanup.push(async () => {
    await runtime.stop()
    if (api.server.listening) await new Promise<void>((resolve, reject) => api.server.close((err) => err ? reject(err) : resolve()))
    registry.close()
    rmSync(home, { recursive: true, force: true })
  })
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`

  // Start with a real stored token, then let both access and refresh expire.
  feishu.nextToken = { accessToken: 'synthetic-old-access', expiresIn: 60, refreshToken: 'synthetic-old-refresh', refreshTokenExpiresIn: 60, scope: 'im:chat:readonly im:message.group_msg:get_as_user' }
  await userTokens.complete({ code: 'synthetic-initial-code', state: userTokens.begin('ou_alice'), redirectUri: cfg.feishu.oauth.redirectUri, openId: 'ou_alice' })
  expect(userTokens.isConnected('ou_alice')).toBe(true)
  const addWatch = (name: string) => routines.add({ kind: 'watch', ownerOpenId: 'ou_alice', runAs: 'ou_alice', spaceId: dm.id, chatId: dm.chatId!, chatType: 'p2p', name, prompt: '只总结合成测试群', schedule: { type: 'interval', everyMinutes: 60 }, watchChatIds: ['oc_synthetic_source'], now: clock.now })
  const watch = addWatch('待恢复的盯群')
  const cursor = Math.floor(clock.now / 1000) + 30
  expect(routines.advanceMessageCursor(watch.id, routines.configVersion(watch.id)!, Math.floor(clock.now / 1000), cursor)).toBe(true)
  const manual = addWatch('保留手动暂停')
  routines.setEnabled(manual.id, false, clock.now)
  const other = routines.add({ kind: 'watch', ownerOpenId: 'ou_bob', runAs: 'ou_bob', spaceId: sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm_bob', openId: 'ou_bob' }).id, chatId: 'oc_dm_bob', chatType: 'p2p', name: '其他人的盯群', prompt: '只总结合成测试群', schedule: { type: 'interval', everyMinutes: 60 }, watchChatIds: ['oc_synthetic_source'], now: clock.now })
  routines.suspendForExpiredAuth('ou_bob', clock.now)
  clock.now += 61_000
  expect(userTokens.isConnected('ou_alice')).toBe(false)
  expect(routines.suspendForExpiredAuth('ou_alice', clock.now).map((r) => r.id)).toEqual([watch.id])
  expect(routines.get(watch.id)).toMatchObject({ enabled: false, disabledReason: AUTH_EXPIRED })
  feishu.nextToken = { accessToken: 'synthetic-renewed-access', expiresIn: 7200, refreshToken: 'synthetic-renewed-refresh', refreshTokenExpiresIn: 30 * 86400, scope: 'im:chat:readonly im:message.group_msg:get_as_user' }
  feishu.identities.set('synthetic-renewed-access', { openId: 'ou_alice', name: '合成用户 Alice' })
  const compact = (id: number) => {
    const r = routines.get(id)!
    return { id: r.id, enabled: r.enabled, disabledReason: r.disabledReason, status: r.status, runAs: r.runAs, messageCursorSec: r.messageCursorSec, nextRunAt: r.nextRunAt }
  }
  return { cfg, registry, userTokens, feishu, orchestrator, agentState, routines, watch, manual, other, baseUrl, clock, compact, cursor, dm, ...sp }
}

type Fixture = Awaited<ReturnType<typeof setup>>

it('an unconnected status check is truthful and does not send another DM', async () => {
  const t = await setup()
  const before = t.feishu.of('sendToUser').length
  const response = await t.orchestrator.handleCardAction({ operatorOpenId: 'ou_alice', value: { action: 'oauth', op: 'check' }, messageId: 'om_card', token: 'synthetic' } as never) as { toast?: { content?: string } }
  expect(response.toast?.content).toContain('尚未连接')
  expect(response.toast?.content).not.toMatch(/授权其实已经成了|回调页面打不开|授权暂不可用/)
  expect(t.feishu.of('sendToUser')).toHaveLength(before)
})

it('escapes the verified display name and prevents caching of callback pages', async () => {
  const t = await setup()
  t.feishu.identities.set('synthetic-renewed-access', { openId: 'ou_alice', name: '<script>bad()</script>' })
  const c = callback(t)
  const response = await fetch(c.url)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  const html = await response.text()
  expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
  expect(html).not.toContain('<script>')
})
type Route = 'http-callback' | 'pasted-callback'

function callback(t: Fixture) {
  const state = t.userTokens.begin('ou_alice')
  return { state, url: `${t.baseUrl}/oauth/callback?code=synthetic-renewal-code&state=${state}` }
}

async function authorize(t: Fixture, route: Route) {
  const c = callback(t)
  if (route === 'http-callback') {
    const response = await fetch(c.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('已连接')
  } else {
    await t.orchestrator.handleMessage({ eventId: 'synthetic-event', messageId: 'om_synthetic_callback', chatId: 'oc_dm_alice', chatType: 'p2p', msgType: 'text', text: `/auth ${c.url}`, senderOpenId: 'ou_alice', senderType: 'user', createTimeMs: t.clock.now, mentions: [] })
    expect(String(t.feishu.of('replyText').at(-1)?.payload ?? '')).toContain('已连接')
  }
  expect(t.userTokens.isConnected('ou_alice')).toBe(true)
  expect(t.userTokens.ownerOfState(c.state)).toBeUndefined()
  expect(t.feishu.exchanges).toEqual([
    { code: 'synthetic-initial-code', redirectUri: t.cfg.feishu.oauth.redirectUri },
    { code: 'synthetic-renewal-code', redirectUri: t.cfg.feishu.oauth.redirectUri },
  ])
  return c
}

async function clickComplete(t: Fixture) {
  return await t.orchestrator.handleCardAction({ operatorOpenId: 'ou_alice', value: { action: 'oauth', op: 'check' }, messageId: 'om_synthetic_card', token: 'synthetic-card-token' } as never) as { toast?: { type?: string; content?: string } }
}

async function checkAuthorization(t: Fixture) {
  const result = await clickComplete(t)
  expect(result.toast?.type).toBe('success')
  expect(result.toast?.content).toMatch(/已连[接上]/)
  return result
}

function storedRoutine(t: Fixture, id = t.watch.id) {
  return t.registry.db.prepare('SELECT * FROM routines WHERE id = ?').get(id)
}

describe('OAuth completion and watch recovery', () => {
  it('an expired watch sends one actual watch upgrade card whose successful callback restores the cursor', async () => {
    const t = await setup()
    t.routines.setEnabled(t.watch.id, true, t.clock.now)
    expect(await t.orchestrator.runRoutine(t.routines.get(t.watch.id)!, { manualMessageId: 'synthetic-expired-watch' })).toBe('skipped')
    const cards = t.feishu.of('sendToUser').filter(record => 'card' in (record.payload as object))
    expect(cards).toHaveLength(1)
    const card = cards[0]!.payload as { card: { body: { elements: { tag: string; behaviors?: { default_url?: string }[] }[] } } }
    const authorize = new URL(card.card.body.elements.find(item => item.tag === 'button')!.behaviors![0]!.default_url!)
    expect(authorize.searchParams.get('scope')!.split(' ')).toEqual(['im:chat:readonly', 'im:message.group_msg:get_as_user'])
    const callbackUrl = new URL('/oauth/callback', t.baseUrl)
    callbackUrl.searchParams.set('code', 'synthetic-watch-renewal')
    callbackUrl.searchParams.set('state', authorize.searchParams.get('state')!)
    expect((await fetch(callbackUrl)).status).toBe(200)
    expect(t.routines.get(t.watch.id)).toMatchObject({ enabled: true, disabledReason: null, messageCursorSec: t.cursor })
    expect(t.agentState.allPrompts).toHaveLength(0)
  })

  it.each(['http-callback', 'pasted-callback'] as const)('%s restores expired watches before the completion click and preserves the message cursor', async (route) => {
    const t = await setup()
    const manualBefore = storedRoutine(t, t.manual.id)
    const otherBefore = storedRoutine(t, t.other.id)
    expect(t.compact(t.watch.id)).toMatchObject({ enabled: false, disabledReason: AUTH_EXPIRED, messageCursorSec: t.cursor })

    await authorize(t, route)
    // Recovery must be part of successful authorization, not require another click.
    expect(t.compact(t.watch.id)).toMatchObject({ enabled: true, disabledReason: null, messageCursorSec: t.cursor })
    const afterAuthorization = storedRoutine(t)
    await checkAuthorization(t)
    expect(storedRoutine(t)).toEqual(afterAuthorization)
    expect(storedRoutine(t, t.manual.id)).toEqual(manualBefore)
    expect(storedRoutine(t, t.other.id)).toEqual(otherBefore)
    expect(t.agentState.allPrompts).toHaveLength(0)
  })

  it('repeated HTTP callback and completion clicks do not rewind the cursor, replan or resurrect a newly paused watch', async () => {
    const t = await setup()
    const c = await authorize(t, 'http-callback')
    expect(t.routines.get(t.watch.id)?.enabled).toBe(true)
    expect(t.routines.advanceMessageCursor(t.watch.id, t.routines.configVersion(t.watch.id)!, t.cursor, t.cursor + 30)).toBe(true)
    const afterProgress = storedRoutine(t)
    const exchanges = t.feishu.exchanges.length
    t.clock.now += 120_000

    const repeated = await fetch(c.url)
    expect(repeated.status).toBe(200)
    expect(await repeated.text()).toContain('已连接')
    expect(t.feishu.exchanges).toHaveLength(exchanges)
    await checkAuthorization(t)
    await checkAuthorization(t)
    expect(storedRoutine(t)).toEqual(afterProgress)

    t.routines.setEnabled(t.watch.id, false, t.clock.now)
    const manuallyPaused = storedRoutine(t)
    await checkAuthorization(t)
    expect(storedRoutine(t)).toEqual(manuallyPaused)
    expect(t.compact(t.watch.id)).toMatchObject({ enabled: false, disabledReason: '手动停用', messageCursorSec: t.cursor + 30 })
    expect(t.agentState.allPrompts).toHaveLength(0)
  })

  it('HTTP authorization does not revive an AUTH_EXPIRED watch whose space was subsequently archived', async () => {
    const t = await setup()
    // Space suspension supersedes the old token-expiry reason, without changing
    // the message cursor or hand-enabled state of unrelated routines.
    const lifecycle = new SpaceLifecycle({ registry: t.registry, routines: t.routines, spaces: t.spaces, stopRuntime: async () => {} })
    await lifecycle.stop(t.dm.id)
    expect(t.spaces.get(t.dm.id)?.status).toBe('archived')
    expect(t.compact(t.watch.id)).toMatchObject({ enabled: false, disabledReason: '空间已停用', messageCursorSec: t.cursor })
    const beforeAuthorization = storedRoutine(t)
    const manualBefore = storedRoutine(t, t.manual.id)

    // A paused DM blocks new chat commands; a browser callback can still arrive.
    await authorize(t, 'http-callback')
    await checkAuthorization(t)
    expect(storedRoutine(t)).toEqual(beforeAuthorization)
    expect(storedRoutine(t, t.manual.id)).toEqual(manualBefore)
    expect(t.spaces.get(t.dm.id)?.status).toBe('archived')
    expect(t.agentState.allPrompts).toHaveLength(0)
  })

  it('the completion button recovers a valid stored authorization without another token exchange', async () => {
    const t = await setup()
    // Models an already completed exchange whose host recovery was interrupted.
    const state = t.userTokens.begin('ou_alice')
    await t.userTokens.complete({ code: 'synthetic-renewal-code', state, redirectUri: t.cfg.feishu.oauth.redirectUri })
    expect(t.userTokens.isConnected('ou_alice')).toBe(true)
    expect(t.routines.get(t.watch.id)?.enabled).toBe(false)
    const exchanges = t.feishu.exchanges.length
    await checkAuthorization(t)
    expect(t.compact(t.watch.id)).toMatchObject({ enabled: true, disabledReason: null, messageCursorSec: t.cursor })
    expect(t.routines.get(t.manual.id)).toMatchObject({ enabled: false, disabledReason: '手动停用' })
    expect(t.feishu.exchanges).toHaveLength(exchanges)
    expect(t.agentState.allPrompts).toHaveLength(0)
  })

  it('restoring an archived space does not let later OAuth completion re-enable its old watch', async () => {
    const t = await setup()
    const lifecycle = new SpaceLifecycle({ registry: t.registry, routines: t.routines, spaces: t.spaces, stopRuntime: async () => {} })
    await lifecycle.stop(t.dm.id)
    expect(t.spaces.resume(t.dm.chatId!)?.status).toBe('active')
    expect(t.routines.get(t.watch.id)?.enabled).toBe(false)
    const beforeAuthorization = storedRoutine(t)

    await authorize(t, 'http-callback')
    await checkAuthorization(t)
    expect(t.spaces.get(t.dm.id)?.status).toBe('active')
    expect(storedRoutine(t)).toEqual(beforeAuthorization)
    expect(t.compact(t.watch.id)).toMatchObject({ enabled: false, messageCursorSec: t.cursor })
    expect(t.agentState.allPrompts).toHaveLength(0)
  })

  it('leaves an old AUTH_EXPIRED marker paused when its bound space is already archived', async () => {
    const t = await setup()
    // Mirrors an old persisted state before lifecycle suspension replaced the
    // AUTH_EXPIRED reason. It must not rely solely on the reason string.
    t.spaces.archive(t.dm.id)
    const beforeAuthorization = storedRoutine(t)
    expect(t.routines.get(t.watch.id)?.disabledReason).toBe(AUTH_EXPIRED)

    await authorize(t, 'http-callback')
    await checkAuthorization(t)
    expect(t.spaces.get(t.dm.id)?.status).toBe('archived')
    expect(storedRoutine(t)).toEqual(beforeAuthorization)
    expect(t.agentState.allPrompts).toHaveLength(0)
  })

  it('does not report success or restore a watch when the stored refresh token fails', async () => {
    const t = await setup()
    await t.userTokens.complete({ code: 'synthetic-renewal-code', state: t.userTokens.begin('ou_alice'), redirectUri: t.cfg.feishu.oauth.redirectUri })
    t.clock.now += 7200_000
    // isConnected remains true because a refresh token is present; the button
    // must await its real provider result before resuming any routine.
    expect(t.userTokens.isConnected('ou_alice')).toBe(true)
    t.feishu.refresh = async () => { t.feishu.refreshes += 1; throw new Error('synthetic refresh rejected') }
    const before = storedRoutine(t)
    const result = await clickComplete(t)

    expect(t.feishu.refreshes).toBe(1)
    expect(result.toast?.type).not.toBe('success')
    expect(result.toast?.content).not.toMatch(/已连[接上]/)
    expect(storedRoutine(t)).toEqual(before)
    expect(t.routines.get(t.manual.id)).toMatchObject({ enabled: false, disabledReason: '手动停用' })
    expect(t.agentState.allPrompts).toHaveLength(0)
  })

  it('rechecks space suspension after awaiting a successful token refresh', async () => {
    const t = await setup()
    await t.userTokens.complete({ code: 'synthetic-renewal-code', state: t.userTokens.begin('ou_alice'), redirectUri: t.cfg.feishu.oauth.redirectUri })
    t.clock.now += 7200_000
    let entered!: () => void
    let release!: () => void
    const refreshing = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    t.feishu.refresh = async () => {
      t.feishu.refreshes += 1
      entered()
      await gate
      return t.feishu.nextToken
    }
    const completion = clickComplete(t)
    await refreshing
    const lifecycle = new SpaceLifecycle({ registry: t.registry, routines: t.routines, spaces: t.spaces, stopRuntime: async () => {} })
    try { await lifecycle.stop(t.dm.id) } finally { release() }
    const stopped = storedRoutine(t)
    await completion

    expect(t.feishu.refreshes).toBe(1)
    expect(t.userTokens.isConnected('ou_alice')).toBe(true)
    expect(t.spaces.get(t.dm.id)?.status).toBe('archived')
    expect(storedRoutine(t)).toEqual(stopped)
    expect(t.compact(t.watch.id)).toMatchObject({ enabled: false, disabledReason: '空间已停用', messageCursorSec: t.cursor })
    expect(t.agentState.allPrompts).toHaveLength(0)
  })

  it('does not recreate a disconnected token or resume its watch when an old refresh returns', async () => {
    const t = await setup()
    await t.userTokens.complete({ code: 'synthetic-renewal-code', state: t.userTokens.begin('ou_alice'), redirectUri: t.cfg.feishu.oauth.redirectUri })
    t.clock.now += 7200_000
    let entered!: () => void
    let release!: () => void
    const refreshing = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const oldResponse = { ...t.feishu.nextToken, accessToken: 'synthetic-old-refresh-result' }
    t.feishu.refresh = async () => { entered(); await gate; return oldResponse }
    const before = storedRoutine(t)
    const completion = clickComplete(t)
    await refreshing
    try {
      await t.orchestrator.handleMessage({ eventId: 'synthetic-disconnect', messageId: 'om_synthetic_disconnect', chatId: 'oc_dm_alice', chatType: 'p2p', msgType: 'text', text: '/disconnect', senderOpenId: 'ou_alice', senderType: 'user', createTimeMs: t.clock.now, mentions: [] })
      expect(t.userTokens.get('ou_alice')).toBeUndefined()
    } finally { release() }
    const result = await completion

    expect(result.toast?.type).not.toBe('success')
    expect(t.userTokens.get('ou_alice')).toBeUndefined()
    expect(storedRoutine(t)).toEqual(before)
    expect(t.agentState.allPrompts).toHaveLength(0)
  })

  it('does not overwrite a newer authorization with an older in-flight refresh response', async () => {
    const t = await setup()
    await t.userTokens.complete({ code: 'synthetic-renewal-code', state: t.userTokens.begin('ou_alice'), redirectUri: t.cfg.feishu.oauth.redirectUri })
    t.clock.now += 7200_000
    let entered!: () => void
    let release!: () => void
    const refreshing = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const oldResponse = { ...t.feishu.nextToken, accessToken: 'synthetic-stale-access', refreshToken: 'synthetic-stale-refresh' }
    t.feishu.refresh = async () => { entered(); await gate; return oldResponse }
    const completion = clickComplete(t)
    await refreshing
    t.clock.now += 1
    t.feishu.nextToken = { ...t.feishu.nextToken, accessToken: 'synthetic-newest-access', refreshToken: 'synthetic-newest-refresh' }
    let newest: ReturnType<typeof t.userTokens.get>
    try {
      await t.userTokens.complete({ code: 'synthetic-new-authorization', state: t.userTokens.begin('ou_alice'), redirectUri: t.cfg.feishu.oauth.redirectUri })
      newest = t.userTokens.get('ou_alice')
      expect(newest?.accessToken).toBe('synthetic-newest-access')
    } finally { release() }
    await completion

    expect(t.userTokens.get('ou_alice')).toEqual(newest)
    expect(t.routines.get(t.watch.id)?.messageCursorSec).toBe(t.cursor)
    expect(t.routines.get(t.manual.id)).toMatchObject({ enabled: false, disabledReason: '手动停用' })
    expect(t.agentState.allPrompts).toHaveLength(0)
  })

  it('checks current authorization again after awaiting an already-resolved valid token', async () => {
    const t = await setup()
    await t.userTokens.complete({ code: 'synthetic-renewal-code', state: t.userTokens.begin('ou_alice'), redirectUri: t.cfg.feishu.oauth.redirectUri })
    const before = storedRoutine(t)
    const completion = clickComplete(t)
    // accessTokenFor returns a resolved Promise for a fresh token, but the host
    // still yields once at await. Revocation in that gap must remain effective.
    t.userTokens.disconnect('ou_alice')
    const result = await completion

    expect(t.feishu.refreshes).toBe(0)
    expect(result.toast?.type).not.toBe('success')
    expect(t.userTokens.get('ou_alice')).toBeUndefined()
    expect(storedRoutine(t)).toEqual(before)
    expect(t.agentState.allPrompts).toHaveLength(0)
  })

  it.each([
    { kind: 'watch', status: 'proposed' },
    { kind: 'watch', status: 'ignored' },
    { kind: 'schedule', status: 'active' },
  ] as const)('does not resume legacy $kind/$status records carrying an AUTH_EXPIRED marker', async ({ kind, status }) => {
    const t = await setup()
    const legacy = t.routines.add({ kind, ownerOpenId: 'ou_alice', runAs: 'ou_alice', spaceId: t.dm.id, chatId: t.dm.chatId!, chatType: 'p2p', name: '旧状态记录', prompt: '合成旧记录', schedule: { type: 'interval', everyMinutes: 60 }, watchChatIds: kind === 'watch' ? ['oc_synthetic_source'] : undefined, now: t.clock.now })
    // Deliberate legacy-state fixture: public suspendForExpiredAuth correctly
    // never creates this combination, but recovery must not activate it either.
    t.registry.db.prepare('UPDATE routines SET status = ?, enabled = 0, disabled_reason = ? WHERE id = ?').run(status, AUTH_EXPIRED, legacy.id)
    const beforeAuthorization = storedRoutine(t, legacy.id)

    await authorize(t, 'http-callback')
    await checkAuthorization(t)
    expect(t.routines.get(t.watch.id)?.enabled).toBe(true)
    expect(storedRoutine(t, legacy.id)).toEqual(beforeAuthorization)
    expect(t.agentState.allPrompts).toHaveLength(0)
  })
})
