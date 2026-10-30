import { mkdtempSync, existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import * as frameTools from '../src/core/frames.js'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Proactive } from '../src/core/proactive.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RoutineStore } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import { Inbox, NUDGE_DELAY_MS } from '../src/core/inbox.js'
import { WikiDocs } from '../src/core/wiki.js'
import { chatScope, dmScope, spaceDeps } from './helpers/space.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createFakeAgent, type FakeTurnStep } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient, cardText, historyMsg } from './helpers/fake-feishu.js'

const log = createLogger('test', 'error')
const confirmedMemory = { status: 'confirmed' as const, confirmation: { by: 'ou_alice', messageId: 'synthetic-human-confirmation', at: Date.now() } }

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    eventId: `ev_${Math.random()}`,
    messageId: `om_${Math.random().toString(36).slice(2, 8)}`,
    chatId: 'oc_group',
    chatType: 'group',
    msgType: 'text',
    text: '@Friday 总结一下最近的讨论',
    senderOpenId: 'ou_alice',
    senderType: 'user',
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Friday' }],
    createTimeMs: Date.now(),
    ...over,
  }
}

async function setup(script?: FakeTurnStep[], envOver: Record<string, string> = {}, withProactive = false,
  extraDeps: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-test-'))
  const cfg = loadConfig({
    FEISHU_APP_ID: 'a',
    FEISHU_APP_SECRET: 'b',
    FRIDAY_HOME: home,
    FRIDAY_PERMISSION_TIMEOUT_MS: '2000',
    FRIDAY_PROMPT_TIMEOUT_MS: '5000',
    // 兼容旧部署的立即发卡配置也不能再发过程卡。
    FRIDAY_PROGRESS_CARD_DELAY_MS: '0',
    // 轮末记忆整理会多跑一轮，默认关掉；专门的用例再打开
    FRIDAY_REFLECT: 'off',
    // repos 默认不挂（开给同事的前提）；大部分用例要断言仓库上下文，所以这里显式给测试群开上
    FRIDAY_REPOS_CHATS: 'oc_group',
    ...envOver,
  } as NodeJS.ProcessEnv)
  mkdirSync(join(cfg.workspace.root, 'repos', 'deepseek-harness'), { recursive: true })
  const registry = new Registry(':memory:')
  const proactive = withProactive ? new Proactive(registry.db, { ...cfg.proactive, minMessages: 2 }) : undefined
  const memory = new ChannelMemory(registry.db)
  const messageCache = new MessageCache(registry.db)
  const sp = spaceDeps(registry.db, { admins: cfg.policy.admins })
  // 群空间当作已经建好（第一条 @ 建空间的路径在 lifecycle.test.ts 里单测）
  sp.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_alice' })
  const feishu = new FakeFeishu()
  feishu.threadIdForReply = 'omt_topic1'
  feishu.names.set('ou_alice', '张三')
  const messages = new MessageService(asFeishuClient(feishu), messageCache, log)
  const tokens = new TokenIssuer('s')
  const { app, state } = createFakeAgent(script ? { script } : undefined)
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({
    transport: { kind: 'inproc', agent: app },
    onPermission: (req, signal) => orchestrator.handlePermission(req, signal),
    // 跟生产一致：并发上限从配置来，测试才测得到真实行为
    maxConcurrent: cfg.policy.maxConcurrentTurns,
    log,
  })
  orchestrator = new Orchestrator({
    cfg,
    feishu: asFeishuClient(feishu),
    runtime,
    registry,
    memory,
    messages,
    proactive,
    routines: new RoutineStore(registry.db),
    inbox: new Inbox(registry.db),
    todos: new Todos(registry.db),
    ...sp,
    wiki: new WikiDocs(registry.db),
    tokens,
    apiBaseUrl: 'http://127.0.0.1:1',
    mcpServerPath: '/nonexistent/server.js',
    botOpenId: 'ou_bot',
    log,
    ...extraDeps,
  })
  return { cfg, registry, memory, messageCache, feishu, state, runtime, orchestrator, tokens, home, spaces: sp.spaces, inbox: new Inbox(registry.db), proactive }
}

/** 从 fake agent 记录的 mcpServers 里取出 capability token 并解开。 */
function capabilityOf(t: Awaited<ReturnType<typeof setup>>, sessionId: string) {
  const mcp = t.state.sessions.get(sessionId)?.mcpServers as { env: { name: string; value: string }[] }[]
  const token = mcp[0]?.env.find((e) => e.name === 'FRIDAY_CAP_TOKEN')?.value ?? ''
  return t.tokens.verify(token)
}

/** These protocol fixtures explicitly select the replied-to Work; a thread alias alone does not amend it. */
const amendRepliedWork: NonNullable<ConstructorParameters<typeof Orchestrator>[0]['ingressClassifier']> = {
  classify: async input => {
    const target = input.candidates.find(candidate => candidate.ref === input.message.replyToRef)
    return target ? { kind: 'amend', targetRef: target.ref } : { kind: 'work_request' }
  },
}

