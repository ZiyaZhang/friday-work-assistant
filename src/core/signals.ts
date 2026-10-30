/**
 * Signal 层：主动模式的唯一入口。设计见 docs/signals.md。
 *
 * 一句话：**主动不是定时去猜，是有东西进来了才判断；判断完也不立刻说话，
 * 要先聚类、去重、对阈值。** 这一层的目标不是每条消息都警觉一次，而是
 * "该升级的一定升级，不必要的噪音不会被重复打扰"。
 *
 * 定时器只负责问 `due()`："有没有攒下的信号到阈值了"，永远不负责"到点去猜"。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  space_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  alerts INTEGER NOT NULL DEFAULT 0,
  next_alert_at INTEGER,
  resolved_at INTEGER,
  resolved_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_open ON signals(status, space_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_fp ON signals(space_id, kind, fingerprint, status);
CREATE TABLE IF NOT EXISTS signal_mutes (
  space_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '*',
  muted_by TEXT,
  muted_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, kind)
);
`

export type SignalStatus = 'open' | 'escalated' | 'resolved' | 'muted' | 'expired'

export interface Signal {
  id: number
  kind: string
  source: string
  spaceId: string
  fingerprint: string
  title: string
  payload: Record<string, unknown>
  firstSeenAt: number
  lastSeenAt: number
  count: number
  status: SignalStatus
  alerts: number
  nextAlertAt: number | null
}

export interface SignalInput {
  kind: string
  source: string
  spaceId: string
  title: string
  /** 同一件事的判据；不给就用 title 算 */
  dedupeOn?: string
  payload?: Record<string, unknown>
  at?: number
}

/** 每种信号的阈值。弱证据要熬够时间，强证据立即。 */
export interface KindRule {
  /** 存活多久才算数（毫秒） */
  minAgeMs: number
  /** 至少出现几次 */
  minCount: number
  /** 到了这个次数就并成一条"同一件事反复出现" */
  burstAt?: number
  /** 多久没再出现就作废 */
  ttlMs: number
}

const HOUR = 3600_000
const DAY = 24 * HOUR

export const KIND_RULES: Record<string, KindRule> = {
  // 弱证据：没人接的问题。十分钟是给人留的反应时间
  unanswered_question: { minAgeMs: 10 * 60_000, minCount: 1, burstAt: 3, ttlMs: 2 * DAY },
  // 弱证据：@ 了人没回。四小时——半个工作日没动静才值得提
  mentioned_stalled: { minAgeMs: 4 * HOUR, minCount: 1, ttlMs: 3 * DAY },
  // 强证据：到点没做完
  task_overdue: { minAgeMs: 0, minCount: 1, ttlMs: 7 * DAY },
  // 强证据：外部系统挂了
  external_failed: { minAgeMs: 0, minCount: 1, burstAt: 3, ttlMs: DAY },
  // 强证据：同一件事反复出现，合并成一条
  duplicate_burst: { minAgeMs: 0, minCount: 1, ttlMs: DAY },
  // 强证据：自检发现两条职责产出重复
  responsibility_conflict: { minAgeMs: 0, minCount: 1, ttlMs: 7 * DAY },
}

const DEFAULT_RULE: KindRule = { minAgeMs: 30 * 60_000, minCount: 1, ttlMs: 2 * DAY }

/** 退避：第 1 次立即，之后 60s / 5min / 30min，第 5 次起闭嘴转成记录。 */
export const BACKOFF_MS = [0, 60_000, 5 * 60_000, 30 * 60_000]
export const MAX_ALERTS = BACKOFF_MS.length

/** 同一件事的指纹：小写、去标点空白，sha1 前 16 位。宁可漏合并，不要错合并。 */
export function fingerprintOf(text: string): string {
  const norm = text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 400)
  return createHash('sha1').update(norm).digest('hex').slice(0, 16)
}

function rowToSignal(r: Record<string, unknown>): Signal {
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(String(r.payload ?? '{}')) as Record<string, unknown>
  } catch {
    payload = {}
  }
  return {
    id: Number(r.id),
    kind: String(r.kind),
    source: String(r.source),
    spaceId: String(r.space_id),
    fingerprint: String(r.fingerprint),
    title: String(r.title),
    payload,
    firstSeenAt: Number(r.first_seen_at),
    lastSeenAt: Number(r.last_seen_at),
    count: Number(r.count),
    status: String(r.status) as SignalStatus,
    alerts: Number(r.alerts),
    nextAlertAt: r.next_alert_at === null || r.next_alert_at === undefined ? null : Number(r.next_alert_at),
  }
}

