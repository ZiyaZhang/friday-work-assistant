import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
async function fixture(options: { workspace?: boolean } = {}) {
  let route: 'new_work' | 'amend' = 'new_work'
  let hookFailure: unknown
  const capture = (fn: () => Promise<void>) => async () => { try { await fn() } catch (error) { hookFailure = error; throw error } }
  const assertHook = () => { if (hookFailure) { const error = hookFailure; hookFailure = undefined; throw error } }
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-ci-host-'))), source = join(home, 'source'), bare = join(home, 'remote.git')
  mkdirSync(source); git(source, 'init', '-q'); git(source, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(source, 'README.md'), 'before\n'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'initial')
  git(home, 'clone', '-q', '--bare', source, bare)
  const registry = new Registry(join(home, 'state.sqlite')), log = createLogger('ci-host', 'error')
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home,
    FRIDAY_PUBLIC_MODE: options.workspace ? 'false' : 'true', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '10000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'synthetic-group', openId: 'alice' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake); fake.members.set(space.chatId!, new Set(['alice']))
  const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const todos = new Todos(registry.db), tokens = new TokenIssuer('synthetic-ci-key'), userTokens = new UserTokenStore(registry.db, fake)
  const provider = { conclusion: 'failure', pending: false, unavailable: false, open: true, creates: 0, reads: 0, approvalPending: false }
  const githubConfig = loadGitHubConfig({ GITHUB_TOKEN: 'synthetic-token', FRIDAY_GITHUB_REPOS: 'org/demo', FRIDAY_GITHUB_WRITE_REPOS: 'org/demo' })!
  const github = new GitHubIdentity(githubConfig, log, {
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
  const execution = managedHostRuntime(registry, home, log), state = options.workspace ? execution.workspacePeer.state : execution.peer.state
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, messages, messageCache: cache, userTokens, feishu,
    runtime: execution.runtime, managed: execution.managed, tokens, github, changes, preparations, repositoryAllowed: repo => github.repoAllowed(repo),
    botOpenId: 'bot', log, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', ingressClassifier: { classify: async input => route === 'amend'
      ? { kind: 'amend', targetRef: input.message.replyToRef ?? input.candidates[0]!.ref, contextRefs: [] } : { kind: 'new_work', contextRefs: [] } } })
  const api = createInternalApi({ appId: cfg.feishu.appId, registry, ...sp, memory, todos, messages, messageCache: cache, userTokens, feishu,
    github, changes, preparations, preparationRunSignal: (key, runId) => host.preparationRunSignal(key, runId), tokens, log, maxHistoryPerCall: 20, oauthRedirectUri: cfg.feishu.oauth.redirectUri,
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPublishToRepository: (key, repo) => host.canPublishToRepository(key, repo), onRepositoryRead: (key, repo) => host.noteRepositoryRead(key, repo),
    repositoryCiTracking: (key, runId, input) => host.repositoryCiTracking(key, runId, input),
    repositoryCiControl: (key, runId, input) => host.repositoryCiControl(key, runId, input),
    armRepositoryCi: (key, runId, input) => host.armRepositoryCi(key, runId, input), isManagedRun: id => host.isManagedRun(id) })
  await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  cleanups.push(async () => { api.beginShutdown(); host.beginShutdown(); await execution.runtime.stop(); api.server.closeAllConnections()
    await new Promise<void>(done => api.server.close(() => done())); await host.waitForShutdown(1000); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const current = () => {
    const prompt = [...execution.peer.state.allPrompts, ...execution.workspacePeer.state.allPrompts].findLast(item => {
      const bound=registry.getSessionByAcpId(item.sessionId)
      return bound && host.resolveActorForSession(bound.sessionKey)
    })!
    const session = registry.getSessionByAcpId(prompt.sessionId)!
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
  const publish = async () => { state.script = [{ kind: 'hook', run: capture(() => edit('first edit\n', true)) }, { kind: 'text', text: '草稿已提交，正在等检查。' }]
    await host.handleMessage(message)
    assertHook()
    expect(registry.taskForMessage('report')?.status).toBe('done')
    expect(registry.db.prepare('SELECT COUNT(*) n FROM github_ci_followups').get()?.n).toBe(1) }
  let nextMessage = 0
  const controlInput = () => {
    const change = registry.db.prepare('SELECT id,dir FROM github_changes LIMIT 1').get()!
    const publication = changes.confirmedPublication(String(change.id))!
    return { change_id: publication.changeId, expected_head: publication.head }
  }
  const http = async (path: string, body: Record<string, unknown>, token = current().token) => {
    const response = await fetch(`${base}/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const tokenWith = (scopes: string[]) => {
    const cap = tokens.verify(current().token)!
    return tokens.issue({ ...cap, scopes })
  }
  const withClient = async (fn: (client: Client) => Promise<void>) => {
    const server = buildServer({ apiUrl: base, token: current().token }), client = new Client({ name: 'ci-control-contract', version: '1' })
    const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    try { await fn(client) } finally { await client.close(); await server.close() }
  }
  const human = async (fn: () => Promise<void>, amend = true) => {
    route = amend ? 'amend' : 'new_work'
    const messageId = `human-control-${++nextMessage}`
    state.script = [{kind:'hook',run:capture(fn)},{kind:'text',text:'已按本轮要求处理。'}]
    await host.handleMessage({...message,eventId:messageId,messageId,parentId: amend ? message.messageId : undefined,
      text:amend ? '@Friday 按原要求继续跟进这个 PR，按我说的方式回告。' : '@Friday 这是另一个独立任务：看看该 PR。',createTimeMs:Date.now()})
    assertHook()
    const task = registry.taskForMessage(messageId)
    expect(task, 'control message must reach a real worker').toBeDefined()
    return task!
  }
  const sweep = async (fn: () => Promise<void>) => {
    state.script=[{kind:'hook',run:capture(fn)},{kind:'text',text:'已核对检查结果。'}]
    execution.peer.state.script=state.script; execution.workspacePeer.state.script=state.script
    expect(await host.sweepRepositoryChecks()).toBe(1)
    const task = registry.db.prepare('SELECT event_task_id id FROM github_ci_observations WHERE event_task_id IS NOT NULL ORDER BY rowid DESC LIMIT 1').get()!
    await expect.poll(() => ['done','failed','cancelled'].includes(registry.getTask(Number(task.id))?.status ?? ''),{timeout:8000}).toBe(true)
    assertHook(); expect(registry.getTask(Number(task.id))?.status).toBe('done')
    return registry.getTask(Number(task.id))!
  }
  const lastPolicy = () => {
    const row=registry.db.prepare('SELECT policy_json FROM github_ci_followups ORDER BY instruction_seq DESC,created_at DESC,rowid DESC LIMIT 1').get()
    return row?.policy_json ? JSON.parse(String(row.policy_json)) : null
  }
  return { registry, host, changes, preparations, execution, state, provider, fake, current, publish, edit, bare, modelTools, message,
    http,tokenWith,withClient,human,sweep,controlInput,lastPolicy,space,github,githubConfig }
}

describe('CI completion notification retains real blockers and original anchor',()=>{
  it('omits normal new-head progress, then reports a complete provider stage while human approval remains pending',async()=>{
    const t=await fixture();await t.publish()
    await t.human(async()=>{expect((await t.http('github/pr/followup',{...t.controlInput(),action:'continue',notification:'completion'})).status).toBe(200)})
    const before=t.fake.sent.length,head=t.controlInput().expected_head
    await t.sweep(async()=>{await t.edit('CI repair\n',false)})
    expect(t.controlInput().expected_head).not.toBe(head)
    expect(t.fake.sent.slice(before).filter(item=>item.kind.startsWith('reply'))).toEqual([])
    t.provider.conclusion='success';t.provider.approvalPending=true
    const count=t.fake.sent.length
    const event=await t.sweep(async()=>{})
    expect(t.fake.sent.slice(count).filter(item=>item.kind.startsWith('reply')).length).toBeGreaterThan(0)
    expect(t.fake.sent.slice(count).filter(item=>item.kind.startsWith('reply')).every(item=>item.target==='report')).toBe(true)
    const prompt=JSON.stringify(t.execution.peer.state.allPrompts.at(-1))
    expect(prompt).toContain('automaticFollowup');expect(prompt).toContain('requiresAnotherUserMessage')
    expect(t.registry.getTask(event.id)?.status).toBe('done')
  },20000)
  it('reports a failed check that has no safe repair instead of suppressing the blocker',async()=>{
    const t=await fixture();await t.publish()
    await t.human(async()=>{expect((await t.http('github/pr/followup',{...t.controlInput(),action:'continue',notification:'completion'})).status).toBe(200)})
    const count=t.fake.sent.length
    await t.sweep(async()=>{})
    expect(t.fake.sent.slice(count).some(item=>item.kind.startsWith('reply')&&item.target==='report')).toBe(true)
  },20000)
})
