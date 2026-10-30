import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ChannelMemory } from '../src/core/memory.js'
import { renderReceipt } from '../src/core/receipt.js'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  return { db, memory: new ChannelMemory(db) }
}
const scope = 'space:sp_dm_alice'

describe('bounded profile discovery in prepared memory', () => {
  it('includes the current candidate profile for a different natural question without requiring a whole-sentence match or writing memory', () => {
    const { db, memory } = fixture()
    const old = memory.add({ scope, kind: 'profile', title: '希望被称为轻舟', body: '以后称呼我为轻舟。' })
    const latest = memory.add({ scope, kind: 'profile', title: '希望被称为远山', body: '改称呼为远山，其他偏好保持。', replaces: old.id })
    const before = db.prepare('SELECT * FROM memory_notes ORDER BY id').all()
    const changes = memory.changes()
    const query = '我现在希望你怎么称呼我？'
    expect(memory.search(scope, query)).toEqual([])
    const composed = memory.composeForPrompt(scope, query)
    expect(composed.text).toContain('远山')
    expect(composed.text).not.toContain('轻舟')
    expect(composed.text).toContain('自动记录未确认')
    expect(composed.used.notes).toEqual([expect.objectContaining({ id: latest.id, revision: 1, status: 'candidate' })])
    expect(composed.used.layers).toEqual([{ scope, label: '个人', rules: 0, hits: 0, total: 1, profiles: 1, profilesTruncated: false }])
    expect(db.prepare('SELECT * FROM memory_notes ORDER BY id').all()).toEqual(before)
    expect(memory.changes()).toEqual(changes)
  })

  it('filters superseded and managed provenance before LIMIT so they cannot crowd out an older readable profile', () => {
    const { db, memory } = fixture()
    const visible = memory.add({ scope, kind: 'profile', title: 'older current preference', body: 'VISIBLE_PROFILE' })
    db.prepare('UPDATE memory_notes SET created_at=1 WHERE id=?').run(visible.id)
    for (let index = 0; index < 5; index++) {
      memory.add({ scope, kind: 'profile', title: `old ${index}`, body: 'SUPERSEDED_PROFILE', status: 'superseded' })
      for (const state of ['verified', 'unavailable'] as const) memory.add({ scope, kind: 'profile', title: `${state} ${index}`, body: 'MANAGED_PROFILE',
        provenance: { state, originRunId: 'synthetic-run', sources: [{ ref: 'synthetic-message', tenantId: 'synthetic-tenant',
          appId: 'synthetic-app', spaceId: scope, chatId: 'oc_source', readIdentity: { kind: 'user', openId: 'alice' }, readAt: 1, coverage: 'complete' }] } })
    }
    expect(memory.profiles(scope, 1).map(note => note.id)).toEqual([visible.id])
    const composed = memory.composeForPrompt(scope, 'a completely unrelated question')
    expect(composed.text).toContain('VISIBLE_PROFILE')
    expect(composed.text).not.toMatch(/SUPERSEDED_PROFILE|MANAGED_PROFILE/)
    expect(composed.used.notes.map(note => note.id)).toEqual([visible.id])
    expect(composed.used.layers[0]).toMatchObject({ total: 1, profiles: 1, profilesTruncated: false })
  })

  it('keeps confirmed and candidate profiles distinct and includes only explicitly supplied scopes', () => {
    const { memory } = fixture()
    const confirmed = memory.add({ scope, kind: 'profile', title: 'confirmed preference', body: 'CONFIRMED_PROFILE' })
    memory.confirm(confirmed.id, scope, { by: 'alice', messageId: 'om_confirmation' })
    const candidate = memory.add({ scope: 'circle:team', kind: 'profile', title: 'candidate preference', body: 'CANDIDATE_PROFILE' })
    memory.add({ scope: 'space:other', kind: 'profile', title: 'other person', body: 'OTHER_SCOPE_PRIVATE' })
    const composed = memory.composeForPrompt([{ scope, label: 'personal' }, { scope: 'circle:team', label: 'authorized team' }], 'unrelated question')
    expect(composed.used.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: confirmed.id, revision: 2, status: 'confirmed' }),
      expect.objectContaining({ id: candidate.id, revision: 1, status: 'candidate' }),
    ]))
    expect(composed.used.notes).toHaveLength(2)
    const confirmedLine = composed.text.split('\n').find(line => line.endsWith('confirmed preference'))!
    const candidateLine = composed.text.split('\n').find(line => line.endsWith('candidate preference'))!
    expect(confirmedLine).not.toContain('自动记录未确认')
    expect(candidateLine).toContain('自动记录未确认')
    expect(composed.text).not.toContain('OTHER_SCOPE_PRIVATE')
    expect(memory.composeForPrompt(scope, 'unrelated question').text).not.toContain('CANDIDATE_PROFILE')
  })

  it('uses a deterministic three-profile budget per scope and reports omitted profiles while leaving explicit search available', () => {
    const { db, memory } = fixture()
    const notes = Array.from({ length: 5 }, (_, index) => memory.add({ scope, kind: 'profile', title: `preference-${index}`, body: `PROFILE_BODY_${index}` }))
    db.prepare('UPDATE memory_notes SET created_at=100').run()
    const composed = memory.composeForPrompt(scope, 'unrelated question')
    expect(composed.used.notes.map(note => note.id)).toEqual(notes.slice(2).reverse().map(note => note.id))
    expect(composed.used.layers[0]).toMatchObject({ total: 5, profiles: 3, profilesTruncated: true, hits: 0 })
    expect(composed.text).toContain('仅取最新 3 条')
    expect(composed.text).not.toContain('PROFILE_BODY_0')
    expect(memory.search(scope, 'PROFILE_BODY_0').map(note => note.id)).toEqual([notes[0].id])
    const receipt = renderReceipt({ sessionKey: 'synthetic', atMs: 100, where: 'synthetic DM', spaceId: 'sp_dm_alice',
      actor: 'alice', memory: composed.used, priorMessages: 0, attachments: 0, prefs: 0, crossSpace: [], excluded: [] }, 'Friday')
    expect(receipt).toContain('近期偏好 3 条（仅取最近部分）')
    expect(receipt).toContain('按这次的问题命中 0 条')
    expect(receipt).not.toContain('按这次的问题命中 3 条')
  })

  it('does not repeat a profile in material or receipt when relevant search also returns it', () => {
    const { memory } = fixture()
    const profile = memory.add({ scope, kind: 'profile', title: 'shared-search profile', body: 'PROFILE_ONCE' })
    const fact = memory.add({ scope, kind: 'fact', title: 'shared-search observation', body: 'FACT_ONCE' })
    const composed = memory.composeForPrompt(scope, 'shared-search')
    expect(memory.search(scope, 'shared-search').map(note => note.id)).toEqual(expect.arrayContaining([profile.id, fact.id]))
    expect(composed.text.match(/PROFILE_ONCE/g)).toHaveLength(1)
    expect(composed.text.match(/FACT_ONCE/g)).toHaveLength(1)
    expect(composed.used.notes.map(note => note.id)).toEqual([profile.id, fact.id])
    expect(composed.used.layers[0]).toMatchObject({ profiles: 1, hits: 1 })
  })
})
