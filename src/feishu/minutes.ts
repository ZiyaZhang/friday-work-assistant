/** Read-only, personal-identity access to Feishu Minutes. No subscription or todo writes. */
import { withUserAccessToken, type Client } from '@larksuiteoapi/node-sdk'

type MinuteApi = Pick<Client['minutes']['v1']['minute'], 'search' | 'get' | 'artifacts'>
export type MinutesClient = { minutes: { v1: { minute: MinuteApi } } }
type Operation = keyof MinuteApi
type AssertCurrent = () => void

export const MINUTES_SCOPES = {
  search: 'minutes:minutes.search:read',
  get: 'minutes:minutes.basic:read',
  artifacts: 'minutes:minutes.artifacts:read',
} as const

/** Host-only source receipt. Search receipts retain the exact query and positive results so
 * a later execution cannot reuse previews that the current user can no longer retrieve. */
export type MinutesSource =
  | { operation: 'get' | 'artifacts'; token: string }
  | { operation: 'search'; range: { startMs: number; endMs: number }; limit: number;
      query?: string; pageToken?: string; tokens: string[]; complete: boolean }

export function minutesSourceRef(source: MinutesSource): string {
  return `minutes:v1:${Buffer.from(JSON.stringify(source)).toString('base64url')}`
}

export function parseMinutesSourceRef(ref: string): MinutesSource | undefined {
  if (!/^minutes:v1:[A-Za-z0-9_-]{1,20000}$/.test(ref)) return undefined
  let source: MinutesSource
  try { source = JSON.parse(Buffer.from(ref.slice('minutes:v1:'.length), 'base64url').toString('utf8')) }
  catch { return undefined }
  if (!source || typeof source !== 'object') return undefined
  if (source.operation === 'get' || source.operation === 'artifacts') {
    return typeof source.token === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(source.token) ? source : undefined
  }
  if (source.operation !== 'search' || !source.range ||
    !Number.isSafeInteger(source.range.startMs) || !Number.isSafeInteger(source.range.endMs) ||
    source.range.startMs < 0 || source.range.endMs > 8.64e15 || source.range.endMs <= source.range.startMs ||
    source.range.endMs - source.range.startMs > 30 * 86_400_000 ||
    !Number.isSafeInteger(source.limit) || source.limit < 1 || source.limit > 50 ||
    (source.query !== undefined && (typeof source.query !== 'string' || source.query.length > 50)) ||
    (source.pageToken !== undefined && (typeof source.pageToken !== 'string' || !source.pageToken.trim() || source.pageToken.length > 2048)) ||
    !Array.isArray(source.tokens) || source.tokens.length > source.limit ||
    source.tokens.some(token => typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(token)) ||
    typeof source.complete !== 'boolean') return undefined
  return source
}

export interface MinuteBrief {
  token: string
  title?: string
  url?: string
  /** Creation time is not necessarily the meeting start time. The API unit is milliseconds. */
  createdAtMs?: number
  durationMs?: number
  ownerId?: string
  noteId?: string
}

export interface MinuteSearchItem {
  token: string
  /** Search preview, not a verified title or a meeting summary. */
  displayInfo?: string
  url?: string
}

export interface MinuteSearchResult {
  items: MinuteSearchItem[]
  coverage: {
    complete: boolean
    hasMore: boolean
    nextPageToken?: string
    fetchedPages: number
    returned: number
    total?: number
    notice?: string
    range: { startMs: number; endMs: number }
  }
}

export interface MinuteTodo {
  content?: string
  /** Provider identifiers, not names; do not assume every action belongs to the requester. */
  assignees?: string[]
  isDone?: boolean
  todoId?: string
  operation?: string
}

export interface MinuteArtifacts {
  token: string
  summary?: string
  todos: MinuteTodo[]
  chapters: { title?: string; startMs?: number; stopMs?: number; summary?: string }[]
  keywords: string[]
  /** Missing AI output is different from a successfully returned empty todo list. */
  coverage: { summary: 'present' | 'absent'; todos: 'present' | 'absent' }
}

