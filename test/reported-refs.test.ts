/**
 * P4-2 G8：跨输出只按稳定编号判重。待办提醒、职责简报在投递 ACK 之后登记 reported_refs；投递失败 / 结果未知不登记；
 * 简报的 prompt 附上近 24 小时已单独提醒过的编号（不含这条职责自己以前的简报、不含别人的），要求模型标注「已单独提醒」而不是删掉。
 * 真实 Orchestrator / TodoReminderApplication / 投递账本；飞书与模型合成。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { routineDigestDeliveryKey, routineExecutionKey } from '../src/core/execution-keys.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator, buildRoutinePrompt } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { ReportedRefs, extractStableRefs, normalizeStableRef } from '../src/core/reported-refs.js'
import { RoutineScheduler, RoutineStore } from '../src/core/routines.js'
import { TodoReminderApplication, todoReminderKey, type TodoReminderResult } from '../src/core/todo-reminder-application.js'
import { Todos } from '../src/core/todos.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('reported-refs', 'error')
const TZ = 480
const HOUR = 3600_000
const NOW = 1_800_000_000_000
/** 2026-09-25 09:00 北京时间 */
const START = Date.UTC(2026, 8, 25, 1)
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

function rows(registry: Registry) {
  return registry.db.prepare('SELECT owner_open_id, ref, output_key, delivered_at FROM reported_refs ORDER BY owner_open_id, ref, output_key').all()
}

