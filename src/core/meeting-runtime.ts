import type { Registry } from './registry.js'
import type { RunAttempts } from './run-attempts.js'
import type { RuntimeContexts } from './runtime-contexts.js'
import type { SourceContexts } from './source-context.js'
import type { MaterialProvenance } from './execution-materials.js'
import type { ExecutionSourceAccessResult } from './execution-source-access.js'
import type { PolicyService } from './policy.js'
import { dmSpaceId, spaceScope, type Spaces } from './space.js'
import type { Todos } from './todos.js'
import { TodoApplication } from './todo-application.js'
import type { TodoProvenance } from './todo-provenance.js'
import { DeliveryService, type DeliveryContext } from './delivery.js'
import type { FeishuClient } from '../feishu/client.js'
import type { FeishuMeetings } from '../feishu/meetings.js'
import type { RunApiCalls } from './run-api-calls.js'
import { assertRequestCurrent } from './request-lease.js'
import { MeetingApplication, type MeetingRunContext, type MeetingRunRef } from './meeting-application.js'
import { meetingDigest, MeetingStateError, type MeetingSessions, type MeetingSession, type MeetingDraft, type MeetingOrigin } from './meeting-sessions.js'
import { meetingSource, verifyMeetingSource, type MeetingSourceReceipt, type MeetingSourceAudience } from './meeting-source.js'

export interface MeetingRuntimeBinding extends MeetingRunRef {
  taskId: number; workKey: string; openId: string; acpSessionId: string
  spaceId: string; chatId: string; chatType: 'group' | 'p2p'
  reviewSpaceId: string; reviewChatId: string
  assertCurrent(): void
}
export interface MeetingRuntimeDeps {
  registry: Registry; attempts: RunAttempts; contexts: RuntimeContexts; sources: SourceContexts
  sessions: MeetingSessions; calls: RunApiCalls; todos: Todos; spaces: Spaces; policy: PolicyService
  todoApplication?: TodoApplication
  provider: Pick<FeishuMeetings, 'join' | 'leave' | 'events' | 'activeForUser'>
  feishu: Pick<FeishuClient, 'sendToUser'>
  binding(ref: MeetingRunRef): MeetingRuntimeBinding
  /** Existing Approvals; must bind the exact actor/target and return only its actual decision. */
  approve(input: { ref: MeetingRunRef; operation: 'join' | 'leave'; meetingNumber: string; actorOpenId: string; assertCurrent(): void }): Promise<{ decision: string; requestId: string }>
  /** Reuses the host source access service. It must include delegation/Space/memory eligibility,
   * without requiring the now-completed initiating Run to still be running. */
  authorizeSavedContext(provenance: MaterialProvenance, origin: MeetingOrigin, assertCurrent: () => void): Promise<ExecutionSourceAccessResult>
  resolveDelivery(ref: MeetingRunRef, session: MeetingSession, assertCurrent: () => void): Promise<DeliveryContext | undefined>
  /** Existing durable system-event admission, not a manufactured user message or detached model call. */
  queueDraft(session: MeetingSession, key: string, prompt: string, source: MeetingSourceReceipt): void
  assertLifecycleCurrent(): void
  onFailure?(sessionId: string, error: unknown): void
}

interface DraftContext { sessionKey: string; origin: MeetingOrigin; provenance: MaterialProvenance; todo: TodoProvenance }
export class MeetingAccessError extends MeetingStateError {
  constructor(readonly status: 'denied' | 'unavailable', readonly reason: string) { super('denied'); this.name = 'MeetingAccessError' }
}

/** Host composition only: business state stays in Meetings, execution in Work/Run,
 * review receipts in Delivery, and confirmed actions in Todos. */