type Failure = 'scope' | 'authentication' | 'provider' | 'transport' | 'invalid_response' | 'invalid_request'
export class MinutesError extends Error {
  readonly requiredScope: string
  constructor(readonly operation: Operation, readonly code: number | undefined, readonly reason: Failure) {
    const scope = MINUTES_SCOPES[operation]
    const detail = reason === 'scope' ? `缺少妙记权限 ${scope}，请补充个人授权；若应用尚未开通该权限，需管理员先开通并发布。`
      : reason === 'authentication' ? '尚无有效的个人授权，未读取妙记。'
      : reason === 'transport' ? '妙记服务暂时无法连接，本次没有取得结果。'
      : reason === 'invalid_response' ? '妙记服务返回的数据不完整，本次不能判断有没有会议或待办。'
      : reason === 'invalid_request' ? '妙记查询参数无效，未发起读取。'
      : `妙记读取失败${code === undefined ? '' : `（code=${code}）`}；请核对本人对这份资料的访问权限，不能据此判断内容为空。`
    super(detail)
    this.name = 'MinutesError'
    this.requiredScope = scope
  }
  get needsScope(): boolean { return this.reason === 'scope' }
}

function milliseconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined
}

function validateToken(token: string, operation: Operation): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) throw new MinutesError(operation, undefined, 'invalid_request')
}

function unwrap<T>(operation: Operation, response: { code?: number; data?: T }): T {
  if (response.code !== 0) {
    // Resource permission errors are not scope errors: repeated OAuth cannot grant document access.
    throw new MinutesError(operation, response.code, response.code === 99991672 ? 'scope' : 'provider')
  }
  if (!response.data || typeof response.data !== 'object') throw new MinutesError(operation, undefined, 'invalid_response')
  return response.data
}

export class FeishuMinutes {
  constructor(private readonly client: MinutesClient) {}

  private async call<T>(operation: Operation, userToken: string, invoke: (options: ReturnType<typeof withUserAccessToken>) => Promise<T>, assertCurrent?: AssertCurrent): Promise<T> {
    if (!userToken.trim()) throw new MinutesError(operation, undefined, 'authentication')
    assertCurrent?.()
    let response: T
    try { response = await invoke(withUserAccessToken(userToken)) }
    catch (error) {
      // SDK transports may reject on HTTP errors with the provider code in response.data.
      // Never propagate an Axios error, its request headers, or the provider's arbitrary message.
      const code = (error as { response?: { data?: { code?: unknown } } } | undefined)?.response?.data?.code
      assertCurrent?.()
      throw new MinutesError(operation, typeof code === 'number' ? code : undefined, code === 99991672 ? 'scope' : typeof code === 'number' ? 'provider' : 'transport')
    }
    assertCurrent?.()
    return response
  }

