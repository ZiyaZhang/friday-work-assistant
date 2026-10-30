import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { UserTokenStore } from '../src/feishu/oauth.js'
import { createLogger } from '../src/log.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const url = 'https://github.com/org/demo/issues/42', commentUrl = `${url}#issuecomment-17`
const ARTIFACT_CHANGED = '这条请求等待期间，相关事项关联的 Issue 或 PR 的来源或访问权限已变化。旧请求已保留，没有自动执行；请确认是否还需要按原要求处理。'

/** Real managed Host + ACP + MCP/HTTP + SQLite. Only platform providers and model are synthetic. */
async function fixture(options: { home?: string; refuseOrigin?: boolean } = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'friday-issue-routing-')), registry = new Registry(join(home, 'friday.db'))
  const log = createLogger('issue-receipt', 'error'), cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic',
    FRIDAY_HOME: home, FRIDAY_PUBLIC_MODE: 'true', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'chat', openId: 'alice' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake); fake.members.set('chat', new Set(['alice']))
  const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const todos = new Todos(registry.db), tokens = new TokenIssuer('synthetic-only'), links = new IssueLinks(registry.db)
  const provider = { writes: 0, comments: 0, unknown: false, readError: false, afterPost: undefined as (() => void) | undefined, paths: [] as string[] }
  const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'synthetic', FRIDAY_GITHUB_REPOS: 'org/demo', FRIDAY_GITHUB_WRITE_REPOS: 'org/demo' })!, log, {
    async request<T>(method: string, path: string) {
      provider.paths.push(`${method} ${path}`)
      if (path.startsWith('/search/issues')) return { status: 200, data: { items: [], total_count: 0, incomplete_results: false } as T }
      if (method === 'POST') {
        provider.writes++; provider.afterPost?.()
        if (provider.unknown) return { status: 503, data: {} as T }
        if (path.endsWith('/comments')) {
          const id = 17 + provider.comments++
          return { status: 201, data: { id, html_url: id === 17 ? commentUrl : `${url}#issuecomment-${id}` } as T }
        }
      }
      if (provider.readError && method === 'GET') throw new Error('synthetic read-back unavailable')
      return { status: 200, data: { number: 42, title: 'Synthetic issue', state: 'open', html_url: url, assignees: [], labels: [] } as T }
    },
  })
  const execution = managedHostRuntime(registry, home, log), state = execution.peer.state
  const routing = { forceNew: false, beforeDecision: undefined as (() => void | Promise<void>) | undefined }
  const classifications: import('../src/acp/ingress-classifier.js').IngressClassificationInput[] = []
  const host = new Orchestrator({ cfg, registry, userTokens: new UserTokenStore(registry.db, fake), ...sp, memory, todos, messages, messageCache: cache, feishu, tokens, github,
    runtime: execution.runtime, managed: execution.managed, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent',
    botOpenId: 'bot', log, repositoryAllowed: repo => github.repoAllowed(repo), ingressClassifier: { classify: async input => {
      classifications.push(structuredClone(input))
      await routing.beforeDecision?.()
      if (routing.forceNew) return { kind: 'work_request' as const }
      const selected = input.candidates.find(candidate => candidate.deliverables?.some(item => item.kind === 'issue' && item.number === 42))
      return selected ? { kind: 'amend', targetRef: selected.ref } : { kind: 'new_work' }
    } } })
  const api = createInternalApi({ appId: cfg.feishu.appId, registry, ...sp, memory, todos, messages, messageCache: cache, feishu, github, issueLinks: links,
    tokens, log, maxHistoryPerCall: 20, resolveActorForSession: key => host.resolveActorForSession(key),
    allowedRoutesForSession: key => host.allowedRoutesForSession(key), canPublishToRepository: (key, repo) => host.canPublishToRepository(key, repo),
    onRepositoryRead: (key, repo) => host.noteRepositoryRead(key, repo),
    // refuseOrigin: the real host method refuses a binding that does not name the Run's own session.
    captureRepositoryIssueOrigin: (key: string, runId: string, repo: string) => host.captureRepositoryIssueOrigin(options.refuseOrigin ? `${key}:other` : key, runId, repo),
    recordRepositoryResult: (key, runId, receipt) => host.recordRepositoryResult(key, runId, receipt) })
  await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const current = () => {
    const prompt = state.allPrompts.at(-1)!, session = registry.getSessionByAcpId(prompt.sessionId)!
    const servers = prompt.mcpServers as { env: { name: string; value: string }[] }[]
    return { session, actor: host.resolveActorForSession(session.sessionKey)!, token: servers[0]!.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value }
  }
  const tool = async (kind: 'open' | 'comment' = 'open', body = 'Synthetic additional evidence.') => {
    const server = buildServer({ apiUrl: base, token: current().token }), client = new Client({ name: 'synthetic', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    try { return await client.callTool({ name: kind === 'open' ? 'github_open_issue' : 'github_comment_issue', arguments: kind === 'open'
      ? { repo: 'org/demo', title: 'Synthetic issue', body: 'Synthetic request with sufficient context.' }
      : { repo: 'org/demo', number: 42, body } }) }
    finally { await client.close(); await server.close() }
  }
  /** The same signed HTTP route the MCP tool uses, keeping the actual status code. */
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${current().token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, error: String((await response.json() as { error?: unknown }).error ?? '') }
  }
  const message: InboundMessage = { eventId: 'event', messageId: 'request', chatId: 'chat', chatType: 'group', senderOpenId: 'alice', senderType: 'user',
    threadId: 'synthetic-thread', rootId: 'synthetic-thread',
    msgType: 'text', text: '@Friday 把这条明确反馈建单并给我结果。', mentions: [{ key: '@Friday', name: 'Friday', openId: 'bot' }], createTimeMs: Date.now() }
  let closed = false
  const close = async (remove = true) => {
    if (closed) return; closed = true
    api.beginShutdown(); host.beginShutdown(); await execution.runtime.stop(); api.server.closeAllConnections()
    await new Promise<void>(done => api.server.close(() => done())); await host.waitForShutdown(1000); registry.close()
    if (remove) rmSync(home, { recursive: true, force: true })
  }
  cleanups.push(close)
  return { host, registry, state, fake, provider, tool, post, current, message, sp, space, classifications, links, routing, home, close, github }

}

