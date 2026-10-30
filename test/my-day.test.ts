import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Todos } from '../src/core/todos.js'
import { Inbox } from '../src/core/inbox.js'
import { MyDayApplication, myDayRange, type MyDayBinding, type MyDayDeps, type MyDayUnavailable } from '../src/core/my-day.js'
import type { CalendarEvent } from '../src/feishu/client.js'
import type { TodoProvenance } from '../src/core/todo-provenance.js'

const dbs: DatabaseSync[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
function fixture() {
  const db = new DatabaseSync(':memory:'); dbs.push(db)
  const todos = new Todos(db), inbox = new Inbox(db), now = Date.parse('2026-09-22T09:00:00+08:00'), range = myDayRange(now)
  const state = { live: true, scope: true, calendarUnavailable: undefined as MyDayUnavailable | undefined,
    events: [] as CalendarEvent[], hiddenTodos: new Map<number, MyDayUnavailable>(), hiddenDecisions: new Map<number, MyDayUnavailable>() }
  const current = () => { if (!state.live) throw new Error('request stopped') }
  const sourceCurrent = () => { current(); if (!state.scope) throw new Error('source permission revoked') }
  const binding: MyDayBinding = { sessionKey: 'alice-dm', runId: 'actual-run', openId: 'alice', spaceId: 'dm-alice',
    chatId: 'alice-chat', chatType: 'p2p', dmScope: 'space:sp_dm_alice', assertCurrent: current }
  const deps: MyDayDeps = { todos, inbox, now: () => now, binding: () => binding,
    calendar: vi.fn(async (_binding, _range, guard) => { guard(); return state.calendarUnavailable
      ? { status: 'unavailable' as const, reason: state.calendarUnavailable, assertCurrent: current }
      : { status: 'allowed' as const, events: state.events, complete: true, assertCurrent: sourceCurrent } }),
    authorizeTodo: vi.fn(async (_binding, todo, _provenance, guard) => { guard(); const reason = state.hiddenTodos.get(todo.id)
      return reason ? { status: 'unavailable' as const, reason, assertCurrent: current } : { status: 'allowed' as const, assertCurrent: sourceCurrent } }),
    recordTodoRead: vi.fn(),
    authorizeDecision: vi.fn(async (_binding, item, guard) => { guard(); const reason = state.hiddenDecisions.get(item.id)
      return reason ? { status: 'unavailable' as const, reason, assertCurrent: current } : { status: 'allowed' as const, assertCurrent: sourceCurrent } }),
    recordDecisionRead: vi.fn(),
  }
  const app = new MyDayApplication(deps), ref = { sessionKey: binding.sessionKey, runId: binding.runId }
  const add = (title: string, dueMs?: number, other: Partial<Parameters<Todos['add']>[0]> = {}) => todos.add({
    title, dueMs, scope: 'space:sp_dm_alice', createdBy: 'alice', ...other })
  const event = (eventId: string, startMs = now, endMs = now + 3600_000): CalendarEvent => ({ eventId, summary: eventId, startMs, endMs, allDay: false, appLink: 'https://applink.feishu.cn/synthetic-event' })
  return { db, todos, inbox, now, range, state, binding, deps, app, ref, add, event }
}

describe('one personal day read model over existing domains', () => {
  it('aggregates the actual person’s calendar, owned cross-space Todos and pending decisions without writing their state', async () => {
    const t = fixture()
    t.state.events = [t.event('later', t.now + 3600_000, t.now + 7200_000), t.event('first'), t.event('outside', t.range.endMs, t.range.endMs + 1000)]
    t.add('overdue', t.range.startMs - 1); t.add('today', t.now); t.add('later', t.range.endMs); t.add('undated')
    t.add('assigned to Alice in team space', undefined, { scope: 'space:team', ownerOpenId: 'alice', createdBy: 'bob' })
    t.add('Bob private', undefined, { scope: 'space:sp_dm_bob', ownerOpenId: 'bob', createdBy: 'bob' })
    const done = t.add('already done'); t.todos.done(done.id, done.scope)
    t.inbox.add({ ownerOpenId: 'alice', kind: 'decision', title: 'Choose a delivery date', spaceId: 'team' })
    t.inbox.add({ ownerOpenId: 'bob', kind: 'decision', title: 'Bob private decision' })
    const before = { todos: t.db.prepare('SELECT * FROM todos').all(), inbox: t.db.prepare('SELECT * FROM inbox_items').all() }
    const result = await t.app.read(t.ref)
    expect(result.calendar.events.map(e => e.eventId)).toEqual(['first', 'later'])
    expect(result.todos.items.map(item => item.title)).toEqual(expect.arrayContaining(['overdue', 'today', 'later', 'undated', 'assigned to Alice in team space']))
    expect(result.todos.items).toHaveLength(5)
    expect(Object.fromEntries(result.todos.items.map(item => [item.title, item.timing]))).toMatchObject({ overdue: 'overdue', today: 'today', later: 'later', undated: 'undated' })
    expect(result.decisions.items.map(item => item.title)).toEqual(['Choose a delivery date'])
    for (const section of [result.calendar, result.todos, result.decisions]) expect(section.coverage).toEqual({ complete: true, truncated: false, unavailable: [], hidden: 0 })
    expect(t.db.prepare('SELECT * FROM todos').all()).toEqual(before.todos); expect(t.db.prepare('SELECT * FROM inbox_items').all()).toEqual(before.inbox)
    expect(t.deps.recordTodoRead).toHaveBeenCalledTimes(5); expect(t.deps.recordDecisionRead).toHaveBeenCalledOnce()
  })

  it.each(['missing_connection', 'missing_scope', 'resource_denied', 'network_unavailable'] as const)('keeps other sections when the calendar is explicitly %s', async reason => {
    const t = fixture(); t.state.calendarUnavailable = reason; t.add('Keep the local Todo')
    const result = await t.app.read(t.ref)
    expect(result.calendar).toEqual({ events: [], coverage: { complete: false, truncated: false, unavailable: [reason], hidden: 0 } })
    expect(result.todos.items).toHaveLength(1); expect(result.todos.coverage.complete).toBe(true)
  })

  it('does not expose unreadable cross-space content or use original authors as the viewer', async () => {
    const t = fixture(), privateTodo = t.add('Secret team item', undefined, { scope: 'space:team', ownerOpenId: 'alice', createdBy: 'bob' })
    const privateDecision = t.inbox.add({ ownerOpenId: 'alice', kind: 'decision', title: 'Secret decision', spaceId: 'former-team' })
    t.state.hiddenTodos.set(privateTodo.id, 'resource_denied'); t.state.hiddenDecisions.set(privateDecision.id, 'source_unverified')
    const result = await t.app.read(t.ref)
    expect(result.todos).toMatchObject({ items: [], coverage: { complete: false, unavailable: ['resource_denied'] } })
    expect(result.decisions.items).toEqual([]); expect(JSON.stringify(result)).not.toContain('Secret')
    expect(t.deps.authorizeTodo).toHaveBeenCalledWith(expect.objectContaining({ openId: 'alice' }), expect.objectContaining({ createdBy: 'bob' }), null, expect.any(Function))
    expect(t.deps.recordTodoRead).not.toHaveBeenCalled(); expect(t.deps.recordDecisionRead).not.toHaveBeenCalled()
  })

  it('preserves the host-verified Todo source link without exposing its permission manifest', async () => {
    const t = fixture(), provenance: TodoProvenance = { version: 1, originRunId: 'origin-run', taskId: 1, workKey: 'origin-work',
      request: { messageId: 'original', chatId: 'alice-chat', chatType: 'p2p', senderOpenId: 'alice', msgType: 'text', createTimeMs: 1,
        link: { status: 'available', url: 'https://applink.feishu.cn/synthetic-source' } }, selectedInputs: [],
      contextSnapshot: { version: 1, acpSessionId: 'old-acp', spaceId: 'dm-alice', chatId: 'alice-chat', memoryScopes: [], chats: [], external: [], repositories: [] } }
    t.add('with provenance', undefined, { provenance })
    const result = await t.app.read(t.ref)
    expect(result.todos.items[0]!.origin?.request?.link).toEqual(provenance.request!.link)
    expect(JSON.stringify(result)).not.toContain('origin-run'); expect(JSON.stringify(result)).not.toContain('old-acp')
  })

  it('keeps truncation and denied coverage explicit, including calendar bounds', async () => {
    const t = fixture(); t.add('one'); t.add('two'); t.state.events = [t.event('one'), t.event('two')]
    t.inbox.add({ ownerOpenId: 'alice', kind: 'decision', title: 'one' }); t.inbox.add({ ownerOpenId: 'alice', kind: 'other', title: 'two' })
    const result = await t.app.read(t.ref, { limit: 1 })
    for (const section of [result.calendar, result.todos, result.decisions]) expect(section.coverage).toMatchObject({ complete: false, truncated: true })
  })

  it.each(['stop', 'actor', 'group'] as const)('rejects current %s changes without falling back to a personal response', async reason => {
    const t = fixture(); t.add('Not returned')
    t.deps.calendar = async () => {
      if (reason === 'stop') t.state.live = false
      if (reason === 'actor') t.binding.openId = 'bob'
      if (reason === 'group') t.binding.chatType = 'group'
      return { status: 'allowed', events: [], complete: true, assertCurrent: () => {} }
    }
    await expect(t.app.read(t.ref)).rejects.toThrow(); expect(t.deps.recordTodoRead).not.toHaveBeenCalled()
  })

  it('refuses an item changed while permission was checked and rechecks old sources before final response', async () => {
    const t = fixture(), todo = t.add('old')
    t.deps.authorizeTodo = async () => {
      t.todos.update(todo.id, todo.scope, { title: 'human replacement' })
      return { status: 'allowed', assertCurrent: () => {} }
    }
    await expect(t.app.read(t.ref)).rejects.toMatchObject({ code: 'changed' })
    expect(t.deps.recordTodoRead).not.toHaveBeenCalled()
    const next = fixture(); next.add('read once'); const result = await next.app.read(next.ref)
    next.state.scope = false
    expect(() => next.app.assertResultCurrent(result)).toThrow('source permission revoked')
  })

  it('does not swallow unknown provider failures or mark pending decisions read', async () => {
    const t = fixture(); t.inbox.add({ ownerOpenId: 'alice', kind: 'decision', title: 'Still pending' })
    t.deps.calendar = async () => { throw new TypeError('unexpected adapter failure') }
    await expect(t.app.read(t.ref)).rejects.toThrow('unexpected adapter failure')
    expect(t.inbox.pending('alice')[0]).toMatchObject({ resolvedAt: null, lastNudgedAt: null, nudges: 0 })
  })

  it('uses the explicit existing UTC+8 day convention and validates impossible dates and model identity injection', async () => {
    const t = fixture()
    expect(myDayRange(Date.parse('2026-09-22T16:00:00Z'))).toEqual({ date: '2026-09-23', timeZone: 'Asia/Shanghai',
      startMs: Date.parse('2026-09-22T16:00:00Z'), endMs: Date.parse('2026-09-23T16:00:00Z') })
    expect(() => myDayRange(t.now, '2026-02-30')).toThrow(); expect(() => myDayRange(t.now, '2026-2-3')).toThrow()
    await expect(t.app.read(t.ref, { openId: 'bob' } as never)).rejects.toMatchObject({ code: 'invalid' })
    await expect(t.app.read(t.ref, { limit: 0 })).rejects.toMatchObject({ code: 'invalid' })
  })
})
