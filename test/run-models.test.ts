import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RunModelError, RunModels, type PrepareRunModel } from '../src/core/run-models.js'

const NOW = 1_800_000_000_000
const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-run-models-')), path = join(dir, 'registry.db')
  let registry = new Registry(path), runs = new RunAttempts(registry.db), models = new RunModels(registry.db)
  cleanups.push(() => { registry.close(); rmSync(dir, { recursive: true, force: true }) })
  let sequence = 0
  const begin = (sessionKey = `session-${++sequence}`) => {
    if (!registry.getSession(sessionKey)) registry.createSession({ sessionKey, chatId: 'chat', chatType: 'group', cwd: dir, requesterOpenId: 'alice' })
    const task = registry.createTaskOnce({ sessionKey, messageId: `message-${++sequence}`, requesterOpenId: 'alice', prompt: 'synthetic model choice' }).task
    const run = runs.begin({ workKey: registry.taskWork.get(task.id)!.key, sessionKey, triggerKey: `task:${task.id}`,
      stage: 'task', taskId: task.id, actorOpenId: 'alice', now: NOW }, () => registry.startTask(task.id, NOW, sessionKey))!
    return run
  }
  const pin = (runId: string, acpSessionId = 'acp-one'): PrepareRunModel => {
    expect(runs.bindRuntime(runId, acpSessionId)).toBe(true)
    return { runId, acpSessionId, runtimeGeneration: 1, selector: '["provider-a","model-a"]', providerId: 'provider-a',
      modelId: 'model-a', accountRef: 'deployment-main', preparedAt: NOW + 1 }
  }
  return { get registry() { return registry }, get runs() { return runs }, get models() { return models }, begin, pin,
    reopen() { registry.close(); registry = new Registry(path); runs = new RunAttempts(registry.db); models = new RunModels(registry.db) } }
}

