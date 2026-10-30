import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import type { IngressClassificationInput, IngressDecision } from '../src/acp/ingress-classifier.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { FeedbackControl } from '../src/core/feedback-control.js'
import { PendingQuestionReplies } from '../src/core/pending-question-replies.js'
import type { AskBugQuestionReceipt } from '../src/core/question-types.js'
import { IngressReceipts } from '../src/core/ingress.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent, type FakeTurnStep } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

// The classifier is deliberately synthetic: these tests exercise host routing,
// authorization and receipts, not a real model's natural-language accuracy.
const log = createLogger('ingress-routing', 'error')
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function settled<T>(promise: Promise<T>) {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
}

function setup(options: { maxConcurrent?: number; maxSteps?: number; databasePath?: string; feedback?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-ingress-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_PERMISSION_TIMEOUT_MS: '5000', FRIDAY_PROMPT_TIMEOUT_MS: '5000',
    FRIDAY_MAX_CONCURRENT_TURNS: String(options.maxConcurrent ?? 3),
    ...(options.maxSteps === undefined ? {} : { FRIDAY_MAX_STEPS_PER_TURN: String(options.maxSteps) }),
  } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const databasePath = options.databasePath ?? join(home, 'test.sqlite')
  const registry = new Registry(databasePath)
  const sp = spaceDeps(registry.db)
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_alice' })
  sp.spaces.addMember(group.id, 'ou_bob', 'member')
  const feishu = new FakeFeishu()
  feishu.chats = [{ chatId: 'oc_group', name: '合成验收群' }]
  feishu.members.set('oc_group', new Set(['ou_alice', 'ou_bob']))
  const memory = new ChannelMemory(registry.db)
  const cache = new MessageCache(registry.db)
  const messages = new MessageService(asFeishuClient(feishu), cache, log)
  const tokens = new TokenIssuer('synthetic-ingress')
  const routines = new RoutineStore(registry.db)
  const bugs = options.feedback ? new Bugs(registry.db) : undefined
  const questions = bugs ? new BugQuestions(registry.db, bugs) : undefined
  const feedback = bugs && questions ? new FeedbackControl(registry, bugs, questions, routines) : undefined
  const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: '普通答疑结果' }] })
  const classify = vi.fn<(input: IngressClassificationInput, signal?: AbortSignal) => Promise<IngressDecision>>(async () => ({ kind: 'clarify' }))
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, maxConcurrent: options.maxConcurrent ?? 3,
    onPermission: (request, signal) => orchestrator.handlePermission(request, signal), log })
  const deps = { cfg, registry, memory, messages, todos: new Todos(registry.db), routines, ...sp, tokens,
    feishu: asFeishuClient(feishu), runtime, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent',
    botOpenId: 'ou_bot', log, ingressClassifier: { classify }, ...(feedback ? { feedback, questions } : {}) }
  orchestrator = new Orchestrator(deps)
  let serial = 0
  const releases: (() => void)[] = []
  const pending: Promise<unknown>[] = []
  const msg = (text: string, over: Partial<InboundMessage> = {}): InboundMessage => {
    const id = `om_ingress_${++serial}`
    return { eventId: `event_${id}`, messageId: id, chatId: 'oc_group', chatType: 'group', msgType: 'text',
      text: `@Friday ${text}`, senderOpenId: 'ou_alice', senderType: 'user', mentions: [{ key: '@Friday', name: 'Friday', openId: 'ou_bot' }],
      createTimeMs: Date.now(), ...over }
  }
  const dispatch = (message: InboundMessage) => {
    const result = settled(orchestrator.handleMessage(message))
    pending.push(result)
    return result
  }
  const barrier = () => {
    const gate = deferred()
    releases.push(gate.resolve)
    return gate
  }
  const tasks = () => registry.db.prepare('SELECT * FROM tasks ORDER BY id').all()
  const receipts = () => registry.db.prepare('SELECT * FROM ingress_routes ORDER BY message_id').all()
  const controlReplies = (message: InboundMessage) => feishu.sent.filter((item) => item.target === message.messageId)
  cleanup.push(async () => {
    for (const release of releases) release()
    await Promise.all(pending)
    await runtime.stop()
    registry.close()
    rmSync(home, { recursive: true, force: true })
  })
  return { registry, routines, bugs, questions, feedback, ...sp, group, feishu, runtime, state, classify, msg, dispatch, barrier, tasks, receipts, controlReplies,
    orchestrator, databasePath, deps }
}

type Fixture = ReturnType<typeof setup>

describe('natural follow-ups to finished work', () => {
  const dm = { chatId: 'oc_dm_natural', chatType: 'p2p' as const }

  it('keeps an unquoted substantive follow-up on the original work root', async () => {
    const t = setup(), original = t.msg('看一下产品群最近一天需要我跟进的事项和出处，先不通知别人', dm)
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    await t.dispatch(original)
    const first = t.registry.taskForMessage(original.messageId)!
    t.classify.mockImplementationOnce(async input => {
      expect(input.message.replyToRef).toBeUndefined()
      expect(input.candidates).toHaveLength(1)
      expect(input.candidates[0]).toMatchObject({ title: '看一下产品群最近一天需要我跟进的事项和出处，先不通知别人', status: 'done' })
      return { kind: 'amend', targetRef: input.candidates[0]!.ref }
    })
    const followup = t.msg('这些是我负责的吗？把直接提到我的和你认为我应该关注的分开，先不用建待办。', dm)
    await t.dispatch(followup)
    const second = t.registry.taskForMessage(followup.messageId)!
    expect(second).toMatchObject({ sessionKey: first.sessionKey, status: 'done' })
    expect(t.registry.taskWork.get(second.id)?.key).toBe(t.registry.taskWork.get(first.id)?.key)
    expect(t.registry.listAmendedTasks(second.id).map(task => task.id)).toEqual([first.id])
    expect(t.receipts().at(-1)?.result).toBe(`amend:${first.id}`)
    expect(t.deps.todos.list(['space:dm:ou_alice'])).toEqual([])
  })

  it('lets the classifier select older A after separate B already completed in the same Session', async () => {
    const t = setup(), original = t.msg('整理原事项 A 的依据', dm)
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    await t.dispatch(original)
    const first = t.registry.taskForMessage(original.messageId)!
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    const other = t.msg('查另一事项 B', dm)
    await t.dispatch(other)
    const second = t.registry.taskForMessage(other.messageId)!
    expect(second.sessionKey).toBe(first.sessionKey)
    expect(t.registry.taskWork.get(second.id)?.key).not.toBe(t.registry.taskWork.get(first.id)?.key)
    t.classify.mockImplementationOnce(async input => {
      expect(input.candidates).toHaveLength(2)
      expect(input.candidates[0]!.title).toBe('查另一事项 B')
      const selected = input.candidates.find(candidate => candidate.title === '整理原事项 A 的依据')!
      return { kind: 'amend', targetRef: selected.ref }
    })
    const backToA = t.msg('回到之前的 A，核对一下那些依据', dm)
    await t.dispatch(backToA)
    const resumed = t.registry.taskForMessage(backToA.messageId)!
    expect(resumed.status).toBe('done')
    expect(t.registry.taskWork.get(resumed.id)?.key).toBe(t.registry.taskWork.get(first.id)?.key)
    expect(t.registry.getTask(second.id)).toEqual(second)
    expect(t.state.cancelled).toEqual([])
    expect(t.state.allPrompts.at(-1)?.text).toContain('整理原事项 A 的依据')
  })

  it('keeps unrelated work in the same private conversation as its own Work, even when the only candidate finished recently', async () => {
    const t = setup(), original = t.msg('核对产品群事项', dm)
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    await t.dispatch(original)
    const first = t.registry.taskForMessage(original.messageId)!
    t.classify.mockResolvedValueOnce({ kind: 'new_work' })
    const different = t.msg('另外帮我解释归并排序', dm)
    await t.dispatch(different)
    const next = t.registry.taskForMessage(different.messageId)!
    // One continuous conversation: the model keeps the earlier turns; the Work relation still says this is a new matter.
    expect(next.sessionKey).toBe(first.sessionKey)
    expect(t.registry.taskWork.get(next.id)?.key).not.toBe(t.registry.taskWork.get(first.id)?.key)
    expect(t.registry.getTask(first.id)).toEqual(first)
    expect(t.receipts().at(-1)?.result).toBe('dm_continue')
  })

  it('in the person\'s own chat, an unclear follow-up continues the conversation instead of being asked back', async () => {
    const t = setup(), original = t.msg('整理产品群事项', dm)
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    await t.dispatch(original)
    const first = t.registry.taskForMessage(original.messageId)!
    // Two more readings must agree before an unclear reading is overruled; here they do not, and it still continues.
    t.classify.mockResolvedValueOnce({ kind: 'clarify' }).mockResolvedValueOnce({ kind: 'clarify' })
    const ambiguous = t.msg('那个再看看', dm)
    await t.dispatch(ambiguous)
    const next = t.registry.taskForMessage(ambiguous.messageId)!
    expect(next).toBeDefined()
    // Same conversation (the model has the earlier turns), no question bounced back, not bound to the earlier Work.
    expect(next.sessionKey).toBe(first.sessionKey)
    expect(t.registry.taskWork.get(next.id)?.key).not.toBe(t.registry.taskWork.get(first.id)?.key)
    expect(JSON.stringify(t.feishu.sent)).not.toContain('哪件事')
    expect(t.receipts().at(-1)?.result).toBe('dm_continue')
  })

  it('in the person\'s own chat, a request that arrives while other work runs waits in the same conversation', async () => {
    const t = setup()
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    const first = await holdTask(t, '先做第一件事', dm)
    t.classify.mockResolvedValueOnce({ kind: 'new_work' })
    const second = t.msg('另外再帮我看看第二件事', dm)
    const queued = t.dispatch(second)
    await vi.waitFor(() => expect(t.registry.taskForMessage(second.messageId)).toBeDefined())
    const next = t.registry.taskForMessage(second.messageId)!
    expect(next.sessionKey).toBe(first.session.sessionKey)
    expect(t.receipts().at(-1)?.result).toBe('dm_continue_queued')
    first.release()
    await Promise.all([first.result, queued])
    expect(t.registry.getTask(next.id)?.status).toBe('done')
  })

  it('rereads an unclear message twice and follows the two agreeing readings instead of asking back', async () => {
    const t = setup(), original = t.msg('整理产品群事项', dm)
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    await t.dispatch(original)
    const first = t.registry.taskForMessage(original.messageId)!
    t.classify.mockResolvedValueOnce({ kind: 'clarify' })
      .mockImplementationOnce(async input => ({ kind: 'amend', targetRef: input.candidates[0]!.ref }))
      .mockImplementationOnce(async input => ({ kind: 'amend', targetRef: input.candidates[0]!.ref }))
    const followup = t.msg('把依据也列出来', dm)
    await t.dispatch(followup)
    expect(t.classify).toHaveBeenCalledTimes(4)
    const next = t.registry.taskForMessage(followup.messageId)!
    expect(t.registry.taskWork.get(next.id)?.key).toBe(t.registry.taskWork.get(first.id)?.key)
    expect(JSON.stringify(t.feishu.sent)).not.toContain('哪件事')
    // Two readings that disagree with each other change nothing: in a group with earlier work the question stays.
    const earlier = t.msg('整理群里的事项')
    await t.dispatch(earlier)
    expect(t.registry.taskForMessage(earlier.messageId)?.status).toBe('done')
    t.classify.mockResolvedValueOnce({ kind: 'clarify' }).mockResolvedValueOnce({ kind: 'new_work' }).mockResolvedValueOnce({ kind: 'work_request' })
    const group = t.msg('那个再看看', { rootId: earlier.messageId })
    await t.dispatch(group)
    expect(t.registry.taskForMessage(group.messageId)).toBeUndefined()
    expect(JSON.stringify(t.feishu.sent)).toContain('这条说的是哪件事')
  })

  it('a quote reply the classifier cannot place continues the answer it quotes', async () => {
    const t = setup(), original = t.msg('要不要我现在去翻群里的记录？', dm)
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    await t.dispatch(original)
    const first = t.registry.taskForMessage(original.messageId)!
    t.classify.mockResolvedValue({ kind: 'clarify' })
    const reply = t.msg('去看吧', { ...dm, parentId: first.cardMessageId ?? original.messageId })
    await t.dispatch(reply)
    const next = t.registry.taskForMessage(reply.messageId)!
    expect(next).toBeDefined()
    expect(t.registry.taskWork.get(next.id)?.key).toBe(t.registry.taskWork.get(first.id)?.key)
    expect(JSON.stringify(t.feishu.sent)).not.toContain('哪件事')
    t.classify.mockReset(); t.classify.mockResolvedValue({ kind: 'clarify' })
  })

  it('can resolve a finished candidate from persistent records after coordinator restart', async () => {
    const t = setup(), original = t.msg('核对原计划的日期', dm)
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    await t.dispatch(original)
    const first = t.registry.taskForMessage(original.messageId)!
    const restarted = new Orchestrator(t.deps)
    t.classify.mockImplementationOnce(async input => ({ kind: 'amend', targetRef: input.candidates.find(candidate => candidate.title === '核对原计划的日期')!.ref }))
    const followup = t.msg('再把依据列出来', dm)
    await restarted.handleMessage(followup)
    const next = t.registry.taskForMessage(followup.messageId)!
    expect(t.registry.taskWork.get(next.id)?.key).toBe(t.registry.taskWork.get(first.id)?.key)
    expect(next.status).toBe('done')
  })

  it('rejects a persisted routing envelope whose actor differs from the real retry', async () => {
    const t = setup(), original = t.msg('核对原计划', dm)
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    await t.dispatch(original)
    const first = t.registry.taskForMessage(original.messageId)!
    t.classify.mockClear()
    const retry = t.msg('继续核对', dm), space = t.spaces.byChat(dm.chatId)!
    new IngressReceipts(t.registry.db).receive({ message: { ...retry, senderOpenId: 'ou_bob' }, spaceId: space.id,
      sessionKey: first.sessionKey, targets: [], input: { message: { text: retry.text }, candidates: [] } }, Date.now())
    await t.dispatch(retry)
    expect(t.classify).not.toHaveBeenCalled()
    expect(t.registry.taskForMessage(retry.messageId)).toBeUndefined()
    expect(t.receipts().at(-1)?.result).toBe('access_changed')
  })
})

