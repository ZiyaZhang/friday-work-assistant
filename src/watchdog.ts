/**
 * 独立看门狗：和网关分开的进程，每分钟只读一次数据库和 /healthz。Friday 停摆时只私聊配置里的负责人。
 *
 * 宿主监控：
 * - 同一现象连续两次才算故障，同一次故障只报一次；恢复要连续两次全部正常。
 * - 先把要发的话写进 outbox 再发；发送结果不明时用同一个 uuid 重发（飞书按 uuid 一小时内去重），不换键重发。
 * - 维护锁（发布时创建）存在且不超过 15 分钟时这一轮不判定；超过 15 分钟照常判定。
 *
 * 边界：只读数据库，不改任务、不重启进程、不发群消息。它和网关在同一台机器上，整机或容器停了它也会一起停，
 * 这种情况需要外部监控另外覆盖。
 *
 *   node --no-warnings=ExperimentalWarning --env-file=.env dist/watchdog.js
 */
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

export type WatchdogCode = 'health' | 'heartbeat' | 'queue' | 'stuck_task' | 'delivery' | 'routine' | 'runs_failing'
export interface WatchdogFinding { code: WatchdogCode; detail: string }
export interface WatchdogMessage { key: string; kind: 'alert' | 'recovery'; text: string; createdAt: number; attempts: number; messageId?: string }
export interface WatchdogState {
  version: 1
  /** Consecutive checks with at least one finding / with none. */
  badStreak: number
  goodStreak: number
  /** An outstanding incident: alerted once, closed by two clean checks. */
  incident?: { since: number; codes: WatchdogCode[] }
  outbox: WatchdogMessage[]
  lastCheckAt?: number
  lastFindings?: WatchdogFinding[]
}

export const WATCHDOG_LIMITS = {
  heartbeatMs: 120_000, queuedMs: 20 * 60_000, runningMs: 60 * 60_000, deliveryMs: 10 * 60_000, routineMs: 15 * 60_000,
  failedRuns: 3, failedRunsWindowMs: 2 * 3600_000, maintenanceMs: 15 * 60_000,
  /** A message still unsent after this many tries is dropped; Feishu only de-duplicates a uuid for an hour. */
  maxAttempts: 30,
} as const

export function emptyState(): WatchdogState { return { version: 1, badStreak: 0, goodStreak: 0, outbox: [] } }

