import { workRequestMessage } from '../feishu/work-request.js'
import { memoryCandidatePayload, memoryDecidedCard } from '../feishu/memory-card.js'
export { memoryCandidatePayload } from '../feishu/memory-card.js'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { IngressDecision } from '../acp/ingress-classifier.js'
import type { FeishuClient } from '../feishu/client.js'
import type { InboundMessage } from '../feishu/mention.js'
import { DeliveryError, DeliveryService, deliveryPayloadDigest, ensureDeliverySchema, readDeliveryRecord, type DeliveryContext, type DeliveryRecord } from './delivery.js'
import { IngressReceipts } from './ingress.js'
import type { MemoryOperationResult } from './memory-application.js'
import type { ChannelMemory, MemoryNote } from './memory.js'
import type { MemoryRuntime } from './memory-runtime.js'
import type { PolicyService } from './policy.js'
import { dmSpaceId, spaceScope, type Spaces } from './space.js'

/** All identity and anchors come from a real inbound envelope, never tool arguments. */
export interface MemoryHumanEnvelope {
  spaceId: string
  message: InboundMessage
  /** Presentation by a worker additionally keeps its captured execution lease. Human confirmation does not. */
  isCurrent?: () => boolean
  /** Ephemeral source-authorized body access, supplied only by this host application. */
  readProof?: { notes: readonly MemoryNote[]; assertCurrent(): void }
  /** Set only by the card paths: a group space owner may act on a card presented to another member. */
  cardOperator?: true
}
interface DisplayTarget {
  version: 1
  noteId: number
  revision: number
  scope: string
  actor: string
  chatId: string
  chatType: 'group' | 'p2p'
  threadId: string | null
  rootId: string | null
  originMessageId: string
  replacement: { id: number; revision: number } | null
}
export interface ConfirmableNote {
  ref: string
  noteId: number
  revision: number
  title: string
  body: string
  replaces?: { id: number; title: string; body: string }
  replied: boolean
}
export interface MemoryFactReceipt {
  noteId: number; text: string; delivery: DeliveryRecord; replayed: boolean
  /** Only on a fresh card decision: the card to put in place of the candidate card. A replay keeps the card already shown. */
  card?: Record<string, unknown>
}
/** The click is real but the card does not belong to this person. Distinguished so the toast can say so. */
export class MemoryCardAccessError extends Error {
  constructor(message: string) { super(message); this.name = 'MemoryCardAccessError' }
}
export interface MemoryCardClick { targetRef: string; operatorOpenId?: string; chatId?: string; messageId?: string }
type MemoryIntent = Extract<IngressDecision, { kind: 'memory_save_preference' | 'memory_confirm' }>
type MemoryControl = MemoryIntent | Extract<IngressDecision, { kind: 'memory_forget' }>
type Committed = { result: MemoryOperationResult<unknown>; noteId: number }
type Deps = { db: DatabaseSync; memory: ChannelMemory; runtime: MemoryRuntime; spaces: Spaces; policy: PolicyService;
  feishu: Pick<FeishuClient, 'chatMemberOpenIds' | 'sendToChat' | 'replyCard' | 'replyText'>; now: () => number;
  assertActive?: () => void
  authorizeNotes?: (ids: readonly number[], envelope: MemoryHumanEnvelope) => Promise<NonNullable<MemoryHumanEnvelope['readProof']>> }
const PREFIX = 'memory-present:'
const TARGET_PREFIX = 'memory-target:'
const CORRECT_PREFIX = 'memory-correct:'
const RECENT_MS = 30 * 60_000

/** One application for human preference, displayed-candidate confirmation, slash and card controls.
 * No new proposal store: full-display version/identity are frozen in the existing Delivery ledger.
 */
export class MemoryConfirmation {
  private readonly ingress: IngressReceipts
  constructor(private readonly deps: Deps) {
    ensureDeliverySchema(deps.db)
    this.ingress = new IngressReceipts(deps.db)
  }

