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
import { UserTokenStore } from '../src/feishu/oauth.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { ChangeManager } from '../src/github/changes.js'
import { ChangePreparationOperations } from '../src/github/preparation-operations.js'
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
  let route: 'new_work' | 'amend' | 'stop' | 'progress' = 'new_work'
  let beforeChecks: (() => Promise<void>) | undefined
  let beforeStopClassification: (() => Promise<void>) | undefined
  let hookFailure: unknown
  const capture = (fn: () => Promise<void>) => async () => { try { await fn() } catch (error) { hookFailure = error; throw error } }
  const assertHook = () => { if (hookFailure) { const error = hookFailure; hookFailure = undefined; throw error } }
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
        await beforeChecks?.()
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
    botOpenId: 'bot', log, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', ingressClassifier: { classify: async input => {
      const kind = route
      if (kind === 'stop') await beforeStopClassification?.()
      return kind === 'new_work' ? { kind, contextRefs: [] }
        : { kind, targetRef: input.message.replyToRef ?? input.candidates[0]!.ref, ...(kind === 'amend' ? { contextRefs: [] } : {}) }
    } }  })
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
  const naturalControl = async (kind: 'stop' | 'progress', messageId: string, senderOpenId = 'alice') => {
    route = kind
    state.script = [{ kind: 'text', text: '这是独立的新请求，未更改其他人的工作。' }]
    await host.handleMessage({ ...message, eventId: messageId, messageId, parentId: message.messageId, senderOpenId,
      text: kind === 'stop' ? '@Friday 先停下来，别再继续检查或修改了。' : '@Friday 这件事现在什么进展？', createTimeMs: Date.now() })
    assertHook()
  }
  const latestArm = () => registry.db.prepare('SELECT * FROM github_ci_followups ORDER BY instruction_seq DESC,created_at DESC,rowid DESC LIMIT 1').get()!
  const work = () => registry.workContexts.get(registry.taskWork.get(registry.taskForMessage('report')!.id)!.key)!
  const armCompletion = () => human(() => modelTools(async call => {
    expect(JSON.parse(await call('github_pr_followup', { ...controlInput(), action: 'continue', handling: 'repair', notification: 'completion' })))
      .toMatchObject({ state: 'tracking', policy: { handling: 'repair', notification: 'completion' } })
  }))
  return { registry, host, execution, state, provider, fake, publish, modelTools, message, human, sweep, controlInput,
    naturalControl, latestArm, work, armCompletion, githubConfig, current, base, capture, assertHook,
    blockStopClassification: (hook?: () => Promise<void>) => { beforeStopClassification = hook }, blockChecks: (hook?: () => Promise<void>) => { beforeChecks = hook } }
}

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

