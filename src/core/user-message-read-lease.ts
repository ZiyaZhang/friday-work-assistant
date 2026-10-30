import type { AsUser, ChatInfo, FeishuClient } from '../feishu/client.js'
import type { UserToken, UserTokenStore } from '../feishu/oauth.js'
import { providerAccessFailure, tokenAccessFailure, type AccessFailure } from './access-failure.js'

export class UserMessageReadChanged extends Error {
  constructor() {
    super('来源授权或空间已变化，请重新核验')
    this.name = 'UserMessageReadChanged'
  }
}

export type UserMessageCapture =
  /** Partial listings prove access only to positive entries, never absence. */
  | { readonly status: 'ready'; readonly groups: readonly Readonly<ChatInfo>[]; readonly groupsComplete: boolean }
  | { readonly status: 'denied'; readonly reason: 'scope_missing' }
  | { readonly status: 'unavailable'; readonly reason: 'scope_unknown' | 'chat_list_unavailable'; readonly failure?: AccessFailure }

/** Host-only request lease. Never serialize `as` or this object to model/API/log output. */
export interface UserMessageReadLease {
  readonly as: Readonly<AsUser>
  /** tenantId identifies the reading authorization, not the message sender's tenant. */
  readonly authority: Readonly<{ appId: string; tenantId: string; openId: string }>
  /** A user read may be valid while its material is ineligible for group-memory capture. */
  readonly capture: UserMessageCapture
  assertCurrent(): void
}

export type UserMessageReadAccessResult =
  | { status: 'available'; lease: UserMessageReadLease }
  | { status: 'denied'; reason: 'not_connected' | 'invalid_grant' | 'identity_mismatch'; assertCurrent(): void }
  | { status: 'unavailable'; reason: 'token_unavailable' | 'authorization_changed' | 'identity_unavailable'; failure?: AccessFailure; assertCurrent(): void }

export interface UserMessageReadAccessDeps {
  /** Must be the appId of the supplied FeishuClient and token provider. */
  appId: string
  userTokens: Pick<UserTokenStore, 'get' | 'accessTokenResult'>
  feishu: Pick<FeishuClient, 'whoAmI' | 'listChatsResult'>
}

/** One user identity and one fresh group listing for an entire message-read request.
 * Target Space/Run authorization belongs to the caller's assertCurrent, not a second policy layer.
 */
export class UserMessageReadAccess {
  constructor(private readonly deps: UserMessageReadAccessDeps) {}

  async open(openId: string, assertHost: () => void, expectedTenantId?: string): Promise<UserMessageReadAccessResult> {
    assertHost()
    let tokenCurrent = () => true
    const assertCurrent = () => { assertHost(); if (!tokenCurrent()) throw new UserMessageReadChanged() }
    const unavailable = (reason: Extract<UserMessageReadAccessResult, { status: 'unavailable' }>['reason'], failure?: AccessFailure): UserMessageReadAccessResult => {
      assertCurrent(); return { status: 'unavailable', reason, ...(failure ? { failure } : {}), assertCurrent }
    }
    const denied = (reason: Extract<UserMessageReadAccessResult, { status: 'denied' }>['reason']): UserMessageReadAccessResult => {
      assertCurrent(); return { status: 'denied', reason, assertCurrent }
    }
    const beforeToken = tokenSnapshot(this.deps.userTokens.get(openId))
    let token
    try { token = await this.deps.userTokens.accessTokenResult(openId) }
    catch (error) {
      assertCurrent()
      const failure = providerAccessFailure(error, 'user')
      if (failure) return unavailable('token_unavailable', failure)
      throw error
    }
    assertCurrent()
    if (token.status !== 'available') {
      const current = this.deps.userTokens.get(openId), captured = tokenSnapshot(current)
      tokenCurrent = () => tokenSnapshot(this.deps.userTokens.get(openId)) === captured
      if (token.status === 'unavailable') return unavailable('token_unavailable', tokenAccessFailure(token))
      // A denial must not be applied after a caller waits while this grant is replaced.
      if (token.reason === 'not_connected' ? Boolean(current) : captured !== beforeToken) return unavailable('authorization_changed')
      return denied(token.reason)
    }
    tokenCurrent = token.isCurrent
    assertCurrent()
    const scope = this.deps.userTokens.get(openId)?.scope.trim()
    let identity
    try { identity = await this.deps.feishu.whoAmI(token.accessToken) }
    catch (error) {
      assertCurrent()
      const failure = providerAccessFailure(error, 'user')
      if (failure) return unavailable('identity_unavailable', failure)
      throw error
    }
    assertCurrent()
    if (!this.deps.appId || !identity.openId || !identity.tenantKey) return unavailable('identity_unavailable')
    if (identity.openId !== openId || (expectedTenantId !== undefined && expectedTenantId !== identity.tenantKey)) return denied('identity_mismatch')
    const authority = Object.freeze({ appId: this.deps.appId, tenantId: identity.tenantKey, openId })
    const available = (capture: UserMessageCapture): UserMessageReadAccessResult => {
      assertCurrent()
      return { status: 'available', lease: {
        as: Object.freeze({ userToken: token.accessToken }),
        authority,
        capture: Object.freeze(capture), assertCurrent,
      } }
    }
    // Group-memory proof is separate from ordinary user identity. Unknown proof must
    // neither manufacture an empty list nor switch a real user request to app identity.
    if (!scope) return available({ status: 'unavailable', reason: 'scope_unknown' })
    // Official user history rule. Capture supports groups, not private messages.
    // https://open.feishu.cn/document/server-docs/im-v1/message/list.md
    const scopes = new Set(scope.split(/\s+/))
    if (!(scopes.has('im:message') || scopes.has('im:message:readonly')) || !scopes.has('im:message.group_msg:get_as_user')) return available({ status: 'denied', reason: 'scope_missing' })
    let chats
    try { chats = await this.deps.feishu.listChatsResult({ userToken: token.accessToken }, { fresh: true, assertCurrent }) }
    catch (error) {
      assertCurrent()
      const failure = providerAccessFailure(error, 'user')
      if (failure) return available({ status: 'unavailable', reason: 'chat_list_unavailable', failure })
      throw error
    }
    assertCurrent()
    return available({ status: 'ready', groups: Object.freeze(chats.items.map(chat => Object.freeze({ ...chat }))), groupsComplete: chats.complete })
  }
}

/** Captured only in closures; values are never returned or logged. */
function tokenSnapshot(token: UserToken | undefined): string {
  return JSON.stringify(token ? [token.openId, token.accessToken, token.refreshToken, token.expiresAt,
    token.refreshExpiresAt, token.scope, token.createdAt, token.updatedAt] : null)
}
