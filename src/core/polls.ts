import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { MaterialProvenance } from './execution-materials.js'
import type { RetainedSourceOrigin } from './retained-source-access.js'

export interface PollOrigin extends RetainedSourceOrigin { chatType: 'group'; requestMessageId: string }
export interface PollChoice { id: string; text: string }
export interface PollBallot { voterOpenId: string; voterName: string | null; optionId: string | null; eventId: string; eventTimeMicros: string; updatedAt: number }
export interface PollResult {
  closedAt: number; total: number; withdrawn: number
  groups: { optionId: string; text: string; count: number; voters: { name: string | null }[] }[]
  digest: string
}
export interface Poll {
  id: string; version: string; operationKey: string; state: 'draft' | 'open' | 'closed'
  question: string; choices: PollChoice[]; contentDigest: string; closesAt: number | null
  origin: PollOrigin; context: MaterialProvenance; createdAt: number; ballotRevision: number
  messageId?: string; feedbackId?: number; result?: PollResult
}
/** Exact DTO actually returned by a host read. This is evidence of an observed
 * result, not a second mutable vote tally or permission to publish it elsewhere. */
export interface PollReadSnapshot {
  digest: string; pollId: string; pollVersion: string; spaceId: string; chatId: string
  contentDigest: string; ballotRevision: number; state: 'open' | 'closed'
  payload: Record<string, unknown>; capturedAt: number
}
export class PollError extends Error {
  constructor(readonly code: 'invalid' | 'denied' | 'not_found' | 'changed' | 'closed' | 'unpublished' | 'too_large' | 'snapshot_too_large' | 'unavailable') {
    super({ invalid: '投票问题、选项或事件信息不完整。', denied: '当前身份或空间不允许这项投票操作。', not_found: '没有找到当前空间的这项投票。',
      changed: '投票内容、来源或权限已变化，请查看当前记录。', closed: '投票已经截止，不能继续改票或撤票。', unpublished: '投票卡片的实际发送尚未确认，没有接受投票。',
      too_large: '完整投票内容超过飞书卡片容量，请缩短问题或选项；没有截断或发送。',
      snapshot_too_large: '完整投票结果超过本次读取容量，没有截断返回；请缩小这项投票的规模。',
      unavailable: '投票来源暂时无法核验，请稍后重试。' }[code])
    this.name = 'PollError'
  }
}
export function pollDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex')
}

