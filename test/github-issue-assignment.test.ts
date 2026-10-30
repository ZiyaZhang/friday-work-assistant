/**
 * 第三批第 2 条后半：负责人规则唯一命中时，网关在建单之后直接写 GitHub assignee。
 * 这里只测写入本身与账本（github_issue_operations，action='assigned'）和只读核对；
 * 接线（待拍板、群里 @、回执）见 github-issue-triage.test.ts。
 * 真实 SQLite 与真实 GitHubIdentity（PAT 模式，GitHubApiError 与 beforeRequest 的顺序照真实实现）；只有 HTTP 是合成的。
 */
import { describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { GitHubApiError, GitHubIdentity, loadGitHubConfig, type GitHubHttp } from '../src/github/identity.js'
import { IN_FLIGHT_GRACE_MS, IssueReconciliation } from '../src/github/issue-reconciliation.js'
import { assignIssue, IssueLinks, type IssueOperationOrigin } from '../src/github/issues.js'
import { issueTriageLines, triageDecisionText } from '../src/github/issue-triage.js'
import { createLogger } from '../src/log.js'

const NOW = 1_800_000_000_000
const REPO = 'org/a'
const URL42 = `https://github.com/${REPO}/issues/42`
const log = createLogger('github-issue-assignment-test', 'error')

const origin: IssueOperationOrigin = { version: 1, apiCallId: 'call-a',
  origin: { runId: 'run-a', taskId: 1, workKey: 'task:1', sessionKey: 'session-a', ownerOpenId: 'ou_alice', spaceId: 'space-a', chatId: 'chat-a', chatType: 'group' },
  provenance: { memoryRefs: [], sources: { version: 1, acpSessionId: 'acp-a', spaceId: 'space-a', chatId: 'chat-a', memoryScopes: [], chats: [], external: [], repositories: [REPO] } } }

type PostMode = 'ok' | 'ignore' | 'forbidden' | 'lost_after_apply' | 'lost_before_apply' | 'bad_gateway'

function setup() {
  const registry = new Registry(':memory:')
  let clock = NOW
  const links = new IssueLinks(registry.db, () => clock)
  const state = {
    assignees: [] as string[], post: 'ok' as PostMode, readError: false, readOverride: {} as Record<string, unknown>, tokenError: false,
    authorized: true,
  }
  const calls: { method: string; path: string; body?: unknown }[] = []
  const http: GitHubHttp = { async request(method, path, body) {
    calls.push({ method, path, body })
    if (method === 'GET' && path === `/repos/${REPO}/issues/42`) {
      if (state.readError) throw new Error('read-back unavailable')
      return { status: 200, data: { number: 42, title: '登录页白屏', state: 'open', html_url: URL42, labels: [],
        assignees: state.assignees.map(login => ({ login })), ...state.readOverride } as never }
    }
    if (method === 'POST' && path === `/repos/${REPO}/issues/42/assignees`) {
      const wanted = (body as { assignees: string[] }).assignees
      const apply = () => { for (const login of wanted) if (!state.assignees.some(a => a.toLowerCase() === login.toLowerCase())) state.assignees.push(login.toLowerCase()) }
      if (state.post === 'forbidden') return { status: 403, data: { message: 'Resource not accessible by integration' } as never }
      if (state.post === 'bad_gateway') return { status: 502, data: { message: 'Bad Gateway' } as never }
      if (state.post === 'lost_before_apply') throw new Error('connection reset before GitHub answered')
      if (state.post !== 'ignore') apply()
      if (state.post === 'lost_after_apply') throw new Error('connection reset after GitHub applied the request')
      return { status: 201, data: { number: 42, html_url: URL42, assignees: state.assignees.map(login => ({ login })) } as never }
    }
    throw new Error(`unexpected ${method} ${path}`)
  } }
  const identity = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'synthetic-token', FRIDAY_GITHUB_REPOS: REPO, FRIDAY_GITHUB_WRITE_REPOS: REPO } as NodeJS.ProcessEnv)!, log, http)
  // 安装令牌换取失败发生在 HTTP 之前（beforeRequest 之前），与真实 GitHubIdentity.api 的顺序相同
  const github = {
    api: ((...args: Parameters<GitHubIdentity['api']>) => state.tokenError && args[0] === 'POST'
      ? Promise.reject(new GitHubApiError(401, '换 installation token 失败')) : identity.api(...args)) as GitHubIdentity['api'],
    botLogin: () => identity.botLogin(),
  }
  const assertAuthorized = () => { if (!state.authorized) throw Object.assign(new Error('原工作已停止、暂停或发生变化，请在对应任务中继续'), { status: 403 }) }
  const assign = (key = 'assign-1', login = 'carol', extra: { captureOrigin?: () => IssueOperationOrigin } = {}) =>
    assignIssue(github, links, { repo: REPO, number: 42, url: URL42, login, requestKey: key, assertAuthorized, ...extra })
  const row = (key = 'assign-1') => registry.db.prepare('SELECT * FROM github_issue_operations WHERE request_key = ?').get(key) as Record<string, unknown> | undefined
  const posts = () => calls.filter(call => call.method === 'POST').length
  return { registry, links, state, calls, github, assign, row, posts, advance: (ms: number) => { clock += ms } }
}

