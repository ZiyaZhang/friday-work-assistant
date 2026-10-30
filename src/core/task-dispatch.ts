import type { DatabaseSync } from 'node:sqlite'
import type { InboundMessage } from '../feishu/mention.js'
import { validTaskEventDispatch } from './task-events.js'
import { validPersonalAssistanceDispatch } from './personal-assistance.js'

export interface TaskDispatch {
  taskId: number
  inbound: InboundMessage
  steer: boolean
  generation: number
  resume: TaskResume | null
}

export interface TaskResume {
  previousRunId: string
  reason: 'authorization' | 'restart' | 'local_preparation'
  resumedAt: number
}

interface DispatchRow { task_id: number; inbound: string; steer: number; generation: number; resume_json: string | null }

/** Durable handoff to the in-process queue. A terminal attempt needs an explicit new generation to replay. */
export class TaskDispatches {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS task_dispatches (
      task_id INTEGER PRIMARY KEY REFERENCES tasks(id),
      inbound TEXT NOT NULL,
      steer INTEGER NOT NULL,
      started_at INTEGER,
      generation INTEGER NOT NULL DEFAULT 0,
      resume_json TEXT
    )`)
    db.exec('SAVEPOINT migrate_task_dispatch_resume')
    try {
      const columns = db.prepare('PRAGMA table_info(task_dispatches)').all() as { name: string }[]
      if (!columns.some(column => column.name === 'generation')) db.exec('ALTER TABLE task_dispatches ADD COLUMN generation INTEGER NOT NULL DEFAULT 0')
      if (!columns.some(column => column.name === 'resume_json')) db.exec('ALTER TABLE task_dispatches ADD COLUMN resume_json TEXT')
      db.exec('RELEASE SAVEPOINT migrate_task_dispatch_resume')
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT migrate_task_dispatch_resume')
      db.exec('RELEASE SAVEPOINT migrate_task_dispatch_resume')
      throw error
    }
  }

  save(taskId: number, inbound: InboundMessage, steer = true): void {
    this.db.prepare('INSERT INTO task_dispatches (task_id, inbound, steer) VALUES (?, ?, ?)')
      .run(taskId, JSON.stringify(inbound), Number(steer))
  }

  /** The real inbound envelope remains available after execution for source references. */
  get(taskId: number): TaskDispatch | undefined {
    const row = this.db.prepare('SELECT * FROM task_dispatches WHERE task_id = ?').get(taskId) as unknown as DispatchRow | undefined
    return row ? toDispatch(row) : undefined
  }

  pending(): TaskDispatch[] {
    return (this.db.prepare(`SELECT d.* FROM task_dispatches d JOIN tasks t ON t.id = d.task_id
      WHERE d.started_at IS NULL AND t.status = 'queued' ORDER BY t.id`).all() as
      unknown as DispatchRow[]).map(toDispatch)
  }

  /** Only the host may request a resume after current permission and unknown-effect checks.
   * This store preserves the original Task/receipt; generation is part of the next Run's trigger key.
   * A delayed callback for any earlier attempt cannot queue work over a newer attempt or stop. */
  resume(taskId: number, input: Pick<TaskResume, 'previousRunId' | 'reason'>, now: number): boolean {
    if (!input.previousRunId || !['authorization', 'restart', 'local_preparation'].includes(input.reason) || !Number.isSafeInteger(now) || now < 0) return false
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_attempts'").get()) return false
    this.db.exec('SAVEPOINT resume_task_dispatch')
    try {
      const changed = this.resumeCurrent(taskId, input, now)
      this.db.exec('RELEASE SAVEPOINT resume_task_dispatch')
      return changed
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT resume_task_dispatch')
      this.db.exec('RELEASE SAVEPOINT resume_task_dispatch')
      throw error
    }
  }

  private resumeCurrent(taskId: number, input: Pick<TaskResume, 'previousRunId' | 'reason'>, now: number): boolean {
    const row = this.db.prepare(`SELECT d.*, t.message_id, t.requester_open_id, t.session_key, s.chat_id, s.chat_type,
      w.work_key FROM task_dispatches d JOIN tasks t ON t.id = d.task_id JOIN sessions s ON s.session_key = t.session_key
      JOIN work_inputs i ON i.task_id = t.id JOIN work_contexts w ON w.work_key = i.work_key
      WHERE d.task_id = ? AND t.status != 'cancelled' AND coalesce(t.stop_reason, '') != 'user_requested'
        AND s.status != 'archived' AND w.lifecycle = 'open' AND w.root_task_id = t.work_root_task_id
        AND w.session_key = t.session_key AND w.authority_open_id = t.requester_open_id
        AND EXISTS (SELECT 1 FROM task_receipts r WHERE r.task_id = t.id AND r.dedup_key = t.message_id)
        AND NOT EXISTS (SELECT 1 FROM work_pause_reasons p WHERE p.work_key = w.work_key)`).get(taskId) as unknown as
      (DispatchRow & { message_id: string; requester_open_id: string; session_key: string; chat_id: string; chat_type: string; work_key: string }) | undefined
    if (!row || !Number.isSafeInteger(row.generation) || row.generation < 0) return false
    let inbound: InboundMessage, prior: TaskResume | null
    try { inbound = JSON.parse(row.inbound) as InboundMessage; prior = parseResume(row.resume_json) }
    catch { return false }
    if (!inbound || (inbound.senderType !== 'user' && !validTaskEventDispatch(this.db, taskId, inbound) && !validPersonalAssistanceDispatch(this.db, taskId, inbound)) || inbound.messageId !== row.message_id || !row.requester_open_id ||
      inbound.senderOpenId !== row.requester_open_id || inbound.chatId !== row.chat_id || inbound.chatType !== row.chat_type ||
      (row.resume_json !== null && !prior) || prior?.previousRunId === input.previousRunId) return false
    const last = this.db.prepare(`SELECT id, work_key, session_key, actor_open_id, stage, state, stop_reason, finished_at FROM run_attempts
      WHERE task_id = ? AND stage != 'reflect' ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(taskId) as
      { id: string; work_key: string; session_key: string; actor_open_id: string; stage: string; state: string; stop_reason: string | null; finished_at: number | null } | undefined
    if (!last || last.id !== input.previousRunId || last.stage !== 'task' || last.stop_reason === 'user_requested' || last.work_key !== row.work_key || last.session_key !== row.session_key ||
      last.actor_open_id !== row.requester_open_id || !['completed', 'failed', 'cancelled', 'interrupted'].includes(last.state) || last.finished_at === null) return false
    const resume: TaskResume = { previousRunId: input.previousRunId, reason: input.reason, resumedAt: now }
    const claimed = this.db.prepare(`UPDATE task_dispatches SET generation = generation + 1, resume_json = ?, started_at = NULL
      WHERE task_id = ? AND generation = ? AND resume_json IS ?`).run(JSON.stringify(resume), taskId, row.generation, row.resume_json)
    if (!claimed.changes) return false
    const queued = this.db.prepare(`UPDATE tasks SET status = 'queued', error = NULL, finished_at = NULL, stop_reason = NULL, started_at = NULL
      WHERE id = ? AND status != 'cancelled' AND coalesce(stop_reason, '') != 'user_requested'`).run(taskId)
    if (!queued.changes) throw new Error('恢复任务状态在事务中发生变化')
    return true
  }

  started(taskId: number, now: number): void {
    this.db.prepare('UPDATE task_dispatches SET started_at = ? WHERE task_id = ? AND started_at IS NULL').run(now, taskId)
  }
}

function parseResume(json: string | null): TaskResume | null {
  if (json === null) return null
  const value = JSON.parse(json) as Partial<TaskResume> | null
  return value && typeof value.previousRunId === 'string' && Boolean(value.previousRunId) &&
    (value.reason === 'authorization' || value.reason === 'restart' || value.reason === 'local_preparation') && Number.isSafeInteger(value.resumedAt) && value.resumedAt! >= 0
    ? value as TaskResume : null
}
function toDispatch(row: DispatchRow): TaskDispatch {
  return { taskId: row.task_id, inbound: JSON.parse(row.inbound) as InboundMessage, steer: Boolean(row.steer), generation: row.generation,
    resume: parseResume(row.resume_json) }
}
