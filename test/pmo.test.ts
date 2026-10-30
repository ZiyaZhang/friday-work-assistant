import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { Todos } from '../src/core/todos.js'
import { PmoStore, PmoSyncStopped, PMO_FIELDS, PMO_TABLE, syncWorkItems, toFields } from '../src/core/pmo.js'
import type { Bitable } from '../src/feishu/bitable.js'

/** 只记调用、不联网的假多维表格 */
function fakeBitable() {
  const rows = new Map<string, Record<string, unknown>>()
  const destinations = new Map<string, string>()
  const calls = { created: 0, updated: 0 }
  let n = 0
  const b = {
    async listRecords(app: string, table: string) {
      return { records: [...rows].filter(([id]) => !destinations.has(id) || destinations.get(id) === `${app}/${table}`)
        .map(([recordId, fields]) => ({ recordId, fields })), complete: true }
    },
    async batchCreate(_a: string, _t: string, recs: { fields: Record<string, unknown> }[]) {
      calls.created += recs.length
      return recs.map((r) => {
        const id = `rec${++n}`
        rows.set(id, r.fields)
        destinations.set(id, `${_a}/${_t}`)
        return id
      })
    },
    async batchUpdate(_a: string, _t: string, recs: { recordId: string; fields: Record<string, unknown> }[]) {
      calls.updated += recs.length
      // 飞书 batch_update 是**按字段合并**的：没传的列原样留着。
      // 这里原来写的是整行替换，于是「只写自己那两列」在测试里看起来像把别的列清空了——
      // 替身比真接口更粗暴，守不住真正要守的东西。
      for (const r of recs) rows.set(r.recordId, { ...rows.get(r.recordId), ...r.fields })
      return recs.length
    },
  }
  return { bitable: b as unknown as Bitable, rows, calls }
}

