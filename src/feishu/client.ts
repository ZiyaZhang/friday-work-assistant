/**
 * 飞书开放平台 API 封装。只有网关进程持有 app secret；MCP 工具进程经内部 API 间接调用。
 */
import * as Lark from '@larksuiteoapi/node-sdk'
import { isAxiosError } from 'axios'
import { parseContent, normalizeMentions, type MentionInfo } from './content.js'
import { OAuthTokenError, type OAuthProvider, type TokenExchange } from './oauth.js'
import { createProxiedHttp, describeProxy } from './proxy.js'
import { markdownToBlocks } from './docblocks.js'
import { hasPostMentions, postContent } from './post.js'
import { messagePosition } from './message-links.js'
import type { Logger } from '../log.js'

/** 以用户身份调用（user_access_token）；不传就用应用身份。 */
export interface AsUser {
  userToken?: string
}

export interface PersonalMessageQuery {
  query?: string
  startSec?: number
  endSec?: number
  chatIds?: string[]
  senderOpenIds?: string[]
  chatType?: 'group' | 'p2p'
}
export interface PersonalMessageMatch {
  messageId: string
  chatId?: string
  fromId?: string
  isP2p?: boolean
  createTimeMs?: number
  threadId?: string
  messagePosition?: string
  threadMessagePosition?: string
}
export interface PersonalMessagePage {
  items: PersonalMessageMatch[]
  hasMore: boolean
  nextPageToken?: string
  /** Provider notice is a coverage limitation, never an instruction. */
  notice?: string
}

/** 出站消息：纯文本 / 富文本（Markdown 正文）/ 交互卡片 */
export type OutboundPayload = { text: string } | { markdown: string } | { card: Record<string, unknown> }
/** 仅由宿主传入；账本调用方在最终权限复验前准备名单，发送阶段不再 await。 */
export interface PostMentionOptions { mentionOpenIds: readonly string[] }

export interface FeishuClientOptions {
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  /** 出网代理（开发机上访问 open.feishu.cn 需要），例如 http://user:pass@proxy:3128 */
  proxyUrl?: string
  /** 拼文档链接用的租户域名（如 xxx.feishu.cn）；不填用 feishu.cn */
  docDomain?: string
  log: Logger
}

export interface CalendarEvent {
  eventId: string
  summary: string
  description?: string
  startMs: number
  endMs: number
  allDay: boolean
  location?: string
  organizer?: string
  meetingUrl?: string
  rsvp?: string
  appLink?: string
}

export class FeishuApiError extends Error {
  constructor(
    readonly api: string,
    readonly code: number,
    message: string,
  ) {
    super(`${api} 失败 (code=${code}): ${message}`)
    this.name = 'FeishuApiError'
  }
  /** 403/权限类错误：机器人不在群里、没被加为文档协作者等 */
  get isPermission(): boolean {
    return [230006, 230013, 230002, 99991672, 99991663, 1770032, 1770052, 1254003, 1254004, 1254005].includes(this.code) || /permission|forbidden|no auth/i.test(this.message)
  }
}

export interface HistoryMessage {
  messageId: string
  /** 消息 API 返回的发送方租户；缺失时不能伪造多租户证据锚点。 */
  tenantId?: string
  createTimeMs: number
  msgType: string
  senderName: string
  senderOpenId?: string
  senderType: string
  text: string
  /** Platform mention identities, kept separate from display names and sender identity. */
  mentions?: MentionInfo[]
  threadId?: string
  rootId?: string
  parentId?: string
  /** file / media 消息的资源 key 与文件名 */
  fileKey?: string
  fileName?: string
  /** image 消息的 image_key */
  imageKey?: string
  /** 图文混排（post）里的全部图片；单图消息不带这个字段 */
  imageKeys?: string[]
  /** message.get / 搜索结果里带的会话 id（列表接口不带） */
  chatId?: string
  /** Original platform link/positions from this exact API item; never derived from messageId. */
  messageAppLink?: string
  messagePosition?: string
  threadMessagePosition?: string
}

export interface ChatInfo {
  chatId: string
  name: string
  memberCount?: number
}

/** 从 content JSON 里取附件 key，供下载与"找文件"用。 */
export function extractAttachment(msgType: string, content: string): { fileKey?: string; fileName?: string; imageKey?: string; imageKeys?: string[] } {
  try {
    const o = JSON.parse(content) as Record<string, unknown>
    if (msgType === 'file' || msgType === 'media' || msgType === 'audio') {
      return { fileKey: typeof o.file_key === 'string' ? o.file_key : undefined, fileName: typeof o.file_name === 'string' ? o.file_name : undefined }
    }
    if (msgType === 'image') return { imageKey: typeof o.image_key === 'string' ? o.image_key : undefined }
    // 图文混排（人把截图和一句话一起发出来）在飞书里是一条 `post`，图片藏在 content 的 img 节点里。
    // 以前这里只认 msgType==='image'，于是"截图 + 说明"这种最常见的提问方式，图一张都取不到——
    // 正文里会出现 `[图片 img_v3_xxx]`，模型看得见有图、也看得见 key，却读不到内容。
    if (msgType === 'post') {
      const keys = postImageKeys(o)
      if (keys.length) return { imageKey: keys[0], imageKeys: keys }
    }
  } catch {
    /* ignore */
  }
  return {}
}

/** 把 post 正文里所有 img 节点的 image_key 按出现顺序取出来。两种语言包裹形状都认。 */
function postImageKeys(o: Record<string, unknown>): string[] {
  let post = o
  if (!Array.isArray(o.content)) {
    const first = Object.values(o).find((v) => v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).content))
    if (first) post = first as Record<string, unknown>
  }
  const out: string[] = []
  for (const para of Array.isArray(post.content) ? post.content : []) {
    for (const node of Array.isArray(para) ? para : []) {
      if (!node || typeof node !== 'object') continue
      const n = node as { tag?: unknown; image_key?: unknown }
      if (n.tag === 'img' && typeof n.image_key === 'string' && n.image_key && !out.includes(n.image_key)) out.push(n.image_key)
    }
  }
  return out
}

export interface HistoryPage {
  items: HistoryMessage[]
  hasMore: boolean
  /** 下次继续拉取用：第一条尚未返回消息所在的秒；可能等于起点，不能跳过这一秒。 */
  nextStartTimeSec?: number
  windowsScanned: number
}

