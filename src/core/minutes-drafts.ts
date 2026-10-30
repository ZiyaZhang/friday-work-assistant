import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { TodoProvenance } from './todo-provenance.js'

/** An undecided draft is discarded after this window; nothing is written to Todos. */
export const MINUTES_DRAFT_TTL_MS = 72 * 3600_000
export const MINUTES_DRAFT_MAX_ITEMS = 50
/** Same bound as a Todo detail: the full item text must fit one Todo. */
export const MINUTES_ITEM_MAX_LENGTH = 2000

export interface MinutesDraftOrigin {
  runId: string; taskId: number; workKey: string; sessionKey: string; requestMessageId: string
  /** Always the owner's own private chat: a draft is neither proposed to nor decided in a group. */
  ownerOpenId: string; spaceId: string; chatId: string
}
/** Host-read metadata. The creation time is the minute's, not necessarily the meeting start. */
export interface MinutesDraftMinute { token: string; title?: string; url?: string; createdAtMs?: number }
/** Exact comparison of the provider's assignee IDs with the owner's open_id; no name is guessed. */
export type MinutesAssignment = 'owner' | 'others' | 'none'
/** `todo`: one of the minute's AI action items. `summary`: a candidate the model phrased, backed by a verbatim quote of the AI summary. */
export type MinutesItemBasis = 'todo' | 'summary'
export interface MinutesDraftItem {
  /** Position among the minute's AI action items (basis `todo`) or among the proposed candidates (basis `summary`). */
  index: number
  /** Absent on drafts proposed before candidates existed: those are AI action items. */
  basis?: MinutesItemBasis
  assignment: MinutesAssignment
  contentDigest: string
  /** Host-read text (or the candidate's wording), kept only while the draft is pending. */
  content?: string
  /** Pending only: the verbatim AI-summary sentence a `summary` candidate rests on. */
  quote?: string
  /** The owner's current tick on the card. Only ticked items are recorded on acceptance. */
  selected?: boolean
  /** After acceptance: the Todo holding this item; `duplicate` when an earlier accepted draft already held it. */
  todoId?: number
  duplicate?: boolean
}
export type MinutesDraftState = 'pending' | 'accepted' | 'ignored' | 'expired'
export interface MinutesDraft {
  id: string; digest: string; minuteToken: string; origin: MinutesDraftOrigin; state: MinutesDraftState
  createdAt: number; expiresAt: number; itemCount: number; items: MinutesDraftItem[]
  /** Todos this draft created (duplicates excluded). */
  todoIds: number[]
  /** Pending only: a decided draft keeps just its decision record, never the minute's text. */
  minute?: MinutesDraftMinute; provenance?: TodoProvenance
  reviewMessageId?: string; decidedAt?: number
}

export interface MinutesProposedItem { index: number; content: string; assignment: MinutesAssignment; basis?: MinutesItemBasis; quote?: string }
export const NOTHING_TICKED = '还没勾选任何一项。勾选算你的事项再点「记录」；都不是就点「都不是我的」。'

export class MinutesDraftError extends Error {
  constructor(readonly code: 'not_found' | 'denied' | 'changed' | 'invalid' | 'unconfirmed', message?: string) {
    super(message ?? ({ not_found: '当前未找到这份妙记草稿。', denied: '只有本人能在自己和 Friday 的私聊里处理这份妙记草稿。',
      changed: '这份妙记草稿已变化，请核对当前版本。', invalid: '妙记行动项不完整，没有生成草稿。',
      unconfirmed: '完整行动项和确认卡尚未确认送达，不能据此记录待办。' })[code])
    this.name = 'MinutesDraftError'
  }
}
/** The owner's current personal access to this exact minute could not be confirmed when accepting. */
export class MinutesDraftAccessError extends MinutesDraftError {
  constructor(readonly status: 'denied' | 'unavailable', readonly reason: string) {
    super('denied', status === 'unavailable' ? '暂时无法核验你对这篇妙记的读取授权，没有记录待办。' : '你对这篇妙记的读取授权已变化，没有记录待办。')
    this.name = 'MinutesDraftAccessError'
  }
}

