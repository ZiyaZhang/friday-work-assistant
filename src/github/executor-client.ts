import { createHash } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { HttpsProxyAgent } from 'https-proxy-agent'

/** Version 1 is deliberately independent of the Work/Task/Run schema. These
 * are provider receipts, never user authorization or proof that a PR passed. */
export interface ExecutorJobInput {
  repo: string
  baseSha: string
  inputTree: string
  patch: string
  command: string
  timeoutMs: number
  /** Protocol 2 only. Absent keeps the exact version 1 request, digest and receipt. */
  capture?: ExecutorOutputCapture
}
/** Host-approved output scope: exact repository-relative files or directory prefixes. */
export interface ExecutorOutputCapture {
  kind: 'repository_patch'
  paths: string[]
  maxBytes: number
}
export interface ExecutorOutputFile {
  path: string
  /** SHA-256 of the file bytes; null means the file is absent on that side. */
  beforeDigest: string | null
  afterDigest: string | null
  mode: '100644' | '100755'
}
/** Provider-stored binary patch from beforeTree to afterTree. Only its digest,
 * size and manifest travel in a receipt; bytes come from download(). */
export interface ExecutorOutputArtifact {
  id: string
  digest: string
  bytes: number
  beforeTree: string
  afterTree: string
  files: ExecutorOutputFile[]
}
export interface ExecutorJobResult {
  status: 'passed' | 'failed' | 'source_changed' | 'input_mismatch' | 'setup_failed' | 'output_limit'
  beforeTree: string | null
  afterTree: string | null
  exitCode: number | null
  output: { stdout: string; stderr: string; truncated: boolean }
  runtime: string
  phase: 'prepare' | 'command' | 'verify'
}
export interface ExecutorJobReceipt {
  /** 1: a job without capture; 2: a capture job (adds outputArtifact/outputError). */
  version: 1 | 2
  id: string
  digest: string | null
  state: 'queued' | 'running' | 'stopping' | 'finished'
  outcome: ExecutorJobResult['status'] | 'cancelled' | 'timed_out' | 'interrupted' | 'executor_unavailable' | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  deadline: number | null
  cleanup: 'not_started' | 'pending' | 'confirmed'
  result: ExecutorJobResult | null
  /** Version 2 only. */
  outputArtifact?: ExecutorOutputArtifact | null
  /** Version 2 only: fixed code when the command changed files but no artifact exists. */
  outputError?: string | null
}
export type ExecutorClientOperation = 'submit' | 'read' | 'stop' | 'download'
export type ExecutorClientErrorCode = 'invalid_configuration' | 'invalid_request' | 'cancelled' | 'authorization_changed'
  | 'timeout' | 'network_error' | 'not_found' | 'forbidden' | 'unauthorized' | 'unavailable' | 'conflict'
  | 'rejected' | 'redirect_denied' | 'invalid_response' | 'output_limit' | 'expired'
/** unknown means a POST may have taken effect: query this same id, do not
 * generate another id or replay the command. No raw transport cause is stored. */
export class ExecutorClientError extends Error {
  constructor(readonly code: ExecutorClientErrorCode, readonly operation: ExecutorClientOperation | 'configuration',
    readonly result: 'not_sent' | 'unknown' | 'rejected' | 'read_failed', readonly status?: number) {
    super(`执行服务请求未完成：${code}`)
    this.name = 'ExecutorClientError'
  }
}
export interface ExecutorClientConfig {
  baseUrl: string
  secret: string
  proxyUrl?: string
  /** Whole HTTP operation, including response body. Execution has its separate job deadline. */
  requestTimeoutMs?: number
}
export type ExecutorGuard = () => void
export interface ExecutorTransportRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Readonly<Record<string, string>>
  body?: string
  signal: AbortSignal
  redirect: 'error'
}
/** Host-only injection for a local fixture. Production defaults to HTTPS with
 * its own optional proxy agent; no environment/global transport is changed. */
export type ExecutorTransport = (request: ExecutorTransportRequest) => Promise<Response>

/** A host-configured HTTPS mount, normalized without changing its path scope.
 * Check the original path before URL parsing can collapse dot segments or
 * backslashes. Encoded paths are excluded to avoid proxy decoding ambiguity. */