function minutes(ms: number): string { return ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} 分钟` : `${(ms / 3600_000).toFixed(1)} 小时` }

/**
 * Read-only look at the gateway's own records. A missing table (older schema) is skipped, never reported as a fault.
 * The gateway lock is taken once at startup and never refreshed; the scheduler lock, held by the same process, is refreshed by a timer.
 * So liveness is: the gateway lock's process still exists (when it is on this host), and the scheduler lock it holds is fresh.
 */
export function inspect(db: DatabaseSync, now: number, health: { ok: boolean; detail?: string },
  alive: (pid: number, host: string) => boolean | undefined = () => undefined): WatchdogFinding[] {
  const findings: WatchdogFinding[] = []
  const has = (table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
  const count = (sql: string, ...args: number[]) => Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0)
  if (!health.ok) findings.push({ code: 'health', detail: `健康检查没通过（${health.detail ?? '没有响应'}）` })
  if (has('process_locks')) {
    const locks = db.prepare('SELECT name, pid, host, heartbeat_at FROM process_locks').all() as { name: string; pid: number; host: string; heartbeat_at: number }[]
    const gateway = locks.find(lock => lock.name === 'gateway'), scheduler = locks.find(lock => lock.name === 'scheduler')
    if (!gateway) findings.push({ code: 'heartbeat', detail: '网关没有持有运行锁' })
    else if (alive(Number(gateway.pid), String(gateway.host)) === false) findings.push({ code: 'heartbeat', detail: '网关进程已经不在了' })
    else if (!scheduler || Number(scheduler.pid) !== Number(gateway.pid) || String(scheduler.host) !== String(gateway.host)) {
      findings.push({ code: 'heartbeat', detail: '网关没有在跑定时任务（调度锁不在它手里）' })
    } else if (now - Number(scheduler.heartbeat_at) > WATCHDOG_LIMITS.heartbeatMs) {
      findings.push({ code: 'heartbeat', detail: `网关心跳 ${minutes(now - Number(scheduler.heartbeat_at))}没更新` })
    }
  }
  if (has('tasks')) {
    const queued = count("SELECT count(*) AS n FROM tasks WHERE status='queued' AND created_at < ?", now - WATCHDOG_LIMITS.queuedMs)
    if (queued) findings.push({ code: 'queue', detail: `${queued} 条请求排队超过 20 分钟` })
    const running = count("SELECT count(*) AS n FROM tasks WHERE status='running' AND started_at < ?", now - WATCHDOG_LIMITS.runningMs)
    if (running) findings.push({ code: 'stuck_task', detail: `${running} 条请求执行超过 1 小时` })
  }
  if (has('deliveries')) {
    const planned = count("SELECT count(*) AS n FROM deliveries WHERE status='planned' AND created_at < ?", now - WATCHDOG_LIMITS.deliveryMs)
    if (planned) findings.push({ code: 'delivery', detail: `${planned} 条消息超过 10 分钟还没发出` })
  }
  if (has('routine_occurrences')) {
    const late = count("SELECT count(*) AS n FROM routine_occurrences WHERE (status='pending' AND scheduled_at < ?) OR (status='running' AND started_at < ?)",
      now - WATCHDOG_LIMITS.routineMs, now - WATCHDOG_LIMITS.runningMs)
    if (late) findings.push({ code: 'routine', detail: `${late} 次定时任务超时没跑完` })
  }
  if (has('run_attempts')) {
    const recent = db.prepare('SELECT state FROM run_attempts WHERE finished_at IS NOT NULL AND finished_at > ? ORDER BY finished_at DESC LIMIT ?')
      .all(now - WATCHDOG_LIMITS.failedRunsWindowMs, WATCHDOG_LIMITS.failedRuns) as { state: string }[]
    if (recent.length === WATCHDOG_LIMITS.failedRuns && recent.every(row => row.state === 'failed')) {
      findings.push({ code: 'runs_failing', detail: `最近 ${WATCHDOG_LIMITS.failedRuns} 次执行都失败了` })
    }
  }
  return findings
}

/** One check's verdict. Pure: the caller persists the returned state before sending anything in its outbox. */
export function decide(previous: WatchdogState, findings: WatchdogFinding[], now: number, newKey: () => string = randomUUID): WatchdogState {
  const state: WatchdogState = { ...structuredClone(previous), lastCheckAt: now, lastFindings: findings }
  if (findings.length) {
    state.badStreak += 1; state.goodStreak = 0
    const codes = [...new Set(findings.map(finding => finding.code))]
    if (state.incident) state.incident.codes = [...new Set([...state.incident.codes, ...codes])]
    else if (state.badStreak >= 2) {
      state.incident = { since: now, codes }
      state.outbox.push({ key: newKey().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50), kind: 'alert', createdAt: now, attempts: 0,
        text: `Friday 可能停摆了：${findings.map(finding => finding.detail).join('；')}。我每分钟复查，恢复了再告诉你。` })
    }
  } else {
    state.goodStreak += 1; state.badStreak = 0
    if (state.incident && state.goodStreak >= 2) {
      state.outbox.push({ key: newKey().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50), kind: 'recovery', createdAt: now, attempts: 0,
        text: `Friday 恢复正常了（异常持续约 ${minutes(now - state.incident.since)}）。` })
      delete state.incident
    }
  }
  return state
}

/** A fresh maintenance lock (a release in progress) skips judging; a stale one is ignored. */
export function maintenanceActive(lockPath: string, now: number): boolean {
  try { return now - statSync(lockPath).mtimeMs < WATCHDOG_LIMITS.maintenanceMs } catch { return false }
}

/** Sends every unsent message with its own stable key; a failure keeps it for the next minute with the same key. */
export async function flush(state: WatchdogState, send: (text: string, key: string) => Promise<string>,
  save: (state: WatchdogState) => void, log: (line: string) => void = () => undefined): Promise<WatchdogState> {
  for (const message of state.outbox.filter(item => !item.messageId)) {
    message.attempts += 1
    save(state)
    try {
      message.messageId = await send(message.text, message.key) || 'sent'
      log(`${message.kind} sent ${message.key}`)
    } catch (error) {
      log(`${message.kind} send failed (attempt ${message.attempts}): ${error instanceof Error ? error.message : String(error)}`)
      if (message.attempts >= WATCHDOG_LIMITS.maxAttempts) message.messageId = 'dropped'
    }
    save(state)
  }
  // Keep a short delivery history only.
  state.outbox = [...state.outbox.filter(item => !item.messageId), ...state.outbox.filter(item => item.messageId).slice(-10)]
  save(state)
  return state
}

export function readState(path: string): WatchdogState {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as WatchdogState
    return value?.version === 1 && Array.isArray(value.outbox) ? value : emptyState()
  } catch { return emptyState() }
}

export function writeState(path: string, state: WatchdogState): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

async function probeHealth(port: number): Promise<{ ok: boolean; detail?: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) })
    const body = await response.json().catch(() => ({})) as { ok?: unknown }
    return response.ok && body.ok === true ? { ok: true } : { ok: false, detail: `HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, detail: error instanceof Error && error.name === 'TimeoutError' ? '5 秒没有响应' : '连不上' }
  }
}

