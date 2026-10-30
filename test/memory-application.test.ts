import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MemoryRevisionConflict } from '../src/core/memory-provenance.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RuntimeContexts } from '../src/core/runtime-contexts.js'
import { MemoryApplication } from '../src/core/memory-application.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
function fixture() {
  const registry = new Registry(':memory:'), db = registry.db, memory = new ChannelMemory(db), attempts = new RunAttempts(db), contexts = new RuntimeContexts(db)
  cleanup.push(() => registry.close())
  const persist = vi.fn((ids: readonly string[]) => {
    for (const id of ids) {
      const run = attempts.get(id)!
      expect(run.state).toBe('stop_requested')
      if (run.taskId) db.prepare("UPDATE tasks SET stop_reason='memory_context_invalidated' WHERE id=?").run(run.taskId)
    }
  })
  const app = new MemoryApplication(db, memory, contexts, attempts, { persistInvalidatedRuns: persist })
  let serial = 0
  const run = (refs: { id: number; revision: number }[]) => {
    const sessionKey = `s-${++serial}`, acpId = `acp-${serial}`
    registry.createSession({ sessionKey, chatId: sessionKey, chatType: 'group', cwd: '/synthetic', requesterOpenId: 'alice' })
    const task = registry.createTask({ sessionKey, messageId: `om-${serial}`, prompt: 'synthetic', requesterOpenId: 'alice' })
    const r = attempts.begin({ workKey: `task:${task.id}`, sessionKey, triggerKey: `task:${task.id}`, stage: 'task', taskId: task.id, actorOpenId: 'alice', now: serial }, () => registry.startTask(task.id, serial, sessionKey))!
    attempts.bindRuntime(r.id, acpId); contexts.bind(r.id, sessionKey, acpId); contexts.recordRead(r.id, refs)
    return r
  }
  const add = (body = 'synthetic original') => app.add({ scope: 'space:a', kind: 'fact', title: 'synthetic', body }).value
  const snapshot = () => ['memory_notes','memory_provenance','memory_changes','memory_tombstones','runtime_contexts','run_contexts','run_attempts','tasks']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
  return { registry, db, memory, attempts, contexts, app, persist, run, add, snapshot }
}

