import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChangeManager } from '../src/github/changes.js'
import { GitHubIdentity, type GitHubHttp } from '../src/github/identity.js'
import { createLogger } from '../src/log.js'

const cleanups: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: {
    PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test',
  } }).trim()
}
type GitRunner = { git(args: string[], cwd?: string, env?: Record<string, string>, beforeStart?: () => void, signal?: AbortSignal): Promise<string> }
async function fixture(options: { repo?: string; responseRepo?: string } = {}) {
  const repo = options.repo ?? 'org/demo', responseRepo = options.responseRepo ?? repo
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-change-update-')))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const src = join(home, 'src'), bare = join(home, 'remote.git'), cwd = join(home, 'workspace'), dbPath = join(home, 'registry.db')
  mkdirSync(src)
  git(src, 'init', '-q'); git(src, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(src, 'README.md'), 'original\n')
  git(src, 'add', '-A'); git(src, 'commit', '-qm', 'initial')
  git(home, 'clone', '--quiet', '--bare', src, bare)
  let registry = new Registry(dbPath)
  cleanups.push(() => registry.close())
  const calls: { method: string; path: string; body?: unknown }[] = []
  const state = { closed: false, merged: false, wrongRepo: false, wrongBase: false, wrongBranch: false,
    baseCaseChanged: false, branchCaseChanged: false, readFailure: false, losePostAck: false, prHead: undefined as string | undefined }
  let branch = '', number = 0
  const hooks = { read: () => {} }
  const pr = () => ({ number, html_url: `https://github.com/${responseRepo}/pull/${number}`, state: state.closed ? 'closed' : 'open', merged: state.merged,
    head: { ref: state.wrongBranch ? 'someone/else' : state.branchCaseChanged ? branch.toUpperCase() : branch,
      sha: state.prHead ?? git(bare, 'rev-parse', branch), repo: { full_name: state.wrongRepo ? 'other/repo' : responseRepo } },
    base: { ref: state.wrongBase ? 'other-base' : state.baseCaseChanged ? 'MAIN' : 'main', repo: { full_name: responseRepo } }, draft: true })
  const http = { async request(method: string, path: string, body?: Record<string, unknown>) {
    calls.push({ method, path, body })
    if (path.includes('/pulls?')) return { status: 200, data: number ? [pr()] : [] }
    if (method === 'POST' && path.endsWith('/pulls')) {
      branch = String(body!.head); number++
      if (state.losePostAck) throw new Error('PR POST ACK lost')
      return { status: 201, data: pr() }
    }
    if (method === 'GET' && /\/pulls\/\d+$/.test(path)) {
      hooks.read()
      if (state.readFailure) throw new Error('PR readback unavailable')
      return { status: 200, data: pr() }
    }
    throw new Error(`Unexpected HTTP ${method} ${path}`)
  } } as GitHubHttp
  const github = new GitHubIdentity({ apiUrl: 'https://api.github.com', mode: 'pat', token: 'synthetic-only', allowedRepos: [repo], writableRepos:[repo] }, createLogger('test', 'error'), http)
  const log = createLogger('test', 'error')
  const manager = () => new ChangeManager({ db: registry.db, cacheDir: join(home, 'gateway-git'), github, log,
    remoteUrlFor: () => `file://${bare}`, createPullRequests: true, author: { name: 'Friday', email: 'friday@example.test' } })
  let changes = manager()
  const actor = { cwd, sessionKey: 'session-a', requesterOpenId: 'ou_a' }
  const prepared = await changes.prepare({ ...actor, repo })
  writeFileSync(join(prepared.dir, 'README.md'), 'first fix\n')
  const inspect = await changes.inspect({ ...actor, dir: prepared.dir })
  const publishInput = { ...actor, dir: prepared.dir, expectedSnapshot: inspect.snapshot, title: 'First fix', body: 'Initial PR' }
  const initial = await changes.publish(publishInput)
  return { home, src, bare, actor, prepared, initial, publishInput, calls, github, state, hooks, log,
    get changes() { return changes }, get registry() { return registry },
    reopen() { registry.close(); registry = new Registry(dbPath); changes = manager() },
    head() { return git(bare, 'rev-parse', prepared.branch) },
    edits(text = 'review adjustment\n', file = 'review.txt') { writeFileSync(join(prepared.dir, file), text) },
    async input() {
      const inspected = await changes.inspectUpdate({ ...actor, dir: prepared.dir })
      return { ...actor, dir: prepared.dir, title: 'Address review', body: 'Only this commit message', expectedSnapshot: inspected.snapshot, expectedHead: inspected.expectedHead }
    },
    row() { return registry.db.prepare('SELECT * FROM github_changes WHERE id = ?').get(prepared.id) },
    updates() { return registry.db.prepare('SELECT * FROM github_change_updates ORDER BY rowid').all() },
    advance() {
      git(src, 'fetch', '--quiet', bare, prepared.branch)
      git(src, 'checkout', '--quiet', '--detach', 'FETCH_HEAD')
      writeFileSync(join(src, 'human.txt'), 'human contribution\n')
      git(src, 'add', '-A'); git(src, 'commit', '-qm', 'human update')
      git(src, 'push', '--quiet', bare, `HEAD:refs/heads/${prepared.branch}`)
      return git(src, 'rev-parse', 'HEAD')
    },
  }
}

