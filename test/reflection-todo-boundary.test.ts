import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ChannelMemory, type MemoryNote } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { spaceScope } from '../src/core/space.js'
import { Todos, type Todo } from '../src/core/todos.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { spaceDeps } from './helpers/space.js'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

/** Real managed runtime selection, host stages, signed HTTP, memory and Todo stores.
 * The ACP peer and Feishu are synthetic; this does not claim a production model test.
 */
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-reflection-todos-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_PUBLIC_MODE: 'true', FRIDAY_REFLECT: 'on', FRIDAY_REFLECT_MIN_CHARS: '1', FRIDAY_ACK_AFTER_MS: '0',
    FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), todos = new Todos(registry.db)
  const attempts = new RunAttempts(registry.db), sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'synthetic-group', openId: 'alice' }), scope = spaceScope(space.id)
  const fake = new FakeFeishu(); fake.members.set('synthetic-group', new Set(['alice']))
  const feishu = asFeishuClient(fake), cache = new MessageCache(registry.db), log = createLogger('reflection-todos', 'error')
  const messages = new MessageService(feishu, cache, log), tokens = new TokenIssuer('synthetic-signing-key')
  const execution = managedHostRuntime(registry, home, log), { runtime, managed, peer } = execution
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, feishu, runtime, managed, messages, tokens,
    ingressClassifier: { classify: async input => input.candidates.length === 1
      ? { kind: 'amend', targetRef: input.candidates[0]!.ref } : { kind: 'new_work' } },
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log })
  closes.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const api = createInternalApi({ registry, memory, todos, messageCache: cache, messages, ...sp, feishu, tokens, log,
    maxHistoryPerCall: 20, abilities: host.abilities,
    resolveActorForSession: key => host.resolveActorForSession(key),
    allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPersistDerivedState: (key, purpose) => host.canPersistDerivedState(key, purpose),
    canPersistPersonalMemory: key => host.canPersistPersonalMemory(key),
    captureTodoProvenance: (key, runId) => host.captureTodoProvenance(key, runId),
    memoryRuntime: { recordRead: (runId, refs) => host.recordMemoryRead(runId, refs),
      add: (runId, input) => host.addMemory(runId, input), forget: (runId, id, scope) => host.forgetMemory(runId, id, scope) } })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  closes.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())) })
  const token = () => {
    const servers = peer.state.allPrompts.at(-1)!.mcpServers as { env: { name: string; value: string }[] }[]
    return servers[0]!.env.find(entry => entry.name === 'FRIDAY_CAP_TOKEN')!.value
  }
  const post = async (path: string, body: unknown, credential = token()) => {
    const res = await fetch(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() as { todo?: Todo; todos?: Todo[]; note?: MemoryNote; error?: string } }
  }
  let serial = 0
  const message = (text: string): InboundMessage => {
    const id = `reflection-input-${++serial}`
    return { eventId: id, messageId: id, chatId: 'synthetic-group', chatType: 'group', threadId: 'synthetic-topic',
      tenantId: 'synthetic-tenant', senderOpenId: 'alice', senderType: 'user', msgType: 'text', text,
      mentions: [{ key: '@bot', openId: 'bot', name: 'Friday' }], createTimeMs: Date.now() }
  }
  return { registry, memory, todos, attempts, scope, host, fake, peer, execution, post, token, tokens, message }
}

