import { DatabaseSync } from 'node:sqlite'
import type { Client } from '@larksuiteoapi/node-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bitable } from '../src/feishu/bitable.js'
import { PmoStore, PmoSyncStopped, syncWorkItems } from '../src/core/pmo.js'
import { Todos } from '../src/core/todos.js'

const databases: DatabaseSync[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks() })

/** Only the SDK transport is fake: actual Bitable pagination/field normalization, PMO and SQLite run. */
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const todos = new Todos(db), store = new PmoStore(db)
  const binding = { appToken: 'base', tableId: 'table', spaceId: 'sp_a', boundBy: 'alice', url: 'synthetic' }
  const space = { id: 'sp_a', kind: 'group', status: 'active' } as const
  store.claim(binding)
  const rows = new Map<string, Record<string, unknown>>()
  const state: { failRead?: boolean; omitCreate?: boolean; omitUpdate?: boolean; lostUpdateAck?: boolean;
    afterRead?: () => void; afterUpdate?: () => void } = {}
  let nextId = 0
  const sdk = {
    list: vi.fn(async () => {
      if (state.failRead) throw new Error('synthetic read failure')
      const data = { items: [...rows].map(([record_id, fields]) => ({ record_id, fields: structuredClone(fields) })), has_more: false }
      state.afterRead?.()
      return { code: 0, data }
    }),
    batchCreate: vi.fn(async ({ data }: { data: { records: { fields: Record<string, unknown> }[] } }) => ({ code: 0, data: {
      records: data.records.map(record => {
        const record_id = `rec${++nextId}`
        if (!state.omitCreate) rows.set(record_id, structuredClone(record.fields))
        return { record_id }
      }),
    } })),
    batchUpdate: vi.fn(async ({ data }: { data: { records: { record_id: string; fields: Record<string, unknown> }[] } }) => {
      if (!state.omitUpdate) for (const record of data.records) Object.assign(rows.get(record.record_id)!, structuredClone(record.fields))
      state.afterUpdate?.()
      if (state.lostUpdateAck) throw new Error('synthetic lost acknowledgement')
      return { code: 0, data: {} }
    }),
  }
  const bitable = new Bitable({ bitable: { v1: { appTableRecord: sdk } } } as unknown as Client)
  const todo = todos.add({ scope: 'space:sp_a', title: '检查发布', owner: 'Alice', dueMs: Date.now() - 3 * 86400_000 })
  const sync = (assertCurrent?: () => void) => syncWorkItems({ bitable, todos, store, assertCurrent }, binding, space, 'A群')
  return { db, todos, store, binding, space, rows, state, sdk, bitable, todo, sync }
}

