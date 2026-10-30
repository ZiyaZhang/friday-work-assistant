/**
 * 没人接的 issue，问一句。
 *
 * 排期里这条写的是「一天无人认领 + 无关联 PR + 允许名单 + 接单规则」。
 * 但「无人认领」这四个字最容易做错：assignee 是空的不等于没人在做——
 * 有人在评论里说了「我来」，有人已经开了分支，都不会体现在 assignee 上。
 * 照着空字段去接单，是从同事手里抢活。
 *
 * 所以这里**不判断"没人认领"**，只判断"值不值得问一句"，然后把看得见的事实摆出来让人定。
 * Friday 也不会自己去认领——它问，人定。
 *
 * 另一条是为了绑定当天不炸群：只看**在我盯着的这段时间里安静下来**的。
 * 一个仓库积压两百条陈年 issue，绑定那一刻全播一遍，这功能第一次就被关掉了。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IssueWatch, type IssueSnapshot, type IssueWatchBinding } from '../src/core/issue-watch.js'
import type { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { Inbox } from '../src/core/inbox.js'

const DAY = 24 * 3600_000
const NOW = 1_800_000_000_000
const SINCE = NOW - 30 * DAY

function setup(now = NOW) {
  const db = new DatabaseSync(':memory:')
  let clock = now
  return { watch: new IssueWatch(db, () => clock), at: (t: number) => { clock = t } }
}

const BINDING: IssueWatchBinding = { spaceId: 'sp_a', boundBy: 'ou_alice', repo: 'org/demo', since: SINCE, labels: [] }

function issue(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    number: 7, title: '插件页加载慢', url: 'https://github.com/org/demo/issues/7',
    isPullRequest: false, state: 'open', assignees: [], labels: [],
    createdAt: NOW - 10 * DAY, updatedAt: NOW - 5 * DAY, linkedPullRequests: 0,
    ...over,
  }
}

describe('哪些 issue 值得问一句', () => {
  it('开着、没 assignee、没关联 PR、安静够久的，问', () => {
    const t = setup()
    const { notice } = t.watch.decide(BINDING, issue(), DAY)
    expect(notice?.number).toBe(7)
    expect(notice?.text).toContain('插件页加载慢')
  })

  it('PR 也会从 /issues 出来，必须认出来——否则它会对着自己刚开的 PR 问"这个没人接吗"', () => {
    const t = setup()
    expect(t.watch.decide(BINDING, issue({ isPullRequest: true }), DAY).skip).toBe('pull_request')
  })

  it('已经关掉的不问', () => {
    const t = setup()
    expect(t.watch.decide(BINDING, issue({ state: 'closed' }), DAY).skip).toBe('closed')
  })

  it('有人认领了就不问', () => {
    const t = setup()
    expect(t.watch.decide(BINDING, issue({ assignees: ['bob'] }), DAY).skip).toBe('assigned')
  })

  it('已经有 PR 在做就不问——那正是"有人在做"最硬的证据', () => {
    const t = setup()
    expect(t.watch.decide(BINDING, issue({ linkedPullRequests: 1 }), DAY).skip).toBe('linked_pr')
  })

  it('刚有人说过话的不问', () => {
    const t = setup()
    expect(t.watch.decide(BINDING, issue({ lastCommentAt: NOW - 3600_000 }), DAY).skip).toBe('too_fresh')
  })

  it('Friday 自己上一次的留言不算"有人在跟进"', () => {
    // 不排掉的话，它问完一句就把自己那句当成有人接了，从此再也不提。
    const t = setup()
    const { notice } = t.watch.decide(BINDING, issue({ lastCommentAt: NOW - 5 * DAY, lastCommentByBot: true }), DAY)
    expect(notice).toBeTruthy()
  })
})

describe('后台扫描不能跨过停止和授权边界', () => {
  const registries: Registry[] = []
  const closes: (() => Promise<void>)[] = []
  afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const r of registries.splice(0)) r.close() })

  function setupSweep() {
    const registry = new Registry(':memory:')
    registries.push(registry)
    const home = mkdtempSync(join(tmpdir(), 'friday-issue-watch-test-'))
    const cfg = loadConfig({ FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test', FRIDAY_REFLECT: 'off', FRIDAY_HOME: home })
    const sp = spaceDeps(registry.db)
    const space = sp.spaces.ensure({ kind: 'group', chatId: 'safe-test-group', openId: 'alice' })
    const binding: IssueWatchBinding = { ...BINDING, spaceId: space.id, boundBy: 'alice', version: 'original' }
    registry.setKv(`issue-watch:${space.id}`, JSON.stringify(binding))
    const raw = {
      number: 7, title: '加载慢', html_url: 'https://github.com/org/demo/issues/7', state: 'open',
      assignees: [], labels: [], created_at: new Date(NOW - 10 * DAY).toISOString(),
      updated_at: new Date(NOW - 5 * DAY).toISOString(), comments: 0, body: '这是提出者仍待核实的合成问题正文。', user: { login: 'reporter' },
    }
    const api = vi.fn(async (_method: string, path: string): Promise<unknown> => {
      if (path.includes('/timeline')) return []
      if (path.includes('/comments')) return []
      if (/\/issues\/\d+$/.test(path)) return { ...raw, number: Number(path.split('/').at(-1)) }
      return [raw]
    })
    const github = { api, botLogin: async () => 'friday-bot', repoAllowed: () => true } as unknown as GitHubIdentity
    const watch = new IssueWatch(registry.db, () => NOW)
    const feishu = new FakeFeishu()
    feishu.members.set('safe-test-group', new Set(['alice']))
    const execution = managedHostRuntime(registry, home, createLogger('issue-watch-test', 'error'))
    execution.peer.state.script = [{ kind: 'text', text: JSON.stringify({ verdict: 'ask', evidence: [{ ref: 'body', quote: raw.body }] }) }]
    closes.push(async () => { await execution.runtime.stop(); rmSync(home, { recursive: true, force: true }) })
    const orchestrator = new Orchestrator({
      cfg, registry, ...sp, issueWatch: watch, github, inbox: new Inbox(registry.db), now: () => NOW,
      feishu: asFeishuClient(feishu), runtime: execution.runtime, managed: execution.managed,
      memory: new ChannelMemory(registry.db), tokens: new TokenIssuer('test'),
      apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/unused', botOpenId: 'bot',
      log: createLogger('issue-watch-test', 'error'),
    })
    return { registry, ...sp, space, binding, raw, api, watch, feishu, orchestrator }
  }

  it.each(['disabled', 'suspended', 'owner_removed', 'rebound'] as const)('扫描等待期间 %s，返回的旧结果不占位也不发消息', async (change) => {
    const t = setupSweep()
    let finish!: (rows: unknown[]) => void
    t.api.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = t.orchestrator.sweepIssues(DAY)
    if (change === 'disabled') t.registry.setKv(`issue-watch:${t.space.id}`, '')
    if (change === 'suspended') t.spaces.suspend(t.space.id)
    if (change === 'owner_removed') t.spaces.removeMember(t.space.id, 'alice')
    if (change === 'rebound') {
      t.registry.setKv(`issue-watch:${t.space.id}`, '')
      t.registry.setKv(`issue-watch:${t.space.id}`, JSON.stringify({ ...t.binding, version: 'new-binding' }))
    }
    finish([t.raw])
    expect(await pending).toBe(0)
    expect(t.feishu.sent).toHaveLength(0)
    expect(t.watch.asked(t.space.id, t.binding.repo, 7)).toBe(false)
  })

  it('第一条发送等待期间停用，不发送扫描里已经算出的第二条', async () => {
    const t = setupSweep()
    t.api.mockImplementationOnce(async () => [t.raw, { ...t.raw, number: 8 }])
    const send = t.feishu.sendToChat.bind(t.feishu)
    vi.spyOn(t.feishu, 'sendToChat').mockImplementationOnce(async (...args) => {
      t.registry.setKv(`issue-watch:${t.space.id}`, '')
      return send(...args)
    })
    expect(await t.orchestrator.sweepIssues(DAY)).toBe(0)
    expect(t.feishu.sent).toHaveLength(1)
    expect(t.watch.asked(t.space.id, t.binding.repo, 8)).toBe(false)
  })

  it('没有停止时正常发出一次，发送回执丢失也不重发', async () => {
    const t = setupSweep()
    const send = t.feishu.sendToChat.bind(t.feishu)
    vi.spyOn(t.feishu, 'sendToChat').mockImplementationOnce(async (...args) => {
      await send(...args)
      throw new Error('receipt lost')
    })
    expect(await t.orchestrator.sweepIssues(DAY)).toBe(0)
    expect(await t.orchestrator.sweepIssues(DAY)).toBe(0)
    expect(t.feishu.sent).toHaveLength(1)
  })

  it('每次发送都丢回执时，也不能突破每轮最多两条的打扰上限', async () => {
    const t = setupSweep()
    t.api.mockImplementationOnce(async () => [t.raw, { ...t.raw, number: 8 }, { ...t.raw, number: 9 }])
    const send = t.feishu.sendToChat.bind(t.feishu)
    vi.spyOn(t.feishu, 'sendToChat').mockImplementation(async (...args) => {
      await send(...args)
      throw new Error('receipt lost')
    })
    expect(await t.orchestrator.sweepIssues(DAY)).toBe(0)
    expect(t.feishu.sent).toHaveLength(2)
    expect(t.watch.asked(t.space.id, t.binding.repo, 9)).toBe(false)
  })
})

describe('绑定当天不炸群', () => {
  it('绑定之前就沉寂的陈年 issue 不翻出来', () => {
    // 积压两百条的仓库，绑定那一刻全播一遍，这个功能第一次就被用废了。
    const t = setup()
    const old = issue({ createdAt: SINCE - 100 * DAY, updatedAt: SINCE - 50 * DAY })
    expect(t.watch.decide(BINDING, old, DAY).skip).toBe('quiet_before_watch')
  })

  it('但有人在老 issue 下留了新评论，它就重新进入视野', () => {
    const t = setup()
    const revived = issue({ createdAt: SINCE - 100 * DAY, updatedAt: SINCE - 50 * DAY, lastCommentAt: NOW - 5 * DAY })
    expect(t.watch.decide(BINDING, revived, DAY).notice).toBeTruthy()
  })
})

describe('接单规则：标签', () => {
  it('配了标签就只看带这些标签的', () => {
    const t = setup()
    const bound = { ...BINDING, labels: ['bug'] }
    expect(t.watch.decide(bound, issue({ labels: ['docs'] }), DAY).skip).toBe('label_mismatch')
    expect(t.watch.decide(bound, issue({ labels: ['bug'] }), DAY).notice).toBeTruthy()
  })

  it('不配标签就不限', () => {
    const t = setup()
    expect(t.watch.decide(BINDING, issue({ labels: [] }), DAY).notice).toBeTruthy()
  })
})

describe('阈值 0 是关掉，不是立刻问', () => {
  it('0 表示不做——把它读成"马上做"，会让一个想关掉它的人收到最吵的结果', () => {
    const t = setup()
    expect(t.watch.decide(BINDING, issue(), 0).skip).toBe('watch_disabled')
  })
})

describe('每条只问一次，靠写下来而不是靠记得', () => {
  it('先占位再发：占不到就不发', () => {
    const t = setup()
    expect(t.watch.claim('sp_a', 'org/demo', 7)).toBe(true)
    expect(t.watch.claim('sp_a', 'org/demo', 7)).toBe(false)
  })

  it('问过之后 decide 不再产出同一条', () => {
    const t = setup()
    t.watch.claim('sp_a', 'org/demo', 7)
    expect(t.watch.decide(BINDING, issue(), DAY).skip).toBe('already_asked')
  })

  it('不同空间各问各的——两个群盯同一个仓库，各自都该知道', () => {
    const t = setup()
    expect(t.watch.claim('sp_a', 'org/demo', 7)).toBe(true)
    expect(t.watch.claim('sp_b', 'org/demo', 7)).toBe(true)
  })
})

describe('说出来的每一句都要能指着一个事实', () => {
  it('只摆看得见的，不下"没人认领"这个结论', () => {
    // 有人在评论里说过"我来"是看不出来的；替人下这个结论就是从同事手里抢活。
    const t = setup()
    const { notice } = t.watch.decide(BINDING, issue(), DAY)
    expect(notice!.text).toContain('没有 assignee')
    expect(notice!.text).toContain('没有关联 PR')
    expect(notice!.text).not.toContain('没人认领')
  })

  it('一条评论都没有时就直说一条都没有，不编个天数', () => {
    const t = setup()
    expect(t.watch.decide(BINDING, issue(), DAY).notice!.text).toContain('一条评论都没有')
  })

  it('有评论时说清楚上次有人说话是多久以前', () => {
    const t = setup()
    const { notice } = t.watch.decide(BINDING, issue({ lastCommentAt: NOW - 6 * DAY }), DAY)
    expect(notice!.text).toContain('6 天前')
  })

  it('问的是"要我接吗"，不是"我接了"', () => {
    const t = setup()
    const { notice } = t.watch.decide(BINDING, issue(), DAY)
    expect(notice!.text).toContain('要我接就说一声')
  })
})

describe('有人说话 / 有人接手 / 事情解决，是三件事', () => {
  /**
   * 审计里的原话：主动跟进会误把事情当成解决了。
   *
   * 根在这里：以前这三件事在代码里长得一模一样——都只是 skip。
   * 没有区别就意味着，谁在底下回一句「我也遇到了」，Friday 就当这件事有人管了。
   */
  it('有人接手（assignee）是终局：不问', () => {
    const t = setup()
    expect(t.watch.decide(BINDING, issue({ assignees: ['bob'] }), DAY).skip).toBe('assigned')
  })

  it('有人接手（已经有 PR）也是终局：不问', () => {
    const t = setup()
    expect(t.watch.decide(BINDING, issue({ linkedPullRequests: 1 }), DAY).skip).toBe('linked_pr')
  })

  it('事情解决（关掉了）是终局：不问', () => {
    const t = setup()
    expect(t.watch.decide(BINDING, issue({ state: 'closed' }), DAY).skip).toBe('closed')
  })

  it('有人说话**不是**终局——它只让安静重新计时，仍然没人接', () => {
    const t = setup()
    // 刚有人说话：先别催
    expect(t.watch.decide(BINDING, issue({ lastCommentAt: NOW - 3600_000 }), DAY).skip).toBe('too_fresh')
    // 说完之后又安静够久：该问还是问
    expect(t.watch.decide(BINDING, issue({ lastCommentAt: NOW - 5 * DAY }), DAY).notice).toBeTruthy()
  })
})

