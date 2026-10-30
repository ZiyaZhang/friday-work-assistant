import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { IssueWatch } from '../src/core/issue-watch.js'

const databases: DatabaseSync[] = [], HOUR = 3600_000
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  let now = 1_800_000_000_000
  const watch = new IssueWatch(db, () => now)
  return { db, watch, clock: () => now, advance: (ms: number) => { now += ms },
    claim: (identity = 'binding-1:thread-1', number = 7) => watch.claimAssessment('sp_a', 'org/repo', number, identity) }
}

describe('durable bounded issue assessment admission', () => {
  it('reserves before work and suppresses concurrent or restarted attempts after a lost result', () => {
    const t = fixture()
    expect(t.claim()).toBeDefined()
    expect(t.claim()).toBeUndefined()
    const restarted = new IssueWatch(t.db, t.clock)
    expect(restarted.claimAssessment('sp_a', 'org/repo', 7, 'binding-1:thread-1')).toBeUndefined()
    t.advance(HOUR)
    expect(t.claim()).toBeDefined()
    expect(t.db.prepare('SELECT attempts FROM github_issue_assessments').get()?.attempts).toBe(2)
  })

  it('waits one hour, then six hours, and stops after three failed attempts for unchanged evidence', () => {
    const t = fixture()
    t.watch.finishAssessment(t.claim()!, false)
    t.advance(HOUR - 1); expect(t.claim()).toBeUndefined()
    t.advance(1); t.watch.finishAssessment(t.claim()!, false)
    t.advance(6 * HOUR - 1); expect(t.claim()).toBeUndefined()
    t.advance(1); t.watch.finishAssessment(t.claim()!, false)
    t.advance(365 * 24 * HOUR); expect(t.claim()).toBeUndefined()
    expect(t.db.prepare('SELECT attempts,status FROM github_issue_assessments').get()).toMatchObject({ attempts: 3, status: 'failed' })
  })

  it('admits changed binding or thread, and rejects stale completions from a replaced attempt', () => {
    const t = fixture(), old = t.claim()!
    const changedThread = t.claim('binding-1:thread-2')!
    expect(changedThread).toBeDefined()
    t.watch.finishAssessment(old, true)
    expect(t.db.prepare('SELECT status FROM github_issue_assessments').get()?.status).toBe('pending')
    t.watch.finishAssessment(changedThread, true)
    expect(t.claim('binding-1:thread-2')).toBeUndefined()
    expect(t.claim('binding-2:thread-2')).toBeDefined()
  })

  it('keeps completed assessments closed and leaves other issues eligible during backoff', () => {
    const t = fixture(), done = t.claim()!
    t.watch.finishAssessment(done, true)
    t.watch.finishAssessment(done, false)
    t.advance(365 * 24 * HOUR); expect(t.claim()).toBeUndefined()
    expect(t.claim('binding-1:thread-1', 8)).toBeDefined()
  })

  it('schema initialization does not create attempts or rewrite an existing notice', () => {
    const t = fixture()
    t.watch.claim('sp_a', 'org/repo', 7)
    const before = t.db.prepare('SELECT * FROM github_issue_notices').all()
    new IssueWatch(t.db, t.clock); new IssueWatch(t.db, t.clock)
    expect(t.db.prepare('SELECT * FROM github_issue_notices').all()).toEqual(before)
    expect(t.db.prepare('SELECT count(*) n FROM github_issue_assessments').get()?.n).toBe(0)
  })
})
