import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { AxiosInstance, AxiosResponse } from 'axios'
import type { GitHubTransport } from './transport.js'
import { GitHubJobLogError, jobLogHttpError, jobLogRange, jobLogStorageLocation, type JobLogRange } from './job-log-policy.js'

export interface ActionsJobLogRequest { repo: string; jobId: number; maxBytes: number; startByte?: number; assertCurrent(): void; signal?: AbortSignal }
export interface ActionsJobLogBytes extends JobLogRange { data: Buffer; sha256: string }

/** This protocol is independent of artifact downloads. Only the initial fixed
 * GitHub endpoint is authenticated; every storage request uses fresh headers. */
export async function downloadActionsJobLog(http: AxiosInstance, transport: GitHubTransport,
  input: ActionsJobLogRequest, authorization: string): Promise<ActionsJobLogBytes> {
  const guard = () => { input.signal?.throwIfAborted(); input.assertCurrent() }
  const get = async (url: string, headers: Record<string, string>): Promise<AxiosResponse<Readable>> => {
    guard()
    let response: AxiosResponse<Readable>
    try { response = await http.request<Readable>({ method: 'GET', url, headers, signal: input.signal,
      responseType: 'stream', maxRedirects: 0, decompress: false, validateStatus: () => true }) }
    catch { guard(); throw new GitHubJobLogError('unavailable') }
    try { guard(); return response } catch (error) { response.data.destroy(); throw error }
  }
  const target = transport.jobLog(input.repo, input.jobId, input.maxBytes, input.startByte)
  let response = await get(target.url, { accept: 'application/vnd.github+json', 'accept-encoding': 'identity',
    'x-github-api-version': '2022-11-28', 'user-agent': 'friday-github', authorization, ...target.headers })
  try {
    let start = input.startByte ?? 0, range: JobLogRange
    if (transport.relay) {
      const observedStart = response.headers['x-friday-log-start-byte']
      if (typeof observedStart !== 'string' || !/^(0|[1-9]\d*)$/.test(observedStart) || !Number.isSafeInteger(Number(observedStart))) {
        if (response.status !== 200 && response.status !== 206) throw jobLogHttpError(response.status)
        throw new GitHubJobLogError('invalid_response')
      }
      start = Number(observedStart)
      range = jobLogRange(response.status, response.headers['content-range'], response.headers['content-length'], start, input.maxBytes)
      if (input.startByte !== undefined && start !== input.startByte || input.startByte === undefined && start !== Math.max(0, range.totalBytes - input.maxBytes)) throw new GitHubJobLogError('invalid_response')
    } else {
      if (response.status !== 302) throw jobLogHttpError(response.status)
      const location = jobLogStorageLocation(response.headers.location)
      response.data.destroy(); guard()
      const storageHeaders = { accept: 'text/plain', 'accept-encoding': 'identity', 'user-agent': 'friday-github' }
      if (input.startByte === undefined) {
        // Azure's documented Range grammar has no suffix form. Probe one byte
        // for a verified total, then request the bounded tail from the same URL.
        response = await get(location, { ...storageHeaders, range: 'bytes=0-0' })
        if (response.status === 200) range = jobLogRange(200, undefined, response.headers['content-length'], 0, input.maxBytes)
        else {
          const probe = jobLogRange(response.status, response.headers['content-range'], response.headers['content-length'], 0, 1)
          start = Math.max(0, probe.totalBytes - input.maxBytes)
          const etag = response.headers.etag
          response.data.destroy(); guard()
          response = await get(location, { ...storageHeaders, range: `bytes=${start}-${start + input.maxBytes - 1}`,
            ...(typeof etag === 'string' ? { 'if-match': etag } : {}) })
          range = jobLogRange(response.status, response.headers['content-range'], response.headers['content-length'], start, input.maxBytes)
          if (range.totalBytes !== probe.totalBytes) throw new GitHubJobLogError('range_changed')
        }
      } else {
        response = await get(location, { ...storageHeaders, range: `bytes=${start}-${start + input.maxBytes - 1}` })
        range = jobLogRange(response.status, response.headers['content-range'], response.headers['content-length'], start, input.maxBytes)
      }
    }
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new GitHubJobLogError('invalid_response')
    const chunks: Buffer[] = [], iterator = response.data[Symbol.asyncIterator]()
    let size = 0
    for (;;) {
      guard()
      let next: IteratorResult<unknown>
      try { next = await iterator.next() } catch { guard(); throw new GitHubJobLogError('unavailable') }
      guard()
      if (next.done) break
      const chunk = Buffer.isBuffer(next.value) ? next.value : next.value instanceof Uint8Array ? Buffer.from(next.value) : undefined
      if (!chunk) throw new GitHubJobLogError('invalid_response')
      size += chunk.length
      if (size > input.maxBytes || size > range.endByte - range.startByte) throw new GitHubJobLogError('too_large')
      chunks.push(chunk)
    }
    if (size !== range.endByte - range.startByte) throw new GitHubJobLogError('invalid_response')
    guard()
    const data = Buffer.concat(chunks, size)
    return { ...range, data, sha256: createHash('sha256').update(data).digest('hex') }
  } finally { response.data.destroy() }
}
