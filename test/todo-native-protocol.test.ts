import type { AddressInfo } from 'node:net'
import { AxiosError } from 'axios'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { Todos, type Todo } from '../src/core/todos.js'
import { FeishuTaskSync } from '../src/core/feishu-task-sync.js'
import { FeishuTaskError, type FeishuTask, type CreateTaskInput, type PatchTaskInput } from '../src/feishu/tasks.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer, type CapabilityScope } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const GUID = '70577c8f-91ab-4c91-b359-a21a751054e8'
const URL = `https://applink.feishu.cn/client/todo/detail?guid=${GUID}&suite_entity_num=t192012`
const ALICE = 'ou_a1'
type Reply = { isError?: boolean; content: { type: string; text?: string }[] }
const text = (reply: Reply) => reply.content.map(item => item.text ?? '').join('\n')
const decode = (reply: Reply) => { expect(reply.isError, text(reply)).not.toBe(true); return JSON.parse(text(reply)) }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

/** Real MCP SDK, signed API, current Run/Space, Todo and native-operation DB;
 * only the Feishu provider is synthetic. No production task is created. */
async function fixture(options: { scopes?: CapabilityScope[]; enabled?: boolean; group?: boolean } = {}) {
  const registry = new Registry(':memory:'), sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: options.group ? 'group' : 'p2p', chatId: options.group ? 'group-native' : 'dm-native', openId: ALICE })
  const todos = new Todos(registry.db), attempts = new RunAttempts(registry.db), calls = new RunApiCalls(registry.db)
  const log = createLogger('todo-native-protocol', 'error'), cache = new MessageCache(registry.db), feishu = asFeishuClient(new FakeFeishu())
  const state = { sourceSafe: true, stage: 'task', loseCreate: false, losePatch: false, beforeGet: undefined as (() => void | Promise<void>) | undefined,
    getError: undefined as unknown, nextGuid: GUID }
  const remote = new Map<string, FeishuTask>()
  const tasks = {
    create: vi.fn(async (value: CreateTaskInput): Promise<FeishuTask> => {
      const task = { guid: state.nextGuid, summary: value.summary, description: value.description ?? null, dueMs: value.dueMs ?? null,
        completedAt: value.completedAtMs || undefined, assigneeOpenIds: [...(value.assigneeOpenIds ?? [])], extra: value.extra, url: URL }
      remote.set(task.guid, task)
      if (state.loseCreate) throw new AxiosError('synthetic ACK missing', 'ECONNRESET')
      return structuredClone(task)
    }),
    get: vi.fn(async (guid: string): Promise<FeishuTask> => {
      await state.beforeGet?.()
      if (state.getError) throw state.getError
      const task = remote.get(guid); if (!task) throw new FeishuTaskError('读任务', 1470404, 'synthetic missing')
      return structuredClone(task)
    }),
    patch: vi.fn(async (guid: string, value: PatchTaskInput): Promise<FeishuTask> => {
      const old = remote.get(guid)!, task = { ...old,
        ...(value.summary !== undefined ? { summary: value.summary } : {}), ...(value.description !== undefined ? { description: value.description } : {}),
        ...(value.dueMs !== undefined ? { dueMs: value.dueMs } : {}), ...(value.completedAtMs !== undefined ? { completedAt: value.completedAtMs || undefined } : {}) }
      remote.set(guid, task); if (state.losePatch) throw new AxiosError('synthetic ACK missing', 'ECONNRESET'); return structuredClone(task)
    }),
    delete: vi.fn(async (guid: string) => { remote.delete(guid) }),
  }
  const sync = new FeishuTaskSync({ db: registry.db, todos, tasks: tasks as never, log, cancellation: 'delete' })
  registry.createSession({ sessionKey: 's-native', chatId: space.chatId, chatType: space.kind, requesterOpenId: ALICE, cwd: '/tmp/synthetic-native' })
  const task = registry.createTaskOnce({ sessionKey: 's-native', requesterOpenId: ALICE, messageId: 'om-native', prompt: '按我明确给出的选择处理这条待办',
    inbound: { eventId: 'event-native', messageId: 'om-native', chatId: space.chatId, chatType: space.kind,
      senderOpenId: ALICE, senderType: 'user', msgType: 'text', text: '按我明确给出的选择处理这条待办', mentions: [], createTimeMs: Date.now() } }).task
  registry.startTask(task.id, Date.now(), 's-native')
  const run = attempts.begin({ sessionKey: 's-native', taskId: task.id, workKey: registry.taskWork.get(task.id)!.key, actorOpenId: ALICE,
    triggerKey: 'native-protocol', stage: 'task', now: Date.now() })!
  attempts.bindExecutionBoundary(run.id, 'managed_api_v1')
  const tokens = new TokenIssuer('synthetic-native-protocol')
  const api = createInternalApi({ registry, ...sp, todos, taskSync: options.enabled === false ? undefined : sync, tokens, log,
    feishu, messageCache: cache, memory: new ChannelMemory(registry.db), messages: new MessageService(feishu, cache, log), maxHistoryPerCall: 10,
    resolveActorForSession: key => key === 's-native' && attempts.isCurrent(run.id) ? { requesterOpenId: ALICE, taskId: task.id, runId: run.id, stage: state.stage } : undefined,
    canPersistDerivedState: () => state.sourceSafe,
  })
  await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done))
  const apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const token = tokens.issue({ sessionKey: 's-native', runId: run.id, chatId: space.chatId, chatType: space.kind, requesterOpenId: ALICE,
    spaceId: space.id, scopes: options.scopes ?? ['todo:read', 'todo:write'] })
  const server = buildServer({ apiUrl, token }), client = new Client({ name: 'todo-native-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
  cleanups.push(async () => { await client.close(); await server.close(); api.beginShutdown(); api.server.closeAllConnections()
    expect((await api.waitForShutdown(3000)).drained).toBe(true)
    await new Promise<void>(done => api.server.close(() => done())); registry.close() })
  const add = (overrides: Record<string, unknown> = {}) => todos.add({ scope: `space:${space.id}`, title: '原任务', confirmed: true,
    ownerOpenId: ALICE, createdBy: ALICE, sessionKey: 's-native', ...overrides })
  const call = async (operation: string, args: Record<string, unknown>): Promise<Reply> => await client.callTool({ name: `friday_todo_native_${operation}`, arguments: args }) as Reply
  const post = async (operation: string, body: Record<string, unknown>, auth = token) => {
    const response = await fetch(`${apiUrl}/v1/todo/native/${operation}`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const operationRows = (id: number) => registry.db.prepare('SELECT * FROM feishu_task_operations WHERE todo_id=? ORDER BY rowid').all(id)
  async function unknownCreate() { const todo = add(); state.loseCreate = true; expect(await sync.sweep()).toMatchObject({ unknown: 1 }); return todo }
  async function conflict() {
    const todo = add(); expect(await sync.sweep()).toMatchObject({ created: 1 })
    todos.update(todo.id, todo.scope, { title: 'Friday 的新内容' }); remote.get(GUID)!.summary = '飞书的新内容'
    expect(await sync.sweep()).toMatchObject({ conflicts: 1 }); return todos.get(todo.id)!
  }
  return { registry, sp, space, todos, sync, tasks, remote, state, run, attempts, calls, tokens, token, client, add, call, post, operationRows, unknownCreate, conflict }
}

describe('manual native task actions through MCP and signed API', () => {
  it.each(['friday', 'feishu'] as const)('records the explicit %s conflict choice, then the existing sweep applies it once', async keep => {
    const t = await fixture(), todo = await t.conflict(), beforeWrites = t.tasks.patch.mock.calls.length
    const result = decode(await t.call('resolve', { id: todo.id, keep }))
    expect(result).toMatchObject({ ok: true, applied: true }); expect(result.note).toContain('下一轮')
    expect(t.tasks.patch).toHaveBeenCalledTimes(beforeWrites)
    expect(decode(await t.call('resolve', { id: todo.id, keep }))).toMatchObject({ applied: false })
    await t.sync.sweep()
    expect(t.todos.get(todo.id)?.title).toBe(keep === 'friday' ? 'Friday 的新内容' : '飞书的新内容')
    expect(t.remote.get(GUID)?.summary).toBe(t.todos.get(todo.id)?.title)
    expect(t.tasks.create).toHaveBeenCalledOnce()
    expect(t.calls.forRun(t.run.id).some(row => row.route.endsWith('/native/resolve') && row.state === 'returned')).toBe(true)
  })
  it('reconciles only the original marker/assignee and never repeats the unknown create', async () => {
    const t = await fixture(), todo = await t.unknownCreate(), original = t.operationRows(todo.id)[0]!
    const result = decode(await t.call('reconcile', { id: todo.id, task_url: URL }))
    expect(result).toMatchObject({ applied: true, native: { state: 'synced', url: URL } })
    expect(t.operationRows(todo.id)).toMatchObject([{ id: original.id, state: 'returned' }])
    expect(t.sync.link(todo.id)?.guid).toBe(GUID); expect(t.tasks.create).toHaveBeenCalledOnce()
    expect(decode(await t.call('reconcile', { id: todo.id, task_url: URL }))).toMatchObject({ applied: false })
    expect(t.tasks.get).toHaveBeenCalledOnce()
  })
  it.each(['marker', 'owner', 'guid'])('keeps the original operation unknown for mismatched %s', async field => {
    const t = await fixture(), todo = await t.unknownCreate(), original = t.operationRows(todo.id)
    if (field === 'marker') t.remote.get(GUID)!.extra = 'not-our-operation'
    if (field === 'owner') t.remote.get(GUID)!.assigneeOpenIds = ['ou_b2']
    if (field === 'guid') t.remote.get(GUID)!.guid = 'c797feb0-4d45-426d-9bb2-e6b21f7b3f0c'
    expect(decode(await t.call('reconcile', { id: todo.id, task_url: URL }))).toMatchObject({ applied: false })
    expect(t.operationRows(todo.id)).toEqual(original); expect(t.sync.link(todo.id)).toBeUndefined()
  })
  it('abandons only the existing unknown creation after the explicit human decision, retaining its receipt', async () => {
    const t = await fixture(), todo = await t.unknownCreate(), original = t.operationRows(todo.id)[0]!
    const result = decode(await t.call('abandon_create', { id: todo.id }))
    expect(result).toMatchObject({ applied: true }); expect(result.note).toContain('会出现两条')
    expect(t.tasks.create).toHaveBeenCalledOnce(); expect(t.operationRows(todo.id)).toMatchObject([{ id: original.id, state: 'abandoned' }])
    expect(decode(await t.call('abandon_create', { id: todo.id }))).toMatchObject({ applied: false })
    t.state.loseCreate = false; t.state.nextGuid = 'c797feb0-4d45-426d-9bb2-e6b21f7b3f0c'; await t.sync.sweep()
    expect(t.tasks.create).toHaveBeenCalledTimes(2)
    expect(t.operationRows(todo.id)).toMatchObject([{ id: original.id, state: 'abandoned' }, { state: 'returned' }])
  })
  it.each(['scope', 'chat', 'actor', 'candidate'])('rejects foreign %s before native reads or mutation', async kind => {
    const t = await fixture(), todo = await t.unknownCreate()
    if (kind === 'scope') t.registry.db.prepare('UPDATE todos SET scope=? WHERE id=?').run('space:foreign', todo.id)
    if (kind === 'chat') t.registry.db.prepare('UPDATE sessions SET chat_id=? WHERE session_key=?').run('other-chat', 's-native')
    if (kind === 'actor') t.registry.db.prepare('UPDATE sessions SET requester_open_id=? WHERE session_key=?').run('ou_b2', 's-native')
    if (kind === 'candidate') t.registry.db.prepare('UPDATE todos SET confirmed=0 WHERE id=?').run(todo.id)
    const before = t.operationRows(todo.id)
    const result = await t.call('reconcile', { id: todo.id, task_url: URL })
    expect(result.isError).toBe(true); expect(t.operationRows(todo.id)).toEqual(before); expect(t.tasks.get).not.toHaveBeenCalled()
  })
  it.each(['source', 'stop', 'space', 'content', 'pointer'])('rechecks %s during provider GET before accepting a reconciliation', async kind => {
    const t = await fixture(), todo = await t.unknownCreate(), entered = deferred(), release = deferred()
    t.state.beforeGet = async () => { entered.resolve(); await release.promise }
    const pending = t.call('reconcile', { id: todo.id, task_url: URL }); await entered.promise
    if (kind === 'source') t.state.sourceSafe = false
    if (kind === 'stop') t.attempts.finish(t.run.id, 'cancelled', Date.now(), 'user_stop')
    if (kind === 'space') t.sp.spaces.archive(t.space.id)
    if (kind === 'content') t.todos.update(todo.id, todo.scope, { title: '后来真实的新输入' })
    if (kind === 'pointer') t.registry.db.prepare("UPDATE feishu_task_operations SET state='abandoned' WHERE todo_id=?").run(todo.id)
    const before = t.operationRows(todo.id); release.resolve()
    const result = await pending
    expect(result.isError).toBe(true); expect(t.sync.link(todo.id)).toBeUndefined(); expect(t.operationRows(todo.id)).toEqual(before)
  })
  it('rechecks the same effect guard on resolve after GET, not merely after the local transaction', async () => {
    const t = await fixture(), todo = await t.conflict(), entered = deferred(), release = deferred()
    const before = t.registry.db.prepare('SELECT * FROM feishu_task_links WHERE todo_id=?').get(todo.id)
    t.state.beforeGet = async () => { entered.resolve(); await release.promise }
    const pending = t.call('resolve', { id: todo.id, keep: 'friday' }); await entered.promise; t.state.sourceSafe = false; release.resolve()
    expect((await pending).isError).toBe(true)
    expect(t.registry.db.prepare('SELECT * FROM feishu_task_links WHERE todo_id=?').get(todo.id)).toEqual(before)
  })
  it.each([
    [99991672, '应用缺少'], [99991663, '应用访问凭证'], [1470403, '访问权'], [1470404, '没有找到'], [99991400, '频率'],
  ])('keeps unknown creation for provider %s and explains %s', async (code, phrase) => {
    const t = await fixture(), todo = await t.unknownCreate(), original = t.operationRows(todo.id)
    t.state.getError = new FeishuTaskError('读任务', Number(code), 'synthetic provider detail')
    const result = await t.call('reconcile', { id: todo.id, task_url: URL })
    expect(result.isError).toBe(true); expect(text(result)).toContain(String(phrase)); expect(t.operationRows(todo.id)).toEqual(original)
    expect(t.tasks.create).toHaveBeenCalledOnce()
  })
  it('reports typed network failure without abandoning an unknown creation', async () => {
    const t = await fixture(), todo = await t.unknownCreate(), original = t.operationRows(todo.id)
    t.state.getError = new AxiosError('synthetic network failure', 'ECONNRESET')
    const result = await t.post('reconcile', { id: todo.id, task_url: URL })
    expect(result.status).toBe(503); expect(JSON.stringify(result.body)).toContain('网络暂时不可用'); expect(t.operationRows(todo.id)).toEqual(original)
  })
  it.each(['bad-signature', 'read-only', 'background', 'disabled'])('does not admit a %s actor', async kind => {
    const t = await fixture({ ...(kind === 'read-only' ? { scopes: ['todo:read'] as CapabilityScope[] } : {}), enabled: kind !== 'disabled' }), todo = await t.unknownCreate()
    if (kind === 'background') t.state.stage = 'proactive'
    const before = t.operationRows(todo.id), response = await t.post('abandon-create', { id: todo.id }, kind === 'bad-signature' ? 'invalid' : t.token)
    expect(response.status).toBeGreaterThanOrEqual(400); expect(t.operationRows(todo.id)).toEqual(before)
  })
  it.each([
    { id: 1, confirmed: true }, { id: 1, actor: ALICE }, { id: 1, current: true }, { id: 1, authorization: 'approved' },
  ])('does not accept model-provided authorization fields %#', async body => {
    const t = await fixture(), todo = await t.unknownCreate(), before = t.operationRows(todo.id)
    expect((await t.post('abandon-create', { ...body, id: todo.id })).status).toBe(400)
    expect(t.operationRows(todo.id)).toEqual(before)
  })
  it.each(['https://evil.example/?guid=' + GUID, 'https://applink.feishu.cn/client/todo/detail?guid=' + GUID + '&guid=' + GUID,
    'https://applink.feishu.cn/client/todo/detail?guid=../../secret', 'https://user:pass@applink.feishu.cn/client/todo/detail?guid=' + GUID])('does not fetch an arbitrary task URL %s', async url => {
    const t = await fixture(), todo = await t.unknownCreate()
    expect((await t.post('reconcile', { id: todo.id, task_url: url })).status).toBe(400)
    expect(t.tasks.get).not.toHaveBeenCalled()
  })
})
