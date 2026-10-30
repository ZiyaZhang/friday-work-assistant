import { createHash, timingSafeEqual, webcrypto } from 'node:crypto'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import axios from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubIdentity, type GitHubConfig, type GitHubHttp } from '../src/github/identity.js'
import { jobLogStorageLocation, JOB_LOG_MAX_BYTES, JOB_LOG_SCAN_BYTES, GitHubJobLogError } from '../src/github/job-log-policy.js'
import { jobLogWindow } from '../src/github/job-log-window.js'
import { searchJobLog } from '../src/github/job-log-search.js'
import { createLogger } from '../src/log.js'
import worker from '../cloudflare/friday-github/src/worker.js'

const GH = 'synthetic-github-token', RELAY = 'synthetic-relay-token-with-at-least-32-chars'
const STORAGE = 'https://fixture.blob.core.windows.net/log/file?sig=SYNTHETIC_SIGNED_URL_SECRET'
const bytes = Buffer.from('setup\ncompile\nTypeError: actionable failure\ncleanup\n')
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const fn of cleanup.splice(0).reverse()) await fn() })
const log = createLogger('job-log-download-test', 'error')
const input = { repo: 'Org/Repo', jobId: 17, maxBytes: 1024, assertCurrent: () => {} }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

/** Real TLS plus a real CONNECT proxy; only local CA trust is injected. The
 * configured public hostnames, request routing and headers remain unchanged. */
async function fixture(relay = false, app = false) {
  const dir = mkdtempSync(join(tmpdir(), 'friday-job-log-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=api.github.com', '-addext', 'subjectAltName=DNS:api.github.com,DNS:fixture.blob.core.windows.net,DNS:relay.example'], { stdio: 'ignore' })
  const requests: Array<{ host: string; path: string; headers: Record<string, unknown> }> = [], tunnels: string[] = [], sockets = new Set<Socket>()
  const entered = deferred(), closed = deferred()
  const state = { firstStatus: 302, location: STORAGE, lastStatus: 206, encoding: '', length: undefined as string | undefined,
    hold: false, stream: false, failure: false, onFirst: () => {}, onLast: () => {}, ignoreRange: false, wrongRange: false, oversize: false }
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    requests.push({ host: req.headers.host!, path: req.url!, headers: { ...req.headers } })
    if (req.url === '/app/installations?per_page=100') { res.end(JSON.stringify([{ id: 22, account: { login: 'Org' } }])); return }
    if (req.url === '/app/installations/22/access_tokens') { res.end(JSON.stringify({ token: GH, expires_at: '2099-01-01T00:00:00Z' })); return }
    if (req.headers.host === 'api.github.com') {
      state.onFirst(); res.writeHead(state.firstStatus, { location: state.location, 'set-cookie': 'secret-cookie' });
      res.end('SECRET_ERROR_BODY'); return
    }
    state.onLast()
    if (state.failure) { req.socket.destroy(); return }
    res.on('close', closed.resolve)
    if (state.hold) { entered.resolve(); return }
    const requested = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''))
    const start = requested ? Number(requested[1]) : req.headers['x-friday-log-start-byte'] !== undefined ? Number(req.headers['x-friday-log-start-byte']) : Math.max(0, bytes.length - Number(req.headers['x-friday-log-max-bytes'] ?? bytes.length))
    const end = Math.min(bytes.length, requested ? Number(requested[2]) + 1 : start + Number(req.headers['x-friday-log-max-bytes'] ?? bytes.length))
    const payload = state.ignoreRange ? bytes : bytes.subarray(start, end)
    res.writeHead(state.ignoreRange ? 200 : state.lastStatus, { 'content-type': 'text/plain', location: STORAGE,
      'content-range': `bytes ${state.wrongRange ? start + 1 : start}-${end - 1}/${bytes.length}`, 'x-friday-log-start-byte': String(start),
      etag: '"fixture-v1"', ...(state.encoding ? { 'content-encoding': state.encoding } : {}),
      ...(state.oversize ? {} : { 'content-length': state.length ?? String(payload.length) }) })
    if (state.stream) { res.write(payload.subarray(0, 1)); entered.resolve(); return }
    res.end(state.oversize ? Buffer.concat([payload, Buffer.from('extra')]) : payload)
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) }))
  const proxy = createHttpServer()
  proxy.on('connect', (req, client, head) => {
    tunnels.push(req.url!); sockets.add(client)
    if (!['api.github.com:443', 'fixture.blob.core.windows.net:443', 'relay.example:443'].includes(req.url!)) { client.destroy(); return }
    const upstream = connect((server.address() as AddressInfo).port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head)
      client.pipe(upstream); upstream.pipe(client)
    })
    sockets.add(upstream); client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy())
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy())
  })
  await new Promise<void>(done => proxy.listen(0, '127.0.0.1', done))
  cleanup.push(() => new Promise<void>(done => { for (const socket of sockets) socket.destroy(); proxy.close(() => done()) }))
  const create = axios.create.bind(axios)
  vi.spyOn(axios, 'create').mockImplementation(options => {
    options!.httpsAgent.options.ca = readFileSync(cert)
    cleanup.push(() => options!.httpsAgent.destroy())
    return create(options)
  })
  const cfg: GitHubConfig = { apiUrl: 'https://api.github.com', token: GH, allowedRepos: ['org/repo'], writableRepos: [],
    proxyUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    ...(relay ? { relay: { url: 'https://relay.example', token: RELAY } } : {}),
    ...(app ? { mode: 'app', appId: '123', installationId: '22', privateKeyPath: key } : {}) }
  const github = new GitHubIdentity(cfg, log)
  return { github, cfg, state, requests, tunnels, entered, closed }
}


