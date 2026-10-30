import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IngressClassificationInput, IngressDecision } from '../src/acp/ingress-classifier.js'
import { loadConfig } from '../src/config.js'
import { InboundMaterials } from '../src/core/inbound-materials.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
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

/** Actual ingress, managed runtime selection, SQLite and signed HTTP. Only the
 * classifier/ACP peer and Feishu service are synthetic; no private method calls.
 */
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-todo-provenance-host-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_PUBLIC_MODE: 'true', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), todos = new Todos(registry.db)
  const sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'synthetic-group', openId: 'alice' })
  const fake = new FakeFeishu(); fake.members.set(space.chatId, new Set(['alice']))
  const feishu = asFeishuClient(fake), log = createLogger('todo-provenance-host', 'error')
  const cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const tokens = new TokenIssuer('synthetic-signing-key')
  const execution = managedHostRuntime(registry, home, log), { runtime, managed, peer } = execution
  const classify = vi.fn<(input: IngressClassificationInput) => Promise<IngressDecision>>(async () => ({ kind: 'work_request' }))
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, feishu, runtime, managed, messages, tokens,
    ingressClassifier: { classify }, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log })
  closes.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const api = createInternalApi({ registry, memory, todos, ...sp, feishu, messages, messageCache: cache, tokens, log,
    maxHistoryPerCall: 20, abilities: host.abilities,
    resolveActorForSession: key => host.resolveActorForSession(key),
    allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPersistDerivedState: (key, purpose) => host.canPersistDerivedState(key, purpose),
    captureTodoProvenance: (key, runId) => host.captureTodoProvenance(key, runId) })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  closes.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())) })
  const postTodo = async () => {
    const server = peer.state.allPrompts.at(-1)!.mcpServers[0] as { env: { name: string; value: string }[] }
    const token = server.env.find(entry => entry.name === 'FRIDAY_CAP_TOKEN')!.value
    const res = await fetch(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/todo/add`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '向报告人核对修复进展', certainty: 'candidate' }),
    })
    return { status: res.status, body: await res.json() as { todo?: Todo; error?: string }, actor: tokens.verify(token)! }
  }
  let serial = 0
  const message = (text: string, over: Partial<InboundMessage> = {}): InboundMessage => {
    const id = `todo-origin-input-${++serial}`
    const result: InboundMessage = { eventId: id, messageId: id, chatId: space.chatId, chatType: 'group',
      threadId: 'synthetic-topic', senderOpenId: 'alice', senderType: 'user', msgType: 'text', text,
      mentions: [{ key: '@bot', openId: 'bot', name: 'Friday' }], createTimeMs: Date.now(), ...over }
    fake.messages.set(id, { ...historyMsg({ ...result, senderName: 'Synthetic user' }), messagePosition: String(serial) })
    return result
  }
  peer.state.script = [{ kind: 'text', text: '已查看合成材料。' }]
  return { registry, todos, scope: spaceScope(space.id), host, fake, peer, execution, classify, postTodo, message,
    task: (message: InboundMessage) => registry.taskForMessage(message.messageId)! }
}

describe('Todo sources follow the actual Work and its explicit material bindings', () => {
  it.each(['direct', 'bound-forward'] as const)('captures %s ancestry on an amendment without selecting same-session unrelated work', async mode => {
    const t = await fixture()
    const forward = mode === 'bound-forward' ? t.message('[合并转发消息]', { msgType: 'merge_forward' }) : undefined
    if (forward) {
      t.fake.forwarded.set(forward.messageId, [historyMsg({ messageId: `${forward.messageId}-child`,
        chatId: 'original-source-chat', senderOpenId: 'reporter', text: 'FORWARDED_SOURCE_CANARY：请核对修复进展。' })])
      await t.host.handleMessage(forward)
      t.classify.mockImplementationOnce(async input => {
        const selected = input.materials?.find(material => material.preview.includes('FORWARDED_SOURCE_CANARY'))
        expect(selected).toBeDefined()
        return { kind: 'work_request', contextRefs: [selected!.ref] }
      })
    }
    const original = t.message(forward ? '先整理这份转发中的后续事项。' : 'DIRECT_SOURCE_CANARY：向报告人核对修复进展。')
    await t.host.handleMessage(original)
    expect(t.task(original).status).toBe('done')
    const unrelated = t.message('UNRELATED_SAME_SESSION_CANARY：单独比较另一份报告。')
    await t.host.handleMessage(unrelated)
    const originalTask = t.task(original), unrelatedTask = t.task(unrelated)
    expect(unrelatedTask.sessionKey).toBe(originalTask.sessionKey)
    expect(t.registry.taskWork.get(unrelatedTask.id)!.key).not.toBe(t.registry.taskWork.get(originalTask.id)!.key)
    const materials = new InboundMaterials(t.registry)
    expect(materials.forTask(originalTask.id).map(reference => reference.message.messageId))
      .toEqual(forward ? [forward.messageId] : [])

    const followup = t.message('把这件事记成待办，负责人和截止未提及时保持空白，并附上出处。', { parentId: original.messageId })
    t.classify.mockImplementationOnce(async input => {
      expect(input.message.replyToRef).toBeTruthy()
      expect(input.candidates.some(candidate => candidate.ref === input.message.replyToRef)).toBe(true)
      return { kind: 'amend', targetRef: input.message.replyToRef!, contextRefs: [] }
    })
    let result: Awaited<ReturnType<typeof t.postTodo>> | undefined
    const failures: unknown[] = []
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      try { result = await t.postTodo(); expect(result.status).toBe(200) }
      catch (error) { failures.push(error); throw error }
    } }, { kind: 'text', text: '已记录候选待办，负责人和截止保持空白，附上原文出处。' }]
    await t.host.handleMessage(followup)
    if (failures.length) throw failures[0]
    expect(result?.body.todo).toMatchObject({ confirmed: false, owner: null, dueMs: null })
    const task = t.task(followup), provenance = t.todos.getProvenance(result!.body.todo!.id)!
    expect(task.status).toBe('done')
    expect(task.sessionKey).toBe(originalTask.sessionKey)
    expect(materials.forTask(task.id)).toEqual([])
    expect(t.registry.listAmendedTasks(task.id).map(ancestor => ancestor.id)).toEqual([originalTask.id])
    expect(provenance).toMatchObject({ version: 1, taskId: task.id, originRunId: result!.actor.runId,
      workKey: t.registry.taskWork.get(originalTask.id)!.key,
      request: { messageId: followup.messageId, senderOpenId: 'alice', chatId: followup.chatId } })
    expect(new Set(provenance.selectedInputs.map(input => input.message.messageId)))
      .toEqual(new Set([original.messageId, ...(forward ? [forward.messageId] : [])]))
    for (const selected of provenance.selectedInputs) {
      expect(selected.message.link).toMatchObject({ status: 'available' })
      expect(selected.message.senderOpenId).toBe('alice')
      expect(selected.message.chatId).toBe(followup.chatId)
      expect(selected.message.messageId).not.toBe(unrelated.messageId)
      expect(selected.taskId).not.toBe(unrelatedTask.id)
    }
    expect(t.todos.list(t.scope)).toHaveLength(1)
    expect(t.execution.workspacePeer.state.allPrompts).toHaveLength(0)
  })
})
