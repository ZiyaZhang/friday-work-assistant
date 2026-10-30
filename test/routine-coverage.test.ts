import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineScheduler, RoutineStore } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const START = Date.UTC(2026, 8, 19)
const log = createLogger('routine-coverage', 'error')
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

function setup(chats = ['oc_a']) {
  const home = mkdtempSync(join(tmpdir(), 'friday-routine-coverage-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), routines = new RoutineStore(registry.db), sp = spaceDeps(registry.db)
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
  const feishu = new FakeFeishu()
  feishu.chats = ['oc_a', 'oc_b'].map((chatId) => ({ chatId, name: chatId }))
  for (const chatId of ['oc_a', 'oc_b']) { sp.spaces.ensure({ kind: 'group', chatId, openId: 'ou_alice' }); feishu.members.set(chatId, new Set(['ou_alice'])) }
  const cache = new MessageCache(registry.db), messages = new MessageService(asFeishuClient(feishu), cache, log)
  const memory = new ChannelMemory(registry.db), tokens = new TokenIssuer('synthetic')
  const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: 'NOTHING' }] })
  const clock = { now: START + 60_000 }
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, registry, routines, ...sp, memory, feishu: asFeishuClient(feishu), messages, runtime, tokens,
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log, now: () => clock.now })
  const receipts: { chatId: string; startSec: number; endSec: number }[] = []
  const api = createInternalApi({ registry, routines, ...sp, memory, feishu: asFeishuClient(feishu), messages, messageCache: cache,
    todos: new Todos(registry.db), tokens, log, maxHistoryPerCall: 50,
    resolveActorForSession: (key) => orchestrator.resolveActorForSession(key),
    onChatHistoryRead: (key, read) => { receipts.push(read); orchestrator.noteChatHistoryRead(key, read) },
    onCrossSpaceRead: (key, read) => orchestrator.noteCrossSpaceRead(key, read) })
  const routine = routines.add({ kind: 'watch', ownerOpenId: 'ou_alice', spaceId: dm.id, chatId: 'oc_dm', chatType: 'p2p', name: '合成消息窗口',
    prompt: '只看合成标记，没变化就不发', schedule: { type: 'interval', everyMinutes: 5 }, watchChatIds: chats, deliverTo: 'dm', now: START })
  const read = async (over: Record<string, unknown> = {}) => {
    const acpId = state.allPrompts.at(-1)!.sessionId
    const servers = state.sessions.get(acpId)!.mcpServers as { env?: { name: string; value: string }[] }[]
    const token = servers.flatMap(server => server.env ?? []).find(item => item.name === 'FRIDAY_CAP_TOKEN')?.value
    const cap = token && tokens.verify(token)
    if (!cap?.runId) throw new Error('历史读取夹具必须使用本轮 ACP 收到的签名 token')
    return await api.routes['POST /v1/chat/history']!(cap,
      { chat: 'oc_a', start_time: new Date(START).toISOString(), end_time: new Date(START + 60_000).toISOString(), ...over }) as { has_more: boolean; next_start_time: string | null; items: { messageId: string }[] }
  }
  const run = (id: string) => orchestrator.runRoutine(routines.get(routine.id)!, { manualMessageId: id })
  const scheduler = new RoutineScheduler({ store: routines, log, now: () => clock.now, run: (r, occurrence) => orchestrator.runRoutine(r, { occurrence }) })
  cleanup.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  return { registry, routines, routine, feishu, cache, messages, state, clock, runtime, run, read, scheduler, receipts }
}

