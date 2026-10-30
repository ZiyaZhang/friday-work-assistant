/**
 * P4-2 G7：关注职责的触发阈值。到点先由网关用与模型相同的身份数一遍读取窗口里的新消息：
 * 不到阈值就消费这个窗口、把 occurrence 记成 skipped（原因 below_threshold），不开模型会话、不发送；
 * 达到阈值、被 @（always_on_mention）、手动触发、数不全时照常运行。真实 Orchestrator / RoutineStore / 调度器 / 内部 API / MCP；飞书与模型合成。
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
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { BELOW_THRESHOLD, RoutineControlError, RoutineScheduler, RoutineStore, TRIGGER_WATCH_ONLY, describeTrigger, parseAlwaysOnMention, parseMinNewMessages, routineRunOutcome, type Routine } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import { UserTokenStore, USER_SCOPE_TIERS } from '../src/feishu/oauth.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, GROUP_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent, type FakeTurnStep } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('routine-threshold', 'error')
const TZ = 480
/** 2026-09-25 09:00 北京时间 */
const START = Date.UTC(2026, 8, 25, 1)
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

describe('RoutineStore: threshold columns (G7)', () => {
  function store() {
    const registry = new Registry(':memory:')
    cleanup.push(() => registry.close())
    return { registry, routines: new RoutineStore(registry.db, TZ) }
  }
  const base = { ownerOpenId: 'ou_a', spaceId: 'sp', chatId: 'oc_dm', chatType: 'p2p' as const, name: '关注', prompt: '发布', schedule: { type: 'daily' as const, at: '18:00' }, now: START }

  it('parses min_new_messages / always_on_mention and rejects invalid values', () => {
    expect(parseMinNewMessages(undefined)).toBe(0)
    expect(parseMinNewMessages(5)).toBe(5)
    expect(parseMinNewMessages('7')).toBe(7)
    for (const bad of [-1, 1.5, 10_001, 'x', true]) expect(() => parseMinNewMessages(bad)).toThrow(/min_new_messages/)
    expect(parseAlwaysOnMention(undefined)).toBe(true)
    expect(parseAlwaysOnMention(false)).toBe(false)
    expect(parseAlwaysOnMention(0)).toBe(false)
    expect(parseAlwaysOnMention(1)).toBe(true)
    expect(() => parseAlwaysOnMention('yes')).toThrow(/always_on_mention/)
  })

  it('stores the threshold on watch routines only; defaults are 0 / true', () => {
    const { routines } = store()
    const plain = routines.add({ kind: 'watch', ...base, watchChatIds: ['oc_g'] })
    expect(plain).toMatchObject({ minNewMessages: 0, alwaysOnMention: true })
    const set = routines.add({ kind: 'watch', ...base, watchChatIds: ['oc_g'], minNewMessages: 5, alwaysOnMention: false })
    expect(set).toMatchObject({ minNewMessages: 5, alwaysOnMention: false })
    expect(() => routines.add({ kind: 'schedule', ...base, minNewMessages: 5 })).toThrow(TRIGGER_WATCH_ONLY)
    expect(() => routines.add({ kind: 'schedule', ...base, alwaysOnMention: false })).toThrow(TRIGGER_WATCH_ONLY)
    expect(routines.add({ kind: 'schedule', ...base, minNewMessages: 0 })).toMatchObject({ minNewMessages: 0, alwaysOnMention: true })
    expect(describeTrigger(set)).toBe('至少 5 条新消息才运行（被 @ 也不例外）')
    expect(describeTrigger({ ...set, alwaysOnMention: true })).toBe('至少 5 条新消息才运行（被 @ 时照常运行）')
    expect(describeTrigger(plain)).toBe('')
  })

  it('update changes the threshold with a new config version and keeps the cursor; schedule routines are rejected', () => {
    const { routines } = store()
    const r = routines.add({ kind: 'watch', ...base, watchChatIds: ['oc_g'] })
    const startSec = Math.floor(START / 1000)
    expect(routines.advanceMessageCursor(r.id, routines.configVersion(r.id)!, startSec, startSec + 60)).toBe(true)
    const version = routines.configVersion(r.id)!
    const updated = routines.update(r.id, { minNewMessages: 3 }, START + 1)!
    expect(updated).toMatchObject({ minNewMessages: 3, alwaysOnMention: true, messageCursorSec: startSec + 60, nextRunAt: r.nextRunAt })
    expect(routines.configVersion(r.id)).toBe(version + 1)
    expect(routines.update(r.id, { alwaysOnMention: false }, START + 2)).toMatchObject({ minNewMessages: 3, alwaysOnMention: false })
    expect(() => routines.update(r.id, { minNewMessages: -1 }, START + 3)).toThrow(/min_new_messages/)
    const s = routines.add({ kind: 'schedule', ...base })
    expect(() => routines.update(s.id, { minNewMessages: 2 }, START + 4)).toThrow(RoutineControlError)
    expect(() => routines.update(s.id, { alwaysOnMention: false }, START + 5)).toThrow(TRIGGER_WATCH_ONLY)
  })

  it('adds both columns to an old table with NOT NULL defaults; existing rows keep every other value; a second construction changes nothing', () => {
    const { registry, routines } = store()
    const r = routines.add({ kind: 'watch', ...base, watchChatIds: ['oc_g'], minNewMessages: 5, alwaysOnMention: false })
    registry.db.exec('ALTER TABLE routines DROP COLUMN min_new_messages; ALTER TABLE routines DROP COLUMN always_on_mention')
    const before = registry.db.prepare('SELECT * FROM routines WHERE id = ?').get(r.id) as Record<string, unknown>
    expect(new RoutineStore(registry.db, TZ).get(r.id)).toMatchObject({ minNewMessages: 0, alwaysOnMention: true })
    expect(registry.db.prepare('SELECT * FROM routines WHERE id = ?').get(r.id)).toEqual({ ...before, min_new_messages: 0, always_on_mention: 1 })
    const columns = registry.db.prepare('PRAGMA table_info(routines)').all() as { name: string; type: string; notnull: number; dflt_value: string | null }[]
    expect(columns.find(c => c.name === 'min_new_messages')).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' })
    expect(columns.find(c => c.name === 'always_on_mention')).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '1' })
    const schema = registry.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'routines'").get()
    new RoutineStore(registry.db, TZ)
    expect(registry.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'routines'").get()).toEqual(schema)
  })
})

