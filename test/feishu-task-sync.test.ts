/**
 * 待办进飞书自己的「任务」。
 *
 * 他的原话：「你不能记到我的 todo 里面吗？就是飞书任务。」
 * Friday 的清单只活在对话里；指派、截止、原生提醒、手机上那个小红点都在飞书任务那边。
 *
 * 这组用例守四件事，每件都是"别把人的任务列表弄脏"的一个侧面：
 *
 * 1. **候选不进去**。群里自动提取的待办是候选——Friday 自己的清单可以先收着（人不要就删），
 *    但往别人的任务列表里塞一条他没点头的事是另一回事。
 * 2. **没有主人就不建**。一个不属于任何人的任务谁也看不到，却已经存在了。
 * 3. **完成和重开都按双方上次同步快照判断**，不把旧完成状态覆盖人的新操作。
 * 4. **权限被拒暂缓**，配置变化或冷却后可恢复；未知写入不能当权限拒绝重发。
 */
import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { FeishuTaskSync } from '../src/core/feishu-task-sync.js'
import { FeishuTaskError, type FeishuTask } from '../src/feishu/tasks.js'
import { Todos } from '../src/core/todos.js'

const NOW = 1_800_000_000_000
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never

function setup(over: { failCreate?: unknown } = {}) {
  const db = new DatabaseSync(':memory:')
  const todos = new Todos(db)
  const remote = new Map<string, FeishuTask>()
  let seq = 0
  let clock = NOW
  const created: { summary: string; assignees?: readonly string[]; token: string }[] = []
  const tasks = {
    create: vi.fn(async (input: { summary: string; assigneeOpenIds?: readonly string[]; clientToken: string; completedAtMs?: number; dueMs?: number | null }) => {
      if (over.failCreate) throw over.failCreate
      created.push({ summary: input.summary, assignees: input.assigneeOpenIds, token: input.clientToken })
      const t: FeishuTask = { guid: `g${++seq}`, summary: input.summary, completedAt: input.completedAtMs, url: `https://f/task/g${seq}` }
      remote.set(t.guid, t)
      return t
    }),
    setCompleted: vi.fn(async (guid: string, done: boolean, at: number) => {
      const t = { ...remote.get(guid)!, completedAt: done ? at : undefined }
      remote.set(guid, t)
      return t
    }),
    get: vi.fn(async (guid: string) => remote.get(guid)!),
    patch: vi.fn(async (guid: string, patch: { summary?: string; description?: string | null; dueMs?: number | null; completedAtMs?: number }) => {
      const task = { ...remote.get(guid)!,
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.dueMs !== undefined ? { dueMs: patch.dueMs } : {}),
        ...(patch.completedAtMs !== undefined ? { completedAt: patch.completedAtMs || undefined } : {}),
      }
      remote.set(guid, task); return task
    }),
  }
  const sync = new FeishuTaskSync({ db, todos, tasks: tasks as never, log, now: () => clock++ })
  return { db, todos, tasks, sync, remote, created }
}

const add = (t: ReturnType<typeof setup>, over: Record<string, unknown> = {}) =>
  t.todos.add({ scope: 'space:sp_a', title: '排查 bad case', confirmed: true, ownerOpenId: 'ou_alice', ...over })