  /** Only host-generated, ACKed, exact current versions are candidates, never globally latest notes. */
  async targetsFor(envelope: MemoryHumanEnvelope): Promise<ConfirmableNote[]> {
    return (await this.captureTargetsFor(envelope)).targets
  }

  async captureTargetsFor(envelope: MemoryHumanEnvelope): Promise<{ targets: ConfirmableNote[]; assertCurrent(): void }> {
    if (!this.current(envelope)) return { targets: [], assertCurrent: () => this.assertCurrent(envelope) }
    const { message: msg } = envelope
    const anchor = this.anchorFor(msg)
    const rows = this.deps.db.prepare(`SELECT delivery_key FROM deliveries WHERE delivery_key LIKE ? AND actor_open_id = ?
      AND status IN ('sent','confirmed') AND remote_id IS NOT NULL ORDER BY created_at DESC, delivery_key`).all(PREFIX + '%', msg.senderOpenId!) as { delivery_key: string }[]
    const ids = rows.flatMap(row => {
      const record = readDeliveryRecord(this.deps.db, row.delivery_key)!, target = decodeTarget(record.contextRef)
      if (!target || (anchor ? record.remoteId !== anchor : record.createdAt < this.deps.now() - RECENT_MS)) return []
      return [target.noteId, ...(target.replacement ? [target.replacement.id] : [])]
    })
    envelope = await this.authorize(envelope, ids)
    const targets: ConfirmableNote[] = []
    for (const row of rows) {
      const record = readDeliveryRecord(this.deps.db, row.delivery_key)!
      if (anchor ? record.remoteId !== anchor : record.createdAt < this.deps.now() - RECENT_MS) continue
      const value = this.target(row.delivery_key, envelope)
      if (value && !targets.some(t => t.noteId === value.note.id && t.revision === value.note.revision)) {
        targets.push({ ref: row.delivery_key, noteId: value.note.id, revision: value.note.revision, title: value.note.title,
          body: value.note.body, ...(value.previous ? { replaces: { id: value.previous.id, title: value.previous.title, body: value.previous.body } } : {}),
          replied: record.remoteId === anchor })
      }
    }
    return { targets, assertCurrent: () => {
      this.assertCurrent(envelope); envelope.readProof?.assertCurrent()
      for (const target of targets) this.requireTarget(target.ref, envelope)
    } }
  }

  /** Metadata-only lookup lets a reply to a display (or to its correction hint) enter control routing without a live worker. */
  isDisplayReply(message: InboundMessage): boolean {
    const anchor = this.anchorFor(message)
    return Boolean(anchor && message.senderOpenId && this.deps.db.prepare(`SELECT 1 FROM deliveries
      WHERE delivery_key LIKE ? AND remote_id = ? AND actor_open_id = ?`).get(PREFIX + '%', anchor, message.senderOpenId))
  }

  async present(noteId: number, expectedRevision: number, envelope: MemoryHumanEnvelope): Promise<DeliveryRecord> {
    this.assertCurrent(envelope)
    envelope = await this.authorize(envelope, [noteId])
    const note = this.read(noteId, envelope)
    if (!note || note.revision !== expectedRevision || note.status !== 'candidate') throw new Error('候选已更新、删除或当前不可读。')
    if (typeof note.source?.replaces === 'number') envelope = await this.authorize(envelope, [noteId, note.source.replaces])
    const previous = this.previous(note, envelope)
    const msg = envelope.message
    const target: DisplayTarget = { version: 1, noteId, revision: expectedRevision, scope: note.scope, actor: msg.senderOpenId!,
      chatId: msg.chatId, chatType: msg.chatType, threadId: msg.threadId ?? null, rootId: msg.rootId ?? null,
      originMessageId: msg.messageId, replacement: previous ? { id: previous.id, revision: previous.revision } : null }
    const contextRef = TARGET_PREFIX + JSON.stringify(target)
    const key = PREFIX + createHash('sha256').update(contextRef).digest('hex')
    const payload = memoryCandidatePayload(note, previous, key)
    const valid = () => {
      this.assertCurrent(envelope)
      const current = this.read(noteId, envelope)
      if (!current || current.revision !== expectedRevision || current.status !== 'candidate' ||
        deliveryPayloadDigest(memoryCandidatePayload(current, this.previous(current, envelope), key)) !== deliveryPayloadDigest(payload)) {
        throw new Error('候选展示期间内容已变化。')
      }
    }
    try { return await this.delivery(envelope, valid).deliver({ key, contextRef, payload }) }
    catch (error) {
      if (error instanceof DeliveryError && error.code === 'unknown') {
        const record = readDeliveryRecord(this.deps.db, key)
        if (record) return record
      }
      throw error
    }
  }

