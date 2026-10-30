import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { Todos, type TodoAudience } from '../src/core/todos.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const audience: TodoAudience = { scope: 'space:current', chatId: 'current-chat', chatType: 'group', openId: 'alice' }
function setup() {
  const registry = new Registry(':memory:'); cleanups.push(() => registry.close())
  return { registry, db: registry.db, todos: new Todos(registry.db) }
}
function session(registry: Registry, sessionKey: string, chatId: string, chatType: 'group' | 'p2p' = 'group', requesterOpenId = 'alice') {
  registry.createSession({ sessionKey, chatId, chatType, requesterOpenId, cwd: '/synthetic' })
}

describe('todo audience query for the human console', () => {
  it('excludes old-chat rows before paging and counting, without deleting the existing records', () => {
    const { registry, db, todos } = setup()
    session(registry, 'old', 'old-chat')
    session(registry, 'current', audience.chatId!)
    for (let n = 0; n < 110; n += 1) todos.add({ scope: audience.scope, sessionKey: 'old', title: 'OLD_GROUP', dueMs: 1 })
    const visible = todos.add({ scope: audience.scope, sessionKey: 'current', title: 'CURRENT', dueMs: 100 })
    todos.add({ scope: 'space:another', sessionKey: 'current', title: 'OTHER_SCOPE' })
    const before = db.prepare('SELECT * FROM todos ORDER BY id').all()
    expect(todos.list(audience.scope, { limit: 1 })[0]?.title).toBe('OLD_GROUP')
    expect(todos.listForAudience(audience, { limit: 1 })).toEqual({ items: [visible], total: 1 })
    expect(db.prepare('SELECT * FROM todos ORDER BY id').all()).toEqual(before)
  })

  it('combines status/kind filtering with origin filtering in both rows and totals', () => {
    const { registry, todos } = setup()
    session(registry, 'current', audience.chatId!)
    const open = todos.add({ scope: audience.scope, sessionKey: 'current', title: 'open' })
    const blocked = todos.add({ scope: audience.scope, title: 'blocked' })
    todos.transition(blocked.id, audience.scope, 'blocked')
    const review = todos.add({ scope: audience.scope, title: 'review', kind: 'deadline' })
    todos.transition(review.id, audience.scope, 'review')
    const done = todos.add({ scope: audience.scope, title: 'done' })
    todos.done(done.id, audience.scope)
    expect(todos.listForAudience(audience)).toEqual({ items: [open], total: 1 })
    expect(todos.listForAudience(audience, { status: 'active' }).total).toBe(3)
    expect(todos.listForAudience(audience, { status: 'all' }).total).toBe(4)
    expect(todos.listForAudience(audience, { status: 'active', kind: 'deadline' }).items.map(item => item.id)).toEqual([review.id])
    expect(todos.listForAudience(audience, { status: 'done' }).items.map(item => item.id)).toEqual([done.id])
  })

  it('requires matching DM session owner and channel kind in addition to chat', () => {
    const { registry, todos } = setup()
    const dm: TodoAudience = { scope: 'space:sp_dm_alice', chatId: 'dm-chat', chatType: 'p2p', openId: 'alice' }
    session(registry, 'alice', 'dm-chat', 'p2p', 'alice')
    session(registry, 'bob', 'dm-chat', 'p2p', 'bob')
    session(registry, 'group', 'dm-chat', 'group', 'alice')
    const mine = todos.add({ scope: dm.scope, sessionKey: 'alice', title: 'mine' })
    todos.add({ scope: dm.scope, sessionKey: 'bob', title: 'PRIVATE_BOB' })
    todos.add({ scope: dm.scope, sessionKey: 'group', title: 'GROUP' })
    expect(todos.listForAudience(dm)).toEqual({ items: [mine], total: 1 })
    expect(todos.listForAudience({ ...dm, chatId: null })).toEqual({ items: [], total: 0 })
  })

  it('allows different authors within the same group, but does not treat owner text as origin authority', () => {
    const { registry, todos } = setup()
    session(registry, 'bob-current', audience.chatId!, 'group', 'bob')
    session(registry, 'bob-other', 'other-chat', 'group', 'bob')
    const shared = todos.add({ scope: audience.scope, sessionKey: 'bob-current', title: 'same group' })
    todos.add({ scope: audience.scope, sessionKey: 'bob-other', title: 'foreign', ownerOpenId: 'alice', createdBy: 'alice', source: 'current group' })
    expect(todos.listForAudience(audience)).toEqual({ items: [shared], total: 1 })
  })

  it('preserves missing legacy session compatibility and stable same-time pagination', () => {
    const { db, todos } = setup()
    const first = todos.add({ scope: audience.scope, title: 'no session' })
    const second = todos.add({ scope: audience.scope, sessionKey: 'missing-history', title: 'missing session' })
    db.prepare('UPDATE todos SET created_at=1').run()
    expect(todos.listForAudience(audience, { limit: 1 })).toEqual({ items: [{ ...second, createdAt: 1 }], total: 2 })
    expect(todos.listForAudience(audience).items.map(item => item.id)).toEqual([second.id, first.id])
    const standalone = new DatabaseSync(':memory:'); cleanups.push(() => standalone.close())
    const legacy = new Todos(standalone)
    const saved = legacy.add({ scope: audience.scope, sessionKey: 'unavailable-history', title: 'legacy' })
    expect(legacy.listForAudience(audience)).toEqual({ items: [saved], total: 1 })
    for (const limit of [0, -1, 1.5, 1001]) expect(() => legacy.listForAudience(audience, { limit })).toThrow('1–1000')
  })
})