describe('Orchestrator end to end', () => {
  it('persists a new execution and replaces MCP credentials on each resumed turn without losing the conversation', async () => {
    const t = await setup(undefined, {}, false, { ingressClassifier: amendRepliedWork })
    t.feishu.members.set('oc_group', new Set(['ou_alice']))
    const first = msg()
    await t.orchestrator.handleMessage(first)
    const firstCap = capabilityOf(t, 'fake-session-1')!
    await t.orchestrator.handleMessage(msg({ text: '继续看刚才的结果', parentId: first.messageId, rootId: first.messageId, threadId: 'omt_topic1', mentions: [] }))
    const secondCap = capabilityOf(t, 'fake-session-1')!
    expect(firstCap.runId).toBeTruthy()
    expect(secondCap.runId).not.toBe(firstCap.runId)
    expect(secondCap.requesterOpenId).toBe('ou_alice')
    expect(t.state.sessions.get('fake-session-1')?.prompts).toHaveLength(2)
    expect(t.state.resumed).toEqual(['fake-session-1'])
    expect(t.registry.taskWork.get(2)?.key).toBe(t.registry.taskWork.get(1)?.key)
    expect(t.registry.db.prepare('SELECT id,state,acp_session_id FROM run_attempts ORDER BY started_at').all()).toEqual([
      expect.objectContaining({ id: firstCap.runId, state: 'completed', acp_session_id: 'fake-session-1' }),
      expect.objectContaining({ id: secondCap.runId, state: 'completed', acp_session_id: 'fake-session-1' }),
    ])
    expect(t.orchestrator.resolveActorForSession(firstCap.sessionKey)).toBeUndefined()
    await t.runtime.stop()
  })

  it('rejects a permission request from the old ACP while the next execution is closing it', async () => {
    const t = await setup(undefined, { FRIDAY_PERMISSION_POLICY: 'auto' })
    const first = msg()
    await t.orchestrator.handleMessage(first)
    let closing!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { closing = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const close = t.runtime.closeSession.bind(t.runtime)
    const spy = vi.spyOn(t.runtime, 'closeSession').mockImplementationOnce(async id => { closing(); await blocked; await close(id) })
    const next = t.orchestrator.handleMessage(msg({ text: '继续', rootId: first.messageId, threadId: 'omt_topic1', mentions: [] }))
    try {
      await entered
      const active = t.registry.db.prepare("SELECT acp_session_id FROM run_attempts WHERE state='running'").get()
      expect(active).toMatchObject({ acp_session_id: null })
      const result = await t.orchestrator.handlePermission({ sessionId: 'fake-session-1',
        toolCall: { toolCallId: 'old-call', title: 'Read old file', kind: 'read' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
      }, new AbortController().signal)
      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    } finally { release(); await next; spy.mockRestore(); await t.runtime.stop() }
    expect(t.registry.db.prepare("SELECT COUNT(*) AS n FROM run_attempts WHERE state='running'").get()?.n).toBe(0)
  })

  it('finishes the user execution before reflection, retaining its work and issuing a distinct runtime credential', async () => {
    const t = await setup(undefined, { FRIDAY_REFLECT: 'on' })
    await t.orchestrator.handleMessage(msg())
    const attempts = t.registry.db.prepare('SELECT id,work_key,stage,state,acp_session_id FROM run_attempts ORDER BY started_at').all()
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({ stage: 'task', state: 'completed' })
    expect(attempts[1]).toMatchObject({ stage: 'reflect', state: 'completed', work_key: attempts[0]!.work_key, acp_session_id: attempts[0]!.acp_session_id })
    const issued = t.state.allPrompts.map(prompt => t.tokens.verify((prompt.mcpServers as { env: { name: string; value: string }[] }[])[0]!.env.find(env => env.name === 'FRIDAY_CAP_TOKEN')!.value)!)
    expect(issued.map(cap => cap.runId)).toEqual(attempts.map(row => row.id))
    expect(t.feishu.answers()).toHaveLength(1)
    await t.runtime.stop()
  })

  it('caches its own final answer and app messages without triggering another task', async () => {
    const t = await setup()
    const first = msg()
    await t.orchestrator.handleMessage(first)
    const answer = t.feishu.of('replyMarkdown')[0]!
    const cached = t.messageCache.get(answer.messageId)
    expect(cached).toMatchObject({ chatId: 'oc_group', text: '这是假回答。', senderType: 'app', senderOpenId: 'ou_bot', threadId: 'omt_topic1', rootId: first.messageId })
    const appReply = msg({ senderType: 'app', senderOpenId: 'ou_other_bot', text: '构建已经恢复', mentions: [] })
    await t.orchestrator.handleMessage(appReply)
    expect(t.messageCache.get(appReply.messageId)?.text).toBe('构建已经恢复')
    expect(t.state.sessions.get('fake-session-1')?.prompts).toHaveLength(1)
    expect(t.feishu.recalled).toEqual([])
  })

  it('refreshes preferences and retrieved memories inside the same persistent discussion', async () => {
    const t = await setup(undefined, {}, false, { ingressClassifier: amendRepliedWork })
    t.feishu.members.set('oc_group', new Set(['ou_alice']))
    const first = msg()
    await t.orchestrator.handleMessage(first)
    const space = t.spaces.byChat('oc_group')!
    t.spaces.patchConfig(space.id, { notes: ['每次只列两个问题'], brevity: 'short' }, 'ou_alice')
    const note = t.memory.add({ scope: chatScope(t.registry.db, 'oc_group'), kind: 'fact', title: '验收规则', body: '发布必须提供验收编号' })
    await t.orchestrator.handleMessage(msg({ text: '验收规则', mentions: [], parentId: first.messageId, rootId: first.messageId, threadId: 'omt_topic1' }))
    const prompt = t.state.sessions.get('fake-session-1')?.prompts[1] ?? ''
    expect(prompt).toContain('每次只列两个问题')
    expect(prompt).toContain('发布必须提供验收编号')
    expect(t.state.sessions.size).toBe(1)
    const key = t.registry.resolveSession([`msg:${first.messageId}`])!.sessionKey
    expect(t.orchestrator.receiptOf(key)?.memory.notes.some((n) => n.id === note.id)).toBe(true)
    t.spaces.patchConfig(space.id, { notes: [], brevity: 'normal' }, 'ou_alice')
    await t.orchestrator.handleMessage(msg({ text: '继续', mentions: [], parentId: first.messageId, rootId: first.messageId, threadId: 'omt_topic1' }))
    expect(t.state.sessions.get('fake-session-1')?.prompts[2]).toContain('当前无额外偏好')
    expect(new Set([1, 2, 3].map(id => t.registry.taskWork.get(id)?.key)).size).toBe(1)
  })

  it('reports a truncated bootstrap thread instead of claiming full context', async () => {
    const t = await setup()
    t.feishu.threads.set('omt_long', Array.from({ length: 75 }, (_, i) => historyMsg({ messageId: `om_before_${i}`, text: `之前的讨论 ${i}`, createTimeMs: 100 + i, threadId: 'omt_long', chatId: 'oc_group' })))
    const first = msg({ threadId: 'omt_long', createTimeMs: 1000 })
    await t.orchestrator.handleMessage(first)
    const prompt = t.state.sessions.get('fake-session-1')?.prompts[0] ?? ''
    expect(prompt).toContain('话题历史已截断')
    expect(prompt).toContain('之前的讨论 74')
    expect(prompt).not.toContain('之前的讨论 14\n')
    const key = t.registry.resolveSession([`msg:${first.messageId}`])!.sessionKey
    expect(t.orchestrator.receiptOf(key)?.excluded.join(' ')).toContain('未完整读取')
  })

  it('enforces reflection restrictions before auto permission and narrows MCP routes during that phase', async () => {
    const phaseRoutes: (readonly string[] | undefined)[] = []
    let t: Awaited<ReturnType<typeof setup>>
    t = await setup([
      { kind: 'hook', run: () => { const session = t.registry.resolveSession([`msg:${first.messageId}`]); phaseRoutes.push(session ? t.orchestrator.allowedRoutesForSession(session.sessionKey) : undefined) } },
      { kind: 'permission', text: 'bash', toolKind: 'execute' },
      { kind: 'text', text: '结论已经完成。' },
    ], { FRIDAY_PERMISSION_POLICY: 'auto', FRIDAY_REFLECT: 'on', FRIDAY_REFLECT_MIN_CHARS: '1' })
    const first = msg()
    await t.orchestrator.handleMessage(first)
    expect(t.state.permissionDecisions).toEqual(['allow', 'reject'])
    expect(phaseRoutes[0]).toBeUndefined()
    expect(phaseRoutes[1]).toContain('POST /v1/memory/save')
    expect(phaseRoutes[1]).not.toContain('POST /v1/ability/settings')
    expect(phaseRoutes[1]).not.toContain('POST /v1/github/issue/open')
    expect(t.feishu.of('replyCard')).toHaveLength(0)
    expect(t.feishu.recalled).toEqual([])
  })

  it('uses the current group sender for authorization while keeping the ACP discussion', async () => {
    const actors: (string | undefined)[] = []
    let t: Awaited<ReturnType<typeof setup>>
    const first = msg()
    t = await setup([
      { kind: 'hook', run: () => { const key = t.registry.resolveSession([`msg:${first.messageId}`])!.sessionKey; actors.push(t.orchestrator.resolveActorForSession(key)?.requesterOpenId) } },
      { kind: 'text', text: '已完成' },
    ])
    await t.orchestrator.handleMessage(first)
    await t.orchestrator.handleMessage(msg({ text: '请继续', mentions: [], senderOpenId: 'ou_bob', threadId: 'omt_topic1' }))
    expect(actors).toEqual(['ou_alice', 'ou_bob'])
    expect(t.state.sessions.size).toBe(1)
    const key = t.registry.resolveSession([`msg:${first.messageId}`])!.sessionKey
    expect(t.orchestrator.resolveActorForSession(key)).toBeUndefined()
  })

  it('binds an approval-first topic so an unmentioned reply steers the same session', async () => {
    const t = await setup([{ kind: 'permission', text: 'bash', toolKind: 'execute' }, { kind: 'text', text: '旧答案' }])
    const first = msg()
    const running = t.orchestrator.handleMessage(first)
    await waitFor(() => t.orchestrator.pendingPermissionCount() === 1)
    const approval = t.feishu.of('replyCard')[0]!
    const key = t.registry.resolveSession([`msg:${first.messageId}`])!.sessionKey
    expect(t.registry.resolveSession(['thread:omt_topic1'])?.sessionKey).toBe(key)
    expect(t.registry.resolveSession([`msg:${approval.messageId}`])?.sessionKey).toBe(key)
    t.state.script = [{ kind: 'text', text: '按新要求完成' }]
    await t.orchestrator.handleMessage(msg({ text: '先别执行，换个要求', mentions: [], parentId: approval.messageId, threadId: 'omt_topic1' }))
    await running
    expect(t.registry.getTask(1)?.stopReason).toBe('steered')
    expect(t.state.sessions.size).toBe(1)
    expect(t.feishu.answers()).toEqual(['按新要求完成'])
    expect(t.feishu.recalled).toEqual([])
  })

  it('does not miss cancellation while sending an approval card', async () => {
    const t = await setup([{ kind: 'permission', text: 'bash', toolKind: 'execute' }, { kind: 'text', text: '旧答案' }], { FRIDAY_PERMISSION_TIMEOUT_MS: '60000' })
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    let sending = false
    const original = t.feishu.replyCard.bind(t.feishu)
    t.feishu.replyCard = async (...args) => { sending = true; await barrier; return original(...args) }
    const first = msg()
    const running = t.orchestrator.handleMessage(first)
    await waitFor(() => sending)
    t.state.script = [{ kind: 'text', text: '已按新要求继续' }]
    const next = t.orchestrator.handleMessage(msg({ text: '别执行，改一下', mentions: [], rootId: first.messageId }))
    release()
    await Promise.race([Promise.all([running, next]), new Promise((_, reject) => setTimeout(() => reject(new Error('missed abort during approval send')), 1500))])
    expect(t.orchestrator.pendingPermissionCount()).toBe(0)
    expect(t.registry.getTask(1)?.stopReason).toBe('steered')
    expect(t.feishu.answers()).toEqual(['已按新要求继续'])
  })

  it('scopes command and ability selfchecks, including for the administrator', async () => {
    const t = await setup(undefined, { FRIDAY_ADMINS: 'ou_alice' })
    for (const [sessionKey, chatId, chatType, requesterOpenId, prompt] of [
      ['diag-group', 'oc_group', 'group', 'ou_bob', '本群任务'],
      ['diag-other', 'oc_other', 'group', 'ou_alice', '别群秘密任务'],
      ['diag-private', 'oc_private', 'p2p', 'ou_alice', '私聊秘密任务'],
    ] as const) {
      t.registry.createSession({ sessionKey, chatId, chatType, requesterOpenId, cwd: t.home })
      const task = t.registry.createTask({ sessionKey, messageId: `om_${sessionKey}`, requesterOpenId, prompt })
      t.registry.updateTask(task.id, { status: 'failed', error: '测试失败', startedAt: Date.now() - 100, finishedAt: Date.now() })
    }
    await t.orchestrator.handleMessage(msg({ text: '@Friday /selfcheck' }))
    const command = t.feishu.answers().join(' ')
    expect(command).toContain('本群任务')
    expect(command).not.toContain('秘密任务')
    const ability = await t.orchestrator.abilities.selfcheck({ sessionKey: 'diag-group', chatId: 'oc_group', chatType: 'group', requesterOpenId: 'ou_alice' })
    expect(ability).toContain('本群任务')
    expect(ability).not.toContain('秘密任务')
    expect((await t.orchestrator.selfCheck({ withLessons: true })).lessons).toBe(false)
  })

  it('runs a group @mention: reactions and an answer as a plain message in the topic, memory note, thread alias', async () => {
    const t = await setup()
    const m = msg()
    await t.orchestrator.handleMessage(m)

    // 从未发送过程卡，也不调用撤回。
    expect(t.feishu.recalled).toHaveLength(0)
    expect(t.feishu.of('replyCard')).toHaveLength(0)
    // 答案是一条普通（富文本）消息，也回到同一个话题里；卡片里只剩折叠的过程
    const answers = t.feishu.of('replyMarkdown')
    expect(answers).toHaveLength(1)
    expect(answers[0]?.target).toBe(m.messageId)
    expect(answers[0]?.replyInThread).toBe(true)
    expect(String(answers[0]?.payload)).toBe('这是假回答。')
    // 答案本身留在群里，过程不留
    // 回复消息也指向这个会话（别人回复这条消息就是追问）
    expect(t.registry.resolveSession([`msg:${answers[0]?.messageId}`])?.sessionKey).toBe(t.registry.resolveSession([`msg:${m.messageId}`])?.sessionKey)

    const session = t.registry.resolveSession([`msg:${m.messageId}`])
    expect(session?.acpSessionId).toBe('fake-session-1')
    expect(session?.threadId).toBe('omt_topic1')
    expect(session?.turns).toBe(1)
    expect(t.registry.resolveSession(['thread:omt_topic1'])?.sessionKey).toBe(session?.sessionKey)

    const prompt = t.state.sessions.get('fake-session-1')?.prompts[0] ?? ''
    expect(prompt).toContain('总结一下最近的讨论')
    expect(prompt).toContain('新会话')
    expect(t.memory.count(chatScope(t.registry.db, 'oc_group'))).toBe(1)
    expect(t.memory.recent(chatScope(t.registry.db, 'oc_group'))[0]).toMatchObject({ kind: 'qa', status: 'candidate', confirmation: null, source: { generatedBy: 'automatic_qa', messageId: m.messageId } })
    expect(existsSync(join(session!.cwd, 'AGENTS.md'))).toBe(true)
    expect(readFileSync(join(session!.cwd, 'AGENTS.md'), 'utf8')).toContain('repos/deepseek-harness')
    const mcp = t.state.sessions.get('fake-session-1')?.mcpServers as { name: string; env: { name: string }[] }[]
    expect(mcp[0]?.name).toBe('friday-lark')
    expect(mcp[0]?.env.map((e) => e.name)).toEqual(['FRIDAY_API_URL', 'FRIDAY_CAP_TOKEN'])
  })

  it('accepts another member\'s reply in the same topic as a distinct Work with a new ACP', async () => {
    const t = await setup()
    const first = msg()
    await t.orchestrator.handleMessage(first)
    const followUp = msg({ text: '再细一点', mentions: [], threadId: 'omt_topic1', rootId: first.messageId, senderOpenId: 'ou_bob' })
    await t.orchestrator.handleMessage(followUp)
    expect(t.state.allPrompts.map(prompt => prompt.sessionId)).toEqual(['fake-session-1', 'fake-session-2'])
    const prompt = t.state.sessions.get('fake-session-2')?.prompts[0]
    expect(prompt).toContain('新会话')
    expect(prompt).toContain('再细一点')
    expect(t.registry.getTask(2)?.sessionKey).toBe(t.registry.getTask(1)?.sessionKey)
    expect(t.registry.taskWork.get(2)?.key).not.toBe(t.registry.taskWork.get(1)?.key)
    expect(t.state.sessions.size).toBe(1)
    // 两轮都没有发送或撤回过程消息
    expect(t.feishu.recalled).toHaveLength(0)
    expect(t.feishu.of('replyCard')).toHaveLength(0)
    expect(t.feishu.of('replyMarkdown')[1]?.replyInThread).toBe(false)
  })

  it('answers quick questions as a plain message only — no progress card at all', async () => {
    const t = await setup(undefined, { FRIDAY_PROGRESS_CARD_DELAY_MS: '5000' })
    const m = msg({ text: '@Friday hi' })
    await t.orchestrator.handleMessage(m)
    expect(t.feishu.of('replyCard')).toHaveLength(0)
    expect(t.feishu.of('patchCard')).toHaveLength(0)
    expect(t.feishu.answers()).toEqual(['这是假回答。'])
    // 话题绑定照样成立（第一条回复就是答案）
    expect(t.registry.resolveSession(['thread:omt_topic1'])?.sessionKey).toBe(t.registry.resolveSession([`msg:${m.messageId}`])?.sessionKey)
    expect(t.registry.getTask(1)?.cardMessageId).toBe(t.feishu.of('replyMarkdown')[0]?.messageId)
  })

  it('never sends or recalls process messages even after the legacy delay elapses', async () => {
    const t = await setup([{ kind: 'tool', text: '读取话题', toolKind: 'read' }, { kind: 'sleep', ms: 250 }, { kind: 'text', text: '慢答' }], { FRIDAY_PROGRESS_CARD_DELAY_MS: '60' })
    await t.orchestrator.handleMessage(msg())
    // 长任务也只发最终答案。
    expect(t.feishu.recalled).toHaveLength(0)
    expect(t.feishu.of('replyCard')).toHaveLength(0)
    expect(t.feishu.of('patchCard')).toHaveLength(0)
    expect(t.feishu.answers()).toEqual(['慢答'])
  })

  it('ignores group messages that neither mention the bot nor belong to a bound topic, but still caches them', async () => {
    const t = await setup()
    const chatter = msg({ text: '闲聊', mentions: [] })
    await t.orchestrator.handleMessage(chatter)
    await t.orchestrator.handleMessage(msg({ senderType: 'app' }))
    expect(t.feishu.sent).toHaveLength(0)
    expect(t.state.sessions.size).toBe(0)
    // 群聊记忆：没 @ 我的消息也进缓存，且带真实姓名与附件信息
    const cached = t.messageCache.get(chatter.messageId)
    expect(cached?.chatId).toBe('oc_group')
    expect(cached?.senderName).toBe('张三')
    await t.orchestrator.handleMessage(msg({ msgType: 'file', text: '[文件] 方案.pdf', fileKey: 'fk', fileName: '方案.pdf', mentions: [] }))
    expect(t.messageCache.files(['oc_group'])[0]?.fileName).toBe('方案.pdf')
  })

  it('uses real sender names in prompts, and does not cache DMs', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg())
    expect(t.state.sessions.get('fake-session-1')?.prompts[0]).toContain('发言人：张三')
    const dm = msg({ chatType: 'p2p', chatId: 'oc_p2p', text: '私下问一句', mentions: [] })
    await t.orchestrator.handleMessage(dm)
    expect(t.messageCache.get(dm.messageId)).toBeUndefined()
  })

  it('issues group tokens without cross-chat reading and DM tokens with it', async () => {
    const t = await setup()
    const g = msg()
    await t.orchestrator.handleMessage(g)
    const groupCap = capabilityOf(t, 'fake-session-1')
    expect(groupCap?.chatType).toBe('group')
    expect(groupCap?.scopes).not.toContain('chat:read-others')
    expect(groupCap?.cwd).toBe(t.registry.resolveSession([`msg:${g.messageId}`])?.cwd)
    expect(existsSync(join(groupCap!.cwd as string, 'downloads'))).toBe(true)
    await t.orchestrator.handleMessage(msg({ chatType: 'p2p', chatId: 'oc_p2p', text: '私聊', mentions: [] }))
    const dmCap = capabilityOf(t, 'fake-session-2')
    expect(dmCap?.chatType).toBe('p2p')
    expect(dmCap?.scopes).toContain('chat:read-others')
    expect(dmCap?.requesterOpenId).toBe('ou_alice')
  })

  it('respects the allowed chats list', async () => {
    const t = await setup(undefined, { FRIDAY_ALLOWED_CHATS: 'oc_other' })
    await t.orchestrator.handleMessage(msg())
    expect(t.feishu.sent).toHaveLength(0)
  })

  it('handles DMs on a per-user session without threads', async () => {
    const t = await setup(undefined, {}, false, { ingressClassifier: amendRepliedWork })
    const dm = msg({ chatType: 'p2p', chatId: 'oc_p2p', text: '帮我看看', mentions: [] })
    await t.orchestrator.handleMessage(dm)
    // 私聊直接发消息，不用"回复"（没有引用头）；答案是富文本
    expect(t.feishu.of('replyCard')).toHaveLength(0)
    expect(t.feishu.of('replyMarkdown')).toHaveLength(0)
    expect(t.feishu.of('sendToChat')[0]?.target).toBe('oc_p2p')
    expect(t.feishu.answers()).toEqual(['这是假回答。'])
    expect(t.registry.getSession('dm:ou_alice')?.acpSessionId).toBe('fake-session-1')
    await t.orchestrator.handleMessage(msg({ chatType: 'p2p', chatId: 'oc_p2p', text: '继续', parentId: dm.messageId, mentions: [] }))
    expect(t.state.sessions.get('fake-session-1')?.prompts).toHaveLength(2)
    expect(t.registry.taskWork.get(2)?.key).toBe(t.registry.taskWork.get(1)?.key)
    expect(t.memory.count(dmScope('ou_alice'))).toBe(2)
  })

  it('records each real request as a delegation input, marks it handled when its Run finishes, and refuses a cancelled delegation', async () => {
    const t = await setup(undefined, {}, false, { ingressClassifier: { classify: async input => input.message.replyToRef ? { kind: 'amend', targetRef: input.message.replyToRef } : { kind: 'new_work' } } })
    const first = msg({ chatType: 'p2p', chatId: 'oc_p2p', text: '帮我看看', mentions: [] })
    await t.orchestrator.handleMessage(first)
    const root = t.registry.taskForMessage(first.messageId)!, key = t.registry.taskWork.get(root.id)!.key
    expect(t.registry.workContexts.view(key)).toMatchObject({ lifecycle: 'open', activity: 'idle', inputSeq: 1, handledSeq: 1, pending: { inputs: 0 } })
    // A follow-up on a delegation cancelled by a host control is recorded as an input but refused at admission, not run.
    t.registry.workContexts.control(key, { action: 'cancel', causeRef: 'test:control' })
    const followup = msg({ chatType: 'p2p', chatId: 'oc_p2p', text: '再补充一点', mentions: [], parentId: first.messageId })
    await t.orchestrator.handleMessage(followup)
    const second = t.registry.taskForMessage(followup.messageId)!
    expect(t.registry.taskWork.get(second.id)?.key).toBe(key)
    expect(t.registry.getTask(second.id)).toMatchObject({ status: 'cancelled', stopReason: 'work_cancelled' })
    expect(t.state.sessions.get('fake-session-1')?.prompts).toHaveLength(1)
    expect(t.registry.workContexts.view(key)).toMatchObject({ lifecycle: 'cancelled', activity: 'idle', inputSeq: 2, handledSeq: 1 })
    expect(t.registry.db.prepare("SELECT COUNT(*) AS n FROM run_attempts WHERE work_key = ? AND state <> 'completed'").get(key)?.n).toBe(0)
  })

  it('answers /help and /tasks, and /new opens a fresh session', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg({ text: '@Friday !help' }))
    expect(cardText(t.feishu.of('replyCard')[0]?.payload as Record<string, unknown>)).toContain('使用说明')

    const first = msg()
    await t.orchestrator.handleMessage(first)
    await t.orchestrator.handleMessage(msg({ text: '@Friday !status session', threadId: 'omt_topic1' }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('已完成轮次：1')

    await t.orchestrator.handleMessage(msg({ text: '@Friday !restart 换个角度总结', threadId: 'omt_topic1' }))
    expect(t.state.sessions.size).toBe(1) // 旧的被 close，新的建出来
    expect([...t.state.sessions.keys()]).toEqual(['fake-session-2'])
    expect(t.registry.resolveSession(['thread:omt_topic1'])?.acpSessionId).toBe('fake-session-2')
    expect(t.state.sessions.get('fake-session-2')?.prompts[0]).toContain('换个角度总结')
  })

  it('auto-allows safe tool kinds and asks via card for execute in safe policy', async () => {
    const t = await setup([
      { kind: 'permission', text: 'grep', toolKind: 'search' },
      { kind: 'permission', text: 'bash', toolKind: 'execute' },
      { kind: 'text', text: 'ok' },
    ])
    const m = msg()
    const run = t.orchestrator.handleMessage(m)
    // 等权限卡片出现，再模拟点击"允许"
    await waitFor(() => t.feishu.sent.some((s) => JSON.stringify(s.payload).includes('"action":"perm"')))
    const permCard = t.feishu.sent.find((s) => JSON.stringify(s.payload).includes('"action":"perm"'))!
    const requestId = JSON.stringify(permCard.payload).match(/"request_id":"([^"]+)"/)?.[1]
    expect(requestId).toBeTruthy()
    const toast = await t.orchestrator.handleCardAction({ value: { action: 'perm', request_id: requestId, decision: 'allow' }, operatorOpenId: 'ou_alice', raw: {} })
    expect(JSON.stringify(toast)).toContain('已允许')
    await run
    expect(t.state.permissionDecisions).toEqual(['allow', 'allow'])
    const patched = t.feishu.of('patchCard').find((p) => p.target === permCard.messageId)
    expect(cardText(patched?.payload as Record<string, unknown>)).toContain('已允许')
    expect(JSON.stringify(await t.orchestrator.handleCardAction({ value: { action: 'perm', request_id: requestId, decision: 'allow' }, operatorOpenId: 'ou_alice', raw: {} }))).toContain('处理过')
  })

  it('handles a dsh-style bare escalation: finds the command by toolCallId, gates the click to the requester', async () => {
    const t = await setup([
      { kind: 'permission', text: 'bash', bare: true, rawInput: { command: 'grep -rn session repos/dsh/src', description: 'Search session code', sandbox_permissions: 'danger-full-access', justification: 'sandbox backend unavailable' } },
      { kind: 'text', text: 'ok' },
    ])
    const m = msg()
    const run = t.orchestrator.handleMessage(m)
    await waitFor(() => t.feishu.sent.some((s) => JSON.stringify(s.payload).includes('"action":"perm"')))
    const permCard = t.feishu.sent.find((s) => JSON.stringify(s.payload).includes('"action":"perm"'))!
    const text = cardText(permCard.payload as Record<string, unknown>)
    expect(text).toContain('执行命令')
    expect(text).toContain('grep -rn session repos/dsh/src')
    expect(text).toContain('danger-full-access')
    expect(text).toContain('sandbox backend unavailable')
    expect(text).toContain('由 张三 确认')
    // 等待反馈使用表情，只有一张需要操作的确认卡。
    expect(t.feishu.of('replyCard')).toHaveLength(1)
    const requestId = JSON.stringify(permCard.payload).match(/"request_id":"([^"]+)"/)?.[1]
    // 群里别人点"允许"不算
    const other = await t.orchestrator.handleCardAction({ value: { action: 'perm', request_id: requestId, decision: 'allow' }, raw: {}, operatorOpenId: 'ou_bob' })
    expect(JSON.stringify(other)).toContain('只有发起人')
    expect(t.state.permissionDecisions).toEqual([])
    const mine = await t.orchestrator.handleCardAction({ value: { action: 'perm', request_id: requestId, decision: 'allow' }, raw: {}, operatorOpenId: 'ou_alice' })
    expect(JSON.stringify(mine)).toContain('已允许')
    await run
    expect(t.state.permissionDecisions).toEqual(['allow'])
    expect(t.feishu.answers()).toEqual(['ok'])
    // 命令在跑的时候就显示在进度卡上（跑完卡会撤掉，所以查的是过程中的 patch）
    expect(t.feishu.recalled).toHaveLength(0)
    expect(t.feishu.of('replyCard')).toHaveLength(1)
  })

  it('sends only the actionable approval card, including when legacy progress is delayed', async () => {
    const t = await setup(
      [{ kind: 'permission', text: 'bash', bare: true, rawInput: { command: 'ls', sandbox_permissions: 'danger-full-access', justification: 'x' } }, { kind: 'text', text: 'ok' }],
      { FRIDAY_PROGRESS_CARD_DELAY_MS: '60000', FRIDAY_PERMISSION_TIMEOUT_MS: '150' },
    )
    await t.orchestrator.handleMessage(msg())
    const perm = t.feishu.sent.find((s) => JSON.stringify(s.payload).includes('"action":"perm"'))
    expect(perm).toBeTruthy()
    expect(t.feishu.of('replyCard')).toHaveLength(1)
    expect(t.feishu.recalled).toHaveLength(0)
    expect(t.feishu.of('patchCard').every((p) => p.target === perm?.messageId)).toBe(true)

  })

  it('auto-allows escalations for trusted requesters and still denies unknown-session requests', async () => {
    const t = await setup(
      [
        { kind: 'permission', text: 'bash', bare: true, rawInput: { command: 'ls', sandbox_permissions: 'danger-full-access', justification: 'x' } },
        { kind: 'permission', text: 'write', bare: true, rawInput: { file_path: '/tmp/out.md', content: 'hi', sandbox_permissions: 'danger-full-access', justification: 'y' } },
        { kind: 'text', text: 'done' },
      ],
      { FRIDAY_TRUSTED_USERS: 'ou_alice, ou_zoe' },
    )
    await t.orchestrator.handleMessage(msg())
    expect(t.state.permissionDecisions).toEqual(['allow', 'allow'])
    expect(t.feishu.sent.some((s) => JSON.stringify(s.payload).includes('"action":"perm"'))).toBe(false)
    expect(t.feishu.of('replyCard')).toHaveLength(0)
    expect(t.feishu.recalled).toHaveLength(0)
    expect(t.feishu.answers()).toEqual(['done'])

    const u = await setup([{ kind: 'permission', text: 'bash', bare: true, rawInput: { command: 'ls' } }, { kind: 'text', text: 'end' }], { FRIDAY_TRUSTED_USERS: 'ou_zoe' })
    await u.orchestrator.handleMessage(msg({ senderOpenId: 'ou_bob' }))
    // 不可信的发起人：发卡片，2s 超时后按拒绝
    expect(u.feishu.sent.some((s) => JSON.stringify(s.payload).includes('"action":"perm"'))).toBe(true)
    expect(u.state.permissionDecisions).toEqual(['reject'])
  }, 15_000)

  it('denies on permission timeout and with deny policy', async () => {
    const t = await setup([{ kind: 'permission', text: 'bash', toolKind: 'execute' }, { kind: 'text', text: 'end' }], { FRIDAY_PERMISSION_TIMEOUT_MS: '150' })
    await t.orchestrator.handleMessage(msg())
    expect(t.state.permissionDecisions).toEqual(['reject'])
    expect(t.feishu.answers().join('\n')).toContain('操作未获批准')

    const d = await setup([{ kind: 'permission', text: 'bash', toolKind: 'execute' }, { kind: 'text', text: 'end' }], { FRIDAY_PERMISSION_POLICY: 'deny' })
    await d.orchestrator.handleMessage(msg())
    expect(d.state.permissionDecisions).toEqual(['reject'])
    expect(d.feishu.sent.some((s) => JSON.stringify(s.payload).includes('"action":"perm"'))).toBe(false)
  })

  it('!whoami tells the requester their open_id and trust status', async () => {
    const t = await setup(undefined, { FRIDAY_TRUSTED_USERS: 'ou_alice' })
    await t.orchestrator.handleMessage(msg({ text: '@Friday !whoami' }))
    const reply = t.feishu.of('replyText').at(-1)
    expect(String((reply?.payload as { text?: string })?.text ?? JSON.stringify(reply?.payload))).toContain('ou_alice')
    expect(JSON.stringify(reply?.payload)).toContain('可信用户：是')
    expect(t.state.sessions.size).toBe(0) // 命令不进模型
  })

  it('bot menu: my tasks / watched / memory / settings answer in the DM', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg({ chatType: 'p2p', chatId: 'oc_p2p', text: '帮我看看', mentions: [] }))
    for (const key of ['my_tasks', 'watched', 'memory', 'settings', 'help', 'nope']) await t.orchestrator.handleMenu({ eventKey: key, operatorOpenId: 'ou_alice', raw: {} })
    const dms = t.feishu.of('sendToUser')
    expect(dms.length).toBe(7) // 第一条是初次见面的自我介绍卡片
    const texts = dms.map((d) => JSON.stringify(d.payload))
    expect(texts[0]).toContain('就位了')
    expect(texts[0]).toContain('只有你能看到')
    // Nothing running is simply not mentioned; no symbols a person has to decode.
    expect(texts[1]).not.toContain('进行中')
    expect(texts[1]).toContain('提醒和定时任务：没有')
    expect(texts[1]).not.toMatch(/[⏳▫️⚠]/u)
    expect(texts[2]).toContain('还没有盯任何群')
    expect(texts[2]).toContain('帮我盯着 xx 群') // 不指定话题也能用
    expect(texts[2]).toContain('markdown') // 带 ** 的正文必须走 markdown，不然人看到一堆星号
    // The menu's memory view lists only what Friday remembers about the person; the automatic note of that one-off
    // question is Friday's own and is not shown, and there are no ids, kinds or counts to decode.
    expect(texts[3]).toContain('我还没有记住关于你的事')
    expect(texts[3]).not.toMatch(/#\d|\[qa|\[lesson|条，可改|工具笔记|不可核验/)
    expect(texts[3]).toContain('markdown')
    expect(texts[4]).toContain('ou_alice')
    expect(texts[5]).toContain('使用说明')
    expect(texts[6]).toContain('还没接上')
    await t.orchestrator.handleMenu({ eventKey: 'settings', raw: {} }) // 没有 open_id：忽略
    expect(t.feishu.of('sendToUser').length).toBe(7)
    // 重开会话：私聊会话归档，下一条消息开新 dsh 会话
    await t.orchestrator.handleMenu({ eventKey: 'restart', operatorOpenId: 'ou_alice', raw: {} })
    expect(JSON.stringify(t.feishu.of('sendToUser').at(-1)?.payload)).toContain('已重开')
    await t.orchestrator.handleMessage(msg({ chatType: 'p2p', chatId: 'oc_p2p', text: '再来', mentions: [] }))
    expect(t.registry.resolveSession(['dm:ou_alice'])?.acpSessionId).toBe('fake-session-2')
    await t.orchestrator.handleMenu({ eventKey: 'connect', operatorOpenId: 'ou_alice', raw: {} })
    expect(JSON.stringify(t.feishu.of('sendToUser').at(-1)?.payload)).toContain('没有开启个人授权')
  })

  it.each(['error', 'empty'])('group connection reports %s delivery honestly and offers a personal retry', async failure => {
    const t = await setup()
    const card = { synthetic_private_authorization: 'ONLY_IN_DM' }
    vi.spyOn(t.orchestrator as unknown as { connectCard(openId: string): object }, 'connectCard').mockReturnValue(card)
    const send = vi.spyOn(t.feishu, 'sendToUser')
    if (failure === 'error') send.mockRejectedValueOnce(new Error('synthetic network outage'))
    else send.mockResolvedValueOnce('')
    await t.orchestrator.handleMessage(msg({ text: '@Friday !connect' }))
    const shared = JSON.stringify(t.feishu.of('replyCard').at(-1)?.payload)
    expect(shared).toContain('retry_personal_connect')
    expect(shared).toContain('没有取得授权卡的送达回执')
    expect(shared).not.toContain('ONLY_IN_DM')
    expect(t.feishu.answers().join('\n')).not.toContain('授权卡已发到')
    send.mockResolvedValueOnce('om_actual_receipt')
    const response = await t.orchestrator.handleCardAction({ operatorOpenId: 'ou_bob', chatId: 'oc_group', messageId: 'om_retry',
      value: { action: 'retry_personal_connect', openId: 'ou_alice' }, raw: {} })
    expect(send).toHaveBeenLastCalledWith('ou_bob', { card })
    expect(response).toMatchObject({ toast: { type: 'success' } })
  })

  it('!circle join makes the prompt list the sibling groups', async () => {
    const t = await setup()
    t.feishu.chats = [
      { chatId: 'oc_group', name: '研发群' },
      { chatId: 'oc_prod', name: '产品群' },
    ]
    t.spaces.ensure({ kind: 'group', chatId: 'oc_prod', openId: 'ou_alice' })
    await t.orchestrator.handleMessage(msg({ text: '@Friday !circle' }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('不在任何联盟')
    await t.orchestrator.handleMessage(msg({ text: '@Friday !circle join bad/name' }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('联盟名')
    await t.orchestrator.handleMessage(msg({ text: '@Friday !circle join harness' }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('harness')
    await t.orchestrator.handleMessage(msg({ chatId: 'oc_prod', text: '@Friday !circle join harness' }))
    await t.orchestrator.handleMessage(msg())
    const prompt = t.state.sessions.get('fake-session-1')?.prompts[0] ?? ''
    expect(prompt).toContain('联盟：「harness」')
    expect(prompt).toContain('产品群（chat_id=oc_prod）')
    await t.orchestrator.handleMessage(msg({ text: '@Friday !circle leave' }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('退出')
    expect(t.state.sessions.size).toBe(1)
  })

  it('!circle join 只有空间负责人能改，普通成员被挡下', async () => {
    const t = await setup()
    // 第一个说话的人成为负责人
    await t.orchestrator.handleMessage(msg({ text: '@Friday !circle' }))
    await t.orchestrator.handleMessage(msg({ text: '@Friday !circle join harness', senderOpenId: 'ou_bob' }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('空间负责人')
    await t.orchestrator.handleMessage(msg({ text: '@Friday !circle join harness' }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('harness')
  })

  it('迁移过来的空间没有负责人时，第一个说话的人接管', async () => {
    const t = await setup()
    // 模拟迁移：空间已存在但没有 owner
    const { Spaces } = await import('../src/core/space.js')
    const spaces = new Spaces(t.registry.db)
    const pre = spaces.ensure({ kind: 'group', chatId: 'oc_legacy' })
    expect(spaces.owners(pre.id)).toEqual([])
    await t.orchestrator.handleMessage(msg({ chatId: 'oc_legacy', text: '@Friday !space', senderOpenId: 'ou_bob' }))
    expect(spaces.owners(pre.id)).toEqual(['ou_bob'])
    // 后来的人只是成员
    await t.orchestrator.handleMessage(msg({ chatId: 'oc_legacy', text: '@Friday !space' }))
    expect(spaces.roleOf(pre.id, 'ou_alice')).toBe('member')
  })

  it('!space 显示空间身份与配置，负责人可以改行为偏好并进入提示词', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg({ text: '@Friday !space' }))
    const info = JSON.stringify(t.feishu.of('replyCard').at(-1)?.payload)
    expect(info).toContain('Friday · 本群功能')
    expect(info).toContain('自动保存')
    // 成员改不了配置
    await t.orchestrator.handleMessage(msg({ text: '@Friday !space set brevity short', senderOpenId: 'ou_bob' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('空间负责人')
    // 负责人可以
    await t.orchestrator.handleMessage(msg({ text: '@Friday !space set brevity short' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('简短')
    await t.orchestrator.handleMessage(msg({ text: '@Friday !space note 这个群攒一批再处理' }))
    await t.orchestrator.handleMessage(msg({ text: '@Friday !space set reflect off' }))
    await t.orchestrator.handleMessage(msg({ text: '@Friday 看看' }))
    const prompt = t.state.sessions.get('fake-session-1')?.prompts[0] ?? ''
    expect(prompt).toContain('[本空间当前行为偏好')
    expect(prompt).toContain('这个群攒一批再处理')
    expect(prompt).toContain('默认简短')
    // reflect 关了就不追加整理那一轮
    expect(t.state.sessions.get('fake-session-1')?.prompts).toHaveLength(1)
    // 行为偏好能删
    await t.orchestrator.handleMessage(msg({ text: '@Friday !space note rm 1' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('已删掉')
  })

  it('!space rebind 在迁移未实现前保留原绑定与资料，不声称已经搬完', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg({ text: '@Friday !space note 小群里调教的偏好' }))
    const original = t.spaces.byChat('oc_group')!
    const scope = chatScope(t.registry.db, 'oc_group')
    t.memory.add({ scope, kind: 'rule', title: '发布前先跑冒烟', body: 'x' })
    await t.orchestrator.handleMessage(msg({ text: '@Friday !space rebind oc_real' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('尚未换绑')
    expect(t.spaces.byChat('oc_group')?.id).toBe(original.id)
    expect(t.spaces.byChat('oc_real')).toBeUndefined()
    await t.orchestrator.handleMessage(msg({ chatId: 'oc_real', text: '@Friday !space' }))
    const info = JSON.stringify(t.feishu.of('replyCard').at(-1)?.payload)
    expect(info).not.toContain('小群里调教的偏好')
    expect(t.memory.count(chatScope(t.registry.db, 'oc_real'))).toBe(0)
    expect(t.memory.count(scope)).toBe(1)
    expect(t.spaces.byChat('oc_group')?.config.notes).toEqual(['小群里调教的偏好'])
  })

  it('memory menu shows what Friday remembers about the person in plain words, and leaves out its own work notes', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg({ chatType: 'p2p', chatId: 'oc_p2p', text: '帮我看看', mentions: [] }))
    const scope = chatScope(t.registry.db, 'oc_p2p')
    t.memory.add({ scope, kind: 'rule', title: '个人偏好', body: '我习惯周五下午写周报，周五上午不要给我安排别的事', ...confirmedMemory })
    t.memory.add({ scope, kind: 'profile', title: '负责 Friday 的发布', body: '从聊天里看出来的' })
    t.memory.add({ scope, kind: 'lesson', title: '缺个人授权时用 friday_connect_account 发卡', body: '工具经验' })
    await t.orchestrator.handleMenu({ eventKey: 'memory', operatorOpenId: 'ou_alice', raw: {} })
    const text = String((t.feishu.of('sendToUser').at(-1)?.payload as { markdown?: string })?.markdown)
    // The saved preference shows the person's own sentence, not its label.
    expect(text).toContain('**你让我记住的**')
    expect(text).toContain('我习惯周五下午写周报，周五上午不要给我安排别的事')
    expect(text).not.toContain('个人偏好')
    expect(text).toContain('**我从聊天里推断、还没确认的**')
    expect(text).toContain('负责 Friday 的发布')
    // Friday's own work notes, ids, kinds and hidden counts are not the person's business here.
    expect(text).not.toContain('friday_connect_account')
    expect(text).not.toMatch(/#\d|\[(?:rule|profile|lesson|qa)|条，可改|工具笔记|不可核验/)
    expect(text).toContain('忘掉周报那条')
  })

  it('!memory lists layers with ids, !forget deletes within scope, share promotes to circle/org', async () => {
    const t = await setup(undefined, { FRIDAY_TRUSTED_USERS: 'ou_alice' })
    t.spaces.ensure({ kind: 'group', chatId: 'oc_other', openId: 'ou_alice' })
    t.memory.add({ scope: chatScope(t.registry.db, 'oc_group'), kind: 'rule', title: '本群回复用英文', body: '本群回复用英文', ...confirmedMemory })
    t.memory.add({ scope: 'org', kind: 'fact', title: '公司统一用 GitLab 内网', body: 'gitlab.example.com' })
    await t.orchestrator.handleMessage(msg({ text: '@Friday !memory' }))
    const text = String(t.feishu.of('replyMarkdown').at(-1)?.payload)
    expect(text).toContain('**企业**（1 条，只读）')
    expect(text).toContain('**本空间**（1 条，可改）')
    expect(text).toContain('#1 常驻要求：本群回复用英文')
    // 只有本层能删
    await t.orchestrator.handleMessage(msg({ chatId: 'oc_other', text: '@Friday !forget 1' }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('没有编号 1')
    // 晋升：不在联盟里不能 share circle；管理员可以 share org；非管理员不行
    await t.orchestrator.handleMessage(msg({ text: '@Friday !memory share 1 circle' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('不在任何联盟')
    await t.orchestrator.handleMessage(msg({ text: '@Friday !memory share 1 org', senderOpenId: 'ou_bob' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('全局管理员')
    await t.orchestrator.handleMessage(msg({ text: '@Friday !memory share 1 org' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('共享到企业')
    expect(t.memory.rules('org').map((n) => n.title)).toEqual(['本群回复用英文'])
    expect(t.memory.rules('org')[0]?.source).toMatchObject({ promotedFrom: chatScope(t.registry.db, 'oc_group'), noteId: 1, by: 'ou_alice' })
    const sharedRule = t.memory.rules('org')[0]!
    expect(t.memory.getProvenance(sharedRule.id)).toMatchObject({ state: 'legacy_unverified', ancestors: [{ id: 1, revision: 1 }] })
    // 再晋升一次不重复
    await t.orchestrator.handleMessage(msg({ text: '@Friday !memory share 1 org' }))
    expect(t.memory.rules('org')).toHaveLength(1)
    await t.orchestrator.handleMessage(msg({ text: '@Friday !forget 1' }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('已删除记忆 #1')
    expect(t.memory.count(chatScope(t.registry.db, 'oc_group'))).toBe(0)
    expect(t.memory.getProvenance(sharedRule.id)).toMatchObject({ state: 'unavailable', ancestors: [{ id: 1, revision: 1 }] })
    expect(t.registry.db.prepare('SELECT id, body, revision FROM memory_notes WHERE id = ?').get(sharedRule.id))
      .toMatchObject({ id: sharedRule.id, body: sharedRule.body, revision: 2 })
    expect(t.memory.rules('org')).toEqual([])
    expect(t.state.sessions.size).toBe(0)
    // 忘记原条目后，新会话不重新注入仍保留的企业副本；这不证明旧 ACP 历史已清除。
    await t.orchestrator.handleMessage(msg())
    const prompt = t.state.sessions.get('fake-session-1')?.prompts[0] ?? ''
    expect(prompt).not.toContain('[常驻要求（企业）')
    expect(prompt).not.toContain('本群回复用英文')
  })

  it('reports a conflicting pre-C1 memory share without duplicating it or returning a generic failure', async () => {
    const t = await setup(undefined, { FRIDAY_TRUSTED_USERS: 'ou_alice' })
    const here = chatScope(t.registry.db, 'oc_group')
    const original = t.memory.add({ scope: here, kind: 'rule', title: '原要求', body: '原要求', ...confirmedMemory })
    t.registry.db.prepare(`INSERT INTO memory_notes (scope, session_key, kind, title, body, created_at, status, source, confirmation)
      VALUES ('org', NULL, 'rule', '旧分享', '不同的已有内容', 1, 'confirmed', ?, ?)`)
      .run(JSON.stringify({ promotedFrom: here, noteId: original.id, by: 'ou_alice' }), JSON.stringify(original.confirmation))
    new ChannelMemory(t.registry.db) // 补齐旧行 legacy 元数据，不造来源或 created 事件。
    const before = t.registry.db.prepare('SELECT * FROM memory_notes ORDER BY id').all()
    await t.orchestrator.handleMessage(msg({ text: `@Friday !memory share ${original.id} org` }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('已有这条记忆的分享记录，但内容或状态不同')
    expect(t.registry.db.prepare('SELECT * FROM memory_notes ORDER BY id').all()).toEqual(before)
    expect(t.memory.count('org')).toBe(1)
    expect(t.state.allPrompts).toHaveLength(0)
  })

  it('candidate memories are marked, confirmable, and supersede chains hide the old note', async () => {
    const t = await setup()
    t.feishu.members.set('oc_group', new Set(['ou_alice']))
    const a = t.memory.add({ scope: chatScope(t.registry.db, 'oc_group'), kind: 'fact', title: '发布日期是 9/20', body: '排期', status: 'candidate' })
    await t.orchestrator.handleMessage(msg({ text: '@Friday !memory candidates' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain(`#${a.id} [fact] 发布日期是 9/20`)
    const b = t.memory.add({ scope: chatScope(t.registry.db, 'oc_group'), kind: 'fact', title: '发布日期改到 9/25', body: '延期', replaces: a.id })
    expect(t.memory.get(a.id)?.status).toBe('superseded')
    expect(t.memory.get(a.id)?.supersededBy).toBe(b.id)
    expect(t.memory.search(chatScope(t.registry.db, 'oc_group'), '发布日期').map((n) => n.id)).toEqual([b.id])
    expect(t.memory.count(chatScope(t.registry.db, 'oc_group'))).toBe(1)
    await t.orchestrator.handleMessage(msg({ text: `@Friday !memory confirm ${b.id}` }))
    // The command first shows the exact full version as a card; replying to that card confirms it.
    expect(t.memory.get(b.id)?.status).toBe('candidate')
    const display = t.feishu.of('replyCard').at(-1)!
    await t.orchestrator.handleMessage(msg({ text: `@Friday !memory confirm ${b.id}`, parentId: display.messageId }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('已记住')
    expect(t.memory.get(b.id)?.confirmation).toMatchObject({ by: 'ou_alice', messageId: expect.any(String) })
    const c = t.memory.add({ scope: chatScope(t.registry.db, 'oc_group'), kind: 'decision', title: '待确认的决定', body: 'x', status: 'candidate' })
    await t.orchestrator.handleMessage(msg({ text: `@Friday !memory confirm ${c.id}` }))
    const nextDisplay = t.feishu.of('replyCard').at(-1)!
    await t.orchestrator.handleMessage(msg({ text: `@Friday !memory confirm ${c.id}`, parentId: nextDisplay.messageId }))
    expect(t.memory.get(c.id)?.status).toBe('confirmed')
  })

  it('runs a reflection turn after substantive answers (same dsh session, nothing sent to the chat)', async () => {
    const t = await setup(undefined, { FRIDAY_REFLECT: 'on' })
    await t.orchestrator.handleMessage(msg())
    const prompts = t.state.sessions.get('fake-session-1')?.prompts ?? []
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('[轮末整理')
    expect(t.feishu.answers()).toEqual(['这是假回答。']) // 整理轮的输出不发人
    expect(t.registry.getSession(t.registry.resolveSession(['thread:omt_topic1'])!.sessionKey)?.status).toBe('idle')
    // 快答（没用工具、很短）不做整理
    const q = await setup([{ kind: 'text', text: '在' }], { FRIDAY_REFLECT: 'on' })
    await q.orchestrator.handleMessage(msg({ text: '@Friday 在吗' }))
    expect(q.state.sessions.get('fake-session-1')?.prompts).toHaveLength(1)
  })

  it('downloads an inbound image into its message directory with source metadata', async () => {
    const t = await setup()
    const inbound = msg({ chatType: 'p2p', chatId: 'oc_p2p', msgType: 'image', text: '[图片]', imageKey: 'img_1', mentions: [] })
    await t.orchestrator.handleMessage(inbound)
    const prompt = t.state.sessions.get('fake-session-1')?.prompts[0] ?? ''
    expect(prompt).toContain('read_image')
    const relative = prompt.match(/downloads\/[a-f0-9]{64}\/files\/image\.png/)?.[0]
    expect(relative).toBeDefined()
    const cwd = capabilityOf(t, 'fake-session-1')!.cwd!
    expect(readFileSync(join(cwd, relative!), 'utf8')).toBe('fake content of img_1')
    expect(t.feishu.downloads[0]).toMatchObject({ messageId: inbound.messageId, fileKey: 'img_1', type: 'image' })
    const source = JSON.parse(readFileSync(join(cwd, relative!, '../../source.json'), 'utf8'))
    expect(source).toMatchObject({ message_id: inbound.messageId, chat_id: 'oc_p2p', resource_type: 'image', file: 'files/image.png', coverage: 'unverified' })
  })

  it('automatically receives same-named logs from two group topics without mixing files or source records', async () => {
    const t = await setup()
    const first = msg({ messageId: 'om_first_deadbeef', threadId: 'thread-first', msgType: 'file', fileName: 'session-log.zip', fileKey: 'first-log', text: '请分析我上传的日志' })
    const second = msg({ messageId: 'om_second_deadbeef', threadId: 'thread-second', msgType: 'file', fileName: 'session-log.zip', fileKey: 'second-log', text: '请分析这个话题的日志' })
    await t.orchestrator.handleMessage(first)
    await t.orchestrator.handleMessage(second)
    const prompts = [...t.state.sessions.values()].flatMap((session) => session.prompts)
    expect(prompts).toHaveLength(2)
    const paths = prompts.map((prompt) => prompt.match(/downloads\/[a-f0-9]{64}\/files\/session-log\.zip/)?.[0])
    expect(paths.every(Boolean)).toBe(true)
    expect(paths[0]).not.toBe(paths[1])
    const cwd = t.orchestrator.prepareWorkspace('oc_group', 'group', 'ou_alice')
    expect(readFileSync(join(cwd, paths[0]!), 'utf8')).toBe('fake content of first-log')
    expect(readFileSync(join(cwd, paths[1]!), 'utf8')).toBe('fake content of second-log')
    for (const [index, inbound] of [first, second].entries()) {
      const source = JSON.parse(readFileSync(join(cwd, paths[index]!, '../../source.json'), 'utf8'))
      expect(source).toMatchObject({ message_id: inbound.messageId, chat_id: inbound.chatId, thread_id: inbound.threadId, sender_open_id: 'ou_alice', coverage: 'unverified' })
      expect(prompts[index]).toContain('可读取并分析')
      expect(prompts[index]).not.toContain(paths[1 - index]!)
    }
    expect(t.feishu.downloads).toHaveLength(2)
  })

  it('keeps a submitted source.json payload separate from its source manifest and strips path components', async () => {
    const t = await setup()
    const inbound = msg({ msgType: 'file', fileName: '..\\outside/../source.json', fileKey: 'actual-json', text: '读取上传文件' })
    await t.orchestrator.handleMessage(inbound)
    const prompt = t.state.sessions.get('fake-session-1')?.prompts[0] ?? ''
    const relative = prompt.match(/downloads\/[a-f0-9]{64}\/files\/source\.json/)?.[0]
    expect(relative).toBeDefined()
    const cwd = capabilityOf(t, 'fake-session-1')!.cwd!
    expect(readFileSync(join(cwd, relative!), 'utf8')).toBe('fake content of actual-json')
    expect(JSON.parse(readFileSync(join(cwd, relative!, '../../source.json'), 'utf8'))).toMatchObject({ original_name: inbound.fileName, file: 'files/source.json' })
    expect(existsSync(join(cwd, 'outside'))).toBe(false)
  })

  it.each(['success', 'failure'] as const)('reads the current message source instead of trusting an old same-named file: %s', async (outcome) => {
    const t = await setup()
    const inbound = msg({ msgType: 'file', fileName: 'session-log.zip', fileKey: 'current-log', text: '分析我本次上传的日志' })
    const cwd = t.orchestrator.prepareWorkspace(inbound.chatId, inbound.chatType, inbound.senderOpenId)
    const sourceId = createHash('sha256').update(JSON.stringify([inbound.chatId, inbound.messageId])).digest('hex')
    const directory = join(cwd, 'downloads', sourceId)
    mkdirSync(join(directory, 'files'), { recursive: true })
    const oldFile = join(directory, 'files', 'session-log.zip')
    writeFileSync(oldFile, 'STALE_OTHER_CONTENT')
    if (outcome === 'failure') {
      t.feishu.downloadMessageResource = async (messageId, fileKey, type, dest) => {
        t.feishu.downloads.push({ messageId, fileKey, type, dest })
        writeFileSync(dest, 'PARTIAL_DOWNLOAD')
        throw new Error('synthetic download failure')
      }
    }
    await t.orchestrator.handleMessage(inbound)
    const prompt = t.state.sessions.get('fake-session-1')?.prompts[0] ?? ''
    expect(t.feishu.downloads).toHaveLength(1)
    expect(prompt).not.toContain('STALE_OTHER_CONTENT')
    expect(readdirSync(join(directory, 'files')).some((name) => name.startsWith('.receiving-'))).toBe(false)
    if (outcome === 'failure') {
      expect(prompt).toContain('本轮下载失败')
      expect(prompt).not.toContain('downloads/')
      expect(prompt).not.toContain('可读取并分析')
      expect(existsSync(join(directory, 'source.json'))).toBe(false)
      expect(readFileSync(oldFile, 'utf8')).toBe('STALE_OTHER_CONTENT')
    } else {
      expect(prompt).toContain(`downloads/${sourceId}/files/session-log.zip`)
      expect(readFileSync(oldFile, 'utf8')).toBe('fake content of current-log')
    }
  })

  it('keeps media download and current-message frame extraction available', async () => {
    const extract = vi.spyOn(frameTools, 'extractFrames').mockImplementation(async (_source, directory) => {
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'f01.png'), 'synthetic-frame')
      return { dir: directory, files: ['f01.png'], totalFrames: 4, durationSec: 1 }
    })
    try {
      const t = await setup()
      const inbound = msg({ msgType: 'media', fileName: 'demo.mp4', fileKey: 'current-video', text: '看看这个视频' })
      await t.orchestrator.handleMessage(inbound)
      const prompt = t.state.sessions.get('fake-session-1')?.prompts[0] ?? ''
      expect(t.feishu.downloads[0]).toMatchObject({ fileKey: 'current-video', type: 'file' })
      expect(extract).toHaveBeenCalledTimes(1)
      expect(extract.mock.calls[0]![0]).toMatch(/downloads\/[a-f0-9]{64}\/files\/demo\.mp4$/)
      expect(extract.mock.calls[0]![1]).toMatch(/downloads\/[a-f0-9]{64}\/frames\/[a-f0-9-]+$/)
      expect(prompt).toContain('视频')
      expect(prompt).toContain('f01.png')
      expect(prompt).toContain('source.json')
    } finally { extract.mockRestore() }
  })

  it('reminds due todos once, to the person or the group', async () => {
    const t = await setup()
    t.spaces.ensure({ kind: 'p2p', chatId: 'oc_p2p', openId: 'ou_alice' })
    t.feishu.members.set('oc_group', new Set(['ou_alice']))
    t.registry.createSession({ sessionKey: 'todo-origin', chatId: 'oc_group', chatType: 'group', requesterOpenId: 'ou_alice', cwd: '/synthetic' })
    const todos = new Todos(t.registry.db)
    const now = Date.now()
    todos.add({ scope: dmScope('ou_alice'), title: '交周报', dueMs: now + 3600_000, owner: '张三', createdBy: 'ou_alice' })
    todos.add({ scope: chatScope(t.registry.db, 'oc_group'), title: '发版', dueMs: now - 60_000, createdBy: 'ou_alice', sessionKey: 'todo-origin' })
    todos.add({ scope: chatScope(t.registry.db, 'oc_group'), title: '下周的事', dueMs: now + 3 * 86400_000 + 3600_000 })
    todos.add({ scope: chatScope(t.registry.db, 'oc_group'), title: '没有截止' })
    expect(await t.orchestrator.remindDueTodos()).toBe(2)
    const dm = t.feishu.of('sendToUser')[0]
    expect(dm?.target).toBe('ou_alice')
    expect(JSON.stringify(dm?.payload)).toContain('交周报')
    expect(JSON.stringify(dm?.payload)).toContain('截止（北京时间）')
    expect(JSON.stringify(dm?.payload)).not.toContain('明天到期')
    const group = t.feishu.of('sendToChat')[0]
    expect(group?.target).toBe('oc_group')
    expect(JSON.stringify(group?.payload)).toContain('已过期')
    expect(await t.orchestrator.remindDueTodos()).toBe(0) // 不重复
  })

  it('milestones (deadline / freeze / release) remind at 3d, 1d, 2h and once overdue, @ the owner, flag unconfirmed ones', async () => {
    const t = await setup()
    t.feishu.members.set('oc_group', new Set(['ou_alice']))
    t.registry.createSession({ sessionKey: 'todo-origin', chatId: 'oc_group', chatType: 'group', requesterOpenId: 'ou_alice', cwd: '/synthetic' })
    const todos = new Todos(t.registry.db)
    const now = Date.now()
    const due = now + 70 * 3600_000 // 70 小时后封版：已过 72h 节点
    const f = todos.add({ scope: chatScope(t.registry.db, 'oc_group'), kind: 'freeze', title: 'v1.2 封版', dueMs: due, owner: '张三', ownerOpenId: 'ou_alice', confirmed: false, createdBy: 'ou_alice', sessionKey: 'todo-origin' })
    expect(await t.orchestrator.remindDueTodos()).toBe(1)
    const first = String((t.feishu.of('sendToChat')[0]?.payload as { markdown: string }).markdown)
    expect(first).toContain('v1.2 封版')
    expect(first).toContain('截止（北京时间）')
    expect(first).toContain('<at open_id="ou_alice">张三</at>')
    expect(first).toContain('归属待核实')
    expect(todos.get(f.id)?.remindedStages).toEqual(['72h'])
    expect(await t.orchestrator.remindDueTodos()).toBe(0)
    // 确认后不再标待确认；改期后提醒节点重算
    todos.confirm(f.id, chatScope(t.registry.db, 'oc_group'))
    todos.update(f.id, chatScope(t.registry.db, 'oc_group'), { dueMs: now + 5 * 3600_000 })
    expect(todos.get(f.id)?.remindedStages).toEqual([])
    // 5 小时后到期：72h 和 24h 都已过 → 只按 24h 提醒一次，72h 作废
    expect(await t.orchestrator.remindDueTodos()).toBe(1)
    const second = JSON.stringify(t.feishu.of('sendToChat')[1]?.payload)
    expect(second).toContain('截止（北京时间）')
    expect(second).not.toContain('归属待核实')
    expect(todos.get(f.id)?.remindedStages?.sort()).toEqual(['24h', '72h'])
    expect(await t.orchestrator.remindDueTodos()).toBe(0)
    // 过期：再提醒一次，然后安静
    todos.update(f.id, chatScope(t.registry.db, 'oc_group'), { dueMs: now - 1000 })
    expect(await t.orchestrator.remindDueTodos()).toBe(1)
    expect(JSON.stringify(t.feishu.of('sendToChat')[2]?.payload)).toContain('已过期')
    expect(await t.orchestrator.remindDueTodos()).toBe(0)
    // 完成后不提醒
    todos.done(f.id, chatScope(t.registry.db, 'oc_group'))
    todos.update(f.id, chatScope(t.registry.db, 'oc_group'), { dueMs: now - 1000 })
    expect(await t.orchestrator.remindDueTodos()).toBe(0)
  })

  it('!restart in a DM retires the old session row and starts a fresh dsh session', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg({ chatType: 'p2p', chatId: 'oc_p2p', text: '第一轮', mentions: [] }))
    expect(t.registry.getSession('dm:ou_alice')?.acpSessionId).toBe('fake-session-1')
    await t.orchestrator.handleMessage(msg({ chatType: 'p2p', chatId: 'oc_p2p', text: '!restart', mentions: [] }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('已重开')
    const fresh = t.registry.resolveSession(['dm:ou_alice'])
    expect(t.registry.getSession('dm:ou_alice')?.status).toBe('archived')
    expect(fresh?.sessionKey).not.toBe('dm:ou_alice')
    expect(fresh?.status).toBe('idle')
    expect(fresh?.acpSessionId).toBeNull()
    await t.orchestrator.handleMessage(msg({ chatType: 'p2p', chatId: 'oc_p2p', text: '第二轮', mentions: [] }))
    expect(t.registry.resolveSession(['dm:ou_alice'])?.acpSessionId).toBe('fake-session-2')
    expect(t.state.sessions.has('fake-session-1')).toBe(false) // 旧的被 close
    // 带正文的 !restart：重开后直接跑
    await t.orchestrator.handleMessage(msg({ chatType: 'p2p', chatId: 'oc_p2p', text: '!restart 换个话题', mentions: [] }))
    expect(t.state.sessions.get('fake-session-3')?.prompts[0]).toContain('换个话题')
  })

  it('!stop cancels a running task', async () => {
    const t = await setup([{ kind: 'sleep', ms: 100 }, { kind: 'sleep', ms: 100 }, { kind: 'sleep', ms: 100 }, { kind: 'text', text: 'late' }])
    const first = msg()
    const run = t.orchestrator.handleMessage(first)
    await waitFor(() => (t.state.sessions.get('fake-session-1')?.prompts.length ?? 0) > 0)
    await t.orchestrator.handleMessage(msg({ text: '@Friday !stop', rootId: first.messageId }))
    await run
    expect(t.state.cancelled).toContain('fake-session-1')
    expect(t.feishu.of('replyText').some((m) => String(m.payload).includes('已请求中止'))).toBe(true)
    expect(t.feishu.of('replyCard')).toHaveLength(0)
    expect(t.registry.getTask(1)?.status).toBe('cancelled')
  })

  it('does not publish buffered draft text when the user stops a turn', async () => {
    let buffered = false
    const t = await setup([
      { kind: 'thought', text: '内部思考不应外发' },
      { kind: 'text', text: '尚未完成也未经核对的草稿' },
      { kind: 'hook', run: () => { buffered = true } },
      { kind: 'sleep', ms: 150 },
      { kind: 'text', text: '未执行的最后一句' },
    ])
    const first = msg()
    const run = t.orchestrator.handleMessage(first)
    await waitFor(() => buffered)
    await t.orchestrator.handleMessage(msg({ text: '@Friday !stop', rootId: first.messageId }))
    await run
    const sent = JSON.stringify(t.feishu.sent)
    expect(sent).not.toContain('内部思考不应外发')
    expect(sent).not.toContain('尚未完成也未经核对的草稿')
    expect(sent).not.toContain('未执行的最后一句')
    expect(t.feishu.of('replyCard')).toHaveLength(0)
    expect(t.feishu.recalled).toHaveLength(0)
    expect(t.registry.getTask(1)?.status).toBe('cancelled')
  })

  it('keeps raw runtime errors and unfinished text out of the failure reply', async () => {
    const t = await setup([
      { kind: 'text', text: '尚未核对的内部草稿' },
    ])
    const prompt = t.runtime.prompt.bind(t.runtime)
    t.runtime.prompt = async (...args) => {
      await prompt(...args)
      throw new Error('/private/example/session.log Authorization: Bearer TEST_SENTINEL')
    }
    await t.orchestrator.handleMessage(msg())
    const sent = JSON.stringify(t.feishu.sent)
    expect(sent).toContain('处理失败')
    expect(sent).not.toMatch(/任务\s*#\d+/)
    expect(sent).not.toContain('尚未核对的内部草稿')
    expect(sent).not.toContain('TEST_SENTINEL')
    expect(sent).not.toContain('/private/example')
    expect(t.feishu.of('replyCard')).toHaveLength(0)
    expect(t.feishu.recalled).toHaveLength(0)
    expect(t.registry.getTask(1)?.status).toBe('failed')
    expect(t.registry.getTask(1)?.error).toContain('TEST_SENTINEL')
  })

  it('an explicit amendment steers its running Work: current turn is cut, the next one continues with both', async () => {
    const t = await setup([{ kind: 'tool', text: '读取话题', toolKind: 'read' }, { kind: 'sleep', ms: 150 }, { kind: 'sleep', ms: 150 }, { kind: 'text', text: '晚到的答案' }],
      {}, false, { ingressClassifier: amendRepliedWork })
    t.feishu.members.set('oc_group', new Set(['ou_alice']))
    const first = msg()
    const run1 = t.orchestrator.handleMessage(first)
    await waitFor(() => (t.state.sessions.get('fake-session-1')?.prompts.length ?? 0) > 0)
    const second = msg({ text: '等等，看上周的就行', mentions: [], threadId: 'omt_topic1', rootId: first.messageId, parentId: first.messageId })
    const run2 = t.orchestrator.handleMessage(second)
    await Promise.all([run1, run2])
    // 第一轮被打断：不发答案、任务记为 steered、原消息上的"在做了"撤掉且不打 ✅
    expect(t.state.cancelled).toContain('fake-session-1')
    expect(t.registry.getTask(1)?.status).toBe('cancelled')
    expect(t.registry.getTask(1)?.stopReason).toBe('steered')
    expect(t.feishu.reactionsOn(first.messageId)).toEqual([])
    expect(t.feishu.recalled).toHaveLength(0)
    expect(t.feishu.of('replyCard')).toHaveLength(0)
    // 第二轮在同一个 dsh 会话里跑，提示词带插话说明，只发一条答案
    const prompts = t.state.sessions.get('fake-session-1')?.prompts ?? []
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('[任务补充]')
    expect(prompts[1]).toContain('总结一下最近的讨论')
    expect(prompts[1]).toContain('等等，看上周的就行')
    expect(t.feishu.answers()).toEqual(['晚到的答案'])
    expect(t.registry.getTask(2)?.status).toBe('done')
    expect(t.registry.taskWork.get(2)?.key).toBe(t.registry.taskWork.get(1)?.key)
    expect(t.feishu.reactionsOn(second.messageId)).toEqual(['DONE'])
  })

  it('resumes the dsh session after the runtime restarts', async () => {
    const t = await setup(undefined, {}, false, { ingressClassifier: amendRepliedWork })
    t.feishu.members.set('oc_group', new Set(['ou_alice']))
    const first = msg()
    await t.orchestrator.handleMessage(first)
    await t.runtime.stop()
    await t.orchestrator.handleMessage(msg({ text: '接着检查刚才的讨论', mentions: [], parentId: first.messageId, threadId: 'omt_topic1' }))
    expect(t.state.resumed).toEqual(['fake-session-1'])
    expect(t.state.sessions.get('fake-session-1')?.prompts).toHaveLength(2)
    expect(t.state.sessions.size).toBe(1)
    expect(t.registry.taskWork.get(2)?.key).toBe(t.registry.taskWork.get(1)?.key)
  })

  it('feeds prior topic messages into the first prompt when mentioned mid-thread', async () => {
    const t = await setup()
    t.feishu.threads.set('omt_existing', [
      historyMsg({ messageId: 'om_a', senderName: '陆知行', text: '之前发过 sample 的 skill', createTimeMs: 1000 }),
      historyMsg({ messageId: 'om_b', senderName: 'Friday', senderOpenId: 'ou_bot', text: '机器人自己的话', createTimeMs: 1500 }),
      historyMsg({ messageId: 'om_c', senderName: '未来', text: '晚于触发消息', createTimeMs: 5000 }),
    ])
    await t.orchestrator.handleMessage(msg({ threadId: 'omt_existing', createTimeMs: 3000 }))
    const prompt = t.state.sessions.get('fake-session-1')?.prompts[0] ?? ''
    expect(prompt).toContain('陆知行: 之前发过 sample 的 skill')
    expect(prompt).toContain('Friday: 机器人自己的话')
    expect(prompt).not.toContain('晚于触发消息')
  })

  it('长回答折成一张卡片，而不是在群里连发好几条刷屏', async () => {
    const t = await setup([{ kind: 'text', text: ['结论：就是这儿。', '', ...Array.from({ length: 40 }, (_, i) => `- 证据 ${i}`)].join('\n') }])
    await t.orchestrator.handleMessage(msg())
    // 不再切成多条普通消息
    expect(t.feishu.answers()).toHaveLength(0)
    expect(t.feishu.of('replyText')).toHaveLength(0)
    const card = cardText(t.feishu.of('replyCard').slice(-1)[0]?.payload as Record<string, unknown>)
    expect(card).toContain('结论：就是这儿。') // 结论露在外面
    expect(card).toContain('展开详情')
    expect(card).toContain('证据 39') // 其余收在面板里，没丢
  })

  it('短回答还是普通消息，不套卡片', async () => {
    const t = await setup([{ kind: 'text', text: '好了。' }])
    await t.orchestrator.handleMessage(msg())
    expect(t.feishu.answers()).toEqual(['好了。'])
  })

  it('acks with a reaction on receipt and swaps it for ✅ when done', async () => {
    const t = await setup([{ kind: 'sleep', ms: 50 }, { kind: 'text', text: '好了' }])
    const m = msg()
    const run = t.orchestrator.handleMessage(m)
    await waitFor(() => t.feishu.reactionsOn(m.messageId).includes('OnIt'))
    await run
    expect(t.feishu.reactionsOn(m.messageId)).toEqual(['DONE'])
    expect(t.feishu.reactionLog.map((r) => r.op)).toEqual(['add', 'remove', 'add'])
  })

  it('marks failures with ❌, cancellations with nothing, and survives reaction API errors', async () => {
    const t = await setup([{ kind: 'sleep', ms: 100 }, { kind: 'sleep', ms: 100 }, { kind: 'text', text: 'late' }])
    const first = msg()
    const run = t.orchestrator.handleMessage(first)
    await waitFor(() => (t.state.sessions.get('fake-session-1')?.prompts.length ?? 0) > 0)
    await t.orchestrator.handleMessage(msg({ text: '@Friday !stop', rootId: first.messageId }))
    await run
    expect(t.feishu.reactionsOn(first.messageId)).toEqual([])

    // 失败：runtime 已停且 mcp 入口不存在时也能跑，这里用一个会抛错的 prompt 超时来触发 failed
    const f = await setup([{ kind: 'sleep', ms: 300 }], { FRIDAY_PROMPT_TIMEOUT_MS: '50' })
    const m2 = msg()
    await f.orchestrator.handleMessage(m2)
    expect(f.registry.getTask(1)?.status).toBe('failed')
    expect(f.feishu.reactionsOn(m2.messageId)).toEqual(['CrossMark'])

    // 失败时群里能看到一条说明
    expect(f.feishu.of('replyText').some((r) => String(r.payload).includes('处理失败'))).toBe(true)

    // 没权限贴表情：任务照常完成
    const n = await setup()
    n.feishu.failReactions = true
    const m3 = msg()
    await n.orchestrator.handleMessage(m3)
    expect(n.feishu.answers()).toEqual(['这是假回答。'])
    expect(n.registry.getTask(1)?.status).toBe('done')

    // FRIDAY_REACTIONS=off：一个表情都不贴
    const o = await setup(undefined, { FRIDAY_REACTIONS: 'off' })
    const m4 = msg()
    await o.orchestrator.handleMessage(m4)
    expect(o.feishu.reactionLog).toEqual([])
  })
})

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('non-end-turn ACP results', () => {
  it('persists a truncated answer as partial and shares that fact with progress and reactions', async () => {
    const t = await setup([{ kind: 'text', text: '已查到的部分。' }])
    const original = t.runtime.prompt.bind(t.runtime)
    vi.spyOn(t.runtime, 'prompt').mockImplementation(async (...args) => ({ ...await original(...args), stopReason: 'max_tokens' }))
    const inbound = msg()
    await t.orchestrator.handleMessage(inbound)
    const task = t.registry.taskForMessage(inbound.messageId)!
    expect(task.status).toBe('done') // Compatibility: the attempt ended; not a claim about completion of the work.
    expect(new RunAttempts(t.registry.db).latestForTask(task.id)?.result).toEqual({ version: 1, termination: 'max_tokens', outcome: 'partial', reason: 'model_limit' })
    expect(t.feishu.answers().join('\n')).toContain('结果还不完整')
    expect(t.feishu.reactionsOn(inbound.messageId)).toEqual(['THINKING'])
    const progress = (t.orchestrator as unknown as { taskProgress(task: typeof task): string }).taskProgress(task)
    expect(progress).toContain('尚未完成')
    expect(progress).not.toContain('已完成')
    expect(t.memory.recent(chatScope(t.registry.db, 'oc_group'))).toEqual([])
    await t.runtime.stop()
  })

  it('never uses the completion reaction when no partial reaction is configured', async () => {
    const t = await setup([{ kind: 'text', text: '未完成的部分。' }], { FRIDAY_REACTIONS: 'ack=OnIt,done=DONE,fail=CrossMark' })
    const original = t.runtime.prompt.bind(t.runtime)
    vi.spyOn(t.runtime, 'prompt').mockImplementation(async (...args) => ({ ...await original(...args), stopReason: 'max_tokens' }))
    const inbound = msg()
    await t.orchestrator.handleMessage(inbound)
    expect(t.feishu.reactionsOn(inbound.messageId)).not.toContain('DONE')
    await t.runtime.stop()
  })

  // The in-process ACP agent returns cancelled through the real runtime, without
  // the host aborting the Run. A partial text update must not count as completion.
  function incomplete(t: Awaited<ReturnType<typeof setup>>): FakeTurnStep[] {
    return [
      { kind: 'text', text: 'SYNTHETIC_PARTIAL_RESULT' },
      { kind: 'hook', run: () => { t.state.cancelPending.add(t.state.allPrompts.at(-1)!.sessionId) } },
      { kind: 'text', text: 'MUST_NOT_EXECUTE' },
    ]
  }

  it('marks reflection failed while keeping the successfully delivered parent completed', async () => {
    const t = await setup(undefined, { FRIDAY_REFLECT: 'on' })
    const prompt = vi.spyOn(t.runtime, 'prompt')
    t.state.script = [
      { kind: 'tool', text: '读取合成资料', toolKind: 'read' },
      { kind: 'text', text: '合成用户任务已完成。' },
      { kind: 'hook', run: () => { t.state.script = incomplete(t) } },
    ]
    try {
      await t.orchestrator.handleMessage(msg())
      expect(prompt).toHaveBeenCalledTimes(2)
      expect(await prompt.mock.results[1]!.value).toMatchObject({ stopReason: 'cancelled' })
      expect(prompt.mock.calls[1]![2]?.signal?.aborted).toBe(false)
      expect(t.registry.db.prepare('SELECT stage,state FROM run_attempts ORDER BY started_at').all()).toEqual([
        { stage: 'task', state: 'completed' }, { stage: 'reflect', state: 'failed' },
      ])
      expect(t.feishu.answers()).toEqual(['合成用户任务已完成。'])
    } finally { await t.runtime.stop() }
  })

  it('does not publish a partial consolidation result or mark its Run completed', async () => {
    const t = await setup()
    t.feishu.members.set('oc_group', new Set(['ou_alice']))
    const scope = chatScope(t.registry.db, 'oc_group')
    for (let i = 0; i < 5; i++) t.memory.add({ scope, kind: 'fact', title: `合成候选 ${i}`, body: '仍待确认' })
    t.state.script = incomplete(t)
    const prompt = vi.spyOn(t.runtime, 'prompt')
    try {
      expect(await t.orchestrator.consolidateMemories()).toBe(0)
      expect(prompt).toHaveBeenCalledOnce()
      expect(await prompt.mock.results[0]!.value).toMatchObject({ stopReason: 'cancelled' })
      expect(prompt.mock.calls[0]![2]?.signal?.aborted).toBe(false)
      expect(t.registry.db.prepare('SELECT stage,state FROM run_attempts').all()).toEqual([{ stage: 'reflect', state: 'failed' }])
      expect(t.feishu.sent).toEqual([])
      expect(t.memory.candidates(scope, 99)).toHaveLength(5)
    } finally { await t.runtime.stop() }
  })

  it('leaves the proactive consumption cursor unchanged after a partial ACP result', async () => {
    const t = await setup(undefined, {}, true)
    const since = t.proactive!.enable('oc_group', 'ou_alice').checkedUntil
    t.messageCache.upsert('oc_group', [1, 2].map(i => historyMsg({ messageId: `om_unconsumed_${i}`, text: `合成待处理讨论 ${i}`, createTimeMs: since + i })))
    t.state.script = incomplete(t)
    const prompt = vi.spyOn(t.runtime, 'prompt')
    try {
      expect(await t.orchestrator.runProactiveCheck('oc_group')).toBe('silent')
      expect(prompt).toHaveBeenCalledOnce()
      expect(await prompt.mock.results[0]!.value).toMatchObject({ stopReason: 'cancelled' })
      expect(prompt.mock.calls[0]![2]?.signal?.aborted).toBe(false)
      expect(t.registry.db.prepare('SELECT stage,state FROM run_attempts').all()).toEqual([{ stage: 'routine', state: 'failed' }])
      expect(t.proactive!.get('oc_group').checkedUntil).toBe(since)
      expect(t.feishu.sent).toEqual([])
    } finally { await t.runtime.stop() }
  })
})

describe('夜间整理（memory consolidation）', () => {
  function candidates(t: Awaited<ReturnType<typeof setup>>, count = 5) {
    t.feishu.members.set('oc_group', new Set(['ou_alice']))
    const scope = chatScope(t.registry.db, 'oc_group')
    return Array.from({ length: count }, (_, i) => t.memory.add({ scope, kind: 'fact', title: `待确认 ${i}`, body: `原候选正文 ${i}`, status: 'candidate' }))
  }
  function plan(notes: ReturnType<typeof candidates>) {
    return { merges: [{ ids: [notes[0]!.id, notes[1]!.id], kind: 'fact', title: '合并后的排期', body: '完整保留约束的合并候选。' }],
      remove: [notes[2]!.id], review: [notes[3]!.id] }
  }
  function memoryRows(t: Awaited<ReturnType<typeof setup>>) {
    return t.registry.db.prepare('SELECT * FROM memory_notes ORDER BY id').all()
  }
  function deliveryRows(t: Awaited<ReturnType<typeof setup>>) {
    // 提前退出的冷夹具尚未构造 DeliveryService，也就不存在任何投递记录。
    return t.registry.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deliveries'").get()
      ? t.registry.db.prepare('SELECT * FROM deliveries').all() : []
  }

  it('只在 candidate 攒够时跑，一天一次，真实提交合并/删除并保留待确认记录', async () => {
    const t = await setup([{ kind: 'text', text: '你好。' }])
    try {
      await t.orchestrator.handleMessage(msg({ text: '@Friday 你好' }))
      const conversation = t.state.allPrompts[0]!.sessionId
      const scope = chatScope(t.registry.db, 'oc_group')
      for (const n of t.memory.candidates(scope, 99)) t.memory.remove(n.id, scope)
      const notes = candidates(t, 4)
      expect(await t.orchestrator.consolidateMemories()).toBe(0)
      expect(t.state.allPrompts).toHaveLength(1)
      notes.push(t.memory.add({ scope, kind: 'fact', title: '第五条', body: '不在本次修改中的记录' }))
      const confirmed = t.memory.add({ scope, kind: 'rule', title: '真实已确认', body: '保持原值', ...confirmedMemory })
      t.state.script = [{ kind: 'text', text: JSON.stringify(plan(notes)) }]
      expect(await t.orchestrator.consolidateMemories()).toBe(1)
      const merged = t.memory.candidates(scope, 99).find(n => n.title === '合并后的排期')!
      expect(merged).toMatchObject({ status: 'candidate', body: '完整保留约束的合并候选。', source: { generatedBy: 'memory_consolidation' } })
      expect(t.memory.get(notes[0]!.id)).toMatchObject({ status: 'superseded', supersededBy: merged.id })
      expect(t.memory.get(notes[1]!.id)).toBeUndefined()
      expect(t.memory.get(notes[2]!.id)).toBeUndefined()
      expect(t.memory.getTombstone(notes[1]!.id)).toBeTruthy()
      expect(t.memory.getTombstone(notes[2]!.id)).toBeTruthy()
      expect(t.memory.get(notes[3]!.id)).toEqual(notes[3]) // review 不替人确认
      expect(t.memory.get(notes[4]!.id)).toEqual(notes[4])
      expect(t.memory.get(confirmed.id)).toEqual(confirmed)
      // 整理照做，但**一个字都不发**：这是我的内务，不该变成他的待办。
      // 真要他拍板的事，应该在学到它的那一刻、在对话里问他，而不是攒到半夜发张卡。
      expect(t.feishu.of('sendToChat')).toHaveLength(0)
      expect(t.feishu.of('sendToUser')).toHaveLength(0)
      // 这个用例前面打过招呼，账本里本来就有那一条；要断言的是**整理自己没有投递**。
      expect(deliveryRows(t).filter((r) => String((r as { delivery_key: string }).delivery_key).startsWith('memory:consolidate'))).toEqual([])
      const after = memoryRows(t)
      // 降低候选阈值后仍不重跑，证明是每日占位生效。
      expect(await t.orchestrator.consolidateMemories({ minCandidates: 1 })).toBe(0)
      expect(memoryRows(t)).toEqual(after)
      expect(t.state.allPrompts).toHaveLength(2)
      expect(t.feishu.of('sendToChat')).toHaveLength(0)
      const latest = t.state.allPrompts.at(-1)!
      expect(latest.sessionId).not.toBe(conversation)
      expect(t.state.sessions.has(conversation)).toBe(true)
      expect(t.state.sessions.has(latest.sessionId)).toBe(false)
      const mcp = latest.mcpServers as { env: { name: string; value: string }[] }[]
      const cap = t.tokens.verify(mcp[0]!.env.find(e => e.name === 'FRIDAY_CAP_TOKEN')!.value)!
      expect(cap.requesterOpenId).toBe('ou_alice')
      expect(cap.scopes).toEqual(['skill:read'])
      expect(cap.scopes).not.toContain('memory:write')
      expect(latest.text).toContain('[夜间整理')
      expect(latest.text).toContain('严格 JSON')
      expect(latest.text).not.toContain(confirmed.body)
    } finally { await t.runtime.stop() }
  })

  /**
   * 用户看到那张「候选记忆已整理」的卡片时问："这个是啥功能，你自己整理很合理，干嘛给用户看。"
   * 说得对。合并重复、删掉没价值的候选都只动**没确认过的**条目，谁也没损失什么——
   * 为此每晚发一张卡就是纯噪音。只有「建议确认」是在请他拍板，才值得打扰他。
   */
  it('只是合并和删除候选时安静落库，一个字都不发', async () => {
    const t = await setup([{ kind: 'text', text: '{"merges":[],"remove":[],"review":[]}' }])
    try {
      const scope = chatScope(t.registry.db, 'oc_group')
      for (const n of t.memory.candidates(scope, 99)) t.memory.remove(n.id, scope)
      const notes = candidates(t, 6)
      // 只做内务：合并一组、删一条，没有任何要他确认的
      t.state.script = [{ kind: 'text', text: JSON.stringify({
        merges: [{ ids: [notes[0]!.id, notes[1]!.id], kind: 'fact', title: '合并后的排期', body: '完整保留约束的合并候选。' }],
        remove: [notes[2]!.id], review: [] }) }]
      expect(await t.orchestrator.consolidateMemories()).toBe(1)
      // 改动真的落了库
      expect(t.memory.candidates(scope, 99).find(n => n.title === '合并后的排期')).toBeTruthy()
      expect(t.memory.get(notes[0]!.id)).toMatchObject({ status: 'superseded' })
      expect(t.memory.get(notes[2]!.id)).toBeUndefined()
      expect(t.memory.getTombstone(notes[2]!.id)).toBeTruthy()
      // 但他那边一个字都没收到，也没留下投递记录
      expect(t.feishu.of('sendToChat')).toHaveLength(0)
      expect(t.feishu.of('sendToUser')).toHaveLength(0)
      expect(deliveryRows(t)).toHaveLength(0)
      // 确认过的条目一概不碰，这一点不因为"安静"而放松
      expect(t.memory.candidates(scope, 99).some(n => n.status !== 'candidate')).toBe(false)
    } finally { await t.runtime.stop() }
  })

  it('模型返回空 JSON 计划就不打扰人，候选原样保留且当天不再计算', async () => {
    const t = await setup([{ kind: 'text', text: '{"merges":[],"remove":[],"review":[]}' }])
    candidates(t, 6)
    const before = memoryRows(t)
    try {
      expect(await t.orchestrator.consolidateMemories()).toBe(0)
      expect(t.state.allPrompts).toHaveLength(1)
      expect(t.feishu.sent).toEqual([])
      expect(memoryRows(t)).toEqual(before)
      expect(await t.orchestrator.consolidateMemories()).toBe(0)
      expect(t.state.allPrompts).toHaveLength(1)
      expect(deliveryRows(t)).toEqual([])
    } finally { await t.runtime.stop() }
  })

  it.each(['stop', 'archive', 'role', 'membership'] as const)('迟到完整计划在 %s 后不能修改记忆或发送', async cause => {
    const t = await setup(), notes = candidates(t), before = memoryRows(t)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), wait = new Promise<void>(resolve => { release = resolve })
    t.state.script = [{ kind: 'hook', run: async () => { entered(); await wait } }, { kind: 'text', text: JSON.stringify(plan(notes)) }]
    const pending = t.orchestrator.consolidateMemories()
    try {
      await started
      const space = t.spaces.byChat('oc_group')!
      if (cause === 'stop') {
        const { RunAttempts } = await import('../src/core/run-attempts.js')
        const attempts = new RunAttempts(t.registry.db)
        const run = t.registry.db.prepare("SELECT id FROM run_attempts WHERE state='running'").get() as { id: string }
        expect(attempts.requestStop(run.id, 'user_requested')).toBe(true) // 故意不 signal：宿主须识别持久停止。
      } else if (cause === 'archive') t.spaces.archive(space.id)
      else if (cause === 'role') t.spaces.removeMember(space.id, 'ou_alice')
      else t.feishu.members.set('oc_group', new Set())
      release()
      expect(await pending).toBe(0)
      expect(t.state.allPrompts).toHaveLength(1)
      expect(memoryRows(t)).toEqual(before)
      expect(t.feishu.sent).toEqual([])
      expect(deliveryRows(t)).toEqual([])
      expect(t.registry.db.prepare('SELECT COUNT(*) n FROM memory_tombstones').get()?.n).toBe(0)
      if (cause === 'stop') expect(t.registry.db.prepare('SELECT state,stop_reason FROM run_attempts').get())
        .toEqual({ state: 'cancelled', stop_reason: 'user_requested' })
    } finally { release(); await pending; await t.runtime.stop() }
  })

  /**
   * 原来这条用例守的是"发送 ACK 丢了之后不要重复合并"。现在夜间整理什么都不发，
   * 那个场景不存在了；但它顺带守的另一半仍然要紧：**同一天不重算、不重复合并**。
   * 这半边靠的是日占位标记，和发不发消息无关，所以单独留下来。
   */
  it('当天只整理一次：第二次调用不重跑模型、不重复合并', async () => {
    const t = await setup(), notes = candidates(t)
    t.state.script = [{ kind: 'text', text: JSON.stringify(plan(notes)) }]
    try {
      expect(await t.orchestrator.consolidateMemories()).toBe(1)
      const merged = t.memory.candidates(notes[0]!.scope, 99).find(n => n.title === '合并后的排期')!
      expect(merged?.status).toBe('candidate')
      expect(t.memory.get(notes[0]!.id)).toMatchObject({ status: 'superseded', supersededBy: merged.id })
      expect(t.memory.get(notes[1]!.id)).toBeUndefined()
      const before = memoryRows(t)
      // 把阈值降到 1 也不重跑：日占位生效
      expect(await t.orchestrator.consolidateMemories({ minCandidates: 1 })).toBe(0)
      expect(t.state.allPrompts).toHaveLength(1)
      expect(memoryRows(t)).toEqual(before)
      expect(t.feishu.sent).toEqual([])
    } finally { await t.runtime.stop() }
  })
})

describe('!status / !report（工作状态与周报）', () => {
  it.each(['status', 'report', 'handover'] as const)('does not return or publish forgotten decisions after awaiting %s facts', async what => {
    const t = await setup()
    const note = t.memory.add({ scope: chatScope(t.registry.db, 'oc_group'), kind: 'decision', title: '待删除的决定', body: '旧正文', ...confirmedMemory })
    vi.spyOn(t.feishu, 'chatName').mockImplementationOnce(async () => {
      t.memory.remove(note.id, note.scope)
      return '合成群'
    })
    await expect(t.orchestrator.abilities[what]({ sessionKey: 'direct-human', chatId: 'oc_group', chatType: 'group', requesterOpenId: 'ou_alice' }))
      .rejects.toThrow('记忆已更新')
    expect(t.feishu.createdDocs).toHaveLength(0)
    await t.runtime.stop()
  })

  it('does not expose the captured report as a fallback after memory changes during document creation', async () => {
    const t = await setup()
    const note = t.memory.add({ scope: chatScope(t.registry.db, 'oc_group'), kind: 'decision', title: '待删除的决定', body: '旧正文', ...confirmedMemory })
    vi.spyOn(t.feishu, 'createDocument').mockImplementationOnce(async () => {
      t.memory.remove(note.id, note.scope)
      throw new Error('network result unknown')
    })
    await expect(t.orchestrator.abilities.report({ sessionKey: 'direct-human', chatId: 'oc_group', chatType: 'group', requesterOpenId: 'ou_alice' }))
      .rejects.toThrow('记忆已更新')
    expect(t.feishu.sent).toHaveLength(0)
    await t.runtime.stop()
  })

  it('!status 只汇总读者能看到的层，!report 生成文档并写明口径', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg({ text: '@Friday 你好' }))
    const scope = chatScope(t.registry.db, 'oc_group')
    const todos = new Todos(t.registry.db)
    const now = Date.now()
    todos.add({ scope, kind: 'freeze', title: 'v1.2 封版', dueMs: now + 2 * 86400_000, owner: '张三' })
    todos.add({ scope, title: '补单测', dueMs: now - 86400_000 })
    const done = todos.add({ scope, title: '上线检查单' })
    todos.done(done.id, scope)
    // 别的群的事项不该出现
    todos.add({ scope: chatScope(t.registry.db, 'oc_other'), title: '别的群的秘密事项', dueMs: now + 86400_000 })
    t.memory.add({ scope, kind: 'decision', title: '发布日期定在 9/25', body: '会上确认', ...confirmedMemory })
    t.memory.add({ scope: chatScope(t.registry.db, 'oc_other'), kind: 'decision', title: '别的群的决定', body: 'x' })

    await t.orchestrator.handleMessage(msg({ text: '@Friday !status' }))
    const status = String(t.feishu.of('replyMarkdown').at(-1)?.payload)
    expect(status).toContain('v1.2 封版')
    expect(status).toContain('补单测')
    expect(status).toContain('上线检查单')
    expect(status).toContain('发布日期定在 9/25')
    expect(status).not.toContain('别的群的秘密事项')
    expect(status).not.toContain('别的群的决定')
    expect(status).toContain('口径：')

    await t.orchestrator.handleMessage(msg({ text: '@Friday !report' }))
    const reply = String(t.feishu.of('replyMarkdown').at(-1)?.payload)
    expect(reply).toContain('周报好了')
    const doc = t.feishu.createdDocs.at(-1)!
    expect(doc.title).toContain('周报')
    expect(doc.markdown).toContain('## 本周完成')
    expect(doc.markdown).toContain('上线检查单')
    expect(doc.markdown).toContain('## 逾期未完成')
    expect(doc.markdown).toContain('## 口径与边界')
    expect(doc.markdown).toContain('这份报告只包含这些层里的内容')
    expect(doc.markdown).not.toContain('别的群的秘密事项')
  })

  it('没东西可汇总时不建空文档', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg({ text: '@Friday 你好' }))
    await t.orchestrator.handleMessage(msg({ text: '@Friday !report' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('没有可汇总的事项')
    expect(t.feishu.createdDocs).toHaveLength(0)
  })
})

describe('!wiki（个人 / 空间 Wiki）', () => {
  it('攒够了才建；正文只来自库里的条目，模型编的编号会被丢掉', async () => {
    const t = await setup([
      {
        kind: 'text',
        text: ['## 项目 | 月度报表', '- 记忆 #2', '- 事项 #1', '一句话：8/11 排期三天，等陆知行给权限', '', '## 人物 | 陆知行', '- 记忆 #3', '一句话：数仓对接人', '', '## 项目 | 编出来的项目', '- 记忆 #999', '一句话：这条该被丢掉'].join('\n'),
      },
    ])
    await t.orchestrator.handleMessage(msg({ text: '@Friday 你好' }))
    const scope = chatScope(t.registry.db, 'oc_group')
    // 攒够之前不建
    await t.orchestrator.handleMessage(msg({ text: '@Friday !wiki' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('还没攒下什么')
    expect(t.feishu.createdDocs).toHaveLength(0)

    t.memory.add({ scope, kind: 'rule', title: '这个群回复用中文', body: 'x', ...confirmedMemory })
    t.memory.add({ scope, kind: 'fact', title: '月度报表 8/11 排期 3 天', body: '陆知行给的排期', ...confirmedMemory })
    t.memory.add({ scope, kind: 'profile', title: '陆知行是数仓对接人', body: 'x', ...confirmedMemory })
    t.memory.add({ scope, kind: 'fact', title: '还没人确认的推断', body: 'x', status: 'candidate' })
    const todos = new Todos(t.registry.db)
    todos.add({ scope, title: '申请数仓权限', owner: '陆知行' })

    await t.orchestrator.handleMessage(msg({ text: '@Friday !wiki' }))
    const reply = String(t.feishu.of('replyMarkdown').at(-1)?.payload)
    expect(reply).toContain('Wiki 建好了')
    const doc = t.feishu.createdDocs.at(-1)!
    expect(doc.title).toContain('工作 Wiki')
    expect(doc.markdown).toContain('## 常驻要求')
    expect(doc.markdown).toContain('这个群回复用中文')
    expect(doc.markdown).toContain('### 月度报表')
    expect(doc.markdown).toContain('8/11 排期三天，等陆知行给权限')
    expect(doc.markdown).toContain('### 陆知行')
    expect(doc.markdown).toContain('申请数仓权限')
    // 模型编的分组没有真实条目支撑，整组丢掉
    expect(doc.markdown).not.toContain('编出来的项目')
    // 没人确认的不进 wiki
    expect(doc.markdown).not.toContain('还没人确认的推断')
    expect(doc.markdown).toContain('## 这份 Wiki 的边界')
  })

  it('再发一次是在同一篇文档上重写，链接不变', async () => {
    const t = await setup([{ kind: 'text', text: 'NOTHING' }])
    await t.orchestrator.handleMessage(msg({ text: '@Friday 你好' }))
    const scope = chatScope(t.registry.db, 'oc_group')
    for (let i = 0; i < 4; i += 1) t.memory.add({ scope, kind: 'fact', title: `事实 ${i}`, body: 'x', ...confirmedMemory })
    await t.orchestrator.handleMessage(msg({ text: '@Friday !wiki' }))
    const first = t.feishu.createdDocs.at(-1)!
    t.memory.add({ scope, kind: 'decision', title: '新决定：延到 9/25', body: 'x', ...confirmedMemory })
    await t.orchestrator.handleMessage(msg({ text: '@Friday !wiki' }))
    expect(t.feishu.createdDocs).toHaveLength(1) // 没建第二篇
    expect(t.feishu.rewrittenDocs).toHaveLength(1)
    expect(t.feishu.rewrittenDocs[0]?.documentId).toBe(first.documentId)
    expect(t.feishu.rewrittenDocs[0]?.markdown).toContain('新决定：延到 9/25')
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('第 2 版')
    // 模型不归类时也能出一篇（条目落进"其他记下的事"）
    expect(t.feishu.rewrittenDocs[0]?.markdown).toContain('## 其他记下的事')
  })
})

describe('WorkItem 状态机', () => {
  it('只允许合法迁移，阻塞原因进提醒和 !status', async () => {
    const t = await setup()
    t.feishu.members.set('oc_group', new Set(['ou_alice']))
    t.registry.createSession({ sessionKey: 'todo-origin', chatId: 'oc_group', chatType: 'group', requesterOpenId: 'ou_alice', cwd: '/synthetic' })
    await t.orchestrator.handleMessage(msg({ text: '@Friday 你好' }))
    const scope = chatScope(t.registry.db, 'oc_group')
    const todos = new Todos(t.registry.db)
    const item = todos.add({ scope, title: '月度报表交付', dueMs: Date.now() + 3600_000, owner: '陆知行', createdBy: 'ou_alice', sessionKey: 'todo-origin' })
    // open → blocked → review → done
    expect(todos.transition(item.id, scope, 'blocked', { note: '等陆知行给权限', by: 'ou_alice' })?.status).toBe('blocked')
    expect(todos.get(item.id)?.statusNote).toBe('等陆知行给权限')
    expect(todos.transition(item.id, scope, 'review')?.status).toBe('review')
    expect(todos.transition(item.id, scope, 'done')?.status).toBe('done')
    expect(todos.get(item.id)?.doneAt).toBeGreaterThan(0)
    // done 只能重开，不能直接跳回阻塞
    expect(todos.transition(item.id, scope, 'blocked')).toBeUndefined()
    expect(todos.transition(item.id, scope, 'open')?.status).toBe('open')
    expect(todos.get(item.id)?.doneAt).toBeNull()
    // 作用域隔离
    expect(todos.transition(item.id, chatScope(t.registry.db, 'oc_other'), 'done')).toBeUndefined()

    // !status 把阻塞单独拎出来，带原因
    todos.transition(item.id, scope, 'blocked', { note: '等权限' })
    await t.orchestrator.handleMessage(msg({ text: '@Friday !status' }))
    const status = String(t.feishu.of('replyMarkdown').at(-1)?.payload)
    expect(status).toContain('阻塞 / 待验收')
    expect(status).toContain('等权限')

    // 提醒里也说明白，且催的是"解开"而不是"做完"
    todos.update(item.id, scope, { dueMs: Date.now() + 30 * 60_000 })
    todos.transition(item.id, scope, 'blocked', { note: '等权限' })
    expect(await t.orchestrator.remindDueTodos()).toBe(1)
    const reminder = String((t.feishu.of('sendToChat').at(-1)?.payload as { markdown: string }).markdown)
    expect(reminder).toContain('阻塞中：等权限')
    expect(reminder).not.toContain('不卡了')

    // 取消掉的不再提醒
    todos.transition(item.id, scope, 'cancelled', { note: '需求砍了' })
    expect(await t.orchestrator.remindDueTodos()).toBe(0)
  })

  it('状态机拒绝非法迁移，调用方据此给人一句话解释', async () => {
    const t = await setup()
    const scope = chatScope(t.registry.db, 'oc_group')
    const todos = new Todos(t.registry.db)
    const item = todos.add({ scope, title: '上线检查', owner: '张三' })
    expect(todos.transition(item.id, scope, 'done')?.status).toBe('done')
    expect(todos.transition(item.id, scope, 'review')).toBeUndefined() // 完成了不能直接回待验收
    expect(todos.transition(item.id, scope, 'cancelled')).toBeUndefined()
    expect(todos.list(scope, { status: 'active' })).toHaveLength(0)
    expect(todos.list(scope, { status: 'all' })).toHaveLength(1)
  })
})

describe('!why（上下文回执）与跨空间披露', () => {
  it('!why 说清这一轮读了哪几层、引用了哪些条目、没取什么', async () => {
    const t = await setup()
    const scope = chatScope(t.registry.db, 'oc_group')
    t.memory.add({ scope, kind: 'rule', title: '本群回复用中文', body: 'x', ...confirmedMemory })
    t.memory.add({ scope, kind: 'fact', title: '数仓对接人是陆知行', body: '8/4 确认' })
    t.memory.add({ scope: 'org', kind: 'fact', title: '公司统一用内网 GitLab', body: 'x' })
    await t.orchestrator.handleMessage(msg({ text: '@Friday 陆知行' }))
    await t.orchestrator.handleMessage(msg({ text: '@Friday !why', threadId: 'omt_topic1' }))
    const why = String(t.feishu.of('replyMarkdown').at(-1)?.payload)
    expect(why).toContain('上一轮')
    expect(why).toContain('本空间')
    expect(why).toContain('常驻要求 1 条')
    expect(why).toContain('数仓对接人是陆知行')
    expect(why).toContain('没有取的')
    expect(why).toContain('不在任何联盟')
    expect(why).toContain('别人的私聊记忆')
  })

  it('没答过就直说，别编', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg({ text: '@Friday !why' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('还没有我答过的轮次')
  })

  it('跨群读取不等于群披露许可：不发正文，仍可查看实际来源回执', async () => {
    let orchestratorRef: { noteCrossSpaceRead: (k: string, r: { chatId: string; name: string; what: string }) => void } | undefined
    let sessionKey = ''
    // 模拟：工具在这一轮中途读了产品群（真实链路上是内部 API 回调进来的）
    const t = await setup([
      { kind: 'hook', run: () => orchestratorRef?.noteCrossSpaceRead(sessionKey, { chatId: 'oc_prod', name: '产品群', what: '群聊内容' }) },
      { kind: 'text', text: '产品群昨天定了 9/25 发布。' },
    ])
    orchestratorRef = t.orchestrator
    const first = msg({ text: '@Friday 产品群昨天说了什么' })
    sessionKey = `msg:${first.messageId}`
    await t.orchestrator.handleMessage(first)
    expect(t.feishu.of('replyMarkdown')).toHaveLength(0)
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('核验不了来源')
    expect(JSON.stringify(t.feishu.sent)).not.toContain('9/25')
    await t.orchestrator.handleMessage(msg({ text: '@Friday !why', threadId: 'omt_topic1' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('产品群')
  })
})

describe('!handover（交接包）', () => {
  it('讲清状态、接手清单、职责原文；不含凭证，身份不转移', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg({ text: '@Friday 你好' }))
    const scope = chatScope(t.registry.db, 'oc_group')
    const todos = new Todos(t.registry.db)
    todos.add({ scope, kind: 'freeze', title: 'v1.2 封版', dueMs: Date.now() + 2 * 86400_000, owner: '张三' })
    t.memory.add({ scope, kind: 'rule', title: '这个群回复用中文', body: 'x', ...confirmedMemory })
    t.memory.add({ scope, kind: 'fact', title: '推断的东西', body: 'x', status: 'candidate' })
    const routines = new RoutineStore(t.registry.db)
    routines.add({ kind: 'watch', ownerOpenId: 'ou_alice', runAs: 'ou_alice', chatId: 'oc_group', chatType: 'group', name: '盯发布讨论', prompt: '把发布相关的讨论摘要发我', schedule: { type: 'daily', at: '18:00' }, watchChatIds: ['oc_prod'] })

    await t.orchestrator.handleMessage(msg({ text: '@Friday !handover' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('交接包好了')
    const doc = t.feishu.createdDocs.at(-1)!
    expect(doc.title).toContain('交接包')
    // 是什么 / 不是什么
    expect(doc.markdown).toContain('不含任何密钥')
    expect(doc.markdown).toContain('换人就必须重新接一遍')
    // 状态快照
    expect(doc.markdown).toContain('待确认 2 条') // 自动 QA 与推断都需确认。
    expect(doc.markdown).toContain('常驻要求 1 条')
    // 接手清单：第一条就是身份
    expect(doc.markdown).toContain('## 接手清单')
    expect(doc.markdown).toContain('不要沿用前任的身份')
    // 接手的是个全新的人，交接包里不能塞命令——第二步照样要说清"怎么成为负责人"。
    expect(doc.markdown).toContain('成为负责人')
    expect(doc.markdown).not.toMatch(/[/!]space owners/)
    expect(doc.markdown).toContain('首轮验收')
    // 职责原文可复制
    expect(doc.markdown).toContain('### #1 盯发布讨论')
    expect(doc.markdown).toContain('把发布相关的讨论摘要发我')
    expect(doc.markdown).toContain('以谁的身份运行')
    // 事项
    expect(doc.markdown).toContain('v1.2 封版')
    expect(doc.markdown).toContain('## 状态游标')
  })
})

describe('初次见面与命令面', () => {
  it('第一次在群里被 @ 只发一条入群确认消息（不再发自我介绍卡片），之后不再发', async () => {
    const t = await setup()
    // 全新的群：第一条 @ 只用来建空间 + 发入群确认，不干活
    await t.orchestrator.handleMessage(msg({ chatId: 'oc_fresh', text: '@Friday 你好' }))
    await new Promise((r) => setTimeout(r, 30))
    const sent = t.feishu.of('sendToChat').map((x) => JSON.stringify(x.payload))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Friday · 本群功能')
    expect(sent[0]).toContain('自动保存')
    expect(sent[0]).not.toContain('选好后就生效，无需回复')
    expect(sent.filter((c) => c.includes('就位了'))).toHaveLength(0)
    expect(t.feishu.of('replyMarkdown')).toHaveLength(0) // 这一条没被当成活儿
    // 再 @ 一次：不再发，这次才真的干活
    await t.orchestrator.handleMessage(msg({ chatId: 'oc_fresh', messageId: 'om_2', text: '@Friday 再问一句' }))
    expect(t.feishu.of('sendToChat').map((x) => JSON.stringify(x.payload)).filter((c) => c.includes('Friday · 本群功能'))).toHaveLength(1)
    expect(t.feishu.of('replyMarkdown').length).toBeGreaterThan(0)
  })

  it('/help 按分组列命令，并且每条都给一句"人话怎么说"', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg({ text: '@Friday /help' }))
    const card = cardText(t.feishu.of('replyCard').at(-1)?.payload as Record<string, unknown>)
    expect(card).toContain('直接跟我说话就行')
    expect(card).toContain('/tasks')
    expect(card).toContain('/wiki')
    expect(card).toContain('或者直接说')
    expect(card).toContain('出个周报')
  })

  it('老命令还认：/status→/tasks、/space→/settings、!restart→/new', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg({ text: '@Friday !status' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('工作状态')
    await t.orchestrator.handleMessage(msg({ text: '@Friday /space' }))
    expect(JSON.stringify(t.feishu.of('replyCard').at(-1)?.payload)).toContain('Friday · 本群功能')
  })

  it('/groups 说清这里能读到哪些群', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(msg({ text: '@Friday /groups' }))
    const out = String(t.feishu.of('replyMarkdown').at(-1)?.payload)
    expect(out).toContain('没加入联盟')
    expect(out).toContain('只在本群说话做事')
    await t.orchestrator.handleMessage(msg({ text: '@Friday /groups join harness' }))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('harness')
  })

  it('群列表读取失败不当作没有群，成功空列表才返回没有', async () => {
    const t = await setup()
    t.feishu.listChats = async () => { throw new Error('synthetic upstream failure') }
    await t.orchestrator.handleMessage(msg({ chatId: 'oc_dm', chatType: 'p2p', text: '/groups' }))
    const failed = String(t.feishu.of('replyMarkdown').at(-1)?.payload)
    expect(failed).toContain('这次没能取到列表')
    expect(failed).not.toContain('一个都没有')
    expect(failed).not.toContain('synthetic upstream failure')
    t.feishu.listChats = async () => []
    await t.orchestrator.handleMessage(msg({ messageId: 'om_groups_retry', chatId: 'oc_dm', chatType: 'p2p', text: '/groups' }))
    expect(String(t.feishu.of('replyMarkdown').at(-1)?.payload)).toContain('一个都没有')
  })
})

describe('自检', () => {
  it('从自己的执行记录里挑出失败、被中止、答完就被追问的', async () => {
    const t = await setup()
    const now = Date.now()
    for (const sessionKey of ['msg:s1', 'msg:s2']) t.registry.createSession({ sessionKey, chatId: 'oc_group', chatType: 'group', cwd: t.home })
    const scope = { chatId: 'oc_group', chatType: 'group' as const, requesterOpenId: 'ou_alice' }
    const mk = (over: Record<string, unknown>) => {
      const task = t.registry.createTask({ sessionKey: String(over.sessionKey ?? 'msg:s1'), messageId: 'om_x', requesterOpenId: 'ou_alice', prompt: String(over.prompt ?? 'p') })
      t.registry.updateTask(task.id, { status: over.status as 'done' | 'failed' | 'cancelled', startedAt: now - 60_000, finishedAt: now - 60_000 + Number(over.ms ?? 1000), error: over.error as string | undefined })
      return task
    }
    mk({ status: 'done', prompt: '总结讨论', ms: 2000 })
    mk({ status: 'failed', prompt: '查数仓排期', error: '模型未正常结束', ms: 5000 })
    mk({ status: 'cancelled', prompt: '跑个脚本', ms: 300 })
    const out = (await t.orchestrator.selfCheck({ days: 7, scope })).text
    expect(out).toContain('自检')
    expect(out).toContain('完成 1')
    expect(out).toContain('失败 1')
    expect(out).toContain('被中止 1')
    expect(out).toContain('模型未正常结束')
    // 同一会话里紧接着又问 → 记成"答完很快又被追问"
    const first = mk({ status: 'done', sessionKey: 'msg:s2', prompt: '第一次问' })
    const second = mk({ status: 'done', sessionKey: 'msg:s2', prompt: '再问一遍' })
    t.registry.db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(now - 40_000, first.id)
    t.registry.db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(now - 10_000, second.id)
    const out2 = (await t.orchestrator.selfCheck({ days: 7, scope })).text
    expect(out2).toContain('答完很快又被追问')
    expect(out2).toContain('第一次问')
    // 没有可总结的就不起会话
    expect((await t.orchestrator.selfCheck({ days: 7, withLessons: false, scope })).lessons).toBe(false)
  })
})

describe('空间负责人的认定', () => {
  it('建空间时把群主也冻结成负责人，之后不自动同步', async () => {
    const t = await setup()
    t.feishu.chatOwners.set('oc_fresh', 'ou_boss')
    // ou_alice 把我拉进群（进群事件记下她），但第一个说话的是 ou_bob
    const { normalizeChatLifecycle } = await import('../src/feishu/ws.js')
    await t.orchestrator.handleChatLifecycle(normalizeChatLifecycle('bot_added', { chat_id: 'oc_fresh', operator_id: { open_id: 'ou_alice' } }))
    const { Spaces } = await import('../src/core/space.js')
    const spaces = new Spaces(t.registry.db)
    expect(spaces.byChat('oc_fresh')).toBeUndefined() // 进群那一刻还没建空间
    await t.orchestrator.handleMessage(msg({ chatId: 'oc_fresh', text: '@Friday 你好', senderOpenId: 'ou_bob' }))
    await new Promise((r) => setTimeout(r, 30))
    const space = spaces.byChat('oc_fresh')!
    // 负责人是**拉我进群的 ou_alice** 和群主，不是第一个说话的 ou_bob
    expect(spaces.owners(space.id).sort()).toEqual(['ou_alice', 'ou_boss'])
    expect(spaces.roleOf(space.id, 'ou_bob')).toBe('member')
  })

  it('群管理员也在建空间那一刻冻结成负责人，之后换管理员不同步', async () => {
    const t = await setup()
    t.feishu.chatOwners.set('oc_mgr', 'ou_boss')
    t.feishu.chatManagers.set('oc_mgr', ['ou_mgr1', 'ou_mgr2'])
    const { normalizeChatLifecycle } = await import('../src/feishu/ws.js')
    await t.orchestrator.handleChatLifecycle(normalizeChatLifecycle('bot_added', { chat_id: 'oc_mgr', operator_id: { open_id: 'ou_alice' } }))
    const { Spaces } = await import('../src/core/space.js')
    const spaces = new Spaces(t.registry.db)
    await t.orchestrator.handleMessage(msg({ chatId: 'oc_mgr', text: '@Friday 你好', senderOpenId: 'ou_bob' }))
    await new Promise((r) => setTimeout(r, 30))
    const space = spaces.byChat('oc_mgr')!
    // 拉我进群的人 ∪ 群主 ∪ 群管理员，都是负责人
    expect(spaces.owners(space.id).sort()).toEqual(['ou_alice', 'ou_boss', 'ou_mgr1', 'ou_mgr2'])
    // 一次性冻结：之后群里换了管理员，空间负责人不变
    t.feishu.chatManagers.set('oc_mgr', ['ou_mgr3'])
    await t.orchestrator.handleMessage(msg({ chatId: 'oc_mgr', text: '@Friday 再来一条', senderOpenId: 'ou_bob' }))
    await new Promise((r) => setTimeout(r, 30))
    expect(spaces.owners(space.id).sort()).toEqual(['ou_alice', 'ou_boss', 'ou_mgr1', 'ou_mgr2'])
    expect(spaces.roleOf(space.id, 'ou_mgr3')).toBeUndefined()
  })
})

describe('repos 隔离', () => {
  it('没在白名单里的人和群，工作区里不挂共享代码检出', async () => {
    const t = await setup(undefined, { FRIDAY_REPOS_CHATS: '', FRIDAY_REPOS_USERS: 'ou_alice' })
    const groupDir = t.orchestrator.prepareWorkspace('oc_group', 'group')
    const aliceDir = t.orchestrator.prepareWorkspace('oc_dm', 'p2p', 'ou_alice')
    const bobDir = t.orchestrator.prepareWorkspace('oc_dm', 'p2p', 'ou_bob')
    expect(existsSync(join(groupDir, 'repos'))).toBe(false)
    expect(existsSync(join(aliceDir, 'repos'))).toBe(true) // 白名单里的人还有
    expect(existsSync(join(bobDir, 'repos'))).toBe(false)
    expect(readFileSync(join(bobDir, 'AGENTS.md'), 'utf8')).not.toContain('repos/deepseek-harness')
  })

  it('权限收紧对存量生效：之前挂过的链接会被摘掉，仓库本身不动', async () => {
    const t = await setup(undefined, { FRIDAY_REPOS_CHATS: '' })
    const { Spaces } = await import('../src/core/space.js')
    const spaces = new Spaces(t.registry.db)
    const space = spaces.ensure({ kind: 'group', chatId: 'oc_group' })
    spaces.patchConfig(space.id, { repos: true })
    const dir = t.orchestrator.prepareWorkspace('oc_group', 'group')
    expect(existsSync(join(dir, 'repos'))).toBe(true)
    spaces.patchConfig(space.id, { repos: false })
    t.orchestrator.prepareWorkspace('oc_group', 'group')
    expect(existsSync(join(dir, 'repos'))).toBe(false)
    // 摘的是软链，共享的仓库目录本身还在
    expect(existsSync(join(t.cfg.workspace.root, 'repos', 'deepseek-harness'))).toBe(true)
  })
})

describe('捎带（收件箱）与回执偏好', () => {
  it('答完在末尾捎一句"还有事等你拍板"，并记账；同一件事不会连着捎两次', async () => {
    const t = await setup()
    const space = t.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_alice' })
    const old = Date.now() - NUDGE_DELAY_MS - 1000
    t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'responsibility', refId: 41, spaceId: space.id, title: '职责提案「每天核对发布清单」', why: '接受后以你的身份定时跑', now: old })

    await t.orchestrator.handleMessage(msg())
    const first = t.feishu.answers().join('\n')
    expect(first).toContain('另外有一件事等你拍板')
    expect(first).toContain('每天核对发布清单')
    // 发出去了才算捎过
    expect(t.inbox.get(1)?.nudges).toBe(1)

    // 紧接着再问一句：冷却期内不该再捎，不然就成了复读机
    await t.orchestrator.handleMessage(msg({ text: '@Friday 再问一句' }))
    expect(t.feishu.answers().slice(1).join('\n')).not.toContain('等你拍板')
  })

  it('群里不捎私聊里攒的事——那等于替人把别处的事贴进群', async () => {
    const t = await setup()
    const old = Date.now() - NUDGE_DELAY_MS - 1000
    t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'auth', refId: 9, spaceId: 'sp_dm_ou_alice', title: '别处的盯群授权到期', now: old })
    await t.orchestrator.handleMessage(msg())
    expect(t.feishu.answers().join('\n')).not.toContain('等你拍板')
  })

  it('!space set ack react：只贴表情，不再发过程卡', async () => {
    const t = await setup()
    const space = t.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_alice' })
    t.spaces.patchConfig(space.id, { ack: 'react' })
    const m = msg()
    await t.orchestrator.handleMessage(m)
    expect(t.feishu.of('replyCard')).toHaveLength(0)
    expect(t.feishu.answers().join('\n')).not.toBe('')
  })

  it('!space set ack none：表情也不贴', async () => {
    const t = await setup()
    const space = t.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_alice' })
    t.spaces.patchConfig(space.id, { ack: 'none' })
    const m = msg()
    await t.orchestrator.handleMessage(m)
    expect(t.feishu.reactionsOn(m.messageId)).toHaveLength(0)
    expect(t.feishu.of('replyCard')).toHaveLength(0)
  })
})

describe('全局并发上限', () => {
  it('不同群同时 @：也要守住全局上限，不是各跑各的', async () => {
    let inFlight = 0
    let peak = 0
    const script: FakeTurnStep[] = [
      { kind: 'hook', run: async () => { inFlight += 1; peak = Math.max(peak, inFlight) } },
      { kind: 'sleep', ms: 80 },
      { kind: 'hook', run: async () => { inFlight -= 1 } },
      { kind: 'text', text: '答完了。' },
    ]
    const t = await setup(script, { FRIDAY_MAX_CONCURRENT_TURNS: '1', FRIDAY_REPOS_CHATS: '' })
    // 三个**不同**的群：SerialQueue 按 sessionKey 串行，管不到它们之间
    await Promise.all([
      t.orchestrator.handleMessage(msg({ chatId: 'oc_a', text: '@Friday 一' })),
      t.orchestrator.handleMessage(msg({ chatId: 'oc_b', text: '@Friday 二' })),
      t.orchestrator.handleMessage(msg({ chatId: 'oc_c', text: '@Friday 三' })),
    ])
    expect(peak).toBe(1)
    // 三个都答上了，只是排着来——排队不是丢任务
    expect(t.feishu.answers().filter((a) => a.includes('答完了')).length).toBe(3)
  })

  it('上限放宽就真的并行——别把上限做成永远串行', async () => {
    let inFlight = 0
    let peak = 0
    const script: FakeTurnStep[] = [
      { kind: 'hook', run: async () => { inFlight += 1; peak = Math.max(peak, inFlight) } },
      { kind: 'sleep', ms: 80 },
      { kind: 'hook', run: async () => { inFlight -= 1 } },
      { kind: 'text', text: '答完了。' },
    ]
    const t = await setup(script, { FRIDAY_MAX_CONCURRENT_TURNS: '3', FRIDAY_REPOS_CHATS: '' })
    await Promise.all([
      t.orchestrator.handleMessage(msg({ chatId: 'oc_a', text: '@Friday 一' })),
      t.orchestrator.handleMessage(msg({ chatId: 'oc_b', text: '@Friday 二' })),
      t.orchestrator.handleMessage(msg({ chatId: 'oc_c', text: '@Friday 三' })),
    ])
    expect(peak).toBe(3)
  })
})

describe('步数预算：有限探索后交付明确未完成的东西', () => {
  /**
   * 第一步先把"下一轮的脚本"换掉，再连着调 n 次工具。
   * fake agent 的循环遍历的是进入时那个数组，所以在 hook 里重新赋值
   * 只影响**下一次** prompt——正好用来模拟收尾轮。
   */
  const exploreThenWrapUp = (n: number, wrapUp: FakeTurnStep[], state: { script: FakeTurnStep[] }): FakeTurnStep[] => [
    { kind: 'hook', run: async () => { state.script = wrapUp } },
    ...Array.from({ length: n }, (_, i) => ({ kind: 'tool' as const, text: `查第 ${i + 1} 处` })),
    { kind: 'text', text: '（这一句轮不到，前面就被掐了）' },
  ]

  it('超预算就掐掉，再跑一轮收尾，交一个明说没做完的结论', async () => {
    const t = await setup(undefined, { FRIDAY_MAX_STEPS_PER_TURN: '5' })
    t.state.script = exploreThenWrapUp(12, [{ kind: 'text', text: '已经确认卡在人工确认这步，确认卡没发出去；通知那条链路还没查。' }], t.state)
    const inbound = msg({ text: '@Friday 发布为什么卡住了' })
    await t.orchestrator.handleMessage(inbound)

    const answer = t.feishu.answers().join('\n')
    expect(answer).toContain('已经确认卡在人工确认这步')
    // 边界由网关加，不指望模型记得说
    expect(answer).toContain('查到这里就停了')
    // 而且要交代下一步在人手上，不能只说"没做完"把人晾着
    expect(answer).toContain('要我接着往下查')
    expect(answer).toContain('已经查实的部分')
    expect(answer).not.toMatch(/第\s*\d+\s*步|预算|上限/)
    // 不是失败：人不该看到"处理失败"
    expect(answer).not.toContain('处理失败')
    // 被掐掉那半轮的残句不该混进最终答案
    expect(answer).not.toContain('轮不到')
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.state.cancelled).toContain(t.state.allPrompts[0]!.sessionId)
    expect(t.feishu.reactionsOn(inbound.messageId)).toEqual(['THINKING'])
    expect(t.feishu.of('replyCard')).toHaveLength(0)
    expect(new RunAttempts(t.registry.db).latestForTask(t.registry.taskForMessage(inbound.messageId)!.id)?.result)
      .toEqual({ version: 1, termination: 'cancelled', outcome: 'partial', reason: 'step_budget' })
  })

  it('收尾轮自己也挂了，照实说被打断，不假装答完了', async () => {
    const t = await setup(undefined, { FRIDAY_MAX_STEPS_PER_TURN: '5', FRIDAY_PROMPT_TIMEOUT_MS: '400' })
    t.state.script = exploreThenWrapUp(12, [{ kind: 'sleep', ms: 3000 }], t.state)
    const inbound = msg({ text: '@Friday 这个为什么' })
    await t.orchestrator.handleMessage(inbound)
    const answer = t.feishu.answers().join('\n')
    expect(answer).toContain('还没有形成可靠结论')
    expect(answer).toContain('查到这里就停了')
    expect(answer).not.toMatch(/比看上去大|\d+\s*步|预算|上限/)
    expect(t.feishu.reactionsOn(inbound.messageId)).toEqual(['THINKING'])
    expect(t.feishu.of('replyCard')).toHaveLength(0)
  })

  it('预算是 0 就不限，别把一个开关做成永远掐', async () => {
    const t = await setup([{ kind: 'tool', text: 'a' }, { kind: 'tool', text: 'b' }, { kind: 'text', text: '正常答完。' }], {
      FRIDAY_MAX_STEPS_PER_TURN: '0',
    })
    const inbound = msg()
    await t.orchestrator.handleMessage(inbound)
    const answer = t.feishu.answers().join('\n')
    expect(answer).toContain('正常答完')
    expect(answer).not.toContain('查到这里就停了')
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.reactionsOn(inbound.messageId)).toEqual(['DONE'])
  })
})

describe('普通长回答保留在原会话，不由长度决定创建文档', () => {
  const longAnswer = [
    '结论：发布卡在人工确认这一步，确认卡从来没发出去。',
    '',
    ...Array.from({ length: 50 }, (_, i) => `细节第 ${i + 1} 条：这里是一段足够长的分析内容，用来把整段 answer 推过旧的落文档阈值。`),
  ].join('\n')

  it('超过旧阈值也只折叠展示完整答案，不自动创建或分享文档', async () => {
    const t = await setup([{ kind: 'text', text: longAnswer }])
    const create = vi.spyOn(t.feishu, 'createDocument'), grant = vi.spyOn(t.feishu, 'grantDocAccess')
    await t.orchestrator.handleMessage(msg({ text: '@Friday 发布为什么卡住了' }))
    const cards = t.feishu.of('replyCard').map(c => cardText(c.payload as Record<string, unknown>))
    const all = [...cards, ...t.feishu.answers()].join('\n')
    expect(all).toContain('结论：发布卡在人工确认这一步')
    expect(all).toContain('细节第 50 条')
    expect(all).not.toContain('完整分析写在这里了')
    expect(create).not.toHaveBeenCalled(); expect(grant).not.toHaveBeenCalled()
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM run_api_calls').get()).toEqual({ n: 0 })
  })

  it('没有文档权限也能在原会话完整展示长回答', async () => {
    const t = await setup([{ kind: 'text', text: longAnswer }])
    t.feishu.failDocCreate = true
    await t.orchestrator.handleMessage(msg({ text: '@Friday 发布为什么卡住了' }))
    const cards = t.feishu.of('replyCard').map(c => cardText(c.payload as Record<string, unknown>))
    expect([...cards, ...t.feishu.answers()].join('\n')).toContain('细节第 50 条')
    expect(t.feishu.createdDocs).toHaveLength(0)
  })

  it('超过折叠面板上限时分段发送完整正文，仍不自动建文档', async () => {
    const full = 'Synthetic first\n' + '完整段落。'.repeat(4000) + '\nSynthetic last'
    const t = await setup([{ kind: 'text', text: full }])
    await t.orchestrator.handleMessage(msg())
    expect(t.feishu.createdDocs).toHaveLength(0)
    const parts = t.feishu.of('replyMarkdown').map(item => String(item.payload))
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('\n')).toContain('Synthetic first')
    expect(parts.join('\n')).toContain('Synthetic last')
    expect(parts.join('').match(/完整段落。/g)).toHaveLength(4000)
  })

  it('中等长度的回答也不创建文档', async () => {
    const medium = ['结论：就是那一行没 await。', '', ...Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行`)].join('\n')
    const t = await setup([{ kind: 'text', text: medium }])
    await t.orchestrator.handleMessage(msg())
    expect(t.feishu.createdDocs).toHaveLength(0)
  })
})

describe('表情语汇：不点开任何东西也知道发生了什么', () => {
  it('排队时贴「在排队」，轮到了撤掉', async () => {
    const script: FakeTurnStep[] = [{ kind: 'sleep', ms: 600 }, { kind: 'text', text: '答完了。' }]
    const t = await setup(script, { FRIDAY_MAX_CONCURRENT_TURNS: '1', FRIDAY_REPOS_CHATS: '' })
    const second = msg({ chatId: 'oc_b', text: '@Friday 第二个' })
    const first = t.orchestrator.handleMessage(msg({ chatId: 'oc_a', text: '@Friday 第一个' }))
    // 先让第一条真的拿到许可再发第二条，否则谁先抢到闸门是不确定的
    await new Promise((r) => setTimeout(r, 150))
    const laterRun = t.orchestrator.handleMessage(second)
    // 轮询到它真的排上队（建 dsh 会话、准备工作区都在闸门之前，时机不固定）
    let sawQueued = false
    for (let i = 0; i < 40 && !sawQueued; i += 1) {
      await new Promise((r) => setTimeout(r, 25))
      sawQueued = t.feishu.reactionsOn(second.messageId).includes('Typing')
    }
    await Promise.all([first, laterRun])

    // 等的时候贴过"在排队"
    expect(sawQueued).toBe(true)
    // 跑完之后不该还挂着"在排队"
    expect(t.feishu.reactionsOn(second.messageId)).not.toContain('Typing')
    expect(t.feishu.reactionsOn(second.messageId)).toContain('DONE')
  })

  it('等人拍板时贴「等你拍板」，拍完撤掉', async () => {
    const t = await setup([{ kind: 'permission', text: 'shell', rawInput: { command: 'rm -rf /' } }, { kind: 'text', text: '好了。' }])
    const m = msg()
    const run = t.orchestrator.handleMessage(m)
    await new Promise((r) => setTimeout(r, 120))
    expect(t.feishu.reactionsOn(m.messageId)).toContain('GLANCE')

    const card = t.feishu.of('replyCard').slice(-1)[0]
    const requestId = JSON.stringify(card?.payload).match(/"requestId":"([^"]+)"/)?.[1]
    await t.orchestrator.handleCardAction({ value: { action: 'permission', requestId, decision: 'deny' }, operatorOpenId: 'ou_alice' } as never)
    await run
    expect(t.feishu.reactionsOn(m.messageId)).not.toContain('GLANCE')
  })

  it('没做完用另一个表情，不跟「答完了」混着用', async () => {
    const t = await setup(undefined, { FRIDAY_MAX_STEPS_PER_TURN: '3' })
    t.state.script = [
      { kind: 'hook', run: async () => { t.state.script = [{ kind: 'text', text: '查到一半，停在这儿。' }] } },
      ...Array.from({ length: 8 }, (_, i) => ({ kind: 'tool' as const, text: `查 ${i}` })),
      { kind: 'text', text: 'x' },
    ]
    const m = msg()
    await t.orchestrator.handleMessage(m)
    expect(t.feishu.reactionsOn(m.messageId)).toContain('THINKING')
    expect(t.feishu.reactionsOn(m.messageId)).not.toContain('DONE')
  })
})
