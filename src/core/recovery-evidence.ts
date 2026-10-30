import type { DatabaseSync } from 'node:sqlite'
import { taskDeliveryContextRef } from './execution-keys.js'
import { readOnlyApiCall } from './run-api-calls.js'

export interface RecoveryReceipt {
  kind: 'api_call' | 'delivery' | 'github_change' | 'github_change_update' | 'github_change_preparation' | 'pmo' | 'feishu_task'
  /** Opaque operation identity only; no payload, title, URL, credential, or provider error. */
  ref: string
  state: 'acknowledged' | 'confirmed' | 'not_sent' | 'prepared' | 'unresolved' | 'unverifiable'
  remoteId?: string
}
export type RecoveryEvidenceReason = 'identity_mismatch' | 'attempt_not_terminal' | 'attempt_superseded' | 'work_stopped'
  | 'input_superseded' | 'coverage_missing' | 'coverage_invalid' | 'ledger_missing' | 'effect_unresolved' | 'effect_unverifiable'
export interface RecoveryEvidence {
  allowed: boolean
  reasons: RecoveryEvidenceReason[]
  receipts: RecoveryReceipt[]
}
export interface RecoveryEvidenceInput {
  taskId: number
  runId: string
  sessionKey: string
  actorOpenId: string
  /** Recheck after the next Run was admitted. Its durable dispatch must name runId. */
  continuationRunId?: string
}

/** Read-only recovery projection. No constructors/migrations, remote calls, repair,
 * retries, or replacement business keys. Current identity and permissions remain
 * the scheduler's responsibility and must be rechecked before the new dispatch. */
