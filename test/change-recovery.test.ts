import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChangeManager, MARKER_FILE } from '../src/github/changes.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { createLogger } from '../src/log.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: {
    PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test',
  } }).trim()
}
async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-change-recovery-')))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const src = join(home, 'src'), bare = join(home, 'remote.git'), cwd = join(home, 'workspace')
  mkdirSync(src)
  git(src, 'init', '-q')
  git(src, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(src, 'README.md'), 'original\n')
  git(src, 'add', '-A'); git(src, 'commit', '-qm', 'initial')
  git(home, 'clone', '--quiet', '--bare', src, bare)
  const dbPath = join(home, 'registry.db')
  let registry = new Registry(dbPath)
  cleanups.push(() => registry.close())
  const calls: { method: string; path: string; body?: unknown }[] = []
  const prs: Record<string, unknown>[] = []
  const failure = { post: false, postUnknown: false, read: false, list: false }
  const hooks = { beforePost: () => {} }
  const github = {
    repoAllowed: (repo: string) => repo === 'org/demo',
    repoWritable: (repo: string) => repo === 'org/demo',
    async api(method: string, path: string, body?: Record<string, unknown>, _owner?: string, beforeRequest?: () => void) {
      if (method === 'POST') hooks.beforePost()
      beforeRequest?.()
      calls.push({ method, path, body })
      if (path.includes('/pulls?')) {
        if (failure.list) throw new Error('list failed')
        return prs
      }
      if (method === 'POST' && path.endsWith('/pulls')) {
        if (failure.postUnknown) throw new Error('network timeout before response')
        const pr = { number: prs.length + 1, html_url: `https://github.com/org/demo/pull/${prs.length + 1}`,
          head: { ref: body!.head, sha: git(bare, 'rev-parse', String(body!.head)), repo: { full_name: 'org/demo' } },
          base: { ref: body!.base, repo: { full_name: 'org/demo' } }, state: 'open', draft: true }
        prs.push(pr)
        if (failure.post) throw new Error('network timeout after remote accepted')
        return pr
      }
      if (/\/pulls\/\d+$/.test(path)) {
        if (failure.read) throw new Error('readback failed')
        return prs.find((pr) => pr.number === Number(path.split('/').at(-1)))!
      }
      throw new Error(`unexpected fake GitHub call: ${method} ${path}`)
    },
  } as unknown as GitHubIdentity
  const manager = () => new ChangeManager({ db: registry.db, cacheDir: join(home, 'gateway-git'), github, log: createLogger('test', 'error'), remoteUrlFor: () => `file://${bare}`, createPullRequests: true, author: { name: 'Friday', email: 'friday@example.test' } })
  let changes = manager()
  const actor = { cwd, sessionKey: 'session-a', requesterOpenId: 'ou_a' }
  const prepared = await changes.prepare({ ...actor, repo: 'org/demo', branchHint: 'small fix' })
  writeFileSync(join(prepared.dir, 'README.md'), 'fixed\n')
  const inspected = await changes.inspect({ ...actor, dir: prepared.dir })
  const input = { ...actor, dir: prepared.dir, expectedSnapshot: inspected.snapshot, title: 'Fix demo', body: 'A small fix', draft: true }
  return { home, bare, cwd, calls, prs, failure, hooks, actor, prepared, input,
    get changes() { return changes }, get registry() { return registry },
    reopen() { registry.close(); registry = new Registry(dbPath); changes = manager() },
    posts() { return calls.filter((call) => call.method === 'POST').length },
    state() { return registry.db.prepare('SELECT state FROM github_changes WHERE id = ?').get(prepared.id)!.state },
  }
}