describe('哪些事该进人的任务列表', () => {
  it('确认过的、有负责人的，建过去并指派给他', async () => {
    const t = setup()
    add(t)
    const r = await t.sync.sweep()
    expect(r.created).toBe(1)
    expect(t.created[0]!.assignees).toEqual(['ou_alice'])
    expect(t.created[0]!.summary).toBe('排查 bad case')
  })

  it('候选的不进去——他还没点头的事不该出现在他的任务列表里', async () => {
    const t = setup()
    add(t, { confirmed: false })
    const r = await t.sync.sweep()
    expect(r.created).toBe(0)
    expect(t.tasks.create).not.toHaveBeenCalled()
  })

  it('负责人不明时不猜：群里没指定负责人的不建；只在本人私聊里未点名他人时归本人', async () => {
    const t = setup()
    add(t, { ownerOpenId: undefined, createdBy: 'ou_bob' })
    add(t, { scope: 'space:sp_dm_ou_bob', ownerOpenId: undefined, owner: '小王', createdBy: 'ou_bob' })
    add(t, { scope: 'space:sp_dm_ou_bob', ownerOpenId: undefined, createdBy: 'ou_bob' })
    expect(await t.sync.sweep()).toMatchObject({ created: 1 })
    expect(t.created.map(item => item.assignees)).toEqual([['ou_bob']])
  })

  it('谁都归不到就不建——一个没有主人的任务谁也看不到，也不占每轮的创建名额', async () => {
    const t = setup()
    const todo = add(t, { ownerOpenId: undefined, createdBy: undefined })
    const r = await t.sync.sweep()
    expect(r.created).toBe(0)
    expect(t.tasks.create).not.toHaveBeenCalled()
    expect(t.sync.view(todo)).toMatchObject({ state: 'owner_unknown' })
  })

  it('已取消的不进去', async () => {
    const t = setup()
    const todo = add(t)
    t.todos.transition(todo.id, todo.scope, 'cancelled')
    const r = await t.sync.sweep()
    expect(r.created).toBe(0)
  })

  it('同一创建收据持久保存幂等键，已有镜像不重建', async () => {
    const t = setup()
    const todo = add(t)
    await t.sync.sweep()
    await t.sync.sweep()
    expect(t.created).toHaveLength(1)
    const operation = t.db.prepare('SELECT id,payload_json FROM feishu_task_operations WHERE todo_id=?').get(todo.id)!
    expect(t.created[0]!.token).toBe(FeishuTaskSync.clientToken(todo.id, 0, String(operation.id)))
    expect(JSON.parse(String(operation.payload_json)).token).toBe(t.created[0]!.token)
  })
})

