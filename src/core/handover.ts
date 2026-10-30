/**
 * 交接包：换人接手这个空间时，一篇文档把"现在是什么状态、接手要做什么"讲清楚。
 * 结构：README（是什么 / 不是什么 / 边界）→ 当前状态快照 → 接手清单 → 职责定义原文 → 状态游标。
 *
 * 两条硬规则：
 * 1. **不含任何密钥**。凭证在网关里，交接的是状态和职责，不是身份。
 * 2. **身份不转移**：职责的 `run_as` 是绑在具体的人身上的，接手人必须自己接一遍
 *    （否则就成了"拿着前任的身份在跑"）。清单里把这件事写在第一条。
 */
import { fmtDate } from './memory.js'
import { describeSchedule, type Routine } from './routines.js'
import { KIND_LABEL, STATUS_LABEL, type Todo } from './todos.js'
import type { StatusFacts } from './report.js'
import type { Space, SpaceMemberRow } from './space.js'

export interface HandoverInput {
  botName: string
  where: string
  nowMs: number
  space: Space
  members: { row: SpaceMemberRow; name: string }[]
  facts: StatusFacts
  /** 生效中的职责（含 run_as 是谁） */
  responsibilities: { routine: Routine; runAsName?: string }[]
  memoryCounts: { label: string; total: number; rules: number; candidates: number }[]
  circle?: string
  wikiUrl?: string
  pmoUrl?: string
}