export function normalizeExecutorBaseUrl(value: string): string {
  const invalid: () => never = () => { throw new ExecutorClientError('invalid_configuration', 'configuration', 'not_sent') }
  if (typeof value !== 'string' || /[\x00-\x20\x7f\\?#]/.test(value)) invalid()
  const raw = /^https:\/\/([^/]+)(\/.*)?$/i.exec(value)
  if (!raw || raw[1]!.includes('@')) invalid()
  const path = raw[2] ?? '/'
  if (path !== '/' && (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(path) ||
    path.split('/').some(segment => segment === '.' || segment === '..'))) invalid()
  let url: URL
  try { url = new URL(value) } catch { invalid() }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== path) invalid()
  return url.origin + path.replace(/\/$/, '')
}

const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/, JOB_ID = /^[a-z0-9][a-z0-9-]{15,79}$/
const MAX_PATCH = 2 * 1024 * 1024, MAX_REQUEST = MAX_PATCH + 32 * 1024
const MAX_STREAM_OUTPUT = 64 * 1024, MAX_RESPONSE = 1024 * 1024
export const MAX_EXECUTOR_OUTPUT_BYTES = 2 * 1024 * 1024
export const MAX_EXECUTOR_OUTPUT_FILES = 200
const MAX_CAPTURE_PATHS = 64, MAX_CAPTURE_PATH_BYTES = 8 * 1024
const bytes = (value: string) => Buffer.byteLength(value, 'utf8')
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullableTime = (value: unknown) => value === null || timestamp(value)
const nullableTree = (value: unknown) => value === null || typeof value === 'string' && SHA.test(value)
const nullableDigest = (value: unknown): value is string | null => value === null || typeof value === 'string' && DIGEST.test(value)

/** The provider's rule: repository-relative, no escape, Git metadata or gateway marker. */
export function safeExecutorOutputPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || bytes(value) > 1024 || /[\\\x00-\x1f\x7f]/.test(value)) return false
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' &&
    part !== '.friday-change.json')
}
/** true when path is one of the scope entries or lies below one of them. */
export function withinExecutorCapture(path: string, paths: readonly string[]): boolean {
  return paths.some(scope => path === scope || path.startsWith(`${scope}/`))
}

type Fail = (code: ExecutorClientErrorCode, status?: number, rejected?: boolean) => never

export class ExecutorClient {
  private readonly baseUrl: string
  private readonly secret: string
  private readonly timeoutMs: number
  private readonly transport: ExecutorTransport

