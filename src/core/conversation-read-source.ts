import { createHash } from 'node:crypto'
import type { AsUser, FeishuClient, HistoryMessage } from '../feishu/client.js'
import { accessFailure, providerAccessFailure, type AccessFailure } from './access-failure.js'
import type { MemorySourceReference } from './memory-provenance.js'

/** Host-recorded inputs, independent of eligibility for persistent personal memory. */
export type ConversationReadSource = {
  appId: string
  chatId: string
  spaceId: string | null
  readIdentity: { kind: 'user'; openId: string; tenantId: string } | { kind: 'app' }
} & (
  | { kind: 'message'; messageId: string; contentDigest: string; contentFields?: string[] }
  | { kind: 'directory'; contentDigest: string }
  | { kind: 'file'; messageId: string; parentDigest: string; resourceDigest: string; contentDigest: string }
)

export interface ConversationReads { complete: boolean; items: ConversationReadSource[] }

export function conversationSourceKey(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}
export function conversationDigest(value: unknown): string {
  return createHash('sha256').update(conversationSourceKey(value)).digest('hex')
}

export function validConversationReads(value: unknown): value is ConversationReads {
  if (!value || typeof value !== 'object') return false
  const reads = value as ConversationReads
  const nonempty = (value: unknown) => typeof value === 'string' && Boolean(value.trim())
  const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  const fields = (item: ConversationReadSource) => item.kind !== 'message' || item.contentFields === undefined ||
    Array.isArray(item.contentFields) && item.contentFields.every(nonempty) &&
    ['messageId', 'chatId', 'text', 'msgType', 'createTimeMs', 'senderName', 'senderType'].every(key => item.contentFields!.includes(key))
  return typeof reads.complete === 'boolean' && Array.isArray(reads.items) && reads.items.every(item =>
    item && nonempty(item.appId) && nonempty(item.chatId) && (item.spaceId === null || nonempty(item.spaceId)) &&
    (item.readIdentity?.kind === 'app' || item.readIdentity?.kind === 'user' && nonempty(item.readIdentity.openId) && nonempty(item.readIdentity.tenantId)) &&
    digest(item.contentDigest) && fields(item) && (item.kind === 'directory' || item.kind === 'message' && nonempty(item.messageId) ||
      item.kind === 'file' && nonempty(item.messageId) && digest(item.parentDigest) && digest(item.resourceDigest)))
}

/** Capture can produce both receipts for the same input. Ordinary reuse of that
 * exact input does not require permission to save it as long-term memory. Actual
 * saved memory revisions remain subject to the memory runtime's own admission.
 */
export function conversationCoversMemorySource(reads: ConversationReads | undefined, source: MemorySourceReference): boolean {
  return reads?.complete === true && reads.items.some(item => {
    if (item.readIdentity.kind !== 'user' || source.readIdentity.kind !== 'user' ||
      item.readIdentity.openId !== source.readIdentity.openId || item.readIdentity.tenantId !== source.tenantId ||
      item.appId !== source.appId || item.chatId !== source.chatId || item.spaceId !== source.spaceId || item.contentDigest !== source.contentDigest) return false
    const ref = item.kind === 'directory' ? `feishu-chat:${item.chatId}` :
      `feishu-${item.kind}:${item.chatId}:${item.messageId}`
    return ref === source.ref && (item.kind === 'directory' ? source.messageId === undefined : source.messageId === item.messageId)
  })
}

/** A group directory has no authority over an absent conversation. Revalidate
 * every recorded message there, with the same reader, before using its snapshot.
 * Directory entries and downloaded bytes cannot borrow a message's permission.
 */
export async function verifyConversationMessages(reads: ConversationReads | undefined, chatId: string, options: {
  appId: string
  openId: string
  tenantId: string
  as: AsUser
  feishu: Pick<FeishuClient, 'getMessage'>
  assertCurrent(): void
}): Promise<AccessFailure | undefined> {
  options.assertCurrent()
  const failure = () => accessFailure('source_unverifiable', { identity: 'user' })
  if (!validConversationReads(reads) || !reads.complete || !options.as.userToken) return failure()
  const items = reads.items.filter(item => item.chatId === chatId)
  if (!items.length || items.some(item => item.kind !== 'message' || item.appId !== options.appId ||
    item.readIdentity.kind !== 'user' || item.readIdentity.openId !== options.openId || item.readIdentity.tenantId !== options.tenantId)) return failure()
  const snapshots = new Map<string, HistoryMessage | undefined>()
  for (const item of items) {
    if (item.kind !== 'message') return failure()
    if (!snapshots.has(item.messageId)) {
      let message
      try { message = await options.feishu.getMessage(item.messageId, options.as) }
      catch (error) {
        options.assertCurrent()
        const known = providerAccessFailure(error, 'user')
        if (known) return known
        throw error
      }
      options.assertCurrent()
      snapshots.set(item.messageId, message)
    }
    const message = snapshots.get(item.messageId)
    // A cache result may contain fewer fields than a current GET. Verify every
    // field actually seen; additional current metadata was never old model input.
    const snapshot = message && item.contentFields
      ? Object.fromEntries(item.contentFields.map(key => [key, (message as unknown as Record<string, unknown>)[key]])) : message
    if (!message || message.messageId !== item.messageId || message.chatId !== chatId || conversationDigest(snapshot) !== item.contentDigest) return failure()
  }
  options.assertCurrent()
}