export function renderHandover(input: HandoverInput): { title: string; markdown: string } {
  const title = `${input.where} · Friday 交接包 ${fmtDate(input.nowMs).slice(0, 10)}`
  const L: string[] = [`# ${title}`, '']

  L.push('## 这是什么', '')
  L.push(`${input.botName} 在${input.where}攒下来的**工作状态**：记忆、在跟的事项、常驻职责、空间配置。接手的人读完这一篇就能接着干。`)
  L.push('')
  L.push('**这不是什么**：')
  L.push('- 不含任何密钥、token、个人授权——凭证只在网关里，任何交接文档都不该有它们。')
  L.push(`- 不含身份。职责是"以某个人的身份运行"的，**换人就必须重新接一遍**（见下面的接手清单第 1 条）。`)
  L.push(`- 不含别的空间的内容。这份包只有${input.where}这一层（${input.facts.scopes.map((s) => s.label).join(' + ')}）看得到的东西。`)
  L.push('')
  L.push('**先读这几段**：当前状态快照 → 接手清单 → 常驻职责定义。其余是明细。')
  L.push('')

  L.push('## 当前状态快照', '')
  L.push(`- 空间：\`${input.space.id}\`（${input.space.kind === 'p2p' ? '私聊' : '群'}${input.circle ? `，联盟「${input.circle}」` : ''}）`)
  L.push(`- 负责人：${input.members.filter((m) => m.row.role === 'owner').map((m) => m.name).join('、') || '（没有）'}；成员 ${input.members.length} 人`)
  for (const m of input.memoryCounts) L.push(`- 记忆（${m.label}）：${m.total} 条，其中常驻要求 ${m.rules} 条、待确认 ${m.candidates} 条`)
  L.push(`- 事项：逾期 ${input.facts.overdue.length}、7 天内到期 ${input.facts.upcoming.length}、在跟 ${input.facts.open.length}、本周完成 ${input.facts.done.length}`)
  L.push(`- 常驻职责：${input.responsibilities.length} 条${input.facts.proposals.length ? `，另有 ${input.facts.proposals.length} 条提案没人处理` : ''}`)
  if (input.wikiUrl) L.push(`- Wiki：${input.wikiUrl}`)
  if (input.pmoUrl) L.push(`- PMO 看板：${input.pmoUrl}`)
  L.push('')

  L.push('## 接手清单', '')
  L.push('按顺序做，每条做完打个勾：')
  L.push('')
  L.push(`1. **接过身份**：每条常驻职责下面都写了它现在"以谁的身份运行"。在群里问一句"你都在替我盯什么"看一遍，需要换人的先让它停掉那一条，再让接手人自己说一次同样的要求重建——**不要沿用前任的身份**。`)
  L.push(`2. **成为负责人**：让现任负责人或管理员跟它说"@接手人 当负责人"。负责人才能改空间配置、换绑、把记忆晋升到联盟层。`)
  L.push(`3. **个人授权**（如果要盯群 / 读日程）：接手人私聊 ${input.botName} 说一声"我要连一下账号"，它会把授权卡发过来，点一下走完。前任的授权不会转移，也不该转移。`)
  L.push(`4. **清待确认**：问一句"有哪些还没确认的记录"，把它们过一遍——对的说确认，不对的说删掉。这些是最容易过期的部分。`)
  L.push(`5. **认领事项**：问一句"现在什么情况"看逾期和 7 天内到期的，逐条确认负责人还对不对（不对就跟 ${input.botName} 说"#编号 换成 xx 负责"）。`)
  L.push(`6. **首轮验收**：问一次"现在什么情况"和"你怎么知道的"——前者确认事项状态对得上，后者确认 ${input.botName} 读的层和你以为的一致。两个都对，就算交接完成。`)
  L.push('')

  L.push('## 常驻职责定义', '')
  if (!input.responsibilities.length) L.push('（没有生效中的职责。）')
  for (const { routine: r, runAsName } of input.responsibilities) {
    L.push(`### #${r.id} ${r.name}`, '')
    L.push(`- 频率：${describeSchedule(r.schedule)}｜发到：${r.deliverTo === 'dm' ? '创建者私聊' : '本群'}`)
    L.push(`- **以谁的身份运行**：${runAsName ?? (r.runAs ? r.runAs : '无主（只读运行，不能发私聊 / 发文件 / 写 GitHub）')}`)
    if (r.watchChatIds.length) L.push(`- 盯的群：${r.watchChatIds.join('、')}`)
    L.push(`- 上次运行：${r.lastRunAt ? `${fmtDate(r.lastRunAt)}（${r.lastStatus === 'ok' ? '有内容' : r.lastStatus === 'skipped' ? '无内容' : '失败'}）` : '还没跑过'}；下次 ${fmtDate(r.nextRunAt)}`)
    L.push('- 每次做什么（原文，可直接复制给接手人重建）：', '')
    L.push('```', r.prompt.slice(0, 2000), '```', '')
  }

  L.push('## 事项明细', '')
  const table = (name: string, items: Todo[]): void => {
    if (!items.length) return
    L.push(`**${name}**`, '')
    for (const t of items) {
      L.push(`- #${t.id} ${t.kind === 'todo' ? '' : `[${KIND_LABEL[t.kind]}] `}${t.title}${t.dueMs ? `（${fmtDate(t.dueMs)}）` : ''}${t.owner ? ` · ${t.owner}` : ''} · ${STATUS_LABEL[t.status]}${t.statusNote ? `（${t.statusNote}）` : ''}${t.confirmed ? '' : ' · 待确认'}`)
    }
    L.push('')
  }
  table('逾期', input.facts.overdue)
  table('7 天内到期', input.facts.upcoming)
  table('在跟', input.facts.open)
  table('本周完成', input.facts.done)
  if (!input.facts.overdue.length && !input.facts.upcoming.length && !input.facts.open.length && !input.facts.done.length) L.push('（没有登记在案的事项。）', '')

  L.push('## 状态游标', '')
  L.push('接手后这些会继续往前走，列在这里是为了让你知道"它记到哪儿了"：')
  L.push('')
  L.push(`- 空间配置：${JSON.stringify(input.space.config)}`)
  L.push(`- 空间创建于 ${fmtDate(input.space.createdAt)}，最近一次改动 ${fmtDate(input.space.updatedAt)}`)
  for (const { routine: r } of input.responsibilities) L.push(`- 职责 #${r.id} 已运行 ${r.runs} 次，连续失败 ${r.failCount} 次`)
  L.push('')
  L.push(`> 这份交接包由 ${input.botName} 在 ${fmtDate(input.nowMs)} 生成，内容来自它自己的库。**不含任何凭证**；再要一份跟它说一声就行。`)
  return { title, markdown: L.join('\n') }
}