  constructor(config: ExecutorClientConfig, transport?: ExecutorTransport) {
    const invalid: () => never = () => { throw new ExecutorClientError('invalid_configuration', 'configuration', 'not_sent') }
    const baseUrl = normalizeExecutorBaseUrl(config.baseUrl)
    if (typeof config.secret !== 'string' || config.secret.length < 32 || config.secret.length > 4096 || /[^\x21-\x7e]/.test(config.secret)) invalid()
    const timeoutMs = config.requestTimeoutMs ?? 15_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) invalid()
    if (config.proxyUrl !== undefined) {
      try { const proxy = new URL(config.proxyUrl); if (!['http:', 'https:'].includes(proxy.protocol) || proxy.hash || proxy.search || proxy.pathname !== '/') invalid() }
      catch { invalid() }
    }
    this.baseUrl = baseUrl
    this.secret = config.secret
    this.timeoutMs = timeoutMs
    this.transport = transport ?? defaultTransport(config.proxyUrl)
  }

  submit(jobId: string, input: ExecutorJobInput, guard: ExecutorGuard, signal?: AbortSignal): Promise<ExecutorJobReceipt> {
    const body = serializeInput(input)
    return this.receipt('submit', jobId, guard, signal, body, sha256(body))
  }
  read(jobId: string, guard: ExecutorGuard, signal?: AbortSignal): Promise<ExecutorJobReceipt> {
    return this.receipt('read', jobId, guard, signal)
  }
  stop(jobId: string, guard: ExecutorGuard, signal?: AbortSignal): Promise<ExecutorJobReceipt> {
    return this.receipt('stop', jobId, guard, signal)
  }
  /** Protocol 2 artifact bytes from the fixed `/jobs/:id/output` path. The read
   * is bounded by the receipt's size and returned only if its SHA-256 matches. */
  download(jobId: string, artifact: Pick<ExecutorOutputArtifact, 'digest' | 'bytes'>, guard: ExecutorGuard, signal?: AbortSignal): Promise<Buffer> {
    if (!object(artifact) || typeof artifact.digest !== 'string' || !DIGEST.test(artifact.digest) || !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 1 || artifact.bytes > MAX_EXECUTOR_OUTPUT_BYTES) {
      return Promise.reject(new ExecutorClientError('invalid_request', 'download', 'not_sent'))
    }
    const expected = { digest: artifact.digest, bytes: artifact.bytes }
    return this.exchange('download', jobId, guard, signal, undefined, expected.bytes, (data, fail) => {
      if (data.length !== expected.bytes || sha256(data) !== expected.digest) fail('invalid_response')
      return data
    })
  }

  private receipt(operation: 'submit' | 'read' | 'stop', jobId: string, guard: ExecutorGuard, signal?: AbortSignal,
    body?: string, expectedDigest?: string): Promise<ExecutorJobReceipt> {
    return this.exchange(operation, jobId, guard, signal, body, MAX_RESPONSE, (data, fail) => {
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) }
      catch { fail('invalid_response') }
      if (object(value) && object(value.result) && object(value.result.output) &&
        [value.result.output.stdout, value.result.output.stderr].some(part => typeof part === 'string' && bytes(part) > MAX_STREAM_OUTPUT)) fail('output_limit')
      const receipt = parseReceipt(value, jobId)
      if (!receipt || expectedDigest !== undefined && receipt.digest !== expectedDigest) fail('invalid_response')
      if (JSON.stringify(receipt).includes(this.secret)) fail('invalid_response')
      return receipt!
    })
  }

  private async exchange<T>(operation: ExecutorClientOperation, jobId: string, guard: ExecutorGuard, signal: AbortSignal | undefined,
    body: string | undefined, limit: number, decode: (data: Buffer, fail: Fail) => T): Promise<T> {
    if (!JOB_ID.test(jobId)) throw new ExecutorClientError('invalid_request', operation, 'not_sent')
    const readLike = operation === 'read' || operation === 'download'
    let sent = false, timedOut = false
    const controller = new AbortController()
    const outcome = () => !sent ? 'not_sent' as const : readLike ? 'read_failed' as const : 'unknown' as const
    const fail: Fail = (code, status, rejected = false) => {
      throw new ExecutorClientError(code, operation, rejected ? 'rejected' : outcome(), status)
    }
    const check = () => {
      if (signal?.aborted) fail('cancelled')
      try { guard() } catch { fail('authorization_changed') }
      if (timedOut) fail('timeout')
    }
    check()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.timeoutMs)
    timer.unref()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      check()
      // Fixed paths only: neither a model URL nor a redirect can receive this credential.
      const url = `${this.baseUrl}/jobs/${jobId}${operation === 'stop' ? '/stop' : operation === 'download' ? '/output' : ''}`
      sent = true
      const pending = this.transport({ url, method: readLike ? 'GET' : 'POST', body,
        headers: Object.freeze({ authorization: `Bearer ${this.secret}`, accept: operation === 'download' ? 'application/octet-stream' : 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) }), signal: controller.signal, redirect: 'error' })
      // A fixture/transport ignoring AbortSignal must not keep an unbounded caller
      // alive. Its late body is discarded, never interpreted as fresh authority.
      void pending.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => {}) }, () => {})
      const response = await boundedAwait(pending, controller.signal)
      check()
      if (response.redirected || response.status >= 300 && response.status < 400) fail('redirect_denied', response.status)
      if (response.status === 401) fail('unauthorized', 401, true)
      if (response.status === 403) fail('forbidden', 403, true)
      if (response.status === 404) fail('not_found', 404, !readLike)
      if (response.status === 409) fail('conflict', 409, true)
      if (response.status === 410 && operation === 'download') fail('expired', 410)
      if (response.status === 429 || response.status >= 500) fail('unavailable', response.status)
      if (response.status >= 400) fail('rejected', response.status, true)
      if (response.status !== 200 && (operation === 'download' || response.status !== 202)) fail('invalid_response', response.status)
      const contentLength = response.headers.get('content-length')
      if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) fail('output_limit')
      if (!response.body) fail('invalid_response')
      reader = response.body!.getReader()
      const chunks: Uint8Array[] = []; let size = 0
      while (true) {
        const item = await boundedAwait(reader.read(), controller.signal)
        check()
        if (item.done) break
        size += item.value.byteLength
        if (size > limit) fail('output_limit')
        chunks.push(item.value)
      }
      const value = decode(Buffer.concat(chunks, size), fail)
      check()
      return value
    } catch (error) {
      // Guard/stop wins over a late HTTP response. HTTP uncertainty remains
      // explicit even if the remote has already durably accepted the operation.
      check()
      if (error instanceof ExecutorClientError) throw error
      return fail('network_error')
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      controller.abort()
      if (reader) void reader.cancel().catch(() => {})
    }
  }
}

