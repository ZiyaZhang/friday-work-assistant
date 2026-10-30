/**
 * “今天我有哪些事，还有什么等我拍板？”——宿主侧的我的一天。
 *
 * 用户已定：别人在群里指派给我的待办，按原群可见——我现在仍是原群成员、该群允许我读、
 * 且待办出自该群自己的会话，才显示标题和内容；否则只计数。群内不提供跨空间个人汇总。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { AxiosError } from 'axios'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { Todos } from '../src/core/todos.js'
import { Inbox } from '../src/core/inbox.js'
import { RoutineStore } from '../src/core/routines.js'
import { IssueValidityRequests } from '../src/core/issue-validity.js'
import { MyDayError } from '../src/core/my-day.js'
import { createMyDayApplication, createMyDayMenuReader, renderMyDay, type MyDaySourceRead, type PersonalCalendarRead } from '../src/core/personal-assistant-host.js'
import { dmSpaceId, spaceScope } from '../src/core/space.js'
import { spaceDeps } from './helpers/space.js'

// 2026-09-23 10:00 in Asia/Shanghai.
const NOW = Date.parse('2026-09-23T02:00:00Z')
const registries: Registry[] = []
afterEach(() => { for (const registry of registries.splice(0)) registry.close() })

function setup(options: { calendar?: PersonalCalendarRead | Error } = {}) {
  const registry = new Registry(':memory:'); registries.push(registry)
  const attempts = new RunAttempts(registry.db), todos = new Todos(registry.db), inbox = new Inbox(registry.db)
  const routines = new RoutineStore(registry.db), issueValidity = new IssueValidityRequests(registry.db, () => NOW)
  const { spaces, policy } = spaceDeps(registry.db)
  const dm = spaces.dm('ou_alice')
  const team = spaces.ensure({ kind: 'group', chatId: 'oc_team', openId: 'ou_bob', title: '产品群' })
  const secret = spaces.ensure({ kind: 'group', chatId: 'oc_secret', openId: 'ou_bob', title: '保密群' })
  const members: Record<string, string[] | Error> = { oc_team: ['ou_alice', 'ou_bob'], oc_secret: ['ou_bob'] }
  const lookups: string[] = [], recorded: MyDaySourceRead[] = [], calendarCalls: { openId: string; startSec: number; endSec: number }[] = []
  const stopped = new Set<string>()
  registry.createSession({ sessionKey: 'dm-alice', chatId: 'oc_dm_alice', chatType: 'p2p', requesterOpenId: 'ou_alice', cwd: '/synthetic' })
  registry.createSession({ sessionKey: 'team-session', chatId: 'oc_team', chatType: 'group', requesterOpenId: 'ou_bob', cwd: '/synthetic' })
  registry.createSession({ sessionKey: 'secret-session', chatId: 'oc_secret', chatType: 'group', requesterOpenId: 'ou_bob', cwd: '/synthetic' })
  const run = attempts.begin({ workKey: 'dm-alice', sessionKey: 'dm-alice', triggerKey: 'task:1', stage: 'task', actorOpenId: 'ou_alice', now: NOW })!
  const calendar: PersonalCalendarRead | Error = options.calendar ?? { status: 'available', complete: true, assertCurrent: () => {}, events: [
    { eventId: 'e1', summary: '周会', startMs: Date.parse('2026-09-23T03:00:00Z'), endMs: Date.parse('2026-09-23T04:00:00Z'), allDay: false, appLink: 'https://applink.feishu.cn/client/calendar/event/detail?e1' },
  ] }
  const app = createMyDayApplication({ registry, attempts, spaces, policy, todos, inbox, routines, issueValidity, now: () => NOW,
    members: async chatId => { lookups.push(chatId); const value = members[chatId]; if (value instanceof Error) throw value; return new Set(value ?? []) },
    chatName: async chatId => spaces.byChat(chatId)?.title ?? undefined,
    readable: (openId, chatId) => { expect(openId).toBe('ou_alice'); return !stopped.has(chatId) },
    readCalendar: async (openId, range) => { calendarCalls.push({ openId, ...range }); if (calendar instanceof Error) throw calendar; return calendar },
    recordSource: (sessionKey, source) => { expect(sessionKey).toBe('dm-alice'); recorded.push(source) } })
  const dmScope = spaceScope(dmSpaceId('ou_alice'))
  const todo = (title: string, extra: Partial<Parameters<Todos['add']>[0]> = {}) => todos.add({ scope: dmScope, sessionKey: 'dm-alice', title, createdBy: 'ou_alice', ...extra })
  return { registry, attempts, todos, inbox, routines, issueValidity, spaces, dm, team, secret, members, lookups, recorded, calendarCalls, stopped, app, run, todo,
    ref: { sessionKey: 'dm-alice', runId: run.id } }
}

describe('my day through the host', () => {
  it('aggregates the calendar, own and assigned Todos visible in their original group, and pending decisions', async () => {
    const t = setup()
    t.todo('写周报', { dueMs: Date.parse('2026-09-23T10:00:00Z') })
    t.todo('上周遗留', { dueMs: Date.parse('2026-09-22T10:00:00Z') })
    t.todo('帮小王记：交接口文档', { owner: '小王' })
    t.todos.add({ scope: spaceScope(t.team.id), sessionKey: 'team-session', title: '评审 PRD', ownerOpenId: 'ou_alice', createdBy: 'ou_bob', source: '群内讨论',
      dueMs: Date.parse('2026-09-25T10:00:00Z') })
    t.todos.add({ scope: spaceScope(t.secret.id), sessionKey: 'secret-session', title: '保密群里指派的事', ownerOpenId: 'ou_alice', createdBy: 'ou_bob' })
    t.todos.add({ scope: spaceScope(t.team.id), sessionKey: 'team-session', title: '群里没有负责人的事', createdBy: 'ou_bob' })
    t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'decision', refId: 1, spaceId: t.team.id, title: '选方案 A 还是 B', why: '等你定', now: NOW - 3600_000 })
    t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'decision', refId: 2, spaceId: t.dm.id, title: '要不要续订', now: NOW - 7200_000 })
    t.inbox.add({ ownerOpenId: 'ou_bob', kind: 'decision', refId: 3, spaceId: t.team.id, title: '别人的决定', now: NOW })

    const result = await t.app.read(t.ref)
    expect(result).toMatchObject({ date: '2026-09-23', timeZone: 'Asia/Shanghai' })
    expect(result.calendar.events.map(event => event.summary)).toEqual(['周会'])
    expect(result.todos.items.map(item => [item.title, item.timing, item.place]).sort()).toEqual([
      ['上周遗留', 'overdue', null], ['写周报', 'today', null], ['评审 PRD', 'later', '产品群'],
    ].sort())
    expect(result.todos.coverage).toEqual({ complete: false, truncated: false, unavailable: ['resource_denied'], hidden: 1 })
    expect(JSON.stringify(result)).not.toContain('保密群里指派的事')
    expect(result.decisions.items.map(item => [item.title, item.place, item.sourceLink.status])).toEqual([
      ['要不要续订', null, 'unavailable'], ['选方案 A 还是 B', '产品群', 'available'],
    ])
    t.app.assertResultCurrent(result)
    expect(t.recorded).toEqual(expect.arrayContaining([
      { kind: 'calendar', personalOpenId: 'ou_alice', ref: expect.stringMatching(/^calendar:ou_alice:\d+:\d+$/) },
      { kind: 'todo', todoId: expect.any(Number), chatId: 'oc_team', spaceId: t.team.id },
      { kind: 'decision', inboxId: expect.any(Number), chatId: 'oc_team', spaceId: t.team.id },
    ]))
    expect(t.recorded.some(source => source.kind === 'todo' && source.chatId === 'oc_secret')).toBe(false)
    expect(t.lookups.filter(chatId => chatId === 'oc_team')).toHaveLength(1)
  })

  it('refuses a group conversation, a stopped Run and a Run bound to someone else', async () => {
    const t = setup()
    const group = t.attempts.begin({ workKey: 'team', sessionKey: 'team-session', triggerKey: 'task:2', stage: 'task', actorOpenId: 'ou_bob', now: NOW })!
    await expect(t.app.read({ sessionKey: 'team-session', runId: group.id })).rejects.toBeInstanceOf(MyDayError)
    await expect(t.app.read({ sessionKey: 'dm-alice', runId: group.id })).rejects.toBeInstanceOf(MyDayError)
    t.attempts.finish(t.run.id, 'completed', NOW)
    await expect(t.app.read(t.ref)).rejects.toBeInstanceOf(MyDayError)
    expect(t.calendarCalls).toEqual([])
  })

  it('treats membership lookup failure, an archived space, a stopped-reading group and a foreign session origin as partial gaps', async () => {
    const t = setup()
    t.members.oc_team = new AxiosError('membership unavailable', 'ERR_NETWORK')
    t.todos.add({ scope: spaceScope(t.team.id), sessionKey: 'team-session', title: '成员查不到', ownerOpenId: 'ou_alice', createdBy: 'ou_bob' })
    const foreign = t.spaces.ensure({ kind: 'group', chatId: 'oc_other', openId: 'ou_bob', title: '别处' })
    t.todos.add({ scope: spaceScope(foreign.id), sessionKey: 'team-session', title: '来源会话是别的群', ownerOpenId: 'ou_alice', createdBy: 'ou_bob' })
    t.members.oc_other = ['ou_alice']
    t.todo('我自己的事')
    const result = await t.app.read(t.ref)
    expect(result.todos.items.map(item => item.title)).toEqual(['我自己的事'])
    expect(result.todos.coverage.unavailable.sort()).toEqual(['network_unavailable', 'resource_denied'])
    t.registry.db.prepare("UPDATE space_rooms SET status = 'archived' WHERE id = ?").run(t.team.id)
    t.members.oc_team = ['ou_alice']
    const archived = await t.app.read(t.ref)
    expect(archived.todos.items.map(item => item.title)).toEqual(['我自己的事'])
    expect(archived.todos.coverage.unavailable).toContain('resource_denied')
    t.registry.db.prepare("UPDATE space_rooms SET status = 'active' WHERE id = ?").run(t.team.id)
    t.stopped.add('oc_team')
    const stopped = await t.app.read(t.ref)
    expect(stopped.todos.items.map(item => item.title)).toEqual(['我自己的事'])
    expect(stopped.todos.coverage).toMatchObject({ complete: false, hidden: 2 })
  })

  it('hides decisions whose domain object is no longer pending without reporting them as missing', async () => {
    const t = setup()
    const proposal = t.routines.add({ kind: 'schedule', source: 'model', ownerOpenId: 'ou_alice', chatId: 'oc_dm_alice', chatType: 'p2p', spaceId: t.dm.id,
      name: '每日竞品', prompt: '汇总竞品动态', schedule: { type: 'daily', at: '09:00' }, now: NOW - 86_400_000 })
    t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'responsibility', refId: proposal.id, spaceId: t.dm.id, title: '职责提案「每日竞品」', now: NOW - 3600_000 })
    expect((await t.app.read(t.ref)).decisions.items.map(item => item.title)).toEqual(['职责提案「每日竞品」'])
    t.registry.db.prepare("UPDATE routines SET status = 'active' WHERE id = ?").run(proposal.id)
    const result = await t.app.read(t.ref)
    expect(result.decisions.items).toEqual([])
    expect(result.decisions.coverage).toEqual({ complete: true, truncated: false, unavailable: [], hidden: 0 })
  })

  it('keeps readable Todos and decisions when the calendar is not connected and never writes business state', async () => {
    const t = setup({ calendar: { status: 'unavailable', reason: 'missing_connection' } })
    t.todo('写周报', { dueMs: NOW + 3600_000 })
    t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'decision', refId: 9, spaceId: t.dm.id, title: '要不要续订', now: NOW - 3600_000 })
    const before = JSON.stringify([t.registry.db.prepare('SELECT * FROM todos').all(), t.registry.db.prepare('SELECT * FROM inbox_items').all()])
    const result = await t.app.read(t.ref)
    expect(result.calendar).toEqual({ events: [], coverage: { complete: false, truncated: false, unavailable: ['missing_connection'], hidden: 0 } })
    expect(result.todos.items).toHaveLength(1); expect(result.decisions.items).toHaveLength(1)
    expect(JSON.stringify([t.registry.db.prepare('SELECT * FROM todos').all(), t.registry.db.prepare('SELECT * FROM inbox_items').all()])).toBe(before)
    expect(t.recorded.some(source => source.kind === 'calendar')).toBe(false)
  })

  it('propagates an unknown calendar failure instead of calling it an empty day', async () => {
    const t = setup({ calendar: new Error('provider exploded') })
    await expect(t.app.read(t.ref)).rejects.toThrow('provider exploded')
  })

  it('renders a person-facing summary without internal ids, with overdue items flagged and gaps explained', async () => {
    const t = setup({ calendar: { status: 'unavailable', reason: 'missing_scope' } })
    t.todo('上周遗留', { dueMs: Date.parse('2026-09-22T10:00:00Z') })
    t.todos.add({ scope: spaceScope(t.team.id), sessionKey: 'team-session', title: '评审 PRD', ownerOpenId: 'ou_alice', createdBy: 'ou_bob', source: '群内讨论' })
    t.todos.add({ scope: spaceScope(t.secret.id), sessionKey: 'secret-session', title: '保密群里指派的事', ownerOpenId: 'ou_alice', createdBy: 'ou_bob' })
    const result = await t.app.read(t.ref)
    const person = renderMyDay(result, { for: 'person' })
    expect(person).toContain('已逾期')
    expect(person).not.toContain('⚠')
    expect(person).toContain('评审 PRD')
    expect(person).toContain('产品群')
    expect(person).toContain('日历没有读取')
    expect(person).toContain('1 条')
    expect(person).not.toMatch(/ou_|oc_|sp_dm|#\d|\[todo:/)
    expect(person).not.toContain('保密群里指派的事')
    const model = renderMyDay(result, { for: 'model' })
    expect(model).toMatch(/\[todo:\d+\]/)
  })

  it('serves the “我的任务” menu from an authenticated menu event in the person’s own private chat, without a Run or source record', async () => {
    const t = setup()
    t.todo('写周报', { dueMs: NOW + 3600_000 })
    t.todos.add({ scope: spaceScope(t.team.id), sessionKey: 'team-session', title: '评审 PRD', ownerOpenId: 'ou_alice', createdBy: 'ou_bob' })
    const read = createMyDayMenuReader({ spaces: t.spaces, policy: spaceDeps(t.registry.db).policy, todos: t.todos, inbox: t.inbox, routines: t.routines, now: () => NOW,
      members: async () => new Set(['ou_alice']), readable: () => true, readCalendar: async () => ({ status: 'unavailable', reason: 'missing_connection' }) })
    const result = await read({ openId: 'ou_alice', chatId: 'oc_dm_alice', eventId: 'menu-event-1' })
    expect(result.todos.items.map(item => item.title).sort()).toEqual(['写周报', '评审 PRD'])
    expect(renderMyDay(result, { for: 'person' })).toContain('评审 PRD')
    await expect(read({ openId: 'ou_nobody', chatId: 'oc_dm_nobody', eventId: 'menu-event-2' })).rejects.toBeInstanceOf(MyDayError)
    await expect(read({ openId: '', chatId: 'oc_dm_alice', eventId: 'menu-event-3' })).rejects.toBeInstanceOf(MyDayError)
    expect(t.recorded).toEqual([])
  })
})
