import type { Registry } from './registry.js'
import type { MemorySourceReference } from './memory-provenance.js'
import type { WebLinkGrant } from './web-egress.js'
import type { DeliveredMessageSource } from './delivered-message-source.js'
import { validMyDayDomainSource, type MyDayDomainSourceReceipt } from './personal-assistant-sources.js'
import { validMeetingSource, type MeetingSourceReceipt } from './meeting-source.js'
import { validPollSource, type PollSourceReceipt } from './poll-source.js'
import { conversationSourceKey, validConversationReads, type ConversationReads } from './conversation-read-source.js'

export interface SourceContext {
  version: 1
  acpSessionId: string
  spaceId: string
  chatId: string
  memoryScopes: string[]
  chats: { chatId: string; spaceId?: string }[]
  /**
   * 非聊天资料。`access` 记的是**取它的时候用了什么凭证**——
   * 这才是能不能转述给别人的判据，而不是它是什么类型：
   * - `public`：有独立公开性证据；无认证 HTTP 不是证据，旧 web/public 不再自动放行。
   * - `link`：链接本身可能是访问凭证，只授权本次读取回到原群或原私聊本人。
   * - `app`：用了 Friday 的应用身份。Friday 是那篇文档的协作者，**群里的人未必是**。
   * - `user`：借了某个人的身份。只有他能看。
   * 字段缺失按 `app` 算：旧记录不能因为加了个新字段就突然变宽。
   */
  external: { kind: 'document' | 'calendar' | 'web' | 'minutes' | 'gmail' | 'mcp'; ref: string; personalOpenId?: string; access?: 'public' | 'app' | 'user' | 'link'; linkGrant?: WebLinkGrant
    /** The Run that read it most recently; a continuous private chat keeps older reads on record too. */
    runId?: string }[]
  repositories: string[]
  personalRepositories?: { repo: string; owner: string; revision: number }[]
  /** Missing on old contexts. Their prior materials cannot acquire provenance retroactively. */
  messageSources?: MemorySourceReference[]
  personalMemoryComplete?: boolean
  /** User-supplied containers in this space; forwarded children's original chat IDs grant no access. */
  inboundMaterials?: { messageId: string; chatId: string; actorOpenId: string; digest: string; complete: boolean }[]
  /** Exact already-delivered host messages; old app/DM reads cannot acquire this proof. */
  deliveredMessages?: DeliveredMessageSource[]
  /** Group Todo / decision rows a person's own My Day showed in their private chat. Each is rechecked
   * against the exact row and current app membership of that group before delivery or history reuse. */
  myDaySources?: MyDayDomainSourceReceipt[]
  /** Exact retained meeting events, restricted to the commissioning person's private chat. */
  meetingSources?: MeetingSourceReceipt[]
  /** Named vote snapshots retain the original group's audience and actual revision. */
  pollSources?: PollSourceReceipt[]
  /** Actual ordinary conversation inputs; distinct from eligibility for persistent group memory. */
  conversationReads?: ConversationReads
}

export interface SourceContextBinding { sessionKey: string; acpSessionId: string; spaceId: string; chatId: string }

/** The actual ACP's accumulated inputs. This records evidence, never grants read/write rights. */
export class SourceContexts {
  constructor(private readonly registry: Pick<Registry, 'getKv' | 'setKv'>) {}

