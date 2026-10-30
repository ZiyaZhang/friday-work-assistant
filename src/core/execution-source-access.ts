import { FeishuApiError, type FeishuClient } from '../feishu/client.js'
import { MINUTES_SCOPES, MinutesError, parseMinutesSourceRef, type FeishuMinutes, type MinutesSource } from '../feishu/minutes.js'
import type { UserTokenStore } from '../feishu/oauth.js'
import type { Circles } from './circles.js'
import type { PersonalMemoryAccess } from './personal-memory-access.js'
import type { PolicyService } from './policy.js'
import { validPersonalRepository, type SourceContext } from './source-context.js'
import { dmSpaceId, type Space, type Spaces } from './space.js'
import { UserMessageReadChanged, type UserMessageReadAccess } from './user-message-read-lease.js'
import { hasCurrentWebLinkGrant } from './web-egress.js'
import { hasCurrentDeliveredMessages, type VerifyDeliveredMessage } from './delivered-message-source.js'
import { conversationCoversMemorySource, validConversationReads, verifyConversationMessages } from './conversation-read-source.js'
import { providerAccessFailure, type AccessFailure } from './access-failure.js'
import type { ChatReadScope } from './chat-read-scope.js'
import { validMyDayDomainSource, type MyDayDomainSourceAudience, type MyDayDomainSourceReceipt } from './personal-assistant-sources.js'
import { validMeetingSource, type MeetingSourceReceipt, type MeetingSourceAudience } from './meeting-source.js'
import { validPollSource, type PollSourceReceipt, type PollSourceAudience } from './poll-source.js'

/** All fields and closures come from the host's exact Run/material version, never tool arguments. */
export interface ExecutionSourceActor {
  runId: string
  openId: string
  spaceId: string
  chatId: string
  chatType: 'group' | 'p2p'
  /** Original ACP of this candidate material/history, not a replacement ACP identity. */
  acpSessionId: string
  /** Includes current Run, complete registered material generation/version and exact memory revisions.
   * An empty manifest cannot make unknown native material eligible for import. */
  assertCurrent(): void
  readScopes(): readonly string[]
}
export type ExecutionSourceAccessResult =
  | { status: 'allowed'; assertCurrent(): void }
  | { status: 'denied' | 'unavailable'; reason: string; assertCurrent(): void }

export interface ExecutionSourceAccessDeps {
  appId: string
  checkMcpSource?(owner: string, ref: string, guard: () => void): Promise<() => void>
  checkGmailSource?(owner: string, ref: string, guard: () => void): Promise<() => void>
  verifyDeliveredMessage?: VerifyDeliveredMessage
  /** Current app membership and exact row for group items a My Day read showed; absent means unverifiable. */
  checkMyDaySources?: (sources: readonly MyDayDomainSourceReceipt[], audience: MyDayDomainSourceAudience, assertCurrent: () => void) => Promise<ExecutionSourceAccessResult>
  checkMeetingSources?: (sources: readonly MeetingSourceReceipt[], audience: MeetingSourceAudience, assertCurrent: () => void) => Promise<ExecutionSourceAccessResult>
  checkPollSources?: (sources: readonly PollSourceReceipt[], audience: PollSourceAudience, assertCurrent: () => void) => Promise<ExecutionSourceAccessResult>
  spaces: Pick<Spaces, 'get' | 'byChat' | 'roleOf'>
  policy: Pick<PolicyService, 'decide'>
  circles?: Pick<Circles, 'circleOf'>
  personalMemory: Pick<PersonalMemoryAccess, 'checkRead'>
  userReads: Pick<UserMessageReadAccess, 'open'>
  feishu: Pick<FeishuClient, 'listChatsResult' | 'chatMemberOpenIds' | 'readDocument' | 'listMyEvents'>
    & Partial<Pick<FeishuClient, 'getMessage'>>
  readScope?: Pick<ChatReadScope, 'isReadable'>
  minutes?: Pick<FeishuMinutes, 'recent' | 'brief' | 'artifacts'>
  userTokens?: Pick<UserTokenStore, 'get'>
  /** Current deployment/Space repository allowlist, bound by the host; this cannot grant writes. */
  repositoryAllowed(repository: string): boolean
  personalRepositoryAllowed?(owner: string, repository: string, receipts: SourceContext['personalRepositories']): boolean
}

