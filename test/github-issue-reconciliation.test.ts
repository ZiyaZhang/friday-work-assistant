import { describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { GitHubIdentity, loadGitHubConfig, type GitHubHttp } from '../src/github/identity.js'
import { IN_FLIGHT_GRACE_MS, IssueReconciliation, SEARCH_SETTLE_MS } from '../src/github/issue-reconciliation.js'
import { fingerprintOf, IssueLinks, openIssue } from '../src/github/issues.js'
import { createLogger } from '../src/log.js'

const NOW = 1_800_000_000_000
const BOT = 'friday-bot[bot]'
const input = { repo: 'org/a', title: 'Safari 登录白屏', body: '复现步骤：打开登录页', spaceId: 'sp_a', createdBy: 'ou_a' }
const fingerprint = fingerprintOf(input)
const log = createLogger('github-reconciliation-test', 'error')

interface RemoteIssue { number: number; title: string; login: string; createdAt: number; state: string; pull: boolean }

/** The original run is gone: only the ledger row, the configured identity and the platform remain. */
function setup() {
  const registry = new Registry(':memory:')
  let clock = NOW
  const links = new IssueLinks(registry.db, () => clock)
  const issues = new Map<number, RemoteIssue>()
  const state = {
    login: BOT, loginError: false, searchError: false, incompleteSearch: false, totalOverride: null as number | null, hidden: new Set<number>(),
    readError: false, readOverride: {} as Partial<RemoteIssue>, post: 'ok' as 'ok' | 'lost_after_create' | 'lost_before_create',
    createCount: 0, commentCount: 0, nextNumber: 101,
  }
  const calls: { method: string; path: string }[] = []
  const issueUrl = (n: number) => `https://github.com/org/a/issues/${n}`
  const item = (i: RemoteIssue) => ({ number: i.number, title: i.title, html_url: issueUrl(i.number), state: i.state, user: { login: i.login },
    created_at: new Date(i.createdAt).toISOString(), labels: [], assignees: [], ...(i.pull ? { pull_request: {} } : {}) })
  const http: GitHubHttp = { async request(method, path) {
    calls.push({ method, path })
    if (path === '/user') {
      if (state.loginError) throw new Error('identity unavailable')
      return { status: 200, data: { login: state.login } as never }
    }
    if (path.startsWith('/search/issues')) {
      if (state.searchError) throw new Error('search unavailable')
      const params = new URL(`https://api.github.com${path}`).searchParams
      const q = params.get('q') ?? ''
      const since = q.includes('created:>=') ? Date.parse(q.match(/created:>=(\S+)/)?.[1] ?? '') : -Infinity
      const repo = q.match(/repo:(\S+)/)?.[1]
      const titleQuery = q.match(/in:title (.+)$/)?.[1]
      const perPage = Number(params.get('per_page') ?? 30), page = Number(params.get('page') ?? 1)
      const all = [...issues.values()].filter((i) => !state.hidden.has(i.number) && repo === 'org/a' && i.createdAt >= since && (!titleQuery || i.title.includes(titleQuery)))
        .sort((a, b) => a.createdAt - b.createdAt || a.number - b.number)
      const items = all.slice((page - 1) * perPage, page * perPage).map(item)
      return { status: 200, data: { items, total_count: state.totalOverride ?? all.length, incomplete_results: state.incompleteSearch } as never }
    }
    const read = path.match(/^\/repos\/org\/a\/issues\/(\d+)$/)
    if (method === 'GET' && read) {
      if (state.readError) throw new Error('read-back unavailable')
      const issue = issues.get(Number(read[1]))
      if (!issue) return { status: 404, data: { message: 'Not Found' } as never }
      return { status: 200, data: item({ ...issue, ...state.readOverride }) as never }
    }
    if (method === 'POST' && path === '/repos/org/a/issues') {
      if (state.post === 'lost_before_create') throw new Error('connection lost before GitHub received the request')
      const number = state.nextNumber++
      state.createCount += 1
      issues.set(number, { number, title: input.title, login: state.login, createdAt: clock, state: 'open', pull: false })
      if (state.post === 'lost_after_create') throw new Error('connection lost after remote created issue')
      return { status: 201, data: { number, html_url: issueUrl(number) } as never }
    }
    if (method === 'POST' && path.endsWith('/comments')) {
      state.commentCount += 1
      return { status: 201, data: { id: state.commentCount, html_url: `${issueUrl(Number(path.match(/issues\/(\d+)\//)?.[1]))}#issuecomment-${state.commentCount}` } as never }
    }
    throw new Error(`unexpected ${method} ${path}`)
  } }
  const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'fake-test-token', FRIDAY_GITHUB_REPOS: 'org/a' } as NodeJS.ProcessEnv)!, log, http)
  const reconciliation = new IssueReconciliation(github, links)
  const row = (key: string) => registry.db.prepare('SELECT * FROM github_issue_operations WHERE request_key = ?').get(key) as Record<string, unknown>
  const note = (key: string) => JSON.parse(String(row(key).reconciliation)) as Record<string, unknown>
  /** Leaves the ledger exactly as a lost acknowledgement does: an unknown creation without a number. */
  const seedUnknown = async (key: string, post: 'lost_after_create' | 'lost_before_create') => {
    state.post = post
    await expect(openIssue(github, links, { ...input, requestKey: key })).rejects.toThrow(/结果未知/)
    state.post = 'ok'
  }
  const addRemote = (number: number, extra: Partial<RemoteIssue> = {}) => {
    issues.set(number, { number, title: input.title, login: BOT, createdAt: clock, state: 'open', pull: false, ...extra })
  }
  const posts = () => calls.filter((c) => c.method === 'POST').length
  /** Reconciliation searches carry the created:>= bound; openIssue's own title dedupe search does not. */
  const reconcileSearches = () => calls.filter((c) => c.path.startsWith('/search/issues') && c.path.includes(encodeURIComponent('created:>=')))
  return { registry, links, state, calls, issues, github, reconciliation, row, note, seedUnknown, addRemote, posts, reconcileSearches, advance: (ms: number) => { clock += ms } }
}

