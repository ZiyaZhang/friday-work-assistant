/**
 * 什么能进企业层（全公司可见）。
 *
 * 他定的规矩是「组织公共知识只接收逐个批准的完全公开空间，私聊和私密群不进入」。
 * 原来只实现了"逐个批准"那一半：`promote` 只问"你是不是全局管理员"，
 * 不问这条记忆里的内容是从哪来的。
 *
 * 缺的那一半来自他的一句追问——「但理论上私聊是可以读用户有权限的工作空间、
 * 各种文档表格、各种群聊、会议纪要等等对吧」。对，而且这正是问题所在：
 * 私聊里 Friday 用的是**他本人的身份**，读得到的是"他有权限看见的"。
 * 把那些东西晋升到企业层，等于用他一个人的权限给所有人开了一扇窗，
 * 而原来那个群里的人根本不知道。
 *
 * 所以判的是**来源**不是**空间**：私聊里总结出来的通用结论（没有外部来源）该能上去，
 * 而群里读来的原文（哪怕是在公开群读的）不该。
 * 这跟自动路径上的 `hasExternalContext` 是同一条规则，只是手动晋升当初漏了。
 */
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ChannelMemory } from '../src/core/memory.js'

const HOME = 'oc_home'
const RUN = 'run-1'

function setup() {
  const db = new DatabaseSync(':memory:')
  return { db, memory: new ChannelMemory(db) }
}

/** 造一条带来源链的记忆。`readIdentity` 和 `chatId` 是判断用得上的两个字段。 */
function remember(
  m: ChannelMemory,
  sources: { chatId: string | null; identity: 'user' | 'app' }[],
  scope = 'space:sp_a',
) {
  return m.add({
    scope, kind: 'fact', title: '发布流程', body: '先封版再发',
    source: { generatedBy: 'model' },
    provenance: sources.length ? {
      state: 'verified', originRunId: RUN,
      sources: sources.map((s, i) => ({
        ref: `r${i}`, tenantId: 't', appId: 'a', spaceId: 'sp_a', chatId: s.chatId,
        readIdentity: s.identity === 'user' ? { kind: 'user' as const, openId: 'ou_alice' } : { kind: 'app' as const },
        readAt: 1, coverage: 'complete' as const,
      })),
      ancestors: [],
    } : undefined,
  })
}

describe('用个人身份读到的，不能变成全公司的', () => {
  it('以用户身份读来的会被拦住', () => {
    const t = setup()
    const note = remember(t.memory, [{ chatId: HOME, identity: 'user' }])
    const r = t.memory.externalSourcesFor(note.id, HOME)
    expect(r.blocked).toHaveLength(1)
    expect(r.blocked[0]!.readIdentity).toMatchObject({ kind: 'user' })
  })

  it('哪怕读的就是本会话，也拦——重点是"用谁的权限读的"', () => {
    // 私聊里读自己的文档，chatId 正是本会话；但那仍然是他一个人的权限。
    const t = setup()
    const note = remember(t.memory, [{ chatId: HOME, identity: 'user' }])
    expect(t.memory.externalSourcesFor(note.id, HOME).blocked).toHaveLength(1)
  })
})

describe('从别的会话读来的，也不能', () => {
  it('别的 chatId 会被拦住', () => {
    const t = setup()
    const note = remember(t.memory, [{ chatId: 'oc_other', identity: 'app' }])
    expect(t.memory.externalSourcesFor(note.id, HOME).blocked).toHaveLength(1)
  })

  it('本会话自产的放行——这正是该能共享的那一类', () => {
    const t = setup()
    const note = remember(t.memory, [{ chatId: HOME, identity: 'app' }])
    expect(t.memory.externalSourcesFor(note.id, HOME).blocked).toEqual([])
  })

  it('混着来的只要有一条外部来源就拦，并把那条指出来', () => {
    const t = setup()
    const note = remember(t.memory, [{ chatId: HOME, identity: 'app' }, { chatId: 'oc_other', identity: 'app' }])
    const r = t.memory.externalSourcesFor(note.id, HOME)
    expect(r.blocked).toHaveLength(1)
    expect(r.blocked[0]!.chatId).toBe('oc_other')
  })
})

describe('证明不了的时候说实话', () => {
  it('没有来源记录的旧条目放行，但标记成"没核对过"', () => {
    // 一律拦住会把所有旧记忆锁死；假装核对过又是撒谎。所以放行 + 说清楚。
    const t = setup()
    const note = remember(t.memory, [])
    const r = t.memory.externalSourcesFor(note.id, HOME)
    expect(r.blocked).toEqual([])
    expect(r.unverified).toBe(true)
  })

  it('有来源链且干净时不需要那句提醒', () => {
    const t = setup()
    const note = remember(t.memory, [{ chatId: HOME, identity: 'app' }])
    expect(t.memory.externalSourcesFor(note.id, HOME).unverified).toBe(false)
  })

  it('查不到这条记忆时按"没核对过"处理，不当成干净', () => {
    const t = setup()
    expect(t.memory.externalSourcesFor(999999, HOME)).toEqual({ blocked: [], unverified: true })
  })
})
