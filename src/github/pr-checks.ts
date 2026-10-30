import type { GitHubIdentity } from './identity.js'

interface PullRequest { head?: { sha?: string }; html_url?: string; state?: string; merged?: boolean }
interface CheckRun { id: number; name: string; head_sha: string; status: string; conclusion: string | null; html_url?: string
  started_at?: string | null; completed_at?: string | null; check_suite?: { id?: number } }
interface CommitStatus { id: number; context: string; state: string; target_url?: string; created_at?: string; updated_at?: string }
interface Page<T> { items: T[]; total: number; complete: boolean }

/** Read checks for one immutable commit and re-read the PR head before reporting.
 * These are reported checks, not a claim that all required rules or tests ran. */
export async function readPullRequestChecks(github: Pick<GitHubIdentity, 'api' | 'repoAllowed'>,
  input: { repo: string; number: number; assertCurrent(): void; signal?: AbortSignal }) {
  const { repo, number } = input
  const guard = () => { input.assertCurrent(); if (!github.repoAllowed(repo)) throw new Error('仓库已不在可读范围内') }
  const get = async <T>(path: string): Promise<T> => {
    guard()
    const result = await github.api<T>('GET', path, undefined, repo.split('/')[0], guard, input.signal)
    guard(); return result
  }
  const path = `/repos/${repo}/pulls/${number}`, before = await get<PullRequest>(path), sha = before.head?.sha
  if (!sha || !/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('无法确认 PR 当前提交')
  async function collect<T extends { id: number }>(route: string, extract: (body: Record<string, unknown>) => T[]): Promise<Page<T>> {
    const items: T[] = [], ids = new Set<number>(); let total = 0
    for (let page = 1; page <= 10; page++) {
      const response = await get<Record<string, unknown>>(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      const next = extract(response)
      if (!Array.isArray(next) || !Number.isSafeInteger(response.total_count) || Number(response.total_count) < 0) throw new Error('GitHub 检查结果不完整')
      if (page > 1 && total !== Number(response.total_count)) return { items, total, complete: false }
      total = Number(response.total_count)
      for (const item of next) {
        if (!item || !Number.isSafeInteger(item.id) || ids.has(item.id)) return { items, total, complete: false }
        ids.add(item.id); items.push(item)
      }
      if (items.length >= total) return { items, total, complete: items.length === total }
      if (!next.length) break
    }
    return { items, total, complete: false }
  }
  const commitEndpoint = (resource: string): string => {
    const url = new URL(resource, `https://api.github.com/repos/${repo}/commits/${sha}/`)
    return url.pathname + url.search
  }
  const results = await Promise.allSettled([
    collect<CheckRun>(commitEndpoint('check-runs?filter=latest'), body => body.check_runs as CheckRun[]),
    collect<CommitStatus>(commitEndpoint('status'), body => body.statuses as CommitStatus[]),
  ])
  guard()
  const checks = results[0].status === 'fulfilled' ? results[0].value : undefined
  const statuses = results[1].status === 'fulfilled' ? results[1].value : undefined
  const after = await get<PullRequest>(path)
  const headCurrent = after.head?.sha === sha
  const complete = Boolean(checks?.complete && statuses?.complete && checks.items.every(item => item.head_sha === sha))
  const rows = checks?.items ?? [], states = statuses?.items ?? []
  const failed = rows.some(item => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].includes(item.conclusion ?? '')) ||
    states.some(item => ['failure', 'error'].includes(item.state))
  const pending = rows.some(item => item.status !== 'completed') || states.some(item => item.state === 'pending')
  const allSucceeded = rows.every(item => item.status === 'completed' && item.conclusion === 'success') && states.every(item => item.state === 'success')
  return { repo, number, url: before.html_url, head: sha, currentHead: after.head?.sha ?? null, headCurrent,
    open: after.state === 'open' && after.merged !== true,
    status: !headCurrent ? 'head_changed' : !complete ? 'unavailable' : failed ? 'failed' : pending ? 'pending' :
      !rows.length && !states.length ? 'no_checks' : allSucceeded ? 'reported_checks_passed' : 'completed_with_skips',
    checks: { available: Boolean(checks), complete: checks?.complete ?? false, total: checks?.total ?? null,
      items: rows.map(row => ({ id: row.id, name: row.name, status: row.status, conclusion: row.conclusion, url: row.html_url,
        ...checkVersion(row) })) },
    statuses: { available: Boolean(statuses), complete: statuses?.complete ?? false, total: statuses?.total ?? null,
      items: states.map(row => ({ id: row.id, name: row.context, state: row.state, url: row.target_url,
        ...statusVersion(row) })) },
    note: '仅反映该提交已上报的检查。没有检查、跳过检查、权限不足或 PR head 已变化，都不能称为全部测试通过；不证明已满足所有合入规则。',
  }
}

// Provider fields only: a check suite is not an Actions run/attempt, and URLs
// cannot supply a missing attempt identity. Older receipts legitimately omit these.
function checkVersion(row: CheckRun): { startedAt?: string; completedAt?: string; checkSuiteId?: number } {
  return { ...(typeof row.started_at === 'string' ? { startedAt: row.started_at } : {}),
    ...(typeof row.completed_at === 'string' ? { completedAt: row.completed_at } : {}),
    ...(Number.isSafeInteger(row.check_suite?.id) ? { checkSuiteId: row.check_suite!.id! } : {}) }
}
function statusVersion(row: CommitStatus): { createdAt?: string; updatedAt?: string } {
  return { ...(typeof row.created_at === 'string' ? { createdAt: row.created_at } : {}),
    ...(typeof row.updated_at === 'string' ? { updatedAt: row.updated_at } : {}) }
}
