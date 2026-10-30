import { createHmac, randomBytes } from 'node:crypto'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'

const TTL_MS = 10 * 60_000
export function createRelayState(token: string, now = Date.now(), provider: 'feishu' | 'github' | 'github_token' | 'gmail' | 'desktop' = 'feishu'): string {
  const payload = `${provider === 'desktop' ? 'dp1' : provider === 'gmail' ? 'gm1' : provider === 'github_token' ? 'gp1' : provider === 'github' ? 'gh1' : 'v1'}.${now + TTL_MS}.${randomBytes(16).toString('base64url')}`
  return `${payload}.${createHmac('sha256', token).update(`friday-oauth-state:${payload}`).digest('base64url')}`
}

/** Node 22 fetch does not honor HTTPS_PROXY. Keep this transport explicit, bounded,
 * and without redirects so the bearer cannot be forwarded to another origin. */
export function createRelayFetch(proxyUrl?: string): typeof globalThis.fetch {
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl, { keepAlive: true }) : undefined
  return (async (input, init) => {
    try {
      const res = await axios.request({
        url: String(input), method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        httpsAgent: agent, httpAgent: agent, proxy: false, maxRedirects: 0,
        timeout: 10_000, maxContentLength: 16_384, responseType: 'text',
        validateStatus: () => true, signal: init?.signal ?? undefined,
      })
      return new Response(res.data, { status: res.status })
    } catch {
      // Axios errors carry request headers, including the relay bearer.
      throw new Error('OAuth relay transport unavailable')
    }
  }) as typeof globalThis.fetch
}

export interface RelayClaim {
  code?: string
  error?: string
  pending?: boolean
  expired?: boolean
  completed?: boolean
}
export interface OAuthRelayDeps {
  baseUrl: string
  token: string
  fetch: typeof globalThis.fetch
  now?: () => number
  log: { info(m: string, meta?: unknown): void; warn(m: string, meta?: unknown): void; debug(m: string, meta?: unknown): void }
  onCode(input: { state: string; openId: string; code: string }): Promise<void>
  onDenied(input: { state: string; openId: string; reason: string }): Promise<void>
}

/** No background traffic without a live authorization. A reply is retained by the
 * Worker until handled; acknowledgement retries never repeat token exchange or DM. */
export class OAuthRelay {
  private readonly watching = new Map<string, { openId: string; expiresAt: number; misses: number; handled: boolean }>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking: Promise<void> | undefined
  private readonly now: () => number
  private closed = false

  constructor(private readonly deps: OAuthRelayDeps, private readonly intervalMs = 2000, private readonly ttlMs = TTL_MS) {
    this.now = deps.now ?? Date.now
  }
  watch(state: string, openId: string, expiresAt = this.now() + this.ttlMs): void {
    if (this.closed || this.watching.has(state)) return
    if (expiresAt <= this.now()) return
    this.watching.set(state, { openId, expiresAt, misses: 0, handled: false })
    if (!this.timer) {
      this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
      this.timer.unref?.()
    }
  }
  get size(): number { return this.watching.size }
  private stopIfIdle(): void {
    if (!this.watching.size && this.timer) { clearInterval(this.timer); this.timer = undefined }
  }
  tick(): Promise<void> {
    if (!this.ticking) this.ticking = this.poll().finally(() => { this.ticking = undefined })
    return this.ticking
  }
  private async request(path: string, state: string, method = 'GET'): Promise<Response> {
    return this.deps.fetch(`${this.deps.baseUrl}/${path}?state=${encodeURIComponent(state)}`, {
      method, headers: { authorization: `Bearer ${this.deps.token}` },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
  }
  private async poll(): Promise<void> {
    for (const [state, w] of this.watching) {
      if (this.closed) break
      if (this.now() >= w.expiresAt) { this.watching.delete(state); continue }
      try {
        if (!w.handled) {
          const res = await this.request('relay/claim', state)
          if (this.closed || this.watching.get(state) !== w) continue
          if (res.status === 404) continue
          if (!res.ok && res.status !== 410) throw new Error('relay unavailable')
          const r: RelayClaim = res.status === 410 ? { expired: true } : await res.json() as RelayClaim
          if (this.closed || this.watching.get(state) !== w) continue
          if (r.pending) continue
          if (!r.code && !r.error && !r.expired && !r.completed) throw new Error('invalid relay reply')
          // Claim before effect. An ambiguous send result must not send twice.
          w.handled = true
          try {
            if (r.code) await this.deps.onCode({ state, openId: w.openId, code: r.code })
            else if (!r.completed) await this.deps.onDenied({ state, openId: w.openId,
              reason: r.expired ? '授权链接已经过期了' : '这次没有完成飞书授权' })
          } catch { this.deps.log.warn('relay completion handler failed') }
        }
        if (this.closed) continue
        const ack = await this.request('relay/ack', state, 'POST')
        if (ack.ok || ack.status === 410) this.watching.delete(state)
        else throw new Error('relay acknowledgement unavailable')
      } catch {
        w.misses += 1
        if (w.misses === 1 || w.misses % 30 === 0) this.deps.log.warn('relay request failed', { misses: w.misses })
      }
    }
    this.stopIfIdle()
  }
  close(): void { this.closed = true; this.watching.clear(); this.stopIfIdle() }
}
