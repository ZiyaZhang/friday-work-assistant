import { AxiosError } from 'axios'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PersonalMemoryAccess, PersonalMemoryAccessChanged } from '../src/core/personal-memory-access.js'
import { PolicyService, type PolicyOptions } from '../src/core/policy.js'
import { Spaces } from '../src/core/space.js'
import type { MemorySourceReference } from '../src/core/memory-provenance.js'
import { DEFAULT_USER_SCOPES, userScopesFor, OAuthTokenError, UserTokenStore, type TokenExchange } from '../src/feishu/oauth.js'

const dbs: DatabaseSync[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
const GROUP_SCOPE = 'im:message.group_msg:get_as_user'
const SCOPE = `im:message:readonly ${GROUP_SCOPE} im:chat:readonly`
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

async function setup(scope = SCOPE, policyOptions: PolicyOptions = { admins: [] }) {
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  let now = 1_000_000, active = true
  const spaces = new Spaces(db, () => now), policy = new PolicyService(spaces, policyOptions)
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm_owner', openId: 'ou_owner' })
  const grant: TokenExchange = { accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH',
    expiresIn: 7200, refreshTokenExpiresIn: 86400, scope }
  const provider = { exchangeCode: vi.fn(async () => grant), refresh: vi.fn(async () => ({ ...grant, accessToken: 'SYNTHETIC_ROTATED' })) }
  const tokens = new UserTokenStore(db, provider, () => now)
  const connect = () => tokens.complete({ openId: 'ou_owner', code: 'synthetic-code', redirectUri: 'https://callback.invalid' })
  await connect()
  const identity = { openId: 'ou_owner', tenantKey: 'tenant-synthetic' }
  const chats = { items: [{ chatId: 'oc_group', name: 'PRIVATE_GROUP_NAME' }], complete: true }
  const feishu = { whoAmI: vi.fn(async () => identity), listChatsResult: vi.fn(async () => chats) }
  const access = new PersonalMemoryAccess({ appId: 'app-synthetic', spaces, policy, userTokens: tokens, feishu })
  const actor = { spaceId: dm.id, openId: 'ou_owner' }
  const stopped = new Error('synthetic run stopped')
  const assertCurrent = vi.fn(() => { if (!active) throw stopped })
  const source = (patch: Partial<MemorySourceReference> = {}): MemorySourceReference => ({ ref: 'chat:oc_group:om_original',
    appId: 'app-synthetic', tenantId: 'tenant-synthetic', spaceId: null, chatId: 'oc_group', messageId: 'om_original',
    readIdentity: { kind: 'user', openId: 'ou_owner' }, readAt: now, coverage: 'complete', ...patch })
  const check = (sources = [source()]) => access.check(actor, sources, assertCurrent)
  const snapshot = () => JSON.stringify({ rooms: db.prepare('SELECT * FROM space_rooms ORDER BY id').all(),
    members: db.prepare('SELECT * FROM space_members ORDER BY space_id,open_id').all(),
    tokens: db.prepare('SELECT * FROM user_tokens ORDER BY open_id').all() })
  return { db, spaces, policy, policyOptions, dm, tokens, provider, grant, feishu, identity, chats, access, actor,
    assertCurrent, stopped, source, check, connect, snapshot, stop: () => { active = false }, time: (value: number) => { now = value } }
}

describe('personal group-memory source access', () => {
  it('authorizes a real user source without creating a group Space or disclosing credentials/names', async () => {
    const t = await setup(), before = t.snapshot()
    const result = await t.check()
    expect(result.status).toBe('allowed')
    result.assertCurrent()
    expect(t.feishu.whoAmI).toHaveBeenCalledExactlyOnceWith('SYNTHETIC_ACCESS')
    expect(t.feishu.listChatsResult).toHaveBeenCalledExactlyOnceWith({ userToken: 'SYNTHETIC_ACCESS' }, { fresh: true, assertCurrent: expect.any(Function) })
    expect(t.spaces.byChat('oc_group', true)).toBeUndefined()
    expect(t.snapshot()).toBe(before)
    expect(JSON.stringify(result)).toBe('{"status":"allowed"}')
  })

  it('does not require a Friday local member record for a platform-authorized source group', async () => {
    const t = await setup(), group = t.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_other' })
    expect(t.spaces.roleOf(group.id, 'ou_owner')).toBeUndefined()
    expect((await t.check([t.source({ spaceId: group.id })])).status).toBe('allowed')
  })

  it('keeps the own-DM and owner boundary even under admin/auto policy', async () => {
    const t = await setup(SCOPE, { mode: 'auto', admins: ['ou_owner'] })
    const other = t.spaces.ensure({ kind: 'p2p', chatId: 'oc_other_dm', openId: 'ou_other' })
    t.spaces.addMember(other.id, 'ou_owner', 'owner')
    const wrong = await t.access.check({ ...t.actor, spaceId: other.id }, [t.source()], t.assertCurrent)
    expect(wrong).toMatchObject({ status: 'denied', reason: 'target_forbidden' })
    t.spaces.removeMember(t.dm.id, 'ou_owner')
    expect(await t.check()).toMatchObject({ status: 'denied', reason: 'target_forbidden' })
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'app source', patch: { readIdentity: { kind: 'app' } }, status: 'unavailable', reason: 'unsupported_identity' },
    { label: 'different user', patch: { readIdentity: { kind: 'user', openId: 'ou_other' } }, status: 'denied', reason: 'source_actor_mismatch' },
    { label: 'different app', patch: { appId: 'other-app' }, status: 'denied', reason: 'source_app_mismatch' },
    { label: 'missing tenant', patch: { tenantId: '' }, status: 'unavailable', reason: 'source_incomplete' },
  ] as const)('refuses unsupported source evidence: $label', async ({ patch, status, reason }) => {
    const t = await setup()
    expect(await t.check([t.source(patch)])).toMatchObject({ status, reason })
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
    expect(t.feishu.listChatsResult).not.toHaveBeenCalled()
  })

  it.each(['openId', 'tenantKey'] as const)('denies a concrete whoAmI %s mismatch without returning the platform identity', async field => {
    const t = await setup()
    t.feishu.whoAmI.mockResolvedValue({ ...t.identity, [field]: 'PRIVATE_OTHER_IDENTITY' })
    const result = await t.check()
    expect(result).toMatchObject({ status: 'denied', reason: 'identity_mismatch' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_OTHER_IDENTITY')
    expect(t.feishu.listChatsResult).not.toHaveBeenCalled()
  })

  it.each([
    { scope: `im:message ${GROUP_SCOPE}`, status: 'allowed' },
    { scope: `im:message.history:readonly ${GROUP_SCOPE}`, status: 'denied', reason: 'scope_missing' },
    { scope: 'im:message:readonly im:chat:readonly', status: 'denied', reason: 'scope_missing' },
    { scope: GROUP_SCOPE, status: 'denied', reason: 'scope_missing' },
    { scope: '', status: 'unavailable', reason: 'scope_unknown' },
    { scope: '  ', status: 'unavailable', reason: 'scope_unknown' },
  ])('uses the documented user-message scope rule for "$scope"', async ({ scope, status, reason }) => {
    const t = await setup(scope)
    expect(await t.check()).toMatchObject({ status, ...(reason ? { reason } : {}) })
  })

  it('requests the new group scope for future authorization without upgrading an old stored grant', async () => {
    // 盯群那一项要后台单独开通，没开通却请求会让整个授权页 20027 报错，
    // 所以它在 watch 这一组里、默认不请求；打开 watch 才请求。
    expect(DEFAULT_USER_SCOPES).not.toContain(GROUP_SCOPE)
    expect(userScopesFor(['watch'])).toContain(GROUP_SCOPE)
    const t = await setup('im:message:readonly'), old = t.tokens.get('ou_owner')
    expect(await t.check()).toMatchObject({ status: 'denied', reason: 'scope_missing' })
    expect(t.tokens.get('ou_owner')).toEqual(old)
  })

  it('cannot authorize a replacement code grant using the previous grant scopes', async () => {
    const t = await setup()
    expect((await t.check()).status).toBe('allowed')
    t.provider.exchangeCode.mockResolvedValue({ accessToken: 'SYNTHETIC_NEW_GRANT', expiresIn: 7200 })
    await t.connect()
    t.feishu.whoAmI.mockClear()
    t.feishu.listChatsResult.mockClear()
    expect(await t.check()).toMatchObject({ status: 'unavailable', reason: 'scope_unknown' })
    expect(t.tokens.get('ou_owner')).toMatchObject({ scope: '', refreshToken: null, refreshExpiresAt: null })
    expect(t.feishu.whoAmI).toHaveBeenCalledExactlyOnceWith('SYNTHETIC_NEW_GRANT')
    expect(t.feishu.listChatsResult).not.toHaveBeenCalled()
  })

  it.each([
    { complete: false, present: true, status: 'allowed' },
    { complete: false, present: false, status: 'unavailable', reason: 'chat_list_incomplete' },
    { complete: true, present: false, status: 'denied', reason: 'chat_not_accessible' },
  ])('uses positive entries but only treats complete absence as denial: complete=$complete present=$present', async ({ complete, present, status, reason }) => {
    const t = await setup()
    t.feishu.listChatsResult.mockResolvedValue({ items: present ? t.chats.items : [], complete })
    expect(await t.check()).toMatchObject({ status, ...(reason ? { reason } : {}) })
  })

  it('does not authorize mixed-source content when one of its groups is absent', async () => {
    const t = await setup()
    expect(await t.check([t.source(), t.source({ chatId: 'oc_missing', ref: 'chat:oc_missing' })]))
      .toMatchObject({ status: 'denied', reason: 'chat_not_accessible' })
    expect(t.feishu.listChatsResult).toHaveBeenCalledTimes(1)
  })

  it.each(['whoAmI', 'listChatsResult'] as const)('treats %s failure as unavailable and removes raw error details', async method => {
    const t = await setup()
    t.feishu[method].mockRejectedValue(new AxiosError('SYNTHETIC_SECRET PRIVATE_GROUP_NAME', 'ERR_NETWORK'))
    const result = await t.check()
    expect(result.status).toBe('unavailable')
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_SECRET|PRIVATE_GROUP_NAME/)
  })

  it.each(['whoAmI', 'listChatsResult'] as const)('does not label a programming error from %s as a temporary outage', async method => {
    const t = await setup(), before = t.snapshot(), error = new TypeError('SYNTHETIC_ADAPTER_BUG')
    t.feishu[method].mockRejectedValue(error)
    await expect(t.check()).rejects.toBe(error)
    expect(t.snapshot()).toBe(before)
  })

  it('uses typed token denial without falling back to app credentials and revalidates the denial before use', async () => {
    const t = await setup()
    t.time(t.tokens.get('ou_owner')!.expiresAt)
    t.provider.refresh.mockRejectedValue(new OAuthTokenError('invalid_grant'))
    const result = await t.check()
    expect(result).toMatchObject({ status: 'denied', reason: 'invalid_grant' })
    result.assertCurrent()
    t.provider.exchangeCode.mockResolvedValue({ ...t.grant, accessToken: 'SYNTHETIC_REPLACEMENT' })
    await t.connect()
    expect(() => result.assertCurrent()).toThrow(PersonalMemoryAccessChanged)
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
    expect(t.feishu.listChatsResult).not.toHaveBeenCalled()
  })

  it('treats local safety expiry without renewal as unavailable, preserving the stored source/grant', async () => {
    const t = await setup()
    t.db.prepare('UPDATE user_tokens SET refresh_token=NULL WHERE open_id=?').run('ou_owner')
    t.time(t.tokens.get('ou_owner')!.expiresAt)
    const before = t.snapshot()
    expect(await t.check()).toMatchObject({ status: 'unavailable', reason: 'token_unavailable' })
    expect(t.snapshot()).toBe(before)
  })

  it('makes a disconnected denial obsolete as soon as a new connection exists', async () => {
    const t = await setup()
    t.tokens.disconnect('ou_owner')
    const result = await t.check()
    expect(result).toMatchObject({ status: 'denied', reason: 'not_connected' })
    await t.connect()
    expect(() => result.assertCurrent()).toThrow(PersonalMemoryAccessChanged)
  })

  it.each(['archived', 'rebound', 'missing'] as const)('rejects an original source Space that is %s without touching unrelated sources', async mode => {
    const t = await setup(), group = t.spaces.ensure({ kind: 'group', chatId: 'oc_group' })
    if (mode === 'archived') t.spaces.suspend(group.id)
    else if (mode === 'rebound') t.spaces.rebind(group.id, 'oc_changed')
    const source = t.source({ spaceId: mode === 'missing' ? 'missing-space' : group.id })
    const before = t.snapshot()
    expect(await t.check([source])).toMatchObject({ status: 'denied', reason: 'source_binding_changed' })
    expect(t.snapshot()).toBe(before)
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
  })

  it.each([
    { phase: 'whoAmI', change: 'stop' }, { phase: 'whoAmI', change: 'disconnect' },
    { phase: 'listChatsResult', change: 'rebind' }, { phase: 'listChatsResult', change: 'remove-owner' },
    { phase: 'listChatsResult', change: 'archive' }, { phase: 'listChatsResult', change: 'deny-policy' },
    { phase: 'listChatsResult', change: 'reconnect' }, { phase: 'listChatsResult', change: 'archive-source' },
    { phase: 'listChatsResult', change: 'scope-revoked' },
  ] as const)('revalidates after $phase waits while $change occurs', async ({ phase, change }) => {
    const t = await setup(), group = t.spaces.ensure({ kind: 'group', chatId: 'oc_group' })
    const entered = deferred(), release = deferred()
    if (phase === 'whoAmI') t.feishu.whoAmI.mockImplementation(async () => { entered.resolve(); await release.promise; return t.identity })
    else t.feishu.listChatsResult.mockImplementation(async () => { entered.resolve(); await release.promise; return t.chats })
    const pending = t.check([t.source({ spaceId: group.id })])
    await entered.promise
    if (change === 'stop') t.stop()
    else if (change === 'disconnect') t.tokens.disconnect('ou_owner')
    else if (change === 'rebind') t.spaces.rebind(group.id, 'oc_changed')
    else if (change === 'remove-owner') t.spaces.removeMember(t.dm.id, 'ou_owner')
    else if (change === 'archive') t.spaces.suspend(t.dm.id)
    else if (change === 'deny-policy') t.policyOptions.mode = 'deny'
    else if (change === 'archive-source') t.spaces.suspend(group.id)
    else if (change === 'scope-revoked') t.db.prepare('UPDATE user_tokens SET scope=? WHERE open_id=?').run('im:chat:readonly', 'ou_owner')
    else {
      t.provider.exchangeCode.mockResolvedValue({ ...t.grant, accessToken: 'SYNTHETIC_REPLACEMENT' })
      await t.connect()
    }
    release.resolve()
    if (change === 'stop') await expect(pending).rejects.toBe(t.stopped)
    else await expect(pending).rejects.toBeInstanceOf(PersonalMemoryAccessChanged)
  })

  it('keeps allowed and denied results recheckable after return while unrelated config can change', async () => {
    const t = await setup(), group = t.spaces.ensure({ kind: 'group', chatId: 'oc_group' })
    const allowed = await t.check([t.source({ spaceId: group.id })])
    t.spaces.patchConfig(t.dm.id, { brevity: 'short' })
    allowed.assertCurrent()
    t.feishu.listChatsResult.mockResolvedValue({ items: [], complete: true })
    const denied = await t.check([t.source({ spaceId: group.id })])
    expect(denied.status).toBe('denied')
    t.spaces.rebind(group.id, 'oc_changed')
    expect(() => allowed.assertCurrent()).toThrow(PersonalMemoryAccessChanged)
    expect(() => denied.assertCurrent()).toThrow(PersonalMemoryAccessChanged)
  })
})
