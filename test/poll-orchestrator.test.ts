import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig } from '../src/config.js'
import { Bugs } from '../src/core/bugs.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { Polls } from '../src/core/polls.js'
import { SourceContexts } from '../src/core/source-context.js'
import { Todos } from '../src/core/todos.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { normalizeCardAction } from '../src/feishu/ws.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** Production Orchestrator + mounted API/MCP + actual ACP protocol and disk
 * SQLite; only model output and Feishu network responses are synthetic. */
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-poll-mounted-')), registry = new Registry(join(home, 'db'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home,
    FRIDAY_PUBLIC_MODE: 'true', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'synthetic-group', openId: 'alice' })
  // Polls are off by default: the Orchestrator receives the deployment-enabled store below, and the group owner has turned polls on.
  sp.spaces.patchConfig(space.id, { polls: 'on' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('poll-mounted-test', 'error')
  fake.members.set(space.chatId!, new Set(['alice', 'bob'])); fake.names.set('bob', 'Bob')
  Object.assign(feishu, { userDisplayName: async (id: string) => fake.names.has(id)
    ? { status: 'known', name: fake.names.get(id)! } : { status: 'unknown' } })
  const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const todos = new Todos(registry.db), store = new Polls(registry.db), bugs = new Bugs(registry.db), tokens = new TokenIssuer('synthetic-poll-key')
  const userTokens = new UserTokenStore(registry.db, fake), execution = managedHostRuntime(registry, home, log)
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, messages, messageCache: cache, userTokens, feishu,
    runtime: execution.runtime, managed: execution.managed, tokens, polls: { store, bugs }, botOpenId: 'bot', log,
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', ingressClassifier: { classify: async () => ({ kind: 'new_work' }) } })
  const api = createInternalApi({ appId: cfg.feishu.appId, registry, ...sp, memory, todos, messages, messageCache: cache, userTokens, feishu,
    tokens, bugs, pollsEnabled: true, get polls() { return host.polls?.runtime }, log, maxHistoryPerCall: 20, oauthRedirectUri: cfg.feishu.oauth.redirectUri,
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPersistDerivedState: key => host.canPersistDerivedState(key), isManagedRun: id => host.isManagedRun(id),
    captureTodoProvenance: (key, id) => host.captureTodoProvenance(key, id) })
  await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`, state = execution.peer.state
  cleanups.push(async () => {
    api.beginShutdown(); host.beginShutdown(); await execution.runtime.stop(); api.server.closeAllConnections()
    await new Promise<void>(done => api.server.close(() => done()))
    expect(await api.waitForShutdown(1000)).toMatchObject({ drained: true }); expect(await host.waitForShutdown(1000)).toMatchObject({ drained: true })
    registry.close(); rmSync(home, { recursive: true, force: true })
  })
  const current = () => {
    const prompt = state.allPrompts.at(-1)!, session = registry.getSessionByAcpId(prompt.sessionId)!
    const servers = prompt.mcpServers as { env: { name: string; value: string }[] }[]
    return { session, actor: host.resolveActorForSession(session.sessionKey)!, token: servers[0]!.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value }
  }
  const tools = async () => {
    const server = buildServer({ apiUrl: base, token: current().token }), client = new Client({ name: 'synthetic-poll-model', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    return { client, close: async () => { await client.close(); await server.close() },
      call: async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args })
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
        return JSON.parse((result.content as { text: string }[])[0]!.text)
      } }
  }
  const message = (id: string): InboundMessage => ({ eventId: id, messageId: id, chatId: space.chatId!, chatType: 'group',
    senderOpenId: 'alice', senderType: 'user', tenantId: 'synthetic-tenant', msgType: 'text', text: '@Friday 处理这项合成投票请求。',
    mentions: [{ key: '@Friday', openId: 'bot', name: 'Friday' }], createTimeMs: Date.now() })
  const vote = async (id: string, choice: string | null, time: string) => {
    const poll = store.get(id)!
    return host.handleCardAction(normalizeCardAction({ event_id: `vote:${time}`, create_time: time,
      operator: { open_id: 'bob' }, context: { open_chat_id: space.chatId!, open_message_id: poll.messageId! },
      action: { tag: 'button', value: { action: 'poll_ballot', pollId: poll.id, digest: poll.contentDigest, optionId: choice } } }))
  }
  return { cfg, registry, ...sp, space, fake, store, bugs, todos, host, api, state, tools, message, current, vote }
}

describe('poll production callers', () => {
  it('runs real user admission → MCP/HTTP create → late human callback → new request read/close → feedback and original-group delivery', async () => {
    const t = await fixture(); let pollId = ''
    t.state.script = [{ kind: 'hook', run: async () => {
      const tools = await t.tools()
      try {
        expect((await tools.client.listTools()).tools.map(item => item.name)).toContain('friday_create_poll')
        pollId = (await tools.call('friday_create_poll', { question: 'Which synthetic requirement should be reviewed?', choices: ['Improve search', 'Improve export'], closesAt: 0 })).pollId
      } finally { await tools.close() }
    } }, { kind: 'text', text: '投票已发布，等待大家选择。' }]
    await t.host.handleMessage(t.message('create-request'))
    expect(t.registry.taskForMessage('create-request')?.status).toBe('done'); expect(t.store.get(pollId)?.state).toBe('open')
    expect(await t.vote(pollId, '1', '1000000')).toMatchObject({ toast: { type: 'success' } })
    let feedbackId = 0
    t.state.script = [{ kind: 'hook', run: async () => {
      const tools = await t.tools()
      try {
        expect((await tools.call('friday_list_polls')).polls.map((poll: { pollId: string }) => poll.pollId)).toContain(pollId)
        const first = await tools.call('friday_read_poll', { pollId }); expect(first.results[0].count).toBe(1)
        const key = t.current().session.sessionKey
        await t.vote(pollId, '2', '2000000')
        const second = await tools.call('friday_read_poll', { pollId }); expect(second.results[1].count).toBe(1)
        const sources = new SourceContexts(t.registry).get(key)!.pollSources!
        expect(sources.some(source => source.ballotRevision === 1)).toBe(true)
        expect(sources.some(source => source.ballotRevision === 2)).toBe(true)
        const active = t.current(), sourceStore = new SourceContexts(t.registry), before = sourceStore.get(key)!
        const file = await t.host.materials!.write(active.actor.runId!, { name: 'observed-votes.txt', text: 'Two historical poll observations.' }, 'poll-artifact')
        // Exercise material consumption from a fresh accumulator in this actual
        // ACP generation: the artifact must restore its exact poll dependencies.
        sourceStore.initialize({ sessionKey: key, acpSessionId: before.acpSessionId, spaceId: before.spaceId, chatId: before.chatId }, before.memoryScopes)
        // r78 has no ZIP packing (fourth batch). Editing the artifact takes the same path: authorize and consume its stored
        // provenance, then write a new version whose provenance must cover the old one (including the poll snapshots).
        await t.host.materials!.edit(active.actor.runId!, { fileId: file.fileId, expectedDigest: file.digest,
          edits: [{ oldText: 'Two historical', newText: 'Both historical' }] }, 'poll-artifact-edit')
        expect(sourceStore.get(key)!.pollSources).toEqual(sources)
        expect(t.host.canPersistDerivedState(key)).toBe(true)
        const todo = await tools.client.callTool({ name: 'friday_todo_add', arguments: { title: '整理已经读取的投票意见', detail: '按两次读取的历史快照比较，未自动采纳方案。' } })
        expect(todo.isError, JSON.stringify(todo.content)).not.toBe(true)
        feedbackId = (await tools.call('friday_close_poll', { pollId })).feedbackId
      } finally { await tools.close() }
    } }, { kind: 'text', text: '投票已经截止并关联反馈，等待负责人决断。' }]
    await t.host.handleMessage(t.message('close-request'))
    expect(t.registry.taskForMessage('close-request')).toMatchObject({ status: 'done', stopReason: 'end_turn' })
    expect(t.store.get(pollId)).toMatchObject({ state: 'closed', feedbackId })
    expect(t.bugs.reports(feedbackId)).toHaveLength(1); expect(t.bugs.get(feedbackId)?.issueUrl).toBeNull()
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM todos').get()?.n).toBe(1)
    expect(t.registry.db.prepare("SELECT status FROM deliveries WHERE context_ref=?",).all(`poll:${pollId}`)).toEqual([{ status: 'sent' }, { status: 'sent' }])
    expect(t.fake.sent.filter(item => item.kind === 'sendToChat').every(item => item.target === t.space.chatId)).toBe(true)
    expect(await t.vote(pollId, null, '3000000')).toMatchObject({ toast: { type: 'error' } })
  })

  it('denies derived writes when the original poll delegation is stopped after a successful read', async () => {
    const t = await fixture(); let pollId = '', writeDenied = false, sourceCurrent: boolean | undefined
    t.state.script = [{ kind: 'hook', run: async () => {
      const tools = await t.tools()
      try { pollId = (await tools.call('friday_create_poll', { question: 'Synthetic delegated poll', choices: ['A', 'B'] })).pollId }
      finally { await tools.close() }
    } }, { kind: 'text', text: '投票已发布。' }]
    await t.host.handleMessage(t.message('source-request'))
    expect(t.store.get(pollId)?.state).toBe('open')
    t.state.script = [{ kind: 'hook', run: async () => {
      const tools = await t.tools()
      try {
        await tools.call('friday_read_poll', { pollId })
        t.registry.workContexts.control(t.store.get(pollId)!.origin.workKey, { action: 'cancel', causeRef: 'actual-host-stop' })
        sourceCurrent = t.host.canPersistDerivedState(t.current().session.sessionKey)
        const todo = await tools.client.callTool({ name: 'friday_todo_add', arguments: { title: 'An unauthorized derivative' } })
        writeDenied = todo.isError === true
      } finally { await tools.close() }
    } }, { kind: 'text', text: '原委托已停止，没有新增待办。' }]
    await t.host.handleMessage(t.message('read-request'))
    expect(sourceCurrent).toBe(false); expect(writeDenied).toBe(true)
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM todos').get()?.n).toBe(0)
  })
})
