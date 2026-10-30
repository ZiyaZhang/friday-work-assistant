/**
 * 飞书交互卡片（schema 2.0）渲染。一个任务一张卡，原地 patch 更新。
 * 卡片三段：状态行、工具进度清单、正文。
 */

import { ALL_LISTED_COMMANDS, COMMAND_GROUPS, commandMenu } from './mention.js'
import { describeConnectionGrant, describeConnectionRequest } from './connection-capabilities.js'
import { renderPagedTodoCard, type TodoCardInput } from './todo-card-pagination.js'
export { TodoCardBudgetError, type TodoCardTransport } from './todo-card-pagination.js'

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface ToolProgress {
  id: string
  title: string
  kind?: string
  status: ToolStatus
  /** 命令 / 文件路径等一行摘要（来自 rawInput），显示在工具行里 */
  detail?: string
  /** 该次调用带的沙箱升级请求（bash / write / edit 越出沙箱时） */
  escalation?: { mode: string; justification?: string }
}

export type TaskPhase = 'queued' | 'thinking' | 'working' | 'waiting_permission' | 'done' | 'failed' | 'cancelled'

export interface TaskCardState {
  title: string
  phase: TaskPhase
  /** Host-derived human status; Task.phase remains the legacy executor/rendering state. */
  progress?: import('../core/work-progress.js').WorkProgress
  statusLine?: string
  tools: ToolProgress[]
  body: string
  error?: string
  footer?: string
  /** 卡片正文上限，超出截断并提示 */
  bodyLimit?: number
}

export const CARD_BODY_LIMIT = 3800
const MAX_TOOL_ROWS = 8

const PHASE_META: Record<TaskPhase, { label: string; template: string }> = {
  queued: { label: '排队中', template: 'grey' },
  thinking: { label: '思考中', template: 'blue' },
  working: { label: '处理中', template: 'blue' },
  waiting_permission: { label: '等待确认', template: 'orange' },
  done: { label: '完成', template: 'green' },
  failed: { label: '失败', template: 'red' },
  cancelled: { label: '已中止', template: 'grey' },
}

const TOOL_ICON: Record<ToolStatus, string> = {
  pending: '▫️',
  in_progress: '⏳',
  completed: '✅',
  failed: '❌',
}

/**
 * 任务卡：按普通消息的样式呈现——没有标题栏、没有颜色块。
 * 进行中：一行灰色状态 + 工具进度；完成后：只剩正文，过程折叠成一行「过程 · N 步 · 用时」；
 * 出错 / 中止 / 等待确认才用带颜色的提示行。
 */
export function renderTaskCard(state: TaskCardState): Record<string, unknown> {
  const meta = PHASE_META[state.phase]
  const elements: Record<string, unknown>[] = []
  const limit = state.bodyLimit ?? CARD_BODY_LIMIT
  const working = state.progress ? ['received', 'queued', 'running', 'stopping', 'waiting_user', 'waiting_authorization'].includes(state.progress.state)
    : state.phase === 'queued' || state.phase === 'thinking' || state.phase === 'working' || state.phase === 'waiting_permission'
  const toolRows = state.tools.slice(-MAX_TOOL_ROWS).map((t) => `${TOOL_ICON[t.status]} ${toolRowText(t)}`)
  const hidden = state.tools.length - Math.min(state.tools.length, MAX_TOOL_ROWS)
  if (hidden > 0) toolRows.unshift(`…前 ${hidden} 步已省略`)

  if (state.progress) {
    if (!['handled', 'completed'].includes(state.progress.state) || !state.body.trim()) {
      elements.push(note(`${state.progress.label}。${state.progress.detail}`, state.progress.state === 'failed' ? 'red'
        : ['partial', 'needs_attention', 'waiting_user', 'waiting_authorization'].includes(state.progress.state) ? 'orange' : 'grey'))
    }
    if (working && toolRows.length) elements.push(note(toolRows.join('\n'), 'grey'))
  } else if (working) {
    const line = state.phase === 'waiting_permission' ? `${state.statusLine ?? '等待确认'}` : `${state.statusLine ?? (state.phase === 'working' ? '处理中…' : 'Friday 正在读取上下文…')}`
    elements.push(note(line, state.phase === 'waiting_permission' ? 'orange' : 'grey'))
    if (toolRows.length) elements.push(note(toolRows.join('\n'), 'grey'))
  }

  if (state.body.trim()) {
    const { text, truncated } = truncate(state.body.trim(), limit)
    elements.push(md(text))
    if (truncated) elements.push(note('（正文过长已截断，完整内容随后以消息发出）', 'grey'))
  }

  if (!state.progress) {
    if (state.phase === 'failed') elements.push(md(`<font color="red">出错：${escapeForCard(state.error ?? '未知错误')}</font>`))
    else if (state.error) elements.push(md(`<font color="red">${escapeForCard(state.error)}</font>`))
    if (state.phase === 'cancelled') elements.push(note('已中止', 'grey'))
  }

  if (!working && state.tools.length) {
    // 过程折叠起来：想看再点开
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'markdown', content: `<font color="grey">过程 · ${state.tools.length} 步${state.footer ? ` · ${escapeForCard(state.footer)}` : ''}</font>` },
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '14px 14px' },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '6px' },
      padding: '4px 8px 4px 8px',
      elements: [note(toolRows.join('\n'), 'grey')],
    })
  } else if (!working && state.footer) {
    elements.push(note(state.footer, 'grey'))
  }

  if (!elements.length) elements.push(note(meta.label, 'grey'))
  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    body: { elements },
  }
}

