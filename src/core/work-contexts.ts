import type { DatabaseSync } from 'node:sqlite'

/**
 * Thin delegation lifecycle over the existing Task work roots (`task:<rootTaskId>`).
 * It records whether Friday should still continue a piece of work, which real inputs it has, and a control epoch
 * that makes earlier admissions stale. Case, Issue/PR, routine and delivery facts stay in their own stores;
 * running/queued/waiting are derived from those facts and never written here.
 */
export type WorkLifecycle = 'open' | 'completed' | 'cancelled'
export type WorkPauseReason = 'manual' | 'run_stop' | 'authorization' | 'space_disabled' | 'config_invalid' | 'executor_unavailable'
export type WorkInputKind = 'instruction' | 'evidence' | 'control'
export type WorkActivity = 'running' | 'stopping' | 'paused' | 'queued' | 'waiting' | 'needs_attention' | 'idle'

export interface WorkPause { reason: WorkPauseReason; causeRef: string }
export interface WorkContext {
  workKey: string
  rootTaskId: number
  sessionKey: string
  authorityOpenId: string | null
  lifecycle: WorkLifecycle
  revision: number
  controlEpoch: number
  inputSeq: number
  handledSeq: number
  pauseReasons: WorkPause[]
  createdAt: number
  updatedAt: number
}
export interface WorkInput { seq: number; taskId: number; kind: WorkInputKind }
export interface WorkView extends WorkContext {
  activity: WorkActivity
  runId: string | null
  /** Inputs with a queued/running Task, not a difference between historical sequence watermarks. */
  pending: { inputs: number; questions: number; unknownDeliveries: number }
}
export type WorkControl =
  | { action: 'pause' | 'resume'; reason: WorkPauseReason; causeRef: string; expectedRevision?: number }
  | { action: 'cancel' | 'complete' | 'reopen'; causeRef: string; expectedRevision?: number }

/** An admission taken under an earlier control epoch reached the dispatch point after a control changed the work. */
export class WorkAdmissionStale extends Error {
  constructor(readonly workKey: string) {
    super('这段工作在准备期间收到了控制变更，这次准入已失效')
    this.name = 'WorkAdmissionStale'
  }
}

export class WorkControlError extends Error {
  constructor(readonly code: 'unknown_work' | 'cancelled' | 'completed' | 'paused' | 'stale_revision' | 'invalid_transition' | 'unknown_input', message: string) {
    super(message)
    this.name = 'WorkControlError'
  }
}

const PAUSE_REASONS = new Set<WorkPauseReason>(['manual', 'run_stop', 'authorization', 'space_disabled', 'config_invalid', 'executor_unavailable'])

