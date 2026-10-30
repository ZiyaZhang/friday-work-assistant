import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IngressClassificationError, type IngressClassificationInput, type IngressDecision } from '../src/acp/ingress-classifier.js'
import { loadConfig } from '../src/config.js'
import { InboundMaterials } from '../src/core/inbound-materials.js'
import { IngressReceipts } from '../src/core/ingress.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { spaceDeps } from './helpers/space.js'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

/** Real disk receipts, routing, admission, managed ACP and delivery ledger. Only platform/model peers are synthetic. */
function fixture(kind: 'p2p' | 'group' = 'p2p') {
  const home = mkdtempSync(join(tmpdir(), 'friday-ingress-recovery-')), path = join(home, 'friday.db')
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_DEFAULT_EXECUTION: 'managed', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('ingress-recovery', 'error')
  const chatId = kind === 'p2p' ? 'oc_recovery_dm' : 'oc_recovery_group'
  fake.chats = [{ chatId, name: '合成验收会话' }]
  fake.members.set(chatId, new Set(['ou_alice', 'ou_bob']))
  const classify = vi.fn<(input: IngressClassificationInput, signal?: AbortSignal) => Promise<IngressDecision>>(async () => ({ kind: 'work_request' }))
  let clock = Date.now(), serial = 0, boots = 0
  const peers: ReturnType<typeof managedHostRuntime>['peer']['state'][] = []
  const releases: (() => void)[] = [], pending: Promise<unknown>[] = []
  function boot() {
    const registry = new Registry(path), sp = spaceDeps(registry.db)
    const space = sp.spaces.ensure({ kind, chatId, openId: 'ou_alice' })
    if (kind === 'group') sp.spaces.addMember(space.id, 'ou_bob', 'member')
    const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db)
    const messages = new MessageService(feishu, cache, log), todos = new Todos(registry.db), routines = new RoutineStore(registry.db)
    const execution = managedHostRuntime(registry, home, log), { runtime, managed } = execution
    const state = execution.peer.state
    state.counter = 100 * boots++
    state.script = [{ kind: 'text', text: '合成材料处理结果。' }]
    peers.push(state)
    const host = new Orchestrator({ cfg, registry, ...sp, memory, messageCache: cache, messages, todos, routines,
      feishu, runtime, managed, tokens: new TokenIssuer('synthetic-key'), ingressClassifier: { classify },
      apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log, now: () => clock })
    return { registry, ...sp, space, todos, host, runtime, state, receipts: new IngressReceipts(registry.db) }
  }
  let kernel = boot()
  const close = async () => { await kernel.runtime.stop(); kernel.registry.close() }
  closes.push(async () => {
    releases.forEach(release => release())
    await Promise.all(pending)
    await close()
    rmSync(home, { recursive: true, force: true })
  })
  const msg = (text: string, over: Partial<InboundMessage> = {}): InboundMessage => {
    const messageId = `synthetic-ingress-${++serial}`
    return { eventId: `event-${messageId}`, messageId, chatId, chatType: kind, senderOpenId: 'ou_alice', senderType: 'user',
      msgType: 'text', text: kind === 'group' ? `@Friday ${text}` : text,
      mentions: kind === 'group' ? [{ key: '@Friday', name: 'Friday', openId: 'ou_bot' }] : [], createTimeMs: ++clock, ...over }
  }
  const forward = () => {
    const source = msg('[合并转发消息]', { msgType: 'merge_forward' })
    fake.messages.set(source.messageId, historyMsg({ ...source, senderName: '合成用户' }))
    fake.forwarded.set(source.messageId, [historyMsg({ messageId: `${source.messageId}-child`, chatId: 'oc_source_not_joined',
      senderOpenId: 'ou_reporter', senderName: '报告人', text: '修复输出截断后请确认结果。负责人和截止时间尚未确定。',
      mentions: [{ key: '@alice', name: '合成用户', openId: 'ou_alice' }] })])
    return source
  }
  const dispatch = (message: InboundMessage) => {
    const result = kernel.host.handleMessage(message)
    pending.push(result.catch(() => {}))
    return result
  }
  const barrier = () => { const gate = deferred(); releases.push(gate.resolve); return gate }
  const task = (message: InboundMessage) => kernel.registry.taskForMessage(message.messageId)
  const route = (message: InboundMessage) => kernel.registry.db.prepare('SELECT decision,result,handoff FROM ingress_routes WHERE message_id=?')
    .get(message.messageId) as { decision: string | null; result: string | null; handoff: string } | undefined
  const failureDeliveries = (message: InboundMessage) => kernel.registry.db.prepare('SELECT delivery_key,status,remote_id FROM deliveries WHERE delivery_key LIKE ? ORDER BY delivery_key')
    .all(`route-failure:${message.messageId}:%`)
  const executed = () => peers.flatMap(state => state.allPrompts)
  const taskCount = () => Number(kernel.registry.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n)
  const reboot = async () => { await close(); kernel = boot() }
  return { cfg, fake, classify, msg, forward, dispatch, task, route, failureDeliveries, executed, taskCount, reboot, barrier,
    advance: (ms: number) => { clock += ms }, get k() { return kernel } }
}

