import type { TodoOrigin } from './todo-provenance.js'

export interface TodoOriginPresentation {
  items: { label: string; url?: string }[]
  notice: string | null
}

/** One pure presentation rule for the card and browser; no evidence lookup or access grant.
 * Self-contained so the same function can be embedded in the existing browser script. */
export function presentTodoOrigin(origin: TodoOrigin | null | undefined): TodoOriginPresentation | null {
  if (!origin) return null
  // A minutes action item cites the minute right after the request that asked for it.
  const inputs = [...(origin.request ? [origin.request] : []), ...(origin.minutes ? [origin.minutes] : []), ...origin.selectedInputs, ...origin.attachments]
  const items: TodoOriginPresentation['items'] = [], seen = new Set<string>()
  let unavailable = false, available = false
  for (const input of inputs) {
    const label = input.label.replace(/\s+/g, ' ').trim()
    if (!label) continue
    let url: string | undefined
    if (input.link.status === 'available') {
      try {
        const parsed = new URL(input.link.url)
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) url = parsed.href
      } catch { /* An unusable link is display text, never a guessed destination. */ }
    }
    const key = JSON.stringify([label, url ?? null])
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ label, ...(url ? { url } : {}) })
    if (url) available = true
    else unavailable = true
  }
  if (!items.length) return null
  return { items, notice: unavailable ? available ? '部分来源链接暂不可用。' : '来源链接暂不可用。' : null }
}
