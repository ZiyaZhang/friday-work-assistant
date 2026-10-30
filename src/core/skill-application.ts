/** Space skill operations; the host resolves current runs and sources, while Delivery owns external sends. */
import type { DatabaseSync } from 'node:sqlite'
import { renderSkillProposalCard } from '../feishu/cards.js'
import { deliveryPayloadDigest, ensureDeliverySchema, readDeliveryRecord, type DeliveryRecord, type DeliveryService } from './delivery.js'
import type { Inbox } from './inbox.js'
import type { PolicyService } from './policy.js'
import { skillReviewParts, SkillStateError, type SkillProposal, type SkillProposals, type SpaceSkillBinding } from './skills.js'
import { dmSpaceId, type Spaces } from './space.js'

export interface SkillRunRef { sessionKey: string; runId: string }
export interface SkillRunContext extends SkillRunRef {
  spaceId: string; chatId: string; chatType: 'group' | 'p2p'; requesterOpenId: string; taskId?: number
}
export interface SkillApplicationDependencies {
  skills: SkillProposals
  spaces: Spaces
  policy: PolicyService
  /** Host current-run gate. Propose includes derived-source permission; pure disable does not. */
  resolveRun: (ref: SkillRunRef, operation: 'propose' | 'disable') => SkillRunContext | undefined
  /** Its resolver must recheck the current run, complete sources and exact audience at the send boundary. */
  deliveryFor: (ref: SkillRunRef, proposal: SkillProposal) => DeliveryService
  userName: (openId: string) => Promise<string>
  patchCard?: (messageId: string, card: Record<string, unknown>) => Promise<unknown>
  inbox?: Inbox
  /** Synchronous durable stop in the same DB transaction; signal/abort only after disable returns. */
  stopRuns: (runIds: readonly string[], caller: SkillRunRef) => string[]
}
export interface SkillProposalReceipt {
  proposal: SkillProposal; delivery: DeliveryRecord & { replayed: boolean }
  /** Only a decided-state patch after a late card ACK; initial delivery has its own status above. */
  cardStatus: 'updated' | 'unknown' | 'not_sent'
}
export interface SkillDecisionReceipt {
  proposal: SkillProposal; changed: boolean; cardStatus: 'updated' | 'unknown' | 'not_sent'
}
export interface SkillDisableReceipt {
  binding: SpaceSkillBinding; changed: boolean; runIds: string[]; stoppedRunIds: string[]
}
export class SkillApplicationError extends Error {
  constructor(readonly code: 'denied' | 'not_found', message: string) { super(message); this.name = 'SkillApplicationError' }
}

export class SkillApplication {
  constructor(private readonly db: DatabaseSync, private readonly deps: SkillApplicationDependencies) { ensureDeliverySchema(db) }

  async propose(ref: SkillRunRef, input: { name: string; description: string; body: string }): Promise<SkillProposalReceipt> {
    const actor = this.current(ref, 'propose')
    const proposal = this.transaction(() => {
      const p = this.deps.skills.propose({ ...input, sessionKey: actor.sessionKey, chatId: actor.chatId, chatType: actor.chatType,
        proposerOpenId: actor.requesterOpenId, spaceId: actor.spaceId, originRunId: actor.runId, originTaskId: actor.taskId })
      if (p.status === 'pending') this.deps.inbox?.add({ ownerOpenId: actor.requesterOpenId, kind: 'skill', refId: p.id, spaceId: actor.spaceId,
        title: `新技能提议「${p.name}」`, why: p.description.slice(0, 60) || undefined })
      return p
    })
    const key = `skill-proposal:${proposal.id}`
    const parts = skillReviewParts(proposal)
    const service = this.deps.deliveryFor(ref, proposal)
    for (const part of parts) {
      // 每段都走原始来源/受众复验和持久占位；回执不明时停止，不发接受按钮。
      await service.deliver({ key: part.key, contextRef: key, payload: { text: part.text } })
    }
    // Initial payload stays immutable even if a card click committed while an API ACK was lost.
    const card = renderSkillProposalCard({ ...proposal, reviewParts: parts.length, status: 'pending', decidedBy: null })
    const delivery = await service.deliver({ key, contextRef: key, payload: { card } })
    if (delivery.remoteId) this.deps.skills.setCard(proposal.id, delivery.remoteId)
    const current = this.deps.skills.get(proposal.id)!
    // A user may decide the visible card before its initial POST ACK reaches this process.
    const cardStatus = current.status === 'pending' ? 'not_sent' : await this.patchDecision(current)
    return { proposal: current, delivery, cardStatus }
  }

