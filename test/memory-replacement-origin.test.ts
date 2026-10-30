import { afterEach, describe, expect, it } from 'vitest'
import { ChannelMemory, MemoryOriginConflict, type MemoryAddInput, type MemoryNote } from '../src/core/memory.js'
import { Registry } from '../src/core/registry.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const scope = 'space:replacement-origin'
const ref = ({ id, revision }: MemoryNote) => ({ id, revision })

function fixture() {
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db)
  cleanup.push(() => registry.close())
  const session = (key: string, chatId: string, requesterOpenId = 'alice', chatType: 'group' | 'p2p' = 'group') =>
    registry.createSession({ sessionKey: key, chatId, chatType, requesterOpenId, cwd: '/synthetic' })
  const add = (title: string, extra: Partial<MemoryAddInput> = {}) =>
    memory.add({ scope, kind: 'fact', title, body: `${title} synthetic body`, ...extra })
  const snapshot = () => ['memory_notes', 'memory_provenance', 'memory_changes', 'memory_tombstones', 'sqlite_sequence']
    .map(table => registry.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
  const visible = (chatId: string) => memory.recentForAudience({ scope, chatId, chatType: 'group', openId: 'alice' }).items.map(note => note.id)
  return { registry, memory, session, add, snapshot, visible }
}

