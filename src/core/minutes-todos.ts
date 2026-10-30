import type { DatabaseSync } from 'node:sqlite'
import type { FeishuClient } from '../feishu/client.js'
import type { MinuteArtifacts, MinuteBrief } from '../feishu/minutes.js'
import { escapeForCard } from '../feishu/cards.js'
import { DeliveryService, type DeliveryContext } from './delivery.js'
import type { ExecutionSourceAccessResult } from './execution-source-access.js'
import type { PolicyService } from './policy.js'
import { assertRequestCurrent } from './request-lease.js'
import { dmSpaceId, spaceScope, type Spaces } from './space.js'
import type { TodoApplication } from './todo-application.js'
import type { TodoAudience, Todos } from './todos.js'
import type { TodoProvenance } from './todo-provenance.js'
import { MINUTES_DRAFT_MAX_ITEMS, MINUTES_ITEM_MAX_LENGTH, MinutesDraftAccessError, MinutesDraftError, NOTHING_TICKED,
  type MinutesAssignment, type MinutesDraft, type MinutesDraftItem, type MinutesDraftMinute, type MinutesDraftOrigin, type MinutesDraftState,
  type MinutesDrafts, type MinutesProposedItem } from './minutes-drafts.js'

export interface MinutesRunRef { sessionKey: string; runId: string }
/** The owner's current interactive task Run in their own private chat, resolved by the host. */
export interface MinutesTodoBinding extends MinutesRunRef {
  taskId: number; workKey: string; requestMessageId: string
  openId: string; spaceId: string; chatId: string
  assertCurrent(): void
}
export interface MinutesTodoDeps {
  drafts: MinutesDrafts
  /** Same database: the delivery ledger records the full text and card receipts. */
  db: DatabaseSync
  todoApplication: TodoApplication
  todos: Pick<Todos, 'get'>
  spaces: Spaces
  policy: PolicyService
  feishu: Pick<FeishuClient, 'sendToUser'>
  /** Throws unless the Run is the owner's current task in their own private chat. */
  binding(ref: MinutesRunRef): MinutesTodoBinding
  /** The Run's actual request and material evidence, kept as the Todos' creation provenance. */
  captureProvenance(ref: MinutesRunRef): Promise<TodoProvenance>
  /** The Run's delivery context for the owner's private chat. */
  resolveDelivery(ref: MinutesRunRef, guard: () => void): Promise<DeliveryContext | undefined>
  /** Revalidates the owner's current personal access to exactly this minute (metadata and AI artifacts). */
  authorizeMinute(draft: MinutesDraft, guard: () => void): Promise<ExecutionSourceAccessResult>
  now?(): number
}
/** Candidate wording is capped so it fits a Todo title; the quote must be a verbatim sentence of the host-read AI summary. */
export const MINUTES_CANDIDATE_MAX_TEXT = 200
export const MINUTES_CANDIDATE_MAX_QUOTE = 300
/** Items longer than this are sent as full text before the card; shorter ones are shown whole on the card itself. */
export const MINUTES_CARD_ITEM_MAX = 200
export interface MinutesCandidate { text: string; quote: string }
/** Host-read minute and artifacts. The model selects AI action items by position, or proposes candidates backed by verbatim summary quotes. */
export interface MinutesProposal { minute: MinuteBrief; artifacts: MinuteArtifacts; items?: readonly number[]; candidates?: readonly MinutesCandidate[] }
export interface MinutesProposalResult {
  draftId: string; state: MinutesDraftState; items: number; reviewDelivered: boolean; todoIds: number[]; expiresAt: string; notice: string
}
/** A tick on the delivered card, from the authenticated checker callback. `position` is the item's place on the card. */
export interface MinutesDraftSelection {
  draftId: string; digest: string; position: number; checked: boolean
  operatorOpenId: string; chatId: string; messageId: string
}
export interface MinutesDraftDecision {
  draftId: string; digest: string; decision: 'accept' | 'ignore'
  /** From the authenticated card callback, never from model output. */
  operatorOpenId: string; chatId: string; messageId: string
}

/**
 * 妙记行动项进待办。读妙记的执行只生成草稿并把全文送到本人私聊；待办只在本人点「接受」的宿主回调里写入，
 * 与会议纪要草稿同一做法。模型只能选择行动项的位置，文本、标题、链接、时间都来自宿主的个人授权读取。
 */
export class MinutesTodoApplication {
  constructor(private readonly deps: MinutesTodoDeps) {}