  async decide(input: { proposalId: number; decision: 'accept' | 'ignore'; operatorOpenId?: string; contentDigest?: string; chatId?: string; messageId?: string }): Promise<SkillDecisionReceipt> {
    const before = this.proposal(input.proposalId)
    this.authorizeDecision(before, input.operatorOpenId)
    this.authorizeVersion(before, input)
    if (before.status !== 'pending') return { proposal: before, changed: false, cardStatus: 'not_sent' }
    if (input.decision === 'accept') this.requireCompleteReview(before)
    const who = await this.deps.userName(input.operatorOpenId!)
    const result = this.transaction(() => {
      // A second click, archive or ownership change may have completed while the name lookup waited.
      const current = this.proposal(input.proposalId)
      this.authorizeDecision(current, input.operatorOpenId)
      this.authorizeVersion(current, input)
      if (current.status !== 'pending') return { proposal: current, changed: false }
      if (input.decision === 'accept') this.requireCompleteReview(current)
      const decided = input.decision === 'accept'
        ? this.deps.skills.accept(current.id, who, input.operatorOpenId!)
        : this.deps.skills.ignore(current.id, who, input.operatorOpenId!)
      if (!decided) throw new SkillApplicationError('not_found', '这条技能提议已无法处理')
      this.deps.inbox?.resolve('skill', current.id)
      return { proposal: decided, changed: true }
    })
    const cardStatus = result.changed ? await this.patchDecision(result.proposal) : 'not_sent'
    return { ...result, cardStatus }
  }

  private async patchDecision(proposal: SkillProposal): Promise<SkillDecisionReceipt['cardStatus']> {
    if (!proposal.cardMessageId || !this.deps.patchCard) return 'not_sent'
    try {
      await this.deps.patchCard(proposal.cardMessageId, renderSkillProposalCard(proposal))
      return 'updated'
    } catch { return 'unknown' } // A failed card patch cannot undo the stored decision.
  }

  private authorizeVersion(proposal: SkillProposal, input: { contentDigest?: string; chatId?: string; messageId?: string }): void {
    if (input.chatId !== proposal.chatId) throw new SkillApplicationError('denied', '请在技能提议所属的原会话里决定')
    if (!input.contentDigest || input.contentDigest !== proposal.contentDigest) {
      throw new SkillStateError('needs_reconfirmation', '这张卡的技能版本已失效，请核对完整正文后重新提议')
    }
    if (proposal.cardMessageId && input.messageId && proposal.cardMessageId !== input.messageId) {
      throw new SkillApplicationError('denied', '请使用这条提议的原始确认卡')
    }
  }

  private requireCompleteReview(proposal: SkillProposal): void {
    const parts = skillReviewParts(proposal)
    const contextRef = `skill-proposal:${proposal.id}`
    const sameAudience = (record: DeliveryRecord) => record.contextRef === contextRef && record.actorOpenId === proposal.proposerOpenId && record.audience.spaceId === proposal.spaceId
      && (proposal.chatType === 'group'
        ? record.audience.kind === 'group' && record.audience.chatId === proposal.chatId
        : record.audience.kind === 'dm' && record.audience.openId === proposal.proposerOpenId)
    for (const part of parts) {
      const record = readDeliveryRecord(this.db, part.key)
      if (!record || !['sent', 'confirmed'].includes(record.status) || !record.remoteId || !sameAudience(record)
        || record.payloadDigest !== deliveryPayloadDigest({ text: part.text })) {
        throw new SkillStateError('needs_reconfirmation', '完整正文尚未确认送达，暂不能启用；请先核对提议的投递状态')
      }
    }
    // 点击可能早于确认卡 POST 的回执；只要正文已送达且卡的占位匹配，仍可处理真实点击。
    const card = readDeliveryRecord(this.db, contextRef)
    const payload = { card: renderSkillProposalCard({ ...proposal, reviewParts: parts.length, status: 'pending', decidedBy: null }) }
    if (!card || !sameAudience(card) || card.payloadDigest !== deliveryPayloadDigest(payload)) {
      throw new SkillStateError('needs_reconfirmation', '未找到这个版本的完整审阅确认卡，请重新提议')
    }
  }