/** Revalidates recorded inputs before disclosing material or resuming history. No writes or publishing. */
export class ExecutionSourceAccess {
  constructor(private readonly deps: ExecutionSourceAccessDeps) {}

  async check(inputActor: ExecutionSourceActor, inputSource: SourceContext): Promise<ExecutionSourceAccessResult> {
    const actor = { ...inputActor }, source = structuredClone(inputSource)
    actor.assertCurrent()
    const guards: (() => void)[] = []
    if (!validSource(source)) return { status: 'unavailable', reason: 'source_incomplete', assertCurrent: actor.assertCurrent }
    const snapshot = () => this.snapshot(actor, source), initial = snapshot(), signature = JSON.stringify(initial)
    const assertBase = () => {
      actor.assertCurrent()
      if (JSON.stringify(snapshot()) !== signature) throw new UserMessageReadChanged()
    }
    const assertCurrent = () => {
      assertBase()
      for (const guard of guards) guard()
    }
    // A nested lease must not close over a mutable guard list that later contains itself.
    const priorGuard = () => {
      const prior = [...guards]
      return () => { assertBase(); for (const guard of prior) guard() }
    }
    const result = (status: 'allowed' | 'denied' | 'unavailable', reason?: string): ExecutionSourceAccessResult => {
      assertCurrent()
      return status === 'allowed' ? { status, assertCurrent } : { status, reason: reason!, assertCurrent }
    }
    if (!actor.runId || !actor.openId || !actor.acpSessionId || source.acpSessionId !== actor.acpSessionId ||
      source.spaceId !== actor.spaceId || source.chatId !== actor.chatId) return result('denied', 'binding_changed')
    if (!initial.target || initial.target.status !== 'active' || initial.target.kind !== actor.chatType ||
      initial.target.chatId !== actor.chatId || !initial.role || initial.read !== 'allow' ||
      actor.chatType === 'p2p' && (actor.spaceId !== dmSpaceId(actor.openId) || initial.role !== 'owner')) return result('denied', 'target_forbidden')
    if (initial.memoryScopes.some(allowed => !allowed)) return result('denied', 'read_scope_changed')
    if (!initial.readScope) return result('denied', 'read_scope_changed')
    if (initial.repositories.some(allowed => !allowed)) return result('denied', 'repository_denied')
    if (source.personalRepositories?.length && (actor.chatType !== 'p2p' || !source.personalRepositories.every(validPersonalRepository) ||
      source.personalRepositories.some(item => item.owner !== actor.openId))) return result('denied', 'source_identity_mismatch')
    if (!initial.deliveredMessages) return result('unavailable', 'delivered_message_unverified')
    if (source.myDaySources?.length) {
      if (!this.deps.checkMyDaySources) return result('unavailable', 'my_day_source_unverified')
      const access = await this.deps.checkMyDaySources(source.myDaySources, actor, priorGuard())
      assertCurrent(); access.assertCurrent(); guards.push(access.assertCurrent)
      if (access.status !== 'allowed') return result(access.status, access.reason)
    }
    if (source.meetingSources?.length) {
      if (!this.deps.checkMeetingSources) return result('unavailable', 'meeting_source_unverified')
      const access = await this.deps.checkMeetingSources(source.meetingSources, actor, priorGuard())
      assertCurrent(); access.assertCurrent(); guards.push(access.assertCurrent)
      if (access.status !== 'allowed') return result(access.status, access.reason)
    }
    if (source.pollSources?.length) {
      if (!this.deps.checkPollSources) return result('unavailable', 'poll_source_unverified')
      const access = await this.deps.checkPollSources(source.pollSources, actor, priorGuard())
      assertCurrent(); access.assertCurrent(); guards.push(access.assertCurrent)
      if (access.status !== 'allowed') return result(access.status, access.reason)
    }

    const personalSources = (source.messageSources ?? []).filter(item => item.readIdentity.kind === 'user')
    const ordinary = source.conversationReads?.items ?? []
    const ordinaryPersonal = ordinary.filter(item => item.readIdentity.kind === 'user')
    const personalChats = new Set([...personalSources.map(item => item.chatId), ...ordinaryPersonal.map(item => item.chatId)])
    const botChats = new Map<string, string | undefined>()
    for (const item of source.chats) if (!personalChats.has(item.chatId)) botChats.set(item.chatId, item.spaceId)
    for (const item of source.messageSources ?? []) {
      if (item.readIdentity.kind === 'app') {
        if (item.appId !== this.deps.appId) return result('denied', 'source_app_mismatch')
        if (!item.chatId) return result('unavailable', 'source_incomplete')
        botChats.set(item.chatId, item.spaceId ?? botChats.get(item.chatId))
      }
    }
    for (const item of ordinary) {
      if (item.appId !== this.deps.appId) return result('denied', 'source_app_mismatch')
      if (item.readIdentity.kind === 'app') botChats.set(item.chatId, item.spaceId ?? botChats.get(item.chatId))
      else if (item.readIdentity.openId !== actor.openId) return result('denied', 'source_identity_mismatch')
    }
    if (source.conversationReads?.complete === false) return result('unavailable', 'source_incomplete')
    // Group invocations use the app read path. A personal source can never become a group input.
    if ((personalSources.length || ordinaryPersonal.length) && actor.chatType !== 'p2p') return result('denied', 'source_identity_mismatch')
    for (const binding of initial.chats) {
      if (binding.recordedSpaceId && (!binding.original || binding.original.chatId !== binding.chatId || binding.original.status !== 'active')) return result('denied', 'source_binding_changed')
      if (binding.current && (binding.current.kind !== 'group' && !ordinaryPersonal.some(item => item.chatId === binding.chatId) || binding.current.status !== 'active' ||
        binding.recordedSpaceId && binding.current.id !== binding.recordedSpaceId)) return result('denied', 'source_binding_changed')
    }
    // Missing identity in an old DM manifest is not evidence it was an app read.
    if (actor.chatType === 'p2p' && [...botChats.keys()].some(chatId => !(source.messageSources ?? []).some(item =>
      item.chatId === chatId && item.readIdentity.kind === 'app') && !ordinary.some(item =>
      item.chatId === chatId && item.readIdentity.kind === 'app'))) return result('unavailable', 'source_identity_unknown')
    for (const [chatId, recordedSpace] of botChats) {
      const bound = recordedSpace ? this.deps.spaces.get(recordedSpace) : this.deps.spaces.byChat(chatId, true)
      if (!bound) return result('unavailable', 'source_binding_unknown')
      if (bound.status !== 'active' || bound.kind !== 'group' || bound.chatId !== chatId) return result('denied', 'source_binding_changed')
      if (actor.chatType === 'group' && chatId !== actor.chatId &&
        (!initial.circle || this.deps.circles?.circleOf(chatId) !== initial.circle)) return result('denied', 'source_outside_circle')
    }
    for (const item of source.external) {
      if (item.kind === 'web') {
        // Same-Run registered materials retain the original link audience. An old
        // Run/public record has no current link revalidation: rebuild history or
        // refuse import instead of silently replaying a capability URL.
        if (!hasCurrentWebLinkGrant(item, { ...actor, actorOpenId: actor.openId })) return result('unavailable', 'web_link_grant_unconfirmed')
        continue
      }
      if (actor.chatType !== 'p2p' || !item.personalOpenId) return result('unavailable', 'external_identity_unsupported')
      if (item.personalOpenId !== actor.openId) return result('denied', 'source_identity_mismatch')
      if (item.kind === 'gmail' || item.kind === 'mcp') {
        const checker = item.kind === 'mcp' ? this.deps.checkMcpSource : this.deps.checkGmailSource
        if (item.access !== 'user' || !checker) return result('denied', 'mail_connection_missing')
        try { guards.push(await checker(actor.openId, item.ref, priorGuard())) }
        catch { return result('unavailable', 'mail_source_unverified') }
        assertCurrent(); continue
      }
      if (!externalRef(item)) return result('unavailable', 'external_reference_unsupported')
    }

    // Fresh app membership proves the current group actor, not membership in every allied group.
    const memberChats = new Set(actor.chatType === 'group' ? [actor.chatId] : botChats.keys())
    for (const chatId of memberChats) {
      let members
      try { members = await this.deps.feishu.chatMemberOpenIds(chatId, { fresh: true }) }
      catch { return result('unavailable', 'membership_unavailable') }
      assertCurrent()
      // This existing port has no pagination-completeness field. Absence is not a revocation proof.
      if (!members.has(actor.openId)) return result('unavailable', 'membership_unconfirmed')
    }
    if (botChats.size) {
      let chats
      try { chats = await this.deps.feishu.listChatsResult({}, { fresh: true }) }
      catch { return result('unavailable', 'chat_list_unavailable') }
      assertCurrent()
      const ids = new Set(chats.items.map(chat => chat.chatId))
      if ([...botChats.keys()].some(chatId => !ids.has(chatId))) return result(chats.complete ? 'denied' : 'unavailable',
        chats.complete ? 'chat_not_accessible' : 'chat_list_incomplete')
    }
    const legacyPersonalSources = personalSources.filter(item => !conversationCoversMemorySource(source.conversationReads, item))
    if (legacyPersonalSources.length) {
      const access = await this.deps.personalMemory.checkRead({ spaceId: actor.spaceId, openId: actor.openId }, legacyPersonalSources, priorGuard())
      assertCurrent(); access.assertCurrent(); guards.push(access.assertCurrent)
      if (access.status !== 'allowed') return result(access.status, access.reason)
    }
    if (ordinaryPersonal.length) {
      const access = await this.deps.userReads.open(actor.openId, priorGuard())
      assertCurrent()
      if (access.status !== 'available') { guards.push(access.assertCurrent); return result(access.status, access.reason) }
      const lease = access.lease
      lease.assertCurrent(); guards.push(lease.assertCurrent)
      if (ordinaryPersonal.some(item => item.readIdentity.kind !== 'user' || item.readIdentity.tenantId !== lease.authority.tenantId)) return result('denied', 'source_identity_mismatch')
      let chats, directoryFailure: AccessFailure | undefined
      try { chats = await this.deps.feishu.listChatsResult(lease.as, { fresh: true, assertCurrent }) }
      catch (error) {
        assertCurrent()
        directoryFailure = providerAccessFailure(error, 'user')
        if (!directoryFailure) throw error
      }
      assertCurrent()
      const groups = new Set(chats?.items.map(chat => chat.chatId) ?? [])
      for (const chatId of new Set(ordinaryPersonal.map(item => item.chatId))) {
        if (groups.has(chatId)) continue
        if (directoryFailure && ordinaryPersonal.some(item => item.chatId === chatId && item.kind !== 'message')) return result('unavailable', directoryFailure.reason)
        if (!this.deps.feishu.getMessage) return result('unavailable', 'source_incomplete')
        const failure = await verifyConversationMessages(source.conversationReads, chatId, {
          appId: this.deps.appId, openId: actor.openId, tenantId: lease.authority.tenantId, as: lease.as,
          feishu: { getMessage: this.deps.feishu.getMessage.bind(this.deps.feishu) }, assertCurrent,
        })
        assertCurrent()
        if (failure) return result(['identity_mismatch', 'resource_forbidden', 'access_rejected'].includes(failure.reason) ? 'denied' : 'unavailable', failure.reason)
      }
    }
    const personalExternal = source.external.filter(item => item.kind !== 'web' && item.kind !== 'gmail' && item.kind !== 'mcp')
    if (personalExternal.length) {
      // Same original user for every external ref. Message capture scopes do not authorize or block external reads.
      const access = await this.deps.userReads.open(actor.openId, priorGuard())
      assertCurrent()
      if (access.status !== 'available') { guards.push(access.assertCurrent); return result(access.status, access.reason) }
      const lease = access.lease
      lease.assertCurrent(); guards.push(lease.assertCurrent)
      for (const item of personalExternal) {
        const ref = externalRef(item)!
        try {
          if (ref.kind === 'minutes') {
            if (!this.deps.minutes || !this.deps.userTokens || !lease.as.userToken) return result('unavailable', 'minutes_unavailable')
            const receipt = ref.source
            const assertPrior = priorGuard()
            const assertMinutes = () => {
              assertPrior()
              const grant = this.deps.userTokens!.get(actor.openId)
              if (!grant || grant.accessToken !== lease.as.userToken || !new Set(grant.scope.split(/[\s,]+/)).has(MINUTES_SCOPES[receipt.operation])) throw new UserMessageReadChanged()
            }
            const grant = this.deps.userTokens.get(actor.openId)
            if (!grant || !new Set(grant.scope.split(/[\s,]+/)).has(MINUTES_SCOPES[receipt.operation])) return result('denied', 'minutes_scope_missing')
            assertMinutes()
            guards.push(assertMinutes)
            if (receipt.operation === 'search') {
              const search = await this.deps.minutes.recent(lease.as.userToken, receipt.range, receipt.limit,
                { query: receipt.query, pageToken: receipt.pageToken, assertCurrent: assertMinutes })
              assertMinutes()
              const visible = new Set(search.items.map(minute => minute.token))
              if (receipt.tokens.some(token => !visible.has(token)) || receipt.complete && !search.coverage.complete) return result('unavailable', 'minutes_search_unconfirmed')
            } else if (receipt.operation === 'get') {
              await this.deps.minutes.brief(lease.as.userToken, receipt.token, assertMinutes)
              assertMinutes()
            } else {
              await this.deps.minutes.artifacts(lease.as.userToken, receipt.token, assertMinutes)
              assertMinutes()
            }
          } else if (ref.kind === 'calendar') await this.deps.feishu.listMyEvents(lease.as, ref.range)
          else {
            const document = await this.deps.feishu.readDocument(ref, lease.as)
            if (document.objType !== 'docx') return result('unavailable', 'external_reference_unsupported')
          }
        } catch (error) {
          const denied = error instanceof FeishuApiError && error.isPermission || error instanceof MinutesError &&
            (error.reason === 'scope' || error.reason === 'authentication' || error.code === 2091005)
          return result(denied ? 'denied' : 'unavailable', denied ? 'external_denied' : 'external_unavailable')
        }
        assertCurrent()
      }
    }
    return result('allowed')
  }

