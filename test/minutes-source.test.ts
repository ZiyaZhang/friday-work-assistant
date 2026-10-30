import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionSourceAccess, type ExecutionSourceActor } from '../src/core/execution-source-access.js'
import { UserMessageReadAccess, UserMessageReadChanged } from '../src/core/user-message-read-lease.js'
import { Spaces } from '../src/core/space.js'
import { PolicyService } from '../src/core/policy.js'
import type { SourceContext } from '../src/core/source-context.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { FeishuMinutes, MINUTES_SCOPES, minutesSourceRef, parseMinutesSourceRef, type MinutesClient, type MinutesSource } from '../src/feishu/minutes.js'

type Api = MinutesClient['minutes']['v1']['minute']
const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const RANGE = { startMs: Date.parse('2026-09-15T00:00:00Z'), endMs: Date.parse('2026-09-22T00:00:00Z') }

async function setup(scope = Object.values(MINUTES_SCOPES).join(' ')) {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const spaces = new Spaces(db), policy = new PolicyService(spaces, { admins: [] })
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'alice' })
  let version = 0
  const userTokens = new UserTokenStore(db, { exchangeCode: async () => ({ accessToken: `PRIVATE_SYNTHETIC_${++version}`, expiresIn: 7200, scope }),
    refresh: async () => { throw new Error('unexpected refresh') } })
  const connect = () => userTokens.complete({ openId: 'alice', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  await connect()
  const feishu = {
    whoAmI: vi.fn(async () => ({ openId: 'alice', tenantKey: 'tenant_a' })),
    listChatsResult: vi.fn(async () => ({ items: [], complete: true })),
    chatMemberOpenIds: vi.fn(async () => new Set<string>()),
    readDocument: vi.fn(), listMyEvents: vi.fn(),
  }
  const sdk = {
    search: vi.fn<Api['search']>().mockResolvedValue({ code: 0, data: { items: [{ token: 'minute_a' }], has_more: false } }),
    get: vi.fn<Api['get']>().mockResolvedValue({ code: 0, data: { minute: { token: 'minute_a' } } }),
    artifacts: vi.fn<Api['artifacts']>().mockResolvedValue({ code: 0, data: { summary: 'PRIVATE_SUMMARY' } }),
  }
  const minutes = new FeishuMinutes({ minutes: { v1: { minute: sdk } } })
  const userReads = new UserMessageReadAccess({ appId: 'app_a', userTokens, feishu })
  let active = true
  const actor: ExecutionSourceActor = { runId: 'run_a', openId: 'alice', spaceId: dm.id, chatId: dm.chatId!, chatType: 'p2p', acpSessionId: 'acp_a',
    readScopes: () => [], assertCurrent: () => { if (!active) throw new Error('RUN_STOPPED') } }
  const source: SourceContext = { version: 1, acpSessionId: actor.acpSessionId, spaceId: actor.spaceId, chatId: actor.chatId,
    memoryScopes: [], chats: [], external: [], repositories: [], personalMemoryComplete: true, messageSources: [] }
  const deps = { appId: 'app_a', spaces, policy, userTokens, feishu, minutes, userReads,
    personalMemory: { checkRead: vi.fn() }, repositoryAllowed: () => false }
  const add = (receipt: MinutesSource) => source.external.push({ kind: 'minutes', ref: minutesSourceRef(receipt), personalOpenId: 'alice', access: 'user' })
  return { sdk, feishu, userTokens, connect, source, actor, add, deps,
    stop: () => { active = false }, check: () => new ExecutionSourceAccess(deps).check(actor, source) }
}

describe('Minutes source revalidation', () => {
  it('revalidates exactly the recorded minute and data tier before history/material reuse', async () => {
    const t = await setup(MINUTES_SCOPES.artifacts); t.add({ operation: 'artifacts', token: 'minute_a' })
    const result = await t.check(); expect(result.status).toBe('allowed'); result.assertCurrent()
    expect(t.sdk.artifacts).toHaveBeenCalledOnce(); expect(t.sdk.get).not.toHaveBeenCalled(); expect(t.sdk.search).not.toHaveBeenCalled()
    expect(t.feishu.readDocument).not.toHaveBeenCalled(); expect(t.feishu.listMyEvents).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
    t.userTokens.disconnect('alice'); expect(() => result.assertCurrent()).toThrow(UserMessageReadChanged)
  })

  it('revalidates metadata and AI artifacts separately when both were originally returned', async () => {
    const t = await setup(); t.add({ operation: 'get', token: 'minute_a' }); t.add({ operation: 'artifacts', token: 'minute_a' })
    const result = await t.check(); expect(result.status).toBe('allowed'); result.assertCurrent()
    expect(t.sdk.get).toHaveBeenCalledOnce(); expect(t.sdk.artifacts).toHaveBeenCalledOnce()
    await t.connect(); expect(() => result.assertCurrent()).toThrow(UserMessageReadChanged)
  })

  it('does not let message-history permissions substitute for Minutes scope', async () => {
    const t = await setup('im:message:readonly im:message.group_msg:get_as_user'); t.add({ operation: 'artifacts', token: 'minute_a' })
    expect(await t.check()).toMatchObject({ status: 'denied', reason: 'minutes_scope_missing' }); expect(t.sdk.artifacts).not.toHaveBeenCalled()
  })

  it('requires personal access and the same person, never a public or application label', async () => {
    const t = await setup(); t.add({ operation: 'get', token: 'minute_a' })
    t.source.external[0]!.access = 'public'
    expect(await t.check()).toMatchObject({ status: 'unavailable', reason: 'external_reference_unsupported' })
    t.source.external[0]!.access = 'user'; t.source.external[0]!.personalOpenId = 'bob'
    expect(await t.check()).toMatchObject({ status: 'denied', reason: 'source_identity_mismatch' })
    expect(t.sdk.get).not.toHaveBeenCalled()
  })

  it('refuses unavailable client wiring without pretending the source was verified', async () => {
    const t = await setup(); t.add({ operation: 'get', token: 'minute_a' })
    expect(await new ExecutionSourceAccess({ ...t.deps, minutes: undefined }).check(t.actor, t.source))
      .toMatchObject({ status: 'unavailable', reason: 'minutes_unavailable' })
  })

  it('replays the exact fixed search and proves every originally returned token remains visible', async () => {
    const t = await setup(MINUTES_SCOPES.search)
    t.add({ operation: 'search', range: RANGE, limit: 2, query: 'release', pageToken: 'page_2', tokens: ['minute_a'], complete: true })
    const result = await t.check(); expect(result.status).toBe('allowed'); result.assertCurrent()
    expect(t.sdk.search.mock.calls[0]![0]).toMatchObject({ data: { query: 'release', filter: { create_time: {
      start_time: new Date(RANGE.startMs).toISOString(), end_time: new Date(RANGE.endMs).toISOString() } } }, params: { page_token: 'page_2', page_size: 2 } })
    t.sdk.search.mockResolvedValue({ code: 0, data: { items: [], has_more: false } })
    expect(await t.check()).toMatchObject({ status: 'unavailable', reason: 'minutes_search_unconfirmed' })
  })

  it('does not turn incomplete revalidation of an empty search into confirmed history access', async () => {
    const t = await setup(); t.add({ operation: 'search', range: RANGE, limit: 1, tokens: [], complete: true })
    t.sdk.search.mockResolvedValue({ code: 0, data: { items: [{ token: 'minute_a' }], has_more: true, page_token: 'page_2' } })
    expect(await t.check()).toMatchObject({ status: 'unavailable', reason: 'minutes_search_unconfirmed' })
  })

  it.each(['stop', 'disconnect', 'replaceGrant'] as const)('does not reuse material if %s happens during a resource check', async change => {
    const t = await setup(); t.add({ operation: 'artifacts', token: 'minute_a' })
    t.sdk.artifacts.mockImplementation(async () => {
      if (change === 'stop') t.stop()
      else if (change === 'disconnect') t.userTokens.disconnect('alice')
      else await t.connect()
      return { code: 0, data: { summary: 'PRIVATE_SUMMARY' } }
    })
    await expect(t.check()).rejects.toThrow(change === 'stop' ? 'RUN_STOPPED' : '来源授权或空间已变化')
  })

  it.each([99991672, 2091005])('does not reuse a resource denied by Feishu (code %s)', async code => {
    const t = await setup(); t.add({ operation: 'artifacts', token: 'minute_a' })
    t.sdk.artifacts.mockResolvedValue({ code, msg: 'PRIVATE_ERROR' })
    expect(await t.check()).toMatchObject({ status: 'denied', reason: 'external_denied' })
  })

  it('keeps provider availability failure distinct from access revocation', async () => {
    const t = await setup(); t.add({ operation: 'get', token: 'minute_a' })
    t.sdk.get.mockRejectedValue(new Error('PRIVATE_TRANSPORT_DETAILS'))
    expect(await t.check()).toMatchObject({ status: 'unavailable', reason: 'external_unavailable' })
  })

  it('validates source references before any provider request', async () => {
    const t = await setup(); t.add({ operation: 'get', token: '../other' })
    expect(await t.check()).toMatchObject({ status: 'unavailable', reason: 'external_reference_unsupported' })
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
    expect(parseMinutesSourceRef('minutes:v1:not-json')).toBeUndefined()
    expect(parseMinutesSourceRef(minutesSourceRef({ operation: 'search', range: { ...RANGE, endMs: RANGE.startMs }, limit: 2, tokens: [], complete: true }))).toBeUndefined()
    expect(parseMinutesSourceRef(minutesSourceRef({ operation: 'search', range: RANGE, limit: 1, tokens: ['minute_a', 'minute_b'], complete: true }))).toBeUndefined()
  })
})