export class MeetingRuntime {
  private readonly todoApplication: TodoApplication
  readonly application: MeetingApplication
  private ticking = false
  constructor(private readonly deps: MeetingRuntimeDeps) {
    this.todoApplication = deps.todoApplication ?? new TodoApplication({ db: deps.registry.db, todos: deps.todos })
    this.application = new MeetingApplication({ sessions: deps.sessions, provider: deps.provider, calls: deps.calls,
      resolveRun: ref => this.resolveRun(ref), authorizeAction: (run, operation, number) => this.authorizeAction(run, operation, number),
      authorizeSession: session => this.authorizeSession(session),
      authorizeDraft: (draft, session) => this.authorizeDraft(draft, session),
      recordSource: (ref, source) => { const binding = this.deps.binding(ref); binding.assertCurrent(); this.deps.sources.recordMeetingSource(binding, source) },
      contextHints: session => this.contextHints(session),
      deliverDraft: (ref, session, draft, guard) => this.deliverDraft(ref, session, draft, guard),
      commitActions: (draft, session) => this.commitActions(draft, session),
      queueDraft: (session, key) => deps.queueDraft(session, key,
        `会议已有离会或结束证据。使用 friday_read_meeting 分页读取会议 ${session.id} 的全部已取得事件，区分实际覆盖与缺失；结合已获准的会前资料整理纪要和行动项。调用 friday_propose_meeting_draft 将完整草稿交给本人确认。此时不要创建待办，不向群里发布，不宣称其他人已同意。`, meetingSource(session)),
    })
  }

  /** Called inside the existing tracked lifecycle owner. No detached interval or second queue. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const session of this.deps.sessions.list().filter(value => value.enabled && value.state !== 'join_rejected' &&
        !(value.currentDraftId && value.coverageComplete && ['left', 'ended'].includes(value.state)))) {
        this.deps.assertLifecycleCurrent()
        try { await this.application.refresh(session.id, () => this.deps.assertLifecycleCurrent()) }
        catch (error) { this.deps.assertLifecycleCurrent(); this.deps.onFailure?.(session.id, error) }
      }
    } finally { this.ticking = false }
  }

  /** Common material/history and final-publication entry. A receipt never grants wider audience. */
  async checkSources(sources: readonly MeetingSourceReceipt[], audience: MeetingSourceAudience,
    assertCurrent: () => void): Promise<ExecutionSourceAccessResult> {
    const snapshot = structuredClone(sources), leases: (() => void)[] = []
    const check = () => {
      assertRequestCurrent(); assertCurrent()
      for (const source of snapshot) if (!verifyMeetingSource(this.deps.sessions, source, audience)) throw new MeetingStateError('changed')
      for (const lease of leases) lease()
    }
    assertCurrent()
    if (!snapshot.every(source => verifyMeetingSource(this.deps.sessions, source, audience))) {
      return { status: 'denied', reason: 'meeting_source_changed_or_audience_denied', assertCurrent }
    }
    for (const source of snapshot) {
      check()
      // Snapshot the previous guards; never create a lease containing itself.
      const preceding = [...leases], base = () => {
        assertRequestCurrent(); assertCurrent()
        for (const value of snapshot) if (!verifyMeetingSource(this.deps.sessions, value, audience)) throw new MeetingStateError('changed')
        for (const lease of preceding) lease()
      }
      const session = this.deps.sessions.get(source.sessionId)!
      const result = await this.deps.authorizeSavedContext(session.context, session.origin, base)
      check(); result.assertCurrent(); leases.push(result.assertCurrent)
      if (result.status !== 'allowed') return { status: result.status, reason: result.reason, assertCurrent: check }
    }
    check(); return { status: 'allowed', assertCurrent: check }
  }

