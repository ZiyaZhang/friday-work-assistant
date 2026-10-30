/**
 * 职责在重启后接着干活、按约定时间自动恢复、连续失败时告诉负责人。
 *
 * 用户原话里的三种期待：
 * - “服务重启后所有职责会自动接上，不会悄悄停摆”——但已经可能发出的消息或写入不能重放；
 * - “这周先停一下，下周一再恢复”——暂停不能被静默变成永久撤销，也不能改成只跑一次；
 * - 连续失败被停用时要有人知道。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { ensureDeliverySchema } from '../src/core/delivery.js'
import { routineExecutionKey } from '../src/core/execution-keys.js'
import { RoutineApplication, routineProgress } from '../src/core/routine-application.js'
import { MAX_PAUSE_MS, RoutineControlError, RoutineScheduler, RoutineStore, type Routine, type RoutineOccurrence } from '../src/core/routines.js'
import { spaceDeps } from './helpers/space.js'
import { createLogger } from '../src/log.js'

const NOW = 1_800_000_000_000
const registries: Registry[] = []
afterEach(() => { for (const registry of registries.splice(0)) registry.close() })

function setup() {
  const registry = new Registry(':memory:'); registries.push(registry)
  const routines = new RoutineStore(registry.db), attempts = new RunAttempts(registry.db), calls = new RunApiCalls(registry.db)
  ensureDeliverySchema(registry.db)
  const { spaces } = spaceDeps(registry.db)
  const space = spaces.ensure({ kind: 'group', chatId: 'oc_team', openId: 'ou_owner' })
  let now = NOW
  const app = new RoutineApplication({ registry, routines, spaces, attempts, activeRuns: () => [], now: () => now })
  const add = (patch: Partial<Parameters<RoutineStore['add']>[0]> = {}) => routines.add({ kind: 'watch', ownerOpenId: 'ou_owner', runAs: 'ou_owner',
    spaceId: space.id, chatId: space.chatId!, chatType: 'group', name: '盯产品群', prompt: '只报等我拍板的事', watchChatIds: ['oc_team'],
    schedule: { type: 'interval', everyMinutes: 30 }, now: NOW, ...patch })
  /** A real scheduled start: claim → start → the host begins the routine Run with the execution key. */
  /** Like ensureAcpSession: managed runs route every effect through the gateway ledger; workspace runs do not. */
  const running = (routine: Routine, boundary: 'managed_api_v1' | 'workspace' | null = 'managed_api_v1'): { occurrence: RoutineOccurrence; runId: string } => {
    const occurrence = routines.claimDueOccurrence(routine.id, routine.nextRunAt, routine.nextRunAt)!
    routines.startOccurrence(occurrence.id, routine.nextRunAt)
    const key = routineExecutionKey(routine.id, { occurrenceId: occurrence.id, configVersion: occurrence.configVersion })
    const run = attempts.begin({ workKey: `routine:${routine.id}`, sessionKey: `routine-session-${routine.id}`, triggerKey: key, stage: 'routine', actorOpenId: 'ou_owner', now })!
    if (boundary) attempts.bindExecutionBoundary(run.id, boundary)
    return { occurrence, runId: run.id }
  }
  const call = (runId: string, route: string, scopes: string[], state: 'returned' | 'started' = 'returned') => {
    const id = calls.begin(runId, route, now); for (const scope of scopes) calls.need(id, scope)
    if (state === 'returned') calls.finish(id, 'returned', now)
  }
  const delivered = (routine: Routine, occurrence: RoutineOccurrence, status: 'planned' | 'sent' | 'unknown') => {
    const key = routineExecutionKey(routine.id, { occurrenceId: occurrence.id, configVersion: occurrence.configVersion })
    registry.db.prepare(`INSERT INTO deliveries(delivery_key,context_ref,signature,status,actor_open_id,audience,source_refs,grant_ids,payload_digest,created_at,updated_at)
      VALUES (?,?,'sig',?, 'ou_owner','{}','[]','[]','digest',?,?)`).run(`${key}:digest`, key, status, now, now)
  }
  return { registry, routines, app, space, add, running, call, delivered, tick: (ms: number) => { now += ms }, get now() { return now } }
}

