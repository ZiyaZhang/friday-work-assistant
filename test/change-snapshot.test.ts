import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChangeManager, MARKER_FILE } from '../src/github/changes.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { createLogger } from '../src/log.js'

const cleanups: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close() })
function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'test@example.test', ...env },
  }).trim()
}
async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-snapshot-'))), source = join(home, 'source'), bare = join(home, 'remote.git'), cwd = join(home, 'workspace')
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(source); git(source, ['init', '-q']); git(source, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  writeFileSync(join(source, 'stable.txt'), 'stable bytes\n'); writeFileSync(join(source, 'edit.txt'), 'first\n')
  writeFileSync(join(source, 'crlf.txt'), 'a\r\nb\r\n'); git(source, ['-c', 'core.autocrlf=false', 'add', '-A']); git(source, ['commit', '-qm', 'initial'])
  git(home, ['clone', '--quiet', '--bare', source, bare])
  const registry = new Registry(':memory:'); cleanups.push(() => registry.close())
  const options = { db: registry.db, cacheDir: join(home, 'cache'), github: { repoAllowed: () => true } as unknown as GitHubIdentity,
    log: createLogger('snapshot-test', 'error'), remoteUrlFor: () => `file://${bare}` }
  const changes = new ChangeManager(options), actor = { cwd, sessionKey: 's', requesterOpenId: 'alice', workKey: 'original-work' }
  const prepared = await changes.prepare({ ...actor, repo: 'org/demo', base: 'main' })
  // Old mtimes avoid accidentally exercising only Git's conservative racy-index
  // fallback instead of its real stat cache; ctime is never forged by this fixture.
  const old = new Date(Date.now() - 60_000)
  for (const file of ['stable.txt', 'edit.txt', 'crlf.txt']) utimesSync(join(prepared.dir, file), old, old)
  const gitDir = String(registry.db.prepare('SELECT git_dir FROM github_changes WHERE id=?').get(prepared.id)!.git_dir)
  const args = [`--git-dir=${gitDir}`, `--work-tree=${prepared.dir}`]
  const inspect = () => changes.inspect({ ...actor, dir: prepared.dir })
  // Independent cold-index oracle preserves the pre-optimization semantics.
  const coldTree = () => {
    const env = { GIT_INDEX_FILE: join(home, 'oracle.index') }
    git(prepared.dir, [...args, 'read-tree', prepared.head], env)
    git(prepared.dir, [...args, 'add', '-A', '--', '.'], env)
    git(prepared.dir, [...args, 'reset', '--quiet', prepared.head, '--', MARKER_FILE], env)
    return git(home, [...args, 'write-tree'], env)
  }
  return { home, changes, options, actor, prepared, gitDir, args, inspect, coldTree }
}

describe('trusted change snapshot semantics (real Git)', () => {
  it('keeps the same exact tree across repeated reads and manager restart', async () => {
    const t = await fixture(), original = await t.inspect()
    expect((await t.inspect()).snapshot).toBe(original.snapshot)
    const reopened = new ChangeManager(t.options)
    expect((await reopened.inspect({ ...t.actor, dir: t.prepared.dir })).snapshot).toBe(original.snapshot)
  })

  it('matches a fresh trusted index for changed/new/deleted/renamed/ignored files and executable modes', async () => {
    const t = await fixture(), file = (name: string) => join(t.prepared.dir, name)
    for (const mutate of [
      () => {}, () => writeFileSync(file('edit.txt'), 'changed\n'), () => writeFileSync(file('new.txt'), 'new\n'),
      () => writeFileSync(file('.gitignore'), 'new.txt\n'), () => renameSync(file('edit.txt'), file('renamed.txt')),
      () => rmSync(file('stable.txt')), () => chmodSync(file('renamed.txt'), 0o755),
    ]) {
      mutate(); expect((await t.inspect()).snapshot).toBe(t.coldTree())
    }
    expect((await t.inspect()).files).not.toContain('new.txt')
  })

  it('detects external same-size content changes with a restored mtime and rejects the stale approved tree', async () => {
    const t = await fixture(), before = await t.inspect(), path = join(t.prepared.dir, 'edit.txt'), old = statSync(path)
    writeFileSync(path, 'other\n'); utimesSync(path, old.atime, old.mtime)
    expect(statSync(path).size).toBe(old.size); expect(statSync(path).mtimeMs).toBeCloseTo(old.mtimeMs, 2)
    const changed = await t.inspect()
    expect(changed.snapshot).not.toBe(before.snapshot); expect(changed.snapshot).toBe(t.coldTree())
    await expect(t.changes.publish({ ...t.actor, dir: t.prepared.dir, title: 'Synthetic', body: '', expectedSnapshot: before.snapshot }))
      .rejects.toThrow(/变化/)
  })

  it('does not borrow worker index flags, ignore-stat config or clean filters to hide changed bytes', async () => {
    const t = await fixture(), before = await t.inspect(), path = join(t.prepared.dir, 'edit.txt'), old = statSync(path)
    git(t.prepared.dir, ['update-index', '--assume-unchanged', '--', 'edit.txt'])
    git(t.prepared.dir, ['update-index', '--skip-worktree', '--', 'edit.txt'])
    git(t.prepared.dir, ['config', 'core.ignoreStat', 'true']); git(t.prepared.dir, ['config', 'core.trustctime', 'false'])
    const witness = join(t.home, 'worker-filter-ran')
    git(t.prepared.dir, ['config', 'filter.poison.clean', `sh -c "touch '${witness}'; cat"`])
    git(t.prepared.dir, ['config', 'filter.poison.required', 'true'])
    writeFileSync(join(t.prepared.dir, '.gitattributes'), 'edit.txt filter=poison\n')
    writeFileSync(path, 'other\n'); utimesSync(path, old.atime, old.mtime)
    const actual = await t.inspect()
    expect(actual.snapshot).not.toBe(before.snapshot); expect(actual.snapshot).toBe(t.coldTree())
    expect(git(t.home, [`--git-dir=${t.gitDir}`, 'show', `${actual.snapshot}:edit.txt`])).toBe('other')
    expect(existsSync(witness)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('other\n')
  })

  it('keeps cold-tree normalization when a new attributes rule changes otherwise untouched tracked bytes', async () => {
    const t = await fixture(); await t.inspect()
    writeFileSync(join(t.prepared.dir, '.gitattributes'), '*.txt text eol=lf\n')
    expect((await t.inspect()).snapshot).toBe(t.coldTree())
  })
})
