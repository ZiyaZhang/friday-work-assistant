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

const POLL_TOOLS = ['friday_close_poll', 'friday_create_poll', 'friday_list_polls', 'friday_read_poll']
const CLOSED = '本群没有开启需求投票'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** Same production assembly as poll-orchestrator.test.ts. `deployment` mirrors index.ts: with FRIDAY_POLLS=off the
 * Orchestrator gets no poll store and the API mounts no poll route. Only model output and Feishu are synthetic. */
async function fixture(deployment: 'on' | 'off') {
  const home = mkdtempSync(join(tmpdir(), 'friday-poll-switch-')), registry = new Registry(join(home, 'db'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home,
    FRIDAY_PUBLIC_MODE: 'true', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_POLLS: deployment })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'synthetic-group', openId: 'alice' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('poll-switch-test', 'error')
  fake.members.set(space.chatId!, new Set(['alice', 'bob'])); fake.names.set('bob', 'Bob')
  Object.assign(feishu, { userDisplayName: async (id: string) => fake.names.has(id)
    ? { status: 'known', name: fake.names.get(id)! } : { status: 'unknown' } })
  const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const todos = new Todos(registry.db), bugs = new Bugs(registry.db), tokens = new TokenIssuer('synthetic-poll-switch-key')
  const store = cfg.polls.enabled ? new Polls(registry.db) : undefined
  const userTokens = new UserTokenStore(registry.db, fake), execution = managedHostRuntime(registry, home, log)
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, messages, userTokens, feishu,
    runtime: execution.runtime, managed: execution.managed, tokens, polls: store ? { store, bugs } : undefined, botOpenId: 'bot', log,
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', ingressClassifier: { classify: async () => ({ kind: 'new_work' }) } })
  const api = createInternalApi({ appId: cfg.feishu.appId, registry, ...sp, memory, todos, messages, messageCache: cache, userTokens, feishu,
    tokens, bugs, pollsEnabled: cfg.polls.enabled, get polls() { return host.polls?.runtime }, abilities: host.abilities, log, maxHistoryPerCall: 20,
    oauthRedirectUri: cfg.feishu.oauth.redirectUri,
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
  const token = () => {
    const servers = state.allPrompts.at(-1)!.mcpServers as { env: { name: string; value: string }[] }[]
    return servers[0]!.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value
  }
  const tools = async () => {
    const server = buildServer({ apiUrl: base, token: token() }), client = new Client({ name: 'synthetic-poll-switch-model', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    return { client, close: async () => { await client.close(); await server.close() },
      names: async () => (await client.listTools()).tools.map(item => item.name).filter(name => POLL_TOOLS.includes(name)).sort(),
      text: async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args })
        return { isError: result.isError === true, text: (result.content as { text: string }[]).map(item => item.text).join('\n') }
      } }
  }
  /** One real user request whose synthetic model runs `hook` with the tools its own Run token lists. */
  const request = async (id: string, sender: string, hook: (t: Awaited<ReturnType<typeof tools>>) => Promise<void>, status = 'done') => {
    state.script = [{ kind: 'hook', run: async () => {
      const mcp = await tools()
      try { await hook(mcp) } finally { await mcp.close() }
    } }, { kind: 'text', text: '已处理。' }]
    const message: InboundMessage = { eventId: id, messageId: id, chatId: space.chatId!, chatType: 'group', senderOpenId: sender, senderType: 'user',
      tenantId: 'synthetic-tenant', msgType: 'text', text: '@Friday 合成请求。', mentions: [{ key: '@Friday', openId: 'bot', name: 'Friday' }], createTimeMs: Date.now() }
    await host.handleMessage(message)
    expect(registry.taskForMessage(id)?.status).toBe(status)
  }
  const scopes = () => tokens.verify(token())!.scopes
  const runId = () => host.resolveActorForSession(registry.getSessionByAcpId(state.allPrompts.at(-1)!.sessionId)!.sessionKey)!.runId!
  const vote = (id: string, choice: string | null, time: string) => {
    const poll = store!.get(id)!
    return host.handleCardAction(normalizeCardAction({ event_id: `vote:${time}`, create_time: time,
      operator: { open_id: 'bob' }, context: { open_chat_id: space.chatId!, open_message_id: poll.messageId! },
      action: { tag: 'button', value: { action: 'poll_ballot', pollId: poll.id, digest: poll.contentDigest, optionId: choice } } }))
  }
  return { cfg, registry, ...sp, space, fake, store, host, base, request, scopes, runId, vote }
}

describe('demand polls are off by default (FRIDAY_POLLS deployment switch and owner-controlled group switch)', () => {
  it('reads FRIDAY_POLLS as off unless it is exactly on', () => {
    const env = { FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret' }
    expect(loadConfig(env).polls.enabled).toBe(false)
    expect(loadConfig({ ...env, FRIDAY_POLLS: 'off' }).polls.enabled).toBe(false)
    expect(loadConfig({ ...env, FRIDAY_POLLS: 'on' }).polls.enabled).toBe(true)
    expect(() => loadConfig({ ...env, FRIDAY_POLLS: '1' })).toThrow('FRIDAY_POLLS')
  })

  it('keeps scopes, tools, ballots and deadline results closed until the owner turns the group on, and again after it is turned off', async () => {
    const t = await fixture('on')
    expect(t.spaces.get(t.space.id)?.config.polls).toBeUndefined()
    // A member cannot switch it on; the default-off Run lists no poll tools and its token carries no poll scope.
    await t.request('member-request', 'bob', async mcp => {
      expect(await mcp.names()).toEqual([])
      expect(await mcp.text('friday_space_settings', { args: 'set polls on' })).toMatchObject({ isError: true })
    })
    expect(t.scopes().filter(scope => scope.startsWith('polls:'))).toEqual([])
    expect(t.spaces.get(t.space.id)?.config.polls).toBeUndefined()
    // The owner turns it on with one sentence (mapped to the space settings tool); it applies from the next request.
    let reply = ''
    await t.request('enable-request', 'alice', async mcp => {
      expect(await mcp.names()).toEqual([])
      reply = (await mcp.text('friday_space_settings', { args: 'set polls on' })).text
    })
    expect(reply).toContain('本群已开启需求投票')
    expect(t.spaces.get(t.space.id)?.config.polls).toBe('on')
    let pollId = '', closesAt = 0
    await t.request('create-request', 'alice', async mcp => {
      expect(await mcp.names()).toEqual(POLL_TOOLS)
      closesAt = Date.now() + 2500
      const created = await mcp.text('friday_create_poll', { question: 'Which synthetic option?', choices: ['A', 'B'], closesAt })
      expect(created.isError, created.text).toBe(false)
      pollId = JSON.parse(created.text).pollId
    })
    expect(t.scopes()).toEqual(expect.arrayContaining(['polls:read', 'polls:write']))
    expect(await t.vote(pollId, '1', '1000000')).toMatchObject({ toast: { type: 'success' } })
    // Turning it off applies at once, even inside a Run whose token was issued while it was on: later calls are refused,
    // and an answer built on a poll this Run already read is not delivered (the poll source is re-checked at delivery).
    let read = { isError: true, text: '' }, off = '', listed = { isError: false, text: '' }, fileAfterOff: unknown
    await t.request('read-then-disable-request', 'alice', async mcp => {
      expect(await mcp.names()).toEqual(POLL_TOOLS)
      read = await mcp.text('friday_read_poll', { pollId })
      const file = await t.host.materials!.write(t.runId(), { name: 'votes.txt', text: 'Observed votes.' }, 'poll-switch-file')
      off = (await mcp.text('friday_space_settings', { args: 'set polls off' })).text
      listed = await mcp.text('friday_list_polls')
      fileAfterOff = await t.host.materials!.read(t.runId(), { fileId: file.fileId, expectedDigest: file.digest }).catch(error => error)
    }, 'failed')
    expect(fileAfterOff).toBeInstanceOf(Error)
    expect(read.isError, read.text).toBe(false); expect(JSON.parse(read.text).total).toBe(1)
    expect(t.fake.sent.filter(item => item.target === 'read-then-disable-request').map(item => item.payload))
      .toEqual(['处理失败，本次任务未能完成。可以在这个话题继续排查。'])
    expect(off).toContain('本群已关闭需求投票')
    expect(listed).toMatchObject({ isError: true }); expect(listed.text).toContain(CLOSED)
    expect(await t.vote(pollId, '2', '2000000')).toEqual({ toast: { type: 'error', content: expect.stringContaining(CLOSED) } })
    expect(t.store!.ballots(pollId).map(ballot => ballot.optionId)).toEqual(['1'])
    await new Promise(done => setTimeout(done, Math.max(0, closesAt - Date.now()) + 100))
    await t.host.polls!.runtime.tick()
    expect(t.store!.get(pollId)?.state).toBe('open')
    expect(t.fake.sent.filter(item => item.kind === 'sendToChat')).toHaveLength(1)
    await t.request('after-off-request', 'alice', async mcp => { expect(await mcp.names()).toEqual([]) })
    // Turning it on again resumes the original deadline once: the result is delivered to the original group.
    t.spaces.patchConfig(t.space.id, { polls: 'on' })
    await t.host.polls!.runtime.tick(); await t.host.polls!.runtime.tick()
    expect(t.store!.get(pollId)).toMatchObject({ state: 'closed', result: { total: 1 } })
    expect(t.fake.sent.filter(item => item.kind === 'sendToChat').map(item => item.target)).toEqual([t.space.chatId, t.space.chatId])
  })

  it('with FRIDAY_POLLS off, the group switch opens nothing and no poll route or runtime exists', async () => {
    const t = await fixture('off')
    let reply = ''
    await t.request('enable-request', 'alice', async mcp => {
      reply = (await mcp.text('friday_space_settings', { args: 'set polls on' })).text
    })
    expect(reply).toContain('FRIDAY_POLLS')
    expect(t.spaces.get(t.space.id)?.config.polls).toBe('on')
    await t.request('later-request', 'alice', async mcp => { expect(await mcp.names()).toEqual([]) })
    expect(t.scopes().filter(scope => scope.startsWith('polls:'))).toEqual([])
    expect(t.host.polls).toBeUndefined()
    const response = await fetch(`${t.base}/v1/polls/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(response.status).toBe(404)
    expect(await t.host.handleCardAction(normalizeCardAction({ event_id: 'vote:1', create_time: '1000000', operator: { open_id: 'bob' },
      context: { open_chat_id: t.space.chatId!, open_message_id: 'synthetic-card' },
      action: { tag: 'button', value: { action: 'poll_ballot', pollId: 'synthetic-poll', digest: 'a'.repeat(64), optionId: '1' } } })))
      .toEqual({ toast: { type: 'error', content: '投票协作当前不可用。' } })
  })
})
