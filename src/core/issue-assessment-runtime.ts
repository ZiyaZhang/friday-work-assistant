import type { Registry } from './registry.js'
import { RunAttempts } from './run-attempts.js'
import { TaskEvents } from './task-events.js'
import { assertRequestCurrent, currentRequestSignal, withoutRequestLease } from './request-lease.js'
import { WorkAssessmentError, type WorkAssessments, type WorkAssessmentRecord, type WorkAssessmentRequest, type WorkAssessmentAuthority } from './work-assessment.js'
import type { IssueAssessmentApplication, IssueAssessmentSourceLease } from './issue-assessment-application.js'

/** Constructed from the current host Run, never accepted in a tool body. */
export interface IssueAssessmentActor { sessionKey: string; runId: string; taskId: number; actorOpenId: string; spaceId: string }
export type IssueAssessmentIntent = WorkAssessmentRequest['intent'] | 'human_confirmation'
/** A click on the host's confirmation card, as the platform callback reports it; the card itself carries only the assessment id. */
export interface IssueAssessmentCardClick { assessmentId: string; operatorOpenId: string; chatId: string; cardMessageId: string }
/** Ledger row of the confirmation card the host delivered for one assessment. */
export interface IssueAssessmentCardDelivery { status: 'planned' | 'sent' | 'confirmed' | 'unknown'; remoteId: string | null }
export interface IssueAssessmentRuntimeDeps {
  registry: Registry
  assessments: WorkAssessments
  application: IssueAssessmentApplication
  assertCurrent(actor: IssueAssessmentActor): void
  /** For a saved assessment, reauthorize its exact origin.sources, not a replacement current manifest. */
  captureSources(actor: IssueAssessmentActor, previous?: WorkAssessmentRecord): Promise<IssueAssessmentSourceLease>
  /** Host interpretation of the real input/approval receipt, bound to this Task and target.
   * A model tool's requested action or the assessment's recommendation is never authority. */
  executionIntent(actor: IssueAssessmentActor, target: { repo: string; number: number; assessmentId?: string }): Promise<IssueAssessmentIntent>
  recordRepositoryRead(actor: IssueAssessmentActor, repo: string): void
  /** Schedule only, after transaction commit; the existing queue owns lifecycle and logging. */
  wakeQueuedTask(taskId: number): void
  /** P3-3b. Lease over a saved record's exact origin.sources when no Run of the requester is live (card click, handoff Task
   * admission): fresh platform membership and, where configured, the existing retained-source check. */
  retainedSources?(record: WorkAssessmentRecord): Promise<IssueAssessmentSourceLease>
  /** P3-3b. The confirmation card the host delivered for this assessment, read from the delivery ledger. */
  confirmationCard?(assessmentId: string): IssueAssessmentCardDelivery | undefined
  /** P3-3b. Deliver that card once per assessment for a recommend verdict admitted by this actor's Task.
   * Must not throw: a failed delivery is logged by the host and shows up through confirmationCard. */
  offerConfirmation?(actor: IssueAssessmentActor, record: WorkAssessmentRecord): Promise<void>
}

/** Connects the domain application to real inputs, durable Tasks and the existing queue.
 * It has no platform sender, shell, repository writer or independent task state. */
export class IssueAssessmentRuntime {
  private readonly attempts: RunAttempts
  private readonly events: TaskEvents
  constructor(private readonly deps: IssueAssessmentRuntimeDeps) {
    this.attempts = new RunAttempts(deps.registry.db); this.events = new TaskEvents(deps.registry)
  }

