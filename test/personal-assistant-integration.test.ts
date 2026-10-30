import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { FeishuTaskSync } from '../src/core/feishu-task-sync.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { TodoApplication } from '../src/core/todo-application.js'
import { Todos, type Todo } from '../src/core/todos.js'
import { FeishuTasks, FeishuTaskError } from '../src/feishu/tasks.js'
import { normalizeCardAction } from '../src/feishu/ws.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { buildServer } from '../src/mcp/server.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { meetingRuntimeFixture } from './helpers/meeting-runtime.js'
import { dmScope, spaceDeps } from './helpers/space.js'

const ALICE = 'ou_aa', BOB = 'ou_bb', CAROL = 'ou_cc', GROUP = 'personal-assistant-group'
const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
type Reply = { isError?: boolean; content: { type: string; text?: string }[] }
function output(reply: Reply) { return reply.content.map(item => item.text ?? '').join('\n') }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
type Card = Record<string, unknown>
function nodes(value: unknown): Card[] {
  if (!value || typeof value !== 'object') return []
  return Array.isArray(value) ? value.flatMap(nodes) : [value as Card, ...Object.values(value).flatMap(nodes)]
}

/** Real Task/Run, managed ACP ownership, MCP SDK, signed HTTP, TodoApplication and
 * SQLite native receipts. Only ACP/Feishu transports are synthetic. */
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-personal-assistant-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '15000', FRIDAY_DEFAULT_EXECUTION: 'managed' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(join(home, 'db')), memory = new ChannelMemory(registry.db), todos = new Todos(registry.db)
  const application = new TodoApplication({ db: registry.db, todos }), sp = spaceDeps(registry.db)
  const group = sp.spaces.ensure({ kind: 'group', chatId: GROUP, openId: ALICE })
  for (const actor of [BOB, CAROL]) sp.spaces.addMember(group.id, actor, 'member')
  const fake = new FakeFeishu(); fake.members.set(GROUP, new Set([ALICE, BOB, CAROL]))
  const feishu = asFeishuClient(fake), log = createLogger('personal-assistant-integration', 'error')
  const cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const tokens = new TokenIssuer('synthetic-personal-assistant'), execution = managedHostRuntime(registry, home, log)
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, todoApplication: application, feishu, messages, tokens,
    runtime: execution.runtime, managed: execution.managed, botOpenId: 'bot', log,
    ingressClassifier: { classify: async () => ({ kind: 'new_work' }) }, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent' })
  type WireTask = { guid: string; summary: string; description?: string; due?: unknown; completed_at: string;
    members: { id: string; role: string; type: string }[]; extra: string; updated_at: string }
  const remote = new Map<string, WireTask>(); let serial = 0, nativeSerial = 0, now = Date.now()
  const nativeApi = {
    create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
      const task: WireTask = { guid: `native-${++nativeSerial}`, summary: data.summary, description: data.description,
        due: data.due, completed_at: data.completed_at ?? '0', members: data.members, extra: data.extra, updated_at: String(now) }
      remote.set(task.guid, task); return { code: 0, data: { task: structuredClone(task) } }
    }),
    get: vi.fn(async ({ path }: { path: { task_guid: string } }) => {
      const task = remote.get(path.task_guid)
      if (!task) throw new FeishuTaskError('读任务', 1470404, 'synthetic missing task')
      return { code: 0, data: { task: structuredClone(task) } }
    }),
    patch: vi.fn(async ({ path, data }: { path: { task_guid: string }; data: { task: Record<string, any>; update_fields: string[] } }) => {
      const task = remote.get(path.task_guid)!
      for (const field of data.update_fields) {
        if (field in data.task) (task as any)[field] = structuredClone(data.task[field])
        else delete (task as any)[field]
      }
      task.updated_at = String(now); return { code: 0, data: { task: structuredClone(task) } }
    }),
    delete: vi.fn(async ({ path }: { path: { task_guid: string } }) => {
      remote.delete(path.task_guid); return { code: 0, data: {} }
    }),
  }
  const tasks = new FeishuTasks({ task: { v2: { task: nativeApi } } } as never)
  const syncDeps = { db: registry.db, todos, tasks, log, now: () => now, assertCurrent() {}, permissionVersion: () => 1, cancellation: 'delete' as const }
  let sync = new FeishuTaskSync(syncDeps)
  const api = createInternalApi({ registry, ...sp, memory, todos, todoApplication: application, taskSync: sync,
    feishu, messages, messageCache: cache, appId: cfg.feishu.appId, tokens, log, maxHistoryPerCall: 20,
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPersistDerivedState: key => host.canPersistDerivedState(key), captureTodoProvenance: (key, run) => host.captureTodoProvenance(key, run) })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const current = () => {
    const prompt = execution.peer.state.allPrompts.at(-1)!, session = registry.getSessionByAcpId(prompt.sessionId)!
    const servers = prompt.mcpServers as { env: { name: string; value: string }[] }[]
    return { session, token: servers[0]!.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value }
  }
  const post = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/v1/todo/${route}`, { method: 'POST', headers: {
      authorization: `Bearer ${current().token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as { todo?: Todo; error?: string; native?: { state: string; label: string }; removed?: number; outcome?: string; note?: string } }
  }
  const call = async (name: string, args: Record<string, unknown>) => {
    const server = buildServer({ apiUrl: base, token: current().token }), client = new Client({ name: 'personal-assistant', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    try { return await client.callTool({ name, arguments: args }) as Reply } finally { await client.close(); await server.close() }
  }
  const during = async (actor: string, kind: 'p2p' | 'group', work: () => Promise<void>) => {
    let called = false, failed: { error: unknown } | undefined
    const messageId = `personal-request-${++serial}`, chatId = kind === 'group' ? GROUP : `dm-${actor}`
    execution.peer.state.script = [{ kind: 'hook', run: async () => { called = true; try { await work() } catch (error) { failed = { error } } } },
      { kind: 'text', text: '本轮合成事项处理结束。' }]
    await host.handleMessage({ eventId: messageId, messageId, chatId, chatType: kind, senderOpenId: actor, senderType: 'user',
      tenantId: 'synthetic-tenant', msgType: 'text', text: '按我这次明确的要求处理事项',
      mentions: kind === 'group' ? [{ key: '@bot', openId: 'bot', name: 'Friday' }] : [], createTimeMs: Date.now(),
      ...(kind === 'group' ? { threadId: 'personal-assistant-thread' } : {}) })
    expect(called).toBe(true); if (failed) throw failed.error
  }
  const add = async (args: Record<string, unknown> = {}) => {
    const response = await post('add', { title: '合成待办', ...args }); expect(response.status, JSON.stringify(response.body)).toBe(200)
    return response.body.todo!
  }
  closes.push(async () => {
    api.beginShutdown(); api.server.closeAllConnections(); expect((await api.waitForShutdown(3000)).drained).toBe(true)
    await new Promise<void>(resolve => api.server.close(() => resolve()))
    await execution.runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true })
  })
  return { registry, todos, application, host, fake, group, sp, current, call, post, during, add, nativeApi, remote,
    get sync() { return sync }, restartSync() { sync = new FeishuTaskSync(syncDeps) }, sweep: () => { now += 1000; return sync.sweep() } }
}

