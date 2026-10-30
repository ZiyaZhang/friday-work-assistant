import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { spaceScope } from '../src/core/space.js'
import { Todos, type Todo, type TodoKind, type TodoStatus } from '../src/core/todos.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('todo-list-coverage', 'error')
type ListResult = { scope: string; todos: Todo[]; total: number; truncated: boolean; limit: number }

describe('todo list coverage through HTTP and MCP', () => {
  let registry: Registry, todos: Todos, api: ReturnType<typeof createInternalApi>, baseUrl: string
  let tokens: Record<string, string>, scopes: Record<string, string>
  let client: Client, dmClient: Client

  beforeEach(async () => {
    registry = new Registry(':memory:')
    todos = new Todos(registry.db)
    const feishu = new FakeFeishu(), issuer = new TokenIssuer('synthetic-todo-list'), sp = spaceDeps(registry.db)
    tokens = {}; scopes = {}
    for (const [key, chatId, chatType, owner] of [
      ['group', 'oc_a', 'group', 'ou_alice'], ['other', 'oc_b', 'group', 'ou_alice'],
      ['dm', 'oc_dm_a', 'p2p', 'ou_alice'], ['otherDm', 'oc_dm_b', 'p2p', 'ou_bob'],
    ] as const) {
      const space = sp.spaces.ensure({ kind: chatType, chatId, openId: owner })
      const sessionKey = `todo-list:${key}`
      scopes[key] = spaceScope(space.id)
      registry.createSession({ sessionKey, chatId, chatType, requesterOpenId: owner, cwd: '/synthetic' })
      tokens[key] = issuer.issue({ sessionKey, spaceId: space.id, chatId, chatType, requesterOpenId: owner, cwd: '/synthetic', scopes: [...ALL_SCOPES] })
      if (key === 'group') tokens.denied = issuer.issue({ sessionKey, spaceId: space.id, chatId, chatType, requesterOpenId: owner, cwd: '/synthetic', scopes: [] })
    }
    const messageCache = new MessageCache(registry.db)
    api = createInternalApi({ registry, todos, feishu: asFeishuClient(feishu), memory: new ChannelMemory(registry.db), messageCache,
      messages: new MessageService(asFeishuClient(feishu), messageCache, log), ...sp, tokens: issuer, log })
    await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
    client = await connect(tokens.group!)
    dmClient = await connect(tokens.dm!)
  })

  afterEach(async () => {
    await client.close(); await dmClient.close()
    await new Promise<void>((resolve, reject) => api.server.close((err) => err ? reject(err) : resolve()))
    registry.close()
  })

  async function connect(token: string) {
    const server = buildServer({ apiUrl: baseUrl, token })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const connected = new Client({ name: 'todo-list-coverage', version: '0.0.0' })
    await connected.connect(clientTransport)
    return connected
  }

  async function post(args: Record<string, unknown> = {}, token = tokens.group!) {
    const response = await fetch(`${baseUrl}/v1/todo/list`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) })
    return { status: response.status, body: await response.json() as ListResult }
  }

  async function list(args: Record<string, unknown> = {}, connected = client) {
    const result = await connected.callTool({ name: 'friday_todo_list', arguments: args })
    return { isError: result.isError, text: (result.content as { type: string; text?: string }[]).map((x) => x.text ?? '').join('\n') }
  }

  function add(title: string, opts: { scope?: string; status?: TodoStatus; kind?: TodoKind; dueMs?: number } = {}): Todo {
    const row = todos.add({ scope: opts.scope ?? scopes.group!, title, kind: opts.kind, dueMs: opts.dueMs })
    return opts.status && opts.status !== 'open' ? todos.transition(row.id, row.scope, opts.status)! : row
  }

  it.each([30, 31, 101])('reports exact total and truncation at %i rows, including MCP default limit', async (count) => {
    for (let i = 0; i < count; i += 1) add(`合成待办 ${i}`, { dueMs: i + 1 })
    const response = await post()
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ scope: scopes.group, total: count, limit: 30, truncated: count > 30 })
    expect(response.body.todos).toHaveLength(30)
    const result = await list()
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain(`已显示 30/${count} 条`)
    if (count > 30) expect(result.text).toMatch(/收窄|提高.*limit|增加.*limit/)
    else expect(result.text).not.toMatch(/收窄|提高.*limit|增加.*limit/)
  })

  it('keeps hidden due-today open and review items recoverable after 31 undated blocked items', async () => {
    for (let i = 0; i < 31; i += 1) add(`合成阻塞 ${i}`, { status: 'blocked' })
    const dueMs = Date.now()
    const open = add('今日必须处理的合成待办', { dueMs })
    const review = add('今日必须验收的合成产物', { dueMs, status: 'review' })
    add('已结束的合成待办', { status: 'done' })
    const first = await post()
    expect(first.body).toMatchObject({ total: 33, truncated: true, limit: 30 })
    expect(first.body.todos.every((t) => t.status === 'blocked')).toBe(true)
    expect(first.body.todos.map((t) => t.id)).not.toContain(open.id)
    expect(first.body.todos.map((t) => t.id)).not.toContain(review.id)
    for (const [status, expected] of [['open', open], ['review', review]] as const) {
      const filtered = await post({ status })
      expect(filtered.body).toMatchObject({ total: 1, truncated: false, limit: 30 })
      expect(filtered.body.todos.map((t) => t.id)).toEqual([expected.id])
      const result = await list({ status })
      expect(result.isError).toBeFalsy()
      expect(result.text).toContain(expected.title)
      expect(result.text).toContain('已显示 1/1 条')
      expect(result.text).not.toContain('合成阻塞')
    }
  })

  it.each(['open', 'blocked', 'review', 'done', 'cancelled', 'active', 'all'] as const)('preserves exact status %s through MCP and HTTP', async (status) => {
    const statuses: TodoStatus[] = ['open', 'blocked', 'review', 'done', 'cancelled']
    const rows = statuses.map((s) => add(`合成独立状态 ${s}`, { status: s }))
    const selected = rows.filter((row) => status === 'all' || status === 'active' && ['open', 'blocked', 'review'].includes(row.status) || status === row.status)
    const response = await post({ status })
    expect(response.body).toMatchObject({ total: selected.length, truncated: false })
    expect(response.body.todos.map((r) => r.id).sort()).toEqual(selected.map((r) => r.id).sort())
    const result = await list({ status })
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain(`已显示 ${selected.length}/${selected.length} 条`)
    for (const row of rows) {
      if (selected.includes(row)) expect(result.text).toContain(row.title)
      else expect(result.text).not.toContain(row.title)
    }
  })

  it('forwards a larger MCP limit, reports the 101st row, and keeps counts independent of limit', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => add(`合成分页事项 ${i}`, { dueMs: i + 1 }))
    const small = await post({ limit: 1 }), large = await post({ limit: 100 })
    expect(small.body).toMatchObject({ total: 101, limit: 1, truncated: true })
    expect(small.body.todos.map((t) => t.id)).toEqual([rows[0]!.id])
    expect(large.body).toMatchObject({ total: 101, limit: 100, truncated: true })
    expect(large.body.todos).toHaveLength(100)
    const result = await list({ limit: 100 })
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('已显示 100/101 条')
    expect(result.text).toContain(`- [todo:${rows[99]!.id}] `)
    expect(result.text).not.toContain(`- [todo:${rows[100]!.id}] `)
    expect(result.text).toMatch(/收窄/)
  })

  it('applies scope, status and kind equally to the total and the returned rows without exposing other spaces', async () => {
    add('本群期限进行中', { kind: 'deadline' })
    add('本群期限待验收', { kind: 'deadline', status: 'review' })
    add('本群普通阻塞', { status: 'blocked' })
    add('本群期限已完成', { kind: 'deadline', status: 'done' })
    for (const [key, count] of [['other', 7], ['dm', 5], ['otherDm', 11]] as const) {
      for (let i = 0; i < count; i += 1) add(`私有合成 ${key} ${i}`, { scope: scopes[key], kind: 'deadline' })
    }
    const group = await post({ kind: 'deadline', limit: 1, scope: scopes.otherDm })
    expect(group.body).toMatchObject({ scope: scopes.group, total: 2, truncated: true, limit: 1 })
    expect(group.body.todos).toHaveLength(1)
    expect(group.body.todos[0]?.scope).toBe(scopes.group)
    expect((await post({ kind: 'deadline', status: 'all' })).body.total).toBe(3)
    expect((await post({ kind: 'todo' })).body.total).toBe(1)
    for (const [key, count] of [['other', 7], ['dm', 5], ['otherDm', 11]] as const) {
      const scoped = await post({ status: 'all', kind: 'deadline' }, tokens[key])
      expect(scoped.body).toMatchObject({ scope: scopes[key], total: count, truncated: false })
      expect(scoped.body.todos.every((r) => r.scope === scopes[key])).toBe(true)
    }
    const result = await list({ kind: 'deadline' }, dmClient)
    expect(result.text).toContain('已显示 5/5 条')
    expect(result.text).not.toContain('本群')
    expect(result.text).not.toContain('私有合成 other')
  })

  it('reports empty filters without counting unrelated records and does not expose totals without read scope', async () => {
    add('本群普通事项')
    add('其他群的封版', { scope: scopes.other, kind: 'freeze' })
    expect((await post({ kind: 'freeze' })).body).toMatchObject({ scope: scopes.group, todos: [], total: 0, truncated: false, limit: 30 })
    const empty = await list({ kind: 'freeze' })
    expect(empty.isError).toBeFalsy()
    expect(empty.text).toContain('没有待办')
    const denied = await post({}, tokens.denied)
    expect(denied.status).toBe(403)
    expect(denied.body).not.toHaveProperty('total')
    expect(denied.body).not.toHaveProperty('todos')
  })

  it.each([0, 101, 1.5])('rejects invalid MCP limit %s instead of silently ignoring it', async (limit) => {
    const result = await list({ limit })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/limit|validation|Invalid/i)
  })
})
