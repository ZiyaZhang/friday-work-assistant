/**
 * PMO 的证据列。
 *
 * PMO 的问题从来不是"有哪些任务"——表里就有。而是这件事**真的在动吗**。
 * 状态字段是人填的，会骗人；证据是挣来的。所以表里多两列：
 * 「Friday 观察」写事实，「风险」是个可筛选的标签，**状态那一列一个字都不碰**。
 *
 * 两条判断值得守住：
 * 1. 写出来的每一句都要能指着一个日期或一个空字段，不写"可能有风险"这种话；
 * 2. 人把风险清掉之后，**底下的事实没变就不许再提起来**——清了又冒出来等于告诉他清了也没用。
 */
import { describe, expect, it } from 'vitest'
import { observe, toFields, toOwnFields, RISK_LABELS } from '../src/core/pmo.js'
import type { Todo } from '../src/core/todos.js'

const DAY = 24 * 3600_000
const NOW = Date.UTC(2026, 8, 22, 4, 0, 0) // 2026-09-22 12:00 +08

function todo(over: Partial<Todo> = {}): Todo {
  return {
    id: 1, scope: 'space:sp_a', kind: 'todo', title: '排查 bad case', detail: null,
    dueMs: null, owner: '陆知行', ownerOpenId: 'ou_alice', status: 'open',
    statusNote: null, statusAt: NOW - DAY, statusBy: null, confirmed: true,
    source: null, createdBy: null, sessionKey: null, createdAt: NOW - 2 * DAY, doneAt: null,
    ...over,
  } as Todo
}

describe('观察只写看得见的事实', () => {
  it('一切正常时什么都不写——没有话说就别说', () => {
    expect(observe(todo(), NOW)).toEqual({ observation: '', risk: '' })
  })

  it('逾期：说清楚截止是哪天、过了几天', () => {
    const r = observe(todo({ dueMs: NOW - 3 * DAY }), NOW)
    expect(r.risk).toBe('已过截止')
    expect(r.observation).toContain('2026/9/19')
    expect(r.observation).toContain('3 天')
  })

  it('没截止的不会被说成逾期', () => {
    expect(observe(todo({ dueMs: null }), NOW).risk).toBe('')
  })

  it('截止还没到不算逾期', () => {
    expect(observe(todo({ dueMs: NOW + 3 * DAY }), NOW).risk).toBe('')
  })

  it('没有负责人就直说没有负责人', () => {
    const r = observe(todo({ owner: null, ownerOpenId: null }), NOW)
    expect(r.risk).toBe('没有负责人')
    expect(r.observation).toContain('没有负责人')
  })

  it('久无进展：说上一次变动是哪天、多少天没动', () => {
    const r = observe(todo({ statusAt: NOW - 12 * DAY }), NOW)
    expect(r.risk).toBe('状态久未更新')
    expect(r.observation).toContain('12 天没变过')
  })

  it('刚动过不算久无进展', () => {
    expect(observe(todo({ statusAt: NOW - 3 * DAY }), NOW).risk).toBe('')
  })

  it('从没变过状态的，按创建时间算', () => {
    const r = observe(todo({ statusAt: null, createdAt: NOW - 30 * DAY }), NOW)
    expect(r.risk).toBe('状态久未更新')
    expect(r.observation).toContain('30 天没变过')
  })

  it('几件事同时成立时都写出来，风险标签取最重的那个', () => {
    const r = observe(todo({ dueMs: NOW - 5 * DAY, owner: null, ownerOpenId: null, statusAt: NOW - 20 * DAY }), NOW)
    expect(r.risk).toBe('已过截止')
    expect(r.observation).toContain('已经过去 5 天')
    expect(r.observation).toContain('没有负责人')
    expect(r.observation).toContain('20 天没变过')
  })

  it.each(['done', 'cancelled'] as const)('%s 的事项不谈风险——它已经结束了', (status) => {
    // 给一件已完成的事标"逾期"，只会让人以为还欠着。
    expect(observe(todo({ status, dueMs: NOW - 99 * DAY }), NOW)).toEqual({ observation: '', risk: '' })
  })

  it('阻塞和待验收仍然谈——它们还没结束', () => {
    expect(observe(todo({ status: 'blocked', dueMs: NOW - 5 * DAY }), NOW).risk).toBe('已过截止')
    expect(observe(todo({ status: 'review', statusAt: NOW - 30 * DAY }), NOW).risk).toBe('状态久未更新')
  })

  it('风险标签只用声明过的那几个，否则在表格里是非法选项', () => {
    const risks = [
      observe(todo({ dueMs: NOW - DAY }), NOW).risk,
      observe(todo({ owner: null, ownerOpenId: null }), NOW).risk,
      observe(todo({ statusAt: NOW - 30 * DAY }), NOW).risk,
    ]
    for (const r of risks) expect(RISK_LABELS as readonly string[]).toContain(r)
  })
})

