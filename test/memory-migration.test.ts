import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'

const GUARD = resolve('scripts/database-migration-guard.py')
const ADAPTER = resolve('scripts/upgrade-schema-copy.mjs')
const ORIGINAL = 'SYNTHETIC_MEMORY_ORIGINAL_不可打印_保留否定与空白 '
const OLD_COLUMNS = 'id,scope,session_key,kind,title,body,created_at,status,source,superseded_by,confirmation'
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

/** The populated business fixture mirrors database-migration-guard.test.ts.
 * Memory schema is frozen at pre-C1, rather than constructing the new store to
 * manufacture an "old" database. All text is synthetic. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-memory-migration-'))
  const source = join(home, 'active.db'), protectedDir = join(home, 'protected')
  const registry = new Registry(source), db = registry.db
  db.exec(`PRAGMA wal_autocheckpoint=0;
    CREATE TABLE memory_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, session_key TEXT,
      kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'candidate', source TEXT, superseded_by INTEGER, confirmation TEXT
    );
    CREATE INDEX idx_memory_scope ON memory_notes(scope, created_at);
    CREATE INDEX idx_memory_status ON memory_notes(scope, status, kind);
    CREATE VIRTUAL TABLE memory_fts USING fts5(title, body, content='memory_notes', content_rowid='id', tokenize='trigram');
    CREATE TRIGGER memory_ai AFTER INSERT ON memory_notes BEGIN
      INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;
    CREATE TRIGGER memory_ad AFTER DELETE ON memory_notes BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
    END;
    CREATE TABLE deliveries(delivery_key TEXT PRIMARY KEY,status TEXT,remote_id TEXT,error TEXT);
    CREATE TABLE github_changes(id TEXT PRIMARY KEY,repo TEXT,pr_number INTEGER,commit_id TEXT);
  `)
  // Feedback tables at their pre-P3-1 shape: the real constructors, minus the two columns P3-1 adds.
  new BugQuestions(db, new Bugs(db))
  db.exec('ALTER TABLE bug_questions DROP COLUMN info_kind; ALTER TABLE bug_buckets DROP COLUMN declined_info')
  const insert = db.prepare(`INSERT INTO memory_notes (${OLD_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  const confirmation = '{ "by": "alice", "messageId": "human-confirmation", "at": 123 }'
  insert.run(41, 'space:sp_dm_alice', 'session-a', 'rule', '已确认规则', ORIGINAL, 10, 'confirmed', '{ "by": "alice", "chatId": "chat-a" }', null, confirmation)
  insert.run(42, 'space:sp_dm_alice', 'session-a', 'fact', '已被替代旧值', ORIGINAL, 20, 'superseded', null, 43, confirmation)
  insert.run(43, 'space:sp_dm_alice', 'session-a', 'fact', '仍待确认更正', ORIGINAL, 30, 'candidate', '{ "replaces": 42 }', null, null)
  insert.run(44, 'org', 'session-a', 'rule', '既有分享副本', ORIGINAL, 40, 'confirmed', '{"promotedFrom":"space:sp_dm_alice","noteId":41,"by":"admin"}', null, confirmation)
  insert.run(45, 'space:sp_dm_alice', null, 'qa', '旧候选问答', ORIGINAL, 50, 'candidate', null, null, null)
  // The old confirmation backup must not be replaced or rewritten by C1.
  db.exec('CREATE TABLE memory_notes_before_confirmation_v1 AS SELECT * FROM memory_notes')
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', requesterOpenId: 'alice', cwd: '/synthetic/a' })
  const original = registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'real-original', requesterOpenId: 'alice', prompt: ORIGINAL }).task
  const amendment = registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'real-amendment', requesterOpenId: 'alice', prompt: '明确更正但尚未执行', amendsTaskId: original.id, replaceQueued: true }).task
  registry.startTask(amendment.id, 100)
  registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'queued-next', requesterOpenId: 'alice', prompt: '尚未开始，不能迁移时派发' })
  db.prepare('INSERT INTO bug_buckets (id,title,status,issue_url,first_seen_at,last_seen_at) VALUES(1,?,?,?,1,1)').run(ORIGINAL, 'open', 'https://github.com/test-org/test-repo/issues/7')
  db.prepare("INSERT INTO bug_reports (id,bucket_id,chat_id,text,record_kind,created_at) VALUES(11,1,'chat-a',?,?,1)").run(ORIGINAL, 'user_note')
  db.prepare("INSERT INTO bug_reports (id,bucket_id,chat_id,text,record_kind,created_at) VALUES(12,1,'chat-a',?,?,1)").run(ORIGINAL, 'report')
  // Real routine tables: a paused watch with its read position and one cancelled window.
  const routines = new RoutineStore(db), routineNow = 1_770_000_000_000
  const watch = routines.add({ kind: 'watch', ownerOpenId: 'alice', runAs: 'alice', spaceId: 'sp_group', chatId: 'chat-a', chatType: 'group',
    name: 'Synthetic watch', prompt: ORIGINAL, schedule: { type: 'interval', everyMinutes: 10 }, now: routineNow })
  if (!routines.advanceMessageCursor(watch.id, 1, routineNow / 1000, routineNow / 1000 + 60)) throw new Error('fixture cursor not advanced')
  if (!routines.claimDueOccurrence(watch.id, watch.nextRunAt, watch.nextRunAt)) throw new Error('fixture window not claimed')
  routines.setEnabled(watch.id, false, routineNow + 1)
  db.exec(`INSERT INTO github_changes VALUES('change-a','test-org/test-repo',7,'sha-before');`)
  db.prepare('INSERT INTO deliveries VALUES(?,?,?,?)').run('delivery-a', 'unknown', null, ORIGINAL)
  const oldNotes = db.prepare(`SELECT ${OLD_COLUMNS} FROM memory_notes ORDER BY id`).all()
  const oldTasks = db.prepare('SELECT * FROM tasks ORDER BY id').all()
  const oldFts = db.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'SYNTHETIC_MEMORY_ORIGINAL' ORDER BY rowid").all()
  const call = (...args: string[]) => {
    const run = spawnSync('python3', [GUARD, ...args], { encoding: 'utf8', timeout: 30_000 })
    return { code: run.status, stdout: run.stdout, stderr: run.stderr, result: JSON.parse(run.stdout.trim()) }
  }
  cleanup.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  return { db, source, protectedDir, original, amendment, oldNotes, oldTasks, oldFts, call }
}

describe('C1 protected non-empty memory migration', () => {
  it('runs the real schema adapter twice, retaining original memory and unrelated business facts without recovery', () => {
    const t = fixture()
    expect(t.call('backup', '--source', t.source, '--out-dir', t.protectedDir).code).toBe(0)
    const verified = t.call('verify', '--protection-dir', t.protectedDir, '--', process.execPath, ADAPTER)
    expect(verified.code, verified.stdout + verified.stderr).toBe(0)
    expect(verified.result).toMatchObject({ passed: true, protected_backup_unchanged: true,
      old_business_rows: { equal: true }, second_upgrade_idempotent: { equal: true } })
    expect(verified.result.passes.map((p: { exit_code: number }) => p.exit_code)).toEqual([0, 0])
    const candidate = new DatabaseSync(join(verified.result.run_dir, 'candidate.db'), { readOnly: true })
    try {
      expect(candidate.prepare(`SELECT ${OLD_COLUMNS} FROM memory_notes ORDER BY id`).all()).toEqual(t.oldNotes)
      expect(candidate.prepare(`SELECT ${OLD_COLUMNS} FROM memory_notes_before_confirmation_v1 ORDER BY id`).all()).toEqual(t.oldNotes)
      expect(candidate.prepare('SELECT revision FROM memory_notes ORDER BY id').all()).toEqual(Array.from({ length: 5 }, () => ({ revision: 1 })))
      expect(candidate.prepare('SELECT * FROM memory_provenance ORDER BY note_id').all()).toEqual([41, 42, 43, 44, 45].map(id => ({
        note_id: id, state: 'legacy_unverified', origin_run_id: null, sources_json: '[]', ancestor_notes_json: '[]',
      })))
      expect(candidate.prepare('SELECT count(*) AS n FROM memory_changes').get()?.n).toBe(0)
      expect(candidate.prepare('SELECT count(*) AS n FROM memory_tombstones').get()?.n).toBe(0)
      expect(candidate.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(t.oldTasks)
      expect(candidate.prepare('SELECT prior_task_id FROM task_amendments WHERE task_id=?').get(t.amendment.id)?.prior_task_id).toBe(t.original.id)
      expect(candidate.prepare('SELECT text,record_kind FROM bug_reports WHERE id=11').get()).toEqual({ text: ORIGINAL, record_kind: 'user_note' })
      expect(candidate.prepare('SELECT issue_url FROM bug_buckets WHERE id=1').get()?.issue_url).toBe('https://github.com/test-org/test-repo/issues/7')
      expect(candidate.prepare('SELECT pr_number,commit_id FROM github_changes').get()).toEqual({ pr_number: 7, commit_id: 'sha-before' })
      expect(candidate.prepare('SELECT message_cursor_sec,enabled,disabled_reason,prompt FROM routines').get()).toEqual({ message_cursor_sec: 1_770_000_060, enabled: 0, disabled_reason: '手动停用', prompt: ORIGINAL.trim() })
      expect(candidate.prepare('SELECT status FROM routine_occurrences').get()?.status).toBe('cancelled')
      expect(candidate.prepare('SELECT status,remote_id FROM deliveries').get()).toEqual({ status: 'unknown', remote_id: null })
      expect(candidate.prepare('SELECT count(*) AS n FROM run_attempts').get()?.n).toBe(0)
      expect(candidate.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'SYNTHETIC_MEMORY_ORIGINAL' ORDER BY rowid").all()).toEqual(t.oldFts)
    } finally { candidate.close() }
    // The active DB stayed open throughout backup/verification and was never migrated.
    expect(t.db.prepare('PRAGMA table_info(memory_notes)').all().map(c => c.name)).not.toContain('revision')
    expect(t.db.prepare(`SELECT ${OLD_COLUMNS} FROM memory_notes ORDER BY id`).all()).toEqual(t.oldNotes)
    expect(t.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(t.oldTasks)
    expect(verified.stdout + verified.stderr + readFileSync(join(verified.result.run_dir, 'verification.json'), 'utf8')).not.toContain(ORIGINAL)
  })
})
