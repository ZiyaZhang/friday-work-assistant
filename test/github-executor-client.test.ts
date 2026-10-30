import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecutorClient, ExecutorClientError, type ExecutorClientErrorCode, type ExecutorJobInput,
  type ExecutorJobReceipt, type ExecutorTransportRequest } from '../src/github/executor-client.js'
import { JobController, type JobStore } from '../cloudflare/friday-executor/src/job-controller.js'
import { validateJobInput, payloadDigest, type JobInput } from '../cloudflare/friday-executor/src/job-protocol.js'

const SECRET = 'synthetic-executor-secret-for-local-tests-only'
const JOB = 'friday-job-1234567890', ORIGIN = 'https://executor.example.test'
const input: ExecutorJobInput = { repo: 'org/demo', baseSha: 'a'.repeat(40), inputTree: 'b'.repeat(40),
  patch: 'diff --git a/a.txt b/a.txt\n', command: 'npm test', timeoutMs: 60_000 }
const noChange = () => {}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function queued(id = JOB, spec = input): ExecutorJobReceipt {
  return { version: 1, id, digest: createHash('sha256').update(JSON.stringify(spec)).digest('hex'),
    state: 'queued', outcome: null, createdAt: 100, startedAt: null, finishedAt: null, deadline: null, cleanup: 'not_started', result: null }
}
function finished(status: NonNullable<ExecutorJobReceipt['result']>['status'] = 'passed'): ExecutorJobReceipt {
  return { ...queued(), state: 'finished', outcome: status, startedAt: 100, deadline: 60_100, finishedAt: 120, cleanup: 'confirmed',
    result: { status, phase: 'command', beforeTree: input.inputTree, afterTree: input.inputTree, exitCode: 0,
      output: { stdout: 'tests passed\n', stderr: '', truncated: false }, runtime: 'node20' } }
}
function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
}
async function rejected(pending: Promise<unknown>, code: ExecutorClientErrorCode, result: ExecutorClientError['result']) {
  const error = await pending.then(() => undefined, error => error)
  expect(error).toBeInstanceOf(ExecutorClientError)
  expect(error).toMatchObject({ code, result })
  expect(String(error)).not.toContain(SECRET)
  expect(JSON.stringify(error)).not.toContain(SECRET)
  return error as ExecutorClientError
}

