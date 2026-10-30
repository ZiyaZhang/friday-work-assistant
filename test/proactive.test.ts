import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Proactive } from '../src/core/proactive.js'
import { Signals } from '../src/core/signals.js'
import { Spaces } from '../src/core/space.js'
import { Registry } from '../src/core/registry.js'
import { Todos } from '../src/core/todos.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createFakeAgent, type FakeTurnStep } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('test', 'error')

describe('Proactive enablement records who enabled it', () => {
  it('refuses to enable without the person who asked, and never clears an existing enabler', () => {
    const p = new Proactive(new Registry(':memory:').db, { quietMs: 20, minMessages: 2, maxPerHour: 1, dormantAfter: 2, now: () => 1_000_000 })
    expect(() => p.enable('oc_new')).toThrow(/谁开启/)
    expect(p.get('oc_new')).toMatchObject({ enabled: false, enabledBy: null })
    p.enable('oc_1', 'ou_owner')
    expect(() => p.enable('oc_1', '  ')).toThrow(/谁开启/)
    expect(p.get('oc_1')).toMatchObject({ enabled: true, enabledBy: 'ou_owner' })
  })
})

describe('Proactive store', () => {
  it('debounces, needs enough messages, rate-limits and goes dormant', async () => {
    let now = 1_000_000
    const p = new Proactive(new Registry(':memory:').db, { quietMs: 20, minMessages: 2, maxPerHour: 1, dormantAfter: 2, now: () => now })
    const runs: string[] = []
    const run = async (id: string): Promise<void> => {
      runs.push(id)
    }
    expect(p.observe('oc_1', run)).toBe(false) // 没开
    p.enable('oc_1', 'ou_a')
    expect(p.observe('oc_1', run)).toBe(true)
    await new Promise((r) => setTimeout(r, 40))
    expect(runs).toEqual([]) // 只有 1 条：不够
    p.observe('oc_1', run)
    p.observe('oc_1', run)
    await new Promise((r) => setTimeout(r, 40))
    expect(runs).toEqual(['oc_1'])
    // 主动发言一次后这小时额度用完
    p.record('oc_1', { acted: true, checkedUntil: now })
    expect(p.quotaLeft('oc_1')).toBe(0)
    p.observe('oc_1', run)
    p.observe('oc_1', run)
    await new Promise((r) => setTimeout(r, 40))
    expect(runs).toEqual(['oc_1'])
    now += 3600_001
    expect(p.quotaLeft('oc_1')).toBe(1)
    // 连续两次没动作 → 休眠；@ 一下醒来
    p.record('oc_1', { acted: false, checkedUntil: now })
    expect(p.get('oc_1').dormantSince).toBeNull()
    p.record('oc_1', { acted: false, checkedUntil: now })
    expect(p.get('oc_1').dormantSince).toBe(now)
    expect(p.observe('oc_1', run)).toBe(false)
    expect(p.describe('oc_1')).toContain('休眠中')
    p.wake('oc_1')
    expect(p.get('oc_1').dormantSince).toBeNull()
    expect(p.get('oc_1').noopStreak).toBe(0)
    p.disable('oc_1')
    expect(p.observe('oc_1', run)).toBe(false)
    expect(p.describe('oc_1')).toContain('关')
  })
})

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    eventId: `ev_${Math.random()}`,
    messageId: `om_${Math.random().toString(36).slice(2, 8)}`,
    chatId: 'oc_group',
    chatType: 'group',
    msgType: 'text',
    text: '随便聊聊',
    senderOpenId: 'ou_alice',
    senderType: 'user',
    mentions: [],
    createTimeMs: Date.now(),
    ...over,
  }
}

