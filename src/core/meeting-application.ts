import { MEETING_SCOPE, MeetingProviderError, type FeishuMeetings } from '../feishu/meetings.js'
import type { MaterialProvenance } from './execution-materials.js'
import { assertRequestCurrent } from './request-lease.js'
import type { RunApiCalls } from './run-api-calls.js'
import { meetingSource, verifyMeetingSource, type MeetingSourceReceipt } from './meeting-source.js'
import { MeetingStateError, type MeetingSessions, type MeetingSession, type MeetingOrigin, type MeetingActionAuthority,
  type MeetingActionItem, type MeetingDraft } from './meeting-sessions.js'

export interface MeetingRunRef { sessionKey: string; runId: string }
export interface MeetingRunContext {
  origin: MeetingOrigin; provenance: MaterialProvenance; assertCurrent(): void
}
export interface MeetingLease { assertCurrent(): void }
export interface MeetingContextHints {
  request: { text: string; messageId: string; chatId: string; createTimeMs?: number; linkStatus: 'not_resolved' }
  references: { kind: 'conversation' | 'message' | 'document' | 'calendar' | 'web' | 'minutes' | 'gmail' | 'mcp' | 'repository' | 'memory' | 'meeting'; ref: string }[]
  notice: string
}
export interface MeetingApplicationDeps {
  sessions: MeetingSessions
  provider: Pick<FeishuMeetings, 'join' | 'leave' | 'activeForUser' | 'events'>
  calls: Pick<RunApiCalls, 'capture'>
  resolveRun(ref: MeetingRunRef): MeetingRunContext
  /** Must authorize the actual human request/approval and exact meeting number.
   * A model tool argument or a bare meeting number is not this authority. */
  authorizeAction(run: MeetingRunContext, operation: 'join' | 'leave', meetingNumber: string): Promise<MeetingActionAuthority>
  /** Current owner/space and all saved pre-meeting sources. Missing proof fails closed.
   * This also supplies the lifecycle worker's lease independently of the initiating Run. */
  authorizeSession(session: MeetingSession): Promise<MeetingLease>
  /** Runtime revalidates all inputs actually consumed while composing this reviewed draft. */
  authorizeDraft?(draft: MeetingDraft, session: MeetingSession): Promise<MeetingLease>
  recordSource(ref: MeetingRunRef, source: MeetingSourceReceipt): void
  contextHints?(session: MeetingSession): MeetingContextHints
  /** Uses DeliveryService: all full text parts ACK before the final digest-bound confirmation card. */
  deliverDraft(ref: MeetingRunRef, session: MeetingSession, draft: MeetingDraft, guard: () => void): Promise<{ complete: boolean; cardMessageId?: string }>
  /** Synchronous writes to the existing Todos/Work in the same SQLite transaction as acceptance.
   * Callback must retain the exact host provenance; it never announces other people's agreement. */
  commitActions(draft: MeetingDraft, session: MeetingSession, source: MeetingSourceReceipt): number[]
  /** Durable, idempotent Work admission after an observed end; never a detached raw model call. */
  queueDraft(session: MeetingSession, key: string): void
}

export function publicMeeting(session: MeetingSession) {
  return { sessionId: session.id, state: session.state, mode: 'silent' as const, enabled: session.enabled,
    coverage: { complete: session.coverageComplete, eventCount: session.events.length, confirmedParticipation: Boolean(session.confirmedAt) },
    ...(session.lastFailure ? { failure: session.lastFailure } : {}),
    notice: session.state === 'awaiting_admission' ? '平台已接受入会请求，仍待核验实际参会；可能需要主持人放行。'
      : session.state === 'join_rejected' || session.state === 'leave_rejected' ? '平台明确拒绝了这次请求，没有假定动作成功；修正应用配置或入会条件后，可由你重新发起。'
      : session.state === 'join_unknown' || session.state === 'leave_unknown' ? '原操作结果待核对，没有重复发起。'
      : session.state === 'attending' ? '已有真实参会证据，静默读取可取得的会议事件；没有开启录制或麦克风。'
      : ['left', 'ended'].includes(session.state) ? '已取得离会或结束证据，会议内容仍按实际覆盖范围生成本人待审稿。' : '会议操作处理中。' }
}

export class MeetingApplication {
  constructor(private readonly deps: MeetingApplicationDeps) {}

  list(ref: MeetingRunRef) {
    const run = this.run(ref)
    return { meetings: this.deps.sessions.list(run.origin.ownerOpenId).filter(session => session.enabled).map(publicMeeting) }
  }