describe('assignIssue：唯一负责人写 GitHub assignee，账本 action=assigned', () => {
  it('reads the Issue first, writes the assignee, confirms it by read-back and keeps one assigned row with its origin', async () => {
    const t = setup()
    const outcome = await t.assign('assign-1', 'carol', { captureOrigin: () => origin })
    expect(outcome).toEqual({ state: 'assigned', login: 'carol', assignees: ['carol'] })
    expect(t.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      `GET /repos/${REPO}/issues/42`, `POST /repos/${REPO}/issues/42/assignees`, `GET /repos/${REPO}/issues/42`])
    expect(t.calls[1]!.body).toEqual({ assignees: ['carol'] })
    expect(t.row()).toMatchObject({ action: 'assigned', status: 'confirmed', repo: REPO, number: 42, url: URL42, fingerprint: 'assignee:carol', error: null, comment_url: null })
    expect(JSON.parse(String(t.row()!.result))).toEqual({ repo: REPO, number: 42, url: URL42, login: 'carol', assignees: ['carol'] })
    expect(JSON.parse(String(t.row()!.origin_json))).toEqual(origin)
    // 同一请求重放：只恢复已有结果，不再读、不再写
    const before = t.calls.length
    expect(await t.assign('assign-1', 'carol')).toEqual({ state: 'assigned', login: 'carol', assignees: ['carol'], replayed: true })
    expect(t.calls.length).toBe(before)
    expect(t.registry.db.prepare("SELECT count(*) AS n FROM github_issue_operations WHERE action = 'assigned'").get()!.n).toBe(1)
    t.registry.close()
  })

  it('GitHub accepts the request but the read-back lacks the person: conflict, recorded once and never resent', async () => {
    const t = setup(); t.state.post = 'ignore'
    expect(await t.assign()).toEqual({ state: 'conflict', login: 'carol', assignees: [] })
    expect(t.row()).toMatchObject({ status: 'conflict', number: 42 })
    expect(String(t.row()!.error)).toContain('carol')
    expect(JSON.parse(String(t.row()!.result))).toMatchObject({ login: 'carol', assignees: [] })
    expect(await t.assign()).toEqual({ state: 'conflict', login: 'carol', assignees: [], replayed: true })
    expect(t.posts()).toBe(1)
    t.registry.close()
  })

  it('a 403 from GitHub is operation_failed with the status; nothing is retried', async () => {
    const t = setup(); t.state.post = 'forbidden'
    expect(await t.assign()).toEqual({ state: 'failed', login: 'carol', httpStatus: 403, error: 'Resource not accessible by integration' })
    expect(t.row()).toMatchObject({ status: 'operation_failed', error: 'HTTP 403: Resource not accessible by integration' })
    expect(JSON.parse(String(t.row()!.result))).toMatchObject({ login: 'carol', assignees: [], httpStatus: 403 })
    expect(t.calls.map(call => call.method)).toEqual(['GET', 'POST'])
    expect(await t.assign()).toEqual({ state: 'failed', login: 'carol', httpStatus: 403, error: 'Resource not accessible by integration', replayed: true })
    expect(t.posts()).toBe(1)
    t.registry.close()
  })

  it('does not write when the Issue already has an assignee or another request already assigned this Issue', async () => {
    const t = setup(); t.state.assignees = ['dave']
    expect(await t.assign()).toEqual({ state: 'skipped', login: 'carol', reason: 'already_assigned', assignees: ['dave'] })
    expect(t.row()).toBeUndefined()
    expect(t.posts()).toBe(0)

    const u = setup()
    expect(await u.assign('first-request')).toMatchObject({ state: 'assigned' })
    u.state.assignees = []   // 之后有人在 GitHub 上把负责人移除了
    const before = u.calls.length
    expect(await u.assign('second-request')).toEqual({ state: 'skipped', login: 'carol', reason: 'assigned_before' })
    expect(u.calls.length).toBe(before)
    expect(u.row('second-request')).toBeUndefined()
    t.registry.close(); u.registry.close()
  })

  it('two concurrent requests for the same Issue send one assignment; the later one sees the earlier ledger row', async () => {
    const t = setup()
    const [first, second] = await Promise.all([t.assign('first-request'), t.assign('second-request')])
    expect(first).toEqual({ state: 'assigned', login: 'carol', assignees: ['carol'] })
    expect(second).toEqual({ state: 'skipped', login: 'carol', reason: 'assigned_before' })
    expect(t.posts()).toBe(1)
    t.registry.close()
  })

  it('an earlier operation that GitHub rejected does not block a later request', async () => {
    const t = setup(); t.state.post = 'forbidden'
    expect(await t.assign('first-request')).toMatchObject({ state: 'failed' })
    t.state.post = 'ok'
    expect(await t.assign('second-request')).toEqual({ state: 'assigned', login: 'carol', assignees: ['carol'] })
    expect(t.posts()).toBe(2)
    t.registry.close()
  })

  it('an e-mail owner or an unreadable Issue is not written', async () => {
    const t = setup()
    expect(await t.assign('assign-1', 'carol@example.com')).toEqual({ state: 'skipped', login: 'carol@example.com', reason: 'not_a_login' })
    expect(t.calls).toEqual([])
    t.state.readError = true
    expect(await t.assign()).toEqual({ state: 'skipped', login: 'carol', reason: 'unreadable' })
    expect(t.row()).toBeUndefined()
    expect(t.posts()).toBe(0)
    t.registry.close()
  })

  it('a lost delegation right before the request releases the reservation and throws; nothing is sent', async () => {
    const t = setup()
    let checks = 0
    const assertAuthorized = () => { if (++checks >= 2) throw Object.assign(new Error('原工作已停止'), { status: 403 }) }
    await expect(assignIssue(t.github, t.links, { repo: REPO, number: 42, url: URL42, login: 'carol', requestKey: 'assign-1', assertAuthorized })).rejects.toThrow('原工作已停止')
    expect(t.row()).toBeUndefined()
    expect(t.posts()).toBe(0)
    t.registry.close()
  })

  it('an installation-token failure before the request is operation_failed without an HTTP status', async () => {
    const t = setup(); t.state.tokenError = true
    expect(await t.assign()).toEqual({ state: 'failed', login: 'carol', error: '换 installation token 失败' })
    expect(t.row()).toMatchObject({ status: 'operation_failed', error: '未发出：换 installation token 失败' })
    expect(t.posts()).toBe(0)
    t.registry.close()
  })
})

