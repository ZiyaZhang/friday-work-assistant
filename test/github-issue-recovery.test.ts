import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { GitHubIdentity, loadGitHubConfig, type GitHubHttp } from '../src/github/identity.js'
import { commentIssue, fingerprintOf, IssueLinks, openIssue } from '../src/github/issues.js'
import { createLogger } from '../src/log.js'

const input = { repo: 'org/a', title: 'Safari 登录白屏', body: '复现步骤：打开登录页', spaceId: 'sp_a', createdBy: 'ou_a' }
const issueUrl = 'https://github.com/org/a/issues/101'
const log = createLogger('github-recovery-test', 'error')

function remote() {
  const state = { searchError: false, readError: false, postUnknown: false, indexed: false, searchMatches: 1, searchTotal: null as number | null, incompleteSearch: false,
    readTitle: input.title, readKind: 'issue', readState: 'open', readNumber: 101, readRepo: null as string | null, createCount: 0, commentCount: 0, readCount: 0 }
  const calls: { method: string; path: string; body: unknown }[] = []
  let beforePost: (() => Promise<void>) | undefined
  const http: GitHubHttp = { async request(method, path, body) {
    calls.push({ method, path, body })
    if (path.startsWith('/search/issues')) {
      if (state.searchError) throw new Error('search unavailable')
      const items = state.indexed ? Array.from({ length: state.searchMatches }, (_, i) => ({ number: 101 + i, title: input.title, html_url: `https://github.com/org/a/issues/${101 + i}`, state: state.readState })) : []
      return { status: 200, data: { items, total_count: state.searchTotal ?? items.length, incomplete_results: state.incompleteSearch } as never }
    }
    if (method === 'POST') {
      await beforePost?.()
      if (path.endsWith('/comments')) {
        state.commentCount += 1
        if (state.postUnknown) throw new Error('connection lost after remote accepted comment')
        return { status: 201, data: { id: state.commentCount, html_url: `${issueUrl}#issuecomment-${state.commentCount}` } as never }
      }
      state.createCount += 1
      if (state.postUnknown) throw new Error('connection lost after remote created issue')
      return { status: 201, data: { number: 101, html_url: issueUrl } as never }
    }
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/issues\/101$/.test(path)) {
      state.readCount += 1
      if (state.readError) throw new Error('read-back unavailable')
      return { status: 200, data: { number: state.readNumber, title: state.readTitle, state: state.readState, html_url: state.readRepo ? `https://github.com/${state.readRepo}/issues/101` : `https://github.com/${path.slice('/repos/'.length)}`, labels: [], assignees: [], ...(state.readKind === 'pr' ? { pull_request: {} } : {}) } as never }
    }
    throw new Error(`unexpected ${method} ${path}`)
  } }
  const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'fake-test-token', FRIDAY_GITHUB_REPOS: 'org/a' } as NodeJS.ProcessEnv)!, log, http)
  return { github, state, calls, delayPosts: (wait: () => Promise<void>) => { beforePost = wait } }
}

function rememberExisting(links: IssueLinks) {
  links.remember({ fingerprint: fingerprintOf(input), repo: input.repo, number: 101, url: issueUrl, spaceId: input.spaceId, source: null })
}

