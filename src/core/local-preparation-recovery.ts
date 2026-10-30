import type { DatabaseSync } from 'node:sqlite'
import { inspectRecoveryEvidence } from './recovery-evidence.js'

/** Scheduling projection only. Local Git preparation owns its result; the
 * existing dispatch/Run mechanism owns attempts, admission and cancellation. */
export function duePreparationRecovery(db: DatabaseSync, now: number, retries: number): { taskId: number; runId: string }[] {
  if (!Number.isSafeInteger(retries) || retries <= 0) return []
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='github_change_preparations'").get() ||
    !db.prepare('PRAGMA table_info(run_api_calls)').all().some(column => column.name === 'operations_json')) return []
  const candidates = db.prepare(`SELECT DISTINCT r.id,r.rowid AS run_order,r.task_id,r.session_key,r.actor_open_id,r.finished_at FROM run_attempts r
    JOIN tasks t ON t.id=r.task_id JOIN work_contexts w ON w.work_key=r.work_key
    WHERE r.stage='task' AND r.state='completed' AND json_extract(r.result_json,'$.reason')='operation_incomplete'
      AND t.status='done' AND w.lifecycle='open'
      AND NOT EXISTS(SELECT 1 FROM work_pause_reasons p WHERE p.work_key=w.work_key)
      AND r.rowid=(SELECT max(n.rowid) FROM run_attempts n WHERE n.task_id=r.task_id AND n.stage='task')`).all()
  const result: { taskId: number; runId: string }[] = []
  for (const candidate of candidates) {
    const preparations = db.prepare(`SELECT p.id,p.state,p.error_code,p.updated_at,min(a.rowid) AS first_run_order
      FROM run_api_calls c JOIN run_attempts a ON a.id=c.run_id,json_each(c.operations_json) o
      JOIN github_change_preparations p ON p.id=json_extract(o.value,'$.id')
      WHERE a.task_id=? AND a.stage='task' AND a.rowid<=?
        AND json_extract(o.value,'$.kind')='github_change_preparation' GROUP BY p.id`)
      .all(Number(candidate.task_id), Number(candidate.run_order))
    if (!preparations.length) continue
    // A continuation that only inspects the receipt still consumed an attempt.
    // Start at this Task's first preparation, not each new receipt: a new repo/base
    // or a no-tool turn must not reset the finite automatic recovery budget.
    const firstRunOrder = Math.min(...preparations.map(p => Number(p.first_run_order)))
    const attempts = Number(db.prepare(`SELECT count(*) AS n FROM run_attempts
      WHERE task_id=? AND stage='task' AND rowid>=? AND rowid<=?`)
      .get(Number(candidate.task_id), firstRunOrder, Number(candidate.run_order))?.n)
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > retries) continue
    // An explicitly incomplete Run may have ended without consuming a prepared
    // result. It can continue from that receipt. Any unfinished preparation must
    // still be a known-stopped transport/interruption failure; access, configuration
    // and Git-content failures require a changed condition, not a timer.
    const unfinished = preparations.filter(p => p.state !== 'prepared')
    if (unfinished.some(p => !['retryable', 'cancelled', 'interrupted'].includes(String(p.state)) ||
      !['network', 'dns', 'timeout', 'request_cancelled', 'host_interrupted'].includes(String(p.error_code)))) continue
    const settledAt = Math.max(Number(candidate.finished_at), ...preparations.map(p => Number(p.updated_at)))
    if (!Number.isSafeInteger(settledAt) || now < settledAt + 30_000 * 2 ** Math.min(attempts - 1, 6)) continue
    const taskId = Number(candidate.task_id), runId = String(candidate.id)
    if (inspectRecoveryEvidence(db, { taskId, runId, sessionKey: String(candidate.session_key), actorOpenId: String(candidate.actor_open_id) }).allowed) {
      result.push({ taskId, runId })
    }
  }
  return result
}
