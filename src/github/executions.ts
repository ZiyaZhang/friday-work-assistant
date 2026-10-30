import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ChangeIdentity } from './changes.js'
import { ExecutorClientError, MAX_EXECUTOR_OUTPUT_BYTES, safeExecutorOutputPath, type ExecutorClient, type ExecutorGuard, type ExecutorJobInput,
  type ExecutorJobReceipt, type ExecutorOutputArtifact, type ExecutorOutputCapture } from './executor-client.js'

export interface RepositoryExecutionIdentity extends ChangeIdentity {
  sessionKey: string
  requesterOpenId: string
  workKey: string
  taskId: number
  runId: string
  assertAuthorized(): void
  /** Host-only link to the active API/Run receipt; no model-supplied callback. */
  onExecution?(id: string): void
}
export interface RepositoryExecutionSnapshot { repo: string; baseSha: string; inputTree: string; patch: string }
export interface RepositoryExecutionStart {
  changeId: string; expectedSnapshot: string; command: string; timeoutMs: number
  /** Protocol 2: host-approved relative files or directory prefixes whose changes may be exported. */
  capture?: { paths: string[]; maxBytes?: number }
}
export interface RepositoryExecutionRef { id: string; changeId: string }
export type RepositoryExecutionOperationStatus = 'unresolved' | 'succeeded' | 'failed' | 'cancelled'
export interface RepositoryExecutionDeps {
  db: DatabaseSync
  client: Pick<ExecutorClient, 'submit' | 'read' | 'stop'>
  /** The trusted ChangeManager adapter checks actor/session/Work and the exact
   * expected snapshot. A changed tree throws RepositoryExecutionSnapshotChanged;
   * permission, missing checkout and IO failures remain their own errors. */
  snapshot(identity: RepositoryExecutionIdentity, input: { changeId: string; expectedSnapshot: string }): Promise<RepositoryExecutionSnapshot>
  authorize(identity: RepositoryExecutionIdentity, repo: string): ExecutorGuard | Promise<ExecutorGuard>
  now?: () => number
}
export type RepositoryExecutionErrorCode = 'invalid_request' | 'identity_required' | 'not_found' | 'scope_mismatch'
  | 'snapshot_changed' | 'snapshot_invalid' | 'provider_invalid_receipt' | 'provider_error' | 'receipt_conflict'
  | 'import_pending' | 'output_unavailable' | 'output_mismatch' | 'output_download_failed' | 'import_conflict' | 'import_busy'
export class RepositoryExecutionError extends Error {
  constructor(readonly code: RepositoryExecutionErrorCode) {
    super(`仓库验证尚未完成：${code}`)
    this.name = 'RepositoryExecutionError'
  }
}
export class RepositoryExecutionSnapshotChanged extends RepositoryExecutionError {
  constructor() { super('snapshot_changed'); this.name = 'RepositoryExecutionSnapshotChanged' }
}
/** Thrown by the change boundary while an output import is not settled. The
 * working tree may hold some but not all generated files. */
