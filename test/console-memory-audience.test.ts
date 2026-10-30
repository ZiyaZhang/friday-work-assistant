import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ChannelMemory, type MemoryAudience } from '../src/core/memory.js'
import { Registry } from '../src/core/registry.js'
import type { MemoryProvenanceInput } from '../src/core/memory-provenance.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const audience: MemoryAudience = { scope: 'space:current', chatId: 'current-chat', chatType: 'group', openId: 'alice' }
function setup() {
  const registry = new Registry(':memory:')
  cleanup.push(() => registry.close())
  return { registry, db: registry.db, memory: new ChannelMemory(registry.db) }
}
function add(memory: ChannelMemory, extra: Partial<Parameters<ChannelMemory['add']>[0]> = {}) {
  return memory.add({ scope: audience.scope, kind: 'fact', title: 'synthetic note', body: 'synthetic body', ...extra })
}
function session(registry: Registry, key: string, chatId: string, chatType: 'group' | 'p2p' = 'group', requesterOpenId = 'alice') {
  registry.createSession({ sessionKey: key, chatId, chatType, requesterOpenId, cwd: '/synthetic' })
}
function managed(state: 'verified' | 'unavailable'): MemoryProvenanceInput {
  return { state, originRunId: 'host-run', sources: [{ ref: 'source', tenantId: 'tenant', appId: 'app',
    readAt: 1, coverage: 'complete', readIdentity: { kind: 'user', openId: 'alice' }, chatId: audience.chatId }] }
}

