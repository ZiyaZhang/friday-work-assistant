/**
 * 读取范围的执行层：默认全开，停读之后模型就读不到了。
 *
 * 这组用例守的是"停读不能被绕过"。最关键的一条是**跨群搜索**：
 * 私聊里的全局搜索是跨所有群和单聊的，只在读历史那里过滤，一次搜索就把停掉的群全拿回来了。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { ChatReadScope } from '../src/core/chat-read-scope.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { UserTokenStore, type TokenExchange } from '../src/feishu/oauth.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

const OTHER = 'oc_other', SECRET = 'oc_secret', DM = 'oc_dm'

async function setup(opts: { withScope?: boolean } = {}) {
  const registry = new Registry(':memory:')
  const cwd = mkdtempSync(join(tmpdir(), 'friday-grant-'))
  cleanups.push(() => { registry.close(); rmSync(cwd, { recursive: true, force: true }) })
  const sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'p2p', chatId: DM, openId: 'ou_owner' })
  const fake = new FakeFeishu()
  const feishu = asFeishuClient(fake)
  const log = createLogger('grant-enforcement', 'error')
  const memory = new ChannelMemory(registry.db)

  const exchange: TokenExchange = { accessToken: 'SYNTHETIC_USER_TOKEN', expiresIn: 7200, refreshToken: 'R', refreshTokenExpiresIn: 86400, scope: 'im:chat:readonly im:message:readonly im:message.group_msg:get_as_user search:message' }
  const userTokens = new UserTokenStore(registry.db, { exchangeCode: vi.fn(async () => exchange), refresh: vi.fn(async () => exchange) })
  await userTokens.complete({ openId: 'ou_owner', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  fake.whoAmI = vi.fn(async () => ({ openId: 'ou_owner', tenantKey: 'tenant-a' }))
  const chatList = [{ chatId: OTHER, name: '数仓对接群' }, { chatId: SECRET, name: '管理层群' }, { chatId: DM, name: '与我的私聊' }]
  fake.listChatsResult = vi.fn(async () => ({ items: chatList, complete: true }))
  fake.listChats = vi.fn(async () => chatList)
  const ago = Date.now() - 60_000
  fake.histories.set(OTHER, [historyMsg({ messageId: 'om_o1', chatId: OTHER, text: '数仓的消息', createTimeMs: ago })])
  fake.histories.set(SECRET, [historyMsg({ messageId: 'om_s1', chatId: SECRET, text: '管理层的消息', createTimeMs: ago })])
  fake.histories.set(DM, [historyMsg({ messageId: 'om_d1', chatId: DM, text: '私聊里的消息', createTimeMs: ago })])
  for (const m of [...fake.histories.get(OTHER)!, ...fake.histories.get(SECRET)!]) fake.messages.set(m.messageId, m)
  fake.searchHits = ['om_o1', 'om_s1']

  registry.createSession({ sessionKey: 'session-a', chatId: DM, chatType: 'p2p', cwd, requesterOpenId: 'ou_owner' })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'om_now', requesterOpenId: 'ou_owner', prompt: '找一下' }).task
  registry.updateTask(task.id, { status: 'running' })
  const memoryHost = memoryRuntimeFixture(registry, memory)
  memoryHost.pin({ runId: 'run-1', sessionKey: 'session-a', actorOpenId: 'ou_owner', taskId: task.id })

  const scope = new ChatReadScope(registry.db)
  const messageCache = new MessageCache(registry.db)
  const api = createInternalApi({
    registry, ...sp, feishu, userTokens, appId: 'app-a', messageCache,
    memory, memoryRuntime: memoryHost.runtime, todos: new Todos(registry.db),
    messages: new MessageService(feishu, messageCache, log),
    ...(opts.withScope === false ? {} : { readScope: scope }),
    tokens: new TokenIssuer('synthetic'), log, maxHistoryPerCall: 50,
    resolveActorForSession: () => ({ requesterOpenId: 'ou_owner', runId: 'run-1', stage: 'task', taskId: task.id }),
  } as InternalApiDeps)
  const cap: Capability & { boundRunId?: string; boundStage?: string } = {
    runId: 'run-1', sessionKey: 'session-a', chatId: DM, chatType: 'p2p', spaceId: space.id,
    requesterOpenId: 'ou_owner', cwd, boundRunId: 'run-1', boundStage: 'task', scopes: [...ALL_SCOPES], exp: 9999999999,
  }
  const call = (path: string, body: Record<string, unknown> = {}) => api.routes[`POST /v1/${path}`]!(cap, body)
  return { scope, fake, call, cap }
}

describe('读取范围执行', () => {
  it('默认全开：没停读时别人的群都能读', async () => {
    const t = await setup()
    const r = await t.call('chats') as { chats: { chat_id: string }[] }
    const ids = r.chats.map(c => c.chat_id)
    expect(ids).toContain(OTHER)
    expect(ids).toContain(SECRET)
    expect(((await t.call('chat/history', { chat: SECRET })) as { items: unknown[] }).items.length).toBeGreaterThan(0)
  })

  it('停读之后被拒，而且告诉人该怎么恢复', async () => {
    const t = await setup()
    t.scope.exclude('ou_owner', SECRET)
    await expect(t.call('chat/history', { chat: SECRET })).rejects.toMatchObject({
      // 点名是哪个会话 + 怎么恢复；恢复的说法是"跟我说一声"，不是一个他未必知道的命令。
      status: 403, message: expect.stringContaining('恢复'),
    })
    await expect(t.call('chat/history', { chat: SECRET })).rejects.toMatchObject({ message: expect.stringContaining('管理层群') })
    // 停一个只停这一个
    expect(((await t.call('chat/history', { chat: OTHER })) as { items: unknown[] }).items.length).toBeGreaterThan(0)
  })

  it('停读的群从群列表里消失', async () => {
    const t = await setup()
    t.scope.exclude('ou_owner', SECRET)
    const ids = ((await t.call('chats')) as { chats: { chat_id: string }[] }).chats.map(c => c.chat_id)
    expect(ids).toContain(OTHER)
    expect(ids).not.toContain(SECRET)
  })

  it('**跨群搜索绕不过停读**：停掉的会话命中不返回正文，并说明原因', async () => {
    const t = await setup()
    t.scope.exclude('ou_owner', SECRET)
    const r = await t.call('messages/search', { query: '消息' }) as { items: { chatId: string }[]; note: string }
    expect(r.items.map(i => i.chatId)).toEqual([OTHER])
    expect(r.note).toContain('停读')
    expect(r.note).toContain('/groups')
  })

  it('没停读时全局搜索是全量的', async () => {
    const t = await setup()
    const r = await t.call('messages/search', { query: '消息' }) as { items: { chatId: string }[] }
    expect(r.items.map(i => i.chatId).sort()).toEqual([OTHER, SECRET].sort())
  })

  it('恢复之后立刻又能读，不用等任何后台任务', async () => {
    const t = await setup()
    t.scope.exclude('ou_owner', OTHER)
    await expect(t.call('chat/history', { chat: OTHER })).rejects.toMatchObject({ status: 403 })
    t.scope.restore('ou_owner', OTHER)
    expect(((await t.call('chat/history', { chat: OTHER })) as { items: unknown[] }).items.length).toBeGreaterThan(0)
  })

  it('本会话自己永远可读，停不掉也不需要恢复', async () => {
    const t = await setup()
    t.scope.exclude('ou_owner', DM)
    const r = await t.call('chat/history', {}) as { chat_id: string }
    expect(r.chat_id).toBe(DM)
  })

  it('没装范围管理的部署就是纯粹全开', async () => {
    const t = await setup({ withScope: false })
    const r = await t.call('chat/history', { chat: SECRET }) as { items: unknown[] }
    expect(r.items.length).toBeGreaterThan(0)
  })
})
