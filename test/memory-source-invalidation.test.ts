import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelMemory, type MemoryNote, type MemorySourceSelector } from '../src/core/memory.js'
import { MemoryRevisionConflict, type MemorySourceReference } from '../src/core/memory-provenance.js'
import { MemoryRuntime } from '../src/core/memory-runtime.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const source = (patch: Partial<MemorySourceReference> = {}): MemorySourceReference => ({
  ref: 'synthetic-source', appId: 'app-a', tenantId: 'tenant-a', spaceId: 'source-space-a', chatId: 'chat-a',
  messageId: 'message-a', readIdentity: { kind: 'user', openId: 'alice' }, readAt: 1, coverage: 'complete', ...patch,
})

function fixture() {
  const registry = new Registry(':memory:'), db = registry.db, memory = new ChannelMemory(db), attempts = new RunAttempts(db)
  cleanup.push(() => registry.close())
  const handles = new Map<string, ReturnType<typeof vi.fn>>()
  const runtime = new MemoryRuntime({ registry, memory, attempts, now: () => 100,
    activeRun: id => handles.has(id) ? { runId: id, abort: handles.get(id)! } : undefined })
  const add = (sources: MemorySourceReference[] = [source()]) => memory.add({ scope: 'space:sp_dm_alice', kind: 'fact',
    title: 'SOURCE_TITLE_CANARY', body: 'SOURCE_BODY_CANARY', provenance: { state: 'verified', originRunId: 'synthetic-origin', sources } })
  let serial = 0
  const consumed = (note: MemoryNote) => {
    const sessionKey = `session-${++serial}`, acpId = `acp-${serial}`
    registry.createSession({ sessionKey, chatId: 'chat-dm', chatType: 'p2p', requesterOpenId: 'alice', cwd: '/synthetic' })
    const task = registry.createTask({ sessionKey, messageId: `message-${serial}`, requesterOpenId: 'alice', prompt: 'synthetic' })
    const run = attempts.begin({ workKey: `task:${task.id}`, triggerKey: `task:${task.id}`, sessionKey, taskId: task.id,
      stage: 'task', actorOpenId: 'alice', now: serial }, () => registry.startTask(task.id, serial, sessionKey))!
    attempts.bindRuntime(run.id, acpId); runtime.contexts.bind(run.id, sessionKey, acpId)
    // This slice does not open managed reads. Seed an already-consumed exact version only
    // to verify durable invalidation; this fixture is not authorization/managed-read coverage.
    db.prepare('UPDATE runtime_contexts SET notes_json=? WHERE acp_id=?').run(JSON.stringify([{ id: note.id, revision: note.revision }]), acpId)
    const abort = vi.fn(); handles.set(run.id, abort)
    return { ...run, abort }
  }
  const raw = (id: number) => db.prepare('SELECT * FROM memory_notes WHERE id=?').get(id)
  const snapshot = () => ['memory_notes', 'memory_provenance', 'memory_changes', 'memory_tombstones',
    'runtime_contexts', 'run_contexts', 'run_attempts', 'tasks', 'sqlite_sequence']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
  return { registry, db, memory, attempts, runtime, add, consumed, raw, snapshot }
}

