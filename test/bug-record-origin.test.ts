import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { Bugs } from '../src/core/bugs.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Registry } from '../src/core/registry.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Todos } from '../src/core/todos.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** Real HTTP dispatch, Task receipts and Bugs; the active-run resolver is a trusted-host fixture. */
async function setup() {
  const registry = new Registry(':memory:'), bugs = new Bugs(registry.db), cache = new MessageCache(registry.db)
  const sp = spaceDeps(registry.db), feishu = new FakeFeishu(), tokens = new TokenIssuer('synthetic')
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', cwd: '/synthetic', requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'om_current', requesterOpenId: 'alice', prompt: '真实入站原文' }).task
  registry.updateTask(task.id, { status: 'running' })
  cache.upsert('chat-a', [historyMsg({ messageId: task.messageId, senderOpenId: 'alice', senderName: 'Alice Verified', text: task.prompt })])
  const state: { actor: ReturnType<NonNullable<InternalApiDeps['resolveActorForSession']>> } = {
    actor: { requesterOpenId: 'alice', runId: 'run-current', stage: 'task', taskId: task.id },
  }
  let hostActor: InternalApiDeps['resolveActorForSession']
  const actor = vi.fn((key: string) => hostActor ? hostActor(key) : state.actor)
  const log = createLogger('bug-record-origin-test', 'error')
  const memory = new ChannelMemory(registry.db), messages = new MessageService(asFeishuClient(feishu), cache, log)
  const api = createInternalApi({ registry, bugs, ...sp, feishu: asFeishuClient(feishu), messageCache: cache,
    memory, messages,
    todos: new Todos(registry.db), tokens, log, maxHistoryPerCall: 50, resolveActorForSession: actor,
  })
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/bug/record`
  const token = tokens.issue({ runId: 'run-current', sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', requesterOpenId: 'alice', spaceId: space.id, scopes: ['bug:record'] })
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const post = async (body: Record<string, unknown>, runId = 'run-current') => {
    const runToken = tokens.issue({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', requesterOpenId: 'alice', spaceId: space.id, scopes: ['bug:record'], runId })
    const res = await fetch(url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${runToken}` }, body: JSON.stringify({ title: '合成卡住反馈', text: '模型整理的反馈', ...body }) })
    return { status: res.status, body: await res.json() as { bucket: { id: number; count: number }; duplicate: boolean; error?: string } }
  }
  cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>((resolve) => api.server.close(() => resolve())); registry.close() })
  return { registry, bugs, cache, task, space, state, actor, url, headers, post, ...sp, feishu, tokens, log, memory, messages,
    setHostActor: (resolve: NonNullable<InternalApiDeps['resolveActorForSession']>) => { hostActor = resolve },
  }
}