describe('startup handoff recovery through the real coordinator', () => {
  async function pendingTask(t: Fixture) {
    const original = t.msg('先查一下这段代码')
    await t.dispatch(original)
    const session = t.registry.getSession(t.registry.taskForMessage(original.messageId)!.sessionKey)!
    const message = t.msg('补充一下，要保留原来的返回格式', { rootId: original.messageId, parentId: original.messageId })
    const task = t.registry.createTaskOnce({ sessionKey: session.sessionKey, messageId: message.messageId,
      requesterOpenId: message.senderOpenId, prompt: '补充一下，要保留原来的返回格式', inbound: message }).task
    return { original, message, task, session }
  }

  it('executes a committed but undispatched task once, retaining its original task ID and input', async () => {
    const t = setup(), p = await pendingTask(t)
    t.registry.failStaleTasks('restart')
    const restored = new Orchestrator(t.deps)
    await restored.recoverHandoffs()
    await restored.recoverHandoffs()
    await restored.handleMessage(p.message)
    expect(t.registry.getTask(p.task.id)?.status).toBe('done')
    expect(t.tasks()).toHaveLength(2)
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.state.allPrompts.at(-1)?.text).toContain('保留原来的返回格式')
    expect(t.feishu.answers()).toHaveLength(2)
  })

  it.each(['stop', 'archive', 'revoke'] as const)('does not run or send queued work after %s during downtime', async (change) => {
    const t = setup(), p = await pendingTask(t)
    if (change === 'stop') t.registry.cancelQueuedTask(p.task.id, Date.now())
    if (change === 'archive') t.spaces.archive(t.group.id)
    if (change === 'revoke') t.feishu.members.set('oc_group', new Set(['ou_bob']))
    await new Orchestrator(t.deps).recoverHandoffs()
    expect(t.registry.getTask(p.task.id)?.status).toBe('cancelled')
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.answers()).toHaveLength(1)
  })

  it('rechecks a stop that arrives while the fresh membership request is awaiting', async () => {
    const t = setup(), p = await pendingTask(t)
    const read = t.barrier(), release = t.barrier()
    vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementationOnce(async () => { read.resolve(); await release.promise; return new Set(['ou_alice']) })
    const recovery = new Orchestrator(t.deps).recoverHandoffs()
    await read.promise
    t.registry.cancelQueuedTask(p.task.id, Date.now())
    release.resolve()
    await recovery
    expect(t.registry.getTask(p.task.id)?.status).toBe('cancelled')
    expect(t.state.allPrompts).toHaveLength(1)
  })

  it('keeps a never-started handoff pending through a transient membership lookup failure', async () => {
    const t = setup(), p = await pendingTask(t)
    const lookup = vi.spyOn(t.feishu, 'chatMemberOpenIds').mockRejectedValueOnce(new Error('network unavailable'))
    const restored = new Orchestrator(t.deps)
    await restored.recoverHandoffs()
    expect(t.registry.getTask(p.task.id)).toMatchObject({ status: 'queued', startedAt: null })
    expect(t.registry.dispatches.pending()).toHaveLength(1)
    expect(t.state.allPrompts).toHaveLength(1)
    lookup.mockRestore()
    await restored.recoverHandoffs()
    expect(t.registry.getTask(p.task.id)).toMatchObject({ status: 'done', error: null })
    expect(t.state.allPrompts).toHaveLength(2)
  })

  it('does not move an old queued task into the replacement session during a membership lookup', async () => {
    const t = setup(), p = await pendingTask(t)
    const read = t.barrier(), release = t.barrier()
    vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementationOnce(async () => { read.resolve(); await release.promise; return new Set(['ou_alice']) })
    const recovery = new Orchestrator(t.deps).recoverHandoffs()
    await read.promise
    const retired = t.registry.retireSession(p.session.sessionKey)!
    t.registry.createSession({ ...p.session, requesterOpenId: 'ou_alice', threadId: undefined, rootMessageId: undefined, title: 'new session' })
    release.resolve()
    await recovery
    expect(t.registry.getTask(p.task.id)?.sessionKey).toBe(retired)
    expect(t.registry.getTask(p.task.id)?.status).not.toBe('done')
    expect(t.state.allPrompts).toHaveLength(1)
  })

  it('does not revive a received new_work decision when its source session was archived', async () => {
    const t = setup(), p = await pendingTask(t)
    const incoming = t.msg('另外做一件事')
    const routes = new IngressReceipts(t.registry.db)
    routes.receive({ message: incoming, spaceId: t.group.id, sessionKey: p.session.sessionKey,
      targets: [], input: { message: { text: '另外做一件事' }, candidates: [] } }, Date.now())
    routes.classified(incoming.messageId, { kind: 'new_work' })
    t.registry.invalidateChat(p.session.chatId, 'space_disabled')
    await new Orchestrator(t.deps).recoverHandoffs()
    expect(t.registry.taskForMessage(incoming.messageId)).toBeUndefined()
    expect(t.registry.listRecentSessions(p.session.chatId)).toHaveLength(1)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(routes.pending()).toEqual([])
  })

  it('refreshes an unsent progress receipt after restart without replaying the interrupted worker', async () => {
    const t = setup(), p = await pendingTask(t)
    const control = t.msg('现在进度如何')
    const routes = new IngressReceipts(t.registry.db)
    routes.receive({ message: control, spaceId: t.group.id, sessionKey: p.session.sessionKey,
      targets: [{ ref: 'captured', task: p.task }], input: { message: { text: '现在进度如何' }, candidates: [] } }, Date.now())
    routes.commit(control.messageId, { kind: 'progress', targetRef: 'captured' }, '还在处理。', () => {}, true)
    t.registry.startTask(p.task.id, Date.now())
    t.registry.failStaleTasks('restart')
    await new Orchestrator(t.deps).recoverHandoffs()
    expect(JSON.stringify(t.controlReplies(control))).toContain('未完成')
    expect(JSON.stringify(t.controlReplies(control))).not.toContain('还在处理')
    expect(t.state.allPrompts).toHaveLength(1)
  })

  it('recovers a classified stop against its captured target before waking queued tasks', async () => {
    const t = setup(), p = await pendingTask(t)
    const control = t.msg('这个先停下', { parentId: p.message.messageId })
    const routes = new IngressReceipts(t.registry.db)
    routes.receive({ message: control, spaceId: t.group.id, sessionKey: p.session.sessionKey,
      targets: [{ ref: 'captured', task: p.task }], input: { message: { text: '这个先停下', replyToRef: 'captured' },
        candidates: [{ ref: 'captured', title: p.task.prompt, status: 'queued' }] } }, Date.now())
    routes.classified(control.messageId, { kind: 'stop', targetRef: 'captured' })
    const restored = new Orchestrator(t.deps)
    await restored.recoverHandoffs()
    await restored.recoverHandoffs()
    expect(t.classify).not.toHaveBeenCalled()
    expect(t.registry.getTask(p.task.id)?.status).toBe('cancelled')
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.controlReplies(control)).toHaveLength(1)
  })

  it('reclassifies a received event with the stored candidates even if the latest alias now points elsewhere', async () => {
    const t = setup(), p = await pendingTask(t)
    const control = t.msg('这件事怎么样了', { parentId: p.message.messageId })
    const routes = new IngressReceipts(t.registry.db)
    routes.receive({ message: control, spaceId: t.group.id, sessionKey: p.session.sessionKey,
      targets: [{ ref: 'captured', task: p.task }], input: { message: { text: '这件事怎么样了', replyToRef: 'captured' },
        candidates: [{ ref: 'captured', title: p.task.prompt, status: 'queued' }] } }, Date.now())
    t.registry.addAlias(`msg:${control.messageId}`, 'another-session')
    t.classify.mockImplementationOnce(async (input) => {
      expect(input.candidates).toEqual([{ ref: 'captured', title: p.task.prompt, status: 'queued' }])
      return { kind: 'progress', targetRef: 'captured' }
    })
    await new Orchestrator(t.deps).recoverHandoffs()
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(t.controlReplies(control))).toContain('保留原来的返回格式')
    expect(t.registry.getTask(p.task.id)?.status).toBe('done')
  })

  it('keeps a started task and its unknown delivery out of automatic recovery', async () => {
    const t = setup(), p = await pendingTask(t)
    t.registry.startTask(p.task.id, Date.now())
    t.registry.db.prepare("UPDATE deliveries SET status = 'unknown', error = 'lost_ack'").run()
    const before = t.registry.db.prepare('SELECT * FROM deliveries').all()
    t.registry.failStaleTasks('restart')
    await new Orchestrator(t.deps).recoverHandoffs()
    expect(t.registry.getTask(p.task.id)?.status).toBe('failed')
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT * FROM deliveries').all()).toEqual(before)
  })

  it('recovers a committed control receipt without reapplying the decision or resending a lost ACK', async () => {
    const t = setup(), p = await pendingTask(t)
    const control = t.msg('停下这件事')
    const routes = new IngressReceipts(t.registry.db)
    routes.receive({ message: control, spaceId: t.group.id, sessionKey: p.session.sessionKey,
      targets: [{ ref: 'captured', task: p.task }], input: { message: { text: '停下这件事' }, candidates: [] } }, Date.now())
    routes.commit(control.messageId, { kind: 'stop', targetRef: 'captured' }, '已停止。', () => t.registry.cancelQueuedTask(p.task.id, Date.now()), true)
    const reply = t.feishu.replyText.bind(t.feishu)
    vi.spyOn(t.feishu, 'replyText').mockImplementation(async (...args) => { await reply(...args); throw new Error('lost ACK') })
    const restored = new Orchestrator(t.deps)
    await restored.recoverHandoffs()
    await restored.recoverHandoffs()
    expect(t.controlReplies(control)).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT status FROM deliveries WHERE delivery_key = ?').get(`route:${control.messageId}`)).toEqual({ status: 'unknown' })
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.classify).not.toHaveBeenCalled()
  })
})
async function holdTask(t: Fixture, text = '合成任务 A', over: Partial<InboundMessage> = {}, prefix: FakeTurnStep[] = []) {
  const entered = t.barrier()
  const release = t.barrier()
  t.state.script = [...prefix, { kind: 'hook', run: async () => { entered.resolve(); await release.promise } }, { kind: 'text', text: `${text}最终结果` }]
  const message = t.msg(text, over)
  const result = t.dispatch(message)
  await entered.promise
  const prompt = t.state.allPrompts.at(-1)!
  const session = t.registry.getSessionByAcpId(prompt.sessionId)!
  const task = t.registry.runningTask(session.sessionKey)!
  return { message, result, release: release.resolve, session, task, acpId: prompt.sessionId }
}