  async saveExplicitPreference(envelope: MemoryHumanEnvelope, intent: Extract<MemoryIntent, { kind: 'memory_save_preference' }>,
    afterApply?: () => void): Promise<MemoryFactReceipt> {
    if (intent.targetRef) envelope = await this.authorizeTarget(intent.targetRef, envelope)
    const body = preferenceText(envelope.message.text, intent.spans)
    if (envelope.message.chatType !== 'p2p' || envelope.spaceId !== dmSpaceId(envelope.message.senderOpenId ?? '')) throw new Error('直接保存偏好仅限本人私聊。')
    return this.apply(envelope, intent, '已记住这条个人偏好。', () => {
      const replace = intent.targetRef ? this.requireTarget(intent.targetRef, envelope).note : undefined
      const provenance = replace && this.deps.memory.getProvenance(replace.id)
      const result = this.deps.runtime.application.add({ scope: spaceScope(envelope.spaceId), kind: 'rule', title: '个人偏好', body,
        status: 'confirmed', confirmation: { by: envelope.message.senderOpenId!, messageId: envelope.message.messageId, at: this.deps.now() },
        source: { by: envelope.message.senderOpenId!, messageId: envelope.message.messageId, chatId: envelope.message.chatId, generatedBy: 'human_preference' },
        ...(replace ? { replaces: replace.id, expectedRevision: replace.revision } : {}),
        ...(provenance?.state === 'verified' && provenance.originRunId ? { provenance: { state: 'verified', originRunId: provenance.originRunId, sources: provenance.sources } } : {}) })
      return { result, noteId: result.value.id }
    }, afterApply)
  }

  async confirm(targetRef: string, envelope: MemoryHumanEnvelope, continueWork = false, afterApply?: () => void): Promise<MemoryFactReceipt> {
    // A replay is resolved before looking for a candidate that this operation already confirmed.
    const replay = this.replay(envelope)
    if (replay) return replay
    envelope = await this.authorizeTarget(targetRef, envelope)
    const { note, previous } = this.requireTarget(targetRef, envelope)
    const decision: MemoryIntent = { kind: 'memory_confirm', targetRef, continueWork }
    const receipt = await this.apply(envelope, decision, '已记住。', () => {
      this.requireTarget(targetRef, envelope)
      const result = this.deps.runtime.application.confirm(note.id, note.scope, { by: envelope.message.senderOpenId!,
        messageId: envelope.message.messageId, expectedRevision: note.revision })
      if (!result.value) throw new Error('候选已经变化，请查看当前版本。')
      return { result, noteId: note.id }
    }, afterApply)
    return receipt.replayed ? receipt : { ...receipt, card: memoryDecidedCard({ noteId: note.id, decision: 'confirmed',
      note: { title: note.title, body: note.body }, ...(previous ? { previousId: previous.id } : {}) }) }
  }

