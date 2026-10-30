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

describe('CI control real MCP, HTTP and host authority', () => {
  it('registers the real strict MCP tool and renews the original Work from a real human request', async () => {
    const t = await fixture(); await t.publish(); let result: any
    const original = t.registry.taskForMessage('report')!
    const task = await t.human(async () => {
      await t.withClient(async client => {
        const tools = await client.listTools(), tool = tools.tools.find(item => item.name === 'github_pr_followup')
        expect(tool).toBeDefined()
        expect(tool!.inputSchema.properties).toHaveProperty('change_id')
        expect(tool!.inputSchema.properties).toHaveProperty('expected_head')
        const response = await client.callTool({name:'github_pr_followup',arguments:{...t.controlInput(),action:'continue',notification:'completion'}})
        expect(response.isError,JSON.stringify(response.content)).not.toBe(true)
        result=JSON.parse((response.content as {text:string}[]).map(item=>item.text).join(''))
        const repeated=await client.callTool({name:'github_pr_followup',arguments:{...t.controlInput(),action:'continue',handling:'preserve',notification:'preserve'}})
        expect(repeated.isError,JSON.stringify(repeated.content)).not.toBe(true)
        expect(JSON.parse((repeated.content as {text:string}[]).map(item=>item.text).join(''))).toEqual(result)
      })
    })
    expect(t.registry.taskWork.get(task.id)?.key).toBe(t.registry.taskWork.get(original.id)?.key)
    expect(result).toMatchObject({state:'tracking',head:t.controlInput().expected_head,policy:{version:1,handling:'repair',notification:'completion',controllerTaskId:task.id}})
    expect(t.lastPolicy()).toMatchObject(result.policy)
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_ci_followups').get()?.n).toBe(2)
    expect(t.provider.creates).toBe(1)
  },20000)

  it('does not let a real CI system Task grant itself a new human repair delegation', async () => {
    const t=await fixture(); await t.publish(); let reply: any, read: any
    const event=await t.sweep(async()=>{
      reply=await t.http('github/pr/followup',{...t.controlInput(),action:'continue',handling:'repair'})
      read=await t.http('github/pr/checks',{repo:'org/demo',number:1})
    })
    expect(reply.status).toBe(403); expect(read.status).toBe(200)
    expect(t.registry.dispatches.get(event.id)?.inbound.senderType).toBe('bot')
    expect(t.registry.db.prepare('SELECT kind FROM task_event_sources WHERE task_id=?').get(event.id)?.kind).toBe('github_ci')
    expect(t.lastPolicy()).toBeNull()
    expect(t.provider.creates).toBe(1)
  },20000)

  it('notify_only is enforced by real write routes even with a signed wider token, while CI reads still work', async()=>{
    const t=await fixture(); await t.publish()
    await t.human(async()=>{const r=await t.http('github/pr/followup',{...t.controlInput(),action:'continue',handling:'notify_only',notification:'actionable'});expect(r.status).toBe(200)})
    expect(t.lastPolicy()).toMatchObject({handling:'notify_only'})
    const denied: number[]=[]; let read: any, advertised: string[]=[]
    const change=t.registry.db.prepare('SELECT * FROM github_changes LIMIT 1').get()!
    const before=git(String(change.dir),'rev-parse','HEAD'), beforeDiff=git(String(change.dir),'diff')
    const beforeBytes=readFileSync(join(String(change.dir),'README.md'))
    await t.sweep(async()=>{
      advertised=tokensScopes(t.current().token)
      read=await t.http('github/change/files/read',{changeId:change.id,path:'README.md',consistency:'snapshot'})
      expect(read.status).toBe(200)
      expect(read.body.snapshot).toMatch(/^[a-f0-9]{40}$/)
      expect(read.body.digest).toMatch(/^[a-f0-9]{64}$/)
      const wide=t.tokenWith([...advertised,'github:write','todo:write'])
      for(const [path,body] of [
        ['github/change/files/edit',{changeId:change.id,path:'README.md',expectedSnapshot:read.body.snapshot,expectedDigest:read.body.digest,oldText:read.body.content,newText:'must not write\n'}],
        ['github/change/update',{dir:change.dir,title:'unauthorized repair',body:'must not publish'}],
        ['github/issue/open',{repo:'org/demo',title:'must not create',body:'system event cannot broaden delegation'}],
        ['github/pr/followup',{...t.controlInput(),action:'continue',handling:'repair'}],
      ] as const) denied.push((await t.http(path,body,wide)).status)
    })
    expect(advertised).toContain('github:read'); expect(advertised).not.toContain('github:write')
    expect(denied).toEqual([403,403,403,403]); expect(git(String(change.dir),'rev-parse','HEAD')).toBe(before)
    expect(git(String(change.dir),'diff')).toBe(beforeDiff); expect(readFileSync(join(String(change.dir),'README.md'))).toEqual(beforeBytes); expect(t.provider.creates).toBe(1)
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_change_updates').get()?.n).toBe(0)
  },20000)

  it('forces a workspace-default publication into a fresh managed runtime for notify_only CI',async()=>{
    const t=await fixture({workspace:true});await t.publish()
    const original=t.registry.taskForMessage('report')!
    const first=t.registry.db.prepare("SELECT execution_boundary,acp_session_id FROM run_attempts WHERE task_id=? AND stage='task'").get(original.id)!
    expect(first.execution_boundary).toBe('workspace');expect(t.execution.peer.state.allPrompts).toHaveLength(0)
    await t.human(async()=>{
      expect(t.host.isManagedRun(t.current().actor.runId)).toBe(false)
      const response=await t.http('github/pr/followup',{...t.controlInput(),action:'continue',handling:'notify_only'})
      expect(response.status).toBe(200)
    })
    const workspacePrompts=t.execution.workspacePeer.state.allPrompts.length
    const event=await t.sweep(async()=>{
      expect(t.host.isManagedRun(t.current().actor.runId)).toBe(true)
      expect(tokensScopes(t.current().token)).not.toContain('github:write')
      expect((await t.http('github/pr/checks',{repo:'org/demo',number:1})).status).toBe(200)
    })
    const resumed=t.registry.db.prepare("SELECT execution_boundary,acp_session_id FROM run_attempts WHERE task_id=? AND stage='task'").get(event.id)!
    expect(resumed.execution_boundary).toBe('managed_api_v1');expect(resumed.acp_session_id).not.toBe(first.acp_session_id)
    expect(t.execution.workspacePeer.state.allPrompts).toHaveLength(workspacePrompts)
    expect(t.execution.peer.state.allPrompts).toHaveLength(1)
    expect(t.provider.creates).toBe(1)
  },20000)

  it('refuses another human Work even in the same group and for the same confirmed PR',async()=>{
    const t=await fixture(); await t.publish(); const original=t.registry.taskForMessage('report')!;let response:any
    const task=await t.human(async()=>{response=await t.http('github/pr/followup',{...t.controlInput(),action:'continue'})},false)
    expect(t.registry.taskWork.get(task.id)?.key).not.toBe(t.registry.taskWork.get(original.id)?.key)
    expect(response.status).toBe(403);expect(t.lastPolicy()).toBeNull()
  },20000)

  it.each(['current_sources','saved_repository'] as const)('allows stop after %s eligibility is lost, but never renews it for continue',async cause=>{
    const t=await fixture();await t.publish();let continued:any,stopped:any
    await t.human(async()=>{
      const current=t.current()
      if(cause==='current_sources'){
        new SourceContexts(t.registry).addRepository(current.session.sessionKey,'org/private-other')
        expect(t.host.canPublishToRepository(current.session.sessionKey,'org/demo')).toBe(false)
      }else{
        t.githubConfig.allowedRepos=['org/other'];expect(t.github.repoAllowed('org/demo')).toBe(false)
      }
      continued=await t.http('github/pr/followup',{...t.controlInput(),action:'continue'})
      stopped=await t.http('github/pr/followup',{...t.controlInput(),action:'stop'})
    })
    expect(continued.status).toBe(403);expect(stopped.status).toBe(200)
    expect(stopped.body).toMatchObject({state:'stopped',policy:{stopped:true}})
    expect(t.lastPolicy()).toMatchObject({stopped:true});expect(await t.host.sweepRepositoryChecks()).toBe(0)
    expect(t.provider.creates).toBe(1)
  },20000)

  it('does not borrow repository write scope from a read or proactive capability',async()=>{
    const t=await fixture();await t.publish();const statuses:number[]=[]
    await t.human(async()=>{
      for(const scopes of [['github:read'],[...PROACTIVE_SCOPES]])for(const action of ['continue','stop']){
        statuses.push((await t.http('github/pr/followup',{...t.controlInput(),action},t.tokenWith(scopes))).status)
      }
    })
    expect(statuses).toEqual([403,403,403,403]);expect(t.lastPolicy()).toBeNull()
  },20000)

  it('does not turn read-allowlisted repositories into a new write delegation',async()=>{
    const t=await fixture();await t.publish();let response:any
    await t.human(async()=>{
      t.githubConfig.writableRepos=[]
      expect(t.github.repoAllowed('org/demo')).toBe(true);expect(t.github.repoWritable('org/demo')).toBe(false)
      response=await t.http('github/pr/followup',{...t.controlInput(),action:'continue',handling:'repair'})
    })
    expect(response.status).toBe(403);expect(t.lastPolicy()).toBeNull();expect(t.provider.creates).toBe(1)
  },20000)

  it('rejects a signed token from the completed real human Run',async()=>{
    const t=await fixture();await t.publish();let oldToken=''
    await t.human(async()=>{oldToken=t.current().token})
    for(const action of ['continue','stop'])expect((await t.http('github/pr/followup',{...t.controlInput(),action},oldToken)).status).toBe(403)
    expect(t.lastPolicy()).toBeNull();expect(t.provider.creates).toBe(1)
  },20000)

  it('enforces both strict schemas and expected head without mutating the existing followup',async()=>{
    const t=await fixture();await t.publish();const statuses:number[]=[];let malformedMcp:any
    await t.human(async()=>{
      const valid={...t.controlInput(),action:'continue'}
      for(const extra of [{repo:'org/other'},{actor:'bob'},{url:'https://example.test'},{changeId:valid.change_id},{notification:'always'}]){
        statuses.push((await t.http('github/pr/followup',{...valid,...extra})).status)
      }
      const stale=await t.http('github/pr/followup',{...valid,expected_head:'f'.repeat(40)})
      expect([403,409]).toContain(stale.status)
      await t.withClient(async client=>{malformedMcp=await client.callTool({name:'github_pr_followup',arguments:{...valid,actor:'bob'}})})
    })
    expect(statuses).toEqual([400,400,400,400,400]);expect(malformedMcp.isError).toBe(true);expect(t.lastPolicy()).toBeNull()
  },20000)
})
function tokensScopes(token:string):string[]{return JSON.parse(Buffer.from(token.slice(0,token.lastIndexOf('.')),'base64url').toString('utf8')).scopes}
