import { AxiosError } from 'axios'
import { describe, expect, it } from 'vitest'
import { accessFailure, accessFailureText, providerAccessFailure, tokenAccessFailure } from '../src/core/access-failure.js'
import { FeishuApiError } from '../src/feishu/client.js'
import { OAuthTokenError } from '../src/feishu/oauth.js'
import { UserMessageReadChanged } from '../src/core/user-message-read-lease.js'

describe('host access failure categories', () => {
  it.each([
    ['not_connected', 'not_connected', 'connect'], ['invalid_grant', 'grant_invalid', 'connect'],
    ['refresh_failed', 'service_unavailable', 'retry'], ['refresh_unavailable', 'renewal_required', 'connect'],
    ['connection_changed', 'connection_changed', 'restart'],
  ] as const)('keeps token outcome %s distinct', (reason, expected, next) => {
    const token = reason === 'not_connected' || reason === 'invalid_grant'
      ? { status: 'denied' as const, reason } : { status: 'unavailable' as const, reason }
    expect(tokenAccessFailure(token)).toEqual({ reason: expected, next, identity: 'user' })
  })
  it('uses structured provider scope categories, never their permission wording', () => {
    expect(providerAccessFailure(new FeishuApiError('test', 99991672, 'opaque'), 'user'))
      .toMatchObject({ reason: 'app_scope_missing', next: 'configure_app', identity: 'user' })
    expect(providerAccessFailure(new FeishuApiError('test', 99991679, 'opaque'), 'user'))
      .toMatchObject({ reason: 'personal_scope_missing', next: 'grant_scope' })
    expect(providerAccessFailure(new FeishuApiError('test', 99991677, 'opaque'), 'user'))
      .toMatchObject({ reason: 'access_token_expired', next: 'retry' })
    expect(providerAccessFailure(new FeishuApiError('test', 99991663, 'opaque'), 'app'))
      .toMatchObject({ reason: 'access_rejected', next: 'check_resource_or_configuration' })
    expect(providerAccessFailure(new FeishuApiError('test', 11223344, 'permission forbidden invalid_grant SECRET'), 'user')).toBeUndefined()
  })
  it('does not treat host cancellation, programming errors or unknown SDK failures as network', () => {
    for (const error of [new UserMessageReadChanged(), new TypeError('programming defect'), new Error('permission SECRET'),
      new AxiosError('bad option', 'ERR_BAD_OPTION_VALUE'), new AxiosError('cancelled', 'ERR_CANCELED')]) {
      expect(providerAccessFailure(error, 'user')).toBeUndefined()
    }
  })
  it.each([
    [230050, 'resource_forbidden', 'request_resource_access'],
    [230110, 'source_unverifiable', 'review_source'],
    [230013, 'access_rejected', 'check_resource_or_configuration'],
  ])('retains the message access cause %s without requesting OAuth again', (code, reason, next) => {
    const failure = providerAccessFailure(new FeishuApiError('message.get', Number(code), 'PRIVATE_PROVIDER_DETAIL'), 'user')
    expect(failure).toMatchObject({ reason, next, identity: 'user' })
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_PROVIDER_DETAIL')
  })
  it('reports actual transport and OAuth failures with fixed safe messages', () => {
    for (const error of [new AxiosError('Bearer SECRET', 'ECONNRESET'), new OAuthTokenError('unavailable')]) {
      const failure = providerAccessFailure(error, 'user')!
      expect(failure).toMatchObject({ reason: 'service_unavailable', next: 'retry' })
      expect(JSON.stringify(failure) + accessFailureText(failure)).not.toContain('SECRET')
    }
  })
  it('does not send people to personal OAuth for app permission or resource denial', () => {
    expect(accessFailure('app_scope_missing', { identity: 'app', scopes: ['im:chat:readonly'] }).next).toBe('configure_app')
    expect(accessFailure('resource_forbidden', { identity: 'user' }).next).toBe('request_resource_access')
    expect(accessFailure('audience_mismatch').next).toBe('none')
  })
})
