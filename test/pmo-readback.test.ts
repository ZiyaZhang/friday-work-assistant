/**
 * PMO 写入后的回读核验：待核验（pending-create）的行在之后的轮次读回核对上就记正式指纹；
 * 核对不上时保留待核验、不重建，但每轮都要说清楚条数和原因。
 *
 * 生产现象（r80）：4 行一直是 pending-create:v4，定时同步没有任何日志，手动同步只说“还有 4 条尚待核验”。
 * 这里只替换飞书 SDK 的传输层：真实的 Bitable（分页、错误码）、PMO 同步、宿主接线（定时 syncPmo / 手动同步）和 SQLite 都在跑。
 */
import type { Client } from '@larksuiteoapi/node-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator, type AbilityActor } from '../src/core/orchestrator.js'
import { PMO_FIELDS, PmoStore, type PmoBinding } from '../src/core/pmo.js'
import { Registry } from '../src/core/registry.js'
import { spaceScope } from '../src/core/space.js'
import type { TodoProvenance } from '../src/core/todo-provenance.js'
import { Todos } from '../src/core/todos.js'
import { Bitable } from '../src/feishu/bitable.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import type { Logger } from '../src/log.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const SOURCE_URL = 'https://applink.feishu.cn/client/message/link/open?token=synthetic'
const PR_URL = 'https://github.com/org/repo/pull/5095'
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(close => close()); vi.restoreAllMocks() })

/** 飞书对缺接口权限的回答：HTTP 400，响应体里是错误码和要开的权限（SDK 原样抛出 axios 错误）。 */
function scopeDenied(scope: string): Error {
  return Object.assign(new Error('Request failed with status code 400'), { code: 'ERR_BAD_REQUEST',
    response: { status: 400, data: { code: 99991672, msg: `Access denied. One of the following scopes is required: [bitable:app, ${scope}].` } } })
}

function provenance(): TodoProvenance {
  return { version: 1, originRunId: 'run-1', taskId: 1, workKey: 'work-1', selectedInputs: [],
    request: { messageId: 'om_request', chatId: 'group-a', chatType: 'group', senderOpenId: 'alice', msgType: 'text', createTimeMs: 1_800_000_000_000,
      link: { status: 'available', url: SOURCE_URL } },
    contextSnapshot: { version: 1, acpSessionId: 'acp-1', spaceId: 'sp_a', chatId: 'group-a', memoryScopes: [], chats: [], external: [], repositories: [] } }
}

/**
 * 宿主 + 真实 Bitable。表已经由 r77 建好并绑定（绑定记录与 r77 写法相同）；`columns` 是表里现有的列。
 * `state.read`：'ok' 正常；一个 Error 表示每次读记录都抛这个错；'incomplete' 表示分页信息不全。
 * `state.readOnce`：只让下一次读记录抛这个错。`state.fieldCreate`：建列时抛的错。
 */