  async join(ref: MeetingRunRef, input: { meetingNumber: string }) {
    const run = this.run(ref), authority = await this.deps.authorizeAction(run, 'join', input.meetingNumber)
    this.current(run)
    const { session, started } = this.deps.sessions.begin(run.origin, input.meetingNumber, run.provenance, authority)
    if (!started) return publicMeeting(session)
    try {
      const receipt = await this.deps.calls.capture(run.origin.runId, 'HOST /meetings/join', [MEETING_SCOPE],
        () => this.deps.provider.join(session.meetingNumber, () => this.current(run)))
      this.deps.sessions.joined(session.id, receipt) // Persist ACK before checking a cancelled caller.
    } catch (error) {
      this.failed(session.id, 'join', error); throw error
    }
    this.current(run)
    return publicMeeting(this.deps.sessions.get(session.id)!)
  }

  async leave(ref: MeetingRunRef, input: { sessionId: string }) {
    const run = this.run(ref), before = this.owned(run, input.sessionId)
    const authority = await this.deps.authorizeAction(run, 'leave', before.meetingNumber)
    this.current(run); this.owned(run, before.id)
    const { session, started } = this.deps.sessions.beginLeave(before.id, before.version, authority)
    if (!started) return publicMeeting(session)
    try {
      const receipt = await this.deps.calls.capture(run.origin.runId, 'HOST /meetings/leave', [MEETING_SCOPE],
        () => this.deps.provider.leave(session.meetingId!, () => this.current(run)))
      this.deps.sessions.left(session.id, receipt.participantId)
    } catch (error) {
      this.failed(session.id, 'leave', error); throw error
    }
    this.current(run)
    return publicMeeting(this.deps.sessions.get(session.id)!)
  }

  async sync(ref: MeetingRunRef, input: { sessionId: string }) {
    const run = this.run(ref), before = this.owned(run, input.sessionId)
    const result = await this.refresh(before.id, () => this.current(run))
    this.current(run)
    return publicMeeting(result)
  }

  /** Existing lifecycle owner awaits this Promise; restarts resume retained cursor and never join again. */
  async refresh(sessionId: string, assertCurrent: () => void): Promise<MeetingSession> {
    const before = this.session(sessionId), version = before.version
    const lease = await this.deps.authorizeSession(before)
    const check = () => { assertRequestCurrent(); assertCurrent(); lease.assertCurrent(); this.deps.sessions.assert(this.session(sessionId), version) }
    check()
    let current = this.session(sessionId)
    if (current.state === 'join_rejected') return current
    if (current.confirmedAt && current.coverageComplete && ['left', 'ended'].includes(current.state)) {
      this.deps.queueDraft(current, `meeting-draft:${current.id}:${current.revision}:${current.eventsDigest}`)
      return current
    }
    if (['joining', 'join_unknown', 'awaiting_admission', 'leave_unknown', 'leaving'].includes(current.state)) {
      const active = await this.deps.provider.activeForUser(current.origin.ownerOpenId, check)
      check(); current = this.deps.sessions.reconcileActive(sessionId, version, active)
    }
    if (!current.meetingId) return current
    // Bound one poll; retain nextPageToken and incomplete coverage for the next lifecycle tick.
    for (let pages = 0; pages < 10; pages++) {
      check(); current = this.session(sessionId)
      const page = await this.deps.provider.events(current.meetingId!, { pageToken: current.pageToken, assertCurrent: check })
      check(); current = this.deps.sessions.append(sessionId, version, page, current.pageToken)
      if (!page.hasMore) break
    }
    check()
    if (current.confirmedAt && current.coverageComplete && ['left', 'ended'].includes(current.state)) {
      this.deps.queueDraft(current, `meeting-draft:${current.id}:${current.revision}:${current.eventsDigest}`)
    }
    return current
  }

  async read(ref: MeetingRunRef, input: { sessionId: string; offset?: number; limit?: number }) {
    const run = this.run(ref), session = this.owned(run, input.sessionId), source = meetingSource(session)
    const lease = await this.deps.authorizeSession(session)
    const check = () => { this.current(run); lease.assertCurrent(); this.sourceCurrent(run, source) }
    check()
    const offset = input.offset ?? 0, limit = input.limit ?? 100
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MeetingStateError('invalid')
    this.deps.recordSource(ref, source); check()
    const contextHints = this.deps.contextHints?.(session)
    check()
    // Speaker IDs are provider correlation, not user-facing names or assigned action owners.
    return { ...publicMeeting(session), title: session.title, revision: session.revision, eventsDigest: session.eventsDigest, contextHints,
      events: session.events.slice(offset, offset + limit), offset, total: session.events.length,
      nextOffset: offset + limit < session.events.length ? offset + limit : null }
  }

