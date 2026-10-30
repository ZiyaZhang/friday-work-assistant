import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillProposals, type SkillProposalInput } from '../src/core/skills.js'

const databases: DatabaseSync[] = []
const BODY = '# Procedure\n\nCheck the current source, preserve the supplied evidence, and report the actual result without inventing completion. '
function setup() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  let clock = 100
  const store = new SkillProposals(db, new Set(['builtin-flow']), () => clock++)
  return { db, store }
}
function input(spaceId = 'space-a', version = 'v1'): SkillProposalInput {
  return { name: 'custom-flow', description: `Procedure ${version}`, body: `${BODY}\n${version}`,
    sessionKey: `session-${spaceId}`, chatId: `chat-${spaceId}`, chatType: 'group',
    proposerOpenId: 'ou_author', spaceId, originRunId: `origin-${spaceId}-${version}`, originTaskId: 1 }
}
function accept(store: SkillProposals, spaceId = 'space-a', version = 'v1') {
  const proposal = store.propose(input(spaceId, version))
  return store.accept(proposal.id, 'Operator', 'ou_operator')!
}
const pin = (store: SkillProposals, runId: string, spaceId = 'space-a', builtinDigest = 'builtin-1') => store.pinForRun({ runId, spaceId, builtinDigest })
afterEach(() => { for (const db of databases.splice(0)) db.close() })

