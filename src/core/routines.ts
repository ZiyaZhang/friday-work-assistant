/**
 * Routines：定时任务与"关注群聊"（对齐 Claude Tag 的 routines / watched channels）。
 *
 * - 存在网关 SQLite 里，调度器每分钟扫一次到期任务；容器里没有 cron/systemd，所以由网关自己循环。
 * - 每个 routine 继承创建者的身份和可读范围：私聊里建的只能读创建者也在的群、结果只私聊给他；
 *   群里建的只能读本群、结果发回本群（和交互式请求同一套作用域，不存在"超级 token"）。
 * - 到期在同一事务记录 occurrence 并推进 next_run_at；重启把未结束的执行标成中断，等待检查，不盲目重放。
 * - occurrence 的身份是 routine + 逻辑执行窗口（scheduled_at 的 UTC 规范化时刻）；config_version 只是该次执行实际使用的配置快照。
 *   只改指令/名字/发送约定不产生第二个相同窗口；改调度取消尚未开始的旧窗口并产生新窗口；手动执行走独立的 message_id 触发身份。
 * - 正常失败沿下一次频率重试；连续失败 3 次自动停用并记录原因。
 * - 运行结果由调用方（编排器）在一个独立的 dsh 会话里产出；默认无内容时静默，明确约定每次发送的任务会报告生成失败。
 */
import type { DatabaseSync } from 'node:sqlite'
import { routineExecutionKey } from './execution-keys.js'
import type { Logger } from '../log.js'

/**
 * schedule：到点在新会话里跑 prompt；watch：关注群聊；
 * followup：模型给自己安排的"到点回来继续"（一次性），回到原会话、原话题里接着做（Claude Tag 的 self-schedule）。
 */
export type RoutineKind = 'schedule' | 'watch' | 'followup'
export type RoutineDeliveryPolicy = 'when_nonempty' | 'every_run'
export type RoutineRunStatus = 'ok' | 'skipped' | 'failed'
/** 执行回调可以带原因返回（例如不到阈值的跳过）；原因记进 occurrence.error，不改变状态语义。 */
export interface RoutineRunOutcome { status: RoutineRunStatus; reason?: string }
export type RoutineRunResult = RoutineRunStatus | RoutineRunOutcome
export function routineRunOutcome(result: RoutineRunResult): RoutineRunOutcome {
  return typeof result === 'string' ? { status: result } : result
}
/** 不到阈值时 occurrence.error 记的原因（G7）。 */
export const BELOW_THRESHOLD = 'below_threshold'
export type RoutineControlAction = 'pause' | 'resume' | 'delete'
export class RoutineControlError extends Error {}
export type RoutineResumeState =
  | { kind: 'enabled'; routine: Routine }
  | { kind: 'ready'; routine: Routine }
  | { kind: 'waiting' | 'completed' | 'inspect_previous_run' | 'feedback_blocked' | 'schedule_disabled'; routine: Routine; reason: string }
export type RoutineOccurrenceStatus = 'pending' | 'running' | RoutineRunStatus | 'interrupted' | 'cancelled'

export interface RoutineOccurrence {
  id: number
  routineId: number
  scheduledAt: number
  /** 逻辑执行窗口：scheduled_at 的 UTC ISO 时刻；与 routineId 一起构成 occurrence 身份。 */
  windowKey: string
  /** 实际执行使用的配置版本快照；pending 行保存领取时的版本，开始时改为当时的当前版本，开始后不再改写。 */
  configVersion: number
  /** 仅旧数据：旧身份含 config_version，同一窗口可能有多行；除最后一行外都指向拥有该窗口的行，两行都保留。 */
  windowDuplicateOf: number | null
  status: RoutineOccurrenceStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  error: string | null
}

/** 窗口键只由计划时刻决定，与配置版本无关；旧行的键由 SQL 回填，结果与此函数一致。 */
export function occurrenceWindowKey(scheduledAt: number): string {
  return new Date(scheduledAt).toISOString()
}

/**
 * 职责提案的生命周期：
 *   proposed  模型自己挖出来的，等人点接受；72 小时没人理就 expired
 *   active    正在生效，调度器会跑
 *   ignored   人点了忽略
 *   expired   提案过期，没人点
 * 只有 active 会真的执行。
 */
export type RoutineStatus = 'proposed' | 'active' | 'ignored' | 'expired'

/** 因为委托授权过期而停用——和「手动停用」区分开，因为只有这种能自动恢复 */
export const AUTH_EXPIRED = '委托授权已到期'
export const ROUTINE_INTERRUPTED = '上次执行中断，结果未知；请检查已产生的操作后重新启用'
const ONCE_PENDING = '一次性任务待执行'
export const FEEDBACK_STOPPED = '反馈已停止跟进'

/** 提案多久没人处理就作废 */
const PROPOSAL_TTL_MS = 72 * 3600_000
/** “先停到某天”最多约定 90 天；更久的暂停不自动恢复，由人明确恢复。 */
export const MAX_PAUSE_MS = 90 * 86_400_000
const MANUAL_PAUSE = '手动停用'
const RESTART_NOT_STARTED = '服务重启时这次调度尚未开始；按原计划继续'
const RESTART_NO_EFFECT = '服务重启中断；网关没有记录这次执行的外部操作，下一轮从原读取位置继续'

export interface QuietHours { start: string; end: string }
export type ScheduleSpec =
  | { type: 'daily'; at: string; days?: number[]; quietHours?: QuietHours }
  | { type: 'interval'; everyMinutes: number; quietHours?: QuietHours }
  | { type: 'once'; atMs: number }

export const FREQUENCY_DISABLED = '频率设为 0，已停用'
const QUIET_HOURS = '当前为安静时段，保留读取位置到下次执行'

export function scheduleDisabled(schedule: ScheduleSpec): boolean {
  return schedule.type === 'interval' && schedule.everyMinutes === 0
}

export function parseQuietHours(raw: unknown): QuietHours | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!raw || typeof raw !== 'object') throw new Error('quiet_hours 必须包含 start 和 end（HH:MM）')
  const { start, end } = raw as Record<string, unknown>
  const valid = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
  if (!valid(start) || !valid(end) || start === end) throw new Error('安静时段需要两个不同的 HH:MM；全天停用请暂停职责')
  return { start, end }
}

/** First allowed instant at or after atMs. Uses the same fixed local timezone as daily schedules. */
export function afterQuietHours(schedule: ScheduleSpec, atMs: number, tzOffsetMin = DEFAULT_TZ_OFFSET_MIN): number {
  if (schedule.type === 'once' || !schedule.quietHours || !Number.isFinite(atMs)) return atMs
  const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3))
  const start = minutes(schedule.quietHours.start), end = minutes(schedule.quietHours.end)
  const offset = tzOffsetMin * 60_000
  const local = new Date(atMs + offset)
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes()
  const quiet = start < end ? minute >= start && minute < end : minute >= start || minute < end
  if (!quiet) return atMs
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset
  return dayStart + end * 60_000 + (start > end && minute >= start ? 86_400_000 : 0)
}

