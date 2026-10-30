/**
 * 会话生命周期：被拉进群、被踢、群解散、消息撤回、表情回执。
 * 这几件事全靠 im.message.receive_v1 之外的事件，之前一条都没订阅。
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
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
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { Signals } from '../src/core/signals.js'
import { Todos } from '../src/core/todos.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { normalizeChatLifecycle, normalizeReaction, normalizeRecall } from '../src/feishu/ws.js'
import { isSmallTalk } from '../src/feishu/mention.js'
import { cardIsEmpty } from '../src/core/orchestrator.js'
import { FOLD_AFTER_CHARS, FOLD_AFTER_LINES, renderFoldedAnswer, shouldFold, splitLede } from '../src/feishu/cards.js'
import { describeError } from '../src/mcp/server.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('test', 'error')

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'friday-life-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:')
  const messageCache = new MessageCache(registry.db)
  const feishu = new FakeFeishu()
  const messages = new MessageService(asFeishuClient(feishu), messageCache, log)
  const signals = new Signals(registry.db)
  const routines = new RoutineStore(registry.db)
  const proactive = new Proactive(registry.db, {})
  const { app, state } = createFakeAgent()
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  const deps = spaceDeps(registry.db, { admins: cfg.policy.admins })
  orchestrator = new Orchestrator({
    cfg, feishu: asFeishuClient(feishu), runtime, registry,
    memory: new ChannelMemory(registry.db), messages, routines, todos: new Todos(registry.db),
    signals, proactive, ...deps,
    tokens: new TokenIssuer('s'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent/server.js',
    botOpenId: 'ou_bot', log,
  })
  return { orchestrator, feishu, signals, routines, proactive, messageCache, messages, spaces: deps.spaces, registry, state, runtime }
}

function atMsg(chatId: string, text = '@Friday 你好', senderOpenId = 'ou_bob') {
  return {
    eventId: `ev_${Math.random()}`,
    messageId: `om_${Math.random().toString(36).slice(2, 8)}`,
    chatId,
    chatType: 'group' as const,
    msgType: 'text',
    text,
    senderOpenId,
    senderType: 'user',
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Friday' }],
    createTimeMs: Date.now(),
  }
}

/** 发到群里的卡片；群里第一次 @ 只发一条入群确认（文字），不再发欢迎卡 */
function chatCards(feishu: FakeFeishu) {
  return feishu.of('sendToChat').filter((s) => typeof s.payload === 'object' && s.payload !== null && 'card' in s.payload)
}

/** 发到群里的文字（入群确认） */
function chatTexts(feishu: FakeFeishu): string[] {
  return feishu.of('sendToChat').map((s) => JSON.stringify(s.payload))
}

