import type { AsUser, HistoryMessage } from '../feishu/client.js'
import type { MemorySourceReference } from './memory-provenance.js'
import type { UserMessageReadLease } from './user-message-read-lease.js'
import { UserMessageReadChanged } from './user-message-read-lease.js'
import type { Spaces } from './space.js'
import { conversationDigest, type ConversationReads, type ConversationReadSource } from './conversation-read-source.js'

/** One request keeps its original identity through paging, cache writes, and capture. */
export interface MessageReadContext {
  as: Readonly<AsUser>
  /** Host application identity for ordinary app reads; never taken from a message sender. */
  appId?: string
  user?: UserMessageReadLease
  bindings?: MessageSourceBindings
  groupsComplete?: boolean
  assertCurrent(): void
}

/** Freeze known source bindings before a platform await; lookup after a rebind cannot relabel the evidence. */
export class MessageSourceBindings {
  private readonly snapshots = new Map<string, ReturnType<MessageSourceBindings['snapshot']>>()
  private readonly used = new Set<string>()
  constructor(private readonly spaces: Pick<Spaces, 'byChat'>, chatIds: readonly string[] = [],
    private readonly assertReadable?: (chatId: string) => void) {
    for (const id of chatIds) this.snapshots.set(id, this.snapshot(id))
  }
  use(chatId: string): void {
    if (!this.snapshots.has(chatId)) this.snapshots.set(chatId, this.snapshot(chatId))
    this.used.add(chatId)
    this.assertCurrent()
  }
  spaceId(chatId: string): string | undefined { this.use(chatId); return this.snapshots.get(chatId)?.id }
  assertCurrent(): void {
    for (const chatId of this.used) {
      this.assertReadable?.(chatId)
      if (JSON.stringify(this.snapshots.get(chatId)) !== JSON.stringify(this.snapshot(chatId))) throw new UserMessageReadChanged()
    }
  }
  private snapshot(chatId: string) {
    const space = this.spaces.byChat(chatId, true)
    return space ? { id: space.id, kind: space.kind, chatId: space.chatId, status: space.status } : null
  }
}
export interface MessageReadReceipt {
  /** Existing group-memory provenance and eligibility; independent of ordinary delivery. */
  sources: MemorySourceReference[]
  complete: boolean
  /** Coverage of actual returned inputs, not completeness of platform history or pagination. */
  conversationReads?: ConversationReads
  assertCurrent(): void
}

/** Identity facts only. This receipt does not promote ordinary reads to memory eligibility. */
function conversationAuthority(read: MessageReadContext): Pick<ConversationReadSource, 'appId' | 'readIdentity'> | undefined {
  const lease = read.user
  if (lease) {
    const { appId, openId, tenantId } = lease.authority
    if (!appId?.trim() || !openId?.trim() || !tenantId?.trim() ||
      read.appId !== undefined && read.appId !== appId || !read.as.userToken || read.as.userToken !== lease.as.userToken) return undefined
    return { appId, readIdentity: { kind: 'user', openId, tenantId } }
  }
  // A missing user lease cannot convert an actual user-token read into an app read.
  return !read.as.userToken && read.appId?.trim() ? { appId: read.appId, readIdentity: { kind: 'app' } } : undefined
}

