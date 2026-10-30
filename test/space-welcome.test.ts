import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig, type FridayConfig } from '../src/config.js'
import { Bugs } from '../src/core/bugs.js'
import { ensureDeliverySchema, readDeliveryRecord } from '../src/core/delivery.js'
import { MeetingSessions } from '../src/core/meeting-sessions.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Polls } from '../src/core/polls.js'
import { Proactive } from '../src/core/proactive.js'
import { RoutineStore } from '../src/core/routines.js'
import { Registry } from '../src/core/registry.js'
import { Signals } from '../src/core/signals.js'
import { Todos } from '../src/core/todos.js'
import { FeishuMeetings, type MeetingsClient } from '../src/feishu/meetings.js'
import { COMMAND_WORDS, type InboundMessage } from '../src/feishu/mention.js'
import { normalizeChatLifecycle } from '../src/feishu/ws.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient, type SentRecord } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('test', 'error')
const CHAT = 'oc_join'
const KEY = `space-welcome:${CHAT}`
/** 会议平台在这些用例里不该被调用；只为让部署开关为 on 时照 src/index.ts 构造会议运行时。 */
const unused = async (): Promise<never> => { throw new Error('会议平台不该被调用') }
const MEETINGS_CLIENT = { vc: { bot: { join: unused, leave: unused, events: unused, userActiveMeeting: unused } } } as unknown as MeetingsClient

const pause = (ms = 80) => new Promise((r) => setTimeout(r, ms))
async function until(read: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!read() && Date.now() < end) await pause(10)
  await pause(40)
}

/** 与 src/index.ts 的装配一致：部署开关打开才构造投票、会议旁听运行时。同一个库再装一次就是重启。 */
function assemble(cfg: FridayConfig, registry: Registry, feishu: FakeFeishu) {
  const messages = new MessageService(asFeishuClient(feishu), new MessageCache(registry.db), log)
  const proactive = new Proactive(registry.db, cfg.proactive)
  const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: '好的。' }] })
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  const deps = spaceDeps(registry.db, { admins: cfg.policy.admins })
  const polls = cfg.polls.enabled ? { store: new Polls(registry.db), bugs: new Bugs(registry.db) } : undefined
  const meetings = cfg.meetings.enabled ? { sessions: new MeetingSessions(registry.db), provider: new FeishuMeetings(MEETINGS_CLIENT) } : undefined
  orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory: new ChannelMemory(registry.db), messages,
    todos: new Todos(registry.db), routines: new RoutineStore(registry.db), ...deps, proactive, signals: new Signals(registry.db), tokens: new TokenIssuer('s'), polls, meetings,
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  return { orchestrator, state, proactive, spaces: deps.spaces }
}