  async assess(actor: IssueAssessmentActor, number: number) {
    const check = () => this.check(actor)
    check()
    const repo = this.boundRepo(actor)
    const previous = this.deps.assessments.forTaskIssue(actor.taskId, repo, number)
    const sources = await this.deps.captureSources(actor, previous); check(); sources.assertCurrent()
    const intent = await this.deps.executionIntent(actor, { repo, number }); check(); sources.assertCurrent()
    // A confirmation of an existing assessment cannot authorize another newly selected issue.
    const originalIntent = intent === 'execute_if_suitable' ? intent : 'assess_only'
    // The same person asking again in the same group under the same binding: an unexpired admitted record is a read-through
    // candidate. The application re-reads the thread first and returns it only when the snapshot is byte-identical (no new model Run).
    const reuse = !previous && originalIntent === 'assess_only' ? this.reuseCandidate(actor, repo, number) : undefined
    let record = previous ? this.deps.application.read({ assessmentId: previous.id, taskId: actor.taskId, sources })
      : await this.deps.application.assess({ taskId: actor.taskId, number, intent: originalIntent, sources, signal: currentRequestSignal(), reuse })
    check(); sources.assertCurrent()
    this.deps.recordRepositoryRead(actor, record.snapshot.repo)
    if (record.result?.verdict === 'recommend' && originalIntent === 'execute_if_suitable') {
      record = await this.handoff(actor, record, sources, 'execute_if_suitable')
    }
    // A recommendation admitted by this Task gets one confirmation card in its conversation; only the requester's click there
    // confirms execution. A record read through from another Task already had its card in that Task's conversation.
    if (record.result?.verdict === 'recommend' && record.state === 'completed' && originalIntent === 'assess_only'
      && record.request.origin?.taskId === actor.taskId && this.deps.offerConfirmation) {
      await this.deps.offerConfirmation(actor, record)
      check(); sources.assertCurrent()
    }
    return this.present(record, Boolean(reuse) && record.id === reuse!.id)
  }

  async get(actor: IssueAssessmentActor, assessmentId: string) {
    this.check(actor)
    const persisted = this.persistedForActor(actor, assessmentId)
    if (persisted) {
      // The same person's record from another Task of this group: read-only presentation under the current binding.
      // It is never an execution lease; execute() still requires the exact original Work.
      this.deps.recordRepositoryRead(actor, persisted.snapshot.repo)
      return this.present(persisted)
    }
    const { record } = await this.read(actor, assessmentId)
    return this.present(record)
  }

  async execute(actor: IssueAssessmentActor, assessmentId: string) {
    const { record, sources } = await this.read(actor, assessmentId)
    const number = issueNumber(record)
    const intent = await this.deps.executionIntent(actor, { repo: record.snapshot.repo, number, assessmentId })
    this.check(actor); sources.assertCurrent()
    if (intent === 'assess_only') throw new WorkAssessmentError('not_authorized')
    return this.present(await this.handoff(actor, record, sources, intent))
  }

  /** The original requester's click on the confirmation card the host delivered for this assessment (P3-3b). The platform
   * supplies operator, chat and card message; the card carries only the assessment id. The original Task stays the event
   * source and the click is recorded as the human confirmation (`card:<message id>`). No live Run of the requester is needed;
   * the thread is re-read and must still match the assessed snapshot. Repeated clicks return the same Task. */
  async confirm(click: IssueAssessmentCardClick) {
    assertRequestCurrent()
    const record = this.deps.assessments.current(click.assessmentId), request = record?.request, origin = request?.origin
    if (!record || !request || !origin) throw new WorkAssessmentError('not_current')
    const card = this.deps.confirmationCard?.(record.id), task = this.deps.registry.getTask(origin.taskId)
    if (click.operatorOpenId !== request.actorOpenId || click.chatId !== request.chatId || !card || !['sent', 'confirmed'].includes(card.status)
      || !card.remoteId || card.remoteId !== click.cardMessageId || record.result?.verdict !== 'recommend'
      || !['completed', 'handed_off'].includes(record.state) || !task || !this.deps.retainedSources) throw new WorkAssessmentError('not_authorized')
    const sources = await this.deps.retainedSources(record); assertRequestCurrent(); sources.assertCurrent()
    return this.present(await this.admitHandoff(record, sources, { taskId: origin.taskId, targetSessionKey: task.sessionKey,
      kind: 'human_confirmation', card: click.cardMessageId, check: assertRequestCurrent }))
  }

