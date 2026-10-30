import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync,
  unlinkSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ChangeFileLease, ChangeManager, StagedOutputEntry } from './changes.js'
import { ExecutorClientError, safeExecutorOutputPath, withinExecutorCapture, type ExecutorClient, type ExecutorGuard,
  type ExecutorOutputArtifact, type ExecutorOutputCapture } from './executor-client.js'
import { RepositoryExecutionError, RepositoryExecutionSnapshotChanged, type RepositoryExecutionIdentity, type RepositoryExecutionOutputSource,
  type RepositoryExecutions } from './executions.js'
import { RepositoryFileError, locateRepositoryPath, readRepositoryFile, repositoryRelativePath, repositoryText,
  type RepositoryFileAccess } from './repository-files.js'

export interface RepositoryExecutionOutputIdentity extends RepositoryExecutionIdentity {
  /** Host-only per-file write gate, the same one the repository file broker uses. */
  authorizeFileWrite?(access: RepositoryFileAccess): Promise<{ assertCurrent(): void }>
}
export interface RepositoryExecutionOutputDeps {
  executions: Pick<RepositoryExecutions, 'outputSource' | 'importRecord' | 'beginImport' | 'recordImport' | 'finishImport' | 'conflictImport'>
  client: Pick<ExecutorClient, 'download'>
  changes: Pick<ChangeManager, 'withChange'>
  /** Gateway-private directory for verified artifact copies, outside every worker workspace. */
  outputRoot: string
  now?: () => number
  /** Test-only: runs synchronously after each file is written and recorded. */
  afterFile?(index: number, path: string): void
}
export interface RepositoryExecutionApply { executionId: string; changeId: string; expectedSnapshot: string; artifactDigest: string }
export interface RepositoryExecutionApplyResult {
  executionId: string
  changeId: string
  repo: string
  state: 'applied'
  /** The original input tree the generator ran on. */
  previousSnapshot: string
  /** The change's actual tree after the import (cold hash). Validate this tree again. */
  snapshot: string
  resultTree: string
  treeMatchesArtifact: boolean
  files: { path: string; action: 'created' | 'updated' | 'deleted'; previousDigest: string | null; digest: string | null }[]
  replayed?: true
  resumed?: true
  validation: { localExecution: 'not_run'; ci: 'not_checked' }
}
interface ImportFile {
  path: string
  action: 'created' | 'updated' | 'deleted'
  beforeDigest: string | null
  afterDigest: string | null
  beforeMode: '100644' | '100755' | null
  afterMode: '100644' | '100755' | null
  beforeBlob: string | null
  afterBlob: string | null
  applied: boolean
}
/** Persisted in github_executions.import_json before the first file changes. */
interface ImportIntent {
  version: 1
  artifactDigest: string
  artifactBytes: number
  inputTree: string
  resultTree: string
  runId: string
  taskId: number
  startedAt: number
  files: ImportFile[]
}
type FileState = 'before' | 'after' | 'conflict'

const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/, MODES = new Set(['100644', '100755'])
const MAX_FILE_BYTES = 1024 * 1024
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
const mismatch = (): never => { throw new RepositoryExecutionError('output_mismatch') }

/** Imports a capture job's verified patch into its original change, under the
 * change's publish lock, with a durable per-file intent. The import never
 * decides publication: the caller validates the returned tree and appends it
 * to the same PR through the existing inspectUpdate/updatePr path. */
export class RepositoryExecutionOutputs {
  private readonly now: () => number
  private readonly outputRoot: string
  constructor(private readonly deps: RepositoryExecutionOutputDeps) {
    if (typeof deps.outputRoot !== 'string' || !isAbsolute(deps.outputRoot) || /[\0\r\n]/.test(deps.outputRoot)) {
      throw new Error('执行结果暂存目录必须是网关私有绝对路径')
    }
    this.outputRoot = resolve(deps.outputRoot)
    this.now = deps.now ?? Date.now
  }

