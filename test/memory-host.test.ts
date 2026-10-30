import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { ChannelMemory, type MemoryNote } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RuntimeContexts } from '../src/core/runtime-contexts.js'
import { spaceScope } from '../src/core/space.js'
import { Todos } from '../src/core/todos.js'
import type { AskBugQuestionReceipt } from '../src/core/question-types.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createInternalApi } from '../src/internal/api.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { deferred } from './helpers/model-agent.js'
import { spaceDeps } from './helpers/space.js'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

/** Real SDK transport, host, context stores and Delivery. Model output/platform are synthetic. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-memory-host-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), attempts = new RunAttempts(registry.db)
  const contexts = new RuntimeContexts(registry.db), bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs)
  const sp = spaceDeps(registry.db, { admins: ['alice'] }), space = sp.spaces.ensure({ kind: 'group', chatId: 'group', openId: 'alice' })
  const scope = spaceScope(space.id), fake = new FakeFeishu(), cache = new MessageCache(registry.db), todos = new Todos(registry.db)
  fake.members.set('group', new Set(['alice']))
  const log = createLogger('memory-host', 'error'), peer = createFakeAgent({ script: [{ kind: 'text', text: 'SYNTHETIC_RESULT' }] })
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: peer.app }, log,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  const messages = new MessageService(asFeishuClient(fake), cache, log), tokens = new TokenIssuer('synthetic')
  const host = new Orchestrator({ cfg, registry, ...sp, memory, questions, todos, feishu: asFeishuClient(fake), runtime,
    messages, tokens,
    // These memory tests continue one work. The synthetic classifier must now
    // choose that completed candidate explicitly; new topics are tested by ingress-routing.
    ingressClassifier: { classify: async input => {
      const targetRef = input.message.replyToRef ?? (input.candidates.length === 1 ? input.candidates[0]!.ref : undefined)
      return targetRef ? { kind: 'amend', targetRef } : { kind: 'new_work' }
    } },
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log })
  closes.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  let serial = 0
  function message(text = 'MEMORY_TARGET', over: Partial<InboundMessage> = {}): InboundMessage {
    const id = `memory-host-${++serial}`
    return { eventId: id, messageId: id, chatId: 'group', chatType: 'group', threadId: 'topic', tenantId: 'tenant',
      senderOpenId: 'alice', senderType: 'user', msgType: 'text', text, mentions: [{ key: '@Friday', name: 'Friday', openId: 'bot' }],
      createTimeMs: Date.now(), ...over }
  }
  const current = (msg: InboundMessage) => {
    const task = registry.taskForMessage(msg.messageId)!, actor = host.resolveActorForSession(task.sessionKey)!
    return { task, actor, session: registry.getSession(task.sessionKey)! }
  }
  const add = (confirmed = true) => memory.add({ scope, kind: confirmed ? 'rule' : 'fact', title: 'MEMORY_TARGET', body: 'CONSUMED_MEMORY_CANARY',
    ...(confirmed ? { status: 'confirmed' as const, confirmation: { by: 'alice', messageId: 'human-proof', at: 1 } } : {}) })
  return { registry, memory, attempts, contexts, bugs, questions, space, scope, ...sp, fake, cache, peer, runtime, host, message, current, add,
    todos, messages, tokens, log }
}

async function hostApi(t: ReturnType<typeof fixture>) {
  const api = createInternalApi({ registry: t.registry, memory: t.memory, messageCache: t.cache, messages: t.messages, todos: t.todos,
    spaces: t.spaces, policy: t.policy, circles: t.circles, feishu: asFeishuClient(t.fake), tokens: t.tokens, log: t.log, maxHistoryPerCall: 20,
    abilities: t.host.abilities, resolveActorForSession: key => t.host.resolveActorForSession(key),
    allowedRoutesForSession: key => t.host.allowedRoutesForSession(key), canPersistDerivedState: key => t.host.canPersistDerivedState(key),
    memoryRuntime: { recordRead: (runId, refs) => t.host.recordMemoryRead(runId, refs),
      add: (runId, input) => t.host.addMemory(runId, input), forget: (runId, id, scope) => t.host.forgetMemory(runId, id, scope) } })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  closes.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())) })
  return async (path = '/v1/ability', body: unknown = { what: 'status', runId: 'not-authoritative' }) => {
    const servers = t.peer.state.allPrompts.at(-1)!.mcpServers as { env: { name: string; value: string }[] }[]
    const token = servers[0]!.env.find(entry => entry.name === 'FRIDAY_CAP_TOKEN')!.value
    const res = await fetch(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() as { text?: string; ok?: boolean; id?: number; note?: MemoryNote;
      replacement?: { id: number; status: string }; confirmation_command?: string; error?: string } }
  }
}

describe('memory commits reach real host Run and ACP admission', () => {
  it('links the actual automatic answer and tool-created extraction to consumed versions, so correction removes both from search', async () => {
    const t = fixture(), post = await hostApi(t), note = t.add(false)
    let extractedId = 0
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      const saved = await post('/v1/memory/save', { kind: 'fact', title: 'DERIVED_OLD', body: 'OLD_DERIVED_CANARY',
        derivedFrom: [], source: { ancestors: [] } })
      expect(saved.status).toBe(200)
      extractedId = saved.body.note!.id
    } }, { kind: 'text', text: 'OLD_ANSWER_CANARY' }]
    await t.host.handleMessage(t.message())
    const answer = t.memory.recent(t.scope, 20).find(item => item.kind === 'qa')!
    expect(t.memory.getProvenance(extractedId)?.ancestors).toContainEqual({ id: note.id, revision: 1 })
    expect(t.memory.getProvenance(answer.id)?.ancestors).toEqual([
      { id: note.id, revision: 1 }, { id: extractedId, revision: 1 },
    ])
    t.memory.add({ scope: t.scope, kind: 'fact', title: 'current', body: 'CURRENT', replaces: note.id })
    expect(t.memory.search(t.scope, 'OLD_ANSWER_CANARY')).toEqual([])
    expect(t.memory.search(t.scope, 'OLD_DERIVED_CANARY')).toEqual([])
    expect(t.memory.getProvenance(answer.id)?.state).toBe('unavailable')
    expect(t.memory.getProvenance(extractedId)?.state).toBe('unavailable')
  })

  it('registers notes first revealed by the real HTTP ability/status path using the signed Run, then invalidates that consumer', async () => {
    const t = fixture(), status = await hostApi(t), entered = deferred(), release = deferred(), msg = t.message()
    const note = t.memory.add({ scope: t.scope, kind: 'decision', title: 'STATUS_ONLY_DECISION', body: 'status source evidence',
      status: 'confirmed', confirmation: { by: 'alice', messageId: 'human-status-proof', at: Date.now() } })
    t.peer.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } }, { kind: 'text', text: 'STALE_STATUS_RESULT' }]
    const pending = t.host.handleMessage(msg); await entered.promise
    const { actor } = t.current(msg), acp = t.peer.state.allPrompts[0]!.sessionId
    expect(t.peer.state.allPrompts[0]!.text).not.toContain(note.title)
    expect(t.contexts.contextForRun(actor.runId)?.notes).not.toContainEqual({ id: note.id, revision: note.revision })
    const result = await status()
    expect(result.status).toBe(200)
    expect(result.body.text).toContain(note.title)
    expect(t.contexts.contextForRun(actor.runId)?.notes).toContainEqual({ id: note.id, revision: note.revision })
    await t.host.handleMessage(t.message(`/forget ${note.id}`))
    expect(t.contexts.get(acp)?.state).toBe('invalidated')
    expect((await status()).status).toBe(403)
    release.resolve(); await pending
    expect(t.attempts.get(actor.runId)).toMatchObject({ state: 'cancelled', stopReason: 'memory_context_invalidated' })
    expect(t.fake.answers().join('\n')).not.toContain('STALE_STATUS_RESULT')
  })

  it('registers a new note returned only by HTTP save, so replacing it later invalidates that ACP without prompt or search consumption', async () => {
    const t = fixture(), post = await hostApi(t), entered = deferred(), release = deferred(), msg = t.message()
    t.peer.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } },
      { kind: 'text', text: 'LATE_RESULT_AFTER_SAVE_REPLACEMENT' }]
    const pending = t.host.handleMessage(msg); await entered.promise
    try {
      const { task, actor } = t.current(msg), acp = t.peer.state.allPrompts[0]!.sessionId
      expect(t.contexts.contextForRun(actor.runId)?.notes).toEqual([])
      expect(t.peer.state.allPrompts[0]!.text).not.toContain('SAVE_RESPONSE_ONLY_CANARY')
      const saved = await post('/v1/memory/save', { kind: 'fact', title: 'save response source', body: 'SAVE_RESPONSE_ONLY_CANARY' })
      expect(saved.status).toBe(200)
      expect(saved.body.note).toMatchObject({ status: 'candidate', body: 'SAVE_RESPONSE_ONLY_CANARY' })
      const note = saved.body.note!
      expect(t.contexts.contextForRun(actor.runId)?.notes).toEqual([{ id: note.id, revision: note.revision }])
      expect(t.attempts.get(actor.runId)?.state).toBe('running')
      expect(t.fake.sent).toEqual([])

      const updated = await post('/v1/memory/save', { kind: 'fact', title: 'corrected candidate', body: 'CURRENT_CANDIDATE', replaces: note.id })
      expect(updated.status).toBe(200)
      expect(updated.body).toMatchObject({ ok: true, replacement: { id: note.id, status: 'applied' } })
      expect(t.memory.get(note.id)).toMatchObject({ status: 'superseded', supersededBy: updated.body.note!.id })
      expect(t.contexts.get(acp)?.state).toBe('invalidated')
      expect(t.host.resolveActorForSession(task.sessionKey)).toBeUndefined()
      release.resolve(); await pending
      expect(t.registry.getTask(task.id)).toMatchObject({ status: 'cancelled', stopReason: 'memory_context_invalidated' })
      expect(t.attempts.get(actor.runId)).toMatchObject({ state: 'cancelled', stopReason: 'memory_context_invalidated' })
      expect(t.peer.state.allPrompts).toHaveLength(1)
      expect(t.fake.sent).toHaveLength(1)
      expect(JSON.stringify(t.fake.sent[0]!.payload)).toContain('要记住这条吗？')
      expect(JSON.stringify(t.fake.sent)).toContain('CURRENT_CANDIDATE')
      expect(JSON.stringify(t.fake.sent)).toContain('SAVE_RESPONSE_ONLY_CANARY')
      expect(JSON.stringify(t.fake.sent)).not.toContain('LATE_RESULT_AFTER_SAVE_REPLACEMENT')
      expect(t.memory.recent(t.scope, 20).filter(item => item.kind === 'qa')).toEqual([])
    } finally { release.resolve(); await pending }
  })

  it('returns a committed candidate replacement through HTTP and sends one fixed confirmation receipt after invalidating its own reader', async () => {
    const t = fixture(), post = await hostApi(t), note = t.add(false), entered = deferred(), release = deferred(), msg = t.message()
    t.peer.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } },
      { kind: 'text', text: 'STALE_SAVE_LATE_RESULT' }]
    const pending = t.host.handleMessage(msg); await entered.promise
    const { task, actor } = t.current(msg)
    expect(t.contexts.contextForRun(actor.runId)?.notes).toContainEqual({ id: note.id, revision: note.revision })
    const result = await post('/v1/memory/save', { kind: 'fact', title: 'NEW_CANDIDATE_TITLE', body: 'NEW_CANDIDATE_BODY', replaces: note.id })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, note: { status: 'candidate', title: 'NEW_CANDIDATE_TITLE', body: 'NEW_CANDIDATE_BODY' },
      replacement: { id: note.id, status: 'applied' } })
    const newId = result.body.note!.id
    expect(t.memory.get(note.id)).toMatchObject({ status: 'superseded', supersededBy: newId })
    expect(t.memory.get(newId)).toMatchObject({ status: 'candidate', confirmation: null })
    expect(result.body.confirmation_command).toBeUndefined()
    expect(t.host.resolveActorForSession(task.sessionKey)).toBeUndefined()
    expect(t.fake.sent).toHaveLength(1)
    const notice = t.fake.sent[0]!
    expect(notice.target).toBe(msg.messageId)
    expect(JSON.stringify(notice.payload)).toContain('要记住这条吗？')
    expect(JSON.stringify(notice.payload)).toMatch(/确认/)
    expect(JSON.stringify(notice.payload)).toContain('NEW_CANDIDATE_BODY')
    expect(JSON.stringify(notice.payload)).toContain('CONSUMED_MEMORY_CANARY')
    expect(t.registry.db.prepare('SELECT status,remote_id FROM deliveries').all()).toEqual([{ status: 'sent', remote_id: notice.messageId }])
    expect((await post('/v1/memory/search', { query: 'MEMORY_TARGET' })).status).toBe(403)
    release.resolve(); await pending
    expect(t.registry.getTask(task.id)).toMatchObject({ status: 'cancelled', stopReason: 'memory_context_invalidated' })
    expect(t.attempts.get(actor.runId)).toMatchObject({ state: 'cancelled', stopReason: 'memory_context_invalidated' })
    expect(t.fake.sent).toHaveLength(1)
    expect(JSON.stringify(t.fake.sent)).not.toContain('STALE_SAVE_LATE_RESULT')
    expect(t.memory.recent(t.scope, 20).filter(item => item.kind === 'qa')).toEqual([])
  })

  it.each(['org', 'circle'] as const)('returns a committed %s correction to the original group audience without its shared title or body', async share => {
    const t = fixture(), post = await hostApi(t), entered = deferred(), release = deferred(), msg = t.message()
    if (share === 'circle') t.circles.join(msg.chatId, 'synthetic-circle', 'alice')
    const scope = share === 'org' ? 'org' : 'circle:synthetic-circle'
    const note = t.memory.add({ scope, kind: 'fact', title: 'MEMORY_TARGET', body: 'SHARED_OLD_CANARY' })
    t.peer.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } },
      { kind: 'text', text: 'LATE_SHARED_CORRECTION_ANSWER' }]
    const pending = t.host.handleMessage(msg); await entered.promise
    try {
      const { task, actor } = t.current(msg)
      expect(t.contexts.contextForRun(actor.runId)?.notes).toContainEqual({ id: note.id, revision: note.revision })
      const result = await post('/v1/memory/save', { share, kind: 'fact', title: 'SHARED_NEW_TITLE', body: 'SHARED_NEW_BODY', replaces: note.id })
      expect(result.status).toBe(200)
      expect(result.body).toMatchObject({ ok: true, note: { scope, status: 'candidate' }, replacement: { id: note.id, status: 'applied' } })
      const newId = result.body.note!.id
      expect(t.memory.get(note.id)).toMatchObject({ status: 'superseded', supersededBy: newId })
      expect(t.fake.sent).toHaveLength(1)
      expect(t.fake.sent[0]).toMatchObject({ target: msg.messageId, payload: '更正已记下，你确认后生效；原来那条在此之前照常有效。' })
      const ledger = t.registry.db.prepare('SELECT status,audience FROM deliveries').get() as { status: string; audience: string }
      expect(ledger.status).toBe('sent')
      expect(JSON.parse(ledger.audience)).toMatchObject({ kind: 'group', spaceId: t.space.id, chatId: msg.chatId, replyToMessageId: msg.messageId })
      expect(t.host.resolveActorForSession(task.sessionKey)).toBeUndefined()
      expect((await post('/v1/memory/search', { query: 'MEMORY_TARGET' })).status).toBe(403)
      release.resolve(); await pending
      expect(t.registry.getTask(task.id)).toMatchObject({ status: 'cancelled', stopReason: 'memory_context_invalidated' })
      expect(t.fake.sent).toHaveLength(1)
      expect(JSON.stringify(t.fake.sent)).not.toMatch(/SHARED_OLD_CANARY|SHARED_NEW_TITLE|SHARED_NEW_BODY|LATE_SHARED_CORRECTION_ANSWER/)
    } finally { release.resolve(); await pending }
  })

  it('returns HTTP success for committed self-forget when its fixed receipt ACK is unknown, keeping the ledger and never posting twice', async () => {
    const t = fixture(), post = await hostApi(t), note = t.add(), entered = deferred(), release = deferred(), msg = t.message()
    t.peer.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } },
      { kind: 'text', text: 'STALE_FORGET_LATE_RESULT' }]
    const pending = t.host.handleMessage(msg); await entered.promise
    const { task, actor } = t.current(msg)
    expect(t.contexts.contextForRun(actor.runId)?.notes).toContainEqual({ id: note.id, revision: note.revision })
    const actualSend = t.fake.replyText.bind(t.fake)
    const send = vi.spyOn(t.fake, 'replyText').mockImplementation(async (...args) => {
      await actualSend(...args)
      throw new Error('synthetic connection lost after remote acceptance')
    })
    const result = await post('/v1/memory/forget', { id: note.id })
    expect(result).toEqual({ status: 200, body: { ok: true, id: note.id } })
    expect(t.memory.get(note.id)).toBeUndefined()
    expect(t.memory.getTombstone(note.id)).toMatchObject({ noteId: note.id, scope: t.scope })
    const ledger = t.registry.db.prepare('SELECT delivery_key,status,remote_id FROM deliveries').all()
    expect(ledger).toEqual([{ delivery_key: `memory:forget:${note.id}:v${t.memory.getTombstone(note.id)!.revision}`, status: 'unknown', remote_id: null }])
    expect((await post('/v1/memory/forget', { id: note.id })).status).toBe(403)
    release.resolve(); await pending
    expect(send).toHaveBeenCalledTimes(1)
    expect(t.fake.sent).toHaveLength(1)
    expect(t.fake.sent[0]).toMatchObject({ target: msg.messageId, payload: '已删除这条记忆。' })
    expect(t.registry.db.prepare('SELECT delivery_key,status,remote_id FROM deliveries').all()).toEqual(ledger)
    expect(t.registry.getTask(task.id)).toMatchObject({ status: 'cancelled', stopReason: 'memory_context_invalidated' })
    expect(t.attempts.get(actor.runId)).toMatchObject({ state: 'cancelled', stopReason: 'memory_context_invalidated' })
    expect(JSON.stringify(t.fake.sent)).not.toMatch(/CONSUMED_MEMORY_CANARY|STALE_FORGET_LATE_RESULT/)
    expect(t.memory.recent(t.scope, 20).filter(item => item.kind === 'qa')).toEqual([])
  })

  it.each(['forget', 'confirm'] as const)('%s stops only the Run which actually consumed that revision and rebuilds the next ACP in the same business cwd', async operation => {
    const t = fixture(), note = t.add(operation === 'forget'), entered = deferred(), release = deferred(), msg = t.message()
    // A numeric command alone is not proof of having seen a candidate's full version.
    if (operation === 'confirm') {
      await t.host.handleMessage(t.message(`/memory confirm ${note.id}`))
      expect(t.memory.get(note.id)?.status).toBe('candidate')
    }
    t.peer.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } }, { kind: 'text', text: 'STALE_LATE_RESULT' }]
    const pending = t.host.handleMessage(msg)
    await entered.promise
    const { task, actor, session } = t.current(msg), acp = t.peer.state.allPrompts[0]!.sessionId
    expect(t.peer.state.allPrompts[0]!.text).toContain(note.body)
    expect(t.contexts.contextForRun(actor.runId)?.notes).toContainEqual({ id: note.id, revision: 1 })
    await t.host.handleMessage(t.message(operation === 'forget' ? `/forget ${note.id}` : `/memory confirm ${note.id}`))
    expect(t.host.resolveActorForSession(task.sessionKey)).toBeUndefined()
    expect(t.attempts.get(actor.runId)?.state).toBe('stop_requested')
    expect(t.registry.getTask(task.id)?.stopReason).toBe('memory_context_invalidated')
    expect(t.contexts.get(acp)?.state).toBe('invalidated')
    release.resolve(); await pending
    expect(t.attempts.get(actor.runId)).toMatchObject({ state: 'cancelled', stopReason: 'memory_context_invalidated' })
    expect(t.registry.getTask(task.id)?.status).toBe('cancelled')
    expect(t.peer.state.cancelled).toContain(acp)
    expect(t.fake.answers().join('\n')).not.toContain('STALE_LATE_RESULT')

    t.peer.state.script = [{ kind: 'text', text: 'FRESH_RESULT' }]
    await t.host.handleMessage(t.message())
    const next = t.peer.state.allPrompts[1]!
    expect(next.sessionId).not.toBe(acp)
    expect(t.peer.state.resumed).not.toContain(acp)
    expect(t.registry.getSession(task.sessionKey)?.cwd).toBe(session.cwd)
    expect(t.peer.state.sessions.get(next.sessionId)?.cwd).toBe(session.cwd)
    if (operation === 'forget') expect(next.text).not.toContain(note.body)
    else {
      expect(next.text).toContain(note.body)
      expect(t.contexts.get(next.sessionId)?.notes).toContainEqual({ id: note.id, revision: 2 })
      expect(t.memory.get(note.id)?.status).toBe('confirmed')
    }
    expect(t.fake.answers()).toContain('FRESH_RESULT')
  })

  it('keeps a warm ACP when an unrelated Space memory changes, without interrupting its actual consumer', async () => {
    const t = fixture(), note = t.add(), otherSpace = t.spaces.ensure({ kind: 'group', chatId: 'other-group', openId: 'alice' })
    t.fake.members.set('other-group', new Set(['alice']))
    const unrelated = t.memory.add({ scope: spaceScope(otherSpace.id), kind: 'fact', title: 'other', body: 'OTHER_SPACE_CANARY' })
    const msg = t.message(), entered = deferred(), release = deferred()
    t.peer.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } }, { kind: 'text', text: 'KEPT_RUNNING' }]
    const pending = t.host.handleMessage(msg); await entered.promise
    const { task, actor } = t.current(msg), acp = t.peer.state.allPrompts[0]!.sessionId
    await t.host.handleMessage(t.message(`/forget ${unrelated.id}`, { chatId: 'other-group', threadId: 'other-topic' }))
    expect(t.memory.get(unrelated.id)).toBeUndefined()
    expect(t.attempts.get(actor.runId)?.state).toBe('running')
    expect(t.contexts.contextForRun(actor.runId)?.notes).toContainEqual({ id: note.id, revision: 1 })
    release.resolve(); await pending
    t.peer.state.script = [{ kind: 'text', text: 'NEXT_WARM_RESULT' }]
    await t.host.handleMessage(t.message())
    expect(t.peer.state.allPrompts[1]!.sessionId).toBe(acp)
    expect(t.peer.state.resumed).toContain(acp)
    expect(t.peer.state.cancelled).not.toContain(acp)
    expect(t.registry.getTask(task.id)?.status).toBe('done')
    expect(t.peer.state.allPrompts.map(p => p.text).join('\n')).not.toContain('OTHER_SPACE_CANARY')
  })

  it('rebuilds from human history while omitting stale assistant messages, then keeps the new assistant context on later turns', async () => {
    const t = fixture(), note = t.add()
    t.fake.threads.set('topic', [
      historyMsg({ messageId: 'human-original', chatId: 'group', senderType: 'user', senderOpenId: 'alice', text: 'ORIGINAL_HUMAN_REQUIREMENT', createTimeMs: 1 }),
      historyMsg({ messageId: 'old-assistant', chatId: 'group', senderType: 'app', senderOpenId: 'bot', text: 'UNRELATED_ASSISTANT_CLAIM', createTimeMs: 2 }),
    ])
    t.peer.state.script = [{ kind: 'text', text: 'OLD_ASSISTANT_DERIVED_CLAIM' }]
    const first = t.message('ORIGINAL_HUMAN_REQUIREMENT MEMORY_TARGET'); await t.host.handleMessage(first)
    const task = t.registry.taskForMessage(first.messageId)!, old = t.peer.state.allPrompts[0]!
    expect(old.text).not.toContain('UNRELATED_ASSISTANT_CLAIM')
    expect(t.fake.answers()).toContain('OLD_ASSISTANT_DERIVED_CLAIM')
    expect(t.contexts.get(old.sessionId)?.notes).toContainEqual({ id: note.id, revision: 1 })
    await t.host.handleMessage(t.message(`/forget ${note.id}`))
    t.peer.state.script = [{ kind: 'text', text: 'NEW_ASSISTANT_FACT' }]
    await t.host.handleMessage(t.message('继续处理原来的要求。'))
    const rebuilt = t.peer.state.allPrompts[1]!
    expect(rebuilt.sessionId).not.toBe(old.sessionId)
    expect(rebuilt.text).toContain('ORIGINAL_HUMAN_REQUIREMENT')
    expect(rebuilt.text).not.toContain('OLD_ASSISTANT_DERIVED_CLAIM')
    expect(rebuilt.text).not.toContain(note.body)
    expect(rebuilt.text).not.toContain('UNRELATED_ASSISTANT_CLAIM')
    t.peer.state.script = [{ kind: 'text', text: 'THIRD_RESULT' }]
    await t.host.handleMessage(t.message('基于刚才的新结果继续。'))
    expect(t.peer.state.allPrompts[2]!.sessionId).toBe(rebuilt.sessionId)
    expect(t.peer.state.sessions.get(rebuilt.sessionId)?.prompts).toHaveLength(2)
    expect(t.fake.answers()).toContain('NEW_ASSISTANT_FACT')
    expect(t.registry.getSession(task.sessionKey)?.acpSessionId).toBe(rebuilt.sessionId)
    expect(new Set([1, 2, 3].map(id => t.registry.taskWork.get(id)?.key)).size).toBe(1)
  })

  it('retains a genuinely delivered Question when forgetting stops its originating Run, and accepts the later explicit answer on a fresh ACP', async () => {
    const t = fixture(), note = t.add(), msg = t.message(), asked = deferred(), release = deferred()
    let receipt!: AskBugQuestionReceipt, bucketId = 0, oldRun = ''
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      const { actor, session } = t.current(msg); oldRun = actor.runId
      bucketId = t.bugs.record({ spaceId: t.space.id, title: '合成问题', chatId: 'group', messageId: msg.messageId, reporterOpenId: 'alice', text: msg.text }).bucket.id
      receipt = await t.host.askBugQuestion(session.sessionKey, actor.runId, { id: bucketId, kind: 'info', question: '之前点了哪个按钮？', missingInfo: ['previous action'] })
      asked.resolve(); await release.promise
    } }, { kind: 'text', text: 'STALE_DIAGNOSIS' }]
    const pending = t.host.handleMessage(msg); await asked.promise
    expect(receipt.delivery_status).toBe('sent')
    const before = t.questions.get(receipt.question_id)!
    await t.host.handleMessage(t.message(`/forget ${note.id}`))
    release.resolve(); await pending
    expect(t.attempts.get(oldRun)?.state).toBe('cancelled')
    expect(t.questions.get(before.id)).toEqual(before)
    expect(t.bugs.get(bucketId)?.intakePhase).not.toBe('cancelled')
    expect(t.registry.db.prepare('SELECT status,remote_id FROM deliveries WHERE delivery_key=?').get(before.deliveryKey))
      .toEqual({ status: 'sent', remote_id: receipt.message_id })
    const reply = t.message('点了发送。日志暂时拿不到。', { parentId: receipt.message_id!, mentions: [] })
    t.peer.state.script = [{ kind: 'text', text: '已保留这次补充。' }]
    await t.host.handleMessage(reply)
    const replies = t.questions.replies(before.id)
    expect(replies).toHaveLength(1)
    expect(replies[0]?.messageId).toBe(reply.messageId)
    expect(t.peer.state.allPrompts.at(-1)!.sessionId).not.toBe(t.peer.state.allPrompts[0]!.sessionId)
    expect(t.peer.state.allPrompts.at(-1)!.text).toContain(reply.text)
    expect(t.fake.answers().join('\n')).not.toContain('STALE_DIAGNOSIS')
  })
})
