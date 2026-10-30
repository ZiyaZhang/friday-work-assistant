/**
 * 个人授权（飞书 OAuth，user_access_token）：让 Friday 在私聊里用"你自己的身份"读你所在的群、你的单聊、
 * 你有权限的文档——这是 Claude Tag "DM 用你自己的账号和连接" 那一半。
 *
 * 流程：私聊 `!connect` → 卡片里的授权链接（accounts.feishu.cn/open-apis/authen/v1/authorize）→ 用户同意 →
 * 浏览器跳到 redirect_uri?code=&state= → 网关 GET /oauth/callback 收到就换 token；
 * 回调地址不通时（开发机没有内网域名），用户把跳转后的地址贴回私聊，网关从里面取 code。
 *
 * token 只存在网关 SQLite（access 2h、refresh 30d，自动续期），模型和 dsh 永远拿不到。
 */
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { describeConnectionGrant } from './connection-capabilities.js'
import { OAuthAttempts } from './oauth-attempts.js'

export const AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
export const AUTHORIZE_URL_LARK = 'https://accounts.larksuite.com/open-apis/authen/v1/authorize'

/** 默认申请的用户授权范围（要先在开发者后台的"用户"权限里开通）。 */
/**
 * 个人授权要哪些 scope，**分层**。
 *
 * 以前是一把 13 个一起要，结果只要有一项后台没开通，**整个授权页就 20027 报错**——
 * 于是"个人授权"这条路一次都没成功过，而跨群搜索、历史检索、我的一天全挂在它上面。
 * 分层之后：`core` 是当前基础能力集合（含创建和编辑文档，不是全部只读），
 * 每个附加组各自解开一个能力，需要后台单独开通，**默认不请求**。
 *
 * 少了一项 `im:message`（以用户身份发消息）：从来没用过，也不该用——
 * 群里永远只用机器人身份说话，个人授权只放大眼睛，不放大嘴。
 */
export const USER_SCOPE_TIERS = {
  core: [
    'offline_access',
    'contact:user.base:readonly',
    'im:chat:readonly',
    'im:message:readonly',
    'search:message',
    'docx:document:readonly',
    // 用户明确要求生成文档、或约定职责归档时，用发起人的身份创建，让文档归他所有。
    // 长度本身不触发建文档；只有 readonly 时无法完成明确要求的创建操作。
    'docx:document',
    // 盯群时读别人发的图和附件走的是读取身份（api.ts 的 downloadMessageResource(read.as)），
    // 没有它就只能看见"有一张图"却打不开。
    'im:resource',
    // 翻会话历史。**用户身份没有 im:message.history:readonly 这个 scope**——
    // 我先照应用身份那份抄了一遍，对着应用实际可选的清单一比才发现根本不存在。
    // 用户身份读历史靠的是这两个：单聊一个、群一个。
    // 单聊这项免审，所以放 core；群那项要单独开通，在 watch 档。
    'im:message.p2p_msg:get_as_user',
    'wiki:wiki:readonly',
    'wiki:node:read',
    'drive:drive.metadata:readonly',
  ],
  /** 盯群：读"你在、我不在"的群。要后台开通 im:message.group_msg:get_as_user。 */
  watch: ['im:message.group_msg:get_as_user'],
  /** 我的一天：读本人日程。开发者本人免审可调，别人用要后台开通。 */
  calendar: ['calendar:calendar:readonly'],
  /**
   * 妙记：会议纪要。是密度最高的上下文来源——决定、排期、谁认领了什么多半在会上定，
   * 而且会后没人会再打一遍。三项都是读：找到、读基本信息、读 AI 产出。
   */
  minutes: ['minutes:minutes.search:read', 'minutes:minutes.basic:read', 'minutes:minutes.artifacts:read'],
} as const

export type UserScopeExtra = Exclude<keyof typeof USER_SCOPE_TIERS, 'core'>

export const USER_SCOPE_EXTRAS: readonly UserScopeExtra[] = ['watch', 'calendar', 'minutes']

/** 附加组各自解开什么，用来在卡片和回执里说人话。 */
export const EXTRA_LABEL: Record<UserScopeExtra, string> = {
  watch: '替你盯"你在、我不在"的群',
  calendar: '看你自己的日程',
  minutes: '读取你的会议妙记与其中的待办',
}