  async applyOutput(identity: RepositoryExecutionOutputIdentity, input: RepositoryExecutionApply): Promise<RepositoryExecutionApplyResult> {
    const request = { ...input }
    if (!boundedText(request.executionId, 128) || !boundedText(request.changeId, 128) || typeof request.expectedSnapshot !== 'string' ||
      !SHA.test(request.expectedSnapshot) || typeof request.artifactDigest !== 'string' || !DIGEST.test(request.artifactDigest)) {
      throw new RepositoryExecutionError('invalid_request')
    }
    const authorizeFile = identity.authorizeFileWrite
    if (typeof authorizeFile !== 'function') throw new RepositoryExecutionError('identity_required')
    const source = await this.deps.executions.outputSource(identity, { id: request.executionId, changeId: request.changeId })
    const { actor, guard } = source
    const artifact = this.verifiedArtifact(source, request)
    if (source.importState === 'applied') { guard(); return this.replay(source, artifact) }
    // The first import needs the bytes before taking the change lock; a resumed
    // import uses its recorded blobs and downloads only if they are missing.
    const patch = source.importState === null ? await this.artifactBytes(source, artifact, guard, actor.signal) : undefined
    guard()
    return this.deps.changes.withChange({ cwd: actor.cwd, sessionKey: actor.sessionKey, requesterOpenId: actor.requesterOpenId,
      workKey: actor.workKey, signal: actor.signal, id: source.changeId, assertAuthorized: guard, importOwner: source.id }, async lease => {
      const check = () => { lease.assertCurrent(); guard() }
      check()
      if (lease.id !== source.changeId || lease.repo.toLowerCase() !== source.repo.toLowerCase()) throw new RepositoryExecutionError('scope_mismatch')
      const record = this.deps.executions.importRecord(source.id)
      if (!record) throw new RepositoryExecutionError('not_found')
      if (record.state === 'applied') return this.replay({ ...source, importJson: record.json, importSnapshot: record.snapshot }, artifact)
      if (record.state === null) {
        return this.firstImport(source, artifact, patch ?? await this.artifactBytes(source, artifact, guard, actor.signal), lease, check, authorizeFile)
      }
      return this.resumeImport(source, artifact, record.state, record.json, lease, check, authorizeFile)
    })
  }

  private async firstImport(source: RepositoryExecutionOutputSource, artifact: ExecutorOutputArtifact, patch: Buffer, lease: ChangeFileLease,
    check: () => void, authorizeFile: NonNullable<RepositoryExecutionOutputIdentity['authorizeFileWrite']>): Promise<RepositoryExecutionApplyResult> {
    // Cold tree CAS: the change must still be exactly the generator's input.
    const current = await lease.snapshot(); check()
    if (current !== source.inputTree) throw new RepositoryExecutionSnapshotChanged()
    // Rebuild the whole result in a private index before touching any file.
    const staged = await lease.stageOutput(source.inputTree, patch); check()
    if (staged.tree !== artifact.afterTree) mismatch()
    const files = this.plan(staged.entries, artifact, source.capture!)
    const contents = await this.contents(files, lease, check)
    const verify = await this.authorize(files, source, current, check, authorizeFile)
    // Actual bytes, including ignored files the tree hash does not see.
    if (files.some(file => this.fileState(lease.dir, file) !== 'before')) throw new RepositoryExecutionSnapshotChanged()
    verify()
    const intent: ImportIntent = { version: 1, artifactDigest: artifact.digest, artifactBytes: artifact.bytes, inputTree: source.inputTree,
      resultTree: artifact.afterTree, runId: source.actor.runId, taskId: source.actor.taskId, startedAt: this.now(), files }
    this.deps.executions.beginImport(source.id, JSON.stringify(intent), 'none')
    return this.write(source, intent, contents, lease, verify, false)
  }

  private async resumeImport(source: RepositoryExecutionOutputSource, artifact: ExecutorOutputArtifact, state: 'applying' | 'conflict',
    json: string | null, lease: ChangeFileLease, check: () => void,
    authorizeFile: NonNullable<RepositoryExecutionOutputIdentity['authorizeFileWrite']>): Promise<RepositoryExecutionApplyResult> {
    const intent = parseIntent(json)
    if (!intent || intent.artifactDigest !== artifact.digest || intent.inputTree !== source.inputTree || intent.resultTree !== artifact.afterTree) mismatch()
    // Only exact recorded evidence decides: each file is at its before state,
    // its after state, or neither. Neither is a conflict; nothing is guessed.
    const states = intent!.files.map(file => this.fileState(lease.dir, file))
    const conflicts = intent!.files.filter((_file, index) => states[index] === 'conflict').map(file => file.path)
    for (const [index, file] of intent!.files.entries()) file.applied = states[index] === 'after'
    if (conflicts.length) {
      this.deps.executions.conflictImport(source.id, 'file_changed', JSON.stringify(intent))
      throw importConflict(conflicts)
    }
    const remaining = intent!.files.filter((_file, index) => states[index] === 'before')
    let contents: Map<string, Buffer>
    try { contents = await this.contents(remaining, lease, check) }
    catch (error) {
      check()
      if (!(error instanceof RepositoryExecutionError && error.code === 'output_mismatch')) throw error
      // Recorded blobs are gone from the trusted Git store: stage the verified bytes again.
      const patch = await this.artifactBytes(source, artifact, source.guard, source.actor.signal); check()
      const staged = await lease.stageOutput(source.inputTree, patch); check()
      if (staged.tree !== intent!.resultTree) mismatch()
      contents = await this.contents(remaining, lease, check)
    }
    const current = await lease.snapshot(); check()
    const verify = await this.authorize(remaining, source, current, check, authorizeFile)
    verify()
    if (state === 'conflict') this.deps.executions.beginImport(source.id, JSON.stringify(intent), 'conflict')
    return this.write(source, intent!, contents, lease, verify, true)
  }