describe('Issue identities stay with their actual producing Work', () => {
  it.each(['open', 'comment'] as const)('routes a %s follow-up to the original Work using the ACK ledger, not neighbouring text', async kind => {
    const t = await fixture()
    t.state.script = [{ kind: 'hook', run: async () => { expect((await t.tool(kind)).isError).not.toBe(true) } }, { kind: 'text', text: '已处理。' }]
    await t.host.handleMessage(t.message)
    const original = t.registry.taskForMessage('request')!, originalWork = t.registry.taskWork.get(original.id)!.key
    t.state.script = [{ kind: 'text', text: '继续处理同一事项。' }]
    await t.host.handleMessage({ ...t.message, messageId: 'follow', eventId: 'follow', text: '请继续关注 Issue #42 的后续回复。' })
    expect(t.classifications.at(-1)?.candidates.flatMap(candidate => candidate.deliverables ?? [])).toContainEqual({
      kind: 'issue', repo: 'org/demo', number: 42, url })
    expect(t.registry.taskWork.get(t.registry.taskForMessage('follow')!.id)!.key).toBe(originalWork)
    expect(t.provider.writes).toBe(1)
    const saved = t.registry.db.prepare('SELECT origin_json FROM github_issue_operations').get()!
    const origin = JSON.parse(String(saved.origin_json))
    expect(origin.origin).toMatchObject({ workKey: originalWork, taskId: original.id, ownerOpenId: 'alice' })
    expect(t.registry.db.prepare('SELECT run_id,route FROM run_api_calls WHERE id=?').get(origin.apiCallId)).toMatchObject({
      run_id: origin.origin.runId, route: `POST /v1/github/issue/${kind}` })
  })

  it('keeps the exact receipt through a real SQLite/host restart', async () => {
    const first = await fixture()
    first.state.script = [{ kind: 'hook', run: async () => { expect((await first.tool()).isError).not.toBe(true) } }]
    await first.host.handleMessage(first.message)
    const work = first.registry.taskWork.get(first.registry.taskForMessage('request')!.id)!.key
    const saved = first.registry.db.prepare('SELECT origin_json FROM github_issue_operations').get()?.origin_json
    await first.close(false)
    const next = await fixture({ home: first.home })
    next.state.script = [{ kind: 'text', text: '继续同一事项。' }]
    await next.host.handleMessage({ ...next.message, messageId: 'restart-follow', eventId: 'restart-follow', text: '继续 Issue #42。' })
    expect(next.registry.taskWork.get(next.registry.taskForMessage('restart-follow')!.id)!.key).toBe(work)
    expect(next.registry.db.prepare('SELECT origin_json FROM github_issue_operations').get()?.origin_json).toBe(saved)
    expect(next.provider.writes).toBe(0)
  })

  it.each(['unknown', 'legacy', 'wrong-call', 'source-denied', 'repo-denied', 'another-person'] as const)(
    'does not route by an unproven identity: %s', async mode => {
      const t = await fixture(); t.provider.unknown = mode === 'unknown'
      t.state.script = [{ kind: 'hook', run: async () => { await t.tool() } }]
      await t.host.handleMessage(t.message)
      const task = t.registry.taskForMessage('request')!, work = t.registry.taskWork.get(task.id)!.key
      if (mode === 'legacy') t.registry.db.prepare('UPDATE github_issue_operations SET origin_json=NULL').run()
      if (mode === 'wrong-call') t.registry.db.prepare("UPDATE run_api_calls SET route='POST /v1/github/issues' WHERE route='POST /v1/github/issue/open'").run()
      if (mode === 'source-denied') t.fake.members.set('chat', new Set())
      if (mode === 'repo-denied') t.github.repoAllowed = () => false
      if (mode === 'another-person') { t.sp.spaces.touchMember(t.space.id, 'bob'); t.fake.members.get('chat')!.add('bob') }
      t.state.script = [{ kind: 'text', text: '另行处理。' }]
      await t.host.handleMessage({ ...t.message, messageId: 'follow', eventId: 'follow', text: '继续 Issue #42。',
        ...(mode === 'another-person' ? { senderOpenId: 'bob' } : {}) })
      expect(t.classifications.at(-1)?.candidates.flatMap(candidate => candidate.deliverables ?? []) ?? []).toEqual([])
      const next = t.registry.taskForMessage('follow')
      if (next) expect(t.registry.taskWork.get(next.id)!.key).not.toBe(work)
      expect(t.provider.writes).toBe(1)
    })

  it('preserves a real POST ACK even when read-back failed, without sending it again', async () => {
    const t = await fixture(); t.provider.readError = true
    t.state.script = [{ kind: 'hook', run: async () => { expect((await t.tool()).isError).toBe(true) } }]
    await t.host.handleMessage(t.message)
    expect(t.registry.db.prepare('SELECT status FROM github_issue_operations').get()?.status).toBe('sent')
    const work = t.registry.taskWork.get(t.registry.taskForMessage('request')!.id)!.key
    t.provider.readError = false; t.state.script = [{ kind: 'text', text: '核对原来的事项。' }]
    await t.host.handleMessage({ ...t.message, messageId: 'follow', eventId: 'follow', text: '核对 Issue #42。' })
    expect(t.registry.taskWork.get(t.registry.taskForMessage('follow')!.id)!.key).toBe(work)
    expect(t.provider.writes).toBe(1)
  })

  it('keeps a same-session independent Work separate and attaches the identity only to its producer', async () => {
    const t = await fixture()
    t.state.script = [{ kind: 'hook', run: async () => { await t.tool() } }]
    await t.host.handleMessage(t.message)
    const original = t.registry.taskForMessage('request')!, work = t.registry.taskWork.get(original.id)!.key
    t.routing.forceNew = true; t.state.script = [{ kind: 'text', text: '独立问题。' }]
    await t.host.handleMessage({ ...t.message, messageId: 'other', eventId: 'other', text: '新的独立问题。' })
    const other = t.registry.taskForMessage('other')!
    expect(other.sessionKey).toBe(original.sessionKey)
    expect(t.registry.taskWork.get(other.id)!.key).not.toBe(work)
    t.routing.forceNew = false
    await t.host.handleMessage({ ...t.message, messageId: 'follow', eventId: 'follow', text: '继续 Issue #42 的后续。' })
    const candidates = t.classifications.at(-1)!.candidates
    expect(candidates.filter(candidate => candidate.deliverables?.some(item => item.url === url))).toHaveLength(1)
    expect(t.registry.taskWork.get(t.registry.taskForMessage('follow')!.id)!.key).toBe(work)
  })

  it('does not apply a decision after its retained source became unreadable during classification', async () => {
    const t = await fixture()
    t.state.script = [{ kind: 'hook', run: async () => { await t.tool() } }]
    await t.host.handleMessage(t.message)
    t.routing.beforeDecision = () => { t.github.repoAllowed = () => false }
    t.state.script = [{ kind: 'text', text: '不能借失效出处继续。' }]
    await t.host.handleMessage({ ...t.message, messageId: 'follow', eventId: 'follow', text: '继续 Issue #42。' })
    expect(t.registry.taskForMessage('follow')).toBeUndefined()
  })

  it('tells the sender, durably, instead of silently dropping a request whose identity changed during classification', async () => {
    const t = await fixture()
    t.state.script = [{ kind: 'hook', run: async () => { await t.tool() } }]
    await t.host.handleMessage(t.message)
    t.routing.beforeDecision = () => { t.github.repoAllowed = () => false }
    t.state.script = [{ kind: 'text', text: '不能借失效出处继续。' }]
    await t.host.handleMessage({ ...t.message, messageId: 'follow', eventId: 'follow', text: '继续 Issue #42。' })
    expect(t.registry.taskForMessage('follow')).toBeUndefined()
    expect(t.fake.of('replyText').filter(item => item.target === 'follow').map(item => item.payload)).toEqual([ARTIFACT_CHANGED])
    expect(t.registry.db.prepare("SELECT decision, result, notice FROM ingress_routes WHERE message_id='follow'").get()).toEqual({
      decision: expect.stringContaining('"amend"'), result: ARTIFACT_CHANGED, notice: ARTIFACT_CHANGED })
    expect(['sent', 'confirmed']).toContain(t.registry.db.prepare("SELECT status FROM deliveries WHERE delivery_key='route:follow'").get()?.status)
  })

  it.each(['open', 'comment'] as const)('answers a host refusal to bind a %s write to its Work with 403 before any write', async kind => {
    const t = await fixture({ refuseOrigin: true })
    let response: { status: number; error: string } | undefined
    t.state.script = [{ kind: 'hook', run: async () => {
      response = await t.post(`/v1/github/issue/${kind}`, kind === 'open'
        ? { repo: 'org/demo', title: 'Synthetic issue', body: 'Synthetic request with sufficient context.' }
        : { repo: 'org/demo', number: 42, body: 'Synthetic additional evidence.' })
    } }, { kind: 'text', text: '没有写入。' }]
    await t.host.handleMessage(t.message)
    expect(response).toMatchObject({ status: 403, error: expect.stringContaining('Issue 写入未执行') })
    expect(response!.error).not.toContain('GitHub：')
    expect(t.provider.writes).toBe(0)
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_issue_operations').get()?.n).toBe(0)
  })

  it('authorizes one Issue identity once even when its Work wrote to that Issue several times', async () => {
    const t = await fixture()
    t.state.script = [{ kind: 'hook', run: async () => {
      expect((await t.tool('open')).isError).not.toBe(true)
      expect((await t.tool('comment', 'Synthetic first addition.')).isError).not.toBe(true)
      expect((await t.tool('comment', 'Synthetic second addition.')).isError).not.toBe(true)
    } }, { kind: 'text', text: '已处理。' }]
    await t.host.handleMessage(t.message)
    const work = t.registry.taskWork.get(t.registry.taskForMessage('request')!.id)!.key
    expect(t.registry.db.prepare("SELECT count(*) AS n FROM github_issue_operations WHERE status IN ('sent','confirmed')").get()?.n).toBe(3)
    const authorize = vi.spyOn(t.host as unknown as { authorizeSavedContext: (...args: unknown[]) => unknown }, 'authorizeSavedContext')
    let authorizedBeforeClassification = -1
    t.routing.beforeDecision = () => { authorizedBeforeClassification = authorize.mock.calls.length }
    t.state.script = [{ kind: 'text', text: '继续处理同一事项。' }]
    await t.host.handleMessage({ ...t.message, messageId: 'follow', eventId: 'follow', text: '请继续关注 Issue #42 的后续回复。' })
    expect(t.classifications.at(-1)?.candidates.flatMap(candidate => candidate.deliverables ?? [])).toEqual([{ kind: 'issue', repo: 'org/demo', number: 42, url }])
    expect(authorizedBeforeClassification).toBe(1)
    expect(t.registry.taskWork.get(t.registry.taskForMessage('follow')!.id)!.key).toBe(work)
    expect(t.provider.writes).toBe(3)
  })
})
