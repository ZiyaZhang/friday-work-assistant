import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ChannelMemory } from '../src/core/memory.js'
import { MemoryPromotionConflict, MemoryRevisionConflict, type MemoryProvenanceInput } from '../src/core/memory-provenance.js'

const scope = 'space:sp_dm_alice'
const proof = { by: 'alice', messageId: 'om-confirm', at: 1000 }
const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })

function fixture(path = ':memory:') {
  const db = new DatabaseSync(path)
  cleanups.push(() => db.close())
  return { db, memory: new ChannelMemory(db) }
}
function provenance(): MemoryProvenanceInput {
  return { state: 'verified', originRunId: 'synthetic-run', sources: [{ ref: 'message:synthetic-source', tenantId: 'tenant-test', appId: 'app-test',
    spaceId: 'space-source', chatId: 'chat-source', messageId: 'om-source', threadId: 'omt-source', rootId: 'om-root',
    readIdentity: { kind: 'user', openId: 'alice' }, readAt: 500, coverage: 'partial', revision: 'source-r1', contentDigest: 'synthetic-digest' }] }
}
function add(memory: ChannelMemory, extra: Partial<Parameters<ChannelMemory['add']>[0]> = {}) {
  return memory.add({ scope, kind: 'fact', title: 'synthetic match', body: 'synthetic source body', ...extra })
}
function snapshot(db: DatabaseSync) {
  return ['memory_notes', 'memory_provenance', 'memory_changes', 'memory_tombstones'].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
}