  get(sessionKey: string): SourceContext | undefined {
    try {
      const value = JSON.parse(this.registry.getKv(this.key(sessionKey)) ?? 'null')
      if (value?.version !== 1 || typeof value.acpSessionId !== 'string' || !Array.isArray(value.memoryScopes)
        || !Array.isArray(value.chats) || !Array.isArray(value.external) || !Array.isArray(value.repositories)
        || value.repositories.some((repo: unknown) => typeof repo !== 'string')
        || (value.personalRepositories !== undefined && (!Array.isArray(value.personalRepositories) || !value.personalRepositories.every(validPersonalRepository)))
        || (value.myDaySources !== undefined && (!Array.isArray(value.myDaySources) || !value.myDaySources.every(validMyDayDomainSource)))
        || (value.meetingSources !== undefined && (!Array.isArray(value.meetingSources) || !value.meetingSources.every(validMeetingSource)))
        || (value.pollSources !== undefined && (!Array.isArray(value.pollSources) || !value.pollSources.every(validPollSource)))
        || (value.conversationReads !== undefined && !validConversationReads(value.conversationReads))) return undefined
      return value
    } catch { return undefined }
  }

  initialize(binding: SourceContextBinding, memoryScopes: readonly string[]): void {
    this.save(binding.sessionKey, { version: 1, acpSessionId: binding.acpSessionId, spaceId: binding.spaceId,
      chatId: binding.chatId, memoryScopes: [...memoryScopes], chats: [], external: [], repositories: [],
      messageSources: [], personalMemoryComplete: true, conversationReads: { complete: true, items: [] } })
  }

  addChat(sessionKey: string, chat: SourceContext['chats'][number]): void {
    const context = this.get(sessionKey)
    if (!context || context.chats.some(item => item.chatId === chat.chatId)) return
    context.chats.push(chat)
    this.save(sessionKey, context)
  }

  addExternal(sessionKey: string, source: SourceContext['external'][number]): void {
    const context = this.get(sessionKey)
    if (!context) return
    const same = context.external.find(item => item.kind === source.kind && item.ref === source.ref
      && item.personalOpenId === source.personalOpenId && item.access === source.access && linkGrantKey(item.linkGrant) === linkGrantKey(source.linkGrant))
    if (same) {
      if (!source.runId || same.runId === source.runId) return
      same.runId = source.runId
    } else context.external.push(source)
    this.save(sessionKey, context)
  }

  addRepository(sessionKey: string, repository: string): void {
    const context = this.get(sessionKey), repo = repository.trim().toLowerCase()
    if (!context || context.repositories.includes(repo)) return
    context.repositories.push(repo)
    this.save(sessionKey, context)
  }

  addPersonalRepository(sessionKey: string, repo: string, grant: { owner: string; revision: number }): void {
    this.addRepository(sessionKey, repo)
    const context = this.get(sessionKey)
    if (!context) return
    context.personalRepositories ??= []
    const entry = { repo: repo.trim().toLowerCase(), owner: grant.owner, revision: grant.revision }
    if (!validPersonalRepository(entry)) throw new Error('Invalid personal GitHub source')
    if (!context.personalRepositories.some(item => JSON.stringify(item) === JSON.stringify(entry))) context.personalRepositories.push(entry)
    this.save(sessionKey, context)
  }

  addMemoryScopes(sessionKey: string, scopes: readonly string[]): void {
    const context = this.get(sessionKey)
    if (!context) return
    context.memoryScopes = [...new Set([...context.memoryScopes, ...scopes])]
    this.save(sessionKey, context)
  }

  recordRetained(binding: SourceContextBinding, source: SourceContext): void {
    const current = this.get(binding.sessionKey)
    if (!current || current.acpSessionId !== binding.acpSessionId || current.spaceId !== binding.spaceId ||
      current.chatId !== binding.chatId || source.spaceId !== binding.spaceId || source.chatId !== binding.chatId) {
      throw new Error('保留的来源不属于当前执行受众')
    }
    this.addMemoryScopes(binding.sessionKey, source.memoryScopes)
    for (const chat of source.chats) this.addChat(binding.sessionKey, chat)
    for (const external of source.external) this.addExternal(binding.sessionKey, external)
    for (const repo of source.repositories) this.addRepository(binding.sessionKey, repo)
    for (const repo of source.personalRepositories ?? []) this.addPersonalRepository(binding.sessionKey, repo.repo, repo)
    for (const inbound of source.inboundMaterials ?? []) this.recordInboundMaterial(binding, inbound)
    for (const delivered of source.deliveredMessages ?? []) this.recordDeliveredMessage(binding, delivered)
    for (const item of source.myDaySources ?? []) this.recordMyDaySource(binding, item)
    for (const meeting of source.meetingSources ?? []) this.recordMeetingSource(binding, meeting)
    for (const poll of source.pollSources ?? []) this.recordPollSource(binding, poll)
    if (source.messageSources !== undefined) this.recordMessages(binding, source.messageSources, source.personalMemoryComplete === true)
    if (source.conversationReads !== undefined || current.conversationReads !== undefined) {
      this.recordConversationReads(binding, source.conversationReads ?? { complete: false, items: [] })
    }
  }