  /** Bounded, explicit query. Continuations must keep the same range and query. */
  async recent(userToken: string, range: { startMs: number; endMs: number }, limit = 20,
    options: { pageToken?: string; query?: string; assertCurrent?: AssertCurrent } = {}): Promise<MinuteSearchResult> {
    if (!Number.isSafeInteger(range.startMs) || !Number.isSafeInteger(range.endMs) || range.startMs < 0 || range.endMs <= range.startMs || range.endMs > 8.64e15 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (options.query?.length ?? 0) > 50 ||
      (options.pageToken !== undefined && (!options.pageToken.trim() || options.pageToken.length > 2048))) {
      throw new MinutesError('search', undefined, 'invalid_request')
    }
    const items: MinuteSearchItem[] = [], seen = new Set<string>(), cursors = new Set<string>()
    const notices = new Set<string>()
    let pageToken = options.pageToken, fetchedPages = 0, hasMore = false, total: number | undefined
    if (pageToken) cursors.add(pageToken)
    do {
      const pageSize = Math.min(50, limit - items.length)
      const response = await this.call('search', userToken, opts => this.client.minutes.v1.minute.search({
        data: { ...(options.query ? { query: options.query } : {}),
          filter: { create_time: { start_time: new Date(range.startMs).toISOString(), end_time: new Date(range.endMs).toISOString() } },
          sorter: 'create_time_desc' },
        params: { page_size: pageSize, ...(pageToken ? { page_token: pageToken } : {}), user_id_type: 'open_id' },
      }, opts), options.assertCurrent)
      const data = unwrap('search', response)
      if (!Array.isArray(data.items) || data.items.length > pageSize || typeof data.has_more !== 'boolean') throw new MinutesError('search', undefined, 'invalid_response')
      for (const item of data.items) {
        if (!item || typeof item.token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.token)) throw new MinutesError('search', undefined, 'invalid_response')
        if (seen.has(item.token)) continue
        seen.add(item.token)
        items.push({ token: item.token,
          ...(typeof item.display_info === 'string' ? { displayInfo: item.display_info } : {}),
          ...(typeof item.meta_data?.app_link === 'string' ? { url: item.meta_data.app_link } : {}) })
      }
      fetchedPages += 1
      if (typeof data.notice === 'string' && data.notice.trim()) notices.add(data.notice)
      if (Number.isSafeInteger(data.total) && data.total! >= 0) total = data.total
      hasMore = data.has_more
      pageToken = hasMore ? data.page_token : undefined
      if (hasMore) {
        if (!pageToken?.trim() || pageToken.length > 2048 || cursors.has(pageToken)) throw new MinutesError('search', undefined, 'invalid_response')
        cursors.add(pageToken)
      }
    } while (hasMore && items.length < limit && fetchedPages < 10)
    return { items, coverage: { complete: !hasMore && notices.size === 0, hasMore,
      ...(pageToken ? { nextPageToken: pageToken } : {}), fetchedPages, returned: items.length,
      ...(total !== undefined ? { total } : {}), ...(notices.size ? { notice: [...notices].join('\n') } : {}), range: { ...range } } }
  }

  async brief(userToken: string, token: string, assertCurrent?: AssertCurrent): Promise<MinuteBrief> {
    validateToken(token, 'get')
    const response = await this.call('get', userToken, opts => this.client.minutes.v1.minute.get({
      path: { minute_token: token }, params: { user_id_type: 'open_id' },
    }, opts), assertCurrent)
    const raw = unwrap('get', response).minute
    if (!raw || raw.token !== token) throw new MinutesError('get', undefined, 'invalid_response')
    return { token, title: raw.title, url: raw.url, createdAtMs: milliseconds(raw.create_time),
      durationMs: milliseconds(raw.duration), ownerId: raw.owner_id, noteId: raw.note_id }
  }

  async artifacts(userToken: string, token: string, assertCurrent?: AssertCurrent): Promise<MinuteArtifacts> {
    validateToken(token, 'artifacts')
    const response = await this.call('artifacts', userToken, opts => this.client.minutes.v1.minute.artifacts({ path: { minute_token: token } }, opts), assertCurrent)
    const data = unwrap('artifacts', response)
    if ((data.minute_todos !== undefined && !Array.isArray(data.minute_todos)) ||
      (data.minute_chapters !== undefined && !Array.isArray(data.minute_chapters)) ||
      (data.keywords !== undefined && !Array.isArray(data.keywords)) ||
      (data.summary !== undefined && typeof data.summary !== 'string')) throw new MinutesError('artifacts', undefined, 'invalid_response')
    return { token, summary: data.summary,
      todos: (data.minute_todos ?? []).map(todo => {
        if (!todo || (todo.assignees !== undefined && (!Array.isArray(todo.assignees) || todo.assignees.some(id => typeof id !== 'string'))) ||
          (todo.is_done !== undefined && typeof todo.is_done !== 'boolean')) throw new MinutesError('artifacts', undefined, 'invalid_response')
        return { content: todo.content, assignees: todo.assignees, isDone: todo.is_done, todoId: todo.todo_id, operation: todo.operation }
      }),
      chapters: (data.minute_chapters ?? []).map(chapter => ({ title: chapter.title, startMs: milliseconds(chapter.start_ms), stopMs: milliseconds(chapter.stop_ms), summary: chapter.summary_content })),
      keywords: data.keywords ?? [], coverage: { summary: data.summary === undefined ? 'absent' : 'present', todos: data.minute_todos === undefined ? 'absent' : 'present' } }
  }
}
