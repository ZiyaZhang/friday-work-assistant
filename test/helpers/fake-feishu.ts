/**
 * 假飞书客户端：记录所有出站调用，返回可配置的历史/文档。
 */
import { writeFileSync } from 'node:fs'
import { FeishuApiError, type AsUser, type ChatInfo, type FeishuClient, type HistoryMessage, type HistoryPage } from '../../src/feishu/client.js'
import type { TokenExchange } from '../../src/feishu/oauth.js'

export interface SentRecord {
  kind: 'replyCard' | 'replyText' | 'replyMarkdown' | 'patchCard' | 'sendToUser' | 'sendToChat' | 'replyFile' | 'sendFileToUser' | 'sendFileToChat'
  target: string
  payload: unknown
  replyInThread?: boolean
  messageId: string
}

export class FakeFeishu {
  readonly sent: SentRecord[] = []
  threads = new Map<string, HistoryMessage[]>()
  /** 不区分群的历史（旧测试用）；histories 里有该群时优先 */
  chatHistory: HistoryMessage[] = []
  histories = new Map<string, HistoryMessage[]>()
  docs = new Map<string, { title?: string; content: string; objType: string }>()
  messages = new Map<string, HistoryMessage>()
  chats: ChatInfo[] = []
  members = new Map<string, Set<string>>()
  names = new Map<string, string>()
  downloads: { messageId: string; fileKey: string; type: string; dest: string }[] = []
  botOpen = 'ou_bot'
  /** 统计 API 调用次数，用来验证缓存生效 */
  calls: { listChatHistory: number; userName: number; listChats: number; chatMemberOpenIds: number; searchMessageIds?: number } = { listChatHistory: 0, userName: 0, listChats: 0, chatMemberOpenIds: 0 }
  private counter = 0
  /** 每次 replyCard 分配的 thread_id（模拟 reply_in_thread 创建话题） */
  threadIdForReply?: string

  private nextId(prefix: string): string {
    this.counter += 1
    return `${prefix}_${this.counter}`
  }

