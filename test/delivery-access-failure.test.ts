import { afterEach, describe, expect, it, vi } from 'vitest'
import { AxiosError } from 'axios'
import { Registry } from '../src/core/registry.js'
import { SourceContexts } from '../src/core/source-context.js'
import { DeliveryContextResolver } from '../src/core/delivery-context.js'
import { DeliveryError, DeliveryService } from '../src/core/delivery.js'
import { accessFailureText } from '../src/core/access-failure.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { FeishuApiError } from '../src/feishu/client.js'
import { spaceDeps } from './helpers/space.js'

const opened: Registry[] = []
afterEach(() => { opened.splice(0).forEach(registry => registry.close()) })
async function fixture(kind: 'document' | 'chat' | 'group' = 'document') {
  const registry = new Registry(':memory:'); opened.push(registry)
  const { spaces, policy } = spaceDeps(registry.db)
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'dm-chat', openId: 'alice' })
  const group = spaces.ensure({ kind: 'group', chatId: 'group-chat', openId: 'alice' })
  const target = kind === 'group' ? group : dm
  const binding = { sessionKey: 'session', acpSessionId: 'acp', spaceId: target.id, chatId: target.chatId! }
  const sources = new SourceContexts(registry); sources.initialize(binding, [])
  if (kind === 'document') sources.addExternal(binding.sessionKey, { kind: 'document', ref: 'private-doc', access: 'user', personalOpenId: 'alice' })
  if (kind === 'chat') sources.addChat(binding.sessionKey, { chatId: group.chatId!, spaceId: group.id })
  const tokens = new UserTokenStore(registry.db, {
    exchangeCode: async () => ({ accessToken: 'SYNTHETIC', expiresIn: 7200, scope: 'im:chat:readonly' }),
    refresh: async () => { throw new Error('unexpected') },
  })
  const connect = () => tokens.complete({ code: 'synthetic', openId: 'alice', redirectUri: 'https://invalid.test' })
  const feishu = {
    listChats: vi.fn(async () => [{ chatId: group.chatId!, name: 'synthetic' }]),
    listChatsResult: vi.fn(async () => ({ items: [{ chatId: group.chatId!, name: 'synthetic' }], complete: true })),
    chatMemberOpenIds: vi.fn(async () => new Set(['alice'])),
  }
  const disconnect = vi.fn(() => false), state = { live: true }
  const resolver = new DeliveryContextResolver({ sources, spaces, feishu, userTokens: tokens, disconnectPersonalConnection: disconnect, now: () => Date.now() })
  const execution = { ...binding, actorOpenId: 'alice', chatType: target.kind, isLive: () => state.live, isCurrent: () => state.live, readScopes: () => [] }
  const options = { audience: kind === 'group' ? { kind: 'group' as const, spaceId: group.id, chatId: group.chatId! }
    : { kind: 'dm' as const, spaceId: dm.id, openId: 'alice' }, prepareMentions: kind === 'group' }
  const resolve = () => resolver.resolveResult(execution, options)
  const send = vi.fn(async () => ({ remoteId: 'synthetic' }))
  const delivery = new DeliveryService(registry.db, { spaces, policy, send, resolveContext: async () => {
    const result = await resolve()
    if (result.status === 'blocked') throw new DeliveryError('denied', accessFailureText(result.failure), result.failure)
    return result.context
  } })
  return { registry, resolver, sources, tokens, connect, feishu, disconnect, state, execution, options, resolve, send, delivery }
}