describe('状态那一列一个字都不碰', () => {
  it('证据列和状态列各写各的', () => {
    const fields = toFields(todo({ status: 'open', dueMs: NOW - 5 * DAY }), '研发群', NOW)
    // Friday 不把"逾期"写进状态，只在自己的列里说事实
    expect(fields['状态']).toBe('进行中')
    expect(fields['风险']).toBe('已过截止')
    expect(String(fields['Friday 观察'])).toContain('已经过去 5 天')
  })
})

describe('人清掉的风险，事实没变就不再提', () => {
  /**
   * 判断依据是"这一行要不要重写"的指纹。观察里带着"N 天没动过"，每天都会变；
   * 算进指纹就成了每天重写一次，人昨天清掉的风险今天又原样冒出来。
   */
  it('只是天数在涨，不触发重写', async () => {
    const { toFields: f } = await import('../src/core/pmo.js')
    const { createHash } = await import('node:crypto')
    const fp = (fields: Record<string, unknown>) => {
      const { 'Friday 观察': _o, ...rest } = fields
      return createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 16)
    }
    const t = todo({ statusAt: NOW - 12 * DAY })
    const day1 = f(t, '研发群', NOW)
    const day2 = f(t, '研发群', NOW + DAY)
    expect(day1['Friday 观察']).not.toBe(day2['Friday 观察']) // 文案确实变了
    expect(fp(day1)).toBe(fp(day2)) // 但不会因此重写整行
  })

  it('底下的事实真变了才重提：风险标签一变，指纹就变', async () => {
    const { createHash } = await import('node:crypto')
    const fp = (fields: Record<string, unknown>) => {
      const { 'Friday 观察': _o, ...rest } = fields
      return createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 16)
    }
    const idle = toFields(todo({ statusAt: NOW - 12 * DAY }), '研发群', NOW)
    const overdue = toFields(todo({ statusAt: NOW - 12 * DAY, dueMs: NOW - DAY }), '研发群', NOW)
    expect(idle['风险']).toBe('状态久未更新')
    expect(overdue['风险']).toBe('已过截止')
    expect(fp(idle)).not.toBe(fp(overdue))
  })
})

describe('人在表里改的东西，不许被覆盖', () => {
  /**
   * 审查里复现出来的：表格里把「已完成 / Bob」改好，下一轮同步又被改回「进行中 / Alice」。
   *
   * 设计写的是按列定权威——事项 / 负责人 / 截止 / 状态归表格，Friday 只读；
   * 观察和风险归 Friday。但同步时写的是**整行**，于是 Friday 把人的修改抹掉了。
   * 这恰恰是 PMO 最不该做的事：它存在的理由就是发现"状态是假的"，
   * 覆盖之后连真的那一版都没了。
   */
  it('更新时只写 Friday 自己那两列', () => {
    const own = toOwnFields(todo({ dueMs: NOW - 5 * DAY }), NOW)
    expect(Object.keys(own).sort()).toEqual(['Friday 观察', '风险'])
  })

  it('尤其不写状态和负责人——那两列是人的', () => {
    const own = toOwnFields(todo({ status: 'open', owner: '陆知行' }), NOW)
    expect(own).not.toHaveProperty('状态')
    expect(own).not.toHaveProperty('负责人')
    expect(own).not.toHaveProperty('截止时间')
    expect(own).not.toHaveProperty('事项')
  })

  it('建行时才写全部——那一刻表里还没有人写的东西', () => {
    const all = toFields(todo(), '研发群', NOW)
    expect(all).toHaveProperty('状态')
    expect(all).toHaveProperty('负责人')
  })
})

describe('风险标签说事实，不下判断', () => {
  it('三个标签都是看得见的事实', () => {
    // 「久无进展」是在替人判断工作状态；我们只看得见状态那一列有没有变。
    expect([...RISK_LABELS]).toEqual(['已过截止', '没有负责人', '状态久未更新'])
  })

  it('观察里明说"状态没变"不等于"没人在做"', () => {
    const r = observe(todo({ statusAt: NOW - 12 * DAY }), NOW)
    expect(r.observation).toContain('不代表没人在做')
  })
})
