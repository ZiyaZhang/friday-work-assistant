import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { parseContent } from '../src/feishu/content.js'
import { FeishuClient } from '../src/feishu/client.js'
import { postContent } from '../src/feishu/post.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { buildServer } from '../src/mcp/server.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Todos } from '../src/core/todos.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { spaceDeps } from './helpers/space.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'

const log = createLogger('test', 'error')

describe('card content is evidence, not an absent reply', () => {
  it('extracts legacy, schema 2 and compact text structures without action payloads', () => {
    const legacy = { header: { title: { tag: 'plain_text', content: '结论' } }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '已经回复' } }] }
    expect(parseContent('interactive', JSON.stringify(legacy))).toBe('[卡片]\n结论\n已经回复')
    const modern = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '外面的结论' }, { tag: 'collapsible_panel', elements: [{ tag: 'markdown', content: '折叠的证据' }] }, { tag: 'button', text: { tag: 'plain_text', content: '查看' }, value: { tag: 'markdown', content: 'NOT_DISPLAY_CONTENT' } }] } }
    const text = parseContent('interactive', JSON.stringify(modern))
    expect(text).toContain('外面的结论\n折叠的证据')
    expect(text).toContain('查看')
    expect(text).not.toContain('NOT_DISPLAY_CONTENT')
    expect(parseContent('interactive', JSON.stringify({ title: '摘要', elements: [[{ tag: 'text', text: 'API 返回的正文' }]] }))).toBe('[卡片]\n摘要\nAPI 返回的正文')
  })

  it('does not mistake a title or template reference for readable body', () => {
    for (const card of [{ title: '已完成', card_id: 'card123' }, { type: 'template', data: { template_id: 't', template_variable: { secret: 'NOT_DISPLAY_CONTENT' } } }]) {
      const text = parseContent('interactive', JSON.stringify(card))
      expect(text).toContain('卡片正文未取得')
      expect(text).toContain('不能据此判断没有回复')
      expect(text).not.toContain('NOT_DISPLAY_CONTENT')
    }
    expect(parseContent('interactive', '{bad json')).toContain('卡片正文未取得')
  })

  it('preserves text in normal Markdown post replies', () => {
    expect(parseContent('post', JSON.stringify(postContent('**已经答复**\n[证据](https://example.invalid)')))).toContain('**已经答复**')
  })
})

describe('message cache preserves reply identity and readable content', () => {
  it('fills thread/root/parent identity and does not erase known card text with an unreadable placeholder', () => {
    const db = new DatabaseSync(':memory:')
    try {
      const cache = new MessageCache(db)
      cache.upsert('oc_1', [historyMsg({ messageId: 'om_reply', msgType: 'interactive', text: 'Friday 已发送的完整结论' })])
      cache.upsert('oc_1', [historyMsg({ messageId: 'om_reply', msgType: 'interactive', text: '[卡片]', threadId: 'omt_1', rootId: 'om_root', parentId: 'om_question' })])
      expect(cache.get('om_reply')).toMatchObject({ text: 'Friday 已发送的完整结论', threadId: 'omt_1', rootId: 'om_root', parentId: 'om_question' })
      cache.upsert('oc_1', [historyMsg({ messageId: 'om_reply', msgType: 'interactive', text: parseContent('interactive', JSON.stringify({ title: '卡片标题', card_id: 'card1' })) })])
      expect(cache.get('om_reply')?.text).toBe('Friday 已发送的完整结论')
      cache.upsert('oc_1', [historyMsg({ messageId: 'om_reply', msgType: 'interactive', text: '[卡片]\n真正的新正文' })])
      expect(cache.get('om_reply')?.text).toBe('[卡片]\n真正的新正文')
    } finally { db.close() }
  })

  it('does not overwrite an existing message via a different chat', () => {
    const db = new DatabaseSync(':memory:')
    try {
      const cache = new MessageCache(db)
      cache.upsert('oc_private', [historyMsg({ messageId: 'om_unique', text: '原消息', threadId: 'omt_private' })])
      expect(cache.upsert('oc_other', [historyMsg({ messageId: 'om_unique', text: '跨群覆盖', threadId: 'omt_other' })])).toBe(0)
      expect(cache.get('om_unique')).toMatchObject({ chatId: 'oc_private', text: '原消息', threadId: 'omt_private' })
      expect(cache.count('oc_other')).toBe(0)
      expect(cache.upsert('oc_other', [historyMsg({ messageId: 'om_new', chatId: 'oc_private', text: '错误来源' })])).toBe(0)
      expect(cache.get('om_new')).toBeUndefined()
    } finally { db.close() }
  })
})