describe('same-PR review updates', () => {
  it('accepts GitHub canonical owner/repo casing through create readback, replay, update and lifecycle', async () => {
    const f=await fixture({repo:'ZhixingLu/Dsh-Visualizer-Benchmark',responseRepo:'ZhixingLu/dsh-visualizer-benchmark'})
    expect(f.initial).toMatchObject({repo:'zhixinglu/dsh-visualizer-benchmark',number:1,phase:'confirmed'})
    expect(await f.changes.publish(f.publishInput)).toMatchObject({number:1,head:f.initial.head,replayed:true})
    expect(await f.changes.lifecycle({...f.actor,dir:f.prepared.dir})).toMatchObject({number:1,phase:'draft',draft:true})
    f.edits();const input=await f.input(),updated=await f.changes.updatePr(input)
    expect(updated.number).toBe(f.initial.number);expect(git(f.bare,'rev-parse',`${updated.head}^`)).toBe(f.initial.head)
    expect(await f.changes.updatePr(input)).toMatchObject({number:1,head:updated.head,replayed:true})
    expect(f.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/pulls'))).toHaveLength(1)
    expect(f.calls.every(call=>call.path.startsWith('/repos/zhixinglu/dsh-visualizer-benchmark/'))).toBe(true)
    f.state.closed=true
    expect(await f.changes.lifecycle({...f.actor,dir:f.prepared.dir})).toMatchObject({phase:'closed',closed:true,merged:false})
  })

  it.each(['baseCaseChanged','branchCaseChanged'] as const)('still refuses a different case-sensitive Git ref: %s',async key=>{
    const f=await fixture({repo:'ZhixingLu/dsh-visualizer-benchmark',responseRepo:'ZhixingLu/dsh-visualizer-benchmark'})
    f.edits();const input=await f.input();f.state[key]=true
    await expect(f.changes.updatePr(input)).rejects.toThrow('与登记不符')
    expect(f.head()).toBe(f.initial.head);expect(f.updates()).toEqual([])
  })

  it('pushes child commits, shows only the new delta, and preserves the initial publication receipt', async () => {
    const f = await fixture(), initialRow = { ...f.row() }
    await expect(f.changes.inspectUpdate({ ...f.actor, dir: f.prepared.dir })).resolves.toMatchObject({ noChanges: true, files: [], expectedHead: f.initial.head })
    f.edits()
    const inspection = await f.changes.inspectUpdate({ ...f.actor, dir: f.prepared.dir })
    expect(inspection).toMatchObject({ expectedHead: f.initial.head, prNumber: 1, files: ['review.txt'] })
    expect(inspection.stat).not.toContain('README.md')
    const first = await f.changes.updatePr(await f.input())
    expect(first).toMatchObject({ number: 1, files: ['review.txt'], phase: 'confirmed' })
    expect(git(f.bare, 'rev-parse', `${first.head}^`)).toBe(f.initial.head)
    expect(git(f.bare, 'show', `${first.head}:README.md`)).toBe('first fix')
    expect(git(f.bare, 'show', `${first.head}:review.txt`)).toBe('review adjustment')
    f.edits('second adjustment\n', 'second.txt')
    const secondInput = await f.input()
    expect(secondInput.expectedHead).toBe(first.head)
    const second = await f.changes.updatePr(secondInput)
    expect(second.files).toEqual(['second.txt'])
    expect(git(f.bare, 'rev-parse', `${second.head}^`)).toBe(first.head)
    expect(f.row()).toEqual(initialRow)
    expect(f.calls.filter((call) => call.method !== 'GET')).toEqual([expect.objectContaining({ method: 'POST', body: expect.objectContaining({ title: 'First fix' }) })])
    expect(f.updates()).toHaveLength(2)
    expect(f.changes.list(f.actor)[0]).toMatchObject({ commitId: second.head, state: 'confirmed', prNumber: 1 })
    expect(await f.changes.inspectUpdate({ ...f.actor, dir: f.prepared.dir })).toMatchObject({ noChanges: true, files: [], expectedHead: second.head, prNumber: 1, prUrl: second.url })
    // Original publish is not an update endpoint and never returns a newer head under its old snapshot.
    writeFileSync(join(f.prepared.dir, 'README.md'), 'first fix\n')
    rmSync(join(f.prepared.dir, 'review.txt')); rmSync(join(f.prepared.dir, 'second.txt'))
    expect(await f.changes.publish(f.publishInput)).toMatchObject({ head: f.initial.head, replayed: true })
  })

  it('serializes aliases and duplicate calls, and replays after restart without another push or PR', async () => {
    const f = await fixture(); f.edits()
    const input = await f.input(), alias = join(f.home, 'alias')
    symlinkSync(f.prepared.dir, alias)
    const target = f.changes as unknown as GitRunner, spy = vi.spyOn(target, 'git')
    const [a, b] = await Promise.all([f.changes.updatePr(input), f.changes.updatePr({ ...input, dir: alias })])
    expect(a.head).toBe(b.head); expect(b.replayed).toBe(true)
    expect(spy.mock.calls.filter(([args]) => args.includes('push'))).toHaveLength(1)
    f.reopen()
    expect(await f.changes.updatePr(input)).toMatchObject({ head: a.head, replayed: true })
    expect(f.updates()).toHaveLength(1)
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it.each(['closed', 'merged', 'wrongRepo', 'wrongBase', 'wrongBranch'] as const)('rejects a PR that is %s without committing or pushing', async (key) => {
    const f = await fixture(); f.edits(); const input = await f.input()
    f.state[key] = true
    await expect(f.changes.updatePr(input)).rejects.toThrow(/已关闭或合并|与登记不符/)
    expect(f.head()).toBe(f.initial.head); expect(f.updates()).toHaveLength(0)
  })

  it('rejects foreign ownership, changed approval content, and an independently advanced branch', async () => {
    const f = await fixture(); f.edits(); const input = await f.input()
    await expect(f.changes.updatePr({ ...input, sessionKey: 'other' })).rejects.toThrow('不属于当前会话')
    await expect(f.changes.updatePr({ ...input, requesterOpenId: 'ou_other' })).rejects.toThrow('不属于当前会话')
    await expect(f.changes.updatePr({ ...input, cwd: f.src })).rejects.toThrow('不属于当前会话')
    f.edits('unapproved\n')
    await expect(f.changes.updatePr(input)).rejects.toThrow('确认后变化')
    f.edits(); const human = f.advance()
    await expect(f.changes.inspectUpdate({ ...f.actor, dir: f.prepared.dir })).rejects.toThrow('不能覆盖')
    await expect(f.changes.updatePr(input)).rejects.toThrow('不能覆盖')
    expect(f.head()).toBe(human); expect(f.updates()).toHaveLength(0)
  })

  it('uses an exact lease when a human pushes after the final check', async () => {
    const f = await fixture(); f.edits(); const input = await f.input()
    const target = f.changes as unknown as GitRunner, original = target.git.bind(target)
    let human = ''
    vi.spyOn(target, 'git').mockImplementation(async (args, cwd, env, beforeStart) => {
      if (args.includes('push')) {
        expect(args).toContain(`--force-with-lease=refs/heads/${f.prepared.branch}:${f.initial.head}`)
        human = f.advance()
      }
      return original(args, cwd, env, beforeStart)
    })
    await expect(f.changes.updatePr(input)).rejects.toThrow('结果未知')
    expect(f.head()).toBe(human); expect(f.updates()[0]?.state).toBe('unknown')
    expect(git(f.bare, 'show', `${human}:human.txt`)).toBe('human contribution')
  })

  it('recovers an accepted push with lost ACK by exact head readback, without repeating push', async () => {
    const f = await fixture(); f.edits(); const input = await f.input(), initialRow = { ...f.row() }
    const target = f.changes as unknown as GitRunner, original = target.git.bind(target)
    vi.spyOn(target, 'git').mockImplementation(async (args, cwd, env, beforeStart) => {
      const result = await original(args, cwd, env, beforeStart)
      if (args.includes('push')) throw new Error('push ACK lost')
      return result
    })
    await expect(f.changes.updatePr(input)).rejects.toThrow('结果未知')
    const received = f.head()
    expect(received).not.toBe(f.initial.head); expect(f.updates()[0]?.state).toBe('unknown')
    f.reopen()
    const spy = vi.spyOn(f.changes as unknown as GitRunner, 'git')
    expect(await f.changes.inspectUpdate({ ...f.actor, dir: input.dir })).toMatchObject({ expectedHead: input.expectedHead, snapshot: input.expectedSnapshot })
    expect(await f.changes.updatePr(input)).toMatchObject({ head: received, replayed: true })
    expect(spy.mock.calls.some(([args]) => args.includes('push'))).toBe(false)
    expect(f.row()).toEqual(initialRow); expect(f.updates()[0]?.state).toBe('confirmed')
  })

  it.each(['unknown', 'push_planned'])('does not re-push %s with the old remote head or accept a different intent', async (state) => {
    const f = await fixture(); f.edits(); const input = await f.input()
    const target = f.changes as unknown as GitRunner, original = target.git.bind(target)
    vi.spyOn(target, 'git').mockImplementation(async (args, cwd, env, beforeStart) => {
      if (args.includes('push')) { beforeStart?.(); throw new Error('no acknowledgement') }
      return original(args, cwd, env, beforeStart)
    })
    await expect(f.changes.updatePr(input)).rejects.toThrow('结果未知')
    f.registry.db.prepare('UPDATE github_change_updates SET state = ?').run(state)
    f.reopen()
    const spy = vi.spyOn(f.changes as unknown as GitRunner, 'git')
    expect(await f.changes.inspectUpdate({ ...f.actor, dir: input.dir })).toMatchObject({ expectedHead: input.expectedHead, snapshot: input.expectedSnapshot })
    await expect(f.changes.updatePr(input)).rejects.toThrow('结果未知')
    await expect(f.changes.updatePr({ ...input, body: 'new content' })).rejects.toThrow('不能用新内容')
    f.edits('later edit\n')
    await expect(f.changes.inspectUpdate({ ...f.actor, dir: input.dir })).rejects.toThrow('工作区已变化')
    expect(spy.mock.calls.some(([args]) => args.includes('push'))).toBe(false)
    expect(f.head()).toBe(f.initial.head); expect(f.updates()).toHaveLength(1)
    expect(f.changes.list(f.actor)[0]?.state).toBe(`update_${state}`)
  })

  it('keeps a successful push durable when PR readback fails and recovers only by reading', async () => {
    const f = await fixture(); f.edits(); const input = await f.input()
    const target = f.changes as unknown as GitRunner, original = target.git.bind(target)
    vi.spyOn(target, 'git').mockImplementation(async (args, cwd, env, beforeStart) => {
      const result = await original(args, cwd, env, beforeStart)
      if (args.includes('push')) f.state.readFailure = true
      return result
    })
    await expect(f.changes.updatePr(input)).rejects.toThrow('readback unavailable')
    expect(f.updates()[0]?.state).toBe('pushed')
    f.reopen(); f.state.readFailure = false
    const spy = vi.spyOn(f.changes as unknown as GitRunner, 'git')
    expect(await f.changes.updatePr(input)).toMatchObject({ head: f.head(), replayed: true })
    expect(spy.mock.calls.some(([args]) => args.includes('push'))).toBe(false)
  })

  it('waits for an acknowledged push to appear in PR readback, using at most three read-only checks', async () => {
    const f = await fixture(); f.edits(); const input = await f.input()
    const target = f.changes as unknown as GitRunner, original = target.git.bind(target)
    let pushed = false, reads = 0
    const spy = vi.spyOn(target, 'git').mockImplementation(async (args, ...rest) => {
      const result = await original(args, ...rest)
      if (args.includes('push')) { pushed = true; f.state.prHead = f.initial.head }
      return result
    })
    f.hooks.read = () => { if (pushed && ++reads === 3) f.state.prHead = undefined }
    const diagnostic = vi.spyOn(f.log, 'warn')
    const result = await f.changes.updatePr(input)
    expect(result).toMatchObject({ head: f.head(), phase: 'confirmed', number: f.initial.number })
    expect(reads).toBe(3); expect(spy.mock.calls.filter(([args]) => args.includes('push'))).toHaveLength(1)
    expect(diagnostic.mock.calls).toHaveLength(2)
    expect(diagnostic.mock.calls[0]).toEqual(['github update readback not synchronized', {
      changeId: f.prepared.id, updateId: f.updates()[0]!.id, round: 1, acknowledged: true,
      parentHead: f.initial.head, expectedHead: result.head, prHead: f.initial.head, remoteHead: result.head,
    }])
  }, 10_000)

  it('retains the push ACK after three stale reads and later reconciles without another push', async () => {
    const f = await fixture(); f.edits(); const input = await f.input()
    const target = f.changes as unknown as GitRunner, original = target.git.bind(target)
    let pushed = false, reads = 0
    const spy = vi.spyOn(target, 'git').mockImplementation(async (args, ...rest) => {
      const result = await original(args, ...rest)
      if (args.includes('push')) { pushed = true; f.state.prHead = f.initial.head }
      return result
    })
    f.hooks.read = () => { if (pushed) reads++ }
    await expect(f.changes.updatePr(input)).rejects.toThrow('推送已完成，尚未确认 PR 同步')
    expect(reads).toBe(3); expect(f.updates()[0]).toMatchObject({ state: 'pushed', error: null })
    expect(spy.mock.calls.filter(([args]) => args.includes('push'))).toHaveLength(1)
    f.reopen(); f.state.prHead = undefined
    const resumed = vi.spyOn(f.changes as unknown as GitRunner, 'git')
    expect(await f.changes.updatePr(input)).toMatchObject({ head: f.head(), replayed: true })
    expect(resumed.mock.calls.some(([args]) => args.includes('push'))).toBe(false)
  }, 10_000)

  it.each(['third_head', 'closed'] as const)('does not repeat readback when acknowledged push is followed by %s', async kind => {
    const f = await fixture(); f.edits(); const input = await f.input()
    const target = f.changes as unknown as GitRunner, original = target.git.bind(target)
    let pushed = false, reads = 0
    const spy = vi.spyOn(target, 'git').mockImplementation(async (args, ...rest) => {
      const result = await original(args, ...rest)
      if (args.includes('push')) {
        pushed = true
        if (kind === 'third_head') f.advance()
        else f.state.closed = true
      }
      return result
    })
    f.hooks.read = () => { if (pushed) reads++ }
    await expect(f.changes.updatePr(input)).rejects.toThrow(kind === 'third_head' ? '出现其他提交' : '已关闭或合并')
    expect(reads).toBe(1); expect(f.updates()[0]?.state).toBe('pushed')
    expect(spy.mock.calls.filter(([args]) => args.includes('push'))).toHaveLength(1)
  })

  it.each(['cancel', 'permission'] as const)('stops the read-only backoff on %s without losing the push ACK', async kind => {
    const f = await fixture(); f.edits(); const input = await f.input()
    const target = f.changes as unknown as GitRunner, original = target.git.bind(target)
    const abort = new AbortController(); let current = true, pushed = false, reads = 0
    const spy = vi.spyOn(target, 'git').mockImplementation(async (args, ...rest) => {
      const result = await original(args, ...rest)
      if (args.includes('push')) { pushed = true; f.state.prHead = f.initial.head }
      return result
    })
    f.hooks.read = () => { if (pushed) reads++ }
    vi.spyOn(f.log, 'warn').mockImplementation(() => {
      setTimeout(() => { if (kind === 'cancel') abort.abort(); else current = false }, 20)
    })
    await expect(f.changes.updatePr({ ...input, signal: abort.signal,
      assertAuthorized: () => { if (!current) throw new Error('permission revoked') },
    })).rejects.toThrow(kind === 'cancel' ? 'aborted' : 'permission revoked')
    expect(reads).toBe(1); expect(f.updates()[0]?.state).toBe('pushed')
    expect(spy.mock.calls.filter(([args]) => args.includes('push'))).toHaveLength(1)
  })

  it('leaves token failures and authorization revoked before push retryable', async () => {
    const f = await fixture(); f.edits(); const input = await f.input()
    const target = f.changes as unknown as { authEnv(repo: string): Promise<Record<string, string>> }
    const original = target.authEnv.bind(target)
    let count = 0
    const auth = vi.spyOn(target, 'authEnv').mockImplementation(async (repo) => {
      if (++count === 2) throw new Error('token unavailable')
      return original(repo)
    })
    await expect(f.changes.updatePr(input)).rejects.toThrow('token unavailable')
    expect(f.updates()[0]?.state).toBe('prepared'); expect(f.head()).toBe(f.initial.head)
    auth.mockRestore()
    let allowed = true
    const run = f.changes as unknown as GitRunner, runOriginal = run.git.bind(run)
    const gate = vi.spyOn(run, 'git').mockImplementation(async (args, cwd, env, beforeStart) => {
      if (args.includes('push')) allowed = false
      return runOriginal(args, cwd, env, beforeStart)
    })
    const authorized = { ...input, assertAuthorized: () => { if (!allowed) throw new Error('authorization revoked') } }
    await expect(f.changes.updatePr(authorized)).rejects.toThrow('authorization revoked')
    expect(f.updates()[0]?.state).toBe('prepared'); expect(f.head()).toBe(f.initial.head)
    gate.mockRestore(); allowed = true
    expect(await f.changes.updatePr(authorized)).toMatchObject({ number: 1, phase: 'confirmed' })
    expect(f.updates()).toHaveLength(1)
  })

  it('rechecks authorization after real GitHubIdentity token and GET awaits', async () => {
    const f = await fixture(); f.edits(); const input = await f.input()
    let allowed = true
    const authorized = { ...input, assertAuthorized: () => { if (!allowed) throw new Error('authorization revoked') } }
    const token = vi.spyOn(f.github, 'token').mockImplementation(async () => { allowed = false; return 'synthetic-only' })
    const before = f.calls.length
    await expect(f.changes.updatePr(authorized)).rejects.toThrow('authorization revoked')
    expect(f.calls).toHaveLength(before)
    token.mockRestore(); allowed = true; f.hooks.read = () => { allowed = false }
    await expect(f.changes.updatePr(authorized)).rejects.toThrow('authorization revoked')
    expect(f.head()).toBe(f.initial.head); expect(f.updates()).toHaveLength(0)
  })

  it('does not enter updates for an unresolved initial PR and lists only trusted matching registrations without IO', async () => {
    const f = await fixture(); f.edits()
    const row = f.row()
    f.registry.db.prepare("UPDATE github_changes SET state = 'pr_unknown' WHERE id = ?").run(f.prepared.id)
    await expect(f.changes.inspectUpdate({ ...f.actor, dir: f.prepared.dir })).rejects.toThrow('首次 PR 发布结果')
    expect(f.updates()).toHaveLength(0)
    const spy = vi.spyOn(f.changes as unknown as GitRunner, 'git')
    const before = f.calls.length
    rmSync(f.prepared.dir, { recursive: true, force: true })
    expect(f.changes.list(f.actor)).toEqual([expect.objectContaining({ id: f.prepared.id, dir: f.prepared.dir, state: 'pr_unknown', commitId: row?.commit_id })])
    expect(f.changes.list({ ...f.actor, sessionKey: 'other' })).toEqual([])
    expect(f.changes.list({ ...f.actor, requesterOpenId: 'other' })).toEqual([])
    expect(f.changes.list({ ...f.actor, cwd: f.src })).toEqual([])
    expect(spy).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(before)
  })

  it('uses the same canonical workspace identity for prepare and list when cwd is a symlink', async () => {
    const f = await fixture(), alias = join(f.home, 'workspace-alias')
    symlinkSync(f.actor.cwd, alias)
    const prepared = await f.changes.prepare({ ...f.actor, cwd: alias, repo: 'org/demo' })
    expect(f.changes.list({ ...f.actor, cwd: alias }).map((entry) => entry.id)).toContain(prepared.id)
    expect(f.changes.list(f.actor).map((entry) => entry.id)).toContain(prepared.id)
  })
})
