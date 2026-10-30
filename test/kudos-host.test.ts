/**
 * 主动巡检里的点赞：模型提名 → 宿主核对 → 贴表情 → 记账本。
 * 用假的飞书客户端和假 dsh，断言真正调用了几次 addReaction、账本里留下了什么。
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { Kudos } from '../src/core/kudos.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Proactive } from '../src/core/proactive.js'
import { Registry } from '../src/core/registry.js'
import { Signals } from '../src/core/signals.js'
import { Spaces } from '../src/core/space.js'
import { Todos } from '../src/core/todos.js'
import { FeishuApiError } from '../src/feishu/client.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('test', 'error')
const AT_BOT = [{ key: '@_user_1', openId: 'ou_bot', name: 'Friday' }]

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    eventId: `ev_${Math.random()}`,
    messageId: `om_${Math.random().toString(36).slice(2, 8)}`,
    chatId: 'oc_group',
    chatType: 'group',
    msgType: 'text',
    text: '随便聊聊',
    senderOpenId: 'ou_bob',
    senderType: 'user',
    mentions: [],
    createTimeMs: Date.now(),
    ...over,
  }
}

async function setup(reply: string, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-kudos-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_REFLECT: 'off',
    FRIDAY_PROACTIVE_MIN_MESSAGES: '2', ...env } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:')
  const feishu = new FakeFeishu()
  feishu.chats = [{ chatId: 'oc_group', name: '研发群' }]
  const messages = new MessageService(asFeishuClient(feishu), new MessageCache(registry.db), log)
  const proactive = new Proactive(registry.db, cfg.proactive)
  const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: reply }] })
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory: new ChannelMemory(registry.db), messages,
    todos: new Todos(registry.db), ...spaceDeps(registry.db), proactive, signals: new Signals(registry.db), tokens: new TokenIssuer('s'),
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  const spaces = new Spaces(registry.db)
  const space = spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_alice' })
  proactive.enable('oc_group', 'ou_alice')
  const ledger = new Kudos(registry.db, { maxPerDay: cfg.kudos.maxPerDay })
  const addReaction = vi.spyOn(feishu, 'addReaction')
  /** 往群里放几条普通消息（没人 @ Friday），它们就是下一轮巡检看到的消息集合 */
  const post = async (...list: Partial<InboundMessage>[]) => {
    let at = Date.now() + 1000
    for (const over of list) await orchestrator.handleMessage(msg({ createTimeMs: at++, ...over }))
  }
  const again = () => registry.db.prepare("UPDATE proactive_chats SET recent_actions = '[]', checked_until = 0, noop_streak = 0").run()
  return { cfg, registry, feishu, proactive, orchestrator, state, spaces, space, ledger, addReaction, post, again }
}

const FIX = { messageId: 'om_fix', text: '修好了：登录超时是连接池太小，已经合并', senderOpenId: 'ou_carol' }

/** 宿主写下的"没贴"原因：messageId:why */
function skipped(info: { mock: { calls: unknown[][] } }): string[] {
  return info.mock.calls.filter(([m]) => m === 'kudos skipped').map(([, d]) => `${(d as { messageId: string }).messageId}:${(d as { why: string }).why}`)
}
const CHAT = { messageId: 'om_chat', text: '今天食堂有饺子' }

