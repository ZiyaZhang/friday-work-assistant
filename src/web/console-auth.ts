import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { ConsoleSessionStore, type ConsoleActor } from '../core/console-sessions.js'
import { buildAuthorizeUrl, type TokenExchange } from '../feishu/oauth.js'

export type { ConsoleActor } from '../core/console-sessions.js'
export interface ConsoleAuthOptions {
  db: DatabaseSync
  provider: {
    exchangeCode(code: string, redirectUri: string): Promise<TokenExchange>
    whoAmI(token: string): Promise<{ openId?: string; tenantKey?: string; name?: string }>
  }
  appId: string
  domain: 'feishu' | 'lark'
  baseUrl: string
  tenantKeys: readonly string[]
  now?: () => number
  /** Only explicit local development may use HTTP, and only for loopback origins. */
  allowInsecureLoopback?: boolean
}

export class ConsoleAuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'ConsoleAuthError' }
}

interface PendingLogin { nonceHash: string; expiresAt: number; claimed: boolean; previous?: ConsoleActor }
const LOGIN_MS = 10 * 60_000
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

/** Human login routes. They neither accept Agent Bearer tokens nor save user_access_token. */
export class ConsoleAuth {
  readonly sessions: ConsoleSessionStore
  readonly origin: string
  readonly sessionCookieName: string
  readonly nonceCookieName: string
  private readonly now: () => number
  private readonly secure: boolean
  private readonly pending = new Map<string, PendingLogin>()
  private readonly callbackUrl: string

  constructor(private readonly opts: ConsoleAuthOptions) {
    const url = new URL(opts.baseUrl)
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (url.username || url.password || url.search || url.hash || !['/', '/console', '/console/'].includes(url.pathname) ||
      (url.protocol !== 'https:' && !(opts.allowInsecureLoopback === true && local && url.protocol === 'http:'))) {
      throw new Error('Console base URL requires HTTPS (explicit loopback development excepted)')
    }
    if (!opts.appId.trim() || !opts.tenantKeys.length || opts.tenantKeys.some(key => !key.trim())) throw new Error('Console app and tenant allowlist are required')
    this.now = opts.now ?? Date.now
    this.origin = url.origin
    this.secure = url.protocol === 'https:'
    this.sessionCookieName = this.secure ? '__Host-friday_console' : 'friday_console_dev'
    this.nonceCookieName = this.secure ? '__Host-friday_login' : 'friday_login_dev'
    this.callbackUrl = `${this.origin}/console/auth/callback`
    this.sessions = new ConsoleSessionStore(opts.db, { now: this.now })
  }

  authenticate(req: IncomingMessage): ConsoleActor {
    const token = cookie(req, this.sessionCookieName)
    const actor = token ? this.sessions.authenticate(token) : undefined
    if (!actor) throw new ConsoleAuthError(401, 'login_required', '请先登录后台。')
    this.assertCurrent(actor)
    return actor
  }

  assertCurrent(actor: ConsoleActor): void {
    if (actor.appId !== this.opts.appId || !this.opts.tenantKeys.includes(actor.tenantKey) || !this.sessions.isCurrent(actor)) {
      throw new ConsoleAuthError(401, 'session_expired', '登录已失效，请重新登录。')
    }
  }