  /** Forgetting a displayed candidate is the same human control as confirming it: exact version, same ledger, one receipt. */
  async forget(targetRef: string, envelope: MemoryHumanEnvelope): Promise<MemoryFactReceipt> {
    const replay = this.replay(envelope)
    if (replay) return replay
    envelope = await this.authorizeTarget(targetRef, envelope)
    const { note, previous } = this.requireTarget(targetRef, envelope)
    const decision: MemoryControl = { kind: 'memory_forget', targetRef }
    const text = !previous ? '已忘记。'
      : previous.status === 'confirmed' ? '没有记，原来那条保持不变。'
        : '已忘记；它替换掉的旧候选不会恢复。'
    const receipt = await this.apply(envelope, decision, text, () => {
      this.requireTarget(targetRef, envelope)
      const result = this.deps.runtime.application.remove(note.id, note.scope, { expectedRevision: note.revision })
      if (!result.value) throw new Error('候选已经变化，请查看当前版本。')
      return { result, noteId: note.id }
    })
    return receipt.replayed ? receipt : { ...receipt, card: memoryDecidedCard({ noteId: note.id, decision: 'forgotten', ...(previous ? { previousId: previous.id } : {}) }) }
  }

  /** The platform's real operator + exact remote ID are mandatory; no proposer fallback. */
  async confirmCard(input: MemoryCardClick): Promise<MemoryFactReceipt> {
    return this.confirm(input.targetRef, this.cardEnvelope(input, 'memory-click'))
  }

  async forgetCard(input: MemoryCardClick): Promise<MemoryFactReceipt> {
    return this.forget(input.targetRef, this.cardEnvelope(input, 'memory-forget-click'))
  }

  /** The button carries no new content. It only checks the card still belongs to this person and this version,
   * then asks for the corrected content as a reply; the reply is saved through the existing replacement operations. */
  async correctCard(input: MemoryCardClick): Promise<{ text: string; delivery: DeliveryRecord; replayed: boolean }> {
    let envelope = this.cardEnvelope(input, 'memory-correct-click')
    envelope = await this.authorizeTarget(input.targetRef, envelope)
    const { note } = this.requireTarget(input.targetRef, envelope)
    const text = `请回复这张记忆卡（或本条提示），把记忆 #${note.id} 正确的内容完整告诉我；保存后会替代这条候选。`
    const key = `${CORRECT_PREFIX}${createHash('sha256').update(`${input.targetRef}\n${input.operatorOpenId}`).digest('hex')}`
    const valid = () => { this.assertCurrent(envelope); this.requireTarget(input.targetRef, envelope) }
    try {
      const delivery = await this.delivery(envelope, valid).deliver({ key, contextRef: CORRECT_PREFIX + input.targetRef, payload: { text } })
      return { text, delivery, replayed: delivery.replayed }
    } catch (error) {
      if (error instanceof DeliveryError && error.code === 'unknown') {
        const record = readDeliveryRecord(this.deps.db, key)
        if (record) return { text, delivery: record, replayed: true }
      }
      throw error
    }
  }

  private cardEnvelope(input: MemoryCardClick, prefix: string): MemoryHumanEnvelope {
    if (!input.operatorOpenId || !input.chatId || !input.messageId) throw new MemoryCardAccessError('缺少本次点击的身份或消息，不能处理。')
    const record = readDeliveryRecord(this.deps.db, input.targetRef), target = record && decodeTarget(record.contextRef)
    if (!record || !target || record.remoteId !== input.messageId || target.chatId !== input.chatId) throw new Error('这张卡不属于当前会话或已不是当前版本。')
    const spaceId = record.audience.spaceId
    if (target.actor !== input.operatorOpenId && !this.spaceOwnerOnCard(spaceId, target.chatType, input.operatorOpenId)) {
      throw new MemoryCardAccessError('这张卡只有本人或本空间负责人能操作。')
    }
    const messageId = `${prefix}:${input.targetRef}:${input.operatorOpenId}`
    const message = workRequestMessage({ requestId: messageId, actorId: input.operatorOpenId, actorKind: 'user', text: '', createdAt: this.deps.now(),
      destination: { kind: 'feishu', messageId, chatId: input.chatId, chatType: target.chatType, parentId: input.messageId,
        ...(target.threadId ? { threadId: target.threadId } : {}), ...(target.rootId ? { rootId: target.rootId } : {}) } })
    return { spaceId, message, cardOperator: true }
  }

