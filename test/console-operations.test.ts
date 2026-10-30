import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsoleSessionStore } from '../src/core/console-sessions.js'
import { ConsoleOperations, type ConsoleOperationCallbacks, type ConsoleOperationInput } from '../src/core/console-operations.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
const identity = { appId: 'synthetic-app', tenantKey: 'synthetic-tenant', openId: 'synthetic-alice', name: 'Synthetic Alice' }
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-console-operations-')), path = join(home, 'test.db')
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  let db = new DatabaseSync(path), now = 1000
  cleanups.push(() => db.close())
  const sessionOptions = { now: () => now, ttlMs: 10_000, idleTimeoutMs: 1000 }
  let sessions = new ConsoleSessionStore(db, sessionOptions)
  const credentials = sessions.create(identity)
  db.exec('CREATE TABLE domain_state(id INTEGER PRIMARY KEY,value INTEGER NOT NULL); INSERT INTO domain_state VALUES(1,0)')
  let operations = new ConsoleOperations(db, { sessions, now: () => now })
  const input: ConsoleOperationInput = { actor: credentials.actor, requestId: 'synthetic-request-0001', spaceId: 'synthetic-space',
    operation: 'routine.pause', resourceId: '1', input: { expectedVersion: 1 } }
  const value = () => Number(db.prepare('SELECT value FROM domain_state WHERE id=1').get()!.value)
  const rows = () => db.prepare('SELECT * FROM console_operations').all()
  const callbacks = (afterCommit?: () => void | Promise<void>): ConsoleOperationCallbacks => ({
    authorize: vi.fn(),
    persist: vi.fn(context => {
      expect(db.prepare('SELECT id,session_id,actor_open_id,space_id,resource_id,result_json FROM console_operations WHERE id=?')
        .get(context.operationId)).toMatchObject({ id: context.operationId, session_id: context.actor.sessionId,
          actor_open_id: context.actor.openId, space_id: context.spaceId, resource_id: context.resourceId, result_json: null })
      db.exec('SAVEPOINT synthetic_domain; UPDATE domain_state SET value=value+1 WHERE id=1; RELEASE synthetic_domain')
      return { appliedResult: { changed: true, state: 'paused', version: value(), affectedRunIds: ['synthetic-run-a'] }, afterCommit }
    }),
  })
  return { get db() { return db }, get sessions() { return sessions }, get operations() { return operations },
    path, input, credentials, value, rows, callbacks, time: (at: number) => { now = at },
    reopen() {
      db.close(); db = new DatabaseSync(path)
      sessions = new ConsoleSessionStore(db, sessionOptions)
      operations = new ConsoleOperations(db, { sessions, now: () => now })
    } }
}