  async botOpenId(): Promise<string> {
    return this.botOpen
  }
  async replyCard(messageId: string, card: Record<string, unknown>, replyInThread = true): Promise<{ messageId: string; threadId?: string }> {
    const id = this.nextId('om_card')
    this.sent.push({ kind: 'replyCard', target: messageId, payload: card, replyInThread, messageId: id })
    return { messageId: id, threadId: replyInThread ? this.threadIdForReply : undefined }
  }
  async replyText(messageId: string, text: string, replyInThread = true): Promise<{ messageId: string; threadId?: string }> {
    const id = this.nextId('om_text')
    this.sent.push({ kind: 'replyText', target: messageId, payload: text, replyInThread, messageId: id })
    return { messageId: id, threadId: replyInThread ? this.threadIdForReply : undefined }
  }
  async replyMarkdown(messageId: string, markdown: string, replyInThread = true): Promise<{ messageId: string; threadId?: string }> {
    const id = this.nextId('om_post')
    this.sent.push({ kind: 'replyMarkdown', target: messageId, payload: markdown, replyInThread, messageId: id })
    return { messageId: id, threadId: replyInThread ? this.threadIdForReply : undefined }
  }
  async patchCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    this.sent.push({ kind: 'patchCard', target: messageId, payload: card, messageId })
  }
  /** 表情：按消息记录当前还挂着的表情，以及完整的增删轨迹 */
  reactions = new Map<string, { id: string; emoji: string }[]>()
  reactionLog: { op: 'add' | 'remove'; messageId: string; emoji?: string; id: string }[] = []
  failReactions = false
  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    if (this.failReactions) throw new FeishuApiError('message.reaction.create', 99991663, 'no permission')
    const id = this.nextId('rx')
    const list = this.reactions.get(messageId) ?? []
    list.push({ id, emoji: emojiType })
    this.reactions.set(messageId, list)
    this.reactionLog.push({ op: 'add', messageId, emoji: emojiType, id })
    return id
  }
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    const list = (this.reactions.get(messageId) ?? []).filter((r) => r.id !== reactionId)
    this.reactions.set(messageId, list)
    this.reactionLog.push({ op: 'remove', messageId, id: reactionId })
  }
  /** 某条消息上现在挂着的表情名 */
  reactionsOn(messageId: string): string[] {
    return (this.reactions.get(messageId) ?? []).map((r) => r.emoji)
  }
  async sendToUser(openId: string, payload: { text: string } | { markdown: string } | { card: Record<string, unknown> }): Promise<string> {
    const id = this.nextId('om_dm')
    this.sent.push({ kind: 'sendToUser', target: openId, payload, messageId: id })
    return id
  }
  /** 撤回自己发的消息：从 sent 里抹掉，并记一笔 recalled。 */
  recalled: string[] = []
  async recallMessage(messageId: string): Promise<boolean> {
    const i = this.sent.findIndex((s) => s.messageId === messageId)
    if (i < 0) return false
    this.sent.splice(i, 1)
    this.recalled.push(messageId)
    return true
  }

  async sendToChat(chatId: string, payload: { text: string } | { markdown: string } | { card: Record<string, unknown> }): Promise<string> {
    const id = this.nextId('om_chat')
    this.sent.push({ kind: 'sendToChat', target: chatId, payload, messageId: id })
    return id
  }
  /** 发出去的普通回答（群里 replyMarkdown / 私聊 sendToChat({markdown})）的正文 */
  answers(): string[] {
    const out: string[] = []
    for (const s of this.sent) {
      if (s.kind === 'replyMarkdown') out.push(String(s.payload))
      else if ((s.kind === 'sendToChat' || s.kind === 'sendToUser') && s.payload && typeof s.payload === 'object' && 'markdown' in s.payload) out.push(String((s.payload as { markdown: string }).markdown))
    }
    return out
  }
  /** 文件上传/发送 */
  uploads: { path: string | Buffer; name: string }[] = []
  async uploadFile(filePath: string | Buffer, fileName: string): Promise<string> {
    this.uploads.push({ path: filePath, name: fileName })
    return `file_v${this.uploads.length}`
  }
  async replyFile(messageId: string, fileKey: string, replyInThread = false): Promise<string> {
    const id = this.nextId('om_file')
    this.sent.push({ kind: 'replyFile', target: messageId, payload: fileKey, replyInThread, messageId: id })
    return id
  }
  async sendFileToUser(openId: string, fileKey: string): Promise<string> {
    const id = this.nextId('om_file')
    this.sent.push({ kind: 'sendFileToUser', target: openId, payload: fileKey, messageId: id })
    return id
  }
  async sendFileToChat(chatId: string, fileKey: string): Promise<string> {
    const id = this.nextId('om_file')
    this.sent.push({ kind: 'sendFileToChat', target: chatId, payload: fileKey, messageId: id })
    return id
  }
  /** 个人授权：用户身份可见的群、单聊消息；以及 OAuth 换 token 的假实现 */
  userChats = new Map<string, ChatInfo[]>()
  userHistories = new Map<string, HistoryMessage[]>()
  searchHits: string[] = []
  identities = new Map<string, { openId: string; name: string; tenantKey?: string }>()
  exchanges: { code: string; redirectUri: string }[] = []
  refreshes = 0
  nextToken: TokenExchange = { accessToken: 'uat-1', expiresIn: 7200, refreshToken: 'rt-1', refreshTokenExpiresIn: 30 * 86400, scope: 'im:chat:readonly' }
  async exchangeCode(code: string, redirectUri: string): Promise<TokenExchange> {
    this.exchanges.push({ code, redirectUri })
    if (code === 'bad') throw new FeishuApiError('oauth.token', 20003, 'invalid code')
    return this.nextToken
  }
  async refresh(refreshToken: string): Promise<TokenExchange> {
    this.refreshes += 1
    if (refreshToken === 'expired') throw new FeishuApiError('oauth.token', 20004, 'refresh expired')
    return { ...this.nextToken, accessToken: `${this.nextToken.accessToken}-refreshed` }
  }
  async whoAmI(userToken: string): Promise<{ openId?: string; name?: string; tenantKey?: string }> {
    return this.identities.get(userToken) ?? {}
  }
  async searchMessageIds(userToken: string): Promise<string[]> {
    this.calls.searchMessageIds = (this.calls.searchMessageIds ?? 0) + 1
    return userToken ? this.searchHits : []
  }
  /** 按人 / 单聊找消息（im.message.search）：记录查询条件，命中由 `findHits` 给出（默认与 searchHits 相同，chat_id 取自 messages）。 */
  findQueries: { query?: string; senderOpenIds?: string[]; chatType?: 'group' | 'p2p' }[] = []
  findHits?: { messageId: string; chatId?: string; fromId?: string; isP2p?: boolean }[]
  async findMessagesAsUser(userToken: string, q: { query?: string; senderOpenIds?: string[]; chatType?: 'group' | 'p2p' }) {
    this.findQueries.push({ query: q.query, senderOpenIds: q.senderOpenIds, chatType: q.chatType })
    if (!userToken) return []
    return this.findHits ?? this.searchHits.map(messageId => ({ messageId, chatId: this.messages.get(messageId)?.chatId }))
  }
  async getMessage(messageId: string, as: AsUser = {}): Promise<HistoryMessage | undefined> {
    void as
    return this.messages.get(messageId)
  }
  /** 合并转发展开：key 是转发卡的 message_id，value 是里面的子消息 */
  forwarded = new Map<string, HistoryMessage[]>()
  async getMessageItems(messageId: string, as: AsUser = {}): Promise<HistoryMessage[]> {
    void as
    const self = this.messages.get(messageId)
    const inner = this.forwarded.get(messageId) ?? []
    return [...(self ? [self] : []), ...inner]
  }
  async listThread(threadId: string, limit = 500): Promise<HistoryMessage[]> {
    return (this.threads.get(threadId) ?? []).slice(0, limit)
  }
  async listChatHistory(chatId: string, startSec: number, endSec: number, limit = 500, _windowSec?: number, as: AsUser = {}): Promise<HistoryPage> {
    this.calls.listChatHistory += 1
    const source = (as.userToken ? this.userHistories.get(chatId) : undefined) ?? this.histories.get(chatId) ?? this.chatHistory
    const items = source
      .filter((m) => m.createTimeMs >= startSec * 1000 && m.createTimeMs < endSec * 1000)
      .sort((a, b) => a.createTimeMs - b.createTimeMs)
    const page = items.slice(0, limit)
    const hasMore = items.length > limit
    return { items: page, hasMore, nextStartTimeSec: hasMore ? Math.floor((items[limit] as HistoryMessage).createTimeMs / 1000) : undefined, windowsScanned: 1 }
  }
  chatOwners = new Map<string, string>()
  chatManagers = new Map<string, string[]>()
  async chatInfo(chatId: string): Promise<{ name: string; ownerId?: string; managerIds: string[] }> {
    return { name: await this.chatName(chatId), ownerId: this.chatOwners.get(chatId), managerIds: this.chatManagers.get(chatId) ?? [] }
  }
  async chatName(chatId: string): Promise<string> {
    return this.chats.find((c) => c.chatId === chatId)?.name ?? `群-${chatId}`
  }
  async listChats(as: AsUser = {}): Promise<ChatInfo[]> {
    this.calls.listChats += 1
    if (as.userToken) return this.userChats.get(as.userToken) ?? []
    return this.chats
  }
  async listChatsResult(as: AsUser = {}): Promise<{ items: ChatInfo[]; complete: boolean }> {
    return { items: await this.listChats(as), complete: true }
  }
  async chatMemberOpenIds(chatId: string): Promise<Set<string>> {
    this.calls.chatMemberOpenIds += 1
    return this.members.get(chatId) ?? new Set()
  }
  rememberName(openId: string, name: string): void {
    this.names.set(openId, name)
  }
  async userName(openId: string): Promise<string> {
    this.calls.userName += 1
    return this.names.get(openId) ?? `用户(${openId.slice(-6)})`
  }
  async downloadMessageResource(messageId: string, fileKey: string, type: 'file' | 'image', destPath: string): Promise<void> {
    this.downloads.push({ messageId, fileKey, type, dest: destPath })
    writeFileSync(destPath, `fake content of ${fileKey}`)
  }
  events: { eventId: string; summary: string; startMs: number; endMs: number; allDay: boolean; location?: string; organizer?: string; meetingUrl?: string; rsvp?: string }[] = []
  async listMyEvents(as: AsUser, range: { startSec: number; endSec: number }): Promise<typeof this.events> {
    if (!as.userToken) throw new FeishuApiError('calendar.primary', -1, '需要个人授权')
    return this.events.filter((e) => e.startMs < range.endSec * 1000 && e.endMs > range.startSec * 1000)
  }
  createdDocs: { title: string; markdown: string; asUser: boolean; documentId: string }[] = []
  grants: { documentId: string; member: { openId?: string; chatId?: string }; perm: string; type: string }[] = []
  failDocCreate = false
  async createDocument(input: { title: string; markdown: string }, as: AsUser = {}): Promise<{ documentId: string; url: string; blocks: number }> {
    if (this.failDocCreate) throw new FeishuApiError('docx.create', 99991672, 'permission denied')
    const documentId = `doxcn${this.createdDocs.length + 1}`
    this.createdDocs.push({ title: input.title, markdown: input.markdown, asUser: Boolean(as.userToken), documentId })
    return { documentId, url: `https://test.feishu.cn/docx/${documentId}`, blocks: input.markdown.split('\n').filter(Boolean).length }
  }
  rewrittenDocs: { documentId: string; markdown: string }[] = []
  async rewriteDocument(documentId: string, markdown: string): Promise<{ documentId: string; url: string; blocks: number }> {
    const doc = this.createdDocs.find((d) => d.documentId === documentId)
    if (!doc) throw new FeishuApiError('docx.blocks.children.get', 1770002, 'not found')
    doc.markdown = markdown
    this.rewrittenDocs.push({ documentId, markdown })
    return { documentId, url: `https://test.feishu.cn/docx/${documentId}`, blocks: markdown.split('\n').filter(Boolean).length }
  }
  async grantDocAccess(documentId: string, member: { openId?: string; chatId?: string }, perm: 'view' | 'edit' | 'full_access' = 'edit', _as: AsUser = {}, type: 'docx' | 'bitable' = 'docx'): Promise<void> {
    this.grants.push({ documentId, member, perm, type })
  }
  userDocs = new Map<string, { title?: string; content: string; objType: string }>()
  async readDocument(ref: { kind: 'docx' | 'wiki'; token: string }, as: AsUser = {}): Promise<{ title?: string; content: string; objType: string }> {
    const d = (as.userToken ? this.userDocs.get(ref.token) : undefined) ?? this.docs.get(ref.token)
    if (!d) throw new FeishuApiError('docx.rawContent', 99991672, 'permission denied')
    return d
  }

  /** 按类型筛选发出的记录 */
  of(kind: SentRecord['kind']): SentRecord[] {
    return this.sent.filter((s) => s.kind === kind)
  }
  lastCard(): Record<string, unknown> | undefined {
    const patches = this.of('patchCard')
    const last = patches[patches.length - 1] ?? this.of('replyCard')[0]
    return last?.payload as Record<string, unknown> | undefined
  }
}

