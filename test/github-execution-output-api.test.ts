import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { ChangeManager, ChangeSnapshotError } from '../src/github/changes.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { RepositoryExecutions, RepositoryExecutionSnapshotChanged } from '../src/github/executions.js'
import { RepositoryExecutionOutputs } from '../src/github/execution-output.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { GENERATED, startExecutorProvider } from './helpers/executor-provider.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: {
    PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test',
  } }).trim()
}

/** MCP tool → internal HTTP API (real routes, capability, Work/Run checks) →
 * executor client → provider HTTP service → runner with the Docker CLI fixture. */
async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-output-api-'))), source = join(home, 'source'), bare = join(home, 'remote.git')
  const cwd = join(home, 'workspace')
  mkdirSync(join(source, 'docs'), { recursive: true }); mkdirSync(cwd)
  git(source, 'init', '-q'); git(source, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(source, 'README.md'), 'original\n')
  writeFileSync(join(source, 'docs', 'a.i18n.yaml'), GENERATED.before.a); writeFileSync(join(source, 'docs', 'b.i18n.yaml'), GENERATED.before.b)
  git(source, 'add', '-A'); git(source, 'commit', '-qm', 'initial'); git(home, 'clone', '--bare', '--quiet', source, bare)
  const registry = new Registry(join(home, 'registry.db')), sp = spaceDeps(registry.db), log = createLogger('execution-output-api', 'error')
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', requesterOpenId: 'alice', cwd })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', requesterOpenId: 'alice', messageId: 'om_original', prompt: '重新生成翻译记录并更新 PR' }).task
  const run = new RunAttempts(registry.db).begin({ workKey: registry.taskWork.get(task.id)!.key,
    sessionKey: task.sessionKey, taskId: task.id, actorOpenId: 'alice', triggerKey: `task:${task.id}`, stage: 'task', now: Date.now() })!
  const state = { active: true, allowed: true, branch: '', posts: 0, fail: undefined as undefined | ((index: number) => void) }
  const pr = () => ({ number: 7, html_url: 'https://github.com/org/demo/pull/7', title: 'Original PR', body: 'Original body', state: 'open', draft: true,
    merged: false, head: { ref: state.branch, sha: git(bare, 'rev-parse', state.branch), repo: { full_name: 'org/demo' } },
    base: { ref: 'main', sha: git(bare, 'rev-parse', 'main'), repo: { full_name: 'org/demo' } } })
  const github = { repoAllowed: (repo: string) => repo === 'org/demo', repoWritable: (repo: string) => repo === 'org/demo', defaultRepo: () => 'org/demo',
    async api(method: string, path: string, body?: Record<string, unknown>, _owner?: string, beforeRequest?: () => void) {
      beforeRequest?.()
      if (method === 'POST' && path.endsWith('/pulls')) { state.posts++; state.branch = String(body!.head); return pr() }
      if (method !== 'GET') throw new Error(`Unexpected write: ${method} ${path}`)
      if (path.includes('/pulls?')) return state.posts ? [pr()] : []
      if (path.endsWith('/pulls/7')) return pr()
      throw new Error(`Unexpected read: ${path}`)
    } } as unknown as GitHubIdentity
  const changes = new ChangeManager({ db: registry.db, cacheDir: join(home, 'gateway'), github, log,
    remoteUrlFor: () => `file://${bare}`, createPullRequests: true, author: { name: 'Friday', email: 'friday@example.test' } })
  const provider = await startExecutorProvider({ root: join(home, 'provider'), bare, baseSha: git(bare, 'rev-parse', 'main') })
  cleanups.push(() => provider.close())
  // Same adapters as src/index.ts.
  const executions = new RepositoryExecutions({ db: registry.db, client: provider.client,
    snapshot: async (identity, input) => {
      try { return await changes.executionSnapshot({ ...identity, ...input }) }
      catch (error) { if (error instanceof ChangeSnapshotError) throw new RepositoryExecutionSnapshotChanged(); throw error }
    },
    authorize: (identity, repo) => () => { identity.assertAuthorized(); if (!github.repoWritable(repo) || !state.allowed) throw new Error('当前工作或资料来源不允许交给此仓库执行环境') } })
  const executionOutputs = new RepositoryExecutionOutputs({ executions, client: provider.client, changes, outputRoot: join(home, 'gateway', 'execution-output'),
    afterFile: index => state.fail?.(index) })
  const feishu = new FakeFeishu(), cache = new MessageCache(registry.db), tokens = new TokenIssuer('synthetic-output-api-test')
  const api = createInternalApi({ registry, ...sp, changes, github, executions, executionOutputs, feishu: asFeishuClient(feishu), messageCache: cache,
    memory: new ChannelMemory(registry.db), messages: new MessageService(asFeishuClient(feishu), cache, log), todos: new Todos(registry.db), tokens, log,
    maxHistoryPerCall: 50, resolveActorForSession: () => state.active ? { requesterOpenId: 'alice', runId: run.id, taskId: task.id, stage: 'task' } : undefined,
    canPublishToRepository: () => state.allowed, confirm: async () => true })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const cap: Omit<Capability, 'exp'> = { runId: run.id, sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', requesterOpenId: 'alice',
    spaceId: space.id, cwd, scopes: [...ALL_SCOPES] }
  const server = buildServer({ apiUrl, token: tokens.issue(cap) }), client = new Client({ name: 'synthetic-output-api', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
  cleanups.push(async () => { await client.close(); await server.close(); api.server.closeAllConnections()
    await new Promise<void>(resolve => api.server.close(() => resolve())); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const text = (result.content as { type: string; text: string }[]).filter(c => c.type === 'text').map(c => c.text).join('\n')
    return { error: !!result.isError, text }
  }
  const json = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args)
    expect(result.error, result.text).toBe(false)
    return JSON.parse(result.text)
  }
  expect((await call('github_start_change', { repo: 'org/demo' })).error).toBe(false)
  const change = changes.list({ cwd, sessionKey: 'session-a', requesterOpenId: 'alice' })[0]!
  writeFileSync(join(change.dir, 'README.md'), 'first fix\n')
  expect((await call('github_open_pr', { dir: change.dir, title: 'Original PR', body: 'Original body' })).error).toBe(false)
  const firstHead = git(bare, 'rev-parse', change.branch)
  const wait = async (id: string) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const view = await json('github_read_change_check', { id, changeId: change.id })
      if (view.state === 'finished') return view
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('execution did not finish')
  }
  const snapshot = async () => (await json('github_read_change_file', { changeId: change.id, path: 'README.md', consistency: 'snapshot' })).snapshot as string
  const post = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${apiUrl}${route}`, { method: 'POST', headers: { authorization: `Bearer ${tokens.issue(cap)}`,
      'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as { error?: string } }
  }
  return { registry, state, call, json, wait, snapshot, post, change, firstHead, bare, run, provider,
    text: (path: string) => readFileSync(join(change.dir, path), 'utf8') }
}

describe('generator output through MCP tools, the internal API and the provider', () => {
  it('runs the generator, imports its output, re-validates and appends to the same PR', async () => {
    const t = await fixture()
    const input = await t.snapshot()
    const started = await t.json('github_run_change_check', { changeId: t.change.id, expectedSnapshot: input, command: 'generate', timeoutMs: 20_000,
      capture: { paths: ['docs'] } })
    const generated = await t.wait(started.id)
    expect(generated.output).toMatchObject({ state: 'ready', capture: { paths: ['docs'] } })
    const applied = await t.json('github_apply_change_check_output', { id: started.id, changeId: t.change.id, expectedSnapshot: input,
      artifactDigest: generated.output.artifact.digest })
    expect(applied).toMatchObject({ state: 'applied', treeMatchesArtifact: true, previousSnapshot: input })
    expect(t.text('docs/c.i18n.yaml')).toBe(GENERATED.after.c)
    const checked = await t.json('github_run_change_check', { changeId: t.change.id, expectedSnapshot: applied.snapshot, command: 'verify', timeoutMs: 20_000 })
    expect(await t.wait(checked.id)).toMatchObject({ validation: 'passed', snapshotCurrent: 'current' })
    const updated = await t.call('github_update_pr', { dir: t.change.dir, title: 'Regenerate translation records', body: 'Generated and verified on the team executor.' })
    expect(updated.error, updated.text).toBe(false); expect(updated.text).toContain('https://github.com/org/demo/pull/7')
    expect(git(t.bare, 'rev-parse', `${t.change.branch}^`)).toBe(t.firstHead)
    expect(git(t.bare, 'rev-parse', `${t.change.branch}^{tree}`)).toBe(applied.snapshot)
    expect(t.state.posts).toBe(1)
    // The host ledger links both executions and the import to this Run.
    const calls = new RunApiCalls(t.registry.db).forRun(t.run.id)
    const referenced = (route: string) => calls.filter(call => call.route === route).flatMap(call => call.operations ?? [])
    expect(referenced('POST /v1/github/execution/apply')).toEqual([{ kind: 'github_execution', id: started.id }])
    expect(referenced('POST /v1/github/execution/start')).toEqual([{ kind: 'github_execution', id: started.id }, { kind: 'github_execution', id: checked.id }])
    expect(calls.find(call => call.route === 'POST /v1/github/execution/apply')!.scopes).toContain('github:write')
  })

  it('pauses reads, edits and PR updates with 409 while an import is unsettled, and resumes through the same tool', async () => {
    const t = await fixture()
    const input = await t.snapshot()
    const started = await t.json('github_run_change_check', { changeId: t.change.id, expectedSnapshot: input, command: 'generate', timeoutMs: 20_000,
      capture: { paths: ['docs'] } })
    const generated = await t.wait(started.id)
    const args = { id: started.id, changeId: t.change.id, expectedSnapshot: input, artifactDigest: generated.output.artifact.digest }
    t.state.fail = index => { if (index === 0) throw new Error('simulated failure after first file') }
    expect((await t.call('github_apply_change_check_output', args)).error).toBe(true)
    t.state.fail = undefined
    for (const [tool, body] of [['github_update_pr', { dir: t.change.dir, title: 'x', body: 'y' }],
      ['github_read_change_file', { changeId: t.change.id, path: 'README.md' }],
      ['github_run_change_check', { changeId: t.change.id, expectedSnapshot: input, command: 'verify', timeoutMs: 20_000 }]] as const) {
      const result = await t.call(tool, body)
      expect(result.error, tool).toBe(true)
      expect(result.text, tool).toContain('github_apply_change_check_output')
    }
    for (const [route, body] of [['/v1/github/change/update', { dir: t.change.dir, title: 'x', body: 'y' }],
      ['/v1/github/change/files/read', { changeId: t.change.id, path: 'README.md' }],
      ['/v1/github/execution/start', { changeId: t.change.id, expectedSnapshot: input, command: 'verify', timeoutMs: 20_000 }]] as const) {
      const response = await t.post(route, body)
      expect([route, response.status]).toEqual([route, 409])
      expect(response.body.error).toContain('github_apply_change_check_output')
    }
    expect(git(t.bare, 'rev-parse', t.change.branch)).toBe(t.firstHead)
    expect(await t.json('github_apply_change_check_output', args)).toMatchObject({ resumed: true, treeMatchesArtifact: true })
    expect((await t.call('github_update_pr', { dir: t.change.dir, title: 'Regenerate', body: 'Resumed import.' })).error).toBe(false)
  })

  it('refuses the import without repository write permission and changes nothing', async () => {
    const t = await fixture()
    const input = await t.snapshot()
    const started = await t.json('github_run_change_check', { changeId: t.change.id, expectedSnapshot: input, command: 'generate', timeoutMs: 20_000,
      capture: { paths: ['docs'] } })
    const generated = await t.wait(started.id)
    t.state.allowed = false
    const refused = await t.call('github_apply_change_check_output', { id: started.id, changeId: t.change.id, expectedSnapshot: input,
      artifactDigest: generated.output.artifact.digest })
    expect(refused.error).toBe(true)
    expect(t.text('docs/a.i18n.yaml')).toBe(GENERATED.before.a)
    expect(t.registry.db.prepare('SELECT import_state FROM github_executions WHERE id=?').get(started.id)).toEqual({ import_state: null })
  })
})
