/**
 * Host adapters for personal-assistant reads (My Day). Built only from existing domains: Run and
 * session identity, Spaces, Todos, Inbox, routine proposals, issue-validity decisions and the personal
 * calendar port. It adds no table and never writes business state (no reminder, nudge or decision change).
 *
 * Visibility rule chosen by the user (2026-09-23): a Todo assigned to me in a group shows its content
 * only when I could see it in that group now — the space is active, fresh app-identity membership of
 * the chat includes me, I have not stopped Friday from reading that chat, and the Todo came from that
 * group's own conversation (the same audience filter as the group's own Todo list). Otherwise only the
 * count is reported. Accumulated sources of the original Run are not re-checked item by item.
 */
import type { CalendarEvent } from '../feishu/client.js'
import type { Inbox, PendingItem } from './inbox.js'
import type { IssueValidityRequests } from './issue-validity.js'
import { MyDayApplication, MyDayError, type MyDayAccess, type MyDayBinding, type MyDayResult, type MyDayUnavailable } from './my-day.js'
import type { PolicyService } from './policy.js'
import type { Registry } from './registry.js'
import { AUTH_EXPIRED, type RoutineStore } from './routines.js'
import { providerAccessFailure } from './access-failure.js'
import { assertRequestCurrent } from './request-lease.js'
import type { RunAttempts } from './run-attempts.js'
import { dmSpaceId, spaceScope, type Space, type Spaces } from './space.js'
import { todoTag, type Todo, type TodoAudience, type Todos } from './todos.js'
import type { TodoOriginLink } from './todo-provenance.js'

/** The existing personal calendar read, in a non-waiting form: it never starts or waits for an
 * authorization card. `complete` is false when the platform result may be cut off. */
export type PersonalCalendarRead =
  | { status: 'available'; events: CalendarEvent[]; complete: boolean; assertCurrent(): void }
  | { status: 'unavailable'; reason: 'missing_connection' | 'missing_scope' | 'resource_denied' | 'network_unavailable' }

/** One actually allowed read, to be added to the reading Run's shared source context. */
export type MyDaySourceRead =
  | { kind: 'calendar'; ref: string; personalOpenId: string }
  | { kind: 'todo'; todoId: number; chatId: string; spaceId: string }
  | { kind: 'decision'; inboxId: number; chatId: string; spaceId: string }

export interface PersonalAssistantHostDeps {
  registry: Pick<Registry, 'getSession'>
  attempts: Pick<RunAttempts, 'get'>
  spaces: Pick<Spaces, 'get' | 'byChat' | 'roleOf'>
  policy: Pick<PolicyService, 'decide'>
  todos: Pick<Todos, 'get' | 'getProvenance' | 'listOwnedBy' | 'getForAudience'>
  inbox: Pick<Inbox, 'get' | 'pending'>
  routines?: Pick<RoutineStore, 'get'>
  issueValidity?: Pick<IssueValidityRequests, 'forDecision'>
  /** Fresh app-identity membership of a group chat. Throws when it cannot be read. */
  members(chatId: string, assertCurrent: () => void): Promise<ReadonlySet<string>>
  /** Display name of a group chat; failures only drop the name. */
  chatName?(chatId: string): Promise<string | undefined>
  /** The person's own “stop reading this chat” choice (ChatReadScope.isReadable). Required: an unwired
   * check would silently show items from a chat the person told Friday to stop reading. */
  readable(openId: string, chatId: string): boolean
  snoozedUntil?(openId: string, todoId: number): number
  readCalendar(openId: string, range: { startSec: number; endSec: number }, assertCurrent: () => void): Promise<PersonalCalendarRead>
  recordSource(sessionKey: string, source: MyDaySourceRead): void
  now?: () => number
}

const unavailable = (reason: MyDayUnavailable): MyDayAccess => ({ status: 'unavailable', reason, assertCurrent: () => {} })
const stale = (): MyDayAccess => ({ status: 'stale', assertCurrent: () => {} })