  private snapshot(actor: ExecutionSourceActor, source: SourceContext) {
    const target = this.deps.spaces.get(actor.spaceId), scopes = new Set(actor.readScopes())
    // Keep every original binding, including two recorded versions of the same chat.
    const allChats = [...source.chats]
    for (const item of source.messageSources ?? []) if (item.chatId) allChats.push({ chatId: item.chatId, spaceId: item.spaceId ?? undefined })
    for (const item of source.conversationReads?.items ?? []) allChats.push({ chatId: item.chatId, spaceId: item.spaceId ?? undefined })
    return { target: binding(target), role: this.deps.spaces.roleOf(actor.spaceId, actor.openId),
      deliveredMessages: hasCurrentDeliveredMessages(source.deliveredMessages, { appId: this.deps.appId,
        actorOpenId: actor.openId, spaceId: actor.spaceId, chatId: actor.chatId, chatType: actor.chatType }, this.deps.verifyDeliveredMessage),
      read: this.deps.policy.decide({ spaceId: actor.spaceId, openId: actor.openId, action: 'read' }).decision,
      memoryScopes: source.memoryScopes.map(scope => scopes.has(scope)),
      readScope: actor.chatType !== 'p2p' || allChats.every(item => item.chatId === actor.chatId || this.deps.readScope?.isReadable(actor.openId, item.chatId) !== false),
      repositories: source.repositories.map(repo => actor.chatType === 'p2p' && this.deps.personalRepositoryAllowed
        ? this.deps.personalRepositoryAllowed(actor.openId, repo, source.personalRepositories) : this.deps.repositoryAllowed(repo) === true),
      circle: this.deps.circles?.circleOf(actor.chatId),
      chats: allChats.map(({ chatId, spaceId }) => ({ chatId, recordedSpaceId: spaceId, original: spaceId ? binding(this.deps.spaces.get(spaceId)) : null,
        current: binding(this.deps.spaces.byChat(chatId, true)), circle: this.deps.circles?.circleOf(chatId) })),
    }
  }
}