/** Snapshot only the messages actually returned, after filtering and cache merging. */
export function captureMessageRead(read: MessageReadContext, items: readonly HistoryMessage[],
  coverage: MemorySourceReference['coverage'], spaceForChat: (chatId: string) => string | undefined, now: number): MessageReadReceipt {
  read.assertCurrent()
  const lease = read.user
  const sources: MemorySourceReference[] = []
  const authority = conversationAuthority(read)
  const conversationReads: ConversationReads = { complete: Boolean(authority), items: [] }
  let complete = true
  const groupIds = new Set(lease?.capture.status === 'ready' ? lease.capture.groups.map(chat => chat.chatId) : [])
  for (const item of items) {
    const chatId = item.chatId?.trim() ? item.chatId : undefined
    const spaceId = chatId && (authority || lease && groupIds.has(chatId)) ? spaceForChat(chatId) ?? null : null
    if (authority && chatId && item.messageId?.trim()) {
      conversationReads.items.push({ ...authority, kind: 'message', chatId, spaceId, messageId: item.messageId,
        contentDigest: conversationDigest(item), contentFields: Object.entries(item).filter(([, value]) => value !== undefined).map(([key]) => key) })
    } else conversationReads.complete = false
    if (!lease || !item.chatId || !groupIds.has(item.chatId)) { complete = false; continue }
    sources.push({ ref: `feishu-message:${item.chatId}:${item.messageId}`,
      appId: lease.authority.appId, tenantId: lease.authority.tenantId,
      spaceId, chatId: item.chatId, messageId: item.messageId,
      ...(item.threadId ? { threadId: item.threadId } : {}), ...(item.rootId ? { rootId: item.rootId } : {}),
      readIdentity: { kind: 'user', openId: lease.authority.openId }, readAt: now, coverage,
      // Sender tenant is not the authority tenant. Hash the delivered snapshot, not a newer/raw API body.
      contentDigest: conversationDigest(item),
    })
  }
  read.assertCurrent()
  return { sources, complete, conversationReads, assertCurrent: read.assertCurrent }
}

/** Group directory entries are actual material too; they have no message ID. */
export function captureChatDirectory(read: MessageReadContext,
  items: readonly { chat_id: string; name: string; cached_messages: number }[], now: number): MessageReadReceipt {
  read.assertCurrent()
  const lease = read.user, groups = new Set(lease?.capture.status === 'ready' ? lease.capture.groups.map(chat => chat.chatId) : [])
  const sources: MemorySourceReference[] = []
  const authority = conversationAuthority(read)
  const conversationReads: ConversationReads = { complete: Boolean(authority), items: [] }
  for (const item of items) {
    const chatId = item.chat_id?.trim() ? item.chat_id : undefined
    const spaceId = chatId && (authority || lease && groups.has(chatId)) ? read.bindings?.spaceId(chatId) ?? null : null
    if (authority && chatId) conversationReads.items.push({ ...authority, kind: 'directory', chatId, spaceId,
      contentDigest: conversationDigest(item) })
    else conversationReads.complete = false
    if (!lease || !groups.has(item.chat_id)) continue
    sources.push({ ref: `feishu-chat:${item.chat_id}`, appId: lease.authority.appId, tenantId: lease.authority.tenantId,
      chatId: item.chat_id, spaceId,
      readIdentity: { kind: 'user', openId: lease.authority.openId }, readAt: now, coverage: 'complete',
      contentDigest: conversationDigest(item) })
  }
  read.assertCurrent()
  return { sources, complete: sources.length === items.length, conversationReads, assertCurrent: read.assertCurrent }
}

/** The downloaded bytes keep their parent message's authorization and recall anchor. */
export function captureMessageFile(read: MessageReadContext, message: HistoryMessage, contentDigest: string, now: number): MessageReadReceipt {
  const receipt = captureMessageRead(read, [message], 'complete', chatId => read.bindings?.spaceId(chatId), now)
  const ordinary = receipt.conversationReads, parent = ordinary?.items[0], key = message.fileKey ?? message.imageKey
  const type = message.imageKey && !message.fileKey ? 'image' : 'file'
  const conversationReads: ConversationReads = ordinary && parent?.kind === 'message' && key?.trim() && /^[a-f0-9]{64}$/.test(contentDigest)
    ? { complete: ordinary.complete, items: [{ appId: parent.appId, chatId: parent.chatId, spaceId: parent.spaceId,
      readIdentity: parent.readIdentity, messageId: parent.messageId, kind: 'file', parentDigest: parent.contentDigest,
      resourceDigest: conversationDigest({ messageId: message.messageId, key, type }), contentDigest }] }
    : { complete: false, items: [] }
  read.assertCurrent()
  return { ...receipt, conversationReads, sources: receipt.sources.map(source => ({ ...source,
    ref: `feishu-file:${message.chatId}:${message.messageId}`, contentDigest })) }
}