  /** Synchronous from the last check to the last write: no await separates the
   * checked authority from the file effects, and each write is a CAS. */
  private async write(source: RepositoryExecutionOutputSource, intent: ImportIntent, contents: Map<string, Buffer>, lease: ChangeFileLease,
    verify: () => void, resumed: boolean): Promise<RepositoryExecutionApplyResult> {
    for (const [index, file] of intent.files.entries()) {
      verify()
      const state = this.fileState(lease.dir, file)
      if (state === 'conflict') {
        this.deps.executions.conflictImport(source.id, 'file_changed', JSON.stringify(intent))
        throw importConflict([file.path])
      }
      if (state === 'before') this.replace(lease.dir, file, contents.get(file.path) ?? null)
      file.applied = true
      this.deps.executions.recordImport(source.id, JSON.stringify(intent))
      this.deps.afterFile?.(index, file.path)
    }
    verify()
    const snapshot = await lease.snapshot(); verify()
    this.deps.executions.finishImport(source.id, JSON.stringify(intent), snapshot)
    rmSync(this.copyDirectory(source.id), { recursive: true, force: true })
    return this.result(source, intent, snapshot, resumed ? { resumed: true } : {})
  }

  private verifiedArtifact(source: RepositoryExecutionOutputSource, request: RepositoryExecutionApply): ExecutorOutputArtifact {
    const receipt = source.receipt, capture = source.capture
    if (!capture || !receipt || receipt.version !== 2 || receipt.state !== 'finished' || receipt.cleanup !== 'confirmed' ||
      receipt.outcome !== 'source_changed' || receipt.result?.status !== 'source_changed' || receipt.result.exitCode !== 0 || !receipt.outputArtifact) {
      throw new RepositoryExecutionError('output_unavailable')
    }
    const artifact = receipt.outputArtifact
    // The provider receipt is bound to this exact input (including capture) by its digest.
    if (receipt.digest !== source.digest || artifact.digest !== request.artifactDigest || artifact.beforeTree !== source.inputTree ||
      receipt.result.beforeTree !== source.inputTree || receipt.result.afterTree !== artifact.afterTree || artifact.bytes > capture.maxBytes ||
      artifact.files.some(file => !safeExecutorOutputPath(file.path) || !withinExecutorCapture(file.path, capture.paths))) mismatch()
    if (request.expectedSnapshot !== source.inputSnapshot || source.inputSnapshot !== source.inputTree) throw new RepositoryExecutionSnapshotChanged()
    return artifact
  }

