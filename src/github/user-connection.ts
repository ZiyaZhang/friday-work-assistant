import { createCipheriv, createDecipheriv, createHash, createHmac, generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { createRelayState } from '../feishu/oauth-relay.js'
import { GitHubApiError, GitHubIdentity, type GitHubHttp } from './identity.js'
import type { Logger } from '../log.js'

const ATTEMPT_TTL = 10 * 60_000
export interface GitHubUserConfig {
  clientId: string; clientSecret: string; redirectUri: string; relayToken: string; proxyUrl?: string; appSlug?: string
}
export function loadGitHubUserConfig(relay: { baseUrl: string; token: string } | undefined, proxyUrl?: string,
  env: NodeJS.ProcessEnv = process.env): GitHubUserConfig | undefined {
  const clientId = env.FRIDAY_GITHUB_CLIENT_ID?.trim(), clientSecret = env.FRIDAY_GITHUB_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret || !relay) return undefined
  const origin = new URL(relay.baseUrl)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('GitHub OAuth needs a public HTTPS relay origin')
  const appSlug = env.FRIDAY_GITHUB_APP_SLUG?.trim()
  if (appSlug && !/^[a-z0-9-]+$/.test(appSlug)) throw new Error('Invalid GitHub App slug')
  return { clientId, clientSecret, redirectUri: `${origin.origin}/github/callback`, relayToken: relay.token, proxyUrl, appSlug }
}
export interface GitHubConnectionView {
  status: 'disconnected' | 'connected' | 'needs_connection'; revision: number
  login?: string; accountId?: number; connectedAt?: number
  method?: 'github_app' | 'personal_token'
}
interface Grant extends GitHubConnectionView { owner: string; secret: string; tokenVersion: number }
export interface TemporaryGitHubRead { repositories: string[]; expiresAt: number }
interface Credential { access: string; refresh?: string; expires: number; refreshExpires?: number; temporaryRead?: TemporaryGitHubRead; kind?: 'pat' }
interface CredentialLease { credential: Credential; tokenVersion: number }
interface TokenSetup { privateKey: string; publicKey: string }
interface Attempt { state: string; owner: string; revision: number; verifier: string; expires: number; claimed: number }
export type GitHubUserHttp = (path: string, input: { token?: string; form?: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; data: unknown }>

export function ensureGitHubUserSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS github_user_connections (
    owner TEXT PRIMARY KEY, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    login TEXT, account_id INTEGER, connected_at INTEGER, secret TEXT NOT NULL DEFAULT '', token_version INTEGER NOT NULL DEFAULT 0
  ); CREATE TABLE IF NOT EXISTS github_user_attempts (
    state TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, verifier TEXT NOT NULL,
    expires INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0
  );`)
}

/** A host-only key, separate from database backups and never sent to the model. */
export function loadConnectionKey(path: string): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, randomBytes(32)) } finally { closeSync(fd) } }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const key = readFileSync(path)
  if (key.length !== 32) throw new Error('Invalid personal connection encryption key')
  return key
}

/** Fixed destinations, no deployment PAT or credential-hosting relay, no redirect or error-body logging. */
export function createGitHubUserHttp(proxyUrl?: string): GitHubUserHttp {
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl, { keepAlive: true }) : undefined
  return async (path, input) => {
    const tokenExchange = path === '/login/oauth/access_token'
    if (!tokenExchange && (!path.startsWith('/') || path.startsWith('//') || /[\\#\r\n]/.test(path))) throw new Error('Invalid GitHub path')
    const base = tokenExchange ? 'https://github.com' : 'https://api.github.com'
    const url = new URL(base + path)
    if (url.href !== base + path) throw new Error('Invalid GitHub path')
    try {
      const result = await axios.request({ url: url.href, method: tokenExchange ? 'POST' : 'GET',
        headers: { accept: tokenExchange ? 'application/json' : 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
          'user-agent': 'Friday-Personal', ...(input.token ? { authorization: `Bearer ${input.token}` } : {}) },
        ...(input.form ? { data: new URLSearchParams(input.form) } : {}),
        timeout: 15_000, maxRedirects: 0, maxContentLength: 8 * 1024 * 1024, proxy: false,
        httpsAgent: agent, signal: input.signal, validateStatus: () => true })
      return { status: result.status, data: result.data }
    } catch { throw new GitHubApiError(503, 'GitHub 暂时无法连接，请稍后重试。') }
  }
}

/** Owner is supplied only by the authenticated host. No username can create a grant. */
export class GitHubUserConnections {
  private readonly refreshing = new Map<string, Promise<CredentialLease>>()
  onBegin?: (state: string, owner: string, expires: number) => void
  constructor(private readonly d: { db: DatabaseSync; key: Buffer; config?: GitHubUserConfig; http: GitHubUserHttp; log: Logger; now?: () => number;
    /** Host-only migration aid. It grants nothing until enableTemporaryRead verifies the same account and explicit repositories. */
    temporaryReader?: GitHubIdentity; tokenRelay?: { baseUrl: string; token: string } }) {
    ensureGitHubUserSchema(d.db)
    if (d.key.length !== 32) throw new Error('Invalid connection key')
  }
  private now() { return this.d.now?.() ?? Date.now() }
  get available() { return Boolean(this.d.config) }
  get tokenAvailable() { return Boolean(this.d.tokenRelay) }
  get installationUrl() { return this.d.config?.appSlug ? `https://github.com/apps/${this.d.config.appSlug}/installations/new` : undefined }
  private grant(owner: string): Grant | undefined {
    const r = this.d.db.prepare('SELECT * FROM github_user_connections WHERE owner=?').get(owner)
    return r ? { owner, status: r.status as Grant['status'], revision: Number(r.revision), secret: String(r.secret), tokenVersion: Number(r.token_version),
      ...(r.login ? { login: String(r.login), accountId: Number(r.account_id), connectedAt: Number(r.connected_at) } : {}) } : undefined
  }
  view(owner: string): GitHubConnectionView {
    let g = this.grant(owner)
    let method: GitHubConnectionView['method']
    if (g?.status === 'connected') {
      // A corrupt token is invalidated by credential(), retaining the normal connection-card recovery path.
      let c: Credential | undefined
      try { c = this.decrypt<Credential>(owner, 'grant', g.secret) } catch { /* credential() reports this on a read */ }
      method = c?.kind === 'pat' ? 'personal_token' : 'github_app'
      if (c?.temporaryRead && c.temporaryRead.expiresAt <= this.now()) {
        delete c.temporaryRead; this.saveReadScope(g, c); g = this.grant(owner)!
      }
    }
    return g ? { status: g.status, revision: g.revision, login: g.login, accountId: g.accountId, connectedAt: g.connectedAt, method } : { status: 'disconnected', revision: 0 }
  }
  temporaryAccess(owner: string): TemporaryGitHubRead | undefined {
    if (this.view(owner).status !== 'connected') return undefined
    return this.decrypt<Credential>(owner, 'grant', this.grant(owner)!.secret).temporaryRead
  }
  private saveReadScope(g: Grant, c: Credential): void {
    const changed = this.d.db.prepare(`UPDATE github_user_connections SET secret=?,revision=revision+1,token_version=token_version+1
      WHERE owner=? AND revision=? AND token_version=? AND status='connected'`)
      .run(this.encrypt(g.owner, 'grant', c), g.owner, g.revision, g.tokenVersion).changes
    if (!changed) throw new GitHubApiError(409, 'GitHub 连接已变化，请重试。')
  }
  /** Operator entry only; deliberately absent from model tools, public HTTP and card actions. */
  async enableTemporaryRead(owner: string, input: TemporaryGitHubRead): Promise<void> {
    const reader = this.d.temporaryReader, v = this.view(owner)
    this.assertCurrent(owner, v.revision)
    const repositories = [...new Set(input.repositories.map(repo => repo.toLowerCase()))]
    if (!reader || reader.mode !== 'pat' || !repositories.length || repositories.length > 3 ||
      repositories.some(repo => !/^[a-z0-9-]+\/[a-z0-9_.-]+$/.test(repo) || repo.split('/')[1] === '.' || repo.split('/')[1] === '..' || !reader.repoAllowed(repo)) ||
      !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.now() || input.expiresAt > this.now() + 7 * 86_400_000)
      throw new GitHubApiError(403, '临时读取需要指定仓库，并在七天内到期。')
    const current = () => this.assertCurrent(owner, v.revision)
    await this.verifyTemporaryIdentity(owner, v.revision)
    for (const repo of repositories) {
      await reader.api('GET', `/repos/${repo}`, undefined, undefined, current)
      current()
    }
    await this.credential(owner, v.revision); current()
    const g = this.grant(owner)!, c = this.decrypt<Credential>(owner, 'grant', g.secret)
    c.temporaryRead = { repositories, expiresAt: input.expiresAt }
    this.saveReadScope(g, c)
  }
  disableTemporaryRead(owner: string, revision: number): void {
    this.assertCurrent(owner, revision)
    const g = this.grant(owner)!, c = this.decrypt<Credential>(owner, 'grant', g.secret)
    if (c.temporaryRead) { delete c.temporaryRead; this.saveReadScope(g, c) }
  }
  private async verifyTemporaryIdentity(owner: string, revision: number, signal?: AbortSignal): Promise<void> {
    const reader = this.d.temporaryReader, current = () => { this.assertCurrent(owner, revision); signal?.throwIfAborted() }
    current()
    if (!reader || reader.mode !== 'pat') throw new GitHubApiError(403, '临时读取暂不可用。')
    const user = await reader.api<{ id: number; login: string }>('GET', '/user', undefined, undefined, current, signal)
    current()
    const v = this.view(owner)
    if (user.id !== v.accountId || user.login?.toLowerCase() !== v.login?.toLowerCase()) {
      this.disableTemporaryRead(owner, revision)
      throw new GitHubApiError(403, '临时凭据与已连接的 GitHub 账号不一致，已停止临时读取。')
    }
  }
  private async temporaryRequest(owner: string, revision: number, path: string, signal?: AbortSignal): Promise<unknown> {
    await this.verifyTemporaryIdentity(owner, revision, signal)
    const current = () => { this.assertCurrent(owner, revision); signal?.throwIfAborted() }
    current()
    const data = await this.d.temporaryReader!.api('GET', path, undefined, undefined, current, signal)
    current()
    return data
  }
  private encrypt(owner: string, purpose: string, data: unknown): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.d.key, iv)
    cipher.setAAD(Buffer.from(`github:${purpose}:${owner}`))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()])
    return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64url')).join('.')
  }
  private decrypt<T>(owner: string, purpose: string, text: string): T {
    try {
      const [iv, tag, bytes] = text.split('.').map(s => Buffer.from(s, 'base64url'))
      const cipher = createDecipheriv('aes-256-gcm', this.d.key, iv!)
      cipher.setAAD(Buffer.from(`github:${purpose}:${owner}`)); cipher.setAuthTag(tag!)
      return JSON.parse(Buffer.concat([cipher.update(bytes!), cipher.final()]).toString()) as T
    } catch { throw new GitHubApiError(401, 'GitHub 连接已失效，请重新连接。') }
  }
  begin(owner: string): { url: string; expires: number } {
    const config = this.d.config
    if (!owner || !config) throw new GitHubApiError(503, 'GitHub 个人连接尚未配置完成。')
    const view = this.view(owner), verifier = randomBytes(32).toString('base64url'), expires = this.now() + ATTEMPT_TTL
    const state = createRelayState(config.relayToken, this.now(), 'github')
    this.d.db.prepare('DELETE FROM github_user_attempts WHERE expires<=? OR owner=?').run(this.now(), owner)
    this.d.db.prepare('INSERT INTO github_user_attempts(state,owner,revision,verifier,expires) VALUES (?,?,?,?,?)')
      .run(state, owner, view.revision, this.encrypt(owner, 'attempt', verifier), expires)
    const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' })
    this.onBegin?.(state, owner, expires)
    return { url: `https://github.com/login/oauth/authorize?${params}`, expires }
  }
  /** The browser encrypts the PAT to this one-use gateway key before any network request. */
  beginToken(owner: string): { url: string; expires: number } {
    const relay = this.d.tokenRelay
    if (!owner || !relay) throw new GitHubApiError(503, '个人令牌连接尚未配置完成。')
    const state = createRelayState(relay.token, this.now(), 'github_token'), expires = this.now() + ATTEMPT_TTL
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
    const setup: TokenSetup = { publicKey: pair.publicKey.toString('base64url'), privateKey: pair.privateKey }
    const url = this.tokenSetupUrl(state, setup.publicKey)
    this.d.db.prepare('DELETE FROM github_user_attempts WHERE expires<=? OR owner=?').run(this.now(), owner)
    this.d.db.prepare('INSERT INTO github_user_attempts(state,owner,revision,verifier,expires) VALUES (?,?,?,?,?)')
      .run(state, owner, this.view(owner).revision, this.encrypt(owner, 'attempt', setup), expires)
    this.onBegin?.(state, owner, expires)
    return { url, expires }
  }
  private tokenSetupUrl(state: string, publicKey: string): string {
    const relay = this.d.tokenRelay!
    const origin = new URL(relay.baseUrl)
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
      throw new GitHubApiError(503, '个人令牌连接需要 HTTPS 配置页。')
    const signature = createHmac('sha256', relay.token).update(`friday-token-key:${state}:${publicKey}`).digest('base64url')
    return `${origin.origin}/github/token?${new URLSearchParams({ state, key: publicKey, signature })}`
  }
  pendingTokenUrl(owner: string): string | undefined {
    const a = this.d.db.prepare("SELECT state,verifier FROM github_user_attempts WHERE owner=? AND state LIKE 'gp1.%' AND expires>? AND claimed=0").get(owner, this.now())
    if (!a || !this.d.tokenRelay) return undefined
    return this.tokenSetupUrl(String(a.state), this.decrypt<TokenSetup>(owner, 'attempt', String(a.verifier)).publicKey)
  }
  pending(): { state: string; owner: string; expires: number }[] {
    return this.d.db.prepare('SELECT state,owner,expires FROM github_user_attempts WHERE claimed=0 AND expires>?').all(this.now())
      .map(r => ({ state: String(r.state), owner: String(r.owner), expires: Number(r.expires) }))
  }
  deny(state: string, owner: string): void { this.d.db.prepare('DELETE FROM github_user_attempts WHERE state=? AND owner=?').run(state, owner) }
  cancelPending(owner: string): void { this.d.db.prepare('DELETE FROM github_user_attempts WHERE owner=?').run(owner) }
  private parseCredential(data: unknown): Credential {
    const r = data as Record<string, unknown>
    if (!r || typeof r.access_token !== 'string' || !/^ghu_[A-Za-z0-9_]+$/.test(r.access_token) || r.token_type !== 'bearer')
      throw new GitHubApiError(401, 'GitHub 授权未完成，请重新连接。')
    const duration = r.expires_in === undefined ? undefined : Number(r.expires_in)
    if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) throw new GitHubApiError(401, 'GitHub 授权已失效。')
    if (r.refresh_token !== undefined && (typeof r.refresh_token !== 'string' || !/^ghr_[A-Za-z0-9_]+$/.test(r.refresh_token)))
      throw new GitHubApiError(401, 'GitHub 授权未完成。')
    if (r.refresh_token !== undefined && (!Number.isFinite(Number(r.refresh_token_expires_in)) || Number(r.refresh_token_expires_in) <= 0))
      throw new GitHubApiError(401, 'GitHub 授权未完成。')
    return { access: r.access_token, expires: duration === undefined ? Number.MAX_SAFE_INTEGER : this.now() + duration * 1000,
      ...(typeof r.refresh_token === 'string' ? { refresh: r.refresh_token, refreshExpires: this.now() + Number(r.refresh_token_expires_in ?? 0) * 1000 } : {}) }
  }
  async complete(state: string, owner: string, code: string): Promise<GitHubConnectionView> {
    if (state.startsWith('gp1.')) return this.completeToken(state, owner, code)
    const config = this.d.config, a = this.d.db.prepare('SELECT * FROM github_user_attempts WHERE state=? AND owner=?').get(state, owner) as unknown as Attempt | undefined
    if (!config || !a || a.expires <= this.now() || a.claimed || a.revision !== this.view(owner).revision || !code || code.length > 2048)
      throw new GitHubApiError(409, '这次连接已失效，请重新连接。')
    if (!this.d.db.prepare('UPDATE github_user_attempts SET claimed=1 WHERE state=? AND claimed=0').run(state).changes)
      throw new GitHubApiError(409, '这次连接已处理。')
    const current = () => {
      const row = this.d.db.prepare('SELECT state FROM github_user_attempts WHERE state=? AND owner=?').get(state, owner)
      if (!row || a.expires <= this.now() || this.view(owner).revision !== a.revision) throw new GitHubApiError(409, '连接设置已变化，请重新连接。')
    }
    try {
      const token = await this.d.http('/login/oauth/access_token', { form: { client_id: config.clientId, client_secret: config.clientSecret,
        redirect_uri: config.redirectUri, code, code_verifier: this.decrypt<string>(owner, 'attempt', a.verifier) } })
      current()
      if (token.status !== 200) throw new GitHubApiError(401, 'GitHub 授权未完成，请重新连接。')
      const credential = this.parseCredential(token.data), result = await this.d.http('/user', { token: credential.access })
      current()
      const user = result.data as { id?: number; login?: string }
      if (result.status !== 200 || !Number.isSafeInteger(user?.id) || Number(user.id) <= 0 || !user.login || !/^[A-Za-z0-9-]{1,39}$/.test(user.login))
        throw new GitHubApiError(401, '未能核实 GitHub 账号，请重新连接。')
      this.d.db.prepare(`INSERT INTO github_user_connections(owner,status,revision,login,account_id,connected_at,secret,token_version)
        VALUES (?,'connected',?,?,?,?,?,0) ON CONFLICT(owner) DO UPDATE SET status='connected',revision=excluded.revision,
        login=excluded.login,account_id=excluded.account_id,connected_at=excluded.connected_at,secret=excluded.secret,token_version=0`)
        .run(owner, a.revision + 1, user.login, user.id!, this.now(), this.encrypt(owner, 'grant', credential))
      return this.view(owner)
    } finally { this.d.db.prepare('DELETE FROM github_user_attempts WHERE state=? AND owner=?').run(state, owner) }
  }
  private async completeToken(state: string, owner: string, encrypted: string): Promise<GitHubConnectionView> {
    const a = this.d.db.prepare('SELECT * FROM github_user_attempts WHERE state=? AND owner=?').get(state, owner) as unknown as Attempt | undefined
    if (!this.d.tokenRelay || !a || a.expires <= this.now() || a.claimed || a.revision !== this.view(owner).revision || !/^[A-Za-z0-9_-]{342}$/.test(encrypted))
      throw new GitHubApiError(409, '这次连接已失效，请重新打开配置页。')
    if (!this.d.db.prepare('UPDATE github_user_attempts SET claimed=1 WHERE state=? AND claimed=0').run(state).changes)
      throw new GitHubApiError(409, '这次连接已处理。')
    const current = () => {
      if (!this.d.db.prepare('SELECT state FROM github_user_attempts WHERE state=? AND owner=?').get(state, owner) ||
        a.expires <= this.now() || this.view(owner).revision !== a.revision) throw new GitHubApiError(409, '连接设置已变化，请重试。')
    }
    try {
      let token: string
      try {
        const setup = this.decrypt<TokenSetup>(owner, 'attempt', a.verifier)
        token = privateDecrypt({ key: setup.privateKey, oaepHash: 'sha256', oaepLabel: Buffer.from(state) }, Buffer.from(encrypted, 'base64url')).toString('utf8')
      } catch { throw new GitHubApiError(400, '未收到有效的令牌，请重新打开配置页。') }
      if (token.length > 160 || !/^(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(token))
        throw new GitHubApiError(400, '请使用 GitHub 生成的个人访问令牌。')
      const result = await this.d.http('/user', { token }); current()
      const user = result.data as { id?: number; login?: string }
      if (result.status !== 200 || !Number.isSafeInteger(user?.id) || Number(user.id) <= 0 || !user.login || !/^[A-Za-z0-9-]{1,39}$/.test(user.login))
        throw new GitHubApiError(401, '未能核实 GitHub 账号，请检查令牌有效期与访问权限。')
      const credential: Credential = { access: token, kind: 'pat', expires: Number.MAX_SAFE_INTEGER }
      this.d.db.prepare(`INSERT INTO github_user_connections(owner,status,revision,login,account_id,connected_at,secret,token_version)
        VALUES (?,'connected',?,?,?,?,?,0) ON CONFLICT(owner) DO UPDATE SET status='connected',revision=excluded.revision,
        login=excluded.login,account_id=excluded.account_id,connected_at=excluded.connected_at,secret=excluded.secret,token_version=0`)
        .run(owner, a.revision + 1, user.login, user.id!, this.now(), this.encrypt(owner, 'grant', credential))
      return this.view(owner)
    } finally { this.d.db.prepare('DELETE FROM github_user_attempts WHERE state=? AND owner=?').run(state, owner) }
  }
  disconnect(owner: string, expectedRevision: number): GitHubConnectionView {
    if (this.view(owner).revision !== expectedRevision) throw new GitHubApiError(409, '连接已更新，请刷新后重试。')
    this.d.db.prepare(`INSERT INTO github_user_connections(owner,status,revision) VALUES (?,'disconnected',?)
      ON CONFLICT(owner) DO UPDATE SET status='disconnected',revision=excluded.revision,secret='',login=NULL,account_id=NULL,connected_at=NULL,token_version=0`)
      .run(owner, expectedRevision + 1)
    this.d.db.prepare('DELETE FROM github_user_attempts WHERE owner=?').run(owner)
    return this.view(owner)
  }
  assertCurrent(owner: string, revision: number): void {
    const v = this.view(owner)
    if (v.status !== 'connected' || v.revision !== revision) throw new GitHubApiError(401, '请在 Friday 私聊的「账号连接」中连接自己的 GitHub。')
  }
  private invalidate(owner: string, revision: number, tokenVersion: number, reason: 'unreadable' | 'refresh_expired' | 'refresh_rejected' | 'access_rejected'): boolean {
    const changed = this.d.db.prepare("UPDATE github_user_connections SET status='needs_connection',revision=revision+1,secret='' WHERE owner=? AND revision=? AND token_version=? AND status='connected'")
      .run(owner, revision, tokenVersion).changes
    if (changed) this.d.log.warn('personal GitHub connection needs reconnect', { reason, revision })
    return Boolean(changed)
  }
  private async credential(owner: string, revision: number): Promise<CredentialLease> {
    this.assertCurrent(owner, revision)
    const g = this.grant(owner)!
    let c: Credential
    try { c = this.decrypt<Credential>(owner, 'grant', g.secret) }
    catch (error) { this.invalidate(owner, revision, g.tokenVersion, 'unreadable'); throw error }
    if (c.expires > this.now() + 60_000) return { credential: c, tokenVersion: g.tokenVersion }
    const key = `${owner}:${revision}`, pending = this.refreshing.get(key)
    if (pending) return pending
    const refresh = (async () => {
      const config = this.d.config
      if (!c.refresh || !c.refreshExpires || c.refreshExpires <= this.now()) {
        this.invalidate(owner, revision, g.tokenVersion, 'refresh_expired'); throw new GitHubApiError(401, 'GitHub 连接已过期，请重新连接。')
      }
      if (!config) throw new GitHubApiError(503, 'GitHub 连接服务暂不可用，已保留账号连接。')
      const result = await this.d.http('/login/oauth/access_token', { form: { client_id: config.clientId, client_secret: config.clientSecret,
        grant_type: 'refresh_token', refresh_token: c.refresh } })
      this.assertCurrent(owner, revision)
      if (result.status >= 500 || result.status === 429) throw new GitHubApiError(503, 'GitHub 暂时无法连接，稍后自动重试。')
      const providerError = result.data && typeof result.data === 'object' ? (result.data as { error?: unknown }).error : undefined
      if (providerError === 'bad_refresh_token') {
        if (!this.invalidate(owner, revision, g.tokenVersion, 'refresh_rejected')) throw new GitHubApiError(409, 'GitHub 连接已刷新，请重试。')
        throw new GitHubApiError(401, 'GitHub 连接已过期，请重新连接。')
      }
      let next: Credential
      try { if (result.status !== 200) throw new Error(); next = this.parseCredential(result.data) }
      catch { throw new GitHubApiError(503, 'GitHub 连接暂未刷新，已保留账号连接。') }
      if (c.temporaryRead) next.temporaryRead = c.temporaryRead
      const changed = this.d.db.prepare(`UPDATE github_user_connections SET secret=?,token_version=token_version+1
        WHERE owner=? AND revision=? AND token_version=? AND status='connected'`).run(this.encrypt(owner, 'grant', next), owner, revision, g.tokenVersion).changes
      if (!changed) throw new GitHubApiError(409, 'GitHub 连接已变化，请重试。')
      return { credential: next, tokenVersion: g.tokenVersion + 1 }
    })()
    this.refreshing.set(key, refresh)
    try { return await refresh } finally { this.refreshing.delete(key) }
  }
  reader(owner: string): GitHubIdentity {
    const revision = this.view(owner).revision
    this.assertCurrent(owner, revision)
    const current = () => this.assertCurrent(owner, revision)
    const http: GitHubHttp = { request: async <T>(method: string, path: string, _body?: unknown, _headers?: Record<string, string>, signal?: AbortSignal) => {
      current(); signal?.throwIfAborted()
      if (method !== 'GET' || !(path === '/user' || /^\/(?:repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[/?]|$)|search\/issues\?|user\/(?:repos|installations)(?:[/?]|$))/.test(path)))
        throw new GitHubApiError(403, '个人 GitHub 连接目前用于读取和准备草稿。')
      const { credential: c, tokenVersion } = await this.credential(owner, revision); current(); signal?.throwIfAborted()
      let result = await this.d.http(path, { token: c.access, signal }); current(); signal?.throwIfAborted()
      if (result.status === 401) {
        if (!this.invalidate(owner, revision, tokenVersion, 'access_rejected')) throw new GitHubApiError(409, 'GitHub 连接已刷新，请重试。')
        throw new GitHubApiError(401, 'GitHub 连接已失效，请重新连接。')
      }
      const temporary = c.temporaryRead
      // Only an explicit, unexpired grant can supplement a missing App installation. No fallback on auth, policy or rate-limit errors.
      if (temporary && this.d.temporaryReader) {
        const repo = temporaryRepo(path, temporary)
        if (result.status === 404 && repo && this.d.temporaryReader.repoAllowed(repo)) {
          result = { status: 200, data: await this.temporaryRequest(owner, revision, path, signal) }
        } else if (result.status === 200) {
          const searches = temporarySearches(path, this.view(owner).login!, temporary)
          if (searches.length) {
            const parts: unknown[] = [result.data]
            let partial = false
            for (const search of searches) {
              try {
                if (!this.d.temporaryReader.repoAllowed(search.repo)) { partial = true; continue }
                const data = await this.temporaryRequest(owner, revision, search.path, signal)
                // Enforce the repository boundary on returned results too, even if a provider ignores a qualifier.
                parts.push(boundSearch(data, search.repo))
              } catch { current(); signal?.throwIfAborted(); partial = true }
            }
            result = { status: 200, data: mergeSearches(parts, partial) }
          }
        }
      }
      current(); signal?.throwIfAborted()
      if (result.status >= 300) throw new GitHubApiError(result.status, result.status === 401 ? 'GitHub 连接已失效，请重新连接。' : 'GitHub 未返回此资料，请检查账号和仓库访问范围。')
      return { status: result.status, data: result.data as T }
    } }
    // The sentinel never leaves this host: the HTTP adapter ignores identity headers.
    const reader = new GitHubIdentity({ apiUrl: 'https://api.github.com', mode: 'pat', token: 'personal-connection', allowedRepos: [], writableRepos: [] }, this.d.log, http)
    reader.repoAllowed = repo => { current(); return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) }
    reader.botLogin = async () => { current(); return this.view(owner).login! }
    return reader
  }
}

