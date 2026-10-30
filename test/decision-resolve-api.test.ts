/**
 * 包 B §5、§6 宿主接线：待拍板事项的列出 / 结清（内部 API 与 MCP），以及记录待决断时已结清的同一句问题。
 * 请求走真实的 HTTP 入口（签名 token、当前执行核对、阶段）；结清走宿主持有的同一个 DecisionApplication。
 * 用户已定：只结清本人那一条；群提案只能在原会话决定；显式停止授权提醒 / 职责提案各走领域关闭。
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import { Inbox } from '../src/core/inbox.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { ALL_SCOPES, GROUP_SCOPES, PROACTIVE_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient, cardText } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('test', 'error')
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-decision-api-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:')
  const memory = new ChannelMemory(registry.db), messageCache = new MessageCache(registry.db), todos = new Todos(registry.db)
  const routines = new RoutineStore(registry.db), inbox = new Inbox(registry.db)
  const feishu = new FakeFeishu()
  const messages = new MessageService(asFeishuClient(feishu), messageCache, log)
  const sp = spaceDeps(registry.db)
  const team = sp.spaces.ensure({ kind: 'group', chatId: 'oc_team', openId: 'ou_alice' })
  sp.spaces.addMember(team.id, 'ou_bob', 'member')
  const ops = sp.spaces.ensure({ kind: 'group', chatId: 'oc_ops', openId: 'ou_alice' })
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm_alice', openId: 'ou_alice' })
  const bobDm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm_bob', openId: 'ou_bob' })
  const tokens = new TokenIssuer('s')
  const state = { actor: { requesterOpenId: 'ou_alice', runId: 'run-a', stage: 'task' }, safe: true }
  const receipts = vi.fn<NonNullable<InternalApiDeps['recordDomainOperation']>>()
  let orchestrator!: Orchestrator
  const api = createInternalApi({ feishu: asFeishuClient(feishu), memory, registry, messages, messageCache, todos, routines, inbox, ...sp, tokens, log, maxHistoryPerCall: 50,
    resolveActorForSession: () => state.actor, canPersistDerivedState: () => state.safe, recordDomainOperation: receipts,
    pendingDecisions: (owner, context) => orchestrator.pendingDecisions(owner, context),
    resolveDecision: input => orchestrator.resolveDecision(input),
    updateRoutine: (id, patch, options) => orchestrator.updateRoutine(id, patch, options),
    refreshProposalCard: id => orchestrator.refreshProposalCard(id) })
  const { app } = createFakeAgent()
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory, messages, routines, inbox, ...sp, tokens,
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())); registry.close() })
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const caps = {
    dm: { sessionKey: 'dm:ou_alice', runId: 'run-a', chatId: dm.chatId!, chatType: 'p2p' as const, spaceId: dm.id, requesterOpenId: 'ou_alice', scopes: [...ALL_SCOPES] },
    team: { sessionKey: 'msg:team', runId: 'run-a', chatId: team.chatId!, chatType: 'group' as const, spaceId: team.id, requesterOpenId: 'ou_alice', scopes: [...GROUP_SCOPES] },
    ops: { sessionKey: 'msg:ops', runId: 'run-a', chatId: ops.chatId!, chatType: 'group' as const, spaceId: ops.id, requesterOpenId: 'ou_alice', scopes: [...GROUP_SCOPES] },
    bobTeam: { sessionKey: 'msg:team:bob', runId: 'run-a', chatId: team.chatId!, chatType: 'group' as const, spaceId: team.id, requesterOpenId: 'ou_bob', scopes: [...GROUP_SCOPES] },
    bobDm: { sessionKey: 'dm:ou_bob', runId: 'run-a', chatId: bobDm.chatId!, chatType: 'p2p' as const, spaceId: bobDm.id, requesterOpenId: 'ou_bob', scopes: [...ALL_SCOPES] },
  }
  const post = async (path: string, cap: Omit<Capability, 'exp'>, body: Record<string, unknown> = {}) => {
    state.actor.requesterOpenId = cap.requesterOpenId ?? ''
    const res = await fetch(`${base}/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${tokens.issue(cap)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as Record<string, any> }
  }
  const tool = async (cap: Omit<Capability, 'exp'>, name: string, args: Record<string, unknown> = {}) => {
    state.actor.requesterOpenId = cap.requesterOpenId ?? ''
    const server = buildServer({ apiUrl: base, token: tokens.issue(cap) })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    cleanups.push(() => client.close())
    const res = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean }
    return res.content.map(item => item.text).join('\n')
  }
  const ask = async (cap: Omit<Capability, 'exp'>, question: string, extra: Record<string, unknown> = {}) => (await post('inbox/decision', cap, { question, ...extra })).body
  return { registry, routines, inbox, feishu, orchestrator, sp, team, ops, dm, state, receipts, caps, post, tool, ask }
}

const QUESTION = '发布优先级定 P1 还是 P2？'

describe('pending decisions: list and resolve only the owner’s own item', () => {
  it('“上次问我的优先级就按 P2，不用再挂着了” settles only that item, keeps the conclusion, and a replay changes nothing', async () => {
    const t = await fixture()
    const mine = await t.ask(t.caps.team, QUESTION)
    const otherGroup = await t.ask(t.caps.ops, QUESTION)
    const bobs = await t.ask(t.caps.bobTeam, QUESTION)
    expect(mine).toMatchObject({ version: 1, created: true, already_open: false })
    const listed = await t.post('decision/list', t.caps.dm)
    expect(listed.status).toBe(200)
    expect(listed.body.items.map((item: { id: number }) => item.id).sort()).toEqual([mine.id, otherGroup.id].sort())
    expect(listed.body.items.find((item: { id: number }) => item.id === mine.id)).toMatchObject({ version: 1, kind: 'decision', title: QUESTION })

    const resolved = await t.post('decision/resolve', t.caps.dm, { id: mine.id, version: 1, resolution: 'decided', note: '按 P2' })
    expect(resolved).toMatchObject({ status: 200, body: { outcome: 'resolved', changed: true, resolution: 'decided', note: '按 P2', message: '已结清（定了），结论记为「按 P2」。' } })
    expect(t.inbox.get(mine.id)).toMatchObject({ resolution: 'decided', resolvedBy: 'ou_alice', resolutionNote: '按 P2' })
    expect(t.inbox.get(otherGroup.id)?.resolvedAt).toBeNull()
    expect(t.inbox.get(bobs.id)?.resolvedAt).toBeNull()
    expect(t.receipts).toHaveBeenLastCalledWith('dm:ou_alice', 'run-a', { kind: 'decision_resolve', id: mine.id, title: QUESTION, outcome: 'resolved', changed: true })
    expect((await t.post('decision/list', t.caps.dm)).body.items.map((item: { id: number }) => item.id)).toEqual([otherGroup.id])

    const before = t.registry.db.prepare('SELECT * FROM inbox_items ORDER BY id').all()
    expect((await t.post('decision/resolve', t.caps.dm, { id: mine.id, version: 1, resolution: 'decided', note: '按 P2' })).body)
      .toMatchObject({ outcome: 'already_resolved', changed: false, message: '已经按同样的结论处理过，没有改动。' })
    expect((await t.post('decision/resolve', t.caps.dm, { id: mine.id, version: 1, resolution: 'dropped' })).body)
      .toMatchObject({ outcome: 'conflict', changed: false, message: '之前已按“定了”处理，没有改动。' })
    expect(t.registry.db.prepare('SELECT * FROM inbox_items ORDER BY id').all()).toEqual(before)
  })

  it('in a group only lists and settles that group’s items of the requester, and never reveals whose item a guessed id is', async () => {
    const t = await fixture()
    const mine = await t.ask(t.caps.team, QUESTION)
    const otherGroup = await t.ask(t.caps.ops, QUESTION)
    expect((await t.post('decision/list', t.caps.team)).body.items.map((item: { id: number }) => item.id)).toEqual([mine.id])
    expect(await t.post('decision/resolve', t.caps.team, { id: otherGroup.id, version: 1, resolution: 'dropped' }))
      .toMatchObject({ status: 403, body: { error: '这件事不是在这个群里提的，请在私聊或原来的群里处理' } })
    expect(await t.post('decision/resolve', t.caps.bobTeam, { id: mine.id, version: 1, resolution: 'dropped' }))
      .toMatchObject({ status: 403, body: { error: '没有这件待拍板的事，或它不归你' } })
    expect(t.receipts).toHaveBeenLastCalledWith('msg:team:bob', 'run-a', { kind: 'operation_failed', operation: 'decision_resolve', id: mine.id })
    expect((await t.post('decision/resolve', t.caps.team, { id: 999999, version: 1, resolution: 'dropped' })).status).toBe(404)
    for (const body of [{ id: mine.id, resolution: 'dropped' }, { id: mine.id, version: 0, resolution: 'dropped' }, { id: String(mine.id), version: 1, resolution: 'dropped' },
      { id: mine.id, version: 1, resolution: 'maybe' }]) {
      expect((await t.post('decision/resolve', t.caps.team, body)).status).toBe(400)
    }
    expect(t.inbox.get(mine.id)?.resolvedAt).toBeNull()
    expect(t.inbox.get(otherGroup.id)?.resolvedAt).toBeNull()
    expect((await t.post('decision/resolve', t.caps.team, { id: mine.id, version: 1, resolution: 'dropped' })).body).toMatchObject({ outcome: 'resolved' })
  })

  it('does not reopen an answered question by default; an explicit reopen is a new version the old reference cannot close', async () => {
    const t = await fixture()
    const first = await t.ask(t.caps.team, QUESTION)
    await t.post('decision/resolve', t.caps.team, { id: first.id, version: 1, resolution: 'decided', note: '按 P2' })
    expect(await t.ask(t.caps.team, QUESTION)).toEqual({ id: first.id, version: 1, already_open: false, already_resolved: true, resolution: 'decided', note: '按 P2' })
    expect(t.inbox.pending('ou_alice')).toEqual([])
    const reopened = await t.ask(t.caps.team, QUESTION, { reopen: true })
    expect(reopened).toEqual({ id: first.id, version: 2, already_open: false, reopened: true })
    expect(await t.ask(t.caps.team, QUESTION, { reopen: true })).toMatchObject({ id: first.id, version: 2, already_open: true })
    expect((await t.post('decision/resolve', t.caps.team, { id: first.id, version: 1, resolution: 'dropped' })).body)
      .toMatchObject({ outcome: 'stale', changed: false, version: 2 })
    expect(t.inbox.get(first.id)).toMatchObject({ version: 2, resolvedAt: null, resolution: null, resolutionNote: null })
    expect((await t.post('decision/list', t.caps.team)).body.items).toMatchObject([{ id: first.id, version: 2 }])
  })

  it('is only available to the person’s own current interactive task', async () => {
    const t = await fixture()
    const mine = await t.ask(t.caps.team, QUESTION)
    expect((await t.post('decision/list', { ...t.caps.team, scopes: [...PROACTIVE_SCOPES].filter(s => s !== 'todo:read') })).status).toBe(403)
    expect((await t.post('decision/resolve', { ...t.caps.team, scopes: ['todo:read'] }, { id: mine.id, version: 1, resolution: 'dropped' })).status).toBe(403)
    t.state.actor.stage = 'routine'
    expect((await t.post('decision/list', t.caps.team)).status).toBe(403)
    expect((await t.post('decision/resolve', t.caps.team, { id: mine.id, version: 1, resolution: 'dropped' })).status).toBe(403)
    t.state.actor.stage = 'task'
    t.state.safe = false
    expect((await t.post('decision/list', t.caps.team)).status).toBe(200)
    expect((await t.post('decision/resolve', t.caps.team, { id: mine.id, version: 1, resolution: 'dropped' })).status).toBe(403)
    expect(t.inbox.get(mine.id)?.resolvedAt).toBeNull()
  })
})

describe('domain pointers go back to their own domain', () => {
  it('a responsibility proposal is decided only in its own group: “不用了” there ignores it and refreshes the card; elsewhere it points to the card', async () => {
    const t = await fixture()
    const proposed = await t.post('responsibility/propose', t.caps.team, { name: '每周五整理项目风险', reason: '每周都有人问', prompt: '整理风险清单', schedule: { type: 'daily', at: '17:00', days: [5] } })
    expect(proposed.status).toBe(200)
    const pointer = t.inbox.find('responsibility', proposed.body.id, 'ou_alice')!
    expect((await t.post('decision/resolve', t.caps.dm, { id: pointer.id, version: pointer.version, resolution: 'dropped' })).body)
      .toMatchObject({ outcome: 'use_domain', domain: 'responsibility', message: expect.stringContaining('在提案卡上选“接受”或“忽略”') })
    expect((await t.post('decision/resolve', t.caps.team, { id: pointer.id, version: pointer.version, resolution: 'decided' })).body)
      .toMatchObject({ outcome: 'use_domain', domain: 'responsibility' })
    expect(t.routines.get(proposed.body.id)?.status).toBe('proposed')

    const dropped = await t.post('decision/resolve', t.caps.team, { id: pointer.id, version: pointer.version, resolution: 'dropped' })
    expect(dropped.body).toMatchObject({ outcome: 'proposal', changed: true, proposal: { outcome: 'ignored' }, message: '已忽略这条职责提案，提醒一并结清。' })
    expect(t.routines.get(proposed.body.id)).toMatchObject({ status: 'ignored', decidedBy: 'ou_alice' })
    expect(t.inbox.get(pointer.id)).toMatchObject({ resolution: 'domain', resolutionNote: 'ignored' })
    const card = t.feishu.of('patchCard').at(-1)!
    expect(card.target).toBe(t.routines.get(proposed.body.id)!.cardMessageId)
    expect(cardText(card.payload as Record<string, unknown>)).toContain('已忽略')
    expect((await t.post('decision/resolve', t.caps.team, { id: pointer.id, version: pointer.version, resolution: 'dropped' })).body)
      .toMatchObject({ outcome: 'settled_by_domain', changed: false, message: '这件事之前就已经不用处理了：提案已被忽略。' })
  })

  it('a pointer left behind after its proposal was already decided is settled by the domain, not by the person', async () => {
    const t = await fixture()
    const proposed = await t.post('responsibility/propose', t.caps.team, { name: '每周五整理项目风险', reason: '每周都有人问', prompt: '整理风险清单', schedule: { type: 'daily', at: '17:00', days: [5] } })
    const pointer = t.inbox.find('responsibility', proposed.body.id, 'ou_alice')!
    // 改造前的两步写：接受了提案，却没结清指针
    t.routines.accept(proposed.body.id, 'ou_alice')
    expect((await t.post('decision/resolve', t.caps.dm, { id: pointer.id, version: pointer.version, resolution: 'dropped' })).body)
      .toMatchObject({ outcome: 'settled_by_domain', changed: true, message: '这件事已经不用处理了：提案已被接受，已一并结清。' })
    expect(t.inbox.get(pointer.id)).toMatchObject({ resolution: 'domain', resolutionNote: 'accepted' })
    expect(t.routines.get(proposed.body.id)?.status).toBe('active')
  })

  it('an authorization reminder is handled by re-authorizing or pausing watches, not by saying “不用了”', async () => {
    const t = await fixture()
    const watch = t.routines.add({ kind: 'watch', ownerOpenId: 'ou_alice', spaceId: t.dm.id, chatId: t.dm.chatId!, chatType: 'p2p', name: '盯发布', prompt: '发布阻塞',
      schedule: { type: 'daily', at: '09:00' }, watchChatIds: ['oc_team'] })
    t.routines.suspendForExpiredAuth('ou_alice')
    const auth = t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'auth', refId: watch.id, title: '1 个盯群停了' })
    expect((await t.post('decision/resolve', t.caps.dm, { id: auth.id, version: auth.version, resolution: 'dropped' })).body)
      .toMatchObject({ outcome: 'use_domain', domain: 'auth', message: expect.stringContaining('重新授权') })
    expect(t.inbox.get(auth.id)?.resolvedAt).toBeNull()
    // 暂停那条关注之后，这个人名下已没有在等授权的关注：提醒按领域结清
    t.orchestrator.controlRoutine(watch.id, 'pause')
    expect(t.inbox.get(auth.id)).toMatchObject({ resolution: 'domain', resolutionNote: 'no_longer_waiting' })
  })
})

describe('MCP tools for pending decisions', () => {
  it('lists with ids and versions, relays the host message, and tells the model not to ask an answered question again', async () => {
    const t = await fixture()
    const mine = await t.ask(t.caps.team, QUESTION, { why: '两个都有人在等' })
    const listed = await t.tool(t.caps.dm, 'friday_decision_list')
    expect(listed).toContain(`[decision:${mine.id} v1] 待决断：${QUESTION}（两个都有人在等）`)
    expect(await t.tool(t.caps.dm, 'friday_decision_resolve', { id: mine.id, version: 1, resolution: 'decided', note: '按 P2' })).toBe('已结清（定了），结论记为「按 P2」。')
    expect(await t.tool(t.caps.dm, 'friday_decision_list')).toBe('这个会话里没有等他拍板的事。')
    expect(await t.tool(t.caps.team, 'friday_needs_decision', { question: QUESTION })).toContain('这件事他之前已经定过了：「按 P2」')
    expect(await t.tool(t.caps.team, 'friday_needs_decision', { question: QUESTION, reopen: true })).toContain('重新记下了')
    expect(await t.tool(t.caps.bobDm, 'friday_decision_resolve', { id: mine.id, version: 2, resolution: 'dropped' })).toContain('工具调用失败')
  })

  it('editing a proposal through MCP says it is still a proposal and that the card now shows the new content', async () => {
    const t = await fixture()
    const proposed = await t.post('responsibility/propose', t.caps.team, { name: '每周五整理项目风险', reason: '每周都有人问', prompt: '整理风险清单', schedule: { type: 'daily', at: '17:00', days: [5] } })
    const text = await t.tool(t.caps.team, 'friday_routine_update', { id: proposed.body.id, prompt: '整理风险清单并标出负责人' })
    expect(text).toContain('已改职责提案「每周五整理项目风险」')
    expect(text).toContain('这还是提案，接受前不会运行')
    expect(text).toContain('提案卡已换成新内容')
    expect(JSON.stringify(t.feishu.of('patchCard').at(-1)!.payload)).toContain(`"v":${t.routines.configVersion(proposed.body.id)}`)
    expect(await t.tool(t.caps.team, 'friday_routine_update', { id: proposed.body.id, archive: 'doc' })).toContain('提案还没接受，接受后再设置结果存放位置')
  })
})
