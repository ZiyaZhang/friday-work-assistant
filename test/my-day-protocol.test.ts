import type { AddressInfo } from 'node:net'
import { AxiosError } from 'axios'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { SourceContexts } from '../src/core/source-context.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Todos } from '../src/core/todos.js'
import { Inbox } from '../src/core/inbox.js'
import { createMyDayCalendar } from '../src/core/my-day-calendar.js'
import { createMyDayApplication, type MyDaySourceRead } from '../src/core/personal-assistant-host.js'
import type { MyDayResult } from '../src/core/my-day.js'
import { spaceScope } from '../src/core/space.js'
import { FeishuApiError, FeishuClient } from '../src/feishu/client.js'
import { UserTokenStore, USER_SCOPE_TIERS, OAuthTokenError } from '../src/feishu/oauth.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer, type CapabilityScope } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const NOW = Date.parse('2026-09-23T02:00:00Z')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
type Reply = { isError?: boolean; content: { type: string; text?: string }[] }
const text = (reply: Reply) => reply.content.map(item => item.text ?? '').join('\n')
function decoded(reply: Reply): { result: MyDayResult; text: string } {
  expect(reply.isError, text(reply)).not.toBe(true); return JSON.parse(text(reply))
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

/** Real SDK → signed HTTP → real current Task/Run, personal grants and domain
 * stores. Only external Feishu reads are synthetic; no auth card or remote write. */
async function fixture(options: { scopes?: CapabilityScope[]; grant?: 'calendar' | 'core' | 'none'; group?: boolean; configured?: boolean } = {}) {
  const registry = new Registry(':memory:'), sp = spaceDeps(registry.db), log = createLogger('my-day-protocol', 'error')
  const errors = vi.spyOn(log, 'error'), attempts = new RunAttempts(registry.db), calls = new RunApiCalls(registry.db)
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'alice' })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_team', openId: 'bob', title: '产品群' })
  const space = options.group ? group : dm, todos = new Todos(registry.db), inbox = new Inbox(registry.db)
  registry.createSession({ sessionKey: 's1', chatId: space.chatId!, chatType: space.kind, requesterOpenId: 'alice', cwd: '/synthetic/my-day' })
  registry.createSession({ sessionKey: 'group-source', chatId: 'oc_team', chatType: 'group', requesterOpenId: 'bob', cwd: '/synthetic/group' })
  sp.spaces.touchMember(group.id, 'alice')
  const task = registry.createTaskOnce({ sessionKey: 's1', messageId: 'om-day', requesterOpenId: 'alice', prompt: '今天我有哪些事？',
    inbound: { eventId: 'event-day', messageId: 'om-day', chatId: space.chatId!, chatType: space.kind, senderOpenId: 'alice',
      senderType: 'user', msgType: 'text', text: '今天我有哪些事？', mentions: [], createTimeMs: NOW } }).task
  expect(registry.startTask(task.id, NOW, 's1')).toBe(true)
  const run = attempts.begin({ sessionKey: 's1', taskId: task.id, workKey: registry.taskWork.get(task.id)!.key,
    actorOpenId: 'alice', triggerKey: 'my-day', stage: 'task', now: NOW })!
  attempts.bindExecutionBoundary(run.id, 'managed_api_v1'); attempts.bindRuntime(run.id, 'acp-day')
  const sources = new SourceContexts(registry)
  sources.initialize({ sessionKey: 's1', acpSessionId: 'acp-day', spaceId: space.id, chatId: space.chatId! }, [])
  const own = todos.add({ scope: spaceScope(dm.id), sessionKey: 's1', title: '写周报', createdBy: 'alice', dueMs: NOW + 3600_000 })
  const assigned = todos.add({ scope: spaceScope(group.id), sessionKey: 'group-source', title: '评审群内方案', ownerOpenId: 'alice', createdBy: 'bob' })
  inbox.add({ ownerOpenId: 'alice', kind: 'decision', spaceId: dm.id, title: '决定是否续订', now: NOW - 3600_000 })
  inbox.add({ ownerOpenId: 'bob', kind: 'decision', spaceId: dm.id, title: '不属于我的决定', now: NOW })
  const hooks = { calendarBefore: undefined as (() => Promise<void> | void) | undefined, calendarError: undefined as Error | undefined,
    memberBefore: undefined as (() => Promise<void> | void) | undefined, memberError: undefined as Error | undefined,
    members: ['alice', 'bob'], readable: true, complete: true, refreshError: undefined as Error | undefined }
  let scope = [...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.calendar].join(' '), tokenVersion = 0
  const userTokens = new UserTokenStore(registry.db, {
    exchangeCode: async () => ({ accessToken: `synthetic-day-${++tokenVersion}`, expiresIn: 7200, refreshToken: 'synthetic-refresh', scope }),
    refresh: async () => { if (hooks.refreshError) throw hooks.refreshError; return { accessToken: `synthetic-day-${++tokenVersion}`, expiresIn: 7200, scope } },
  }, () => NOW)
  const connect = async (withCalendar = true) => { scope = [...USER_SCOPE_TIERS.core, ...(withCalendar ? USER_SCOPE_TIERS.calendar : [])].join(' ')
    await userTokens.complete({ openId: 'alice', code: 'synthetic', redirectUri: 'https://callback.invalid', verify: async () => ({ openId: 'alice' }) }) }
  if (options.grant !== 'none') await connect(options.grant !== 'core')
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  const calendar = vi.fn(async (as: { userToken?: string }, _range: unknown, guard: () => void) => {
    guard(); expect(as.userToken).toBe(userTokens.get('alice')?.accessToken)
    await hooks.calendarBefore?.(); if (hooks.calendarError) throw hooks.calendarError
    guard(); return { complete: hooks.complete, events: [{ eventId: 'e1', summary: '产品周会', startMs: NOW + 3600_000,
      endMs: NOW + 7200_000, allDay: false, appLink: 'https://applink.feishu.cn/client/calendar/event/detail?event_id=e1' }] }
  })
  const recorded: MyDaySourceRead[] = []
  const app = createMyDayApplication({ registry, attempts, ...sp, todos, inbox, now: () => NOW,
    members: async (_chat, guard) => { guard(); await hooks.memberBefore?.(); if (hooks.memberError) throw hooks.memberError; guard(); return new Set(hooks.members) },
    chatName: async () => '产品群', readable: () => hooks.readable,
    readCalendar: createMyDayCalendar({ userTokens, feishu: { listMyEventsPage: calendar } }),
    recordSource: (sessionKey, read) => { expect(sessionKey).toBe('s1'); recorded.push(read)
      if (read.kind === 'calendar') sources.addExternal(sessionKey, { kind: 'calendar', ref: read.ref, personalOpenId: read.personalOpenId, access: 'user' }) },
  })
  const current = { actor: 'alice', stage: 'task', runId: run.id }, tokens = new TokenIssuer('synthetic-day-capability')
  const offer = vi.fn()
  const api = createInternalApi({ registry, ...sp, log, feishu, tokens, todos, inbox, userTokens, memory: new ChannelMemory(registry.db), maxHistoryPerCall: 20,
    myDay: options.configured === false ? undefined : app,
    resolveActorForSession: key => key === 's1' && attempts.isCurrent(current.runId)
      ? { requesterOpenId: current.actor, runId: current.runId, taskId: task.id, stage: current.stage } : undefined,
    allowedRoutesForSession: () => current.stage === 'reflect' ? ['POST /v1/memory/search'] : undefined,
    onAccessBlocked: offer,
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const token = tokens.issue({ sessionKey: 's1', runId: run.id, requesterOpenId: 'alice', chatId: space.chatId!, chatType: space.kind,
    spaceId: space.id, scopes: options.scopes ?? ['todo:read', 'calendar:read'] })
  const server = buildServer({ apiUrl, token }), client = new Client({ name: 'my-day-protocol', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
  cleanups.push(async () => { await client.close(); await server.close(); api.beginShutdown(); api.server.closeAllConnections()
    expect((await api.waitForShutdown(3000)).drained).toBe(true)
    await new Promise<void>(resolve => api.server.close(() => resolve())); registry.close() })
  const call = async (args: Record<string, unknown> = {}) => await client.callTool({ name: 'friday_my_day', arguments: args }) as Reply
  const post = async (args: Record<string, unknown> = {}, auth = token) => {
    const response = await fetch(`${apiUrl}/v1/my-day`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(args) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  return { registry, sp, dm, group, task, run, attempts, calls, current, sources, recorded, own, assigned, todos, inbox,
    hooks, userTokens, connect, calendar, offer, fake, errors, call, post, client }
}

describe('My Day through real MCP and signed HTTP', () => {
  it('reads the actual person’s calendar, own/assigned visible Todos and pending decisions without changing them', async () => {
    const t = await fixture()
    const snapshot = () => JSON.stringify([t.registry.db.prepare('SELECT * FROM todos').all(), t.registry.db.prepare('SELECT * FROM inbox_items').all()])
    const before = snapshot(), value = decoded(await t.call())
    expect(value.result).toMatchObject({ date: '2026-09-23', timeZone: 'Asia/Shanghai', calendar: { events: [{ summary: '产品周会' }], coverage: { complete: true } } })
    expect(value.result.todos.items.map(item => item.title).sort()).toEqual(['写周报', '评审群内方案'].sort())
    expect(value.result.decisions.items.map(item => item.title)).toEqual(['决定是否续订'])
    expect(value.text).toContain('[todo:'); expect(snapshot()).toBe(before)
    expect(t.recorded).toEqual(expect.arrayContaining([{ kind: 'todo', todoId: t.assigned.id, chatId: 'oc_team', spaceId: t.group.id }]))
    expect(t.sources.get('s1')?.messageSources).toEqual([])
    expect(t.sources.get('s1')?.external).toMatchObject([{ kind: 'calendar', personalOpenId: 'alice', access: 'user' }])
    expect(JSON.stringify(value)).not.toContain('synthetic-day-')
    expect(t.offer).not.toHaveBeenCalled(); expect(t.fake.sent).toEqual([])
    expect(t.calls.forRun(t.run.id)).toMatchObject([{ route: 'POST /v1/my-day', state: 'returned', scopes: expect.arrayContaining(['todo:read', 'calendar:read']) }])
  })

  it.each([['none', 'missing_connection'], ['core', 'missing_scope']] as const)('keeps readable items when the calendar grant is %s, with no auth wait', async (grant, reason) => {
    const t = await fixture({ grant }), value = decoded(await t.call())
    expect(value.result.calendar).toMatchObject({ events: [], coverage: { complete: false, unavailable: [reason] } })
    expect(value.result.todos.items).toHaveLength(2); expect(value.result.decisions.items).toHaveLength(1)
    expect(value.text).toContain('日历没有读取'); expect(t.calendar).not.toHaveBeenCalled(); expect(t.offer).not.toHaveBeenCalled()
    expect(t.sources.get('s1')?.external).toEqual([]); expect(t.attempts.isCurrent(t.run.id)).toBe(true)
  })

  it.each([{ scopes: ['todo:read'] }, { scopes: ['calendar:read'] }, { scopes: [] }] satisfies { scopes: CapabilityScope[] }[])('rejects missing capability %j rather than borrowing a personal grant', async ({ scopes }) => {
    const t = await fixture({ scopes })
    expect((await t.post()).status).toBe(403); expect((await t.call()).isError).toBe(true); expect(t.calendar).not.toHaveBeenCalled()
  })

  it('rejects unsigned requests, group access and unavailable host wiring', async () => {
    const t = await fixture(); expect((await t.post({}, 'forged')).status).toBe(401)
    const group = await fixture({ group: true }); expect((await group.post()).status).toBe(403); expect(group.calendar).not.toHaveBeenCalled()
    const unwired = await fixture({ configured: false }); expect((await unwired.post()).status).toBe(503)
  })

  it.each(['stop', 'actor', 'reflect', 'proactive', 'archived', 'suspended'] as const)('rejects %s at the shared host gate', async change => {
    const t = await fixture()
    if (change === 'stop') t.attempts.requestStop(t.run.id, 'user_requested')
    if (change === 'actor') t.current.actor = 'bob'
    if (change === 'reflect' || change === 'proactive') t.current.stage = change
    if (change === 'archived') t.registry.updateSession('s1', { status: 'archived' })
    if (change === 'suspended') t.sp.spaces.suspend(t.dm.id)
    expect((await t.call()).isError).toBe(true); expect(t.calendar).not.toHaveBeenCalled(); expect(t.recorded).toEqual([])
  })

  it.each([{ open_id: 'bob' }, { sessionKey: 'other' }, { scope: 'space:other' }, { runId: 'other' }, { date: '2026-02-31' }, { limit: 0 }])(
    'rejects invalid or injected input %j', async args => {
      const t = await fixture(); expect((await t.post(args)).status).toBe(400); expect((await t.call(args)).isError).toBe(true)
      expect(t.calendar).not.toHaveBeenCalled()
    })

  it.each([
    [new FeishuApiError('calendar', 99991679, 'synthetic'), 'missing_scope'],
    [new FeishuApiError('calendar', 99991672, 'synthetic'), 'resource_denied'],
    [new FeishuApiError('calendar', 230050, 'synthetic'), 'resource_denied'],
    [new AxiosError('synthetic', 'ERR_NETWORK'), 'network_unavailable'],
  ] as const)('keeps typed calendar failure %s as a local gap', async (error, reason) => {
    const t = await fixture(); t.hooks.calendarError = error
    const value = decoded(await t.call())
    expect(value.result.calendar.coverage.unavailable).toEqual([reason]); expect(value.result.todos.items).toHaveLength(2)
    expect(t.recorded.some(read => read.kind === 'calendar')).toBe(false); expect(t.offer).not.toHaveBeenCalled()
  })

  it.each(['calendar', 'membership'] as const)('does not turn an unknown %s programming failure into an empty/partial day', async operation => {
    const t = await fixture(); if (operation === 'calendar') t.hooks.calendarError = new TypeError('synthetic programmer failure')
    else t.hooks.memberError = new TypeError('synthetic programmer failure')
    const reply = await t.post(); expect(reply.status).toBe(500); expect(reply.body).not.toHaveProperty('result')
    expect(t.errors).toHaveBeenCalled(); expect(t.offer).not.toHaveBeenCalled()
  })

  it.each(['disconnect', 'scope', 'stop', 'actor'] as const)('drops calendar bytes when %s changes during the read', async change => {
    const t = await fixture(), entered = deferred(), release = deferred()
    t.hooks.calendarBefore = async () => { entered.resolve(); await release.promise }
    const pending = t.call(); await entered.promise
    try {
      if (change === 'disconnect') t.userTokens.disconnect('alice')
      if (change === 'scope') await t.connect(false)
      if (change === 'stop') t.attempts.requestStop(t.run.id, 'user_requested')
      if (change === 'actor') { t.current.actor = 'bob'; t.registry.updateSession('s1', { requesterOpenId: 'bob' }) }
    } finally { release.resolve() }
    const reply = await pending
    expect(reply.isError).toBe(true); expect(text(reply)).not.toContain('产品周会'); expect(t.recorded).toEqual([])
  })

  it('keeps source scope and membership gaps private, and rechecks stop-reading after membership I/O', async () => {
    const t = await fixture(); t.hooks.members = ['bob']
    const result = decoded(await t.call()).result
    expect(result.todos.items.map(item => item.title)).toEqual(['写周报'])
    expect(result.todos.coverage).toMatchObject({ hidden: 1, unavailable: ['resource_denied'] })
    expect(JSON.stringify(result)).not.toContain('评审群内方案')
    t.hooks.members = ['alice', 'bob']; t.hooks.memberBefore = async () => { t.hooks.readable = false }
    const later = decoded(await t.call()).result
    expect(later.todos.items.map(item => item.title)).toEqual(['写周报'])
  })

  it('rechecks a successful calendar grant while a later domain section awaits I/O', async () => {
    const t = await fixture(), entered = deferred(), release = deferred()
    t.hooks.memberBefore = async () => { entered.resolve(); await release.promise }
    const pending = t.call(); await entered.promise
    t.userTokens.disconnect('alice'); release.resolve()
    const reply = await pending
    expect(reply.isError).toBe(true); expect(text(reply)).not.toContain('产品周会')
    // The read did occur; retain its source fact, but do not deliver stale content.
    expect(t.recorded.some(source => source.kind === 'calendar')).toBe(true)
    expect(t.calls.forRun(t.run.id)).toMatchObject([{ state: 'failed' }])
  })

  it('keeps a provider coverage gap when an event is returned, without claiming a complete day', async () => {
    const t = await fixture(); t.hooks.complete = false
    const value = decoded(await t.call({ limit: 1 }))
    expect(value.result.calendar.coverage.complete).toBe(false); expect(value.text).toContain('日历结果可能不完整')
    expect(value.result.todos.coverage.truncated).toBe(true)
  })

  it('makes recognized membership network errors partial without converting permissions to network errors', async () => {
    const t = await fixture(); t.hooks.memberError = new AxiosError('synthetic', 'ERR_NETWORK')
    expect(decoded(await t.call()).result.todos.coverage.unavailable).toEqual(['network_unavailable'])
    t.hooks.memberError = new FeishuApiError('members', 99991672, 'synthetic')
    expect(decoded(await t.call()).result.todos.coverage.unavailable).toEqual(['resource_denied'])
  })

  it('preserves request cancellation without cancelling the Run or returning late calendar content', async () => {
    const t = await fixture(), entered = deferred(), release = deferred(), abort = new AbortController()
    t.hooks.calendarBefore = async () => { entered.resolve(); await release.promise }
    const pending = t.client.callTool({ name: 'friday_my_day', arguments: {} }, undefined, { signal: abort.signal }).catch(error => error)
    await entered.promise; abort.abort(); await pending
    await new Promise(resolve => setTimeout(resolve, 20)); release.resolve()
    await expect.poll(() => t.calls.forRun(t.run.id)[0]?.state).toBe('failed')
    expect(t.recorded).toEqual([]); expect(t.attempts.isCurrent(t.run.id)).toBe(true)
    t.hooks.calendarBefore = undefined; expect(decoded(await t.call()).result.calendar.events).toHaveLength(1)
  })

  it.each(['invalid', 'network'] as const)('keeps %s token-refresh failure distinct and never starts another connection', async reason => {
    const t = await fixture(); t.userTokens.expireAccessToken('alice', t.userTokens.get('alice')!)
    t.hooks.refreshError = reason === 'invalid' ? new OAuthTokenError('invalid_grant') : new AxiosError('synthetic', 'ERR_NETWORK')
    const result = decoded(await t.call()).result
    expect(result.calendar.coverage.unavailable).toEqual([reason === 'invalid' ? 'missing_connection' : 'network_unavailable'])
    expect(t.calendar).not.toHaveBeenCalled(); expect(t.offer).not.toHaveBeenCalled(); expect(t.userTokens.get('alice')).toBeDefined()
  })

  it('keeps a provider-expired token connected and refreshes on the next read without an authorization card', async () => {
    const t = await fixture(), previous = t.userTokens.get('alice')!.accessToken
    t.hooks.calendarError = new FeishuApiError('calendar', 99991677, 'synthetic')
    expect(decoded(await t.call()).result.calendar.coverage.unavailable).toEqual(['network_unavailable'])
    expect(t.userTokens.get('alice')).toBeDefined(); expect(t.offer).not.toHaveBeenCalled()
    t.hooks.calendarError = undefined
    expect(decoded(await t.call()).result.calendar.events).toHaveLength(1)
    expect(t.userTokens.get('alice')!.accessToken).not.toBe(previous); expect(t.offer).not.toHaveBeenCalled()
  })
})

describe('calendar raw-result coverage', () => {
  function provider(count: number, cancelled: number) {
    const feishu = new FeishuClient({ appId: 'synthetic', appSecret: 'synthetic', log: createLogger('calendar-page', 'error') })
    vi.spyOn(feishu.client.calendar.v4.calendar, 'primary').mockResolvedValue({ code: 0, data: { calendars: [{ calendar: { calendar_id: 'cal' } }] } } as never)
    vi.spyOn(feishu.client.calendar.v4.calendarEvent, 'instanceView').mockResolvedValue({ code: 0, data: { items: Array.from({ length: count }, (_, i) => ({
      event_id: `e${i}`, status: i < cancelled ? 'cancelled' : 'confirmed', summary: 'event', start_time: { timestamp: '1790128800' }, end_time: { timestamp: '1790132400' },
    })) } } as never)
    return feishu
  }
  it('reports an at-limit raw result as incomplete even when most items were cancelled', async () => {
    const page = await provider(1000, 999).listMyEventsPage({ userToken: 'synthetic' }, { startSec: 1, endSec: 2 })
    expect(page.events).toHaveLength(1); expect(page.complete).toBe(false)
  })
  it('preserves the legacy array API while exposing complete results below the raw limit', async () => {
    const feishu = provider(4, 1), range = { startSec: 1, endSec: 2 }
    const page = await feishu.listMyEventsPage({ userToken: 'synthetic' }, range)
    expect(page.complete).toBe(true); expect(page.events).toHaveLength(3)
    expect(await feishu.listMyEvents({ userToken: 'synthetic' }, range)).toEqual(page.events)
  })
  it('rechecks the host lease after the provider await', async () => {
    const feishu = provider(1, 0); let active = true
    vi.spyOn(feishu.client.calendar.v4.calendarEvent, 'instanceView').mockImplementation(async () => { active = false; return { code: 0, data: { items: [] } } })
    await expect(feishu.listMyEventsPage({ userToken: 'synthetic' }, { startSec: 1, endSec: 2 }, () => { if (!active) throw new Error('stopped') })).rejects.toThrow('stopped')
  })
})