/** My Day for a tool/API call bound to the person's current Run in their own private chat. */
export function createMyDayApplication(deps: PersonalAssistantHostDeps): MyDayApplication {
  return buildMyDay(deps, ref => {
    const read = () => {
      const run = deps.attempts.get(ref.runId), session = deps.registry.getSession(ref.sessionKey)
      if (!run || run.state !== 'running' || run.sessionKey !== ref.sessionKey || !session || session.status === 'archived' || session.chatType !== 'p2p') throw new MyDayError('denied')
      const openId = run.actorOpenId
      if (!openId || session.requesterOpenId !== openId) throw new MyDayError('denied')
      assertOwnPrivateSpace(deps, openId)
      return { openId, chatId: session.chatId }
    }
    return bindingOf(ref, read)
  }, deps.recordSource)
}

/**
 * “我的任务” menu: the host passes the authenticated menu operator and the private chat the event came
 * from. No model Run consumes the result, so no source context is written. The text goes only to them.
 */
export function createMyDayMenuReader(deps: Omit<PersonalAssistantHostDeps, 'registry' | 'attempts' | 'recordSource'>):
  (person: { openId: string; chatId: string; eventId: string }, input?: { date?: string; limit?: number }) => Promise<MyDayResult> {
  return async (person, input = {}) => {
    if (!person.openId?.trim() || !person.chatId?.trim() || !person.eventId?.trim()) throw new MyDayError('denied')
    const ref = { sessionKey: `menu:${person.openId}`, runId: `menu:${person.eventId}` }
    const app = buildMyDay(deps, value => {
      if (value.sessionKey !== ref.sessionKey || value.runId !== ref.runId) throw new MyDayError('denied')
      return bindingOf(value, () => { assertOwnPrivateSpace(deps, person.openId); return { openId: person.openId, chatId: person.chatId } })
    }, () => {})
    const result = await app.read(ref, input)
    app.assertResultCurrent(result)
    return result
  }
}

function assertOwnPrivateSpace(deps: Pick<PersonalAssistantHostDeps, 'spaces' | 'policy'>, openId: string): void {
  const spaceId = dmSpaceId(openId), space = deps.spaces.get(spaceId)
  if (!space || space.status !== 'active' || deps.spaces.roleOf(spaceId, openId) !== 'owner' ||
    deps.policy.decide({ spaceId, openId, action: 'read' }).decision !== 'allow') throw new MyDayError('denied')
}

function bindingOf(ref: { sessionKey: string; runId: string }, read: () => { openId: string; chatId: string }): MyDayBinding {
  assertRequestCurrent()
  const initial = read()
  return { sessionKey: ref.sessionKey, runId: ref.runId, openId: initial.openId, spaceId: dmSpaceId(initial.openId), chatId: initial.chatId,
    chatType: 'p2p', dmScope: spaceScope(dmSpaceId(initial.openId)),
    assertCurrent: () => { assertRequestCurrent(); const now = read(); if (now.openId !== initial.openId || now.chatId !== initial.chatId) throw new MyDayError('denied') } }
}

