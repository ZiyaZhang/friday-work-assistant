/**
 * 我的一天接进宿主之后的两个入口：机器人菜单“我的任务”，以及本人私聊当前 Run 里的 friday_my_day。
 * 真实 Orchestrator、SQLite 领域表、签名 HTTP 与 MCP SDK；只有 ACP 与飞书传输是合成的。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { SourceContexts } from '../src/core/source-context.js'
import { spaceScope } from '../src/core/space.js'
import { TodoApplication } from '../src/core/todo-application.js'
import { Todos } from '../src/core/todos.js'
import { Inbox } from '../src/core/inbox.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { buildServer } from '../src/mcp/server.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('my-day-host-wiring', 'error')
const closes: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
type Reply = { isError?: boolean; content: { type: string; text?: string }[] }
const output = (reply: Reply) => reply.content.map(item => item.text ?? '').join('\n')

function menuFixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-my-day-menu-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off' })
  const registry = new Registry(':memory:'), sp = spaceDeps(registry.db)
  closes.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  const feishu = new FakeFeishu()
  feishu.chats = [{ chatId: 'oc_rd', name: '研发群' }, { chatId: 'oc_left', name: '已离开的群' }]
  feishu.members.set('oc_rd', new Set(['ou_me', 'ou_boss']))
  feishu.members.set('oc_left', new Set(['ou_boss']))
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm_me', openId: 'ou_me' })
  const rd = sp.spaces.ensure({ kind: 'group', chatId: 'oc_rd', openId: 'ou_boss' })
  const left = sp.spaces.ensure({ kind: 'group', chatId: 'oc_left', openId: 'ou_boss' })
  const todos = new Todos(registry.db), inbox = new Inbox(registry.db)
  const orchestrator = new Orchestrator({ cfg, registry, todos, inbox, routines: new RoutineStore(registry.db), ...sp,
    feishu: asFeishuClient(feishu), runtime: {} as AcpRuntime, memory: new ChannelMemory(registry.db), tokens: new TokenIssuer('menu'),
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/unused', botOpenId: 'ou_bot', log })
  const menu = async () => {
    await orchestrator.handleMenu({ eventKey: 'my_tasks', operatorOpenId: 'ou_me', raw: {} })
    const sent = feishu.of('sendToUser').at(-1)!
    expect(sent.target).toBe('ou_me')
    return (sent.payload as { markdown: string }).markdown
  }
  return { registry, sp, feishu, dm, rd, left, todos, inbox, orchestrator, menu }
}

describe('menu “我的任务” uses the same My Day rules', () => {
  it('shows only items visible in their original group, counts the rest, and never counts a named colleague’s DM item', async () => {
    const t = menuFixture()
    t.todos.add({ scope: spaceScope(t.dm.id), title: '我自己记的周报' })
    t.todos.add({ scope: spaceScope(t.dm.id), title: '帮小王记：交接口文档', owner: '小王' })
    t.todos.add({ scope: spaceScope(t.rd.id), title: '评审研发群方案', ownerOpenId: 'ou_me', createdBy: 'ou_boss' })
    t.todos.add({ scope: spaceScope(t.left.id), title: '已离开群里的旧事', ownerOpenId: 'ou_me', createdBy: 'ou_boss' })
    t.inbox.add({ ownerOpenId: 'ou_me', kind: 'decision', spaceId: t.dm.id, title: '要不要续订工具', now: Date.now() - 3600_000 })
    const text = await t.menu()
    expect(text).not.toContain('进行中')
    expect(text).toContain('我自己记的周报')
    expect(text).toContain('评审研发群方案')
    expect(text).toContain('「研发群」')
    expect(text).toContain('要不要续订工具')
    // Left group: only a count, never the title. A name-only item for 小王 is nobody's item.
    expect(text).not.toContain('已离开群里的旧事')
    expect(text).toContain('有 1 条待办没有显示内容')
    expect(text).not.toContain('帮小王记')
    // No personal calendar grant: an honest gap, never “今天没有日程”, and no authorization card.
    expect(text).toContain('日历没有读取')
    expect(text).not.toContain('今天没有日程')
    expect(text).toContain('定时任务：没有')
    expect(text).not.toMatch(/\b(ou|oc)_[a-z]/)
    expect(t.feishu.of('sendToUser')).toHaveLength(1)
  })

  it('explains a private-summary refusal and an unreadable summary without pretending the day is empty', async () => {
    const t = menuFixture()
    t.todos.add({ scope: spaceScope(t.rd.id), title: '评审研发群方案', ownerOpenId: 'ou_me' })
    t.sp.spaces.suspend(t.dm.id)
    const denied = await t.menu()
    expect(denied).toContain('个人汇总只能在你和 Friday 的私聊里查看')
    expect(denied).not.toContain('评审研发群方案')
    t.sp.spaces.resume('oc_dm_me')
    vi.spyOn(t.feishu, 'chatMemberOpenIds').mockRejectedValue(new TypeError('synthetic programming failure'))
    const failed = await t.menu()
    expect(failed).toContain('个人汇总这次没有读到')
    expect(failed).toContain('不表示今天没有日程或待办')
    expect(failed).not.toContain('评审研发群方案')
  })
})

const ALICE = 'ou_aa', BOB = 'ou_bb', GROUP = 'oc_my_day_group'
async function managedFixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-my-day-host-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '15000', FRIDAY_DEFAULT_EXECUTION: 'managed' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(join(home, 'db')), memory = new ChannelMemory(registry.db), todos = new Todos(registry.db)
  const inbox = new Inbox(registry.db), routines = new RoutineStore(registry.db)
  const application = new TodoApplication({ db: registry.db, todos }), sp = spaceDeps(registry.db)
  const group = sp.spaces.ensure({ kind: 'group', chatId: GROUP, openId: BOB, title: '产品群' })
  sp.spaces.addMember(group.id, ALICE, 'member')
  const fake = new FakeFeishu(); fake.chats = [{ chatId: GROUP, name: '产品群' }]; fake.members.set(GROUP, new Set([ALICE, BOB]))
  const feishu = asFeishuClient(fake)
  const cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const tokens = new TokenIssuer('synthetic-my-day-host'), execution = managedHostRuntime(registry, home, log)
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, inbox, routines, todoApplication: application, feishu, messages, tokens,
    runtime: execution.runtime, managed: execution.managed, botOpenId: 'bot', log,
    ingressClassifier: { classify: async () => ({ kind: 'new_work' }) }, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent' })
  const api = createInternalApi({ registry, ...sp, memory, todos, inbox, routines, todoApplication: application, get myDay() { return host.myDay },
    feishu, messages, messageCache: cache, appId: cfg.feishu.appId, tokens, log, maxHistoryPerCall: 20,
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPersistDerivedState: (key, purpose) => host.canPersistDerivedState(key, purpose), captureTodoProvenance: (key, run) => host.captureTodoProvenance(key, run),
    onExternalSourceRead: (key, read) => host.noteExternalSource(key, read) })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const current = () => {
    const prompt = execution.peer.state.allPrompts.at(-1)!, session = registry.getSessionByAcpId(prompt.sessionId)!
    const servers = prompt.mcpServers as { env: { name: string; value: string }[] }[]
    return { session, token: servers[0]!.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value }
  }
  const call = async (name: string, args: Record<string, unknown>) => {
    const server = buildServer({ apiUrl: base, token: current().token }), client = new Client({ name: 'my-day-host', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    try { return await client.callTool({ name, arguments: args }) as Reply } finally { await client.close(); await server.close() }
  }
  const post = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { authorization: `Bearer ${current().token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  let serial = 0
  const during = async (work: () => Promise<void>, where: 'p2p' | 'group' = 'p2p') => {
    let failed: { error: unknown } | undefined, called = false
    const messageId = `my-day-request-${++serial}`
    execution.peer.state.script = [{ kind: 'hook', run: async () => { called = true; try { await work() } catch (error) { failed = { error } } } },
      { kind: 'text', text: '今天的安排已经整理好了。' }]
    await host.handleMessage({ eventId: messageId, messageId, chatId: where === 'p2p' ? `dm-${ALICE}` : GROUP, chatType: where, senderOpenId: ALICE,
      senderType: 'user', tenantId: 'synthetic-tenant', msgType: 'text', text: where === 'p2p' ? '今天我有哪些事？' : '@Friday 今天我有哪些事？',
      mentions: where === 'group' ? [{ key: '@bot', openId: 'bot', name: 'Friday' }] : [], createTimeMs: Date.now(),
      ...(where === 'group' ? { threadId: 'omt-my-day' } : {}) })
    expect(called).toBe(true); if (failed) throw failed.error
  }
  closes.push(async () => {
    api.beginShutdown(); api.server.closeAllConnections(); expect((await api.waitForShutdown(3000)).drained).toBe(true)
    await new Promise<void>(resolve => api.server.close(() => resolve()))
    await execution.runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true })
  })
  return { registry, host, fake, group, todos, inbox, call, post, current, during }
}

describe('friday_my_day inside the person’s own private Run', () => {
  it('registers what was shown as this Run’s sources, lets the person keep a private todo from it, and answers only in the private chat', async () => {
    const t = await managedFixture()
    const assigned = t.todos.add({ scope: spaceScope(t.group.id), title: '评审群内方案', ownerOpenId: ALICE, createdBy: BOB })
    await t.during(async () => {
      const reply = await t.call('friday_my_day', {})
      expect(reply.isError, output(reply)).not.toBe(true)
      const value = JSON.parse(output(reply)) as { result: { todos: { items: { id: number; place: string | null }[] } }; text: string }
      expect(value.result.todos.items).toMatchObject([{ id: assigned.id, place: '产品群' }])
      expect(value.text).toContain('日历没有读取')
      const context = new SourceContexts(t.registry).get(t.current().session.sessionKey)!
      expect(context.myDaySources).toMatchObject([{ kind: 'todo', id: assigned.id, sourceChatId: GROUP, viewerOpenId: ALICE }])
      expect(context.chats).toEqual([])
      // The rows My Day showed are the person's own items from groups they are in; in their own private chat
      // (one continuous conversation since 2026-09-29) that may become a private todo of theirs.
      const add = await t.post('/v1/todo/add', { title: '把群里的方案抄一份' })
      expect(add.status).toBe(200)
      expect(t.todos.list(`space:sp_dm_${ALICE}`, { status: 'all' })).toMatchObject([{ title: '把群里的方案抄一份' }])
    })
    const answers = t.fake.sent.filter(item => JSON.stringify(item.payload).includes('今天的安排已经整理好了'))
    expect(answers).toHaveLength(1)
    expect(answers[0]!.target).toBe(`dm-${ALICE}`)
  })

  it('does not deliver the answer after the person left the original group during the Run', async () => {
    const t = await managedFixture()
    t.todos.add({ scope: spaceScope(t.group.id), title: '评审群内方案', ownerOpenId: ALICE, createdBy: BOB })
    await t.during(async () => {
      const reply = await t.call('friday_my_day', {})
      expect(reply.isError, output(reply)).not.toBe(true)
      expect(output(reply)).toContain('评审群内方案')
      t.fake.members.set(GROUP, new Set([BOB]))
    })
    expect(t.fake.sent.some(item => JSON.stringify(item.payload).includes('今天的安排已经整理好了'))).toBe(false)
    expect(t.fake.sent.some(item => JSON.stringify(item.payload).includes('评审群内方案'))).toBe(false)
  })

  it('is refused in a group Run, without registering any source there', async () => {
    const t = await managedFixture()
    t.todos.add({ scope: spaceScope(t.group.id), title: '评审群内方案', ownerOpenId: ALICE, createdBy: BOB })
    await t.during(async () => {
      const reply = await t.call('friday_my_day', {})
      expect(reply.isError).toBe(true)
      expect(output(reply)).not.toContain('评审群内方案')
      expect((await t.post('/v1/my-day', {})).status).toBe(403)
      const context = new SourceContexts(t.registry).get(t.current().session.sessionKey)
      expect(context?.myDaySources).toBeUndefined()
    }, 'group')
  })
})