function temporaryRepo(path: string, grant: TemporaryGitHubRead): string | undefined {
  if (/[\\#\r\n]/.test(path) || /%(?:2e|2f|5c)/i.test(path.split('?')[0]!)) return undefined
  const url = new URL(`https://api.github.com${path}`)
  if (url.href !== `https://api.github.com${path}`) return undefined
  const match = url.pathname.match(/^\/repos\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)(?:\/|$)/)
  return match && grant.repositories.includes(match[1]!.toLowerCase()) ? match[1]!.toLowerCase() : undefined
}
function temporarySearches(path: string, login: string, grant: TemporaryGitHubRead): { repo: string; path: string }[] {
  const url = new URL(`https://api.github.com${path}`), p = url.searchParams
  if (url.pathname !== '/search/issues' || url.hash || [...p.keys()].some(k => !['q', 'sort', 'order', 'per_page'].includes(k)) ||
    p.getAll('q').length !== 1 || p.get('sort') !== 'updated' || p.get('order') !== 'desc' || p.get('per_page') !== '50') return []
  const query = p.get('q')
  // Generate bounded queries ourselves; never pass arbitrary user/model search expressions to the temporary identity.
  if (![ `is:open is:pr review-requested:${login}`, `is:open is:issue assignee:${login}`, `is:open is:pr author:${login}` ].includes(query ?? '')) return []
  return grant.repositories.map(repo => ({ repo, path: `/search/issues?${new URLSearchParams({ q: `${query} repo:${repo}`, sort: 'updated', order: 'desc', per_page: '50' })}` }))
}
interface SearchResult { total_count: number; incomplete_results: boolean; items: Record<string, unknown>[] }
function searchResult(data: unknown): SearchResult {
  const r = data as SearchResult
  if (!r || !Number.isSafeInteger(r.total_count) || !Array.isArray(r.items)) throw new GitHubApiError(503, 'GitHub 搜索暂未完成。')
  return r
}
function boundSearch(data: unknown, repo: string): SearchResult {
  const r = searchResult(data)
  const items = r.items.filter(item => typeof item?.html_url === 'string' &&
    new RegExp(`^https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:pull|issues)/[1-9]\\d*$`, 'i').test(item.html_url))
  return { ...r, items, incomplete_results: r.incomplete_results || items.length !== r.items.length }
}
function mergeSearches(parts: unknown[], partial: boolean): SearchResult {
  const items = new Map<string, Record<string, unknown>>()
  for (const part of parts) {
    const r = searchResult(part)
    partial ||= r.incomplete_results || r.total_count > r.items.length
    for (const item of r.items) if (typeof item?.html_url === 'string' && !items.has(item.html_url)) items.set(item.html_url, item)
  }
  const sorted = [...items.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  return { total_count: sorted.length, incomplete_results: partial || sorted.length > 50, items: sorted.slice(0, 50) }
}
