import type { SourceContext } from './source-context.js'

/** Only the host's verified message-link adapter may provide an available URL. */
export type TodoOriginLink = { status: 'available'; url: string } | { status: 'unavailable' }

/** Real inbound metadata, without message bodies, resource keys or derived model text. */
export interface TodoMessageMetadata {
  messageId: string
  chatId: string
  chatType: 'group' | 'p2p'
  senderOpenId: string
  /** Provider display labels, never generated from a model or an opaque ID. */
  senderName?: string
  chatName?: string
  msgType: string
  createTimeMs: number
  threadId?: string
  rootId?: string
  parentId?: string
  fileName?: string
  link: TodoOriginLink
}

export interface TodoSelectedInput { ref: string; taskId: number; message: TodoMessageMetadata }
/** Admission of actual bytes is not evidence that the model read those bytes. */
export interface TodoReceivedAttachment {
  fileId: string
  version: number
  containerMessageId: string
  resourceMessageId: string
  contentDigest: string
  name: string
  link: TodoOriginLink
}

/** The work itself is this one GitHub object, not a deployment or a larger delivery. */
export interface TodoGitHubSource {
  url: string
  completion: 'merged' | 'reviewed' | 'issue_closed'
}

/** A Feishu Minutes action item that the person accepted from a host-read draft in their own private chat.
 * Title, time and link come from the host's personal read; this cites the minute and grants no read access. */
export interface TodoMinutesSource {
  token: string
  title?: string
  /** Provider creation time of the minute, not necessarily the meeting start. */
  createdAtMs?: number
  link: TodoOriginLink
  /** Position among the minute's AI action items when the host read them, or among the proposed candidates when `basis` is `summary`. */
  item: number
  /** Present only for a candidate backed by a verbatim quote of the minute's AI summary, not one of its AI action items. */
  basis?: 'summary'
  contentDigest: string
  draftId: string
}

/** Host-only creation evidence. This snapshot records facts; it grants no access or publication rights. */
export interface TodoProvenance {
  version: 1
  originRunId: string
  taskId: number | null
  workKey: string
  /** Null only for an actual background Run without an inbound Task. */
  request: TodoMessageMetadata | null
  selectedInputs: TodoSelectedInput[]
  attachments?: TodoReceivedAttachment[]
  /** Only on Todos written by the owner's acceptance of a minutes action-item draft. */
  minutes?: TodoMinutesSource
  /** Host-read evidence from an explicitly enabled personal collector; never a fabricated inbound Task. */
  collection?: { ownerOpenId: string; message: TodoMessageMetadata; quote: string;
    kind: 'todo' | 'reply'; relationship: 'requested' | 'committed' | 'uncertain'; github?: TodoGitHubSource }
  github?: TodoGitHubSource & { ownerOpenId: string; revision: number; accountId: number; login: string;
    relationship: 'review_requested' | 'assigned'; updatedAt: number }
  /** Accumulated ACP inputs for permission/audit, not individual Todo citations. */
  contextSnapshot: SourceContext
}

export interface TodoOriginItem {
  kind: 'request' | 'message' | 'forward' | 'attachment' | 'minutes' | 'github'
  label: string
  suppliedAt?: number
  link: TodoOriginLink
}
/** The sole display projection. No Run/Task/message IDs or permission manifest are exposed. */
export interface TodoOrigin {
  request: TodoOriginItem | null
  selectedInputs: TodoOriginItem[]
  attachments: TodoOriginItem[]
  /** Present only when the Todo came from an accepted minutes draft. */
  minutes?: TodoOriginItem
}

/** Validate and serialize before the one Todo INSERT; a bad snapshot must leave no content-only row. */
export function serializeTodoProvenance(value: TodoProvenance): string {
  return JSON.stringify(normalize(value))
}

/** Legacy and malformed evidence stay unknown rather than acquiring a fabricated source. */
export function parseTodoProvenance(value: unknown): TodoProvenance | null {
  if (typeof value !== 'string') return null
  try { return normalize(JSON.parse(value)) } catch { return null }
}

