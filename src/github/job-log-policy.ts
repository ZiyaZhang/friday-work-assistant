/** Shared by the host and the fixed-id Worker route. No credentials or URLs are
 * part of a model-visible result. GitHub returns a one-minute 302 for job logs.
 * Azure supports explicit byte ranges, not suffix ranges. */
export const JOB_LOG_TIMEOUT_MS = 30_000
export const JOB_LOG_MAX_BYTES = 64 * 1024
export const JOB_LOG_DEFAULT_BYTES = 32 * 1024
/** A search may inspect more bytes than it returns; the model-visible window
 * remains bounded by JOB_LOG_MAX_BYTES and the caller's line budget. */
export const JOB_LOG_SCAN_BYTES = 8 * 1024 * 1024
export type JobLogErrorCode = 'invalid_input' | 'repository_denied' | 'permission_denied' | 'not_found_or_inaccessible'
  | 'rate_limited' | 'unavailable' | 'redirect_rejected' | 'range_unsupported' | 'range_changed' | 'invalid_response' | 'too_large'
export class GitHubJobLogError extends Error {
  constructor(readonly code: JobLogErrorCode) { super(`GitHub job log: ${code}`); this.name = 'GitHubJobLogError' }
}
export function validateJobLog(repo: string, jobId: number, maxBytes: number, startByte?: number) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some(p => p === '.' || p === '..') ||
    !Number.isSafeInteger(jobId) || jobId <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > JOB_LOG_SCAN_BYTES ||
    startByte !== undefined && (!Number.isSafeInteger(startByte) || startByte < 0 || !Number.isSafeInteger(startByte + maxBytes))) throw new GitHubJobLogError('invalid_input')
}
export function jobLogStorageLocation(value: unknown): string {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) throw new GitHubJobLogError('redirect_rejected')
  let url: URL
  try { url = new URL(value) } catch { throw new GitHubJobLogError('redirect_rejected') }
  if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || url.hash ||
    !(url.hostname === 'results-receiver.actions.githubusercontent.com' || /^[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname))) throw new GitHubJobLogError('redirect_rejected')
  return url.href
}
export function jobLogHttpError(status: number): GitHubJobLogError {
  return new GitHubJobLogError(status === 401 || status === 403 ? 'permission_denied' : status === 404 ? 'not_found_or_inaccessible'
    : status === 429 ? 'rate_limited' : status === 416 || status === 412 ? 'range_changed'
    : status >= 300 && status < 400 ? 'redirect_rejected' : 'unavailable')
}
export interface JobLogRange { startByte: number; endByte: number; totalBytes: number }
/** endByte is exclusive throughout the application. */
export function jobLogRange(status: number, contentRange: unknown, contentLength: unknown, start: number, limit: number): JobLogRange {
  if (status !== 200 && status !== 206) throw jobLogHttpError(status)
  const length = typeof contentLength === 'string' && /^(0|[1-9]\d*)$/.test(contentLength) ? Number(contentLength) : undefined
  if (contentLength !== undefined && contentLength !== null && (!Number.isSafeInteger(length) || length! < 0)) throw new GitHubJobLogError('invalid_response')
  if (status === 200) {
    if (start !== 0) throw new GitHubJobLogError('range_unsupported')
    if (length === undefined) throw new GitHubJobLogError('range_unsupported')
    if (length > limit) throw new GitHubJobLogError('range_unsupported')
    return { startByte: 0, endByte: length, totalBytes: length }
  }
  const match = typeof contentRange === 'string' ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange) : null
  if (!match) throw new GitHubJobLogError('invalid_response')
  const first = Number(match[1]), last = Number(match[2]), total = Number(match[3])
  if (![first, last, total].every(Number.isSafeInteger) || first !== start || last < first || last >= total ||
    last !== Math.min(total - 1, start + limit - 1) || length !== undefined && length !== last - first + 1) throw new GitHubJobLogError('invalid_response')
  return { startByte: first, endByte: last + 1, totalBytes: total }
}
