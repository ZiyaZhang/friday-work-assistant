import type { DatabaseSync } from 'node:sqlite'
import type { MaterialProvenance } from './execution-materials.js'
import type { ExecutionSourceAccessResult } from './execution-source-access.js'
import type { Spaces } from './space.js'
import type { PolicyService } from './policy.js'
import type { Bugs } from './bugs.js'
import type { FeishuClient } from '../feishu/client.js'
import { DeliveryService, readDeliveryRecord, type DeliveryContext } from './delivery.js'
import { assertRequestCurrent } from './request-lease.js'
import { PollError, pollDigest, type Poll, type PollOrigin, type Polls } from './polls.js'
import { pollSource, verifyPollSource, type PollSourceReceipt, type PollSourceAudience } from './poll-source.js'
import { renderPollCard, pollResultText } from '../feishu/poll-card.js'

export interface PollRunRef { sessionKey: string; runId: string }
/** This is produced by the host from the actual Task/Run. Never from model JSON. */
export interface PollRuntimeBinding { origin: PollOrigin; provenance: MaterialProvenance; assertCurrent(): void }
export interface PollRuntimeDeps {
  db: DatabaseSync; polls: Polls; bugs: Bugs; spaces: Spaces; policy: PolicyService
  feishu: Pick<FeishuClient, 'sendToChat' | 'chatMemberOpenIds'>
  /** Verified display metadata. A legacy ID-derived fallback is not a name. */
  participantName(openId: string): Promise<{ status: 'known'; name: string } | { status: 'unknown' }>
  binding(ref: PollRunRef): PollRuntimeBinding
  authorizeSavedContext(context: MaterialProvenance, origin: PollOrigin, assertCurrent: () => void): Promise<ExecutionSourceAccessResult>
  resolveDelivery(poll: Poll, ref: PollRunRef | undefined, assertCurrent: () => void): Promise<DeliveryContext | undefined>
  recordSource(ref: PollRunRef, source: PollSourceReceipt): void
  assertLifecycleCurrent(): void
  onFailure?(id: string, error: unknown): void
  now?: () => number
}
export interface PollCallback {
  pollId: string; digest: string; optionId: string | null; operatorOpenId: string; chatId: string; messageId: string
  /** The authenticated platform envelope, not card.value fields. */
  eventId: string; eventTimeMicros: string
}
export class PollAccessError extends PollError {
  constructor(readonly status: 'denied' | 'unavailable', readonly reason: string) { super(status === 'denied' ? 'denied' : 'unavailable') }
}

/** Poll business state and real human callbacks. Existing Work, Policy, retained
 * source authorization and Delivery remain the lifecycle/authority owners. */
export class PollRuntime {
  private ticking = false
  /** Live permission proofs only; persistent receipts alone never grant writes. */
  private readonly sourceLeases = new Map<string, () => void>()
  private readonly now: () => number
  constructor(private readonly deps: PollRuntimeDeps) { this.now = deps.now ?? Date.now }

  async create(ref: PollRunRef, input: { question: string; choices: string[]; closesAt?: number; feedbackId?: number }) {
    const binding = this.run(ref, 'configure')
    const check = () => { binding.assertCurrent(); this.assertSpace(binding.origin, binding.origin.ownerOpenId, 'configure') }
    check()
    if (input.feedbackId !== undefined) this.feedback(input.feedbackId, binding.origin.spaceId)
    const { poll } = this.deps.polls.create({ ...input, origin: binding.origin, context: binding.provenance,
      operationKey: pollDigest({ message: binding.origin.requestMessageId, space: binding.origin.spaceId, owner: binding.origin.ownerOpenId }) }, renderPollCard)
    const lease = await this.authorize(poll, check); lease()
    if (poll.state === 'draft') {
      const receipt = await this.delivery(poll, ref, lease).deliver({ key: `poll:${poll.id}:open`, contextRef: `poll:${poll.id}`, payload: { card: renderPollCard(poll) } })
      // Preserve a real ACK before testing cancellation. Recovery reuses this exact
      // Delivery key if the process ended between ACK and the local publication fact.
      if (receipt.remoteId) this.deps.polls.published(poll.id, poll.contentDigest, receipt.remoteId)
      lease()
    }
    const current = this.deps.polls.get(poll.id)!
    const result = this.project(current)
    this.recordSource(ref, current, lease, result); check()
    return result
  }

  async list(ref: PollRunRef) {
    const binding = this.run(ref, 'read'), items = []
    for (const poll of this.deps.polls.list(binding.origin.spaceId).filter(value => value.origin.chatId === binding.origin.chatId && value.state !== 'draft')) {
      const lease = await this.authorize(poll, binding.assertCurrent); lease()
      const current = this.deps.polls.get(poll.id)!
      const result = this.project(current)
      this.recordSource(ref, current, lease, result); lease()
      items.push(result)
    }
    return { polls: items }
  }

