import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeishuClient } from '../src/feishu/client.js'
import { OAuthTokenError, UserTokenStore, type TokenExchange } from '../src/feishu/oauth.js'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  let now = 1_000_000
  const initial: TokenExchange = { accessToken: 'SYNTHETIC_ACCESS_1', expiresIn: 7200,
    refreshToken: 'SYNTHETIC_REFRESH_1', refreshTokenExpiresIn: 86400, scope: 'im:chat:readonly' }
  const next: TokenExchange = { ...initial, accessToken: 'SYNTHETIC_ACCESS_2', refreshToken: 'SYNTHETIC_REFRESH_2' }
  const provider = { exchangeCode: vi.fn(async () => initial), refresh: vi.fn(async () => next) }
  const store = new UserTokenStore(db, provider, () => now)
  const connect = () => store.complete({ code: 'synthetic-code', redirectUri: 'https://callback.invalid', openId: 'ou_owner' })
  return { db, store, provider, initial, next, connect, now: () => now, time: (value: number) => { now = value } }
}

describe('typed user token access', () => {
  it('reports an absent connection without contacting the provider', async () => {
    const t = setup()
    expect(await t.store.accessTokenResult('ou_owner')).toEqual({ status: 'denied', reason: 'not_connected' })
    expect(await t.store.accessTokenFor('ou_owner')).toBeUndefined()
    expect(t.provider.refresh).not.toHaveBeenCalled()
  })

  it('returns a recheckable current token without changing data/schema on reconstruction', async () => {
    const t = setup()
    const original = await t.connect()
    const schema = t.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()
    const result = await t.store.accessTokenResult('ou_owner')
    expect(result.status).toBe('available')
    if (result.status !== 'available') throw new Error('expected available')
    expect(result.accessToken).toBe(original.accessToken)
    expect(result.isCurrent()).toBe(true)
    const rebuilt = new UserTokenStore(t.db, t.provider, t.now)
    expect(rebuilt.get('ou_owner')).toEqual(original)
    expect(t.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()).toEqual(schema)
    t.time(original.expiresAt)
    expect(result.isCurrent()).toBe(false)
    expect(t.provider.refresh).not.toHaveBeenCalled()
  })

  it('refreshes near expiry and gives a lease for the newly saved connection', async () => {
    const t = setup()
    const original = await t.connect()
    t.time(original.expiresAt - 120_000)
    const result = await t.store.accessTokenResult('ou_owner')
    expect(result.status).toBe('available')
    if (result.status !== 'available') throw new Error('expected available')
    expect(result.accessToken).toBe(t.next.accessToken)
    expect(result.isCurrent()).toBe(true)
    expect(t.provider.refresh).toHaveBeenCalledExactlyOnceWith(original.refreshToken)
    expect(await t.store.accessTokenFor('ou_owner')).toBe(t.next.accessToken)
    expect(t.provider.refresh).toHaveBeenCalledTimes(1)
  })

  it('does not inherit scopes or renewal credentials from a different code grant', async () => {
    const t = setup(), old = await t.connect()
    t.provider.exchangeCode.mockResolvedValue({ accessToken: 'SYNTHETIC_NEW_GRANT', expiresIn: 7200 })
    const replacement = await t.connect()
    expect(replacement).toMatchObject({ scope: '', refreshToken: null, refreshExpiresAt: null })
    expect(replacement.createdAt).toBe(old.createdAt)
    t.time(replacement.expiresAt)
    expect(await t.store.accessTokenResult('ou_owner')).toEqual({ status: 'unavailable', reason: 'refresh_unavailable' })
    expect(t.provider.refresh).not.toHaveBeenCalled()
  })

  it('preserves omitted scope and renewal fields only for a refresh of the same grant', async () => {
    const t = setup(), old = await t.connect()
    t.time(old.expiresAt)
    t.provider.refresh.mockResolvedValue({ accessToken: 'SYNTHETIC_SAME_GRANT_REFRESH', expiresIn: 7200 })
    expect((await t.store.accessTokenResult('ou_owner')).status).toBe('available')
    expect(t.store.get('ou_owner')).toMatchObject({ scope: old.scope, refreshToken: old.refreshToken, refreshExpiresAt: old.refreshExpiresAt })
  })

  it.each([
    { name: 'no refresh token, access still valid', hasRefresh: false, accessValid: true, status: 'unavailable', reason: 'refresh_unavailable' },
    { name: 'expired refresh token, access still valid', hasRefresh: true, accessValid: true, status: 'unavailable', reason: 'refresh_unavailable' },
    { name: 'no refresh token, past the stored safety deadline', hasRefresh: false, accessValid: false, status: 'unavailable', reason: 'refresh_unavailable' },
    { name: 'expired refresh token, past the stored access safety deadline', hasRefresh: true, accessValid: false, status: 'unavailable', reason: 'refresh_unavailable' },
  ])('distinguishes expiry from unavailable renewal: $name', async ({ hasRefresh, accessValid, status, reason }) => {
    const t = setup()
    const original = await t.connect()
    t.db.prepare('UPDATE user_tokens SET refresh_token=?, refresh_expires_at=? WHERE open_id=?')
      .run(hasRefresh ? original.refreshToken : null, t.now(), 'ou_owner')
    t.time(accessValid ? original.expiresAt - 120_000 : original.expiresAt)
    const before = t.store.get('ou_owner')
    expect(await t.store.accessTokenResult('ou_owner')).toEqual({ status, reason })
    expect(await t.store.accessTokenFor('ou_owner')).toBeUndefined()
    expect(t.store.get('ou_owner')).toEqual(before)
    expect(t.provider.refresh).not.toHaveBeenCalled()
  })

  it('does not call a buffered access deadline proof that the provider token has expired', async () => {
    const t = setup()
    const issuedAt = t.now()
    t.provider.exchangeCode.mockResolvedValue({ accessToken: 'SYNTHETIC_UNREFRESHABLE', expiresIn: 7200 })
    const saved = await t.connect()
    t.time(saved.expiresAt + 30_000)
    expect(t.now()).toBeLessThan(issuedAt + 7200_000) // The synthetic provider token still has 30 seconds.
    expect(await t.store.accessTokenResult('ou_owner')).toEqual({ status: 'unavailable', reason: 'refresh_unavailable' })
    expect(t.store.get('ou_owner')).toEqual(saved)
  })

  it('shares one refresh for a captured grant so token rotation cannot look like a second-call denial', async () => {
    const t = setup()
    const saved = await t.connect()
    t.time(saved.expiresAt)
    const refresh = deferred<TokenExchange>()
    t.provider.refresh.mockImplementationOnce(() => refresh.promise)
      .mockRejectedValueOnce(new OAuthTokenError('invalid_grant'))
    const first = t.store.accessTokenResult('ou_owner')
    const second = t.store.accessTokenResult('ou_owner')
    await Promise.resolve() // An accidental second request can reject before the valid rotation returns.
    refresh.resolve(t.next)
    const results = await Promise.all([first, second])
    expect(results.map(result => result.status)).toEqual(['available', 'available'])
    expect(t.provider.refresh).toHaveBeenCalledTimes(1)
    for (const result of results) {
      if (result.status !== 'available') throw new Error('expected available')
      expect(result.accessToken).toBe(t.next.accessToken)
      expect(result.isCurrent()).toBe(true)
    }
  })

  it.each([
    new Error('SYNTHETIC_SECRET invalid_grant network timeout'),
    new OAuthTokenError('unavailable'),
    { reason: 'invalid_grant', message: 'SYNTHETIC_SECRET' },
  ])('does not infer revocation from an untyped/unknown refresh failure %#', async error => {
    const t = setup()
    const before = await t.connect()
    t.time(before.expiresAt - 120_000)
    t.provider.refresh.mockRejectedValue(error)
    const result = await t.store.accessTokenResult('ou_owner')
    expect(result).toEqual({ status: 'unavailable', reason: 'refresh_failed' })
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET')
    expect(t.store.get('ou_owner')).toEqual(before)
  })

  it('reports an explicit grant denial but leaves persistence/revocation actions to the host', async () => {
    const t = setup()
    const before = await t.connect()
    t.time(before.expiresAt - 120_000)
    t.provider.refresh.mockRejectedValue(new OAuthTokenError('invalid_grant'))
    expect(await t.store.accessTokenResult('ou_owner')).toEqual({ status: 'denied', reason: 'invalid_grant' })
    expect(await t.store.accessTokenFor('ou_owner')).toBeUndefined()
    expect(t.store.get('ou_owner')).toEqual(before)
  })

  it.each(['success', 'denial'] as const)('discards a late refresh %s after disconnect', async outcome => {
    const t = setup()
    const before = await t.connect()
    t.time(before.expiresAt)
    const refresh = deferred<TokenExchange>()
    t.provider.refresh.mockReturnValue(refresh.promise)
    const pending = t.store.accessTokenResult('ou_owner')
    const joined = t.store.accessTokenResult('ou_owner')
    expect(t.provider.refresh).toHaveBeenCalledTimes(1)
    t.store.disconnect('ou_owner')
    if (outcome === 'success') refresh.resolve(t.next)
    else refresh.reject(new OAuthTokenError('invalid_grant'))
    expect(await pending).toEqual({ status: 'denied', reason: 'not_connected' })
    expect(await joined).toEqual({ status: 'denied', reason: 'not_connected' })
    expect(t.store.get('ou_owner')).toBeUndefined()
  })

  it.each(['success', 'denial'] as const)('does not apply an old refresh %s to a replacement grant', async outcome => {
    const t = setup()
    const before = await t.connect()
    t.time(before.expiresAt)
    const refresh = deferred<TokenExchange>()
    t.provider.refresh.mockReturnValue(refresh.promise)
    const pending = t.store.accessTokenResult('ou_owner')
    const joined = t.store.accessTokenResult('ou_owner')
    t.provider.exchangeCode.mockResolvedValue({ ...t.initial, accessToken: 'SYNTHETIC_REPLACEMENT' })
    const replacement = await t.connect()
    if (outcome === 'success') refresh.resolve(t.next)
    else refresh.reject(new OAuthTokenError('invalid_grant'))
    expect(await pending).toEqual({ status: 'unavailable', reason: 'connection_changed' })
    expect(await joined).toEqual({ status: 'unavailable', reason: 'connection_changed' })
    expect(t.provider.refresh).toHaveBeenCalledTimes(1)
    expect(t.store.get('ou_owner')).toEqual(replacement)
  })

  it('does not reuse or clear a replacement grant flight when the previous refresh finishes', async () => {
    const t = setup()
    const before = await t.connect()
    t.time(before.expiresAt)
    const oldRefresh = deferred<TokenExchange>(), newRefresh = deferred<TokenExchange>()
    t.provider.refresh.mockImplementationOnce(() => oldRefresh.promise).mockImplementationOnce(() => newRefresh.promise)
    const old = t.store.accessTokenResult('ou_owner')
    t.store.disconnect('ou_owner')
    t.provider.exchangeCode.mockResolvedValue({ ...t.initial, accessToken: 'SYNTHETIC_REPLACED_ACCESS',
      refreshToken: 'SYNTHETIC_REPLACED_REFRESH', expiresIn: 120 })
    await t.connect()
    const next = t.store.accessTokenResult('ou_owner')
    oldRefresh.resolve(t.next)
    expect(await old).toEqual({ status: 'unavailable', reason: 'connection_changed' })
    const joined = t.store.accessTokenResult('ou_owner')
    expect(t.provider.refresh).toHaveBeenCalledTimes(2)
    newRefresh.resolve({ ...t.next, accessToken: 'SYNTHETIC_NEW_ACCESS' })
    const results = await Promise.all([next, joined])
    for (const result of results) {
      expect(result.status).toBe('available')
      if (result.status !== 'available') throw new Error('expected available')
      expect(result.accessToken).toBe('SYNTHETIC_NEW_ACCESS')
      expect(result.isCurrent()).toBe(true)
    }
  })

  it('rejects a captured lease after a same-token scope change and a wrapper result after disconnect', async () => {
    const t = setup()
    await t.connect()
    const captured = await t.store.accessTokenResult('ou_owner')
    if (captured.status !== 'available') throw new Error('expected available')
    t.provider.exchangeCode.mockResolvedValue({ ...t.initial, scope: '' })
    await t.connect() // same synthetic clock and token bytes; scope is part of authorization.
    expect(captured.isCurrent()).toBe(false)
    const pending = t.store.accessTokenFor('ou_owner')
    t.store.disconnect('ou_owner')
    expect(await pending).toBeUndefined()
  })

  it('does not save a malformed provider refresh success', async () => {
    const t = setup()
    const before = await t.connect()
    t.time(before.expiresAt)
    t.provider.refresh.mockResolvedValue({ accessToken: ' ' })
    expect(await t.store.accessTokenResult('ou_owner')).toEqual({ status: 'unavailable', reason: 'refresh_failed' })
    expect(t.store.get('ou_owner')).toEqual(before)
  })
})

