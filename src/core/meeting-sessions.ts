import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { MeetingEvent, MeetingJoinReceipt } from '../feishu/meetings.js'
import type { MaterialProvenance } from './execution-materials.js'

export type MeetingState = 'joining' | 'awaiting_admission' | 'attending' | 'join_unknown' | 'join_rejected' | 'leaving' | 'leave_unknown' | 'leave_rejected' | 'left' | 'ended'
export interface MeetingOrigin {
  runId: string; taskId: number; workKey: string; sessionKey: string; requestMessageId: string
  spaceId: string; chatId: string; chatType: 'group' | 'p2p'; ownerOpenId: string
  /** Resolved by the host from the owner's DM, never a model-selected destination. */
  reviewSpaceId: string; reviewChatId: string
}
export interface MeetingActionAuthority { key: string; operation: 'join' | 'leave'; actorOpenId: string; messageId: string; meetingNumber: string }
export interface MeetingSession {
  id: string; version: string; origin: MeetingOrigin; meetingNumber: string; meetingId?: string; botParticipantId?: string; title?: string
  state: MeetingState; enabled: boolean; createdAt: number; updatedAt: number
  joinAuthority: MeetingActionAuthority; leaveAuthority?: MeetingActionAuthority
  context: MaterialProvenance
  events: MeetingEvent[]; eventsDigest: string; revision: number; pageToken?: string; coverageComplete: boolean
  lastFailure?: { reason: string; code?: number }; joinAckAt?: number; confirmedAt?: number; leaveAckAt?: number
  rejections?: { operation: 'join' | 'leave'; authority: MeetingActionAuthority; reason: string; code?: number; at: number }[]
  currentDraftId?: string
}
export interface MeetingActionItem { title: string; detail?: string; owner?: string; ownerOpenId?: string; dueMs?: number }
export interface MeetingDraft {
  id: string; sessionId: string; sessionVersion: string; revision: number; eventsDigest: string; summary: string; actions: MeetingActionItem[]
  digest: string; state: 'pending' | 'accepted' | 'rejected'; createdAt: number
  reviewMessageId?: string; reviewedDigest?: string; todoIds: number[]; decidedAt?: number
}
export class MeetingStateError extends Error {
  constructor(readonly code: 'not_found' | 'denied' | 'changed' | 'unconfirmed' | 'invalid' | 'pending') {
    super(({ not_found: '当前未找到这次参会。', denied: '当前身份或资料范围不允许处理这次会议。', changed: '会议内容或授权已变化，请重新取得当前版本。',
      unconfirmed: '参会、会议内容或完整审阅尚未确认，请先核对原记录。', invalid: '会议请求不完整，未执行。', pending: '原会议动作的结果仍待核对，没有重复发起。' })[code])
    this.name = 'MeetingStateError'
  }
}
export function meetingDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex')
}