/** 小号灰字（notation）：状态行、过程、脚注。 */
function note(text: string, color: 'grey' | 'orange' | 'red' = 'grey'): Record<string, unknown> {
  return { tag: 'markdown', content: `<font color="${color}">${escapeForCard(text)}</font>`, text_size: 'notation' }
}

export interface PermissionCardInput {
  requestId: string
  botName?: string
  toolTitle: string
  /** execute = 跑命令；edit = 改文件；其他 = 未知操作 */
  category?: 'execute' | 'edit' | 'read' | 'other'
  kind?: string
  /** 命令原文 / 文件路径 */
  detail?: string
  /** Approval of external parameters must show every byte, without markdown interpretation. */
  fullDetail?: boolean
  /** 模型对这条命令的一句话说明 */
  description?: string
  /** 沙箱升级：目标模式 + 模型的理由 */
  escalation?: { mode: string; justification?: string }
  /** 额外说明（比如"本机没有沙箱后端，命令会直接在开发机上运行"） */
  note?: string
  /** 只有这个人（发起人）能点；显示在卡片上 */
  approverName?: string
  /** 要别人拍板时 @ 他。open_id 由宿主从空间负责人表取，不来自模型。 */
  mentionOpenId?: string
  /** 自定义标题（网关侧写操作，如"需要你确认：开 PR"） */
  header?: string
  expiresInMinutes: number
}

export function renderPermissionCard(input: PermissionCardInput, decided?: 'allow' | 'deny' | 'expired' | 'cancelled'): Record<string, unknown> {
  if (input.fullDetail && Buffer.byteLength(input.detail ?? '', 'utf8') > 16_000) {
    throw new Error('确认内容过长，无法完整展示；请缩小这次操作的参数。')
  }
  const bot = escapeForCard(input.botName ?? 'Friday')
  const lines: string[] = []
  if (input.category === 'execute') {
    lines.push(`${bot} 想在开发机上执行命令${input.escalation ? `（要求沙箱模式 \`${escapeForCard(input.escalation.mode)}\`）` : ''}：`)
    lines.push(codeBlock(input.detail ?? input.toolTitle))
  } else if (input.category === 'edit') {
    lines.push(`${bot} 想修改工作区之外的文件${input.escalation ? `（要求沙箱模式 \`${escapeForCard(input.escalation.mode)}\`）` : ''}：`)
    lines.push(`**${escapeForCard(input.toolTitle)}** \`${escapeForCard(clip(input.detail ?? '', 300))}\``)
  } else {
    lines.push(`${bot} 想执行需要确认的操作：**${escapeForCard(input.toolTitle)}**${input.kind ? `（${escapeForCard(input.kind)}）` : ''}`)
    if (input.detail && !input.fullDetail) lines.push(codeBlock(input.detail))
  }
  if (input.description) lines.push(`用途：${escapeForCard(input.description)}`)
  if (input.escalation?.justification) lines.push(`${bot} 的理由：${escapeForCard(input.escalation.justification)}`)
  if (input.note) lines.push(`<font color="grey">${escapeForCard(input.note)}</font>`)
  // 要别人点头时直接 @ 他，否则这张卡会挂在那儿没人认领。open_id 来自宿主，按形态再核一次。
  if (input.mentionOpenId && /^ou_[A-Za-z0-9]+$/.test(input.mentionOpenId)) {
    lines.push(`请 <at id="${input.mentionOpenId}"></at> 确认`)
  }
  const elements: Record<string, unknown>[] = [md(lines.join('\n'))]
  if (input.fullDetail && input.detail) elements.push({ tag: 'div', text: { tag: 'plain_text', content: input.detail } })
  if (decided === 'allow') elements.push(md('✅ 已允许'))
  else if (decided === 'deny') elements.push(md('⛔ 已拒绝'))
  else if (decided === 'expired') elements.push(md(`⌛ ${input.expiresInMinutes} 分钟内无人确认，已按拒绝处理`))
  else if (decided === 'cancelled') elements.push(md('本次请求已结束，确认已取消；这项操作没有获准执行。'))
  else {
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        column(button('允许', 'primary', { action: 'perm', request_id: input.requestId, decision: 'allow' })),
        column(button('拒绝', 'danger', { action: 'perm', request_id: input.requestId, decision: 'deny' })),
      ],
    })
    elements.push(md(`<font color="grey">${input.approverName ? `由 ${escapeForCard(input.approverName)} 确认；` : ''}${input.expiresInMinutes} 分钟内未确认将按拒绝处理</font>`))
  }
  const card = {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: input.header ?? (input.category === 'execute' ? '需要你确认：执行命令' : input.category === 'edit' ? '需要你确认：修改文件' : '需要你确认') }, template: decided ? 'grey' : 'orange' },
    body: { elements },
  }
  if (input.fullDetail && Buffer.byteLength(JSON.stringify(card), 'utf8') > 28_000) {
    throw new Error('确认卡片过长，无法完整展示；请缩小这次操作的参数。')
  }
  return card
}

