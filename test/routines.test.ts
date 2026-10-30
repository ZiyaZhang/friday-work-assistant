import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator, buildRoutinePrompt, splitHeadline } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineScheduler, RoutineStore, describeSchedule, nextRunAt, parseSchedule } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import { UserTokenStore, USER_SCOPE_TIERS } from '../src/feishu/oauth.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer, ALL_SCOPES, GROUP_SCOPES } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent, type FakeTurnStep } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('test', 'error')
const TZ = 480
/** 2026-09-18 08:00 北京时间 */
const T0 = Date.UTC(2026, 8, 18, 0, 0)

describe('routine schedules', () => {
  it('parses and validates schedule specs', () => {
    expect(parseSchedule({ type: 'daily', at: '9:05' })).toEqual({ type: 'daily', at: '09:05' })
    expect(parseSchedule({ type: 'daily', at: '18:00', days: [5, 1, 1] })).toEqual({ type: 'daily', at: '18:00', days: [1, 5] })
    expect(parseSchedule({ type: 'interval', everyMinutes: 90 })).toEqual({ type: 'interval', everyMinutes: 90 })
    expect(parseSchedule({ type: 'once', at: '2026-09-20T10:00:00+08:00' })).toEqual({ type: 'once', atMs: Date.parse('2026-09-20T10:00:00+08:00') })
    expect(() => parseSchedule({ type: 'daily', at: '25:00' })).toThrow(/HH:MM/)
    expect(() => parseSchedule({ type: 'interval', everyMinutes: 1 })).toThrow(/5/)
    expect(() => parseSchedule({ type: 'weekly' })).toThrow(/type/)
  })

  it('computes the next run in Asia/Shanghai', () => {
    // 08:00 → 今天 09:00
    expect(nextRunAt({ type: 'daily', at: '09:00' }, T0, TZ)).toBe(T0 + 3600_000)
    // 09:00 整点 → 明天 09:00（严格晚于）
    expect(nextRunAt({ type: 'daily', at: '09:00' }, T0 + 3600_000, TZ)).toBe(T0 + 25 * 3600_000)
    // 2026-09-18 是周五；工作日 18:00 从周五 19:00 起 → 下周一 18:00
    const fri19 = T0 + 11 * 3600_000
    expect(new Date(nextRunAt({ type: 'daily', at: '18:00', days: [1, 2, 3, 4, 5] }, fri19, TZ)).toISOString()).toBe('2026-09-21T10:00:00.000Z')
    expect(nextRunAt({ type: 'interval', everyMinutes: 30 }, T0, TZ)).toBe(T0 + 30 * 60_000)
    expect(nextRunAt({ type: 'once', atMs: T0 - 1 }, T0, TZ)).toBe(Number.POSITIVE_INFINITY)
    expect(describeSchedule({ type: 'daily', at: '18:00', days: [1, 2, 3, 4, 5] })).toBe('工作日 18:00')
    expect(describeSchedule({ type: 'interval', everyMinutes: 120 })).toBe('每 2 小时')
  })

  it('describes explicit fixed offsets across date boundaries and keeps omitted-offset formatting compatible', () => {
    const atMs = Date.UTC(2026, 8, 20, 3, 15)
    expect(describeSchedule({ type: 'once', atMs }, -420)).toBe('一次性 2026/9/19 20:15:00')
    expect(describeSchedule({ type: 'once', atMs }, 345)).toBe('一次性 2026/9/20 09:00:00')
    expect(describeSchedule({ type: 'once', atMs }, 0)).toBe('一次性 2026/9/20 03:15:00')
    expect(describeSchedule({ type: 'once', atMs })).toBe('一次性 2026/9/20 11:15:00')
    expect(describeSchedule({ type: 'daily', at: '09:30' }, -420)).toBe('每天 09:30')
    expect(describeSchedule({ type: 'interval', everyMinutes: 30 }, 345)).toBe('每 30 分钟')
  })

  it('stores, advances, disables after repeated failures, and scopes management', () => {
    const store = new RoutineStore(new Registry(':memory:').db, TZ)
    const r = store.add({ kind: 'watch', ownerOpenId: 'ou_a', chatId: 'oc_dm', chatType: 'p2p', name: '关注发布', prompt: '发布', schedule: { type: 'daily', at: '09:00' }, watchChatIds: ['oc_g'], now: T0 })
    expect(r.nextRunAt).toBe(T0 + 3600_000)
    expect(r.deliverTo).toBe('dm')
    expect(store.due(T0)).toHaveLength(0)
    expect(store.due(T0 + 3600_000)).toHaveLength(1)
    store.advance(r.id, T0 + 3600_000)
    expect(store.get(r.id)?.nextRunAt).toBe(T0 + 25 * 3600_000)
    for (let i = 0; i < 3; i += 1) store.recordRun(r.id, 'failed', T0, 'boom')
    const after = store.get(r.id)!
    expect(after.enabled).toBe(false)
    expect(after.disabledReason).toContain('连续失败 3 次')
    expect(store.setEnabled(r.id, true, T0)?.enabled).toBe(true)
    expect(store.canManage(after, { chatId: 'oc_other', chatType: 'p2p', openId: 'ou_a' })).toBe(true)
    expect(store.canManage(after, { chatId: 'oc_dm', chatType: 'p2p', openId: 'ou_b' })).toBe(false)
    const g = store.add({ kind: 'schedule', chatId: 'oc_g', chatType: 'group', name: '日报', prompt: 'x', schedule: { type: 'interval', everyMinutes: 60 }, now: T0 })
    expect(store.canManage(g, { chatId: 'oc_g', chatType: 'group', openId: 'ou_z' })).toBe(true)
    expect(store.listFor({ chatId: 'oc_g', chatType: 'group' })).toHaveLength(1)
    expect(store.listFor({ chatId: 'oc_dm', chatType: 'p2p', ownerOpenId: 'ou_a' })).toHaveLength(1)
    // 一次性任务跑完即停
    const once = store.add({ kind: 'schedule', chatId: 'oc_g', chatType: 'group', name: '一次', prompt: 'x', schedule: { type: 'once', atMs: T0 + 1000 }, now: T0 })
    store.advance(once.id, T0 + 1000)
    expect(store.get(once.id)?.enabled).toBe(false)
  })

  it('adds nullable followup provenance twice without inventing an origin or modifying old rows', () => {
    const registry = new Registry(':memory:')
    try {
      const store = new RoutineStore(registry.db, TZ)
      const old = store.add({ kind: 'followup', ownerOpenId: 'ou_a', chatId: 'oc_g', chatType: 'group', name: 'legacy', prompt: 'retained',
        sessionKey: 'msg:legacy', schedule: { type: 'once', atMs: T0 + 60_000 }, now: T0 })
      registry.db.exec('ALTER TABLE routines DROP COLUMN origin_task_id')
      const before = registry.db.prepare('SELECT * FROM routines ORDER BY id').all()
      for (let pass = 0; pass < 2; pass += 1) {
        const migrated = new RoutineStore(registry.db, TZ)
        const rows = registry.db.prepare('SELECT * FROM routines ORDER BY id').all()
        expect(rows.map(({ origin_task_id, ...rest }) => { expect(origin_task_id).toBeNull(); return rest })).toEqual(before)
        expect(migrated.get(old.id)?.originTaskId).toBeNull()
        expect(registry.db.prepare('PRAGMA table_info(routines)').all()).toContainEqual(expect.objectContaining({ name: 'origin_task_id', notnull: 0, dflt_value: null }))
      }
    } finally { registry.close() }
  })

  it('scheduler advances before running, collapses catch-up, and records outcomes', async () => {
    const store = new RoutineStore(new Registry(':memory:').db, TZ)
    let now = T0
    const ran: number[] = []
    const a = store.add({ kind: 'schedule', chatId: 'oc_g', chatType: 'group', name: 'a', prompt: 'x', schedule: { type: 'interval', everyMinutes: 10 }, now })
    const b = store.add({ kind: 'schedule', chatId: 'oc_g', chatType: 'group', name: 'b', prompt: 'x', schedule: { type: 'interval', everyMinutes: 10 }, now })
    const s = new RoutineScheduler({
      store,
      now: () => now,
      log,
      catchUpWindowMs: 60 * 60_000,
      run: async (r) => {
        ran.push(r.id)
        if (r.id === b.id) throw new Error('b broke')
        return 'ok'
      },
    })
    expect(await s.tick()).toBe(0)
    now = T0 + 10 * 60_000
    expect(await s.tick()).toBe(2)
    expect(ran).toEqual([a.id, b.id])
    expect(store.get(a.id)?.lastStatus).toBe('ok')
    expect(store.get(b.id)?.lastStatus).toBe('failed')
    expect(store.get(a.id)?.nextRunAt).toBe(now + 10 * 60_000)
    // 宕机 5 小时后：超出补跑窗口 → 直接跳过，只推进时间
    now = T0 + 5 * 3600_000
    expect(await s.tick()).toBe(0)
    expect(store.get(a.id)?.nextRunAt).toBe(now + 10 * 60_000)
  })

  it('splits headline and builds a watch prompt', () => {
    expect(splitHeadline('**发布延期到周五**\n\n- 张三说延期')).toEqual({ headline: '发布延期到周五', rest: '- 张三说延期' })
    expect(splitHeadline('只有一行')).toEqual({ headline: '只有一行', rest: '' })
    const store = new RoutineStore(new Registry(':memory:').db, TZ)
    const r = store.add({ kind: 'watch', ownerOpenId: 'ou_a', chatId: 'oc_dm', chatType: 'p2p', name: '关注', prompt: '发布排期', schedule: { type: 'daily', at: '18:00' }, watchChatIds: ['oc_g'], now: T0 })
    const p = buildRoutinePrompt({ botName: 'Friday', routine: r, sinceMs: T0, nowMs: T0 + 3600_000, chatNames: ['研发群（chat_id=oc_g）'], manual: false })
    expect(p).toContain('关注群聊')
    expect(p).toContain('研发群（chat_id=oc_g）')
    expect(p).toContain('NOTHING')
    expect(p).toContain('发布排期')
  })
})