describe('IssueReconciliation: read-only update of an unresolved creation', () => {
  it('confirms the single candidate created by our identity after verifying it by number, and remembers the link', async () => {
    const t = setup()
    await t.seedUnknown('lost-ack', 'lost_after_create')
    expect(t.row('lost-ack')).toMatchObject({ status: 'unknown', number: null, error: 'connection lost after remote created issue' })
    expect(t.links.get(fingerprint)).toBeUndefined()
    t.advance(30_000)
    const before = t.calls.length
    const receipt = await t.reconciliation.reconcile('lost-ack', { spaceId: input.spaceId })
    expect(receipt).toMatchObject({ requestKey: 'lost-ack', result: 'confirmed', status: 'confirmed', number: 101, url: 'https://github.com/org/a/issues/101', checkedAt: NOW + 30_000 })
    expect(t.row('lost-ack')).toMatchObject({ status: 'confirmed', number: 101, url: 'https://github.com/org/a/issues/101', error: null })
    expect(JSON.parse(String(t.row('lost-ack').result))).toMatchObject({ action: 'created', repo: 'org/a', number: 101, title: input.title, state: 'open' })
    expect(t.note('lost-ack')).toMatchObject({ result: 'confirmed', login: BOT, checkedAt: NOW + 30_000, previousError: 'connection lost after remote created issue' })
    expect(t.links.get(fingerprint)).toMatchObject({ repo: 'org/a', number: 101 })
    expect(t.calls.slice(before).map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual(['GET /user', 'GET /search/issues', 'GET /repos/org/a/issues/101'])
    expect(t.state.createCount).toBe(1)
    expect(t.links.hasUnresolvedCreation(fingerprint, 'unused')).toBe(false)
    t.registry.close()
  })

  it('searches from the operation time with a clock-skew allowance and only for issues in the recorded repo', async () => {
    const t = setup()
    await t.seedUnknown('lost-ack', 'lost_after_create')
    await t.reconciliation.reconcile('lost-ack', { spaceId: input.spaceId })
    const [search] = t.reconcileSearches()
    const q = new URL(`https://api.github.com${search!.path}`).searchParams.get('q')!
    expect(q).toContain('repo:org/a')
    expect(q).toContain('is:issue')
    const since = Date.parse(q.match(/created:>=(\S+)/)![1]!)
    expect(since).toBeLessThanOrEqual(NOW)
    expect(since).toBeGreaterThan(NOW - 60 * 60_000)
    t.registry.close()
  })

  it('proves absence only with complete results and only once the search index has had time to settle', async () => {
    const t = setup()
    await t.seedUnknown('lost-request', 'lost_before_create')
    expect(t.state.createCount).toBe(0)
    expect(t.links.hasUnresolvedCreation(fingerprint, 'unused')).toBe(true)
    // Zero candidates right after the failure: the index may simply not include the POST's result yet.
    expect(await t.reconciliation.reconcile('lost-request', { spaceId: input.spaceId })).toMatchObject({ result: 'too_recent', status: 'unknown', number: null })
    expect(t.row('lost-request')).toMatchObject({ status: 'unknown', error: 'connection lost before GitHub received the request' })
    expect(t.links.hasUnresolvedCreation(fingerprint, 'unused')).toBe(true)
    t.advance(SEARCH_SETTLE_MS)
    t.state.incompleteSearch = true
    expect(await t.reconciliation.reconcile('lost-request', { spaceId: input.spaceId })).toMatchObject({ result: 'incomplete', status: 'unknown' })
    expect(t.links.hasUnresolvedCreation(fingerprint, 'unused')).toBe(true)
    t.state.incompleteSearch = false
    t.state.totalOverride = 3
    expect(await t.reconciliation.reconcile('lost-request', { spaceId: input.spaceId })).toMatchObject({ result: 'incomplete', status: 'unknown' })
    expect(t.links.hasUnresolvedCreation(fingerprint, 'unused')).toBe(true)
    t.state.totalOverride = null
    const receipt = await t.reconciliation.reconcile('lost-request', { spaceId: input.spaceId })
    expect(receipt).toMatchObject({ result: 'verified_absent', status: 'unknown', number: null, checkedAt: NOW + SEARCH_SETTLE_MS })
    expect(t.row('lost-request')).toMatchObject({ status: 'unknown', number: null, error: 'verified_absent' })
    expect(t.note('lost-request')).toMatchObject({ result: 'verified_absent', login: BOT, previousError: 'connection lost before GitHub received the request' })
    expect(t.links.hasUnresolvedCreation(fingerprint, 'unused')).toBe(false)
    expect(t.links.get(fingerprint)).toBeUndefined()
    expect(t.posts()).toBe(1)
    t.registry.close()
  })

  it.each([
    ['ambiguous', (t: ReturnType<typeof setup>) => { t.addRemote(101); t.addRemote(102) }],
    ['incomplete', (t: ReturnType<typeof setup>) => { t.addRemote(101); t.state.incompleteSearch = true }],
    ['more-pages', (t: ReturnType<typeof setup>) => { t.addRemote(101); t.state.totalOverride = 250 }],
    ['search-error', (t: ReturnType<typeof setup>) => { t.addRemote(101); t.state.searchError = true }],
    ['identity-error', (t: ReturnType<typeof setup>) => { t.addRemote(101); t.state.loginError = true }],
    ['verify-error', (t: ReturnType<typeof setup>) => { t.addRemote(101); t.state.readError = true }],
  ] as const)('leaves status, number and admission untouched when the platform cannot prove the outcome: %s', async (kind, arrange) => {
    const t = setup()
    await t.seedUnknown('lost-request', 'lost_before_create')
    t.advance(SEARCH_SETTLE_MS)
    arrange(t)
    const receipt = await t.reconciliation.reconcile('lost-request', { spaceId: input.spaceId })
    expect(receipt.result).toBe(kind === 'ambiguous' ? 'ambiguous' : kind === 'incomplete' || kind === 'more-pages' ? 'incomplete' : 'unavailable')
    expect(receipt).toMatchObject({ status: 'unknown', number: null })
    if (kind === 'ambiguous') expect(receipt.candidates).toEqual([101, 102])
    expect(t.row('lost-request')).toMatchObject({ status: 'unknown', number: null, error: 'connection lost before GitHub received the request' })
    expect(t.links.hasUnresolvedCreation(fingerprint, 'unused')).toBe(true)
    expect(t.links.get(fingerprint)).toBeUndefined()
    expect(t.posts()).toBe(1)
    t.registry.close()
  })

  it.each([
    ['title', { title: '另一个问题' }],
    ['login', { login: 'someone-else' }],
    ['number', { number: 102 }],
    ['pull-request', { pull: true }],
  ] as const)('does not confirm when the read-back by number disagrees with the search candidate: %s', async (_kind, override) => {
    const t = setup()
    await t.seedUnknown('lost-ack', 'lost_after_create')
    t.state.readOverride = override
    expect(await t.reconciliation.reconcile('lost-ack', { spaceId: input.spaceId })).toMatchObject({ result: 'unavailable', status: 'unknown', number: null })
    expect(t.row('lost-ack')).toMatchObject({ status: 'unknown', number: null, reconciliation: null })
    expect(t.links.get(fingerprint)).toBeUndefined()
    t.registry.close()
  })

  it('treats a same-title issue by another identity as not ours: absence is proven, nothing is attributed', async () => {
    const t = setup()
    await t.seedUnknown('lost-request', 'lost_before_create')
    t.addRemote(7, { login: 'human-reporter' })
    t.advance(SEARCH_SETTLE_MS)
    expect(await t.reconciliation.reconcile('lost-request', { spaceId: input.spaceId })).toMatchObject({ result: 'verified_absent', status: 'unknown', number: null })
    expect(t.row('lost-request')).toMatchObject({ number: null, error: 'verified_absent' })
    expect(t.links.get(fingerprint)).toBeUndefined()
    t.registry.close()
  })

  it('does not attribute anything when our own login cannot be determined', async () => {
    const t = setup()
    await t.seedUnknown('lost-ack', 'lost_after_create')
    t.advance(SEARCH_SETTLE_MS)
    t.state.loginError = true
    expect(await t.reconciliation.reconcile('lost-ack', { spaceId: input.spaceId })).toMatchObject({ result: 'unavailable', status: 'unknown', number: null })
    expect(t.reconcileSearches()).toHaveLength(0)
    expect(t.row('lost-ack')).toMatchObject({ status: 'unknown', number: null, reconciliation: null })
    t.registry.close()
  })

  it('ignores candidates already attributed to another created operation', async () => {
    const t = setup()
    await t.seedUnknown('lost-request', 'lost_before_create')
    t.advance(SEARCH_SETTLE_MS)
    expect(await t.reconciliation.reconcile('lost-request', { spaceId: input.spaceId })).toMatchObject({ result: 'verified_absent' })
    // Proven absence unblocked a fresh creation under a new key; the later issue belongs to that operation.
    expect(await openIssue(t.github, t.links, { ...input, requestKey: 'second-attempt' })).toMatchObject({ action: 'created', number: 101 })
    expect(t.row('second-attempt')).toMatchObject({ status: 'confirmed', number: 101 })
    t.advance(SEARCH_SETTLE_MS)
    expect(await t.reconciliation.reconcile('lost-request', { spaceId: input.spaceId })).toMatchObject({ result: 'verified_absent', status: 'unknown', number: null })
    expect(t.row('second-attempt')).toMatchObject({ status: 'confirmed', number: 101 })
    t.registry.close()
  })

  it('never modifies sent or confirmed rows and reads nothing for them', async () => {
    const t = setup()
    expect(await openIssue(t.github, t.links, { ...input, requestKey: 'done' })).toMatchObject({ action: 'created', number: 101 })
    t.state.readError = true
    await expect(openIssue(t.github, t.links, { ...input, title: '另一个问题', requestKey: 'half-done' })).rejects.toThrow('read-back unavailable')
    expect(t.row('half-done')).toMatchObject({ status: 'sent', number: 102 })
    const before = t.calls.length
    const done = t.row('done'), halfDone = t.row('half-done')
    expect(await t.reconciliation.reconcile('done', { spaceId: input.spaceId })).toMatchObject({ result: 'already_resolved', status: 'confirmed', number: 101 })
    expect(await t.reconciliation.reconcile('half-done', { spaceId: input.spaceId })).toMatchObject({ result: 'already_resolved', status: 'sent', number: 102 })
    expect(t.calls.length).toBe(before)
    expect(t.row('done')).toEqual(done)
    expect(t.row('half-done')).toEqual(halfDone)
    t.registry.close()
  })

  it('reads nothing for a planned row that may still be in flight, and reconciles it once the grace period has passed', async () => {
    const t = setup()
    await t.seedUnknown('crashed', 'lost_after_create')
    t.registry.db.prepare("UPDATE github_issue_operations SET status = 'planned', error = NULL WHERE request_key = ?").run('crashed')
    const before = t.calls.length
    expect(await t.reconciliation.reconcile('crashed', { spaceId: input.spaceId })).toMatchObject({ result: 'in_flight', status: 'planned', number: null })
    expect(t.calls.length).toBe(before)
    expect(t.row('crashed')).toMatchObject({ status: 'planned', reconciliation: null })
    t.advance(IN_FLIGHT_GRACE_MS)
    expect(await t.reconciliation.reconcile('crashed', { spaceId: input.spaceId })).toMatchObject({ result: 'confirmed', status: 'confirmed', number: 101 })
    expect(t.row('crashed')).toMatchObject({ status: 'confirmed', number: 101 })
    t.registry.close()
  })

  it('replays idempotently: a confirmed row is not re-read', async () => {
    const t = setup()
    await t.seedUnknown('lost-ack', 'lost_after_create')
    expect(await t.reconciliation.reconcile('lost-ack', { spaceId: input.spaceId })).toMatchObject({ result: 'confirmed', number: 101 })
    const confirmed = t.row('lost-ack')
    const before = t.calls.length
    expect(await t.reconciliation.reconcile('lost-ack', { spaceId: input.spaceId })).toMatchObject({ result: 'already_resolved', status: 'confirmed', number: 101 })
    expect(t.calls.length).toBe(before)
    expect(t.row('lost-ack')).toEqual(confirmed)
    t.registry.close()
  })

  it('re-verifies a proven absence on replay without reopening admission questions', async () => {
    const t = setup()
    await t.seedUnknown('lost-request', 'lost_before_create')
    t.advance(SEARCH_SETTLE_MS)
    expect(await t.reconciliation.reconcile('lost-request', { spaceId: input.spaceId })).toMatchObject({ result: 'verified_absent' })
    t.advance(1_000)
    expect(await t.reconciliation.reconcile('lost-request', { spaceId: input.spaceId })).toMatchObject({ result: 'verified_absent', status: 'unknown', number: null, checkedAt: NOW + SEARCH_SETTLE_MS + 1_000 })
    expect(t.row('lost-request')).toMatchObject({ status: 'unknown', error: 'verified_absent' })
    expect(t.note('lost-request')).toMatchObject({ result: 'verified_absent', checkedAt: NOW + SEARCH_SETTLE_MS + 1_000 })
    expect(t.posts()).toBe(1)
    t.registry.close()
  })

  it('rejects requests for rows that are missing or are not issue creations', async () => {
    const t = setup()
    await expect(t.reconciliation.reconcile('missing', { spaceId: input.spaceId })).rejects.toThrow(/找不到/)
    expect(await openIssue(t.github, t.links, { ...input, requestKey: 'done' })).toMatchObject({ action: 'created', number: 101 })
    expect(await openIssue(t.github, t.links, { ...input, body: '补充', requestKey: 'follow' })).toMatchObject({ action: 'commented', number: 101 })
    await expect(t.reconciliation.reconcile('follow', { spaceId: input.spaceId })).rejects.toThrow(/不是创建/)
    expect(t.row('follow')).toMatchObject({ status: 'confirmed', action: 'commented', reconciliation: null })
    t.registry.close()
  })

  it('pages through complete search results before deciding', async () => {
    const t = setup()
    await t.seedUnknown('lost-ack', 'lost_after_create')
    for (let n = 1; n <= 130; n += 1) t.addRemote(1000 + n, { title: `别的问题 ${n}`, login: 'someone' })
    expect(await t.reconciliation.reconcile('lost-ack', { spaceId: input.spaceId })).toMatchObject({ result: 'confirmed', number: 101 })
    expect(t.reconcileSearches()).toHaveLength(2)
    t.registry.close()
  })
})

describe('openIssue runs the reconciliation before deciding on an unresolved creation', () => {
  it('stays blocked while absence cannot be proven, then allows a fresh creation under a new key once it is', async () => {
    const t = setup()
    await t.seedUnknown('first-create', 'lost_before_create')
    await expect(openIssue(t.github, t.links, { ...input, body: '多一句证据', requestKey: 'changed-body' })).rejects.toThrow(/结果未知.*须核对/)
    expect(t.state.createCount).toBe(0)
    expect(t.row('first-create')).toMatchObject({ status: 'unknown', error: 'connection lost before GitHub received the request' })
    expect(t.note('first-create')).toMatchObject({ result: 'too_recent' })
    t.advance(SEARCH_SETTLE_MS)
    expect(await openIssue(t.github, t.links, { ...input, body: '多一句证据', requestKey: 'changed-body' })).toMatchObject({ action: 'created', number: 101 })
    expect(t.state).toMatchObject({ createCount: 1, commentCount: 0 })
    expect(t.row('first-create')).toMatchObject({ status: 'unknown', number: null, error: 'verified_absent' })
    expect(t.row('changed-body')).toMatchObject({ status: 'confirmed', number: 101 })
    // The old key itself is never resent: its operation stays unknown.
    await expect(openIssue(t.github, t.links, { ...input, requestKey: 'first-create' })).rejects.toThrow(/不会自动重发/)
    expect(t.state.createCount).toBe(1)
    t.registry.close()
  })

  it('comments on the issue the lost POST really created once the old operation is confirmed', async () => {
    const t = setup()
    await t.seedUnknown('first-create', 'lost_after_create')
    expect(await openIssue(t.github, t.links, { ...input, body: '新的证据', requestKey: 'new-content' })).toMatchObject({ action: 'commented', number: 101 })
    expect(t.state).toMatchObject({ createCount: 1, commentCount: 1 })
    expect(t.row('first-create')).toMatchObject({ status: 'confirmed', number: 101, error: null })
    expect(t.row('new-content')).toMatchObject({ status: 'confirmed', action: 'commented', number: 101 })
    const commentIndex = t.calls.findIndex((c) => c.method === 'POST' && c.path.endsWith('/comments'))
    expect(t.calls.slice(0, commentIndex).some((c) => c.method === 'GET' && c.path === '/repos/org/a/issues/101')).toBe(true)
    // The original key now replays the confirmed result instead of failing as unknown.
    expect(await openIssue(t.github, t.links, { ...input, requestKey: 'first-create' })).toMatchObject({ action: 'created', number: 101, replayed: true })
    expect(t.state).toMatchObject({ createCount: 1, commentCount: 1 })
    t.registry.close()
  })

  it('keeps the existing inline candidate check when reconciliation cannot decide', async () => {
    const t = setup()
    await t.seedUnknown('first-create', 'lost_after_create')
    t.state.loginError = true
    expect(await openIssue(t.github, t.links, { ...input, body: '新的证据', requestKey: 'new-content' })).toMatchObject({ action: 'commented', number: 101 })
    expect(t.row('first-create')).toMatchObject({ status: 'unknown', number: null })
    expect(t.state).toMatchObject({ createCount: 1, commentCount: 1 })
    t.registry.close()
  })

  it('does not change behaviour for requests without an unresolved creation', async () => {
    const t = setup()
    expect(await openIssue(t.github, t.links, { ...input, requestKey: 'plain' })).toMatchObject({ action: 'created', number: 101 })
    expect(t.calls.some((c) => c.path === '/user')).toBe(false)
    expect(await openIssue(t.github, t.links, { ...input, body: '补充', requestKey: 'follow-up' })).toMatchObject({ action: 'commented', number: 101 })
    expect(t.calls.some((c) => c.path === '/user')).toBe(false)
    t.registry.close()
  })
})
