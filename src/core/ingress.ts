/** A receipt for one inbound routing decision. It is not a second work-item store. */
import type { DatabaseSync } from 'node:sqlite'
import { IngressClassificationError, type IngressClassificationInput, type IngressDecision } from '../acp/ingress-classifier.js'
import type { InboundMessage } from '../feishu/mention.js'
import type { TaskRow } from './registry.js'
import type { InboundMaterialReference } from './inbound-materials.js'

export interface RoutingHandoff {
  /** The host revalidates this captured binding before resuming the original entry point. */
  route?: { kind: 'task' } | { kind: 'question'; questionId: number; anchorId: number; originTaskId: number }
    | { kind: 'stopped_feedback'; feedbackId: number; originSessionKey?: string;
        observation?: { lastReportId: number; lastControlRowId: number } }
  message: InboundMessage
  spaceId: string
  sessionKey: string
  targets: { ref: string; task: TaskRow; runId?: string; sessionHeadTaskId?: number;
    workInputTaskId?: number; workControlEpoch?: number }[]
  input: IngressClassificationInput
  materials?: InboundMaterialReference[]
  /** False means the immutable envelope/refs are saved but previews still need I/O.
   * Absence preserves existing fully prepared handoffs. */
  materialsPrepared?: boolean
  /** Idle conversation classified only to detect a human memory control; ordinary work keeps its session. */
  memoryControlsOnly?: boolean
  decision?: IngressDecision
}

export type IngressFailureCode = IngressClassificationError['code'] | 'unexpected'
export interface IngressClassificationAttempt { messageId: string; attempt: number; expiresAt: number }
export interface IngressFailure { code: IngressFailureCode; attemptCount: number; retryAt: number | null; phase: 'transient' | 'terminal' }
export interface IngressFailureNoticeText { transient: string; terminal: string }
interface ClassificationRow { attempt_count: number; last_failure_code: IngressFailureCode | null; retry_at: number | null }
/** This is a model-request budget, not a second work queue. A transient outage or
 * classifier lifecycle stop gets two spaced retries; bad protocol needs investigation. */
export const INGRESS_CLASSIFICATION_MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [60_000, 180_000] as const
export function ingressFailureCode(error: unknown): IngressFailureCode {
  return error instanceof IngressClassificationError ? error.code : 'unexpected'
}