  private resolveRun(ref: MeetingRunRef): MeetingRunContext {
    const binding = this.deps.binding(ref), signature = meetingDigest({ ...binding, assertCurrent: undefined })
    const current = () => {
      assertRequestCurrent(); binding.assertCurrent()
      const value = this.deps.binding(ref), attempt = this.deps.attempts.get(ref.runId), task = this.deps.registry.getTask(binding.taskId)
      if (meetingDigest({ ...value, assertCurrent: undefined }) !== signature || ref.sessionKey !== binding.sessionKey || ref.runId !== binding.runId ||
        !attempt || attempt.state !== 'running' || attempt.stage !== 'task' || attempt.taskId !== binding.taskId ||
        attempt.actorOpenId !== binding.openId || attempt.workKey !== binding.workKey || attempt.acpSessionId !== binding.acpSessionId ||
        !task || task.sessionKey !== binding.sessionKey || task.requesterOpenId !== binding.openId ||
        !this.deps.contexts.isEligible(ref.runId, true)) throw new MeetingStateError('denied')
      const target = this.deps.spaces.get(binding.reviewSpaceId)
      if (binding.reviewSpaceId !== dmSpaceId(binding.openId) || target?.kind !== 'p2p' || target.status !== 'active' || target.chatId !== binding.reviewChatId) throw new MeetingStateError('denied')
    }
    current()
    const task = this.deps.registry.getTask(binding.taskId)!, sources = this.deps.sources.get(ref.sessionKey), context = this.deps.contexts.contextForRun(ref.runId)
    if (!sources || sources.acpSessionId !== binding.acpSessionId || sources.spaceId !== binding.spaceId || sources.chatId !== binding.chatId || !context) throw new MeetingStateError('denied')
    return { origin: { runId: ref.runId, taskId: task.id, workKey: binding.workKey, sessionKey: ref.sessionKey,
      requestMessageId: task.messageId, spaceId: binding.spaceId, chatId: binding.chatId, chatType: binding.chatType,
      ownerOpenId: binding.openId, reviewSpaceId: binding.reviewSpaceId, reviewChatId: binding.reviewChatId },
      provenance: structuredClone({ sources, memoryRefs: context.notes }), assertCurrent: current }
  }

  private async authorizeAction(run: MeetingRunContext, operation: 'join' | 'leave', meetingNumber: string) {
    const check = () => { run.assertCurrent(); if (this.deps.policy.decide({ spaceId: run.origin.spaceId, openId: run.origin.ownerOpenId, action: 'act' }).decision === 'deny') throw new MeetingStateError('denied') }
    if (!/^\d{9}$/.test(meetingNumber)) throw new MeetingStateError('invalid')
    check()
    const key = meetingDigest({ request: run.origin.requestMessageId, owner: run.origin.ownerOpenId, operation, meetingNumber })
    const previous = this.deps.sessions.list(run.origin.ownerOpenId).flatMap(session => [session.joinAuthority, session.leaveAuthority])
      .find(value => value?.key === key)
    if (previous) return previous
    const approved = await this.deps.approve({ ref: { sessionKey: run.origin.sessionKey, runId: run.origin.runId }, operation,
      meetingNumber, actorOpenId: run.origin.ownerOpenId, assertCurrent: check })
    check()
    if (approved.decision !== 'allow' || !approved.requestId) throw new MeetingStateError('denied')
    return { key, operation, actorOpenId: run.origin.ownerOpenId, messageId: run.origin.requestMessageId, meetingNumber }
  }

  private async authorizeSession(session: MeetingSession) {
    const check = () => {
      assertRequestCurrent(); this.deps.assertLifecycleCurrent()
      const current = this.deps.sessions.get(session.id)
      if (!current?.enabled || current.version !== session.version || meetingDigest(current.context) !== meetingDigest(session.context)) throw new MeetingStateError('changed')
    }
    check()
    const result = await this.deps.authorizeSavedContext(session.context, session.origin, check)
    check(); result.assertCurrent()
    if (result.status !== 'allowed') throw new MeetingAccessError(result.status, result.reason)
    return { assertCurrent: () => { check(); result.assertCurrent() } }
  }

  private draftContext(draft: MeetingDraft): DraftContext {
    const raw = this.deps.registry.getKv(`meeting-draft-context:${draft.id}`)
    if (!raw) throw new MeetingStateError('unconfirmed')
    return JSON.parse(raw) as DraftContext
  }