function buildMyDay(deps: Omit<PersonalAssistantHostDeps, 'registry' | 'attempts' | 'recordSource'>, bind: (ref: { sessionKey: string; runId: string }) => MyDayBinding,
  recordSource: PersonalAssistantHostDeps['recordSource']): MyDayApplication {
  // One membership lookup per chat per read: MyDayApplication passes the same binding object to every check.
  const memberships = new WeakMap<MyDayBinding, Map<string, Promise<ReadonlySet<string>>>>()
  const membersOf = (binding: MyDayBinding, chatId: string, assertCurrent: () => void): Promise<ReadonlySet<string>> => {
    let cache = memberships.get(binding)
    if (!cache) memberships.set(binding, cache = new Map())
    let pending = cache.get(chatId)
    if (!pending) cache.set(chatId, pending = deps.members(chatId, assertCurrent))
    return pending
  }
  const names = new WeakMap<MyDayBinding, Map<string, Promise<string | null>>>()
  const nameOf = (binding: MyDayBinding, chatId: string): Promise<string | null> => {
    let cache = names.get(binding)
    if (!cache) names.set(binding, cache = new Map())
    let pending = cache.get(chatId)
    if (!pending) cache.set(chatId, pending = (deps.chatName?.(chatId) ?? Promise.resolve(undefined)).then(name => name?.trim() || null, () => null))
    return pending
  }

  /** Legacy scopes are resolved the same way as the reminder route. */
  const originOf = (scope: string): Space | undefined => scope.startsWith('space:') ? deps.spaces.get(scope.slice(6))
    : scope.startsWith('user:') ? deps.spaces.get(dmSpaceId(scope.slice(5)))
      : scope.startsWith('chat:') ? deps.spaces.byChat(scope.slice(5), true) : undefined
  const groupUsable = (space: Space | undefined, chatId: string, openId: string): space is Space & { chatId: string } =>
    !!space && space.status === 'active' && space.kind === 'group' && space.chatId === chatId && deps.readable(openId, chatId) !== false

  /** Current membership of the original group, for this person, at this moment. */
  async function groupAccess(binding: MyDayBinding, space: Space, guard: () => void): Promise<{ ok: true; chatId: string; place: string | null } | { ok: false; access: MyDayAccess }> {
    const chatId = space.chatId
    if (!chatId || !groupUsable(space, chatId, binding.openId)) return { ok: false, access: unavailable('resource_denied') }
    let members: ReadonlySet<string>
    try { members = await membersOf(binding, chatId, guard) }
    catch (error) {
      guard()
      const failure = providerAccessFailure(error, 'app')
      if (failure?.reason === 'service_unavailable') return { ok: false, access: unavailable('network_unavailable') }
      if (failure && ['app_scope_missing', 'resource_forbidden', 'access_rejected'].includes(failure.reason)) {
        return { ok: false, access: unavailable('resource_denied') }
      }
      throw error
    }
    guard()
    if (!members.has(binding.openId) || !groupUsable(deps.spaces.get(space.id), chatId, binding.openId)) return { ok: false, access: unavailable('resource_denied') }
    return { ok: true, chatId, place: await nameOf(binding, chatId) }
  }

  return new MyDayApplication({
    todos: deps.todos,
    inbox: deps.inbox,
    now: deps.now,

    binding: bind,

    async authorizeTodo(binding, todo, provenance, guard) {
      if ((deps.snoozedUntil?.(binding.openId, todo.id) ?? 0) > (deps.now?.() ?? Date.now())) return stale()
      const collection = provenance?.collection
      const sourceReadable = () => !collection || collection.ownerOpenId === binding.openId && deps.readable(binding.openId, collection.message.chatId)
      if (!sourceReadable()) return unavailable('resource_denied')
      const origin = originOf(todo.scope)
      if (!origin) return unavailable('source_unverified')
      if (origin.kind === 'p2p') {
        if (origin.id !== binding.spaceId) return unavailable('resource_denied')
        const audience: TodoAudience = { scope: todo.scope, chatId: binding.chatId, chatType: 'p2p', openId: binding.openId }
        if (!sameTodo(deps.todos.getForAudience(todo.id, audience), todo)) return unavailable('resource_denied')
        return { status: 'allowed', place: null, assertCurrent: () => {
          if (!sourceReadable() || (deps.snoozedUntil?.(binding.openId, todo.id) ?? 0) > (deps.now?.() ?? Date.now()) ||
            !sameTodo(deps.todos.getForAudience(todo.id, audience), todo)) throw new MyDayError('changed')
        } }
      }
      const group = await groupAccess(binding, origin, guard)
      if (!group.ok) return group.access
      // Same audience filter as that group's own Todo list: a Todo recorded from another conversation stays out.
      const audience: TodoAudience = { scope: todo.scope, chatId: group.chatId, chatType: 'group', openId: binding.openId }
      if (!sameTodo(deps.todos.getForAudience(todo.id, audience), todo)) return unavailable('resource_denied')
      return { status: 'allowed', place: group.place, assertCurrent: () => {
        if (!groupUsable(deps.spaces.get(origin.id), group.chatId, binding.openId) || !sameTodo(deps.todos.getForAudience(todo.id, audience), todo)) throw new MyDayError('changed')
      } }
    },

    recordTodoRead(binding, todo) {
      const origin = originOf(todo.scope)
      if (origin?.kind === 'group' && origin.chatId) recordSource(binding.sessionKey, { kind: 'todo', todoId: todo.id, chatId: origin.chatId, spaceId: origin.id })
    },

    async authorizeDecision(binding, item, guard) {
      if (item.ownerOpenId !== binding.openId) return unavailable('resource_denied')
      if (!stillPending(item)) return stale()
      const pendingNow = () => { if (!stillPending(item)) throw new MyDayError('changed') }
      const issue = item.kind === 'decision' && item.refId !== null ? deps.issueValidity?.forDecision(item.refId) : undefined
      const issueLink: TodoOriginLink | undefined = issue?.url && /^https:\/\//.test(issue.url) ? { status: 'available', url: issue.url } : undefined
      if (item.spaceId === null || item.spaceId === binding.spaceId) {
        return { status: 'allowed', place: null, ...(issueLink ? { sourceLink: issueLink } : {}), assertCurrent: pendingNow }
      }
      const space = deps.spaces.get(item.spaceId)
      if (!space) return unavailable('source_unverified')
      if (space.kind !== 'group') return unavailable('resource_denied')
      const group = await groupAccess(binding, space, guard)
      if (!group.ok) return group.access
      const chatLink: TodoOriginLink = { status: 'available', url: `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(group.chatId)}` }
      return { status: 'allowed', place: group.place, sourceLink: issueLink ?? chatLink, assertCurrent: () => {
        pendingNow()
        if (!groupUsable(deps.spaces.get(space.id), group.chatId, binding.openId)) throw new MyDayError('changed')
      } }
    },

    recordDecisionRead(binding, item) {
      if (!item.spaceId || item.spaceId === binding.spaceId) return
      const space = deps.spaces.get(item.spaceId)
      if (space?.kind === 'group' && space.chatId) recordSource(binding.sessionKey, { kind: 'decision', inboxId: item.id, chatId: space.chatId, spaceId: space.id })
    },

    async calendar(binding, range, guard) {
      const startSec = Math.floor(range.startMs / 1000), endSec = Math.ceil(range.endMs / 1000)
      const read = await deps.readCalendar(binding.openId, { startSec, endSec }, guard)
      guard()
      if (read.status !== 'available') return { status: 'unavailable', reason: read.reason, assertCurrent: guard }
      read.assertCurrent()
      recordSource(binding.sessionKey, { kind: 'calendar', ref: `calendar:${binding.openId}:${startSec}:${endSec}`, personalOpenId: binding.openId })
      return { status: 'allowed', events: read.events, complete: read.complete, assertCurrent: () => { guard(); read.assertCurrent() } }
    },
  })

  /** Pointer items stay in the Inbox until someone resolves them; the owning domain says whether they still wait. */
  function stillPending(item: PendingItem): boolean {
    if (item.resolvedAt !== null) return false
    if (item.refId === null) return true
    if (item.kind === 'responsibility') return deps.routines?.get(item.refId)?.status === 'proposed'
    if (item.kind === 'auth') { const routine = deps.routines?.get(item.refId); return !!routine && routine.disabledReason === AUTH_EXPIRED }
    return true
  }
}