describe('restart continues a periodic responsibility only when no outbound effect was recorded', () => {
  it('a periodic watch interrupted while only reading continues from the same cursor after restart', () => {
    const t = setup(), routine = t.add()
    t.registry.db.prepare('UPDATE routines SET message_cursor_sec = 1790000000 WHERE id = ?').run(routine.id)
    const { occurrence, runId } = t.running(t.routines.get(routine.id)!)
    t.call(runId, 'POST /v1/chat/history', ['chat:read', 'thread:read'])
    expect(t.routines.recoverInterruptedOccurrences(NOW + 60_000)).toEqual([])
    expect(t.routines.getOccurrence(occurrence.id)).toMatchObject({ status: 'cancelled', error: expect.stringContaining('没有记录这次执行的外部操作') })
    expect(t.routines.get(routine.id)).toMatchObject({ enabled: true, disabledReason: null, messageCursorSec: 1790000000 })
    expect(t.routines.resumeState(routine.id)?.kind).toBe('enabled')
  })

  it.each([
    ['a returned write call', (t: ReturnType<typeof setup>, _r: Routine, _o: RoutineOccurrence, runId: string) => t.call(runId, 'POST /v1/todo/add', ['todo:write'])],
    ['a write call still in flight', (t: ReturnType<typeof setup>, _r: Routine, _o: RoutineOccurrence, runId: string) => t.call(runId, 'POST /v1/doc/append', ['doc:write'], 'started')],
    ['a host document write', (t: ReturnType<typeof setup>, _r: Routine, _o: RoutineOccurrence, runId: string) => t.call(runId, 'HOST /documents/prepend', ['doc:write'])],
    ['a planned delivery', (t: ReturnType<typeof setup>, r: Routine, o: RoutineOccurrence) => t.delivered(r, o, 'planned')],
    ['a sent delivery', (t: ReturnType<typeof setup>, r: Routine, o: RoutineOccurrence) => t.delivered(r, o, 'sent')],
  ] as const)('still requires inspection after %s', (_name, record) => {
    const t = setup(), routine = t.add(), { occurrence, runId } = t.running(t.routines.get(routine.id)!)
    record(t, routine, occurrence, runId)
    expect(t.routines.recoverInterruptedOccurrences(NOW + 60_000)).toMatchObject([{ id: occurrence.id, status: 'interrupted' }])
    expect(t.routines.get(routine.id)).toMatchObject({ enabled: false })
    expect(t.routines.resumeState(routine.id)?.kind).toBe('inspect_previous_run')
  })

  it.each(['workspace', null] as const)('a %s execution boundary is not evidence of no effect: shell and network work bypass the gateway ledger', boundary => {
    const t = setup(), routine = t.add(), { occurrence, runId } = t.running(t.routines.get(routine.id)!, boundary)
    t.call(runId, 'POST /v1/chat/history', ['chat:read'])
    expect(t.routines.recoverInterruptedOccurrences(NOW + 60_000)).toMatchObject([{ id: occurrence.id, status: 'interrupted' }])
    expect(t.routines.get(routine.id)).toMatchObject({ enabled: false })
  })

  it('a started one-time reminder still requires inspection; it is never replayed automatically', () => {
    const t = setup(), routine = t.add({ kind: 'schedule', watchChatIds: undefined, schedule: { type: 'once', atMs: NOW + 1000 } })
    t.running(t.routines.get(routine.id)!)
    expect(t.routines.recoverInterruptedOccurrences(NOW + 60_000)).toHaveLength(1)
    expect(t.routines.get(routine.id)?.enabled).toBe(false)
  })

  it('an occurrence claimed but never started is cancelled; the periodic plan continues and a one-time reminder is re-armed', () => {
    const t = setup(), periodic = t.add(), once = t.add({ kind: 'schedule', watchChatIds: undefined, name: '一次性提醒', schedule: { type: 'once', atMs: NOW + 1000 } })
    const claimed = t.routines.claimDueOccurrence(periodic.id, periodic.nextRunAt, periodic.nextRunAt)!
    const onceClaim = t.routines.claimDueOccurrence(once.id, once.nextRunAt, once.nextRunAt)!
    expect(t.routines.get(once.id)?.enabled).toBe(false)
    expect(t.routines.recoverInterruptedOccurrences(NOW + 60_000)).toEqual([])
    expect(t.routines.getOccurrence(claimed.id)?.status).toBe('cancelled')
    expect(t.routines.getOccurrence(onceClaim.id)?.status).toBe('cancelled')
    expect(t.routines.get(periodic.id)?.enabled).toBe(true)
    expect(t.routines.get(once.id)).toMatchObject({ enabled: true, disabledReason: null, nextRunAt: NOW + 1000 })
    const again = t.routines.claimDueOccurrence(once.id, NOW + 1000, NOW + 60_000)
    expect(again).toMatchObject({ status: 'pending', scheduledAt: NOW + 1000 })
  })
})

