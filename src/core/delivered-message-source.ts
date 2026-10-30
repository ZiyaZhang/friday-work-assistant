/** A host-confirmed outgoing message, confined to its original space and recipient.
 * This is distinct from reading arbitrary platform messages with app credentials. */
export interface DeliveredMessageSource {
  ref: string
  deliveryKey: string
  messageId: string
  tenantId: string
  appId: string
  spaceId: string
  chatId: string
  chatType: 'group' | 'p2p'
  targetOpenId: string
  contentDigest: string
}

export interface DeliveredMessageBinding {
  appId: string; actorOpenId: string; spaceId: string; chatId: string; chatType: 'group' | 'p2p'
}

/** The injected host reader verifies the actual source text and sent/confirmed ACK.
 * Both execution and delivery use this same synchronous proof at every boundary. */
export type VerifyDeliveredMessage = (source: DeliveredMessageSource) => boolean
export function hasCurrentDeliveredMessages(sources: readonly DeliveredMessageSource[] | undefined,
  binding: DeliveredMessageBinding, verify?: VerifyDeliveredMessage): boolean {
  if (sources === undefined) return true
  if (!Array.isArray(sources)) return false
  return sources.every(source => Boolean(source && verify &&
    [source.ref, source.deliveryKey, source.messageId, source.tenantId, source.appId, source.spaceId, source.chatId, source.targetOpenId]
      .every(value => typeof value === 'string' && value.length > 0) &&
    typeof source.contentDigest === 'string' && /^[a-f0-9]{64}$/.test(source.contentDigest) &&
    source.appId === binding.appId && source.targetOpenId === binding.actorOpenId && source.spaceId === binding.spaceId &&
    source.chatId === binding.chatId && source.chatType === binding.chatType && verify(source)))
}
