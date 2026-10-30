/** Host-only permission for an exact outbound request; never constructed from model claims. */
export interface PublicWebRequestLease {
  url: string
  allowedOrigin: string
  signal?: AbortSignal
  assertCurrent(): void
  linkGrant: Omit<WebLinkGrant, 'fetchedUrl'>
}

/** A URL may itself carry private access. This host receipt grants only the
 * original audience for this reading Run; it is not evidence of publicness. */
export interface WebLinkGrant {
  version: 1
  runId: string
  acpSessionId: string
  spaceId: string
  chatId: string
  chatType: 'group' | 'p2p'
  actorOpenId: string
  messageId: string
  requestUrl: string
  fetchedUrl: string
}

export interface WebLinkTarget {
  runId?: string
  acpSessionId: string | null
  spaceId: string
  chatId: string
  chatType: 'group' | 'p2p'
  actorOpenId: string
}

/** Old public/unknown records never acquire a link grant retrospectively. */
export function hasCurrentWebLinkGrant(source: {
  kind: string; ref: string; access?: string; personalOpenId?: string; linkGrant?: WebLinkGrant
}, target: WebLinkTarget): boolean {
  const grant = source.linkGrant
  if (source.kind !== 'web' || source.access !== 'link' || source.personalOpenId || !grant || grant.version !== 1 ||
      !grant.runId || grant.runId !== target.runId || !grant.acpSessionId || grant.acpSessionId !== target.acpSessionId ||
      !grant.spaceId || grant.spaceId !== target.spaceId || !grant.chatId || grant.chatId !== target.chatId ||
      grant.chatType !== target.chatType || !grant.actorOpenId || grant.actorOpenId !== target.actorOpenId ||
      !grant.messageId || !grant.requestUrl || grant.fetchedUrl !== source.ref) return false
  try {
    const original = new URL(grant.requestUrl), fetched = new URL(grant.fetchedUrl)
    return ['http:', 'https:'].includes(original.protocol) && original.origin === fetched.origin &&
      !original.username && !original.password && !fetched.username && !fetched.password && !original.hash && !fetched.hash
  } catch { return false }
}

export class WebEgressDenied extends Error {
  constructor() {
    super('这次不能把当前资料改写成联网请求。请在本条消息里提供要打开的完整网页链接；不会把已有聊天或资料拼进网址。')
    this.name = 'WebEgressDenied'
  }
}

/** Match a URL actually supplied in the current human message, not quoted history,
 * a forwarded container, a model-produced URL or a vague permission response. */
export function originalWebUrl(text: string, requested: string): string | undefined {
  const normalize = (raw: string): string | undefined => {
    try {
      const url = new URL(raw)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined
      url.hash = '' // A fragment is never part of the outbound HTTP request.
      return url.href
    } catch { return undefined }
  }
  const target = normalize(requested)
  if (!target) return undefined
  // Brackets and parentheses are legal URL characters. Never stop at them: a
  // truncated query prefix would authorize different parameters than the user
  // supplied. Strip only one explicit surrounding prose/Markdown delimiter.
  for (const match of text.matchAll(/https?:\/\/[^\s]+/g)) {
    const before = text[(match.index ?? 0) - 1]
    if (before && /[A-Za-z0-9_]/.test(before)) continue
    let candidate = match[0]
    const closer = ({ '(': ')', '[': ']', '{': '}', '<': '>', '（': '）', '「': '」', '『': '』',
      '"': '"', "'": "'", '`': '`' } as Record<string, string>)[before ?? '']
    if (closer && candidate.endsWith(closer)) candidate = candidate.slice(0, -1)
    if (normalize(candidate) === target) return target
  }
  return undefined
}