export class IngressReceipts {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS ingress_routes (
      message_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      actor_open_id TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      decision TEXT,
      result TEXT,
      created_at INTEGER NOT NULL
    )`)
    const columns = new Set((db.prepare('PRAGMA table_info(ingress_routes)').all() as { name: string }[]).map(row => row.name))
    if (!columns.has('handoff')) db.exec('ALTER TABLE ingress_routes ADD COLUMN handoff TEXT')
    if (!columns.has('notice')) db.exec('ALTER TABLE ingress_routes ADD COLUMN notice TEXT')
    if (!columns.has('attempt_count')) db.exec('ALTER TABLE ingress_routes ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0')
    if (!columns.has('last_failure_code')) db.exec('ALTER TABLE ingress_routes ADD COLUMN last_failure_code TEXT')
    if (!columns.has('retry_at')) db.exec('ALTER TABLE ingress_routes ADD COLUMN retry_at INTEGER')
  }

  claim(messageId: string, spaceId: string, actor: string, snapshot: unknown, now: number): boolean {
    // Ordinary tasks and control messages share the same ingress identity.
    if (this.db.prepare('SELECT 1 FROM task_receipts WHERE dedup_key = ?').get(messageId)) return false
    return Boolean(this.db.prepare(`INSERT OR IGNORE INTO ingress_routes
      (message_id, space_id, actor_open_id, snapshot, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      messageId, spaceId, actor, JSON.stringify(snapshot), now,
    ).changes)
  }

  has(messageId: string): boolean {
    // A received/classified handoff has not consumed the message. Legacy rows lack
    // the original envelope, so retain their previous non-replay behavior.
    return Boolean(this.db.prepare('SELECT 1 FROM ingress_routes WHERE message_id = ? AND (result IS NOT NULL OR handoff IS NULL)').get(messageId))
  }

  applied(messageId: string, decision: unknown, result: string): void {
    this.db.prepare('UPDATE ingress_routes SET decision = ?, result = ? WHERE message_id = ? AND result IS NULL')
      .run(JSON.stringify(decision), result, messageId)
  }

  /** Host invalidation is not a model decision. Retain the original envelope and
   * any prior classifier facts, but prevent a late callback or poll from reviving it. */
  retire(messageId: string, result: string): boolean {
    if (!result) throw new Error('Missing ingress retirement reason')
    return Boolean(this.db.prepare("UPDATE ingress_routes SET result = ?, retry_at = NULL, notice = NULL WHERE message_id = ? AND (result IS NULL OR result = 'classification_failed')")
      .run(result, messageId).changes)
  }

  receive(handoff: RoutingHandoff, now: number): RoutingHandoff | undefined {
    const id = handoff.message.messageId
    if (this.has(id) || this.db.prepare('SELECT 1 FROM task_receipts WHERE dedup_key = ?').get(id)) return undefined
    this.db.prepare(`INSERT OR IGNORE INTO ingress_routes
      (message_id, space_id, actor_open_id, snapshot, handoff, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, handoff.spaceId, handoff.message.senderOpenId!, JSON.stringify(handoff.targets), JSON.stringify(handoff), now)
    return this.pending(id)[0]
  }

  pending(messageId?: string): RoutingHandoff[] {
    const rows = this.db.prepare(`SELECT handoff, decision FROM ingress_routes WHERE handoff IS NOT NULL AND result IS NULL
      ${messageId === undefined ? '' : 'AND message_id = ?'} ORDER BY created_at, message_id`)
      .all(...(messageId === undefined ? [] : [messageId])) as { handoff: string; decision: string | null }[]
    return rows.map(row => ({ ...JSON.parse(row.handoff), ...(row.decision ? { decision: JSON.parse(row.decision) } : {}) }))
  }

  /** Fill only previews for the frozen references. Never replace the raw message,
   * candidates, routing binding, material identities or work observations. */
  markMaterialsPrepared(messageId: string, inputs: NonNullable<IngressClassificationInput['materials']>): boolean {
    const row = this.db.prepare(`SELECT handoff FROM ingress_routes WHERE message_id = ? AND handoff IS NOT NULL
      AND result IS NULL AND decision IS NULL AND attempt_count = 0 AND json_extract(handoff,'$.materialsPrepared') = 0
      AND NOT EXISTS (SELECT 1 FROM task_receipts WHERE dedup_key = ingress_routes.message_id)`).get(messageId) as { handoff: string } | undefined
    if (!row || !Array.isArray(inputs)) return false
    const handoff = JSON.parse(row.handoff) as RoutingHandoff
    const frozen = handoff.materials ?? []
    if (inputs.length !== frozen.length || new Set(frozen.map(material => material.ref)).size !== frozen.length) return false
    const previews = new Map<string, NonNullable<IngressClassificationInput['materials']>[number]>()
    for (const input of inputs) {
      if (!input || typeof input !== 'object' || Object.keys(input).some(key =>
        !['ref', 'kind', 'preview', 'status', 'replied', 'suppliedAt'].includes(key))) return false
      const material = frozen.find(candidate => candidate.ref === input.ref)
      if (!material || previews.has(input.ref) || input.kind !== material.message.msgType ||
        input.replied !== (material.message.messageId === handoff.message.parentId) ||
        input.suppliedAt !== material.message.createTimeMs || typeof input.preview !== 'string' ||
        !['ready', 'partial', 'unavailable'].includes(input.status)) return false
      previews.set(input.ref, { ref: input.ref, kind: input.kind, preview: input.preview, status: input.status,
        replied: input.replied, suppliedAt: input.suppliedAt })
    }
    const prepared: RoutingHandoff = { ...handoff, materialsPrepared: true,
      input: { ...handoff.input, materials: frozen.map(material => previews.get(material.ref)!) } }
    // The original JSON also forms the CAS: another preparation or host binding
    // change cannot be overwritten between reading and committing this receipt.
    return Boolean(this.db.prepare(`UPDATE ingress_routes SET handoff = ? WHERE message_id = ? AND handoff = ?
      AND result IS NULL AND decision IS NULL AND attempt_count = 0 AND json_extract(handoff,'$.materialsPrepared') = 0
      AND NOT EXISTS (SELECT 1 FROM task_receipts WHERE dedup_key = ingress_routes.message_id)`)
      .run(JSON.stringify(prepared), messageId, row.handoff).changes)
  }

  /** Admission is persisted before the classifier runs. The lease covers its total
   * deadline and teardown; overlapping polls or duplicate delivery cannot spend twice. */
  beginClassification(messageId: string, now: number, leaseMs: number): IngressClassificationAttempt | undefined {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(now + leaseMs)) {
      throw new Error('Invalid classification admission time')
    }
    const row = this.db.prepare(`UPDATE ingress_routes SET attempt_count = attempt_count + 1,
      last_failure_code = NULL, retry_at = ? WHERE message_id = ? AND handoff IS NOT NULL AND decision IS NULL AND result IS NULL
      AND COALESCE(json_extract(handoff,'$.materialsPrepared'),1) = 1
      AND attempt_count < ? AND (attempt_count = 0 OR (last_failure_code IS NOT NULL AND retry_at <= ?))
      AND NOT EXISTS (SELECT 1 FROM task_receipts WHERE dedup_key = ingress_routes.message_id)
      RETURNING attempt_count`).get(now + leaseMs, messageId, INGRESS_CLASSIFICATION_MAX_ATTEMPTS, now) as { attempt_count: number } | undefined
    return row ? { messageId, attempt: row.attempt_count, expiresAt: now + leaseMs } : undefined
  }

  classified(messageId: string, decision: IngressDecision, attempt?: IngressClassificationAttempt, now = Date.now()): boolean {
    if (attempt && attempt.messageId !== messageId) return false
    return Boolean(this.db.prepare(`UPDATE ingress_routes SET decision = ?, last_failure_code = NULL, retry_at = NULL, notice = NULL
      WHERE message_id = ? AND decision IS NULL AND result IS NULL
      AND COALESCE(json_extract(handoff,'$.materialsPrepared'),1) = 1
      ${attempt ? 'AND attempt_count = ? AND retry_at = ? AND retry_at > ? AND last_failure_code IS NULL' : 'AND attempt_count = 0'}`)
      .run(JSON.stringify(decision), messageId, ...(attempt ? [attempt.attempt, attempt.expiresAt, now] : [])).changes)
  }

  /** Failure is not a model decision. Record only host codes, never error bodies or
   * fabricated clarify output. The attempt CAS also rejects duplicate/late callbacks. */
  classificationFailed(messageId: string, attempt: IngressClassificationAttempt, code: IngressFailureCode, now: number,
    notice: IngressFailureNoticeText): IngressFailure | undefined {
    if (attempt.messageId !== messageId) return undefined
    // `stopped` is the classifier's permanent gateway-lifecycle abort (including
    // failed runtime teardown), not a human Work stop. A fresh gateway may retry;
    // caller `aborted` and host retire() remain terminal and cannot be revived here.
    const retry = (code === 'timeout' || code === 'unavailable' || code === 'stopped') && attempt.attempt < INGRESS_CLASSIFICATION_MAX_ATTEMPTS
    const retryAt = retry ? now + RETRY_DELAYS_MS[attempt.attempt - 1]! : null
    const phase = retry ? 'transient' : 'terminal'
    const changed = this.db.prepare(`UPDATE ingress_routes SET last_failure_code = ?, retry_at = ?, result = ?,
      notice = CASE WHEN ? = 'terminal' OR notice IS NULL THEN ? ELSE notice END
      WHERE message_id = ? AND handoff IS NOT NULL AND decision IS NULL AND result IS NULL
      AND attempt_count = ? AND retry_at = ? AND last_failure_code IS NULL`)
      .run(code, retryAt, retry ? null : 'classification_failed', phase, notice[phase], messageId, attempt.attempt, attempt.expiresAt).changes
    return changed ? { code, attemptCount: attempt.attempt, retryAt, phase } : undefined
  }

  /** Startup/poll recovery for a classifier whose process never returned. Only an
   * elapsed recorded deadline becomes a timeout; the original envelope stays exact. */
  recoverClassifications(now: number, notice: IngressFailureNoticeText): void {
    const rows = this.db.prepare(`SELECT message_id, attempt_count, retry_at FROM ingress_routes
      WHERE handoff IS NOT NULL AND decision IS NULL AND result IS NULL AND attempt_count > 0
      AND last_failure_code IS NULL AND retry_at <= ?`).all(now) as
      { message_id: string; attempt_count: number; retry_at: number }[]
    for (const row of rows) this.classificationFailed(row.message_id,
      { messageId: row.message_id, attempt: row.attempt_count, expiresAt: row.retry_at }, 'timeout', now, notice)
  }

  /** The existing recoverHandoffs poll owns dispatch. Inspection of pending(id)
   * remains unfiltered so receiving a duplicate cannot replace its stored input. */
  ready(now: number): RoutingHandoff[] {
    const rows = this.db.prepare(`SELECT message_id FROM ingress_routes WHERE handoff IS NOT NULL AND result IS NULL
      AND (decision IS NOT NULL OR attempt_count = 0 OR (last_failure_code IS NOT NULL AND retry_at <= ?))
      AND NOT EXISTS (SELECT 1 FROM task_receipts WHERE dedup_key = ingress_routes.message_id)
      ORDER BY created_at, message_id`).all(now) as { message_id: string }[]
    return rows.flatMap(row => this.pending(row.message_id))
  }

  classificationFailure(messageId: string): IngressFailure | undefined {
    const row = this.db.prepare(`SELECT attempt_count,last_failure_code,retry_at FROM ingress_routes
      WHERE message_id = ? AND decision IS NULL AND last_failure_code IS NOT NULL AND (result IS NULL OR result = 'classification_failed')`).get(messageId) as ClassificationRow | undefined
    return row ? { code: row.last_failure_code!, attemptCount: row.attempt_count, retryAt: row.retry_at,
      phase: row.retry_at === null ? 'terminal' : 'transient' } : undefined
  }

  /** The DeliveryService must reserve route-failure:<messageId>:<phase> before send.
   * Its existing planned/unknown receipt suppresses duplicates even after restart. */
  failureNotices(): { handoff: RoutingHandoff; text: string; phase: IngressFailure['phase']; failure: IngressFailure }[] {
    const hasDeliveries = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").get())
    return (this.db.prepare(`SELECT message_id,handoff,notice,attempt_count,last_failure_code,retry_at FROM ingress_routes
      WHERE handoff IS NOT NULL AND decision IS NULL AND notice IS NOT NULL AND last_failure_code IS NOT NULL
      AND (result IS NULL OR result = 'classification_failed')
      ${hasDeliveries ? `AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.delivery_key = 'route-failure:' || ingress_routes.message_id || ':' ||
        CASE WHEN ingress_routes.retry_at IS NULL THEN 'terminal' ELSE 'transient' END)` : ''}
      ORDER BY created_at, message_id`).all() as unknown as (ClassificationRow & { handoff: string; notice: string })[])
      .map(row => {
        const phase = row.retry_at === null ? 'terminal' : 'transient'
        return { handoff: JSON.parse(row.handoff), text: row.notice, phase,
          failure: { code: row.last_failure_code!, attemptCount: row.attempt_count, retryAt: row.retry_at, phase } }
      })
  }

  notices(): { handoff: RoutingHandoff; text: string; decision: IngressDecision }[] {
    const hasDeliveries = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").get())
    return (this.db.prepare(`SELECT handoff, notice, decision FROM ingress_routes WHERE handoff IS NOT NULL AND notice IS NOT NULL AND decision IS NOT NULL
      ${hasDeliveries ? "AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.delivery_key = 'route:' || ingress_routes.message_id)" : ''}`).all() as
      { handoff: string; notice: string; decision: string }[]).map(row => ({ handoff: JSON.parse(row.handoff), text: row.notice, decision: JSON.parse(row.decision) }))
  }

  refreshNotice(messageId: string, text: string): void {
    this.db.prepare('UPDATE ingress_routes SET notice = ? WHERE message_id = ? AND notice IS NOT NULL').run(text, messageId)
  }

  /** Apply local routing, task creation and the durable dispatch before waking anything. */
  commit<T>(messageId: string, decision: IngressDecision, result: string | (() => string), apply: () => T, notify = false): T {
    this.db.exec('SAVEPOINT apply_ingress')
    try {
      const pending = this.db.prepare('SELECT 1 FROM ingress_routes WHERE message_id = ? AND result IS NULL').get(messageId)
      if (!pending) throw new Error('入站决定已应用或不存在')
      const value = apply()
      const receipt = typeof result === 'string' ? result : result()
      this.applied(messageId, decision, receipt)
      if (notify) this.db.prepare('UPDATE ingress_routes SET notice = ? WHERE message_id = ?').run(receipt, messageId)
      this.db.exec('RELEASE SAVEPOINT apply_ingress')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT apply_ingress')
      this.db.exec('RELEASE SAVEPOINT apply_ingress')
      throw error
    }
  }
}