describe('PMO 看板同步', () => {
  it.each(['deleted', 'moved', 'edited'] as const)('远端读取期间新事项被 %s，发送前使用当前本地事实', async change => {
    const db = new DatabaseSync(':memory:'), todos = new Todos(db), store = new PmoStore(db)
    try {
      const { bitable, rows, calls } = fakeBitable()
      const space = { id: 'sp_fresh', kind: 'group', status: 'active' } as const
      const binding = { appToken: 'synthetic', tableId: 'synthetic', url: 'u', spaceId: space.id, boundBy: 'owner' }
      store.claim(binding)
      const scope = `space:${space.id}`
      todos.add({ scope, title: '已投影事项' })
      await syncWorkItems({ bitable, todos, store }, binding, space, '合成群')
      const todo = todos.add({ scope, title: '应当撤回的旧标题', owner: '旧负责人' })
      const read = bitable.listRecords.bind(bitable)
      vi.spyOn(bitable, 'listRecords').mockImplementationOnce(async (...args) => {
        const result = await read(...args)
        if (change === 'deleted') todos.remove(todo.id, scope)
        else if (change === 'moved') db.prepare('UPDATE todos SET scope = ? WHERE id = ?').run('space:sp_other', todo.id)
        else todos.update(todo.id, scope, { title: '当前已更正标题', owner: '新负责人' })
        return result
      })
      const result = await syncWorkItems({ bitable, todos, store }, binding, space, '合成群')
      const projected = [...rows.values()].find(row => row['编号'] === todo.id)
      expect(JSON.stringify([...rows.values()])).not.toContain('应当撤回的旧标题')
      if (change === 'edited') {
        expect(projected).toMatchObject({ 事项: '当前已更正标题', 负责人: '新负责人' })
        expect(result.created).toBe(1)
        expect(calls.created).toBe(2)
      } else {
        expect(projected).toBeUndefined()
        expect(store.get(binding, todo.id)).toBeUndefined()
        expect(result.created).toBe(0)
        expect(calls.created).toBe(1)
      }
    } finally { db.close() }
  })

  it('新增 / 变了才更新 / 没变就跳过；只导出绑定群空间', async () => {
    const db = new DatabaseSync(':memory:')
    const todos = new Todos(db)
    const store = new PmoStore(db)
    const { bitable, rows, calls } = fakeBitable()
    const space = { id: 'sp_abc', kind: 'group', status: 'active' } as const
    const binding = { appToken: 'bas1', tableId: 'tbl1', url: 'u', spaceId: space.id, boundBy: 'owner' }
    expect(store.claim(binding)).toBe(true)
    const scope = 'space:sp_abc'
    const a = todos.add({ scope, kind: 'freeze', title: 'v1.2 封版', dueMs: 1_800_000_000_000, owner: '张三' })
    todos.add({ scope, title: '补单测' })

    let r = await syncWorkItems({ bitable, todos, store }, binding, space, '研发群')
    expect(r).toMatchObject({ created: 2, updated: 0, skipped: 0 })
    expect(rows.size).toBe(2)
    expect([...rows.values()].find((f) => f['事项'] === 'v1.2 封版')).toMatchObject({ 类型: '封版', 状态: '进行中', 负责人: '张三', 空间: '研发群', 已确认: true })

    // 再同步一次：内容没变，一行都不重写
    r = await syncWorkItems({ bitable, todos, store }, binding, space, '研发群')
    expect(r).toMatchObject({ created: 0, updated: 0, skipped: 2 })

    // 状态变了才更新那一行
    todos.transition(a.id, scope, 'blocked', { note: '等权限' })
    r = await syncWorkItems({ bitable, todos, store }, binding, space, '研发群')
    expect(r).toMatchObject({ created: 0, updated: 1, skipped: 1 })
    // 更新只碰 Friday 自己那两列。状态留在建行时写的那一版——**那一列归人**，
    // 整行写回去会把人在表里的修改覆盖掉（复现过：「已完成 / Bob」被改回「进行中 / Alice」）。
    const rowA = [...rows.values()].find((f) => f['编号'] === a.id)!
    expect(rowA['状态']).toBe('进行中')
    expect(rowA).toHaveProperty('Friday 观察')
    expect(rowA).toHaveProperty('风险')
    expect(calls.created).toBe(2)
    expect(calls.updated).toBe(1)

    // 调用方不能把别的可读作用域夹进导出范围。
    todos.add({ scope: 'space:sp_dm_ou_x', title: '我的私事' })
    todos.add({ scope: 'space:sp_other', title: '其他群事项' })
    todos.add({ scope: 'org', title: '企业事项' })
    todos.add({ scope: 'circle:test', title: '联盟事项' })
    r = await syncWorkItems({ bitable, todos, store }, binding, space, '研发群')
    expect(r.total).toBe(2)
    expect([...rows.values()].some((f) => f['事项'] === '我的私事')).toBe(false)
  })

  it('同一事项重绑到不同表时重新创建行，不复用其他表的 record id', async () => {
    const db = new DatabaseSync(':memory:')
    const todos = new Todos(db)
    const store = new PmoStore(db)
    const { bitable, rows, calls } = fakeBitable()
    const space = { id: 'sp_a', kind: 'group', status: 'active' } as const
    const a = { spaceId: space.id, boundBy: 'owner', appToken: 'base1', tableId: 'table1', url: 'a' }
    const b = { ...a, tableId: 'table2', url: 'b' }
    const c = { ...a, appToken: 'base2', url: 'c' }
    store.claim(a)
    store.claim(c)
    const todo = todos.add({ scope: 'space:sp_a', title: '发布' })
    for (const binding of [a, b, c]) {
      expect(await syncWorkItems({ bitable, todos, store }, binding, space, 'A群')).toMatchObject({ created: 1, updated: 0 })
    }
    expect(calls).toEqual({ created: 3, updated: 0 })
    expect(new Set([store.get(a, todo.id)?.recordId, store.get(b, todo.id)?.recordId, store.get(c, todo.id)?.recordId]).size).toBe(3)
    todos.transition(todo.id, todo.scope, 'blocked', { note: '等构建' })
    await syncWorkItems({ bitable, todos, store }, b, space, 'A群')
    // 两张表各自独立：只有 b 被写过一次，a 那一行原样不动。
    // （状态两边都还是建行时的值——更新不碰那一列，它归人。）
    expect(calls).toMatchObject({ created: 3, updated: 1 })
    expect(rows.get(store.get(a, todo.id)!.recordId)?.['状态']).toBe('进行中')
    expect(rows.get(store.get(b, todo.id)!.recordId)?.['状态']).toBe('进行中')
    expect(store.count(a)).toBe(1)
    expect(store.count(b)).toBe(1)
  })

  it('拒绝私聊、停用空间、不匹配的绑定和不同群共用同一 base', async () => {
    const db = new DatabaseSync(':memory:')
    const todos = new Todos(db)
    const store = new PmoStore(db)
    const { bitable, calls } = fakeBitable()
    const group = { id: 'sp_a', kind: 'group', status: 'active' } as const
    const binding = { spaceId: group.id, boundBy: 'owner', appToken: 'base1', tableId: 'table1', url: 'a' }
    store.claim(binding)
    const dm = { id: 'sp_dm_alice', kind: 'p2p', status: 'active' } as const
    todos.add({ scope: 'space:sp_dm_alice', title: '私事' })
    await expect(syncWorkItems({ bitable, todos, store }, { ...binding, spaceId: dm.id }, dm, '私聊')).rejects.toThrow('当前群空间')
    await expect(syncWorkItems({ bitable, todos, store }, binding, { ...group, status: 'archived' }, '停用')).rejects.toThrow('当前群空间')
    await expect(syncWorkItems({ bitable, todos, store }, binding, { ...group, id: 'sp_b' }, 'B群')).rejects.toThrow('当前群空间')
    expect(store.claim({ ...binding, spaceId: 'sp_b', tableId: 'different-table' })).toBe(false)
    expect(calls).toEqual({ created: 0, updated: 0 })
  })

  it('旧版缺少目标表的 record 映射保留但不自动复用', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec("CREATE TABLE pmo_records (todo_id INTEGER PRIMARY KEY, record_id TEXT, fingerprint TEXT, synced_at INTEGER); INSERT INTO pmo_records VALUES (1, 'legacy-record', 'old', 0)")
    const todos = new Todos(db)
    const store = new PmoStore(db)
    const { bitable } = fakeBitable()
    const space = { id: 'sp_a', kind: 'group', status: 'active' } as const
    const binding = { spaceId: space.id, boundBy: 'owner', appToken: 'base1', tableId: 'table1', url: 'a' }
    store.claim(binding)
    todos.add({ scope: 'space:sp_a', title: '发布' })
    expect(await syncWorkItems({ bitable, todos, store }, binding, space, 'A群')).toMatchObject({ created: 1, updated: 0 })
    expect(db.prepare('SELECT record_id FROM pmo_records').get()).toMatchObject({ record_id: 'legacy-record' })
  })

  it('表结构里该有的列都在，字段映射不丢状态说明', () => {
    expect(PMO_TABLE).toBe('工作项')
    const names = PMO_FIELDS.map((f) => f.field_name)
    for (const n of ['事项', '编号', '类型', '状态', '负责人', '截止时间', '空间', '已确认', '状态说明', '更新时间', '作用域']) expect(names).toContain(n)
    const db = new DatabaseSync(':memory:')
    const todos = new Todos(db)
    const t = todos.add({ scope: 'space:sp_a', title: 'x' })
    const blocked = todos.transition(t.id, 'space:sp_a', 'blocked', { note: '缺环境' })!
    expect(toFields(blocked, '研发群')).toMatchObject({ 状态: '阻塞', 状态说明: '缺环境', 空间: '研发群', 作用域: 'space:sp_a' })
  })
})