/** External meeting facts and reviewed drafts; Work/Run and Todo remain their own domains. */
export class MeetingSessions {
  constructor(readonly db: DatabaseSync, private readonly now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS meeting_sessions (
      id TEXT PRIMARY KEY, owner_open_id TEXT NOT NULL, meeting_number TEXT NOT NULL, enabled INTEGER NOT NULL,
      state TEXT NOT NULL, value_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_meeting_sessions_owner ON meeting_sessions(owner_open_id,enabled,state);
    CREATE TABLE IF NOT EXISTS meeting_drafts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, value_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE(session_id,digest)
    );`)
  }
  get(id: string): MeetingSession | undefined {
    const row = this.db.prepare('SELECT value_json FROM meeting_sessions WHERE id=?').get(id)
    return row && JSON.parse(String(row.value_json)) as MeetingSession
  }
  list(ownerOpenId?: string): MeetingSession[] {
    const rows = ownerOpenId ? this.db.prepare('SELECT value_json FROM meeting_sessions WHERE owner_open_id=? ORDER BY created_at').all(ownerOpenId)
      : this.db.prepare('SELECT value_json FROM meeting_sessions ORDER BY created_at').all()
    return rows.map(row => JSON.parse(String(row.value_json)) as MeetingSession)
  }
  begin(origin: MeetingOrigin, meetingNumber: string, context: MaterialProvenance, authority: MeetingActionAuthority): { session: MeetingSession; started: boolean } {
    if (!/^\d{9}$/.test(meetingNumber) || !origin.ownerOpenId || !origin.reviewChatId || !origin.reviewSpaceId || !origin.requestMessageId ||
      !origin.workKey || !origin.runId || !Number.isSafeInteger(origin.taskId) || !authority.key || !authority.messageId ||
      authority.operation !== 'join' || authority.meetingNumber !== meetingNumber || authority.actorOpenId !== origin.ownerOpenId) throw new MeetingStateError('invalid')
    const existing = this.list(origin.ownerOpenId).find(item => item.joinAuthority.key === authority.key ||
      item.enabled && item.meetingNumber === meetingNumber && !['left', 'ended', 'join_rejected'].includes(item.state))
    if (existing) return { session: existing, started: false }
    const now = this.now(), session: MeetingSession = { id: randomUUID(), version: randomUUID(), origin: structuredClone(origin), meetingNumber,
      state: 'joining', enabled: true, createdAt: now, updatedAt: now, joinAuthority: structuredClone(authority), context: structuredClone(context),
      events: [], eventsDigest: meetingDigest([]), revision: 0, coverageComplete: false }
    this.db.prepare('INSERT INTO meeting_sessions(id,owner_open_id,meeting_number,enabled,state,value_json,created_at,updated_at) VALUES(?,?,?,1,?,?,?,?)')
      .run(session.id, origin.ownerOpenId, meetingNumber, session.state, JSON.stringify(session), now, now)
    return { session, started: true }
  }
  /** Mutation facts are saved even if the invoking HTTP/Run was cancelled while awaiting ACK. */
  joined(id: string, receipt: MeetingJoinReceipt): MeetingSession {
    return this.update(id, session => { session.meetingId = receipt.meetingId; session.botParticipantId = receipt.botParticipantId;
      session.title = receipt.title; session.joinAckAt = this.now(); if (session.state === 'joining' || session.state === 'join_unknown') session.state = 'awaiting_admission'; delete session.lastFailure })
  }
  unknown(id: string, action: 'join' | 'leave', error: { reason?: string; code?: number }): MeetingSession {
    return this.update(id, session => {
      if (action === 'join' && session.state === 'joining') session.state = 'join_unknown'
      if (action === 'leave' && session.state === 'leaving') session.state = 'leave_unknown'
      session.lastFailure = { reason: error.reason ?? 'unknown', ...(typeof error.code === 'number' ? { code: error.code } : {}) } })
  }
  /** A definite provider refusal is not an uncertain POST. Preserve it for this
   * request; only a newly approved human request may start another attempt. */
  refused(id: string, action: 'join' | 'leave', error: { reason: string; code?: number }): MeetingSession {
    return this.update(id, session => {
      if (action === 'join' && session.state === 'joining') session.state = 'join_rejected'
      if (action === 'leave' && session.state === 'leaving') session.state = 'leave_rejected'
      session.lastFailure = { reason: error.reason, ...(error.code === undefined ? {} : { code: error.code }) }
      const authority = action === 'join' ? session.joinAuthority : session.leaveAuthority
      if (authority && !(session.rejections ?? []).some(value => value.authority.key === authority.key)) {
        session.rejections ??= []
        session.rejections.push({ operation: action, authority, ...session.lastFailure, at: this.now() })
      }
    })
  }
  beginLeave(id: string, version: string, authority: MeetingActionAuthority): { session: MeetingSession; started: boolean } {
    let started = false
    const session = this.update(id, value => {
      this.assert(value, version)
      if (!authority.key || !authority.messageId || authority.actorOpenId !== value.origin.ownerOpenId || authority.operation !== 'leave' || authority.meetingNumber !== value.meetingNumber) throw new MeetingStateError('denied')
      if (value.leaveAuthority && (value.leaveAuthority.key === authority.key || value.state !== 'leave_rejected') || ['left', 'ended'].includes(value.state)) return
      if (!value.meetingId) throw new MeetingStateError('unconfirmed')
      value.leaveAuthority = structuredClone(authority); value.state = 'leaving'; started = true
    })
    return { session, started }
  }
  left(id: string, participantId: string): MeetingSession {
    return this.update(id, session => {
      if (session.botParticipantId && session.botParticipantId !== participantId) throw new MeetingStateError('unconfirmed')
      session.botParticipantId ??= participantId; session.leaveAckAt = this.now(); if (session.state !== 'ended') session.state = 'left'; delete session.lastFailure
    })
  }
  reconcileActive(id: string, version: string, active: { meetingId: string; meetingNumber?: string; title?: string }[]): MeetingSession {
    return this.update(id, session => {
      this.assert(session, version)
      const matches = active.filter(item => session.meetingId ? item.meetingId === session.meetingId : item.meetingNumber === session.meetingNumber)
      if (matches.length !== 1) return // Directory absence cannot prove that the bot left or the meeting ended.
      const found = matches[0]!
      session.meetingId ??= found.meetingId; session.title ??= found.title
      if (['joining', 'join_unknown', 'awaiting_admission'].includes(session.state)) {
        session.state = 'attending'; session.confirmedAt ??= this.now()
      }
    })
  }
  append(id: string, version: string, page: { events: MeetingEvent[]; hasMore: boolean; nextPageToken?: string }, expectedPageToken?: string): MeetingSession {
    return this.update(id, session => {
      this.assert(session, version)
      if (!session.meetingId || session.pageToken !== expectedPageToken || page.hasMore && (!page.nextPageToken || page.nextPageToken === expectedPageToken)) throw new MeetingStateError('changed')
      const all = new Map(session.events.map(event => [event.id, event]))
      for (const event of page.events) {
        if (event.meeting && event.meeting.id !== session.meetingId) throw new MeetingStateError('changed')
        const previous = all.get(event.id)
        if (previous && meetingDigest(previous) !== meetingDigest(event)) throw new MeetingStateError('changed')
        all.set(event.id, structuredClone(event))
        if (session.botParticipantId && event.joined.some(item => item.participant.id === session.botParticipantId)) {
          session.confirmedAt ??= this.now()
          if (['joining', 'join_unknown', 'awaiting_admission'].includes(session.state)) session.state = 'attending'
        }
        // Official VC event semantics: leave_reason=2 means meeting ended.
        const ended = event.left.some(item => item.reason === 2) || Boolean(event.meeting?.endedAt && event.meeting.startedAt &&
          /^\d+$/.test(event.meeting.endedAt) && /^\d+$/.test(event.meeting.startedAt) && BigInt(event.meeting.endedAt) > BigInt(event.meeting.startedAt))
        if (ended) session.state = 'ended'
        else if (session.botParticipantId && event.left.some(item => item.participant.id === session.botParticipantId)) session.state = 'left'
      }
      session.events = [...all.values()]
      const digest = meetingDigest(session.events)
      if (digest !== session.eventsDigest) { session.eventsDigest = digest; session.revision++ }
      session.pageToken = page.nextPageToken; session.coverageComplete = !page.hasMore
      delete session.lastFailure
    })
  }
  revoke(id: string): MeetingSession { return this.update(id, value => { value.enabled = false; value.version = randomUUID() }) }
  assert(value: MeetingSession, version: string): void { if (!value.enabled || value.version !== version) throw new MeetingStateError('changed') }

  propose(id: string, version: string, summary: string, actions: MeetingActionItem[]): MeetingDraft {
    const session = this.get(id)
    if (!session) throw new MeetingStateError('not_found')
    this.assert(session, version)
    if (!['left', 'ended'].includes(session.state) || !session.coverageComplete || !session.confirmedAt || !summary.trim() || summary.length > 100_000 ||
      actions.length > 100 || actions.some(item => !item.title.trim() || item.title.length > 200 || (item.detail?.length ?? 0) > 20_000 ||
        item.dueMs !== undefined && (!Number.isSafeInteger(item.dueMs) || item.dueMs < 0))) throw new MeetingStateError('unconfirmed')
    const body = { sessionId: id, sessionVersion: version, revision: session.revision, eventsDigest: session.eventsDigest, summary, actions }
    const digest = meetingDigest(body)
    const existing = this.db.prepare('SELECT value_json FROM meeting_drafts WHERE session_id=? AND digest=?').get(id, digest)
    if (existing) return JSON.parse(String(existing.value_json)) as MeetingDraft
    if (session.currentDraftId && this.draft(session.currentDraftId)?.state === 'accepted') throw new MeetingStateError('changed')
    const draft: MeetingDraft = { id: randomUUID(), ...structuredClone(body), digest, state: 'pending', createdAt: this.now(), todoIds: [] }
    this.transaction(() => {
      this.db.prepare('INSERT INTO meeting_drafts(id,session_id,digest,state,value_json,created_at) VALUES(?,?,?,?,?,?)').run(draft.id,id,digest,draft.state,JSON.stringify(draft),draft.createdAt)
      this.update(id, current => { this.assert(current, version); current.currentDraftId = draft.id })
    })
    return draft
  }
  draft(id: string): MeetingDraft | undefined {
    const row = this.db.prepare('SELECT value_json FROM meeting_drafts WHERE id=?').get(id)
    return row && JSON.parse(String(row.value_json)) as MeetingDraft
  }
  reviewDelivered(id: string, digest: string, messageId: string): void {
    const draft = this.draft(id)
    if (!draft || draft.digest !== digest || !messageId) throw new MeetingStateError('changed')
    draft.reviewMessageId = messageId; draft.reviewedDigest = digest; this.saveDraft(draft)
  }
  decide(id: string, digest: string, decision: 'accept' | 'reject', commit: (draft: MeetingDraft, session: MeetingSession) => number[], guard: () => void): MeetingDraft {
    return this.transaction(() => {
      guard()
      const draft = this.draft(id), session = draft && this.get(draft.sessionId)
      if (!draft || !session) throw new MeetingStateError('not_found')
      this.assert(session, draft.sessionVersion)
      if (session.currentDraftId !== draft.id || draft.digest !== digest || draft.eventsDigest !== session.eventsDigest || draft.revision !== session.revision ||
        draft.reviewedDigest !== digest || !draft.reviewMessageId) throw new MeetingStateError('changed')
      if (draft.state !== 'pending') return draft
      guard()
      draft.todoIds = decision === 'accept' ? commit(draft, session) : []
      if (!Array.isArray(draft.todoIds) || draft.todoIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new MeetingStateError('invalid')
      draft.state = decision === 'accept' ? 'accepted' : 'rejected'; draft.decidedAt = this.now(); this.saveDraft(draft)
      return draft
    })
  }
  private update(id: string, edit: (session: MeetingSession) => void): MeetingSession {
    const session = this.get(id)
    if (!session) throw new MeetingStateError('not_found')
    edit(session); session.updatedAt = this.now()
    this.db.prepare('UPDATE meeting_sessions SET enabled=?,state=?,value_json=?,updated_at=? WHERE id=?').run(+session.enabled,session.state,JSON.stringify(session),session.updatedAt,id)
    return session
  }
  private saveDraft(draft: MeetingDraft): void { this.db.prepare('UPDATE meeting_drafts SET state=?,value_json=? WHERE id=?').run(draft.state,JSON.stringify(draft),draft.id) }
  private transaction<T>(work: () => T): T {
    this.db.exec('SAVEPOINT meeting_decision')
    try { const result = work(); this.db.exec('RELEASE meeting_decision'); return result }
    catch(error) { this.db.exec('ROLLBACK TO meeting_decision'); this.db.exec('RELEASE meeting_decision'); throw error }
  }
}
