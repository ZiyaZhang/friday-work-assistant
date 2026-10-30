import type { DatabaseSync } from 'node:sqlite'
import type { MaterialProvenance } from '../core/execution-materials.js'
import type { RetainedSourceOrigin } from '../core/retained-source-access.js'
import type { ExecutionSourceAccessResult } from '../core/execution-source-access.js'
import { createHash } from 'node:crypto'
import { DeviceError } from './devices.js'

export interface PersonalResult { body: string; provenance: MaterialProvenance; origin: RetainedSourceOrigin }
export function ensurePersonalResultSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS personal_results (task_id INTEGER PRIMARY KEY,owner TEXT NOT NULL,record TEXT NOT NULL,created_at INTEGER NOT NULL)`)
}
/** The exact user-facing answer and complete source snapshot; never reasoning or a runtime transcript. */
export class PersonalResults {
  constructor(private readonly db: DatabaseSync, private readonly authorize: (value: PersonalResult, guard: () => void) => Promise<ExecutionSourceAccessResult>) {
    ensurePersonalResultSchema(db)
  }
  save(value: PersonalResult, now: number) {
    if (value.origin.chatType !== 'p2p' || value.origin.spaceId !== `sp_dm_${value.origin.ownerOpenId}` || !value.body.trim() || value.body.length > 200_000)
      throw new Error('Invalid personal result')
    this.db.prepare('INSERT INTO personal_results VALUES(?,?,?,?) ON CONFLICT(task_id) DO NOTHING')
      .run(value.origin.taskId, value.origin.ownerOpenId, JSON.stringify(value), now)
  }
  has(owner: string, taskId: number) { return Boolean(this.db.prepare('SELECT 1 FROM personal_results WHERE task_id=? AND owner=?').get(taskId, owner)) }
  /** Local identity only, never authorization to reveal a saved answer. */
  metadata(owner: string, taskId: number) {
    const row = this.db.prepare('SELECT record,created_at FROM personal_results WHERE task_id=? AND owner=?').get(taskId, owner)
    if (!row) return undefined
    const version = createHash('sha256').update(JSON.stringify([owner, taskId, row.created_at, row.record])).digest('hex')
    return { version, createdAt: Number(row.created_at) }
  }
  async read(owner: string, taskId: number, guard: () => void): Promise<() => { body: string; taskId: number; createdAt: number; version: string }> {
    const material = await this.material(owner, taskId, guard)
    return () => {
      const value = material()
      const metadata = this.metadata(owner, taskId)!
      return { taskId, body: value.body, ...metadata }
    }
  }
  async material(owner: string, taskId: number, guard: () => void): Promise<() => PersonalResult> {
    guard()
    const row = this.db.prepare('SELECT record FROM personal_results WHERE task_id=? AND owner=?').get(taskId, owner)
    if (!row) throw new DeviceError('denied', '这份结果暂不可用。')
    const value = JSON.parse(String(row.record)) as PersonalResult
    if (value.origin.ownerOpenId !== owner || value.origin.taskId !== taskId) throw new DeviceError('denied', '这份结果不属于本人。')
    const current = () => {
      guard()
      if (this.db.prepare('SELECT record FROM personal_results WHERE task_id=? AND owner=?').get(taskId, owner)?.record !== row.record)
        throw new DeviceError('conflict', '结果已变化，请重新打开。')
    }
    const access = await this.authorize(value, current)
    current(); access.assertCurrent()
    if (access.status !== 'allowed') throw new DeviceError('denied', '这份结果的来源暂不可用，请恢复连接后再查看。')
    return () => { current(); access.assertCurrent(); return structuredClone(value) }
  }
}