export class RepositoryExecutionImportPending extends RepositoryExecutionError {
  constructor(readonly executionId: string, readonly state: 'applying' | 'conflict') {
    super('import_pending')
    this.name = 'RepositoryExecutionImportPending'
    this.message = `修改副本有未完成的执行结果导入（${executionId}，${state === 'conflict' ? '有冲突' : '尚未核对完成'}）；读写、验证和发布都已暂停。请用原执行编号再次调用 github_apply_change_check_output 核对并完成这次导入。`
  }
}
export interface RepositoryExecutionOutputView {
  capture: { paths: string[]; maxBytes: number }
  /** pending: job not finished; unchanged: command changed nothing; ready: artifact can be imported;
   * rejected: output refused by the provider; not_produced: command failed, stopped or timed out. */
  state: 'pending' | 'unchanged' | 'ready' | 'rejected' | 'not_produced' | 'importing' | 'imported' | 'conflict'
  artifact: Pick<ExecutorOutputArtifact, 'digest' | 'bytes' | 'beforeTree' | 'afterTree' | 'files'> | null
  error: string | null
  importedSnapshot: string | null
}
export interface RepositoryExecutionView {
  id: string
  changeId: string
  repo: string
  inputTree: string
  inputSnapshot: string
  command: string
  timeoutMs: number
  state: 'submitting' | 'unknown' | 'rejected' | 'active' | 'stopping' | 'finished'
  validation: 'pending' | 'passed' | 'not_passed' | 'stale' | 'unknown' | 'not_run'
  snapshotCurrent: 'current' | 'stale' | 'not_checked'
  errorCode: string | null
  stopRequested: boolean
  receipt: ExecutorJobReceipt | null
  /** null for a job without capture (protocol 1). */
  output: RepositoryExecutionOutputView | null
  createdAt: number
  updatedAt: number
}
/** Host-only source for importing a capture job's artifact; never a model DTO. */
export interface RepositoryExecutionOutputSource {
  actor: RepositoryExecutionIdentity
  guard: ExecutorGuard
  id: string
  changeId: string
  repo: string
  inputTree: string
  inputSnapshot: string
  digest: string
  capture: ExecutorOutputCapture | null
  receipt: ExecutorJobReceipt | null
  importState: 'applying' | 'applied' | 'conflict' | null
  importJson: string | null
  importSnapshot: string | null
}
const IMPORT_COLUMNS: [string, string][] = [
  ['capture_json', 'TEXT'],
  ['import_state', "TEXT CHECK (import_state IN ('applying','applied','conflict'))"],
  ['import_json', 'TEXT'],
  ['import_error', 'TEXT'],
  ['import_snapshot', 'TEXT'],
  ['import_updated_at', 'INTEGER'],
]
/** A settled import (applied) or none is open; applying/conflict must be reconciled first. */
export function pendingExecutionImport(db: DatabaseSync, changeId: string): { id: string; state: 'applying' | 'conflict' } | undefined {
  if (!importColumns(db)) return undefined
  const row = db.prepare(`SELECT id,import_state FROM github_executions WHERE change_id=? AND import_state IN ('applying','conflict')
    ORDER BY created_at,rowid LIMIT 1`).get(changeId) as { id: string; import_state: 'applying' | 'conflict' } | undefined
  return row ? { id: row.id, state: row.import_state } : undefined
}
const importReady = new WeakSet<DatabaseSync>()
function importColumns(db: DatabaseSync): boolean {
  if (importReady.has(db)) return true
  const names = new Set((db.prepare('PRAGMA table_info(github_executions)').all() as { name: string }[]).map(column => column.name))
  if (!IMPORT_COLUMNS.every(([name]) => names.has(name))) return false
  importReady.add(db)
  return true
}

/** Only provider-operation facts live here; Work/Task/Run and user permissions
 * retain their existing owners. No credentials, patch bytes or checkout paths. */
export function ensureGitHubExecutionSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS github_executions (
    id TEXT PRIMARY KEY,
    operation_key TEXT NOT NULL UNIQUE,
    session_key TEXT NOT NULL,
    requester_open_id TEXT NOT NULL,
    work_key TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    origin_run_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    input_tree TEXT NOT NULL,
    input_snapshot TEXT NOT NULL,
    command TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL,
    digest TEXT NOT NULL,
    submission_status TEXT NOT NULL CHECK (submission_status IN ('claimed','unknown','not_sent','rejected','accepted')),
    request_seq INTEGER NOT NULL DEFAULT 0,
    receipt_seq INTEGER NOT NULL DEFAULT 0,
    receipt_json TEXT,
    error_code TEXT,
    stop_requested_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    capture_json TEXT,
    import_state TEXT CHECK (import_state IN ('applying','applied','conflict')),
    import_json TEXT,
    import_error TEXT,
    import_snapshot TEXT,
    import_updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_github_executions_work ON github_executions(work_key,change_id,created_at);`)
  // Schema-only and idempotent: an existing ledger gains nullable columns; old
  // rows keep NULL, meaning a protocol 1 job with no output import.
  const names = new Set((db.prepare('PRAGMA table_info(github_executions)').all() as { name: string }[]).map(column => column.name))
  for (const [name, type] of IMPORT_COLUMNS) if (!names.has(name)) db.exec(`ALTER TABLE github_executions ADD COLUMN ${name} ${type}`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_github_executions_import ON github_executions(change_id)
    WHERE import_state IN ('applying','conflict')`)
}