describe('pause until a time', () => {
  it('pauses with a resume time and resumes automatically through the same checks as a manual resume', () => {
    const t = setup(), routine = t.add(), monday = NOW + 3 * 86_400_000
    const paused = t.app.persistControl(routine.id, 'pause', { resumeAt: monday })
    paused.afterCommit()
    expect(paused.routine).toMatchObject({ enabled: false, disabledReason: '手动停用', resumeAt: monday })
    expect(t.app.resumeDue()).toEqual({ resumed: [], stillPaused: [] })
    t.tick(3 * 86_400_000)
    const version = t.routines.configVersion(routine.id)!
    const result = t.app.resumeDue()
    expect(result.resumed.map(item => item.id)).toEqual([routine.id])
    expect(t.routines.get(routine.id)).toMatchObject({ enabled: true, disabledReason: null, resumeAt: null })
    expect(t.routines.configVersion(routine.id)).toBe(version + 1)
    expect(t.routines.get(routine.id)!.nextRunAt).toBeGreaterThan(t.now)
    expect(t.app.resumeDue()).toEqual({ resumed: [], stillPaused: [] })
  })

  it('a due resume that fails its checks stays paused, reports the reason once and does not loop', () => {
    const t = setup(), routine = t.add()
    t.app.persistControl(routine.id, 'pause', { resumeAt: NOW + 3600_000 }).afterCommit()
    t.registry.db.prepare("UPDATE space_rooms SET status = 'archived' WHERE id = ?").run(t.space.id)
    t.tick(3600_000)
    const result = t.app.resumeDue()
    expect(result.resumed).toEqual([])
    expect(result.stillPaused).toMatchObject([{ routine: { id: routine.id }, reason: expect.stringContaining('空间') }])
    expect(t.routines.get(routine.id)).toMatchObject({ enabled: false, disabledReason: '手动停用', resumeAt: null })
    expect(t.app.resumeDue()).toEqual({ resumed: [], stillPaused: [] })
  })

  it('an explicit manual resume or a new pause without a time clears the automatic resume', () => {
    const t = setup(), routine = t.add()
    t.app.persistControl(routine.id, 'pause', { resumeAt: NOW + 3600_000 }).afterCommit()
    t.app.persistControl(routine.id, 'pause').afterCommit()
    expect(t.routines.get(routine.id)?.resumeAt).toBeNull()
    t.app.persistControl(routine.id, 'pause', { resumeAt: NOW + 7200_000 }).afterCommit()
    expect(t.routines.get(routine.id)?.resumeAt).toBe(NOW + 7200_000)
    t.app.persistControl(routine.id, 'resume').afterCommit()
    expect(t.routines.get(routine.id)).toMatchObject({ enabled: true, resumeAt: null })
  })

  it('rejects a past, malformed or too distant resume time and resume times on non-pause actions', () => {
    const t = setup(), routine = t.add()
    for (const resumeAt of [NOW - 1, NOW, 1.5, NOW + MAX_PAUSE_MS + 1]) {
      expect(() => t.app.persistControl(routine.id, 'pause', { resumeAt })).toThrow(RoutineControlError)
    }
    expect(() => t.app.persistControl(routine.id, 'resume', { resumeAt: NOW + 1000 })).toThrow(RoutineControlError)
    expect(t.routines.get(routine.id)).toMatchObject({ enabled: true, resumeAt: null })
  })

  it('does not let “pause until Monday” become a one-time schedule that can never resume', () => {
    const t = setup(), routine = t.add()
    expect(() => t.routines.update(routine.id, { schedule: { type: 'once', atMs: NOW + 86_400_000 } })).toThrow(/暂停并设置恢复时间/)
    expect(t.routines.get(routine.id)?.schedule).toEqual({ type: 'interval', everyMinutes: 30 })
  })

  it('another reason for stopping drops the agreed resume time instead of promising a resume that will not happen', () => {
    const t = setup(), zero = t.add(), archived = t.add({ name: '空间停用' })
    for (const routine of [zero, archived]) t.app.persistControl(routine.id, 'pause', { resumeAt: NOW + 86_400_000 }).afterCommit()
    t.routines.update(zero.id, { schedule: { type: 'interval', everyMinutes: 0 } })
    t.routines.pauseForSpace(t.space.id, t.space.chatId!, NOW)
    for (const routine of [zero, archived]) {
      expect(t.routines.get(routine.id)?.resumeAt).toBeNull()
      const progress = routineProgress(t.routines, t.routines.get(routine.id)!, t.registry.db)
      expect(progress.resume_at).toBeNull(); expect(progress.fact_summary).not.toContain('暂停至')
    }
  })

  it('shows the automatic resume time in the persisted progress', () => {
    const t = setup(), routine = t.add(), monday = NOW + 3 * 86_400_000
    t.app.persistControl(routine.id, 'pause', { resumeAt: monday }).afterCommit()
    const progress = routineProgress(t.routines, t.routines.get(routine.id)!, t.registry.db)
    expect(progress).toMatchObject({ resume_at: new Date(monday).toISOString(), next_run_at: null })
    expect(progress.fact_summary).toContain('暂停至')
  })
})

describe('failure bookkeeping', () => {
  it('keeps the last successful time for the next schedule window and reports an automatic stop once', async () => {
    const t = setup(), routine = t.add({ kind: 'schedule', watchChatIds: undefined, schedule: { type: 'interval', everyMinutes: 10 } })
    t.routines.recordRun(routine.id, 'ok', NOW + 1000)
    const disabled: { id: number; reason: string }[] = []
    let clock = NOW + 10 * 60_000
    const scheduler = new RoutineScheduler({ store: t.routines, now: () => clock, log: createLogger('routine-failures', 'error'),
      run: async () => { throw new Error('model unavailable') }, onDisabled: (item, reason) => disabled.push({ id: item.id, reason }) })
    for (let i = 0; i < 3; i++) { await scheduler.tick(); clock += 10 * 60_000 }
    expect(t.routines.get(routine.id)).toMatchObject({ enabled: false, lastSuccessAt: NOW + 1000, lastStatus: 'failed', failCount: 3 })
    expect(disabled).toEqual([{ id: routine.id, reason: expect.stringContaining('连续失败 3 次') }])
    await scheduler.tick()
    expect(disabled).toHaveLength(1)
  })
})