  private contextHints(session: MeetingSession) {
    const task = this.deps.registry.getTask(session.origin.taskId), dispatch = this.deps.registry.dispatches.get(session.origin.taskId)
    if (!task || task.requesterOpenId !== session.origin.ownerOpenId || task.sessionKey !== session.origin.sessionKey ||
      !dispatch || dispatch.inbound.senderType !== 'user' || dispatch.inbound.messageId !== session.origin.requestMessageId ||
      dispatch.inbound.senderOpenId !== session.origin.ownerOpenId || dispatch.inbound.chatId !== session.origin.chatId) throw new MeetingStateError('denied')
    const source = session.context.sources
    return { request: { text: task.prompt, messageId: dispatch.inbound.messageId, chatId: dispatch.inbound.chatId,
      createTimeMs: dispatch.inbound.createTimeMs, linkStatus: 'not_resolved' as const },
      references: [
        ...source.chats.map(value => ({ kind: 'conversation' as const, ref: value.chatId })),
        ...(source.inboundMaterials ?? []).map(value => ({ kind: 'message' as const, ref: value.messageId })),
        ...source.external.map(value => ({ kind: value.kind, ref: value.ref })),
        ...source.repositories.map(ref => ({ kind: 'repository' as const, ref })),
        ...session.context.memoryRefs.map(value => ({ kind: 'memory' as const, ref: String(value.id) })),
        ...(source.meetingSources ?? []).map(value => ({ kind: 'meeting' as const, ref: value.sessionId })),
      ], notice: '这里只保留真实会前委托和资料引用，不含完整会前会话。需要资料正文时按当前权限重新读取；没有可核验消息链接时不拼接链接，也不把内部引用编号发给用户。' }
  }

  private async authorizeDraft(draft: MeetingDraft, session: MeetingSession) {
    const saved = this.draftContext(draft), digest = meetingDigest(saved)
    const check = () => {
      assertRequestCurrent(); this.deps.assertLifecycleCurrent()
      if (meetingDigest(this.draftContext(draft)) !== digest || !verifyMeetingSource(this.deps.sessions, meetingSource(session),
        { openId: session.origin.ownerOpenId, spaceId: session.origin.reviewSpaceId, chatId: session.origin.reviewChatId, chatType: 'p2p' })) throw new MeetingStateError('changed')
    }
    check()
    // The exact self receipt was verified above; its original pre-meeting context is
    // checked by authorizeSession. Do not recursively authorize this same receipt.
    const context = structuredClone(saved.provenance)
    context.sources.meetingSources = context.sources.meetingSources?.filter(value => value.sessionId !== session.id)
    const access = await this.deps.authorizeSavedContext(context, saved.origin, check)
    check(); access.assertCurrent()
    if (access.status !== 'allowed') throw new MeetingAccessError(access.status, access.reason)
    return { assertCurrent: () => { check(); access.assertCurrent() } }
  }

  private async deliverDraft(ref: MeetingRunRef, session: MeetingSession, draft: MeetingDraft, guard: () => void) {
    guard()
    const run = this.resolveRun(ref), binding = this.deps.binding(ref)
    if (binding.chatType !== 'p2p' || binding.openId !== session.origin.ownerOpenId || binding.chatId !== session.origin.reviewChatId) throw new MeetingStateError('denied')
    // Provider participant IDs are not verified Feishu open_ids. Only the actual
    // commissioning person can be bound by ID; other names remain proposals.
    if (draft.actions.some(action => action.ownerOpenId && action.ownerOpenId !== binding.openId)) throw new MeetingStateError('denied')
    const snapshot: DraftContext = { sessionKey: ref.sessionKey, origin: run.origin, provenance: run.provenance,
      todo: { version: 1, originRunId: ref.runId, taskId: null, request: null, workKey: binding.workKey,
        selectedInputs: [], contextSnapshot: run.provenance.sources } }
    // Creation evidence remains immutable on delivery retries. Actual meeting receipt
    // is retained, while a system-event draft is never labelled as a human request.
    const key = `meeting-draft-context:${draft.id}`
    if (!this.deps.registry.getKv(key)) this.deps.registry.setKv(key, JSON.stringify(snapshot))
    const fullText = meetingDraftText(draft)
    const service = new DeliveryService(this.deps.registry.db, { spaces: this.deps.spaces, policy: this.deps.policy,
      resolveContext: async () => {
        guard()
        const context = await this.deps.resolveDelivery(ref, session, guard)
        guard()
        if (!context || context.actorOpenId !== session.origin.ownerOpenId || context.audience.kind !== 'dm' ||
          context.audience.openId !== session.origin.ownerOpenId || context.audience.spaceId !== session.origin.reviewSpaceId) return undefined
        const previous = context.isCurrent
        return { ...context, isCurrent: () => { guard(); return previous?.() !== false } }
      }, send: async ({ audience, payload }) => {
        guard(); if (audience.kind !== 'dm' || audience.openId !== session.origin.ownerOpenId) throw new MeetingStateError('denied')
        return { remoteId: await this.deps.feishu.sendToUser(audience.openId, payload) }
      } })
    const parts = Array.from(fullText).reduce<string[]>((all, point, index) => { const part = Math.floor(index / 3000); all[part] = (all[part] ?? '') + point; return all }, [])
    for (const [index, text] of parts.entries()) {
      const result = await service.deliver({ key: `meeting-draft:${draft.id}:part:${index}`, contextRef: `meeting-draft:${draft.id}`, payload: { text } })
      guard(); if (result.status !== 'sent' && result.status !== 'confirmed') return { complete: false }
    }
    const card = await service.deliver({ key: `meeting-draft:${draft.id}:review`, contextRef: `meeting-draft:${draft.id}`, payload: { card: meetingDraftCard(draft) } })
    // Caller persists this returned ACK before checking cancellation.
    return { complete: card.status === 'sent' || card.status === 'confirmed', cardMessageId: card.remoteId ?? undefined }
  }