async function holdInitialAcknowledgment(t: Fixture, text = '等待接单回执的原事项 A', over: Partial<InboundMessage> = {}) {
  const accepted = t.barrier()
  const release = t.barrier()
  const message = t.msg(text, over)
  const promptCount = t.state.allPrompts.length
  const addReaction = t.feishu.addReaction.bind(t.feishu)
  vi.spyOn(t.feishu, 'addReaction').mockImplementation(async (messageId, emoji) => {
    const id = await addReaction(messageId, emoji)
    if (messageId === message.messageId && emoji === 'OnIt') {
      accepted.resolve()
      await release.promise
    }
    return id
  })
  const result = t.dispatch(message)
  await accepted.promise
  const task = t.registry.taskForMessage(message.messageId)!
  const session = t.registry.getSession(task.sessionKey)!
  expect(task.status).toBe('queued')
  expect(t.state.allPrompts).toHaveLength(promptCount)
  expect(t.feishu.reactionsOn(message.messageId)).toEqual(['OnIt'])
  return { message, task, session, result, release: release.resolve }
}

function decideTarget(t: Fixture, kind: 'progress' | 'stop' | 'amend') {
  t.classify.mockImplementation(async (input) => {
    expect(input.candidates).toHaveLength(1)
    return { kind, targetRef: input.candidates[0]!.ref }
  })
}

async function classified(t: Fixture, message: InboundMessage) {
  const calls = t.classify.mock.calls.length
  const result = t.dispatch(message)
  // Bounded observation makes a missing route fail without waiting on the held worker.
  await vi.waitFor(() => expect(t.classify.mock.calls.length).toBeGreaterThan(calls))
  return result
}

