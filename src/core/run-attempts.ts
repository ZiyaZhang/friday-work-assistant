import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type RunStage = 'task' | 'routine' | 'reflect'
export type RunState = 'running' | 'stop_requested' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type RunResultReason = 'normal_end' | 'host_completed' | 'step_budget' | 'model_limit' | 'model_stopped' | 'delivery_partial' | 'delivery_unknown'
  | 'authorization_required' | 'access_denied' | 'access_changed' | 'network_error' | 'empty_result' | 'runtime_error'
  | 'user_requested' | 'host_cancelled' | 'interrupted' | 'recovery_context_missing' | 'operation_incomplete'
/** Host facts for one attempt. `handled` says nothing about completion of its Work/Issue/Todo. */
export interface RunResult {
  version: 1
  /** Original model/host termination code, before any summary or recovery turn. Never an exception message. */
  termination: string
  outcome: 'handled' | 'partial' | 'failed' | 'cancelled' | 'interrupted'
  reason: RunResultReason
}

const RESULT_REASONS = new Set<RunResultReason>(['normal_end', 'host_completed', 'step_budget', 'model_limit', 'model_stopped', 'delivery_partial', 'delivery_unknown',
  'authorization_required', 'access_denied', 'access_changed', 'network_error', 'empty_result', 'runtime_error', 'user_requested', 'host_cancelled', 'interrupted', 'recovery_context_missing', 'operation_incomplete'])

function validResult(value: unknown): value is RunResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return Object.keys(r).length === 4 && r.version === 1 && typeof r.termination === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(r.termination)
    && ['handled', 'partial', 'failed', 'cancelled', 'interrupted'].includes(String(r.outcome)) && RESULT_REASONS.has(r.reason as RunResultReason)
    && (r.outcome !== 'handled' || (r.termination === 'end_turn' && r.reason === 'normal_end') || (r.termination === 'host_completed' && r.reason === 'host_completed'))
}

/** Old/malformed evidence remains unknown; reading it never invents successful work. */
export function parseRunResult(json: unknown): RunResult | null {
  if (typeof json !== 'string') return null
  try { const value: unknown = JSON.parse(json); return validResult(value) ? value : null } catch { return null }
}

export interface RunAttempt {
  id: string
  workKey: string
  sessionKey: string
  triggerKey: string
  stage: RunStage
  taskId: number | null
  actorOpenId: string | null
  acpSessionId: string | null
  state: RunState
  stopReason: string | null
  result: RunResult | null
  startedAt: number
  finishedAt: number | null
}

