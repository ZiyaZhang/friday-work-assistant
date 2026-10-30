import { AxiosError } from 'axios'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserMessageReadAccess, UserMessageReadChanged } from '../src/core/user-message-read-lease.js'
import { UserTokenStore, type TokenExchange } from '../src/feishu/oauth.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { createLogger } from '../src/log.js'
import { historyMsg } from './helpers/fake-feishu.js'

const dbs: DatabaseSync[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
async function setup() {
  const db = new DatabaseSync(':memory:'); dbs.push(db)
  const grant: TokenExchange = { accessToken: 'SYNTHETIC_ORIGINAL', expiresIn: 7200,
    scope: 'im:message:readonly im:message.group_msg:get_as_user im:chat:readonly' }
  const provider = { exchangeCode: vi.fn(async () => grant), refresh: vi.fn(async () => grant) }
  const tokens = new UserTokenStore(db, provider, () => 1_000_000)
  const connect = () => tokens.complete({ code: 'synthetic', openId: 'ou_owner', redirectUri: 'https://callback.invalid' })
  await connect()
  const groups = [{ chatId: 'oc_a', name: 'A' }, { chatId: 'oc_b', name: 'B' }]
  const feishu = { whoAmI: vi.fn(async () => ({ openId: 'ou_owner', tenantKey: 'tenant_authority' })),
    listChatsResult: vi.fn(async () => ({ items: groups, complete: true })),
    listChats: vi.fn(async () => groups), chatMemberOpenIds: vi.fn(async () => new Set<string>()),
    listChatHistory: vi.fn(async (chatId: string, _start: number, _end: number, _limit: number, _window: number, _as: unknown) => ({
      items: [historyMsg({ messageId: `om_${chatId}`, chatId, tenantId: 'tenant_sender', text: chatId, createTimeMs: 150_000 })], hasMore: false,
    })),
  }
  let active = true
  const assertCurrent = () => { if (!active) throw new Error('synthetic stopped') }
  const access = new UserMessageReadAccess({ appId: 'app_synthetic', userTokens: tokens, feishu })
  const cache = new MessageCache(db), messages = new MessageService(feishu, cache, createLogger('lease-test', 'error'))
  return { db, grant, provider, tokens, connect, groups, feishu, access, cache, messages, assertCurrent,
    stop: () => { active = false }, open: () => access.open('ou_owner', assertCurrent) }
}

describe('one host user-message read lease', () => {
  it('uses one identity/group verification and the original token for a multi-group read', async () => {
    const t = await setup(), result = await t.open()
    if (result.status !== 'available') throw new Error('expected available')
    const { lease } = result
    expect(lease.authority).toEqual({ appId: 'app_synthetic', tenantId: 'tenant_authority', openId: 'ou_owner' })
    if (lease.capture.status !== 'ready') throw new Error('expected group proof')
    const page = await t.messages.search({ chatIds: lease.capture.groups.map(group => group.chatId), startSec: 100, endSec: 200 }, lease.as, lease.assertCurrent)
    expect(page.items.map(message => message.messageId)).toEqual(['om_oc_a', 'om_oc_b'])
    expect(t.feishu.whoAmI).toHaveBeenCalledExactlyOnceWith('SYNTHETIC_ORIGINAL')
    expect(t.feishu.listChatsResult).toHaveBeenCalledExactlyOnceWith({ userToken: 'SYNTHETIC_ORIGINAL' }, { fresh: true, assertCurrent: expect.any(Function) })
    expect(t.feishu.listChatHistory.mock.calls.map(call => call[5])).toEqual([lease.as, lease.as])
    expect(t.feishu.chatMemberOpenIds).not.toHaveBeenCalled()
    // The lease does not rewrite sender tenant or claim the cache stores an API authority.
    expect(page.items.every(message => message.tenantId === undefined)).toBe(true)
    expect(lease.authority.tenantId).toBe('tenant_authority')
  })

  it('keeps partial group listings explicit and copies SDK arrays instead of accepting late mutation', async () => {
    const t = await setup()
    t.feishu.listChatsResult.mockResolvedValue({ items: t.groups, complete: false })
    const result = await t.open()
    if (result.status !== 'available') throw new Error('expected available')
    if (result.lease.capture.status !== 'ready') throw new Error('expected group proof')
    expect(result.lease.capture.groupsComplete).toBe(false)
    t.groups.push({ chatId: 'oc_late', name: 'late' })
    expect(result.lease.capture.groups.map(group => group.chatId)).toEqual(['oc_a', 'oc_b'])
  })

  it('does not reacquire a new token to repair a previously issued lease', async () => {
    const t = await setup(), result = await t.open()
    if (result.status !== 'available') throw new Error('expected available')
    t.provider.exchangeCode.mockResolvedValue({ ...t.grant, accessToken: 'SYNTHETIC_REPLACEMENT' })
    await t.connect()
    expect(() => result.lease.assertCurrent()).toThrow(UserMessageReadChanged)
    expect(result.lease.as.userToken).toBe('SYNTHETIC_ORIGINAL')
    expect(t.provider.exchangeCode).toHaveBeenCalledTimes(2)
    expect(t.feishu.whoAmI).toHaveBeenCalledTimes(1)
  })

  it('checks expected authorization tenant before listing any groups', async () => {
    const t = await setup()
    expect(await t.access.open('ou_owner', t.assertCurrent, 'different_authority'))
      .toMatchObject({ status: 'denied', reason: 'identity_mismatch' })
    expect(t.feishu.listChatsResult).not.toHaveBeenCalled()
  })

  it.each([
    { scope: '', status: 'unavailable', reason: 'scope_unknown' },
    { scope: 'im:message:readonly', status: 'denied', reason: 'scope_missing' },
  ] as const)('preserves ordinary user reads when group capture is $reason', async ({ scope, status, reason }) => {
    const t = await setup()
    t.db.prepare('UPDATE user_tokens SET scope=?').run(scope)
    const result = await t.open()
    if (result.status !== 'available') throw new Error('expected user identity')
    expect(result.lease.capture).toEqual({ status, reason })
    const page = await t.messages.history('oc_a', 100, 200, 20, result.lease.as, result.lease.assertCurrent)
    expect(page.items.map(message => message.messageId)).toEqual(['om_oc_a'])
    expect(t.feishu.listChatHistory.mock.calls[0]![5]).toEqual({ userToken: 'SYNTHETIC_ORIGINAL' })
    expect(t.feishu.whoAmI).toHaveBeenCalledTimes(1)
    expect(t.feishu.listChatsResult).not.toHaveBeenCalled()
  })

  it('keeps list failure explicit without suppressing a direct user read or returning a fake empty list', async () => {
    const t = await setup()
    t.feishu.listChatsResult.mockRejectedValue(new AxiosError('SYNTHETIC_PRIVATE_ERROR', 'ECONNRESET'))
    const result = await t.open()
    if (result.status !== 'available') throw new Error('expected user identity')
    expect(result.lease.capture).toEqual({ status: 'unavailable', reason: 'chat_list_unavailable',
      failure: { reason: 'service_unavailable', next: 'retry', identity: 'user' } })
    expect('groups' in result.lease.capture).toBe(false)
    const page = await t.messages.history('oc_a', 100, 200, 20, result.lease.as, result.lease.assertCurrent)
    expect(page.items).toHaveLength(1)
    expect(t.feishu.listChatsResult).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result.lease.capture)).not.toContain('SYNTHETIC_PRIVATE_ERROR')
  })

  it('does not expose a user lease on identity mismatch even when group scope is unknown', async () => {
    const t = await setup()
    t.db.prepare('UPDATE user_tokens SET scope=?').run('')
    t.feishu.whoAmI.mockResolvedValue({ openId: 'ou_other', tenantKey: 'tenant_authority' })
    const result = await t.open()
    expect(result).toMatchObject({ status: 'denied', reason: 'identity_mismatch' })
    expect('lease' in result).toBe(false)
    expect(t.feishu.listChatsResult).not.toHaveBeenCalled()
  })

  it('does not fall back to application identity when an existing user token is unavailable', async () => {
    const t = await setup()
    t.db.prepare('UPDATE user_tokens SET expires_at=?').run(0)
    const result = await t.open()
    expect(result).toMatchObject({ status: 'unavailable', reason: 'token_unavailable' })
    expect('lease' in result).toBe(false)
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
    expect(t.feishu.listChatsResult).not.toHaveBeenCalled()
    expect(t.feishu.listChats).not.toHaveBeenCalled()
  })

  it('keeps unknown group scope separate from user identity and never invents application fallback', async () => {
    const t = await setup()
    t.tokens.disconnect('ou_owner')
    expect(await t.open()).toMatchObject({ status: 'denied', reason: 'not_connected' })
    t.provider.exchangeCode.mockResolvedValue({ accessToken: 'SYNTHETIC_NO_SCOPE' })
    await t.connect()
    expect(await t.open()).toMatchObject({ status: 'available', lease: { as: { userToken: 'SYNTHETIC_NO_SCOPE' },
      capture: { status: 'unavailable', reason: 'scope_unknown' } } })
    expect(t.feishu.whoAmI).toHaveBeenCalledExactlyOnceWith('SYNTHETIC_NO_SCOPE')
    expect(t.feishu.listChatsResult).not.toHaveBeenCalled()
  })

  it('rejects late identity results for a replaced connection before making a group request', async () => {
    const t = await setup(), entered = deferred(), release = deferred()
    t.feishu.whoAmI.mockImplementation(async () => { entered.resolve(); await release.promise; return { openId: 'ou_owner', tenantKey: 'tenant_authority' } })
    const request = t.open()
    await entered.promise
    t.provider.exchangeCode.mockResolvedValue({ ...t.grant, accessToken: 'SYNTHETIC_REPLACEMENT' })
    await t.connect(); release.resolve()
    await expect(request).rejects.toBeInstanceOf(UserMessageReadChanged)
    expect(t.feishu.listChatsResult).not.toHaveBeenCalled()
  })

  it.each(['disconnect', 'stop', 'reconnect', 'scope-change'] as const)('prevents cache/coverage writes after a history await crosses %s', async change => {
    const t = await setup(), result = await t.open(), entered = deferred(), release = deferred()
    if (result.status !== 'available') throw new Error('expected available')
    t.feishu.listChatHistory.mockImplementation(async () => {
      entered.resolve(); await release.promise
      return { items: [historyMsg({ messageId: 'om_late', text: 'late', createTimeMs: 150_000 })], hasMore: false }
    })
    const request = t.messages.history('oc_a', 100, 200, 20, result.lease.as, result.lease.assertCurrent)
    await entered.promise
    if (change === 'disconnect') t.tokens.disconnect('ou_owner')
    else if (change === 'stop') t.stop()
    else if (change === 'scope-change') t.db.prepare('UPDATE user_tokens SET scope=?').run('im:chat:readonly')
    else {
      t.provider.exchangeCode.mockResolvedValue({ ...t.grant, accessToken: 'SYNTHETIC_REPLACEMENT' })
      await t.connect()
    }
    release.resolve()
    await expect(request).rejects.toThrow(change === 'stop' ? 'synthetic stopped' : '来源授权或空间已变化')
    expect(t.cache.count()).toBe(0)
    expect(t.cache.coverage('oc_a')).toEqual([])
  })

  it('rejects a stopped cache-only read without dropping existing data or calling the platform', async () => {
    const t = await setup(), result = await t.open()
    if (result.status !== 'available') throw new Error('expected available')
    t.cache.upsert('oc_a', [historyMsg({ messageId: 'om_old', text: 'cached', createTimeMs: 150_000 })])
    t.cache.markCovered('oc_a', 100, 200)
    t.stop()
    await expect(t.messages.history('oc_a', 100, 200, 20, result.lease.as, result.lease.assertCurrent)).rejects.toThrow('synthetic stopped')
    expect(t.cache.get('om_old')?.text).toBe('cached')
    expect(t.cache.coverage('oc_a')).toEqual([{ startSec: 100, endSec: 200 }])
    expect(t.feishu.listChatHistory).not.toHaveBeenCalled()
  })
})
