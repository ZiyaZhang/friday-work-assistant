import { DatabaseSync } from 'node:sqlite'
import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsoleAuth, type ConsoleAuthOptions } from '../src/web/console-auth.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { FeishuClient } from '../src/feishu/client.js'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function request(cookieValue?: string) { return { headers: { ...(cookieValue ? { cookie: cookieValue } : {}) } } as IncomingMessage }

async function fixture(patch: Partial<ConsoleAuthOptions> = {}) {
  const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close())
  let now = 1_000_000
  const provider = {
    exchangeCode: vi.fn(async () => ({ accessToken: 'SYNTHETIC_PLATFORM_SECRET', refreshToken: 'SYNTHETIC_REFRESH_SECRET' })),
    whoAmI: vi.fn(async () => ({ openId: 'ou_alice', tenantKey: 'tenant-a', name: 'Alice' })),
  }
  const options = { db, provider, appId: 'cli_synthetic', domain: 'feishu' as const, baseUrl: 'https://console.example.test', tenantKeys: ['tenant-a'], now: () => now, ...patch }
  const auth = new ConsoleAuth(options)
  const server = createServer((req, res) => {
    void auth.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end('missing') } })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) })
  const address = server.address() as { port: number }, base = `http://127.0.0.1:${address.port}`
  const call = (path: string, opts: RequestInit = {}) => fetch(`${base}${path}`, { ...opts, redirect: 'manual' })
  const pairs = (res: Response) => res.headers.getSetCookie().map(value => value.split(';')[0]!)
  async function start(sessionCookie = '') {
    const res = await call('/console/auth/start?openId=ou_forged&return=https://attacker.invalid/', { headers: sessionCookie ? { cookie: sessionCookie } : {} })
    expect(res.status).toBe(303)
    const location = new URL(res.headers.get('location')!)
    return { res, state: location.searchParams.get('state')!, nonce: pairs(res)[0]!, location }
  }
  const callback = (s: Awaited<ReturnType<typeof start>>, sessionCookie = '') => call(`/console/auth/callback?code=synthetic_code&state=${s.state}`,
    { headers: { cookie: [s.nonce, sessionCookie].filter(Boolean).join('; ') } })
  async function login() {
    const s = await start(), res = await callback(s)
    expect(res.status).toBe(303)
    const sessionCookie = pairs(res).find(value => value.startsWith(`${auth.sessionCookieName}=`))!
    const me = await (await call('/console/api/me', { headers: { cookie: sessionCookie } })).json()
    return { sessionCookie, me, response: res }
  }
  const logout = (sessionCookie: string, csrf: string, extra: Record<string, string> = {}) => call('/console/api/logout', { method: 'POST',
    headers: { cookie: sessionCookie, origin: auth.origin, 'content-type': 'application/json', 'x-csrf-token': csrf, ...extra }, body: '{}' })
  return { db, options, provider, auth, call, start, callback, login, logout, pairs, advance: (ms: number) => { now += ms } }
}