describe('durable human console operations', () => {
  it('commits the server operation and nested domain write before cleanup, storing no form or auth secrets', async () => {
    const t = fixture(), form = 'SYNTHETIC_FORM_BODY_DO_NOT_RETAIN'
    const observer = new DatabaseSync(t.path, { readOnly: true }); cleanups.push(() => observer.close())
    const cleanup = vi.fn(() => {
      expect(observer.prepare('SELECT value FROM domain_state WHERE id=1').get()?.value).toBe(1)
      expect(observer.prepare('SELECT count(*) AS n FROM console_operations WHERE result_json IS NOT NULL').get()?.n).toBe(1)
    })
    const result = await t.operations.execute({ ...t.input, input: { expectedVersion: 1, body: form } }, t.callbacks(cleanup))
    expect(result).toMatchObject({ replayed: false, appliedAt: 1000, appliedResult: { changed: true, state: 'paused', version: 1 }, runtimeCleanup: 'complete' })
    expect(result.operationId).not.toBe(t.input.requestId)
    expect(cleanup).toHaveBeenCalledOnce()
    const raw = JSON.stringify(t.rows())
    expect(raw).not.toContain(form)
    expect(raw).not.toContain(t.credentials.token)
    expect(raw).not.toContain(t.sessions.csrfFor(t.input.actor))
    expect(t.rows()[0]!.input_digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('reopens and returns the original fact after current access checks, without repeating mutation CAS', async () => {
    const t = fixture(), calls = t.callbacks()
    const first = await t.operations.execute({ ...t.input, input: { expectedVersion: 1, patch: { b: 2, a: 1 } } }, calls)
    t.db.exec('UPDATE domain_state SET value=9 WHERE id=1')
    t.reopen()
    const authorize = vi.fn(), persist = vi.fn(() => { throw new Error('must not repeat CAS or mutation') })
    const replay = await t.operations.execute({ ...t.input, input: { patch: { a: 1, b: 2 }, expectedVersion: 1 } }, { authorize, persist })
    expect(replay).toEqual({ ...first, replayed: true })
    expect(replay.appliedResult.version).toBe(1)
    expect(t.value()).toBe(9)
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ mode: 'replay', operationId: first.operationId, actor: t.input.actor }))
    expect(persist).not.toHaveBeenCalled()
    expect(t.rows()).toHaveLength(1)
  })

  it('rechecks access even for a completed receipt and rejects changed targets or input with 409', async () => {
    const t = fixture(), first = await t.operations.execute(t.input, t.callbacks())
    const deny = vi.fn(() => { throw new Error('current resource access revoked') }), persist = vi.fn()
    await expect(t.operations.execute(t.input, { authorize: deny, persist })).rejects.toThrow('access revoked')
    expect(deny).toHaveBeenCalledWith(expect.objectContaining({ mode: 'replay', operationId: first.operationId }))
    for (const patch of [{ resourceId: '2' }, { spaceId: 'synthetic-other-space' }, { operation: 'routine.resume' as const }, { input: { expectedVersion: 2 } }]) {
      const authorize = vi.fn()
      await expect(t.operations.execute({ ...t.input, ...patch }, { authorize, persist })).rejects.toMatchObject({ status: 409, code: 'request_conflict' })
      expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ mode: 'replay', spaceId: t.input.spaceId, resourceId: '1' }))
    }
    expect(t.value()).toBe(1); expect(t.rows()).toHaveLength(1); expect(persist).not.toHaveBeenCalled()
  })

  it('binds receipts to real current login sessions, including logout and expiration on replay', async () => {
    const t = fixture(), callbacks = t.callbacks()
    for (const actor of [{ ...t.input.actor, openId: 'synthetic-bob' }, { ...t.input.actor, tenantKey: 'another-tenant' },
      { ...t.input.actor, appId: 'another-app' }, { ...t.input.actor, sessionId: 'not-a-real-session' }]) {
      await expect(t.operations.execute({ ...t.input, actor }, callbacks)).rejects.toMatchObject({ status: 401 })
    }
    expect(t.rows()).toHaveLength(0); expect(callbacks.authorize).not.toHaveBeenCalled()
    await t.operations.execute(t.input, callbacks)
    t.sessions.revoke(t.input.actor.sessionId)
    await expect(t.operations.execute(t.input, callbacks)).rejects.toMatchObject({ status: 401 })
    const other = t.sessions.create(identity)
    await t.operations.execute({ ...t.input, actor: other.actor }, callbacks)
    expect(t.rows()).toHaveLength(2)
    t.time(2000)
    await expect(t.operations.execute({ ...t.input, actor: other.actor }, callbacks)).rejects.toMatchObject({ status: 401 })
    expect(t.value()).toBe(2)
  })

  it('rolls back domain writes and the new identity when persistence throws, without cleanup', async () => {
    const t = fixture(), cleanup = vi.fn(), before = t.rows()
    await expect(t.operations.execute(t.input, { authorize: () => {}, persist: () => {
      t.db.exec('UPDATE domain_state SET value=7 WHERE id=1')
      throw new Error('synthetic domain failure')
    }, cleanupReplay: cleanup })).rejects.toThrow('synthetic domain failure')
    expect(t.value()).toBe(0); expect(t.rows()).toEqual(before); expect(cleanup).not.toHaveBeenCalled()
    await expect(t.operations.execute(t.input, t.callbacks(cleanup))).resolves.toMatchObject({ replayed: false })
    expect(t.value()).toBe(1); expect(cleanup).toHaveBeenCalledOnce()
  })

  it('rolls back a successful domain savepoint if the final operation receipt cannot be written', async () => {
    const t = fixture(), cleanup = vi.fn()
    t.db.exec("CREATE TRIGGER reject_result BEFORE UPDATE OF result_json ON console_operations BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END")
    await expect(t.operations.execute(t.input, t.callbacks(cleanup))).rejects.toThrow('synthetic receipt failure')
    expect(t.value()).toBe(0); expect(t.rows()).toHaveLength(0); expect(cleanup).not.toHaveBeenCalled()
    t.db.exec('DROP TRIGGER reject_result')
    await expect(t.operations.execute(t.input, t.callbacks(cleanup))).resolves.toMatchObject({ replayed: false })
    expect(t.value()).toBe(1); expect(cleanup).toHaveBeenCalledOnce()
  })

  it('rejects missing or prose-containing results atomically rather than retaining another body copy', async () => {
    const t = fixture(), cleanup = vi.fn()
    for (const result of [undefined, { changed: true, body: 'SYNTHETIC_PRIVATE_BODY' }, { changed: true, state: 'SYNTHETIC_PRIVATE_BODY' }]) {
      await expect(t.operations.execute(t.input, { authorize: () => {}, persist: () => {
        t.db.exec('UPDATE domain_state SET value=7 WHERE id=1')
        return { appliedResult: result, afterCommit: cleanup } as never
      } })).rejects.toMatchObject({ code: 'invalid_result' })
      expect(t.value()).toBe(0); expect(t.rows()).toHaveLength(0)
    }
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('does not commit a placeholder or repeat persistence when an incomplete historical receipt is encountered', async () => {
    const t = fixture()
    await t.operations.execute(t.input, t.callbacks())
    t.db.exec('UPDATE console_operations SET result_json=NULL')
    const callbacks = t.callbacks()
    await expect(t.operations.execute(t.input, callbacks)).rejects.toMatchObject({ code: 'invalid_receipt' })
    expect(callbacks.authorize).toHaveBeenCalledOnce(); expect(callbacks.persist).not.toHaveBeenCalled()
    expect(t.value()).toBe(1)
  })

  it('preserves committed facts on cleanup failure and permits only explicit cleanup of the original affected runs', async () => {
    const t = fixture(), cleanup = vi.fn(async () => { throw new Error('SYNTHETIC_PRIVATE_RUNTIME_ERROR') })
    const first = await t.operations.execute(t.input, t.callbacks(cleanup))
    expect(first.runtimeCleanup).toBe('pending'); expect(t.value()).toBe(1)
    expect(JSON.stringify(t.rows())).not.toContain('SYNTHETIC_PRIVATE_RUNTIME_ERROR')
    t.reopen()
    const persist = vi.fn(() => { throw new Error('must not run') }), authorize = vi.fn()
    const noRetry = await t.operations.execute(t.input, { authorize, persist })
    expect(noRetry).toEqual({ ...first, replayed: true })
    const cleanupReplay = vi.fn((context, result) => {
      expect(context.operationId).toBe(first.operationId)
      expect(result.affectedRunIds).toEqual(['synthetic-run-a'])
      expect(t.value()).toBe(1)
    })
    const retried = await t.operations.execute(t.input, { authorize, persist, cleanupReplay })
    expect(retried).toEqual({ ...first, replayed: true, runtimeCleanup: 'complete' })
    await t.operations.execute(t.input, { authorize, persist, cleanupReplay })
    expect(cleanupReplay).toHaveBeenCalledOnce(); expect(persist).not.toHaveBeenCalled()
    expect(t.value()).toBe(1)
  })

  it('does not signal cleanup before an outer caller transaction commits', async () => {
    const t = fixture(), cleanup = vi.fn()
    t.db.exec('SAVEPOINT caller; UPDATE domain_state SET value=8 WHERE id=1')
    await expect(t.operations.execute(t.input, t.callbacks(cleanup))).rejects.toMatchObject({ status: 409, code: 'nested_operation' })
    expect(t.value()).toBe(8); expect(t.rows()).toHaveLength(0); expect(cleanup).not.toHaveBeenCalled()
    t.db.exec('ROLLBACK TO caller; RELEASE caller')
    expect(t.value()).toBe(0)
  })

  it('rejects async authorization or persistence before invocation and rolls back accidental thenable results', async () => {
    const t = fixture(), work = vi.fn(), cleanup = vi.fn()
    await expect(t.operations.execute(t.input, { authorize: async () => { work() }, persist: t.callbacks().persist }))
      .rejects.toMatchObject({ code: 'async_operation' })
    await expect(t.operations.execute(t.input, { authorize: () => {}, persist: (async () => { work(); return { appliedResult: { changed: true } } }) as never }))
      .rejects.toMatchObject({ code: 'async_operation' })
    expect(work).not.toHaveBeenCalled()
    await expect(t.operations.execute(t.input, { authorize: () => {}, persist: (() => {
      t.db.exec('UPDATE domain_state SET value=8 WHERE id=1')
      return Promise.resolve({ appliedResult: { changed: true }, afterCommit: cleanup })
    }) as never })).rejects.toMatchObject({ code: 'async_operation' })
    expect(t.value()).toBe(0); expect(t.rows()).toHaveLength(0); expect(cleanup).not.toHaveBeenCalled()
  })

  it('serializes two stores on the same database while the first committed cleanup is still waiting', async () => {
    const t = fixture(), secondDb = new DatabaseSync(t.path); cleanups.push(() => secondDb.close())
    const second = new ConsoleOperations(secondDb, { sessions: new ConsoleSessionStore(secondDb, { now: () => 1000 }), now: () => 1000 })
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const first = t.operations.execute(t.input, t.callbacks(() => waiting))
    const persist = vi.fn(() => { throw new Error('duplicate write') })
    const replay = await second.execute(t.input, { authorize: () => {}, persist })
    expect(replay).toMatchObject({ replayed: true, runtimeCleanup: 'pending', appliedResult: { version: 1 } })
    expect(t.value()).toBe(1); expect(persist).not.toHaveBeenCalled()
    release()
    expect((await first).runtimeCleanup).toBe('complete')
    expect(t.rows()).toHaveLength(1)
  })
})
