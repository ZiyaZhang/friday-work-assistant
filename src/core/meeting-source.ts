import { meetingDigest, type MeetingSession, type MeetingSessions } from './meeting-sessions.js'

/** Host-only receipt for the exact retained event snapshot, never an app/public read grant. */
export interface MeetingSourceReceipt {
  version: 1; sessionId: string; sessionVersion: string; meetingId: string; ownerOpenId: string
  spaceId: string; chatId: string; revision: number; eventsDigest: string; complete: boolean
}
export function validMeetingSource(value: unknown): value is MeetingSourceReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return source.version === 1 && ['sessionId', 'sessionVersion', 'meetingId', 'ownerOpenId', 'spaceId', 'chatId', 'eventsDigest']
    .every(key => typeof source[key] === 'string' && Boolean(source[key])) && Number.isSafeInteger(source.revision) &&
    Number(source.revision) >= 0 && typeof source.complete === 'boolean'
}
export function meetingSource(session: MeetingSession): MeetingSourceReceipt {
  if (!session.meetingId) throw new Error('会议尚无平台身份')
  return { version: 1, sessionId: session.id, sessionVersion: session.version, meetingId: session.meetingId,
    ownerOpenId: session.origin.ownerOpenId, spaceId: session.origin.reviewSpaceId, chatId: session.origin.reviewChatId,
    revision: session.revision, eventsDigest: session.eventsDigest, complete: session.coverageComplete }
}
export interface MeetingSourceAudience { openId: string; spaceId: string; chatId: string; chatType: 'group' | 'p2p' }
/** This synchronous check is combined with the host's current SourceContext authorization,
 * which revalidates the saved pre-meeting context and original owner/space authority. */
export function verifyMeetingSource(store: Pick<MeetingSessions, 'get'>, source: MeetingSourceReceipt, audience: MeetingSourceAudience): boolean {
  if (!validMeetingSource(source) || audience.chatType !== 'p2p' || source.ownerOpenId !== audience.openId ||
    source.spaceId !== audience.spaceId || source.chatId !== audience.chatId || !source.complete) return false
  const session = store.get(source.sessionId)
  return Boolean(session?.enabled && session.confirmedAt && session.coverageComplete && session.meetingId &&
    meetingDigest(meetingSource(session)) === meetingDigest(source))
}
