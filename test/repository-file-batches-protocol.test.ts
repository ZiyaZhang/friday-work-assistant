import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry, type TaskRow } from '../src/core/registry.js'
import { RunAttempts, type RunAttempt } from '../src/core/run-attempts.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { ChangeManager } from '../src/github/changes.js'
import { GitHubIdentity, loadGitHubConfig } from '../src/github/identity.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { buildServer } from '../src/mcp/server.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'protocol test', GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'protocol test', GIT_COMMITTER_EMAIL: 'test@example.test' } }).trim()
}
type ToolReply = { content: { type: string; text?: string }[]; isError?: boolean }
const text = (reply: ToolReply) => reply.content.map(item => item.text ?? '').join('\n')
function json<T>(reply: ToolReply): T {
  expect(reply.isError, text(reply)).not.toBe(true)
  return JSON.parse(text(reply)) as T
}
type Current = { task: TaskRow; run: RunAttempt; stage: string }

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-repository-protocol-')))
  const source = join(home, 'source'), bare = join(home, 'remote.git'), cwd = join(home, 'workspace')
  mkdirSync(source); mkdirSync(cwd)
  git(source, 'init', '-q'); git(source, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(source, 'README.md'), '# Protocol fixture\n')
  writeFileSync(join(source, 'untouched.txt'), 'must remain unchanged\n')
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'initial')
  git(home, 'clone', '-q', '--bare', source, bare)
  const initialHead = git(bare, 'rev-parse', 'main')
  const registry = new Registry(join(home, 'state.sqlite')), sp = spaceDeps(registry.db)
  const log = createLogger('repository-protocol', 'error')
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  sp.spaces.addMember(space.id, 'bob', 'member')
  const attempts = new RunAttempts(registry.db), calls = new RunApiCalls(registry.db)
  const current = new Map<string, Current>(), providerCalls: { method: string; path: string; body: unknown }[] = []
  const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'synthetic-protocol-token',
    FRIDAY_GITHUB_REPOS: 'org/demo', FRIDAY_GITHUB_WRITE_REPOS: 'org/demo' })!, log, {
    async request(method, path, body) {
      providerCalls.push({ method, path, body })
      if (path === '/user') return { status: 200, data: { login: 'fixture-user' } as never }
      if (path === '/users/fixture-user') return { status: 200, data: { id: 123 } as never }
      if (method === 'GET' && path.includes('/pulls?')) return { status: 200, data: [] as never }
      if (method === 'POST' && path.endsWith('/pulls')) return { status: 201,
        data: { number: 1, html_url: 'https://github.com/org/demo/pull/1' } as never }
      if (method === 'GET' && path.endsWith('/pulls/1')) {
        const change = registry.db.prepare('SELECT branch,commit_id FROM github_changes LIMIT 1').get()!
        return { status: 200, data: { number: 1, html_url: 'https://github.com/org/demo/pull/1', draft: true, state: 'open',
          head: { ref: change.branch, sha: change.commit_id, repo: { full_name: 'org/demo' } },
          base: { ref: 'main', repo: { full_name: 'org/demo' } } } as never }
      }
      return { status: 404, data: {} as never }
    },
  })
  const changes = new ChangeManager({ db: registry.db, github, cacheDir: join(home, 'cache'), log,
    remoteUrlFor: () => `file://${bare}`, createPullRequests: true })
  const feishu = new FakeFeishu(), cache = new MessageCache(registry.db), tokens = new TokenIssuer('synthetic-protocol-signing')
  const state = { sourceSafe: true }, repositoryReads: { sessionKey: string; repo: string }[] = []
  const api = createInternalApi({ registry, ...sp, github, changes, log, tokens,
    feishu: asFeishuClient(feishu), messageCache: cache, memory: new ChannelMemory(registry.db),
    messages: new MessageService(asFeishuClient(feishu), cache, log), todos: new Todos(registry.db), maxHistoryPerCall: 50,
    resolveActorForSession: sessionKey => {
      const active = current.get(sessionKey)
      return active && attempts.isCurrent(active.run.id)
        ? { requesterOpenId: active.task.requesterOpenId, taskId: active.task.id, runId: active.run.id, stage: active.stage }
        : undefined
    },
    canPublishToRepository: () => state.sourceSafe,
    onRepositoryRead: (sessionKey, repo) => repositoryReads.push({ sessionKey, repo }),
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const clients: Client[] = []
  cleanups.push(async () => {
    for (const client of clients) await client.close()
    api.beginShutdown(); api.server.closeAllConnections()
    expect((await api.waitForShutdown(3000)).drained).toBe(true)
    await new Promise<void>(resolve => api.server.close(() => resolve()))
    registry.close(); rmSync(home, { recursive: true, force: true })
  })
  let sequence = 0
  async function admit(options: { sessionKey?: string; actor?: string; amendsTaskId?: number } = {}) {
    const sessionKey = options.sessionKey ?? 'session-a', actor = options.actor ?? 'alice'
    const previous = current.get(sessionKey)
    if (previous) {
      attempts.finish(previous.run.id, 'completed', Date.now(), 'end_turn')
      registry.updateTask(previous.task.id, { status: 'done', finishedAt: Date.now() })
    }
    if (!registry.getSession(sessionKey)) registry.createSession({ sessionKey, chatId: 'chat-a', chatType: 'group', cwd, requesterOpenId: actor })
    const messageId = `om_protocol_${++sequence}`, prompt = options.amendsTaskId ? '继续完成原来的修改' : '为仓库准备一个独立修改'
    const task = registry.createTaskOnce({ sessionKey, requesterOpenId: actor, messageId, prompt, amendsTaskId: options.amendsTaskId,
      inbound: { eventId: `event_${sequence}`, messageId, chatId: 'chat-a', chatType: 'group', senderOpenId: actor,
        senderType: 'user', msgType: 'text', text: prompt, mentions: [], createTimeMs: Date.now() } }).task
    expect(registry.startTask(task.id, Date.now(), sessionKey)).toBe(true)
    const run = attempts.begin({ sessionKey, taskId: task.id, workKey: registry.taskWork.get(task.id)!.key,
      actorOpenId: actor, triggerKey: `task:${task.id}:protocol`, stage: 'task', now: Date.now() })!
    attempts.bindExecutionBoundary(run.id, 'managed_api_v1')
    const binding: Current = { task, run, stage: 'task' }; current.set(sessionKey, binding)
    const server = buildServer({ apiUrl, token: tokens.issue({ runId: run.id, sessionKey, chatId: 'chat-a', chatType: 'group',
      requesterOpenId: actor, spaceId: space.id, cwd, scopes: [...ALL_SCOPES] }) })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: `repository-protocol-${sequence}`, version: '1' })
    await client.connect(clientTransport); clients.push(client)
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolReply> =>
      await client.callTool({ name, arguments: args }) as ToolReply
    return { ...binding, binding, call }
  }
  async function prepare(actor: Awaited<ReturnType<typeof admit>>) {
    const reply = await actor.call('github_start_change', { repo: 'org/demo', base: 'main', branch_hint: 'protocol-change' })
    expect(reply.isError, text(reply)).not.toBe(true)
    const id = /changeId: ([^\s]+)/u.exec(text(reply))?.[1]
    expect(id, text(reply)).toBeTruthy()
    const listed = json<{ changes: { id: string; dir: string; branch: string }[] }>(await actor.call('github_list_changes'))
    const change = listed.changes.find(item => item.id === id)!
    expect(change).toBeTruthy()
    return change
  }
  return { home, bare, cwd, initialHead, registry, attempts, calls, changes, state, providerCalls, repositoryReads, admit, prepare }
}

