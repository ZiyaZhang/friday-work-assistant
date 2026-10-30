/**
 * 群内点赞（kudos）：主动巡检时，模型可以提名本轮消息里明确有用的人类消息，宿主核对后贴一个表情。
 *
 * 模型只提名（`@@like <message_id> <一句理由>`），是否贴由宿主决定：
 * - 只认本轮巡检消息集合里的人类 text/post 消息，不赞 Friday 自己和其他机器人；
 * - 不赞提问、求助和没解决的报错，不赞已经有 Friday 表情的消息（任务回执或已点过赞）；
 * - 同一条消息只赞一次；每群每个自然日（默认 Asia/Shanghai）最多 maxPerDay 个；
 * - 理由只进日志和账本，不发到群里。
 *
 * 账本先占位再贴表情：贴的过程中进程退出，重启后也不会对同一条消息再贴一次。
 */
import type { DatabaseSync } from 'node:sqlite'

/** message_kudos 账本。迁移时由 schema-only 适配器调用 ensureKudosSchema 建空表。 */
export const KUDOS_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_kudos (
  message_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  sender_open_id TEXT NOT NULL,
  emoji_type TEXT NOT NULL,
  reaction_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_message_kudos_chat_created ON message_kudos(chat_id, created_at);
`

export function ensureKudosSchema(db: DatabaseSync): void {
  db.exec(KUDOS_SCHEMA)
}

/** 一轮输出里最多认几条 @@like。 */
export const KUDOS_MAX_LINES = 2
export const KUDOS_DEFAULT_MAX_PER_DAY = 3
export const KUDOS_DEFAULT_EMOJI = 'THUMBSUP'
const REASON_MAX_CHARS = 200

export interface KudosNomination {
  messageId: string
  reason: string
}

export interface KudosExtraction {
  nominations: KudosNomination[]
  /** 去掉所有 @@like 行之后的正文，交给原来的 NOTHING / @@reply 逻辑 */
  rest: string
  /** 丢弃的 @@like 行数：格式不对、重复、超过条数 */
  dropped: number
}

/** 以 @@like 开头的行都是协议行，不管合不合法都不能留在要发到群里的正文里。 */
const LIKE_LINE = /^\s*(?:[-*]\s*)?@@like(?![\w-])(.*)$/
const LIKE_ARGS = /^\s+(om_[\w-]+)\s+(\S.*?)\s*$/

export function extractKudos(body: string, max = KUDOS_MAX_LINES): KudosExtraction {
  const nominations: KudosNomination[] = []
  const kept: string[] = []
  let dropped = 0
  for (const line of body.split('\n')) {
    const like = LIKE_LINE.exec(line.replace(/\r$/, ''))
    if (!like) {
      kept.push(line)
      continue
    }
    const args = LIKE_ARGS.exec(like[1] ?? '')
    const messageId = args?.[1]
    const reason = args?.[2]
    if (!messageId || !reason || nominations.length >= max || nominations.some((n) => n.messageId === messageId)) {
      dropped += 1
      continue
    }
    nominations.push({ messageId, reason: reason.slice(0, REASON_MAX_CHARS) })
  }
  return { nominations, rest: kept.join('\n'), dropped }
}

/** 巡检消息集合里的一条（消息缓存行的这几个字段）。 */
export interface KudosCandidate {
  messageId: string
  msgType: string
  senderType: string
  senderOpenId?: string
  text: string
}

export type KudosRejection = 'not_in_round' | 'not_text' | 'not_human' | 'self' | 'question' | 'trouble' | 'already_reacted'

const TROUBLE_ZH = /(报错|出错|错误|异常|失败|挂了|崩了|不行|不好使|跑不起来|起不来|卡住|卡死|超时|求助|救命)/
const TROUBLE_EN = /\b(help|error|errors|exception|traceback|failed|failure|fails|panic|fatal|timeout|timed out)\b/i
const RESOLVED = /(修好|修复|已修|解决了|已解决|搞定|恢复了|恢复正常|好使了|跑通|已合并|已上线|已发布|\bfixed\b|\bresolved\b|\bmerged\b)/i

/**
 * 像报错、求助或抱怨，而且没说已经解决。
 * 修好了的公告常常提到之前的报错，所以带"修好""已解决"这类词的不算。
 */
export function looksLikeTrouble(text: string): boolean {
  return (TROUBLE_ZH.test(text) || TROUBLE_EN.test(text)) && !RESOLVED.test(text)
}

/** 这条提名为什么不能赞；undefined = 可以。 */
export function kudosRejection(
  candidate: KudosCandidate | undefined,
  ctx: { botOpenId: string; isQuestion: (text: string) => boolean; hasFridayReaction: (messageId: string) => boolean },
): KudosRejection | undefined {
  if (!candidate) return 'not_in_round'
  if (candidate.msgType !== 'text' && candidate.msgType !== 'post') return 'not_text'
  if (candidate.senderType !== 'user' || !candidate.senderOpenId) return 'not_human'
  if (candidate.senderOpenId === ctx.botOpenId) return 'self'
  if (ctx.isQuestion(candidate.text)) return 'question'
  if (looksLikeTrouble(candidate.text)) return 'trouble'
  if (ctx.hasFridayReaction(candidate.messageId)) return 'already_reacted'
  return undefined
}

export interface KudosRow {
  messageId: string
  chatId: string
  spaceId: string
  senderOpenId: string
  emojiType: string
  reactionId: string | null
  reason: string
  createdAt: number
  removedAt: number | null
}

export interface KudosOptions {
  /** 每群每个自然日最多赞几条；0 = 不点赞 */
  maxPerDay?: number
  now?: () => number
  /** 自然日按哪个时区划分（分钟），默认 +08:00 */
  tzOffsetMin?: number
}

export type KudosClaim = 'claimed' | 'duplicate' | 'daily_limit' | 'disabled'

export class Kudos {
  readonly maxPerDay: number
  private readonly now: () => number
  private readonly tzOffsetMin: number

  constructor(private readonly db: DatabaseSync, opts: KudosOptions = {}) {
    ensureKudosSchema(db)
    const max = opts.maxPerDay ?? KUDOS_DEFAULT_MAX_PER_DAY
    this.maxPerDay = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : KUDOS_DEFAULT_MAX_PER_DAY
    this.now = opts.now ?? (() => Date.now())
    this.tzOffsetMin = opts.tzOffsetMin ?? 8 * 60
  }

  /** nowMs 所在自然日的起点（毫秒时间戳）。 */
  dayStart(nowMs = this.now()): number {
    const offset = this.tzOffsetMin * 60_000
    return Math.floor((nowMs + offset) / 86_400_000) * 86_400_000 - offset
  }

  has(messageId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM message_kudos WHERE message_id = ?').get(messageId))
  }

  get(messageId: string): KudosRow | undefined {
    const r = this.db.prepare('SELECT * FROM message_kudos WHERE message_id = ?').get(messageId) as Record<string, unknown> | undefined
    if (!r) return undefined
    return {
      messageId: String(r.message_id),
      chatId: String(r.chat_id),
      spaceId: String(r.space_id),
      senderOpenId: String(r.sender_open_id),
      emojiType: String(r.emoji_type),
      reactionId: r.reaction_id === null || r.reaction_id === undefined ? null : String(r.reaction_id),
      reason: String(r.reason ?? ''),
      createdAt: Number(r.created_at),
      removedAt: r.removed_at === null || r.removed_at === undefined ? null : Number(r.removed_at),
    }
  }

  /** 这个群今天已经用掉的名额：贴失败的、后来撤掉的都算。 */
  countToday(chatId: string, nowMs = this.now()): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM message_kudos WHERE chat_id = ? AND created_at >= ?').get(chatId, this.dayStart(nowMs)) as { n: number }
    return Number(r.n)
  }

  remainingToday(chatId: string, nowMs = this.now()): number {
    return Math.max(0, this.maxPerDay - this.countToday(chatId, nowMs))
  }

  /**
   * 占一个名额，成功后才去贴表情。同一条消息只占一次；这个群今天满了就不占。
   * node:sqlite 是同步调用，查和写之间不会插进别的 JS。
   */
  claim(input: { messageId: string; chatId: string; spaceId: string; senderOpenId: string; emojiType: string; reason: string }): KudosClaim {
    if (this.maxPerDay <= 0) return 'disabled'
    if (this.has(input.messageId)) return 'duplicate'
    const now = this.now()
    if (this.countToday(input.chatId, now) >= this.maxPerDay) return 'daily_limit'
    this.db
      .prepare(`INSERT INTO message_kudos (message_id, chat_id, space_id, sender_open_id, emoji_type, reason, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(input.messageId, input.chatId, input.spaceId, input.senderOpenId, input.emojiType, input.reason.slice(0, REASON_MAX_CHARS), now)
    return 'claimed'
  }

  /** 表情贴上了：记下 reaction_id，撤销时要用。 */
  settle(messageId: string, reactionId: string): void {
    this.db.prepare('UPDATE message_kudos SET reaction_id = ? WHERE message_id = ? AND reaction_id IS NULL').run(reactionId, messageId)
  }

  /** 表情撤掉之后记一笔。行保留：同一条消息以后也不再赞。 */
  markRemoved(messageId: string): boolean {
    return Number(this.db.prepare('UPDATE message_kudos SET removed_at = ? WHERE message_id = ? AND removed_at IS NULL').run(this.now(), messageId).changes) > 0
  }
}