export function asFeishuClient(fake: FakeFeishu): FeishuClient {
  return fake as unknown as FeishuClient
}

/** 把卡片里所有能读到的文字拼起来（标题、正文、折叠面板及其标题、列内元素）。 */
export function cardText(card: Record<string, unknown> | undefined): string {
  if (!card) return ''
  const body = card.body as { elements?: unknown[] } | undefined
  const header = card.header as { title?: { content?: string } } | undefined
  const parts = [header?.title?.content ?? '']
  const walk = (el: unknown): void => {
    if (!el || typeof el !== 'object') return
    const o = el as Record<string, unknown>
    if (typeof o.content === 'string') parts.push(o.content)
    const title = (o.header as { title?: { content?: string } } | undefined)?.title?.content
    if (typeof title === 'string') parts.push(title)
    for (const key of ['elements', 'columns']) if (Array.isArray(o[key])) for (const child of o[key] as unknown[]) walk(child)
  }
  for (const el of body?.elements ?? []) walk(el)
  return parts.join('\n')
}

export function historyMsg(partial: Partial<HistoryMessage> & { text: string }): HistoryMessage {
  return {
    tenantId: partial.tenantId,
    messageId: partial.messageId ?? `om_${Math.random().toString(36).slice(2, 10)}`,
    createTimeMs: partial.createTimeMs ?? Date.now(),
    msgType: partial.msgType ?? 'text',
    senderName: partial.senderName ?? '同事',
    senderOpenId: partial.senderOpenId,
    senderType: partial.senderType ?? 'user',
    text: partial.text,
    mentions: partial.mentions,
    threadId: partial.threadId,
    rootId: partial.rootId,
    parentId: partial.parentId,
    fileKey: partial.fileKey,
    fileName: partial.fileName,
    imageKey: partial.imageKey,
    imageKeys: partial.imageKeys,
    chatId: partial.chatId,
  }
}
