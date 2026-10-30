/**
 * 把 GitHub 上的 issue 读成已核验覆盖范围的快照。
 *
 * 读侧，一次写操作都没有。两件事值得单独说：
 *
 * 1. **`/issues` 会把 PR 一起返回**。GitHub 的模型里 PR 就是一种 issue，返回体里带 `pull_request` 字段。
 *    不认出来的话，Friday 会对着自己刚开的那个 PR 问一句"这个怎么没人接"。
 * 2. **"有没有关联 PR"不能只看正文里的 `#123`**。真正的关联在时间线上：
 *    别人开 PR 时写了 `fixes #12`，或者在 PR 里手动 link，都会在 issue 的 timeline 里
 *    留下 `cross-referenced` / `connected` 事件。只读正文会把"已经有人在做"读成"没人做"。
 */
import type { GitHubIdentity } from './identity.js'
import type { IssueSnapshot } from '../core/issue-watch.js'

/** 时间线里能证明"已经有 PR 在做这件事"的事件。 */
const LINK_EVENTS = new Set(['cross-referenced', 'connected'])
const PAGE_SIZE = 100
const MAX_DETAIL_PAGES = 5

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** GitHub 的单 issue comments / timeline 都用 page 分页，comments 不支持倒序参数。 */
async function allPages(github: GitHubIdentity, path: string, owner: string | undefined): Promise<Record<string, unknown>[] | undefined> {
  const all: Record<string, unknown>[] = []
  for (let page = 1; page <= MAX_DETAIL_PAGES; page += 1) {
    const raw = await github.api<unknown>('GET', `${path}?per_page=${PAGE_SIZE}&page=${page}`, undefined, owner)
    if (!Array.isArray(raw) || raw.length > PAGE_SIZE || raw.some((entry) => !object(entry))) return undefined
    all.push(...raw as Record<string, unknown>[])
    if (raw.length < PAGE_SIZE) return all
  }
  // 没到尾页，不能把“前五页没看见 PR / 新回复”说成“没有”。
  return undefined
}

function ms(value: unknown): number {
  const t = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(t) ? t : 0
}

function names(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[key] : undefined))
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
}

/**
 * 时间线里有没有指向这条 issue 的 PR。
 *
 * 只认**打开着或已合并**的 PR：一个被关掉又没合并的 PR，说明那次尝试没成，
 * 这条 issue 还是没人做——把它算成"有人在做"就等于永久闭嘴。
 */
export function linkedPullRequestCount(timeline: unknown[]): number {
  const seen = new Set<string>()
  for (const entry of timeline) {
    if (!entry || typeof entry !== 'object') continue
    const event = entry as Record<string, unknown>
    if (typeof event.event !== 'string' || !LINK_EVENTS.has(event.event)) continue
    const source = event.source as Record<string, unknown> | undefined
    const issue = (source?.issue ?? event.subject) as Record<string, unknown> | undefined
    if (!issue || typeof issue !== 'object') continue
    if (!issue.pull_request) continue
    const merged = Boolean((issue.pull_request as Record<string, unknown>)?.merged_at)
    if (issue.state === 'closed' && !merged) continue
    const url = typeof issue.html_url === 'string' ? issue.html_url : String(issue.number ?? '')
    if (url) seen.add(url)
  }
  return seen.size
}

/** 一条 issue 的原始返回体 → 快照。评论和关联 PR 另外读，这里只管本体。 */
export function snapshotOf(raw: Record<string, unknown>): IssueSnapshot {
  const state = raw.state === 'closed' ? 'closed' : 'open'
  return {
    number: Number(raw.number ?? 0),
    title: String(raw.title ?? ''),
    url: String(raw.html_url ?? ''),
    isPullRequest: Boolean(raw.pull_request),
    state,
    assignees: names(raw.assignees, 'login'),
    labels: names(raw.labels, 'name'),
    createdAt: ms(raw.created_at),
    updatedAt: ms(raw.updated_at),
    linkedPullRequests: 0,
  }
}

export interface IssueScanOptions {
  /** 一次最多看几条，别把整个仓库拖进来。 */
  limit?: number
}

