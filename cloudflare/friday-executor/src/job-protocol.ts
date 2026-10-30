/** Provider receipts only. Friday remains the authority for Task/Work, user
 * permissions, waiting, and publication. No model-supplied identity lives here. */
export interface JobInput {
  repo: string
  baseSha: string
  inputTree: string
  patch: string
  command: string
  timeoutMs: number
  /** Protocol 2. Absent keeps the v1 verify-only job: same fields, digest and receipt. */
  capture?: OutputCapture
}
/** Host-approved output scope. Each entry is an exact relative file path or a
 * directory prefix. It is part of the immutable input digest. */
export interface OutputCapture {
  kind: 'repository_patch'
  paths: string[]
  /** Largest accepted binary patch. A larger output is rejected, never truncated. */
  maxBytes: number
}
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024 + 32 * 1024
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
export const MAX_OUTPUT_FILES = 200
export const MAX_OUTPUT_FILE_BYTES = 1024 * 1024
export const MAX_CAPTURE_PATHS = 64
const MAX_CAPTURE_PATH_BYTES = 8 * 1024
/** Lossless base conversion keeps a 256-bit DO id within Sandbox's 63 chars. */
export function sandboxId(objectId: string): string {
  if (!/^[a-f0-9]{64}$/.test(objectId)) throw new Error('invalid_object_id')
  return `job-${BigInt(`0x${objectId}`).toString(36)}`
}
export class JobProtocolError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
/** A repository-relative path without escape, Git metadata or the gateway marker. */
export function safeOutputPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > 1024 || /[\\\x00-\x1f\x7f]/.test(value)) return false
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' &&
    part !== '.friday-change.json')
}
/** true when path is one of the scope entries or lies below one of them. */
export function withinCapture(path: string, paths: readonly string[]): boolean {
  return paths.some(scope => path === scope || path.startsWith(`${scope}/`))
}
function validateCapture(value: unknown): OutputCapture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JobProtocolError(400, 'invalid_capture')
  const capture = value as Record<string, unknown>
  if (Object.keys(capture).length !== 3 || !['kind', 'paths', 'maxBytes'].every(key => key in capture) ||
    capture.kind !== 'repository_patch' || !Array.isArray(capture.paths) || capture.paths.length < 1 ||
    capture.paths.length > MAX_CAPTURE_PATHS || !capture.paths.every(safeOutputPath) ||
    new Set(capture.paths).size !== capture.paths.length ||
    capture.paths.reduce((total: number, path: string) => total + new TextEncoder().encode(path).length, 0) > MAX_CAPTURE_PATH_BYTES ||
    !Number.isSafeInteger(capture.maxBytes) || Number(capture.maxBytes) < 1 || Number(capture.maxBytes) > MAX_OUTPUT_BYTES) {
    throw new JobProtocolError(400, 'invalid_capture')
  }
  return { kind: 'repository_patch', paths: [...capture.paths as string[]], maxBytes: Number(capture.maxBytes) }
}
/** capture is accepted only by a provider that stores output artifacts. */
export function validateJobInput(value: unknown, allowedRepos: readonly string[], options: { capture?: boolean } = {}): JobInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JobProtocolError(400, 'invalid_job')
  const input = value as Record<string, unknown>
  const keys = ['repo', 'baseSha', 'inputTree', 'patch', 'command', 'timeoutMs', ...('capture' in input && options.capture ? ['capture'] : [])]
  if (Object.keys(input).length !== keys.length || keys.some(key => !(key in input))) throw new JobProtocolError(400, 'invalid_fields')
  if (typeof input.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo) ||
    !allowedRepos.some(repo => repo.toLowerCase() === String(input.repo).toLowerCase())) throw new JobProtocolError(403, 'repository_not_allowed')
  if (typeof input.baseSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.baseSha) ||
    typeof input.inputTree !== 'string' || !/^[a-f0-9]{40}$/.test(input.inputTree)) throw new JobProtocolError(400, 'invalid_git_revision')
  if (typeof input.patch !== 'string' || new TextEncoder().encode(input.patch).length > 2 * 1024 * 1024 ||
    typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0') ||
    new TextEncoder().encode(input.command).length > 16 * 1024) throw new JobProtocolError(400, 'invalid_payload')
  // Alarm invocations have a 15 minute wall limit. Leave time for termination
  // and persisting a receipt; longer builds need process-handle polling.
  if (!Number.isInteger(input.timeoutMs) || Number(input.timeoutMs) < 1000 || Number(input.timeoutMs) > 12 * 60_000) throw new JobProtocolError(400, 'invalid_timeout')
  const capture = 'capture' in input ? validateCapture(input.capture) : undefined
  // Fixed property order gives a stable payload digest independent of JSON key order.
  // Without capture the object, its JSON and its digest are exactly protocol 1.
  return { repo: input.repo, baseSha: input.baseSha, inputTree: input.inputTree, patch: input.patch,
    command: input.command, timeoutMs: Number(input.timeoutMs), ...(capture ? { capture } : {}) }
}
export async function payloadDigest(input: JobInput): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)))
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
