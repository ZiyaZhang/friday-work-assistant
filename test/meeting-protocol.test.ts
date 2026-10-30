import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { meetingRuntimeFixture } from './helpers/meeting-runtime.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { asFeishuClient } from './helpers/fake-feishu.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'
import { MeetingProviderError } from '../src/feishu/meetings.js'
import { spaceScope } from '../src/core/space.js'
import type { MeetingApplication } from '../src/core/meeting-application.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const t = meetingRuntimeFixture(), memory = new ChannelMemory(t.registry.db), memoryHost = memoryRuntimeFixture(t.registry, memory)
  const feishu = asFeishuClient(t.fake), cache = new MessageCache(t.registry.db), log = createLogger('meeting-protocol', 'error')
  const tokens = new TokenIssuer('synthetic-meeting-protocol-only'), actor = { requesterOpenId: 'alice', runId: t.run.id, stage: 'task', taskId: t.task.id }
  const deps: InternalApiDeps & { meetings: MeetingApplication } = { registry: t.registry, memory, memoryRuntime: memoryHost.runtime,
    ...t.sp, feishu, messageCache: cache, messages: new MessageService(feishu, cache, log), todos: t.todos, tokens, log, maxHistoryPerCall: 10,
    meetings: t.runtime.application, meetingsEnabled: true, resolveActorForSession: () => actor, canPersistDerivedState: () => true }
  const api = createInternalApi(deps)
  await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>(done => api.server.close(() => done())) })
  let cap: Capability = { sessionKey: t.ref.sessionKey, runId: t.run.id, requesterOpenId: 'alice', chatId: t.dm.chatId!, chatType: 'p2p',
    spaceId: t.dm.id, cwd: t.home, scopes: [...ALL_SCOPES], exp: 9999999999 }
  const post = (path: string, body: Record<string, unknown>, override: Partial<Capability> = {}) => fetch(`${base}/v1/meetings/${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${tokens.issue({ ...cap, ...override })}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const connect = async () => {
    const server = buildServer({ apiUrl: base, token: tokens.issue(cap) }), client = new Client({ name: 'meeting-protocol', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    cleanups.push(async () => { await client.close(); await server.close() })
    return client
  }
  let client = await connect()
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return JSON.parse((result.content as { type: string; text: string }[])[0]!.text)
  }
  const startEvent = async (taskId: number) => { const run = t.startEvent(taskId); actor.runId = run.id; actor.taskId = taskId;
    cap = { ...cap, sessionKey: run.sessionKey, runId: run.id }; client = await connect(); return run }
  return { ...t, api, actor, call, get client() { return client }, post, startEvent }
}

describe('meeting tools through actual MCP and signed host API', () => {
  it('runs approval→platform join→read→full Delivery→owner decision through real stores', async () => {
    const t = await fixture()
    expect((await t.call('friday_list_meetings')).meetings).toEqual([])
    const joined = await t.call('friday_join_meeting', { meetingNumber: '123456789' })
    expect(joined).toMatchObject({ state: 'awaiting_admission', coverage: { confirmedParticipation: false } })
    expect((await t.call('friday_sync_meeting', { sessionId: joined.sessionId })).state).toBe('ended')
    const event = t.queueDraft.mock.results[0]!.value
    const followup = await t.startEvent(event.task.id)
    expect(followup.workKey).toBe(t.run.workKey)
    expect(t.registry.dispatches.get(event.task.id)?.inbound.senderType).toBe('bot')
    const first = await t.call('friday_read_meeting', { sessionId: joined.sessionId, limit: 1 })
    expect(first).toMatchObject({ total: 2, nextOffset: 1 })
    const second = await t.call('friday_read_meeting', { sessionId: joined.sessionId, offset: first.nextOffset })
    expect(second.nextOffset).toBeNull()
    const result = await t.call('friday_propose_meeting_draft', { sessionId: joined.sessionId, summary: 'Synthetic verified meeting facts.', actions: [{ title: 'Follow up the synthetic issue' }] })
    expect(result.reviewDelivered).toBe(true)
    expect(t.todos.list(spaceScope(t.dm.id))).toEqual([])
    const draft = t.sessions.draft(result.draftId)!
    await t.runtime.application.decideDraft({ draftId: draft.id, digest: draft.digest, decision: 'accept', operatorOpenId: 'alice', chatId: t.dm.chatId!, messageId: draft.reviewMessageId! }, () => {})
    expect(t.todos.list(spaceScope(t.dm.id))).toHaveLength(1)
    expect(t.calls.forRun(t.run.id).map(value => value.route)).toContain('HOST /meetings/join')
    expect(t.fake.sent.every(value => value.target === 'alice')).toBe(true)
    expect(JSON.stringify([joined, first, second, result])).not.toContain('memoryScopes')
    expect((await t.post('draft/decide', { draftId: draft.id, digest: draft.digest, decision: 'accept' })).status).toBe(404)
  })

  it('requires signed current task scopes and cannot accept model-supplied authority, target or source', async () => {
    const t = await fixture()
    expect((await t.post('join', { meetingNumber: '123456789' }, { scopes: [] })).status).toBe(403)
    expect((await t.post('join', { meetingNumber: '123456789' }, { runId: 'stale' })).status).toBe(403)
    for (const key of ['actorOpenId', 'approved', 'provenance', 'reviewChatId', 'password']) {
      expect((await t.post('join', { meetingNumber: '123456789', [key]: 'forged' })).status).toBe(400)
    }
    t.actor.stage = 'reflect'
    expect((await t.post('list', {})).status).toBe(403)
    expect(t.provider.join).not.toHaveBeenCalled()
  })

  it('returns actual application/gray-release failures without pretending participation or asking for personal OAuth', async () => {
    const t = await fixture()
    t.provider.join.mockRejectedValue(new MeetingProviderError('configuration', 99991672))
    const result = await t.client.callTool({ name: 'friday_join_meeting', arguments: { meetingNumber: '123456789' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('灰度')
    expect(t.sessions.list()[0]?.state).toBe('join_rejected')
    expect(t.sessions.list()[0]?.confirmedAt).toBeUndefined()
    expect(t.fake.sent).toEqual([])
    const replay = await t.call('friday_join_meeting', { meetingNumber: '123456789' })
    expect(replay.state).toBe('join_rejected'); expect(t.provider.join).toHaveBeenCalledTimes(1)
  })
})