describe('personal assistant through a real managed host, signed API and MCP', () => {
  it('refuses a third group member confirming another person’s candidate, while assignee and original creator can confirm', async () => {
    const t = await fixture(); let owned!: Todo, created!: Todo
    await t.during(ALICE, 'group', async () => {
      owned = await t.add({ owner_open_id: BOB, owner: 'Bob', certainty: 'candidate' })
      created = await t.add({ owner_open_id: BOB, certainty: 'candidate' })
      expect(owned).toMatchObject({ createdBy: ALICE, ownerOpenId: BOB, confirmed: false })
    })
    const unchanged = t.todos.get(owned.id)
    await t.during(CAROL, 'group', async () => {
      expect((await t.post('update', { id: owned.id, confirm: true })).status).toBe(403)
      // Reassigning to oneself in the same confirmation must not change who may confirm the original candidate.
      expect((await t.post('update', { id: owned.id, owner_open_id: CAROL, confirm: true })).status).toBe(403)
      const denied = await t.call('friday_todo_update', { id: owned.id, confirm: true })
      expect(denied.isError).toBe(true); expect(output(denied)).toContain('确认')
      expect(t.todos.get(owned.id)).toEqual(unchanged)
    })
    await t.during(BOB, 'group', async () => {
      const result = await t.call('friday_todo_update', { id: owned.id, confirm: true })
      expect(result.isError, output(result)).not.toBe(true); expect(t.todos.get(owned.id)?.confirmed).toBe(true)
    })
    await t.during(ALICE, 'group', async () => {
      expect((await t.post('update', { id: created.id, confirm: true })).status).toBe(200)
      expect(t.todos.get(created.id)?.confirmed).toBe(true)
    })
  })

  it.each([{ owner_open_id: 'Bob' }, { owner_open_id: 42 }, { owner: 42 }, { owner: { name: 'Bob' } }])(
    'rejects malformed owner data without creating a default-self Todo: %j', async invalid => {
      const t = await fixture()
      await t.during(ALICE, 'p2p', async () => {
        const result = await t.post('add', { title: 'bad input', ...invalid })
        expect(result.status).toBe(400)
        expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM todos').get()!.n).toBe(0)
      })
    })

  it('defaults an unspecified DM owner to the actual requester; a name-only other person never becomes their native task', async () => {
    const t = await fixture(), create = vi.spyOn(t.application, 'create')
    await t.during(ALICE, 'p2p', async () => {
      const result = await t.call('friday_todo_add', { title: '我的事项' })
      expect(result.isError, output(result)).not.toBe(true)
      const mine = t.todos.list(dmScope(ALICE), { status: 'all' })[0]!
      expect(mine).toMatchObject({ ownerOpenId: ALICE, createdBy: ALICE, owner: null })
      const proof = t.todos.getProvenance(mine.id)!
      expect(proof.request.senderOpenId).toBe(ALICE)
      expect(proof.originRunId).toBe(t.host.resolveActorForSession(t.current().session.sessionKey)!.runId)
      const other = await t.add({ title: '别人的事项', owner: '尚未核实身份的同事' })
      expect(other.ownerOpenId).toBeNull(); expect(t.sync.view(other).state).toBe('owner_unknown')
      await t.sweep()
      expect(t.nativeApi.create).toHaveBeenCalledTimes(1)
      expect(t.remote.get('native-1')?.members).toEqual([{ id: ALICE, role: 'assignee', type: 'user' }])
      expect(t.sync.link(other.id)).toBeUndefined()
      expect(create).toHaveBeenCalledTimes(2)
    })
  })

  it('removing an already synced Todo cancels and deletes the same native task, preserving the local source receipt', async () => {
    const t = await fixture()
    await t.during(ALICE, 'p2p', async () => {
      const todo = await t.add(); await t.sweep(); const before = t.todos.getProvenance(todo.id)
      const result = await t.call('friday_todo_update', { id: todo.id, remove: true })
      expect(result.isError, output(result)).not.toBe(true)
      expect(t.todos.get(todo.id)).toMatchObject({ id: todo.id, status: 'cancelled' })
      expect(t.todos.getProvenance(todo.id)).toEqual(before)
      expect(output(result)).toContain('取消'); expect(output(result)).not.toContain('已删除待办')
      await t.sweep()
      expect(t.nativeApi.delete).toHaveBeenCalledWith(expect.objectContaining({ path: { task_guid: 'native-1' } }))
      expect(t.remote.size).toBe(0); expect(t.sync.link(todo.id)).toBeDefined()
      t.restartSync(); await t.sweep(); expect(t.nativeApi.create).toHaveBeenCalledTimes(1)
    })
  })

  it('reports actual native status and applies edits/done/reopen to one native GUID through the common application', async () => {
    const t = await fixture(), update = vi.spyOn(t.application, 'update')
    await t.during(ALICE, 'p2p', async () => {
      const created = await t.post('add', { title: 'Original task', detail: 'Original detail' })
      expect(created.status).toBe(200); expect(created.body.native?.state).toBe('queued')
      const todo = created.body.todo!, origin = t.todos.getProvenance(todo.id)
      expect(output(await t.call('friday_todo_list', {}))).toContain('等待同步')
      await t.sweep()
      expect(output(await t.call('friday_todo_list', {}))).toContain('已同步')
      const due = '2026-10-01T10:00:00+08:00'
      const edited = await t.call('friday_todo_update', { id: todo.id, title: 'Edited task', detail: 'Edited detail', due })
      expect(edited.isError, output(edited)).not.toBe(true)
      await t.sweep()
      expect(t.remote.get('native-1')).toMatchObject({ summary: 'Edited task', description: 'Edited detail',
        due: { timestamp: String(Date.parse(due)), is_all_day: false } })
      const done = await t.call('friday_todo_done', { id: todo.id })
      expect(done.isError, output(done)).not.toBe(true); await t.sweep()
      expect(t.todos.get(todo.id)?.status).toBe('done'); expect(t.remote.get('native-1')?.completed_at).not.toBe('0')
      const reopen = await t.call('friday_todo_update', { id: todo.id, status: 'open' })
      expect(reopen.isError, output(reopen)).not.toBe(true); await t.sweep()
      expect(t.todos.get(todo.id)?.status).toBe('open'); expect(t.remote.get('native-1')?.completed_at).toBe('0')
      expect(t.sync.link(todo.id)?.guid).toBe('native-1'); expect(t.nativeApi.create).toHaveBeenCalledTimes(1)
      expect(t.todos.getProvenance(todo.id)).toEqual(origin); expect(update).toHaveBeenCalledTimes(3)
    })
  })

  it('keeps an in-flight native create ACK after HTTP remove, then cleans that exact task without recreating it', async () => {
    const t = await fixture(), started = deferred(), release = deferred()
    const create = t.nativeApi.create.getMockImplementation()!
    t.nativeApi.create.mockImplementationOnce(async request => { started.resolve(); await release.promise; return create(request) })
    await t.during(ALICE, 'p2p', async () => {
      const todo = await t.add(), pending = t.sweep(); await started.promise
      try {
        const removed = await t.post('update', { id: todo.id, remove: true })
        expect(removed.status).toBe(200); expect(removed.body).toMatchObject({ outcome: 'cancelled', todo: { id: todo.id, status: 'cancelled' } })
      } finally { release.resolve(); await pending }
      expect(t.sync.link(todo.id)?.guid).toBe('native-1')
      expect(t.registry.db.prepare('SELECT kind,state FROM feishu_task_operations WHERE todo_id=?').all(todo.id))
        .toContainEqual({ kind: 'create', state: 'returned' })
      expect(t.todos.get(todo.id)?.status).toBe('cancelled')
      t.restartSync(); await t.sweep()
      expect(t.nativeApi.delete).toHaveBeenCalledWith(expect.objectContaining({ path: { task_guid: 'native-1' } }))
      expect(t.nativeApi.create).toHaveBeenCalledTimes(1); expect(t.remote.size).toBe(0)
    })
  })

  it('uses the shared application for real checkbox callbacks and keeps one ID/provenance through done and reopen', async () => {
    const t = await fixture(); let todo!: Todo
    await t.during(ALICE, 'group', async () => { todo = await t.add({ owner_open_id: ALICE }) })
    const update = vi.spyOn(t.application, 'update'), proof = t.todos.getProvenance(todo.id)
    const card = t.host.todoCard([todo], 0, undefined, 0, { kind: 'create', receiveId: GROUP })
    const callback = nodes(card).find(node => node.type === 'callback' && (node.value as Card | undefined)?.action === 'todo')!.value as Card
    expect(callback.op).toBe('done')
    for (const checked of [true, false]) {
      const event = normalizeCardAction({ context: { open_chat_id: GROUP, open_message_id: 'real-card-receipt' },
        operator: { open_id: ALICE }, action: { value: callback, tag: 'checker', checked } })
      const result = await t.host.handleCardAction(event)
      expect(result).toMatchObject({ card: { type: 'raw' }, toast: { type: 'success' } })
      expect(t.todos.get(todo.id)?.status).toBe(checked ? 'done' : 'open')
      expect(nodes(result).find(node => node.tag === 'checker')?.checked).toBe(checked)
      expect(t.todos.getProvenance(todo.id)).toEqual(proof)
    }
    expect(update).toHaveBeenCalledTimes(2); expect(t.fake.of('patchCard')).toHaveLength(0)
  })
})

