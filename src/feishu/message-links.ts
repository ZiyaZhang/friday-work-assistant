/** Position-based message links follow the official Lark CLI implementation:
 * https://github.com/larksuite/cli/blob/ceace6d9349f827a5f5a646aac51e2c5ef428d48/shortcuts/im/convert_lib/content_convert.go
 * These fields must come from the returned message item, not inferred from an om_ ID. */
export interface MessageLinkSource {
  messageAppLink?: string
  chatId?: string
  threadId?: string
  messagePosition?: string | number
  threadMessagePosition?: string | number
}

/** Preserve integer positions exactly, including the platform's -1 thread-root sentinel. */
export function messagePosition(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return /^-?(?:0|[1-9]\d*)$/.test(text) ? text : undefined
}

export function messageSourceLink(source: MessageLinkSource, domain: 'feishu' | 'lark' = 'feishu'): string | undefined {
  const host = domain === 'lark' ? 'applink.larksuite.com' : 'applink.feishu.cn'
  if (source.messageAppLink) {
    try {
      const url = new URL(source.messageAppLink)
      if (url.protocol === 'https:' && url.host === host && !url.username && !url.password &&
        isMessageLocation(url, source)) return url.href
    } catch { /* A malformed provider field cannot replace real position evidence. */ }
  }
  if (!source.chatId?.trim()) return undefined
  const threadPosition = messagePosition(source.threadMessagePosition)
  const position = messagePosition(source.messagePosition)
  if (source.threadId?.trim() && threadPosition !== undefined) {
    const url = new URL(`https://${host}/client/thread/open`)
    // The official client contract sends both spellings for desktop and mobile.
    for (const key of ['openthreadid', 'open_thread_id']) url.searchParams.set(key, source.threadId)
    for (const key of ['openchatid', 'open_chat_id']) url.searchParams.set(key, source.chatId)
    url.searchParams.set('thread_position', threadPosition)
    return url.href
  }
  if (position === undefined) return undefined
  const url = new URL(`https://${host}/client/chat/open`)
  url.searchParams.set('openChatId', source.chatId)
  url.searchParams.set('position', position)
  return url.href
}

/** A chat home or unrelated client AppLink is not evidence of a message location. */
function isMessageLocation(url: URL, source: MessageLinkSource): boolean {
  if (url.pathname === '/client/message/link/open') return Boolean(url.searchParams.get('token')?.trim())
  if (url.pathname === '/client/chat/open') {
    const chat = url.searchParams.get('openChatId')
    return Boolean(chat?.trim() && (!source.chatId || source.chatId === chat) &&
      messagePosition(url.searchParams.get('position')) !== undefined)
  }
  if (url.pathname === '/client/thread/open') {
    const chat = url.searchParams.get('open_chat_id') ?? url.searchParams.get('openchatid')
    const thread = url.searchParams.get('open_thread_id') ?? url.searchParams.get('openthreadid')
    return Boolean(chat?.trim() && thread?.trim() && (!source.chatId || source.chatId === chat) &&
      (!source.threadId || source.threadId === thread) && messagePosition(url.searchParams.get('thread_position')) !== undefined &&
      (!url.searchParams.has('openchatid') || url.searchParams.get('openchatid') === chat) &&
      (!url.searchParams.has('openthreadid') || url.searchParams.get('openthreadid') === thread))
  }
  return false
}