export function userScopesFor(extras: readonly UserScopeExtra[] = []): string[] {
  const out: string[] = [...USER_SCOPE_TIERS.core]
  for (const extra of extras) for (const scope of USER_SCOPE_TIERS[extra]) if (!out.includes(scope)) out.push(scope)
  return out
}

/**
 * 实际拿到的 scope 串 → 哪些能力是活的。
 * 判断依据是**飞书返回的授权结果**，不是我们请求过什么——请求了不等于给了。
 */
export function grantedCapabilities(scope: string): { core: boolean; extras: UserScopeExtra[]; missing: UserScopeExtra[] } {
  const granted = new Set(scope.split(/[\s,]+/).filter(Boolean))
  const has = (list: readonly string[]) => list.every((s) => granted.has(s))
  const extras = USER_SCOPE_EXTRAS.filter((e) => has(USER_SCOPE_TIERS[e]))
  return {
    // 读群历史和搜索是这条路的意义所在；contact / offline_access 缺了也还能用，不算致命
    core: granted.has('im:chat:readonly') && granted.has('im:message:readonly'),
    extras,
    missing: USER_SCOPE_EXTRAS.filter((e) => !extras.includes(e)),
  }
}

/** Describe the actual grant; provider scopes do not prove every resource is readable. */
export function describeGrantedScope(scope: string): string {
  return describeConnectionGrant(scope)
}

/** 兼容旧配置名。默认只要 core——附加组由 FRIDAY_USER_SCOPE_EXTRAS 显式打开。 */
export const DEFAULT_USER_SCOPES = userScopesFor()

