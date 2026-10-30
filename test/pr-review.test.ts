import { describe, expect, it } from 'vitest'
import type { GitHubIdentity } from '../src/github/identity.js'
import { readPullRequestReview } from '../src/github/pr-review.js'

const repo = 'test-org/test-repo'
const number = 42
const prefix = `/repos/${repo}/pulls/${number}`
const input = { repo, number, maxPatchBytes: 120_000 }
type Row = Record<string, unknown>
type Source = 'files' | 'reviews' | 'comments'
function fixture() {
  const pr: Row = { number, title: 'Synthetic small fix', body: 'Why and how', state: 'open', draft: true, merged: false,
    user: { login: 'synthetic-author' }, base: { ref: 'main', sha: 'base-commit', repo: { full_name: repo } }, head: { ref: 'friday/fix', sha: 'head-commit', repo: { full_name: repo } },
    html_url: `https://github.com/${repo}/pull/${number}`, additions: 2, deletions: 1, changed_files: 1 }
  const sources: Record<Source, Row[]> = { files: [{ filename: 'fix.ts', status: 'modified', patch: '+ fix', additions: 2, deletions: 1 }], reviews: [], comments: [] }
  const calls: string[] = []
  const state = {
    beforeHttp: undefined as ((path: string) => void) | undefined,
    afterHttp: undefined as ((path: string) => void | Promise<void>) | undefined,
    response: undefined as ((path: string) => unknown) | undefined,
  }
  const api: GitHubIdentity['api'] = async <T>(_method: string, path: string, _body?: unknown, owner?: string, beforeRequest?: () => void): Promise<T> => {
    expect(_method).toBe('GET')
    expect(owner).toBe('test-org')
    state.beforeHttp?.(path)
    beforeRequest?.()
    calls.push(path)
    await state.afterHttp?.(path)
    if (state.response) {
      const result = state.response(path)
      if (result !== undefined) return result as T
    }
    if (path === prefix) return structuredClone(pr) as T
    const parsed = new URL(path, 'https://configured-api.example')
    const source = parsed.pathname.split('/').at(-1) as Source
    expect(parsed.searchParams.get('per_page')).toBe('100')
    const page = Number(parsed.searchParams.get('page'))
    return sources[source].slice((page - 1) * 100, page * 100) as T
  }
  return { github: { api }, pr, sources, calls, state }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

describe('bounded PR review evidence', () => {
  it('paginates more than 100 files, reviews and inline comments while preserving exact commit and comment locations', async () => {
    const f = fixture()
    f.sources.files = Array.from({ length: 101 }, (_, i) => ({ filename: `file-${i}.ts`, patch: '+fix' }))
    f.sources.reviews = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, state: 'COMMENTED', body: `review-${i}`, commit_id: 'head-commit' }))
    f.sources.comments = Array.from({ length: 101 }, (_, i) => ({ id: i + 1000, body: `inline-${i}`, path: `file-${i}.ts` }))
    f.sources.comments[100] = { id: 1100, user: { login: 'synthetic-reviewer' }, body: 'Preserve both independent requirements.',
      path: 'file-100.ts', line: 12, original_line: 10, side: 'RIGHT', start_line: 9, original_start_line: 8, start_side: 'RIGHT',
      commit_id: 'head-commit', original_commit_id: 'older-head', in_reply_to_id: 1099, pull_request_review_id: 101,
      html_url: `https://github.com/${repo}/pull/42#discussion_r1100`, created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T01:00:00Z' }
    const result = await readPullRequestReview(f.github, input)
    expect(result).toMatchObject({ repo, number, head: 'friday/fix', base: 'main', head_sha: 'head-commit', base_sha: 'base-commit', truncated: false })
    expect(result.files).toHaveLength(101)
    expect(result.existing_reviews).toHaveLength(101)
    expect(result.inline_comments).toHaveLength(101)
    expect(result.inline_comments[100]).toMatchObject({ id: 1100, author: 'synthetic-reviewer', path: 'file-100.ts', line: 12, original_line: 10,
      start_line: 9, original_start_line: 8, commit_id: 'head-commit', original_commit_id: 'older-head', in_reply_to_id: 1099, pull_request_review_id: 101 })
    for (const key of ['files', 'reviews', 'inline_comments'] as const) expect(result.coverage[key]).toMatchObject({ status: 'complete', pages: 2, items: 101, truncated: false })
    expect(f.calls).toHaveLength(8)
    expect(f.calls.at(-1)).toBe(prefix)
  })

  it('stops each source at five full pages and explicitly leaves coverage incomplete', async () => {
    const f = fixture()
    for (const key of ['files', 'reviews', 'comments'] as const) f.sources[key] = Array.from({ length: 501 }, (_, id) => ({ id, filename: `${id}.ts`, patch: 'x', body: 'x' }))
    const result = await readPullRequestReview(f.github, input)
    for (const key of ['files', 'reviews', 'inline_comments'] as const) {
      expect(result.coverage[key]).toMatchObject({ status: 'partial', pages: 5, items: 500, page_limit: 5, page_size: 100, reasons: ['page_limit'], truncated: true })
    }
    expect(result.truncated).toBe(true)
    expect(f.calls).toHaveLength(17)
    expect(f.calls.some(path => path.includes('page=6'))).toBe(false)
  })

  it('does not disguise a reviews request failure as no review, and keeps usable files and inline discussion', async () => {
    const f = fixture()
    f.sources.comments.push({ id: 7, path: 'fix.ts', line: 2, body: 'Still needs a fix' })
    f.state.response = path => { if (path.includes('/reviews?')) throw new Error('backend request failed; private transport details') }
    const result = await readPullRequestReview(f.github, input)
    expect(result.existing_reviews).toEqual([])
    expect(result.coverage.reviews).toMatchObject({ status: 'failed', pages: 0, items: 0, reasons: ['request_failed'] })
    expect(result.files).toHaveLength(1)
    expect(result.inline_comments).toMatchObject([{ id: 7, body: 'Still needs a fix' }])
    expect(result.coverage.inline_comments.status).toBe('complete')
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private transport details')
  })

  it('retains prior pages after a later failure without claiming the list was complete', async () => {
    const f = fixture()
    f.sources.files = Array.from({ length: 101 }, (_, id) => ({ filename: `${id}.ts`, patch: '+fix' }))
    f.state.response = path => { if (path.endsWith('/files?per_page=100&page=2')) throw new Error('second page failed') }
    const result = await readPullRequestReview(f.github, input)
    expect(result.files).toHaveLength(100)
    expect(result.coverage.files).toMatchObject({ status: 'partial', pages: 1, items: 100, reasons: ['request_failed'], truncated: true })
    expect(result.coverage.patch.complete).toBe(false)
    expect(result.coverage.reviews.status).toBe('complete')
  })

  it('marks an invalid page response as unread evidence rather than an empty completed source', async () => {
    const f = fixture()
    f.state.response = path => path.includes('/comments?') ? { message: 'unexpected response' } : undefined
    const result = await readPullRequestReview(f.github, input)
    expect(result.inline_comments).toEqual([])
    expect(result.coverage.inline_comments).toMatchObject({ status: 'failed', reasons: ['invalid_response'] })
    expect(result.truncated).toBe(true)
  })

  it('shares one UTF-8 patch budget across files without broken characters or concealed clipping', async () => {
    const f = fixture()
    f.sources.files = [{ filename: 'first.ts', patch: '中文😀' }, { filename: 'second.ts', patch: 'abc' }]
    const result = await readPullRequestReview(f.github, { ...input, maxPatchBytes: 5 })
    expect(result.files).toMatchObject([{ patch: '中', patch_truncated: true }, { patch: 'ab', patch_truncated: true }])
    expect(result.files.reduce((n, file) => n + Buffer.byteLength(file.patch), 0)).toBe(5)
    expect(result.coverage.patch).toMatchObject({ complete: false, limit_bytes: 5, returned_bytes: 5, truncated_files: 2, unavailable_files: 0 })
    expect(result.truncated).toBe(true)
  })

  it('does not mark an exactly fitting patch as truncated', async () => {
    const f = fixture()
    f.sources.files = [{ filename: 'first.ts', patch: '中文' }]
    const result = await readPullRequestReview(f.github, { ...input, maxPatchBytes: 6 })
    expect(result.files[0]?.patch).toBe('中文')
    expect(result.coverage.patch).toMatchObject({ complete: true, returned_bytes: 6, truncated_files: 0 })
    expect(result.truncated).toBe(false)
  })

  it('marks absent patches as missing coverage, independently of the budget', async () => {
    const f = fixture()
    f.sources.files = [{ filename: 'binary.png' }, { filename: 'huge.ts', patch: '' }]
    const result = await readPullRequestReview(f.github, input)
    expect(result.files.every(file => !file.patch_available)).toBe(true)
    expect(result.coverage.files.status).toBe('complete')
    expect(result.coverage.patch).toMatchObject({ complete: false, unavailable_files: 2, truncated_files: 0 })
    expect(result.truncated).toBe(true)
  })

  it('marks clipped PR and comment bodies explicitly rather than presenting a complete review', async () => {
    const f = fixture()
    f.pr.body = '中'.repeat(6000)
    f.sources.reviews = [{ id: 1, body: '中'.repeat(3000) }]
    f.sources.comments = [{ id: 2, body: '😀'.repeat(3000), path: 'fix.ts', commit_id: 'head-commit' }]
    const result = await readPullRequestReview(f.github, input)
    expect(result.body_truncated).toBe(true)
    expect(result.coverage.body).toMatchObject({ complete: false, limit_bytes: 16_000 })
    expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(16_000)
    for (const key of ['reviews', 'inline_comments'] as const) expect(result.coverage[key]).toMatchObject({ status: 'partial', text_truncated_items: 1, reasons: ['text_limit'] })
    expect(result.existing_reviews[0]?.body_truncated).toBe(true)
    expect(result.inline_comments[0]?.body_truncated).toBe(true)
    expect(result.inline_comments[0]?.commit_id).toBe('head-commit')
    expect(Buffer.byteLength(result.inline_comments[0]!.body)).toBeLessThanOrEqual(8000)
  })

  it('refuses any HTTP read when authorization is already revoked', async () => {
    const f = fixture(), denied = new Error('revoked')
    await expect(readPullRequestReview(f.github, { ...input, assertAuthorized: () => { throw denied } })).rejects.toBe(denied)
    expect(f.calls).toEqual([])
  })

  it('propagates revocation during an awaited page rather than returning partial data or reading another source', async () => {
    const f = fixture(), entered = deferred(), release = deferred(), denied = new Error('revoked during review')
    let allowed = true
    f.state.afterHttp = async path => { if (path.includes('/reviews?')) { entered.resolve(); await release.promise } }
    const reading = readPullRequestReview(f.github, { ...input, assertAuthorized: () => { if (!allowed) throw denied } })
    await entered.promise; allowed = false; release.resolve()
    await expect(reading).rejects.toBe(denied)
    expect(f.calls.some(path => path.includes('/comments?'))).toBe(false)
  })

  it('preserves a beforeRequest authorization failure even if a later callback could otherwise pass', async () => {
    const f = fixture(), denied = new Error('revoked before HTTP')
    let rejectNext = false
    f.state.beforeHttp = path => { if (path.includes('/reviews?')) rejectNext = true }
    await expect(readPullRequestReview(f.github, { ...input, assertAuthorized: () => {
      if (rejectNext) { rejectNext = false; throw denied }
    } })).rejects.toBe(denied)
    expect(f.calls.some(path => path.includes('/reviews?') || path.includes('/comments?'))).toBe(false)
  })

  it('does not swallow revocation when the same awaited request also fails', async () => {
    const f = fixture(), denied = new Error('revoked')
    let allowed = true
    f.state.response = path => { if (path.includes('/reviews?')) { allowed = false; throw new Error('transport failure') } }
    await expect(readPullRequestReview(f.github, { ...input, assertAuthorized: () => { if (!allowed) throw denied } })).rejects.toBe(denied)
    expect(f.calls.some(path => path.includes('/comments?'))).toBe(false)
  })

  it.each([
    ['head', 'sha'], ['base', 'sha'], ['head', 'ref'], ['base', 'ref'], ['head', 'repo'], ['base', 'repo'],
  ] as const)('rejects mixed evidence when %s %s changes during pagination, without automatically retrying', async (side, field) => {
    const f = fixture(), entered = deferred(), release = deferred()
    f.state.afterHttp = async path => { if (path.includes('/files?')) { entered.resolve(); await release.promise } }
    const reading = readPullRequestReview(f.github, input)
    await entered.promise
    const version = f.pr[side] as Row
    version[field] = field === 'repo' ? { full_name: 'test-org/other-repo' } : 'new-value'
    f.sources.files[0]!.patch = '+ belongs to the changed PR version'
    release.resolve()
    await expect(reading).rejects.toThrow('PR在读取期间更新，请重新读取')
    expect(f.calls.filter(path => path === prefix)).toHaveLength(2)
    expect(f.calls.filter(path => path.includes('/files?'))).toHaveLength(1)
  })

  it('does not return otherwise complete evidence when the final PR version lookup fails', async () => {
    const f = fixture(), failed = new Error('final PR lookup unavailable')
    f.state.response = path => {
      if (path === prefix && f.calls.filter(call => call === prefix).length === 2) throw failed
    }
    await expect(readPullRequestReview(f.github, input)).rejects.toBe(failed)
    expect(f.calls).toEqual([prefix, `${prefix}/files?per_page=100&page=1`, `${prefix}/reviews?per_page=100&page=1`, `${prefix}/comments?per_page=100&page=1`, prefix])
  })

  it.each(['wrong-number', 'missing-head', 'missing-base', 'request-failed'] as const)('does not build review evidence when the primary PR has %s', async kind => {
    const f = fixture()
    if (kind === 'wrong-number') f.pr.number = 43
    if (kind === 'missing-head') f.pr.head = { ref: 'friday/fix' }
    if (kind === 'missing-base') f.pr.base = { ref: 'main' }
    if (kind === 'request-failed') f.state.response = () => { throw new Error('PR unavailable') }
    await expect(readPullRequestReview(f.github, input)).rejects.toThrow()
    expect(f.calls).toEqual([prefix])
  })
})