describe('fixed-job Actions log transport over the configured company proxy', () => {
  it.each([false, true])('uses the real PAT/App adapter (%s), bounded tail range and no storage credentials', async app => {
    const t = await fixture(false, app), result = await t.github.readActionsJobLog({ ...input, maxBytes: 24 })
    expect(result).toMatchObject({ data: bytes.subarray(bytes.length - 24), startByte: bytes.length - 24, endByte: bytes.length, totalBytes: bytes.length })
    const api = t.requests.find(row => row.path.endsWith('/17/logs'))!, storage = t.requests.filter(row => row.host === 'fixture.blob.core.windows.net')
    expect(api).toMatchObject({ host: 'api.github.com', path: '/repos/Org/Repo/actions/jobs/17/logs', headers: { authorization: `Bearer ${GH}` } })
    expect(storage).toHaveLength(2)
    expect(storage[0]?.headers.range).toBe('bytes=0-0')
    expect(storage[1]?.headers).toMatchObject({ range: `bytes=${bytes.length - 24}-${bytes.length - 1}`, 'if-match': '"fixture-v1"' })
    for (const request of storage) for (const name of ['authorization', 'x-friday-relay-token', 'cookie', 'referer', 'proxy-authorization']) expect(request.headers[name]).toBeUndefined()
    expect(t.tunnels).toContain('fixture.blob.core.windows.net:443')
    expect(JSON.stringify({ ...result, data: undefined })).not.toContain('SIGNED_URL')
    if (app) expect(t.requests.filter(row => row.path.includes('/access_tokens'))).toHaveLength(1)
  })
  it('continues using an explicit byte range rather than downloading all prior output', async () => {
    const t = await fixture(), result = await t.github.readActionsJobLog({ ...input, startByte: 6, maxBytes: 7 })
    expect(result.data.toString()).toBe('compile'); expect(result).toMatchObject({ startByte: 6, endByte: 13 })
    expect(t.requests).toHaveLength(2); expect(t.requests[1]?.headers.range).toBe('bytes=6-12')
  })
  it('uses only the dedicated relay route without a direct fallback', async () => {
    const t = await fixture(true), result = await t.github.readActionsJobLog(input)
    expect(result.data).toEqual(bytes); expect(t.requests).toHaveLength(1)
    expect(t.requests[0]).toMatchObject({ host: 'relay.example', path: '/logs/Org/Repo/17', headers: {
      authorization: `Bearer ${GH}`, 'x-friday-relay-token': RELAY, 'x-friday-log-max-bytes': '1024' } })
    t.state.failure = true
    await expect(t.github.readActionsJobLog(input)).rejects.toMatchObject({ code: 'unavailable' })
    expect(t.requests.every(row => row.host === 'relay.example')).toBe(true)
  })
  it('validates repository, fixed job id and all budgets before network', async () => {
    const t = await fixture()
    for (const bad of [{ repo: 'evil/repo' }, { jobId: 0 }, { jobId: 1.2 }, { repo: 'https://evil.example' },
      { maxBytes: 0 }, { maxBytes: JOB_LOG_SCAN_BYTES + 1 }, { startByte: -1 }, { startByte: Number.MAX_SAFE_INTEGER }]) {
      await expect(t.github.readActionsJobLog({ ...input, ...bad })).rejects.toThrow()
    }
    expect(t.requests).toEqual([])
  })
  it.each([[301, 'redirect_rejected'], [403, 'permission_denied'], [404, 'not_found_or_inaccessible'], [429, 'rate_limited'], [500, 'unavailable']] as const)('keeps first-hop HTTP %i cause without exposing its body or URL', async (firstStatus, code) => {
    const t = await fixture(); t.state.firstStatus = firstStatus
    const error = await t.github.readActionsJobLog(input).catch(error => error)
    expect(error).toMatchObject({ code }); expect(String(error)).not.toMatch(/SECRET|https:|Bearer/); expect(t.requests).toHaveLength(1)
  })
  it('rejects a third redirect even if its target is another official host', async () => {
    const t = await fixture(); t.state.lastStatus = 302
    await expect(t.github.readActionsJobLog(input)).rejects.toMatchObject({ code: 'redirect_rejected' })
    expect(t.requests).toHaveLength(2)
  })
  it('does not pretend ignored ranges are a bounded full log', async () => {
    const t = await fixture(); t.state.ignoreRange = true
    await expect(t.github.readActionsJobLog({ ...input, maxBytes: 5 })).rejects.toMatchObject({ code: 'range_unsupported' })
    const full = await t.github.readActionsJobLog(input)
    expect(full.data).toEqual(bytes); expect(full.totalBytes).toBe(bytes.length)
  })
  it.each(['wrongRange', 'oversize', 'encoding'] as const)('rejects invalid provider %s with no partial success', async mode => {
    const t = await fixture(); if (mode === 'encoding') t.state.encoding = 'gzip'; else t.state[mode] = true
    await expect(t.github.readActionsJobLog({ ...input, startByte: 0, maxBytes: 10 })).rejects.toMatchObject({ code: mode === 'oversize' ? 'too_large' : 'invalid_response' })
  })
  it.each([false, true])('aborts the actual socket before/after headers (%s)', async stream => {
    const t = await fixture(), abort = new AbortController(); t.state.stream = stream; t.state.hold = !stream
    const pending = t.github.readActionsJobLog({ ...input, startByte: 0, signal: abort.signal }), rejected = expect(pending).rejects.toThrow()
    await t.entered.promise; abort.abort(); await rejected; await t.closed.promise
    expect(t.requests).toHaveLength(2)
  })
  it('checks source authority after redirect lookup before any storage fetch', async () => {
    const t = await fixture(); let current = true; t.state.onFirst = () => { current = false }
    await expect(t.github.readActionsJobLog({ ...input, assertCurrent: () => { if (!current) throw new Error('source_revoked') } })).rejects.toThrow('source_revoked')
    expect(t.requests).toHaveLength(1)
  })
  it('rechecks the live read allowlist after storage I/O', async () => {
    const t = await fixture(); t.state.onLast = () => { t.cfg.allowedRepos = ['other/repo'] }
    await expect(t.github.readActionsJobLog(input)).rejects.toMatchObject({ code: 'repository_denied' })
  })
  it('checks both token-await and final adapter-return without fallback', async () => {
    let active = true
    const adapter: GitHubHttp = { request: vi.fn(), readActionsJobLog: vi.fn(async () => {
      active = false; return { data: bytes, startByte: 0, endByte: bytes.length, totalBytes: bytes.length, sha256: 'x' }
    }) }
    const github = new GitHubIdentity({ apiUrl: 'https://api.github.com', token: GH, allowedRepos: ['org/repo'], writableRepos: [] }, log, adapter)
    const request = { ...input, assertCurrent: () => { if (!active) throw new Error('host_stopped') } }
    vi.spyOn(github, 'token').mockImplementationOnce(async () => { active = false; return GH })
    await expect(github.readActionsJobLog(request)).rejects.toThrow('host_stopped'); expect(adapter.readActionsJobLog).not.toHaveBeenCalled()
    active = true; await expect(github.readActionsJobLog(request)).rejects.toThrow('host_stopped')
  })
})

