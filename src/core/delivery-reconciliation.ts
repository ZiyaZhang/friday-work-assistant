/**
 * 独立的只读核对：依据原投递键读取平台实际结果并更新原收据。
 * 不依赖原 Run 存活，不复活它，没有再次发送能力；查看者按当前 Space 状态和实时成员身份核验。
 * 平台无法证明时保持 unknown；正文只比对摘要，收据里不出现原文。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { FeishuClient, HistoryMessage } from '../feishu/client.js'
import { DeliveryError, deliveryPayloadDigest, ensureDeliverySchema, readDeliveryRecord, type DeliveryAudience, type DeliveryRecord, type DeliveryStatus } from './delivery.js'
import type { PolicyService } from './policy.js'
import { dmSpaceId, type Space, type Spaces } from './space.js'

/** Verified by the calling adapter (human console grant or an authorized chat control), never taken from a model argument. */
export interface ReconcileViewer { openId: string; assertCurrent(): void }

export type ReconciliationResult =
  /** Remote message exists in the recorded chat, from the app, with matching content. */
  | 'confirmed'
  /** Remote message exists in the recorded chat from the app, but this payload type has no comparable read-back. */
  | 'acknowledged'
  /** The acknowledged remote ID now resolves to another chat, sender or content. */
  | 'remote_mismatch'
  /** A complete window contained no app message at all. */
  | 'remote_absent'
  /** Nothing matched, but the window listing was truncated. */
  | 'remote_absent_incomplete'
  /** App messages exist in the window whose content cannot be attributed to this delivery. */
  | 'unverifiable'
  /** The platform read failed; nothing was recorded. */
  | 'read_unavailable'

export interface ReconciliationReceipt {
  key: string
  status: DeliveryStatus
  remoteId: string | null
  result: ReconciliationResult | 'already_confirmed'
  checkedAt: number
}

/** Everything commit needs: the exact ledger snapshot the platform result was compared against. */
export interface ReconciliationObservation {
  key: string
  viewerOpenId: string
  /** Snapshot read before the platform call; commit is conditional on it. */
  before: { status: DeliveryStatus; remoteId: string | null; error: string | null; audienceSpaceId: string }
  result: ReconciliationResult | 'already_confirmed'
  remoteId?: string
  window?: { startSec: number; endSec: number; complete: boolean }
}

export interface DeliveryReconciliationDeps {
  spaces: Pick<Spaces, 'get' | 'roleOf'>
  policy: Pick<PolicyService, 'decide'>
  feishu: Pick<FeishuClient, 'getMessage' | 'listChatHistory' | 'chatMemberOpenIds'>
  /** The app's own open_id; when known, app messages from another app are not this delivery. */
  botOpenId?: string
  now?: () => number
}

/** Search window around the original attempt for sends whose acknowledgement was lost. */
const WINDOW_BEFORE_MS = 60_000
const WINDOW_AFTER_MS = 10 * 60_000
const WINDOW_LIMIT = 200

export class DeliveryReconciliation {
  private readonly now: () => number
  constructor(private readonly db: DatabaseSync, private readonly deps: DeliveryReconciliationDeps) {
    this.now = deps.now ?? Date.now
    ensureDeliverySchema(db)
  }

  /** observe + commit for callers without their own receipt transaction. */
  async reconcile(viewer: ReconcileViewer, key: string): Promise<ReconciliationReceipt> {
    return this.commit(await this.observe(viewer, key))
  }

  /** Authorizes the viewer from current state and reads the platform. No ledger write happens here. */
  async observe(viewer: ReconcileViewer, key: string, options: { expectedSpaceId?: string } = {}): Promise<ReconciliationObservation> {
    viewer.assertCurrent()
    const record = readDeliveryRecord(this.db, key)
    // A receipt outside the caller's space is reported as absent there, before any identity detail is checked.
    if (!record || options.expectedSpaceId !== undefined && record.audience.spaceId !== options.expectedSpaceId) throw new DeliveryError('invalid', '找不到发送记录')
    const chatId = await this.authorizeViewer(viewer, record.audience)
    viewer.assertCurrent()
    const before = { status: record.status, remoteId: record.remoteId, error: record.error, audienceSpaceId: record.audience.spaceId }
    if (record.status === 'confirmed') return { key, viewerOpenId: viewer.openId, before, result: 'already_confirmed' }
    if (record.status === 'planned') throw new DeliveryError('unknown', '发送可能仍在进行；先停机核对或恢复中断记录')
    const observed = record.remoteId ? await this.readAcknowledged(record, chatId) : await this.searchWindow(record, chatId)
    viewer.assertCurrent()
    return { key, viewerOpenId: viewer.openId, before, ...observed }
  }

