import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AxiosError } from 'axios'
import { FeishuMeetings, type MeetingsClient } from '../src/feishu/meetings.js'
import { MeetingSessions, type MeetingSession, type MeetingOrigin } from '../src/core/meeting-sessions.js'
import { MeetingApplication, type MeetingApplicationDeps } from '../src/core/meeting-application.js'
import { meetingSource, verifyMeetingSource, type MeetingSourceReceipt } from '../src/core/meeting-source.js'
import { Registry } from '../src/core/registry.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { Todos } from '../src/core/todos.js'
import { DeliveryService } from '../src/core/delivery.js'
import { withRequestLease } from '../src/core/request-lease.js'
import { spaceDeps } from './helpers/space.js'
import type { MaterialProvenance } from '../src/core/execution-materials.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
type Api = MeetingsClient['vc']['bot']
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-meeting-')), path = join(home, 'db')
  let registry = new Registry(path)
  cleanup.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  const sp = spaceDeps(registry.db), dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'dm-alice', openId: 'alice' })
  const origin: MeetingOrigin = { runId: 'run-a', taskId: 1, workKey: 'work-a', sessionKey: 'session-a', requestMessageId: 'inbound-a',
    spaceId: dm.id, chatId: 'dm-alice', chatType: 'p2p', ownerOpenId: 'alice', reviewChatId: 'dm-alice', reviewSpaceId: dm.id }
  registry.createSession({ sessionKey: 'session-a', chatId: origin.chatId, chatType: 'p2p', cwd: home, requesterOpenId: 'alice' })
  const context: MaterialProvenance = { memoryRefs: [], sources: { version: 1, acpSessionId: 'acp-a', spaceId: dm.id, chatId: 'dm-alice',
    memoryScopes: [dm.id], chats: [], external: [], repositories: [] } }
  const api = { join: vi.fn<Api['join']>().mockResolvedValue({ code: 0, data: { meeting: { id: 'meeting-1', meeting_no: '123456789', topic: 'Synthetic review' }, join_user: { id: 'bot' } } }),
    leave: vi.fn<Api['leave']>().mockResolvedValue({ code: 0, data: { leave_user: { id: 'bot' } } }),
    userActiveMeeting: vi.fn<Api['userActiveMeeting']>().mockResolvedValue({ code: 0, data: { meetings: [] } }),
    events: vi.fn<Api['events']>().mockResolvedValue({ code: 0, data: { events: [], has_more: false } }) }
  let sessions = new MeetingSessions(registry.db), todos = new Todos(registry.db), calls = new RunApiCalls(registry.db)
  const state = { current: true, authorized: true, sources: true, sourceVersion: 1, fullReview: true, failSecondAction: false }
  const sources: MeetingSourceReceipt[] = [], sent: { chatId: string; payload: unknown }[] = [], queued: string[] = []
  const sourceGuard = () => { if (!state.sources) throw new Error('source revoked') }
  const dependencies = (): MeetingApplicationDeps => ({ sessions, calls, provider: new FeishuMeetings({ vc: { bot: api } }),
    resolveRun: ref => {
      if (ref.runId !== origin.runId || ref.sessionKey !== origin.sessionKey) throw new Error('wrong run')
      return { origin: structuredClone(origin), provenance: structuredClone(context), assertCurrent: () => { if (!state.current) throw new Error('run stopped') } }
    },
    authorizeAction: async (_run, operation, meetingNumber) => {
      if (!state.authorized) throw new Error('human authority required')
      return { key: `${operation}:${origin.requestMessageId}`, operation, actorOpenId: origin.ownerOpenId, messageId: origin.requestMessageId, meetingNumber }
    },
    authorizeSession: async () => {
      const version = state.sourceVersion; sourceGuard()
      return { assertCurrent() { sourceGuard(); if (version !== state.sourceVersion) throw new Error('source version changed') } }
    },
    recordSource: (_ref, source) => sources.push(source),
    queueDraft: (_session, key) => { if (!queued.includes(key)) queued.push(key) },
    deliverDraft: async (_ref, session, draft, guard) => {
      const service = new DeliveryService(registry.db, { ...sp,
        resolveContext: async () => { guard(); return { actorOpenId: 'alice', provenanceComplete: true, expiresAt: Date.now() + 60_000,
          sources: [{ ref: draft.digest, spaceId: session.origin.reviewSpaceId, chatId: session.origin.reviewChatId }],
          audience: { kind: 'dm', spaceId: session.origin.reviewSpaceId, chatId: session.origin.reviewChatId, openId: session.origin.ownerOpenId }, isCurrent: () => { guard(); return true } } },
        send: async ({ payload }) => { guard(); sent.push({ chatId: session.origin.reviewChatId, payload }); return { remoteId: `outgoing-${sent.length}` } },
      })
      await service.deliver({ key: `draft:${draft.id}:text`, contextRef: draft.id, payload: { text: draft.summary + JSON.stringify(draft.actions) } })
      if (!state.fullReview) return { complete: false }
      const result = await service.deliver({ key: `draft:${draft.id}:card`, contextRef: draft.id,
        payload: { card: { header: { title: { tag: 'plain_text', content: 'Confirm synthetic minutes' } }, elements: [] } } })
      return { complete: result.status === 'sent', cardMessageId: result.remoteId ?? undefined }
    },
    commitActions: (draft, session, source) => draft.actions.map((action, i) => {
      if (state.failSecondAction && i === 1) throw new Error('synthetic second action failed')
      expect(source.eventsDigest).toBe(session.eventsDigest)
      return todos.add({ scope: session.origin.reviewSpaceId, title: action.title, detail: action.detail, owner: action.owner,
        ownerOpenId: action.ownerOpenId, dueMs: action.dueMs, sessionKey: origin.sessionKey, confirmed: true, createdBy: session.origin.ownerOpenId,
        source: '会后本人确认 · Synthetic review' }).id
    }),
  })
  let app = new MeetingApplication(dependencies())
  const ref = { sessionKey: origin.sessionKey, runId: origin.runId }
  const end = () => api.events.mockResolvedValue({ code: 0, data: { has_more: false, events: [
    { event_id: 'joined', event_type: 'participant_joined', payload: { participant_joined_items: [{ participant: { id: 'bot' } }] } },
    { event_id: 'speech', event_type: 'transcript_received', payload: { transcript_received_items: [{ speaker: { id: 'alice', user_name: 'Alice' }, text: 'Synthetic follow-up requested.' }] } },
    { event_id: 'ended', event_type: 'participant_left', payload: { participant_left_items: [{ participant: { id: 'bot' }, leave_reason: 2 }] } },
  ] } })
  return { get registry() { return registry }, get sessions() { return sessions }, get todos() { return todos }, get calls() { return calls },
    get app() { return app }, ref, origin, state, api, sources, sent, queued, end,
    reopen() { registry.close(); registry = new Registry(path); sessions = new MeetingSessions(registry.db); todos = new Todos(registry.db); calls = new RunApiCalls(registry.db); app = new MeetingApplication(dependencies()) },
  }
}
async function ended(t: ReturnType<typeof fixture>) {
  const joined = await t.app.join(t.ref, { meetingNumber: '123456789' }); t.end(); await t.app.sync(t.ref, { sessionId: joined.sessionId }); return joined.sessionId
}
async function draft(t: ReturnType<typeof fixture>, sessionId: string, actions = [{ title: 'Follow up synthetic issue' }]) {
  return t.app.proposeDraft(t.ref, { sessionId, summary: 'Synthetic meeting summary with actual event coverage.', actions })
}
function decision(t: ReturnType<typeof fixture>, draftId: string) {
  const d = t.sessions.draft(draftId)!
  return { draftId, digest: d.digest, decision: 'accept' as const, operatorOpenId: 'alice', chatId: 'dm-alice', messageId: d.reviewMessageId! }
}

