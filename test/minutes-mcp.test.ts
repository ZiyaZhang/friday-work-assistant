import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../src/mcp/server.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllGlobals()
})

async function fixture(response: unknown, status = 200) {
  const requests: { path: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    requests.push({ path: new URL(url).pathname, body: JSON.parse(String(options.body)) })
    return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } })
  }))
  const server = buildServer({ apiUrl: 'http://127.0.0.1:1', token: 'synthetic-capability' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'minutes-test', version: '1.0.0' })
  await client.connect(clientTransport)
  cleanup.push(async () => { await client.close(); await server.close() })
  return { client, requests }
}

function parseText(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = result.content as { type: string; text?: string }[]
  return JSON.parse(content.filter(item => item.type === 'text').map(item => item.text).join('\n'))
}

describe('Minutes MCP tools', () => {
  it('passes the search window and continuation without hiding incomplete coverage', async () => {
    const response = { minutes: [{ token: 'minute_a' }], coverage: { complete: false, hasMore: true, nextPageToken: 'page_3', notice: 'Only part of the requested window' } }
    const { client, requests } = await fixture(response)
    const args = { query: 'release', start_time: '2026-09-15T00:00:00+08:00', end_time: '2026-09-22T00:00:00+08:00', page_token: 'page_2', limit: 10 }
    expect(parseText(await client.callTool({ name: 'feishu_my_minutes', arguments: args }))).toEqual(response)
    expect(requests).toEqual([{ path: '/v1/minutes/recent', body: args }])
  })

  it('reads exactly one selected minute without creating tasks or subscribing', async () => {
    const response = { minute: { token: 'minute_a', createdAtMs: 1669098360477 }, artifacts: { summary: 'Synthetic summary', coverage: { summary: 'present', todos: 'absent' } } }
    const { client, requests } = await fixture(response)
    expect(parseText(await client.callTool({ name: 'feishu_read_minute', arguments: { minute_token: 'minute_a' } }))).toEqual(response)
    expect(requests).toEqual([{ path: '/v1/minutes/read', body: { minute_token: 'minute_a' } }])
  })

  it('preserves todo ownership and provider completion rather than claiming a Friday todo was created', async () => {
    const response = { token: 'minute_a', todos: [{ content: 'Bob follows up', assignees: ['ou_bob'], isDone: true, todoId: 'todo_b' }], coverage: { todos: 'present' } }
    const { client, requests } = await fixture(response)
    expect(parseText(await client.callTool({ name: 'feishu_minute_todos', arguments: { minute_token: 'minute_a' } }))).toEqual(response)
    expect(requests).toEqual([{ path: '/v1/minutes/todos', body: { minute_token: 'minute_a' } }])
  })

  it('returns permission failure as an error, never as an empty meeting or todo list', async () => {
    const { client, requests } = await fixture({ error: '请补充妙记个人授权' }, 403)
    const result = await client.callTool({ name: 'feishu_minute_todos', arguments: { minute_token: 'minute_a' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('请补充妙记个人授权')
    expect(requests).toHaveLength(1)
  })

  it('validates untrusted minute identifiers before contacting the gateway', async () => {
    const { client, requests } = await fixture({})
    const result = await client.callTool({ name: 'feishu_read_minute', arguments: { minute_token: '../../different/path' } })
    expect(result.isError).toBe(true)
    expect(requests).toEqual([])
  })

  it('hands selected action items to the owner for confirmation; the tool itself creates no Todo', async () => {
    const response = { draftId: 'draft_a', state: 'pending', reviewDelivered: true, items: 2 }
    const { client, requests } = await fixture(response)
    expect(parseText(await client.callTool({ name: 'feishu_propose_minute_todos', arguments: { minute_token: 'minute_a', items: [0, 2] } }))).toEqual(response)
    expect(requests).toEqual([{ path: '/v1/minutes/todos/propose', body: { minute_token: 'minute_a', items: [0, 2] } }])
    const tools = (await client.listTools()).tools, find = (name: string) => tools.find(item => item.name === name)!
    expect(find('feishu_propose_minute_todos').description).toContain('本工具不创建待办')
    expect(find('feishu_propose_minute_todos').annotations).toMatchObject({ readOnlyHint: false })
    // The read tool now points to the confirmation path instead of a direct Todo write.
    expect(find('feishu_minute_todos').description).toContain('feishu_propose_minute_todos')
    expect(find('feishu_propose_minute_todos').description).toContain('不要再让本人打字回复编号')
  })

  it('passes summary candidates through to the gateway, which checks each quote against the minute', async () => {
    const response = { draftId: 'draft_b', state: 'pending', reviewDelivered: true, items: 1 }
    const { client, requests } = await fixture(response)
    const candidates = [{ text: '补一轮兼容性测试', quote: '另外需要补一轮兼容性测试。' }]
    expect(parseText(await client.callTool({ name: 'feishu_propose_minute_todos', arguments: { minute_token: 'minute_a', candidates } }))).toEqual(response)
    expect(requests).toEqual([{ path: '/v1/minutes/todos/propose', body: { minute_token: 'minute_a', candidates } }])
  })

  it.each([{ minute_token: 'minute_a', items: [] }, { minute_token: 'minute_a', items: [-1] }, { minute_token: 'minute_a', items: [0.5] },
    { minute_token: 'minute_a' }, { minute_token: '../other', items: [0] }, { minute_token: 'minute_a', candidates: [] },
    { minute_token: 'minute_a', candidates: [{ text: '补测试', quote: '短' }] }, { minute_token: 'minute_a', candidates: [{ text: '补测试' }] }])('validates a proposal before contacting the gateway: %j', async args => {
    const { client, requests } = await fixture({})
    expect((await client.callTool({ name: 'feishu_propose_minute_todos', arguments: args })).isError).toBe(true)
    expect(requests).toEqual([])
  })
})
