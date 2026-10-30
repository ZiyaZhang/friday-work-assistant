import { describe, expect, it } from 'vitest'
import { readPullRequestChecks } from '../src/github/pr-checks.js'
import type { GitHubIdentity } from '../src/github/identity.js'

const sha = 'a'.repeat(40)
function fixture(options: { checks?: unknown[]; statuses?: unknown[]; changed?: boolean; denyChecks?: boolean; pages?: boolean; duplicatePage?: boolean; stop?: boolean } = {}) {
  let heads = 0, alive = true
  const seen: string[] = []
  const github = { repoAllowed: () => true, api: async (_method: string, path: string) => {
    seen.push(path)
    if (path.includes('/pulls/')) return { head: { sha: ++heads > 1 && options.changed ? 'b'.repeat(40) : sha } }
    if (options.stop) alive = false
    if (path.includes('/check-runs')) {
      if (options.denyChecks) throw new Error('checks permission denied')
      return options.pages ? { total_count: 101, check_runs: Array.from({ length: path.endsWith('page=1') ? 100 : 1 }, (_, i) => ({ id: path.endsWith('page=1') ? i : options.duplicatePage ? 0 : 100, head_sha: sha, status: 'completed', conclusion: 'success' })) }
        : { total_count: options.checks?.length ?? 0, check_runs: options.checks ?? [] }
    }
    return { total_count: options.statuses?.length ?? 0, statuses: options.statuses ?? [] }
  } } as unknown as Pick<GitHubIdentity, 'api' | 'repoAllowed'>
  return { seen, read: () => readPullRequestChecks(github, { repo: 'example/repo', number: 1, assertCurrent: () => { if (!alive) throw new Error('Run stopped') } }) }
}
describe('PR checks pin the actual head without inventing test success', () => {
  it('retains actual provider versions without deriving an Actions attempt from a check URL', async () => {
    const result = await fixture({ checks: [{ id: 71, name: 'build', head_sha: sha, status: 'completed', conclusion: 'success',
      started_at: '2026-09-23T10:00:00Z', completed_at: '2026-09-23T10:04:00Z', check_suite: { id: 51 },
      html_url: 'https://github.com/example/repo/actions/runs/40/job/71' }],
      statuses: [{ id: 91, context: 'external', state: 'success', created_at: '2026-09-23T10:00:00Z', updated_at: '2026-09-23T10:03:00Z' }] }).read()
    expect(result.checks.items[0]).toMatchObject({ id: 71, checkSuiteId: 51,
      startedAt: '2026-09-23T10:00:00Z', completedAt: '2026-09-23T10:04:00Z' })
    expect(result.statuses.items[0]).toMatchObject({ id: 91, createdAt: '2026-09-23T10:00:00Z', updatedAt: '2026-09-23T10:03:00Z' })
    expect(result.checks.items[0]).not.toHaveProperty('runAttempt')
    expect(result.checks.items[0]).not.toHaveProperty('runId')
  })
  it('does not treat zero checks as success', async () => { expect(await fixture().read()).toMatchObject({ status: 'no_checks', head: sha, headCurrent: true }) })
  it('reads all reported pages and real statuses', async () => {
    const f = fixture({ pages: true, statuses: [{ id: 1, context: 'build', state: 'success' }] })
    expect(await f.read()).toMatchObject({ status: 'reported_checks_passed', checks: { total: 101, complete: true } })
    expect(f.seen.some(path => path.endsWith('page=2'))).toBe(true)
    expect(f.seen).toContain(`/repos/example/repo/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`)
    expect(f.seen).toContain(`/repos/example/repo/commits/${sha}/status?per_page=100&page=1`)
  })
  it.each([['failure', 'failed'], ['skipped', 'completed_with_skips'], ['neutral', 'completed_with_skips']])('reports %s honestly', async (conclusion, status) => {
    expect(await fixture({ checks: [{ id: 1, name: 'test', head_sha: sha, status: 'completed', conclusion }] }).read()).toMatchObject({ status })
  })
  it('does not report a newer commit as tested', async () => {
    expect(await fixture({ changed: true, statuses: [{ id: 1, context: 'test', state: 'success' }] }).read()).toMatchObject({ status: 'head_changed', headCurrent: false })
  })
  it('does not count a repeated check on a moving pagination boundary as a complete passing set', async () => {
    expect(await fixture({ pages: true, duplicatePage: true }).read()).toMatchObject({ status: 'unavailable', checks: { complete: false } })
  })
  it('preserves partial status evidence while checks permissions are missing', async () => {
    expect(await fixture({ denyChecks: true, statuses: [{ id: 1, context: 'test', state: 'success' }] }).read()).toMatchObject({ status: 'unavailable', checks: { available: false }, statuses: { available: true } })
  })
  it('does not swallow a stopped Run as an ordinary partial result', async () => {
    await expect(fixture({ stop: true }).read()).rejects.toThrow('Run stopped')
  })
})
