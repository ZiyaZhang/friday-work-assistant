import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { assertRequestCurrent, withRequestLease } from '../src/core/request-lease.js'
import { ChangeManager } from '../src/github/changes.js'
import { ChangePreparationOperations } from '../src/github/preparation-operations.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { createLogger } from '../src/log.js'

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
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-preparation-operations-')))
  const seed = join(home, 'seed'), remote = join(home, 'remote.git'), cwd = join(home, 'workspace'), cache = join(home, 'cache')
  mkdirSync(seed); git(seed, 'init', '-q'); git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(seed, 'README.md'), 'real fixture content\n'); git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'initial')
  git(home, 'clone', '--bare', '--quiet', seed, remote)
  const registry = new Registry(join(home, 'state.sqlite'))
  const options = { db: registry.db, cacheDir: cache, github: { repoAllowed: (repo: string) => repo === 'org/demo' } as GitHubIdentity,
    log: createLogger('preparation-operations-test', 'error'), remoteUrlFor: () => `file://${remote}` }
  const changes = new ChangeManager(options), service = new ChangePreparationOperations({ changes }), run = new AbortController()
  let authorized = true
  const input = { cwd, repo: 'org/demo', base: 'main', sessionKey: 'session-alice', requesterOpenId: 'alice',
    workKey: 'original-work', operationKey: 'host-preparation-intent', attemptKey: 'run-original', runSignal: run.signal,
    assertCurrent() { assertRequestCurrent(); if (!authorized) throw new Error('original source revoked') } }
  const internal = changes as unknown as { git: GitMethod }, actualGit = internal.git.bind(changes)
  cleanups.push(async () => {
    service.beginShutdown(); expect((await service.waitForShutdown(3000)).drained).toBe(true)
    registry.close(); rmSync(home, { recursive: true, force: true })
  })
  function holdFetch() {
    const entered = deferred(), release = deferred(); releases.push(release.resolve)
    const spy = vi.spyOn(internal, 'git').mockImplementation(async (...args) => {
      if (args[0][0] === 'fetch') { entered.resolve(); await release.promise }
      return actualGit(...args)
    })
    return { entered, release, spy }
  }
  return { home, cwd, cache, registry, changes, service, options, input, run, internal, actualGit, holdFetch,
    authorize: (value: boolean) => { authorized = value } }
}

