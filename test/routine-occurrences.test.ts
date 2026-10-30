import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { routineExecutionKey } from '../src/core/execution-keys.js'
import { Registry } from '../src/core/registry.js'
import { AUTH_EXPIRED, ROUTINE_INTERRUPTED, RoutineScheduler, RoutineStore, occurrenceWindowKey } from '../src/core/routines.js'
import { createLogger } from '../src/log.js'

const log = createLogger('routine-occurrences-test', 'error')
const T0 = Date.UTC(2026, 8, 18)
const INTERVAL = 10 * 60_000

function add(store: RoutineStore, name = '日报') {
  return store.add({ kind: 'schedule', ownerOpenId: 'ou_owner', chatId: 'oc_g', chatType: 'group', name, prompt: '总结本群', schedule: { type: 'interval', everyMinutes: 10 }, now: T0 })
}

describe('durable routine occurrences (single scheduler)', () => {
  it('rolls back the occurrence if advancing the cursor fails, and composes with a caller transaction', () => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    const r = add(store)
    registry.db.exec("CREATE TRIGGER reject_advance BEFORE UPDATE OF next_run_at ON routines BEGIN SELECT RAISE(ABORT, 'disk write failed'); END")
    expect(() => store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)).toThrow('disk write failed')
    expect(store.listOccurrences(r.id)).toEqual([])
    expect(store.get(r.id)?.nextRunAt).toBe(r.nextRunAt)
    registry.db.exec('DROP TRIGGER reject_advance')

    registry.db.exec('BEGIN')
    expect(store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)?.status).toBe('pending')
    expect(store.get(r.id)?.nextRunAt).toBe(r.nextRunAt + INTERVAL)
    registry.db.exec('ROLLBACK')
    expect(store.listOccurrences(r.id)).toEqual([])
    expect(store.get(r.id)?.nextRunAt).toBe(r.nextRunAt)
    registry.close()
  })

  it('after restart a never-started window runs normally, while a started one with no execution record is not replayed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-occurrence-restart-'))
    const path = join(dir, 'registry.sqlite')
    let registry = new Registry(path)
    try {
      let store = new RoutineStore(registry.db)
      const pending = add(store, '尚未开始')
      const running = add(store, '可能已经产生操作')
      store.claimDueOccurrence(pending.id, pending.nextRunAt, pending.nextRunAt)
      const occurrence = store.claimDueOccurrence(running.id, running.nextRunAt, running.nextRunAt)!
      store.startOccurrence(occurrence.id, running.nextRunAt)
      registry.close()
      registry = new Registry(path)
      store = new RoutineStore(registry.db)

      let ownsScheduler = false
      let executions = 0
      let now = T0 + 2 * INTERVAL
      const scheduler = new RoutineScheduler({ store, log, now: () => now, enabled: () => ownsScheduler, run: async () => { executions += 1; return 'ok' } })
      expect(await scheduler.tick()).toBe(0)
      expect(store.getOccurrence(occurrence.id)?.status).toBe('running')
      ownsScheduler = true
      // Nothing ran in the claimed-but-unstarted window: cancel it and keep the plan (G1, 2026-09-23).
      expect(await scheduler.tick()).toBe(1)
      expect(store.listOccurrences(pending.id).map((o) => o.status)).toEqual(['ok', 'cancelled'])
      expect(store.get(pending.id)).toMatchObject({ enabled: true, runs: 1 })
      // The started run has no Run/ledger record in this store: that is not evidence of no effect.
      expect(store.listOccurrences(running.id)).toHaveLength(1)
      expect(store.listOccurrences(running.id)[0]?.status).toBe('interrupted')
      expect(store.get(running.id)).toMatchObject({ enabled: false, disabledReason: ROUTINE_INTERRUPTED, lastRunAt: null, runs: 0 })
      expect(store.recoverInterruptedOccurrences(now)).toEqual([])
      // 旧执行稍后回报成功，也不能覆盖“结果未知”或补记一次成功。
      expect(store.finishOccurrence(occurrence.id, 'ok', now)).toBeUndefined()
      expect(await scheduler.tick()).toBe(0)
      expect(executions).toBe(1)

      store.setEnabled(running.id, true, now)
      now += INTERVAL
      expect(await scheduler.tick()).toBe(2)
      expect(executions).toBe(3)
      expect(store.listOccurrences(running.id).map((o) => o.status)).toEqual(['ok', 'interrupted'])
      expect(store.get(running.id)?.runs).toBe(1)
    } finally {
      registry.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not claim, start or count the same occurrence twice', () => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    const r = add(store)
    const occurrence = store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    expect(occurrence).toMatchObject({ routineId: r.id, scheduledAt: r.nextRunAt, configVersion: 1, status: 'pending' })
    expect(store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)).toBeUndefined()
    expect(store.startOccurrence(occurrence.id, r.nextRunAt)?.id).toBe(r.id)
    expect(store.startOccurrence(occurrence.id, r.nextRunAt)).toBeUndefined()
    expect(store.finishOccurrence(occurrence.id, 'ok', r.nextRunAt + 100)?.runs).toBe(1)
    expect(store.finishOccurrence(occurrence.id, 'failed', r.nextRunAt + 200, 'late duplicate')).toBeUndefined()
    expect(store.get(r.id)).toMatchObject({ runs: 1, lastStatus: 'ok', failCount: 0 })
    expect(store.getOccurrence(occurrence.id)).toMatchObject({ status: 'ok', finishedAt: r.nextRunAt + 100, error: null })
    registry.close()
  })

  it('cancels pending work on pause, deletion and schedule change; resuming does not revive old pending work', () => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    for (const mutation of ['pause', 'delete', 'reschedule'] as const) {
      const r = add(store, mutation)
      const occurrence = store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
      if (mutation === 'pause') {
        store.setEnabled(r.id, false, r.nextRunAt)
        store.setEnabled(r.id, true, r.nextRunAt)
      } else if (mutation === 'delete') store.remove(r.id)
      else store.update(r.id, { schedule: { type: 'interval', everyMinutes: 30 } }, r.nextRunAt)
      expect(store.startOccurrence(occurrence.id, r.nextRunAt)).toBeUndefined()
      expect(store.getOccurrence(occurrence.id)?.status).toBe('cancelled')
    }
    registry.close()
  })

  it('rechecks stale due snapshots after another run paused or deleted the next routines', async () => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    const a = add(store, '第一项')
    const b = add(store, '暂停')
    const c = add(store, '删除')
    const executed: number[] = []
    const scheduler = new RoutineScheduler({ store, log, now: () => a.nextRunAt, run: async (r) => {
      executed.push(r.id)
      store.setEnabled(b.id, false, a.nextRunAt)
      store.remove(c.id)
      return 'ok'
    } })
    expect(await scheduler.tick()).toBe(1)
    expect(executed).toEqual([a.id])
    expect(store.listOccurrences(b.id)).toEqual([])
    expect(store.listOccurrences(c.id)).toEqual([])
    registry.close()
  })

  it('keeps a manually paused occurrence cancelled when a late success returns', async () => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    const r = store.add({ kind: 'followup', ownerOpenId: 'ou_owner', chatId: 'oc_g', chatType: 'group', name: '一次', prompt: '跟进', schedule: { type: 'once', atMs: T0 + INTERVAL }, now: T0 })
    let finish!: () => void
    const wait = new Promise<void>((resolve) => { finish = resolve })
    const scheduler = new RoutineScheduler({ store, log, now: () => r.nextRunAt, run: async (snapshot) => {
      expect(snapshot.enabled).toBe(true)
      await wait
      return 'ok'
    } })
    const firstTick = scheduler.tick()
    expect(store.listOccurrences(r.id)[0]?.status).toBe('running')
    const next = store.get(r.id)?.nextRunAt
    store.setEnabled(r.id, false, r.nextRunAt)
    expect(await scheduler.tick()).toBe(0)
    finish()
    expect(await firstTick).toBe(1)
    expect(store.get(r.id)).toMatchObject({ enabled: false, disabledReason: '手动停用', nextRunAt: next, runs: 0, lastStatus: null })
    expect(store.listOccurrences(r.id)[0]?.status).toBe('cancelled')
    expect(await scheduler.tick()).toBe(0)
    registry.close()
  })

  it('reports that an edited in-flight one-shot needs enabling instead of claiming it is still pending', () => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    const r = store.add({ kind: 'followup', ownerOpenId: 'ou_owner', chatId: 'oc_g', chatType: 'group', name: '一次', prompt: '跟进', schedule: { type: 'once', atMs: T0 + INTERVAL }, now: T0 })
    const occurrence = store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    store.startOccurrence(occurrence.id, r.nextRunAt)
    store.update(r.id, { prompt: '只检查发布版本' }, r.nextRunAt)
    expect(store.finishOccurrence(occurrence.id, 'ok', r.nextRunAt)).toBeUndefined()
    expect(store.getOccurrence(occurrence.id)?.status).toBe('cancelled')
    expect(store.get(r.id)).toMatchObject({ enabled: false, runs: 0, disabledReason: '职责配置已修改，请重新启用' })
    expect(store.due(r.nextRunAt + INTERVAL)).toEqual([])
    registry.close()
  })

  it('runs a once window once even when a re-enable points the schedule at it again; a later instant is a new window', async () => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    const r = store.add({ kind: 'schedule', chatId: 'oc_g', chatType: 'group', name: '一次', prompt: '总结', schedule: { type: 'once', atMs: T0 + INTERVAL }, now: T0 })
    let now = r.nextRunAt
    const scheduler = new RoutineScheduler({ store, log, now: () => now, run: async () => 'ok' })
    expect(await scheduler.tick()).toBe(1)
    expect(await scheduler.tick()).toBe(0)
    expect(store.get(r.id)).toMatchObject({ enabled: false, disabledReason: '一次性任务已执行', runs: 1 })
    // Re-enabling at the same instant is a configuration bump, not a new window: the recorded window is not executed twice.
    store.setEnabled(r.id, true, now)
    expect(store.get(r.id)).toMatchObject({ enabled: true, nextRunAt: r.nextRunAt })
    expect(await scheduler.tick()).toBe(0)
    expect(store.listOccurrences(r.id).map((o) => [o.scheduledAt, o.configVersion, o.status])).toEqual([[r.nextRunAt, 1, 'ok']])
    expect(store.get(r.id)).toMatchObject({ enabled: false, disabledReason: '一次性任务已执行', runs: 1 })
    // A later instant is a different window and runs under the configuration current at that time.
    now += 1
    store.setEnabled(r.id, true, now)
    expect(await scheduler.tick()).toBe(1)
    expect(store.listOccurrences(r.id).map((o) => [o.scheduledAt, o.windowKey, o.configVersion, o.status])).toEqual([
      [r.nextRunAt + 1, new Date(r.nextRunAt + 1).toISOString(), 3, 'ok'], [r.nextRunAt, new Date(r.nextRunAt).toISOString(), 1, 'ok'],
    ])
    expect(store.get(r.id)?.runs).toBe(2)
    registry.close()
  })

  it('records skipped catch-up without changing the read cursor, and follows existing repeated failure policy', async () => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    const r = add(store)
    let now = T0 + 5 * INTERVAL
    let executions = 0
    const scheduler = new RoutineScheduler({ store, log, now: () => now, catchUpWindowMs: INTERVAL, run: async () => { executions += 1; throw new Error('failed normally') } })
    expect(await scheduler.tick()).toBe(0)
    expect(store.listOccurrences(r.id)[0]).toMatchObject({ scheduledAt: r.nextRunAt, status: 'skipped', startedAt: null })
    expect(store.get(r.id)).toMatchObject({ lastRunAt: null, runs: 0, enabled: true })
    for (let i = 0; i < 3; i += 1) {
      now += INTERVAL
      expect(await scheduler.tick()).toBe(1)
    }
    expect(executions).toBe(3)
    expect(store.get(r.id)).toMatchObject({ enabled: false, runs: 3, failCount: 3 })
    expect(store.get(r.id)?.disabledReason).toContain('连续失败 3 次')
    expect(store.listOccurrences(r.id).map((o) => o.status)).toEqual(['failed', 'failed', 'failed', 'skipped'])
    registry.close()
  })

  it('does not misclassify a completion commit failure as a retryable execution failure', async () => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    const r = add(store)
    let externalEffects = 0
    registry.db.exec("CREATE TRIGGER reject_completion BEFORE UPDATE OF runs ON routines BEGIN SELECT RAISE(ABORT, 'commit failed'); END")
    const scheduler = new RoutineScheduler({ store, log, now: () => r.nextRunAt, run: async () => { externalEffects += 1; return 'ok' } })
    await expect(scheduler.tick()).rejects.toThrow('commit failed')
    expect(externalEffects).toBe(1)
    expect(store.listOccurrences(r.id)[0]?.status).toBe('running')
    expect(store.get(r.id)).toMatchObject({ runs: 0, failCount: 0, lastStatus: null })
    registry.db.exec('DROP TRIGGER reject_completion')
    // 同一进程下一轮也先处理未落账状态，不能卡成一个表面仍启用、永远不再跑的职责。
    expect(await scheduler.tick()).toBe(0)
    expect(externalEffects).toBe(1)
    expect(store.listOccurrences(r.id)[0]?.status).toBe('interrupted')
    registry.close()
  })

  it.each(['interval', 'once'] as const)('preserves the watch read cursor when auth expires during a %s occurrence', async (kind) => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    const r = store.add({ kind: 'watch', ownerOpenId: 'ou_owner', chatId: 'oc_dm', chatType: 'p2p', name: '关注', prompt: '看新消息', schedule: kind === 'once' ? { type: 'once', atMs: T0 + INTERVAL } : { type: 'interval', everyMinutes: 10 }, now: T0 })
    store.recordRun(r.id, 'ok', T0 + 1000)
    let now = r.nextRunAt
    let authorized = false
    let readFrom: number | null | undefined
    const scheduler = new RoutineScheduler({ store, log, now: () => now, run: async (routine) => {
      if (!authorized) {
        store.suspendForExpiredAuth('ou_owner', now)
        return 'skipped'
      }
      readFrom = routine.lastRunAt
      return 'ok'
    } })
    expect(await scheduler.tick()).toBe(1)
    expect(store.listOccurrences(r.id)[0]).toMatchObject({ status: 'skipped', error: AUTH_EXPIRED })
    expect(store.get(r.id)).toMatchObject({ enabled: false, disabledReason: AUTH_EXPIRED, lastRunAt: T0 + 1000, lastStatus: 'ok', runs: 1 })
    authorized = true
    // Re-authorization completes after the failed window; the retry is a new window, the recorded one is not re-run.
    now += 1
    store.resumeAfterAuth('ou_owner', now)
    now = store.get(r.id)!.nextRunAt
    expect(await scheduler.tick()).toBe(1)
    expect(readFrom).toBe(T0 + 1000)
    expect(store.listOccurrences(r.id).map((o) => [o.status, o.windowKey])).toEqual([['ok', new Date(now).toISOString()], ['skipped', new Date(r.nextRunAt).toISOString()]])
    registry.close()
  })
})

