import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const GUARD = resolve(process.env.FRIDAY_MIGRATION_GUARD ?? 'scripts/database-migration-guard.py')
const REPO = resolve('.')
const SENTINEL = 'SYNTHETIC_CONSOLE_MIGRATION_保持原文\n不恢复职责，不改授权。  '
const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('E1a console session schema migration', () => {
  it('adds only an empty browser-session table while preserving all nonempty old tables, fields and IDs across two upgrades', () => {
    const home = mkdtempSync(join(tmpdir(), 'friday-console-migration-'))
    homes.push(home)
    const source = join(home, 'legacy.db'), protectedDir = join(home, 'protected'), adapter = join(home, 'upgrade-console-copy.mjs')
    const db = new DatabaseSync(source)
    // A frozen, nonempty old schema: do not construct today's stores to invent a legacy fixture.
    db.exec(`CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, message_id TEXT NOT NULL,
      requester_open_id TEXT, prompt TEXT NOT NULL, status TEXT NOT NULL, stop_reason TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_tasks_session ON tasks(session_key,id);
    CREATE TABLE settings (key TEXT PRIMARY KEY,value BLOB NOT NULL,weight REAL,optional TEXT);
    CREATE TABLE user_tokens (open_id TEXT PRIMARY KEY,access_token TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE VIRTUAL TABLE synthetic_fts USING fts5(content,tokenize='trigram');`)
    const put = db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)')
    put.run(7, 'synthetic-session', 'synthetic-message-1', 'synthetic-actor', SENTINEL, 'cancelled', 'user_requested', 123)
    put.run(41, 'synthetic-session', 'synthetic-message-2', null, `${SENTINEL}第二条`, 'done', null, 456)
    db.prepare('INSERT INTO settings VALUES (?,?,?,?)').run('synthetic-key', Buffer.from([0, 255, 1, 128]), 1.25, null)
    db.prepare('INSERT INTO user_tokens VALUES (?,?,?)').run('synthetic-actor', 'synthetic-existing-uat-not-a-browser-session', 900)
    db.prepare('INSERT INTO synthetic_fts(content) VALUES (?)').run(SENTINEL)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => String(row.name))
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
    const rows = Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()]))
    db.close()
    const sourceHash = sha(source)
    // Only the constructor under test runs. No Registry startup, token refresh or business recovery.
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
const db = new DatabaseSync(candidate)
try { new ConsoleSessionStore(db) } finally { db.close() }
`)
    const guard = (...args: string[]) => {
      const result = spawnSync('python3', [GUARD, ...args], { encoding: 'utf8', timeout: 60_000 })
      expect(result.status, 'migration guard must complete successfully').toBe(0)
      expect(result.stdout + result.stderr).not.toContain(SENTINEL)
      return JSON.parse(result.stdout.trim())
    }
    guard('backup', '--source', source, '--out-dir', protectedDir)
    const baseline = join(protectedDir, 'baseline.db'), baselineHash = sha(baseline)
    const verified = guard('verify', '--protection-dir', protectedDir, '--', process.execPath, adapter)
    expect(verified).toMatchObject({ passed: true, protected_backup_unchanged: true, added_tables: ['console_sessions'],
      old_business_rows: { equal: true }, second_upgrade_idempotent: { equal: true } })
    expect(verified.passes.map((pass: { exit_code: number }) => pass.exit_code)).toEqual([0, 0])
    const candidatePath = join(verified.run_dir, 'candidate.db'), candidate = new DatabaseSync(candidatePath, { readOnly: true })
    try {
      expect(candidate.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name != 'console_sessions' ORDER BY type,name").all()).toEqual(schema)
      for (const name of tables) expect(candidate.prepare(`SELECT * FROM "${name}"`).all()).toEqual(rows[name])
      expect(candidate.prepare('SELECT count(*) AS n FROM console_sessions').get()?.n).toBe(0)
    } finally { candidate.close() }
    expect(sha(source)).toBe(sourceHash)
    expect(sha(baseline)).toBe(baselineHash)
    expect(statSync(baseline).mode & 0o777).toBe(0o400)
    expect(statSync(candidatePath).ino).not.toBe(statSync(baseline).ino)
  })
})
