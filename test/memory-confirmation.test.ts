import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory, type NoteKind } from '../src/core/memory.js'
import type { MemorySourceReference } from '../src/core/memory-provenance.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { createInternalApi } from '../src/internal/api.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const registries: Registry[] = []
afterEach(() => { for (const registry of registries.splice(0)) registry.close(); vi.unstubAllGlobals() })
function registry() { const value = new Registry(':memory:'); registries.push(value); return value }
const scope = 'space:sp_dm_alice'
const proof = { by: 'alice', messageId: 'human-confirmation-message', at: 1000 }

describe('memory confirmation is a host-recorded human action', () => {
  it('keeps every automatic kind and model claims unconfirmed, with original content searchable', () => {
    const memory = new ChannelMemory(registry().db)
    for (const kind of ['qa', 'fact', 'decision', 'todo', 'profile', 'rule', 'lesson'] as NoteKind[]) {
      const note = memory.add({ scope, kind, title: `Synthetic ${kind}`, body: 'Original user history and model summary', status: 'confirmed', source: { by: 'alice', confirmation: proof, generatedBy: 'model' } })
      expect(note).toMatchObject({ status: 'candidate', confirmation: null })
    }
    expect(memory.search(scope, 'Original')).toHaveLength(7)
    expect(memory.rules(scope)).toEqual([])
    expect(memory.confirmedBetween(scope, 0, Date.now() + 1)).toEqual([])
    expect(memory.renderForPrompt(scope, 'Original')).toContain('未确认')
  })

  it('records explicit personal confirmation and preserves it on reopening', () => {
    const db = registry().db
    const memory = new ChannelMemory(db)
    const note = memory.add({ scope, kind: 'rule', title: '请简短回答', body: '请简短回答', source: { by: 'reported-author' } })
    expect(memory.confirm(note.id, scope, { by: 'bob', messageId: 'wrong-person' })).toBe(false)
    expect(memory.confirm(note.id, scope, { by: 'alice', messageId: '' })).toBe(false)
    expect(memory.confirm(note.id, scope, { by: 'alice', messageId: 'current-human-message' })).toBe(true)
    expect(new ChannelMemory(db).get(note.id)).toMatchObject({ status: 'confirmed', source: { by: 'reported-author' }, confirmation: { by: 'alice', messageId: 'current-human-message', at: expect.any(Number) } })
    expect(memory.rules(scope).map((n) => n.id)).toEqual([note.id])
  })

  it('does not let a candidate correction supersede confirmed preferences before human confirmation', () => {
    const memory = new ChannelMemory(registry().db)
    const original = memory.add({ scope, kind: 'rule', title: '简短回答', body: '简短回答', status: 'confirmed', confirmation: proof })
    const correction = memory.add({ scope, kind: 'rule', title: '详细回答', body: '详细回答', replaces: original.id })
    expect(memory.get(original.id)?.status).toBe('confirmed')
    expect(memory.rules(scope).map((n) => n.id)).toEqual([original.id])
    expect(correction).toMatchObject({ status: 'candidate', source: { replaces: original.id } })
    expect(memory.confirm(correction.id, scope, { by: 'alice', messageId: 'approve-new-preference' })).toBe(true)
    expect(memory.get(original.id)).toMatchObject({ status: 'superseded', supersededBy: correction.id })
    expect(memory.rules(scope).map((n) => n.id)).toEqual([correction.id])
  })

  it('reports when a person confirmed the note, independently of creation and sharing time', () => {
    const db = registry().db, memory = new ChannelMemory(db)
    const now = Date.now(), earlier = now - 14 * 86_400_000
    const pending = memory.add({ scope, kind: 'decision', title: '旧候选今天确认', body: '原文' })
    db.prepare('UPDATE memory_notes SET created_at = ? WHERE id = ?').run(earlier, pending.id)
    memory.add({ scope, kind: 'decision', title: '旧确认今天导入', body: '原文', status: 'confirmed', confirmation: { ...proof, at: earlier } })
    memory.add({ scope, kind: 'decision', title: '仍待确认', body: '原文' })
    expect(memory.confirm(pending.id, scope, { by: 'alice', messageId: 'confirmation-today' })).toBe(true)
    const confirmed = memory.get(pending.id)!
    expect(confirmed.createdAt).toBe(earlier)
    expect(memory.confirmedBetween(scope, now, Date.now() + 1, ['decision']).map((n) => n.id)).toEqual([pending.id])
    expect(memory.confirmedBetween(scope, earlier, earlier, ['decision']).map((n) => n.title)).toEqual(['旧确认今天导入'])
    const shared = memory.promote(pending.id, scope, 'org', 'admin')!
    const at = confirmed.confirmation!.at
    expect(memory.confirmedBetween('org', at, at).map((n) => n.id)).toEqual([shared.id])
    expect(memory.confirmedBetween('org', at + 1, Date.now() + 1000)).toEqual([])
  })

  it('preserves candidate/confirmed status and original confirmer when sharing', () => {
    const memory = new ChannelMemory(registry().db)
    const candidate = memory.add({ scope, kind: 'fact', title: '未核实的推断', body: 'x' })
    const confirmed = memory.add({ scope, kind: 'rule', title: '本人偏好', body: 'y', status: 'confirmed', confirmation: proof })
    expect(memory.promote(candidate.id, scope, 'org', 'admin')).toMatchObject({ status: 'candidate', confirmation: null })
    const shared = memory.promote(confirmed.id, scope, 'org', 'admin')!
    expect(shared).toMatchObject({ status: 'confirmed', confirmation: proof, source: { by: 'admin', noteId: confirmed.id, promotedFrom: scope } })
    expect(memory.promote(confirmed.id, scope, 'org', 'admin')?.id).toBe(shared.id)
  })

  it('backs up legacy rows before downgrading unverifiable confirmations, preserving raw history and timestamps', () => {
    const db = registry().db
    db.exec(`CREATE TABLE memory_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, session_key TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', source TEXT, superseded_by INTEGER)`)
    const insert = db.prepare('INSERT INTO memory_notes(scope,kind,title,body,created_at,status,source,superseded_by) VALUES (?,?,?,?,?,?,?,?)')
    insert.run(scope, 'qa', '旧回答', '历史原文不能变成确认事实', 10, 'confirmed', JSON.stringify({ by: 'alice', messageId: 'original-question' }), null)
    insert.run(scope, 'rule', '来源不明的旧确认', '原偏好文字', 20, 'confirmed', JSON.stringify({ by: 'alice' }), null)
    insert.run(scope, 'fact', '待确认', '原候选', 30, 'candidate', null, null)
    insert.run(scope, 'fact', '已替代', '原旧条目', 40, 'superseded', null, 3)
    const before = db.prepare('SELECT * FROM memory_notes ORDER BY id').all()
    const memory = new ChannelMemory(db)
    expect(db.prepare('SELECT * FROM memory_notes_before_confirmation_v1 ORDER BY id').all()).toEqual(before)
    expect([1, 2, 3, 4].map((id) => memory.get(id)?.status)).toEqual(['candidate', 'candidate', 'candidate', 'superseded'])
    expect(memory.get(1)).toMatchObject({ body: '历史原文不能变成确认事实', createdAt: 10, source: { by: 'alice', messageId: 'original-question' }, confirmation: null })
    expect(memory.rules(scope)).toEqual([])
    expect(memory.search(scope, '历史原文').map((n) => n.id)).toEqual([1])
    memory.confirm(2, scope, { by: 'alice', messageId: 'new-confirmation' })
    expect(new ChannelMemory(db).get(2)?.status).toBe('confirmed')
    expect(db.prepare('SELECT * FROM memory_notes_before_confirmation_v1 ORDER BY id').all()).toEqual(before)
  })

  it('does not turn pre-status historical rows into confirmed facts', () => {
    const db = registry().db
    db.exec(`CREATE TABLE memory_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, session_key TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO memory_notes (scope,kind,title,body,created_at) VALUES ('org','qa','Legacy answer','Original content',123)`)
    const memory = new ChannelMemory(db)
    expect(memory.get(1)).toMatchObject({ status: 'candidate', confirmation: null, body: 'Original content', createdAt: 123 })
    expect(db.prepare('SELECT body FROM memory_notes_before_confirmation_v1').get()).toMatchObject({ body: 'Original content' })
  })

  it('does not confirm an unavailable correction or retire the valid rule it would replace', () => {
    const db = registry().db, memory = new ChannelMemory(db)
    const source = (messageId: string): MemorySourceReference => ({ ref: messageId, appId: 'app', tenantId: 'tenant',
      spaceId: 'source-space', chatId: 'source-chat', messageId, readIdentity: { kind: 'user', openId: 'alice' },
      readAt: 1, coverage: 'complete' })
    const original = memory.add({ scope, kind: 'rule', title: '原要求', body: '仍有依据的做法', status: 'confirmed', confirmation: proof,
      provenance: { state: 'verified', originRunId: 'original-run', sources: [source('original')] } })
    const correction = memory.add({ scope, kind: 'rule', title: '候选更正', body: '新材料支持的做法', replaces: original.id,
      provenance: { state: 'verified', originRunId: 'correction-run', sources: [source('original'), source('correction')] } })
    expect(memory.invalidateSources({ kind: 'message', appId: 'app', chatId: 'source-chat', messageId: 'correction' }))
      .toEqual([correction.id])
    const before = db.prepare('SELECT * FROM memory_notes ORDER BY id').all(), changes = memory.changes()
    for (const current of [memory, new ChannelMemory(db)]) {
      expect(current.confirm(correction.id, scope, { by: 'alice', messageId: 'late-confirmation' })).toBe(false)
      expect(current.metadata(original.id, scope)).toMatchObject({ status: 'confirmed', supersededBy: null })
      expect(current.getProvenance(original.id)?.state).toBe('verified')
      expect(current.metadata(correction.id, scope)).toMatchObject({ status: 'candidate' })
      expect(current.getProvenance(correction.id)?.state).toBe('unavailable')
    }
    expect(db.prepare('SELECT * FROM memory_notes ORDER BY id').all()).toEqual(before)
    expect(memory.changes()).toEqual(changes)

    // A newly verified read is a new candidate. Reauthorization/restart cannot
    // silently revive the old draft, and the person's decision applies only here.
    const refreshed = memory.add({ scope, kind: 'rule', title: '重新核验的更正', body: '当前证据支持的做法', replaces: original.id,
      provenance: { state: 'verified', originRunId: 'fresh-authorized-run', sources: [source('original'), source('fresh-correction')] } })
    expect(memory.confirm(refreshed.id, 'space:sp_dm_bob', { by: 'bob', messageId: 'other-space' })).toBe(false)
    expect(memory.confirm(refreshed.id, scope, { by: 'bob', messageId: 'other-user' })).toBe(false)
    expect(memory.confirm(refreshed.id, scope, { by: 'alice', messageId: 'confirm-refreshed' })).toBe(true)
    expect(memory.metadata(original.id, scope)).toMatchObject({ status: 'superseded', supersededBy: refreshed.id })
    expect(memory.metadata(refreshed.id, scope)?.status).toBe('confirmed')
    expect(memory.metadata(correction.id, scope)?.status).toBe('candidate')
    expect(memory.getProvenance(correction.id)?.state).toBe('unavailable')
  })

  it('confirming a corrected fact neither confirms a derived lesson nor creates a global rule', () => {
    const memory = new ChannelMemory(registry().db)
    const fact = memory.add({ scope, kind: 'fact', title: 'Plan 这次不改', body: '本次界面的标签保持原文' })
    const lesson = memory.add({ scope, kind: 'lesson', title: '核对目标页面', body: '有多个同名控件时先核对目标页面' })
    expect(memory.confirm(fact.id, scope, { by: 'alice', messageId: 'confirm-only-fact' })).toBe(true)
    expect(memory.get(lesson.id)).toMatchObject({ status: 'candidate', confirmation: null, scope })
    expect(memory.rules(scope)).toEqual([])
    expect(memory.search('org', '')).toEqual([])
    expect(memory.search('space:sp_dm_bob', '')).toEqual([])
    const context = memory.composeForPrompt(scope, '核对目标页面')
    expect(context.used.notes.find(note => note.id === lesson.id)?.status).toBe('candidate')
    expect(context.text).toContain('自动记录未确认')
    expect(context.text).not.toContain('常驻要求')
  })
})

