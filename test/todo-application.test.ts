import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { TodoApplication, todoTag, type TodoPatch } from '../src/core/todo-application.js'
import { Todos, responsibleOpenId, type TodoAudience } from '../src/core/todos.js'
import { ensureFeishuTaskSyncSchema } from '../src/core/feishu-task-sync.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const audience: TodoAudience = { scope: 'space:team', chatId: 'team-chat', chatType: 'group', openId: 'alice' }
function setup(actor = 'alice') {
  const registry = new Registry(':memory:')
  cleanups.push(() => registry.close())
  registry.createSession({ sessionKey: 'team-session', chatId: audience.chatId!, chatType: 'group', requesterOpenId: 'bob', cwd: '/synthetic' })
  const todos = new Todos(registry.db)
  const app = new TodoApplication({ db: registry.db, todos })
  const todo = todos.add({ scope: audience.scope, sessionKey: 'team-session', title: '审阅文档', detail: '保留上下文', dueMs: 100,
    owner: 'Bob', ownerOpenId: 'bob', confirmed: false, createdBy: 'bob', source: '群内讨论' })
  const update = (patch: TodoPatch, tag = todoTag(todos.get(todo.id)!)) => app.update(todo.id, { ...audience, openId: actor }, { expectedTag: tag, patch }, actor)
  return { registry, db: registry.db, todos, app, todo, update }
}