  /** Group cards: the space owner may decide a member's displayed candidate. DM cards belong to the person alone. */
  private spaceOwnerOnCard(spaceId: string, chatType: 'group' | 'p2p', openId: string | undefined): boolean {
    return chatType === 'group' && this.deps.spaces.roleOf(spaceId, openId) === 'owner'
  }

  private async apply(envelope: MemoryHumanEnvelope, decision: MemoryControl, text: string,
    mutation: () => Committed, afterApply?: () => void): Promise<MemoryFactReceipt> {
    this.assertCurrent(envelope)
    const replay = this.replay(envelope)
    if (replay) return replay
    const key = `memory-result:${envelope.message.messageId}`
    let committed: Committed | undefined
    const service = this.delivery(envelope, () => this.assertCurrent(envelope), () => {
      if (!this.ingress.pending(envelope.message.messageId).length && !this.ingress.claim(envelope.message.messageId,
        envelope.spaceId, envelope.message.senderOpenId!, { memory: true }, this.deps.now())) throw new Error('本条消息已被其他操作处理。')
      this.ingress.commit(envelope.message.messageId, decision, () => JSON.stringify({ kind: 'memory_fact', noteId: committed!.noteId, text, key }), () => {
        committed = mutation()
        afterApply?.()
      })
    }, () => { if (committed) this.deps.runtime.complete(committed.result) })
    try {
      const delivery = await service.deliver({ key, contextRef: `memory-human:${envelope.spaceId}:${envelope.message.messageId}`, payload: { text } })
      return { noteId: committed?.noteId ?? this.replay(envelope)!.noteId, text, delivery, replayed: delivery.replayed }
    } catch (error) {
      // Unknown send already has a committed fact; never change key or repeat the mutation/POST.
      if (error instanceof DeliveryError && error.code === 'unknown') {
        const fact = this.replay(envelope)
        if (fact) return fact
      }
      throw error
    }
  }

  private replay(envelope: MemoryHumanEnvelope): MemoryFactReceipt | undefined {
    this.assertCurrent(envelope)
    const row = this.deps.db.prepare('SELECT result FROM ingress_routes WHERE message_id = ? AND actor_open_id = ? AND space_id = ?')
      .get(envelope.message.messageId, envelope.message.senderOpenId!, envelope.spaceId) as { result: string | null } | undefined
    if (!row?.result) return undefined
    let fact: { kind: string; noteId: number; text: string; key: string }
    try { fact = JSON.parse(row.result) } catch { return undefined }
    const delivery = fact.kind === 'memory_fact' && readDeliveryRecord(this.deps.db, fact.key)
    return delivery ? { noteId: fact.noteId, text: fact.text, delivery, replayed: true } : undefined
  }

  /** A reply to the correction hint counts as a reply to the display it was sent for. */
  private anchorFor(msg: Pick<InboundMessage, 'parentId' | 'senderOpenId'>): string | undefined {
    if (!msg.parentId || !msg.senderOpenId) return msg.parentId
    const hint = this.deps.db.prepare(`SELECT context_ref FROM deliveries WHERE delivery_key LIKE ? AND remote_id = ? AND actor_open_id = ?`)
      .get(CORRECT_PREFIX + '%', msg.parentId, msg.senderOpenId) as { context_ref: string } | undefined
    if (!hint?.context_ref.startsWith(CORRECT_PREFIX)) return msg.parentId
    const display = readDeliveryRecord(this.deps.db, hint.context_ref.slice(CORRECT_PREFIX.length))
    return display?.remoteId ?? msg.parentId
  }

