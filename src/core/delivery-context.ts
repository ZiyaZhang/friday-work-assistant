import type { FeishuClient } from '../feishu/client.js'
import type { UserToken, UserTokenStore } from '../feishu/oauth.js'
import type { DeliveryAudience, DeliveryContext } from './delivery.js'
import type { SourceContexts } from './source-context.js'
import type { Spaces } from './space.js'
import { hasCurrentWebLinkGrant } from './web-egress.js'
import { accessFailure, providerAccessFailure, tokenAccessFailure, type AccessFailure } from './access-failure.js'
import { hasCurrentDeliveredMessages, type VerifyDeliveredMessage } from './delivered-message-source.js'
import { verifyConversationMessages } from './conversation-read-source.js'
import type { ChatReadScope } from './chat-read-scope.js'
import type { ExecutionSourceAccessResult } from './execution-source-access.js'
import type { MyDayDomainSourceAudience, MyDayDomainSourceReceipt } from './personal-assistant-sources.js'
import type { MeetingSourceReceipt, MeetingSourceAudience } from './meeting-source.js'
import type { PollSourceReceipt, PollSourceAudience } from './poll-source.js'

/** Captured by the host for one exact Run. These closures never enter model-visible data. */
export interface DeliveryExecution {
  runId?: string
  sessionKey: string
  acpSessionId: string | null
  actorOpenId: string
  spaceId: string
  chatId: string
  chatType: 'group' | 'p2p'
  /** Run/Session/Space are still bound; does not consult the memory proof being revoked. */
  isLive(): boolean
  /** Also requires the current memory/skill context to remain eligible. */
  isCurrent(): boolean
  readScopes(): readonly string[]
}

interface DeliveryContextDependencies {
  appId?: string
  checkMcpSource?(owner: string, ref: string, guard: () => void): Promise<() => void>
  checkGmailSource?(owner: string, ref: string, guard: () => void): Promise<() => void>
  verifyDeliveredMessage?: VerifyDeliveredMessage
  checkMyDaySources?: (sources: readonly MyDayDomainSourceReceipt[], audience: MyDayDomainSourceAudience, assertCurrent: () => void) => Promise<ExecutionSourceAccessResult>
  checkMeetingSources?: (sources: readonly MeetingSourceReceipt[], audience: MeetingSourceAudience, assertCurrent: () => void) => Promise<ExecutionSourceAccessResult>
  checkPollSources?: (sources: readonly PollSourceReceipt[], audience: PollSourceAudience, assertCurrent: () => void) => Promise<ExecutionSourceAccessResult>
  sources: Pick<SourceContexts, 'get'>
  spaces: Pick<Spaces, 'byChat'>
  feishu: Pick<FeishuClient, 'listChats' | 'chatMemberOpenIds'> & Partial<Pick<FeishuClient, 'listChatsResult' | 'getMessage' | 'whoAmI'>>
  readScope?: Pick<ChatReadScope, 'isReadable'>
  userTokens?: Pick<UserTokenStore, 'get' | 'accessTokenResult'>
  disconnectPersonalConnection(openId: string, expected: UserToken): boolean
  now(): number
}

export interface DeliveryResolveOptions { audience: DeliveryAudience; notice?: boolean; prepareMentions?: boolean }
export type DeliveryResolveResult =
  | { status: 'ready'; context: DeliveryContext }
  | { status: 'blocked'; failure: AccessFailure; legacyContext?: DeliveryContext }

/** Converts actual accumulated sources into freshly checked delivery evidence.
 * The host owns execution identity; DeliveryService owns audience policy, admission and sending.
 */
export class DeliveryContextResolver {
  constructor(private readonly deps: DeliveryContextDependencies) {}

  /** Compatibility adapter. New callers use resolveResult to retain the cause. */
  async resolve(execution: DeliveryExecution, options: DeliveryResolveOptions): Promise<DeliveryContext | undefined> {
    const result = await this.resolveResult(execution, options)
    return result.status === 'ready' ? result.context : result.legacyContext
  }

