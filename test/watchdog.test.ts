import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WATCHDOG_LIMITS, decide, emptyState, flush, inspect, maintenanceActive, readState, writeState, type WatchdogFinding } from '../src/watchdog.js'
import { PROBE_CASES, runProbe } from '../src/probe.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const NOW = Date.parse('2026-09-28T10:00:00Z')

function database(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'friday-watchdog-')), db = new DatabaseSync(join(dir, 'friday.db'))
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  db.exec(`CREATE TABLE process_locks (name TEXT PRIMARY KEY, pid INTEGER, host TEXT, acquired_at INTEGER, heartbeat_at INTEGER);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT, created_at INTEGER, started_at INTEGER);
    CREATE TABLE deliveries (delivery_key TEXT PRIMARY KEY, status TEXT, created_at INTEGER);
    CREATE TABLE routine_occurrences (id INTEGER PRIMARY KEY, status TEXT, scheduled_at INTEGER, started_at INTEGER);
    CREATE TABLE run_attempts (id TEXT PRIMARY KEY, state TEXT, started_at INTEGER, finished_at INTEGER);`)
  // As in production: the gateway lock keeps its startup time; the scheduler lock of the same process is refreshed.
  db.prepare("INSERT INTO process_locks VALUES ('gateway', 1, 'host', ?, ?)").run(NOW - 3600_000, NOW - 3600_000)
  db.prepare("INSERT INTO process_locks VALUES ('scheduler', 1, 'host', ?, ?)").run(NOW - 3600_000, NOW - 5_000)
  return db
}

const healthy = { ok: true }
const codes = (findings: WatchdogFinding[]) => findings.map(finding => finding.code).sort()

describe('watchdog inspection reads only the gateway records', () => {
  it('finds nothing on a healthy, idle gateway and skips tables an older schema does not have', () => {
    const db = database()
    expect(inspect(db, NOW, healthy)).toEqual([])
    db.exec('DROP TABLE routine_occurrences; DROP TABLE run_attempts')
    expect(inspect(db, NOW, healthy)).toEqual([])
  })

  it('reports each stalled part with a plain description', () => {
    const db = database()
    db.prepare("UPDATE process_locks SET heartbeat_at=? WHERE name='scheduler'").run(NOW - 5 * 60_000)
    db.prepare("INSERT INTO tasks(status, created_at, started_at) VALUES ('queued', ?, NULL), ('queued', ?, NULL), ('running', ?, ?)")
      .run(NOW - 25 * 60_000, NOW - 60_000, NOW - 2 * 3600_000, NOW - 2 * 3600_000)
    db.prepare("INSERT INTO deliveries VALUES ('k1', 'planned', ?), ('k2', 'planned', ?), ('k3', 'sent', ?)").run(NOW - 11 * 60_000, NOW - 60_000, NOW - 3600_000)
    db.prepare("INSERT INTO routine_occurrences(status, scheduled_at, started_at) VALUES ('pending', ?, NULL)").run(NOW - 16 * 60_000)
    for (const [index, state] of ['failed', 'failed', 'failed'].entries()) {
      db.prepare('INSERT INTO run_attempts VALUES (?, ?, ?, ?)').run(`r${index}`, state, NOW - 600_000, NOW - 60_000 * (index + 1))
    }
    const findings = inspect(db, NOW, { ok: false, detail: '连不上' })
    expect(codes(findings)).toEqual(['delivery', 'health', 'heartbeat', 'queue', 'routine', 'runs_failing', 'stuck_task'])
    expect(findings.map(finding => finding.detail)).toEqual(expect.arrayContaining(['网关心跳 5 分钟没更新', '1 条请求排队超过 20 分钟',
      '1 条消息超过 10 分钟还没发出', '最近 3 次执行都失败了', '健康检查没通过（连不上）']))
  })

  it('does not call a mix of failed and completed runs a failure streak, nor a missing lock a healthy one', () => {
    const db = database()
    for (const [index, state] of ['failed', 'completed', 'failed'].entries()) {
      db.prepare('INSERT INTO run_attempts VALUES (?, ?, ?, ?)').run(`r${index}`, state, NOW - 600_000, NOW - 60_000 * (index + 1))
    }
    expect(inspect(db, NOW, healthy)).toEqual([])
    db.exec("DELETE FROM process_locks WHERE name='gateway'")
    expect(codes(inspect(db, NOW, healthy))).toEqual(['heartbeat'])
  })

  it('judges liveness by the refreshed scheduler lock of the gateway process, never by the gateway lock that is only taken at startup', () => {
    const db = database()
    // The 09-28 false alarm: an hour-old gateway lock with a fresh scheduler lock is a healthy gateway.
    expect(inspect(db, NOW, healthy, () => true)).toEqual([])
    expect(inspect(db, NOW, healthy, () => false).map(finding => finding.detail)).toEqual(['网关进程已经不在了'])
    db.prepare("UPDATE process_locks SET pid=2 WHERE name='scheduler'").run()
    expect(inspect(db, NOW, healthy).map(finding => finding.detail)).toEqual(['网关没有在跑定时任务（调度锁不在它手里）'])
    db.exec("DELETE FROM process_locks WHERE name='scheduler'")
    expect(codes(inspect(db, NOW, healthy))).toEqual(['heartbeat'])
  })
})

