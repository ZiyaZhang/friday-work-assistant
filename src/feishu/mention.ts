/**
 * 入站消息判定：有没有 @ 机器人、去掉 @ 后的正文、命令、线程键。
 */
import { normalizeMentions, parseContent, type MentionInfo } from './content.js'
import { extractAttachment, type HistoryMessage } from './client.js'

export type ChatType = 'group' | 'p2p'

export interface InboundMessage {
  /** Host-authenticated input surface. Websocket parsing never accepts this field from event data. */
  personalDevice?: { id: string; requestId: string }
  eventId: string
  tenantId?: string
  messageId: string
  chatId: string
  chatType: ChatType
  threadId?: string
  rootId?: string
  parentId?: string
  msgType: string
  /** 已把 @占位符换成名字的正文 */
  text: string
  senderOpenId?: string
  senderType: string
  mentions: MentionInfo[]
  createTimeMs: number
  fileKey?: string
  fileName?: string
  imageKey?: string
  /** 图文混排（post）里的全部图片 */
  imageKeys?: string[]
}

/** 入站事件 → 可缓存的历史消息（事件里没有发送者姓名，由调用方补）。 */
export function inboundToHistory(msg: InboundMessage, senderName: string): HistoryMessage {
  return {
    messageId: msg.messageId,
    tenantId: msg.tenantId,
    createTimeMs: msg.createTimeMs,
    msgType: msg.msgType,
    senderName,
    senderOpenId: msg.senderOpenId,
    senderType: msg.senderType,
    text: msg.text,
    mentions: structuredClone(msg.mentions),
    threadId: msg.threadId,
    rootId: msg.rootId,
    parentId: msg.parentId,
    fileKey: msg.fileKey,
    fileName: msg.fileName,
    imageKey: msg.imageKey,
    imageKeys: msg.imageKeys,
  }
}

/**
 * 命令面。两条原则：
 * 1. **命令是快捷方式，不是说明书**——每个命令背后的能力都能直接用人话触发
 *    （"整理成一页 wiki""出个周报""你怎么知道的"），模型会去调对应的工具。
 * 2. **可发现**：分组列在 /help 和私聊菜单里，输入 `/` 就能挑，不用背。
 * 前缀 `/` 和 `!` 等价；老名字（/restart /status /space /circle /routines）都保留为别名。
 */
export type FridayCommand =
  | 'help'
  | 'new'
  | 'tasks'
  | 'responsibilities'
  | 'groups'
  | 'settings'
  | 'stop'
  // 以下是隐藏别名 / 运维用，不在帮助里列
  | 'whoami'
  | 'memory'
  | 'forget'
  | 'routine'
  | 'proactive'
  | 'connect'
  | 'disconnect'
  | 'auth'
  | 'github'
  | 'report'
  | 'wiki'
  | 'pmo'
  | 'why'
  | 'handover'
  | 'circle'
  | 'selfcheck'

export interface CommandSpec {
  name: string
  command: FridayCommand
  desc: string
  /** 同一件事用人话怎么说——帮助里并排列出来，提醒人不必记命令 */
  saying?: string
}

/** 分组列在 /help 与私聊菜单里。每一条都配一句"人话怎么说"。 */
export const COMMAND_GROUPS: { title: string; items: CommandSpec[] }[] = [
  {
    title: '干活',
    items: [
      { name: '/tasks', command: 'tasks', desc: '在跟的事：逾期、要到期的、本周完成的', saying: '现在什么情况' },
      { name: '/report', command: 'report', desc: '把这些整理成一篇飞书周报文档', saying: '出个周报' },
      { name: '/wiki', command: 'wiki', desc: '把已确认的内容整理成一页会自己更新的 wiki', saying: '整理成一页 wiki' },
      { name: '/responsibilities', command: 'responsibilities', desc: '常驻职责与待处理的提案', saying: '你都在替我盯什么' },
    ],
  },
  {
    title: '这一轮',
    items: [
      { name: '/why', command: 'why', desc: '上一轮我读了哪几层、引用了什么、没取什么', saying: '你怎么知道的' },
      { name: '/new', command: 'new', desc: '开启新会话，之前的上下文不再带入', saying: '重新开一个话题' },
      { name: '/stop', command: 'stop', desc: '中止当前任务' },
    ],
  },
  {
    title: '设置',
    items: [
      { name: '/settings', command: 'settings', desc: '这个空间的配置：回答长度、主动模式、行为偏好', saying: '以后回答简短点 / 这个群攒一批再处理' },
      { name: '/groups', command: 'groups', desc: '相关的群：本空间、联盟、你在的空间', saying: '你能看到哪些群' },
      { name: '/memory', command: 'memory', desc: '分层记忆：看、确认、删、晋升', saying: '你都记住了什么' },
      { name: '/connect', command: 'connect', desc: '个人授权：之后我能用你的身份读你所在的群和文档' },
    ],
  },
  {
    title: '交接与看板',
    items: [
      { name: '/handover', command: 'handover', desc: '换人接手时的交接包（不含凭证）', saying: '做个交接包' },
      { name: '/pmo', command: 'pmo', desc: '本群独立看板；负责人绑定和同步', saying: '同步一下看板' },
      { name: '/whoami', command: 'whoami', desc: '我是谁、有什么权限' },
      { name: '/help', command: 'help', desc: '看这份帮助' },
    ],
  },
]

