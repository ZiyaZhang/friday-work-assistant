import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Registry } from './registry.js'
import type { Spaces } from './space.js'
import type { PolicyService } from './policy.js'
import { TaskEvents, validTaskEventDispatch } from './task-events.js'
import type { SourceContext } from './source-context.js'
import type { GitHubIdentity } from '../github/identity.js'
import { WorkAssessmentSourceBroker, type WorkAssessmentSnapshot } from '../github/work-assessment-snapshot.js'
import { runWorkAssessment, WorkAssessmentError, type WorkAssessments, type WorkAssessmentRecord,
  type WorkAssessmentRequest, type WorkAssessmentExecution, type WorkAssessmentAuthority, type WorkAssessmentHandoff } from './work-assessment.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bindingSchema = z.object({ spaceId: z.string().min(1), boundBy: z.string().min(1),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), since: z.number().int().nonnegative(),
  labels: z.array(z.string().min(1)), version: z.string().min(1).optional() })
const factsSchema = z.object({ number: z.number().int().positive(), isPullRequest: z.boolean(), state: z.enum(['open', 'closed']),
  assignees: z.array(z.string().min(1)), labels: z.array(z.string()), linkedPullRequests: z.number().int().nonnegative(),
  createdAt: z.number().int().positive(), updatedAt: z.number().int().positive() })

/** A host lease over these exact original sources, obtained through the existing source-access service.
 * Neither this lease nor assessment intent is an MCP/model argument. It must include lifecycle/stop checks. */
export interface IssueAssessmentSourceLease { context: SourceContext; assertCurrent(): void }
export interface IssueAssessmentApplicationDeps {
  registry: Registry
  spaces: Spaces
  policy: PolicyService
  github: Pick<GitHubIdentity, 'api' | 'repoAllowed'>
  assessments: WorkAssessments
  execution: WorkAssessmentExecution
  /** Existing deployment allowlist and fresh platform-membership lease, including after every await. */
  assertSpaceCurrent(spaceId: string, chatId: string, actorOpenId: string): void
  /** Host-owned rule, not text from a model. 0 disables this automatic assessment application. */
  minimumIdleMs?: number
  now?: () => number
}

/** B.2 issue domain application. It reads repository evidence and persists proposals only.
 * No GitHub mutation, messaging, Inbox insertion, shell or worker session is available here. */
export class IssueAssessmentApplication {
  private readonly broker: WorkAssessmentSourceBroker
  private readonly now: () => number
  private readonly minimumIdleMs: number
  private readonly events: TaskEvents

  constructor(private readonly deps: IssueAssessmentApplicationDeps) {
    this.broker = new WorkAssessmentSourceBroker(deps.github)
    this.events = new TaskEvents(deps.registry)
    this.now = deps.now ?? Date.now
    this.minimumIdleMs = deps.minimumIdleMs ?? 86400_000
    if (!Number.isSafeInteger(this.minimumIdleMs) || this.minimumIdleMs < 0) throw new WorkAssessmentError('not_authorized')
  }

  async assess(input: { taskId: number; number: number; intent: WorkAssessmentRequest['intent'];
    sources: IssueAssessmentSourceLease; signal?: AbortSignal;
    /** Host-selected earlier record for the same group/binding/Issue. It is returned instead of a new admission only when
     * the thread read for this request is byte-identical to its snapshot; any change assesses again under this Task. */
    reuse?: WorkAssessmentRecord }): Promise<WorkAssessmentRecord> {
    if (this.minimumIdleMs === 0) throw new WorkAssessmentError('not_authorized')
    const request = this.request(input.taskId, input.number, input.intent, input.sources)
    const check = () => { input.signal?.throwIfAborted(); this.assertOrigin(request, input.sources) }
    check()
    const existing = this.deps.assessments.byKey(request.assessmentKey!)
    if (existing) {
      if (!isDeepStrictEqual(existing.request, request)) throw new WorkAssessmentError('conflict')
      return existing // A duplicate delivery never purchases another evaluation, including failed/interrupted ones.
    }
    const snapshot = await this.broker.read({ targets: [{ kind: 'issue', repo: this.binding(request).repo.toLowerCase(), number: input.number }], assertCurrent: check })
    check()
    if (input.reuse && this.reusable(request, snapshot, input.reuse)) return input.reuse
    const rejection = this.ruleRejection(request, snapshot)
    if (rejection) return this.deps.assessments.decideWithoutModel(request, snapshot, rejection)
    const record = await runWorkAssessment({ store: this.deps.assessments, request, snapshot,
      execution: this.deps.execution, signal: input.signal, assertCurrent: check })
    check()
    return record
  }

