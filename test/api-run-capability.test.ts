import { afterEach, describe, expect, it, vi } from 'vitest'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { TokenIssuer, ALL_SCOPES, type Capability } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

/** Real HTTP, signed capability and SQLite; only the trusted runtime/platform are synthetic. */
async function fixture(withResolver = true, stage = 'task') {
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db)
  const memoryHost = memoryRuntimeFixture(registry, memory)
  memoryHost.pin({ runId: 'run-a', sessionKey: 'session-a', actorOpenId: 'alice', stage: stage === 'reflect' ? 'reflect' : 'task' })
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  const feishu = new FakeFeishu(), cache = new MessageCache(registry.db), tokens = new TokenIssuer('synthetic-test-key')
  const log = createLogger('run-capability-test', 'error')
  const state: { actor: ReturnType<NonNullable<InternalApiDeps['resolveActorForSession']>>; onResolve?: () => void } = {
    actor: { requesterOpenId: 'alice', runId: 'run-a', stage },
  }
  const sourceRead = vi.fn(), hostDelivery = vi.fn(async () => ({ messageId: 'synthetic-delivery' }))
  const api = createInternalApi({ registry, memory, memoryRuntime: memoryHost.runtime, ...sp, feishu: asFeishuClient(feishu), messageCache: cache,
    messages: new MessageService(asFeishuClient(feishu), cache, log), todos: new Todos(registry.db), tokens, log, maxHistoryPerCall: 50,
    resolveActorForSession: withResolver ? () => { state.onResolve?.(); return state.actor } : undefined,
    allowedRoutesForSession: () => state.actor?.stage === 'reflect' ? ['POST /v1/memory/save', 'POST /v1/memory/search', 'POST /v1/memory/forget'] : undefined,
    onExternalSourceRead: sourceRead, deliverToolResult: hostDelivery,
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())); registry.close() })
  const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const cap: Omit<Capability, 'exp'> = { sessionKey: 'session-a', runId: 'run-a', requesterOpenId: 'alice', spaceId: space.id, chatId: space.chatId, chatType: 'group', scopes: [...ALL_SCOPES] }
  const token = tokens.issue(cap)
  const post = async (path: string, body: Record<string, unknown>, signedToken = token) => {
    const response = await fetch(`${url}/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${signedToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  return { registry, memory, sp, space, feishu, tokens, state, sourceRead, hostDelivery, cap, token, post, url }
}

describe('signed Run capability at real HTTP boundaries', () => {
  it('rejects a token first received after the next run starts, even for the same requester', async () => {
    const t = await fixture()
    t.state.actor = { ...t.state.actor!, runId: 'run-b' }
    const result = await t.post('memory/save', { title: 'old request', body: 'must not persist', runId: 'run-b', requesterOpenId: 'alice' })
    expect(result.status).toBe(403)
    expect(t.memory.search(`space:${t.space.id}`, 'must not persist')).toEqual([])
    expect((await t.post('dm', { text: 'must not send', runId: 'run-b' })).status).toBe(403)
    expect(t.hostDelivery).not.toHaveBeenCalled()
  })

  it.each(['missing-run', 'different-requester', 'idle'] as const)('rejects %s instead of rebinding signed identity', async boundary => {
    const t = await fixture()
    let token = t.token
    if (boundary === 'missing-run') token = t.tokens.issue({ ...t.cap, runId: undefined })
    if (boundary === 'different-requester') t.state.actor = { ...t.state.actor!, requesterOpenId: 'bob' }
    if (boundary === 'idle') t.state.actor = undefined
    expect((await t.post('memory/save', { title: 'synthetic', body: 'unauthorized' }, token)).status).toBe(403)
    expect(t.memory.search(`space:${t.space.id}`, 'unauthorized')).toEqual([])
  })

  it('allows the same signed run and delegates its exact run ID to the host sender', async () => {
    const t = await fixture()
    expect(await t.post('memory/save', { title: 'synthetic', body: 'same run' })).toMatchObject({ status: 200, body: { note: { status: 'candidate', body: 'same run' } } })
    expect((await t.post('dm', { text: 'synthetic result', runId: 'forged' })).status).toBe(200)
    expect(t.hostDelivery).toHaveBeenCalledExactlyOnceWith('session-a', 'run-a', { kind: 'message', text: 'synthetic result' })
  })

  it.each(['run', 'stage'] as const)('rejects a %s change while the HTTP body is pending', async boundary => {
    const t = await fixture(), entered = deferred()
    t.state.onResolve = entered.resolve
    const body = JSON.stringify({ title: 'late body', body: 'must not persist' })
    let req!: ReturnType<typeof request>
    const response = new Promise<number>((resolve, reject) => {
      req = request(`${t.url}/v1/memory/save`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
      req.on('error', reject); req.flushHeaders()
    })
    await entered.promise
    t.state.onResolve = undefined
    if (boundary === 'run') t.state.actor!.runId = 'run-b'
    else t.state.actor!.stage = 'reflect'
    req.end(body)
    expect(await response).toBe(403)
    expect(t.memory.search(`space:${t.space.id}`, 'must not persist')).toEqual([])
  })

  it('does not attribute a late document read to a newer run or return its contents', async () => {
    const t = await fixture(), entered = deferred(), release = deferred()
    const read = vi.spyOn(t.feishu, 'readDocument').mockImplementation(async () => { entered.resolve(); await release.promise; return { content: 'synthetic document canary', objType: 'docx' } })
    const pending = t.post('doc', { url: 'https://test.feishu.cn/docx/synthetic' })
    await entered.promise; t.state.actor!.runId = 'run-b'; release.resolve()
    const result = await pending
    expect(result.status).toBe(403)
    expect(JSON.stringify(result.body)).not.toContain('synthetic document canary')
    expect(read).toHaveBeenCalledOnce()
    expect(t.sourceRead).not.toHaveBeenCalled()
  })

  it('keeps scope receipts idempotent without retaining permission after membership is revoked during a provider await', async () => {
    const t = await fixture(), entered = deferred(), release = deferred()
    t.registry.db.exec(`CREATE TABLE scope_updates (call_id TEXT NOT NULL);
      CREATE TRIGGER count_scope_updates AFTER UPDATE OF scopes_json ON run_api_calls
      BEGIN INSERT INTO scope_updates(call_id) VALUES (NEW.id); END;`)
    vi.spyOn(t.feishu, 'readDocument').mockImplementation(async () => {
      entered.resolve(); await release.promise
      return { content: 'revoked document canary', objType: 'docx' }
    })
    const pending = t.post('doc', { url: 'https://test.feishu.cn/docx/synthetic' })
    await entered.promise
    const call = t.registry.db.prepare("SELECT id, scopes_json FROM run_api_calls WHERE route='POST /v1/doc' AND state='started'").get()!
    expect(JSON.parse(String(call.scopes_json))).toEqual(['doc:read'])
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM scope_updates WHERE call_id=?').get(call.id as string)!.n).toBe(1)
    t.sp.spaces.removeMember(t.space.id, 'alice')
    release.resolve()
    const result = await pending
    expect(result.status).toBe(403)
    expect(JSON.stringify(result.body)).not.toContain('revoked document canary')
    expect(t.sourceRead).not.toHaveBeenCalled()
    expect(t.registry.db.prepare('SELECT state FROM run_api_calls WHERE id=?').get(call.id as string)!.state).toBe('failed')
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM scope_updates WHERE call_id=?').get(call.id as string)!.n).toBe(1)
  })

  it('does not grant document access after creation returns to a different run', async () => {
    const t = await fixture(), entered = deferred(), release = deferred()
    const create = t.feishu.createDocument.bind(t.feishu)
    vi.spyOn(t.feishu, 'createDocument').mockImplementation(async (input, as) => { const result = await create(input, as); entered.resolve(); await release.promise; return result })
    const pending = t.post('doc/create', { title: 'synthetic doc', markdown: 'synthetic body' })
    await entered.promise; t.state.actor!.runId = 'run-b'; release.resolve()
    expect((await pending).status).toBe(403)
    expect(t.feishu.createdDocs).toHaveLength(1) // the already-issued write cannot be undone
    expect(t.feishu.grants).toEqual([])
  })

  it('retains reflection restrictions for a correctly signed reflection run', async () => {
    const t = await fixture(true, 'reflect'), scope = `space:${t.space.id}`
    const confirmed = t.memory.add({ scope, kind: 'fact', title: 'confirmed', body: 'human fact', status: 'confirmed', confirmation: { by: 'alice', messageId: 'synthetic-confirmation', at: 1000 } })
    expect((await t.post('memory/save', { title: 'candidate', body: 'model observation', certainty: 'confirmed' })).body.note.status).toBe('candidate')
    expect((await t.post('memory/forget', { id: confirmed.id })).status).toBe(403)
    expect((await t.post('memory/save', { title: 'replacement', body: 'model text', replaces: confirmed.id })).status).toBe(403)
    expect((await t.post('dm', { text: 'not allowed in reflection' })).status).toBe(403)
    expect(t.memory.get(confirmed.id)).toEqual(confirmed)
    expect(t.hostDelivery).not.toHaveBeenCalled()
  })

  it('keeps unrelated legacy routes usable but requires a real Run for memory writes', async () => {
    const t = await fixture(false)
    const token = t.tokens.issue({ ...t.cap, runId: undefined })
    expect((await t.post('todo/list', {}, token)).status).toBe(200)
    expect((await t.post('memory/save', { title: 'legacy fixture', body: 'synthetic' }, token)).status).toBe(503)
    expect(t.memory.recent(`space:${t.space.id}`)).toEqual([])
  })
})

describe('Run capability signature', () => {
  const issuer = new TokenIssuer('synthetic-test-key')
  const cap: Omit<Capability, 'exp'> = { sessionKey: 's', runId: 'run-a', chatId: 'c', chatType: 'group', requesterOpenId: 'alice', scopes: ['memory:read'] }
  it('signs the run ID and rejects replacing it while retaining the old signature', () => {
    const token = issuer.issue(cap)
    expect(issuer.verify(token)).toMatchObject(cap)
    const [body, signature] = token.split('.')
    const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), runId: 'run-b' })).toString('base64url')
    expect(issuer.verify(`${changed}.${signature}`)).toBeUndefined()
  })
  it.each(['', '   ', 7])('rejects malformed signed run ID %j', value => {
    expect(issuer.verify(issuer.issue({ ...cap, runId: value as string }))).toBeUndefined()
  })
})