describe('real meeting application, SDK port, SQLite state, Delivery and Todo boundaries', () => {
  it('retains definite refusal and permits only a new approved request after fixing platform conditions', async () => {
    const t = fixture()
    t.api.join.mockResolvedValueOnce({ code: 99991672 })
    await expect(t.app.join(t.ref, { meetingNumber: '123456789' })).rejects.toMatchObject({ reason: 'configuration' })
    const rejected = t.sessions.list()[0]!
    expect(rejected.state).toBe('join_rejected'); expect(rejected.rejections).toHaveLength(1)
    expect((await t.app.join(t.ref, { meetingNumber: '123456789' })).state).toBe('join_rejected')
    expect(t.api.join).toHaveBeenCalledTimes(1)
    t.origin.requestMessageId = 'new-request-after-fix'
    const fresh = await t.app.join(t.ref, { meetingNumber: '123456789' })
    expect(fresh.sessionId).not.toBe(rejected.id); expect(fresh.state).toBe('awaiting_admission')
    expect(t.sessions.get(rejected.id)?.state).toBe('join_rejected')
    t.api.leave.mockResolvedValueOnce({ code: 121003 })
    await expect(t.app.leave(t.ref, { sessionId: fresh.sessionId })).rejects.toMatchObject({ reason: 'conditions' })
    expect((await t.app.leave(t.ref, { sessionId: fresh.sessionId })).state).toBe('leave_rejected')
    expect(t.api.leave).toHaveBeenCalledTimes(1)
    t.origin.requestMessageId = 'new-leave-after-fix'
    expect((await t.app.leave(t.ref, { sessionId: fresh.sessionId })).state).toBe('left')
    expect(t.sessions.get(fresh.sessionId)?.rejections).toEqual([expect.objectContaining({ operation: 'leave', code: 121003 })])
  })
  it('needs human authority, distinguishes request ACK from participation, and exposes no pre-meeting context to VC', async () => {
    const t = fixture(); t.state.authorized = false
    await expect(t.app.join(t.ref, { meetingNumber: '123456789' })).rejects.toThrow('human authority required')
    expect(t.api.join).not.toHaveBeenCalled(); expect(t.sessions.list()).toEqual([])
    t.state.authorized = true
    const joined = await t.app.join(t.ref, { meetingNumber: '123456789' })
    expect(joined).toMatchObject({ state: 'awaiting_admission', coverage: { confirmedParticipation: false } })
    expect(t.calls.forRun('run-a')).toEqual([expect.objectContaining({ route: 'HOST /meetings/join', state: 'returned' })])
    await expect(t.app.read(t.ref, { sessionId: joined.sessionId })).rejects.toMatchObject({ code: 'denied' })
    await t.app.sync(t.ref, { sessionId: joined.sessionId })
    expect(t.sessions.get(joined.sessionId)?.state).toBe('awaiting_admission')
    await t.app.join(t.ref, { meetingNumber: '123456789' }); expect(t.api.join).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(t.api.join.mock.calls)).not.toContain('memoryScopes')
  })

  it('uses the full real flow: join, ended events, owner-only source read, full review, then one atomic Todo confirmation', async () => {
    const t = fixture(), sessionId = await ended(t)
    const read = await t.app.read(t.ref, { sessionId, limit: 1 })
    expect(read).toMatchObject({ state: 'ended', total: 3, nextOffset: 1 })
    expect(t.sources[0]?.eventsDigest).toBe(t.sessions.get(sessionId)?.eventsDigest)
    const proposed = await draft(t, sessionId)
    expect(t.todos.list(t.origin.reviewSpaceId, { status: 'all' })).toEqual([])
    expect(t.sent).toHaveLength(2); expect(t.sent.every(item => item.chatId === 'dm-alice')).toBe(true)
    const accepted = await t.app.decideDraft(decision(t, proposed.draftId), () => {})
    expect(accepted.state).toBe('accepted'); expect(accepted.todoIds).toHaveLength(1)
    expect(await t.app.decideDraft(decision(t, proposed.draftId), () => {})).toEqual(accepted)
    expect(t.todos.list(t.origin.reviewSpaceId, { status: 'all' })).toHaveLength(1)
    expect(t.queued).toHaveLength(1)
    await t.app.refresh(sessionId, () => {}); expect(t.queued).toHaveLength(1)
  })

  it('never retries unknown join after restart; platform absence is not success or failure, positive active presence can reconcile', async () => {
    const t = fixture()
    t.api.join.mockRejectedValueOnce(new AxiosError('lost ACK', 'ETIMEDOUT'))
    await expect(t.app.join(t.ref, { meetingNumber: '123456789' })).rejects.toMatchObject({ reason: 'transport' })
    const original = t.sessions.list()[0]!
    expect(original.state).toBe('join_unknown')
    t.reopen()
    await t.app.join(t.ref, { meetingNumber: '123456789' }); expect(t.api.join).toHaveBeenCalledTimes(1)
    await t.app.refresh(original.id, () => {}); expect(t.sessions.get(original.id)?.state).toBe('join_unknown')
    t.api.userActiveMeeting.mockResolvedValueOnce({ code: 0, data: { meetings: [{ meeting_id: 'meeting-1', meeting_no: '123456789' }] } })
    await t.app.refresh(original.id, () => {})
    expect(t.sessions.get(original.id)).toMatchObject({ state: 'attending', meetingId: 'meeting-1' })
    expect(t.calls.forRun('run-a')[0]?.state).toBe('failed')
  })

  it('keeps a late join ACK durable when HTTP cancellation ends the caller and makes lifecycle recovery independent of that Run', async () => {
    const t = fixture(), entered = deferred(), release = deferred(), request = new AbortController()
    t.api.join.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { code: 0, data: { meeting: { id: 'meeting-1' }, join_user: { id: 'bot' } } } })
    const pending = withRequestLease(request.signal, () => t.app.join(t.ref, { meetingNumber: '123456789' }))
    const rejected = expect(pending).rejects.toThrow('本次工具请求已结束')
    await entered.promise; request.abort(); release.resolve(); await rejected
    const session = t.sessions.list()[0]!
    expect(session).toMatchObject({ meetingId: 'meeting-1', state: 'awaiting_admission' })
    expect(t.calls.forRun('run-a')[0]?.state).toBe('returned')
    t.state.current = false; t.end(); await t.app.refresh(session.id, () => {})
    expect(t.sessions.get(session.id)?.state).toBe('ended'); expect(t.queued).toHaveLength(1)
  })

  it('rejects source/participation revocation during provider await before ingesting contents or scheduling any draft', async () => {
    const t = fixture(), joined = await t.app.join(t.ref, { meetingNumber: '123456789' }), entered = deferred(), release = deferred()
    t.api.events.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { code: 0, data: { has_more: false, events: [{ event_id: 'private', event_type: 'transcript_received', payload: { transcript_received_items: [{ text: 'PRIVATE_CANARY' }] } }] } } })
    const pending = expect(t.app.sync(t.ref, { sessionId: joined.sessionId })).rejects.toMatchObject({ code: 'changed' })
    await entered.promise; t.sessions.revoke(joined.sessionId); release.resolve(); await pending
    expect(t.sessions.get(joined.sessionId)?.events).toEqual([]); expect(t.queued).toEqual([]); expect(t.sent).toEqual([])
  })

  it('recovers the exact persistent cursor and refuses partial pagination as a complete source', async () => {
    const t = fixture(), joined = await t.app.join(t.ref, { meetingNumber: '123456789' })
    t.api.userActiveMeeting.mockResolvedValue({ code: 0, data: { meetings: [{ meeting_id: 'meeting-1', meeting_no: '123456789' }] } })
    let page = 0
    t.api.events.mockImplementation(async () => ({ code: 0, data: { has_more: true, page_token: `page-${++page}`, events: [] } }))
    await t.app.sync(t.ref, { sessionId: joined.sessionId })
    expect(t.sessions.get(joined.sessionId)).toMatchObject({ pageToken: 'page-10', coverageComplete: false })
    await expect(t.app.read(t.ref, { sessionId: joined.sessionId })).rejects.toMatchObject({ code: 'denied' })
    t.reopen(); t.end(); await t.app.refresh(joined.sessionId, () => {})
    expect(t.api.events.mock.calls.at(-1)?.[0]?.params.page_token).toBe('page-10')
    expect(t.sessions.get(joined.sessionId)).toMatchObject({ coverageComplete: true, state: 'ended' })
  })

  it('keeps draft approval bound to owner, DM, card, exact source snapshot and full delivered text', async () => {
    const t = fixture(), sessionId = await ended(t); t.state.fullReview = false
    const partial = await draft(t, sessionId)
    await expect(t.app.decideDraft({ ...decision(t, partial.draftId), messageId: 'fake-card' }, () => {})).rejects.toMatchObject({ code: 'denied' })
    t.state.fullReview = true; const proposed = await draft(t, sessionId)
    for (const change of [{ operatorOpenId: 'mallory' }, { chatId: 'group-a' }, { messageId: 'old-card' }, { digest: 'f'.repeat(64) }]) {
      await expect(t.app.decideDraft({ ...decision(t, proposed.draftId), ...change }, () => {})).rejects.toMatchObject({ code: 'denied' })
    }
    const source = meetingSource(t.sessions.get(sessionId)!)
    expect(verifyMeetingSource(t.sessions, source, { openId: 'alice', spaceId: t.origin.spaceId, chatId: t.origin.chatId, chatType: 'group' })).toBe(false)
    t.state.sources = false
    await expect(t.app.decideDraft(decision(t, proposed.draftId), () => {})).rejects.toThrow('source revoked')
    expect(t.todos.list(t.origin.reviewSpaceId, { status: 'all' })).toEqual([])
  })

  it('rolls back all Todo writes and leaves the draft pending if a later action cannot commit', async () => {
    const t = fixture(), sessionId = await ended(t), proposed = await draft(t, sessionId, [{ title: 'First action' }, { title: 'Second action' }])
    t.state.failSecondAction = true
    await expect(t.app.decideDraft(decision(t, proposed.draftId), () => {})).rejects.toThrow('synthetic second action failed')
    expect(t.todos.list(t.origin.reviewSpaceId, { status: 'all' })).toEqual([])
    expect(t.sessions.draft(proposed.draftId)?.state).toBe('pending')
    t.state.failSecondAction = false
    expect((await t.app.decideDraft(decision(t, proposed.draftId), () => {})).todoIds).toHaveLength(2)
  })

  it('a revised full draft supersedes the old card without duplicating already accepted actions', async () => {
    const t = fixture(), sessionId = await ended(t), old = await draft(t, sessionId)
    const revised = await t.app.proposeDraft(t.ref, { sessionId, summary: 'Corrected summary', actions: [{ title: 'Corrected action' }] })
    await expect(t.app.decideDraft(decision(t, old.draftId), () => {})).rejects.toMatchObject({ code: 'changed' })
    const accepted = await t.app.decideDraft(decision(t, revised.draftId), () => {})
    expect(accepted.todoIds).toHaveLength(1)
    await expect(t.app.proposeDraft(t.ref, { sessionId, summary: 'Another wording', actions: [{ title: 'Corrected action' }] })).rejects.toMatchObject({ code: 'changed' })
    expect(t.todos.list(t.origin.reviewSpaceId, { status: 'all' }).map(todo => todo.title)).toEqual(['Corrected action'])
  })

  it('a late leave failure never overwrites a separately verified meeting-ended fact', async () => {
    const t = fixture(), joined = await t.app.join(t.ref, { meetingNumber: '123456789' }), entered = deferred(), release = deferred()
    t.api.leave.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new AxiosError('lost ACK', 'ETIMEDOUT') })
    const pending = expect(t.app.leave(t.ref, { sessionId: joined.sessionId })).rejects.toMatchObject({ reason: 'transport' })
    await entered.promise; t.end(); await t.app.refresh(joined.sessionId, () => {}); release.resolve(); await pending
    expect(t.sessions.get(joined.sessionId)?.state).toBe('ended')
    expect(t.calls.forRun('run-a').map(call => call.state)).toEqual(['returned', 'failed'])
  })

  it('never replays an unknown leave or interprets directory absence as a confirmed departure', async () => {
    const t = fixture(), joined = await t.app.join(t.ref, { meetingNumber: '123456789' })
    t.api.leave.mockRejectedValueOnce(new AxiosError('lost leave ACK', 'ETIMEDOUT'))
    await expect(t.app.leave(t.ref, { sessionId: joined.sessionId })).rejects.toMatchObject({ reason: 'transport' })
    t.reopen(); await t.app.leave(t.ref, { sessionId: joined.sessionId }); await t.app.sync(t.ref, { sessionId: joined.sessionId })
    expect(t.api.leave).toHaveBeenCalledTimes(1); expect(t.sessions.get(joined.sessionId)?.state).toBe('leave_unknown')
    t.api.events.mockResolvedValueOnce({ code: 0, data: { has_more: false, events: [{ event_id: 'bot-left', event_type: 'participant_left', payload: { participant_left_items: [{ participant: { id: 'bot' }, leave_reason: 1 }] } }] } })
    await t.app.sync(t.ref, { sessionId: joined.sessionId }); expect(t.sessions.get(joined.sessionId)?.state).toBe('left')
  })
})
