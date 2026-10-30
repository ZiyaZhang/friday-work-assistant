import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RoutineStore, occurrenceWindowKey } from '../src/core/routines.js'
import { IssueLinks } from '../src/github/issues.js'
import { Todos } from '../src/core/todos.js'
import { MessageCache } from '../src/core/message-cache.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'

const SCRIPT = resolve('scripts/database-migration-guard.py')
const PRIVATE_TEXT = 'SYNTHETIC_PRIVATE_ORIGINAL_文字还在_拒绝日志'
const SECRET = 'SYNTHETIC_ACCESS_TOKEN_DO_NOT_PRINT'
const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-db-guard-')), source = join(home, 'active.db'), protectedDir = join(home, 'protected')
  const db = new DatabaseSync(source)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE bug_buckets(id INTEGER PRIMARY KEY, title TEXT, status TEXT, issue_url TEXT);
    CREATE TABLE bug_reports(id INTEGER PRIMARY KEY,bucket_id INTEGER,text TEXT,record_kind TEXT);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY,prompt TEXT,status TEXT);
    CREATE TABLE task_amendments(task_id INTEGER PRIMARY KEY,prior_task_id INTEGER);
    CREATE TABLE routines(id INTEGER PRIMARY KEY,message_cursor_sec INTEGER,enabled INTEGER,disabled_reason TEXT);
    CREATE TABLE routine_occurrences(id INTEGER PRIMARY KEY,routine_id INTEGER,status TEXT);
    CREATE TABLE deliveries(delivery_key TEXT PRIMARY KEY,status TEXT,remote_id TEXT,error TEXT);
    CREATE TABLE github_changes(id TEXT PRIMARY KEY,repo TEXT,pr_number INTEGER,commit_id TEXT);
    CREATE TABLE private_tokens(id INTEGER PRIMARY KEY,access_token TEXT);`)
  db.prepare('INSERT INTO bug_buckets VALUES(1,?,?,?)').run(PRIVATE_TEXT, 'open', 'https://github.com/test-org/test-repo/issues/7')
  db.prepare('INSERT INTO bug_reports VALUES(11,1,?,?)').run(PRIVATE_TEXT, 'user_note')
  db.prepare('INSERT INTO tasks VALUES(3,?,?)').run(PRIVATE_TEXT, 'done')
  db.prepare('INSERT INTO tasks VALUES(4,?,?)').run('Synthetic correction', 'queued')
  db.exec("INSERT INTO task_amendments VALUES(4,3); INSERT INTO routines VALUES(9,1770000000,0,'manual_pause'); INSERT INTO routine_occurrences VALUES(8,9,'cancelled'); INSERT INTO github_changes VALUES('change-a','test-org/test-repo',7,'sha-before');")
  db.prepare('INSERT INTO deliveries VALUES(?,?,?,?)').run('delivery-a', 'unknown', null, PRIVATE_TEXT)
  db.prepare('INSERT INTO private_tokens VALUES(1,?)').run(SECRET)
  cleanup.push(() => { db.close(); rmSync(home, { recursive: true, force: true }) })
  const call = (...args: string[]) => {
    const process = spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8', timeout: 15000 })
    return { code: process.status, stdout: process.stdout, stderr: process.stderr, result: JSON.parse(process.stdout.trim()) }
  }
  const backup = () => call('backup', '--source', source, '--out-dir', protectedDir)
  const verify = (body: string, timeout?: number) => {
    const adapter = join(home, 'synthetic-upgrade.py')
    writeFileSync(adapter, `import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\n${body}\nc.commit()\nc.close()\n`)
    return call('verify', '--protection-dir', protectedDir, ...(timeout ? ['--timeout-seconds', String(timeout)] : []), '--', 'python3', adapter)
  }
  return { home, db, source, protectedDir, call, backup, verify }
}

describe('protected SQLite migration validator', () => {
  it('matches Python and Node read tokens exactly and preserves the full snapshot when old SQLite cannot read trigram', () => {
    const t = fixture()
    t.db.exec(`PRAGMA journal_mode=DELETE;
      CREATE TABLE compat_values(id INTEGER PRIMARY KEY,wide INTEGER,negative INTEGER,fraction REAL,zero REAL,infinite REAL,text TEXT,bytes BLOB,empty BLOB,null_value TEXT);
      CREATE VIRTUAL TABLE compat_fts USING fts5(body,tokenize='trigram');`)
    t.db.prepare('INSERT INTO compat_values VALUES(?,?,?,?,?,?,?,?,?,?)').run(1, 9223372036854775807n, -9223372036854775808n, 1.125, -0, Infinity, PRIVATE_TEXT, Buffer.from([0, 255, 128]), Buffer.alloc(0), null)
    t.db.prepare('INSERT INTO compat_fts(body) VALUES(?)').run(PRIVATE_TEXT)
    const script = join(t.home, 'check-reader.py')
    writeFileSync(script, `import importlib.util,json,sqlite3,sys