export class WorkContexts {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_contexts (
        work_key TEXT PRIMARY KEY,
        root_task_id INTEGER NOT NULL REFERENCES tasks(id),
        session_key TEXT NOT NULL,
        authority_open_id TEXT,
        lifecycle TEXT NOT NULL CHECK(lifecycle IN ('open','completed','cancelled')),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        control_epoch INTEGER NOT NULL CHECK(control_epoch >= 1),
        input_seq INTEGER NOT NULL CHECK(input_seq >= 0),
        handled_seq INTEGER NOT NULL CHECK(handled_seq >= 0 AND handled_seq <= input_seq),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_inputs (
        work_key TEXT NOT NULL REFERENCES work_contexts(work_key),
        seq INTEGER NOT NULL CHECK(seq >= 1),
        task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id),
        kind TEXT NOT NULL CHECK(kind IN ('instruction','evidence','control')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(work_key, seq)
      );
      CREATE TABLE IF NOT EXISTS work_pause_reasons (
        work_key TEXT NOT NULL REFERENCES work_contexts(work_key),
        reason TEXT NOT NULL CHECK(reason IN ('manual','run_stop','authorization','space_disabled','config_invalid','executor_unavailable')),
        cause_ref TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(work_key, reason, cause_ref)
      );
    `)
    this.backfill()
  }

  get(workKey: string): WorkContext | undefined {
    const row = this.db.prepare('SELECT * FROM work_contexts WHERE work_key = ?').get(workKey) as Record<string, unknown> | undefined
    return row ? this.toContext(row) : undefined
  }

  inputs(workKey: string): WorkInput[] {
    return (this.db.prepare('SELECT seq, task_id, kind FROM work_inputs WHERE work_key = ? ORDER BY seq').all(workKey) as
      { seq: number; task_id: number; kind: WorkInputKind }[]).map(row => ({ seq: row.seq, taskId: row.task_id, kind: row.kind }))
  }

  /**
   * Called by Registry inside the Task creation transaction, after the work root is bound.
   * A completed work is reopened by a new real input; a cancelled work keeps the input on record without reviving.
   * A new instruction also lifts the pauses caused by stopping this work's Runs: the person who stopped is asking to go on.
   */
  registerTask(input: { taskId: number; workKey: string; rootTaskId: number; sessionKey: string; authorityOpenId: string | null; kind?: WorkInputKind; now?: number }): WorkContext {
    const now = input.now ?? this.now()
    const existing = this.get(input.workKey), kind = input.kind ?? 'instruction'
    if (!existing) {
      this.db.prepare(`INSERT INTO work_contexts (work_key, root_task_id, session_key, authority_open_id, lifecycle, revision, control_epoch, input_seq, handled_seq, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', 1, 1, 0, 0, ?, ?)`).run(input.workKey, input.rootTaskId, input.sessionKey, input.authorityOpenId, now, now)
    } else if (existing.lifecycle === 'completed' && kind === 'instruction') {
      this.db.prepare("UPDATE work_contexts SET lifecycle = 'open', revision = revision + 1, control_epoch = control_epoch + 1, updated_at = ? WHERE work_key = ?").run(now, input.workKey)
    } else if (existing.lifecycle === 'open' && kind === 'instruction' && existing.pauseReasons.some(pause => pause.reason === 'run_stop')) {
      this.db.prepare("DELETE FROM work_pause_reasons WHERE work_key = ? AND reason = 'run_stop'").run(input.workKey)
      this.db.prepare('UPDATE work_contexts SET revision = revision + 1, control_epoch = control_epoch + 1, updated_at = ? WHERE work_key = ?').run(now, input.workKey)
    }
    const seq = (existing?.inputSeq ?? 0) + 1
    this.db.prepare('INSERT INTO work_inputs (work_key, seq, task_id, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.workKey, seq, input.taskId, kind, now)
    this.db.prepare('UPDATE work_contexts SET input_seq = ?, updated_at = ? WHERE work_key = ?').run(seq, now, input.workKey)
    return this.get(input.workKey)!
  }

  /** Admission check for a new Run of this work; the caller commits it together with the Run/Task claim. */
  claim(workKey: string): { controlEpoch: number; inputSeq: number } {
    const context = this.get(workKey)
    if (!context) throw new WorkControlError('unknown_work', '这段工作没有登记，不能开始执行（unknown work）')
    if (context.lifecycle === 'cancelled') throw new WorkControlError('cancelled', '这段工作已取消，不再开始新的执行（cancelled）')
    if (context.lifecycle === 'completed') throw new WorkControlError('completed', '这段工作已完成；继续需要新的真实输入（completed）')
    if (context.pauseReasons.length) {
      throw new WorkControlError('paused', `这段工作已暂停（${context.pauseReasons.map(pause => pause.reason).join('、')}），恢复对应原因后才继续`)
    }
    return { controlEpoch: context.controlEpoch, inputSeq: context.inputSeq }
  }

  isCurrentEpoch(workKey: string, controlEpoch: number): boolean {
    return this.get(workKey)?.controlEpoch === controlEpoch
  }

  /** The Run that executed this Task consumed every input up to it; the sequence never moves backwards. */
  markHandled(workKey: string, taskId: number): WorkContext {
    const row = this.db.prepare('SELECT seq FROM work_inputs WHERE work_key = ? AND task_id = ?').get(workKey, taskId) as { seq: number } | undefined
    if (!row) throw new WorkControlError('unknown_input', '这条任务不属于该工作的已登记输入')
    this.db.prepare('UPDATE work_contexts SET handled_seq = MAX(handled_seq, ?), updated_at = ? WHERE work_key = ?').run(row.seq, this.now(), workKey)
    return this.get(workKey)!
  }

  /** Every control bumps the revision and the control epoch; pause reasons are a set keyed by reason and cause. */
  control(workKey: string, control: WorkControl): WorkContext {
    const context = this.get(workKey)
    if (!context) throw new WorkControlError('unknown_work', '这段工作没有登记（unknown work）')
    if (control.expectedRevision !== undefined && control.expectedRevision !== context.revision) {
      throw new WorkControlError('stale_revision', '工作状态已被其他操作更新，请重新读取后再操作')
    }
    const now = this.now()
    this.db.exec('SAVEPOINT work_control')
    try {
      if (control.action === 'pause' || control.action === 'resume') {
        if (!PAUSE_REASONS.has(control.reason) || !control.causeRef.trim()) throw new WorkControlError('invalid_transition', '暂停原因或来源无效')
        if (control.action === 'pause') {
          this.db.prepare('INSERT OR IGNORE INTO work_pause_reasons (work_key, reason, cause_ref, created_at) VALUES (?, ?, ?, ?)').run(workKey, control.reason, control.causeRef, now)
        } else {
          this.db.prepare('DELETE FROM work_pause_reasons WHERE work_key = ? AND reason = ? AND cause_ref = ?').run(workKey, control.reason, control.causeRef)
        }
      } else if (control.action === 'cancel') {
        if (context.lifecycle === 'cancelled') { this.db.exec('RELEASE work_control'); return context }
      } else if (control.action === 'complete') {
        if (context.lifecycle !== 'open') throw new WorkControlError('invalid_transition', `工作当前为 ${context.lifecycle}，不能标记完成`)
      } else if (control.action === 'reopen') {
        if (context.lifecycle !== 'completed') throw new WorkControlError('invalid_transition', `工作当前为 ${context.lifecycle}，只有已完成的工作可以重新打开`)
      }
      const lifecycle: WorkLifecycle = control.action === 'cancel' ? 'cancelled' : control.action === 'complete' ? 'completed'
        : control.action === 'reopen' ? 'open' : context.lifecycle
      this.db.prepare('UPDATE work_contexts SET lifecycle = ?, revision = revision + 1, control_epoch = control_epoch + 1, updated_at = ? WHERE work_key = ?')
        .run(lifecycle, now, workKey)
      this.db.exec('RELEASE work_control')
    } catch (error) {
      this.db.exec('ROLLBACK TO work_control; RELEASE work_control')
      throw error
    }
    return this.get(workKey)!
  }

  /** Activity is read from Run, Task, question and delivery facts at query time. */
  view(workKey: string): WorkView | undefined {
    const context = this.get(workKey)
    if (!context) return undefined
    const run = this.hasTable('run_attempts') ? this.db.prepare(`SELECT id, state FROM run_attempts WHERE work_key = ? AND state IN ('running','stop_requested')
      ORDER BY started_at DESC LIMIT 1`).get(workKey) as { id: string; state: string } | undefined : undefined
    // Cancellation retires only its Task; advancing handled_seq here would also
    // consume earlier human inputs. Conversely, a host-authorized new generation
    // can requeue an already consumed input. Derive both counts from current Tasks
    // while preserving the original input journal and its consumption watermark.
    const tasks = this.db.prepare(`SELECT COUNT(*) AS pending, COUNT(CASE WHEN t.status = 'queued' THEN 1 END) AS queued
      FROM work_inputs i JOIN tasks t ON t.id = i.task_id WHERE i.work_key = ? AND t.status IN ('queued','running')`)
      .get(workKey) as { pending: number; queued: number }
    const queued = Number(tasks.queued)
    const questions = this.hasTable('bug_questions') ? Number(this.db.prepare(`SELECT COUNT(*) AS n FROM bug_questions q JOIN work_inputs i ON i.task_id = q.origin_task_id
      WHERE i.work_key = ? AND q.resolution = 'open'`).get(workKey)!.n) : 0
    const unknownDeliveries = this.hasTable('deliveries') ? Number(this.db.prepare(`SELECT COUNT(*) AS n FROM deliveries d WHERE d.status IN ('planned','unknown') AND EXISTS (
      SELECT 1 FROM work_inputs i JOIN tasks t ON t.id = i.task_id WHERE i.work_key = ? AND d.context_ref LIKE 'task:' || t.id || ':session:%')`).get(workKey)!.n) : 0
    const activity: WorkActivity = run ? (run.state === 'stop_requested' ? 'stopping' : 'running')
      : context.lifecycle !== 'open' ? 'idle'
      : context.pauseReasons.length ? 'paused'
      : queued ? 'queued' : questions ? 'waiting' : unknownDeliveries ? 'needs_attention' : 'idle'
    return { ...context, activity, runId: run?.id ?? null,
      pending: { inputs: Number(tasks.pending), questions, unknownDeliveries } }
  }

  /** Existing work roots become open contexts; inputs are the recorded Tasks in ID order, handled up to the last finished one. */
  private backfill(): void {
    const columns = this.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
    if (!columns.some(column => column.name === 'work_root_task_id')) return
    const roots = this.db.prepare(`SELECT t.work_root_task_id AS root FROM tasks t
      WHERE t.work_root_task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM work_contexts c WHERE c.work_key = 'task:' || t.work_root_task_id)
      GROUP BY t.work_root_task_id ORDER BY t.work_root_task_id`).all() as { root: number }[]
    if (!roots.length) return
    this.db.exec('SAVEPOINT work_context_backfill')
    try {
      const now = this.now()
      for (const { root } of roots) {
        const tasks = this.db.prepare(`SELECT id, session_key, requester_open_id, status, created_at FROM tasks WHERE work_root_task_id = ? ORDER BY id`).all(root) as
          { id: number; session_key: string; requester_open_id: string | null; status: string; created_at: number }[]
        const first = tasks[0]
        if (!first || first.id !== root) continue
        let handled = 0
        tasks.forEach((task, index) => { if (['done', 'failed', 'cancelled'].includes(task.status)) handled = index + 1 })
        const key = `task:${root}`
        this.db.prepare(`INSERT INTO work_contexts (work_key, root_task_id, session_key, authority_open_id, lifecycle, revision, control_epoch, input_seq, handled_seq, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'open', 1, 1, ?, ?, ?, ?)`).run(key, root, first.session_key, first.requester_open_id, tasks.length, handled, first.created_at, now)
        const insert = this.db.prepare("INSERT INTO work_inputs (work_key, seq, task_id, kind, created_at) VALUES (?, ?, ?, 'instruction', ?)")
        tasks.forEach((task, index) => insert.run(key, index + 1, task.id, task.created_at))
      }
      this.db.exec('RELEASE work_context_backfill')
    } catch (error) {
      this.db.exec('ROLLBACK TO work_context_backfill; RELEASE work_context_backfill')
      throw error
    }
  }

  private hasTable(name: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
  }

  private toContext(row: Record<string, unknown>): WorkContext {
    const workKey = String(row.work_key)
    const pauses = this.db.prepare('SELECT reason, cause_ref FROM work_pause_reasons WHERE work_key = ? ORDER BY created_at, reason, cause_ref').all(workKey) as
      { reason: WorkPauseReason; cause_ref: string }[]
    return { workKey, rootTaskId: Number(row.root_task_id), sessionKey: String(row.session_key),
      authorityOpenId: row.authority_open_id == null ? null : String(row.authority_open_id), lifecycle: row.lifecycle as WorkLifecycle,
      revision: Number(row.revision), controlEpoch: Number(row.control_epoch), inputSeq: Number(row.input_seq), handledSeq: Number(row.handled_seq),
      pauseReasons: pauses.map(pause => ({ reason: pause.reason, causeRef: pause.cause_ref })), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }
  }
}
