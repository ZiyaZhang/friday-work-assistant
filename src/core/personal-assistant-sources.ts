import { createHash } from 'node:crypto'
import { providerAccessFailure } from './access-failure.js'
import type { ExecutionSourceAccessResult } from './execution-source-access.js'
import type { Inbox } from './inbox.js'
import { MyDayError } from './my-day.js'
import type { MyDaySourceRead } from './personal-assistant-host.js'
import type { PolicyService } from './policy.js'
import { assertRequestCurrent } from './request-lease.js'
import { AUTH_EXPIRED, type RoutineStore } from './routines.js'
import { dmSpaceId, spaceScope, type Spaces } from './space.js'
import { responsibleOpenId, todoTag, type Todos } from './todos.js'

/** A domain-row read, not a message, directory lookup, or public grant. */
export interface MyDayDomainSourceReceipt {
  version: 1
  kind: 'todo' | 'decision'
  id: number
  appId: string
  sourceSpaceId: string
  sourceChatId: string
  sourceScope: string
  sourceSessionKey: string | null
  viewerOpenId: string
  privateSpaceId: string
  privateChatId: string
  contentDigest: string
}
export interface MyDayDomainSourceAudience { openId: string; spaceId: string; chatId: string; chatType: 'group' | 'p2p' }
type DomainRead = Exclude<MyDaySourceRead, { kind: 'calendar' }>
export interface PersonalAssistantSourceDeps {
  appId: string
  spaces: Pick<Spaces, 'get' | 'byChat' | 'roleOf'>
  policy: Pick<PolicyService, 'decide'>
  todos: Pick<Todos, 'get' | 'getForAudience' | 'getProvenance'>
  inbox: Pick<Inbox, 'get'>
  routines?: Pick<RoutineStore, 'get'>
  readable(openId: string, chatId: string): boolean
  members(chatId: string, assertCurrent: () => void): Promise<ReadonlySet<string>>
}

export function validMyDayDomainSource(value: unknown): value is MyDayDomainSourceReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return v.version === 1 && (v.kind === 'todo' || v.kind === 'decision') && Number.isSafeInteger(v.id) && Number(v.id) > 0 &&
    ['appId', 'sourceSpaceId', 'sourceChatId', 'sourceScope', 'viewerOpenId', 'privateSpaceId', 'privateChatId'].every(key => typeof v[key] === 'string' && Boolean(v[key])) &&
    (v.sourceSessionKey === null || typeof v.sourceSessionKey === 'string' && Boolean(v.sourceSessionKey)) &&
    typeof v.contentDigest === 'string' && /^[a-f0-9]{64}$/.test(v.contentDigest)
}

/** Capture is called synchronously by the host's already-authorized My Day read
 * hook; it is not an authorization endpoint. Every later consumption rechecks
 * current app membership of the original group and the exact retained row. */
