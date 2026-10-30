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
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { SourceContexts } from '../src/core/source-context.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { ChangeManager } from '../src/github/changes.js'
import { GitHubIdentity, loadGitHubConfig } from '../src/github/identity.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
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
async function fixture(threaded = false) {
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
  const hooks = { beforeRead: undefined as ((path: string) => Promise<void>) | undefined }
  const provider = { conclusion: 'failure', pending: false, unavailable: false, open: true, creates: 0, reads: 0 }
  const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'synthetic-token', FRIDAY_GITHUB_REPOS: 'org/demo', FRIDAY_GITHUB_WRITE_REPOS: 'org/demo' })!, log, {
    async request(method, path) {
      if (method === 'GET') await hooks.beforeRead?.(path)
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
      if (path.includes('/status?')) return { status: 200, data: { total_count: 0, statuses: [] } as never }
      return { status: 404, data: {} as never }
    },
  })
  const changes = new ChangeManager({ db: registry.db, github, cacheDir: join(home, 'cache'), log, remoteUrlFor: () => `file://${bare}`, createPullRequests: true })
  const execution = managedHostRuntime(registry, home, log), state = execution.peer.state
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, messages, messageCache: cache, userTokens, feishu,
    runtime: execution.runtime, managed: execution.managed, tokens, github, changes, repositoryAllowed: repo => github.repoAllowed(repo),
    botOpenId: 'bot', log, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', ingressClassifier: { classify: async () => ({ kind: 'new_work' }) } })
  const api = createInternalApi({ appId: cfg.feishu.appId, registry, ...sp, memory, todos, messages, messageCache: cache, userTokens, feishu,
    github, changes, tokens, log, maxHistoryPerCall: 20, oauthRedirectUri: cfg.feishu.oauth.redirectUri,
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPublishToRepository: (key, repo) => host.canPublishToRepository(key, repo), onRepositoryRead: (key, repo) => host.noteRepositoryRead(key, repo),
    armRepositoryCi: (key, runId, input) => host.armRepositoryCi(key, runId, input), isManagedRun: id => host.isManagedRun(id) })
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
    if (first) await call('github_start_change', { repo: 'org/demo', base: 'main', branch_hint: 'test-ci' })
    const change = registry.db.prepare('SELECT * FROM github_changes LIMIT 1').get()!
    const file = JSON.parse(await call('github_read_change_file', { changeId: change.id, path: 'README.md', consistency: 'snapshot' }))
    await call('github_write_change_file', { changeId: change.id, path: 'README.md', expectedSnapshot: file.snapshot, expectedDigest: file.digest, content })
    await call(first ? 'github_open_pr' : 'github_update_pr', { dir: change.dir, title: 'test: CI continuation', body: 'Synthetic independent review fixture; validation pending.' })
  })
  const message: InboundMessage = { eventId: 'report', messageId: 'report', chatId: space.chatId!, chatType: 'group', senderOpenId: 'alice',
    senderType: 'user', tenantId: 'tenant', ...(threaded ? { threadId: 'real-thread', rootId: 'report', parentId: 'parent-human' } : {}), msgType: 'text', text: '@Friday 修正说明里的拼写，提个 PR。',
    mentions: [{ key: '@Friday', openId: 'bot', name: 'Friday' }], createTimeMs: Date.now() }
  const publish = async () => { state.script = [{ kind: 'hook', run: () => edit('first edit\n', true) }, { kind: 'text', text: '草稿已提交，正在等检查。' }]
    await host.handleMessage(message)
    expect(registry.taskForMessage('report')?.status).toBe('done')
    expect(registry.db.prepare('SELECT COUNT(*) n FROM github_ci_followups').get()?.n).toBe(1) }
  return { registry, host, changes, execution, state, provider, fake, current, publish, edit, bare, hooks, cfg, sp, space, message, api, base, modelTools }
}

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function sourceTask(t: Awaited<ReturnType<typeof fixture>>) { return t.registry.taskForMessage('report')! }
function workKey(t: Awaited<ReturnType<typeof fixture>>) { return t.registry.taskWork.get(sourceTask(t).id)!.key }
function eventId(t: Awaited<ReturnType<typeof fixture>>) { return Number(t.registry.db.prepare('SELECT event_task_id id FROM github_ci_followups WHERE event_task_id IS NOT NULL ORDER BY rowid DESC LIMIT 1').get()!.id) }
function cancelWork(t: Awaited<ReturnType<typeof fixture>>) {
  const result = t.host.persistHumanWorkCancel({ actorOpenId: 'alice', spaceId: t.space.id, workKey: workKey(t),
    assertCurrent: () => t.sp.spaces.get(t.space.id)! })
  result.afterCommit(); return result
}
const terminal = (t: Awaited<ReturnType<typeof fixture>>, id: number) => expect.poll(() => t.registry.getTask(id)?.status, { timeout: 8000 }).not.toMatch(/queued|running/)

