import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { ChatReadScope } from '../src/core/chat-read-scope.js'
import { verifyConversationMessages } from '../src/core/conversation-read-source.js'
import { UserTokenStore, USER_SCOPE_TIERS } from '../src/feishu/oauth.js'
import { messageSourceLink } from '../src/feishu/message-links.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

/** Real SQLite, signed HTTP, MessageService and MCP wire. Only Feishu and the host's live Run lookup are synthetic. */
async function setup(options: { chatType?: 'group' | 'p2p'; scope?: string } = {}) {
  const registry = new Registry(':memory:')
  cleanups.push(() => registry.close())
  const { spaces, circles, policy } = spaceDeps(registry.db)
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_reader' })
  const group = spaces.ensure({ kind: 'group', chatId: 'oc_source', openId: 'ou_author' })
  spaces.addMember(group.id, 'ou_reader', 'member')
  const chatType = options.chatType ?? 'p2p', space = chatType === 'group' ? group : dm
  const readScope = new ChatReadScope(registry.db)
  const sessionKey = 'synthetic-link-read', cwd = '/tmp/friday-synthetic-link-read'
  registry.createSession({ sessionKey, chatId: space.chatId!, chatType, requesterOpenId: 'ou_reader', cwd })
  const task = registry.createTaskOnce({ sessionKey, messageId: 'om_request', requesterOpenId: 'ou_reader', prompt: '合成出处请求' }).task
  registry.updateTask(task.id, { status: 'running' })
  let runId = 'run-source'
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  fake.nextToken = { ...fake.nextToken, accessToken: 'SYNTHETIC_READ_TOKEN', scope: options.scope ?? USER_SCOPE_TIERS.core.join(' ') }
  fake.identities.set(fake.nextToken.accessToken, { openId: 'ou_reader', tenantKey: 'tenant-reader' })
  fake.userChats.set(fake.nextToken.accessToken, [{ chatId: 'oc_source', name: 'Synthetic source' }])
  const userTokens = new UserTokenStore(registry.db, fake)
  await userTokens.complete({ openId: 'ou_reader', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  const cache = new MessageCache(registry.db), log = createLogger('source-link-test', 'error')
  const getMessage = vi.spyOn(fake, 'getMessage'), history = vi.spyOn(fake, 'listChatHistory')
  const capture = vi.fn<NonNullable<InternalApiDeps['onMessageRead']>>((_session, _run, receipt) => receipt.assertCurrent())
  const tokens = new TokenIssuer('synthetic-secret')
  const api = createInternalApi({ feishu, registry, spaces, circles, policy, userTokens, readScope, appId: 'app-reader',
    memory: new ChannelMemory(registry.db), messageCache: cache, messages: new MessageService(feishu, cache, log),
    todos: new Todos(registry.db), tokens, log, maxHistoryPerCall: 300, onMessageRead: capture,
    resolveActorForSession: key => key === sessionKey ? { requesterOpenId: 'ou_reader', runId, stage: 'task', taskId: task.id } : undefined })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => api.server.close(error => error ? reject(error) : resolve())))
  const apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const token = tokens.issue({ runId, sessionKey, chatId: space.chatId!, chatType, spaceId: space.id, requesterOpenId: 'ou_reader', cwd,
    scopes: ['chat:read', 'chat:read-others', 'thread:read', 'file:read', 'chats:list'] })
  const server = buildServer({ apiUrl, token }), client = new Client({ name: 'source-link-client', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
  cleanups.push(async () => { await client.close(); await server.close() })
  const start = Math.floor((Date.now() - 60_000) / 1000) * 1000
  const item = (id = 'om_synthetic') => historyMsg({ messageId: id, chatId: 'oc_source', text: '合成来源正文', senderOpenId: 'ou_author',
    senderName: 'Author', createTimeMs: start + 1000 })
  const range = { chat: 'oc_source', start_time: new Date(start).toISOString(), end_time: new Date(start + 10_000).toISOString() }
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    return { result, text: JSON.stringify(result) }
  }
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${apiUrl}/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  return { fake, feishu, cache, capture, getMessage, history, item, range, start, tool, post, userTokens, readScope,
    replaceRun: () => { runId = 'run-replacement' } }
}

describe('message links reach actual MCP users', () => {
  it.each([
    ['feishu_read_chat_history', 'history'], ['feishu_search_messages', 'search'],
    ['feishu_read_thread', 'thread'], ['feishu_find_files', 'files'],
  ] as const)('carries platform location through %s without an extra message GET', async (name, kind) => {
    const t = await setup(), item = { ...t.item(), messagePosition: '42', threadId: 'omt_source',
      ...(kind === 'files' ? { msgType: 'file', fileKey: 'file', fileName: 'evidence.txt' } : {}) }
    t.fake.userHistories.set('oc_source', [item]); t.fake.threads.set('omt_source', [item])
    const args = kind === 'thread' ? { chat: 'oc_source', thread_id: 'omt_source' } : { ...t.range, ...(kind === 'search' ? { query: '合成' } : {}) }
    const out = await t.tool(name, args)
    expect(out.result.isError).not.toBe(true)
    expect(out.text).toContain(`[打开原消息](<${messageSourceLink(item)}>)`)
    expect(t.getMessage).not.toHaveBeenCalled()
    expect(t.capture).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(t.capture.mock.calls[0]![2])).not.toContain('sourceLink')
  })

  it('repairs a covered legacy cache row through exact current-user GET and reuses the link on later reads', async () => {
    const t = await setup(), original = t.item(), fresh = { ...original, messagePosition: '73' }
    t.cache.upsert('oc_source', [original]); t.cache.markCovered('oc_source', t.start / 1000, t.start / 1000 + 10)
    t.fake.messages.set(fresh.messageId, fresh)
    const out = await t.tool('feishu_search_messages', { ...t.range, query: '合成' })
    expect(out.result.isError).not.toBe(true)
    expect(out.text).toContain(messageSourceLink(fresh))
    expect(t.history).not.toHaveBeenCalled()
    expect(t.getMessage).toHaveBeenCalledExactlyOnceWith(original.messageId, { userToken: 'SYNTHETIC_READ_TOKEN' })
    const receipt = t.capture.mock.calls[0]![2]
    expect(await verifyConversationMessages(receipt.conversationReads, 'oc_source', { appId: 'app-reader', openId: 'ou_reader',
      tenantId: 'tenant-reader', as: { userToken: 'SYNTHETIC_READ_TOKEN' }, feishu: t.feishu,
      // The HTTP read lease closes with its call. This independent verification
      // checks the immutable receipt with a fresh synthetic audience lease.
      assertCurrent: () => { expect(t.userTokens.get('ou_reader')?.accessToken).toBe('SYNTHETIC_READ_TOKEN') } })).toBeUndefined()
    t.getMessage.mockClear()
    const second = await t.tool('feishu_read_chat_history', t.range)
    expect(second.text).toContain(messageSourceLink(fresh))
    expect(t.getMessage).not.toHaveBeenCalled()
  })

  it('does not discard the fresh GET link in global search MCP formatting', async () => {
    const t = await setup(), item = { ...t.item(), messageAppLink: 'https://applink.feishu.cn/client/message/link/open?token=synthetic-real-field' }
    t.fake.searchHits = [item.messageId]; t.fake.messages.set(item.messageId, item)
    const out = await t.tool('feishu_search_messages', { query: '合成' })
    expect(out.result.isError).not.toBe(true)
    expect(out.text).toContain(item.messageAppLink)
    expect(t.getMessage).toHaveBeenCalledTimes(1)
  })

  it('reports an unavailable link instead of synthesizing one from message_id', async () => {
    const t = await setup(), item = t.item()
    t.fake.userHistories.set('oc_source', [item]); t.fake.messages.set(item.messageId, item)
    const out = await t.tool('feishu_read_chat_history', t.range)
    expect(out.result.isError).not.toBe(true)
    expect(out.text).toContain('本次未取得可靠定位')
    expect(out.text).not.toContain('https://applink.')
    expect(out.text).toContain('合成来源正文')
  })

  it.each(['run', 'grant'] as const)('rejects a changed %s while the old cache location is being refreshed', async change => {
    const t = await setup(), item = t.item()
    t.fake.userHistories.set('oc_source', [item])
    t.getMessage.mockImplementation(async () => {
      if (change === 'run') t.replaceRun()
      else t.userTokens.disconnect('ou_reader')
      return { ...item, messagePosition: '42' }
    })
    const result = await t.post('chat/history', t.range)
    expect(result.status).toBe(403)
    expect(result.body.items).toBeUndefined()
    expect(t.cache.get(item.messageId)?.messagePosition).toBeUndefined()
  })

  it('withholds the old cache body and new location after the source is stopped during GET, then permits a fresh restored read', async () => {
    const t = await setup(), item = t.item()
    t.cache.upsert('oc_source', [item]); t.cache.markCovered('oc_source', t.start / 1000, t.start / 1000 + 10)
    t.getMessage.mockImplementationOnce(async () => {
      t.readScope.exclude('ou_reader', 'oc_source')
      return { ...item, messagePosition: '42' }
    })
    const stopped = await t.post('chat/history', t.range)
    expect(stopped.status).toBe(403)
    expect(stopped.body.items).toBeUndefined()
    expect(t.cache.get(item.messageId)?.messagePosition).toBeUndefined()
    expect(t.history).not.toHaveBeenCalled()

    t.readScope.restore('ou_reader', 'oc_source')
    t.getMessage.mockResolvedValue({ ...item, messagePosition: '42' })
    const restored = await t.post('chat/history', t.range)
    expect(restored.status).toBe(200)
    expect(restored.body.items[0]).toMatchObject({ text: item.text, sourceLink: { status: 'available' } })
    expect(t.getMessage).toHaveBeenCalledTimes(2)
    expect(t.cache.get(item.messageId)?.messagePosition).toBe('42')
  })

  it('does not stop a read when an unused directory group is excluded during the location GET', async () => {
    const t = await setup({ scope: [...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.watch].join(' ') }), item = t.item()
    t.fake.userChats.get('SYNTHETIC_READ_TOKEN')!.push({ chatId: 'oc_unrelated', name: 'Unrelated source' })
    t.fake.userHistories.set('oc_source', [item])
    t.getMessage.mockImplementation(async () => {
      t.readScope.exclude('ou_reader', 'oc_unrelated')
      return { ...item, messagePosition: '42' }
    })
    const result = await t.post('chat/history', t.range)
    expect(result.status).toBe(200)
    expect(result.body.items[0].sourceLink.status).toBe('available')
    expect(t.readScope.isReadable('ou_reader', 'oc_unrelated')).toBe(false)
  })

  it('keeps group application reads independent of the actor personal read exclusions', async () => {
    const t = await setup({ chatType: 'group' }), item = t.item()
    t.readScope.exclude('ou_reader', 'oc_source')
    t.fake.histories.set('oc_source', [item])
    t.fake.messages.set(item.messageId, { ...item, messagePosition: '42' })
    const result = await t.post('chat/history', t.range)
    expect(result.status).toBe(200)
    expect(result.body.items[0].sourceLink.status).toBe('available')
    expect(t.getMessage).toHaveBeenCalledExactlyOnceWith(item.messageId, {})
    expect(t.capture.mock.calls[0]![2].conversationReads!.items[0]!.readIdentity).toEqual({ kind: 'app' })
  })
})