describe('change ownership and approval snapshot', () => {
  it('allocates independent directories for every preparation and persists ownership across restart', async () => {
    const f = await fixture()
    const second = await f.changes.prepare({ ...f.actor, repo: 'org/demo' })
    const other = await f.changes.prepare({ ...f.actor, sessionKey: 'session-b', repo: 'org/demo' })
    expect(new Set([f.prepared.dir, second.dir, other.dir]).size).toBe(3)
    expect(readFileSync(join(second.dir, 'README.md'), 'utf8')).toBe('original\n')
    f.reopen()
    await expect(f.changes.inspect({ ...f.actor, dir: f.prepared.dir })).resolves.toMatchObject({ snapshot: f.input.expectedSnapshot })
    await expect(f.changes.publish({ ...f.input, sessionKey: 'session-b' })).rejects.toThrow('不属于当前会话')
    await expect(f.changes.publish({ ...f.input, requesterOpenId: 'ou_b' })).rejects.toThrow('不属于当前会话')
    expect(f.posts()).toBe(0)
  })

  it('takes repo/base/branch from the DB even if the worker forges its marker', async () => {
    const f = await fixture()
    writeFileSync(join(f.prepared.dir, MARKER_FILE), JSON.stringify({ repo: 'evil/other', branch: 'main', base: 'attacker' }))
    expect(f.changes.readMarker(f.prepared.dir)).toMatchObject({ repo: 'org/demo', branch: f.prepared.branch, base: 'main' })
    const result = await f.changes.publish(f.input)
    expect(result.repo).toBe('org/demo')
    expect(git(f.bare, 'show', `${f.prepared.branch}:README.md`)).toBe('fixed')
    expect(f.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ head: f.prepared.branch, base: 'main', draft: true })
  })

  it('rejects unregistered checkouts and changes after the approval snapshot', async () => {
    const f = await fixture()
    const forged = join(f.cwd, 'work', 'forged')
    mkdirSync(forged)
    writeFileSync(join(forged, MARKER_FILE), JSON.stringify(f.changes.readMarker(f.prepared.dir)))
    await expect(f.changes.inspect({ ...f.actor, dir: forged })).rejects.toThrow('不是 github_start_change')
    writeFileSync(join(f.prepared.dir, 'README.md'), 'changed after confirmation\n')
    await expect(f.changes.publish(f.input)).rejects.toThrow('确认后变化')
    expect(git(f.bare, 'branch', '--list', f.prepared.branch)).toBe('')
    expect(f.posts()).toBe(0)
  })

  it.each(['branch', 'origin', 'gitdir'] as const)('rejects worker %s tampering', async (kind) => {
    const f = await fixture()
    if (kind === 'branch') git(f.prepared.dir, 'checkout', '-qb', 'other')
    if (kind === 'origin') git(f.prepared.dir, 'remote', 'set-url', 'origin', 'https://example.invalid/other.git')
    if (kind === 'gitdir') {
      const alternate = join(f.home, 'other.git')
      git(f.home, 'clone', '--quiet', '--bare', f.bare, alternate)
      rmSync(join(f.prepared.dir, '.git'), { recursive: true })
      symlinkSync(alternate, join(f.prepared.dir, '.git'))
    }
    await expect(f.changes.publish(f.input)).rejects.toThrow(/登记不符|Git 目录已经改变/)
    expect(f.posts()).toBe(0)
  })

  it('uses only gateway git config/index/hooks when publishing worker files', async () => {
    const f = await fixture()
    const witness = join(f.home, 'unsafe-executed')
    const hook = join(f.prepared.dir, '.git', 'hooks', 'pre-push')
    writeFileSync(hook, `#!/bin/sh\ntouch '${witness}'\n`); chmodSync(hook, 0o755)
    const poison = `sh -c "touch '${witness}'; cat"`
    git(f.prepared.dir, 'config', 'filter.poison.clean', poison)
    git(f.prepared.dir, 'config', 'filter.poison.required', 'true')
    git(f.prepared.dir, 'config', 'core.fsmonitor', poison)
    writeFileSync(join(f.prepared.dir, '.gitattributes'), 'README.md filter=poison\n')
    const inspection = await f.changes.inspect({ ...f.actor, dir: f.prepared.dir })
    await f.changes.publish({ ...f.input, expectedSnapshot: inspection.snapshot })
    expect(existsSync(witness)).toBe(false)
    expect(git(f.bare, 'show', `${f.prepared.branch}:README.md`)).toBe('fixed')
  })

  it('loads HTTP auth from a temporary config and removes it after success or failure', async () => {
    const f = await fixture()
    // Exercise the real git config parser; the credential is a fake test string and no network is used.
    const runGit = (f.changes as unknown as { git(args: string[], cwd?: string, env?: Record<string, string>): Promise<string> }).git.bind(f.changes)
    const fakeAuth = { FRIDAY_GIT_AUTH_SCOPE: 'https://github.com/org/demo.git', FRIDAY_GIT_AUTH_HEADER: 'AUTHORIZATION: test-only' }
    expect(await runGit(['config', '--get-urlmatch', 'http.extraheader', 'https://github.com/org/demo.git'], undefined, fakeAuth)).toBe('AUTHORIZATION: test-only')
    await expect(runGit(['not-a-git-command'], undefined, fakeAuth)).rejects.toThrow('not-a-git-command')
    expect(readdirSync(join(f.home, 'gateway-git')).filter((name) => name.startsWith('.auth-'))).toEqual([])
  })

  it('rejects a symlinked work root and a cache writable inside the worker workspace', async () => {
    const f = await fixture()
    const otherCwd = join(f.home, 'other-workspace')
    mkdirSync(otherCwd); symlinkSync(join(f.cwd, 'work'), join(otherCwd, 'work'))
    await expect(f.changes.prepare({ ...f.actor, cwd: otherCwd, repo: 'org/demo' })).rejects.toThrow('符号链接')
    const bad = new ChangeManager({ db: f.registry.db, cacheDir: join(f.cwd, 'cache'), github: { repoAllowed: () => true } as unknown as GitHubIdentity, log: createLogger('test', 'error') })
    await expect(bad.prepare({ ...f.actor, repo: 'org/demo' })).rejects.toThrow('worker 工作区之外')
  })
})