  requireMutation(req: IncomingMessage, actor: ConsoleActor): void {
    this.assertCurrent(actor)
    const csrf = req.headers['x-csrf-token']
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method ?? '') || req.headers.origin !== this.origin ||
      req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
      typeof csrf !== 'string' || !this.sessions.acceptsCsrf(actor, csrf)) {
      throw new ConsoleAuthError(403, 'csrf_rejected', '请求来源无效，请在后台页面重新操作。')
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', this.origin)
    const route = `${req.method} ${url.pathname}`
    if (!['GET /console/auth/start', 'GET /console/auth/callback', 'GET /console/api/me', 'POST /console/api/logout'].includes(route)) return false
    try {
      if (route === 'GET /console/auth/start') this.start(req, res)
      else if (route === 'GET /console/auth/callback') await this.callback(req, res, url)
      else {
        const actor = this.authenticate(req)
        if (route === 'GET /console/api/me') json(res, 200, { actor, csrfToken: this.sessions.csrfFor(actor) })
        else {
          this.requireMutation(req, actor)
          await emptyJson(req)
          this.assertCurrent(actor)
          this.sessions.revoke(actor.sessionId)
          this.cancelPending(cookie(req, this.nonceCookieName), actor.sessionId)
          res.setHeader('set-cookie', [this.cookie(this.sessionCookieName, '', 0), this.cookie(this.nonceCookieName, '', 0)])
          json(res, 200, { ok: true })
        }
      }
    } catch (error) {
      const safe = error instanceof ConsoleAuthError ? error : new ConsoleAuthError(502, 'login_unavailable', '登录暂不可用，请重新登录。')
      json(res, safe.status, { error: safe.message, code: safe.code })
    }
    return true
  }

  private start(req: IncomingMessage, res: ServerResponse): void {
    this.cancelPending(cookie(req, this.nonceCookieName))
    for (const [key, value] of this.pending) if (value.expiresAt <= this.now()) this.pending.delete(key)
    const token = cookie(req, this.sessionCookieName)
    const previous = token ? this.sessions.authenticate(token) : undefined
    if (previous) this.assertCurrent(previous)
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url')
    this.pending.set(digest(state), { nonceHash: digest(nonce), expiresAt: this.now() + LOGIN_MS, claimed: false, previous })
    res.setHeader('set-cookie', this.cookie(this.nonceCookieName, nonce, LOGIN_MS / 1000))
    redirect(res, buildAuthorizeUrl({ appId: this.opts.appId, domain: this.opts.domain, redirectUri: this.callbackUrl,
      scopes: ['contact:user.base:readonly'], state }))
  }

  private async callback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const state = single(url, 'state'), code = single(url, 'code'), nonce = cookie(req, this.nonceCookieName)
    const key = digest(state), attempt = this.pending.get(key)
    if (!code || !state || !nonce || !attempt || attempt.claimed || attempt.expiresAt <= this.now() || attempt.nonceHash !== digest(nonce)) {
      throw new ConsoleAuthError(400, 'invalid_login', '登录链接已失效，请重新登录。')
    }
    // Claim before the first platform await. A second callback can never exchange this code again.
    attempt.claimed = true
    try {
      this.assertPending(req, key, attempt)
      const token = await this.opts.provider.exchangeCode(code, this.callbackUrl)
      this.assertPending(req, key, attempt)
      if (!token.accessToken) throw new ConsoleAuthError(502, 'identity_unverified', '无法核验登录账号，请重新登录。')
      const me = await this.opts.provider.whoAmI(token.accessToken)
      this.assertPending(req, key, attempt)
      if (!validId(me.openId) || !validId(me.tenantKey) || !this.opts.tenantKeys.includes(me.tenantKey)) {
        throw new ConsoleAuthError(403, 'identity_unverified', '这个账号暂不能登录后台。')
      }
      if (attempt.previous && (attempt.previous.openId !== me.openId || attempt.previous.tenantKey !== me.tenantKey)) {
        throw new ConsoleAuthError(403, 'identity_mismatch', '授权账号与当前登录账号不一致，请先退出后再更换账号。')
      }
      const created = this.sessions.create({ appId: this.opts.appId, tenantKey: me.tenantKey, openId: me.openId,
        name: typeof me.name === 'string' ? me.name.slice(0, 200) : null }, attempt.previous)
      res.setHeader('set-cookie', [this.cookie(this.sessionCookieName, created.token, Math.floor((created.actor.expiresAt - this.now()) / 1000)),
        this.cookie(this.nonceCookieName, '', 0)])
      redirect(res, `${this.origin}/console`)
    } finally {
      if (this.pending.get(key) === attempt) this.pending.delete(key)
    }
  }

  private assertPending(req: IncomingMessage, key: string, attempt: PendingLogin): void {
    if (this.pending.get(key) !== attempt || attempt.expiresAt <= this.now()) throw new ConsoleAuthError(400, 'invalid_login', '登录链接已失效，请重新登录。')
    if (attempt.previous) {
      this.assertCurrent(attempt.previous)
      if (this.authenticate(req).sessionId !== attempt.previous.sessionId) throw new ConsoleAuthError(401, 'session_changed', '登录账号已变化，请重新登录。')
    }
  }

  private cancelPending(nonce?: string, sessionId?: string): void {
    for (const [key, attempt] of this.pending) {
      if (nonce && attempt.nonceHash === digest(nonce) || sessionId && attempt.previous?.sessionId === sessionId) this.pending.delete(key)
    }
  }

  private cookie(name: string, value: string, maxAge: number): string {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`
  }
}

function validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value) }
function single(url: URL, key: string): string { const values = url.searchParams.getAll(key); return values.length === 1 ? values[0]! : '' }
function cookie(req: IncomingMessage, name: string): string | undefined {
  const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`))
  if (values.length > 1) throw new ConsoleAuthError(401, 'invalid_cookie', '登录凭据无效，请重新登录。')
  return values[0]?.slice(name.length + 1)
}
function headers(res: ServerResponse): void {
  res.setHeader('cache-control', 'no-store')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-content-type-options', 'nosniff')
}
function redirect(res: ServerResponse, location: string): void { headers(res); res.writeHead(303, { location }); res.end() }
function json(res: ServerResponse, status: number, body: unknown): void { headers(res); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
async function emptyJson(req: IncomingMessage): Promise<void> {
  let body = ''
  for await (const chunk of req) {
    body += String(chunk)
    if (Buffer.byteLength(body) > 1024) throw new ConsoleAuthError(413, 'invalid_body', '请求内容过大。')
  }
  try { const value = JSON.parse(body); if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new Error() }
  catch { throw new ConsoleAuthError(400, 'invalid_body', '请求需要空 JSON 对象。') }
}