describe('PMO uses human table fields and verifies remote writes', () => {
  it('human completion and reassignment remove stale local risk; only the two Friday columns are sent', async () => {
    const t = fixture()
    expect(await t.sync()).toMatchObject({ created: 1, pending: 0 })
    const row = t.rows.get('rec1')!
    Object.assign(row, { 状态: '已完成', 负责人: [{ text: 'Bob' }], 截止时间: Date.now() + 86400_000, 更新时间: 1 })
    expect(await t.sync()).toMatchObject({ updated: 1, pending: 0 })
    expect(row['风险']).toBe('')
    expect(row['Friday 观察']).toContain('表格状态为「已完成」，Friday 账本为「进行中」')
    expect(row['Friday 观察']).toContain('表格负责人为「Bob」，Friday 账本为「Alice」')
    expect(row['Friday 观察']).toContain('表格截止为')
    expect(row['Friday 观察']).not.toMatch(/状态久未更新|没进展|PR|GitHub|群内/)
    expect(t.todos.get(t.todo.id)?.status).toBe('open')
    expect(t.todos.get(t.todo.id)?.owner).toBe('Alice')
    const sent = t.sdk.batchUpdate.mock.calls[0]![0].data.records[0]!.fields
    expect(Object.keys(sent).sort()).toEqual(['Friday 观察', '风险'])
    expect(t.sdk.list).toHaveBeenCalledTimes(4) // create verification; fact read; write preflight; update verification
  })

  it('a cleared risk stays cleared until authoritative facts change; daily elapsed prose cannot bring it back', async () => {
    const t = fixture(); await t.sync()
    const row = t.rows.get('rec1')!; row['风险'] = ''; row['Friday 观察'] = '人工已知悉'
    const later = Date.now() + 5 * 86400_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    expect(await t.sync()).toMatchObject({ skipped: 1, updated: 0 })
    expect(row).toMatchObject({ 风险: '', 'Friday 观察': '人工已知悉' })
    row['负责人'] = 'Bob'
    expect(await t.sync()).toMatchObject({ updated: 1 })
    expect(row['风险']).toBe('已过截止')
    expect(row['Friday 观察']).toContain('表格负责人为「Bob」')
  })

  it('table fields stay authoritative when local todo changes, and no activity evidence is invented', async () => {
    const t = fixture(); await t.sync()
    Object.assign(t.rows.get('rec1')!, { 状态: '进行中', 负责人: '', 截止时间: undefined, 更新时间: 1 })
    t.todos.transition(t.todo.id, t.todo.scope, 'done')
    expect(await t.sync()).toMatchObject({ updated: 1 })
    expect(t.rows.get('rec1')).toMatchObject({ 状态: '进行中', 负责人: '', 风险: '没有负责人' })
    expect(t.rows.get('rec1')!['Friday 观察']).toContain('Friday 账本为「已完成」')
    expect(t.rows.get('rec1')!['Friday 观察']).not.toMatch(/天没变|无人认领|没有进展|PR/)
  })

  it.each(['scope', 'number', 'duplicate', 'missing', 'unreadable', 'malformed'] as const)('does not use local fallback or write when remote identity/fields are %s', async mode => {
    const t = fixture(); await t.sync()
    t.todos.transition(t.todo.id, t.todo.scope, 'done')
    if (mode === 'scope') t.rows.get('rec1')!['作用域'] = 'space:other'
    if (mode === 'number') t.rows.get('rec1')!['编号'] = t.todo.id + 1
    if (mode === 'duplicate') t.rows.set('rec2', { ...t.rows.get('rec1')! })
    if (mode === 'missing') t.rows.delete('rec1')
    if (mode === 'unreadable') t.state.failRead = true
    if (mode === 'malformed') t.rows.get('rec1')!['截止时间'] = 'not a date'
    expect(await t.sync()).toMatchObject({ created: 0, updated: 0, pending: 1 })
    expect(t.sdk.batchCreate).toHaveBeenCalledTimes(1)
    expect(t.sdk.batchUpdate).not.toHaveBeenCalled()
  })

  it('a create acknowledgement without a readable row remains pending and never creates again', async () => {
    const t = fixture(); t.state.omitCreate = true
    expect(await t.sync()).toMatchObject({ created: 0, pending: 1 })
    expect(t.store.count(t.binding)).toBe(0)
    expect(await t.sync()).toMatchObject({ created: 0, pending: 1 })
    expect(t.sdk.batchCreate).toHaveBeenCalledTimes(1)
  })

  it('200 update response is not success without field read-back; restart retains the pending intent without replay', async () => {
    const t = fixture(); await t.sync()
    t.rows.get('rec1')!['状态'] = '已完成'; t.state.omitUpdate = true
    expect(await t.sync()).toMatchObject({ updated: 0, pending: 1 })
    const intent = t.store.pendingWrite(t.binding, t.todo.id)!
    expect(intent).toBeDefined()
    expect(t.store.count(t.binding)).toBe(0)
    const restarted = new PmoStore(t.db)
    expect(await syncWorkItems({ bitable: t.bitable, todos: t.todos, store: restarted }, t.binding, t.space, 'A群')).toMatchObject({ updated: 0, pending: 1 })
    expect(t.sdk.batchUpdate).toHaveBeenCalledTimes(1)
    Object.assign(t.rows.get('rec1')!, intent.fields)
    expect(await t.sync()).toMatchObject({ updated: 0, skipped: 1, pending: 0 })
    expect(t.store.pendingWrite(t.binding, t.todo.id)).toBeUndefined()
    expect(t.store.count(t.binding)).toBe(1)
    expect(t.sdk.batchUpdate).toHaveBeenCalledTimes(1)
  })

  it('unknown update acknowledgement can be confirmed by actual read-back', async () => {
    const t = fixture(); await t.sync()
    t.rows.get('rec1')!['状态'] = '已完成'; t.state.lostUpdateAck = true
    expect(await t.sync()).toMatchObject({ updated: 1, pending: 0 })
    expect(t.store.pendingWrite(t.binding, t.todo.id)).toBeUndefined()
    expect(await t.sync()).toMatchObject({ skipped: 1 })
    expect(t.sdk.batchUpdate).toHaveBeenCalledTimes(1)
  })

  it('a person changing facts during the update prevents stale success; the landed write is confirmed and the next round follows the new facts', async () => {
    const t = fixture(); await t.sync()
    t.rows.get('rec1')!['状态'] = '已完成'
    t.state.afterUpdate = () => { t.rows.get('rec1')!['状态'] = '阻塞' }
    expect(await t.sync()).toMatchObject({ updated: 0, pending: 1 })
    expect(t.rows.get('rec1')!['状态']).toBe('阻塞')
    expect(t.store.pendingWrite(t.binding, t.todo.id)).toBeUndefined()
    t.state.afterUpdate = undefined
    expect(await t.sync()).toMatchObject({ updated: 1, pending: 0 })
    expect(t.rows.get('rec1')!['Friday 观察']).toContain('表格状态为「阻塞」')
  })

  it('re-reads human fields after another row creation before sending the prepared update', async () => {
    const t = fixture(); await t.sync()
    t.rows.get('rec1')!['状态'] = '阻塞'
    t.todos.add({ scope: t.todo.scope, title: '并行新增' })
    const create = t.sdk.batchCreate.getMockImplementation()!
    t.sdk.batchCreate.mockImplementationOnce(async request => {
      const response = await create(request)
      t.rows.get('rec1')!['状态'] = '已完成'
      return response
    })
    expect(await t.sync()).toMatchObject({ created: 1, updated: 1, pending: 0 })
    expect(t.rows.get('rec1')!['风险']).toBe('')
    expect(t.rows.get('rec1')!['Friday 观察']).toContain('表格状态为「已完成」')
    expect(t.rows.get('rec1')!['Friday 观察']).not.toContain('阻塞')
  })

  it('overlapping sync reserves one update while the first request is in flight', async () => {
    const t = fixture(); await t.sync()
    t.rows.get('rec1')!['状态'] = '已完成'
    let started!: () => void, finish!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const release = new Promise<void>(resolve => { finish = resolve })
    const update = t.sdk.batchUpdate.getMockImplementation()!
    t.sdk.batchUpdate.mockImplementationOnce(async request => { started(); await release; return update(request) })
    const first = t.sync(); await entered
    expect(await t.sync()).toMatchObject({ updated: 0, pending: 1 })
    finish()
    expect(await first).toMatchObject({ updated: 1, pending: 0 })
    expect(t.sdk.batchUpdate).toHaveBeenCalledTimes(1)
  })

  it('legacy fingerprints establish a baseline without restoring a previously cleared risk', async () => {
    const t = fixture(); await t.sync()
    t.store.remember(t.binding, t.todo.id, 'rec1', 'old-local-only-fingerprint')
    Object.assign(t.rows.get('rec1')!, { 风险: '', 'Friday 观察': '人工已知悉' })
    const reopened = new PmoStore(t.db)
    expect(await syncWorkItems({ bitable: t.bitable, todos: t.todos, store: reopened }, t.binding, t.space, 'A群'))
      .toMatchObject({ updated: 0, skipped: 1, pending: 0 })
    expect(t.rows.get('rec1')).toMatchObject({ 风险: '', 'Friday 观察': '人工已知悉' })
    // v4 = v3 的观察/风险两段加「关联」一段（这里没给 links，这一段按空记）
    expect(reopened.get(t.binding, t.todo.id)?.fingerprint).toMatch(/^v4:/)
    expect(t.sdk.batchUpdate).not.toHaveBeenCalled()
  })

  it('revocation during read stops before writing, and revocation during write preserves pending evidence', async () => {
    const t = fixture(); await t.sync()
    t.rows.get('rec1')!['状态'] = '已完成'
    let active = true
    const current = () => { if (!active) throw new PmoSyncStopped() }
    t.state.afterRead = () => { active = false }
    await expect(t.sync(current)).rejects.toThrow(PmoSyncStopped)
    expect(t.sdk.batchUpdate).not.toHaveBeenCalled()
    active = true; t.state.afterRead = undefined
    t.state.afterUpdate = () => { active = false }
    await expect(t.sync(current)).rejects.toThrow(PmoSyncStopped)
    expect(t.store.pendingWrite(t.binding, t.todo.id)).toBeDefined()
    expect(t.sdk.batchUpdate).toHaveBeenCalledTimes(1)
  })

  it('Bitable rechecks every pagination await and does not treat a missing next token as complete', async () => {
    let active = true
    const current = () => { if (!active) throw new PmoSyncStopped() }
    const list = vi.fn(async () => {
      active = false
      return { code: 0, data: { items: [], has_more: true, page_token: 'second' } }
    })
    const bitable = new Bitable({ bitable: { v1: { appTableRecord: { list } } } } as unknown as Client)
    await expect(bitable.listRecords('base', 'table', { assertCurrent: current })).rejects.toThrow(PmoSyncStopped)
    expect(list).toHaveBeenCalledTimes(1)
    list.mockResolvedValueOnce({ code: 0, data: { items: [], has_more: true, page_token: '' } })
    expect(await bitable.listRecords('base', 'table')).toMatchObject({ complete: false })
  })

  it('a cleared risk stays cleared when only the Friday ledger changes; only the observation column is written', async () => {
    const t = fixture(); await t.sync()
    const row = t.rows.get('rec1')!; row['风险'] = ''
    t.todos.update(t.todo.id, t.todo.scope, { owner: 'Carol' })
    expect(await t.sync()).toMatchObject({ updated: 1, pending: 0 })
    expect(row['风险']).toBe('')
    expect(row['Friday 观察']).toContain('Friday 账本为「Carol」')
    expect(Object.keys(t.sdk.batchUpdate.mock.calls.at(-1)![0].data.records[0]!.fields)).toEqual(['Friday 观察'])
  })

  it('an update that never landed is resent with the same values after the delay, at most three sends, then waits for a person', async () => {
    const t = fixture(); await t.sync()
    let clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    t.rows.get('rec1')!['状态'] = '已完成'; t.state.omitUpdate = true
    expect(await t.sync()).toMatchObject({ updated: 0, pending: 1 })
    expect(await t.sync()).toMatchObject({ pending: 1 }); expect(t.sdk.batchUpdate).toHaveBeenCalledTimes(1)
    for (let sends = 2; sends <= 3; sends++) { clock += 61_000; expect(await t.sync()).toMatchObject({ pending: 1 }); expect(t.sdk.batchUpdate).toHaveBeenCalledTimes(sends) }
    const [first, retry] = [t.sdk.batchUpdate.mock.calls[0]![0].data.records[0]!.fields, t.sdk.batchUpdate.mock.calls[2]![0].data.records[0]!.fields]
    expect(retry).toEqual(first)
    clock += 61_000; t.state.omitUpdate = false
    expect(await t.sync()).toMatchObject({ pending: 1 }); expect(t.sdk.batchUpdate).toHaveBeenCalledTimes(3)
    expect(t.store.pendingWrite(t.binding, t.todo.id)).toMatchObject({ attempts: 3 })
    expect(t.store.abandonPendingWrite(t.binding, t.todo.id)).toBe(true)
    expect(await t.sync()).toMatchObject({ updated: 1, pending: 0 })
    expect(t.rows.get('rec1')!['Friday 观察']).toContain('表格状态为「已完成」')
  })

  it('a resend stops when the facts changed meanwhile; the unresolved write is not replayed over the newer decision', async () => {
    const t = fixture(); await t.sync()
    let clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    t.rows.get('rec1')!['状态'] = '已完成'; t.state.omitUpdate = true
    await t.sync()
    t.rows.get('rec1')!['状态'] = '阻塞'; clock += 61_000
    expect(await t.sync()).toMatchObject({ pending: 1 })
    expect(t.sdk.batchUpdate).toHaveBeenCalledTimes(1)
  })

  it('a definitive platform rejection drops the pending write and re-plans; a server error stays unresolved', async () => {
    const t = fixture(); await t.sync()
    t.rows.get('rec1')!['状态'] = '已完成'
    t.sdk.batchUpdate.mockResolvedValueOnce({ code: 1254060, msg: 'TextFieldConvFail' } as never)
    expect(await t.sync()).toMatchObject({ updated: 0, pending: 0, rejected: 1 })
    expect(t.store.pendingWrite(t.binding, t.todo.id)).toBeUndefined()
    expect(await t.sync()).toMatchObject({ updated: 1 })
    t.rows.get('rec1')!['状态'] = '阻塞'
    t.sdk.batchUpdate.mockResolvedValueOnce({ code: 1255001, msg: 'InternalError' } as never)
    expect(await t.sync()).toMatchObject({ updated: 0, pending: 1, rejected: 0 })
    expect(t.store.pendingWrite(t.binding, t.todo.id)).toBeDefined()
  })

  it('a person editing the Friday columns while a write is unresolved wins; the write is dropped without resending', async () => {
    const t = fixture(); await t.sync()
    t.rows.get('rec1')!['状态'] = '已完成'; t.state.omitUpdate = true
    await t.sync()
    t.rows.get('rec1')!['Friday 观察'] = '人工写的说明'; t.state.omitUpdate = false
    expect(await t.sync()).toMatchObject({ pending: 0, updated: 0 })
    expect(t.store.pendingWrite(t.binding, t.todo.id)).toBeUndefined()
    expect(t.rows.get('rec1')!['Friday 观察']).toBe('人工写的说明')
    expect(await t.sync()).toMatchObject({ skipped: 1 })
    expect(t.sdk.batchUpdate).toHaveBeenCalledTimes(1)
  })

  it('a rate-limited row creation is released as rejected and created on a later round, never left pending', async () => {
    const t = fixture()
    t.sdk.batchCreate.mockResolvedValueOnce({ code: 99991400, msg: 'request trigger frequency limit' } as never)
    expect(await t.sync()).toMatchObject({ created: 0, pending: 0, rejected: 1 })
    expect(t.store.get(t.binding, t.todo.id)).toBeUndefined()
    expect(await t.sync()).toMatchObject({ created: 1, pending: 0 })
    expect(t.rows.size).toBe(1)
  })
})
