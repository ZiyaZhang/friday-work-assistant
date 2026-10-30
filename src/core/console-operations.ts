import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ConsoleActor, ConsoleSessionStore } from './console-sessions.js'

export type ConsoleOperationKind = 'routine.pause' | 'routine.resume' | 'run.stop' | 'work.cancel' | 'work.resume' | 'space.presentation' | 'space.model'
  | 'todo.update' | 'memory.confirm' | 'memory.correct' | 'memory.forget' | 'delivery.reconcile'
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Historical facts only. Form contents, titles, errors and message bodies do not belong in this receipt. */
export interface ConsoleAppliedResult {
  changed: boolean
  state?: 'paused' | 'enabled' | 'stop_requested' | 'already_stopping' | 'already_finished' | 'cancelled' | 'already_cancelled' | 'resumed' | 'already_resumed'
    | 'updated' | 'confirmed' | 'corrected' | 'forgotten' | 'unresolved'
  version?: number
  tag?: string
  enabled?: boolean
  nextRunAt?: number | null
  affectedRunIds?: readonly string[]
  replacementId?: number
  /** delivery.reconcile: what the platform read-back showed for the original receipt. */
  result?: 'confirmed' | 'acknowledged' | 'remote_mismatch' | 'remote_absent' | 'remote_absent_incomplete' | 'unverifiable' | 'read_unavailable' | 'already_confirmed'
}
export type ConsoleRuntimeCleanup = 'not_required' | 'pending' | 'complete'
export interface ConsoleOperationReceipt {
  operationId: string
  appliedAt: number
  appliedResult: ConsoleAppliedResult
  runtimeCleanup: ConsoleRuntimeCleanup
  replayed: boolean
}
export interface ConsoleOperationInput {
  /** Supplied by ConsoleAuth, never read from a browser JSON body. */
  actor: ConsoleActor
  requestId: string
  spaceId: string
  operation: ConsoleOperationKind
  resourceId: string
  /** The host normalizes explicit fields and expected versions before calling this store. Only a digest is retained. */
  input: { [key: string]: Json }
}
export interface ConsoleOperationContext {
  operationId: string
  actor: Readonly<ConsoleActor>
  requestId: string
  spaceId: string
  operation: ConsoleOperationKind
  resourceId: string
}
export interface ConsoleOperationCallbacks {
  /** Synchronous current session/grant/resource access check. Replay does not repeat mutation CAS. */
  authorize(context: ConsoleOperationContext & { mode: 'apply' | 'replay' }): void
  /** Synchronous domain writes; stores may use nested savepoints. No network or runtime cancellation here. */
  persist(context: ConsoleOperationContext): { appliedResult: ConsoleAppliedResult; afterCommit?: () => void | Promise<void> }
  /** Optional, idempotent cleanup of the original receipt's affectedRunIds only. Never repeat domain writes. */
  cleanupReplay?(context: ConsoleOperationContext, appliedResult: ConsoleAppliedResult): void | Promise<void>
}
export class ConsoleOperationError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 500 | 503, readonly code: string, message: string) { super(message); this.name = 'ConsoleOperationError' }
}

interface OperationRow {
  id: string; session_id: string; actor_open_id: string; request_id: string; space_id: string
  operation: ConsoleOperationKind; resource_id: string; input_digest: string; created_at: number; result_json: string | null
}
interface StoredResult { appliedResult: ConsoleAppliedResult; runtimeCleanup: ConsoleRuntimeCleanup }
const OPERATIONS = new Set<ConsoleOperationKind>(['routine.pause', 'routine.resume', 'run.stop', 'work.cancel', 'work.resume', 'space.presentation', 'space.model',
  'todo.update', 'memory.confirm', 'memory.correct', 'memory.forget', 'delivery.reconcile'])
const STATES = new Set(['paused', 'enabled', 'stop_requested', 'already_stopping', 'already_finished', 'cancelled', 'already_cancelled', 'resumed', 'already_resumed',
  'updated', 'confirmed', 'corrected', 'forgotten', 'unresolved'])