  async read(ref: PollRunRef, input: { pollId: string }) {
    const binding = this.run(ref, 'read'), poll = this.forBinding(input.pollId, binding)
    if (poll.state === 'draft') throw new PollError('unpublished')
    const lease = await this.authorize(poll, binding.assertCurrent); lease()
    const current = this.deps.polls.get(poll.id)!, result = this.deps.polls.tally(current.id)
    const output = { ...this.project(current), results: result.groups.map(({ text, count, voters }) => ({ option: text, count, voters })),
      total: result.total, withdrawn: result.withdrawn, asOfRevision: current.ballotRevision,
      notice: current.state === 'closed' ? '已截止；汇总等待负责人决断，未自动创建 Issue 或执行选项。' : '这是本次读取时已收到的选择；不代表所有群成员，之后仍可变化。需要当前结果时重新读取。' }
    this.recordSource(ref, current, lease, output); lease()
    return output
  }

  async close(ref: PollRunRef, input: { pollId: string }) {
    const binding = this.run(ref, 'configure'), poll = this.forBinding(input.pollId, binding)
    const lease = await this.authorize(poll, binding.assertCurrent); lease()
    const closed = this.closeLocal(poll, lease)
    await this.deliverResult(closed, ref, lease); lease()
    const output = { ...this.project(closed), resultDelivered: true }
    this.recordSource(ref, closed, lease, output); lease()
    return output
  }

  /** The model has no route to this method. Only authenticated card callbacks may
   * supply the actual actor and platform event order. An explicit click confirms
   * the exact ballot, including for Policy.act='ask'; it is not blanket authority. */
  async vote(input: PollCallback, assertCaller: () => void) {
    const poll = this.deps.polls.get(input.pollId)
    if (!poll || poll.origin.chatId !== input.chatId || poll.messageId !== input.messageId || poll.contentDigest !== input.digest) throw new PollError('denied')
    let registered = Boolean(this.deps.spaces.roleOf(poll.origin.spaceId, input.operatorOpenId))
    const check = () => {
      assertRequestCurrent(); assertCaller(); this.deps.assertLifecycleCurrent()
      if (!input.operatorOpenId) throw new PollError('denied')
      if (registered) {
        this.assertSpace(poll.origin, input.operatorOpenId, 'read')
        if (this.deps.policy.decide({ spaceId: poll.origin.spaceId, openId: input.operatorOpenId, action: 'act' }).decision === 'deny') throw new PollError('denied')
      }
    }
    const lease = await this.authorize(poll, check); lease()
    const members = await this.deps.feishu.chatMemberOpenIds(input.chatId, { fresh: true }); lease()
    if (!members.has(input.operatorOpenId)) throw new PollError('denied')
    // A first authenticated interaction in this group uses the same membership
    // admission as an actual message. Never re-add an existing member removed
    // during an await, and never create a membership from card.value alone.
    if (!registered) { this.deps.spaces.touchMember(poll.origin.spaceId, input.operatorOpenId); registered = true }
    lease()
    const name = await this.deps.participantName(input.operatorOpenId); lease()
    const result = this.deps.polls.ballot({ pollId: poll.id, digest: input.digest, messageId: input.messageId,
      openId: input.operatorOpenId, name: name.status === 'known' ? name.name : undefined,
      optionId: input.optionId, eventId: input.eventId, eventTimeMicros: input.eventTimeMicros }, lease)
    return { outcome: result.outcome, message: result.outcome === 'stale' ? '这条旧操作没有覆盖你的较新选择。'
      : input.optionId === null ? '已撤回你的选择。' : '已记录你的选择；截止前可以改选或撤回。' }
  }