export const ALL_LISTED_COMMANDS: CommandSpec[] = COMMAND_GROUPS.flatMap((g) => g.items)

/** 主命令 + 别名（前缀 `/` 和 `!` 等价）。 */
const ALIASES: Record<string, FridayCommand> = {
  help: 'help',
  new: 'new',
  restart: 'new',
  tasks: 'tasks',
  status: 'tasks',
  responsibilities: 'responsibilities',
  routines: 'responsibilities',
  routine: 'routine',
  groups: 'groups',
  circle: 'circle',
  settings: 'settings',
  space: 'settings',
  stop: 'stop',
  whoami: 'whoami',
  memory: 'memory',
  forget: 'forget',
  proactive: 'proactive',
  connect: 'connect',
  disconnect: 'disconnect',
  auth: 'auth',
  github: 'github',
  report: 'report',
  wiki: 'wiki',
  pmo: 'pmo',
  why: 'why',
  handover: 'handover',
  selfcheck: 'selfcheck',
}

/**
 * 所有命令词（含别名）。给"不许把命令当答案"的那条检查当事实源用，
 * 免得它自己再抄一份、抄漏一个就漏检一个。
 */
export const COMMAND_WORDS: readonly string[] = Object.freeze(Object.keys(ALIASES))

/**
 * 命令用法说明。**只有对方刚刚自己敲了命令**（敲错了、少了参数）的时候才回这种话——
 * 那时候他显然知道有这个命令，照命令的写法回是最短的路。
 *
 * 其余任何场合都不许出现命令名：他多半不知道命令存在，甩一个 `/xxx` 给他就是把话堵死。
 * 那些地方要么给能点的卡片，要么说人话（"跟我说一声就行"）。
 * 这个包装本身不改字符串，它的作用是**把"这是用法说明"这件事写进代码里**，
 * 好让 test/commands-are-not-answers.test.ts 能把它和"拿命令当答案"分开。
 */
export function usage(text: string): string {
  return text
}

/**
 * 命令面自己的说明文字（帮助卡、欢迎卡里折叠着的"也可以用命令"）。
 *
 * 这是唯一一类"主动提命令"还算合理的地方：它就是那份清单，而且默认折叠、措辞是"也可以"。
 * 除此之外任何地方提到命令，都是把我们该做的事推给了用户。
 */
export function commandMenu(text: string): string {
  return text
}

/**
 * 命令前缀两种都认，但**对外只写 \`/xxx\`**：飞书里斜杠是原生的命令写法，
 * 感叹号看着像在喊人。\`!\` 保留只是为了不把已经习惯它的人挡在外面。
 */
export function parseCommand(body: string): FridayCommand | undefined {
  const first = body.trim().split(/\s+/)[0]?.toLowerCase()
  if (!first || (first[0] !== '/' && first[0] !== '!')) return undefined
  return ALIASES[first.slice(1)]
}

export interface ParsedMention {
  /** 是否 @ 了机器人 */
  mentioned: boolean
  /** 去掉 @机器人 之后的正文（保留对其他人的 @） */
  body: string
  command?: FridayCommand
}

/**
 * 判断消息是否 @ 了机器人：优先比 open_id，其次比名字（open_id 拿不到时的兜底）。
 * 正文里对应的占位符（如 `@_user_1`）会被去掉。
 */