export function renderReportCard(input: { title: string; body: string; source?: string }): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [md(truncate(input.body, CARD_BODY_LIMIT).text)]
  if (input.source) elements.push({ tag: 'markdown', content: `<font color="grey">${escapeForCard(input.source)}</font>`, text_size: 'notation' })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: clip(input.title, 60) }, template: 'indigo' },
    body: { elements },
  }
}

/**
 * 定时任务 / 关注群聊的结果卡：标题一行「关注群聊 · 群名」· 一句话，正文默认折叠，
 * 不打扰人，点开才展开。
 */
/**
 * 职责交付卡（日报、关注群聊摘要共用）。2026-09-28 定的版式：蓝色卡头，标题是职责名、副标题是日期和来源；
 * 结论一两句放最上面、始终可见；其余内容（进展 / 待确认 / 风险）短的直接展示，长的才折叠成「完整内容」；
 * 没有底部说明（频率、下次时间、"不想再收跟我说一声"都不放），不加 @、不加结尾套话。
 */
export function renderDigestCard(input: { title: string; subtitle?: string; conclusion: string; body: string; fold?: boolean }): Record<string, unknown> {
  const body = truncate(input.body.trim(), CARD_BODY_LIMIT).text
  const elements: Record<string, unknown>[] = []
  const conclusion = input.conclusion.trim()
  if (conclusion) elements.push(md(escapeForCard(conclusion)))
  if (body) {
    const sections = digestSections(body)
    // A long report still shows its first short section; only the remaining detail folds away.
    const visible = input.fold ? (sections.length > 1 && sections[0]!.length < 800 ? sections.splice(0, 1) : []) : sections.splice(0)
    for (const section of visible) {
      if (elements.length) elements.push({ tag: 'hr' })
      elements.push(md(section))
    }
    if (sections.length) elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'markdown', content: visible.length ? '更多详情' : '完整内容' },
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '6px' },
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: sections.map(md),
    })
  }
  const header: Record<string, unknown> = { title: { tag: 'plain_text', content: clip(input.title, 40) }, template: 'blue' }
  if (input.subtitle) header.subtitle = { tag: 'plain_text', content: clip(input.subtitle, 60) }
  return { schema: '2.0', config: { wide_screen_mode: true }, header, body: { elements } }
}

/** Feishu markdown does not support Markdown headings/tables. Keep links and native :emoji: codes intact. */
function digestSections(body: string): string[] {
  const sections: string[] = []
  let lines: string[] = [], fence = false
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence
    const heading = !fence && (line.match(/^#{1,4}\s+(.+?)\s*#*$/) ?? line.match(/^\*\*(.+?)\*\*\s*$/))
    if (heading) {
      if (lines.join('\n').trim()) sections.push(lines.join('\n').trim())
      lines = [`**${heading[1]}**`]
    } else lines.push(line)
  }
  if (lines.join('\n').trim()) sections.push(lines.join('\n').trim())
  return sections
}

/** 全文先单独送达，这张卡只决定确切版本；不得把截断预览当成完整审阅。 */
export function renderSkillProposalCard(input: { id: number; name: string; description: string; body: string; contentDigest?: string | null; reviewParts?: number; status?: 'pending' | 'accepted' | 'ignored'; decidedBy?: string | null }): Record<string, unknown> {
  const status = input.status ?? 'pending'
  const elements: Record<string, unknown>[] = [
    md(`**「新提议」· 新增技能 \`${escapeForCard(input.name)}\`**\n${escapeForCard(input.description)}`),
  ]
  // 已决定的卡带上版本。待决定的卡输出不能变：SkillApplication.requireCompleteReview 按 payload 摘要核对已发出的待决定卡
  const version = input.contentDigest ? `\n版本：\`${input.contentDigest.slice(0, 12)}\`` : ''
  if (status === 'accepted') elements.push(md(`✅ 已在本空间启用${input.decidedBy ? `（${escapeForCard(input.decidedBy)}）` : ''}，后续任务可使用这个版本${version}`))
  else if (status === 'ignored') elements.push(md(`已忽略${version}`))
  else if (input.contentDigest && input.reviewParts) {
    elements.push(md(`完整 SKILL.md 已分 ${input.reviewParts} 段发送在这张卡前面。请核对全文后决定。\n接受后只在本空间启用；这个提议版本目前尚未启用。\n版本：\`${input.contentDigest.slice(0, 12)}\``))
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        column(button('接受', 'primary', { action: 'skill', id: input.id, decision: 'accept', contentDigest: input.contentDigest })),
        column(button('忽略', 'default', { action: 'skill', id: input.id, decision: 'ignore', contentDigest: input.contentDigest })),
      ],
    })
  } else elements.push(md('这条旧提议没有完整正文的投递记录，请在当前空间重新提议后再决定。'))
  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: status === 'pending' ? '新提议' : status === 'accepted' ? '已接受' : '已忽略' }, template: status === 'pending' ? 'purple' : status === 'accepted' ? 'green' : 'grey' },
    body: { elements },
  }
}