function fixture(opts: { columns?: string[]; numbersAsStrings?: boolean } = {}) {
  const registry = new Registry(':memory:'); cleanups.push(() => registry.close())
  const cfg = loadConfig({ FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test', FRIDAY_REFLECT: 'off' })
  const sp = spaceDeps(registry.db)
  const a = sp.spaces.ensure({ kind: 'group', chatId: 'group-a', openId: 'alice', title: 'A群' })
  const todos = new Todos(registry.db), pmo = new PmoStore(registry.db), feishu = new FakeFeishu()
  const columns = new Map((opts.columns ?? PMO_FIELDS.map(field => field.field_name)).map(name => [name, PMO_FIELDS.find(field => field.field_name === name)!.type]))
  const rows = new Map<string, Record<string, unknown>>()
  const state: { read: Error | 'ok' | 'incomplete'; readOnce?: Error; fieldCreate?: Error } = { read: 'ok' }
  let nextId = 0
  const record = {
    list: vi.fn(async () => {
      if (state.readOnce) { const error = state.readOnce; state.readOnce = undefined; throw error }
      if (state.read instanceof Error) throw state.read
      // 生产的飞书读记录接口把数字列「编号」返回成字符串；numbersAsStrings 照这个样子回。
      const items = [...rows].map(([record_id, fields]) => ({ record_id, fields: opts.numbersAsStrings && typeof fields['编号'] === 'number'
        ? { ...structuredClone(fields), 编号: String(fields['编号']) } : structuredClone(fields) }))
      return { code: 0, data: state.read === 'incomplete' ? { items, has_more: true, page_token: '' } : { items, has_more: false } }
    }),
    batchCreate: vi.fn(async ({ data }: { data: { records: { fields: Record<string, unknown> }[] } }) => ({ code: 0, data: {
      records: data.records.map(item => {
        const unknown = Object.keys(item.fields).find(name => !columns.has(name))
        if (unknown) throw new Error(`synthetic: unknown field ${unknown}`)
        const record_id = `rec${++nextId}`
        rows.set(record_id, structuredClone(item.fields))
        return { record_id }
      }) } })),
    batchUpdate: vi.fn(async ({ data }: { data: { records: { record_id: string; fields: Record<string, unknown> }[] } }) => {
      for (const item of data.records) Object.assign(rows.get(item.record_id)!, structuredClone(item.fields))
      return { code: 0, data: {} }
    }),
  }
  const field = {
    list: vi.fn(async () => ({ code: 0, data: { items: [...columns].map(([field_name, type]) => ({ field_name, type })) } })),
    create: vi.fn(async ({ data }: { data: { field_name: string; type: number } }) => {
      if (state.fieldCreate) throw state.fieldCreate
      columns.set(data.field_name, data.type)
      return { code: 0, data: { field: data } }
    }),
  }
  const bitable = new Bitable({ bitable: { v1: { appTableRecord: record, appTableField: field } } } as unknown as Client)
  const binding: PmoBinding = { appToken: 'base', tableId: 'table', url: 'https://example.invalid/base/base?table=table', spaceId: a.id, boundBy: 'alice', version: 'r77' }
  pmo.claim(binding)
  registry.setKv(`pmo:binding:${a.id}`, JSON.stringify(binding))
  const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = []
  const log: Logger = {
    debug: () => {}, info: (msg, data) => logs.push({ level: 'info', msg, data }), warn: (msg, data) => logs.push({ level: 'warn', msg, data }),
    error: (msg, data) => logs.push({ level: 'error', msg, data }), child: () => log,
  }
  const orchestrator = new Orchestrator({ cfg, registry, todos, pmo, ...sp, feishu: asFeishuClient(feishu), bitable, runtime: {} as AcpRuntime,
    memory: new ChannelMemory(registry.db), tokens: new TokenIssuer('test'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/unused', botOpenId: 'bot', log })
  const actor: AbilityActor = { sessionKey: 'test', chatId: 'group-a', requesterOpenId: 'alice', chatType: 'group' }
  const fingerprints = () => (registry.db.prepare('SELECT fingerprint FROM pmo_projection_records WHERE app_token = ? AND table_id = ? ORDER BY todo_id')
    .all(binding.appToken, binding.tableId) as { fingerprint: string }[]).map(row => row.fingerprint)
  const logged = (msg: string) => logs.filter(line => line.msg === msg)
  /** 和生产一样的四条待办：三条普通的，一条带出处和 PR 链接（生产的 todo 12）。 */
  const addFour = () => {
    for (const title of ['整理需求', '补单测', '核对验收记录']) todos.add({ scope: spaceScope(a.id), title, owner: 'Alice' })
    todos.add({ scope: spaceScope(a.id), title: `跟进 PR ${PR_URL} 的合并`, owner: 'Alice', provenance: provenance() })
  }
  return { registry, a, todos, pmo, binding, columns, rows, state, record, field, orchestrator, actor, logs, logged, fingerprints, addFour,
    manual: () => orchestrator.abilities.pmo(actor, 'sync') }
}

describe('读回的「编号」是字符串（飞书接口的实际返回）', () => {
  it('建的 4 行读回时「编号」为 "9" 这样的字符串，照样按编号和作用域核对上并记正式指纹', async () => {
    const t = fixture({ numbersAsStrings: true })
    t.addFour()
    const first = await t.orchestrator.syncPmo()
    // 生产在这一轮是 created=0 pending=4（字符串编号对不上）；修正后同一轮就核对上。
    expect(first).toMatchObject({ created: 4, pending: 0 })
    for (const fp of t.fingerprints()) expect(fp).toMatch(/^v4:[0-9a-f]{16}:[0-9a-f]{16}:[0-9a-f]{16}$/)
    expect(t.logged('pmo readback pending')).toEqual([])
    expect(t.record.batchCreate).toHaveBeenCalledTimes(1)
  })

  it('待核验的行在下一轮核对：字符串编号核对上；被人改成非数字的那一行找不到，留待核验、不误认、不重建', async () => {
    const t = fixture({ numbersAsStrings: true })
    t.addFour()
    t.state.readOnce = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    expect(await t.orchestrator.syncPmo()).toMatchObject({ pending: 4 })
    const [recordId] = [...t.rows.keys()]
    t.rows.get(recordId!)!['编号'] = 'abc'
    const second = await t.orchestrator.syncPmo()
    expect(second).toMatchObject({ pending: 1, confirmed: 3 })
    expect(t.fingerprints().filter(fp => fp.startsWith('pending-create:'))).toHaveLength(1)
    expect(t.record.batchCreate).toHaveBeenCalledTimes(1)
    expect(t.logged('pmo readback pending').at(-1)?.data).toMatchObject({ pending: 1, reasons: [{ reason: 'row_not_found', count: 1 }] })
  })
})

describe('待核验的建行在之后的轮次读回核对', () => {
  it('r77 建的表缺「关联」列：补列后建 4 行，建行这一轮读回失败留待核验；下一轮定时同步核对上，记正式指纹并记 info 日志', async () => {
    const t = fixture({ columns: PMO_FIELDS.map(field => field.field_name).filter(name => name !== '关联') })
    t.addFour()
    // 建行后的那一次读记录临时失败（回执已拿到，内容还没读回）。
    t.state.readOnce = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    const first = await t.orchestrator.syncPmo()
    expect(first).toMatchObject({ created: 0, pending: 4 })
    expect(t.field.create.mock.calls.map(([request]) => request.data.field_name)).toEqual(['关联'])
    expect(t.fingerprints()).toHaveLength(4)
    for (const fp of t.fingerprints()) expect(fp).toMatch(/^pending-create:v4:/)

    // 下一轮定时同步：读得到表，4 行按编号和作用域各找到一行，记下正式指纹。
    const second = await t.orchestrator.syncPmo()
    expect(second).toMatchObject({ created: 0, updated: 0, pending: 0 })
    for (const fp of t.fingerprints()) expect(fp).toMatch(/^v4:[0-9a-f]{16}:[0-9a-f]{16}:[0-9a-f]{16}$/)
    expect(t.pmo.count(t.binding)).toBe(4)
    expect(t.record.batchCreate).toHaveBeenCalledTimes(1)
    expect(t.rows.size).toBe(4)
    // 核对上之后「关联」照常：带 PR 链接的那一行写了出处和链接。
    expect([...t.rows.values()].find(row => String(row['事项']).includes(PR_URL))!['关联']).toBe(`出处：原请求 ${SOURCE_URL}\nPR org/repo#5095：未读到 ${PR_URL}`)
    // 两轮各记一条：第一轮 warn（条数、原因），第二轮 info（核对上的条数）。
    expect(t.logged('pmo readback pending')).toEqual([{ level: 'warn', msg: 'pmo readback pending', data: { spaceId: t.a.id, pending: 4,
      reasons: [{ reason: 'read_failed', count: 4, detail: 'socket hang up' }] } }])
    expect(second).toMatchObject({ confirmed: 4 })
    expect(t.logged('pmo readback confirmed')).toEqual([{ level: 'info', msg: 'pmo readback confirmed', data: { spaceId: t.a.id, confirmed: 4 } }])
    // 再下一轮没有要核对的，不再记核对日志。
    expect(await t.orchestrator.syncPmo()).toMatchObject({ skipped: 4, pending: 0, confirmed: 0 })
    expect(t.logged('pmo readback confirmed')).toHaveLength(1)
  })

  it('读记录一直被拒：4 行保持待核验、不重建；定时每轮记 warn（条数、原因、错误码），手动回复写明原因；恢复后下一轮核对上', async () => {
    const t = fixture()
    t.addFour()
    t.state.read = scopeDenied('base:record:retrieve')
    const denied = { reason: 'read_failed', count: 4, code: 99991672,
      detail: 'Access denied. One of the following scopes is required: [bitable:app, base:record:retrieve].' }
    expect(await t.orchestrator.syncPmo()).toMatchObject({ created: 0, pending: 4 })
    expect(await t.orchestrator.syncPmo()).toMatchObject({ created: 0, pending: 4 })
    expect(t.logged('pmo readback pending').map(line => line.data)).toEqual([
      { spaceId: t.a.id, pending: 4, reasons: [denied] }, { spaceId: t.a.id, pending: 4, reasons: [denied] }])
    for (const fp of t.fingerprints()) expect(fp).toMatch(/^pending-create:v4:/)

    const reply = await t.manual()
    expect(reply).toContain('还有 4 条尚待核验')
    expect(reply).toContain('读取表格记录失败：4 条（code=99991672：Access denied. One of the following scopes is required: [bitable:app, base:record:retrieve].）')
    expect(t.logged('pmo synced')).toHaveLength(1)
    expect(t.logged('pmo readback pending')).toHaveLength(3)
    expect(t.record.batchCreate).toHaveBeenCalledTimes(1)

    t.state.read = 'ok'
    expect(await t.orchestrator.syncPmo()).toMatchObject({ pending: 0, confirmed: 4 })
    for (const fp of t.fingerprints()) expect(fp).toMatch(/^v4:/)
    expect(t.logged('pmo readback confirmed').map(line => line.data)).toEqual([{ spaceId: t.a.id, confirmed: 4 }])
    const after = await t.manual()
    expect(after).toContain('同步完成')
    expect(after).not.toContain('待核验')
  })

  it('手动同步做核对的那一轮：回复写明之前待核验的条数已读回核对上，日志和定时同步相同', async () => {
    const t = fixture()
    t.addFour()
    t.state.readOnce = new Error('socket hang up')
    expect(await t.manual()).toContain('还有 4 条尚待核验（读取表格记录失败：4 条（socket hang up））')
    expect(await t.manual()).toContain('同步完成：新增 0、更新 0、没变 4；之前待核验的 4 条已读回核对上（共 4 条，仅来自本群空间）。')
    expect(t.logged('pmo readback pending').map(line => line.data)).toEqual([
      { spaceId: t.a.id, pending: 4, reasons: [{ reason: 'read_failed', count: 4, detail: 'socket hang up' }] }])
    expect(t.logged('pmo readback confirmed').map(line => line.data)).toEqual([{ spaceId: t.a.id, confirmed: 4 }])
    expect(t.logged('pmo synced')).toHaveLength(2)
    for (const fp of t.fingerprints()) expect(fp).toMatch(/^v4:/)
  })

  it('补列失败（缺建列权限）：「关联」这一轮不写，4 行当轮核对上；日志带错误码，手动回复说明「关联」没写的原因', async () => {
    const t = fixture({ columns: PMO_FIELDS.map(field => field.field_name).filter(name => name !== '关联') })
    t.addFour()
    t.state.fieldCreate = scopeDenied('base:field:create')
    const reply = await t.manual()
    // 「关联」列没准备好不会让整批写入变成“不能核对”：观察和风险两列照常写，当轮读回核对上。
    expect(reply).toContain('同步完成：新增 4、更新 0、没变 0')
    expect(reply).toContain('「关联」列这一轮没有写：读取或补建 Friday 自有列失败（code=99991672：Access denied. One of the following scopes is required: [bitable:app, base:field:create].）')
    for (const fp of t.fingerprints()) expect(fp).toMatch(/^v4:/)
    for (const row of t.rows.values()) expect(row).not.toHaveProperty('关联')
    expect(t.logged('pmo own columns unavailable')).toEqual([{ level: 'warn', msg: 'pmo own columns unavailable', data: expect.objectContaining({
      spaceId: t.a.id, code: 99991672, detail: 'Access denied. One of the following scopes is required: [bitable:app, base:field:create].' }) }])
    expect(t.logged('pmo readback pending')).toEqual([])
    // 定时同步同样：没有待核验，不记核对日志；补列失败照旧记 warn。
    expect(await t.orchestrator.syncPmo()).toMatchObject({ pending: 0, confirmed: 0, skipped: 4 })
    expect(t.logged('pmo own columns unavailable')).toHaveLength(2)
    expect(t.logged('pmo readback pending')).toEqual([])
  })

  it.each([
    ['row_duplicated', '表里同一事项不止一行：1 条'],
    ['row_not_found', '表里按编号和作用域找不到对应的行：1 条'],
    ['read_incomplete', '表格记录没有读全：1 条'],
  ] as const)('找不到唯一一行时（%s）不猜、不重建，定时日志和手动回复写明原因', async (reason, text) => {
    const t = fixture()
    t.todos.add({ scope: spaceScope(t.a.id), title: '发布', owner: 'Alice' })
    t.state.readOnce = new Error('socket hang up')
    expect(await t.orchestrator.syncPmo()).toMatchObject({ pending: 1 })
    const [id, fields] = [...t.rows][0]!
    if (reason === 'row_duplicated') t.rows.set('copy', structuredClone(fields))
    if (reason === 'row_not_found') t.rows.delete(id)
    if (reason === 'read_incomplete') t.state.read = 'incomplete'
    expect(await t.orchestrator.syncPmo()).toMatchObject({ pending: 1, confirmed: 0 })
    expect(t.logged('pmo readback pending').at(-1)!.data).toEqual({ spaceId: t.a.id, pending: 1, reasons: [{ reason, count: 1 }] })
    expect(await t.manual()).toContain(`还有 1 条尚待核验（${text}）`)
    expect(t.fingerprints()).toEqual([expect.stringMatching(/^pending-create:v4:/)])
    expect(t.record.batchCreate).toHaveBeenCalledTimes(1)
  })
})
