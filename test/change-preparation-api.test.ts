import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { ChangeManager } from '../src/github/changes.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } }).trim()
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
type GitMethod = (args: string[], cwd?: string, env?: Record<string, string>, check?: () => void, signal?: AbortSignal) => Promise<string>

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-prepare-http-'))), source = join(home, 'source'), bare = join(home, 'remote.git')
  const cwd = join(home, 'workspace'), cacheDir = join(home, 'gateway')
  mkdirSync(source); mkdirSync(cwd); git(source, 'init', '-q'); git(source, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(source, 'README.md'), 'synthetic original\n'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'initial')
  git(home, 'clone', '--bare', '--quiet', source, bare)
  const registry = new Registry(join(home, 'db.sqlite')), sp = spaceDeps(registry.db), log = createLogger('prepare-http', 'error')
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', cwd, requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', requesterOpenId: 'alice', messageId: 'om_prepare', prompt: '修复这个仓库' }).task
  const attempts = new RunAttempts(registry.db), calls = new RunApiCalls(registry.db)
  const begin = (generation: number) => attempts.begin({ sessionKey: task.sessionKey, taskId: task.id, workKey: registry.taskWork.get(task.id)!.key,
    actorOpenId: 'alice', triggerKey: `task:${task.id}:attempt:${generation}`, stage: 'task', now: Date.now() })!
  const state = { run: begin(0), sourceSafe: true }
  const github = { repoAllowed: (repo: string) => repo === 'org/demo', repoWritable: (repo: string) => repo === 'org/demo' } as GitHubIdentity
  const changes = new ChangeManager({ db: registry.db, cacheDir, github, log, remoteUrlFor: () => `file://${bare}` })
  const feishu = new FakeFeishu(), cache = new MessageCache(registry.db), tokens = new TokenIssuer('synthetic-preparation')
  const api = createInternalApi({ registry, ...sp, github, changes, log, tokens, feishu: asFeishuClient(feishu), messageCache: cache,
    memory: new ChannelMemory(registry.db), messages: new MessageService(asFeishuClient(feishu), cache, log), todos: new Todos(registry.db), maxHistoryPerCall: 50,
    resolveActorForSession: key => key === task.sessionKey && attempts.isCurrent(state.run.id)
      ? { requesterOpenId: 'alice', runId: state.run.id, taskId: task.id, stage: 'task' } : undefined,
    canPublishToRepository: () => state.sourceSafe })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  cleanups.push(async () => {
    api.beginShutdown(); api.server.closeAllConnections()
    expect((await api.waitForShutdown(3000)).drained).toBe(true)
    await new Promise<void>(resolve => api.server.close(() => resolve()))
    registry.close(); rmSync(home, { recursive: true, force: true })
  })
  const cap = (): Omit<Capability, 'exp'> => ({ runId: state.run.id, sessionKey: task.sessionKey, chatId: 'chat-a', chatType: 'group',
    requesterOpenId: 'alice', spaceId: space.id, cwd, scopes: [...ALL_SCOPES] })
  const post = async (route: string, body: Record<string, unknown>, options: { signal?: AbortSignal; cap?: Partial<Capability> } = {}) => {
    const response = await fetch(`${url}/v1/github/change/${route}`, { method: 'POST', signal: options.signal,
      headers: { authorization: `Bearer ${tokens.issue({ ...cap(), ...options.cap })}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  const internal = changes as unknown as { git: GitMethod }, actualGit = internal.git.bind(changes)
  const preparations = () => changes.listPreparations({ cwd, sessionKey: task.sessionKey, requesterOpenId: 'alice' })
  const nextRun = () => { attempts.finish(state.run.id, 'cancelled', Date.now(), 'host_cancelled'); state.run = begin(1) }
  return { home, cacheDir, registry, task, state, calls, attempts, changes, preparations, post, internal, actualGit, nextRun }
}

describe('change preparation through signed HTTP and real Git', () => {
  it('shares one persistent operation across independent requests and exposes only scoped receipt metadata', async () => {
    const t = await fixture(), entered = deferred(), release = deferred()
    const spy = vi.spyOn(t.internal, 'git').mockImplementation(async (...args) => {
      if (args[0][0] === 'fetch') { entered.resolve(); await release.promise }
      return t.actualGit(...args)
    })
    const first = t.post('start', { repo: 'org/demo', base: 'main' }); await entered.promise
    const recorded = t.calls.forRun(t.state.run.id)[0]!
    expect(recorded).toMatchObject({ state: 'started', operations: [{ kind: 'github_change_preparation', id: t.preparations()[0]!.id }] })
    const second = t.post('start', { repo: 'Org/Demo', base: 'main', branch_hint: 'retry cosmetics', operationKey: 'model-supplied' })
    await vi.waitFor(() => expect(t.calls.forRun(t.state.run.id).filter(call => call.route.endsWith('/start'))).toHaveLength(2))
    const pending = await t.post('list', {})
    expect(pending.body.changes).toEqual([]); expect(pending.body.preparations).toMatchObject([{ state: 'preparing' }])
    expect(pending.body.preparations[0]).not.toHaveProperty('operationKey'); expect(pending.body.preparations[0]).not.toHaveProperty('attemptKey')
    release.resolve(); const [a, b] = await Promise.all([first, second])
    expect(a.status).toBe(200); expect(b.status).toBe(200); expect(b.body.id).toBe(a.body.id)
    const replay = await t.post('start', { repo: 'org/demo', base: 'main' })
    expect(replay.body).toMatchObject({ id: a.body.id, replayed: true })
    expect(spy.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1)
    expect(t.preparations()).toHaveLength(1)
    expect(new Set(t.calls.forRun(t.state.run.id).flatMap(call => call.operations ?? []).map(ref => ref.id)).size).toBe(1)
  })

  it('disconnecting HTTP terminates the actual Git process and same-Run retries cannot queue another clone', async () => {
    const t = await fixture(), abort = new AbortController(), pidFile = join(t.home, 'git-child.pid')
    const code = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
    const spy = vi.spyOn(t.internal, 'git').mockImplementation((...args) => args[0][0] === 'fetch'
      ? t.actualGit(['-c', `alias.hold=!${quote(process.execPath)} -e ${quote(code)}`, 'hold'], undefined,
        { FRIDAY_GIT_AUTH_SCOPE: 'https://github.com/org/demo.git', FRIDAY_GIT_AUTH_HEADER: 'AUTHORIZATION: synthetic-only' }, args[3], args[4]) : t.actualGit(...args))
    const request = t.post('start', { repo: 'org/demo', base: 'main' }, { signal: abort.signal })
    const rejected = expect(request).rejects.toThrow()
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true)); const pid = Number(readFileSync(pidFile, 'utf8'))
    abort.abort(); await rejected
    await vi.waitFor(() => expect(t.preparations()[0]?.state).toBe('cancelled'), { timeout: 3000 })
    expect(() => process.kill(pid, 0)).toThrow(); expect(readdirSync(t.cacheDir).filter(name => name.startsWith('.auth-'))).toEqual([])
    expect(t.attempts.isCurrent(t.state.run.id)).toBe(true)
    const originalId = t.preparations()[0]!.id, repeated = await t.post('start', { repo: 'org/demo', base: 'main' })
    expect(repeated.status).toBeGreaterThanOrEqual(400); expect(t.preparations()).toHaveLength(1)
    expect(spy.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_changes').get()?.n).toBe(0)
    expect(t.calls.forRun(t.state.run.id).filter(call => call.route.endsWith('/start')).every(call => call.state === 'failed')).toBe(true)
    // A new host-admitted attempt of the same input can retry local-only preparation.
    spy.mockImplementation(t.actualGit); t.nextRun()
    const resumed = await t.post('start', { repo: 'org/demo', base: 'main' })
    expect(resumed.status).toBe(200); expect(resumed.body.operationId).toBe(originalId)
    expect(t.preparations()[0]?.state).toBe('prepared')
  })

  it('does not let signed actor/repository changes or unsafe sources borrow an existing operation', async () => {
    const t = await fixture(), ready = await t.post('start', { repo: 'org/demo', base: 'main' })
    expect(ready.status).toBe(200)
    const spy = vi.spyOn(t.internal, 'git')
    expect((await t.post('start', { repo: 'org/demo', base: 'main' }, { cap: { requesterOpenId: 'mallory' } })).status).toBe(403)
    expect((await t.post('list', {}, { cap: { requesterOpenId: 'mallory' } })).status).toBe(403)
    expect((await t.post('start', { repo: 'other/private', base: 'main' })).status).toBe(403)
    t.state.sourceSafe = false
    expect((await t.post('start', { repo: 'org/demo', base: 'main' })).status).toBe(403)
    expect(spy).not.toHaveBeenCalled(); expect(t.preparations()).toHaveLength(1)
  })
})