describe('watchdog alerting', () => {
  let keys = 0
  const key = () => `key-${++keys}`
  const fault: WatchdogFinding[] = [{ code: 'heartbeat', detail: '网关心跳 3 分钟没更新' }]

  it('alerts once after two bad checks in a row, and reports recovery only after two clean checks', () => {
    let state = decide(emptyState(), fault, NOW, key)
    expect(state.outbox).toEqual([])
    state = decide(state, fault, NOW + 60_000, key)
    expect(state.outbox).toHaveLength(1)
    expect(state.outbox[0]).toMatchObject({ kind: 'alert', attempts: 0, text: 'Friday 可能停摆了：网关心跳 3 分钟没更新。我每分钟复查，恢复了再告诉你。' })
    state = decide(state, [...fault, { code: 'queue', detail: '2 条请求排队超过 20 分钟' }], NOW + 120_000, key)
    expect(state.outbox).toHaveLength(1)
    expect(state.incident?.codes).toEqual(['heartbeat', 'queue'])
    // One clean check between bad ones neither recovers nor re-alerts.
    state = decide(state, [], NOW + 180_000, key)
    state = decide(state, fault, NOW + 240_000, key)
    expect(state.outbox).toHaveLength(1)
    state = decide(state, [], NOW + 300_000, key)
    state = decide(state, [], NOW + 360_000, key)
    expect(state.outbox.map(message => message.kind)).toEqual(['alert', 'recovery'])
    expect(state.outbox[1]!.text).toBe('Friday 恢复正常了（异常持续约 5 分钟）。')
    expect(state.incident).toBeUndefined()
  })

  it('a single bad check is not an incident', () => {
    const state = decide(decide(emptyState(), fault, NOW, key), [], NOW + 60_000, key)
    expect(state).toMatchObject({ outbox: [], badStreak: 0, goodStreak: 1 })
    expect(state.incident).toBeUndefined()
  })

  it('keeps an unsent message with the same key until it goes out, saving before and after every attempt', async () => {
    let state = decide(decide(emptyState(), fault, NOW, key), fault, NOW + 60_000, key)
    const sent: string[] = [], saves: number[] = []
    const failing = async (_text: string, messageKey: string) => { sent.push(messageKey); throw new Error('timeout') }
    state = await flush(state, failing, next => saves.push(next.outbox[0]!.attempts))
    state = await flush(state, failing, () => undefined)
    expect(state.outbox[0]).toMatchObject({ attempts: 2 })
    expect(state.outbox[0]!.messageId).toBeUndefined()
    state = await flush(state, async (_text, messageKey) => { sent.push(messageKey); return 'om_sent' }, () => undefined)
    expect(new Set(sent).size).toBe(1)
    expect(state.outbox[0]).toMatchObject({ attempts: 3, messageId: 'om_sent' })
    expect(saves[0]).toBe(1)
    // Delivered messages are not sent again.
    await flush(state, async () => { throw new Error('must not send') }, () => undefined)
  })

  it('drops a message that could not be sent within the attempt limit instead of retrying past Feishu’s de-duplication window', async () => {
    let state = decide(decide(emptyState(), fault, NOW, key), fault, NOW + 60_000, key)
    for (let attempt = 0; attempt < WATCHDOG_LIMITS.maxAttempts; attempt++) state = await flush(state, async () => { throw new Error('down') }, () => undefined)
    expect(state.outbox[0]).toMatchObject({ messageId: 'dropped', attempts: WATCHDOG_LIMITS.maxAttempts })
  })

  it('skips judging only while the maintenance lock is fresh, and survives a missing or corrupt state file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-watchdog-state-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const lock = join(dir, 'maintenance.lock')
    expect(maintenanceActive(lock, Date.now())).toBe(false)
    writeFileSync(lock, '')
    expect(maintenanceActive(lock, Date.now())).toBe(true)
    const old = (Date.now() - WATCHDOG_LIMITS.maintenanceMs - 1000) / 1000
    utimesSync(lock, old, old)
    expect(maintenanceActive(lock, Date.now())).toBe(false)
    const path = join(dir, 'state.json')
    expect(readState(path)).toEqual(emptyState())
    writeFileSync(path, '{not json')
    expect(readState(path)).toEqual(emptyState())
    const state = decide(emptyState(), fault, NOW, key)
    writeState(path, state)
    expect(readState(path)).toEqual(state)
  })
})

describe('post-deploy recognition probe', () => {
  it('passes only when the owner’s explicit preference is still recognised and a plain request is still work', async () => {
    const passing = await runProbe(async input => input.message.text.startsWith('记住')
      ? { kind: 'memory_save_preference', spans: [{ start: 3, end: 10 }], continueWork: false }
      : { kind: 'new_work' })
    expect(passing).toMatchObject({ ok: true, results: [{ name: 'explicit_preference', ok: true }, { name: 'new_request', ok: true }] })
    // The 09-28 failure: the classifier answered, but not with something the host could use.
    const failing = await runProbe(async input => {
      if (input.message.text.startsWith('记住')) throw Object.assign(new Error('bad'), { code: 'invalid_output' })
      return { kind: 'new_work' }
    })
    expect(failing).toMatchObject({ ok: false, results: [{ name: 'explicit_preference', ok: false, error: 'invalid_output' }, { ok: true }] })
    expect((await runProbe(async () => ({ kind: 'new_work' }))).results[0]).toMatchObject({ ok: false, kind: 'new_work' })
    // Synthetic sentences only; the owner's preference case is the one allowed to save original text.
    expect(PROBE_CASES.find(item => item.name === 'explicit_preference')?.input.allowExplicitPreference).toBe(true)
  })
})