describe('Feishu response provenance and pagination', () => {
  const raw = (id: string, overrides: Record<string, unknown> = {}) => ({
    message_id: id, create_time: '100050', msg_type: 'text', body: { content: '{"text":"内容"}' },
    sender: { sender_type: 'app', sender_name: 'Friday' }, ...overrides,
  })
  function clientFor(data: { items?: unknown[]; has_more?: boolean; page_token?: string }[]) {
    const list = vi.fn()
    for (const page of data) list.mockResolvedValueOnce({ code: 0, data: page })
    // 注入 SDK 方法而不构造真实连接；仍执行生产 get/list/normalize 全链路。
    const client = Object.assign(Object.create(FeishuClient.prototype) as FeishuClient, {
      client: { im: { v1: { message: { list, get: vi.fn().mockResolvedValue({ code: 0, data: data[0] }) } } } },
      nameCache: new Map<string, string>(),
    })
    return { client, list }
  }

  it('selects the requested message instead of a forwarded child as provenance', async () => {
    const { client } = clientFor([{ items: [raw('om_child', { chat_id: 'oc_other' }), raw('om_requested', { chat_id: 'oc_1' })] }])
    expect(await client.getMessage('om_requested')).toMatchObject({ messageId: 'om_requested', chatId: 'oc_1' })
    expect(await client.getMessage('om_missing')).toBeUndefined()
  })

  it.each(['missing', 'repeated'])('does not call an unfinished thread complete with %s paging tokens', async (mode) => {
    const { client } = clientFor(mode === 'missing'
      ? [{ items: [raw('om_1')], has_more: true }]
      : [{ items: [raw('om_1')], has_more: true, page_token: 'same' }, { items: [raw('om_2')], has_more: true, page_token: 'same' }])
    await expect(client.listThread('omt_1', 500)).rejects.toThrow('话题分页未完成')
  })

  it('rejects an unfinished history window and a contradictory source chat', async () => {
    const unfinished = clientFor([{ items: [raw('om_1')], has_more: true }]).client
    await expect(unfinished.listChatHistory('oc_1', 100, 103)).rejects.toThrow('群历史分页未完成')
    const wrongChat = clientFor([{ items: [raw('om_other', { chat_id: 'oc_other' })], has_more: false }]).client
    await expect(wrongChat.listChatHistory('oc_1', 100, 103)).rejects.toThrow('其他会话')
  })

  it('continues SDK pagination within a second without skipping unread messages', async () => {
    const { client, list } = clientFor([
      { items: [raw('om_1', { create_time: '100' })], has_more: true, page_token: 'page2' },
      { items: [raw('om_2', { create_time: '100' }), raw('om_3', { create_time: '100' })], has_more: false },
    ])
    const page = await client.listChatHistory('oc_1', 100, 103, 2)
    expect(page.items.map((m) => m.messageId)).toEqual(['om_1', 'om_2'])
    expect(page).toMatchObject({ hasMore: true, nextStartTimeSec: 100 })
    expect(list.mock.calls[1]?.[0].params.page_token).toBe('page2')
  })
})