describe('delivery retains the actionable access cause', () => {
  it('missing connection differs from a token refresh network failure', async () => {
    const t = await fixture()
    expect(await t.resolve()).toMatchObject({ status: 'blocked', failure: { reason: 'not_connected', next: 'connect' } })
    expect(await t.resolver.resolve(t.execution, t.options)).toBeUndefined()
    await t.connect()
    vi.spyOn(t.tokens, 'accessTokenResult').mockResolvedValue({ status: 'unavailable', reason: 'refresh_failed' })
    expect(await t.resolve()).toMatchObject({ failure: { reason: 'service_unavailable', next: 'retry' } })
    expect(t.disconnect).not.toHaveBeenCalled()
  })
  it('a late denial never classifies or disconnects a replacement connection', async () => {
    const t = await fixture()
    vi.spyOn(t.tokens, 'accessTokenResult').mockImplementation(async () => {
      await t.connect()
      return { status: 'denied', reason: 'invalid_grant' }
    })
    expect(await t.resolve()).toMatchObject({ failure: { reason: 'connection_changed', next: 'restart' } })
    expect(t.disconnect).not.toHaveBeenCalled()
    expect(t.tokens.get('alice')).toBeDefined()
  })
  it('confirmed grant rejection withdraws only the captured grant and carries reconnect', async () => {
    const t = await fixture(); const prior = await t.connect()
    vi.spyOn(t.tokens, 'accessTokenResult').mockResolvedValue({ status: 'denied', reason: 'invalid_grant' })
    expect(await t.resolve()).toMatchObject({ failure: { reason: 'grant_invalid', next: 'connect' } })
    expect(t.disconnect).toHaveBeenCalledWith('alice', prior)
  })
  it.each([true, false])('a group listing with complete=%s cannot prove a missing message source forbidden', async complete => {
    const t = await fixture('chat'); await t.connect()
    t.feishu.listChatsResult.mockResolvedValue({ items: [], complete })
    // No exact message receipt is available here. A directory's coverage is not
    // proof that all conversation/message types have been checked.
    expect(await t.resolve()).toMatchObject({ status: 'blocked', failure: { reason: 'resource_unverified', next: 'retry' } })
    expect(t.disconnect).not.toHaveBeenCalled()
  })
  it('positive entries in a partial listing still prove the specific required resource', async () => {
    const t = await fixture('chat'); await t.connect()
    t.feishu.listChatsResult.mockResolvedValue({ items: [{ chatId: 'group-chat', name: 'synthetic' }], complete: false })
    expect(await t.resolve()).toMatchObject({ status: 'ready' })
  })
  it.each([['app', 99991672, 'app_scope_missing'], ['user', 99991679, 'personal_scope_missing']] as const)
    ('keeps %s scope denial separate', async (_label, code, reason) => {
      const t = await fixture('chat'); await t.connect()
      t.feishu.listChatsResult.mockRejectedValue(new FeishuApiError('chat.list', code, 'SECRET'))
      const result = await t.resolve()
      expect(result).toMatchObject({ failure: { reason } })
      expect(JSON.stringify(result)).not.toContain('SECRET')
      expect(t.disconnect).not.toHaveBeenCalled()
    })
  it('actual network failure never deletes the grant or invites authorization', async () => {
    const t = await fixture('chat'); await t.connect()
    t.feishu.listChatsResult.mockRejectedValue(new AxiosError('SECRET', 'ECONNRESET'))
    expect(await t.resolve()).toMatchObject({ failure: { reason: 'service_unavailable', next: 'retry' } })
    expect(t.disconnect).not.toHaveBeenCalled()
  })
  it('a host stop during failed I/O takes precedence over the network error', async () => {
    const t = await fixture('chat'); await t.connect()
    t.feishu.listChatsResult.mockImplementation(async () => { t.state.live = false; throw new AxiosError('SECRET', 'ECONNRESET') })
    expect(await t.resolve()).toMatchObject({ failure: { reason: 'context_changed', next: 'none' } })
  })
  it('a grant replaced while fetching membership is connection_changed', async () => {
    const t = await fixture('chat'); await t.connect()
    t.feishu.listChatsResult.mockImplementation(async () => { t.tokens.disconnect('alice'); return { items: [], complete: true } })
    expect(await t.resolve()).toMatchObject({ failure: { reason: 'connection_changed', next: 'restart' } })
  })
  it('programming errors are not recast as network outages', async () => {
    const t = await fixture('chat'); await t.connect()
    const error = new TypeError('bug')
    t.feishu.listChatsResult.mockRejectedValue(error)
    await expect(t.resolve()).rejects.toBe(error)
  })
  it('group membership lookup failure is not swallowed into a send without mentions', async () => {
    const t = await fixture('group')
    t.feishu.chatMemberOpenIds.mockRejectedValue(new AxiosError('SECRET', 'ECONNRESET'))
    expect(await t.resolve()).toMatchObject({ failure: { reason: 'service_unavailable', identity: 'app' } })
  })
  it('typed denial reaches delivery without sending or adding a planned receipt', async () => {
    const t = await fixture()
    await expect(t.delivery.deliver({ key: 'original-effect', contextRef: 'run', payload: { text: 'synthetic' } }))
      .rejects.toMatchObject({ code: 'denied', failure: { reason: 'not_connected' } })
    expect(t.send).not.toHaveBeenCalled()
    expect(t.delivery.get('original-effect')).toBeUndefined()
  })
  it('unknown web source cannot be repaired by requesting personal OAuth', async () => {
    const t = await fixture('group')
    t.sources.addExternal('session', { kind: 'web', ref: 'https://example.com/?secret=synthetic', access: 'public' })
    const tokenCall = vi.spyOn(t.tokens, 'accessTokenResult')
    expect(await t.resolve()).toMatchObject({ failure: { reason: 'source_unverifiable', next: 'review_source' } })
    expect(tokenCall).not.toHaveBeenCalled()
  })
})
