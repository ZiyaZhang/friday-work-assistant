import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { spaceScope } from '../src/core/space.js'
import { Todos } from '../src/core/todos.js'
import type { TodoProvenance } from '../src/core/todo-provenance.js'
import { presentTodoOrigin } from '../src/core/todo-origin-presentation.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, PROACTIVE_SCOPES, TokenIssuer } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const sourceUrl = 'https://verified-message.example/original?position=%7B%22message_id%22%3A%22synthetic%22%7D'
const materialUrl = 'https://verified-message.example/container'

/** Real MCP client/server -> authenticated HTTP API -> real Todo store. Only host capture is a fixture. */
async function fixture() {
  const registry = new Registry(':memory:'); cleanups.push(() => registry.close())
  const todos = new Todos(registry.db), sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'p2p', chatId: 'actual-dm', openId: 'alice' })
  const sessionKey = 'opaque-session', runId = 'PRIVATE_CURRENT_RUN'
  registry.createSession({ sessionKey, chatId: space.chatId!, chatType: 'p2p', requesterOpenId: 'alice', cwd: '/synthetic' })
  const task = registry.createTask({ sessionKey, messageId: 'PRIVATE_REQUEST_ID', requesterOpenId: 'alice', prompt: '记录原材料' })
  const message = { messageId: task.messageId, chatId: space.chatId!, chatType: 'p2p' as const, senderOpenId: 'alice', msgType: 'text',
    createTimeMs: 1000, link: { status: 'available' as const, url: sourceUrl } }
  const provenance: TodoProvenance = { version: 1, originRunId: runId, taskId: task.id, workKey: 'PRIVATE_WORK_KEY', request: message,
    selectedInputs: [{ ref: 'PRIVATE_SELECTED_REF', taskId: 95, message: { ...message, messageId: 'PRIVATE_CONTAINER_ID',
      msgType: 'merge_forward', createTimeMs: 900, link: { status: 'unavailable' } } }],
    attachments: [{ fileId: 'PRIVATE_FILE_ID', version: 1, containerMessageId: 'PRIVATE_CONTAINER_ID', resourceMessageId: 'PRIVATE_CHILD_ID',
      contentDigest: 'b'.repeat(64), name: '问题报告.pdf', link: { status: 'available', url: materialUrl } }],
    contextSnapshot: { version: 1, acpSessionId: 'PRIVATE_ACP_ID', spaceId: space.id, chatId: space.chatId!,
      memoryScopes: [], chats: [], repositories: [], external: [{ kind: 'web', ref: 'https://private.example/?code=PRIVATE_OPAQUE', access: 'link' }] } }
  const capture = vi.fn(async (key: string, id: string) => {
    expect([key, id]).toEqual([sessionKey, runId])
    return structuredClone(provenance)
  })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), messageCache = new MessageCache(registry.db)
  const log = createLogger('todo-origin-protocol', 'error'), tokens = new TokenIssuer('synthetic-secret')
  const state = { currentRun: runId, derivedSafe: true }
  const api = createInternalApi({ registry, todos, ...sp, feishu, messageCache, memory: new ChannelMemory(registry.db),
    messages: new MessageService(feishu, messageCache, log), tokens, log, maxHistoryPerCall: 50,
    captureTodoProvenance: capture, canPersistDerivedState: () => state.derivedSafe,
    resolveActorForSession: key => key === sessionKey ? { requesterOpenId: 'alice', runId: state.currentRun, stage: 'task', taskId: task.id } : undefined })
  const updates: Record<string, unknown>[] = []
  const update = api.routes['POST /v1/todo/update']!
  api.routes['POST /v1/todo/update'] = async (cap, body) => { updates.push(structuredClone(body)); return update(cap, body) }
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    api.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => api.server.close(error => error ? reject(error) : resolve()))
  })
  const token = tokens.issue({ sessionKey, runId, chatId: space.chatId!, chatType: 'p2p', spaceId: space.id,
    requesterOpenId: 'alice', scopes: [...ALL_SCOPES] })
  const server = buildServer({ apiUrl: `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`, token })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'todo-origin-protocol', version: '1' }); await client.connect(clientTransport)
  cleanups.push(async () => { await client.close(); await server.close() })
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    return { result, text: (result.content as { type: string; text?: string }[]).map(item => item.text ?? '').join('\n') }
  }
  return { registry, todos, scope: spaceScope(space.id), client, call, capture, provenance, updates, state }
}

