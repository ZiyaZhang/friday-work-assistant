/**
 * 「这一轮我停下来等你定」要留下痕迹。
 *
 * 真机上看到的：他说「把 dsh 这个标签的文案从 Beta 改成实验性，提到 deepseek-harness 并 request 我 review」，
 * Friday 查出仓库里有两处 Beta，停下来问是哪一个——然后这一轮就结束了。
 * **问题只存在于那条消息里**：他当时没回，这件事就没了，没有任何地方记着"有件事在等他"。
 *
 * 收件箱本来就是为这个设计的（不单独打扰、蹭已有对话捎带、最多捎三次），
 * 缺的只是**没人往里写**。
 *
 * 这组用例守三件事：
 * 1. 停下来等人定的问题要能记下来，并且之后会被捎带；
 * 2. 同一个空间里同一句问题**只记一条**——问两次不会变成两条；
 * 3. 不同空间的同一句问题是两回事，而且**群里只捎带本空间的**。
 */
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Inbox, decisionRef, MAX_NUDGES, NUDGE_DELAY_MS, NUDGE_COOLDOWN_MS } from '../src/core/inbox.js'

const Q = '插件页的 Beta 和设置里的 beta，改哪一个？'
const NOW = 1_000_000_000

function setup() {
  const db = new DatabaseSync(':memory:')
  return { db, inbox: new Inbox(db) }
}

/** 照 API 路由的做法记一条。 */
function record(inbox: Inbox, opts: { spaceId?: string; question?: string; now?: number } = {}) {
  const question = opts.question ?? Q
  const ref = decisionRef(opts.spaceId, question)
  const existing = inbox.find('decision', ref)
  const item = inbox.add({ ownerOpenId: 'ou_alice', kind: 'decision', refId: ref, spaceId: opts.spaceId, title: question, why: '两处都叫 Beta，改错会动到另一个页面', now: opts.now ?? NOW })
  return { item, alreadyOpen: Boolean(existing && existing.resolvedAt === null) }
}

describe('停下来等人定的问题要留痕', () => {
  it('记下来之后，它在等这个人拍板', () => {
    const t = setup()
    const { item, alreadyOpen } = record(t.inbox, { spaceId: 'space:sp_dm' })
    expect(alreadyOpen).toBe(false)
    expect(t.inbox.pending('ou_alice').map((i) => i.title)).toEqual([Q])
    expect(item.why).toContain('改错会动到另一个页面')
  })

  it('同一句问题问两次只有一条，而且第二次会告诉你已经在等了', () => {
    const t = setup()
    record(t.inbox, { spaceId: 'space:sp_dm' })
    const second = record(t.inbox, { spaceId: 'space:sp_dm' })
    expect(second.alreadyOpen).toBe(true)
    expect(t.inbox.pending('ou_alice')).toHaveLength(1)
  })

  it('只差空格换行的两句话是同一个问题——模型重述时很容易多个换行', () => {
    const t = setup()
    record(t.inbox, { spaceId: 'space:sp_dm', question: Q })
    record(t.inbox, { spaceId: 'space:sp_dm', question: `  ${Q.replace('，', '，\n')}  ` })
    expect(t.inbox.pending('ou_alice')).toHaveLength(1)
  })

  it('不同空间的同一句问题是两回事', () => {
    const t = setup()
    record(t.inbox, { spaceId: 'space:sp_a' })
    record(t.inbox, { spaceId: 'space:sp_b' })
    expect(t.inbox.pending('ou_alice')).toHaveLength(2)
  })

  it('答完之后不再等；再问同一句会重新开一条', () => {
    const t = setup()
    const { item } = record(t.inbox, { spaceId: 'space:sp_dm' })
    expect(t.inbox.resolveById(item.id, NOW + 1000)).toBe(true)
    expect(t.inbox.pending('ou_alice')).toEqual([])
    expect(record(t.inbox, { spaceId: 'space:sp_dm' }).alreadyOpen).toBe(false)
  })
})

describe('怎么捎带出去', () => {
  it('刚记下来不立刻催——别答完上一句就马上追着问', () => {
    const t = setup()
    record(t.inbox, { spaceId: 'space:sp_dm' })
    expect(t.inbox.dueFor('ou_alice', NOW)).toEqual([])
    expect(t.inbox.dueFor('ou_alice', NOW + NUDGE_DELAY_MS + 1)).toHaveLength(1)
  })

  it('群里只捎带本空间的——私聊里攒的贴进群等于替人泄密', () => {
    const t = setup()
    record(t.inbox, { spaceId: 'space:sp_dm' })
    const later = NOW + NUDGE_DELAY_MS + 1
    expect(t.inbox.dueFor('ou_alice', later, { spaceId: 'space:sp_group' })).toEqual([])
    expect(t.inbox.dueFor('ou_alice', later, { spaceId: 'space:sp_dm' })).toHaveLength(1)
  })

  it('催到上限就不再催——他就是不想理，再催是骚扰', () => {
    const t = setup()
    const { item } = record(t.inbox, { spaceId: 'space:sp_dm' })
    let at = NOW + NUDGE_DELAY_MS + 1
    for (let i = 0; i < MAX_NUDGES; i += 1) {
      expect(t.inbox.dueFor('ou_alice', at)).toHaveLength(1)
      t.inbox.markNudged([item.id], at)
      at += NUDGE_COOLDOWN_MS + 1
    }
    expect(t.inbox.dueFor('ou_alice', at)).toEqual([])
    // 但它还在等——只是不再主动提，问起来仍然查得到
    expect(t.inbox.pending('ou_alice')).toHaveLength(1)
  })
})

describe('编号是内容算出来的，不是随手编的', () => {
  it('同样的输入永远同样的编号，落在安全整数内', () => {
    const a = decisionRef('space:sp_a', Q)
    expect(decisionRef('space:sp_a', Q)).toBe(a)
    expect(Number.isSafeInteger(a)).toBe(true)
    expect(a).toBeGreaterThan(0)
  })

  it('空间不同、问题不同，编号都不同', () => {
    expect(decisionRef('space:sp_a', Q)).not.toBe(decisionRef('space:sp_b', Q))
    expect(decisionRef('space:sp_a', Q)).not.toBe(decisionRef('space:sp_a', '别的问题'))
  })

  it('没有空间（私聊之外的场合）也能算', () => {
    expect(Number.isSafeInteger(decisionRef(undefined, Q))).toBe(true)
  })
})
