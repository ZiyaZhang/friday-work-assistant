import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IngressClassificationInput, IngressDecision } from '../src/acp/ingress-classifier.js'
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
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { spaceDeps } from './helpers/space.js'

type Domain = 'task' | 'question' | 'stopped_feedback'
const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

/** DM input must survive before a material provider returns. The actual host,
 * source receipts, managed execution and SQLite reopen are used; remote peers are synthetic. */
async function fixture(domain: Domain) {
  const home = mkdtempSync(join(tmpdir(), 'friday-material-preparation-')), path = join(home, 'friday.db')
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_DEFAULT_EXECUTION: 'managed', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('material-preparation', 'error')
  const classify = vi.fn<(input: IngressClassificationInput) => Promise<IngressDecision>>(async input => {
    // The first ordinary DM now passes through memory-capable ingress too;
    // only subsequent references depend on hydrated historical materials.
    if (!input.candidates.length && !input.materials?.length && !input.memoryTargets?.length) return { kind: 'work_request' }
    const material = input.materials?.find(item => item.kind === 'merge_forward')
    if (!material) throw new Error('Synthetic frozen source not provided to classifier')
    return domain === 'task' ? { kind: 'new_work', contextRefs: [material.ref] }
      : { kind: 'amend', targetRef: domain === 'question' ? 'question' : 'feedback', contextRefs: [material.ref] }
  })
  let serial = 0, clock = Date.now()
  function boot() {
    const registry = new Registry(path), sp = spaceDeps(registry.db)
    const space = sp.spaces.ensure({ kind: 'p2p', chatId: 'synthetic-dm', openId: 'alice' })
    const bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs), routines = new RoutineStore(registry.db)
    const feedback = new FeedbackControl(registry, bugs, questions, routines)
    const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
    const execution = managedHostRuntime(registry, home, log)
    execution.peer.state.counter = serial++ * 100
    execution.peer.state.script = [{ kind: 'text', text: '已处理原始合成材料。' }]
    const host = new Orchestrator({ cfg, registry, ...sp, feedback, questions, routines, memory, messageCache: cache, messages,
      feishu, runtime: execution.runtime, managed: execution.managed, tokens: new TokenIssuer('synthetic'), ingressClassifier: { classify },
      apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/synthetic', botOpenId: 'bot', log, now: () => ++clock })
    return { registry, ...sp, space, bugs, questions, feedback, host, cache, runtime: execution.runtime,
      state: execution.peer.state, receipts: new IngressReceipts(registry.db) }
  }
  let k = boot()
  const pending: Promise<unknown>[] = [], releases: (() => void)[] = []
  const close = async () => { await k.runtime.stop(); k.registry.close() }
  closes.push(async () => { releases.forEach(release => release()); await Promise.allSettled(pending); await close(); rmSync(home, { recursive: true, force: true }) })
  const message = (id: string, text: string, patch: Partial<InboundMessage> = {}): InboundMessage => ({
    eventId: `event-${id}`, messageId: id, chatId: 'synthetic-dm', chatType: 'p2p', tenantId: 'synthetic-tenant',
    senderOpenId: 'alice', senderType: 'user', msgType: 'text', text, mentions: [], createTimeMs: ++clock, ...patch,
  })
  const source = message('forwarded-source', '[合并转发消息]', { msgType: 'merge_forward' })
  fake.messages.set(source.messageId, historyMsg({ ...source, senderName: '合成用户' }))
  fake.forwarded.set(source.messageId, [historyMsg({ messageId: 'synthetic-child', chatId: 'synthetic-origin-chat',
    senderOpenId: 'reporter', senderName: '合成报告人', text: '提交操作偶发卡住，请核查这个合成问题。' })])
  await k.host.handleMessage(source)
  const sourceTask = k.registry.taskForMessage(source.messageId)!
  expect(sourceTask).toMatchObject({ messageId: source.messageId, status: 'done' })
  expect(k.state.allPrompts[0]?.text).toContain('提交操作偶发卡住，请核查这个合成问题。')
  const bucket = k.bugs.record({ spaceId: k.space.id, chatId: source.chatId, messageId: source.messageId,
    reporterOpenId: 'alice', title: '合成问题', text: source.text }).bucket
  let parentId = source.messageId
  if (domain !== 'task') {
    const q = k.questions.prepare({ bucketId: bucket.id, spaceId: k.space.id, sessionKey: sourceTask.sessionKey,
      originTaskId: sourceTask.id, targetOpenId: 'alice', anchor: { tenantId: source.tenantId!, appId: cfg.feishu.appId,
        chatId: source.chatId, messageId: source.messageId }, kind: 'info', question: '发生前最后做了什么？' })
    const delivery = new DeliveryService(k.registry.db, { spaces: k.spaces, policy: k.policy, now: () => clock,
      resolveContext: async () => ({ actorOpenId: 'alice', provenanceComplete: true, expiresAt: clock + 60_000,
        sources: [{ ref: 'synthetic-question-source', spaceId: k.space.id, chatId: source.chatId }],
        audience: { kind: 'dm', spaceId: k.space.id, openId: 'alice' } }),
      send: async () => ({ remoteId: await fake.sendToChat(source.chatId, { text: q.question }) }),
    })
    parentId = (await delivery.deliver({ key: q.deliveryKey, contextRef: q.deliveryKey, payload: { text: q.question } })).remoteId!
    if (domain === 'stopped_feedback') k.feedback.stop({ feedbackId: bucket.id, spaceId: k.space.id,
      chatId: source.chatId, chatType: 'p2p', openId: 'alice', controllerTaskId: sourceTask.id })
  }
  classify.mockClear()
  const originalRead = fake.getMessageItems.bind(fake), held = deferred(), entered = deferred()
  releases.push(held.resolve)
  let block = true
  const read = vi.spyOn(fake, 'getMessageItems').mockImplementation(async id => {
    if (id === source.messageId && block) { block = false; entered.resolve(); await held.promise }
    return originalRead(id)
  })
  const input = message('original-request', '按原始材料记录：最后点击提交，日志暂时没有。', { parentId })
  const dispatch = (msg = input) => { const task = k.host.handleMessage(msg); pending.push(task.catch(() => {})); return task }
  return { input, source, sourceTask, bucket, classify, read, held, entered, dispatch, get k() { return k },
    async rebootWithoutProviderReply() { await close(); k = boot() } }
}

describe('material preparation persists before provider reads', () => {
  it.each(['task', 'question', 'stopped_feedback'] as const)('%s keeps original DM and refs through duplicate input, database reopen and a late old provider reply', async domain => {
    const t = await fixture(domain)
    const first = t.dispatch()
    await t.entered.promise
    const captured = t.k.receipts.pending(t.input.messageId)[0]!
    expect(captured).toMatchObject({ materialsPrepared: false, message: t.input })
    expect(captured.route?.kind ?? 'task').toBe(domain)
    expect(captured.materials?.map(item => item.message.messageId)).toContain(t.source.messageId)
    expect(t.k.cache.get(t.input.messageId)).toBeUndefined() // the ingress receipt, not a DM history cache, owns recovery
    expect(t.k.registry.taskForMessage(t.input.messageId)).toBeUndefined()
    expect(t.classify).not.toHaveBeenCalled()
    const duplicate = t.dispatch({ ...t.input, text: 'DUPLICATE_MUST_NOT_REPLACE_ORIGINAL_TEXT' })
    expect(t.k.receipts.pending(t.input.messageId)[0]).toEqual(captured)

    // The first process never receives the provider result. Keep its promise only
    // to prove a late callback cannot overwrite the reopened gateway's receipt.
    await t.rebootWithoutProviderReply()
    expect(t.k.receipts.pending(t.input.messageId)[0]).toEqual(captured)
    await t.k.host.recoverHandoffs()
    t.held.resolve()
    await Promise.allSettled([first, duplicate])
    await t.k.host.recoverHandoffs()
    expect(t.classify).toHaveBeenCalledTimes(1)
    const actual = t.classify.mock.calls[0]![0]
    expect(actual.message).toEqual(captured.input.message)
    expect(actual.candidates).toEqual(captured.input.candidates)
    expect(actual.materials?.map(item => item.ref)).toEqual(captured.materials?.map(item => item.ref))
    expect(actual.materials?.find(item => item.kind === 'merge_forward')?.preview).toContain('提交操作偶发卡住')
    const row = t.k.registry.db.prepare('SELECT handoff,result,attempt_count FROM ingress_routes WHERE message_id=?')
      .get(t.input.messageId) as { handoff: string; result: string | null; attempt_count: number }
    expect(JSON.parse(row.handoff)).toMatchObject({ materialsPrepared: true, message: t.input, materials: captured.materials })
    expect(row).toMatchObject({ attempt_count: 1 })
    expect(row.result).not.toBeNull()
    if (domain === 'stopped_feedback') {
      expect(t.k.registry.taskForMessage(t.input.messageId)).toBeUndefined()
      expect(t.k.bugs.reports(t.bucket.id).filter(item => item.messageId === t.input.messageId))
        .toMatchObject([{ recordKind: 'user_note', text: t.input.text }])
      expect(t.k.state.allPrompts).toEqual([])
    } else {
      expect(t.k.registry.taskForMessage(t.input.messageId)).toMatchObject({ prompt: t.input.text, status: 'done' })
      expect(t.k.state.allPrompts).toHaveLength(1)
      expect(t.k.state.allPrompts[0]!.text).toContain(t.input.text)
      expect(t.k.state.allPrompts[0]!.text).toContain('提交操作偶发卡住')
    }
  })

  it('does not prepare or classify a retired request when the old provider finally returns', async () => {
    const t = await fixture('task'), first = t.dispatch()
    await t.entered.promise
    t.k.receipts.retire(t.input.messageId, 'user_requested')
    t.held.resolve(); await first
    await t.rebootWithoutProviderReply(); await t.k.host.recoverHandoffs()
    expect(t.classify).not.toHaveBeenCalled()
    expect(t.k.registry.taskForMessage(t.input.messageId)).toBeUndefined()
    const row = t.k.registry.db.prepare('SELECT handoff,result,decision,attempt_count FROM ingress_routes WHERE message_id=?')
      .get(t.input.messageId) as { handoff: string }
    expect(row).toMatchObject({ result: 'user_requested', decision: null, attempt_count: 0 })
    expect(JSON.parse(row.handoff)).toMatchObject({ materialsPrepared: false, message: t.input })
  })

  it('preserves and retires the original request when source-space access is lost during preparation', async () => {
    const t = await fixture('task'), first = t.dispatch()
    await t.entered.promise
    expect(t.k.spaces.archive(t.k.space.id)).toBe(true)
    t.held.resolve()
    await expect(first).rejects.toThrow('引用材料的空间或发起人已变化')
    const original = t.k.receipts.pending(t.input.messageId)[0]!
    expect(original).toMatchObject({ message: t.input, materialsPrepared: false })
    await t.rebootWithoutProviderReply(); await t.k.host.recoverHandoffs()
    expect(t.classify).not.toHaveBeenCalled()
    expect(t.k.registry.taskForMessage(t.input.messageId)).toBeUndefined()
    expect(t.k.registry.db.prepare('SELECT result,decision,attempt_count FROM ingress_routes WHERE message_id=?').get(t.input.messageId))
      .toMatchObject({ result: 'access_changed', decision: null, attempt_count: 0 })
  })
})