  /** Admission of a durable handoff Task before its Run (P3-3b). The exact handed-off record, its event row and its original
   * sources are re-verified without a live Run of the requester: binding owner and reader, repository allowlist, space and fresh
   * membership, Work epoch and input order. The returned lease is for the whole Run: the event row, the handoff, the binding text
   * and the original sources lease, not the short membership lease used here. */
  async admitHandoffTask(taskId: number): Promise<{ record: WorkAssessmentRecord; assertCurrent(): void }> {
    const record = this.deps.assessments.forHandoff(taskId), origin = record?.request.origin, key = record?.handoff?.dispatchKey
    const current = () => {
      const now = this.deps.assessments.forHandoff(taskId), event = this.events.get(taskId)
      if (!record || !origin || !key || !now || now.id !== record.id || now.handoff?.taskId !== taskId || now.handoff.dispatchKey !== key
        || !event || event.kind !== 'issue_assessment' || event.domainId !== record.id || event.key !== key || event.sourceWorkKey !== origin.workKey
        || this.deps.registry.getKv(`issue-watch:${record.request.spaceId}`) !== origin.binding) throw new WorkAssessmentError('not_current')
    }
    current()
    if (!this.deps.retainedSources) throw new WorkAssessmentError('not_current')
    const sources = await this.deps.retainedSources(record!); current(); sources.assertCurrent()
    this.deps.application.read({ assessmentId: record!.id, taskId: this.events.get(taskId)!.sourceTaskId, sources })
    return { record: record!, assertCurrent: () => { current(); sources.assertCurrent() } }
  }

  /** A scan cannot manufacture a human Task or an execution grant. Persisted automation
   * authorization must first be admitted by the same host input/Run path. */
  async assessScannedIssue(input: { actor?: IssueAssessmentActor; number: number }) {
    if (!input.actor) return { status: 'needs_authorization' as const, reason: '没有可核验的接单委托，请负责人先明确评估范围。' }
    return this.assess(input.actor, input.number)
  }

  private check(actor: IssueAssessmentActor): void {
    assertRequestCurrent(); this.deps.assertCurrent(actor)
    const { registry } = this.deps, task = registry.getTask(actor.taskId), attempt = this.attempts.get(actor.runId)
    const session = registry.getSession(actor.sessionKey), work = task && registry.taskWork.get(task.id)
    const inbound = task && registry.dispatches.get(task.id)?.inbound
    if (!task || task.status === 'cancelled' || !attempt || attempt.state !== 'running' || attempt.stage !== 'task' || attempt.taskId !== task.id
      || attempt.sessionKey !== actor.sessionKey || attempt.actorOpenId !== actor.actorOpenId || !session || session.status === 'archived'
      || task.sessionKey !== actor.sessionKey || task.requesterOpenId !== actor.actorOpenId || !work || work.key !== attempt.workKey
      || !inbound || inbound.messageId !== task.messageId || inbound.senderType !== 'user' || inbound.senderOpenId !== actor.actorOpenId
      || inbound.chatId !== session.chatId || inbound.chatType !== session.chatType) throw new WorkAssessmentError('not_current')
  }

  private binding(actor: IssueAssessmentActor): { raw: string; repo: string; version?: string } {
    const raw = this.deps.registry.getKv(`issue-watch:${actor.spaceId}`)
    let binding: unknown
    try { binding = raw ? JSON.parse(raw) : undefined } catch { throw new WorkAssessmentError('not_authorized') }
    if (!raw || !binding || typeof binding !== 'object' || !('repo' in binding) || typeof binding.repo !== 'string') throw new WorkAssessmentError('not_authorized')
    const version = 'version' in binding && typeof binding.version === 'string' && binding.version ? binding.version : undefined
    return { raw, repo: binding.repo.toLowerCase(), ...(version ? { version } : {}) }
  }

