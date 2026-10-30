import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChangeManager, ensureGitHubChangeSchema } from '../src/github/changes.js'
import { GitHubIdentity, loadGitHubConfig } from '../src/github/identity.js'
import { RepositoryFiles, type RepositoryFilesDeps, type RepositoryFileIdentity } from '../src/github/repository-files.js'
import { createLogger } from '../src/log.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve: () => resolve() }
}
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' } }).trim()
}
async function fixture(legacy = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'friday-repository-files-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const seed = join(root, 'seed'), bare = join(root, 'remote.git'), cwd = join(root, 'workspace')
  mkdirSync(seed); git(seed, 'init', '-q'); git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(seed, 'README.md'), '# Demo\n')
  writeFileSync(join(seed, 'script.sh'), '#!/bin/sh\nexit 0\n'); chmodSync(join(seed, 'script.sh'), 0o755)
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'initial'); git(root, 'clone', '-q', '--bare', seed, bare)
  const registry = new Registry(':memory:'); cleanups.push(() => registry.close())
  registry.createSession({ sessionKey: 'session-owner', requesterOpenId: 'owner', chatId: 'chat-owner', chatType: 'p2p', cwd })
  const task = registry.createTask({ sessionKey: 'session-owner', requesterOpenId: 'owner', messageId: 'message-first', prompt: 'Prepare a documentation change' })
  const providerCalls: { method: string; path: string; body: unknown }[] = []
  const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'fixture-token', FRIDAY_GITHUB_REPOS: 'org/demo', FRIDAY_GITHUB_WRITE_REPOS: 'org/demo' })!, createLogger('test', 'error'), {
    async request(method, path, body) {
      providerCalls.push({ method, path, body })
      if (path === '/user') return { status: 200, data: { login: 'fixture-user' } as never }
      if (path === '/users/fixture-user') return { status: 200, data: { id: 123 } as never }
      if (method === 'GET' && path.includes('/pulls?')) return { status: 200, data: [] as never }
      if (method === 'POST' && path.endsWith('/pulls')) return { status: 201, data: { number: 1, html_url: 'https://github.com/org/demo/pull/1' } as never }
      if (method === 'GET' && path.endsWith('/pulls/1')) {
        const change = registry.db.prepare('SELECT branch,commit_id FROM github_changes LIMIT 1').get()!
        return { status: 200, data: { number: 1, html_url: 'https://github.com/org/demo/pull/1', draft: true, state: 'open',
          head: { ref: change.branch, sha: change.commit_id, repo: { full_name: 'org/demo' } },
          base: { ref: 'main', repo: { full_name: 'org/demo' } } } as never }
      }
      return { status: 404, data: {} as never }
    },
  })
  const changes = new ChangeManager({ db: registry.db, github, cacheDir: join(root, 'cache'), log: createLogger('test', 'error'),
    remoteUrlFor: () => `file://${bare}`, createPullRequests: true })
  let allowed = true
  const identity: RepositoryFileIdentity = { cwd, sessionKey: 'session-owner', requesterOpenId: 'owner',
    ...(legacy ? {} : { workKey: registry.taskWork.get(task.id)!.key }),
    assertAuthorized() { if (!allowed) throw new Error('source revoked') } }
  const prepared = await changes.prepare({ ...identity, repo: 'org/demo' })
  const reads: unknown[] = [], admissions: unknown[] = []
  const deps: RepositoryFilesDeps = { changes,
    async authorize(_identity, access) { admissions.push(access); return { assertCurrent: identity.assertAuthorized } },
    recordRead(_identity, source) { reads.push(source) },
  }
  const files = new RepositoryFiles(deps)
  return { root, cwd, bare, registry, task, changes, identity, prepared, files, deps, reads, admissions, providerCalls,
    revoke: () => { allowed = false } }
}

