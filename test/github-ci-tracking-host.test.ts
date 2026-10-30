import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig } from '../src/config.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { SourceContexts } from '../src/core/source-context.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { ChangeManager } from '../src/github/changes.js'
import { ChangePreparationOperations } from '../src/github/preparation-operations.js'
import { duePreparationRecovery } from '../src/core/local-preparation-recovery.js'
import { GitHubIdentity, loadGitHubConfig } from '../src/github/identity.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer, PROACTIVE_SCOPES } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: { ...process.env,
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.test' } }).trim()
}

/** Real Orchestrator, managed ACP, MCP/HTTP, disk SQLite and Git. The model,
 * GitHub checks and Feishu provider are synthetic; no production acceptance claim. */
async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-ci-host-'))), source = join(home, 'source'), bare = join(home, 'remote.git')
  mkdirSync(source); git(source, 'init', '-q'); git(source, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(source, 'README.md'), 'before\n'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'initial')
  git(home, 'clone', '-q', '--bare', source, bare)
  const registry = new Registry(join(home, 'state.sqlite')), log = createLogger('ci-host', 'error')
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home,
    FRIDAY_PUBLIC_MODE: 'true', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '10000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'synthetic-group', openId: 'alice' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake); fake.members.set(space.chatId!, new Set(['alice']))
  const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const todos = new Todos(registry.db), tokens = new TokenIssuer('synthetic-ci-key'), userTokens = new UserTokenStore(registry.db, fake)
  let losePublishResponse = false
  const provider = { conclusion: 'failure', pending: false, unavailable: false, open: true, creates: 0, reads: 0, approvalPending: false }
  const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'synthetic-token', FRIDAY_GITHUB_REPOS: 'org/demo', FRIDAY_GITHUB_WRITE_REPOS: 'org/demo' })!, log, {
    async request(method, path) {
      if (path === '/user') return { status: 200, data: { login: 'tester' } as never }
      if (path === '/users/tester') return { status: 200, data: { id: 123 } as never }
      if (path.includes('/pulls?')) return { status: 200, data: [] as never }
      if (method === 'POST' && path.endsWith('/pulls')) { provider.creates++; return { status: 201, data: { number: 1, html_url: 'https://github.com/org/demo/pull/1' } as never } }
      const change = registry.db.prepare('SELECT * FROM github_changes LIMIT 1').get()
      const head = change ? git(bare, 'rev-parse', `refs/heads/${change.branch}`) : 'a'.repeat(40)
      if (path.endsWith('/pulls/1')) return { status: 200, data: { number: 1, state: provider.open ? 'open' : 'closed', draft: true, merged: false,
        html_url: 'https://github.com/org/demo/pull/1', head: { sha: head, ref: change?.branch, repo: { full_name: 'org/demo' } },
        base: { ref: 'main', repo: { full_name: 'org/demo' } } } as never }
      if (path.includes('/check-runs?')) {
        provider.reads++
        if (provider.unavailable) return { status: 503, data: {} as never }
        return { status: 200, data: { total_count: 1, check_runs: [{ id: 10, name: 'build', head_sha: head,
          status: provider.pending ? 'in_progress' : 'completed', conclusion: provider.pending ? null : provider.conclusion }] } as never }
      }
      if (path.includes('/status?')) return { status: 200, data: { total_count: provider.approvalPending ? 1 : 0,
        statuses: provider.approvalPending ? [{ id: 77, context: 'review approval', state: 'pending', target_url: null }] : [] } as never }
      return { status: 404, data: {} as never }
    },
  })
  const changes = new ChangeManager({ db: registry.db, github, cacheDir: join(home, 'cache'), log, remoteUrlFor: () => `file://${bare}`, createPullRequests: true })
  const preparations = new ChangePreparationOperations({ changes })
  const execution = managedHostRuntime(registry, home, log), state = execution.peer.state
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, messages, messageCache: cache, userTokens, feishu,
    runtime: execution.runtime, managed: execution.managed, tokens, github, changes, preparations, repositoryAllowed: repo => github.repoAllowed(repo),
    botOpenId: 'bot', log, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', ingressClassifier: { classify: async () => ({ kind: 'new_work' }) } })
  const api = createInternalApi({ appId: cfg.feishu.appId, registry, ...sp, memory, todos, messages, messageCache: cache, userTokens, feishu,
    github, changes, preparations, preparationRunSignal: (key, runId) => host.preparationRunSignal(key, runId), tokens, log, maxHistoryPerCall: 20, oauthRedirectUri: cfg.feishu.oauth.redirectUri,
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPublishToRepository: (key, repo) => host.canPublishToRepository(key, repo), onRepositoryRead: (key, repo) => host.noteRepositoryRead(key, repo),
    repositoryCiTracking: (key, runId, input) => host.repositoryCiTracking(key, runId, input),
    armRepositoryCi: (key, runId, input) => host.armRepositoryCi(key, runId, input), isManagedRun: id => host.isManagedRun(id) })
  // Lose only the actual publish response after its handler and domain ACK.
  api.server.on('request', (req, res) => {
    if (losePublishResponse && req.url === '/v1/github/change/publish') {
      res.end = (() => { losePublishResponse = false; res.destroy(); return res }) as typeof res.end
    }
  })
  await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  cleanups.push(async () => { api.beginShutdown(); host.beginShutdown(); await execution.runtime.stop(); api.server.closeAllConnections()
    await new Promise<void>(done => api.server.close(() => done())); await host.waitForShutdown(1000); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const current = () => {
    const prompt = state.allPrompts.at(-1)!, session = registry.getSessionByAcpId(prompt.sessionId)!
    const servers = prompt.mcpServers as { env: { name: string; value: string }[] }[]
    return { session, actor: host.resolveActorForSession(session.sessionKey)!, token: servers[0]!.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value }
  }
  const modelTools = async (fn: (call: (name: string, args: Record<string, unknown>) => Promise<string>) => Promise<void>) => {
    const server = buildServer({ apiUrl: base, token: current().token }), client = new Client({ name: 'synthetic-ci-worker', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    try { await fn(async (name, args) => { const result = await client.callTool({ name, arguments: args })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      return (result.content as { text?: string }[]).map(item => item.text ?? '').join('\n') }) }
    finally { await client.close(); await server.close() }
  }
  const edit = (content: string, first: boolean) => modelTools(async call => {
    if (first) {
      let receipt = await call('github_start_change', { repo: 'org/demo', base: 'main', branch_hint: 'test-ci' })
      for (let waits = 0; receipt.startsWith('{') && waits < 5; waits++) {
        expect(JSON.parse(receipt).preparation.state).toBe('preparing')
        receipt = await call('github_wait_change', { repo: 'org/demo', base: 'main' })
      }
      expect(receipt).toContain('已准备好可写副本')
    }
    const change = registry.db.prepare('SELECT * FROM github_changes LIMIT 1').get()!
    const found = JSON.parse(await call('github_search_change_files', { changeId: change.id, query: 'README', mode: 'path' }))
    expect(found.matches).toContainEqual({ path: 'README.md' })
    const file = JSON.parse(await call('github_read_change_file', { changeId: change.id, path: 'README.md', consistency: 'snapshot' }))
    await call('github_edit_change_file', { changeId: change.id, path: 'README.md', expectedSnapshot: file.snapshot,
      expectedDigest: file.digest, oldText: file.content, newText: content })
    const operation = registry.db.prepare("SELECT scopes_json FROM run_api_calls WHERE route='POST /v1/github/change/files/edit' ORDER BY started_at DESC LIMIT 1").get()
    expect(JSON.parse(String(operation?.scopes_json))).toContain('github:write')
    await call(first ? 'github_open_pr' : 'github_update_pr', { dir: change.dir, title: 'test: CI continuation', body: 'Synthetic protocol fixture; validation pending.' })
  })
  const message: InboundMessage = { eventId: 'report', messageId: 'report', chatId: space.chatId!, chatType: 'group', senderOpenId: 'alice',
    senderType: 'user', tenantId: 'tenant', msgType: 'text', text: '@Friday 修正说明里的拼写，提个 PR。',
    mentions: [{ key: '@Friday', openId: 'bot', name: 'Friday' }], createTimeMs: Date.now() }
  const publish = async () => { state.script = [{ kind: 'hook', run: () => edit('first edit\n', true) }, { kind: 'text', text: '草稿已提交，正在等检查。' }]
    await host.handleMessage(message)
    expect(registry.taskForMessage('report')?.status).toBe('done')
    expect(registry.db.prepare('SELECT COUNT(*) n FROM github_ci_followups').get()?.n).toBe(1) }
  return { registry, host, changes, preparations, execution, state, provider, fake, current, publish, edit, bare, modelTools, message,
    losePublishResponse: () => { losePublishResponse = true } }
}

describe('real Work CI registration reaches the existing checks MCP output', () => {
  it('returns the existing tracking fact after a real confirmed publication response was lost', async () => {
    const t = await fixture(); let tracking: unknown
    t.state.script = [{ kind: 'hook', run: async () => {
      t.losePublishResponse()
      await expect(t.edit('first edit\n', true)).rejects.toThrow()
      expect(t.registry.db.prepare('SELECT state FROM github_changes').get()?.state).toBe('confirmed')
      await t.modelTools(async call => { const checks = JSON.parse(await call('github_pr_checks', { repo: 'org/demo', number: 1 })); tracking = checks.automatic_followup })
    } }, { kind: 'text', text: '已回读确认草稿，宿主继续跟进检查。' }]
    await t.host.handleMessage(t.message)
    expect(tracking).toMatchObject({ state: 'tracking', note: expect.stringContaining('无需另建定时提醒') })
    expect(t.provider.creates).toBe(1)
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_ci_followups').get()?.n).toBe(1)
  }, 20000)

  it('does not borrow the previous Work registration when a new real request reads the same PR', async () => {
    const t = await fixture(); await t.publish(); let tracking: unknown
    t.state.script = [{ kind: 'hook', run: () => t.modelTools(async call => {
      tracking = JSON.parse(await call('github_pr_checks', { repo: 'org/demo', number: 1 })).automatic_followup
    }) }, { kind: 'text', text: '已核对当前检查。' }]
    await t.host.handleMessage({ ...t.message, eventId: 'another', messageId: 'another', text: '另一个独立任务：只看这个 PR 当前检查。' })
    const first = t.registry.taskForMessage('report')!, second = t.registry.taskForMessage('another')!
    expect(t.registry.taskWork.get(first.id)?.key).not.toBe(t.registry.taskWork.get(second.id)?.key)
    expect(tracking).toMatchObject({ state: 'not_registered' })
    expect(t.provider.creates).toBe(1)
  }, 20000)
})


describe('CI tracking remains optional for legitimate background reads', () => {
  it.each(['routine', 'proactive'] as const)('keeps signed %s checks readable without a task-only tracking call', async kind => {
    const registry = new Registry(':memory:'), attempts = new RunAttempts(registry.db), sp = spaceDeps(registry.db)
    const space = sp.spaces.ensure({ kind: 'group', chatId: 'background-chat', openId: 'alice' })
    const actor = kind === 'routine' ? 'alice' : undefined, sessionKey = `${kind}:synthetic`
    registry.createSession({ sessionKey, chatId: space.chatId!, chatType: 'group', requesterOpenId: actor, cwd: '/tmp/ci-background-fixture' })
    const run = attempts.begin({ sessionKey, workKey: `${kind}:work`, triggerKey: `${kind}:checks`, stage: 'routine', actorOpenId: actor, now: Date.now() })!
    attempts.bindExecutionBoundary(run.id, 'managed_api_v1'); attempts.bindRuntime(run.id, `${kind}:acp`)
    const log = createLogger('ci-background-read', 'error'), fake = new FakeFeishu(), feishu = asFeishuClient(fake)
    const cache = new MessageCache(registry.db), tokens = new TokenIssuer('synthetic-background-signing'), head = 'a'.repeat(40)
    let providerReads = 0, trackingCalls = 0
    const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'synthetic', FRIDAY_GITHUB_REPOS: 'org/demo' })!, log, {
      async request<T>(_method: string, path: string) {
        providerReads++
        if (path === '/repos/org/demo/pulls/1') return { status: 200, data: { state: 'open', head: { sha: head }, html_url: 'https://github.com/org/demo/pull/1' } as T }
        if (path.includes('/check-runs?')) return { status: 200, data: { total_count: 1, check_runs: [{ id: 10, name: 'build', head_sha: head, status: 'completed', conclusion: 'success' }] } as T }
        if (path.includes('/status?')) return { status: 200, data: { total_count: 0, statuses: [] } as T }
        throw new Error('Unexpected provider request')
      },
    })
    const sources = new SourceContexts(registry)
    sources.initialize({ sessionKey, acpSessionId: `${kind}:acp`, spaceId: space.id, chatId: space.chatId! }, [])
    const api = createInternalApi({ registry, ...sp, feishu, github, tokens, log, messageCache: cache,
      memory: new ChannelMemory(registry.db), messages: new MessageService(feishu, cache, log), todos: new Todos(registry.db), maxHistoryPerCall: 20,
      resolveActorForSession: key => key === sessionKey && attempts.isCurrent(run.id) ? { runId: run.id, requesterOpenId: actor, stage: 'routine' } : undefined,
      onRepositoryRead: (key, repo) => sources.addRepository(key, repo),
      repositoryCiTracking: async () => { trackingCalls++; throw new Error('CI tracking requires a real interactive Task') },
    })
    await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done))
    cleanups.push(async () => { api.beginShutdown(); api.server.closeAllConnections(); await new Promise<void>(done => api.server.close(() => done())); registry.close() })
    const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/github/pr/checks`
    const token = tokens.issue({ sessionKey, runId: run.id, requesterOpenId: actor, spaceId: space.id, chatId: space.chatId!, chatType: 'group',
      scopes: kind === 'proactive' ? [...PROACTIVE_SCOPES] : ['github:read'] })
    const post = () => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ repo: 'org/demo', number: 1 }) })
    const response = await post(), result = await response.json()
    expect(response.status).toBe(200)
    expect(result).toMatchObject({ head, status: 'reported_checks_passed', checks: { complete: true }, automatic_followup: { state: 'unavailable', head } })
    expect(trackingCalls).toBe(0)
    expect(sources.get(sessionKey)?.repositories).toEqual(['org/demo'])
    expect(providerReads).toBe(4)
    const call = registry.db.prepare('SELECT scopes_json,state FROM run_api_calls').get()!
    expect(JSON.parse(String(call.scopes_json))).toEqual(['github:read']); expect(call.state).toBe('returned')
    attempts.requestStop(run.id, 'user_requested')
    expect((await post()).status).toBe(403)
    expect(providerReads).toBe(4); expect(trackingCalls).toBe(0)
  })
})