  private boundRepo(actor: IssueAssessmentActor): string {
    return this.binding(actor).repo
  }

  /** Only a binding with an explicit version (what the issue-watch route writes) can be matched across Tasks. */
  private reuseCandidate(actor: IssueAssessmentActor, repo: string, number: number): WorkAssessmentRecord | undefined {
    const binding = this.binding(actor), session = this.deps.registry.getSession(actor.sessionKey)
    if (!binding.version || !session) return undefined
    const candidate = this.deps.assessments.latestForActor({ actorOpenId: actor.actorOpenId, spaceId: actor.spaceId, chatId: session.chatId,
      bindingVersion: binding.version, repo, number })
    return candidate?.request.origin?.binding === binding.raw && candidate.request.intent === 'assess_only' ? candidate : undefined
  }

  /** The same person's saved record of this group under the still-current binding; undefined when it belongs to the current
   * Work (the strict read path applies). Another person's record, another group, binding or an expired record is rejected. */
  private persistedForActor(actor: IssueAssessmentActor, assessmentId: string): WorkAssessmentRecord | undefined {
    const { registry } = this.deps, record = this.deps.assessments.get(assessmentId), origin = record?.request.origin
    const task = registry.getTask(actor.taskId)!, session = registry.getSession(actor.sessionKey)!
    if (!record || !origin || record.request.actorOpenId !== actor.actorOpenId || record.request.spaceId !== actor.spaceId) {
      throw new WorkAssessmentError('not_authorized')
    }
    if (origin.workKey === registry.taskWork.get(task.id)?.key) return undefined
    const binding = this.binding(actor)
    if (record.request.chatId !== session.chatId || record.request.chatType !== session.chatType || !binding.version
      || record.request.bindingVersion !== binding.version || origin.binding !== binding.raw || record.snapshot.repo !== binding.repo
      || !this.deps.assessments.current(record.id)) throw new WorkAssessmentError('not_authorized')
    return record
  }

  private async read(actor: IssueAssessmentActor, assessmentId: string) {
    this.check(actor)
    const original = this.deps.assessments.get(assessmentId), task = this.deps.registry.getTask(actor.taskId)!
    if (!original?.request.origin || original.request.actorOpenId !== actor.actorOpenId || original.request.spaceId !== actor.spaceId
      || original.request.origin.workKey !== this.deps.registry.taskWork.get(task.id)?.key) throw new WorkAssessmentError('not_authorized')
    const sources = await this.deps.captureSources(actor, original); this.check(actor); sources.assertCurrent()
    const record = this.deps.application.read({ assessmentId, taskId: actor.taskId, sources })
    this.deps.recordRepositoryRead(actor, record.snapshot.repo)
    return { record, sources }
  }

  private async handoff(actor: IssueAssessmentActor, record: WorkAssessmentRecord, sources: IssueAssessmentSourceLease,
    intent: Exclude<IssueAssessmentIntent, 'assess_only'>): Promise<WorkAssessmentRecord> {
    this.check(actor); sources.assertCurrent()
    const origin = record.request.origin!
    if (intent === 'execute_if_suitable' && (origin.taskId !== actor.taskId || record.request.intent !== 'execute_if_suitable')) {
      throw new WorkAssessmentError('not_authorized')
    }
    // A confirmation already given on the host's card is that same authority (the original Task plus the click):
    // a later tool call gets the Task it created, never another one.
    const card = intent === 'human_confirmation' ? cardMessageId(this.deps.assessments.authorityFor(record.id)) : undefined
    return this.admitHandoff(record, sources, card
      ? { taskId: origin.taskId, targetSessionKey: this.deps.registry.getTask(origin.taskId)!.sessionKey, kind: 'human_confirmation', card, check: () => this.check(actor) }
      : { taskId: actor.taskId, targetSessionKey: actor.sessionKey, kind: intent === 'human_confirmation' ? 'human_confirmation' : 'explicit_request',
        check: () => this.check(actor) })
  }

