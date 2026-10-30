/**
 * 契约 §9：聊天 API、MCP 工具、卡片打勾对待办的每一次写入都经过 TodoApplication，入口不再直接写 Todos。
 * 真实 Orchestrator + 签名 HTTP + MCP SDK + SQLite；ACP 与飞书传输是合成的。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { TodoApplication } from '../src/core/todo-application.js'
import { Todos, type Todo } from '../src/core/todos.js'
import { normalizeCardAction } from '../src/feishu/ws.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { buildServer } from '../src/mcp/server.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { spaceDeps } from './helpers/space.js'

const ALICE = 'ou_aa', GROUP = 'oc_single_application'
const log = createLogger('todo-entry-single-application', 'error')
const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
type Reply = { isError?: boolean; content: { type: string; text?: string }[] }
type Card = Record<string, unknown>
const nodes = (value: unknown): Card[] => !value || typeof value !== 'object' ? []
  : Array.isArray(value) ? value.flatMap(nodes) : [value as Card, ...Object.values(value).flatMap(nodes)]

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-single-application-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '15000', FRIDAY_DEFAULT_EXECUTION: 'managed' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(join(home, 'db')), todos = new Todos(registry.db), memory = new ChannelMemory(registry.db)
  const application = new TodoApplication({ db: registry.db, todos }), sp = spaceDeps(registry.db)
  sp.spaces.ensure({ kind: 'group', chatId: GROUP, openId: ALICE })
  const fake = new FakeFeishu(); fake.members.set(GROUP, new Set([ALICE]))
  const feishu = asFeishuClient(fake), cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const tokens = new TokenIssuer('synthetic-single-application'), execution = managedHostRuntime(registry, home, log)
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, todoApplication: application, feishu, messages, tokens,
    runtime: execution.runtime, managed: execution.managed, botOpenId: 'bot', log,
    ingressClassifier: { classify: async () => ({ kind: 'new_work' }) }, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent' })
  const api = createInternalApi({ registry, ...sp, memory, todos, todoApplication: application, feishu, messages, messageCache: cache,
    appId: cfg.feishu.appId, tokens, log, maxHistoryPerCall: 20,
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPersistDerivedState: (key, purpose) => host.canPersistDerivedState(key, purpose), captureTodoProvenance: (key, run) => host.captureTodoProvenance(key, run) })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const token = () => {
    const prompt = execution.peer.state.allPrompts.at(-1)!
    return (prompt.mcpServers as { env: { name: string; value: string }[] }[])[0]!.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value
  }
  const post = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/v1/todo/${route}`, { method: 'POST', headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as { todo?: Todo; outcome?: string; note?: string } }
  }
  const call = async (name: string, args: Record<string, unknown>) => {
    const server = buildServer({ apiUrl: base, token: token() }), client = new Client({ name: 'single-application', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    try { return await client.callTool({ name, arguments: args }) as Reply } finally { await client.close(); await server.close() }
  }
  let serial = 0
  const during = async (work: () => Promise<void>) => {
    let failed: { error: unknown } | undefined
    const messageId = `single-application-${++serial}`
    execution.peer.state.script = [{ kind: 'hook', run: async () => { try { await work() } catch (error) { failed = { error } } } }, { kind: 'text', text: '处理完了。' }]
    await host.handleMessage({ eventId: messageId, messageId, chatId: GROUP, chatType: 'group', senderOpenId: ALICE, senderType: 'user',
      tenantId: 'synthetic-tenant', msgType: 'text', text: '按我说的处理待办', mentions: [{ key: '@bot', openId: 'bot', name: 'Friday' }],
      createTimeMs: Date.now(), threadId: 'omt-single-application' })
    if (failed) throw failed.error
  }
  closes.push(async () => {
    api.beginShutdown(); api.server.closeAllConnections(); expect((await api.waitForShutdown(3000)).drained).toBe(true)
    await new Promise<void>(resolve => api.server.close(() => resolve()))
    await execution.runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true })
  })
  return { registry, todos, host, post, call, during }
}

describe('one Todo application behind every entry', () => {
  it('API, MCP and card callbacks write Todos only inside TodoApplication operations', async () => {
    const t = await fixture()
    let depth = 0
    const operations: string[] = [], outside: string[] = []
    for (const method of ['create', 'update', 'remove'] as const) {
      const original = TodoApplication.prototype[method] as (...args: unknown[]) => unknown
      vi.spyOn(TodoApplication.prototype, method).mockImplementation(function (this: TodoApplication, ...args: unknown[]) {
        operations.push(method); depth++
        try { return original.apply(this, args) } finally { depth-- }
      } as never)
    }
    for (const method of ['add', 'update', 'transition', 'confirm', 'remove', 'done'] as const) {
      const original = Todos.prototype[method] as (...args: unknown[]) => unknown
      vi.spyOn(Todos.prototype, method).mockImplementation(function (this: Todos, ...args: unknown[]) {
        if (!depth) outside.push(method)
        return original.apply(this, args)
      } as never)
    }
    let kept!: Todo
    await t.during(async () => {
      const added = await t.post('add', { title: '合成事项', certainty: 'candidate', owner_open_id: ALICE })
      expect(added.status, JSON.stringify(added.body)).toBe(200)
      kept = added.body.todo!
      expect((await t.post('update', { id: kept.id, confirm: true, title: '合成事项（改）', due: '2026-10-01T10:00:00+08:00' })).status).toBe(200)
      expect((await t.post('update', { id: kept.id, status: 'blocked', status_note: '等权限' })).status).toBe(200)
      expect((await t.call('friday_todo_update', { id: kept.id, status: 'open' })).isError).not.toBe(true)
      expect((await t.call('friday_todo_done', { id: kept.id })).isError).not.toBe(true)
      const extra = (await t.post('add', { title: '记错了的事项' })).body.todo!
      expect((await t.post('update', { id: extra.id, remove: true })).body).toMatchObject({ outcome: 'deleted', note: '已删除' })
      expect((await t.call('friday_todo_add', { title: '工具记下的事项', owner_open_id: ALICE })).isError).not.toBe(true)
    })
    const card = t.host.todoCard([t.todos.get(kept.id)!], 0, undefined, 0, { kind: 'create', receiveId: GROUP })
    const callback = nodes(card).find(node => node.type === 'callback' && (node.value as Card | undefined)?.action === 'todo')!.value as Card
    const result = await t.host.handleCardAction(normalizeCardAction({ context: { open_chat_id: GROUP, open_message_id: 'card-receipt' },
      operator: { open_id: ALICE }, action: { value: callback, tag: 'checker', checked: false } }))
    expect(result).toMatchObject({ toast: { type: 'success' } })
    expect(t.todos.get(kept.id)?.status).toBe('open')
    expect(outside).toEqual([])
    expect(new Set(operations)).toEqual(new Set(['create', 'update', 'remove']))
  })
})