  async resolveResult(execution: DeliveryExecution, options: DeliveryResolveOptions): Promise<DeliveryResolveResult> {
    const blocked = (failure: AccessFailure, legacyContext?: DeliveryContext): DeliveryResolveResult => ({ status: 'blocked', failure, ...(legacyContext ? { legacyContext } : {}) })
    const changed = () => blocked(accessFailure('context_changed'))
    if (!execution.isCurrent()) return changed()
    const { sources, spaces, feishu, userTokens } = this.deps
    const { sessionKey, actorOpenId: actor, spaceId, chatId, chatType } = execution
    const manifest = sources.get(sessionKey), expiresAt = this.deps.now() + 60_000
    const base = { ref: `space:${spaceId}`, spaceId, chatId }
    const context: DeliveryContext = {
      isCurrent: () => execution.isCurrent(),
      actorOpenId: actor, expiresAt, audience: options.audience, sources: [base],
      provenanceComplete: Boolean(options.notice || manifest && manifest.acpSessionId === execution.acpSessionId &&
        manifest.spaceId === spaceId && manifest.chatId === chatId),
    }
    if (options.notice) return { status: 'ready', context } // Fixed host notice carries no model text or inherited material.
    if (!context.provenanceComplete || !manifest) return blocked(accessFailure('source_unverifiable'), context)
    if (manifest.conversationReads?.complete === false) return blocked(accessFailure('source_unverifiable'))
    if (manifest.conversationReads?.items.some(item => item.appId !== this.deps.appId ||
      item.readIdentity.kind === 'user' && item.readIdentity.openId !== actor)) return blocked(accessFailure('identity_mismatch'))
    const deliveredCurrent = () => hasCurrentDeliveredMessages(manifest.deliveredMessages, {
      appId: this.deps.appId ?? '', actorOpenId: actor, spaceId, chatId, chatType,
    }, this.deps.verifyDeliveredMessage)
    if (!deliveredCurrent()) return blocked(accessFailure('source_unverifiable'))
    const sourceSnapshot = JSON.stringify(manifest)
    const chatBindings = () => JSON.stringify(manifest.chats.map(chat => {
      const space = spaces.byChat(chat.chatId, true)
      return space ? [space.id, space.kind, space.chatId, space.status] : null
    }))
    const bindingSnapshot = chatBindings()
    const allowedScopes = new Set(execution.readScopes())
    if (manifest.memoryScopes.some(scope => !allowedScopes.has(scope))) {
      context.provenanceComplete = false
      return blocked(accessFailure('source_unverifiable'), context)
    }
    context.sources = [base, ...manifest.chats.filter(chat => chat.chatId !== chatId).map(chat => ({
      ref: `chat:${chat.chatId}`, chatId: chat.chatId,
      spaceId: chat.spaceId ?? spaces.byChat(chat.chatId)?.id ?? `unregistered-chat:${chat.chatId}`,
    }))]
    const personalChats = [...new Set([...manifest.chats.map(chat => chat.chatId), ...(chatType === 'group' ? [chatId] : [])])]
    // 要不要用**本人身份**再核一次，取决于这轮的资料是**用谁的身份**读到的，不是"有没有读过外部资料"。
    //
    // 以前只看 external 非空。于是 Friday 用自己的应用身份读了一篇它本来就是协作者的文档，
    // 也会被判成"需要个人授权"，没授权就整轮拒发。那篇文档 Friday 自己有权限，核他的授权证明不了任何事。
    //
    // 真正需要重核的是**借了某个人的身份**读到的东西：他可能已经被移出那个群、或者授权已撤销，
    // 而我们还攥着旧 token 的结果。所以判据是 personalOpenId 在不在。
    const requiresPersonal = manifest.external.some(source => source.kind !== 'web' && source.kind !== 'gmail' && source.kind !== 'mcp' && Boolean(source.personalOpenId))
      || Boolean(manifest.messageSources?.some(source => source.readIdentity.kind === 'user'))
      || Boolean(manifest.conversationReads?.items.some(source => source.readIdentity.kind === 'user'))
    let userToken: string | undefined
    let authorizationCurrent = () => true
    let myDayCurrent = () => true
    let meetingCurrent = () => true
    let pollCurrent = () => true
    const mailGuards: (() => void)[] = []
    const mailCurrent = () => { try { for (const guard of mailGuards) guard(); return true } catch { return false } }
    // Another tool in this Run may return new material while audience checks await.
    // It must receive its own admission against the full current source context.
    const readScopeCurrent = () => chatType !== 'p2p' || personalChats.every(id => id === chatId || this.deps.readScope?.isReadable(actor, id) !== false)
    const current = () => execution.isCurrent() && authorizationCurrent() && myDayCurrent() && meetingCurrent() && pollCurrent() && mailCurrent() && deliveredCurrent() && readScopeCurrent() && chatBindings() === bindingSnapshot &&
      JSON.stringify(sources.get(sessionKey)) === sourceSnapshot
    const noLongerCurrent = () => blocked(accessFailure(!execution.isCurrent() ? 'context_changed'
      : !authorizationCurrent() ? 'connection_changed' : 'source_unverifiable'))
    context.isCurrent = current
    const web = manifest.external.filter(source => source.kind === 'web')
    const originalAudience = context.audience.spaceId === spaceId && (chatType === 'group'
      ? context.audience.kind === 'group' && context.audience.chatId === chatId
      : context.audience.kind === 'dm' && context.audience.openId === actor)
    for (const mail of manifest.external.filter(source => source.kind === 'gmail' || source.kind === 'mcp')) {
      if (!originalAudience || chatType !== 'p2p' || mail.personalOpenId !== actor || mail.access !== 'user') return blocked(accessFailure('audience_mismatch'))
      const checker = mail.kind === 'mcp' ? this.deps.checkMcpSource : this.deps.checkGmailSource
      if (!checker) return blocked(accessFailure('source_unverifiable'))
      const prior = [...mailGuards], guard = () => {
        if (!execution.isCurrent() || JSON.stringify(sources.get(sessionKey)) !== sourceSnapshot) throw new Error('Email context changed')
        for (const check of prior) check()
      }
      try { mailGuards.push(await checker(actor, mail.ref, guard)) }
      catch { return blocked(accessFailure('source_unverifiable')) }
      if (!current()) return noLongerCurrent()
      context.sources = [...context.sources, { ...base, ref: mail.ref }]
    }
    if (manifest.conversationReads?.items.some(source => source.readIdentity.kind === 'user') &&
      (chatType !== 'p2p' || !originalAudience)) return blocked(accessFailure('audience_mismatch'))
    if (!readScopeCurrent()) return blocked(accessFailure('context_changed'))
    if (manifest.deliveredMessages?.length) {
      if (!originalAudience) return blocked(accessFailure('audience_mismatch'))
      context.sources = [...context.sources, ...manifest.deliveredMessages.map(source => ({ ...base, ref: source.ref }))]
    }
    if (manifest.myDaySources?.length) {
      // A person's own My Day rows from other groups go back only to that person's private chat.
      if (!originalAudience || chatType !== 'p2p') return blocked(accessFailure('audience_mismatch'))
      if (!this.deps.checkMyDaySources) return blocked(accessFailure('source_unverifiable'))
      // Freeze the outer guards: the returned lease must not call itself.
      const priorMyDayCurrent = myDayCurrent
      const assertPrior = () => {
        if (!execution.isCurrent() || !authorizationCurrent() || !priorMyDayCurrent() || !deliveredCurrent() || !readScopeCurrent() ||
          chatBindings() !== bindingSnapshot || JSON.stringify(sources.get(sessionKey)) !== sourceSnapshot) throw new Error('我的一天的投递上下文已变化')
      }
      const access = await this.deps.checkMyDaySources(manifest.myDaySources, { openId: actor, spaceId, chatId, chatType }, assertPrior)
      if (!current()) return noLongerCurrent()
      try { access.assertCurrent() } catch { return blocked(accessFailure('source_unverifiable')) }
      if (access.status !== 'allowed') return blocked(accessFailure('source_unverifiable'))
      myDayCurrent = () => { try { access.assertCurrent(); return true } catch { return false } }
      context.sources = [...context.sources, ...manifest.myDaySources.map(source => ({ ...base, ref: `my-day:${source.kind}:${source.id}:${source.contentDigest}` }))]
    }
    if (manifest.meetingSources?.length) {
      // Retained meeting events go back only to the commissioning person's private chat.
      if (!originalAudience || chatType !== 'p2p') return blocked(accessFailure('audience_mismatch'))
      if (!this.deps.checkMeetingSources) return blocked(accessFailure('source_unverifiable'))
      // Freeze the outer guard: the returned lease must not recursively call itself. My Day was checked
      // before this branch and its lease never calls back into meetingCurrent, so it is chained live.
      const priorMeetingCurrent = meetingCurrent
      const assertPrior = () => {
        if (!execution.isCurrent() || !authorizationCurrent() || !myDayCurrent() || !priorMeetingCurrent() || !deliveredCurrent() || !readScopeCurrent() ||
          chatBindings() !== bindingSnapshot || JSON.stringify(sources.get(sessionKey)) !== sourceSnapshot) throw new Error('会议资料投递上下文已变化')
      }
      const access = await this.deps.checkMeetingSources(manifest.meetingSources, { openId: actor, spaceId, chatId, chatType }, assertPrior)
      if (!current()) return noLongerCurrent()
      try { access.assertCurrent() } catch { return blocked(accessFailure('source_unverifiable')) }
      if (access.status !== 'allowed') return blocked(accessFailure('source_unverifiable'))
      meetingCurrent = () => { try { access.assertCurrent(); return true } catch { return false } }
      context.sources = [...context.sources, ...manifest.meetingSources.map(source => ({ ...base, ref: `meeting:${source.sessionId}:${source.eventsDigest}` }))]
    }
    if (web.some(source => !originalAudience || !hasCurrentWebLinkGrant(source, execution))) {
      context.provenanceComplete = false
      return blocked(accessFailure(originalAudience ? 'source_unverifiable' : 'audience_mismatch'), context) // OAuth cannot repair link scope.
    }
    if (manifest.pollSources?.length) {
      // A named vote snapshot goes back only to its original group.
      if (!originalAudience || !this.deps.checkPollSources) return blocked(accessFailure(originalAudience ? 'source_unverifiable' : 'audience_mismatch'))
      const precedingPollCurrent = pollCurrent
      const assertPrior = () => {
        if (!execution.isCurrent() || !authorizationCurrent() || !myDayCurrent() || !meetingCurrent() || !precedingPollCurrent() || !deliveredCurrent() ||
          !readScopeCurrent() || chatBindings() !== bindingSnapshot || JSON.stringify(sources.get(sessionKey)) !== sourceSnapshot) {
          throw new Error('投票资料投递上下文已变化')
        }
      }
      const access = await this.deps.checkPollSources(manifest.pollSources, { openId: actor, spaceId, chatId, chatType }, assertPrior)
      if (!current()) return noLongerCurrent()
      try { access.assertCurrent() } catch { return blocked(accessFailure('source_unverifiable')) }
      if (access.status !== 'allowed') return blocked(accessFailure('source_unverifiable'))
      // Capture the preceding guards; the returned lease must not depend on itself.
      pollCurrent = () => { try { access.assertCurrent(); return true } catch { return false } }
      context.sources = [...context.sources, ...manifest.pollSources.map(source => ({ ...base, ref: `poll:${source.pollId}:${source.snapshotDigest}` }))]
    }
    if (requiresPersonal || context.audience.kind === 'dm' && personalChats.length) {
      const expected = userTokens?.get(actor)
      if (userTokens) {
        // One original lease covers external material and all group/member awaits.
        let token
        try { token = await userTokens.accessTokenResult(actor) }
        catch (error) {
          if (!execution.isCurrent()) return changed()
          const failure = providerAccessFailure(error, 'user')
          if (failure) return blocked(failure)
          throw error
        }
        if (!execution.isLive()) return changed()
        if (!current()) return noLongerCurrent()
        if (token.status !== 'available' && JSON.stringify(userTokens.get(actor)) !== JSON.stringify(expected)) {
          return blocked(accessFailure('connection_changed', { identity: 'user' }))
        }
        if (token.status === 'denied' && token.reason === 'invalid_grant') {
          // The host compares this frozen grant again before withdrawing its derived memories.
          if (expected) this.deps.disconnectPersonalConnection(actor, expected)
          return blocked(tokenAccessFailure(token))
        }
        if (token.status === 'available') {
          userToken = token.accessToken
          authorizationCurrent = token.isCurrent
        } else {
          // A temporary failure is not revocation. Existing/user-derived identity never becomes app identity.
          if (token.status === 'unavailable' || expected || requiresPersonal || userTokens.get(actor)) return blocked(tokenAccessFailure(token))
          authorizationCurrent = () => !userTokens.get(actor)
        }
      } else if (requiresPersonal) return blocked(accessFailure('not_connected', { identity: 'user' }))
      if (!current()) return noLongerCurrent()
    }
    // A URL can itself be a capability. Every web result needs its original
    // audience-bound host receipt; no query-key heuristics or Feishu OAuth fallback.
    const other = manifest.external.filter(source => source.kind !== 'web' && source.kind !== 'gmail' && source.kind !== 'mcp')
    const isOpen = (source: { personalOpenId?: string; access?: string }) => source.access === 'public' && !source.personalOpenId
    const open = other.filter(isOpen)
    const restricted = other.filter(source => !isOpen(source))
    const cite = (source: { kind: string; ref: string }) => ({ ...base, ref: `${source.kind}:${source.ref}` })
    // Every grant above was checked, even when two user URLs resolve to one page.
    if (web.length) context.sources = [...context.sources, ...new Map(web.map(source => [source.ref, cite(source)])).values()]
    if (open.length) context.sources = [...context.sources, ...open.map(cite)]
    if (restricted.length) {
      if (context.audience.kind !== 'dm' || restricted.some(source => source.personalOpenId !== actor) || !userToken) {
        context.provenanceComplete = false
        return blocked(accessFailure(context.audience.kind !== 'dm' || restricted.some(source => source.personalOpenId && source.personalOpenId !== actor)
          ? 'audience_mismatch' : 'source_unverifiable'), context)
      } else {
        context.sources = [...context.sources, ...restricted.map(cite)]
      }
    }
    if (context.audience.kind === 'dm' && personalChats.length) {
      const permitted = new Set<string>()
      const identity = userToken ? 'user' : 'app'
      try {
        if (userToken) {
          const ordinary = manifest.conversationReads?.items ?? []
          let tenantId: string | undefined
          if (ordinary.some(item => item.readIdentity.kind === 'user')) {
            if (!feishu.whoAmI) return blocked(accessFailure('source_unverifiable'))
            const identity = await feishu.whoAmI(userToken)
            if (!current()) return noLongerCurrent()
            if (identity.openId !== actor || !identity.tenantKey || ordinary.some(item =>
              item.readIdentity.kind === 'user' && item.readIdentity.tenantId !== identity.tenantKey)) return blocked(accessFailure('identity_mismatch'))
            tenantId = identity.tenantKey
          }
          let result, directoryFailure: AccessFailure | undefined
          try {
            result = feishu.listChatsResult ? await feishu.listChatsResult({ userToken }, { fresh: true, assertCurrent: () => {
                if (!current()) throw new Error('Delivery context changed during membership pagination')
              } })
              : { items: await feishu.listChats({ userToken }, { fresh: true }), complete: false }
          } catch (error) {
            if (!current()) return noLongerCurrent()
            directoryFailure = providerAccessFailure(error, 'user')
            if (!directoryFailure) throw error
          }
          if (!current()) return noLongerCurrent()
          for (const chat of result?.items ?? []) permitted.add(chat.chatId)
          for (const sourceChat of personalChats.filter(chat => !permitted.has(chat))) {
            const reads = ordinary.filter(item => item.chatId === sourceChat)
            if (directoryFailure && (!reads.length || reads.some(item => item.kind !== 'message'))) return blocked(directoryFailure)
            if (!tenantId || !feishu.getMessage) return blocked(directoryFailure ?? accessFailure('resource_unverified', { identity }))
            const failure = await verifyConversationMessages(manifest.conversationReads, sourceChat, {
              appId: this.deps.appId ?? '', openId: actor, tenantId, as: { userToken },
              feishu: { getMessage: feishu.getMessage.bind(feishu) },
              assertCurrent: () => { if (!current()) throw new Error('Delivery context changed during message verification') },
            })
            if (!current()) return noLongerCurrent()
            if (failure) return blocked(failure)
            permitted.add(sourceChat)
          }
        } else {
          for (const sourceChat of personalChats) {
            const members = await feishu.chatMemberOpenIds(sourceChat, { fresh: true })
            if (!current()) return noLongerCurrent()
            // The legacy member helper has no completeness proof for an absent member.
            if (!members.has(actor)) return blocked(accessFailure('resource_unverified', { identity }))
            permitted.add(sourceChat)
          }
        }
      } catch (error) {
        if (!current()) return noLongerCurrent()
        const failure = providerAccessFailure(error, identity)
        if (failure) return blocked(failure)
        throw error
      }
      context.personalRead = { actorOpenId: actor, chatIds: [...permitted], expiresAt }
    }
    if (options.prepareMentions) {
      if (context.audience.kind === 'dm') context.mentionOpenIds = [actor]
      else {
        let members
        try { members = await feishu.chatMemberOpenIds(context.audience.chatId, { fresh: true }) }
        catch (error) {
          if (!current()) return noLongerCurrent()
          const failure = providerAccessFailure(error, 'app')
          if (failure) return blocked(failure)
          throw error
        }
        if (!current()) return noLongerCurrent()
        if (!members.has(actor)) return blocked(accessFailure('resource_unverified', { identity: 'app' }))
        context.mentionOpenIds = [...members]
      }
    }
    return current() ? { status: 'ready', context } : noLongerCurrent()
  }
}
