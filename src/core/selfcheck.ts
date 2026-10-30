/**
 * 自检：拿 Friday 自己的执行记录回看一段时间"干得怎么样"，把教训存成记忆。
 *
 * 数据来自网关 tasks 表，其中包含请求正文和错误，必须按调用者的会话范围读取。
 * 不读取 dsh 的内部日志。
 *
 * 之所以值得做：失败和被中止是最诚实的反馈。一条任务失败了、或者人在 90 秒内又问了一遍，
 * 多半说明上一条答得不好。把这些挑出来让模型自己总结成 lesson，比任何自评都准。
 */
import type { DatabaseSync } from 'node:sqlite'
import { fmtDate } from './memory.js'

export interface TaskOutcome {
  id: number
  sessionKey: string
  prompt: string
  status: string
  stopReason: string | null
  error: string | null
  elapsedMs: number | null
  createdAt: number
  /** 同一会话里紧接着又来了一条（人没满意，追着问） */
  reaskedWithinMs?: number
}

export interface SelfCheckFacts {
  fromMs: number
  toMs: number
  total: number
  done: number
  failed: number
  cancelled: number
  /** 跑得最久的几条 */
  slowest: TaskOutcome[]
  /** 失败和被中止的 */
  bad: TaskOutcome[]
  /** 答完很快又被追问的（大概率没答好） */
  reasked: TaskOutcome[]
  p50Ms: number
  p90Ms: number
}

const REASK_WINDOW_MS = 90_000

export interface SelfCheckScope {
  chatId: string
  chatType: 'group' | 'p2p'
  requesterOpenId?: string
  /** 可进一步限制到本话题；省略时只读当前群或本人的当前私聊。 */
  sessionKey?: string
}

export function collectSelfCheck(db: DatabaseSync, fromMs: number, toMs: number, scope?: SelfCheckScope, limit = 400): SelfCheckFacts {
  let rows: Record<string, unknown>[] = []
  // 缺少范围不能退化为全库查询；私聊即使 chat_id 相同也必须匹配本人。
  if (scope?.chatId && (scope.chatType === 'group' || (scope.chatType === 'p2p' && scope.requesterOpenId))) {
    const where = ['t.created_at >= ?', 't.created_at <= ?', 's.chat_id = ?', 's.chat_type = ?']
    const args: (string | number)[] = [fromMs, toMs, scope.chatId, scope.chatType]
    if (scope.chatType === 'p2p') {
      where.push('s.requester_open_id = ?', 't.requester_open_id = ?')
      args.push(scope.requesterOpenId!, scope.requesterOpenId!)
    }
    if (scope.sessionKey) {
      where.push('t.session_key = ?')
      args.push(scope.sessionKey)
    }
    args.push(Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 400) : 400)
    rows = db.prepare(`SELECT t.* FROM tasks t JOIN sessions s ON s.session_key = t.session_key WHERE ${where.join(' AND ')} ORDER BY t.created_at LIMIT ?`).all(...args) as Record<string, unknown>[]
  }
  const tasks: TaskOutcome[] = rows.map((r) => ({
    id: Number(r.id),
    sessionKey: String(r.session_key),
    prompt: String(r.prompt ?? '').replace(/\s+/g, ' ').slice(0, 200),
    status: String(r.status),
    stopReason: (r.stop_reason as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    elapsedMs: r.started_at && r.finished_at ? Number(r.finished_at) - Number(r.started_at) : null,
    createdAt: Number(r.created_at),
  }))
  // 追问：同一会话里，上一条答完 90 秒内又来一条
  const bySession = new Map<string, TaskOutcome[]>()
  for (const t of tasks) bySession.set(t.sessionKey, [...(bySession.get(t.sessionKey) ?? []), t])
  const reasked: TaskOutcome[] = []
  for (const list of bySession.values()) {
    for (let i = 0; i < list.length - 1; i += 1) {
      const cur = list[i] as TaskOutcome
      const next = list[i + 1] as TaskOutcome
      const gap = next.createdAt - cur.createdAt
      if (cur.status === 'done' && gap > 0 && gap <= REASK_WINDOW_MS) reasked.push({ ...cur, reaskedWithinMs: gap })
    }
  }
  const timed = tasks.map((t) => t.elapsedMs).filter((n): n is number => typeof n === 'number' && n > 0).sort((a, b) => a - b)
  const pct = (p: number): number => (timed.length ? (timed[Math.min(timed.length - 1, Math.floor(timed.length * p))] as number) : 0)
  return {
    fromMs,
    toMs,
    total: tasks.length,
    done: tasks.filter((t) => t.status === 'done').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
    cancelled: tasks.filter((t) => t.status === 'cancelled').length,
    slowest: [...tasks].filter((t) => t.elapsedMs).sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0)).slice(0, 5),
    bad: tasks.filter((t) => t.status === 'failed' || t.status === 'cancelled').slice(-12),
    reasked: reasked.slice(-10),
    p50Ms: pct(0.5),
    p90Ms: pct(0.9),
  }
}

function line(t: TaskOutcome): string {
  const took = t.elapsedMs ? `${Math.round(t.elapsedMs / 1000)}s` : '—'
  const why = t.error ? `：${t.error.replace(/\s+/g, ' ').slice(0, 120)}` : t.stopReason ? `（${t.stopReason}）` : ''
  const reask = t.reaskedWithinMs ? `，${Math.round(t.reaskedWithinMs / 1000)}s 后又被追问` : ''
  return `#${t.id} [${t.status}${why}] ${took}${reask} — ${t.prompt}`
}