interface ExecutionRow {
  id: string; operation_key: string; session_key: string; requester_open_id: string; work_key: string; task_id: number
  origin_run_id: string; change_id: string; repo: string; base_sha: string; input_tree: string; input_snapshot: string
  command: string; timeout_ms: number; digest: string; submission_status: 'claimed' | 'unknown' | 'not_sent' | 'rejected' | 'accepted'
  request_seq: number; receipt_seq: number; receipt_json: string | null; error_code: string | null; stop_requested_at: number | null
  created_at: number; updated_at: number
  capture_json: string | null; import_state: 'applying' | 'applied' | 'conflict' | null; import_json: string | null
  import_error: string | null; import_snapshot: string | null; import_updated_at: number | null
}
const SHA = /^[a-f0-9]{40}$/
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
/** Sorted so the same scope always yields the same digest and operation key. */
function captureSpec(input: unknown): ExecutorOutputCapture {
  const value = input as { paths?: unknown; maxBytes?: unknown } | null
  const maxBytes = value?.maxBytes ?? MAX_EXECUTOR_OUTPUT_BYTES
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'paths' && key !== 'maxBytes') ||
    !Array.isArray(value.paths) || value.paths.length < 1 || value.paths.length > 64 || !value.paths.every(safeExecutorOutputPath) ||
    new Set(value.paths).size !== value.paths.length || value.paths.reduce((total: number, path: string) => total + Buffer.byteLength(path), 0) > 8 * 1024 ||
    !Number.isSafeInteger(maxBytes) || Number(maxBytes) < 1 || Number(maxBytes) > MAX_EXECUTOR_OUTPUT_BYTES) throw new RepositoryExecutionError('invalid_request')
  return { kind: 'repository_patch', paths: [...value.paths as string[]].sort(), maxBytes: Number(maxBytes) }
}

export class RepositoryExecutions {
  private readonly db: DatabaseSync
  private readonly now: () => number
  constructor(private readonly deps: RepositoryExecutionDeps) {
    this.db = deps.db; this.now = deps.now ?? Date.now
    ensureGitHubExecutionSchema(this.db)
  }

