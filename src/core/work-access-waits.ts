import type { DatabaseSync } from 'node:sqlite'
import type { AccessFailure } from './access-failure.js'
import type { WorkContexts } from './work-contexts.js'
import type { UserTokenStore } from '../feishu/oauth.js'
import { inspectRecoveryEvidence, type RecoveryEvidence } from './recovery-evidence.js'

export interface WorkAccessWait {
  version: 1
  taskId: number
  runId: string
  openId: string
  grantId: string | null
  scopes: string[]
  purpose: string
}
export interface PendingWorkAccess { workKey: string; causeRef: string; details: WorkAccessWait }
export type WorkConnectionReader = Pick<UserTokenStore, 'get' | 'grantId' | 'isConnected'>
export interface WorkAccessCondition {
  causeRef: string
  satisfied: boolean
  recovery?: Pick<RecoveryEvidence, 'allowed' | 'reasons'>
}

/** Read the condition behind an admission pause, rather than equating the pause with
 * a missing grant. An accepted grant may still be waiting for operation reconciliation.
 * This projection never clears the pause, retries work, or exposes token/operation data. */
export function projectWorkAccessConditions(db: DatabaseSync, workKey: string, connection?: WorkConnectionReader): WorkAccessCondition[] {
  if (!connection || !db.prepare('PRAGMA table_info(work_pause_reasons)').all().some(column => column.name === 'details_json')) return []
  const rows = db.prepare(`SELECT p.cause_ref,p.details_json,w.session_key,w.authority_open_id FROM work_pause_reasons p
    JOIN work_contexts w ON w.work_key=p.work_key WHERE p.work_key=? AND p.reason='authorization' AND p.details_json IS NOT NULL`)
    .all(workKey) as { cause_ref: string; details_json: string; session_key: string; authority_open_id: string | null }[]
  return rows.map(row => {
    const condition: WorkAccessCondition = { causeRef: row.cause_ref, satisfied: false }
    let wait: WorkAccessWait
    try { wait = JSON.parse(row.details_json) as WorkAccessWait } catch { return condition }
    if (!wait || wait.version !== 1 || !wait.openId || wait.openId !== row.authority_open_id || !Number.isSafeInteger(wait.taskId) ||
      !wait.runId || !Array.isArray(wait.scopes) || !wait.scopes.every(scope => typeof scope === 'string') ||
      !connection.isConnected(wait.openId)) return condition
    const grantId = connection.grantId(wait.openId), scopes = new Set((connection.get(wait.openId)?.scope ?? '').split(/[\s,]+/))
    if (grantId === wait.grantId || wait.scopes.some(scope => !scopes.has(scope))) return condition
    condition.satisfied = true
    const evidence = inspectRecoveryEvidence(db, { taskId: wait.taskId, runId: wait.runId,
      sessionKey: row.session_key, actorOpenId: wait.openId })
    condition.recovery = { allowed: evidence.allowed, reasons: evidence.reasons }
    return condition
  })
}

/** Authorization is a condition on the original delegation, not a new user request. */
export class WorkAccessWaits {
  constructor(private readonly db: DatabaseSync, private readonly work: WorkContexts) {
    const columns = db.prepare('PRAGMA table_info(work_pause_reasons)').all() as { name: string }[]
    if (!columns.some(column => column.name === 'details_json')) db.exec('ALTER TABLE work_pause_reasons ADD COLUMN details_json TEXT')
  }

  record(workKey: string, failure: AccessFailure, input: Omit<WorkAccessWait, 'version' | 'scopes'>): void {
    if (failure.next !== 'connect' && failure.next !== 'grant_scope') return
    const context = this.work.get(workKey)
    if (!context || context.lifecycle !== 'open' || context.authorityOpenId !== input.openId ||
      !this.work.inputs(workKey).some(item => item.taskId === input.taskId)) throw new Error('授权等待不属于当前委托')
    const causeRef = `access:${input.runId}:${input.purpose}`
    const previous = this.db.prepare("SELECT details_json FROM work_pause_reasons WHERE work_key=? AND reason='authorization' AND cause_ref=?")
      .get(workKey, causeRef)
    const prior = previous?.details_json ? JSON.parse(String(previous.details_json)) as WorkAccessWait : undefined
    const details: WorkAccessWait = { version: 1, ...input, grantId: prior ? prior.grantId : input.grantId,
      scopes: [...new Set([...(prior?.scopes ?? []), ...(failure.scopes ?? [])])].sort() }
    this.db.exec('SAVEPOINT wait_for_access')
    try {
      if (!previous) this.work.control(workKey, { action: 'pause', reason: 'authorization', causeRef })
      this.db.prepare("UPDATE work_pause_reasons SET details_json=? WHERE work_key=? AND reason='authorization' AND cause_ref=?")
        .run(JSON.stringify(details), workKey, causeRef)
      this.db.exec('RELEASE wait_for_access')
    } catch (error) { this.db.exec('ROLLBACK TO wait_for_access; RELEASE wait_for_access'); throw error }
  }

  pending(openId: string): PendingWorkAccess[] {
    const rows = this.db.prepare(`SELECT p.work_key,p.cause_ref,p.details_json FROM work_pause_reasons p JOIN work_contexts w ON w.work_key=p.work_key
      WHERE p.reason='authorization' AND p.details_json IS NOT NULL AND w.authority_open_id=? AND w.lifecycle='open' ORDER BY p.created_at,p.cause_ref`)
      .all(openId) as { work_key: string; cause_ref: string; details_json: string }[]
    return rows.map(row => ({ workKey: row.work_key, causeRef: row.cause_ref, details: JSON.parse(row.details_json) as WorkAccessWait }))
      .filter(row => row.details.version === 1 && row.details.openId === openId)
  }

  owners(): string[] {
    return (this.db.prepare(`SELECT DISTINCT w.authority_open_id AS open_id FROM work_pause_reasons p JOIN work_contexts w ON w.work_key=p.work_key
      WHERE p.reason='authorization' AND p.details_json IS NOT NULL AND w.lifecycle='open' AND w.authority_open_id IS NOT NULL`)
      .all() as { open_id: string }[]).map(row => row.open_id)
  }

  resolve(wait: PendingWorkAccess): void {
    this.work.control(wait.workKey, { action: 'resume', reason: 'authorization', causeRef: wait.causeRef })
  }
}