describe('结果未知的指派按回读判定，不重发', () => {
  it('a connection lost after GitHub applied it is confirmed by reading the Issue back', async () => {
    const t = setup(); t.state.post = 'lost_after_apply'
    expect(await t.assign()).toEqual({ state: 'assigned', login: 'carol', assignees: ['carol'] })
    expect(t.row()).toMatchObject({ status: 'confirmed', error: null })
    expect(JSON.parse(String(t.row()!.reconciliation))).toMatchObject({ result: 'confirmed', target: 'carol', assignees: ['carol'], previousError: 'connection reset after GitHub applied the request' })
    expect(t.posts()).toBe(1)
    t.registry.close()
  })

  it('a connection lost before GitHub applied it stays unknown; replays read again and never send; absence is recorded only after the grace period', async () => {
    const t = setup(); t.state.post = 'lost_before_apply'
    expect(await t.assign()).toEqual({ state: 'unknown', login: 'carol' })
    expect(t.row()).toMatchObject({ status: 'unknown', error: 'connection reset before GitHub answered' })
    expect(JSON.parse(String(t.row()!.reconciliation))).toMatchObject({ result: 'too_recent', target: 'carol', assignees: [] })
    t.state.post = 'ok'
    expect(await t.assign()).toEqual({ state: 'unknown', login: 'carol' })
    t.advance(IN_FLIGHT_GRACE_MS)
    expect(await t.assign()).toEqual({ state: 'unknown', login: 'carol' })
    expect(t.row()).toMatchObject({ status: 'unknown', error: 'verified_absent' })
    expect(JSON.parse(String(t.row()!.reconciliation))).toMatchObject({ result: 'verified_absent', previousError: 'connection reset before GitHub answered' })
    expect(t.posts()).toBe(1)
    t.registry.close()
  })

  it('a 502 from the relay or GitHub is unknown, not a failure', async () => {
    const t = setup(); t.state.post = 'bad_gateway'
    expect(await t.assign()).toEqual({ state: 'unknown', login: 'carol' })
    expect(t.row()).toMatchObject({ status: 'unknown' })
    expect(t.posts()).toBe(1)
    t.registry.close()
  })
})