/** Execution identity only. Domain state and delivery identities remain in their own stores. */
export class RunAttempts {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS run_attempts (
      id TEXT PRIMARY KEY,
      work_key TEXT NOT NULL,
      session_key TEXT NOT NULL,
      trigger_key TEXT NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('task', 'routine', 'reflect')),
      task_id INTEGER REFERENCES tasks(id),
      actor_open_id TEXT,
      acp_session_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('running', 'stop_requested', 'completed', 'failed', 'cancelled', 'interrupted')),
      stop_reason TEXT,
      result_json TEXT,
      execution_boundary TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE(trigger_key, stage)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_active_session ON run_attempts(session_key)
      WHERE state IN ('running', 'stop_requested');`)
    const columns = db.prepare('PRAGMA table_info(run_attempts)').all() as { name: string }[]
    if (!columns.some(column => column.name === 'result_json')) db.exec('ALTER TABLE run_attempts ADD COLUMN result_json TEXT')
    if (!columns.some(column => column.name === 'execution_boundary')) db.exec('ALTER TABLE run_attempts ADD COLUMN execution_boundary TEXT')
  }

  /** Admission and the host's Task/occurrence claim share one short transaction. */
  begin(input: { workKey: string; sessionKey: string; triggerKey: string; stage: RunStage; taskId?: number; actorOpenId?: string; now: number },
    admit: () => boolean = () => true): RunAttempt | undefined {
    this.db.exec('SAVEPOINT begin_run')
    try {
      if (!admit()) {
        this.db.exec('ROLLBACK TO SAVEPOINT begin_run')
        this.db.exec('RELEASE SAVEPOINT begin_run')
        return undefined
      }
      const id = randomUUID()
      this.db.prepare(`INSERT INTO run_attempts
        (id,work_key,session_key,trigger_key,stage,task_id,actor_open_id,state,started_at) VALUES (?,?,?,?,?,?,?,'running',?)`)
        .run(id, input.workKey, input.sessionKey, input.triggerKey, input.stage, input.taskId ?? null, input.actorOpenId ?? null, input.now)
      this.db.exec('RELEASE SAVEPOINT begin_run')
      return this.get(id)!
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT begin_run')
      this.db.exec('RELEASE SAVEPOINT begin_run')
      throw error
    }
  }

  get(id: string): RunAttempt | undefined {
    const row = this.db.prepare(`SELECT id, work_key AS workKey, session_key AS sessionKey, trigger_key AS triggerKey,
      stage, task_id AS taskId, actor_open_id AS actorOpenId, acp_session_id AS acpSessionId, state,
      stop_reason AS stopReason, result_json AS resultJson, started_at AS startedAt, finished_at AS finishedAt FROM run_attempts WHERE id = ?`).get(id)
    if (!row) return undefined
    const { resultJson, ...attempt } = row
    return { ...attempt, result: parseRunResult(resultJson) } as unknown as RunAttempt
  }

  isCurrent(id: string): boolean {
    return this.get(id)?.state === 'running'
  }

  latestForTask(taskId: number): RunAttempt | undefined {
    const row = this.db.prepare("SELECT id FROM run_attempts WHERE task_id = ? AND stage <> 'reflect' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(taskId)
    return row ? this.get(String(row.id)) : undefined
  }

  bindRuntime(id: string, acpSessionId: string): boolean {
    return Boolean(this.db.prepare("UPDATE run_attempts SET acp_session_id = ? WHERE id = ? AND state = 'running'")
      .run(acpSessionId, id).changes)
  }

  /** Only the host-selected executor can establish the complete API boundary. */
  bindExecutionBoundary(id: string, boundary: 'managed_api_v1' | 'workspace'): void {
    this.db.prepare("UPDATE run_attempts SET execution_boundary=? WHERE id=? AND state='running' AND execution_boundary IS NULL").run(boundary, id)
  }

  requestStop(id: string, reason: string): boolean {
    return Boolean(this.db.prepare("UPDATE run_attempts SET state = 'stop_requested', stop_reason = ? WHERE id = ? AND state = 'running'")
      .run(reason, id).changes)
  }

  finish(id: string, state: 'completed' | 'failed' | 'cancelled', now: number, reason?: string, result?: RunResult): void {
    const current = this.get(id)
    if (!current || !['running', 'stop_requested'].includes(current.state)) return
    if (result && (!validResult(result) || (state === 'completed' ? !['handled', 'partial'].includes(result.outcome) : result.outcome !== state))) {
      throw new Error('Invalid Run result for its terminal state')
    }
    // A committed stop owns the terminal outcome even if the model subsequently returns normally.
    const finalResult: RunResult | undefined = current.state === 'stop_requested' ? {
      version: 1, termination: result?.termination ?? 'host_cancelled', outcome: 'cancelled',
      reason: current.stopReason === 'user_requested' ? 'user_requested' : current.stopReason === 'access_changed' ? 'access_changed' : 'host_cancelled',
    } : result
    this.db.prepare(`UPDATE run_attempts SET state = CASE WHEN state = 'stop_requested' THEN 'cancelled' ELSE ? END,
      stop_reason = COALESCE(stop_reason, ?), result_json = COALESCE(result_json, ?), finished_at = ? WHERE id = ? AND state = ?`)
      .run(state, reason ?? null, finalResult ? JSON.stringify(finalResult) : null, now, id, current.state)
  }

  /** Host shutdown owns running attempts only; a committed user stop still wins. */
  interruptActive(now: number, termination: 'gateway_shutdown' | 'gateway_restarted' = 'gateway_shutdown'): number {
    return Number(this.db.prepare(`UPDATE run_attempts
      SET state = CASE WHEN state = 'stop_requested' THEN 'cancelled' ELSE 'interrupted' END,
      result_json = COALESCE(result_json, CASE WHEN state = 'stop_requested' THEN
        json_object('version',1,'termination',?,'outcome','cancelled','reason',CASE WHEN stop_reason = 'user_requested' THEN 'user_requested' WHEN stop_reason = 'access_changed' THEN 'access_changed' ELSE 'host_cancelled' END)
        ELSE json_object('version',1,'termination',?,'outcome','interrupted','reason','interrupted') END),
      stop_reason = COALESCE(stop_reason, ?), finished_at = ? WHERE state IN ('running','stop_requested')`)
      .run(termination, termination, termination, now).changes)
  }

  /** Startup never invents completion or overwrites an already terminal attempt. */
  recoverInterrupted(now: number): number { return this.interruptActive(now, 'gateway_restarted') }
}
