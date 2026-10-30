import type { CalendarEvent } from '../feishu/client.js'
import type { Inbox, PendingItem } from './inbox.js'
import { responsibleOpenId, todoTag, type Todo, type Todos } from './todos.js'
import type { TodoOrigin, TodoOriginLink, TodoProvenance } from './todo-provenance.js'

export type MyDayUnavailable = 'missing_connection' | 'missing_scope' | 'resource_denied' | 'network_unavailable' | 'source_unverified'
/** 'stale': the underlying domain object is no longer pending (for example an accepted proposal).
 * It is neither shown nor reported as a gap. */
export type MyDayAccess = { status: 'allowed'; place?: string | null; assertCurrent(): void }
  | { status: 'unavailable'; reason: MyDayUnavailable; assertCurrent(): void }
  | { status: 'stale'; assertCurrent(): void }
export interface MyDayBinding {
  sessionKey: string; runId: string; openId: string; spaceId: string; chatId: string; chatType: 'p2p' | 'group'
  /** Actual person's private scope, verified by the host, never supplied by a tool argument. */
  dmScope: string
  assertCurrent(): void
}
export interface MyDayRange { date: string; timeZone: 'Asia/Shanghai'; startMs: number; endMs: number }
export interface MyDayTodo {
  id: number; title: string; detail: string | null; kind: Todo['kind']; status: Todo['status']; dueMs: number | null
  confirmed: boolean; origin: TodoOrigin | null; owner: string | null
  timing: 'overdue' | 'today' | 'later' | 'undated'
  /** Host-verified name of the original group; null for the person's own private chat. */
  place: string | null
  /** Existing display label such as “主动巡检 · 研发群”; not evidence of access. */
  source: string | null
  createdAt: number
  collection?: { kind: 'todo' | 'reply'; relationship: 'requested' | 'committed' | 'uncertain' }
}
export interface MyDayDecision { id: number; kind: PendingItem['kind']; title: string; why: string | null; createdAt: number; sourceLink: TodoOriginLink; place: string | null }
/** `hidden` counts items that exist but could not be shown to this person now; their content is never returned. */
interface Coverage { complete: boolean; truncated: boolean; unavailable: MyDayUnavailable[]; hidden: number }
export interface MyDayResult {
  date: string; timeZone: 'Asia/Shanghai'; startMs: number; endMs: number; observedAt: number
  calendar: { events: CalendarEvent[]; coverage: Coverage }
  todos: { items: MyDayTodo[]; coverage: Coverage }
  decisions: { items: MyDayDecision[]; coverage: Coverage }
}
export interface MyDayDeps {
  todos: Pick<Todos, 'get' | 'getProvenance' | 'listOwnedBy'>
  inbox: Pick<Inbox, 'get' | 'pending'>
  binding(ref: { sessionKey: string; runId: string }): MyDayBinding
  /** Check as the current viewer, not as the Todo's original author. Source registration
   * uses the existing host context and happens only for the allowed item. */
  authorizeTodo(binding: MyDayBinding, todo: Todo, provenance: TodoProvenance | null, assertCurrent: () => void): Promise<MyDayAccess>
  recordTodoRead(binding: MyDayBinding, todo: Todo, provenance: TodoProvenance | null): void
  authorizeDecision(binding: MyDayBinding, item: PendingItem, assertCurrent: () => void): Promise<MyDayAccess & { sourceLink?: TodoOriginLink }>
  recordDecisionRead(binding: MyDayBinding, item: PendingItem): void
  /** Reuse the personal calendar adapter, including its actual grant lease and source
   * recording. Typed expected failures are partial sections; unknown errors propagate. */
  calendar(binding: MyDayBinding, range: MyDayRange, assertCurrent: () => void): Promise<
    { status: 'allowed'; events: CalendarEvent[]; complete: boolean; assertCurrent(): void }
    | { status: 'unavailable'; reason: MyDayUnavailable; assertCurrent(): void }>
  now?: () => number
}

export class MyDayError extends Error {
  constructor(readonly code: 'invalid' | 'denied' | 'changed') {
    super({ invalid: '日期或汇总条数无效。', denied: '个人汇总只能由本人在私聊查看。', changed: '汇总期间事项或权限已变化，请重新读取。' }[code])
    this.name = 'MyDayError'
  }
}

/** One read model over the existing calendar, Todo and Inbox domains. No copied
 * business state, reminder acknowledgement, inferred assignment or model ranking. */
export class MyDayApplication {
  private readonly resultGuards = new WeakMap<object, () => void>()
  constructor(private readonly deps: MyDayDeps) {}

  async read(ref: { sessionKey: string; runId: string }, input: { date?: string; limit?: number } = {}): Promise<MyDayResult> {
    const binding = this.deps.binding(ref), identity = bindingKey(binding), limit = input.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || Object.keys(input).some(key => !['date', 'limit'].includes(key))) throw new MyDayError('invalid')
    const now = (this.deps.now ?? Date.now)(), range = myDayRange(now, input.date), leases: (() => void)[] = []
    const current = () => {
      binding.assertCurrent()
      const fresh = this.deps.binding(ref); fresh.assertCurrent()
      if (bindingKey(fresh) !== identity || binding.chatType !== 'p2p' || !binding.openId || !binding.dmScope ||
        ref.sessionKey !== binding.sessionKey || ref.runId !== binding.runId) throw new MyDayError('denied')
    }
    const allCurrent = () => { current(); for (const lease of leases) lease() }
    current()
    const calendar = await this.deps.calendar(binding, range, current)
    allCurrent(); calendar.assertCurrent(); leases.push(calendar.assertCurrent)
    const calendarCoverage = coverage()
    // A missing calendar has an unknown number of events: report the gap, not a hidden count.
    if (calendar.status === 'unavailable') { calendarCoverage.complete = false; calendarCoverage.unavailable.push(calendar.reason) }
    else if (!calendar.complete) calendarCoverage.complete = false
    const observedEvents = calendar.status === 'allowed' ? calendar.events.filter(event => event.startMs < range.endMs && event.endMs > range.startMs)
      .map(event => structuredClone(event)).sort((a, b) => a.startMs - b.startMs || a.eventId.localeCompare(b.eventId)) : []
    if (observedEvents.length > limit) { calendarCoverage.complete = false; calendarCoverage.truncated = true }
    const events = observedEvents.slice(0, limit)