type Fixture = ReturnType<typeof fixture>
async function acceptSource(t: Fixture, source: InboundMessage): Promise<void> {
  await t.dispatch(source)
  expect(t.task(source)).toMatchObject({ messageId: source.messageId, status: 'done' })
  expect(t.executed().at(-1)?.text).toContain('负责人和截止时间尚未确定')
}
function classificationsFor(t: Fixture, message: InboundMessage): IngressClassificationInput[] {
  // Each synthetic request has distinct text. The public classifier receives
  // that original text, not platform IDs; unrelated earlier routing calls do
  // not consume this envelope's three-attempt recovery budget.
  return t.classify.mock.calls.map(([input]) => input).filter(input => input.message.text === message.text)
}
function useMaterial(input: IngressClassificationInput): IngressDecision {
  const source = input.materials?.find(material => material.kind === 'merge_forward')
  if (!source) throw new Error('Synthetic forwarded material was lost from the persisted classification input')
  return { kind: 'new_work', contextRefs: [source.ref] }
}
function expectNotClarified(t: Fixture, message: InboundMessage) {
  const route = t.route(message)
  expect(route?.decision && JSON.parse(route.decision).kind).not.toBe('clarify')
  expect(JSON.stringify(t.fake.sent)).not.toContain('哪件事')
}

