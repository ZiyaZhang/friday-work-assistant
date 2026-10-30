/**
 * PMO「关联」列（第四批第 1 条，最小做法）：Friday 自有列加一格「关联」，写待办的出处链接，
 * 以及待办标题 / 说明里 Issue、PR 链接的只读状态。人维护的列（事项 / 负责人 / 截止 / 状态）照旧只读。
 *
 * 守住的几条：
 * - 链接解析、每轮最多读 24 个链接、同时最多 6 个、读不到按“未读到”，都复用待办完成证据（包 B）那一套；
 * - 只写 Friday 自有列；人改过的负责人 / 状态不覆盖；人清空的风险在事实不变时不再提；
 * - 指纹规则变化后的首轮，r77 写下的行只补「关联」这一格；
 * - 表格改成只读，被拒只私聊绑定人一次（包 A 规则不变）。
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Client } from '@larksuiteoapi/node-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator, type AbilityActor } from '../src/core/orchestrator.js'
import { PMO_FIELDS, PMO_OWN_FIELDS, PmoStore, preparePmoColumns, syncWorkItems, toFields, toOwnFields, type PmoLinks } from '../src/core/pmo.js'
import { Registry } from '../src/core/registry.js'
import { spaceScope } from '../src/core/space.js'
import type { GitHubItemState, GitHubRef } from '../src/core/todo-completion-evidence.js'
import type { TodoProvenance } from '../src/core/todo-provenance.js'
import { STATUS_LABEL, Todos, type Todo } from '../src/core/todos.js'
import { Bitable, FIELD_TYPE, type BitableField } from '../src/feishu/bitable.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const DAY = 86400_000
const SOURCE_URL = 'https://applink.feishu.cn/client/message/link/open?token=synthetic'
const PR_URL = 'https://github.com/org/repo/pull/12'
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(close => close()); vi.restoreAllMocks() })

function provenance(url?: string): TodoProvenance {
  return { version: 1, originRunId: 'run-1', taskId: 1, workKey: 'work-1', selectedInputs: [],
    request: { messageId: 'om_request', chatId: 'oc_a', chatType: 'group', senderOpenId: 'ou_alice', msgType: 'text', createTimeMs: 1_800_000_000_000,
      link: url ? { status: 'available', url } : { status: 'unavailable' } },
    contextSnapshot: { version: 1, acpSessionId: 'acp-1', spaceId: 'sp_a', chatId: 'oc_a', memoryScopes: [], chats: [], external: [], repositories: [] } }
}

function read(kind: 'issue' | 'pull', state: 'open' | 'closed', extra: { merged?: boolean; stateReason?: string | null } = {}): GitHubItemState {
  return { status: 'read', kind, state, merged: extra.merged ?? false, stateReason: extra.stateReason ?? null }
}

/** 飞书文本列回读时，链接会变成单独一段（{type:'url'}）。 */
function asSegments(fields: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(fields), text = copy['关联']
  if (typeof text === 'string' && text) copy['关联'] = text.split(/(https:\/\/\S+)/).filter(Boolean)
    .map(part => part.startsWith('https://') ? { type: 'url', text: part, link: part } : { type: 'text', text: part })
  return copy
}