export function inspectRecoveryEvidence(db: DatabaseSync, input: RecoveryEvidenceInput): RecoveryEvidence {
  const reasons = new Set<RecoveryEvidenceReason>(), receipts: RecoveryReceipt[] = []
  const result = (): RecoveryEvidence => ({ allowed: reasons.size === 0, reasons: [...reasons], receipts })
  const table = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
  if (!['tasks', 'sessions', 'task_receipts', 'task_dispatches', 'run_attempts', 'work_contexts', 'work_inputs'].every(table)) {
    reasons.add('ledger_missing'); return result()
  }
  if (!db.prepare('PRAGMA table_info(run_attempts)').all().some(column => column.name === 'execution_boundary')) {
    reasons.add('coverage_missing'); return result()
  }
  const run = db.prepare(`SELECT r.id,r.trigger_key,r.rowid AS run_order,r.task_id,r.session_key,r.actor_open_id,r.work_key,r.state,r.stop_reason,r.finished_at,r.execution_boundary,
    t.status AS task_status,t.stop_reason AS task_stop,t.requester_open_id,w.lifecycle,w.authority_open_id,i.seq AS input_seq
    FROM run_attempts r JOIN tasks t ON t.id=r.task_id JOIN work_contexts w ON w.work_key=r.work_key
    JOIN work_inputs i ON i.work_key=w.work_key AND i.task_id=t.id
    WHERE r.id=? AND r.stage='task' AND t.session_key=r.session_key AND w.session_key=r.session_key`).get(input.runId)
  if (!run || run.task_id !== input.taskId || run.session_key !== input.sessionKey || !input.actorOpenId ||
    run.actor_open_id !== input.actorOpenId || run.requester_open_id !== input.actorOpenId || run.authority_open_id !== input.actorOpenId) {
    reasons.add('identity_mismatch'); return result()
  }
  if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(String(run.state)) || run.finished_at === null) reasons.add('attempt_not_terminal')
  const latest = db.prepare("SELECT * FROM run_attempts WHERE task_id=? AND stage='task' ORDER BY started_at DESC,rowid DESC LIMIT 1").get(input.taskId)
  if (input.continuationRunId) {
    const dispatch = db.prepare('SELECT generation,resume_json FROM task_dispatches WHERE task_id=?').get(input.taskId)
    let previousRunId: unknown
    try { previousRunId = JSON.parse(String(dispatch?.resume_json))?.previousRunId } catch { /* no proven handoff */ }
    if (latest?.id !== input.continuationRunId || latest.state !== 'running' || latest.session_key !== input.sessionKey ||
      latest.actor_open_id !== input.actorOpenId || latest.work_key !== run.work_key || previousRunId !== input.runId ||
      !Number.isSafeInteger(dispatch?.generation) || Number(dispatch?.generation) < 1 ||
      latest.trigger_key !== `task:${input.taskId}:resume:${dispatch?.generation}`) {
      reasons.add('attempt_superseded'); return result()
    }
    if (latest.execution_boundary !== 'managed_api_v1') { reasons.add('coverage_missing'); return result() }
  } else if (latest?.id !== input.runId) reasons.add('attempt_superseded')
  if (run.lifecycle !== 'open' || run.task_status === 'cancelled' || run.task_stop === 'user_requested' || run.stop_reason === 'user_requested') reasons.add('work_stopped')
  // A newer human input is already the continuation of this Work. A late OAuth
  // callback must not append the older instruction after it. Neither an unrelated
  // Work nor a synthetic/control task establishes that takeover.
  const laterInputs = db.prepare(`SELECT t.message_id,t.requester_open_id,s.chat_id,s.chat_type,d.inbound
    FROM work_inputs i JOIN tasks t ON t.id=i.task_id JOIN sessions s ON s.session_key=t.session_key
    JOIN task_receipts r ON r.task_id=t.id AND r.dedup_key=t.message_id JOIN task_dispatches d ON d.task_id=t.id
    WHERE i.work_key=? AND i.seq>? AND i.kind IN ('instruction','evidence') AND t.session_key=? AND t.requester_open_id=?`)
    .all(String(run.work_key), Number(run.input_seq), input.sessionKey, input.actorOpenId)
  for (const later of laterInputs) {
    let inbound: Record<string, unknown> | undefined
    try { inbound = JSON.parse(String(later.inbound)) as Record<string, unknown> } catch { continue }
    if (inbound?.senderType === 'user' && inbound.messageId === later.message_id && inbound.senderOpenId === later.requester_open_id &&
      inbound.chatId === later.chat_id && inbound.chatType === later.chat_type) { reasons.add('input_superseded'); break }
  }
  // Do not return another actor's operation references when any identity check failed.
  const add = (receipt: RecoveryReceipt): void => {
    receipts.push(receipt)
    if (receipt.state === 'unresolved') reasons.add('effect_unresolved')
    if (receipt.state === 'unverifiable') reasons.add('effect_unverifiable')
  }

  if (table('deliveries')) {
    const context = taskDeliveryContextRef(input.taskId, input.sessionKey)
    // Exact prefix delimiter; SQL LIKE would interpret a Session's '%'/'_' as wildcards.
    const rows = db.prepare(`SELECT delivery_key,status,remote_id,actor_open_id FROM deliveries
      WHERE context_ref=? OR substr(context_ref,1,length(?) + 1)=? || ':' ORDER BY created_at,delivery_key`)
      .all(context, context, context)
    for (const row of rows) {
      // A final answer may be acknowledged just before host shutdown interrupts
      // its remaining bookkeeping. No completion fact means no automatic resend.
      const finalPrefix = `${run.trigger_key}:final:`
      if (run.state === 'interrupted' && String(row.delivery_key).startsWith(finalPrefix) &&
        /^\d+$/.test(String(row.delivery_key).slice(finalPrefix.length)) && ['sent', 'confirmed'].includes(String(row.status))) {
        reasons.add('effect_unverifiable')
      }
      const remoteId = typeof row.remote_id === 'string' && row.remote_id ? row.remote_id : undefined
      add({ kind: 'delivery', ref: String(row.delivery_key), state: row.actor_open_id !== input.actorOpenId ? 'unverifiable'
        : ['planned', 'unknown'].includes(String(row.status)) ? 'unresolved'
          : row.status === 'confirmed' && remoteId ? 'confirmed' : row.status === 'sent' && remoteId ? 'acknowledged' : 'unverifiable',
      ...(remoteId && row.actor_open_id === input.actorOpenId ? { remoteId } : {}) })
    }
  }

  // The host binds this only after selecting the managed runtime and enabling
  // the complete before-handler ledger. Runtime mode alone is not coverage.
  if (run.execution_boundary !== 'managed_api_v1' || !table('run_api_calls')) {
    reasons.add('coverage_missing'); return result()
  }
  if (db.prepare(`SELECT 1 FROM run_attempts WHERE task_id=? AND stage='task' AND rowid<=?
    AND (execution_boundary IS NULL OR execution_boundary<>'managed_api_v1') LIMIT 1`).get(input.taskId, Number(run.run_order))) {
    reasons.add('coverage_missing'); return result()
  }
  // Earlier generations of this Task are part of the same recovery. Looking only
  // at its last read-only attempt could hide an already returned write.
  const hasOperationRefs = db.prepare('PRAGMA table_info(run_api_calls)').all().some(column => column.name === 'operations_json')
  const calls = db.prepare(`SELECT c.id,c.route,c.scopes_json,c.state,${hasOperationRefs ? 'c.operations_json' : "'[]' AS operations_json"} FROM run_api_calls c JOIN run_attempts r ON r.id=c.run_id
    WHERE r.task_id=? AND r.stage='task' AND r.rowid<=? ORDER BY r.rowid,c.started_at,c.rowid`).all(input.taskId, Number(run.run_order))
  for (const call of calls) {
    let scopes: unknown
    try { scopes = JSON.parse(String(call.scopes_json)) } catch { scopes = null }
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(scope => typeof scope === 'string' && scope.length > 0)) {
      reasons.add('coverage_invalid')
      add({ kind: 'api_call', ref: String(call.id), state: 'unverifiable' })
      continue
    }
    const isRead = readOnlyApiCall({ scopes })
    // A prepared checkout is a host-local effect with its own durable identity.
    // Only this exact route can reuse that receipt. Publishing and other write
    // calls retain their reconciliation requirement, even in the same Run.
    let operations: unknown
    try { operations = JSON.parse(String(call.operations_json)) } catch { operations = null }
    if (call.route === 'POST /v1/github/change/start' && scopes.length === 1 && scopes[0] === 'github:write' &&
      Array.isArray(operations) && operations.length === 1 && operations[0]?.kind === 'github_change_preparation' &&
      typeof operations[0]?.id === 'string' && table('github_change_preparations')) {
      const preparation = db.prepare(`SELECT p.id,p.state,p.repo,p.result,p.cwd FROM github_change_preparations p
        JOIN run_attempts r ON r.id=p.attempt_key
        WHERE p.id=? AND p.session_key=? AND p.requester_open_id=? AND r.task_id=?
          AND r.session_key=p.session_key AND r.actor_open_id=p.requester_open_id AND r.work_key=? AND r.stage='task'`)
        .get(operations[0].id, input.sessionKey, input.actorOpenId, input.taskId, String(run.work_key))
      if (preparation) {
        let state: RecoveryReceipt['state'] = 'unverifiable'
        if (preparation.state === 'preparing') state = 'unresolved'
        else if (['retryable', 'cancelled', 'interrupted'].includes(String(preparation.state))) state = 'not_sent'
        else if (preparation.state === 'prepared' && table('github_changes')) {
          let value: { id?: unknown; operationId?: unknown } | undefined
          try { value = JSON.parse(String(preparation.result)) } catch { /* missing domain binding */ }
          if (typeof value?.id === 'string' && value.operationId === preparation.id && db.prepare(`SELECT 1 FROM github_changes
            WHERE id=? AND session_key=? AND requester_open_id=? AND repo=? AND cwd=?`)
            .get(value.id, input.sessionKey, input.actorOpenId, String(preparation.repo), String(preparation.cwd))) state = 'prepared'
        }
        add({ kind: 'github_change_preparation', ref: String(preparation.id), state })
        // Even a lost HTTP response cannot change the authoritative operation.
        // The next Run reuses the original id and still rechecks source/repo access.
        continue
      }
    }
    // A handler ACK can precede network delivery and ACP persistence of its tool
    // result. Even successful ACP resume cannot prove that gap closed. The call
    // ledger has no stable domain-object refs yet; do not replay such a request.
    if (call.state === 'returned' && !isRead) reasons.add('effect_unverifiable')
    add({ kind: 'api_call', ref: String(call.id), state: call.state === 'returned' ? 'acknowledged'
      : (call.state === 'started' || call.state === 'failed') && isRead ? 'not_sent'
        : call.state === 'started' || call.state === 'failed' ? 'unresolved' : 'unverifiable' })
  }

  // Existing domain stores are authoritative. Their identities are intentionally
  // preserved across Runs. Session/actor is the narrowest available binding for
  // changes and todos; never use global unknown rows or a timestamp to guess it.
  if (table('github_changes')) {
    if (!table('github_change_updates')) reasons.add('ledger_missing')
    const changes = db.prepare('SELECT id,state,commit_id,result FROM github_changes WHERE session_key=? AND requester_open_id=? ORDER BY created_at,id')
      .all(input.sessionKey, input.actorOpenId)
    for (const row of changes) {
      add({ kind: 'github_change', ref: String(row.id), state: row.state === 'prepared' ? 'prepared'
        : row.state === 'confirmed' && row.commit_id && row.result ? 'confirmed'
          : ['push_planned', 'pushed', 'pr_planned', 'pr_sent', 'pr_unknown', 'unknown'].includes(String(row.state)) ? 'unresolved' : 'unverifiable' })
      if (!table('github_change_updates')) continue
      const updates = db.prepare('SELECT id,state,commit_id,result FROM github_change_updates WHERE change_id=? ORDER BY created_at,id').all(String(row.id))
      for (const update of updates) add({ kind: 'github_change_update', ref: String(update.id), state: update.state === 'prepared' ? 'prepared'
        : update.state === 'confirmed' && update.commit_id && update.result ? 'confirmed'
          : ['push_planned', 'pushed', 'unknown'].includes(String(update.state)) ? 'unresolved' : 'unverifiable' })
    }
  }
  if (table('todos')) {
    const todos = db.prepare('SELECT id FROM todos WHERE session_key=? AND created_by=? ORDER BY id').all(input.sessionKey, input.actorOpenId)
    for (const todo of todos) {
      if (table('pmo_projection_records')) {
        if (!table('pmo_projection_writes')) reasons.add('ledger_missing')
        const records = db.prepare('SELECT record_id,fingerprint FROM pmo_projection_records WHERE todo_id=?').all(Number(todo.id))
        const pending = table('pmo_projection_writes') && db.prepare('SELECT 1 FROM pmo_projection_writes WHERE todo_id=? LIMIT 1').get(Number(todo.id))
        if (records.length || pending) add({ kind: 'pmo', ref: String(todo.id), state: pending || records.some(record => !record.record_id || String(record.fingerprint).startsWith('pending-create:'))
          ? 'unresolved' : 'confirmed' })
      }
      if (table('feishu_task_links')) {
        const link = db.prepare('SELECT guid FROM feishu_task_links WHERE todo_id=?').get(Number(todo.id))
        // This background synchronizer has no before-send reservation. Absence
        // cannot tell whether a mirror was requested, so it supplies no receipt.
        // The API coverage must record any direct invocation before dispatch.
        if (link) add({ kind: 'feishu_task', ref: String(todo.id), state: link.guid ? 'acknowledged' : 'unverifiable' })
      }
    }
  }
  // github_issue_operations has only an irreversible request_key and no Run,
  // Session or actor binding. Do not guess by time/repo or scan other people's
  // operations. Unresolved and returned mutation calls are blocked above until
  // their exact domain references can be reconstructed; an ACK is still retained.
  return result()
}
