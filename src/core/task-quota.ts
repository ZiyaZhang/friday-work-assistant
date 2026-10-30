import type { DatabaseSync } from 'node:sqlite'

/** Counts admitted tasks, not tokens or money. A dispatched task is never refunded on timeout. */
export class TaskQuotaExceeded extends Error {
  constructor(readonly limit: number, readonly day: string) {
    super(limit === 0 ? '当前已暂停新任务。查看进度和停止操作仍可使用。'
      : `今天的新任务次数已达到 ${limit} 次上限。请明天重新发起，或请管理员调整额度；本次没有自动排到次日。`)
    this.name = 'TaskQuotaExceeded'
  }
}

export class TaskQuota {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS model_task_admissions (
      run_id TEXT PRIMARY KEY,
      actor_open_id TEXT NOT NULL,
      day TEXT NOT NULL,
      admitted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_task_admissions_actor_day
      ON model_task_admissions(actor_open_id, day);`)
  }

  /** The first prompt dispatch consumes one slot; wrap-up prompts of the same Run do not. */
  admit(input: { runId: string; actorOpenId: string; now: number; limit: number | undefined }): void {
    if (!input.runId || !input.actorOpenId || !Number.isFinite(input.now)) throw new Error('任务额度缺少可信执行身份')
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 0)) throw new Error('任务额度配置无效')
    const day = new Date(input.now + 8 * 3600_000).toISOString().slice(0, 10)
    this.db.exec('SAVEPOINT model_task_admission')
    try {
      const previous = this.db.prepare('SELECT actor_open_id FROM model_task_admissions WHERE run_id=?').get(input.runId)
      if (previous && previous.actor_open_id !== input.actorOpenId) throw new Error('任务额度主体不能改变')
      if (!previous) {
        const row = this.db.prepare('SELECT count(*) AS n FROM model_task_admissions WHERE actor_open_id=? AND day=?').get(input.actorOpenId, day)!
        if (input.limit !== undefined && Number(row.n) >= input.limit) throw new TaskQuotaExceeded(input.limit, day)
        this.db.prepare('INSERT INTO model_task_admissions(run_id,actor_open_id,day,admitted_at) VALUES(?,?,?,?)')
          .run(input.runId, input.actorOpenId, day, input.now)
      }
      this.db.exec('RELEASE model_task_admission')
    } catch (error) {
      this.db.exec('ROLLBACK TO model_task_admission; RELEASE model_task_admission')
      throw error
    }
  }
}