/** Only the SDK transport is fake: actual Bitable, PMO and SQLite run. */
function fixture() {
  const db = new DatabaseSync(':memory:'); cleanups.push(() => db.close())
  const todos = new Todos(db), store = new PmoStore(db)
  const binding = { appToken: 'base', tableId: 'table', spaceId: 'sp_a', boundBy: 'alice', url: 'synthetic' }
  const space = { id: 'sp_a', kind: 'group', status: 'active' } as const
  store.claim(binding)
  const rows = new Map<string, Record<string, unknown>>()
  const options: { segments?: boolean } = {}
  let nextId = 0
  const sdk = {
    list: vi.fn(async () => ({ code: 0, data: { has_more: false,
      items: [...rows].map(([record_id, fields]) => ({ record_id, fields: options.segments ? asSegments(fields) : structuredClone(fields) })) } })),
    batchCreate: vi.fn(async ({ data }: { data: { records: { fields: Record<string, unknown> }[] } }) => ({ code: 0, data: {
      records: data.records.map(record => { const record_id = `rec${++nextId}`; rows.set(record_id, structuredClone(record.fields)); return { record_id } }) } })),
    batchUpdate: vi.fn(async ({ data }: { data: { records: { record_id: string; fields: Record<string, unknown> }[] } }) => {
      for (const record of data.records) Object.assign(rows.get(record.record_id)!, structuredClone(record.fields))
      return { code: 0, data: {} }
    }),
  }
  const bitable = new Bitable({ bitable: { v1: { appTableRecord: sdk } } } as unknown as Client)
  const github = new Map<string, GitHubItemState>()
  const reads: string[] = []
  const readGitHub = vi.fn(async (ref: GitHubRef): Promise<GitHubItemState> => {
    const key = `${ref.owner}/${ref.repo}#${ref.number}`
    reads.push(key)
    return github.get(key) ?? { status: 'unavailable', reason: 'synthetic: not found' }
  })
  /** null：不给 links（表里「关联」列还没建好的那种轮次） */
  const sync = (links: PmoLinks | null = { readGitHub }) => syncWorkItems({ bitable, todos, store, links: links ?? undefined }, binding, space, 'A群')
  const add = (title: string, extra: Partial<Parameters<Todos['add']>[0]> = {}) => todos.add({ scope: 'space:sp_a', title, owner: 'Alice', ...extra })
  /** 每次 batchUpdate 发出去的各行字段 */
  const sent = () => sdk.batchUpdate.mock.calls.map(([request]) => request.data.records.map(record => record.fields))
  const row = (todo: Todo) => [...rows.values()].find(fields => fields['编号'] === todo.id)!
  return { db, todos, store, binding, rows, options, sdk, github, reads, readGitHub, sync, add, sent, row }
}

