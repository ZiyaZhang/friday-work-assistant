/**
 * 群级主动模式（照 Claude Tag 的 ambient auto-reply / 豆包工作伙伴的"主动补位"）：
 * 开启后，群里没人 @ 它，它也会在一阵讨论安静下来后看一眼新消息，判断"有没有我能接的活"：
 * 没人答的问题而它能答 → 提供一条回复供宿主核验；其余沉默。评估不登记业务状态。
 *
 * 防打扰（"annoying agent is worse than unhelpful"）：
 * - 去抖：消息安静 quietMs 后、且积累 ≥ minMessages 条新消息才巡检一次
 * - 频控：每群每小时最多 maxPerHour 次主动发言
 * - 自我休眠：连续 dormantAfter 次巡检都没动作就休眠，有人 @ 它才醒
 * - 只读：巡检会话没有发私聊 / 发文件 / 跑命令的权限
 */
import type { DatabaseSync } from 'node:sqlite'

export interface ProactiveSettings {
  chatId: string
  enabled: boolean
  enabledBy: string | null
  enabledAt: number | null
  dormantSince: number | null
  noopStreak: number
  lastCheckAt: number | null
  /** 最近一次巡检看过的最后一条消息时间 */
  checkedUntil: number
  /** 一小时窗口内的主动发言时间戳 */
  recentActions: number[]
}

/** 一个群的主动模式节奏；空间负责人用 `!space set proactive ...` 调，缺省用部署级默认值。 */
export interface ProactiveTuning {
  quietMs?: number
  /** 只在这个时段内主动说话，本地时间 [from, to) */
  hours?: { from: number; to: number }
  minMessages?: number
  maxPerHour?: number
  /**
   * 说完一句之后，至少隔这么久才允许再主动说下一句。
   *
   * 这条和 maxPerHour 管的**不是同一件事**：配额是总量，间隔是节奏。
   * 每小时 3 次的配额完全允许它在 90 秒里连说三句然后安静一小时——
   * 而让人觉得烦的恰恰是那 90 秒，不是那三句的总数。
   */
  speakCooldownMs?: number
  dormantAfter?: number
  /** 自定义"什么消息该主动回"；为空时由模型按默认标准判断 */
  criteria?: string
}

