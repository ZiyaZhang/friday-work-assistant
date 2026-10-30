import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig } from '../src/config.js'
import { Registry } from '../src/core/registry.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { GitHubIdentity, loadGitHubConfig } from '../src/github/identity.js'
import { IssueLinks } from '../src/github/issues.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const url = 'https://github.com/org/demo/issues/42', commentUrl = `${url}#issuecomment-17`

/** Real managed Host + ACP + MCP/HTTP + SQLite. Only platform providers and model are synthetic. */
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-issue-receipt-')), registry = new Registry(':memory:')
  const log = createLogger('issue-receipt', 'error'), cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic',
    FRIDAY_HOME: home, FRIDAY_PUBLIC_MODE: 'true', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'chat', openId: 'alice' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake); fake.members.set('chat', new Set(['alice']))
  const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const todos = new Todos(registry.db), tokens = new TokenIssuer('synthetic-only'), links = new IssueLinks(registry.db)
  const provider = { writes: 0, unknown: false, afterPost: undefined as (() => void) | undefined, paths: [] as string[] }
  const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'synthetic', FRIDAY_GITHUB_REPOS: 'org/demo', FRIDAY_GITHUB_WRITE_REPOS: 'org/demo' })!, log, {
    async request<T>(method: string, path: string) {
      provider.paths.push(`${method} ${path}`)
      if (path.startsWith('/search/issues')) return { status: 200, data: { items: [], total_count: 0, incomplete_results: false } as T }
      if (method === 'POST') {
        provider.writes++; provider.afterPost?.()
        if (provider.unknown) return { status: 503, data: {} as T }
        if (path.endsWith('/comments')) return { status: 201, data: { id: 17, html_url: commentUrl } as T }
      }
      return { status: 200, data: { number: 42, title: 'Synthetic issue', state: 'open', html_url: url, assignees: [], labels: [] } as T }
    },
  })
  const execution = managedHostRuntime(registry, home, log), state = execution.peer.state
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, messages, messageCache: cache, feishu, tokens, github,
    runtime: execution.runtime, managed: execution.managed, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent',
    botOpenId: 'bot', log, repositoryAllowed: repo => github.repoAllowed(repo), ingressClassifier: { classify: async () => ({ kind: 'work_request' }) } })
  const api = createInternalApi({ appId: cfg.feishu.appId, registry, ...sp, memory, todos, messages, messageCache: cache, feishu, github, issueLinks: links,
    tokens, log, maxHistoryPerCall: 20, resolveActorForSession: key => host.resolveActorForSession(key),
    allowedRoutesForSession: key => host.allowedRoutesForSession(key), canPublishToRepository: (key, repo) => host.canPublishToRepository(key, repo),
    onRepositoryRead: (key, repo) => host.noteRepositoryRead(key, repo),
    recordRepositoryResult: (key, runId, receipt) => host.recordRepositoryResult(key, runId, receipt) })
  await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const current = () => {
    const prompt = state.allPrompts.at(-1)!, session = registry.getSessionByAcpId(prompt.sessionId)!
    const servers = prompt.mcpServers as { env: { name: string; value: string }[] }[]
    return { session, actor: host.resolveActorForSession(session.sessionKey)!, token: servers[0]!.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value }
  }
  const tool = async (kind: 'open' | 'comment' = 'open') => {
    const server = buildServer({ apiUrl: base, token: current().token }), client = new Client({ name: 'synthetic', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    try { return await client.callTool({ name: kind === 'open' ? 'github_open_issue' : 'github_comment_issue', arguments: kind === 'open'
      ? { repo: 'org/demo', title: 'Synthetic issue', body: 'Synthetic request with sufficient context.' }
      : { repo: 'org/demo', number: 42, body: 'Synthetic additional evidence.' } }) }
    finally { await client.close(); await server.close() }
  }
  const message: InboundMessage = { eventId: 'event', messageId: 'request', chatId: 'chat', chatType: 'group', senderOpenId: 'alice', senderType: 'user',
    threadId: 'synthetic-thread', rootId: 'synthetic-thread',
    msgType: 'text', text: '@Friday 把这条明确反馈建单并给我结果。', mentions: [{ key: '@Friday', name: 'Friday', openId: 'bot' }], createTimeMs: Date.now() }
  cleanups.push(async () => { api.beginShutdown(); host.beginShutdown(); await execution.runtime.stop(); api.server.closeAllConnections()
    await new Promise<void>(done => api.server.close(() => done())); await host.waitForShutdown(1000); registry.close(); rmSync(home, { recursive: true, force: true }) })
  return { host, registry, state, fake, provider, tool, current, message, sp, space }
}

describe('confirmed Issue receipts reach the current Run final answer', () => {
  it.each(['open', 'comment'] as const)('adds the actual %s URL when the model omits it, without an administrator notification', async kind => {
    const t = await fixture()
    t.state.script = [{ kind: 'hook', run: async () => { expect((await t.tool(kind)).isError).not.toBe(true) } }, { kind: 'text', text: '已处理这条反馈。' }]
    await t.host.handleMessage(t.message)
    expect(t.fake.answers().join('\n')).toContain(kind === 'open' ? url : commentUrl)
    expect(t.fake.of('sendToUser')).toHaveLength(0)
    expect(t.fake.of('replyMarkdown')).toHaveLength(1)
    expect(t.provider.writes).toBe(1)
    expect(t.registry.db.prepare('SELECT status FROM github_issue_operations').get()?.status).toBe('confirmed')
  })

  it('does not invent a link when the Issue POST outcome is unknown', async () => {
    const t = await fixture(); t.provider.unknown = true
    t.state.script = [{ kind: 'hook', run: async () => { expect((await t.tool()).isError).toBe(true) } }, { kind: 'text', text: '写入结果尚待核对。' }]
    await t.host.handleMessage(t.message)
    expect(t.registry.db.prepare('SELECT status FROM github_issue_operations').get()?.status).toBe('unknown')
    expect(JSON.stringify(t.fake.sent)).not.toContain(url)
    expect(t.provider.writes).toBe(1)
  })

  it.each(['source', 'stop', 'remove-actor'] as const)('keeps the normal Delivery gate after a confirmed write and %s', async change => {
    const t = await fixture()
    t.state.script = [{ kind: 'hook', run: async () => {
      expect((await t.tool()).isError).not.toBe(true)
      const c = t.current(), task = t.registry.taskForMessage(t.message.messageId)!
      if (change === 'source') t.host.noteCrossSpaceRead(c.session.sessionKey, { chatId: 'other-private-chat', name: 'private', what: 'history' })
      else if (change === 'remove-actor') t.sp.spaces.removeMember(t.space.id, 'alice')
      else t.host.persistHumanRunStop({ actorOpenId: 'alice', spaceId: t.space.id, runId: c.actor.runId!, taskId: task.id,
        assertCurrent: () => t.sp.spaces.get(t.space.id)! }).afterCommit()
    } }, { kind: 'text', text: '已处理。' }]
    await t.host.handleMessage(t.message)
    expect(t.registry.db.prepare('SELECT status FROM github_issue_operations').get()?.status).toBe('confirmed')
    expect(JSON.stringify(t.fake.sent)).not.toContain(url)
  })

  it('does not carry another Run or Work receipt into a later answer in the same session', async () => {
    const t = await fixture(); let previous: { key: string; runId: string } | undefined
    t.state.script = [{ kind: 'hook', run: async () => {
      expect((await t.tool()).isError).not.toBe(true); const c = t.current(); previous = { key: c.session.sessionKey, runId: c.actor.runId! }
    } }, { kind: 'text', text: '建单已处理。' }]
    await t.host.handleMessage(t.message)
    const start = t.fake.sent.length
    t.state.script = [{ kind: 'hook', run: () => t.host.recordRepositoryResult(previous!.key, previous!.runId, { repo: 'org/demo', url }) },
      { kind: 'text', text: '这是新问题的回答。' }]
    await t.host.handleMessage({ ...t.message, eventId: 'new', messageId: 'new', text: '另一个独立问题：说明当前使用方法。' })
    expect(JSON.stringify(t.fake.sent.slice(start))).not.toContain(url)
    const first = t.registry.taskForMessage('request')!, next = t.registry.taskForMessage('new')!
    expect(first.sessionKey).toBe(next.sessionKey)
    expect(t.registry.taskWork.get(first.id)?.key).not.toBe(t.registry.taskWork.get(next.id)?.key)
  })
})
