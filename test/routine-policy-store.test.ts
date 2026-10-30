import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'

const NOW = Date.UTC(2026, 8, 19)
const opened: Registry[] = []
afterEach(() => { for (const r of opened.splice(0)) r.close() })
function setup() {
  const registry = new Registry(':memory:')
  opened.push(registry)
  const store = new RoutineStore(registry.db)
  const input = { kind: 'watch' as const, ownerOpenId: 'ou_test', chatId: 'oc_test', chatType: 'group' as const,
    name: '合成任务', prompt: '完整原指令', schedule: { type: 'interval' as const, everyMinutes: 10 }, watchChatIds: ['oc_test'], now: NOW }
  return { registry, store, input }
}

describe('routine delivery policy storage', () => {
  it('migrates existing rows to silent-on-empty without changing their schedule or cursor', () => {
    const t = setup()
    const old = t.store.add(t.input)
    t.store.advanceMessageCursor(old.id, 1, NOW / 1000, NOW / 1000 + 30)
    const before = t.store.get(old.id)!
    t.registry.db.exec('ALTER TABLE routines DROP COLUMN delivery_policy')
    const migrated = new RoutineStore(t.registry.db)
    expect(migrated.get(old.id)).toEqual(before)
    expect(migrated.get(old.id)?.deliveryPolicy).toBe('when_nonempty')
    expect(migrated.configVersion(old.id)).toBe(1)
  })

  it('keeps a claimed but unstarted window through a policy-only edit; the window starts with the current policy', () => {
    const t = setup()
    const r = t.store.add(t.input)
    t.store.advanceMessageCursor(r.id, 1, NOW / 1000, NOW / 1000 + 30)
    const occurrence = t.store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    const before = t.store.get(r.id)!
    const changed = t.store.update(r.id, { deliveryPolicy: 'every_run' }, r.nextRunAt)!
    expect(changed).toEqual({ ...before, deliveryPolicy: 'every_run' })
    expect(t.store.configVersion(r.id)).toBe(2)
    expect(t.store.getOccurrence(occurrence.id)).toMatchObject({ status: 'pending', configVersion: 1 })
    // The stale snapshot never becomes an execution; the window records the version it actually starts with.
    expect(t.store.currentForExecution(r.id, 1, occurrence.id)).toBeUndefined()
    expect(t.store.startOccurrence(occurrence.id, r.nextRunAt)?.deliveryPolicy).toBe('every_run')
    expect(t.store.getOccurrence(occurrence.id)).toMatchObject({ status: 'running', configVersion: 2 })
    expect(t.store.currentForExecution(r.id, 2, occurrence.id)?.deliveryPolicy).toBe('every_run')
    expect(new RoutineStore(t.registry.db).get(r.id)?.deliveryPolicy).toBe('every_run')
  })

  it('validates direct callers without partial writes and does not change followup semantics', () => {
    const t = setup()
    const r = t.store.add(t.input)
    const before = t.registry.db.prepare('SELECT * FROM routines').all()
    expect(() => t.store.add({ ...t.input, deliveryPolicy: 'invalid' as never })).toThrow('delivery_policy')
    expect(() => t.store.update(r.id, { name: '不可写入', deliveryPolicy: 'invalid' as never })).toThrow('delivery_policy')
    expect(t.registry.db.prepare('SELECT * FROM routines').all()).toEqual(before)
    const followup = t.store.add({ ...t.input, kind: 'followup', sessionKey: 'msg:om_test' })
    expect(() => t.store.update(followup.id, { deliveryPolicy: 'every_run' })).toThrow('followup')
    expect(t.store.get(followup.id)).toEqual(followup)
  })
})