  /** Reading a saved proposal uses the same source/binding proof as acting on it. */
  read(input: { assessmentId: string; taskId: number; sources: IssueAssessmentSourceLease }): WorkAssessmentRecord {
    const record = this.deps.assessments.get(input.assessmentId)
    if (!record?.request.origin) throw new WorkAssessmentError('not_authorized')
    this.assertOrigin(record.request, input.sources, input.taskId, record.handoff?.taskId)
    return record
  }

  /** Re-read exact evidence before a host-authorized handoff. Only create persistent Task/dispatch in create;
   * queue wakeup, ACP setup and any actual effects belong after this method commits. */
  async handoff(input: { assessmentId: string; authorityTaskId: number; kind: WorkAssessmentAuthority['kind'];
    /** Host-verified click on the confirmation card the host delivered for this assessment (the card's message id).
     * Valid only as a human_confirmation whose authority Task is the original request: the click is the new human input,
     * the original Task stays the event source. Recorded as `card:<message id>`. */
    confirmation?: { messageId: string }
    sources: IssueAssessmentSourceLease; signal?: AbortSignal;
    create(input: { key: string; assessment: WorkAssessmentRecord; authority: WorkAssessmentAuthority }): WorkAssessmentHandoff;
  }): Promise<WorkAssessmentHandoff> {
    const record = this.deps.assessments.get(input.assessmentId), request = record?.request
    if (!record || !request?.origin || record.result?.verdict !== 'recommend') throw new WorkAssessmentError('not_authorized')
    if (input.confirmation && (input.kind !== 'human_confirmation' || input.authorityTaskId !== request.origin.taskId
      || typeof input.confirmation.messageId !== 'string' || !input.confirmation.messageId.trim())) throw new WorkAssessmentError('not_authorized')
    let createdTaskId = record.handoff?.taskId
    const check = () => {
      input.signal?.throwIfAborted()
      this.assertOrigin(request, input.sources, input.authorityTaskId, createdTaskId)
      const act = this.deps.policy.decide({ spaceId: request.spaceId, openId: request.actorOpenId, action: 'act' })
      if (act.decision === 'deny' || (act.decision === 'ask' && input.kind !== 'human_confirmation')) throw new WorkAssessmentError('not_authorized')
    }
    check()
    const authorityTask = this.deps.registry.getTask(input.authorityTaskId)!
    const authority: WorkAssessmentAuthority = { kind: input.kind,
      messageId: input.confirmation ? `card:${input.confirmation.messageId}` : authorityTask.messageId, assessmentId: record.id,
      actorOpenId: request.actorOpenId, spaceId: request.spaceId, chatId: request.chatId, bindingVersion: request.bindingVersion,
      repo: record.snapshot.repo, action: 'develop_change', targetRef: record.result.proposedAction!.targetRef, snapshotDigest: record.snapshot.digest }
    if (record.state !== 'handed_off') {
      const reviewed = await this.broker.read({ targets: record.snapshot.targets.map(item => item.target), assertCurrent: check })
      check()
      if (reviewed.digest !== record.snapshot.digest || this.ruleRejection(request, reviewed)) throw new WorkAssessmentError('thread_changed')
    }
    return this.deps.assessments.handoff(record.id, authority, check, value => {
      const handoff = input.create(value)
      createdTaskId = handoff?.taskId
      const created = createdTaskId && this.deps.registry.getTask(createdTaskId)
      const envelope = createdTaskId && this.deps.registry.dispatches.get(createdTaskId)?.inbound
      const event = createdTaskId && this.events.get(createdTaskId)
      if (!created || created.id === request.origin!.taskId || created.id === input.authorityTaskId || created.messageId !== `host-event:${value.key}`
        || !envelope || !validTaskEventDispatch(this.deps.registry.db, created.id, envelope)
        || !event || event.kind !== 'issue_assessment' || event.domainId !== record.id || event.key !== value.key
        || event.sourceTaskId !== input.authorityTaskId || event.sourceWorkKey !== request.origin!.workKey
        || envelope.senderOpenId !== request.actorOpenId || envelope.chatId !== request.chatId || envelope.chatType !== request.chatType) {
        throw new WorkAssessmentError('conflict')
      }
      return handoff
    })
  }

