import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsoleSessionStore } from '../src/core/console-sessions.js'
import { ConsoleOperations, type ConsoleOperationInput } from '../src/core/console-operations.js'

const GUARD = resolve(process.env.FRIDAY_MIGRATION_GUARD ?? 'scripts/database-migration-guard.py')
const REPO = resolve('.')
const homes: string[] = []
const SENTINEL = 'SYNTHETIC_OPERATION_MIGRATION_保留原文\n停止并非删除。  '
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

function schema(db: DatabaseSync) { return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all() }
function rows(db: DatabaseSync) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => String(row.name))
  return Object.fromEntries(names.map(name => [name, db.prepare(`SELECT * FROM ${quote(name)}`).all()]))
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-console-operation-migration-')); homes.push(home)
  const source = join(home, 'legacy.db'), adapter = join(home, 'upgrade-copy.mjs'), protectedDir = join(home, 'protected')
  writeFileSync(adapter, `import { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const supplied = process.argv[2]
if (!supplied || lstatSync(supplied).isSymbolicLink()) throw new Error('Expected guarded candidate')
const candidate = realpathSync(supplied), runDir = dirname(candidate)
if (basename(candidate) !== 'candidate.db' || !basename(runDir).startsWith('verification-') || !existsSync(join(dirname(runDir), 'backup-receipt.json'))) throw new Error('Expected guarded candidate')
const repo = ${JSON.stringify(REPO)}, req = createRequire(join(repo, 'package.json'))
const { register } = await import(pathToFileURL(req.resolve('tsx/esm/api')).href)
register()
const { ConsoleSessionStore } = await import(pathToFileURL(join(repo, 'src/core/console-sessions.ts')).href)
const { ConsoleOperations } = await import(pathToFileURL(join(repo, 'src/core/console-operations.ts')).href)
const db = new DatabaseSync(candidate)
try { const sessions = new ConsoleSessionStore(db); new ConsoleOperations(db, { sessions }) } finally { db.close() }
`)
  const guard = (...args: string[]) => {
    const result = spawnSync('python3', [GUARD, ...args], { encoding: 'utf8', timeout: 60_000 })
    expect(result.status, 'migration guard must pass without exposing database values').toBe(0)
    expect(result.stdout + result.stderr).not.toContain(SENTINEL)
    return JSON.parse(result.stdout.trim())
  }
  const upgrade = () => {
    guard('backup', '--source', source, '--out-dir', protectedDir)
    const baseline = join(protectedDir, 'baseline.db'), baselineHash = sha(baseline)
    const result = guard('verify', '--protection-dir', protectedDir, '--', process.execPath, adapter)
    expect(result).toMatchObject({ passed: true, protected_backup_unchanged: true,
      old_business_rows: { equal: true }, second_upgrade_idempotent: { equal: true } })
    expect(result.passes.map((pass: { exit_code: number }) => pass.exit_code)).toEqual([0, 0])
    const candidate = join(result.run_dir, 'candidate.db')
    expect(statSync(candidate).ino).not.toBe(statSync(baseline).ino)
    expect(sha(baseline)).toBe(baselineHash)
    expect(statSync(baseline).mode & 0o777).toBe(0o400)
    return { candidate, result }
  }
  return { source, upgrade }
}