describe('「关联」列的内容', () => {
  it('表结构在末尾追加「关联」文本列；同步前补列只补 Friday 自有的三列', () => {
    expect(PMO_FIELDS.at(-1)).toEqual({ field_name: '关联', type: FIELD_TYPE.text })
    expect(PMO_OWN_FIELDS.map(field => field.field_name)).toEqual(['Friday 观察', '风险', '关联'])
  })

  it('同步前核对列：缺列只补 Friday 自有列，列齐了不再补；同名非文本的「关联」不接管；读不到列清单就抛错', async () => {
    const binding = { appToken: 'base', tableId: 'table', spaceId: 'sp_a', boundBy: 'alice', url: 'synthetic' }
    const columns = new Map<string, number>([['事项', FIELD_TYPE.text], ['Friday 观察', FIELD_TYPE.text], ['风险', FIELD_TYPE.singleSelect]])
    const bitable = {
      listFields: vi.fn(async () => [...columns].map(([fieldName, type]) => ({ fieldName, type }))),
      ensureFields: vi.fn(async (_app: string, _table: string, fields: BitableField[]) => {
        for (const field of fields) if (!columns.has(field.field_name)) columns.set(field.field_name, field.type)
        return 1
      }),
    }
    expect(await preparePmoColumns(bitable, binding, () => {})).toBe(true)
    expect(bitable.ensureFields.mock.calls[0]![2].map(field => field.field_name)).toEqual(['Friday 观察', '风险', '关联'])
    expect(await preparePmoColumns(bitable, binding, () => {})).toBe(true)
    expect(bitable.ensureFields).toHaveBeenCalledTimes(1)
    columns.set('关联', 18)
    expect(await preparePmoColumns(bitable, binding, () => {})).toBe(false)
    bitable.listFields.mockRejectedValueOnce(new Error('synthetic: no field read'))
    await expect(preparePmoColumns(bitable, binding, () => {})).rejects.toThrow('no field read')
  })

  it('有出处、有 PR 链接：建行时写出处链接和 PR 当前状态，同一链接只读一次', async () => {
    const t = fixture()
    t.github.set('org/repo#12', read('pull', 'closed', { merged: true }))
    const todo = t.add(`合并登录修复 ${PR_URL}`, { detail: `同一个 PR：${PR_URL}`, provenance: provenance(SOURCE_URL) })
    expect(await t.sync()).toMatchObject({ created: 1, pending: 0 })
    expect(t.row(todo)['关联']).toBe(`出处：原请求 ${SOURCE_URL}\nPR org/repo#12：已合并 ${PR_URL}`)
    expect(t.reads).toEqual(['org/repo#12'])
  })

  it('无出处、无链接：「关联」留空，不读 GitHub；出处链接不可用时照实写', async () => {
    const t = fixture()
    const plain = t.add('补单测')
    const unlinked = t.add('整理需求', { provenance: provenance() })
    expect(await t.sync()).toMatchObject({ created: 2, pending: 0 })
    expect(t.row(plain)['关联']).toBe('')
    expect(t.row(unlinked)['关联']).toBe('出处：原请求 · 来源链接暂不可用。')
    expect(t.readGitHub).not.toHaveBeenCalled()
  })

  it('Issue / PR 的状态和待办完成依据用同一套说法；链接写成 /issues/ 的 PR 按读到的类型写', async () => {
    const t = fixture()
    const cases = [
      [1, read('issue', 'open'), 'Issue org/repo#1：未关闭'],
      [2, read('issue', 'closed', { stateReason: 'completed' }), 'Issue org/repo#2：已关闭为完成'],
      [3, read('issue', 'closed', { stateReason: 'not_planned' }), 'Issue org/repo#3：已关闭（not_planned）'],
      [4, read('issue', 'closed'), 'Issue org/repo#4：已关闭（没有写原因）'],
      [5, read('pull', 'open'), 'PR org/repo#5：未合并'],
      [6, read('pull', 'closed'), 'PR org/repo#6：已关闭未合并'],
    ] as const
    const added = cases.map(([n, state]) => { t.github.set(`org/repo#${n}`, state); return t.add(`跟进 https://github.com/org/repo/issues/${n}`) })
    await t.sync()
    cases.forEach(([n, , line], i) => expect(t.row(added[i]!)['关联']).toBe(`${line} https://github.com/org/repo/issues/${n}`))
  })

  it('链接超出本轮上限：最多读 24 个、同时最多 6 个，未结束的事项先读，其余写“未读到”', async () => {
    const t = fixture()
    let active = 0, peak = 0
    t.readGitHub.mockImplementation(async ref => {
      t.reads.push(`${ref.owner}/${ref.repo}#${ref.number}`); active++; peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active--
      return read('issue', 'open')
    })
    // 表格按状态字母序列出事项，已完成的排在进行中前面；读取名额仍先给没结束的事项。
    const done = Array.from({ length: 10 }, (_, i) => {
      const todo = t.add(`已结束 https://github.com/org/repo/issues/${100 + i}`)
      return t.todos.transition(todo.id, todo.scope, 'done')!
    })
    const open = Array.from({ length: 20 }, (_, i) => t.add(`进行中 https://github.com/org/repo/issues/${i + 1}`))
    expect(await t.sync()).toMatchObject({ created: 30, pending: 0 })
    expect(t.reads).toHaveLength(24)
    expect(new Set(t.reads).size).toBe(24)
    expect(peak).toBeLessThanOrEqual(6)
    expect(peak).toBeGreaterThan(1)
    for (const todo of open) expect(t.row(todo)['关联']).toMatch(/：未关闭 https:/)
    expect(done.filter(todo => String(t.row(todo)['关联']).includes('：未读到 https:'))).toHaveLength(6)
  })

  it('GitHub 读取失败、仓库读不到或没配 GitHub：一律写“未读到”，不写原因', async () => {
    const t = fixture()
    t.readGitHub.mockImplementation(async ref => {
      if (ref.number === 1) throw new Error('synthetic network error token=secret')
      return { status: 'unavailable', reason: '仓库不在允许范围内' }
    })
    const failed = t.add('跟进 https://github.com/org/repo/issues/1')
    const denied = t.add('跟进 https://github.com/other/private/pull/2')
    expect(await t.sync()).toMatchObject({ created: 2, pending: 0 })
    expect(t.row(failed)['关联']).toBe('Issue org/repo#1：未读到 https://github.com/org/repo/issues/1')
    expect(t.row(denied)['关联']).toBe('PR other/private#2：未读到 https://github.com/other/private/pull/2')
    expect(JSON.stringify([...t.rows.values()])).not.toMatch(/network|secret|允许范围/)
    const unconfigured = fixture()
    const todo = unconfigured.add(`合并 ${PR_URL}`)
    await unconfigured.sync({})
    expect(unconfigured.row(todo)['关联']).toBe(`PR org/repo#12：未读到 ${PR_URL}`)
  })

  it('toOwnFields / toFields：给了关联内容才带「关联」这一格；toOwnFields 只有 Friday 自有列', () => {
    const t = fixture()
    const todo = t.add('补单测')
    expect(Object.keys(toOwnFields(todo, Date.now(), '出处：原请求')).sort()).toEqual(['Friday 观察', '关联', '风险'])
    expect(Object.keys(toOwnFields(todo, Date.now())).sort()).toEqual(['Friday 观察', '风险'])
    expect(toFields(todo, 'A群', Date.now())).not.toHaveProperty('关联')
    expect(toFields(todo, 'A群', Date.now(), '')).toMatchObject({ 关联: '', 事项: '补单测', 负责人: 'Alice' })
  })
})

