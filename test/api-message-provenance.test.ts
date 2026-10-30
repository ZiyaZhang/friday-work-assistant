import { AxiosError } from 'axios'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { ChatReadScope } from '../src/core/chat-read-scope.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { conversationDigest, validConversationReads } from '../src/core/conversation-read-source.js'
import { UserTokenStore, type TokenExchange } from '../src/feishu/oauth.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const GROUP_SCOPE = 'im:message:readonly im:message.group_msg:get_as_user im:chat:readonly search:message'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

/** Source-link presentation is host display metadata, not part of the platform message snapshot. */
function returnedMessageSnapshot(item: Record<string, unknown>) {
  const { sourceLink: _sourceLink, ...snapshot } = item
  return snapshot
}

/** Real HTTP signatures, DB, policy, cache/service and token store; only platform and current-host lookup are fixtures. */
async function setup(scope = GROUP_SCOPE) {
  const registry = new Registry(':memory:'), cwd = mkdtempSync(join(tmpdir(), 'friday-message-source-'))
  cleanups.push(() => { registry.close(); rmSync(cwd, { recursive: true, force: true }) })
  const { spaces, circles, policy } = spaceDeps(registry.db)
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_owner' })
  const group = spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_other' })
  registry.createSession({ sessionKey: 'session-current', chatId: 'oc_dm', chatType: 'p2p', requesterOpenId: 'ou_owner', cwd })
  const task = registry.createTaskOnce({ sessionKey: 'session-current', messageId: 'om_request', requesterOpenId: 'ou_owner', prompt: '合成读取请求' }).task
  registry.updateTask(task.id, { status: 'running' })
  let currentRunId = 'run-original', now = Date.now()
  const grant: TokenExchange = { accessToken: 'SYNTHETIC_USER_TOKEN', expiresIn: 7200, refreshToken: 'SYNTHETIC_REFRESH', refreshTokenExpiresIn: 86400, scope }
  const provider = { exchangeCode: vi.fn(async () => grant), refresh: vi.fn(async () => ({ ...grant, accessToken: 'SYNTHETIC_REFRESHED' })) }
  const userTokens = new UserTokenStore(registry.db, provider, () => now)
  const connect = () => userTokens.complete({ openId: 'ou_owner', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  await connect()
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  const whoAmI = vi.fn(async () => ({ openId: 'ou_owner', tenantKey: 'tenant-authority' }))
  const listChatsResult = vi.fn(async () => ({ items: [{ chatId: 'oc_group', name: '可读群' }], complete: true }))
  feishu.whoAmI = whoAmI; feishu.listChatsResult = listChatsResult
  const getMessage = vi.spyOn(fake, 'getMessage'), history = vi.spyOn(fake, 'listChatHistory'), search = vi.spyOn(fake, 'searchMessageIds')
  const messageCache = new MessageCache(registry.db), readScope = new ChatReadScope(registry.db), log = createLogger('message-provenance-test', 'error')
  const capture = vi.fn<NonNullable<InternalApiDeps['onMessageRead']>>((_key, _runId, receipt) => { receipt.assertCurrent() })
  const tokens = new TokenIssuer('synthetic-signing-secret')
  const api = createInternalApi({ registry, spaces, circles, policy, feishu, userTokens, readScope, appId: 'app-synthetic',
    memory: new ChannelMemory(registry.db), messageCache, messages: new MessageService(feishu, messageCache, log),
    todos: new Todos(registry.db), tokens, log, maxHistoryPerCall: 10, onMessageRead: capture,
    resolveActorForSession: key => key === 'session-current' ? { requesterOpenId: 'ou_owner', runId: currentRunId, stage: 'task', taskId: task.id } : undefined,
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => api.server.close(err => err ? reject(err) : resolve())))
  const baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const cap = { runId: 'run-original', sessionKey: 'session-current', chatId: 'oc_dm', chatType: 'p2p' as const,
    requesterOpenId: 'ou_owner', spaceId: dm.id, cwd, scopes: ['chat:read', 'chat:read-others', 'thread:read', 'chats:list', 'file:read'] }
  const token = tokens.issue(cap)
  const post = async (path: string, body: Record<string, unknown>, signed = token) => {
    const response = await fetch(`${baseUrl}/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${signed}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const start = Math.floor((now - 60_000) / 1000) * 1000
  const item = (id: string, text: string, second = 1, chatId = 'oc_group') => historyMsg({ messageId: id, text, chatId, tenantId: 'tenant-sender', createTimeMs: start + second * 1000 })
  const range = { chat: 'oc_group', start_time: new Date(start).toISOString(), end_time: new Date(start + 10_000).toISOString() }
  const receipt = () => capture.mock.calls.at(-1)![2]
  return { registry, spaces, dm, group, task, fake, feishu, userTokens, provider, grant, connect, whoAmI, listChatsResult,
    history, getMessage, search, messageCache, readScope, capture, cap, token, tokens, post, item, range, receipt,
    replaceRun: () => { currentRunId = 'run-replacement' }, time: (value: number) => { now = value } }
}

describe('HTTP message reads and actual material provenance', () => {
  it('reads a human DM absent from the group directory only after the current user search verifies it', async () => {
    const t = await setup(GROUP_SCOPE + ' im:message.p2p_msg:get_as_user')
    const message = t.item('om_private', '本人私聊上下文', 1, 'oc_private')
    t.fake.userHistories.set('oc_private', [message])
    const find = vi.spyOn(t.fake, 'findMessagesAsUser').mockResolvedValue([{ messageId: message.messageId, chatId: 'oc_private', isP2p: true }])
    const result = await t.post('chat/history', { ...t.range, chat: 'oc_private' })
    expect(result.status).toBe(200)
    expect(find).toHaveBeenCalledWith('SYNTHETIC_USER_TOKEN', { chatIds: ['oc_private'], chatType: 'p2p', limit: 1 }, expect.any(Function))
    expect(t.history.mock.calls[0]![5]).toEqual({ userToken: 'SYNTHETIC_USER_TOKEN' })
    expect(t.receipt().conversationReads).toMatchObject({ complete: true, items: [{ chatId: 'oc_private', readIdentity: { kind: 'user', openId: 'ou_owner' } }] })
    expect(t.receipt().sources).toEqual([])
  })

  it.each(['other_chat', 'not_private', 'no_hit', 'replaced_run'])('does not read DM history after %s discovery', async mode => {
    const t = await setup(GROUP_SCOPE + ' im:message.p2p_msg:get_as_user')
    vi.spyOn(t.fake, 'findMessagesAsUser').mockImplementation(async () => {
      if (mode === 'replaced_run') t.replaceRun()
      return mode === 'no_hit' ? [] : [{ messageId: 'om_private', chatId: mode === 'other_chat' ? 'oc_other' : 'oc_private', isP2p: mode !== 'not_private' }]
    })
    expect((await t.post('chat/history', { ...t.range, chat: 'oc_private' })).status).toBe(mode === 'replaced_run' ? 403 : 404)
    expect(t.history).not.toHaveBeenCalled(); expect(t.capture).not.toHaveBeenCalled()
  })

  it.each(['before', 'during'])('respects a DM exclusion set %s discovery', async when => {
    const t = await setup(GROUP_SCOPE + ' im:message.p2p_msg:get_as_user')
    if (when === 'before') t.readScope.exclude('ou_owner', 'oc_private')
    const find = vi.spyOn(t.fake, 'findMessagesAsUser').mockImplementation(async () => {
      t.readScope.exclude('ou_owner', 'oc_private')
      return [{ messageId: 'om_private', chatId: 'oc_private', isP2p: true }]
    })
    expect((await t.post('chat/history', { ...t.range, chat: 'oc_private' })).status).toBe(403)
    if (when === 'before') expect(find).not.toHaveBeenCalled()
    expect(t.history).not.toHaveBeenCalled(); expect(t.capture).not.toHaveBeenCalled()
  })

  it('downloads attachments under the fixed user identity and captures the actual bytes separately from message metadata', async () => {
    const t = await setup()
    const attachment = { ...t.item('om_file', '附件'), msgType: 'file', fileKey: 'synthetic_file_key', fileName: 'evidence.txt' }
    t.fake.messages.set(attachment.messageId, attachment)
    const download = vi.spyOn(t.feishu, 'downloadMessageResource')
    const result = await t.post('message/file', { message_id: attachment.messageId })
    expect(result.status).toBe(200)
    expect(result.body.bytes).toBeGreaterThan(0)
    expect(t.getMessage.mock.calls[0]![1]).toEqual({ userToken: 'SYNTHETIC_USER_TOKEN' })
    expect(download.mock.calls[0]![4]).toEqual({ userToken: 'SYNTHETIC_USER_TOKEN' })
    expect(t.receipt()).toMatchObject({ complete: true, sources: [{ ref: 'feishu-file:oc_group:om_file',
      messageId: 'om_file', readIdentity: { kind: 'user', openId: 'ou_owner' },
      contentDigest: createHash('sha256').update('fake content of synthetic_file_key').digest('hex') }] })
    expect(t.receipt().conversationReads).toMatchObject({ complete: true, items: [{ kind: 'file', messageId: 'om_file',
      parentDigest: conversationDigest(t.messageCache.get(attachment.messageId)),
      resourceDigest: conversationDigest({ messageId: 'om_file', key: 'synthetic_file_key', type: 'file' }),
      contentDigest: createHash('sha256').update('fake content of synthetic_file_key').digest('hex'),
      readIdentity: { kind: 'user', openId: 'ou_owner', tenantId: 'tenant-authority' } }] })
    expect(t.receipt().conversationReads?.items).toHaveLength(1)
  })

  it('does not hand an attachment to a replaced Run after its download await', async () => {
    const t = await setup(), entered = deferred(), release = deferred()
    const attachment = { ...t.item('om_file', '附件'), msgType: 'file', fileKey: 'synthetic_file_key', fileName: 'evidence.txt' }
    t.messageCache.upsert('oc_group', [attachment])
    const download = t.feishu.downloadMessageResource.bind(t.feishu)
    vi.spyOn(t.feishu, 'downloadMessageResource').mockImplementation(async (...args) => {
      entered.resolve(); await release.promise; await download(...args)
    })
    const pending = t.post('message/file', { message_id: attachment.messageId })
    await entered.promise; t.replaceRun(); release.resolve()
    const result = await pending
    expect(result.status).toBe(403)
    expect(result.body.path).toBeUndefined()
    expect(t.capture).not.toHaveBeenCalled()
    expect(readdirSync(join(t.cap.cwd, 'downloads'))).toEqual([])
  })

  it('records only post-limit/post-keyword history and binds host run/identity instead of body claims', async () => {
    const t = await setup()
    t.fake.userHistories.set('oc_group', [t.item('om_1', '保留第一条'), t.item('om_2', '过滤掉', 2), t.item('om_3', '保留但超出limit', 3)])
    const start = Date.now()
    const result = await t.post('chat/history', { ...t.range, limit: 2, keyword: '保留', run_id: 'forged', tenant_id: 'forged', open_id: 'ou_forged' })
    expect(result.status).toBe(200)
    expect(result.body.items.map((m: { messageId: string }) => m.messageId)).toEqual(['om_1'])
    expect(t.messageCache.count('oc_group')).toBe(3) // Backfill is wider than delivered material.
    expect(t.capture).toHaveBeenCalledTimes(1)
    expect(t.capture.mock.calls[0]!.slice(0, 2)).toEqual(['session-current', 'run-original'])
    expect(t.receipt().sources).toHaveLength(1)
    expect(t.receipt()).toMatchObject({ complete: true, sources: [{ messageId: 'om_1', appId: 'app-synthetic', tenantId: 'tenant-authority',
      spaceId: t.group.id, readIdentity: { kind: 'user', openId: 'ou_owner' }, coverage: 'partial' }] })
    expect(t.receipt().sources[0]!.readAt).toBeGreaterThanOrEqual(start)
    expect(t.receipt().conversationReads).toEqual({ complete: true, items: [{ kind: 'message', appId: 'app-synthetic',
      chatId: 'oc_group', spaceId: t.group.id, messageId: 'om_1',
      readIdentity: { kind: 'user', openId: 'ou_owner', tenantId: 'tenant-authority' }, contentDigest: conversationDigest(returnedMessageSnapshot(result.body.items[0])),
      contentFields: Object.keys(returnedMessageSnapshot(result.body.items[0])) }] })
    expect(t.receipt().sources[0]!.contentDigest).toBe(t.receipt().conversationReads!.items[0]!.contentDigest)
    expect(t.history.mock.calls[0]![5]).toEqual({ userToken: 'SYNTHETIC_USER_TOKEN' })
    expect(t.whoAmI).toHaveBeenCalledTimes(1); expect(t.listChatsResult).toHaveBeenCalledTimes(1)
  })

  it('hashes the delivered cached card body after a fresh thread placeholder is merged', async () => {
    const t = await setup()
    const full = { ...t.item('om_card', '完整缓存卡片正文'), msgType: 'interactive', threadId: 'omt_group' }
    t.messageCache.upsert('oc_group', [full])
    const placeholder = { ...full, text: '[卡片]' }
    t.fake.threads.set('omt_group', [placeholder])
    const result = await t.post('thread/messages', { chat: 'oc_group', thread_id: 'omt_group' })
    expect(result.status).toBe(200)
    expect(result.body.items[0].text).toBe(full.text)
    const digest = conversationDigest
    expect(t.receipt().sources[0]!.contentDigest).toBe(digest(returnedMessageSnapshot(result.body.items[0])))
    expect(t.receipt().sources[0]!.contentDigest).not.toBe(digest(placeholder))
    expect(t.receipt().sources[0]!.tenantId).toBe('tenant-authority')
    expect(t.receipt().conversationReads).toMatchObject({ complete: true,
      items: [{ kind: 'message', messageId: full.messageId, contentDigest: conversationDigest(returnedMessageSnapshot(result.body.items[0])) }] })
    expect(t.receipt().conversationReads!.items[0]!.contentDigest).not.toBe(conversationDigest(placeholder))
  })

  it('keeps private/unknown-group search results readable but marks the whole capture incomplete', async () => {
    const t = await setup()
    const items = [t.item('om_group', '群命中'), t.item('om_private', '本人私聊', 2, 'oc_private'), t.item('om_unknown', '未证明群', 3, 'oc_unknown')]
    t.fake.searchHits = items.map(m => m.messageId)
    for (const item of items) t.fake.messages.set(item.messageId, item)
    const result = await t.post('messages/search', { query: '合成命中' })
    expect(result.status).toBe(200)
    expect(result.body.items.map((m: { messageId: string }) => m.messageId)).toEqual(items.map(m => m.messageId))
    expect(result.body.complete).toBe(true) // Search retrieval and memory provenance are different facts.
    expect(t.receipt().complete).toBe(false)
    expect(t.receipt().sources.map(source => source.messageId)).toEqual(['om_group'])
    expect(t.receipt().conversationReads).toMatchObject({ complete: true, items: items.map(item => ({
      kind: 'message', messageId: item.messageId, chatId: item.chatId, contentDigest: conversationDigest(item),
      readIdentity: { kind: 'user', openId: 'ou_owner', tenantId: 'tenant-authority' },
    })) })
    expect(t.search.mock.calls[0]![0]).toBe('SYNTHETIC_USER_TOKEN')
    expect(t.getMessage.mock.calls.every(call => call[1]?.userToken === 'SYNTHETIC_USER_TOKEN')).toBe(true)
  })

  it.each(['scope_missing', 'scope_unknown'] as const)('uses the actual user for history with %s, without manufacturing memory provenance', async mode => {
    const t = await setup(mode === 'scope_unknown' ? '' : 'im:message:readonly im:chat:readonly')
    t.fake.userHistories.set('oc_group', [t.item('om_user', '本人可读')])
    t.fake.histories.set('oc_group', [t.item('om_bot', '应用路径哨兵')])
    const result = await t.post('chat/history', t.range)
    expect(result.status).toBe(200)
    expect(result.body.items.map((m: { messageId: string }) => m.messageId)).toEqual(['om_user'])
    expect(t.receipt()).toMatchObject({ complete: false, sources: [] })
    expect(t.receipt().conversationReads).toMatchObject({ complete: true, items: [{ kind: 'message', messageId: 'om_user',
      appId: 'app-synthetic', contentDigest: conversationDigest(returnedMessageSnapshot(result.body.items[0])),
      readIdentity: { kind: 'user', openId: 'ou_owner', tenantId: 'tenant-authority' } }] })
    expect(t.history.mock.calls[0]![5]).toEqual({ userToken: 'SYNTHETIC_USER_TOKEN' })
    expect(t.fake.calls.listChats).toBe(0)
  })

  it('captures a core-only cross-conversation search without claiming persistent group-memory proof', async () => {
    const t = await setup('im:message:readonly im:chat:readonly search:message')
    const items = [t.item('om_group_a', '第一个实际命中'), t.item('om_group_b', '另一个实际命中', 2, 'oc_second'),
      t.item('om_unlisted', '目录之外的实际命中', 3, 'oc_unlisted')]
    t.fake.searchHits = items.map(item => item.messageId)
    for (const item of items) t.fake.messages.set(item.messageId, item)
    const result = await t.post('messages/search', { query: '真实意图的合成资料', app_id: 'forged-app', conversationReads: { complete: true, items: [] } })
    expect(result.status).toBe(200)
    expect(result.body.items.map((item: { messageId: string }) => item.messageId)).toEqual(items.map(item => item.messageId))
    expect(t.receipt()).toMatchObject({ complete: false, sources: [], conversationReads: { complete: true,
      items: items.map(item => ({ kind: 'message', appId: 'app-synthetic', messageId: item.messageId, chatId: item.chatId,
        contentDigest: conversationDigest(item), readIdentity: { kind: 'user', openId: 'ou_owner', tenantId: 'tenant-authority' } })) } })
    expect(t.getMessage).toHaveBeenCalledTimes(items.length)
    expect(validConversationReads(t.receipt().conversationReads)).toBe(true)
    expect(JSON.stringify(t.receipt().conversationReads)).not.toMatch(/SYNTHETIC_USER_TOKEN|tenant-sender|实际命中|forged-app/)
  })

  it.each(['user', 'app'] as const)('captures %s directory and cached-history outputs through the same host receipt hook', async identity => {
    const t = await setup('im:message:readonly im:chat:readonly')
    if (identity === 'app') {
      t.userTokens.disconnect('ou_owner')
      t.fake.chats = [{ chatId: 'oc_group', name: '合成群' }]
      t.fake.members.set('oc_group', new Set(['ou_owner']))
    }
    const item = t.item('om_cached', '缓存实际返回内容')
    t.fake.userHistories.set('oc_group', [item]); t.fake.histories.set('oc_group', [item])
    const directory = await t.post('chats', {})
    expect(directory.status).toBe(200)
    const expectedIdentity = identity === 'user' ? { kind: 'user', openId: 'ou_owner', tenantId: 'tenant-authority' } : { kind: 'app' }
    expect(t.receipt()).toMatchObject({ complete: false, sources: [], conversationReads: { complete: true, items: [{
      kind: 'directory', appId: 'app-synthetic', chatId: 'oc_group', spaceId: t.group.id,
      readIdentity: expectedIdentity, contentDigest: conversationDigest(directory.body.chats[0]),
    }] } })
    expect(t.receipt().conversationReads!.items[0]).not.toHaveProperty('messageId')
    const first = await t.post('chat/history', t.range)
    expect(first.status).toBe(200)
    const fetches = t.history.mock.calls.length
    const cached = await t.post('chat/history', t.range)
    expect(cached.status).toBe(200)
    expect(cached.body.fetched_from_api).toBe(0)
    expect(t.history).toHaveBeenCalledTimes(fetches)
    expect(t.receipt()).toMatchObject({ complete: false, sources: [], conversationReads: { complete: true, items: [{
      kind: 'message', appId: 'app-synthetic', messageId: item.messageId, chatId: item.chatId,
      readIdentity: expectedIdentity, contentDigest: conversationDigest(returnedMessageSnapshot(cached.body.items[0])),
    }] } })
    expect(t.receipt().conversationReads!.items[0]!.readIdentity).toEqual(expectedIdentity)
    expect(validConversationReads(t.receipt().conversationReads)).toBe(true)
  })

  it('returns list failure as unavailable rather than a successful empty list; global user search still returns its actual hits', async () => {
    const t = await setup()
    t.listChatsResult.mockRejectedValue(new AxiosError('synthetic listing outage', 'ECONNRESET'))
    const list = await t.post('chats', {})
    expect(list.status).toBe(503); expect(list.body.chats).toBeUndefined()
    expect(t.capture).not.toHaveBeenCalled()
    t.fake.searchHits = ['om_hit']; t.fake.messages.set('om_hit', t.item('om_hit', '普通本人搜索'))
    const result = await t.post('messages/search', { query: '搜索' })
    expect(result.status).toBe(200); expect(result.body.items).toHaveLength(1)
    expect(t.receipt()).toMatchObject({ complete: false, sources: [] })
    expect(t.receipt().conversationReads).toMatchObject({ complete: true, items: [{ kind: 'message', messageId: 'om_hit',
      contentDigest: conversationDigest(returnedMessageSnapshot(result.body.items[0])), readIdentity: { kind: 'user', tenantId: 'tenant-authority' } }] })
    expect(t.fake.calls.listChats).toBe(0)
  })

  it.each([true, false])('does not infer absence from a partial list when group capture scopes present=%s', async fullScope => {
    const t = await setup(fullScope ? GROUP_SCOPE : 'im:message:readonly im:chat:readonly')
    t.listChatsResult.mockResolvedValue({ items: [], complete: false })
    const result = await t.post('chat/history', t.range)
    expect(result.status).toBe(503)
    expect(t.history).not.toHaveBeenCalled(); expect(t.capture).not.toHaveBeenCalled()
    expect(t.messageCache.count()).toBe(0)
  })

  it('allows a positively listed group even when the rest of the fresh catalog is incomplete', async () => {
    const t = await setup()
    t.listChatsResult.mockResolvedValue({ items: [{ chatId: 'oc_group', name: '可读群' }], complete: false })
    t.fake.userHistories.set('oc_group', [t.item('om_positive', '已验证群的实际内容')])
    const result = await t.post('chat/history', t.range)
    expect(result.status).toBe(200)
    expect(result.body.items.map((m: { messageId: string }) => m.messageId)).toEqual(['om_positive'])
    expect(t.receipt()).toMatchObject({ complete: true, sources: [{ spaceId: t.group.id, messageId: 'om_positive' }] })
    expect(t.history.mock.calls[0]![5]).toEqual({ userToken: 'SYNTHETIC_USER_TOKEN' })
  })

  it('rejects refresh failure without attempting bot reads or reporting empty results', async () => {
    const t = await setup()
    t.time(t.userTokens.get('ou_owner')!.expiresAt)
    t.provider.refresh.mockRejectedValue(new Error('synthetic refresh unavailable'))
    const result = await t.post('chat/history', t.range)
    expect(result.status).toBe(503); expect(result.body.items).toBeUndefined()
    expect(t.whoAmI).not.toHaveBeenCalled(); expect(t.listChatsResult).not.toHaveBeenCalled()
    expect(t.history).not.toHaveBeenCalled(); expect(t.capture).not.toHaveBeenCalled()
    expect(t.fake.calls.listChats).toBe(0); expect(t.messageCache.count()).toBe(0)
  })

  it.each(['token', 'run', 'target-space', 'source-space'] as const)('rejects a history response after %s changed, before cache writes or capture', async change => {
    const t = await setup(), entered = deferred(), release = deferred()
    t.history.mockImplementation(async () => { entered.resolve(); await release.promise; return { items: [t.item('om_late', '迟到内容')], hasMore: false } })
    const request = t.post('chat/history', t.range)
    await entered.promise
    if (change === 'token') {
      t.provider.exchangeCode.mockResolvedValue({ ...t.grant, accessToken: 'SYNTHETIC_REPLACEMENT' }); await t.connect()
    } else if (change === 'run') t.replaceRun()
    else if (change === 'target-space') t.spaces.suspend(t.dm.id)
    else t.spaces.rebind(t.group.id, 'oc_rebound')
    release.resolve()
    const result = await request
    expect.soft(result.status).toBe(403)
    expect.soft(t.messageCache.get('om_late')).toBeUndefined()
    expect.soft(t.messageCache.coverage('oc_group')).toEqual([])
    expect.soft(t.capture).not.toHaveBeenCalled()
  })

  it('rejects a global search hit when its known source Space changes during the body fetch', async () => {
    const t = await setup(), entered = deferred(), release = deferred()
    t.fake.searchHits = ['om_global_late']
    t.getMessage.mockImplementation(async () => { entered.resolve(); await release.promise; return t.item('om_global_late', '不得重新标成无空间来源') })
    const request = t.post('messages/search', { query: '合成延迟搜索' })
    await entered.promise
    t.spaces.rebind(t.group.id, 'oc_rebound')
    release.resolve()
    const result = await request
    expect(result.status).toBe(403)
    expect(t.getMessage).toHaveBeenCalledTimes(1)
    expect(t.messageCache.get('om_global_late')).toBeUndefined()
    expect(t.capture).not.toHaveBeenCalled()
    expect(result.body.items).toBeUndefined()
  })

  it('finds the messages one person sent the owner in their one-on-one chat by sender and chat type, without a keyword', async () => {
    const t = await setup()
    // The roster knows the person; the hit lives in a one-on-one chat that no group directory lists.
    const identities = new (await import('../src/core/identities.js')).Identities(t.registry.db)
    identities.upsertFromRoster([{ login: 'shuyanshen', name: '沈书言', openId: 'ou_shuyan' }])
    const dm = t.item('om_p2p_1', '你那个 PR 我看了，晚点回', 3, 'oc_p2p_owner_shuyan')
    t.fake.messages.set(dm.messageId, { ...dm, senderOpenId: 'ou_shuyan', senderName: '沈书言' })
    t.fake.findHits = [{ messageId: dm.messageId, chatId: 'oc_p2p_owner_shuyan', fromId: 'ou_shuyan', isP2p: true }]
    const api = createInternalApi({ registry: t.registry, spaces: t.spaces, circles: spaceDeps(t.registry.db).circles, policy: spaceDeps(t.registry.db).policy,
      feishu: t.feishu, userTokens: t.userTokens, appId: 'app-synthetic', identities,
      memory: new ChannelMemory(t.registry.db), messageCache: t.messageCache, messages: new MessageService(t.feishu, t.messageCache, createLogger('p2p-test', 'error')),
      todos: new Todos(t.registry.db), tokens: t.tokens, log: createLogger('p2p-test', 'error'), maxHistoryPerCall: 10, onMessageRead: t.capture,
      resolveActorForSession: key => key === 'session-current' ? { requesterOpenId: 'ou_owner', runId: 'run-original', stage: 'task', taskId: t.task.id } : undefined })
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve, reject) => api.server.close(err => err ? reject(err) : resolve())))
    const port = (api.server.address() as AddressInfo).port
    const post = async (body: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages/search`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json() }
    }
    const result = await post({ sender: '沈书言', chat_type: 'p2p', hours_back: 48 })
    expect(result.status).toBe(200)
    expect(t.fake.findQueries.at(-1)).toEqual({ query: undefined, senderOpenIds: ['ou_shuyan'], chatType: 'p2p' })
    expect(t.search).not.toHaveBeenCalled()
    expect(JSON.stringify(result.body)).toContain('你那个 PR 我看了')
    expect(JSON.stringify(result.body)).toContain('oc_p2p_owner_shuyan')
    // A nickname the roster does not know is refused plainly instead of guessed.
    const unknown = await post({ sender: '老沈', chat_type: 'p2p', hours_back: 48 })
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toContain('没找到叫「老沈」的人')
  })

  it('refuses forged signatures and old signed Run identities before any platform read', async () => {
    const t = await setup()
    expect((await t.post('chat/history', t.range, `${t.token}x`)).status).toBe(401)
    const old = t.tokens.issue({ ...t.cap, runId: 'run-old' })
    expect((await t.post('chat/history', t.range, old)).status).toBe(403)
    expect(t.whoAmI).not.toHaveBeenCalled(); expect(t.history).not.toHaveBeenCalled(); expect(t.capture).not.toHaveBeenCalled()
  })
})