async function main(): Promise<void> {
  const { loadConfig } = await import('./config.js')
  const { FeishuClient } = await import('./feishu/client.js')
  const { createLogger } = await import('./log.js')
  const cfg = loadConfig()
  const home = process.env.FRIDAY_HOME?.trim() || join(homedir(), '.friday')
  const dir = join(home, 'watchdog')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const statePath = join(dir, 'state.json'), configPath = join(dir, 'config.json')
  const line = (text: string) => process.stdout.write(`${new Date().toISOString()} ${text}\n`)
  const recipient = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, 'utf8')) as { recipientOpenId?: unknown }).recipientOpenId : undefined
  let state = readState(statePath)
  const now = Date.now()
  if (maintenanceActive(join(home, 'maintenance.lock'), now)) {
    line('maintenance lock present; skipped')
  } else {
    const health = await probeHealth(cfg.internalApi.port)
    const db = new DatabaseSync(cfg.dbPath, { readOnly: true })
    let findings: WatchdogFinding[]
    const alive = (pid: number, host: string) => {
      if (host !== hostname()) return undefined
      try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
    }
    try { db.exec('PRAGMA query_only=ON'); findings = inspect(db, now, health, alive) } finally { db.close() }
    state = decide(state, findings, now)
    line(findings.length ? `findings: ${findings.map(finding => finding.code).join(',')} (streak ${state.badStreak})` : 'ok')
  }
  writeState(statePath, state)
  if (typeof recipient !== 'string' || !/^ou_[A-Za-z0-9_-]+$/.test(recipient)) {
    if (state.outbox.some(item => !item.messageId)) line('no recipient configured in watchdog/config.json; message kept unsent')
    return
  }
  const feishu = new FeishuClient({ ...cfg.feishu, log: createLogger('watchdog', 'warn') })
  await flush(state, (text, key) => feishu.sendToUserOnce(recipient, { text }, key), next => writeState(statePath, next), line)
}

const isEntrypoint = process.argv[1] && /watchdog\.(js|ts)$/.test(process.argv[1])
if (isEntrypoint) {
  main().then(() => process.exit(0), error => {
    process.stderr.write(`watchdog failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
}
