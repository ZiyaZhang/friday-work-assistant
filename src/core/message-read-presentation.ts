import type { AsUser, FeishuClient, HistoryMessage } from '../feishu/client.js'
import { messageSourceLink } from '../feishu/message-links.js'
import { providerAccessFailure } from './access-failure.js'
import type { MessageCache } from './message-cache.js'

export type MessageSourceLink = { status: 'available'; url: string } | {
  status: 'unavailable'; reason: 'missing_location' | 'lookup_failed' | 'lookup_budget' | 'identity_mismatch'
}

export interface MessageReadPresentationOptions {
  feishu: Pick<FeishuClient, 'getMessage'>
  cache: Pick<MessageCache, 'get' | 'rememberLocation'>
  as: AsUser
  domain?: 'feishu' | 'lark'
  assertCurrent(): void
  /** Exact GET results already obtained under this same request's read lease. */
  fetchedMessages?: readonly HistoryMessage[]
  /** Per returned page, not a limit on messages or on already available links. */
  maxLookups?: number
}

/** Call after capturing the original read receipt. sourceLink is display metadata,
 * not a field returned by message.get and must never enter the content digest.
 * Old complete cache windows need an exact GET: refilling the same time window
 * otherwise does nothing. Bound this optional work and reuse each lookup once.
 */
export async function prepareMessageReadPresentation<T extends HistoryMessage>(items: readonly T[],
  options: MessageReadPresentationOptions): Promise<{
    items: (T & { sourceLink: MessageSourceLink })[]
    linkCoverage: { lookupBudget: number; lookups: number; available: number; unavailable: number; deferred: number }
  }> {
  const budget = options.maxLookups ?? 20
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > 20) throw new Error('Message link lookup budget must be between 0 and 20')
  options.assertCurrent()
  const fetched = new Map(options.fetchedMessages?.map(item => [JSON.stringify([item.chatId, item.messageId]), item]))
  const resolved = new Map<string, MessageSourceLink>()
  let lookups = 0
  const result: (T & { sourceLink: MessageSourceLink })[] = []
  for (const item of items) {
    options.assertCurrent()
    const key = JSON.stringify([item.chatId, item.messageId])
    let sourceLink = resolved.get(key)
    if (!sourceLink) {
      const cached = options.cache.get(item.messageId)
      const currentGet = fetched.get(key)
      const url = messageSourceLink(item, options.domain) ?? (currentGet && messageSourceLink(currentGet, options.domain)) ?? (item.chatId && cached?.chatId === item.chatId
        ? messageSourceLink(cached, options.domain) : undefined)
      if (url) sourceLink = { status: 'available', url }
      else if (!item.chatId || !item.messageId) sourceLink = { status: 'unavailable', reason: 'missing_location' }
      else if (currentGet) sourceLink = { status: 'unavailable', reason: 'missing_location' }
      else if (lookups >= budget) sourceLink = { status: 'unavailable', reason: 'lookup_budget' }
      else {
        lookups += 1
        let current: HistoryMessage | undefined
        try { current = await options.feishu.getMessage(item.messageId, options.as) }
        catch (error) {
          options.assertCurrent()
          // Optional location lookup can fail independently of an already admitted
          // body. Unknown programming failures must remain visible to the host.
          if (providerAccessFailure(error, options.as.userToken ? 'user' : 'app')?.reason !== 'service_unavailable') throw error
          sourceLink = { status: 'unavailable', reason: 'lookup_failed' }
        }
        options.assertCurrent()
        if (!sourceLink) {
          if (!current) sourceLink = { status: 'unavailable', reason: 'missing_location' }
          else if (current.messageId !== item.messageId || current.chatId !== item.chatId) {
            sourceLink = { status: 'unavailable', reason: 'identity_mismatch' }
          } else {
            const found = messageSourceLink(current, options.domain)
            if (found) {
              options.cache.rememberLocation(item.messageId, item.chatId, current)
              sourceLink = { status: 'available', url: found }
            } else sourceLink = { status: 'unavailable', reason: 'missing_location' }
          }
        }
      }
      resolved.set(key, sourceLink)
    }
    result.push({ ...item, sourceLink })
  }
  options.assertCurrent()
  const available = result.filter(item => item.sourceLink.status === 'available').length
  return { items: result, linkCoverage: { lookupBudget: budget, lookups, available, unavailable: result.length - available,
    deferred: result.filter(item => item.sourceLink.status === 'unavailable' && item.sourceLink.reason === 'lookup_budget').length } }
}