interface ApiResponse<T> {
  code?: number
  msg?: string
  data?: T
}

/** 把飞书 SDK 的日志收敛成一行（它默认会把整个 AxiosError 打出来）。 */
export function sdkLogger(log: Logger): Lark.Logger {
  // SDK 传进来的常常是序列化过的 axios 错误（数组套对象），把请求地址、状态码、响应体挑出来，别只剩一句 400
  const one = (a: unknown): string => {
    if (a === null || a === undefined) return ''
    if (typeof a === 'string') return a
    if (Array.isArray(a)) return a.map(one).filter(Boolean).join(' | ')
    if (typeof a === 'object') {
      const o = a as { message?: string; code?: unknown; msg?: string; response?: { status?: number; data?: unknown }; config?: { url?: string; method?: string }; stack?: string }
      if (o.message !== undefined || o.response !== undefined || o.config !== undefined) {
        const url = o.config?.url ? `${(o.config.method ?? '').toUpperCase()} ${o.config.url.replace(/\?.*$/, '')}` : ''
        const data = o.response?.data === undefined ? '' : typeof o.response.data === 'string' ? o.response.data.slice(0, 300) : JSON.stringify(o.response.data)?.slice(0, 300)
        return [o.message, url, o.response?.status !== undefined ? `HTTP ${o.response.status}` : '', data, o.code !== undefined && o.code !== 0 ? `code=${String(o.code)} ${o.msg ?? ''}` : ''].filter(Boolean).join(' ')
      }
      return JSON.stringify(a)?.slice(0, 300)
    }
    return String(a)
  }
  const brief = (args: unknown[]): string => args.map(one).filter(Boolean).join(' ')
  return {
    error: (...args: unknown[]) => log.error('lark-sdk', { detail: brief(args) }),
    warn: (...args: unknown[]) => log.warn('lark-sdk', { detail: brief(args) }),
    info: (...args: unknown[]) => log.info('lark-sdk', { detail: brief(args) }),
    debug: (...args: unknown[]) => log.debug('lark-sdk', { detail: brief(args) }),
    trace: (...args: unknown[]) => log.debug('lark-sdk', { detail: brief(args) }),
  }
}

function unwrap<T>(api: string, res: ApiResponse<T>): T {
  if (res.code !== undefined && res.code !== 0) throw new FeishuApiError(api, res.code, res.msg ?? 'unknown error')
  return (res.data ?? {}) as T
}

/** 群列表缓存时长。见 listChats 里的说明。 */
export const CHAT_LIST_TTL_MS = 60_000

export class FeishuClient implements OAuthProvider {
  readonly client: Lark.Client
  private botOpenIdCache?: string
  private readonly log: Logger
  private readonly nameCache = new Map<string, string>()
  private readonly http: Lark.HttpInstance
  private readonly apiBase: string