describe('human Todo application', () => {
  it('uses the real session audience for exact reads and updates, without changing legacy list behavior', () => {
    const { registry, todos, app, todo } = setup()
    registry.createSession({ sessionKey: 'old-team', chatId: 'old-chat', chatType: 'group', requesterOpenId: 'alice', cwd: '/synthetic' })
    const old = todos.add({ scope: audience.scope, sessionKey: 'old-team', title: '旧群事项', ownerOpenId: 'alice' })
    expect(todos.getForAudience(old.id, audience)).toBeUndefined()
    expect(() => app.update(old.id, audience, { expectedTag: todoTag(old), patch: { title: '不应改写' } }, 'alice')).toThrowError(expect.objectContaining({ status: 404 }))
    expect(todos.get(old.id)).toEqual(old)
    expect(todos.list(audience.scope).map(row => row.id)).toContain(old.id)
    // Another author in the same group is still in the current shared audience.
    expect(todos.getForAudience(todo.id, audience)).toEqual(todo)
    expect(app.update(todo.id, audience, { expectedTag: todoTag(todo), patch: { title: '补充审阅' } }, 'alice').todo.title).toBe('补充审阅')
    expect(() => app.update(todo.id, { ...audience, scope: 'space:elsewhere' }, { expectedTag: todoTag(todo), patch: { confirm: true } }, 'alice')).toThrowError(expect.objectContaining({ status: 404 }))
  })

  it('rejects another DM owner, channel kind, and an actor different from the authorized audience', () => {
    const { registry, todos, app, todo } = setup()
    const dm: TodoAudience = { scope: 'space:dm', chatId: 'dm-chat', chatType: 'p2p', openId: 'alice' }
    for (const [key, chatType, owner] of [['dm-bob', 'p2p', 'bob'], ['group', 'group', 'alice'], ['dm-alice', 'p2p', 'alice']] as const) {
      registry.createSession({ sessionKey: key, chatId: 'dm-chat', chatType, requesterOpenId: owner, cwd: '/synthetic' })
      const saved = todos.add({ scope: dm.scope, sessionKey: key, title: key })
      if (key === 'dm-alice') expect(app.update(saved.id, dm, { expectedTag: todoTag(saved), patch: { title: '本人更新' } }, 'alice').changed).toBe(true)
      else expect(() => app.update(saved.id, dm, { expectedTag: todoTag(saved), patch: { title: '不可读写' } }, 'alice')).toThrowError(expect.objectContaining({ status: 404 }))
    }
    expect(() => app.update(todo.id, audience, { expectedTag: todoTag(todo), patch: { confirm: true } }, 'bob')).toThrowError(expect.objectContaining({ status: 403 }))
  })

  it('atomically edits, confirms and completes with the human status identity and preserved ownership/source', () => {
    const { todos, todo, update } = setup('bob') // Original creator and assignee may confirm the candidate.
    todos.markReminded(todo.id, '24h', 50)
    const result = update({ title: '  完成\n文档审阅  ', detail: '完整的新详情', dueMs: 200, confirm: true, status: 'done', statusNote: '  已验收  ' })
    expect(result).toMatchObject({ changed: true, todo: { title: '完成 文档审阅', detail: '完整的新详情', dueMs: 200,
      confirmed: true, status: 'done', statusNote: '已验收', statusBy: 'bob', remindedStages: [], remindedAt: null,
      owner: 'Bob', ownerOpenId: 'bob', createdBy: 'bob', source: '群内讨论', sessionKey: 'team-session' } })
    expect(result.todo.doneAt).toEqual(expect.any(Number))
    expect(result.tag).toBe(todoTag(todos.get(todo.id)!))
    expect(todos.getForAudience(todo.id, audience)?.status).toBe('done')
    expect(todos.listForAudience(audience).total).toBe(0)
  })

  it('rolls back earlier content, deadline and confirmation when the final persistent transition fails', () => {
    const { db, todos, todo, update } = setup('bob')
    todos.markReminded(todo.id, '24h', 50)
    const before = todos.get(todo.id)
    db.exec(`CREATE TRIGGER reject_completion BEFORE UPDATE OF status ON todos
      WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'simulated transition failure'); END`)
    expect(() => update({ title: '不应残留', detail: null, dueMs: 200, confirm: true, status: 'done' })).toThrow('simulated transition failure')
    expect(todos.get(todo.id)).toEqual(before)
  })

  it('joins the caller transaction so failure to save the human operation receipt rolls back the domain update', () => {
    const { db, todos, todo, update } = setup('bob')
    db.exec('BEGIN IMMEDIATE')
    update({ title: '事务内修改', confirm: true })
    expect(todos.get(todo.id)?.title).toBe('事务内修改')
    db.exec('ROLLBACK')
    expect(todos.get(todo.id)).toEqual(todo)
    expect(update({ title: '之后仍可正常修改' }).changed).toBe(true)
  })

  it('rejects the second editor with a stale content tag, including after a separately constructed store', () => {
    const { db, todos, todo, update } = setup()
    const tag = todoTag(todo)
    const second = new TodoApplication({ db, todos: new Todos(db) })
    const saved = update({ title: '先提交的标题' }, tag)
    expect(() => second.update(todo.id, audience, { expectedTag: tag, patch: { detail: '旧表单的详情', status: 'done' } }, 'alice')).toThrowError(expect.objectContaining({ status: 409, code: 'todo_changed' }))
    expect(todos.get(todo.id)).toEqual(saved.todo)
  })

  it('does not conflict with or clear reminder acknowledgements when explicit values are unchanged', () => {
    const { todos, todo, update } = setup()
    const tag = todoTag(todo)
    todos.markReminded(todo.id, '24h', 50)
    const unchanged = update({ title: todo.title, detail: todo.detail, dueMs: todo.dueMs }, tag)
    expect(unchanged).toMatchObject({ changed: false, tag, todo: { remindedStages: ['24h'], remindedAt: 50 } })
    expect(update({ detail: null }, tag).changed).toBe(true)
    expect(todos.get(todo.id)?.remindedStages).toEqual(['24h'])
  })

  it('preserves the original state machine, including explicit reopen before editing terminal records', () => {
    const { todos, todo, update } = setup('bob')
    update({ status: 'blocked', statusNote: '等待资料' })
    update({ status: 'blocked', statusNote: '资料仍未到' })
    update({ status: 'review' })
    const review = todos.get(todo.id)
    expect(() => update({ title: '不能部分保存', status: 'blocked' })).toThrowError(expect.objectContaining({ status: 409 }))
    expect(todos.get(todo.id)).toEqual(review)
    update({ status: 'done' })
    const done = todos.get(todo.id)
    expect(() => update({ title: '未显式重开' })).toThrowError(expect.objectContaining({ status: 409 }))
    expect(() => update({ confirm: true })).toThrowError(expect.objectContaining({ status: 409 }))
    expect(() => update({ status: 'cancelled' })).toThrowError(expect.objectContaining({ status: 409 }))
    expect(todos.get(todo.id)).toEqual(done)
    todos.markReminded(todo.id, '24h', 50)
    const reopened = update({ status: 'open', title: '明确重新审阅', confirm: true })
    expect(reopened.todo).toMatchObject({ status: 'open', doneAt: null, confirmed: true, title: '明确重新审阅', remindedStages: [], remindedAt: null })
    update({ status: 'cancelled', statusNote: '不用继续' })
    expect(update({ status: 'open', dueMs: null }).todo).toMatchObject({ status: 'open', dueMs: null, statusNote: null })
  })

  it('rejects malformed reassignment, clearing confirmation, an independent status note, or silently truncated content', () => {
    const { todos, todo, update } = setup()
    const invalid: unknown[] = [
      {}, { ownerOpenId: '' }, { ownerOpenId: 42 }, { owner: '字'.repeat(101) }, { source: '伪来源' }, { scope: 'other' }, { confirm: false }, { statusNote: '未声明迁移' },
      { title: '  ' }, { title: '字'.repeat(201) }, { detail: '字'.repeat(2001) },
      { status: 'blocked', statusNote: '字'.repeat(301) }, { dueMs: 1.5 }, { dueMs: Infinity }, { dueMs: 8.64e15 + 1 },
      { dueMs: '100' }, { detail: undefined }, { status: 'unknown' },
    ]
    for (const patch of invalid) {
      expect(() => update(patch as TodoPatch)).toThrowError(expect.objectContaining({ status: 400 }))
      expect(todos.get(todo.id)).toEqual(todo)
    }
    const max = update({ title: '字'.repeat(200), detail: '字'.repeat(2000), status: 'blocked', statusNote: '字'.repeat(300) })
    expect([max.todo.title.length, max.todo.detail!.length, max.todo.statusNote!.length]).toEqual([200, 2000, 300])
  })

  it('keeps unknown legacy origins compatible without treating them as newly proven sources', () => {
    const db = new DatabaseSync(':memory:'); cleanups.push(() => db.close())
    const todos = new Todos(db)
    const app = new TodoApplication({ db, todos })
    const old = todos.add({ scope: audience.scope, sessionKey: 'missing-history', title: '历史条目' })
    const result = app.update(old.id, audience, { expectedTag: todoTag(old), patch: { detail: '明确修改' } }, 'alice')
    expect(result.todo).toMatchObject({ sessionKey: 'missing-history', source: null, detail: '明确修改' })
    expect(todos.list(audience.scope)).toEqual([result.todo])
  })
})

