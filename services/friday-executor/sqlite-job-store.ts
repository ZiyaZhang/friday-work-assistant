import type { DatabaseSync } from 'node:sqlite'
import type { JobReceipt, JobStore } from '../../cloudflare/friday-executor/src/job-controller.js'
import type { JobInput } from '../../cloudflare/friday-executor/src/job-protocol.js'

/** Provider-local receipts, not another Friday Task queue. Keep this database
 * private to the service account; inputs may contain private source code. */
export class SqliteJobStores {
  constructor(private readonly db: DatabaseSync, private readonly onAlarm: (id: string, at: number | null) => void = () => {}) {
    db.exec(`CREATE TABLE IF NOT EXISTS executor_jobs (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('queued','running','stopping','finished')),
      receipt_json TEXT NOT NULL,
      input_json TEXT,
      alarm_at INTEGER
    ); CREATE INDEX IF NOT EXISTS executor_jobs_state ON executor_jobs(state);`)
  }

  receipt(id: string): JobReceipt | undefined {
    const row = this.db.prepare('SELECT receipt_json FROM executor_jobs WHERE id=?').get(id) as { receipt_json: string } | undefined
    return row ? JSON.parse(row.receipt_json) as JobReceipt : undefined
  }
  unfinished(): Array<{ id: string; alarmAt: number | null }> {
    return (this.db.prepare("SELECT id,alarm_at FROM executor_jobs WHERE state != 'finished' ORDER BY rowid").all() as
      Array<{ id: string; alarm_at: number | null }>).map(row => ({ id: row.id, alarmAt: row.alarm_at }))
  }
  countUnfinished(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM executor_jobs WHERE state != 'finished'").get() as { count: number }).count
  }
  alarmAt(id: string): number | null {
    return (this.db.prepare('SELECT alarm_at FROM executor_jobs WHERE id=?').get(id) as { alarm_at: number | null } | undefined)?.alarm_at ?? null
  }
  forJob(id: string): JobStore {
    return {
      load: async () => this.receipt(id),
      input: async () => {
        const row = this.db.prepare('SELECT input_json FROM executor_jobs WHERE id=?').get(id) as { input_json: string | null } | undefined
        return row?.input_json ? JSON.parse(row.input_json) as JobInput : undefined
      },
      save: async (receipt, input) => {
        if (receipt.id !== id) throw new Error('job_identity_mismatch')
        // Each statement atomically updates the receipt and its input. Preserve
        // an existing scheduled alarm until the controller explicitly changes it.
        if (input === undefined) {
          const saved = this.db.prepare('UPDATE executor_jobs SET state=?,receipt_json=? WHERE id=?')
            .run(receipt.state, JSON.stringify(receipt), id)
          if (saved.changes !== 1) throw new Error('job_receipt_missing')
        } else {
          this.db.prepare(`INSERT INTO executor_jobs(id,state,receipt_json,input_json,alarm_at) VALUES(?,?,?,?,NULL)
            ON CONFLICT(id) DO UPDATE SET state=excluded.state,receipt_json=excluded.receipt_json,input_json=excluded.input_json`)
            .run(id, receipt.state, JSON.stringify(receipt), input === null ? null : JSON.stringify(input))
        }
      },
      alarm: async at => {
        const saved = this.db.prepare('UPDATE executor_jobs SET alarm_at=? WHERE id=?').run(at, id)
        if (saved.changes !== 1) throw new Error('job_receipt_missing')
        this.onAlarm(id, at)
      },
    }
  }
}
