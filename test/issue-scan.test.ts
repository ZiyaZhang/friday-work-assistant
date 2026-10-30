import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { IssueWatch, type IssueWatchBinding } from '../src/core/issue-watch.js'
import { linkedPullRequestCount, scanUnassignedIssues } from '../src/github/issue-scan.js'
import type { GitHubIdentity } from '../src/github/identity.js'

const DAY = 24 * 3600_000
const NOW = Date.UTC(2026, 8, 22)
const date = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
const binding: IssueWatchBinding = { spaceId: 'sp_a', boundBy: 'alice', repo: 'org/demo', since: NOW - 30 * DAY, labels: [] }

function comment(id: number, daysAgo: number, login = 'alice', type = 'User') {
  return { id, created_at: date(daysAgo), user: { login, type } }
}

function fixture(options: { comments?: unknown[]; timeline?: unknown[]; botLogin?: string } = {}) {
  const comments = options.comments ?? []
  const timeline = options.timeline ?? []
  const issue = {
    number: 7, title: '加载慢', html_url: 'https://github.com/org/demo/issues/7', state: 'open',
    assignees: [], labels: [], comments: comments.length, created_at: date(20), updated_at: date(2),
  }
  let latest: unknown = issue
  const api = vi.fn(async (_method: string, path: string): Promise<unknown> => {
    const url = new URL(path, 'https://api.github.com')
    if (url.pathname.endsWith('/issues')) return [issue]
    if (url.pathname.endsWith('/issues/7')) return latest
    const page = Number(url.searchParams.get('page') ?? 1)
    const size = Number(url.searchParams.get('per_page'))
    expect(size).toBe(100)
    expect(url.searchParams.has('sort')).toBe(false)
    expect(url.searchParams.has('direction')).toBe(false)
    const rows = url.pathname.endsWith('/comments') ? comments : timeline
    return rows.slice((page - 1) * size, page * size)
  })
  const botLogin = vi.fn(async () => options.botLogin ?? 'friday[bot]')
  const github = { api, botLogin } as unknown as GitHubIdentity
  return { issue, comments, timeline, api, botLogin, github, setLatest: (value: unknown) => { latest = value } }
}

