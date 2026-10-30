import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { Bugs } from '../src/core/bugs.js'
import { ApiError, createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function setup(deliverToolResult?: InternalApiDeps['deliverToolResult']) {
  const registry = new Registry(':memory:')
  const cwd = mkdtempSync(join(tmpdir(), 'friday-write-boundaries-'))
  writeFileSync(join(cwd, 'synthetic.txt'), 'synthetic bytes')
  cleanups.push(() => { registry.close(); rmSync(cwd, { recursive: true, force: true }) })
  const sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  const feishu = new FakeFeishu()
  const cache = new MessageCache(registry.db)
  const memory = new ChannelMemory(registry.db)
  const bugs = new Bugs(registry.db)
  const log = createLogger('api-write-boundaries', 'error')
  const state = { derivedSafe: true, actor: 'alice' as string | undefined }
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', cwd, requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'om_current', requesterOpenId: 'alice', prompt: 'Observed here' }).task
  registry.updateTask(task.id, { status: 'running' })
  const memoryHost = memoryRuntimeFixture(registry, memory)
  memoryHost.pin({ runId: 'current-run', sessionKey: 'session-a', actorOpenId: 'alice', taskId: task.id })
  const invoke = vi.fn(async () => 'ability result')
  const sourceCheck = vi.fn(() => state.derivedSafe)
  const api = createInternalApi({
    registry, ...sp, feishu: asFeishuClient(feishu), messageCache: cache,
    memory, memoryRuntime: memoryHost.runtime, bugs, todos: new Todos(registry.db), messages: new MessageService(asFeishuClient(feishu), cache, log),
    abilities: { status: invoke, report: invoke, wiki: invoke, handover: invoke, groups: invoke, pmo: invoke, settings: invoke, explain: () => '', selfcheck: invoke },
    tokens: new TokenIssuer('synthetic'), log, maxHistoryPerCall: 50,
    resolveActorForSession: () => state.actor ? { requesterOpenId: state.actor, runId: 'current-run', stage: 'task', taskId: task.id } : undefined,
    canPersistDerivedState: sourceCheck,
    deliverToolResult,
  })
  // 直调路由的夹具模拟 HTTP dispatch 已绑定当前 run；请求 body 不能提供这个字段。
  const cap: Capability & { boundRunId?: string; boundStage?: string } = { runId: 'current-run', sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', spaceId: space.id, requesterOpenId: 'alice', cwd, boundRunId: 'current-run', boundStage: 'task', scopes: [...ALL_SCOPES], exp: 9999999999 }
  const call = (path: string, body: Record<string, unknown>, actor = cap) => api.routes[`POST /v1/${path}`]!(actor, body)
  return { registry, ...sp, space, feishu, memory, bugs, state, invoke, sourceCheck, cap, call, routes: api.routes }
}

describe('API write effects use explicit authorization boundaries', () => {
  it('rejects empty scopes in every registered bug route without database or outbound effects', async () => {
    const t = setup()
    const bucket = t.bugs.record({ spaceId: t.space.id, chatId: t.cap.chatId, title: 'Existing', text: 'Original report' }).bucket
    // 给读写入口都提供可执行输入；不能因为缺字段而把 400 误认成授权拒绝。
    const body = { id: bucket.id, bucket_id: bucket.id, title: 'Changed', text: 'Another report', status: 'fixed', phase: 'awaiting_info', missing_info: ['version'], message_id: 'synthetic-evidence', issue_url: 'https://github.com/org/demo/issues/1' }
    const before = t.registry.db.prepare('SELECT total_changes() AS count').get()
    const messageLookup = vi.spyOn(t.feishu, 'getMessage')
    const routes = Object.entries(t.routes).filter(([path]) => path.startsWith('POST /v1/bug/'))
    expect(routes.length).toBeGreaterThan(0)
    for (const [path, handler] of routes) {
      await expect(handler({ ...t.cap, scopes: [] }, body), path).rejects.toMatchObject({ status: 403 })
      expect(t.registry.db.prepare('SELECT total_changes() AS count').get(), path).toEqual(before)
      expect(t.feishu.sent, path).toEqual([])
      expect(t.feishu.downloads, path).toEqual([])
      expect(messageLookup, path).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['bug/record', { title: 'Synthetic', text: 'Untrusted source' }],
    ['ability', { what: 'settings', args: 'note Untrusted source' }],
    ['ability', { what: 'pmo', args: 'sync' }],
    ['ability', { what: 'report' }],
    ['skill/propose', { name: 'synthetic', description: 'Test', body: 'Test' }],
    ['doc/create', { title: 'Synthetic', markdown: 'Untrusted source' }],
    // 建表在检查部署是否配了多维表格之前先看来源：来源不安全时不能靠 501 掩盖成"没开这个功能"
    ['table/create', { title: 'Synthetic', fields: [{ name: 'Col', type: 'text' }], rows: [{ Col: 'Untrusted source' }] }],
  ])('rejects derived writes in %s before invoking the effect', async (path, body) => {
    const t = setup(); t.state.derivedSafe = false
    await expect(t.call(path, body)).rejects.toMatchObject({ status: 403 })
    expect(t.sourceCheck).toHaveBeenCalledWith(t.cap.sessionKey)
    expect(t.invoke).not.toHaveBeenCalled()
    expect(t.bugs.list(t.space.id)).toEqual([])
    expect(t.feishu.sent).toEqual([])
    expect(t.feishu.createdDocs).toEqual([])
  })

  it.each([
    ['dm', { text: 'Synthetic result' }],
    ['file/send', { path: 'synthetic.txt' }],
  ] as const)('requires a host delivery callback and a current run for %s, never direct-send fallback', async (path, body) => {
    const missingHost = setup(); missingHost.state.derivedSafe = false
    await expect(missingHost.call(path, body)).rejects.toMatchObject({ status: 503 })
    expect(missingHost.sourceCheck).not.toHaveBeenCalled()
    expect(missingHost.feishu.sent).toEqual([])
    expect(missingHost.feishu.uploads).toEqual([])

    const hostDelivery = vi.fn<NonNullable<InternalApiDeps['deliverToolResult']>>(async () => ({ messageId: 'host-receipt' }))
    const unbound = setup(hostDelivery)
    await expect(unbound.call(path, { ...body, runId: 'model-chosen', boundRunId: 'model-chosen' }, { ...unbound.cap, boundRunId: undefined })).rejects.toMatchObject({ status: 503 })
    expect(hostDelivery).not.toHaveBeenCalled()
    expect(unbound.feishu.sent).toEqual([])
    expect(unbound.feishu.uploads).toEqual([])
  })

  it.each([
    ['dm', { text: 'Synthetic result', to: 'bob', requesterOpenId: 'bob' }, { kind: 'message', text: 'Synthetic result' }],
    ['file/send', { path: 'synthetic.txt', note: '合成说明', to: 'chat-b' }, { kind: 'file', data: Buffer.from('synthetic bytes'), name: 'synthetic.txt', note: '合成说明' }],
  ] as const)('delegates %s to the host audience gate even when derived persistence is blocked', async (path, body, input) => {
    const hostAudienceDelivery = vi.fn<NonNullable<InternalApiDeps['deliverToolResult']>>(async () => ({ messageId: 'host-receipt' }))
    const t = setup(hostAudienceDelivery); t.state.derivedSafe = false
    const result = await t.call(path, body)
    expect(result).toMatchObject({ ok: true, message_id: 'host-receipt' })
    if (path === 'dm') expect(result).toMatchObject({ to: 'alice' })
    expect(hostAudienceDelivery).toHaveBeenCalledExactlyOnceWith('session-a', 'current-run', input)
    expect(t.sourceCheck).not.toHaveBeenCalled()
    expect(t.feishu.uploads).toEqual([])
    expect(t.feishu.sent).toEqual([])
  })

  it.each([
    ['dm', { text: 'Synthetic cross-space result' }],
    ['file/send', { path: 'synthetic.txt' }],
  ] as const)('preserves scope and fresh identity gates and propagates a host audience denial for %s', async (path, body) => {
    const hostAudienceGate = vi.fn<NonNullable<InternalApiDeps['deliverToolResult']>>(async () => { throw new ApiError(403, 'synthetic audience authorization denied') })
    const t = setup(hostAudienceGate); t.state.derivedSafe = false
    await expect(t.call(path, body, { ...t.cap, scopes: [] })).rejects.toMatchObject({ status: 403 })
    t.state.actor = 'bob'
    await expect(t.call(path, body)).rejects.toMatchObject({ status: 403 })
    expect(hostAudienceGate).not.toHaveBeenCalled()
    t.state.actor = 'alice'
    await expect(t.call(path, body)).rejects.toThrow('synthetic audience authorization denied')
    expect(hostAudienceGate).toHaveBeenCalledOnce()
    expect(t.sourceCheck).not.toHaveBeenCalled()
    expect(t.feishu.uploads).toEqual([])
    expect(t.feishu.sent).toEqual([])
  })

  it.each(['bug:record', 'bug:write'])('keeps authorized record creation working with %s alone', async (scope) => {
    const t = setup()
    await expect(t.call('bug/record', { title: 'Synthetic', text: 'Observed here' }, { ...t.cap, scopes: [scope] })).resolves.toMatchObject({ isNew: true })
    expect(t.sourceCheck).toHaveBeenCalledOnce()
    expect(t.bugs.list(t.space.id)).toHaveLength(1)
  })

  it.each(['ended', 'actor', 'member', 'archive', 'rebind'] as const)('does not let bug:record bypass the current %s boundary', async (boundary) => {
    const t = setup()
    if (boundary === 'ended') t.state.actor = undefined
    if (boundary === 'actor') t.state.actor = 'bob'
    if (boundary === 'member') t.spaces.removeMember(t.space.id, 'alice')
    if (boundary === 'archive') t.spaces.archive(t.space.id)
    if (boundary === 'rebind') t.spaces.rebind(t.space.id, 'chat-b')
    await expect(t.call('bug/record', { title: 'Synthetic', text: 'Must not persist' }, { ...t.cap, scopes: ['bug:record'] })).rejects.toMatchObject({ status: 403 })
    expect(t.bugs.list(t.space.id)).toEqual([])
  })

  it('keeps status/settings reads available when derived content cannot be persisted', async () => {
    const t = setup(); t.state.derivedSafe = false
    for (const what of ['status', 'settings', 'pmo']) await expect(t.call('ability', { what })).resolves.toEqual({ text: 'ability result' })
    expect(t.sourceCheck).not.toHaveBeenCalled()
  })

  it('requires both configuration authority and safe sources, without changing a valid owner request', async () => {
    const t = setup()
    await expect(t.call('ability', { what: 'settings', args: 'brief short' })).resolves.toEqual({ text: 'ability result' })
    t.spaces.touchMember(t.space.id, 'bob'); t.state.actor = 'bob'
    await expect(t.call('ability', { what: 'settings', args: 'brief short' }, { ...t.cap, requesterOpenId: 'bob' })).rejects.toMatchObject({ status: 403 })
    expect(t.invoke).toHaveBeenCalledOnce()
  })

  it('permits only the signed candidate memory exception when general derived writes are blocked', async () => {
    const t = setup(); t.state.derivedSafe = false
    const candidate = t.memory.add({ scope: `space:${t.space.id}`, sessionKey: 'old', kind: 'fact', title: 'Candidate', body: 'Synthetic', status: 'candidate' })
    const confirmed = t.memory.add({ scope: `space:${t.space.id}`, sessionKey: 'old', kind: 'fact', title: 'Confirmed', body: 'Synthetic', status: 'confirmed', confirmation: { by: 'alice', messageId: 'confirm-original', at: 1 } })
    const cap = { ...t.cap, memoryWritePolicy: { candidateIds: [candidate.id, confirmed.id] } }
    await expect(t.call('memory/save', { title: 'Merged', body: 'Synthetic', replaces: candidate.id, certainty: 'confirmed' }, cap)).resolves.toMatchObject({ note: { status: 'candidate' } })
    await expect(t.call('memory/forget', { id: confirmed.id }, cap)).rejects.toMatchObject({ status: 403 })
    await expect(t.call('memory/save', { title: 'New', body: 'Synthetic' }, cap)).rejects.toMatchObject({ status: 403 })
    await expect(t.call('memory/save', { title: 'Regular', body: 'Synthetic' })).rejects.toMatchObject({ status: 403 })
    expect(t.memory.get(confirmed.id)).toMatchObject({ status: 'confirmed' })
  })
})