describe('independent CI host review boundaries', () => {
  it('keeps first publication and a new repaired head waiting, with no DONE reaction or synthetic message reaction', async () => {
    const t = await fixture(); t.provider.pending = true; await t.publish()
    expect(t.host.githubCi!.waitingForWork(workKey(t))).toBe(true)
    expect(t.fake.reactionLog.some(item => item.op === 'add' && item.emoji === t.cfg.feishu.reactions.done)).toBe(false)
    t.provider.pending = false
    t.state.script = [{ kind: 'hook', run: async () => { await t.edit('second revision\n', false); t.provider.pending = true } },
      { kind: 'text', text: '已更新，等待新提交的检查。' }]
    expect(await t.host.sweepRepositoryChecks()).toBe(1)
    await terminal(t, eventId(t))
    expect(t.registry.getTask(eventId(t))?.status).toBe('done')
    expect(t.host.githubCi!.waitingForWork(workKey(t))).toBe(true)
    expect(await t.host.sweepRepositoryChecks()).toBe(0)
    expect(t.registry.listTasks(sourceTask(t).sessionKey)).toHaveLength(2)
    expect(t.fake.reactionLog.some(item => item.messageId.startsWith('host-event:'))).toBe(false)
    expect(t.fake.reactionLog.some(item => item.op === 'add' && item.emoji === t.cfg.feishu.reactions.done)).toBe(false)
  }, 20000)

  it('uses the real original threaded message for all bot followup replies', async () => {
    const t = await fixture(true); await t.publish()
    t.provider.conclusion = 'success'; t.state.script = [{ kind: 'text', text: '已核对当前提交的检查，视觉结果仍需确认。' }]
    const before = t.fake.sent.length
    expect(await t.host.sweepRepositoryChecks()).toBe(1); await terminal(t, eventId(t))
    const replies = t.fake.sent.slice(before).filter(item => item.kind.startsWith('reply'))
    expect(replies.length).toBeGreaterThan(0)
    expect(replies.every(item => item.target === 'report' && item.replyInThread === false)).toBe(true)
    expect(t.fake.sent.slice(before).some(item => item.kind === 'sendToChat' || item.target.startsWith('host-event:'))).toBe(false)
    expect(t.execution.workspacePeer.state.allPrompts).toHaveLength(0)
  })

  it('does not admit an event after a real human Work cancellation during GitHub checks I/O', async () => {
    const t = await fixture(); await t.publish()
    const entered = deferred(), release = deferred(), before = t.state.allPrompts.length, sent = t.fake.sent.length
    t.hooks.beforeRead = async path => { if (path.includes('/check-runs?')) { entered.resolve(); await release.promise } }
    const sweep = t.host.sweepRepositoryChecks()
    try { await entered.promise; expect(cancelWork(t).result).toBe('cancelled') } finally { release.resolve() }
    expect(await sweep).toBe(0)
    expect(t.registry.workContexts.get(workKey(t))?.lifecycle).toBe('cancelled')
    expect(t.registry.listTasks(sourceTask(t).sessionKey)).toHaveLength(1)
    expect(t.state.allPrompts).toHaveLength(before); expect(t.fake.sent).toHaveLength(sent)
  })

  it.each([1, 2])('rechecks group membership at admission boundary %s without starting a model on revocation', async boundary => {
    const t = await fixture(); await t.publish()
    const wake = t.host.wakeQueuedTask.bind(t.host); t.host.wakeQueuedTask = () => {}
    await t.host.sweepRepositoryChecks(); const id = eventId(t), before = t.state.allPrompts.length, sent = t.fake.sent.length
    const originalMembers = t.fake.chatMemberOpenIds.bind(t.fake), entered = deferred(), release = deferred()
    let checks = 0
    t.fake.chatMemberOpenIds = async (...args) => {
      if (++checks === boundary) { entered.resolve(); await release.promise }
      return originalMembers(...args)
    }
    wake(id)
    try { await entered.promise; t.fake.members.set(t.space.chatId!, new Set()) } finally { release.resolve() }
    if (boundary === 1) {
      await expect.poll(() => t.registry.getTask(id)?.status).toBe('cancelled')
      expect(t.registry.getTask(id)?.stopReason).toBe('access_changed')
    } else {
      await expect.poll(() => t.registry.getTask(id)?.error).toContain('等待重新核对')
      expect(t.registry.getTask(id)?.status).toBe('queued')
    }
    expect(t.state.allPrompts).toHaveLength(before); expect(t.fake.sent).toHaveLength(sent)
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM run_attempts WHERE task_id=?').get(id)?.n).toBe(0)
  })

  it('does not let an own-publication handoff bypass a human stop or push another commit', async () => {
    const t = await fixture(); await t.publish()
    const id = String(t.registry.db.prepare('SELECT id FROM github_changes').get()!.id), first = t.changes.confirmedPublication(id)!
    const originalArm = t.host.armRepositoryCi.bind(t.host), armed = deferred()
    t.host.armRepositoryCi = (...args) => { originalArm(...args); cancelWork(t); armed.resolve() }
    t.state.script = [{ kind: 'hook', run: async () => {
      await expect(t.edit('must not publish after stop\n', false)).rejects.toThrow()
    } }, { kind: 'text', text: 'THIS MUST NEVER BE DELIVERED AFTER STOP' }]
    expect(await t.host.sweepRepositoryChecks()).toBe(1)
    await armed.promise; const event = eventId(t); await terminal(t, event)
    expect(t.registry.getTask(event)?.status).toBe('cancelled')
    expect(t.registry.workContexts.get(workKey(t))?.lifecycle).toBe('cancelled')
    expect(t.changes.confirmedPublication(id)?.head).toBe(first.head)
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_change_updates').get()?.n).toBe(0)
    expect(t.fake.answers().join('\n')).not.toContain('THIS MUST NEVER')
    expect(await t.host.sweepRepositoryChecks()).toBe(0)
    expect(t.provider.creates).toBe(1)
  }, 20000)

  it('does not send or mutate after a live CI Run loses its original source-space permission', async () => {
    const t = await fixture(); await t.publish()
    const before = t.fake.sent.length, entered = deferred(), release = deferred()
    t.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } },
      { kind: 'text', text: 'PRIVATE LATE CI RESULT' }]
    expect(await t.host.sweepRepositoryChecks()).toBe(1)
    try { await entered.promise; t.sp.spaces.suspend(t.space.id) } finally { release.resolve() }
    await terminal(t, eventId(t))
    expect(t.fake.sent).toHaveLength(before)
    expect(t.registry.getTask(eventId(t))?.status).not.toBe('done')
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_change_updates').get()?.n).toBe(0)
    expect(t.execution.workspacePeer.state.allPrompts).toHaveLength(0)
  })
})