/** Schema-only entry point; no callbacks, recovery or platform access. */
export function ensurePollSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, space_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('draft','open','closed')), value_json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS polls_space ON polls(space_id,state);
    CREATE TABLE IF NOT EXISTS poll_ballots (
      poll_id TEXT NOT NULL REFERENCES polls(id), voter_open_id TEXT NOT NULL, voter_name TEXT, option_id TEXT,
      event_id TEXT NOT NULL, event_time_micros TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(poll_id,voter_open_id)
    );
    CREATE TABLE IF NOT EXISTS poll_read_snapshots (
      digest TEXT PRIMARY KEY, poll_id TEXT NOT NULL REFERENCES polls(id), value_json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS poll_reads_poll ON poll_read_snapshots(poll_id);`)
}

/** Poll and ballot facts only. Tasks schedule work, Delivery owns remote receipts,
 * and Feedback owns the later product decision. */
export class Polls {
  constructor(readonly db: DatabaseSync, private readonly now: () => number = Date.now) { ensurePollSchema(db) }

  captureRead(poll: Poll, payload: Record<string, unknown>): PollReadSnapshot {
    const current = this.require(poll.id)
    if (!current.messageId || current.state === 'draft') throw new PollError('unpublished')
    if (current.version !== poll.version || current.contentDigest !== poll.contentDigest || current.ballotRevision !== poll.ballotRevision ||
      current.state !== poll.state || payload.pollId !== poll.id || payload.state !== poll.state) throw new PollError('changed')
    const snapshot = { pollId: poll.id, pollVersion: poll.version, spaceId: poll.origin.spaceId, chatId: poll.origin.chatId,
      contentDigest: poll.contentDigest, ballotRevision: poll.ballotRevision, state: current.state,
      payload: structuredClone(payload) }
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 256 * 1024) throw new PollError('snapshot_too_large')
    const digest = pollDigest(snapshot), existing = this.readSnapshot(digest)
    if (existing) return existing
    const stored: PollReadSnapshot = { ...snapshot, digest, capturedAt: this.now() }
    this.db.prepare('INSERT INTO poll_read_snapshots(digest,poll_id,value_json) VALUES(?,?,?)').run(digest, poll.id, JSON.stringify(stored))
    return stored
  }

  readSnapshot(digest: string): PollReadSnapshot | undefined {
    const row = this.db.prepare('SELECT value_json FROM poll_read_snapshots WHERE digest=?').get(digest)
    if (!row) return undefined
    const snapshot = JSON.parse(String(row.value_json)) as PollReadSnapshot
    const { digest: recorded, capturedAt: _captured, ...payload } = snapshot
    return recorded === digest && pollDigest(payload) === digest ? snapshot : undefined
  }
  get(id: string): Poll | undefined {
    const row = this.db.prepare('SELECT value_json FROM polls WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value_json)) as Poll : undefined
  }
  list(spaceId?: string): Poll[] {
    const rows = spaceId ? this.db.prepare('SELECT value_json FROM polls WHERE space_id=? ORDER BY rowid').all(spaceId)
      : this.db.prepare('SELECT value_json FROM polls ORDER BY rowid').all()
    return rows.map(row => JSON.parse(String(row.value_json)) as Poll)
  }
  create(input: { operationKey: string; question: string; choices: string[]; closesAt?: number; feedbackId?: number; origin: PollOrigin; context: MaterialProvenance },
    validate: (poll: Poll) => void): { poll: Poll; created: boolean } {
    const question = input.question.trim(), choices = input.choices.map(value => value.trim()), closesAt = input.closesAt === undefined || input.closesAt === 0 ? null : input.closesAt
    if (!input.operationKey || !question || choices.length < 2 || choices.some(value => !value) || new Set(choices).size !== choices.length ||
      input.origin.chatType !== 'group' || !input.origin.ownerOpenId || !input.origin.requestMessageId ||
      closesAt !== null && (!Number.isSafeInteger(closesAt) || closesAt < 0) ||
      input.feedbackId !== undefined && (!Number.isSafeInteger(input.feedbackId) || input.feedbackId < 1)) throw new PollError('invalid')
    const body = { question, choices, closesAt, feedbackId: input.feedbackId ?? null }, contentDigest = pollDigest(body)
    const previous = this.db.prepare('SELECT id FROM polls WHERE operation_key=?').get(input.operationKey)
    if (previous) {
      const poll = this.get(String(previous.id))!
      // A replacement Run may recover the same actual request. Its retained
      // context stays the original snapshot; this never replaces source facts.
      if (poll.contentDigest !== contentDigest || pollDigest({ ...poll.origin, runId: undefined }) !== pollDigest({ ...input.origin, runId: undefined })) throw new PollError('changed')
      return { poll, created: false }
    }
    if (closesAt !== null && closesAt <= this.now()) throw new PollError('invalid')
    const poll: Poll = { id: randomUUID(), version: randomUUID(), operationKey: input.operationKey, state: 'draft',
      question, choices: choices.map((text, index) => ({ id: String(index + 1), text })), contentDigest, closesAt,
      origin: structuredClone(input.origin), context: structuredClone(input.context), createdAt: this.now(), ballotRevision: 0,
      ...(input.feedbackId === undefined ? {} : { feedbackId: input.feedbackId }) }
    validate(poll)
    this.db.prepare('INSERT INTO polls(id,operation_key,space_id,chat_id,state,value_json) VALUES(?,?,?,?,?,?)')
      .run(poll.id, poll.operationKey, poll.origin.spaceId, poll.origin.chatId, poll.state, JSON.stringify(poll))
    return { poll, created: true }
  }
  published(id: string, digest: string, messageId: string): Poll {
    const poll = this.require(id)
    if (poll.contentDigest !== digest || !messageId || poll.messageId && poll.messageId !== messageId) throw new PollError('changed')
    poll.messageId = messageId
    if (poll.state === 'draft') poll.state = 'open'
    this.save(poll); return poll
  }
  ballots(id: string): PollBallot[] {
    this.require(id)
    return this.db.prepare(`SELECT voter_open_id AS voterOpenId,voter_name AS voterName,option_id AS optionId,event_id AS eventId,
      event_time_micros AS eventTimeMicros,updated_at AS updatedAt FROM poll_ballots WHERE poll_id=? ORDER BY voter_open_id`).all(id) as unknown as PollBallot[]
  }
  ballot(input: { pollId: string; digest: string; messageId: string; openId: string; name?: string; optionId: string | null; eventId: string; eventTimeMicros: string },
    assertCurrent: () => void): { poll: Poll; outcome: 'recorded' | 'unchanged' | 'stale' | 'withdrawn' } {
    return this.transaction(() => {
      assertCurrent()
      const poll = this.require(input.pollId)
      if (poll.contentDigest !== input.digest || poll.messageId !== input.messageId) throw new PollError('changed')
      if (poll.state === 'draft') throw new PollError('unpublished')
      if (poll.state === 'closed' || poll.closesAt !== null && this.now() >= poll.closesAt) throw new PollError('closed')
      if (!input.openId || !input.eventId || !/^\d{1,24}$/.test(input.eventTimeMicros) || BigInt(input.eventTimeMicros) <= 0n ||
        input.optionId !== null && !poll.choices.some(choice => choice.id === input.optionId)) throw new PollError('invalid')
      const previous = this.ballots(poll.id).find(value => value.voterOpenId === input.openId)
      if (previous?.eventId === input.eventId) {
        if (previous.optionId !== input.optionId || previous.eventTimeMicros !== input.eventTimeMicros) throw new PollError('changed')
        return { poll, outcome: 'unchanged' }
      }
      if (previous && BigInt(previous.eventTimeMicros) >= BigInt(input.eventTimeMicros)) return { poll, outcome: 'stale' }
      const name = input.name?.trim() || null, changed = !previous || previous.optionId !== input.optionId || previous.voterName !== name
      this.db.prepare(`INSERT INTO poll_ballots(poll_id,voter_open_id,voter_name,option_id,event_id,event_time_micros,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(poll_id,voter_open_id) DO UPDATE SET voter_name=excluded.voter_name,option_id=excluded.option_id,event_id=excluded.event_id,
        event_time_micros=excluded.event_time_micros,updated_at=excluded.updated_at`).run(poll.id, input.openId, name, input.optionId, input.eventId, input.eventTimeMicros, this.now())
      if (changed) { poll.ballotRevision++; this.save(poll) }
      assertCurrent()
      return { poll, outcome: !changed ? 'unchanged' : input.optionId === null ? 'withdrawn' : 'recorded' }
    })
  }
  tally(id: string): PollResult {
    const poll = this.require(id)
    if (poll.result) return poll.result
    return this.result(poll, this.now())
  }
  /** Closing and Feedback linkage are one local transaction; never a remote call. */
  close(id: string, assertCurrent: () => void, recordFeedback: (poll: Poll, result: PollResult) => number): Poll {
    return this.transaction(() => {
      assertCurrent()
      const poll = this.require(id)
      if (poll.state === 'closed') return poll
      if (!poll.messageId || poll.state !== 'open') throw new PollError('unpublished')
      const result = this.result(poll, this.now()), feedbackId = recordFeedback(poll, result)
      if (!Number.isSafeInteger(feedbackId) || feedbackId < 1) throw new PollError('invalid')
      assertCurrent(); poll.state = 'closed'; poll.result = result; poll.feedbackId = feedbackId
      this.save(poll); return poll
    })
  }
  private result(poll: Poll, closedAt: number): PollResult {
    const ballots = this.ballots(poll.id), counted = ballots.filter(value => value.optionId !== null)
    const result = { closedAt, total: counted.length, withdrawn: ballots.length - counted.length,
      groups: poll.choices.map(choice => { const votes = counted.filter(value => value.optionId === choice.id)
        return { optionId: choice.id, text: choice.text, count: votes.length, voters: votes.map(value => ({ name: value.voterName })) } }) }
    return { ...result, digest: pollDigest({ content: poll.contentDigest, revision: poll.ballotRevision, ...result }) }
  }
  private require(id: string): Poll { const poll = this.get(id); if (!poll) throw new PollError('not_found'); return poll }
  private save(poll: Poll): void { this.db.prepare('UPDATE polls SET state=?,value_json=? WHERE id=?').run(poll.state, JSON.stringify(poll), poll.id) }
  private transaction<T>(fn: () => T): T {
    this.db.exec('SAVEPOINT poll_change')
    try { const result = fn(); this.db.exec('RELEASE SAVEPOINT poll_change'); return result }
    catch (error) { this.db.exec('ROLLBACK TO SAVEPOINT poll_change; RELEASE SAVEPOINT poll_change'); throw error }
  }
}