export interface Routine {
  id: number
  kind: RoutineKind
  ownerOpenId: string | null
  /**
   * 以谁的身份运行。为空 = 无主职责：仍然会跑，但只拿只读权限
   * 没有执行身份的自动化不授予写权限。
   */
  runAs: string | null
  status: RoutineStatus
  /** 谁提出来的：人说的，还是模型自己挖的 */
  source: 'user' | 'model'
  /** 提案的截止时间（proposed 才有） */
  expiresAt: number | null
  /** 决定人与决定时间 */
  decidedBy: string | null
  decidedAt: number | null
  /** 提案卡片的消息 id，决定后就地更新 */
  cardMessageId: string | null
  /** 所属空间；换绑后职责跟着空间走 */
  spaceId: string | null
  chatId: string
  chatType: 'group' | 'p2p'
  name: string
  prompt: string
  schedule: ScheduleSpec
  watchChatIds: string[]
  deliverTo: 'chat' | 'dm'
  /** schedule/watch 的发送约定；followup 仍沿用原话题执行路径。 */
  deliveryPolicy: RoutineDeliveryPolicy
  /** followup：要回去继续的会话键 */
  sessionKey: string | null
  /** followup 的真实来源任务；旧记录为 null，不能按会话猜测 Work。 */
  originTaskId: number | null
  /** 仅 followup：明确绑定的反馈案件，旧记录保持空，不按会话猜测。 */
  feedbackId: number | null
  enabled: boolean
  disabledReason: string | null
  nextRunAt: number
  lastRunAt: number | null
  /** 最近一次成功（ok/skipped）结束的时间；失败不推进它，定时类的下一轮窗口从这里算起。 */
  lastSuccessAt: number | null
  /** 手动暂停时约定的自动恢复时间；恢复仍走与手动恢复相同的检查。 */
  resumeAt: number | null
  /** 群消息流已完整读取并成功处理到的秒级上界；不等同于运行完成时间。 */
  messageCursorSec: number | null
  /** 关注职责的触发阈值：窗口内新消息不到这个数就不启动模型，只记 skipped（0 = 不设阈值）。 */
  minNewMessages: number
  /** 窗口里有 @ 委托人或机器人的消息时，即使不到阈值也照常运行。 */
  alwaysOnMention: boolean
  lastStatus: RoutineRunStatus | null
  lastError: string | null
  failCount: number
  runs: number
  createdAt: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  owner_open_id TEXT,
  chat_id TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  watch_chat_ids TEXT NOT NULL DEFAULT '[]',
  deliver_to TEXT NOT NULL DEFAULT 'chat',
  enabled INTEGER NOT NULL DEFAULT 1,
  disabled_reason TEXT,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_status TEXT,
  last_error TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routines_due ON routines(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_routines_chat ON routines(chat_id);
CREATE TABLE IF NOT EXISTS routine_occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  config_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT,
  window_key TEXT,
  window_duplicate_of INTEGER,
  UNIQUE (routine_id, scheduled_at, config_version)
);
CREATE INDEX IF NOT EXISTS idx_routine_occurrences_status ON routine_occurrences(status);
CREATE INDEX IF NOT EXISTS idx_routine_occurrences_routine ON routine_occurrences(routine_id, id);
`

/**
 * occurrence 身份索引：一个 routine 的一个窗口最多一条未取消记录，配置版本不参与。
 * 表级 UNIQUE(routine_id, scheduled_at, config_version) 是旧身份的残留：旧表无法不重建就去掉，新表沿用同一定义避免两套 schema；
 * 每次把 next_run_at 拨回旧时刻的操作都会递增 config_version，所以它不会拒绝新身份允许的写入。
 */
const WINDOW_INDEX = 'idx_routine_occurrences_window'
const WINDOW_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS ${WINDOW_INDEX} ON routine_occurrences(routine_id, window_key) WHERE status <> 'cancelled' AND window_duplicate_of IS NULL`
/** 与 occurrenceWindowKey 相同的推导（整数毫秒 → UTC ISO），用于回填旧行。 */
const WINDOW_KEY_SQL = `strftime('%Y-%m-%dT%H:%M:%S', CAST(scheduled_at AS INTEGER) / 1000, 'unixepoch') || printf('.%03dZ', CAST(scheduled_at AS INTEGER) % 1000)`

/** 老库补列（每一项都是可空或有默认值，老数据自动落到"人建的、已生效"这一档）。 */
const ADD_COLUMNS: [string, string][] = [
  ['session_key', 'TEXT'],
  ['origin_task_id', 'INTEGER'],
  ['run_as', 'TEXT'],
  ['status', `TEXT NOT NULL DEFAULT 'active'`],
  ['source', `TEXT NOT NULL DEFAULT 'user'`],
  ['expires_at', 'INTEGER'],
  ['decided_by', 'TEXT'],
  ['decided_at', 'INTEGER'],
  ['card_message_id', 'TEXT'],
  ['space_id', 'TEXT'],
  ['config_version', 'INTEGER NOT NULL DEFAULT 1'],
  ['message_cursor_sec', 'INTEGER'],
  ['delivery_policy', "TEXT NOT NULL DEFAULT 'when_nonempty'"],
  ['feedback_id', 'INTEGER'],
  ['resume_at', 'INTEGER'],
  ['last_success_at', 'INTEGER'],
  // G7：旧行默认不设阈值、被 @ 照常运行，与加列前的行为相同。
  ['min_new_messages', 'INTEGER NOT NULL DEFAULT 0'],
  ['always_on_mention', 'INTEGER NOT NULL DEFAULT 1'],
]

/** 中国没有夏令时，固定 +8 即可；测试里可改。 */
export const DEFAULT_TZ_OFFSET_MIN = 480
export const MAX_CONSECUTIVE_FAILURES = 3

export function parseDeliveryPolicy(raw: unknown): RoutineDeliveryPolicy {
  if (raw === undefined) return 'when_nonempty'
  if (raw === 'when_nonempty' || raw === 'every_run') return raw
  throw new Error('delivery_policy 只能是 when_nonempty | every_run')
}

export function describeDeliveryPolicy(policy: RoutineDeliveryPolicy): string {
  return policy === 'every_run' ? '每次发送' : '有内容才发送'
}

/** 阈值上限；再大就不是“攒一批”而是永远不跑。 */
export const MAX_MIN_NEW_MESSAGES = 10_000
export const TRIGGER_WATCH_ONLY = '只有关注职责可以设置新消息阈值'

/** API/MCP 的 min_new_messages：缺省 0（不设阈值）。 */
export function parseMinNewMessages(raw: unknown): number {
  if (raw === undefined || raw === null) return 0
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_MIN_NEW_MESSAGES) {
    throw new Error(`min_new_messages 必须是 0 到 ${MAX_MIN_NEW_MESSAGES} 的整数；0 = 不设阈值`)
  }
  return n
}

/** API/MCP 的 always_on_mention：缺省 true（被 @ 时照常运行）。 */
export function parseAlwaysOnMention(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true
  if (typeof raw === 'boolean') return raw
  if (raw === 0 || raw === 1) return raw === 1
  throw new Error('always_on_mention 必须是 true 或 false')
}

/** 列表和回执里的一句话；没设阈值就是空串。 */
export function describeTrigger(routine: Pick<Routine, 'kind' | 'minNewMessages' | 'alwaysOnMention'>): string {
  if (routine.kind !== 'watch' || routine.minNewMessages <= 0) return ''
  return `至少 ${routine.minNewMessages} 条新消息才运行${routine.alwaysOnMention ? '（被 @ 时照常运行）' : '（被 @ 也不例外）'}`
}

/** 重叠判定窗口：两条职责的下次运行时间相差不超过这么久才算“产出重复”（G9）。 */
export const OVERLAP_WINDOW_MS = 45 * 60_000
export type RoutineOverlapReason = 'same_watch_chats' | 'same_audience_and_archive'
export interface RoutineOverlap { routine: Routine; reason: RoutineOverlapReason; gapMs: number }

export function parseSchedule(raw: unknown): ScheduleSpec {
  if (!raw || typeof raw !== 'object') throw new Error('schedule 必须是对象')
  const s = raw as Record<string, unknown>
  const quietHours = parseQuietHours(s.quietHours ?? s.quiet_hours)
  const quiet = quietHours ? { quietHours } : {}
  if (s.type === 'daily') {
    const at = typeof s.at === 'string' ? s.at.trim() : ''
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) throw new Error('daily.at 必须是 HH:MM（24 小时制）')
    let days: number[] | undefined
    if (s.days !== undefined) {
      if (!Array.isArray(s.days) || !s.days.length) throw new Error('daily.days 必须是非空数组，0=周日 … 6=周六')
      days = [...new Set(s.days.map((d) => Number(d)))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort()
      if (!days.length) throw new Error('daily.days 里没有合法的星期数字')
    }
    return days ? { type: 'daily', at: at.padStart(5, '0'), days, ...quiet } : { type: 'daily', at: at.padStart(5, '0'), ...quiet }
  }
  if (s.type === 'interval') {
    const m = Number(s.everyMinutes ?? s.every_minutes)
    if (!Number.isFinite(m) || m !== 0 && (m < 5 || m > 24 * 60 * 30)) throw new Error('interval.everyMinutes 为 0 时停用，否则必须在 5 到 43200 之间')
    return { type: 'interval', everyMinutes: Math.floor(m), ...quiet }
  }
  if (s.type === 'once') {
    if (quietHours) throw new Error('一次性提醒请直接指定允许提醒的时间；安静时段用于长期职责')
    const at = typeof s.at === 'string' ? Date.parse(s.at) : Number(s.atMs ?? s.at)
    if (!Number.isFinite(at)) throw new Error('once.at 必须是 ISO 时间')
    return { type: 'once', atMs: at }
  }
  throw new Error('schedule.type 只能是 daily | interval | once')
}

/** 下一次运行时刻（ms）。daily 按本地时区（默认东八区）算，严格晚于 fromMs。 */
export function nextRunAt(spec: ScheduleSpec, fromMs: number, tzOffsetMin = DEFAULT_TZ_OFFSET_MIN): number {
  if (spec.type === 'interval') return scheduleDisabled(spec) ? Number.POSITIVE_INFINITY : afterQuietHours(spec, fromMs + spec.everyMinutes * 60_000, tzOffsetMin)
  if (spec.type === 'once') return spec.atMs > fromMs ? spec.atMs : Number.POSITIVE_INFINITY
  const [hh, mm] = spec.at.split(':').map(Number) as [number, number]
  const offset = tzOffsetMin * 60_000
  const local = new Date(fromMs + offset)
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  for (let i = 0; i < 8; i += 1) {
    const candidateLocal = dayStart + i * 86_400_000 + (hh * 60 + mm) * 60_000
    const candidate = candidateLocal - offset
    const weekday = new Date(candidateLocal).getUTCDay()
    const allowed = afterQuietHours(spec, candidate, tzOffsetMin)
    if (allowed > fromMs && (!spec.days || spec.days.includes(weekday))) return allowed
  }
  return fromMs + 86_400_000
}

export function describeSchedule(spec: ScheduleSpec, tzOffsetMin?: number): string {
  if (spec.type !== 'once' && spec.quietHours) {
    const { quietHours, ...base } = spec
    return `${describeSchedule(base, tzOffsetMin)}；${quietHours.start}–${quietHours.end} 安静时段`
  }
  if (scheduleDisabled(spec)) return FREQUENCY_DISABLED
  if (spec.type === 'interval') return spec.everyMinutes % 60 === 0 ? `每 ${spec.everyMinutes / 60} 小时` : `每 ${spec.everyMinutes} 分钟`
  if (spec.type === 'once') {
    // Explicit offsets describe the scheduler's fixed timezone, independent of the browser/host timezone.
    // Omitted offsets retain the existing display contract for other callers.
    const local = new Date(spec.atMs + (tzOffsetMin ?? 0) * 60_000)
    return `一次性 ${local.toLocaleString('zh-CN', { timeZone: tzOffsetMin === undefined ? 'Asia/Shanghai' : 'UTC', hour12: false })}`
  }
  const names = ['日', '一', '二', '三', '四', '五', '六']
  if (!spec.days) return `每天 ${spec.at}`
  if (spec.days.join() === '1,2,3,4,5') return `工作日 ${spec.at}`
  return `每周${spec.days.map((d) => names[d]).join('、')} ${spec.at}`
}

