import type { GitHubIdentity } from './identity.js'

const PAGE_SIZE = 100
const PAGE_LIMIT = 5
const BODY_BYTES = 16_000
const COMMENT_BYTES = 8_000

type CoverageReason = 'page_limit' | 'request_failed' | 'invalid_response' | 'text_limit'
export interface PullRequestSourceCoverage {
  status: 'complete' | 'partial' | 'failed'
  pages: number
  items: number
  page_size: number
  page_limit: number
  truncated: boolean
  text_truncated_items: number
  reasons: CoverageReason[]
}

export interface ReadPullRequestReviewInput {
  repo: string
  number: number
  maxPatchBytes: number
  /** Host authorization, checked again after every await and by GitHubIdentity before HTTP. */
  assertAuthorized?: () => void
}

type Row = Record<string, unknown>
function record(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
}
function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }

/** UTF-8 byte limits must not split a multibyte character or add an uncounted marker. */
function limitedText(value: unknown, limit: number) {
  const text = typeof value === 'string' ? value : ''
  if (Buffer.byteLength(text) <= limit) return { text, bytes: Buffer.byteLength(text), truncated: false }
  let bytes = 0, end = 0
  for (const character of text) {
    const size = Buffer.byteLength(character)
    if (bytes + size > limit) break
    bytes += size; end += character.length
  }
  return { text: text.slice(0, end), bytes, truncated: true }
}

