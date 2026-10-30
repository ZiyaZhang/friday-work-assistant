import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import type { IngressClassificationInput, IngressDecision } from '../src/acp/ingress-classifier.js'
import { loadConfig } from '../src/config.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions, type BugQuestion, type BugQuestionReply } from '../src/core/bug-questions.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { Todos } from '../src/core/todos.js'
import type { AskBugQuestionReceipt } from '../src/core/question-types.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const QUESTION = '卡住前最后一步做了什么？'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return { eventId: 'ev_feedback', messageId: 'om_feedback', chatId: 'oc_feedback', chatType: 'group', msgType: 'text',
    tenantId: 'tenant-synthetic', threadId: 'omt_feedback', text: '@Friday 帮我排查合成报障', senderOpenId: 'ou_alice', senderType: 'user',
    mentions: [{ key: '@Friday', openId: 'ou_bot', name: 'Friday' }], createTimeMs: Date.now(), ...over }
}

/** Real HTTP, Orchestrator, SQLite, ACP Runtime and DeliveryService; model/classifier/platform are substitutes. */
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'friday-question-continuation-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'app-synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)
  const path = join(home, 'friday.db')
  const registry = new Registry(path), bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs)
  const memory = new ChannelMemory(registry.db), messageCache = new MessageCache(registry.db)
  const sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'oc_feedback', openId: 'ou_alice' })
  const feishu = new FakeFeishu()
  feishu.members.set('oc_feedback', new Set(['ou_alice', 'ou_bob']))
  const log = createLogger('question-continuation-test', 'error')
  const messages = new MessageService(asFeishuClient(feishu), messageCache, log)
  const tokens = new TokenIssuer('synthetic')
  const { app, state } = createFakeAgent({ script: [] })
  // Fixed test decisions: no keyword matching and no claim of real classifier/model validation.
  const classify = vi.fn(async (input: IngressClassificationInput): Promise<IngressDecision> => input.message.replyToRef === 'question' ? { kind: 'amend', targetRef: 'question' } : { kind: 'new_work' })
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, registry, memory, messages, questions, ...sp, feishu: asFeishuClient(feishu), runtime, ingressClassifier: { classify }, tokens, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  const api = createInternalApi({ registry, bugs, questions, memory, messageCache, messages, todos: new Todos(registry.db), ...sp, feishu: asFeishuClient(feishu), tokens, log, maxHistoryPerCall: 50,
    resolveActorForSession: (key) => orchestrator.resolveActorForSession(key),
    canPersistDerivedState: (key) => orchestrator.canPersistDerivedState(key),
    askBugQuestion: (key, runId, input) => orchestrator.askBugQuestion(key, runId, input),
    resolveBugQuestionReply: (key, runId, input) => orchestrator.resolveBugQuestionReply(key, runId, input),
    onCrossSpaceRead: (key, read) => orchestrator.noteCrossSpaceRead(key, read),
  })
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
  const apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const current = () => {
    const sessionId = state.allPrompts.at(-1)!.sessionId
    const session = registry.getSessionByAcpId(sessionId)!
    const servers = state.sessions.get(sessionId)!.mcpServers as { env: { name: string; value: string }[] }[]
    return { session, token: servers[0]!.env.find((entry) => entry.name === 'FRIDAY_CAP_TOKEN')!.value }
  }
  const post = async <T = Record<string, unknown>>(route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${apiUrl}/v1/${route}`, { method: 'POST', headers: { authorization: `Bearer ${current().token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as T }
  }
  const record = async () => {
    const r = await post<{ bucket: { id: number } }>('bug/record', { title: '合成卡住反馈', text: '合成报障原文', message_id: 'om_feedback' })
    expect(r.status).toBe(200)
    return r.body.bucket.id
  }
  const ask = (id: number) => post<AskBugQuestionReceipt>('bug/ask', { id, kind: 'info', question: QUESTION, missing_info: ['last action'] })
  const reply = (parentId: string, over: Partial<InboundMessage> = {}) => msg({ eventId: 'ev_reply', messageId: 'om_reply', parentId, text: '我没有日志', mentions: [], ...over })
  const resolveCurrent = async (bucketId: number, outcome: 'answered' | 'declined' | 'unavailable') => {
    const context = await post<{ questions: (BugQuestion & { replies: BugQuestionReply[] })[] }>('bug/context', { id: bucketId })
    expect(context.status).toBe(200)
    const q = context.body.questions[0]!
    const r = q.replies.at(-1)!
    return post('bug/reply', { question_id: q.id, reply_id: r.id, outcome })
  }
  cleanups.push(async () => {
    api.server.closeAllConnections(); await new Promise<void>((resolve) => api.server.close(() => resolve()))
    await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true })
  })
  return { ...sp, cfg, path, registry, bugs, questions, memory, feishu, state, space, runtime, orchestrator, classify, post, record, ask, reply, resolveCurrent }
}

