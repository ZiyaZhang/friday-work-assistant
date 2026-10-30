/**
 * 收件箱（等人拍板的事，蹭已有对话捎带）、静默时段、沿用最近配置。
 */
import { describe, expect, it } from 'vitest'
import { Inbox, MAX_NUDGES, NUDGE_COOLDOWN_MS, NUDGE_DELAY_MS } from '../src/core/inbox.js'
import { withinHours } from '../src/core/proactive.js'
import { Spaces } from '../src/core/space.js'
import { Circles } from '../src/core/circles.js'
import { Registry } from '../src/core/registry.js'

const T = Date.parse('2026-09-19T00:00:00+08:00')

describe('收件箱', () => {
  function box() {
    return new Inbox(new Registry(':memory:').db)
  }

  it('同一个提案登记两次还是一条', () => {
    const b = box()
    const a = b.add({ ownerOpenId: 'ou_a', kind: 'responsibility', refId: 7, title: '每天核对发布清单', now: T })
    const again = b.add({ ownerOpenId: 'ou_a', kind: 'responsibility', refId: 7, title: '换了个说法', now: T })
    expect(again.id).toBe(a.id)
    expect(b.pending('ou_a')).toHaveLength(1)
  })

  it('群里只捎带本空间的事：私聊里攒的不往群里贴', () => {
    const b = box()
    b.add({ ownerOpenId: 'ou_a', kind: 'responsibility', refId: 1, spaceId: 'sp_group', title: '本群的事', now: T })
    b.add({ ownerOpenId: 'ou_a', kind: 'auth', refId: 2, spaceId: 'sp_dm_ou_a', title: '别处的盯群授权到期', now: T })
    const later = T + NUDGE_DELAY_MS + 1
    // 私聊里：他自己的事全都能捎
    expect(b.dueFor('ou_a', later)).toHaveLength(2)
    // 在群里：只捎这个群里产生的那件
    const inGroup = b.dueFor('ou_a', later, { spaceId: 'sp_group' })
    expect(inGroup).toHaveLength(1)
    expect(inGroup[0]?.title).toBe('本群的事')
  })

  it('刚建出来不立刻催——答完上一句就催人太急', () => {
    const b = box()
    b.add({ ownerOpenId: 'ou_a', kind: 'skill', refId: 1, title: 'x', now: T })
    expect(b.dueFor('ou_a', T + 60_000)).toHaveLength(0)
    expect(b.dueFor('ou_a', T + NUDGE_DELAY_MS + 1)).toHaveLength(1)
  })

  it('捎带过之后要隔一段时间才再提', () => {
    const b = box()
    const it1 = b.add({ ownerOpenId: 'ou_a', kind: 'skill', refId: 1, title: 'x', now: T })
    const t1 = T + NUDGE_DELAY_MS + 1
    b.markNudged([it1.id], t1)
    expect(b.dueFor('ou_a', t1 + 60_000)).toHaveLength(0)
    expect(b.dueFor('ou_a', t1 + NUDGE_COOLDOWN_MS + 1)).toHaveLength(1)
  })

  it('提过三次就不再提了——他就是不想理', () => {
    const b = box()
    const x = b.add({ ownerOpenId: 'ou_a', kind: 'skill', refId: 1, title: 'x', now: T })
    let t = T + NUDGE_DELAY_MS + 1
    for (let i = 0; i < MAX_NUDGES; i += 1) {
      expect(b.dueFor('ou_a', t)).toHaveLength(1)
      b.markNudged([x.id], t)
      t += NUDGE_COOLDOWN_MS + 1
    }
    expect(b.dueFor('ou_a', t)).toHaveLength(0)
  })

  it('dueFor 只读不记账：答案没发出去就不该算提过', () => {
    const b = box()
    b.add({ ownerOpenId: 'ou_a', kind: 'skill', refId: 1, title: 'x', now: T })
    const t = T + NUDGE_DELAY_MS + 1
    b.dueFor('ou_a', t)
    b.dueFor('ou_a', t)
    expect(b.pending('ou_a')[0]?.nudges).toBe(0)
  })

  it('处理掉之后就不再出现', () => {
    const b = box()
    b.add({ ownerOpenId: 'ou_a', kind: 'responsibility', refId: 9, title: 'x', now: T })
    expect(b.resolve('responsibility', 9)).toBe(true)
    expect(b.pending('ou_a')).toHaveLength(0)
    expect(b.dueFor('ou_a', T + 86400_000)).toHaveLength(0)
  })

  it('捎带的那句话短、且不喧宾夺主', () => {
    const b = box()
    const a = b.add({ ownerOpenId: 'ou_a', kind: 'responsibility', refId: 1, title: '每天核对发布清单', why: '连着三周有人问同一件事', now: T })
    const line = Inbox.renderNudge([a])
    expect(line).toContain('一件事等你拍板')
    expect(line).toContain('每天核对发布清单')
    expect(line.split('\n').length).toBeLessThan(8)
  })

  it('没有待办就什么都不加', () => {
    expect(Inbox.renderNudge([])).toBe('')
  })
})