describe('durable ingress classification failure recovery', () => {
  it.each(['timeout', 'unavailable'] as const)('preserves the original forwarded request after %s, then applies it exactly once', async code => {
    const t = fixture(), source = t.forward()
    await acceptSource(t, source)
    const original = t.task(source)!, before = t.executed().length
    t.classify.mockRejectedValueOnce(new IngressClassificationError(code))
    const request = t.msg('把这段需要我跟进的事记下来，负责人和截止没说清就留空，附出处。')
    await t.dispatch(request)
    expect(t.task(request)).toBeUndefined()
    expect(t.task(source)).toEqual(original)
    expect(t.taskCount()).toBe(1)
    expect(t.executed()).toHaveLength(before)
    expect(t.route(request)).toMatchObject({ decision: null, result: null })
    const handoff = t.k.receipts.pending(request.messageId)[0]!
    expect(handoff.message).toEqual(request)
    expect(handoff.materials?.map(material => material.message.messageId)).toContain(source.messageId)
    expect(handoff.input.materials).toContainEqual(expect.objectContaining({ kind: 'merge_forward' }))
    expectNotClarified(t, request)
    expect(t.failureDeliveries(request)).toMatchObject([{ status: 'sent', remote_id: expect.any(String) }])
    const sendsBeforeDuplicate = t.fake.sent.length
    await Promise.all([t.dispatch({ ...request, text: 'DUPLICATE_ENVELOPE_MUST_NOT_REPLACE_THE_ORIGINAL_REQUEST' }),
      t.k.host.recoverHandoffs(), t.k.host.recoverHandoffs()])
    expect(classificationsFor(t, request)).toHaveLength(1)
    expect(t.failureDeliveries(request)).toHaveLength(1)
    expect(t.fake.sent).toHaveLength(sendsBeforeDuplicate)
    t.classify.mockImplementationOnce(async input => {
      expect(input).toEqual(handoff.input)
      return useMaterial(input)
    })
    t.advance(60_001)
    await t.k.host.recoverHandoffs()
    const created = t.task(request)!
    expect(created).toMatchObject({ messageId: request.messageId, requesterOpenId: request.senderOpenId, status: 'done' })
    expect(t.k.registry.dispatches.get(created.id)?.inbound).toEqual(request)
    expect(new InboundMaterials(t.k.registry).forTask(created.id).map(material => material.message.messageId)).toEqual([source.messageId])
    expect(t.executed().at(-1)?.text).toContain('负责人和截止时间尚未确定')
    expect(t.task(source)).toEqual(original)
    const sendsAfterSuccess = t.fake.sent.length
    await t.dispatch(request)
    await t.k.host.recoverHandoffs()
    expect(classificationsFor(t, request)).toHaveLength(2)
    expect(t.taskCount()).toBe(2)
    expect(t.executed()).toHaveLength(before + 1)
    expect(t.failureDeliveries(request)).toHaveLength(1)
    expect(t.fake.sent).toHaveLength(sendsAfterSuccess)
  })

  it('does not cancel or replace existing running work when its follow-up classifier fails', async () => {
    const t = fixture(), source = t.forward(), entered = t.barrier(), held = t.barrier()
    t.k.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await held.promise } }, { kind: 'text', text: '原工作完成。' }]
    const first = t.dispatch(source)
    await entered.promise
    const original = t.task(source)!, work = t.k.registry.taskWork.get(original.id)!
    t.classify.mockRejectedValueOnce(new IngressClassificationError('timeout'))
    const followup = t.msg('还要保留原文出处', { parentId: source.messageId })
    await t.dispatch(followup)
    expect(t.task(source)?.status).toBe('running')
    expect(t.k.registry.workContexts.get(work.key)?.lifecycle).toBe('open')
    expect(t.k.state.cancelled).toEqual([])
    expect(t.task(followup)).toBeUndefined()
    expect(t.executed()).toHaveLength(1)
    expectNotClarified(t, followup)
    held.resolve(); await first
    expect(t.task(source)?.status).toBe('done')
  })

  it('recovers from a reopened SQLite database without requiring another human message or repeating the notice', async () => {
    const t = fixture(), source = t.forward()
    await acceptSource(t, source)
    t.classify.mockRejectedValueOnce(new IngressClassificationError('unavailable'))
    const request = t.msg('跟进转发中的问题，保留人物和出处')
    await t.dispatch(request)
    const originalHandoff = t.k.receipts.pending(request.messageId)[0]!
    expect(t.failureDeliveries(request)).toHaveLength(1)
    const sentBeforeRestart = t.fake.sent.length
    await t.reboot()
    expect(t.k.receipts.pending(request.messageId)[0]).toEqual(originalHandoff)
    await t.k.host.recoverHandoffs()
    expect(classificationsFor(t, request)).toHaveLength(1)
    expect(t.fake.sent).toHaveLength(sentBeforeRestart)
    t.classify.mockImplementationOnce(async input => useMaterial(input))
    t.advance(60_001)
    await t.k.host.recoverHandoffs()
    await t.k.host.recoverHandoffs()
    const task = t.task(request)!
    expect(task?.status).toBe('done')
    expect(t.k.registry.dispatches.get(task.id)?.inbound).toEqual(request)
    expect(t.executed()).toHaveLength(2)
    expect(t.failureDeliveries(request)).toHaveLength(1)
    expect(t.k.receipts.pending(request.messageId)).toEqual([])
  })

  it('does not repeat a failure notice whose platform acknowledgment was lost, including after restart', async () => {
    const t = fixture(), source = t.forward()
    await acceptSource(t, source)
    const send = t.fake.sendToChat.bind(t.fake)
    vi.spyOn(t.fake, 'sendToChat').mockImplementationOnce(async (chatId, payload) => {
      await send(chatId, payload)
      throw new Error('synthetic disconnect after the platform accepted the notice')
    })
    t.classify.mockRejectedValueOnce(new IngressClassificationError('unavailable'))
    const request = t.msg('把讨论里需要我处理的事整理出来')
    await t.dispatch(request)
    expect(t.failureDeliveries(request)).toMatchObject([{ status: 'unknown', remote_id: null }])
    const accepted = t.fake.sent.length
    await t.dispatch(request)
    await t.reboot()
    await t.k.host.recoverHandoffs()
    expect(t.fake.sent).toHaveLength(accepted)
    expect(t.failureDeliveries(request)).toHaveLength(1)
    expect(classificationsFor(t, request)).toHaveLength(1)
    expect(t.task(request)).toBeUndefined()
  })

  it.each(['membership', 'archive', 'allowed_chat_config'] as const)('does not execute the saved request after %s changed during backoff', async change => {
    const t = fixture('group'), source = t.forward()
    await acceptSource(t, source)
    t.classify.mockRejectedValueOnce(new IngressClassificationError('timeout'))
    const request = t.msg('把这段整理成跟进事项', { parentId: source.messageId, rootId: source.messageId })
    await t.dispatch(request)
    expect(t.task(request)).toBeUndefined()
    if (change === 'membership') t.fake.members.set(source.chatId, new Set(['ou_bob']))
    else if (change === 'archive') t.k.spaces.archive(t.k.space.id)
    else t.cfg.policy.allowedChats = ['oc_different_allowed_group']
    const sends = t.fake.sent.length
    t.classify.mockImplementation(async input => useMaterial(input))
    t.advance(60_001)
    await t.k.host.recoverHandoffs()
    expect(t.executed()).toHaveLength(1)
    expect(t.task(request)).toBeUndefined()
    expect(t.fake.sent).toHaveLength(sends)
    expect(t.route(request)?.result).toBe('access_changed')
  })

  it('rechecks membership after the recovered classifier returns instead of trusting its admission-time authority', async () => {
    const t = fixture('group'), source = t.forward()
    await acceptSource(t, source)
    t.classify.mockRejectedValueOnce(new IngressClassificationError('timeout'))
    const request = t.msg('把这段整理成跟进事项', { parentId: source.messageId, rootId: source.messageId })
    await t.dispatch(request)
    const entered = t.barrier(), release = t.barrier()
    t.classify.mockImplementationOnce(async input => { entered.resolve(); await release.promise; return useMaterial(input) })
    t.advance(60_001)
    const retry = t.k.host.recoverHandoffs()
    await entered.promise
    t.fake.members.set(source.chatId, new Set(['ou_bob']))
    release.resolve(); await retry
    expect(t.executed()).toHaveLength(1)
    expect(t.task(request)).toBeUndefined()
    expect(t.route(request)?.result).toBe('access_changed')
    t.fake.members.set(source.chatId, new Set(['ou_alice', 'ou_bob']))
    await t.k.host.recoverHandoffs()
    expect(t.task(request)).toBeUndefined()
  })

  it('does not revive a target explicitly cancelled while classification is waiting to retry', async () => {
    const t = fixture(), source = t.forward()
    await acceptSource(t, source)
    t.classify.mockRejectedValueOnce(new IngressClassificationError('timeout'))
    const request = t.msg('继续这件事', { parentId: source.messageId })
    await t.dispatch(request)
    const work = t.k.registry.taskWork.get(t.task(source)!.id)!
    t.k.registry.workContexts.control(work.key, { action: 'cancel', causeRef: 'synthetic-explicit-human-cancel' })
    t.classify.mockImplementation(async input => ({ kind: 'amend', targetRef: input.message.replyToRef! }))
    t.advance(60_001)
    await t.k.host.recoverHandoffs()
    expect(t.k.registry.workContexts.get(work.key)?.lifecycle).toBe('cancelled')
    expect(t.executed()).toHaveLength(1)
    expect(t.task(request)?.status).not.toBe('done')
  })

  it('lets a newer real amendment take over instead of replaying the old input after recovery', async () => {
    const t = fixture(), source = t.forward()
    await acceptSource(t, source)
    t.classify.mockRejectedValueOnce(new IngressClassificationError('timeout'))
    const oldInput = t.msg('把讨论里的事项记成待办', { parentId: source.messageId })
    await t.dispatch(oldInput)
    expect(t.task(oldInput)).toBeUndefined()
    t.classify.mockImplementation(async input => ({ kind: 'amend', targetRef: input.message.replyToRef! }))
    const newInput = t.msg('改一下，先只列清单，不创建待办', { parentId: source.messageId })
    await t.dispatch(newInput)
    const current = t.task(newInput)!
    expect(current?.status).toBe('done')
    expect(t.k.registry.taskWork.get(current.id)?.key).toBe(t.k.registry.taskWork.get(t.task(source)!.id)?.key)
    const count = t.executed().length
    // The old instruction could independently create a todo with selected material;
    // a later amendment must invalidate the original admission before that decision.
    t.classify.mockImplementation(async input => useMaterial(input))
    t.advance(60_001)
    await t.k.host.recoverHandoffs()
    await t.dispatch(oldInput)
    expect(t.executed()).toHaveLength(count)
    expect(t.task(oldInput)).toBeUndefined()
    expect(t.task(newInput)).toEqual(current)
    expect(t.route(oldInput)?.result).not.toBeNull()
    expect(t.k.receipts.pending(oldInput.messageId)).toEqual([])
  })

  it('keeps an unrelated later topic from cancelling the original request, even in the same conversation session', async () => {
    const t = fixture(), source = t.forward()
    await acceptSource(t, source)
    const sourceTask = t.task(source)!
    t.classify.mockRejectedValueOnce(new IngressClassificationError('timeout'))
    const original = t.msg('根据转发整理需要跟进的事项')
    await t.dispatch(original)
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    const unrelated = t.msg('另外解释一下归并排序的时间复杂度')
    await t.dispatch(unrelated)
    const otherTask = t.task(unrelated)!
    expect(otherTask.status).toBe('done')
    expect(otherTask.sessionKey).toBe(sourceTask.sessionKey)
    expect(t.k.registry.taskWork.get(otherTask.id)?.key).not.toBe(t.k.registry.taskWork.get(sourceTask.id)?.key)
    const stored = t.k.receipts.pending(original.messageId)[0]!
    t.classify.mockImplementationOnce(async input => { expect(input).toEqual(stored.input); return useMaterial(input) })
    t.advance(60_001)
    await t.k.host.recoverHandoffs()
    const recovered = t.task(original)!
    expect(recovered?.status).toBe('done')
    expect(t.k.registry.dispatches.get(recovered.id)?.inbound).toEqual(original)
    expect(new InboundMaterials(t.k.registry).forTask(recovered.id).map(material => material.message.messageId)).toEqual([source.messageId])
    expect(t.task(unrelated)).toEqual(otherTask)
    expect(t.task(source)).toEqual(sourceTask)
    expect(t.executed()).toHaveLength(3)
    await t.k.host.recoverHandoffs()
    expect(t.executed()).toHaveLength(3)
  })

  it('does not bind an explicitly independent new request to the work of its replied message', async () => {
    const t = fixture(), source = t.forward()
    await acceptSource(t, source)
    const sourceTask = t.task(source)!, oldWork = t.k.registry.taskWork.get(sourceTask.id)!
    t.classify.mockRejectedValueOnce(new IngressClassificationError('timeout'))
    const independent = t.msg('另外开一项独立工作，解释归并排序，不用上面的报告。', { parentId: source.messageId })
    await t.dispatch(independent)
    t.k.registry.workContexts.control(oldWork.key, { action: 'cancel', causeRef: 'synthetic-stop-old-report' })
    t.classify.mockResolvedValueOnce({ kind: 'new_work' })
    t.advance(60_001); await t.k.host.recoverHandoffs()
    const created = t.task(independent)!
    expect(created?.status).toBe('done')
    expect(t.k.registry.taskWork.get(created.id)?.key).not.toBe(oldWork.key)
    expect(new InboundMaterials(t.k.registry).forTask(created.id)).toEqual([])
    expect(t.k.registry.workContexts.get(oldWork.key)?.lifecycle).toBe('cancelled')
    expect(t.k.registry.dispatches.get(created.id)?.inbound).toEqual(independent)
  })

  it('checks selected material work independently when the source is absent from resumable task targets', async () => {
    const t = fixture(), source = t.forward()
    await acceptSource(t, source)
    const sourceTask = t.task(source)!, sourceWork = t.k.registry.taskWork.get(sourceTask.id)!
    // Completed delegations remain usable as human-provided material, but the real
    // candidate query correctly excludes them as resumable execution targets.
    t.k.registry.workContexts.control(sourceWork.key, { action: 'complete', causeRef: 'synthetic-completed-work' })
    t.classify.mockRejectedValueOnce(new IngressClassificationError('timeout'))
    const request = t.msg('用这段转发建立一份后续跟进清单')
    await t.dispatch(request)
    const saved = t.k.receipts.pending(request.messageId)[0]!
    expect(saved.targets).toEqual([])
    expect(saved.materials).toHaveLength(1)
    expect(saved.materials?.[0]?.workObservation).toMatchObject({ workKey: sourceWork.key, inputTaskId: sourceTask.id })
    const observedEpoch = saved.materials![0]!.workObservation!.controlEpoch
    t.k.registry.workContexts.control(sourceWork.key, { action: 'cancel', causeRef: 'synthetic-human-withdrew-followup' })
    expect(t.k.registry.workContexts.get(sourceWork.key)!.controlEpoch).toBeGreaterThan(observedEpoch)
    t.classify.mockImplementationOnce(async input => useMaterial(input))
    t.advance(60_001)
    await t.k.host.recoverHandoffs()
    expect(t.task(request)).toBeUndefined()
    expect(t.executed()).toHaveLength(1)
    expect(t.k.receipts.pending(request.messageId)).toEqual([])
    expect(t.route(request)?.result).not.toBeNull()
  })

  it.each(['new_work', 'work_request'] as const)('allows a fresh %s to use historical material whose work was already stopped', async kind => {
    const t = fixture(), source = t.forward()
    await acceptSource(t, source)
    const original = t.task(source)!, work = t.k.registry.taskWork.get(original.id)!
    t.k.registry.workContexts.control(work.key, { action: 'cancel', causeRef: 'synthetic-stop-before-new-request' })
    const stoppedEpoch = t.k.registry.workContexts.get(work.key)!.controlEpoch
    t.classify.mockImplementationOnce(async input => {
      const material = input.materials?.find(item => item.kind === 'merge_forward')
      expect(material).toBeDefined()
      return { kind, contextRefs: [material!.ref] }
    })
    const request = t.msg('另建一份这段原文的核对清单，原来的工作保持停止。')
    await t.dispatch(request)
    const created = t.task(request)!
    expect(created?.status).toBe('done')
    expect(t.k.registry.taskWork.get(created.id)?.key).not.toBe(work.key)
    expect(new InboundMaterials(t.k.registry).forTask(created.id).map(item => item.taskId)).toEqual([original.id])
    expect(t.executed().at(-1)?.text).toContain('负责人和截止时间尚未确定')
    expect(t.k.registry.workContexts.get(work.key)).toMatchObject({ lifecycle: 'cancelled', controlEpoch: stoppedEpoch })
    expect(t.task(source)).toEqual(original)
  })

  it('reports invalid model protocol as a terminal classification error, never as human ambiguity', async () => {
    const t = fixture(), source = t.forward()
    await acceptSource(t, source)
    t.classify.mockRejectedValueOnce(new IngressClassificationError('invalid_output'))
    const request = t.msg('继续跟进这件事')
    await t.dispatch(request)
    expect(t.route(request)?.decision).toBeNull()
    expect(t.task(request)).toBeUndefined()
    expect(t.k.receipts.pending(request.messageId)).toEqual([])
    expectNotClarified(t, request)
    expect(t.failureDeliveries(request)).toMatchObject([{ delivery_key: `route-failure:${request.messageId}:terminal`, status: 'sent' }])
    const sends = t.fake.sent.length
    t.advance(24 * 60 * 60_000)
    await t.reboot()
    await t.k.host.recoverHandoffs()
    await t.dispatch(request)
    expect(classificationsFor(t, request)).toHaveLength(1)
    expect(t.executed()).toHaveLength(1)
    expect(t.fake.sent).toHaveLength(sends)
  })

  it('ends repeated transient failures after three attempts with one notice per failure phase', async () => {
    const t = fixture(), source = t.forward()
    await acceptSource(t, source)
    t.classify.mockRejectedValue(new IngressClassificationError('timeout'))
    const request = t.msg('根据转发继续跟进')
    await t.dispatch(request)
    t.advance(60_001); await t.k.host.recoverHandoffs()
    t.advance(180_001); await t.k.host.recoverHandoffs()
    expect(classificationsFor(t, request)).toHaveLength(3)
    expect(t.task(request)).toBeUndefined()
    expect(t.k.receipts.pending(request.messageId)).toEqual([])
    expectNotClarified(t, request)
    expect(t.failureDeliveries(request)).toMatchObject([
      { delivery_key: `route-failure:${request.messageId}:terminal`, status: 'sent' },
      { delivery_key: `route-failure:${request.messageId}:transient`, status: 'sent' },
    ])
    t.advance(24 * 60 * 60_000)
    await t.k.host.recoverHandoffs()
    await t.dispatch(request)
    expect(classificationsFor(t, request)).toHaveLength(3)
    expect(t.executed()).toHaveLength(1)
    expect(t.failureDeliveries(request)).toHaveLength(2)
  })
})