/** 个人授权卡：一个打开授权页的按钮 + 回调不通时的兜底说明。 */
/**
 * 个人授权卡。
 *
 * 写成**两步**，因为它本来就是两步：去飞书点同意，回来告诉我。
 * 以前这张卡把 11 个 scope 平铺出来，再把"页面打不开就把地址粘回来"当成脚注——
 * 可那恰恰是必经的第二步（回调地址在开发机上，你的浏览器到不了）。
 * 现在：权限清单折起来（想看再点），第二步写在正脸上。
 *
 * `expired` 是委托授权到期时的同一张卡：橙色抬头 + 说清连带影响
 * （同一授权下的关注任务暂停，保留读取位置），照 docs/signals.md §4。
 */
export function renderConnectCard(input: {
  botName: string
  authorizeUrl: string
  scopes: string[]
  connected?: { name?: string | null; scope?: string }
  expired?: { chatName: string; scopeMissing?: boolean }
}): Record<string, unknown> {
  const bot = escapeForCard(input.botName)
  const head: string[] = []
  if (input.expired) {
    head.push(`**关注「${escapeForCard(input.expired.chatName)}」${input.expired.scopeMissing ? '缺少群历史权限' : '所用的授权已到期'}。**`)
    head.push('使用这份授权的关注任务已暂停，读取位置已保留。取得所需权限后，仍启用的空间会恢复关注。')
  } else if (input.connected) {
    head.push(`你已经授权过了${input.connected.name ? `（${escapeForCard(input.connected.name)}）` : ''}。重新授权会覆盖旧的；想解除跟我说一声。`)
    head.push(escapeForCard(describeConnectionGrant(input.connected.scope ?? '')))
  } else {
    head.push(`连接后，我会在**私聊里**按你实际同意的权限，读取你有权访问的会话和文档。`)
    head.push('群里我仍然只用机器人身份发消息。文档读写依实际授权和本次委托执行。')
    head.push(`不想让我看的会话，跟我说一声就**单独停掉**（停一个只停这一个）；想整个断开也跟我说一声。token 只存在网关，不进模型。`)
  }
  head.push(escapeForCard(describeConnectionRequest(input.scopes)))

  const elements: Record<string, unknown>[] = [
    md(head.join('\n')),
    md('**① 打开授权页面，完成飞书授权：**'),
    md('<font color="grey">同意后请等 Friday 核验连接结果。若回调页面打不开，连接尚未完成；请只在 Friday 私聊反馈，不要把带授权码的链接发到群里。</font>'),
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '打开授权页面' },
      type: 'primary',
      width: 'default',
      behaviors: [{ type: 'open_url', default_url: input.authorizeUrl }],
    },
    md('**② 授权成功后，我会在私聊通知你。也可以查看连接状态：**'),
    {
      tag: 'column_set',
      flex_mode: 'none',
      columns: [column(button('查看连接状态', 'default', { action: 'oauth', op: 'check' })), column(button('稍后处理', 'default', { action: 'oauth', op: 'later' }))],
    },
    {
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'markdown', content: `<font color="grey">会申请哪些权限（${input.scopes.length} 项${input.scopes.includes('docx:document') ? '，含文档读写' : ''}）</font>` },
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '14px 14px' },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '6px' },
      padding: '4px 8px 4px 8px',
      elements: [md(input.scopes.map((x) => `\`${x}\``).join(' '))],
    },
  ]
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: input.expired ? input.expired.scopeMissing ? '需要补充群历史授权' : '盯的群授权到期了' : `个人授权 · ${bot}` },
      template: input.expired ? 'orange' : 'blue',
    },
    body: { elements },
  }
}

export interface ChatScopeRow {
  chatId: string
  name: string
}

/**
 * 「关注的群聊」卡片：默认全都能读，逐个停读 / 恢复。
 *
 * 取舍写在卡片第一句上：连接之后立刻可用，代价是授权面大。
 * 所以这张卡的第一职责不是勾选，而是让人**看见范围有多大**，并给一个随时停掉某个群的入口。
 */