describe('只写 Friday 自有列', () => {
  it('人改了事项、负责人、截止和状态：下一轮只写观察和风险；之后 PR 合并只写「关联」一格，人改的列不动', async () => {
    const t = fixture()
    t.github.set('org/repo#12', read('pull', 'open'))
    const todo = t.add(`合并登录修复 ${PR_URL}`, { provenance: provenance(SOURCE_URL) })
    await t.sync()
    const human = { 事项: '人改过的标题', 负责人: 'Bob', 状态: '阻塞', 截止时间: Date.now() + 5 * DAY }
    Object.assign(t.row(todo), human)
    expect(await t.sync()).toMatchObject({ updated: 1, pending: 0 })
    expect(t.sent().at(-1)!.map(fields => Object.keys(fields).sort())).toEqual([['Friday 观察', '风险']])
    t.github.set('org/repo#12', read('pull', 'closed', { merged: true }))
    expect(await t.sync()).toMatchObject({ updated: 1, pending: 0 })
    expect(t.sent().at(-1)).toEqual([{ 关联: `出处：原请求 ${SOURCE_URL}\nPR org/repo#12：已合并 ${PR_URL}` }])
    expect(t.row(todo)).toMatchObject(human)
    expect(await t.sync()).toMatchObject({ updated: 0, skipped: 1 })
    expect(t.sdk.batchUpdate).toHaveBeenCalledTimes(2)
    for (const fields of t.sent().flat()) expect(Object.keys(fields).every(key => ['Friday 观察', '风险', '关联'].includes(key))).toBe(true)
    expect(t.todos.get(todo.id)).toMatchObject({ title: `合并登录修复 ${PR_URL}`, owner: 'Alice', status: 'open' })
  })

  it('人清空风险：事实不变不再提；之后只有链接状态变了，也只写「关联」，不把风险写回来', async () => {
    const t = fixture()
    t.github.set('org/repo#12', read('pull', 'open'))
    const todo = t.add(`合并登录修复 ${PR_URL}`, { dueMs: Date.now() - 3 * DAY })
    await t.sync()
    expect(t.row(todo)['风险']).toBe('已过截止')
    t.row(todo)['风险'] = ''
    expect(await t.sync()).toMatchObject({ skipped: 1, updated: 0 })
    t.github.set('org/repo#12', read('pull', 'closed', { merged: true }))
    expect(await t.sync()).toMatchObject({ updated: 1, pending: 0 })
    expect(t.sent().at(-1)).toEqual([{ 关联: `PR org/repo#12：已合并 ${PR_URL}` }])
    expect(t.row(todo)['风险']).toBe('')
    expect(await t.sync()).toMatchObject({ skipped: 1, updated: 0 })
  })

  it('人改了「关联」这一格：链接状态不变就不覆盖，变了才重写', async () => {
    const t = fixture()
    t.github.set('org/repo#12', read('pull', 'open'))
    const todo = t.add(`合并登录修复 ${PR_URL}`)
    await t.sync()
    t.row(todo)['关联'] = '人工备注：等法务'
    expect(await t.sync()).toMatchObject({ skipped: 1, updated: 0 })
    expect(t.row(todo)['关联']).toBe('人工备注：等法务')
    t.github.set('org/repo#12', read('pull', 'closed', { merged: true }))
    expect(await t.sync()).toMatchObject({ updated: 1 })
    expect(t.row(todo)['关联']).toBe(`PR org/repo#12：已合并 ${PR_URL}`)
  })

  it('「关联」列还没建好（不给 links）：这一轮不写、不读 GitHub；列建好后的第一轮只补这一格', async () => {
    const t = fixture()
    t.github.set('org/repo#12', read('pull', 'open'))
    const todo = t.add(`合并登录修复 ${PR_URL}`, { provenance: provenance(SOURCE_URL) })
    expect(await t.sync(null)).toMatchObject({ created: 1, pending: 0 })
    expect(t.sdk.batchCreate.mock.calls[0]![0].data.records[0]!.fields).not.toHaveProperty('关联')
    t.row(todo)['负责人'] = 'Bob'
    expect(await t.sync(null)).toMatchObject({ updated: 1, pending: 0 })
    expect(Object.keys(t.sent().at(-1)![0]!)).not.toContain('关联')
    expect(t.readGitHub).not.toHaveBeenCalled()
    expect(await t.sync()).toMatchObject({ updated: 1, pending: 0 })
    expect(t.sent().at(-1)).toEqual([{ 关联: `出处：原请求 ${SOURCE_URL}\nPR org/repo#12：未合并 ${PR_URL}` }])
    expect(await t.sync()).toMatchObject({ skipped: 1, updated: 0 })
  })

  it('飞书把链接回读成分段文本：按文字核对，建行和更新都算写到', async () => {
    const t = fixture()
    t.options.segments = true
    t.github.set('org/repo#12', read('pull', 'open'))
    t.add(`合并登录修复 ${PR_URL}`, { provenance: provenance(SOURCE_URL) })
    expect(await t.sync()).toMatchObject({ created: 1, pending: 0 })
    t.github.set('org/repo#12', read('pull', 'closed', { merged: true }))
    expect(await t.sync()).toMatchObject({ updated: 1, pending: 0 })
    expect(await t.sync()).toMatchObject({ skipped: 1, pending: 0 })
  })
})

