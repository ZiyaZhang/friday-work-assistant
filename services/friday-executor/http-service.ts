import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { JobController, type JobExecutor, type OutputArtifact } from '../../cloudflare/friday-executor/src/job-controller.js'
import { JobProtocolError, MAX_REQUEST_BYTES, payloadDigest, validateJobInput } from '../../cloudflare/friday-executor/src/job-protocol.js'
import { SqliteJobStores } from './sqlite-job-store.js'

export interface ExecutorHttpServiceOptions {
  db: DatabaseSync
  token: string
  allowedRepos: readonly string[]
  createExecutor(jobId: string): JobExecutor
  isReady(): boolean | Promise<boolean>
  capacity?: number
  now?: () => number
  /** Protocol 2: accept `capture` and serve stored artifacts. Off keeps protocol 1 exactly. */
  capture?: boolean
  /** Returns the stored artifact bytes, undefined when gone; throws when they do not match. */
  readOutput?(jobId: string, artifact: OutputArtifact): Promise<Buffer | undefined>
}

/** Owns one controller per job and the durable provider alarms. The caller owns
 * the loopback HTTP listener, service-account isolation and database lifetime.
 * Run recover() before listening. A closed/aborted HTTP request never stops an
 * admitted job: only its persisted deadline or the explicit stop route does. */