describe('PR publication recovery', () => {
  it('rechecks after Git awaits before push and leaves an unpushed change retryable', async () => {
    const f = await fixture()
    let allowed = true
    const target = f.changes as unknown as { git(args: string[], cwd?: string, env?: Record<string, string>): Promise<string> }
    const original = target.git.bind(f.changes)
    const spy = vi.spyOn(target, 'git').mockImplementation(async (args, cwd, env) => {
      const result = await original(args, cwd, env)
      if (args.includes('ls-remote')) allowed = false
      return result
    })
    const input = { ...f.input, assertAuthorized: () => { if (!allowed) throw new Error('authorization revoked') } }
    await expect(f.changes.publish(input)).rejects.toThrow('authorization revoked')
    expect(git(f.bare, 'branch', '--list', f.prepared.branch)).toBe('')
    expect(f.state()).toBe('push_planned'); expect(f.posts()).toBe(0)
    spy.mockRestore(); allowed = true
    await expect(f.changes.publish(input)).resolves.toMatchObject({ number: 1 })
  })

  it('does not mark a PR unknown when authorization is revoked before HTTP starts', async () => {
    const f = await fixture()
    let allowed = true
    f.hooks.beforePost = () => { allowed = false }
    const input = { ...f.input, assertAuthorized: () => { if (!allowed) throw new Error('authorization revoked') } }
    await expect(f.changes.publish(input)).rejects.toThrow('authorization revoked')
    expect(f.state()).toBe('pushed'); expect(f.posts()).toBe(0)
    f.reopen(); allowed = true; f.hooks.beforePost = () => {}
    await expect(f.changes.publish(input)).resolves.toMatchObject({ number: 1 })
    expect(f.posts()).toBe(1)
  })

  it('serializes concurrent identical publication and rejects a different intent on the same checkout', async () => {
    const f = await fixture()
    const alias = join(f.home, 'same-checkout')
    symlinkSync(f.prepared.dir, alias)
    const [a, b] = await Promise.all([f.changes.publish(f.input), f.changes.publish({ ...f.input, dir: alias })])
    expect(a.number).toBe(1); expect(b.number).toBe(1); expect(b.replayed).toBe(true)
    expect(f.posts()).toBe(1)
    await expect(f.changes.publish({ ...f.input, title: 'Different task' })).rejects.toThrow('已开始发布其他改动')
    await expect(f.changes.publish({ ...f.input, draft: false })).rejects.toThrow('只支持 draft')
  })

  it('records a successful POST number before GET and resumes only readback after restart', async () => {
    const f = await fixture(); f.failure.read = true
    await expect(f.changes.publish(f.input)).rejects.toThrow('readback failed')
    expect(f.state()).toBe('pr_sent'); expect(f.posts()).toBe(1)
    f.reopen(); f.failure.read = false
    expect((await f.changes.publish(f.input)).number).toBe(1)
    expect(f.posts()).toBe(1); expect(f.state()).toBe('confirmed')
  })

  it('recovers a POST with an unknown result by querying all PR states, without another POST', async () => {
    const f = await fixture(); f.failure.post = true
    await expect(f.changes.publish(f.input)).rejects.toThrow('结果未知')
    expect(f.state()).toBe('pr_unknown'); expect(f.posts()).toBe(1)
    f.prs[0]!.state = 'closed'
    f.reopen()
    expect((await f.changes.publish(f.input)).number).toBe(1)
    expect(f.posts()).toBe(1)
    expect(f.calls.filter((c) => c.path.includes('/pulls?')).every((c) => c.path.includes('state=all'))).toBe(true)
  })

  it.each(['pr_unknown', 'pr_planned'])('never repeats POST when persisted %s has no visible PR', async (state) => {
    const f = await fixture(); f.failure.postUnknown = true
    await expect(f.changes.publish(f.input)).rejects.toThrow('结果未知')
    f.registry.db.prepare('UPDATE github_changes SET state = ? WHERE id = ?').run(state, f.prepared.id)
    f.reopen(); f.failure.postUnknown = false
    await expect(f.changes.publish(f.input)).rejects.toThrow('结果未知')
    expect(f.posts()).toBe(1)
  })

  it('does not treat a failed lookup as no match or create a PR', async () => {
    const f = await fixture(); f.failure.list = true
    await expect(f.changes.publish(f.input)).rejects.toThrow('list failed')
    expect(f.posts()).toBe(0); expect(f.state()).toBe('pushed')
    f.failure.list = false
    await f.changes.publish(f.input)
    expect(f.posts()).toBe(1)
  })

  it('does not create another PR when the exact branch has an unexpected head', async () => {
    const f = await fixture(); f.failure.list = true
    await expect(f.changes.publish(f.input)).rejects.toThrow('list failed')
    f.failure.list = false
    f.prs.push({ number: 8, head: { ref: f.prepared.branch, sha: 'different', repo: { full_name: 'org/demo' } }, base: { ref: 'main', repo: { full_name: 'org/demo' } } })
    await expect(f.changes.publish(f.input)).rejects.toThrow('head 提交')
    expect(f.posts()).toBe(0)
  })

  it('rechecks the pushed remote head before PR creation after an interrupted lookup', async () => {
    const f = await fixture(); f.failure.list = true
    await expect(f.changes.publish(f.input)).rejects.toThrow('list failed')
    git(f.bare, 'update-ref', `refs/heads/${f.prepared.branch}`, git(f.bare, 'rev-parse', 'main'))
    f.reopen(); f.failure.list = false
    await expect(f.changes.publish(f.input)).rejects.toThrow('推送后变化')
    expect(f.posts()).toBe(0)
  })

  it('recovers an accepted push before its local acknowledgment without making a second commit', async () => {
    const f = await fixture()
    f.registry.db.exec("CREATE TRIGGER fail_push_ack BEFORE UPDATE OF state ON github_changes WHEN NEW.state = 'pushed' BEGIN SELECT RAISE(ABORT, 'crash after push'); END")
    await expect(f.changes.publish(f.input)).rejects.toThrow('crash after push')
    const head = git(f.bare, 'rev-parse', f.prepared.branch)
    expect(f.state()).toBe('push_planned'); expect(f.posts()).toBe(0)
    f.registry.db.exec('DROP TRIGGER fail_push_ack'); f.reopen()
    expect((await f.changes.publish(f.input)).head).toBe(head)
    expect(git(f.bare, 'rev-parse', f.prepared.branch)).toBe(head)
    expect(f.posts()).toBe(1)
  })
})