describe('RoutineScheduler: a run may return its status with a reason', () => {
  it('records a below-threshold skip on the occurrence without counting a failure', async () => {
    const registry = new Registry(':memory:')
    cleanup.push(() => registry.close())
    const routines = new RoutineStore(registry.db, TZ)
    const r = routines.add({ kind: 'watch', ownerOpenId: 'ou_a', spaceId: 'sp', chatId: 'oc_dm', chatType: 'p2p', name: '关注', prompt: '发布',
      schedule: { type: 'interval', everyMinutes: 10 }, watchChatIds: ['oc_g'], minNewMessages: 5, now: START })
    const now = r.nextRunAt
    const scheduler = new RoutineScheduler({ store: routines, log, now: () => now, run: async () => ({ status: 'skipped', reason: BELOW_THRESHOLD }) })
    expect(await scheduler.tick()).toBe(1)
    expect(routines.listOccurrences(r.id, 1)[0]).toMatchObject({ status: 'skipped', error: BELOW_THRESHOLD })
    expect(routines.get(r.id)).toMatchObject({ lastStatus: 'skipped', lastError: null, failCount: 0, runs: 1, enabled: true })
    expect(routineRunOutcome('ok')).toEqual({ status: 'ok' })
    expect(routineRunOutcome({ status: 'skipped', reason: 'x' })).toEqual({ status: 'skipped', reason: 'x' })
  })
})