describe('指纹规则变化后的首轮', () => {
  /** r77 recordProjection 的指纹原样照抄：证明新指纹的前两段与 r77 已存的一致。 */
  function r77Fingerprint(row: Record<string, unknown>, todo: Todo, risk: string): string {
    const sha = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16)
    const table = { status: row['状态'], owner: row['负责人'], due: row['截止时间'] ?? null }
    const local = { status: STATUS_LABEL[todo.status], owner: todo.owner ?? (todo.ownerOpenId ? '已指定成员（未记录姓名）' : ''), due: todo.dueMs }
    return `v3:${sha({ table, risk })}:${sha({ table, local, risk })}`
  }
  /** 把本地记下的指纹换回 r77 的写法（去掉「关联」那一段）。 */
  function asR77(t: ReturnType<typeof fixture>, todo: Todo): string {
    const stored = t.store.get(t.binding, todo.id)!
    const [, risk, observation] = stored.fingerprint.split(':')
    const v3 = `v3:${risk}:${observation}`
    t.store.remember(t.binding, todo.id, stored.recordId, v3)
    return v3
  }

  it('r77 写下的行：首轮只补「关联」一格，人改过的负责人和人清空的风险不动；第二轮不再写', async () => {
    const t = fixture()
    t.github.set('org/repo#12', read('pull', 'closed', { merged: true }))
    const todo = t.add(`合并登录修复 ${PR_URL}`, { dueMs: Date.now() - 3 * DAY, provenance: provenance(SOURCE_URL) })
    // r77 时期：表里还没有「关联」列。建行、人改负责人、人清空风险。
    await t.sync(null)
    const row = t.row(todo)
    row['负责人'] = 'Bob'
    expect(await t.sync(null)).toMatchObject({ updated: 1 })
    row['风险'] = ''
    expect(await t.sync(null)).toMatchObject({ skipped: 1 })
    expect(asR77(t, todo)).toBe(r77Fingerprint(row, t.todos.get(todo.id)!, '已过截止'))
    const writes = t.sdk.batchUpdate.mock.calls.length
    expect(await t.sync()).toMatchObject({ updated: 1, pending: 0 })
    expect(t.sent().at(-1)).toEqual([{ 关联: `出处：原请求 ${SOURCE_URL}\nPR org/repo#12：已合并 ${PR_URL}` }])
    expect(row).toMatchObject({ 负责人: 'Bob', 风险: '', 状态: '进行中' })
    expect(t.store.get(t.binding, todo.id)!.fingerprint).toMatch(/^v4:/)
    expect(await t.sync()).toMatchObject({ updated: 0, skipped: 1 })
    expect(t.sdk.batchUpdate).toHaveBeenCalledTimes(writes + 1)
  })

  it('r77 写下的行没有出处也没有链接：首轮不写表，只把指纹换成新格式', async () => {
    const t = fixture()
    const todo = t.add('补单测')
    await t.sync(null)
    asR77(t, todo)
    expect(await t.sync()).toMatchObject({ updated: 0, skipped: 1, pending: 0 })
    expect(t.sdk.batchUpdate).not.toHaveBeenCalled()
    expect(t.store.get(t.binding, todo.id)!.fingerprint).toMatch(/^v4:/)
  })

  it('更早的旧指纹：观察和风险只建基线（人清空的风险不恢复），「关联」按空比较、有内容就补上', async () => {
    const t = fixture()
    t.github.set('org/repo#12', read('pull', 'open'))
    const todo = t.add(`合并登录修复 ${PR_URL}`, { dueMs: Date.now() - 3 * DAY })
    await t.sync(null)
    const stored = t.store.get(t.binding, todo.id)!
    t.store.remember(t.binding, todo.id, stored.recordId, 'old-local-only-fingerprint')
    Object.assign(t.row(todo), { 风险: '', 'Friday 观察': '人工已知悉' })
    expect(await t.sync()).toMatchObject({ updated: 1, pending: 0 })
    expect(t.sent().at(-1)).toEqual([{ 关联: `PR org/repo#12：未合并 ${PR_URL}` }])
    expect(t.row(todo)).toMatchObject({ 风险: '', 'Friday 观察': '人工已知悉' })
    expect(await t.sync()).toMatchObject({ updated: 0, skipped: 1 })
  })
})