describe('IssueReconciliation 覆盖 assigned', () => {
  it('reads nothing for a planned row still in flight or for rows that already have an outcome', async () => {
    const t = setup()
    const reconciliation = new IssueReconciliation(t.github, t.links)
    const plan = (key: string) => t.links.planOperation({ requestKey: key, signature: `sig-${key}`, fingerprint: 'assignee:carol', action: 'assigned', repo: REPO, number: 42, url: URL42 })
    const result = { repo: REPO, number: 42, url: URL42, login: 'carol', assignees: [] as string[] }
    plan('planned')
    plan('sent'); t.links.sentOperation('sent', 42, URL42)
    plan('confirmed'); t.links.sentOperation('confirmed', 42, URL42); t.links.confirmOperation('confirmed', { ...result, assignees: ['carol'] })
    plan('conflict'); t.links.sentOperation('conflict', 42, URL42); t.links.conflictOperation('conflict', result, '回读的负责人里没有 carol')
    plan('failed'); t.links.failOperation('failed', 'HTTP 403: Forbidden', { ...result, httpStatus: 403 })
    expect(await reconciliation.reconcile('planned', {})).toMatchObject({ result: 'in_flight', status: 'planned', number: 42 })
    t.advance(IN_FLIGHT_GRACE_MS)
    for (const [key, status] of [['sent', 'sent'], ['confirmed', 'confirmed'], ['conflict', 'conflict'], ['failed', 'operation_failed']] as const) {
      const before = t.row(key)
      expect(await reconciliation.reconcile(key, {})).toMatchObject({ result: 'already_resolved', status })
      expect(t.row(key)).toEqual(before)
    }
    expect(t.calls).toEqual([])
    t.registry.close()
  })

  it('confirms an old planned row when GitHub shows the person, and records absence for an old row it cannot find', async () => {
    const t = setup()
    const reconciliation = new IssueReconciliation(t.github, t.links)
    t.links.planOperation({ requestKey: 'crashed', signature: 'sig-crashed', fingerprint: 'assignee:carol', action: 'assigned', repo: REPO, number: 42, url: URL42 })
    t.links.planOperation({ requestKey: 'lost', signature: 'sig-lost', fingerprint: 'assignee:dave', action: 'assigned', repo: REPO, number: 42, url: URL42 })
    t.state.assignees = ['Carol']
    t.advance(IN_FLIGHT_GRACE_MS)
    expect(await reconciliation.reconcile('crashed', {})).toMatchObject({ result: 'confirmed', status: 'confirmed', number: 42 })
    expect(JSON.parse(String(t.row('crashed')!.result))).toEqual({ repo: REPO, number: 42, url: URL42, login: 'carol', assignees: ['Carol'] })
    expect(await reconciliation.reconcile('lost', {})).toMatchObject({ result: 'verified_absent', status: 'planned' })
    expect(t.row('lost')).toMatchObject({ status: 'planned', error: 'verified_absent' })
    expect(t.posts()).toBe(0)
    t.registry.close()
  })

  it('does not decide when the read-back fails or is not this Issue', async () => {
    const t = setup()
    const reconciliation = new IssueReconciliation(t.github, t.links)
    t.links.planOperation({ requestKey: 'lost', signature: 'sig-lost', fingerprint: 'assignee:carol', action: 'assigned', repo: REPO, number: 42, url: URL42 })
    t.links.unknownOperation('lost', 'synthetic transport outcome')
    t.state.assignees = ['carol']
    for (const arrange of [() => { t.state.readError = true }, () => { t.state.readOverride = { pull_request: {} } }, () => { t.state.readOverride = { number: 43 } },
      () => { t.state.readOverride = { html_url: 'https://github.com/other/repo/issues/42' } }]) {
      t.state.readError = false; t.state.readOverride = {}
      arrange()
      expect(await reconciliation.reconcile('lost', {})).toMatchObject({ result: 'unavailable', status: 'unknown' })
      expect(t.row('lost')).toMatchObject({ status: 'unknown', error: 'synthetic transport outcome', reconciliation: null })
    }
    t.registry.close()
  })
})

