import type { FeishuClient } from '../feishu/client.js'
import { USER_SCOPE_TIERS, type UserTokenStore } from '../feishu/oauth.js'
import { providerAccessFailure } from './access-failure.js'
import { MyDayError } from './my-day.js'
import type { PersonalAssistantHostDeps, PersonalCalendarRead } from './personal-assistant-host.js'

/** Read-only personal calendar adapter. Actual grant scope is authoritative;
 * requested scopes and application-identity access never substitute for it. */
export function createMyDayCalendar(deps: {
  userTokens?: Pick<UserTokenStore, 'get' | 'accessTokenResult' | 'expireAccessToken'>
  feishu: Pick<FeishuClient, 'listMyEventsPage'>
}): PersonalAssistantHostDeps['readCalendar'] {
  return async (openId, range, assertCurrent) => {
    assertCurrent()
    const store = deps.userTokens, before = store?.get(openId)
    if (!store || !before) return gap('missing_connection')
    const hasScope = () => {
      const scope = new Set(store.get(openId)?.scope.split(/\s+/).filter(Boolean))
      return USER_SCOPE_TIERS.calendar.every(item => scope.has(item))
    }
    if (!hasScope()) return gap('missing_scope')
    const access = await store.accessTokenResult(openId)
    assertCurrent()
    if (access.status !== 'available') {
      // Loss/replacement during an await invalidates the read, rather than
      // relabelling the previous person's data as a harmless missing section.
      if (!store.get(openId) || access.reason === 'connection_changed') throw new MyDayError('changed')
      return gap(access.reason === 'refresh_failed' ? 'network_unavailable' : 'missing_connection')
    }
    const current = () => {
      assertCurrent()
      if (!access.isCurrent() || !hasScope()) throw new MyDayError('changed')
    }
    current()
    const grant = store.get(openId)!
    try {
      const result = await deps.feishu.listMyEventsPage({ userToken: access.accessToken }, range, current)
      current()
      return { status: 'available', ...result, assertCurrent: current }
    } catch (error) {
      current()
      const failure = providerAccessFailure(error, 'user')
      if (!failure) throw error
      if (failure.reason === 'personal_scope_missing') return gap('missing_scope')
      if (failure.reason === 'service_unavailable') return gap('network_unavailable')
      if (failure.reason === 'access_token_expired') {
        // A provider expiry is not revocation. Preserve the connection and let
        // the existing token store refresh on the next read, without a card.
        store.expireAccessToken(openId, grant)
        return gap('network_unavailable')
      }
      if (['grant_invalid', 'not_connected', 'renewal_required'].includes(failure.reason)) return gap('missing_connection')
      if (['app_scope_missing', 'resource_forbidden', 'access_rejected'].includes(failure.reason)) return gap('resource_denied')
      throw error
    }
  }
}

function gap(reason: Extract<PersonalCalendarRead, { status: 'unavailable' }>['reason']): PersonalCalendarRead {
  return { status: 'unavailable', reason }
}
