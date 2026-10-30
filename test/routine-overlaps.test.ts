/**
 * P4-2 G9：重叠的职责交给人决定。RoutineStore.overlaps 判定「同一组关注群」或「同一受众且同一归档目标」且下次运行相差 ≤45 分钟；
 * 新建 / 修改 / 接受后由 RoutineApplication 登记一条 Inbox 待决定（一对只登记一次）；人的决定走现有待拍板结清：
 * 保留两条 / 暂停 A / 暂停 B（复用现有暂停）；不自动去重。真实 Store / Application / 内部 API / MCP；飞书与模型合成。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { DecisionApplication, overlapChoice } from '../src/core/decision-application.js'
import { Inbox, decisionRef } from '../src/core/inbox.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RoutineApplication } from '../src/core/routine-application.js'
import { OVERLAP_WINDOW_MS, RoutineStore, type RoutineOverlap } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import { UserTokenStore, USER_SCOPE_TIERS } from '../src/feishu/oauth.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('routine-overlaps', 'error')
const TZ = 480
/** 2026-09-25 09:00 北京时间 */
const START = Date.UTC(2026, 8, 25, 1)
const MIN = 60_000
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

const summary = (list: RoutineOverlap[]) => list.map(o => [o.routine.name, o.reason, o.gapMs / MIN])

describe('RoutineStore.overlaps', () => {
  function fixture() {
    const registry = new Registry(':memory:')
    cleanup.push(() => registry.close())
    const routines = new RoutineStore(registry.db, TZ)
    const add = (over: Partial<Parameters<RoutineStore['add']>[0]> & { at?: string } = {}) => {
      const { at, ...rest } = over
      return routines.add({ kind: 'watch', ownerOpenId: 'ou_a', runAs: 'ou_a', spaceId: 'sp_g', chatId: 'oc_g', chatType: 'group', name: '关注', prompt: '发布',
        schedule: { type: 'daily', at: at ?? '18:00' }, watchChatIds: ['oc_a'], deliverTo: 'chat', now: START, ...rest })
    }
    return { registry, routines, add }
  }

  it('same watch chats or same audience + archive target within 45 minutes; 45 counts, 46 does not; other space, paused, proposed, followup, doc archive and other audiences do not', () => {
    const t = fixture()
    const a = t.add({ name: 'A' })
    t.add({ name: 'B', at: '18:30' })
    t.add({ name: '45', at: '18:45' })
    const outside = t.add({ name: '46', at: '18:46' })
    t.add({ name: '别的群发私聊', watchChatIds: ['oc_b'], deliverTo: 'dm' })
    t.add({ name: '别的空间', spaceId: 'sp_other', chatId: 'oc_other' })
    const paused = t.add({ name: '暂停' })
    t.routines.setEnabled(paused.id, false, START)
    t.add({ name: '提案', source: 'model' })
    t.add({ kind: 'followup', name: '跟进', sessionKey: 's', schedule: { type: 'once', atMs: a.nextRunAt }, watchChatIds: [] })
    const f = t.add({ kind: 'schedule', name: '群日报', at: '18:20', watchChatIds: [] })
    const g = t.add({ kind: 'schedule', name: '归档日报', at: '18:10', watchChatIds: [] })
    t.registry.setKv(`routine-archive:${g.id}`, 'doc')
    t.add({ kind: 'schedule', name: '私聊日报', at: '18:05', watchChatIds: [], deliverTo: 'dm' })
    expect(OVERLAP_WINDOW_MS).toBe(45 * MIN)
    expect(summary(t.routines.overlaps(a.id))).toEqual([['B', 'same_watch_chats', 30], ['45', 'same_watch_chats', 45], ['群日报', 'same_audience_and_archive', 20]])
    expect(summary(t.routines.overlaps(outside.id))).toEqual([['B', 'same_watch_chats', 16], ['45', 'same_watch_chats', 1], ['群日报', 'same_audience_and_archive', 26]])
    expect(summary(t.routines.overlaps(f.id))).toEqual([['A', 'same_audience_and_archive', 20], ['B', 'same_audience_and_archive', 10], ['45', 'same_audience_and_archive', 25], ['46', 'same_audience_and_archive', 26]])
    expect(t.routines.overlaps(paused.id)).toEqual([])
    expect(t.routines.overlaps(g.id)).toEqual([])
    expect(t.routines.overlaps(999)).toEqual([])
  })

  it('a watch on several groups matches only the same set, in any order; two DM routines of the same person are the same audience', () => {
    const t = fixture()
    const both = t.add({ name: '两个群', watchChatIds: ['oc_a', 'oc_b'] })
    t.add({ name: '倒过来', watchChatIds: ['oc_b', 'oc_a'], at: '18:10', deliverTo: 'dm' })
    t.add({ name: '只一个', watchChatIds: ['oc_a'], at: '18:10', deliverTo: 'dm' })
    expect(summary(t.routines.overlaps(both.id))).toEqual([['倒过来', 'same_watch_chats', 10]])
    const mine = t.add({ name: '我的', spaceId: 'dm_a', chatId: 'oc_dm', chatType: 'p2p', watchChatIds: ['oc_x'], deliverTo: 'dm' })
    t.add({ name: '也是我的', spaceId: 'dm_a', chatId: 'oc_dm', chatType: 'p2p', watchChatIds: ['oc_y'], deliverTo: 'dm', at: '18:40' })
    t.add({ name: '别人的', spaceId: 'dm_b', chatId: 'oc_dm_b', chatType: 'p2p', ownerOpenId: 'ou_b', runAs: 'ou_b', watchChatIds: ['oc_x'], deliverTo: 'dm', at: '18:00' })
    expect(summary(t.routines.overlaps(mine.id))).toEqual([['也是我的', 'same_audience_and_archive', 40]])
  })
})