describe('info question immediate delivery and explicit continuation', () => {
  it('recovers a reply committed before queue dispatch, without asking again or duplicating its answer record', async () => {
    const t = await setup()
    let bucketId = 0, facts!: AskBugQuestionReceipt
    t.state.script = [{ kind: 'hook', run: async () => { bucketId = await t.record(); facts = (await t.ask(bucketId)).body } }]
    await t.orchestrator.handleMessage(msg())
    const input = t.reply(facts.message_id!, { text: '日志拿不到，先按现有信息查。' })
    const dispatcher = vi.spyOn(t.orchestrator as unknown as { queueAcceptedTask: (...args: unknown[]) => Promise<void> }, 'queueAcceptedTask')
      .mockRejectedValueOnce(new Error('crash after commit'))
    await expect(t.orchestrator.handleMessage(input)).rejects.toThrow('crash after commit')
    dispatcher.mockRestore()
    const accepted = t.registry.taskForMessage(input.messageId)!
    expect(accepted.status).toBe('queued')
    expect(t.questions.replies(facts.question_id)).toHaveLength(1)
    t.registry.failStaleTasks('restart')
    t.state.script = [{ kind: 'hook', run: async () => { expect((await t.resolveCurrent(bucketId, 'unavailable')).status).toBe(200) } },
      { kind: 'text', text: '我继续核查已有材料。' }]
    await t.orchestrator.recoverHandoffs()
    await t.orchestrator.recoverHandoffs()
    expect(t.registry.taskForMessage(input.messageId)).toMatchObject({ id: accepted.id, status: 'done' })
    expect(t.questions.list(bucketId, t.space.id)).toHaveLength(1)
    expect(t.questions.replies(facts.question_id)).toHaveLength(1)
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.state.allPrompts[1]!.text).toContain(input.text)
  })

  it('reports intake persistence separately from question delivery on a continued session', async () => {
    const t = await setup()
    let bucketId = 0
    t.state.script = [{ kind: 'hook', run: async () => { bucketId = await t.record() } }, { kind: 'text', text: '已记录。' }]
    await t.orchestrator.handleMessage(msg())
    t.state.script = [{ kind: 'hook', run: async () => {
      const updated = await t.post('bug/intake', { id: bucketId, phase: 'awaiting_info', missing_info: ['last action'] })
      expect(updated.body).toMatchObject({ message_sent: false, open_question: null, bucket: { intakePhase: 'awaiting_info' } })
      expect(t.feishu.answers()).toEqual(['已记录。'])
      expect(t.questions.list(bucketId, t.space.id)).toEqual([])
      const sent = await t.ask(bucketId)
      expect(sent.body.delivery_status).toBe('sent')
      const checked = await t.post('bug/intake', { id: bucketId, phase: 'awaiting_info', missing_info: ['last action'] })
      expect(checked.body).toMatchObject({ message_sent: false, open_question: { id: sent.body.question_id, question: QUESTION } })
      expect(t.feishu.answers()).toEqual(['已记录。', QUESTION])
    } }]
    // A semantic amendment continues this Work; merely sharing a Session does not.
    const original = t.registry.taskForMessage('om_feedback')!
    t.classify.mockImplementationOnce(async input => ({ kind: 'amend', targetRef: input.candidates.find(candidate => candidate.title === original.prompt)!.ref }))
    await t.orchestrator.handleMessage(msg({ messageId: 'om_next_context', text: '@Friday 继续查刚才的问题', eventId: 'ev_next' }))
    expect(t.registry.taskWork.get(t.registry.taskForMessage('om_next_context')!.id)).toEqual(t.registry.taskWork.get(original.id))
    const turn = t.state.allPrompts[1]!
    expect(turn.sessionId).toBe(t.state.allPrompts[0]!.sessionId)
    expect(turn.text).toContain('message_id=om_next_context')
    expect(turn.text).toContain('friday_bug_ask')
    expect(t.feishu.answers()).toEqual(['已记录。', QUESTION])
  })

  it.each(['empty', 'same-question'] as const)('sends before independent work and suppresses %s final output', async (ending) => {
    const t = await setup()
    let facts!: AskBugQuestionReceipt
    let bucketId = 0
    const order: string[] = []
    t.state.script = [
      { kind: 'hook', run: async () => {
        bucketId = await t.record()
        for (const body of [{ id: bucketId }, { id: bucketId, kind: 'decision', question: '要发布吗？' }]) expect((await t.post('bug/ask', body)).status).toBe(400)
        expect(t.questions.budget(bucketId).occupied).toBe(0)
        const r = await t.ask(bucketId); expect(r.status).toBe(200); facts = r.body
        expect(t.feishu.answers()).toEqual([QUESTION]); order.push('question-sent')
      } },
      { kind: 'hook', run: async () => { expect((await t.post('chat/history', {})).status).toBe(200); order.push('independent-read') } },
      ...(ending === 'same-question' ? [{ kind: 'text' as const, text: QUESTION }] : []),
    ]
    await t.orchestrator.handleMessage(msg())
    expect(order).toEqual(['question-sent', 'independent-read'])
    expect(facts).toMatchObject({ delivery_status: 'sent', question: QUESTION, next: 'continue_independent_work', budget: { occupied: 1, max: 3 } })
    expect(t.feishu.answers()).toEqual([QUESTION])
    expect(t.registry.taskForMessage('om_feedback')?.status).toBe('done')
    expect(t.memory.recent(`space:${t.space.id}`)).toEqual([])
    expect(t.questions.list(bucketId, t.space.id)).toMatchObject([{ resolution: 'open' }])
    expect(t.feishu.reactionsOn('om_feedback')).toEqual(['GLANCE'])
    const task = t.registry.taskForMessage('om_feedback')!
    expect((t.orchestrator as unknown as { taskProgress(task: typeof task): string }).taskProgress(task)).toContain('等待补充')
  })

  it('queues a busy reply without cancelling the original worker and preserves an explicit refusal', async () => {
    const t = await setup(), ready = deferred(), release = deferred()
    let bucketId = 0, facts!: AskBugQuestionReceipt
    t.state.script = [{ kind: 'hook', run: async () => { bucketId = await t.record(); facts = (await t.ask(bucketId)).body; ready.resolve(); await release.promise } }]
    const original = t.orchestrator.handleMessage(msg())
    await ready.promise
    t.state.script = [{ kind: 'hook', run: async () => { expect((await t.resolveCurrent(bucketId, 'declined')).status).toBe(200) } }, { kind: 'text', text: '按现有信息继续核查。' }]
    const inbound = t.reply(facts.message_id!, { text: '我不想提供日志' })
    const continuation = t.orchestrator.handleMessage(inbound)
    try {
      await vi.waitFor(() => expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('queued'))
      expect(t.state.allPrompts).toHaveLength(1)
      expect(t.state.cancelled).toEqual([])
      await t.orchestrator.handleMessage(inbound)
    } finally { release.resolve(); await original; await continuation }
    const question = t.questions.get(facts.question_id)!
    expect(question.resolution).toBe('declined')
    expect(t.questions.replies(question.id)).toMatchObject([{ messageId: inbound.messageId, outcome: 'declined' }])
    expect(t.registry.taskForMessage(inbound.messageId)?.sessionKey).toBe(question.sessionKey)
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.state.allPrompts[1]!.text).toContain('我不想提供日志')
    expect(t.bugs.get(bucketId)?.issueUrl).toBeNull()
  })

  it('routes an idle explicit reply to its question even after the thread alias points elsewhere', async () => {
    const t = await setup()
    let bucketId = 0, facts!: AskBugQuestionReceipt
    t.state.script = [{ kind: 'hook', run: async () => { bucketId = await t.record(); facts = (await t.ask(bucketId)).body } }]
    await t.orchestrator.handleMessage(msg())
    const original = t.questions.get(facts.question_id)!
    const cwd = t.registry.getSession(original.sessionKey)!.cwd
    t.registry.createSession({ sessionKey: 'other-work', chatId: 'oc_feedback', chatType: 'group', cwd, requesterOpenId: 'ou_alice', threadId: 'omt_feedback', title: '另一件事' })
    t.registry.addAlias('thread:omt_feedback', 'other-work')
    t.state.script = [{ kind: 'hook', run: async () => { expect((await t.resolveCurrent(bucketId, 'unavailable')).status).toBe(200) } }, { kind: 'text', text: '材料缺失已保留。' }]
    const inbound = t.reply(facts.message_id!)
    await t.orchestrator.handleMessage(inbound)
    expect(t.registry.taskForMessage(inbound.messageId)?.sessionKey).toBe(original.sessionKey)
    expect(t.registry.listTasks('other-work')).toEqual([])
    expect(t.questions.replies(original.id)).toMatchObject([{ outcome: 'unavailable' }])
    expect(t.state.allPrompts[1]!.text).toContain(QUESTION)
  })

  it('assembles continuation context from the updated case and original task, including prior replies', async () => {
    const t = await setup()
    const originalText = '刷新后已经恢复，请核查当时卡住的原因，不要假设仍能复现。'
    const firstReply = '我没有日志，并不是不愿提供。'
    const secondReply = '补充：最后一次点击的是提交按钮。'
    let bucketId = 0, facts!: AskBugQuestionReceipt
    t.state.script = [{ kind: 'hook', run: async () => { bucketId = await t.record(); facts = (await t.ask(bucketId)).body } }]
    await t.orchestrator.handleMessage(msg({ text: `@Friday ${originalText}` }))
    const questionAtCreation = t.questions.get(facts.question_id)!
    expect(questionAtCreation.missingInfo).toEqual(['last action'])
    expect(t.bugs.get(bucketId)?.issueUrl).toBeNull()
    t.state.script = [{ kind: 'hook', run: async () => { expect((await t.resolveCurrent(bucketId, 'unavailable')).status).toBe(200) } }, { kind: 'text', text: '已保留材料缺失情况。' }]
    await t.orchestrator.handleMessage(t.reply(facts.message_id!, { messageId: 'om_first_context_reply', text: firstReply }))

    // Simulate trusted case updates after the question and its first continuation, without a GitHub network write.
    const issueUrl = 'https://github.com/synthetic-org/synthetic-repo/issues/73'
    t.bugs.retitle(bucketId, '刷新恢复后的提交等待异常')
    t.bugs.setIntake({ bucketId, spaceId: t.space.id, phase: 'awaiting_info', missingInfo: ['发生时间与版本'] })
    t.bugs.linkIssue(bucketId, issueUrl)
    let deliveredContext: Record<string, unknown> | undefined
    t.state.script = [{ kind: 'hook', run: async () => {
      // Inspect the actual ACP input, not a direct call to readContext or the prompt builder.
      const actualPrompt = t.state.allPrompts.at(-1)!.text
      const contextLine = actualPrompt.split('\n').find((line) => line.startsWith('{"feedback_id":'))
      expect(contextLine).toBeDefined()
      deliveredContext = JSON.parse(contextLine!) as Record<string, unknown>
    } }, { kind: 'text', text: '按更新后的案件继续核查。' }]
    const continuation = t.reply(facts.message_id!, { messageId: 'om_second_context_reply', text: secondReply })
    await t.orchestrator.handleMessage(continuation)

    expect(deliveredContext).toMatchObject({
      feedback_id: bucketId, question_id: facts.question_id, title: '刷新恢复后的提交等待异常',
      intake_phase: 'linked_issue', issue_url: issueUrl, missing_info: ['发生时间与版本'],
      original_request: { message_id: 'om_feedback', text: originalText },
      replies: [
        { message_id: 'om_first_context_reply', outcome: 'unavailable', text: firstReply },
        { message_id: continuation.messageId, outcome: 'pending', text: secondReply },
      ],
    })
    expect(t.questions.get(facts.question_id)?.missingInfo).toEqual(questionAtCreation.missingInfo)
    expect(t.registry.taskForMessage(continuation.messageId)).toMatchObject({ sessionKey: questionAtCreation.sessionKey, status: 'done' })
    expect(t.state.allPrompts).toHaveLength(3)
  })

  it('persists a reply received before ACK and executes it only once when the receipt arrives', async () => {
    const t = await setup(), remoteAccepted = deferred(), releaseAck = deferred()
    const send = t.feishu.replyMarkdown.bind(t.feishu)
    let remoteId = '', bucketId = 0
    vi.spyOn(t.feishu, 'replyMarkdown').mockImplementation(async (...args) => {
      const result = await send(...args)
      if (args[1] === QUESTION) { remoteId = result.messageId; remoteAccepted.resolve(); await releaseAck.promise }
      return result
    })
    t.state.script = [{ kind: 'hook', run: async () => { bucketId = await t.record(); expect((await t.ask(bucketId)).status).toBe(200) } }]
    const original = t.orchestrator.handleMessage(msg())
    await remoteAccepted.promise
    const inbound = t.reply(remoteId, { text: '最后点了提交' })
    try {
      await t.orchestrator.handleMessage(inbound)
      await t.orchestrator.handleMessage(inbound)
      expect(t.registry.taskForMessage(inbound.messageId)).toBeUndefined()
      const reopened = new Registry(t.path)
      try { expect(reopened.db.prepare('SELECT message_id FROM pending_question_replies').all()).toEqual([{ message_id: inbound.messageId }]) } finally { reopened.close() }
      t.state.script = [{ kind: 'hook', run: async () => { expect((await t.resolveCurrent(bucketId, 'answered')).status).toBe(200) } }, { kind: 'text', text: '收到这一步，继续核查。' }]
    } finally { releaseAck.resolve(); await original }
    await vi.waitFor(() => expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('done'))
    await t.orchestrator.handleMessage(inbound)
    expect(t.registry.db.prepare('SELECT message_id FROM pending_question_replies').all()).toEqual([])
    expect(t.questions.replies(t.questions.list(bucketId, t.space.id)[0]!.id)).toMatchObject([{ outcome: 'answered' }])
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.state.cancelled).toEqual([])
  })

  it('preserves unknown delivery without a second POST or a false successful task', async () => {
    const t = await setup()
    const send = t.feishu.replyMarkdown.bind(t.feishu)
    const attempts = vi.spyOn(t.feishu, 'replyMarkdown').mockImplementation(async (...args) => { await send(...args); throw new Error('synthetic question ACK lost') })
    let bucketId = 0
    const results: AskBugQuestionReceipt[] = []
    t.state.script = [{ kind: 'hook', run: async () => { bucketId = await t.record(); results.push((await t.ask(bucketId)).body, (await t.ask(bucketId)).body) } }]
    await t.orchestrator.handleMessage(msg())
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ delivery_status: 'unknown', budget: { occupied: 1, max: 3 } })
    expect(results[1]).toEqual(results[0])
    expect(attempts).toHaveBeenCalledTimes(1)
    expect(t.registry.taskForMessage('om_feedback')?.status).toBe('failed')
    expect(t.feishu.reactionsOn('om_feedback')).not.toContain(t.cfg.feishu.reactions.done)
    expect(t.memory.recent(`space:${t.space.id}`)).toEqual([])
  })

  it('sends the pending-material receipt and later clarification once each after a late question ACK', async () => {
    const t = await setup(), remoteAccepted = deferred(), releaseAck = deferred(), failRun = deferred()
    const send = t.feishu.replyMarkdown.bind(t.feishu)
    let remoteId = '', askResult: ReturnType<typeof t.ask> | undefined
    const attempts = vi.spyOn(t.feishu, 'replyMarkdown').mockImplementation(async (...args) => {
      const result = await send(...args)
      if (args[1] === QUESTION) { remoteId = result.messageId; remoteAccepted.resolve(); await releaseAck.promise }
      return result
    })
    t.state.script = [{ kind: 'hook', run: async () => {
      askResult = t.ask(await t.record())
      await remoteAccepted.promise
      await failRun.promise
      // The model connection fails while the already-issued HTTP send is still awaiting ACK.
      throw new Error('synthetic model connection ended before question ACK')
    } }]
    const original = t.orchestrator.handleMessage(msg())
    await remoteAccepted.promise
    const inbound = t.reply(remoteId, { text: '这条补充先保留' })
    const receipts = () => t.feishu.of('replyText').filter((r) => r.target === inbound.messageId).map((r) => r.payload)
    try {
      await t.orchestrator.handleMessage(inbound)
      expect(t.registry.db.prepare('SELECT message_id FROM pending_question_replies').all()).toEqual([{ message_id: inbound.messageId }])
      failRun.resolve(); await original
      await vi.waitFor(() => expect(receipts()).toEqual(['这条补充已保留。请回复最初的报障消息，继续处理同一件事。']))
      expect(t.registry.taskForMessage('om_feedback')?.status).toBe('failed')
      t.classify.mockResolvedValueOnce({ kind: 'clarify' })
      releaseAck.resolve()
      // The worker ended before the ACK: its capability is now stale, but the
      // actual remote success stays on the original delivery and can resume the reply.
      expect((await askResult!).status).toBe(403)
      expect(t.registry.db.prepare("SELECT status,remote_id FROM deliveries WHERE delivery_key LIKE 'question:%'").get()).toMatchObject({ status: 'sent', remote_id: remoteId })
      await vi.waitFor(() => expect(receipts()).toEqual([
        '这条补充已保留。请回复最初的报障消息，继续处理同一件事。',
        '这条是补充信息，还是要停止这件事？',
      ]))
      await t.orchestrator.handleMessage(inbound)
      expect(receipts()).toHaveLength(2)
      expect(t.registry.db.prepare('SELECT delivery_key, status FROM deliveries WHERE delivery_key IN (?, ?) ORDER BY delivery_key').all(`question-pending:${inbound.messageId}`, `route:${inbound.messageId}`)).toEqual([
        { delivery_key: `question-pending:${inbound.messageId}`, status: 'sent' },
        { delivery_key: `route:${inbound.messageId}`, status: 'sent' },
      ])
      expect(attempts.mock.calls.filter((args) => args[1] === QUESTION)).toHaveLength(1)
      expect(t.registry.db.prepare('SELECT message_id FROM pending_question_replies').all()).toEqual([])
      expect(t.registry.taskForMessage(inbound.messageId)).toBeUndefined()
    } finally { failRun.resolve(); releaseAck.resolve(); await original; await askResult }
  })

  it('finds the exact receipt when ACK arrives during the initial fresh membership lookup', async () => {
    const t = await setup(), remoteAccepted = deferred(), releaseAck = deferred(), releaseLookup = deferred()
    const send = t.feishu.replyMarkdown.bind(t.feishu)
    let remoteId = '', bucketId = 0, lookupWaiting = false
    vi.spyOn(t.feishu, 'replyMarkdown').mockImplementation(async (...args) => {
      const result = await send(...args)
      if (args[1] === QUESTION) { remoteId = result.messageId; remoteAccepted.resolve(); await releaseAck.promise }
      return result
    })
    t.state.script = [{ kind: 'hook', run: async () => { bucketId = await t.record(); expect((await t.ask(bucketId)).status).toBe(200) } }]
    const original = t.orchestrator.handleMessage(msg())
    await remoteAccepted.promise
    const members = t.feishu.chatMemberOpenIds.bind(t.feishu)
    vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementationOnce(async (chatId) => {
      lookupWaiting = true; await releaseLookup.promise; return members(chatId)
    })
    const inbound = t.reply(remoteId, { text: '最后点了提交' })
    const continuation = t.orchestrator.handleMessage(inbound)
    try {
      await vi.waitFor(() => expect(lookupWaiting).toBe(true))
      expect(t.registry.db.prepare('SELECT message_id FROM pending_question_replies').all()).toEqual([])
      releaseAck.resolve(); await original // ask's finally has retried an empty pending list
      expect(t.registry.db.prepare('SELECT status FROM deliveries WHERE delivery_key = ?').get(t.questions.list(bucketId, t.space.id)[0]!.deliveryKey)).toEqual({ status: 'sent' })
      expect(t.registry.taskForMessage(inbound.messageId)).toBeUndefined()
      t.state.script = [{ kind: 'hook', run: async () => { expect((await t.resolveCurrent(bucketId, 'answered')).status).toBe(200) } }, { kind: 'text', text: '收到操作步骤。' }]
    } finally { releaseAck.resolve(); releaseLookup.resolve(); await original; await continuation }
    expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('done')
    expect(t.questions.replies(t.questions.list(bucketId, t.space.id)[0]!.id)).toMatchObject([{ messageId: inbound.messageId, outcome: 'answered' }])
    expect(t.registry.db.prepare('SELECT message_id FROM pending_question_replies').all()).toEqual([])
    expect(t.state.allPrompts).toHaveLength(2)
  })

  it('does not defer an unrelated parent reply because an older question delivery is unknown', async () => {
    const t = await setup()
    const send = t.feishu.replyMarkdown.bind(t.feishu)
    const attempts = vi.spyOn(t.feishu, 'replyMarkdown').mockImplementation(async (...args) => { await send(...args); throw new Error('synthetic question ACK lost') })
    let facts!: AskBugQuestionReceipt
    t.state.script = [{ kind: 'hook', run: async () => { facts = (await t.ask(await t.record())).body } }]
    await t.orchestrator.handleMessage(msg())
    expect(facts.delivery_status).toBe('unknown')
    attempts.mockRestore()
    t.state.script = [{ kind: 'text', text: '已处理另一话题。' }]
    const unrelated = msg({ eventId: 'ev_other_reply', messageId: 'om_other_reply', threadId: 'omt_other', rootId: 'om_other_root', parentId: 'om_other_parent', text: '@Friday 继续这一话题' })
    await t.orchestrator.handleMessage(unrelated)
    expect(t.registry.taskForMessage(unrelated.messageId)).toMatchObject({ status: 'done' })
    expect(t.registry.taskForMessage(unrelated.messageId)?.sessionKey).not.toBe(t.questions.get(facts.question_id)?.sessionKey)
    expect(t.questions.replies(facts.question_id)).toEqual([])
    expect(t.registry.db.prepare('SELECT message_id FROM pending_question_replies').all()).toEqual([])
    expect(t.feishu.answers()).toContain('已处理另一话题。')
    expect(t.state.allPrompts).toHaveLength(2)
  })

  it('scopes an explicit question /stop to A after the same-thread alias points to running B', async () => {
    const t = await setup(), aReady = deferred(), bReady = deferred(), releaseA = deferred(), releaseB = deferred()
    let facts!: AskBugQuestionReceipt
    t.state.script = [{ kind: 'hook', run: async () => { facts = (await t.ask(await t.record())).body } }]
    await t.orchestrator.handleMessage(msg())
    const question = t.questions.get(facts.question_id)!
    t.state.script = [{ kind: 'hook', run: async () => { aReady.resolve(); await releaseA.promise } }, { kind: 'text', text: '不应发送的 A 结果' }]
    const aReply = t.reply(facts.message_id!, { messageId: 'om_a_reply' })
    const aWork = t.orchestrator.handleMessage(aReply)
    await aReady.promise
    t.state.script = [{ kind: 'hook', run: async () => { bReady.resolve(); await releaseB.promise } }, { kind: 'text', text: 'B 正常完成。' }]
    const bMessage = msg({ eventId: 'ev_b', messageId: 'om_b', text: '@Friday 处理另一件独立事项' })
    const bWork = t.orchestrator.handleMessage(bMessage)
    try {
      await bReady.promise
      const bTask = t.registry.taskForMessage(bMessage.messageId)!
      expect(bTask.sessionKey).not.toBe(question.sessionKey)
      expect(t.registry.resolveSession(['thread:omt_feedback'])?.sessionKey).toBe(bTask.sessionKey)
      await t.orchestrator.handleMessage(t.reply(facts.message_id!, { messageId: 'om_stop_a', text: '/stop' }))
      expect(t.questions.get(question.id)?.resolution).toBe('cancelled')
      expect(t.registry.taskForMessage(aReply.messageId)?.stopReason).toBe('user_requested')
      expect(t.registry.getTask(bTask.id)).toMatchObject({ status: 'running', stopReason: null })
    } finally { releaseA.resolve(); releaseB.resolve(); await aWork; await bWork }
    expect(t.registry.taskForMessage(aReply.messageId)?.status).toBe('cancelled')
    expect(t.registry.taskForMessage(bMessage.messageId)).toMatchObject({ status: 'done', stopReason: 'end_turn' })
    expect(t.feishu.answers()).not.toContain('不应发送的 A 结果')
    expect(t.feishu.answers()).toContain('B 正常完成。')
  })

  it('does not revive a queued reply stopped during its pre-start membership lookup', async () => {
    const t = await setup(), ready = deferred(), releaseOriginal = deferred(), releaseLookup = deferred()
    let facts!: AskBugQuestionReceipt, startupLookupWaiting = false, startupChecks = 0
    t.state.script = [{ kind: 'hook', run: async () => { facts = (await t.ask(await t.record())).body; ready.resolve(); await releaseOriginal.promise } }]
    const original = t.orchestrator.handleMessage(msg())
    await ready.promise
    const inbound = t.reply(facts.message_id!, { text: '这里是补充材料' })
    const continuation = t.orchestrator.handleMessage(inbound)
    try {
      await vi.waitFor(() => expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('queued'))
      const members = t.feishu.chatMemberOpenIds.bind(t.feishu)
      vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementation(async (chatId) => {
        // Route acceptance has finished; the first lookup after the original task ends is runTask's pre-start guard.
        if (!startupLookupWaiting && t.registry.taskForMessage('om_feedback')?.status === 'done') {
          startupChecks += 1; startupLookupWaiting = true; await releaseLookup.promise
        }
        return members(chatId)
      })
      t.state.script = [{ kind: 'text', text: '不应启动的排队回复' }]
      releaseOriginal.resolve(); await original
      await vi.waitFor(() => expect(startupLookupWaiting).toBe(true))
      expect(t.registry.taskForMessage(inbound.messageId)).toMatchObject({ status: 'queued', startedAt: null })
      await t.orchestrator.handleMessage(t.reply(facts.message_id!, { messageId: 'om_stop_queued', text: '/stop' }))
      expect(t.registry.taskForMessage(inbound.messageId)).toMatchObject({ status: 'cancelled', stopReason: 'user_requested', startedAt: null })
    } finally { releaseOriginal.resolve(); releaseLookup.resolve(); await original; await continuation }
    expect(startupChecks).toBe(1)
    expect(t.registry.taskForMessage(inbound.messageId)).toMatchObject({ status: 'cancelled', stopReason: 'user_requested', startedAt: null })
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.answers()).not.toContain('不应启动的排队回复')
    expect(t.feishu.reactionsOn(inbound.messageId)).toEqual([])
  })

  it('does not execute late material after an explicit stop of the question', async () => {
    const t = await setup()
    let facts!: AskBugQuestionReceipt
    t.state.script = [{ kind: 'hook', run: async () => { facts = (await t.ask(await t.record())).body } }]
    await t.orchestrator.handleMessage(msg())
    t.classify.mockResolvedValueOnce({ kind: 'stop', targetRef: 'question' })
    await t.orchestrator.handleMessage(t.reply(facts.message_id!, { messageId: 'om_stop_question', text: '先停止这件事' }))
    const late = t.reply(facts.message_id!, { messageId: 'om_late', text: '这里是补充材料' })
    await t.orchestrator.handleMessage(late)
    expect(t.questions.get(facts.question_id)?.resolution).toBe('cancelled')
    expect(t.questions.replies(facts.question_id)).toEqual([])
    expect(t.registry.taskForMessage(late.messageId)).toBeUndefined()
    expect(t.state.allPrompts).toHaveLength(1)
  })

  it.each(['actor', 'tenant'] as const)('never binds an explicit reply with the wrong %s to the question', async (wrong) => {
    const t = await setup()
    let facts!: AskBugQuestionReceipt
    t.state.script = [{ kind: 'hook', run: async () => { facts = (await t.ask(await t.record())).body } }]
    await t.orchestrator.handleMessage(msg())
    t.state.script = [{ kind: 'text', text: '普通消息答复' }]
    const inbound = t.reply(facts.message_id!, { messageId: `om_wrong_${wrong}`, ...(wrong === 'actor' ? { senderOpenId: 'ou_bob' } : { tenantId: 'other-tenant' }) })
    await t.orchestrator.handleMessage(inbound)
    expect(t.questions.replies(facts.question_id)).toEqual([])
    expect(t.questions.get(facts.question_id)?.resolution).toBe('open')
    const task = t.registry.taskForMessage(inbound.messageId)
    if (task) expect(t.questions.forTask(task.id)).toEqual([]) // ordinary routing is allowed; question binding is not
    expect(t.registry.db.prepare('SELECT message_id FROM pending_question_replies').all()).toEqual([])
  })
})