async function setup(opts: { maxBackfill?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-routine-threshold-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const clock = { now: START }
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
  const registry = new Registry(':memory:')
  const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), todos = new Todos(registry.db)
  const routines = new RoutineStore(registry.db, TZ)
  const feishu = new FakeFeishu()
  feishu.chats = [{ chatId: 'oc_g', name: '研发群' }]
  feishu.members.set('oc_g', new Set(['ou_alice', 'ou_bot']))
  feishu.names.set('ou_alice', '陆知行')
  const messages = new MessageService(asFeishuClient(feishu), cache, log, opts.maxBackfill ? { maxBackfillMessages: opts.maxBackfill } : {})
  const tokens = new TokenIssuer('s')
  const sp = spaceDeps(registry.db)
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_g', openId: 'ou_alice' })
  // 用例里的时钟会拨到当天 18:00 之后：委托 token 的有效期要盖住整天，否则模型那一侧的读取会因换 token 后身份未核验而失败。
  feishu.nextToken = { ...feishu.nextToken, expiresIn: 30 * 86_400, scope: [...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.watch].join(' ') }
  const userTokens = new UserTokenStore(registry.db, feishu)
  const grant = await userTokens.complete({ openId: 'ou_alice', code: 'synthetic-watch', redirectUri: 'https://callback.invalid' })
  feishu.userChats.set(grant.accessToken, [{ chatId: 'oc_g', name: '研发群' }])
  feishu.identities.set(grant.accessToken, { openId: 'ou_alice', name: '陆知行', tenantKey: 'synthetic-tenant' })
  let orchestrator!: Orchestrator
  const api = createInternalApi({ feishu: asFeishuClient(feishu), memory, registry, messages, messageCache: cache, todos, routines, ...sp, tokens, log, maxHistoryPerCall: 50,
    appId: cfg.feishu.appId, userTokens,
    resolveActorForSession: key => key === 'dm:ou_alice' || key === 'msg:1'
      ? { requesterOpenId: 'ou_alice', runId: `fixture:${key}`, stage: 'task' }
      : orchestrator.resolveActorForSession(key),
    onCrossSpaceRead: (key, read) => orchestrator.noteCrossSpaceRead(key, read),
    onChatHistoryRead: (key, read) => orchestrator.noteChatHistoryRead(key, read),
    updateRoutine: (id, patch, options) => orchestrator.updateRoutine(id, patch, options),
    noteRoutineOverlaps: (id, actor) => orchestrator.noteRoutineOverlaps(id, actor),
    stopRoutine: (id, mode) => orchestrator.stopRoutine(id, mode) })
  const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: '合成简报\n有一条合成变化' }] })
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory, messages, routines, userTokens, ...sp, tokens,
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log, now: () => clock.now })
  const scheduler = new RoutineScheduler({ store: routines, log, now: () => clock.now, run: (r, occurrence) => orchestrator.runRoutine(r, { occurrence }) })
  cleanup.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const dmCap = { sessionKey: 'dm:ou_alice', runId: 'fixture:dm:ou_alice', spaceId: dm.id, chatId: 'oc_dm', chatType: 'p2p' as const, requesterOpenId: 'ou_alice', scopes: [...ALL_SCOPES], exp: 0 }
  const groupCap = { sessionKey: 'msg:1', runId: 'fixture:msg:1', spaceId: group.id, chatId: 'oc_g', chatType: 'group' as const, requesterOpenId: 'ou_alice', scopes: [...GROUP_SCOPES], exp: 0 }
  /** 群里建的关注：机器人身份读本群，结果发回本群。 */
  const addGroupWatch = async (body: Record<string, unknown> = {}) => {
    const created = await api.routes['POST /v1/routine/add']!(groupCap, { kind: 'watch', name: '日报', prompt: '有重要变化再说', chats: ['oc_g'],
      schedule: { type: 'daily', at: '18:00' }, min_new_messages: 5, ...body }) as { routine: { id: number } }
    return routines.get(created.routine.id)!
  }
  /** 往假飞书里放 n 条别人发的消息（从 base 起每秒一条），再加 extra 里的特殊消息。每次调用的 message_id 都不同：缓存按 id 去重，重复 id 不会改时间。 */
  let batch = 0
  const fill = (n: number, extra: { text: string }[] = [], target: 'histories' | 'userHistories' = 'histories', base = START + 60_000) => {
    batch += 1
    const items = Array.from({ length: n }, (_, i) => historyMsg({ messageId: `om_${target}_${batch}_${i}`, chatId: 'oc_g', createTimeMs: base + i * 1000, senderName: '同事', senderOpenId: 'ou_bob', text: `合成消息 ${i}` }))
    extra.forEach((e, i) => items.push(historyMsg({ messageId: `om_${target}_${batch}_x${i}`, chatId: 'oc_g', createTimeMs: base + 60_000 + i * 1000, senderName: '同事', senderOpenId: 'ou_bob', text: e.text })))
    feishu[target].set('oc_g', items)
  }
  /** 模型这一轮读窗口的钩子：读全了，简报才能发出去。读取失败原样抛出，让用例直接看到原因。 */
  const readWindow = (cap: typeof groupCap | typeof dmCap, r: Routine): FakeTurnStep => ({ kind: 'hook', run: async () => {
    const prompt = state.allPrompts.at(-1)!
    const session = registry.getSessionByAcpId(prompt.sessionId)!
    const actor = orchestrator.resolveActorForSession(session.sessionKey)!
    const current = routines.get(r.id)!
    try {
      await api.routes['POST /v1/chat/history']!({ ...cap, sessionKey: session.sessionKey, runId: actor.runId },
        { chat: 'oc_g', start_time: new Date((current.messageCursorSec ?? Math.floor(current.createdAt / 1000)) * 1000).toISOString(), end_time: new Date(clock.now).toISOString() })
    } catch (err) {
      console.error('readWindow hook failed', err)
      throw err
    }
  } })
  const tickAt = async (r: Routine) => { clock.now = routines.get(r.id)!.nextRunAt; return scheduler.tick() }
  return { cfg, registry, routines, feishu, orchestrator, runtime, api, state, clock, scheduler, dmCap, groupCap, addGroupWatch, fill, readWindow, tickAt, tokens, cache, ...sp }
}