function serializeInput(input: ExecutorJobInput): string {
  const invalid = (): never => { throw new ExecutorClientError('invalid_request', 'submit', 'not_sent') }
  const keys = ['repo', 'baseSha', 'inputTree', 'patch', 'command', 'timeoutMs', ...(object(input) && input.capture !== undefined ? ['capture'] : [])]
  if (!object(input) || Object.keys(input).length !== keys.length || keys.some(key => !(key in input))) invalid()
  if (typeof input.repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.repo) || input.repo.endsWith('.git') ||
    !SHA.test(input.baseSha) || !SHA.test(input.inputTree) || typeof input.patch !== 'string' || bytes(input.patch) > MAX_PATCH ||
    typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0') || bytes(input.command) > 16 * 1024 ||
    !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 12 * 60_000) invalid()
  let capture: ExecutorOutputCapture | undefined
  if (input.capture !== undefined) {
    const value: unknown = input.capture
    if (!object(value) || Object.keys(value).length !== 3 || value.kind !== 'repository_patch' || !Array.isArray(value.paths) ||
      value.paths.length < 1 || value.paths.length > MAX_CAPTURE_PATHS || !value.paths.every(safeExecutorOutputPath) ||
      new Set(value.paths).size !== value.paths.length ||
      value.paths.reduce((total: number, path: string) => total + bytes(path), 0) > MAX_CAPTURE_PATH_BYTES ||
      !Number.isSafeInteger(value.maxBytes) || Number(value.maxBytes) < 1 || Number(value.maxBytes) > MAX_EXECUTOR_OUTPUT_BYTES) invalid()
    const checked = value as unknown as ExecutorOutputCapture
    capture = { kind: 'repository_patch', paths: [...checked.paths], maxBytes: checked.maxBytes }
  }
  // Without capture this is byte-for-byte the version 1 request (and digest).
  const body = JSON.stringify({ repo: input.repo, baseSha: input.baseSha, inputTree: input.inputTree, patch: input.patch,
    command: input.command, timeoutMs: input.timeoutMs, ...(capture ? { capture } : {}) })
  if (bytes(body) > MAX_REQUEST) invalid()
  return body
}

function parseReceipt(value: unknown, id: string): ExecutorJobReceipt | undefined {
  if (!object(value) || (value.version !== 1 && value.version !== 2) || value.id !== id ||
    !(value.digest === null || typeof value.digest === 'string' && DIGEST.test(value.digest)) ||
    !['queued', 'running', 'stopping', 'finished'].includes(String(value.state)) ||
    !['not_started', 'pending', 'confirmed'].includes(String(value.cleanup)) ||
    !timestamp(value.createdAt) || !nullableTime(value.startedAt) || !nullableTime(value.finishedAt) || !nullableTime(value.deadline)) return
  const resultStates = ['passed', 'failed', 'source_changed', 'input_mismatch', 'setup_failed', 'output_limit']
  const terminal = [...resultStates, 'cancelled', 'timed_out', 'interrupted', 'executor_unavailable']
  if (!(value.outcome === null || terminal.includes(String(value.outcome)))) return
  if (value.state === 'queued' && (value.outcome !== null || value.result !== null || value.cleanup !== 'not_started' ||
    value.startedAt !== null || value.finishedAt !== null || value.deadline !== null)) return
  if (value.state === 'running' && (value.outcome !== null || value.result !== null || value.cleanup !== 'pending' ||
    !timestamp(value.startedAt) || !timestamp(value.deadline) || value.finishedAt !== null)) return
  if (value.state === 'stopping' && (value.outcome === null || value.cleanup !== 'pending' || value.finishedAt !== null)) return
  if (value.state === 'finished' && (value.outcome === null || value.cleanup !== 'confirmed' || !timestamp(value.finishedAt))) return
  let result: ExecutorJobResult | null = null
  if (value.result !== null) {
    const r = value.result
    if (!object(r) || !resultStates.includes(String(r.status)) || r.status !== value.outcome || !nullableTree(r.beforeTree) || !nullableTree(r.afterTree) ||
      !(r.exitCode === null || typeof r.exitCode === 'number' && Number.isSafeInteger(r.exitCode)) ||
      !['prepare', 'command', 'verify'].includes(String(r.phase)) || typeof r.runtime !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(r.runtime) ||
      !object(r.output) || typeof r.output.stdout !== 'string' || typeof r.output.stderr !== 'string' || typeof r.output.truncated !== 'boolean' ||
      bytes(r.output.stdout) > MAX_STREAM_OUTPUT || bytes(r.output.stderr) > MAX_STREAM_OUTPUT) return
    if (r.status === 'passed' && (r.exitCode !== 0 || r.beforeTree === null || r.beforeTree !== r.afterTree || r.output.truncated)) return
    result = { status: r.status as ExecutorJobResult['status'], beforeTree: r.beforeTree as string | null, afterTree: r.afterTree as string | null,
      exitCode: r.exitCode as number | null, phase: r.phase as ExecutorJobResult['phase'], runtime: r.runtime,
      output: { stdout: r.output.stdout, stderr: r.output.stderr, truncated: r.output.truncated } }
  } else if (resultStates.includes(String(value.outcome))) return
  if (value.digest === null && (value.outcome !== 'cancelled' || value.startedAt !== null || value.result !== null || value.version !== 1)) return
  // Project known fields; a remote stack, URL, token, or command is never copied
  // merely because the provider accidentally included it in its JSON envelope.
  const receipt: ExecutorJobReceipt = { version: value.version as 1 | 2, id, digest: value.digest as string | null, state: value.state as ExecutorJobReceipt['state'],
    outcome: value.outcome as ExecutorJobReceipt['outcome'], createdAt: value.createdAt,
    startedAt: value.startedAt as number | null, finishedAt: value.finishedAt as number | null, deadline: value.deadline as number | null,
    cleanup: value.cleanup as ExecutorJobReceipt['cleanup'], result }
  if (value.version === 1) return receipt
  // Version 2: both output fields are always present; at most one is set, and
  // only together with a successful source-changing command result.
  if (!('outputArtifact' in value) || !('outputError' in value)) return
  const artifact = value.outputArtifact === null ? null : parseArtifact(value.outputArtifact)
  if (artifact === undefined) return
  if (!(value.outputError === null || typeof value.outputError === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(value.outputError))) return
  if (artifact && (value.outputError !== null || result?.status !== 'source_changed' || result.exitCode !== 0 ||
    result.beforeTree !== artifact.beforeTree || result.afterTree !== artifact.afterTree)) return
  if (value.outputError !== null && (result === null || result.status !== 'source_changed')) return
  return { ...receipt, outputArtifact: artifact, outputError: value.outputError as string | null }
}

