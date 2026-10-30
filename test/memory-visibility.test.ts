import { AxiosError } from 'axios'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../src/mcp/server.js'
import { ManagedMemoryStorage } from '../src/core/managed-memory-storage.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory, type MemoryNote } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RuntimeContexts } from '../src/core/runtime-contexts.js'
import { SourceContexts } from '../src/core/source-context.js'
import { Todos } from '../src/core/todos.js'
import { OAuthTokenError, UserTokenStore } from '../src/feishu/oauth.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

/** Real Orchestrator/ACP SDK, signed HTTP, SQLite, user token store, source receipts and memory runtime.
 * Only the model and platform are synthetic; no private host method is replaced. */
async function fixture(mode: 'managed' | 'workspace' = 'managed') {
  const home = mkdtempSync(join(tmpdir(), 'friday-personal-memory-host-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'app-synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000',
    ...(mode === 'managed' ? { FRIDAY_DEFAULT_EXECUTION: 'managed' } : {}) })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), attempts = new RunAttempts(registry.db)
  const contexts = new RuntimeContexts(registry.db), sourceContexts = new SourceContexts(registry)
  const sp = spaceDeps(registry.db), dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_owner' })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_other' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), cache = new MessageCache(registry.db)
  let tokenNow = Date.now()
  const provider = {
    exchangeCode: async () => ({ accessToken: 'SYNTHETIC_USER_TOKEN', expiresIn: 600, refreshToken: 'SYNTHETIC_REFRESH', refreshTokenExpiresIn: 86400,
      scope: 'im:chat:readonly im:message:readonly im:message.group_msg:get_as_user' }),
    refresh: vi.fn(async () => { throw new OAuthTokenError('invalid_grant') }),
  }
  const userTokens = new UserTokenStore(registry.db, provider, () => tokenNow)
  await userTokens.complete({ openId: 'ou_owner', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  const listChatsResult = vi.fn(async () => ({ items: [{ chatId: 'oc_group', name: '合成群' }], complete: true }))
  feishu.listChatsResult = listChatsResult
  feishu.whoAmI = vi.fn(async () => ({ openId: 'ou_owner', tenantKey: 'tenant-authority' }))
  fake.userChats.set('SYNTHETIC_USER_TOKEN', [{ chatId: 'oc_group', name: '合成群' }])
  const log = createLogger('personal-memory-host', 'error')
  const execution = managedHostRuntime(registry, home, log), { runtime, managed, bindings, workspacePeer } = execution
  const peer = mode === 'managed' ? execution.peer : workspacePeer
  const messages = new MessageService(feishu, cache, log), todos = new Todos(registry.db), tokens = new TokenIssuer('synthetic-signing')
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, feishu, userTokens, runtime, managed, messages, tokens,
    ingressClassifier: { classify: async input => input.message.replyToRef
      ? { kind: 'amend', targetRef: input.message.replyToRef } : { kind: 'new_work' } },
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  closes.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const api = createInternalApi({ registry, ...sp, memory, messageCache: cache, messages, todos, feishu, userTokens,
    appId: cfg.feishu.appId, tokens, log, maxHistoryPerCall: 20,
    isManagedRun: runId => host.isManagedRun(runId),
    registerExecutionFile: (runId, file, guard) => host.registerExecutionFile(runId, file, guard),
    disconnectPersonalConnection: (openId, expected) => host.disconnectPersonalConnection(openId, expected),
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPersistDerivedState: key => host.canPersistDerivedState(key), canPersistPersonalMemory: key => host.canPersistPersonalMemory(key),
    onCrossSpaceRead: (key, read) => host.noteCrossSpaceRead(key, read),
    onMessageRead: (key, runId, receipt) => host.noteMessageRead(key, runId, receipt),
    abilities: host.abilities,
    memoryRuntime: { recordRead: (runId, refs) => host.recordMemoryRead(runId, refs),
      search: (runId, scopes, query, limit) => host.searchMemory(runId, scopes, query, limit),
      add: (runId, input) => host.addMemory(runId, input), forget: (runId, id, scope) => host.forgetMemory(runId, id, scope) },
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  closes.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())) })
  const post = async (path: string, body: unknown) => {
    const servers = peer.state.allPrompts.at(-1)!.mcpServers as { env: { name: string; value: string }[] }[]
    const token = servers[0]!.env.find(entry => entry.name === 'FRIDAY_CAP_TOKEN')!.value
    const response = await fetch(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as { note?: MemoryNote; notes?: MemoryNote[]; items?: unknown[]; error?: string; availability?: { inactive_notes: number; temporarily_unavailable_notes: number } } }
  }
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const servers = peer.state.allPrompts.at(-1)!.mcpServers as { env: { name: string; value: string }[] }[]
    const token = servers[0]!.env.find(entry => entry.name === 'FRIDAY_CAP_TOKEN')!.value
    const server = buildServer({ apiUrl: `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`, token })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'memory-visibility-test', version: '0.0.0' })
    await server.connect(serverTransport); await client.connect(clientTransport)
    try {
      const result = await client.callTool({ name, arguments: args })
      return { isError: result.isError, text: (result.content as { type: string; text?: string }[]).map(item => item.text ?? '').join('\n') }
    } finally { await client.close(); await server.close() }
  }
  let serial = 0
  const message = (text: string, parentId?: string): InboundMessage => {
    const messageId = `personal-memory-${++serial}`
    return { eventId: messageId, messageId, chatId: 'oc_dm', chatType: 'p2p', senderOpenId: 'ou_owner',
      senderType: 'user', tenantId: 'tenant-authority', msgType: 'text', text, mentions: [], createTimeMs: Date.now(),
      ...(parentId ? { parentId } : {}) }
  }
  return { registry, memory, attempts, contexts, sourceContexts, cache, ...sp, dm, group, fake, peer, runtime,
    host, bindings, managed, workspacePeer, userTokens, listChatsResult, post, callTool, message, provider, feishu, advanceTokenClock: () => { tokenNow += 400_000 } }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
