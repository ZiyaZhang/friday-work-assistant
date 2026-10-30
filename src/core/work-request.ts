/** Host-owned work input. This compatibility stage retains the current delivery
 * destination; it does not admit desktop requests or grant new authority. */
export interface WorkRequest {
  requestId: string
  actorId?: string
  actorKind: 'user' | 'app' | 'bot'
  text: string
  createdAt: number
  destination: {
    kind: 'feishu'
    chatId: string
    chatType: 'group' | 'p2p'
    messageId: string
    threadId?: string
    rootId?: string
    parentId?: string
  }
}