    const owned = this.deps.todos.listOwnedBy(binding.openId, { dmScope: binding.dmScope, status: 'active', limit: limit + 1 })
    const todoCoverage = coverage(owned.length > limit), items: MyDayTodo[] = []
    for (const todo of owned.slice(0, limit)) {
      allCurrent()
      const provenance = this.deps.todos.getProvenance(todo.id), original = todoTag(todo), originalProof = JSON.stringify(provenance)
      const itemCurrent = () => {
        current()
        const fresh = this.deps.todos.get(todo.id)
        if (!fresh || todoTag(fresh) !== original || JSON.stringify(this.deps.todos.getProvenance(todo.id)) !== originalProof ||
          responsibleOpenId(fresh) !== binding.openId) throw new MyDayError('changed')
      }
      itemCurrent()
      const access = await this.deps.authorizeTodo(binding, todo, provenance, itemCurrent)
      allCurrent(); itemCurrent(); access.assertCurrent()
      if (access.status === 'stale') continue
      if (access.status !== 'allowed') { unavailable(todoCoverage, access.reason); continue }
      const guard = () => { itemCurrent(); access.assertCurrent() }
      guard(); this.deps.recordTodoRead(binding, todo, provenance); guard(); leases.push(guard)
      items.push({ id: todo.id, title: todo.title, detail: todo.detail, kind: todo.kind, status: todo.status,
        dueMs: todo.dueMs, confirmed: todo.confirmed, owner: todo.owner, origin: structuredClone(todo.origin),
        timing: todo.dueMs === null ? 'undated' : todo.dueMs < range.startMs ? 'overdue' : todo.dueMs < range.endMs ? 'today' : 'later',
        place: access.place ?? null, source: todo.source, createdAt: todo.createdAt,
        ...(provenance?.collection ? { collection: { kind: provenance.collection.kind, relationship: provenance.collection.relationship } } : {}) })
    }

    const pending = this.deps.inbox.pending(binding.openId), decisionCoverage = coverage(pending.length > limit), decisions: MyDayDecision[] = []
    for (const item of pending.slice(0, limit)) {
      allCurrent(); const original = decisionKey(item)
      const itemCurrent = () => {
        current(); const fresh = this.deps.inbox.get(item.id)
        if (!fresh || fresh.ownerOpenId !== binding.openId || fresh.resolvedAt !== null || decisionKey(fresh) !== original) throw new MyDayError('changed')
      }
      itemCurrent()
      const access = await this.deps.authorizeDecision(binding, item, itemCurrent)
      allCurrent(); itemCurrent(); access.assertCurrent()
      if (access.status === 'stale') continue
      if (access.status !== 'allowed') { unavailable(decisionCoverage, access.reason); continue }
      const guard = () => { itemCurrent(); access.assertCurrent() }
      guard(); this.deps.recordDecisionRead(binding, item); guard(); leases.push(guard)
      decisions.push({ id: item.id, kind: item.kind, title: item.title, why: item.why, createdAt: item.createdAt,
        sourceLink: structuredClone(access.sourceLink ?? { status: 'unavailable' }), place: access.place ?? null })
    }
    allCurrent()
    const result: MyDayResult = { ...range, observedAt: now, calendar: { events, coverage: calendarCoverage },
      todos: { items, coverage: todoCoverage }, decisions: { items: decisions, coverage: decisionCoverage } }
    this.resultGuards.set(result, allCurrent)
    return result
  }

  /** Recheck the same result at the HTTP/menu/delivery boundary after any caller await. */
  assertResultCurrent(result: MyDayResult): void {
    const guard = this.resultGuards.get(result)
    if (!guard) throw new MyDayError('denied')
    guard()
  }
}

/** Matches the existing personal-calendar API's UTC+8 day boundary. This explicit
 * timezone is returned in every result; it does not claim to infer the user's location. */
export function myDayRange(now: number, input?: string): MyDayRange {
  if (!Number.isSafeInteger(now)) throw new MyDayError('invalid')
  const date = input ?? new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new MyDayError('invalid')
  const utc = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== date) throw new MyDayError('invalid')
  return { date, timeZone: 'Asia/Shanghai', startMs: utc - 8 * 3600_000, endMs: utc + 16 * 3600_000 }
}
function bindingKey(value: MyDayBinding): string { return JSON.stringify([value.sessionKey, value.runId, value.openId, value.spaceId, value.chatId, value.chatType, value.dmScope]) }
function decisionKey(value: PendingItem): string { return JSON.stringify([value.id, value.ownerOpenId, value.kind, value.refId, value.spaceId, value.title, value.why, value.createdAt, value.resolvedAt]) }
function coverage(truncated = false): Coverage { return { complete: !truncated, truncated, unavailable: [], hidden: 0 } }
function unavailable(value: Coverage, reason: MyDayUnavailable): void {
  value.complete = false; value.hidden++
  if (!value.unavailable.includes(reason)) value.unavailable.push(reason)
}