s=importlib.util.spec_from_file_location('guard',sys.argv[1]); g=importlib.util.module_from_spec(s); s.loader.exec_module(g)
path=sys.argv[2]
with g.closing(g.readonly(path)) as c:
    native=g.read_table(c,path,'compat_values')
    bridged=g.read_table_via_node(path,'compat_values')
original=g.snapshot(path,b'x'*32)
real_readonly=g.readonly
class OldTokenizer:
    def __init__(self,c): self.c=c
    def execute(self,sql,*args):
        if sql=='PRAGMA table_info("compat_fts")': raise sqlite3.OperationalError('no such tokenizer: trigram')
        return self.c.execute(sql,*args)
    def close(self): self.c.close()
g.readonly=lambda *args,**kwargs: OldTokenizer(real_readonly(*args,**kwargs))
old_engine=g.snapshot(path,b'x'*32)
print(json.dumps({'typed_values_equal':native==bridged,'full_snapshot_equal':original==old_engine,'trigram_rows':old_engine['tables']['compat_fts']['row_count']}))
`)
    const run = spawnSync('python3', [script, SCRIPT, t.source], { encoding: 'utf8', env: { ...process.env, FRIDAY_MIGRATION_NODE: process.execPath } })
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({ typed_values_equal: true, full_snapshot_equal: true, trigram_rows: 1 })
    expect(run.stdout + run.stderr).not.toContain(PRIVATE_TEXT)
    expect(run.stdout + run.stderr).not.toContain(SECRET)
  })

  it('does not mask unrelated SQLite failures or mix another connection into a live WAL snapshot', () => {
    const t = fixture(), script = join(t.home, 'check-reader-errors.py')
    writeFileSync(script, `import importlib.util,json,sqlite3,sys
s=importlib.util.spec_from_file_location('guard',sys.argv[1]); g=importlib.util.module_from_spec(s); s.loader.exec_module(g)
called=[]
g.read_table_via_node=lambda *args: called.append(True)
class FailedRead:
    def __init__(self,error): self.error=error
    def execute(self,sql):
        if sql=='PRAGMA journal_mode': return self
        raise sqlite3.OperationalError(self.error)
    def fetchone(self): return ('wal',)
results=[]
for error in ['database disk image is malformed','no such tokenizer: trigram']:
    try: g.read_table(FailedRead(error),sys.argv[2],'tasks')
    except (sqlite3.Error,g.GuardError) as e: results.append(str(e))
print(json.dumps({'errors':results,'bridge_calls':len(called)}))
`)
    const run = spawnSync('python3', [script, SCRIPT, t.source], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({ errors: ['database disk image is malformed', 'sqlite_compatibility_requires_completed_copy'], bridge_calls: 0 })
  })

  it('backs up committed WAL data while the writer stays open, with restricted permissions and no plaintext output', () => {
    const t = fixture()
    expect(statSync(t.source + '-wal').size).toBeGreaterThan(0)
    // Raw main-file copying is insufficient in this fixture: even schema is still in the live WAL.
    const unsafeCopy = join(t.home, 'raw-main-file-only.db'); copyFileSync(t.source, unsafeCopy)
    const unsafe = new DatabaseSync(unsafeCopy, { readOnly: true })
    expect(unsafe.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='bug_reports'").get()?.n).toBe(0)
    unsafe.close()
    const r = t.backup()
    expect(r.code).toBe(0)
    expect(r.result).toMatchObject({ action: 'online_backup', source_open_mode: 'ro', quick_check: 'ok', upgrade_executed: false,
      semantic_counts: { user_notes: 1, paused_routines: 1, unknown_deliveries: 1, planned_deliveries: 0 } })
    const copy = new DatabaseSync(join(t.protectedDir, 'baseline.db'), { readOnly: true })
    expect(copy.prepare('SELECT text FROM bug_reports WHERE id=11').get()?.text).toBe(PRIVATE_TEXT)
    copy.close()
    for (const [name, permission] of [['', 0o700], ['baseline.db', 0o400], ['summary.key', 0o600], ['baseline-summary.json', 0o600]] as const) expect(statSync(join(t.protectedDir, name)).mode & 0o777).toBe(permission)
    const allOutput = r.stdout + r.stderr + readFileSync(join(t.protectedDir, 'baseline-summary.json'), 'utf8')
    expect(allOutput).not.toContain(PRIVATE_TEXT)
    expect(allOutput).not.toContain(SECRET)
    expect(t.db.prepare('SELECT message_cursor_sec FROM routines WHERE id=9').get()?.message_cursor_sec).toBe(1770000000)
    expect(t.backup().code).toBe(1) // Never overwrite a protected baseline.
  })

  it('permits new fields and new backfilled tables while preserving old IDs/values and proving two-pass idempotence', () => {
    const t = fixture(); expect(t.backup().code).toBe(0)
    const r = t.verify(`if 'entity_ref' not in [r[1] for r in c.execute('pragma table_info(bug_buckets)')]: c.execute('alter table bug_buckets add column entity_ref text')