describe('GitHub 只读状态读取（待办完成证据与 PMO 共用）', () => {
  it('只发 GET：Issue 读一次，PR 再读合并状态；仓库不在允许范围不发请求；出错或请求前核验失败按读不到', async () => {
    const { readGitHubLinkState } = await import('../src/github/link-state.js')
    const responses: Record<string, unknown> = {
      '/repos/org/repo/issues/7': { state: 'closed', state_reason: 'completed' },
      '/repos/org/repo/issues/12': { state: 'closed', state_reason: null, pull_request: {} },
      '/repos/org/repo/pulls/12': { merged: true },
    }
    const calls: string[] = []
    const github = { repoAllowed: (repo: string) => repo === 'org/repo',
      api: vi.fn(async (method: string, path: string, _body?: unknown, _owner?: string, beforeRequest?: () => void) => {
        beforeRequest?.()
        calls.push(`${method} ${path}`)
        if (!(path in responses)) throw new Error(`synthetic 404 ${path}`)
        return responses[path]
      }) } as unknown as Pick<GitHubIdentity, 'api' | 'repoAllowed'>
    const ref = (kind: 'issue' | 'pull', number: number, owner = 'org', repo = 'repo'): GitHubRef =>
      ({ owner, repo, kind, number, url: `https://github.com/${owner}/${repo}/${kind === 'pull' ? 'pull' : 'issues'}/${number}` })
    expect(await readGitHubLinkState(github, ref('issue', 7))).toEqual({ status: 'read', kind: 'issue', state: 'closed', merged: false, stateReason: 'completed' })
    expect(await readGitHubLinkState(github, ref('pull', 12, 'Org', 'Repo'))).toEqual({ status: 'read', kind: 'pull', state: 'closed', merged: true, stateReason: null })
    expect(await readGitHubLinkState(github, ref('pull', 1, 'other', 'secret'))).toEqual({ status: 'unavailable', reason: '仓库不在允许范围内' })
    expect(await readGitHubLinkState(github, ref('issue', 99))).toMatchObject({ status: 'unavailable' })
    expect(await readGitHubLinkState(github, ref('issue', 7), () => { throw new Error('binding changed') })).toMatchObject({ status: 'unavailable' })
    expect(calls).toEqual(['GET /repos/org/repo/issues/7', 'GET /repos/org/repo/issues/12', 'GET /repos/org/repo/pulls/12', 'GET /repos/org/repo/issues/99'])
  })
})