function apiFixture() {
  const r = registry(), memory = new ChannelMemory(r.db)
  const memoryHost = memoryRuntimeFixture(r, memory)
  memoryHost.pin({ runId: 'memory-test-run', sessionKey: 'session-a', actorOpenId: 'alice' })
  const sp = spaceDeps(r.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  const feishu = asFeishuClient(new FakeFeishu()), cache = new MessageCache(r.db)
  const log = createLogger('memory-confirmation', 'error')
  const state = { stage: 'task' }
  const api = createInternalApi({ registry: r, ...sp, memory, memoryRuntime: memoryHost.runtime, feishu, messageCache: cache, messages: new MessageService(feishu, cache, log), todos: new Todos(r.db), tokens: new TokenIssuer('synthetic'), log, maxHistoryPerCall: 50,
    resolveActorForSession: () => ({ requesterOpenId: 'alice', runId: 'memory-test-run', stage: state.stage }), canPersistDerivedState: () => true })
  const cap: Capability = { runId: 'memory-test-run', sessionKey: 'session-a', spaceId: space.id, chatId: 'chat-a', chatType: 'group', requesterOpenId: 'alice', scopes: [...ALL_SCOPES], exp: 9999999999 }
  const call = (path: string, body: Record<string, unknown>, actor = cap) => api.routes[`POST /v1/memory/${path}`]!(actor, body)
  return { memory, state, cap, call, scope: `space:${space.id}` }
}

describe('model memory tools cannot assert human confirmation', () => {
  it.each(['task', 'reflect'])('keeps claimed confirmed facts as candidates in the %s stage', async (stage) => {
    const t = apiFixture(); t.state.stage = stage
    const result = await t.call('save', { title: '请简短回答', body: '引用用户历史原话', kind: 'rule', certainty: 'confirmed', confirmation: proof })
    expect(result.note).toMatchObject({ status: 'candidate', confirmation: null, source: { generatedBy: 'model', by: 'alice' } })
    expect(t.memory.rules(t.scope)).toEqual([])
  })

  it('allows candidate consolidation but protects confirmed memories from reflection', async () => {
    const t = apiFixture(); t.state.stage = 'reflect'
    const confirmed = t.memory.add({ scope: t.scope, kind: 'fact', title: '已确认', body: '原文', status: 'confirmed', confirmation: proof })
    const candidate = t.memory.add({ scope: t.scope, kind: 'fact', title: '待确认', body: '旧候选' })
    await expect(t.call('forget', { id: confirmed.id })).rejects.toMatchObject({ status: 403 })
    for (const id of [String(confirmed.id), confirmed.id + 0.5, 0]) {
      await expect(t.call('forget', { id })).rejects.toMatchObject({ status: 400 })
    }
    await expect(t.call('save', { title: '变更', body: '自动改写', replaces: confirmed.id })).rejects.toMatchObject({ status: 403 })
    const compactCap = { ...t.cap, memoryWritePolicy: { candidateIds: [candidate.id, confirmed.id] } }
    const merged = await t.call('save', { title: '归纳', body: '新候选', replaces: candidate.id, certainty: 'confirmed' }, compactCap)
    expect(merged.note.status).toBe('candidate')
    expect(t.memory.get(candidate.id)?.status).toBe('superseded')
    expect(t.memory.get(confirmed.id)).toEqual(confirmed)
  })

  it('reports actual candidate status through MCP despite certainty=confirmed', async () => {
    const t = apiFixture()
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => new Response(JSON.stringify(await t.call('save', JSON.parse(String(init.body)))), { status: 200, headers: { 'content-type': 'application/json' } }))
    const server = buildServer({ apiUrl: 'http://memory-fixture.invalid', token: 'fixture' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'memory-fixture', version: '1' })
    await server.connect(serverTransport); await client.connect(clientTransport)
    try {
      const response = await client.callTool({ name: 'friday_memory_save', arguments: { title: 'Original history', body: 'The model says this is confirmed', certainty: 'confirmed' } })
      expect(JSON.stringify(response.content)).toContain('待确认')
      expect(t.memory.recent(t.scope)[0]?.status).toBe('candidate')
    } finally { await client.close(); await server.close() }
  })

  it.each(['candidate', 'confirmed'] as const)('reports the stored replacement result through MCP for an old %s note', async (oldStatus) => {
    const t = apiFixture()
    const original = t.memory.add({ scope: t.scope, kind: 'fact', title: '原记录', body: '原事实' })
    if (oldStatus === 'confirmed') expect(t.memory.confirm(original.id, t.scope, { by: 'alice', messageId: 'original-confirmation' })).toBe(true)
    const before = t.memory.get(original.id)
    let savedResult: Awaited<ReturnType<typeof t.call>> | undefined
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      savedResult = await t.call('save', JSON.parse(String(init.body)))
      return new Response(JSON.stringify(savedResult), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const server = buildServer({ apiUrl: 'http://memory-fixture.invalid', token: 'fixture' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'memory-replacement-fixture', version: '1' })
    await server.connect(serverTransport); await client.connect(clientTransport)
    try {
      const response = await client.callTool({ name: 'friday_memory_save', arguments: {
        title: '更正记录', body: '新事实', certainty: 'confirmed', replaces: original.id,
      } })
      const saved = t.memory.search(t.scope, '更正记录')[0]!
      const receipt = JSON.stringify(response.content)
      expect(saved).toMatchObject({ status: 'candidate', confirmation: null, source: { replaces: original.id } })
      expect(savedResult).toMatchObject({
        replacement: { id: original.id, status: oldStatus === 'confirmed' ? 'pending_confirmation' : 'applied' },
      })
      expect(savedResult?.confirmation_command).toBeUndefined()
      expect(receipt).not.toContain('/memory')
      expect(receipt).toContain('待确认')
      if (oldStatus === 'confirmed') {
        expect(t.memory.get(original.id)).toEqual(before)
        expect(receipt).toContain(`旧记录仍为已确认并继续生效，尚未替换 [memory:${original.id}]`)
        expect(receipt).toContain('已保存更正候选')
        expect(receipt).not.toContain('已被本条替代')
        expect(receipt).not.toContain('已更正')
        // The receipt describes a real next action: only the host-recorded confirmation applies it.
        expect(t.memory.confirm(saved.id, t.scope, { by: 'alice', messageId: 'correction-confirmation' })).toBe(true)
        expect(t.memory.get(original.id)).toMatchObject({ status: 'superseded', supersededBy: saved.id })
        expect(t.memory.get(saved.id)?.status).toBe('confirmed')
      } else {
        expect(t.memory.get(original.id)).toMatchObject({ status: 'superseded', supersededBy: saved.id })
        expect(receipt).toContain(`旧候选已被本条替代；新条目仍待确认 [memory:${original.id}]`)
        expect(receipt).toContain('新条目仍待确认')
        expect(receipt).not.toContain('旧记录仍生效')
      }
    } finally { await client.close(); await server.close() }
  })
})
