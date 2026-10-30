import { isAxiosError } from 'axios'
import { FeishuApiError } from '../feishu/client.js'
import { MinutesError } from '../feishu/minutes.js'
import { OAuthTokenError, type TokenAccessResult } from '../feishu/oauth.js'

/** Host facts, never parsed from model text or provider error messages. */
export type AccessFailureReason = 'not_connected' | 'identity_mismatch' | 'grant_invalid' | 'renewal_required' | 'access_token_expired' |
  'personal_scope_missing' | 'app_scope_missing' | 'resource_forbidden' | 'access_rejected' |
  'service_unavailable' | 'connection_changed' | 'context_changed' | 'source_unverifiable' |
  'resource_unverified' | 'audience_mismatch'
export type AccessNext = 'connect' | 'grant_scope' | 'configure_app' | 'request_resource_access' |
  'check_resource_or_configuration' | 'retry' | 'restart' | 'review_source' | 'none'
export interface AccessFailure {
  reason: AccessFailureReason
  next: AccessNext
  identity?: 'user' | 'app'
  /** Actual missing scopes obtained from the host/provider grant, never requested scopes. */
  scopes?: readonly string[]
}
const NEXT: Record<AccessFailureReason, AccessNext> = {
  not_connected: 'connect', identity_mismatch: 'connect', grant_invalid: 'connect', renewal_required: 'connect', access_token_expired: 'retry',
  personal_scope_missing: 'grant_scope', app_scope_missing: 'configure_app', resource_forbidden: 'request_resource_access',
  access_rejected: 'check_resource_or_configuration', service_unavailable: 'retry', connection_changed: 'restart',
  context_changed: 'none', source_unverifiable: 'review_source', resource_unverified: 'retry', audience_mismatch: 'none',
}
const TEXT: Record<AccessFailureReason, string> = {
  not_connected: '这次需要先连接你的飞书账号。',
  identity_mismatch: '连接身份与当前用户不一致，需要重新连接本人账号。',
  grant_invalid: '飞书已拒绝这份授权，需要重新连接。',
  renewal_required: '现有授权无法续期，需要重新连接；这不代表资料本身没有访问权限。',
  access_token_expired: '本次访问凭证已过期，需要刷新后重新核验；没有据此删除个人授权。',
  personal_scope_missing: '本次需要补充个人授权范围。',
  app_scope_missing: '应用后台尚未开通本次所需权限，需要管理员配置并发布；重新个人授权不能解决。',
  resource_forbidden: '当前身份没有这份资料的访问权限，请资料负责人核对分享范围。',
  access_rejected: '飞书拒绝了本次资料访问，需要核对资源权限和应用后台配置。',
  service_unavailable: '飞书服务或网络暂时不可用，请稍后重试；这次没有认定授权失效。',
  connection_changed: '处理期间连接已更新或断开，需要按当前连接重新核验。',
  context_changed: '这次任务或空间状态已变化，原请求没有继续执行。',
  source_unverifiable: '这轮读到的内容里有一部分我核验不了来源，所以没把结果发出来（你的授权没有问题，不用重新授权）。换个说法再问一次，或者告诉我具体看哪个群、哪个人、哪段时间。',
  resource_unverified: '本次资源范围核验不完整，暂不能确定是否有权访问，请稍后重试。',
  audience_mismatch: '这份资料只允许回到原会话或原接收人，个人授权不能扩大投递范围。',
}
export function accessFailure(reason: AccessFailureReason, details: Pick<AccessFailure, 'identity' | 'scopes'> = {}): AccessFailure {
  return { reason, next: NEXT[reason], ...(details.identity ? { identity: details.identity } : {}),
    ...(details.scopes?.length ? { scopes: [...new Set(details.scopes)] } : {}) }
}
export function accessFailureText(failure: AccessFailure): string {
  const scopes = ['personal_scope_missing', 'app_scope_missing'].includes(failure.reason) && failure.scopes?.length
    ? `本次缺少：${failure.scopes.join('、')}。` : ''
  return TEXT[failure.reason] + scopes
}
export function tokenAccessFailure(result: Exclude<TokenAccessResult, { status: 'available' }>): AccessFailure {
  return accessFailure(result.status === 'denied'
    ? result.reason === 'invalid_grant' ? 'grant_invalid' : 'not_connected'
    : result.reason === 'connection_changed' ? 'connection_changed'
      : result.reason === 'refresh_unavailable' ? 'renewal_required' : 'service_unavailable', { identity: 'user' })
}

/** Only recognizable provider / I/O failures are classified. Programmer and host
 * lease errors remain exceptions, so they cannot masquerade as a network outage. */
export function providerAccessFailure(error: unknown, identity: 'user' | 'app'): AccessFailure | undefined {
  if (error instanceof OAuthTokenError) return accessFailure(error.reason === 'invalid_grant' ? 'grant_invalid' : 'service_unavailable', { identity })
  // Provider protocol adapter: https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code
  // No message regex: 99991672 is application permission even on a user-token call.
  if (error instanceof FeishuApiError || error instanceof MinutesError) {
    // Official message.get errors distinguish resource visibility/deletion from
    // app availability and grant configuration; none is an OAuth revocation.
    // https://open.feishu.cn/document/server-docs/im-v1/message/get
    if (error instanceof FeishuApiError) {
      if (error.code === 230050) return accessFailure('resource_forbidden', { identity })
      if (error.code === 230110) return accessFailure('source_unverifiable', { identity })
      if ([230002, 230006, 230013, 230027].includes(error.code)) return accessFailure('access_rejected', { identity })
    }
    if (error.code === 99991672) return accessFailure('app_scope_missing', { identity })
    if (error.code === 99991679 && identity === 'user') return accessFailure('personal_scope_missing', { identity })
    if (error.code === 99991677 && identity === 'user') return accessFailure('access_token_expired', { identity })
    if (error.code !== undefined && [99991663, 99991668, 99991673, 99991676, 99991679].includes(error.code)) return accessFailure('access_rejected', { identity })
    return undefined
  }
  if (!isAxiosError(error)) return undefined
  const status = error.response?.status
  if (status === 401 || status === 403) return accessFailure('access_rejected', { identity })
  if (status === 429 || status !== undefined && status >= 500 && status <= 599 ||
    !error.response && ['ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK', 'ERR_SOCKET_CLOSED'].includes(error.code ?? '')) {
    return accessFailure('service_unavailable', { identity })
  }
  return undefined
}