describe('Run-owned short-return repository preparation', () => {
  it('returns a persistent pending receipt before Git finishes; HTTP end cannot cancel that Run-owned effect', async () => {
    const t = fixture(), hold = t.holdFetch(), http = new AbortController(), refs: string[] = []
    const accepted = await withRequestLease(http.signal, () => t.service.start({ ...t.input, onPreparation: receipt => {
      refs.push(receipt.id); expect(t.changes.preparationStatus(receipt.id)).toBe('preparing')
    } }))
    expect(accepted.preparation.state).toBe('preparing'); expect(refs).toEqual([accepted.preparation.id])
    await hold.entered.promise; http.abort()
    expect(t.run.signal.aborted).toBe(false)
    expect(t.service.pendingForRun(t.input.attemptKey)).toBe(1)
    const duplicate = await t.service.start({ ...t.input, onPreparation: r => refs.push(r.id) })
    expect(duplicate.preparation.id).toBe(accepted.preparation.id); expect(refs).toEqual([refs[0], refs[0]])
    hold.release.resolve(); await t.service.settleRun(t.input.attemptKey)
    expect(hold.spy.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_changes').get()?.n).toBe(1)
    const ready = await t.service.wait(t.input, { timeoutMs: 0 })
    expect(ready.preparation.state).toBe('prepared')
    expect(readFileSync(join(ready.preparation.result!.dir, 'README.md'), 'utf8')).toBe('real fixture content\n')
  })

  it('bounds a wait and cancels only its caller, while the same effect can complete and be read later', async () => {
    const t = fixture(), hold = t.holdFetch()
    await t.service.start(t.input); await hold.entered.promise
    const query = new AbortController()
    const waiting = t.service.wait(t.input, { signal: query.signal, timeoutMs: 20_000 })
    const rejected = expect(waiting).rejects.toThrow('query ended'); query.abort(new Error('query ended')); await rejected
    expect(t.service.pendingForRun(t.input.attemptKey)).toBe(1); expect(t.run.signal.aborted).toBe(false)
    expect((await t.service.wait(t.input, { timeoutMs: 5 })).preparation.state).toBe('preparing')
    for (const timeoutMs of [20_001, -1, NaN, 0.5]) await expect(t.service.wait(t.input, { timeoutMs })).rejects.toThrow('20秒')
    hold.release.resolve()
    expect((await t.service.wait(t.input)).preparation.state).toBe('prepared')
  })

  it('does not mistake background completion for a model that consumed the prepared result', async () => {
    const t = fixture(), hold = t.holdFetch(), pending = await t.service.start(t.input)
    await hold.entered.promise
    expect(t.service.unobservedForRun(t.input.attemptKey)).toBe(true)
    hold.release.resolve(); await t.service.settleRun(t.input.attemptKey)
    expect(t.service.unobservedForRun(t.input.attemptKey)).toBe(true)
    const id = t.changes.preparationForRequest({ ...t.input })!.result!.id
    t.service.observeResultForRun('another-run', id); t.service.observeResultForRun(t.input.attemptKey, 'invented-change')
    expect(t.service.unobservedForRun(t.input.attemptKey)).toBe(true)
    t.service.observeResultForRun(t.input.attemptKey, id)
    expect(t.service.unobservedForRun(t.input.attemptKey)).toBe(false)
    // A host-return is tentative if its enclosing HTTP call never returned.
    t.service.markUnobservedForRun(t.input.attemptKey, pending.preparation.id)
    expect(t.service.unobservedForRun(t.input.attemptKey)).toBe(true)
    await t.service.wait(t.input, { timeoutMs: 0 })
    expect(t.service.unobservedForRun(t.input.attemptKey)).toBe(false)
    t.service.releaseRun(t.input.attemptKey)
    expect(t.service.pendingForRun(t.input.attemptKey)).toBe(0)
  })

  it('terminates real Git children and cleans credentials when the actual Run stops', async () => {
    const t = fixture(), pidFile = join(t.home, 'child.pid')
    const code = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
    vi.spyOn(t.internal, 'git').mockImplementation((...args) => args[0][0] === 'fetch'
      ? t.actualGit(['-c', `alias.hold=!${quote(process.execPath)} -e ${quote(code)}`, 'hold'], undefined,
        { FRIDAY_GIT_AUTH_SCOPE: 'https://github.com/org/demo.git', FRIDAY_GIT_AUTH_HEADER: 'AUTHORIZATION: fixture-only' }, args[3], args[4]) : t.actualGit(...args))
    await t.service.start(t.input)
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true))
    const pid = Number(readFileSync(pidFile, 'utf8'))
    t.run.abort(); await t.service.settleRun(t.input.attemptKey)
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 })
    expect(readdirSync(t.cache).filter(name => name.startsWith('.auth-'))).toEqual([])
    expect(t.changes.preparation(t.input)).toMatchObject({ state: 'cancelled', errorCode: 'request_cancelled' })
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_changes').get()?.n).toBe(0)
  })

  it('rechecks source authority after IO and never registers a late revoked checkout', async () => {
    const t = fixture(), hold = t.holdFetch()
    await t.service.start(t.input); await hold.entered.promise
    t.authorize(false); hold.release.resolve(); await t.service.settleRun(t.input.attemptKey)
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_changes').get()?.n).toBe(0)
    expect(() => t.service.read(t.input)).toThrow('source revoked')
    t.authorize(true)
    expect(t.service.read(t.input).preparation.state).toBe('retryable')
  })

  it('returns a failed receipt on repeated same-Run calls and only a fresh authorized attempt may retry', async () => {
    const t = fixture(), spy = vi.spyOn(t.internal, 'git').mockRejectedValueOnce(new Error('synthetic connection failure'))
    const original = await t.service.start(t.input); await t.service.settleRun(t.input.attemptKey)
    const again = await t.service.start(t.input)
    expect(again.preparation).toMatchObject({ id: original.preparation.id, state: 'retryable' })
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockImplementation(t.actualGit)
    const next = { ...t.input, attemptKey: 'host-admitted-next-run', runSignal: new AbortController().signal }
    expect((await t.service.start(next)).preparation.id).toBe(original.preparation.id)
    await t.service.settleRun(next.attemptKey)
    expect(t.service.read(next).preparation.state).toBe('prepared')
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_change_preparations').get()?.n).toBe(1)
  })

  it('holds drain ownership until cleanup, rejects new starts after shutdown and cannot release an active Run', async () => {
    const t = fixture(), hold = t.holdFetch()
    await t.service.start(t.input); await hold.entered.promise
    expect(() => t.service.releaseRun(t.input.attemptKey)).toThrow('尚未结束')
    t.service.beginShutdown()
    expect(await t.service.waitForShutdown(5)).toEqual({ drained: false, pending: 1 })
    await expect(t.service.start({ ...t.input, operationKey: 'new-operation' })).rejects.toThrow('正在关闭')
    hold.release.resolve()
    expect(await t.service.waitForShutdown(3000)).toEqual({ drained: true, pending: 0 })
    expect(t.changes.preparation(t.input)?.state).toBe('cancelled')
    t.service.releaseRun(t.input.attemptKey)
  })

  it('cancels only the retiring attempt effects without cancelling the external Run or another attempt', async () => {
    const t = fixture(), hold = t.holdFetch()
    await t.service.start(t.input); await hold.entered.promise
    const other = { ...t.input, operationKey: 'another-operation', attemptKey: 'other-attempt' }
    await t.service.start(other)
    t.service.cancelRun(t.input.attemptKey)
    expect(t.run.signal.aborted).toBe(false)
    hold.release.resolve(); await t.service.settleRun(t.input.attemptKey); await t.service.settleRun(other.attemptKey)
    expect(t.service.read(t.input).preparation.state).toBe('cancelled')
    expect(t.service.read(other).preparation.state).toBe('prepared')
  })

  it('reopens the durable receipt and denies another actor, session, Work, repo or base before exposing it', async () => {
    const t = fixture()
    await t.service.start(t.input); await t.service.settleRun(t.input.attemptKey)
    const original = t.service.read(t.input).preparation, reopenedDb = new DatabaseSync(join(t.home, 'state.sqlite'))
    const reopened = new ChangePreparationOperations({ changes: new ChangeManager({ ...t.options, db: reopenedDb }) })
    cleanups.push(async () => { reopened.beginShutdown(); await reopened.waitForShutdown(3000); reopenedDb.close() })
    expect(reopened.read(t.input).preparation.result?.id).toBe(original.result!.id)
    for (const changed of [{ requesterOpenId: 'mallory' }, { sessionKey: 'elsewhere' }, { workKey: 'another-work' },
      { workKey: undefined }, { repo: 'org/other' }, { base: 'another-base' }]) {
      expect(() => reopened.read({ ...t.input, ...changed })).toThrow('不属于')
      await expect(reopened.start({ ...t.input, ...changed })).rejects.toThrow('不属于')
    }
    expect((await reopened.start(t.input)).preparation.result?.id).toBe(original.result!.id)
  })

  it('does not replay orphaned preparation on service construction; startup reconciliation precedes a new host attempt', async () => {
    const t = fixture(), hold = t.holdFetch(), accepted = await t.service.start(t.input)
    await hold.entered.promise
    const reopenedDb = new DatabaseSync(join(t.home, 'state.sqlite'))
    const changes = new ChangeManager({ ...t.options, db: reopenedDb }), reopened = new ChangePreparationOperations({ changes })
    cleanups.push(async () => { reopened.beginShutdown(); await reopened.waitForShutdown(3000); reopenedDb.close() })
    expect(reopened.read(t.input).preparation.state).toBe('preparing')
    expect((await reopened.start({ ...t.input, attemptKey: 'new-run' })).preparation.state).toBe('preparing')
    expect(reopened.pendingForRun('new-run')).toBe(0)
    expect(changes.recoverPreparations()).toBe(1)
    t.run.abort(); hold.release.resolve(); await t.service.settleRun(t.input.attemptKey)
    expect(reopened.read(t.input).preparation).toMatchObject({ id: accepted.preparation.id, state: 'interrupted' })
    const retry = { ...t.input, runSignal: new AbortController().signal }
    expect((await reopened.start(retry)).preparation.state).toBe('interrupted')
    expect(hold.spy.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1)
    const next = { ...retry, attemptKey: 'new-run' }
    expect((await reopened.start(next)).preparation.id).toBe(accepted.preparation.id)
    await reopened.settleRun(next.attemptKey)
    expect(reopened.read(next).preparation.state).toBe('prepared')
    expect(reopenedDb.prepare('SELECT count(*) AS n FROM github_changes').get()?.n).toBe(1)
  })

  it('does not start Git if durable API-reference attachment fails or the Run is already stopped', async () => {
    const t = fixture(), spy = vi.spyOn(t.internal, 'git')
    await expect(t.service.start({ ...t.input, onPreparation() { throw new Error('reference not recorded') } })).rejects.toThrow('reference not recorded')
    expect(t.changes.preparation(t.input)).toMatchObject({ state: 'retryable', errorCode: 'receipt_unavailable' })
    expect(spy).not.toHaveBeenCalled(); expect(t.service.pendingForRun(t.input.attemptKey)).toBe(0)
    t.run.abort()
    await expect(t.service.start({ ...t.input, operationKey: 'different' })).rejects.toThrow()
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_change_preparations').get()?.n).toBe(1)
  })
})