  /** Synchronous receipt update; may run inside a caller's transaction. Never resends. */
  commit(observation: ReconciliationObservation): ReconciliationReceipt {
    const { key, before } = observation
    const checkedAt = this.now()
    if (observation.result === 'already_confirmed' || observation.result === 'read_unavailable') {
      const current = readDeliveryRecord(this.db, key)
      if (!current) throw new DeliveryError('invalid', '找不到发送记录')
      return { key, status: current.status, remoteId: current.remoteId, result: observation.result, checkedAt }
    }
    const note = JSON.stringify({ result: observation.result, checkedAt, viewerOpenId: observation.viewerOpenId,
      ...(observation.remoteId ? { remoteId: observation.remoteId } : {}), ...(observation.window ? { window: observation.window } : {}) })
    // Conditional on the status and remote ID observed; a concurrent change is a conflict, never an overwrite.
    const changed = observation.result === 'confirmed'
      ? this.db.prepare(`UPDATE deliveries SET status = 'confirmed', remote_id = ?, error = NULL, reconciliation = ?, updated_at = ?
          WHERE delivery_key = ? AND status = ? AND remote_id IS ?`)
        .run(observation.remoteId!, note, checkedAt, key, before.status, before.remoteId)
      : this.db.prepare(`UPDATE deliveries SET error = ?, reconciliation = ?, updated_at = ?
          WHERE delivery_key = ? AND status = ? AND remote_id IS ?`)
        .run(observation.result === 'remote_absent' ? 'verified_absent' : before.error, note, checkedAt, key, before.status, before.remoteId)
    if (!Number(changed.changes)) throw new DeliveryError('conflict', '核对期间收据已被其他操作更新，未覆盖')
    const current = readDeliveryRecord(this.db, key)!
    return { key, status: current.status, remoteId: current.remoteId, result: observation.result, checkedAt }
  }

  /** Returns the chat to read. Every check uses the current Space and fresh platform membership, never the original run. */
  private async authorizeViewer(viewer: ReconcileViewer, audience: DeliveryAudience): Promise<string> {
    const target = this.deps.spaces.get(audience.spaceId)
    if (!target || target.status !== 'active') throw new DeliveryError('denied', '目标空间不存在或已停用')
    if (audience.kind === 'group') {
      if (target.kind !== 'group' || target.chatId !== audience.chatId) throw new DeliveryError('denied', '目标群已换绑，原受众不再有效')
    } else if (target.kind !== 'p2p' || target.id !== dmSpaceId(viewer.openId) || audience.openId !== viewer.openId) {
      throw new DeliveryError('denied', '私聊投递只能由收件人本人核对')
    }
    if (!this.deps.spaces.roleOf(target.id, viewer.openId)) throw new DeliveryError('denied', '当前身份不是该空间成员')
    if (this.deps.policy.decide({ spaceId: target.id, openId: viewer.openId, action: 'read' }).decision !== 'allow') throw new DeliveryError('denied', '当前身份不能查看该空间的投递')
    const chatId = chatOf(target, audience)
    if (!chatId) throw new DeliveryError('unconfirmed', '该空间尚未记录可读取的会话')
    if (audience.kind === 'group') {
      let members: Set<string>
      try { members = await this.deps.feishu.chatMemberOpenIds(chatId, { fresh: true }) }
      catch { throw new DeliveryError('unconfirmed', '成员身份暂未能核实') }
      viewer.assertCurrent()
      if (!members.has(viewer.openId)) throw new DeliveryError('unconfirmed', '成员身份暂未能核实')
    }
    return chatId
  }

  private async readAcknowledged(record: DeliveryRecord, chatId: string): Promise<Observation> {
    let message: HistoryMessage | undefined
    try { message = await this.deps.feishu.getMessage(record.remoteId!) }
    catch { return { result: 'read_unavailable' } }
    if (!message) return { result: 'remote_absent' }
    if (message.chatId !== chatId || !this.fromThisApp(message)) return { result: 'remote_mismatch' }
    return { result: this.contentMatches(record, message) ? 'confirmed' : 'acknowledged', remoteId: record.remoteId! }
  }

  private async searchWindow(record: DeliveryRecord, chatId: string): Promise<Observation> {
    const startSec = Math.floor((record.createdAt - WINDOW_BEFORE_MS) / 1000)
    const endSec = Math.ceil((Math.max(record.createdAt, record.updatedAt) + WINDOW_AFTER_MS) / 1000)
    let page
    try { page = await this.deps.feishu.listChatHistory(chatId, startSec, endSec, WINDOW_LIMIT) }
    catch { return { result: 'read_unavailable' } }
    const window = { startSec, endSec, complete: !page.hasMore }
    const fromApp = page.items.filter(item => (!item.chatId || item.chatId === chatId) && this.fromThisApp(item))
    const matches = fromApp.filter(item => this.contentMatches(record, item))
    if (matches.length === 1) return { result: 'confirmed', remoteId: matches[0]!.messageId, window }
    if (!fromApp.length) return { result: page.hasMore ? 'remote_absent_incomplete' : 'remote_absent', window }
    return { result: page.hasMore ? 'remote_absent_incomplete' : 'unverifiable', window }
  }

  private fromThisApp(message: HistoryMessage): boolean {
    if (message.senderType !== 'app') return false
    return !this.deps.botOpenId || !message.senderOpenId || message.senderOpenId === this.deps.botOpenId
  }

  /** Only a plain text payload has a read-back that reproduces the ledger digest. */
  private contentMatches(record: DeliveryRecord, message: HistoryMessage): boolean {
    return message.msgType === 'text' && deliveryPayloadDigest({ text: message.text }) === record.payloadDigest
  }
}

interface Observation { result: ReconciliationResult; remoteId?: string; window?: { startSec: number; endSec: number; complete: boolean } }

function chatOf(target: Space, audience: DeliveryAudience): string | null {
  return audience.kind === 'group' ? audience.chatId : target.chatId
}