describe('E1b console operation schema migration', () => {
  it('preserves frozen nonempty E1a sessions and all old fields, IDs and values across two constructor passes', () => {
    const t = fixture(), db = new DatabaseSync(t.source)
    // Frozen E1a definitions, including nonempty browser sessions; no current store invents the old schema.
    db.exec(`CREATE TABLE console_sessions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_token TEXT NOT NULL,
      app_id TEXT NOT NULL, tenant_key TEXT NOT NULL, open_id TEXT NOT NULL,
      name TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,session_key TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,stop_reason TEXT);
    CREATE INDEX idx_tasks_session ON tasks(session_key,id);
    CREATE TABLE typed_values(id INTEGER PRIMARY KEY,data BLOB,weight REAL,optional TEXT);
    CREATE VIRTUAL TABLE synthetic_fts USING fts5(content,tokenize='trigram');`)
    db.prepare('INSERT INTO console_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-session-live', 'hash-a', 'csrf-a', 'app-a', 'tenant-a', 'alice', '合成名', 1, 10000, 2, null)
    db.prepare('INSERT INTO console_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-session-revoked', 'hash-b', 'csrf-b', 'app-b', 'tenant-b', 'bob', null, 3, 10000, 4, 5)
    db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(7, 'synthetic-work', SENTINEL, 'cancelled', 'user_requested')
    db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(41, 'synthetic-work', SENTINEL + '第二条', 'done', null)
    db.prepare('INSERT INTO typed_values VALUES(?,?,?,?)').run(9, Buffer.from([0, 255, 1, 128]), 1.25, null)
    db.prepare('INSERT INTO synthetic_fts(content) VALUES(?)').run(SENTINEL)
    const beforeSchema = schema(db), beforeRows = rows(db); db.close()
    const originalHash = sha(t.source), upgraded = t.upgrade()
    expect(upgraded.result.added_tables).toEqual(['console_operations'])
    const candidate = new DatabaseSync(upgraded.candidate, { readOnly: true })
    try {
      expect(candidate.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name!='console_operations' ORDER BY type,name").all()).toEqual(beforeSchema)
      for (const [name, oldRows] of Object.entries(beforeRows)) expect(candidate.prepare(`SELECT * FROM ${quote(name)}`).all()).toEqual(oldRows)
      expect(candidate.prepare('SELECT count(*) AS n FROM console_sessions').get()?.n).toBe(2)
      expect(candidate.prepare('SELECT count(*) AS n FROM console_operations').get()?.n).toBe(0)
    } finally { candidate.close() }
    expect(sha(t.source)).toBe(originalHash)
  })

  it('preserves a nonempty operation receipt on two upgrades and replays after reopening without applying the mutation again', async () => {
    const t = fixture(), db = new DatabaseSync(t.source)
    const sessionOptions = { now: () => 1000, ttlMs: 10000, idleTimeoutMs: 10000 }
    const sessions = new ConsoleSessionStore(db, sessionOptions)
    const credentials = sessions.create({ appId: 'synthetic-app', tenantKey: 'synthetic-tenant', openId: 'alice', name: null })
    const operations = new ConsoleOperations(db, { sessions, now: () => 1000 })
    db.exec('CREATE TABLE synthetic_domain(id INTEGER PRIMARY KEY,value INTEGER NOT NULL); INSERT INTO synthetic_domain VALUES(71,0)')
    const input: ConsoleOperationInput = { actor: credentials.actor, requestId: 'synthetic-request-0001', spaceId: 'synthetic-space',
      operation: 'todo.update', resourceId: '71', input: { expectedTag: 'a'.repeat(64), title: SENTINEL } }
    const first = await operations.execute(input, { authorize: () => {}, persist: () => {
      db.exec('UPDATE synthetic_domain SET value=1 WHERE id=71')
      return { appliedResult: { changed: true, state: 'updated', tag: 'b'.repeat(64) } }
    } })
    // A later business update must not be undone by replay of this historical receipt.
    db.exec('UPDATE synthetic_domain SET value=9 WHERE id=71')
    const beforeRows = rows(db), beforeSchema = schema(db)
    expect(JSON.stringify(beforeRows.console_operations)).not.toContain(SENTINEL)
    expect(JSON.stringify(beforeRows.console_operations)).not.toContain(credentials.token)
    db.close()
    const originalHash = sha(t.source), upgraded = t.upgrade()
    expect(upgraded.result.added_tables).toEqual([])
    for (let restart = 0; restart < 2; restart += 1) {
      const reopened = new DatabaseSync(upgraded.candidate)
      try {
        const currentSessions = new ConsoleSessionStore(reopened, sessionOptions)
        const currentOperations = new ConsoleOperations(reopened, { sessions: currentSessions, now: () => 1000 })
        expect(schema(reopened)).toEqual(beforeSchema)
        expect(rows(reopened)).toEqual(beforeRows)
        const authorize = vi.fn(), persist = vi.fn(() => { throw new Error('must not repeat a completed operation') })
        expect(await currentOperations.execute(input, { authorize, persist })).toEqual({ ...first, replayed: true })
        expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ mode: 'replay', operationId: first.operationId }))
        expect(persist).not.toHaveBeenCalled()
        expect(reopened.prepare('SELECT value FROM synthetic_domain WHERE id=71').get()?.value).toBe(9)
        expect(rows(reopened)).toEqual(beforeRows)
      } finally { reopened.close() }
    }
    expect(sha(t.source)).toBe(originalHash)
  })
})