async function fixture(handler?: (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void> | void,
  requestTimeoutMs = 1000, baseUrl = ORIGIN) {
  const prefix = new URL(baseUrl).pathname.replace(/\/$/, '')
  const actual: { method: string; path: string; authorization: string | undefined; body: string }[] = []
  const controllers = new Map<string, JobController>()
  const controller = (id: string) => {
    let existing = controllers.get(id)
    if (!existing) {
      let receipt: ExecutorJobReceipt | undefined, saved: JobInput | undefined
      const store: JobStore = { async load() { return receipt && structuredClone(receipt) },
        async input() { return saved && structuredClone(saved) },
        async save(next, spec) { receipt = structuredClone(next); if (spec !== undefined) saved = spec === null ? undefined : structuredClone(spec) },
        async alarm() {} }
      existing = new JobController(id, store, { async run() { throw new Error('No command execution in this protocol test') }, async destroy() {} }, () => 100)
      controllers.set(id, existing)
    }
    return existing
  }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    try {
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString('utf8')
      actual.push({ method: req.method!, path: req.url!, authorization: req.headers.authorization, body })
      if (handler) { await handler(req, res, body); return }
      if (req.headers.authorization !== `Bearer ${SECRET}`) { json(res, { error: 'unauthorized' }, 401); return }
      if (!req.url!.startsWith(`${prefix}/jobs/`)) { json(res, { error: 'wrong_mount' }, 404); return }
      const match = /^\/jobs\/([a-z0-9-]+)(\/stop)?$/.exec(req.url!.slice(prefix.length))!
      const job = controller(match[1]!)
      if (req.method === 'GET') { const receipt = await job.read(); json(res, receipt ?? { error: 'unknown_job' }, receipt ? 200 : 404) }
      else if (match[2]) json(res, await job.stop())
      else { const spec = validateJobInput(JSON.parse(body), ['org/demo']); json(res, await job.submit(spec, await payloadDigest(spec)), 202) }
    } catch { if (!res.destroyed) json(res, { error: 'synthetic_handler_failure' }, 503) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const sent: ExecutorTransportRequest[] = []
  // Explicit fixture transport is the only HTTP path. Production configuration
  // remains HTTPS even here, and no global fetch/proxy/TLS setting is replaced.
  const client = new ExecutorClient({ baseUrl, secret: SECRET, requestTimeoutMs }, async request => {
    sent.push(request)
    expect(request.redirect).toBe('error')
    const url = new URL(request.url)
    expect(url.origin).toBe(ORIGIN)
    return fetch(local + url.pathname, { method: request.method, body: request.body, headers: request.headers,
      signal: request.signal, redirect: 'manual' })
  })
  return { client, actual, sent, controller }
}

describe('gateway executor client (real local HTTP, versioned provider receipts)', () => {
  it('submits the immutable six-field spec, reads the same job, and stops it without exposing the credential', async () => {
    const t = await fixture(), spec = { ...input }
    const pending = t.client.submit(JOB, spec, noChange)
    spec.command = 'mutated after submission'
    const admitted = await pending
    expect(admitted).toMatchObject({ id: JOB, state: 'queued', digest: queued().digest })
    expect(await t.client.read(JOB, noChange)).toEqual(admitted)
    expect(await t.client.stop(JOB, noChange)).toMatchObject({ id: JOB, state: 'finished', outcome: 'cancelled', cleanup: 'confirmed' })
    expect(t.actual.map(call => [call.method, call.path])).toEqual([
      ['POST', `/jobs/${JOB}`], ['GET', `/jobs/${JOB}`], ['POST', `/jobs/${JOB}/stop`],
    ])
    expect(JSON.parse(t.actual[0]!.body)).toEqual(input)
    expect(t.actual.every(call => call.authorization === `Bearer ${SECRET}`)).toBe(true)
    expect(JSON.stringify(admitted)).not.toContain(SECRET)
    expect(t.actual.every(call => !call.path.includes(SECRET) && !call.body.includes(SECRET))).toBe(true)
  })

  it('rejects invalid origins, secrets, timeout and proxy configuration before making a request', () => {
    for (const baseUrl of ['http://127.0.0.1:1234', 'https://user:pass@example.test',
      'https://example.test/?token=x', 'https://example.test/#fragment', 'file:///tmp/x']) {
      expect(() => new ExecutorClient({ baseUrl, secret: SECRET })).toThrowError(ExecutorClientError)
    }
    for (const secret of ['', 'short', `${SECRET}\r\nheader: value`, `${SECRET} `]) {
      expect(() => new ExecutorClient({ baseUrl: ORIGIN, secret })).toThrowError(ExecutorClientError)
    }
    for (const requestTimeoutMs of [0, -1, 30_001, NaN, 1.5]) {
      expect(() => new ExecutorClient({ baseUrl: ORIGIN, secret: SECRET, requestTimeoutMs })).toThrowError(ExecutorClientError)
    }
    const proxyBefore = [process.env.HTTP_PROXY, process.env.HTTPS_PROXY, process.env.NO_PROXY]
    expect(() => new ExecutorClient({ baseUrl: ORIGIN, secret: SECRET, proxyUrl: 'socks5://localhost:9' })).toThrowError(ExecutorClientError)
    new ExecutorClient({ baseUrl: ORIGIN, secret: SECRET, proxyUrl: 'http://localhost:3128' })
    expect([process.env.HTTP_PROXY, process.env.HTTPS_PROXY, process.env.NO_PROXY]).toEqual(proxyBefore)
  })

  it.each(['', '/', '/friday-executor', '/friday-executor/', '/services/friday-executor/v1/'])(
    'keeps all three authenticated RPCs inside the fixed HTTPS mount %s', async path => {
      const prefix = path.replace(/\/$/, ''), t = await fixture(undefined, 1000, ORIGIN + path)
      expect(await t.client.submit(JOB, input, noChange)).toEqual(queued())
      expect(await t.client.read(JOB, noChange)).toEqual(queued())
      expect(await t.client.stop(JOB, noChange)).toMatchObject({ id: JOB, outcome: 'cancelled', cleanup: 'confirmed' })
      expect(t.actual.map(call => [call.method, call.path])).toEqual([
        ['POST', `${prefix}/jobs/${JOB}`], ['GET', `${prefix}/jobs/${JOB}`], ['POST', `${prefix}/jobs/${JOB}/stop`],
      ])
      expect(t.sent.every(call => new URL(call.url).origin === ORIGIN && call.redirect === 'error')).toBe(true)
      expect(t.actual.every(call => call.authorization === `Bearer ${SECRET}`)).toBe(true)
      expect(t.actual.every(call => !call.path.includes(SECRET) && !call.body.includes(SECRET))).toBe(true)
    })

  it.each([
    '/friday-executor/../other', '/friday-executor/./', '/friday-executor//nested', '//other',
    '/friday-executor/%2e%2e/other', '/friday-executor/%2Fother', '/friday-executor/%252e%252e',
    '/friday-executor/%3fsecret', '/friday-executor/%00', '/friday-executor\\..\\other',
    '/friday-executor/?', '/friday-executor/#', '/friday-executor/\nother',
  ])('rejects an ambiguous or escaping configured path before transport: %j', path => {
    let calls = 0
    expect(() => new ExecutorClient({ baseUrl: ORIGIN + path, secret: SECRET }, async () => {
      calls++; return Response.json(queued())
    })).toThrowError(ExecutorClientError)
    expect(calls).toBe(0)
  })

  it('does not follow redirects out of a prefix or accept job-id traversal within it', async () => {
    const t = await fixture((_req, res) => { res.writeHead(307, { location: `${ORIGIN}/jobs/${JOB}` }); res.end() },
      1000, `${ORIGIN}/friday-executor/`)
    for (const id of [`../${JOB}`, `${JOB}/stop`, `${JOB}%2fstop`, `${JOB}?x=1`]) {
      await rejected(t.client.read(id, noChange), 'invalid_request', 'not_sent')
    }
    expect(t.actual).toEqual([])
    await rejected(t.client.submit(JOB, input, noChange), 'redirect_denied', 'unknown')
    expect(t.actual.map(call => call.path)).toEqual([`/friday-executor/jobs/${JOB}`])
    expect(t.sent).toHaveLength(1)
  })

  it('rejects job path injection and malformed/oversized inputs before HTTP', async () => {
    const t = await fixture()
    for (const id of ['', 'short', `../${JOB}`, `${JOB}/stop`, `${JOB}?x=1`, `${JOB}#x`, 'A'.repeat(32), 'a'.repeat(81)]) {
      await rejected(t.client.read(id, noChange), 'invalid_request', 'not_sent')
    }
    for (const patch of [{ repo: 'org/../x' }, { repo: 'org/demo.git' }, { baseSha: 'main' }, { inputTree: 'bad' },
      { command: '' }, { command: 'x\0y' }, { command: 'x'.repeat(16 * 1024 + 1) }, { patch: 'x'.repeat(2 * 1024 * 1024 + 1) },
      { patch: '\0'.repeat(400_000) }, { timeoutMs: 999 }, { timeoutMs: 12 * 60_000 + 1 }, { token: SECRET }]) {
      await rejected(Promise.resolve().then(() => t.client.submit(JOB, { ...input, ...patch }, noChange)), 'invalid_request', 'not_sent')
    }
    expect(t.actual).toEqual([])
  })

  it('retains an accepted POST as unknown after socket loss and only reads the original id to recover', async () => {
    let accepted: ExecutorJobReceipt | undefined
    const t = await fixture((req, res) => {
      if (req.method === 'POST') { accepted = queued(); res.destroy(); return }
      json(res, accepted)
    })
    await rejected(t.client.submit(JOB, input, noChange), 'network_error', 'unknown')
    expect(t.actual).toHaveLength(1)
    expect(await t.client.read(JOB, noChange)).toEqual(accepted)
    expect(t.actual.map(call => call.method)).toEqual(['POST', 'GET'])
  })

  it.each([
    [401, 'unauthorized', 'rejected'], [403, 'forbidden', 'rejected'], [409, 'conflict', 'rejected'],
    [503, 'unavailable', 'unknown'], [429, 'unavailable', 'unknown'], [400, 'rejected', 'rejected'],
  ] as const)('distinguishes HTTP %s without copying its error body or retrying', async (status, code, outcome) => {
    const t = await fixture((_req, res) => json(res, { error: `remote error ${SECRET}`, stack: 'raw provider stack' }, status))
    const error = await rejected(t.client.submit(JOB, input, noChange), code, outcome)
    expect(error.status).toBe(status); expect(String(error)).not.toContain('raw provider')
    expect(t.actual).toHaveLength(1)
  })

  it('returns a typed absent read and blocks redirect targets without forwarding any credentials', async () => {
    const absent = await fixture()
    await rejected(absent.client.read(JOB, noChange), 'not_found', 'read_failed')
    const t = await fixture((_req, res) => { res.writeHead(302, { location: 'https://attacker.invalid/collect' }); res.end() })
    await rejected(t.client.submit(JOB, input, noChange), 'redirect_denied', 'unknown')
    expect(t.sent).toHaveLength(1); expect(t.actual).toHaveLength(1)
  })

  it('does not interpret a late accepted response as new authority after the source guard changes', async () => {
    let current = true
    const t = await fixture((req, res) => { if (req.method === 'POST') current = false; json(res, queued(), 202) })
    const guard = () => { if (!current) throw new Error(`private authority diagnostic ${SECRET}`) }
    await rejected(t.client.submit(JOB, input, guard), 'authorization_changed', 'unknown')
    expect(t.actual).toHaveLength(1)
    current = true
    expect((await t.client.read(JOB, guard)).id).toBe(JOB)
  })

  it('rechecks the guard after body chunks, not merely after HTTP headers', async () => {
    let current = true, pulled = false
    const client = new ExecutorClient({ baseUrl: ORIGIN, secret: SECRET }, async () => new Response(new ReadableStream({
      pull(controller) {
        pulled = true
        controller.enqueue(new TextEncoder().encode(JSON.stringify(queued())))
        current = false; controller.close()
      },
    }, { highWaterMark: 0 }), { status: 202 }))
    await rejected(client.submit(JOB, input, () => { if (!current) throw new Error('revoked') }), 'authorization_changed', 'unknown')
    expect(pulled).toBe(true)
  })

  it('keeps a remotely accepted stop unknown when its caller cancels, then permits a separate read of its tombstone', async () => {
    const received = deferred(), release = deferred(), abort = new AbortController()
    const stopped: ExecutorJobReceipt = { ...queued(), digest: null, state: 'finished', outcome: 'cancelled', cleanup: 'confirmed', finishedAt: 110 }
    const t = await fixture(async (req, res) => {
      if (req.method === 'POST') { received.resolve(); await release.promise }
      json(res, stopped)
    })
    const pending = rejected(t.client.stop(JOB, noChange, abort.signal), 'cancelled', 'unknown')
    await received.promise; abort.abort(); await pending; release.resolve()
    expect((await t.client.read(JOB, noChange)).outcome).toBe('cancelled')
    expect(t.actual.filter(call => call.method === 'POST')).toHaveLength(1)
    const early = new AbortController(); early.abort(new Error(SECRET))
    await rejected(t.client.submit(JOB, input, noChange, early.signal), 'cancelled', 'not_sent')
    await rejected(t.client.stop(JOB, () => { throw new Error(SECRET) }), 'authorization_changed', 'not_sent')
    expect(t.actual).toHaveLength(2)
  })

  it.each(['headers', 'body'] as const)('bounds the entire %s wait and does not retry a timed-out submission', async mode => {
    const t = await fixture((_req, res) => { if (mode === 'body') { res.writeHead(202); res.write('{') } }, 50)
    await rejected(t.client.submit(JOB, input, noChange), 'timeout', 'unknown')
    expect(t.actual).toHaveLength(1)
  })

  it('bounds an explicit test transport that ignores AbortSignal and discards its late ACK', async () => {
    const pending = deferred<Response>(); let count = 0
    const client = new ExecutorClient({ baseUrl: ORIGIN, secret: SECRET, requestTimeoutMs: 20 }, async () => { count++; return pending.promise })
    await rejected(client.submit(JOB, input, noChange), 'timeout', 'unknown')
    pending.resolve(Response.json(queued()))
    expect(count).toBe(1)
  })

  it.each(['declared', 'chunked', 'stdout'] as const)('rejects oversized %s output without truncating it into a passed receipt', async mode => {
    const t = await fixture((_req, res) => {
      if (mode === 'declared') { res.writeHead(200, { 'content-length': String(2 * 1024 * 1024) }); res.end('{}') }
      else if (mode === 'chunked') { res.writeHead(200); res.write('x'.repeat(700_000)); res.end('y'.repeat(700_000)) }
      else { const receipt = finished(); receipt.result!.output.stdout = 'x'.repeat(64 * 1024 + 1); json(res, receipt) }
    })
    await rejected(t.client.read(JOB, noChange), 'output_limit', 'read_failed')
  })

  it('keeps a real output-limit receipt and source-changed result distinct from a fully verified passed result', async () => {
    let response = finished('output_limit'); response.result!.output.truncated = true
    const t = await fixture((_req, res) => json(res, response))
    expect(await t.client.read(JOB, noChange)).toMatchObject({ outcome: 'output_limit', result: { output: { truncated: true } } })
    response = finished('source_changed'); response.result!.afterTree = 'c'.repeat(40)
    expect(await t.client.read(JOB, noChange)).toMatchObject({ outcome: 'source_changed', result: { afterTree: 'c'.repeat(40) } })
    response = finished()
    expect(await t.client.read(JOB, noChange)).toEqual(response)
    response.result!.output.truncated = true
    await rejected(t.client.read(JOB, noChange), 'invalid_response', 'read_failed')
  })

  it('validates receipt identity, immutable payload digest and state invariants instead of trusting HTTP success', async () => {
    let response: unknown = queued('another-job-1234567890')
    const t = await fixture((_req, res) => json(res, response))
    await rejected(t.client.submit(JOB, input, noChange), 'invalid_response', 'unknown')
    response = { ...queued(), digest: 'e'.repeat(64) }
    await rejected(t.client.submit(JOB, input, noChange), 'invalid_response', 'unknown')
    response = { ...finished(), cleanup: 'pending' }
    await rejected(t.client.read(JOB, noChange), 'invalid_response', 'read_failed')
    const contradictory = finished(); contradictory.result!.afterTree = 'd'.repeat(40); response = contradictory
    await rejected(t.client.read(JOB, noChange), 'invalid_response', 'read_failed')
    response = { ...queued(), token: SECRET, stack: `internal ${SECRET}` }
    expect(await t.client.read(JOB, noChange)).toEqual(queued())
    const leaked = finished(); leaked.result!.output.stderr = SECRET; response = leaked
    await rejected(t.client.read(JOB, noChange), 'invalid_response', 'read_failed')
  })

  it('rejects invalid JSON/encoding and never exposes raw transport exceptions', async () => {
    const invalid = await fixture((_req, res) => res.end(Buffer.from([0xff, 0xfe])))
    await rejected(invalid.client.read(JOB, noChange), 'invalid_response', 'read_failed')
    const client = new ExecutorClient({ baseUrl: ORIGIN, secret: SECRET }, async () => { throw new Error(`https://user:${SECRET}@proxy.invalid/raw`) })
    const error = await rejected(client.submit(JOB, input, noChange), 'network_error', 'unknown')
    expect(error).not.toHaveProperty('cause'); expect(String(error)).not.toContain('proxy.invalid')
  })
})