export function renderChatScopeCard(input: {
  botName: string
  connected: boolean
  readable: ChatScopeRow[]
  excluded: ChatScopeRow[]
  /** 群列表没读完整时说清楚，不让人以为"就这些" */
  complete?: boolean
  limit?: number
  page?: number
}): Record<string, unknown> {
  const limit = input.limit ?? 12
  const elements: Record<string, unknown>[] = []
  if (!input.connected) {
    // 走到这里说明这个部署根本没开个人授权——能授权的话，调用方给的是那张能点的授权卡，不是这句话。
    elements.push(md('这个部署没有开启个人授权，所以我读不到你所在的群。'))
    return {
      schema: '2.0', config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: `读取范围 · ${escapeForCard(input.botName)}` }, template: 'grey' },
      body: { elements },
    }
  }

  const total = input.readable.length + input.excluded.length
  const pages = Math.max(1, Math.ceil(Math.max(input.readable.length, input.excluded.length) / limit))
  const page = Math.max(0, Math.min(pages - 1, Math.trunc(input.page ?? 0)))
  elements.push(md(`已列出 **${total}** 个会话。这里管理允许读取的范围，自动收集可在个人设置中开启或暂停。结果只发给你。`))

  if (input.readable.length) {
    elements.push(md(`**允许读取**（${input.readable.length}）`))
    for (const row of input.readable.slice(page * limit, (page + 1) * limit)) {
      elements.push({
        tag: 'column_set', flex_mode: 'none',
        columns: [
          { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [md(`「${escapeForCard(row.name)}」`)] },
          column(button('排除', 'default', { action: 'scope', op: 'exclude', chat_id: row.chatId, page })),
        ],
      })
    }
  }

  if (input.excluded.length) {
    elements.push(md(`**已排除**（${input.excluded.length}）`))
    for (const row of input.excluded.slice(page * limit, (page + 1) * limit)) {
      elements.push({
        tag: 'column_set', flex_mode: 'none',
        columns: [
          { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [md(`「${escapeForCard(row.name)}」`)] },
          column(button('恢复', 'default', { action: 'scope', op: 'restore', chat_id: row.chatId, page })),
        ],
      })
    }
  }

  if (input.complete === false) elements.push(md('<font color="grey">群列表这次没读完整，上面可能还有没列出来的会话。</font>'))
  if (pages > 1) elements.push({ tag: 'column_set', flex_mode: 'none', columns: [
    ...(page ? [column(button('上一页', 'default', { action: 'scope', op: 'page', page: page - 1 }))] : []),
    column(md(`${page + 1}/${pages} 页`)),
    ...(page < pages - 1 ? [column(button('下一页', 'default', { action: 'scope', op: 'page', page: page + 1 }))] : []),
  ] })
  elements.push(md('<font color="grey">私聊列出已发现事项的会话，以事项名称标识。实际可读的消息范围以飞书授权为准。</font>'))

  return {
    schema: '2.0', config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: `读取范围 · ${escapeForCard(input.botName)}` }, template: 'blue' },
    body: { elements },
  }
}

/**
 * 第一次在一个空间里被 @ 时发的自我介绍：
 * 说清边界、给几句可以照着抄的话、把命令折起来。让人不用读文档就知道怎么用。
 */
