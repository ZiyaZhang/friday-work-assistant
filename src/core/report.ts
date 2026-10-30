/**
 * 工作状态投影：`!status`（聊天里一眼看完）和周报文档（沉淀给人和 PMO 看）。
 *
 * 只有一条硬规则：**这里只读调用方传进来的作用域**。
 * 作用域是编排器按读者身份算出来的（本空间 → 联盟 → 企业），所以一份报告天然只包含读者本来就能看到的东西，
 * 不存在"周报把别的群的事漏出去"。报告末尾把口径写清楚（取了哪几层、窗口多长），
 * 让人一眼知道这份东西的边界——这也是 ContextReceipt 的思路。
 */
import { ChannelMemory, fmtDate, type MemoryNote, type ScopeSpec } from './memory.js'
import { KIND_LABEL, STATUS_LABEL, type Todo, type Todos } from './todos.js'
import { describeSchedule, type Routine, type RoutineStore } from './routines.js'

export interface StatusFacts {
  /** 统计窗口 */
  fromMs: number
  toMs: number
  /** 已完成 */
  done: Todo[]
  /** 逾期未完成 */
  overdue: Todo[]
  /** 未来 7 天到期的里程碑与待办 */
  upcoming: Todo[]
  /** 没有截止日、还开着的 */
  open: Todo[]
  /** 窗口内新确认的决定 / 事实 / 经验 */
  decisions: MemoryNote[]
  /** 还没人确认的自动记录 */
  candidates: number
  /** 生效中的职责 */
  responsibilities: Routine[]
  /** 等人处理的职责提案 */
  proposals: Routine[]
  /** 取数的层 */
  scopes: ScopeSpec[]
}

export interface FactsDeps {
  todos: Todos
  memory: ChannelMemory
  routines?: RoutineStore
}

const WEEK_MS = 7 * 86_400_000

/** 本周（周一 00:00 起，东八区）的起点。 */
export function weekStart(nowMs: number, tzOffsetMin = 480): number {
  const offset = tzOffsetMin * 60_000
  const local = new Date(nowMs + offset)
  const dow = (local.getUTCDay() + 6) % 7 // 周一 = 0
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  return dayStart - dow * 86_400_000 - offset
}

/** 把读者可见范围内的工作状态取出来。窗口默认本周。 */
export function collectStatus(deps: FactsDeps, scopes: ScopeSpec[], nowMs: number, window?: { fromMs: number; toMs: number }): StatusFacts {
  const list = scopes.map((s) => s.scope)
  const fromMs = window?.fromMs ?? weekStart(nowMs)
  const toMs = window?.toMs ?? nowMs
  const open = deps.todos.list(list, { status: 'active', limit: 200 })
  const soon = nowMs + WEEK_MS
  return {
    fromMs,
    toMs,
    done: deps.todos.completedBetween(list, fromMs, toMs),
    overdue: open.filter((t) => t.dueMs !== null && t.dueMs < nowMs),
    upcoming: open.filter((t) => t.dueMs !== null && t.dueMs >= nowMs && t.dueMs <= soon),
    open: open.filter((t) => t.dueMs === null || t.dueMs > soon),
    decisions: deps.memory.confirmedBetween(list, fromMs, toMs, ['decision', 'fact', 'lesson']),
    candidates: list.reduce((n, s) => n + deps.memory.candidates(s, 100).length, 0),
    responsibilities: [],
    proposals: [],
    scopes,
  }
}

/** 职责部分要按空间取（职责挂在空间上，不走记忆作用域）。 */
export function withResponsibilities(facts: StatusFacts, routines: RoutineStore | undefined, opts: { chatId: string; chatType: 'group' | 'p2p'; openId?: string; spaceId?: string }): StatusFacts {
  if (!routines) return facts
  const mine = routines.listFor({ chatId: opts.chatId, chatType: opts.chatType, ownerOpenId: opts.openId })
  return {
    ...facts,
    responsibilities: mine.filter((r) => r.status === 'active' && r.enabled && r.kind !== 'followup'),
    proposals: opts.spaceId ? routines.proposals(opts.spaceId) : mine.filter((r) => r.status === 'proposed'),
  }
}

function todoLine(t: Todo, opts: { showDue?: boolean } = {}): string {
  const label = t.kind === 'todo' ? '' : `[${KIND_LABEL[t.kind]}] `
  const due = opts.showDue !== false && t.dueMs ? `（${fmtDate(t.dueMs)}）` : ''
  const owner = t.owner ? ` · ${t.owner}` : ''
  const pending = t.confirmed ? '' : ' · 待确认'
  // 进行中是默认状态，不用写出来；阻塞 / 待验收 要显眼，带上原因
  const state = t.status === 'open' || t.status === 'done' ? '' : ` · **${STATUS_LABEL[t.status]}**${t.statusNote ? `（${t.statusNote}）` : ''}`
  // 出处：让人一眼看出"这条不是我写的，是它从消息里提的"
  const from = t.source ? ` · 来自${t.source}` : ''
  return `#${t.id} ${label}${t.title}${due}${owner}${state}${pending}${from}`
}

