import type { GitHubIdentity } from './identity.js'
import type { TodoGitHubSource } from '../core/todo-provenance.js'

export interface PersonalGitHubState {
  url: string; head?: string; state: 'open' | 'closed'; merged?: boolean; draft?: boolean
  reviewed?: boolean; requested?: boolean; updatedAt: string; note: string
  completion?: 'done' | 'cancelled'
}

/** No search-based identity guesses: the caller supplies the owner's explicitly connected GitHub login. */
export async function readPersonalGitHubWork(github: Pick<GitHubIdentity, 'api' | 'repoAllowed'>, source: TodoGitHubSource & { relationship?: 'review_requested' | 'assigned' },
  input: { login?: string; assertCurrent(): void; signal?: AbortSignal }): Promise<PersonalGitHubState> {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(pull|issues)\/([1-9]\d*)$/.exec(source.url)
  if (!match || match[2] === 'issues' !== (source.completion === 'issue_closed')) throw new Error('工作链接无效')
  const [, repo, kind, number] = match
  const guard = () => { input.assertCurrent(); if (!github.repoAllowed(repo!)) throw new Error('仓库读取范围已变化') }
  const get = async <T>(path: string): Promise<T> => {
    guard(); const result = await github.api<T>('GET', path, undefined, repo!.split('/')[0], guard, input.signal); guard(); return result
  }
  interface Item { state?: string; updated_at?: string; state_reason?: string | null; pull_request?: unknown;
    merged?: boolean; draft?: boolean; head?: { sha?: string }; requested_reviewers?: { login?: string }[]; assignees?: { login?: string }[] }
  const path = `/repos/${repo}/${kind === 'pull' ? 'pulls' : 'issues'}/${number}`, before = await get<Item>(path)
  const valid = (item: Item) => {
    if (!['open', 'closed'].includes(item.state ?? '') || typeof item.updated_at !== 'string' || !Number.isFinite(Date.parse(item.updated_at))) throw new Error('工作状态不完整')
  }
  valid(before)
  if (kind === 'issues') {
    // The issues endpoint also returns PRs. Never treat a closed unmerged PR as a completed issue.
    if (before.pull_request) throw new Error('该对象不是 Issue')
    if (before.state === 'open' && source.relationship === 'assigned') {
      if (!input.login || !Array.isArray(before.assignees)) throw new Error('Issue 指派信息不完整')
      if (!before.assignees.some(user => user.login?.toLowerCase() === input.login!.toLowerCase())) return {
        url: source.url, state: 'open', updatedAt: before.updated_at!, completion: 'cancelled', note: `Issue #${number} 已不再分配给你` }
    }
    return { url: source.url, state: before.state as 'open' | 'closed', updatedAt: before.updated_at!,
      note: before.state === 'open' ? `Issue #${number} 仍开放` : before.state_reason === 'completed' ? `Issue #${number} 已解决`
        : before.state_reason === 'not_planned' ? `Issue #${number} 已关闭，不再计划处理` : `Issue #${number} 已关闭，完成原因尚未确认`,
      ...(before.state === 'closed' && before.state_reason === 'completed' ? { completion: 'done' as const }
        : before.state === 'closed' && before.state_reason === 'not_planned' ? { completion: 'cancelled' as const } : {}) }
  }
  const head = before.head?.sha
  if (!head || !/^[a-f0-9]{40,64}$/.test(head) || typeof before.merged !== 'boolean' || typeof before.draft !== 'boolean' ||
    !Array.isArray(before.requested_reviewers)) throw new Error('PR 状态不完整')
  const requested = Boolean(input.login && before.requested_reviewers.some(user => user.login?.toLowerCase() === input.login!.toLowerCase()))
  let reviewed = false
  if (input.login && source.completion === 'reviewed' && before.state === 'open' && !requested) {
    interface Review { id: number; user?: { login?: string }; state: string; commit_id?: string; submitted_at?: string }
    const ids = new Set<number>(); let latest: Review | undefined, complete = false
    for (let page = 1; page <= 10; page++) {
      const reviews = await get<Review[]>(`${path}/reviews?per_page=100&page=${page}`)
      if (!Array.isArray(reviews)) throw new Error('评审记录不完整')
      for (const review of reviews) {
        if (!Number.isSafeInteger(review.id) || ids.has(review.id)) throw new Error('评审分页发生变化')
        ids.add(review.id)
        if (review.user?.login?.toLowerCase() === input.login.toLowerCase() && review.state !== 'PENDING' && review.submitted_at) latest = review
      }
      if (reviews.length < 100) { complete = true; break }
    }
    if (!complete) throw new Error('评审记录未读取完整')
    reviewed = latest?.commit_id === head && ['APPROVED', 'CHANGES_REQUESTED'].includes(latest?.state ?? '')
  }
  const after = await get<Item>(path); valid(after)
  if (after.head?.sha !== head || after.updated_at !== before.updated_at || after.state !== before.state || after.merged !== before.merged ||
    after.draft !== before.draft || JSON.stringify(after.requested_reviewers) !== JSON.stringify(before.requested_reviewers)) throw new Error('PR 已变化，等待重新核对')
  const completion = before.merged || reviewed ? 'done' : before.state === 'closed' ? 'cancelled' : undefined
  return { url: source.url, head, updatedAt: before.updated_at!, state: before.state as 'open' | 'closed', merged: before.merged, draft: before.draft,
    requested, reviewed, ...(completion ? { completion } : {}), note: before.merged ? `PR #${number} 已合并`
      : before.state === 'closed' ? `PR #${number} 已关闭，未合并` : reviewed ? `你已评审 PR #${number} 的当前提交`
      : before.draft ? `PR #${number} 仍是草稿` : `PR #${number} 仍开放${requested ? '，已请求你评审' : ''}` }
}
