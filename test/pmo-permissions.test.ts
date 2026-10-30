import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator, type AbilityActor } from '../src/core/orchestrator.js'
import { PmoStore } from '../src/core/pmo.js'
import { Registry } from '../src/core/registry.js'
import { spaceScope } from '../src/core/space.js'
import { Todos } from '../src/core/todos.js'
import type { Bitable } from '../src/feishu/bitable.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const registries: Registry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close()
})

function setup() {
  const registry = new Registry(':memory:')
  registries.push(registry)
  const cfg = loadConfig({ FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test', FRIDAY_REFLECT: 'off' })
  const sp = spaceDeps(registry.db)
  const a = sp.spaces.ensure({ kind: 'group', chatId: 'group-a', openId: 'alice', title: 'A群' })
  const b = sp.spaces.ensure({ kind: 'group', chatId: 'group-b', openId: 'bob', title: 'B群' })
  sp.spaces.addMember(a.id, 'member', 'member')
  const dm = sp.spaces.dm('alice')
  const todos = new Todos(registry.db)
  const pmo = new PmoStore(registry.db)
  const feishu = new FakeFeishu()
  let nextBase = 0
  let nextRecord = 0
  const rows = new Map<string, Record<string, unknown>[]>()
  const rowIds = new Map<string, string[]>()
  const bitable = {
    baseUrl: (app: string, table?: string) => `https://example.invalid/base/${app}${table ? `?table=${table}` : ''}`,
    createBase: vi.fn(async () => {
      const appToken = `base${++nextBase}`
      return { appToken, url: `https://example.invalid/base/${appToken}` }
    }),
    ensureTable: vi.fn(async () => 'table'),
    ensureFields: vi.fn(async () => undefined),
    listRecords: vi.fn(async (app: string, table: string) => ({
      records: (rows.get(`${app}/${table}`) ?? []).map((fields, i) => ({ recordId: rowIds.get(`${app}/${table}`)?.[i], fields })), complete: true,
    })),
    batchCreate: vi.fn(async (app: string, table: string, records: { fields: Record<string, unknown> }[]) => {
      const key = `${app}/${table}`
      const ids = records.map(() => `record${++nextRecord}`)
      rows.set(key, [...(rows.get(key) ?? []), ...records.map((r) => r.fields)])
      rowIds.set(key, [...(rowIds.get(key) ?? []), ...ids])
      return ids
    }),
    batchUpdate: vi.fn(async () => 0),
  }
  const orchestrator = new Orchestrator({
    cfg, registry, todos, pmo, ...sp,
    feishu: asFeishuClient(feishu),
    bitable: bitable as unknown as Bitable,
    // These command/ability paths never start a model turn.
    runtime: {} as AcpRuntime,
    memory: new ChannelMemory(registry.db),
    tokens: new TokenIssuer('test'),
    apiBaseUrl: 'http://127.0.0.1:1',
    mcpServerPath: '/unused',
    botOpenId: 'bot',
    log: createLogger('pmo-test', 'error'),
  })
  const actor = (chatId = 'group-a', requesterOpenId = 'alice', chatType: 'group' | 'p2p' = 'group'): AbilityActor => ({ sessionKey: 'test', chatId, requesterOpenId, chatType })
  return { registry, ...sp, a, b, dm, todos, pmo, feishu, bitable, rows, orchestrator, actor }
}

describe('PMO export authorization', () => {
  it('群负责人绑定仅当前空间；手动和定期同步均不导出私聊、其他群或全局作用域', async () => {
    const t = setup()
    for (const [scope, title] of [
      [spaceScope(t.a.id), 'A群事项'],
      [spaceScope(t.b.id), 'B群事项'],
      [spaceScope(t.dm.id), '私聊事项'],
      ['org', '企业事项'],
      ['circle:team', '联盟事项'],
    ]) t.todos.add({ scope: scope!, title: title! })
    expect(await t.orchestrator.abilities.pmo(t.actor(), 'init')).toContain('仅来自本群空间')
    expect(t.rows.get('base1/table')?.map((r) => r['事项'])).toEqual(['A群事项'])
    const binding = JSON.parse(t.registry.getKv(`pmo:binding:${t.a.id}`)!)
    expect(binding).toMatchObject({ spaceId: t.a.id, boundBy: 'alice' })
    expect(t.registry.getKv(`pmo:binding:${t.b.id}`)).toBeUndefined()
    t.todos.add({ scope: spaceScope(t.a.id), title: 'A群后续' })
    t.todos.add({ scope: spaceScope(t.b.id), title: 'B群后续' })
    expect(await t.orchestrator.syncPmo()).toMatchObject({ created: 1 })
    expect(t.rows.get('base1/table')?.map((r) => r['事项'])).toEqual(['A群事项', 'A群后续'])
    expect(t.feishu.grants.map((g) => g.member)).toEqual([{ openId: 'alice' }, { chatId: 'group-a' }])
  })

  it('成员不能新建、重绑或触发同步；私聊连看板状态也不能取得', async () => {
    const t = setup()
    await t.orchestrator.abilities.pmo(t.actor(), 'init')
    const original = t.registry.getKv(`pmo:binding:${t.a.id}`)
    const grants = t.feishu.grants.length
    t.bitable.createBase.mockClear()
    t.bitable.ensureTable.mockClear()
    t.bitable.batchCreate.mockClear()
    for (const command of ['init', 'bind elsewhere', 'sync']) {
      expect(await t.orchestrator.abilities.pmo(t.actor('group-a', 'member'), command)).toContain('只有本空间负责人')
    }
    for (const command of ['', 'init', 'bind elsewhere', 'sync']) {
      const result = await t.orchestrator.abilities.pmo(t.actor('dm-alice', 'alice', 'p2p'), command)
      expect(result).toContain('不会导出私聊事项')
      expect(result).not.toContain('base1')
    }
    expect(t.registry.getKv(`pmo:binding:${t.a.id}`)).toBe(original)
    expect(t.bitable.createBase).not.toHaveBeenCalled()
    expect(t.bitable.ensureTable).not.toHaveBeenCalled()
    expect(t.bitable.batchCreate).not.toHaveBeenCalled()
    expect(t.feishu.grants).toHaveLength(grants)
  })

  it('两个群不能绑定同一 base；独立绑定不覆盖其他群且各写各的表', async () => {
    const t = setup()
    t.todos.add({ scope: spaceScope(t.a.id), title: 'A' })
    t.todos.add({ scope: spaceScope(t.b.id), title: 'B' })
    await t.orchestrator.abilities.pmo(t.actor(), 'init')
    const first = t.registry.getKv(`pmo:binding:${t.a.id}`)
    const grants = t.feishu.grants.length
    t.bitable.ensureTable.mockClear()
    expect(await t.orchestrator.abilities.pmo(t.actor('group-b', 'bob'), 'bind base1')).toContain('已用于其他群空间')
    expect(t.bitable.ensureTable).not.toHaveBeenCalled()
    expect(t.feishu.grants).toHaveLength(grants)
    await t.orchestrator.abilities.pmo(t.actor('group-b', 'bob'), 'init')
    expect(t.registry.getKv(`pmo:binding:${t.a.id}`)).toBe(first)
    expect(t.rows.get('base1/table')?.map((r) => r['事项'])).toEqual(['A'])
    expect(t.rows.get('base2/table')?.map((r) => r['事项'])).toEqual(['B'])
  })

  it('旧全局绑定保留但不能同步、披露链接或重新授权给当前群', async () => {
    const t = setup()
    const legacy = JSON.stringify({ appToken: 'legacy', tableId: 'old', url: 'https://example.invalid/legacy' })
    t.registry.setKv('pmo:binding', legacy)
    t.todos.add({ scope: spaceScope(t.a.id), title: 'A' })
    expect(await t.orchestrator.syncPmo()).toBeUndefined()
    expect(await t.orchestrator.abilities.pmo(t.actor(), 'sync')).toContain('还没有 PMO')
    expect(await t.orchestrator.abilities.pmo(t.actor())).toContain('旧版全局看板已停止同步')
    expect(await t.orchestrator.abilities.pmo(t.actor())).not.toContain('https://example.invalid/legacy')
    expect(await t.orchestrator.abilities.pmo(t.actor(), 'bind legacy')).toContain('曾是全局看板')
    expect(t.bitable.ensureTable).not.toHaveBeenCalled()
    expect(t.bitable.batchCreate).not.toHaveBeenCalled()
    expect(t.feishu.grants).toHaveLength(0)
    expect(t.registry.getKv('pmo:binding')).toBe(legacy)
    t.registry.setKv('pmo:binding', '{}')
    expect(await t.orchestrator.abilities.pmo(t.actor(), 'bind legacy')).toContain('旧版全局看板配置无法解析')
    expect(t.bitable.ensureTable).not.toHaveBeenCalled()
  })

  it('配置者被移除或空间停用后自动同步不继续导出', async () => {
    const t = setup()
    await t.orchestrator.abilities.pmo(t.actor(), 'init')
    t.todos.add({ scope: spaceScope(t.a.id), title: '新事项' })
    t.spaces.removeMember(t.a.id, 'alice')
    expect(await t.orchestrator.syncPmo()).toBeUndefined()
    expect(t.bitable.batchCreate).not.toHaveBeenCalled()
    t.spaces.addMember(t.a.id, 'alice', 'owner')
    t.spaces.suspend(t.a.id)
    expect(await t.orchestrator.syncPmo()).toBeUndefined()
    expect(t.bitable.batchCreate).not.toHaveBeenCalled()
  })

  it.each(['auto', 'manual'] as const)('%s 同步等群名时配置者被移除，之后不建行', async (mode) => {
    const t = setup()
    await t.orchestrator.abilities.pmo(t.actor(), 'init')
    t.todos.add({ scope: spaceScope(t.a.id), title: '撤权之后不应导出' })
    t.registry.db.prepare('UPDATE space_rooms SET title = NULL WHERE id = ?').run(t.a.id)
    vi.spyOn(t.feishu, 'chatName').mockImplementationOnce(async () => {
      t.spaces.removeMember(t.a.id, 'alice')
      return 'A群'
    })
    const result = mode === 'auto' ? await t.orchestrator.syncPmo() : await t.orchestrator.abilities.pmo(t.actor(), 'sync')
    if (mode === 'auto') expect(result).toBeUndefined()
    else expect(result).toContain('停止')
    expect(t.bitable.batchCreate).not.toHaveBeenCalled()
  })

  it.each(['suspended', 'rebound'] as const)('同步等群名时 %s，旧绑定不再导出', async (change) => {
    const t = setup()
    await t.orchestrator.abilities.pmo(t.actor(), 'init')
    t.todos.add({ scope: spaceScope(t.a.id), title: '旧绑定不应导出' })
    t.registry.db.prepare('UPDATE space_rooms SET title = NULL WHERE id = ?').run(t.a.id)
    vi.spyOn(t.feishu, 'chatName').mockImplementationOnce(async () => {
      if (change === 'suspended') t.spaces.suspend(t.a.id)
      else {
        const key = `pmo:binding:${t.a.id}`
        const old = JSON.parse(t.registry.getKv(key)!)
        t.registry.setKv(key, JSON.stringify({ ...old, version: 'new-binding' }))
      }
      return 'A群'
    })
    expect(await t.orchestrator.syncPmo()).toBeUndefined()
    expect(t.bitable.batchCreate).not.toHaveBeenCalled()
  })

  it('建行回执不明不谎报完成，用户重试也不重复建行', async () => {
    const t = setup()
    await t.orchestrator.abilities.pmo(t.actor(), 'init')
    t.todos.add({ scope: spaceScope(t.a.id), title: '回执可能丢失' })
    t.bitable.batchCreate.mockRejectedValueOnce(new Error('timeout'))
    const result = await t.orchestrator.abilities.pmo(t.actor(), 'sync')
    expect(result).toContain('待核验')
    expect(result).not.toContain('同步完成')
    expect(await t.orchestrator.abilities.pmo(t.actor(), 'sync')).toContain('待核验')
    expect(t.bitable.batchCreate).toHaveBeenCalledTimes(1)
  })
})