  async propose(ref: MinutesRunRef, input: MinutesProposal, guard: () => void): Promise<MinutesProposalResult> {
    const binding = this.deps.binding(ref)
    const check = () => { assertRequestCurrent(); guard(); binding.assertCurrent() }
    check()
    const items = selectItems(input, binding.openId)
    const origin: MinutesDraftOrigin = { runId: ref.runId, taskId: binding.taskId, workKey: binding.workKey, sessionKey: ref.sessionKey,
      requestMessageId: binding.requestMessageId, ownerOpenId: binding.openId, spaceId: binding.spaceId, chatId: binding.chatId }
    this.ownerCurrent(origin)
    const provenance = await this.deps.captureProvenance(ref)
    check(); this.ownerCurrent(origin)
    const draft = this.deps.drafts.propose({ origin, minute: draftMinute(input.minute), items, provenance })
    if (draft.state !== 'pending' || draft.reviewMessageId) return proposalResult(draft)
    const delivered = await this.deliver(ref, draft, check)
    // The card ACK is a fact even if the Run was cancelled after it was sent.
    const current = delivered.complete && delivered.cardMessageId ? this.deps.drafts.reviewDelivered(draft.id, draft.digest, delivered.cardMessageId) : draft
    check()
    return proposalResult(current)
  }

  /** Card callback: a separate host operation, authorized by the owner's click on the delivered card only. */
  async decide(input: MinutesDraftDecision, guard: () => void): Promise<MinutesDraft> {
    const check = () => { assertRequestCurrent(); guard() }
    check()
    const draft = this.deps.drafts.get(input.draftId)
    if (!draft) throw new MinutesDraftError('not_found')
    const actor = () => {
      check()
      const current = this.deps.drafts.get(draft.id)
      if (!current || input.operatorOpenId !== current.origin.ownerOpenId || input.chatId !== current.origin.chatId ||
        !current.reviewMessageId || input.messageId !== current.reviewMessageId || input.digest !== current.digest) throw new MinutesDraftError('denied')
    }
    actor()
    const refuse = () => { throw new MinutesDraftError('changed') }
    // Ignoring, a decided draft and an expired one need no source access; the store records the outcome.
    if (input.decision === 'ignore' || draft.state !== 'pending' || this.now() >= draft.expiresAt) {
      return this.deps.drafts.decide(draft.id, input.digest, input.decision, refuse, actor)
    }
    if (!draft.items.some(item => item.selected)) throw new MinutesDraftError('invalid', NOTHING_TICKED)
    const owner = () => { actor(); this.ownerCurrent(draft.origin) }
    owner()
    const access = await this.deps.authorizeMinute(draft, owner)
    owner(); access.assertCurrent()
    if (access.status !== 'allowed') throw new MinutesDraftAccessError(access.status, access.reason)
    return this.deps.drafts.decide(draft.id, input.digest, 'accept', current => this.commit(current), () => { owner(); access.assertCurrent() })
  }

  /** The draft behind a card the owner is looking at, for redrawing it after a failed click; nobody else's draft is returned. */
  draftFor(draftId: unknown, action: { operatorOpenId?: string; chatId?: string; messageId?: string }): MinutesDraft | undefined {
    const draft = typeof draftId === 'string' ? this.deps.drafts.get(draftId) : undefined
    return draft && draft.origin.ownerOpenId === action.operatorOpenId && draft.origin.chatId === action.chatId &&
      draft.reviewMessageId === action.messageId ? draft : undefined
  }

  /** Checker callback: only the owner's click on the delivered card changes a tick; nothing is written to Todos. */
  select(input: MinutesDraftSelection, guard: () => void): MinutesDraft {
    assertRequestCurrent(); guard()
    const current = this.deps.drafts.get(input.draftId)
    if (!current) throw new MinutesDraftError('not_found')
    const actor = () => {
      assertRequestCurrent(); guard()
      const draft = this.deps.drafts.get(current.id)
      if (!draft || input.operatorOpenId !== draft.origin.ownerOpenId || input.chatId !== draft.origin.chatId ||
        !draft.reviewMessageId || input.messageId !== draft.reviewMessageId || input.digest !== draft.digest) throw new MinutesDraftError('denied')
    }
    actor()
    return this.deps.drafts.select(current.id, input.digest, input.position, input.checked, actor)
  }