describe('Run model facts', () => {
  it('leaves historical and unprepared Run facts unknown across construction and reopen', () => {
    const t = setup(), run = t.begin()
    t.runs.bindRuntime(run.id, 'acp-old'); t.runs.finish(run.id, 'completed', NOW + 1)
    const before = t.runs.get(run.id)
    t.reopen(); new RunModels(t.registry.db)
    expect(t.models.get(run.id)).toBeUndefined()
    expect(t.runs.get(run.id)).toEqual(before)
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM run_models').get()?.n).toBe(0)
  })

  it('requires an existing running attempt already bound to the exact ACP', () => {
    const t = setup(), run = t.begin(), input = { runId: run.id, acpSessionId: 'acp-one', runtimeGeneration: 1,
      selector: 'opaque-choice', providerId: 'a', modelId: 'b', accountRef: 'account-main', preparedAt: NOW }
    expect(() => t.models.prepare(input)).toThrow(RunModelError)
    t.runs.bindRuntime(run.id, 'acp-other')
    expect(() => t.models.prepare(input)).toThrow('ACP')
    expect(() => t.models.prepare({ ...input, runId: 'missing' })).toThrow('ACP')
    expect(t.models.get(run.id)).toBeUndefined()
    t.runs.bindRuntime(run.id, 'acp-one')
    expect(t.models.prepare(input)).toMatchObject({ ...input, admittedAt: null, contextUsed: null, contextSize: null,
      contextObservedAt: null, usageStatus: 'unavailable' })
  })

  it('pins every model identity field once and retains the first verified timestamp', () => {
    const t = setup(), run = t.begin(), input = t.pin(run.id), first = t.models.prepare(input)
    expect(t.models.prepare({ ...input, preparedAt: NOW + 20 })).toEqual(first)
    for (const patch of [{ selector: 'other' }, { providerId: 'other' }, { modelId: 'other' }, { accountRef: 'other' }, { runtimeGeneration: 2 }]) {
      expect(() => t.models.prepare({ ...input, ...patch })).toThrow('固定')
    }
    t.runs.bindRuntime(run.id, 'acp-two')
    expect(() => t.models.prepare({ ...input, acpSessionId: 'acp-two' })).toThrow('固定')
    expect(t.models.get(run.id)).toEqual(first)
  })

  it('rolls model preparation back with an outer admission transaction and on insert failure', () => {
    const t = setup(), run = t.begin(), input = t.pin(run.id)
    t.registry.db.exec('BEGIN IMMEDIATE')
    t.models.prepare(input)
    t.registry.db.exec('ROLLBACK')
    expect(t.models.get(run.id)).toBeUndefined()
    t.registry.db.exec("CREATE TRIGGER reject_model BEFORE INSERT ON run_models BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END")
    expect(() => t.models.prepare(input)).toThrow('synthetic write failure')
    expect(t.models.get(run.id)).toBeUndefined()
    t.registry.db.exec('DROP TRIGGER reject_model')
    expect(t.models.prepare(input).runId).toBe(run.id)
  })

  it('admits only the pinned live binding and keeps the first admission across wrap-up', () => {
    const t = setup(), run = t.begin(), input = t.pin(run.id)
    expect(t.models.admit(run.id, input, NOW + 2)).toBe(false)
    t.models.prepare(input)
    for (const wrong of [{ acpSessionId: 'other' }, { runtimeGeneration: 2 }, { selector: 'other' }]) {
      expect(t.models.admit(run.id, { ...input, ...wrong }, NOW + 2)).toBe(false)
    }
    expect(t.models.admit(run.id, input, NOW)).toBe(false)
    expect(t.models.admit(run.id, input, NOW + 2)).toBe(true)
    expect(t.models.admit(run.id, input, NOW + 3)).toBe(true)
    expect(t.models.get(run.id)?.admittedAt).toBe(NOW + 2)
    t.runs.bindRuntime(run.id, 'replacement')
    expect(t.models.admit(run.id, input, NOW + 4)).toBe(false)
  })

  it('stores latest occupancy including decreases and zero, never accumulated billing usage', () => {
    const t = setup(), run = t.begin(), input = t.pin(run.id)
    t.models.prepare(input)
    expect(t.models.observeContext(run.id, input, { used: 8, size: 100, observedAt: NOW + 2 })).toBe(false)
    t.models.admit(run.id, input, NOW + 2)
    expect(t.models.observeContext(run.id, input, { used: 800, size: 1000, observedAt: NOW + 3 })).toBe(true)
    expect(t.models.observeContext(run.id, input, { used: 200, size: 1000, observedAt: NOW + 4 })).toBe(true)
    expect(t.models.observeContext(run.id, input, { used: 900, size: 1000, observedAt: NOW + 3 })).toBe(false)
    expect(t.models.get(run.id)).toMatchObject({ contextUsed: 200, contextSize: 1000, contextObservedAt: NOW + 4, usageStatus: 'unavailable' })
    // Equal millisecond samples keep arrival order. A real occupancy above the nominal size is not hidden.
    expect(t.models.observeContext(run.id, input, { used: 1200, size: 1000, observedAt: NOW + 4 })).toBe(true)
    expect(t.models.observeContext(run.id, input, { used: 0, size: 0, observedAt: NOW + 5 })).toBe(true)
    expect(t.models.get(run.id)).toMatchObject({ contextUsed: 0, contextSize: 0, usageStatus: 'unavailable' })
  })

  it('ignores invalid samples and samples from another ACP, generation, selector or before admission', () => {
    const t = setup(), run = t.begin(), input = t.pin(run.id)
    t.models.prepare(input); t.models.admit(run.id, input, NOW + 2)
    const good = { used: 2, size: 100, observedAt: NOW + 3 }
    for (const bad of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(t.models.observeContext(run.id, input, { ...good, used: bad })).toBe(false)
      expect(t.models.observeContext(run.id, input, { ...good, size: bad })).toBe(false)
      expect(t.models.observeContext(run.id, input, { ...good, observedAt: bad })).toBe(false)
    }
    for (const wrong of [{ acpSessionId: 'other' }, { runtimeGeneration: 2 }, { selector: 'other' }]) {
      expect(t.models.observeContext(run.id, { ...input, ...wrong }, good)).toBe(false)
    }
    expect(t.models.observeContext(run.id, input, { ...good, observedAt: NOW + 1 })).toBe(false)
    expect(t.models.get(run.id)?.contextUsed).toBeNull()
  })

  it.each(['stop_requested', 'completed', 'failed', 'cancelled', 'interrupted'] as const)('rejects preparation, admission and late usage after %s', state => {
    const t = setup(), run = t.begin(), input = t.pin(run.id)
    t.models.prepare(input); t.models.admit(run.id, input, NOW + 2)
    t.models.observeContext(run.id, input, { used: 10, size: 100, observedAt: NOW + 3 })
    if (state === 'stop_requested') t.runs.requestStop(run.id, 'user_requested')
    else if (state === 'interrupted') t.runs.recoverInterrupted(NOW + 4)
    else t.runs.finish(run.id, state, NOW + 4)
    const original = t.models.get(run.id)
    expect(() => t.models.prepare(input)).toThrow('失效')
    expect(t.models.admit(run.id, input, NOW + 5)).toBe(false)
    expect(t.models.observeContext(run.id, input, { used: 50, size: 100, observedAt: NOW + 5 })).toBe(false)
    expect(t.models.get(run.id)).toEqual(original)
  })

  it('retains nonempty facts after restart and does not attach late old usage to a newer Run', () => {
    const t = setup(), old = t.begin('shared'), first = t.pin(old.id, 'same-acp')
    t.models.prepare(first); t.models.admit(old.id, first, NOW + 2)
    t.models.observeContext(old.id, first, { used: 12, size: 100, observedAt: NOW + 3 })
    t.runs.finish(old.id, 'completed', NOW + 4)
    const current = t.begin('shared'), second = { ...t.pin(current.id, 'same-acp'), runtimeGeneration: 2, modelId: 'model-b', selector: '["provider-a","model-b"]' }
    t.models.prepare(second); t.models.admit(current.id, second, NOW + 5)
    const oldFact = t.models.get(old.id), currentFact = t.models.get(current.id)
    t.reopen(); new RunModels(t.registry.db)
    expect(t.models.get(old.id)).toEqual(oldFact)
    expect(t.models.get(current.id)).toEqual(currentFact)
    expect(t.models.observeContext(old.id, first, { used: 99, size: 100, observedAt: NOW + 6 })).toBe(false)
    expect(t.models.observeContext(current.id, first, { used: 99, size: 100, observedAt: NOW + 6 })).toBe(false)
    expect(t.models.get(current.id)?.contextUsed).toBeNull()
  })

  it('rejects malformed verified facts without inserting any record', () => {
    const t = setup(), run = t.begin(), input = t.pin(run.id)
    for (const patch of [{ runtimeGeneration: 0 }, { runtimeGeneration: 1.5 }, { preparedAt: -1 }, { accountRef: '' }, { selector: '  ' }]) {
      expect(() => t.models.prepare({ ...input, ...patch })).toThrow('无效')
    }
    expect(t.models.get(run.id)).toBeUndefined()
  })
})
