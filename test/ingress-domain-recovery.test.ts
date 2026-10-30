import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IngressClassificationError, type IngressClassificationInput, type IngressDecision } from '../src/acp/ingress-classifier.js'
import { loadConfig } from '../src/config.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { Bugs } from '../src/core/bugs.js'
import { DeliveryService } from '../src/core/delivery.js'
import { FeedbackControl } from '../src/core/feedback-control.js'
import { IngressReceipts } from '../src/core/ingress.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { spaceDeps } from './helpers/space.js'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })

/** Real host entry points, SQLite reopen and delivery receipts; only remote peers are synthetic. */
async function fixture(stopped = false) {
  const home = mkdtempSync(join(tmpdir(), 'friday-ingress-domain-')), path = join(home, 'friday.db')
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_DEFAULT_EXECUTION: 'managed', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('ingress-domain', 'error')
  fake.members.set('synthetic-chat', new Set(['alice']))
  const classify = vi.fn<(input: IngressClassificationInput) => Promise<IngressDecision>>(async input =>
    input.message.replyToRef ? { kind: 'amend', targetRef: input.message.replyToRef } : { kind: 'new_work' })
  let clock = Date.now(), boots = 0
  function boot() {
    const registry = new Registry(path), sp = spaceDeps(registry.db)
    const space = sp.spaces.ensure({ kind: 'group', chatId: 'synthetic-chat', openId: 'alice' })
    const bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs), routines = new RoutineStore(registry.db)
    const feedback = new FeedbackControl(registry, bugs, questions, routines)
    const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
    const execution = managedHostRuntime(registry, home, log)
    execution.peer.state.counter = 100 * boots++
    execution.peer.state.script = [{ kind: 'text', text: '已核查合成输入。' }]
    const host = new Orchestrator({ cfg, registry, ...sp, feedback, questions, routines, memory, messageCache: cache, messages,
      feishu, runtime: execution.runtime, managed: execution.managed, tokens: new TokenIssuer('synthetic'), ingressClassifier: { classify },
      apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/synthetic', botOpenId: 'bot', log, now: () => clock })
    return { registry, ...sp, space, bugs, questions, feedback, host, runtime: execution.runtime,
      state: execution.peer.state, receipts: new IngressReceipts(registry.db) }
  }
  let k = boot()
  const close = async () => { await k.runtime.stop(); k.registry.close() }
  closes.push(async () => { await close(); rmSync(home, { recursive: true, force: true }) })
  const msg = (id: string, text: string, over: Partial<InboundMessage> = {}): InboundMessage => ({
    eventId: `event-${id}`, messageId: id, chatId: 'synthetic-chat', chatType: 'group', tenantId: 'synthetic-tenant',
    threadId: 'synthetic-thread', senderOpenId: 'alice', senderType: 'user', msgType: 'text', text: `@Friday ${text}`,
    mentions: [{ key: '@Friday', name: 'Friday', openId: 'bot' }], createTimeMs: ++clock, ...over,
  })
  const original = msg('origin', '排查合成反馈')
  await k.host.handleMessage(original)
  const task = k.registry.taskForMessage(original.messageId)!
  const bucket = k.bugs.record({ spaceId: k.space.id, chatId: original.chatId, messageId: original.messageId,
    reporterOpenId: original.senderOpenId, title: '合成反馈', text: original.text }).bucket
  const question = k.questions.prepare({ bucketId: bucket.id, spaceId: k.space.id, sessionKey: task.sessionKey, originTaskId: task.id,
    targetOpenId: 'alice', anchor: { tenantId: original.tenantId!, appId: cfg.feishu.appId, chatId: original.chatId,
      messageId: original.messageId, threadId: original.threadId }, kind: 'info', question: '发生前最后做了什么？' })
  const delivery = new DeliveryService(k.registry.db, { spaces: k.spaces, policy: k.policy, now: () => clock,
    resolveContext: async () => ({ actorOpenId: 'alice', provenanceComplete: true, expiresAt: clock + 60_000,
      sources: [{ ref: 'synthetic-origin', spaceId: k.space.id, chatId: original.chatId }],
      audience: { kind: 'group', spaceId: k.space.id, chatId: original.chatId, replyToMessageId: original.messageId, threadId: original.threadId } }),
    send: async () => ({ remoteId: (await fake.replyText(original.messageId, question.question, false)).messageId }),
  })
  const sent = await delivery.deliver({ key: question.deliveryKey, contextRef: question.deliveryKey, payload: { text: question.question } })
  if (stopped) k.feedback.stop({ feedbackId: bucket.id, spaceId: k.space.id, chatId: original.chatId, chatType: 'group',
    openId: 'alice', controllerTaskId: task.id, now: clock })
  classify.mockClear()
  const reply = (id: string, text: string, patch: Partial<InboundMessage> = {}) => msg(id, text,
    { parentId: sent.remoteId!, text, mentions: [], ...patch })
  const row = (id: string) => k.registry.db.prepare('SELECT decision,result,notice,handoff FROM ingress_routes WHERE message_id=?').get(id) as
    { decision: string | null; result: string | null; notice: string | null; handoff: string } | undefined
  const routeTexts = () => fake.sent.filter(item => item.kind === 'replyText').map(item => String(item.payload))
  return { fake, classify, task, bucket, question, reply, row, routeTexts, get k() { return k },
    advance() { clock += 60_001 }, async reboot() { await close(); k = boot() } }
}

describe('question and stopped-feedback classification recovery', () => {
  it.each([false, true])('reopens the exact original domain request after timeout (stopped=%s)', async stopped => {
    const t = await fixture(stopped), input = t.reply('late', '没有日志，最后点击的是提交。')
    t.classify.mockRejectedValueOnce(new IngressClassificationError('timeout'))
    await t.k.host.handleMessage(input)
    expect(t.row(input.messageId)).toMatchObject({ decision: null, result: null })
    const handoff = JSON.parse(t.row(input.messageId)!.handoff)
    expect(handoff.message).toEqual(input)
    expect(handoff.route.kind).toBe(stopped ? 'stopped_feedback' : 'question')
    expect(t.k.registry.taskForMessage(input.messageId)).toBeUndefined()
    expect(t.k.questions.replies(t.question.id)).toEqual([])
    await t.k.host.handleMessage(input)
    expect(t.row(input.messageId)).toMatchObject({ decision: null, result: null })
    expect(t.classify).toHaveBeenCalledTimes(1)
    await t.reboot(); t.advance()
    await t.k.host.recoverHandoffs(); await t.k.host.recoverHandoffs()
    expect(t.classify).toHaveBeenCalledTimes(2)
    expect(t.classify.mock.calls[1]![0]).toEqual(handoff.input)
    if (stopped) {
      expect(t.k.registry.taskForMessage(input.messageId)).toBeUndefined()
      expect(t.k.bugs.reports(t.bucket.id).filter(report => report.messageId === input.messageId))
        .toMatchObject([{ text: input.text, recordKind: 'user_note' }])
      expect(t.k.bugs.get(t.bucket.id)?.intakePhase).toBe('cancelled')
      expect(t.k.state.allPrompts).toEqual([])
    } else {
      expect(t.k.registry.taskForMessage(input.messageId)).toMatchObject({ sessionKey: t.task.sessionKey, status: 'done' })
      expect(t.k.questions.replies(t.question.id)).toHaveLength(1)
    }
    expect(t.routeTexts().filter(text => text.includes('暂时没能完成请求识别'))).toHaveLength(1)
    expect(t.row(input.messageId)?.result).not.toBeNull()
  })

  it.each([false, true])('keeps invalid model output as a terminal host failure (stopped=%s)', async stopped => {
    const t = await fixture(stopped), input = t.reply('invalid', '这是原始补充。')
    t.classify.mockRejectedValueOnce(new IngressClassificationError('invalid_output'))
    await t.k.host.handleMessage(input)
    t.advance(); await t.k.host.recoverHandoffs()
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(t.row(input.messageId)).toMatchObject({ decision: null, result: 'classification_failed' })
    expect(t.k.registry.taskForMessage(input.messageId)).toBeUndefined()
    expect(t.k.questions.replies(t.question.id)).toEqual([])
    expect(t.k.bugs.reports(t.bucket.id)).toHaveLength(1)
    expect(t.routeTexts().filter(text => text.includes('自动重试已停止'))).toHaveLength(1)
  })

  it('does not apply an older question reply after a newer reply has taken over the same work', async () => {
    const t = await fixture(), older = t.reply('older', '请按旧信息查。'), newer = t.reply('newer', '更正，按新信息查。')
    t.classify.mockRejectedValueOnce(new IngressClassificationError('unavailable'))
    await t.k.host.handleMessage(older)
    await t.k.host.handleMessage(newer)
    t.advance(); await t.k.host.recoverHandoffs()
    expect(t.k.registry.taskForMessage(newer.messageId)?.status).toBe('done')
    expect(t.k.registry.taskForMessage(older.messageId)).toBeUndefined()
    expect(t.k.questions.replies(t.question.id).map(reply => reply.messageId)).toEqual([newer.messageId])
    expect(t.row(older.messageId)?.result).not.toBeNull()
  })

  it('does not let an older deferred question stop cancel a later human reply execution', async () => {
    const t = await fixture(), older = t.reply('older-stop', '停止这轮。'), newer = t.reply('later-human-reply', '继续，按这份新信息查。')
    t.classify.mockRejectedValueOnce(new IngressClassificationError('timeout'))
    await t.k.host.handleMessage(older)
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    t.k.state.script = [{ kind: 'hook', run: async () => { enter(); await held } }, { kind: 'text', text: '已处理新的补充。' }]
    t.classify.mockResolvedValueOnce({ kind: 'amend', targetRef: 'question' })
    const running = t.k.host.handleMessage(newer)
    try {
      await entered
      const newerTask = t.k.registry.taskForMessage(newer.messageId)!
      expect(newerTask.status).toBe('running')
      t.classify.mockResolvedValueOnce({ kind: 'stop', targetRef: 'question' })
      t.advance(); await t.k.host.recoverHandoffs()
      expect(t.k.questions.get(t.question.id)?.resolution).toBe('open')
      expect(t.k.registry.getTask(newerTask.id)?.status).toBe('running')
      expect(t.k.state.cancelled).toEqual([])
      expect(t.row(older.messageId)?.result).not.toBeNull()
    } finally { release(); await running }
    expect(t.k.registry.taskForMessage(newer.messageId)?.status).toBe('done')
  })

  it('does not revive pending work from a stopped feedback after a newer explicit stop', async () => {
    const t = await fixture(true), older = t.reply('older-work', '把这条反馈整理成待办。'), stop = t.reply('stop-again', '这件事到此为止。')
    t.classify.mockRejectedValueOnce(new IngressClassificationError('timeout'))
    await t.k.host.handleMessage(older)
    t.classify.mockResolvedValueOnce({ kind: 'stop', targetRef: 'feedback' })
    await t.k.host.handleMessage(stop)
    t.classify.mockImplementationOnce(async input => {
      const source = input.candidates.find(candidate => candidate.ref === 'feedback')?.materialRefs?.[0]
      expect(source).toBeDefined()
      return { kind: 'new_work', contextRefs: [source!] }
    })
    t.advance(); await t.k.host.recoverHandoffs()
    expect(t.k.registry.taskForMessage(older.messageId)).toBeUndefined()
    expect(t.k.bugs.get(t.bucket.id)?.intakePhase).toBe('cancelled')
    expect(t.row(older.messageId)?.result).not.toBeNull()
  })

  it('keeps unrelated independent work separate from later control of the replied feedback', async () => {
    const t = await fixture(true), older = t.reply('independent-topic', '另一个无关问题：解释归并排序。'), stop = t.reply('stop-feedback', '原反馈继续停止。')
    t.classify.mockRejectedValueOnce(new IngressClassificationError('timeout'))
    await t.k.host.handleMessage(older)
    t.classify.mockResolvedValueOnce({ kind: 'stop', targetRef: 'feedback' })
    await t.k.host.handleMessage(stop)
    t.classify.mockResolvedValueOnce({ kind: 'new_work', contextRefs: [] })
    t.advance(); await t.k.host.recoverHandoffs()
    expect(t.k.registry.taskForMessage(older.messageId)?.status).toBe('done')
    expect(t.k.bugs.get(t.bucket.id)?.intakePhase).toBe('cancelled')
    expect(t.k.questions.replies(t.question.id)).toEqual([])
  })

  it('retires a recovered question whose actual thread binding changed without using another model attempt', async () => {
    const t = await fixture(), input = t.reply('changed-anchor', '原始补充。')
    t.classify.mockRejectedValueOnce(new IngressClassificationError('timeout'))
    await t.k.host.handleMessage(input)
    t.k.registry.db.prepare('UPDATE bug_message_anchors SET thread_id=? WHERE id=?').run('changed-thread', t.question.anchorId)
    t.advance(); await t.k.host.recoverHandoffs(); await t.k.host.recoverHandoffs()
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(t.k.registry.taskForMessage(input.messageId)).toBeUndefined()
    expect(t.row(input.messageId)?.result).toBe('question_changed')
  })

  it('rolls back a question stop with its receipt and recovers the classified stop without calling the model again', async () => {
    const t = await fixture(), input = t.reply('stop', '停止这件事。')
    t.classify.mockResolvedValueOnce({ kind: 'stop', targetRef: 'question' })
    const internal = t.k.host as unknown as { ingressReceipts: IngressReceipts }
    const original = internal.ingressReceipts.applied.bind(internal.ingressReceipts)
    const write = vi.spyOn(internal.ingressReceipts, 'applied').mockImplementationOnce((id, decision, result) => {
      original(id, decision, result)
      throw new Error('synthetic crash after receipt write')
    })
    await expect(t.k.host.handleMessage(input)).rejects.toThrow('synthetic crash')
    expect(t.k.questions.get(t.question.id)?.resolution).toBe('open')
    expect(t.row(input.messageId)).toMatchObject({ result: null, notice: null })
    expect(JSON.parse(t.row(input.messageId)!.decision!)).toEqual({ kind: 'stop', targetRef: 'question' })
    write.mockRestore()
    await t.reboot(); await t.k.host.recoverHandoffs(); await t.k.host.recoverHandoffs()
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(t.k.questions.get(t.question.id)?.resolution).toBe('cancelled')
    expect(t.row(input.messageId)?.result).not.toBeNull()
    expect(t.routeTexts().filter(text => text.includes('已停止这轮执行'))).toHaveLength(1)
  })

  it.each([false, true])('recovers a committed progress receipt with the correct domain wording (stopped=%s)', async stopped => {
    const t = await fixture(stopped), input = t.reply('progress', '现在是什么状态？')
    t.classify.mockResolvedValueOnce({ kind: 'progress', targetRef: stopped ? 'feedback' : 'question' })
    const internal = t.k.host as unknown as { sendIngressReceipt: (...args: unknown[]) => Promise<void> }
    vi.spyOn(internal, 'sendIngressReceipt').mockRejectedValueOnce(new Error('synthetic crash before delivery'))
    await expect(t.k.host.handleMessage(input)).rejects.toThrow('synthetic crash')
    expect(t.row(input.messageId)?.notice).toBeTruthy()
    await t.reboot(); await t.k.host.recoverHandoffs(); await t.k.host.recoverHandoffs()
    expect(t.classify).toHaveBeenCalledTimes(1)
    expect(t.routeTexts().some(text => text.includes('原任务记录已不可用'))).toBe(false)
    const expected = stopped ? '已停止跟进' : '等待补充'
    expect(t.routeTexts().filter(text => text.includes(expected))).toHaveLength(1)
  })
})
