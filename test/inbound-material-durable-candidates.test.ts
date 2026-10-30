import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IngressClassificationInput, IngressDecision } from '../src/acp/ingress-classifier.js'
import { loadConfig } from '../src/config.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { Bugs } from '../src/core/bugs.js'
import { FeedbackControl } from '../src/core/feedback-control.js'
import { InboundMaterials, MAX_CONTEXT_MATERIALS, type InboundMaterialReference } from '../src/core/inbound-materials.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import type { AskBugQuestionReceipt } from '../src/core/question-types.js'
import { Registry, type TaskRow } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { SourceContexts } from '../src/core/source-context.js'
import { Todos } from '../src/core/todos.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { spaceDeps } from './helpers/space.js'

const closes: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })

/** Real Task receipts, Work ancestry and material bindings; no model, platform or byte reads. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-durable-materials-')), path = join(home, 'friday.db')
  let registry = new Registry(path), serial = 0, now = Date.UTC(2026, 8, 22, 12)
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  closes.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  const message = (text: string, over: Partial<InboundMessage> = {}): InboundMessage => {
    const messageId = `material-${++serial}`
    return { eventId: `event-${messageId}`, messageId, chatId: 'oc_dm_alice', chatType: 'p2p', senderOpenId: 'ou_alice',
      senderType: 'user', text, msgType: 'text', mentions: [], createTimeMs: ++now, ...over }
  }
  const accept = (text: string, options: { inbound?: Partial<InboundMessage>; sessionKey?: string; amends?: TaskRow } = {}) => {
    const inbound = message(text, options.inbound)
    const sessionKey = options.sessionKey ?? options.amends?.sessionKey ?? `session:${inbound.chatId}:${inbound.senderOpenId}`
    if (!registry.getSession(sessionKey)) registry.createSession({ sessionKey, chatId: inbound.chatId, chatType: inbound.chatType,
      requesterOpenId: inbound.senderOpenId, threadId: inbound.threadId, rootMessageId: inbound.rootId ?? inbound.messageId, cwd: home })
    const task = registry.createTaskOnce({ sessionKey, messageId: inbound.messageId, requesterOpenId: inbound.senderOpenId,
      prompt: text, inbound, ...(options.amends ? { amendsTaskId: options.amends.id } : {}) }).task
    registry.updateTask(task.id, { status: 'done', stopReason: 'end_turn', finishedAt: now })
    return registry.getTask(task.id)!
  }
  const reference = (task: TaskRow): InboundMaterialReference => ({ ref: `bound-${task.id}`, taskId: task.id,
    message: registry.dispatches.get(task.id)!.inbound })
  const bind = (target: TaskRow, sources: TaskRow[]) => new InboundMaterials(registry).bind(target,
    registry.dispatches.get(target.id)!.inbound, sources.map(reference))
  return { home, message, accept, reference, bind, advance: (ms = 31 * 60_000) => { now += ms },
    reopen: () => { registry.close(); registry = new Registry(path) },
    get registry() { return registry }, get materials() { return new InboundMaterials(registry) } }
}

describe('durable material candidates for existing work', () => {
  it('retains the exact material bound to a completed task after thirty minutes and a database reopen', () => {
    const t = fixture()
    const source = t.accept('[合并转发消息]', { inbound: { msgType: 'merge_forward',
      mentions: [{ key: '@person', name: '报告人', openId: 'ou_reporter' }], fileKey: 'synthetic-attachment', fileName: '报告.txt' } })
    const summary = t.accept('先整理这段讨论的结论')
    t.bind(summary, [source])
    const before = t.materials.forTask(summary.id)
    t.advance(); t.reopen()
    const followup = t.message('这里哪些需要我跟进？')
    expect(t.materials.candidates(followup)).toEqual([])
    const candidates = t.materials.candidates(followup, [summary.id])
    expect(candidates[0]).toMatchObject({ taskId: source.id, message: t.reference(source).message })
    expect(candidates.map(candidate => candidate.taskId)).toContain(summary.id)
    expect(candidates[0]?.message).toMatchObject({ fileKey: 'synthetic-attachment', mentions: [{ openId: 'ou_reporter' }] })
    expect(t.materials.forTask(summary.id)).toEqual(before)
  })

  it('includes lawful amendment ancestors but not another work sharing the same Session', () => {
    const t = fixture(), original = t.accept('[合并转发消息]', { inbound: { msgType: 'merge_forward' } })
    const unrelated = t.accept('UNRELATED_WORK_MUST_NOT_ENTER_MATERIALS')
    const first = t.accept('只列需要确认的部分', { amends: original })
    const latest = t.accept('把人物也区分开', { amends: first })
    t.advance()
    const candidates = t.materials.candidates(t.message('继续这件事，附原文出处'), [latest.id])
    expect(candidates.map(candidate => candidate.taskId)).toEqual([original.id, first.id, latest.id])
    expect(candidates.some(candidate => candidate.taskId === unrelated.id)).toBe(false)
  })

  it('offers both old plausible sources instead of choosing the latest work or one source implicitly', () => {
    const t = fixture(), sourceA = t.accept('转发 A：修复输出截断'), sourceB = t.accept('转发 B：修正文档链接')
    const workA = t.accept('整理第一件事'), workB = t.accept('整理第二件事')
    t.bind(workA, [sourceA]); t.bind(workB, [sourceB]); t.advance()
    const candidates = t.materials.candidates(t.message('把这件事继续跟进'), [workB.id, workA.id])
    expect(candidates.slice(0, 2).map(candidate => candidate.taskId)).toEqual([sourceB.id, sourceA.id])
    expect(candidates).toHaveLength(4)
    expect(t.materials.forTask(workA.id).map(reference => reference.taskId)).toEqual([sourceA.id])
    expect(t.materials.forTask(workB.id).map(reference => reference.taskId)).toEqual([sourceB.id])
  })

  it('caps context at four and gives each plausible work an evidence slot before a second source', () => {
    const t = fixture(), work: TaskRow[] = [], firstSources: number[] = []
    for (let i = 0; i < 5; i++) {
      const a = t.accept(`资料 ${i} A`), b = t.accept(`资料 ${i} B`), task = t.accept(`整理资料 ${i}`)
      t.bind(task, [a, b]); work.push(task); firstSources.push(a.id)
    }
    t.advance()
    const candidates = t.materials.candidates(t.message('还要核对哪些事项'), work.map(task => task.id))
    expect(candidates).toHaveLength(MAX_CONTEXT_MATERIALS)
    expect(candidates.map(candidate => candidate.taskId)).toEqual(firstSources.slice(0, MAX_CONTEXT_MATERIALS))
  })

  it.each(['different_person', 'different_chat', 'different_chat_type', 'changed_dm_owner'] as const)(
    'does not inherit candidate work after %s', change => {
      const t = fixture(), source = t.accept('只属于当前用户和会话的材料'), work = t.accept('整理材料')
      t.bind(work, [source]); t.advance()
      const followup = t.message('继续')
      if (change === 'different_person') followup.senderOpenId = 'ou_bob'
      if (change === 'different_chat') followup.chatId = 'oc_another'
      if (change === 'different_chat_type') followup.chatType = 'group'
      if (change === 'changed_dm_owner') t.registry.updateSession(work.sessionKey, { requesterOpenId: 'ou_bob' })
      expect(t.materials.candidates(followup, [work.id])).toEqual([])
    })

  it('does not expand work from a different group thread merely because the actor and chat match', () => {
    const t = fixture()
    const source = t.accept('[合并转发消息]', { sessionKey: 'thread-a', inbound: { chatType: 'group', chatId: 'oc_group',
      threadId: 'omt_a', rootId: 'om_a', msgType: 'merge_forward' } })
    t.advance()
    expect(t.materials.candidates(t.message('继续', { chatType: 'group', chatId: 'oc_group', threadId: 'omt_b', rootId: 'om_b' }), [source.id]))
      .toEqual([])
    expect(t.materials.candidates(t.message('继续', { chatType: 'group', chatId: 'oc_group', threadId: 'omt_a', rootId: 'om_a' }), [source.id])
      .map(reference => reference.taskId)).toEqual([source.id])
  })

  it('retains an explicitly bound same-chat source through its candidate work instead of discovering other threads', () => {
    const t = fixture()
    const source = t.accept('明确引用的群内原文', { sessionKey: 'thread-a', inbound: { chatType: 'group', chatId: 'oc_group',
      threadId: 'omt_a', rootId: 'om_a' } })
    const work = t.accept('根据刚才引用的原文整理', { sessionKey: 'thread-b', inbound: { chatType: 'group', chatId: 'oc_group',
      threadId: 'omt_b', rootId: 'om_b' } })
    t.bind(work, [source]); t.advance()
    const candidates = t.materials.candidates(t.message('继续整理', { chatType: 'group', chatId: 'oc_group', threadId: 'omt_b', rootId: 'om_b' }), [work.id])
    expect(candidates[0]?.taskId).toBe(source.id)
    expect(candidates.map(candidate => candidate.taskId)).toEqual([source.id, work.id])
  })

  it('honors an explicit reference to an older message without admitting unrelated expired material', () => {
    const t = fixture(), source = t.accept('[合并转发消息]', { inbound: { msgType: 'merge_forward' } })
    t.accept('另外一份过期且无关联的资料'); t.advance()
    const followup = t.message('继续', { parentId: source.messageId })
    expect(t.materials.candidates(followup).map(reference => reference.taskId)).toEqual([source.id])
  })

  it('rejects a changed material envelope while keeping the valid work input available', () => {
    const t = fixture(), source = t.accept('真实原文'), work = t.accept('整理原文')
    t.bind(work, [source])
    const forged = t.materials.forTask(work.id).map(reference => ({ ...reference, message: { ...reference.message, text: 'FORGED_BODY' } }))
    t.registry.setKv(`task-input-materials:${work.id}`, JSON.stringify(forged))
    t.advance()
    const candidates = t.materials.candidates(t.message('继续'), [work.id])
    expect(candidates.map(reference => reference.taskId)).toEqual([work.id])
    expect(JSON.stringify(candidates)).not.toContain('FORGED_BODY')
  })

  it('does not follow a forged amendment edge across different work roots', () => {
    const t = fixture(), a = t.accept('UNRELATED_SOURCE'), b = t.accept('当前工作')
    t.registry.db.prepare('INSERT INTO task_amendments(task_id,prior_task_id) VALUES (?,?)').run(b.id, a.id)
    t.advance()
    expect(t.materials.candidates(t.message('继续当前工作'), [b.id]).map(reference => reference.taskId)).toEqual([b.id])
  })

  it('rechecks archived source sessions even when the receiving work remains available', () => {
    const t = fixture(), source = t.accept('原文', { sessionKey: 'source-session' }), work = t.accept('整理')
    t.bind(work, [source]); t.advance()
    t.registry.updateSession(source.sessionKey, { status: 'archived' })
    expect(t.materials.candidates(t.message('继续'), [work.id]).map(reference => reference.taskId)).toEqual([work.id])
  })
})

function hostFixture() {
  const t = fixture(), registry = t.registry, sp = spaceDeps(registry.db)
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: t.home,
    FRIDAY_REFLECT: 'off', FRIDAY_DEFAULT_EXECUTION: 'managed', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('durable-material-host', 'error')
  const cache = new MessageCache(registry.db), memory = new ChannelMemory(registry.db), messages = new MessageService(feishu, cache, log)
  const bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs), routines = new RoutineStore(registry.db)
  const feedback = new FeedbackControl(registry, bugs, questions, routines)
  const userTokens = new UserTokenStore(registry.db, fake)
  const execution = managedHostRuntime(registry, t.home, log), { runtime, managed } = execution, state = execution.peer.state
  state.script = [{ kind: 'text', text: '合成讨论整理结果。' }]
  const classify = vi.fn<(input: IngressClassificationInput) => Promise<IngressDecision>>(async () => ({ kind: 'new_work' }))
  const host = new Orchestrator({ cfg, registry, ...sp, memory, messageCache: cache, messages, todos: new Todos(registry.db),
    routines, feedback, questions, userTokens, feishu, runtime, managed, tokens: new TokenIssuer('synthetic-key'),
    ingressClassifier: { classify }, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  closes.push(() => runtime.stop())
  const forward = (text: string, withAttachment = false) => {
    const message = t.message('[合并转发消息]', { msgType: 'merge_forward' })
    fake.messages.set(message.messageId, historyMsg({ ...message, senderName: '合成用户' }))
    fake.forwarded.set(message.messageId, [historyMsg({ messageId: `${message.messageId}-child`, chatId: 'oc_original_group',
      senderOpenId: 'ou_reporter', senderName: '报告人', text, mentions: [{ key: '@alice', name: '合成用户', openId: 'ou_alice' }] }),
      ...(withAttachment ? [historyMsg({ messageId: `${message.messageId}-attachment`, chatId: 'oc_original_group', msgType: 'file',
        senderOpenId: 'ou_reporter', senderName: '报告人', text: '[文件 evidence.txt]', fileName: 'evidence.txt', fileKey: 'synthetic-forwarded-evidence' })] : [])])
    return message
  }
  return { ...t, ...sp, fake, classify, host, runtime, state, forward, bugs, questions, feedback,
    task: (message: InboundMessage) => registry.taskForMessage(message.messageId) }
}

describe('natural follow-up after the recent-material window through the real host', () => {
  it('offers the original bound forward after 31 minutes and rebuilds it for the correct amended work', async () => {
    const t = hostFixture(), source = t.forward('输出截断修好以后，需要把结果告诉报告人。')
    await t.host.handleMessage(source)
    t.classify.mockImplementationOnce(async input => ({ kind: 'new_work', contextRefs: [input.materials![0]!.ref] }))
    const summary = t.message('先整理这段讨论的结论')
    await t.host.handleMessage(summary)
    const prior = t.task(summary)!, session = t.registry.getSession(prior.sessionKey)!
    expect(t.materials.forTask(prior.id).map(reference => reference.taskId)).toEqual([t.task(source)!.id])
    await t.runtime.closeSession(session.acpSessionId!)
    t.registry.updateSession(session.sessionKey, { acpSessionId: null })
    t.advance()
    t.classify.mockImplementationOnce(async input => {
      expect(input.message.replyToRef).toBeUndefined()
      expect(input.materials).toContainEqual(expect.objectContaining({ kind: 'merge_forward', preview: expect.stringContaining('把结果告诉报告人') }))
      const target = input.candidates.find(candidate => candidate.title.includes('先整理这段讨论的结论'))!
      return { kind: 'amend', targetRef: target.ref }
    })
    const followup = t.message('这里面哪些事需要我跟进？把人物和出处列出来。')
    await t.host.handleMessage(followup)
    const current = t.task(followup)!
    expect(current?.status).toBe('done')
    expect(t.registry.taskWork.get(current.id)?.key).toBe(t.registry.taskWork.get(prior.id)?.key)
    expect(t.state.allPrompts.at(-1)?.text).toContain('把结果告诉报告人')
    expect(t.state.allPrompts.at(-1)?.text).toContain('ou_reporter')
    expect(t.fake.of('sendToChat').every(record => record.target === source.chatId)).toBe(true)
  })

  it('keeps two old material choices visible and continues the private conversation unbound when the classifier finds the follow-up ambiguous', async () => {
    const t = hostFixture(), first = t.forward('事项甲：修复输出截断'), second = t.forward('事项乙：更新安装说明')
    await t.host.handleMessage(first)
    await t.host.handleMessage(second)
    t.advance()
    // Every reading of this message finds it ambiguous (the host rereads an unclear message before asking back).
    t.classify.mockImplementation(async input => {
      const forwardMaterials = input.materials?.filter(material => material.kind === 'merge_forward') ?? []
      expect(forwardMaterials).toHaveLength(2)
      expect(forwardMaterials.map(material => material.preview).join('\n')).toContain('事项甲')
      expect(forwardMaterials.map(material => material.preview).join('\n')).toContain('事项乙')
      return { kind: 'clarify' }
    })
    const ambiguous = t.message('把那件事记下来')
    await t.host.handleMessage(ambiguous)
    // In the person's own chat the line continues the conversation (which holds both forwards) instead of being asked
    // back; neither old forward is bound to it as material, and the reading itself stays on record.
    const task = t.task(ambiguous)!
    expect(task.sessionKey).toBe(t.task(second).sessionKey)
    expect(new InboundMaterials(t.registry).forTask(task.id)).toEqual([])
    expect(t.state.allPrompts).toHaveLength(3)
    expect(JSON.parse(String(t.registry.db.prepare('SELECT decision FROM ingress_routes WHERE message_id=?').get(ambiguous.messageId)?.decision)))
      .toEqual({ kind: 'clarify' })
  })
})

async function deliveredReportQuestion(stopped: boolean) {
  const t = hostFixture(), reportText = 'REPORT_EVIDENCE_CANARY：保存报告时输出被截断，报告人请我修复后告诉他。'
  const source = t.forward(reportText, true)
  source.tenantId = 'synthetic-tenant'
  let receipt!: AskBugQuestionReceipt, feedbackId!: number
  const questionText = 'QUESTION_EVIDENCE_CANARY：发生前最后做了哪一步，能提供日志吗？'
  t.state.script = [{ kind: 'hook', run: async () => {
    const task = t.task(source)!, space = t.spaces.byChat(source.chatId)!
    feedbackId = t.bugs.record({ spaceId: space.id, chatId: source.chatId, messageId: source.messageId,
      reporterOpenId: source.senderOpenId, title: '合成报告', text: source.text }).bucket.id
    const actor = t.host.resolveActorForSession(task.sessionKey)!
    receipt = await t.host.askBugQuestion(task.sessionKey, actor.runId, { id: feedbackId, kind: 'info', question: questionText })
  } }, { kind: 'text', text: '已记录问题，等你补充。' }]
  await t.host.handleMessage(source)
  expect(receipt).toMatchObject({ delivery_status: expect.stringMatching(/^(sent|confirmed)$/), message_id: expect.any(String) })
  const original = t.task(source)!, originalWork = t.registry.taskWork.get(original.id)!
  if (stopped) t.feedback.stop({ feedbackId, spaceId: t.spaces.byChat(source.chatId)!.id,
    chatId: source.chatId, chatType: 'p2p', openId: 'ou_alice', controllerTaskId: original.id, now: Date.now() })
  t.state.script = [{ kind: 'text', text: '已处理当前请求。' }]
  t.classify.mockClear()
  return { ...t, source, reportText, questionText, receipt, feedbackId, original, originalWork,
    reply: (text: string) => t.message(text, { parentId: receipt.message_id, tenantId: source.tenantId }) }
}

describe('original report material through question and stopped-feedback new work', () => {
  it.each([false, true])('delivers selected original evidence to the real independent managed prompt (stopped=%s)', async stopped => {
    const t = await deliveredReportQuestion(stopped)
    t.advance()
    t.classify.mockImplementationOnce(async input => {
      const original = input.materials?.find(material => material.kind === 'merge_forward' && material.preview.includes('REPORT_EVIDENCE_CANARY'))
      expect(original).toBeDefined()
      return { kind: 'new_work', contextRefs: [original!.ref] }
    })
    const request = t.reply('日志暂时没有，先把这条报告整理成一份待办草稿，保留人物和原文出处。')
    await t.host.handleMessage(request)
    const next = t.task(request)!
    expect(next?.status).toBe('done')
    expect(next.sessionKey).not.toBe(t.original.sessionKey)
    expect(t.registry.taskWork.get(next.id)?.key).not.toBe(t.originalWork.key)
    expect(t.materials.forTask(next.id).map(material => material.taskId)).toContain(t.original.id)
    const prompt = t.state.allPrompts.at(-1)!.text
    expect(prompt).toContain(t.reportText)
    expect(prompt).toContain(t.questionText)
    expect(prompt).toContain('ou_reporter')
    expect(prompt).toContain('evidence.txt')
    const manifest = new SourceContexts(t.registry).get(next.sessionKey)!
    expect(manifest.deliveredMessages).toContainEqual(expect.objectContaining({
      ref: `question:${t.receipt.question_id}`, deliveryKey: `question:${t.receipt.question_id}`,
      messageId: t.receipt.message_id, tenantId: t.source.tenantId, appId: 'synthetic',
      spaceId: t.spaces.byChat(t.source.chatId)!.id, chatId: t.source.chatId, chatType: 'p2p', targetOpenId: 'ou_alice',
      contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }))
    expect(manifest.chats.some(chat => chat.chatId === t.source.chatId)).toBe(false)
    expect(manifest.messageSources?.some(source => source.chatId === t.source.chatId)).toBe(false)
    expect(t.fake.downloads.some(download => download.fileKey === 'synthetic-forwarded-evidence')).toBe(true)
    expect(t.questions.replies(t.receipt.question_id)).toEqual([])
    expect(t.questions.get(t.receipt.question_id)?.resolution).toBe(stopped ? 'cancelled' : 'open')
    expect(t.registry.workContexts.get(t.originalWork.key)?.lifecycle).toBe(stopped ? 'cancelled' : 'open')
  })

  it.each([false, true])('does not copy the old report, question or authority into unrelated new work (stopped=%s)', async stopped => {
    const t = await deliveredReportQuestion(stopped)
    t.advance()
    t.classify.mockResolvedValueOnce({ kind: 'new_work', contextRefs: [] })
    const request = t.reply('另外一件事，解释归并排序的时间复杂度。')
    await t.host.handleMessage(request)
    const next = t.task(request)!
    expect(next?.status).toBe('done')
    expect(next.sessionKey).not.toBe(t.original.sessionKey)
    expect(t.registry.taskWork.get(next.id)?.key).not.toBe(t.originalWork.key)
    expect(t.materials.forTask(next.id)).toEqual([])
    const prompt = t.state.allPrompts.at(-1)!.text
    expect(prompt).not.toContain('REPORT_EVIDENCE_CANARY')
    expect(prompt).not.toContain('QUESTION_EVIDENCE_CANARY')
    expect(prompt).not.toContain('evidence.txt')
    expect(new SourceContexts(t.registry).get(next.sessionKey)?.deliveredMessages ?? []).toEqual([])
    expect(t.questions.replies(t.receipt.question_id)).toEqual([])
    expect(t.registry.workContexts.get(t.originalWork.key)?.lifecycle).toBe(stopped ? 'cancelled' : 'open')
  })

  it.each([false, true])('rechecks the question receipt after asynchronous material reading (stopped=%s)', async stopped => {
    const t = await deliveredReportQuestion(stopped)
    t.advance()
    let selected = false
    t.classify.mockImplementationOnce(async input => {
      const original = input.materials!.find(material => material.preview.includes('REPORT_EVIDENCE_CANARY'))!
      selected = true
      return { kind: 'new_work', contextRefs: [original.ref] }
    })
    const getItems = t.fake.getMessageItems.bind(t.fake)
    vi.spyOn(t.fake, 'getMessageItems').mockImplementation(async (...args) => {
      const result = await getItems(...args)
      if (selected) t.registry.db.prepare("UPDATE deliveries SET status='unknown' WHERE delivery_key=?")
        .run(`question:${t.receipt.question_id}`)
      return result
    })
    const request = t.reply('根据原始报告整理待办草稿，保留出处。')
    await t.host.handleMessage(request)
    const next = t.task(request)!
    expect(next?.status).toBe('done')
    const prompt = t.state.allPrompts.at(-1)!.text
    expect(prompt).toContain(t.reportText)
    expect(prompt).not.toContain('QUESTION_EVIDENCE_CANARY')
    expect(new SourceContexts(t.registry).get(next.sessionKey)?.deliveredMessages ?? []).toEqual([])
    expect(t.questions.replies(t.receipt.question_id)).toEqual([])
  })

  it('withdraws derived-state write eligibility when a loaded host-question receipt becomes unknown', async () => {
    const t = await deliveredReportQuestion(false)
    t.advance()
    t.classify.mockImplementationOnce(async input => ({ kind: 'new_work', contextRefs: [input.materials!
      .find(material => material.preview.includes('REPORT_EVIDENCE_CANARY'))!.ref] }))
    const request = t.reply('把报告整理成待办草稿，暂不通知别人。')
    let observed: { sources: number; before: boolean; after: boolean } | undefined
    t.state.script = [{ kind: 'hook', run: async () => {
      const task = t.task(request)!
      const sources = new SourceContexts(t.registry).get(task.sessionKey)?.deliveredMessages?.length ?? 0
      const before = t.host.canPersistDerivedState(task.sessionKey)
      t.registry.db.prepare("UPDATE deliveries SET status='unknown' WHERE delivery_key=?").run(`question:${t.receipt.question_id}`)
      observed = { sources, before, after: t.host.canPersistDerivedState(task.sessionKey) }
    } }, { kind: 'text', text: 'DERIVED_STATE_MUST_NOT_BE_PUBLISHED' }]
    await t.host.handleMessage(request)
    expect(observed).toEqual({ sources: 1, before: true, after: false })
    expect(t.fake.answers().join('\n')).not.toContain('DERIVED_STATE_MUST_NOT_BE_PUBLISHED')
  })

  it('also withdraws personal-memory eligibility when mixed-source work loses its host-question proof', async () => {
    const t = await deliveredReportQuestion(false)
    t.advance()
    t.classify.mockImplementationOnce(async input => ({ kind: 'new_work', contextRefs: [input.materials!
      .find(material => material.preview.includes('REPORT_EVIDENCE_CANARY'))!.ref] }))
    const request = t.reply('根据报告和资料整理记忆候选，先不发布。')
    let observed: { before: boolean; after: boolean } | undefined
    t.state.script = [{ kind: 'hook', run: async () => {
      const task = t.task(request)!, actor = t.host.resolveActorForSession(task.sessionKey)!
      const group = t.spaces.ensure({ kind: 'group', chatId: 'oc_synthetic_read_group' })
      // Host-side synthetic read receipt isolates the synchronous eligibility gate;
      // this test does not claim that personal-memory's separate grant check ran.
      t.host.noteMessageRead(task.sessionKey, actor.runId!, { sources: [{ ref: 'synthetic-host-read',
        tenantId: 'synthetic-tenant', appId: 'synthetic', spaceId: group.id, chatId: group.chatId,
        messageId: 'synthetic-read-message', readIdentity: { kind: 'app' }, readAt: Date.now(),
        coverage: 'complete', contentDigest: 'a'.repeat(64) }], complete: true, assertCurrent: () => {} })
      const before = t.host.canPersistPersonalMemory(task.sessionKey)
      t.registry.db.prepare("UPDATE deliveries SET status='unknown' WHERE delivery_key=?").run(`question:${t.receipt.question_id}`)
      observed = { before, after: t.host.canPersistPersonalMemory(task.sessionKey) }
    } }, { kind: 'text', text: 'PERSONAL_MEMORY_MUST_NOT_BE_PUBLISHED' }]
    await t.host.handleMessage(request)
    expect(observed).toEqual({ before: true, after: false })
    expect(t.fake.answers().join('\n')).not.toContain('PERSONAL_MEMORY_MUST_NOT_BE_PUBLISHED')
  })
})