describe('threshold at run time (G7)', () => {
  it('below the threshold: records skipped(below_threshold), keeps the read cursor, opens no model session and sends nothing', async () => {
    const t = await setup()
    const r = await t.addGroupWatch()
    expect(r).toMatchObject({ minNewMessages: 5, alwaysOnMention: true, chatType: 'group', messageCursorSec: null })
    t.fill(2)
    expect(await t.tickAt(r)).toBe(1)
    expect(t.state.allPrompts).toHaveLength(0)
    expect(t.registry.db.prepare("SELECT count(*) AS n FROM sessions WHERE session_key LIKE 'routine:%'").get()?.n).toBe(0)
    expect(t.feishu.sent).toHaveLength(0)
    expect(t.routines.listOccurrences(r.id, 1)[0]).toMatchObject({ status: 'skipped', error: BELOW_THRESHOLD })
    // 游标不动：这 2 条留到下一轮一起算
    expect(t.routines.get(r.id)).toMatchObject({ lastStatus: 'skipped', failCount: 0, runs: 1, enabled: true, messageCursorSec: null })
    // 网关自己读了窗口，读到的进了缓存；下一轮同一窗口不再打 API
    expect(t.feishu.calls.listChatHistory).toBeGreaterThan(0)
    expect(t.cache.count('oc_g')).toBe(2)
    const calls = t.feishu.calls.listChatHistory
    expect(await t.tickAt(t.routines.get(r.id)!)).toBe(1)
    expect(t.routines.listOccurrences(r.id, 1)[0]).toMatchObject({ status: 'skipped', error: BELOW_THRESHOLD })
    expect(t.state.allPrompts).toHaveLength(0)
    expect(t.routines.get(r.id)).toMatchObject({ runs: 2, messageCursorSec: null })
    // 第二轮只回填新增的时间段（旧段命中缓存），仍是同样的 2 条
    expect(t.feishu.calls.listChatHistory).toBeGreaterThan(calls)
    expect(t.cache.count('oc_g')).toBe(2)
  })

  it('accumulates: 3 + 3 new messages with threshold 5 → first round skipped, second round runs on all 6, cursor advances only after the run', async () => {
    const t = await setup()
    const r = await t.addGroupWatch()
    t.fill(3)
    expect(await t.tickAt(r)).toBe(1)
    const firstRun = t.clock.now
    expect(t.routines.listOccurrences(r.id, 1)[0]).toMatchObject({ status: 'skipped', error: BELOW_THRESHOLD })
    expect(t.routines.get(r.id)?.messageCursorSec).toBeNull()
    expect(t.state.allPrompts).toHaveLength(0)
    // 下一轮之前又来 3 条（在第一轮到点之后）
    t.fill(3, [], 'histories', firstRun + 3600_000)
    t.state.script = [t.readWindow(t.groupCap, t.routines.get(r.id)!), { kind: 'text', text: '合成简报\n有六条合成变化' }]
    expect(await t.tickAt(t.routines.get(r.id)!)).toBe(1)
    expect(t.clock.now).toBeGreaterThan(firstRun)
    expect(t.state.allPrompts).toHaveLength(1)
    const prompt = t.state.allPrompts[0]!.text
    expect(prompt).toContain('本次窗口内新消息 6 条')
    // 读取起点仍是创建时间：两轮的消息在同一个窗口里
    expect(prompt).toContain(`start_time=${new Date(START).toISOString()}`)
    expect(prompt).toContain(`end_time=${new Date(t.clock.now).toISOString()}`)
    expect(t.routines.listOccurrences(r.id, 1)[0]).toMatchObject({ status: 'ok', error: null })
    expect(t.feishu.of('sendToChat')).toHaveLength(1)
    const secondRun = t.clock.now
    expect(t.routines.get(r.id)).toMatchObject({ runs: 2, messageCursorSec: Math.floor(secondRun / 1000) })
    // 运行之后游标已推进：第三轮从新游标起没有新消息 → 0 条，再次 skipped，游标保持在第二轮
    expect(await t.tickAt(t.routines.get(r.id)!)).toBe(1)
    expect(t.routines.listOccurrences(r.id, 1)[0]).toMatchObject({ status: 'skipped', error: BELOW_THRESHOLD })
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.routines.get(r.id)).toMatchObject({ runs: 3, messageCursorSec: Math.floor(secondRun / 1000) })
  })

  it('at the threshold the model runs, the prompt states the threshold and the count, and the digest goes out', async () => {
    const t = await setup()
    const r = await t.addGroupWatch()
    t.fill(5)
    t.state.script = [t.readWindow(t.groupCap, r), { kind: 'text', text: '合成简报\n有一条合成变化' }]
    expect(await t.tickAt(r)).toBe(1)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.state.allPrompts[0]!.text).toContain('触发阈值：至少 5 条新消息才运行（被 @ 时照常运行）；本次窗口内新消息 5 条。')
    expect(t.routines.listOccurrences(r.id, 1)[0]).toMatchObject({ status: 'ok', error: null })
    expect(t.feishu.of('sendToChat')).toHaveLength(1)
    expect(t.routines.get(r.id)?.messageCursorSec).toBe(Math.floor(t.clock.now / 1000))
  })

  it('an @ of the delegate or of Friday runs the routine below the threshold; with always_on_mention off it stays quiet', async () => {
    const t = await setup()
    const byName = await t.addGroupWatch()
    t.fill(1, [{ text: '@陆知行 这个要今天定' }])
    await t.tickAt(byName)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.state.allPrompts[0]!.text).toContain('本次窗口内新消息 2 条')

    const byBot = await t.addGroupWatch({ name: '@机器人', schedule: { type: 'daily', at: '19:00' } })
    t.fill(1, [{ text: '@Friday 看一下这个' }], 'histories', t.clock.now + 60_000)
    await t.tickAt(byBot)
    expect(t.state.allPrompts).toHaveLength(2)

    const quiet = await t.addGroupWatch({ name: '攒着', schedule: { type: 'daily', at: '20:00' }, always_on_mention: false })
    expect(quiet.alwaysOnMention).toBe(false)
    t.fill(1, [{ text: '@陆知行 @Friday 都在' }], 'histories', t.clock.now + 60_000)
    await t.tickAt(quiet)
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.routines.listOccurrences(quiet.id, 1)[0]).toMatchObject({ status: 'skipped', error: BELOW_THRESHOLD })
  })

  it('a manual run ignores the threshold', async () => {
    const t = await setup()
    const r = await t.addGroupWatch()
    t.fill(1)
    t.clock.now = START + 300_000
    t.state.script = [t.readWindow(t.groupCap, r), { kind: 'text', text: 'NOTHING' }]
    expect(await t.orchestrator.runRoutine(t.routines.get(r.id)!, { manualMessageId: 'om_manual' })).toBe('skipped')
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.state.allPrompts[0]!.text).toContain('本次为手动触发')
    expect(t.state.allPrompts[0]!.text).not.toContain('本次窗口内新消息')
  })

  it('when the gateway cannot read the whole window it does not decide for the model', async () => {
    const t = await setup({ maxBackfill: 1 })
    const r = await t.addGroupWatch()
    // 两条在同一秒、预算每次 1 条：时间游标停在这一秒，读不全，不能当成“只有 1 条”
    t.feishu.histories.set('oc_g', [0, 1].map(i => historyMsg({ messageId: `om_same_${i}`, chatId: 'oc_g', createTimeMs: START + 60_000, senderName: '同事', senderOpenId: 'ou_bob', text: `同一秒 ${i}` })))
    await t.tickAt(r)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.state.allPrompts[0]!.text).toContain('触发阈值：至少 5 条新消息才运行（被 @ 时照常运行）。')
    expect(t.state.allPrompts[0]!.text).not.toContain('本次窗口内新消息')
  })

  it('a watch created in DM counts with the delegate’s token, not with the bot identity', async () => {
    const t = await setup()
    const created = await t.api.routes['POST /v1/routine/add']!(t.dmCap, { kind: 'watch', name: '关注发布', prompt: '发布排期', chats: ['研发群'],
      schedule: { type: 'daily', at: '18:00' }, min_new_messages: 5 }) as { routine: { id: number } }
    const r = t.routines.get(created.routine.id)!
    expect(r).toMatchObject({ chatType: 'p2p', deliverTo: 'dm', minNewMessages: 5 })
    t.fill(1)
    t.fill(5, [], 'userHistories')
    t.state.script = [t.readWindow(t.dmCap, r), { kind: 'text', text: '合成简报\n有一条合成变化' }]
    await t.tickAt(r)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.state.allPrompts[0]!.text).toContain('本次窗口内新消息 5 条')
    expect(t.routines.listOccurrences(r.id, 1)[0]?.status).toBe('ok')
    expect(t.feishu.of('sendToUser')).toHaveLength(1)
  })
})

