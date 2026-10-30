import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RoutineApplication, RoutineControlConflictError } from '../src/core/routine-application.js'
import { RoutineControlError, RoutineStore, type Routine, type RoutineControlAction } from '../src/core/routines.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { spaceDeps } from './helpers/space.js'

const NOW = 1_800_000_000_000
const registries: Registry[] = []
afterEach(() => { for (const registry of registries.splice(0)) registry.close() })

function setup() {
  const registry = new Registry(':memory:')
  registries.push(registry)
  const routines = new RoutineStore(registry.db)
  const attempts = new RunAttempts(registry.db)
  const { spaces } = spaceDeps(registry.db)
  const space = spaces.ensure({ kind: 'group', chatId: 'oc_control', openId: 'ou_owner' })
  let now = NOW
  let runSequence = 0
  const active = new Map<number, { runId: string; abort: AbortController }[]>()
  const userTokens = new UserTokenStore(registry.db, {
    exchangeCode: async () => ({ accessToken: 'synthetic-test-only', expiresIn: 7200 }),
    refresh: async () => { throw new Error('This fixture must not refresh credentials') },
  }, () => now)
  const app = new RoutineApplication({ registry, routines, spaces, attempts, userTokens,
    activeRuns: id => active.get(id) ?? [], now: () => now })
  function add(patch: Partial<Parameters<RoutineStore['add']>[0]> = {}) {
    return routines.add({ kind: 'schedule', ownerOpenId: 'ou_owner', runAs: 'ou_owner', spaceId: space.id,
      chatId: space.chatId!, chatType: 'group', name: '合成职责', prompt: '合成指令',
      schedule: { type: 'interval', everyMinutes: 10 }, now: NOW, ...patch })
  }
  function start(routine: Routine, sessionKey = `synthetic-session-${++runSequence}`) {
    const run = attempts.begin({ workKey: `routine:${routine.id}`, sessionKey,
      triggerKey: `synthetic:${runSequence}`, stage: 'routine', actorOpenId: 'ou_owner', now })!
    const handle = { runId: run.id, abort: new AbortController() }
    active.set(routine.id, [...active.get(routine.id) ?? [], handle])
    return handle
  }
  function occurrence(routine: Routine, running = true) {
    const result = routines.claimDueOccurrence(routine.id, routine.nextRunAt, routine.nextRunAt)!
    expect(result).toBeDefined()
    if (running) expect(routines.startOccurrence(result.id, routine.nextRunAt)).toBeDefined()
    return result
  }
  function snapshot() {
    return ['routines', 'routine_occurrences', 'run_attempts'].map(table =>
      registry.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
  }
  return { registry, routines, attempts, spaces, space, active, app, userTokens, add, start, occurrence, snapshot,
    setNow: (value: number) => { now = value } }
}

describe('RoutineApplication durable control and commit-only runtime cancellation', () => {
  it.each(['pause', 'delete'] as const)('rolls back %s with its outer transaction without aborting a Run', action => {
    const t = setup(), routine = t.add(), occurrence = t.occurrence(routine), run = t.start(routine)
    const before = t.snapshot()
    t.registry.db.exec('SAVEPOINT console_operation')
    const receipt = t.app.persistControl(routine.id, action, { expectedConfigVersion: t.routines.configVersion(routine.id) })
    expect(receipt.changed).toBe(true)
    expect(receipt.affectedRunIds).toEqual([run.runId])
    expect(t.routines.getOccurrence(occurrence.id)?.status).toBe('cancelled')
    expect(t.attempts.get(run.runId)?.state).toBe('stop_requested')
    expect(run.abort.signal.aborted).toBe(false)
    t.registry.db.exec('ROLLBACK TO SAVEPOINT console_operation; RELEASE SAVEPOINT console_operation')
    // A rolled-back operation discards its afterCommit closure.
    expect(t.snapshot()).toEqual(before)
    expect(run.abort.signal.aborted).toBe(false)
  })

  it('pauses an already-disabled running once, then aborts only its captured Run after commit', () => {
    const t = setup(), routine = t.add({ kind: 'followup', sessionKey: 'original-thread', schedule: { type: 'once', atMs: NOW + 1000 } })
    const occurrence = t.occurrence(routine), runA = t.start(routine)
    const version = t.routines.configVersion(routine.id)!
    expect(t.routines.get(routine.id)?.enabled).toBe(false)
    t.registry.db.exec('SAVEPOINT console_operation')
    const receipt = t.app.persistControl(routine.id, 'pause', { expectedConfigVersion: version })
    expect(receipt.routine).toMatchObject({ id: routine.id, enabled: false, disabledReason: '手动停用', lastRunAt: null })
    expect(t.routines.configVersion(routine.id)).toBe(version + 1)
    expect(t.routines.currentForExecution(routine.id, version, occurrence.id)).toBeUndefined()
    expect(runA.abort.signal.aborted).toBe(false)
    t.registry.db.exec('RELEASE SAVEPOINT console_operation')
    t.attempts.finish(runA.runId, 'cancelled', NOW + 2000)
    const runB = t.start(routine)
    t.active.set(routine.id, [runB])
    receipt.afterCommit()
    receipt.afterCommit()
    expect(runA.abort.signal.aborted).toBe(true)
    expect(runB.abort.signal.aborted).toBe(false)
    expect(t.attempts.get(runB.runId)?.state).toBe('running')
    expect(t.routines.listOccurrences(routine.id)).toMatchObject([{ id: occurrence.id, status: 'cancelled' }])
  })

  it('keeps the watch cursor and version stable on a repeated pause and enabled resume', async () => {
    const t = setup(), routine = t.add({ kind: 'watch' })
    await t.userTokens.complete({ code: 'synthetic', openId: 'ou_owner', redirectUri: 'http://127.0.0.1/synthetic' })
    const start = Math.floor(routine.createdAt / 1000)
    expect(t.routines.advanceMessageCursor(routine.id, t.routines.configVersion(routine.id)!, start, start + 45)).toBe(true)
    t.app.control(routine.id, 'pause')
    const paused = t.snapshot()
    expect(t.app.persistControl(routine.id, 'pause')).toMatchObject({ changed: false, affectedRunIds: [] })
    expect(t.snapshot()).toEqual(paused)
    const resumed = t.app.persistControl(routine.id, 'resume')
    expect(resumed).toMatchObject({ changed: true, affectedRunIds: [], routine: { id: routine.id, enabled: true, messageCursorSec: start + 45 } })
    const enabled = t.snapshot()
    expect(t.app.persistControl(routine.id, 'resume')).toMatchObject({ changed: false, affectedRunIds: [] })
    expect(t.snapshot()).toEqual(enabled)
  })

  it('still stops a manually started Run on an already paused routine without an extra config revision', () => {
    const t = setup(), routine = t.add()
    t.app.control(routine.id, 'pause')
    const version = t.routines.configVersion(routine.id)
    const run = t.start(routine)
    const receipt = t.app.persistControl(routine.id, 'pause')
    expect(receipt).toMatchObject({ changed: true, affectedRunIds: [run.runId] })
    expect(t.routines.configVersion(routine.id)).toBe(version)
    expect(t.attempts.get(run.runId)?.state).toBe('stop_requested')
    expect(run.abort.signal.aborted).toBe(false)
    receipt.afterCommit()
    expect(run.abort.signal.aborted).toBe(true)
  })

  it.each(['pause', 'resume', 'delete'] as RoutineControlAction[])('rejects stale %s atomically', action => {
    const t = setup(), routine = t.add(), run = t.start(routine)
    const version = t.routines.configVersion(routine.id)!
    t.routines.update(routine.id, { prompt: '新的真实指令' }, NOW + 10)
    const before = t.snapshot()
    expect(() => t.app.persistControl(routine.id, action, { expectedConfigVersion: version })).toThrow(RoutineControlConflictError)
    expect(t.snapshot()).toEqual(before)
    expect(run.abort.signal.aborted).toBe(false)
  })

  it('rolls back the routine and occurrence if persisting the Run stop fails', () => {
    const t = setup(), routine = t.add(), occurrence = t.occurrence(routine), run = t.start(routine)
    t.registry.db.exec(`CREATE TRIGGER reject_stop BEFORE UPDATE ON run_attempts
      WHEN NEW.state='stop_requested' BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END`)
    const before = t.snapshot()
    expect(() => t.app.persistControl(routine.id, 'pause')).toThrow('synthetic persistence failure')
    expect(t.snapshot()).toEqual(before)
    expect(t.routines.getOccurrence(occurrence.id)?.status).toBe('running')
    expect(run.abort.signal.aborted).toBe(false)
  })

  it.each(['pending', 'running', 'completed', 'interrupted', 'cancelled_after_start'] as const)('does not resume an unsafe once state: %s', state => {
    const t = setup(), routine = t.add({ schedule: { type: 'once', atMs: NOW + 1000 } })
    const occurrence = t.occurrence(routine, state !== 'pending')
    if (state === 'completed') t.routines.finishOccurrence(occurrence.id, 'ok', NOW + 2000)
    if (state === 'interrupted') t.routines.recoverInterruptedOccurrences(NOW + 2000)
    if (state === 'cancelled_after_start') t.app.control(routine.id, 'pause')
    const before = t.snapshot()
    expect(() => t.app.persistControl(routine.id, 'resume')).toThrow(RoutineControlError)
    expect(t.snapshot()).toEqual(before)
  })

  it('resumes a paused, never-started once under the same id when its original time has passed', () => {
    const t = setup(), routine = t.add({ schedule: { type: 'once', atMs: NOW + 1000 } })
    const occurrence = t.occurrence(routine, false)
    t.app.control(routine.id, 'pause')
    t.setNow(NOW + 20_000)
    const receipt = t.app.persistControl(routine.id, 'resume')
    expect(receipt.routine).toMatchObject({ id: routine.id, enabled: true, schedule: routine.schedule, nextRunAt: NOW + 20_000, lastRunAt: null })
    expect(t.routines.listOccurrences(routine.id)).toMatchObject([{ id: occurrence.id, status: 'cancelled', startedAt: null }])
  })

  it('retains the current Space and delegated watch-auth guards without making network requests', () => {
    const t = setup(), watch = t.add({ kind: 'watch' }), schedule = t.add()
    t.app.control(watch.id, 'pause')
    t.app.control(schedule.id, 'pause')
    const before = t.snapshot()
    expect(() => t.app.persistControl(watch.id, 'resume')).toThrow('授权已到期')
    t.spaces.archive(t.space.id)
    expect(() => t.app.persistControl(schedule.id, 'resume')).toThrow('空间已停用或换绑')
    expect(t.snapshot()).toEqual(before)
  })

  it('preserves proposal and missing-row differences between control and legacy stop', () => {
    const t = setup(), proposal = t.add({ source: 'model' })
    expect(() => t.app.control(proposal.id, 'pause')).toThrow('尚未生效')
    t.app.stop(proposal.id, 'pause')
    expect(t.routines.get(proposal.id)).toMatchObject({ status: 'proposed', enabled: false })
    expect(t.app.control(proposal.id, 'delete')).toBeUndefined()
    expect(() => t.app.control(proposal.id, 'delete')).toThrow('已不存在')
    expect(() => t.app.stop(proposal.id, 'remove')).not.toThrow()
  })

  it.each(['control', 'stop'] as const)('%s commits persistent ineligibility before aborting the exact runtime', entry => {
    const t = setup(), routine = t.add(), occurrence = t.occurrence(routine), run = t.start(routine)
    let abortObserved = false
    run.abort.signal.addEventListener('abort', () => {
      abortObserved = true
      expect(t.routines.get(routine.id)?.enabled).toBe(false)
      expect(t.routines.getOccurrence(occurrence.id)?.status).toBe('cancelled')
      expect(t.attempts.get(run.runId)?.state).toBe('stop_requested')
    })
    if (entry === 'control') t.app.control(routine.id, 'pause')
    else t.app.stop(routine.id, 'pause')
    expect(abortObserved).toBe(true)
  })
})
