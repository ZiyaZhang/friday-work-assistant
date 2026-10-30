import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChangeManager, ChangePreparationError } from '../src/github/changes.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { createLogger } from '../src/log.js'

const cleanup: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()) })
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } }).trim()
}
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
type GitMethod = (args: string[], cwd?: string, env?: Record<string, string>, beforeStart?: () => void, signal?: AbortSignal) => Promise<string>
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-prepare-')))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const source = join(home, 'source'), bare = join(home, 'remote.git'), cwd = join(home, 'workspace'), cacheDir = join(home, 'git')
  mkdirSync(source); git(source, 'init', '-q'); git(source, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  for (let i = 0; i < 3; i++) { writeFileSync(join(source, 'README.md'), `version ${i}\n`); git(source, 'add', '.'); git(source, 'commit', '-qm', `revision ${i}`) }
  git(source, 'branch', 'unrelated-history'); git(source, 'tag', 'unneeded-tag')
  git(home, 'clone', '--quiet', '--bare', source, bare)
  const registry = new Registry(join(home, 'db.sqlite')); cleanup.push(() => registry.close())
  const github = { repoAllowed: (repo: string) => repo === 'org/demo' } as GitHubIdentity
  const options = { db: registry.db, cacheDir, github, log: createLogger('test', 'error'), remoteUrlFor: () => `file://${bare}`,
    author: { name: 'Test', email: 'test@example.test' } }
  const changes = new ChangeManager(options), internal = changes as unknown as { git: GitMethod }
  const actualGit = internal.git.bind(changes)
  const input = { repo: 'org/demo', base: 'main', cwd, sessionKey: 'session-a', requesterOpenId: 'alice', operationKey: 'work:7:input:9:org/demo:main', attemptKey: 'run-1' }
  return { home, source, bare, cwd, cacheDir, registry, changes, options, input, internal, actualGit }
}