describe('one Todo application for chat, cards, console and meetings', () => {
  const dm: TodoAudience = { scope: 'space:sp_dm_alice', chatId: 'dm-alice', chatType: 'p2p', openId: 'alice' }
  function app() {
    const db = new DatabaseSync(':memory:'); cleanups.push(() => db.close())
    const todos = new Todos(db)
    return { db, todos, app: new TodoApplication({ db, todos }) }
  }

  it('resolves and saves the responsible person once: private chat without a named owner is that person, a name without open_id stays unknown', () => {
    const { app: todo, todos } = app()
    expect(todo.create(dm, { title: '周五前交周报' }, 'alice').todo).toMatchObject({ owner: null, ownerOpenId: 'alice', createdBy: 'alice', scope: dm.scope })
    expect(todo.create(dm, { title: '帮小王记：交接口文档', owner: '小王' }, 'alice').todo).toMatchObject({ owner: '小王', ownerOpenId: null })
    expect(todo.create(dm, { title: '让 Bob 看方案', owner: 'Bob', ownerOpenId: 'bob' }, 'alice').todo).toMatchObject({ owner: 'Bob', ownerOpenId: 'bob' })
    expect(todo.create(audience, { title: '群里没说谁做' }, 'alice').todo).toMatchObject({ owner: null, ownerOpenId: null })
    expect(todo.create(audience, { title: '群里没说谁做', owner: '张三' }, null).todo).toMatchObject({ owner: '张三', ownerOpenId: null, createdBy: null })
    const legacy = todos.add({ scope: dm.scope, title: '旧私聊待办', createdBy: 'alice' })
    const named = todos.add({ scope: dm.scope, title: '旧私聊代记', owner: '小王', createdBy: 'alice' })
    const group = todos.add({ scope: audience.scope, title: '旧群待办', createdBy: 'alice' })
    expect([legacy, named, group].map(responsibleOpenId)).toEqual(['alice', null, null])
    expect(responsibleOpenId(todos.add({ scope: 'user:carol', title: '更早的私聊格式' }))).toBe('carol')
    expect(todos.listOwnedBy('alice', { dmScope: dm.scope, limit: 50 }).map(item => item.title).sort())
      .toEqual(['周五前交周报', '旧私聊待办'].sort())
  })

  it('validates new Todos and requires a time for milestones', () => {
    const { app: todo, todos } = app()
    for (const input of [{ title: ' ' }, { title: '字'.repeat(201) }, { title: '封版', kind: 'freeze' }, { title: 'x', dueMs: 1.5 },
      { title: 'x', detail: '字'.repeat(2001) }, { title: 'x', ownerOpenId: '' }, { title: 'x', kind: 'other' }]) {
      expect(() => todo.create(audience, input as never, 'alice')).toThrowError(expect.objectContaining({ status: 400 }))
    }
    expect(todos.list(audience.scope, { status: 'all' })).toEqual([])
    const saved = todo.create(audience, { title: ' 9/25 18:00\n封版 ', kind: 'freeze', dueMs: 1_900_000_000_000, confirmed: false, source: '群内讨论' }, 'alice')
    expect(saved.todo).toMatchObject({ title: '9/25 18:00 封版', kind: 'freeze', confirmed: false, source: '群内讨论', status: 'open' })
    expect(saved.tag).toBe(todoTag(saved.todo))
  })

  it('reassigns by replacing both owner fields; a bare name never keeps the previous open_id', () => {
    const { app: todo } = app()
    const saved = todo.create(audience, { title: '整理需求', owner: 'Bob', ownerOpenId: 'bob' }, 'alice')
    const moved = todo.update(saved.todo.id, audience, { current: true, patch: { owner: 'Carol', ownerOpenId: 'carol' } }, 'alice')
    expect(moved.todo).toMatchObject({ owner: 'Carol', ownerOpenId: 'carol' })
    expect(todo.update(saved.todo.id, audience, { current: true, patch: { owner: '小王' } }, 'alice').todo).toMatchObject({ owner: '小王', ownerOpenId: null })
    const mine = todo.create(dm, { title: '私聊事项', owner: '小王' }, 'alice')
    expect(todo.update(mine.todo.id, dm, { current: true, patch: { owner: null } }, 'alice').todo).toMatchObject({ owner: null, ownerOpenId: 'alice' })
  })

  it('applies an explicit chat instruction to the current version but still rejects stale console forms', () => {
    const { app: todo } = app()
    const saved = todo.create(audience, { title: '原标题', dueMs: 100 }, 'alice')
    todo.update(saved.todo.id, audience, { current: true, patch: { title: '别人先改的标题' } }, 'alice')
    expect(todo.update(saved.todo.id, audience, { current: true, patch: { dueMs: 200 } }, 'alice').todo).toMatchObject({ title: '别人先改的标题', dueMs: 200 })
    expect(() => todo.update(saved.todo.id, audience, { expectedTag: saved.tag, patch: { dueMs: 300 } }, 'alice')).toThrowError(expect.objectContaining({ status: 409 }))
  })

  it('deletes a Todo that never reached Feishu, but cancels one with a native link or an in-flight/unknown native operation', () => {
    const { app: todo, db, todos } = app()
    ensureFeishuTaskSyncSchema(db)
    const plain = todo.create(audience, { title: '记错了的事' }, 'alice').todo
    expect(todo.remove(plain.id, audience, { current: true }, 'alice')).toEqual({ outcome: 'deleted', id: plain.id })
    expect(todos.get(plain.id)).toBeUndefined()

    const linked = todo.create(audience, { title: '已进飞书' }, 'alice').todo
    db.prepare("INSERT INTO feishu_task_links(todo_id,guid,created_at,synced_at) VALUES (?, 'g1', 1, 1)").run(linked.id)
    const creating = todo.create(audience, { title: '正在建飞书任务' }, 'alice').todo
    db.prepare(`INSERT INTO feishu_task_operations(id,todo_id,generation,kind,payload_json,state,created_at,updated_at)
      VALUES ('op-1', ?, 0, 'create', '{}', 'started', 1, 1)`).run(creating.id)
    const rejected = todo.create(audience, { title: '建飞书任务被明确拒绝' }, 'alice').todo
    db.prepare(`INSERT INTO feishu_task_operations(id,todo_id,generation,kind,payload_json,state,created_at,updated_at)
      VALUES ('op-2', ?, 0, 'create', '{}', 'rejected', 1, 1)`).run(rejected.id)
    for (const item of [linked, creating]) {
      const result = todo.remove(item.id, audience, { current: true }, 'alice')
      expect(result).toMatchObject({ outcome: 'cancelled', todo: { id: item.id, status: 'cancelled', statusBy: 'alice', statusNote: '记错了，已删除' } })
      expect(todos.get(item.id)?.status).toBe('cancelled')
    }
    expect(todo.remove(rejected.id, audience, { current: true }, 'alice').outcome).toBe('deleted')

    const done = todo.create(audience, { title: '已完成且已同步' }, 'alice').todo
    todo.update(done.id, audience, { current: true, patch: { status: 'done' } }, 'alice')
    db.prepare("INSERT INTO feishu_task_links(todo_id,guid,created_at,synced_at) VALUES (?, 'g2', 1, 1)").run(done.id)
    expect(todo.remove(done.id, audience, { current: true }, 'alice')).toMatchObject({ outcome: 'cancelled', todo: { status: 'cancelled', doneAt: null } })
    expect(() => todo.remove(done.id, { ...audience, scope: 'space:elsewhere' }, { current: true }, 'alice')).toThrowError(expect.objectContaining({ status: 404 }))
  })
})