describe('ReportedRefs: store and stable-ref extraction', () => {
  it('accepts only the four stable ref kinds and lower-cases gh repositories', () => {
    expect(normalizeStableRef('todo:12')).toBe('todo:12')
    expect(normalizeStableRef(' inbox:3 ')).toBe('inbox:3')
    expect(normalizeStableRef('msg:om_abc-1')).toBe('msg:om_abc-1')
    expect(normalizeStableRef('gh:Org/Demo#7')).toBe('gh:org/demo#7')
    for (const bad of ['todo:0', 'todo:abc', 'issue:12', '#12', 'msg:12', 'gh:org#7', 'gh:org/demo#0', 'gh:org/demo', '']) expect(normalizeStableRef(bad), bad).toBeUndefined()
  })

  it('extracts explicit refs from delivered text in order without duplicates; a bare #n or a deeper path is not a ref', () => {
    const text = '待办 [todo:12] 已过期；另见 todo:12 和 [inbox:3]。Issue org/demo#7、https://github.com/Org/Demo/issues/7 与 https://github.com/org/demo/pull/8；gh:org/demo#9；消息 msg:om_abc-1；裸的 #15 不算；路径 a/b/c#12 不算。'
    expect(extractStableRefs(text)).toEqual(['todo:12', 'inbox:3', 'msg:om_abc-1', 'gh:org/demo#9', 'gh:org/demo#7', 'gh:org/demo#8'])
    expect(extractStableRefs('没有编号的一段话 #12 #todo')).toEqual([])
  })

  it('record ignores invalid refs and repeats; recent() returns the latest row per ref inside the window and can exclude an output prefix', () => {
    const registry = new Registry(':memory:')
    cleanup.push(() => registry.close())
    const refs = new ReportedRefs(registry.db)
    expect(refs.record({ ownerOpenId: 'ou_a', refs: ['todo:12', 'todo:12', 'bogus', 'gh:Org/Demo#7'], outputKey: 'todo-reminder:12:1:24h', deliveredAt: NOW - HOUR })).toBe(2)
    expect(refs.record({ ownerOpenId: 'ou_a', refs: ['todo:12'], outputKey: 'todo-reminder:12:1:24h', deliveredAt: NOW })).toBe(0)
    expect(refs.record({ ownerOpenId: 'ou_a', refs: ['todo:12'], outputKey: 'routine:1:occurrence:1:v1:digest', deliveredAt: NOW - 2 * HOUR })).toBe(1)
    expect(refs.record({ ownerOpenId: 'ou_b', refs: ['todo:12'], outputKey: 'x', deliveredAt: NOW })).toBe(1)
    expect(refs.record({ ownerOpenId: '', refs: ['todo:1'], outputKey: 'x', deliveredAt: NOW })).toBe(0)
    expect(refs.record({ ownerOpenId: 'ou_a', refs: ['todo:1'], outputKey: '', deliveredAt: NOW })).toBe(0)
    expect(refs.recent('ou_a', NOW - 24 * HOUR)).toEqual([
      { ref: 'gh:org/demo#7', outputKey: 'todo-reminder:12:1:24h', deliveredAt: NOW - HOUR },
      { ref: 'todo:12', outputKey: 'todo-reminder:12:1:24h', deliveredAt: NOW - HOUR },
    ])
    expect(refs.recent('ou_a', NOW - 24 * HOUR, { excludeOutputPrefix: 'todo-reminder:' })).toEqual([{ ref: 'todo:12', outputKey: 'routine:1:occurrence:1:v1:digest', deliveredAt: NOW - 2 * HOUR }])
    expect(refs.recent('ou_a', NOW - 30 * 60_000)).toEqual([])
    expect(refs.record({ ownerOpenId: 'ou_a', refs: ['todo:12'], outputKey: 'old', deliveredAt: NOW - 30 * HOUR })).toBe(1)
    expect(refs.recent('ou_a', NOW - 24 * HOUR).map(r => r.ref)).toEqual(['gh:org/demo#7', 'todo:12'])
    expect(registry.db.prepare('SELECT count(*) AS n FROM reported_refs').get()?.n).toBe(5)
    // 再构造一次不改表
    const schema = registry.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'reported_refs'").get()
    new ReportedRefs(registry.db)
    expect(registry.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'reported_refs'").get()).toEqual(schema)
  })
})

describe('todo reminders register todo:<id> after the ACK', () => {
  function fixture() {
    const registry = new Registry(':memory:')
    cleanup.push(() => registry.close())
    const sp = spaceDeps(registry.db)
    const group = sp.spaces.ensure({ kind: 'group', chatId: 'chat-group', openId: 'alice' })
    sp.spaces.addMember(group.id, 'bob', 'member')
    sp.spaces.ensure({ kind: 'p2p', chatId: 'chat-dm', openId: 'alice' })
    sp.spaces.ensure({ kind: 'p2p', chatId: 'chat-dm-bob', openId: 'bob' })
    registry.createSession({ sessionKey: 'origin', chatId: 'chat-group', chatType: 'group', requesterOpenId: 'someone-else', cwd: '/synthetic' })
    const todos = new Todos(registry.db), feishu = new FakeFeishu(), transitions: TodoReminderResult[] = []
    feishu.members.set('chat-group', new Set(['alice', 'bob']))
    let now = NOW
    const reportedRefs = new ReportedRefs(registry.db)
    const options = { db: registry.db, registry, todos, ...sp, feishu: asFeishuClient(feishu), now: () => now, reportedRefs, onStateChange: (r: TodoReminderResult) => transitions.push(r) }
    const app = new TodoReminderApplication(options)
    const add = (patch: Partial<Parameters<Todos['add']>[0]> = {}) => todos.add({ scope: `space:${group.id}`, title: '合成待办', dueMs: NOW + 12 * HOUR, createdBy: 'alice', sessionKey: 'origin', ...patch })
    return { registry, group, todos, feishu, app, options, add, setNow: (value: number) => { now = value } }
  }

  it('a group notice registers for the creator, a personal nudge for the person whose DM received it', async () => {
    const t = fixture(), shared = t.add({ kind: 'deadline' }), personal = t.add({ ownerOpenId: 'bob', owner: 'Bob' })
    expect(await t.app.runDue()).toMatchObject({ sent: 2, attempted: 2 })
    expect(t.feishu.sent.map(s => [s.kind, s.target])).toEqual([['sendToChat', 'chat-group'], ['sendToUser', 'bob']])
    expect(rows(t.registry)).toEqual([
      { owner_open_id: 'alice', ref: `todo:${shared.id}`, output_key: todoReminderKey(shared.id, shared.dueMs!, '24h'), delivered_at: NOW },
      { owner_open_id: 'bob', ref: `todo:${personal.id}`, output_key: todoReminderKey(personal.id, personal.dueMs!, '24h'), delivered_at: NOW },
    ])
    // 同一阶段不再发，也不再登记
    expect(await t.app.runDue()).toMatchObject({ sent: 0, attempted: 0 })
    expect(rows(t.registry)).toHaveLength(2)
  })

  it('a lost ACK (result unknown) registers nothing, then or later', async () => {
    const t = fixture(), todo = t.add({ kind: 'freeze', dueMs: NOW + 5 * HOUR })
    const realSend = t.feishu.sendToChat.bind(t.feishu)
    vi.spyOn(t.feishu, 'sendToChat').mockImplementation(async (...args) => { await realSend(...args); throw new Error('synthetic lost ACK') })
    expect(await t.app.runDue()).toMatchObject({ attempted: 1, sent: 0, results: [expect.objectContaining({ status: 'unknown' })] })
    expect(rows(t.registry)).toEqual([])
    t.setNow(NOW + 4 * HOUR)
    expect(await new TodoReminderApplication(t.options).runDue()).toMatchObject({ attempted: 0 })
    expect(rows(t.registry)).toEqual([])
    expect(t.registry.db.prepare('SELECT status FROM deliveries WHERE delivery_key = ?').get(todoReminderKey(todo.id, todo.dueMs!, '24h'))).toEqual({ status: 'unknown' })
  })
})

async function digestFixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-reported-refs-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const clock = { now: START }
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
  const registry = new Registry(':memory:')
  const routines = new RoutineStore(registry.db, TZ), sp = spaceDeps(registry.db)
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_g', openId: 'ou_alice' })
  const feishu = new FakeFeishu()
  feishu.chats = [{ chatId: 'oc_g', name: '研发群' }]
  feishu.members.set('oc_g', new Set(['ou_alice', 'ou_bot']))
  const messages = new MessageService(asFeishuClient(feishu), new MessageCache(registry.db), log)
  const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: '合成简报\n有一条合成变化' }] })
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  const reportedRefs = new ReportedRefs(registry.db)
  orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory: new ChannelMemory(registry.db), messages, routines, reportedRefs, ...sp,
    tokens: new TokenIssuer('s'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log, now: () => clock.now })
  const scheduler = new RoutineScheduler({ store: routines, log, now: () => clock.now, run: (r, occurrence) => orchestrator.runRoutine(r, { occurrence }) })
  cleanup.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  // 群里的定时简报：不需要读消息窗口，模型回什么就发什么。
  const routine = routines.add({ kind: 'schedule', ownerOpenId: 'ou_alice', spaceId: group.id, chatId: 'oc_g', chatType: 'group', name: '日报', prompt: '总结今天',
    schedule: { type: 'daily', at: '18:00' }, deliverTo: 'chat', now: START })
  const tick = async () => { clock.now = routines.get(routine.id)!.nextRunAt; return scheduler.tick() }
  return { registry, routines, routine, feishu, orchestrator, state, clock, reportedRefs, tick }
}

