import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore, AUTH_EXPIRED } from '../src/core/routines.js'
import { ChatReadScope } from '../src/core/chat-read-scope.js'
import { UserTokenStore, USER_SCOPE_TIERS, type UserScopeExtra } from '../src/feishu/oauth.js'
import { FeishuApiError, FeishuClient } from '../src/feishu/client.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
const WATCH = { kind: 'watch', name: '关注测试群', prompt: '总结测试群中的问题', chats: ['oc_source'], schedule: { type: 'interval', everyMinutes: 60 } }

async function setup(tiers: UserScopeExtra[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'friday-personal-scope-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), sp = spaceDeps(registry.db)
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'alice' })
  const routines = new RoutineStore(registry.db), readScope = new ChatReadScope(registry.db)
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('personal-scope', 'error')
  const { app } = createFakeAgent(), runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, log,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  let scope = [...USER_SCOPE_TIERS.core, ...tiers.flatMap(tier => USER_SCOPE_TIERS[tier])].join(' '), version = 0
  const userTokens = new UserTokenStore(registry.db, { exchangeCode: async () => ({ accessToken: `SYNTHETIC_TOKEN_${++version}`, expiresIn: 7200, scope }), refresh: async () => { throw new Error('unexpected') } })
  const connect = async (next = scope) => { scope = next; await userTokens.complete({ openId: 'alice', code: 'synthetic', redirectUri: 'https://callback.invalid' });
    fake.userChats.set(userTokens.get('alice')!.accessToken, [{ chatId: 'oc_source', name: '测试群' }]) }
  await connect()
  const tokens = new TokenIssuer('synthetic-capability-key')
  const host = new Orchestrator({ cfg, registry, memory, ...sp, feishu, runtime, userTokens, routines, readScope,
    tokens, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  let current: { requesterOpenId: string; runId: string; stage: string; controlRevision: number } | undefined =
    { requesterOpenId: 'alice', runId: 'run_a', stage: 'task', controlRevision: 0 }
  const onSource = vi.fn(), offer = vi.spyOn(host.abilities, 'offerConnect')
  const calendar = vi.spyOn(feishu, 'listMyEvents'), chats = vi.spyOn(feishu, 'listChatsResult')
  const api = createInternalApi({ registry, memory, ...sp, feishu, tokens, log, maxHistoryPerCall: 10, userTokens, routines, readScope,
    resolveActorForSession: () => current, abilities: host.abilities, onExternalSourceRead: onSource, canPersistDerivedState: () => true })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve()));
    await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const cap = { sessionKey: 'session_a', runId: 'run_a', chatId: 'oc_dm', chatType: 'p2p' as const, spaceId: dm.id, requesterOpenId: 'alice',
    scopes: ['calendar:read', 'routine:write', 'chat:read', 'chat:read-others'] }
  const post = async (path: string, body: Record<string, unknown> = {}, patch: Partial<Omit<Capability, 'exp'>> = {}) => {
    const response = await fetch(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${tokens.issue({ ...cap, ...patch })}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  const cards = () => fake.of('sendToUser').filter(record => 'card' in (record.payload as object))
  const cardScopes = () => {
    const serialized = JSON.stringify(cards().at(-1)!.payload)
    const url = serialized.match(/https:\/\/accounts\.[^" ]+/)![0]
    return new URL(url).searchParams.get('scope')!.split(' ')
  }
  return { post, connect, cfg, host, fake, userTokens, registry, routines, readScope, dm, ...sp, calendar, chats, onSource, offer, cards, cardScopes,
    stop: () => { current = undefined }, changeRun: () => { current!.runId = 'run_b' }, changeControl: () => { current!.controlRevision++ } }
}

describe('on-demand personal scope upgrades through real HTTP and cards', () => {
  it.each(['calendar', 'watch'] as const)('core-only %s creates one incremental card across retries and performs no resource read', async tier => {
    const t = await setup(), path = tier === 'calendar' ? 'calendar/events' : 'routine/add', body = tier === 'calendar' ? {} : WATCH
    // Config had once requested everything; actual accepted core must stay authoritative.
    t.cfg.feishu.oauth.scopes = Object.values(USER_SCOPE_TIERS).flat()
    expect((await t.post(path, body)).status).toBe(403)
    expect((await t.post(path, body)).status).toBe(403)
    expect(t.offer).toHaveBeenCalledWith(expect.objectContaining({ requesterOpenId: 'alice' }), [tier],
      expect.objectContaining({ reason: 'personal_scope_missing', scopes: USER_SCOPE_TIERS[tier].filter(scope => !USER_SCOPE_TIERS.core.includes(scope)) }))
    expect(t.cards()).toHaveLength(1)
    expect(t.cardScopes()).toEqual([...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS[tier]])
    expect(t.calendar).not.toHaveBeenCalled(); expect(t.chats).not.toHaveBeenCalled()
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM routines').get()).toEqual({ n: 0 })
  })

  it('preserves accepted optional scopes and partial core without re-requesting denied groups', async () => {
    const t = await setup(['minutes'])
    const partial = ['offline_access', 'im:chat:readonly', ...USER_SCOPE_TIERS.minutes]
    await t.connect(partial.join(' ')); t.cfg.feishu.oauth.scopes = Object.values(USER_SCOPE_TIERS).flat()
    expect((await t.post('calendar/events')).status).toBe(403)
    expect(t.cardScopes()).toEqual([...partial, ...USER_SCOPE_TIERS.calendar])
    expect(t.cardScopes()).not.toContain('im:message.group_msg:get_as_user')
    expect(t.cardScopes()).not.toContain('docx:document')
  })

  it.each(['calendar', 'watch'] as const)('an absent token requests %s at first connection', async tier => {
    const t = await setup(); t.userTokens.disconnect('alice')
    expect((await t.post(tier === 'calendar' ? 'calendar/events' : 'routine/add', tier === 'calendar' ? {} : WATCH)).status).toBe(403)
    expect(t.cardScopes()).toEqual([...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS[tier]])
  })

  it.each(['calendar', 'watch'] as const)('provider resource denial with granted %s does not trigger another authorization', async tier => {
    const t = await setup([tier]), failure = new FeishuApiError('synthetic.resource', 99991663, 'PRIVATE_PROVIDER_DETAIL')
    if (tier === 'calendar') t.calendar.mockRejectedValueOnce(failure)
    else t.chats.mockRejectedValueOnce(failure)
    const r = await t.post(tier === 'calendar' ? 'calendar/events' : 'routine/add', tier === 'calendar' ? {} : WATCH)
    expect(r.status).toBe(403); expect(r.body.failure).toMatchObject({ reason: 'access_rejected', next: 'check_resource_or_configuration' })
    expect(r.body.error).not.toContain('PRIVATE_PROVIDER_DETAIL'); expect(t.cards()).toHaveLength(0)
    expect(t.onSource).not.toHaveBeenCalled()
  })

  it('a real accepted calendar grant permits reads and records personal provenance', async () => {
    const t = await setup(['calendar'])
    expect((await t.post('calendar/events')).status).toBe(200)
    expect(t.calendar).toHaveBeenCalledWith({ userToken: t.userTokens.get('alice')!.accessToken }, expect.any(Object), expect.any(Function))
    expect(t.onSource).toHaveBeenCalledWith('session_a', expect.objectContaining({ kind: 'calendar', personalOpenId: 'alice', access: 'user' }))
    expect(t.cards()).toHaveLength(0)
  })

  it('a real accepted watch grant and visible group create a durable watch exactly after validation', async () => {
    const t = await setup(['watch']), r = await t.post('routine/add', WATCH)
    expect(r.status).toBe(200)
    expect(t.routines.get(r.body.routine.id)).toMatchObject({ kind: 'watch', ownerOpenId: 'alice', watchChatIds: ['oc_source'], enabled: true })
    expect(t.chats).toHaveBeenCalledWith({ userToken: t.userTokens.get('alice')!.accessToken }, expect.objectContaining({ fresh: true }))
    expect(t.cards()).toHaveLength(0)
  })

  it('preserves app-identity watches inside the same group without borrowing any personal connection', async () => {
    const t = await setup(), group = t.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'alice' })
    t.userTokens.disconnect('alice')
    const access = vi.spyOn(t.userTokens, 'accessTokenResult')
    const patch = { chatId: 'oc_group', chatType: 'group' as const, spaceId: group.id }
    const r = await t.post('routine/add', { ...WATCH, chats: ['oc_group'] }, patch)
    expect(r.status).toBe(200)
    expect(t.routines.get(r.body.routine.id)).toMatchObject({ chatType: 'group', watchChatIds: ['oc_group'], deliverTo: 'chat' })
    expect((await t.post('routine/add', WATCH, patch)).status).toBe(403)
    expect(access).not.toHaveBeenCalled(); expect(t.chats).not.toHaveBeenCalled(); expect(t.cards()).toHaveLength(0)
  })

  it.each(['archive', 'leave', 'stop'] as const)('rechecks group space and actor after the app-name await: %s', async change => {
    const t = await setup(), group = t.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'alice' })
    vi.spyOn(t.fake, 'chatName').mockImplementationOnce(async () => {
      if (change === 'archive') t.spaces.archive(group.id)
      else if (change === 'leave') t.spaces.removeMember(group.id, 'alice')
      else t.stop()
      return '测试群'
    })
    expect((await t.post('routine/add', { ...WATCH, chats: ['oc_group'] }, { chatId: 'oc_group', chatType: 'group', spaceId: group.id })).status).toBe(403)
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM routines').get()).toEqual({ n: 0 })
  })

  it.each(['stop', 'changeRun', 'changeControl', 'disconnect', 'replaceGrant', 'archive'] as const)
    ('rejects a calendar result after %s without content or source receipts', async change => {
      const t = await setup(['calendar'])
      t.calendar.mockImplementationOnce(async () => {
        if (change === 'disconnect') t.userTokens.disconnect('alice')
        else if (change === 'replaceGrant') await t.connect()
        else if (change === 'archive') t.spaces.archive(t.dm.id)
        else t[change]()
        return [{ eventId: 'synthetic', summary: 'PRIVATE_EVENT', startMs: 1, endMs: 2, allDay: false }]
      })
      const r = await t.post('calendar/events')
      expect(r.status).toBe(403); expect(JSON.stringify(r.body)).not.toContain('PRIVATE_EVENT'); expect(t.onSource).not.toHaveBeenCalled()
    })

  it.each(['stop', 'disconnect', 'archive', 'stopReading'] as const)('does not persist a watch after %s while awaiting the directory', async change => {
    const t = await setup(['watch'])
    t.chats.mockImplementationOnce(async () => {
      if (change === 'disconnect') t.userTokens.disconnect('alice')
      else if (change === 'archive') t.spaces.archive(t.dm.id)
      else if (change === 'stopReading') t.readScope.exclude('alice', 'oc_source')
      else t.stop()
      return { items: [{ chatId: 'oc_source', name: '测试群' }], complete: true }
    })
    expect((await t.post('routine/add', WATCH)).status).toBe(403)
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM routines').get()).toEqual({ n: 0 })
  })

  it('transient authorization failure is not a missing grant and does not issue a card', async () => {
    const t = await setup(); vi.spyOn(t.userTokens, 'accessTokenResult').mockResolvedValue({ status: 'unavailable', reason: 'refresh_failed' })
    expect((await t.post('calendar/events')).status).toBe(503)
    expect((await t.post('routine/add', WATCH)).status).toBe(503)
    expect(t.cards()).toHaveLength(0)
  })

  it('core-only reauthorization leaves a suspended watch paused; granting watch resumes it', async () => {
    const t = await setup()
    const r = t.routines.add({ kind: 'watch', ownerOpenId: 'alice', runAs: 'alice', spaceId: t.dm.id, chatId: 'oc_dm', chatType: 'p2p',
      name: WATCH.name, prompt: WATCH.prompt, schedule: { type: 'interval', everyMinutes: 60 }, watchChatIds: ['oc_source'] })
    t.routines.suspendForExpiredAuth('alice')
    expect(await t.host.resumeAuthorizedRoutines('alice')).toMatchObject({ connected: true, resumed: 0, stillPaused: 1 })
    expect(t.routines.get(r.id)).toMatchObject({ enabled: false, disabledReason: AUTH_EXPIRED })
    await t.connect([...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.watch].join(' '))
    expect(await t.host.resumeAuthorizedRoutines('alice')).toMatchObject({ connected: true, resumed: 1, stillPaused: 0 })
  })
})

