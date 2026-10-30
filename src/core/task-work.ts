import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

export type TaskWorkKey = `task:${number}`
export interface TaskWorkRef { key: TaskWorkKey; rootTaskId: number }

interface WorkRow extends Record<string, SQLOutputValue> {
  id: number
  session_key: string
  requester_open_id: string | null
  work_root_task_id: number | null
}
interface AmendmentWorkRow extends WorkRow { prior_task_id: number | null }

/** Stable links between existing Tasks; not an execution or authorization store. */
export class TaskWork {
  constructor(private readonly db: DatabaseSync) {
    db.exec('SAVEPOINT migrate_task_work')
    try {
      const columns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
      if (!columns.some(column => column.name === 'work_root_task_id')) {
        db.exec('ALTER TABLE tasks ADD COLUMN work_root_task_id INTEGER REFERENCES tasks(id)')
      }
      // Only actual host-recorded amendment edges join old work. In particular,
      // duplicate message IDs and a shared Session do not establish an edge.
      const rows = db.prepare(`SELECT t.id, t.session_key, t.requester_open_id, t.work_root_task_id, a.prior_task_id
        FROM tasks t LEFT JOIN task_amendments a ON a.task_id = t.id
        WHERE t.work_root_task_id IS NULL ORDER BY t.id`).all() as AmendmentWorkRow[]
      const fill = db.prepare('UPDATE tasks SET work_root_task_id = ? WHERE id = ? AND work_root_task_id IS NULL')
      for (const row of rows) {
        if (row.prior_task_id === null) {
          fill.run(row.id, row.id)
          continue
        }
        const prior = this.row(row.prior_task_id)
        const root = prior && prior.id < row.id && this.sameOrigin(row, prior) ? this.get(prior.id) : undefined
        // An explicit broken link is unknown, not permission to invent a root.
        if (root) fill.run(root.rootTaskId, row.id)
      }
      db.exec('RELEASE SAVEPOINT migrate_task_work')
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT migrate_task_work')
      db.exec('RELEASE SAVEPOINT migrate_task_work')
      throw error
    }
  }

  get(taskId: number): TaskWorkRef | undefined {
    const task = this.row(taskId)
    if (!task || task.work_root_task_id === null) return undefined
    const root = this.row(task.work_root_task_id)
    if (!root || root.work_root_task_id !== root.id || root.id > task.id || (root.id !== task.id && !this.sameOrigin(task, root))) return undefined
    return { key: `task:${root.id}`, rootTaskId: root.id }
  }

  /** Called only for a just-inserted Task, within the caller's creation transaction. */
  initialize(taskId: number, fromTaskId?: number): TaskWorkRef {
    const task = this.row(taskId)
    if (!task || task.work_root_task_id !== null) throw new Error('工作根只能在创建任务时绑定')
    let rootTaskId = task.id
    if (fromTaskId !== undefined) {
      const prior = this.row(fromTaskId)
      const root = prior && prior.id < task.id && this.sameOrigin(task, prior) ? this.get(prior.id) : undefined
      if (!root) throw new Error('来源任务的工作关系不完整，不能继承')
      rootTaskId = root.rootTaskId
    }
    this.db.prepare('UPDATE tasks SET work_root_task_id = ? WHERE id = ? AND work_root_task_id IS NULL').run(rootTaskId, taskId)
    return { key: `task:${rootTaskId}`, rootTaskId }
  }

  private row(taskId: number): WorkRow | undefined {
    return this.db.prepare('SELECT id, session_key, requester_open_id, work_root_task_id FROM tasks WHERE id = ?').get(taskId) as WorkRow | undefined
  }

  private sameOrigin(a: WorkRow, b: WorkRow): boolean {
    return a.session_key === b.session_key && Boolean(a.requester_open_id) && a.requester_open_id === b.requester_open_id
  }
}
