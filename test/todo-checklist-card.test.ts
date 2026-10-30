/**
 * 记完待办，回的应该是一份能打勾的清单，不是一段文本回执。
 *
 * 真机上看到的：他一口气说了五件事，Friday 回
 * 「已记下 5 条（#2-#6）：自动化任务建议、Harness 官网文案、插件系统安装流程、产品经理新 JD、
 * Friday 使用指南 + 权限申请。都没带时间 —— 哪条有截止日……」
 *
 * 这句话把五件事压成一行逗号分隔的文本：看不出哪条做完了，也没法在上面做任何动作，
 * 想把第二条标成完成还得再打一句话。他的原话是「你一段纯文本消息算啥？」——说得对。
 *
 * 飞书自己的「任务」当然更好，但那要 `task:task` 权限，现在还没有。
 * 在那之前，卡片里的 `checker` 就是能打勾的清单；而且正文塞进卡里当引子，
 * 省掉"一段纯文本 + 一张卡"的两条消息。
 *
 * 这组用例守四件事：
 * 1. 每一条都是能点的 checker，且带着自己的 id——卡片会留在会话里很久，按序号回查是会点错的；
 * 2. 已完成的打上勾并划掉，抬头写清 N/M；
 * 3. 正文作为引子进卡，而不是单独再发一条；
 * 4. 每个 checker 都带着整张卡的 id 列表，所以点任意一条都能刷出完整的新卡。
 */
import { describe, expect, it } from 'vitest'
import { renderTodoCard } from '../src/feishu/cards.js'

type El = Record<string, unknown>

function elements(card: Record<string, unknown>): El[] {
  return (card.body as { elements: El[] }).elements
}
function checkers(card: Record<string, unknown>): El[] {
  return elements(card).filter((e) => e.tag === 'checker')
}
function valueOf(el: El): Record<string, unknown> {
  return (el.behaviors as { value: Record<string, unknown> }[])[0]!.value
}

const ITEMS = [
  { id: 2, title: '修改自动化任务的建议', done: false },
  { id: 3, title: '想 Harness 官网的文案', done: false },
  { id: 4, title: '去改那个插件系统的安装流程', done: true },
]

describe('清单是能点的，不是一段文字', () => {
  it('每条都是一个 checker，不是 markdown 行', () => {
    const card = renderTodoCard({ items: ITEMS })
    expect(checkers(card)).toHaveLength(3)
    expect(checkers(card).map((c) => (c.text as El).content)).toEqual([
      '修改自动化任务的建议', '想 Harness 官网的文案', '去改那个插件系统的安装流程',
    ])
  })

  it('标题与完成操作分开，点击工作链接不会误完成事项', () => {
    const card = renderTodoCard({ items: [{ id: 1, title: '评审 PR #12', done: false,
      githubEvidence: '请看 https://github.com/org/repo/pull/12' }] })
    const checker = checkers(card)[0]!
    expect(checker.overall_checkable).toBe(false)
    expect(checker.text).toEqual({ tag: 'lark_md', content: '评审 [PR #12](https://github.com/org/repo/pull/12)' })
  })

  it('已完成的打勾并划掉', () => {
    const card = renderTodoCard({ items: ITEMS })
    expect(checkers(card).map((c) => c.checked)).toEqual([false, false, true])
    expect((checkers(card)[2]!.checked_style as El).show_strikethrough).toBe(true)
  })

  it('抬头写清做完几条', () => {
    const header = renderTodoCard({ items: ITEMS }).header as { subtitle: El; template: string }
    expect((header.subtitle as El).content).toBe('1/3 已完成')
    expect(header.template).toBe('blue')
  })

  it('全做完了抬头变绿——一眼看得出这份清单结了', () => {
    const header = renderTodoCard({ items: ITEMS.map((i) => ({ ...i, done: true })) }).header as { subtitle: El; template: string }
    expect((header.subtitle as El).content).toBe('3/3 已完成')
    expect(header.template).toBe('green')
  })
})

