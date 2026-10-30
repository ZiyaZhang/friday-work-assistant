import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { RunApiCalls } from '../src/core/run-api-calls.js'

const databases: DatabaseSync[] = []
function database() { const db = new DatabaseSync(':memory:'); databases.push(db); return db }
afterEach(() => { databases.splice(0).forEach(db => db.close()) })

describe('tool calls refer to concrete domain receipts', () => {
  it('retains one-to-many operation references across HTTP failure and retries without copying domain state', () => {
    const db = database(), calls = new RunApiCalls(db)
    const first = calls.begin('run', 'POST /prepare')
    calls.reference(first, { kind: 'github_change_preparation', id: 'a' })
    calls.reference(first, { kind: 'github_change_preparation', id: 'b' })
    calls.finish(first, 'failed')
    const retry = calls.begin('run', 'POST /prepare')
    calls.reference(retry, { kind: 'github_change_preparation', id: 'a' })
    calls.reference(retry, { kind: 'github_change_preparation', id: 'a' })
    calls.finish(retry, 'returned')
    const completed = new Set<string>(['a'])
    expect(calls.unresolvedOperations('run', ref => completed.has(ref.id))).toEqual([{ kind: 'github_change_preparation', id: 'b' }])
    completed.add('b')
    expect(new RunApiCalls(db).unresolvedOperations('run', ref => completed.has(ref.id))).toEqual([])
    expect(calls.forRun('run')[1]?.operations).toHaveLength(1)
    expect(() => calls.reference(first, { kind: 'github_change_preparation', id: 'c' })).toThrow(/已结束/)
  })
  it('upgrades old calls twice without inventing receipt identity or changing old call evidence', () => {
    const db = database()
    db.exec(`CREATE TABLE run_api_calls(id TEXT PRIMARY KEY,run_id TEXT,route TEXT,scopes_json TEXT,state TEXT,started_at INTEGER,finished_at INTEGER);
      INSERT INTO run_api_calls VALUES('old','run','POST /write','["github:write"]','failed',1,2)`)
    const first = new RunApiCalls(db).forRun('run')
    expect(first).toEqual([{ id: 'old', runId: 'run', route: 'POST /write', scopes: ['github:write'], state: 'failed' }])
    const before = db.prepare('SELECT * FROM run_api_calls').all()
    new RunApiCalls(db)
    expect(db.prepare('SELECT * FROM run_api_calls').all()).toEqual(before)
  })
  it('retains the original obligation across a status-only continuation, scoped to the same Task and actor', () => {
    const db = database(), calls = new RunApiCalls(db)
    db.exec(`CREATE TABLE run_attempts(id TEXT PRIMARY KEY,task_id INTEGER,stage TEXT,work_key TEXT,session_key TEXT,actor_open_id TEXT);
      INSERT INTO run_attempts VALUES('first',1,'task','work','session','alice'),
      ('other-task',2,'task','work','session','alice'),('other-actor',1,'task','work','session','bob'),
      ('reflect',1,'reflect','work','session','alice'),('continued',1,'task','work','session','alice'),
      ('future',1,'task','work','session','alice')`)
    for (const run of ['first', 'other-task', 'other-actor', 'reflect', 'future']) {
      const id = calls.begin(run, 'POST /prepare')
      calls.reference(id, { kind: 'github_change_preparation', id: `${run}-operation` }); calls.finish(id, 'failed')
    }
    const status = calls.begin('continued', 'POST /list'); calls.finish(status, 'returned')
    expect(calls.unresolvedOperations('continued', () => false)).toEqual([])
    expect(calls.unresolvedTaskOperations('continued', () => false)).toEqual([{ kind: 'github_change_preparation', id: 'first-operation' }])
    expect(calls.unresolvedTaskOperations('continued', ref => ref.id === 'first-operation')).toEqual([])
  })
})