function appFixture() {
  const registry = new Registry(':memory:')
  cleanup.push(() => registry.close())
  const inbox = new Inbox(registry.db), routines = new RoutineStore(registry.db, TZ), { spaces, policy } = spaceDeps(registry.db)
  const group = spaces.ensure({ kind: 'group', chatId: 'oc_g', openId: 'ou_a' })
  spaces.addMember(group.id, 'ou_actor', 'member')
  let now = START
  const app = new RoutineApplication({ registry, routines, spaces, policy, inbox, attempts: new RunAttempts(registry.db), activeRuns: () => [], now: () => now })
  const decisions = new DecisionApplication({ db: registry.db, inbox, spaces, routines: app, now: () => now })
  const add = (over: Partial<Parameters<RoutineStore['add']>[0]> & { at?: string } = {}) => {
    const { at, ...rest } = over
    return routines.add({ kind: 'watch', ownerOpenId: 'ou_a', runAs: 'ou_a', spaceId: group.id, chatId: 'oc_g', chatType: 'group', name: '关注', prompt: '发布',
      schedule: { type: 'daily', at: at ?? '18:00' }, watchChatIds: ['oc_a'], deliverTo: 'chat', now: START, ...rest })
  }
  const inTeam = { spaceId: group.id, chatType: 'group' as const }
  const resolve = (item: { id: number; version: number }, note: string | undefined, resolution: 'decided' | 'dropped' = 'decided', operator = 'ou_actor') =>
    decisions.resolve({ itemId: item.id, expectedVersion: item.version, resolution, ...(note === undefined ? {} : { note }), operatorOpenId: operator, context: inTeam })
  return { registry, inbox, routines, spaces, group, app, decisions, add, resolve, setNow: (value: number) => { now = value } }
}

