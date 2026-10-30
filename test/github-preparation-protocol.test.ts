import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { assertRequestCurrent } from '../src/core/request-lease.js'
import { inspectRecoveryEvidence } from '../src/core/recovery-evidence.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { ChangeManager } from '../src/github/changes.js'
import { ChangePreparationOperations } from '../src/github/preparation-operations.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'

const cleanups: (() => Promise<void>)[] = [], releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } }).trim()
}
type GitMethod = (args: string[], cwd?: string, env?: Record<string, string>, check?: () => void, signal?: AbortSignal) => Promise<string>
async function fixture(options: { missingRunSignal?: boolean } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-preparation-protocol-')))
  const seed = join(home, 'seed'), remote = join(home, 'remote.git'), cwd = join(home, 'workspace'), cacheDir = join(home, 'cache')
  mkdirSync(seed); mkdirSync(cwd); git(seed, 'init', '-q'); git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(seed, 'README.md'), 'real managed checkout\n'); git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'initial')
  git(home, 'clone', '--bare', '--quiet', seed, remote)
  const registry = new Registry(join(home, 'state.sqlite')), sp = spaceDeps(registry.db), log = createLogger('preparation-protocol', 'error')
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'synthetic-chat', openId: 'alice' }), sessionKey = 'synthetic-session'
  registry.createSession({ sessionKey, chatId: space.chatId!, chatType: 'group', cwd, requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey, messageId: 'original-request', requesterOpenId: 'alice', prompt: 'Prepare this repository change' }).task
  const attempts = new RunAttempts(registry.db), calls = new RunApiCalls(registry.db)
  const begin = (taskId: number, generation: number) => attempts.begin({ taskId, sessionKey, workKey: registry.taskWork.get(taskId)!.key,
    actorOpenId: 'alice', triggerKey: `fixture:${taskId}:${generation}`, stage: 'task', now: Date.now() })!
  const state = { run: begin(task.id, 0), task, abort: new AbortController(), sourceSafe: true, controlRevision: 0 }
  attempts.bindExecutionBoundary(state.run.id, 'managed_api_v1')
  const github = { repoAllowed: (repo: string) => repo === 'org/demo', repoWritable: (repo: string) => repo === 'org/demo' } as GitHubIdentity
  const changes = new ChangeManager({ db: registry.db, cacheDir, github, log, remoteUrlFor: () => `file://${remote}` })
  const preparations = new ChangePreparationOperations({ changes }), cache = new MessageCache(registry.db), tokens = new TokenIssuer('fixture-preparation')
  const feishu = asFeishuClient(new FakeFeishu())
  const api = createInternalApi({ registry, ...sp, github, changes, preparations, log, tokens, feishu, messageCache: cache,
    memory: new ChannelMemory(registry.db), messages: new MessageService(feishu, cache, log), todos: new Todos(registry.db), maxHistoryPerCall: 50,
    resolveActorForSession: key => key === sessionKey && attempts.isCurrent(state.run.id)
      ? { requesterOpenId: 'alice', runId: state.run.id, taskId: state.task.id, stage: 'task', controlRevision: state.controlRevision } : undefined,
    canPublishToRepository: () => { assertRequestCurrent(); return state.sourceSafe },
    ...(!options.missingRunSignal ? { preparationRunSignal: (key: string, runId: string) => {
      assertRequestCurrent()
      if (key !== sessionKey || state.run.id !== runId || !attempts.isCurrent(runId)) throw new Error('wrong Run')
      return state.abort.signal
    } } : {}) })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const cap = (): Omit<Capability, 'exp'> => ({ runId: state.run.id, sessionKey, chatId: space.chatId!, chatType: 'group',
    requesterOpenId: 'alice', spaceId: space.id, cwd, scopes: [...ALL_SCOPES] })
  const post = async (route: string, body: Record<string, unknown>, opts: { signal?: AbortSignal; cap?: Partial<Capability> } = {}) => {
    const response = await fetch(`${url}/v1/github/change/${route}`, { method: 'POST', signal: opts.signal,
      headers: { authorization: `Bearer ${tokens.issue({ ...cap(), ...opts.cap })}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  const server = buildServer({ apiUrl: url, token: tokens.issue(cap()) }), client = new Client({ name: 'preparation-protocol-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport); await client.connect(clientTransport)
  cleanups.push(async () => {
    await client.close(); await server.close(); api.beginShutdown(); api.server.closeAllConnections()
    expect((await api.waitForShutdown(3000)).drained).toBe(true)
    await new Promise<void>(resolve => api.server.close(() => resolve()))
    registry.close(); rmSync(home, { recursive: true, force: true })
  })
  const internal = changes as unknown as { git: GitMethod }, actualGit = internal.git.bind(changes)
  function holdFetch() {
    const entered = deferred(), release = deferred(); releases.push(release.resolve)
    const spy = vi.spyOn(internal, 'git').mockImplementation(async (...args) => {
      if (args[0][0] === 'fetch') { entered.resolve(); await release.promise }
      return actualGit(...args)
    })
    return { entered, release, spy }
  }
  const textOf = (result: any) => result.content.map((item: any) => item.text ?? '').join('\n') as string
  const records = () => changes.listPreparations({ cwd, sessionKey, requesterOpenId: 'alice' })
  return { home, cwd, cacheDir, registry, sp, space, attempts, calls, state, changes, preparations, api, client, post, cap,
    internal, actualGit, holdFetch, textOf, records, begin }
}

describe('actual MCP -> signed API -> Run-owned Git preparation', () => {
  it('returns pending without a checkout, then waits for the same real copy with only host-derived operation identity', async () => {
    const t = await fixture(), hold = t.holdFetch()
    const started = await t.client.callTool({ name: 'github_start_change', arguments: { repo: 'org/demo', base: 'main' } })
    expect(started.isError).toBeFalsy(); const first = JSON.parse(t.textOf(started))
    expect(first.preparation.state).toBe('preparing'); expect(t.textOf(started)).not.toContain('已准备好可写副本')
    await hold.entered.promise
    const calls = t.calls.forRun(t.state.run.id)
    expect(calls).toMatchObject([{ state: 'returned', scopes: ['github:write'], operations: [{ kind: 'github_change_preparation', id: first.preparation.id }] }])
    const repeat = await t.post('start', { repo: 'Org/Demo', base: 'main', runId: 'model-invented', operationKey: 'model-invented' })
    expect(repeat.body.preparation.id).toBe(first.preparation.id); expect(t.records()).toHaveLength(1)
    const query = await t.client.callTool({ name: 'github_wait_change', arguments: { repo: 'org/demo', base: 'main', wait_ms: 0 } })
    expect(JSON.parse(t.textOf(query)).preparation.state).toBe('preparing')
    expect(t.calls.forRun(t.state.run.id).at(-1)).toMatchObject({ state: 'returned', scopes: ['github:read'] })
    hold.release.resolve()
    const ready = await t.client.callTool({ name: 'github_wait_change', arguments: { repo: 'org/demo', base: 'main' } })
    expect(ready.isError).toBeFalsy(); expect(t.textOf(ready)).toContain('已准备好可写副本')
    const record = t.records()[0]!
    expect(readFileSync(join(record.result!.dir, 'README.md'), 'utf8')).toBe('real managed checkout\n')
    expect(t.preparations.unobservedForRun(t.state.run.id)).toBe(false)
    expect(hold.spy.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1)
    expect((await t.post('wait', { repo: 'org/demo', base: 'main', wait_ms: 0 })).body).toMatchObject({ id: record.result!.id, dir: record.result!.dir })
    expect(JSON.stringify(repeat.body)).not.toMatch(/operationKey|attemptKey|model-invented/)
  })

  it('a real MCP timeout cancels only HTTP waiting; preparation survives and read-only cancellation is not an unknown write', async () => {
    const t = await fixture(), hold = t.holdFetch()
    expect((await t.post('start', { repo: 'org/demo', base: 'main' })).status).toBe(200); await hold.entered.promise
    await expect(t.client.callTool({ name: 'github_wait_change', arguments: { repo: 'org/demo', base: 'main' } }, undefined, { timeout: 50 }))
      .rejects.toThrow(/timed out/i)
    await vi.waitFor(() => expect(t.calls.forRun(t.state.run.id).find(call => call.route.endsWith('/wait'))?.state).toBe('failed'))
    expect(t.state.abort.signal.aborted).toBe(false); expect(t.records()[0]!.state).toBe('preparing')
    expect(t.calls.forRun(t.state.run.id).find(call => call.route.endsWith('/wait'))?.scopes).toEqual(['github:read'])
    hold.release.resolve(); await t.preparations.settleRun(t.state.run.id)
    expect(t.records()[0]!.state).toBe('prepared')
    const evidence = inspectRecoveryEvidence(t.registry.db, { taskId: t.state.task.id, runId: t.state.run.id,
      sessionKey: t.state.task.sessionKey, actorOpenId: 'alice' })
    expect(evidence.reasons).not.toContain('effect_unresolved')
    expect(evidence.reasons).not.toContain('effect_unverifiable')
    expect((await t.post('wait', { repo: 'org/demo', base: 'main', wait_ms: 0 })).body.preparation.state).toBe('prepared')
  })

  it('restores unobserved after a prepared HTTP response is cancelled before it is sent', async () => {
    const t = await fixture()
    await t.post('start', { repo: 'org/demo', base: 'main' }); await t.preparations.settleRun(t.state.run.id)
    const route = t.api.routes['POST /v1/github/change/wait']!, formed = deferred(), release = deferred(); releases.push(release.resolve)
    t.api.routes['POST /v1/github/change/wait'] = async (cap, body) => { const result = await route(cap, body); formed.resolve(); await release.promise; return result }
    const abort = new AbortController(), response = t.post('wait', { repo: 'org/demo', base: 'main', wait_ms: 0 }, { signal: abort.signal })
    const rejected = expect(response).rejects.toThrow(); await formed.promise
    expect(t.preparations.unobservedForRun(t.state.run.id)).toBe(false)
    abort.abort(); await rejected
    await vi.waitFor(() => expect(t.preparations.unobservedForRun(t.state.run.id)).toBe(true))
    release.resolve(); await vi.waitFor(() => expect(t.calls.forRun(t.state.run.id).at(-1)?.state).toBe('failed'))
    t.api.routes['POST /v1/github/change/wait'] = route
    expect((await t.post('list', {})).body.changes).toHaveLength(1)
    expect(t.preparations.unobservedForRun(t.state.run.id)).toBe(false)
  })

  it('does not inherit a lost start response lifetime into the already admitted Git effect', async () => {
    const t = await fixture(), hold = t.holdFetch(), formed = deferred(), ended = deferred(), release = deferred(); releases.push(release.resolve)
    const route = t.api.routes['POST /v1/github/change/start']!
    t.api.routes['POST /v1/github/change/start'] = async (cap, body) => {
      cap.requestSignal?.addEventListener('abort', ended.resolve, { once: true })
      const result = await route(cap, body); formed.resolve(); await release.promise; return result
    }
    const abort = new AbortController(), response = t.post('start', { repo: 'org/demo', base: 'main' }, { signal: abort.signal })
    const rejected = expect(response).rejects.toThrow(); await formed.promise; await hold.entered.promise
    abort.abort(); await rejected; await ended.promise; release.resolve()
    await vi.waitFor(() => expect(t.calls.forRun(t.state.run.id).at(-1)?.state).toBe('failed'))
    expect(t.state.abort.signal.aborted).toBe(false); expect(t.records()[0]!.state).toBe('preparing')
    hold.release.resolve(); await t.preparations.settleRun(t.state.run.id)
    expect(t.records()[0]!.state).toBe('prepared'); expect(t.preparations.unobservedForRun(t.state.run.id)).toBe(true)
    expect((await t.post('wait', { repo: 'org/demo', base: 'main', wait_ms: 0 })).body.preparation.state).toBe('prepared')
    expect(t.preparations.unobservedForRun(t.state.run.id)).toBe(false)
  })

  it('counts only successful use of a verified change as consuming the prepared result', async () => {
    const t = await fixture(), hold = t.holdFetch()
    await t.post('start', { repo: 'org/demo', base: 'main' }); await hold.entered.promise
    hold.release.resolve(); await t.preparations.settleRun(t.state.run.id)
    const id = t.records()[0]!.result!.id
    expect(t.preparations.unobservedForRun(t.state.run.id)).toBe(true)
    expect((await t.post('files/read', { changeId: id, path: 'missing.txt' })).status).toBe(404)
    expect(t.preparations.unobservedForRun(t.state.run.id)).toBe(true)
    const read = await t.post('files/read', { changeId: id, path: 'README.md' })
    expect(read.status).toBe(200); expect(read.body.content).toBe('real managed checkout\n')
    expect(t.preparations.unobservedForRun(t.state.run.id)).toBe(false)
  })

  it('queries do not create operations, accepts only bounded waits, and never trusts model Run/operation keys', async () => {
    const t = await fixture(), hold = t.holdFetch()
    const started = await t.post('start', { repo: 'org/demo', base: 'main' }); await hold.entered.promise
    for (const body of [{ repo: 'org/demo', base: 'main', wait_ms: 20_001 }, { repo: 'org/demo', base: 'main', wait_ms: -1 }]) {
      expect((await t.post('wait', body)).status).toBe(400)
    }
    expect((await t.post('wait', { repo: 'org/demo', base: 'main', wait_ms: 0,
      operationKey: 'invented', runId: 'invented', preparation_id: 'invented' })).body.preparation.id).toBe(started.body.preparation.id)
    expect((await t.post('wait', { repo: 'org/demo', base: 'different', wait_ms: 0 })).status).toBe(404)
    expect((await t.post('wait', { repo: 'other/private', base: 'main', wait_ms: 0 })).status).toBe(403)
    expect(t.records()).toHaveLength(1); hold.release.resolve(); await t.preparations.settleRun(t.state.run.id)
  })

  it('keeps another Work in the same conversation out of both preparation wait and directory list', async () => {
    const t = await fixture()
    await t.post('start', { repo: 'org/demo', base: 'main' }); await t.preparations.settleRun(t.state.run.id)
    const old = t.records()[0]!
    t.attempts.finish(t.state.run.id, 'completed', Date.now())
    t.state.task = t.registry.createTaskOnce({ sessionKey: t.state.task.sessionKey, requesterOpenId: 'alice', messageId: 'independent-request', prompt: 'Another Work' }).task
    t.state.run = t.begin(t.state.task.id, 0); t.state.abort = new AbortController()
    expect((await t.post('list', {})).body).toMatchObject({ changes: [], preparations: [] })
    expect((await t.post('wait', { repo: 'org/demo', base: 'main', wait_ms: 0, operationKey: old.operationKey })).status).toBe(404)
    expect((await t.post('start', { repo: 'org/demo', base: 'main' }, { cap: { requesterOpenId: 'mallory' } })).status).toBe(403)
    expect(t.records()).toHaveLength(1)
  })

  it('retains signed scope, current source and Work control gates after the start HTTP already returned', async () => {
    const t = await fixture(), hold = t.holdFetch()
    expect((await t.post('start', { repo: 'org/demo', base: 'main' }, { cap: { scopes: ['github:read'] } })).status).toBe(403)
    await t.post('start', { repo: 'org/demo', base: 'main' }); await hold.entered.promise
    t.state.sourceSafe = false; hold.release.resolve(); await t.preparations.settleRun(t.state.run.id)
    expect(t.records()[0]!.state).toBe('retryable'); expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_changes').get()?.n).toBe(0)
    expect((await t.post('start', { repo: 'org/demo', base: 'main' })).status).toBe(403)
    // Only status is readable; it does not resume the failed write under read authority.
    expect((await t.post('wait', { repo: 'org/demo', base: 'main', wait_ms: 0 }, { cap: { scopes: ['github:read'] } })).body.preparation.state).toBe('retryable')
    const context = t.registry.workContexts.get(t.state.run.workKey)!
    t.registry.workContexts.control(t.state.run.workKey, { action: 'pause', reason: 'manual', causeRef: 'test-stop', expectedRevision: context.revision })
    expect((await t.post('wait', { repo: 'org/demo', base: 'main', wait_ms: 0 })).status).toBe(403)
  })

  it('real Run stop kills the actual Git child after the start request has already completed', async () => {
    const t = await fixture(), pidFile = join(t.home, 'git-child.pid')
    const code = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
    vi.spyOn(t.internal, 'git').mockImplementation((...args) => args[0][0] === 'fetch'
      ? t.actualGit(['-c', `alias.hold=!${quote(process.execPath)} -e ${quote(code)}`, 'hold'], undefined,
        { FRIDAY_GIT_AUTH_SCOPE: 'https://github.com/org/demo.git', FRIDAY_GIT_AUTH_HEADER: 'AUTHORIZATION: fixture-only' }, args[3], args[4]) : t.actualGit(...args))
    expect((await t.post('start', { repo: 'org/demo', base: 'main' })).status).toBe(200)
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true)); const pid = Number(readFileSync(pidFile, 'utf8'))
    t.state.abort.abort(); await t.preparations.settleRun(t.state.run.id)
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 })
    expect(t.records()[0]!.state).toBe('cancelled')
    expect(readdirSync(t.cacheDir).filter(name => name.startsWith('.auth-'))).toEqual([])
  })

  it('API shutdown drains a detached preparation even though no HTTP handler remains', async () => {
    const t = await fixture(), hold = t.holdFetch()
    await t.post('start', { repo: 'org/demo', base: 'main' }); await hold.entered.promise
    t.api.beginShutdown()
    expect(await t.api.waitForShutdown(5)).toEqual({ drained: false, pending: 1 })
    expect((await t.post('start', { repo: 'org/demo', base: 'main' })).status).toBe(503)
    hold.release.resolve()
    expect(await t.api.waitForShutdown(3000)).toEqual({ drained: true, pending: 0 })
    expect(t.records()[0]!.state).toBe('cancelled')
  })

  it('cannot silently use the legacy request-owned path when production preparation mounting lacks its Run signal', async () => {
    const t = await fixture({ missingRunSignal: true })
    expect((await t.post('start', { repo: 'org/demo', base: 'main' })).status).toBe(503)
    expect(t.records()).toEqual([])
  })
})