function parseArtifact(value: unknown): ExecutorOutputArtifact | undefined {
  if (!object(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id) ||
    typeof value.digest !== 'string' || !DIGEST.test(value.digest) || !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 1 || Number(value.bytes) > MAX_EXECUTOR_OUTPUT_BYTES ||
    typeof value.beforeTree !== 'string' || !SHA.test(value.beforeTree) || typeof value.afterTree !== 'string' || !SHA.test(value.afterTree) ||
    value.beforeTree === value.afterTree || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_EXECUTOR_OUTPUT_FILES) return
  const files: ExecutorOutputFile[] = []
  for (const file of value.files as unknown[]) {
    if (!object(file) || !safeExecutorOutputPath(file.path) || !nullableDigest(file.beforeDigest) || !nullableDigest(file.afterDigest) ||
      file.beforeDigest === null && file.afterDigest === null || (file.mode !== '100644' && file.mode !== '100755')) return
    files.push({ path: file.path, beforeDigest: file.beforeDigest, afterDigest: file.afterDigest, mode: file.mode })
  }
  if (new Set(files.map(file => file.path)).size !== files.length) return
  return { id: value.id, digest: value.digest, bytes: Number(value.bytes), beforeTree: value.beforeTree, afterTree: value.afterTree, files }
}

function boundedAwait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(new Error('request_ended')) }
    if (signal.aborted) { reject(new Error('request_ended')); return }
    signal.addEventListener('abort', aborted, { once: true })
    pending.then(value => { signal.removeEventListener('abort', aborted); resolve(value) }, error => {
      signal.removeEventListener('abort', aborted); reject(error)
    })
  })
}

function defaultTransport(proxyUrl?: string): ExecutorTransport {
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl, { keepAlive: true }) : undefined
  return request => new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(request.url, { method: request.method, headers: request.headers, agent, signal: request.signal }, response => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        if (typeof value === 'string') headers.set(name, value)
        else if (Array.isArray(value)) for (const entry of value) headers.append(name, entry)
      }
      const status = response.statusCode ?? 502
      const empty = [204, 205, 304].includes(status)
      if (empty) response.resume()
      resolve(new Response(empty ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }))
    })
    req.on('error', reject)
    req.end(request.body)
  })
}
