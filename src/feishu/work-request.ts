import type { WorkRequest } from '../core/work-request.js'
import type { InboundMessage } from './mention.js'

/** The only legacy envelope constructor for non-message work. Keep provenance,
 * caller validation and task receipts at their existing admission sites. */
export function workRequestMessage(request: WorkRequest): InboundMessage {
  const { destination } = request
  return {
    eventId: request.requestId, messageId: destination.messageId,
    chatId: destination.chatId, chatType: destination.chatType,
    senderOpenId: request.actorId, senderType: request.actorKind,
    msgType: 'text', text: request.text, mentions: [], createTimeMs: request.createdAt,
    ...(destination.threadId !== undefined ? { threadId: destination.threadId } : {}),
    ...(destination.rootId !== undefined ? { rootId: destination.rootId } : {}),
    ...(destination.parentId !== undefined ? { parentId: destination.parentId } : {}),
  }
}
