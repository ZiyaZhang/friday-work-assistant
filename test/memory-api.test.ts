import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** Real HTTP/token/SQLite/application/context path. Host identity and the unused Feishu transport are fixtures. */
async function setup(withRuntime = true) {
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  const scope = `space:${space.id}`
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', cwd: '/synthetic', requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', requesterOpenId: 'alice', messageId: 'human-origin', prompt: '处理本群记忆' }).task
  registry.startTask(task.id, Date.now(), task.sessionKey)
  const host = memoryRuntimeFixture(registry, memory)
  const acpId = host.pin({ runId: 'run-a', sessionKey: task.sessionKey, taskId: task.id, actorOpenId: 'alice' })
  const state = { runId: 'run-a', actor: 'alice' as string | undefined, stage: 'task', derivedSafe: true, enforceContext: false }
  const feishu = asFeishuClient(new FakeFeishu()), cache = new MessageCache(registry.db), log = createLogger('memory-api', 'error')
  const tokens = new TokenIssuer('synthetic-memory-secret')
  const api = createInternalApi({ registry, memory, ...sp, feishu, messageCache: cache,
    messages: new MessageService(feishu, cache, log), todos: new Todos(registry.db), tokens, log, maxHistoryPerCall: 10,
    memoryRuntime: withRuntime ? host.runtime : undefined,
    resolveActorForSession: () => state.enforceContext && (!host.attempts.isCurrent(state.runId) || !host.contexts.isEligible(state.runId, true))
      ? undefined : { requesterOpenId: state.actor, runId: state.runId, stage: state.stage },
    canPersistDerivedState: () => state.derivedSafe,
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())); registry.close() })
  const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const cap: Capability = { runId: 'run-a', sessionKey: task.sessionKey, requesterOpenId: 'alice', chatId: 'chat-a', chatType: 'group', spaceId: space.id, scopes: [...ALL_SCOPES], exp: 9999999999 }
  const post = async (path: string, body: Record<string, unknown>, override: Partial<Capability> = {}) => {
    const res = await fetch(`${url}/v1/memory/${path}`, { method: 'POST', headers: { authorization: `Bearer ${tokens.issue({ ...cap, ...override })}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as Record<string, any> }
  }
  const add = (title = 'memory canary', body = 'synthetic memory body', extra: Partial<Parameters<ChannelMemory['add']>[0]> = {}) => memory.add({ scope, kind: 'fact', title, body, ...extra })
  return { registry, memory, ...sp, space, scope, task, host, acpId, state, cap, post, add }
}

describe('memory HTTP routes use the current registered context', () => {
  it('registers the actual returned IDs and revisions, and keeps model replacements candidates', async () => {
    const t = await setup(), old = t.add('original preference')
    t.memory.confirm(old.id, t.scope, { by: 'alice', messageId: 'confirm-old' })
    const current = t.memory.get(old.id)!
    const found = await t.post('search', { query: 'original preference', runId: 'forged', notes: [{ id: 999, revision: 1 }] })
    expect(found.status).toBe(200)
    expect(found.body.notes).toMatchObject([{ id: old.id, revision: current.revision, status: 'confirmed' }])
    expect(t.host.contexts.get(t.acpId)?.notes).toEqual([{ id: old.id, revision: current.revision }])
    const saved = await t.post('save', { title: 'corrected preference', body: 'new proposed value', replaces: old.id, certainty: 'confirmed', source: { by: 'mallory' } })
    expect(saved).toMatchObject({ status: 200, body: { note: { status: 'candidate', source: { by: 'alice' } }, replacement: { id: old.id, status: 'pending_confirmation' } } })
    expect(t.memory.get(old.id)).toEqual(current)
    expect(t.host.contexts.get(t.acpId)?.state).toBe('valid')
    t.host.application.confirm(saved.body.note.id, t.scope, { by: 'alice', messageId: 'confirm-new' })
    expect(t.host.contexts.get(t.acpId)?.state).toBe('invalidated')
    expect(t.host.attempts.get('run-a')?.stopReason).toBe('memory_context_invalidated')
  })

  it('rejects an old search result before returning its body when the note changed during retrieval', async () => {
    const t = await setup(), note = t.add('STALE_SECRET', 'BODY_MUST_NOT_LEAVE')
    const search = t.memory.search.bind(t.memory)
    vi.spyOn(t.memory, 'search').mockImplementation((...args) => { const result = search(...args); t.host.application.remove(note.id, t.scope); return result })
    const response = await t.post('search', { query: 'STALE_SECRET' })
    expect(response.status).toBe(403)
    expect(JSON.stringify(response.body)).not.toMatch(/STALE_SECRET|BODY_MUST_NOT_LEAVE/)
    expect(t.host.contexts.get(t.acpId)?.notes).toEqual([])
  })

  it('rechecks the registered context after handler completion before putting old memory on HTTP', async () => {
    const t = await setup(), note = t.add('AFTER_HANDLER_SECRET', 'LATE_BODY_MUST_NOT_LEAVE')
    const record = t.host.runtime.recordRead
    vi.spyOn(t.host.runtime, 'recordRead').mockImplementation((runId, refs) => {
      record(runId, refs)
      if (refs.length) queueMicrotask(() => t.host.application.remove(note.id, t.scope))
    })
    const response = await t.post('search', { query: 'AFTER_HANDLER_SECRET' })
    expect(response.status).toBe(403)
    expect(JSON.stringify(response.body)).not.toMatch(/AFTER_HANDLER_SECRET|LATE_BODY_MUST_NOT_LEAVE/)
    expect(t.host.contexts.get(t.acpId)?.state).toBe('invalidated')
  })

  it('does not turn a host no-op deletion into a success receipt', async () => {
    const t = await setup(), note = t.add()
    vi.spyOn(t.host.runtime, 'forget').mockResolvedValue(false)
    expect((await t.post('forget', { id: note.id })).status).toBe(404)
    expect(t.memory.get(note.id)).toEqual(note)
  })

  it.each(['save', 'forget'] as const)('returns the committed %s fact after self-invalidation without authorizing later requests', async action => {
    const t = await setup(), note = t.add()
    await t.post('search', { query: 'memory canary' })
    t.state.enforceContext = true
    const result = await t.post(action, action === 'forget' ? { id: note.id } : { title: 'new candidate', body: 'replacement', replaces: note.id })
    expect(result.status).toBe(200)
    expect(t.host.attempts.get('run-a')?.state).toBe('stop_requested')
    expect(t.host.contexts.get(t.acpId)?.state).toBe('invalidated')
    expect((await t.post('search', { query: '' })).status).toBe(403)
    expect((await t.post('save', { title: 'later write', body: 'must not write' })).status).toBe(403)
    if (action === 'forget') expect(result.body).toEqual({ ok: true, id: note.id })
    else expect(result.body).toMatchObject({ note: { status: 'candidate' }, replacement: { id: note.id, status: 'applied' } })
  })

  it('allows current personal control with dirty sources but keeps saves and foreign deletion blocked', async () => {
    const t = await setup(), note = t.add()
    await t.post('search', { query: 'memory canary' })
    t.state.derivedSafe = false
    expect((await t.post('save', { title: 'derived', body: 'must not persist' })).status).toBe(403)
    const foreign = t.add('foreign', 'not yours', { scope: 'space:elsewhere' })
    expect((await t.post('forget', { id: foreign.id })).status).toBe(404)
    expect(await t.post('forget', { id: note.id })).toEqual({ status: 200, body: { ok: true, id: note.id } })
    expect(t.memory.getTombstone(note.id)?.noteId).toBe(note.id)
    expect(t.memory.get(foreign.id)).toBeDefined()
    expect(t.host.contexts.get(t.acpId)?.state).toBe('invalidated')
  })

  it('keeps consolidation limited to the signed current candidate set even for dirty-source control', async () => {
    const t = await setup(), candidate = t.add('candidate'), confirmed = t.add('confirmed')
    t.memory.confirm(confirmed.id, t.scope, { by: 'alice', messageId: 'confirmation' })
    t.state.stage = 'reflect'; t.state.derivedSafe = false
    const override = { memoryWritePolicy: { candidateIds: [candidate.id, confirmed.id] } }
    expect((await t.post('forget', { id: confirmed.id }, override)).status).toBe(403)
    expect((await t.post('forget', { id: String(candidate.id) }, override)).status).toBe(403)
    expect(await t.post('forget', { id: candidate.id }, override)).toMatchObject({ status: 200, body: { ok: true } })
    expect(t.memory.get(confirmed.id)?.status).toBe('confirmed')
  })

  it.each(['scope', 'actor', 'run', 'space'] as const)('rejects changed %s before a memory read or mutation', async mode => {
    const t = await setup(), note = t.add()
    if (mode === 'actor') t.state.actor = 'bob'
    if (mode === 'run') t.state.runId = 'new-run'
    if (mode === 'space') t.spaces.archive(t.space.id)
    const override = mode === 'scope' ? { scopes: [] } : {}
    for (const [path, body] of [['search', { query: 'memory' }], ['save', { title: 'new', body: 'new' }], ['forget', { id: note.id }]] as const) expect((await t.post(path, body, override)).status).toBe(403)
    expect(t.memory.get(note.id)).toEqual(note)
    expect(t.host.contexts.get(t.acpId)?.notes).toEqual([])
  })

  it('leaves all three routes unavailable without the host and never writes via the old store', async () => {
    const t = await setup(false), note = t.add()
    for (const [path, body] of [['search', { query: 'memory' }], ['save', { title: 'new', body: 'new' }], ['forget', { id: note.id }]] as const) expect((await t.post(path, body)).status).toBe(503)
    expect(t.memory.recent(t.scope)).toEqual([note])
  })
})