export function todoOrigin(provenance: TodoProvenance | null): TodoOrigin | null {
  if (!provenance) return null
  return {
    request: provenance.request ? messageItem(provenance.request, true) : null,
    selectedInputs: [...provenance.selectedInputs.map(input => messageItem(input.message, false)),
      ...(provenance.collection ? [{ ...messageItem(provenance.collection.message, false), label: '原消息' }] : []),
      ...(provenance.github ? [{ kind: 'github' as const, label: provenance.github.relationship === 'review_requested' ? 'GitHub 评审请求' : 'GitHub 指派',
        suppliedAt: provenance.github.updatedAt, link: { status: 'available' as const, url: provenance.github.url } }] : [])],
    attachments: (provenance.attachments ?? []).map(attachment => ({
      kind: 'attachment', label: `附件已接收：${attachment.name}`, link: { ...attachment.link },
    })),
    ...(provenance.minutes ? { minutes: minutesItem(provenance.minutes) } : {}),
  }
}

function minutesItem(source: TodoMinutesSource): TodoOriginItem {
  // Calendar date in Beijing time, the same day the person saw in the draft.
  const day = source.createdAtMs === undefined ? '' : new Date(source.createdAtMs + 8 * 3600_000).toISOString().slice(0, 10)
  const label = `妙记${source.title ? `：${source.title}` : ''}${day ? `（${day}）` : ''}`
  return { kind: 'minutes', label, ...(source.createdAtMs === undefined ? {} : { suppliedAt: source.createdAtMs }), link: { ...source.link } }
}

function messageItem(message: TodoMessageMetadata, request: boolean): TodoOriginItem {
  return { kind: request ? 'request' : message.msgType === 'merge_forward' ? 'forward' : 'message',
    label: request ? '原请求' : message.msgType === 'merge_forward' ? '转发材料' : '引用消息',
    suppliedAt: message.createTimeMs, link: { ...message.link } }
}

function normalize(value: TodoProvenance): TodoProvenance {
  if (!value || value.version !== 1 || !text(value.originRunId) || !text(value.workKey) ||
    !(value.taskId === null || id(value.taskId)) || (value.taskId === null) !== (value.request === null) ||
    !Array.isArray(value.selectedInputs) || (value.attachments !== undefined && !Array.isArray(value.attachments))) invalid()
  const context = value.contextSnapshot
  if (!context || context.version !== 1 || !text(context.acpSessionId) || !text(context.spaceId) || !text(context.chatId) ||
    !Array.isArray(context.memoryScopes) || !context.memoryScopes.every(text) || !Array.isArray(context.chats) ||
    !Array.isArray(context.external) || !Array.isArray(context.repositories) || !context.repositories.every(text)) invalid()
  const request = value.request === null ? null : message(value.request)
  if (request && request.chatId !== context.chatId) invalid()
  const refs = new Set<string>(), messages = new Set<string>(request ? [request.messageId] : [])
  const selectedInputs = value.selectedInputs.map(input => {
    if (!input || !text(input.ref) || !id(input.taskId) || refs.has(input.ref)) invalid()
    refs.add(input.ref)
    const metadata = message(input.message)
    if (!request || metadata.chatId !== request.chatId || metadata.chatType !== request.chatType ||
      metadata.senderOpenId !== request.senderOpenId || messages.has(metadata.messageId)) invalid()
    messages.add(metadata.messageId)
    return { ref: input.ref, taskId: input.taskId, message: metadata }
  })
  const attachments = value.attachments?.map(attachment => {
    if (!attachment || !text(attachment.fileId) || !id(attachment.version) || !text(attachment.resourceMessageId) ||
      !messages.has(attachment.containerMessageId) || !/^[a-f0-9]{64}$/.test(attachment.contentDigest) || !text(attachment.name)) invalid()
    return { fileId: attachment.fileId, version: attachment.version, containerMessageId: attachment.containerMessageId,
      resourceMessageId: attachment.resourceMessageId, contentDigest: attachment.contentDigest, name: attachment.name,
      link: link(attachment.link) }
  })
  const minutes = value.minutes === undefined ? undefined : minutesSource(value.minutes)
  const collection = value.collection === undefined ? undefined : collectionSource(value.collection)
  const github = value.github
  if (github && (!text(github.ownerOpenId) || !id(github.revision) || !id(github.accountId) || !/^[A-Za-z0-9-]{1,39}$/.test(github.login) ||
    !Number.isSafeInteger(github.updatedAt) || github.updatedAt < 0 || !['review_requested', 'assigned'].includes(github.relationship) ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(pull|issues)\/[1-9]\d*$/.test(github.url) ||
    (github.relationship === 'review_requested' ? github.completion !== 'reviewed' || !github.url.includes('/pull/') : github.completion !== 'issue_closed' || !github.url.includes('/issues/')) ||
    value.taskId !== null || Boolean(collection) || context.spaceId !== `sp_dm_${github.ownerOpenId}` ||
    !context.personalRepositories?.some(r => r.owner === github.ownerOpenId && r.revision === github.revision &&
      r.repo === github.url.split('/').slice(3, 5).join('/').toLowerCase() && context.repositories.includes(r.repo)))) invalid()
  if (collection && (value.taskId !== null || context.spaceId !== `sp_dm_${collection.ownerOpenId}` ||
    !context.chats.some(chat => chat.chatId === collection.message.chatId))) invalid()
  return { version: 1, originRunId: value.originRunId, taskId: value.taskId, workKey: value.workKey, request, selectedInputs,
    ...(attachments !== undefined ? { attachments } : {}), ...(minutes ? { minutes } : {}),
    ...(collection ? { collection } : {}), ...(github ? { github: { ...github } } : {}), contextSnapshot: structuredClone(context) }
}