export function createExecutorHttpService(options: ExecutorHttpServiceOptions) {
  const { db, createExecutor } = options, now = options.now ?? Date.now, capacity = options.capacity ?? 1
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('invalid_executor_capacity')
  if (typeof options.token !== 'string' || options.token.length < 32 || options.token.length > 4096 || /[^\x21-\x7e]/.test(options.token)) {
    throw new Error('invalid_executor_token')
  }
  const expectedAuthorization = hash(`Bearer ${options.token}`), allowedRepos = [...options.allowedRepos]
  const capture = options.capture === true
  if (capture && typeof options.readOutput !== 'function') throw new Error('invalid_executor_output_store')
  const controllers = new Map<string, JobController>(), timers = new Map<string, ReturnType<typeof setTimeout>>()
  const alarms = new Set<string>(), claims = new Set<string>(), effects = new Map<string, number>(), requests = new Set<Promise<void>>()
  let recovered = false, closing = false, admission: Promise<unknown> = Promise.resolve(), recovery: Promise<void> | undefined
  const stores = new SqliteJobStores(db, schedule)

  function serial<T>(use: () => Promise<T>): Promise<T> {
    const pending = admission.then(use)
    admission = pending.catch(() => {})
    return pending
  }
  async function effect<T>(id: string, use: () => Promise<T>): Promise<T> {
    effects.set(id, (effects.get(id) ?? 0) + 1)
    try { return await use() }
    finally {
      const remaining = effects.get(id)! - 1
      if (remaining) effects.set(id, remaining); else effects.delete(id)
    }
  }
  function controller(id: string): JobController {
    let existing = controllers.get(id)
    if (!existing) {
      // Reads and early stop tombstones need no Docker/provider initialization.
      let executor: JobExecutor | undefined
      const getExecutor = () => executor ??= createExecutor(id)
      existing = new JobController(id, stores.forJob(id), {
        run: (input, check) => effect(id, () => getExecutor().run(input, check)),
        destroy: () => effect(id, () => getExecutor().destroy()),
      }, now)
      controllers.set(id, existing)
    }
    return existing
  }
  async function ready(): Promise<boolean> {
    if (closing || !recovered) return false
    try { return await options.isReady() === true && !closing }
    catch { return false }
  }
  function schedule(id: string, at: number | null) {
    const old = timers.get(id)
    if (old) clearTimeout(old)
    timers.delete(id)
    if (closing || at === null) return
    const timer = setTimeout(() => { timers.delete(id); void fire(id) }, Math.max(1, Math.min(2_147_483_647, at - now())))
    timer.unref(); timers.set(id, timer)
  }
  async function fire(id: string) {
    if (closing || alarms.has(id)) return
    alarms.add(id)
    try {
      const job = controller(id), receipt = await job.read()
      if (closing) return
      if (receipt?.state === 'queued') {
        if (!await ready()) { await stores.forJob(id).alarm(now() + 1000); return }
        // A reduced capacity after restart must not start every old queued row
        // concurrently. Stopping jobs retain their slot until actual cleanup.
        const occupied = new Set([...claims, ...effects.keys()])
        for (const row of stores.unfinished()) {
          if (stores.receipt(row.id)?.state !== 'queued') occupied.add(row.id)
        }
        if (occupied.size >= capacity) { await stores.forJob(id).alarm(now() + 1000); return }
        claims.add(id)
      }
      if (closing) return
      await job.alarm()
    } catch {
      // No provider error text or command can leak through HTTP. A durable row
      // remains observable and is retried only through controller lifecycle.
      if (!closing) schedule(id, now() + 1000)
    } finally {
      alarms.delete(id)
      claims.delete(id)
      if (!closing && !timers.has(id)) {
        const at = stores.alarmAt(id)
        if (at !== null) schedule(id, Math.max(now() + 1, at))
      }
    }
  }
  function recover(): Promise<void> {
    return recovery ??= serial(async () => {
      if (closing) return
      // A persisted running row becomes interrupted through JobController.load;
      // it is never treated as a new command. Repair save→alarm crash windows.
      for (const row of stores.unfinished()) {
        const job = controller(row.id)
        await job.read()
        await stores.forJob(row.id).alarm(Math.min(stores.alarmAt(row.id) ?? now(), now() + 1))
      }
      recovered = true
    })
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!timingSafeEqual(hash(req.headers.authorization ?? ''), expectedAuthorization)) {
      req.resume(); json(res, 401, { error: 'unauthorized' }); return
    }
    const path = req.url ?? ''
    if (req.method === 'GET' && path === '/health') {
      json(res, 200, { service: 'friday-executor', protocol: capture ? 2 : 1, ready: await ready() }); return
    }
    const route = /^\/jobs\/([a-z0-9][a-z0-9-]{15,79})(\/stop|\/output)?$/.exec(path)
    if (!route || (route[2] === '/stop' ? req.method !== 'POST' : route[2] === '/output' ? req.method !== 'GET' || !capture
      : !['GET', 'POST'].includes(req.method ?? ''))) {
      req.resume(); json(res, 404, { error: 'not_found' }); return
    }
    const id = route[1]!
    if (route[2] === '/output') {
      // Same credential and fixed origin as the receipt; the job id is the only selector.
      const receipt = stores.receipt(id)
      if (!receipt) { json(res, 404, { error: 'unknown_job' }); return }
      const artifact = receipt.version === 2 && receipt.state === 'finished' && receipt.cleanup === 'confirmed' ? receipt.outputArtifact : null
      if (!artifact) { json(res, 404, { error: 'output_unavailable' }); return }
      let data: Buffer | undefined
      try { data = await options.readOutput!(id, artifact) } catch { json(res, 500, { error: 'artifact_corrupt' }); return }
      if (!data) { json(res, 410, { error: 'artifact_expired' }); return }
      if (data.length !== artifact.bytes || hex(data) !== artifact.digest) { json(res, 500, { error: 'artifact_corrupt' }); return }
      if (res.destroyed || res.writableEnded) return
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(data.length),
        'cache-control': 'no-store', 'x-friday-output-digest': artifact.digest })
      res.end(data); return
    }
    if (req.method === 'GET') {
      // Don't allocate unbounded controller objects for absent read requests.
      if (!stores.receipt(id)) { json(res, 404, { error: 'unknown_job' }); return }
      json(res, 200, await controller(id).read()); return
    }
    if (route[2] === '/stop') {
      req.resume()
      const receipt = await serial(() => controller(id).stop())
      json(res, 200, receipt); return
    }
    const input = validateJobInput(JSON.parse(await body(req)), allowedRepos, { capture })
    const digest = await payloadDigest(input)
    const receipt = await serial(async () => {
      if (closing || !recovered) throw new JobProtocolError(503, 'executor_unavailable')
      if (stores.receipt(id)) return controller(id).submit(input, digest)
      if (!await ready()) throw new JobProtocolError(503, 'executor_unavailable')
      if (stores.countUnfinished() >= capacity) throw new JobProtocolError(429, 'executor_capacity_full')
      try { return await controller(id).submit(input, digest) }
      catch (error) {
        // JobController updates its in-memory view before awaiting persistence.
        // If SQLite rejected the initial row, don't retain that phantom claim.
        if (!stores.receipt(id)) controllers.delete(id)
        throw error
      }
    })
    json(res, 202, receipt)
  }
  function handler(req: IncomingMessage, res: ServerResponse) {
    const pending = handle(req, res).catch(error => {
      const known = error instanceof JobProtocolError ? error : error instanceof SyntaxError ? new JobProtocolError(400, 'invalid_json') : undefined
      json(res, known?.status ?? 503, { error: known?.code ?? 'executor_request_failed' })
    })
    requests.add(pending)
    void pending.finally(() => requests.delete(pending))
  }
  async function close({ timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<{ drained: boolean; pending: number }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) throw new Error('invalid_shutdown_timeout')
    closing = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    // Serialize with in-flight admissions. Do not close the injected database:
    // late create/start ACK and their cleanup still need to persist truth.
    let stopsDone = false
    const stops = serial(async () => {
      await Promise.all(stores.unfinished().map(row => controller(row.id).stop().catch(() => {})))
    }).finally(() => { stopsDone = true })
    void stops.catch(() => {})
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const jobs = new Set([...stores.unfinished().map(row => row.id), ...effects.keys(), ...alarms])
      const pending = jobs.size + requests.size + (stopsDone ? 0 : jobs.size ? 0 : 1)
      if (pending === 0) return { drained: true, pending: 0 }
      if (Date.now() >= deadline) return { drained: false, pending }
      await new Promise(resolve => setTimeout(resolve, Math.min(5, deadline - Date.now())))
    }
  }
  return { handler, recover, close }
}

function hash(value: string): Buffer { return createHash('sha256').update(value).digest() }
function hex(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }
function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
async function body(req: IncomingMessage): Promise<string> {
  const length = req.headers['content-length']
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
    req.resume(); throw new JobProtocolError(413, 'job_too_large')
  }
  const chunks: Buffer[] = []; let size = 0
  // Event listeners let an oversized chunked body receive a JSON 413 instead
  // of async-iterator cancellation destroying its socket before the response.
  return new Promise<string>((resolve, reject) => {
    const clean = () => { req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', aborted) }
    const failed = () => { clean(); reject(new JobProtocolError(400, 'request_incomplete')) }
    const aborted = () => failed()
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) { clean(); req.resume(); reject(new JobProtocolError(413, 'job_too_large')); return }
      chunks.push(chunk)
    }
    const end = () => {
      clean()
      try { resolve(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))) }
      catch { reject(new JobProtocolError(400, 'invalid_encoding')) }
    }
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', aborted)
  })
}