export function createPersonalAssistantSources(deps: PersonalAssistantSourceDeps): {
  capture(read: DomainRead, audience: MyDayDomainSourceAudience, assertCurrent: () => void): MyDayDomainSourceReceipt
  check(sources: readonly MyDayDomainSourceReceipt[], audience: MyDayDomainSourceAudience, assertCurrent: () => void): Promise<ExecutionSourceAccessResult>
} {
  const ownPrivate = (audience: MyDayDomainSourceAudience) => {
    const space = deps.spaces.get(audience.spaceId)
    return Boolean(audience.openId && audience.chatType === 'p2p' && audience.spaceId === dmSpaceId(audience.openId) &&
      space?.status === 'active' && space.kind === 'p2p' && space.chatId === audience.chatId &&
      deps.spaces.roleOf(space.id, audience.openId) === 'owner' &&
      deps.policy.decide({ spaceId: space.id, openId: audience.openId, action: 'read' }).decision === 'allow')
  }
  const groupCurrent = (spaceId: string, chatId: string, openId: string) => {
    const space = deps.spaces.get(spaceId)
    return Boolean(space?.status === 'active' && space.kind === 'group' && space.chatId === chatId && deps.readable(openId, chatId) !== false)
  }
  const originOf = (scope: string) => scope.startsWith('space:') ? deps.spaces.get(scope.slice(6))
    : scope.startsWith('chat:') ? deps.spaces.byChat(scope.slice(5), true) : undefined

  const snapshot = (read: DomainRead, audience: MyDayDomainSourceAudience): MyDayDomainSourceReceipt | undefined => {
    if (!deps.appId || !ownPrivate(audience) || !groupCurrent(read.spaceId, read.chatId, audience.openId)) return undefined
    let sourceScope: string, sourceSessionKey: string | null, content: unknown
    const id = read.kind === 'todo' ? read.todoId : read.inboxId
    if (read.kind === 'todo') {
      const todo = deps.todos.get(id), space = todo && originOf(todo.scope)
      if (!todo || space?.id !== read.spaceId || space.chatId !== read.chatId || responsibleOpenId(todo) !== audience.openId) return undefined
      const visible = deps.todos.getForAudience(id, { scope: todo.scope, chatId: read.chatId, chatType: 'group', openId: audience.openId })
      if (!visible || todoTag(visible) !== todoTag(todo)) return undefined
      sourceScope = todo.scope; sourceSessionKey = todo.sessionKey
      content = [todoTag(todo), todo.origin, deps.todos.getProvenance(id)]
    } else {
      const item = deps.inbox.get(id)
      if (!item || item.ownerOpenId !== audience.openId || item.spaceId !== read.spaceId || item.resolvedAt !== null) return undefined
      if (item.refId !== null) {
        if (item.kind === 'responsibility' && deps.routines?.get(item.refId)?.status !== 'proposed') return undefined
        if (item.kind === 'auth' && deps.routines?.get(item.refId)?.disabledReason !== AUTH_EXPIRED) return undefined
      }
      // Content only: a reminder nudge (nudges / last_nudged_at) is not a change to what was shown.
      sourceScope = spaceScope(read.spaceId); sourceSessionKey = null
      content = [item.id, item.ownerOpenId, item.kind, item.refId, item.spaceId, item.title, item.why, item.createdAt, item.resolvedAt]
    }
    return { version: 1, kind: read.kind, id, appId: deps.appId, sourceSpaceId: read.spaceId, sourceChatId: read.chatId,
      sourceScope, sourceSessionKey, viewerOpenId: audience.openId, privateSpaceId: audience.spaceId, privateChatId: audience.chatId,
      contentDigest: digest(content) }
  }
  const matches = (source: MyDayDomainSourceReceipt, audience: MyDayDomainSourceAudience) => {
    if (!validMyDayDomainSource(source) || source.appId !== deps.appId || source.viewerOpenId !== audience.openId ||
      source.privateSpaceId !== audience.spaceId || source.privateChatId !== audience.chatId) return false
    const read: DomainRead = source.kind === 'todo'
      ? { kind: 'todo', todoId: source.id, spaceId: source.sourceSpaceId, chatId: source.sourceChatId }
      : { kind: 'decision', inboxId: source.id, spaceId: source.sourceSpaceId, chatId: source.sourceChatId }
    const current = snapshot(read, audience)
    return Boolean(current && digest(current) === digest(source))
  }
  return {
    capture(read, audience, assertCurrent) {
      assertRequestCurrent(); assertCurrent()
      const result = snapshot(read, audience)
      if (!result) throw new MyDayError('changed')
      assertCurrent()
      return Object.freeze(result)
    },
    async check(sources, audienceInput, assertCaller) {
      const saved = structuredClone(sources), audience = { ...audienceInput }
      const caller = () => { assertRequestCurrent(); assertCaller() }
      caller()
      if (!saved.every(source => matches(source, audience))) return { status: 'denied', reason: 'domain_source_or_audience_changed', assertCurrent: caller }
      const current = () => {
        caller()
        if (!saved.every(source => matches(source, audience))) throw new MyDayError('changed')
      }
      // One fresh membership read for each actual source group in this check;
      // unrelated same-session groups never enter this set.
      for (const chatId of new Set(saved.map(source => source.sourceChatId))) {
        current()
        let members: ReadonlySet<string>
        try { members = await deps.members(chatId, current) }
        catch (error) {
          current()
          const failure = providerAccessFailure(error, 'app')
          if (failure?.reason === 'service_unavailable') return { status: 'unavailable', reason: 'domain_membership_unavailable', assertCurrent: current }
          if (failure && ['app_scope_missing', 'resource_forbidden', 'access_rejected'].includes(failure.reason)) {
            return { status: 'denied', reason: 'domain_membership_denied', assertCurrent: current }
          }
          throw error
        }
        current()
        if (!members.has(audience.openId)) return { status: 'denied', reason: 'domain_membership_denied', assertCurrent: current }
      }
      current()
      return { status: 'allowed', assertCurrent: current }
    },
  }
}

/** Stable structural digest; object key order is not a content revision. */
function digest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : item
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