function legacyShares(confirmed: boolean) {
  const db = new DatabaseSync(':memory:')
  cleanups.push(() => db.close())
  // 真正旧结构：无 revision/provenance/change 表，原 ID 和原分享记录由迁移保留。
  db.exec(`CREATE TABLE memory_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, session_key TEXT, kind TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL,
    source TEXT, superseded_by INTEGER, confirmation TEXT
  );
  CREATE VIRTUAL TABLE memory_fts USING fts5(title, body, content='memory_notes', content_rowid='id', tokenize='trigram');
  CREATE TRIGGER memory_ai AFTER INSERT ON memory_notes BEGIN
    INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END;
  CREATE TRIGGER memory_ad AFTER DELETE ON memory_notes BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  END;`)
  const insert = db.prepare('INSERT INTO memory_notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const status = confirmed ? 'confirmed' : 'candidate', confirmation = confirmed ? JSON.stringify(proof) : null
  insert.run(41, scope, 'old-session', 'rule', 'original rule', 'original body', 10, status, '{"messageId":"old-original"}', null, confirmation)
  insert.run(77, 'org', 'old-session', 'rule', 'original rule', 'original body', 20, status,
    JSON.stringify({ noteId: 41, promotedFrom: scope, by: 'old-admin' }), null, confirmation)
  return { db, memory: new ChannelMemory(db) }
}

describe('versioned memory storage and host provenance (C1)', () => {
  it('versions actual confirmation/forget once, keeps no body tombstone and does not resurrect across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-memory-provenance-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'memory.db'), { db, memory } = fixture(path)
    const note = add(memory, { title: 'FORGET_TITLE_CANARY', body: 'FORGET_BODY_CANARY', source: { by: 'claimed-by', messageId: 'claimed-message' } })
    expect(note.revision).toBe(1)
    expect(memory.getProvenance(note.id)).toEqual({ noteId: note.id, state: 'legacy_unverified', originRunId: null, sources: [], ancestors: [] })
    expect(memory.confirm(note.id, scope, { ...proof, expectedRevision: 1 })).toBe(true)
    expect(memory.get(note.id)).toMatchObject({ revision: 2, status: 'confirmed', source: note.source })
    const confirmed = snapshot(db)
    expect(memory.confirm(note.id, scope, { ...proof, expectedRevision: 2 })).toBe(false)
    expect(snapshot(db)).toEqual(confirmed)
    expect(memory.remove(note.id, scope, { expectedRevision: 2 })).toBe(true)
    expect(memory.get(note.id)).toBeUndefined()
    expect(memory.getProvenance(note.id)).toBeUndefined()
    expect(memory.search(scope, 'FORGET')).toEqual([])
    expect(memory.getTombstone(note.id)).toEqual({ noteId: note.id, scope, revision: 3, forgottenAt: expect.any(Number) })
    expect(memory.changes().map((c) => [c.revision, c.operation])).toEqual([[1, 'created'], [2, 'confirmed'], [3, 'forgotten']])
    expect(JSON.stringify([memory.getTombstone(note.id), memory.changes()])).not.toMatch(/FORGET_|claimed-/)
    expect(memory.remove(note.id, scope)).toBe(false)
    const reopened = fixture(path).memory
    expect(reopened.getTombstone(note.id)).toEqual(memory.getTombstone(note.id))
    expect(reopened.changes()).toEqual(memory.changes())
    expect(add(reopened).id).toBeGreaterThan(note.id)
  })

  it('rejects stale confirm/remove/promote/replacement CAS without changing notes, lineage, or journal', () => {
    const { db, memory } = fixture(), note = add(memory)
    const secondWriter = new ChannelMemory(db)
    secondWriter.confirm(note.id, scope, proof)
    const before = snapshot(db)
    for (const action of [
      () => memory.confirm(note.id, scope, { ...proof, expectedRevision: 1 }),
      () => memory.remove(note.id, scope, { expectedRevision: 1 }),
      () => memory.promote(note.id, scope, 'org', 'alice', { expectedRevision: 1 }),
      () => add(memory, { replaces: note.id, expectedRevision: 1 }),
    ]) {
      expect(action).toThrow(MemoryRevisionConflict)
      expect(snapshot(db)).toEqual(before)
    }
    expect(() => memory.remove(note.id, 'space:someone-else', { expectedRevision: 2 })).toThrow(MemoryRevisionConflict)
    expect(snapshot(db)).toEqual(before)
    expect(() => add(memory, { expectedRevision: 1 })).toThrow('expectedRevision')
    expect(snapshot(db)).toEqual(before)
  })

  it('records both sides of a real replacement without treating replaces or model source fields as ancestry', () => {
    const { memory } = fixture()
    const old = add(memory, { status: 'confirmed', confirmation: proof })
    const copy = memory.promote(old.id, scope, 'org')!
    const correction = add(memory, { replaces: old.id, expectedRevision: 1, source: { ancestors: [{ id: old.id, revision: 1 }], provenance: provenance() } })
    expect(memory.get(old.id)?.revision).toBe(1)
    expect(memory.get(copy.id)).toBeDefined()
    expect(memory.getProvenance(correction.id)).toMatchObject({ state: 'legacy_unverified', sources: [], ancestors: [] })
    expect(memory.confirm(correction.id, scope, { ...proof, expectedRevision: 1 })).toBe(true)
    expect(memory.get(old.id)).toMatchObject({ revision: 2, status: 'superseded', supersededBy: correction.id })
    expect(memory.get(correction.id)).toMatchObject({ revision: 2, status: 'confirmed' })
    expect(memory.getProvenance(copy.id)?.state).toBe('unavailable')
    expect(memory.get(copy.id)).toBeUndefined()
    memory.remove(old.id, scope, { expectedRevision: 2 })
    expect(memory.get(correction.id)?.status).toBe('confirmed')
    expect(memory.getProvenance(correction.id)?.ancestors).toEqual([])
  })

  it('copies trusted sources and actual ancestor versions across scopes, while preserving candidate confirmation rules', () => {
    const { memory } = fixture(), input = provenance()
    const original = add(memory, { provenance: input, source: { messageId: 'original-claim' } })
    input.sources[0]!.ref = 'mutated-after-add'
    expect(memory.get(original.id)).toBeUndefined() // 未接 C2 授权入口，不开放正文。
    const copy = memory.promote(original.id, scope, 'org', 'alice', { expectedRevision: 1 })!
    const next = memory.promote(copy.id, 'org', 'circle:test', 'alice')!
    expect(copy.status).toBe('candidate')
    expect(copy.source).toMatchObject({ messageId: 'original-claim', promotedFrom: scope, noteId: original.id })
    expect(memory.getProvenance(next.id)).toEqual({ noteId: next.id, ...provenance(), ancestors: [{ id: original.id, revision: 1 }, { id: copy.id, revision: 1 }] })
    expect(memory.promote(original.id, scope, 'org', 'alice')?.id).toBe(copy.id)
    const before = memory.changes().length
    expect(memory.confirm(original.id, scope, { ...proof, expectedRevision: 1 })).toBe(true) // 内部事务不依赖 public get。
    expect(memory.changes()).toHaveLength(before + 3)
    expect(memory.getProvenance(copy.id)?.state).toBe('unavailable')
    expect(memory.getProvenance(next.id)?.state).toBe('unavailable')
    expect(memory.remove(original.id, scope, { expectedRevision: 2 })).toBe(true)
    expect(memory.promote(copy.id, 'org', 'space:another')).toBeUndefined()
  })

  it('keeps original source fields on a copied correction but does not apply its original replaces relation in another scope', () => {
    const { memory } = fixture(), original = add(memory)
    const correction = add(memory, { replaces: original.id, source: { messageId: 'original-correction' } })
    expect(memory.get(original.id)).toMatchObject({ revision: 2, supersededBy: correction.id })
    const copy = memory.promote(correction.id, scope, 'org')!
    expect(copy.source).toMatchObject({ messageId: 'original-correction', replaces: original.id, noteId: correction.id })
    expect(memory.confirm(copy.id, 'org', proof)).toBe(true)
    expect(memory.get(original.id)?.revision).toBe(2)
    expect(memory.get(correction.id)?.status).toBe('candidate')
  })

  it('does not mistake a model supplied noteId for a real previously copied note', () => {
    const { memory } = fixture(), original = add(memory)
    const fake = add(memory, { scope: 'org', body: 'unrelated body', source: { noteId: original.id, promotedFrom: scope } })
    const copy = memory.promote(original.id, scope, 'org')!
    expect(copy.id).not.toBe(fake.id)
    expect(copy.body).toBe(original.body)
    expect(memory.getProvenance(fake.id)?.ancestors).toEqual([])
    expect(memory.promote(original.id, scope, 'org')?.id).toBe(copy.id)
  })

  it.each([false, true])('reuses the exact pre-C1 share after migration with no writes or fabricated ancestors (confirmed=%s)', (confirmed) => {
    const { db, memory } = legacyShares(confirmed)
    const before = snapshot(db)
    expect(memory.promote(41, scope, 'org', 'new-admin')?.id).toBe(77)
    expect(new ChannelMemory(db).promote(41, scope, 'org', 'new-admin')?.id).toBe(77)
    expect(snapshot(db)).toEqual(before)
    expect(memory.count('org')).toBe(1)
    expect(memory.getProvenance(77)).toEqual({ noteId: 77, state: 'legacy_unverified', originRunId: null, sources: [], ancestors: [] })
    memory.remove(41, scope)
    // 这只是同内容旧分享的复用，不能因此为旧 source.noteId 伪造删除依赖。
    expect(memory.get(77)).toMatchObject({ id: 77, revision: 1, status: confirmed ? 'confirmed' : 'candidate' })
    expect(memory.getProvenance(77)?.ancestors).toEqual([])
    expect(memory.changes()).toEqual([expect.objectContaining({ noteId: 41, operation: 'forgotten' })])
  })

  it.each(['body', 'source-scope', 'session', 'status', 'confirmation', 'ambiguous'])('rejects a conflicting legacy share (%s) without a second copy or any metadata writes', (difference) => {
    const { db, memory } = legacyShares(true)
    if (difference === 'body') db.prepare('UPDATE memory_notes SET body = ? WHERE id = 77').run('different existing body')
    if (difference === 'source-scope') db.prepare('UPDATE memory_notes SET source = ? WHERE id = 77').run(JSON.stringify({ noteId: 41, promotedFrom: 'space:other' }))
    if (difference === 'session') db.prepare('UPDATE memory_notes SET session_key = ? WHERE id = 77').run('different-session')
    if (difference === 'status') db.prepare("UPDATE memory_notes SET status = 'candidate', confirmation = NULL WHERE id = 77").run()
    if (difference === 'confirmation') db.prepare('UPDATE memory_notes SET confirmation = ? WHERE id = 77').run(JSON.stringify({ ...proof, messageId: 'different-confirmation' }))
    if (difference === 'ambiguous') {
      db.exec('INSERT INTO memory_notes SELECT 78, scope, session_key, kind, title, body, created_at, status, source, superseded_by, confirmation, revision FROM memory_notes WHERE id = 77')
      new ChannelMemory(db)
    }
    const before = snapshot(db)
    expect(() => memory.promote(41, scope, 'org', 'alice')).toThrow(MemoryPromotionConflict)
    expect(snapshot(db)).toEqual(before)
  })

  it('forgets an ancestor and atomically disables existing same/cross scope copies while retaining unrelated memories', () => {
    const { db, memory } = fixture(), original = add(memory), unrelated = add(memory, { scope: 'org', title: 'unrelated' })
    const copy = memory.promote(original.id, scope, 'org')!
    const nested = memory.promote(copy.id, 'org', scope)!
    memory.remove(original.id, scope, { expectedRevision: 1 })
    for (const note of [copy, nested]) {
      expect(memory.get(note.id)).toBeUndefined()
      expect(memory.getProvenance(note.id)?.state).toBe('unavailable')
      expect(db.prepare('SELECT revision, status, body FROM memory_notes WHERE id = ?').get(note.id)).toMatchObject({ revision: 2, status: 'candidate', body: note.body })
    }
    expect(memory.count(scope)).toBe(0)
    expect(memory.recent('org').map((n) => n.id)).toEqual([unrelated.id])
    expect(memory.changes().filter((c) => c.operation === 'source_unavailable').map((c) => c.noteId)).toEqual([copy.id, nested.id])
  })

  it('filters managed sources before all old query limits/counts, including rules and review/report consumers', () => {
    const { db, memory } = fixture()
    const legacyFact = add(memory, { title: '匹 synthetic match' })
    const legacyRule = add(memory, { kind: 'rule', status: 'confirmed', confirmation: proof, title: 'legacy rule' })
    db.prepare('UPDATE memory_notes SET created_at = 1').run()
    for (let n = 0; n < 4; n++) {
      add(memory, { title: '匹 synthetic match', provenance: provenance() })
      add(memory, { kind: 'rule', title: 'managed rule', status: 'confirmed', confirmation: proof, provenance: provenance() })
      add(memory, { scope: 'only-managed', provenance: { ...provenance(), state: 'unavailable' } })
    }
    expect(memory.count(scope)).toBe(2)
    expect(memory.count('only-managed')).toBe(0)
    expect(memory.search(scope, 'synthetic', 1).map((n) => n.id)).toEqual([legacyFact.id]) // FTS
    expect(memory.search(scope, '匹', 1).map((n) => n.id)).toEqual([legacyFact.id]) // LIKE
    expect(memory.search('only-managed', '', 1)).toEqual([])
    expect(memory.recent(scope, 2).map((n) => n.id).sort()).toEqual([legacyFact.id, legacyRule.id])
    expect(memory.candidates(scope, 1).map((n) => n.id)).toEqual([legacyFact.id])
    expect(memory.rules(scope, 1).map((n) => n.id)).toEqual([legacyRule.id])
    expect(memory.confirmedBetween(scope, 0, Date.now(), ['rule'], 1).map((n) => n.id)).toEqual([legacyRule.id])
    expect(memory.scopesNeedingReview(1)).toEqual([{ scope, count: 1 }])
    expect(memory.scopesNeedingReview(1, Date.now())).toEqual([{ scope, count: 1 }])
    const used = memory.composeForPrompt(scope, 'synthetic', 1)
    expect(used.text).toContain('legacy rule')
    expect(used.text).not.toContain('managed rule')
    expect(used.used.notes).toEqual([
      expect.objectContaining({ id: legacyRule.id, revision: 1 }), expect.objectContaining({ id: legacyFact.id, revision: 1 }),
    ])
    memory.confirm(legacyFact.id, scope, proof)
    expect(memory.composeForPrompt(scope, 'synthetic').used.notes.find((n) => n.id === legacyFact.id)?.revision).toBe(2)
  })

  it.each(['created', 'confirmed', 'forgotten', 'copied', 'source_unavailable'])('rolls back all rows when %s journal recording fails', (operation) => {
    const { db, memory } = fixture(), original = add(memory)
    if (operation === 'source_unavailable') memory.promote(original.id, scope, 'org')
    db.exec(`CREATE TRIGGER reject_memory_change BEFORE INSERT ON memory_changes WHEN new.operation = '${operation}' BEGIN SELECT RAISE(ABORT, 'synthetic journal failure'); END`)
    const before = snapshot(db)
    const action = operation === 'created' ? () => add(memory, { replaces: original.id })
      : operation === 'confirmed' ? () => memory.confirm(original.id, scope, proof)
        : operation === 'copied' ? () => memory.promote(original.id, scope, 'org')
          : () => memory.remove(original.id, scope)
    expect(action).toThrow('synthetic journal failure')
    expect(snapshot(db)).toEqual(before)
    expect(memory.search(scope, 'synthetic').map((n) => n.id)).toEqual([original.id])
  })

  it('rolls back confirmation and its replacement if recording the old-note supersession fails', () => {
    const { db, memory } = fixture(), original = add(memory, { status: 'confirmed', confirmation: proof })
    const correction = add(memory, { replaces: original.id })
    db.exec(`CREATE TRIGGER reject_supersession BEFORE INSERT ON memory_changes WHEN new.operation = 'superseded' BEGIN SELECT RAISE(ABORT, 'synthetic supersession failure'); END`)
    const before = snapshot(db)
    expect(() => memory.confirm(correction.id, scope, proof)).toThrow('synthetic supersession failure')
    expect(snapshot(db)).toEqual(before)
  })
})