export function renderWelcomeCard(input: { botName: string; isDm: boolean; ownerName?: string }): Record<string, unknown> {
  const { botName, isDm } = input
  const lines: string[] = [`**${botName} 就位了。**`]
  lines.push(
    isDm
      ? '私聊里我是你的个人助理：这里的记忆和事项**只有你能看到**。授权卡我紧接着发过来，申请范围会列在卡上，完成后按实际授权和资料访问权限处理——不点也不影响其它功能。'
      : `群里我是这个组的 AI 同事：${input.ownerName ? `**${escapeForCard(input.ownerName)}** 是本空间负责人（可以改我的行为偏好），` : ''}在这里说过话的人都是成员。我**只在本群说话做事**——就算授权我读别的群，我也不会跑去别的群发言。`,
  )
  lines.push('')
  lines.push('**不知道从哪开始？照着说就行：**')
  const examples = isDm
    ? ['"今天我要做什么" / "现在什么情况"', '"每天 9 点把昨天的讨论总结发我"', '"帮我盯着 xx 群里关于发布的讨论"', '"把你知道的整理成一页"']
    : [
        `"@${botName} 总结一下最近三天关于发布的讨论"`,
        `"@${botName} 9/25 封版，记一下，@陆知行 负责"（到点我会在群里提醒）`,
        `"@${botName} 以后回答简短点"（这类长期要求我会一直记着）`,
        `"@${botName} 现在什么情况"`,
      ]
  lines.push(examples.map((e) => `- ${e}`).join('\n'))
  const cmdRows = COMMAND_GROUPS.map((g) => `**${g.title}** ${g.items.map((c) => `\`${c.name}\``).join(' ')}`)
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [
        md(lines.join('\n')),
        {
          tag: 'collapsible_panel',
          expanded: false,
          header: {
            title: { tag: 'markdown', content: commandMenu('<font color="grey">也可以用命令（输入 / 挑一个，`/help` 看全部）</font>') },
            icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '14px 14px' },
            icon_position: 'right',
            icon_expanded_angle: -180,
          },
          border: { color: 'grey', corner_radius: '6px' },
          padding: '8px 8px 8px 8px',
          elements: [md(cmdRows.join('\n'))],
        },
      ],
    },
  }
}

export function renderHelpCard(botName: string): Record<string, unknown> {
  const groups = COMMAND_GROUPS.map((g) => {
    const rows = g.items.map((c) => `\`${c.name}\` ${escapeForCard(c.desc)}${c.saying ? ` · 或者直接说"${escapeForCard(c.saying)}"` : ''}`)
    return `**${g.title}**\n${rows.join('\n')}`
  })
  const head = [
    `**直接跟我说话就行**，命令只是快捷方式：`,
    `- @${botName} 总结一下这个群最近三天关于发布的讨论`,
    `- @${botName} 9/25 封版，记一下，@陆知行 负责`,
    `- @${botName} 读一下这篇文档并列出待办 https://xxx.feishu.cn/docx/...`,
    `- @${botName} 每天 9 点把昨天的讨论总结发我`,
    '',
    '同一话题里直接回复即可追问；私聊我可以让我把结果单独汇报给你。',
  ].join('\n')
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `${botName} 使用说明` }, template: 'blue' },
    body: {
      elements: [
        md(head),
        {
          tag: 'collapsible_panel',
          expanded: false,
          header: {
            title: { tag: 'markdown', content: `<font color="grey">全部命令 · ${ALL_LISTED_COMMANDS.length} 个（输入 / 或 ! 都行）</font>` },
            icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '14px 14px' },
            icon_position: 'right',
            icon_expanded_angle: -180,
          },
          border: { color: 'grey', corner_radius: '6px' },
          padding: '8px 8px 8px 8px',
          elements: [md(groups.join('\n\n'))],
        },
      ],
    },
  }
}

/**
 * 「新提议」· 职责提案（模型发现的常驻职责，经人确认后生效，72 小时未处理则失效）。
 * 卡片上写清楚三件事：它要做什么、多久做一次、**以谁的身份**做。
 */
export function renderResponsibilityCard(input: {
  id: number
  name: string
  schedule: string
  deliverTo: string
  prompt: string
  runAsName?: string
  expiresAt?: number | null
  status?: 'proposed' | 'active' | 'ignored' | 'expired'
  decidedBy?: string | null
  /** 渲染这张卡时这一行的 config_version（和卡片内容同一时刻读）；按钮带上它，点击时只接受这一版 */
  configVersion: number
}): Record<string, unknown> {
  const status = input.status ?? 'proposed'
  const elements: Record<string, unknown>[] = [
    md(`**「新提议」· 常驻职责 ${escapeForCard(input.name)}**\n${escapeForCard(input.schedule)} → ${escapeForCard(input.deliverTo)}`),
    {
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'markdown', content: '它每次会做什么' }, icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' }, icon_position: 'right', icon_expanded_angle: -180 },
      border: { color: 'grey', corner_radius: '6px' },
      padding: '8px 8px 8px 8px',
      elements: [md(escapeForCard(clip(input.prompt, 1200)))],
    },
  ]
  if (status === 'active') elements.push(md(`✅ 已接受${input.decidedBy ? `（${escapeForCard(input.decidedBy)}）` : ''}，以${input.runAsName ? escapeForCard(input.runAsName) : '接受者'}的身份运行。想暂停跟我说一声。`))
  else if (status === 'ignored') elements.push(md('已忽略'))
  else if (status === 'expired') elements.push(md('72 小时没人处理，这条提案作废了。要的话直接跟我说一声重新建。'))
  else {
    elements.push(md(`接受后**以点「接受」的人的身份运行**——它能读到的、能写的，都以那个人为准。${input.expiresAt ? `${fmtCardTime(input.expiresAt)} 前没人处理就作废。` : ''}`))
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        column(button('接受', 'primary', { action: 'resp', id: input.id, decision: 'accept', v: input.configVersion })),
        column(button('忽略', 'default', { action: 'resp', id: input.id, decision: 'ignore', v: input.configVersion })),
      ],
    })
  }
  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: status === 'proposed' ? '新提议 · 常驻职责' : status === 'active' ? '已接受' : status === 'ignored' ? '已忽略' : '已作废' },
      template: status === 'proposed' ? 'purple' : status === 'active' ? 'green' : 'grey',
    },
    body: { elements },
  }
}

// ---- helpers ----

function fmtCardTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function md(content: string): Record<string, unknown> {
  return { tag: 'markdown', content }
}