async function setup(script?: FakeTurnStep[]) {
  const home = mkdtempSync(join(tmpdir(), 'friday-proactive-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_REFLECT: 'off', FRIDAY_PROACTIVE_QUIET_MS: '30', FRIDAY_PROACTIVE_MIN_MESSAGES: '2' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:')
  const memory = new ChannelMemory(registry.db)
  const messageCache = new MessageCache(registry.db)
  const feishu = new FakeFeishu()
  feishu.chats = [{ chatId: 'oc_group', name: '研发群' }]
  feishu.names.set('ou_alice', '张三')
  const messages = new MessageService(asFeishuClient(feishu), messageCache, log)
  const proactive = new Proactive(registry.db, cfg.proactive)
  let signalNow = Date.now()
  const signals = new Signals(registry.db, () => signalNow)
  const { app, state } = createFakeAgent(script ? { script } : undefined)
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory, messages, todos: new Todos(registry.db), ...spaceDeps(registry.db), proactive, signals, tokens: new TokenIssuer('s'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  const spaces = new Spaces(registry.db)
  spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_alice' }) // 由真实负责人开启主动模式
  return { cfg, registry, feishu, proactive, signals, spaces, orchestrator, state, messageCache, tickSignals: (ms: number) => (signalNow += ms) }
}

describe('proactive mode end to end', () => {
  it.each(['disabled', 'archived', 'owner_removed'] as const)('评估完成前 %s，不再主动发言', async (change) => {
    const t = await setup()
    t.proactive.enable('oc_group', 'ou_alice')
    const space = t.spaces.byChat('oc_group')!
    t.state.script = [{ kind: 'hook', run: () => {
      if (change === 'disabled') t.proactive.disable('oc_group')
      else if (change === 'archived') t.spaces.suspend(space.id)
      else t.spaces.removeMember(space.id, 'ou_alice')
    } }, { kind: 'text', text: '这里有一个确定的答案。' }]
    await t.orchestrator.handleMessage(msg({ messageId: 'om_current1', text: '讨论一', createTimeMs: Date.now() + 1000 }))
    await t.orchestrator.handleMessage(msg({ messageId: 'om_current2', text: '讨论二', createTimeMs: Date.now() + 2000 }))
    expect(await t.orchestrator.runProactiveCheck('oc_group')).toBe('skipped')
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.sent).toHaveLength(0)
  })

  it('评估读了应用可见文档，不能跳过来源门禁把内容发给全群', async () => {
    const t = await setup()
    t.proactive.enable('oc_group', 'ou_alice')
    t.state.script = [{ kind: 'hook', run: () => {
      const mcp = t.state.allPrompts.at(-1)!.mcpServers as { env: { name: string; value: string }[] }[]
      const cap = new TokenIssuer('s').verify(mcp[0]!.env.find(e => e.name === 'FRIDAY_CAP_TOKEN')!.value)!
      t.orchestrator.noteExternalSource(cap.sessionKey, { kind: 'document', ref: 'private-document' })
    } }, { kind: 'text', text: '不该发往群里的文档正文。' }]
    await t.orchestrator.handleMessage(msg({ messageId: 'om_doc1', text: '讨论一', createTimeMs: Date.now() + 1000 }))
    await t.orchestrator.handleMessage(msg({ messageId: 'om_doc2', text: '讨论二', createTimeMs: Date.now() + 2000 }))
    expect(await t.orchestrator.runProactiveCheck('oc_group')).toBe('silent')
    expect(t.feishu.of('sendToChat')).toHaveLength(0)
    expect(t.feishu.of('replyMarkdown')).toHaveLength(0)
  })

  it('主动回复先占位，丢失回执后同一批消息不再次发送', async () => {
    const t = await setup([{ kind: 'text', text: '接一下这个问题：这是已核实的答案。' }])
    t.proactive.enable('oc_group', 'ou_alice')
    await t.orchestrator.handleMessage(msg({ messageId: 'om_lost1', text: '讨论一', createTimeMs: Date.now() + 1000 }))
    await t.orchestrator.handleMessage(msg({ messageId: 'om_lost2', text: '讨论二', createTimeMs: Date.now() + 2000 }))
    const send = t.feishu.sendToChat.bind(t.feishu)
    vi.spyOn(t.feishu, 'sendToChat').mockImplementationOnce(async (...args) => { await send(...args); throw new Error('receipt lost') })
    expect(await t.orchestrator.runProactiveCheck('oc_group')).toBe('silent')
    t.registry.db.prepare("UPDATE proactive_chats SET recent_actions='[]', last_check_at=NULL").run()
    expect(await t.orchestrator.runProactiveCheck('oc_group')).toBe('silent')
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.feishu.of('sendToChat')).toHaveLength(1)
  })

  it('!proactive on/off/status are group commands', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg({ chatType: 'p2p', chatId: 'oc_p2p', text: '!proactive on' }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('按群开')
    await t.orchestrator.handleMessage(msg({ text: '@Friday !proactive', mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Friday' }] }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('主动模式：关')
    await t.orchestrator.handleMessage(msg({ text: '@Friday !proactive on', mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Friday' }] }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('只有**具体的东西进来**才会判断')
    expect(t.proactive.get('oc_group').enabled).toBe(true)
    expect(t.state.sessions.size).toBe(0)
  })

  it('有人问了没人接，熬够时间才起一轮；回复带触发出处', async () => {
    const t = await setup([{ kind: 'text', text: '@@reply om_q1\n接一下张三的问题：数仓权限找陆知行。' }])
    t.proactive.enable('oc_group', 'ou_alice')
    const t0 = Date.now()
    await t.orchestrator.handleMessage(msg({ messageId: 'om_q1', text: '数仓权限找谁申请啊？', createTimeMs: t0 }))
    // 刚问完：没到阈值，一轮都不该起
    expect(await t.orchestrator.sweepSignals()).toBe(0)
    expect(t.state.allPrompts).toHaveLength(0)

    t.tickSignals(11 * 60_000)
    expect(await t.orchestrator.sweepSignals()).toBe(1)
    const prompt = t.state.allPrompts[0]?.text ?? ''
    expect(prompt).toContain('触发本轮的事')
    expect(prompt).toContain('数仓权限找谁申请')
    expect(prompt).toContain('不是时间到了')
    // 作用域仍然是只读
    const mcp = t.state.allPrompts[0]?.mcpServers as { env: { name: string; value: string }[] }[]
    const cap = new TokenIssuer('s').verify(mcp[0]?.env.find((e) => e.name === 'FRIDAY_CAP_TOKEN')?.value ?? '')
    expect(cap?.scopes).not.toContain('dm:send')
    expect(cap?.scopes).not.toContain('memory:write')
    expect(cap?.scopes).not.toContain('todo:write')
    expect(cap?.scopes).not.toContain('bug:record')

    const reply = t.feishu.of('replyMarkdown')[0]
    expect(reply?.target).toBe('om_q1')
    expect(String(reply?.payload)).toContain('陆知行')
    expect(String(reply?.payload)).toContain('因为：数仓权限找谁申请') // 说清为什么冒出来
    expect(t.state.sessions.size).toBe(0)
  })

  it('有别人接话了就不再触发——安静本身不是信号', async () => {
    const t = await setup([{ kind: 'text', text: 'NOTHING' }])
    t.proactive.enable('oc_group', 'ou_alice')
    const t0 = Date.now()
    await t.orchestrator.handleMessage(msg({ messageId: 'om_q1', text: '导出为什么失败了？', createTimeMs: t0, threadId: 'omt_a' }))
    await t.orchestrator.handleMessage(msg({ messageId: 'om_a1', text: '我看一下', senderOpenId: 'ou_bob', createTimeMs: t0 + 1000, threadId: 'omt_a' }))
    t.tickSignals(30 * 60_000)
    expect(await t.orchestrator.sweepSignals()).toBe(0)
    expect(t.feishu.sent).toHaveLength(0)

    // 纯闲聊也不产生信号
    await t.orchestrator.handleMessage(msg({ text: '今天天气不错', createTimeMs: t0 + 2000 }))
    await t.orchestrator.handleMessage(msg({ text: '是啊', senderOpenId: 'ou_bob', createTimeMs: t0 + 3000 }))
    t.tickSignals(30 * 60_000)
    expect(await t.orchestrator.sweepSignals()).toBe(0)
  })

  it('别的小助手在同一话题接了话就让位：不再主动接；别处的机器人消息不算，也不产生新信号', async () => {
    const t = await setup([{ kind: 'text', text: '@@reply om_q2\n我来看看。' }])
    t.proactive.enable('oc_group', 'ou_alice')
    const t0 = Date.now()
    // 话题里的问题，小助手在同一话题回复
    await t.orchestrator.handleMessage(msg({ messageId: 'om_q1', text: '导出为什么失败了？', createTimeMs: t0, threadId: 'omt_a' }))
    await t.orchestrator.handleMessage(msg({ messageId: 'om_h1', text: '我查到是权限问题。', senderType: 'app', senderOpenId: 'ou_helper', createTimeMs: t0 + 1000, threadId: 'omt_a' }))
    // 群里直接发的问题，小助手直接回复这条消息
    await t.orchestrator.handleMessage(msg({ messageId: 'om_q3', text: '插件页为什么是空白？', createTimeMs: t0 + 2000 }))
    await t.orchestrator.handleMessage(msg({ messageId: 'om_h3', text: '已经记下了。', senderType: 'app', senderOpenId: 'ou_helper', parentId: 'om_q3', rootId: 'om_q3', createTimeMs: t0 + 3000, threadId: 'omt_c' }))
    expect(t.signals.open(t.spaces.byChat('oc_group')!.id).map(s => s.payload.messageId)).toEqual([])
    // 别的话题里的机器人消息不收这条问题；机器人消息本身也不产生信号
    await t.orchestrator.handleMessage(msg({ messageId: 'om_q2', text: '部署脚本在哪里看？', createTimeMs: t0 + 4000, threadId: 'omt_b' }))
    await t.orchestrator.handleMessage(msg({ messageId: 'om_h2', text: '这个问题怎么解决？', senderType: 'app', senderOpenId: 'ou_helper', createTimeMs: t0 + 5000, threadId: 'omt_x' }))
    expect(t.signals.open(t.spaces.byChat('oc_group')!.id).map(s => s.payload.messageId)).toEqual(['om_q2'])
    t.tickSignals(30 * 60_000)
    expect(await t.orchestrator.sweepSignals()).toBe(1)
  })

  it('自然语言开关主动接话：负责人关掉只关主动接话；非负责人被拒；状态可查；私聊里不改', async () => {
    const t = await setup()
    t.proactive.enable('oc_group', 'ou_alice')
    const actor = (openId: string) => ({ sessionKey: 'chat:oc_group', chatId: 'oc_group', chatType: 'group' as const, requesterOpenId: openId })
    const refused = await t.orchestrator.abilities.proactive(actor('ou_bob'), 'off')
    expect(refused).not.toContain('已停止盯'); expect(t.proactive.get('oc_group').enabled).toBe(true)
    const off = await t.orchestrator.abilities.proactive(actor('ou_alice'), 'off')
    expect(off).toContain('已停止盯'); expect(t.proactive.get('oc_group').enabled).toBe(false)
    expect(await t.orchestrator.abilities.proactive(actor('ou_bob'), 'on')).not.toContain('已开'); expect(t.proactive.get('oc_group').enabled).toBe(false)
    const on = await t.orchestrator.abilities.proactive(actor('ou_alice'), 'on')
    expect(on).toContain('主动接话已开'); expect(t.proactive.get('oc_group').enabled).toBe(true)
    expect(await t.orchestrator.abilities.proactive(actor('ou_alice'), '')).toBe(t.proactive.describe('oc_group'))
    expect(await t.orchestrator.abilities.proactive({ ...actor('ou_alice'), chatId: 'oc_dm', chatType: 'p2p' as const }, 'off')).toContain('按群开关')
    expect(t.proactive.get('oc_group').enabled).toBe(true)
  })

  it('看过一轮就进退避，不会每分钟重来', async () => {
    const t = await setup([{ kind: 'text', text: 'NOTHING' }])
    t.proactive.enable('oc_group', 'ou_alice')
    await t.orchestrator.handleMessage(msg({ messageId: 'om_q1', text: '这个接口怎么调？', createTimeMs: Date.now() }))
    t.tickSignals(11 * 60_000)
    expect(await t.orchestrator.sweepSignals()).toBe(1)
    expect(await t.orchestrator.sweepSignals()).toBe(0) // 退避期内
    t.tickSignals(61_000)
    expect(await t.orchestrator.sweepSignals()).toBe(1)
    expect(t.state.allPrompts).toHaveLength(2)
  })

  it('关停要说清连带影响，而且不删数据', async () => {
    const t = await setup()
    t.proactive.enable('oc_group', 'ou_alice')
    await t.orchestrator.handleMessage(msg({ messageId: 'om_q1', text: '谁知道这个怎么配？', createTimeMs: Date.now() }))
    const space = t.spaces.byChat('oc_group')!
    expect(t.signals.open(space.id)).toHaveLength(1)

    await t.orchestrator.handleMessage(msg({ text: '@Friday !proactive off', mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Friday' }] }))
    const said = String(t.feishu.of('replyText').at(-1)?.payload)
    expect(said).toContain('已停止盯')
    expect(said).toContain('1 条信号不删')
    expect(said).not.toContain('别的群')
    expect(t.proactive.get('oc_group').enabled).toBe(false)
    expect(t.signals.isMuted(space.id, 'unanswered_question')).toBe(true)
    expect(t.signals.open(space.id)).toHaveLength(1) // 数据还在
    t.tickSignals(60 * 60_000)
    expect(await t.orchestrator.sweepSignals()).toBe(0)
  })
})

describe('说完之后的冷却', () => {
  it('配额没用完也要等：两句之间必须隔开', () => {
    const db = new Registry(':memory:').db
    let now = Date.parse('2026-09-19T10:00:00+08:00')
    const p = new Proactive(db, { maxPerHour: 3, speakCooldownMs: 15 * 60_000, now: () => now })
    p.enable('oc_1', 'ou_a')

    expect(p.maySpeak('oc_1')).toEqual({ ok: true })
    p.record('oc_1', { acted: true, checkedUntil: now })

    // 刚说完：配额还剩 2，但节奏上不该再说
    expect(p.quotaLeft('oc_1')).toBe(2)
    expect(p.maySpeak('oc_1')).toEqual({ ok: false, why: 'cooldown' })

    now += 14 * 60_000
    expect(p.maySpeak('oc_1').ok).toBe(false)
    now += 2 * 60_000
    expect(p.maySpeak('oc_1')).toEqual({ ok: true })
  })

  it('没说话的巡检不进冷却——沉默不该罚它', () => {
    const db = new Registry(':memory:').db
    const now = Date.parse('2026-09-19T10:00:00+08:00')
    const p = new Proactive(db, { speakCooldownMs: 15 * 60_000, now: () => now })
    p.enable('oc_1', 'ou_a')
    p.record('oc_1', { acted: false, checkedUntil: now })
    expect(p.cooldownLeft('oc_1')).toBe(0)
    expect(p.maySpeak('oc_1')).toEqual({ ok: true })
  })

  it('冷却设成 0 就是不限，别把开关做成永远堵', () => {
    const db = new Registry(':memory:').db
    const now = Date.parse('2026-09-19T10:00:00+08:00')
    const p = new Proactive(db, { speakCooldownMs: 0, now: () => now })
    p.enable('oc_1', 'ou_a')
    p.record('oc_1', { acted: true, checkedUntil: now })
    expect(p.maySpeak('oc_1')).toEqual({ ok: true })
  })

  it('配额用完时给的理由是 quota，不是 cooldown——排查时要分得开', () => {
    const db = new Registry(':memory:').db
    let now = Date.parse('2026-09-19T10:00:00+08:00')
    const p = new Proactive(db, { maxPerHour: 1, speakCooldownMs: 5 * 60_000, now: () => now })
    p.enable('oc_1', 'ou_a')
    p.record('oc_1', { acted: true, checkedUntil: now })
    now += 10 * 60_000 // 冷却过了，配额还没回
    expect(p.maySpeak('oc_1')).toEqual({ ok: false, why: 'quota' })
  })
})