describe('repository batches over real MCP, signed HTTP and Git', () => {
  it('browses directory pages and continues path discovery over the actual signed MCP contract without tree hashing', async () => {
    const t = await fixture(), actor = await t.admit(), change = await t.prepare(actor)
    mkdirSync(join(change.dir, 'needle-dir'))
    writeFileSync(join(change.dir, 'needle-dir', 'one.txt'), 'target')
    writeFileSync(join(change.dir, 'needle-dir', 'two.txt'), 'target')
    const original = t.changes.withChange.bind(t.changes)
    t.changes.withChange = (input, use) => original(input, lease => use({ ...lease,
      async snapshot() { throw new Error('ordinary discovery must not hash the whole tree') },
    }))
    const first = json<{ next: string; directoryVersion: string; entries: { name: string }[] }>(await actor.call('github_list_change_files', { changeId: change.id, limit: 1 }))
    const rest = json<{ complete: boolean; entries: { name: string }[] }>(await actor.call('github_list_change_files', {
      changeId: change.id, after: first.next, expectedDirectoryVersion: first.directoryVersion }))
    expect([...first.entries, ...rest.entries].map(entry => entry.name)).toEqual(['README.md', 'needle-dir', 'untouched.txt'])
    expect(rest.complete).toBe(true)
    const input = { changeId: change.id, mode: 'path', query: 'needle', limit: 1 }
    const found: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const result = json<{ nextCursor: string | null; coverage: string; consistency: string; matches: { path: string }[] }>(
        await actor.call('github_search_change_files', { ...input, ...(cursor ? { cursor } : {}) }))
      expect(result).toMatchObject({ coverage: 'page', consistency: 'files' })
      expect(result).not.toHaveProperty('snapshot')
      found.push(...result.matches.map(match => match.path)); cursor = result.nextCursor
      if (!cursor) break
    }
    expect(cursor).toBeNull()
    expect(found).toEqual(['needle-dir', 'needle-dir/one.txt', 'needle-dir/two.txt'])
    expect(t.providerCalls.some(call => call.method === 'POST')).toBe(false)
  })

  it('does not grant a stale or foreign Work access through a previously returned directory version or path cursor', async () => {
    const t = await fixture(), actor = await t.admit(), change = await t.prepare(actor)
    const first = json<{ next: string; directoryVersion: string }>(await actor.call('github_list_change_files', { changeId: change.id, limit: 1 }))
    const search = json<{ nextCursor: string }>(await actor.call('github_search_change_files', { changeId: change.id, queries: ['.', 'md'], mode: 'path', limit: 1 }))
    expect(search.nextCursor).toEqual(expect.any(String))
    const other = await t.admit()
    for (const call of [
      { name: 'github_list_change_files', args: { changeId: change.id, after: first.next, expectedDirectoryVersion: first.directoryVersion } },
      { name: 'github_search_change_files', args: { changeId: change.id, queries: ['.', 'md'], mode: 'path', limit: 1, cursor: search.nextCursor } },
    ]) expect((await other.call(call.name, call.args)).isError).toBe(true)
    expect(t.providerCalls.some(call => call.method === 'POST')).toBe(false)
  })

  it('defaults model reads and searches to file digests without any whole-tree snapshot and can opt into strict verification', async () => {
    const t = await fixture(), actor = await t.admit(), change = await t.prepare(actor)
    const original = t.changes.withChange.bind(t.changes)
    let allowSnapshot = false
    t.changes.withChange = (input, use) => original(input, lease => use({ ...lease,
      async snapshot() {
        if (!allowSnapshot) throw new Error('ordinary model reads must not hash the entire repository')
        return lease.snapshot()
      },
    }))
    const single = json<{ digest: string; content: string }>(await actor.call('github_read_change_file', { changeId: change.id, path: 'README.md' }))
    const batch = json<Record<string, unknown>>(await actor.call('github_read_change_files', { changeId: change.id, paths: ['README.md', 'untouched.txt'] }))
    const search = json<{ matches: { path: string; digest: string }[] }>(await actor.call('github_search_change_files', { changeId: change.id, path: 'README.md', query: 'Protocol' }))
    for (const result of [single, batch, search]) {
      expect(result).toMatchObject({ consistency: 'files' })
      expect(result).not.toHaveProperty('snapshot')
    }
    expect(single.digest).toBe(createHash('sha256').update(single.content).digest('hex'))
    expect(search.matches[0]).toMatchObject({ path: 'README.md', digest: single.digest })
    allowSnapshot = true
    const strict = json<{ snapshot: string }>(await actor.call('github_read_change_file', { changeId: change.id, path: 'README.md', consistency: 'snapshot' }))
    expect(strict.snapshot).toMatch(/^[a-f0-9]{40}$/)
    expect((await actor.call('github_read_change_file', { changeId: change.id, path: 'README.md', expectedSnapshot: '0'.repeat(40) })).isError).toBe(true)
    expect(t.providerCalls.some(call => call.method === 'POST')).toBe(false)
  })

  it('passes batched queries and real file bytes through signed tools without multiplying snapshots or granting writes', async () => {
    const t = await fixture(), actor = await t.admit(), change = await t.prepare(actor)
    const original = t.changes.withChange.bind(t.changes)
    let snapshots = 0
    t.changes.withChange = (input, use) => original(input, lease => use({ ...lease,
      async snapshot() { snapshots++; return lease.snapshot() },
    }))
    const searched = json<{ snapshot: string; results: { query: string; matches: { path: string }[]; truncated: boolean }[] }>(
      await actor.call('github_search_change_files', { changeId: change.id, queries: ['Protocol', 'unchanged'], consistency: 'snapshot' }))
    expect(snapshots).toBe(2)
    expect(searched.results.map(result => ({ query: result.query, paths: result.matches.map(match => match.path) })))
      .toEqual([{ query: 'Protocol', paths: ['README.md'] }, { query: 'unchanged', paths: ['untouched.txt'] }])
    const batch = json<{ snapshot: string; files: { path: string; content: string; digest: string }[] }>(await actor.call('github_read_change_files', {
      changeId: change.id, paths: ['README.md', 'untouched.txt'], expectedSnapshot: searched.snapshot }))
    expect(snapshots).toBe(4)
    expect(batch.snapshot).toBe(searched.snapshot)
    expect(batch.files.map(file => file.content)).toEqual(['# Protocol fixture\n', 'must remain unchanged\n'])
    expect(batch.files.every(file => file.digest === createHash('sha256').update(file.content).digest('hex'))).toBe(true)
    const calls = t.calls.forRun(actor.run.id).filter(call => call.route.includes('/change/files/'))
    expect(calls.map(call => ({ scopes: call.scopes, state: call.state }))).toEqual([
      { scopes: ['github:read'], state: 'returned' }, { scopes: ['github:read'], state: 'returned' },
    ])
    expect((await actor.call('github_search_change_files', { changeId: change.id, query: 'Protocol', queries: ['unchanged'] })).isError).toBe(true)
    expect((await actor.call('github_search_change_files', { changeId: change.id })).isError).toBe(true)
    const missing = await actor.call('github_read_change_files', { changeId: change.id, paths: ['README.md', 'missing.txt'] })
    expect(missing.isError).toBe(true); expect(text(missing)).toContain('not_found'); expect(text(missing)).not.toContain('Protocol fixture')
    const stranger = await t.admit()
    expect((await stranger.call('github_read_change_files', { changeId: change.id, paths: ['README.md'] })).isError).toBe(true)
    expect((await stranger.call('github_search_change_files', { changeId: change.id, queries: ['Protocol'] })).isError).toBe(true)
    expect(t.providerCalls.some(call => call.method === 'POST')).toBe(false)
  })

  it('rejects an otherwise complete batch when its actual Run stops during the final Git snapshot', async () => {
    const t = await fixture(), actor = await t.admit(), change = await t.prepare(actor)
    const original = t.changes.withChange.bind(t.changes)
    let snapshots = 0
    t.changes.withChange = (input, use) => original(input, lease => use({ ...lease,
      async snapshot() {
        const snapshot = await lease.snapshot()
        if (++snapshots === 2) t.attempts.requestStop(actor.run.id, 'user_requested')
        return snapshot
      },
    }))
    t.repositoryReads.length = 0
    const reply = await actor.call('github_read_change_files', { changeId: change.id, paths: ['README.md', 'untouched.txt'], consistency: 'snapshot' })
    expect(reply.isError).toBe(true)
    expect(text(reply)).not.toContain('Protocol fixture')
    expect(t.repositoryReads).toEqual([])
    expect(t.calls.forRun(actor.run.id).find(call => call.route.endsWith('/read-many'))?.state).toBe('failed')
  })

})
