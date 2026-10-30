import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillProposals } from '../src/core/skills.js'

const GUARD = resolve(process.env.FRIDAY_MIGRATION_GUARD ?? 'scripts/database-migration-guard.py')
const ADAPTER = resolve('scripts/upgrade-schema-copy.mjs')
const OLD_COLUMNS = 'id,name,description,body,session_key,chat_id,chat_type,proposer_open_id,status,card_message_id,decided_by,installed_path,created_at,decided_at'
const NEW_COLUMNS = ['space_id', 'content_digest', 'origin_run_id', 'origin_task_id', 'expected_binding_revision', 'decided_by_open_id']
const SENTINEL = 'SYNTHETIC_SKILL_BODY_仅用于迁移验收\n保留原文、否定、空白与“引号”。  '
const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-skill-migration-'))
  homes.push(home)
  const source = join(home, 'legacy.db'), protectedDir = join(home, 'protected')
  const db = new DatabaseSync(source)
  // Freeze the pre-C3 schema explicitly: constructing the new store would not test an old database.
  db.exec(`CREATE TABLE skill_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,description TEXT NOT NULL,body TEXT NOT NULL,
    session_key TEXT NOT NULL,chat_id TEXT NOT NULL,chat_type TEXT NOT NULL,proposer_open_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',card_message_id TEXT,decided_by TEXT,installed_path TEXT,
    created_at INTEGER NOT NULL,decided_at INTEGER
  );
  CREATE INDEX idx_skill_proposals_status ON skill_proposals(status,created_at);
  CREATE TABLE space_rooms (
    id TEXT PRIMARY KEY,kind TEXT NOT NULL,chat_id TEXT,title TEXT,config TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',created_by TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
  );
  INSERT INTO space_rooms VALUES ('synthetic-space-a','group','synthetic-chat-a','Synthetic A','{}','active','synthetic-owner-a',1,2);
  INSERT INTO space_rooms VALUES ('synthetic-space-b','group','synthetic-chat-b','Synthetic B','{}','active','synthetic-owner-b',3,4);`)
  const put = db.prepare(`INSERT INTO skill_proposals (${OLD_COLUMNS}) VALUES (${Array(14).fill('?').join(',')})`)
  // Both historical accepted records used the same global destination. Neither chat mapping
  // nor the latest timestamp proves which Space should now activate either version.
  put.run(7, 'shared-skill', 'Description A  ', `${SENTINEL}A`, 'synthetic-session-a', 'synthetic-chat-a', 'group', 'synthetic-owner-a',
    'accepted', 'synthetic-card-a', 'Synthetic Operator A', '/synthetic/global/skills/shared-skill/SKILL.md', 11, 21)
  put.run(41, 'shared-skill', 'Description B\nsecond line', `${SENTINEL}B`, 'synthetic-session-b', 'synthetic-chat-b', 'group', 'synthetic-owner-b',
    'accepted', 'synthetic-card-b', 'Synthetic Operator B', '/synthetic/global/skills/shared-skill/SKILL.md', 12, 22)
  put.run(88, 'pending-skill', 'Pending', `${SENTINEL}pending`, 'synthetic-session-a', 'synthetic-chat-a', 'group', null,
    'pending', null, null, null, 13, null)
  put.run(99, 'ignored-skill', 'Ignored', `${SENTINEL}ignored`, 'synthetic-dm', 'synthetic-chat-dm', 'p2p', 'synthetic-owner-dm',
    'ignored', 'synthetic-card-dm', 'Synthetic DM Owner', null, 14, 24)
  const rows = db.prepare(`SELECT ${OLD_COLUMNS} FROM skill_proposals ORDER BY id`).all()
  const spaces = db.prepare('SELECT * FROM space_rooms ORDER BY id').all()
  const sequence = db.prepare("SELECT * FROM sqlite_sequence WHERE name='skill_proposals'").get()
  db.close()
  const sourceHash = hash(source)
  function call(...args: string[]) {
    const run = spawnSync('python3', [GUARD, ...args], { encoding: 'utf8', timeout: 60_000 })
    expect(run.status, 'migration guard must complete successfully').toBe(0)
    expect(run.stdout + run.stderr).not.toContain(SENTINEL)
    return JSON.parse(run.stdout.trim())
  }
  call('backup', '--source', source, '--out-dir', protectedDir)
  const baseline = join(protectedDir, 'baseline.db'), baselineHash = hash(baseline)
  const verified = call('verify', '--protection-dir', protectedDir, '--', process.execPath, ADAPTER)
  expect(verified).toMatchObject({ passed: true, protected_backup_unchanged: true,
    old_business_rows: { equal: true }, second_upgrade_idempotent: { equal: true } })
  expect(verified.passes.map((p: { exit_code: number }) => p.exit_code)).toEqual([0, 0])
  return { home, source, sourceHash, rows, spaces, sequence, baseline, baselineHash, verified,
    candidate: join(verified.run_dir, 'candidate.db') }
}

