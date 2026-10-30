import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { OutputArtifact, OutputArtifactFile } from '../../cloudflare/friday-executor/src/job-controller.js'
import { MAX_OUTPUT_FILE_BYTES, MAX_OUTPUT_FILES, safeOutputPath, withinCapture, type OutputCapture } from '../../cloudflare/friday-executor/src/job-protocol.js'

/** Fixed codes only; a receipt never carries Git stderr, file content or host paths. */
export type OutputCaptureErrorCode = 'output_outside_scope' | 'output_path_unsafe' | 'output_link' | 'output_not_regular'
  | 'output_not_text' | 'output_too_large' | 'output_too_many_files' | 'output_roundtrip_failed' | 'output_capture_unavailable'
  | 'output_capture_failed'
export class OutputCaptureError extends Error {
  constructor(readonly code: OutputCaptureErrorCode) { super(code); this.name = 'OutputCaptureError' }
}
/** Trusted Git runner over the job's private metadata. `limit` bounds stdout;
 * exceeding it must throw OutputCaptureError('output_too_large'). */
export interface CaptureGit {
  bytes(args: string[], options: { limit: number; index?: string; workTree?: string }): Promise<Buffer>
}

const SHA = /^[a-f0-9]{40}$/, FILE_MODES = new Set(['100644', '100755'])
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const fail = (code: OutputCaptureErrorCode): never => { throw new OutputCaptureError(code) }

/** Runs only after every container process has ended and the container was
 * removed. Git metadata lives outside the worktree; no hook, filter, textconv or
 * repository config runs. The diff is computed from trees already verified by
 * the caller, never from command output. Out-of-scope changes reject the whole
 * capture; nothing is partially exported. */
