import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunModels } from '../src/core/run-models.js'

const GUARD = resolve(process.env.FRIDAY_MIGRATION_GUARD ?? 'scripts/database-migration-guard.py')
const REPO = resolve('.'), SENTINEL = 'SYNTHETIC_MODEL_MIGRATION_保留原文\n不是选模事实。  '
const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const schema = (db: DatabaseSync) => db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
function rows(db: DatabaseSync) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(row => [String(row.name), db.prepare(`SELECT * FROM ${quote(String(row.name))}`).all()]))
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-run-model-migration-')); homes.push(home)
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
const { RunModels } = await import(pathToFileURL(join(repo, 'src/core/run-models.ts')).href)
const db = new DatabaseSync(candidate)
try { new RunModels(db) } finally { db.close() }
`)
  const db = new DatabaseSync(source)
  // Frozen pre-E2a Run schema. Do not construct current Registry/RunAttempts to invent a legacy fixture.
  db.exec(`CREATE TABLE tasks(id INTEGER PRIMARY KEY,prompt TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE run_attempts (
      id TEXT PRIMARY KEY,work_key TEXT NOT NULL,session_key TEXT NOT NULL,trigger_key TEXT NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('task','routine','reflect')),task_id INTEGER REFERENCES tasks(id),
      actor_open_id TEXT,acp_session_id TEXT,state TEXT NOT NULL CHECK(state IN ('running','stop_requested','completed','failed','cancelled','interrupted')),
      stop_reason TEXT,started_at INTEGER NOT NULL,finished_at INTEGER,UNIQUE(trigger_key,stage));
    CREATE UNIQUE INDEX idx_run_active_session ON run_attempts(session_key) WHERE state IN ('running','stop_requested');
    CREATE TABLE typed_values(id INTEGER PRIMARY KEY,data BLOB,weight REAL,optional TEXT);
    CREATE VIRTUAL TABLE synthetic_fts USING fts5(content,tokenize='trigram');`)
  db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(7, SENTINEL, 'done')
  db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(41, 'synthetic active task', 'running')
  const insertRun = db.prepare('INSERT INTO run_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
  insertRun.run('old-completed', 'task:7', 'session-a', 'task:7', 'task', 7, 'alice', 'acp-old', 'completed', null, 100, 200)
  insertRun.run('old-running', 'task:41', 'session-b', 'task:41', 'task', 41, 'bob', 'acp-current', 'running', null, 300, null)
  insertRun.run('old-routine', 'routine:9', 'routine-session', 'occurrence:9:1', 'routine', null, null, null, 'interrupted', 'gateway_restarted', 100, 200)
  db.prepare('INSERT INTO typed_values VALUES(?,?,?,?)').run(19, Buffer.from([0, 255, 128, 1]), 0.125, null)
  db.prepare('INSERT INTO synthetic_fts(content) VALUES(?)').run(SENTINEL)
  db.close()
  const guard = (...args: string[]) => {
    const result = spawnSync('python3', [GUARD, ...args], { encoding: 'utf8', timeout: 60_000 })
    expect(result.status, 'protected migration comparison must pass').toBe(0)
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
    expect(sha(baseline)).toBe(baselineHash)
    expect(statSync(baseline).mode & 0o777).toBe(0o400)
    const candidate = join(result.run_dir, 'candidate.db')
    expect(statSync(candidate).ino).not.toBe(statSync(baseline).ino)
    return { result, candidate }
  }
  return { source, upgrade }
}

describe('Run model facts migration', () => {
  it('preserves all original Run/Task schema, IDs and values twice without fabricating old model choices', () => {
    const t = fixture(), originalHash = sha(t.source), db = new DatabaseSync(t.source)
    const beforeSchema = schema(db), beforeRows = rows(db); db.close()
    const { result, candidate } = t.upgrade()
    expect(result.added_tables).toEqual(['run_models'])
    const migrated = new DatabaseSync(candidate)
    try {
      expect(migrated.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name!='run_models' ORDER BY type,name").all()).toEqual(beforeSchema)
      for (const [name, data] of Object.entries(beforeRows)) expect(migrated.prepare(`SELECT * FROM ${quote(name)}`).all()).toEqual(data)
      const models = new RunModels(migrated)
      for (const run of beforeRows.run_attempts!) expect(models.get(String(run.id))).toBeUndefined()
      expect(migrated.prepare('SELECT count(*) AS n FROM run_models').get()?.n).toBe(0)
      expect(migrated.prepare('PRAGMA foreign_key_list(run_models)').all()).toMatchObject([{ table: 'run_attempts', from: 'run_id', to: 'id' }])
    } finally { migrated.close() }
    expect(sha(t.source)).toBe(originalHash)
  })

  it('preserves nonempty model pins/admission/context on two upgrades and repeat construction after restart', () => {
    const t = fixture(), db = new DatabaseSync(t.source), models = new RunModels(db)
    const input = { runId: 'old-running', acpSessionId: 'acp-current', runtimeGeneration: 3, selector: '["p","m"]',
      providerId: 'p', modelId: 'm', accountRef: 'synthetic-deployment-account', preparedAt: 310 }
    models.prepare(input); models.admit(input.runId, input, 320)
    models.observeContext(input.runId, input, { used: 4096, size: 8192, observedAt: 330 })
    const saved = models.get(input.runId), beforeRows = rows(db), beforeSchema = schema(db); db.close()
    const originalHash = sha(t.source), { result, candidate } = t.upgrade()
    expect(result.added_tables).toEqual([])
    for (let pass = 0; pass < 2; pass++) {
      const reopened = new DatabaseSync(candidate)
      try {
        const current = new RunModels(reopened)
        expect(schema(reopened)).toEqual(beforeSchema)
        expect(rows(reopened)).toEqual(beforeRows)
        expect(current.prepare({ ...input, preparedAt: 999 })).toEqual(saved)
        expect(current.admit(input.runId, input, 1000)).toBe(true)
        expect(current.get(input.runId)).toEqual(saved)
        expect(current.get('old-completed')).toBeUndefined()
      } finally { reopened.close() }
    }
    expect(sha(t.source)).toBe(originalHash)
  })
})