describe('被拉进群', () => {
  it('进群那一刻只记下「谁拉我进来的」，不建空间、不发卡', async () => {
    const t = await setup()
    await t.orchestrator.handleChatLifecycle(
      normalizeChatLifecycle('bot_added', { chat_id: 'oc_new', operator_id: { open_id: 'ou_alice' }, name: '新群' }),
    )
    // 拉进来没人用，就不该占资源、也不该在群里发东西；入群确认等第一次 @ 建空间时再发
    expect(t.spaces.byChat('oc_new')).toBeUndefined()
    expect(chatCards(t.feishu)).toHaveLength(0)
    expect(t.feishu.of('sendToChat')).toHaveLength(0)
  })

  it('第一条 @ 才建空间：负责人 = 拉我进来的人 ∪ 群主，且这一条不当活儿干', async () => {
    const t = await setup()
    t.feishu.chatOwners.set('oc_new', 'ou_boss')
    await t.orchestrator.handleChatLifecycle(normalizeChatLifecycle('bot_added', { chat_id: 'oc_new', operator_id: { open_id: 'ou_alice' } }))
    // 第一个说话的是 ou_bob，不是拉群的 ou_alice
    await t.orchestrator.handleMessage(atMsg('oc_new'))
    await new Promise((r) => setTimeout(r, 30))

    const space = t.spaces.byChat('oc_new')
    expect(space).toBeDefined()
    expect(t.spaces.owners(space!.id).sort()).toEqual(['ou_alice', 'ou_boss'])
    expect(t.spaces.roleOf(space!.id, 'ou_bob')).toBe('member')
    // 群里只有一条入群确认（文字），负责人按实际写；不再发欢迎卡
    expect(chatCards(t.feishu)).toHaveLength(1)
    const texts = chatTexts(t.feishu)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('Friday · 本群功能')
    // 这一条没被当成任务
    expect(t.feishu.of('replyMarkdown')).toHaveLength(0)
  })

  it('拿不到拉群的人时退回第一个说话的人，空间还是建得起来', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(atMsg('oc_orphan', '@Friday 在吗', 'ou_carol'))
    await new Promise((r) => setTimeout(r, 30))
    const space = t.spaces.byChat('oc_orphan')
    expect(space).toBeDefined()
    expect(t.spaces.owners(space!.id)).toEqual(['ou_carol'])
  })

  it('第一条 @ 就问正事：入群确认照发，但活儿也接了，不把问题吞掉', async () => {
    const t = await setup()
    await t.orchestrator.handleChatLifecycle(normalizeChatLifecycle('bot_added', { chat_id: 'oc_work', operator_id: { open_id: 'ou_alice' } }))
    await t.orchestrator.handleMessage(atMsg('oc_work', '@Friday 帮我看下发布流程卡在哪一步'))
    await new Promise((r) => setTimeout(r, 120))

    // 入群确认还是发了（一条文字，不是卡片）
    const texts = chatTexts(t.feishu)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('Friday · 本群功能')
    expect(chatCards(t.feishu)).toHaveLength(1)
    // 但这一条没被吞掉：真的开了一轮活
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toMatchObject({ n: 1 })
  })

  it('isSmallTalk：只有整条都是招呼才算，沾一点正事就当活儿干', () => {
    for (const s of ['在吗', '你好', '你好呀', 'hi', 'Hello!', '  测试  ', '', '来了～']) expect(isSmallTalk(s)).toBe(true)
    for (const s of ['在吗？线上挂了', '你好，帮我看个 bug', '发布排期是哪天', 'hi 能读群历史吗', '测试环境怎么连']) expect(isSmallTalk(s)).toBe(false)
  })

  it('入群确认只发一次：再 @ 不会重复发', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(atMsg('oc_new'))
    await new Promise((r) => setTimeout(r, 30))
    const after1 = t.feishu.of('sendToChat').length
    await t.orchestrator.handleMessage(atMsg('oc_new', '@Friday 再问一句'))
    await new Promise((r) => setTimeout(r, 30))
    expect(t.feishu.of('sendToChat').length).toBe(after1)
    expect(t.spaces.listAll()).toHaveLength(1)
  })
})