describe('atomic memory application and exact durable Run invalidation', () => {
  it('new notes, copies and idempotent writes do not invalidate unrelated contexts or invent stop effects', () => {
    const t = fixture(), original = t.add(), run = t.run([original])
    expect(t.app.add({ scope: 'space:other', kind: 'fact', title: original.title, body: original.body }).invalidatedRunIds).toEqual([])
    const copy = t.app.promote(original.id, original.scope, 'org', 'alice')
    expect(copy.invalidatedRunIds).toEqual([])
    expect(t.app.promote(original.id, original.scope, 'org', 'alice').value?.id).toBe(copy.value?.id)
    expect(t.app.remove(99999, original.scope)).toEqual({ value: false, invalidatedRunIds: [] })
    expect(t.contexts.isEligible(run.id, true)).toBe(true)
    expect(t.attempts.get(run.id)?.state).toBe('running')
    expect(t.persist).not.toHaveBeenCalled()
  })

  it('confirmation stops only actual old-revision consumers and runs the persistence hook before returning exact IDs', () => {
    const t = fixture(), note = t.add(), other = t.add('other'), affected = t.run([note]), untouched = t.run([other])
    const result = t.app.confirm(note.id, note.scope, { by: 'alice', messageId: 'om-confirm', expectedRevision: 1 })
    expect(result).toEqual({ value: true, invalidatedRunIds: [affected.id] })
    expect(t.memory.get(note.id)).toMatchObject({ revision: 2, status: 'confirmed' })
    expect(t.attempts.get(affected.id)).toMatchObject({ state: 'stop_requested', stopReason: 'memory_context_invalidated' })
    expect(t.registry.getTask(affected.taskId!)?.stopReason).toBe('memory_context_invalidated')
    expect(t.attempts.get(untouched.id)?.state).toBe('running')
    expect(t.persist).toHaveBeenCalledExactlyOnceWith([affected.id])
    const after = t.snapshot()
    expect(t.app.confirm(note.id, note.scope, { by: 'alice', messageId: 'another-proof', expectedRevision: 2 }).value).toBe(false)
    expect(t.snapshot()).toEqual(after)
  })

  it('a candidate correction does not withdraw a confirmed fact until real confirmation, then invalidates both consumed revisions', () => {
    const t = fixture(), old = t.app.add({ scope: 'space:a', kind: 'rule', title: 'original', body: 'old wording', status: 'confirmed', confirmation: { by: 'alice', messageId: 'human-proof', at: 10 } }).value
    const oldRun = t.run([old])
    const correction = t.app.add({ scope: old.scope, kind: 'rule', title: 'correction', body: 'new wording', replaces: old.id, expectedRevision: 1 })
    expect(correction.invalidatedRunIds).toEqual([])
    expect(t.memory.get(old.id)?.status).toBe('confirmed')
    const candidateRun = t.run([correction.value])
    const result = t.app.confirm(correction.value.id, old.scope, { by: 'alice', messageId: 'real-new-proof' })
    expect(result.invalidatedRunIds).toEqual([oldRun.id, candidateRun.id].sort())
    expect(t.memory.get(old.id)).toMatchObject({ status: 'superseded', supersededBy: correction.value.id })
    expect(t.memory.rules(old.scope).map(n => n.id)).toEqual([correction.value.id])
  })

  it('forgetting invalidates genuine copies in other scopes and removes the body without touching other contexts', () => {
    const t = fixture(), original = t.add('FORGET_BODY'), copy = t.app.promote(original.id, original.scope, 'org').value!
    const direct = t.run([original]), copied = t.run([copy]), unrelated = t.run([t.add('unrelated')])
    expect(t.app.remove(original.id, original.scope, { expectedRevision: 1 })).toEqual({ value: true, invalidatedRunIds: [direct.id, copied.id].sort() })
    expect(t.memory.get(original.id)).toBeUndefined()
    expect(t.memory.get(copy.id)).toBeUndefined()
    expect(t.memory.getProvenance(copy.id)?.state).toBe('unavailable')
    expect(t.attempts.get(unrelated.id)?.state).toBe('running')
    expect(JSON.stringify([t.memory.getTombstone(original.id), t.contexts.contextForRun(direct.id)])).not.toContain('FORGET_BODY')
  })

  it('rolls memory, journal, context, stop request and host Task write back together when the persistence hook fails', () => {
    const t = fixture(), note = t.add(), run = t.run([note]), before = t.snapshot()
    t.persist.mockImplementation(ids => {
      expect(ids).toEqual([run.id])
      expect(t.attempts.get(run.id)?.state).toBe('stop_requested')
      t.db.prepare("UPDATE tasks SET stop_reason='memory_context_invalidated' WHERE id=?").run(run.taskId!)
      throw new Error('synthetic occurrence write failure')
    })
    expect(() => t.app.remove(note.id, note.scope)).toThrow('synthetic occurrence write failure')
    expect(t.snapshot()).toEqual(before)
    expect(t.contexts.canResume(run.sessionKey, `acp-1`)).toBe(true)
  })

  it('rolls back a context storage failure and stale CAS, without notifying the host of an uncommitted change', () => {
    const t = fixture(), note = t.add(), run = t.run([note]), before = t.snapshot()
    t.db.exec("CREATE TRIGGER fail_context BEFORE UPDATE ON runtime_contexts BEGIN SELECT RAISE(ABORT, 'context disk fault'); END")
    expect(() => t.app.remove(note.id, note.scope)).toThrow('context disk fault')
    expect(t.snapshot()).toEqual(before)
    expect(t.persist).not.toHaveBeenCalled()
    t.db.exec('DROP TRIGGER fail_context')
    expect(() => t.app.confirm(note.id, note.scope, { by: 'alice', messageId: 'proof', expectedRevision: 99 })).toThrow(MemoryRevisionConflict)
    expect(t.snapshot()).toEqual(before)
    expect(t.attempts.get(run.id)?.state).toBe('running')
  })

  it('does not commit an outer application transaction or abort anything by itself', () => {
    const t = fixture(), note = t.add(), run = t.run([note]), before = t.snapshot()
    t.db.exec('BEGIN')
    expect(t.app.remove(note.id, note.scope).invalidatedRunIds).toEqual([run.id])
    expect(t.contexts.isEligible(run.id, true)).toBe(false)
    t.db.exec('ROLLBACK')
    expect(t.snapshot()).toEqual(before)
  })

  it('preserves an existing explicit stop reason while invalidating that still-active context', () => {
    const t = fixture(), note = t.add(), run = t.run([note])
    t.attempts.requestStop(run.id, 'user_requested')
    expect(t.app.remove(note.id, note.scope).invalidatedRunIds).toEqual([run.id])
    expect(t.attempts.get(run.id)?.stopReason).toBe('user_requested')
  })
})
