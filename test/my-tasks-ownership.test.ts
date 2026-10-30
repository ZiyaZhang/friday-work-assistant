/**
 * 「我的任务」要按**谁的事**取，不是按**在哪个空间记的**取。
 *
 * 原来 `/tasks` 只查私聊空间的待办，于是群里明确派给某人的事哪怕 owner 写对了也看不见——
 * 而"别人在群里派给我的事"正是这个清单最主要的来源。
 */
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Todos } from '../src/core/todos.js'

const DM = 'space:sp_dm_ou_me'

function setup() {
  const db = new DatabaseSync(':memory:')
  const todos = new Todos(db)
  return { db, todos }
}

describe('我的任务按归属取', () => {
  it('群里派给我的事出现在我的清单里', () => {
    const t = setup()
    t.todos.add({ scope: 'space:sp_group', title: '排查 bad case：字太小', ownerOpenId: 'ou_me' })
    const mine = t.todos.listOwnedBy('ou_me')
    expect(mine.map(x => x.title)).toEqual(['排查 bad case：字太小'])
  })

  it('派给别人的不出现在我的清单里', () => {
    const t = setup()
    t.todos.add({ scope: 'space:sp_group', title: '别人的事', ownerOpenId: 'ou_other' })
    expect(t.todos.listOwnedBy('ou_me')).toEqual([])
  })

  it('我自己私聊里记的没写 owner，也算我的', () => {
    const t = setup()
    t.todos.add({ scope: DM, title: '周五交方案' })
    expect(t.todos.listOwnedBy('ou_me', { dmScope: DM }).map(x => x.title)).toEqual(['周五交方案'])
  })

  it('私聊里明确派给别人的，不算我的——哪怕记在我的私聊里', () => {
    const t = setup()
    t.todos.add({ scope: DM, title: '让老王周五交', ownerOpenId: 'ou_wang' })
    expect(t.todos.listOwnedBy('ou_me', { dmScope: DM })).toEqual([])
  })

  it('跨空间合并，并且带得出来是从哪个空间来的', () => {
    const t = setup()
    t.todos.add({ scope: 'space:sp_a', title: 'A 群派的', ownerOpenId: 'ou_me' })
    t.todos.add({ scope: 'space:sp_b', title: 'B 群派的', ownerOpenId: 'ou_me' })
    t.todos.add({ scope: DM, title: '我自己记的' })
    const mine = t.todos.listOwnedBy('ou_me', { dmScope: DM })
    expect(mine).toHaveLength(3)
    expect(new Set(mine.map(x => x.scope))).toEqual(new Set(['space:sp_a', 'space:sp_b', DM]))
  })

  it('默认只给没做完的；做完的不再占清单', () => {
    const t = setup()
    const done = t.todos.add({ scope: 'space:sp_a', title: '已经做完的', ownerOpenId: 'ou_me' })
    t.todos.add({ scope: 'space:sp_a', title: '还没做的', ownerOpenId: 'ou_me' })
    t.db.prepare("UPDATE todos SET status='done' WHERE id=?").run(done.id)
    expect(t.todos.listOwnedBy('ou_me').map(x => x.title)).toEqual(['还没做的'])
    expect(t.todos.listOwnedBy('ou_me', { status: 'all' })).toHaveLength(2)
  })

  it('有截止的排在没截止的前面', () => {
    const t = setup()
    t.todos.add({ scope: 'space:sp_a', title: '没有截止', ownerOpenId: 'ou_me' })
    t.todos.add({ scope: 'space:sp_a', title: '明天到期', ownerOpenId: 'ou_me', dueMs: Date.now() + 86_400_000 })
    expect(t.todos.listOwnedBy('ou_me').map(x => x.title)).toEqual(['明天到期', '没有截止'])
  })
})