  /** The staged Git diff must be exactly the provider manifest: same paths,
   * actions, modes and digests. Anything else rejects the whole import. */
  private plan(entries: StagedOutputEntry[], artifact: ExecutorOutputArtifact, capture: ExecutorOutputCapture): ImportFile[] {
    if (entries.length !== artifact.files.length) mismatch()
    const manifest = new Map(artifact.files.map(file => [file.path, file]))
    const files: ImportFile[] = []
    for (const entry of [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      const file = manifest.get(entry.path)
      if (!file || !safeExecutorOutputPath(entry.path) || !withinExecutorCapture(entry.path, capture.paths)) mismatch()
      try { repositoryRelativePath(entry.path) } catch { mismatch() }
      const action = entry.status === 'A' ? 'created' : entry.status === 'D' ? 'deleted' : entry.status === 'M' ? 'updated' : mismatch()
      const beforeMode = action === 'created' ? null : entry.srcMode, afterMode = action === 'deleted' ? null : entry.dstMode
      if ((beforeMode !== null && !MODES.has(beforeMode)) || (afterMode !== null && !MODES.has(afterMode)) ||
        file!.mode !== (afterMode ?? beforeMode) || (file!.beforeDigest === null) !== (action === 'created') ||
        (file!.afterDigest === null) !== (action === 'deleted')) mismatch()
      files.push({ path: entry.path, action, beforeDigest: file!.beforeDigest, afterDigest: file!.afterDigest,
        beforeMode: beforeMode as ImportFile['beforeMode'], afterMode: afterMode as ImportFile['afterMode'],
        beforeBlob: action === 'created' ? null : entry.srcBlob, afterBlob: action === 'deleted' ? null : entry.dstBlob, applied: false })
    }
    return files
  }

  /** Before and after bytes from the trusted Git store, checked against the manifest digests. */
  private async contents(files: ImportFile[], lease: ChangeFileLease, check: () => void): Promise<Map<string, Buffer>> {
    const contents = new Map<string, Buffer>()
    for (const file of files) {
      for (const side of ['before', 'after'] as const) {
        const blob = side === 'before' ? file.beforeBlob : file.afterBlob, digest = side === 'before' ? file.beforeDigest : file.afterDigest
        if (blob === null || digest === null) continue
        let data: Buffer
        try { data = await lease.readBlob(blob) } catch (error) { check(); if (error instanceof RepositoryExecutionError) throw error; return mismatch() }
        check()
        if (data.length > MAX_FILE_BYTES || sha256(data) !== digest) mismatch()
        try { repositoryText(data) } catch { mismatch() }
        if (side === 'after') contents.set(file.path, data)
      }
    }
    return contents
  }

  /** One broker write authorization per path, then a combined guard for every later step. */
  private async authorize(files: ImportFile[], source: RepositoryExecutionOutputSource, snapshot: string, check: () => void,
    authorizeFile: NonNullable<RepositoryExecutionOutputIdentity['authorizeFileWrite']>): Promise<() => void> {
    const grants: { assertCurrent(): void }[] = []
    const verify = () => { check(); for (const grant of grants) grant.assertCurrent() }
    for (const file of files) {
      verify()
      const grant = await authorizeFile({ action: 'write', changeId: source.changeId, repo: source.repo, path: file.path,
        expectedSnapshot: snapshot, expectedDigest: file.beforeDigest, contentDigest: file.afterDigest })
      if (!grant || typeof grant.assertCurrent !== 'function') throw new RepositoryExecutionError('identity_required')
      grants.push(grant)
      verify()
    }
    return verify
  }

  private fileState(root: string, file: ImportFile): FileState {
    let actual: { digest: string; exec: boolean } | null
    try {
      const found = readRepositoryFile(locateRepositoryPath(root, repositoryRelativePath(file.path)))
      actual = { digest: found.digest, exec: (found.mode & 0o100) !== 0 }
    } catch (error) {
      if (error instanceof RepositoryFileError && error.code === 'not_found' || (error as NodeJS.ErrnoException).code === 'ENOENT') actual = null
      else if (error instanceof RepositoryFileError) return 'conflict'
      else throw error
    }
    const matches = (digest: string | null, mode: string | null) =>
      digest === null ? actual === null : actual !== null && actual.digest === digest && actual.exec === (mode === '100755')
    if (matches(file.afterDigest, file.afterMode)) return 'after'
    if (matches(file.beforeDigest, file.beforeMode)) return 'before'
    return 'conflict'
  }

  /** Same atomic rename discipline as the file broker; the temporary file lives in the worktree's Git metadata. */
  private replace(root: string, file: ImportFile, data: Buffer | null): void {
    const segments = repositoryRelativePath(file.path)
    const path = locateRepositoryPath(root, segments, data !== null)
    if (data === null) unlinkSync(path)
    else {
      if (file.afterDigest === null || sha256(data) !== file.afterDigest) mismatch()
      const metadata = join(root, '.git')
      const info = lstatSync(metadata)
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(metadata) !== metadata) throw new RepositoryFileError('unsafe_path')
      let mode = file.afterMode === '100755' ? 0o755 : 0o644
      if (file.action === 'updated') {
        const existing = lstatSync(path).mode & 0o777
        mode = file.afterMode === '100755' ? existing | 0o111 : existing & ~0o111
      }
      const temporary = join(metadata, `friday-output-${randomUUID()}`)
      let fd: number | undefined
      try {
        fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        fchmodSync(fd, mode)
        let offset = 0
        while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset)
        fsyncSync(fd); closeSync(fd); fd = undefined
        renameSync(temporary, path)
      } finally {
        if (fd !== undefined) closeSync(fd)
        rmSync(temporary, { force: true })
      }
    }
    const directory = openSync(dirname(path), constants.O_RDONLY)
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }

  /** Download once, verify, keep a private copy until the import settles. */
  private async artifactBytes(source: RepositoryExecutionOutputSource, artifact: ExecutorOutputArtifact, guard: ExecutorGuard,
    signal?: AbortSignal): Promise<Buffer> {
    const directory = this.copyDirectory(source.id), path = join(directory, `${artifact.digest}.patch`)
    try {
      const copy = readFileSync(path)
      if (copy.length === artifact.bytes && sha256(copy) === artifact.digest) return copy
    } catch { /* absent or unreadable copy: download again */ }
    let data: Buffer
    try { data = await this.deps.client.download(source.id, artifact, guard, signal) }
    catch (error) {
      guard()
      const failure = new RepositoryExecutionError('output_download_failed')
      failure.message = `执行结果下载未完成：${error instanceof ExecutorClientError ? error.code : 'provider_error'}`
      throw failure
    }
    guard()
    if (data.length !== artifact.bytes || sha256(data) !== artifact.digest) mismatch()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        let offset = 0
        while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset)
        fsyncSync(fd)
      } finally { closeSync(fd) }
      renameSync(temporary, path)
    } finally { rmSync(temporary, { force: true }) }
    return data
  }

  private copyDirectory(executionId: string): string {
    return join(this.outputRoot, sha256(executionId).slice(0, 32))
  }

  private replay(source: Pick<RepositoryExecutionOutputSource, 'id' | 'changeId' | 'repo' | 'inputTree' | 'importJson' | 'importSnapshot'>,
    artifact: ExecutorOutputArtifact): RepositoryExecutionApplyResult {
    const intent = parseIntent(source.importJson)
    if (!intent || !source.importSnapshot || intent.artifactDigest !== artifact.digest) mismatch()
    return this.result(source, intent!, source.importSnapshot!, { replayed: true })
  }

  private result(source: Pick<RepositoryExecutionOutputSource, 'id' | 'changeId' | 'repo' | 'inputTree'>, intent: ImportIntent, snapshot: string,
    extra: { replayed?: true; resumed?: true }): RepositoryExecutionApplyResult {
    return { executionId: source.id, changeId: source.changeId, repo: source.repo, state: 'applied', previousSnapshot: source.inputTree,
      snapshot, resultTree: intent.resultTree, treeMatchesArtifact: snapshot === intent.resultTree,
      files: intent.files.map(file => ({ path: file.path, action: file.action, previousDigest: file.beforeDigest, digest: file.afterDigest })),
      ...extra, validation: { localExecution: 'not_run', ci: 'not_checked' } }
  }
}