describe('GitHub issue 扫描必须覆盖完整事实', () => {
  it('第 101 条时间线事件里的关联 PR 不能漏掉', async () => {
    const timeline = Array.from({ length: 100 }, (_, id) => ({ id, event: 'labeled' }))
    const pr = { event: 'cross-referenced', source: { issue: { number: 42, html_url: 'https://github.com/org/demo/pull/42', state: 'open', pull_request: {} } } }
    const t = fixture({ timeline: [...timeline, pr] })
    const [snapshot] = await scanUnassignedIssues(t.github, 'org/demo')
    expect(snapshot?.linkedPullRequests).toBe(1)
    expect(t.api.mock.calls.map(([, path]) => path)).toContain('/repos/org/demo/issues/7/timeline?per_page=100&page=2')
    const db = new DatabaseSync(':memory:')
    expect(new IssueWatch(db, () => NOW).decide(binding, snapshot!, DAY).skip).toBe('linked_pr')
    db.close()
  })

  it('晚到的第 101 条真人回复重新计时，不能拿第一条旧评论催问', async () => {
    const t = fixture({ comments: [...Array.from({ length: 100 }, (_, i) => comment(i + 1, 10)), comment(101, 0.01)] })
    const [snapshot] = await scanUnassignedIssues(t.github, 'org/demo')
    expect(snapshot).toMatchObject({ lastCommentAt: Date.parse(date(0.01)), lastHumanCommentAt: Date.parse(date(0.01)), lastCommentByBot: false })
    const db = new DatabaseSync(':memory:')
    expect(new IssueWatch(db, () => NOW).decide(binding, snapshot!, DAY).skip).toBe('too_fresh')
    db.close()
  })

  it('最后一条是机器人时仍保留前面的真人回复，不让 bot 消息掩盖或制造重新跟进', async () => {
    const t = fixture({ comments: [comment(1, 15), comment(2, 5, 'bob'), comment(3, 0.01, 'other[bot]', 'Bot')] })
    const [snapshot] = await scanUnassignedIssues(t.github, 'org/demo')
    expect(snapshot).toMatchObject({ lastCommentAt: Date.parse(date(0.01)), lastHumanCommentAt: Date.parse(date(5)), lastCommentByBot: true })
    const db = new DatabaseSync(':memory:')
    let now = NOW - 10 * DAY
    const watch = new IssueWatch(db, () => now)
    watch.claim(binding.spaceId, binding.repo, 7)
    now = NOW
    expect(watch.decide(binding, snapshot!, DAY).notice?.text).toContain('最后一次有人说话是 5 天前')
    db.close()
  })

  it('PAT 自己的 User 评论和其他 Bot 评论都不能被当成真人回复', async () => {
    const t = fixture({ botLogin: 'service-account', comments: [comment(1, 5, 'service-account'), comment(2, 1, 'automation', 'Bot')] })
    const [snapshot] = await scanUnassignedIssues(t.github, 'org/demo')
    expect(snapshot).toMatchObject({ lastCommentByBot: true })
    expect(snapshot?.lastHumanCommentAt).toBeUndefined()
  })

  it('机器人身份读取失败时不把未知评论判成人，也不生成提醒快照', async () => {
    const t = fixture({ comments: [comment(1, 5, 'service-account')] })
    t.botLogin.mockRejectedValueOnce(new Error('identity unavailable'))
    expect(await scanUnassignedIssues(t.github, 'org/demo')).toEqual([])
    expect(t.api).toHaveBeenCalledTimes(1)
  })

  it('时间线读到硬上限仍未结束时不声称没有关联 PR', async () => {
    const t = fixture({ timeline: Array.from({ length: 501 }, (_, id) => ({ id, event: 'labeled' })) })
    expect(await scanUnassignedIssues(t.github, 'org/demo')).toEqual([])
    expect(t.api.mock.calls.filter(([, path]) => path.includes('/timeline'))).toHaveLength(5)
  })

  it.each([{ event: 'connected', id: 1 }, { event: 'cross-referenced', source: null }, {}])('时间线关联目标不可见或格式不完整时不声称没有 PR', async (event) => {
    const t = fixture({ timeline: [event] })
    expect(await scanUnassignedIssues(t.github, 'org/demo')).toEqual([])
  })

  it('评论数超过可完整覆盖的预算时跳过，不取局部当最新回复', async () => {
    const t = fixture()
    t.issue.comments = 501
    expect(await scanUnassignedIssues(t.github, 'org/demo')).toEqual([])
    expect(t.api).toHaveBeenCalledTimes(1)
  })

  it.each(['timeline', 'comments'])('%s 第二页请求中断时整条 issue 不进入提醒判定', async (collection) => {
    const t = fixture({
      comments: Array.from({ length: 101 }, (_, i) => comment(i + 1, 5)),
      timeline: Array.from({ length: 101 }, (_, id) => ({ id, event: 'labeled' })),
    })
    const api = t.api.getMockImplementation()!
    t.api.mockImplementation(async (method, path) => {
      if (path.includes(`/${collection}?`) && path.includes('page=2')) throw new Error('page unavailable')
      return api(method, path)
    })
    expect(await scanUnassignedIssues(t.github, 'org/demo')).toEqual([])
  })

  it.each([
    { id: 1, created_at: date(5), user: null },
    { id: 1, created_at: date(5), user: { login: 'unknown' } },
    { id: 1, created_at: 'invalid', user: { login: 'alice', type: 'User' } },
  ])('评论身份或时间不完整时不猜测', async (row) => {
    const t = fixture({ comments: [row] })
    expect(await scanUnassignedIssues(t.github, 'org/demo')).toEqual([])
  })

  it('评论分页有重复或数量不符时不声明完整覆盖', async () => {
    const t = fixture({ comments: [comment(1, 5), comment(1, 4)] })
    expect(await scanUnassignedIssues(t.github, 'org/demo')).toEqual([])
    t.comments.pop()
    expect(await scanUnassignedIssues(t.github, 'org/demo')).toEqual([])
  })

  it.each(['new_comment', 'new_activity', 'assigned', 'closed'] as const)('分页期间 %s，放弃混合了新旧事实的快照', async (change) => {
    const t = fixture()
    const latest = { ...t.issue, assignees: [] as { login: string }[] }
    if (change === 'new_comment') latest.comments = 1
    if (change === 'new_activity') latest.updated_at = date(0)
    if (change === 'assigned') latest.assignees = [{ login: 'alice' }]
    if (change === 'closed') latest.state = 'closed'
    t.setLatest(latest)
    expect(await scanUnassignedIssues(t.github, 'org/demo')).toEqual([])
  })

  it('完整无评论的 issue 可进入提醒，所有调用均为只读 GET', async () => {
    const t = fixture()
    const [snapshot] = await scanUnassignedIssues(t.github, 'org/demo')
    expect(snapshot?.number).toBe(7)
    expect(snapshot?.lastCommentAt).toBeUndefined()
    expect(t.api.mock.calls.every(([method]) => method === 'GET')).toBe(true)
  })

  it('limit 为 0 时不联网扫描', async () => {
    const t = fixture()
    expect(await scanUnassignedIssues(t.github, 'org/demo', { limit: 0 })).toEqual([])
    expect(t.api).not.toHaveBeenCalled()
  })

  it('关掉但未合并的 PR 不冒充正在处理，合并过的关联保留且去重', () => {
    const event = (number: number, state: string, merged = false) => ({ event: 'cross-referenced', source: { issue: {
      number, html_url: `https://github.com/org/demo/pull/${number}`, state, pull_request: merged ? { merged_at: date(1) } : {},
    } } })
    expect(linkedPullRequestCount([event(1, 'closed'), event(2, 'closed', true), event(2, 'closed', true), event(3, 'open')])).toBe(2)
  })
})
