import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RuntimeContextError, RuntimeContexts } from '../src/core/runtime-contexts.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-runtime-context-')), path = join(dir, 'db')
  let registry = new Registry(path), memory = new ChannelMemory(registry.db), attempts = new RunAttempts(registry.db), contexts = new RuntimeContexts(registry.db, () => 1000)
  cleanup.push(() => { registry.close(); rmSync(dir, { recursive: true, force: true }) })
  let serial = 0
  const run = (sessionKey = 'session-a', acpId?: string) => {
    if (!registry.getSession(sessionKey)) registry.createSession({ sessionKey, chatId: sessionKey, chatType: 'group', cwd: dir, requesterOpenId: 'alice' })
    const task = registry.createTask({ sessionKey, messageId: `om-${++serial}`, prompt: 'synthetic request', requesterOpenId: 'alice' })
    const result = attempts.begin({ workKey: `task:${task.id}`, sessionKey, triggerKey: `task:${task.id}`, stage: 'task', taskId: task.id, actorOpenId: 'alice', now: serial }, () => registry.startTask(task.id, serial, sessionKey))!
    if (acpId) attempts.bindRuntime(result.id, acpId)
    return result
  }
  return { get db() { return registry.db }, get memory() { return memory }, get attempts() { return attempts }, get contexts() { return contexts }, run,
    note: () => memory.add({ scope: 'space:a', kind: 'fact', title: 'PRIVATE_TITLE', body: 'PRIVATE_BODY' }),
    reopen() { registry.close(); registry = new Registry(path); memory = new ChannelMemory(registry.db); attempts = new RunAttempts(registry.db); contexts = new RuntimeContexts(registry.db, () => 1000) } }
}