describe('RoutineApplication.noteOverlaps registers one pending decision per pair', () => {
  it('title, why, owner and stable ref; the same pair is never registered twice; without an actor the routine owner decides', () => {
    const t = appFixture()
    const a = t.add({ name: '早报' })
    expect(t.app.noteOverlaps(a.id, 'ou_actor')).toEqual([])
    const b = t.add({ name: '晚报', at: '18:30' })
    const [item] = t.app.noteOverlaps(b.id, 'ou_actor')
    expect(item).toMatchObject({ ownerOpenId: 'ou_actor', kind: 'decision', spaceId: t.group.id, refId: decisionRef(t.group.id, `routine-overlap:${a.id}:${b.id}`),
      title: '「早报」和「晚报」产出重复，保留还是暂停其中一个？', why: `关注同一组群，下次运行只差 30 分钟。结清时写：保留两条 / 暂停 #${a.id} / 暂停 #${b.id}`, resolvedAt: null })
    expect(t.app.noteOverlaps(a.id, 'ou_actor')).toEqual([])
    expect(t.app.noteOverlaps(b.id)).toEqual([])
    expect(t.inbox.pending('ou_actor').map(i => i.id)).toEqual([item!.id])
    expect(t.app.overlapDecision(item!.refId)).toEqual({ a: a.id, b: b.id, spaceId: t.group.id })
    expect(t.app.overlapDecision(12345)).toBeUndefined()
    expect(t.app.overlapDecision(null)).toBeUndefined()
    const c = t.add({ name: '第三份', at: '18:10' })
    const registered = t.app.noteOverlaps(c.id)
    expect(registered.map(i => [i.ownerOpenId, i.title])).toEqual([['ou_a', '「早报」和「第三份」产出重复，保留还是暂停其中一个？'], ['ou_a', '「晚报」和「第三份」产出重复，保留还是暂停其中一个？']])
    expect(registered[1]!.why).toContain('下次运行只差 20 分钟')
  })

  it('update() registers after the change that creates the overlap and returns it; an unchanged update registers nothing; accepting a proposal registers too', () => {
    const t = appFixture()
    const a = t.add({ name: '早报' })
    const b = t.add({ name: '晚报', at: '19:30' })
    expect(t.app.noteOverlaps(b.id, 'ou_actor')).toEqual([])
    const changed = t.app.update(b.id, { schedule: { type: 'daily', at: '18:30' } }, { actorOpenId: 'ou_actor' })
    expect(changed.changed).toBe(true)
    expect(changed.overlaps.map(i => [i.ownerOpenId, i.title])).toEqual([['ou_actor', '「早报」和「晚报」产出重复，保留还是暂停其中一个？']])
    expect(t.app.update(b.id, {}, { actorOpenId: 'ou_actor' })).toMatchObject({ changed: false, overlaps: [] })
    expect(t.app.update(b.id, { name: '晚报 v2' }, { actorOpenId: 'ou_actor' }).overlaps).toEqual([])
    expect(t.inbox.pending('ou_actor')).toHaveLength(1)
    // 提案：接受前不算重叠；接受的人成为决定人
    const proposal = t.add({ kind: 'schedule', name: '提案日报', at: '18:05', watchChatIds: [], source: 'model' })
    expect(t.app.noteOverlaps(proposal.id, 'ou_actor')).toEqual([])
    const decided = t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: t.routines.configVersion(proposal.id), decision: 'accept', operatorOpenId: 'ou_a', spaceId: t.group.id })
    expect(decided.outcome).toBe('accepted')
    const pending = t.inbox.pending('ou_a')
    expect(pending.map(i => i.title)).toEqual(['「早报」和「提案日报」产出重复，保留还是暂停其中一个？', '「晚报 v2」和「提案日报」产出重复，保留还是暂停其中一个？'])
    expect(a.id).toBeLessThan(proposal.id)
  })
})

