import { pollDigest, type PollReadSnapshot, type Polls } from './polls.js'

/** A snapshot of a named poll, restricted to its original group. Not public facts. */
export interface PollSourceReceipt {
  version: 2; pollId: string; pollVersion: string; spaceId: string; chatId: string
  contentDigest: string; snapshotDigest: string; ballotRevision: number; state: 'open' | 'closed'
}
export interface PollSourceAudience { spaceId: string; chatId: string; chatType: 'group' | 'p2p'; openId: string }
export function validPollSource(value: unknown): value is PollSourceReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return source.version === 2 && ['pollId', 'pollVersion', 'spaceId', 'chatId'].every(key => typeof source[key] === 'string' && Boolean(source[key])) &&
    ['contentDigest', 'snapshotDigest'].every(key => typeof source[key] === 'string' && /^[a-f0-9]{64}$/.test(source[key])) &&
    Number.isSafeInteger(source.ballotRevision) && Number(source.ballotRevision) >= 0 && ['open', 'closed'].includes(String(source.state))
}
export function pollSource(snapshot: PollReadSnapshot): PollSourceReceipt {
  return { version: 2, pollId: snapshot.pollId, pollVersion: snapshot.pollVersion, spaceId: snapshot.spaceId, chatId: snapshot.chatId,
    contentDigest: snapshot.contentDigest, snapshotDigest: snapshot.digest, ballotRevision: snapshot.ballotRevision, state: snapshot.state }
}
export function verifyPollSource(store: Pick<Polls, 'get' | 'readSnapshot'>, source: PollSourceReceipt, audience: PollSourceAudience): boolean {
  if (!validPollSource(source) || !audience.openId || audience.chatType !== 'group' || source.spaceId !== audience.spaceId || source.chatId !== audience.chatId) return false
  const poll = store.get(source.pollId), snapshot = store.readSnapshot(source.snapshotDigest)
  return Boolean(poll?.messageId && poll.state !== 'draft' && poll.version === source.pollVersion && poll.contentDigest === source.contentDigest &&
    poll.origin.spaceId === source.spaceId && poll.origin.chatId === source.chatId && snapshot && pollDigest(pollSource(snapshot)) === pollDigest(source))
}
