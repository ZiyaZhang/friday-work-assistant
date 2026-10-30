import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { ChannelMemory } from '../src/core/memory.js'
import { RoutineStore } from '../src/core/routines.js'
import { RuntimeContexts } from '../src/core/runtime-contexts.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'

it('upgrades an online nonempty pre-context copy twice without changing old facts or legitimizing historical ACP contexts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-context-migration-')), source = join(dir, 'source.db'), protection = join(dir, 'protected')
  const registry = new Registry(source), db = registry.db
  try {
    db.exec('PRAGMA wal_autocheckpoint=0')
    const memory = new ChannelMemory(db), attempts = new RunAttempts(db)
    registry.createSession({ sessionKey: 'old-session', chatId: 'synthetic-chat', chatType: 'p2p', cwd: '/synthetic', requesterOpenId: 'alice' })
    registry.updateSession('old-session', { acpSessionId: 'legacy-acp' })
    const original = registry.createTaskOnce({ sessionKey: 'old-session', messageId: 'original', requesterOpenId: 'alice', prompt: 'SYNTHETIC_原话_不允许打印' }).task
    const amended = registry.createTaskOnce({ sessionKey: 'old-session', messageId: 'amended', requesterOpenId: 'alice', prompt: '只更正原话，保留原始要求', amendsTaskId: original.id, replaceQueued: true }).task
    const run = attempts.begin({ workKey: `task:${amended.id}`, sessionKey: 'old-session', triggerKey: `task:${amended.id}`, stage: 'task', taskId: amended.id, actorOpenId: 'alice', now: 100 }, () => registry.startTask(amended.id, 100))!
    attempts.bindRuntime(run.id, 'legacy-acp')
    const note = memory.add({ scope: 'space:synthetic', sessionKey: 'old-session', kind: 'fact', title: '合成笔记', body: 'SYNTHETIC_正文_不允许打印' })
    memory.confirm(note.id, note.scope, { by: 'alice', messageId: 'real-confirmation' })
    // Real routine tables: a paused routine with its read position, as a live database would hold them.
    const routines = new RoutineStore(db)
    const paused = routines.add({ kind: 'watch', ownerOpenId: 'alice', runAs: 'alice', spaceId: 'synthetic-space', chatId: 'synthetic-chat', chatType: 'p2p',
      name: 'Synthetic watch', prompt: 'SYNTHETIC_职责_不允许打印', schedule: { type: 'interval', everyMinutes: 10 }, now: 1_789_940_000_000 })
    routines.advanceMessageCursor(paused.id, 1, 1_789_940_000, 1_789_940_030)
    routines.setEnabled(paused.id, false, 1_789_940_000_000)
    // Feedback tables at their pre-P3-1 shape: the real constructors, minus the two columns P3-1 adds.
    new BugQuestions(db, new Bugs(db))
    db.exec(`ALTER TABLE bug_questions DROP COLUMN info_kind; ALTER TABLE bug_buckets DROP COLUMN declined_info;
      CREATE TABLE github_changes(id TEXT PRIMARY KEY,pr_number INTEGER,commit_id TEXT);
      CREATE TABLE deliveries(delivery_key TEXT PRIMARY KEY,status TEXT,remote_id TEXT);
      INSERT INTO bug_reports (id,bucket_id,chat_id,text,record_kind,created_at) VALUES(8,2,'synthetic-chat','SYNTHETIC_补充原文','user_note',1);
      INSERT INTO bug_buckets (id,title,status,issue_url,first_seen_at,last_seen_at) VALUES(2,'SYNTHETIC_标题','open','https://github.com/test-org/test-repo/issues/7',1,1);
      INSERT INTO github_changes VALUES('change',7,'synthetic-sha');
      INSERT INTO deliveries VALUES('old-unknown','unknown',NULL);`)
    const oldNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name))
    // Include WITHOUT ROWID / FTS shadow tables as well as business tables. Compare the original columns only:
    // additive columns (such as deliveries.reconciliation) may appear, original values may not change.
    const oldColumns = new Map(oldNames.map(name => [name, db.prepare(`PRAGMA table_info("${name}")`).all().map(column => String(column.name))]))
    const rows = (connection: DatabaseSync, name: string) => connection.prepare(`SELECT ${oldColumns.get(name)!.map(column => `"${column}"`).join(',')} FROM "${name}"`).all()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    const oldData = new Map(oldNames.map(name => [name, rows(db, name)]))
    const call = (...args: string[]) => {
      const r = spawnSync('python3', [resolve('scripts/database-migration-guard.py'), ...args], { encoding: 'utf8', timeout: 30_000 })
      expect(r.status, r.stdout + r.stderr).toBe(0)
      return { ...JSON.parse(r.stdout.trim()), output: r.stdout + r.stderr }
    }
    call('backup', '--source', source, '--out-dir', protection)
    const result = call('verify', '--protection-dir', protection, '--', process.execPath, resolve('test/helpers/upgrade-runtime-context-copy.mjs'))
    expect(result).toMatchObject({ passed: true, protected_backup_unchanged: true, old_business_rows: { equal: true }, second_upgrade_idempotent: { equal: true } })
    expect(result.passes.map((p: { exit_code: number }) => p.exit_code)).toEqual([0, 0])
    expect(result.added_tables).toContain('run_models')
    expect(result.added_tables).toContain('runtime_contexts')
    expect(result.added_tables).toContain('run_contexts')
    const candidate = new DatabaseSync(join(result.run_dir, 'candidate.db'))
    try {
      for (const [name, oldRows] of oldData) expect(rows(candidate, name), name).toEqual(oldRows)
      const contexts = new RuntimeContexts(candidate)
      expect(contexts.canResume('old-session', 'legacy-acp')).toBe(false)
      expect(contexts.contextForRun(run.id)).toBeUndefined()
      expect(contexts.isEligible(run.id, true)).toBe(false)
      for (const table of ['runtime_contexts', 'run_contexts', 'run_models', 'execution_material_files',
        'execution_material_generations', 'execution_material_versions']) expect(candidate.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0)
      expect(candidate.prepare('SELECT state,acp_session_id FROM run_attempts WHERE id=?').get(run.id)).toEqual({ state: 'running', acp_session_id: 'legacy-acp' })
      // The additive ledger column exists and no reconciliation result is invented for the old unknown receipt.
      expect(candidate.prepare('SELECT reconciliation FROM deliveries').all()).toEqual([{ reconciliation: null }])
    } finally { candidate.close() }
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_contexts'").get()).toBeUndefined()
    expect(result.output + readFileSync(join(result.run_dir, 'verification.json'), 'utf8')).not.toMatch(/SYNTHETIC_|原话|补充原文|职责_/)
  } finally { registry.close(); rmSync(dir, { recursive: true, force: true }) }
})
