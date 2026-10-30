/**
 * 消息服务：把飞书历史 API 和本地缓存拼成一个"按需回填"的读取层。
 * 先查缓存覆盖窗口，缺口才打 API；所有拉到的消息都进缓存，之后的搜索/找文件直接走 SQLite。
 */
import type { AsUser, ChatInfo, FeishuClient, HistoryMessage } from '../feishu/client.js'
import type { CachedMessage, MessageCache, SearchQuery } from './message-cache.js'
import type { Logger } from '../log.js'

export interface MessageServiceOptions {
  /** 回填时按多大的时间窗口分片（秒） */
  windowSec?: number
  /** 单次调用最多从 API 回填多少条 */
  maxBackfillMessages?: number
}

export interface HistoryResult {
  items: CachedMessage[]
  hasMore: boolean
  nextStartTimeSec?: number
  fetchedFromApi: number
  /** 仅表示群消息流时间窗回填完成，不表示已展开话题或取得卡片全文。 */
  coverageComplete: boolean
  coveredUntilSec: number
  threadsExpanded: false
}

type FeishuHistoryClient = Pick<FeishuClient, 'listChatHistory' | 'listChats' | 'chatMemberOpenIds'>

export class MessageService {
  private readonly windowSec: number
  private readonly maxBackfill: number

  constructor(
    private readonly feishu: FeishuHistoryClient,
    private readonly cache: MessageCache,
    private readonly log: Logger,
    opts: MessageServiceOptions = {},
  ) {
    this.windowSec = opts.windowSec ?? 6 * 3600
    this.maxBackfill = opts.maxBackfillMessages ?? 2000
  }

  /**
   * 保证 [startSec, endSec) 已缓存；缺口按时间窗口回填，最多 maxBackfill 条。
   * 返回是否完整覆盖，以及未覆盖的起点（供分页续拉）。
   */
  async ensureCoverage(chatId: string, startSec: number, endSec: number, budget = this.maxBackfill, as: AsUser = {}, assertCurrent?: () => void): Promise<{ fetched: number; complete: boolean; resumeAtSec?: number }> {
    assertCurrent?.()
    let fetched = 0
    for (const gap of this.cache.missingWindows(chatId, startSec, endSec)) {
      let cursor = gap.startSec
      while (cursor < gap.endSec) {
        const remaining = budget - fetched
        if (remaining <= 0) return { fetched, complete: false, resumeAtSec: cursor }
        assertCurrent?.()
        const page = await this.feishu.listChatHistory(chatId, cursor, gap.endSec, remaining, this.windowSec, as, assertCurrent)
        assertCurrent?.()
        this.cache.upsert(chatId, page.items)
        fetched += page.items.length
        if (!page.hasMore) {
          this.cache.markCovered(chatId, cursor, gap.endSec)
          break
        }
        if (!page.nextStartTimeSec || page.nextStartTimeSec <= cursor) {
          // 同一秒内消息超过预算，时间游标无法继续。不要把未读完的这一秒标成完整。
          return { fetched, complete: false, resumeAtSec: cursor }
        }
        this.cache.markCovered(chatId, cursor, page.nextStartTimeSec)
        cursor = page.nextStartTimeSec
      }
    }
    return { fetched, complete: true }
  }

  /** 读取一段时间的历史（缓存优先），带分页语义。 */
  async history(chatId: string, startSec: number, endSec: number, limit: number, as: AsUser = {}, assertCurrent?: () => void): Promise<HistoryResult> {
    limit = Math.min(Math.max(limit, 1), 500)
    const cov = await this.ensureCoverage(chatId, startSec, endSec, this.maxBackfill, as, assertCurrent)
    assertCurrent?.()
    // 未完整覆盖的秒里也可能已取得部分消息：照实返回已知内容，另报覆盖缺口。
    const rows = this.cache.search({ chatIds: [chatId], startMs: startSec * 1000, endMs: endSec * 1000, limit: limit + 1 })
    const items = rows.slice(0, limit)
    let hasMore = rows.length > limit
    let nextStartTimeSec: number | undefined
    if (hasMore) nextStartTimeSec = Math.floor((rows[limit] as CachedMessage).createTimeMs / 1000)
    if (!cov.complete) {
      hasMore = true
      nextStartTimeSec = Math.min(nextStartTimeSec ?? endSec, cov.resumeAtSec ?? startSec)
    }
    return { items, hasMore, nextStartTimeSec, fetchedFromApi: cov.fetched, coverageComplete: cov.complete, coveredUntilSec: cov.complete ? endSec : (cov.resumeAtSec ?? startSec), threadsExpanded: false }
  }

  /** 跨群搜索：先把每个群在范围内的缺口补上（共享预算），再查缓存。 */
  async search(q: SearchQuery & { startSec: number; endSec: number }, as: AsUser = {}, assertCurrent?: () => void): Promise<{ items: CachedMessage[]; fetchedFromApi: number; incompleteChats: string[] }> {
    assertCurrent?.()
    let fetched = 0
    const incomplete: string[] = []
    for (const chatId of q.chatIds) {
      const cov = await this.ensureCoverage(chatId, q.startSec, q.endSec, Math.max(0, this.maxBackfill - fetched), as, assertCurrent)
      assertCurrent?.()
      fetched += cov.fetched
      if (!cov.complete) incomplete.push(chatId)
    }
    const items = this.cache.search({ ...q, startMs: q.startSec * 1000, endMs: q.endSec * 1000 })
    return { items, fetchedFromApi: fetched, incompleteChats: incomplete }
  }

  /** 事件收到的消息直接进缓存（不改覆盖窗口）。 */
  /** 缓存里某个时刻之后的消息（主动模式巡检用，不打 API）。 */
  cachedSince(chatId: string, sinceMs: number, limit = 80): CachedMessage[] {
    return this.cache.search({ chatIds: [chatId], startMs: sinceMs, limit })
  }

  /** 缓存里的一条（表情回执要靠它把 message_id 映回话题）。 */
  cached(messageId: string): CachedMessage | undefined {
    return this.cache.get(messageId)
  }

  /** 撤回一条：从缓存里删掉，之后搜索/引用都取不到。 */
  forget(messageId: string): boolean {
    return this.cache.remove(messageId)
  }

  remember(chatId: string, message: HistoryMessage): void {
    this.cache.upsert(chatId, [message])
  }

  /** 按 id 或名字片段解析群；候选列表由调用方按权限给出。 */
  static resolveChat(ref: string | undefined, candidates: ChatInfo[], fallback?: ChatInfo): ChatInfo | undefined {
    if (!ref) return fallback
    const needle = ref.trim()
    const byId = candidates.find((c) => c.chatId === needle)
    if (byId) return byId
    const exact = candidates.find((c) => c.name === needle)
    if (exact) return exact
    const partial = candidates.filter((c) => c.name.toLowerCase().includes(needle.toLowerCase()))
    return partial.length === 1 ? partial[0] : partial.length > 1 ? partial.sort((a, b) => a.name.length - b.name.length)[0] : undefined
  }
}