describe('memory audience query for the human console', () => {
  it('excludes known old-chat source and real old-session ownership before limit/count', () => {
    const { registry, db, memory } = setup()
    session(registry, 'old-session', 'old-chat')
    session(registry, 'current-session', audience.chatId!)
    const visible = add(memory, { sessionKey: 'current-session', source: { chatId: audience.chatId }, title: 'VISIBLE' })
    db.prepare('UPDATE memory_notes SET created_at=1 WHERE id=?').run(visible.id)
    for (let i = 0; i < 110; i += 1) {
      add(memory, i % 2 ? { source: { chatId: 'old-chat' }, title: 'OLD_CHAT' }
        : { sessionKey: 'old-session', source: { chatId: audience.chatId }, title: 'OLD_SESSION' })
    }
    add(memory, { scope: 'space:unrelated', title: 'UNRELATED' })
    const before = db.prepare('SELECT COUNT(*) n FROM memory_notes').get()
    expect(memory.recent(audience.scope, 1)[0]!.id).not.toBe(visible.id)
    expect(memory.recentForAudience(audience, 1)).toEqual({ items: [{ ...visible, createdAt: 1 }], total: 1 })
    expect(db.prepare('SELECT COUNT(*) n FROM memory_notes').get()).toEqual(before)
  })

  it('does not disclose another user or another channel kind through a DM session with the same chat selector', () => {
    const { registry, memory } = setup()
    const dm: MemoryAudience = { scope: 'space:sp_dm_alice', chatId: 'dm-chat', chatType: 'p2p', openId: 'alice' }
    session(registry, 'mine', 'dm-chat', 'p2p', 'alice')
    session(registry, 'someone-else', 'dm-chat', 'p2p', 'bob')
    session(registry, 'group-kind', 'dm-chat', 'group', 'alice')
    const mine = add(memory, { scope: dm.scope, sessionKey: 'mine' })
    add(memory, { scope: dm.scope, sessionKey: 'someone-else', title: 'OTHER_DM' })
    add(memory, { scope: dm.scope, sessionKey: 'group-kind', title: 'GROUP' })
    expect(memory.recentForAudience(dm)).toEqual({ items: [mine], total: 1 })
    expect(memory.recentForAudience({ ...dm, chatId: null })).toEqual({ items: [], total: 0 })
  })

  it('excludes declared promotion from another scope, including legacy copies', () => {
    const { memory } = setup()
    const local = add(memory, { source: { promotedFrom: audience.scope, chatId: audience.chatId } })
    for (const promotedFrom of ['org', 'circle:old', 'space:other', 'user:bob']) add(memory, { source: { promotedFrom } })
    expect(memory.recentForAudience(audience)).toEqual({ items: [local], total: 1 })
  })

  it('uses real C1 copy ancestry to exclude cross-scope and old-binding sources even if display source is missing', () => {
    const { registry, db, memory } = setup()
    session(registry, 'old-session', 'old-chat')
    const other = add(memory, { scope: 'space:other' })
    const foreignCopy = memory.promote(other.id, 'space:other', audience.scope)!
    const old = add(memory, { sessionKey: 'old-session' })
    const oldCopy = memory.promote(old.id, audience.scope, audience.scope)!
    // A legacy display-field repair does not erase the independently recorded copy ancestry.
    for (const copy of [foreignCopy, oldCopy]) db.prepare('UPDATE memory_notes SET source=NULL,session_key=NULL WHERE id=?').run(copy.id)
    const local = add(memory)
    expect(memory.getProvenance(foreignCopy.id)!.ancestors).toEqual([{ id: other.id, revision: 1 }])
    expect(memory.getProvenance(oldCopy.id)!.ancestors).toEqual([{ id: old.id, revision: 1 }])
    expect(memory.recentForAudience(audience)).toEqual({ items: [local], total: 1 })
  })

  it('retains unknown legacy compatibility without upgrading provenance or trusting claimed by/noteId as a grant', () => {
    const { db, memory } = setup()
    const unknown = add(memory, { sessionKey: 'missing-history', source: { by: 'claimed-person', noteId: 123456 } })
    const absent = add(memory)
    const malformed = add(memory)
    db.prepare('UPDATE memory_notes SET source=? WHERE id=?').run('{old-invalid-json', malformed.id)
    const before = db.prepare('SELECT * FROM memory_provenance ORDER BY note_id').all()
    const result = memory.recentForAudience(audience)
    expect(result.total).toBe(3)
    expect(result.items.map(item => item.id).sort()).toEqual([unknown.id, absent.id, malformed.id].sort())
    expect(db.prepare('SELECT * FROM memory_provenance ORDER BY note_id').all()).toEqual(before)
    expect(result.items.every(item => memory.getProvenance(item.id)?.state === 'legacy_unverified')).toBe(true)
  })

  it('preserves C1 managed-source and live-state exclusions before counting', () => {
    const { memory } = setup()
    add(memory, { title: 'VERIFIED', provenance: managed('verified') })
    add(memory, { title: 'UNAVAILABLE', provenance: managed('unavailable') })
    const old = add(memory)
    const replacement = add(memory, { replaces: old.id })
    const confirmed = add(memory, { status: 'confirmed', confirmation: { by: 'alice', messageId: 'real-host-confirmation', at: 1 } })
    expect(memory.recentForAudience(audience).items.map(item => item.id).sort()).toEqual([replacement.id, confirmed.id].sort())
    expect(memory.recentForAudience(audience).total).toBe(2)
    const copy = memory.promote(confirmed.id, audience.scope, audience.scope)!
    memory.remove(confirmed.id, audience.scope)
    expect(memory.getProvenance(copy.id)?.state).toBe('unavailable')
    expect(memory.recentForAudience(audience)).toEqual({ items: [replacement], total: 1 })
  })

  it('supports a standalone legacy memory store without inventing session evidence, with stable same-time paging', () => {
    const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close())
    const memory = new ChannelMemory(db)
    const first = add(memory, { sessionKey: 'unavailable-old-history' }), second = add(memory)
    add(memory, { source: { chatId: 'foreign-chat' } })
    db.prepare('UPDATE memory_notes SET created_at=1').run()
    expect(memory.recentForAudience(audience, 1)).toEqual({ items: [{ ...second, createdAt: 1 }], total: 2 })
    expect(memory.recentForAudience(audience, 2).items.map(item => item.id)).toEqual([second.id, first.id])
    for (const limit of [0, -1, 1.5, 1001]) expect(() => memory.recentForAudience(audience, limit)).toThrow('1–1000')
  })
})
