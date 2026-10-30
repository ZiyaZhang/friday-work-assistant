import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

async function fixture(options: Partial<Pick<InternalApiDeps, 'consoleRouter'>> = {}) {
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db)
  const space = spaceDeps(registry.db), group = space.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_owner' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), tokens = new TokenIssuer('synthetic-shutdown')
  const log = createLogger('shutdown-test', 'error'), calls = new RunApiCalls(registry.db)
  const userTokens = new UserTokenStore(registry.db, fake)
  const current = { available: true }
  const api = createInternalApi({ registry, memory, messageCache: cache, messages: new MessageService(feishu, cache, log),
    todos: new Todos(registry.db), feishu, tokens, log, maxHistoryPerCall: 20, ...space, userTokens,
    oauthRedirectUri: 'https://synthetic.invalid/oauth/callback',
    resolveActorForSession: () => current.available ? { runId: 'run-synthetic', requesterOpenId: 'ou_owner', stage: 'task' } : undefined,
    canPersistDerivedState: () => current.available, ...options })
  for (const server of [api.server, api.callbackServer]) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const urls = [api.server, api.callbackServer].map(server => `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  const token = tokens.issue({ runId: 'run-synthetic', sessionKey: 'session-synthetic', chatId: 'oc_group', chatType: 'group',
    spaceId: group.id, requesterOpenId: 'ou_owner', scopes: ['doc:write'] })
  const post = () => fetch(`${urls[0]}/v1/doc/create`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Synthetic shutdown', markdown: 'Synthetic content' }) })
  cleanup.push(async () => {
    api.beginShutdown()
    for (const server of [api.server, api.callbackServer]) server.closeAllConnections()
    const result = await api.waitForShutdown(1000)
    if (!result.drained) throw new Error('Test left an unresolved HTTP handler; database must stay open')
    for (const server of [api.server, api.callbackServer]) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    registry.close()
  })
  return { registry, fake, api, urls, userTokens, current, calls, post }
}

describe('API request ownership during gateway shutdown', () => {
  it('idempotently rejects new internal and OAuth traffic without starting provider or domain work', async () => {
    const t = await fixture(), state = t.userTokens.begin('ou_owner')
    t.api.beginShutdown(); t.api.beginShutdown()
    expect((await t.post()).status).toBe(503)
    for (const url of t.urls) expect((await fetch(`${url}/oauth/callback?state=${state}&code=synthetic`)).status).toBe(503)
    expect(t.userTokens.ownerOfState(state)).toBe('ou_owner')
    expect(t.fake.exchanges).toHaveLength(0)
    expect(t.fake.createdDocs).toHaveLength(0)
    expect(t.calls.forRun('run-synthetic')).toEqual([])
    expect(await t.api.waitForShutdown(0)).toEqual({ drained: true, pending: 0 })
  })

  it('does not mistake a closed socket for a finished in-flight write or erase its started evidence', async () => {
    const t = await fixture(), entered = deferred(), release = deferred(), original = t.fake.createDocument.bind(t.fake)
    cleanup.push(() => release.resolve())
    vi.spyOn(t.fake, 'createDocument').mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args) })
    const request = t.post().catch(() => undefined)
    await entered.promise
    t.current.available = false // Orchestrator's synchronous host shutdown revokes execution authority.
    t.api.beginShutdown(); t.api.server.closeAllConnections()
    await new Promise<void>(resolve => t.api.server.close(() => resolve()))
    expect(await t.api.waitForShutdown(5)).toEqual({ drained: false, pending: 1 })
    expect(t.calls.forRun('run-synthetic')).toMatchObject([{ route: 'POST /v1/doc/create', scopes: ['doc:write'], state: 'started' }])
    // The owner deliberately keeps SQLite alive on timeout. A real remote ACK may
    // arrive late; record it as failed/unresolved rather than pretending no write happened.
    release.resolve()
    expect(await t.api.waitForShutdown(1000)).toEqual({ drained: true, pending: 0 })
    await request
    expect(t.fake.createdDocs).toHaveLength(1)
    expect(t.fake.grants).toHaveLength(0)
    expect(t.calls.forRun('run-synthetic')).toMatchObject([{ state: 'failed', scopes: ['doc:write'] }])
  })

  it('waits for the actual final ledger update, with concurrent waiters and a bounded zero-time snapshot', async () => {
    const t = await fixture(), entered = deferred(), release = deferred(), original = t.fake.createDocument.bind(t.fake)
    cleanup.push(() => release.resolve())
    vi.spyOn(t.fake, 'createDocument').mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args) })
    const request = t.post()
    await entered.promise; t.api.beginShutdown()
    const first = t.api.waitForShutdown(1000), second = t.api.waitForShutdown(1000)
    expect(await t.api.waitForShutdown(0)).toEqual({ drained: false, pending: 1 })
    release.resolve()
    expect(await first).toEqual({ drained: true, pending: 0 })
    expect(await second).toEqual({ drained: true, pending: 0 })
    expect((await request).status).toBe(200)
    expect(t.calls.forRun('run-synthetic')).toMatchObject([{ state: 'returned' }])
  })

  it.each([0, 1])('tracks an already admitted OAuth exchange on server %s after its socket closes', async serverIndex => {
    const t = await fixture(), entered = deferred(), release = deferred(), original = t.fake.exchangeCode.bind(t.fake)
    cleanup.push(() => release.resolve())
    t.fake.identities.set(t.fake.nextToken.accessToken, { openId: 'ou_owner', tenantKey: 'tenant', name: 'Synthetic owner' })
    vi.spyOn(t.fake, 'exchangeCode').mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args) })
    const state = t.userTokens.begin('ou_owner')
    const request = fetch(`${t.urls[serverIndex]}/oauth/callback?state=${state}&code=synthetic`).catch(() => undefined)
    await entered.promise; t.api.beginShutdown()
    const server = serverIndex === 0 ? t.api.server : t.api.callbackServer
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    expect(await t.api.waitForShutdown(5)).toEqual({ drained: false, pending: 1 })
    expect(t.userTokens.isConnected('ou_owner')).toBe(false)
    release.resolve()
    expect(await t.api.waitForShutdown(1000)).toEqual({ drained: true, pending: 0 })
    await request
    expect(t.userTokens.isConnected('ou_owner')).toBe(true)
    expect(t.fake.exchanges).toHaveLength(1)
  })

  it('releases a rejected handler without a detached unhandled rejection', async () => {
    const t = await fixture({ consoleRouter: async () => { throw new TypeError('synthetic router failure') } })
    expect((await fetch(`${t.urls[0]}/synthetic-console`)).status).toBe(500)
    t.api.beginShutdown()
    expect(await t.api.waitForShutdown(1000)).toEqual({ drained: true, pending: 0 })
  })

  it('requires explicit shutdown and a finite wait budget', async () => {
    const t = await fixture()
    await expect(t.api.waitForShutdown(1)).rejects.toThrow('has not started')
    t.api.beginShutdown()
    for (const value of [-1, Infinity, NaN]) await expect(t.api.waitForShutdown(value)).rejects.toThrow('finite and non-negative')
  })
})