  async start(identity: RepositoryExecutionIdentity, input: RepositoryExecutionStart): Promise<RepositoryExecutionView> {
    const actor = this.identity(identity), request = { ...input }
    if (!boundedText(request.changeId, 128) || !SHA.test(request.expectedSnapshot) || !boundedText(request.command, 16 * 1024) ||
      Buffer.byteLength(request.command) > 16 * 1024 || !request.command.trim() || !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1000 || request.timeoutMs > 12 * 60_000) throw new RepositoryExecutionError('invalid_request')
    const capture = request.capture === undefined ? undefined : captureSpec(request.capture)
    const snapshot = { ...await this.deps.snapshot(actor, { changeId: request.changeId, expectedSnapshot: request.expectedSnapshot }) }
    actor.assertAuthorized(); this.validateSnapshot(snapshot)
    const guard = await this.authorize(actor, snapshot.repo)
    const spec: ExecutorJobInput = { repo: snapshot.repo, baseSha: snapshot.baseSha, inputTree: snapshot.inputTree,
      patch: snapshot.patch, command: request.command, timeoutMs: request.timeoutMs, ...(capture ? { capture } : {}) }
    const digest = hash(spec)
    // A job without capture keeps its protocol 1 operation key and digest.
    const operationKey = hash(capture ? ['github_execution_v2', actor.workKey, actor.taskId, request.changeId,
      snapshot.inputTree, request.command, request.timeoutMs, capture] : ['github_execution_v1', actor.workKey, actor.taskId, request.changeId,
      snapshot.inputTree, request.command, request.timeoutMs])
    guard()
    const now = this.now(), id = `exec-${randomUUID()}`
    const created = Number(this.db.prepare(`INSERT INTO github_executions
      (id,operation_key,session_key,requester_open_id,work_key,task_id,origin_run_id,change_id,repo,base_sha,input_tree,input_snapshot,
       command,timeout_ms,digest,submission_status,created_at,updated_at,capture_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'claimed',?,?,?) ON CONFLICT(operation_key) DO NOTHING`)
      .run(id, operationKey, actor.sessionKey, actor.requesterOpenId, actor.workKey, actor.taskId, actor.runId,
        request.changeId, snapshot.repo, snapshot.baseSha, snapshot.inputTree, request.expectedSnapshot, request.command,
        request.timeoutMs, digest, now, now, capture ? JSON.stringify(capture) : null).changes) === 1
    const row = this.byOperation(operationKey)!
    this.bound(actor, { id: row.id, changeId: request.changeId }, row)
    if (row.digest !== digest || row.repo !== snapshot.repo || row.base_sha !== snapshot.baseSha || row.input_snapshot !== request.expectedSnapshot) {
      throw new RepositoryExecutionError('snapshot_invalid')
    }
    actor.onExecution?.(row.id)
    // A duplicate input, another Run or a restarted gateway never re-POSTs.
    // A claimed row may represent a crash immediately before or after submit.
    const seq = this.beginRequest(row.id)
    await this.provider(actor, row, guard, seq, created ? 'submit' : 'read', created ? spec : undefined)
    return this.project(actor, this.get(row.id)!, guard, true)
  }

  async read(identity: RepositoryExecutionIdentity, input: RepositoryExecutionRef): Promise<RepositoryExecutionView> {
    const actor = this.identity(identity), row = this.bound(actor, { ...input })
    actor.onExecution?.(row.id)
    const guard = await this.authorize(actor, row.repo)
    await this.provider(actor, row, guard, this.beginRequest(row.id), 'read')
    return this.project(actor, this.get(row.id)!, guard, true)
  }

  async stop(identity: RepositoryExecutionIdentity, input: RepositoryExecutionRef): Promise<RepositoryExecutionView> {
    const actor = this.identity(identity), row = this.bound(actor, { ...input })
    actor.onExecution?.(row.id)
    const guard = await this.authorize(actor, row.repo)
    guard()
    this.db.prepare('UPDATE github_executions SET stop_requested_at=COALESCE(stop_requested_at,?),updated_at=? WHERE id=?')
      .run(this.now(), this.now(), row.id)
    await this.provider(actor, row, guard, this.beginRequest(row.id), 'stop')
    const current = this.get(row.id)!
    // A changed/deleted working tree must not prevent stopping the admitted VM.
    // Only an already-finished passed result needs a current-tree comparison.
    return this.project(actor, current, guard, this.receipt(current)?.outcome === 'passed')
  }

  /** Trusted host projection of the historical input-tree operation. This is
   * neither user authorization nor proof that the checkout is still that tree;
   * current-code validation must use read() and its snapshotCurrent check. */
  operationStatus(id: string): RepositoryExecutionOperationStatus | undefined {
    const row = this.get(id)
    if (!row) return undefined
    const receipt = this.receipt(row)
    if (!receipt) return row.submission_status === 'not_sent' || row.submission_status === 'rejected' ? 'failed' : 'unresolved'
    if (receipt.state !== 'finished' || receipt.cleanup !== 'confirmed') return 'unresolved'
    if (receipt.outcome === 'cancelled') return 'cancelled'
    // A generated artifact settles its operation only once imported into the change.
    if (row.capture_json && receipt.outputArtifact) return row.import_state === 'applied' ? 'succeeded' : 'unresolved'
    return this.passedInput(row, receipt) ? 'succeeded' : 'failed'
  }