describe('replacement preserves material origin while dropping obsolete version dependencies', () => {
  it('keeps a rebound Space correction out of the new chat while separately auditing the current message', () => {
    const t = fixture()
    t.session('old', 'chat-old'); t.session('new', 'chat-new')
    const old = t.add('old source', { sessionKey: 'old', source: { chatId: 'chat-old', promotedFrom: scope } })
    expect(t.visible('chat-new')).toEqual([])
    const corrected = t.add('corrected', { sessionKey: 'new', source: { chatId: 'chat-new', promotedFrom: 'forged-new-origin',
      by: 'alice', messageId: 'om-correction', generatedBy: 'model' }, replaces: old.id, derivedFrom: [old] })
    expect(corrected.sessionKey).toBe('old')
    expect(corrected.source).toMatchObject({ chatId: 'chat-old', promotedFrom: scope, replaces: old.id,
      correction: { sessionKey: 'new', chatId: 'chat-new', by: 'alice', messageId: 'om-correction', generatedBy: 'model' } })
    expect(t.memory.getProvenance(corrected.id)?.ancestors).toEqual([])
    expect(t.visible('chat-new')).toEqual([])
    expect(t.visible('chat-old')).toEqual([corrected.id])
    expect(t.memory.get(old.id)).toMatchObject({ status: 'superseded', supersededBy: corrected.id })
  })

  it('rejects discarding a foreign-session QA even when the replaced claim itself belongs to the current chat', () => {
    const t = fixture()
    t.session('old', 'chat-old'); t.session('new', 'chat-new')
    const target = t.add('current claim', { sessionKey: 'new' })
    const qa = t.add('foreign answer', { sessionKey: 'old', kind: 'qa', derivedFrom: [target] })
    const before = t.snapshot()
    expect(() => t.add('must not become local', { sessionKey: 'new', replaces: target.id,
      derivedFrom: [target, qa] })).toThrow(MemoryOriginConflict)
    expect(t.snapshot()).toEqual(before)
    expect(t.visible('chat-new')).toEqual([target.id])
  })

  it.each(['chatId', 'promotedFrom'] as const)('does not discard a known different %s label hidden in downstream lineage', key => {
    const t = fixture(), target = t.add('claim', { source: { [key]: 'origin-a' } })
    const qa = t.add('answer', { kind: 'qa', source: { [key]: 'origin-b' }, derivedFrom: [target] })
    const before = t.snapshot()
    expect(() => t.add('correction', { replaces: target.id, derivedFrom: [qa] })).toThrow(MemoryOriginConflict)
    expect(t.snapshot()).toEqual(before)
  })

  it('keeps missing legacy metadata missing rather than claiming the correction Run proves an origin', () => {
    const t = fixture()
    t.session('current', 'chat-current')
    const target = t.add('legacy')
    const corrected = t.add('correction', { sessionKey: 'current', source: { chatId: 'chat-current', promotedFrom: scope,
      messageId: 'om-current' }, replaces: target.id, derivedFrom: [target] })
    expect(corrected.sessionKey).toBeNull()
    expect(corrected.source).not.toHaveProperty('chatId')
    expect(corrected.source).not.toHaveProperty('promotedFrom')
    expect(corrected.source?.correction).toMatchObject({ sessionKey: 'current', chatId: 'chat-current', messageId: 'om-current' })
    expect(t.memory.getProvenance(corrected.id)).toMatchObject({ state: 'legacy_unverified', sources: [], ancestors: [] })
  })

  it('cannot discard a known downstream origin into a target with unknown legacy provenance', () => {
    const t = fixture(), target = t.add('legacy')
    const qa = t.add('known-source answer', { source: { chatId: 'known-chat' }, derivedFrom: [target] })
    const before = t.snapshot()
    expect(() => t.add('correction', { replaces: target.id, derivedFrom: [qa] })).toThrow(MemoryOriginConflict)
    expect(t.snapshot()).toEqual(before)
  })

  it('permits the same real group across Sessions/requesters and retains an independent cross-scope ancestor', () => {
    const t = fixture()
    t.session('first', 'chat-same', 'alice'); t.session('second', 'chat-same', 'bob')
    const target = t.add('claim', { sessionKey: 'first' }), independent = t.add('org fact', { scope: 'org' })
    const qa = t.add('answer', { sessionKey: 'second', kind: 'qa', derivedFrom: [target, independent] })
    const corrected = t.add('correction', { sessionKey: 'second', replaces: target.id, derivedFrom: [qa] })
    expect(corrected.sessionKey).toBe('first')
    expect(t.memory.getProvenance(corrected.id)?.ancestors).toEqual([ref(independent)])
    expect(t.memory.get(qa.id)).toBeUndefined()
    t.memory.remove(independent.id, 'org')
    expect(t.memory.get(corrected.id)).toBeUndefined()
  })

  it.each(['owner', 'type'] as const)('does not collapse a different real private audience (%s)', difference => {
    const t = fixture()
    t.session('first', 'chat-same', 'alice', 'p2p')
    t.session('second', 'chat-same', difference === 'owner' ? 'bob' : 'alice', difference === 'type' ? 'group' : 'p2p')
    const target = t.add('claim', { sessionKey: 'first' }), qa = t.add('answer', { sessionKey: 'second', derivedFrom: [target] })
    const before = t.snapshot()
    expect(() => t.add('correction', { replaces: target.id, derivedFrom: [qa] })).toThrow(MemoryOriginConflict)
    expect(t.snapshot()).toEqual(before)
  })

  it('does not collapse a downstream copy from a different scope', () => {
    const t = fixture(), target = t.add('claim'), copy = t.memory.promote(target.id, scope, 'org')!
    const before = t.snapshot()
    expect(() => t.add('correction', { replaces: target.id, derivedFrom: [target, copy] })).toThrow(MemoryOriginConflict)
    expect(t.snapshot()).toEqual(before)
  })

  it('keeps the same origin through real confirmation and a further replacement', () => {
    const t = fixture()
    t.session('old', 'chat-old'); t.session('new', 'chat-new')
    const old = t.add('confirmed original', { sessionKey: 'old', status: 'confirmed',
      confirmation: { by: 'alice', messageId: 'om-original', at: 1 }, source: { chatId: 'chat-old' } })
    const corrected = t.add('candidate correction', { sessionKey: 'new', source: { chatId: 'chat-new' }, replaces: old.id })
    expect(t.memory.get(old.id)?.status).toBe('confirmed')
    expect(t.memory.confirm(corrected.id, scope, { by: 'alice', messageId: 'om-confirm', expectedRevision: corrected.revision })).toBe(true)
    const next = t.add('next correction', { sessionKey: 'new', source: { chatId: 'chat-new' }, replaces: corrected.id })
    expect(next.sessionKey).toBe('old')
    expect(next.source?.chatId).toBe('chat-old')
    expect(t.visible('chat-new')).toEqual([])
  })
})