/** Read-only evidence. Metadata is from the initial PR read, with version identity rechecked after paging. */
export async function readPullRequestReview(github: Pick<GitHubIdentity, 'api'>, input: ReadPullRequestReviewInput) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo) || !Number.isSafeInteger(input.number) || input.number <= 0) throw new Error('需要有效的仓库和 PR 编号')
  if (!Number.isSafeInteger(input.maxPatchBytes) || input.maxPatchBytes < 0 || input.maxPatchBytes > 400_000) throw new Error('diff 字节预算必须为 0 到 400000 的整数')
  const owner = input.repo.split('/')[0]!
  const path = `/repos/${input.repo}/pulls/${input.number}`
  let authorizationFailed = false, authorizationError: unknown
  const check = (): void => {
    if (authorizationFailed) throw authorizationError
    try { input.assertAuthorized?.() }
    catch (error) { authorizationFailed = true; authorizationError = error; throw error }
  }
  const get = async (target: string): Promise<unknown> => {
    check()
    try {
      const result = await github.api<unknown>('GET', target, undefined, owner, check)
      check()
      return result
    } catch (error) {
      // A source request can fail at the same time its run is revoked. Revocation wins.
      check()
      throw error
    }
  }
  const versionOf = (pr: Row): string => {
    const head = record(pr.head), base = record(pr.base)
    if (pr.number !== input.number || !string(head.sha) || !string(base.sha)) throw new Error('PR 回读缺少匹配的编号或 head/base 提交，不能建立审阅版本')
    return JSON.stringify([pr.number, head.sha, base.sha, string(head.ref), string(base.ref),
      string(record(head.repo).full_name), string(record(base.repo).full_name)])
  }
  const pr = record(await get(path))
  const initialVersion = versionOf(pr)

  const readPages = async (suffix: string) => {
    const rows: Row[] = []
    const coverage: PullRequestSourceCoverage = {
      status: 'complete', pages: 0, items: 0, page_size: PAGE_SIZE, page_limit: PAGE_LIMIT,
      truncated: false, text_truncated_items: 0, reasons: [],
    }
    for (let page = 1; page <= PAGE_LIMIT; page++) {
      let result: unknown
      try { result = await get(`${path}/${suffix}?per_page=${PAGE_SIZE}&page=${page}`) }
      catch {
        check()
        coverage.reasons.push('request_failed')
        break
      }
      if (!Array.isArray(result) || result.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
        coverage.reasons.push('invalid_response')
        break
      }
      rows.push(...result as Row[])
      coverage.pages++
      if (result.length < PAGE_SIZE) break
      if (page === PAGE_LIMIT) coverage.reasons.push('page_limit')
    }
    coverage.items = rows.length
    coverage.truncated = coverage.reasons.length > 0
    if (coverage.truncated) coverage.status = coverage.pages ? 'partial' : 'failed'
    return { rows, coverage }
  }

  const filesSource = await readPages('files')
  const reviewsSource = await readPages('reviews')
  const commentsSource = await readPages('comments')
  // Two reads are not an atomic snapshot, but detect ordinary pushes/retargeting during pagination.
  // This required read is not a best-effort source: failure or version drift rejects the whole result.
  const finalVersion = versionOf(record(await get(path)))
  if (finalVersion !== initialVersion) throw new Error('PR在读取期间更新，请重新读取')
  let patchBytes = 0, truncatedFiles = 0, unavailableFiles = 0
  const files = filesSource.rows.map(file => {
    const available = typeof file.patch === 'string' && file.patch.length > 0
    if (!available) unavailableFiles++
    const patch = limitedText(file.patch, Math.max(0, input.maxPatchBytes - patchBytes))
    patchBytes += patch.bytes
    if (patch.truncated) truncatedFiles++
    return {
      filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions,
      patch: patch.text, patch_available: available, patch_truncated: patch.truncated,
    }
  })
  const commentBody = (body: unknown, coverage: PullRequestSourceCoverage) => {
    const limited = limitedText(body, COMMENT_BYTES)
    if (limited.truncated) {
      coverage.text_truncated_items++
      coverage.truncated = true
      coverage.status = 'partial'
      if (!coverage.reasons.includes('text_limit')) coverage.reasons.push('text_limit')
    }
    return { body: limited.text, body_truncated: limited.truncated }
  }
  const existing_reviews = reviewsSource.rows.map(review => ({
    id: review.id, author: string(record(review.user).login), state: review.state,
    ...commentBody(review.body, reviewsSource.coverage), commit_id: review.commit_id,
    submitted_at: review.submitted_at, url: review.html_url,
  }))
  const inline_comments = commentsSource.rows.map(comment => ({
    id: comment.id, author: string(record(comment.user).login),
    ...commentBody(comment.body, commentsSource.coverage), path: comment.path,
    line: comment.line, original_line: comment.original_line, side: comment.side,
    start_line: comment.start_line, original_start_line: comment.original_start_line, start_side: comment.start_side,
    position: comment.position, original_position: comment.original_position,
    commit_id: comment.commit_id, original_commit_id: comment.original_commit_id,
    pull_request_review_id: comment.pull_request_review_id, in_reply_to_id: comment.in_reply_to_id,
    url: comment.html_url, created_at: comment.created_at, updated_at: comment.updated_at,
  }))
  const body = limitedText(pr.body, BODY_BYTES)
  const patchComplete = !filesSource.coverage.truncated && truncatedFiles === 0 && unavailableFiles === 0
  check()
  return {
    repo: input.repo, number: input.number, title: pr.title, state: pr.state, draft: pr.draft, merged: pr.merged,
    author: string(record(pr.user).login), base: string(record(pr.base).ref), head: string(record(pr.head).ref),
    base_sha: string(record(pr.base).sha)!, head_sha: string(record(pr.head).sha)!,
    url: pr.html_url, body: body.text, body_truncated: body.truncated,
    additions: pr.additions, deletions: pr.deletions, changed_files: pr.changed_files, mergeable_state: pr.mergeable_state,
    files, existing_reviews, inline_comments,
    truncated: !patchComplete || reviewsSource.coverage.truncated || commentsSource.coverage.truncated || body.truncated,
    coverage: {
      files: filesSource.coverage, reviews: reviewsSource.coverage, inline_comments: commentsSource.coverage,
      body: { complete: !body.truncated, limit_bytes: BODY_BYTES, returned_bytes: body.bytes },
      patch: { complete: patchComplete, limit_bytes: input.maxPatchBytes, returned_bytes: patchBytes, truncated_files: truncatedFiles, unavailable_files: unavailableFiles },
    },
  }
}

export type PullRequestReview = Awaited<ReturnType<typeof readPullRequestReview>>