export class RoutineStore {
  get timezoneOffsetMinutes(): number { return this.tzOffsetMin }

  constructor(
    private readonly db: DatabaseSync,
    private readonly tzOffsetMin = DEFAULT_TZ_OFFSET_MIN,
  ) {
    db.exec(SCHEMA)
    const cols = new Set((db.prepare('PRAGMA table_info(routines)').all() as { name: string }[]).map((c) => c.name))
    for (const [name, type] of ADD_COLUMNS) if (!cols.has(name)) db.exec(`ALTER TABLE routines ADD COLUMN ${name} ${type}`)
    // 老数据：以创建者的身份跑（以前就是这个语义，只是没写下来）
    if (!cols.has('run_as')) db.exec('UPDATE routines SET run_as = owner_open_id WHERE run_as IS NULL')
    db.exec('CREATE INDEX IF NOT EXISTS idx_routines_feedback ON routines(feedback_id, space_id)')
    this.migrateOccurrenceWindows()
  }

  /**
   * 只加列、只回填空值：旧行保留 id、scheduled_at、config_version（因此执行键不变），窗口由 scheduled_at 推导，不重跑任何旧窗口。
   * 旧身份允许同一窗口按配置版本多行；建身份索引前把每组除最后一行外都标为 window_duplicate_of，两行都保留、不删不改号。
   */
  private migrateOccurrenceWindows(): void {
    this.atomic(() => {
      const cols = new Set((this.db.prepare('PRAGMA table_info(routine_occurrences)').all() as { name: string }[]).map((c) => c.name))
      if (!cols.has('window_key')) this.db.exec('ALTER TABLE routine_occurrences ADD COLUMN window_key TEXT')
      if (!cols.has('window_duplicate_of')) this.db.exec('ALTER TABLE routine_occurrences ADD COLUMN window_duplicate_of INTEGER')
      this.db.exec(`UPDATE routine_occurrences SET window_key = ${WINDOW_KEY_SQL} WHERE window_key IS NULL`)
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(WINDOW_INDEX)) return
      const rows = this.db.prepare("SELECT id, routine_id, window_key FROM routine_occurrences WHERE status <> 'cancelled' AND window_duplicate_of IS NULL ORDER BY routine_id, window_key, id")
        .all() as { id: number; routine_id: number; window_key: string }[]
      const mark = this.db.prepare('UPDATE routine_occurrences SET window_duplicate_of = ? WHERE id = ?')
      let start = 0
      for (let i = 1; i <= rows.length; i += 1) {
        if (i < rows.length && rows[i]!.routine_id === rows[start]!.routine_id && rows[i]!.window_key === rows[start]!.window_key) continue
        for (let k = start; k < i - 1; k += 1) mark.run(rows[i - 1]!.id, rows[k]!.id)
        start = i
      }
      this.db.exec(WINDOW_INDEX_SQL)
    })
  }

  add(input: {
    kind: RoutineKind
    ownerOpenId?: string
    /** 以谁的身份跑；不给就等于 ownerOpenId（无主 = 只读） */
    runAs?: string
    spaceId?: string
    chatId: string
    chatType: 'group' | 'p2p'
    name: string
    prompt: string
    schedule: ScheduleSpec
    watchChatIds?: string[]
    deliverTo?: 'chat' | 'dm'
    deliveryPolicy?: RoutineDeliveryPolicy
    /** 仅 watch：窗口内新消息不到这个数就不启动模型（0 = 不设阈值） */
    minNewMessages?: number
    /** 仅 watch：被 @ 时即使不到阈值也照常运行（默认 true） */
    alwaysOnMention?: boolean
    sessionKey?: string
    originTaskId?: number | null
    feedbackId?: number | null
    /** 'model' = 模型自己挖的职责提案，先进 proposed，等人点接受 */
    source?: 'user' | 'model'
    now?: number
  }): Routine {
    if (input.originTaskId != null && (input.kind !== 'followup' || !Number.isSafeInteger(input.originTaskId) || input.originTaskId < 1)) throw new RoutineControlError('跟进来源任务无效')
    if (input.feedbackId != null) {
      if (input.kind !== 'followup') throw new RoutineControlError('只有 followup 可以关联反馈')
      this.requireFeedback(input.feedbackId, input.spaceId ?? null, input.chatId, true)
    }
    if (input.kind === 'followup' && input.deliveryPolicy !== undefined) throw new Error('followup 不支持 delivery_policy')
    const deliveryPolicy = parseDeliveryPolicy(input.deliveryPolicy)
    const minNewMessages = parseMinNewMessages(input.minNewMessages), alwaysOnMention = parseAlwaysOnMention(input.alwaysOnMention)
    if (input.kind !== 'watch' && (minNewMessages !== 0 || input.alwaysOnMention !== undefined)) throw new RoutineControlError(TRIGGER_WATCH_ONLY)
    const now = input.now ?? Date.now()
    const next = nextRunAt(input.schedule, now, this.tzOffsetMin)
    if (!Number.isFinite(next) && !scheduleDisabled(input.schedule)) throw new Error('这个时间已经过了')
    const source = input.source ?? 'user'
    const status: RoutineStatus = source === 'model' ? 'proposed' : 'active'
    const res = this.db
      .prepare(
        `INSERT INTO routines (kind, owner_open_id, run_as, space_id, chat_id, chat_type, name, prompt, schedule, watch_chat_ids, deliver_to, delivery_policy, min_new_messages, always_on_mention, session_key, origin_task_id, feedback_id, source, status, expires_at, enabled, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.ownerOpenId ?? null,
        input.runAs ?? input.ownerOpenId ?? null,
        input.spaceId ?? null,
        input.chatId,
        input.chatType,
        input.name.replace(/\s+/g, ' ').trim().slice(0, 80),
        input.prompt.trim().slice(0, 4000),
        JSON.stringify(input.schedule),
        JSON.stringify(input.watchChatIds ?? []),
        input.deliverTo ?? (input.chatType === 'p2p' ? 'dm' : 'chat'),
        deliveryPolicy,
        minNewMessages,
        alwaysOnMention ? 1 : 0,
        input.sessionKey ?? null,
        input.originTaskId ?? null,
        input.feedbackId ?? null,
        source,
        status,
        status === 'proposed' ? now + PROPOSAL_TTL_MS : null,
        scheduleDisabled(input.schedule) ? 0 : 1,
        Number.isFinite(next) ? next : now,
        now,
      )
    if (scheduleDisabled(input.schedule)) this.db.prepare('UPDATE routines SET disabled_reason = ? WHERE id = ?').run(FREQUENCY_DISABLED, res.lastInsertRowid)
    return this.get(Number(res.lastInsertRowid)) as Routine
  }

  // ---- 提案的一生 ----

  /** 待处理的提案（某个空间 / 全部）。 */
  proposals(spaceId?: string): Routine[] {
    const rows = (spaceId
      ? this.db.prepare(`SELECT * FROM routines WHERE status = 'proposed' AND space_id = ? ORDER BY id`).all(spaceId)
      : this.db.prepare(`SELECT * FROM routines WHERE status = 'proposed' ORDER BY id`).all()) as Record<string, unknown>[]
    return rows.map(toRoutine)
  }

  /** 接受提案：从此生效，以点的人的身份跑。 */
  accept(id: number, by: string | undefined, nowMs = Date.now()): Routine | undefined {
    const r = this.get(id)
    if (!r || r.status !== 'proposed') return undefined
    this.assertFeedbackCurrent(r)
    const next = nextRunAt(r.schedule, nowMs, this.tzOffsetMin)
    this.db
      .prepare(`UPDATE routines SET status = 'active', enabled = ?, disabled_reason = ?, run_as = COALESCE(?, run_as), owner_open_id = COALESCE(owner_open_id, ?), decided_by = ?, decided_at = ?, expires_at = NULL, next_run_at = ? WHERE id = ?`)
      .run(scheduleDisabled(r.schedule) ? 0 : 1, scheduleDisabled(r.schedule) ? FREQUENCY_DISABLED : null, by ?? null, by ?? null, by ?? null, nowMs, Number.isFinite(next) ? next : nowMs, id)
    return this.get(id)
  }

  ignore(id: number, by: string | undefined, nowMs = Date.now()): Routine | undefined {
    const r = this.get(id)
    if (!r || r.status !== 'proposed') return undefined
    this.db.prepare(`UPDATE routines SET status = 'ignored', enabled = 0, disabled_reason = '提案被忽略', decided_by = ?, decided_at = ? WHERE id = ?`).run(by ?? null, nowMs, id)
    return this.get(id)
  }

  /** 到期没人理的提案作废；返回作废掉的那些（调用方去把卡片改掉）。 */
  expireProposals(nowMs = Date.now()): Routine[] {
    const rows = this.db.prepare(`SELECT * FROM routines WHERE status = 'proposed' AND expires_at IS NOT NULL AND expires_at <= ?`).all(nowMs) as Record<string, unknown>[]
    const stale = rows.map(toRoutine)
    if (stale.length) {
      this.db.prepare(`UPDATE routines SET status = 'expired', enabled = 0, disabled_reason = '提案 72 小时没人处理，已作废' WHERE id IN (${stale.map(() => '?').join(', ')})`).run(...stale.map((r) => r.id))
    }
    return stale
  }

  /** 点击时已过 72 小时：只作废这一条（条件更新，已被决定或已作废的不动）。返回是否由这次调用作废。 */
  expireProposal(id: number, nowMs = Date.now()): boolean {
    return Number(this.db.prepare(`UPDATE routines SET status = 'expired', enabled = 0, disabled_reason = '提案 72 小时没人处理，已作废'
      WHERE id = ? AND status = 'proposed' AND expires_at IS NOT NULL AND expires_at <= ?`).run(id, nowMs).changes) > 0
  }

  setCardMessageId(id: number, messageId: string): void {
    this.db.prepare('UPDATE routines SET card_message_id = ? WHERE id = ?').run(messageId, id)
  }

  /** 某个会话还没到点的 followup（用于列出 / 去重）。 */
  followupsFor(sessionKey: string): Routine[] {
    const rows = this.db.prepare(`SELECT * FROM routines WHERE kind = 'followup' AND session_key = ? AND enabled = 1 ORDER BY next_run_at`).all(sessionKey) as Record<string, unknown>[]
    return rows.map(toRoutine)
  }

  /** 全部明确关联，不漏已 claim 后 enabled=false 的 once，也不猜同 Session 的未绑定项。 */
  listForFeedback(feedbackId: number, spaceId: string | null): Routine[] {
    this.requireFeedback(feedbackId, spaceId)
    return (this.db.prepare("SELECT * FROM routines WHERE feedback_id = ? AND space_id IS ? ORDER BY id")
      .all(feedbackId, spaceId) as Record<string, unknown>[]).map(toRoutine)
  }

  /** 仅持久变更，可嵌入案件停止事务；宿主在外层提交后才 abort 对应运行。 */
  pauseForFeedback(feedbackId: number, spaceId: string | null, nowMs = Date.now()): number {
    return this.atomic(() => {
      const routines = this.listForFeedback(feedbackId, spaceId)
      let changed = 0
      for (const routine of routines) {
        const inFlight = this.db.prepare("SELECT 1 FROM routine_occurrences WHERE routine_id = ? AND status IN ('pending', 'running') LIMIT 1").get(routine.id)
        if (!routine.enabled && routine.disabledReason === FEEDBACK_STOPPED && !inFlight) continue
        this.db.prepare('UPDATE routines SET enabled = 0, disabled_reason = ?, resume_at = NULL, config_version = config_version + 1 WHERE id = ?')
          .run(FEEDBACK_STOPPED, routine.id)
        this.cancelOccurrences(routine.id, nowMs, FEEDBACK_STOPPED)
        changed += 1
      }
      return changed
    })
  }

  private requireFeedback(feedbackId: number, spaceId: string | null, chatId?: string, active = false): void {
    if (!Number.isSafeInteger(feedbackId) || feedbackId < 1) throw new RoutineControlError('反馈编号无效')
    const tableExists = (name: string) => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
    if (!tableExists('bug_buckets')) throw new RoutineControlError('反馈记录不可用，不能关联职责')
    const bucket = this.db.prepare('SELECT intake_phase FROM bug_buckets WHERE id = ? AND space_id IS ?').get(feedbackId, spaceId) as { intake_phase: string } | undefined
    if (!bucket) throw new RoutineControlError('反馈不存在或不属于当前空间')
    if (chatId !== undefined) {
      const inReports = tableExists('bug_reports') && this.db.prepare('SELECT 1 FROM bug_reports WHERE bucket_id = ? AND chat_id = ? LIMIT 1').get(feedbackId, chatId)
      const inAnchors = tableExists('bug_message_anchors') && this.db.prepare('SELECT 1 FROM bug_message_anchors WHERE bucket_id = ? AND chat_id = ? LIMIT 1').get(feedbackId, chatId)
      if (!inReports && !inAnchors) throw new RoutineControlError('反馈不属于当前聊天')
    }
    if (active && bucket.intake_phase === 'cancelled') throw new RoutineControlError(FEEDBACK_STOPPED)
  }

  private assertFeedbackCurrent(routine: Routine): void {
    if (routine.feedbackId === null) return
    if (routine.kind !== 'followup') throw new RoutineControlError('只有 followup 可以关联反馈')
    this.requireFeedback(routine.feedbackId, routine.spaceId, routine.chatId, true)
  }

  private feedbackCurrent(routine: Routine): boolean {
    try { this.assertFeedbackCurrent(routine); return true } catch (error) {
      if (error instanceof RoutineControlError) return false
      throw error
    }
  }

  get(id: number): Routine | undefined {
    const r = this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? toRoutine(r) : undefined
  }

  /** 某个群 / 某个人的 routines（私聊按 owner，群按 chat）。 */
  listFor(scope: { chatId: string; chatType: 'group' | 'p2p'; ownerOpenId?: string }, includeDisabled = true): Routine[] {
    const rows = (scope.chatType === 'p2p' && scope.ownerOpenId
      ? this.db.prepare(`SELECT * FROM routines WHERE chat_type = 'p2p' AND owner_open_id = ? ${includeDisabled ? '' : 'AND enabled = 1'} ORDER BY id`).all(scope.ownerOpenId)
      : this.db.prepare(`SELECT * FROM routines WHERE chat_id = ? ${includeDisabled ? '' : 'AND enabled = 1'} ORDER BY id`).all(scope.chatId)) as Record<string, unknown>[]
    return rows.map(toRoutine)
  }

  listAll(): Routine[] {
    return (this.db.prepare('SELECT * FROM routines ORDER BY id').all() as Record<string, unknown>[]).map(toRoutine)
  }

  /** 到期且启用的快照；调度执行前必须再用 claimDueOccurrence 检查并入账。 */
  due(nowMs: number, limit = 20): Routine[] {
    const rows = this.db.prepare(`SELECT * FROM routines WHERE enabled = 1 AND status = 'active' AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?`).all(nowMs, limit) as Record<string, unknown>[]
    return rows.map(toRoutine)
  }

  /** 把 next_run_at 推到下一次；一次性任务跑完即停用。 */
  advance(id: number, nowMs: number): void {
    const r = this.get(id)
    if (!r) return
    const next = nextRunAt(r.schedule, nowMs, this.tzOffsetMin)
    if (!Number.isFinite(next)) {
      this.db.prepare(`UPDATE routines SET enabled = 0, disabled_reason = '一次性任务已执行', next_run_at = ? WHERE id = ?`).run(nowMs, id)
      return
    }
    this.db.prepare('UPDATE routines SET next_run_at = ? WHERE id = ?').run(next, id)
  }

  /** 同步 SAVEPOINT 可嵌入 Registry.db 的外层事务，不提交调用方的事务。 */
  private atomic<T>(fn: () => T): T {
    this.db.exec('SAVEPOINT routine_occurrence_tx')
    try {
      const result = fn()
      this.db.exec('RELEASE SAVEPOINT routine_occurrence_tx')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK TO SAVEPOINT routine_occurrence_tx')
      this.db.exec('RELEASE SAVEPOINT routine_occurrence_tx')
      throw err
    }
  }

  configVersion(id: number): number | undefined {
    const row = this.db.prepare('SELECT config_version FROM routines WHERE id = ?').get(id) as { config_version: number } | undefined
    return row ? Number(row.config_version) : undefined
  }

  /** 仅网关核验完整读取后提交；配置变化和并发旧窗口不能推进或回退游标。 */
  advanceMessageCursor(id: number, configVersion: number, startSec: number, endSec: number): boolean {
    if (!Number.isSafeInteger(startSec) || !Number.isSafeInteger(endSec) || startSec < 0 || endSec < startSec) return false
    return Number(this.db.prepare(`UPDATE routines SET message_cursor_sec = ? WHERE id = ? AND kind = 'watch'
      AND status = 'active' AND config_version = ?
      AND coalesce(message_cursor_sec, CAST(created_at / 1000 AS INTEGER)) = ?`)
      .run(endSec, id, configVersion, startSec).changes) > 0
  }

  getOccurrence(id: number): RoutineOccurrence | undefined {
    const row = this.db.prepare('SELECT * FROM routine_occurrences WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? toOccurrence(row) : undefined
  }

  /** 发布前重验真实执行身份；手动执行允许运行已暂停的职责，但不能越过执行后发生的配置变化。 */
  currentForExecution(id: number, configVersion: number, occurrenceId?: number, nowMs = Date.now()): Routine | undefined {
    const r = this.get(id)
    if (!r || r.status !== 'active' || this.configVersion(id) !== configVersion || !this.feedbackCurrent(r)) return undefined
    if (occurrenceId !== undefined) {
      const occurrence = this.getOccurrence(occurrenceId)
      if (!occurrence || occurrence.routineId !== id || occurrence.configVersion !== configVersion || occurrence.status !== 'running') return undefined
      // Automatic work must remain quiet even if an earlier model request crosses the boundary.
      // Cancel this window without advancing its read cursor or counting a failure; next window catches up.
      const allowed = afterQuietHours(r.schedule, nowMs, this.tzOffsetMin)
      if (allowed > nowMs) {
        this.atomic(() => {
          this.db.prepare("UPDATE routine_occurrences SET status = 'cancelled', finished_at = ?, error = ? WHERE id = ? AND status = 'running'").run(nowMs, QUIET_HOURS, occurrenceId)
          this.db.prepare('UPDATE routines SET next_run_at = ? WHERE id = ?').run(afterQuietHours(r.schedule, r.nextRunAt, this.tzOffsetMin), id)
        })
        return undefined
      }
      // claimDueOccurrence 已把一次性任务停用；这不是人为撤销，必须保留该次执行的发送资格。
      const oncePending = r.schedule.type === 'once' && r.disabledReason === ONCE_PENDING
      if (!r.enabled && !oncePending) return undefined
    }
    return r
  }

  /** 历史只按 routine 查询；调用方沿 routine 的权限边界展示。 */
  listOccurrences(routineId: number, limit = 20): RoutineOccurrence[] {
    const capped = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20
    return (this.db.prepare('SELECT * FROM routine_occurrences WHERE routine_id = ? ORDER BY id DESC LIMIT ?').all(routineId, capped) as Record<string, unknown>[]).map(toOccurrence)
  }

  /** occurrence 与游标一起提交；重复快照、已暂停/删除的 routine 不会再次开始。 */
  claimDueOccurrence(id: number, scheduledAt: number, nowMs: number): RoutineOccurrence | undefined {
    return this.atomic(() => {
      const r = this.get(id)
      if (!r || !r.enabled || r.status !== 'active' || r.nextRunAt !== scheduledAt || scheduledAt > nowMs || !this.feedbackCurrent(r)) return undefined
      const allowed = afterQuietHours(r.schedule, nowMs, this.tzOffsetMin)
      if (allowed > nowMs) {
        this.db.prepare('UPDATE routines SET next_run_at = ? WHERE id = ?').run(allowed, id)
        return undefined
      }
      // 同一个 routine 不并行启动另一个 occurrence；不引入多 worker 租约语义。
      if (this.db.prepare("SELECT id FROM routine_occurrences WHERE routine_id = ? AND status IN ('pending', 'running') LIMIT 1").get(id)) return undefined
      const window = occurrenceWindowKey(scheduledAt)
      // 已有执行记录的窗口不因配置版本变了就再跑一次（如一次性任务在同一时刻重新启用）；计划越过它继续。
      if (this.db.prepare("SELECT id FROM routine_occurrences WHERE routine_id = ? AND window_key = ? AND status <> 'cancelled' AND window_duplicate_of IS NULL LIMIT 1").get(id, window)) {
        this.advance(id, nowMs)
        return undefined
      }
      const version = this.configVersion(id)!
      const inserted = this.db.prepare("INSERT INTO routine_occurrences (routine_id, scheduled_at, window_key, config_version, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(id, scheduledAt, window, version, nowMs)
      this.advance(id, nowMs)
      if (r.schedule.type === 'once') this.db.prepare('UPDATE routines SET disabled_reason = ? WHERE id = ?').run(ONCE_PENDING, id)
      return this.getOccurrence(Number(inserted.lastInsertRowid))
    })
  }

  /** 开始前重新检查启用状态；返回与原调度回调相同的到期快照。只改配置不换窗口，执行记录开始时的当前配置版本。 */
  startOccurrence(id: number, nowMs: number): Routine | undefined {
    return this.atomic(() => {
      const occurrence = this.getOccurrence(id)
      if (!occurrence || occurrence.status !== 'pending') return undefined
      const r = this.get(occurrence.routineId)
      const oncePending = r?.schedule.type === 'once' && r.disabledReason === ONCE_PENDING
      if (!r || r.status !== 'active' || (!r.enabled && !oncePending) || !this.feedbackCurrent(r)) {
        this.db.prepare("UPDATE routine_occurrences SET status = 'cancelled', finished_at = ?, error = '职责已停用或删除' WHERE id = ? AND status = 'pending'").run(nowMs, id)
        return undefined
      }
      const allowed = afterQuietHours(r.schedule, nowMs, this.tzOffsetMin)
      if (allowed > nowMs) {
        this.db.prepare("UPDATE routine_occurrences SET status = 'cancelled', finished_at = ?, error = ? WHERE id = ?").run(nowMs, QUIET_HOURS, id)
        this.db.prepare('UPDATE routines SET next_run_at = ? WHERE id = ?').run(Math.max(allowed, r.nextRunAt), r.id)
        return undefined
      }
      const updated = this.db.prepare("UPDATE routine_occurrences SET status = 'running', started_at = ?, config_version = ? WHERE id = ? AND status = 'pending'").run(nowMs, this.configVersion(r.id)!, id)
      return Number(updated.changes) ? { ...r, enabled: true, disabledReason: null, nextRunAt: occurrence.scheduledAt } : undefined
    })
  }

  /** 终态只提交一次，统计更新与 occurrence 完成在同一事务。 */
  finishOccurrence(id: number, status: RoutineRunStatus, nowMs: number, error?: string): Routine | undefined {
    return this.atomic(() => {
      const occurrence = this.getOccurrence(id)
      if (!occurrence || occurrence.status !== 'running') return undefined
      const routine = this.get(occurrence.routineId)
      if (routine && !this.feedbackCurrent(routine)) {
        this.cancelOccurrences(routine.id, nowMs, FEEDBACK_STOPPED)
        return undefined
      }
      const authSkipped = status === 'skipped' && this.get(occurrence.routineId)?.disabledReason === AUTH_EXPIRED
      const changed = this.db.prepare("UPDATE routine_occurrences SET status = ?, finished_at = ?, error = ? WHERE id = ? AND status = 'running'").run(status, nowMs, error?.slice(0, 500) ?? (authSkipped ? AUTH_EXPIRED : null), id)
      if (!Number(changed.changes)) return undefined
      // 没读到任何消息的授权失败不能当作 NOTHING：保留上次成功读取的游标供重新授权后补读。
      if (!authSkipped) this.recordRun(occurrence.routineId, status, nowMs, error)
      this.db.prepare('UPDATE routines SET disabled_reason = ? WHERE id = ? AND disabled_reason = ?').run(status === 'failed' ? '一次性任务执行失败' : '一次性任务已执行', occurrence.routineId, ONCE_PENDING)
      return this.get(occurrence.routineId)
    })
  }

  /** 超过补跑窗口的 occurrence 留痕，但保持原有语义：不移动已读游标或增加执行次数。 */
  skipOccurrence(id: number, nowMs: number, reason: string): void {
    this.atomic(() => {
      const occurrence = this.getOccurrence(id)
      if (!occurrence || occurrence.status !== 'pending') return
      this.db.prepare("UPDATE routine_occurrences SET status = 'skipped', finished_at = ?, error = ? WHERE id = ? AND status = 'pending'").run(nowMs, reason.slice(0, 500), id)
      this.db.prepare('UPDATE routines SET disabled_reason = ? WHERE id = ? AND disabled_reason = ?').run(reason.slice(0, 500), occurrence.routineId, ONCE_PENDING)
    })
  }

  /**
   * 仅在取得单实例调度权后的首次 tick 调用；不重放任何可能已生效的动作。
   * - 还没开始的调度：什么都没发生，取消这一轮、计划照常；一次性提醒重新排上原时刻。
   * - 已开始的周期职责：只有网关账本里查不到这次执行的任何投递、写调用或宿主写入，才从原读取位置继续；
   *   否则（包括账本缺失）仍停用并要求先核对。一次性任务开始后一律要求核对。
   */
  recoverInterruptedOccurrences(nowMs = Date.now()): RoutineOccurrence[] {
    return this.atomic(() => {
      const rows = this.db.prepare("SELECT * FROM routine_occurrences WHERE status IN ('pending', 'running') ORDER BY id").all() as Record<string, unknown>[]
      const interrupted: number[] = []
      for (const row of rows) {
        const occurrence = toOccurrence(row)
        const routine = this.get(occurrence.routineId)
        if (routine && !this.feedbackCurrent(routine)) {
          this.cancelOccurrences(routine.id, nowMs, FEEDBACK_STOPPED)
          this.db.prepare('UPDATE routines SET enabled = 0, disabled_reason = ? WHERE id = ?').run(FEEDBACK_STOPPED, routine.id)
          continue
        }
        if (occurrence.status === 'pending' && occurrence.startedAt === null) {
          this.db.prepare("UPDATE routine_occurrences SET status = 'cancelled', finished_at = ?, error = ? WHERE id = ?").run(nowMs, RESTART_NOT_STARTED, occurrence.id)
          if (routine?.schedule.type === 'once' && routine.disabledReason === ONCE_PENDING) {
            // A new config version lets the same window be claimed again; the cancelled row keeps the history.
            this.db.prepare('UPDATE routines SET enabled = 1, disabled_reason = NULL, next_run_at = ?, config_version = config_version + 1 WHERE id = ?').run(occurrence.scheduledAt, routine.id)
          }
          continue
        }
        if (routine && routine.schedule.type !== 'once' && this.interruptionEvidence(routine, occurrence) === 'none') {
          this.db.prepare("UPDATE routine_occurrences SET status = 'cancelled', finished_at = ?, error = ? WHERE id = ?").run(nowMs, RESTART_NO_EFFECT, occurrence.id)
          continue
        }
        this.db.prepare("UPDATE routine_occurrences SET status = 'interrupted', finished_at = ?, error = ? WHERE id = ?").run(nowMs, ROUTINE_INTERRUPTED, occurrence.id)
        this.db.prepare('UPDATE routines SET enabled = 0, disabled_reason = ?, last_error = ? WHERE id = ?').run(ROUTINE_INTERRUPTED, ROUTINE_INTERRUPTED, occurrence.routineId)
        interrupted.push(occurrence.id)
      }
      return interrupted.map(id => this.getOccurrence(id)!)
    })
  }

  /**
   * Read-only evidence for one interrupted execution. 'none' only when the gateway ledgers exist, every
   * routine Run for this execution key ran managed (all effects through the gateway), every recorded call
   * needed read scopes only and no delivery was even planned. Missing ledgers, Runs or a workspace
   * boundary are not evidence of no effect.
   */
  private interruptionEvidence(routine: Routine, occurrence: RoutineOccurrence): 'none' | 'recorded' | 'missing' {
    const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('deliveries','run_attempts','run_api_calls')`).all() as { name: string }[]).map(row => row.name))
    if (tables.size !== 3) return 'missing'
    const key = routineExecutionKey(routine.id, { occurrenceId: occurrence.id, configVersion: occurrence.configVersion })
    // Exact context or `${key}:…` (tool/notice contexts); ';' sorts right after ':'.
    if (this.db.prepare('SELECT 1 FROM deliveries WHERE context_ref = ? OR (context_ref >= ? AND context_ref < ?) LIMIT 1').get(key, `${key}:`, `${key};`)) return 'recorded'
    const attempts = this.db.prepare("SELECT id, execution_boundary FROM run_attempts WHERE trigger_key = ? AND stage = 'routine'").all(key) as { id: string; execution_boundary: string | null }[]
    // Only a managed Run routes every effect through the gateway ledger. A workspace (or unbound) Run can
    // act through its own shell and network, which leave no record here — same rule as recovery-evidence.
    if (!attempts.length || attempts.some(row => row.execution_boundary !== 'managed_api_v1')) return 'missing'
    const runs = attempts.map(row => row.id)
    const calls = this.db.prepare(`SELECT route, scopes_json FROM run_api_calls WHERE run_id IN (${runs.map(() => '?').join(',')})`).all(...runs) as { route: string; scopes_json: string }[]
    for (const call of calls) {
      if (String(call.route).startsWith('HOST ')) return 'recorded'
      let scopes: unknown
      try { scopes = JSON.parse(String(call.scopes_json)) } catch { return 'recorded' }
      if (!Array.isArray(scopes) || !scopes.length || scopes.some(scope => typeof scope !== 'string' || !readOnlyScope(scope))) return 'recorded'
    }
    return 'none'
  }

  /** Stop one execution without changing its responsibility or future schedule. */
  cancelOccurrence(id: number, nowMs: number, reason: string): void {
    this.atomic(() => {
      const occurrence = this.getOccurrence(id)
      if (!occurrence) return
      const changed = this.db.prepare("UPDATE routine_occurrences SET status = 'cancelled', finished_at = ?, error = ? WHERE id = ? AND status IN ('pending', 'running')")
        .run(nowMs, reason, id)
      if (Number(changed.changes)) this.db.prepare('UPDATE routines SET disabled_reason = ? WHERE id = ? AND disabled_reason = ?')
        .run('本次执行已停止', occurrence.routineId, ONCE_PENDING)
    })
  }

  private cancelOccurrences(id: number, nowMs: number, reason: string): void {
    this.db.prepare("UPDATE routine_occurrences SET status = 'cancelled', finished_at = ?, error = ? WHERE routine_id = ? AND status IN ('pending', 'running')").run(nowMs, reason, id)
  }

  recordRun(id: number, status: RoutineRunStatus, nowMs: number, error?: string): Routine | undefined {
    const current = this.get(id)
    if (current && !this.feedbackCurrent(current)) return undefined
    if (status === 'failed') {
      this.db
        .prepare(`UPDATE routines SET last_run_at = ?, last_status = 'failed', last_error = ?, fail_count = fail_count + 1, runs = runs + 1 WHERE id = ?`)
        .run(nowMs, (error ?? 'unknown').slice(0, 500), id)
      const r = this.get(id)
      if (r && r.failCount >= MAX_CONSECUTIVE_FAILURES) {
        this.db.prepare('UPDATE routines SET enabled = 0, disabled_reason = ? WHERE id = ?').run(`连续失败 ${r.failCount} 次：${(error ?? '').slice(0, 200)}`, id)
      }
    } else {
      this.db.prepare(`UPDATE routines SET last_run_at = ?, last_success_at = ?, last_status = ?, last_error = NULL, fail_count = 0, runs = runs + 1 WHERE id = ?`).run(nowMs, nowMs, status, id)
    }
    return this.get(id)
  }

  /** 只读恢复判定：控制与进度查询共用，不根据显示用的停用文案另推一次执行状态。 */
  resumeState(id: number): RoutineResumeState | undefined {
    const routine = this.get(id)
    if (!routine) return undefined
    try { this.assertFeedbackCurrent(routine) } catch (error) {
      if (error instanceof RoutineControlError) return { kind: 'feedback_blocked', routine, reason: error.message }
      throw error
    }
    if (routine.enabled) return { kind: 'enabled', routine }
    if (scheduleDisabled(routine.schedule)) return { kind: 'schedule_disabled', routine, reason: '频率为 0；先设置大于 0 的频率再恢复' }
    if (routine.disabledReason === ROUTINE_INTERRUPTED || this.listOccurrences(id, 1)[0]?.status === 'interrupted') {
      return { kind: 'inspect_previous_run', routine, reason: '上次执行中断，请先核对已产生的结果' }
    }
    if (routine.schedule.type === 'once') {
      const outstanding = this.db.prepare("SELECT id FROM routine_occurrences WHERE routine_id = ? AND status IN ('pending', 'running') LIMIT 1").get(id)
      if (outstanding) return { kind: 'waiting', routine, reason: '这条提醒仍在等待执行或执行中，不需要恢复' }
      if (routine.lastRunAt !== null && routine.lastRunAt >= routine.schedule.atMs) return { kind: 'completed', routine, reason: '这条一次性任务已经执行过；需要再做一次时，请指定新的时间' }
      // 暂停可能发生在远端接受与本地收尾之间；cancelled 不能证明没有发出结果。
      const started = this.db.prepare('SELECT id FROM routine_occurrences WHERE routine_id = ? AND scheduled_at >= ? AND started_at IS NOT NULL LIMIT 1').get(id, routine.schedule.atMs)
      if (started) return { kind: 'inspect_previous_run', routine, reason: '这条一次性任务已开始执行，请先核对结果；不会重新发送' }
    }
    return { kind: 'ready', routine }
  }

  /** 恢复暂停的计划，不把运行中、已完成或结果未知的一次执行重新排队。 */
  resume(id: number, nowMs = Date.now()): Routine | undefined {
    const state = this.resumeState(id)
    if (!state) return undefined
    if (state.kind === 'enabled') return state.routine
    if (state.kind !== 'ready') throw new RoutineControlError(state.reason)
    return this.setEnabled(id, true, nowMs)
  }

  setEnabled(id: number, enabled: boolean, nowMs = Date.now(), opts: { resumeAt?: number } = {}): Routine | undefined {
    return this.atomic(() => {
      const r = this.get(id)
      if (!r) return undefined
      if (enabled) {
        this.assertFeedbackCurrent(r)
        if (scheduleDisabled(r.schedule)) throw new RoutineControlError('频率为 0；先设置大于 0 的频率再恢复')
        const next = nextRunAt(r.schedule, nowMs, this.tzOffsetMin)
        this.db.prepare('UPDATE routines SET enabled = 1, disabled_reason = NULL, resume_at = NULL, fail_count = 0, next_run_at = ?, config_version = config_version + 1 WHERE id = ?').run(Number.isFinite(next) ? next : nowMs, id)
      } else {
        this.db.prepare(`UPDATE routines SET enabled = 0, disabled_reason = ?, resume_at = ?, config_version = config_version + 1 WHERE id = ?`).run(MANUAL_PAUSE, opts.resumeAt ?? null, id)
      }
      this.cancelOccurrences(id, nowMs, '职责启用状态已改变')
      return this.get(id)
    })
  }

  /** Change only the agreed automatic resume time of a manual pause; the plan itself is not touched. */
  setResumeAt(id: number, resumeAt: number | null): Routine | undefined {
    this.db.prepare('UPDATE routines SET resume_at = ? WHERE id = ? AND enabled = 0 AND disabled_reason = ?').run(resumeAt, id, MANUAL_PAUSE)
    return this.get(id)
  }

  /** Manual pauses whose agreed resume time has come. Resuming is the application's job. */
  dueResumes(nowMs: number, limit = 50): number[] {
    return (this.db.prepare(`SELECT id FROM routines WHERE enabled = 0 AND status = 'active' AND disabled_reason = ?
      AND resume_at IS NOT NULL AND resume_at <= ? ORDER BY resume_at, id LIMIT ?`).all(MANUAL_PAUSE, nowMs, limit) as { id: number }[]).map(row => Number(row.id))
  }

  /** 系统停用与手动关闭分开记录；保留读取游标，恢复空间不会自动重启职责。 */
  pauseForSpace(spaceId: string, chatId: string, nowMs = Date.now()): number {
    // 停用前发出的提案卡不能在空间恢复后接受：等待中的提案版本加一，旧卡从此失效。
    // 提案本身仍在等待，照原来的 72 小时路径作废并结清指针，不依赖调用方另做什么。
    this.db.prepare(`UPDATE routines SET config_version = config_version + 1
      WHERE (space_id = ? OR (space_id IS NULL AND chat_id = ?)) AND status = 'proposed'`).run(spaceId, chatId)
    // A manual pause with an agreed resume time must not wake up inside a stopped space either.
    this.db.prepare(`UPDATE routines SET resume_at = NULL WHERE (space_id = ? OR (space_id IS NULL AND chat_id = ?)) AND resume_at IS NOT NULL`).run(spaceId, chatId)
    const rows = this.db.prepare(`SELECT id FROM routines WHERE (space_id = ? OR (space_id IS NULL AND chat_id = ?))
      AND status = 'active' AND (enabled = 1 OR disabled_reason IN (?, ?))`)
      .all(spaceId, chatId, ONCE_PENDING, AUTH_EXPIRED) as { id: number }[]
    for (const { id } of rows) {
      this.db.prepare("UPDATE routines SET enabled = 0, disabled_reason = '空间已停用', resume_at = NULL, config_version = config_version + 1 WHERE id = ?").run(id)
      this.db.prepare("UPDATE routine_occurrences SET status = 'cancelled', finished_at = ?, error = '空间已停用' WHERE routine_id = ? AND status IN ('pending', 'running')").run(nowMs, id)
    }
    return rows.length
  }

  /**
   * 改一条已有任务的指令 / 名字 / 频率。**不新建、不重置游标**——这是关键：
   * 盯群任务攒了几天的读取位置和历史，删了重建全丢，而人只是想说一句
   * 「以后报告里带上产物链接」。改频率时才重算 next_run_at。
   */
  /**
   * 与 id 这条产出重复的其他职责（G9）：同一空间里正在生效（active 且 enabled）的 schedule / watch，
   * 满足「关注同一组群」或「投递给同一受众且写入同一归档目标」，并且两条下次运行时间相差不超过 45 分钟。
   * 归档目标：archive=doc 的职责各有自己的文档（journal:<id>），所以只有直接发聊天 / 私聊的会写到同一处。只读，不改任何行。
   */
  overlaps(id: number): RoutineOverlap[] {
    const a = this.get(id)
    if (!a || a.kind === 'followup' || a.status !== 'active' || !a.enabled) return []
    const rows = (a.spaceId
      ? this.db.prepare(`SELECT * FROM routines WHERE id <> ? AND space_id = ? AND status = 'active' AND enabled = 1 AND kind IN ('schedule', 'watch') ORDER BY id`).all(id, a.spaceId)
      : this.db.prepare(`SELECT * FROM routines WHERE id <> ? AND space_id IS NULL AND chat_id = ? AND status = 'active' AND enabled = 1 AND kind IN ('schedule', 'watch') ORDER BY id`).all(id, a.chatId)) as Record<string, unknown>[]
    const watchKey = (r: Routine): string => r.watchChatIds.length ? JSON.stringify([...new Set(r.watchChatIds)].sort()) : ''
    const out: RoutineOverlap[] = []
    for (const row of rows) {
      const b = toRoutine(row)
      const gapMs = Math.abs(a.nextRunAt - b.nextRunAt)
      if (!Number.isFinite(gapMs) || gapMs > OVERLAP_WINDOW_MS) continue
      if (a.kind === 'watch' && b.kind === 'watch' && watchKey(a) !== '' && watchKey(a) === watchKey(b)) {
        out.push({ routine: b, reason: 'same_watch_chats', gapMs })
        continue
      }
      if (this.audienceKey(a) === this.audienceKey(b) && this.archiveTarget(a) === this.archiveTarget(b)) out.push({ routine: b, reason: 'same_audience_and_archive', gapMs })
    }
    return out
  }

  private audienceKey(r: Routine): string {
    return r.deliverTo === 'dm' ? `dm:${r.runAs ?? r.ownerOpenId ?? ''}` : `chat:${r.chatId}`
  }

  /** 归档偏好存在 kv（routine-archive:<id>），不进 routines 表；没有 kv 表（纯 Store 测试）按 chat 处理。 */
  private archiveTarget(r: Routine): string {
    const hasKv = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get())
    const archive = hasKv ? (this.db.prepare('SELECT v FROM kv WHERE k = ?').get(`routine-archive:${r.id}`) as { v: string } | undefined)?.v : undefined
    return archive === 'doc' ? `doc:journal:${r.id}` : this.audienceKey(r)
  }

  update(id: number, patch: { name?: string; prompt?: string; schedule?: ScheduleSpec; deliveryPolicy?: RoutineDeliveryPolicy; watchChatIds?: string[]; minNewMessages?: number; alwaysOnMention?: boolean }, nowMs = Date.now()): Routine | undefined {
    const r = this.get(id)
    if (!r) return undefined
    this.assertFeedbackCurrent(r)
    const sets: string[] = []
    const vals: (string | number)[] = []
    if (patch.watchChatIds !== undefined) {
      if (r.kind !== 'watch' || !patch.watchChatIds.length) throw new RoutineControlError('只有关注职责可以设置非空关注群范围')
      sets.push('watch_chat_ids = ?')
      vals.push(JSON.stringify([...new Set(patch.watchChatIds)]))
    }
    if (patch.minNewMessages !== undefined || patch.alwaysOnMention !== undefined) {
      if (r.kind !== 'watch') throw new RoutineControlError(TRIGGER_WATCH_ONLY)
      if (patch.minNewMessages !== undefined) {
        sets.push('min_new_messages = ?')
        vals.push(parseMinNewMessages(patch.minNewMessages))
      }
      if (patch.alwaysOnMention !== undefined) {
        sets.push('always_on_mention = ?')
        vals.push(parseAlwaysOnMention(patch.alwaysOnMention) ? 1 : 0)
      }
    }
    if (patch.deliveryPolicy !== undefined) {
      if (r.kind === 'followup') throw new Error('followup 不支持 delivery_policy')
      sets.push('delivery_policy = ?')
      vals.push(parseDeliveryPolicy(patch.deliveryPolicy))
    }
    if (patch.name !== undefined && patch.name.trim()) {
      sets.push('name = ?')
      vals.push(patch.name.trim().slice(0, 200))
    }
    if (patch.prompt !== undefined && patch.prompt.trim()) {
      sets.push('prompt = ?')
      vals.push(patch.prompt.trim())
    }
    if (patch.schedule?.type === 'once' && r.schedule.type !== 'once') {
      throw new RoutineControlError('周期职责不能改成一次性：要停到某天请暂停并设置恢复时间；要单独提醒一次请另建一次性提醒')
    }
    if (patch.schedule) {
      sets.push('schedule = ?')
      vals.push(JSON.stringify(patch.schedule))
      const next = nextRunAt(patch.schedule, nowMs, this.tzOffsetMin)
      sets.push('next_run_at = ?')
      vals.push(Number.isFinite(next) ? next : nowMs)
      if (scheduleDisabled(patch.schedule)) {
        // 0 means “don't run”; an earlier agreed resume time no longer applies.
        sets.push('enabled = 0', 'disabled_reason = ?', 'resume_at = NULL')
        vals.push(FREQUENCY_DISABLED)
      }
    }
    if (!sets.length) return r
    return this.atomic(() => {
      this.db.prepare(`UPDATE routines SET ${sets.join(', ')}, config_version = config_version + 1 WHERE id = ?`).run(...vals, id)
      // 改调度：旧调度尚未开始的窗口随调度变更一起撤销，新窗口由新 next_run_at 产生；已开始的执行按过期取消，行本身保留。
      // 只改配置：pending 窗口保留身份、开始时记录新版本；只有已开始的执行才是过期的。
      if (patch.schedule) this.cancelOccurrences(id, nowMs, '职责调度已修改')
      else this.db.prepare("UPDATE routine_occurrences SET status = 'cancelled', finished_at = ?, error = '职责配置已修改' WHERE routine_id = ? AND status = 'running'").run(nowMs, id)
      this.db.prepare(`UPDATE routines SET disabled_reason = ? WHERE id = ? AND disabled_reason = ?
        AND NOT EXISTS (SELECT 1 FROM routine_occurrences WHERE routine_id = ? AND status = 'pending')`)
        .run('职责配置已修改，请重新启用', id, ONCE_PENDING, id)
      return this.get(id)
    })
  }

  /**
   * 盯群靠委托人的 user token 去读一个我根本不在的群。token 一死，这条就必须停——
   * 暂停该委托人的关注职责，保留读取游标；重新授权后再按当前权限续读。
   */
  suspendForExpiredAuth(runAs: string, nowMs = Date.now()): Routine[] {
    const rows = this.db
      .prepare(`SELECT * FROM routines WHERE kind = 'watch' AND (enabled = 1 OR disabled_reason = ?) AND status = 'active' AND run_as = ?`)
      .all(ONCE_PENDING, runAs) as Record<string, unknown>[]
    const out: Routine[] = []
    for (const r of rows) {
      this.db.prepare(`UPDATE routines SET enabled = 0, disabled_reason = ? WHERE id = ?`).run(AUTH_EXPIRED, Number(r.id))
      // 当前执行由 finishOccurrence 记为授权失败的 skipped；只撤销尚未开始的轮次。
      this.db.prepare("UPDATE routine_occurrences SET status = 'cancelled', finished_at = ?, error = ? WHERE routine_id = ? AND status = 'pending'").run(nowMs, AUTH_EXPIRED, Number(r.id))
      const got = this.get(Number(r.id))
      if (got) out.push(got)
    }
    return out
  }

  /** 重新授权之后把因为 token 过期停掉的盯群放回去。游标没动，接着读。 */
  resumeAfterAuth(runAs: string, nowMs = Date.now(), canResume: (routine: Routine) => boolean = () => true): Routine[] {
    const rows = this.db.prepare(`SELECT id FROM routines WHERE kind = 'watch' AND status = 'active' AND run_as = ? AND enabled = 0 AND disabled_reason = ?`).all(runAs, AUTH_EXPIRED) as { id: number }[]
    const out: Routine[] = []
    for (const { id } of rows) {
      const r = this.get(Number(id))
      if (!r || !canResume(r)) continue
      const next = nextRunAt(r.schedule, nowMs, this.tzOffsetMin)
      const changed = this.db.prepare(`UPDATE routines SET enabled = 1, disabled_reason = NULL, fail_count = 0, next_run_at = ?, config_version = config_version + 1
        WHERE id = ? AND kind = 'watch' AND status = 'active' AND run_as = ? AND enabled = 0 AND disabled_reason = ?`)
        .run(Number.isFinite(next) ? next : nowMs, id, runAs, AUTH_EXPIRED)
      if (!changed.changes) continue
      const got = this.get(Number(id))
      if (got) out.push(got)
    }
    return out
  }

  remove(id: number): boolean {
    return this.atomic(() => {
      this.cancelOccurrences(id, Date.now(), '职责已删除')
      return Number(this.db.prepare('DELETE FROM routines WHERE id = ?').run(id).changes) > 0
    })
  }

  /** 私聊里建的只能由创建者在私聊里改；群里建的只能在那个群里改（群会话对全群可见，不碰个人任务）。 */
  canManage(r: Routine, actor: { chatId: string; chatType: 'group' | 'p2p'; openId?: string }): boolean {
    if (r.chatType === 'p2p') return actor.chatType === 'p2p' && Boolean(actor.openId) && r.ownerOpenId === actor.openId
    return actor.chatType === 'group' && r.chatId === actor.chatId
  }
}