describe('两边的完成状态', () => {
  it('完成镜像也公平轮询，后续事项不会饥饿', async () => {
    const t = setup()
    const first = add(t), second = add(t)
    await t.sync.sweep(2)
    t.todos.transition(first.id, first.scope, 'done')
    await t.sync.sweep(2)
    const link = t.sync.link(second.id)!
    t.remote.set(link.guid, { ...t.remote.get(link.guid)!, completedAt: NOW })
    const a = await t.sync.sweep(1), b = await t.sync.sweep(1)
    expect(a.pulledBack + b.pulledBack).toBe(1)
    expect(t.todos.get(second.id)!.status).toBe('done')
  })

  it('already completed local todos are created completed, with the provider receipt recorded', async () => {
    const t = setup(), todo = add(t)
    t.todos.transition(todo.id, todo.scope, 'done', { now: NOW })
    expect(await t.sync.sweep()).toMatchObject({ created: 1 })
    expect(t.tasks.create).toHaveBeenCalledWith(expect.objectContaining({ completedAtMs: NOW }))
    expect(t.remote.get('g1')?.completedAt).toBe(NOW)
    expect(t.sync.link(todo.id)?.completedAt).toBe(NOW)
    await t.sync.sweep()
    expect(t.tasks.setCompleted).not.toHaveBeenCalled()
  })

  it('does not invent a completion receipt when creation returns an incomplete remote task', async () => {
    const t = setup(), todo = add(t)
    t.todos.transition(todo.id, todo.scope, 'done', { now: NOW })
    const original = t.tasks.create.getMockImplementation()!
    t.tasks.create.mockImplementationOnce(input => original({ ...input, completedAtMs: undefined }))
    await t.sync.sweep()
    expect(t.sync.link(todo.id)?.completedAt).toBeNull()
    expect(await t.sync.sweep()).toMatchObject({ completed: 1 })
    expect(t.remote.get('g1')?.completedAt).toBe(NOW)
  })

  it.each(['cancel', 'scope', 'delete', 'owner', 'edit', 'unconfirm'] as const)('does not apply a late remote completion after local %s', async change => {
    const t = setup(), todo = add(t)
    await t.sync.sweep()
    t.tasks.get.mockImplementationOnce(async () => {
      if (change === 'cancel') t.todos.transition(todo.id, todo.scope, 'cancelled')
      if (change === 'scope') t.db.prepare('UPDATE todos SET scope = ? WHERE id = ?').run('space:sp_other', todo.id)
      if (change === 'delete') t.db.prepare('DELETE FROM todos WHERE id = ?').run(todo.id)
      if (change === 'owner') t.todos.update(todo.id, todo.scope, { ownerOpenId: 'ou_bob' })
      if (change === 'edit') t.todos.update(todo.id, todo.scope, { title: '最新明确指令' })
      if (change === 'unconfirm') t.db.prepare('UPDATE todos SET confirmed = 0 WHERE id = ?').run(todo.id)
      return { ...t.remote.get('g1')!, completedAt: NOW }
    })
    const result = await t.sync.sweep()
    expect(result.pulledBack).toBe(0)
    expect(t.todos.get(todo.id)?.status).not.toBe('done')
    expect(t.sync.link(todo.id)?.completedAt).toBeNull()
    expect(t.tasks.patch).not.toHaveBeenCalled()
  })

  it('never polls or revives a locally cancelled linked task', async () => {
    const t = setup(), todo = add(t)
    await t.sync.sweep(); t.todos.transition(todo.id, todo.scope, 'cancelled')
    t.remote.set('g1', { ...t.remote.get('g1')!, completedAt: NOW })
    expect(await t.sync.sweep()).toMatchObject({ pulledBack: 0 })
    expect(t.tasks.get).not.toHaveBeenCalled()
    expect(t.todos.get(todo.id)?.status).toBe('cancelled')
  })

  it('reads each not-yet-created todo again after earlier network awaits', async () => {
    const t = setup(), first = add(t), later = add(t, { title: '过时标题' })
    // Force a deterministic creation order independent from millisecond wall-clock ties.
    t.db.prepare('UPDATE todos SET created_at = ? WHERE id = ?').run(NOW + 1, first.id)
    t.db.prepare('UPDATE todos SET created_at = ? WHERE id = ?').run(NOW, later.id)
    const original = t.tasks.create.getMockImplementation()!
    t.tasks.create.mockImplementationOnce(async input => {
      t.todos.update(later.id, later.scope, { title: '新标题', dueMs: NOW + 60_000 })
      t.todos.transition(later.id, later.scope, 'done', { now: NOW })
      return original(input)
    })
    await t.sync.sweep()
    expect(t.tasks.create.mock.calls[1]![0]).toMatchObject({ summary: '新标题', dueMs: NOW + 60_000, completedAtMs: NOW })
  })

  it('Friday 这边完成了，推到飞书任务', async () => {
    const t = setup()
    const todo = add(t)
    await t.sync.sweep()
    t.todos.transition(todo.id, todo.scope, 'done')
    const r = await t.sync.sweep()
    expect(r.completed).toBe(1)
    expect(t.remote.get('g1')!.completedAt).toBeTruthy()
  })

  it('他直接在飞书任务里勾掉了，Friday 要跟上——不然还会提醒一件做完的事', async () => {
    const t = setup()
    const todo = add(t)
    await t.sync.sweep()
    t.remote.set('g1', { ...t.remote.get('g1')!, completedAt: NOW })
    const r = await t.sync.sweep()
    expect(r.pulledBack).toBe(1)
    expect(t.todos.get(todo.id)!.status).toBe('done')
  })

  it('拉回来的那条写清楚是在哪完成的', async () => {
    const t = setup()
    const todo = add(t)
    await t.sync.sweep()
    t.remote.set('g1', { ...t.remote.get('g1')!, completedAt: NOW })
    await t.sync.sweep()
    expect(t.todos.get(todo.id)!.statusNote).toBe('在飞书任务里完成')
  })

  it('两边都没完成时什么都不改', async () => {
    const t = setup()
    add(t)
    await t.sync.sweep()
    const r = await t.sync.sweep()
    expect(r).toMatchObject({ created: 0, completed: 0, pulledBack: 0 })
  })

  it('已经同步过完成的不再重复推', async () => {
    const t = setup()
    const todo = add(t)
    await t.sync.sweep()
    t.todos.transition(todo.id, todo.scope, 'done')
    await t.sync.sweep()
    t.tasks.patch.mockClear()
    await t.sync.sweep()
    expect(t.tasks.patch).not.toHaveBeenCalled()
  })
})

describe('权限没批之前', () => {
  it('被以权限理由拒绝就停下，不反复重试', async () => {
    const t = setup({ failCreate: new FeishuTaskError('建任务', 99991672, 'permission denied') })
    add(t)
    const first = await t.sync.sweep()
    expect(first.blocked).toBe(true)
    t.tasks.create.mockClear()
    const second = await t.sync.sweep()
    expect(second.blocked).toBe(true)
    expect(t.tasks.create).not.toHaveBeenCalled()
  })

  it('普通失败只跳过这一条，不把整件事关掉', async () => {
    // 一次网络抖动不该让所有人的任务同步从此停摆。
    const t = setup({ failCreate: new Error('socket hang up') })
    add(t)
    const r = await t.sync.sweep()
    expect(r.blocked).toBeUndefined()
    expect(r.created).toBe(0)
  })
})
