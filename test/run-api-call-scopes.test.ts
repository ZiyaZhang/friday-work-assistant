import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { RunApiCalls } from '../src/core/run-api-calls.js'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const calls = new RunApiCalls(db)
  db.exec(`CREATE TABLE scope_updates (call_id TEXT NOT NULL);
    CREATE TRIGGER count_scope_updates AFTER UPDATE OF scopes_json ON run_api_calls
    BEGIN INSERT INTO scope_updates(call_id) VALUES (NEW.id); END;`)
  const id = calls.begin('run', 'POST /v1/github/change/files/search')
  const updates = () => Number(db.prepare('SELECT count(*) AS n FROM scope_updates WHERE call_id=?').get(id)!.n)
  return { db, calls, id, updates }
}

describe('Run API scope evidence is idempotent, not an authorization cache', () => {
  it('writes one scope receipt across repeated guards and records each distinct scope once', () => {
    const t = fixture()
    for (let i = 0; i < 2000; i++) t.calls.need(t.id, 'github:read')
    expect(t.updates()).toBe(1)
    t.calls.need(t.id, 'github:write')
    t.calls.need(t.id, 'github:write')
    t.calls.need(t.id, 'github:read')
    expect(t.updates()).toBe(2)
    expect(t.calls.forRun('run')[0]).toMatchObject({ scopes: ['github:read', 'github:write'], state: 'started' })
  })

  it.each(['returned', 'failed'] as const)('rejects even a previously recorded scope after the real call becomes %s', state => {
    const t = fixture()
    t.calls.need(t.id, 'github:read')
    t.calls.finish(t.id, state)
    expect(() => t.calls.need(t.id, 'github:read')).toThrow('本次工具调用已结束')
    expect(() => t.calls.need(t.id, 'github:write')).toThrow('本次工具调用已结束')
    expect(t.updates()).toBe(1)
    expect(t.calls.forRun('run')[0]).toMatchObject({ scopes: ['github:read'], state })
  })

  it('reads current persisted evidence instead of remembering a prior successful check', () => {
    const t = fixture()
    t.calls.need(t.id, 'github:read')
    t.db.prepare("UPDATE run_api_calls SET scopes_json='[]' WHERE id=?").run(t.id)
    t.calls.need(t.id, 'github:read')
    expect(t.updates()).toBe(3) // first receipt, explicit external change, current receipt
    t.db.prepare('DELETE FROM run_api_calls WHERE id=?').run(t.id)
    expect(() => t.calls.need(t.id, 'github:read')).toThrow('本次工具调用已结束')
  })
})
