import { afterEach, describe, expect, it, vi } from 'vitest'
import { AxiosError } from 'axios'
import type { AddressInfo } from 'node:net'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { UserTokenStore, USER_SCOPE_TIERS } from '../src/feishu/oauth.js'
import { FeishuApiError } from '../src/feishu/client.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0)) await close() })
async function fixture(connected = true) {
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db)
  const todos = new Todos(registry.db), sp = spaceDeps(registry.db)
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'alice' })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'alice' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('read-access', 'error')
  const tokens = new TokenIssuer('synthetic-capability-key')
  const refresh = vi.fn(async () => ({ accessToken: 'SYNTHETIC_REFRESHED', expiresIn: 7200, refreshToken: 'SYNTHETIC_REFRESH', refreshTokenExpiresIn: 86400, scope: USER_SCOPE_TIERS.core.join(' ') }))
  const userTokens = new UserTokenStore(registry.db, { exchangeCode: async () => ({ accessToken: 'SYNTHETIC_USER', expiresIn: 7200,
    refreshToken: 'SYNTHETIC_REFRESH', refreshTokenExpiresIn: 86400, scope: USER_SCOPE_TIERS.core.join(' ') }), refresh })
  if (connected) await userTokens.complete({ openId: 'alice', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  const order: string[] = [], onAccessBlocked = vi.fn<NonNullable<InternalApiDeps['onAccessBlocked']>>(async () => { order.push('wait') })
  const offerConnect = vi.fn(async () => { order.push('card'); return 'already delivered synthetic card' })
  const onSource = vi.fn(), disconnect = vi.fn((openId: string) => userTokens.disconnect(openId))
  const readDoc = vi.spyOn(fake, 'readDocument').mockResolvedValue({ content: 'SYNTHETIC_DOCUMENT', title: 'Doc', objType: 'docx' })
  const whoAmI = vi.spyOn(fake, 'whoAmI').mockResolvedValue({ openId: 'alice', tenantKey: 'synthetic-tenant' })
  let active = true
  const api = createInternalApi({ registry, memory, messageCache: cache, messages: new MessageService(feishu, cache, log), todos,
    ...sp, feishu, tokens, log, appId: 'synthetic-app', maxHistoryPerCall: 20, userTokens, onExternalSourceRead: onSource,
    disconnectPersonalConnection: disconnect, onAccessBlocked, abilities: { offerConnect } as InternalApiDeps['abilities'],
    resolveActorForSession: () => active ? { requesterOpenId: 'alice', runId: 'run-original', stage: 'task', controlRevision: 0 } : undefined })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  closes.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())); registry.close() })
  const cap = { sessionKey: 'session-original', runId: 'run-original', spaceId: dm.id, chatId: dm.chatId!, chatType: 'p2p' as const,
    requesterOpenId: 'alice', scopes: ['doc:read', 'calendar:read', 'chats:list', 'chat:read', 'chat:read-others'] }
  const post = async (path = 'doc', body: Record<string, unknown> = { url: 'https://example.feishu.cn/docx/doc_a' }, patch: Partial<Omit<Capability, 'exp'>> = {}) => {
    const response = await fetch(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${tokens.issue({ ...cap, ...patch })}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  return { post, order, refresh, onAccessBlocked, offerConnect, onSource, disconnect, readDoc, whoAmI, userTokens, group,
    stop: () => { active = false } }
}

describe('real API read failure and authorization recovery contract', () => {
  it('persists the exact original Run wait before asking for missing personal calendar scope', async () => {
    const t = await fixture()
    const result = await t.post('calendar/events', {})
    expect(result).toMatchObject({ status: 403, body: { failure: { reason: 'personal_scope_missing', next: 'grant_scope', scopes: USER_SCOPE_TIERS.calendar } } })
    expect(t.order).toEqual(['wait', 'card'])
    expect(t.onAccessBlocked).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: 'session-original', runId: 'run-original', requesterOpenId: 'alice' }),
      expect.objectContaining({ reason: 'personal_scope_missing' }), expect.any(String))
    expect(t.onSource).not.toHaveBeenCalled()
  })
  it.each([[99991672, 'app_scope_missing'], [99991663, 'access_rejected']] as const)
    ('does not turn provider code %s into another personal authorization loop', async (code, reason) => {
      const t = await fixture(); t.readDoc.mockRejectedValue(new FeishuApiError('doc.read', code, 'PRIVATE_PROVIDER'))
      const result = await t.post()
      expect(result).toMatchObject({ status: 403, body: { failure: { reason } } })
      expect(t.readDoc).toHaveBeenCalledTimes(1)
      expect(t.offerConnect).not.toHaveBeenCalled(); expect(t.onAccessBlocked).not.toHaveBeenCalled()
      expect(t.onSource).not.toHaveBeenCalled(); expect(t.userTokens.get('alice')).toBeDefined()
      expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER')
    })
  it('a user-document I/O failure never retries the read using application identity', async () => {
    const t = await fixture(); t.readDoc.mockRejectedValue(new AxiosError('PRIVATE_URL_TOKEN', 'ECONNRESET'))
    const result = await t.post()
    expect(result).toMatchObject({ status: 503, body: { failure: { reason: 'service_unavailable', next: 'retry' } } })
    expect(t.readDoc).toHaveBeenCalledTimes(1)
    expect(t.readDoc).toHaveBeenCalledWith(expect.any(Object), { userToken: 'SYNTHETIC_USER' })
    expect(t.offerConnect).not.toHaveBeenCalled(); expect(t.disconnect).not.toHaveBeenCalled(); expect(t.onSource).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('PRIVATE_URL_TOKEN')
  })
  it('an unavailable stored grant does not fall back to application reading', async () => {
    const t = await fixture()
    vi.spyOn(t.userTokens, 'accessTokenResult').mockResolvedValue({ status: 'unavailable', reason: 'refresh_failed' })
    expect(await t.post()).toMatchObject({ status: 503, body: { failure: { reason: 'service_unavailable' } } })
    expect(t.readDoc).not.toHaveBeenCalled(); expect(t.offerConnect).not.toHaveBeenCalled()
  })
  it('a confirmed invalid grant records recovery and never calls the document provider', async () => {
    const t = await fixture()
    vi.spyOn(t.userTokens, 'accessTokenResult').mockResolvedValue({ status: 'denied', reason: 'invalid_grant' })
    expect(await t.post()).toMatchObject({ status: 403, body: { failure: { reason: 'grant_invalid' } } })
    expect(t.disconnect).toHaveBeenCalledOnce(); expect(t.order).toEqual(['wait', 'card'])
    expect(t.readDoc).not.toHaveBeenCalled()
  })
  it('a structured personal-scope rejection uses the same host wait hook', async () => {
    const t = await fixture(); t.readDoc.mockRejectedValue(new FeishuApiError('doc.read', 99991679, 'PRIVATE'))
    expect(await t.post()).toMatchObject({ status: 403, body: { failure: { reason: 'personal_scope_missing' } } })
    expect(t.order).toEqual(['wait', 'card']); expect(t.readDoc).toHaveBeenCalledTimes(1)
    expect(t.offerConnect).toHaveBeenCalledWith(expect.any(Object), undefined, expect.objectContaining({ reason: 'personal_scope_missing' }))
  })
  it('expires only the rejected access token and refreshes the same grant on the next read', async () => {
    const t = await fixture(), grant = t.userTokens.get('alice')!
    t.readDoc.mockRejectedValueOnce(new FeishuApiError('doc.read', 99991677, 'PRIVATE'))
    expect(await t.post()).toMatchObject({ status: 503, body: { failure: { reason: 'access_token_expired', next: 'retry' } } })
    expect(t.userTokens.get('alice')).toMatchObject({ refreshToken: grant.refreshToken })
    expect(t.userTokens.get('alice')!.expiresAt).toBeLessThanOrEqual(Date.now())
    expect(t.offerConnect).not.toHaveBeenCalled(); expect(t.disconnect).not.toHaveBeenCalled()
    expect(await t.post()).toMatchObject({ status: 200, body: { content: 'SYNTHETIC_DOCUMENT' } })
    expect(t.refresh).toHaveBeenCalledOnce()
    expect(t.readDoc).toHaveBeenLastCalledWith(expect.any(Object), { userToken: 'SYNTHETIC_REFRESHED' })
  })
  it('an old expired response cannot expire a concurrently replaced personal grant', async () => {
    const t = await fixture()
    t.readDoc.mockImplementationOnce(async () => {
      await t.userTokens.complete({ openId: 'alice', code: 'new-grant', redirectUri: 'https://callback.invalid' })
      throw new FeishuApiError('doc.read', 99991677, 'PRIVATE')
    })
    expect((await t.post()).status).toBe(403)
    expect(t.userTokens.get('alice')!.expiresAt).toBeGreaterThan(Date.now())
    expect(t.offerConnect).not.toHaveBeenCalled(); expect(t.refresh).not.toHaveBeenCalled()
  })
  it('identity lookup preserves app scope denial instead of calling it a disconnection', async () => {
    const t = await fixture(); t.whoAmI.mockRejectedValue(new FeishuApiError('userInfo', 99991672, 'PRIVATE'))
    expect(await t.post('chats', {})).toMatchObject({ status: 403, body: { failure: { reason: 'app_scope_missing' } } })
    expect(t.offerConnect).not.toHaveBeenCalled(); expect(t.disconnect).not.toHaveBeenCalled()
  })
  it('a successful document response keeps its true user source and no credentials', async () => {
    const t = await fixture(), result = await t.post()
    expect(result).toMatchObject({ status: 200, body: { content: 'SYNTHETIC_DOCUMENT', identity: 'user' } })
    expect(t.onSource).toHaveBeenCalledWith('session-original', expect.objectContaining({ personalOpenId: 'alice', access: 'user' }))
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_USER')
  })
  it('group documents retain application identity even with a stored personal grant', async () => {
    const t = await fixture()
    expect(await t.post('doc', { url: 'https://example.feishu.cn/docx/doc_a' }, { chatType: 'group', chatId: t.group.chatId!, spaceId: t.group.id }))
      .toMatchObject({ status: 200, body: { identity: 'bot' } })
    expect(t.readDoc).toHaveBeenCalledWith(expect.any(Object), {})
  })
  it('a stop during a denied read does not create a new waiting task or card', async () => {
    const t = await fixture()
    t.readDoc.mockImplementation(async () => { t.stop(); throw new FeishuApiError('doc.read', 99991679, 'PRIVATE') })
    expect((await t.post()).status).toBe(403)
    expect(t.onAccessBlocked).not.toHaveBeenCalled(); expect(t.offerConnect).not.toHaveBeenCalled(); expect(t.onSource).not.toHaveBeenCalled()
  })
  it('a stop during persisted wait creation prevents a late authorization card', async () => {
    const t = await fixture(); t.onAccessBlocked.mockImplementation(async () => { t.stop() })
    expect((await t.post('calendar/events', {})).status).toBe(403)
    expect(t.offerConnect).not.toHaveBeenCalled()
  })
})