  private target(ref: string, envelope: MemoryHumanEnvelope) {
    try { return this.requireTarget(ref, envelope) } catch { return undefined }
  }
  private requireTarget(ref: string, envelope: MemoryHumanEnvelope) {
    this.assertCurrent(envelope)
    const record = ref.startsWith(PREFIX) ? readDeliveryRecord(this.deps.db, ref) : undefined
    const target = record && decodeTarget(record.contextRef), msg = envelope.message, anchor = this.anchorFor(msg)
    const owner = Boolean(envelope.cardOperator && this.spaceOwnerOnCard(envelope.spaceId, msg.chatType, msg.senderOpenId))
    if (!record || !target || !['sent', 'confirmed'].includes(record.status) || !record.remoteId ||
      (!owner && (record.actorOpenId !== msg.senderOpenId || target.actor !== msg.senderOpenId)) || target.scope !== spaceScope(envelope.spaceId) ||
      record.audience.spaceId !== envelope.spaceId || target.chatId !== msg.chatId || target.chatType !== msg.chatType ||
      (anchor ? record.remoteId !== anchor : target.threadId !== (msg.threadId ?? null) || target.rootId !== (msg.rootId ?? null))) {
      throw new Error('没有本次发言人实际收到的对应记忆版本，请回复那张记忆卡。')
    }
    const note = this.read(target.noteId, envelope)
    if (!note || note.revision !== target.revision || note.status !== 'candidate') throw new Error('候选已更新、删除或确认。')
    const previous = this.previous(note, envelope)
    if (JSON.stringify(target.replacement) !== JSON.stringify(previous ? { id: previous.id, revision: previous.revision } : null) ||
      deliveryPayloadDigest(memoryCandidatePayload(note, previous, ref)) !== record.payloadDigest) throw new Error('展示内容或替代关系已变化。')
    return { note, previous }
  }
  private read(id: number, envelope: MemoryHumanEnvelope): MemoryNote | undefined {
    // Authorized source-managed bodies remain scoped to this operation; never cache them as global authority.
    envelope.readProof?.assertCurrent()
    const note = envelope.readProof?.notes.find(note => note.id === id) ?? this.deps.memory.get(id)
    return note && note.scope === spaceScope(envelope.spaceId) &&
      (!note.source?.chatId || note.source.chatId === envelope.message.chatId) && !note.source?.promotedFrom ? note : undefined
  }
  private previous(note: MemoryNote, envelope: MemoryHumanEnvelope): MemoryNote | undefined {
    if (note.source?.replaces === undefined) return undefined
    const previous = typeof note.source.replaces === 'number' ? this.read(note.source.replaces, envelope) : undefined
    if (!previous || previous.supersededBy && previous.supersededBy !== note.id) throw new Error('被更正的原记忆当前不可读或已另行更正。')
    return previous
  }
  private async authorize(envelope: MemoryHumanEnvelope, ids: readonly number[]): Promise<MemoryHumanEnvelope> {
    this.assertCurrent(envelope)
    if (!ids.length || !this.deps.authorizeNotes) return envelope
    const readProof = await this.deps.authorizeNotes([...new Set(ids)], envelope)
    this.assertCurrent(envelope); readProof.assertCurrent()
    return { ...envelope, readProof }
  }
  private async authorizeTarget(ref: string, envelope: MemoryHumanEnvelope) {
    const record = readDeliveryRecord(this.deps.db, ref), target = record && decodeTarget(record.contextRef)
    return target ? this.authorize(envelope, [target.noteId, ...(target.replacement ? [target.replacement.id] : [])]) : envelope
  }
  private current(envelope: MemoryHumanEnvelope): boolean {
    this.deps.assertActive?.()
    const { message: msg } = envelope, space = this.deps.spaces.get(envelope.spaceId)
    return Boolean(msg.senderType !== 'app' && msg.senderOpenId && msg.messageId && (!envelope.isCurrent || envelope.isCurrent()) &&
      space?.status === 'active' && space.kind === msg.chatType && space.chatId === msg.chatId &&
      (msg.chatType !== 'p2p' || space.id === dmSpaceId(msg.senderOpenId)) &&
      this.deps.spaces.roleOf(space.id, msg.senderOpenId) &&
      this.deps.policy.decide({ spaceId: space.id, openId: msg.senderOpenId, action: 'remember' }).decision === 'allow' &&
      this.deps.policy.decide({ spaceId: space.id, openId: msg.senderOpenId, action: 'read' }).decision === 'allow')
  }
  private assertCurrent(envelope: MemoryHumanEnvelope): void { if (!this.current(envelope)) throw new Error('当前空间、身份或记忆权限已经变化。') }