const RESULTS = new Set(['confirmed', 'acknowledged', 'remote_mismatch', 'remote_absent', 'remote_absent_incomplete', 'unverifiable', 'read_unavailable', 'already_confirmed'])
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,256}$/.test(value)
const failure = (code: string, message: string) => new ConsoleOperationError(500, code, message)

/** One browser action and its domain writes commit together. This is not a work queue. */
export class ConsoleOperations {
  private readonly now: () => number
  constructor(private readonly db: DatabaseSync, private readonly opts: { sessions: Pick<ConsoleSessionStore, 'isCurrent'>; now?: () => number }) {
    this.now = opts.now ?? Date.now
    db.exec(`CREATE TABLE IF NOT EXISTS console_operations (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, actor_open_id TEXT NOT NULL, request_id TEXT NOT NULL,
      space_id TEXT NOT NULL, operation TEXT NOT NULL, resource_id TEXT NOT NULL, input_digest TEXT NOT NULL,
      created_at INTEGER NOT NULL, result_json TEXT, UNIQUE(session_id,request_id)
    )`)
  }

  /** Whether this browser session already submitted the request; lets callers skip platform reads before a replay. */
  recorded(actor: ConsoleActor, requestId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM console_operations WHERE session_id=? AND request_id=?').get(actor.sessionId, requestId))
  }