describe('the person decides through the pending-decision flow', () => {
  it('“暂停 #B” pauses B in the same transaction and settles the item; unclear answers change nothing', () => {
    const t = appFixture()
    const a = t.add({ name: '早报' }), b = t.add({ name: '晚报', at: '18:30' })
    const [item] = t.app.noteOverlaps(b.id, 'ou_actor')
    for (const note of [undefined, '嗯', `暂停 #${a.id} 和 #${b.id}`, `#${b.id}`, '暂停']) {
      expect(t.resolve(item!, note)).toMatchObject({ outcome: 'needs_choice', changed: false, options: { keep: '保留两条', pause: [{ id: a.id, name: '早报' }, { id: b.id, name: '晚报' }] } })
    }
    expect(t.inbox.get(item!.id)?.resolvedAt).toBeNull()
    expect(t.routines.get(a.id)?.enabled).toBe(true)
    expect(t.routines.get(b.id)?.enabled).toBe(true)
    const result = t.resolve(item!, `暂停 #${b.id}`)
    expect(result).toMatchObject({ outcome: 'resolved', changed: true, paused: { id: b.id, enabled: false, disabledReason: '手动停用' } })
    expect('afterCommit' in result).toBe(false)
    expect(t.routines.get(b.id)).toMatchObject({ enabled: false, disabledReason: '手动停用' })
    expect(t.routines.get(a.id)?.enabled).toBe(true)
    expect(t.inbox.get(item!.id)).toMatchObject({ resolution: 'decided', resolvedBy: 'ou_actor', resolutionNote: `暂停 #${b.id}` })
    // 重放同一结论：已结清，不再暂停别的
    expect(t.resolve(item!, `暂停 #${b.id}`)).toMatchObject({ outcome: 'already_resolved', changed: false })
  })

  it('“保留两条” and “不用了” keep both running; a name in 「」 selects the routine; the other pair’s question is settled by the pause', () => {
    const t = appFixture()
    const a = t.add({ name: '早报' }), b = t.add({ name: '晚报', at: '18:30' })
    const [keep] = t.app.noteOverlaps(b.id, 'ou_actor')
    expect(t.resolve(keep!, '保留两条')).toMatchObject({ outcome: 'resolved', changed: true })
    expect(t.routines.get(a.id)?.enabled).toBe(true)
    expect(t.routines.get(b.id)?.enabled).toBe(true)
    // 同一对不再问；第三条与两条都重叠 → 两条待决定
    expect(t.app.noteOverlaps(a.id, 'ou_actor')).toEqual([])
    const c = t.add({ name: '第三份', at: '18:15' })
    const [withA, withB] = t.app.noteOverlaps(c.id, 'ou_actor')
    expect(t.resolve(withA!, undefined, 'dropped')).toMatchObject({ outcome: 'resolved', changed: true })
    expect(t.routines.get(c.id)?.enabled).toBe(true)
    expect(t.resolve(withB!, '暂停「第三份」')).toMatchObject({ outcome: 'resolved', paused: { id: c.id } })
    expect(t.routines.get(c.id)).toMatchObject({ enabled: false, disabledReason: '手动停用' })
    // 暂停之后：已经由本人结清的 withA 不动；暂停中的职责不再登记新的一对
    expect(t.inbox.get(withA!.id)).toMatchObject({ resolution: 'dropped', resolvedBy: 'ou_actor' })
    expect(t.app.noteOverlaps(c.id, 'ou_actor')).toEqual([])
  })

  it('pausing or deleting one routine elsewhere settles the open question by domain; resolving it afterwards says so', () => {
    const t = appFixture()
    const a = t.add({ name: '早报' }), b = t.add({ name: '晚报', at: '18:30' }), c = t.add({ name: '第三份', at: '18:15' })
    // b 与 a、c 都重叠：两对一起登记；之后 c 只剩与 a 的一对
    const [ab, bc] = t.app.noteOverlaps(b.id, 'ou_actor')
    const [ac] = t.app.noteOverlaps(c.id, 'ou_actor')
    expect([ab, bc, ac].map(i => i?.title)).toEqual(['「早报」和「晚报」产出重复，保留还是暂停其中一个？', '「晚报」和「第三份」产出重复，保留还是暂停其中一个？', '「早报」和「第三份」产出重复，保留还是暂停其中一个？'])
    t.app.control(a.id, 'pause')
    expect(t.inbox.get(ab!.id)).toMatchObject({ resolution: 'domain', resolutionNote: 'routine_paused' })
    expect(t.inbox.get(ac!.id)).toMatchObject({ resolution: 'domain', resolutionNote: 'routine_paused' })
    expect(t.inbox.get(bc!.id)?.resolvedAt).toBeNull()
    expect(t.resolve(ab!, `暂停 #${b.id}`)).toMatchObject({ outcome: 'settled_by_domain', changed: false })
    expect(t.routines.get(b.id)?.enabled).toBe(true)
    t.app.control(c.id, 'delete')
    expect(t.inbox.get(bc!.id)).toMatchObject({ resolution: 'domain', resolutionNote: 'routine_deleted' })
    // 恢复 a 之后与 b 仍重叠，但这一对已经问过：不再登记
    t.app.control(a.id, 'resume')
    expect(t.app.noteOverlaps(a.id, 'ou_actor')).toEqual([])
  })

  it('a decision that names a routine which no longer exists is rejected as a whole', () => {
    const t = appFixture()
    const a = t.add({ name: '早报' }), b = t.add({ name: '晚报', at: '18:30' })
    const [item] = t.app.noteOverlaps(b.id, 'ou_actor')
    t.registry.db.prepare('DELETE FROM routines WHERE id = ?').run(b.id)
    expect(() => t.resolve(item!, `暂停 #${b.id}`)).toThrow('这条职责已不存在')
    expect(t.inbox.get(item!.id)?.resolvedAt).toBeNull()
    expect(t.routines.get(a.id)?.enabled).toBe(true)
  })

  it('overlapChoice reads the three options and nothing else', () => {
    const pair = [{ id: 1, name: '早报' }, { id: 2, name: '晚报 v2' }] as unknown as Parameters<typeof overlapChoice>[2]
    const overlap = { a: 1, b: 2 }
    expect(overlapChoice({ resolution: 'dropped' }, overlap, pair)).toBe('keep')
    expect(overlapChoice({ resolution: 'decided', note: '保留两条' }, overlap, pair)).toBe('keep')
    expect(overlapChoice({ resolution: 'decided', note: '都留着' }, overlap, pair)).toBe('keep')
    expect(overlapChoice({ resolution: 'decided', note: '暂停 #2' }, overlap, pair)).toBe(2)
    expect(overlapChoice({ resolution: 'decided', note: '先停「晚报 v2」' }, overlap, pair)).toBe(2)
    expect(overlapChoice({ resolution: 'decided', note: '停掉早报' }, overlap, pair)).toBe(1)
    expect(overlapChoice({ resolution: 'decided', note: '暂停 #12' }, overlap, pair)).toBeUndefined()
    expect(overlapChoice({ resolution: 'decided', note: '暂停 #1 保留 #2' }, overlap, pair)).toBe(1)
    expect(overlapChoice({ resolution: 'decided', note: '暂停一个' }, overlap, pair)).toBeUndefined()
    expect(overlapChoice({ resolution: 'decided', note: '#2' }, overlap, pair)).toBeUndefined()
    expect(overlapChoice({ resolution: 'decided' }, overlap, pair)).toBeUndefined()
  })
})