  /** Same person, same group, same binding text and version, same host rule, an unexpired admitted record, and an identical
   * thread snapshot. Only an assess-only request may read through: an explicit repair request needs its own admission. */
  private reusable(request: WorkAssessmentRequest, snapshot: WorkAssessmentSnapshot, reuse: WorkAssessmentRecord): boolean {
    const origin = reuse.request.origin
    return request.intent === 'assess_only' && reuse.request.intent === 'assess_only' && Boolean(origin)
      && ['running', 'completed'].includes(reuse.state) && reuse.expiresAt > this.now()
      && reuse.snapshot.digest === snapshot.digest && reuse.snapshot.repo === snapshot.repo
      && reuse.request.actorOpenId === request.actorOpenId && reuse.request.spaceId === request.spaceId
      && reuse.request.chatId === request.chatId && reuse.request.chatType === request.chatType
      && reuse.request.bindingVersion === request.bindingVersion && origin!.binding === request.origin!.binding
      && origin!.minimumIdleMs === this.minimumIdleMs
  }

  private request(taskId: number, number: number, intent: WorkAssessmentRequest['intent'], sources: IssueAssessmentSourceLease): WorkAssessmentRequest {
    if (!Number.isSafeInteger(number) || number < 1 || !['assess_only', 'execute_if_suitable'].includes(intent)) throw new WorkAssessmentError('not_authorized')
    const { registry, spaces } = this.deps, task = registry.getTask(taskId), session = task && registry.getSession(task.sessionKey)
    const workRef = registry.taskWork.get(taskId), work = workRef && registry.workContexts.get(workRef.key)
    const space = session && spaces.byChat(session.chatId)
    if (!task?.requesterOpenId || !session || !work || !space || !task.prompt.trim()) throw new WorkAssessmentError('not_current')
    const raw = registry.getKv(`issue-watch:${space.id}`), parsed = bindingSchema.safeParse(raw && JSON.parse(raw))
    if (!raw || !parsed.success || parsed.data.spaceId !== space.id) throw new WorkAssessmentError('not_authorized')
    const binding = parsed.data, bindingVersion = binding.version ?? hash(raw)
    const request: WorkAssessmentRequest = { messageId: task.messageId, actorOpenId: task.requesterOpenId, spaceId: space.id,
      chatId: session.chatId, chatType: session.chatType, ...(session.threadId ? { threadId: session.threadId } : {}), bindingVersion,
      text: task.prompt, intent, assessmentKey: `issue:${task.id}:${hash([binding.repo.toLowerCase(), number, bindingVersion])}`,
      origin: { taskId, workKey: work.workKey, controlEpoch: work.controlEpoch, inputSeq: work.inputSeq,
        sources: structuredClone(sources.context), sourceDigest: hash(sources.context), binding: raw, minimumIdleMs: this.minimumIdleMs } }
    this.assertOrigin(request, sources)
    return request
  }

  private binding(request: WorkAssessmentRequest) {
    const { registry, spaces, policy, github } = this.deps
    const space = spaces.get(request.spaceId), origin = request.origin
    if (!origin || !space || space.status !== 'active' || space.kind !== 'group' || space.chatId !== request.chatId
      || registry.getKv(`issue-watch:${space.id}`) !== origin.binding) throw new WorkAssessmentError('not_current')
    const binding = bindingSchema.parse(JSON.parse(origin.binding))
    const owner = policy.decide({ spaceId: space.id, openId: binding.boundBy, action: 'configure' })
    const reader = policy.decide({ spaceId: space.id, openId: request.actorOpenId, action: 'read' })
    if (binding.spaceId !== space.id || owner.decision !== 'allow' || !['admin', 'owner'].includes(owner.actor)
      || reader.decision !== 'allow' || reader.actor === 'outsider' || !github.repoAllowed(binding.repo.toLowerCase())
      || (binding.version ?? hash(origin.binding)) !== request.bindingVersion || origin.minimumIdleMs !== this.minimumIdleMs) {
      throw new WorkAssessmentError('not_authorized')
    }
    this.deps.assertSpaceCurrent(space.id, request.chatId, request.actorOpenId)
    this.deps.assertSpaceCurrent(space.id, request.chatId, binding.boundBy)
    return binding
  }