/** 聊天里看的自检摘要（不调模型，纯统计）。 */
export function renderSelfCheck(f: SelfCheckFacts, botName: string): string {
  if (!f.total) return `${fmtDate(f.fromMs)} 以来我没跑过任务，没什么可自检的。`
  const parts = [
    `**${botName} 自检**（${fmtDate(f.fromMs)} 起，共 ${f.total} 条）`,
    `完成 ${f.done} · 失败 ${f.failed} · 被中止 ${f.cancelled}｜耗时中位数 ${Math.round(f.p50Ms / 1000)}s，P90 ${Math.round(f.p90Ms / 1000)}s`,
  ]
  if (f.bad.length) parts.push(`**没跑成的（${f.bad.length}）**\n${f.bad.map((t) => `- ${line(t)}`).join('\n')}`)
  if (f.reasked.length) parts.push(`**答完很快又被追问的（${f.reasked.length}）**——多半是上一条没答到点上\n${f.reasked.map((t) => `- ${line(t)}`).join('\n')}`)
  if (f.slowest.length) parts.push(`**跑得最久的**\n${f.slowest.map((t) => `- ${line(t)}`).join('\n')}`)
  if (!f.bad.length && !f.reasked.length) parts.push('没有失败、没有被中止、没有紧跟着的追问——这段时间没什么要改的。')
  return parts.join('\n\n')
}

/** 让模型从这些记录里总结教训（存成 lesson），不总结就回 NOTHING。 */
export function buildSelfCheckPrompt(f: SelfCheckFacts, botName: string): string {
  return [
    `[自检｜网关自动发起，不是人在说话]`,
    `你是 ${botName}。下面是你自己在 ${fmtDate(f.fromMs)} — ${fmtDate(f.toMs)} 跑过的任务记录（共 ${f.total} 条：完成 ${f.done}、失败 ${f.failed}、被中止 ${f.cancelled}）。`,
    `[没跑成的]\n${f.bad.length ? f.bad.map((t) => line(t)).join('\n') : '（没有）'}`,
    `[答完很快又被追问的]\n${f.reasked.length ? f.reasked.map((t) => line(t)).join('\n') : '（没有）'}`,
    `[跑得最久的]\n${f.slowest.map((t) => line(t)).join('\n') || '（没有）'}`,
    `从这些记录里找**可复用的教训**，用 friday_memory_save 存成 kind=lesson、certainty=candidate（等人确认）。

什么算教训：同一类请求反复失败、某种问法我总是理解偏、某类任务每次都超时、某个工具我用错了顺序。
什么不算：单次的网络抖动、人自己中途改主意、一次性的偶发错误——这些别记。

硬规则：**只能依据上面列出的记录**，不要凭印象编；一条教训要能说清"下次遇到什么情况该怎么做"，说不清就别写。
最多 3 条。没有值得记的就整个回复只写 NOTHING。不要跑命令、不要读文件、不要发消息。`,
  ].join('\n\n')
}

/**
 * 职责之间有没有在打架：同一个群里两条常驻职责，时间挨得很近、产出的东西又像，
 * 多半是同一批素材写两遍、发两张卡。自己发现、自己提，别等人被烦到才说。
 */
export interface ResponsibilityConflict {
  a: { id: number; name: string }
  b: { id: number; name: string }
  chatId: string
  /** 两次触发差多少分钟 */
  apartMin: number
  /** 重合的关键词 */
  shared: string[]
}

/** 近到这个程度才算"几乎同时跑" */
export const CONFLICT_WINDOW_MS = 45 * 60_000

/** 名字和提示词里的实词。中文按 2 字切片，英文按单词。 */
function keywords(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []) out.add(w)
  const han = text.replace(/[^一-龥]+/g, '')
  for (let i = 0; i + 2 <= han.length; i += 1) out.add(han.slice(i, i + 2))
  return out
}

export function findResponsibilityConflicts(
  routines: { id: number; name: string; prompt: string; chatId: string; nextRunAt: number; enabled: boolean; status: string }[],
): ResponsibilityConflict[] {
  const active = routines.filter((r) => r.enabled && r.status === 'active')
  const out: ResponsibilityConflict[] = []
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i]!
      const b = active[j]!
      if (a.chatId !== b.chatId) continue
      const apart = Math.abs(a.nextRunAt - b.nextRunAt)
      if (apart > CONFLICT_WINDOW_MS) continue
      const ka = keywords(`${a.name} ${a.prompt}`)
      const shared = [...keywords(`${b.name} ${b.prompt}`)].filter((w) => ka.has(w))
      // 两个实词以上重合才算像；一个词太容易误报
      if (shared.length < 2) continue
      out.push({ a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name }, chatId: a.chatId, apartMin: Math.round(apart / 60_000), shared: shared.slice(0, 6) })
    }
  }
  return out
}

export function renderConflicts(list: ResponsibilityConflict[]): string {
  if (!list.length) return ''
  return [
    '**待你决定：有职责在重复干活**',
    ...list.map(
      (c) =>
        `- 「${c.a.name}」和「${c.b.name}」相差 ${c.apartMin} 分钟先后跑，讲的还是同一批东西（${c.shared.slice(0, 3).join('、')}）——大概率同素材、同写表、同发卡片。回我「停掉 #${c.b.id}」或者「保留」都行。`,
    ),
  ].join('\n')
}