describe('end to end through the internal API and MCP', () => {
  async function fixture() {
    const home = mkdtempSync(join(tmpdir(), 'friday-routine-overlaps-'))
    const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
    mkdirSync(cfg.workspace.root, { recursive: true })
    const clock = { now: START }
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
    const registry = new Registry(':memory:')
    const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), todos = new Todos(registry.db)
    const routines = new RoutineStore(registry.db, TZ), inbox = new Inbox(registry.db)
    const feishu = new FakeFeishu()
    feishu.chats = [{ chatId: 'oc_g', name: '研发群' }]
    feishu.members.set('oc_g', new Set(['ou_alice', 'ou_bot']))
    const messages = new MessageService(asFeishuClient(feishu), cache, log)
    const tokens = new TokenIssuer('s'), sp = spaceDeps(registry.db)
    const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
    sp.spaces.ensure({ kind: 'group', chatId: 'oc_g', openId: 'ou_alice' })
    feishu.nextToken.scope = [...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.watch].join(' ')
    const userTokens = new UserTokenStore(registry.db, feishu)
    const grant = await userTokens.complete({ openId: 'ou_alice', code: 'synthetic-watch', redirectUri: 'https://callback.invalid' })
    feishu.userChats.set(grant.accessToken, [{ chatId: 'oc_g', name: '研发群' }])
    feishu.identities.set(grant.accessToken, { openId: 'ou_alice', name: '陆知行', tenantKey: 'synthetic-tenant' })
    const state = { actor: { requesterOpenId: 'ou_alice', runId: 'run-a', stage: 'task' as const } }
    let orchestrator!: Orchestrator
    const api = createInternalApi({ feishu: asFeishuClient(feishu), memory, registry, messages, messageCache: cache, todos, routines, inbox, ...sp, tokens, log, maxHistoryPerCall: 50,
      appId: cfg.feishu.appId, userTokens,
      resolveActorForSession: () => state.actor, canPersistDerivedState: () => true,
      pendingDecisions: (owner, context) => orchestrator.pendingDecisions(owner, context),
      resolveDecision: input => orchestrator.resolveDecision(input),
      updateRoutine: (id, patch, options) => orchestrator.updateRoutine(id, patch, options),
      noteRoutineOverlaps: (id, actor) => orchestrator.noteRoutineOverlaps(id, actor),
      refreshProposalCard: id => orchestrator.refreshProposalCard(id) })
    const { app } = createFakeAgent()
    const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
    orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory, messages, routines, inbox, userTokens, ...sp, tokens,
      apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log, now: () => clock.now })
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())); await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
    const dmCap: Omit<Capability, 'exp'> = { sessionKey: 'dm:ou_alice', runId: 'run-a', chatId: 'oc_dm', chatType: 'p2p', spaceId: dm.id, requesterOpenId: 'ou_alice', scopes: [...ALL_SCOPES] }
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const server = buildServer({ apiUrl: base, token: tokens.issue(dmCap) })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const client = new Client({ name: 'test-client', version: '0.0.0' })
      await client.connect(clientTransport)
      cleanup.push(() => client.close())
      const res = await client.callTool({ name, arguments: args }) as { content: { text: string }[] }
      return res.content.map(item => item.text).join('\n')
    }
    return { registry, routines, inbox, feishu, orchestrator, dm, tool }
  }

  it('the second overlapping watch reports the pending decision; the person’s “暂停 #B” pauses B; an unclear answer asks for one of three options', async () => {
    const t = await fixture()
    const first = await t.tool('friday_watch_add', { chats: ['研发群'], topic: '发布排期', name: '早报', schedule: { type: 'daily', at: '18:00' } })
    expect(first).not.toContain('产出重复')
    const a = Number(first.match(/\[routine:(\d+)\]/)?.[1])
    const second = await t.tool('friday_watch_add', { chats: ['研发群'], topic: '发布排期', name: '晚报', schedule: { type: 'daily', at: '18:30' } })
    const b = Number(second.match(/\[routine:(\d+)\]/)?.[1])
    expect(second).toContain('「早报」和「晚报」产出重复，保留还是暂停其中一个？（已记为待拍板 [decision:')
    const listed = await t.tool('friday_decision_list')
    const match = listed.match(/\[decision:(\d+) v(\d+)\] 待决断：「早报」和「晚报」产出重复，保留还是暂停其中一个？（关注同一组群，下次运行只差 30 分钟。结清时写：保留两条 \/ 暂停 #(\d+) \/ 暂停 #(\d+)）/)
    expect(match).not.toBeNull()
    const [, id, version, first_id, second_id] = match!
    expect([Number(first_id), Number(second_id)]).toEqual([a, b])
    const unclear = await t.tool('friday_decision_resolve', { id: Number(id), version: Number(version), resolution: 'decided', note: '随便' })
    expect(unclear).toContain('结论要是三项之一：保留两条 / 暂停 #')
    expect(t.inbox.pending('ou_alice')).toHaveLength(1)
    expect(t.routines.get(b)?.enabled).toBe(true)
    const paused = await t.tool('friday_decision_resolve', { id: Number(id), version: Number(version), resolution: 'decided', note: `暂停 #${b}` })
    expect(paused).toContain(`已结清（定了），结论记为「暂停 #${b}」。已暂停职责 #${b}「晚报」`)
    expect(t.routines.get(b)).toMatchObject({ enabled: false, disabledReason: '手动停用' })
    expect(t.routines.get(a)?.enabled).toBe(true)
    expect(t.inbox.pending('ou_alice')).toEqual([])
    expect(await t.tool('friday_decision_list')).toBe('这个会话里没有等他拍板的事。')
    // 同一对不再问：改回来仍重叠，但已经决定过
    const updated = await t.tool('friday_routine_update', { id: a, schedule: { type: 'daily', at: '18:10' } })
    expect(updated).toContain('已改「早报」的时间安排')
    expect(updated).not.toContain('产出重复')
  })

  it('an update that creates a new overlap reports it, and “不用了” keeps both', async () => {
    const t = await fixture()
    const first = await t.tool('friday_watch_add', { chats: ['研发群'], topic: '发布排期', name: '早报', schedule: { type: 'daily', at: '18:00' } })
    const a = Number(first.match(/\[routine:(\d+)\]/)?.[1])
    const second = await t.tool('friday_watch_add', { chats: ['研发群'], topic: '发布排期', name: '晚报', schedule: { type: 'daily', at: '20:00' } })
    expect(second).not.toContain('产出重复')
    const b = Number(second.match(/\[routine:(\d+)\]/)?.[1])
    const updated = await t.tool('friday_routine_update', { id: b, schedule: { type: 'daily', at: '18:40' } })
    expect(updated).toContain('「早报」和「晚报」产出重复，保留还是暂停其中一个？（已记为待拍板 [decision:')
    const item = t.inbox.pending('ou_alice')[0]!
    expect(item.why).toContain('下次运行只差 40 分钟')
    const kept = await t.tool('friday_decision_resolve', { id: item.id, version: item.version, resolution: 'dropped', note: '两条都要' })
    expect(kept).toContain('已结清（不用了）')
    expect(kept).not.toContain('已暂停')
    expect(t.routines.get(a)?.enabled).toBe(true)
    expect(t.routines.get(b)?.enabled).toBe(true)
  })
})