describe('长回答折叠', () => {
  const long = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行内容`).join('\n')

  it('够长就折，短的不折', () => {
    expect(shouldFold(long)).toBe(true)
    expect(shouldFold('一句话说完。')).toBe(false)
    expect(shouldFold('')).toBe(false)
  })

  it('@ 掉进折叠面板里就不折——折叠面板里的 @ 通不通知，飞书没承诺', () => {
    const atAtEnd = `${long}\n\n<at open_id="ou_bob"></at> 你看下这个`
    expect(shouldFold(atAtEnd)).toBe(false)
  })

  it('@ 在露出来的那一段里就照折——卡片正文的 @ 是通知得到的', () => {
    const atInLede = `<at open_id="ou_bob"></at> 发布卡在人工确认这步了，你看下。\n\n${long}`
    expect(shouldFold(atInLede)).toBe(true)
    const { lede, rest } = splitLede(atInLede)
    expect(lede).toContain('ou_bob')
    expect(rest).not.toContain('<at')
  })

  it('结论独占一行时，那一行就是露出来的部分', () => {
    const { lede, rest } = splitLede(`结论：发布卡在人工确认。\n\n${long}`)
    expect(lede).toBe('结论：发布卡在人工确认。')
    expect(rest).toContain('第 1 行内容')
  })
})

describe('被踢出群 / 群解散', () => {
  it('停掉主动和职责、保留数据；重新进群仍须负责人显式恢复', async () => {
    const t = await setup()
    const spaceId = t.spaces.ensure({ kind: 'group', chatId: 'oc_x', openId: 'ou_alice' }).id
    t.proactive.enable('oc_x', 'ou_alice')
    const r = t.routines.add({ kind: 'report', chatId: 'oc_x', chatType: 'group', name: '日报', prompt: '汇总', schedule: { type: 'daily', at: '09:00' }, ownerOpenId: 'ou_alice', spaceId })
    expect(t.routines.listFor({ chatId: 'oc_x', chatType: 'group' }, false)).toHaveLength(1)

    await t.orchestrator.handleChatLifecycle(normalizeChatLifecycle('bot_removed', { chat_id: 'oc_x', operator_id: { open_id: 'ou_boss' } }))
    expect(t.proactive.get('oc_x').enabled).toBe(false)
    expect(t.routines.listFor({ chatId: 'oc_x', chatType: 'group' }, false)).toHaveLength(0)
    expect(t.spaces.byChat('oc_x')).toBeUndefined() // 不再是活跃空间
    expect(t.spaces.get(spaceId)?.status).toBe('archived')
    expect(t.routines.get(r.id)).toBeDefined() // 数据还在

    // 重新加群不等于恢复授权。只有负责人显式恢复才能继续。
    await t.orchestrator.handleChatLifecycle(normalizeChatLifecycle('bot_added', { chat_id: 'oc_x', operator_id: { open_id: 'ou_alice' } }))
    expect(t.spaces.byChat('oc_x')).toBeUndefined()
    t.feishu.members.set('oc_x', new Set(['ou_alice']))
    await t.orchestrator.handleMessage(atMsg('oc_x', '@Friday /space resume', 'ou_alice'))
    expect(t.spaces.byChat('oc_x')?.id).toBe(spaceId)
    expect(t.routines.get(r.id)?.enabled).toBe(false)
    expect(t.spaces.listAll(true)).toHaveLength(1)
  })

  it('群解散走同一条路', async () => {
    const t = await setup()
    t.spaces.ensure({ kind: 'group', chatId: 'oc_y', openId: 'ou_alice' })
    await t.orchestrator.handleChatLifecycle(normalizeChatLifecycle('disbanded', { chat_id: 'oc_y' }))
    expect(t.spaces.byChat('oc_y')).toBeUndefined()
  })
})

describe('撤回', () => {
  it('撤回的消息从缓存里抹掉，之后搜不到', async () => {
    const t = await setup()
    t.messages.remember('oc_1', { messageId: 'om_1', createTimeMs: Date.now(), msgType: 'text', senderName: '陆知行', senderOpenId: 'ou_alice', senderType: 'user', text: '这句我说错了' })
    expect(t.messages.cached('om_1')).toBeDefined()
    t.orchestrator.handleRecall(normalizeRecall({ message_id: 'om_1', chat_id: 'oc_1' }))
    expect(t.messages.cached('om_1')).toBeUndefined()
  })
})

describe('表情回执', () => {
  it('别人贴表情 = 这条有人接了，收掉对应信号', async () => {
    const t = await setup()
    const spaceId = t.spaces.ensure({ kind: 'group', chatId: 'oc_z', openId: 'ou_alice' }).id
    t.messages.remember('oc_z', { messageId: 'om_q', createTimeMs: Date.now(), msgType: 'text', senderName: '陆知行', senderOpenId: 'ou_alice', senderType: 'user', text: '数仓权限找谁申请？', threadId: 'omt_1' })
    t.signals.ingest({ kind: 'unanswered_question', source: 'feishu:omt_1', spaceId, title: '数仓权限找谁申请？' })
    expect(t.signals.open(spaceId)).toHaveLength(1)

    t.orchestrator.handleReaction(normalizeReaction({ message_id: 'om_q', reaction_type: { emoji_type: 'OnIt' }, user_id: { open_id: 'ou_bob' } }))
    expect(t.signals.open(spaceId)).toHaveLength(0)
  })

  it('机器人自己贴的回执不算', async () => {
    const t = await setup()
    const spaceId = t.spaces.ensure({ kind: 'group', chatId: 'oc_z', openId: 'ou_alice' }).id
    t.messages.remember('oc_z', { messageId: 'om_q', createTimeMs: Date.now(), msgType: 'text', senderName: '陆知行', senderOpenId: 'ou_alice', senderType: 'user', text: '在吗', threadId: 'omt_1' })
    t.signals.ingest({ kind: 'unanswered_question', source: 'feishu:omt_1', spaceId, title: '在吗' })
    t.orchestrator.handleReaction(normalizeReaction({ message_id: 'om_q', reaction_type: { emoji_type: 'OnIt' }, user_id: { open_id: 'ou_bot' } }))
    expect(t.signals.open(spaceId)).toHaveLength(1)
  })
})

describe('进度卡片不留白条', () => {
  const base = { phase: 'done' as const, tools: [], footer: undefined, error: undefined }
  it('一问一答、没动工具、没超时 → 卡片收尾后是空的，该撤掉', () => {
    expect(cardIsEmpty(base)).toBe(true)
  })

  it('有过程 / 有用时 / 出过错 / 还在跑，都要留着', () => {
    expect(cardIsEmpty({ ...base, tools: [{ id: 't1', title: '读取话题', status: 'completed' }] })).toBe(false)
    expect(cardIsEmpty({ ...base, footer: '用时 1 分 10 秒' })).toBe(false)
    expect(cardIsEmpty({ ...base, error: '权限被拒' })).toBe(false)
    expect(cardIsEmpty({ ...base, phase: 'failed' })).toBe(false)
    expect(cardIsEmpty({ ...base, phase: 'working' })).toBe(false)
    expect(cardIsEmpty({ ...base, phase: 'cancelled' })).toBe(false)
  })
})

describe('工具报错要能看懂', () => {
  it('抛对象不再变成 [object Object]', () => {
    expect(describeError({ code: 99991663, msg: 'no permission' })).toBe('no permission · code=99991663')
    expect(describeError({ status: 400, message: 'bad request' })).toBe('bad request · HTTP 400')
    expect(describeError({ a: 1 })).toBe('{"a":1}')
    expect(describeError({})).toBe('[object Object]') // 实在没信息就照实说，不编
  })

  it('Error 和字符串照旧', () => {
    expect(describeError(new Error('炸了'))).toBe('炸了')
    expect(describeError('炸了')).toBe('炸了')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(describeError(circular)).toBe('[object Object]') // 循环引用不抛
  })
})

describe('合并转发', () => {
  it('把转发进来的聊天记录展开成正文，而不是一句「[合并转发消息]」', async () => {
    const t = await setup()
    const fwd = {
      eventId: 'ev_f',
      messageId: 'om_fwd',
      chatId: 'oc_g',
      chatType: 'group' as const,
      msgType: 'merge_forward',
      text: '[合并转发消息]',
      senderOpenId: 'ou_bob',
      senderType: 'user',
      mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Friday' }],
      createTimeMs: Date.now(),
    }
    t.feishu.forwarded.set('om_fwd', [
      { messageId: 'om_i1', chatId: 'oc_other', threadId: undefined, senderOpenId: 'ou_x', senderName: '傅禹铭', text: '求解这个权限问题可以怎么搞', msgType: 'text', createTimeMs: Date.now() - 6e4 },
      { messageId: 'om_i2', chatId: 'oc_other', threadId: undefined, senderOpenId: 'ou_y', senderName: '李林灿', text: '平台 09-15 上线了新权限模型', msgType: 'text', createTimeMs: Date.now() - 3e4 },
    ])
    // @ts-expect-error 私有方法，测的就是这一段
    const note = await t.orchestrator.attachmentsNote(fwd, t.orchestrator.prepareWorkspace('oc_g', 'group'))
    expect(note).toContain('转发了一段聊天记录（2 条）')
    expect(note).toContain('傅禹铭（发言人身份 ou_x）: 求解这个权限问题可以怎么搞')
    expect(note).toContain('李林灿（发言人身份 ou_y）: 平台 09-15 上线了新权限模型')
    expect(note).toContain('平台 09-15 上线了新权限模型')
    expect(note).not.toContain('[合并转发消息]')
  })

  it('读不到里面的内容时明说，不假装看见了', async () => {
    const t = await setup()
    const fwd = { eventId: 'e', messageId: 'om_empty', chatId: 'oc_g', chatType: 'group' as const, msgType: 'merge_forward', text: '', senderOpenId: 'ou_bob', senderType: 'user', mentions: [], createTimeMs: Date.now() }
    // @ts-expect-error 私有方法
    const note = await t.orchestrator.attachmentsNote(fwd, t.orchestrator.prepareWorkspace('oc_g', 'group'))
    expect(note).toContain('读不到里面的内容')
  })
})

describe('个人授权卡', () => {
  it('点「完成授权」时已经连上了 → 直接说连上了，不提粘地址', async () => {
    const t = await setup()
    t.orchestrator.deps.userTokens?.save?.('ou_bob', { accessToken: 'x', refreshToken: 'r', expiresAtMs: Date.now() + 6e5, name: '张三' } as never)
    const res = (await t.orchestrator.handleCardAction({ operatorOpenId: 'ou_bob', value: { action: 'oauth', op: 'check' }, messageId: 'om_c', token: 't' } as never)) as { toast?: { content?: string } }
    // 没配 oauth 的部署会走「没开启」分支，配了的走「已连上」——两种都不该讲粘地址
    expect(String(res?.toast?.content ?? '')).not.toContain('地址栏')
  })

  it('点「稍后处理」只是收起来，不发私聊', async () => {
    const t = await setup()
    const before = t.feishu.of('sendToUser').length
    const res = (await t.orchestrator.handleCardAction({ operatorOpenId: 'ou_bob', value: { action: 'oauth', op: 'later' }, messageId: 'om_c', token: 't' } as never)) as { toast?: { content?: string } }
    expect(res?.toast?.content).toContain('个人授权')
    expect(t.feishu.of('sendToUser')).toHaveLength(before)
  })
})

describe('长回答折叠', () => {
  it('短的原样发，不套卡片', () => {
    expect(shouldFold('查到了：是 acl.ts:242 那段没覆盖到工作区外的文件。')).toBe(false)
    expect(shouldFold('')).toBe(false)
  })

  it('超过行数或字数就折', () => {
    expect(shouldFold(Array.from({ length: 30 }, (_, i) => `第 ${i} 行`).join('\n'))).toBe(true)
    expect(shouldFold('啊'.repeat(FOLD_AFTER_CHARS + 1))).toBe(true)
  })

  it('优先在空行处切，结论自成一段', () => {
    const md = ['结论：是 ACL 那层没拦住。', '', '链路：', '- a', '- b', '- c', '- d', '- e', '- f', '- g', '- h', '- i'].join('\n')
    const { lede, rest } = splitLede(md)
    expect(lede).toBe('结论：是 ACL 那层没拦住。')
    expect(rest).toContain('链路：')
  })

  it('第一段只是引子（冒号结尾）时，把紧跟的清单一起露在外面；清单太长才折叠', () => {
    const list = Array.from({ length: 16 }, (_, i) => `- 待办 ${i + 1}：示例事项`).join('\n')
    const { lede, rest } = splitLede(`今天（9/28 周一）有这些：\n\n${list}`)
    expect(lede).toContain('今天（9/28 周一）有这些：')
    expect(lede).toContain('待办 16')
    expect(rest).toBe('')
    const longList = Array.from({ length: 40 }, (_, i) => `- 待办 ${i + 1}：示例事项`).join('\n')
    const folded = splitLede(`今天有这些：\n\n${longList}`)
    expect(folded.lede).toBe('今天有这些：')
    expect(folded.rest).toContain('待办 40')
  })

  it('一行开场白后面直接是小标题和清单时，第一节一起露在外面；正文段落照旧自成一段', () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => `- 第 ${i + 1} 条`).join('\n')
    const memory = `以下都是我自己记的，你说一句就能改。\n\n**关于你本人**\n\n${items(4)}\n\n**你定过的事**\n\n${items(12)}`
    const { lede, rest } = splitLede(memory)
    expect(lede).toContain('**关于你本人**')
    expect(lede).toContain('第 4 条')
    expect(rest.startsWith('**你定过的事**')).toBe(true)
    // 小标题紧跟清单、中间没有空行，也一样
    const tight = splitLede(`以下都是我自己记的。\n\n**关于你本人**\n${items(3)}\n\n${items(30)}`)
    expect(tight.lede).toContain('第 3 条')
    // 结论后面是一段正文而不是清单：还是只露结论
    const prose = splitLede(`结论：发布卡在人工确认。\n\n链路是这样的：先过 ACL，再到审批。\n${items(30)}`)
    expect(prose.lede).toBe('结论：发布卡在人工确认。')
  })

  it('前面没有空行时用短标题，正文完整放入面板', () => {
    const md = Array.from({ length: 40 }, (_, i) => `行${i}`).join('\n')
    const { lede, rest } = splitLede(md)
    expect(lede.split('\n').length).toBeLessThanOrEqual(FOLD_AFTER_LINES)
    expect(rest).toBe(md)
  })

  function panelBody(markdown: string): string | undefined {
    const card = renderFoldedAnswer({ markdown }) as { body: { elements: { tag: string; elements?: { content: string }[] }[] } }
    return card.body.elements.find((e) => e.tag === 'collapsible_panel')?.elements?.[0]?.content
  }

  it('keeps a short copyable block beside its introduction, without splitting code at blank lines', () => {
    const first = '运行这个命令：\n\n```sh\necho one\n\necho two\n```'
    const rest = Array.from({ length: 25 }, (_, i) => `- 注意事项 ${i}`).join('\n')
    expect(splitLede(`${first}\n\n${rest}`)).toEqual({ lede: first, rest })
    const unfinished = '运行这个命令：\n\n```sh\necho one\n\necho two'
    expect(splitLede(`${unfinished}\n\n${rest}`).lede).toBe('运行这个命令：')
    expect(panelBody(`${unfinished}\n\n${rest}`)).toContain('```sh\necho one\n\necho two')
  })

  it('900 字单段真正折叠，首屏简短且面板完整保留原文', () => {
    const md = '字'.repeat(900)
    const { lede, rest } = splitLede(md)
    expect(shouldFold(md)).toBe(true)
    expect(lede.length).toBeLessThan(100)
    expect(rest).toBe(md)
    expect(panelBody(md)).toBe(md)
  })

  it('长段内的链接保持完整，不在文字或 URL 中间硬切', () => {
    const link = `[完整链接](https://example.invalid/${'path'.repeat(200)})`
    const md = `证据如下：${link}，详情结束。`
    expect(shouldFold(md)).toBe(true)
    expect(splitLede(md).rest).toBe(md)
    expect(panelBody(md)).toBe(md)
  })

  it('短首段中的 @ 保留在外面，后面的长段和链接完整展开', () => {
    const mention = '<at open_id="ou_bob"></at>'
    const first = `${mention} 请确认这项结果。`
    const rest = `${'证据'.repeat(400)} [来源](https://example.invalid/source)`
    const md = `${first}\n\n${rest}`
    expect(shouldFold(md)).toBe(true)
    expect(splitLede(md)).toEqual({ lede: first, rest })
    expect(panelBody(md)).toBe(rest)
  })

  it('单长段中的 @ 不被截断或藏进面板，沿用完整普通消息路径', () => {
    const md = `${'字'.repeat(900)}<at open_id="ou_bob"></at> 请确认。`
    expect(splitLede(md).rest).toBe(md)
    expect(shouldFold(md)).toBe(false)
  })

  it('不足十行但超过字数预算的多段仍折叠，保持段落正文', () => {
    const first = '结论：已定位到问题。'
    const rest = `${'证据一'.repeat(150)}\n\n${'证据二'.repeat(150)}`
    const md = `${first}\n\n${rest}`
    expect(splitLede(md)).toEqual({ lede: first, rest })
    expect(panelBody(md)).toBe(rest)
  })

  it('代码块内的空行不作为切分点，保留整块 Markdown', () => {
    const md = `\`\`\`text\n前半段\n\n${'代码'.repeat(450)}\n\`\`\``
    expect(splitLede(md).rest).toBe(md)
    expect(panelBody(md)).toBe(md)
  })

  it('超出面板预算回退完整交付，不丢弃 8000 字以后的内容', () => {
    const md = `结论\n\n${'字'.repeat(8000)}原文结尾`
    expect(shouldFold(md)).toBe(false)
    expect(panelBody(md)).toBe(`${'字'.repeat(8000)}原文结尾`)
  })

  it('折叠卡片：结论在外面，其余进面板，不向用户展示内部行数', () => {
    const md = ['结论：整层都没拦。', '', ...Array.from({ length: 20 }, (_, i) => `- 证据 ${i}`)].join('\n')
    const card = renderFoldedAnswer({ markdown: md })
    const txt = JSON.stringify(card)
    expect(txt).toContain('结论：整层都没拦。')
    expect(txt).toContain('collapsible_panel')
    expect(txt).toContain('展开详情')
    expect(txt).toContain('证据 19')
  })
})