describe('natural stop and resume own durable CI delegation after its Run ended', () => {
  it('stops an active CI arm even though the selected human Task and Run are already complete', async () => {
    const t = await fixture(); await t.publish(); const controller = await t.armCompletion()
    expect(t.registry.getTask(controller.id)?.status).toBe('done')
    expect(t.registry.db.prepare("SELECT COUNT(*) n FROM run_attempts WHERE state IN ('running','stop_requested')").get()?.n).toBe(0)
    const before = t.work(), arm = t.latestArm(), prompts = t.state.allPrompts.length
    const originalAttempt = t.registry.db.prepare('SELECT * FROM run_attempts WHERE task_id=?').get(controller.id)
    await t.naturalControl('stop', 'natural-stop')
    expect(t.work().pauseReasons.map(item => item.reason)).toContain('run_stop')
    expect(t.work().controlEpoch).toBeGreaterThan(before.controlEpoch)
    expect(t.registry.getTask(controller.id)?.status).toBe('done') // History stays true: no retroactive Run cancellation.
    expect(t.registry.db.prepare('SELECT * FROM run_attempts WHERE task_id=?').get(controller.id)).toEqual(originalAttempt)
    expect(t.registry.taskForMessage('natural-stop')).toBeUndefined()
    expect(t.state.allPrompts.length).toBe(prompts)
    expect(await t.host.sweepRepositoryChecks()).toBe(0)
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_ci_observations WHERE event_task_id IS NOT NULL').get()?.n).toBe(0)
    const receipt = t.fake.sent.find(item => item.target === 'natural-stop' && item.kind === 'replyText')
    expect(receipt?.payload).toContain('停止')
    expect(receipt?.payload).not.toContain('检查结束后继续')
    const stoppedEpoch = t.work().controlEpoch
    await t.naturalControl('stop', 'natural-stop') // Exact duplicate is not a second control action.
    expect(t.work().controlEpoch).toBe(stoppedEpoch)
    await t.naturalControl('stop', 'second-natural-stop')
    expect(t.work().controlEpoch).toBe(stoppedEpoch)
    expect(t.latestArm().id).toBe(arm.id) // Stop need not invent a human model Run or overwrite publication proof.
  }, 20000)

  it('drops a late poll from the old epoch and renews only after a new explicit human resume through MCP', async () => {
    const t = await fixture(); await t.publish(); await t.armCompletion()
    const originalWork = t.work(), oldArm = t.latestArm(), entered = deferred(), release = deferred()
    t.blockChecks(async () => { entered.resolve(); await release.promise })
    const poll = t.host.sweepRepositoryChecks()
    try {
      await entered.promise
      await t.naturalControl('stop', 'stop-during-poll')
      expect(t.work().controlEpoch).toBeGreaterThan(originalWork.controlEpoch)
      release.resolve()
      expect(await poll).toBe(0)
      expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_ci_observations WHERE event_task_id IS NOT NULL').get()?.n).toBe(0)
    } finally { release.resolve(); await poll; t.blockChecks() }
    const stoppedEpoch = t.work().controlEpoch
    await t.naturalControl('progress', 'progress-is-not-resume')
    expect(t.work().controlEpoch).toBe(stoppedEpoch)
    expect(t.work().pauseReasons.map(item => item.reason)).toContain('run_stop')
    expect(await t.host.sweepRepositoryChecks()).toBe(0)
    const humanResumed = await t.human(async () => {})
    expect(t.registry.taskWork.get(humanResumed.id)?.key).toBe(originalWork.workKey)
    expect(t.work().pauseReasons).toEqual([])
    expect(await t.host.sweepRepositoryChecks()).toBe(0) // A human input alone cannot re-arm old CI authority.
    expect(t.latestArm().id).toBe(oldArm.id)
    const resumed = await t.armCompletion()
    expect(t.registry.taskWork.get(resumed.id)?.key).toBe(originalWork.workKey)
    expect(t.work().pauseReasons).toEqual([])
    expect(t.latestArm().id).not.toBe(oldArm.id)
    expect(Number(t.latestArm().control_epoch)).toBe(t.work().controlEpoch)
    expect(t.registry.db.prepare('SELECT control_epoch FROM github_ci_followups WHERE id=?').get(String(oldArm.id))?.control_epoch).toBe(oldArm.control_epoch)
    const event = await t.sweep(() => t.modelTools(async call => {
      expect(JSON.parse(await call('github_pr_checks', { repo: 'org/demo', number: 1 }))).toMatchObject({ status: 'failed' })
    }))
    expect(t.registry.taskWork.get(event.id)?.key).toBe(originalWork.workKey)
    expect(t.registry.db.prepare('SELECT followup_id FROM github_ci_observations WHERE event_task_id=?').get(event.id)?.followup_id).toBe(t.latestArm().id)
    expect(t.provider.creates).toBe(1)
  }, 20000)

  it('does not let new CI evidence arriving during stop classification outrun the human stop', async () => {
    const t = await fixture(); await t.publish(); await t.armCompletion()
    const classifierEntered = deferred(), classifierRelease = deferred(), workerEntered = deferred(), workerRelease = deferred()
    const initial = t.work()
    t.blockStopClassification(async () => { classifierEntered.resolve(); await classifierRelease.promise })
    const stop = t.naturalControl('stop', 'stop-before-new-ci-evidence')
    let writeStatus: number | undefined, contentBefore = '', contentAfter = ''
    let eventId = 0
    try {
      await classifierEntered.promise
      t.state.script = [{ kind: 'hook', run: t.capture(async () => {
        const token = t.current().token
        const change = t.registry.db.prepare('SELECT id,dir FROM github_changes LIMIT 1').get()!
        await t.modelTools(async call => {
          const value = JSON.parse(await call('github_read_change_file', { changeId: String(change.id), path: 'README.md', consistency: 'snapshot' }))
          contentBefore = readFileSync(join(String(change.dir), 'README.md'), 'utf8')
          workerEntered.resolve(); await workerRelease.promise
          const response = await fetch(`${t.base}/v1/github/change/files/edit`, { method: 'POST', headers: {
            authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ changeId: change.id,
            path: 'README.md', expectedSnapshot: value.snapshot, expectedDigest: value.digest, oldText: value.content, newText: 'forbidden late edit\n' }) })
          writeStatus = response.status
          contentAfter = readFileSync(join(String(change.dir), 'README.md'), 'utf8')
        })
      }) }, { kind: 'text', text: '不应作为停止后的结果发出。' }]
      expect(await t.host.sweepRepositoryChecks()).toBe(1)
      await workerEntered.promise
      eventId = Number(t.registry.db.prepare('SELECT event_task_id id FROM github_ci_observations WHERE event_task_id IS NOT NULL ORDER BY rowid DESC LIMIT 1').get()!.id)
      expect(t.registry.dispatches.get(eventId)?.inbound.senderType).toBe('bot')
      expect(t.work().controlEpoch).toBe(initial.controlEpoch)
      classifierRelease.resolve(); await stop
      expect(t.work().pauseReasons.map(item => item.reason)).toContain('run_stop')
      expect(t.work().controlEpoch).toBeGreaterThan(initial.controlEpoch)
    } finally {
      classifierRelease.resolve(); workerRelease.resolve(); await stop
      if (eventId) await expect.poll(() => ['done', 'failed', 'cancelled'].includes(t.registry.getTask(eventId)?.status ?? ''), { timeout: 8000 }).toBe(true)
      t.blockStopClassification()
    }
    t.assertHook()
    await expect.poll(() => writeStatus, { timeout: 8000 }).toBe(403)
    expect(contentAfter).toBe(contentBefore)
    expect(t.fake.answers()).not.toContain('不应作为停止后的结果发出。')
    expect(await t.host.sweepRepositoryChecks()).toBe(0)
  }, 20000)

  it('can stop the original Work after repository read access was revoked', async () => {
    const t = await fixture(); await t.publish(); await t.armCompletion()
    const epoch = t.work().controlEpoch, prompts = t.state.allPrompts.length
    t.githubConfig.allowedRepos = ['org/other']
    await t.naturalControl('stop', 'stop-without-repository-access')
    expect(t.work().controlEpoch).toBeGreaterThan(epoch)
    expect(t.work().pauseReasons.map(item => item.reason)).toContain('run_stop')
    expect(t.state.allPrompts).toHaveLength(prompts)
    expect(await t.host.sweepRepositoryChecks()).toBe(0)
  }, 20000)

  it('does not allow another group member to stop the original owner delegation', async () => {
    const t = await fixture(); await t.publish(); await t.armCompletion()
    t.fake.members.get(t.message.chatId)!.add('bob')
    const before = t.work(), arm = t.latestArm()
    await t.naturalControl('stop', 'other-person-stop', 'bob')
    expect(t.work().controlEpoch).toBe(before.controlEpoch)
    expect(t.work().pauseReasons).toEqual(before.pauseReasons)
    expect(t.latestArm().id).toBe(arm.id)
  }, 20000)
})