describe('natural-language ingress control with real worker and durable receipts', () => {
  it('keeps an ordinary question without active work on the existing worker path', async () => {
    const t = setup()
    expect((await t.dispatch(t.msg('这个按钮怎么用？'))).ok).toBe(true)
    expect(t.classify).not.toHaveBeenCalled()
    expect(t.tasks()).toHaveLength(1)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.answers()).toEqual(['普通答疑结果'])
  })

  it('answers progress while the initial ACK is pending without accepting a second worker task', async () => {
    const t = setup()
    const first = await holdInitialAcknowledgment(t)
    t.classify.mockImplementationOnce(async (input) => {
      expect(input.candidates).toHaveLength(1)
      expect(input.candidates[0]).toMatchObject({ title: '等待接单回执的原事项 A', status: 'queued' })
      return { kind: 'progress', targetRef: input.candidates[0]!.ref }
    })
    const query = t.msg('不用停，只问做到哪了？', { rootId: first.message.messageId })
    await classified(t, query)
    expect(t.tasks()).toHaveLength(1)
    expect(t.registry.getTask(first.task.id)?.status).toBe('queued')
    expect(t.state.allPrompts).toHaveLength(0)
    expect(t.state.cancelled).toEqual([])
    expect(t.controlReplies(query)).toHaveLength(1)
    expect(JSON.stringify(t.controlReplies(query))).toContain('排队')
    first.release()
    await first.result
    expect(t.registry.getTask(first.task.id)?.status).toBe('done')
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.tasks()).toHaveLength(1)
    expect(t.feishu.reactionsOn(first.message.messageId)).not.toContain('OnIt')
  })

  it('durably stops the queued task before its initial ACK arrives and then removes the late OnIt reaction', async () => {
    const t = setup()
    t.state.script = [{ kind: 'text', text: 'ACK_CANCELLED_TASK_MUST_NOT_RUN' }]
    const first = await holdInitialAcknowledgment(t)
    decideTarget(t, 'stop')
    const query = t.msg('这件先停一下', { rootId: first.message.messageId })
    await classified(t, query)
    expect(t.registry.getTask(first.task.id)).toMatchObject({ status: 'cancelled', stopReason: 'user_requested', startedAt: null })
    expect(t.registry.getTask(first.task.id)?.finishedAt).not.toBeNull()
    expect(t.state.allPrompts).toHaveLength(0)
    expect(t.state.cancelled).toEqual([])
    expect(t.tasks()).toHaveLength(1)
    expect(t.controlReplies(query)).toHaveLength(1)
    first.release()
    await first.result
    expect(t.registry.getTask(first.task.id)?.status).toBe('cancelled')
    expect(t.state.allPrompts).toHaveLength(0)
    expect(t.feishu.reactionsOn(first.message.messageId)).toEqual([])
    expect(t.feishu.reactionLog).toContainEqual(expect.objectContaining({ op: 'remove', messageId: first.message.messageId }))
    expect(JSON.stringify(t.feishu.sent)).not.toContain('ACK_CANCELLED_TASK_MUST_NOT_RUN')
  })

  it('does not apply a queued stop decision to the worker that starts while classification is awaiting', async () => {
    const t = setup()
    const first = await holdInitialAcknowledgment(t)
    const classifying = t.barrier()
    const releaseDecision = t.barrier()
    t.classify.mockImplementationOnce(async (input) => {
      expect(input.candidates).toHaveLength(1)
      expect(input.candidates[0]?.status).toBe('queued')
      const targetRef = input.candidates[0]!.ref
      classifying.resolve()
      await releaseDecision.promise
      return { kind: 'stop', targetRef }
    })
    const query = t.msg('停下这件事', { rootId: first.message.messageId })
    const stopping = t.dispatch(query)
    await classifying.promise
    const workerEntered = t.barrier()
    const releaseWorker = t.barrier()
    t.state.script = [{ kind: 'hook', run: async () => { workerEntered.resolve(); await releaseWorker.promise } },
      { kind: 'text', text: 'NEWLY_STARTED_WORKER_SURVIVES_STALE_CONTROL' }]
    first.release()
    await workerEntered.promise
    expect(t.registry.getTask(first.task.id)?.status).toBe('running')
    releaseDecision.resolve()
    await stopping
    expect(t.registry.getTask(first.task.id)).toMatchObject({ status: 'running', stopReason: null })
    expect(t.state.cancelled).toEqual([])
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.tasks()).toHaveLength(1)
    expect(t.controlReplies(query)).toHaveLength(1)
    expect(JSON.stringify(t.controlReplies(query))).toMatch(/状态.*变|再确认/)
    releaseWorker.resolve()
    await first.result
    expect(t.registry.getTask(first.task.id)?.status).toBe('done')
    expect(t.feishu.answers()).toContain('NEWLY_STARTED_WORKER_SURVIVES_STALE_CONTROL')
  })

  it('starts new work separately during the original ACK wait and preserves both accepted tasks', async () => {
    const t = setup()
    const first = await holdInitialAcknowledgment(t)
    t.classify.mockResolvedValueOnce({ kind: 'new_work' })
    const second = await holdTask(t, 'ACK 等待期间的新事项 B', { rootId: first.message.messageId })
    expect(second.session.sessionKey).not.toBe(first.session.sessionKey)
    expect(second.session.cwd).not.toBe(first.session.cwd)
    expect(t.registry.getTask(first.task.id)?.status).toBe('queued')
    expect(t.registry.getTask(second.task.id)?.status).toBe('running')
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.state.cancelled).toEqual([])
    t.state.script = [{ kind: 'text', text: '原事项 A 正常完成' }]
    first.release()
    await first.result
    const firstAcpId = t.registry.getSession(first.session.sessionKey)?.acpSessionId
    expect(firstAcpId).toBeTruthy()
    expect(firstAcpId).not.toBe(second.acpId)
    expect(t.registry.getTask(first.task.id)?.status).toBe('done')
    expect(t.registry.getTask(second.task.id)?.status).toBe('running')
    second.release()
    await second.result
    expect(t.registry.getTask(second.task.id)?.status).toBe('done')
    expect(t.tasks()).toHaveLength(2)
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.state.cancelled).toEqual([])
    expect(t.feishu.answers()).toEqual(['原事项 A 正常完成', 'ACK 等待期间的新事项 B最终结果'])
    expect(t.feishu.reactionsOn(first.message.messageId)).not.toContain('OnIt')
  })

  it('replaces an ACK-pending task with one amended inbound task carrying the original request and supplement', async () => {
    const t = setup()
    const first = await holdInitialAcknowledgment(t)
    decideTarget(t, 'amend')
    t.state.script = [{ kind: 'text', text: '原请求结合补充后的唯一结果' }]
    const supplement = t.msg('只看移动端，上周的数据不用了', { rootId: first.message.messageId, parentId: first.message.messageId })
    const amend = t.dispatch(supplement)
    await vi.waitFor(() => expect(t.registry.taskForMessage(supplement.messageId)).toBeDefined())
    const newTask = t.registry.taskForMessage(supplement.messageId)!
    expect(newTask).toMatchObject({ sessionKey: first.session.sessionKey, requesterOpenId: 'ou_alice', status: 'queued' })
    expect(newTask.id).not.toBe(first.task.id)
    expect(t.registry.getTask(first.task.id)).toMatchObject({ status: 'cancelled', stopReason: 'steered', startedAt: null })
    expect(t.state.allPrompts).toHaveLength(0)
    expect(t.state.cancelled).toEqual([])
    first.release()
    await Promise.all([first.result, amend])
    expect(t.state.allPrompts).toHaveLength(1)
    const prompt = t.state.allPrompts[0]!
    expect(prompt.text).toContain('等待接单回执的原事项 A')
    expect(prompt.text).toContain('只看移动端，上周的数据不用了')
    expect(prompt.text).toContain('[任务补充]')
    expect(prompt.text).toContain('"run_status":"cancelled"')
    expect(prompt.text).toContain('"stop_reason":"steered"')
    expect(prompt.text).not.toContain('"run_status":"done"')
    expect(t.registry.getSessionByAcpId(prompt.sessionId)?.sessionKey).toBe(first.session.sessionKey)
    expect(t.registry.getSession(first.session.sessionKey)?.cwd).toBe(first.session.cwd)
    expect(t.registry.getTask(first.task.id)).toMatchObject({ status: 'cancelled', stopReason: 'steered', startedAt: null })
    expect(t.registry.getTask(newTask.id)?.status).toBe('done')
    expect(t.feishu.reactionsOn(first.message.messageId)).toEqual([])
    expect(t.feishu.reactionsOn(supplement.messageId)).not.toContain('OnIt')
    expect(t.feishu.answers()).toEqual(['原请求结合补充后的唯一结果'])
  })

  it('preserves A B and C through two queued amendments in an already warm ACP session', async () => {
    const t = setup()
    const warmMessage = t.msg('先说明这个页面入口在哪里')
    await t.dispatch(warmMessage)
    const warmAcpId = t.state.allPrompts[0]!.sessionId
    const warmSession = t.registry.getSessionByAcpId(warmAcpId)!
    const original = 'CHAIN_A_ORIGINAL：检查项目计划中的三项风险，并保留原始依据链接'
    const additionB = 'CHAIN_B_ADDITION：只看移动端，不用处理桌面端'
    const additionC = 'CHAIN_C_ADDITION：再按优先级排序，先列最高的一项'
    t.classify.mockImplementationOnce(async (input) => {
      const target = input.candidates.find(candidate => candidate.ref === input.message.replyToRef)
      expect(target?.status).toBe('done')
      return { kind: 'amend', targetRef: target!.ref }
    })
    const first = await holdInitialAcknowledgment(t, original, { rootId: warmMessage.messageId, parentId: warmMessage.messageId })
    expect(first.session.sessionKey).toBe(warmSession.sessionKey)
    expect(first.session.acpSessionId).toBe(warmAcpId)
    t.classify.mockClear()
    t.classify.mockImplementation(async (input) => {
      const target = input.candidates.find((candidate) => candidate.ref === input.message.replyToRef)
      expect(target?.status).toBe('queued')
      return { kind: 'amend', targetRef: target!.ref }
    })
    t.state.script = [{ kind: 'text', text: 'CHAIN_C_ONLY_FINAL_RESULT' }]
    const secondMessage = t.msg(additionB, { rootId: warmMessage.messageId, parentId: first.message.messageId })
    const second = t.dispatch(secondMessage)
    await vi.waitFor(() => expect(t.registry.taskForMessage(secondMessage.messageId)).toBeDefined())
    const secondTask = t.registry.taskForMessage(secondMessage.messageId)!
    const thirdMessage = t.msg(additionC, { rootId: warmMessage.messageId, parentId: secondMessage.messageId })
    const third = t.dispatch(thirdMessage)
    await vi.waitFor(() => expect(t.registry.taskForMessage(thirdMessage.messageId)).toBeDefined())
    const thirdTask = t.registry.taskForMessage(thirdMessage.messageId)!
    for (const replaced of [first.task, secondTask]) {
      expect(t.registry.getTask(replaced.id)).toMatchObject({ status: 'cancelled', stopReason: 'steered', startedAt: null })
    }
    expect(thirdTask).toMatchObject({ sessionKey: warmSession.sessionKey, requesterOpenId: 'ou_alice', status: 'queued' })
    expect(t.state.allPrompts).toHaveLength(1) // Only the warm-up has reached ACP.
    expect(t.state.cancelled).toEqual([])
    first.release()
    await Promise.all([first.result, second, third])

    expect(t.classify).toHaveBeenCalledTimes(2)
    expect(t.state.allPrompts).toHaveLength(2)
    const finalPrompt = t.state.allPrompts[1]!
    expect(finalPrompt.sessionId).toBe(warmAcpId)
    expect(t.registry.getSession(warmSession.sessionKey)?.cwd).toBe(warmSession.cwd)
    expect(finalPrompt.text).toContain(original)
    expect(finalPrompt.text).toContain(additionB)
    expect(finalPrompt.text).toContain(additionC)
    expect(t.registry.getTask(thirdTask.id)?.status).toBe('done')
    const warmTask = t.registry.taskForMessage(warmMessage.messageId)!
    for (const task of [first.task, secondTask, thirdTask]) {
      expect(t.registry.taskWork.get(task.id)).toEqual(t.registry.taskWork.get(warmTask.id))
    }
    for (const replaced of [first.task, secondTask]) {
      expect(t.registry.getTask(replaced.id)).toMatchObject({ status: 'cancelled', stopReason: 'steered', startedAt: null })
    }
    expect(t.state.cancelled).toEqual([])
    expect(t.feishu.reactionsOn(first.message.messageId)).toEqual([])
    expect(t.feishu.reactionsOn(secondMessage.messageId)).toEqual([])
    expect(t.feishu.reactionsOn(thirdMessage.messageId)).not.toContain('OnIt')
    expect(t.feishu.answers().slice(1)).toEqual(['CHAIN_C_ONLY_FINAL_RESULT'])
  })

  it('stops the active amendment B when the user replies to its original replaced request A', async () => {
    const t = setup()
    const first = await holdInitialAcknowledgment(t)
    const entered = t.barrier()
    const releaseWorker = t.barrier()
    t.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await releaseWorker.promise } },
      { kind: 'text', text: 'REPLACEMENT_B_MUST_NOT_PUBLISH_AFTER_STOP' }]
    decideTarget(t, 'amend')
    const addition = t.msg('这件只需要移动端结果', { rootId: first.message.messageId, parentId: first.message.messageId })
    const amended = t.dispatch(addition)
    await vi.waitFor(() => expect(t.registry.taskForMessage(addition.messageId)).toBeDefined())
    const secondTask = t.registry.taskForMessage(addition.messageId)!
    first.release()
    await entered.promise
    const acpId = t.state.allPrompts[0]!.sessionId
    const originalBefore = t.registry.getTask(first.task.id)!
    expect(originalBefore).toMatchObject({ status: 'cancelled', stopReason: 'steered', startedAt: null })
    expect(t.registry.getTask(secondTask.id)?.status).toBe('running')
    t.classify.mockImplementationOnce(async (input) => {
      const replied = input.candidates.find((candidate) => candidate.ref === input.message.replyToRef)
      expect(replied?.status).toBe('running')
      expect(input.candidates.filter((candidate) => candidate.status === 'running')).toEqual([replied])
      return { kind: 'stop', targetRef: replied!.ref }
    })
    const stopOriginal = t.msg('这件先停一下', { rootId: first.message.messageId, parentId: first.message.messageId })
    await classified(t, stopOriginal)
    expect(t.registry.getTask(first.task.id)).toEqual(originalBefore)
    expect(t.registry.getTask(secondTask.id)).toMatchObject({ status: 'running', stopReason: 'user_requested' })
    expect(t.state.cancelled).toEqual([acpId])
    expect(t.tasks()).toHaveLength(2)
    expect(t.controlReplies(stopOriginal)).toHaveLength(1)
    expect(JSON.stringify(t.controlReplies(stopOriginal))).toMatch(/请求停止|停止中/)
    releaseWorker.resolve()
    await Promise.all([first.result, amended])
    expect(t.registry.getTask(secondTask.id)?.status).toBe('cancelled')
    expect(t.state.allPrompts).toHaveLength(1)
    expect(JSON.stringify(t.feishu.sent)).not.toContain('REPLACEMENT_B_MUST_NOT_PUBLISH_AFTER_STOP')
  })

  it('amends a durable queued inbound task without cancelling the other current task in that session', async () => {
    const t = setup()
    const current = await holdTask(t, '同会话正在执行的事项 A')
    // Model a persisted accepted inbound task without inventing a running worker
    // for it. A current task in this session belongs to a different captured turn.
    const queuedMessage = t.msg('QUEUED_B_ORIGINAL_REQUEST', { rootId: current.message.messageId })
    const queued = t.registry.createTaskOnce({ sessionKey: current.session.sessionKey,
      messageId: queuedMessage.messageId, requesterOpenId: 'ou_alice', prompt: 'QUEUED_B_ORIGINAL_REQUEST' }).task
    t.classify.mockImplementationOnce(async (input) => {
      expect(input.candidates).toHaveLength(2)
      const target = input.candidates.find((candidate) => candidate.ref === input.message.replyToRef)
      expect(target).toMatchObject({ title: 'QUEUED_B_ORIGINAL_REQUEST', status: 'queued' })
      return { kind: 'amend', targetRef: target!.ref }
    })
    t.state.script = [{ kind: 'text', text: 'B 的补充执行结果' }]
    const supplement = t.msg('B 还要补充平板端', { rootId: current.message.messageId, parentId: queuedMessage.messageId })
    const amend = t.dispatch(supplement)
    await vi.waitFor(() => expect(t.registry.taskForMessage(supplement.messageId)).toBeDefined())
    expect(t.registry.getTask(queued.id)).toMatchObject({ status: 'cancelled', stopReason: 'steered', startedAt: null })
    expect(t.registry.getTask(current.task.id)).toMatchObject({ status: 'running', stopReason: null })
    expect(t.state.cancelled).toEqual([])
    expect(t.state.allPrompts).toHaveLength(1)
    current.release()
    await Promise.all([current.result, amend])
    expect(t.registry.getTask(current.task.id)?.status).toBe('done')
    const continued = t.registry.taskForMessage(supplement.messageId)!
    expect(continued).toMatchObject({ sessionKey: current.session.sessionKey, status: 'done' })
    expect(t.registry.taskWork.get(continued.id)).toEqual(t.registry.taskWork.get(queued.id))
    expect(t.registry.taskWork.get(continued.id)).not.toEqual(t.registry.taskWork.get(current.task.id))
    expect(t.registry.listAmendedTasks(continued.id).map(task => task.id)).toEqual([queued.id])
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.state.allPrompts[1]?.sessionId).not.toBe(current.acpId)
    expect(t.state.resumed).not.toContain(current.acpId)
    expect(t.state.allPrompts[1]?.text).toContain('QUEUED_B_ORIGINAL_REQUEST')
    expect(t.state.allPrompts[1]?.text).toContain('B 还要补充平板端')
    expect(t.state.allPrompts[1]?.text).not.toContain('同会话正在执行的事项 A')
    expect(t.state.cancelled).toEqual([])
    expect(t.feishu.answers()).toEqual(['同会话正在执行的事项 A最终结果', 'B 的补充执行结果'])
  })

  it('answers progress without a new task, worker prompt, cancellation, or disclosure of drafts and command details', async () => {
    const t = setup({ maxConcurrent: 1 })
    const active = await holdTask(t, '合成代码核查', {}, [
      { kind: 'thought', text: 'PRIVATE_THOUGHT_CANARY' },
      { kind: 'tool', text: 'cat /private/SYNTHETIC_SECRET_PATH', toolKind: 'read' },
      { kind: 'text', text: 'UNDELIVERED_DRAFT_CANARY' },
    ])
    decideTarget(t, 'progress')
    const before = t.tasks()
    const query = t.msg('不用停，只问现在做到哪了？', { rootId: active.message.messageId })
    expect((await classified(t, query)).ok).toBe(true)
    expect(t.tasks()).toEqual(before)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.state.cancelled).toEqual([])
    expect(t.controlReplies(query)).toHaveLength(1)
    const classifiedInput = JSON.stringify(t.classify.mock.calls[0]![0])
    const reply = JSON.stringify(t.controlReplies(query))
    for (const canary of ['PRIVATE_THOUGHT_CANARY', 'SYNTHETIC_SECRET_PATH', 'UNDELIVERED_DRAFT_CANARY']) {
      expect(classifiedInput).not.toContain(canary)
      expect(reply).not.toContain(canary)
    }
    expect(t.receipts()).toHaveLength(1)
    active.release()
    expect((await active.result).ok).toBe(true)
    expect(t.registry.getTask(active.task.id)?.status).toBe('done')
  })

  it('stops only the selected ordinary task and leaves future responsibilities unchanged', async () => {
    const t = setup()
    const prompt = vi.spyOn(t.runtime, 'prompt')
    const responsibility = t.routines.add({ kind: 'schedule', ownerOpenId: 'ou_alice', spaceId: t.group.id,
      chatId: 'oc_group', chatType: 'group', name: '合成未来日报', prompt: '以后再汇总', schedule: { type: 'interval', everyMinutes: 30 } })
    const active = await holdTask(t, '合成停止目标', {}, [{ kind: 'text', text: 'STOPPED_DRAFT_CANARY' }])
    let atAbort: ReturnType<Registry['getTask']>
    prompt.mock.calls[0]?.[2]?.signal?.addEventListener('abort', () => { atAbort = t.registry.getTask(active.task.id) }, { once: true })
    decideTarget(t, 'stop')
    const query = t.msg('先停一下这件事', { rootId: active.message.messageId })
    await classified(t, query)
    expect(t.state.cancelled).toContain(active.acpId)
    expect(atAbort).toMatchObject({ status: 'running', stopReason: 'user_requested', finishedAt: null })
    expect(t.tasks()).toHaveLength(1)
    expect(t.routines.get(responsibility.id)).toEqual(responsibility)
    expect(t.controlReplies(query)).toHaveLength(1)
    expect(JSON.stringify(t.controlReplies(query))).toMatch(/请求|停止中|中止中/)
    active.release()
    await active.result
    expect(t.registry.getTask(active.task.id)?.status).toBe('cancelled')
    expect(JSON.stringify(t.feishu.sent)).not.toContain('STOPPED_DRAFT_CANARY')
    expect(t.state.allPrompts).toHaveLength(1)
  })

  it('clarifies an ambiguous request without steering or creating work', async () => {
    const t = setup()
    const active = await holdTask(t)
    const before = t.tasks()
    const query = t.msg('那件事先等等', { rootId: active.message.messageId })
    await classified(t, query)
    expect(t.controlReplies(query)).toHaveLength(1)
    expect(t.tasks()).toEqual(before)
    expect(t.state.cancelled).toEqual([])
    expect(t.state.allPrompts).toHaveLength(1)
  })

  it('does not let a different member stop or implicitly steer another member\'s work', async () => {
    const t = setup()
    const active = await holdTask(t, 'Alice 的合成任务')
    t.classify.mockImplementation(async (input) => input.candidates.length
      ? { kind: 'stop', targetRef: input.candidates[0]!.ref } : { kind: 'clarify' })
    const query = t.msg('先停一下这件事', { rootId: active.message.messageId, senderOpenId: 'ou_bob' })
    const result = t.dispatch(query)
    await vi.waitFor(() => expect(t.classify.mock.calls.length + t.controlReplies(query).length).toBeGreaterThan(0))
    await result
    expect(t.state.cancelled).not.toContain(active.acpId)
    expect(t.registry.getTask(active.task.id)?.status).toBe('running')
    expect(t.state.allPrompts.filter((prompt) => prompt.sessionId === active.acpId)).toHaveLength(1)
  })

  it('does not apply a delayed decision for A to B after A finishes in the same discussion', async () => {
    const t = setup()
    const first = await holdTask(t, '合成任务 A')
    const classifying = t.barrier()
    const releaseDecision = t.barrier()
    t.classify.mockImplementationOnce(async (input) => {
      const targetRef = input.candidates[0]!.ref
      classifying.resolve()
      await releaseDecision.promise
      return { kind: 'stop', targetRef }
    })
    const stopA = t.dispatch(t.msg('先停下刚才的 A', { rootId: first.message.messageId }))
    await classifying.promise
    first.release()
    await first.result
    // A different member can start work in the now-idle discussion while Alice's
    // control classification awaits. Alice's own later ingress is serialized.
    const second = await holdTask(t, '合成任务 B', { rootId: first.message.messageId, senderOpenId: 'ou_bob' })
    expect(second.session.sessionKey).toBe(first.session.sessionKey)
    releaseDecision.resolve()
    await stopA
    expect(t.registry.getTask(first.task.id)?.status).toBe('done')
    expect(t.registry.getTask(second.task.id)?.status).toBe('running')
    expect(t.state.cancelled).toEqual([])
    second.release()
    await second.result
    expect(t.registry.getTask(second.task.id)?.status).toBe('done')
  })

  it('resolves an explicit reply to finished A without stopping the newer active B', async () => {
    const t = setup()
    const first = t.msg('合成任务 A')
    await t.dispatch(first)
    const firstTask = t.registry.getTask(1)!
    t.classify.mockResolvedValueOnce({ kind: 'work_request' }) // Real prior text is now offered for optional material reference.
    const second = await holdTask(t, '合成任务 B', { rootId: first.messageId })
    t.classify.mockImplementation(async (input) => {
      const replied = input.candidates.find((candidate) => candidate.ref === input.message.replyToRef)
      expect(replied).toMatchObject({ title: '合成任务 A', status: 'done' })
      expect(input.candidates.some((candidate) => candidate.title === '合成任务 B')).toBe(true)
      return { kind: 'stop', targetRef: replied!.ref }
    })
    const query = t.msg('先停这件事', { parentId: first.messageId, rootId: first.messageId })
    await classified(t, query)
    expect(t.registry.getTask(firstTask.id)?.status).toBe('done')
    expect(t.registry.getTask(second.task.id)?.status).toBe('running')
    expect(t.state.cancelled).toEqual([])
    expect(JSON.stringify(t.controlReplies(query))).toContain('后续自动跟进')
    expect(JSON.stringify(t.controlReplies(query))).not.toContain('已请求停止')
    expect(t.registry.workContexts.get(t.registry.taskWork.get(firstTask.id)!.key)?.pauseReasons).toEqual([expect.objectContaining({reason:'run_stop'})])
    expect(t.registry.workContexts.get(t.registry.taskWork.get(second.task.id)!.key)?.pauseReasons).toEqual([])
    expect(t.tasks()).toHaveLength(2)
  })

  it('reports an approval wait and then stops it without approving or starting a second worker turn', async () => {
    const t = setup()
    t.state.script = [{ kind: 'permission', text: '合成写入申请', toolKind: 'execute' }, { kind: 'text', text: 'UNAPPROVED_RESULT_CANARY' }]
    const message = t.msg('合成需要确认的操作')
    const running = t.dispatch(message)
    await vi.waitFor(() => expect(t.feishu.of('replyCard')).toHaveLength(1))
    decideTarget(t, 'progress')
    const query = t.msg('卡在哪一步？', { rootId: message.messageId })
    await classified(t, query)
    expect(JSON.stringify(t.controlReplies(query))).toMatch(/等.*确认|等待.*确认/)
    expect(t.state.permissionDecisions).toEqual([])
    expect(t.state.cancelled).toEqual([])
    decideTarget(t, 'stop')
    await classified(t, t.msg('这次先停下', { rootId: message.messageId }))
    await running
    expect(t.state.permissionDecisions).toEqual(['cancelled'])
    expect(t.registry.getTask(1)?.status).toBe('cancelled')
    expect(t.tasks()).toHaveLength(1)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(JSON.stringify(t.feishu.sent)).not.toContain('UNAPPROVED_RESULT_CANARY')
  })

  it.each(['archive', 'remove-member'] as const)('rechecks authorization after classification awaits: %s', async (change) => {
    const t = setup()
    const active = await holdTask(t)
    const classifying = t.barrier()
    const releaseDecision = t.barrier()
    t.classify.mockImplementation(async (input) => {
      classifying.resolve()
      await releaseDecision.promise
      return { kind: 'stop', targetRef: input.candidates[0]!.ref }
    })
    const query = t.msg('先停一下', { rootId: active.message.messageId })
    const result = t.dispatch(query)
    await classifying.promise
    if (change === 'archive') t.spaces.archive(t.group.id)
    else { t.spaces.removeMember(t.group.id, 'ou_alice'); t.feishu.members.get('oc_group')!.delete('ou_alice') }
    releaseDecision.resolve()
    await result
    expect(t.state.cancelled).toEqual([])
    expect(t.controlReplies(query)).toHaveLength(0)
    expect(t.tasks()).toHaveLength(1)
  })

  it('rejects an unknown target reference without guessing the only active task', async () => {
    const t = setup()
    const active = await holdTask(t)
    t.classify.mockResolvedValue({ kind: 'stop', targetRef: 'model-invented-ref' })
    await classified(t, t.msg('停止那个任务', { rootId: active.message.messageId }))
    expect(t.state.cancelled).toEqual([])
    expect(t.registry.getTask(active.task.id)?.status).toBe('running')
    expect(t.tasks()).toHaveLength(1)
  })

  it('keeps work running when classification fails instead of falling back to a steering prompt', async () => {
    const t = setup()
    const active = await holdTask(t)
    t.classify.mockRejectedValue(new Error('synthetic classification timeout'))
    const query = t.msg('先等等', { rootId: active.message.messageId })
    await classified(t, query)
    expect(t.controlReplies(query)).toHaveLength(1)
    expect(t.state.cancelled).toEqual([])
    expect(t.tasks()).toHaveLength(1)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(JSON.stringify(t.controlReplies(query))).not.toContain('synthetic classification timeout')
  })

  it('cancels the budget wrap-up prompt rather than the already-aborted main prompt', async () => {
    const t = setup({ maxSteps: 1 })
    const enteredWrap = t.barrier()
    const releaseWrap = t.barrier()
    t.state.script = [{ kind: 'hook', run: () => { t.state.script = [
      { kind: 'text', text: 'WRAP_UP_DRAFT_CANARY' },
      { kind: 'hook', run: async () => { enteredWrap.resolve(); await releaseWrap.promise } },
    ] } }, { kind: 'tool', text: '合成读取一' }, { kind: 'tool', text: '合成读取二' }]
    const prompt = vi.spyOn(t.runtime, 'prompt')
    const message = t.msg('合成需要收尾的代码核查')
    const running = t.dispatch(message)
    await enteredWrap.promise
    const mainSignal = prompt.mock.calls[0]?.[2]?.signal
    const wrapSignal = prompt.mock.calls[1]?.[2]?.signal
    expect(mainSignal?.aborted).toBe(true)
    expect(wrapSignal).toBeDefined()
    expect(wrapSignal).not.toBe(mainSignal)
    expect(wrapSignal?.aborted).toBe(false)
    decideTarget(t, 'stop')
    await classified(t, t.msg('不用继续了，停下', { rootId: message.messageId }))
    expect(wrapSignal?.aborted).toBe(true)
    releaseWrap.resolve()
    await running
    expect(t.registry.getTask(1)?.status).toBe('cancelled')
    expect(JSON.stringify(t.feishu.sent)).not.toContain('WRAP_UP_DRAFT_CANARY')
    expect(t.state.allPrompts).toHaveLength(2)
  })

  it('deduplicates concurrent and later control-message deliveries without reclassifying or sending twice', async () => {
    const t = setup()
    const active = await holdTask(t)
    const classifying = t.barrier()
    const releaseDecision = t.barrier()
    t.classify.mockImplementation(async (input) => {
      classifying.resolve()
      await releaseDecision.promise
      return { kind: 'progress', targetRef: input.candidates[0]!.ref }
    })
    const query = t.msg('进度怎样了？', { rootId: active.message.messageId })
    const first = t.dispatch(query)
    await classifying.promise
    const duplicate = t.dispatch({ ...query, eventId: 'same-message-new-event' })
    releaseDecision.resolve()
    await Promise.all([first, duplicate])
    await t.dispatch(query)
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(t.receipts()).toHaveLength(1)
    expect(t.controlReplies(query)).toHaveLength(1)
    expect(t.tasks()).toHaveLength(1)
    expect(t.state.cancelled).toEqual([])
  })

  it('does not turn a queued duplicate progress message into work after the first classifier outlives its worker', async () => {
    const t = setup()
    const active = await holdTask(t)
    const checkingMembership = t.barrier()
    const releaseMembership = t.barrier()
    const classifying = t.barrier()
    const releaseDecision = t.barrier()
    const actualMembers = t.feishu.chatMemberOpenIds.bind(t.feishu)
    vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementationOnce(async (...args) => {
      checkingMembership.resolve()
      await releaseMembership.promise
      return actualMembers(...args)
    })
    const receiptChecks = vi.spyOn(IngressReceipts.prototype, 'has')
    t.classify.mockImplementation(async (input) => {
      classifying.resolve()
      await releaseDecision.promise
      return { kind: 'progress', targetRef: input.candidates[0]!.ref }
    })
    const query = t.msg('进度到哪了？', { rootId: active.message.messageId })
    const first = t.dispatch(query)
    await checkingMembership.promise
    const checksBeforeDuplicate = receiptChecks.mock.calls.filter(([id]) => id === query.messageId).length
    const duplicate = t.dispatch({ ...query, eventId: 'duplicate-before-first-claim' })
    // Observe the real pre-queue receipt lookup, not a timer: both deliveries have
    // passed admission while the first membership request still prevents claim.
    await vi.waitFor(() => expect(receiptChecks.mock.calls.filter(([id]) => id === query.messageId).length).toBeGreaterThan(checksBeforeDuplicate))
    expect(t.receipts()).toEqual([])
    releaseMembership.resolve()
    await classifying.promise
    active.release()
    await active.result
    expect(t.registry.getTask(active.task.id)?.status).toBe('done')
    releaseDecision.resolve()
    await Promise.all([first, duplicate])
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(t.controlReplies(query)).toHaveLength(1)
    expect(t.receipts()).toHaveLength(1)
    expect(t.tasks()).toHaveLength(1)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.state.cancelled).toEqual([])
  })

  it('starts explicit new work in a separate session and writable directory while the original worker continues', async () => {
    const t = setup()
    const first = await holdTask(t, '合成原任务 A', { threadId: 'omt_shared' })
    writeFileSync(join(first.session.cwd, 'prior-task-only.txt'), 'SYNTHETIC_PRIOR_WORKSPACE_CANARY')
    t.classify.mockResolvedValue({ kind: 'new_work' })
    const second = await holdTask(t, '另一件独立事项 B', { rootId: first.message.messageId, threadId: 'omt_shared' })
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(second.session.sessionKey).not.toBe(first.session.sessionKey)
    expect(second.session.cwd).not.toBe(first.session.cwd)
    expect(second.acpId).not.toBe(first.acpId)
    expect(existsSync(join(second.session.cwd, 'prior-task-only.txt'))).toBe(false)
    expect(t.registry.getSession(first.session.sessionKey)?.status).toBe('running')
    expect(t.registry.getTask(first.task.id)?.status).toBe('running')
    expect(t.state.cancelled).toEqual([])
    expect(t.state.allPrompts).toHaveLength(2)
    second.release()
    await second.result
    expect(t.registry.getTask(second.task.id)?.status).toBe('done')
    expect(t.registry.getTask(first.task.id)?.status).toBe('running')
    first.release()
    await first.result
    expect(t.registry.getTask(first.task.id)?.status).toBe('done')
  })

  it('amends only the captured target while another worker in the same topic keeps running', async () => {
    const t = setup()
    const first = await holdTask(t, '合成原任务 A', { threadId: 'omt_shared' })
    t.classify.mockResolvedValueOnce({ kind: 'new_work' })
    const second = await holdTask(t, '合成独立任务 B', { rootId: first.message.messageId, threadId: 'omt_shared' })
    t.classify.mockImplementation(async (input) => {
      const target = input.candidates.find((candidate) => candidate.title === '合成原任务 A')
      expect(input.candidates).toHaveLength(2)
      expect(target).toBeDefined()
      return { kind: 'amend', targetRef: target!.ref }
    })
    t.state.script = [{ kind: 'text', text: '已按补充完成 A' }]
    const amend = t.dispatch(t.msg('A 只需要看上周，B 继续', { rootId: first.message.messageId, parentId: first.message.messageId, threadId: 'omt_shared' }))
    await vi.waitFor(() => expect(t.state.cancelled).toContain(first.acpId))
    expect(t.state.cancelled).not.toContain(second.acpId)
    first.release()
    await Promise.all([first.result, amend])
    expect(t.registry.getTask(first.task.id)).toMatchObject({ status: 'cancelled', stopReason: 'steered' })
    expect(t.registry.getTask(second.task.id)?.status).toBe('running')
    const followups = t.registry.listTasks(first.session.sessionKey)
    expect(followups).toHaveLength(2)
    expect(followups[1]).toMatchObject({ status: 'done', requesterOpenId: 'ou_alice' })
    expect(t.state.allPrompts.filter((prompt) => prompt.sessionId === first.acpId)).toHaveLength(2)
    expect(t.state.allPrompts.filter((prompt) => prompt.sessionId === second.acpId)).toHaveLength(1)
    expect(t.feishu.answers()).toContain('已按补充完成 A')
    expect(t.receipts()).toHaveLength(2)
  })

  it.each(['done', 'failed'] as const)('continues an explicitly replied %s B as a new task in B while A keeps running', async (status) => {
    const t = setup()
    const first = await holdTask(t, '仍在运行的事项 A', { threadId: 'omt_amend_finished' })
    t.classify.mockResolvedValueOnce({ kind: 'new_work' })
    const secondEntered = t.barrier()
    const releaseSecond = t.barrier()
    t.state.script = [
      { kind: 'hook', run: async () => { secondEntered.resolve(); await releaseSecond.promise } },
      ...(status === 'failed'
        ? [{ kind: 'hook' as const, run: () => { throw new Error('synthetic B worker failure') } }]
        : [{ kind: 'text' as const, text: '事项 B 第一轮结果' }]),
    ]
    const secondMessage = t.msg('独立事项 B', { rootId: first.message.messageId, threadId: 'omt_amend_finished' })
    const secondResult = t.dispatch(secondMessage)
    await secondEntered.promise
    const secondTask = t.registry.taskForMessage(secondMessage.messageId)!
    const secondSession = t.registry.getSession(secondTask.sessionKey)!
    const secondAcpId = t.state.allPrompts.at(-1)!.sessionId
    releaseSecond.resolve()
    await secondResult
    const terminalTask = t.registry.getTask(secondTask.id)!
    expect(terminalTask.status).toBe(status)
    expect(t.registry.getTask(first.task.id)?.status).toBe('running')

    t.classify.mockImplementationOnce(async (input) => {
      const target = input.candidates.find((candidate) => candidate.ref === input.message.replyToRef)
      expect(target).toMatchObject({ title: '独立事项 B', status })
      expect(input.candidates.some((candidate) => candidate.title === '仍在运行的事项 A')).toBe(true)
      return { kind: 'amend', targetRef: target!.ref }
    })
    t.state.script = [{ kind: 'text', text: '事项 B 补充后的结果' }]
    const supplement = t.msg('这件再补上移动端情况', {
      rootId: first.message.messageId, parentId: secondMessage.messageId, threadId: 'omt_amend_finished',
    })
    await classified(t, supplement)

    const newTask = t.registry.taskForMessage(supplement.messageId)!
    expect(newTask).toMatchObject({ sessionKey: secondTask.sessionKey, messageId: supplement.messageId,
      requesterOpenId: 'ou_alice', status: 'done' })
    expect(newTask.id).not.toBe(secondTask.id)
    expect(t.registry.getTask(secondTask.id)).toEqual(terminalTask)
    expect(t.registry.listTasks(secondTask.sessionKey)).toHaveLength(2)
    expect(t.registry.getSession(secondTask.sessionKey)?.cwd).toBe(secondSession.cwd)
    expect(t.state.allPrompts.at(-1)?.sessionId).toBe(secondAcpId)
    expect(t.state.allPrompts.filter((prompt) => prompt.sessionId === secondAcpId)).toHaveLength(2)
    expect(t.state.allPrompts.filter((prompt) => prompt.sessionId === first.acpId)).toHaveLength(1)
    expect(t.registry.getTask(first.task.id)?.status).toBe('running')
    expect(t.state.cancelled).toEqual([])
    expect(t.feishu.answers()).toContain('事项 B 补充后的结果')
    expect(t.receipts()).toHaveLength(2)
  })

  it('continues A with a new inbound task when A finishes while its amend classification awaits', async () => {
    const t = setup()
    const first = await holdTask(t, '即将结束的事项 A')
    const classifying = t.barrier()
    const releaseDecision = t.barrier()
    t.classify.mockImplementationOnce(async (input) => {
      expect(input.candidates).toHaveLength(1)
      const targetRef = input.candidates[0]!.ref
      classifying.resolve()
      await releaseDecision.promise
      return { kind: 'amend', targetRef }
    })
    const supplement = t.msg('再补充移动端情况', { rootId: first.message.messageId, parentId: first.message.messageId })
    const amend = t.dispatch(supplement)
    await classifying.promise
    first.release()
    await first.result
    const terminalTask = t.registry.getTask(first.task.id)!
    expect(terminalTask.status).toBe('done')
    t.state.script = [{ kind: 'text', text: 'A 接着补充的结果' }]
    releaseDecision.resolve()
    await amend

    const newTask = t.registry.taskForMessage(supplement.messageId)!
    expect(newTask).toMatchObject({ sessionKey: first.session.sessionKey, messageId: supplement.messageId,
      requesterOpenId: 'ou_alice', status: 'done' })
    expect(newTask.id).not.toBe(first.task.id)
    expect(t.registry.getTask(first.task.id)).toEqual(terminalTask)
    expect(t.registry.listTasks(first.session.sessionKey)).toHaveLength(2)
    expect(t.registry.getSession(first.session.sessionKey)?.cwd).toBe(first.session.cwd)
    expect(t.state.allPrompts.map((prompt) => prompt.sessionId)).toEqual([first.acpId, first.acpId])
    expect(t.state.cancelled).toEqual([])
    expect(t.feishu.answers()).toContain('A 接着补充的结果')
    expect(t.receipts()).toHaveLength(1)
  })

  it('rejects delayed amend A after a newer task has already completed in A\'s session', async () => {
    const t = setup()
    const first = await holdTask(t, '旧轮事项 A')
    const classifying = t.barrier()
    const releaseDecision = t.barrier()
    t.classify.mockImplementationOnce(async (input) => {
      const targetRef = input.candidates[0]!.ref
      classifying.resolve()
      await releaseDecision.promise
      return { kind: 'amend', targetRef }
    })
    const supplement = t.msg('给刚才 A 补充移动端情况', { rootId: first.message.messageId, parentId: first.message.messageId })
    const amend = t.dispatch(supplement)
    await classifying.promise
    first.release()
    await first.result
    // Another member's ingress is independent of Alice's pending classification.
    // Complete this newer turn too: absence of a running worker alone cannot make A current again.
    const second = await holdTask(t, '另一成员接续的新一轮', { rootId: first.message.messageId, senderOpenId: 'ou_bob' })
    expect(second.session.sessionKey).toBe(first.session.sessionKey)
    second.release()
    await second.result
    const before = t.tasks()
    expect(t.registry.getTask(second.task.id)?.status).toBe('done')
    t.state.script = [{ kind: 'text', text: 'STALE_AMEND_MUST_NOT_RUN' }]
    releaseDecision.resolve()
    await amend

    expect(t.tasks()).toEqual(before)
    expect(t.registry.taskForMessage(supplement.messageId)).toBeUndefined()
    expect(t.registry.listTasks(first.session.sessionKey)).toHaveLength(2)
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.state.cancelled).toEqual([])
    expect(t.controlReplies(supplement)).toHaveLength(1)
    expect(JSON.stringify(t.controlReplies(supplement))).toMatch(/已经结束|已结束|哪件事|状态.*变化.*回复/)
    expect(JSON.stringify(t.feishu.sent)).not.toContain('STALE_AMEND_MUST_NOT_RUN')
    expect(t.receipts()).toHaveLength(1)
  })

  it('targets B for progress and stop with only root and parent identifiers while A continues', async () => {
    const t = setup()
    const first = await holdTask(t, '无话题 ID 的任务 A')
    t.classify.mockResolvedValueOnce({ kind: 'new_work' })
    const second = await holdTask(t, '无话题 ID 的任务 B', { rootId: first.message.messageId })
    expect(first.session.threadId).toBeNull()
    expect(second.session.threadId).toBeNull()
    for (const kind of ['progress', 'stop'] as const) {
      t.classify.mockImplementation(async (input) => {
        const target = input.candidates.find((candidate) => candidate.ref === input.message.replyToRef)
        expect(target?.title).toBe('无话题 ID 的任务 B')
        return { kind, targetRef: target!.ref }
      })
      const query = t.msg(kind === 'progress' ? '这件事做到哪了？' : '这件先停一下',
        { rootId: first.message.messageId, parentId: second.message.messageId })
      await classified(t, query)
      expect(t.controlReplies(query)).toHaveLength(1)
      expect(t.registry.getTask(first.task.id)?.status).toBe('running')
      expect(t.state.cancelled).not.toContain(first.acpId)
      if (kind === 'progress') expect(t.state.cancelled).not.toContain(second.acpId)
    }
    second.release()
    await second.result
    expect(t.registry.getTask(second.task.id)?.status).toBe('cancelled')
    expect(t.tasks()).toHaveLength(2)
  })

  it('continues completed B through an explicit reply even when its root still points to completed A', async () => {
    const t = setup()
    const first = await holdTask(t, '原根事项 A')
    t.classify.mockResolvedValueOnce({ kind: 'new_work' })
    const second = await holdTask(t, '独立事项 B', { rootId: first.message.messageId })
    first.release(); second.release()
    await Promise.all([first.result, second.result])
    t.classify.mockClear()
    t.classify.mockImplementationOnce(async input => {
      expect(input.candidates).toHaveLength(2)
      const target = input.candidates.find(candidate => candidate.ref === input.message.replyToRef)
      expect(target).toMatchObject({ title: '独立事项 B', status: 'done' })
      return { kind: 'amend', targetRef: target!.ref }
    })
    t.state.script = [{ kind: 'text', text: '继续 B 的具体结果' }]
    const reply = t.msg('补充一下这个结果', { rootId: first.message.messageId, parentId: second.message.messageId })
    await t.dispatch(reply)
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(t.state.allPrompts.at(-1)?.sessionId).toBe(second.acpId)
    expect(t.state.allPrompts.filter((prompt) => prompt.sessionId === first.acpId)).toHaveLength(1)
    expect(t.registry.listTasks(second.session.sessionKey)).toHaveLength(2)
    expect(t.registry.getSession(second.session.sessionKey)?.cwd).toBe(second.session.cwd)
    const task = t.registry.taskForMessage(reply.messageId)!
    const work = t.registry.taskWork.get(task.id)
    expect(work).toEqual(t.registry.taskWork.get(second.task.id))
    expect(work).not.toEqual(t.registry.taskWork.get(first.task.id))
    const before = { tasks: t.tasks(), prompts: t.state.allPrompts.length, answers: t.feishu.answers() }
    await t.dispatch(reply)
    expect(t.registry.taskWork.get(task.id)).toEqual(work)
    expect({ tasks: t.tasks(), prompts: t.state.allPrompts.length, answers: t.feishu.answers() }).toEqual(before)
    expect(t.classify).toHaveBeenCalledTimes(1)
  })

  it('keeps an explicit new_work independent even when replying to a completed request in an idle discussion', async () => {
    const t = setup(), firstMessage = t.msg('整理本周的项目风险')
    await t.dispatch(firstMessage)
    const first = t.registry.taskForMessage(firstMessage.messageId)!
    const firstSession = t.registry.getSession(first.sessionKey)!
    t.classify.mockImplementationOnce(async input => {
      expect(input.candidates).toHaveLength(1)
      const target = input.candidates.find(candidate => candidate.ref === input.message.replyToRef)
      expect(target?.status).toBe('done')
      return { kind: 'new_work' }
    })
    const nextMessage = t.msg('另外，起草下周培训邀请', { rootId: firstMessage.messageId, parentId: firstMessage.messageId })
    await t.dispatch(nextMessage)
    const next = t.registry.taskForMessage(nextMessage.messageId)!
    expect(next.status).toBe('done')
    expect(next.sessionKey).not.toBe(first.sessionKey)
    expect(t.registry.getSession(next.sessionKey)?.cwd).not.toBe(firstSession.cwd)
    expect(t.registry.taskWork.get(next.id)).toEqual({ key: `task:${next.id}`, rootTaskId: next.id })
    expect(t.registry.taskWork.get(next.id)).not.toEqual(t.registry.taskWork.get(first.id))
    expect(t.registry.listAmendedTasks(next.id)).toEqual([])
    const before = t.tasks()
    await t.dispatch(nextMessage)
    expect(t.tasks()).toEqual(before)
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(t.state.allPrompts).toHaveLength(2)
  })

  it('passes domain control of completed work to a new task without inheriting its execution or losing the request', async () => {
    const t = setup(), original = t.msg('帮我记录隐藏按钮的建议')
    await t.dispatch(original)
    const prior = t.registry.taskForMessage(original.messageId)!
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    const body = '这条建议先不跟了，保留记录。提醒也继续保持暂停。'
    const control = t.msg(body,
      { rootId: original.messageId, parentId: original.messageId })
    await t.dispatch(control)
    const task = t.registry.taskForMessage(control.messageId)!
    expect(task).toMatchObject({ status: 'done', sessionKey: prior.sessionKey, prompt: body })
    expect(t.registry.getTask(prior.id)?.status).toBe('done')
    expect(t.registry.listAmendedTasks(task.id)).toEqual([])
    expect(t.registry.taskWork.get(task.id)).not.toEqual(t.registry.taskWork.get(prior.id))
    expect(t.state.allPrompts.at(-1)?.text).toContain(body)
    expect(t.state.cancelled).toEqual([])
    expect(t.receipts()).toHaveLength(1)
    await t.dispatch(control)
    expect(t.state.allPrompts).toHaveLength(2)
  })

  it('queues a mixed work request without steering the existing run and delivers its full input once', async () => {
    const t = setup(), first = await holdTask(t, '正在处理已有建议')
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    const body = '停掉原建议的跟进，再给另一条建议补上优先级。'
    const control = t.msg(body, { rootId: first.message.messageId })
    const next = t.dispatch(control)
    await vi.waitFor(() => expect(t.registry.taskForMessage(control.messageId)?.status).toBe('queued'))
    expect(t.registry.getTask(first.task.id)?.status).toBe('running')
    expect(t.state.cancelled).toEqual([])
    t.state.script = [{ kind: 'text', text: '两个操作的实际结果' }]
    first.release()
    await Promise.all([first.result, next])
    const task = t.registry.taskForMessage(control.messageId)!
    expect(task).toMatchObject({ status: 'done', prompt: body })
    expect(t.registry.listAmendedTasks(task.id)).toEqual([])
    expect(t.state.allPrompts.at(-1)?.text).toContain(body)
    expect(t.state.cancelled).toEqual([])
  })

  async function deliveredQuestion(t: Fixture, hold = false) {
    const original = t.msg('请排查这条已授权的反馈', { tenantId: 'tenant-synthetic' })
    const sent = t.barrier(), release = t.barrier()
    let receipt!: AskBugQuestionReceipt
    t.state.script = [{ kind: 'hook', run: async () => {
      const task = t.registry.taskForMessage(original.messageId)!
      const bucket = t.bugs!.record({ spaceId: t.group.id, chatId: original.chatId, messageId: original.messageId,
        reporterOpenId: original.senderOpenId, title: '需要材料的合成案件', text: '真实原请求' }).bucket
      const actor = t.orchestrator.resolveActorForSession(task.sessionKey)!
      receipt = await t.orchestrator.askBugQuestion(task.sessionKey, actor.runId, { id: bucket.id, kind: 'info', question: '能提供日志吗？' })
      sent.resolve()
      if (hold) await release.promise
    } }, { kind: 'text', text: '我继续核查已有材料。' }]
    const result = t.dispatch(original)
    if (hold) await sent.promise
    else expect(await result).toMatchObject({ ok: true })
    expect(receipt.delivery_status).toMatch(/sent|confirmed/)
    return { original, receipt, originTask: t.registry.taskForMessage(original.messageId)!, result, release: release.resolve }
  }

  it('preserves an exact question reply inside a mixed work_request without inheriting the old execution', async () => {
    const t = setup({ feedback: true }), q = await deliveredQuestion(t, true)
    const reply = t.msg('日志拿不到；把明天的提醒也暂停。', {
      tenantId: 'tenant-synthetic', rootId: q.original.messageId, parentId: q.receipt.message_id,
    })
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    t.state.script = [{ kind: 'text', text: '已收到补充。' }]
    const next = t.dispatch(reply)
    await vi.waitFor(() => expect(t.registry.taskForMessage(reply.messageId)?.status).toBe('queued'))
    expect(t.registry.getTask(q.originTask.id)?.status).toBe('running')
    expect(t.state.cancelled).toEqual([])
    expect(t.state.allPrompts).toHaveLength(1)
    const task = t.registry.taskForMessage(reply.messageId)!
    const replies = t.questions!.replies(q.receipt.question_id)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ taskId: task.id, messageId: reply.messageId, outcome: 'pending' })
    expect(t.registry.taskWork.get(task.id)).not.toEqual(t.registry.taskWork.get(q.originTask.id))
    expect(t.registry.listAmendedTasks(task.id)).toEqual([])
    q.release()
    expect(await q.result).toMatchObject({ ok: true })
    expect(await next).toMatchObject({ ok: true })
    expect(t.registry.getTask(task.id)?.status).toBe('done')
    expect(t.state.cancelled).toEqual([])
    expect(t.state.allPrompts.at(-1)?.text).toContain('"current_reply_id":' + replies[0]!.id)
    expect(t.state.allPrompts.at(-1)?.text).toContain('日志拿不到；把明天的提醒也暂停。')
    await t.dispatch(reply)
    expect(t.questions!.replies(q.receipt.question_id)).toHaveLength(1)
    expect(t.state.allPrompts).toHaveLength(2)
  })

  it('keeps the durable pending reply if accepting its mixed work_request fails', async () => {
    const t = setup({ feedback: true }), q = await deliveredQuestion(t)
    const reply = t.msg('日志拿不到；把明天的提醒也暂停。', {
      tenantId: 'tenant-synthetic', rootId: q.original.messageId, parentId: q.receipt.message_id,
    })
    const waiting = new PendingQuestionReplies(t.registry.db)
    waiting.save(t.group.id, reply)
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    t.registry.db.exec(`CREATE TRIGGER fail_mixed_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'synthetic task creation failure'); END`)
    const result = await t.dispatch(reply)
    expect(result.ok).toBe(false)
    expect(t.registry.taskForMessage(reply.messageId)).toBeUndefined()
    expect(waiting.has(reply.messageId)).toBe(true)
    expect(t.questions!.replies(q.receipt.question_id)).toEqual([])
    t.registry.db.exec('DROP TRIGGER fail_mixed_task')
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    t.state.script = [{ kind: 'text', text: '已收到补充。' }]
    expect(await t.dispatch(reply)).toMatchObject({ ok: true })
    expect(waiting.has(reply.messageId)).toBe(false)
    expect(t.questions!.replies(q.receipt.question_id)).toHaveLength(1)
  })

  it('accepts a work_request replying to stopped feedback without classifying the same message twice', async () => {
    const t = setup({ feedback: true }), q = await deliveredQuestion(t)
    const bucketId = t.questions!.get(q.receipt.question_id)!.bucketId
    t.feedback!.stop({ feedbackId: bucketId, spaceId: t.group.id, chatId: q.original.chatId,
      chatType: 'group', openId: 'ou_alice', controllerTaskId: q.originTask.id })
    t.classify.mockResolvedValueOnce({ kind: 'work_request' }).mockResolvedValue({ kind: 'clarify' })
    t.state.script = [{ kind: 'text', text: '已核对提醒状态。' }]
    const control = t.msg('这条仍不跟进，保留记录；明天的提醒也保持暂停。', {
      tenantId: 'tenant-synthetic', rootId: q.original.messageId, parentId: q.original.messageId,
    })
    expect(await t.dispatch(control)).toMatchObject({ ok: true })
    expect(t.classify).toHaveBeenCalledTimes(1)
    const task = t.registry.taskForMessage(control.messageId)
    expect(task).toMatchObject({ status: 'done', sessionKey: q.originTask.sessionKey })
    expect(t.registry.taskWork.get(task!.id)).not.toEqual(t.registry.taskWork.get(q.originTask.id))
    expect(t.registry.listAmendedTasks(task!.id)).toEqual([])
    expect(t.bugs!.get(bucketId)?.intakePhase).toBe('cancelled')
    expect(t.state.allPrompts.at(-1)?.text).toContain('这条仍不跟进，保留记录；明天的提醒也保持暂停。')
    await t.dispatch(control)
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(t.state.allPrompts).toHaveLength(2)
  })

  it('keeps A and B in one private conversation: an unquoted follow-up continues B, a quote reply continues A', async () => {
    const t = setup()
    const dm = { chatId: 'oc_dm', chatType: 'p2p' as const, mentions: [] }
    t.classify.mockResolvedValueOnce({ kind: 'work_request' }) // Idle DM also admits explicit memory intent.
    const first = await holdTask(t, '私聊事项 A', dm)
    t.classify.mockResolvedValueOnce({ kind: 'new_work' })
    const secondMessage = t.msg('私聊另一事项 B', dm)
    const secondRun = t.dispatch(secondMessage)
    await vi.waitFor(() => expect(t.registry.taskForMessage(secondMessage.messageId)?.status).toBe('queued'))
    first.release()
    await Promise.all([first.result, secondRun])
    const second = t.registry.taskForMessage(secondMessage.messageId)!
    expect(second.sessionKey).toBe(first.session.sessionKey)
    expect(t.registry.taskWork.get(second.id)).not.toEqual(t.registry.taskWork.get(first.task.id))
    t.classify.mockClear()
    t.state.script = [{ kind: 'text', text: '合成接续答案' }]
    t.classify.mockImplementationOnce(async input => ({ kind: 'amend', targetRef: input.candidates.find(candidate => candidate.title === second.prompt)!.ref }))
    const nextB = t.msg('再补充一个例子', dm)
    await t.dispatch(nextB)
    expect(t.registry.taskWork.get(t.registry.taskForMessage(nextB.messageId)!.id)).toEqual(t.registry.taskWork.get(second.id))
    expect(t.state.allPrompts.at(-1)?.sessionId).toBe(first.acpId)
    expect(t.registry.resolveSession(['dm:ou_alice'])?.sessionKey).toBe(first.session.sessionKey)
    expect(t.classify).toHaveBeenCalledTimes(1)
    t.classify.mockImplementationOnce(async input => ({ kind: 'amend', targetRef: input.message.replyToRef! }))
    const reply = t.msg('回到这件事继续', { ...dm, parentId: first.message.messageId })
    await t.dispatch(reply)
    expect(t.state.allPrompts.at(-1)?.sessionId).toBe(first.acpId)
    expect(t.classify).toHaveBeenCalledTimes(2)
    expect(t.registry.taskWork.get(t.registry.taskForMessage(reply.messageId)!.id)).toEqual(t.registry.taskWork.get(first.task.id))
    expect(t.registry.listTasks(first.session.sessionKey)).toHaveLength(4)
  })

  it.each([60, 61])('rebuilds independent ACP from only its %i inbound tasks, excluding system followups and marking real truncation', async (historyCount) => {
    const t = setup()
    const first = await holdTask(t, 'UNRELATED_A_HISTORY_CANARY')
    t.classify.mockResolvedValueOnce({ kind: 'new_work' })
    const second = await holdTask(t, 'B_INBOUND_0', { rootId: first.message.messageId })
    first.release(); second.release()
    await Promise.all([first.result, second.result])
    // Public Registry APIs seed genuine inbound receipts versus a routine execution
    // receipt; no synthetic system row is permitted to masquerade as a human turn.
    let latestInbound = second.task
    for (let i = 1; i < historyCount; i++) {
      const inbound = t.msg(`B_INBOUND_${i}`, { messageId: `om_history_b_${i}`, rootId: second.message.messageId })
      const { task } = t.registry.createTaskOnce({ sessionKey: second.session.sessionKey, messageId: `om_history_b_${i}`,
        requesterOpenId: 'ou_alice', prompt: `B_INBOUND_${i}`, amendsTaskId: latestInbound.id, inbound })
      t.registry.updateTask(task.id, { status: 'done' })
      latestInbound = task
    }
    const systemHistory = t.registry.createTaskOnce({ sessionKey: second.session.sessionKey, messageId: second.message.messageId,
      requesterOpenId: 'ou_alice', prompt: 'SYSTEM_FOLLOWUP_MUST_NOT_BE_USER' }, 'routine:synthetic:occurrence:1:v1')
    t.registry.updateTask(systemHistory.task.id, { status: 'done' })
    const otherHistory = t.registry.createTaskOnce({ sessionKey: first.session.sessionKey, messageId: 'om_other_work_history',
      requesterOpenId: 'ou_alice', prompt: 'OTHER_WORK_RECEIPT_CANARY' })
    t.registry.updateTask(otherHistory.task.id, { status: 'done' })
    const before = Number((t.tasks().at(-1) as { id: number }).id) + 1
    const inbound = t.registry.listInboundTasksBefore(second.session.sessionKey, before, 61)
    expect(inbound).toHaveLength(historyCount)
    expect(inbound.map((task) => task.prompt)).toEqual(Array.from({ length: historyCount }, (_, i) => `B_INBOUND_${i}`))
    await t.runtime.closeSession(second.acpId)
    // Close alone preserves history. This fixture specifically models loss of
    // the persisted ACP conversation, independently of the completed-reply route.
    const resume = vi.spyOn(t.runtime, 'resumeSession').mockResolvedValueOnce(false)
    t.state.script = [{ kind: 'text', text: 'B 重建后继续的结果' }]
    t.classify.mockClear()
    t.classify.mockImplementationOnce(async input => ({ kind: 'amend', targetRef: input.message.replyToRef! }))
    const continuation = t.msg('按本事项已有要求继续', { rootId: second.message.messageId, parentId: latestInbound.messageId })
    await t.dispatch(continuation)
    expect(t.registry.taskWork.get(t.registry.taskForMessage(continuation.messageId)!.id)).toEqual(t.registry.taskWork.get(second.task.id))
    expect(resume.mock.calls.map(([id, cwd]) => [id, cwd])).toEqual([[second.acpId, second.session.cwd]])
    const prompt = t.state.allPrompts.at(-1)!
    expect(prompt.sessionId).not.toBe(second.acpId)
    expect(t.registry.getSessionByAcpId(prompt.sessionId)?.sessionKey).toBe(second.session.sessionKey)
    const prior = prompt.text.split('[话题里已有的消息，供理解背景]\n')[1]?.split('\n\n')[0] ?? ''
    expect(prior).toContain(`B_INBOUND_${historyCount - 1}`)
    expect(prior).not.toContain('SYSTEM_FOLLOWUP_MUST_NOT_BE_USER')
    expect(prior).not.toContain('UNRELATED_A_HISTORY_CANARY')
    expect(prior).not.toContain('OTHER_WORK_RECEIPT_CANARY')
    expect(t.orchestrator.receiptOf(second.session.sessionKey)?.priorMessages).toBe(60)
    if (historyCount > 60) {
      expect(prior).not.toMatch(/B_INBOUND_0(?:\n|$)/)
      expect(prompt.text).toContain('[话题历史覆盖范围]')
      expect(t.orchestrator.receiptOf(second.session.sessionKey)?.excluded.join(' ')).toMatch(/截断|未完整读取|更早内容未载入/)
    } else {
      expect(prior).toMatch(/B_INBOUND_0(?:\n|$)/)
      expect(prompt.text).not.toContain('[话题历史覆盖范围]')
    }
    expect(t.classify).toHaveBeenCalledTimes(1)
  })

  it('retains B as the topic default when A learns the thread id from a late send acknowledgement', async () => {
    const t = setup()
    const threadId = 'omt_late_ack'
    t.feishu.threadIdForReply = threadId
    const accepted = t.barrier()
    const releaseAcknowledgement = t.barrier()
    const actualReply = t.feishu.replyMarkdown.bind(t.feishu)
    vi.spyOn(t.feishu, 'replyMarkdown').mockImplementationOnce(async (...args) => {
      const acknowledgement = await actualReply(...args)
      accepted.resolve()
      await releaseAcknowledgement.promise
      return acknowledgement
    })
    t.state.script = [{ kind: 'text', text: 'A 的早已接受但回执迟到的结果' }]
    const first = t.msg('A 的合成事项')
    const firstRun = t.dispatch(first)
    await accepted.promise
    const firstTask = t.registry.taskForMessage(first.messageId)!
    const firstSession = t.registry.getSession(firstTask.sessionKey)!
    expect(firstSession.threadId).toBeNull()
    t.classify.mockResolvedValueOnce({ kind: 'new_work' })
    const second = await holdTask(t, 'B 的独立事项', { rootId: first.messageId, threadId })
    second.release()
    await second.result
    expect(t.registry.resolveSession([`thread:${threadId}`])?.sessionKey).toBe(second.session.sessionKey)
    releaseAcknowledgement.resolve()
    await firstRun
    expect(t.registry.getSession(firstSession.sessionKey)?.threadId).toBe(threadId)
    expect(t.registry.resolveSession([`thread:${threadId}`])?.sessionKey).toBe(second.session.sessionKey)
    t.state.script = [{ kind: 'text', text: '继续 B' }]
    t.classify.mockClear()
    t.classify.mockImplementationOnce(async input => ({ kind: 'amend', targetRef: input.candidates.find(candidate => candidate.title === 'B 的独立事项')!.ref }))
    const continuation = t.msg('继续补充细节', { rootId: first.messageId, threadId })
    await t.dispatch(continuation)
    expect(t.registry.taskWork.get(t.registry.taskForMessage(continuation.messageId)!.id)).toEqual(t.registry.taskWork.get(second.task.id))
    expect(t.state.allPrompts.at(-1)?.sessionId).toBe(second.acpId)
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(t.state.allPrompts.filter((prompt) => prompt.sessionId === firstSession.acpSessionId)).toHaveLength(1)
  })

  it('reports a worker waiting for the ACP gate as queued and stops it before any model prompt is sent', async () => {
    const t = setup({ maxConcurrent: 1 })
    const first = await holdTask(t, '占满执行名额的 A')
    t.classify.mockResolvedValueOnce({ kind: 'new_work' })
    const secondMessage = t.msg('等待名额的 B', { rootId: first.message.messageId })
    const secondRun = t.dispatch(secondMessage)
    await vi.waitFor(() => expect(t.runtime.load().waiting).toBe(1))
    const secondTask = t.registry.taskForMessage(secondMessage.messageId)!
    expect(secondTask).toBeDefined()
    expect(t.state.allPrompts).toHaveLength(1)
    for (const kind of ['progress', 'stop'] as const) {
      t.classify.mockImplementation(async (input) => {
        const target = input.candidates.find((candidate) => candidate.ref === input.message.replyToRef)
        expect(target?.title).toBe('等待名额的 B')
        return { kind, targetRef: target!.ref }
      })
      const query = t.msg(kind === 'progress' ? '这件进度如何？' : '取消这次执行',
        { rootId: first.message.messageId, parentId: secondMessage.messageId })
      await classified(t, query)
      if (kind === 'progress') expect(JSON.stringify(t.controlReplies(query))).toContain('排队')
      expect(t.state.cancelled).not.toContain(first.acpId)
    }
    first.release()
    await Promise.all([first.result, secondRun])
    expect(t.registry.getTask(secondTask.id)?.status).toBe('cancelled')
    expect(t.registry.getTask(first.task.id)?.status).toBe('done')
    expect(t.state.allPrompts).toHaveLength(1)
  })

  it('keeps an unknown control receipt durable and never repeats a possibly accepted POST', async () => {
    const t = setup()
    const active = await holdTask(t)
    decideTarget(t, 'progress')
    const query = t.msg('现在进度怎么样？', { rootId: active.message.messageId })
    for (const method of ['replyText', 'replyMarkdown'] as const) {
      const actual = t.feishu[method].bind(t.feishu)
      vi.spyOn(t.feishu, method).mockImplementation(async (...args) => {
        const receipt = await actual(...args)
        if (args[0] === query.messageId) throw new Error('synthetic control ACK lost')
        return receipt
      })
    }
    await classified(t, query)
    await t.dispatch(query)
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(t.controlReplies(query)).toHaveLength(1)
    expect(t.registry.db.prepare("SELECT status FROM deliveries WHERE status = 'unknown'").all()).toHaveLength(1)
    const routes = t.receipts()
    active.release()
    await active.result
    // A new host with a new SQLite connection and no in-memory control receipts.
    const restarted = setup({ databasePath: t.databasePath })
    await restarted.dispatch(query)
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(t.controlReplies(query)).toHaveLength(1)
    expect(restarted.classify).not.toHaveBeenCalled()
    expect(restarted.feishu.sent).toHaveLength(0)
    expect(restarted.receipts()).toEqual(routes)
    expect(restarted.tasks()).toHaveLength(1)
    expect(restarted.registry.db.prepare("SELECT status FROM deliveries WHERE status = 'unknown'").all()).toHaveLength(1)
  })
})