describe('API / MCP carry the threshold parameters', () => {
  it('friday_watch_add / friday_routine_update / friday_routine_list read and write min_new_messages and always_on_mention; schedule routines reject them', async () => {
    const t = await setup()
    await new Promise<void>(resolve => t.api.server.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => { t.api.server.closeAllConnections(); await new Promise<void>(resolve => t.api.server.close(() => resolve())) })
    const base = `http://127.0.0.1:${(t.api.server.address() as AddressInfo).port}`
    const tool = async (cap: Omit<Capability, 'exp'>, name: string, args: Record<string, unknown> = {}) => {
      const server = buildServer({ apiUrl: base, token: t.tokens.issue(cap) })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const client = new Client({ name: 'test-client', version: '0.0.0' })
      await client.connect(clientTransport)
      cleanup.push(() => client.close())
      const res = await client.callTool({ name, arguments: args }) as { content: { text: string }[] }
      return res.content.map(item => item.text).join('\n')
    }
    const { exp: _exp, ...dmCap } = t.dmCap
    const added = await tool(dmCap, 'friday_watch_add', { chats: ['研发群'], topic: '发布排期', min_new_messages: 5, always_on_mention: false })
    expect(added).toContain('至少 5 条新消息才运行（被 @ 也不例外）')
    const id = Number(added.match(/\[routine:(\d+)\]/)?.[1])
    expect(t.routines.get(id)).toMatchObject({ minNewMessages: 5, alwaysOnMention: false })
    expect(JSON.parse(await tool(dmCap, 'friday_routine_list', { id }))).toMatchObject({ min_new_messages: 5, always_on_mention: false })
    expect(await tool(dmCap, 'friday_routine_list', {})).toContain('至少 5 条新消息才运行')
    const updated = await tool(dmCap, 'friday_routine_update', { id, min_new_messages: 0 })
    expect(updated).toContain('触发阈值')
    expect(updated).toContain('不设阈值')
    expect(t.routines.get(id)).toMatchObject({ minNewMessages: 0, alwaysOnMention: false })
    expect(await tool(dmCap, 'friday_routine_list', {})).not.toContain('至少')
    await expect(t.api.routes['POST /v1/routine/add']!(t.dmCap, { kind: 'schedule', name: '定时', prompt: '总结', schedule: { type: 'daily', at: '19:00' }, min_new_messages: 3 })).rejects.toThrow(TRIGGER_WATCH_ONLY)
    await expect(t.api.routes['POST /v1/routine/update']!(t.dmCap, { id, min_new_messages: 20_000 })).rejects.toThrow(/10000/)
    const schedule = await t.api.routes['POST /v1/routine/add']!(t.dmCap, { kind: 'schedule', name: '定时', prompt: '总结', schedule: { type: 'daily', at: '19:00' } }) as { routine: { id: number } }
    await expect(t.api.routes['POST /v1/routine/update']!(t.dmCap, { id: schedule.routine.id, always_on_mention: false })).rejects.toThrow(TRIGGER_WATCH_ONLY)
  })
})
