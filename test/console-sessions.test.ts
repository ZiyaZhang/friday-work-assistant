import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ConsoleSessionStore } from '../src/core/console-sessions.js'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()) })
const identity = { appId: 'cli_synthetic', tenantKey: 'tenant-a', openId: 'ou_alice', name: 'Alice' }

describe('persisted console sessions', () => {
  it('survives reopen without storing the raw cookie, and revocation persists too', () => {
    const home = mkdtempSync(join(tmpdir(), 'friday-console-session-')); cleanup.push(() => rmSync(home, { recursive: true, force: true }))
    const path = join(home, 'sessions.db')
    let db = new DatabaseSync(path)
    const first = new ConsoleSessionStore(db).create(identity)
    expect(JSON.stringify(db.prepare('SELECT * FROM console_sessions').all())).not.toContain(first.token)
    db.close(); db = new DatabaseSync(path)
    const reopened = new ConsoleSessionStore(db)
    expect(reopened.authenticate(first.token)).toEqual(first.actor)
    expect(reopened.revoke(first.actor.sessionId)).toBe(true)
    expect(reopened.revoke(first.actor.sessionId)).toBe(false)
    db.close(); db = new DatabaseSync(path)
    try { expect(new ConsoleSessionStore(db).authenticate(first.token)).toBeUndefined() } finally { db.close() }
  })

  it('enforces idle and absolute expiration even when the session is repeatedly touched', () => {
    const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close())
    let now = 0
    const store = new ConsoleSessionStore(db, { now: () => now, ttlMs: 100, idleTimeoutMs: 30 })
    const a = store.create(identity)
    now = 29; expect(store.authenticate(a.token)).toBeDefined()
    now = 58; expect(store.authenticate(a.token)).toBeDefined()
    now = 87; expect(store.authenticate(a.token)).toBeDefined()
    now = 100; expect(store.authenticate(a.token)).toBeUndefined()
    const idle = store.create(identity)
    now = 130; expect(store.authenticate(idle.token)).toBeUndefined()
    expect(store.isCurrent(idle.actor)).toBe(false)
    expect(store.acceptsCsrf(idle.actor, 'invalid')).toBe(false)
  })

  it('rolls back old-session revocation when the new row cannot be committed', () => {
    const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close())
    const store = new ConsoleSessionStore(db), first = store.create(identity)
    db.exec("CREATE TRIGGER reject_console_session BEFORE INSERT ON console_sessions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    expect(() => store.create(identity, first.actor)).toThrow(/synthetic/)
    expect(store.authenticate(first.token)).toEqual(first.actor)
    expect(db.prepare('SELECT count(*) AS n FROM console_sessions').get()?.n).toBe(1)
  })

  it('does not rotate a revoked session or substitute another app, tenant or person', () => {
    const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close())
    const store = new ConsoleSessionStore(db), first = store.create(identity)
    for (const patch of [{ appId: 'cli_other' }, { tenantKey: 'tenant-other' }, { openId: 'ou_bob' }]) {
      expect(() => store.create({ ...identity, ...patch }, first.actor)).toThrow(/changed/)
      expect(store.isCurrent({ ...first.actor, ...patch })).toBe(false)
    }
    store.revoke(first.actor.sessionId)
    expect(() => store.create(identity, first.actor)).toThrow(/changed/)
    expect(db.prepare('SELECT count(*) AS n FROM console_sessions').get()?.n).toBe(1)
  })
})
