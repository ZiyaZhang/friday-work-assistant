/**
 * GitHub 只读项目镜像。repo + number 是正式事项身份；这里只保存远端快照，
 * 不创建自己的事项状态，也不把分页缺失当作关闭、删除或没有工作。
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { SerialQueue } from '../core/queue.js'
import { GitHubApiError, type GitHubIdentity } from './identity.js'

export interface ProjectPageCoverage {
  complete: boolean
  pages: number
  items: number
  invalidItems: number
  duplicates: number
  reason: 'complete' | 'not_synced' | 'page_limit' | 'request_failed' | 'invalid_response' | 'invalid_item' | 'pagination_shift'
  httpStatus?: number
}

export interface ProjectRepoStatus {
  repo: string
  /** 仅标识本次同步观察，不是事项状态版本或授权凭证。 */
  snapshotId: string | null
  syncAt: number | null
  lastCompleteSyncAt: number | null
  coverage: { complete: boolean; issues: ProjectPageCoverage; pullRequests: ProjectPageCoverage }
  stale: boolean
}

export interface ProjectItem {
  id: string
  repo: string
  number: number
  kind: 'issue' | 'pr'
  title: string
  /** GitHub 原始 open/closed；mergedAt 单列，不推断本地的 blocked/review/done。 */
  state: 'open' | 'closed'
  stateReason: string | null
  assignees: string[]
  url: string
  createdAt: number
  updatedAt: number
  closedAt: number | null
  mergedAt: number | null
  draft: boolean | null
  createdToClosedMs: number | null
  createdToMergedMs: number | null
  syncAt: number
  coverage: { issueObservedAt: number | null; pullObservedAt: number | null; mergeStateKnown: boolean }
  stale: boolean
}

export interface ProjectView {
  items: ProjectItem[]
  repositories: ProjectRepoStatus[]
  stale: boolean
  coverageComplete: boolean
}

interface Snapshot {
  number: number
  kind: 'issue' | 'pr'
  title: string
  state: 'open' | 'closed'
  stateReason: string | null
  assignees: string[]
  url: string
  createdAt: number
  updatedAt: number
  closedAt: number | null
  mergedAt: number | null
  draft: boolean | null
}