describe('watch message coverage is independent from run completion', () => {
  it.each([false, true])('keeps every_run empty-result delivery behind complete watch coverage (%s)', async (complete) => {
    const t = setup()
    t.routines.update(t.routine.id, { deliveryPolicy: 'every_run' })
    t.state.script = [{ kind: 'hook', run: async () => { if (complete) await t.read() } }, { kind: 'text', text: 'NOTHING' }]
    await expect(t.run('om_required_empty')).rejects.toThrow(complete ? '已发送失败提示' : '尚未完整读取')
    expect(t.feishu.sent).toHaveLength(complete ? 1 : 0)
    if (complete) expect(t.feishu.of('sendToUser')[0]?.payload).toEqual({ text: `「${t.routine.name}」这次没有生成结果，跟我说一声就能重跑一次。` })
    expect(t.routines.get(t.routine.id)?.messageCursorSec).toBeNull()
    // A sent failure notice is not a coverage receipt and must not advance the cursor on the next run.
    t.state.script = [{ kind: 'text', text: 'NOTHING' }]
    await expect(t.run('om_after_required_empty')).rejects.toThrow('尚未完整读取')
    expect(t.routines.get(t.routine.id)?.messageCursorSec).toBeNull()
    expect(t.feishu.sent).toHaveLength(complete ? 1 : 0)
  })

  it('combines real pages, commits the fixed end, and reads arrivals during execution next time', async () => {
    const t = setup()
    t.feishu.histories.set('oc_a', [1, 2, 3].map((second) => historyMsg({ messageId: `om_${second}`, createTimeMs: START + second * 1000, text: 'synthetic' })))
    t.state.script = [{ kind: 'hook', run: async () => {
      const first = await t.read({ limit: 2 })
      expect(first.has_more).toBe(true)
      const last = await t.read({ start_time: first.next_start_time, limit: 2 })
      expect(last.has_more).toBe(false)
      t.clock.now += 5000
    } }, { kind: 'text', text: 'NOTHING' }]
    expect(await t.run('om_first')).toBe('skipped')
    expect(t.routines.get(t.routine.id)?.messageCursorSec).toBe((START + 60_000) / 1000)
    t.feishu.histories.get('oc_a')!.push(historyMsg({ messageId: 'om_during_execution', createTimeMs: START + 61_000, text: 'arrived during processing' }))
    t.state.script = [{ kind: 'hook', run: async () => {
      const prompt = JSON.stringify(t.state.allPrompts.at(-1))
      expect(prompt).toContain(`start_time=${new Date(START + 60_000).toISOString()}`)
      expect(prompt).toContain(`end_time=${new Date(START + 65_000).toISOString()}`)
      const page = await t.read({ start_time: new Date(START + 60_000).toISOString(), end_time: new Date(START + 65_000).toISOString() })
      expect(page.items.map((m) => m.messageId)).toContain('om_during_execution')
    } }, { kind: 'text', text: 'NOTHING' }]
    await t.run('om_second')
    expect(t.routines.get(t.routine.id)?.messageCursorSec).toBe((START + 65_000) / 1000)
    expect(t.feishu.sent).toHaveLength(0)
  })

  it.each(['last-page-only', 'gap', 'keyword', 'same-second', 'only-one-chat'] as const)('does not consume incomplete coverage: %s', async (mode) => {
    const t = setup(mode === 'only-one-chat' ? ['oc_a', 'oc_b'] : ['oc_a'])
    if (mode === 'same-second') t.feishu.histories.set('oc_a', [1, 2].map((id) => historyMsg({ messageId: `om_${id}`, createTimeMs: START + 1000, text: 'synthetic' })))
    t.state.script = [{ kind: 'hook', run: async () => {
      if (mode === 'last-page-only') await t.read({ start_time: new Date(START + 1000).toISOString() })
      if (mode === 'gap') { await t.read({ end_time: new Date(START + 20_000).toISOString() }); await t.read({ start_time: new Date(START + 21_000).toISOString() }) }
      if (mode === 'keyword') await t.read({ keyword: 'synthetic' })
      if (mode === 'same-second') expect((await t.read({ limit: 1 })).has_more).toBe(true)
      if (mode === 'only-one-chat') await t.read()
    } }, { kind: 'text', text: 'NOTHING' }]
    await expect(t.run(`om_${mode}`)).rejects.toThrow('尚未完整读取')
    expect(t.routines.get(t.routine.id)?.messageCursorSec).toBeNull()
    expect(t.feishu.sent).toHaveLength(0)
  })

  it('commits after the send receipt and reuses the same manual delivery without another POST', async () => {
    const t = setup()
    t.state.script = [{ kind: 'hook', run: async () => { await t.read() } }, { kind: 'text', text: '合成摘要\n有一条合成变化' }]
    const send = t.feishu.sendToUser.bind(t.feishu)
    vi.spyOn(t.feishu, 'sendToUser').mockImplementation(async (...args) => {
      expect(t.routines.get(t.routine.id)?.messageCursorSec).toBeNull()
      t.clock.now += 4000
      return send(...args)
    })
    expect(await t.run('om_send_once')).toBe('ok')
    expect(t.routines.get(t.routine.id)?.messageCursorSec).toBe((START + 60_000) / 1000)
    expect(await t.run('om_send_once')).toBe('ok')
    expect(t.feishu.sent).toHaveLength(1)
    expect(t.state.allPrompts).toHaveLength(1)
  })

  it('requires every configured source, accepting different page boundaries and empty streams', async () => {
    const t = setup(['oc_a', 'oc_b'])
    t.state.script = [{ kind: 'hook', run: async () => {
      await t.read()
      await t.read({ chat: 'oc_b', end_time: new Date(START + 30_000).toISOString() })
      await t.read({ chat: 'oc_b', start_time: new Date(START + 30_000).toISOString() })
    } }, { kind: 'text', text: 'NOTHING' }]
    await t.run('om_multi_chat')
    expect(t.routines.get(t.routine.id)?.messageCursorSec).toBe((START + 60_000) / 1000)
  })

  it.each(['before-read', 'after-read', 'cancelled'] as const)('keeps the cursor despite updated failure statistics: %s', async (mode) => {
    const t = setup()
    t.clock.now = t.routine.nextRunAt
    const end = new Date(t.clock.now).toISOString()
    t.state.script = [{ kind: 'hook', run: async () => {
      if (mode !== 'before-read') await t.read({ end_time: end })
      t.clock.now += 3000
      if (mode !== 'cancelled') throw new Error('synthetic read/execution failure')
    } }, { kind: 'text', text: 'NOTHING' }]
    if (mode === 'cancelled') {
      const prompt = t.runtime.prompt.bind(t.runtime)
      vi.spyOn(t.runtime, 'prompt').mockImplementation(async (...args) => ({ ...await prompt(...args), stopReason: 'cancelled' }))
    }
    await t.scheduler.tick()
    expect(t.routines.get(t.routine.id)).toMatchObject({ messageCursorSec: null, lastStatus: 'failed', lastRunAt: t.clock.now })
    expect(t.feishu.sent).toHaveLength(0)
  })

  it('does not advance on unknown delivery or send again under the next occurrence key', async () => {
    const t = setup()
    t.clock.now = t.routine.nextRunAt
    const end = new Date(t.clock.now).toISOString()
    t.state.script = [{ kind: 'hook', run: async () => { await t.read({ end_time: end }) } }, { kind: 'text', text: '合成消息\n有一条合成变化' }]
    const send = t.feishu.sendToUser.bind(t.feishu)
    vi.spyOn(t.feishu, 'sendToUser').mockImplementation(async (...args) => { await send(...args); throw new Error('synthetic lost ACK') })
    await t.scheduler.tick()
    expect(t.routines.get(t.routine.id)?.messageCursorSec).toBeNull()
    expect(t.feishu.sent).toHaveLength(1)
    t.clock.now = t.routines.get(t.routine.id)!.nextRunAt
    await t.scheduler.tick()
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.sent).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT status FROM deliveries').all()).toEqual([{ status: 'unknown' }])
  })

  it('recovers the covered window after sent was persisted but committing the cursor was interrupted', async () => {
    const t = setup()
    t.clock.now = t.routine.nextRunAt
    const firstEnd = t.clock.now
    t.state.script = [{ kind: 'hook', run: async () => { await t.read({ end_time: new Date(firstEnd).toISOString() }) } }, { kind: 'text', text: '合成摘要\n已发送的那条变化' }]
    vi.spyOn(t.routines, 'advanceMessageCursor').mockImplementationOnce(() => { throw new Error('synthetic interruption after durable ACK') })
    await t.scheduler.tick()
    expect(t.routines.get(t.routine.id)?.messageCursorSec).toBeNull()
    expect(t.registry.db.prepare('SELECT status FROM deliveries').all()).toEqual([{ status: 'sent' }])
    t.clock.now = t.routines.get(t.routine.id)!.nextRunAt
    const nextEnd = t.clock.now
    t.state.script = [{ kind: 'hook', run: async () => {
      expect(t.routines.get(t.routine.id)?.messageCursorSec).toBe(firstEnd / 1000)
      expect(JSON.stringify(t.state.allPrompts.at(-1))).toContain(`start_time=${new Date(firstEnd).toISOString()}`)
      await t.read({ start_time: new Date(firstEnd).toISOString(), end_time: new Date(nextEnd).toISOString() })
    } }, { kind: 'text', text: 'NOTHING' }]
    await t.scheduler.tick()
    expect(t.routines.get(t.routine.id)?.messageCursorSec).toBe(nextEnd / 1000)
    expect(t.feishu.sent).toHaveLength(1)
  })

  it('does not infer legacy coverage from last_run_at, or let stale configuration commit a cursor', () => {
    const t = setup()
    t.routines.recordRun(t.routine.id, 'ok', START + 60_000)
    t.registry.db.exec('ALTER TABLE routines DROP COLUMN message_cursor_sec')
    const reopened = new RoutineStore(t.registry.db)
    expect(reopened.get(t.routine.id)).toMatchObject({ lastRunAt: START + 60_000, messageCursorSec: null })
    const version = reopened.configVersion(t.routine.id)!
    reopened.update(t.routine.id, { prompt: '新的明确指令' })
    expect(reopened.advanceMessageCursor(t.routine.id, version, START / 1000, (START + 60_000) / 1000)).toBe(false)
    expect(reopened.get(t.routine.id)?.messageCursorSec).toBeNull()
  })
})