function collectionSource(value: NonNullable<TodoProvenance['collection']>): NonNullable<TodoProvenance['collection']> {
  if (!text(value?.ownerOpenId) || !text(value.quote) || value.quote.length > 2000 ||
    !['todo', 'reply'].includes(value.kind) || !['requested', 'committed', 'uncertain'].includes(value.relationship)) invalid()
  const github = value.github
  if (github && (!['merged', 'reviewed', 'issue_closed'].includes(github.completion) ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(pull|issues)\/[1-9]\d*$/.test(github.url) ||
    !value.quote.includes(github.url) || github.url.includes('/issues/') !== (github.completion === 'issue_closed'))) invalid()
  return { ownerOpenId: value.ownerOpenId, message: message(value.message), quote: value.quote,
    kind: value.kind, relationship: value.relationship, ...(github ? { github: { ...github } } : {}) }
}

function minutesSource(value: TodoMinutesSource): TodoMinutesSource {
  if (!value || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.token) ||
    (value.title !== undefined && (!text(value.title) || value.title.length > 200)) ||
    (value.createdAtMs !== undefined && (!Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0)) ||
    !Number.isSafeInteger(value.item) || value.item < 0 || typeof value.contentDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.contentDigest) || !text(value.draftId) || (value.basis !== undefined && value.basis !== 'summary')) invalid()
  return { token: value.token, ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.createdAtMs !== undefined ? { createdAtMs: value.createdAtMs } : {}), link: link(value.link),
    item: value.item, ...(value.basis ? { basis: value.basis } : {}), contentDigest: value.contentDigest, draftId: value.draftId }
}

function message(value: TodoMessageMetadata): TodoMessageMetadata {
  if (!value || !text(value.messageId) || !text(value.chatId) || !['group', 'p2p'].includes(value.chatType) ||
    !text(value.senderOpenId) || !text(value.msgType) || !Number.isSafeInteger(value.createTimeMs) || value.createTimeMs < 0) invalid()
  const optional: Pick<TodoMessageMetadata, 'threadId' | 'rootId' | 'parentId' | 'fileName' | 'senderName' | 'chatName'> = {}
  for (const key of ['threadId', 'rootId', 'parentId', 'fileName', 'senderName', 'chatName'] as const) {
    if (value[key] !== undefined) {
      if (!text(value[key])) invalid()
      optional[key] = value[key]
    }
  }
  return { messageId: value.messageId, chatId: value.chatId, chatType: value.chatType, senderOpenId: value.senderOpenId,
    msgType: value.msgType, createTimeMs: value.createTimeMs, ...optional, link: link(value.link) }
}

function link(value: TodoOriginLink): TodoOriginLink {
  if (value?.status === 'unavailable') return { status: 'unavailable' }
  if (value?.status !== 'available' || !text(value.url)) invalid()
  let url: URL
  try { url = new URL(value.url) } catch { return invalid() }
  // This is transport hygiene only. Identity/message matching belongs to the host adapter.
  if (url.protocol !== 'https:' || url.username || url.password) invalid()
  return { status: 'available', url: value.url }
}

function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function id(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function invalid(): never { throw new Error('待办来源记录不完整或不匹配') }