/** Pre-window schema: configuration version was part of the occurrence identity. */
function legacyOccurrenceSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE routines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, owner_open_id TEXT, chat_id TEXT NOT NULL, chat_type TEXT NOT NULL,
    name TEXT NOT NULL, prompt TEXT NOT NULL, schedule TEXT NOT NULL, watch_chat_ids TEXT NOT NULL DEFAULT '[]', deliver_to TEXT NOT NULL DEFAULT 'chat',
    enabled INTEGER NOT NULL DEFAULT 1, disabled_reason TEXT, next_run_at INTEGER NOT NULL, last_run_at INTEGER, last_status TEXT, last_error TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    session_key TEXT, run_as TEXT, status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT 'user', expires_at INTEGER, decided_by TEXT,
    decided_at INTEGER, card_message_id TEXT, space_id TEXT, config_version INTEGER NOT NULL DEFAULT 1, message_cursor_sec INTEGER,
    delivery_policy TEXT NOT NULL DEFAULT 'when_nonempty', feedback_id INTEGER);
  CREATE INDEX idx_routines_due ON routines(enabled, next_run_at);
  CREATE INDEX idx_routines_chat ON routines(chat_id);
  CREATE INDEX idx_routines_feedback ON routines(feedback_id, space_id);
  CREATE TABLE routine_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT, routine_id INTEGER NOT NULL, scheduled_at INTEGER NOT NULL, config_version INTEGER NOT NULL,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, error TEXT,
    UNIQUE (routine_id, scheduled_at, config_version));
  CREATE INDEX idx_routine_occurrences_status ON routine_occurrences(status);
  CREATE INDEX idx_routine_occurrences_routine ON routine_occurrences(routine_id, id);
  CREATE TABLE deliveries (delivery_key TEXT PRIMARY KEY, context_ref TEXT, status TEXT NOT NULL, remote_id TEXT);`)
  db.prepare(`INSERT INTO routines (id, kind, owner_open_id, run_as, chat_id, chat_type, name, prompt, schedule, next_run_at, created_at, config_version, enabled, disabled_reason, runs, last_run_at, last_status)
    VALUES (1, 'schedule', 'ou_owner', 'ou_owner', 'oc_g', 'group', '日报', 'SYNTHETIC_ORIGINAL_PROMPT', ?, ?, ?, 3, 1, NULL, 3, ?, 'ok'),
           (2, 'schedule', 'ou_owner', 'ou_owner', 'oc_g', 'group', '一次', '一次性总结', ?, ?, ?, 2, 0, '一次性任务已执行', 2, ?, 'ok')`)
    .run(JSON.stringify({ type: 'interval', everyMinutes: 10 }), T0 + 5 * INTERVAL, T0, T0 + 4 * INTERVAL,
      JSON.stringify({ type: 'once', atMs: T0 + INTERVAL }), T0 + INTERVAL, T0, T0 + INTERVAL + 5000)
  const insert = db.prepare('INSERT INTO routine_occurrences (id, routine_id, scheduled_at, config_version, status, created_at, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  insert.run(1, 1, T0 + INTERVAL, 1, 'ok', T0 + INTERVAL, T0 + INTERVAL, T0 + INTERVAL + 1000, null)
  insert.run(2, 1, T0 + 2 * INTERVAL, 1, 'failed', T0 + 2 * INTERVAL, T0 + 2 * INTERVAL, T0 + 2 * INTERVAL + 1000, 'SYNTHETIC_ORIGINAL_ERROR')
  // A cancelled row and the later completed row of the same window: not a collision.
  insert.run(3, 1, T0 + 3 * INTERVAL, 2, 'cancelled', T0 + 3 * INTERVAL, null, T0 + 3 * INTERVAL, '职责配置已修改')
  insert.run(4, 1, T0 + 3 * INTERVAL, 3, 'ok', T0 + 3 * INTERVAL, T0 + 3 * INTERVAL, T0 + 3 * INTERVAL + 1000, null)
  // Two completed executions of one once window under different configuration versions: the old identity allowed it.
  insert.run(5, 2, T0 + INTERVAL, 1, 'ok', T0 + INTERVAL, T0 + INTERVAL, T0 + INTERVAL + 1000, null)
  insert.run(6, 2, T0 + INTERVAL, 2, 'ok', T0 + INTERVAL + 5000, T0 + INTERVAL + 5000, T0 + INTERVAL + 6000, null)
  insert.run(7, 1, T0 + 4 * INTERVAL, 3, 'skipped', T0 + 4 * INTERVAL, null, T0 + 4 * INTERVAL, '超过补跑窗口，未执行')
  const delivery = db.prepare('INSERT INTO deliveries (delivery_key, context_ref, status, remote_id) VALUES (?, ?, ?, ?)')
  delivery.run('routine:1:occurrence:1:v1:digest', 'routine:1:occurrence:1:v1', 'sent', 'om_legacy_1')
  delivery.run('routine:2:occurrence:5:v1:digest', 'routine:2:occurrence:5:v1', 'sent', 'om_legacy_5')
  delivery.run('routine:2:occurrence:6:v2:digest', 'routine:2:occurrence:6:v2', 'unknown', null)
}

const LEGACY_COLUMNS = 'id, routine_id, scheduled_at, config_version, status, created_at, started_at, finished_at, error'

describe('occurrence identity is the logical execution window, configuration version is a snapshot', () => {
  it('keeps a pending window across configuration-only edits and starts it with the configuration current at start', () => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    const r = add(store)
    const claimed = store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    expect(claimed).toMatchObject({ configVersion: 1, status: 'pending', windowKey: occurrenceWindowKey(r.nextRunAt), windowDuplicateOf: null })
    expect(claimed.windowKey).toBe(new Date(r.nextRunAt).toISOString())
    store.update(r.id, { prompt: '新的指令' }, r.nextRunAt)
    store.update(r.id, { name: '新的名字', deliveryPolicy: 'every_run' }, r.nextRunAt)
    expect(store.configVersion(r.id)).toBe(3)
    expect(store.getOccurrence(claimed.id)).toMatchObject({ status: 'pending', configVersion: 1, windowKey: claimed.windowKey })
    expect(store.listOccurrences(r.id)).toHaveLength(1)
    expect(store.due(r.nextRunAt)).toEqual([])
    const started = store.startOccurrence(claimed.id, r.nextRunAt + 1)
    expect(started).toMatchObject({ id: r.id, prompt: '新的指令', name: '新的名字', deliveryPolicy: 'every_run', nextRunAt: r.nextRunAt })
    const occurrence = store.getOccurrence(claimed.id)!
    expect(occurrence).toMatchObject({ id: claimed.id, status: 'running', configVersion: 3, windowKey: claimed.windowKey, scheduledAt: r.nextRunAt, startedAt: r.nextRunAt + 1 })
    expect(routineExecutionKey(r.id, { occurrenceId: occurrence.id, configVersion: occurrence.configVersion })).toBe(`routine:${r.id}:occurrence:${occurrence.id}:v3`)
    expect(store.currentForExecution(r.id, 3, occurrence.id)?.id).toBe(r.id)
    expect(store.currentForExecution(r.id, 1, occurrence.id)).toBeUndefined()
    expect(store.finishOccurrence(occurrence.id, 'ok', r.nextRunAt + 2)?.runs).toBe(1)
    expect(store.listOccurrences(r.id).map((o) => [o.windowKey, o.configVersion, o.status])).toEqual([[claimed.windowKey, 3, 'ok']])
    // The identity index no longer distinguishes configuration versions: a second row for the same window is rejected.
    expect(() => registry.db.prepare("INSERT INTO routine_occurrences (routine_id, scheduled_at, window_key, config_version, status, created_at) VALUES (?, ?, ?, 99, 'pending', ?)")
      .run(r.id, r.nextRunAt, claimed.windowKey, T0)).toThrow(/UNIQUE/)
    registry.close()
  })

  it('never rewrites a started occurrence: a configuration edit cancels the stale execution and keeps its window and snapshot', () => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    const r = add(store)
    const claimed = store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    store.startOccurrence(claimed.id, r.nextRunAt)
    const before = store.getOccurrence(claimed.id)!
    store.update(r.id, { prompt: '新的指令' }, r.nextRunAt + 5)
    expect(store.getOccurrence(claimed.id)).toEqual({ ...before, status: 'cancelled', finishedAt: r.nextRunAt + 5, error: '职责配置已修改' })
    expect(store.listOccurrences(r.id)).toHaveLength(1)
    expect(store.currentForExecution(r.id, 2, claimed.id)).toBeUndefined()
    expect(store.finishOccurrence(claimed.id, 'ok', r.nextRunAt + 6)).toBeUndefined()
    expect(store.get(r.id)?.runs).toBe(0)
    expect(store.configVersion(r.id)).toBe(2)
    registry.close()
  })

  it('cancels pending windows of the old schedule in the same transaction as the schedule change; the next claim is a new window', () => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    const r = add(store)
    const claimed = store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    registry.db.exec("CREATE TRIGGER reject_cancel BEFORE UPDATE OF status ON routine_occurrences WHEN NEW.status = 'cancelled' BEGIN SELECT RAISE(ABORT, 'synthetic cancel failure'); END")
    expect(() => store.update(r.id, { schedule: { type: 'interval', everyMinutes: 30 } }, r.nextRunAt)).toThrow('synthetic cancel failure')
    expect(store.get(r.id)).toMatchObject({ schedule: r.schedule, nextRunAt: r.nextRunAt + INTERVAL })
    expect(store.configVersion(r.id)).toBe(1)
    expect(store.getOccurrence(claimed.id)?.status).toBe('pending')
    registry.db.exec('DROP TRIGGER reject_cancel')
    const updated = store.update(r.id, { schedule: { type: 'interval', everyMinutes: 30 } }, r.nextRunAt)!
    expect(updated.nextRunAt).toBe(r.nextRunAt + 3 * INTERVAL)
    expect(store.getOccurrence(claimed.id)).toMatchObject({ id: claimed.id, status: 'cancelled', error: '职责调度已修改', scheduledAt: r.nextRunAt, windowKey: claimed.windowKey })
    expect(store.startOccurrence(claimed.id, r.nextRunAt)).toBeUndefined()
    expect(store.due(updated.nextRunAt).map((x) => x.id)).toEqual([r.id])
    const next = store.claimDueOccurrence(r.id, updated.nextRunAt, updated.nextRunAt)!
    expect(next).toMatchObject({ status: 'pending', scheduledAt: updated.nextRunAt, windowKey: occurrenceWindowKey(updated.nextRunAt), configVersion: 2 })
    expect(next.id).not.toBe(claimed.id)
    expect(next.windowKey).not.toBe(claimed.windowKey)
    expect(store.listOccurrences(r.id).map((o) => [o.id, o.status])).toEqual([[next.id, 'pending'], [claimed.id, 'cancelled']])
    registry.close()
  })

  it('lets a new schedule use an instant whose earlier occurrence was cancelled before it started', () => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    const r = store.add({ kind: 'schedule', chatId: 'oc_g', chatType: 'group', name: '一次', prompt: '总结', schedule: { type: 'once', atMs: T0 + INTERVAL }, now: T0 })
    const first = store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    store.update(r.id, { schedule: { type: 'once', atMs: T0 + 2 * INTERVAL } }, r.nextRunAt)
    expect(store.getOccurrence(first.id)).toMatchObject({ status: 'cancelled', error: '职责调度已修改' })
    store.update(r.id, { schedule: { type: 'once', atMs: T0 + INTERVAL } }, r.nextRunAt)
    store.setEnabled(r.id, true, r.nextRunAt)
    const second = store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    expect(second).toMatchObject({ status: 'pending', scheduledAt: first.scheduledAt, windowKey: first.windowKey })
    expect(second.id).not.toBe(first.id)
    expect(store.startOccurrence(second.id, r.nextRunAt)?.id).toBe(r.id)
    expect(store.listOccurrences(r.id).map((o) => [o.id, o.status])).toEqual([[second.id, 'running'], [first.id, 'cancelled']])
    registry.close()
  })

  it('constructs twice on a fresh database without schema or row changes', () => {
    const registry = new Registry(':memory:')
    const store = new RoutineStore(registry.db)
    const r = add(store)
    store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)
    const schema = () => registry.db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()
    const rows = () => registry.db.prepare('SELECT * FROM routine_occurrences ORDER BY id').all()
    const [before, occurrences] = [schema(), rows()]
    expect(before.some((row) => row.name === 'idx_routine_occurrences_window')).toBe(true)
    new RoutineStore(registry.db)
    expect(schema()).toEqual(before)
    expect(rows()).toEqual(occurrences)
    registry.close()
  })

  it('migrates legacy occurrences in place: same ids, same columns, derived window keys, explicit legacy collisions, no re-run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-occurrence-window-migration-'))
    const path = join(dir, 'registry.sqlite')
    const legacy = new DatabaseSync(path)
    legacyOccurrenceSchema(legacy)
    const originalOccurrences = legacy.prepare(`SELECT ${LEGACY_COLUMNS} FROM routine_occurrences ORDER BY id`).all()
    const originalRoutines = legacy.prepare('SELECT * FROM routines ORDER BY id').all()
    const originalDeliveries = legacy.prepare('SELECT * FROM deliveries ORDER BY delivery_key').all()
    legacy.close()
    let registry = new Registry(path)
    try {
      let store = new RoutineStore(registry.db)
      const db = () => registry.db
      expect(db().prepare(`SELECT ${LEGACY_COLUMNS} FROM routine_occurrences ORDER BY id`).all()).toEqual(originalOccurrences)
      // Old values unchanged; columns added later start empty and are never back-filled.
      // P4-2 G7 columns have NOT NULL defaults: legacy rows read as “no threshold, run when mentioned”, exactly the pre-column behaviour.
      expect(db().prepare('SELECT * FROM routines ORDER BY id').all()).toEqual(originalRoutines.map((row) => ({ ...row, resume_at: null, last_success_at: null, origin_task_id: null, min_new_messages: 0, always_on_mention: 1 })))
      expect(db().prepare('SELECT * FROM deliveries ORDER BY delivery_key').all()).toEqual(originalDeliveries)
      const windows = db().prepare('SELECT id, scheduled_at, window_key, window_duplicate_of FROM routine_occurrences ORDER BY id').all() as { id: number; scheduled_at: number; window_key: string; window_duplicate_of: number | null }[]
      expect(windows.map((row) => row.window_key)).toEqual(windows.map((row) => new Date(row.scheduled_at).toISOString()))
      expect(windows.map((row) => [row.id, row.window_duplicate_of])).toEqual([[1, null], [2, null], [3, null], [4, null], [5, 6], [6, null], [7, null]])
      expect(store.getOccurrence(5)).toMatchObject({ windowKey: occurrenceWindowKey(T0 + INTERVAL), windowDuplicateOf: 6, configVersion: 1, status: 'ok' })
      expect(store.getOccurrence(6)).toMatchObject({ windowKey: occurrenceWindowKey(T0 + INTERVAL), windowDuplicateOf: null, configVersion: 2, status: 'ok' })
      expect(db().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_routine_occurrences_window'").get()).toBeDefined()
      // Old execution keys still resolve to their original rows; nothing is recomputed.
      for (const [key, id, version] of [['routine:1:occurrence:1:v1', 1, 1], ['routine:2:occurrence:5:v1', 5, 1], ['routine:2:occurrence:6:v2', 6, 2]] as const) {
        const occurrence = store.getOccurrence(id)!
        expect(routineExecutionKey(occurrence.routineId, { occurrenceId: occurrence.id, configVersion: occurrence.configVersion })).toBe(key)
        expect(occurrence.configVersion).toBe(version)
      }

      const schema = () => db().prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()
      const everything = () => ['routines', 'routine_occurrences', 'deliveries'].map((table) => db().prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
      const [schemaAfterFirst, rowsAfterFirst] = [schema(), everything()]
      store = new RoutineStore(registry.db)
      expect(schema()).toEqual(schemaAfterFirst)
      expect(everything()).toEqual(rowsAfterFirst)
      registry.close(); registry = new Registry(path); store = new RoutineStore(registry.db)
      expect(schema()).toEqual(schemaAfterFirst)
      expect(everything()).toEqual(rowsAfterFirst)
      expect(db().prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok')
      // A partially applied upgrade (columns present, index missing, a key still NULL) converges to the same state.
      db().exec('DROP INDEX idx_routine_occurrences_window; UPDATE routine_occurrences SET window_key = NULL WHERE id = 2')
      store = new RoutineStore(registry.db)
      expect(schema()).toEqual(schemaAfterFirst)
      expect(everything()).toEqual(rowsAfterFirst)

      // Old windows are never re-run, even if the schedule points at one again; new windows still work.
      db().prepare('UPDATE routines SET next_run_at = ? WHERE id = 1').run(T0 + 3 * INTERVAL)
      expect(store.claimDueOccurrence(1, T0 + 3 * INTERVAL, T0 + 5 * INTERVAL)).toBeUndefined()
      expect(store.get(1)).toMatchObject({ enabled: true, nextRunAt: T0 + 6 * INTERVAL })
      expect(db().prepare('SELECT count(*) AS n FROM routine_occurrences').get()?.n).toBe(7)
      const fresh = store.claimDueOccurrence(1, T0 + 6 * INTERVAL, T0 + 6 * INTERVAL)!
      expect(fresh).toMatchObject({ id: 8, configVersion: 3, windowKey: occurrenceWindowKey(T0 + 6 * INTERVAL), windowDuplicateOf: null, status: 'pending' })
      store.setEnabled(2, true, T0 + INTERVAL)
      expect(store.claimDueOccurrence(2, T0 + INTERVAL, T0 + INTERVAL)).toBeUndefined()
      expect(store.get(2)).toMatchObject({ enabled: false, disabledReason: '一次性任务已执行', runs: 2 })
      expect(store.listOccurrences(2).map((o) => o.id)).toEqual([6, 5])
      expect(db().prepare(`SELECT ${LEGACY_COLUMNS} FROM routine_occurrences WHERE id <= 7 ORDER BY id`).all()).toEqual(originalOccurrences)
      expect(db().prepare('SELECT * FROM deliveries ORDER BY delivery_key').all()).toEqual(originalDeliveries)
    } finally {
      registry.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes the protected-copy guard twice when the real startup constructors upgrade a legacy occurrence database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-occurrence-window-guard-')), source = join(dir, 'old.db'), protection = join(dir, 'protected')
    try {
      const legacy = new DatabaseSync(source)
      try { legacyOccurrenceSchema(legacy) } finally { legacy.close() }
      // Mirrors src/index.ts: Registry first, then RoutineStore; nothing else boots.
      const adapter = join(dir, 'upgrade-routines.mjs')
      writeFileSync(adapter, `import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [repo, candidate] = process.argv.slice(2)