describe('known source loss is a precise, atomic memory operation', () => {
  it('matches the real reading user, not another user, app identity, or a legacy claimed source', () => {
    const t = fixture(), exact = t.add(), other = t.add([source({ readIdentity: { kind: 'user', openId: 'bob' } })])
    const app = t.add([source({ readIdentity: { kind: 'app' } })])
    const legacy = t.memory.add({ scope: 'space:sp_dm_alice', kind: 'fact', title: 'legacy', body: 'legacy',
      source: { by: 'alice', readIdentity: { kind: 'user', openId: 'alice' }, messageId: 'message-a' } })
    expect(t.memory.invalidateSources({ kind: 'user', openId: 'alice' })).toEqual([exact.id])
    expect(t.memory.getProvenance(exact.id)?.state).toBe('unavailable')
    for (const note of [other, app]) expect(t.memory.getProvenance(note.id)?.state).toBe('verified')
    expect(t.memory.get(legacy.id)).toEqual(legacy)
    expect(t.raw(exact.id)).toMatchObject({ revision: 2, title: exact.title, body: exact.body, status: 'candidate' })
  })

  it('matches the original source Space rather than the target scope or a same-chat unbound source', () => {
    const t = fixture(), exact = t.add(), other = t.add([source({ spaceId: 'source-space-b' })])
    const unbound = t.add([source({ spaceId: null })])
    expect(t.memory.invalidateSources({ kind: 'space', spaceId: 'space:sp_dm_alice' })).toEqual([])
    expect(t.memory.invalidateSources({ kind: 'space', spaceId: 'source-space-a' })).toEqual([exact.id])
    for (const note of [other, unbound]) expect(t.memory.getProvenance(note.id)?.state).toBe('verified')
  })

  it('invalidates only exact denied notes and their descendants, not the user\'s other materials', () => {
    const t = fixture(), denied = t.add(), copy = t.memory.promote(denied.id, denied.scope, 'org')!
    const other = t.add(), run = t.consumed(denied), copiedRun = t.consumed(copy), otherRun = t.consumed(other)
    expect(t.runtime.invalidateSources({ kind: 'notes', refs: [{ id: denied.id, revision: 1 }] })).toEqual([denied.id, copy.id])
    expect(t.memory.getProvenance(other.id)?.state).toBe('verified')
    expect(t.raw(other.id)).toMatchObject({ revision: 1 })
    expect(run.abort).toHaveBeenCalledOnce(); expect(copiedRun.abort).toHaveBeenCalledOnce()
    expect(otherRun.abort).not.toHaveBeenCalled()
    const before = t.snapshot()
    expect(t.memory.invalidateSources({ kind: 'notes', refs: [{ id: denied.id, revision: 2 }] })).toEqual([])
    expect(t.snapshot()).toEqual(before)
  })

  it.each(['newer', 'missing', 'legacy'] as const)('rejects an entire denial batch on a %s ref before any write or abort', mode => {
    const t = fixture(), valid = t.add(), changed = mode === 'legacy'
      ? t.memory.add({ scope: valid.scope, kind: 'fact', title: 'legacy', body: 'legacy' }) : t.add()
    if (mode === 'newer') t.memory.confirm(changed.id, changed.scope, { by: 'alice', messageId: 'om', at: 1 })
    if (mode === 'missing') t.memory.remove(changed.id, changed.scope)
    const run = t.consumed(valid), before = t.snapshot()
    expect(() => t.runtime.invalidateSources({ kind: 'notes', refs: [{ id: valid.id, revision: 1 }, { id: changed.id, revision: 1 }] }))
      .toThrow(MemoryRevisionConflict)
    expect(t.snapshot()).toEqual(before)
    expect(run.abort).not.toHaveBeenCalled()
  })

  it('does not abort or retain exact-note invalidation when the host outer transaction rolls back', () => {
    const t = fixture(), note = t.add(), run = t.consumed(note), before = t.snapshot()
    t.db.exec('BEGIN')
    const result = t.runtime.application.invalidateSources({ kind: 'notes', refs: [{ id: note.id, revision: 1 }] })
    expect(result.invalidatedRunIds).toEqual([run.id])
    t.db.exec('ROLLBACK')
    expect(t.snapshot()).toEqual(before); expect(run.abort).not.toHaveBeenCalled()
  })

  it('requires app, chat and message to match together, including in a multi-source note', () => {
    const t = fixture(), exact = t.add([source({ chatId: 'other-chat', messageId: 'other-message' }), source()])
    const otherApp = t.add([source({ appId: 'app-b' })]), otherChat = t.add([source({ chatId: 'chat-b' })])
    const otherMessage = t.add([source({ messageId: 'message-b' })]), missingMessage = t.add([source({ messageId: undefined })])
    const originalSources = t.memory.getProvenance(exact.id)!.sources
    expect(t.memory.invalidateSources({ kind: 'message', appId: 'app-a', chatId: 'chat-a', messageId: 'message-a' })).toEqual([exact.id])
    expect(t.memory.getProvenance(exact.id)).toMatchObject({ state: 'unavailable', sources: originalSources })
    for (const note of [otherApp, otherChat, otherMessage, missingMessage]) expect(t.memory.getProvenance(note.id)?.state).toBe('verified')
  })

  it('invalidates all real descendants once and is idempotent across reconstruction and different matching events', () => {
    const t = fixture(), original = t.add()
    const copy = t.memory.promote(original.id, original.scope, 'org')!, nested = t.memory.promote(copy.id, 'org', 'circle:synthetic')!
    expect(t.memory.invalidateSources({ kind: 'user', openId: 'alice' })).toEqual([original.id, copy.id, nested.id])
    for (const note of [original, copy, nested]) {
      expect(t.raw(note.id)).toMatchObject({ revision: 2, body: note.body })
      expect(t.memory.getProvenance(note.id)?.state).toBe('unavailable')
    }
    const before = t.snapshot(), reopened = new ChannelMemory(t.db)
    expect(reopened.invalidateSources({ kind: 'space', spaceId: 'source-space-a' })).toEqual([])
    expect(reopened.invalidateSources({ kind: 'user', openId: 'alice' })).toEqual([])
    expect(t.snapshot()).toEqual(before)
    const changes = t.memory.changes().filter(change => change.operation === 'source_unavailable')
    expect(changes.map(change => change.noteId).sort((a, b) => a - b)).toEqual([original.id, copy.id, nested.id])
    expect(JSON.stringify(changes)).not.toMatch(/SOURCE_(TITLE|BODY)_CANARY/)
  })

  it('persists only actual consumer stops and defers abort until the outer transaction has committed', () => {
    const t = fixture(), original = t.add(), copy = t.memory.promote(original.id, original.scope, 'org')!
    const independent = t.add([source({ readIdentity: { kind: 'user', openId: 'bob' } })])
    const direct = t.consumed(original), copied = t.consumed(copy), other = t.consumed(independent)
    t.db.exec('BEGIN')
    const result = t.runtime.application.invalidateSources({ kind: 'user', openId: 'alice' })
    expect(result.value).toEqual([original.id, copy.id])
    expect(result.invalidatedRunIds).toEqual([direct.id, copied.id].sort())
    for (const run of [direct, copied]) {
      expect(t.attempts.get(run.id)).toMatchObject({ state: 'stop_requested', stopReason: 'memory_context_invalidated' })
      expect(t.registry.getTask(run.taskId!)?.stopReason).toBe('memory_context_invalidated')
      expect(t.runtime.contexts.contextForRun(run.id)?.state).toBe('invalidated')
      expect(run.abort).not.toHaveBeenCalled()
    }
    expect(t.attempts.get(other.id)?.state).toBe('running')
    t.db.exec('COMMIT')
    expect(t.runtime.complete(result)).toEqual([original.id, copy.id])
    expect(direct.abort).toHaveBeenCalledOnce(); expect(copied.abort).toHaveBeenCalledOnce()
    expect(other.abort).not.toHaveBeenCalled()
    expect(t.runtime.invalidateSources({ kind: 'user', openId: 'alice' })).toEqual([])
    expect(direct.abort).toHaveBeenCalledOnce()
  })

  it('does not overwrite an existing user stop reason or issue a second abort for it', () => {
    const t = fixture(), note = t.add(), run = t.consumed(note)
    t.attempts.requestStop(run.id, 'user_requested'); t.registry.requestStop(run.taskId!, 'user_requested')
    expect(t.runtime.invalidateSources({ kind: 'user', openId: 'alice' })).toEqual([note.id])
    expect(t.attempts.get(run.id)?.stopReason).toBe('user_requested')
    expect(t.registry.getTask(run.taskId!)?.stopReason).toBe('user_requested')
    expect(t.runtime.contexts.contextForRun(run.id)?.state).toBe('invalidated')
    expect(run.abort).not.toHaveBeenCalled()
  })

  it('rolls note versions, lineage, journal, contexts and task/run stops back on a late persistent failure', () => {
    const t = fixture(), note = t.add(), run = t.consumed(note), before = t.snapshot()
    t.db.exec("CREATE TRIGGER fail_source_stop BEFORE UPDATE OF stop_reason ON tasks BEGIN SELECT RAISE(ABORT, 'synthetic stop failure'); END")
    expect(() => t.runtime.invalidateSources({ kind: 'user', openId: 'alice' })).toThrow('synthetic stop failure')
    expect(t.snapshot()).toEqual(before)
    expect(run.abort).not.toHaveBeenCalled()
  })

  it('does not commit an outer transaction or abort any execution on caller rollback', () => {
    const t = fixture(), note = t.add(), run = t.consumed(note), before = t.snapshot()
    t.db.exec('BEGIN')
    expect(t.runtime.application.invalidateSources({ kind: 'space', spaceId: 'source-space-a' }).invalidatedRunIds).toEqual([run.id])
    t.db.exec('ROLLBACK')
    expect(t.snapshot()).toEqual(before)
    expect(run.abort).not.toHaveBeenCalled()
  })

  it('keeps unverified and managed reads closed; this operation only records known loss', () => {
    const t = fixture(), note = t.add(), before = t.snapshot()
    expect(t.memory.get(note.id)).toBeUndefined()
    expect(t.memory.search(note.scope, '')).toEqual([])
    // A temporary platform failure has no selector/event to apply and must leave persistence alone.
    expect(t.snapshot()).toEqual(before)
    expect(t.memory.invalidateSources({ kind: 'message', appId: 'app-a', chatId: 'chat-a', messageId: 'unknown-message' })).toEqual([])
    expect(t.snapshot()).toEqual(before)
  })

  it.each([
    { kind: 'user', openId: '' }, { kind: 'space', spaceId: ' ' },
    { kind: 'message', appId: 'app-a', chatId: '', messageId: 'message-a' }, { kind: 'unknown' },
  ])('rejects an incomplete selector before any write: $kind', selector => {
    const t = fixture(); t.add(); const before = t.snapshot()
    expect(() => t.memory.invalidateSources(selector as MemorySourceSelector)).toThrow()
    expect(t.snapshot()).toEqual(before)
  })
})