async function setup(script?: FakeTurnStep[]) {
  const home = mkdtempSync(join(tmpdir(), 'friday-routine-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:')
  const memory = new ChannelMemory(registry.db)
  const messageCache = new MessageCache(registry.db)
  const todos = new Todos(registry.db)
  const routines = new RoutineStore(registry.db, TZ)
  const feishu = new FakeFeishu()
  feishu.chats = [{ chatId: 'oc_g', name: '研发群' }, { chatId: 'oc_other', name: '别的群' }]
  feishu.members.set('oc_g', new Set(['ou_alice', 'ou_bot']))
  feishu.members.set('oc_other', new Set(['ou_bob']))
  const messages = new MessageService(asFeishuClient(feishu), messageCache, log)
  const tokens = new TokenIssuer('s')
  const sp = spaceDeps(registry.db)
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_g', openId: 'ou_alice' })
  feishu.nextToken.scope = [...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.watch].join(' ')
  const userTokens = new UserTokenStore(registry.db, feishu)
  const grant = await userTokens.complete({ openId: 'ou_alice', code: 'synthetic-watch', redirectUri: 'https://callback.invalid' })
  feishu.userChats.set(grant.accessToken, [{ chatId: 'oc_g', name: '研发群' }])
  feishu.identities.set(grant.accessToken, { openId: 'ou_alice', tenantKey: 'synthetic-tenant' })
  const api = createInternalApi({ feishu: asFeishuClient(feishu), memory, registry, messages, messageCache, todos, routines, ...sp, tokens, log, maxHistoryPerCall: 50,
    appId: cfg.feishu.appId, userTokens,
    resolveActorForSession: key => key === 'dm:ou_alice' || key === 'msg:1'
      ? { requesterOpenId: 'ou_alice', runId: `fixture:${key}`, stage: 'task' }
      : orchestrator.resolveActorForSession(key),
    onCrossSpaceRead: (key, read) => orchestrator.noteCrossSpaceRead(key, read),
    onChatHistoryRead: (key, read) => orchestrator.noteChatHistoryRead(key, read),
    stopRoutine: (id, mode) => orchestrator.stopRoutine(id, mode) })
  const { app, state } = createFakeAgent(script ? { script } : undefined)
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory, messages, routines, userTokens, ...sp, tokens, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  const dmCap = { sessionKey: 'dm:ou_alice', runId: 'fixture:dm:ou_alice', spaceId: dm.id, chatId: 'oc_dm', chatType: 'p2p' as const, requesterOpenId: 'ou_alice', scopes: [...ALL_SCOPES], exp: 0 }
  const groupCap = { sessionKey: 'msg:1', runId: 'fixture:msg:1', spaceId: group.id, chatId: 'oc_g', chatType: 'group' as const, requesterOpenId: 'ou_alice', scopes: [...GROUP_SCOPES], exp: 0 }
  return { cfg, registry, routines, feishu, orchestrator, runtime, api, dmCap, groupCap, state, ...sp }
}

describe('routines end to end', () => {
  it('creates a watch through the internal API within the caller scope, runs it headless and delivers a digest card', async () => {
    const t = await setup()
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(T0)
    try {
      const created = (await t.api.routes['POST /v1/routine/add']!(t.dmCap, { kind: 'watch', name: '关注发布', prompt: '发布排期', chats: ['研发群'], schedule: { type: 'daily', at: '18:00' } })) as { routine: { id: number; watchChatIds: string[]; deliverTo: string } }
      expect(created.routine.watchChatIds).toEqual(['oc_g'])
      expect(created.routine.deliverTo).toBe('dm')
      // 私聊里不能关注自己不在的群
      await expect(t.api.routes['POST /v1/routine/add']!(t.dmCap, { kind: 'watch', name: 'x', prompt: 'y', chats: ['别的群'], schedule: { type: 'daily', at: '18:00' } })).rejects.toThrow(/未能确认你在这个群/)
      // 群会话只能关注本群，deliver 到本群
      const g = (await t.api.routes['POST /v1/routine/add']!(t.groupCap, { kind: 'schedule', name: '日报', prompt: '总结今天', schedule: { type: 'daily', at: '19:00' } })) as { routine: { deliverTo: string; chatId: string } }
      expect(g.routine.deliverTo).toBe('chat')
      expect(g.routine.chatId).toBe('oc_g')

      const r = t.routines.get(created.routine.id)!
      // A real one-minute window must be read; identical creation/run seconds would
      // make this test pass without proving any history was consumed.
      expect(r.createdAt).toBe(T0)
      dateNow.mockReturnValue(T0 + 60_000)
      t.feishu.histories.set('oc_g', [
        historyMsg({ messageId: 'om_watch_qa', chatId: 'oc_g', createTimeMs: T0 + 10_000, senderName: '张三', text: 'QA 没跑完，延到周五' }),
        historyMsg({ messageId: 'om_watch_agreed', chatId: 'oc_g', createTimeMs: T0 + 20_000, senderName: '李四', text: '同意延期到周五' }),
      ])
      t.state.script = [{ kind: 'hook', run: async () => {
        const prompt = t.state.allPrompts.at(-1)!
        const session = t.registry.getSessionByAcpId(prompt.sessionId)!
        expect(prompt.text).toContain(`start_time=${new Date(T0).toISOString()}`)
        expect(prompt.text).toContain(`end_time=${new Date(T0 + 60_000).toISOString()}`)
        const actor = t.orchestrator.resolveActorForSession(session.sessionKey)!
        const page = await t.api.routes['POST /v1/chat/history']!({ ...t.dmCap, sessionKey: session.sessionKey, runId: actor.runId },
          { chat: 'oc_g', start_time: new Date(T0).toISOString(), end_time: new Date(T0 + 60_000).toISOString() }) as {
            items: { messageId: string }[]; coverage_complete: boolean; has_more: boolean
          }
        expect(page.items.map((item) => item.messageId)).toEqual(['om_watch_qa', 'om_watch_agreed'])
        expect(page.coverage_complete).toBe(true)
        expect(page.has_more).toBe(false)
      } }, { kind: 'text', text: '发布延期到周五\n\n- 张三：QA 没跑完，延到周五\n- 李四同意' }]
      const status = await t.orchestrator.runRoutine(r, { manualMessageId: 'om_manual_watch' })
      expect(status).toBe('ok')
      expect(t.feishu.calls.listChatHistory).toBeGreaterThan(0)
      expect(t.routines.get(r.id)?.messageCursorSec).toBe((T0 + 60_000) / 1000)
      const dm = t.feishu.of('sendToUser')
      expect(dm).toHaveLength(1)
      expect(dm[0]?.target).toBe('ou_alice')
      const card = JSON.stringify((dm[0]?.payload as { card: unknown }).card)
      // 2026-09-28 版式：蓝色卡头（职责名 + 「日期 · 来源」），结论置顶，短内容不折叠，没有底部说明。
      expect(card).toContain('关注群聊 · 研发群')
      expect(card).toContain('发布延期到周五')
      expect(card).toContain('"template":"blue"')
      expect(card).not.toContain('collapsible_panel')
      expect(card).not.toContain('不想再收')
      // 跑完的会话已归档，不留在活跃列表
      expect(t.registry.listRecentSessions('oc_dm').every((s) => s.status === 'archived')).toBe(true)
      const list = (await t.api.routes['POST /v1/routine/list']!(t.dmCap, {})) as { routines: { id: number }[] }
      expect(list.routines.map((x) => x.id)).toEqual([created.routine.id])
      // 群会话看不到私聊里的任务，也删不掉
      await expect(t.api.routes['POST /v1/routine/remove']!(t.groupCap, { id: created.routine.id, disable_only: false })).rejects.toThrow(/不属于/)
      await t.api.routes['POST /v1/routine/remove']!(t.dmCap, { id: created.routine.id, disable_only: false })
      expect(t.routines.get(created.routine.id)).toBeUndefined()
    } finally {
      dateNow.mockRestore()
      await t.runtime.stop()
      t.registry.close()
    }
  })

  it('stays quiet when the model answers NOTHING, and !routines lists / removes from chat', async () => {
    const t = await setup([{ kind: 'text', text: 'NOTHING' }])
    t.spaces.ensure({ kind: 'group', chatId: 'oc_g', openId: 'ou_alice' })
    const r = t.routines.add({ kind: 'schedule', ownerOpenId: 'ou_alice', chatId: 'oc_g', chatType: 'group', name: '日报', prompt: '总结', schedule: { type: 'daily', at: '19:00' }, now: T0 })
    expect(await t.orchestrator.runRoutine(r, { manualMessageId: 'om_manual_nothing' })).toBe('skipped')
    expect(t.feishu.sent).toHaveLength(0)
    const base = { eventId: 'e', chatId: 'oc_g', chatType: 'group' as const, msgType: 'text', senderOpenId: 'ou_alice', senderType: 'user', createTimeMs: T0, mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Friday' }] }
    await t.orchestrator.handleMessage({ ...base, messageId: 'om_1', text: '@Friday !routines' })
    expect(String(t.feishu.of('replyText')[0]?.payload)).toContain('#1 定时「日报」 每天 19:00 → 本群')
    await t.orchestrator.handleMessage({ ...base, messageId: 'om_2', text: '@Friday !routine off 1' })
    expect(t.routines.get(1)?.enabled).toBe(false)
    await t.orchestrator.handleMessage({ ...base, messageId: 'om_3', text: '@Friday !routine rm 1' })
    expect(t.routines.get(1)).toBeUndefined()
    expect(t.feishu.of('replyCard')).toHaveLength(0)
  })

  it('self-scheduled followups come back to the same session and topic', async () => {
    const t = await setup()
    t.feishu.threadIdForReply = 'omt_topic1'
    const base = { eventId: 'e', chatId: 'oc_g', chatType: 'group' as const, msgType: 'text', senderOpenId: 'ou_alice', senderType: 'user', createTimeMs: Date.now(), mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Friday' }] }
    // 第一条 @ 只用来建空间（见 orchestrator.enterSpace），从第二条起才是活儿
    await t.orchestrator.handleMessage({ ...base, messageId: 'om_hello', text: '@Friday 你好' })
    let created!: { followup: { id: number; kind: string; sessionKey: string }; pending: number }
    t.state.script = [{ kind: 'hook', run: async () => {
      // Self-scheduling is an action of the active host Run, never an expired cap reused after its reply.
      const server = t.state.allPrompts.at(-1)!.mcpServers[0] as { env: { name: string; value: string }[] }
      const cap = new TokenIssuer('s').verify(server.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value)!
      await expect(t.api.routes['POST /v1/followup/add']!(cap, { note: 'x', in_minutes: 0 })).rejects.toThrow(/需要 at|一分钟/)
      created = await t.api.routes['POST /v1/followup/add']!(cap, { note: '看 PR #12 合了没；合了就在这里说一声', in_minutes: 30 }) as typeof created
    } }, { kind: 'text', text: '已安排跟进。' }]
    await t.orchestrator.handleMessage({ ...base, messageId: 'om_root', text: '@Friday 盯着这个 PR，合了告诉我' })
    const session = t.registry.resolveSession(['msg:om_root'])!
    expect(created.followup.kind).toBe('followup')
    expect(created.followup.sessionKey).toBe(session.sessionKey)
    expect(t.routines.get(created.followup.id)?.originTaskId).toBe(t.registry.taskForMessage('om_root')!.id)
    expect(created.pending).toBe(1)
    const list = (await t.api.routes['POST /v1/routine/list']!(t.groupCap, {})) as { routines: { id: number; kind: string }[] }
    expect(list.routines.map((x) => x.kind)).toEqual(['followup'])

    const before = t.feishu.sent.length
    t.state.script = [{ kind: 'text', text: 'PR 已合并。' }]
    expect(await t.orchestrator.runRoutine(t.routines.get(created.followup.id)!, { manualMessageId: 'om_manual_followup' })).toBe('ok')
    const originalTask = t.registry.taskForMessage('om_root')!
    const followupTask = t.registry.listTasks(session.sessionKey).at(-1)!
    expect(followupTask.id).not.toBe(originalTask.id)
    expect(t.registry.taskWork.get(followupTask.id)).toMatchObject({ key: t.registry.taskWork.get(originalTask.id)!.key })
    const followupRun = t.registry.db.prepare('SELECT work_key FROM run_attempts WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(followupTask.id) as { work_key: string }
    expect(followupRun.work_key).toBe(t.registry.taskWork.get(originalTask.id)!.key)
    // 同一个 dsh 会话里多了一轮，提示词说明这是到点的自我安排
    const s = t.registry.getSession(session.sessionKey)!
    expect(s.turns).toBe(2)
    const prompts = t.state.sessions.get(s.acpSessionId!)?.prompts ?? []
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('[到点了]')
    expect(prompts[1]).toContain('看 PR #12 合了没')
    // 回复发到原话题（回复根消息、以话题形式），不贴表情
    const answers = t.feishu.of('replyMarkdown')
    expect(answers.length).toBeGreaterThanOrEqual(2)
    const last = answers.at(-1)!
    expect(last.target).toBe('om_root')
    expect(last.replyInThread).toBe(true)
    expect(t.feishu.reactionsOn('om_root')).toEqual(['DONE']) // 只有第一轮贴的 ✅，跟进不再贴
    expect(t.feishu.sent.length).toBeGreaterThan(before)
    // 会话归档后退化成普通 routine：新会话、结果发回群
    const r2 = t.routines.add({ kind: 'followup', ownerOpenId: 'ou_alice', chatId: 'oc_g', chatType: 'group', name: '跟进', prompt: '再看一眼', schedule: { type: 'once', atMs: Date.now() + 60_000 }, sessionKey: 'msg:gone' })
    expect(await t.orchestrator.runRoutine(r2, { manualMessageId: 'om_manual_archived_followup' })).toBe('ok')
    expect(t.feishu.of('sendToChat').at(-1)?.target).toBe('oc_g')
  })
})

describe('responsibility proposals（职责提案）', () => {
  it('模型提的职责先是提案：不跑、发卡片、接受后以点的人的身份跑', async () => {
    const t = await setup([{ kind: 'text', text: '上周进展：xxx' }])
    const out = (await t.api.routes['POST /v1/responsibility/propose']!(t.groupCap, {
      name: '每周一的上周进展汇总',
      reason: '最近三周每周一都有人在群里问上周做了什么',
      prompt: '把上周本群关于排期和交付的讨论汇总成 5 行以内',
      schedule: { type: 'daily', at: '09:00', days: [1] },
    })) as { id: number; status: string }
    expect(out.status).toBe('proposed')
    const r = t.routines.get(out.id)!
    expect(r.source).toBe('model')
    expect(r.runAs).toBeNull()
    expect(r.expiresAt).toBeGreaterThan(Date.now())
    // 提案不会被调度器捡走
    expect(t.routines.due(r.nextRunAt + 1).map((x) => x.id)).not.toContain(r.id)
    // 卡片发到了群里，带接受/忽略按钮
    const card = JSON.stringify(t.feishu.sent.at(-1)?.payload)
    expect(card).toContain('新提议')
    expect(card).toContain('每周一的上周进展汇总')
    expect(card).toContain('最近三周每周一都有人在群里问上周做了什么')
    expect(card).toContain('"decision":"accept"')

    // 别人点接受 → 以他的身份跑
    const clicked = (await t.orchestrator.handleCardAction({ value: { action: 'resp', id: r.id, decision: 'accept', v: t.routines.configVersion(r.id) }, operatorOpenId: 'ou_alice', chatId: 'oc_g', messageId: r.cardMessageId ?? undefined, raw: {} })) as { card?: { type: string; data: Record<string, unknown> } }
    const accepted = t.routines.get(r.id)!
    expect(accepted.status).toBe('active')
    expect(accepted.runAs).toBe('ou_alice')
    expect(accepted.decidedBy).toBe('ou_alice')
    expect(accepted.expiresAt).toBeNull()
    expect(t.routines.due(accepted.nextRunAt + 1).map((x) => x.id)).toContain(r.id)
    // 卡片就地改成"已接受"
    expect(JSON.stringify(t.feishu.of('patchCard').at(-1)?.payload)).toContain('已接受')
    // 回调响应里就是这张"已接受"的卡（飞书按响应更新被点的卡），没有按钮
    expect(clicked.card).toMatchObject({ type: 'raw', data: { header: { title: { content: '已接受' }, template: 'green' } } })
    expect(JSON.stringify(clicked.card?.data)).not.toContain('"decision":')
    expect(clicked.card?.data).toEqual(t.feishu.of('patchCard').at(-1)?.payload)
    // 重复点不生效
    const again = (await t.orchestrator.handleCardAction({ value: { action: 'resp', id: r.id, decision: 'ignore', v: t.routines.configVersion(r.id) }, operatorOpenId: 'ou_alice', chatId: 'oc_g', messageId: r.cardMessageId ?? undefined, raw: {} })) as { toast: { content: string }; card?: { data: Record<string, unknown> } }
    expect(again.toast.content).toContain('处理过')
    expect(again.card?.data).toEqual(clicked.card?.data)
  })

  it('无主职责只拿只读权限', async () => {
    const t = await setup([{ kind: 'text', text: 'NOTHING' }])
    t.spaces.ensure({ kind: 'group', chatId: 'oc_g', openId: 'ou_alice' })
    const r = t.routines.add({ kind: 'schedule', chatId: 'oc_g', chatType: 'group', name: '无主巡检', prompt: '看看', schedule: { type: 'daily', at: '09:00' } })
    expect(r.runAs).toBeNull()
    await t.orchestrator.runRoutine(r, { manualMessageId: 'om_manual_orphan' })
    const mcp = t.state.allPrompts.at(-1)?.mcpServers as { env: { name: string; value: string }[] }[]
    const cap = new TokenIssuer('s').verify(mcp[0]?.env.find((e) => e.name === 'FRIDAY_CAP_TOKEN')?.value ?? '')
    expect(cap?.scopes).not.toContain('dm:send')
    expect(cap?.scopes).not.toContain('github:write')
    expect(cap?.scopes).not.toContain('memory:write')
    // 有主的就是完整的群作用域
    const owned = t.routines.add({ kind: 'schedule', ownerOpenId: 'ou_alice', chatId: 'oc_g', chatType: 'group', name: '有主', prompt: '看看', schedule: { type: 'daily', at: '09:00' } })
    expect(owned.runAs).toBe('ou_alice')
    await t.orchestrator.runRoutine(owned, { manualMessageId: 'om_manual_owned' })
    const mcp2 = t.state.allPrompts.at(-1)?.mcpServers as { env: { name: string; value: string }[] }[]
    const cap2 = new TokenIssuer('s').verify(mcp2[0]?.env.find((e) => e.name === 'FRIDAY_CAP_TOKEN')?.value ?? '')
    expect(cap2?.scopes).toContain('dm:send')
  })

  it('72 小时没人处理的提案自动作废，卡片改成已作废', async () => {
    const t = await setup()
    const out = (await t.api.routes['POST /v1/responsibility/propose']!(t.groupCap, {
      name: '发版前清单核对',
      reason: '每次发版都要人工核对同一个清单',
      prompt: '核对清单',
      schedule: { type: 'daily', at: '10:00' },
    })) as { id: number }
    expect(await t.orchestrator.expireProposals()).toBe(0)
    // 把到期时间拨到过去
    t.registry.db.prepare('UPDATE routines SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, out.id)
    expect(await t.orchestrator.expireProposals()).toBe(1)
    expect(t.routines.get(out.id)?.status).toBe('expired')
    expect(JSON.stringify(t.feishu.of('patchCard').at(-1)?.payload)).toContain('作废')
    // 过期后再点接受不生效
    const res = (await t.orchestrator.handleCardAction({ value: { action: 'resp', id: out.id, decision: 'accept', v: t.routines.configVersion(out.id) }, operatorOpenId: 'ou_alice', chatId: 'oc_g', messageId: t.routines.get(out.id)?.cardMessageId ?? undefined, raw: {} })) as { toast: { content: string }; card?: { data: Record<string, unknown> } }
    expect(res.toast.content).toContain('过期')
    expect(res.card?.data).toMatchObject({ header: { title: { content: '已作废' } } })
    expect(JSON.stringify(res.card?.data)).not.toContain('"decision":')
  })

  it('同一个地方的提案有上限，也不重复提', async () => {
    const t = await setup()
    const mk = (name: string) => t.api.routes['POST /v1/responsibility/propose']!(t.groupCap, { name, reason: 'r', prompt: 'p', schedule: { type: 'daily', at: '10:00' } })
    await mk('一')
    await expect(mk('一')).rejects.toThrow(/已经提过/)
    await mk('二')
    await mk('三')
    await expect(mk('四')).rejects.toThrow(/3 条/)
  })
})

describe('改一条已有任务', () => {
  const T = Date.parse('2026-09-19T00:00:00+08:00')

  it('只改指令：不动名字、不动下次运行时间、不换编号', () => {
    const store = new RoutineStore(new Registry(':memory:').db, TZ)
    const r = store.add({ kind: 'watch', ownerOpenId: 'ou_a', chatId: 'oc_dm', chatType: 'p2p', name: '自研PPT反馈监控', prompt: '看有没有新反馈', schedule: { type: 'interval', everyMinutes: 60 }, watchChatIds: ['oc_g'], now: T })
    const before = store.get(r.id)!
    const after = store.update(r.id, { prompt: '看有没有新反馈，每条都带上 neo-ppt 产物链接' }, T + 1000)!
    expect(after.prompt).toContain('neo-ppt 产物链接')
    expect(after.name).toBe('自研PPT反馈监控')
    // 频率没改 → 下次运行时间原样，它攒下来的读取位置不受影响
    expect(after.nextRunAt).toBe(before.nextRunAt)
    expect(after.id).toBe(r.id)
  })

  it('改了频率才重排下次运行', () => {
    const store = new RoutineStore(new Registry(':memory:').db, TZ)
    const r = store.add({ kind: 'schedule', chatId: 'oc_g', chatType: 'group', name: '日报', prompt: 'x', schedule: { type: 'interval', everyMinutes: 60 }, now: T })
    const after = store.update(r.id, { schedule: { type: 'interval', everyMinutes: 120 } }, T)!
    expect(after.schedule).toEqual({ type: 'interval', everyMinutes: 120 })
    expect(after.nextRunAt).toBe(T + 120 * 60_000)
  })

  it('什么都没给就原样返回，不会把字段清空', () => {
    const store = new RoutineStore(new Registry(':memory:').db, TZ)
    const r = store.add({ kind: 'schedule', chatId: 'oc_g', chatType: 'group', name: '日报', prompt: 'x', schedule: { type: 'interval', everyMinutes: 60 }, now: T })
    const after = store.update(r.id, {}, T)!
    expect(after.prompt).toBe('x')
    expect(after.name).toBe('日报')
  })

  it('空白字符串当没给，不会把指令改没', () => {
    const store = new RoutineStore(new Registry(':memory:').db, TZ)
    const r = store.add({ kind: 'schedule', chatId: 'oc_g', chatType: 'group', name: '日报', prompt: 'x', schedule: { type: 'interval', everyMinutes: 60 }, now: T })
    expect(store.update(r.id, { prompt: '   ' }, T)!.prompt).toBe('x')
  })
})

describe('盯群的委托授权到期', () => {
  const T = Date.parse('2026-09-19T00:00:00+08:00')
  function watchFor(store: RoutineStore, runAs: string, name: string) {
    return store.add({ kind: 'watch', ownerOpenId: runAs, runAs, chatId: 'oc_dm', chatType: 'p2p', name, prompt: 'x', schedule: { type: 'interval', everyMinutes: 60 }, watchChatIds: ['oc_far'], now: T })
  }

  it('只停这个人的盯群，别人的、别的类型的都不动', () => {
    const store = new RoutineStore(new Registry(':memory:').db, TZ)
    const mine = watchFor(store, 'ou_a', '盯A')
    const mine2 = watchFor(store, 'ou_a', '盯B')
    const other = watchFor(store, 'ou_b', '别人的')
    const sched = store.add({ kind: 'schedule', ownerOpenId: 'ou_a', runAs: 'ou_a', chatId: 'oc_g', chatType: 'group', name: '日报', prompt: 'x', schedule: { type: 'interval', everyMinutes: 60 }, now: T })

    const stopped = store.suspendForExpiredAuth('ou_a', T)
    expect(stopped.map((r) => r.id).sort()).toEqual([mine.id, mine2.id].sort())
    expect(store.get(other.id)?.enabled).toBe(true)
    expect(store.get(sched.id)?.enabled).toBe(true)
  })

  it('停的时候不动游标：重新授权后从上次的位置接着读', () => {
    const store = new RoutineStore(new Registry(':memory:').db, TZ)
    const r = watchFor(store, 'ou_a', '盯A')
    store.advance(r.id, T + 3600_000)
    store.recordRun(r.id, 'ok', T + 3600_000)
    const lastRun = store.get(r.id)!.lastRunAt
    expect(lastRun).toBeTruthy()

    store.suspendForExpiredAuth('ou_a', T)
    expect(store.get(r.id)?.enabled).toBe(false)
    expect(store.get(r.id)?.lastRunAt).toBe(lastRun) // 关键：游标没被清

    const back = store.resumeAfterAuth('ou_a', T + 7200_000)
    expect(back.map((x) => x.id)).toEqual([r.id])
    expect(store.get(r.id)?.enabled).toBe(true)
    expect(store.get(r.id)?.disabledReason).toBeNull()
    expect(store.get(r.id)?.lastRunAt).toBe(lastRun) // 恢复后还是接着读
  })

  it('手动停用的不会被重新授权顺手打开', () => {
    const store = new RoutineStore(new Registry(':memory:').db, TZ)
    const r = watchFor(store, 'ou_a', '盯A')
    store.setEnabled(r.id, false, T)
    expect(store.resumeAfterAuth('ou_a', T)).toHaveLength(0)
    expect(store.get(r.id)?.enabled).toBe(false)
  })
})

describe('职责交付卡版式（2026-09-28）', () => {
  it('卡头是职责名与「日期 · 来源」，结论在最上面，短内容直接展示，长内容才折叠，没有底部说明', async () => {
    const { renderDigestCard } = await import('../src/feishu/cards.js')
    const { digestDateLabel } = await import('../src/core/orchestrator.js')
    expect(digestDateLabel(Date.parse('2026-09-27T17:30:00Z'))).toBe('9月28日')
    const short = renderDigestCard({ title: '项目群日报', subtitle: '9月28日 · 本群', conclusion: '今天没有阻塞。', body: '**进展**\n- 发布完成' }) as {
      header: { title: { content: string }; subtitle: { content: string }; template: string }; body: { elements: { tag: string; content?: string; expanded?: boolean }[] } }
    expect(short.header).toMatchObject({ title: { content: '项目群日报' }, subtitle: { content: '9月28日 · 本群' }, template: 'blue' })
    expect(short.body.elements.map((e) => e.tag)).toEqual(['markdown', 'hr', 'markdown'])
    expect(short.body.elements[0]?.content).toBe('今天没有阻塞。')
    const long = renderDigestCard({ title: 't', conclusion: '结论', body: '很长的内容', fold: true }) as { body: { elements: { tag: string; expanded?: boolean }[] } }
    expect(long.body.elements.map((e) => e.tag)).toEqual(['markdown', 'collapsible_panel'])
    expect(long.body.elements[1]?.expanded).toBe(false)
    expect(JSON.stringify(long)).not.toMatch(/每天|下次|不想再收/)
  })
})