  disable(ref: SkillRunRef, input: { name: string; expectedRevision: number }): SkillDisableReceipt {
    const actor = this.current(ref, 'disable')
    this.authorizeOwner(actor.spaceId, actor.chatId, actor.chatType, actor.requesterOpenId)
    return this.transaction(() => {
      const result = this.deps.skills.disable(actor.spaceId, input.name, input.expectedRevision, actor.requesterOpenId)
      const stoppedRunIds = this.deps.stopRuns(result.runIds, ref)
      return { ...result, stoppedRunIds }
    })
  }

  private current(ref: SkillRunRef, operation: 'propose' | 'disable'): SkillRunContext {
    const actor = this.deps.resolveRun(ref, operation)
    if (!actor || actor.runId !== ref.runId || actor.sessionKey !== ref.sessionKey || !actor.requesterOpenId?.trim()) {
      throw new SkillApplicationError('denied', '本次技能操作的执行身份已失效')
    }
    const space = this.deps.spaces.get(actor.spaceId)
    if (!space || space.status !== 'active' || space.kind !== actor.chatType || space.chatId !== actor.chatId ||
      !this.deps.spaces.roleOf(space.id, actor.requesterOpenId) || (space.kind === 'p2p' && space.id !== dmSpaceId(actor.requesterOpenId))) {
      throw new SkillApplicationError('denied', '本次技能操作的空间或成员身份已失效')
    }
    return actor
  }

  private proposal(id: number): SkillProposal {
    const proposal = this.deps.skills.get(id)
    if (!proposal) throw new SkillApplicationError('not_found', '找不到这条技能提议')
    return proposal
  }

  private authorizeDecision(proposal: SkillProposal, openId?: string): void {
    if (!proposal.spaceId) throw new SkillStateError('needs_reconfirmation', '这条旧技能提议尚未绑定空间，请在当前空间重新核对后提议')
    if (proposal.chatType === 'p2p' && openId !== proposal.proposerOpenId) throw new SkillApplicationError('denied', '只有本人能决定')
    this.authorizeOwner(proposal.spaceId, proposal.chatId, proposal.chatType, openId)
  }

  private authorizeOwner(spaceId: string, chatId: string, chatType: 'group' | 'p2p', openId?: string): void {
    if (!openId?.trim()) throw new SkillApplicationError('denied', '认不出是谁操作，不能处理技能')
    const space = this.deps.spaces.get(spaceId)
    if (!space || space.status !== 'active' || space.kind !== chatType || space.chatId !== chatId) throw new SkillApplicationError('denied', '技能所属空间已失效，不能处理')
    if (space.kind === 'p2p' && space.id !== dmSpaceId(openId)) throw new SkillApplicationError('denied', '只有本人能决定')
    if (this.deps.spaces.roleOf(spaceId, openId) !== 'owner') throw new SkillApplicationError('denied', '只有本空间负责人能决定技能')
    const gate = this.deps.policy.decide({ spaceId, openId, action: 'configure' })
    if (gate.decision !== 'allow') throw new SkillApplicationError('denied', gate.reason)
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('SAVEPOINT skill_application')
    try { const result = fn(); this.db.exec('RELEASE skill_application'); return result }
    catch (error) { this.db.exec('ROLLBACK TO skill_application; RELEASE skill_application'); throw error }
  }
}
