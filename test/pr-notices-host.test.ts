/**
 * 自己开的 PR：合并 → 进入发布版本 → 回告原会话与原报障人；review 超时分档升级。宿主级（sweepPullRequests）。
 *
 * 真 Orchestrator、真 PrWatch、真 ChangeManager（只用 poll / closingIssues）、真 Bugs、真投递账本；
 * GitHub 与飞书是替身。模型不参与。
 *
 * 判重全靠写下来的东西：github_pr_notices 的 (change_id, kind) 与 deliveries 的 key。
 * "重启"= 换一个 Orchestrator + PrWatch 实例读同一个库。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { Bugs } from '../src/core/bugs.js'
import { ensureDeliverySchema } from '../src/core/delivery.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { PrWatch } from '../src/core/pr-watch.js'
import { Registry } from '../src/core/registry.js'
import { ChangeManager } from '../src/github/changes.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const HOUR = 3600_000
const NOW = 1_800_000_000_000
const SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const PR_URL = 'https://github.com/o/r/pull/41'
const ISSUE_URL = 'https://github.com/o/r/issues/7'

interface Remote {
  pr: { merged: boolean; draft: boolean; state: 'open' | 'closed'; merged_at: string | null }
  reviews: unknown[]
  releases: { tag_name: string; name: string; published_at: string | null; draft: boolean; prerelease: boolean; html_url: string | null }[]
  /** 哪些 tag 包含合并提交 */
  contains: Set<string>
  closing: { number: number; url: string; repo: string }[]
  fail?: 'releases' | 'graphql' | 'compare' | 'pull'
}

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function fixture(env: Record<string, string> = {}) {
  const registry = new Registry(':memory:')
  ensureDeliverySchema(registry.db) // 生产里启动时建；这里先建好，账本断言才能在没发过任何东西时也查得到
  const home = mkdtempSync(join(tmpdir(), 'friday-pr-notices-host-'))
  cleanups.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  const cfg = loadConfig({ FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test', FRIDAY_REFLECT: 'off', FRIDAY_HOME: home, ...env })
  const sp = spaceDeps(registry.db)
  // 开 PR 的群：负责人 ou_owner，发起人 ou_alice 是普通成员
  const work = sp.spaces.ensure({ kind: 'group', chatId: 'chat-work', openId: 'ou_owner' })
  sp.spaces.addMember(work.id, 'ou_alice', 'member')
  // 报障的群：负责人 ou_lead，报障人 ou_bob、ou_carol
  const users = sp.spaces.ensure({ kind: 'group', chatId: 'chat-users', openId: 'ou_lead' })
  sp.spaces.addMember(users.id, 'ou_bob', 'member')
  sp.spaces.addMember(users.id, 'ou_carol', 'member')
  registry.createSession({ sessionKey: 'sess-a', chatId: 'chat-work', chatType: 'group', cwd: home, requesterOpenId: 'ou_alice' })
  const remote: Remote = {
    pr: { merged: false, draft: false, state: 'open', merged_at: null }, reviews: [],
    releases: [], contains: new Set(), closing: [],
  }
  const calls: string[] = []
  const api = vi.fn(async (method: string, path: string, body?: unknown): Promise<unknown> => {
    calls.push(`${method} ${path}`)
    if (path === '/repos/o/r/pulls/41') {
      if (remote.fail === 'pull') throw new Error('pull unavailable')
      return { number: 41, html_url: PR_URL, state: remote.pr.state, draft: remote.pr.draft, merged: remote.pr.merged,
        merged_at: remote.pr.merged_at, merge_commit_sha: remote.pr.merged ? SHA : null }
    }
    if (path.startsWith('/repos/o/r/pulls/41/reviews')) return remote.reviews
    if (path.startsWith('/repos/o/r/releases')) { if (remote.fail === 'releases') throw new Error('releases unavailable'); return remote.releases }
    if (path.startsWith('/repos/o/r/tags')) return []
    const cmp = /^\/repos\/o\/r\/compare\/(.+)\.\.\.(.+)$/.exec(path)
    if (cmp) {
      if (remote.fail === 'compare') throw new Error('compare unavailable')
      return { status: remote.contains.has(decodeURIComponent(cmp[1]!)) ? 'behind' : 'diverged' }
    }
    if (method === 'POST' && path === '/graphql') {
      if (remote.fail === 'graphql') throw new Error('graphql unavailable')
      const b = body as { query: string; variables: Record<string, unknown> }
      expect(b.query).toContain('closingIssuesReferences')
      expect(b.variables).toMatchObject({ owner: 'o', name: 'r', number: 41 })
      return { data: { repository: { pullRequest: { closingIssuesReferences: {
        nodes: remote.closing.map((i) => ({ number: i.number, url: i.url, repository: { nameWithOwner: i.repo } })) } } } } }
    }
    throw new Error(`unexpected ${method} ${path}`)
  })
  const github = { api, repoAllowed: (repo: string) => repo === 'o/r', defaultRepo: () => 'o/r' } as unknown as GitHubIdentity
  const log = createLogger('pr-notices-host', 'error')
  const changes = new ChangeManager({ db: registry.db, github, log, cacheDir: join(home, 'cache') })
  registry.db.prepare(`INSERT INTO github_changes (id, session_key, requester_open_id, cwd, dir, repo, base, base_commit, branch, remote_url, git_dir, state, pr_number, pr_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('chg_41', 'sess-a', 'ou_alice', home, join(home, 'dir'), 'o/r', 'main', 'base0', 'friday/fix-7', 'https://github.com/o/r.git', join(home, 'git'), 'confirmed', 41, PR_URL, NOW, NOW)
  const bugs = new Bugs(registry.db)
  const feishu = new FakeFeishu()
  feishu.members.set('chat-work', new Set(['ou_owner', 'ou_alice']))
  feishu.members.set('chat-users', new Set(['ou_lead', 'ou_bob', 'ou_carol']))
  const client = asFeishuClient(feishu)
  const sendToChat = vi.spyOn(client, 'sendToChat')
  let clock = NOW
  const build = () => new Orchestrator({
    cfg, registry, ...sp, changes, github, bugs, prWatch: new PrWatch(registry.db, () => clock), now: () => clock,
    feishu: client, runtime: {} as AcpRuntime, memory: new ChannelMemory(registry.db), tokens: new TokenIssuer('test'),
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/unused', botOpenId: 'bot', log,
  })
  let orchestrator = build()
  const texts = (chatId: string) => feishu.sent.filter((s) => s.kind === 'sendToChat' && s.target === chatId).map((s) => (s.payload as { text: string }).text)
  const mentionsOf = (chatId: string) => sendToChat.mock.calls.filter((c) => c[0] === chatId).map((c) => [...(c[2]?.mentionOpenIds ?? [])])
  const notices = () => (registry.db.prepare('SELECT change_id, kind FROM github_pr_notices ORDER BY noticed_at, kind').all() as { change_id: string; kind: string }[]).map((r) => r.kind)
  const deliveries = () => (registry.db.prepare('SELECT delivery_key, status FROM deliveries ORDER BY delivery_key').all() as { delivery_key: string; status: string }[])
  const release = (tag: string, over: Partial<Remote['releases'][number]> = {}) => {
    remote.releases.unshift({ tag_name: tag, name: tag, published_at: new Date(NOW + HOUR).toISOString(), draft: false, prerelease: false, html_url: `https://github.com/o/r/releases/tag/${tag}`, ...over })
  }
  const merge = () => { remote.pr = { merged: true, draft: false, state: 'closed', merged_at: new Date(NOW - HOUR).toISOString() } }
  const reportBug = (chatId: string, reporter: string, messageId: string, bucketId?: number) => bugs.record({
    spaceId: chatId === 'chat-users' ? users.id : work.id, title: '插件页加载慢', chatId, text: '插件页打开要十几秒', messageId, reporterOpenId: reporter, bucketId, now: NOW - 3 * 24 * HOUR,
  }).bucket
  return {
    registry, sp, work, users, remote, calls, api, bugs, feishu, sendToChat, texts, mentionsOf, notices, deliveries, release, merge, reportBug,
    sweep: (overdueMs?: number, escalateMs?: number) => orchestrator.sweepPullRequests(overdueMs, escalateMs),
    at: (t: number) => { clock = t },
    restart: () => { orchestrator = build() },
  }
}

describe('合并与发布：原会话各一句', () => {
  it('合并了说"已合并"，并提醒合并不等于发布；同一轮不说进入发布', async () => {
    const t = fixture()
    t.merge(); t.release('0.1.6'); t.remote.contains.add('0.1.6')
    expect(await t.sweep()).toBe(1)
    expect(t.texts('chat-work')).toHaveLength(1)
    expect(t.texts('chat-work')[0]).toContain('PR #41 已合并')
    expect(t.texts('chat-work')[0]).toContain('合并不等于发布')
    expect(t.mentionsOf('chat-work')[0]).toEqual(['ou_alice'])
    expect(t.notices()).toEqual(['merged'])
    // 合并这一轮不查 release
    expect(t.calls.filter((c) => c.includes('/releases') || c.includes('/compare/'))).toEqual([])
  })

  it('合并提醒过之后，某个已发布版本包含它 → 原会话一句"已进入 vX"，只说一次，重启也不重复', async () => {
    const t = fixture()
    t.merge()
    await t.sweep()
    // 还没有发布版本：什么都不说，但要去查
    expect(await t.sweep()).toBe(0)
    expect(t.calls.filter((c) => c.includes('/releases'))).toHaveLength(1)
    t.release('0.1.6'); t.remote.contains.add('0.1.6')
    expect(await t.sweep()).toBe(1)
    const said = t.texts('chat-work')
    expect(said).toHaveLength(2)
    expect(said[1]).toContain('PR #41 已进入 0.1.6')
    expect(said[1]).toContain('https://github.com/o/r/releases/tag/0.1.6')
    expect(t.notices()).toEqual(['merged', 'released'])
    expect(await t.sweep()).toBe(0)
    t.restart()
    expect(await t.sweep()).toBe(0)
    expect(t.texts('chat-work')).toHaveLength(2)
    // 说过"已进入"之后不再盯：不再读这个 PR
    const before = t.calls.length
    await t.sweep()
    expect(t.calls.length).toBe(before)
  })

  it('发布版本发布在合并之前的不比对；比对只针对合并之后发布的', async () => {
    const t = fixture()
    t.merge()
    await t.sweep()
    t.release('0.1.5', { published_at: new Date(NOW - 10 * HOUR).toISOString() })
    expect(await t.sweep()).toBe(0)
    expect(t.calls.filter((c) => c.includes('/compare/'))).toEqual([])
    t.release('0.1.6'); t.remote.contains.add('0.1.6')
    expect(await t.sweep()).toBe(1)
    expect(t.calls.filter((c) => c.includes('/compare/'))).toEqual([`GET /repos/o/r/compare/0.1.6...${SHA}`])
  })

  it('查 release 失败这一轮跳过、不写账本，下一轮再查', async () => {
    const t = fixture()
    t.merge()
    await t.sweep()
    t.release('0.1.6'); t.remote.contains.add('0.1.6')
    t.remote.fail = 'releases'
    expect(await t.sweep()).toBe(0)
    expect(t.notices()).toEqual(['merged'])
    t.remote.fail = undefined
    expect(await t.sweep()).toBe(1)
    expect(t.notices()).toEqual(['merged', 'released'])
  })
})

describe('部署前就发布过的旧版本：一次性回填', () => {
  it('这个版本第一次巡查之前发布的版本包含它 → "已进入"只记不发，不回告，之后不再盯', async () => {
    const t = fixture({ FRIDAY_RELEASE_REPORTER_NOTICES: 'on' })
    t.merge(); await t.sweep()
    // 第一次巡查在 NOW；这个版本发布在它之前（合并之后）
    t.release('0.1.5', { published_at: new Date(NOW - 30 * 60_000).toISOString() }); t.remote.contains.add('0.1.5')
    expect(await t.sweep()).toBe(0)
    expect(t.texts('chat-work')).toHaveLength(1)
    expect(t.notices()).toEqual(['merged', 'released'])
    expect(t.deliveries()).toEqual([])
    const before = t.calls.length
    expect(await t.sweep()).toBe(0)
    expect(t.calls.length).toBe(before)
  })

  it('起点持久在 kv：重启后仍按第一次巡查的时刻算，之后发布的版本照说"已进入"', async () => {
    const t = fixture()
    t.merge(); await t.sweep()
    t.at(NOW + 2 * HOUR); t.restart()
    t.release('0.1.6', { published_at: new Date(NOW + 30 * 60_000).toISOString() }); t.remote.contains.add('0.1.6')
    expect(await t.sweep()).toBe(1)
    expect(t.texts('chat-work')[1]).toContain('PR #41 已进入 0.1.6')
    expect(t.registry.db.prepare("SELECT v FROM kv WHERE k = 'pr-release-notice-boundary'").get()).toEqual({ v: String(NOW) })
  })
})

describe('回告原报障人：开关 FRIDAY_RELEASE_REPORTER_NOTICES', () => {
  it('默认 off：原会话照说"已进入"，原报障群什么都不发，也不去查 PR 关闭了哪些 Issue', async () => {
    const t = fixture()
    const bucket = t.reportBug('chat-users', 'ou_bob', 'om_bug1')
    t.bugs.linkIssue(bucket.id, ISSUE_URL)
    t.remote.closing = [{ number: 7, url: ISSUE_URL, repo: 'o/r' }]
    t.merge(); await t.sweep()
    t.release('0.1.6'); t.remote.contains.add('0.1.6')
    expect(await t.sweep()).toBe(1)
    expect(t.texts('chat-work')).toHaveLength(2)
    expect(t.texts('chat-users')).toEqual([])
    expect(t.calls.filter((c) => c.includes('/graphql'))).toEqual([])
    expect(t.deliveries()).toEqual([])
  })

  it('on：按 bug_reports 的原会话各回告一次，@ 该群的报障人；再扫、重启都不重复', async () => {
    const t = fixture({ FRIDAY_RELEASE_REPORTER_NOTICES: 'on' })
    const bucket = t.reportBug('chat-users', 'ou_bob', 'om_bug1')
    t.reportBug('chat-users', 'ou_carol', 'om_bug2', bucket.id)
    t.reportBug('chat-users', 'ou_bob', 'om_bug3', bucket.id) // 同一个人报两次：还是一条
    t.bugs.linkIssue(bucket.id, ISSUE_URL)
    t.remote.closing = [{ number: 7, url: ISSUE_URL, repo: 'o/r' }]
    t.merge(); await t.sweep()
    t.release('0.1.6'); t.remote.contains.add('0.1.6')
    expect(await t.sweep()).toBe(1)
    expect(t.texts('chat-work')).toHaveLength(2)
    const said = t.texts('chat-users')
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('插件页加载慢')
    expect(said[0]).toContain('已进入 0.1.6')
    expect(said[0]).toContain(PR_URL)
    expect(said[0]).toContain(ISSUE_URL)
    expect(t.mentionsOf('chat-users')[0]).toEqual(['ou_bob', 'ou_carol'])
    const ledger = t.deliveries()
    expect(ledger).toEqual([{ delivery_key: `pr-released:chg_41:${bucket.id}:chat-users`, status: 'sent' }])
    expect(await t.sweep()).toBe(0)
    t.restart()
    expect(await t.sweep()).toBe(0)
    expect(t.texts('chat-users')).toHaveLength(1)
    expect(t.deliveries()).toEqual(ledger)
  })

  it('on：两个群各有案件关联同一个 Issue → 两个群各一条；Issue 没有对应案件 → 只发原会话', async () => {
    const t = fixture({ FRIDAY_RELEASE_REPORTER_NOTICES: 'on' })
    const bucket = t.reportBug('chat-users', 'ou_bob', 'om_bug1')
    t.bugs.linkIssue(bucket.id, ISSUE_URL)
    const again = t.reportBug('chat-work', 'ou_alice', 'om_bug2')
    t.bugs.linkIssue(again.id, `${ISSUE_URL}/`) // 同一个 Issue，旧存量的尾斜杠写法
    const other = t.bugs.record({ spaceId: t.users.id, title: '别的问题', chatId: 'chat-users', text: '无关', messageId: 'om_other', reporterOpenId: 'ou_carol' }).bucket
    t.bugs.linkIssue(other.id, 'https://github.com/o/r/issues/99')
    t.remote.closing = [{ number: 7, url: ISSUE_URL, repo: 'o/r' }, { number: 8, url: 'https://github.com/o/r/issues/8', repo: 'o/r' }]
    t.merge(); await t.sweep()
    t.release('0.1.6'); t.remote.contains.add('0.1.6')
    expect(await t.sweep()).toBe(1)
    expect(t.texts('chat-users')).toHaveLength(1)
    expect(t.mentionsOf('chat-users')[0]).toEqual(['ou_bob'])
    // 开 PR 的群里：一句"已进入"（给发起人）+ 一句回告（给该群的报障人）
    expect(t.texts('chat-work')).toHaveLength(3)
    expect(t.mentionsOf('chat-work')[2]).toEqual(['ou_alice'])
    expect(t.deliveries().map((d) => d.delivery_key).sort()).toEqual([`pr-released:chg_41:${again.id}:chat-work`, `pr-released:chg_41:${bucket.id}:chat-users`].sort())
  })

  it('on：查 PR 关闭的 Issue 失败 → 这一轮连"已进入"都不说，下一轮重试后两边都说', async () => {
    const t = fixture({ FRIDAY_RELEASE_REPORTER_NOTICES: 'on' })
    const bucket = t.reportBug('chat-users', 'ou_bob', 'om_bug1')
    t.bugs.linkIssue(bucket.id, ISSUE_URL)
    t.remote.closing = [{ number: 7, url: ISSUE_URL, repo: 'o/r' }]
    t.merge(); await t.sweep()
    t.release('0.1.6'); t.remote.contains.add('0.1.6')
    t.remote.fail = 'graphql'
    expect(await t.sweep()).toBe(0)
    expect(t.notices()).toEqual(['merged'])
    t.remote.fail = undefined
    expect(await t.sweep()).toBe(1)
    expect(t.texts('chat-work')).toHaveLength(2)
    expect(t.texts('chat-users')).toHaveLength(1)
  })

  it('on：原会话暂不可达（空间停用）→ 回告先发出去；恢复后原会话补说"已进入"，回告只核对原收据不重发', async () => {
    const t = fixture({ FRIDAY_RELEASE_REPORTER_NOTICES: 'on' })
    const bucket = t.reportBug('chat-users', 'ou_bob', 'om_bug1')
    t.bugs.linkIssue(bucket.id, ISSUE_URL)
    t.remote.closing = [{ number: 7, url: ISSUE_URL, repo: 'o/r' }]
    t.merge(); await t.sweep()
    t.release('0.1.6'); t.remote.contains.add('0.1.6')
    t.sp.spaces.suspend(t.work.id)
    expect(await t.sweep()).toBe(0)
    expect(t.texts('chat-users')).toHaveLength(1)
    expect(t.notices()).toEqual(['merged']) // 原会话不可达：不占位，下一轮再来
    const ledger = t.deliveries()
    expect(ledger).toHaveLength(1)
    t.restart()
    expect(await t.sweep()).toBe(0)
    expect(t.texts('chat-users')).toHaveLength(1)
    t.sp.spaces.resume('chat-work')
    expect(await t.sweep()).toBe(1)
    expect(t.texts('chat-work')[1]).toContain('已进入 0.1.6')
    expect(t.texts('chat-users')).toHaveLength(1)
    expect(t.deliveries()).toEqual(ledger)
    expect(t.notices()).toEqual(['merged', 'released'])
  })

  it('on：报障来自私聊 → 发到该报障人自己的私聊，账本受众是 dm；再扫不重复', async () => {
    const t = fixture({ FRIDAY_RELEASE_REPORTER_NOTICES: 'on' })
    const dm = t.sp.spaces.ensure({ kind: 'p2p', chatId: 'chat-dm-bob', openId: 'ou_bob' })
    const bucket = t.bugs.record({ spaceId: dm.id, title: '插件页加载慢', chatId: 'chat-dm-bob', text: '私聊里报的', messageId: 'om_dm1', reporterOpenId: 'ou_bob' }).bucket
    t.bugs.linkIssue(bucket.id, ISSUE_URL)
    t.remote.closing = [{ number: 7, url: ISSUE_URL, repo: 'o/r' }]
    t.merge(); await t.sweep()
    t.release('0.1.6'); t.remote.contains.add('0.1.6')
    expect(await t.sweep()).toBe(1)
    const dms = () => t.feishu.sent.filter((s) => s.kind === 'sendToUser').map((s) => ({ to: s.target, text: (s.payload as { text: string }).text }))
    expect(dms()).toHaveLength(1)
    expect(dms()[0]!.to).toBe('ou_bob')
    expect(dms()[0]!.text).toContain('已进入 0.1.6')
    expect(t.deliveries()).toEqual([{ delivery_key: `pr-released:chg_41:${bucket.id}:chat-dm-bob`, status: 'sent' }])
    expect(t.texts('chat-work')).toHaveLength(2)
    expect(await t.sweep()).toBe(0)
    expect(dms()).toHaveLength(1)
  })

  it('on：报障人已不在原群（成员表里没有）→ 那个群不发；案件已停止跟进 → 不发', async () => {
    const t = fixture({ FRIDAY_RELEASE_REPORTER_NOTICES: 'on' })
    const bucket = t.reportBug('chat-users', 'ou_bob', 'om_bug1')
    t.bugs.linkIssue(bucket.id, ISSUE_URL)
    t.sp.spaces.removeMember(t.users.id, 'ou_bob')
    const stopped = t.reportBug('chat-work', 'ou_alice', 'om_bug2')
    t.bugs.linkIssue(stopped.id, 'https://github.com/o/r/issues/8')
    t.bugs.stopFollowing(stopped.id, t.work.id, NOW)
    t.remote.closing = [{ number: 7, url: ISSUE_URL, repo: 'o/r' }, { number: 8, url: 'https://github.com/o/r/issues/8', repo: 'o/r' }]
    t.merge(); await t.sweep()
    t.release('0.1.6'); t.remote.contains.add('0.1.6')
    expect(await t.sweep()).toBe(1)
    expect(t.texts('chat-users')).toEqual([])
    expect(t.texts('chat-work')).toHaveLength(2) // 只有"已合并"与"已进入"
    expect(t.deliveries()).toEqual([])
  })
})

describe('review 超时分档', () => {
  it('第一档：原会话 @ 发起人；第二档：同一会话 @ 空间负责人；各一次，重启不重复', async () => {
    const t = fixture({ FRIDAY_PR_REVIEW_ESCALATE_MS: String(48 * HOUR) })
    expect(await t.sweep(12 * HOUR, 48 * HOUR)).toBe(0) // 第一次看见就绪
    t.at(NOW + 13 * HOUR)
    expect(await t.sweep(12 * HOUR, 48 * HOUR)).toBe(1)
    expect(t.texts('chat-work')[0]).toContain('还没有人 review')
    expect(t.mentionsOf('chat-work')[0]).toEqual(['ou_alice'])
    t.at(NOW + 30 * HOUR)
    expect(await t.sweep(12 * HOUR, 48 * HOUR)).toBe(0)
    t.at(NOW + 49 * HOUR)
    expect(await t.sweep(12 * HOUR, 48 * HOUR)).toBe(1)
    expect(t.texts('chat-work')[1]).toContain('49 小时')
    expect(t.texts('chat-work')[1]).toContain(PR_URL)
    expect(t.mentionsOf('chat-work')[1]).toEqual(['ou_owner'])
    expect(t.notices()).toEqual(['ready_seen', 'review_overdue', 'review_escalated'])
    t.restart()
    t.at(NOW + 200 * HOUR)
    expect(await t.sweep(12 * HOUR, 48 * HOUR)).toBe(0)
    expect(t.texts('chat-work')).toHaveLength(2)
  })

  it('不传阈值时用配置：FRIDAY_PR_REVIEW_ESCALATE_MS 默认 48 小时', async () => {
    const t = fixture()
    await t.sweep()
    t.at(NOW + 13 * HOUR)
    expect(await t.sweep()).toBe(1)
    t.at(NOW + 47 * HOUR)
    expect(await t.sweep()).toBe(0)
    t.at(NOW + 49 * HOUR)
    expect(await t.sweep()).toBe(1)
    expect(t.mentionsOf('chat-work')[1]).toEqual(['ou_owner'])
  })

  it('第二档配 0 = 不升级', async () => {
    const t = fixture({ FRIDAY_PR_REVIEW_ESCALATE_MS: '0' })
    await t.sweep()
    t.at(NOW + 13 * HOUR)
    expect(await t.sweep()).toBe(1)
    t.at(NOW + 999 * HOUR)
    expect(await t.sweep()).toBe(0)
    expect(t.texts('chat-work')).toHaveLength(1)
  })

  it('空间负责人不在群里时退回 @ 发起人', async () => {
    const t = fixture()
    t.feishu.members.set('chat-work', new Set(['ou_alice']))
    await t.sweep()
    t.at(NOW + 13 * HOUR); await t.sweep()
    t.at(NOW + 49 * HOUR)
    expect(await t.sweep()).toBe(1)
    expect(t.mentionsOf('chat-work')[1]).toEqual(['ou_alice'])
  })
})

describe('ChangeManager：轮询补合并信息；读 PR 关闭的 Issue', () => {
  function manager(api: (method: string, path: string, body?: unknown) => unknown) {
    const registry = new Registry(':memory:')
    const home = mkdtempSync(join(tmpdir(), 'friday-pr-closing-'))
    cleanups.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
    const github = { api: vi.fn(async (m: string, p: string, b?: unknown) => api(m, p, b)), repoAllowed: () => true } as unknown as GitHubIdentity
    return new ChangeManager({ db: registry.db, github, log: createLogger('pr-closing', 'error'), cacheDir: join(home, 'cache') })
  }

  it('poll：已合并的带合并提交与合并时刻；未合并的两项都是 null', async () => {
    const merged = manager((_m, path) => path.endsWith('/pulls/41')
      ? { html_url: PR_URL, state: 'closed', draft: false, merged: true, merged_at: '2026-09-20T10:00:00Z', merge_commit_sha: SHA } : [])
    expect(await merged.poll('o/r', 41)).toMatchObject({ merged: true, reviewed: false, mergeCommitSha: SHA, mergedAt: Date.parse('2026-09-20T10:00:00Z') })
    const open = manager((_m, path) => path.endsWith('/pulls/41') ? { html_url: PR_URL, state: 'open', draft: false, merged: false, merged_at: null, merge_commit_sha: 'tmp' } : [{ id: 1 }])
    expect(await open.poll('o/r', 41)).toMatchObject({ merged: false, reviewed: true, mergeCommitSha: null, mergedAt: null })
  })

  it('closingIssues：只收形状完整的节点；GitHub 没返回 PR（错误或不存在）就抛错，由巡查这一轮跳过', async () => {
    const ok = manager((m, path) => {
      if (m === 'POST' && path === '/graphql') return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [
        { number: 7, url: ISSUE_URL, repository: { nameWithOwner: 'o/r' } },
        { number: 'x', url: 'https://github.com/o/r/issues/8', repository: { nameWithOwner: 'o/r' } },
        { number: 9, url: '', repository: { nameWithOwner: 'o/r' } },
        null,
      ] } } } } }
      return []
    })
    expect(await ok.closingIssues('o/r', 41)).toEqual([{ repo: 'o/r', number: 7, url: ISSUE_URL }])
    const missing = manager(() => ({ data: { repository: { pullRequest: null } }, errors: [{ message: 'Could not resolve' }] }))
    await expect(missing.closingIssues('o/r', 41)).rejects.toThrow('读不到')
  })
})