describe('bug recording default inbound provenance', () => {
  it('records an omitted message_id through the real Orchestrator run resolver and HTTP dispatcher', async () => {
    const t = await setup(), home = mkdtempSync(join(tmpdir(), 'friday-record-origin-'))
    const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
    const { app, state } = createFakeAgent({ script: [] })
    let orchestrator!: Orchestrator
    const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log: t.log })
    cleanups.push(async () => { await runtime.stop(); rmSync(home, { recursive: true, force: true }) })
    t.feishu.members.set('chat-a', new Set(['alice']))
    orchestrator = new Orchestrator({ cfg, registry: t.registry, memory: t.memory, messages: t.messages,
      spaces: t.spaces, circles: t.circles, policy: t.policy, feishu: asFeishuClient(t.feishu), runtime,
      tokens: t.tokens, apiBaseUrl: new URL(t.url).origin, mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log: t.log,
    })
    t.setHostActor((key) => orchestrator.resolveActorForSession(key))
    let recordedId = 0
    state.script = [{ kind: 'hook', run: async () => {
      const sessionId = state.allPrompts.at(-1)!.sessionId
      const servers = state.sessions.get(sessionId)!.mcpServers as { env: { name: string; value: string }[] }[]
      const token = servers[0]!.env.find((item) => item.name === 'FRIDAY_CAP_TOKEN')!.value
      const response = await fetch(t.url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: '宿主绑定的反馈', text: '这次工具调用没有 message_id', reporter_open_id: 'forged' }),
      })
      expect(response.status).toBe(200)
      recordedId = (await response.json() as { bucket: { id: number } }).bucket.id
    } }, { kind: 'text', text: '已记录反馈。' }]
    await orchestrator.handleMessage({ eventId: 'ev_host', messageId: 'om_host_request', chatId: 'chat-a', chatType: 'group', msgType: 'text',
      text: '@Friday 记录这个合成反馈', senderOpenId: 'alice', senderType: 'user', threadId: 'omt_host', tenantId: 'tenant-synthetic',
      mentions: [{ key: '@Friday', openId: 'ou_bot', name: 'Friday' }], createTimeMs: Date.now(),
    })
    expect(t.registry.taskForMessage('om_host_request')?.status).toBe('done')
    expect(t.bugs.reports(recordedId)).toMatchObject([{ messageId: 'om_host_request', reporterOpenId: 'alice' }])
    expect(t.bugs.reports(recordedId)).toHaveLength(1)
  })

  it('uses the bound running Task rather than a newer queued Task, ignores forged identity and deduplicates retries', async () => {
    const t = await setup()
    t.registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'om_newer', requesterOpenId: 'alice', prompt: '另一条已排队消息' })
    const first = await t.post({ reporter_open_id: 'mallory', reporter_name: 'Forged Name', taskId: 999, runId: 'forged' })
    expect(first.status).toBe(200)
    const retry = await t.post({ title: '改写后的标题', text: '改写后的正文', reporter_open_id: 'bob' })
    expect(retry).toMatchObject({ status: 200, body: { duplicate: true, bucket: { id: first.body.bucket.id, count: 1 } } })
    expect(t.bugs.reports(first.body.bucket.id)).toMatchObject([
      { messageId: 'om_current', reporterOpenId: 'alice', reporterName: 'Alice Verified', text: '模型整理的反馈' },
    ])
    expect(t.bugs.list(t.space.id)).toHaveLength(1)
  })

  it('keeps the real reporter ID when the source message has no cached display name', async () => {
    const t = await setup(); t.cache.remove(t.task.messageId)
    const result = await t.post({ reporter_open_id: 'bob', reporter_name: 'Forged Name' })
    expect(result.status).toBe(200)
    expect(t.bugs.reports(result.body.bucket.id)).toMatchObject([{ messageId: t.task.messageId, reporterOpenId: 'alice', reporterName: null }])
  })

  it.each(['queued', 'no-receipt', 'other-session', 'other-actor', 'stopped', 'routine', 'unbound'] as const)('rejects an omitted source with %s instead of guessing a Task', async (invalid) => {
    const t = await setup()
    if (invalid === 'queued') t.registry.updateTask(t.task.id, { status: 'queued' })
    if (invalid === 'no-receipt') t.registry.db.prepare('DELETE FROM task_receipts WHERE task_id = ?').run(t.task.id)
    if (invalid === 'other-session') {
      t.registry.createSession({ sessionKey: 'other', chatId: 'chat-a', chatType: 'group', cwd: '/synthetic', requesterOpenId: 'alice' })
      const other = t.registry.createTaskOnce({ sessionKey: 'other', messageId: 'om_other', requesterOpenId: 'alice', prompt: '另一会话' }).task
      t.registry.updateTask(other.id, { status: 'running' }); t.state.actor!.taskId = other.id
    }
    if (invalid === 'other-actor') {
      const other = t.registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'om_bob', requesterOpenId: 'bob', prompt: '另一人' }).task
      t.registry.updateTask(other.id, { status: 'running' }); t.state.actor!.taskId = other.id
    }
    if (invalid === 'stopped') t.registry.requestStop(t.task.id)
    if (invalid === 'routine') t.state.actor!.stage = 'routine'
    if (invalid === 'unbound') t.state.actor!.taskId = undefined
    expect((await t.post({})).status).toBe(403)
    expect(t.bugs.list(t.space.id)).toEqual([])
  })

  it('rejects a slow HTTP body after the captured run changes', async () => {
    const t = await setup()
    const response = new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(t.url, { method: 'POST', headers: t.headers }, (res) => {
        let text = ''; res.on('data', (chunk) => { text += chunk }); res.on('end', () => resolve({ status: res.statusCode!, text }))
      })
      req.on('error', reject)
      req.write('{"title":"合成卡住反馈",')
      void (async () => {
        await vi.waitFor(() => expect(t.actor).toHaveBeenCalled())
        t.state.actor = { ...t.state.actor!, runId: 'replacement-run' }
        req.end('"text":"旧请求延迟的正文"}')
      })().catch((error) => { req.destroy(); reject(error) })
    })
    expect(await response).toMatchObject({ status: 403 })
    expect(t.bugs.list(t.space.id)).toEqual([])
  })

  it('does not treat a followup occurrence receipt as a new inbound even when its stage is task', async () => {
    const t = await setup()
    t.registry.updateTask(t.task.id, { status: 'done', stopReason: 'end_turn' })
    const occurrenceKey = 'routine:7:occurrence:11:v1'
    const followup = t.registry.createTaskOnce({ sessionKey: t.task.sessionKey, messageId: t.task.messageId,
      requesterOpenId: 'alice', prompt: '按职责稍后核查原消息',
    }, occurrenceKey).task
    t.registry.updateTask(followup.id, { status: 'running' })
    t.state.actor = { requesterOpenId: 'alice', runId: 'followup-run', stage: 'task', taskId: followup.id }
    expect(t.registry.taskReceiptKeys(followup.id)).toEqual([occurrenceKey])
    expect(t.registry.taskForMessage(t.task.messageId)?.id).toBe(t.task.id)
    expect((await t.post({}, 'followup-run')).status).toBe(403)
    expect(t.bugs.list(t.space.id)).toEqual([])
  })

  it('preserves explicit historical-message recording and its existing caller-supplied attribution contract', async () => {
    const t = await setup()
    t.state.actor = { requesterOpenId: 'alice', runId: 'background-run', stage: 'routine' }
    const result = await t.post({ message_id: 'om_historical', reporter_open_id: 'historical-person', reporter_name: 'Historical Name' }, 'background-run')
    expect(result.status).toBe(200)
    expect(t.bugs.reports(result.body.bucket.id)).toMatchObject([{ messageId: 'om_historical', reporterOpenId: 'historical-person', reporterName: 'Historical Name' }])
  })
})
