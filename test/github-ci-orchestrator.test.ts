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
import { ChangePreparationOperations } from '../src/github/preparation-operations.js'
import { duePreparationRecovery } from '../src/core/local-preparation-recovery.js'
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
  return { registry, host, changes, preparations, execution, state, provider, fake, current, publish, edit, bare, modelTools, message }
}

describe('repository CI resumes the original worker through the real host', () => {
  it('keeps the verified PR link on a read-only CI Run when the model omits it', async () => {
    const t = await fixture(); await t.publish()
    const original = t.registry.taskForMessage('report')!, before = t.fake.answers().length
    t.provider.conclusion = 'success'
    t.state.script = [{ kind: 'hook', run: () => t.modelTools(async call => {
      await call('github_pr_checks', { repo: 'org/demo', number: 1 })
    }) }, { kind: 'text', text: '构建已通过；页面验收尚未完成，仍保留草稿。' }]
    expect(await t.host.sweepRepositoryChecks()).toBe(1)
    const eventTaskId = Number(t.registry.db.prepare('SELECT event_task_id id FROM github_ci_followups').get()!.id)
    await expect.poll(() => t.registry.getTask(eventTaskId)?.status, { timeout: 8000 }).toBe('done')
    const eventTask = t.registry.getTask(eventTaskId)!
    expect(eventTask.id).not.toBe(original.id)
    const calls = t.registry.db.prepare(`SELECT route FROM run_api_calls WHERE run_id IN
      (SELECT id FROM run_attempts WHERE task_id=?)`).all(eventTask.id)
    expect(calls).toEqual([{ route: 'POST /v1/github/pr/checks' }])
    expect(t.provider.creates).toBe(1)
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_change_updates').get()?.n).toBe(0)
    expect(t.fake.answers().slice(before)).toEqual([
      '已确认 [org/demo PR #1](https://github.com/org/demo/pull/1)。\n构建已通过；页面验收尚未完成，仍保留草稿。',
    ])
    expect(t.fake.sent.filter(item => item.kind.startsWith('reply')).every(item => item.target === 'report')).toBe(true)
  }, 20000)

  it('does not call the task completed when the worker ends before consuming its prepared result', async () => {
    const t = await fixture()
    t.state.script = [{ kind: 'hook', run: () => t.modelTools(async call => {
      const receipt = JSON.parse(await call('github_start_change', { repo: 'org/demo', base: 'main' }))
      expect(receipt.preparation.state).toBe('preparing')
    }) }, { kind: 'text', text: '已经全部修好并提交 PR。' }]
    await t.host.handleMessage(t.message)
    const task = t.registry.taskForMessage('report')!
    const run = t.registry.db.prepare('SELECT * FROM run_attempts WHERE task_id=? AND stage=?').get(task.id, 'task')!
    expect(JSON.parse(String(run.result_json))).toMatchObject({ outcome: 'partial', reason: 'operation_incomplete' })
    expect(t.registry.db.prepare('SELECT state FROM github_change_preparations').get()?.state).toBe('prepared')
    expect(t.preparations.pendingForRun(String(run.id))).toBe(0)
    expect(duePreparationRecovery(t.registry.db, Date.now() + 31_000, 2)).toEqual([{ taskId: task.id, runId: run.id }])
    expect(JSON.stringify(t.fake.sent)).not.toContain('已经全部修好并提交 PR。')
    expect(t.provider.creates).toBe(0)
  })

  it('publishes, repairs failed CI in the same PR, then verifies the next head and replies to the original human message', async () => {
    const t = await fixture(); t.provider.approvalPending = true; await t.publish()
    const original = t.registry.taskForMessage('report')!, workKey = t.registry.taskWork.get(original.id)!.key
    const firstHead = t.changes.confirmedPublication(String(t.registry.db.prepare('SELECT id FROM github_changes').get()!.id))!.head
    t.state.script = [{ kind: 'hook', run: async () => {
      expect(t.registry.taskWork.get(t.current().actor.taskId!)?.key).toBe(workKey)
      expect(new SourceContexts(t.registry).get(t.current().session.sessionKey)?.repositories).toContain('org/demo')
      await t.edit('second edit\n', false)
    } }, { kind: 'text', text: '同一个 PR 已追加修正，继续等待检查。' }]
    expect(await t.host.sweepRepositoryChecks()).toBe(1)
    await expect.poll(() => t.registry.db.prepare("SELECT COUNT(*) n FROM github_change_updates WHERE state='confirmed'").get()?.n, { timeout: 8000 }).toBe(1)
    await expect.poll(() => t.registry.listTasks(original.sessionKey)[0]?.status, { timeout: 8000 }).toBe('done')
    const second = t.changes.confirmedPublication(String(t.registry.db.prepare('SELECT id FROM github_changes').get()!.id))!
    expect(second.head).not.toBe(firstHead); expect(t.provider.creates).toBe(1)
    t.provider.conclusion = 'success'; t.state.script = [{ kind: 'text', text: '构建已通过；审批仍在等待，还需要页面验收。' }]
    expect(await t.host.sweepRepositoryChecks()).toBe(1)
    await expect.poll(() => t.registry.listTasks(original.sessionKey)[0]?.status, { timeout: 8000 }).toBe('done')
    expect(await t.host.sweepRepositoryChecks()).toBe(0)
    expect(t.registry.db.prepare('SELECT conclusion FROM github_ci_followups WHERE head=?').get(second.head)?.conclusion).toBe('checks_partially_completed')
    expect(t.registry.listTasks(original.sessionKey)).toHaveLength(3)
    expect(t.fake.sent.filter(item => item.kind.startsWith('reply')).every(item => item.target === 'report')).toBe(true)
    expect(t.execution.workspacePeer.state.allPrompts).toHaveLength(0)
  }, 20000)

  it('keeps a temporarily unreadable CI event queued and supplies fresh same-head rerun evidence when resumed', async () => {
    const t = await fixture(); await t.publish()
    // Keep the durable event queued while simulating a lost in-process wake.
    const wake = t.host.wakeQueuedTask.bind(t.host); t.host.wakeQueuedTask = () => {}
    expect(await t.host.sweepRepositoryChecks()).toBe(1)
    const event = t.registry.db.prepare('SELECT event_task_id id FROM github_ci_followups').get()!
    t.provider.unavailable = true; wake(Number(event.id))
    await expect.poll(() => t.registry.getTask(Number(event.id))?.error).toContain('等待重新核对')
    expect(t.registry.getTask(Number(event.id))?.status).toBe('queued')
    t.provider.unavailable = false; t.provider.conclusion = 'success'; t.host.wakeQueuedTask = wake
    t.state.script = [{ kind: 'text', text: '已核对本次重跑结果。' }]
    await t.host.sweepRepositoryChecks()
    await expect.poll(() => t.registry.getTask(Number(event.id))?.status).toBe('done')
    expect(JSON.stringify(t.state.allPrompts.at(-1))).toContain('reported_checks_passed')
    expect(JSON.stringify(t.state.allPrompts.at(-1))).toContain('不为旧失败重复修改')
  })
})