interface ItemRow {
  repo: string
  number: number
  issue_snapshot: string | null
  issue_sync_at: number | null
  pull_snapshot: string | null
  pull_sync_at: number | null
  issue_sync_id: string | null
  pull_sync_id: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS github_project_items (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  issue_snapshot TEXT,
  issue_updated_at INTEGER,
  issue_sync_at INTEGER,
  issue_sync_id TEXT,
  pull_snapshot TEXT,
  pull_updated_at INTEGER,
  pull_sync_at INTEGER,
  pull_sync_id TEXT,
  PRIMARY KEY(repo, number)
);
CREATE TABLE IF NOT EXISTS github_project_sync (
  repo TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  sync_at INTEGER NOT NULL,
  last_complete_sync_at INTEGER,
  coverage TEXT NOT NULL
);
`

const freshCoverage = (): ProjectPageCoverage => ({ complete: false, pages: 0, items: 0, invalidItems: 0, duplicates: 0, reason: 'not_synced' })

export class GitHubProjectView {
  private readonly queue = new SerialQueue()
  private readonly now: () => number
  private readonly staleAfterMs: number
  private readonly maxPages: number
  private readonly pageSize: number

  constructor(private readonly db: DatabaseSync, private readonly github: GitHubIdentity,
    opts: { now?: () => number; staleAfterMs?: number; maxPages?: number; pageSize?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.staleAfterMs = opts.staleAfterMs ?? 15 * 60_000
    this.maxPages = opts.maxPages ?? 20
    this.pageSize = opts.pageSize ?? 100
    if (!Number.isSafeInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 100) throw new Error('maxPages 必须为 1–100')
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 100) throw new Error('pageSize 必须为 1–100')
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs < 0) throw new Error('staleAfterMs 必须非负')
    db.exec(SCHEMA)
  }

  /** 只有 GET；API/页面还须校验本次调用者有权查看这些项目。 */
  async sync(repo: string): Promise<ProjectRepoStatus> {
    const canonical = this.allowedRepo(repo)
    return this.queue.run(canonical, async () => {
      this.allowedRepo(canonical)
      const issues = await this.fetchPages(canonical, 'issues')
      const pulls = await this.fetchPages(canonical, 'pulls')
      // 网络往返期间配置被撤销时不把返回数据继续落库或交给调用者。
      this.allowedRepo(canonical)
      const syncAt = this.now()
      const snapshotId = randomUUID()
      const coverage = { complete: issues.coverage.complete && pulls.coverage.complete, issues: issues.coverage, pullRequests: pulls.coverage }
      this.db.exec('SAVEPOINT github_project_sync')
      try {
        for (const item of issues.items) this.save(canonical, 'issue', item, syncAt, snapshotId)
        for (const item of pulls.items) this.save(canonical, 'pull', item, syncAt, snapshotId)
        this.db.prepare(`INSERT INTO github_project_sync (repo, snapshot_id, sync_at, last_complete_sync_at, coverage) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(repo) DO UPDATE SET snapshot_id = excluded.snapshot_id, sync_at = excluded.sync_at,
          last_complete_sync_at = COALESCE(excluded.last_complete_sync_at, github_project_sync.last_complete_sync_at), coverage = excluded.coverage`)
          .run(canonical, snapshotId, syncAt, coverage.complete ? syncAt : null, JSON.stringify(coverage))
        this.db.exec('RELEASE SAVEPOINT github_project_sync')
      } catch (error) {
        this.db.exec('ROLLBACK TO SAVEPOINT github_project_sync; RELEASE SAVEPOINT github_project_sync')
        throw error
      }
      return this.repoStatus(canonical, syncAt)
    })
  }

  /** 缓存读取也重新检查仓库allowlist；不会因为以前同步过就允许继续读取。 */
  view(repos: string[], assignee?: string): ProjectView {
    const requested = [...new Set(repos.map((repo) => this.allowedRepo(repo)))]
    const login = assignee?.trim().toLowerCase()
    const now = this.now()
    const repositories = requested.map((repo) => this.repoStatus(repo, now))
    const items: ProjectItem[] = []
    for (const status of repositories) {
      const rows = this.db.prepare('SELECT * FROM github_project_items WHERE repo = ? ORDER BY number').all(status.repo) as unknown as ItemRow[]
      for (const row of rows) {
        const item = this.toItem(row, status, now)
        if (!login || item.assignees.some((who) => who.toLowerCase() === login)) items.push(item)
      }
    }
    return { items, repositories, stale: repositories.some((r) => r.stale) || items.some((x) => x.stale), coverageComplete: repositories.length > 0 && repositories.every((r) => r.coverage.complete) }
  }

  private allowedRepo(repo: string): string {
    const value = repo.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/.test(value) || ['.', '..'].includes(value.split('/')[1] ?? '')) throw new Error('需要精确的 owner/repo，不能传 URL 或路径')
    if (!this.github.repoAllowed(value)) throw new Error('仓库不在允许范围内')
    return value
  }

  private async fetchPages(repo: string, kind: 'issues' | 'pulls'): Promise<{ items: Snapshot[]; coverage: ProjectPageCoverage }> {
    const coverage = freshCoverage()
    const items = new Map<number, Snapshot>()
    let reachedEnd = false
    for (let page = 1; page <= this.maxPages; page += 1) {
      this.allowedRepo(repo)
      let data: unknown
      try {
        data = await this.github.api('GET', `/repos/${repo}/${kind}?state=all&sort=created&direction=asc&per_page=${this.pageSize}&page=${page}`)
      } catch (error) {
        coverage.reason = 'request_failed'
        if (error instanceof GitHubApiError) coverage.httpStatus = error.status
        break
      }
      coverage.pages += 1
      if (!Array.isArray(data) || data.length > this.pageSize) {
        coverage.reason = 'invalid_response'
        break
      }
      for (const raw of data) {
        const item = parseSnapshot(raw, repo, kind)
        if (!item) { coverage.invalidItems += 1; continue }
        const prior = items.get(item.number)
        if (prior) coverage.duplicates += 1
        if (!prior || item.updatedAt >= prior.updatedAt) items.set(item.number, item)
      }
      if (data.length < this.pageSize) { reachedEnd = true; break }
      coverage.reason = 'page_limit'
    }
    coverage.items = items.size
    if (reachedEnd) {
      coverage.reason = coverage.invalidItems ? 'invalid_item' : coverage.duplicates ? 'pagination_shift' : 'complete'
      coverage.complete = coverage.reason === 'complete'
    }
    return { items: [...items.values()], coverage }
  }

  private save(repo: string, kind: 'issue' | 'pull', item: Snapshot, syncAt: number, snapshotId: string): void {
    // 分别保存两个API的观测：issues分页不能抹掉pulls里的merged_at；晚回来的旧updated_at不能倒退已知事实。
    this.db.prepare(`INSERT INTO github_project_items (repo, number, ${kind}_snapshot, ${kind}_updated_at, ${kind}_sync_at, ${kind}_sync_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo, number) DO UPDATE SET ${kind}_snapshot = excluded.${kind}_snapshot,
      ${kind}_updated_at = excluded.${kind}_updated_at, ${kind}_sync_at = excluded.${kind}_sync_at, ${kind}_sync_id = excluded.${kind}_sync_id
      WHERE github_project_items.${kind}_updated_at IS NULL OR excluded.${kind}_updated_at >= github_project_items.${kind}_updated_at`)
      .run(repo, item.number, JSON.stringify(item), item.updatedAt, syncAt, snapshotId)
  }

  private repoStatus(repo: string, now: number): ProjectRepoStatus {
    const row = this.db.prepare('SELECT * FROM github_project_sync WHERE repo = ?').get(repo) as { snapshot_id: string; sync_at: number; last_complete_sync_at: number | null; coverage: string } | undefined
    const coverage = row ? JSON.parse(row.coverage) as ProjectRepoStatus['coverage'] : { complete: false, issues: freshCoverage(), pullRequests: freshCoverage() }
    return { repo, snapshotId: row?.snapshot_id ?? null, syncAt: row?.sync_at ?? null, lastCompleteSyncAt: row?.last_complete_sync_at ?? null, coverage,
      stale: !row || !coverage.complete || now - row.sync_at >= this.staleAfterMs }
  }

  private toItem(row: ItemRow, repo: ProjectRepoStatus, now: number): ProjectItem {
    const issue = row.issue_snapshot ? JSON.parse(row.issue_snapshot) as Snapshot : null
    const pull = row.pull_snapshot ? JSON.parse(row.pull_snapshot) as Snapshot : null
    const current = !issue ? pull! : !pull || issue.updatedAt > pull.updatedAt ? issue : pull
    const kind = pull || issue?.kind === 'pr' ? 'pr' : 'issue'
    const syncAt = Math.max(row.issue_sync_at ?? 0, row.pull_sync_at ?? 0)
    const sourceSyncId = current === pull ? row.pull_sync_id : row.issue_sync_id
    const mergedAt = kind === 'pr' ? pull?.mergedAt ?? null : null
    const detailsOld = kind === 'pr' && row.pull_sync_id !== repo.snapshotId
    return {
      id: `${row.repo}#${row.number}`, repo: row.repo, number: row.number, kind, title: current.title,
      state: current.state, stateReason: current.stateReason, assignees: current.assignees, url: current.url,
      createdAt: current.createdAt, updatedAt: current.updatedAt, closedAt: current.closedAt, mergedAt,
      draft: kind === 'pr' ? pull?.draft ?? null : null,
      createdToClosedMs: current.closedAt === null ? null : current.closedAt - current.createdAt,
      createdToMergedMs: mergedAt === null ? null : mergedAt - current.createdAt,
      syncAt, coverage: { issueObservedAt: row.issue_sync_at, pullObservedAt: row.pull_sync_at, mergeStateKnown: kind === 'pr' && pull !== null },
      stale: repo.stale || sourceSyncId !== repo.snapshotId || detailsOld || now - syncAt >= this.staleAfterMs,
    }
  }
}