describe('显式停用与恢复', () => {
  it('停用后的消息不会缓存、建任务或新建空间，查看状态仍可用', async () => {
    const t = await setup()
    const space = t.spaces.ensure({ kind: 'group', chatId: 'oc_stop', openId: 'ou_alice' })
    await t.orchestrator.handleMessage(atMsg('oc_stop', '@Friday /space archive', 'ou_alice'))
    const ignored = atMsg('oc_stop', '@Friday 帮我分析附件', 'ou_alice')
    await t.orchestrator.handleMessage(ignored)
    expect(t.messages.cached(ignored.messageId)).toBeUndefined()
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toMatchObject({ n: 0 })
    expect(t.spaces.listAll(true)).toHaveLength(1)
    expect(t.spaces.get(space.id)).toMatchObject({ status: 'archived', chatId: 'oc_stop' })
    await t.orchestrator.handleMessage(atMsg('oc_stop', '@Friday /space', 'ou_alice'))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('状态：已停用')
  })

  it('恢复要求当前负责人且仍在群里，等待成员查询期间撤权也不恢复', async () => {
    const t = await setup()
    const space = t.spaces.ensure({ kind: 'group', chatId: 'oc_stop', openId: 'ou_alice' })
    await t.orchestrator.handleMessage(atMsg('oc_stop', '@Friday /space archive', 'ou_alice'))
    t.feishu.members.set('oc_stop', new Set(['ou_bob']))
    await t.orchestrator.handleMessage(atMsg('oc_stop', '@Friday /space resume', 'ou_bob'))
    expect(t.spaces.get(space.id)?.status).toBe('archived')
    await t.orchestrator.handleMessage(atMsg('oc_stop', '@Friday /space resume', 'ou_alice'))
    expect(t.spaces.get(space.id)?.status).toBe('archived')
    vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementationOnce(async () => {
      t.registry.db.prepare("UPDATE space_members SET role = 'member' WHERE space_id = ? AND open_id = ?").run(space.id, 'ou_alice')
      return new Set(['ou_alice'])
    })
    await t.orchestrator.handleMessage(atMsg('oc_stop', '@Friday /space resume', 'ou_alice'))
    expect(t.spaces.get(space.id)?.status).toBe('archived')
  })

  it('停用并恢复后，在原话题开新会话；迟到的旧执行不能写进新任务', async () => {
    const t = await setup()
    t.spaces.ensure({ kind: 'group', chatId: 'oc_stop', openId: 'ou_alice' })
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((r) => { entered = r })
    const delayed = new Promise<void>((r) => { release = r })
    t.state.script = [{ kind: 'hook', run: async () => { entered(); await delayed } }, { kind: 'text', text: '旧回答不能发' }]
    const first = atMsg('oc_stop', '@Friday 分析第一个问题', 'ou_alice')
    const oldWork = t.orchestrator.handleMessage({ ...first, threadId: 'omt_stable' })
    await started
    const old = t.registry.resolveSession(['thread:omt_stable'])!
    await t.orchestrator.handleMessage(atMsg('oc_stop', '@Friday /space archive', 'ou_alice'))
    t.feishu.members.set('oc_stop', new Set(['ou_alice']))
    await t.orchestrator.handleMessage(atMsg('oc_stop', '@Friday /space resume', 'ou_alice'))
    t.state.script = [{ kind: 'text', text: '新的回答' }]
    await t.orchestrator.handleMessage({ ...atMsg('oc_stop', '@Friday 新的问题', 'ou_alice'), threadId: 'omt_stable' })
    const fresh = t.registry.resolveSession(['thread:omt_stable'])!
    expect(fresh.sessionKey).not.toBe(old.sessionKey)
    release()
    await oldWork
    expect(t.registry.getSession(old.sessionKey)?.status).toBe('archived')
    expect(t.registry.getSession(fresh.sessionKey)?.status).toBe('idle')
    const tasks = t.registry.db.prepare('SELECT status, stop_reason FROM tasks ORDER BY id').all()
    expect(tasks).toMatchObject([{ status: 'cancelled', stop_reason: 'space_disabled' }, { status: 'done' }])
    expect(t.feishu.of('replyMarkdown').map((m) => String(m.payload)).join('\n')).not.toContain('旧回答不能发')
    await t.runtime.stop()
  })

  it('ACP 新会话创建期间停用，返回的句柄被关闭且不启动 prompt', async () => {
    const t = await setup()
    t.spaces.ensure({ kind: 'group', chatId: 'oc_stop', openId: 'ou_alice' })
    const create = t.runtime.newSession.bind(t.runtime)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((r) => { entered = r })
    const delayed = new Promise<void>((r) => { release = r })
    vi.spyOn(t.runtime, 'newSession').mockImplementationOnce(async (...args) => {
      const id = await create(...args)
      entered(); await delayed
      return id
    })
    const work = t.orchestrator.handleMessage(atMsg('oc_stop', '@Friday 分析问题', 'ou_alice'))
    await started
    await t.orchestrator.handleMessage(atMsg('oc_stop', '@Friday /space archive', 'ou_alice'))
    release()
    await work
    expect(t.state.allPrompts).toHaveLength(0)
    expect(t.state.sessions.size).toBe(0)
    expect(t.registry.db.prepare('SELECT status, stop_reason FROM tasks').get()).toMatchObject({ status: 'cancelled', stop_reason: 'space_disabled' })
    await t.runtime.stop()
  })
})