  /** Host-only: the bound original capture execution for an import. It
   * re-checks the actor's current Work/session/requester and repository access. */
  async outputSource(identity: RepositoryExecutionIdentity, input: RepositoryExecutionRef): Promise<RepositoryExecutionOutputSource> {
    const actor = this.identity(identity), row = this.bound(actor, { ...input })
    actor.onExecution?.(row.id)
    const guard = await this.authorize(actor, row.repo)
    const current = this.get(row.id)!
    return { actor, guard, id: current.id, changeId: current.change_id, repo: current.repo, inputTree: current.input_tree,
      inputSnapshot: current.input_snapshot, digest: current.digest,
      capture: current.capture_json ? JSON.parse(current.capture_json) as ExecutorOutputCapture : null,
      receipt: this.receipt(current), importState: current.import_state, importJson: current.import_json, importSnapshot: current.import_snapshot }
  }
  /** Host-only current import record of an already bound execution. */
  importRecord(id: string): { state: 'applying' | 'applied' | 'conflict' | null; json: string | null; snapshot: string | null; error: string | null } | undefined {
    const row = this.get(id)
    return row ? { state: row.import_state, json: row.import_json, snapshot: row.import_snapshot, error: row.import_error } : undefined
  }
  /** Records the import intent before the first file changes. Only one import per execution. */
  beginImport(id: string, intent: string, from: 'none' | 'applying' | 'conflict'): void {
    const changed = this.db.prepare(`UPDATE github_executions SET import_state='applying',import_json=?,import_error=NULL,import_updated_at=?
      WHERE id=? AND ${from === 'none' ? 'import_state IS NULL' : 'import_state=?'}`)
      .run(...[intent, this.now(), id, ...(from === 'none' ? [] : [from])]).changes
    if (Number(changed) !== 1) throw new RepositoryExecutionError('import_busy')
  }
  /** Per-file progress; the reconciler still trusts only the actual file digests. */
  recordImport(id: string, intent: string): void {
    const changed = this.db.prepare("UPDATE github_executions SET import_json=?,import_updated_at=? WHERE id=? AND import_state='applying'")
      .run(intent, this.now(), id).changes
    if (Number(changed) !== 1) throw new RepositoryExecutionError('import_busy')
  }
  finishImport(id: string, intent: string, snapshot: string): void {
    const changed = this.db.prepare(`UPDATE github_executions SET import_state='applied',import_json=?,import_snapshot=?,import_error=NULL,
      import_updated_at=? WHERE id=? AND import_state='applying'`).run(intent, snapshot, this.now(), id).changes
    if (Number(changed) !== 1) throw new RepositoryExecutionError('import_busy')
  }
  /** The working tree is neither the recorded before nor after state for some file. */
  conflictImport(id: string, code: string, intent?: string): void {
    this.db.prepare(`UPDATE github_executions SET import_state='conflict',import_error=?,import_json=COALESCE(?,import_json),import_updated_at=?
      WHERE id=? AND import_state IN ('applying','conflict')`).run(code, intent ?? null, this.now(), id)
  }

