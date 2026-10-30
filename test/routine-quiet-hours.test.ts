import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { afterQuietHours, FREQUENCY_DISABLED, nextRunAt, parseSchedule, RoutineStore, type ScheduleSpec } from '../src/core/routines.js'

const at = (s: string) => Date.parse(`2026-09-22T${s}:00+08:00`)
const quiet: ScheduleSpec = { type: 'interval', everyMinutes: 30, quietHours: { start: '22:00', end: '08:00' } }
const registries: Registry[] = []
function fixture(schedule: ScheduleSpec = quiet) {
  const registry = new Registry(':memory:'); registries.push(registry)
  const store = new RoutineStore(registry.db)
  const routine = store.add({ kind: 'watch', ownerOpenId: 'alice', chatId: 'dm', chatType: 'p2p', name: '发布进展', prompt: '有变化告诉我',
    schedule, watchChatIds: ['release'], now: at('21:00') })
  return { registry, store, routine }
}
afterEach(() => { registries.splice(0).forEach(registry => registry.close()) })

describe('routine quiet hours, cadence and scope use the original occurrence chain', () => {
  it('normalizes quiet hours and rejects an ambiguous all-day window', () => {
    expect(parseSchedule({ type: 'interval', everyMinutes: 30, quiet_hours: quiet.quietHours })).toEqual(quiet)
    expect(() => parseSchedule({ type: 'daily', at: '09:00', quietHours: { start: '08:00', end: '08:00' } })).toThrow(/两个不同/)
    expect(() => parseSchedule({ type: 'once', atMs: at('23:00'), quietHours: quiet.quietHours })).toThrow(/一次性/)
  })
  it('handles midnight, exact boundaries and a daytime quiet window in the scheduler timezone', () => {
    expect(afterQuietHours(quiet, at('21:59'))).toBe(at('21:59'))
    expect(afterQuietHours(quiet, at('22:00'))).toBe(at('08:00') + 86_400_000)
    expect(afterQuietHours(quiet, at('07:59'))).toBe(at('08:00'))
    expect(afterQuietHours(quiet, at('08:00'))).toBe(at('08:00'))
    const lunch: ScheduleSpec = { type: 'daily', at: '12:30', quietHours: { start: '12:00', end: '14:00' } }
    expect(nextRunAt(lunch, at('11:00'))).toBe(at('14:00'))
    expect(afterQuietHours(lunch, at('12:30'), 0)).toBe(at('12:30'))
  })
  it('coalesces overnight windows at the quiet period end without creating missed occurrences', () => {
    const { store, routine } = fixture()
    const run = store.claimDueOccurrence(routine.id, routine.nextRunAt, at('21:30'))!
    store.startOccurrence(run.id, at('21:30'))
    store.finishOccurrence(run.id, 'ok', at('21:31'))
    expect(store.get(routine.id)?.nextRunAt).toBe(at('08:00') + 86_400_000)
    expect(store.due(at('23:00'))).toEqual([])
    expect(store.listOccurrences(routine.id)).toHaveLength(1)
  })
  it('recovery in quiet hours preserves the unread cursor and defers the old due window', () => {
    const { store, routine } = fixture()
    expect(store.claimDueOccurrence(routine.id, routine.nextRunAt, at('23:00'))).toBeUndefined()
    expect(store.get(routine.id)).toMatchObject({ nextRunAt: at('08:00') + 86_400_000, messageCursorSec: null, runs: 0, failCount: 0 })
    expect(store.listOccurrences(routine.id)).toEqual([])
  })
  it('a pending window cannot start in quiet hours; a running automatic window cannot deliver after the boundary', () => {
    const { store, routine } = fixture()
    const run = store.claimDueOccurrence(routine.id, routine.nextRunAt, at('21:30'))!
    expect(store.startOccurrence(run.id, at('22:00'))).toBeUndefined()
    expect(store.getOccurrence(run.id)?.status).toBe('cancelled')
    const other = fixture()
    const running = other.store.claimDueOccurrence(other.routine.id, other.routine.nextRunAt, at('21:30'))!
    other.store.startOccurrence(running.id, at('21:30'))
    const version = other.store.configVersion(other.routine.id)!
    expect(other.store.currentForExecution(other.routine.id, version, running.id, at('21:59'))).toBeDefined()
    expect(other.store.currentForExecution(other.routine.id, version, running.id, at('22:00'))).toBeUndefined()
    expect(other.store.finishOccurrence(running.id, 'failed', at('22:01'))).toBeUndefined()
    expect(other.store.get(other.routine.id)).toMatchObject({ failCount: 0, runs: 0, messageCursorSec: null })
    // A person's explicit request to run now is distinct from automatic scheduling.
    expect(other.store.currentForExecution(other.routine.id, version, undefined, at('22:00'))).toBeDefined()
  })
  it('zero cadence persists disabled, cannot be resumed or accepted into immediate execution', () => {
    const zero = parseSchedule({ type: 'interval', everyMinutes: 0 })
    const { store, routine } = fixture(zero)
    expect(routine).toMatchObject({ enabled: false, disabledReason: FREQUENCY_DISABLED })
    expect(nextRunAt(zero, at('21:00'))).toBe(Infinity)
    expect(store.due(at('23:00'))).toEqual([])
    expect(() => store.resume(routine.id)).toThrow(/频率为 0/)
    const proposal = store.add({ kind: 'schedule', source: 'model', chatId: 'group', chatType: 'group', name: '关闭日报', prompt: '日报', schedule: zero, now: at('21:00') })
    expect(store.accept(proposal.id, 'alice', at('21:01'))).toMatchObject({ status: 'active', enabled: false })
  })
  it('setting cadence to zero cancels active windows but retains source coverage and future user control', () => {
    const { store, routine } = fixture()
    const run = store.claimDueOccurrence(routine.id, routine.nextRunAt, at('21:30'))!
    store.startOccurrence(run.id, at('21:30'))
    store.update(routine.id, { schedule: { type: 'interval', everyMinutes: 0 } }, at('21:35'))
    expect(store.getOccurrence(run.id)?.status).toBe('cancelled')
    expect(store.get(routine.id)).toMatchObject({ enabled: false, messageCursorSec: null })
    store.update(routine.id, { schedule: { type: 'interval', everyMinutes: 60 } }, at('21:36'))
    expect(store.get(routine.id)?.enabled).toBe(false)
    expect(store.resume(routine.id, at('21:37'))).toMatchObject({ enabled: true, nextRunAt: at('22:37') })
  })
  it('editing watch scope retains consumed coverage and invalidates in-flight reads from the previous scope', () => {
    const { store, routine } = fixture()
    const version = store.configVersion(routine.id)!
    const start = Math.floor(routine.createdAt / 1000), end = start + 60
    expect(store.advanceMessageCursor(routine.id, version, start, end)).toBe(true)
    const run = store.claimDueOccurrence(routine.id, routine.nextRunAt, at('21:30'))!
    store.startOccurrence(run.id, at('21:30'))
    store.update(routine.id, { watchChatIds: ['release', 'support', 'support'] }, at('21:35'))
    expect(store.get(routine.id)).toMatchObject({ watchChatIds: ['release', 'support'], messageCursorSec: end })
    expect(store.getOccurrence(run.id)?.status).toBe('cancelled')
    expect(store.advanceMessageCursor(routine.id, version, end, end + 60)).toBe(false)
  })
})