function importConflict(paths: string[]): RepositoryExecutionError {
  const error = new RepositoryExecutionError('import_conflict')
  error.message = `执行结果导入与修改副本中的文件冲突：${paths.slice(0, 10).join('、')}${paths.length > 10 ? ` 等 ${paths.length} 个文件` : ''}。` +
    '这些文件既不是导入前内容也不是生成结果；已停止写入，读写与发布保持暂停。恢复为其中一种内容后再次调用本工具核对。'
  return error
}

function parseIntent(json: string | null): ImportIntent | undefined {
  if (!json) return undefined
  let value: ImportIntent
  try { value = JSON.parse(json) as ImportIntent } catch { return undefined }
  if (!value || value.version !== 1 || typeof value.artifactDigest !== 'string' || !DIGEST.test(value.artifactDigest) ||
    typeof value.inputTree !== 'string' || !SHA.test(value.inputTree) || typeof value.resultTree !== 'string' || !SHA.test(value.resultTree) ||
    !Array.isArray(value.files) || !value.files.length) return undefined
  for (const file of value.files) {
    if (!file || !safeExecutorOutputPath(file.path) || !['created', 'updated', 'deleted'].includes(file.action) ||
      !(file.beforeDigest === null || DIGEST.test(file.beforeDigest)) || !(file.afterDigest === null || DIGEST.test(file.afterDigest)) ||
      !(file.beforeBlob === null || SHA.test(file.beforeBlob)) || !(file.afterBlob === null || SHA.test(file.afterBlob)) ||
      !(file.beforeMode === null || MODES.has(file.beforeMode)) || !(file.afterMode === null || MODES.has(file.afterMode))) return undefined
  }
  return value
}