const req = createRequire(join(repo, 'package.json'))
const { register } = await import(pathToFileURL(req.resolve('tsx/esm/api')).href)
register()
const { Registry } = await import(pathToFileURL(join(repo, 'src/core/registry.ts')).href)
const { RoutineStore } = await import(pathToFileURL(join(repo, 'src/core/routines.ts')).href)
const registry = new Registry(candidate)
try { new RoutineStore(registry.db) } finally { registry.close() }
`)
      const guard = (...args: string[]) => {
        const run = spawnSync('python3', [resolve('scripts/database-migration-guard.py'), ...args], { encoding: 'utf8', timeout: 60_000 })
        expect(run.status, run.stdout + run.stderr).toBe(0)
        return { ...JSON.parse(run.stdout.trim()), output: run.stdout + run.stderr }
      }
      guard('backup', '--source', source, '--out-dir', protection)
      const result = guard('verify', '--protection-dir', protection, '--', process.execPath, adapter, resolve('.'))
      expect(result).toMatchObject({ passed: true, protected_backup_unchanged: true, old_business_rows: { equal: true }, second_upgrade_idempotent: { equal: true } })
      expect(result.passes.map((p: { exit_code: number }) => p.exit_code)).toEqual([0, 0])
      const candidate = new DatabaseSync(join(result.run_dir, 'candidate.db'), { readOnly: true })
      try {
        expect(candidate.prepare('SELECT id, window_key, window_duplicate_of FROM routine_occurrences ORDER BY id').all()).toEqual([1, 2, 3, 4, 5, 6, 7].map((id) => ({
          id, window_key: new Date(id === 2 ? T0 + 2 * INTERVAL : id === 3 || id === 4 ? T0 + 3 * INTERVAL : id === 7 ? T0 + 4 * INTERVAL : T0 + INTERVAL).toISOString(), window_duplicate_of: id === 5 ? 6 : null })))
        expect(candidate.prepare('SELECT delivery_key, status FROM deliveries ORDER BY delivery_key').all()).toEqual([
          { delivery_key: 'routine:1:occurrence:1:v1:digest', status: 'sent' }, { delivery_key: 'routine:2:occurrence:5:v1:digest', status: 'sent' }, { delivery_key: 'routine:2:occurrence:6:v2:digest', status: 'unknown' }])
      } finally { candidate.close() }
      expect(result.output).not.toContain('SYNTHETIC_ORIGINAL')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