describe('指派结局写进待拍板与回执的文字', () => {
  const issue = { number: 42, url: URL42, title: '登录页白屏' }
  const owner = { kind: 'resolved' as const, login: 'carol', name: 'Carol', person: 'resolved' as const, mention: { openId: 'ou_carol', name: 'Carol' } }

  it('a 403 fallback names the reason in the decision and keeps every link whole within the inbox limits', () => {
    const verified = [40, 41, 43, 44, 45].map(number => ({ number, title: `同一个登录页白屏问题的第 ${number} 次报告，标题很长很长`, state: 'open' as const, url: `https://github.com/${REPO}/issues/${number}` }))
    const text = triageDecisionText({ repo: REPO, issue, questions: ['owner', 'priority', 'duplicate'], owner,
      assignment: { state: 'failed', login: 'carol', httpStatus: 403, error: 'Resource not accessible by integration' }, duplicates: { verified, unverified: [] } })
    expect(text.why.length).toBeLessThanOrEqual(300)
    expect(text.why).toContain('CODEOWNERS 唯一负责人是 Carol（GitHub carol），指派被 GitHub 拒绝（403，GitHub App 可能没有 Issues 写权限），待你定')
    expect(text.why).not.toContain('建议')
    for (const match of `${text.title} ${text.why}`.matchAll(/https:\/\/github\.com\/[^\s；，、）」]*/g)) expect(match[0]).toMatch(/\/issues\/\d+$/)
    const many = triageDecisionText({ repo: REPO, issue, questions: ['owner'], owner,
      assignment: { state: 'conflict', login: 'carol', assignees: Array.from({ length: 10 }, (_, i) => `someone-with-a-long-login-${i}`) }, duplicates: { verified: [], unverified: [] } })
    expect(many.why).toContain('等 10 人')
    expect(many.why.length).toBeLessThanOrEqual(300)
  })

  it('the group @ appears once for a new assignment and never for a replayed one or an Issue that already had an owner', () => {
    const fresh = issueTriageLines({ state: 'not_needed', owner, assignment: { state: 'assigned', login: 'carol', assignees: ['carol'] } }).join('\n')
    expect(fresh.match(/<at open_id="ou_carol">Carol<\/at>/g)).toHaveLength(1)
    expect(fresh).toContain('已按 CODEOWNERS 在 GitHub 上把这张 Issue 指派给 Carol（GitHub carol）')
    const { mention: _unused, ...quiet } = owner
    expect(issueTriageLines({ state: 'not_needed', owner: quiet, assignment: { state: 'assigned', login: 'carol', assignees: ['carol'], replayed: true } }).join('\n')).not.toContain('<at')
    const already = issueTriageLines({ state: 'not_needed', owner: quiet, assignment: { state: 'skipped', login: 'carol', reason: 'already_assigned', assignees: ['dave'] } }).join('\n')
    expect(already).toContain('已有负责人（dave）')
    expect(already).not.toContain('<at')
    // 待拍板写入失败时也照实说指派结果
    expect(issueTriageLines({ state: 'failed', assignment: { state: 'assigned', login: 'carol', assignees: ['carol'] } }).join('\n')).toContain('已指派给 carol（写后回读确认）')
  })
})