const canary = 'REVOKED_MEMORY_VISIBILITY_CANARY'
function managed(t: Fixture, scope = `space:${t.dm.id}`, chatId = 'oc_group') {
  return t.memory.add({ scope, kind: 'fact', title: `title ${canary}`, body: `body ${canary}`,
    provenance: { state: 'verified', originRunId: 'synthetic-original-run', sources: [{ ref: `message:${chatId}`,
      appId: 'app-synthetic', tenantId: 'tenant-authority', chatId, spaceId: null, messageId: 'om_source',
      readIdentity: { kind: 'user', openId: 'ou_owner' }, coverage: 'complete', readAt: 1 }] } })
}

describe('memory visibility through real host, HTTP and MCP', () => {
  it('preserves a safe unavailable count after revocation and later Runs without returning the old body', async () => {
    const t = await fixture(), note = managed(t), other = managed(t, 'space:sp_dm_ou_other')
    t.memory.invalidateSources({ kind: 'notes', refs: [other] })
    const first = t.message(canary)
    t.peer.state.script = [{ kind: 'text', text: '已核对当前资料。' }]
    await t.host.handleMessage(first)
    expect(t.peer.state.allPrompts[0]!.text).toContain(canary)
    const originalAcp = t.peer.state.allPrompts[0]!.sessionId
    t.listChatsResult.mockResolvedValue({ items: [], complete: true })
    t.fake.userChats.set('SYNTHETIC_USER_TOKEN', [])
    const observations: { http: Awaited<ReturnType<Fixture['post']>>; mcp: Awaited<ReturnType<Fixture['callTool']>>; explain: Awaited<ReturnType<Fixture['callTool']>> }[] = []
    let previous = first
    for (const body of ['继续这件事，哪些记忆这轮可用？', '接着看刚才的可用记忆。']) {
      const next = t.message(body, previous.messageId)
      t.peer.state.script = [{ kind: 'hook', run: async () => {
        observations.push({ http: await t.post('memory/search', { query: canary }),
          mcp: await t.callTool('friday_memory_search', { query: canary }),
          explain: await t.callTool('friday_explain_context', {}) })
      } }, { kind: 'text', text: '部分来源已失效，这轮没有使用旧内容。' }]
      await t.host.handleMessage(next); previous = next
    }
    expect(t.peer.state.allPrompts).toHaveLength(3)
    expect(t.peer.state.allPrompts[1]!.sessionId).not.toBe(originalAcp)
    for (const prompt of t.peer.state.allPrompts.slice(1)) {
      // Real original human requests may mention the title canary; unavailable note bodies cannot reappear.
      expect(prompt.text).not.toContain(`body ${canary}`)
      expect(prompt.text).not.toContain(`title ${canary}`)
      expect(prompt.text).toContain('1 条记忆的来源已失效')
    }
    for (const result of observations) {
      expect(result.http).toMatchObject({ status: 200, body: { notes: [], availability: { inactive_notes: 1, temporarily_unavailable_notes: 0 } } })
      expect(result.mcp).toMatchObject({ isError: undefined })
      expect(result.mcp.text).toContain('1 条记忆的来源已失效')
      expect(JSON.stringify(result)).not.toContain(`body ${canary}`)
      expect(JSON.stringify(result)).not.toContain(`title ${canary}`)
      expect(result.explain.text).not.toContain('这一层还没有记忆')
    }
    expect(observations[1]!.explain.text).toContain('1 条记忆的来源已失效')
    expect(t.memory.getProvenance(note.id)?.state).toBe('unavailable')
    expect(t.memory.metadata(note.id, `space:${t.dm.id}`)?.revision).toBe(2)
  })

  it('adds newly denied entries to old inactive entries once, while excluding forgotten and other-scope rows', async () => {
    const t = await fixture(), old = managed(t), denied = managed(t), forgotten = managed(t), foreign = managed(t, 'org')
    t.memory.invalidateSources({ kind: 'notes', refs: [old, forgotten, foreign] })
    t.memory.remove(forgotten.id, `space:${t.dm.id}`)
    t.listChatsResult.mockResolvedValue({ items: [], complete: true })
    const replies: Awaited<ReturnType<Fixture['post']>>[] = []
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      replies.push(await t.post('memory/search', { query: 'unmatched query' }), await t.post('memory/search', { query: 'another query' }))
    } }, { kind: 'text', text: '这轮只使用可用记忆。' }]
    await t.host.handleMessage(t.message('本轮有哪些可用记忆？'))
    for (const reply of replies) expect(reply).toMatchObject({ status: 200, body: { notes: [], availability: { inactive_notes: 2, temporarily_unavailable_notes: 0 } } })
    expect(t.memory.getProvenance(denied.id)?.state).toBe('unavailable')
    expect(new ManagedMemoryStorage(t.registry.db).countUnavailable(`space:${t.dm.id}`)).toBe(2)
    expect(JSON.stringify(replies)).not.toContain(canary)
  })

  it('reports temporary verification failure separately and leaves the source available for a later successful Run', async () => {
    const t = await fixture(), note = managed(t)
    t.listChatsResult.mockRejectedValue(new AxiosError('SYNTHETIC_TEMPORARY_PLATFORM_FAILURE', 'ERR_NETWORK'))
    let result: Awaited<ReturnType<Fixture['post']>> | undefined, text = ''
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      result = await t.post('memory/search', { query: canary })
      text = (await t.callTool('friday_memory_search', { query: canary })).text
    } }, { kind: 'text', text: '这次暂未能核验来源。' }]
    const first = t.message('当前可用记忆是什么？')
    await t.host.handleMessage(first)
    expect(result).toMatchObject({ status: 200, body: { notes: [], availability: { inactive_notes: 0, temporarily_unavailable_notes: 1 } } })
    expect(text).toContain('1 条记忆的来源暂未能核验')
    expect(text).not.toContain('来源已失效')
    expect(t.peer.state.allPrompts[0]!.text).toContain('1 条记忆的来源暂未能核验')
    expect(t.memory.getProvenance(note.id)?.state).toBe('verified')
    expect(t.memory.metadata(note.id, `space:${t.dm.id}`)?.revision).toBe(1)
    t.listChatsResult.mockResolvedValue({ items: [{ chatId: 'oc_group', name: '合成群' }], complete: true })
    t.peer.state.script = [{ kind: 'hook', run: async () => { result = await t.post('memory/search', { query: canary }) } },
      { kind: 'text', text: '来源已可核验，按当前资料回答。' }]
    await t.host.handleMessage(t.message('再查当前资料', first.messageId))
    expect(result).toMatchObject({ status: 200, body: { notes: [{ id: note.id, body: `body ${canary}` }],
      availability: { inactive_notes: 0, temporarily_unavailable_notes: 0 } } })
    expect(t.memory.getProvenance(note.id)?.state).toBe('verified')
  })

  it('keeps the safe availability facts alongside a successful MCP hit', async () => {
    const t = await fixture(), old = managed(t)
    t.memory.invalidateSources({ kind: 'notes', refs: [old] })
    const current = t.memory.add({ scope: `space:${t.dm.id}`, kind: 'fact', title: 'current fact', body: 'CURRENT_AVAILABLE_BODY' })
    let result: Awaited<ReturnType<Fixture['callTool']>> | undefined
    t.peer.state.script = [{ kind: 'hook', run: async () => { result = await t.callTool('friday_memory_search', { query: 'current' }) } },
      { kind: 'text', text: '按当前可用资料回答。' }]
    await t.host.handleMessage(t.message('看当前资料'))
    expect(result?.text).toContain(`[memory:${current.id}]`)
    expect(result?.text).toContain('CURRENT_AVAILABLE_BODY')
    expect(result?.text).toContain('1 条记忆的来源已失效')
    expect(result?.text).not.toContain(canary)
  })

  it('describes a plain miss as this query result, not proof that memory was never saved', async () => {
    const t = await fixture()
    t.memory.add({ scope: `space:${t.dm.id}`, kind: 'fact', title: 'unrelated', body: 'useful legacy fact' })
    let result: Awaited<ReturnType<Fixture['callTool']>> | undefined
    t.peer.state.script = [{ kind: 'hook', run: async () => { result = await t.callTool('friday_memory_search', { query: 'no-match-string' }) } },
      { kind: 'text', text: '本次没有匹配结果。' }]
    await t.host.handleMessage(t.message('本次查询'))
    expect(result?.text).toContain('本轮可用记忆中未命中')
    expect(result?.text).not.toContain('没有相关笔记')
    expect(result?.text).not.toContain('来源已失效')
  })
})
