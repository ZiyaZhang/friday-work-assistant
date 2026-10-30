import { timingSafeEqual, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../cloudflare/friday-github/src/worker.js'

const BASE = 'https://friday-github.example.workers.dev'
const TOKEN = 'synthetic-independent-relay-token'
const GH = 'Bearer synthetic-current-github-token'
const env = { RELAY_TOKEN: TOKEN, ALLOWED_GIT_REPOS: 'acme-org/acme-harness, Other/Repo' }
const compare = vi.fn((a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b)))
let upstream: ReturnType<typeof vi.fn>
beforeEach(() => {
  compare.mockClear()
  // Workers extends SubtleCrypto with a native timing-safe comparison. Node's
  // equivalent is only a test adapter; all digest operations use real WebCrypto.
  vi.stubGlobal('crypto', { subtle: { digest: webcrypto.subtle.digest.bind(webcrypto.subtle), timingSafeEqual: compare } })
  upstream = vi.fn(async () => new Response('synthetic upstream', { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', upstream)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (!headers.has('x-friday-relay-token')) headers.set('x-friday-relay-token', TOKEN)
  return new Request(BASE + path, { ...init, headers })
}
const hit = (path: string, init: RequestInit = {}, bindings = env) => worker.fetch(request(path, init), bindings)

describe('GitHub Worker relay authorization and fixed destinations', () => {
  it('only allows bounded repository-scoped personal discovery with the hosted credential', async () => {
    const hosted = { ...env, GITHUB_CREDENTIAL_MODE: 'worker', GITHUB_READ_TOKEN: 'synthetic-hosted-pat' }
    const path = (q: string) => `/api/search/issues?${new URLSearchParams({ q, sort: 'updated', order: 'desc', per_page: '50' })}`
    const query = 'is:open is:pr review-requested:alice repo:acme-org/acme-harness'
    expect((await hit(path(query), {}, hosted)).status).toBe(200)
    expect(upstream.mock.calls.at(-1)![1].headers.get('authorization')).toBe('Bearer synthetic-hosted-pat')
    const before = upstream.mock.calls.length
    for (const q of ['is:open', query + ' OR repo:evil/private', query.replace('acme-org/acme-harness', 'evil/private')])
      expect((await hit(path(q), {}, hosted)).status).toBe(403)
    for (const p of [path(query) + '&q=repo:evil/private', path(query) + '&page=2', path(query).replace('per_page=50', 'per_page=100')])
      expect((await hit(p, {}, hosted)).status).toBe(403)
    expect((await hit(path(query), { method: 'POST', body: '{}' }, hosted)).status).toBe(403)
    expect(upstream).toHaveBeenCalledTimes(before)
  })
  it('uses the hosted credential for full-token API writes and Git push, overriding an old host PAT', async () => {
    const hosted = { ...env, GITHUB_CREDENTIAL_MODE: 'worker', GITHUB_READ_TOKEN: 'synthetic-new-write-pat', RELAY_READ_TOKEN: 'separate-read-only-token' }
    const paths = ['/api/repos/acme-org/acme-harness/pulls', '/git/acme-org/acme-harness.git/git-receive-pack']
    for (const path of paths) {
      const response = await hit(path, { method: 'POST', body: '{}', headers: { authorization: GH } }, hosted)
      expect(response.status).toBe(200)
      const headers = upstream.mock.calls.at(-1)![1].headers as Headers
      expect(headers.get('authorization')).toBe(path.startsWith('/git/')
        ? `Basic ${Buffer.from('x-access-token:synthetic-new-write-pat').toString('base64')}` : 'Bearer synthetic-new-write-pat')
      expect(headers.has('x-friday-relay-token')).toBe(false)
      expect(await response.text()).not.toContain(hosted.GITHUB_READ_TOKEN)
    }
    const before = upstream.mock.calls.length
    for (const path of paths) expect((await hit(path, { method: 'POST', body: '{}', headers: { 'x-friday-relay-token': hosted.RELAY_READ_TOKEN } }, hosted)).status).toBe(403)
    for (const path of ['/api/repos/evil/repo/pulls', '/api/graphql', '/api/user/emails', '/git/evil/repo.git/git-receive-pack']) {
      expect((await hit(path, { method: 'POST', body: '{}' }, hosted)).status).toBe(403)
    }
    expect(upstream).toHaveBeenCalledTimes(before)
  })

  it('requires a configured hosted PAT, keeps read-token fetch read-only and fails closed on equal relay secrets', async () => {
    const hosted = { ...env, GITHUB_CREDENTIAL_MODE: 'worker', GITHUB_READ_TOKEN: 'synthetic-new-pat', RELAY_READ_TOKEN: 'separate-read-only-token' }
    expect((await hit('/api/user', {}, { ...hosted, GITHUB_READ_TOKEN: '' })).status).toBe(503)
    expect((await hit('/api/user', {}, { ...hosted, RELAY_READ_TOKEN: TOKEN })).status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
    expect((await hit('/git/acme-org/acme-harness.git/info/refs?service=git-upload-pack',
      { headers: { 'x-friday-relay-token': hosted.RELAY_READ_TOKEN } }, hosted)).status).toBe(200)
    expect(upstream.mock.calls.at(-1)![1].headers.get('authorization')).toBe(`Basic ${Buffer.from('x-access-token:synthetic-new-pat').toString('base64')}`)
    const count = upstream.mock.calls.length
    expect((await hit('/git/acme-org/acme-harness.git/info/refs?service=git-receive-pack',
      { headers: { 'x-friday-relay-token': hosted.RELAY_READ_TOKEN } }, hosted)).status).toBe(403)
    expect(upstream).toHaveBeenCalledTimes(count)
  })

  it('exposes only generic public health metadata and constant-time authenticates every forwarding path', async () => {
    const health = await worker.fetch(new Request(BASE + '/health'), {})
    expect(await health.json()).toEqual({ ok: true, version: 'github-relay-v1' })
    expect(health.headers.get('cache-control')).toBe('no-store'); expect(compare).not.toHaveBeenCalled()
    for (const token of ['', 'wrong', `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const response = await hit('/api/user', { headers: { 'x-friday-relay-token': token, authorization: GH } })
      expect(response.status).toBe(401); expect(await response.text()).not.toContain(TOKEN)
    }
    expect((await worker.fetch(new Request(BASE + '/api/user'), env)).status).toBe(401)
    expect((await hit('/api/user', {}, { ...env, RELAY_TOKEN: '' })).status).toBe(401)
    expect((await worker.fetch(new Request(BASE + '/unknown'), env)).status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
    expect(compare.mock.calls.every(([a, b]) => a.byteLength === 32 && b.byteLength === 32)).toBe(true)
  })

  it('keeps REST/GraphQL method, exact query and current GitHub token while stripping all unapproved headers', async () => {
    const response = await hit('/api/repos/Owner/Repo/issues?state=open&labels=a%2Cb', { headers: {
      authorization: GH, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Friday-Test',
      cookie: 'secret-cookie', 'x-forwarded-host': 'evil.example', 'x-forwarded-for': 'private-ip', referer: 'https://internal.example/secret',
      origin: 'https://internal.example', host: 'evil.example', 'x-private-secret': 'private', 'proxy-authorization': 'proxy-secret',
    } })
    expect(response.status).toBe(200)
    const [target, init] = upstream.mock.calls[0]!
    expect(String(target)).toBe('https://api.github.com/repos/Owner/Repo/issues?state=open&labels=a%2Cb')
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', cache: 'no-store' })
    expect(Object.fromEntries(init.headers)).toEqual({ accept: 'application/vnd.github+json', authorization: GH,
      'cache-control': 'no-store', 'user-agent': 'Friday-Test', 'x-github-api-version': '2022-11-28' })
    await hit('/api/graphql', { method: 'POST', body: '{"query":"synthetic"}', headers: { authorization: 'Bearer second-current-token', 'content-type': 'application/json' } })
    expect(String(upstream.mock.calls[1]![0])).toBe('https://api.github.com/graphql')
    expect(upstream.mock.calls[1]![1].headers.get('authorization')).toBe('Bearer second-current-token')
    await hit('/api/rate_limit')
    expect(upstream.mock.calls[2]![1].headers.has('authorization')).toBe(false)
  })

  it('cannot convert API paths or query values into a different upstream origin', async () => {
    for (const path of ['/api//evil.example/private', '/api/https://evil.example/private', '/api/%2F%2Fevil.example/private', '/api/user?url=https%3A%2F%2Fevil.example&target=localhost']) {
      expect((await hit(path)).status).toBe(200)
      expect(new URL(String(upstream.mock.lastCall![0])).origin).toBe('https://api.github.com')
    }
    for (const path of ['/proxy?url=https://evil.example', '/https://evil.example', '/api', '/']) expect((await hit(path)).status).toBe(404)
    expect(upstream).toHaveBeenCalledTimes(4)
  })

  it.each(['git-upload-pack', 'git-receive-pack'])('accepts only the allowlisted smart HTTP discovery and %s exchange', async service => {
    expect((await hit(`/git/ACME-ORG/Acme-Harness.git/info/refs?service=${service}`, { headers: { authorization: GH, 'git-protocol': 'version=2' } })).status).toBe(200)
    expect(String(upstream.mock.calls[0]![0])).toBe(`https://github.com/ACME-ORG/Acme-Harness.git/info/refs?service=${service}`)
    expect(upstream.mock.calls[0]![1].headers.get('git-protocol')).toBe('version=2')
    expect((await hit(`/git/acme-org/acme-harness.git/${service}`, { method: 'POST', body: new Uint8Array([0, 1, 255]),
      headers: { authorization: GH, 'content-type': `application/x-${service}-request` } })).status).toBe(200)
    expect(String(upstream.mock.calls[1]![0])).toBe(`https://github.com/acme-org/acme-harness.git/${service}`)
    expect(upstream.mock.calls[1]![1]).toMatchObject({ method: 'POST', redirect: 'manual' })
  })

  it('rejects other repositories, encoded/alternate Git paths, service injection and malformed allowlists', async () => {
    for (const path of [
      '/git/acme-org/acme-harness-extra.git/info/refs?service=git-upload-pack',
      '/git/other/deepseek-harness.git/info/refs?service=git-upload-pack',
      '/git/deepseek-harness%2fevil/deepseek-harness.git/info/refs?service=git-upload-pack',
      '/git/acme-org/acme-harness.git/objects/info/packs',
      '/git/acme-org/acme-harness.git/info/refs?service=git-upload-pack&url=https://evil.example',
      '/git/acme-org/acme-harness.git/info/refs?service=git-upload-pack&service=git-receive-pack',
      '/git/acme-org/acme-harness.git/info/refs?service=not-a-service',
    ]) expect((await hit(path)).status).toBeGreaterThanOrEqual(400)
    expect((await hit('/git/acme-org/acme-harness.git/git-upload-pack')).status).toBe(405)
    expect((await hit('/git/acme-org/acme-harness.git/git-receive-pack?target=other', { method: 'POST', body: 'pack' })).status).toBe(400)
    for (const raw of ['', '*', 'deepseek-harness/*', 'acme-org/acme-harness,invalid']) {
      expect((await hit('/git/acme-org/acme-harness.git/info/refs?service=git-upload-pack', {}, { ...env, ALLOWED_GIT_REPOS: raw })).status).toBe(403)
    }
    expect(upstream).not.toHaveBeenCalled()
  })

  it('streams request and response bytes without waiting for the whole body or changing binary data', async () => {
    let upload!: ReadableStreamDefaultController<Uint8Array>, download!: ReadableStreamDefaultController<Uint8Array>
    const uploadBody = new ReadableStream<Uint8Array>({ start(controller) { upload = controller } })
    const downloadBody = new ReadableStream<Uint8Array>({ start(controller) { download = controller } })
    const incoming = request('/git/acme-org/acme-harness.git/git-receive-pack', { method: 'POST', body: uploadBody,
      duplex: 'half', headers: { authorization: GH, 'content-type': 'application/x-git-receive-pack-request' } } as RequestInit)
    vi.spyOn(incoming, 'arrayBuffer').mockRejectedValue(new Error('must not buffer'))
    vi.spyOn(incoming, 'text').mockRejectedValue(new Error('must not parse'))
    const provider = new Response(downloadBody, { headers: { 'content-type': 'application/x-git-receive-pack-result' } })
    upstream.mockResolvedValueOnce(provider)
    const result = await worker.fetch(incoming, env)
    expect(upstream.mock.calls[0]![1].body).toBe(incoming.body); expect(result.body).toBe(provider.body)
    const sent = upstream.mock.calls[0]![1].body.getReader(), read = result.body!.getReader()
    const bytes = new Uint8Array([0, 255, 128, 10, 13])
    upload.enqueue(bytes); expect((await sent.read()).value).toEqual(bytes)
    download.enqueue(bytes); expect((await read.read()).value).toEqual(bytes)
    upload.close(); download.close(); expect((await sent.read()).done).toBe(true); expect((await read.read()).done).toBe(true)
    expect(incoming.arrayBuffer).not.toHaveBeenCalled(); expect(incoming.text).not.toHaveBeenCalled()
  })

  it('filters response headers and disables caching even when upstream requests caching or sets a cookie', async () => {
    upstream.mockResolvedValueOnce(new Response('body', { status: 403, headers: {
      'content-type': 'application/json', 'content-encoding': 'gzip', etag: 'synthetic-etag', link: '<https://api.github.com/user?page=2>; rel="next"',
      'x-ratelimit-remaining': '0', 'retry-after': '10', 'www-authenticate': 'Basic realm="GitHub"', 'x-github-request-id': 'request-ref',
      'cache-control': 'public, max-age=10000', 'set-cookie': 'secret-cookie', authorization: GH, 'x-friday-relay-token': TOKEN,
      'x-internal-debug': 'secret', location: 'https://evil.example', 'access-control-allow-origin': '*',
    } }))
    const response = await hit('/api/user')
    expect(response.status).toBe(403); expect(response.headers.get('cache-control')).toBe('no-store')
    for (const name of ['content-type', 'content-encoding', 'etag', 'link', 'x-ratelimit-remaining', 'retry-after', 'www-authenticate', 'x-github-request-id']) expect(response.headers.has(name)).toBe(true)
    for (const name of ['set-cookie', 'authorization', 'x-friday-relay-token', 'x-internal-debug', 'location', 'access-control-allow-origin']) expect(response.headers.has(name)).toBe(false)
  })

  it.each([301, 302, 303, 307, 308])('rejects %i without following or exposing its Location or body', async status => {
    const cancelled = vi.fn()
    upstream.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled }), { status,
      headers: { location: 'https://evil.example/private-code', authorization: GH } }))
    const response = await hit('/api/repos/owner/renamed')
    expect(response.status).toBe(502); expect(response.headers.has('location')).toBe(false)
    expect(await response.text()).toBe('{"error":"upstream_redirect_or_protocol_rejected"}')
    expect(cancelled).toHaveBeenCalledOnce(); expect(upstream).toHaveBeenCalledOnce(); expect(upstream.mock.calls[0]![1].redirect).toBe('manual')
  })

  it('preserves bodyless conditional and empty responses', async () => {
    for (const status of [204, 304]) {
      upstream.mockResolvedValueOnce(new Response(null, { status, headers: { etag: 'known' } }))
      const response = await hit('/api/user', { headers: { 'if-none-match': 'known' } })
      expect(response.status).toBe(status); expect(await response.text()).toBe(''); expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('passes the exact incoming signal, cancels an in-flight request and never retries an uncertain write', async () => {
    const controller = new AbortController(), incoming = request('/api/repos/owner/repo/issues', { method: 'POST', body: '{}', signal: controller.signal })
    let entered!: () => void; const started = new Promise<void>(done => { entered = done })
    upstream.mockImplementationOnce(async (_url: URL, init: RequestInit) => {
      entered(); expect(init.signal).toBe(incoming.signal)
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('SYNTHETIC_SECRET_IN_EXCEPTION')), { once: true }))
    })
    const pending = worker.fetch(incoming, env); await started; controller.abort()
    const result = await pending
    expect(result.status).toBe(499); expect(await result.text()).toBe('{"error":"request_cancelled"}'); expect(upstream).toHaveBeenCalledOnce()
    const aborted = new AbortController(); aborted.abort()
    expect((await hit('/api/user', { signal: aborted.signal })).status).toBe(499); expect(upstream).toHaveBeenCalledOnce()
  })

  it('does not log or expose thrown credential-bearing errors and does not retry transport failures', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')]
    upstream.mockRejectedValueOnce(new Error(`network failure ${TOKEN} ${GH}`))
    const response = await hit('/api/repos/owner/repo/pulls', { method: 'POST', body: '{}' })
    expect(response.status).toBe(502); expect(await response.text()).toBe('{"error":"upstream_unavailable"}'); expect(upstream).toHaveBeenCalledOnce()
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })

  it('keeps its own Worker config without databases/logging and enables actual client cancellation flags', () => {
    const config = readFileSync(new URL('../cloudflare/friday-github/wrangler.toml', import.meta.url), 'utf8')
    expect(config).toContain('name = "friday-github"'); expect(config).toContain('workers_dev = true')
    expect(config).toContain('"enable_request_signal"'); expect(config).toContain('"request_signal_passthrough"')
    expect(config).toMatch(/\[observability\]\s*enabled = false/)
    expect(config).not.toMatch(/\[\[d1_databases\]\]|\[\[kv_namespaces\]\]/)
    expect(config).not.toContain(TOKEN); expect(config).not.toContain(GH)
  })
})