  private assertOrigin(request: WorkAssessmentRequest, lease: IssueAssessmentSourceLease, authorityTaskId?: number, createdTaskId?: number): void {
    lease.assertCurrent()
    this.binding(request)
    const { registry } = this.deps, origin = request.origin!
    const task = registry.getTask(origin.taskId), session = task && registry.getSession(task.sessionKey)
    const work = registry.workContexts.get(origin.workKey), dispatch = registry.dispatches.get(origin.taskId)
    if (!task || task.status === 'cancelled' || !session || session.status === 'archived' || !work || work.lifecycle !== 'open'
      || work.pauseReasons.length || work.controlEpoch !== origin.controlEpoch || work.authorityOpenId !== request.actorOpenId
      || work.sessionKey !== session.sessionKey || registry.taskWork.get(task.id)?.key !== origin.workKey
      || task.messageId !== request.messageId || task.requesterOpenId !== request.actorOpenId || task.prompt !== request.text
      || session.chatId !== request.chatId || session.chatType !== request.chatType || (session.threadId ?? undefined) !== request.threadId
      || !dispatch || dispatch.inbound.messageId !== request.messageId || dispatch.inbound.senderOpenId !== request.actorOpenId
      || dispatch.inbound.senderType !== 'user' || registry.taskForMessage(task.messageId)?.id !== task.id
      || dispatch.inbound.chatId !== request.chatId || dispatch.inbound.chatType !== request.chatType
      || lease.context.spaceId !== request.spaceId || lease.context.chatId !== request.chatId || hash(lease.context) !== origin.sourceDigest
      || hash(origin.sources) !== origin.sourceDigest) throw new WorkAssessmentError('not_current')
    const expected = [authorityTaskId, createdTaskId].filter((id, index, all): id is number =>
      id !== undefined && id !== origin.taskId && all.indexOf(id) === index)
    const following = registry.workContexts.inputs(origin.workKey).filter(item => item.seq > origin.inputSeq)
    if (!registry.workContexts.inputs(origin.workKey).some(item => item.seq === origin.inputSeq && item.taskId === origin.taskId)
      || following.length !== expected.length || following.some((item, index) => item.taskId !== expected[index])
      || work.inputSeq !== origin.inputSeq + following.length) throw new WorkAssessmentError('not_current')
    for (const id of [authorityTaskId, createdTaskId]) {
      if (id === undefined) continue
      const actual = registry.getTask(id)
      if (!actual || actual.status === 'cancelled' || actual.requesterOpenId !== request.actorOpenId || actual.sessionKey !== session.sessionKey
        || registry.taskWork.get(id)?.key !== origin.workKey) throw new WorkAssessmentError('not_authorized')
      // Confirmation is a real human input. A generated execution Task cannot manufacture that authority.
      if (id === authorityTaskId) {
        const inbound = registry.dispatches.get(id)?.inbound
        if (!inbound || inbound.messageId !== actual.messageId || inbound.senderOpenId !== request.actorOpenId
          || inbound.senderType !== 'user' || inbound.chatId !== request.chatId || inbound.chatType !== request.chatType
          || registry.taskForMessage(actual.messageId)?.id !== id) throw new WorkAssessmentError('not_authorized')
      }
    }
  }

  private ruleRejection(request: WorkAssessmentRequest, snapshot: WorkAssessmentSnapshot) {
    const target = snapshot.targets[0]!, metadata = snapshot.sources.find(source => source.ref === `${target.ref}:metadata`)
    if (!metadata || target.target.kind !== 'issue') throw new WorkAssessmentError('invalid_result')
    const facts = factsSchema.parse(JSON.parse(metadata.text)), binding = this.binding(request)
    const activity = Math.max(facts.updatedAt, ...snapshot.sources.map(source => source.at ?? 0))
    const reason = this.minimumIdleMs === 0 ? '当前自动接单评估已停用。'
      : facts.isPullRequest || facts.state !== 'open' ? '该对象不是仍打开的 Issue，不进入自动接单。'
      : facts.assignees.length ? 'Issue 已有负责人，不进入自动接单。'
      : facts.linkedPullRequests ? '完整时间线中已有打开或合入的关联 PR，不重复接手。'
      : binding.labels.length && !facts.labels.some(label => binding.labels.includes(label)) ? 'Issue 不符合当前仓库绑定的标签规则。'
      : activity < binding.since ? '这条 Issue 在关注绑定前已静默，不自动翻出旧事项。'
      : this.now() - activity < this.minimumIdleMs ? 'Issue 尚未满足约定的无人更新等待窗口。' : undefined
    if (!reason) return undefined
    return { verdict: 'not_suitable' as const, summary: reason, evidence: [{ ref: metadata.ref, quote: metadata.text.slice(0, 500) }],
      missingInfo: [], proposedAction: null }
  }
}