  private commitActions(draft: MeetingDraft, session: MeetingSession): number[] {
    const saved = this.draftContext(draft)
    if (this.deps.policy.decide({ spaceId: session.origin.reviewSpaceId, openId: session.origin.ownerOpenId, action: 'remember' }).decision !== 'allow') throw new MeetingStateError('denied')
    if (saved.provenance.sources.chatId !== session.origin.reviewChatId || !saved.provenance.sources.meetingSources?.some(value =>
      meetingDigest(value) === meetingDigest(meetingSource(session)))) throw new MeetingStateError('denied')
    return draft.actions.map(action => {
      if (action.detail && action.detail.length > 2000) throw new MeetingStateError('invalid')
      return this.todoApplication.create({ scope: spaceScope(session.origin.reviewSpaceId), chatId: session.origin.reviewChatId,
        chatType: 'p2p', openId: session.origin.ownerOpenId }, { title: action.title, detail: action.detail,
        dueMs: action.dueMs, owner: action.owner, ownerOpenId: action.ownerOpenId,
        confirmed: action.ownerOpenId === session.origin.ownerOpenId || !action.ownerOpenId && !action.owner,
        sessionKey: saved.sessionKey, provenance: saved.todo, source: `本人确认的会议纪要${session.title ? ` · ${session.title}` : ''}；他人行动仍待本人确认` }, session.origin.ownerOpenId).todo.id
    })
  }
}

export function meetingDraftText(draft: MeetingDraft): string {
  return ['会议纪要待审稿', draft.summary, '行动项（接受后记录；涉及他人的事项仍是候选，不代表对方承诺）',
    ...draft.actions.map((action, index) => `${index + 1}. ${action.title}${action.ownerOpenId ? '\n负责人：你本人' : action.owner ? `\n负责人（待本人确认）：${action.owner}` : '\n负责人：未指定'}${action.dueMs === undefined ? '' : `\n截止时间：${new Date(action.dueMs).toISOString()}`}${action.detail ? `\n${action.detail}` : ''}`)].join('\n\n')
}
export function meetingDraftCard(draft: MeetingDraft): Record<string, unknown> {
  return { schema: '2.0', header: { title: { tag: 'plain_text', content: '确认会议纪要与行动项' } }, body: { elements: [
    { tag: 'markdown', content: `完整待审稿已在前面送达，含 ${draft.actions.length} 项行动。接受将记录到你的私聊待办；没有宣称你已阅读。` },
    { tag: 'column_set', columns: ['accept', 'reject'].map(decision => ({ tag: 'column', width: 'weighted', weight: 1, elements: [
      { tag: 'button', text: { tag: 'plain_text', content: decision === 'accept' ? '接受并记录' : '暂不接受' }, type: decision === 'accept' ? 'primary' : 'default',
        behaviors: [{ type: 'callback', value: { action: 'meeting_draft_decide', draftId: draft.id, digest: draft.digest, decision } }] },
    ] })) },
  ] } }
}