describe('Space skill versions and run pins', () => {
  it('keeps same-name skills independent across spaces and pins the original version for an existing run', () => {
    const { store } = setup()
    const a1 = accept(store)
    const b1 = accept(store, 'space-b', 'B only')
    const oldA = pin(store, 'a-old')
    pin(store, 'b-run', 'space-b')
    const a2 = accept(store, 'space-a', 'A updated')
    const newA = pin(store, 'a-new')
    expect(newA.digest).not.toBe(oldA.digest)
    expect(pin(store, 'a-old')).toEqual(oldA)
    expect(store.isRunEligible('a-old')).toBe(true)
    expect(store.loadForRun('space-a', 'a-old', a1.name, a1.id).content).toContain('v1')
    expect(store.loadForRun('space-a', 'a-new', a2.name, a2.id).content).toContain('A updated')
    expect(store.loadForRun('space-b', 'b-run', b1.name, b1.id).content).toContain('B only')
    expect(store.listInstalled('space-a')).toEqual(['custom-flow'])
    expect(store.listInstalled('space-b')).toEqual(['custom-flow'])
  })

  it('rejects stale proposal acceptance and never reactivates an old accepted proposal on repeated clicks', () => {
    const { store } = setup()
    const first = store.propose(input())
    const competing = store.propose(input('space-a', 'competing'))
    store.accept(first.id, 'Original owner', 'ou_first')
    expect(() => store.accept(competing.id, 'Other owner', 'ou_other')).toThrow(expect.objectContaining({ code: 'binding_conflict' }))
    expect(store.get(competing.id)?.status).toBe('pending')
    const second = accept(store, 'space-a', 'second')
    expect(store.accept(first.id, 'Late click', 'ou_late')?.decidedByOpenId).toBe('ou_first')
    expect(store.getBinding('space-a', first.name)).toMatchObject({ proposalId: second.id, revision: 2 })
  })

  it('explicit disable permanently invalidates earlier pins even after a new proposal re-enables the name', () => {
    const { store } = setup()
    const a = accept(store)
    const b = accept(store, 'space-b')
    pin(store, 'a-old')
    pin(store, 'b-old', 'space-b')
    const result = store.disable('space-a', a.name, 1, 'ou_operator')
    expect(result).toMatchObject({ changed: true, runIds: ['a-old'], binding: { enabled: false, revision: 2, lastDisabledRevision: 2 } })
    expect(store.isRunEligible('a-old')).toBe(false)
    expect(store.isRunEligible('b-old')).toBe(true)
    expect(store.listForRun('space-a', 'a-old')).toEqual([])
    expect(() => store.loadForRun('space-a', 'a-old', a.name, a.id)).toThrow(expect.objectContaining({ code: 'unavailable' }))
    expect(() => store.disable('space-a', a.name, 1, 'ou_operator')).toThrow(expect.objectContaining({ code: 'binding_conflict' }))
    expect(store.disable('space-a', a.name, 2, 'ou_operator').changed).toBe(false)
    store.accept(a.id, 'Late old click', 'ou_operator')
    expect(store.isInstalled('space-a', a.name)).toBe(false)
    const next = accept(store, 'space-a', 're-enabled')
    pin(store, 'a-new')
    expect(store.getBinding('space-a', a.name)).toMatchObject({ revision: 3, lastDisabledRevision: 2, enabled: true })
    expect(store.isRunEligible('a-old')).toBe(false)
    expect(store.isRunEligible('a-new')).toBe(true)
    expect(() => store.loadForRun('space-a', 'a-old', a.name, a.id)).toThrow(/停用/)
    expect(store.loadForRun('space-a', 'a-new', next.name, next.id).content).toContain('re-enabled')
    expect(store.loadForRun('space-b', 'b-old', b.name, b.id).content).toContain('v1')
  })

  it('requires the exact run, space and pinned proposal, recording served versions only after a successful load', () => {
    const { store } = setup()
    const a = accept(store)
    const b = accept(store, 'space-b')
    pin(store, 'a-run')
    expect(store.getRunSkillSet('a-run')?.served).toEqual([])
    store.listForRun('space-a', 'a-run')
    expect(store.getRunSkillSet('a-run')?.served).toEqual([])
    expect(() => store.listForRun('space-b', 'a-run')).toThrow(expect.objectContaining({ code: 'run_mismatch' }))
    expect(() => store.listForRun('space-a', 'missing')).toThrow(/绑定/)
    expect(() => store.loadForRun('space-a', 'a-run', a.name, b.id)).toThrow(/未绑定/)
    expect(() => store.loadForRun('space-a', 'a-run', 'another-name', a.id)).toThrow(/未绑定/)
    expect(store.getRunSkillSet('a-run')?.served).toEqual([])
    store.loadForRun('space-a', 'a-run', a.name, a.id)
    store.loadForRun('space-a', 'a-run', a.name, a.id)
    expect(store.getRunSkillSet('a-run')?.served).toEqual([{ proposalId: a.id, contentDigest: a.contentDigest }])
  })

  it('keeps builtin identity immutable per run and gives equivalent manifests the same digest', () => {
    const { store } = setup()
    expect(store.isRunEligible('missing')).toBe(false)
    const empty = pin(store, 'empty')
    expect(empty.skills).toEqual([])
    expect(store.isRunEligible('empty')).toBe(true)
    expect(pin(store, 'empty-again').digest).toBe(empty.digest)
    expect(pin(store, 'new-builtin', 'space-a', 'builtin-2').digest).not.toBe(empty.digest)
    expect(() => pin(store, 'empty', 'space-b')).toThrow(expect.objectContaining({ code: 'run_mismatch' }))
    expect(() => pin(store, 'empty', 'space-a', 'builtin-2')).toThrow(expect.objectContaining({ code: 'run_mismatch' }))
    expect(() => pin(store, 'blank', 'space-a', '')).toThrow(/不完整/)
  })

  it('rolls back both the binding and proposal if acceptance fails between writes', () => {
    const { db, store } = setup()
    const p = store.propose(input())
    db.exec(`CREATE TRIGGER reject_accept BEFORE UPDATE OF status ON skill_proposals
      WHEN NEW.status='accepted' BEGIN SELECT RAISE(ABORT,'synthetic acceptance failure'); END`)
    expect(() => store.accept(p.id, 'Operator', 'ou_operator')).toThrow(/synthetic/)
    expect(store.getBinding('space-a', p.name)).toBeUndefined()
    expect(store.get(p.id)).toMatchObject({ status: 'pending', decidedBy: null, decidedAt: null })
  })

  it('composes acceptance, disable and run pin with the host admission transaction', () => {
    const { db, store } = setup()
    const a = accept(store)
    pin(store, 'old-run')
    db.exec('SAVEPOINT admission')
    const pending = store.propose(input('space-a', 'v2'))
    store.accept(pending.id, 'Operator', 'ou_operator')
    pin(store, 'new-run')
    store.disable('space-a', a.name, 2, 'ou_operator')
    expect(store.isRunEligible('old-run')).toBe(false)
    db.exec('ROLLBACK TO admission; RELEASE admission')
    expect(store.get(pending.id)).toBeUndefined()
    expect(store.getRunSkillSet('new-run')).toBeUndefined()
    expect(store.getBinding('space-a', a.name)).toMatchObject({ proposalId: a.id, revision: 1, enabled: true })
    expect(store.isRunEligible('old-run')).toBe(true)
  })

  it('rejects changed contents before acceptance or loading without recording a false served version', () => {
    const { db, store } = setup()
    const p = store.propose(input())
    db.prepare('UPDATE skill_proposals SET body=? WHERE id=?').run(`${BODY}tampered`, p.id)
    expect(() => store.accept(p.id, 'Operator', 'ou_operator')).toThrow(expect.objectContaining({ code: 'content_changed' }))
    expect(store.getBinding('space-a', p.name)).toBeUndefined()
    const good = accept(store, 'space-a', 'good')
    pin(store, 'pinned')
    db.prepare('UPDATE skill_proposals SET description=? WHERE id=?').run('changed', good.id)
    expect(() => store.loadForRun('space-a', 'pinned', good.name, good.id)).toThrow(expect.objectContaining({ code: 'content_changed' }))
    expect(() => pin(store, 'later')).toThrow(expect.objectContaining({ code: 'content_changed' }))
    expect(store.getRunSkillSet('pinned')?.served).toEqual([])
    expect(store.getRunSkillSet('later')).toBeUndefined()
  })

  it('requires host provenance and decision identity while ignoring keeps proposal history intact', () => {
    const { store } = setup()
    expect(() => store.propose({ ...input(), spaceId: '' })).toThrow(/来源/)
    expect(() => store.propose({ ...input(), originRunId: '' })).toThrow(/来源/)
    expect(() => store.propose({ ...input(), originTaskId: 0 })).toThrow(/无效/)
    expect(() => store.propose({ ...input(), name: 'builtin-flow' })).toThrow(/内置/)
    const p = store.propose(input())
    expect(() => store.accept(p.id, 'Fake display name', '')).toThrow(/操作者/)
    expect(() => store.ignore(p.id, 'Fake display name', ' ')).toThrow(/操作者/)
    expect(store.ignore(p.id, 'Owner', 'ou_owner')).toMatchObject({ id: p.id, status: 'ignored', body: p.body, originRunId: p.originRunId, decidedByOpenId: 'ou_owner' })
    expect(store.accept(p.id, 'Owner', 'ou_owner')).toBeUndefined()
    expect(store.getBinding('space-a', p.name)).toBeUndefined()
  })

  it('rejects a custom binding that collides with a newly bundled reserved name', () => {
    const { db, store } = setup()
    accept(store)
    const upgraded = new SkillProposals(db, new Set(['custom-flow']))
    expect(() => pin(upgraded, 'new-run')).toThrow(/重名/)
    expect(upgraded.getRunSkillSet('new-run')).toBeUndefined()
  })

  it('retains pinned, served and disabled versions after closing and reopening the database', () => {
    const home = mkdtempSync(join(tmpdir(), 'friday-skill-storage-'))
    const path = join(home, 'skills.db')
    let db = new DatabaseSync(path)
    try {
      const initial = new SkillProposals(db)
      const p = accept(initial)
      const originalSet = pin(initial, 'before-restart')
      initial.loadForRun('space-a', 'before-restart', p.name, p.id)
      initial.disable('space-a', p.name, 1, 'ou_operator')
      const next = accept(initial, 'space-a', 'newer')
      db.close()
      db = new DatabaseSync(path)
      const reopened = new SkillProposals(db)
      expect(reopened.getRunSkillSet('before-restart')).toMatchObject({ digest: originalSet.digest,
        skills: originalSet.skills, served: [{ proposalId: p.id, contentDigest: p.contentDigest }] })
      expect(reopened.isRunEligible('before-restart')).toBe(false)
      expect(() => reopened.loadForRun('space-a', 'before-restart', p.name, p.id)).toThrow(/停用/)
      expect(pin(reopened, 'after-restart').skills[0]?.proposalId).toBe(next.id)
      expect(reopened.isRunEligible('after-restart')).toBe(true)
    } finally { db.close(); rmSync(home, { recursive: true, force: true }) }
  })
})

