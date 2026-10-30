/**
 * ContextReceipt：一轮回答"用了什么、没用什么、为什么"。`!why` 把它讲给人听。
 *
 * 这是 B2B Agent 最该有、也最容易被跳过的东西：人问"你怎么知道的"和"你为什么看不到 X"时，
 * 答案必须来自**真实发生过的检索**，而不是模型的复述。所以 receipt 由网关在组 prompt 时如实记录，
 * 模型碰不到它。
 *
 * 另一半是披露（disclosure）：这一轮如果读了别的会话（联盟内的其他群），
 * 回答会带一行"引用了 X 群"，让在场的人知道内容是从哪来的——跨空间内容不该悄悄出现。
 */
import { fmtDate, type MemoryAvailability, type MemoryUsage } from './memory.js'

export interface CrossSpaceRead {
  chatId: string
  name: string
  /** 读了什么：历史 / 搜索 / 文档 */
  what: string
}

export interface ContextReceipt {
  sessionKey: string
  atMs: number
  where: string
  spaceId: string
  actor: string
  /** 记忆层的命中情况 */
  memory: MemoryUsage
  /** 首轮带进去的话题历史条数 */
  priorMessages: number
  attachments: number
  /** 本空间的行为偏好条数 */
  prefs: number
  circle?: string
  /** 这一轮读到的其他会话（披露用） */
  crossSpace: CrossSpaceRead[]
  /** 明确没有取的来源，以及为什么 */
  excluded: string[]
  /** Discovery is not a read receipt; actual custom bodies served are stored against the Run. */
  skillSet?: { digest: string; builtinDigest: string; available: { name: string; proposalId: number; contentDigest: string }[] }
}

/** 平台的原始标识（oc_ 群、om_ 消息、ou_ 人）。名字没解析出来时会退化成它，对人没有意义。 */
const RAW_ID_RE = /^(oc|om|ou|on)_[0-9a-zA-Z]+$/

/**
 * 一行披露，附在回答末尾。没有跨空间读取时返回 undefined。
 *
 * 名字解析不出来时只说"另外 N 个群聊"——披露的目的是让在场的人知道内容从哪来，
 * 打一串 chat_id 既帮不到人，又把内部标识摆到了群里。
 */
export function disclosureLine(reads: CrossSpaceRead[], selfChatId: string): string | undefined {
  const others = reads.filter((r) => r.chatId !== selfChatId)
  if (!others.length) return undefined
  const named = new Set<string>()
  const unnamed = new Set<string>()
  for (const r of others) {
    const name = r.name?.trim() ?? ''
    if (name && !RAW_ID_RE.test(name)) named.add(name)
    else unnamed.add(r.chatId)
  }
  const namedPart = [...named].map((n) => `「${n}」`).join('、')
  const unnamedPart = unnamed.size ? `另外 ${unnamed.size} 个群聊` : ''
  if (!namedPart) return `（本条回答引用了${unnamedPart}的内容）`
  return `（本条回答引用了${namedPart}${unnamedPart ? `和${unnamedPart}` : ''}的内容）`
}

/** Host facts shared by the current prompt, query receipt, and historical context explanation. */
export function describeMemoryAvailability(availability: MemoryAvailability | undefined): string {
  if (!availability) return ''
  const lines: string[] = []
  if (availability.inactiveNotes > 0) lines.push(`有 ${availability.inactiveNotes} 条记忆的来源已失效，本轮未加载。`)
  if (availability.temporarilyUnavailableNotes > 0) lines.push(`有 ${availability.temporarilyUnavailableNotes} 条记忆的来源暂未能核验，本轮未加载。`)
  return lines.join('\n')
}

/** `!why` 的正文。 */
export function renderReceipt(r: ContextReceipt | undefined, botName: string): string {
  if (!r) return `这个话题里还没有我答过的轮次。@ 我问点什么，再问一句"你怎么知道的"，我就能说清楚那一轮用了什么。`
  const lines: string[] = [`**上一轮（${fmtDate(r.atMs)}）我用了什么**`, `位置：${r.where}｜空间 ${r.spaceId}｜你在这里是${r.actor}`]

  const layers = r.memory.layers.filter((l) => l.total > 0 || l.rules > 0 || l.hits > 0)
  if (layers.length) {
    lines.push(`**读的记忆层**\n${layers.map((l) => `- ${l.label}：常驻要求 ${l.rules} 条全带，${l.profiles ? `近期偏好 ${l.profiles} 条${l.profilesTruncated ? '（仅取最近部分）' : ''}，` : ''}按这次的问题命中 ${l.hits} 条（这一层共 ${l.total} 条）`).join('\n')}`)
  } else {
    lines.push('**读的记忆层**：这一轮没有加载可用记忆。')
  }
  const availability = describeMemoryAvailability(r.memory.availability)
  if (availability) lines.push(`**记忆可用性**\n${availability}`)
  if (r.memory.notes.length) {
    lines.push(`**具体引用的条目**\n${r.memory.notes.map((n) => `- #${n.id} ${n.title}（${n.label}${n.status === 'candidate' ? ' · 未确认' : ''}）`).join('\n')}`)
  }

  const ctx: string[] = []
  if (r.priorMessages) ctx.push(`话题里之前的 ${r.priorMessages} 条消息`)
  if (r.attachments) ctx.push(`${r.attachments} 个附件`)
  if (r.prefs) ctx.push(`本空间的 ${r.prefs} 条行为偏好`)
  if (r.circle) ctx.push(`联盟「${r.circle}」（同联盟的群可读）`)
  if (ctx.length) lines.push(`**还带了**：${ctx.join('、')}。`)

  if (r.crossSpace.length) {
    lines.push(`**读了别的会话**\n${r.crossSpace.map((c) => `- ${c.name}：${c.what}`).join('\n')}`)
  }
  if (r.excluded.length) lines.push(`**没有取的**\n${r.excluded.map((e) => `- ${e}`).join('\n')}`)
  lines.push(`这些都是网关在组装这一轮时如实记下的，不是 ${botName} 自己复述的。重启后就没了。`)
  return lines.join('\n\n')
}
