/**
 * 巡查轮次静默：信号到阈值起一轮，模型回复被发言前检查拦下（主动发言不许 @ 人）时，
 * 只记一条 `proactive reply blocked` 日志；不给空间负责人私聊推「群巡查 · 有话没发」卡，群里也不发。
 * 对照：同一条信号、回复不带 @ 的轮次照常在群里回复。
 */
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
import { Proactive } from '../src/core/proactive.js'
import { Registry } from '../src/core/registry.js'
import { Signals } from '../src/core/signals.js'
import { Todos } from '../src/core/todos.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('proactive-round-silent', 'error')
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

/**
 * 一个开了主动模式的群：负责人 ou_alice 建的空间、也是她开的主动模式；
 * ou_bob 在群里问一句没人接的问题，熬过阈值后 sweepSignals 起一轮，假 dsh 这一轮的整段回复是 `reply`。
 */
async function round(reply: string) {
  const home = mkdtempSync(join(tmpdir(), 'friday-round-silent-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_REFLECT: 'off',
    FRIDAY_PROACTIVE_QUIET_MS: '30', FRIDAY_PROACTIVE_MIN_MESSAGES: '2' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), sp = spaceDeps(registry.db)
  const feishu = new FakeFeishu(); feishu.chats = [{ chatId: 'oc_group', name: '研发群' }]
  const messages = new MessageService(asFeishuClient(feishu), new MessageCache(registry.db), log)
  const proactive = new Proactive(registry.db, cfg.proactive)
  let signalNow = Date.now()
  const signals = new Signals(registry.db, () => signalNow)
  const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: reply }] })
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory: new ChannelMemory(registry.db), messages,
    todos: new Todos(registry.db), ...sp, proactive, signals, tokens: new TokenIssuer('s'), apiBaseUrl: 'http://127.0.0.1:1',
    mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  cleanup.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_alice' })
  proactive.enable('oc_group', 'ou_alice')
  const dm = vi.spyOn(feishu, 'sendToUser')
  const info = vi.spyOn(log, 'info')

  const t0 = Date.now()
  await orchestrator.handleMessage({ eventId: 'ev_om_q1', messageId: 'om_q1', chatId: 'oc_group', chatType: 'group', msgType: 'text',
    text: '数仓权限找谁申请啊？', senderOpenId: 'ou_bob', senderType: 'user', mentions: [], createTimeMs: t0 })
  expect(await orchestrator.sweepSignals()).toBe(0) // 刚问完：没到阈值
  signalNow += 11 * 60_000
  expect(await orchestrator.sweepSignals()).toBe(1)
  // 这一轮真的问过模型；空间有负责人（r77 的 reportRound 就是把卡私聊给 owners 的前 3 个）
  expect(state.allPrompts).toHaveLength(1)
  expect(sp.spaces.owners(space.id)).toEqual(['ou_alice'])
  /** 每条 `proactive reply blocked` 日志带的字段 */
  const blockedLogs = info.mock.calls.filter(([msg]) => msg === 'proactive reply blocked').map(([, data]) => data)
  return { feishu, dm, blockedLogs }
}

describe('巡查轮次的结果只进运行记录', () => {
  it('回复里 @ 了人、被发言前检查拦下：不私聊负责人，群里不发，只记一条 proactive reply blocked', async () => {
    const t = await round('@@reply om_q1\n接一下这个问题：数仓权限找 <at user_id="ou_carol">王五</at> 申请。')
    expect(t.dm).not.toHaveBeenCalled()
    expect(t.feishu.of('sendToChat')).toHaveLength(0)
    expect(t.feishu.of('replyMarkdown')).toHaveLength(0)
    expect(t.feishu.sent).toHaveLength(0)
    expect(t.blockedLogs).toEqual([{ chatId: 'oc_group', reason: '主动发言不许 @ 人', signals: 1, acted: false }])
  })

  it('对照：同一条信号、回复不带 @，照常回到提问那条消息下，带触发出处', async () => {
    const t = await round('@@reply om_q1\n接一下这个问题：数仓权限找王五申请。')
    const reply = t.feishu.of('replyMarkdown')[0]
    expect(reply?.target).toBe('om_q1')
    expect(String(reply?.payload)).toContain('数仓权限找王五申请')
    expect(String(reply?.payload)).toContain('因为：数仓权限找谁申请')
    expect(t.feishu.of('replyMarkdown')).toHaveLength(1)
    expect(t.dm).not.toHaveBeenCalled()
    expect(t.blockedLogs).toEqual([])
  })
})