function setup(env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-space-welcome-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_REFLECT: 'off',
    FRIDAY_ACK_AFTER_MS: '0', ...env } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:')
  ensureDeliverySchema(registry.db) // 生产里 src/index.ts 启动时就建好投递账本
  const feishu = new FakeFeishu()
  feishu.chats = [{ chatId: CHAT, name: '新群' }]
  let seq = 0
  const at = (text: string, senderOpenId = 'ou_bob'): InboundMessage => ({
    eventId: `ev_join_${++seq}`, messageId: `om_join_${seq}`, chatId: CHAT, chatType: 'group', msgType: 'text', text, senderOpenId,
    senderType: 'user', createTimeMs: Date.now(), mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Friday' }],
  })
  /** 群里 Friday 主动发出的消息（不是回复）。 */
  const chat = (): SentRecord[] => feishu.sent.filter((s) => s.kind === 'sendToChat' && s.target === CHAT)
  const welcomes = () => feishu.sent.filter((s) => JSON.stringify(s.payload ?? '').includes('Friday · 本群功能'))
  const text = () => JSON.stringify(chat()[0]?.payload ?? '')
  /** 后续的 @ 会当活儿干（假模型回一句）；等这些任务都结束再往下断言。 */
  const idle = () => until(() => (registry.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('queued', 'running')").get() as { n: number }).n === 0)
  const current = assemble(cfg, registry, feishu)
  const t = {
    cfg, registry, feishu, at, chat, welcomes, text, idle, ...current,
    added: (data: Record<string, unknown> = {}) => t.orchestrator.handleChatLifecycle(normalizeChatLifecycle('bot_added', { chat_id: CHAT, ...data })),
    /** 群里第一次 @，等入群确认发完 */
    first: async (message = at('@Friday 在吗')) => {
      await t.orchestrator.handleMessage(message)
      await until(() => welcomes().length > 0)
    },
    restart: () => {
      t.orchestrator.beginShutdown()
      Object.assign(t, assemble(cfg, registry, feishu))
    },
  }
  return t
}

describe('入群确认消息', () => {
  it('真实 callback 勾选静默保存，重复回调幂等，关掉再收到旧开启回调不会重开，重启后状态仍在', async () => {
    const t = setup()
    await t.added({ operator_id: { open_id: 'ou_alice' } })
    await t.first()
    const messageId = t.chat()[0]!.messageId
    const space = t.spaces.byChat(CHAT)!
    let card = (t.chat()[0]!.payload as any).card
    const click = (name: string, checked: boolean, overrides = {}) => ({ operatorOpenId: 'ou_alice', chatId: CHAT, messageId,
      tag: 'checker', checked, value: card.body.elements.find((e: any) => e.name === name).behaviors[0].value, raw: {}, ...overrides })
    const oldOn = click('brief', true)
    const before = t.feishu.sent.length
    let result = await t.orchestrator.handleCardAction(oldOn) as any
    expect(result.toast).toBeUndefined()
    expect(t.feishu.sent).toHaveLength(before)
    card = result.card.data
    const store = new RoutineStore(t.registry.db)
    expect(store.listAll()).toHaveLength(1)
    expect(store.listAll()[0]).toMatchObject({ enabled: true, runAs: 'ou_alice', spaceId: space.id, chatId: CHAT,
      deliveryPolicy: 'every_run', schedule: { type: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] } })
    await t.orchestrator.handleCardAction(oldOn)
    expect(store.listAll()).toHaveLength(1)
    result = await t.orchestrator.handleCardAction(click('brief', false)) as any
    card = result.card.data
    expect(store.listAll()[0]!.enabled).toBe(false)
    t.restart()
    result = await t.orchestrator.handleCardAction(oldOn) as any
    expect(result.toast.type).toBe('error')
    expect(store.listAll()[0]!.enabled).toBe(false)
    result = await t.orchestrator.handleCardAction(click('brief', true)) as any
    expect(result.toast).toBeUndefined()
    expect(store.listAll()).toHaveLength(1)
    expect(store.listAll()[0]!.enabled).toBe(true)
  })

  it('普通成员、错误群、伪造消息和缺失 checked 都不能修改；负责人可开关主动功能和投票', async () => {
    const t = setup({ FRIDAY_POLLS: 'on' })
    await t.added({ operator_id: { open_id: 'ou_alice' } })
    await t.first()
    let card = (t.chat()[0]!.payload as any).card
    const action = (name: string, checked: boolean) => ({ operatorOpenId: 'ou_alice', chatId: CHAT, messageId: t.chat()[0]!.messageId,
      tag: 'checker', checked, value: card.body.elements.find((e: any) => e.name === name).behaviors[0].value, raw: {} })
    for (const patch of [{ operatorOpenId: 'ou_bob' }, { chatId: 'oc_other' }, { messageId: 'om_fake' }, { checked: undefined }]) {
      const denied = await t.orchestrator.handleCardAction({ ...action('proactive', true), ...patch }) as any
      expect(denied.toast.type).toBe('error')
      expect(t.proactive.get(CHAT).enabled).toBe(false)
    }
    for (const name of ['proactive', 'polls']) for (const checked of [true, false]) {
      const result = await t.orchestrator.handleCardAction(action(name, checked)) as any
      expect(result.toast).toBeUndefined()
      card = result.card.data
      expect(card.body.elements.find((e: any) => e.name === name).checked).toBe(checked)
      if (name === 'proactive') expect(t.proactive.get(CHAT).enabled).toBe(checked)
      else expect(t.spaces.byChat(CHAT)!.config.polls).toBe(checked ? 'on' : 'off')
    }
  })
  it('第一次 @ 只发一张未勾选的功能卡，不自动开启或启动模型', async () => {
    const t = setup()
    t.feishu.chatOwners.set(CHAT, 'ou_alice')
    t.feishu.chatManagers.set(CHAT, ['ou_mgr'])
    await t.added({ operator_id: { open_id: 'ou_alice' } })
    expect(t.feishu.sent).toHaveLength(0)
    await t.first()
    expect(t.chat()).toHaveLength(1)
    const payload = t.chat()[0]!.payload as any
    expect(payload.card.schema).toBe('2.0')
    expect(payload.card.body.elements.filter((e: any) => e.tag === 'checker').every((e: any) => e.checked === false)).toBe(true)
    expect(t.spaces.owners(t.spaces.byChat(CHAT)!.id).sort()).toEqual(['ou_alice', 'ou_mgr'])
    expect(t.proactive.get(CHAT).enabled).toBe(false)
    expect(t.state.allPrompts).toHaveLength(0)
  })

  it('经投递账本发送：deliveries 一行，远端 ID 就是群里那条消息；KV 标记已写', async () => {
    const t = setup()
    await t.added({ operator_id: { open_id: 'ou_alice' } })
    await t.first()
    const space = t.spaces.byChat(CHAT)!
    expect(readDeliveryRecord(t.registry.db, KEY)).toMatchObject({
      contextRef: KEY, status: 'sent', actorOpenId: 'ou_alice', remoteId: t.chat()[0]!.messageId, sourceRefs: [KEY],
      audience: { kind: 'group', spaceId: space.id, chatId: CHAT },
    })
    expect(t.registry.getKv(KEY)).toBeTruthy()
    const rows = t.registry.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE delivery_key LIKE 'space-welcome:%'").get() as { n: number }
    expect(rows.n).toBe(1)
  })

  it('重复事件不再发：进群事件重投递、别人再 @、重启后同一条 @ 重投递、重启后再 @ 都不再发，账本那一行不变', async () => {
    const t = setup()
    await t.added({ operator_id: { open_id: 'ou_alice' } })
    const first = t.at('@Friday 在吗')
    await t.first(first)
    const record = readDeliveryRecord(t.registry.db, KEY)
    expect(record?.status).toBe('sent')

    // 进群事件网关不去重（src/feishu/ws.ts），飞书重投递会再到一次
    await t.added({ operator_id: { open_id: 'ou_alice' } })
    await t.orchestrator.handleMessage(t.at('@Friday 在吗', 'ou_carol'))
    await t.idle()
    expect(t.welcomes()).toHaveLength(1)

    // 网关的消息去重只在内存里；重启后飞书重投递的同一条 @ 会再进来一次
    t.restart()
    await t.orchestrator.handleMessage(first)
    await t.orchestrator.handleMessage(t.at('@Friday 在吗', 'ou_dave'))
    await t.idle()
    expect(t.welcomes()).toHaveLength(1)
    expect(t.chat()).toHaveLength(1)
    expect(readDeliveryRecord(t.registry.db, KEY)).toEqual(record)
  })

  it('两个人同时第一次 @：只建一个空间、只发一条', async () => {
    const t = setup()
    await t.added({ operator_id: { open_id: 'ou_alice' } })
    await Promise.all([t.orchestrator.handleMessage(t.at('@Friday 在吗', 'ou_bob')), t.orchestrator.handleMessage(t.at('@Friday 你好', 'ou_carol'))])
    await until(() => t.welcomes().length > 0)
    await t.idle()
    expect(t.welcomes()).toHaveLength(1)
    expect(t.spaces.listAll()).toHaveLength(1)
  })

  it('仅已接入功能有可操作的勾选框；缺少 GitHub 连接时不能开启跟进', async () => {
    for (const enabled of [false, true]) {
      const t = setup({ FRIDAY_POLLS: enabled ? 'on' : 'off' })
      await t.first()
      const elements = (t.chat()[0]!.payload as any).card.body.elements
      expect(elements.some((e: any) => e.tag === 'checker' && e.name === 'polls')).toBe(enabled)
      expect(elements.some((e: any) => e.tag === 'checker' && e.name === 'github')).toBe(false)
      expect(t.text()).toContain('当前未接入')
    }
  })

  it('部署不点赞时不展示点赞承诺', async () => {
    const t = setup({ FRIDAY_KUDOS_MAX_PER_DAY: '0' })
    await t.first()
    expect(t.text()).not.toContain('点赞')
  })

  it('旧默认开关不能绕过勾选；已有主动设置保留', async () => {
    const t = setup({ FRIDAY_PROACTIVE_DEFAULT_ON: 'on' })
    t.proactive.enable(CHAT, 'ou_alice')
    await t.added({ operator_id: { open_id: 'ou_alice' } })
    await t.first()
    expect(t.proactive.get(CHAT).enabled).toBe(true)
    expect((t.chat()[0]!.payload as any).card.body.elements.find((e: any) => e.name === 'proactive').checked).toBe(true)
  })

  it('群主、管理员和拉群人获得设置权限，第一个 @ 的普通成员不获得权限', async () => {
    const t = setup()
    t.feishu.chatOwners.set(CHAT, 'ou_owner')
    t.feishu.chatManagers.set(CHAT, ['ou_manager'])
    await t.added({ operator_id: { open_id: 'ou_inviter' } })
    await t.first()
    const space = t.spaces.byChat(CHAT)!
    expect(t.spaces.owners(space.id).sort()).toEqual(['ou_inviter', 'ou_manager', 'ou_owner'])
    expect(t.spaces.roleOf(space.id, 'ou_bob')).toBe('member')
  })

  it('第一条 @ 就问正事：先发确认消息，再接活', async () => {
    const t = setup()
    await t.added({ operator_id: { open_id: 'ou_alice' } })
    const question = t.at('@Friday 帮我看下发布流程卡在哪一步')
    await t.orchestrator.handleMessage(question)
    await until(() => t.registry.taskForMessage(question.messageId)?.status === 'done')
    expect(t.welcomes()).toHaveLength(1)
    const welcomeAt = t.feishu.sent.indexOf(t.welcomes()[0]!)
    const answerAt = t.feishu.sent.findIndex((s) => s.target === question.messageId && ['replyMarkdown', 'replyCard', 'replyText'].includes(s.kind))
    expect(answerAt).toBeGreaterThan(welcomeAt)
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toMatchObject({ n: 1 })
  })

  it('发送失败：账本记为结果未知，之后不自动补发', async () => {
    const t = setup()
    await t.added({ operator_id: { open_id: 'ou_alice' } })
    const send = t.feishu.sendToChat.bind(t.feishu)
    let attempts = 0
    t.feishu.sendToChat = async (chatId, payload) => {
      if (JSON.stringify(payload).includes('Friday · 本群功能')) { attempts += 1; throw new Error('network') }
      return send(chatId, payload)
    }
    await t.orchestrator.handleMessage(t.at('@Friday 在吗'))
    await until(() => readDeliveryRecord(t.registry.db, KEY)?.status === 'unknown')
    expect(readDeliveryRecord(t.registry.db, KEY)).toMatchObject({ status: 'unknown', error: 'send_result_unknown' })
    expect(t.registry.getKv(KEY)).toBeTruthy()

    await t.orchestrator.handleMessage(t.at('@Friday 在吗', 'ou_carol'))
    await t.idle()
    expect(attempts).toBe(1)
    expect(t.welcomes()).toHaveLength(0)
  })

  it('私聊不受影响：第一次私聊照旧发自我介绍卡片，不发入群确认', async () => {
    const t = setup()
    await t.orchestrator.handleMessage({ eventId: 'ev_dm', messageId: 'om_dm', chatId: 'oc_dm_alice', chatType: 'p2p', msgType: 'text', text: '你好',
      senderOpenId: 'ou_alice', senderType: 'user', createTimeMs: Date.now(), mentions: [] })
    await until(() => t.feishu.of('sendToUser').length > 0)
    await t.idle()
    expect(JSON.stringify(t.feishu.of('sendToUser')[0]!.payload)).toContain('就位了')
    expect(t.welcomes()).toHaveLength(0)
    const rows = t.registry.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE delivery_key LIKE 'space-welcome:%'").get() as { n: number }
    expect(rows.n).toBe(0)
  })
})