describe('durable bounded change preparation', () => {
  it('reserves and exposes its real receipt before IO; duplicate calls and a reopened manager reuse one copy', async () => {
    const t = fixture(), entered = deferred(), release = deferred(), receipts: string[] = []
    const spy = vi.spyOn(t.internal, 'git').mockImplementation(async (...args) => {
      if (args[0][0] === 'fetch') { entered.resolve(); await release.promise }
      return t.actualGit(...args)
    })
    const hook = ({ id }: { id: string }) => { receipts.push(id); expect(t.changes.preparationStatus(id)).toBeDefined() }
    const first = t.changes.prepare({ ...t.input, onPreparation: hook })
    expect(receipts).toHaveLength(1); expect(t.changes.preparationStatus(receipts[0]!)).toBe('preparing')
    await entered.promise
    const second = t.changes.prepare({ ...t.input, branchHint: 'cosmetic retry', onPreparation: hook })
    expect(receipts[1]).toBe(receipts[0]); release.resolve()
    const [a, b] = await Promise.all([first, second]); expect(b).toMatchObject({ id: a.id, replayed: true })
    const restarted = new ChangeManager(t.options)
    expect(await restarted.prepare(t.input)).toMatchObject({ id: a.id, operationId: receipts[0], replayed: true })
    expect(spy.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_changes').get()?.n).toBe(1)
    expect(t.changes.preparation({ ...t.input })?.result?.id).toBe(a.id)
    expect(() => t.changes.preparation({ ...t.input, requesterOpenId: 'mallory' })).toThrow('不属于')
    expect(t.changes.listPreparations(t.input)).toHaveLength(1)
    expect(t.changes.listPreparations({ ...t.input, requesterOpenId: 'mallory' })).toEqual([])
    expect(t.changes.listPreparations({ ...t.input, sessionKey: 'other-session' })).toEqual([])
  })
  it('cancels a queued cache waiter immediately and never starts its token/Git work after the first owner exits', async () => {
    const t = fixture(), entered = deferred(), release = deferred(), abort = new AbortController()
    const spy = vi.spyOn(t.internal, 'git').mockImplementation(async (...args) => {
      if (args[0][0] === 'fetch') { entered.resolve(); await release.promise }
      return t.actualGit(...args)
    })
    const first = t.changes.prepare(t.input); await entered.promise
    const queued = t.changes.prepare({ ...t.input, operationKey: 'other-input', signal: abort.signal })
    await vi.waitFor(() => expect((t.changes as unknown as { queue: { pending(key: string): number } }).queue.pending('cache:org/demo')).toBe(2))
    const rejected = expect(queued).rejects.toThrow('request ended'); abort.abort(new Error('request ended')); await rejected
    expect(t.changes.preparation({ ...t.input, operationKey: 'other-input' })?.state).toBe('cancelled')
    release.resolve(); await first
    expect(spy.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1)
    await expect(t.changes.prepare({ ...t.input, operationKey: 'other-input' })).rejects.toBeInstanceOf(ChangePreparationError)
    expect(spy.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1)
  })
  it.each(['copy', 'git'] as const)('does not replay success or clone again after the prepared %s directory is removed', async removed => {
    const t = fixture(), prepared = await t.changes.prepare(t.input), spy = vi.spyOn(t.internal, 'git')
    rmSync(removed === 'copy' ? prepared.dir : join(prepared.dir, '.git'), { recursive: true, force: true })
    await expect(t.changes.prepare(t.input)).rejects.toThrow('原修改副本已不可用')
    expect(spy).not.toHaveBeenCalled()
    expect(t.changes.preparation(t.input)).toMatchObject({ state: 'prepared', result: { id: prepared.id } })
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_changes').get()?.n).toBe(1)
  })
  it('terminates real Git descendants on cancellation and retains no temporary credential file or successful copy', async () => {
    const t = fixture(), entered = join(t.home, 'child.pid'), abort = new AbortController()
    const code = `require('fs').writeFileSync(${JSON.stringify(entered)},String(process.pid));setInterval(()=>{},1000)`
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
    vi.spyOn(t.internal, 'git').mockImplementation((...args) => args[0][0] === 'fetch'
      ? t.actualGit(['-c', `alias.hold=!${quote(process.execPath)} -e ${quote(code)}`, 'hold'], undefined,
        { FRIDAY_GIT_AUTH_SCOPE: 'https://github.com/org/demo.git', FRIDAY_GIT_AUTH_HEADER: 'AUTHORIZATION: fake-test-only' }, args[3], args[4]) : t.actualGit(...args))
    const pending = t.changes.prepare({ ...t.input, signal: abort.signal })
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(existsSync(entered)).toBe(true)); const pid = Number(readFileSync(entered, 'utf8'))
    abort.abort(); await rejected
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 })
    expect(readdirSync(t.cacheDir).filter(name => name.startsWith('.auth-'))).toEqual([])
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_changes').get()?.n).toBe(0)
    expect(t.changes.preparation(t.input)).toMatchObject({ state: 'cancelled', errorCode: 'request_cancelled' })
  })
  it('does not retry a failed attempt from the same Run, but a newly admitted Run can prepare safely', async () => {
    const t = fixture()
    const spy = vi.spyOn(t.internal, 'git').mockRejectedValueOnce(new Error('provider unavailable'))
    await expect(t.changes.prepare(t.input)).rejects.toThrow('provider unavailable')
    expect(t.changes.preparation(t.input)?.state).toBe('retryable')
    await expect(t.changes.prepare(t.input)).rejects.toBeInstanceOf(ChangePreparationError)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockImplementation(t.actualGit)
    const prepared = await t.changes.prepare({ ...t.input, attemptKey: 'run-2-after-host-recovery' })
    expect(t.changes.preparation(t.input)).toMatchObject({ state: 'prepared', result: { id: prepared.id }, attemptKey: 'run-2-after-host-recovery' })
  })
  it('recovers interrupted local preparation only through an explicit startup action and a new host attempt', async () => {
    const t = fixture(), entered = deferred(), release = deferred()
    vi.spyOn(t.internal, 'git').mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new Error('old worker ended') })
    const old = t.changes.prepare(t.input), rejected = expect(old).rejects.toThrow('old worker ended'); await entered.promise
    const reopened = new ChangeManager(t.options)
    expect(reopened.preparation(t.input)?.state).toBe('preparing')
    expect(reopened.recoverPreparations()).toBe(1); release.resolve(); await rejected
    expect(reopened.preparation(t.input)?.state).toBe('interrupted')
    await expect(reopened.prepare(t.input)).rejects.toBeInstanceOf(ChangePreparationError)
    expect((await reopened.prepare({ ...t.input, attemptKey: 'new-run' })).history).toBe('base_snapshot')
  })
  it('never begins IO if recording the host operation receipt fails', async () => {
    const t = fixture(), spy = vi.spyOn(t.internal, 'git')
    await expect(t.changes.prepare({ ...t.input, onPreparation: () => { throw new Error('receipt transaction failed') } })).rejects.toThrow('receipt transaction failed')
    expect(spy).not.toHaveBeenCalled()
    expect(t.changes.preparation(t.input)).toMatchObject({ state: 'retryable', errorCode: 'receipt_unavailable' })
  })
  it('rechecks authorization after default-branch and Git awaits and prevents late checkout registration', async () => {
    const t = fixture(); let live = true
    vi.spyOn(t.internal, 'git').mockImplementationOnce(async (...args) => { const result = await t.actualGit(...args); live = false; return result })
    await expect(t.changes.prepare({ ...t.input, assertAuthorized: () => { if (!live) throw new Error('run revoked') } })).rejects.toThrow('run revoked')
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_changes').get()?.n).toBe(0)
  })
  it('fetches only the selected base snapshot while preserving actual commits, trusted snapshots and push ancestry', async () => {
    const t = fixture(), prepared = await t.changes.prepare(t.input), cache = join(t.cacheDir, 'org__demo.git')
    expect(git(cache, 'rev-parse', '--is-shallow-repository')).toBe('true')
    expect(git(cache, 'rev-list', '--count', 'refs/heads/main')).toBe('1')
    expect(git(cache, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main')
    expect(git(prepared.dir, 'rev-parse', '--is-shallow-repository')).toBe('true')
    writeFileSync(join(prepared.dir, 'README.md'), 'actual change\n')
    const inspected = await t.changes.inspect({ ...t.input, dir: prepared.dir })
    const published = await t.changes.publish({ ...t.input, dir: prepared.dir, title: 'Fix', body: 'Evidence', expectedSnapshot: inspected.snapshot })
    expect(git(t.bare, 'rev-parse', `${published.head}^`)).toBe(prepared.head)
    expect(git(t.bare, 'rev-list', '--count', published.head)).toBe('4')
    // Advancing upstream does not change the previously approved base or require a full mirror.
    writeFileSync(join(t.source, 'new.txt'), 'new base\n'); git(t.source, 'add', '.'); git(t.source, 'commit', '-qm', 'advance')
    git(t.source, 'push', '--quiet', t.bare, 'main')
    const next = await t.changes.prepare({ ...t.input, operationKey: 'new-input-after-base-advanced' })
    expect(next.head).not.toBe(prepared.head)
    expect(git(cache, 'rev-list', '--count', 'refs/heads/main')).toBe('1')
    expect((await t.changes.prepare(t.input)).head).toBe(prepared.head)
  })
})
