import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { assertRequestCurrent } from '../src/core/request-lease.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { PersonalMcpConnections } from '../src/personal/mcp-connections.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'

const cleanups: (() => Promise<void>)[] = []
const releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-personal-mcp-protocol-'))
  const registry = new Registry(':memory:'), sp = spaceDeps(registry.db), log = createLogger('mcp-protocol', 'error')
  const space = sp.spaces.ensure({ kind: 'p2p', chatId: 'synthetic-dm', openId: 'alice' }), sessionKey = 'personal-protocol'
  registry.createSession({ sessionKey, chatId: space.chatId!, chatType: 'p2p', cwd: home, requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey, messageId: 'original-request', requesterOpenId: 'alice', prompt: 'Use my connected tool' }).task
  const attempts = new RunAttempts(registry.db), calls = new RunApiCalls(registry.db)
  const begin = (taskId: number) => {
    const run = attempts.begin({ taskId, sessionKey, workKey: registry.taskWork.get(taskId)!.key,
      actorOpenId: 'alice', triggerKey: `fixture:${taskId}`, stage: 'task', now: Date.now() })!
    attempts.bindExecutionBoundary(run.id, 'managed_api_v1')
    return run
  }
  const state = { task, run: begin(task.id), abort: new AbortController(), sourceSafe: true }
  const remote = {
    tools: vi.fn(async () => [{ name: 'post', description: 'Deterministic external operation', inputSchema: { type: 'object' }, readOnly: false }]),
    call: vi.fn(async () => ({ text: 'source-bound synthetic result', isError: false })),
  }
  const store = new PersonalMcpConnections({ db: registry.db, key: Buffer.alloc(32, 7), remote,
    audience: owner => { if (owner !== 'alice') throw new Error('wrong owner') } })
  const connection = (await store.prepareConnect('alice', { name: 'Synthetic MCP', url: 'https://mcp.example.test/mcp' }, () => {}))()
  const approvals: { signal?: AbortSignal; decide(allow: boolean): void }[] = []
  const confirm = vi.fn((input: { signal?: AbortSignal; requesterOnly?: boolean; fullDetail?: boolean }) => new Promise<boolean>(resolve => {
    expect(input.requesterOnly).toBe(true); expect(input.fullDetail).toBe(true); expect(input.signal).toBeDefined()
    let done = false
    const decide = (allow: boolean) => { if (done) return; done = true; input.signal?.removeEventListener('abort', cancel); resolve(allow) }
    const cancel = () => decide(false)
    input.signal?.addEventListener('abort', cancel, { once: true })
    approvals.push({ signal: input.signal, decide })
    if (input.signal?.aborted) cancel()
  }))
  const cache = new MessageCache(registry.db), feishu = asFeishuClient(new FakeFeishu()), tokens = new TokenIssuer('synthetic-mcp-protocol')
  const recordSource = vi.fn()
  const api = createInternalApi({ registry, ...sp, log, tokens, feishu, messageCache: cache,
    memory: new ChannelMemory(registry.db), messages: new MessageService(feishu, cache, log), todos: new Todos(registry.db), maxHistoryPerCall: 20,
    personalMcp: store, confirm, onExternalSourceRead: recordSource,
    resolveActorForSession: key => key === sessionKey && attempts.isCurrent(state.run.id)
      ? { requesterOpenId: 'alice', runId: state.run.id, taskId: state.task.id, stage: 'task', controlRevision: 0 } : undefined,
    personalMcpRunSignal: (key, runId) => {
      assertRequestCurrent()
      if (key !== sessionKey || runId !== state.run.id || !attempts.isCurrent(runId)) throw new Error('wrong Run')
      return state.abort.signal
    },
    captureEmailDraftSource: async (key, runId) => {
      const assertCurrent = () => {
        assertRequestCurrent()
        if (key !== sessionKey || runId !== state.run.id || !state.sourceSafe) throw new Error('source no longer allowed')
      }
      assertCurrent()
      return { assertCurrent, source: {
        origin: { runId, taskId: state.task.id, workKey: registry.taskWork.get(state.task.id)!.key, sessionKey,
          ownerOpenId: 'alice', spaceId: space.id, chatId: space.chatId!, chatType: 'p2p' as const },
        provenance: { memoryRefs: [], sources: { version: 1 as const, acpSessionId: 'synthetic-acp', spaceId: space.id,
          chatId: space.chatId!, memoryScopes: [], chats: [], external: [], repositories: [] } },
      } }
    },
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const cap = (): Omit<Capability, 'exp'> => ({ runId: state.run.id, sessionKey, chatId: space.chatId!, chatType: 'p2p',
    requesterOpenId: 'alice', spaceId: space.id, cwd: home, scopes: [...ALL_SCOPES] })
  const post = async (route: 'call' | 'wait', body: Record<string, unknown>, override: Partial<Capability> = {}, signal?: AbortSignal) => {
    const response = await fetch(`${url}/v1/personal-mcp/${route}`, { method: 'POST',
      signal,
      headers: { authorization: `Bearer ${tokens.issue({ ...cap(), ...override })}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const server = buildServer({ apiUrl: url, token: tokens.issue(cap()) }), client = new Client({ name: 'personal-mcp-protocol', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport); await client.connect(clientTransport)
  cleanups.push(async () => {
    state.abort.abort(); store.beginShutdown()
    for (const approval of approvals) approval.decide(false)
    await store.waitForShutdown(3000)
    await client.close(); await server.close(); api.beginShutdown(); api.server.closeAllConnections()
    expect((await api.waitForShutdown(3000)).drained).toBe(true)
    await new Promise<void>(resolve => api.server.close(() => resolve()))
    registry.close(); rmSync(home, { recursive: true, force: true })
  })
  const input = { connection_id: connection.id, tool: 'post', arguments: { text: 'only once', number: 1 } }
  const content = (result: Awaited<ReturnType<typeof client.callTool>>) => {
    expect(result.isError).toBeFalsy()
    const text = (result.content as { type: string; text?: string }[]).map(item => item.text ?? '').join('\n')
    return JSON.parse(text) as { id: string; state: string; result?: string }
  }
  const start = async () => content(await client.callTool({ name: 'friday_call_connected_tool', arguments: input }))
  const rows = () => registry.db.prepare('SELECT id,state,record FROM personal_mcp_calls').all()
  return { registry, attempts, calls, state, store, remote, approvals, confirm, recordSource, api, client, post, input, content, start, rows, begin }
}

describe('real MCP transport and signed API for personal tool confirmation', () => {
  it('returns one durable call and survives a real MCP wait timeout until the original approval resolves', async () => {
    const t = await fixture(), first = await t.start()
    expect(['checking', 'awaiting_confirmation']).toContain(first.state)
    await expect.poll(() => t.approvals.length).toBe(1)
    expect((await t.post('call', { ...t.input, arguments: { number: 1, text: 'only once' } })).body.id).toBe(first.id)
    expect(t.rows()).toHaveLength(1); expect(t.confirm).toHaveBeenCalledOnce()
    await expect(t.client.callTool({ name: 'friday_wait_connected_tool', arguments: { id: first.id } }, undefined, { timeout: 50 }))
      .rejects.toThrow(/timed out/i)
    await expect.poll(() => t.calls.forRun(t.state.run.id).find(call => call.route.endsWith('/wait'))?.state).toBe('failed')
    expect(t.calls.forRun(t.state.run.id).find(call => call.route.endsWith('/wait'))?.scopes).toEqual(['mcp:read'])
    expect(t.state.abort.signal.aborted).toBe(false)
    expect(t.approvals[0]!.signal!.aborted).toBe(false)
    expect(t.rows()[0]!.state).toBe('awaiting_confirmation'); expect(t.remote.call).not.toHaveBeenCalled()
    t.approvals[0]!.decide(true)
    const finished = t.content(await t.client.callTool({ name: 'friday_wait_connected_tool', arguments: { id: first.id } }))
    expect(finished).toMatchObject({ id: first.id, state: 'completed', result: 'source-bound synthetic result' })
    expect((await t.post('wait', { id: first.id, wait_ms: 0 })).body).toMatchObject(finished)
    expect(t.remote.call).toHaveBeenCalledOnce(); expect(t.confirm).toHaveBeenCalledOnce()
    expect(t.recordSource).toHaveBeenCalled()
  })

  it('cancels the pending original approval when its Run stops and ignores a late acceptance', async () => {
    const t = await fixture(), first = await t.start()
    await expect.poll(() => t.approvals.length).toBe(1)
    t.state.abort.abort()
    await expect.poll(() => t.rows()[0]!.state).toBe('cancelled')
    expect(t.approvals[0]!.signal!.aborted).toBe(true)
    t.approvals[0]!.decide(true); await t.store.settleRun(t.state.run.id)
    expect(t.remote.call).not.toHaveBeenCalled()
    expect(t.rows()[0]!.id).toBe(first.id)
  })

  it('does not count a completed result as consumed when its HTTP response is cancelled before delivery', async () => {
    const t = await fixture(), first = await t.start()
    await expect.poll(() => t.approvals.length).toBe(1)
    t.approvals[0]!.decide(true); await t.store.settleRun(t.state.run.id)
    const route = t.api.routes['POST /v1/personal-mcp/wait']!
    let formed!: () => void, release!: () => void
    const formedPromise = new Promise<void>(resolve => { formed = resolve })
    const hold = new Promise<void>(resolve => { release = resolve }); releases.push(release)
    t.api.routes['POST /v1/personal-mcp/wait'] = async (cap, body) => {
      const result = await route(cap, body); formed(); await hold; return result
    }
    const abort = new AbortController(), response = t.post('wait', { id: first.id, wait_ms: 0 }, {}, abort.signal)
    const rejected = expect(response).rejects.toThrow()
    await formedPromise
    expect(t.store.unobservedForRun(t.state.run.id)).toEqual([])
    abort.abort(); await rejected
    await expect.poll(() => t.store.unobservedForRun(t.state.run.id)).toContain(first.id)
    release()
    await expect.poll(() => t.calls.forRun(t.state.run.id).at(-1)?.state).toBe('failed')
    t.api.routes['POST /v1/personal-mcp/wait'] = route
    expect((await t.post('wait', { id: first.id, wait_ms: 0 })).body).toMatchObject({ id: first.id, state: 'completed' })
    expect(t.store.unobservedForRun(t.state.run.id)).toEqual([])
    expect(t.remote.call).toHaveBeenCalledOnce()
  })

  it('does not let another owner or a new Run in the same private chat read the original call', async () => {
    const t = await fixture(), first = await t.start()
    await expect.poll(() => t.approvals.length).toBe(1)
    expect((await t.post('wait', { id: first.id, wait_ms: 0 }, { requesterOpenId: 'mallory' })).status).toBe(403)
    expect((await t.post('wait', { id: first.id, wait_ms: 0 }, { runId: 'invented-run' })).status).toBe(403)
    const oldRun = t.state.run.id
    t.attempts.finish(oldRun, 'completed', Date.now())
    t.state.task = t.registry.createTaskOnce({ sessionKey: t.state.task.sessionKey, messageId: 'another-request', requesterOpenId: 'alice', prompt: 'Independent work' }).task
    t.state.run = t.begin(t.state.task.id)
    expect((await t.post('wait', { id: first.id, wait_ms: 0 })).status).toBe(403)
    t.approvals[0]!.decide(true); await t.store.settleRun(oldRun)
    expect(t.remote.call).not.toHaveBeenCalled()
  })

  it('rechecks source authority before dispatch and before returning a completed result', async () => {
    const t = await fixture(), first = await t.start()
    await expect.poll(() => t.approvals.length).toBe(1)
    t.state.sourceSafe = false; t.approvals[0]!.decide(true); await t.store.settleRun(t.state.run.id)
    expect(t.rows()[0]!.state).toBe('failed'); expect(t.remote.call).not.toHaveBeenCalled()
    const denied = await t.post('wait', { id: first.id, wait_ms: 0 })
    expect(denied.status).not.toBe(200); expect(JSON.stringify(denied.body)).not.toContain('source-bound synthetic result')
    const u = await fixture(), second = await u.start()
    await expect.poll(() => u.approvals.length).toBe(1)
    u.approvals[0]!.decide(true); await u.store.settleRun(u.state.run.id)
    u.state.sourceSafe = false
    const hidden = await u.post('wait', { id: second.id, wait_ms: 0 })
    expect(hidden.status).not.toBe(200); expect(JSON.stringify(hidden.body)).not.toContain('source-bound synthetic result')
  })

  it('refuses oversized waits without starting another call and aborts approval on connection revocation', async () => {
    const t = await fixture(), first = await t.start()
    await expect.poll(() => t.approvals.length).toBe(1)
    for (const wait_ms of [-1, 20_001]) expect((await t.post('wait', { id: first.id, wait_ms })).status).toBe(400)
    t.store.disconnect('alice', t.input.connection_id, 1)
    await expect.poll(() => t.rows()[0]!.state).toBe('cancelled')
    expect(t.approvals[0]!.signal!.aborted).toBe(true)
    expect((await t.post('wait', { id: first.id, wait_ms: 0 })).status).toBe(403)
    expect(t.rows()).toHaveLength(1); expect(t.remote.call).not.toHaveBeenCalled()
  })
})
