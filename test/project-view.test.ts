import { describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { GitHubIdentity, type GitHubHttp } from '../src/github/identity.js'
import { GitHubProjectView } from '../src/github/project-view.js'
import { createLogger } from '../src/log.js'

const DAY = 86_400_000
const T = Date.parse('2026-09-19T00:00:00Z')
const log = createLogger('project-test', 'error')
const iso = (offset: number) => new Date(T + offset).toISOString()
function item(number: number, patch: Record<string, unknown> = {}, repo = 'org/a') {
  return { number, title: `Issue ${number}`, state: 'open', state_reason: null, html_url: `https://github.com/${repo}/issues/${number}`,
    assignees: [], created_at: iso(-5 * DAY), updated_at: iso(-DAY), closed_at: null, ...patch }
}
function pr(number: number, patch: Record<string, unknown> = {}, repo = 'org/a') {
  return item(number, { html_url: `https://github.com/${repo}/pull/${number}`, pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}` }, merged_at: null, draft: false, ...patch }, repo)
}
function setup(opts: { pageSize?: number; maxPages?: number; staleAfterMs?: number } = {}) {
  let now = T
  const db = new Registry(':memory:').db
  const allowedRepos = ['org/a', 'org/b']
  const calls: { method: string; path: string }[] = []
  const routes = new Map<string, { status: number; data: unknown }>()
  const http: GitHubHttp = {
    async request(method, path) {
      calls.push({ method, path })
      const url = new URL(path, 'https://api.github.com')
      const route = routes.get(`${url.pathname}:${url.searchParams.get('page') ?? ''}`)
      return (route ?? { status: 200, data: [] }) as never
    },
  }
  const github = new GitHubIdentity({ apiUrl: 'https://api.github.com', token: 'fake-token-not-real', allowedRepos }, log, http)
  const options = { pageSize: 2, now: () => now, ...opts }
  const service = new GitHubProjectView(db, github, options)
  const page = (kind: 'issues' | 'pulls', n: number, data: unknown, status = 200, repo = 'org/a') => routes.set(`/repos/${repo}/${kind}:${n}`, { status, data })
  return { service, db, github, options, allowedRepos, calls, page, time: (value: number) => { now = value } }
}

describe('GitHub project mirror: facts, pagination and elapsed time', () => {
  it('reads all issue/PR pages once, identifies repo+number and stores real state/assignees/URLs and elapsed times', async () => {
    const t = setup()
    t.page('issues', 1, [item(1, { state: 'closed', state_reason: 'completed', closed_at: iso(-2 * DAY), assignees: [{ login: 'Alice' }] }), pr(2, { state: 'closed', closed_at: iso(-DAY) })])
    t.page('issues', 2, [item(3)])
    t.page('pulls', 1, [pr(2, { state: 'closed', closed_at: iso(-DAY), merged_at: iso(-DAY), assignees: [{ login: 'Bob' }] })])
    const status = await t.service.sync('Org/A')
    expect(status).toMatchObject({ repo: 'org/a', syncAt: T, lastCompleteSyncAt: T, stale: false,
      coverage: { complete: true, issues: { pages: 2, items: 3 }, pullRequests: { pages: 1, items: 1 } } })
    const view = t.service.view(['org/a'])
    expect(view.items).toHaveLength(3)
    expect(view.items[0]).toMatchObject({ id: 'org/a#1', kind: 'issue', state: 'closed', stateReason: 'completed', assignees: ['Alice'], createdToClosedMs: 3 * DAY, createdToMergedMs: null, stale: false })
    expect(view.items[1]).toMatchObject({ id: 'org/a#2', kind: 'pr', state: 'closed', assignees: ['Bob'], mergedAt: T - DAY, createdToMergedMs: 4 * DAY, draft: false, stale: false, coverage: { mergeStateKnown: true } })
    expect(view.items[2]).toMatchObject({ state: 'open', createdToClosedMs: null, createdToMergedMs: null })
    expect(JSON.stringify(view)).not.toMatch(/fake-token|effort|blocked|workHours/)
    expect(t.calls.every((x) => x.method === 'GET' && x.path.includes('state=all') && x.path.includes('direction=asc'))).toBe(true)
    expect(new GitHubProjectView(t.db, t.github, t.options).view(['ORG/A'], 'alice').items.map((x) => x.number)).toEqual([1])
  })

  it('fetches an empty terminating page when the preceding page is full; page cap is explicitly incomplete', async () => {
    const t = setup({ maxPages: 1 })
    t.page('issues', 1, [item(1), item(2)])
    const status = await t.service.sync('org/a')
    expect(status).toMatchObject({ lastCompleteSyncAt: null, stale: true, coverage: { complete: false, issues: { reason: 'page_limit', pages: 1 } } })
    const withRoom = new GitHubProjectView(t.db, t.github, { ...t.options, maxPages: 2 })
    expect((await withRoom.sync('org/a')).coverage.issues).toMatchObject({ complete: true, pages: 2, items: 2 })
    expect(t.calls.some((x) => x.path.includes('/issues?') && x.path.endsWith('page=2'))).toBe(true)
  })

  it('distinguishes unsynced, confirmed empty and stale snapshots without inventing work or assignees', async () => {
    const t = setup({ staleAfterMs: 100 })
    expect(t.service.view(['org/a'])).toMatchObject({ items: [], stale: true, coverageComplete: false, repositories: [{ syncAt: null, coverage: { issues: { reason: 'not_synced' } } }] })
    await t.service.sync('org/a')
    expect(t.service.view(['org/a'])).toMatchObject({ items: [], stale: false, coverageComplete: true })
    t.time(T + 100)
    expect(t.service.view(['org/a']).stale).toBe(true)
    expect(t.service.view([]).coverageComplete).toBe(false)
  })

  it('keeps different repo identities separate and filters only actual assignees case-insensitively', async () => {
    const t = setup()
    t.page('issues', 1, [item(7, { assignees: [{ login: 'alice' }] })])
    t.page('issues', 1, [item(7, { assignees: [{ login: 'bob' }] }, 'org/b')], 200, 'org/b')
    await t.service.sync('org/a')
    await t.service.sync('org/b')
    expect(t.service.view(['org/a', 'ORG/A', 'org/b']).items.map((x) => x.id)).toEqual(['org/a#7', 'org/b#7'])
    expect(t.service.view(['org/a', 'org/b'], 'BOB').items.map((x) => x.id)).toEqual(['org/b#7'])
    expect(t.service.view(['org/a', 'org/b'], 'nobody').items).toEqual([])
  })
})

describe('GitHub project mirror: incomplete data never closes or erases unseen work', () => {
  it('persists good pages on a later failure, preserves old unseen rows and the last complete time', async () => {
    const t = setup()
    t.page('issues', 1, [item(9)])
    await t.service.sync('org/a')
    t.time(T + 100)
    t.page('issues', 1, [item(1), item(2)])
    t.page('issues', 2, { message: 'fake upstream details: SECRET_SENTINEL' }, 403)
    const result = await t.service.sync('org/a')
    expect(result).toMatchObject({ syncAt: T + 100, lastCompleteSyncAt: T, stale: true, coverage: { complete: false, issues: { pages: 1, items: 2, reason: 'request_failed', httpStatus: 403 } } })
    expect(t.service.view(['org/a']).items.map((x) => x.number)).toEqual([1, 2, 9])
    expect(t.service.view(['org/a']).items.find((x) => x.number === 9)).toMatchObject({ state: 'open', closedAt: null, stale: true, syncAt: T })
    expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL')
  })

  it('even a completed newer crawl preserves an absent row as stale rather than inventing deletion or closure', async () => {
    const t = setup()
    t.page('issues', 1, [item(9)])
    await t.service.sync('org/a')
    t.time(T + 100)
    t.page('issues', 1, [item(1)])
    await t.service.sync('org/a')
    const view = t.service.view(['org/a'])
    expect(view.coverageComplete).toBe(true) // 当前两个端点分页完成，不代表旧行自动被删除。
    expect(view.stale).toBe(true)
    expect(view.items.find((x) => x.number === 9)).toMatchObject({ state: 'open', closedAt: null, stale: true })
    expect(view.items.find((x) => x.number === 1)?.stale).toBe(false)
  })

  it('uses a sync identity rather than wall-clock equality to detect an unseen old row', async () => {
    const t = setup()
    t.page('issues', 1, [item(9)])
    const first = await t.service.sync('org/a')
    t.page('issues', 1, [item(1)])
    const second = await t.service.sync('org/a') // 同一毫秒/假时钟，仍是新一轮观察。
    expect(first.syncAt).toBe(second.syncAt)
    expect(first.snapshotId).not.toBe(second.snapshotId)
    expect(t.service.view(['org/a']).items.find((x) => x.number === 9)?.stale).toBe(true)
    expect(t.service.view(['org/a']).items.find((x) => x.number === 1)?.stale).toBe(false)
  })

  it('does not erase known PR merge facts when the newer issues page lacks them and pulls fails', async () => {
    const t = setup()
    const merged = pr(2, { state: 'closed', closed_at: iso(-DAY), merged_at: iso(-DAY) })
    t.page('issues', 1, [merged])
    t.page('pulls', 1, [merged])
    await t.service.sync('org/a')
    t.time(T + 100)
    t.page('issues', 1, [pr(2, { title: 'Updated title', state: 'closed', closed_at: iso(-DAY), updated_at: iso(0) })])
    t.page('pulls', 1, { message: 'Not Found' }, 404)
    await t.service.sync('org/a')
    expect(t.service.view(['org/a']).items[0]).toMatchObject({ title: 'Updated title', mergedAt: T - DAY, createdToMergedMs: 4 * DAY, stale: true,
      coverage: { pullObservedAt: T, issueObservedAt: T + 100, mergeStateKnown: true } })
  })

  it('does not treat an unobserved pull as unmerged; malformed rows/URLs are gaps, not valid snapshots', async () => {
    const t = setup({ pageSize: 10 })
    t.page('issues', 1, [pr(2), item(3, { html_url: 'https://github.com/secret/repo/issues/3' }), item(4, { updated_at: 'invalid' }), item(5, { assignees: undefined })])
    t.page('pulls', 1, { unexpected: 'shape' })
    const result = await t.service.sync('org/a')
    expect(result.coverage).toMatchObject({ complete: false, issues: { reason: 'invalid_item', invalidItems: 3, items: 1 }, pullRequests: { reason: 'invalid_response' } })
    expect(t.service.view(['org/a']).items).toHaveLength(1)
    expect(t.service.view(['org/a']).items[0]).toMatchObject({ number: 2, mergedAt: null, draft: null, stale: true, coverage: { mergeStateKnown: false } })
  })

  it('flags overlapping pagination and keeps the newer observation; a later old snapshot cannot regress state', async () => {
    const t = setup()
    const closed = item(1, { state: 'closed', closed_at: iso(0), updated_at: iso(0) })
    t.page('issues', 1, [item(1), item(2)])
    t.page('issues', 2, [closed])
    expect((await t.service.sync('org/a')).coverage.issues).toMatchObject({ complete: false, duplicates: 1, reason: 'pagination_shift' })
    expect(t.service.view(['org/a']).items[0]?.state).toBe('closed')
    t.time(T + 100)
    t.page('issues', 1, [item(1)])
    await t.service.sync('org/a')
    expect(t.service.view(['org/a']).items[0]).toMatchObject({ state: 'closed', updatedAt: T, syncAt: T, stale: true })
  })

  it('rolls back the batch if recording its coverage fails; old snapshot and sync receipt stay coherent', async () => {
    const t = setup()
    t.page('issues', 1, [item(1)])
    await t.service.sync('org/a')
    t.db.exec("CREATE TRIGGER fail_sync BEFORE UPDATE ON github_project_sync BEGIN SELECT RAISE(ABORT, 'fixture sync failure'); END")
    t.time(T + 100)
    t.page('issues', 1, [item(1, { title: 'Uncommitted', updated_at: iso(0) })])
    await expect(t.service.sync('org/a')).rejects.toThrow('fixture sync failure')
    expect(t.service.view(['org/a']).items[0]).toMatchObject({ title: 'Issue 1', syncAt: T })
    expect(t.service.view(['org/a']).repositories[0]?.syncAt).toBe(T)
  })
})

describe('GitHub project mirror: repository authorization', () => {
  it('rejects unallowed repos and injected paths before any request, and rechecks cached reads after revocation', async () => {
    const t = setup()
    for (const repo of ['org/private', 'org/a?state=open', '../secret', 'https://github.com/org/a', 'org/..']) {
      await expect(t.service.sync(repo)).rejects.toThrow()
      expect(() => t.service.view([repo])).toThrow()
    }
    expect(t.calls).toEqual([])
    t.page('issues', 1, [item(1)])
    await t.service.sync('org/a')
    t.allowedRepos.splice(0, t.allowedRepos.length, 'org/b')
    expect(() => t.service.view(['org/a'])).toThrow('允许范围')
    await expect(t.service.sync('org/a')).rejects.toThrow('允许范围')
  })

  it('serializes concurrent syncs per repo and keeps one stable row per GitHub item', async () => {
    const t = setup()
    t.page('issues', 1, [item(1)])
    await Promise.all([t.service.sync('org/a'), t.service.sync('ORG/A')])
    expect(t.calls.map((x) => x.path.split('?')[0])).toEqual(['/repos/org/a/issues', '/repos/org/a/pulls', '/repos/org/a/issues', '/repos/org/a/pulls'])
    expect(t.service.view(['org/a']).items).toHaveLength(1)
  })
})