function binding(space: Space | undefined) { return space ? { id: space.id, kind: space.kind, chatId: space.chatId, status: space.status } : null }
function validSource(source: SourceContext): boolean {
  return source?.version === 1 && typeof source.acpSessionId === 'string' && typeof source.spaceId === 'string' && typeof source.chatId === 'string' &&
    Array.isArray(source.memoryScopes) && source.memoryScopes.every(scope => typeof scope === 'string' && Boolean(scope)) &&
    Array.isArray(source.chats) && source.chats.every(chat => typeof chat?.chatId === 'string' && Boolean(chat.chatId) && (chat.spaceId === undefined || typeof chat.spaceId === 'string')) &&
    Array.isArray(source.repositories) && source.repositories.every(repo => typeof repo === 'string' && Boolean(repo)) &&
    Array.isArray(source.external) && source.external.every(item => item && ['document', 'calendar', 'minutes', 'web', 'gmail', 'mcp'].includes(item.kind) && typeof item.ref === 'string') &&
    (source.conversationReads === undefined || validConversationReads(source.conversationReads)) &&
    (source.myDaySources === undefined || Array.isArray(source.myDaySources) && source.myDaySources.every(validMyDayDomainSource)) &&
    (source.meetingSources === undefined || Array.isArray(source.meetingSources) && source.meetingSources.every(validMeetingSource)) &&
    (source.pollSources === undefined || Array.isArray(source.pollSources) && source.pollSources.every(validPollSource)) &&
    (source.messageSources === undefined || Array.isArray(source.messageSources) && source.messageSources.every(item => item &&
      typeof item.ref === 'string' && typeof item.appId === 'string' && typeof item.tenantId === 'string' &&
      (item.chatId === null || typeof item.chatId === 'string') && (item.spaceId === null || typeof item.spaceId === 'string') &&
      (item.readIdentity?.kind === 'user' || item.readIdentity?.kind === 'app')))
}
function externalRef(source: SourceContext['external'][number]): { kind: 'docx' | 'wiki'; token: string } | { kind: 'calendar'; range: { startSec: number; endSec: number } } | { kind: 'minutes'; source: MinutesSource } | undefined {
  if (source.kind === 'minutes') {
    const receipt = parseMinutesSourceRef(source.ref)
    return receipt && source.access === 'user' ? { kind: 'minutes', source: receipt } : undefined
  }
  if (source.kind === 'document') {
    const match = /^(docx|wiki):([A-Za-z0-9_-]+)$/.exec(source.ref)
    return match ? { kind: match[1] as 'docx' | 'wiki', token: match[2]! } : undefined
  }
  const match = /^calendar:([^:]+):(\d+):(\d+)$/.exec(source.ref)
  if (!match || match[1] !== source.personalOpenId) return undefined
  const startSec = Number(match[2]), endSec = Number(match[3])
  if (!Number.isSafeInteger(startSec) || !Number.isSafeInteger(endSec) || endSec <= startSec || endSec - startSec > 31 * 86400) return undefined
  return { kind: 'calendar', range: { startSec, endSec } }
}
