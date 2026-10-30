import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { createRelayState } from '../feishu/oauth-relay.js'

export const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly'
export const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send'
const ATTEMPT_TTL = 10 * 60_000
export interface GmailConfig { clientId: string; clientSecret: string; redirectUri: string; relayToken: string }
export interface GmailView {
  status: 'disconnected' | 'connected' | 'needs_connection'; revision: number
  accountId?: string; email?: string; canSend: boolean; connectedAt?: number
}
interface Credential { access: string; refresh: string; expires: number; scopes: string[] }
interface CredentialLease { credential: Credential; tokenVersion: number }
interface Grant extends GmailView { owner: string; secret: string; tokenVersion: number }
interface Attempt { state: string; owner: string; revision: number; secret: string; expires: number; claimed: number }
export class GmailError extends Error {
  constructor(readonly status: number, message: string, readonly providerRejectedSend = false) { super(message); this.name = 'GmailError' }
}
export type GmailHttp = (path: string, input: { token?: string; method?: 'GET' | 'POST'; form?: Record<string, string>; body?: unknown; signal?: AbortSignal }) => Promise<{ status: number; data: unknown }>

export function loadGmailConfig(relay: { baseUrl: string; token: string } | undefined, env: NodeJS.ProcessEnv = process.env): GmailConfig | undefined {
  const clientId = env.FRIDAY_GOOGLE_CLIENT_ID?.trim(), clientSecret = env.FRIDAY_GOOGLE_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret || !relay) return undefined
  const url = new URL(relay.baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.hash || url.search) throw new Error('Gmail requires an HTTPS callback origin')
  return { clientId, clientSecret, redirectUri: `${url.origin}/gmail/callback`, relayToken: relay.token }
}