describe('Todo origin survives the actual MCP protocol', () => {
  it('returns the same host-recorded clickable sources after add and list without exposing internal proof', async () => {
    const t = await fixture()
    const add = await t.call('friday_todo_add', { title: '跟进问题', detail: '原始说明', certainty: 'candidate',
      source: 'https://unverified-model.example', origin: { messageId: 'MODEL_FAKE_ID' } })
    expect(add.result.isError).toBeFalsy()
    const saved = t.todos.list(t.scope)[0]!
    expect(t.capture).toHaveBeenCalledOnce()
    expect(t.todos.getProvenance(saved.id)).toEqual(t.provenance)
    const list = await t.call('friday_todo_list', {})
    expect(list.result.isError).toBeFalsy()
    for (const output of [add.text, list.text]) {
      expect(output).toContain(`[原请求](<${sourceUrl}>)`)
      expect(output).toContain(`[附件已接收：问题报告.pdf](<${materialUrl}>)`)
      expect(output).toContain('转发材料')
      expect(output.match(/部分来源链接暂不可用/g)).toHaveLength(1)
      expect(output).not.toMatch(/PRIVATE_|MODEL_FAKE|unverified-model|contextSnapshot|provenance_json|已读取/)
      expect(output).toContain(`[todo:${saved.id}]`)
    }
    const view = presentTodoOrigin(saved.origin)!
    for (const item of view.items) expect(list.text).toContain(item.label)
  })

  it('advertises update detail, passes its exact text to HTTP, and retains creation sources on amendment and status changes', async () => {
    const t = await fixture()
    await t.call('friday_todo_add', { title: '同一待办', detail: '原始描述' })
    const saved = t.todos.list(t.scope)[0]!, before = t.todos.getProvenance(saved.id)
    const tools = await t.client.listTools(), schema = tools.tools.find(tool => tool.name === 'friday_todo_update')!.inputSchema
    expect((schema.properties as Record<string, any>).detail).toMatchObject({ type: 'string', description: expect.stringContaining('替换事项说明') })
    const detail = '补充：附件中第一个例子可复现。\n保留原来的问题与验收条件。'
    const amended = await t.call('friday_todo_update', { id: saved.id, detail })
    expect(amended.result.isError).toBeFalsy()
    expect(t.updates).toEqual([{ id: saved.id, detail }])
    expect(t.todos.get(saved.id)!.detail).toBe(detail)
    expect(t.todos.list(t.scope)).toHaveLength(1)
    expect(t.todos.getProvenance(saved.id)).toEqual(before)
    expect(amended.text).toContain(`[原请求](<${sourceUrl}>)`)
    const changed = await t.call('friday_todo_update', { id: saved.id, status: 'blocked', status_note: '等本人补充日志' })
    expect(changed.result.isError).toBeFalsy()
    expect(changed.text).toContain('阻塞')
    expect(changed.text).toContain(`[附件已接收：问题报告.pdf](<${materialUrl}>)`)
    expect(t.todos.getProvenance(saved.id)).toEqual(before)
    expect(t.capture).toHaveBeenCalledOnce()
    const list = await t.call('friday_todo_list', {})
    expect(list.text).toContain(detail)
  })

  it('keeps unavailable sources honest and never infers a link from source IDs or detail text', async () => {
    const t = await fixture()
    t.provenance.request!.link = { status: 'unavailable' }
    t.provenance.attachments![0]!.link = { status: 'unavailable' }
    const added = await t.call('friday_todo_add', { title: '待核对事项', detail: '说明中的 URL 不是宿主确认的出处。' })
    expect(added.result.isError).toBeFalsy()
    expect(added.text).toContain('来源链接暂不可用。')
    expect(added.text).not.toMatch(/https:|PRIVATE_/)
    const saved = t.todos.list(t.scope)[0]!
    const updated = await t.call('friday_todo_update', { id: saved.id, confirm: true })
    expect(updated.text).toContain('来源链接暂不可用。')
    expect(updated.text).not.toMatch(/https:|PRIVATE_/)
  })

  it('does not fabricate provenance for legacy list or update results, or return sources after deletion', async () => {
    const t = await fixture(), old = t.todos.add({ scope: t.scope, title: '历史待办' })
    expect((await t.call('friday_todo_list', {})).text).not.toContain('来源：')
    expect((await t.call('friday_todo_update', { id: old.id, detail: '用户明确补充' })).text).not.toContain('来源：')
    expect(t.todos.getProvenance(old.id)).toBeNull()
    const removed = await t.call('friday_todo_update', { id: old.id, remove: true })
    expect(removed.text).toContain('已删除待办')
    expect(removed.text).not.toContain('来源')
    expect(t.capture).not.toHaveBeenCalled()
  })

  it('does not expose another scope through an ID-only update, including its immutable source links', async () => {
    const t = await fixture(), foreignUrl = 'https://verified-message.example/other-person'
    const provenance: TodoProvenance = { ...structuredClone(t.provenance), originRunId: 'other-run', taskId: 999, workKey: 'other-work',
      request: { ...t.provenance.request!, messageId: 'OTHER_PRIVATE_MESSAGE', chatId: 'other-chat', senderOpenId: 'bob',
        link: { status: 'available', url: foreignUrl } }, selectedInputs: [], attachments: [],
      contextSnapshot: { ...t.provenance.contextSnapshot, spaceId: 'other-space', chatId: 'other-chat' } }
    const foreign = t.todos.add({ scope: 'space:other-space', title: '另一人的私有事项', provenance })
    const rejected = await t.call('friday_todo_update', { id: foreign.id })
    expect(rejected.result.isError).toBe(true)
    expect(rejected.text).not.toContain(foreignUrl)
    expect(rejected.text).not.toContain('另一人的私有事项')
    expect(rejected.text).not.toContain('来源：')
    expect(t.todos.getProvenance(foreign.id)).toEqual(provenance)
    // An unchanged update in the caller's own scope remains an honest readback.
    await t.call('friday_todo_add', { title: '本人的事项' })
    const own = t.todos.list(t.scope)[0]!, before = t.todos.getProvenance(own.id)
    const unchanged = await t.call('friday_todo_update', { id: own.id })
    expect(unchanged.result.isError).toBeFalsy()
    expect(unchanged.text).toContain(`[原请求](<${sourceUrl}>)`)
    expect(t.todos.getProvenance(own.id)).toEqual(before)
  })

  it.each(['different-chat', 'different-dm-owner'])('uses the existing audience boundary for list and every mutation when a same-scope session has %s', async mismatch => {
    const t = await fixture(), sessionKey = 'other-session'
    t.registry.createSession({ sessionKey, chatId: mismatch === 'different-chat' ? 'other-chat' : 'actual-dm',
      chatType: 'p2p', requesterOpenId: 'bob', cwd: '/synthetic' })
    const hidden = t.todos.add({ scope: t.scope, title: '不可见的旧受众待办', sessionKey, confirmed: false, provenance: t.provenance })
    const before = t.todos.get(hidden.id), beforeProof = t.todos.getProvenance(hidden.id)
    // Missing legacy session evidence is still a valid local row, not an inferred foreign source.
    const legacy = t.todos.add({ scope: t.scope, title: '本会话的历史待办' })
    const list = await t.call('friday_todo_list', {})
    expect(list.result.isError).toBeFalsy()
    expect(list.text).toContain('已显示 1/1 条')
    expect(list.text).toContain(legacy.title)
    expect(list.text).not.toContain(hidden.title)
    expect(list.text).not.toContain(sourceUrl)
    for (const patch of [{}, { remove: true }, { confirm: true }, { status: 'done' }, { detail: '不能修改' }, { title: '不能改名' }]) {
      const result = await t.call('friday_todo_update', { id: hidden.id, ...patch })
      expect(result.result.isError).toBe(true)
      expect(result.text).not.toContain(sourceUrl)
      expect(result.text).not.toContain('来源：')
      expect(t.todos.get(hidden.id)).toEqual(before)
      expect(t.todos.getProvenance(hidden.id)).toEqual(beforeProof)
    }
    expect((await t.call('friday_todo_done', { id: hidden.id })).result.isError).toBe(true)
    expect(t.todos.get(hidden.id)).toEqual(before)
    expect((await t.call('friday_todo_update', { id: legacy.id, detail: '合法补充' })).result.isError).toBeFalsy()
    expect((await t.call('friday_todo_done', { id: legacy.id })).result.isError).toBeFalsy()
    expect(t.todos.get(legacy.id)!.status).toBe('done')
  })

  it('keeps signed application-identity proactive group reads, filtering foreign sessions without granting writes', async () => {
    const registry = new Registry(':memory:'); cleanups.push(() => registry.close())
    const todos = new Todos(registry.db), sp = spaceDeps(registry.db)
    const group = sp.spaces.ensure({ kind: 'group', chatId: 'actual-group' })
    const sessionKey = 'proactive-group-session', runId = 'proactive-group-run'
    registry.createSession({ sessionKey, chatId: group.chatId!, chatType: 'group', cwd: '/synthetic' })
    registry.createSession({ sessionKey: 'foreign-session', chatId: 'previous-group', chatType: 'group', cwd: '/synthetic' })
    const visible = todos.add({ scope: spaceScope(group.id), title: '当前群的事项', sessionKey })
    const hidden = todos.add({ scope: spaceScope(group.id), title: '换绑前另一个群的事项', sessionKey: 'foreign-session' })
    const feishu = asFeishuClient(new FakeFeishu()), messageCache = new MessageCache(registry.db)
    const tokens = new TokenIssuer('synthetic-proactive-secret'), log = createLogger('todo-proactive-audience', 'error')
    const api = createInternalApi({ registry, todos, ...sp, feishu, messageCache, memory: new ChannelMemory(registry.db),
      messages: new MessageService(feishu, messageCache, log), tokens, log,
      resolveActorForSession: key => key === sessionKey ? { runId, stage: 'proactive' } : undefined })
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())) })
    const token = tokens.issue({ sessionKey, runId, spaceId: group.id, chatId: group.chatId!, chatType: 'group', scopes: [...PROACTIVE_SCOPES] })
    const post = async (path: string, body: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/todo/${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() as Record<string, any> }
    }
    const list = await post('list', {})
    expect(list.status).toBe(200)
    expect(list.body.total).toBe(1)
    expect(list.body.todos.map((todo: { id: number }) => todo.id)).toEqual([visible.id])
    expect(JSON.stringify(list.body)).not.toContain(hidden.title)
    expect((await post('update', { id: visible.id, status: 'done' })).status).toBe(403)
    expect((await post('add', { title: '巡检不得私自建单' })).status).toBe(403)
    expect(todos.get(visible.id)!.status).toBe('open')
    expect(todos.count(spaceScope(group.id))).toBe(2)
  })

  it.each(['old-run', 'unsafe-derived-state'])('preserves the host write boundary on %s', async reason => {
    const t = await fixture()
    if (reason === 'old-run') t.state.currentRun = 'new-run'
    else t.state.derivedSafe = false
    const result = await t.call('friday_todo_add', { title: '不应创建' })
    expect(result.result.isError).toBe(true)
    expect(t.todos.list(t.scope)).toEqual([])
    expect(t.capture).not.toHaveBeenCalled()
    expect(result.text).not.toContain(sourceUrl)
  })

  it.each(['old-run', 'unsafe-derived-state'])('rechecks %s after async host capture and leaves no Todo row', async reason => {
    const t = await fixture()
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const waiting = new Promise<void>(resolve => { release = resolve })
    t.capture.mockImplementationOnce(async () => {
      entered()
      await waiting
      return structuredClone(t.provenance)
    })
    const pending = t.call('friday_todo_add', { title: '捕获来源后不可迟到写入' })
    await started
    expect(t.todos.list(t.scope)).toEqual([])
    if (reason === 'old-run') t.state.currentRun = 'replacement-run'
    else t.state.derivedSafe = false
    release()
    const result = await pending
    expect(result.result.isError).toBe(true)
    expect(t.capture).toHaveBeenCalledOnce()
    expect(t.todos.list(t.scope)).toEqual([])
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM todos').get()!.n).toBe(0)
    expect(result.text).not.toContain(sourceUrl)
  })
})
