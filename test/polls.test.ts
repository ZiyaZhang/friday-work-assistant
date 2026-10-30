import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Polls, type PollOrigin } from '../src/core/polls.js'
import type { MaterialProvenance } from '../src/core/execution-materials.js'
import { pollSource, verifyPollSource } from '../src/core/poll-source.js'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(close => close()) })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-poll-store-')), path = join(home, 'db'); let now = 1000, db = new DatabaseSync(path), store = new Polls(db, () => now)
  cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }) })
  const origin: PollOrigin = { runId: 'run', taskId: 1, workKey: 'work', sessionKey: 'session', ownerOpenId: 'alice', spaceId: 'space', chatId: 'chat', chatType: 'group', requestMessageId: 'message' }
  const context: MaterialProvenance = { sources: { version: 1, acpSessionId: 'acp', spaceId: 'space', chatId: 'chat', memoryScopes: [], chats: [], external: [], repositories: [] }, memoryRefs: [] }
  const input = { operationKey: 'original-message', question: 'Choose the focus', choices: ['First', 'Second'], origin, context }
  const open = () => { const poll = store.create(input, () => {}).poll; return store.published(poll.id, poll.contentDigest, 'actual-card') }
  const vote = (pollId: string, optionId: string | null, micros: string, eventId = `event:${micros}`, guard = () => {}) => store.ballot({ pollId, optionId, digest: store.get(pollId)!.contentDigest, messageId: 'actual-card', openId: 'bob', name: 'Bob', eventId, eventTimeMicros: micros }, guard)
  return { get store() { return store }, get db() { return db }, input, open, vote, advance(to: number) { now = to }, reopen() { db.close(); db = new DatabaseSync(path); store = new Polls(db, () => now) } }
}
describe('durable poll and actual ballot facts', () => {
  it('keeps the original source snapshot when a replacement Run retries the same actual request', () => {
    const t = fixture(), poll = t.open(); t.reopen()
    const repeated = t.store.create({ ...t.input, origin: { ...t.input.origin, runId: 'replacement' }, context: { ...t.input.context, memoryRefs: [{ id: 8, revision: 9 }] } }, () => { throw new Error('should not resend') })
    expect(repeated).toMatchObject({ created: false, poll: { id: poll.id, origin: { runId: 'run' }, context: { memoryRefs: [] } } })
    expect(() => t.store.create({ ...t.input, question: 'Changed question' }, () => {})).toThrow(expect.objectContaining({ code: 'changed' }))
    expect(t.store.list()).toHaveLength(1)
  })
  it('enforces one current choice, durable withdrawal, exact replay and old-event order after restart', () => {
    const t = fixture(), poll = t.open(); t.vote(poll.id, '1', '100'); t.vote(poll.id, '2', '300'); t.reopen()
    expect(t.vote(poll.id, '1', '200').outcome).toBe('stale')
    expect(t.vote(poll.id, '2', '300').outcome).toBe('unchanged')
    expect(() => t.vote(poll.id, '1', '300')).toThrow(expect.objectContaining({ code: 'changed' }))
    expect(t.vote(poll.id, null, '400').outcome).toBe('withdrawn'); t.reopen()
    expect(t.vote(poll.id, '2', '300').outcome).toBe('stale')
    expect(t.store.tally(poll.id)).toMatchObject({ total: 0, withdrawn: 1 })
    t.vote(poll.id, '1', '500'); expect(t.store.tally(poll.id).groups.map(group => group.count)).toEqual([1, 0])
  })
  it('treats zero as no deadline, rejects invalid time and freezes votes at a real deadline', () => {
    const t = fixture(), manual = t.store.create({ ...t.input, closesAt: 0 }, () => {}).poll
    expect(manual.closesAt).toBeNull()
    for (const closesAt of [NaN, -1, 999]) expect(() => t.store.create({ ...t.input, operationKey: String(closesAt), closesAt }, () => {})).toThrow()
    const timed = t.store.create({ ...t.input, operationKey: 'timed', closesAt: 2000 }, () => {}).poll
    t.store.published(timed.id, timed.contentDigest, 'actual-card'); t.advance(2000)
    expect(() => t.vote(timed.id, '1', '100')).toThrow(expect.objectContaining({ code: 'closed' }))
  })
  it('rolls back a canceled ballot and the whole close/feedback transaction, not just the status flag', () => {
    const t = fixture(), poll = t.open(); let checks = 0
    expect(() => t.vote(poll.id, '1', '100', 'event', () => { if (++checks === 2) throw new Error('revoked') })).toThrow('revoked')
    expect(t.store.ballots(poll.id)).toEqual([]); expect(t.store.get(poll.id)?.ballotRevision).toBe(0)
    t.db.exec('CREATE TABLE evidence(id INTEGER)')
    expect(() => t.store.close(poll.id, () => {}, () => { t.db.prepare('INSERT INTO evidence VALUES(1)').run(); throw new Error('feedback unavailable') })).toThrow()
    expect(t.db.prepare('SELECT * FROM evidence').all()).toEqual([]); expect(t.store.get(poll.id)?.state).toBe('open')
    t.vote(poll.id, '1', '200'); const closed = t.store.close(poll.id, () => {}, () => 8); t.reopen()
    expect(t.store.close(poll.id, () => {}, () => { throw new Error('no second feedback') })).toEqual(closed)
    expect(() => t.vote(poll.id, null, '300')).toThrow(expect.objectContaining({ code: 'closed' }))
  })
  it('never accepts votes for an unpublished or modified card', () => {
    const t = fixture(), draft = t.store.create(t.input, () => {}).poll
    expect(() => t.vote(draft.id, '1', '100')).toThrow()
    const poll = t.open()
    expect(() => t.store.ballot({ pollId: poll.id, optionId: '1', digest: 'forged', messageId: 'actual-card', openId: 'bob', eventId: 'event', eventTimeMicros: '100' }, () => {})).toThrow()
    expect(t.store.ballots(poll.id)).toEqual([])
  })
  it('retains exact returned snapshots across votes and disk reopen without claiming historical totals are current', () => {
    const t = fixture(), poll = t.open(); t.vote(poll.id, '1', '100')
    const observed = t.store.get(poll.id)!, payload = { pollId: poll.id, state: observed.state,
      question: observed.question, results: t.store.tally(poll.id).groups, asOfRevision: observed.ballotRevision }
    const read = t.store.captureRead(observed, payload), source = pollSource(read)
    expect(t.store.captureRead(observed, payload).digest).toBe(read.digest)
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM poll_read_snapshots').get()?.n).toBe(1)
    t.vote(poll.id, '2', '200'); t.reopen()
    expect(t.store.readSnapshot(read.digest)?.payload).toEqual(payload)
    expect(t.store.tally(poll.id).groups.map(group => group.count)).toEqual([0, 1])
    expect(verifyPollSource(t.store, source, { spaceId: 'space', chatId: 'chat', chatType: 'group', openId: 'bob' })).toBe(true)
    expect(verifyPollSource(t.store, { ...source, snapshotDigest: '0'.repeat(64) },
      { spaceId: 'space', chatId: 'chat', chatType: 'group', openId: 'bob' })).toBe(false)
    expect(() => t.store.captureRead(observed, payload)).toThrow(expect.objectContaining({ code: 'changed' }))
    expect(() => t.store.captureRead(t.store.get(poll.id)!, { ...payload, oversized: 'x'.repeat(256 * 1024) }))
      .toThrow(expect.objectContaining({ code: 'snapshot_too_large' }))
  })
})