describe('主动巡检里的点赞', () => {
  it('提名一条修好 bug 的消息：贴一次 THUMBSUP、记账本，不在群里说话', async () => {
    const t = await setup('NOTHING\n@@like om_fix 修好了登录超时并说明了原因')
    await t.post(FIX, CHAT)
    expect(await t.orchestrator.runProactiveCheck('oc_group')).toBe('silent')
    expect(t.addReaction).toHaveBeenCalledTimes(1)
    expect(t.addReaction).toHaveBeenCalledWith('om_fix', 'THUMBSUP')
    expect(t.feishu.reactionsOn('om_fix')).toEqual(['THUMBSUP'])
    expect(t.ledger.get('om_fix')).toMatchObject({ chatId: 'oc_group', spaceId: t.space.id, senderOpenId: 'ou_carol', emojiType: 'THUMBSUP',
      reason: '修好了登录超时并说明了原因', removedAt: null })
    expect(t.ledger.get('om_fix')?.reactionId).toMatch(/^rx_/)
    expect(t.feishu.sent).toHaveLength(0)
    const prompt = t.state.allPrompts[0]?.text ?? ''
    expect(prompt).toContain('@@like <message_id> <一句理由>')
    expect(prompt).toContain('[点赞标准]')
    // 点赞不算主动发言：不占这小时的发言次数
    expect(t.proactive.quotaLeft('oc_group')).toBe(t.proactive.maxPerHour)
  })

  it('用配置的表情键', async () => {
    const t = await setup('NOTHING\n@@like om_fix 修好了', { FRIDAY_KUDOS_EMOJI: 'APPLAUSE' })
    await t.post(FIX, CHAT)
    await t.orchestrator.runProactiveCheck('oc_group')
    expect(t.addReaction).toHaveBeenCalledWith('om_fix', 'APPLAUSE')
  })

  it('宿主过滤：不在本轮的、机器人发的、提问、没解决的报错、Friday 接过的任务消息都不赞', async () => {
    const t = await setup([
      'NOTHING',
      '@@like om_q 问得好',
      '@@like om_err 贴了报错',
    ].join('\n'))
    const info = vi.spyOn(log, 'info')
    await t.post({ messageId: 'om_q', text: '这个接口怎么调？' }, { messageId: 'om_err', text: '部署又挂了，还是 500' },
      { messageId: 'om_app', text: '构建完成', senderType: 'app', senderOpenId: 'ou_ci' })
    await t.orchestrator.runProactiveCheck('oc_group')
    t.again()
    // 第二轮：机器人消息和不在集合里的 id
    t.state.script = [{ kind: 'text', text: 'NOTHING\n@@like om_app 构建完成\n@@like om_nowhere 不存在' }]
    await t.post(CHAT, { messageId: 'om_more', text: '好的' })
    await t.orchestrator.runProactiveCheck('oc_group')
    t.again()
    // 第三轮：Friday 接过的任务来源消息（回执表情贴在它上面）
    t.registry.createSession({ sessionKey: 'synthetic-task-session', chatId: 'oc_group', chatType: 'group', cwd: '/tmp', requesterOpenId: 'ou_bob' })
    t.registry.createTaskOnce({ sessionKey: 'synthetic-task-session', messageId: 'om_task', requesterOpenId: 'ou_bob', prompt: '总结发布流程' })
    expect(t.registry.taskForMessage('om_task')).toBeDefined()
    t.state.script = [{ kind: 'text', text: 'NOTHING\n@@like om_task 总结得清楚' }]
    await t.post({ messageId: 'om_task', text: '发布流程总结在这里：先冻结，再灰度，最后全量' }, { messageId: 'om_tail', text: '收到' })
    await t.orchestrator.runProactiveCheck('oc_group')
    expect(t.state.allPrompts).toHaveLength(3)
    expect(t.state.allPrompts.every((p) => p.text.includes('[点赞标准]'))).toBe(true)
    expect(t.addReaction).not.toHaveBeenCalled()
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM message_kudos').get()).toMatchObject({ n: 0 })
    expect(skipped(info)).toEqual(['om_q:question', 'om_err:trouble', 'om_app:not_in_round', 'om_nowhere:not_in_round', 'om_task:already_reacted'])
    info.mockRestore()
  })

  it('贴失败只记日志，不重试：账本留一行空 reaction_id，下一轮同一条不再贴', async () => {
    const t = await setup('NOTHING\n@@like om_fix 修好了')
    t.feishu.failReactions = true
    await t.post(FIX, CHAT)
    expect(await t.orchestrator.runProactiveCheck('oc_group')).toBe('silent')
    expect(t.addReaction).toHaveBeenCalledTimes(1)
    expect(t.ledger.get('om_fix')?.reactionId).toBeNull()
    t.feishu.failReactions = false
    t.again()
    await t.post({ messageId: 'om_next', text: '继续' })
    await t.orchestrator.runProactiveCheck('oc_group')
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.addReaction).toHaveBeenCalledTimes(1)
  })

  it('表情键不存在（231001）：本进程停用，下一轮提示词不再带点赞段', async () => {
    const t = await setup('NOTHING\n@@like om_fix 修好了', { FRIDAY_KUDOS_EMOJI: 'NoSuchKey' })
    t.addReaction.mockRejectedValueOnce(new FeishuApiError('message.reaction.create', 231001, 'reaction type is invalid'))
    await t.post(FIX, CHAT)
    await t.orchestrator.runProactiveCheck('oc_group')
    expect(t.addReaction).toHaveBeenCalledTimes(1)
    t.again()
    t.state.script = [{ kind: 'text', text: 'NOTHING\n@@like om_other 讲清了原因' }]
    await t.post({ messageId: 'om_other', text: '原因是索引没建，补上之后查询从 3 秒降到 50 毫秒' })
    await t.orchestrator.runProactiveCheck('oc_group')
    expect(t.state.allPrompts[1]?.text).not.toContain('@@like')
    expect(t.addReaction).toHaveBeenCalledTimes(1)
    expect(t.ledger.has('om_other')).toBe(false)
  })

  it('每群每天上限：超出的提名不贴；用完之后提示词不带点赞段', async () => {
    const t = await setup('NOTHING\n@@like om_fix 修好了\n@@like om_idx 讲清了原因', { FRIDAY_KUDOS_MAX_PER_DAY: '1' })
    await t.post(FIX, { messageId: 'om_idx', text: '原因是索引没建，补上之后查询从 3 秒降到 50 毫秒' })
    await t.orchestrator.runProactiveCheck('oc_group')
    expect(t.addReaction).toHaveBeenCalledTimes(1)
    expect(t.ledger.has('om_idx')).toBe(false)
    t.again()
    await t.post({ messageId: 'om_more', text: '继续' }, { messageId: 'om_more2', text: '好' })
    await t.orchestrator.runProactiveCheck('oc_group')
    expect(t.state.allPrompts[1]?.text).not.toContain('@@like')
    expect(t.addReaction).toHaveBeenCalledTimes(1)
  })

  it('部署把上限设为 0：提示词不带点赞段，模型提名了也不贴', async () => {
    const t = await setup('NOTHING\n@@like om_fix 修好了', { FRIDAY_KUDOS_MAX_PER_DAY: '0' })
    await t.post(FIX, CHAT)
    await t.orchestrator.runProactiveCheck('oc_group')
    expect(t.state.allPrompts[0]?.text).not.toContain('@@like')
    expect(t.addReaction).not.toHaveBeenCalled()
    expect(t.ledger.has('om_fix')).toBe(false)
  })

  it('@@like 与 @@reply 组合：回复照发且不带协议行，点赞照贴', async () => {
    const t = await setup('@@like om_fix 修好了登录超时\n@@reply om_q1\n接一下 @张三 的问题：数仓权限找运维申请。')
    await t.post(FIX, { messageId: 'om_q1', text: '数仓权限找谁申请啊？' })
    expect(await t.orchestrator.runProactiveCheck('oc_group')).toBe('replied')
    const reply = t.feishu.of('replyMarkdown')[0]
    expect(reply?.target).toBe('om_q1')
    expect(String(reply?.payload)).toContain('数仓权限找运维申请')
    expect(String(reply?.payload)).not.toContain('@@')
    expect(t.addReaction).toHaveBeenCalledWith('om_fix', 'THUMBSUP')
  })

  it('格式不对和超出条数的 @@like 行不贴、也不会被当成正文发到群里', async () => {
    const t = await setup(['@@like', '@@like om_fix 修好了', '@@like om_idx 讲清了原因', '@@like om_chat 第三条超出', 'NOTHING'].join('\n'))
    await t.post(FIX, { messageId: 'om_idx', text: '原因是索引没建，补上之后查询从 3 秒降到 50 毫秒' }, CHAT)
    expect(await t.orchestrator.runProactiveCheck('oc_group')).toBe('silent')
    expect(t.addReaction.mock.calls.map((c) => c[0])).toEqual(['om_fix', 'om_idx'])
    expect(t.feishu.sent).toHaveLength(0)
  })

  it('这一轮读过外部资料（来源门禁不过）：不点赞', async () => {
    const t = await setup('NOTHING\n@@like om_fix 修好了')
    t.state.script = [{ kind: 'hook', run: () => {
      const mcp = t.state.allPrompts.at(-1)!.mcpServers as { env: { name: string; value: string }[] }[]
      const cap = new TokenIssuer('s').verify(mcp[0]!.env.find((e) => e.name === 'FRIDAY_CAP_TOKEN')!.value)!
      t.orchestrator.noteExternalSource(cap.sessionKey, { kind: 'document', ref: 'private-document' })
    } }, { kind: 'text', text: 'NOTHING\n@@like om_fix 修好了' }]
    const info = vi.spyOn(log, 'info')
    await t.post(FIX, CHAT)
    await t.orchestrator.runProactiveCheck('oc_group')
    expect(t.addReaction).not.toHaveBeenCalled()
    expect(t.ledger.has('om_fix')).toBe(false)
    expect(skipped(info)).toEqual(['om_fix:closed'])
    info.mockRestore()
  })

  it('/space set kudos off：提示词不带点赞段，模型提名了也不贴、不写账本；on 再打开', async () => {
    const t = await setup('NOTHING\n@@like om_fix 修好了')
    await t.orchestrator.handleMessage(msg({ text: '@Friday /space set kudos off', senderOpenId: 'ou_alice', mentions: AT_BOT }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('不再给消息点赞')
    expect(t.spaces.get(t.space.id)?.config.kudos).toBe('off')
    await t.post(FIX, CHAT)
    await t.orchestrator.runProactiveCheck('oc_group')
    expect(t.state.allPrompts[0]?.text).not.toContain('@@like')
    expect(t.addReaction).not.toHaveBeenCalled()
    expect(t.ledger.has('om_fix')).toBe(false)

    await t.orchestrator.handleMessage(msg({ text: '@Friday /space set 点赞 on', senderOpenId: 'ou_alice', mentions: AT_BOT }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('每天最多 3 个')
    expect(t.spaces.get(t.space.id)?.config.kudos).toBe('on')
    t.again()
    await t.post({ messageId: 'om_more', text: '继续' })
    await t.orchestrator.runProactiveCheck('oc_group')
    expect(t.addReaction).toHaveBeenCalledWith('om_fix', 'THUMBSUP')
  })

  it('/space set kudos：非负责人被拒；取值不对给用法；主动模式关着时说明打开后才生效', async () => {
    const t = await setup('NOTHING')
    await t.orchestrator.handleMessage(msg({ text: '@Friday /space set kudos off', senderOpenId: 'ou_bob', mentions: AT_BOT }))
    expect(t.spaces.get(t.space.id)?.config.kudos).toBeUndefined()
    await t.orchestrator.handleMessage(msg({ text: '@Friday /space set kudos maybe', senderOpenId: 'ou_alice', mentions: AT_BOT }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('/space set kudos on|off')
    t.proactive.disable('oc_group')
    await t.orchestrator.handleMessage(msg({ text: '@Friday /space set kudos on', senderOpenId: 'ou_alice', mentions: AT_BOT }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('主动模式现在是关的')
    await t.orchestrator.handleMessage(msg({ text: '@Friday /space', senderOpenId: 'ou_alice', mentions: AT_BOT }))
    await t.orchestrator.handleMessage(msg({ text: '@Friday /space set', senderOpenId: 'ou_alice', mentions: AT_BOT }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('kudos on|off')
  })
})