function sameTodo(found: Todo | undefined, expected: Todo): boolean { return !!found && todoTag(found) === todoTag(expected) }

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const TZ_OFFSET_MS = 8 * 3600_000
function local(ms: number): Date { return new Date(ms + TZ_OFFSET_MS) }
function clock(ms: number): string { const d = local(ms); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` }
function day(ms: number): string { const d = local(ms); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日` }
function ago(ms: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000))
  return minutes < 60 ? `${Math.max(1, minutes)} 分钟前` : minutes < 24 * 60 ? `${Math.round(minutes / 60)} 小时前` : `${Math.round(minutes / 1440)} 天前`
}
const CALENDAR_GAP: Record<string, string> = {
  missing_connection: '日历没有读取：还没有授权 Friday 读你的个人日历',
  missing_scope: '日历没有读取：个人授权里缺少日历权限',
  resource_denied: '日历没有读取：没有读取权限',
  network_unavailable: '日历这次没读到，稍后再试',
  source_unverified: '日历没有读取：来源无法核验',
}
const ITEM_GAP: Record<MyDayUnavailable, string> = {
  resource_denied: '你现在看不到原群（不在群里、群已停用或已停止读取）',
  network_unavailable: '暂时查不到原群的成员',
  source_unverified: '来源无法核验',
  missing_connection: '缺少个人授权',
  missing_scope: '缺少个人授权范围',
}

/**
 * Text form of My Day. 'person' is sent directly to the person (menu): no ids, no internal markers.
 * 'model' is a tool result: it keeps `[todo:<id>]` handles so a follow-up can name the exact item.
 * Hidden items are only counted, never described.
 */