describe('durable actual memory consumption by ACP context', () => {
  it('rejects unknown old ACP while allowing an unbound preparation Run, then preserves accumulated refs across reopen and later Runs', () => {
    const t = fixture(), first = t.run(), a = t.note(), b = t.note()
    expect(t.contexts.canResume('session-a', 'legacy-acp')).toBe(false)
    expect(t.contexts.isEligible('missing-run')).toBe(false)
    expect(t.contexts.isEligible(first.id)).toBe(true)
    expect(t.contexts.isEligible(first.id, true)).toBe(false)
    expect(() => t.contexts.bind(first.id, 'session-a', 'fresh')).toThrow(RuntimeContextError)
    t.attempts.bindRuntime(first.id, 'fresh')
    t.contexts.bind(first.id, 'session-a', 'fresh')
    t.contexts.recordRead(first.id, [a, a])
    t.attempts.finish(first.id, 'completed', 3)
    expect(t.contexts.isEligible(first.id, true)).toBe(true) // A terminal parent may supply valid reflection context.
    const second = t.run('session-a', 'fresh')
    t.contexts.bind(second.id, 'session-a', 'fresh')
    t.contexts.recordRead(second.id, [b])
    expect(t.contexts.contextForRun(second.id)?.notes).toEqual([{ id: a.id, revision: 1 }, { id: b.id, revision: 1 }])
    t.reopen()
    expect(t.contexts.canResume('session-a', 'fresh')).toBe(true)
    expect(t.contexts.canResume('other-session', 'fresh')).toBe(false)
    expect(t.contexts.contextForRun(first.id)).toEqual(t.contexts.contextForRun(second.id))
    expect(JSON.stringify(t.contexts.get('fresh'))).not.toMatch(/PRIVATE_|space:a/)
  })

  it('keeps Run and ACP associations immutable, rejecting cross-Session, wrong runtime and stopped bindings without orphan rows', () => {
    const t = fixture(), a = t.run('a', 'acp-a'), b = t.run('b', 'acp-b')
    t.contexts.bind(a.id, 'a', 'acp-a')
    const before = t.db.prepare('SELECT * FROM runtime_contexts').all()
    expect(() => t.contexts.bind(a.id, 'b', 'acp-b')).toThrow(RuntimeContextError)
    t.attempts.bindRuntime(b.id, 'acp-a')
    expect(() => t.contexts.bind(b.id, 'b', 'acp-a')).toThrow(RuntimeContextError)
    t.attempts.bindRuntime(a.id, 'replacement')
    expect(t.contexts.isEligible(a.id, true)).toBe(false)
    expect(() => t.contexts.bind(a.id, 'a', 'replacement')).toThrow(RuntimeContextError)
    t.attempts.requestStop(b.id, 'user_requested')
    expect(() => t.contexts.bind(b.id, 'b', 'acp-b')).toThrow(RuntimeContextError)
    expect(t.db.prepare('SELECT * FROM runtime_contexts').all()).toEqual(before)
    expect(t.db.prepare('SELECT * FROM run_contexts').all()).toHaveLength(1)
  })

  it('rechecks material revisions after an await and rejects the whole batch, including managed or unavailable source refs', () => {
    const t = fixture(), run = t.run('a', 'acp'), fresh = t.note(), stale = t.note()
    t.contexts.bind(run.id, 'a', 'acp')
    t.memory.confirm(stale.id, stale.scope, { by: 'alice', messageId: 'confirmed-after-read' })
    expect(() => t.contexts.recordRead(run.id, [fresh, stale])).toThrow(RuntimeContextError)
    expect(t.contexts.get('acp')?.notes).toEqual([])
    expect(() => t.contexts.recordRead(run.id, [{ id: fresh.id, revision: 0 }])).toThrow(RuntimeContextError)
    const managed = t.memory.add({ scope: 'space:a', kind: 'fact', title: 'managed', body: 'not enabled', provenance: {
      state: 'verified', originRunId: run.id, sources: [{ ref: 'synthetic', tenantId: 'tenant', appId: 'app', spaceId: 'space:a', chatId: 'a', readIdentity: { kind: 'user', openId: 'alice' }, readAt: 1, coverage: 'partial' }],
    } })
    expect(() => t.contexts.recordRead(run.id, [managed])).toThrow(RuntimeContextError)
    t.contexts.recordRead(run.id, [fresh])
    t.attempts.requestStop(run.id, 'user_requested')
    expect(() => t.contexts.recordRead(run.id, [])).toThrow(RuntimeContextError)
    expect(t.contexts.get('acp')?.notes).toEqual([{ id: fresh.id, revision: 1 }])
  })

  it('invalidates every actual consumer of an old revision, keeps terminal links, and cannot revive or rebind the invalidated ACP', () => {
    const t = fixture(), note = t.note(), first = t.run('a', 'acp-a'), other = t.run('b', 'acp-b')
    t.contexts.bind(first.id, 'a', 'acp-a'); t.contexts.recordRead(first.id, [note])
    t.attempts.finish(first.id, 'completed', 10)
    const active = t.run('a', 'acp-a'); t.contexts.bind(active.id, 'a', 'acp-a')
    t.contexts.bind(other.id, 'b', 'acp-b'); t.contexts.recordRead(other.id, [note])
    t.memory.remove(note.id, note.scope)
    const affected = t.contexts.invalidate(t.memory.changes())
    expect(affected).toEqual([active.id, other.id].sort())
    expect(t.contexts.isEligible(first.id, true)).toBe(false)
    expect(t.contexts.get('acp-a')).toMatchObject({ state: 'invalidated', reason: 'memory_context_invalidated', invalidatedAt: 1000 })
    expect(t.contexts.invalidate(t.memory.changes())).toEqual([])
    expect(() => t.contexts.bind(active.id, 'a', 'acp-a')).toThrow(RuntimeContextError)
    expect(() => t.contexts.recordRead(active.id, [])).toThrow(RuntimeContextError)
    t.reopen()
    expect(t.contexts.canResume('a', 'acp-a')).toBe(false)
    expect(t.contexts.contextForRun(first.id)?.notes).toEqual([{ id: note.id, revision: 1 }])
  })

  it('does not approve stale consumption if an old direct store caller omitted application invalidation', () => {
    const t = fixture(), run = t.run('a', 'acp'), note = t.note()
    t.contexts.bind(run.id, 'a', 'acp'); t.contexts.recordRead(run.id, [note])
    t.memory.confirm(note.id, note.scope, { by: 'alice', messageId: 'change' })
    expect(t.contexts.canResume('a', 'acp')).toBe(false)
    expect(t.contexts.isEligible(run.id, true)).toBe(false)
    expect(() => t.contexts.recordRead(run.id, [{ id: note.id, revision: 2 }])).toThrow(RuntimeContextError)
  })
})