  async execute(input: ConsoleOperationInput, callbacks: ConsoleOperationCallbacks): Promise<ConsoleOperationReceipt> {
    const actor = Object.freeze({ ...input.actor })
    this.assertActor(actor)
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.requestId) || !identifier(input.spaceId) || !identifier(input.resourceId) || !OPERATIONS.has(input.operation)) {
      throw new ConsoleOperationError(400, 'invalid_operation', '操作目标或请求标识无效。')
    }
    const inputDigest = createHash('sha256').update(canonical({ spaceId: input.spaceId, operation: input.operation,
      resourceId: input.resourceId, input: input.input })).digest('hex')
    const requested: ConsoleOperationContext = { operationId: randomUUID(), actor, requestId: input.requestId,
      spaceId: input.spaceId, operation: input.operation, resourceId: input.resourceId }
    let context = requested, row: OperationRow, stored: StoredResult, replayed = false
    let afterCommit: (() => void | Promise<void>) | undefined
    // Own the outer transaction: a nested RELEASE is not a commit and must never trigger abort/close.
    try { this.db.exec('BEGIN IMMEDIATE') } catch (error) {
      if (error instanceof Error && /cannot start a transaction within a transaction/i.test(error.message)) {
        throw new ConsoleOperationError(409, 'nested_operation', '人类操作需要独立事务。')
      }
      throw error
    }
    try {
      this.assertActor(actor)
      const existing = this.db.prepare('SELECT * FROM console_operations WHERE session_id=? AND request_id=?')
        .get(actor.sessionId, input.requestId) as unknown as OperationRow | undefined
      if (existing) {
        if (existing.actor_open_id !== actor.openId) throw failure('invalid_receipt', '操作回执身份不一致。')
        context = { ...requested, operationId: existing.id, spaceId: existing.space_id,
          operation: existing.operation, resourceId: existing.resource_id }
      }
      syncCall(callbacks.authorize, { ...context, mode: existing ? 'replay' : 'apply' })
      this.assertActor(actor)
      if (existing) {
        if (existing.input_digest !== inputDigest) throw new ConsoleOperationError(409, 'request_conflict', '同一请求标识已用于不同操作，请重新提交。')
        row = existing
        stored = readResult(row)
        replayed = true
        if (stored.runtimeCleanup === 'pending' && callbacks.cleanupReplay) {
          const result = structuredClone(stored.appliedResult)
          afterCommit = () => callbacks.cleanupReplay!(context, result)
        }
      } else {
        const createdAt = this.now()
        this.db.prepare(`INSERT INTO console_operations
          (id,session_id,actor_open_id,request_id,space_id,operation,resource_id,input_digest,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(context.operationId, actor.sessionId, actor.openId, input.requestId,
            input.spaceId, input.operation, input.resourceId, inputDigest, createdAt)
        const applied = syncCall(callbacks.persist, context)
        const appliedResult = facts(applied?.appliedResult)
        if (applied.afterCommit !== undefined && typeof applied.afterCommit !== 'function') throw failure('invalid_cleanup', '操作清理回调无效。')
        afterCommit = applied.afterCommit
        stored = { appliedResult, runtimeCleanup: afterCommit ? 'pending' : 'not_required' }
        this.db.prepare('UPDATE console_operations SET result_json=? WHERE id=?').run(JSON.stringify(stored), context.operationId)
        row = { id: context.operationId, session_id: actor.sessionId, actor_open_id: actor.openId, request_id: input.requestId,
          space_id: input.spaceId, operation: input.operation, resource_id: input.resourceId, input_digest: inputDigest,
          created_at: createdAt, result_json: JSON.stringify(stored) }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    if (afterCommit) {
      try {
        await afterCommit()
        stored = { ...stored, runtimeCleanup: 'complete' }
        this.db.prepare('UPDATE console_operations SET result_json=? WHERE id=?').run(JSON.stringify(stored), row.id)
      } catch {
        // The domain operation is already durable. Preserve pending cleanup without storing raw errors.
        stored = readResult(this.db.prepare('SELECT * FROM console_operations WHERE id=?').get(row.id) as unknown as OperationRow)
      }
    }
    return { operationId: row.id, appliedAt: row.created_at, appliedResult: stored.appliedResult,
      runtimeCleanup: stored.runtimeCleanup, replayed }
  }

  private assertActor(actor: ConsoleActor): void {
    if (!this.opts.sessions.isCurrent(actor)) throw new ConsoleOperationError(401, 'session_expired', '登录已失效，请重新登录。')
  }
}

function syncCall<A, R>(fn: (arg: A) => R, arg: A): R {
  if (fn.constructor.name === 'AsyncFunction') throw failure('async_operation', '授权和持久操作必须同步执行。')
  const value = fn(arg)
  if (value && typeof value === 'object' && 'then' in value && typeof value.then === 'function') {
    void Promise.resolve(value).catch(() => {})
    throw failure('async_operation', '授权和持久操作必须同步执行。')
  }
  return value
}

function readResult(row: OperationRow): StoredResult {
  let stored: StoredResult
  try { stored = JSON.parse(row.result_json ?? 'null') as StoredResult } catch { throw failure('invalid_receipt', '操作回执不完整。') }
  if (!stored || !['not_required', 'pending', 'complete'].includes(stored.runtimeCleanup)) throw failure('invalid_receipt', '操作回执不完整。')
  return { appliedResult: facts(stored.appliedResult), runtimeCleanup: stored.runtimeCleanup }
}

function facts(input: ConsoleAppliedResult): ConsoleAppliedResult {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.changed !== 'boolean') throw failure('invalid_result', '操作必须返回最小事实回执。')
  for (const [key, value] of Object.entries(input)) {
    const valid = key === 'changed' || key === 'enabled' ? typeof value === 'boolean'
      : key === 'state' ? typeof value === 'string' && STATES.has(value)
      : key === 'version' ? Number.isSafeInteger(value) && Number(value) >= 0
      : key === 'replacementId' ? Number.isSafeInteger(value) && Number(value) > 0
      : key === 'nextRunAt' ? value === null || Number.isSafeInteger(value) && Number(value) >= 0
      : key === 'tag' ? typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
      : key === 'affectedRunIds' ? Array.isArray(value) && value.every(identifier)
      : key === 'result' ? typeof value === 'string' && RESULTS.has(value)
      : false
    if (!valid) throw failure('invalid_result', '操作回执只能保留标识、版本和实际状态。')
  }
  return structuredClone(input)
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (typeof value !== 'object' || seen.has(value)) throw new ConsoleOperationError(400, 'invalid_input', '操作内容必须是规范 JSON。')
  seen.add(value)
  try {
    if (Array.isArray(value)) return `[${[...value].map(item => canonical(item, seen)).join(',')}]`
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ConsoleOperationError(400, 'invalid_input', '操作内容必须是规范 JSON。')
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen)}`).join(',')}}`
  } finally { seen.delete(value) }
}