export async function captureRepositoryPatch(git: CaptureGit, input: { workTree: string; scratch: string; capture: OutputCapture;
  beforeTree: string; afterTree: string }): Promise<{ patch: Buffer; files: OutputArtifactFile[] }> {
  const { capture, beforeTree, afterTree } = input
  if (!SHA.test(beforeTree) || !SHA.test(afterTree) || beforeTree === afterTree) fail('output_capture_failed')
  const raw = await git.bytes(['diff-tree', '-r', '-z', '--no-renames', '--raw', '--full-index', beforeTree, afterTree],
    { limit: 4 * 1024 * 1024 })
  const entries = parseRawDiff(raw)
  if (!entries.length) fail('output_capture_failed')
  if (entries.length > MAX_OUTPUT_FILES) fail('output_too_many_files')
  for (const entry of entries) {
    if (!safeOutputPath(entry.path)) fail('output_path_unsafe')
    if (!withinCapture(entry.path, capture.paths)) fail('output_outside_scope')
  }
  const files: OutputArtifactFile[] = []
  let total = 0
  for (const entry of entries) {
    for (const mode of [entry.status !== 'A' ? entry.srcMode : undefined, entry.status !== 'D' ? entry.dstMode : undefined]) {
      if (mode === undefined) continue
      if (mode === '120000') fail('output_link')
      if (!FILE_MODES.has(mode)) fail('output_not_regular')
    }
    if (entry.status !== 'A' && entry.status !== 'M' && entry.status !== 'D') fail('output_not_regular')
    if (entry.status !== 'D') await regularWorktreeFile(input.workTree, entry.path)
    const content = async (sha: string) => {
      const data = await git.bytes(['cat-file', 'blob', sha], { limit: MAX_OUTPUT_FILE_BYTES })
      total += data.length
      if (total > 16 * MAX_OUTPUT_FILE_BYTES) fail('output_too_large')
      if (!text(data)) fail('output_not_text')
      return sha256(data)
    }
    files.push({ path: entry.path, beforeDigest: entry.status === 'A' ? null : await content(entry.srcSha),
      afterDigest: entry.status === 'D' ? null : await content(entry.dstSha),
      mode: (entry.status === 'D' ? entry.srcMode : entry.dstMode) as OutputArtifactFile['mode'] })
  }
  const patch = await git.bytes(['diff', '--binary', '--full-index', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', beforeTree, afterTree, '--'], { limit: capture.maxBytes })
  if (!patch.length) fail('output_capture_failed')
  // The importer rebuilds the tree from these exact bytes; prove they do so here.
  const patchFile = join(input.scratch, 'output.patch'), index = join(input.scratch, 'roundtrip.index')
  const empty = join(input.scratch, 'empty')
  try {
    await mkdir(input.scratch, { mode: 0o700 })
    await mkdir(empty, { mode: 0o700 })
    await writePrivate(patchFile, patch)
    await git.bytes(['read-tree', beforeTree], { limit: 64 * 1024, index, workTree: empty })
    await git.bytes(['apply', '--cached', '--binary', '--whitespace=nowarn', '--', patchFile], { limit: 64 * 1024, index, workTree: empty })
    const tree = (await git.bytes(['write-tree'], { limit: 64 * 1024, index, workTree: empty })).toString('utf8').trim()
    if (tree !== afterTree) fail('output_roundtrip_failed')
  } catch (error) {
    if (error instanceof OutputCaptureError) throw error
    fail('output_roundtrip_failed')
  } finally { await rm(input.scratch, { recursive: true, force: true }) }
  return { patch, files }
}

/** Stores the verified patch read-only under a job-derived directory. The
 * receipt, not this file, remains the job record: a missing file is `artifact_expired`. */
export async function storeOutputArtifact(root: string, jobId: string, input: { patch: Buffer; files: OutputArtifactFile[];
  beforeTree: string; afterTree: string }): Promise<OutputArtifact> {
  const digest = sha256(input.patch), path = outputArtifactPath(root, jobId, digest)
  const directory = resolve(path, '..')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0 || await realpath(root) !== resolve(root)) {
    fail('output_capture_unavailable')
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  try {
    await writePrivate(temporary, input.patch)
    await chmod(temporary, 0o400)
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
  const handle = openSync(directory, constants.O_RDONLY)
  try { fsyncSync(handle) } finally { closeSync(handle) }
  return { id: `patch-${digest.slice(0, 32)}`, digest, bytes: input.patch.length, beforeTree: input.beforeTree,
    afterTree: input.afterTree, files: input.files }
}

/** undefined when the blob is gone. Bytes are returned only if length and digest match the receipt. */
export async function readOutputArtifact(root: string, jobId: string, artifact: Pick<OutputArtifact, 'digest' | 'bytes'>): Promise<Buffer | undefined> {
  if (!/^[a-f0-9]{64}$/.test(artifact.digest)) return undefined
  const path = outputArtifactPath(root, jobId, artifact.digest)
  let info
  try { info = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.bytes) throw new Error('artifact_corrupt')
  const data = await readFile(path)
  if (data.length !== artifact.bytes || sha256(data) !== artifact.digest) throw new Error('artifact_corrupt')
  return data
}

export function outputArtifactPath(root: string, jobId: string, digest: string): string {
  if (!isAbsolute(root) || !/^[a-z0-9][a-z0-9-]{15,79}$/.test(jobId) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_output_artifact_path')
  return join(resolve(root), createHash('sha256').update(jobId).digest('hex').slice(0, 48), `${digest}.patch`)
}

interface RawEntry { srcMode: string; dstMode: string; srcSha: string; dstSha: string; status: string; path: string }
function parseRawDiff(raw: Buffer): RawEntry[] {
  const parts = raw.toString('utf8').split('\0')
  if (parts.at(-1) === '') parts.pop()
  if (parts.length % 2) fail('output_capture_failed')
  const entries: RawEntry[] = []
  for (let index = 0; index < parts.length; index += 2) {
    const header = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([A-Z])$/.exec(parts[index]!)
    if (!header) fail('output_capture_failed')
    entries.push({ srcMode: header![1]!, dstMode: header![2]!, srcSha: header![3]!, dstSha: header![4]!, status: header![5]!, path: parts[index + 1]! })
  }
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
function text(data: Buffer): boolean {
  if (data.includes(0)) return false
  try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); return true } catch { return false }
}
/** The Git tree records the path, not how it was reached: reject links, hard
 * links and non-regular entries on every segment of the actual worktree path. */
async function regularWorktreeFile(root: string, path: string): Promise<void> {
  let current = resolve(root)
  const segments = path.split('/')
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    let info
    try { info = await lstat(current) } catch { fail('output_not_regular') }
    if (info!.isSymbolicLink()) fail('output_link')
    if (index < segments.length - 1 ? !info!.isDirectory() : !info!.isFile()) fail('output_not_regular')
    if (index === segments.length - 1 && info!.nlink !== 1) fail('output_link')
  }
}
async function writePrivate(path: string, data: Buffer): Promise<void> {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    let offset = 0
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset)
    fsyncSync(fd)
  } finally { closeSync(fd) }
}