  /** Discards undecided drafts older than 72 hours; writes no Todo and sends nothing. */
  expire(): number { return this.deps.drafts.expire().length }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  private ownerCurrent(origin: Pick<MinutesDraftOrigin, 'ownerOpenId' | 'spaceId' | 'chatId'>): void {
    const space = this.deps.spaces.get(origin.spaceId)
    if (origin.spaceId !== dmSpaceId(origin.ownerOpenId) || !space || space.kind !== 'p2p' || space.status !== 'active' ||
      space.chatId !== origin.chatId || this.deps.spaces.roleOf(space.id, origin.ownerOpenId) !== 'owner') throw new MinutesDraftError('denied')
    if (this.deps.policy.decide({ spaceId: space.id, openId: origin.ownerOpenId, action: 'remember' }).decision !== 'allow') {
      throw new MinutesDraftError('denied', '当前私聊不允许记录待办。')
    }
  }

  /** Runs inside the draft's transaction: every Todo and the decision commit together, or none. */
  private commit(draft: MinutesDraft): { todoId: number; duplicate: boolean }[] {
    const { origin, minute, provenance } = draft
    if (!minute || !provenance || draft.items.some(item => item.content === undefined)) throw new MinutesDraftError('changed')
    this.ownerCurrent(origin)
    const audience: TodoAudience = { scope: spaceScope(origin.spaceId), chatId: origin.chatId, chatType: 'p2p', openId: origin.ownerOpenId }
    const recorded = this.deps.drafts.recorded(origin.ownerOpenId, draft.minuteToken)
    const link = minute.url ? { status: 'available' as const, url: minute.url } : { status: 'unavailable' as const }
    return draft.items.filter(item => item.selected).map(item => {
      // An item an earlier accepted draft of this minute recorded, and whose Todo is still kept, is not written again.
      const held = (recorded.get(item.contentDigest) ?? []).map(id => this.deps.todos.get(id))
        .find(todo => todo && todo.scope === audience.scope && todo.status !== 'cancelled')
      if (held) return { todoId: held.id, duplicate: true }
      const { title, detail } = todoText(item)
      // A tick is the owner's own claim; a minute naming someone else is kept in the source note, not overridden.
      const { todo } = this.deps.todoApplication.create(audience, { title, detail, confirmed: true,
        sessionKey: origin.sessionKey, source: todoSource(minute, item),
        provenance: { ...provenance, minutes: { token: minute.token, ...(minute.title ? { title: minute.title } : {}),
          ...(minute.createdAtMs === undefined ? {} : { createdAtMs: minute.createdAtMs }), link, item: item.index,
          ...(item.basis === 'summary' ? { basis: 'summary' as const } : {}), contentDigest: item.contentDigest, draftId: draft.id } } }, origin.ownerOpenId)
      return { todoId: todo.id, duplicate: false }
    })
  }

  private async deliver(ref: MinutesRunRef, draft: MinutesDraft, guard: () => void): Promise<{ complete: boolean; cardMessageId?: string }> {
    const owner = draft.origin.ownerOpenId
    const service = new DeliveryService(this.deps.db, { spaces: this.deps.spaces, policy: this.deps.policy,
      resolveContext: async () => {
        guard()
        const context = await this.deps.resolveDelivery(ref, guard)
        guard()
        if (!context || context.actorOpenId !== owner || context.audience.kind !== 'dm' || context.audience.openId !== owner ||
          context.audience.spaceId !== draft.origin.spaceId) return undefined
        const previous = context.isCurrent
        return { ...context, isCurrent: () => { guard(); return previous?.() !== false } }
      },
      send: async ({ audience, payload }) => {
        guard()
        if (audience.kind !== 'dm' || audience.openId !== owner) throw new MinutesDraftError('denied')
        return { remoteId: await this.deps.feishu.sendToUser(audience.openId, payload) }
      } })
    // Short items are shown whole on the card; only long ones need the full text first.
    const parts = !needsFullText(draft) ? [] : Array.from(minutesDraftText(draft)).reduce<string[]>((all, point, index) => {
      const part = Math.floor(index / 3000); all[part] = (all[part] ?? '') + point; return all
    }, [])
    for (const [index, text] of parts.entries()) {
      const result = await service.deliver({ key: `minutes-draft:${draft.id}:part:${index}`, contextRef: `minutes-draft:${draft.id}`, payload: { text } })
      guard()
      if (result.status !== 'sent' && result.status !== 'confirmed') return { complete: false }
    }
    // Only after every text part is acknowledged: the card is bound to this draft's digest.
    const card = await service.deliver({ key: `minutes-draft:${draft.id}:review`, contextRef: `minutes-draft:${draft.id}`, payload: { card: minutesDraftCard(draft) } })
    return { complete: card.status === 'sent' || card.status === 'confirmed', cardMessageId: card.remoteId ?? undefined }
  }
}