function adapter() {
  const post = vi.fn()
  // Real Feishu OAuth methods; only the outbound HTTP transport is synthetic.
  const client = Object.assign(Object.create(FeishuClient.prototype) as FeishuClient, {
    http: { post }, apiBase: 'https://oauth.invalid', opts: { appId: 'synthetic-app', appSecret: 'SYNTHETIC_CLIENT_SECRET' },
  })
  return { client, post }
}

function transportError(status: number, data: unknown) {
  return Object.assign(new Error('SYNTHETIC_TRANSPORT_SECRET'), {
    isAxiosError: true, response: { status, data }, config: { data: 'SYNTHETIC_REQUEST_SECRET' },
  })
}

describe('real OAuth adapter error classification', () => {
  it.each([
    { name: 'structured token response', response: { error: 'invalid_grant', error_description: 'SYNTHETIC_PROVIDER_SECRET' } },
    { name: 'HTTP 400 OAuth response', failure: transportError(400, { error: 'invalid_grant', error_description: 'SYNTHETIC_PROVIDER_SECRET' }) },
  ])('recognizes only explicit invalid_grant: $name', async scenario => {
    const t = adapter()
    if ('failure' in scenario) t.post.mockRejectedValue(scenario.failure)
    else t.post.mockResolvedValue(scenario.response)
    const error = await t.client.refresh('SYNTHETIC_REFRESH_SECRET').catch(error => error)
    expect(error).toBeInstanceOf(OAuthTokenError)
    expect(error.reason).toBe('invalid_grant')
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain('SYNTHETIC_')
    expect(error).not.toHaveProperty('cause')
    expect(error).not.toHaveProperty('response')
    expect(t.post).toHaveBeenCalledTimes(1)
  })

  it.each([
    { name: 'unknown numeric code', response: { code: 123456, error_description: 'invalid_grant SYNTHETIC_SECRET' } },
    { name: 'client configuration rejection', response: { error: 'invalid_client' } },
    { name: 'HTTP 401 alone', failure: transportError(401, { message: 'unauthorized' }) },
    { name: 'HTTP 403 alone', failure: transportError(403, { message: 'forbidden' }) },
    { name: 'server failure', failure: transportError(503, { error: 'invalid_grant' }) },
    { name: 'network failure', failure: new Error('invalid_grant SYNTHETIC_SECRET ECONNRESET') },
    { name: 'null body', response: null },
    { name: 'missing token', response: { code: 0 } },
    { name: 'non-string token', response: { code: 0, access_token: 42 } },
  ])('preserves uncertainty and drops raw errors: $name', async scenario => {
    const t = adapter()
    if ('failure' in scenario) t.post.mockRejectedValue(scenario.failure)
    else t.post.mockResolvedValue(scenario.response)
    const error = await t.client.refresh('SYNTHETIC_REFRESH_SECRET').catch(error => error)
    expect(error).toBeInstanceOf(OAuthTokenError)
    expect(error.reason).toBe('unavailable')
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain('SYNTHETIC_')
    expect(error).not.toHaveProperty('config')
    expect(error).not.toHaveProperty('response')
  })

  it('preserves successful code exchange and refresh payloads', async () => {
    const t = adapter()
    t.post.mockResolvedValue({ code: 0, access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
      expires_in: 7200, refresh_token_expires_in: 86400, scope: 'im:chat:readonly' })
    const code = await t.client.exchangeCode('synthetic-code', 'https://callback.invalid')
    const refreshed = await t.client.refresh('synthetic-refresh')
    expect(refreshed).toEqual(code)
    expect(code).toEqual({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
      expiresIn: 7200, refreshTokenExpiresIn: 86400, scope: 'im:chat:readonly' })
    expect(t.post.mock.calls.map(call => call[1].grant_type)).toEqual(['authorization_code', 'refresh_token'])
  })
})