c.execute('create table if not exists synthetic_entities(id integer primary key, bucket_id integer unique)')
c.execute('insert or ignore into synthetic_entities select id,id from bug_buckets')`)
    expect(r.code).toBe(0)
    expect(r.result).toMatchObject({ passed: true, protected_backup_unchanged: true, old_business_rows: { equal: true }, second_upgrade_idempotent: { equal: true }, added_tables: ['synthetic_entities'] })
    expect(r.result.passes.map((p: { exit_code: number }) => p.exit_code)).toEqual([0, 0])
    expect(t.db.prepare('PRAGMA table_info(bug_buckets)').all().map(c => c.name)).not.toContain('entity_ref')
    expect(t.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='synthetic_entities'").get()?.n).toBe(0)
  })

  it('runs actual constructors twice without changing populated work, Todo origins, reports, pauses, occurrences or unknown deliveries', () => {
    const t = fixture()
    t.db.exec('DROP TABLE task_amendments; DROP TABLE tasks; DROP TABLE routines; DROP TABLE routine_occurrences')
    // Feedback tables come from the real constructors below, not the synthetic fixture shape.
    t.db.exec('DROP TABLE bug_buckets; DROP TABLE bug_reports')
    const registry = new Registry(t.source)
    const original = registry.createTaskOnce({ sessionKey: 'synthetic-session', messageId: 'synthetic-original', requesterOpenId: 'synthetic-user', prompt: PRIVATE_TEXT }).task
    const amendment = registry.createTaskOnce({ sessionKey: original.sessionKey, messageId: 'synthetic-amendment', requesterOpenId: 'synthetic-user', prompt: 'Synthetic correction remains a correction', amendsTaskId: original.id, replaceQueued: true }).task
    // Real routine rows: a paused routine with one executed window and one that ran twice under the old per-version identity.
    const routines = new RoutineStore(registry.db), now = 1_770_000_000_000
    const paused = routines.add({ kind: 'schedule', ownerOpenId: 'synthetic-user', spaceId: 'synthetic-space', chatId: 'synthetic-chat', chatType: 'group',
      name: 'Synthetic routine', prompt: PRIVATE_TEXT, schedule: { type: 'interval', everyMinutes: 10 }, now })
    const executed = routines.claimDueOccurrence(paused.id, paused.nextRunAt, paused.nextRunAt)!
    routines.startOccurrence(executed.id, paused.nextRunAt); routines.finishOccurrence(executed.id, 'done', paused.nextRunAt + 1)
    routines.setEnabled(paused.id, false, now + 1)
    // A GitHub issue creation whose acknowledgement was lost: the ledger keeps it unknown, never resends it.
    const issues = new IssueLinks(registry.db, () => now)
    issues.planOperation({ requestKey: 'synthetic-issue-request', signature: 'synthetic-signature', action: 'create', repo: 'test-org/test-repo', fingerprint: 'synthetic-fingerprint' })
    issues.unknownOperation('synthetic-issue-request', 'synthetic lost acknowledgement')
    const todo = new Todos(registry.db).add({ scope: 'synthetic-space', title: PRIVATE_TEXT, detail: PRIVATE_TEXT,
      owner: 'Synthetic owner', dueMs: now + 86400_000, source: 'Synthetic original material', createdBy: 'synthetic-user' })
    const originalTodoRow = registry.db.prepare('SELECT * FROM todos WHERE id=?').get(todo.id)
    const cache = new MessageCache(registry.db)
    cache.upsert('synthetic-chat', [{ messageId: 'synthetic-cached-message', createTimeMs: now, msgType: 'text',
      senderName: 'Synthetic user', senderType: 'user', text: PRIVATE_TEXT }])
    cache.markCovered('synthetic-chat', now / 1000, now / 1000 + 60)
    const originalMessageRow = registry.db.prepare('SELECT * FROM messages WHERE message_id=?').get('synthetic-cached-message')
    const originalCoverage = registry.db.prepare('SELECT * FROM chat_coverage').all()
    // A real case, its report, the stopped-case note kept as row 11, and one information question (no material kind before P3-1).
    registry.createSession({ sessionKey: original.sessionKey, chatId: 'synthetic-chat', chatType: 'group', cwd: '/synthetic', requesterOpenId: 'synthetic-user' })
    const bugs = new Bugs(registry.db)
    const bucket = bugs.record({ spaceId: 'synthetic-space', chatId: 'synthetic-chat', title: PRIVATE_TEXT, text: PRIVATE_TEXT, messageId: original.messageId, reporterOpenId: 'synthetic-user', now }).bucket
    registry.db.prepare("INSERT INTO bug_reports (id, bucket_id, chat_id, message_id, reporter_open_id, text, record_kind, created_at) VALUES (11, ?, 'synthetic-chat', 'synthetic-note', 'synthetic-user', ?, 'user_note', ?)")
      .run(bucket.id, PRIVATE_TEXT, now)
    const question = new BugQuestions(registry.db, bugs).prepare({ bucketId: bucket.id, spaceId: 'synthetic-space', sessionKey: original.sessionKey, originTaskId: original.id,
      targetOpenId: 'synthetic-user', anchor: { tenantId: 'synthetic-tenant', appId: 'synthetic-app', chatId: 'synthetic-chat', messageId: original.messageId }, kind: 'info', question: PRIVATE_TEXT })
    registry.close()
    // Emulate the pre-B1 schema; retain actual Registry task/receipt/amendment columns. The work lifecycle tables and the
    // occurrence window identity did not exist either: the old identity allowed the same window once per config version.
    t.db.exec(`DROP TABLE task_dispatches; DROP TABLE work_inputs; DROP TABLE work_pause_reasons; DROP TABLE work_contexts;
      DROP INDEX idx_routine_occurrences_window;
      ALTER TABLE routine_occurrences DROP COLUMN window_key; ALTER TABLE routine_occurrences DROP COLUMN window_duplicate_of;
      DROP INDEX idx_issue_operations_work; ALTER TABLE github_issue_operations DROP COLUMN origin_json;
      ALTER TABLE github_issue_operations DROP COLUMN reconciliation;
      ALTER TABLE todos DROP COLUMN provenance_json;
      ALTER TABLE routines DROP COLUMN min_new_messages; ALTER TABLE routines DROP COLUMN always_on_mention;
      ALTER TABLE messages DROP COLUMN message_app_link;
      ALTER TABLE messages DROP COLUMN message_position;
      ALTER TABLE messages DROP COLUMN thread_message_position;
      INSERT INTO routine_occurrences (routine_id, scheduled_at, config_version, status, created_at, started_at, finished_at)
        SELECT routine_id, scheduled_at, config_version + 1, 'done', created_at, started_at, finished_at FROM routine_occurrences WHERE id = ${executed.id};
      CREATE TABLE ingress_routes(message_id TEXT PRIMARY KEY,space_id TEXT NOT NULL,actor_open_id TEXT NOT NULL,snapshot TEXT NOT NULL,decision TEXT,result TEXT,created_at INTEGER NOT NULL);
      INSERT INTO ingress_routes VALUES('synthetic-control','synthetic-space','synthetic-user','[]','{"kind":"progress"}','sent',123);`)
    // Pre-P3-1 feedback schema: questions had no material kind and cases no record of declined materials.
    t.db.exec('ALTER TABLE bug_questions DROP COLUMN info_kind; ALTER TABLE bug_buckets DROP COLUMN declined_info')
    expect(t.backup().code).toBe(0)
    const r = t.call('verify', '--protection-dir', t.protectedDir, '--', process.execPath, resolve('scripts/upgrade-schema-copy.mjs'))
    expect(r.code, r.stdout).toBe(0)
    expect(r.result).toMatchObject({ passed: true, old_business_rows: { equal: true }, second_upgrade_idempotent: { equal: true }, added_tables: [
      'chat_read_exclusions', 'console_operations', 'console_sessions', 'email_drafts', 'execution_material_files', 'execution_material_generations', 'execution_material_versions',
      'feishu_task_links', 'feishu_task_operations', 'feishu_task_permission_blocks',
      'github_change_preparations', 'github_change_updates', 'github_ci_followups', 'github_ci_observations', 'github_executions', 'github_issue_assessments', 'github_issue_followups', 'github_issue_notices', 'github_issue_observations', 'github_user_attempts', 'github_user_connections', 'gmail_attempts', 'gmail_connections', 'gmail_scan', 'gmail_threads', 'inbox_items', 'issue_validity_requests',
      'meeting_drafts', 'meeting_sessions',
      'memory_changes', 'memory_fts', 'memory_fts_config', 'memory_fts_data', 'memory_fts_docsize', 'memory_fts_idx',
      'memory_notes', 'memory_provenance', 'memory_tombstones', 'message_kudos', 'minutes_drafts', 'model_task_admissions', 'oauth_attempts',
      'personal_assistance', 'personal_collection_cursors', 'personal_collection_evidence', 'personal_collection_items', 'personal_collection_pages', 'personal_collection_profiles', 'personal_collection_read_gaps', 'personal_collection_receipts',
      'personal_device_operations', 'personal_device_pairs', 'personal_devices', 'personal_inputs', 'personal_local_work', 'personal_mcp_calls', 'personal_mcp_connections', 'personal_reply_messages', 'personal_reply_reviews', 'personal_results',
      'pmo_base_owners', 'pmo_projection_records', 'pmo_projection_writes',
      'poll_ballots', 'poll_read_snapshots', 'polls', 'reported_refs',
      'run_api_calls', 'run_attempts', 'run_contexts', 'run_models', 'run_skill_sets', 'runtime_contexts', 'skill_proposals', 'space_skill_bindings', 'task_dispatches', 'task_event_sources', 'todo_completion_evidence', 'user_tokens',
      'work_assessments', 'work_contexts', 'work_inputs', 'work_pause_reasons',
    ], protected_backup_unchanged: true })
    const upgraded = new DatabaseSync(join(r.result.run_dir, 'candidate.db'), { readOnly: true })
    try {
      for (const table of ['feishu_task_links', 'feishu_task_operations', 'github_change_preparations', 'github_change_updates', 'github_ci_followups', 'github_ci_observations', 'github_executions', 'github_issue_assessments', 'github_issue_followups', 'github_issue_notices', 'github_issue_observations', 'inbox_items', 'issue_validity_requests', 'meeting_drafts', 'meeting_sessions', 'message_kudos', 'minutes_drafts', 'model_task_admissions', 'oauth_attempts', 'pmo_base_owners', 'pmo_projection_records', 'pmo_projection_writes', 'poll_ballots', 'poll_read_snapshots', 'polls', 'reported_refs', 'run_api_calls', 'todo_completion_evidence', 'user_tokens', 'work_assessments']) {
        expect(upgraded.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, table).toBe(0)
      }
      // P4-2 G8: reported_refs is one new empty table with a composite primary key and no other index; the Orchestrator constructor creates it at startup.
      expect(upgraded.prepare('PRAGMA table_info(reported_refs)').all().map(c => [c.name, c.type, c.notnull, c.pk]))
        .toEqual([['owner_open_id', 'TEXT', 1, 1], ['ref', 'TEXT', 1, 2], ['output_key', 'TEXT', 1, 3], ['delivered_at', 'INTEGER', 1, 0]])
      expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='reported_refs' AND sql IS NOT NULL").all()).toEqual([])
      // P4-2 G7: two routines columns with NOT NULL defaults; the paused legacy routine reads back as “no threshold, run when mentioned”.
      expect(upgraded.prepare('PRAGMA table_info(routines)').all().find(c => c.name === 'min_new_messages')).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 })
      expect(upgraded.prepare('PRAGMA table_info(routines)').all().find(c => c.name === 'always_on_mention')).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '1', pk: 0 })
      expect(upgraded.prepare('SELECT min_new_messages, always_on_mention FROM routines WHERE id=?').get(paused.id)).toEqual({ min_new_messages: 0, always_on_mention: 1 })
      // Issue assessment ledger (P3-3a): one new empty table with a state CHECK and four UNIQUE columns; no explicit index.
      expect(upgraded.prepare('PRAGMA table_info(work_assessments)').all().map(c => [c.name, c.type, c.notnull, c.pk]))
        .toEqual([['id', 'TEXT', 0, 1], ['message_id', 'TEXT', 1, 0], ['admission_key', 'TEXT', 1, 0], ['signature', 'TEXT', 1, 0], ['request', 'TEXT', 1, 0],
          ['snapshot', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['result', 'TEXT', 0, 0], ['failure', 'TEXT', 0, 0], ['run_id', 'TEXT', 0, 0], ['session_key', 'TEXT', 0, 0],
          ['acp_session_id', 'TEXT', 0, 0], ['handoff', 'TEXT', 0, 0], ['authority', 'TEXT', 0, 0], ['created_at', 'INTEGER', 1, 0], ['expires_at', 'INTEGER', 1, 0]])
      expect(upgraded.prepare("SELECT name FROM pragma_index_list('work_assessments') WHERE \"unique\"=1").all().map(index => upgraded.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(String(index.name)).map(column => column.name)).sort())
        .toEqual([['acp_session_id'], ['admission_key'], ['id'], ['run_id'], ['session_key']])
      expect(upgraded.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='work_assessments' AND sql IS NOT NULL").get()?.n).toBe(0)
      // Demand polls: three new empty tables and two plain indexes, the same shape startup creates with FRIDAY_POLLS on or off.
      expect(upgraded.prepare('PRAGMA table_info(polls)').all().map(c => [c.name, c.type, c.notnull, c.pk]))
        .toEqual([['id', 'TEXT', 0, 1], ['operation_key', 'TEXT', 1, 0], ['space_id', 'TEXT', 1, 0], ['chat_id', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['value_json', 'TEXT', 1, 0]])
      expect(upgraded.prepare('PRAGMA table_info(poll_ballots)').all().map(c => [c.name, c.type, c.notnull, c.pk]))
        .toEqual([['poll_id', 'TEXT', 1, 1], ['voter_open_id', 'TEXT', 1, 2], ['voter_name', 'TEXT', 0, 0], ['option_id', 'TEXT', 0, 0], ['event_id', 'TEXT', 1, 0], ['event_time_micros', 'TEXT', 1, 0], ['updated_at', 'INTEGER', 1, 0]])
      expect(upgraded.prepare('PRAGMA table_info(poll_read_snapshots)').all().map(c => [c.name, c.type, c.notnull, c.pk]))
        .toEqual([['digest', 'TEXT', 0, 1], ['poll_id', 'TEXT', 1, 0], ['value_json', 'TEXT', 1, 0]])
      expect(upgraded.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name IN ('polls_space', 'poll_reads_poll') ORDER BY name").all())
        .toEqual([{ name: 'poll_reads_poll', sql: 'CREATE INDEX poll_reads_poll ON poll_read_snapshots(poll_id)' }, { name: 'polls_space', sql: 'CREATE INDEX polls_space ON polls(space_id,state)' }])
      // Meeting attendance: two new empty tables and one plain index, the same shape startup creates with FRIDAY_MEETINGS on or off.
      expect(upgraded.prepare('PRAGMA table_info(meeting_sessions)').all().map(c => [c.name, c.type, c.notnull, c.pk]))
        .toEqual([['id', 'TEXT', 0, 1], ['owner_open_id', 'TEXT', 1, 0], ['meeting_number', 'TEXT', 1, 0], ['enabled', 'INTEGER', 1, 0], ['state', 'TEXT', 1, 0], ['value_json', 'TEXT', 1, 0], ['created_at', 'INTEGER', 1, 0], ['updated_at', 'INTEGER', 1, 0]])
      expect(upgraded.prepare('PRAGMA table_info(meeting_drafts)').all().map(c => [c.name, c.type, c.notnull, c.pk]))
        .toEqual([['id', 'TEXT', 0, 1], ['session_id', 'TEXT', 1, 0], ['digest', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['value_json', 'TEXT', 1, 0], ['created_at', 'INTEGER', 1, 0]])
      expect(upgraded.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('meeting_sessions', 'meeting_drafts') AND sql IS NOT NULL").all())
        .toEqual([{ name: 'idx_meeting_sessions_owner', sql: 'CREATE INDEX idx_meeting_sessions_owner ON meeting_sessions(owner_open_id,enabled,state)' }])
      expect(upgraded.prepare("SELECT name FROM pragma_index_list('meeting_drafts') WHERE \"unique\"=1").all().map(index => upgraded.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(String(index.name)).map(column => column.name)))
        .toContainEqual(['session_id', 'digest'])
      // Minutes action-item drafts: one new empty table and one plain index, created at startup and by this adapter.
      expect(upgraded.prepare('PRAGMA table_info(minutes_drafts)').all().map(c => [c.name, c.type, c.notnull, c.pk]))
        .toEqual([['id', 'TEXT', 0, 1], ['owner_open_id', 'TEXT', 1, 0], ['minute_token', 'TEXT', 1, 0], ['digest', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['value_json', 'TEXT', 1, 0], ['created_at', 'INTEGER', 1, 0], ['expires_at', 'INTEGER', 1, 0]])
      expect(upgraded.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='minutes_drafts' AND sql IS NOT NULL").all())
        .toEqual([{ name: 'idx_minutes_drafts_owner', sql: 'CREATE INDEX idx_minutes_drafts_owner ON minutes_drafts(owner_open_id,minute_token,state)' }])
      expect(upgraded.prepare("SELECT name FROM pragma_index_list('minutes_drafts') WHERE \"unique\"=1").all().map(index => upgraded.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(String(index.name)).map(column => column.name)))
        .toContainEqual(['owner_open_id', 'digest'])
      const ciUniqueKeys = upgraded.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique"=1').all('github_ci_followups')
        .map(index => upgraded.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(String(index.name)).map(column => column.name))
      expect(ciUniqueKeys).toContainEqual(['change_id', 'expected_snapshot', 'control_epoch', 'instruction_seq'])
      expect(ciUniqueKeys).not.toContainEqual(['change_id', 'expected_snapshot'])
      expect(ciUniqueKeys).not.toContainEqual(['change_id', 'head'])
      expect(upgraded.prepare('PRAGMA table_info(github_ci_followups)').all().find(row => row.name === 'policy_json'))
        .toMatchObject({ notnull: 0, dflt_value: null })
      expect(upgraded.prepare('PRAGMA table_info(github_ci_followups)').all().find(row => row.name === 'latest_checks_json'))
        .toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
      expect(upgraded.prepare('PRAGMA table_info(run_api_calls)').all().find(row => row.name === 'operations_json'))
        .toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'[]'" })
      expect(upgraded.prepare('SELECT prior_task_id FROM task_amendments WHERE task_id=?').get(amendment.id)?.prior_task_id).toBe(original.id)
      expect(upgraded.prepare('SELECT prompt FROM tasks WHERE id=?').get(original.id)?.prompt).toBe(PRIVATE_TEXT)
      expect(upgraded.prepare('SELECT text,record_kind FROM bug_reports WHERE id=11').get()).toMatchObject({ text: PRIVATE_TEXT, record_kind: 'user_note' })
      // P3-1 adds two columns only: old cases get an empty declined-material record, old questions no material kind; nothing is inferred.
      expect(upgraded.prepare('SELECT id, declined_info FROM bug_buckets').all()).toEqual([{ id: bucket.id, declined_info: '[]' }])
      expect(upgraded.prepare('SELECT id, info_kind, resolution FROM bug_questions').all()).toEqual([{ id: question.id, info_kind: null, resolution: 'open' }])
      expect(upgraded.prepare('PRAGMA table_info(bug_buckets)').all().find(c => c.name === 'declined_info')).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'[]'", pk: 0 })
      expect(upgraded.prepare('PRAGMA table_info(bug_questions)').all().find(c => c.name === 'info_kind')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 })
      expect(t.db.prepare('PRAGMA table_info(bug_buckets)').all().map(c => c.name)).not.toContain('declined_info')
      expect(t.db.prepare('PRAGMA table_info(bug_questions)').all().map(c => c.name)).not.toContain('info_kind')
      expect(upgraded.prepare('SELECT status FROM deliveries').get()?.status).toBe('unknown')
      expect(upgraded.prepare('SELECT handoff,notice,result,attempt_count,last_failure_code,retry_at FROM ingress_routes').get())
        .toMatchObject({ handoff: null, notice: null, result: 'sent', attempt_count: 0, last_failure_code: null, retry_at: null })
      expect(upgraded.prepare('SELECT count(*) AS n FROM task_dispatches').get()?.n).toBe(0)
      expect(upgraded.prepare('SELECT * FROM todos WHERE id=?').get(todo.id)).toEqual(originalTodoRow)
      expect(upgraded.prepare('SELECT count(*) AS n FROM todos').get()?.n).toBe(1)
      expect(upgraded.prepare('SELECT * FROM messages WHERE message_id=?').get('synthetic-cached-message')).toEqual(originalMessageRow)
      expect(upgraded.prepare('SELECT * FROM chat_coverage').all()).toEqual(originalCoverage)
      for (const column of ['message_app_link', 'message_position', 'thread_message_position']) {
        expect(upgraded.prepare('PRAGMA table_info(messages)').all().find(c => c.name === column))
          .toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
      }
      expect(upgraded.prepare('PRAGMA table_info(todos)').all().find(c => c.name === 'provenance_json'))
        .toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
      // Work lifecycle is derived from the recorded Tasks only: one root, two inputs, no pause and no invented control.
      expect(upgraded.prepare('SELECT work_key, lifecycle, input_seq, handled_seq, revision, control_epoch FROM work_contexts').all())
        .toEqual([{ work_key: `task:${original.id}`, lifecycle: 'open', input_seq: 2, handled_seq: 1, revision: 1, control_epoch: 1 }])
      expect(upgraded.prepare('SELECT task_id FROM work_inputs ORDER BY seq').all().map(row => row.task_id)).toEqual([original.id, amendment.id])
      expect(upgraded.prepare('SELECT count(*) AS n FROM work_pause_reasons').get()?.n).toBe(0)
      expect(upgraded.prepare('PRAGMA table_info(deliveries)').all().map(c => c.name)).toContain('reconciliation')
      // Occurrence windows are derived from scheduled_at; the older duplicate of the same window is marked, never deleted or renumbered.
      expect(upgraded.prepare('SELECT id, status, config_version, window_key, window_duplicate_of FROM routine_occurrences ORDER BY id').all()).toEqual([
        { id: executed.id, status: 'done', config_version: 1, window_key: occurrenceWindowKey(paused.nextRunAt), window_duplicate_of: executed.id + 1 },
        { id: executed.id + 1, status: 'done', config_version: 2, window_key: occurrenceWindowKey(paused.nextRunAt), window_duplicate_of: null },
      ])
      expect(upgraded.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_routine_occurrences_window'").get()?.n).toBe(1)
      // The unresolved GitHub creation gains the additive reconciliation column and no invented result.
      expect(upgraded.prepare('SELECT status, number, reconciliation, origin_json FROM github_issue_operations').all()).toEqual([{ status: 'unknown', number: null, reconciliation: null, origin_json: null }])
      // The producing-Work binding is a nullable additive column: never inferred for a pre-existing operation.
      expect(upgraded.prepare('PRAGMA table_info(github_issue_operations)').all().find(c => c.name === 'origin_json'))
        .toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 })
      expect(upgraded.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_issue_operations_work'").get()?.sql)
        .toBe("CREATE INDEX idx_issue_operations_work ON github_issue_operations(json_extract(origin_json,'$.origin.workKey'), created_at)")
      expect(upgraded.prepare('SELECT "unique", partial FROM pragma_index_list(?) WHERE name=?').get('github_issue_operations', 'idx_issue_operations_work'))
        .toEqual({ unique: 0, partial: 0 })
      expect(upgraded.prepare('SELECT enabled, disabled_reason, prompt FROM routines WHERE id=?').get(paused.id)).toEqual({ enabled: 0, disabled_reason: '手动停用', prompt: PRIVATE_TEXT })
    } finally { upgraded.close() }
    expect(t.db.prepare('PRAGMA table_info(ingress_routes)').all().map(c => c.name)).not.toContain('handoff')
    expect(t.db.prepare('PRAGMA table_info(routine_occurrences)').all().map(c => c.name)).not.toContain('window_key')
    expect(t.db.prepare('PRAGMA table_info(github_issue_operations)').all().map(c => c.name)).not.toContain('reconciliation')
    expect(t.db.prepare('PRAGMA table_info(github_issue_operations)').all().map(c => c.name)).not.toContain('origin_json')
    expect(t.db.prepare('PRAGMA table_info(todos)').all().map(c => c.name)).not.toContain('provenance_json')
    expect(t.db.prepare('PRAGMA table_info(routines)').all().map(c => c.name)).not.toContain('min_new_messages')
    expect(t.db.prepare('PRAGMA table_info(routines)').all().map(c => c.name)).not.toContain('always_on_mention')
    expect(t.db.prepare("SELECT name FROM sqlite_master WHERE name = 'reported_refs'").all()).toEqual([])
    expect(t.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('polls', 'poll_ballots', 'poll_read_snapshots')").all()).toEqual([])
    expect(t.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('meeting_sessions', 'meeting_drafts', 'idx_meeting_sessions_owner')").all()).toEqual([])
    expect(t.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('minutes_drafts', 'idx_minutes_drafts_owner')").all()).toEqual([])
    expect(t.db.prepare("SELECT name FROM sqlite_master WHERE name='work_assessments'").all()).toEqual([])
    const { provenance_json: _newProof, ...originalLegacyTodo } = originalTodoRow!
    expect(t.db.prepare('SELECT * FROM todos WHERE id=?').get(todo.id)).toEqual(originalLegacyTodo)
  })

  it('reprotects only a verified completed backup and rejects sidecars instead of treating active WAL as immutable', () => {
    const t = fixture(); const backup = t.backup()
    const output = join(t.home, 'portable'), baseline = join(t.protectedDir, 'baseline.db')
    writeFileSync(baseline + '-wal', 'synthetic sidecar')
    expect(t.call('reprotect', '--protection-dir', t.protectedDir, '--out-dir', output).result).toMatchObject({ error_code: 'frozen_backup_has_sidecars' })
    rmSync(baseline + '-wal')
    const r = t.call('reprotect', '--protection-dir', t.protectedDir, '--out-dir', output)
    expect(r.code, r.stdout).toBe(0)
    expect(r.result).toMatchObject({ action: 'reprotect_completed_backup', source_backup_sha256: backup.result.backup_sha256, source_open_mode: 'ro_immutable_completed_backup_only', quick_check: 'ok' })
    const copy = new DatabaseSync(join(output, 'baseline.db'), { readOnly: true })
    try { expect(copy.prepare('SELECT text FROM bug_reports WHERE id=11').get()?.text).toBe(PRIVATE_TEXT) }
    finally { copy.close() }
  })

  it.each([
    ['original wording', "UPDATE bug_reports SET text='changed'"],
    ['original ID', 'UPDATE bug_buckets SET id=2'],
    ['Issue reference', "UPDATE bug_buckets SET issue_url='https://github.com/test-org/test-repo/issues/8'"],
    ['PR reference', 'UPDATE github_changes SET pr_number=8'],
    ['cursor', 'UPDATE routines SET message_cursor_sec=1770000001'],
    ['pause reason', "UPDATE routines SET disabled_reason='different'"],
    ['unknown delivery', "UPDATE deliveries SET status='sent'"],
  ])('detects changed %s rather than silently accepting migration', (_name, sql) => {
    const t = fixture(); t.backup()
    const r = t.verify(`c.execute(${JSON.stringify(sql)})`)
    expect(r.code).toBe(1)
    expect(r.result).toMatchObject({ passed: false, error_code: 'first_upgrade_changed_protected_rows', protected_backup_unchanged: true })
    expect(r.result.passes).toHaveLength(1)
    expect(r.stdout + r.stderr).not.toContain(PRIVATE_TEXT)
  })

  it('detects a second upgrade mutating a newly created table', () => {
    const t = fixture(); t.backup()
    const r = t.verify(`c.execute('create table if not exists synthetic_counter(n integer)')
