/**
 * 私聊读取范围：默认全开，可以逐个排除。
 *
 * 默认全开是刻意的取舍——连接之后立刻能用，不用先勾一遍群。
 * 换来的义务是：停一个必须**只停这一个**，恢复必须**接着上次的位置**，
 * 而且"我停过哪些"要随时答得出来。
 */
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ChatReadScope } from '../src/core/chat-read-scope.js'

function setup(startMs = 1_000_000) {
  const db = new DatabaseSync(':memory:')
  let now = startMs
  const scope = new ChatReadScope(db, () => now)
  return { db, scope, at: (ms: number) => { now = ms } }
}

describe('私聊读取范围', () => {
  it('默认全开：没排除过的会话都读得到', () => {
    const t = setup()
    expect(t.scope.isReadable('ou_a', 'oc_1')).toBe(true)
    expect(t.scope.isReadable('ou_a', 'oc_never_seen')).toBe(true)
    expect(t.scope.excludedChatIds('ou_a')).toEqual([])
  })

  it('排除之后读不到', () => {
    const t = setup()
    t.scope.exclude('ou_a', 'oc_1')
    expect(t.scope.isReadable('ou_a', 'oc_1')).toBe(false)
    expect(t.scope.excludedChatIds('ou_a')).toEqual(['oc_1'])
  })

  it('停一个只停这一个，其他照常', () => {
    const t = setup()
    t.scope.exclude('ou_a', 'oc_1')
    expect(t.scope.isReadable('ou_a', 'oc_2')).toBe(true)
    expect(t.scope.isReadable('ou_a', 'oc_3')).toBe(true)
  })

  it('一个人的排除不影响另一个人', () => {
    const t = setup()
    t.scope.exclude('ou_a', 'oc_1')
    expect(t.scope.isReadable('ou_b', 'oc_1')).toBe(true)
  })

  it('恢复之后又能读，并且记录保留下来', () => {
    const t = setup()
    t.scope.exclude('ou_a', 'oc_1')
    t.at(2_000_000)
    expect(t.scope.restore('ou_a', 'oc_1')).toBe(true)
    expect(t.scope.isReadable('ou_a', 'oc_1')).toBe(true)
    const e = t.scope.get('ou_a', 'oc_1')!
    expect(e.active).toBe(false)
    expect(e.excludedAt).toBe(1_000_000)
    expect(e.restoredAt).toBe(2_000_000)
    expect(t.scope.excludedChatIds('ou_a')).toEqual([])
  })

  it('恢复不动游标：游标不在这张表里，所以恢复后是接着读而不是重头读', () => {
    const t = setup()
    t.scope.exclude('ou_a', 'oc_1')
    t.scope.restore('ou_a', 'oc_1')
    const cols = (t.db.prepare('PRAGMA table_info(chat_read_exclusions)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).not.toContain('cursor')
    expect(cols).not.toContain('last_read_at')
  })

  it('重复恢复返回 false，不无中生有', () => {
    const t = setup()
    t.scope.exclude('ou_a', 'oc_1')
    expect(t.scope.restore('ou_a', 'oc_1')).toBe(true)
    expect(t.scope.restore('ou_a', 'oc_1')).toBe(false)
    expect(t.scope.restore('ou_a', 'oc_never')).toBe(false)
  })

  it('恢复之后再停，能重新生效且不产生第二条记录', () => {
    const t = setup()
    t.scope.exclude('ou_a', 'oc_1')
    t.scope.restore('ou_a', 'oc_1')
    t.at(3_000_000)
    const again = t.scope.exclude('ou_a', 'oc_1')
    expect(again.active).toBe(true)
    expect(again.excludedAt).toBe(3_000_000)
    expect(again.restoredAt).toBeNull()
    expect(t.scope.isReadable('ou_a', 'oc_1')).toBe(false)
    expect(t.scope.list('ou_a')).toHaveLength(1)
  })

  it('「我停过哪些」随时答得出来，含已经恢复的', () => {
    const t = setup()
    t.scope.exclude('ou_a', 'oc_1')
    t.scope.exclude('ou_a', 'oc_2')
    t.scope.restore('ou_a', 'oc_2')
    const all = t.scope.list('ou_a')
    expect(all).toHaveLength(2)
    expect(all.filter(e => e.active).map(e => e.chatId)).toEqual(['oc_1'])
  })
})
