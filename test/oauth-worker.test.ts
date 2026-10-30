import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { publicEncrypt } from 'node:crypto'
import worker from '../cloudflare/friday-oauth/src/worker.js'
import { createRelayState, OAuthRelay } from '../src/feishu/oauth-relay.js'
import { GitHubUserConnections } from '../src/github/user-connection.js'
import { createLogger } from '../src/log.js'

function fakeD1() {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../cloudflare/friday-oauth/schema.sql', import.meta.url), 'utf8'))
  return { raw: db, prepare(sql: string) {
    let args: unknown[] = []
    const stmt = { bind(...a: unknown[]) { args = a; return stmt },
      async run() { return { success: true, results: db.prepare(sql).all(...args as never[]) } },
      async first() { return db.prepare(sql).all(...args as never[])[0] } }
    return stmt
  } }
}
const BASE = 'https://friday-oauth.example.workers.dev'
const TOKEN = 'synthetic-relay-key'
let env: { DB: ReturnType<typeof fakeD1>; RELAY_TOKEN: string }
let state: string
beforeEach(() => { env = { DB: fakeD1(), RELAY_TOKEN: TOKEN }; state = createRelayState(TOKEN) })
afterEach(() => { env.DB.raw.close(); vi.restoreAllMocks() })
const hit = (path: string, init?: RequestInit) => worker.fetch(new Request(BASE + path, init), env as never)
const poll = (which = state, token = TOKEN) => hit(`/relay/claim?state=${which}`, { headers: { authorization: `Bearer ${token}` } })
const callback = (code = 'synthetic-code', which = state) => hit(`/oauth/callback?code=${code}&state=${which}`)
const ack = () => hit(`/relay/ack?state=${state}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })

describe('public callback admission and honest output', () => {
  it('binds Gmail callbacks to their signed provider and keeps credentials encrypted', async () => {
    const gmailState = createRelayState(TOKEN, Date.now(), 'gmail'), githubState = createRelayState(TOKEN, Date.now(), 'github')
    expect((await hit(`/gmail/callback?code=wrong-provider&state=${githubState}`)).status).toBe(400)
    expect((await hit(`/gmail/callback?code=wrong-provider&state=${state}`)).status).toBe(400)
    expect((await hit(`/github/callback?code=wrong-provider&state=${gmailState}`)).status).toBe(400)
    const result = await hit(`/gmail/callback?code=google-code&state=${gmailState}`)
    expect(result.status).toBe(200)
    expect(await result.text()).toContain('Gmail')
    expect(await (await poll(gmailState)).json()).toEqual({ code: 'google-code' })
    expect(JSON.stringify(env.DB.raw.prepare('SELECT * FROM pending').all())).not.toContain('google-code')
  })
  it('separates GitHub and Feishu callbacks while retaining encrypted claim/ack semantics', async () => {
    const githubState = createRelayState(TOKEN, Date.now(), 'github')
    expect((await callback('wrong-provider', githubState)).status).toBe(400)
    expect((await hit(`/github/callback?code=wrong-provider&state=${state}`)).status).toBe(400)
    const result = await hit(`/github/callback?code=github-code&state=${githubState}`)
    expect(result.status).toBe(200); expect(await result.text()).toContain('GitHub返回的结果')
    expect(await (await poll(githubState)).json()).toEqual({ code: 'github-code' })
    expect(JSON.stringify(env.DB.raw.prepare('SELECT * FROM pending').all())).not.toContain('github-code')
  })
  it('only accepts a gateway-signed state; rejects forged, expired and missing states without storing', async () => {
    for (const s of ['Abcd1234', createRelayState('wrong-key'), createRelayState(TOKEN, Date.now() - 11 * 60_000), ''])
      expect((await callback('code', s)).status).toBe(400)
    expect(env.DB.raw.prepare('SELECT count(*) n FROM pending').get()).toMatchObject({ n: 0 })
  })
  it('does not echo credentials or claim connection completion; disables caching and referrer forwarding', async () => {
    const res = await callback()
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('正在核验')
    expect(html).not.toMatch(/synthetic-code|已经收到授权|已连接/)
    expect(html).not.toContain(state)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })
  it('bounds callback inputs and enforces methods', async () => {
    expect((await callback('x'.repeat(2049))).status).toBe(400)
    expect((await hit(`/oauth/callback?state=${state}`)).status).toBe(400)
    expect((await hit('/oauth/callback', { method: 'POST' })).status).toBe(405)
    expect((await hit(`/relay/ack?state=${state}`)).status).toBe(405)
  })
  it('stores encrypted replies, preserving the first callback on replay', async () => {
    await callback('first-secret'); await callback('replacement-secret')
    const stored = JSON.stringify(env.DB.raw.prepare('SELECT * FROM pending').all())
    expect(stored).not.toMatch(/first-secret|replacement-secret/)
    expect(await (await poll()).json()).toEqual({ code: 'first-secret' })
  })
  it('normalizes denial without reflecting provider-controlled descriptions', async () => {
    await hit(`/oauth/callback?state=${state}&error=access_denied&error_description=untrusted-secret`)
    expect(await (await poll()).json()).toEqual({ error: 'denied' })
  })
})

describe('reliable authenticated relay', () => {
  it('retains a reply until acknowledged, then prevents browser replay', async () => {
    await callback()
    expect(await (await poll()).json()).toEqual({ code: 'synthetic-code' })
    expect(await (await poll()).json()).toEqual({ code: 'synthetic-code' })
    expect((await ack()).status).toBe(200)
    await callback('replay')
    expect(await (await poll()).json()).toEqual({ completed: true })
    expect(env.DB.raw.prepare('SELECT payload FROM pending').get()).toMatchObject({ payload: '' })
  })
  it('does not allow unauthenticated reads or acknowledgements', async () => {
    await callback()
    expect((await poll(state, 'wrong')).status).toBe(401)
    expect((await hit(`/relay/ack?state=${state}`, { method: 'POST' })).status).toBe(401)
    expect(await (await poll()).json()).toEqual({ code: 'synthetic-code' })
    env.RELAY_TOKEN = ''
    expect((await poll()).status).toBe(401)
  })
  it('removes expired records through scheduled cleanup without a later user callback', async () => {
    await callback()
    env.DB.raw.prepare('UPDATE pending SET expires_at = 0').run()
    await worker.scheduled({}, env)
    expect((await poll()).status).toBe(404)
  })
  it('recovers a lost poll response and lost acknowledgement without duplicate effects', async () => {
    let dropClaim = true, dropAck = true, exchanged = 0
    const relay = new OAuthRelay({ baseUrl: BASE, token: TOKEN,
      fetch: (async (url, init) => {
        const res = await worker.fetch(new Request(String(url), init), env)
        if (String(url).includes('/claim') && dropClaim) { dropClaim = false; throw new Error('lost response') }
        if (String(url).includes('/ack') && dropAck) { dropAck = false; throw new Error('lost acknowledgement') }
        return res
      }) as typeof fetch,
      log: { info() {}, warn() {}, debug() {} },
      onCode: async ({ code }) => { expect(code).toBe('synthetic-code'); exchanged++ }, onDenied: async () => { throw new Error('unexpected denial') },
    }, 60_000)
    try {
      relay.watch(state, 'ou_synthetic'); await callback()
      await relay.tick(); expect(exchanged).toBe(0)
      await relay.tick(); expect(exchanged).toBe(1)
      await relay.tick(); expect(exchanged).toBe(1); expect(relay.size).toBe(0)
    } finally { relay.close() }
  })
  it('exposes only the OAuth relay and health routes', async () => {
    expect(await (await hit('/healthz')).json()).toEqual({ ok: true })
    for (const path of ['/v1/status', '/oauth/token', '/']) expect((await hit(path)).status).toBe(404)
  })
})

describe('private token setup page and encrypted handoff', () => {
  function setup() {
    const http = vi.fn(async (_path: string, _input: unknown) => ({ status: 200, data: { id: 101, login: 'alice' } }))
    const connections = new GitHubUserConnections({ db: env.DB.raw, key: Buffer.alloc(32, 1), tokenRelay: { baseUrl: BASE, token: TOKEN }, http, log: createLogger('test', 'error') })
    const url = new URL(connections.beginToken('alice').url), values = Object.fromEntries(url.searchParams)
    const token = `github_pat_${'a'.repeat(72)}`
    const code = publicEncrypt({ key: Buffer.from(values.key!, 'base64url'), format: 'der', type: 'spki', oaepHash: 'sha256', oaepLabel: Buffer.from(values.state!) }, Buffer.from(token)).toString('base64url')
    const post = (data = { ...values, code }, origin = BASE) => hit('/github/token', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(data) })
    return { connections, http, url, values, token, code, post }
  }
  it('renders a runnable first-party form and connects through the real encrypted relay', async () => {
    const f = setup(), page = await hit(f.url.pathname + f.url.search), html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain('连接你的 GitHub')
    expect(html).toContain('type="password"')
    const script = html.match(/<script nonce="[a-z0-9]+">([\s\S]+)<\/script>/)![1]!
    expect(() => new Function(script)).not.toThrow()
    expect(page.headers.get('content-security-policy')).toMatch(/script-src 'nonce-.+connect-src 'self'/)
    expect(page.headers.get('referrer-policy')).toBe('no-referrer')
    expect((await f.post()).status).toBe(200)
    expect(JSON.stringify(env.DB.raw.prepare('SELECT * FROM pending').all())).not.toContain(f.token)
    const payload = await (await poll(f.values.state)).json() as { code: string }
    expect(payload.code).toBe(f.code)
    await f.connections.complete(f.values.state!, 'alice', payload.code)
    expect(f.connections.view('alice')).toMatchObject({ status: 'connected', method: 'personal_token', login: 'alice' })
    expect(f.http.mock.calls).toEqual([['/user', { token: f.token }]])
    expect((await f.post()).status).toBe(409)
    expect(await (await hit(f.url.pathname + f.url.search)).text()).toContain('这次配置已提交')
  })
  it('rejects forged keys, wrong origins, plaintext tokens, expired setup and wrong callback routes', async () => {
    const f = setup()
    expect((await f.post({ ...f.values, code: f.token })).status).toBe(400)
    expect((await f.post(undefined, 'https://attacker.test')).status).toBe(403)
    expect((await f.post({ ...f.values, key: 'A'.repeat(392), code: f.code })).status).toBe(400)
    expect((await hit(`/github/callback?state=${f.values.state}&code=not-a-token`)).status).toBe(400)
    expect((await hit(`/github/token?state=${state}&key=${f.values.key}&signature=${f.values.signature}`)).status).toBe(400)
    expect((await hit('/github/token', { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: 'x'.repeat(4097) })).status).toBe(413)
    expect(env.DB.raw.prepare('SELECT count(*) n FROM pending').get()?.n).toBe(0)
  })
})