export interface ProactiveOptions extends ProactiveTuning {
  /** 判断现在几点用的时区偏移（分钟），默认 +08:00 */
  tzOffsetMin?: number
  now?: () => number
  /** 按群取空间级覆盖（由组装层注入，避免这里反向依赖 Space） */
  tuningFor?: (chatId: string) => ProactiveTuning | undefined
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS proactive_chats (
  chat_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  enabled_by TEXT,
  enabled_at INTEGER,
  dormant_since INTEGER,
  noop_streak INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  checked_until INTEGER NOT NULL DEFAULT 0,
  recent_actions TEXT NOT NULL DEFAULT '[]'
);
`

/** 现在在允许主动说话的时段里吗。没配就是全天。跨零点的区间（22→7）也支持。 */
export function withinHours(hours: { from: number; to: number } | undefined, nowMs: number, tzOffsetMin: number): boolean {
  if (!hours) return true
  const { from, to } = hours
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return true
  const h = new Date(nowMs + tzOffsetMin * 60_000).getUTCHours()
  return from < to ? h >= from && h < to : h >= from || h < to
}

export class Proactive {
  /** 判断现在几点用的时区偏移，默认 +08:00 */
  private readonly tzOffsetMin: number
  readonly quietMs: number
  readonly minMessages: number
  readonly maxPerHour: number
  readonly speakCooldownMs: number
  readonly dormantAfter: number
  private readonly now: () => number
  /** 每群的去抖计时器与待巡检的消息数 */
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly pending = new Map<string, number>()
  private readonly tuningFor?: (chatId: string) => ProactiveTuning | undefined

  constructor(
    private readonly db: DatabaseSync,
    opts: ProactiveOptions = {},
  ) {
    db.exec(SCHEMA)
    this.quietMs = opts.quietMs ?? 3 * 60_000
    this.minMessages = opts.minMessages ?? 3
    this.maxPerHour = opts.maxPerHour ?? 2
    // 15 分钟：比"每小时 2 次"更严的是节奏，不是总量
    this.speakCooldownMs = opts.speakCooldownMs ?? 15 * 60_000
    this.dormantAfter = opts.dormantAfter ?? 5
    this.now = opts.now ?? (() => Date.now())
    this.tuningFor = opts.tuningFor
    this.tzOffsetMin = opts.tzOffsetMin ?? 8 * 60
  }

  /** 这个群实际生效的节奏：空间配置覆盖部署默认值。 */
  tuning(chatId: string): Required<Omit<ProactiveTuning, 'criteria' | 'hours'>> & { criteria?: string; hours?: { from: number; to: number } } {
    const o = this.tuningFor?.(chatId) ?? {}
    return {
      quietMs: o.quietMs ?? this.quietMs,
      minMessages: o.minMessages ?? this.minMessages,
      maxPerHour: o.maxPerHour ?? this.maxPerHour,
      speakCooldownMs: o.speakCooldownMs ?? this.speakCooldownMs,
      dormantAfter: o.dormantAfter ?? this.dormantAfter,
      criteria: o.criteria,
      hours: o.hours,
    }
  }

  get(chatId: string): ProactiveSettings {
    const r = this.db.prepare('SELECT * FROM proactive_chats WHERE chat_id = ?').get(chatId) as Record<string, unknown> | undefined
    if (!r) return { chatId, enabled: false, enabledBy: null, enabledAt: null, dormantSince: null, noopStreak: 0, lastCheckAt: null, checkedUntil: 0, recentActions: [] }
    let recent: number[] = []
    try {
      const parsed = JSON.parse(String(r.recent_actions ?? '[]')) as unknown
      if (Array.isArray(parsed)) recent = parsed.map(Number).filter(Number.isFinite)
    } catch {
      /* ignore */
    }
    return {
      chatId,
      enabled: Number(r.enabled) === 1,
      enabledBy: (r.enabled_by as string | null) ?? null,
      enabledAt: r.enabled_at === null || r.enabled_at === undefined ? null : Number(r.enabled_at),
      dormantSince: r.dormant_since === null || r.dormant_since === undefined ? null : Number(r.dormant_since),
      noopStreak: Number(r.noop_streak ?? 0),
      lastCheckAt: r.last_check_at === null || r.last_check_at === undefined ? null : Number(r.last_check_at),
      checkedUntil: Number(r.checked_until ?? 0),
      recentActions: recent,
    }
  }

  listEnabled(): ProactiveSettings[] {
    const rows = this.db.prepare('SELECT chat_id FROM proactive_chats WHERE enabled = 1').all() as { chat_id: string }[]
    return rows.map((r) => this.get(r.chat_id))
  }

  /** The enabler owns the quota and is re-checked every round. Enabling without them would look “on” while
   * every round is skipped, and must not clear the person recorded by an earlier enablement. */
  enable(chatId: string, by?: string): ProactiveSettings {
    if (!by?.trim()) throw new Error('开启主动协助需要记录是谁开启的；请由负责人在群里明确开启')
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO proactive_chats (chat_id, enabled, enabled_by, enabled_at, dormant_since, noop_streak, checked_until)
         VALUES (?, 1, ?, ?, NULL, 0, ?)
         ON CONFLICT(chat_id) DO UPDATE SET enabled = 1, enabled_by = excluded.enabled_by, enabled_at = excluded.enabled_at, dormant_since = NULL, noop_streak = 0, checked_until = excluded.checked_until`,
      )
      .run(chatId, by ?? null, now, now)
    return this.get(chatId)
  }

  disable(chatId: string): void {
    this.db.prepare('UPDATE proactive_chats SET enabled = 0 WHERE chat_id = ?').run(chatId)
    this.cancel(chatId)
  }

  /** 表里有没有这个群。只有 enable 会插行，所以有记录 = 曾经开过（现在可能已关）。 */
  has(chatId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM proactive_chats WHERE chat_id = ?').get(chatId))
  }

  /** 有人 @ 了：醒来、清零连续无动作计数。 */
  wake(chatId: string): void {
    this.db.prepare('UPDATE proactive_chats SET dormant_since = NULL, noop_streak = 0 WHERE chat_id = ? AND enabled = 1').run(chatId)
  }

  /** 一小时内还能主动发言几次。 */
  quotaLeft(chatId: string): number {
    const s = this.get(chatId)
    const hourAgo = this.now() - 3600_000
    return Math.max(0, this.tuning(chatId).maxPerHour - s.recentActions.filter((t) => t > hourAgo).length)
  }

  /**
   * 刚说过话、还在冷却里吗。返回还要等多少毫秒，0 = 可以说。
   *
   * 独立于配额：配额没用完也得等。连着两句之间隔得太近，人感觉到的是"它在刷屏"，
   * 跟这一小时总共说了几句没关系。
   */
  cooldownLeft(chatId: string): number {
    const cd = this.tuning(chatId).speakCooldownMs
    if (cd <= 0) return 0
    const last = this.get(chatId).recentActions.at(-1)
    if (last === undefined) return 0
    return Math.max(0, last + cd - this.now())
  }

  /** 现在允许主动说话吗（配额 + 冷却 + 时段，三道一起看）。 */
  maySpeak(chatId: string): { ok: boolean; why?: 'quota' | 'cooldown' | 'hours' } {
    if (this.quotaLeft(chatId) <= 0) return { ok: false, why: 'quota' }
    if (this.cooldownLeft(chatId) > 0) return { ok: false, why: 'cooldown' }
    if (!withinHours(this.tuning(chatId).hours, this.now(), this.tzOffsetMin)) return { ok: false, why: 'hours' }
    return { ok: true }
  }

  /**
   * 群里来了一条普通消息：开启且没休眠时启动/重置去抖计时器；安静够久且消息够多就触发 run。
   * 返回是否在观察这条消息（测试用）。
   */
  observe(chatId: string, run: (chatId: string) => Promise<void>): boolean {
    const s = this.get(chatId)
    if (!s.enabled || s.dormantSince !== null) return false
    const tune = this.tuning(chatId)
    this.pending.set(chatId, (this.pending.get(chatId) ?? 0) + 1)
    const old = this.timers.get(chatId)
    if (old) clearTimeout(old)
    const t = setTimeout(() => {
      this.timers.delete(chatId)
      const n = this.pending.get(chatId) ?? 0
      if (n < tune.minMessages) return // 零星消息：留到下次一起看
      if (this.quotaLeft(chatId) <= 0) return // 这小时说够了，安静
      // 不在允许的时段里就彻底不开口。半夜在群里冒一句，比白天多嘴十句还讨人厌；
      // 而且攒下的消息不清空，等到点了一起看。
      if (!withinHours(tune.hours, this.now(), this.tzOffsetMin)) return
      this.pending.delete(chatId)
      void run(chatId)
    }, tune.quietMs)
    t.unref?.()
    this.timers.set(chatId, t)
    return true
  }

  cancel(chatId: string): void {
    const t = this.timers.get(chatId)
    if (t) clearTimeout(t)
    this.timers.delete(chatId)
    this.pending.delete(chatId)
  }

  cancelAll(): void {
    for (const id of [...this.timers.keys()]) this.cancel(id)
  }

  /**
   * 巡检结束：记录看到哪里、是否有动作；连续无动作到阈值就休眠。
   *
   * 注：`observe`/`wake` 的防抖计时器现在只用来"@ 我之后清零休眠"，
   * **触发已经移交给 Signal 层**（docs/signals.md）——安静本身不是信号。
   */
  record(chatId: string, result: { acted: boolean; checkedUntil: number }): ProactiveSettings {
    const s = this.get(chatId)
    const now = this.now()
    const hourAgo = now - 3600_000
    const recent = s.recentActions.filter((t) => t > hourAgo)
    let streak = s.noopStreak
    let dormant: number | null = s.dormantSince
    if (result.acted) {
      recent.push(now)
      streak = 0
    } else {
      streak += 1
      if (streak >= this.tuning(chatId).dormantAfter) dormant = now
    }
    this.db
      .prepare('UPDATE proactive_chats SET noop_streak = ?, dormant_since = ?, last_check_at = ?, checked_until = ?, recent_actions = ? WHERE chat_id = ?')
      .run(streak, dormant, now, Math.max(s.checkedUntil, result.checkedUntil), JSON.stringify(recent), chatId)
    return this.get(chatId)
  }

  describe(chatId: string): string {
    const s = this.get(chatId)
    if (!s.enabled) return '本群主动模式：关（只在被 @ 时说话）。跟我说一声就能开；开了之后讨论安静下来，我会看一眼有没有没人答的问题能接。'
    const tune = this.tuning(chatId)
    const parts = [`本群主动模式：开（${s.enabledAt ? new Date(s.enabledAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : ''} 开启）`]
    parts.push(s.dormantSince ? `状态：休眠中（连续 ${s.noopStreak} 次巡检没事可做；@ 我一下就醒）` : `状态：观察中（安静 ${Math.round(tune.quietMs / 60_000)} 分钟且有 ≥${tune.minMessages} 条新消息时看一眼）`)
    parts.push(`这小时还能主动发言 ${this.quotaLeft(chatId)}/${tune.maxPerHour} 次${s.lastCheckAt ? `；上次巡检 ${new Date(s.lastCheckAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}` : ''}`)
    if (tune.criteria) parts.push(`本空间的主动依据：${tune.criteria}`)
    parts.push('想关掉、或者想调节奏和依据（什么样的消息该主动回），跟我说一声。')
    return parts.join('\n')
  }
}
