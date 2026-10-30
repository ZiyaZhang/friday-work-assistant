import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelMemory } from '../src/core/memory.js'
import { MemoryRuntime } from '../src/core/memory-runtime.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'

const registries: Registry[] = []
afterEach(() => { for (const registry of registries.splice(0)) registry.close() })
function setup() {
  const registry = new Registry(':memory:'); registries.push(registry)
  const memory = new ChannelMemory(registry.db), attempts = new RunAttempts(registry.db), abort = vi.fn()
  const runtime = new MemoryRuntime({ registry, memory, attempts, now: () => 100, activeRun: runId => ({ runId, abort }) })
  registry.createSession({ sessionKey: 'same-work', chatId: 'group', chatType: 'group', cwd: '/synthetic', requesterOpenId: 'alice' })
  const task = registry.createTask({ sessionKey: 'same-work', messageId: 'message', prompt: 'synthetic' })
  const run = attempts.begin({ workKey: `task:${task.id}`, sessionKey: 'same-work', triggerKey: `task:${task.id}`, stage: 'task', taskId: task.id,
    actorOpenId: 'alice', now: 1 }, () => registry.startTask(task.id, 1, 'same-work'))!
  attempts.bindRuntime(run.id, 'acp'); runtime.contexts.bind(run.id, 'same-work', 'acp')
  const note = runtime.add({ scope: 'space:a', kind: 'fact', title: 'Synthetic note', body: 'Synthetic body' })
  runtime.recordRead(run.id, [note])
  return { registry, memory, attempts, runtime, abort, task, run, note }
}

describe('memory commit to live Run cleanup', () => {
  it('keeps generated QA linked to consumed memory and stops a later QA-only consumer when the source is forgotten', () => {
    const t = setup()
    const answer = t.runtime.addDerived(t.run.id, { scope: t.note.scope, kind: 'qa', title: '回答', body: '旧称呼是轻舟',
      source: { generatedBy: 'automatic_qa' } })
    expect(t.memory.getProvenance(answer.id)?.ancestors).toEqual([{ id: t.note.id, revision: 1 }])
    t.attempts.finish(t.run.id, 'completed', 2)
    const next = t.attempts.begin({ workKey: 'same-work', sessionKey: 'same-work', triggerKey: 'next', stage: 'task', now: 3 })!
    t.attempts.bindRuntime(next.id, 'next-acp'); t.runtime.contexts.bind(next.id, 'same-work', 'next-acp')
    t.runtime.recordRead(next.id, [answer])
    expect(t.runtime.remove(t.note.id, t.note.scope)).toBe(true)
    expect(t.memory.search(t.note.scope, '轻舟')).toEqual([])
    expect(t.memory.getProvenance(answer.id)?.state).toBe('unavailable')
    expect(t.attempts.get(next.id)).toMatchObject({ state: 'stop_requested', stopReason: 'memory_context_invalidated' })
    expect(t.runtime.contexts.canResume('same-work', 'next-acp')).toBe(false)
  })

  it('replaces an old claim without making its new correction depend on that claim or the old QA', () => {
    const t = setup()
    const answer = t.runtime.addDerived(t.run.id, { scope: t.note.scope, kind: 'qa', title: '称呼', body: '轻舟' })
    const other = t.runtime.add({ scope: t.note.scope, kind: 'fact', title: '语言', body: '中文' })
    t.runtime.recordRead(t.run.id, [answer, other])
    const correction = t.runtime.addDerived(t.run.id, { scope: t.note.scope, kind: 'profile', title: '称呼', body: '远山', replaces: t.note.id })
    expect(t.memory.get(correction.id)).toMatchObject({ status: 'candidate', body: '远山' })
    expect(t.memory.getProvenance(correction.id)?.ancestors).toEqual([{ id: other.id, revision: 1 }])
    expect(t.memory.get(answer.id)).toBeUndefined()
    expect(t.memory.search(t.note.scope, '轻舟')).toEqual([])
    expect(t.memory.search(t.note.scope, '远山').map(note => note.id)).toEqual([correction.id])
  })

  it('rejects derived writes after stop and rolls back stale dependency writes without fabricated ancestry', () => {
    const t = setup()
    const before = t.memory.changes()
    expect(() => t.memory.add({ scope: t.note.scope, kind: 'fact', title: 'stale', body: 'stale',
      derivedFrom: [{ id: t.note.id, revision: 9 }] })).toThrow(/版本已变化/)
    expect(t.memory.changes()).toEqual(before)
    t.attempts.requestStop(t.run.id, 'user_requested')
    expect(() => t.runtime.addDerived(t.run.id, { scope: t.note.scope, kind: 'qa', title: 'late', body: 'late' })).toThrow()
    expect(t.memory.changes()).toEqual(before)
  })

  it('preserves an earlier user stop on both Task and Run when forgetting before its signal callback', () => {
    const t = setup()
    t.attempts.requestStop(t.run.id, 'user_requested'); t.registry.requestStop(t.task.id, 'user_requested')
    expect(t.runtime.remove(t.note.id, t.note.scope)).toBe(true)
    expect(t.registry.getTask(t.task.id)?.stopReason).toBe('user_requested')
    expect(t.attempts.get(t.run.id)?.stopReason).toBe('user_requested')
    expect(t.runtime.contexts.isEligible(t.run.id, true)).toBe(false)
    expect(t.abort).not.toHaveBeenCalled()
  })

  it('persists context and stop before aborting; application operations inside outer transactions do not abort', () => {
    const t = setup()
    t.registry.db.exec('BEGIN')
    t.runtime.application.remove(t.note.id, t.note.scope)
    expect(t.abort).not.toHaveBeenCalled()
    expect(t.registry.getTask(t.task.id)?.stopReason).toBe('memory_context_invalidated')
    t.registry.db.exec('ROLLBACK')
    expect(t.runtime.contexts.isEligible(t.run.id, true)).toBe(true)
    expect(t.memory.get(t.note.id)).toBeDefined()
    t.abort.mockImplementation(() => {
      expect(t.runtime.contexts.isEligible(t.run.id, true)).toBe(false)
      expect(t.registry.getTask(t.task.id)?.stopReason).toBe('memory_context_invalidated')
      expect(t.memory.get(t.note.id)).toBeUndefined()
    })
    expect(t.runtime.remove(t.note.id, t.note.scope)).toBe(true)
    expect(t.abort).toHaveBeenCalledTimes(1)
  })
})