describe('PMO 建行先占位，回执不明只核验', () => {
  function setup() {
    const db = new DatabaseSync(':memory:')
    const todos = new Todos(db)
    const store = new PmoStore(db)
    const fake = fakeBitable()
    const space = { id: 'sp_a', kind: 'group', status: 'active' } as const
    const binding = { spaceId: space.id, boundBy: 'owner', appToken: 'base1', tableId: 'table1', url: 'a' }
    store.claim(binding)
    const todo = todos.add({ scope: 'space:sp_a', title: '发布', owner: 'Alice' })
    const sync = (assertCurrent?: () => void) => syncWorkItems({ ...fake, todos, store, assertCurrent }, binding, space, 'A群')
    return { db, todos, store, ...fake, space, binding, todo, sync }
  }

  it('飞书已建行但响应丢了，重启后找回原行而不是再建一行，并保留人工修改', async () => {
    const t = setup()
    const create = t.bitable.batchCreate.bind(t.bitable)
    vi.spyOn(t.bitable, 'batchCreate').mockImplementationOnce(async (...args) => {
      await create(...args)
      throw new Error('response lost')
    })
    expect(await t.sync()).toMatchObject({ created: 0, pending: 1 })
    expect(t.store.count(t.binding)).toBe(0)
    expect(t.store.get(t.binding, t.todo.id)?.recordId).toBe('')
    Object.assign(t.rows.get('rec1')!, { 状态: '已完成', 负责人: 'Bob', 风险: '' })
    const restarted = new PmoStore(t.db)
    expect(await syncWorkItems({ bitable: t.bitable, todos: t.todos, store: restarted }, t.binding, t.space, 'A群'))
      .toMatchObject({ created: 0, updated: 1, pending: 0 })
    expect(restarted.get(t.binding, t.todo.id)?.recordId).toBe('rec1')
    expect(restarted.count(t.binding)).toBe(1)
    expect(t.calls.created).toBe(1)
    expect(t.rows.get('rec1')).toMatchObject({ 状态: '已完成', 负责人: 'Bob', 风险: '' })
  })

  it('请求结果不明且表里尚未可见，不凭一次空列表重建', async () => {
    const t = setup()
    const create = vi.spyOn(t.bitable, 'batchCreate').mockRejectedValueOnce(new Error('timeout'))
    expect(await t.sync()).toMatchObject({ created: 0, pending: 1 })
    expect(await t.sync()).toMatchObject({ created: 0, pending: 1 })
    expect(await t.sync()).toMatchObject({ created: 0, pending: 1 })
    expect(create).toHaveBeenCalledTimes(1)
    expect(t.store.count(t.binding)).toBe(0)
  })

  it.each(['incomplete', 'duplicate', 'wrong_scope', 'read_failed'] as const)('核验结果 %s 时不猜原行、不重发', async (mode) => {
    const t = setup()
    const create = t.bitable.batchCreate.bind(t.bitable)
    vi.spyOn(t.bitable, 'batchCreate').mockImplementationOnce(async (...args) => {
      await create(...args)
      throw new Error('response lost')
    })
    await t.sync()
    if (mode === 'incomplete') vi.spyOn(t.bitable, 'listRecords').mockResolvedValue({ records: [{ recordId: 'rec1', fields: t.rows.get('rec1')! }], complete: false })
    if (mode === 'duplicate') t.rows.set('rec2', { ...t.rows.get('rec1')! })
    if (mode === 'wrong_scope') t.rows.get('rec1')!['作用域'] = 'space:sp_other'
    if (mode === 'read_failed') vi.spyOn(t.bitable, 'listRecords').mockRejectedValue(new Error('permission denied'))
    expect(await t.sync()).toMatchObject({ created: 0, updated: 0, pending: 1 })
    expect(t.store.get(t.binding, t.todo.id)?.recordId).toBe('')
    expect(t.calls.created).toBe(1)
  })

  it('重叠同步在第一份请求等待回执时也只能发送一次创建', async () => {
    const t = setup()
    let finish!: (ids: string[]) => void
    const create = vi.spyOn(t.bitable, 'batchCreate').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const first = t.sync()
    expect(t.store.get(t.binding, t.todo.id)?.recordId).toBe('')
    expect(await t.sync()).toMatchObject({ created: 0, pending: 1 })
    // 成功回执必须对应真实可回读的行；只拿到一个 ID 不能宣称完成。
    t.rows.set('original-record', toFields(t.todo, 'A群'))
    finish(['original-record'])
    expect(await first).toMatchObject({ created: 1, pending: 0 })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it.each([
    { offset: -1, firstRecordId: 'rec1', secondRecordId: 'rec2' },
    { offset: 1, firstRecordId: 'rec2', secondRecordId: 'rec1' },
  ])('批量回执数量不足时按编号和作用域核验，不依赖创建/回读顺序（时间差 $offset）', async ({ offset, firstRecordId, secondRecordId }) => {
    const t = setup()
    const second = t.todos.add({ scope: t.todo.scope, title: '验收' })
    // Todos.list 按 created_at DESC 排序；两次 add 是否跨毫秒不能决定本测试的预期。
    t.db.prepare('UPDATE todos SET created_at = ? WHERE id = ?').run(t.todo.createdAt + offset, second.id)
    const create = t.bitable.batchCreate.bind(t.bitable)
    vi.spyOn(t.bitable, 'batchCreate').mockImplementationOnce(async (...args) => (await create(...args)).slice(1))
    expect(await t.sync()).toMatchObject({ created: 0, pending: 2 })
    expect(t.store.get(t.binding, t.todo.id)?.recordId).toBe('')
    expect(t.store.get(t.binding, second.id)?.recordId).toBe('')
    const list = t.bitable.listRecords.bind(t.bitable)
    vi.spyOn(t.bitable, 'listRecords').mockImplementationOnce(async (...args) => {
      const result = await list(...args)
      return { ...result, records: [...result.records].reverse() }
    })
    expect(await t.sync()).toMatchObject({ created: 0, pending: 0, skipped: 2 })
    expect(t.store.get(t.binding, t.todo.id)?.recordId).toBe(firstRecordId)
    expect(t.rows.get(firstRecordId)).toMatchObject({ 编号: t.todo.id, 作用域: t.todo.scope })
    expect(t.store.get(t.binding, second.id)?.recordId).toBe(secondRecordId)
    expect(t.rows.get(secondRecordId)).toMatchObject({ 编号: second.id, 作用域: second.scope })
    expect(t.calls.created).toBe(2)
  })

  it('创建请求期间停用，保留已发送回执，但阻止同一轮后续更新', async () => {
    const t = setup()
    await t.sync()
    t.todos.transition(t.todo.id, t.todo.scope, 'blocked', { note: '等确认' })
    const second = t.todos.add({ scope: t.todo.scope, title: '新事项' })
    let active = true
    const create = t.bitable.batchCreate.bind(t.bitable)
    vi.spyOn(t.bitable, 'batchCreate').mockImplementationOnce(async (...args) => {
      const ids = await create(...args)
      active = false
      return ids
    })
    await expect(t.sync(() => { if (!active) throw new PmoSyncStopped() })).rejects.toThrow(PmoSyncStopped)
    expect(t.store.get(t.binding, second.id)?.recordId).toBe('rec2')
    expect(t.calls.updated).toBe(0)
  })

  it('等待核验列表期间权限撤回，不再创建同一轮的新事项', async () => {
    const t = setup()
    vi.spyOn(t.bitable, 'batchCreate').mockRejectedValueOnce(new Error('timeout'))
    await t.sync()
    t.todos.add({ scope: t.todo.scope, title: '新事项' })
    let active = true
    vi.spyOn(t.bitable, 'listRecords').mockImplementationOnce(async () => {
      active = false
      return { records: [], complete: true }
    })
    await expect(t.sync(() => { if (!active) throw new PmoSyncStopped() })).rejects.toThrow(PmoSyncStopped)
    expect(t.bitable.batchCreate).toHaveBeenCalledTimes(1)
  })
})