describe('change-bound repository files (real Git and filesystem)', () => {

  it('reads actual file bytes and content search digests in files mode without hashing the whole tree', async () => {
    const f = await fixture(), original = f.deps.changes
    f.deps.changes = { withChange(input, use) { return original.withChange(input, lease => use({ ...lease,
      async snapshot() { throw new Error('whole-tree snapshot must not run for ordinary reads') },
    })) } }
    const input = { changeId: f.prepared.id, consistency: 'files' as const }
    const single = await f.files.read(f.identity, { ...input, path: 'README.md' })
    const batch = await f.files.readMany(f.identity, { ...input, paths: ['README.md', 'script.sh'] })
    const search = await f.files.search(f.identity, { ...input, query: 'Demo' })
    const many = await f.files.searchMany(f.identity, { ...input, queries: ['Demo', 'exit'] })
    for (const result of [single, batch, search, many]) {
      expect(result).toMatchObject({ consistency: 'files' })
      expect(result).not.toHaveProperty('snapshot')
    }
    expect(single).toMatchObject({ content: '# Demo\n', digest: digest('# Demo\n') })
    expect(batch.files.map(file => file.digest)).toEqual([digest('# Demo\n'), digest('#!/bin/sh\nexit 0\n')])
    expect(search.matches).toEqual([expect.objectContaining({ path: 'README.md', digest: single.digest })])
    expect(many.results[1]!.matches[0]).toMatchObject({ path: 'script.sh', digest: batch.files[1]!.digest })
    expect(f.reads.every(source => !Object.hasOwn(source as object, 'snapshot'))).toBe(true)
  })

  it.each(['files', 'snapshot'] as const)('searches an exact file in %s mode without scanning its siblings', async consistency => {
    const f = await fixture()
    writeFileSync(join(f.prepared.dir, 'sibling.txt'), 'Demo should not escape the selected file\n')
    const result = await f.files.search(f.identity, { changeId: f.prepared.id, path: 'README.md', query: 'Demo', consistency })
    expect(result.matches).toEqual([{ path: 'README.md', digest: digest('# Demo\n'), line: 1, text: '# Demo' }])
    expect(result.scannedFiles).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it('keeps explicit expectedSnapshot strict even when files consistency was requested', async () => {
    const f = await fixture()
    const baseline = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })
    writeFileSync(join(f.prepared.dir, 'unrelated.txt'), 'changed tree\n')
    const input = { changeId: f.prepared.id, consistency: 'files' as const, expectedSnapshot: baseline.snapshot }
    await expect(f.files.read(f.identity, { ...input, path: 'README.md' })).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(f.files.readMany(f.identity, { ...input, paths: ['README.md'] })).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(f.files.search(f.identity, { ...input, query: 'Demo' })).rejects.toMatchObject({ code: 'version_conflict' })
  })

  it.each(['files', 'snapshot'] as const)('accurately reports the %s boundary when another file changes during a yielded scan', async consistency => {
    const f = await fixture()
    for (let i = 0; i < 80; i++) writeFileSync(join(f.prepared.dir, `read-${i}.txt`), 'needle\n')
    const mutate = () => writeFileSync(join(f.prepared.dir, 'README.md'), '# Changed\n')
    if (consistency === 'snapshot') {
      const original = f.deps.changes
      let snapshots = 0
      f.deps.changes = { withChange(input, use) { return original.withChange(input, lease => use({ ...lease,
        async snapshot() {
          const value = await lease.snapshot()
          if (++snapshots === 1) setImmediate(mutate)
          return value
        },
      })) } }
    } else f.deps.authorize = async () => {
      setImmediate(mutate)
      return { assertCurrent: f.identity.assertAuthorized }
    }
    const pending = f.files.search(f.identity, { changeId: f.prepared.id, query: 'needle', consistency, limit: 200 })
    if (consistency === 'snapshot') await expect(pending).rejects.toMatchObject({ code: 'version_conflict' })
    else {
      const result = await pending
      expect(result).not.toHaveProperty('snapshot')
      expect(result.matches).toHaveLength(80)
      expect(result.matches.every(match => match.digest === digest('needle\n'))).toBe(true)
    }
  })

  it('still refuses all files-mode search output after authority changes at a scan yield', async () => {
    const f = await fixture()
    for (let i = 0; i < 80; i++) writeFileSync(join(f.prepared.dir, `read-${i}.txt`), 'needle\n')
    f.deps.authorize = async () => {
      setImmediate(f.revoke)
      return { assertCurrent: f.identity.assertAuthorized }
    }
    await expect(f.files.search(f.identity, { changeId: f.prepared.id, query: 'needle', consistency: 'files', limit: 200 }))
      .rejects.toThrow('source revoked')
    expect(f.reads).toEqual([])
  })

  it('reads a batch from one tree with two full snapshots, preserving every file and source digest', async () => {
    const f = await fixture(), paths = ['README.md', 'script.sh']
    const singles = await Promise.all(paths.map(path => f.files.read(f.identity, { changeId: f.prepared.id, path })))
    const original = f.deps.changes
    let snapshots = 0
    f.deps.changes = { withChange(input, use) { return original.withChange(input, lease => use({ ...lease,
      async snapshot() { snapshots++; return lease.snapshot() },
    })) } }
    f.reads.length = 0
    const batch = await f.files.readMany(f.identity, { changeId: f.prepared.id, paths })
    expect(batch.files).toEqual(singles.map(({ changeId: _id, repo: _repo, snapshot: _snapshot, ...file }) => file))
    expect(batch.snapshot).toBe(singles[0]!.snapshot)
    expect(snapshots).toBe(2)
    expect(f.reads).toHaveLength(paths.length)
    expect(f.admissions.slice(-2)).toEqual(paths.map(path => expect.objectContaining({ action: 'read', path })))
    expect(JSON.stringify(batch)).not.toContain(f.root)
  })

  it('shares scan work and total match budget across search terms while single-query results stay identical', async () => {
    const f = await fixture()
    writeFileSync(join(f.prepared.dir, 'README.md'), 'alpha beta\nalpha\nbeta\n')
    const single = await f.files.search(f.identity, { changeId: f.prepared.id, query: 'alpha' })
    const asBatch = await f.files.searchMany(f.identity, { changeId: f.prepared.id, queries: ['alpha'] })
    const { query: _query, ...same } = asBatch.results[0]!
    expect({ changeId: asBatch.changeId, repo: asBatch.repo, snapshot: asBatch.snapshot, path: asBatch.path, mode: asBatch.mode, ...same }).toEqual(single)
    const original = f.deps.changes
    let snapshots = 0
    f.deps.changes = { withChange(input, use) { return original.withChange(input, lease => use({ ...lease,
      async snapshot() { snapshots++; return lease.snapshot() },
    })) } }
    const batch = await f.files.searchMany(f.identity, { changeId: f.prepared.id, queries: ['alpha', 'beta'] })
    expect(snapshots).toBe(2)
    expect(batch.results.map(result => result.matches.map(match => match.line))).toEqual([[1, 2], [1, 3]])
    expect(batch.results.every(result => result.scannedBytes === single.scannedBytes)).toBe(true)
    const limited = await f.files.searchMany(f.identity, { changeId: f.prepared.id, queries: ['alpha', 'beta', 'absent'], limit: 2 })
    expect(limited.results.flatMap(result => result.matches)).toHaveLength(2)
    expect(limited.results.every(result => result.truncated && result.limitReason === 'matches')).toBe(true)
    expect(limited.results[2]!.matches).toEqual([]) // Incomplete coverage, not a proven absence.
  })

  it.each(['mutate', 'revoke', 'abort'] as const)('returns no batch bytes or sources when %s happens before the ending snapshot', async failure => {
    for (const operation of ['read', 'search'] as const) {
      const f = await fixture(), controller = new AbortController(), entered = deferred(), release = deferred()
      f.identity.signal = controller.signal
      const original = f.deps.changes
      let snapshots = 0
      f.deps.changes = { withChange(input, use) { return original.withChange(input, lease => use({ ...lease,
        async snapshot() {
          if (++snapshots === 2) { entered.resolve(); await release.promise }
          return lease.snapshot()
        },
      })) } }
      const pending = operation === 'read'
        ? f.files.readMany(f.identity, { changeId: f.prepared.id, paths: ['README.md', 'script.sh'] })
        : f.files.searchMany(f.identity, { changeId: f.prepared.id, queries: ['Demo', 'exit'] })
      const rejected = expect(pending).rejects.toThrow()
      await entered.promise
      if (failure === 'mutate') writeFileSync(join(f.prepared.dir, 'README.md'), 'changed externally\n')
      else if (failure === 'revoke') f.revoke()
      else controller.abort(new Error('request ended'))
      release.resolve(); await rejected
      expect(f.reads).toEqual([])
    }
  })


  it('keeps each path authority live while admitting a read batch', async () => {
    const f = await fixture()
    let firstReadable = true
    f.deps.authorize = async (_identity, access) => {
      if (access.path === 'script.sh') firstReadable = false
      return { assertCurrent() { f.identity.assertAuthorized(); if (access.path === 'README.md' && !firstReadable) throw new Error('first file revoked') } }
    }
    await expect(f.files.readMany(f.identity, { changeId: f.prepared.id, paths: ['README.md', 'script.sh'] })).rejects.toThrow('first file revoked')
    expect(f.reads).toEqual([])
  })

  it('keeps the actual edit when cancellation arrives after bytes changed, without falsely returning success', async () => {
    const f = await fixture(), before = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })
    const controller = new AbortController(), original = f.deps.changes
    let snapshots = 0
    f.identity.signal = controller.signal
    f.deps.changes = { withChange(input, use) { return original.withChange(input, lease => use({ ...lease,
      async snapshot() {
        const snapshot = await lease.snapshot()
        if (++snapshots === 2) controller.abort(new Error('stopped after edit'))
        return snapshot
      },
    })) } }
    const input = { changeId: f.prepared.id, path: 'README.md', expectedSnapshot: before.snapshot,
      expectedDigest: before.digest, oldText: 'Demo', newText: 'Changed' }
    await expect(f.files.edit(f.identity, input)).rejects.toThrow('stopped after edit')
    expect(readFileSync(join(f.prepared.dir, 'README.md'), 'utf8')).toBe('# Changed\n')
    f.identity.signal = undefined
    await expect(f.files.edit(f.identity, input)).rejects.toMatchObject({ code: 'version_conflict' })
  })

  it('rejects incomplete, unsafe or over-budget read batches rather than silently omitting files', async () => {
    const f = await fixture()
    const outside = join(f.root, 'outside'); writeFileSync(outside, 'not in this repository')
    symlinkSync(outside, join(f.prepared.dir, 'linked.txt'))
    for (const [path, code] of [['missing.txt', 'not_found'], ['linked.txt', 'unsafe_path'], ['.git/config', 'unsafe_path']] as const) {
      await expect(f.files.readMany(f.identity, { changeId: f.prepared.id, paths: ['README.md', path] })).rejects.toMatchObject({ code })
    }
    for (let i = 0; i < 5; i++) writeFileSync(join(f.prepared.dir, `large-${i}.txt`), 'x'.repeat(1024 * 1024))
    await expect(f.files.readMany(f.identity, { changeId: f.prepared.id, paths: Array.from({ length: 5 }, (_, i) => `large-${i}.txt`) })).rejects.toMatchObject({ code: 'too_large' })
    expect(f.reads).toEqual([])
  })

  it('performs one edit under one lock with exactly two snapshots and the precise approved content digest', async () => {
    const f = await fixture(), before = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'script.sh' })
    const original = f.deps.changes
    let snapshots = 0, locks = 0
    f.deps.changes = { withChange(input, use) { locks++; return original.withChange(input, lease => use({ ...lease,
      async snapshot() { snapshots++; return lease.snapshot() },
    })) } }
    const result = await f.files.edit(f.identity, { changeId: f.prepared.id, path: 'script.sh', expectedSnapshot: before.snapshot,
      expectedDigest: before.digest, oldText: 'exit 0', newText: 'exit 1' })
    expect(locks).toBe(1); expect(snapshots).toBe(2)
    expect(f.admissions.at(-1)).toMatchObject({ action: 'write', expectedSnapshot: before.snapshot,
      expectedDigest: before.digest, contentDigest: digest('#!/bin/sh\nexit 1\n') })
    expect(result.digest).toBe(digest(readFileSync(join(f.prepared.dir, 'script.sh'), 'utf8')))
  })

  it.each(['other-file', 'target', 'revoke', 'abort'] as const)('revalidates an edit after write approval awaits: %s', async change => {
    const f = await fixture(), before = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })
    const entered = deferred(), release = deferred(), controller = new AbortController()
    f.identity.signal = controller.signal
    const original = f.deps.authorize
    f.deps.authorize = async (identity, access) => {
      if (access.action === 'write') { entered.resolve(); await release.promise }
      return original(identity, access)
    }
    const pending = f.files.edit(f.identity, { changeId: f.prepared.id, path: 'README.md', expectedSnapshot: before.snapshot,
      expectedDigest: before.digest, oldText: 'Demo', newText: 'Changed' })
    const rejected = expect(pending).rejects.toThrow()
    await entered.promise
    if (change === 'target') writeFileSync(join(f.prepared.dir, 'README.md'), '# Other\n')
    else if (change === 'other-file') writeFileSync(join(f.prepared.dir, 'another.md'), 'unapproved tree')
    else if (change === 'revoke') f.revoke()
    else controller.abort(new Error('stopped'))
    release.resolve(); await rejected
    expect(readFileSync(join(f.prepared.dir, 'README.md'), 'utf8')).toBe(change === 'target' ? '# Other\n' : '# Demo\n')
  })

  it('searches literal content in a bounded subdirectory with real line numbers, without regex or case folding', async () => {
    const f = await fixture()
    mkdirSync(join(f.prepared.dir, 'src'))
    writeFileSync(join(f.prepared.dir, 'src', 'view.ts'), 'unrelated\nconst label = "1 turns"\nconst literal = "[a-z]+"\nconst upper = "1 TURNS"\n')
    writeFileSync(join(f.prepared.dir, 'other.ts'), '1 turns\n')
    const found = await f.files.search(f.identity, { changeId: f.prepared.id, path: 'src', query: '1 turns' })
    expect(found).toMatchObject({ repo: 'org/demo', path: 'src', mode: 'content', truncated: false,
      matches: [{ path: 'src/view.ts', line: 2, text: 'const label = "1 turns"' }], scannedFiles: 1 })
    expect(found.snapshot).toMatch(/^[a-f0-9]{40}$/)
    expect(f.admissions.at(-1)).toMatchObject({ action: 'read', path: 'src', changeId: f.prepared.id })
    expect(f.reads.at(-1)).toMatchObject({ snapshot: found.snapshot, path: 'src' })
    const literal = await f.files.search(f.identity, { changeId: f.prepared.id, path: 'src', query: '[a-z]+', expectedSnapshot: found.snapshot })
    expect(literal.matches).toEqual([{ path: 'src/view.ts', digest: digest(readFileSync(join(f.prepared.dir, 'src/view.ts'), 'utf8')), line: 3, text: 'const literal = "[a-z]+"' }])
    expect(JSON.stringify(found)).not.toContain(f.root)
  })

  it('searches relative file paths and distinguishes a truncated result from an exact limit', async () => {
    const f = await fixture()
    mkdirSync(join(f.prepared.dir, 'locales'))
    writeFileSync(join(f.prepared.dir, 'locales', 'en-US.json'), '{}')
    writeFileSync(join(f.prepared.dir, 'locales', 'en-GB.json'), '{}')
    const limited = await f.files.search(f.identity, { changeId: f.prepared.id, query: 'locales/en-', mode: 'path', limit: 1 })
    expect(limited).toMatchObject({ truncated: true, limitReason: 'matches', scannedBytes: 0 })
    expect(limited.matches).toHaveLength(1)
    expect(limited.matches[0]).toEqual({ path: expect.stringMatching(/^locales\/en-/) })
    const exact = await f.files.search(f.identity, { changeId: f.prepared.id, path: 'locales', query: 'en-', mode: 'path', limit: 2 })
    expect(exact.truncated).toBe(false)
    expect(exact.matches.map(match => match.path).sort()).toEqual(['locales/en-GB.json', 'locales/en-US.json'])
    expect((await f.files.search(f.identity, { changeId: f.prepared.id, query: 'EN-', mode: 'path' })).matches).toEqual([])
  })

  it('skips metadata, linked files, nontext and oversized contents without revealing their bytes', async () => {
    const f = await fixture(), outside = join(f.root, 'outside.txt')
    writeFileSync(outside, 'PRIVATE-CANARY')
    symlinkSync(outside, join(f.prepared.dir, 'link.txt'))
    symlinkSync(f.root, join(f.prepared.dir, 'outside-directory'))
    linkSync(outside, join(f.prepared.dir, 'hard.txt'))
    writeFileSync(join(f.prepared.dir, 'binary.bin'), Buffer.from('PRIVATE-CANARY\0'))
    writeFileSync(join(f.prepared.dir, 'document.pdf'), '%PDF-1.4\nPRIVATE-CANARY')
    writeFileSync(join(f.prepared.dir, 'large.txt'), `PRIVATE-CANARY${'x'.repeat(1024 * 1024)}`)
    writeFileSync(join(f.prepared.dir, '.git', 'private-canary'), 'PRIVATE-CANARY')
    const found = await f.files.search(f.identity, { changeId: f.prepared.id, query: 'PRIVATE-CANARY' })
    expect(found.matches).toEqual([])
    expect(found.skippedFiles).toBe(6)
    expect(found.truncated).toBe(false)
    for (const query of ['private-canary', '.friday-change.json', 'outside']) {
      expect((await f.files.search(f.identity, { changeId: f.prepared.id, query, mode: 'path' })).matches).toEqual([])
    }
    for (const path of ['../', '.git', '.friday-change.json', 'outside-directory']) {
      await expect(f.files.search(f.identity, { changeId: f.prepared.id, query: 'PRIVATE-CANARY', path })).rejects.toThrow()
    }
  })

  it('bounds snippets, reports each matching line once, and supports literal multiline text', async () => {
    const f = await fixture()
    writeFileSync(join(f.prepared.dir, 'README.md'), `${'x'.repeat(1000)}needle needle${'z'.repeat(1000)}\nnext needle\nthird\n`)
    const found = await f.files.search(f.identity, { changeId: f.prepared.id, query: 'needle' })
    expect(found.matches.map(match => match.line)).toEqual([1, 2])
    expect(found.matches.every(match => match.text!.length <= 242)).toBe(true)
    expect(found.matches[0].text).toContain('needle needle')
    expect((await f.files.search(f.identity, { changeId: f.prepared.id, query: 'needle\nthird' })).matches)
      .toEqual([{ path: 'README.md', digest: digest(readFileSync(join(f.prepared.dir, 'README.md'), 'utf8')), line: 2, text: 'next needle' }])
  })

  it('returns explicit bounded coverage when a no-hit scan exhausts its file budget', async () => {
    const f = await fixture()
    mkdirSync(join(f.prepared.dir, 'generated'))
    for (let i = 0; i < 2001; i++) writeFileSync(join(f.prepared.dir, 'generated', `${i}.txt`), 'no hit\n')
    const result = await f.files.search(f.identity, { changeId: f.prepared.id, path: 'generated', query: 'absent' })
    expect(result).toMatchObject({ matches: [], truncated: true, limitReason: 'files', scannedFiles: 2000 })
    const batch = await f.files.searchMany(f.identity, { changeId: f.prepared.id, path: 'generated', queries: ['absent', 'missing', 'not here'] })
    expect(batch.results).toHaveLength(3)
    expect(batch.results.every(result => result.truncated && result.limitReason === 'files' && result.scannedFiles === 2000)).toBe(true)
  })

  it('bounds full authority revalidation work for synchronous scan batches', async () => {
    const f = await fixture()
    mkdirSync(join(f.prepared.dir, 'small-files'))
    for (let i = 0; i < 256; i++) writeFileSync(join(f.prepared.dir, 'small-files', `${i}.txt`), 'needle\n')
    let fullChecks = 0
    f.deps.authorize = async () => ({ assertCurrent() { fullChecks++; f.identity.assertAuthorized() } })
    const found = await f.files.search(f.identity, { changeId: f.prepared.id, path: 'small-files', query: 'absent' })
    expect(found).toMatchObject({ matches: [], scannedFiles: 256, truncated: false })
    // A regression to per-entry/per-read full policy proofs multiplies thousands
    // of database/source checks; each yielded batch still has its own live proof.
    expect(fullChecks).toBeGreaterThanOrEqual(8)
    expect(fullChecks).toBeLessThan(32)
  })

  it.each(['revoke', 'abort'] as const)('does not deliver found content when %s happens during the ending snapshot', async failure => {
    const f = await fixture(), entered = deferred(), release = deferred(), controller = new AbortController()
    f.identity.signal = controller.signal
    const original = f.deps.changes
    let snapshots = 0
    f.deps.changes = { withChange(input, use) { return original.withChange(input, change => use({ ...change,
      async snapshot() {
        const snapshot = await change.snapshot()
        if (++snapshots === 2) { entered.resolve(); await release.promise }
        return snapshot
      },
    })) } }
    const pending = f.files.search(f.identity, { changeId: f.prepared.id, query: 'Demo' })
    await entered.promise
    if (failure === 'revoke') f.revoke()
    else controller.abort(new Error('request ended'))
    release.resolve()
    await expect(pending).rejects.toThrow(failure === 'revoke' ? 'source revoked' : 'request ended')
    expect(f.reads).toEqual([])
  })

  it('allocates by actual small file size and still supports empty and maximum-sized text', async () => {
    const f = await fixture()
    writeFileSync(join(f.prepared.dir, 'empty.txt'), '')
    const original = f.deps.changes
    let reading = false
    f.deps.changes = { withChange(input, use) { return original.withChange(input, change => use({ ...change,
      async snapshot() { const value = await change.snapshot(); reading = true; return value },
    })) } }
    const allocated: number[] = [], alloc = Buffer.alloc
    const spy = vi.spyOn(Buffer, 'alloc').mockImplementation(((size: number, ...rest: unknown[]) => {
      if (reading) allocated.push(size)
      return Reflect.apply(alloc, Buffer, [size, ...rest])
    }) as typeof Buffer.alloc)
    try {
      expect((await f.files.read(f.identity, { changeId: f.prepared.id, path: 'empty.txt' })).content).toBe('')
      reading = false
      expect((await f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })).content).toBe('# Demo\n')
    } finally { spy.mockRestore() }
    expect(allocated).toEqual([1, Buffer.byteLength('# Demo\n') + 1])
    const content = 'x'.repeat(1024 * 1024)
    writeFileSync(join(f.prepared.dir, 'maximum.txt'), content)
    expect((await f.files.read(f.identity, { changeId: f.prepared.id, path: 'maximum.txt' })).bytes).toBe(content.length)
    writeFileSync(join(f.prepared.dir, 'maximum.txt'), content + 'x')
    await expect(f.files.read(f.identity, { changeId: f.prepared.id, path: 'maximum.txt' })).rejects.toMatchObject({ code: 'too_large' })
  })

  it.each(['grow', 'short-read'] as const)('rejects a real file %s between descriptor inspection and byte reading', async change => {
    const f = await fixture(), path = join(f.prepared.dir, 'README.md')
    const original = f.deps.changes
    let reading = false, changed = false
    f.deps.changes = { withChange(input, use) { return original.withChange(input, lease => use({ ...lease,
      async snapshot() { const value = await lease.snapshot(); reading = true; return value },
    })) } }
    const alloc = Buffer.alloc
    const spy = vi.spyOn(Buffer, 'alloc').mockImplementation(((size: number, ...rest: unknown[]) => {
      if (reading && !changed) { changed = true; writeFileSync(path, change === 'grow' ? '# Demo\nmore' : '#') }
      return Reflect.apply(alloc, Buffer, [size, ...rest])
    }) as typeof Buffer.alloc)
    try {
      await expect(f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })).rejects.toMatchObject({ code: 'content_changed' })
      expect(changed).toBe(true)
      expect(f.reads).toEqual([])
    } finally { spy.mockRestore() }
  })

  it('discards partial search results on a mid-scan permission revocation or request cancellation', async () => {
    for (const failure of ['revoke', 'abort'] as const) {
      const f = await fixture(), controller = new AbortController()
      f.identity.signal = controller.signal
      for (let i = 0; i < 64; i++) writeFileSync(join(f.prepared.dir, `item-${i}.txt`), 'needle\n')
      const original = f.deps.changes
      let snapshots = 0, scheduled = false
      f.deps.changes = { withChange(input, use) { return original.withChange(input, change => use({ ...change,
        async snapshot() {
          const snapshot = await change.snapshot()
          snapshots++
          if (!scheduled) { scheduled = true; setImmediate(() => failure === 'revoke' ? f.revoke() : controller.abort(new Error('request ended'))) }
          return snapshot
        },
      })) } }
      await expect(f.files.search(f.identity, { changeId: f.prepared.id, query: 'needle', limit: 200 }))
        .rejects.toThrow(failure === 'revoke' ? 'source revoked' : 'request ended')
      expect(snapshots).toBe(1)
      expect(f.reads).toEqual([])
    }
  })

  it('rejects an initial stale snapshot and a tree changed during a yielded scan', async () => {
    const f = await fixture()
    for (let i = 0; i < 64; i++) writeFileSync(join(f.prepared.dir, `item-${i}.txt`), 'needle\n')
    await expect(f.files.search(f.identity, { changeId: f.prepared.id, query: 'needle', expectedSnapshot: '0'.repeat(40) }))
      .rejects.toMatchObject({ code: 'version_conflict' })
    const original = f.deps.changes
    let scheduled = false
    f.deps.changes = { withChange(input, use) { return original.withChange(input, change => use({ ...change,
      async snapshot() {
        const snapshot = await change.snapshot()
        if (!scheduled) { scheduled = true; setImmediate(() => writeFileSync(join(f.prepared.dir, 'README.md'), 'changed while scanning\n')) }
        return snapshot
      },
    })) } }
    await expect(f.files.search(f.identity, { changeId: f.prepared.id, query: 'needle', limit: 200 }))
      .rejects.toMatchObject({ code: 'version_conflict' })
    expect(f.reads).toEqual([])
  })

  it('uses the current actor, change and Work binding for search and rejects invalid searches before scanning', async () => {
    const f = await fixture(), input = { changeId: f.prepared.id, query: 'Demo' }
    await expect(f.files.search({ ...f.identity, requesterOpenId: 'other' }, input)).rejects.toThrow('不属于')
    await expect(f.files.search({ ...f.identity, sessionKey: 'other' }, input)).rejects.toThrow('不属于')
    await expect(f.files.search({ ...f.identity, workKey: 'other' }, input)).rejects.toThrow()
    for (const invalid of [{ query: '' }, { query: '\0' }, { query: 'a'.repeat(4097) }, { limit: 0 }, { limit: 201 }, { mode: 'regex' }]) {
      await expect(f.files.search(f.identity, { ...input, ...invalid } as never)).rejects.toMatchObject({ code: 'invalid_request' })
    }
    expect(f.reads).toEqual([])
  })

  it('edits an exact fragment without regenerating the rest of a large file, preserving mode and final newline', async () => {
    const f = await fixture()
    const original = `#!/bin/sh\n${'# unrelated text stays byte-identical\n'.repeat(3000)}exit 0\n`
    writeFileSync(join(f.prepared.dir, 'script.sh'), original)
    const originalMode = statSync(join(f.prepared.dir, 'script.sh')).mode & 0o777
    expect(originalMode & 0o111).toBe(0o111)
    const before = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'script.sh' })
    const edited = await f.files.edit(f.identity, { changeId: f.prepared.id, path: 'script.sh',
      expectedSnapshot: before.snapshot, expectedDigest: before.digest, oldText: 'exit 0\n', newText: 'exit 1\n' })
    expect(readFileSync(join(f.prepared.dir, 'script.sh'), 'utf8')).toBe(original.replace('exit 0\n', 'exit 1\n'))
    expect(statSync(join(f.prepared.dir, 'script.sh')).mode & 0o777).toBe(originalMode)
    expect(edited.snapshot).not.toBe(before.snapshot)
    await expect(f.files.edit(f.identity, { changeId: f.prepared.id, path: 'script.sh',
      expectedSnapshot: before.snapshot, expectedDigest: before.digest, oldText: 'exit 1\n', newText: 'exit 2\n' }))
      .rejects.toMatchObject({ code: 'version_conflict' })
  })

  it('refuses ambiguous or missing fragments and requires fresh write authority after reading', async () => {
    const f = await fixture()
    writeFileSync(join(f.prepared.dir, 'README.md'), 'same\nsame\n')
    const before = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })
    const input = { changeId: f.prepared.id, path: 'README.md', expectedSnapshot: before.snapshot, expectedDigest: before.digest, newText: 'replacement' }
    for (const oldText of ['same', 'missing', '']) await expect(f.files.edit(f.identity, { ...input, oldText })).rejects.toMatchObject({ code: 'invalid_request' })
    const admitted = f.deps.authorize
    f.deps.authorize = async (identity, access) => { if (access.action === 'write') f.revoke(); return admitted(identity, access) }
    await expect(f.files.edit(f.identity, { ...input, oldText: 'same\nsame' })).rejects.toThrow('source revoked')
    expect(readFileSync(join(f.prepared.dir, 'README.md'), 'utf8')).toBe('same\nsame\n')
  })

  it('exports an exact binary patch that reapplies to its base, with no host marker or lost final newline', async () => {
    const f = await fixture()
    const read = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })
    const content = '# Demo\n\nTrailing spaces stay here:  \n'
    const edited = await f.files.write(f.identity, { changeId: f.prepared.id, path: 'README.md', expectedSnapshot: read.snapshot,
      expectedDigest: read.digest, content })
    const exported = await f.changes.executionSnapshot({ ...f.identity, changeId: f.prepared.id, expectedSnapshot: edited.snapshot })
    expect(exported.patch.endsWith('\n')).toBe(true)
    expect(exported.patch).not.toContain('.friday-change.json')
    const target = join(f.root, 'replica'); git(f.root, 'clone', '-q', f.bare, target)
    git(target, 'checkout', '--detach', exported.baseSha)
    const patchPath = join(f.root, 'patch'); writeFileSync(patchPath, exported.patch)
    git(target, 'apply', '--index', '--binary', patchPath)
    expect(git(target, 'write-tree')).toBe(exported.inputTree)
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe(content)
    await expect(f.changes.executionSnapshot({ ...f.identity, changeId: f.prepared.id, expectedSnapshot: read.snapshot }))
      .rejects.toThrow('修改副本已变化')
  })
  it('reads and edits a registered change, then publishes that exact tree as a draft without claiming tests ran', async () => {
    const f = await fixture()
    const read = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })
    expect(read.content).toBe('# Demo\n')
    expect(JSON.stringify(read)).not.toContain(f.root)
    const written = await f.files.write(f.identity, { changeId: f.prepared.id, path: 'README.md',
      expectedSnapshot: read.snapshot, expectedDigest: read.digest, content: '# Demo\n\nFixed on the server.\n' })
    expect(written.snapshot).not.toBe(read.snapshot)
    expect(written.validation).toEqual({ localExecution: 'not_run', ci: 'not_checked' })
    const published = await f.changes.publish({ ...f.identity, dir: f.prepared.dir, expectedSnapshot: written.snapshot,
      title: 'Fix documentation', body: 'Local tests not run; CI not checked.', draft: true })
    expect(git(f.bare, 'show', `${published.branch}:README.md`)).toContain('Fixed on the server.')
    expect(f.providerCalls.find(call => call.method === 'POST' && call.path.endsWith('/pulls'))?.body).toMatchObject({ draft: true })
    expect(f.reads).toHaveLength(2)
  })

  it('creates nested text, preserves executable mode, and deletes only with the current file and tree digests', async () => {
    const f = await fixture()
    const originalMode = statSync(join(f.prepared.dir, 'script.sh')).mode & 0o777
    expect(originalMode & 0o111).toBe(0o111)
    const read = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'script.sh' })
    const edited = await f.files.write(f.identity, { changeId: f.prepared.id, path: 'script.sh', expectedSnapshot: read.snapshot,
      expectedDigest: read.digest, content: '#!/bin/sh\nexit 1\n' })
    expect(statSync(join(f.prepared.dir, 'script.sh')).mode & 0o777).toBe(originalMode)
    const created = await f.files.write(f.identity, { changeId: f.prepared.id, path: 'docs/nested/说明.md',
      expectedSnapshot: edited.snapshot, expectedDigest: null, content: '\ufeff你好\n' })
    expect((await f.files.read(f.identity, { changeId: f.prepared.id, path: 'docs/nested/说明.md' })).content).toBe('\ufeff你好\n')
    await f.files.write(f.identity, { changeId: f.prepared.id, path: 'docs/nested/说明.md',
      expectedSnapshot: created.snapshot, expectedDigest: created.digest, content: null })
    expect(existsSync(join(f.prepared.dir, 'docs/nested/说明.md'))).toBe(false)
  })

  it('uses the database actor/change binding and refuses unresolved publication state', async () => {
    const f = await fixture()
    await expect(f.files.read({ ...f.identity, requesterOpenId: 'someone-else' }, { changeId: f.prepared.id, path: 'README.md' })).rejects.toThrow('不属于')
    await expect(f.files.read({ ...f.identity, sessionKey: 'other-session' }, { changeId: f.prepared.id, path: 'README.md' })).rejects.toThrow('不属于')
    f.registry.db.prepare("UPDATE github_changes SET state='pr_planned' WHERE id=?").run(f.prepared.id)
    await expect(f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })).rejects.toThrow('待核对')
    expect(f.reads).toHaveLength(0)
    expect(f.admissions).toHaveLength(0)
  })

  it('rejects traversal, metadata, symbolic links, hard links and binary data without exposing external bytes', async () => {
    const f = await fixture(), outside = join(f.root, 'outside-secret.txt')
    writeFileSync(outside, 'fixture outside data')
    symlinkSync(outside, join(f.prepared.dir, 'link.txt'))
    symlinkSync(f.root, join(f.prepared.dir, 'dir-link'))
    linkSync(outside, join(f.prepared.dir, 'hard.txt'))
    writeFileSync(join(f.prepared.dir, 'binary.bin'), Buffer.from([0xff, 0xfe, 0, 1]))
    writeFileSync(join(f.prepared.dir, 'document.pdf'), '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
    for (const path of ['../outside-secret.txt', outside, '.git/config', '.friday-change.json', 'link.txt', 'dir-link/outside-secret.txt', 'hard.txt']) {
      await expect(f.files.read(f.identity, { changeId: f.prepared.id, path })).rejects.toMatchObject({ code: 'unsafe_path' })
    }
    await expect(f.files.read(f.identity, { changeId: f.prepared.id, path: 'binary.bin' })).rejects.toMatchObject({ code: 'not_text' })
    await expect(f.files.read(f.identity, { changeId: f.prepared.id, path: 'document.pdf' })).rejects.toMatchObject({ code: 'not_text' })
    expect(f.reads).toHaveLength(0)
    expect(readFileSync(outside, 'utf8')).toBe('fixture outside data')
  })

  it('does not overwrite a changed tree or a changed file, and binds approvals to the proposed bytes', async () => {
    const f = await fixture(), read = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })
    await expect(f.files.write(f.identity, { changeId: f.prepared.id, path: 'README.md', expectedSnapshot: read.snapshot,
      expectedDigest: digest('wrong'), content: 'new text' })).rejects.toMatchObject({ code: 'version_conflict' })
    writeFileSync(join(f.prepared.dir, 'other.md'), 'someone else changed the tree')
    await expect(f.files.write(f.identity, { changeId: f.prepared.id, path: 'README.md', expectedSnapshot: read.snapshot,
      expectedDigest: read.digest, content: 'new text' })).rejects.toMatchObject({ code: 'version_conflict' })
    expect(f.admissions.at(-1)).toMatchObject({ action: 'write', expectedSnapshot: read.snapshot, expectedDigest: read.digest, contentDigest: digest('new text') })
    expect(readFileSync(join(f.prepared.dir, 'README.md'), 'utf8')).toBe('# Demo\n')
  })

  it('stops before writing if source authority changes while awaiting a real host approval', async () => {
    const f = await fixture(), read = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })
    const entered = deferred(), released = deferred()
    f.deps.authorize = async () => { entered.resolve(); await released.promise; return { assertCurrent: f.identity.assertAuthorized } }
    const pending = f.files.write(f.identity, { changeId: f.prepared.id, path: 'README.md', expectedSnapshot: read.snapshot,
      expectedDigest: read.digest, content: 'not permitted' })
    await entered.promise; f.revoke(); released.resolve()
    await expect(pending).rejects.toThrow('source revoked')
    expect(readFileSync(join(f.prepared.dir, 'README.md'), 'utf8')).toBe('# Demo\n')
  })

  it('serializes edits and publish in the existing ChangeManager lock and rejects the stale approved publish snapshot', async () => {
    const f = await fixture(), read = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })
    const entered = deferred(), released = deferred()
    f.deps.authorize = async () => { entered.resolve(); await released.promise; return { assertCurrent: f.identity.assertAuthorized } }
    const editing = f.files.write(f.identity, { changeId: f.prepared.id, path: 'README.md', expectedSnapshot: read.snapshot,
      expectedDigest: read.digest, content: 'edit under the common lock' })
    await entered.promise
    let publishSettled = false
    const publishing = f.changes.publish({ ...f.identity, dir: f.prepared.dir, expectedSnapshot: read.snapshot,
      title: 'stale proposal', body: 'stale' }).finally(() => { publishSettled = true })
    const rejected = expect(publishing).rejects.toThrow()
    await new Promise(resolve => setTimeout(resolve, 20)); expect(publishSettled).toBe(false)
    released.resolve(); await editing; await rejected
    expect(f.providerCalls.some(call => call.method === 'POST' && call.path.endsWith('/pulls'))).toBe(false)
  })

  it('preserves strict tree-version pagination and rejects pagination after tree changes', async () => {
    const f = await fixture()
    const first = await f.files.list(f.identity, { changeId: f.prepared.id, limit: 1, consistency: 'snapshot' })
    expect(first.complete).toBe(false)
    const second = await f.files.list(f.identity, { changeId: f.prepared.id, limit: 1, after: first.next!, expectedSnapshot: first.snapshot })
    expect([...first.entries, ...second.entries].map(item => item.name)).toEqual(['README.md', 'script.sh'])
    expect(second.complete).toBe(true)
    writeFileSync(join(f.prepared.dir, 'added'), 'x')
    await expect(f.files.list(f.identity, { changeId: f.prepared.id, after: first.next!, expectedSnapshot: first.snapshot })).rejects.toMatchObject({ code: 'version_conflict' })
  })

  it('keeps a committed edit when a later snapshot is cancelled, reports failure and never replays the old compare-and-swap', async () => {
    const f = await fixture(), read = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })
    const controller = new AbortController()
    const changes: RepositoryFilesDeps['changes'] = { withChange(input, use) {
      return f.changes.withChange(input, lease => {
        let snapshots = 0
        return use({ ...lease, snapshot: async () => {
          const result = await lease.snapshot()
          if (++snapshots === 2) controller.abort(new Error('request stopped after write'))
          return result
        } })
      })
    } }
    const files = new RepositoryFiles({ ...f.deps, changes })
    await expect(files.write({ ...f.identity, signal: controller.signal }, { changeId: f.prepared.id, path: 'README.md',
      expectedSnapshot: read.snapshot, expectedDigest: read.digest, content: 'acknowledgment lost' })).rejects.toThrow('request stopped after write')
    expect(readFileSync(join(f.prepared.dir, 'README.md'), 'utf8')).toBe('acknowledgment lost')
    await expect(f.files.write(f.identity, { changeId: f.prepared.id, path: 'README.md', expectedSnapshot: read.snapshot,
      expectedDigest: read.digest, content: 'acknowledgment lost' })).rejects.toMatchObject({ code: 'version_conflict' })
  })

  it('bounds text bytes and returns no raw host path for missing files', async () => {
    const f = await fixture()
    writeFileSync(join(f.prepared.dir, 'big.txt'), Buffer.alloc(1024 * 1024 + 1, 65))
    await expect(f.files.read(f.identity, { changeId: f.prepared.id, path: 'big.txt' })).rejects.toMatchObject({ code: 'too_large' })
    const error = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'missing/directory/file' }).catch(error => error)
    expect(error.code).toBe('not_found'); expect(error.message).not.toContain(f.root)
  })

  it('keeps two actual Works in one Session separate, including callers that omit the bound Work', async () => {
    const f = await fixture()
    const second = f.registry.createTask({ sessionKey: f.identity.sessionKey!, requesterOpenId: f.identity.requesterOpenId,
      messageId: 'message-unrelated', prompt: 'Another independent request' })
    const other = { ...f.identity, workKey: f.registry.taskWork.get(second.id)!.key }
    expect(other.workKey).not.toBe(f.identity.workKey)
    for (const actor of [other, { ...f.identity, workKey: undefined }]) {
      await expect(f.files.read(actor, { changeId: f.prepared.id, path: 'README.md' })).rejects.toThrow('原工作')
      await expect(f.changes.inspect({ ...actor, dir: f.prepared.dir })).rejects.toThrow('原工作')
      await expect(f.changes.markReady({ ...actor, dir: f.prepared.dir })).rejects.toThrow('原工作')
      await expect(f.changes.lifecycle({ ...actor, dir: f.prepared.dir })).rejects.toThrow('原工作')
    }
    expect(f.changes.list(other)[0]?.workAccess).toBe('other_work')
    expect(f.changes.list(f.identity)[0]?.workAccess).toBe('current')
    expect(f.reads).toHaveLength(0)
    expect((await f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })).content).toBe('# Demo\n')
  })

  it('preserves a nullable legacy binding and does not assign an old copy to a Work-aware caller', async () => {
    const f = await fixture(true)
    f.registry.db.exec('ALTER TABLE github_changes DROP COLUMN origin_work_key')
    const before = f.registry.db.prepare('SELECT * FROM github_changes WHERE id=?').get(f.prepared.id)!
    ensureGitHubChangeSchema(f.registry.db)
    const after = f.registry.db.prepare('SELECT * FROM github_changes WHERE id=?').get(f.prepared.id)!
    expect(after).toEqual({ ...before, origin_work_key: null })
    const aware = { ...f.identity, workKey: f.registry.taskWork.get(f.task.id)!.key }
    expect(f.changes.list(aware)[0]?.workAccess).toBe('legacy_unbound')
    await expect(f.files.read(aware, { changeId: f.prepared.id, path: 'README.md' })).rejects.toThrow('旧修改副本缺少原工作绑定')
    const legacy = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'README.md' })
    expect(legacy.content).toBe('# Demo\n')
    expect(f.registry.db.prepare('SELECT origin_work_key FROM github_changes WHERE id=?').get(f.prepared.id)?.origin_work_key).toBeNull()
  })

  it('binds preparation replay to the original Work without changing legacy preparation signatures', async () => {
    const f = await fixture()
    const input = { ...f.identity, repo: 'org/demo', operationKey: 'same-real-host-operation', attemptKey: 'first-run' }
    const prepared = await f.changes.prepare(input)
    expect((await f.changes.prepare(input)).id).toBe(prepared.id)
    await expect(f.changes.prepare({ ...input, workKey: 'task:999' })).rejects.toThrow('相同准备操作')
    await expect(f.changes.prepare({ ...input, workKey: undefined })).rejects.toThrow('相同准备操作')
    const legacy = { ...input, workKey: undefined, operationKey: 'historical-operation' }
    const previous = await f.changes.prepare(legacy)
    expect((await f.changes.prepare(legacy)).id).toBe(previous.id)
    await expect(f.changes.prepare({ ...legacy, workKey: f.identity.workKey })).rejects.toThrow('相同准备操作')
  })

  it('browses and paginates a real directory without a tree snapshot, preserving strict opt-in', async () => {
    const f = await fixture(), original = f.deps.changes
    let snapshots = 0
    f.deps.changes = { withChange(input, use) { return original.withChange(input, lease => use({ ...lease,
      async snapshot() { snapshots++; return lease.snapshot() },
    })) } }
    const first = await f.files.list(f.identity, { changeId: f.prepared.id, limit: 1 })
    expect(snapshots).toBe(0)
    expect(first).toMatchObject({ consistency: 'files', directoryVersion: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(first).not.toHaveProperty('snapshot')
    const second = await f.files.list(f.identity, { changeId: f.prepared.id, after: first.next!, expectedDirectoryVersion: first.directoryVersion })
    expect([...first.entries, ...second.entries].map(entry => entry.name)).toEqual(['README.md', 'script.sh'])
    expect(snapshots).toBe(0)
    writeFileSync(join(f.prepared.dir, 'added.txt'), 'new entry')
    await expect(f.files.list(f.identity, { changeId: f.prepared.id, after: first.next!, expectedDirectoryVersion: first.directoryVersion }))
      .rejects.toMatchObject({ code: 'version_conflict' })
    const strict = await f.files.list(f.identity, { changeId: f.prepared.id, consistency: 'snapshot' })
    expect(strict.snapshot).toMatch(/^[a-f0-9]{40}$/)
    expect(snapshots).toBeGreaterThan(0)
  })

  it('finds paths beyond 2,000 unrelated files and locates directories without reading file contents', async () => {
    const f = await fixture(), original = f.deps.changes
    mkdirSync(join(f.prepared.dir, 'a-first'))
    for (let i = 0; i < 2050; i++) writeFileSync(join(f.prepared.dir, 'a-first', `unrelated-${String(i).padStart(4, '0')}.txt`), 'not searched')
    mkdirSync(join(f.prepared.dir, 'z-component'))
    writeFileSync(join(f.prepared.dir, 'z-component', 'README.zh.md'), 'actual target')
    f.deps.changes = { withChange(input, use) { return original.withChange(input, lease => use({ ...lease,
      async snapshot() { throw new Error('path discovery must not hash the tree') },
    })) } }
    const input = { changeId: f.prepared.id, mode: 'path' as const, query: 'z-component', consistency: 'files' as const }
    const first = await f.files.search(f.identity, input)
    expect(first.matches.map(match => match.path)).toEqual(['z-component', 'z-component/README.zh.md'])
    expect(first.matches[0]).toMatchObject({ kind: 'directory' })
    expect(first).toMatchObject({ scannedBytes: 0, truncated: false, nextCursor: null, coverage: 'page',
      inventory: { scope: 'tracked_and_nonignored_untracked', complete: true } })
    expect(JSON.stringify(first)).not.toContain(f.root)
  })

  it('preserves overlapping batch path matches across output pages and binds cursors to query, scope and directory version', async () => {
    const f = await fixture()
    mkdirSync(join(f.prepared.dir, 'match-dir'))
    writeFileSync(join(f.prepared.dir, 'match-dir', 'match.txt'), 'x')
    const input = { changeId: f.prepared.id, queries: ['match', 'dir'], mode: 'path' as const, consistency: 'files' as const, limit: 1 }
    const first = await f.files.searchMany(f.identity, input)
    expect(first.nextCursor).toEqual(expect.any(String))
    const all = first.results.flatMap(result => result.matches.map(match => `${result.query}:${match.path}`))
    let cursor = first.nextCursor
    for (let page = 0; cursor && page < 10; page++) {
      const next = await f.files.searchMany(f.identity, { ...input, cursor })
      all.push(...next.results.flatMap(result => result.matches.map(match => `${result.query}:${match.path}`)))
      cursor = next.nextCursor
    }
    expect(cursor).toBeNull()
    expect(all.sort()).toEqual(['dir:match-dir', 'dir:match-dir/match.txt', 'match:match-dir', 'match:match-dir/match.txt'].sort())
    for (const other of [{ ...input, queries: ['changed'] }, { ...input, path: 'match-dir' }, { ...input, mode: 'content' as const }]) {
      await expect(f.files.searchMany(f.identity, { ...other, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'invalid_request' })
    }
    writeFileSync(join(f.prepared.dir, 'new.txt'), 'changed listing')
    await expect(f.files.searchMany(f.identity, { ...input, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'version_conflict' })
  })

  it.each(['revoke', 'abort'] as const)('returns no directory or path page after %s at an actual event-loop yield', async reason => {
    for (const operation of ['list', 'search'] as const) {
      const f = await fixture(), controller = new AbortController()
      f.identity.signal = controller.signal
      for (let i = 0; i < 70; i++) writeFileSync(join(f.prepared.dir, `entry-${i}.txt`), 'x')
      f.deps.authorize = async () => {
        setImmediate(() => reason === 'revoke' ? f.revoke() : controller.abort(new Error('cancelled request')))
        return { assertCurrent: f.identity.assertAuthorized }
      }
      const input = { changeId: f.prepared.id, consistency: 'files' as const }
      await expect(operation === 'list' ? f.files.list(f.identity, input)
        : f.files.search(f.identity, { ...input, query: 'entry', mode: 'path' })).rejects.toThrow()
      expect(f.reads).toEqual([])
    }
  })


  it('continues overlapping path queries for one exact file without exceeding the shared output limit', async () => {
    const f = await fixture(), input = { changeId: f.prepared.id, path: 'README.md', queries: ['README', '.md'], mode: 'path' as const, consistency: 'files' as const, limit: 1 }
    const first = await f.files.searchMany(f.identity, input)
    expect(first.results.flatMap(result => result.matches)).toHaveLength(1)
    const second = await f.files.searchMany(f.identity, { ...input, cursor: first.nextCursor! })
    expect(second.results.map(result => result.matches.length)).toEqual([0, 1])
    expect(second.nextCursor).toBeNull()
    writeFileSync(join(f.prepared.dir, 'README.md'), 'changed bytes, same path')
    const changedBytes = await f.files.searchMany(f.identity, { ...input, cursor: first.nextCursor! })
    expect(changedBytes.results[1]!.matches).toEqual([{ path: 'README.md' }])
    expect(changedBytes).not.toHaveProperty('snapshot')
  })

  it('retains whole-tree consistency across strict path pages and rechecks authority after the final snapshot', async () => {
    const f = await fixture(), input = { changeId: f.prepared.id, queries: ['.', 'md'], mode: 'path' as const, consistency: 'snapshot' as const, limit: 1 }
    const first = await f.files.searchMany(f.identity, input)
    expect(first.nextCursor).toEqual(expect.any(String))
    writeFileSync(join(f.prepared.dir, 'README.md'), 'tree changed without changing path names')
    await expect(f.files.searchMany(f.identity, { ...input, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'version_conflict' })
    const original = f.deps.changes
    let snapshots = 0
    f.deps.changes = { withChange(actor, use) { return original.withChange(actor, lease => use({ ...lease,
      async snapshot() { const result = await lease.snapshot(); if (++snapshots === 2) f.revoke(); return result },
    })) } }
    f.reads.length = 0
    await expect(f.files.searchMany(f.identity, input)).rejects.toThrow('source revoked')
    expect(f.reads).toEqual([])
  })

  it('rejects cursor traversal and cannot turn a cursor into access to a symlinked directory', async () => {
    const f = await fixture()
    mkdirSync(join(f.prepared.dir, 'target'))
    writeFileSync(join(f.prepared.dir, 'target', 'one.txt'), 'x')
    writeFileSync(join(f.prepared.dir, 'target', 'two.txt'), 'x')
    const input = { changeId: f.prepared.id, path: 'target', query: '.txt', mode: 'path' as const, consistency: 'files' as const, limit: 1 }
    const first = await f.files.search(f.identity, input), parsed = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString())
    parsed.offset = -1
    await expect(f.files.search(f.identity, { ...input, cursor: Buffer.from(JSON.stringify(parsed)).toString('base64url') })).rejects.toThrow()
    const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'two.txt'), 'private')
    rmSync(join(f.prepared.dir, 'target'), { recursive: true }); symlinkSync(outside, join(f.prepared.dir, 'target'))
    await expect(f.files.search(f.identity, { ...input, cursor: first.nextCursor! })).rejects.toThrow()
  })


  it('uses trusted Git paths including tracked ignored and untracked source, excludes ignored dependencies, and parses NUL names safely', async () => {
    const f = await fixture()
    // Base-tracked README remains visible despite a new ignore rule and an
    // empty trusted index. The model-controlled index/config is not authority.
    writeFileSync(join(f.prepared.dir, '.gitignore'), 'README.md\ndependencies/\n')
    mkdirSync(join(f.prepared.dir, 'dependencies'))
    for (let i = 0; i < 2100; i++) writeFileSync(join(f.prepared.dir, 'dependencies', `noise-${i}.txt`), 'ignored')
    writeFileSync(join(f.prepared.dir, 'new-源码.txt'), 'new source')
    writeFileSync(join(f.prepared.dir, 'unsafe\nphantom.txt'), 'not two file names')
    const found = await f.files.searchMany(f.identity, { changeId: f.prepared.id, queries: ['README', 'new-', 'noise', 'phantom'], mode: 'path', consistency: 'files' })
    expect(found.results.map(result => result.matches.map(match => match.path))).toEqual([['README.md'], ['new-源码.txt'], [], []])
    expect(found.results[0]!.skippedFiles).toBe(1)
    expect(found.results.every(result => result.scannedFiles < 10)).toBe(true)
    expect(found.inventory).toMatchObject({ scope: 'tracked_and_nonignored_untracked', complete: true })
    const direct = await f.files.read(f.identity, { changeId: f.prepared.id, path: 'dependencies/noise-0.txt', consistency: 'files' })
    expect(direct.content).toBe('ignored') // Discovery exclusion is not a new read permission restriction.
    mkdirSync(join(f.prepared.dir, 'src[one]'))
    writeFileSync(join(f.prepared.dir, 'src[one]', 'new.txt'), 'literal pathspec')
    expect((await f.files.search(f.identity, { changeId: f.prepared.id, path: 'src[one]', query: 'new', mode: 'path', consistency: 'files' })).matches)
      .toEqual([{ path: 'src[one]/new.txt' }])
  })

  it('reports incomplete inventory without pretending an exhausted page proves absence, and revalidates its version', async () => {
    const f = await fixture(), original = f.deps.changes
    f.deps.changes = { withChange(actor, use) { return original.withChange(actor, lease => use({ ...lease,
      async pathInventory() { return { paths: [], complete: false } },
    })) } }
    const input = { changeId: f.prepared.id, query: 'missing', mode: 'path' as const, consistency: 'files' as const }
    expect(await f.files.search(f.identity, input)).toMatchObject({ matches: [], truncated: true, nextCursor: null, limitReason: 'inventory', inventory: { complete: false } })
    let inventories = 0
    f.deps.changes = { withChange(actor, use) { return original.withChange(actor, lease => use({ ...lease,
      async pathInventory(path) { const result = await lease.pathInventory(path); if (++inventories === 2) result.paths.push('changed.txt'); return result },
    })) } }
    f.reads.length = 0
    await expect(f.files.search(f.identity, input)).rejects.toMatchObject({ code: 'version_conflict' })
    expect(f.reads).toEqual([])
  })

})