describe('meeting confirmation uses the same atomic Todo domain', () => {
  it('rolls back both new actions and acceptance when the second real Todo insert fails, then retries exactly once', async () => {
    const t = meetingRuntimeFixture(), sessionId = await t.end(), create = vi.spyOn(TodoApplication.prototype, 'create')
    const proposed = await t.runtime.application.proposeDraft(t.ref, { sessionId, summary: 'Confirmed synthetic meeting facts.', actions: [
      { title: 'first action', ownerOpenId: 'alice' }, { title: 'second action', owner: 'unverified colleague' }] })
    const draft = t.sessions.draft(proposed.draftId)!
    const decision = { draftId: draft.id, digest: draft.digest, decision: 'accept' as const, operatorOpenId: 'alice',
      chatId: t.dm.chatId!, messageId: draft.reviewMessageId! }
    t.registry.db.exec("CREATE TRIGGER fail_second_todo BEFORE INSERT ON todos WHEN NEW.title = 'second action' BEGIN SELECT RAISE(ABORT, 'synthetic second insert failed'); END")
    await expect(t.runtime.application.decideDraft(decision, () => {})).rejects.toThrow('synthetic second insert failed')
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM todos').get()!.n).toBe(0)
    expect(t.sessions.draft(draft.id)?.state).not.toBe('accepted')
    t.registry.db.exec('DROP TRIGGER fail_second_todo')
    const accepted = await t.runtime.application.decideDraft(decision, () => {})
    expect(accepted.todoIds).toHaveLength(2)
    expect(await t.runtime.application.decideDraft(decision, () => {})).toEqual(accepted)
    const items = accepted.todoIds.map(id => t.todos.get(id)!)
    expect(items[0]).toMatchObject({ createdBy: 'alice', ownerOpenId: 'alice', confirmed: true })
    expect(items[1]).toMatchObject({ createdBy: 'alice', ownerOpenId: null, owner: 'unverified colleague', confirmed: false })
    expect(items.map(item => t.todos.getProvenance(item.id)?.contextSnapshot?.meetingSources?.length)).toEqual([1, 1])
    expect(create).toHaveBeenCalledTimes(4)
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM todos').get()!.n).toBe(2)
  })
})