export interface UserToken {
  openId: string
  accessToken: string
  expiresAt: number
  refreshToken: string | null
  refreshExpiresAt: number | null
  scope: string
  name: string | null
  createdAt: number
  updatedAt: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_tokens (
  open_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_token TEXT,
  refresh_expires_at INTEGER,
  scope TEXT NOT NULL DEFAULT '',
  name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export interface TokenExchange {
  accessToken: string
  expiresIn?: number
  refreshToken?: string
  refreshTokenExpiresIn?: number
  scope?: string
}

export interface OAuthProvider {
  exchangeCode(code: string, redirectUri: string): Promise<TokenExchange>
  refresh(refreshToken: string): Promise<TokenExchange>
}

/** Fixed, non-secret provider outcome. Never retain a raw OAuth request/response. */
export class OAuthTokenError extends Error {
  constructor(readonly reason: 'invalid_grant' | 'unavailable') {
    super(reason === 'invalid_grant' ? 'OAuth 授权已不可用，请重新授权' : 'OAuth 服务暂不可用，请稍后重试')
    this.name = 'OAuthTokenError'
  }
}

/** Messages here are fixed host-authored text, safe to show in a completion page. */
export class OAuthConnectionError extends Error {}

/** Host-only: the token and its revalidation closure must not enter model/API/log output. */
export type TokenAccessResult =
  | { status: 'available'; accessToken: string; isCurrent(): boolean }
  | { status: 'denied'; reason: 'not_connected' | 'invalid_grant' }
  | { status: 'unavailable'; reason: 'refresh_failed' | 'refresh_unavailable' | 'connection_changed' }

export function buildAuthorizeUrl(input: { appId: string; redirectUri: string; scopes: string[]; state: string; domain?: 'feishu' | 'lark' }): string {
  const base = input.domain === 'lark' ? AUTHORIZE_URL_LARK : AUTHORIZE_URL
  const q = new URLSearchParams({ client_id: input.appId, response_type: 'code', redirect_uri: input.redirectUri, scope: input.scopes.join(' '), state: input.state })
  return `${base}?${q.toString()}`
}

/** 从用户贴回来的整段文字里找 code / state（跳转后的地址，或裸 code）。 */
export function extractCallback(text: string): { code: string; state?: string } | undefined {
  const s = text.trim()
  try {
    const url = new URL(s.match(/https?:\/\/\S+/)?.[0] ?? '')
    const code = url.searchParams.get('code')
    if (code) return { code, state: url.searchParams.get('state') ?? undefined }
  } catch {
    /* not a url */
  }
  const m = s.match(/(?:^|[?&\s])code=([A-Za-z0-9_.-]{8,})/)
  if (m) return { code: m[1] as string, state: s.match(/state=([A-Za-z0-9_-]+)/)?.[1] }
  if (/^[A-Za-z0-9_.-]{16,}$/.test(s)) return { code: s }
  return undefined
}

/** Schema-only entry point; migration verification must never create or recover a grant. */
export function ensureUserTokenSchema(db: DatabaseSync): void {
  db.exec(SCHEMA)
  const columns = db.prepare('PRAGMA table_info(user_tokens)').all() as { name: string }[]
  if (!columns.some(column => column.name === 'grant_attempt_state')) db.exec('ALTER TABLE user_tokens ADD COLUMN grant_attempt_state TEXT')
  new OAuthAttempts(db, () => Date.now())
}

export class UserTokenStore {
  private readonly attempts: OAuthAttempts
  private readonly refreshing = new Map<string, { snapshot: UserToken; promise: Promise<TokenAccessResult> }>()

  constructor(
    private readonly db: DatabaseSync,
    private readonly provider: OAuthProvider,
    private readonly now: () => number = () => Date.now(),
    private readonly createState: () => string = () => randomBytes(16).toString('base64url'),
  ) {
    ensureUserTokenSchema(db)
    this.attempts = new OAuthAttempts(db, now)
  }

  /**
   * 发起授权：生成 state 并记住它属于谁（10 分钟内有效）。
   *
   * `onBegin` 是给公网中转用的挂钩。挂在这里而不是挂在调用方，是因为
   * **state 只在这一个地方诞生**——挂在调用方就得每加一个入口记得挂一次，
   * 而忘了挂的那个入口不会报错，只会安静地永远等不到回调。
   */
  begin(openId: string): string {
    const state = this.createState()
    this.attempts.begin(state, openId, this.now() + 10 * 60_000)
    try { this.onBegin?.(state, openId) } catch { /* 盯不上不该让授权发不出去 */ }
    return state
  }

  /** 每次发起授权时叫一声。网关用它启动公网中转的轮询。 */
  onBegin?: (state: string, openId: string) => void

  /** state 对应的用户；不认识或过期返回 undefined。 */
  ownerOfState(state: string | undefined): string | undefined {
    if (!state) return undefined
    return this.attempts.owner(state)
  }

  /** Bootstrap only, after the single gateway lock. Reattach still-valid cards to the public relay. */
  recoverAuthorizations(): { state: string; openId: string; expiresAt: number }[] { return this.attempts.recover() }

  denyAuthorization(state: string): boolean { return this.attempts.deny(state) }

  /** A repeated callback can report the same existing grant; it never exchanges a code again. */
  private completedGrant(state: string, expectedOpenId?: string): UserToken | undefined {
    const attempt = this.attempts.get(state)
    if (attempt?.status !== 'connected' || expectedOpenId && attempt.openId !== expectedOpenId) return undefined
    const current = this.db.prepare('SELECT grant_attempt_state FROM user_tokens WHERE open_id=?').get(attempt.openId)
    return current?.grant_attempt_state === state && this.isConnected(attempt.openId) ? this.get(attempt.openId) : undefined
  }

  /** 用 code 换 token 并保存。expectedOpenId 是发起授权的人（私聊里贴回来时必须一致）。 */
  async complete(input: { code: string; state?: string; redirectUri: string; openId?: string; name?: string;
    verify?: (accessToken: string) => Promise<{ openId?: string; name?: string }> }): Promise<UserToken> {
    const completed = input.state && this.completedGrant(input.state, input.openId)
    if (completed) return completed
    const owner = this.ownerOfState(input.state)
    if (input.state && !owner) throw new OAuthConnectionError('授权链接已过期或已经使用，请重新授权')
    const openId = owner ?? input.openId
    if (!openId) throw new OAuthConnectionError('这个授权链接已过期或不是从这里发起的，跟我说一声我重新发一张授权卡')
    if (input.openId && owner && owner !== input.openId) throw new OAuthConnectionError('这个授权码是别人发起的，不能绑定到你')
    // A code pasted by the real person without state still gets a durable, single-use attempt.
    const state = input.state ?? this.createState()
    if (!input.state) this.attempts.begin(state, openId, this.now() + 10 * 60_000)
    if (!this.attempts.claim(state, openId)) throw new OAuthConnectionError('授权链接已过期或已经使用，请重新授权')
    try {
      const t = await this.provider.exchangeCode(input.code, input.redirectUri)
      const identity = input.verify ? await input.verify(t.accessToken) : undefined
      if (input.verify && !identity?.openId) throw new OAuthConnectionError('未能核验授权人，请重新授权')
      if (identity?.openId && identity.openId !== openId) throw new OAuthConnectionError('授权人不匹配，请用发起授权的飞书账号重试')
      // The grant and its terminal attempt commit together. A new card or disconnect wins over any late result.
      this.db.exec('SAVEPOINT complete_oauth_attempt')
      try {
        if (!this.attempts.isExchanging(state, openId)) throw new OAuthConnectionError('连接已变更，请使用最新授权卡')
        const saved = this.save(openId, t, 'grant', identity?.name ?? input.name)
        this.db.prepare('UPDATE user_tokens SET grant_attempt_state=? WHERE open_id=?').run(state, openId)
        if (!this.attempts.finish(state, 'connected')) throw new OAuthConnectionError('连接已变更，请使用最新授权卡')
        this.db.exec('RELEASE SAVEPOINT complete_oauth_attempt')
        return saved
      } catch (error) {
        this.db.exec('ROLLBACK TO SAVEPOINT complete_oauth_attempt; RELEASE SAVEPOINT complete_oauth_attempt')
        throw error
      }
    } catch (error) {
      this.attempts.finish(state, 'failed')
      throw error
    }
  }

  private save(openId: string, t: TokenExchange, mode: 'grant' | 'refresh', name?: string): UserToken {
    const now = this.now()
    const existing = this.get(openId)
    // A code exchange establishes a new grant. Only a same-grant refresh may omit
    // scope/refresh fields while retaining the original grant's authority.
    const priorGrant = mode === 'refresh' ? existing : undefined
    const expiresAt = now + Math.max(60, (t.expiresIn ?? 7200) - 60) * 1000
    const refreshToken = t.refreshToken ?? priorGrant?.refreshToken ?? null
    const refreshExpiresAt = t.refreshToken ? now + (t.refreshTokenExpiresIn ?? 30 * 86400) * 1000 : (priorGrant?.refreshExpiresAt ?? null)
    this.db
      .prepare(
        `INSERT INTO user_tokens (open_id, access_token, expires_at, refresh_token, refresh_expires_at, scope, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(open_id) DO UPDATE SET access_token = excluded.access_token, expires_at = excluded.expires_at,
           refresh_token = excluded.refresh_token, refresh_expires_at = excluded.refresh_expires_at, scope = excluded.scope,
           name = coalesce(excluded.name, user_tokens.name), updated_at = excluded.updated_at`,
      )
      .run(openId, t.accessToken, expiresAt, refreshToken, refreshExpiresAt, t.scope ?? priorGrant?.scope ?? '', name ?? null, existing?.createdAt ?? now, now)
    return this.get(openId) as UserToken
  }

  get(openId: string): UserToken | undefined {
    const r = this.db.prepare('SELECT * FROM user_tokens WHERE open_id = ?').get(openId) as Record<string, unknown> | undefined
    return r ? toToken(r) : undefined
  }

  /** Host-only grant identity; refresh does not create a new authorization. */
  grantId(openId: string): string | null {
    const row = this.db.prepare('SELECT grant_attempt_state FROM user_tokens WHERE open_id=?').get(openId)
    return typeof row?.grant_attempt_state === 'string' ? row.grant_attempt_state : null
  }

  /** A provider-expired access token requires refresh, not deletion of the grant. */
  expireAccessToken(openId: string, expected: UserToken): boolean {
    const current = this.get(openId)
    if (!current || expected.openId !== openId || !this.sameAuthorization(current, expected)) return false
    return Boolean(this.db.prepare('UPDATE user_tokens SET expires_at=? WHERE open_id=? AND access_token=? AND expires_at=?')
      .run(Math.min(expected.expiresAt, this.now()), openId, expected.accessToken, expected.expiresAt).changes)
  }

  /** Distinguishes known loss of authorization from a temporary inability to obtain it. */
  async accessTokenResult(openId: string): Promise<TokenAccessResult> {
    const t = this.get(openId)
    if (!t) return { status: 'denied', reason: 'not_connected' }
    if (t.expiresAt > this.now() + 5 * 60_000) return this.available(t)
    if (!t.refreshToken || (t.refreshExpiresAt !== null && t.refreshExpiresAt <= this.now())) {
      // expiresAt is an early refresh/safety deadline, not a persisted provider expiry.
      // Older rows do not prove the actual lifetime; do not infer revocation from them.
      return { status: 'unavailable', reason: 'refresh_unavailable' }
    }
    const pending = this.refreshing.get(openId)
    if (pending && this.sameAuthorization(pending.snapshot, t)) return pending.promise
    const flight = { snapshot: t, promise: this.refreshAccess(t, t.refreshToken) }
    this.refreshing.set(openId, flight)
    try {
      return await flight.promise
    } finally {
      // A replacement grant may already have started a different refresh.
      if (this.refreshing.get(openId) === flight) this.refreshing.delete(openId)
    }
  }

  private async refreshAccess(t: UserToken, refreshToken: string): Promise<TokenAccessResult> {
    let fresh: TokenExchange
    try {
      fresh = await this.provider.refresh(refreshToken)
    } catch (error) {
      // A late denial for the previous grant says nothing about a replacement connection.
      return this.connectionChanged(t) ?? (error instanceof OAuthTokenError && error.reason === 'invalid_grant'
        ? { status: 'denied', reason: 'invalid_grant' }
        : { status: 'unavailable', reason: 'refresh_failed' })
    }
    const changed = this.connectionChanged(t)
    if (changed) return changed
    if (!fresh || typeof fresh.accessToken !== 'string' || !fresh.accessToken.trim()) return { status: 'unavailable', reason: 'refresh_failed' }
    try {
      return this.available(this.save(t.openId, fresh, 'refresh'))
    } catch {
      return { status: 'unavailable', reason: 'refresh_failed' }
    }
  }

  /** Compatibility wrapper; callers needing revocation semantics must use accessTokenResult. */
  async accessTokenFor(openId: string): Promise<string | undefined> {
    const result = await this.accessTokenResult(openId)
    return result.status === 'available' && result.isCurrent() ? result.accessToken : undefined
  }

  private available(snapshot: UserToken): Extract<TokenAccessResult, { status: 'available' }> {
    return { status: 'available', accessToken: snapshot.accessToken,
      isCurrent: () => snapshot.expiresAt > this.now() && this.connectionChanged(snapshot) === undefined }
  }

  private connectionChanged(snapshot: UserToken): Exclude<TokenAccessResult, { status: 'available' }> | undefined {
    const current = this.get(snapshot.openId)
    if (!current) return { status: 'denied', reason: 'not_connected' }
    if (!this.sameAuthorization(current, snapshot)) {
      return { status: 'unavailable', reason: 'connection_changed' }
    }
    return undefined
  }

  private sameAuthorization(current: UserToken, snapshot: UserToken): boolean {
    return current.openId === snapshot.openId && current.accessToken === snapshot.accessToken &&
      current.refreshToken === snapshot.refreshToken && current.expiresAt === snapshot.expiresAt &&
      current.refreshExpiresAt === snapshot.refreshExpiresAt && current.scope === snapshot.scope &&
      current.createdAt === snapshot.createdAt && current.updatedAt === snapshot.updatedAt
  }

  isConnected(openId: string): boolean {
    const t = this.get(openId)
    if (!t) return false
    if (t.expiresAt > this.now()) return true
    return Boolean(t.refreshToken && (!t.refreshExpiresAt || t.refreshExpiresAt > this.now()))
  }

  disconnect(openId: string): boolean {
    this.attempts.invalidate(openId)
    return Number(this.db.prepare('DELETE FROM user_tokens WHERE open_id = ?').run(openId).changes) > 0
  }
}

function toToken(r: Record<string, unknown>): UserToken {
  return {
    openId: String(r.open_id),
    accessToken: String(r.access_token),
    expiresAt: Number(r.expires_at),
    refreshToken: (r.refresh_token as string | null) ?? null,
    refreshExpiresAt: r.refresh_expires_at === null || r.refresh_expires_at === undefined ? null : Number(r.refresh_expires_at),
    scope: String(r.scope ?? ''),
    name: (r.name as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}