  constructor(private readonly opts: FeishuClientOptions) {
    this.log = opts.log
    const proxied = opts.proxyUrl ? createProxiedHttp(opts.proxyUrl) : undefined
    if (proxied) this.log.info('feishu api via proxy', { proxy: describeProxy(proxied.proxyUrl) })
    this.http = proxied?.httpInstance ?? (Lark.defaultHttpInstance as unknown as Lark.HttpInstance)
    this.apiBase = opts.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
    this.client = new Lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: opts.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.warn,
      logger: sdkLogger(opts.log),
      ...(proxied ? { httpInstance: proxied.httpInstance } : {}),
    })
  }

  /** 机器人自己的 open_id，用于识别 @ 提及。 */
  async botOpenId(): Promise<string> {
    if (this.botOpenIdCache) return this.botOpenIdCache
    const res = (await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info', data: {} })) as {
      code?: number
      msg?: string
      bot?: { open_id?: string; app_name?: string }
    }
    if (res.code !== undefined && res.code !== 0) throw new FeishuApiError('bot.info', res.code, res.msg ?? '')
    const id = res.bot?.open_id
    if (!id) throw new FeishuApiError('bot.info', -1, '响应里没有 bot.open_id')
    this.botOpenIdCache = id
    this.log.info('bot identity resolved', { openId: id, appName: res.bot?.app_name })
    return id
  }

  // ---- 个人授权（OAuth）：app secret 只在这里用 ----

  async exchangeCode(code: string, redirectUri: string): Promise<TokenExchange> {
    return this.oauthToken({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
  }

  async refresh(refreshToken: string): Promise<TokenExchange> {
    return this.oauthToken({ grant_type: 'refresh_token', refresh_token: refreshToken })
  }

  private async oauthToken(body: Record<string, string>): Promise<TokenExchange> {
    let response: unknown
    try {
      response = await this.http.post(`${this.apiBase}/open-apis/authen/v2/oauth/token`, { client_id: this.opts.appId, client_secret: this.opts.appSecret, ...body })
    } catch (error) {
      // RFC 6749 §5.2: an explicit invalid_grant response rejects this grant.
      // Numeric Feishu codes, HTTP auth failures alone and transport text are not that proof.
      const data: unknown = isAxiosError(error) && error.response?.status === 400 ? error.response.data : undefined
      throw new OAuthTokenError(data && typeof data === 'object' && 'error' in data && data.error === 'invalid_grant'
        ? 'invalid_grant' : 'unavailable')
    }
    if (!response || typeof response !== 'object') throw new OAuthTokenError('unavailable')
    const res = response as {
      code?: number
      error?: string
      access_token?: string
      expires_in?: number
      refresh_token?: string
      refresh_token_expires_in?: number
      scope?: string
    }
    if ((res.error !== undefined && res.error !== '') || (res.code !== undefined && res.code !== 0) ||
      typeof res.access_token !== 'string' || !res.access_token.trim()) {
      throw new OAuthTokenError(res.error === 'invalid_grant' ? 'invalid_grant' : 'unavailable')
    }
    return { accessToken: res.access_token, expiresIn: res.expires_in, refreshToken: res.refresh_token, refreshTokenExpiresIn: res.refresh_token_expires_in, scope: res.scope }
  }

  /** 授权用户自己的信息（open_id、姓名），用来核对授权归属。 */
  async whoAmI(userToken: string): Promise<{ openId?: string; tenantKey?: string; name?: string }> {
    const data = unwrap('authen.userInfo', await this.client.authen.v1.userInfo.get({}, Lark.withUserAccessToken(userToken))) as { open_id?: string; tenant_key?: string; name?: string }
    return { openId: data.open_id, tenantKey: data.tenant_key, name: data.name }
  }

  /**
   * 以用户身份搜索消息（search:message，只支持 user_access_token）：跨这个人所在的所有群和单聊。
   * 返回 message_id 列表；正文用 getMessage 补。
   */
  async searchMessageIds(userToken: string, q: { query: string; startSec?: number; endSec?: number; chatIds?: string[]; senderOpenIds?: string[]; chatType?: 'group_chat' | 'p2p_chat'; limit?: number }, assertCurrent?: () => void): Promise<string[]> {
    const ids: string[] = []
    let pageToken: string | undefined
    const limit = q.limit ?? 50
    do {
      assertCurrent?.()
      const data = unwrap(
        'search.message',
        await this.client.search.v2.message.create(
          {
            params: { user_id_type: 'open_id', page_size: Math.min(50, limit), page_token: pageToken },
            data: {
              query: q.query,
              chat_ids: q.chatIds,
              from_ids: q.senderOpenIds,
              chat_type: q.chatType,
              start_time: q.startSec ? String(q.startSec) : undefined,
              end_time: q.endSec ? String(q.endSec) : undefined,
            },
          },
          Lark.withUserAccessToken(userToken),
        ),
      ) as { items?: string[]; page_token?: string; has_more?: boolean }
      assertCurrent?.()
      for (const id of data.items ?? []) ids.push(id)
      pageToken = data.has_more ? data.page_token : undefined
    } while (pageToken && ids.length < limit)
    return ids.slice(0, limit)
  }

  /**
   * 以用户身份按条件找消息（im.message.search）：可以不带关键词，只按发言人 / 单聊或群聊 / 时间筛——
   * 「老沈给我发的消息」就是 from_ids + chat_type=p2p。结果带 chat_id，正是找到一段单聊的唯一办法：
   * 单聊没有列表接口，只能从消息反查。正文仍用 getMessage 补。
   */
  async findMessagesAsUser(userToken: string, q: PersonalMessageQuery & { limit?: number },
    assertCurrent?: () => void): Promise<PersonalMessageMatch[]> {
    const out: PersonalMessageMatch[] = []
    let pageToken: string | undefined
    const seenTokens = new Set<string>()
    const limit = q.limit ?? 50
    do {
      const page = await this.findMessagesAsUserPage(userToken, q, { pageSize: Math.min(50, limit - out.length), pageToken }, assertCurrent)
      out.push(...page.items)
      pageToken = page.nextPageToken
      if (pageToken && seenTokens.has(pageToken)) throw new Error('消息搜索分页标识重复，尚未读完')
      if (pageToken) seenTokens.add(pageToken)
    } while (pageToken && out.length < limit)
    return out.slice(0, limit)
  }

  /** One provider page. Background collection persists the exact window and continuation token. */
  async findMessagesAsUserPage(userToken: string, q: PersonalMessageQuery,
    page: { pageToken?: string; pageSize?: number } = {}, assertCurrent?: () => void): Promise<PersonalMessagePage> {
    const size = page.pageSize ?? 50
    if (!Number.isSafeInteger(size) || size < 1 || size > 50) throw new Error('消息搜索每页条数须为 1–50')
    const iso = (seconds: number): string => {
      if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error('消息搜索时间无效')
      // The provider rejects fractional seconds (including .000), despite accepting ISO 8601.
      return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z')
    }
    assertCurrent?.()
    const data = unwrap('message.search', await this.client.im.v1.message.search({
      params: { user_id_type: 'open_id', page_size: size, page_token: page.pageToken },
      data: { ...(q.query ? { query: q.query } : {}), filter: {
        ...(q.senderOpenIds?.length ? { from_ids: q.senderOpenIds } : {}),
        ...(q.chatIds?.length ? { chat_ids: q.chatIds } : {}),
        ...(q.chatType ? { chat_type: q.chatType } : {}),
        // im.v1.message.search requires RFC3339, unlike search.v2 and message.list (Unix seconds).
        ...((q.startSec !== undefined || q.endSec !== undefined) ? { time_range: {
          ...(q.startSec !== undefined ? { start_time: iso(q.startSec) } : {}),
          ...(q.endSec !== undefined ? { end_time: iso(q.endSec) } : {}),
        } } : {}),
      } },
    }, Lark.withUserAccessToken(userToken))) as {
      items?: { id: string; meta_data?: { message_id?: string; chat_id?: string; from_id?: string; is_p2p_chat?: boolean;
        create_time?: string; thread_id?: string; position?: number; thread_position?: number } }[]
      page_token?: string; has_more?: boolean; notice?: string
    }
    assertCurrent?.()
    if (!Array.isArray(data.items) || typeof data.has_more !== 'boolean' ||
      (data.has_more && (!data.page_token || data.page_token === page.pageToken))) throw new Error('消息搜索分页未完成，不能视为已读完')
    const items = data.items.map(item => {
      const messageId = item.meta_data?.message_id ?? item.id
      if (!messageId) throw new Error('消息搜索返回了无效的消息编号')
      const created = Number(item.meta_data?.create_time)
      return { messageId, chatId: item.meta_data?.chat_id, fromId: item.meta_data?.from_id, isP2p: item.meta_data?.is_p2p_chat,
        threadId: item.meta_data?.thread_id, messagePosition: messagePosition(item.meta_data?.position),
        threadMessagePosition: messagePosition(item.meta_data?.thread_position),
        ...(Number.isFinite(created) && created > 0 ? { createTimeMs: created < 1e12 ? created * 1000 : created } : {}) }
    })
    return { items, hasMore: data.has_more, ...(data.has_more ? { nextPageToken: data.page_token! } : {}),
      ...(data.notice ? { notice: data.notice } : {}) }
  }

  // ---- 发消息 ----
  // 三种形态：text（纯文本）、markdown（富文本 post，看起来也是普通消息）、card（交互卡片：确认、菜单、待办）。
  // 发送异常可能只是回执丢失，不能换成纯文本再 POST；原样交给调用方记录发送结果。

  private outbound(payload: OutboundPayload, mentionOpenIds: readonly string[] = []): { msg_type: string; content: string } {
    if ('card' in payload) return { msg_type: 'interactive', content: JSON.stringify(payload.card) }
    if ('markdown' in payload) return { msg_type: 'post', content: JSON.stringify(postContent(payload.markdown, undefined, mentionOpenIds)) }
    return { msg_type: 'text', content: JSON.stringify({ text: payload.text }) }
  }

  private async replyRaw(messageId: string, payload: OutboundPayload, replyInThread: boolean, mentions?: PostMentionOptions): Promise<{ messageId: string; threadId?: string }> {
    let allowed = mentions?.mentionOpenIds
    if (!allowed && 'markdown' in payload && hasPostMentions(payload.markdown)) {
      // 回复锚点决定真实目标，不能由模型给一个可 @ 的群替换它。
      const source = await this.getMessage(messageId).catch(() => undefined)
      allowed = source?.chatId ? await this.mentionMembers(source.chatId) : []
    }
    const data = unwrap(
      'message.reply',
      await this.client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { ...this.outbound(payload, allowed), reply_in_thread: replyInThread },
      }),
    ) as { message_id?: string; thread_id?: string }
    return { messageId: data.message_id ?? '', threadId: data.thread_id }
  }

  /**
   * Sends to one person with Feishu's own de-duplication key: a retry with the same uuid within an hour does not create a second message.
   * For senders that must retry after an unclear timeout (the watchdog), never for ordinary replies.
   */
  async sendToUserOnce(openId: string, payload: OutboundPayload, uuid: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{1,50}$/.test(uuid)) throw new Error('uuid must be 1-50 characters of [A-Za-z0-9_-]')
    return this.createRaw('open_id', openId, payload, undefined, uuid)
  }

  private async createRaw(receiveIdType: 'open_id' | 'chat_id', receiveId: string, payload: OutboundPayload, mentions?: PostMentionOptions, uuid?: string): Promise<string> {
    let allowed = mentions?.mentionOpenIds
    if ('markdown' in payload && hasPostMentions(payload.markdown)) {
      if (receiveIdType === 'open_id') allowed = allowed ? allowed.filter((id) => id === receiveId) : [receiveId]
      else if (!allowed) allowed = await this.mentionMembers(receiveId)
    }
    const data = unwrap(
      'message.create',
      await this.client.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: receiveId, ...this.outbound(payload, allowed), ...(uuid ? { uuid } : {}) },
      }),
    ) as { message_id?: string }
    return data.message_id ?? ''
  }

  async replyCard(messageId: string, card: Record<string, unknown>, replyInThread = true): Promise<{ messageId: string; threadId?: string }> {
    return this.replyRaw(messageId, { card }, replyInThread)
  }

  async replyText(messageId: string, text: string, replyInThread = true): Promise<{ messageId: string; threadId?: string }> {
    return this.replyRaw(messageId, { text }, replyInThread)
  }

  /** 以富文本回复（正文是 Markdown）。 */
  async replyMarkdown(messageId: string, markdown: string, replyInThread = true, mentions?: PostMentionOptions): Promise<{ messageId: string; threadId?: string }> {
    return this.replyRaw(messageId, { markdown }, replyInThread, mentions)
  }

  private async mentionMembers(chatId: string): Promise<string[]> {
    return [...await this.chatMemberOpenIds(chatId, { fresh: true }).catch(() => new Set<string>())]
  }

  async patchCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    unwrap('message.patch', await this.client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } }))
  }

  // ---- 文件：上传并发送（需要 im:resource + im:message）----

  /** 把本地文件上传到飞书，返回 file_key（≤ 30 MB）。 */
  async uploadFile(filePath: string | Buffer, fileName: string): Promise<string> {
    const { createReadStream } = await import('node:fs')
    const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
    const fileType = ext === 'pdf' ? 'pdf' : ['doc', 'docx'].includes(ext) ? 'doc' : ['xls', 'xlsx'].includes(ext) ? 'xls' : ['ppt', 'pptx'].includes(ext) ? 'ppt' : ext === 'mp4' ? 'mp4' : ext === 'opus' ? 'opus' : 'stream'
    const res = (await this.client.im.v1.file.create({ data: { file_type: fileType, file_name: fileName, file: typeof filePath === 'string' ? createReadStream(filePath) : filePath } })) as { code?: number; msg?: string; file_key?: string; data?: { file_key?: string } } | null
    const key = res?.file_key ?? res?.data?.file_key
    if (!key) throw new FeishuApiError('file.create', res?.code ?? -1, res?.msg ?? '上传没有返回 file_key')
    return key
  }

  async replyFile(messageId: string, fileKey: string, replyInThread = false): Promise<string> {
    const data = unwrap(
      'message.reply',
      await this.client.im.v1.message.reply({ path: { message_id: messageId }, data: { content: JSON.stringify({ file_key: fileKey }), msg_type: 'file', reply_in_thread: replyInThread } }),
    ) as { message_id?: string }
    return data.message_id ?? ''
  }

  async sendFileToUser(openId: string, fileKey: string): Promise<string> {
    const data = unwrap(
      'message.create',
      await this.client.im.v1.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: openId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) } }),
    ) as { message_id?: string }
    return data.message_id ?? ''
  }

  async sendFileToChat(chatId: string, fileKey: string): Promise<string> {
    const data = unwrap('message.create', await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
    })) as { message_id?: string }
    return data.message_id ?? ''
  }

  // ---- 表情回复（需要 im:message.reactions:write_only）----

  /** 给消息贴一个表情，返回 reaction_id（之后可撤）。emoji_type 见飞书《表情文案说明》，如 OnIt / DONE / CrossMark。 */
  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    const data = unwrap(
      'message.reaction.create',
      await this.client.im.v1.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: emojiType } } }),
    ) as { reaction_id?: string }
    return data.reaction_id
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    unwrap('message.reaction.delete', await this.client.im.v1.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } }))
  }

  /**
   * 撤回自己发的一条消息（只能撤自己的）。用来收掉"什么都没发生"的进度卡片——
   * 一条只写着「完成」的空卡片比没有卡片更烦人。失败不抛，调用方自己兜底。
   */
  async recallMessage(messageId: string): Promise<boolean> {
    try {
      unwrap('message.delete', await this.client.im.v1.message.delete({ path: { message_id: messageId } }))
      return true
    } catch {
      return false
    }
  }

  async sendToUser(openId: string, payload: OutboundPayload, mentions?: PostMentionOptions): Promise<string> {
    return this.createRaw('open_id', openId, payload, mentions)
  }

  async sendToChat(chatId: string, payload: OutboundPayload, mentions?: PostMentionOptions): Promise<string> {
    return this.createRaw('chat_id', chatId, payload, mentions)
  }

  // ---- 读消息 ----

  async getMessage(messageId: string, as: AsUser = {}): Promise<HistoryMessage | undefined> {
    // 合并转发包含多个 items，不能把第一条子消息误作被请求消息的来源证明。
    return (await this.getMessageItems(messageId, as)).find((m) => m.messageId === messageId)
  }

  /**
   * 一条消息的**全部** items。普通消息就 1 条；合并转发的消息，飞书会把被转发的每条子消息
   * 一起返回（items[0] 是转发卡本身，后面是里面的内容）。
   *
   * 以前 getMessage 只取 items[0]，于是别人转发一整段聊天记录进来，我们看到的只有
   * 「[合并转发消息]」占位符。读取后续子消息，才能保留被转发记录的完整正文。
   */
  async getMessageItems(messageId: string, as: AsUser = {}): Promise<HistoryMessage[]> {
    const data = unwrap(
      'message.get',
      await this.client.im.v1.message.get({ path: { message_id: messageId }, params: { user_id_type: 'open_id', with_sender_name: true } }, asOptions(as)),
    ) as { items?: unknown[] }
    return (data.items ?? []).map((x) => this.normalizeItem(x as Record<string, unknown>))
  }

  /** 话题内全部消息（按时间正序），分页到底或到 limit。 */
  async listThread(threadId: string, limit = 500, as: AsUser = {}, assertCurrent?: () => void): Promise<HistoryMessage[]> {
    const out: HistoryMessage[] = []
    const seenTokens = new Set<string>()
    let pageToken: string | undefined
    do {
      assertCurrent?.()
      const data = unwrap(
        'message.list',
        await this.client.im.v1.message.list(
          {
            params: {
              container_id_type: 'thread',
              container_id: threadId,
              sort_type: 'ByCreateTimeAsc',
              page_size: 50,
              page_token: pageToken,
              with_sender_name: true,
            },
          },
          asOptions(as),
        ),
      ) as { has_more?: boolean; page_token?: string; items?: unknown[] }
      assertCurrent?.()
      for (const it of data.items ?? []) out.push(this.normalizeItem(it as Record<string, unknown>))
      if (data.has_more && (!data.page_token || seenTokens.has(data.page_token))) throw new Error('话题分页未完成：飞书未返回可继续的分页标识，不能视为已读完')
      if (data.page_token) seenTokens.add(data.page_token)
      pageToken = data.has_more ? data.page_token : undefined
    } while (pageToken && out.length < limit)
    return out.slice(0, limit)
  }

  /**
   * 群历史：按时间窗口分片拉取，绕开单次拉取的静默截断。
   * @param startSec 起点（秒）；@param endSec 终点（秒）；@param limit 本次最多返回条数
   */
  async listChatHistory(chatId: string, startSec: number, endSec: number, limit = 500, windowSec = 6 * 3600, as: AsUser = {}, assertCurrent?: () => void): Promise<HistoryPage> {
    assertCurrent?.()
    const out: HistoryMessage[] = []
    let windowStart = startSec
    let windowsScanned = 0
    let hasMore = false
    let nextStartTimeSec: number | undefined
    while (windowStart < endSec && out.length < limit) {
      const windowEnd = Math.min(windowStart + windowSec, endSec)
      const seenTokens = new Set<string>()
      let pageToken: string | undefined
      do {
        assertCurrent?.()
        const data = unwrap(
          'message.list',
          await this.client.im.v1.message.list(
            {
              params: {
                container_id_type: 'chat',
                container_id: chatId,
                start_time: String(windowStart),
                end_time: String(windowEnd),
                sort_type: 'ByCreateTimeAsc',
                page_size: 50,
                page_token: pageToken,
                with_sender_name: true,
              },
            },
            asOptions(as),
          ),
        ) as { has_more?: boolean; page_token?: string; items?: unknown[] }
        assertCurrent?.()
        for (const it of data.items ?? []) {
          const m = this.normalizeItem(it as Record<string, unknown>)
          if (m.chatId && m.chatId !== chatId) throw new Error('群历史返回了其他会话的消息，已停止读取')
          if (out.length >= limit) {
            hasMore = true
            nextStartTimeSec = Math.floor(m.createTimeMs / 1000)
            break
          }
          out.push(m)
        }
        if (hasMore) break
        if (data.has_more && (!data.page_token || seenTokens.has(data.page_token))) throw new Error('群历史分页未完成：飞书未返回可继续的分页标识，不能视为已读完')
        if (data.page_token) seenTokens.add(data.page_token)
        pageToken = data.has_more ? data.page_token : undefined
      } while (pageToken)
      windowsScanned += 1
      if (hasMore) break
      windowStart = windowEnd
    }
    if (!hasMore && out.length >= limit && windowStart < endSec) {
      hasMore = true
      nextStartTimeSec = windowStart
    }
    return { items: out, hasMore, nextStartTimeSec, windowsScanned }
  }

  private normalizeItem(it: Record<string, unknown>): HistoryMessage {
    const body = (it.body ?? {}) as Record<string, unknown>
    const sender = (it.sender ?? {}) as Record<string, unknown>
    const mentions = normalizeMentions(it.mentions)
    const msgType = String(it.msg_type ?? 'text')
    const createTime = Number(it.create_time ?? 0)
    const senderOpenId = sender.id_type === 'open_id' && typeof sender.id === 'string' ? sender.id : undefined
    let senderName = typeof sender.sender_name === 'string' && sender.sender_name ? sender.sender_name : ''
    if (!senderName && senderOpenId) senderName = this.nameCache.get(senderOpenId) ?? ''
    if (senderName && senderOpenId) this.nameCache.set(senderOpenId, senderName)
    for (const m of mentions) if (m.openId && m.name) this.nameCache.set(m.openId, m.name)
    if (!senderName) senderName = sender.sender_type === 'app' ? '机器人' : senderOpenId ? `用户(${senderOpenId.slice(-6)})` : '未知'
    const content = String(body.content ?? '')
    return {
      messageId: String(it.message_id ?? ''),
      tenantId: typeof sender.tenant_key === 'string' ? sender.tenant_key : undefined,
      createTimeMs: createTime > 1e12 ? createTime : createTime * 1000,
      msgType,
      senderName,
      senderOpenId,
      senderType: String(sender.sender_type ?? 'user'),
      text: parseContent(msgType, content, mentions),
      mentions,
      threadId: typeof it.thread_id === 'string' && it.thread_id ? it.thread_id : undefined,
      rootId: typeof it.root_id === 'string' && it.root_id ? it.root_id : undefined,
      parentId: typeof it.parent_id === 'string' && it.parent_id ? it.parent_id : undefined,
      chatId: typeof it.chat_id === 'string' && it.chat_id ? it.chat_id : undefined,
      messageAppLink: typeof it.message_app_link === 'string' && it.message_app_link.trim() ? it.message_app_link.trim() : undefined,
      messagePosition: messagePosition(it.message_position),
      threadMessagePosition: messagePosition(it.thread_message_position),
      ...extractAttachment(msgType, content),
    }
  }

  /** 记住 open_id → 姓名（来自 mentions / sender_name / contact API）。 */
  rememberName(openId: string, name: string): void {
    if (openId && name) this.nameCache.set(openId, name)
  }

  /** 用户姓名：先查缓存，再走 contact API（需要 contact:user.base:readonly）。 */
  async userName(openId: string): Promise<string> {
    const result = await this.userDisplayName(openId)
    return result.status === 'known' ? result.name : `用户(${openId.slice(-6)})`
  }

  /** A consumer needing a real display name must not treat an ID fallback as one. */
  async userDisplayName(openId: string, as: AsUser = {}): Promise<{ status: 'known'; name: string } | { status: 'unknown' }> {
    const cached = this.nameCache.get(openId)
    if (cached) return { status: 'known', name: cached }
    try {
      const data = unwrap('user.get', await this.client.contact.v3.user.get({ path: { user_id: openId }, params: { user_id_type: 'open_id' } }, asOptions(as))) as {
        user?: { name?: string }
      }
      const name = data.user?.name
      if (name) {
        this.nameCache.set(openId, name)
        return { status: 'known', name }
      }
    } catch (err) {
      // 常见原因：contact:user.base:readonly 没开，或"可访问的数据范围"没配成全员（这时是 99991672 / 400）
      if (!this.nameWarned.has(openId)) {
        this.nameWarned.add(openId)
        this.log.warn('user.get failed; check contact:user.base:readonly and the data scope (可访问的数据范围) in the console', { openId, err: String(err) })
      }
    }
    return { status: 'unknown' }
  }
  private readonly nameWarned = new Set<string>()

  // ---- 群列表与成员 ----

  private readonly chatListCache = new Map<string, { at: number; chats: ChatInfo[]; complete: boolean }>()
  private readonly memberCache = new Map<string, { at: number; members: Set<string> }>()

  /** 机器人所在的所有群（缓存 5 分钟）；传 userToken 则是该用户所在的所有群（按 token 各自缓存）。 */
  async listChats(as: AsUser = {}, opts: { fresh?: boolean; assertCurrent?: () => void } = {}): Promise<ChatInfo[]> {
    return (await this.listChatsResult(as, opts)).items
  }

  /** Absence proves loss of access only when all pages were fetched. */
  async listChatsResult(as: AsUser = {}, opts: { fresh?: boolean; assertCurrent?: () => void } = {}): Promise<{ items: ChatInfo[]; complete: boolean }> {
    opts.assertCurrent?.()
    const key = as.userToken ? `u:${as.userToken.slice(-16)}` : 'bot'
    const cached = this.chatListCache.get(key)
    // 缓存故意短：「我在哪些群」是人会当场追问的事，缓存久了会出现"刚拉我进群却说看不到"的怪现象。
    if (!opts.fresh && cached && Date.now() - cached.at < CHAT_LIST_TTL_MS) return { items: cached.chats, complete: cached.complete }
    const chats: ChatInfo[] = []
    let pageToken: string | undefined
    let complete = false
    do {
      opts.assertCurrent?.()
      const data = unwrap(
        'chat.list',
        await this.client.im.v1.chat.list({ params: { page_size: 100, page_token: pageToken, sort_type: 'ByActiveTimeDesc' } }, asOptions(as)),
      ) as { items?: { chat_id?: string; name?: string }[]; has_more?: boolean; page_token?: string }
      opts.assertCurrent?.()
      if (!Array.isArray(data.items) || data.items.some(it => !it || typeof it.chat_id !== 'string' || !it.chat_id)) {
        throw new Error('chat.list 返回的群列表无效')
      }
      for (const it of data.items) chats.push({ chatId: it.chat_id!, name: it.name ?? it.chat_id! })
      complete = data.has_more === false
      pageToken = data.has_more ? data.page_token : undefined
    } while (pageToken && chats.length < 2000)
    this.chatListCache.set(key, { at: Date.now(), chats, complete })
    return { items: chats, complete }
  }

  /**
   * 群成员的「名字 → open_id」。要 @ 某个人的时候用这个现查，
   * 就不必存一份会过期的 open_id 副本，也**不需要通讯录权限**。
   */
  async chatMembers(chatId: string): Promise<{ name: string; openId: string }[]> {
    await this.chatMemberOpenIds(chatId) // 顺带把 nameCache 填上
    const ids = this.memberCache.get(chatId)?.members ?? new Set<string>()
    const out: { name: string; openId: string }[] = []
    for (const id of ids) {
      const name = this.nameCache.get(id)
      if (name) out.push({ name, openId: id })
    }
    return out
  }

  /** 群成员 open_id 集合（缓存 10 分钟）。 */
  async chatMemberOpenIds(chatId: string, opts: { fresh?: boolean; assertCurrent?: () => void } = {}): Promise<Set<string>> {
    opts.assertCurrent?.()
    const cached = this.memberCache.get(chatId)
    if (!opts.fresh && cached && Date.now() - cached.at < 10 * 60_000) return cached.members
    const members = new Set<string>()
    let pageToken: string | undefined
    do {
      opts.assertCurrent?.()
      const data = unwrap(
        'chatMembers.get',
        await this.client.im.v1.chatMembers.get({ path: { chat_id: chatId }, params: { member_id_type: 'open_id', page_size: 100, page_token: pageToken } }),
      ) as { items?: { member_id?: string; name?: string }[]; has_more?: boolean; page_token?: string }
      opts.assertCurrent?.()
      for (const it of data.items ?? []) {
        if (it.member_id) members.add(it.member_id)
        if (it.member_id && it.name) this.nameCache.set(it.member_id, it.name)
      }
      pageToken = data.has_more ? data.page_token : undefined
    } while (pageToken && members.size < 5000)
    this.memberCache.set(chatId, { at: Date.now(), members })
    return members
  }

  /** 下载消息里的文件/图片；沿用本次读取身份，未指定时为应用身份。 */
  async downloadMessageResource(messageId: string, fileKey: string, type: 'file' | 'image', destPath: string, as: AsUser = {}): Promise<void> {
    const res = await this.client.im.v1.messageResource.get({ path: { message_id: messageId, file_key: fileKey }, params: { type } }, asOptions(as))
    await res.writeFile(destPath)
  }

  // ---- 群与文档 ----

  async chatName(chatId: string, as: AsUser = {}): Promise<string> {
    return (await this.chatInfo(chatId, as)).name
  }

  /**
   * 群的名字、群主与群管理员。
   *
   * 建空间那一刻把群主**和群管理员**一起冻结成空间负责人：
   * 这是一次性授权，之后群里换管理员不再同步——否则谁临时当了管理员谁就能改配置。
   */
  async chatInfo(chatId: string, as: AsUser = {}): Promise<{ name: string; ownerId?: string; managerIds: string[] }> {
    try {
      const data = unwrap('chat.get', await this.client.im.v1.chat.get({ path: { chat_id: chatId }, params: { user_id_type: 'open_id' } }, asOptions(as))) as {
        name?: string
        owner_id?: string
        owner_id_type?: string
        user_manager_id_list?: string[]
      }
      const byOpenId = data.owner_id_type === 'open_id'
      return {
        name: data.name ?? chatId,
        ownerId: byOpenId && data.owner_id ? data.owner_id : undefined,
        // 只在明确是 open_id 时采用：拿到 user_id/union_id 当成 open_id 用会把权限给错人
        managerIds: byOpenId ? (data.user_manager_id_list ?? []).filter((id) => typeof id === 'string' && id) : [],
      }
    } catch (err) {
      this.log.warn('chat.get failed', { chatId, err })
      return { name: chatId, managerIds: [] }
    }
  }

  /** 读取云文档纯文本。支持 docx 链接与 wiki 链接（wiki 会先解析到底层 docx）。 */
  async readDocument(ref: { kind: 'docx' | 'wiki'; token: string }, as: AsUser = {}): Promise<{ title?: string; content: string; objType: string }> {
    let objType = 'docx'
    let token = ref.token
    if (ref.kind === 'wiki') {
      const node = unwrap('wiki.getNode', await this.client.wiki.v2.space.getNode({ params: { token: ref.token, obj_type: 'wiki' } }, asOptions(as))) as {
        node?: { obj_type?: string; obj_token?: string; title?: string }
      }
      objType = node.node?.obj_type ?? 'docx'
      token = node.node?.obj_token ?? ref.token
      if (objType !== 'docx') return { title: node.node?.title, content: `[暂不支持读取 ${objType} 类型的知识库节点]`, objType }
    }
    const raw = unwrap('docx.rawContent', await this.client.docx.v1.document.rawContent({ path: { document_id: token }, params: { lang: 0 } }, asOptions(as))) as {
      content?: string
    }
    let title: string | undefined
    try {
      const info = unwrap('docx.get', await this.client.docx.v1.document.get({ path: { document_id: token } }, asOptions(as))) as { document?: { title?: string } }
      title = info.document?.title
    } catch {
      /* 标题拿不到不影响正文 */
    }
    return { title, content: raw.content ?? '', objType }
  }

  /**
   * 新建云文档并写入 Markdown 正文。以用户身份调用时文档归该用户所有；应用身份时归应用，
   * 之后用 grantDocAccess 给发起人 / 群授权。块按 50 个一批追加。
   */
  async createDocument(input: { title: string; markdown: string; folderToken?: string }, as: AsUser = {}): Promise<{ documentId: string; url: string; blocks: number }> {
    const created = unwrap('docx.create', await this.client.docx.v1.document.create({ data: { title: input.title.slice(0, 200), ...(input.folderToken ? { folder_token: input.folderToken } : {}) } }, asOptions(as))) as {
      document?: { document_id?: string }
    }
    const documentId = created.document?.document_id
    if (!documentId) throw new FeishuApiError('docx.create', -1, '创建文档没有返回 document_id')
    const blocks = markdownToBlocks(input.markdown)
    for (let i = 0; i < blocks.length; i += 50) {
      unwrap(
        'docx.blocks.create',
        await this.client.docx.v1.documentBlockChildren.create(
          { path: { document_id: documentId, block_id: documentId }, params: { document_revision_id: -1 }, data: { children: blocks.slice(i, i + 50) as never, index: i } },
          asOptions(as),
        ),
      )
    }
    return { documentId, url: this.docUrl(documentId), blocks: blocks.length }
  }

  /**
   * 把一段 Markdown **插到文档最前面**（链接不变，已有内容原样留在下面）。
   *
   * 日报这类"每天一期"的东西要的既不是每天新建一篇（链接每天变，历史散落各处），
   * 也不是 `rewriteDocument`（那会把前几期删掉）。最新一期在最上面，
   * 打开就是今天的，往下翻才是历史——不用滚到底去找。
   *
   * 分批时第 i 批插在 index i：第一批占 0..49，第二批插在 50 正好接在后面，顺序不会乱。
   */
  async prependToDocument(documentId: string, markdown: string, as: AsUser = {}): Promise<{ documentId: string; url: string; blocks: number }> {
    const blocks = markdownToBlocks(markdown)
    for (let i = 0; i < blocks.length; i += 50) {
      unwrap(
        'docx.blocks.create',
        await this.client.docx.v1.documentBlockChildren.create(
          { path: { document_id: documentId, block_id: documentId }, params: { document_revision_id: -1 }, data: { children: blocks.slice(i, i + 50) as never, index: i } },
          asOptions(as),
        ),
      )
    }
    return { documentId, url: this.docUrl(documentId), blocks: blocks.length }
  }

  /**
   * 用新的 Markdown 重写一篇已有文档（**链接不变**，个人 wiki 这类"每次重新生成"的文档靠它）。
   * 先删掉根块下的所有子块，再按 50 个一批写回去。删不掉的（比如别人加的评论块）跳过，不让整次更新失败。
   */
  async rewriteDocument(documentId: string, markdown: string, as: AsUser = {}): Promise<{ documentId: string; url: string; blocks: number }> {
    const existing = unwrap(
      'docx.blocks.children.get',
      await this.client.docx.v1.documentBlockChildren.get({ path: { document_id: documentId, block_id: documentId }, params: { page_size: 500, document_revision_id: -1 } }, asOptions(as)),
    ) as { items?: { block_id?: string }[] }
    const count = existing.items?.length ?? 0
    if (count > 0) {
      unwrap(
        'docx.blocks.children.batchDelete',
        await this.client.docx.v1.documentBlockChildren.batchDelete(
          { path: { document_id: documentId, block_id: documentId }, params: { document_revision_id: -1 }, data: { start_index: 0, end_index: count } },
          asOptions(as),
        ),
      )
    }
    const blocks = markdownToBlocks(markdown)
    for (let i = 0; i < blocks.length; i += 50) {
      unwrap(
        'docx.blocks.create',
        await this.client.docx.v1.documentBlockChildren.create(
          { path: { document_id: documentId, block_id: documentId }, params: { document_revision_id: -1 }, data: { children: blocks.slice(i, i + 50) as never, index: i } },
          asOptions(as),
        ),
      )
    }
    return { documentId, url: this.docUrl(documentId), blocks: blocks.length }
  }

  /**
   * 本人日历里某个时间段的日程（含重复日程展开后的实例）。只能以用户身份调用（需要 calendar:calendar:readonly）。
   */
  async listMyEvents(as: AsUser, range: { startSec: number; endSec: number }, assertCurrent: () => void = () => {}): Promise<CalendarEvent[]> {
    return (await this.listMyEventsPage(as, range, assertCurrent)).events
  }

  /** Completeness is based on the raw instance-view limit, before cancelled
   * events are removed. The legacy array method delegates here. */
  async listMyEventsPage(as: AsUser, range: { startSec: number; endSec: number }, assertCurrent: () => void = () => {}): Promise<{ events: CalendarEvent[]; complete: boolean }> {
    assertCurrent()
    if (!as.userToken) throw new FeishuApiError('calendar.primary', -1, '读日历需要个人授权')
    const prim = unwrap('calendar.primary', await this.client.calendar.v4.calendar.primary({ params: { user_id_type: 'open_id' } }, asOptions(as))) as {
      calendars?: { calendar?: { calendar_id: string } }[]
    }
    const calendarId = prim.calendars?.[0]?.calendar?.calendar_id
    assertCurrent()
    if (!calendarId) return { events: [], complete: true }
    const data = unwrap(
      'calendar.instanceView',
      await this.client.calendar.v4.calendarEvent.instanceView({ path: { calendar_id: calendarId }, params: { start_time: String(range.startSec), end_time: String(range.endSec), user_id_type: 'open_id' } }, asOptions(as)),
    ) as { items?: Record<string, unknown>[] }
    assertCurrent()
    const items = data.items ?? []
    const events = items
      .filter((e) => e.status !== 'cancelled')
      .map((e) => {
        const st = e.start_time as { date?: string; timestamp?: string } | undefined
        const et = e.end_time as { date?: string; timestamp?: string } | undefined
        const startMs = st?.timestamp ? Number(st.timestamp) * 1000 : st?.date ? Date.parse(`${st.date}T00:00:00+08:00`) : 0
        const endMs = et?.timestamp ? Number(et.timestamp) * 1000 : et?.date ? Date.parse(`${et.date}T00:00:00+08:00`) : startMs
        return {
          eventId: String(e.event_id),
          summary: String(e.summary ?? '（无标题）'),
          description: typeof e.description === 'string' ? e.description : undefined,
          startMs,
          endMs,
          allDay: Boolean(st?.date && !st.timestamp),
          location: (e.location as { name?: string } | undefined)?.name,
          organizer: (e.event_organizer as { display_name?: string } | undefined)?.display_name,
          meetingUrl: (e.vchat as { meeting_url?: string } | undefined)?.meeting_url,
          rsvp: e.self_rsvp_status as string | undefined,
          appLink: typeof e.app_link === 'string' ? e.app_link : undefined,
        }
      })
      .sort((a, b) => a.startMs - b.startMs)
    return { events, complete: items.length < 1000 }
  }

  docUrl(documentId: string): string {
    const domain = this.opts.docDomain ?? (this.opts.domain === 'lark' ? 'larksuite.com' : 'feishu.cn')
    return `https://${domain}/docx/${documentId}`
  }

  /** 给某人（open_id）或某个群（chat_id）加文档协作权限。 */
  /**
   * 给人 / 群授权访问一个云文档或多维表格。
   * `type` 决定是哪种：docx 文档、bitable 多维表格。应用自己建出来的东西默认只有应用能看见，
   * 必须显式授权，否则人点开链接是"无权限"。
   */
  async grantDocAccess(documentId: string, member: { openId?: string; chatId?: string }, perm: 'view' | 'edit' | 'full_access' = 'edit', as: AsUser = {}, type: 'docx' | 'bitable' = 'docx'): Promise<void> {
    const memberType = member.openId ? 'openid' : 'openchat'
    const memberId = member.openId ?? member.chatId
    if (!memberId) return
    unwrap(
      'drive.permission.member.create',
      await this.client.drive.v1.permissionMember.create({ path: { token: documentId }, params: { type, need_notification: false }, data: { member_type: memberType, member_id: memberId, perm } }, asOptions(as)),
    )
  }
}

/** SDK 请求选项：有 userToken 就以用户身份调用，否则应用身份（undefined = SDK 默认 tenant token）。 */
function asOptions(as: AsUser): ReturnType<typeof Lark.withUserAccessToken> | undefined {
  return as.userToken ? Lark.withUserAccessToken(as.userToken) : undefined
}

/** 从飞书链接里解析文档引用。 */
export function parseDocRef(input: string): { kind: 'docx' | 'wiki'; token: string } | undefined {
  const s = input.trim()
  const m = s.match(/https?:\/\/[^/\s]+\/(docx|wiki|docs)\/([A-Za-z0-9_-]+)/)
  if (m) {
    const kind = m[1] === 'wiki' ? 'wiki' : 'docx'
    return { kind, token: m[2] as string }
  }
  if (/^[A-Za-z0-9_-]{16,}$/.test(s)) return { kind: 'docx', token: s }
  return undefined
}