describe('history coverage does not imply complete discussion', () => {
  it.each([500, 501])('detects the end of a maximum-sized page with %s cached messages', async (count) => {
    const db = new DatabaseSync(':memory:')
    try {
      const cache = new MessageCache(db)
      cache.upsert('oc_1', Array.from({ length: count }, (_, i) => historyMsg({ messageId: `om_${i}`, text: '已回填消息', createTimeMs: 100_000 + i * 1000 })))
      cache.markCovered('oc_1', 100, 700)
      const page = await new MessageService(asFeishuClient(new FakeFeishu()), cache, log).history('oc_1', 100, 700, 500)
      expect(page.items).toHaveLength(500)
      expect(page.coverageComplete).toBe(true)
      expect(page.hasMore).toBe(count > 500)
      expect(page.nextStartTimeSec).toBe(count > 500 ? 600 : undefined)
    } finally { db.close() }
  })

  it('distinguishes a complete backfill window from a truncated page and unopened threads', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      const cache = new MessageCache(db)
      const feishu = new FakeFeishu()
      feishu.histories.set('oc_1', [historyMsg({ messageId: 'om_1', text: '一个话题', createTimeMs: 101_000, threadId: 'omt_1' }), historyMsg({ messageId: 'om_2', text: '另一条消息', createTimeMs: 102_000 })])
      const service = new MessageService(asFeishuClient(feishu), cache, log)
      const page = await service.history('oc_1', 100, 103, 1)
      expect(page).toMatchObject({ coverageComplete: true, coveredUntilSec: 103, hasMore: true, threadsExpanded: false })
      expect(page.items).toHaveLength(1)
      expect(page.nextStartTimeSec).toBe(102)
    } finally { db.close() }
  })

  it.each([100, undefined])('does not mark an unfinished second as covered when the API cursor is %s', async (cursor) => {
    const db = new DatabaseSync(':memory:')
    try {
      const cache = new MessageCache(db)
      const feishu = new FakeFeishu()
      feishu.listChatHistory = async () => ({ items: [historyMsg({ messageId: 'om_partial', text: '这一秒的一部分', createTimeMs: 100_050 })], hasMore: true, nextStartTimeSec: cursor, windowsScanned: 1 })
      const service = new MessageService(asFeishuClient(feishu), cache, log, { maxBackfillMessages: 1 })
      const page = await service.history('oc_1', 100, 103, 10)
      expect(page).toMatchObject({ coverageComplete: false, coveredUntilSec: 100, hasMore: true, nextStartTimeSec: 100, threadsExpanded: false })
      expect(page.items.map((m) => m.messageId)).toEqual(['om_partial'])
      expect(cache.coverage('oc_1')).toEqual([])
    } finally { db.close() }
  })
})

