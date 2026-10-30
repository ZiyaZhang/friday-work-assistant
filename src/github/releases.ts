/**
 * 发布版本读取与"某个提交进了哪个版本"的比对。
 *
 * 两处共用：`POST /v1/github/releases`（按需查询）和 PR 巡查（合并之后自动查"进了哪个版本"）。
 * 规则只写一遍：
 * - 只比已发布（非 draft）的版本；从旧到新比，第一个包含它的就是最早包含它的版本；继续比完是为了确认后续版本也都带着它
 * - 最多比最新 `RELEASE_COMPARE_LIMIT` 个
 * - "查过的版本里没找到" ≠ "没发布"：调用方要把 `checked` 说清楚
 *
 * `check` 在每次拿到 GitHub 响应之后调一次：授权可能在等待期间撤销，抛错就中止。
 */
import type { GitHubIdentity } from './identity.js'

export interface ReleaseSummary {
  tag: string
  name: string
  published_at: string | null
  draft: boolean
  prerelease: boolean
  url: string | null
}

export interface ReleaseListing {
  repo: string
  /** 没有 release 时退回 tag：tag 不是发布，调用方要说清楚 */
  source: 'releases' | 'tags'
  releases: ReleaseSummary[]
  tags: string[]
  /** 非 draft 的，顺序同 `releases`（GitHub 返回的新到旧） */
  published: ReleaseSummary[]
  latest: string | null
  /** 最新的是预览版时，正式版单独给出来：别让人把 alpha 当成正式发布 */
  latest_stable: string | null
}

export const RELEASE_COMPARE_LIMIT = 12

type GitHubReader = Pick<GitHubIdentity, 'api'>

export async function readReleases(github: GitHubReader, repo: string, limit: number, check: () => void = () => {}): Promise<ReleaseListing> {
  const raw = await github.api<Record<string, unknown>[]>('GET', `/repos/${repo}/releases?per_page=${limit}`)
  check()
  const releases = (raw ?? []).map((r): ReleaseSummary => ({
    tag: String(r.tag_name ?? ''), name: String(r.name ?? r.tag_name ?? ''),
    published_at: (r.published_at as string | null) ?? null,
    draft: Boolean(r.draft), prerelease: Boolean(r.prerelease),
    url: (r.html_url as string | null) ?? null,
  })).filter((r) => r.tag)
  let tags: string[] = []
  if (!releases.length) {
    const rawTags = await github.api<Record<string, unknown>[]>('GET', `/repos/${repo}/tags?per_page=${limit}`)
    check()
    tags = (rawTags ?? []).map((t) => String(t.name ?? '')).filter(Boolean)
  }
  const published = releases.filter((r) => !r.draft)
  return {
    repo, source: releases.length ? 'releases' : 'tags', releases, tags, published,
    latest: published[0]?.tag ?? null,
    latest_stable: published.find((r) => !r.prerelease)?.tag ?? null,
  }
}

/**
 * 最早包含 `sha` 的已发布版本。`published` 里 draft 不该出现（调用方传 `readReleases().published`）。
 * 候选为空或 sha 为空时不发任何请求。
 */
export async function firstReleaseContaining(github: GitHubReader, repo: string, sha: string, published: readonly ReleaseSummary[], check: () => void = () => {}): Promise<{ first: ReleaseSummary | null; checked: string[]; containing: string[] }> {
  const checked: string[] = [], containing: string[] = []
  let first: ReleaseSummary | null = null
  if (!sha) return { first, checked, containing }
  // 从旧到新比，第一个包含它的就是最早包含它的版本；继续比完是为了确认后续版本也都带着它
  const ordered = [...published].filter((r) => !r.draft).sort((a, b) => String(a.published_at ?? '').localeCompare(String(b.published_at ?? '')))
  for (const rel of ordered.slice(-RELEASE_COMPARE_LIMIT)) {
    checked.push(rel.tag)
    const cmp = await github.api<{ status?: string }>('GET', `/repos/${repo}/compare/${encodeURIComponent(rel.tag)}...${encodeURIComponent(sha)}`)
    check()
    if (cmp?.status === 'behind' || cmp?.status === 'identical') {
      containing.push(rel.tag)
      if (!first) first = rel
    }
  }
  return { first, checked, containing }
}

/** 合并之前发布的版本不可能包含合并提交，不用比。发布时间未知的保留（宁可多比一次）；没有时刻可依据时全部保留。 */
export function releasesPublishedSince(published: readonly ReleaseSummary[], sinceMs: number | null): ReleaseSummary[] {
  if (sinceMs === null || !Number.isFinite(sinceMs)) return [...published]
  return published.filter((r) => {
    if (!r.published_at) return true
    const at = Date.parse(r.published_at)
    return !Number.isFinite(at) || at >= sinceMs
  })
}
