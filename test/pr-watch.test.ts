/**
 * 盯住自己开的 PR。
 *
 * Friday 的常驻网关通过轮询跟进 PR 状态。
 *
 * 说五种话、不说第六种：
 * - 已合并 / 被关掉：说。事情结了，不说人不知道。
 * - 就绪太久没人 review：说。这正是"提了 PR 然后石沉大海"的那个洞。
 * - 第一档提醒过之后还是没人看、就绪满第二档阈值：升级一次，提醒对象换成空间负责人。
 * - 合并之后进了某个发布版本：说一次"已进入 vX"——合并不等于发布，这句才是发布。
 * - 就绪本身：**不说**。那是模型刚调完 github_pr_ready 在对话里说过的，这里再说一遍是复读。
 *
 * 每种话对每个 PR 只说一次，靠账本保证——不是靠记得，是靠写下来。
 */
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { PrWatch, type PrSnapshot, type ReleaseHit, type WatchedChange } from '../src/core/pr-watch.js'

const HOUR = 3600_000
const DAY = 24 * HOUR
const RELEASE: ReleaseHit = { tag: '0.1.6', url: 'https://github.com/x/y/releases/tag/0.1.6', publishedAt: '2026-09-20T00:00:00Z', prerelease: false }

function setup(now = 1_000_000) {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE github_changes (
    id TEXT PRIMARY KEY, session_key TEXT, requester_open_id TEXT, repo TEXT,
    pr_number INTEGER, pr_url TEXT, updated_at INTEGER)`)
  let clock = now
  const watch = new PrWatch(db, () => clock)
  const add = (id: string, prNumber: number | null) =>
    db.prepare('INSERT INTO github_changes VALUES (?,?,?,?,?,?,?)')
      .run(id, 's', 'ou_alice', 'ZhixingLu/dsh-visualizer-benchmark', prNumber, null, clock)
  return { db, watch, add, at: (ms: number) => { clock = ms }, now: () => clock }
}

const CHANGE: WatchedChange = {
  id: 'chg_1', sessionKey: 's', requesterOpenId: 'ou_alice',
  repo: 'ZhixingLu/dsh-visualizer-benchmark', prNumber: 4399, prUrl: 'https://github.com/x/y/pull/4399',
}

function snap(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return { merged: false, closed: false, draft: false, reviewed: false, url: 'https://github.com/x/y/pull/4399', ...over }
}

describe('盯哪些 PR', () => {
  it('只盯自己开过 PR 的那些；没有编号的不盯', () => {
    const t = setup()
    t.add('chg_1', 4399)
    t.add('chg_2', null)
    expect(t.watch.pending().map((c) => c.id)).toEqual(['chg_1'])
  })

  it('说过"被关掉"之后就不再盯', () => {
    const t = setup()
    t.add('chg_1', 4399)
    t.watch.claim('chg_1', 'closed')
    expect(t.watch.pending()).toEqual([])
  })

  it('说过"已合并"之后还要盯——要等它进发布版本', () => {
    const t = setup()
    t.add('chg_1', 4399)
    t.watch.claim('chg_1', 'merged')
    expect(t.watch.pending().map((c) => c.id)).toEqual(['chg_1'])
  })

  it('说过"已进入发布版本"之后不再盯', () => {
    const t = setup()
    t.add('chg_1', 4399)
    t.watch.claim('chg_1', 'merged')
    t.watch.claim('chg_1', 'released')
    expect(t.watch.pending()).toEqual([])
  })

  it('合并提醒过之后过了盯发布的窗口（默认 30 天）还没进版本，不再盯', () => {
    const t = setup()
    t.add('chg_1', 4399)
    t.watch.claim('chg_1', 'merged')
    t.at(1_000_000 + 29 * DAY)
    expect(t.watch.pending().map((c) => c.id)).toEqual(['chg_1'])
    t.at(1_000_000 + 31 * DAY)
    expect(t.watch.pending()).toEqual([])
    // 窗口可以调：传 0 = 合并提醒过就不再盯
    expect(t.watch.pending(50, 0)).toEqual([])
  })

  it('说过"就绪太久"不影响继续盯——它还没结束', () => {
    const t = setup()
    t.add('chg_1', 4399)
    t.watch.claim('chg_1', 'review_overdue')
    expect(t.watch.pending().map((c) => c.id)).toEqual(['chg_1'])
  })
})

describe('该说哪一句', () => {
  it('合并了就说一声，并且提醒合并不等于发布', () => {
    const t = setup()
    const notice = t.watch.decide(CHANGE, snap({ merged: true }), 12 * HOUR)
    expect(notice?.kind).toBe('merged')
    expect(notice?.text).toContain('已合并')
    expect(notice?.text).toContain('合并不等于发布')
  })

  it('被关掉且没合并，说的是"没有合并"，不含糊成已完成', () => {
    const t = setup()
    const notice = t.watch.decide(CHANGE, snap({ closed: true }), 12 * HOUR)
    expect(notice?.kind).toBe('closed')
    expect(notice?.text).toContain('没有合并')
  })

  it('还是 draft 就什么都不说——本来就没人该看', () => {
    const t = setup()
    expect(t.watch.decide(CHANGE, snap({ draft: true }), 12 * HOUR)).toBeUndefined()
  })

  it('刚就绪不催；到点了才催一次，并说清楚等了多久', () => {
    const t = setup()
    expect(t.watch.decide(CHANGE, snap(), 12 * HOUR)).toBeUndefined()
    t.at(1_000_000 + 13 * HOUR)
    const notice = t.watch.decide(CHANGE, snap(), 12 * HOUR)
    expect(notice?.kind).toBe('review_overdue')
    expect(notice?.text).toContain('13 小时')
    expect(notice?.text).toContain('还没有人 review')
  })

  it('已经有人 review 了就不催', () => {
    const t = setup()
    t.watch.decide(CHANGE, snap(), 12 * HOUR)
    t.at(1_000_000 + 99 * HOUR)
    expect(t.watch.decide(CHANGE, snap({ reviewed: true }), 12 * HOUR)).toBeUndefined()
  })

  it('催过一次就不再催——不是每轮都提醒', () => {
    const t = setup()
    t.watch.decide(CHANGE, snap(), 12 * HOUR)
    t.at(1_000_000 + 13 * HOUR)
    expect(t.watch.decide(CHANGE, snap(), 12 * HOUR)?.kind).toBe('review_overdue')
    t.watch.claim('chg_1', 'review_overdue')
    t.at(1_000_000 + 99 * HOUR)
    expect(t.watch.decide(CHANGE, snap(), 12 * HOUR)).toBeUndefined()
  })

  it('阈值设成 0 是**关掉**，不是立刻催', () => {
    // 0 在配置里一向是"不做"。读成"马上做"，会让一个想关掉它的人收到最吵的结果。
    const t = setup()
    t.at(1_000_000 + 999 * HOUR)
    expect(t.watch.decide(CHANGE, snap(), 0)).toBeUndefined()
  })

  it('就绪起算用的是"我第一次看见"，措辞上也照实说', () => {
    const t = setup()
    t.watch.decide(CHANGE, snap(), 12 * HOUR) // 第一次看见就绪
    t.at(1_000_000 + 20 * HOUR)
    const notice = t.watch.decide(CHANGE, snap(), 12 * HOUR)
    expect(notice?.text).toContain('20 小时')
  })

  it('合并优先于"就绪太久"：结了就说结了，不再催 review', () => {
    const t = setup()
    t.watch.decide(CHANGE, snap(), 12 * HOUR)
    t.at(1_000_000 + 99 * HOUR)
    expect(t.watch.decide(CHANGE, snap({ merged: true }), 12 * HOUR)?.kind).toBe('merged')
  })
})

describe('每种话只说一次，靠写下来而不是靠记得', () => {
  it('先占位再发：占不到就不发', () => {
    const t = setup()
    expect(t.watch.claim('chg_1', 'merged')).toBe(true)
    expect(t.watch.claim('chg_1', 'merged')).toBe(false)
  })

  it('不同的话各占各的位', () => {
    const t = setup()
    expect(t.watch.claim('chg_1', 'merged')).toBe(true)
    expect(t.watch.claim('chg_1', 'closed')).toBe(true)
  })

  it('占了位之后 decide 就不再产出同一句', () => {
    const t = setup()
    t.watch.claim('chg_1', 'merged')
    expect(t.watch.decide(CHANGE, snap({ merged: true }), 12 * HOUR)).toBeUndefined()
  })
})

describe('review 超时分档：第二档升级给空间负责人', () => {
  it('第一档提醒过、就绪满第二档阈值，升级一次', () => {
    const t = setup()
    t.watch.decide(CHANGE, snap(), 12 * HOUR)
    t.at(1_000_000 + 13 * HOUR)
    expect(t.watch.decide(CHANGE, snap(), 12 * HOUR, { escalateMs: 48 * HOUR })?.kind).toBe('review_overdue')
    t.watch.claim('chg_1', 'review_overdue')
    t.at(1_000_000 + 47 * HOUR)
    expect(t.watch.decide(CHANGE, snap(), 12 * HOUR, { escalateMs: 48 * HOUR })).toBeUndefined()
    t.at(1_000_000 + 49 * HOUR)
    const notice = t.watch.decide(CHANGE, snap(), 12 * HOUR, { escalateMs: 48 * HOUR })
    expect(notice?.kind).toBe('review_escalated')
    expect(notice?.text).toContain('49 小时')
    expect(notice?.text).toContain('负责人')
    expect(notice?.text).toContain(CHANGE.prUrl)
  })

  it('第一档还没提醒过就不升级——先说第一档', () => {
    const t = setup()
    t.watch.decide(CHANGE, snap(), 12 * HOUR)
    t.at(1_000_000 + 49 * HOUR)
    expect(t.watch.decide(CHANGE, snap(), 12 * HOUR, { escalateMs: 48 * HOUR })?.kind).toBe('review_overdue')
  })

  it('第二档阈值 0 = 关掉升级，不是立刻升级', () => {
    const t = setup()
    t.watch.decide(CHANGE, snap(), 12 * HOUR)
    t.watch.claim('chg_1', 'review_overdue')
    t.at(1_000_000 + 999 * HOUR)
    expect(t.watch.decide(CHANGE, snap(), 12 * HOUR, { escalateMs: 0 })).toBeUndefined()
    // 没传第二档 = 不升级
    expect(t.watch.decide(CHANGE, snap(), 12 * HOUR)).toBeUndefined()
  })

  it('升级过一次就不再升级', () => {
    const t = setup()
    t.watch.decide(CHANGE, snap(), 12 * HOUR)
    t.watch.claim('chg_1', 'review_overdue')
    t.at(1_000_000 + 49 * HOUR)
    expect(t.watch.decide(CHANGE, snap(), 12 * HOUR, { escalateMs: 48 * HOUR })?.kind).toBe('review_escalated')
    t.watch.claim('chg_1', 'review_escalated')
    t.at(1_000_000 + 200 * HOUR)
    expect(t.watch.decide(CHANGE, snap(), 12 * HOUR, { escalateMs: 48 * HOUR })).toBeUndefined()
  })

  it('有人 review 了就不升级；第一档关掉（0）时也不升级', () => {
    const t = setup()
    t.watch.decide(CHANGE, snap(), 12 * HOUR)
    t.watch.claim('chg_1', 'review_overdue')
    t.at(1_000_000 + 49 * HOUR)
    expect(t.watch.decide(CHANGE, snap({ reviewed: true }), 12 * HOUR, { escalateMs: 48 * HOUR })).toBeUndefined()
    expect(t.watch.decide(CHANGE, snap(), 0, { escalateMs: 48 * HOUR })).toBeUndefined()
  })
})

describe('进入发布版本：合并之后再说一次"已进入 vX"', () => {
  it('合并提醒过、某个发布版本包含它，说一次"已进入"，带版本和链接', () => {
    const t = setup()
    t.watch.claim('chg_1', 'merged')
    const notice = t.watch.decide(CHANGE, snap({ merged: true }), 12 * HOUR, { release: RELEASE })
    expect(notice?.kind).toBe('released')
    expect(notice?.text).toContain('已进入 0.1.6')
    expect(notice?.text).toContain(RELEASE.url)
    expect(notice?.release).toEqual(RELEASE)
  })

  it('合并还没提醒过时先说合并，这一轮不说进入发布', () => {
    const t = setup()
    expect(t.watch.decide(CHANGE, snap({ merged: true }), 12 * HOUR, { release: RELEASE })?.kind).toBe('merged')
  })

  it('没有发布版本包含它时什么都不说', () => {
    const t = setup()
    t.watch.claim('chg_1', 'merged')
    expect(t.watch.decide(CHANGE, snap({ merged: true }), 12 * HOUR, { release: null })).toBeUndefined()
    expect(t.watch.decide(CHANGE, snap({ merged: true }), 12 * HOUR)).toBeUndefined()
  })

  it('预览版也算进入，但要标出来', () => {
    const t = setup()
    t.watch.claim('chg_1', 'merged')
    const notice = t.watch.decide(CHANGE, snap({ merged: true }), 12 * HOUR, { release: { ...RELEASE, tag: '0.1.7-alpha.1', prerelease: true } })
    expect(notice?.text).toContain('0.1.7-alpha.1')
    expect(notice?.text).toContain('预览版')
  })

  it('说过"已进入"就不再说——换一个 PrWatch 实例（重启）读同一账本也一样', () => {
    const t = setup()
    t.watch.claim('chg_1', 'merged')
    expect(t.watch.decide(CHANGE, snap({ merged: true }), 12 * HOUR, { release: RELEASE })?.kind).toBe('released')
    t.watch.claim('chg_1', 'released')
    expect(t.watch.decide(CHANGE, snap({ merged: true }), 12 * HOUR, { release: RELEASE })).toBeUndefined()
    const restarted = new PrWatch(t.db, t.now)
    expect(restarted.decide(CHANGE, snap({ merged: true }), 12 * HOUR, { release: RELEASE })).toBeUndefined()
    expect(restarted.said('chg_1', 'released')).toBe(true)
  })

  it('只在合并提醒过、还没说进入发布时才值得去查 release', () => {
    const t = setup()
    expect(t.watch.needsReleaseCheck(CHANGE, snap())).toBe(false)
    expect(t.watch.needsReleaseCheck(CHANGE, snap({ merged: true }))).toBe(false) // 合并这句还没说
    t.watch.claim('chg_1', 'merged')
    expect(t.watch.needsReleaseCheck(CHANGE, snap({ merged: true }))).toBe(true)
    t.watch.claim('chg_1', 'released')
    expect(t.watch.needsReleaseCheck(CHANGE, snap({ merged: true }))).toBe(false)
  })
})
