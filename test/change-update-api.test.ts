import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { ChangeManager } from '../src/github/changes.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: {
    PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test',
  } }).trim()
}
async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-pr-api-'))), source = join(home, 'source'), bare = join(home, 'remote.git'), cwd = join(home, 'workspace')
  mkdirSync(source); mkdirSync(cwd)
  git(source, 'init', '-q'); git(source, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(source, 'README.md'), 'original\n')
  git(source, 'add', '-A'); git(source, 'commit', '-qm', 'initial'); git(home, 'clone', '--bare', '--quiet', source, bare)
  const registry = new Registry(join(home, 'registry.db')), sp = spaceDeps(registry.db), log = createLogger('change-update-api', 'error')
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', requesterOpenId: 'alice', cwd })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', requesterOpenId: 'alice', messageId: 'om_original', prompt: '修改本仓库并提交 PR' }).task
  const run = new RunAttempts(registry.db).begin({ workKey: registry.taskWork.get(task.id)!.key,
    sessionKey: task.sessionKey, taskId: task.id, actorOpenId: 'alice', triggerKey: `task:${task.id}`, stage: 'task', now: Date.now() })!
  const state = { active: true, allowed: true, approval: true, afterRemoteRead: () => {}, branch: '', title: '', prBody: '', posts: 0 }
  const pr = () => ({ number: 7, html_url: 'https://github.com/org/demo/pull/7', title: state.title, body: state.prBody, state: 'open', draft: true, merged: false,
    head: { ref: state.branch, sha: git(bare, 'rev-parse', state.branch), repo: { full_name: 'org/demo' } },
    base: { ref: 'main', sha: git(bare, 'rev-parse', 'main'), repo: { full_name: 'org/demo' } }, changed_files: 1 })
  const github = { repoAllowed: (repo: string) => repo === 'org/demo', repoWritable: (repo: string) => repo === 'org/demo', defaultRepo: () => 'org/demo',
    async api(method: string, path: string, body?: Record<string, unknown>, _owner?: string, beforeRequest?: () => void) {
      beforeRequest?.()
      if (method === 'POST' && path.endsWith('/pulls')) { state.posts++; state.branch = String(body!.head); state.title = String(body!.title); state.prBody = String(body!.body); return pr() }
      if (method !== 'GET') throw new Error(`Unexpected write: ${method} ${path}`)
      if (path.includes('/pulls?')) return state.posts ? [pr()] : []
      if (path.includes('/pulls/7/files?')) return [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-original\n+first' }]
      if (path.includes('/pulls/7/reviews?')) return [{ id: 1, user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: 'Add usage and keep the original title.', commit_id: pr().head.sha }]
      if (path.includes('/pulls/7/comments?')) return [{ id: 2, user: { login: 'reviewer' }, body: 'Give a working example.', path: 'README.md', line: 1, commit_id: pr().head.sha, original_commit_id: pr().head.sha }]
      if (path.endsWith('/pulls/7')) { const r = pr(); state.afterRemoteRead(); return r }
      throw new Error(`Unexpected read: ${path}`)
    },
  } as unknown as GitHubIdentity
  const changes = new ChangeManager({ db: registry.db, cacheDir: join(home, 'gateway'), github, log,
    remoteUrlFor: () => `file://${bare}`, createPullRequests: true, author: { name: 'Friday', email: 'friday@example.test' } })
  const feishu = new FakeFeishu(), cache = new MessageCache(registry.db), tokens = new TokenIssuer('synthetic-pr-test')
  const confirmations: { header: string; headline: string; detail?: string }[] = []
  const api = createInternalApi({ registry, ...sp, changes, github, feishu: asFeishuClient(feishu), messageCache: cache,
    memory: new ChannelMemory(registry.db), messages: new MessageService(asFeishuClient(feishu), cache, log), todos: new Todos(registry.db), tokens, log, maxHistoryPerCall: 50,
    resolveActorForSession: () => state.active ? { requesterOpenId: 'alice', runId: run.id, taskId: task.id, stage: 'task' } : undefined,
    canPublishToRepository: () => state.allowed,
    confirm: async input => { confirmations.push(input); return state.approval },
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const cap: Omit<Capability, 'exp'> = { runId: run.id, sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', requesterOpenId: 'alice', spaceId: space.id, cwd, scopes: [...ALL_SCOPES] }
  const token = tokens.issue(cap), server = buildServer({ apiUrl, token }), client = new Client({ name: 'synthetic-pr-workflow', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
  cleanups.push(async () => { await client.close(); await server.close(); api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as { type: string; text: string }[]
    return { error: !!result.isError, text: content.filter(c => c.type === 'text').map(c => c.text).join('\n') }
  }
  const list = async () => JSON.parse((await call('github_list_changes')).text).changes as { id: string; dir: string; branch: string; commitId: string }[]
  const post = async (route: string, body: Record<string, unknown>, patch: Partial<typeof cap> = {}) => {
    const response = await fetch(`${apiUrl}/v1/github/change/${route}`, { method: 'POST', headers: { authorization: `Bearer ${tokens.issue({ ...cap, ...patch })}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const started = await call('github_start_change', { repo: 'org/demo' })
  expect(started.error, started.text).toBe(false)
  const change = (await list())[0]!
  writeFileSync(join(change.dir, 'README.md'), 'first\n')
  expect((await call('github_open_pr', { dir: change.dir, title: 'Original PR', body: 'Original body' })).error).toBe(false)
  const firstHead = git(bare, 'rev-parse', change.branch)
  return { registry, state, confirmations, call, list, post, change, firstHead, bare, git: (...args: string[]) => git(bare, ...args) }
}

describe('existing PR through MCP, real HTTP, SQLite and local Git', () => {
  it('reads inline review and updates the original PR without changing its description or creating another PR', async () => {
    const t = await fixture()
    const review = JSON.parse((await t.call('github_pr_diff', { repo: 'org/demo', number: 7 })).text)
    expect(review.head_sha).toBe(t.firstHead)
    expect(review.inline_comments[0]).toMatchObject({ path: 'README.md', commit_id: t.firstHead, body: 'Give a working example.' })
    writeFileSync(join(t.change.dir, 'README.md'), 'first\n\nUsage: run demo\n')
    const result = await t.call('github_update_pr', { dir: t.change.dir, title: 'Address review', body: 'Added usage example. Verified sample.' })
    expect(result.error).toBe(false); expect(result.text).toContain('PR #7'); expect(result.text).toContain('https://github.com/org/demo/pull/7')
    expect(t.git('rev-parse', `${t.change.branch}^`)).toBe(t.firstHead)
    expect(t.git('show', `${t.change.branch}:README.md`)).toContain('Usage: run demo')
    expect(t.state.posts).toBe(1); expect(t.state.title).toBe('Original PR'); expect(t.state.prBody).toBe('Original body')
    expect((await t.list())[0]?.dir).toBe(t.change.dir)
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_changes').get()?.n).toBe(1)
    const updatedHead = t.git('rev-parse', t.change.branch)
    const replay = await t.call('github_update_pr', { dir: t.change.dir, title: 'Address review', body: 'Added usage example. Verified sample.' })
    expect(replay.error).toBe(false); expect(replay.text).toContain('没有新改动'); expect(replay.text).toContain(updatedHead)
    expect(t.git('rev-parse', t.change.branch)).toBe(updatedHead)
    expect(t.state.posts).toBe(1)
    // 开 PR 和更新 PR 都不再弹确认卡
    expect(t.confirmations).toEqual([])
  })

  // 更新 PR 不再要确认（和开 PR 一致：同一个 PR 的前后半段，不该一个问一个不问），
  // 所以没有 'refused' 这一档了。但**取消**和**授权撤销**仍然必须拦住推送——
  // 那两件事和"要不要点头"无关，是这轮还算不算数。注入点搬到读完远端 PR 之后，
  // 那才是这条路上真正的 await，它后面紧跟着 needRepositoryWrite。
  it.each(['cancelled', 'sources'] as const)('preserves the old remote head when the run is %s mid-update', async kind => {
    const t = await fixture()
    writeFileSync(join(t.change.dir, 'README.md'), 'unpublished review fix\n')
    t.state.afterRemoteRead = () => { if (kind === 'cancelled') t.state.active = false; else t.state.allowed = false }
    const result = await t.call('github_update_pr', { dir: t.change.dir, title: 'Review fix', body: '' })
    expect(result.error).toBe(true)
    expect(t.git('rev-parse', t.change.branch)).toBe(t.firstHead); expect(t.state.posts).toBe(1)
  })

  it('limits discovery to the same session and rejects another session using the known path', async () => {
    const t = await fixture()
    const discovery = await t.post('list', {}, { sessionKey: 'unrelated' })
    expect(discovery.status).toBe(403)
    expect(discovery.body).not.toHaveProperty('changes')
    expect(JSON.stringify(discovery.body)).not.toContain(t.change.dir)
    const result = await t.post('update', { dir: t.change.dir, title: 'Wrong session', body: '' }, { sessionKey: 'unrelated' })
    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(t.git('rev-parse', t.change.branch)).toBe(t.firstHead)
    expect(t.confirmations).toEqual([])
  })
})