  recordInboundMaterial(binding: SourceContextBinding, source: NonNullable<SourceContext['inboundMaterials']>[number]): void {
    const context = this.get(binding.sessionKey)
    if (!context || context.acpSessionId !== binding.acpSessionId || context.spaceId !== binding.spaceId ||
      context.chatId !== binding.chatId || source.chatId !== binding.chatId) throw new Error('转发材料不属于当前执行空间')
    context.inboundMaterials ??= []
    if (!context.inboundMaterials.some(item => item.messageId === source.messageId && item.digest === source.digest)) context.inboundMaterials.push(source)
    this.save(binding.sessionKey, context)
  }

  recordDeliveredMessage(binding: SourceContextBinding, source: DeliveredMessageSource): void {
    const context = this.get(binding.sessionKey)
    if (!context || context.acpSessionId !== binding.acpSessionId || context.spaceId !== binding.spaceId ||
      context.chatId !== binding.chatId || source.spaceId !== binding.spaceId || source.chatId !== binding.chatId) {
      throw new Error('宿主消息来源不属于当前执行空间')
    }
    context.deliveredMessages ??= []
    if (!context.deliveredMessages.some(item => linkGrantKey(item) === linkGrantKey(source))) context.deliveredMessages.push({ ...source })
    this.save(binding.sessionKey, context)
  }

  /** Only the host's already-authorized My Day read hook records these; the viewer's private audience is part of the receipt. */
  recordMyDaySource(binding: SourceContextBinding, source: MyDayDomainSourceReceipt): void {
    const context = this.get(binding.sessionKey)
    if (!context || context.acpSessionId !== binding.acpSessionId || context.spaceId !== binding.spaceId || context.chatId !== binding.chatId ||
      !validMyDayDomainSource(source) || source.privateSpaceId !== binding.spaceId || source.privateChatId !== binding.chatId) {
      throw new Error('我的一天的来源不属于当前执行空间')
    }
    context.myDaySources ??= []
    if (!context.myDaySources.some(item => linkGrantKey(item) === linkGrantKey(source))) context.myDaySources.push({ ...source })
    this.save(binding.sessionKey, context)
  }

  recordMeetingSource(binding: SourceContextBinding, source: MeetingSourceReceipt): void {
    const context = this.get(binding.sessionKey)
    if (!context || context.acpSessionId !== binding.acpSessionId || context.spaceId !== binding.spaceId ||
      context.chatId !== binding.chatId || !validMeetingSource(source) || source.spaceId !== binding.spaceId || source.chatId !== binding.chatId) {
      throw new Error('会议来源不属于当前执行空间')
    }
    context.meetingSources ??= []
    if (!context.meetingSources.some(item => linkGrantKey(item) === linkGrantKey(source))) context.meetingSources.push({ ...source })
    this.save(binding.sessionKey, context)
  }