  /** Mounted under the existing tracked timer only; no model loop or extra queue. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const poll of this.deps.polls.list().filter(value => value.state === 'closed' ? this.resultNeedsDelivery(value)
        : value.state === 'open' && value.closesAt !== null && value.closesAt <= this.now())) {
        this.deps.assertLifecycleCurrent()
        try {
          const lease = await this.authorize(poll, () => this.deps.assertLifecycleCurrent()); lease()
          const closed = this.closeLocal(poll, lease)
          await this.deliverResult(closed, undefined, lease); lease()
        } catch (error) { this.deps.assertLifecycleCurrent(); this.deps.onFailure?.(poll.id, error) }
      }
    } finally { this.ticking = false }
  }

  async checkSources(sources: readonly PollSourceReceipt[], audience: PollSourceAudience, assertCaller: () => void): Promise<ExecutionSourceAccessResult> {
    const snapshot = structuredClone(sources), leases: (() => void)[] = []
    let checkingLeases = false
    const current = () => {
      assertRequestCurrent(); assertCaller()
      if (!snapshot.every(source => verifyPollSource(this.deps.polls, source, audience))) throw new PollError('changed')
      for (const source of snapshot) this.assertSpace(this.deps.polls.get(source.pollId)!.origin, audience.openId, 'read')
      // Saved-source proofs retain this caller guard. Validate each acquired
      // proof once per synchronous pass, rather than recursively expanding all
      // earlier proofs again inside every later proof. No await occurs here.
      if (checkingLeases) return
      checkingLeases = true
      try { for (const lease of leases) lease() }
      finally { checkingLeases = false }
    }
    assertCaller()
    if (!snapshot.every(source => verifyPollSource(this.deps.polls, source, audience))) return { status: 'denied', reason: 'poll_snapshot_or_audience_changed', assertCurrent: assertCaller }
    for (const source of snapshot) {
      current()
      const poll = this.deps.polls.get(source.pollId)!
      const access = await this.deps.authorizeSavedContext(poll.context, poll.origin, current)
      current(); access.assertCurrent(); leases.push(access.assertCurrent)
      if (access.status !== 'allowed') return { status: access.status, reason: access.reason, assertCurrent: current }
    }
    current()
    for (const source of snapshot) this.sourceLeases.set(this.sourceKey(source, audience), current)
    return { status: 'allowed', assertCurrent: current }
  }

  /** Shared synchronous derived-state guard, after a read/checkSources obtained
   * the actual retained-context lease. New Runs must reauthorize; no persisted
   * receipt is upgraded to a permission, and no unrelated source is ignored.
   * New votes do not revoke a historical read; its snapshot remains attributable.
   * Operations needing today's count must explicitly read current domain facts. */
  sourcesCurrent(sources: readonly PollSourceReceipt[], audience: PollSourceAudience): boolean {
    try {
      assertRequestCurrent(); this.deps.assertLifecycleCurrent()
      for (const source of sources) {
        if (!verifyPollSource(this.deps.polls, source, audience)) return false
        this.assertSpace(this.deps.polls.get(source.pollId)!.origin, audience.openId, 'read')
        const lease = this.sourceLeases.get(this.sourceKey(source, audience))
        if (!lease) return false
        lease()
      }
      return true
    } catch { return false }
  }

  private sourceKey(source: PollSourceReceipt, audience: PollSourceAudience): string { return pollDigest({ source, audience }) }

  private recordSource(ref: PollRunRef, poll: Poll, guard: () => void, payload: Record<string, unknown>): void {
    const binding = this.run(ref, 'read')
    guard(); binding.assertCurrent()
    const source = pollSource(this.deps.polls.captureRead(poll, payload))
    const audience: PollSourceAudience = { spaceId: binding.origin.spaceId, chatId: binding.origin.chatId,
      chatType: 'group', openId: binding.origin.ownerOpenId }
    const current = () => {
      guard(); binding.assertCurrent()
      if (!verifyPollSource(this.deps.polls, source, audience)) throw new PollError('changed')
    }
    current(); this.deps.recordSource(ref, source); current()
    this.sourceLeases.set(this.sourceKey(source, audience), current)
  }