describe('点一下要能改到对的那一条', () => {
  it('回调带的是 id，不是它在卡上的第几行', () => {
    // 卡片会留在会话里很久；几天后再点，那时的"第 2 条"早就不是同一条了。
    const values = checkers(renderTodoCard({ items: ITEMS })).map(valueOf)
    expect(values.map((v) => v.id)).toEqual([2, 3, 4])
    expect(values.every((v) => v.action === 'todo')).toBe(true)
  })

  it('未完成的点了是完成，已完成的点了是撤回——同一个位置两个方向', () => {
    const values = checkers(renderTodoCard({ items: ITEMS })).map(valueOf)
    expect(values.map((v) => v.op)).toEqual(['done', 'done', 'reopen'])
  })
})

describe('正文进卡当引子，不再单独发一条', () => {
  it('引子排在清单前面', () => {
    const card = renderTodoCard({ items: ITEMS, lede: '都没带时间 —— 哪条有截止日跟我说一声。' })
    expect(elements(card)[0]).toEqual({ tag: 'markdown', content: '都没带时间 —— 哪条有截止日跟我说一声。' })
    expect(checkers(card)).toHaveLength(3)
  })

  it('没有引子就不占位置', () => {
    expect(elements(renderTodoCard({ items: ITEMS }))[0]!.tag).toBe('checker')
    expect(elements(renderTodoCard({ items: ITEMS, lede: '   ' }))[0]!.tag).toBe('checker')
  })
})

describe('说清楚没列出来的部分', () => {
  it('空清单直说是空的，不发一张什么都没有的卡', () => {
    const card = renderTodoCard({ items: [] })
    expect(checkers(card)).toHaveLength(0)
    expect(JSON.stringify(elements(card))).toContain('这份清单现在是空的')
  })

  it('还有别的条目就写个数，不偷偷不提', () => {
    expect(JSON.stringify(renderTodoCard({ items: ITEMS, more: 7 }))).toContain('还有 7 条没列在这张卡上')
  })

  it('长标题截断，不把一整段话塞进一行', () => {
    const long = '很长的标题'.repeat(60)
    const content = String((checkers(renderTodoCard({ items: [{ id: 1, title: long, done: false }] }))[0]!.text as El).content)
    expect(content.length).toBeLessThanOrEqual(121)
  })
})

describe('字段名要和飞书认的那一份一致', () => {
  /**
   * 这一段是撞出来的，不是想出来的。第一版写了 `checked_style: { text_color, strikethrough }`，
   * 飞书直接整张卡打回：`230099 / 200621 unknown property, property: text_color`，
   * 换成 `strikethrough` 又被打回一次。卡片被打回时人收到的是**什么都没有**——
   * 比原来那段纯文本还糟。所以这几个名字值得钉死。
   */
  it('checked_style 只有 show_strikethrough 和 opacity 这两个键', () => {
    for (const c of checkers(renderTodoCard({ items: ITEMS }))) {
      expect(Object.keys(c.checked_style as El).sort()).toEqual(['opacity', 'show_strikethrough'])
    }
  })

  it('checker 上没有 subtitle——飞书没这个字段，负责人和截止并进正文那一行', () => {
    const card = renderTodoCard({ items: [{ id: 1, title: '排查 bad case', done: false, owner: '陆知行', due: '9/25' }] })
    const checker = checkers(card)[0]!
    expect(checker).not.toHaveProperty('subtitle')
    expect((checker.text as El).content).toBe('排查 bad case · 陆知行 · 9/25')
  })

  it('只有负责人或只有截止时不留下孤零零的分隔符', () => {
    const only = (over: Record<string, unknown>) =>
      String((checkers(renderTodoCard({ items: [{ id: 1, title: 'T', done: false, ...over }] }))[0]!.text as El).content)
    expect(only({ owner: '陆知行' })).toBe('T · 陆知行')
    expect(only({ due: '9/25' })).toBe('T · 9/25')
    expect(only({ owner: null, due: '  ' })).toBe('T')
  })

  it('每个 checker 都声明了回调，否则点了没有任何反应', () => {
    for (const c of checkers(renderTodoCard({ items: ITEMS }))) {
      expect((c.behaviors as El[])[0]!.type).toBe('callback')
    }
  })
})