if c.execute('select count(*) from synthetic_counter').fetchone()[0] == 0: c.execute('insert into synthetic_counter values(0)')
c.execute('update synthetic_counter set n=n+1')`)
    expect(r.code).toBe(1)
    expect(r.result).toMatchObject({ error_code: 'second_upgrade_not_idempotent', old_business_rows: { equal: true }, second_upgrade_idempotent: { equal: false } })
    expect(r.result.passes).toHaveLength(2)
  })

  it('reports only exit status and byte counts for an upgrade failure, discarding potentially private logs', () => {
    const t = fixture(); t.backup()
    const r = t.verify(`print(${JSON.stringify(PRIVATE_TEXT)})\nraise RuntimeError(${JSON.stringify(SECRET)})`)
    expect(r.code).toBe(1)
    expect(r.result).toMatchObject({ error_code: 'first_upgrade_failed', protected_backup_unchanged: true })
    expect(r.result.passes[0]).toMatchObject({ exit_code: 1 })
    expect(r.result.passes[0].stdout_bytes).toBeGreaterThan(0)
    expect(r.result.passes[0].stderr_bytes).toBeGreaterThan(0)
    expect(r.stdout + r.stderr + readFileSync(join(r.result.run_dir, 'verification.json'), 'utf8')).not.toMatch(new RegExp(`${PRIVATE_TEXT}|${SECRET}`))
  })

  it('stops a hanging adapter within the chosen timeout and keeps the baseline unchanged', () => {
    const t = fixture(); t.backup()
    const r = t.verify('import time\ntime.sleep(3)', 1)
    expect(r.code).toBe(1)
    expect(r.result).toMatchObject({ error_code: 'upgrade_timeout', protected_backup_unchanged: true, passed: false })
  })
})