  private identity(input: RepositoryExecutionIdentity): RepositoryExecutionIdentity {
    const identity = { ...input }
    if (!boundedText(identity.sessionKey, 512) || !boundedText(identity.requesterOpenId, 256) ||
      !boundedText(identity.workKey, 200) || !boundedText(identity.runId, 128) || !Number.isSafeInteger(identity.taskId) ||
      identity.taskId <= 0 || typeof identity.assertAuthorized !== 'function') throw new RepositoryExecutionError('identity_required')
    const assert = identity.assertAuthorized
    identity.assertAuthorized = () => { identity.signal?.throwIfAborted(); assert() }
    identity.assertAuthorized()
    return identity
  }
  private async authorize(actor: RepositoryExecutionIdentity, repo: string): Promise<ExecutorGuard> {
    actor.assertAuthorized()
    const access = await this.deps.authorize(actor, repo)
    actor.assertAuthorized()
    if (typeof access !== 'function') throw new RepositoryExecutionError('identity_required')
    const guard = () => { actor.assertAuthorized(); access() }
    guard(); return guard
  }
  private bound(actor: RepositoryExecutionIdentity, input: RepositoryExecutionRef, existing?: ExecutionRow): ExecutionRow {
    actor.assertAuthorized()
    if (!boundedText(input.id, 128) || !boundedText(input.changeId, 128)) throw new RepositoryExecutionError('invalid_request')
    const row = existing ?? this.get(input.id)
    if (!row) throw new RepositoryExecutionError('not_found')
    if (row.id !== input.id || row.change_id !== input.changeId || row.session_key !== actor.sessionKey ||
      row.requester_open_id !== actor.requesterOpenId || row.work_key !== actor.workKey) throw new RepositoryExecutionError('scope_mismatch')
    return row
  }
  private validateSnapshot(snapshot: RepositoryExecutionSnapshot): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(snapshot.repo) || snapshot.repo.endsWith('.git') ||
      !SHA.test(snapshot.baseSha) || !SHA.test(snapshot.inputTree) || typeof snapshot.patch !== 'string' ||
      Buffer.byteLength(snapshot.patch) > 2 * 1024 * 1024) throw new RepositoryExecutionError('snapshot_invalid')
  }
  private beginRequest(id: string): number {
    const row = this.db.prepare('UPDATE github_executions SET request_seq=request_seq+1 WHERE id=? RETURNING request_seq').get(id)!
    return Number(row.request_seq)
  }
  private async provider(actor: RepositoryExecutionIdentity, row: ExecutionRow, guard: ExecutorGuard, seq: number,
    operation: 'submit' | 'read' | 'stop', input?: ExecutorJobInput): Promise<void> {
    guard()
    let receipt: ExecutorJobReceipt
    try {
      receipt = operation === 'submit' ? await this.deps.client.submit(row.id, input!, guard, actor.signal)
        : await this.deps.client[operation](row.id, guard, actor.signal)
    } catch (error) {
      // This is an observation about the already-claimed operation, not a fresh
      // action. It remains durable even if the original caller lost authority.
      this.failure(row.id, operation, error)
      guard()
      if (!(error instanceof ExecutorClientError)) throw new RepositoryExecutionError('provider_error')
      return
    }
    // Preserve a genuine ACK before checking the caller again. Losing the Run
    // cannot erase a started provider operation or authorize a subsequent one.
    this.acceptReceipt(row.id, receipt, seq, operation)
    guard()
  }
  private acceptReceipt(id: string, incoming: ExecutorJobReceipt, seq: number, operation: 'submit' | 'read' | 'stop'): void {
    const row = this.get(id)!
    // A stop can overtake an unacknowledged submit. This tombstone proves only
    // that this job id is sealed; it never attests that the input was executed.
    const tombstone = operation !== 'submit' && incoming.digest === null && incoming.state === 'finished' &&
      incoming.outcome === 'cancelled' && incoming.cleanup === 'confirmed' && incoming.startedAt === null &&
      incoming.result === null && incoming.deadline === null && incoming.finishedAt !== null
    // A capture job's receipt is protocol 2; a stop tombstone is always protocol 1.
    const version = tombstone ? 1 : row.capture_json ? 2 : 1
    if (incoming.id !== id || incoming.version !== version || incoming.digest !== row.digest && !tombstone) {
      this.db.prepare("UPDATE github_executions SET error_code='provider_invalid_receipt',updated_at=? WHERE id=?").run(this.now(), id)
      throw new RepositoryExecutionError('provider_invalid_receipt')
    }
    const receipt = this.copyReceipt(incoming), encoded = JSON.stringify(receipt)
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw new RepositoryExecutionError('provider_invalid_receipt')
    const previous = this.receipt(row)
    if (previous?.state === 'finished') {
      if (receipt.state === 'finished' && JSON.stringify(receipt) !== JSON.stringify(previous)) throw new RepositoryExecutionError('receipt_conflict')
      return // Neither a late queued response nor an error can undo a terminal ACK.
    }
    const rank = { queued: 0, running: 1, stopping: 2, finished: 3 }
    if (previous && (rank[receipt.state] < rank[previous.state] || seq < row.receipt_seq && rank[receipt.state] <= rank[previous.state])) return
    this.db.prepare(`UPDATE github_executions SET receipt_json=?,receipt_seq=?,submission_status='accepted',error_code=NULL,updated_at=? WHERE id=?`)
      .run(encoded, Math.max(seq, row.receipt_seq), this.now(), id)
  }
  private failure(id: string, operation: 'submit' | 'read' | 'stop', error: unknown): void {
    const row = this.get(id)!
    const code = error instanceof ExecutorClientError ? error.code : 'provider_error'
    let status = row.submission_status
    if (!row.receipt_json && operation === 'submit') status = error instanceof ExecutorClientError &&
      (error.result === 'not_sent' || error.result === 'rejected') ? error.result : 'unknown'
    else if (!row.receipt_json && status === 'claimed') status = 'unknown'
    this.db.prepare('UPDATE github_executions SET submission_status=?,error_code=?,updated_at=? WHERE id=?')
      .run(status, code, this.now(), id)
  }
  private async project(actor: RepositoryExecutionIdentity, row: ExecutionRow, guard: ExecutorGuard, compare: boolean): Promise<RepositoryExecutionView> {
    let snapshotCurrent: RepositoryExecutionView['snapshotCurrent'] = 'not_checked'
    if (compare) {
      guard()
      try {
        const snapshot = await this.deps.snapshot(actor, { changeId: row.change_id, expectedSnapshot: row.input_snapshot })
        guard(); this.validateSnapshot(snapshot)
        snapshotCurrent = snapshot.repo === row.repo && snapshot.baseSha === row.base_sha && snapshot.inputTree === row.input_tree ? 'current' : 'stale'
      } catch (error) {
        guard()
        // An unsettled import means the tree is not the tested input either.
        if (!(error instanceof RepositoryExecutionSnapshotChanged) && !(error instanceof RepositoryExecutionImportPending)) throw error
        snapshotCurrent = 'stale'
      }
    }
    guard()
    // Another request may have acknowledged stop while this view read Git.
    const latest = this.get(row.id)!, receipt = this.receipt(latest)
    const state: RepositoryExecutionView['state'] = receipt?.state === 'finished' ? 'finished'
      : latest.stop_requested_at !== null || receipt?.state === 'stopping' ? 'stopping'
      : receipt ? 'active' : ['not_sent', 'rejected'].includes(latest.submission_status) ? 'rejected'
      : latest.submission_status === 'claimed' ? 'submitting' : 'unknown'
    let validation: RepositoryExecutionView['validation'] = receipt ? 'pending' : state === 'rejected' ? 'not_run' : 'unknown'
    if (receipt?.state === 'finished' && receipt.cleanup === 'confirmed') {
      validation = this.passedInput(row, receipt) && snapshotCurrent === 'current'
        ? 'passed' : 'not_passed'
      if (receipt.digest === null && receipt.outcome === 'cancelled') validation = 'not_run'
    }
    if (snapshotCurrent === 'stale') validation = 'stale'
    return { id: row.id, changeId: row.change_id, repo: row.repo, inputTree: row.input_tree, inputSnapshot: row.input_snapshot,
      command: row.command, timeoutMs: row.timeout_ms, state, validation, snapshotCurrent, errorCode: latest.error_code,
      stopRequested: latest.stop_requested_at !== null, receipt, output: this.outputView(latest, receipt),
      createdAt: row.created_at, updatedAt: latest.updated_at }
  }
  private outputView(row: ExecutionRow, receipt: ExecutorJobReceipt | null): RepositoryExecutionOutputView | null {
    if (!row.capture_json) return null
    const capture = JSON.parse(row.capture_json) as ExecutorOutputCapture, artifact = receipt?.outputArtifact ?? null
    const settled = receipt?.state === 'finished' && receipt.cleanup === 'confirmed'
    const state: RepositoryExecutionOutputView['state'] = row.import_state === 'applied' ? 'imported' : row.import_state === 'applying' ? 'importing'
      : row.import_state === 'conflict' ? 'conflict' : !settled ? 'pending' : artifact ? 'ready' : receipt?.outputError ? 'rejected'
        : receipt?.outcome === 'passed' ? 'unchanged' : 'not_produced'
    return { capture: { paths: [...capture.paths], maxBytes: capture.maxBytes }, state,
      artifact: artifact && settled ? { digest: artifact.digest, bytes: artifact.bytes, beforeTree: artifact.beforeTree,
        afterTree: artifact.afterTree, files: artifact.files.map(file => ({ ...file })) } : null,
      error: row.import_error ?? receipt?.outputError ?? null, importedSnapshot: row.import_snapshot }
  }
  private passedInput(row: ExecutionRow, receipt: ExecutorJobReceipt): boolean {
    const result = receipt.result
    return receipt.state === 'finished' && receipt.cleanup === 'confirmed' && receipt.digest === row.digest &&
      receipt.outcome === 'passed' && result?.status === 'passed' && result.exitCode === 0 && result.phase === 'command' &&
      result.beforeTree === row.input_tree && result.afterTree === row.input_tree && !result.output.truncated
  }
  private copyReceipt(receipt: ExecutorJobReceipt): ExecutorJobReceipt {
    const artifact = receipt.outputArtifact
    return { version: receipt.version, id: receipt.id, digest: receipt.digest, state: receipt.state, outcome: receipt.outcome,
      createdAt: receipt.createdAt, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt, deadline: receipt.deadline, cleanup: receipt.cleanup,
      result: receipt.result ? { status: receipt.result.status, phase: receipt.result.phase, beforeTree: receipt.result.beforeTree,
        afterTree: receipt.result.afterTree, exitCode: receipt.result.exitCode, runtime: receipt.result.runtime,
        output: { stdout: receipt.result.output.stdout, stderr: receipt.result.output.stderr, truncated: receipt.result.output.truncated } } : null,
      ...(receipt.version === 2 ? { outputError: receipt.outputError ?? null,
        outputArtifact: artifact ? { id: artifact.id, digest: artifact.digest, bytes: artifact.bytes, beforeTree: artifact.beforeTree,
          afterTree: artifact.afterTree, files: artifact.files.map(file => ({ path: file.path, beforeDigest: file.beforeDigest,
            afterDigest: file.afterDigest, mode: file.mode })) } : null } : {}) }
  }
  private receipt(row: ExecutionRow): ExecutorJobReceipt | null { return row.receipt_json ? JSON.parse(row.receipt_json) as ExecutorJobReceipt : null }
  private get(id: string): ExecutionRow | undefined { return this.db.prepare('SELECT * FROM github_executions WHERE id=?').get(id) as unknown as ExecutionRow | undefined }
  private byOperation(key: string): ExecutionRow | undefined { return this.db.prepare('SELECT * FROM github_executions WHERE operation_key=?').get(key) as unknown as ExecutionRow | undefined }
}