describe('the digest prompt carries refs reminded in the last 24 hours, and the digest registers its own refs after the ACK', () => {
  it('lists this person’s recent refs, not older ones, not another person’s, not this routine’s earlier digests; registers what the digest cited', async () => {
    const t = await digestFixture()
    const runAt = t.routines.get(t.routine.id)!.nextRunAt
    t.reportedRefs.record({ ownerOpenId: 'ou_alice', refs: ['todo:12'], outputKey: 'todo-reminder:12:1:24h', deliveredAt: runAt - HOUR })
    t.reportedRefs.record({ ownerOpenId: 'ou_alice', refs: ['gh:org/demo#7'], outputKey: 'issue-validity:old', deliveredAt: runAt - 30 * HOUR })
    t.reportedRefs.record({ ownerOpenId: 'ou_alice', refs: ['inbox:3'], outputKey: `routine:${t.routine.id}:occurrence:0:v1:digest`, deliveredAt: runAt - HOUR })
    t.reportedRefs.record({ ownerOpenId: 'ou_bob', refs: ['todo:99'], outputKey: 'todo-reminder:99:1:24h', deliveredAt: runAt - HOUR })
    t.state.script = [{ kind: 'text', text: '合成简报\n- 待办 [todo:12] 仍未完成（已单独提醒）\n- Issue org/demo#8 等 review' }]
    expect(await t.tick()).toBe(1)
    const prompt = t.state.allPrompts[0]!.text
    expect(prompt).toContain('[已单独提醒] 近 24 小时里这些对象已经单独提醒过')
    expect(prompt).toContain('- todo:12（')
    expect(prompt).toContain('标注「已单独提醒」，不要因此删掉这一条')
    expect(prompt).not.toContain('gh:org/demo#7')
    expect(prompt).not.toContain('inbox:3')
    expect(prompt).not.toContain('todo:99')
    const occurrence = t.routines.listOccurrences(t.routine.id, 1)[0]!
    expect(occurrence.status).toBe('ok')
    expect(t.feishu.of('sendToChat')).toHaveLength(1)
    const key = routineDigestDeliveryKey(routineExecutionKey(t.routine.id, { occurrenceId: occurrence.id, configVersion: occurrence.configVersion }))
    expect(t.registry.db.prepare('SELECT status FROM deliveries WHERE delivery_key = ?').get(key)).toEqual({ status: 'sent' })
    expect(rows(t.registry).filter(row => row.output_key === key)).toEqual([
      { owner_open_id: 'ou_alice', ref: 'gh:org/demo#8', output_key: key, delivered_at: t.clock.now },
      { owner_open_id: 'ou_alice', ref: 'todo:12', output_key: key, delivered_at: t.clock.now },
    ])
  })

  it('a digest whose delivery result is unknown registers nothing', async () => {
    const t = await digestFixture()
    vi.spyOn(t.feishu, 'sendToChat').mockRejectedValue(new Error('synthetic send failure'))
    t.state.script = [{ kind: 'text', text: '合成简报\n- 待办 [todo:12] 仍未完成' }]
    expect(await t.tick()).toBe(1)
    expect(t.routines.listOccurrences(t.routine.id, 1)[0]?.status).toBe('failed')
    expect(t.registry.db.prepare("SELECT status FROM deliveries WHERE delivery_key LIKE 'routine:%'").all()).toEqual([{ status: 'unknown' }])
    expect(rows(t.registry)).toEqual([])
  })

  it('buildRoutinePrompt only adds the section when there is something to annotate', () => {
    const registry = new Registry(':memory:')
    cleanup.push(() => registry.close())
    const r = new RoutineStore(registry.db, TZ).add({ kind: 'schedule', ownerOpenId: 'ou_a', chatId: 'oc_g', chatType: 'group', name: '日报', prompt: '总结', schedule: { type: 'daily', at: '18:00' }, now: START })
    const plain = buildRoutinePrompt({ botName: 'Friday', routine: r, sinceMs: START, nowMs: START + HOUR, chatNames: [], manual: false })
    expect(plain).not.toContain('已单独提醒')
    const annotated = buildRoutinePrompt({ botName: 'Friday', routine: r, sinceMs: START, nowMs: START + HOUR, chatNames: [], manual: false,
      reportedRefs: [{ ref: 'todo:12', outputKey: 'todo-reminder:12:1:24h', deliveredAt: START }, { ref: 'gh:org/demo#7', outputKey: 'issue-validity:x', deliveredAt: START }] })
    expect(annotated).toContain('- todo:12（')
    expect(annotated).toContain('- gh:org/demo#7（')
    expect(annotated).toContain('判断是不是同一件事只看编号，不猜')
  })
})
