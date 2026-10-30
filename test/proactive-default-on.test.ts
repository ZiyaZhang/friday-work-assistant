import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
import { normalizeChatLifecycle } from '../src/feishu/ws.js'
import { COMMAND_WORDS } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('test', 'error')

async function setup(env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-default-on-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_REFLECT: 'off',
    FRIDAY_PROACTIVE_MIN_MESSAGES: '2', ...env } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:')
  const feishu = new FakeFeishu()
  feishu.chats = [{ chatId: 'oc_new', name: '新群' }]
  const messages = new MessageService(asFeishuClient(feishu), new MessageCache(registry.db), log)
  const proactive = new Proactive(registry.db, cfg.proactive)
  const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: 'NOTHING' }] })
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  const deps = spaceDeps(registry.db, { admins: cfg.policy.admins })
  orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory: new ChannelMemory(registry.db), messages,
    todos: new Todos(registry.db), ...deps, proactive, signals: new Signals(registry.db), tokens: new TokenIssuer('s'),
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  const added = (data: Record<string, unknown>) => orchestrator.handleChatLifecycle(normalizeChatLifecycle('bot_added', { chat_id: 'oc_new', ...data }))
  const texts = () => feishu.of('sendToChat').map((s) => String((s.payload as { text?: string }).text ?? ''))
  let seq = 0
  /** 群里 @ Friday 的一条消息 */
  const mention = (text = '@Friday 在吗', senderOpenId = 'ou_bob') => ({
    eventId: `ev_at_${++seq}`, messageId: `om_at_${seq}`, chatId: 'oc_new', chatType: 'group' as const, msgType: 'text', text, senderOpenId,
    senderType: 'user', createTimeMs: Date.now(), mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Friday' }],
  })
  /** 第一次 @：建空间，等入群确认发出去（建空间之后异步发） */
  const first = async () => {
    await orchestrator.handleMessage(mention())
    const end = Date.now() + 3000
    while (!texts().length && Date.now() < end) await pause(10)
    await pause(40)
  }
  /** 后续的 @ 会当活儿干；等这些任务结束 */
  const idle = async () => {
    const end = Date.now() + 3000
    while ((registry.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('queued', 'running')").get() as { n: number }).n && Date.now() < end) await pause(10)
    await pause(40)
  }
  return { cfg, registry, feishu, proactive, orchestrator, state, spaces: deps.spaces, added, texts, mention, first, idle }
}

const pause = (ms = 50) => new Promise((r) => setTimeout(r, ms))

const COMMAND = new RegExp(`(?<![\\w./])[/!](?:${COMMAND_WORDS.join('|')})\\b`)

describe('新群主动功能须勾选开启', () => {
  it.each(['on', 'off'])('旧部署默认值 %s 不自动开启；首次 @ 仍发功能卡', async (setting) => {
    const t = await setup({ FRIDAY_PROACTIVE_DEFAULT_ON: setting })
    await t.added({ operator_id: { open_id: 'ou_alice' } })
    await t.added({ operator_id: { open_id: 'ou_bob' } })
    expect(t.proactive.get('oc_new').enabled).toBe(false)
    expect(t.feishu.sent).toHaveLength(0)
    await t.first()
    expect(t.feishu.of('sendToChat')).toHaveLength(1)
    expect(JSON.stringify(t.feishu.of('sendToChat')[0]!.payload)).toContain('group_feature')
    expect(t.proactive.get('oc_new').enabled).toBe(false)
  })
  it.each([true, false])('已有群主动状态 %s 保留', async (enabled) => {
    const t = await setup()
    t.proactive.enable('oc_new', 'ou_alice')
    if (!enabled) t.proactive.disable('oc_new')
    await t.added({ operator_id: { open_id: 'ou_bob' } })
    expect(t.proactive.get('oc_new')).toMatchObject({ enabled, enabledBy: 'ou_alice' })
  })
  it('不在允许列表里的群不开启、不发卡', async () => {
    const t = await setup({ FRIDAY_ALLOWED_CHATS: 'oc_other' })
    await t.added({ operator_id: { open_id: 'ou_alice' } })
    await t.orchestrator.handleMessage(t.mention())
    expect(t.proactive.get('oc_new').enabled).toBe(false)
    expect(t.feishu.sent).toHaveLength(0)
  })
})