describe('C3 nonempty legacy Space skill migration', () => {
  it('preserves every old field, ID, install path and sequence across two real adapter upgrades without inferred bindings', () => {
    const t = fixture()
    const candidate = new DatabaseSync(t.candidate, { readOnly: true })
    try {
      expect(candidate.prepare(`SELECT ${OLD_COLUMNS} FROM skill_proposals ORDER BY id`).all()).toEqual(t.rows)
      expect(candidate.prepare('SELECT * FROM space_rooms ORDER BY id').all()).toEqual(t.spaces)
      expect(candidate.prepare("SELECT * FROM sqlite_sequence WHERE name='skill_proposals'").get()).toEqual(t.sequence)
      expect(candidate.prepare(`SELECT ${NEW_COLUMNS.join(',')} FROM skill_proposals ORDER BY id`).all())
        .toEqual(t.rows.map(() => Object.fromEntries(NEW_COLUMNS.map(column => [column, null]))))
      expect(candidate.prepare('SELECT count(*) AS n FROM space_skill_bindings').get()?.n).toBe(0)
      expect(candidate.prepare('SELECT count(*) AS n FROM run_skill_sets').get()?.n).toBe(0)
    } finally { candidate.close() }
    expect(hash(t.source)).toBe(t.sourceHash)
    expect(hash(t.baseline)).toBe(t.baselineHash)
    expect(statSync(t.baseline).mode & 0o777).toBe(0o400)
    expect(statSync(t.candidate).ino).not.toBe(statSync(t.baseline).ino)
    const original = new DatabaseSync(t.source, { readOnly: true })
    try { expect(original.prepare('PRAGMA table_info(skill_proposals)').all().map(row => row.name)).not.toContain('space_id') }
    finally { original.close() }
  })

  it('keeps old accepted/colliding versions unavailable to either Space and rejects a late old card without writes', () => {
    const t = fixture()
    const runtimeCopy = join(t.home, 'runtime-check.db')
    copyFileSync(t.candidate, runtimeCopy)
    const db = new DatabaseSync(runtimeCopy)
    try {
      const skills = new SkillProposals(db)
      const before = db.prepare('SELECT total_changes() AS n').get()?.n
      for (const id of [7, 41, 88]) {
        expect(() => skills.accept(id, 'Synthetic Operator', 'synthetic-owner'))
          .toThrow(expect.objectContaining({ code: 'needs_reconfirmation' }))
      }
      expect(db.prepare('SELECT total_changes() AS n').get()?.n).toBe(before)
      for (const spaceId of ['synthetic-space-a', 'synthetic-space-b']) {
        expect(skills.listInstalled(spaceId)).toEqual([])
        expect(skills.isInstalled(spaceId, 'shared-skill')).toBe(false)
        const run = skills.pinForRun({ runId: `synthetic-run-${spaceId}`, spaceId, builtinDigest: 'synthetic-builtin' })
        expect(run.skills).toEqual([])
        expect(() => skills.loadForRun(spaceId, run.runId, 'shared-skill', 7)).toThrow(/未绑定/)
        expect(skills.getRunSkillSet(run.runId)?.served).toEqual([])
      }
      expect(db.prepare(`SELECT ${OLD_COLUMNS} FROM skill_proposals ORDER BY id`).all()).toEqual(t.rows)
      expect(db.prepare('SELECT count(*) AS n FROM space_skill_bindings').get()?.n).toBe(0)
    } finally { db.close() }
  })
})