/** 工具行：`bash · ls -la`（命令 / 路径压成一行、截短，行内代码避免被当 markdown 解析）。 */
function toolRowText(t: ToolProgress): string {
  const title = escapeForCard(t.title)
  if (!t.detail) return title
  const detail = clip(t.detail, 70).replace(/`/g, '＇')
  return `${title} · \`${escapeForCard(detail)}\``
}

/** 代码块；正文里的 ``` 会截断代码块，替换掉。 */
function codeBlock(text: string): string {
  return '```\n' + truncate(text, 800).text.replace(/```/g, '``') + '\n```'
}

function column(...elements: Record<string, unknown>[]): Record<string, unknown> {
  return { tag: 'column', width: 'auto', elements }
}

function button(text: string, type: 'primary' | 'danger' | 'default', value: Record<string, unknown>): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    width: 'default',
    behaviors: [{ type: 'callback', value }],
  }
}

export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

export function truncate(s: string, limit: number): { text: string; truncated: boolean } {
  if (s.length <= limit) return { text: s, truncated: false }
  return { text: s.slice(0, limit) + '\n…', truncated: true }
}

/** 卡片 markdown 里尖括号会被当标签，状态行这类非正文做一次转义。 */
export function escapeForCard(s: string): string {
  return s.replace(/</g, '＜').replace(/>/g, '＞')
}

/** 把长文本切成多条飞书文本消息。 */
export function chunkText(s: string, size = CARD_BODY_LIMIT): string[] {
  const out: string[] = []
  let rest = s
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = size
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) out.push(rest)
  return out
}

/**
 * 群里默认只露结论，长的折起来。
 *
 * 模型查得深是好事，但一次在群里糊 2000 字没人看——尤其手机上，
 * 别人要滚三屏才能翻过这条消息。所以**折叠在网关侧强制**，不指望模型自觉：
 * 前面几行（结论）露出来，剩下的收进折叠面板，想看的人点一下。
 *
 * 短回答原样走 markdown，不套卡片——一句话的答复套个卡片反而更重。
 */
export const FOLD_AFTER_LINES = 10
export const FOLD_AFTER_CHARS = 700
/** 过大的结果改走文档或完整普通消息，不在面板里截断正文。 */
const PANEL_MAX = 8000

/**
 * 折叠面板里的 `<at>` 到底通不通知被 @ 的人，飞书没有明确承诺——
 * 而「@ 了但人家没收到」比「消息长了点」坏得多，尤其我们刚立下
 * 「查得到才 @，@ 错人比不 @ 坏得多」这条规矩：@ 对了却石沉大海，等于没 @。
 *
 * 卡片正文里的 `<at>` 是通知得到的，有疑问的只是折叠面板里那一段。
 * 所以规则不是「有 @ 就不折」，而是**@ 必须留在露出来的那一段里**：
 * 切完之后如果有 @ 掉进了面板，这条就整条不折。
 */
export function hasMention(markdown: string): boolean {
  return /<at\b/i.test(markdown)
}

/**
 * 再长下去连折叠都不合适了：详情该有个**真正的去处**。
 *
 * 100 词硬上限之所以立得住，是因为测试、命令、实现细节全留在 PR 里。
 * 我们的折叠面板是个弱得多的版本——被折起来的东西大多数人根本不会点开，
 * 写在里面约等于没写。所以到这个长度就落一篇飞书文档：
 * 群里留结论 + 链接，想看细节的人点进去，不想看的人不用被刷屏。
 */
export const SPILL_AFTER_CHARS = 1800
/**
 * 行数阈值定得比字数松得多，是因为它们指向不同的东西：
 * 40 行短条目（"- 证据 12"）折起来一点就展开，看得很舒服，落成文档反而多一次跳转；
 * 真正需要文档的是**成篇的分析**，那种东西字数先爆。
 * 行数这条只用来兜住"上百行的清单"，不该替字数做决定。
 */
export const SPILL_AFTER_LINES = 80

export function shouldSpillToDoc(markdown: string): boolean {
  const t = markdown.trim()
  if (!t) return false
  return t.length > SPILL_AFTER_CHARS || t.split('\n').length > SPILL_AFTER_LINES
}

export function shouldFold(markdown: string): boolean {
  const t = markdown.trim()
  if (!t) return false
  if (t.length > PANEL_MAX) return false
  if (t.length <= FOLD_AFTER_CHARS && t.split('\n').length <= FOLD_AFTER_LINES) return false
  // @ 掉进折叠面板 → 宁可长，也不要 @ 了没通知到
  return !hasMention(splitLede(t).rest)
}

/** Keep a complete fenced block together, including blank lines inside it. */
function fencedBlockEnd(lines: string[], start: number): number | undefined {
  const opening = lines[start]?.trim().match(/^(`{3,}|~{3,})[^`~]*$/)?.[1]
  if (!opening) return undefined
  for (let i = start + 1; i < lines.length; i++) {
    const closing = lines[i]!.trim()
    if (closing.length >= opening.length && [...closing].every(char => char === opening[0])) return i + 1
  }
  return undefined
}

/**
 * 只把预算内的完整首段留在外面；没有安全段落边界时使用短标题，全文放面板。
 * 不按字符硬切链接、mention 或代码；代码开头的复杂内容直接保留全文。
 */
