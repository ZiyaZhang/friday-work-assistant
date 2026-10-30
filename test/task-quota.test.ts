import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskQuota, TaskQuotaExceeded } from '../src/core/task-quota.js'

const databases: DatabaseSync[] = []
function setup() { const db = new DatabaseSync(':memory:'); databases.push(db); return { db, quota: new TaskQuota(db) } }
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const now = Date.parse('2026-09-22T15:00:00Z')
describe('daily task admission', () => {
  it('counts before dispatch and never refunds a failed or unknown task', () => {
    const { db, quota } = setup()
    quota.admit({runId:'r1', actorOpenId:'alice', now, limit:1})
    expect(() => quota.admit({runId:'r2', actorOpenId:'alice', now, limit:1})).toThrow(TaskQuotaExceeded)
    expect(db.prepare('SELECT count(*) n FROM model_task_admissions').get()?.n).toBe(1)
    expect(() => new TaskQuota(db).admit({runId:'r2', actorOpenId:'alice', now, limit:1})).toThrow(TaskQuotaExceeded)
  })
  it('allows a wrap-up of the same Run without charging twice, including after midnight', () => {
    const { db, quota } = setup()
    quota.admit({runId:'r1', actorOpenId:'alice', now, limit:1})
    quota.admit({runId:'r1', actorOpenId:'alice', now:now+2*3600_000, limit:0})
    expect(db.prepare('SELECT count(*) n FROM model_task_admissions').get()?.n).toBe(1)
  })
  it('uses company-local midnight, keeps actors independent and never queues a task by itself', () => {
    const { db, quota } = setup()
    quota.admit({runId:'r1', actorOpenId:'alice', now, limit:1})
    quota.admit({runId:'r2', actorOpenId:'bob', now, limit:1})
    quota.admit({runId:'r3', actorOpenId:'alice', now:Date.parse('2026-09-22T16:00:00Z'), limit:1})
    expect(db.prepare('SELECT day FROM model_task_admissions WHERE run_id=?').get('r3')?.day).toBe('2026-09-23')
    expect(db.prepare('SELECT count(*) n FROM model_task_admissions').get()?.n).toBe(3)
  })
  it('treats zero as no new work and explicit unlimited as no count ceiling', () => {
    const { quota } = setup()
    expect(() => quota.admit({runId:'r1', actorOpenId:'alice', now, limit:0})).toThrow('暂停新任务')
    quota.admit({runId:'r1', actorOpenId:'alice', now, limit:undefined})
    quota.admit({runId:'r2', actorOpenId:'alice', now, limit:undefined})
  })
  it('cannot reuse another actor admission or accept invalid configuration', () => {
    const { quota } = setup()
    quota.admit({runId:'r1', actorOpenId:'alice', now, limit:1})
    expect(() => quota.admit({runId:'r1', actorOpenId:'bob', now, limit:1})).toThrow('主体不能改变')
    for (const limit of [-1, NaN, 0.5]) expect(() => quota.admit({runId:'r2', actorOpenId:'alice', now, limit})).toThrow('配置无效')
  })
})