  private run(ref: PollRunRef, action: 'read' | 'configure'): PollRuntimeBinding {
    assertRequestCurrent()
    const binding = this.deps.binding(ref), original = pollDigest(binding.origin)
    const check = () => {
      assertRequestCurrent(); binding.assertCurrent(); this.deps.assertLifecycleCurrent()
      const fresh = this.deps.binding(ref)
      fresh.assertCurrent()
      if (ref.runId !== binding.origin.runId || ref.sessionKey !== binding.origin.sessionKey ||
        original !== pollDigest(fresh.origin)) throw new PollError('changed')
      this.assertSpace(binding.origin, binding.origin.ownerOpenId, action)
    }
    check(); return { ...binding, assertCurrent: check }
  }
  private assertSpace(origin: PollOrigin, openId: string, action: 'read' | 'configure') {
    const space = this.deps.spaces.get(origin.spaceId)
    if (!openId || origin.chatType !== 'group' || !space || space.kind !== 'group' || space.status !== 'active' || space.chatId !== origin.chatId ||
      this.deps.policy.decide({ spaceId: space.id, openId, action }).decision !== 'allow') throw new PollError('denied')
  }
  private forBinding(id: string, binding: PollRuntimeBinding): Poll {
    const poll = this.deps.polls.get(id)
    if (!poll || poll.origin.spaceId !== binding.origin.spaceId || poll.origin.chatId !== binding.origin.chatId) throw new PollError('not_found')
    return poll
  }
  private async authorize(poll: Poll, assertCaller: () => void): Promise<() => void> {
    const signature = pollDigest({ version: poll.version, origin: poll.origin, context: poll.context, content: poll.contentDigest })
    const current = () => {
      assertRequestCurrent(); assertCaller(); this.deps.assertLifecycleCurrent()
      const fresh = this.deps.polls.get(poll.id)
      if (!fresh || signature !== pollDigest({ version: fresh.version, origin: fresh.origin, context: fresh.context, content: fresh.contentDigest })) throw new PollError('changed')
      this.assertSpace(poll.origin, poll.origin.ownerOpenId, 'configure')
    }
    current()
    const access = await this.deps.authorizeSavedContext(poll.context, poll.origin, current)
    current(); access.assertCurrent()
    if (access.status !== 'allowed') throw new PollAccessError(access.status, access.reason)
    return () => { current(); access.assertCurrent() }
  }
  private feedback(id: number, spaceId: string) {
    const value = this.deps.bugs.get(id)
    if (!value || value.spaceId !== spaceId || value.intakePhase === 'cancelled') throw new PollError('denied')
    return value
  }
  private closeLocal(poll: Poll, guard: () => void): Poll {
    return this.deps.polls.close(poll.id, guard, (current, result) => {
      if (current.feedbackId !== undefined) this.feedback(current.feedbackId, current.origin.spaceId)
      const record = this.deps.bugs.record({ spaceId: current.origin.spaceId, chatId: current.origin.chatId, bucketId: current.feedbackId,
        title: '需求投票结果待负责人决断', messageId: `poll-result:${current.id}:${result.digest}`, reporterName: 'Friday 投票汇总',
        text: `投票已截止。有效选择 ${result.total} 人，已撤回 ${result.withdrawn} 人。完整问题、选项和具名分类保留在关联投票快照。等待负责人决断，没有自动创建 Issue 或采纳选项。` })
      this.deps.bugs.addEvidence({ bucketId: record.bucket.id, spaceId: current.origin.spaceId, kind: 'feedback_receipt',
        sourceRef: `poll:${current.id}:${result.digest}`, digest: result.digest, coverage: { state: 'unknown', note: '完整投票快照；不代表聊天记录覆盖或所有群成员意见。' } })
      if (record.isNew) this.deps.bugs.setIntake({ bucketId: record.bucket.id, spaceId: current.origin.spaceId, phase: 'triaged', missingInfo: [], note: '投票结果待负责人决断；未创建 Issue 或自动采纳选项。' })
      return record.bucket.id
    })
  }
  private delivery(poll: Poll, ref: PollRunRef | undefined, guard: () => void) {
    return new DeliveryService(this.deps.db, { spaces: this.deps.spaces, policy: this.deps.policy, now: this.now,
      resolveContext: async () => {
        guard()
        const context = await this.deps.resolveDelivery(poll, ref, guard); guard()
        if (!context || context.audience.kind !== 'group' || context.audience.spaceId !== poll.origin.spaceId || context.audience.chatId !== poll.origin.chatId) return undefined
        return { ...context, isCurrent: () => { guard(); return context.isCurrent?.() ?? true } }
      }, send: async ({ audience, payload }) => {
        guard()
        if (audience.kind !== 'group' || audience.chatId !== poll.origin.chatId) throw new PollError('denied')
        return { remoteId: await this.deps.feishu.sendToChat(audience.chatId, payload) }
      } })
  }
  private async deliverResult(poll: Poll, ref: PollRunRef | undefined, guard: () => void) {
    if (!poll.result) throw new PollError('invalid')
    const text = Array.from(pollResultText(poll, poll.result)), service = this.delivery(poll, ref, guard)
    for (let offset = 0; offset < text.length; offset += 3000) {
      guard()
      await service.deliver({ key: `poll:${poll.id}:result:${poll.result.digest}:${offset / 3000}`, contextRef: `poll:${poll.id}`,
        payload: { text: text.slice(offset, offset + 3000).join('') } }); guard()
    }
  }
  private resultNeedsDelivery(poll: Poll): boolean {
    if (!poll.result) return false
    const length = Array.from(pollResultText(poll, poll.result)).length
    for (let offset = 0; offset < length; offset += 3000) {
      const receipt = readDeliveryRecord(this.deps.db, `poll:${poll.id}:result:${poll.result.digest}:${offset / 3000}`)
      if (!receipt) return true
      // A missing ACK is not permission to retry or send later fragments.
      if (receipt.status === 'planned' || receipt.status === 'unknown') return false
    }
    return false
  }
  private project(poll: Poll) {
    return { pollId: poll.id, question: poll.question, choices: poll.choices.map(choice => choice.text), state: poll.state,
      closesAt: poll.closesAt, feedbackId: poll.feedbackId ?? null, published: Boolean(poll.messageId),
      rule: '具名单选，一人一票，截止前可改选或撤回；只接受本人点击原群卡片。' }
  }
}