export function splitLede(markdown: string, maxLines = FOLD_AFTER_LINES): { lede: string; rest: string } {
  const text = markdown.trim()
  const lines = text.split('\n')
  if (lines.length <= maxLines && text.length <= FOLD_AFTER_CHARS) return { lede: text, rest: '' }
  for (let i = 1; i <= Math.min(maxLines, lines.length - 1); i += 1) {
    if (!lines[i]?.trim()) {
      const lede = lines.slice(0, i).join('\n').trim()
      // 段落边界仍可能在代码块或不完整 mention 内；不尝试修复/重写 Markdown。
      const withoutMentions = lede.replace(/<at\b[^>]*>[^<]*<\/at>/g, '')
      if (lede.length <= FOLD_AFTER_CHARS && !/```|~~~/.test(lede) && !hasMention(withoutMentions)) {
        // 第一段只是引子（以冒号结尾，例如「今天有这些：」）时，把紧跟的那一段一起留在外面：否则问「我今天有哪些待办」，
        // 外面只剩一句引子，清单全被折进去（2026-09-28 实机）。以句号结尾的结论照旧自成一段；长回答照样折叠。
        // 只有一行、后面直接就是清单或小标题的开场句同样算引子：问「你记得我哪些事」，外面只剩「以下都是我自己记的」
        // 一句、条目全在面板里（2026-09-28 实机），人得点开才知道到底记了什么。
        let j = i
        while (j < lines.length && !lines[j]?.trim()) j += 1
        const intro = /[:：]$/.test(lede) || (i === 1 && /^(?:[-*•]\s|\d+[.、]\s|\*\*|#{1,4}\s)/.test(lines[j]?.trim() ?? ''))
        if (intro) {
          let k = j
          while (k < lines.length && lines[k]?.trim()) k += 1
          const codeEnd = fencedBlockEnd(lines, j)
          if (codeEnd) k = codeEnd
          // 小标题只有一行时，把它带的那段清单也一起露出来
          if (k < lines.length && k === j + 1 && /^(?:\*\*|#{1,4}\s)/.test(lines[j]!.trim())) {
            let m = k
            while (m < lines.length && !lines[m]?.trim()) m += 1
            if (/^(?:[-*•]\s|\d+[.、]\s)/.test(lines[m]?.trim() ?? '')) {
              k = m
              while (k < lines.length && lines[k]?.trim()) k += 1
            }
          }
          const merged = lines.slice(0, k).join('\n').trim()
          const mergedPlain = merged.replace(/<at\b[^>]*>[^<]*<\/at>/g, '')
          if (k > j && k <= maxLines * 2 && merged.length <= FOLD_AFTER_CHARS * 2 &&
            (codeEnd || !/```|~~~/.test(merged)) && !hasMention(mergedPlain)) {
            const rest = lines.slice(k).join('\n').trim()
            return { lede: merged, rest }
          }
        }
        return { lede, rest: lines.slice(i).join('\n').trim() }
      }
      break
    }
  }
  return { lede: '回复较长，展开查看完整内容。', rest: text }
}

/** 长回答的折叠卡片。`rest` 为空时调用方就不该用它。 */
export function renderFoldedAnswer(input: { markdown: string; footer?: string }): Record<string, unknown> {
  const { lede, rest } = splitLede(input.markdown)
  const elements: Record<string, unknown>[] = [md(lede)]
  if (rest) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'markdown', content: '<font color="grey">展开详情</font>' },
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '14px 14px' },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '6px' },
      padding: '4px 8px 4px 8px',
      elements: [md(rest)],
    })
  }
  if (input.footer) elements.push(md(`<font color="grey">${escapeForCard(input.footer)}</font>`))
  return { schema: '2.0', config: { wide_screen_mode: true }, body: { elements } }
}

/**
 * 待办清单卡：真能打勾的那种。
 *
 * 以前记完待办只回一句「已记下 5 条（#2-#6）：发布清单、官网文案……」。
 * 那句话把五件事压成一行逗号分隔的文本——看不出哪条做完了，也没法在上面做任何动作，
 * 人还得再说一句「第二条做完了」才能改状态。一段纯文本不是清单，只是回执。
 *
 * 飞书自己的「任务」系统当然更好（那是原生的 ToDo 界面），但它要 `task:task` 权限，
 * 而且得把 Friday 的 todos 双向同步过去；在那之前，卡片里的 `checker` 就是能打勾的清单：
 * 勾上即完成、划掉标题，再点一次撤回。状态直接落在 todos 表里，不是卡片上的装饰。
 *
 * 只渲染这张卡负责的那几条，并把 id 写进回调值——卡片长期留在会话里，
 * 几天后有人回来点一下，那时的"第 2 条"早就不是同一条了，按序号回查是会点错人的活。
 */
export function renderTodoCard(input: TodoCardInput): Record<string, unknown> {
  return renderPagedTodoCard(input)
}