/** Fixed Google destinations. The model never supplies a host or sees a credential. */
export function createGmailHttp(proxyUrl?: string): GmailHttp {
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl, { keepAlive: true }) : undefined
  return async (path, input) => {
    const url = path === '/token' ? 'https://oauth2.googleapis.com/token'
      : path === '/identity' ? 'https://openidconnect.googleapis.com/v1/userinfo'
      : `https://gmail.googleapis.com/gmail/v1/users/me${path}`
    if (!['/token', '/identity'].includes(path) && (!/^\/(?:profile|messages|threads|history)(?:[/?]|$)/.test(path) ||
      /[\\#\r\n]/.test(path) || new URL(url).href !== url)) throw new GmailError(400, '邮件请求地址无效。')
    try {
      const result = await axios.request({ url, method: input.method ?? (input.form ? 'POST' : 'GET'),
        headers: { accept: 'application/json', ...(input.token ? { authorization: `Bearer ${input.token}` } : {}) },
        ...(input.form ? { data: new URLSearchParams(input.form) } : input.body ? { data: input.body } : {}),
        proxy: false, httpsAgent: agent, timeout: 20_000, maxRedirects: 0, maxContentLength: 4 * 1024 * 1024,
        signal: input.signal, validateStatus: () => true })
      return { status: result.status, data: result.data }
    } catch { throw new GmailError(503, 'Gmail 暂时无法连接，请稍后查看状态。') }
  }
}

export function ensureGmailSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS gmail_connections (
    owner TEXT PRIMARY KEY,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,
    account_id TEXT,email TEXT,connected_at INTEGER,can_send INTEGER NOT NULL DEFAULT 0,
    secret TEXT NOT NULL DEFAULT '',token_version INTEGER NOT NULL DEFAULT 0
  ); CREATE TABLE IF NOT EXISTS gmail_attempts (
    state TEXT PRIMARY KEY,owner TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,
    secret TEXT NOT NULL,expires INTEGER NOT NULL,claimed INTEGER NOT NULL DEFAULT 0
  );`)
}

/** Only authenticated entry points supply owner. Email addresses cannot grant access. */
export class GmailConnections {
  private readonly refreshing = new Map<string, Promise<CredentialLease>>()
  onBegin?: (state: string, owner: string, expires: number) => void
  constructor(private readonly d: { db: DatabaseSync; key: Buffer; config?: GmailConfig; http: GmailHttp; now?: () => number }) {
    ensureGmailSchema(d.db)
    if (d.key.length !== 32) throw new Error('Invalid connection encryption key')
  }
  private now() { return this.d.now?.() ?? Date.now() }
  get available() { return Boolean(this.d.config) }
  private grant(owner: string): Grant | undefined {
    const r = this.d.db.prepare('SELECT * FROM gmail_connections WHERE owner=?').get(owner)
    return r ? { owner, status: r.status as Grant['status'], revision: Number(r.revision), accountId: r.account_id ? String(r.account_id) : undefined,
      email: r.email ? String(r.email) : undefined, connectedAt: r.connected_at ? Number(r.connected_at) : undefined,
      canSend: Boolean(r.can_send), secret: String(r.secret), tokenVersion: Number(r.token_version) } : undefined
  }
  view(owner: string): GmailView {
    const r = this.grant(owner)
    if (!r) return { status: 'disconnected', revision: 0, canSend: false }
    const { owner: _owner, secret: _secret, tokenVersion: _version, ...view } = r
    return view
  }
  connectedOwners(): string[] { return this.d.db.prepare("SELECT owner FROM gmail_connections WHERE status='connected'").all().map(r => String(r.owner)) }
  private encrypt(owner: string, purpose: string, data: unknown): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.d.key, iv)
    cipher.setAAD(Buffer.from(`gmail:${purpose}:${owner}`))
    const bytes = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()])
    return [iv, cipher.getAuthTag(), bytes].map(b => b.toString('base64url')).join('.')
  }
  private decrypt<T>(owner: string, purpose: string, secret: string): T {
    try {
      const [iv, tag, bytes] = secret.split('.').map(value => Buffer.from(value, 'base64url'))
      const cipher = createDecipheriv('aes-256-gcm', this.d.key, iv!)
      cipher.setAAD(Buffer.from(`gmail:${purpose}:${owner}`)); cipher.setAuthTag(tag!)
      return JSON.parse(Buffer.concat([cipher.update(bytes!), cipher.final()]).toString()) as T
    } catch { throw new GmailError(401, 'Gmail 连接已失效，请重新连接。') }
  }
  begin(owner: string, allowSend = false): { url: string; expires: number } {
    const config = this.d.config
    if (!owner || !config) throw new GmailError(503, 'Gmail 连接尚未配置完成。')
    const state = createRelayState(config.relayToken, this.now(), 'gmail'), expires = this.now() + ATTEMPT_TTL
    const verifier = randomBytes(32).toString('base64url')
    const scopes = ['openid', 'email', GMAIL_READ, ...(allowSend ? [GMAIL_SEND] : [])]
    this.d.db.prepare('DELETE FROM gmail_attempts WHERE expires<=? OR owner=?').run(this.now(), owner)
    this.d.db.prepare('INSERT INTO gmail_attempts(state,owner,revision,secret,expires) VALUES (?,?,?,?,?)')
      .run(state, owner, this.view(owner).revision, this.encrypt(owner, 'attempt', { verifier, scopes, allowSend }), expires)
    const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code',
      scope: scopes.join(' '), access_type: 'offline', prompt: 'consent select_account', state,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') })
    this.onBegin?.(state, owner, expires)
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, expires }
  }
  pending(): { state: string; owner: string; expires: number }[] {
    return this.d.db.prepare('SELECT state,owner,expires FROM gmail_attempts WHERE claimed=0 AND expires>?').all(this.now())
      .map(r => ({ state: String(r.state), owner: String(r.owner), expires: Number(r.expires) }))
  }
  pendingUrl(owner: string): string | undefined {
    const a = this.d.db.prepare('SELECT * FROM gmail_attempts WHERE owner=? AND expires>? AND claimed=0').get(owner, this.now()) as unknown as Attempt | undefined
    if (!a || a.revision !== this.view(owner).revision || !this.d.config) return undefined
    const setup = this.decrypt<{ verifier: string; scopes: string[] }>(owner, 'attempt', a.secret), config = this.d.config
    const q = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: setup.scopes.join(' '),
      access_type: 'offline', prompt: 'consent select_account', state: a.state, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(setup.verifier).digest('base64url') })
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
  }
  deny(state: string, owner: string): void { this.d.db.prepare('DELETE FROM gmail_attempts WHERE state=? AND owner=?').run(state, owner) }
  cancelPending(owner: string): void { this.d.db.prepare('DELETE FROM gmail_attempts WHERE owner=?').run(owner) }
  async complete(state: string, owner: string, code: string): Promise<GmailView> {
    const config = this.d.config, a = this.d.db.prepare('SELECT * FROM gmail_attempts WHERE state=? AND owner=?').get(state, owner) as unknown as Attempt | undefined
    if (!config || !state.startsWith('gm1.') || !a || a.claimed || a.expires <= this.now() || a.revision !== this.view(owner).revision || !code || code.length > 2048)
      throw new GmailError(409, '这次 Gmail 连接已失效，请重新连接。')
    if (!this.d.db.prepare('UPDATE gmail_attempts SET claimed=1 WHERE state=? AND claimed=0').run(state).changes) throw new GmailError(409, '这次连接已处理。')
    const current = () => {
      if (a.expires <= this.now() || this.view(owner).revision !== a.revision || !this.d.db.prepare('SELECT state FROM gmail_attempts WHERE state=? AND owner=?').get(state, owner))
        throw new GmailError(409, 'Gmail 连接设置已变化，请重试。')
    }
    try {
      const setup = this.decrypt<{ verifier: string; allowSend: boolean }>(owner, 'attempt', a.secret)
      const reply = await this.d.http('/token', { form: { client_id: config.clientId, client_secret: config.clientSecret,
        grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, code_verifier: setup.verifier } }); current()
      const c = this.parseToken(reply)
      if (!c.refresh || !c.scopes.includes(GMAIL_READ)) throw new GmailError(403, '请允许读取 Gmail，并完成离线访问授权。')
      const me = await this.d.http('/identity', { token: c.access }); current()
      const identity = me.data as { sub?: string; email?: string; email_verified?: boolean }
      if (me.status !== 200 || !identity || !/^\d{1,40}$/.test(identity.sub ?? '') || identity.email_verified !== true || !emailAddress(identity.email))
        throw new GmailError(401, '未能核实 Google 账号，请重新连接。')
      const profile = await this.d.http('/profile', { token: c.access }); current()
      if (profile.status !== 200 || (profile.data as { emailAddress?: string })?.emailAddress?.toLowerCase() !== identity.email!.toLowerCase())
        throw new GmailError(403, '未能读取这个账号的 Gmail 邮箱。')
      // A broader grant in Google's cache cannot silently enable sending in Friday.
      const canSend = setup.allowSend && c.scopes.includes(GMAIL_SEND)
      this.d.db.prepare(`INSERT INTO gmail_connections(owner,status,revision,account_id,email,connected_at,can_send,secret,token_version)
        VALUES (?,'connected',?,?,?,?,?,?,0) ON CONFLICT(owner) DO UPDATE SET status='connected',revision=excluded.revision,
        account_id=excluded.account_id,email=excluded.email,connected_at=excluded.connected_at,can_send=excluded.can_send,secret=excluded.secret,token_version=0`)
        .run(owner, a.revision + 1, identity.sub!, identity.email!, this.now(), Number(canSend), this.encrypt(owner, 'grant', c))
      return this.view(owner)
    } finally { this.d.db.prepare('DELETE FROM gmail_attempts WHERE state=? AND owner=?').run(state, owner) }
  }
  disconnect(owner: string, revision: number): void {
    if (this.view(owner).revision !== revision) throw new GmailError(409, 'Gmail 连接已更新，请刷新。')
    this.d.db.prepare(`INSERT INTO gmail_connections(owner,status,revision) VALUES (?,'disconnected',?)
      ON CONFLICT(owner) DO UPDATE SET status='disconnected',revision=excluded.revision,secret='',can_send=0,account_id=NULL,email=NULL,connected_at=NULL,token_version=token_version+1`)
      .run(owner, revision + 1)
    this.cancelPending(owner)
  }
  assertCurrent(owner: string, revision: number): void {
    const view = this.view(owner)
    if (view.status !== 'connected' || view.revision !== revision) throw new GmailError(409, 'Gmail 连接或读取范围已变化。')
  }
  private invalidate(owner: string, revision: number, tokenVersion: number): boolean {
    return Boolean(this.d.db.prepare("UPDATE gmail_connections SET status='needs_connection',revision=revision+1,secret='',can_send=0 WHERE owner=? AND revision=? AND token_version=? AND status='connected'")
      .run(owner, revision, tokenVersion).changes)
  }
  private parseToken(reply: { status: number; data: unknown }, previous?: Credential): Credential {
    const r = reply.data as Record<string, unknown>
    if (reply.status !== 200 || !r || typeof r.access_token !== 'string' || !r.access_token || r.token_type !== 'Bearer' ||
      !Number.isFinite(Number(r.expires_in)) || Number(r.expires_in) <= 0 || Number(r.expires_in) > 86400)
      throw new GmailError(reply.status === 400 || reply.status === 401 ? 401 : 503, 'Gmail 授权暂不可用，请重新连接。')
    return { access: r.access_token, refresh: typeof r.refresh_token === 'string' ? r.refresh_token : previous?.refresh ?? '',
      expires: this.now() + Number(r.expires_in) * 1000,
      scopes: typeof r.scope === 'string' ? r.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [] }
  }
  private async credential(owner: string, revision: number): Promise<CredentialLease> {
    this.assertCurrent(owner, revision)
    const grant = this.grant(owner)!
    let c: Credential
    try { c = this.decrypt<Credential>(owner, 'grant', grant.secret) }
    catch (error) { this.invalidate(owner, revision, grant.tokenVersion); throw error }
    if (c.expires > this.now() + 60_000) return { credential: c, tokenVersion: grant.tokenVersion }
    const key = `${owner}:${revision}`, existing = this.refreshing.get(key)
    if (existing) return existing
    const refresh = (async () => {
      const cfg = this.d.config
      if (!c.refresh) { this.invalidate(owner, revision, grant.tokenVersion); throw new GmailError(401, 'Gmail 需要重新连接。') }
      if (!cfg) throw new GmailError(503, 'Gmail 连接服务暂不可用，已保留邮箱连接。')
      const result = await this.d.http('/token', { form: { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: cfg.clientId, client_secret: cfg.clientSecret } })
      this.assertCurrent(owner, revision)
      const providerError = result.data && typeof result.data === 'object' ? (result.data as { error?: unknown }).error : undefined
      if (result.status < 500 && result.status !== 429 && providerError === 'invalid_grant') {
        if (!this.invalidate(owner, revision, grant.tokenVersion)) throw new GmailError(409, 'Gmail 连接已刷新，请重试。')
        throw new GmailError(401, 'Gmail 连接已过期，请重新连接。')
      }
      let next: Credential
      try { next = this.parseToken(result, c) }
      catch { throw new GmailError(503, 'Gmail 连接暂未刷新，已保留邮箱连接。') }
      if (!next.scopes.includes(GMAIL_READ)) {
        if (!this.invalidate(owner, revision, grant.tokenVersion)) throw new GmailError(409, 'Gmail 连接已刷新，请重试。')
        throw new GmailError(401, 'Gmail 读取授权已变化。')
      }
      if (!this.d.db.prepare("UPDATE gmail_connections SET secret=?,token_version=token_version+1 WHERE owner=? AND revision=? AND token_version=? AND status='connected'")
        .run(this.encrypt(owner, 'grant', next), owner, revision, grant.tokenVersion).changes) throw new GmailError(409, 'Gmail 连接已变化。')
      return { credential: next, tokenVersion: grant.tokenVersion + 1 }
    })().finally(() => this.refreshing.delete(key))
    this.refreshing.set(key, refresh); return refresh
  }
  /** Sending is called only by the draft application's persisted human acceptance. */
  async request<T>(owner: string, revision: number, path: string, input: { body?: { raw: string; threadId?: string }; signal?: AbortSignal; assertCurrent?: () => void; onSendDispatch?: () => void } = {}): Promise<T> {
    const check = () => { this.assertCurrent(owner, revision); input.signal?.throwIfAborted(); input.assertCurrent?.() }
    check()
    const send = input.body !== undefined
    if (send ? path !== '/messages/send' || !this.view(owner).canSend || !/^[A-Za-z0-9_-]{1,200000}$/.test(input.body!.raw)
      : !/^\/(?:profile|messages(?:\/[a-f0-9]+)?|threads(?:\/[a-f0-9]+)?|history)(?:\?[^#]*)?$/.test(path)) throw new GmailError(403, '当前 Gmail 连接不允许此操作。')
    const { credential: c, tokenVersion } = await this.credential(owner, revision); check()
    if (send && !c.scopes.includes(GMAIL_SEND)) throw new GmailError(403, '请先在账号连接中允许发送邮件。')
    // Token refresh and local authorization can fail without sending anything.
    // The durable draft needs the actual provider dispatch boundary for recovery.
    if (send) input.onSendDispatch?.()
    const r = await this.d.http(path, { token: c.access, method: send ? 'POST' : 'GET', body: input.body, signal: input.signal }); check()
    if (r.status === 401 && !this.invalidate(owner, revision, tokenVersion)) throw new GmailError(409, 'Gmail 连接已刷新，请重试。')
    if (r.status < 200 || r.status >= 300) throw new GmailError(r.status, r.status === 401 ? 'Gmail 连接已过期，请重新连接。' : 'Gmail 未完成此操作，请稍后查看状态。',
      send && [400, 401, 403, 404, 413, 429].includes(r.status))
    return r.data as T
  }
}

export function emailAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value)
}