describe('job-log window has truthful byte and line coverage', () => {
  function view(data: Buffer, start = 0, total = data.length, lines = 2, tail = true) {
    return jobLogWindow({ data, startByte: start, endByte: start + data.length, totalBytes: total, sha256: '' }, 64, lines, tail)
  }
  it('defaults to bounded tail lines with exact reusable byte cursors', () => {
    const result = view(bytes)
    expect(result.text).toBe('TypeError: actionable failure\ncleanup\n')
    expect(result).toMatchObject({ lines: 2, truncated: true, complete: false, startByte: 14, endByte: bytes.length, previousStartByte: 0, nextStartByte: null })
    const earlier = view(bytes, 0, bytes.length, 2, false)
    expect(earlier.text).toBe('setup\ncompile\n'); expect(earlier.nextStartByte).toBe(14)
  })
  it('handles a single long line without silently claiming the whole log', () => {
    const result = view(Buffer.from('x'.repeat(64)), 128, 1000)
    expect(result).toMatchObject({ lines: 1, startByte: 128, endByte: 192, complete: false, nextStartByte: 192 })
  })
  it('keeps valid UTF-8 boundaries while preserving absolute byte positions', () => {
    const all = Buffer.from('甲乙丙丁')
    expect(view(all.subarray(1, 8), 1, all.length)).toMatchObject({ text: '乙', startByte: 3, endByte: 6, truncated: true })
    expect(() => view(Buffer.from([0x61, 0xff]), 0, 99)).toThrow('invalid_response')
    expect(() => view(Buffer.from([0x61, 0, 0x62]))).toThrow('invalid_response')
  })
  it('does not call a complete tiny/empty log truncated', () => {
    expect(view(Buffer.from('ok\n'))).toMatchObject({ text: 'ok\n', lines: 1, complete: true, truncated: false })
    expect(view(Buffer.alloc(0))).toMatchObject({ text: '', lines: 0, complete: true })
  })
})