  recordPollSource(binding: SourceContextBinding, source: PollSourceReceipt): void {
    const context = this.get(binding.sessionKey)
    if (!context || context.acpSessionId !== binding.acpSessionId || context.spaceId !== binding.spaceId ||
      context.chatId !== binding.chatId || !validPollSource(source) || source.spaceId !== binding.spaceId || source.chatId !== binding.chatId) {
      throw new Error('投票来源不属于当前执行空间')
    }
    context.pollSources ??= []
    if (!context.pollSources.some(item => linkGrantKey(item) === linkGrantKey(source))) context.pollSources.push({ ...source })
    this.save(binding.sessionKey, context)
  }

  /** The host checks the exact Run and read lease before this synchronous operation. */
  recordMessages(binding: SourceContextBinding, sources: readonly MemorySourceReference[], complete: boolean): void {
    const context = this.get(binding.sessionKey)
    if (!context || context.acpSessionId !== binding.acpSessionId || context.spaceId !== binding.spaceId || context.chatId !== binding.chatId) {
      throw new Error('执行上下文已变化，未登记消息来源')
    }
    const sourceKey = (source: MemorySourceReference) => JSON.stringify([source.ref, source.contentDigest,
      source.appId, source.tenantId, source.spaceId, source.chatId, source.readIdentity])
    const all = new Map((context.messageSources ?? []).map(source => [sourceKey(source), source]))
    for (const source of sources) {
      // Keep distinct content snapshots and identities; a later read does not erase prior inputs.
      const key = sourceKey(source)
      if (!all.has(key)) all.set(key, source)
      if (source.chatId && !context.chats.some(chat => chat.chatId === source.chatId)) {
        context.chats.push({ chatId: source.chatId, ...(source.spaceId ? { spaceId: source.spaceId } : {}) })
      }
    }
    context.messageSources = [...all.values()]
    context.personalMemoryComplete = context.personalMemoryComplete === true && complete
    this.save(binding.sessionKey, context)
  }

  /** Append exact host receipts. A later read cannot certify older unknown input, even from the same chat. */
  recordConversationReads(binding: SourceContextBinding, reads: ConversationReads): void {
    const context = this.get(binding.sessionKey)
    if (!context || context.acpSessionId !== binding.acpSessionId || context.spaceId !== binding.spaceId || context.chatId !== binding.chatId) {
      throw new Error('执行上下文已变化，未登记会话来源')
    }
    if (!validConversationReads(reads)) throw new Error('会话读取来源不完整')
    const incoming = structuredClone(reads)
    const all = new Map((context.conversationReads?.items ?? []).map(source => [conversationSourceKey(source), source]))
    for (const source of incoming.items) {
      const key = conversationSourceKey(source)
      if (!all.has(key)) all.set(key, source)
      if (!context.chats.some(chat => chat.chatId === source.chatId)) {
        context.chats.push({ chatId: source.chatId, ...(source.spaceId ? { spaceId: source.spaceId } : {}) })
      }
    }
    context.conversationReads = { complete: context.conversationReads?.complete === true && incoming.complete, items: [...all.values()] }
    this.save(binding.sessionKey, context)
  }

  private save(sessionKey: string, context: SourceContext): void { this.registry.setKv(this.key(sessionKey), JSON.stringify(context)) }
  private key(sessionKey: string): string { return `delivery-sources:${sessionKey}` }
}

// Material provenance uses canonical JSON; object property order is not a new
// authorization and must not append duplicate external sources on read/import.
function linkGrantKey(grant: WebLinkGrant | DeliveredMessageSource | MyDayDomainSourceReceipt | MeetingSourceReceipt | PollSourceReceipt | undefined): string | undefined {
  return grant && JSON.stringify(Object.fromEntries(Object.entries(grant).sort(([a], [b]) => a.localeCompare(b))))
}

export function validPersonalRepository(value: unknown): value is NonNullable<SourceContext['personalRepositories']>[number] {
  const r = value as NonNullable<SourceContext['personalRepositories']>[number] | undefined
  return Boolean(r && typeof r.repo === 'string' && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(r.repo) &&
    typeof r.owner === 'string' && r.owner && Number.isSafeInteger(r.revision) && r.revision > 0)
}