/**
 * 读一个仓库里**还开着、没有 assignee** 的 issue，补齐完整时间线和评论。
 *
 * 筛选尽量交给 GitHub（`assignee=none` 少拉很多数据），但**不信它替我们判断**：
 * 返回体里的 assignees 仍然会再看一遍，服务端筛选变了不至于悄悄接错单。
 */
export async function scanUnassignedIssues(
  github: GitHubIdentity,
  repo: string,
  opts: IssueScanOptions = {},
): Promise<IssueSnapshot[]> {
  const owner = repo.split('/')[0]
  const limit = Number.isFinite(opts.limit ?? 30) ? Math.min(Math.max(Math.trunc(opts.limit ?? 30), 0), 100) : 0
  if (limit === 0) return []
  const raw = await github.api<unknown[]>(
    'GET',
    `/repos/${repo}/issues?state=open&assignee=none&sort=updated&direction=desc&per_page=${limit}`,
    undefined,
    owner,
  )
  if (!Array.isArray(raw)) return []
  const botLogin = await github.botLogin().catch(() => undefined)
  // PAT 模式下自动发出的评论也可能是 type=User；查不到当前身份就不能把它当真人。
  if (typeof botLogin !== 'string' || !botLogin.trim()) return []
  const out: IssueSnapshot[] = []
  for (const value of raw.slice(0, limit)) {
    const entry = object(value)
    if (!entry) continue
    const snapshot = snapshotOf(entry)
    const commentCount = entry.comments
    if (!Number.isSafeInteger(snapshot.number) || snapshot.number < 1 || snapshot.isPullRequest || snapshot.state !== 'open'
      || snapshot.assignees.length || snapshot.createdAt <= 0 || snapshot.updatedAt <= 0
      || !Number.isSafeInteger(commentCount) || Number(commentCount) < 0 || Number(commentCount) >= PAGE_SIZE * MAX_DETAIL_PAGES) continue
    const issuePath = `/repos/${repo}/issues/${snapshot.number}`
    // 只有读到尾页才能提供“没有关联 PR”的事实；失败、截断、格式异常都跳过这条。
    try {
      const timeline = await allPages(github, `${issuePath}/timeline`, owner)
      if (!timeline || timeline.some((event) => {
        if (typeof event.event !== 'string') return true
        if (!LINK_EVENTS.has(event.event)) return false
        // connected 的 REST 返回可能只有事件元数据，没有目标 issue/PR。
        // 这时不能把“无法分辨关联对象”转换成“没有关联 PR”。
        const source = object(event.source)
        return !object(source?.issue ?? event.subject)
      })) continue
      snapshot.linkedPullRequests = linkedPullRequestCount(timeline)
      if (Number(commentCount) > 0) {
        const comments = await allPages(github, `${issuePath}/comments`, owner)
        if (!comments || comments.length !== commentCount) continue
        const ids = new Set<unknown>()
        let invalid = false
        for (const comment of comments) {
          const at = ms(comment.created_at)
          const author = object(comment.user)
          const login = typeof author?.login === 'string' ? author.login : undefined
          const byBot = login?.toLowerCase() === botLogin.toLowerCase() || author?.type === 'Bot' || login?.toLowerCase().endsWith('[bot]') === true
          if (!Number.isSafeInteger(comment.id) || ids.has(comment.id) || at <= 0 || !login || (!byBot && author?.type !== 'User')) {
            invalid = true
            break
          }
          ids.add(comment.id)
          if (snapshot.lastCommentAt === undefined || at >= snapshot.lastCommentAt) {
            snapshot.lastCommentAt = at
            snapshot.lastCommentByBot = byBot
          }
          if (!byBot) snapshot.lastHumanCommentAt = Math.max(snapshot.lastHumanCommentAt ?? 0, at)
        }
        if (invalid) continue
      }
      // 分页期间有人回复、认领、关单或关联 PR 时，等下一轮重新取一份一致快照。
      // 不把旧列表里的“没人接”与新评论拼起来后立刻催问。
      const latest = object(await github.api<unknown>('GET', issuePath, undefined, owner))
      if (!latest || latest.number !== snapshot.number || ms(latest.updated_at) !== snapshot.updatedAt || latest.comments !== commentCount
        || latest.state !== 'open' || latest.pull_request || !Array.isArray(latest.assignees) || latest.assignees.length) continue
      out.push(snapshot)
    } catch { continue }
  }
  return out
}