/** `!status`：聊天里一眼看完，不建文档。 */
export function renderStatusText(facts: StatusFacts, where: string): string {
  const parts: string[] = [`**${where} · 工作状态**（${fmtDate(facts.fromMs)} 起）`]
  const section = (title: string, items: string[], empty?: string): void => {
    if (items.length) parts.push(`**${title}（${items.length}）**\n${items.map((x) => `- ${x}`).join('\n')}`)
    else if (empty) parts.push(`**${title}**：${empty}`)
  }
  section('逾期', facts.overdue.map((t) => todoLine(t)))
  section('7 天内到期', facts.upcoming.map((t) => todoLine(t)))
  section('阻塞 / 待验收', facts.open.concat(facts.upcoming, facts.overdue).filter((t) => t.status !== 'open').map((t) => todoLine(t)))
  section('进行中', facts.open.filter((t) => t.status === 'open').slice(0, 10).map((t) => todoLine(t)), '没有在跟的事项')
  section('本周完成', facts.done.map((t) => todoLine(t, { showDue: false })))
  section('本周的决定与结论', facts.decisions.slice(0, 8).map((n) => `${n.title}（${ChannelMemory.describeScope(n.scope)}）`))
  section('常驻职责', facts.responsibilities.map((r) => `${r.name} · ${describeSchedule(r.schedule)}${r.runAs ? '' : '（无主：只读运行）'}`))
  if (facts.proposals.length) parts.push(`**等你处理的职责提案（${facts.proposals.length}）**\n${facts.proposals.map((r) => `- #${r.id}「${r.name}」`).join('\n')}\n在提案卡片上点「接受」或「忽略」。`)
  if (facts.candidates) parts.push(`另有 ${facts.candidates} 条我自己记下、还没人确认的（问我一句就能看）。`)
  parts.push(`口径：${describeScopes(facts.scopes)}。跟我说一声就能把这些整理成一篇飞书文档。`)
  return parts.join('\n\n')
}

/** 周报文档（markdown，交给 docx 建文档）。 */
export function renderWeeklyReport(facts: StatusFacts, input: { where: string; botName: string; nowMs: number }): { title: string; markdown: string; empty: boolean } {
  const title = `${input.where} 周报 ${fmtDate(facts.fromMs).slice(0, 10)} – ${fmtDate(facts.toMs).slice(0, 10)}`
  const empty = !facts.done.length && !facts.overdue.length && !facts.upcoming.length && !facts.open.length && !facts.decisions.length
  const lines: string[] = [`# ${title}`, '', `统计窗口：${fmtDate(facts.fromMs)} — ${fmtDate(facts.toMs)}（Asia/Shanghai）。由 ${input.botName} 自动汇总。`, '']

  const block = (heading: string, items: string[], empty: string): void => {
    lines.push(`## ${heading}`, '')
    if (items.length) lines.push(...items.map((x) => `- ${x}`))
    else lines.push(empty)
    lines.push('')
  }

  block('本周完成', facts.done.map((t) => todoLine(t, { showDue: false })), '本周没有标记完成的事项。')
  block('逾期未完成', facts.overdue.map((t) => todoLine(t)), '没有逾期事项。')
  block('未来 7 天的节点', facts.upcoming.map((t) => todoLine(t)), '未来 7 天没有已登记的截止 / 封版 / 上线 / 会议。')
  block('进行中', facts.open.map((t) => todoLine(t)), '没有其他在跟的事项。')
  block(
    '本周的决定与结论',
    facts.decisions.map((n) => `**${n.title}** — ${n.body.replace(/\n+/g, ' ').slice(0, 200)}（${ChannelMemory.describeScope(n.scope)} · ${fmtDate(n.createdAt)}）`),
    '本周没有新确认的决定。',
  )
  if (facts.responsibilities.length) {
    block('常驻职责', facts.responsibilities.map((r) => `${r.name} · ${describeSchedule(r.schedule)} · ${r.runAs ? '有主' : '无主（只读运行）'}`), '')
  }

  lines.push('## 口径与边界', '')
  lines.push(`- 数据来源：${describeScopes(facts.scopes)}。**这份报告只包含这些层里的内容**，其他空间的事不会出现在这里。`)
  if (facts.candidates) lines.push(`- 另有 ${facts.candidates} 条 ${input.botName} 从对话里推断、**还没人确认**的记录，没有计入正文；问我一句就能查看确认。`)
  lines.push(`- 事项状态以有人明确说过"完成 / 改期"为准；标了"待确认"的是 ${input.botName} 推断的，负责人确认后才算数。`)
  return { title, markdown: lines.join('\n'), empty }
}

function describeScopes(scopes: ScopeSpec[]): string {
  return scopes.map((s) => s.label).join(' + ')
}
