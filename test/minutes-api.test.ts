import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { FeishuMinutes, MINUTES_SCOPES, parseMinutesSourceRef, type MinutesClient } from '../src/feishu/minutes.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'

type Api = MinutesClient['minutes']['v1']['minute']
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const RANGE = { start_time: '2026-09-15T00:00:00Z', end_time: '2026-09-22T00:00:00Z' }

async function setup(scope = Object.values(MINUTES_SCOPES).join(' '), overrides: Partial<InternalApiDeps> = {}) {
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db)
  const messageCache = new MessageCache(registry.db), todos = new Todos(registry.db)
  const { spaces, policy, circles } = spaceDeps(registry.db)
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'alice' })
  const group = spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'alice' })
  const feishu = asFeishuClient(new FakeFeishu()), log = createLogger('minutes-test', 'error')
  const messages = new MessageService(feishu, messageCache, log)
  let grantVersion = 0
  const userTokens = new UserTokenStore(registry.db, { exchangeCode: async () => ({ accessToken: `SYNTHETIC_PRIVATE_TOKEN_${++grantVersion}`, expiresIn: 7200, scope }),
    refresh: async () => { throw new Error('unexpected refresh') } })
  const connect = () => userTokens.complete({ openId: 'alice', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  await connect()
  const sdk = {
    search: vi.fn<Api['search']>().mockResolvedValue({ code: 0, data: { items: [{ token: 'minute_a', display_info: 'PRIVATE_PREVIEW' }], has_more: false } }),
    get: vi.fn<Api['get']>().mockResolvedValue({ code: 0, data: { minute: { token: 'minute_a', title: 'PRIVATE_TITLE' } } }),
    artifacts: vi.fn<Api['artifacts']>().mockResolvedValue({ code: 0, data: { summary: 'PRIVATE_SUMMARY',
      minute_todos: [{ content: 'Bob follows up', assignees: ['ou_bob'], is_done: true, todo_id: 'todo_b' }] } }),
  }
  const minutes = new FeishuMinutes({ minutes: { v1: { minute: sdk } } })
  const tokens = new TokenIssuer('synthetic-test-secret')
  let current: { requesterOpenId: string; runId: string; stage: string; controlRevision: number } | undefined =
    { requesterOpenId: 'alice', runId: 'run_a', stage: 'task', controlRevision: 0 }
  const onSource = vi.fn<NonNullable<InternalApiDeps['onExternalSourceRead']>>()
  const offerConnect = vi.fn(async () => '已发送授权卡')
  const api = createInternalApi({ feishu, memory, registry, messages, messageCache, todos, spaces, policy, circles, tokens, log,
    maxHistoryPerCall: 10, userTokens, minutes, resolveActorForSession: () => current, onExternalSourceRead: onSource,
    abilities: { offerConnect } as InternalApiDeps['abilities'], ...overrides })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { await new Promise<void>((resolve, reject) => api.server.close(error => error ? reject(error) : resolve())); registry.close() })
  const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const cap = { sessionKey: 'session_a', runId: 'run_a', chatId: dm.chatId!, chatType: 'p2p' as const,
    spaceId: dm.id, requesterOpenId: 'alice', scopes: ['chat:read'] }
  const post = async (path: string, body: Record<string, unknown> = {}, patch: Partial<Omit<Capability, 'exp'>> = {}) => {
    const response = await fetch(`${url}/v1/minutes/${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${tokens.issue({ ...cap, ...patch })}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  return { sdk, minutes, post, onSource, offerConnect, registry, spaces, dm, group, userTokens, connect,
    stop: () => { current = undefined }, changeRun: () => { current!.runId = 'run_b' },
    changeControl: () => { current!.controlRevision += 1 } }
}

describe('Minutes gateway authorization and source receipts', () => {
  it('searches only with the search tier and records a restricted personal receipt with a fixed range', async () => {
    const t = await setup(MINUTES_SCOPES.search)
    const r = await t.post('recent', { ...RANGE, query: 'release', limit: 2 })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ minutes: [{ token: 'minute_a', displayInfo: 'PRIVATE_PREVIEW' }], coverage: { complete: true },
      start_time: new Date(RANGE.start_time).toISOString(), end_time: new Date(RANGE.end_time).toISOString(), query: 'release' })
    expect(t.sdk.get).not.toHaveBeenCalled(); expect(t.sdk.artifacts).not.toHaveBeenCalled()
    const source = t.onSource.mock.calls[0]![1]
    expect(source).toMatchObject({ kind: 'minutes', personalOpenId: 'alice', access: 'user' })
    expect(parseMinutesSourceRef(source.ref)).toEqual({ operation: 'search', range: { startMs: Date.parse(RANGE.start_time), endMs: Date.parse(RANGE.end_time) },
      query: 'release', limit: 2, tokens: ['minute_a'], complete: true })
    expect(JSON.stringify(r.body)).not.toContain('SYNTHETIC_PRIVATE_TOKEN')
  })

  it('keeps a proven empty search personal instead of dropping its source', async () => {
    const t = await setup(); t.sdk.search.mockResolvedValue({ code: 0, data: { items: [], has_more: false } })
    expect((await t.post('recent')).body).toMatchObject({ minutes: [], coverage: { complete: true } })
    expect(parseMinutesSourceRef(t.onSource.mock.calls[0]![1].ref)).toMatchObject({ tokens: [], complete: true })
  })

  it('reads one complete selected minute and preserves todo owners/status without creating any todos', async () => {
    const t = await setup()
    const r = await t.post('read', { minute_token: 'minute_a' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ minute: { title: 'PRIVATE_TITLE' }, artifacts: { summary: 'PRIVATE_SUMMARY',
      todos: [{ assignees: ['ou_bob'], isDone: true, todoId: 'todo_b' }] } })
    expect(t.onSource.mock.calls.map(call => parseMinutesSourceRef(call[1].ref))).toEqual([
      { operation: 'get', token: 'minute_a' }, { operation: 'artifacts', token: 'minute_a' }])
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM todos').get()).toEqual({ n: 0 })
  })

  it('requires only artifacts scope for selected todo reading and does not return unrelated summary', async () => {
    const t = await setup(MINUTES_SCOPES.artifacts)
    const r = await t.post('todos', { minute_token: 'minute_a' })
    expect(r.status).toBe(200); expect(r.body.todos).toHaveLength(1)
    expect(r.body.summary).toBeUndefined(); expect(t.sdk.get).not.toHaveBeenCalled(); expect(t.sdk.search).not.toHaveBeenCalled()
  })

  it.each(['recent', 'read', 'todos'])('forbids group use even when the requester has a personal grant: %s', async path => {
    const t = await setup()
    const r = await t.post(path, { minute_token: 'minute_a' }, { chatId: t.group.chatId!, chatType: 'group', spaceId: t.group.id })
    expect(r.status).toBe(403); expect(t.sdk.search).not.toHaveBeenCalled(); expect(t.sdk.get).not.toHaveBeenCalled(); expect(t.sdk.artifacts).not.toHaveBeenCalled()
  })

  it('checks chat capability and refuses an incorrectly bound private space', async () => {
    const t = await setup()
    expect((await t.post('recent', {}, { scopes: [] })).status).toBe(403)
    const bob = t.spaces.ensure({ kind: 'p2p', chatId: 'oc_bob', openId: 'bob' })
    expect((await t.post('recent', {}, { spaceId: bob.id, chatId: bob.chatId! })).status).toBe(403)
    expect(t.sdk.search).not.toHaveBeenCalled()
  })

  it.each(['resolveActorForSession', 'onExternalSourceRead'] as const)('fails closed when the host cannot verify %s', async key => {
    const t = await setup(undefined, { [key]: undefined })
    expect((await t.post('recent')).status).toBe(503); expect(t.sdk.search).not.toHaveBeenCalled()
  })

  it('uses the real offer-connect exit for a disconnected user, without invoking the Minutes SDK', async () => {
    const t = await setup(); t.userTokens.disconnect('alice')
    const r = await t.post('recent')
    expect(r.status).toBe(403); expect(r.body.error).toContain('已经发到')
    expect(t.offerConnect).toHaveBeenCalledOnce(); expect(t.sdk.search).not.toHaveBeenCalled()
  })

  it('keeps a temporary token failure distinct from disconnection', async () => {
    const t = await setup(); vi.spyOn(t.userTokens, 'accessTokenResult').mockResolvedValue({ status: 'unavailable', reason: 'refresh_failed' })
    const r = await t.post('recent')
    expect(r.status).toBe(503); expect(t.offerConnect).not.toHaveBeenCalled(); expect(t.sdk.search).not.toHaveBeenCalled()
  })

  it('names the exact missing scope rather than claiming there are no minutes', async () => {
    const t = await setup(MINUTES_SCOPES.search)
    const r = await t.post('read', { minute_token: 'minute_a' })
    expect(r.status).toBe(403); expect(r.body.error).toContain(MINUTES_SCOPES.get); expect(r.body.error).toContain(MINUTES_SCOPES.artifacts)
    expect(t.sdk.get).not.toHaveBeenCalled(); expect(t.offerConnect).toHaveBeenCalledWith(expect.objectContaining({ requesterOpenId: 'alice' }), ['minutes'],
      expect.objectContaining({ reason: 'personal_scope_missing', scopes: [MINUTES_SCOPES.get, MINUTES_SCOPES.artifacts] }))
  })

  it.each(['stop', 'changeRun', 'changeControl', 'disconnect', 'replaceGrant'] as const)('rejects late SDK results after %s', async change => {
    const t = await setup()
    t.sdk.search.mockImplementationOnce(async () => {
      await Promise.resolve()
      if (change === 'disconnect') t.userTokens.disconnect('alice')
      else if (change === 'replaceGrant') await t.connect()
      else t[change]()
      return { code: 0, data: { items: [{ token: 'minute_a', display_info: 'PRIVATE_PREVIEW' }], has_more: true, page_token: 'page_2' } }
    })
    const r = await t.post('recent')
    expect(r.status).toBe(403); expect(JSON.stringify(r.body)).not.toContain('PRIVATE_PREVIEW')
    expect(t.sdk.search).toHaveBeenCalledOnce(); expect(t.onSource).not.toHaveBeenCalled()
  })

  it('rechecks the Run after token lookup before any SDK request', async () => {
    const t = await setup(), original = t.userTokens.accessTokenResult.bind(t.userTokens)
    vi.spyOn(t.userTokens, 'accessTokenResult').mockImplementation(async id => { const r = await original(id); t.stop(); return r })
    expect((await t.post('recent')).status).toBe(403); expect(t.sdk.search).not.toHaveBeenCalled()
  })

  it('rechecks authorization between metadata and AI artifacts', async () => {
    const t = await setup()
    t.sdk.get.mockImplementationOnce(async () => { t.userTokens.disconnect('alice'); return { code: 0, data: { minute: { token: 'minute_a', title: 'PRIVATE_TITLE' } } } })
    const r = await t.post('read', { minute_token: 'minute_a' })
    expect(r.status).toBe(403); expect(JSON.stringify(r.body)).not.toContain('PRIVATE_TITLE'); expect(t.sdk.artifacts).not.toHaveBeenCalled()
  })

  it('rejects late artifacts after revocation and never writes a source or todo', async () => {
    const t = await setup()
    t.sdk.artifacts.mockImplementationOnce(async () => { t.userTokens.disconnect('alice'); return { code: 0, data: { summary: 'PRIVATE_SUMMARY' } } })
    const r = await t.post('todos', { minute_token: 'minute_a' })
    expect(r.status).toBe(403); expect(JSON.stringify(r.body)).not.toContain('PRIVATE_SUMMARY'); expect(t.onSource).not.toHaveBeenCalled()
  })

  it('holds the personal read lease across the final HTTP dispatcher await', async () => {
    const t = await setup()
    t.onSource.mockImplementation(() => { queueMicrotask(() => t.userTokens.disconnect('alice')) })
    const r = await t.post('recent')
    expect(r.status).toBe(403); expect(JSON.stringify(r.body)).not.toContain('PRIVATE_PREVIEW')
  })

  it('never converts an SDK error into a successful empty todo list or leaks transport details', async () => {
    const t = await setup()
    t.sdk.artifacts.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_URL_AND_TOKEN'))
    const r = await t.post('todos', { minute_token: 'minute_a' })
    expect(r.status).toBe(502); expect(r.body.todos).toBeUndefined(); expect(JSON.stringify(r.body)).not.toContain('PRIVATE_PROVIDER_URL_AND_TOKEN')
    expect(t.onSource).not.toHaveBeenCalled()
  })

  it('surfaces provider scope denial as an actionable permission error', async () => {
    const t = await setup(); t.sdk.search.mockResolvedValueOnce({ code: 99991672, msg: 'PRIVATE_PROVIDER_MESSAGE' })
    const r = await t.post('recent')
    expect(r.status).toBe(403); expect(r.body.error).toContain(MINUTES_SCOPES.search); expect(r.body.error).not.toContain('PRIVATE_PROVIDER_MESSAGE')
  })

  it.each([{ page_token: 'page_2' }, { start_time: RANGE.start_time }, { ...RANGE, limit: 0 }, { ...RANGE, query: 123 },
    { start_time: '2026-09-01T00:00:00', end_time: '2026-09-02T00:00:00' }])('rejects ambiguous windows or invalid query bounds: %j', async body => {
    const t = await setup(); expect((await t.post('recent', body)).status).toBe(400); expect(t.sdk.search).not.toHaveBeenCalled()
  })
})

describe('Minutes action-item proposal route', () => {
  const WRITE = { scopes: ['chat:read', 'todo:write'] }
  const host = () => ({ propose: vi.fn<NonNullable<InternalApiDeps['minutesTodos']>['propose']>(async () =>
    ({ draftId: 'draft_a', state: 'pending' as const, items: 1, reviewDelivered: true, todoIds: [], expiresAt: '2026-09-28T00:00:00.000Z', notice: 'synthetic' })) })

  it('reads the selected minute with the personal grant, records the same receipts as a read, and hands only host-read content to the host', async () => {
    const minutesTodos = host(), t = await setup(undefined, { minutesTodos })
    const r = await t.post('todos/propose', { minute_token: 'minute_a', items: [0] }, WRITE)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ draftId: 'draft_a', state: 'pending' })
    expect(t.onSource.mock.calls.map(call => parseMinutesSourceRef(call[1].ref))).toEqual([{ operation: 'get', token: 'minute_a' }, { operation: 'artifacts', token: 'minute_a' }])
    const [ref, input] = minutesTodos.propose.mock.calls[0]!
    expect(ref).toEqual({ sessionKey: 'session_a', runId: 'run_a' })
    expect(input).toMatchObject({ items: [0], minute: { token: 'minute_a', title: 'PRIVATE_TITLE' },
      artifacts: { token: 'minute_a', todos: [{ content: 'Bob follows up', assignees: ['ou_bob'], isDone: true }] } })
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM todos').get()).toEqual({ n: 0 })
    expect(JSON.stringify(r.body)).not.toContain('SYNTHETIC_PRIVATE_TOKEN')
  })

  it('refuses without todo:write, in a group, with an invalid selection, or without the host confirmation path, before any Minutes read', async () => {
    const minutesTodos = host(), t = await setup(undefined, { minutesTodos })
    expect((await t.post('todos/propose', { minute_token: 'minute_a', items: [0] })).status).toBe(403)
    const group = await t.post('todos/propose', { minute_token: 'minute_a', items: [0] }, { ...WRITE, chatId: t.group.chatId!, chatType: 'group', spaceId: t.group.id })
    expect(group.status).toBe(403); expect(group.body.error).toContain('私聊')
    for (const items of [[], [-1], [0, 0], [1.5], 'all', Array.from({ length: 51 }, (_, i) => i)]) {
      expect((await t.post('todos/propose', { minute_token: 'minute_a', items }, WRITE)).status, JSON.stringify(items)).toBe(400)
    }
    const missing = await setup()
    expect((await missing.post('todos/propose', { minute_token: 'minute_a', items: [0] }, WRITE)).status).toBe(503)
    for (const sdk of [t.sdk, missing.sdk]) { expect(sdk.get).not.toHaveBeenCalled(); expect(sdk.artifacts).not.toHaveBeenCalled() }
    expect(minutesTodos.propose).not.toHaveBeenCalled(); expect(t.onSource).not.toHaveBeenCalled()
  })
})