  /** One transaction: the application re-reads the thread, then the Task/dispatch/event row and the handed_off state commit together. */
  private async admitHandoff(record: WorkAssessmentRecord, sources: IssueAssessmentSourceLease, authority: { taskId: number; targetSessionKey: string;
    kind: WorkAssessmentAuthority['kind']; card?: string; check(): void }): Promise<WorkAssessmentRecord> {
    const handoff = await this.deps.application.handoff({ assessmentId: record.id, authorityTaskId: authority.taskId, kind: authority.kind,
      ...(authority.card ? { confirmation: { messageId: authority.card } } : {}), sources, signal: currentRequestSignal(),
      create: ({ key, assessment, authority: granted }) => {
        authority.check(); sources.assertCurrent()
        const task = this.events.admit({ key, kind: 'issue_assessment', sourceTaskId: authority.taskId, targetSessionKey: authority.targetSessionKey,
          domainId: assessment.id, prompt: executionInput(assessment, granted) }).task
        return { taskId: task.id, dispatchKey: key }
      } })
    // Durable handoff exists now. Do not inherit a cancelled HTTP lease into its future Run.
    withoutRequestLease(() => this.deps.wakeQueuedTask(handoff.taskId))
    return this.deps.assessments.get(record.id)!
  }

  private present(record: WorkAssessmentRecord, reused = false) {
    return { assessmentId: record.id, state: record.state, repo: record.snapshot.repo, number: issueNumber(record),
      snapshotDigest: record.snapshot.digest, assessedAt: record.createdAt, result: record.result, failure: record.failure,
      /** true: an earlier record of this group was returned because the thread is unchanged; no new evaluation ran. */
      reused,
      requiresExecutionAuthorization: record.result?.verdict === 'recommend' && !record.handoff,
      /** The confirmation card in the original conversation: 'sent', 'unknown' (delivery outcome not confirmed; never resent), or null. */
      confirmationCard: confirmationState(record.result?.verdict === 'recommend' ? this.deps.confirmationCard?.(record.id) : undefined),
      handoff: record.handoff ? { taskId: record.handoff.taskId,
        taskStatus: this.deps.registry.getTask(record.handoff.taskId)?.status ?? 'unavailable' } : null }
  }
}

function issueNumber(record: WorkAssessmentRecord): number {
  const target = record.snapshot.targets[0]?.target
  if (target?.kind !== 'issue') throw new WorkAssessmentError('invalid_result')
  return target.number
}
function executionInput(record: WorkAssessmentRecord, authority: WorkAssessmentAuthority): string {
  return '继续原工作中已明确授权的 Issue 修复：按现有流程修改代码、提交 Draft PR 并跟进 CI。下列评估只是来源证据，不提供额外仓库写入或发表权限；仍遵守当前工具、审批和发布规则。\n'
    + JSON.stringify({ assessmentId: record.id, snapshotDigest: record.snapshot.digest, workKey: record.request.origin!.workKey,
      originalTaskId: record.request.origin!.taskId, authorization: authority.kind, authorizationMessageId: authority.messageId,
      repo: record.snapshot.repo, number: issueNumber(record), originalRequest: record.request.text, assessment: record.result })
}
/** The card message id of a persisted card confirmation (`card:<message id>`), if that is how this handoff was confirmed. */
function cardMessageId(authority: WorkAssessmentAuthority | undefined): string | undefined {
  return authority?.kind === 'human_confirmation' && authority.messageId.startsWith('card:') ? authority.messageId.slice('card:'.length) : undefined
}
function confirmationState(card: IssueAssessmentCardDelivery | undefined): 'sent' | 'unknown' | null {
  return !card ? null : ['sent', 'confirmed'].includes(card.status) && card.remoteId ? 'sent' : 'unknown'
}