describe('宿主接线：syncPmo / 手动同步', () => {
  function hostFixture() {
    const registry = new Registry(':memory:'); cleanups.push(() => registry.close())
    const cfg = loadConfig({ FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test', FRIDAY_REFLECT: 'off' })
    const sp = spaceDeps(registry.db)
    const a = sp.spaces.ensure({ kind: 'group', chatId: 'group-a', openId: 'alice', title: 'A群' })
    sp.spaces.dm('alice')
    const todos = new Todos(registry.db), pmo = new PmoStore(registry.db), feishu = new FakeFeishu()
    const rows = new Map<string, Record<string, unknown>>()
    /** 表里现有的列：名字 → 类型 */
    const columns = new Map<string, number>()
    let record = 0
    const bitable = {
      baseUrl: (app: string, table?: string) => `https://example.invalid/base/${app}${table ? `?table=${table}` : ''}`,
      createBase: vi.fn(async () => ({ appToken: 'base1', url: 'https://example.invalid/base/base1' })),
      ensureTable: vi.fn(async () => 'table'),
      listFields: vi.fn(async () => [...columns].map(([fieldName, type]) => ({ fieldName, type }))),
      ensureFields: vi.fn(async (_app: string, _table: string, fields: { field_name: string; type: number }[]) => {
        let added = 0
        for (const field of fields) if (!columns.has(field.field_name)) { columns.set(field.field_name, field.type); added++ }
        return added
      }),
      listRecords: vi.fn(async () => ({ records: [...rows].map(([recordId, fields]) => ({ recordId, fields: structuredClone(fields) })), complete: true })),
      batchCreate: vi.fn(async (_app: string, _table: string, records: { fields: Record<string, unknown> }[]) =>
        records.map(item => { const id = `record${++record}`; rows.set(id, structuredClone(item.fields)); return id })),
      batchUpdate: vi.fn(async (_app: string, _table: string, records: { recordId: string; fields: Record<string, unknown> }[]) => {
        for (const item of records) Object.assign(rows.get(item.recordId)!, structuredClone(item.fields))
        return records.length
      }),
    }
    const githubCalls: string[] = []
    const pulls = new Map<number, { state: 'open' | 'closed'; merged: boolean }>()
    const github = { repoAllowed: (repo: string) => repo.toLowerCase() === 'org/repo',
      api: vi.fn(async (_method: string, path: string, _body?: unknown, _owner?: string, beforeRequest?: () => void) => {
        beforeRequest?.()
        githubCalls.push(path)
        const match = path.match(/^\/repos\/org\/repo\/(issues|pulls)\/(\d+)$/)
        const pull = match ? pulls.get(Number(match[2])) : undefined
        if (!match || !pull) throw new Error('synthetic not found')
        return match[1] === 'issues' ? { state: pull.state, state_reason: null, pull_request: {} } : { merged: pull.merged }
      }) }
    const orchestrator = new Orchestrator({ cfg, registry, todos, pmo, ...sp, feishu: asFeishuClient(feishu), bitable: bitable as unknown as Bitable,
      github: github as unknown as GitHubIdentity, runtime: {} as AcpRuntime, memory: new ChannelMemory(registry.db), tokens: new TokenIssuer('test'),
      apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/unused', botOpenId: 'bot', log: createLogger('pmo-links-host', 'error') })
    const actor: AbilityActor = { sessionKey: 'test', chatId: 'group-a', requesterOpenId: 'alice', chatType: 'group' }
    const row = (todoId: number) => [...rows.values()].find(fields => fields['编号'] === todoId)!
    const dms = () => feishu.of('sendToUser').map(item => ({ to: item.target, text: (item.payload as { text?: string }).text ?? '' }))
    const ensured = () => bitable.ensureFields.mock.calls.map(call => call[2].map(field => field.field_name).join('|'))
    return { a, todos, bitable, rows, columns, githubCalls, pulls, orchestrator, actor, row, dms, ensured }
  }

  it('手动和定时同步都读 GitHub：只读允许范围内的仓库，范围外写“未读到”且不发请求', async () => {
    const t = hostFixture()
    t.pulls.set(12, { state: 'open', merged: false })
    const inside = t.todos.add({ scope: spaceScope(t.a.id), title: `合并 ${PR_URL}` })
    const outside = t.todos.add({ scope: spaceScope(t.a.id), title: '看看 https://github.com/other/secret/pull/3' })
    expect(await t.orchestrator.abilities.pmo(t.actor, 'init')).toContain('仅来自本群空间')
    expect(t.row(inside.id)['关联']).toBe(`PR org/repo#12：未合并 ${PR_URL}`)
    expect(t.row(outside.id)['关联']).toBe('PR other/secret#3：未读到 https://github.com/other/secret/pull/3')
    expect(t.githubCalls).toEqual(['/repos/org/repo/issues/12', '/repos/org/repo/pulls/12'])
    t.pulls.set(12, { state: 'closed', merged: true })
    expect(await t.orchestrator.syncPmo()).toMatchObject({ updated: 1, pending: 0 })
    expect(t.row(inside.id)['关联']).toBe(`PR org/repo#12：已合并 ${PR_URL}`)
    expect(t.githubCalls.filter(path => path.includes('other'))).toEqual([])
    // 建表时按全表补列；之后列都在，每轮只读一次列清单，不再补
    expect(t.ensured()).toEqual([PMO_FIELDS.map(field => field.field_name).join('|')])
    expect(t.bitable.listFields).toHaveBeenCalledTimes(2)
  })

  it('r77 建的表没有「关联」列：同步前只补 Friday 自有的三列，人删掉的列不替人加回来；补上后写这一格', async () => {
    const t = hostFixture()
    t.pulls.set(12, { state: 'open', merged: false })
    const todo = t.todos.add({ scope: spaceScope(t.a.id), title: `合并 ${PR_URL}` })
    await t.orchestrator.abilities.pmo(t.actor, 'init')
    // 回到 r77 的表：没有「关联」列（也没有这一格），人还删了一列「状态说明」
    t.columns.delete('关联'); t.columns.delete('状态说明'); delete t.row(todo.id)['关联']
    t.pulls.set(12, { state: 'closed', merged: true })
    expect(await t.orchestrator.syncPmo()).toMatchObject({ updated: 1, pending: 0 })
    expect(t.ensured().at(-1)).toBe('Friday 观察|风险|关联')
    expect(t.columns.has('关联')).toBe(true)
    expect(t.columns.has('状态说明')).toBe(false)
    expect(t.row(todo.id)['关联']).toBe(`PR org/repo#12：已合并 ${PR_URL}`)
  })

  it('补列失败：这一轮不写「关联」、不读 GitHub，观察和风险照常写', async () => {
    const t = hostFixture()
    t.pulls.set(12, { state: 'open', merged: false })
    await t.orchestrator.abilities.pmo(t.actor, 'init')
    t.columns.delete('关联')
    t.bitable.ensureFields.mockRejectedValue(Object.assign(new Error('synthetic: no field permission'), { code: 91403 }))
    const todo = t.todos.add({ scope: spaceScope(t.a.id), title: `合并 ${PR_URL}`, dueMs: Date.now() - 3 * DAY })
    expect(await t.orchestrator.syncPmo()).toMatchObject({ created: 1, pending: 0 })
    expect(t.row(todo.id)).not.toHaveProperty('关联')
    expect(t.row(todo.id)).toMatchObject({ 风险: '已过截止' })
    expect(t.githubCalls).toEqual([])
    expect(t.dms()).toEqual([])
  })

  it('表里已有人建的同名非文本「关联」列：不接管、不写这一列，其余照常', async () => {
    const t = hostFixture()
    t.pulls.set(12, { state: 'open', merged: false })
    await t.orchestrator.abilities.pmo(t.actor, 'init')
    t.columns.set('关联', 18)
    const calls = t.bitable.ensureFields.mock.calls.length
    const todo = t.todos.add({ scope: spaceScope(t.a.id), title: `合并 ${PR_URL}` })
    expect(await t.orchestrator.syncPmo()).toMatchObject({ created: 1, pending: 0 })
    expect(t.row(todo.id)).not.toHaveProperty('关联')
    expect(t.bitable.ensureFields).toHaveBeenCalledTimes(calls)
    expect(t.githubCalls).toEqual([])
  })

  it('表格改成只读：写入被拒只私聊绑定人一次，之后几轮和手动同步都不再私聊', async () => {
    const t = hostFixture()
    t.pulls.set(12, { state: 'open', merged: false })
    t.todos.add({ scope: spaceScope(t.a.id), title: `合并 ${PR_URL}` })
    await t.orchestrator.abilities.pmo(t.actor, 'init')
    const readOnly = Object.assign(new Error('synthetic: read only'), { code: 1254302 })
    t.bitable.batchUpdate.mockRejectedValue(readOnly)
    t.bitable.batchCreate.mockRejectedValue(readOnly)
    t.pulls.set(12, { state: 'closed', merged: true })
    t.todos.add({ scope: spaceScope(t.a.id), title: '新加的事项' })
    await t.orchestrator.syncPmo()
    expect(t.dms()).toEqual([{ to: 'alice', text: expect.stringContaining('写入被拒（code=1254302）') }])
    await t.orchestrator.syncPmo()
    expect(await t.orchestrator.abilities.pmo(t.actor, 'sync')).toContain('写入被拒（code=1254302）')
    await t.orchestrator.syncPmo()
    expect(t.dms()).toHaveLength(1)
    // 被拒的是真实写入：更新里带着「关联」这一格
    expect(t.bitable.batchUpdate.mock.calls.some(call => call[2].some(item => '关联' in item.fields))).toBe(true)
  })
})