function invalid(message: string): never { throw new MinutesDraftError('invalid', message) }

const clean = (value: string) => value.replace(/\s+/g, ' ').trim()
/** Surrounding quote marks and trailing punctuation are not part of the sentence the host looks for. */
const bareQuote = (value: string) => clean(value).replace(/^[「『“"'‘]+|[」』”"'’]+$/g, '').replace(/[。！？!?；;，,、…]+$/u, '').trim()

/**
 * Position-based selection over the host-read AI action items, plus candidates the model phrased when those are missing or incomplete.
 * Provider assignee IDs are compared, never turned into names; a candidate stands only on a verbatim quote of the host-read AI summary.
 */
function selectItems(input: MinutesProposal, owner: string): MinutesProposedItem[] {
  const { minute, artifacts } = input, items = input.items ?? [], candidates = input.candidates ?? []
  if (minute.token !== artifacts.token) invalid('妙记基本信息与行动项不属于同一篇妙记，没有生成草稿。')
  const total = items.length + candidates.length
  if (!total || total > MINUTES_DRAFT_MAX_ITEMS || new Set(items).size !== items.length) invalid(`请选择 1–${MINUTES_DRAFT_MAX_ITEMS} 个不重复的行动项或候选。`)
  if (items.length && artifacts.coverage.todos !== 'present') invalid('这篇妙记还没有返回行动项字段，不能按位置选择；可以改用 candidates，每条附上 AI 总结里的原句。这不表示没有行动项。')
  const selected = items.map((index): MinutesProposedItem => {
    const todo = Number.isSafeInteger(index) && index >= 0 ? artifacts.todos[index] : undefined
    if (!todo) invalid(`第 ${index + 1} 项不存在：这篇妙记当前有 ${artifacts.todos.length} 个行动项，请重新读取后按位置选择。`)
    if (todo.isDone === true) invalid(`第 ${index + 1} 项在妙记里已标记完成，不记成待办；去掉后重新提交。`)
    const content = todo.content?.trim() ?? ''
    if (!content) invalid(`第 ${index + 1} 项没有内容，不能记成待办。`)
    if (content.length > MINUTES_ITEM_MAX_LENGTH) invalid(`第 ${index + 1} 项超过 ${MINUTES_ITEM_MAX_LENGTH} 字，不能完整记成一条待办。`)
    const assignment: MinutesAssignment = !todo.assignees?.length ? 'none' : todo.assignees.includes(owner) ? 'owner' : 'others'
    return { index, content, assignment }
  })
  if (!candidates.length) return selected
  // The summary and chapter summaries are the host-read AI output; a quote must be found there word for word.
  const corpus = [artifacts.summary ?? '', ...artifacts.chapters.flatMap(chapter => [chapter.title ?? '', chapter.summary ?? ''])].map(clean).filter(Boolean)
  if (!corpus.length) invalid('这篇妙记没有返回 AI 总结，候选事项没有可核对的原文，没有生成草稿。')
  const seen = new Set<string>()
  return [...selected, ...candidates.map((candidate, index): MinutesProposedItem => {
    const text = typeof candidate?.text === 'string' ? clean(candidate.text) : ''
    const quote = typeof candidate?.quote === 'string' ? bareQuote(candidate.quote) : ''
    if (!text || text.length > MINUTES_CANDIDATE_MAX_TEXT) invalid(`第 ${index + 1} 条候选要写成 1–${MINUTES_CANDIDATE_MAX_TEXT} 字的一件事。`)
    if (seen.has(text)) invalid(`第 ${index + 1} 条候选和前面重复。`)
    seen.add(text)
    if (quote.length < 4 || quote.length > MINUTES_CANDIDATE_MAX_QUOTE || !corpus.some(part => part.includes(quote))) {
      invalid(`第 ${index + 1} 条候选的依据不是这篇妙记 AI 总结里的原句；请逐字引用总结或章节摘要里的一句（4–${MINUTES_CANDIDATE_MAX_QUOTE} 字）。`)
    }
    return { index, content: text, assignment: 'none', basis: 'summary', quote }
  })]
}

/** Whether any item is too long to show whole on the card, so the full text goes out first. */
function needsFullText(draft: MinutesDraft): boolean {
  return draft.items.some(item => (item.content ?? '').length > MINUTES_CARD_ITEM_MAX)
}

function draftMinute(brief: MinuteBrief): MinutesDraftMinute {
  const title = brief.title?.replace(/\s+/g, ' ').trim().slice(0, 200)
  let url: string | undefined
  try {
    const parsed = brief.url ? new URL(brief.url) : undefined
    if (parsed?.protocol === 'https:' && !parsed.username && !parsed.password) url = brief.url
  } catch { /* An unusable link is reported as unavailable, never guessed. */ }
  return { token: brief.token, ...(title ? { title } : {}), ...(url ? { url } : {}),
    ...(Number.isSafeInteger(brief.createdAtMs) && brief.createdAtMs! >= 0 ? { createdAtMs: brief.createdAtMs } : {}) }
}

function todoText(item: MinutesDraftItem): { title: string; detail: string | null } {
  const content = item.content!, title = clean(content)
  const basis = item.basis === 'summary' && item.quote ? `依据（妙记 AI 总结原句）：「${item.quote}」` : null
  if (title.length <= 200) return { title, detail: basis }
  return { title: `${title.slice(0, 199)}…`, detail: [content.trim(), basis].filter(Boolean).join('\n\n') }
}

function todoSource(minute: MinutesDraftMinute, item: MinutesDraftItem): string {
  return `本人勾选的妙记${item.basis === 'summary' ? '总结事项' : '行动项'}${minute.title ? ` · ${minute.title.slice(0, 80)}` : ''}${
    item.assignment === 'others' ? '；妙记标注为其他人负责' : ''}`
}

function beijingTime(ms: number): string {
  const date = new Date(ms + 8 * 3600_000), pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

function proposalResult(draft: MinutesDraft): MinutesProposalResult {
  const delivered = draft.state === 'pending' && Boolean(draft.reviewMessageId)
  const notice = draft.state === 'accepted' ? `本人已勾选并记录 ${draft.todoIds.length} 项待办。`
    : draft.state === 'ignored' ? '本人选了「都不是我的」，没有写入待办；需要时请本人重新提出。'
      : draft.state === 'expired' ? '这份草稿超过 72 小时未确认已作废，没有写入待办；需要时请本人重新提出。'
        : delivered ? `已把 ${draft.itemCount} 项发到本人私聊，每项带勾选框。本人勾选算自己的并点「记录」前没有写入待办；忽略或 72 小时未确认则作废。不要改用 friday_todo_add，也不要再让本人打字回复编号。回复本人一句话说明卡已发出即可，不要把卡上的事项再列一遍。`
          : '草稿已生成，但卡片尚未确认送达，没有写入待办。'
  return { draftId: draft.id, state: draft.state, items: draft.itemCount, reviewDelivered: delivered, todoIds: [...draft.todoIds],
    expiresAt: new Date(draft.expiresAt).toISOString(), notice }
}

function assignmentLabel(item: MinutesDraftItem): string {
  return item.basis === 'summary' ? '从总结里找到' : item.assignment === 'owner' ? '标注：你' : item.assignment === 'others' ? '标注：其他人' : '未标注负责人'
}

/** Full text sent before the card when some item is too long for it. Item numbers follow the card. */
export function minutesDraftText(draft: MinutesDraft): string {
  const minute = draft.minute
  const header = [`妙记事项原文（共 ${draft.items.length} 项）`, `妙记：${minute?.title ?? '（未取得标题）'}`, `链接：${minute?.url ?? '（未取得可用链接）'}`,
    `时间：${minute?.createdAtMs === undefined ? '（未取得）' : `${beijingTime(minute.createdAtMs)}（北京时间；妙记生成时间，不一定是会议开始时间）`}`].join('\n')
  const notice = '以下是妙记 AI 产出的原文，不是会议逐字稿。在下面的卡片上勾选算你的，再点「记录」；没勾的不记，72 小时内有效。'
  return [header, notice, ...draft.items.map((item, index) => `${index + 1}. ${item.content ?? ''}\n${
    item.basis === 'summary' ? `依据（AI 总结原句）：「${item.quote ?? ''}」` : `负责人（妙记标注）：${
      item.assignment === 'owner' ? '你本人' : item.assignment === 'others' ? '其他人' : '未标注'}`}`)].join('\n\n')
}

function cardText(value: string): string { return escapeForCard(value).replace(/[\\`*_\[\]()]/g, '\\$&') }
const CARD_CONFIG = { update_multi: true, wide_screen_mode: true }

function shortDate(ms: number): string {
  const date = new Date(ms + 8 * 3600_000)
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`
}

/** The review card: one tick box per item, pre-ticked only where the minute names the owner. Rendered from the stored ticks. */
export function minutesDraftCard(draft: MinutesDraft): Record<string, unknown> {
  const minute = draft.minute, full = needsFullText(draft)
  const name = minute?.title ? `「${minute.title.length > 40 ? `${minute.title.slice(0, 39)}…` : minute.title}」` : ''
  const subtitle = [`妙记${name}`, minute?.createdAtMs === undefined ? '' : shortDate(minute.createdAtMs)].filter(Boolean).join(' · ')
  const ticked = draft.items.filter(item => item.selected).length
  const link = minute?.url ? `[打开妙记](${minute.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})。` : ''
  const elements: Record<string, unknown>[] = [
    { tag: 'markdown', content: `勾选算你的，再点「记录」；没勾的不记，72 小时内有效。${full ? '完整原文在上面。' : ''}${link}` },
  ]
  draft.items.forEach((item, position) => {
    const content = clean(item.content ?? '')
    const label = content.length > MINUTES_CARD_ITEM_MAX ? `${content.slice(0, MINUTES_CARD_ITEM_MAX - 1)}…（见上方第 ${position + 1} 项）` : content
    elements.push({ tag: 'checker', name: `item_${position}`, checked: Boolean(item.selected), overall_checkable: true,
      text: { tag: 'plain_text', content: `${label}（${assignmentLabel(item)}）` },
      behaviors: [{ type: 'callback', value: { action: 'minutes_draft_select', draftId: draft.id, digest: draft.digest, item: position } }] })
    if (item.basis === 'summary' && item.quote) elements.push({ tag: 'markdown', content: `<font color="grey">依据：「${cardText(item.quote)}」</font>` })
  })
  elements.push({ tag: 'column_set', columns: (['accept', 'ignore'] as const).map(decision => ({ tag: 'column', width: 'weighted', weight: 1, elements: [
    { tag: 'button', text: { tag: 'plain_text', content: decision === 'accept' ? (ticked ? `记录勾选的 ${ticked} 项` : '记录勾选的项') : '都不是我的' },
      type: decision === 'accept' ? 'primary' : 'default',
      behaviors: [{ type: 'callback', value: { action: 'minutes_draft_decide', draftId: draft.id, digest: draft.digest, decision } }] },
  ] })) })
  return { schema: '2.0', config: CARD_CONFIG, header: { title: { tag: 'plain_text', content: '哪些算你的？' },
    ...(subtitle ? { subtitle: { tag: 'plain_text', content: subtitle } } : {}), template: 'blue' }, body: { elements } }
}

/** Returned in the card callback response, so the clicked card itself shows the outcome without buttons. */
export function minutesDecidedCard(draft: MinutesDraft): Record<string, unknown> {
  const duplicates = draft.items.filter(item => item.duplicate).length
  const skipped = draft.items.filter(item => !item.selected).length
  const [title, template, content] = draft.state === 'accepted'
    ? ['已记录', 'green', `记了 ${draft.todoIds.length} 项待办，每项都记下了这篇妙记作为出处。${duplicates ? `另有 ${duplicates} 项之前已记过，没有重复添加。` : ''}${skipped ? `没勾的 ${skipped} 项没有记。` : ''}`]
    : draft.state === 'ignored' ? ['都不是你的', 'grey', '没有新增待办，这份草稿的内容已丢弃。']
      : draft.state === 'expired' ? ['已过期', 'grey', '超过 72 小时没有确认，没有新增待办，这份草稿的内容已丢弃。']
        : ['哪些算你的？', 'blue', '这份草稿仍待确认。']
  return { schema: '2.0', config: CARD_CONFIG, header: { title: { tag: 'plain_text', content: title }, template }, body: { elements: [{ tag: 'markdown', content }] } }
}

export function minutesDecisionToast(draft: MinutesDraft): string {
  const duplicates = draft.items.filter(item => item.duplicate).length
  return draft.state === 'accepted' ? `已记录 ${draft.todoIds.length} 项待办。${duplicates ? `${duplicates} 项之前已记过，没有重复添加。` : ''}`
    : draft.state === 'ignored' ? '好的，都不记。'
      : draft.state === 'expired' ? '这份草稿已超过 72 小时，没有记录待办；需要时请重新让我读取这篇妙记。' : '这份草稿仍待确认。'
}