/** Schema only. Startup and the migration adapter both call it; the table exists whether or not anyone uses Minutes. */
export function ensureMinutesDraftSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS minutes_drafts (
    id TEXT PRIMARY KEY, owner_open_id TEXT NOT NULL, minute_token TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL,
    value_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(owner_open_id,digest)
  ); CREATE INDEX IF NOT EXISTS idx_minutes_drafts_owner ON minutes_drafts(owner_open_id,minute_token,state);`)
}

export function minutesItemDigest(token: string, content: string): string {
  return createHash('sha256').update(JSON.stringify([token, content.replace(/\s+/g, ' ').trim()])).digest('hex')
}

function stableDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex')
}

/** Reviewed drafts of host-read minutes action items. Todos stay their own domain; this only records the owner's decision. */
export class MinutesDrafts {
  constructor(readonly db: DatabaseSync, private readonly now: () => number = Date.now) { ensureMinutesDraftSchema(db) }

  get(id: string): MinutesDraft | undefined {
    const row = this.db.prepare('SELECT value_json FROM minutes_drafts WHERE id=?').get(id)
    return row && JSON.parse(String(row.value_json)) as MinutesDraft
  }

  /** One owner, request and host-read content is one draft; a new request is a new draft. */
  propose(input: { origin: MinutesDraftOrigin; minute: MinutesDraftMinute; items: MinutesProposedItem[]; provenance: TodoProvenance }): MinutesDraft {
    const { origin, minute, items } = input
    if (![origin.runId, origin.workKey, origin.sessionKey, origin.requestMessageId, origin.ownerOpenId, origin.spaceId, origin.chatId]
      .every(value => typeof value === 'string' && Boolean(value.trim())) || !Number.isSafeInteger(origin.taskId) || origin.taskId < 1 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(minute.token) || !items.length || items.length > MINUTES_DRAFT_MAX_ITEMS ||
      new Set(items.map(item => `${item.basis ?? 'todo'}:${item.index}`)).size !== items.length || items.some(item => !Number.isSafeInteger(item.index) || item.index < 0 ||
        typeof item.content !== 'string' || !item.content.trim() || item.content.length > MINUTES_ITEM_MAX_LENGTH ||
        !['owner', 'others', 'none'].includes(item.assignment) || !['todo', 'summary', undefined].includes(item.basis) ||
        ((item.basis === 'summary') !== (typeof item.quote === 'string' && Boolean(item.quote.trim()))))) throw new MinutesDraftError('invalid')
    const digest = stableDigest({ owner: origin.ownerOpenId, spaceId: origin.spaceId, chatId: origin.chatId, taskId: origin.taskId,
      request: origin.requestMessageId, minute, items: items.map(({ index, content, assignment, basis, quote }) =>
        ({ index, content, assignment, ...(basis === 'summary' ? { basis, quote } : {}) })) })
    const existing = this.db.prepare('SELECT id FROM minutes_drafts WHERE owner_open_id=? AND digest=?').get(origin.ownerOpenId, digest)
    if (existing) return this.transaction(() => this.expireIfDue(this.get(String(existing.id))!))
    const now = this.now()
    const draft: MinutesDraft = { id: randomUUID(), digest, minuteToken: minute.token, origin: structuredClone(origin), state: 'pending',
      createdAt: now, expiresAt: now + MINUTES_DRAFT_TTL_MS, itemCount: items.length,
      // Pre-ticked only where the minute itself names the owner; the owner ticks the rest.
      items: items.map(item => ({ index: item.index, ...(item.basis === 'summary' ? { basis: 'summary' as const, quote: item.quote } : {}),
        assignment: item.assignment, contentDigest: minutesItemDigest(minute.token, item.content), content: item.content, selected: item.assignment === 'owner' })),
      todoIds: [], minute: structuredClone(minute), provenance: structuredClone(input.provenance) }
    this.db.prepare('INSERT INTO minutes_drafts(id,owner_open_id,minute_token,digest,state,value_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(draft.id, origin.ownerOpenId, minute.token, digest, draft.state, JSON.stringify(draft), draft.createdAt, draft.expiresAt)
    return draft
  }

  /** The confirmation card's ACK. Only a draft whose full text and card were both delivered can be accepted. */
  reviewDelivered(id: string, digest: string, messageId: string): MinutesDraft {
    const draft = this.get(id)
    if (!draft || draft.digest !== digest || !messageId) throw new MinutesDraftError('changed')
    if (draft.state !== 'pending' || draft.reviewMessageId === messageId) return draft
    draft.reviewMessageId = messageId
    this.save(draft)
    return draft
  }

  /** A tick on the delivered card. Only the pending, delivered draft changes; a decided or expired one is returned as it is. */
  select(id: string, digest: string, position: number, checked: boolean, guard: () => void): MinutesDraft {
    return this.transaction(() => {
      guard()
      const draft = this.get(id)
      if (!draft) throw new MinutesDraftError('not_found')
      if (draft.digest !== digest) throw new MinutesDraftError('changed')
      if (draft.state !== 'pending') return draft
      if (this.now() >= draft.expiresAt) return this.close(draft, 'expired')
      if (!draft.reviewMessageId) throw new MinutesDraftError('unconfirmed')
      const item = Number.isSafeInteger(position) && position >= 0 ? draft.items[position] : undefined
      if (!item) throw new MinutesDraftError('changed')
      if (Boolean(item.selected) === checked) return draft
      item.selected = checked
      this.save(draft)
      return draft
    })
  }

  /** Acceptance commits every ticked item's Todo and the decision in one transaction; any failure leaves the draft pending and no Todo. */
  decide(id: string, digest: string, decision: 'accept' | 'ignore', commit: (draft: MinutesDraft) => { todoId: number; duplicate: boolean }[], guard: () => void): MinutesDraft {
    return this.transaction(() => {
      guard()
      const draft = this.get(id)
      if (!draft) throw new MinutesDraftError('not_found')
      if (draft.digest !== digest) throw new MinutesDraftError('changed')
      if (draft.state !== 'pending') return draft
      if (this.now() >= draft.expiresAt) return this.close(draft, 'expired')
      if (!draft.reviewMessageId) throw new MinutesDraftError('unconfirmed')
      if (decision === 'ignore') return this.close(draft, 'ignored')
      const chosen = draft.items.filter(item => item.selected).length
      if (!chosen) throw new MinutesDraftError('invalid', NOTHING_TICKED)
      guard()
      const results = commit(structuredClone(draft))
      if (!Array.isArray(results) || results.length !== chosen ||
        results.some(result => !Number.isSafeInteger(result.todoId) || result.todoId < 1)) throw new MinutesDraftError('invalid')
      let next = 0
      draft.items = draft.items.map(item => {
        if (!item.selected) return item
        const result = results[next++]!
        return { ...item, todoId: result.todoId, ...(result.duplicate ? { duplicate: true } : {}) }
      })
      draft.todoIds = results.filter(result => !result.duplicate).map(result => result.todoId)
      return this.close(draft, 'accepted')
    })
  }

  /** Pending drafts past their window become expired and lose their content. */
  expire(): MinutesDraft[] {
    return this.transaction(() => (this.db.prepare("SELECT id FROM minutes_drafts WHERE state='pending' AND expires_at<=? ORDER BY created_at").all(this.now()) as { id: string }[])
      .map(row => this.close(this.get(row.id)!, 'expired')))
  }

  /** Todos this owner's accepted drafts of the same minute recorded, keyed by item content digest. */
  recorded(ownerOpenId: string, minuteToken: string): Map<string, number[]> {
    const recorded = new Map<string, number[]>()
    const rows = this.db.prepare("SELECT value_json FROM minutes_drafts WHERE owner_open_id=? AND minute_token=? AND state='accepted' ORDER BY created_at")
      .all(ownerOpenId, minuteToken) as { value_json: string }[]
    for (const row of rows) {
      for (const item of (JSON.parse(row.value_json) as MinutesDraft).items) {
        if (item.todoId !== undefined) recorded.set(item.contentDigest, [...recorded.get(item.contentDigest) ?? [], item.todoId])
      }
    }
    return recorded
  }

  private expireIfDue(draft: MinutesDraft): MinutesDraft {
    return draft.state === 'pending' && this.now() >= draft.expiresAt ? this.close(draft, 'expired') : draft
  }
  /** Decided drafts keep IDs, digests and counts only; the minute's title, link, item text and request evidence are dropped. */
  private close(draft: MinutesDraft, state: Exclude<MinutesDraftState, 'pending'>): MinutesDraft {
    draft.state = state
    draft.decidedAt = this.now()
    delete draft.minute
    delete draft.provenance
    draft.items = state === 'accepted' ? draft.items.map(({ content: _content, quote: _quote, ...item }) => item) : []
    if (state !== 'accepted') draft.todoIds = []
    this.save(draft)
    return draft
  }
  private save(draft: MinutesDraft): void {
    this.db.prepare('UPDATE minutes_drafts SET state=?,value_json=? WHERE id=?').run(draft.state, JSON.stringify(draft), draft.id)
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('SAVEPOINT minutes_draft')
    try { const result = work(); this.db.exec('RELEASE minutes_draft'); return result }
    catch (error) { this.db.exec('ROLLBACK TO minutes_draft'); this.db.exec('RELEASE minutes_draft'); throw error }
  }
}