describe('file and search coverage through the internal API', () => {
  function setup(budget = 2000) {
    const registry = new Registry(':memory:')
    const cache = new MessageCache(registry.db)
    const feishu = new FakeFeishu()
    const userTokens = new UserTokenStore(registry.db, feishu)
    const api = createInternalApi({ registry, appId: 'app-synthetic', messageCache: cache, feishu: asFeishuClient(feishu),
      messages: new MessageService(asFeishuClient(feishu), cache, log, { maxBackfillMessages: budget }),
      memory: new ChannelMemory(registry.db), todos: new Todos(registry.db), ...spaceDeps(registry.db),
      userTokens, tokens: new TokenIssuer('offline'), log, maxHistoryPerCall: 100,
    })
    const cap: Capability = { sessionKey: 'test', chatId: 'oc_1', chatType: 'group', requesterOpenId: 'ou_alice', scopes: [...ALL_SCOPES], exp: 9999999999 }
    const call = (path: string, body: Record<string, unknown>, actor = cap) => api.routes[`POST /v1/${path}`]!(actor, body)
    return { registry, cache, feishu, userTokens, cap, call }
  }

  it('filters file timestamps before applying the limit, so later files cannot hide a historical hit', async () => {
    const t = setup()
    try {
      t.cache.upsert('oc_1', [
        historyMsg({ messageId: 'om_target', text: '[文件]', fileName: '目标.md', fileKey: 'target', createTimeMs: 100_000 }),
        historyMsg({ messageId: 'om_newer', text: '[文件]', fileName: '更新.md', fileKey: 'newer', createTimeMs: 120_000 }),
        historyMsg({ messageId: 'om_end', text: '[文件]', fileKey: 'end', createTimeMs: 110_000 }),
      ])
      const result = await t.call('messages/files', { start_time: '90', end_time: '110', limit: 1 })
      expect(result).toMatchObject({ coverage_complete: true, matches_may_be_truncated: true, threads_expanded: false, items: [{ messageId: 'om_target' }] })
    } finally { t.registry.close() }
  })

  it('reports incomplete file coverage when budget is consumed by non-file messages', async () => {
    const t = setup(1)
    try {
      t.feishu.histories.set('oc_1', [historyMsg({ messageId: 'om_chat', text: '先说句话', createTimeMs: 100_000 }), historyMsg({ messageId: 'om_file', text: '[文件]', fileKey: 'later', createTimeMs: 100_500 })])
      expect(await t.call('messages/files', { start_time: '100', end_time: '103' })).toMatchObject({ items: [], coverage_complete: false, covered_until_time: '1970-01-01T00:01:40.000Z' })
    } finally { t.registry.close() }
  })

  it('marks search results at the limit as a sample even when backfill is complete', async () => {
    const t = setup()
    try {
      t.feishu.histories.set('oc_1', [historyMsg({ messageId: 'om_1', text: '匹配', createTimeMs: 100_000 }), historyMsg({ messageId: 'om_2', text: '匹配', createTimeMs: 101_000 })])
      expect(await t.call('messages/search', { query: '匹配', start_time: '100', end_time: '103', limit: 1 })).toMatchObject({ complete: true, matches_may_be_truncated: true, threads_expanded: false })
    } finally { t.registry.close() }
  })

  it('reports OAuth search hits whose body fetch failed or disappeared as incomplete', async () => {
    const t = setup()
    try {
      const state = t.userTokens.begin('ou_alice')
      await t.userTokens.complete({ code: 'offline', state, redirectUri: 'http://offline.invalid', openId: 'ou_alice' })
      t.feishu.identities.set('uat-1', { openId: 'ou_alice', name: '合成用户', tenantKey: 'tenant-synthetic' })
      t.feishu.searchHits = ['om_cached', 'om_fetched', 'om_fail', 'om_missing']
      t.cache.upsert('oc_1', [historyMsg({ messageId: 'om_cached', text: '缓存正文' })])
      t.feishu.getMessage = async (id) => {
        if (id === 'om_fail') throw new Error('offline fixture permission denied')
        return id === 'om_fetched' ? historyMsg({ messageId: id, chatId: 'oc_1', text: '新取得的正文' }) : undefined
      }
      const result = await t.call('messages/search', { query: '正文', limit: 4 }, { ...t.cap, chatType: 'p2p', chatId: 'oc_dm' })
      expect(result).toMatchObject({ complete: false, failed_fetches: 3, fetched_from_api: 1, matches_may_be_truncated: true, items: [{ messageId: 'om_fetched' }] })
      expect(JSON.stringify(result)).not.toContain('缓存正文')
      expect(t.cache.get('om_cached')?.text).toBe('缓存正文')
    } finally { t.registry.close() }
  })
})