describe('job logs use only the official storage destination grammar', () => {
  it.each(['https://fixture.blob.core.windows.net/log?sig=x', 'https://results-receiver.actions.githubusercontent.com/log'])('accepts %s only after fixed GitHub lookup', value => expect(jobLogStorageLocation(value)).toBe(value))
  it.each(['http://fixture.blob.core.windows.net/a', 'https://fixture.blob.core.windows.net:444/a', 'https://user@fixture.blob.core.windows.net/a',
    'https://fixture.blob.core.windows.net/a#token', 'https://evilblob.core.windows.net/a', 'https://fixture.blob.core.windows.net.evil.test/a',
    'https://a.b.blob.core.windows.net/a', 'https://127.0.0.1/a', '//fixture.blob.core.windows.net/a', 'https://github.com/a',
    'https://fixture.blob.core.windows.net\\@evil.test/a', 'https://fixture.blob.core.windows.net/a\n'])('rejects %s', value => expect(() => jobLogStorageLocation(value)).toThrow())
})

describe('Worker fixed Actions logs protocol', () => {
  function setup() {
    vi.stubGlobal('crypto', { subtle: { digest: webcrypto.subtle.digest.bind(webcrypto.subtle),
      timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(Buffer.from(a), Buffer.from(b)) } })
    const fetcher = vi.fn(async (target: string | URL, opts?: RequestInit): Promise<Response> => {
      const url = String(target)
      if (url.startsWith('https://api.github.com/')) return new Response('SECRET', { status: 302, headers: { location: STORAGE } })
      const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(opts?.headers).get('range') ?? '')!
      const first = Number(range[1]), last = Math.min(Number(range[2]), bytes.length - 1)
      return new Response(bytes.subarray(first, last + 1), { status: 206, headers: {
        'content-range': `bytes ${first}-${last}/${bytes.length}`, 'content-length': String(last - first + 1), etag: '"v1"' } })
    })
    vi.stubGlobal('fetch', fetcher)
    const call = (over: Record<string, string> = {}, signal?: AbortSignal) => worker.fetch(new Request('https://relay.example/logs/Org/Repo/17', {
      headers: { 'x-friday-relay-token': RELAY, authorization: `Bearer ${GH}`, 'x-friday-log-max-bytes': '24', ...over }, signal }), { RELAY_TOKEN: RELAY })
    return { call, fetcher }
  }
  it('authenticates, obtains the exact fixed id, then streams a bounded tail with stripped headers', async () => {
    const t = setup(), result = await t.call()
    expect(result.status).toBe(206); expect(await result.text()).toBe(bytes.subarray(bytes.length - 24).toString())
    expect(result.headers.get('content-range')).toBe(`bytes ${bytes.length - 24}-${bytes.length - 1}/${bytes.length}`)
    expect(result.headers.get('location')).toBeNull(); expect(result.headers.get('cache-control')).toBe('no-store')
    expect(t.fetcher.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/Org/Repo/actions/jobs/17/logs')
    for (const [, options] of t.fetcher.mock.calls.slice(1)) {
      const headers = new Headers(options?.headers)
      for (const key of ['authorization', 'cookie', 'referer', 'x-friday-relay-token']) expect(headers.has(key)).toBe(false)
      expect(options?.redirect).toBe('manual')
    }
  })
  it('does not contact upstream without relay authentication', async () => {
    const t = setup(); expect((await t.call({ 'x-friday-relay-token': 'bad' })).status).toBe(401); expect(t.fetcher).not.toHaveBeenCalled()
  })
  it('validates byte budgets and continuation cursors before network', async () => {
    const t = setup()
    for (const bad of [{ 'x-friday-log-max-bytes': String(JOB_LOG_SCAN_BYTES + 1) }, { 'x-friday-log-start-byte': '-1' }, { 'x-friday-log-start-byte': 'NaN' }]) expect((await t.call(bad)).status).toBe(400)
    expect(t.fetcher).not.toHaveBeenCalled()
  })
  it('never follows untrusted storage or a subsequent redirect and never reflects URLs', async () => {
    const t = setup(); t.fetcher.mockImplementationOnce(async () => new Response('secret', { status: 302, headers: { location: 'https://attacker.test/?secret=x' } }))
    const first = await t.call(); expect(first.status).toBe(502); expect(await first.text()).not.toMatch(/https|secret/)
    expect(t.fetcher).toHaveBeenCalledTimes(1)
    t.fetcher.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: STORAGE } }))
    t.fetcher.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: STORAGE } }))
    expect((await t.call()).status).toBe(502); expect(t.fetcher).toHaveBeenCalledTimes(3)
  })
  it('keeps explicit permission denial as permission, not a fake empty log', async () => {
    const t = setup(); t.fetcher.mockImplementationOnce(async () => new Response('SECRET BODY', { status: 403 }))
    const response = await t.call(); expect(response.status).toBe(403); expect(await response.text()).toBe('{"error":"permission_denied"}')
  })
  it('enforces actual stream bytes and cancellation even after response headers', async () => {
    const t = setup(); t.fetcher.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: STORAGE } }))
    t.fetcher.mockImplementationOnce(async () => new Response(bytes, { status: 206, headers: { 'content-range': `bytes 0-4/${bytes.length}` } }))
    const response = await t.call({ 'x-friday-log-max-bytes': '5', 'x-friday-log-start-byte': '0' })
    await expect(response.text()).rejects.toThrow('job_log_download_failed')
  })
})

