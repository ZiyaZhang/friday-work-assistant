import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../src/mcp/server.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { FeishuClient } from '../src/feishu/client.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
async function close(server: Server) { server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) }
async function mcp(apiUrl: string, token = 'synthetic') {
  const server = buildServer({ apiUrl, token }), client = new Client({ name: 'cancel-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
  cleanups.push(async () => { await client.close(); await server.close() })
  return client
}

async function fixture() {
  const registry = new Registry(':memory:'), cache = new MessageCache(registry.db), fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  const space = spaceDeps(registry.db), group = space.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_owner' })
  const log = createLogger('cancel-test', 'error'), tokens = new TokenIssuer('synthetic'), calls = new RunApiCalls(registry.db)
  const captures = vi.fn(), blocked = vi.fn(), state = { current: true }
  const api = createInternalApi({ registry, messageCache: cache, memory: new ChannelMemory(registry.db), todos: new Todos(registry.db),
    messages: new MessageService(feishu, cache, log), feishu, tokens, log, maxHistoryPerCall: 100, ...space, appId: 'synthetic-app',
    onMessageRead: captures, onAccessBlocked: blocked,
    resolveActorForSession: () => state.current ? { runId: 'synthetic-run', requesterOpenId: 'ou_owner', stage: 'task' } : undefined,
    canPersistDerivedState: () => true })
  const url = await listen(api.server), token = tokens.issue({ runId: 'synthetic-run', sessionKey: 'synthetic-session', chatId: 'oc_group',
    chatType: 'group', requesterOpenId: 'ou_owner', spaceId: group.id, scopes: ['doc:write', 'chat:read', 'thread:read', 'chats:list'] })
  cleanups.push(async () => { api.beginShutdown(); expect(await api.waitForShutdown(1000)).toMatchObject({ drained: true }); await close(api.server); registry.close() })
  const post = (path: string, body: object, signal?: AbortSignal) => fetch(`${url}${path}`, { method: 'POST', signal,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const disconnected = deferred()
  api.server.on('request', (_req, res) => res.on('close', () => { if (!res.writableFinished) disconnected.resolve() }))
  return { api, registry, cache, fake, calls, captures, blocked, post, state, disconnected, client: await mcp(url, token) }
}

describe('one tool request owns cancellation without cancelling its Run', () => {
  it.each(['feishu_list_chats', 'friday_list_files'])('forwards real MCP timeout through the common registration facade: %s', async name => {
    const entered = deferred(), released = deferred(), disconnected = deferred()
    const http = createServer(async (req, res) => {
      res.once('close', () => { if (!res.writableFinished) disconnected.resolve() })
      for await (const _ of req) { /* consume normal POST body */ }
      entered.resolve(); await released.promise
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ chats: [], files: [] }))
    })
    const client = await mcp(await listen(http))
    cleanups.push(async () => { released.resolve(); await close(http) })
    const result = client.callTool({ name, arguments: {} }, undefined, { timeout: 100 }).catch(error => error)
    await entered.promise
    expect(await result).toMatchObject({ code: -32001 })
    await disconnected.promise
  })

  it('normal request-body completion does not retire the lease or stop an authorized write', async () => {
    const t = await fixture()
    expect((await t.post('/v1/doc/create', { title: 'Normal', markdown: 'Synthetic' })).status).toBe(200)
    expect(t.fake.createdDocs).toHaveLength(1); expect(t.fake.grants).toHaveLength(2)
    expect(t.calls.forRun('synthetic-run')).toMatchObject([{ state: 'returned', scopes: ['doc:write'] }])
  })

  it('HTTP disconnect retains the started effect, rejects follow-on writes, and does not revoke another request', async () => {
    const t = await fixture(), entered = deferred(), released = deferred(), original = t.fake.createDocument.bind(t.fake)
    cleanups.push(() => released.resolve())
    vi.spyOn(t.fake, 'createDocument').mockImplementation(async (...args) => { if (args[0].title === 'First') { entered.resolve(); await released.promise }; return original(...args) })
    const controller = new AbortController()
    const request = t.post('/v1/doc/create', { title: 'First', markdown: 'Synthetic' }, controller.signal).catch(error => error)
    await entered.promise; controller.abort(); await request; await t.disconnected.promise
    expect(t.calls.forRun('synthetic-run')).toMatchObject([{ state: 'started' }])
    // Another request in the same Run retains its own authority.
    expect((await t.post('/v1/doc/create', { title: 'Second', markdown: 'Synthetic' })).status).toBe(200)
    released.resolve(); t.api.beginShutdown(); expect(await t.api.waitForShutdown(1000)).toMatchObject({ drained: true })
    expect(t.fake.createdDocs).toHaveLength(2)
    expect(t.fake.grants).toHaveLength(2)
    const first = t.fake.createdDocs.find(item => item.title === 'First')!
    expect(t.fake.grants.some(grant => grant.documentId === first.documentId)).toBe(false)
    expect(t.calls.forRun('synthetic-run').map(call => call.state).sort()).toEqual(['failed', 'returned'])
    expect(t.blocked).not.toHaveBeenCalled()
  })

  it('real concurrent MCP calls keep separate signals and leave a started timed-out write unresolved', async () => {
    const t = await fixture(), entered = deferred(), released = deferred(), original = t.fake.createDocument.bind(t.fake)
    cleanups.push(() => released.resolve())
    vi.spyOn(t.fake, 'createDocument').mockImplementation(async (...args) => { if (args[0].title === 'Slow') { entered.resolve(); await released.promise }; return original(...args) })
    const first = t.client.callTool({ name: 'feishu_create_document', arguments: { title: 'Slow', markdown: 'Synthetic' } }, undefined, { timeout: 100 }).catch(error => error)
    await entered.promise
    const second = await t.client.callTool({ name: 'feishu_create_document', arguments: { title: 'Fast', markdown: 'Synthetic' } })
    expect(second.isError).not.toBe(true)
    expect(await first).toMatchObject({ code: -32001 }); await t.disconnected.promise
    released.resolve(); t.api.beginShutdown(); expect(await t.api.waitForShutdown(1000)).toMatchObject({ drained: true })
    expect(t.fake.createdDocs).toHaveLength(2); expect(t.fake.grants).toHaveLength(2)
    expect(t.calls.forRun('synthetic-run').map(call => call.state).sort()).toEqual(['failed', 'returned'])
  })

  it.each(['history', 'thread'])('stops %s at the first real provider page boundary, without capturing cancelled output or asking for OAuth', async kind => {
    const t = await fixture(), entered = deferred(), released = deferred()
    cleanups.push(() => released.resolve())
    const list = vi.fn(async () => { entered.resolve(); await released.promise; return { code: 0, data: { has_more: true, page_token: 'next', items: [] } } })
    const actual = Object.assign(Object.create(FeishuClient.prototype) as FeishuClient, { client: { im: { v1: { message: { list } } } }, nameCache: new Map() })
    t.fake.listChatHistory = actual.listChatHistory.bind(actual)
    t.fake.listThread = actual.listThread.bind(actual)
    const controller = new AbortController()
    const request = (kind === 'history'
      ? t.post('/v1/chat/history', { chat: 'oc_group', start_time: '2026-09-21T00:00:00Z', end_time: '2026-09-21T01:00:00Z' }, controller.signal)
      : t.post('/v1/thread/messages', { chat: 'oc_group', thread_id: 'omt_synthetic' }, controller.signal)).catch(error => error)
    await entered.promise; controller.abort(); await request; await t.disconnected.promise; released.resolve()
    t.api.beginShutdown(); expect(await t.api.waitForShutdown(1000)).toMatchObject({ drained: true })
    expect(list).toHaveBeenCalledTimes(1); expect(t.cache.count('oc_group')).toBe(0)
    expect(t.captures).not.toHaveBeenCalled(); expect(t.blocked).not.toHaveBeenCalled()
    expect(t.calls.forRun('synthetic-run')).toMatchObject([{ state: 'failed' }])
  })

  it('still distinguishes a live-request authority change from transport cancellation', async () => {
    const t = await fixture(), entered = deferred(), released = deferred(), original = t.fake.createDocument.bind(t.fake)
    cleanups.push(() => released.resolve())
    vi.spyOn(t.fake, 'createDocument').mockImplementation(async (...args) => { entered.resolve(); await released.promise; return original(...args) })
    const request = t.post('/v1/doc/create', { title: 'Revoked', markdown: 'Synthetic' })
    await entered.promise; t.state.current = false; released.resolve()
    const response = await request
    expect(response.status).toBe(403); expect((await response.json()).error).toContain('运行实例已变化')
    expect(t.fake.createdDocs).toHaveLength(1); expect(t.fake.grants).toHaveLength(0)
  })
})