describe('MCP context output', () => {
  afterEach(() => vi.restoreAllMocks())

  async function invoke(name: string, args: Record<string, unknown>, response: unknown) {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } }))
    const server = buildServer({ apiUrl: 'http://offline.invalid', token: 'offline' })
    const client = new Client({ name: 'context-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    await client.connect(b)
    try {
      const result = await client.callTool({ name, arguments: args }) as { content: { type: string; text: string }[]; isError?: boolean }
      return { result, text: result.content.map((c) => c.text).join('\n'), fetch }
    } finally {
      await client.close()
      await server.close()
    }
  }

  it('retains chat and reply identifiers with explicit unreadable-card and thread-coverage warnings', async () => {
    const { text } = await invoke('feishu_read_chat_history', { chat: 'oc_1', limit: 20 }, {
      chat_id: 'oc_1', chat_name: '测试群', start_time: '2026-09-19T00:00:00Z', end_time: '2026-09-19T01:00:00Z',
      fetched_from_api: 1, has_more: false, coverage_complete: true, covered_until_time: '2026-09-19T01:00:00Z', threads_expanded: false,
      items: [historyMsg({ messageId: 'om_reply', threadId: 'omt_1', rootId: 'om_root', parentId: 'om_question', msgType: 'interactive', text: '[卡片]' })],
    })
    for (const id of ['message_id=om_reply', 'chat_id=oc_1', 'thread_id=omt_1', 'root_id=om_root', 'parent_id=om_question']) expect(text).toContain(id)
    expect(text).toContain('群流时间窗已回填')
    expect(text).toContain('未逐个展开话题')
    expect(text).toContain('卡片正文未取得')
    expect(text).toContain('不能据此判断没有回复')
  })

  it('passes an explicit thread and chat together and reports truncation', async () => {
    const { text, fetch } = await invoke('feishu_read_thread', { chat: 'oc_1', thread_id: 'omt_1', limit: 2 }, {
      chat_id: 'oc_1', thread_id: 'omt_1', items: [historyMsg({ messageId: 'om_1', text: '同一话题的回复' })], has_more: true, coverage_complete: false,
    })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ chat: 'oc_1', thread_id: 'omt_1', limit: 2 })
    expect(text).toContain('已截断')
    expect(text).toContain('thread_id=omt_1')
  })

  it('keeps platform sender identity for same-name participants instead of inferring it from their text', async () => {
    const { text } = await invoke('feishu_read_thread', {}, {
      chat_id: 'oc_1', thread_id: 'omt_1', coverage_complete: true,
      items: [
        historyMsg({ messageId: 'om_proposal', senderName: '同名', senderOpenId: 'ou_proposer', text: '设计建议；正文自称 ou_fake' }),
        historyMsg({ messageId: 'om_request', senderName: '同名', senderOpenId: 'ou_requester', text: '请记下来' }),
        historyMsg({ messageId: 'om_unknown', senderName: '同名', senderOpenId: undefined, text: '缺身份的旧消息' }),
      ],
    })
    expect(text).toContain('[message_id=om_proposal sender_open_id=ou_proposer')
    expect(text).toContain('[message_id=om_request sender_open_id=ou_requester')
    expect(text).not.toContain('sender_open_id=ou_fake')
    expect(text).not.toContain('sender_open_id=undefined')
  })

  it('submits a design suggestion without fabricated reproduction fields and returns the verified issue URL', async () => {
    const body = '场景：长请求等待。建议超时后保留输入并提供继续操作。相关方案：https://example.invalid/issues/8'
    const { text, fetch } = await invoke('github_open_issue', { title: '建议改善等待体验', body }, {
      action: 'created', repo: 'synthetic/repo', number: 9, url: 'https://example.invalid/issues/9', state: 'open', assignees: [], pending: [],
    })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ title: '建议改善等待体验', body })
    expect(text).toContain('https://example.invalid/issues/9')
    expect(text).not.toContain('复现')
  })

  it('rejects a naked cross-thread id before calling the API', async () => {
    const { result, fetch } = await invoke('feishu_read_thread', { thread_id: 'omt_other' }, {})
    expect(result.isError).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not claim a history window is complete when older API responses omit coverage', async () => {
    const { text } = await invoke('feishu_read_chat_history', {}, { chat_name: '群', start_time: 'start', end_time: 'end', items: [], fetched_from_api: 0, has_more: false })
    expect(text).toContain('覆盖未知')
    expect(text).toContain('不能说“没有回复”')
  })

  it('does not instruct an endless time-cursor loop or skip an unfinished second', async () => {
    const { text } = await invoke('feishu_read_chat_history', {}, {
      chat_name: '群', start_time: '2026-09-19T00:00:00Z', end_time: '2026-09-19T01:00:00Z',
      next_start_time: '2026-09-19T00:00:00Z', items: [], fetched_from_api: 0, has_more: true, coverage_complete: false,
    })
    expect(text).toContain('照搬 start_time 会重复本页')
    expect(text).toContain('不能把时间加一秒跳过消息')
  })

  it('does not turn an incomplete empty file page into a definitive absence claim', async () => {
    const { text } = await invoke('feishu_find_files', {}, { items: [], coverage_complete: false })
    expect(text).toContain('未取得的消息里仍可能有附件')
    expect(text).toContain('已取得的消息里未找到匹配附件')
  })

  it('labels a search page at the cap as a sample, independently from complete backfill', async () => {
    const { text } = await invoke('feishu_search_messages', {}, { items: [], fetched_from_api: 0, incomplete_chats: [], complete: true, matches_may_be_truncated: true })
    expect(text).toContain('当前是取样结果')
    expect(text).toContain('回填完成不代表全部搜索命中或话题已读完')
  })
})