describe('human console login over HTTP', () => {
  it('verifies the actual platform account, issues only a browser cookie and exposes CSRF only through me', async () => {
    const t = await fixture(), start = await t.start()
    expect(start.location.origin).toBe('https://accounts.feishu.cn')
    expect(start.location.searchParams.get('scope')).toBe('contact:user.base:readonly')
    expect(start.location.searchParams.get('redirect_uri')).toBe('https://console.example.test/console/auth/callback')
    expect(start.res.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax; Max-Age=600; Secure/)
    const response = await t.callback(start)
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://console.example.test/console')
    const sessionCookie = t.pairs(response).find(value => value.startsWith('__Host-friday_console='))!
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const meResponse = await t.call('/console/api/me', { headers: { cookie: sessionCookie } }), me = await meResponse.json()
    expect(me.actor).toMatchObject({ appId: 'cli_synthetic', tenantKey: 'tenant-a', openId: 'ou_alice', name: 'Alice' })
    expect(me.actor).not.toHaveProperty('csrfToken')
    expect(me.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(t.provider.exchangeCode).toHaveBeenCalledWith('synthetic_code', 'https://console.example.test/console/auth/callback')
    expect(t.provider.whoAmI).toHaveBeenCalledWith('SYNTHETIC_PLATFORM_SECRET')
    expect(JSON.stringify(me)).not.toContain('SYNTHETIC_')
    const stored = JSON.stringify(t.db.prepare('SELECT * FROM console_sessions').all())
    expect(stored).not.toContain(sessionCookie.split('=')[1])
    expect(stored).not.toContain('SYNTHETIC_PLATFORM_SECRET')
    expect(stored).not.toContain('SYNTHETIC_REFRESH_SECRET')
    expect(t.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'console_sessions' }])
  })

  it('rejects a missing or different-browser nonce, unknown state and another OAuth purpose without exchanging a code', async () => {
    const t = await fixture(), s = await t.start()
    for (const headers of [{}, { cookie: `${t.auth.nonceCookieName}=other-browser` }]) {
      const res = await t.call(`/console/auth/callback?code=x&state=${s.state}`, { headers })
      expect(res.status).toBe(400)
    }
    const connect = new UserTokenStore(t.db, { ...t.provider, refresh: async () => ({ accessToken: 'never' }) })
    const connectState = connect.begin('ou_alice')
    expect((await t.call(`/console/auth/callback?code=x&state=${connectState}`, { headers: { cookie: s.nonce } })).status).toBe(400)
    expect(t.provider.exchangeCode).not.toHaveBeenCalled()
    expect((await t.callback(s)).status).toBe(303)
    expect((await t.callback(s)).status).toBe(400)
    expect(t.provider.exchangeCode).toHaveBeenCalledTimes(1)
    expect(t.db.prepare('SELECT count(*) AS n FROM user_tokens').get()?.n).toBe(0)
  })

  it('claims state before an exchange await, so concurrent replay causes only one exchange/session', async () => {
    const t = await fixture(), s = await t.start(), entered = deferred(), release = deferred()
    t.provider.exchangeCode.mockImplementation(async () => { entered.resolve(); await release.promise; return { accessToken: 'synthetic' } })
    const first = t.callback(s); await entered.promise
    expect((await t.callback(s)).status).toBe(400)
    release.resolve()
    expect((await first).status).toBe(303)
    expect(t.provider.exchangeCode).toHaveBeenCalledTimes(1)
    expect(t.db.prepare('SELECT count(*) AS n FROM console_sessions').get()?.n).toBe(1)
  })

  it('does not replace the existing account when a different person completes reauthentication', async () => {
    const t = await fixture(), a = await t.login(), s = await t.start(a.sessionCookie)
    t.provider.whoAmI.mockResolvedValue({ openId: 'ou_bob', tenantKey: 'tenant-a', name: 'Bob' })
    const response = await t.callback(s, a.sessionCookie)
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('identity_mismatch')
    expect((await (await t.call('/console/api/me', { headers: { cookie: a.sessionCookie } })).json()).actor.openId).toBe('ou_alice')
    expect(t.db.prepare('SELECT count(*) AS n FROM console_sessions').get()?.n).toBe(1)
  })

  it.each([
    { openId: '', tenantKey: 'tenant-a' }, { openId: 'ou_alice', tenantKey: '' },
    { openId: 'ou_alice', tenantKey: 'another-tenant' }, { openId: 'not a platform id', tenantKey: 'tenant-a' },
  ])('rejects an unverifiable platform identity %j', async identity => {
    const t = await fixture(), s = await t.start()
    t.provider.whoAmI.mockResolvedValue({ ...identity, name: 'Untrusted' })
    const res = await t.callback(s)
    expect(res.status).toBe(403)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(t.db.prepare('SELECT count(*) AS n FROM console_sessions').get()?.n).toBe(0)
  })

  it.each(['exchangeCode', 'whoAmI'] as const)('never returns or logs raw provider errors from %s', async method => {
    const t = await fixture(), s = await t.start()
    const stderr = vi.spyOn(process.stderr, 'write')
    try {
      t.provider[method].mockRejectedValue(new Error('SYNTHETIC_SECRET_HEADER_AND_TOKEN'))
      const res = await t.callback(s), body = await res.text()
      expect(res.status).toBe(502)
      expect(body).not.toContain('SYNTHETIC_SECRET')
      expect(stderr).not.toHaveBeenCalled()
      expect(t.db.prepare('SELECT count(*) AS n FROM console_sessions').get()?.n).toBe(0)
    } finally { stderr.mockRestore() }
  })

  it('expires login attempts both before exchange and during platform verification', async () => {
    const t = await fixture(), expired = await t.start()
    t.advance(10 * 60_000)
    expect((await t.callback(expired)).status).toBe(400)
    expect(t.provider.exchangeCode).not.toHaveBeenCalled()
    const current = await t.start()
    t.provider.whoAmI.mockImplementation(async () => { t.advance(10 * 60_000); return { openId: 'ou_alice', tenantKey: 'tenant-a', name: 'Alice' } })
    expect((await t.callback(current)).status).toBe(400)
    expect(t.db.prepare('SELECT count(*) AS n FROM console_sessions').get()?.n).toBe(0)
  })

  it.each(['exchangeCode', 'whoAmI'] as const)('logout while %s waits invalidates captured actor and prevents late session creation', async method => {
    const t = await fixture(), a = await t.login(), s = await t.start(a.sessionCookie), entered = deferred(), release = deferred()
    const actor = t.auth.authenticate(request(a.sessionCookie))
    if (method === 'exchangeCode') t.provider.exchangeCode.mockImplementation(async () => { entered.resolve(); await release.promise; return { accessToken: 'synthetic' } })
    else t.provider.whoAmI.mockImplementation(async () => { entered.resolve(); await release.promise; return { openId: 'ou_alice', tenantKey: 'tenant-a', name: 'Alice' } })
    const pending = t.callback(s, a.sessionCookie); await entered.promise
    const logout = await t.logout(a.sessionCookie, a.me.csrfToken)
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(() => t.auth.assertCurrent(actor)).toThrow(/失效/)
    release.resolve()
    expect([400, 401]).toContain((await pending).status)
    expect((await t.call('/console/api/me', { headers: { cookie: a.sessionCookie } })).status).toBe(401)
    expect(t.db.prepare('SELECT count(*) AS n FROM console_sessions WHERE revoked_at IS NULL').get()?.n).toBe(0)
    expect(t.db.prepare('SELECT count(*) AS n FROM console_sessions').get()?.n).toBe(1)
  })

  it('a newer login start with the same browser nonce cancels an already claimed anonymous callback', async () => {
    const t = await fixture(), s = await t.start(), entered = deferred(), release = deferred()
    t.provider.whoAmI.mockImplementation(async () => { entered.resolve(); await release.promise; return { openId: 'ou_alice', tenantKey: 'tenant-a', name: 'Alice' } })
    const pending = t.callback(s); await entered.promise
    await t.start(s.nonce)
    release.resolve()
    expect((await pending).status).toBe(400)
    expect(t.db.prepare('SELECT count(*) AS n FROM console_sessions').get()?.n).toBe(0)
  })

  it('keeps browser sessions and Agent capabilities in separate namespaces', async () => {
    const t = await fixture(), a = await t.login(), issuer = new TokenIssuer('synthetic-hmac')
    const capability = issuer.issue({ sessionKey: 'synthetic-session', runId: 'synthetic-run', chatId: 'chat', chatType: 'p2p', requesterOpenId: 'ou_alice', scopes: ['memory:read'] })
    for (const headers of [{ authorization: `Bearer ${capability}` }, { cookie: `${t.auth.sessionCookieName}=${capability}` },
      { authorization: `Bearer ${a.sessionCookie.split('=')[1]}` }]) {
      expect((await t.call('/console/api/me', { headers })).status).toBe(401)
    }
    expect(issuer.verify(a.sessionCookie.split('=')[1]!)).toBeUndefined()
    expect((await t.call('/v1/project/view', { headers: { cookie: a.sessionCookie } })).status).toBe(404)
    expect((await t.call('/console/api/connect', { method: 'POST', body: '{}' })).status).toBe(404)
  })

  it('requires same origin, JSON and session-bound CSRF for logout without revoking on rejected requests', async () => {
    const t = await fixture(), a = await t.login(), b = await t.login()
    for (const extra of [ { origin: 'https://attacker.invalid' }, { origin: '' }, { 'content-type': 'text/plain' },
      { 'x-csrf-token': '' }, { 'x-csrf-token': b.me.csrfToken } ]) {
      expect((await t.logout(a.sessionCookie, a.me.csrfToken, extra)).status).toBe(403)
      expect((await t.call('/console/api/me', { headers: { cookie: a.sessionCookie } })).status).toBe(200)
    }
    expect((await t.logout(a.sessionCookie, a.me.csrfToken)).status).toBe(200)
    expect((await t.call('/console/api/me', { headers: { cookie: b.sessionCookie } })).status).toBe(200)
  })

  it('rejects ambiguous duplicate cookies and rotates a successful same-person session', async () => {
    const t = await fixture(), a = await t.login()
    expect((await t.call('/console/api/me', { headers: { cookie: `${a.sessionCookie}; ${a.sessionCookie}` } })).status).toBe(401)
    const s = await t.start(a.sessionCookie), res = await t.callback(s, a.sessionCookie)
    expect(res.status).toBe(303)
    expect((await t.call('/console/api/me', { headers: { cookie: a.sessionCookie } })).status).toBe(401)
    const current = t.pairs(res).find(value => value.startsWith(t.auth.sessionCookieName))!
    expect(current).not.toBe(a.sessionCookie)
    expect((await t.call('/console/api/me', { headers: { cookie: current } })).status).toBe(200)
  })

  it('requires explicit loopback HTTP development and never silently downgrades production cookies', async () => {
    const t = await fixture()
    for (const baseUrl of ['http://console.example.test', 'http://127.0.0.1:7777', 'https://user:secret@console.example.test', 'https://console.example.test/not-console']) {
      expect(() => new ConsoleAuth({ ...t.options, baseUrl })).toThrow()
    }
    expect(() => new ConsoleAuth({ ...t.options, baseUrl: 'http://0.0.0.0:7777', allowInsecureLoopback: true })).toThrow()
    expect(() => new ConsoleAuth({ ...t.options, tenantKeys: [] })).toThrow()
    const local = await fixture({ baseUrl: 'http://127.0.0.1:7777', allowInsecureLoopback: true, domain: 'lark' })
    const start = await local.start()
    expect(start.location.origin).toBe('https://accounts.larksuite.com')
    expect(start.res.headers.get('set-cookie')).toContain('friday_login_dev=')
    expect(start.res.headers.get('set-cookie')).not.toContain('Secure')
  })
})

describe('real Feishu identity adapter', () => {
  it('returns tenant identity from the official userInfo response without constructing a network client', async () => {
    const get = vi.fn().mockResolvedValue({ code: 0, data: { open_id: 'ou_synthetic', tenant_key: 'tenant-synthetic', name: 'Synthetic Person' } })
    const client = Object.assign(Object.create(FeishuClient.prototype) as FeishuClient, { client: { authen: { v1: { userInfo: { get } } } } })
    expect(await client.whoAmI('synthetic-token')).toEqual({ openId: 'ou_synthetic', tenantKey: 'tenant-synthetic', name: 'Synthetic Person' })
    expect(get).toHaveBeenCalledTimes(1)
  })
})