export function parseMention(msg: InboundMessage, bot: { openId?: string; name: string }, rawText?: string): ParsedMention {
  const botMentions = msg.mentions.filter((m) => (bot.openId && m.openId === bot.openId) || (!bot.openId && m.name === bot.name))
  const mentioned = botMentions.length > 0
  let body = rawText ?? msg.text
  for (const m of botMentions) {
    if (m.key) body = body.split(m.key).join('')
    body = body.split(`@${m.name}`).join('')
  }
  body = body.replace(/[ \t ]+/g, ' ').replace(/^\s+|\s+$/g, '')
  const command = parseCommand(body)
  return { mentioned, body, command }
}

/**
 * 线程键候选，按优先级：话题 thread_id → 回复链 root_id → 消息自身 id。
 * 注册表用这些候选做别名查找（我们自己 reply_in_thread 后拿到的 thread_id 也会登记为别名）。
 */
export function threadKeyCandidates(msg: InboundMessage): string[] {
  const out: string[] = []
  if (msg.threadId) out.push(`thread:${msg.threadId}`)
  if (msg.rootId) out.push(`msg:${msg.rootId}`)
  if (msg.parentId) out.push(`msg:${msg.parentId}`)
  out.push(`msg:${msg.messageId}`)
  return out
}

export function canonicalThreadKey(msg: InboundMessage): string {
  return `msg:${msg.messageId}`
}

export function dmThreadKey(openId: string): string {
  return `dm:${openId}`
}

/** 从 `im.message.receive_v1` 事件 data 构造 InboundMessage。 */
export function inboundFromEvent(data: Record<string, unknown>): InboundMessage {
  const message = (data.message ?? {}) as Record<string, unknown>
  const sender = (data.sender ?? {}) as Record<string, unknown>
  const senderId = (sender.sender_id ?? {}) as Record<string, unknown>
  const mentions = normalizeMentions(message.mentions)
  const msgType = String(message.message_type ?? 'text')
  const content = String(message.content ?? '')
  const createTime = Number(message.create_time ?? Date.now())
  return {
    eventId: String(data.event_id ?? message.message_id ?? ''),
    tenantId: typeof sender.tenant_key === 'string' ? sender.tenant_key : undefined,
    messageId: String(message.message_id ?? ''),
    chatId: String(message.chat_id ?? ''),
    chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
    threadId: typeof message.thread_id === 'string' && message.thread_id ? message.thread_id : undefined,
    rootId: typeof message.root_id === 'string' && message.root_id ? message.root_id : undefined,
    parentId: typeof message.parent_id === 'string' && message.parent_id ? message.parent_id : undefined,
    msgType,
    text: parseContent(msgType, content, mentions),
    senderOpenId: typeof senderId.open_id === 'string' ? senderId.open_id : undefined,
    senderType: String(sender.sender_type ?? 'user'),
    mentions,
    createTimeMs: createTime > 1e12 ? createTime : createTime * 1000,
    ...extractAttachment(msgType, content),
  }
}

/**
 * 「这句话是不是只是打了个招呼」。
 *
 * 用在**刚被拉进群的第一条 @** 上：那一条如果只是「在吗」「来了」，
 * 回一张欢迎卡就够了；但如果人家上来就问正事，把它当寒暄吞掉比多回一张卡糟得多——
 * 人会以为我坏了，然后把同一句话再打一遍。
 *
 * 判定故意保守：**整条**都得是招呼语才算，沾一点实质内容就当正事。
 * 宁可把「你好」当活儿干（最多多回一句），也不要把「帮我看下线上挂了」当寒暄。
 */
const SMALL_TALK = new Set([
  '在吗', '在么', '在不在', '在', '你好', '您好', '哈喽', '嗨', '早', '早上好', '下午好', '晚上好',
  '来了', '来了吗', '到了吗', '欢迎', '请多关照', '以后靠你了', '辛苦了', '谢谢', '试试', '测试', '测一下',
  'hi', 'hello', 'hey', 'yo', 'test', 'testing', 'ping', 'hi there', 'good morning',
])

export function isSmallTalk(body: string): boolean {
  const s = body
    .replace(/[\s]+/g, ' ')
    .replace(/[。，,.!！?？~～、：:；;\-—…]+/g, ' ')
    .trim()
    .toLowerCase()
  if (!s) return true
  if (s.length > 12) return false
  // 「你好呀」「在吗在吗」这类叠词/语气词，去掉尾巴再比一次
  const bare = s.replace(/[呀啊哈呢吧嘛哟喔噢~ ]+$/g, '').trim()
  return SMALL_TALK.has(s) || SMALL_TALK.has(bare)
}