describe('bounded literal search finds diagnostic evidence outside the tail', () => {
  function search(data: Buffer, query: string, over: { start?: number; total?: number; maxBytes?: number; lines?: number } = {}) {
    return searchJobLog({ data, startByte: over.start ?? 0, endByte: (over.start ?? 0) + data.length,
      totalBytes: over.total ?? data.length, sha256: '' }, query, over.maxBytes ?? 32768, over.lines ?? 200)
  }
  it('reads a few megabytes once and returns actual middle-log context without claiming all lines were returned', () => {
    const data = Buffer.from('ordinary output\n'.repeat(80_000) + 'before context\nReferenceError: document is not defined\nafter context\n' + 'coverage detail\n'.repeat(80_000))
    const result = search(data, 'ReferenceError')
    expect(result).toMatchObject({ mode: 'search', complete: true, truncated: false, matches: 1, nextStartByte: null,
      searchedThroughByte: data.length, returnedLines: 7 })
    expect(result.windows[0]?.text).toContain('before context\nReferenceError: document is not defined\nafter context')
    expect(result.returnedBytes).toBeLessThan(1000)
    expect(result.windows[0]?.complete).toBe(false)
  })
  it('does not interpret literal regex syntax or silently case-fold', () => {
    const result = search(Buffer.from('ERROR\nerror\n.* literal\n'), '.*')
    expect(result.matches).toBe(1)
    expect(search(Buffer.from('ERROR\n'), 'error')).toMatchObject({ matches: 0, complete: true, windows: [] })
  })
  it('finds a match at byte zero and can show it with a one-line budget', () => {
    const result = search(Buffer.from('failure\nnext\n'), 'failure', { lines: 1 })
    expect(result.windows[0]?.text).toBe('failure\n'); expect(result.matches).toBe(1)
  })
  it('does not turn unscanned bytes into a no-match claim', () => {
    const result = search(Buffer.from('nothing here\n'), 'failure', { total: 9_000_000 })
    expect(result).toMatchObject({ windows: [], complete: false, truncated: true, nextStartByte: 7, searchedThroughByte: 7 })
  })
  it('retains overlap for a literal split across download windows', () => {
    const data = Buffer.from('12345FAI'), first = search(data, 'FAILURE', { total: 20 })
    expect(first.nextStartByte).toBe(2)
    const next = search(Buffer.from('345FAILURE\nend\n'), 'FAILURE', { start: first.nextStartByte! })
    expect(next.matches).toBe(1); expect(next.windows[0]?.text).toContain('FAILURE')
  })
  it('shares output and match budgets and gives a progressing continuation cursor', () => {
    const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => `line ${i} failure\n`).join(''))
    const first = search(data, 'failure', { maxBytes: 100, lines: 4 })
    expect(first.returnedBytes).toBeLessThanOrEqual(100); expect(first.returnedLines).toBeLessThanOrEqual(4)
    expect(first.complete).toBe(false); expect(first.nextStartByte).toBeGreaterThan(0)
    const start = first.nextStartByte!, next = search(data.subarray(start), 'failure', { start, total: data.length, maxBytes: 100, lines: 4 })
    expect(next.windows[0]?.text).toContain('failure'); expect(next.nextStartByte).toBeGreaterThan(start)
  })
  it('keeps the match visible even on a very long line', () => {
    const data = Buffer.from('x'.repeat(2_000_000) + 'important-failure' + 'x'.repeat(1000))
    const result = search(data, 'important-failure', { maxBytes: 100, lines: 1 })
    expect(result.windows[0]?.text).toContain('important-failure'); expect(result.returnedBytes).toBeLessThanOrEqual(100)
  })
  it.each(['', ' ', 'x'.repeat(513)])('rejects invalid query before scanning', query => expect(() => search(bytes, query)).toThrow('invalid_input'))
})