describe('Reflection cannot silently change acknowledged business work', () => {
  it.each(['candidate', 'confirmed'] as const)('preserves an acknowledged %s Todo while memory reflection remains active', async certainty => {
    const t = await fixture(), first = t.message('记下这件合成事项，负责人和截止未明确，附上出处。')
    t.fake.messages.set(first.messageId, { ...historyMsg({ messageId: first.messageId, chatId: first.chatId,
      senderOpenId: first.senderOpenId, text: first.text }), messagePosition: '17' })
    const legacy = t.todos.add({ scope: t.scope, title: '此前的人已确认的事项', detail: '应保留的详情',
      source: '合成材料原始出处', confirmed: true, createdBy: 'alice' })
    let original: Todo | undefined, reflected = 0, memoryId = 0, priorCredential = '', parentRunId = ''
    let originalProvenance: ReturnType<Todos['getProvenance']>
    const failures: unknown[] = []
    const checked = (check: () => Promise<void>) => async () => {
      try { await check() } catch (error) { failures.push(error); throw error }
    }
    const todoRows = () => t.registry.db.prepare('SELECT * FROM todos ORDER BY id').all()
    const finalReceipts = () => t.registry.db.prepare("SELECT status,remote_id FROM deliveries WHERE delivery_key LIKE 'task:%:final:%' ORDER BY created_at").all()
    let deliveredRows: ReturnType<typeof todoRows> = []
    t.peer.state.script = [{ kind: 'hook', run: checked(async () => {
      const cap = t.tokens.verify(t.token())!, actor = t.host.resolveActorForSession(cap.sessionKey)!
      if (actor.stage === 'task') {
        const added = await t.post('todo/add', { title: '合成验收事项', detail: '出处：合成报告第一段；负责人和截止未知。', certainty })
        expect(added.status).toBe(200)
        original = added.body.todo!
        expect(original).toMatchObject({ confirmed: certainty === 'confirmed', owner: null, dueMs: null })
        expect(original.origin?.request).toMatchObject({ kind: 'request', link: { status: 'available',
          url: 'https://applink.feishu.cn/client/chat/open?openChatId=synthetic-group&position=17' } })
        originalProvenance = t.todos.getProvenance(original.id)
        expect(originalProvenance).toMatchObject({ version: 1, originRunId: actor.runId,
          taskId: t.registry.taskForMessage(first.messageId)!.id, request: { messageId: first.messageId,
            chatId: first.chatId, senderOpenId: 'alice' }, contextSnapshot: { chatId: first.chatId } })
        parentRunId = actor.runId
        deliveredRows = todoRows()
        return
      }
      expect(actor.stage).toBe('reflect')
      expect(t.attempts.get(parentRunId)).toMatchObject({ stage: 'task', state: 'completed' })
      expect(finalReceipts()).toEqual([{ status: 'sent', remote_id: expect.any(String) }])
      expect(t.tokens.verify(t.token())!.runId).not.toBe(parentRunId)
      priorCredential = t.token()
      // Include task-looking fields: the actual host stage, never model arguments, controls admission.
      for (const [path, body] of [
        ['todo/add', { title: original!.title, detail: '后台想补写的详情', certainty: 'candidate', stage: 'task', runId: parentRunId }],
        ['todo/update', { id: original!.id, title: '后台改写', detail: '后台改写详情' }],
        ['todo/update', { id: original!.id, remove: true }],
        ['todo/update', { id: original!.id, confirm: true }],
        ['todo/done', { id: original!.id }],
        ['todo/update', { id: legacy.id, remove: true }],
      ] as const) {
        const denied = await t.post(path, body)
        expect(denied.status, path).toBe(403)
        expect(denied.body.error).toContain('当前运行阶段')
        expect(todoRows()).toEqual(deliveredRows)
      }
      const saved = await t.post('memory/save', { kind: 'fact', title: '合成长期知识', body: '合成范围内长期有效的事实。', certainty: 'confirmed' })
      expect(saved.status).toBe(200)
      expect(saved.body.note?.status).toBe('candidate')
      memoryId = saved.body.note!.id
      expect((await t.post('memory/search', { query: '合成长期知识' })).status).toBe(200)
      reflected++
    }) }, { kind: 'text', text: '已记录合成事项；负责人和截止保持未知，出处保留。' }]
    await t.host.handleMessage(first)
    if (failures.length) throw failures[0]
    expect(reflected).toBe(1)
    expect(original).toBeDefined()
    expect(todoRows()).toEqual(deliveredRows)
    expect(t.todos.get(original!.id)).toEqual(original)
    expect(t.todos.getProvenance(original!.id)).toEqual(originalProvenance)
    expect(t.memory.get(memoryId)).toMatchObject({ status: 'candidate', title: '合成长期知识' })
    const runs = t.registry.db.prepare('SELECT id,stage,state,work_key,acp_session_id FROM run_attempts ORDER BY started_at').all()
    expect(runs).toHaveLength(2)
    expect(runs[1]).toMatchObject({ stage: 'reflect', state: 'completed', work_key: runs[0]!.work_key, acp_session_id: runs[0]!.acp_session_id })
    expect(t.execution.workspacePeer.state.allPrompts).toHaveLength(0)
    expect(finalReceipts()).toHaveLength(1)

    let humanUpdates = 0
    t.peer.state.script = [{ kind: 'hook', run: checked(async () => {
      const cap = t.tokens.verify(t.token())!, actor = t.host.resolveActorForSession(cap.sessionKey)!
      if (actor.stage === 'reflect') return
      expect(actor.stage).toBe('task')
      expect(actor.runId).not.toBe(parentRunId)
      expect((await t.post('todo/update', { id: original!.id, remove: true }, priorCredential)).status).toBe(403)
      const updated = await t.post('todo/update', { id: original!.id, title: '用户明确更正后的事项', detail: '用户补充详情，保留同一项。' })
      expect(updated.status).toBe(200)
      expect(updated.body.todo).toMatchObject({ id: original!.id, title: '用户明确更正后的事项' })
      expect((await t.post('todo/done', { id: original!.id })).status).toBe(200)
      humanUpdates++
    }) }, { kind: 'text', text: '已按你的更正更新并完成同一项。' }]
    await t.host.handleMessage(t.message('把刚才那项改为用户明确更正后的事项，补充详情，并标记完成。'))
    if (failures.length) throw failures[0]
    expect(humanUpdates).toBe(1)
    expect(t.todos.get(original!.id)).toMatchObject({ id: original!.id, title: '用户明确更正后的事项',
      detail: '用户补充详情，保留同一项。', status: 'done', createdAt: original!.createdAt, source: original!.source, origin: original!.origin })
    expect(t.todos.get(legacy.id)).toEqual(legacy)
    expect(t.todos.getProvenance(original!.id)).toEqual(originalProvenance)
    expect(t.todos.count(t.scope, { status: 'all' })).toBe(2)
    expect(finalReceipts()).toEqual(Array.from({ length: 2 }, () => ({ status: 'sent', remote_id: expect.any(String) })))
  })
})