  private delivery(envelope: MemoryHumanEnvelope, valid: () => void, admit?: () => void, committed?: () => void) {
    const { message: msg } = envelope
    return new DeliveryService(this.deps.db, { ...this.deps, admit, resolveContext: async (): Promise<DeliveryContext | undefined> => {
      valid()
      if (msg.chatType === 'group' && !(await this.deps.feishu.chatMemberOpenIds(msg.chatId, { fresh: true })).has(msg.senderOpenId!)) return undefined
      valid()
      return { actorOpenId: msg.senderOpenId!, audience: msg.chatType === 'p2p' ? { kind: 'dm', spaceId: envelope.spaceId, openId: msg.senderOpenId! }
        : { kind: 'group', spaceId: envelope.spaceId, chatId: msg.chatId, replyToMessageId: msg.parentId ?? msg.messageId, threadId: msg.threadId },
      sources: [{ ref: spaceScope(envelope.spaceId), spaceId: envelope.spaceId, chatId: msg.chatId }],
      isCurrent: () => { try { valid(); return true } catch { return false } }, provenanceComplete: true, expiresAt: this.deps.now() + 60_000 }
    }, send: async ({ payload }) => {
      committed?.() // Delivery's admission savepoint is committed before any AbortController or network side effect.
      const replyId = msg.parentId ?? msg.messageId
      const remoteId = msg.chatType === 'p2p' ? await this.deps.feishu.sendToChat(msg.chatId, payload)
        : 'card' in payload ? (await this.deps.feishu.replyCard(replyId, payload.card, !msg.threadId)).messageId
          : (await this.deps.feishu.replyText(replyId, 'text' in payload ? payload.text : '', !msg.threadId)).messageId
      return { remoteId }
    } })
  }
}

/** Strict exact original-text extraction. Semantic intent belongs to the independent classifier. */
export function preferenceText(text: string, spans: { start: number; end: number }[]): string {
  if (!Array.isArray(spans) || spans.length < 1 || spans.length > 4) throw new Error('偏好原句区间无效。')
  let end = -1
  const parts = spans.map(span => {
    if (!span || Object.keys(span).some(key => key !== 'start' && key !== 'end') || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) ||
      span.start < 0 || span.start < end || span.end <= span.start || span.end > text.length || splitsSurrogate(text, span.start) || splitsSurrogate(text, span.end)) throw new Error('偏好原句区间无效。')
    end = span.end
    const part = text.slice(span.start, span.end).trim()
    if (!part) throw new Error('偏好原句不能为空。')
    return part
  })
  const body = parts.join('\n')
  if (body.length > 1500) throw new Error('偏好原句太长，请拆成单项偏好。')
  return body
}
function splitsSurrogate(text: string, index: number) { return /[\uD800-\uDBFF]/.test(text[index - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[index] ?? '') }
function decodeTarget(ref: string): DisplayTarget | undefined {
  if (!ref.startsWith(TARGET_PREFIX)) return undefined
  try { const t = JSON.parse(ref.slice(TARGET_PREFIX.length)); return t.version === 1 && Number.isSafeInteger(t.noteId) && Number.isSafeInteger(t.revision) ? t : undefined } catch { return undefined }
}