describe('问过一次不是终局', () => {
  /**
   * 原来是问过就永远不再问。听起来克制，实际后果是——有人在底下回了句「我看看」，
   * 然后一个月没动静，Friday 全程沉默，因为它"已经问过了"。
   * 那正好是最该再问一句的情形。
   */
  it('问完之后一点动静都没有，就闭嘴', () => {
    const t = setup()
    t.watch.claim('sp_a', 'org/demo', 7)
    t.at(NOW + 30 * DAY)
    expect(t.watch.decide(BINDING, issue(), DAY).skip).toBe('already_asked')
  })

  it('问完之后有人说了话、然后又安静了一个窗口，再问一次', () => {
    const t = setup()
    t.watch.claim('sp_a', 'org/demo', 7)           // 此刻问过
    t.at(NOW + 10 * DAY)                            // 十天后
    const spoke = issue({ lastCommentAt: NOW + 5 * DAY })  // 中间第 5 天有人说过话
    const { notice } = t.watch.decide(BINDING, spoke, DAY)
    expect(notice).toBeTruthy()
    expect(notice!.again).toBe(true)
  })

  it('再问的时候说清楚中间发生过什么，不是把同一句重复一遍', () => {
    const t = setup()
    t.watch.claim('sp_a', 'org/demo', 7)
    t.at(NOW + 10 * DAY)
    const { notice } = t.watch.decide(BINDING, issue({ lastCommentAt: NOW + 5 * DAY }), DAY)
    expect(notice!.text).toContain('上次问过之后有人说过话，但仍未设置 assignee 或关联 PR')
    expect(notice!.text).not.toContain('没人接')
  })

  it('有人说过话但还没安静够久，不再问', () => {
    const t = setup()
    t.watch.claim('sp_a', 'org/demo', 7)
    t.at(NOW + 10 * DAY)
    expect(t.watch.decide(BINDING, issue({ lastCommentAt: NOW + 10 * DAY - 3600_000 }), DAY).skip).toBe('too_fresh')
  })

  it('中间有人接手了就不再问——那是终局，哪怕之前问过', () => {
    const t = setup()
    t.watch.claim('sp_a', 'org/demo', 7)
    t.at(NOW + 10 * DAY)
    expect(t.watch.decide(BINDING, issue({ lastCommentAt: NOW + 5 * DAY, assignees: ['bob'] }), DAY).skip).toBe('assigned')
  })

  it('第二次占位要能占上——否则算出来该问，却被当成"别人问过了"漏发', () => {
    const t = setup()
    expect(t.watch.claim('sp_a', 'org/demo', 7)).toBe(true)
    expect(t.watch.claim('sp_a', 'org/demo', 7)).toBe(false)          // 第一次那条已经在
    t.at(NOW + 10 * DAY)
    expect(t.watch.claim('sp_a', 'org/demo', 7, { again: true, previousNoticeAt: NOW })).toBe(true)
    // 时间戳真的往前推了，否则下一轮又会立刻判成"该再问"
    expect(t.watch.askedAt('sp_a', 'org/demo', 7)).toBe(NOW + 10 * DAY)
  })

  it('没问过的时候 again 占位不算数——不能凭空造一条"问过"的记录', () => {
    const t = setup()
    expect(t.watch.claim('sp_a', 'org/demo', 99, { again: true, previousNoticeAt: NOW })).toBe(false)
    expect(t.watch.asked('sp_a', 'org/demo', 99)).toBe(false)
  })

  it('Friday 自己的留言不能让它以为"有人说过话"而再问一遍', () => {
    // 不排掉的话，它问完一句、自己在 issue 下面留了言，就会把自己那句当成新事实，
    // 于是无限循环地问下去。
    const t = setup()
    t.watch.claim('sp_a', 'org/demo', 7)
    t.at(NOW + 10 * DAY)
    const onlyBot = issue({ lastCommentAt: NOW + 5 * DAY, lastCommentByBot: true, updatedAt: NOW + 5 * DAY })
    expect(t.watch.decide(BINDING, onlyBot, DAY).skip).toBe('already_asked')
  })

  it('只改标签或标题，没有人新回复，不谎称“有人说过话”再催一次', () => {
    const t = setup()
    t.watch.claim('sp_a', 'org/demo', 7)
    t.at(NOW + 10 * DAY)
    expect(t.watch.decide(BINDING, issue({ updatedAt: NOW + 5 * DAY }), DAY).skip).toBe('already_asked')
  })

  it('两个扫描都判定可以再问，只允许一个原子占位成功', () => {
    const t = setup()
    t.watch.claim('sp_a', 'org/demo', 7)
    t.at(NOW + 10 * DAY)
    const spoke = issue({ lastCommentAt: NOW + 5 * DAY })
    const first = t.watch.decide(BINDING, spoke, DAY).notice!
    const second = t.watch.decide(BINDING, spoke, DAY).notice!
    expect(first.previousNoticeAt).toBe(NOW)
    expect(t.watch.claim('sp_a', 'org/demo', 7, first)).toBe(true)
    expect(t.watch.claim('sp_a', 'org/demo', 7, second)).toBe(false)
    expect(t.watch.decide(BINDING, spoke, DAY).skip).toBe('already_asked')
  })

  it('旧调用方未携带占位版本时拒绝重复通知', () => {
    const t = setup()
    t.watch.claim('sp_a', 'org/demo', 7)
    expect(t.watch.claim('sp_a', 'org/demo', 7, { again: true })).toBe(false)
    expect(t.watch.askedAt('sp_a', 'org/demo', 7)).toBe(NOW)
  })

  it('时钟未前进时也消费旧占位版本，不能多次成功', () => {
    const t = setup()
    t.watch.claim('sp_a', 'org/demo', 7)
    const opts = { again: true, previousNoticeAt: NOW }
    expect(t.watch.claim('sp_a', 'org/demo', 7, opts)).toBe(true)
    expect(t.watch.claim('sp_a', 'org/demo', 7, opts)).toBe(false)
  })
})