describe('UTF-8 cursors cannot loop on a sub-scalar window', () => {
  it.each([1, 2, 3])('rejects byte budget %i before any download', async maxBytes => {
    const http: GitHubHttp = { request: vi.fn(), readActionsJobLog: vi.fn() }
    const github = new GitHubIdentity({ apiUrl: 'https://api.github.com', token: GH, allowedRepos: ['org/repo'], writableRepos: [] }, log, http)
    await expect(github.readActionsJobLog({ ...input, maxBytes })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(http.readActionsJobLog).not.toHaveBeenCalled()
  })
  it.each(['甲乙', '😀😄', '甲😀乙'])('advances through %s using four-byte windows without dropping scalars', value => {
    const full = Buffer.from(value), texts: string[] = []; let at = 0
    for (let count = 0; at < full.length && count < 20; count++) {
      const data = full.subarray(at, at + 4)
      const window = jobLogWindow({ data, startByte: at, endByte: at + data.length, totalBytes: full.length, sha256: '' }, 4, 200, false)
      texts.push(window.text)
      const next = window.nextStartByte ?? full.length; expect(next).toBeGreaterThan(at); at = next
    }
    expect(texts.join('')).toBe(value)
  })
})

describe('a log provider deadline is distinct from caller cancellation', () => {
  it.each(['deadline', 'caller', 'revoked'] as const)('preserves the actual %s cause', async cause => {
    const deadline = new AbortController(), caller = new AbortController(), entered = deferred()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    let current = true
    const github = new GitHubIdentity({ apiUrl: 'https://api.github.com', token: GH, allowedRepos: ['org/repo'], writableRepos: [] }, log, {
      request: vi.fn(), readActionsJobLog: request => new Promise((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }); entered.resolve()
      }),
    })
    const result = github.readActionsJobLog({ ...input, signal: caller.signal, assertCurrent() { if (!current) throw new Error('source_revoked') } })
    const rejected = cause === 'deadline' ? expect(result).rejects.toMatchObject({ code: 'unavailable' })
      : expect(result).rejects.toThrow(cause === 'caller' ? 'user_stopped' : 'source_revoked')
    await entered.promise
    if (cause === 'caller') caller.abort(new Error('user_stopped'))
    else { if (cause === 'revoked') current = false; deadline.abort(new DOMException('Deadline expired', 'TimeoutError')) }
    await rejected
  })
  it('does not swallow an unrelated adapter programming error', async () => {
    const error = new Error('synthetic programming defect')
    const github = new GitHubIdentity({ apiUrl: 'https://api.github.com', token: GH, allowedRepos: ['org/repo'], writableRepos: [] }, log, {
      request: vi.fn(), readActionsJobLog: async () => { throw error },
    })
    await expect(github.readActionsJobLog(input)).rejects.toBe(error)
  })
})