describe('scope lease guards actual SDK boundaries', () => {
  it('does not fetch calendar event details after revocation during primary calendar lookup', async () => {
    let current = true
    const primary = vi.fn(async () => { current = false; return { code: 0, data: { calendars: [{ calendar: { calendar_id: 'cal' } }] } } })
    const instanceView = vi.fn()
    const client = Object.assign(Object.create(FeishuClient.prototype) as FeishuClient, { client: { calendar: { v4: { calendar: { primary }, calendarEvent: { instanceView } } } } })
    await expect(client.listMyEvents({ userToken: 'synthetic' }, { startSec: 1, endSec: 2 }, () => { if (!current) throw new Error('revoked') })).rejects.toThrow('revoked')
    expect(instanceView).not.toHaveBeenCalled()
  })

  it('does not fetch another directory page after revocation', async () => {
    let current = true
    const list = vi.fn(async () => { current = false; return { code: 0, data: { items: [{ chat_id: 'oc_a', name: 'A' }], has_more: true, page_token: 'next' } } })
    const client = Object.assign(Object.create(FeishuClient.prototype) as FeishuClient, { client: { im: { v1: { chat: { list } } } }, chatListCache: new Map() })
    await expect(client.listChatsResult({ userToken: 'synthetic' }, { fresh: true, assertCurrent: () => { if (!current) throw new Error('revoked') } })).rejects.toThrow('revoked')
    expect(list).toHaveBeenCalledOnce()
  })
})