describe('主动发言的时段', () => {
  const tz = 8 * 60
  const at = (h: number) => Date.parse(`2026-09-19T${String(h).padStart(2, '0')}:30:00+08:00`)

  it('没配就是全天', () => {
    expect(withinHours(undefined, at(3), tz)).toBe(true)
  })

  it('白天段：内外分明', () => {
    expect(withinHours({ from: 9, to: 21 }, at(10), tz)).toBe(true)
    expect(withinHours({ from: 9, to: 21 }, at(3), tz)).toBe(false)
    expect(withinHours({ from: 9, to: 21 }, at(21), tz)).toBe(false)
    expect(withinHours({ from: 9, to: 21 }, at(9), tz)).toBe(true)
  })

  it('跨零点的区间也对', () => {
    expect(withinHours({ from: 22, to: 7 }, at(23), tz)).toBe(true)
    expect(withinHours({ from: 22, to: 7 }, at(3), tz)).toBe(true)
    expect(withinHours({ from: 22, to: 7 }, at(12), tz)).toBe(false)
  })

  it('起止相同当没配，不会把自己锁死', () => {
    expect(withinHours({ from: 9, to: 9 }, at(3), tz)).toBe(true)
  })
})

describe('沿用最近配置', () => {
  function spaces() {
    const db = new Registry(':memory:').db
    new Circles(db)
    return new Spaces(db)
  }

  it('配过一次，下一个空间自动套用，不用再问一遍', () => {
    const sp = spaces()
    const a = sp.ensure({ kind: 'group', chatId: 'oc_1', openId: 'ou_a' })
    sp.patchConfig(a.id, { brevity: 'short' }, 'ou_a')
    const b = sp.ensure({ kind: 'group', chatId: 'oc_2', openId: 'ou_a' })
    expect(b.config.brevity).toBe('short')
  })

  it('别人的默认不会串到你头上', () => {
    const sp = spaces()
    const a = sp.ensure({ kind: 'group', chatId: 'oc_1', openId: 'ou_a' })
    sp.patchConfig(a.id, { brevity: 'short' }, 'ou_a')
    const b = sp.ensure({ kind: 'group', chatId: 'oc_2', openId: 'ou_b' })
    expect(b.config.brevity).toBeUndefined()
  })

  it('repos 这种权限开关不跟着走——权限必须每个空间单独给', () => {
    const sp = spaces()
    const a = sp.ensure({ kind: 'group', chatId: 'oc_1', openId: 'ou_a' })
    sp.patchConfig(a.id, { repos: true, brevity: 'detailed' }, 'ou_a')
    const b = sp.ensure({ kind: 'group', chatId: 'oc_2', openId: 'ou_a' })
    expect(b.config.repos).toBeUndefined()
    expect(b.config.brevity).toBe('detailed')
  })
})