describe('GitHub issue write recovery', () => {
  it('propagates search failure without treating it as an empty result or creating an operation', async () => {
    const registry = new Registry(':memory:')
    const links = new IssueLinks(registry.db)
    const gh = remote()
    gh.state.searchError = true
    await expect(openIssue(gh.github, links, { ...input, requestKey: 'open-1' })).rejects.toThrow('search unavailable')
    expect(gh.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(registry.db.prepare('SELECT * FROM github_issue_operations').all()).toHaveLength(0)
    gh.state.searchError = false
    expect(await openIssue(gh.github, links, { ...input, requestKey: 'open-1' })).toMatchObject({ action: 'created', number: 101 })
    expect(gh.state.createCount).toBe(1)
    registry.close()
  })

  it('remembers a returned issue number immediately even for callers without a request key', async () => {
    const registry = new Registry(':memory:')
    const links = new IssueLinks(registry.db)
    const gh = remote()
    gh.state.readError = true
    await expect(openIssue(gh.github, links, input)).rejects.toThrow('read-back unavailable')
    expect(links.get(fingerprintOf(input))).toMatchObject({ number: 101, url: issueUrl })
    registry.close()
  })

  it('persists sent before read-back; retry after reopen reads the created issue instead of creating or commenting again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-github-recovery-'))
    const path = join(dir, 'db.sqlite')
    let registry = new Registry(path)
    try {
      let links = new IssueLinks(registry.db)
      const gh = remote()
      gh.state.readError = true
      await expect(openIssue(gh.github, links, { ...input, requestKey: 'open-1' })).rejects.toThrow('read-back unavailable')
      expect(links.get(fingerprintOf(input))?.number).toBe(101)
      expect(registry.db.prepare('SELECT status, number FROM github_issue_operations').get()).toMatchObject({ status: 'sent', number: 101 })
      registry.close()
      registry = new Registry(path)
      links = new IssueLinks(registry.db)
      gh.state.readError = false
      expect(await openIssue(gh.github, links, { ...input, body: `${input.body}\n新的出处时间戳`, requestKey: 'open-1' })).toMatchObject({ action: 'created', number: 101 })
      expect(gh.state).toMatchObject({ createCount: 1, commentCount: 0, readCount: 2 })
      const again = await openIssue(gh.github, links, { ...input, requestKey: 'open-1' })
      expect(again).toMatchObject({ action: 'created', replayed: true })
      expect(gh.state.readCount).toBe(2) // replayed 显式表示已有确认结果，没有声称刚回读。
    } finally {
      registry.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['open-existing', 'comment'] as const)('retries only the read after a successful %s comment and failed GET', async (kind) => {
    const registry = new Registry(':memory:')
    const links = new IssueLinks(registry.db)
    rememberExisting(links)
    const gh = remote()
    gh.state.readError = true
    const run = () => kind === 'open-existing'
      ? openIssue(gh.github, links, { ...input, requestKey: 'comment-1' })
      : commentIssue(gh.github, { repo: input.repo, number: 101, body: input.body, requestKey: 'comment-1' }, links)
    await expect(run()).rejects.toThrow('read-back unavailable')
    expect(registry.db.prepare('SELECT status, number, comment_url FROM github_issue_operations').get()).toMatchObject({ status: 'sent', number: 101, comment_url: `${issueUrl}#issuecomment-1` })
    gh.state.readError = false
    // 两个只读重试可以同时回读，不重复 POST，也不误报另一个确认为 unknown。
    expect(await Promise.all([run(), run()])).toHaveLength(2)
    expect(gh.state.commentCount).toBe(1)
    expect(await run()).toMatchObject({ replayed: true })
    registry.close()
  })

  it.each(['unknown', 'planned'] as const)('does not replay an ambiguous POST after restart (%s state)', async (status) => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-github-unknown-'))
    const path = join(dir, 'db.sqlite')
    let registry = new Registry(path)
    try {
      let links = new IssueLinks(registry.db)
      const gh = remote()
      gh.state.postUnknown = true
      await expect(openIssue(gh.github, links, { ...input, requestKey: 'open-unknown' })).rejects.toThrow(/结果未知.*须核对.*不会自动重发/)
      await expect(commentIssue(gh.github, { repo: input.repo, number: 101, body: '评论', requestKey: 'comment-unknown' }, links)).rejects.toThrow(/结果未知/)
      // planned 是进程在 POST 返回/抛错与落状态之间退出留下的状态。
      if (status === 'planned') registry.db.prepare('UPDATE github_issue_operations SET status = ?').run(status)
      registry.close()
      registry = new Registry(path)
      links = new IssueLinks(registry.db)
      gh.state.postUnknown = false
      await expect(openIssue(gh.github, links, { ...input, requestKey: 'open-unknown' })).rejects.toThrow(/结果未知.*须核对/)
      await expect(commentIssue(gh.github, { repo: input.repo, number: 101, body: '评论', requestKey: 'comment-unknown' }, links)).rejects.toThrow(/不会自动重发/)
      expect(gh.state).toMatchObject({ createCount: 1, commentCount: 1, readCount: 0 })
    } finally {
      registry.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('CAS-plans the operation before POST so concurrent identical requests cannot both send', async () => {
    const registry = new Registry(':memory:')
    const links = new IssueLinks(registry.db)
    const gh = remote()
    let entered!: () => void
    const sending = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    gh.delayPosts(async () => { entered(); await gate })
    const first = openIssue(gh.github, links, { ...input, requestKey: 'concurrent' })
    await sending
    expect(registry.db.prepare('SELECT status FROM github_issue_operations').get()).toMatchObject({ status: 'planned' })
    await expect(openIssue(gh.github, links, { ...input, requestKey: 'concurrent' })).rejects.toThrow(/结果未知/)
    release()
    expect(await first).toMatchObject({ action: 'created' })
    expect(gh.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    registry.close()
  })

  it('preserves new-content comments under different keys and rejects reuse of a key for a different target', async () => {
    const registry = new Registry(':memory:')
    const links = new IssueLinks(registry.db)
    const gh = remote()
    await openIssue(gh.github, links, { ...input, requestKey: 'original-intent' })
    expect(await openIssue(gh.github, links, { ...input, body: '新增复现证据', requestKey: 'new-content-intent' })).toMatchObject({ action: 'commented' })
    expect(gh.state).toMatchObject({ createCount: 1, commentCount: 1 })
    await expect(openIssue(gh.github, links, { ...input, title: '别的问题', requestKey: 'original-intent' })).rejects.toThrow(/不同的操作/)
    await expect(commentIssue(gh.github, { repo: input.repo, number: 101, body: 'x', requestKey: 'original-intent' }, links)).rejects.toThrow(/不同的操作/)
    await expect(commentIssue(gh.github, { repo: input.repo, number: 101, body: 'x', requestKey: 'no-store' })).rejects.toThrow(/持久操作记录/)
    expect(gh.state).toMatchObject({ createCount: 1, commentCount: 1 })
    registry.close()
  })

  it('serializes different intents for the same issue while allowing unrelated repos to proceed', async () => {
    const registry = new Registry(':memory:')
    const links = new IssueLinks(registry.db)
    const gh = remote()
    let entered!: () => void
    const sending = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    gh.delayPosts(async () => { entered(); await gate })
    const first = openIssue(gh.github, links, { ...input, requestKey: 'intent-a' })
    await sending
    const second = openIssue(gh.github, links, { ...input, body: '不同的补充证据', requestKey: 'intent-b' })
    const unrelated = remote()
    expect(await openIssue(unrelated.github, links, { ...input, repo: 'org/b', requestKey: 'unrelated' })).toMatchObject({ repo: 'org/b', action: 'created' })
    expect(gh.calls.filter((c) => c.path.startsWith('/search/issues'))).toHaveLength(1)
    release()
    const results = await Promise.all([first, second])
    expect(results.map((r) => r.action)).toEqual(['created', 'commented'])
    expect(gh.state).toMatchObject({ createCount: 1, commentCount: 1 })
    registry.close()
  })

  it('blocks replay when the response was received but persisting sent failed', async () => {
    const registry = new Registry(':memory:')
    const links = new IssueLinks(registry.db)
    const gh = remote()
    registry.db.exec("CREATE TRIGGER reject_sent BEFORE UPDATE OF status ON github_issue_operations WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'sent commit failed'); END")
    await expect(openIssue(gh.github, links, { ...input, requestKey: 'write-failed' })).rejects.toThrow(/结果未知/)
    expect(links.get(fingerprintOf(input))?.number).toBe(101)
    registry.db.exec('DROP TRIGGER reject_sent')
    await expect(openIssue(gh.github, links, { ...input, requestKey: 'write-failed' })).rejects.toThrow(/不会自动重发/)
    expect(gh.state).toMatchObject({ createCount: 1, commentCount: 0, readCount: 0 })
    registry.close()
  })

  it.each(['unknown', 'planned'] as const)('blocks a new key and edited body after an ambiguous create survives restart (%s)', async (status) => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-issue-fingerprint-'))
    const path = join(dir, 'db.sqlite')
    let registry = new Registry(path)
    try {
      const gh = remote()
      gh.state.postUnknown = true
      await expect(openIssue(gh.github, new IssueLinks(registry.db), { ...input, requestKey: 'first-create' })).rejects.toThrow(/结果未知/)
      registry.db.prepare('UPDATE github_issue_operations SET status = ?').run(status)
      registry.close()
      registry = new Registry(path)
      gh.state.postUnknown = false
      await expect(openIssue(gh.github, new IssueLinks(registry.db), { ...input, body: `${input.body}\n多一句证据`, requestKey: 'changed-body' })).rejects.toThrow(/结果未知.*须核对/)
      expect(gh.state).toMatchObject({ createCount: 1, commentCount: 0 })
      expect(registry.db.prepare('SELECT request_key, status, fingerprint FROM github_issue_operations').all()).toEqual([
        { request_key: 'first-create', status, fingerprint: fingerprintOf(input) },
      ])
    } finally {
      registry.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reuses a remotely verified issue after search catches up, including a now-closed issue', async () => {
    const registry = new Registry(':memory:')
    const links = new IssueLinks(registry.db)
    const gh = remote()
    gh.state.postUnknown = true
    await expect(openIssue(gh.github, links, { ...input, requestKey: 'first-create' })).rejects.toThrow(/结果未知/)
    gh.state.postUnknown = false
    gh.state.indexed = true
    gh.state.readState = 'closed'
    expect(await openIssue(gh.github, links, { ...input, body: '新的证据', requestKey: 'new-content' })).toMatchObject({ action: 'commented', number: 101, state: 'closed' })
    expect(gh.state).toMatchObject({ createCount: 1, commentCount: 1 })
    const commentIndex = gh.calls.findIndex((c) => c.method === 'POST' && c.path.endsWith('/comments'))
    expect(gh.calls.slice(0, commentIndex).some((c) => c.method === 'GET' && c.path === '/repos/org/a/issues/101')).toBe(true)
    expect(registry.db.prepare("SELECT status FROM github_issue_operations WHERE request_key = 'first-create'").get()).toMatchObject({ status: 'unknown' })
    registry.close()
  })

  it.each(['read-failed', 'title-mismatch', 'number-mismatch', 'repo-mismatch', 'pr'] as const)('keeps an ambiguous create blocked when candidate verification fails: %s', async (kind) => {
    const registry = new Registry(':memory:')
    const links = new IssueLinks(registry.db)
    const gh = remote()
    gh.state.postUnknown = true
    await expect(openIssue(gh.github, links, { ...input, requestKey: 'first-create' })).rejects.toThrow(/结果未知/)
    gh.state.postUnknown = false
    gh.state.indexed = true
    gh.state.readError = kind === 'read-failed'
    gh.state.readTitle = kind === 'title-mismatch' ? '另一个问题' : input.title
    gh.state.readKind = kind === 'pr' ? 'pr' : 'issue'
    gh.state.readNumber = kind === 'number-mismatch' ? 102 : 101
    gh.state.readRepo = kind === 'repo-mismatch' ? 'org/b' : null
    await expect(openIssue(gh.github, links, { ...input, body: '补充', requestKey: 'new-content' })).rejects.toThrow(/结果未知.*须核对/)
    expect(gh.state).toMatchObject({ createCount: 1, commentCount: 0 })
    expect(links.get(fingerprintOf(input))).toBeUndefined()
    registry.close()
  })

  it('does not block an unrelated fingerprint or independent comment intentions', async () => {
    const registry = new Registry(':memory:')
    const links = new IssueLinks(registry.db)
    const gh = remote()
    gh.state.postUnknown = true
    await expect(openIssue(gh.github, links, { ...input, requestKey: 'first-create' })).rejects.toThrow(/结果未知/)
    gh.state.postUnknown = false
    expect(await openIssue(gh.github, links, { ...input, title: '独立问题', requestKey: 'unrelated' })).toMatchObject({ action: 'created' })
    expect(await commentIssue(gh.github, { repo: input.repo, number: 101, body: '独立评论委托', requestKey: 'comment' }, links)).toMatchObject({ number: 101 })
    expect(gh.state).toMatchObject({ createCount: 2, commentCount: 1 })
    registry.close()
  })

  it.each(['multiple', 'more-pages', 'incomplete'] as const)('does not guess a recovery candidate when search is %s', async (coverage) => {
    const registry = new Registry(':memory:')
    const links = new IssueLinks(registry.db)
    const gh = remote()
    gh.state.postUnknown = true
    await expect(openIssue(gh.github, links, { ...input, requestKey: 'first-create' })).rejects.toThrow(/结果未知/)
    gh.state.postUnknown = false
    gh.state.indexed = true
    gh.state.searchMatches = coverage === 'multiple' ? 2 : 1
    gh.state.searchTotal = coverage === 'more-pages' ? 6 : null
    gh.state.incompleteSearch = coverage === 'incomplete'
    await expect(openIssue(gh.github, links, { ...input, body: '补充', requestKey: 'new-content' })).rejects.toThrow(/结果未知.*须核对/)
    expect(gh.state).toMatchObject({ createCount: 1, commentCount: 0, readCount: 0 })
    registry.close()
  })

  it('migrates legacy operations without deleting them and associates the same static signature on a changed-body retry', async () => {
    const registry = new Registry(':memory:')
    const gh = remote()
    gh.state.postUnknown = true
    await expect(openIssue(gh.github, new IssueLinks(registry.db), { ...input, requestKey: 'legacy-create' })).rejects.toThrow(/结果未知/)
    // Recreate the previous schema exactly: all original columns/rows remain, fingerprint did not exist.
    registry.db.exec('DROP INDEX idx_issue_operations_fingerprint; ALTER TABLE github_issue_operations DROP COLUMN fingerprint')
    const links = new IssueLinks(registry.db)
    expect(registry.db.prepare('SELECT fingerprint FROM github_issue_operations').get()).toEqual({ fingerprint: null })
    gh.state.postUnknown = false
    await expect(openIssue(gh.github, links, { ...input, body: `${input.body}\n多一句`, requestKey: 'changed-body' })).rejects.toThrow(/结果未知.*须核对/)
    expect(registry.db.prepare('SELECT request_key, status, fingerprint FROM github_issue_operations').all()).toEqual([
      { request_key: 'legacy-create', status: 'unknown', fingerprint: fingerprintOf(input) },
    ])
    expect(gh.state).toMatchObject({ createCount: 1, commentCount: 0 })
    registry.close()
  })
})