describe('legacy skill migration', () => {
  it('preserves every old proposal value and ID; old accepted files never become an inferred Space binding', () => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    db.exec(`CREATE TABLE skill_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,description TEXT NOT NULL,body TEXT NOT NULL,
      session_key TEXT NOT NULL,chat_id TEXT NOT NULL,chat_type TEXT NOT NULL,proposer_open_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',card_message_id TEXT,decided_by TEXT,installed_path TEXT,
      created_at INTEGER NOT NULL,decided_at INTEGER
    )`)
    for (const [i, status] of ['pending', 'accepted', 'ignored'].entries()) {
      db.prepare(`INSERT INTO skill_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(10 + i, 'legacy-skill',
        `description ${status}`, `${BODY}${status}`, 'legacy-session', 'legacy-chat', 'group', 'ou_original', status,
        `card-${i}`, status === 'pending' ? null : 'Historical owner', status === 'accepted' ? '/legacy/global/SKILL.md' : null,
        50 + i, status === 'pending' ? null : 70 + i)
    }
    const oldColumns = (db.prepare('PRAGMA table_info(skill_proposals)').all() as { name: string }[]).map(row => row.name).join(',')
    const before = db.prepare(`SELECT ${oldColumns} FROM skill_proposals ORDER BY id`).all()
    const store = new SkillProposals(db)
    expect(db.prepare(`SELECT ${oldColumns} FROM skill_proposals ORDER BY id`).all()).toEqual(before)
    for (const id of [10, 11, 12]) expect(store.get(id)).toMatchObject({ spaceId: null, contentDigest: null,
      originRunId: null, originTaskId: null, expectedBindingRevision: null, decidedByOpenId: null })
    expect(() => store.accept(11, 'Now owner', 'ou_owner')).toThrow(expect.objectContaining({ code: 'needs_reconfirmation' }))
    expect(() => store.accept(10, 'Now owner', 'ou_owner')).toThrow(expect.objectContaining({ code: 'needs_reconfirmation' }))
    expect(store.listInstalled('legacy-chat')).toEqual([])
    expect(pin(store, 'legacy-run', 'legacy-chat').skills).toEqual([])
    const snapshot = () => ({ schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
      proposals: db.prepare('SELECT * FROM skill_proposals ORDER BY id').all(),
      bindings: db.prepare('SELECT * FROM space_skill_bindings ORDER BY space_id,name').all(),
      runs: db.prepare('SELECT * FROM run_skill_sets ORDER BY run_id').all() })
    const once = snapshot()
    new SkillProposals(db)
    expect(snapshot()).toEqual(once)
    expect(db.prepare(`SELECT ${oldColumns} FROM skill_proposals ORDER BY id`).all()).toEqual(before)
    const next = store.propose(input())
    expect(next.id).toBe(13)
    expect(next.expectedBindingRevision).toBe(0)
  })
})