export class Signals {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = () => Date.now(),
  ) {
    db.exec(SCHEMA)
  }

  rule(kind: string): KindRule {
    return KIND_RULES[kind] ?? DEFAULT_RULE
  }

  /**
   * 归一化入库。同 `(spaceId, kind, fingerprint)` 且还开着的，合并计数而不新建。
   * 返回落地的信号；`merged` 表示这次是合并进已有的一条。
   */
  ingest(input: SignalInput): { signal: Signal; merged: boolean; burst?: Signal } {
    const at = input.at ?? this.now()
    const fp = fingerprintOf(input.dedupeOn ?? input.title)
    const existing = this.db
      .prepare(`SELECT * FROM signals WHERE space_id = ? AND kind = ? AND fingerprint = ? AND status = 'open'`)
      .get(input.spaceId, input.kind, fp) as Record<string, unknown> | undefined
    if (existing) {
      this.db
        .prepare('UPDATE signals SET count = count + 1, last_seen_at = MAX(last_seen_at, ?) WHERE id = ?')
        .run(at, Number(existing.id))
      const signal = this.get(Number(existing.id))!
      const burstAt = this.rule(input.kind).burstAt
      // 同一件事反复出现：额外产生一条合并信号，原信号不再单独升级
      if (burstAt && signal.count === burstAt) {
        const burst = this.ingest({
          kind: 'duplicate_burst',
          source: input.source,
          spaceId: input.spaceId,
          title: `同一件事出现了 ${signal.count} 次：${signal.title}`,
          dedupeOn: `burst:${fp}`,
          payload: { of: signal.id, ofKind: signal.kind, count: signal.count },
          at,
        }).signal
        this.resolve(signal.id, `并入 #${burst.id}`)
        return { signal, merged: true, burst }
      }
      return { signal, merged: true }
    }
    const id = Number(
      this.db
        .prepare(
          'INSERT INTO signals (kind, source, space_id, fingerprint, title, payload, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(input.kind, input.source, input.spaceId, fp, input.title, JSON.stringify(input.payload ?? {}), at, at).lastInsertRowid,
    )
    return { signal: this.get(id)!, merged: false }
  }

  get(id: number): Signal | undefined {
    const r = this.db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? rowToSignal(r) : undefined
  }

  open(spaceId?: string): Signal[] {
    const rows = (spaceId
      ? this.db.prepare(`SELECT * FROM signals WHERE status = 'open' AND space_id = ? ORDER BY first_seen_at`).all(spaceId)
      : this.db.prepare(`SELECT * FROM signals WHERE status = 'open' ORDER BY first_seen_at`).all()) as Record<string, unknown>[]
    return rows.map(rowToSignal)
  }

  /**
   * 到阈值、不在退避期、没被关停的信号。定时器每轮问这一个问题。
   * 返回按空间分组——同一空间同一轮打包成一次，不是一条起一轮。
   */
  due(nowMs = this.now()): Map<string, Signal[]> {
    const out = new Map<string, Signal[]>()
    for (const s of this.open()) {
      if (this.isMuted(s.spaceId, s.kind)) continue
      if (s.nextAlertAt !== null && nowMs < s.nextAlertAt) continue
      const rule = this.rule(s.kind)
      if (s.count < rule.minCount) continue
      if (nowMs - s.firstSeenAt < rule.minAgeMs) continue
      const list = out.get(s.spaceId) ?? []
      list.push(s)
      out.set(s.spaceId, list)
    }
    return out
  }

  /**
   * 说过一次了：推进退避。第 5 次起不再说话，转成 muted 只留记录。
   * 退避状态在 resolve 时清空。
   */
  noteAlerted(id: number, nowMs = this.now()): Signal | undefined {
    const s = this.get(id)
    if (!s) return undefined
    const alerts = s.alerts + 1
    if (alerts >= MAX_ALERTS) {
      this.db
        .prepare(`UPDATE signals SET alerts = ?, status = 'muted', next_alert_at = NULL, resolved_at = ?, resolved_reason = ? WHERE id = ?`)
        .run(alerts, nowMs, `提醒 ${alerts} 次没有进展，转成记录不再打扰`, id)
      return this.get(id)
    }
    this.db.prepare('UPDATE signals SET alerts = ?, next_alert_at = ? WHERE id = ?').run(alerts, nowMs + BACKOFF_MS[alerts]!, id)
    return this.get(id)
  }

  /** 有人接了 / 事办完了 / CI 转绿了。 */
  resolve(id: number, reason: string, nowMs = this.now()): void {
    this.db
      .prepare(`UPDATE signals SET status = 'resolved', resolved_at = ?, resolved_reason = ?, alerts = 0, next_alert_at = NULL WHERE id = ? AND status = 'open'`)
      .run(nowMs, reason, id)
  }

  /**
   * 反例表里那几条"有人在管了"：同空间同来源下，晚于某个时刻的信号一律收掉。
   * 用在"别人接话了"这种场景——人已经在处理，我们闭嘴。
   */
  resolveBySource(spaceId: string, source: string, reason: string, opts: { kinds?: string[]; beforeMs?: number } = {}): number {
    const rows = this.open(spaceId).filter(
      (s) => s.source === source && (!opts.kinds || opts.kinds.includes(s.kind)) && (opts.beforeMs === undefined || s.firstSeenAt <= opts.beforeMs),
    )
    for (const s of rows) this.resolve(s.id, reason)
    return rows.length
  }

  /** 攒着没人管、也没再出现的，到期作废。 */
  expire(nowMs = this.now()): number {
    let n = 0
    for (const s of this.open()) {
      if (nowMs - s.lastSeenAt <= this.rule(s.kind).ttlMs) continue
      this.db
        .prepare(`UPDATE signals SET status = 'expired', resolved_at = ?, resolved_reason = '过期没人管' WHERE id = ?`)
        .run(nowMs, s.id)
      n += 1
    }
    return n
  }

  /** 同指纹在别的空间出现过几次——升级时只把这个计数带进提示词，不带别人群里的原文。 */
  elsewhere(signal: Signal): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM signals WHERE fingerprint = ? AND space_id != ?')
      .get(signal.fingerprint, signal.spaceId) as { n: number } | undefined
    return Number(r?.n ?? 0)
  }

  // ------------------------------------------------------------ 关停

  /** 自然语言关停："别盯这个群了"。kind 给 '*' 就是整个空间。 */
  mute(spaceId: string, kind = '*', by?: string, nowMs = this.now()): void {
    this.db
      .prepare('INSERT INTO signal_mutes (space_id, kind, muted_by, muted_at) VALUES (?, ?, ?, ?) ON CONFLICT(space_id, kind) DO UPDATE SET muted_by = excluded.muted_by, muted_at = excluded.muted_at')
      .run(spaceId, kind, by ?? null, nowMs)
  }

  unmute(spaceId: string, kind = '*'): void {
    this.db.prepare('DELETE FROM signal_mutes WHERE space_id = ? AND kind = ?').run(spaceId, kind)
  }

  isMuted(spaceId: string, kind: string): boolean {
    const r = this.db
      .prepare(`SELECT 1 AS hit FROM signal_mutes WHERE space_id = ? AND kind IN ('*', ?) LIMIT 1`)
      .get(spaceId, kind) as { hit: number } | undefined
    return Boolean(r)
  }

  mutedKinds(spaceId: string): string[] {
    const rows = this.db.prepare('SELECT kind FROM signal_mutes WHERE space_id = ?').all(spaceId) as { kind: string }[]
    return rows.map((r) => String(r.kind))
  }
}

/** 升级时给模型看的那一段：每条一行，带出处和次数。 */
export function renderSignals(signals: Signal[], elsewhere: (s: Signal) => number = () => 0): string {
  return signals
    .map((s) => {
      const bits = [`[#${s.id} ${s.kind}]`, s.title]
      if (s.count > 1) bits.push(`（出现 ${s.count} 次）`)
      const other = elsewhere(s)
      if (other > 0) bits.push(`（别的空间也出现过 ${other} 次）`)
      if (s.alerts > 0) bits.push(`（已提过 ${s.alerts} 次没进展）`)
      return bits.join(' ')
    })
    .join('\n')
}

/** 发出去的话必须带触发出处——人一眼知道它为什么冒出来，误报也好纠正。 */
export function triggerLine(signals: Signal[], nowMs: number): string {
  const first = signals[0]
  if (!first) return ''
  const mins = Math.max(1, Math.round((nowMs - first.firstSeenAt) / 60_000))
  const age = mins >= 60 ? `${Math.round(mins / 60)} 小时` : `${mins} 分钟`
  const more = signals.length > 1 ? `等 ${signals.length} 件事` : ''
  return `（因为：${first.title}${more}，${age}没动静）`
}