export function renderMyDay(result: MyDayResult, opts: { for: 'person' | 'model' }): string {
  const lines: string[] = [], now = result.observedAt
  const handle = (id: number) => opts.for === 'model' ? ` [todo:${id}]` : ''
  const link = (value: TodoOriginLink | undefined, label: string) => value?.status === 'available' ? ` · [${label}](${value.url})` : ''
  lines.push(`**${result.date === new Date(now + TZ_OFFSET_MS).toISOString().slice(0, 10) ? '今天' : result.date} ${day(result.startMs)}（周${WEEKDAYS[local(result.startMs).getUTCDay()]}）** · 北京时间`)

  const todos = result.todos.items
  const groups: [string, typeof todos][] = [['已逾期', todos.filter(item => item.timing === 'overdue')], ['今天到期', todos.filter(item => item.timing === 'today')],
    ['之后', todos.filter(item => item.timing === 'later')], ['未定时间', todos.filter(item => item.timing === 'undated')]]
  if (todos.length) {
    lines.push('', `**待办（${todos.length}）**`)
    for (const [title, items] of groups) {
      if (!items.length) continue
      lines.push(title)
      for (const item of items) {
        const due = item.dueMs === null ? '' : item.timing === 'today' ? `（${clock(item.dueMs)} 截止）` : `（截止 ${day(item.dueMs)} ${clock(item.dueMs)}）`
        const where = [item.place && `「${item.place}」`, item.source].filter(Boolean).join(' · ')
        const origin = item.origin?.request?.link ?? item.origin?.selectedInputs.find(source => source.link.status === 'available')?.link
        const relationship = item.collection ? ({ requested: '对方请你处理', committed: '你已承诺', uncertain: '归属待核实' }[item.collection.relationship]) : item.confirmed ? '' : '待确认'
        lines.push(`- ${item.title}${due}${relationship ? `（${relationship}）` : ''}${item.collection?.kind === 'reply' ? ' · 待回复' : ''}${where ? ` · ${where}` : ''}${link(origin, '原消息')}${handle(item.id)}`)
      }
    }
  } else if (result.todos.coverage.complete) lines.push('', '**待办**：没有需要你负责的待办。')

  const decisions = result.decisions.items
  if (decisions.length) {
    lines.push('', `**等你拍板（${decisions.length}）**`)
    for (const item of decisions) {
      lines.push(`- ${item.title}${item.why ? `——${item.why}` : ''}${item.place ? ` · 「${item.place}」` : ''} · ${ago(item.createdAt, now)}${link(item.sourceLink, '查看')}`)
    }
  } else if (result.decisions.coverage.complete) lines.push('', '**等你拍板**：没有。')

  const events = result.calendar.events
  if (events.length) {
    const next = events.filter(event => event.endMs > now), past = events.length - next.length
    lines.push('', `**接下来的日程（${next.length}）**`)
    for (const event of next) {
      const when = event.allDay ? '全天' : `${clock(event.startMs)}–${clock(event.endMs)}`
      lines.push(`- ${when} ${event.summary}${event.appLink && /^https:\/\//.test(event.appLink) ? ` · [打开](${event.appLink})` : ''}`)
    }
    if (past) lines.push(`另有 ${past} 个已结束的日程。`)
  } else if (result.calendar.coverage.complete) lines.push('', '**日程**：今天没有日程。')

  const notes: string[] = []
  for (const reason of result.calendar.coverage.unavailable) notes.push(CALENDAR_GAP[reason] ?? '日历没有读取')
  if (!result.calendar.coverage.unavailable.length && !result.calendar.coverage.complete) notes.push(result.calendar.coverage.truncated ? `日程较多，只列出前 ${events.length} 条` : '日历结果可能不完整')
  for (const [label, section] of [['待办', result.todos], ['待拍板事项', result.decisions]] as const) {
    if (section.coverage.hidden) notes.push(`有 ${section.coverage.hidden} 条${label}没有显示内容：${section.coverage.unavailable.map(reason => ITEM_GAP[reason]).join('；')}`)
    if (section.coverage.truncated) notes.push(`${label}较多，只列出前 ${section.items.length} 条`)
  }
  if (notes.length) lines.push('', `说明：${notes.join('；')}。`)
  return lines.join('\n')
}
