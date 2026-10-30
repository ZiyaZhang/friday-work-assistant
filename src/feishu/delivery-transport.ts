import type { DeliveryAudience } from '../core/delivery.js'
import type { FeishuClient, OutboundPayload } from './client.js'

export type FeishuDeliveryTarget =
  | { kind: 'user'; id: string }
  | { kind: 'chat'; id: string }
  | { kind: 'reply'; id: string; inThread: boolean }
type Client = Pick<FeishuClient, 'sendToUser' | 'sendToChat'> & Partial<Pick<FeishuClient, 'replyCard' | 'replyMarkdown' | 'replyText'>>

/** Transport only. Admission, source checks and deduplication remain in
 * DeliveryService; callers retain their exact existing destination. */
export async function sendFeishuPayload(client: Client, target: FeishuDeliveryTarget, payload: OutboundPayload,
  options?: { mentionOpenIds: readonly string[] }): Promise<{ remoteId: string; threadId?: string }> {
  if (target.kind === 'user') return { remoteId: await (options ? client.sendToUser(target.id, payload, options) : client.sendToUser(target.id, payload)) }
  if (target.kind === 'chat') return { remoteId: await (options ? client.sendToChat(target.id, payload, options) : client.sendToChat(target.id, payload)) }
  let sent: { messageId: string; threadId?: string }
  if ('card' in payload) {
    if (!client.replyCard) throw new Error('发送适配器不支持卡片回复')
    sent = await client.replyCard(target.id, payload.card, target.inThread)
  } else if ('markdown' in payload) {
    if (!client.replyMarkdown) throw new Error('发送适配器不支持富文本回复')
    sent = await (options ? client.replyMarkdown(target.id, payload.markdown, target.inThread, options) : client.replyMarkdown(target.id, payload.markdown, target.inThread))
  } else {
    if (!client.replyText) throw new Error('发送适配器不支持文本回复')
    sent = await client.replyText(target.id, payload.text, target.inThread)
  }
  return { remoteId: sent.messageId, ...(sent.threadId ? { threadId: sent.threadId } : {}) }
}

export function feishuDeliveryTarget(audience: DeliveryAudience): FeishuDeliveryTarget {
  return audience.kind === 'dm' ? { kind: 'user', id: audience.openId }
    : audience.replyToMessageId ? { kind: 'reply', id: audience.replyToMessageId, inThread: !audience.threadId }
    : { kind: 'chat', id: audience.chatId }
}