  async proposeDraft(ref: MeetingRunRef, input: { sessionId: string; summary: string; actions: MeetingActionItem[] }) {
    const run = this.run(ref), session = this.owned(run, input.sessionId), source = meetingSource(session)
    const lease = await this.deps.authorizeSession(session)
    const check = () => { this.current(run); lease.assertCurrent(); this.sourceCurrent(run, source) }
    check(); this.deps.recordSource(ref, source); check()
    const draft = this.deps.sessions.propose(session.id, session.version, input.summary, input.actions)
    if (draft.state !== 'pending') return { draftId: draft.id, state: draft.state, digest: draft.digest, todoIds: draft.todoIds }
    const delivered = await this.deps.deliverDraft(ref, session, draft, check)
    // ACK is a fact even if cancellation happened after send.
    if (delivered.complete && delivered.cardMessageId) this.deps.sessions.reviewDelivered(draft.id, draft.digest, delivered.cardMessageId)
    check()
    return { draftId: draft.id, state: draft.state, digest: draft.digest, reviewDelivered: delivered.complete && Boolean(delivered.cardMessageId) }
  }

  async decideDraft(input: { draftId: string; digest: string; decision: 'accept' | 'reject'; operatorOpenId: string; chatId: string; messageId: string }, assertCurrent: () => void) {
    const draft = this.deps.sessions.draft(input.draftId), session = draft && this.session(draft.sessionId)
    if (!draft || !session) throw new MeetingStateError('not_found')
    const source = meetingSource(session)
    const checkActor = () => {
      assertRequestCurrent(); assertCurrent()
      const latest = this.session(session.id), actual = this.deps.sessions.draft(draft.id)
      if (input.operatorOpenId !== latest.origin.ownerOpenId || input.chatId !== latest.origin.reviewChatId ||
        input.messageId !== actual?.reviewMessageId || input.digest !== actual?.digest) throw new MeetingStateError('denied')
      if (!verifyMeetingSource(this.deps.sessions, source, { openId: input.operatorOpenId, spaceId: latest.origin.reviewSpaceId, chatId: input.chatId, chatType: 'p2p' })) throw new MeetingStateError('changed')
    }
    checkActor()
    const lease = await this.deps.authorizeSession(session)
    const check = () => { checkActor(); lease.assertCurrent() }
    check()
    const draftLease = await this.deps.authorizeDraft?.(draft, session)
    const checkAll = () => { check(); draftLease?.assertCurrent() }
    checkAll()
    const decided = this.deps.sessions.decide(draft.id, input.digest, input.decision,
      (current, value) => this.deps.commitActions(current, value, source), checkAll)
    return { draftId: decided.id, state: decided.state, todoIds: decided.todoIds }
  }

  private run(ref: MeetingRunRef): MeetingRunContext { const run = this.deps.resolveRun(ref); this.current(run); return run }
  private current(run: MeetingRunContext): void { assertRequestCurrent(); run.assertCurrent() }
  private session(id: string): MeetingSession { const value = this.deps.sessions.get(id); if (!value) throw new MeetingStateError('not_found'); return value }
  private owned(run: MeetingRunContext, id: string): MeetingSession {
    this.current(run); const value = this.session(id)
    if (!value.enabled || value.origin.ownerOpenId !== run.origin.ownerOpenId) throw new MeetingStateError('denied')
    return value
  }
  private sourceCurrent(run: MeetingRunContext, source: MeetingSourceReceipt): void {
    if (!verifyMeetingSource(this.deps.sessions, source, { openId: run.origin.ownerOpenId, spaceId: run.origin.spaceId, chatId: run.origin.chatId, chatType: run.origin.chatType })) throw new MeetingStateError('denied')
  }
  private failure(error: unknown): { reason?: string; code?: number } {
    const value = error as { reason?: unknown; code?: unknown }
    return { ...(typeof value?.reason === 'string' ? { reason: value.reason } : {}), ...(typeof value?.code === 'number' ? { code: value.code } : {}) }
  }
  private failed(id: string, action: 'join' | 'leave', error: unknown): void {
    if (error instanceof MeetingProviderError && ['configuration', 'conditions'].includes(error.reason)) {
      this.deps.sessions.refused(id, action, { reason: error.reason, ...(error.code === undefined ? {} : { code: error.code }) })
    } else this.deps.sessions.unknown(id, action, this.failure(error))
  }
}