function parseSnapshot(raw: unknown, repo: string, endpoint: 'issues' | 'pulls'): Snapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (!Number.isSafeInteger(r.number) || Number(r.number) < 1 || typeof r.title !== 'string' || !['open', 'closed'].includes(String(r.state))) return undefined
  if (!Array.isArray(r.assignees) || r.assignees.some((x) => !x || typeof x !== 'object' || typeof x.login !== 'string' || !x.login)) return undefined
  const createdAt = timestamp(r.created_at)
  const updatedAt = timestamp(r.updated_at)
  const closedAt = r.closed_at === null ? null : timestamp(r.closed_at)
  const kind = endpoint === 'pulls' || r.pull_request ? 'pr' : 'issue'
  const mergedAt = endpoint === 'pulls' ? (r.merged_at === null ? null : timestamp(r.merged_at)) : null
  if (createdAt === undefined || updatedAt === undefined || closedAt === undefined || mergedAt === undefined) return undefined
  if (updatedAt < createdAt || (closedAt !== null && closedAt < createdAt) || (mergedAt !== null && mergedAt < createdAt)) return undefined
  if (r.state === 'open' && (closedAt !== null || mergedAt !== null)) return undefined
  if (typeof r.html_url !== 'string') return undefined
  try {
    const url = new URL(r.html_url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname.toLowerCase() !== `/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${r.number}`) return undefined
  } catch { return undefined }
  return { number: Number(r.number), kind, title: r.title, state: r.state as 'open' | 'closed',
    stateReason: typeof r.state_reason === 'string' ? r.state_reason : null,
    assignees: [...new Set(r.assignees.map((x) => String(x.login)))], url: r.html_url, createdAt, updatedAt, closedAt, mergedAt,
    draft: endpoint === 'pulls' && typeof r.draft === 'boolean' ? r.draft : null }
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
