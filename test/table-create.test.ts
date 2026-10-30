/**
 * 通用建多维表格（POST /v1/table/create）：模型按当前对话整理出一张表。
 *
 * 权限与受众是这条路径的重点，和 /v1/doc/create 同一套：
 * - 需要 doc:write，且来源可派生（needDerivedWrite）；主动巡检拿不到这个 scope。
 * - 受众锁死在签发 capability 的那个会话：只共享给发起人和当前群，模型不能指定别的群或人。
 * - 每次 await 之后重新核验，撤权在途中生效就不继续往下做。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { Bugs } from '../src/core/bugs.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FeishuApiError } from '../src/feishu/client.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { FakeBitable, asBitable } from './helpers/fake-bitable.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function setup(opts: { chatType?: 'group' | 'p2p' } = {}) {
  const chatType = opts.chatType ?? 'group'
  const registry = new Registry(':memory:')
  const cwd = mkdtempSync(join(tmpdir(), 'friday-table-create-'))
  cleanups.push(() => { registry.close(); rmSync(cwd, { recursive: true, force: true }) })
  const sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: chatType, chatId: 'chat-a', openId: 'alice' })
  const chatId = space.chatId
  const feishu = new FakeFeishu()
  const bitable = new FakeBitable()
  const memory = new ChannelMemory(registry.db)
  const log = createLogger('table-create', 'error')
  const state = { derivedSafe: true }
  registry.createSession({ sessionKey: 'session-a', chatId, chatType, cwd, requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'om_current', requesterOpenId: 'alice', prompt: '把成员整理成一张表' }).task
  registry.updateTask(task.id, { status: 'running' })
  const memoryHost = memoryRuntimeFixture(registry, memory)
  memoryHost.pin({ runId: 'current-run', sessionKey: 'session-a', actorOpenId: 'alice', taskId: task.id })
  const invoke = vi.fn(async () => '')
  const sourceCheck = vi.fn(() => state.derivedSafe)
  const api = createInternalApi({
    registry, ...sp, feishu: asFeishuClient(feishu), bitable: asBitable(bitable), messageCache: new MessageCache(registry.db),
    memory, memoryRuntime: memoryHost.runtime, bugs: new Bugs(registry.db), todos: new Todos(registry.db),
    messages: new MessageService(asFeishuClient(feishu), new MessageCache(registry.db), log),
    abilities: { status: invoke, report: invoke, wiki: invoke, handover: invoke, groups: invoke, pmo: invoke, settings: invoke, explain: () => '', selfcheck: invoke },
    tokens: new TokenIssuer('synthetic'), log, maxHistoryPerCall: 50,
    resolveActorForSession: () => ({ requesterOpenId: 'alice', runId: 'current-run', stage: 'task', taskId: task.id }),
    canPersistDerivedState: sourceCheck,
  } as InternalApiDeps)
  const cap: Capability & { boundRunId?: string; boundStage?: string } = {
    runId: 'current-run', sessionKey: 'session-a', chatId, chatType, spaceId: space.id,
    requesterOpenId: 'alice', cwd, boundRunId: 'current-run', boundStage: 'task', scopes: [...ALL_SCOPES], exp: 9999999999,
  }
  const call = (body: Record<string, unknown>, actor = cap) => api.routes['POST /v1/table/create']!(actor, body)
  return { registry, space, feishu, bitable, state, sourceCheck, cap, call }
}

const MEMBERS = {
  title: '成员档案',
  fields: [
    { name: '成员', type: 'text' },
    { name: '城市', type: 'select' },
    { name: '加入日期', type: 'date' },
    { name: '是管理员', type: 'checkbox' },
  ],
  rows: [
    { 成员: '井曦 Jeffrey', 城市: '上海', 加入日期: '2026-08-10', 是管理员: true },
    { 成员: '韩清越', 城市: '杭州', 加入日期: '2026-08-10', 是管理员: true },
    { 成员: '知行', 城市: '北京', 加入日期: '2026-08-22', 是管理员: false },
  ],
}

describe('通用建多维表格', () => {
  it('建表、写行，并只共享给发起人和当前群', async () => {
    const t = setup()
    const r = await t.call(MEMBERS) as { appToken: string; tableId: string; url: string; rows: number; shared: string[] }

    expect(t.bitable.calls).toEqual(['createBase', 'ensureTable', 'batchCreate'])
    expect(t.bitable.bases[0]?.name).toBe('成员档案')
    expect(t.bitable.tables[0]?.fields.map((f) => f.field_name)).toEqual(['成员', '城市', '加入日期', '是管理员'])
    // 单选列的候选项由真实行值推出来，模型不用自己列
    expect(t.bitable.tables[0]?.fields[1]?.property).toMatchObject({ options: [{ name: '上海' }, { name: '杭州' }, { name: '北京' }] })
    expect(t.bitable.created[0]?.records).toHaveLength(3)
    expect(t.bitable.created[0]?.records[0]?.fields).toMatchObject({ 成员: '井曦 Jeffrey', 城市: '上海', 是管理员: true })
    expect(t.bitable.created[0]?.records[0]?.fields['加入日期']).toBe(Date.parse('2026-08-10'))

    expect(r.rows).toBe(3)
    expect(r.url).toContain(r.appToken)
    expect(t.feishu.grants).toEqual([
      { documentId: 'bascn1', member: { openId: 'alice' }, perm: 'full_access', type: 'bitable' },
      { documentId: 'bascn1', member: { chatId: t.cap.chatId }, perm: 'edit', type: 'bitable' },
    ])
    expect(r.shared).toEqual(['requester', 'chat'])
  })

  it('模型给的 chat_id / open_id 不改变受众', async () => {
    const t = setup()
    await t.call({ ...MEMBERS, chat_id: 'chat-other', open_id: 'mallory', folder_token: 'fldcnEvil' })
    for (const g of t.feishu.grants) {
      expect(g.member.chatId ?? t.cap.chatId).toBe(t.cap.chatId)
      expect(g.member.openId ?? 'alice').toBe('alice')
    }
    expect(t.bitable.bases[0]?.folderToken).toBeUndefined()
  })

  it('私聊里不把表共享给会话，只给本人', async () => {
    const t = setup({ chatType: 'p2p' })
    const r = await t.call(MEMBERS) as { shared: string[] }
    expect(r.shared).toEqual(['requester'])
    expect(t.feishu.grants.map((g) => g.member)).toEqual([{ openId: 'alice' }])
  })

  it('群里可以显式不共享给整个群', async () => {
    const t = setup()
    const r = await t.call({ ...MEMBERS, share_with_chat: false }) as { shared: string[] }
    expect(r.shared).toEqual(['requester'])
  })

  it('来源不可派生时在建表之前就拒绝', async () => {
    const t = setup(); t.state.derivedSafe = false
    await expect(t.call(MEMBERS)).rejects.toMatchObject({ status: 403 })
    expect(t.bitable.calls).toEqual([])
    expect(t.feishu.grants).toEqual([])
  })

  it('没有 doc:write 时拒绝，且不碰多维表格', async () => {
    const t = setup()
    const noScope = { ...t.cap, scopes: ALL_SCOPES.filter((s) => s !== 'doc:write') }
    await expect(t.call(MEMBERS, noScope)).rejects.toMatchObject({ status: 403 })
    expect(t.bitable.calls).toEqual([])
  })

  it('缺 title 或 fields 时报 400，不建空表', async () => {
    const t = setup()
    await expect(t.call({ fields: MEMBERS.fields, rows: [] })).rejects.toMatchObject({ status: 400 })
    await expect(t.call({ title: '空表', fields: [], rows: [] })).rejects.toMatchObject({ status: 400 })
    expect(t.bitable.calls).toEqual([])
  })

  it('超出列数或行数上限时报 413，不建表', async () => {
    const t = setup()
    const many = Array.from({ length: 31 }, (_, i) => ({ name: `列${i}`, type: 'text' }))
    await expect(t.call({ title: '宽表', fields: many, rows: [] })).rejects.toMatchObject({ status: 413 })
    const rows = Array.from({ length: 501 }, (_, i) => ({ 成员: `第${i}行` }))
    await expect(t.call({ title: '长表', fields: [{ name: '成员', type: 'text' }], rows })).rejects.toMatchObject({ status: 413 })
    expect(t.bitable.calls).toEqual([])
  })

  it('行里出现未声明的列会被丢掉，不会偷偷加列', async () => {
    const t = setup()
    await t.call({ title: 'T', fields: [{ name: '成员', type: 'text' }], rows: [{ 成员: 'a', 手机号: '13800000000' }] })
    expect(Object.keys(t.bitable.created[0]!.records[0]!.fields)).toEqual(['成员'])
  })

  it('缺权限时给出要开哪个权限，并且不留下半张表', async () => {
    const t = setup()
    t.bitable.failCreateBase = new FeishuApiError('bitable.app.create', 99991672, 'permission denied')
    await expect(t.call(MEMBERS)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('bitable:app') })
    expect(t.feishu.grants).toEqual([])
  })

  it('写行失败时不共享一张空表', async () => {
    const t = setup()
    t.bitable.failBatchCreate = new FeishuApiError('bitable.record.batchCreate', 1254045, 'field not found')
    await expect(t.call(MEMBERS)).rejects.toBeTruthy()
    expect(t.feishu.grants).toEqual([])
  })
})