export interface SchedulerDeps {
  /** Host owns the whole tick, including occurrence bookkeeping after run returns. */
  runTick?: (tick: () => Promise<number>) => Promise<number>
  store: RoutineStore
  /** 执行一次；抛错算失败。可以带原因返回（{ status, reason }），原因记进 occurrence.error。 */
  run: (routine: Routine, occurrence: RoutineOccurrence) => Promise<RoutineRunResult>
  log: Logger
  intervalMs?: number
  now?: () => number
  /** 错过太久的到期任务（进程宕机期间）只补跑一次；超过这个时长就直接跳到下一次 */
  catchUpWindowMs?: number
  /** 这一轮该不该跑。用来接单实例锁：新旧进程重叠时，只有拿到锁的那个跑定时任务 */
  enabled?: () => boolean
  /** 连续失败被自动停用时调用一次（宿主私聊负责人 / 登记待处理）；调度器不自己发消息。 */
  onDisabled?: (routine: Routine, reason: string) => void
}

export class RoutineScheduler {
  private timer?: NodeJS.Timeout
  private ticking = false
  private stopped = false
  private recovered = false
  private readonly now: () => number

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  start(): void {
    if (this.timer) return
    const interval = this.deps.intervalMs ?? 60_000
    this.stopped = false
    const tick = () => void (this.deps.runTick ? this.deps.runTick(() => this.tick()) : this.tick()).catch((err) => this.deps.log.error('routine scheduler tick failed', { err }))
    this.timer = setInterval(tick, interval)
    this.timer.unref?.()
    tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 扫一遍到期任务；并发保护：上一轮没跑完就跳过。 */
  async tick(): Promise<number> {
    if (this.stopped || this.deps.enabled && !this.deps.enabled()) return 0
    if (this.ticking) return 0
    this.ticking = true
    let ran = 0
    try {
      const now = this.now()
      if (!this.recovered) {
        const interrupted = this.deps.store.recoverInterruptedOccurrences(now)
        this.recovered = true
        if (interrupted.length) this.deps.log.warn('routine occurrences interrupted; inspection required before enabling', { ids: interrupted.map((r) => r.id) })
      }
      const window = this.deps.catchUpWindowMs ?? 6 * 3600_000
      for (const r of this.deps.store.due(now)) {
        if (this.stopped || this.deps.enabled && !this.deps.enabled()) break
        const occurrence = this.deps.store.claimDueOccurrence(r.id, r.nextRunAt, now)
        if (!occurrence) continue
        if (now - r.nextRunAt > window) {
          this.deps.store.skipOccurrence(occurrence.id, now, '超过补跑窗口，未执行')
          this.deps.log.warn('routine skipped: overdue beyond catch-up window', { id: r.id, name: r.name, overdueMin: Math.round((now - r.nextRunAt) / 60_000) })
          continue
        }
        const current = this.deps.store.startOccurrence(occurrence.id, this.now())
        if (!current) continue
        ran += 1
        let status: RoutineRunStatus
        let error: string | undefined
        try {
          const outcome = routineRunOutcome(await this.deps.run(current, this.deps.store.getOccurrence(occurrence.id)!))
          status = outcome.status
          error = outcome.reason
        } catch (err) {
          status = 'failed'
          error = err instanceof Error ? err.message : String(err)
        }
        // Shutdown is not a failed execution. Leave the admitted occurrence for
        // the existing startup interruption/reconciliation path; never start the next one.
        if (this.stopped) break
        // 入账失败不能改写成执行失败后重试：保留 running，重启时按结果未知处理。
        const after = this.deps.store.finishOccurrence(occurrence.id, status, this.now(), error)
        if (this.deps.store.getOccurrence(occurrence.id)?.status === 'cancelled') this.deps.log.info('routine cancelled', { id: r.id, name: r.name })
        else if (status === 'failed') {
          this.deps.log.error('routine failed', { id: r.id, name: r.name, error, disabled: after ? !after.enabled : false })
          if (after && !after.enabled && current.enabled && after.disabledReason?.startsWith('连续失败')) {
            try { this.deps.onDisabled?.(after, after.disabledReason) } catch (err) { this.deps.log.warn('routine disable notice failed', { id: r.id, err }) }
          }
        }
        else this.deps.log.info('routine ran', { id: r.id, name: r.name, status, ...(error ? { reason: error } : {}) })
      }
    } catch (err) {
      // 数据库暂时不可写时保留未终态记录；下次拿到调度权后先标中断，不能一直静默堵住。
      this.recovered = false
      throw err
    } finally {
      this.ticking = false
    }
    return ran
  }
}

/** Capability scopes that only read. Anything else (writes, sends, proposals) is an outbound effect. */
function readOnlyScope(scope: string): boolean {
  return scope.endsWith(':read') || scope === 'chats:list' || scope === 'chat:read-others'
}

function toOccurrence(r: Record<string, unknown>): RoutineOccurrence {
  const scheduledAt = Number(r.scheduled_at)
  return {
    id: Number(r.id),
    routineId: Number(r.routine_id),
    scheduledAt,
    windowKey: r.window_key == null ? occurrenceWindowKey(scheduledAt) : String(r.window_key),
    configVersion: Number(r.config_version),
    windowDuplicateOf: r.window_duplicate_of == null ? null : Number(r.window_duplicate_of),
    status: r.status as RoutineOccurrenceStatus,
    createdAt: Number(r.created_at),
    startedAt: r.started_at == null ? null : Number(r.started_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    error: (r.error as string | null) ?? null,
  }
}

function toStatus(v: unknown): RoutineStatus {
  return v === 'proposed' || v === 'ignored' || v === 'expired' ? v : 'active'
}

function toRoutine(r: Record<string, unknown>): Routine {
  let schedule: ScheduleSpec
  try {
    schedule = JSON.parse(String(r.schedule)) as ScheduleSpec
  } catch {
    schedule = { type: 'interval', everyMinutes: 24 * 60 }
  }
  let watch: string[] = []
  try {
    const parsed = JSON.parse(String(r.watch_chat_ids ?? '[]')) as unknown
    if (Array.isArray(parsed)) watch = parsed.map(String)
  } catch {
    /* ignore */
  }
  return {
    id: Number(r.id),
    kind: r.kind === 'watch' ? 'watch' : r.kind === 'followup' ? 'followup' : 'schedule',
    ownerOpenId: (r.owner_open_id as string | null) ?? null,
    runAs: (r.run_as as string | null) ?? null,
    status: toStatus(r.status),
    source: r.source === 'model' ? 'model' : 'user',
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: r.decided_at === null || r.decided_at === undefined ? null : Number(r.decided_at),
    cardMessageId: (r.card_message_id as string | null) ?? null,
    spaceId: (r.space_id as string | null) ?? null,
    chatId: String(r.chat_id),
    chatType: r.chat_type === 'p2p' ? 'p2p' : 'group',
    name: String(r.name),
    prompt: String(r.prompt),
    schedule,
    watchChatIds: watch,
    deliverTo: r.deliver_to === 'dm' ? 'dm' : 'chat',
    deliveryPolicy: r.delivery_policy === 'every_run' ? 'every_run' : 'when_nonempty',
    sessionKey: (r.session_key as string | null) ?? null,
    originTaskId: r.origin_task_id == null ? null : Number(r.origin_task_id),
    feedbackId: r.feedback_id == null ? null : Number(r.feedback_id),
    enabled: Number(r.enabled) === 1,
    disabledReason: (r.disabled_reason as string | null) ?? null,
    nextRunAt: Number(r.next_run_at),
    lastRunAt: r.last_run_at === null || r.last_run_at === undefined ? null : Number(r.last_run_at),
    lastSuccessAt: r.last_success_at === null || r.last_success_at === undefined ? null : Number(r.last_success_at),
    resumeAt: r.resume_at === null || r.resume_at === undefined ? null : Number(r.resume_at),
    messageCursorSec: r.message_cursor_sec === null || r.message_cursor_sec === undefined ? null : Number(r.message_cursor_sec),
    minNewMessages: r.min_new_messages === null || r.min_new_messages === undefined ? 0 : Number(r.min_new_messages),
    alwaysOnMention: r.always_on_mention === null || r.always_on_mention === undefined ? true : Number(r.always_on_mention) === 1,
    lastStatus: (r.last_status as RoutineRunStatus | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    failCount: Number(r.fail_count ?? 0),
    runs: Number(r.runs ?? 0),
    createdAt: Number(r.created_at),
  }
}
