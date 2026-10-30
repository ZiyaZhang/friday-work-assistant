import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Todos } from '../src/core/todos.js'
import { ChatReadScope } from '../src/core/chat-read-scope.js'
import { PersonalCollectionStore, ensurePersonalCollectionReadGapsSchema, type CollectionDecision,
  type CollectionMessage, type CollectionReadGap } from '../src/core/personal-collection.js'

const OWNER = 'ou_owner', NOW = Date.parse('2026-10-13T04:00:00Z'), DAY = 86_400_000
const databases: DatabaseSync[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()) })
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const clock = { value: NOW }, now = () => clock.value, todos = new Todos(db), readScope = new ChatReadScope(db, now), store = new PersonalCollectionStore(db, todos, now, readScope)
  const audience = (owner = OWNER) => ({ openId: owner, scope: `space:sp_dm_${owner}`, chatId: `oc_friday_${owner}`, chatType: 'p2p' as const })
  store.configure(OWNER, true)
  const gap: CollectionReadGap = { messageId: 'om_unreadable', chatId: 'oc_closed_group', chatType: 'group', reason: 'chat_dissolved' }
  const message: CollectionMessage = { metadata: { messageId: 'om_readable', chatId: 'oc_readable_group', chatType: 'group',
    senderOpenId: 'ou_requester', msgType: 'text', createTimeMs: NOW - 60_000, link: { status: 'unavailable' } },
    text: '@owner 请确认测试计划', mentions: [OWNER], senderName: 'Test requester' }
  const decision: CollectionDecision = { messageId: message.metadata.messageId, quote: message.text, existingId: null,
    kind: 'todo', relationship: 'requested', title: '确认测试计划', dueMs: null, operation: 'record' }
  const commit = (extra: Partial<Parameters<PersonalCollectionStore['commit']>[0]> = {}, owner = OWNER) => store.commit({
    profile: store.profile(owner)!, cursor: store.next(owner)!, audience: audience(owner), messages: [], decisions: [],
    candidates: store.candidates(owner), assertCurrent() {}, ...extra,
  })
  const gaps = (owner = OWNER) => db.prepare('SELECT * FROM personal_collection_read_gaps WHERE open_id=? ORDER BY message_id').all(owner)
  return { db, clock, now, todos, store, readScope, audience, gap, message, decision, commit, gaps }
}

describe('personal collection durable read gaps', () => {
  it('adds one empty table without changing any old schema or row, and is idempotent', () => {
    const t = fixture(); t.commit({ messages: [t.message], decisions: [t.decision] })
    t.db.exec('DROP TABLE personal_collection_read_gaps')
    const schema = () => t.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name<>'personal_collection_read_gaps' ORDER BY type,name").all()
    const oldSchema = schema(), tables = t.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    const rows = () => tables.map(row => [row.name, t.db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}" ORDER BY rowid`).all()])
    const oldRows = rows()
    ensurePersonalCollectionReadGapsSchema(t.db); ensurePersonalCollectionReadGapsSchema(t.db)
    expect(schema()).toEqual(oldSchema); expect(rows()).toEqual(oldRows); expect(t.gaps()).toEqual([])
    expect(t.db.prepare('PRAGMA table_info(personal_collection_read_gaps)').all().map(row => row.name)).toEqual([
      'open_id', 'message_id', 'chat_id', 'chat_type', 'window_start_sec', 'reason', 'first_seen_at', 'last_seen_at',
    ])
  })
  it('commits readable tasks and gap metadata together while keeping complete coverage before the gap', () => {
    const t = fixture(), cursor = t.store.next(OWNER)!
    expect(t.commit({ messages: [t.message], decisions: [t.decision], readGaps: [t.gap] })).toEqual({ created: 1, updated: 0 })
    t.commit() // p2p can complete independently.
    expect(t.store.progress(OWNER)).toMatchObject({ state: 'partial', messages: 1, scannedThrough: NOW,
      through: cursor.startSec * 1000, gapCount: 1, lanes: [
        { lane: 'group', state: 'partial', through: cursor.startSec * 1000, scannedThrough: NOW, gapCount: 1, nextRetryAt: null },
        { lane: 'p2p', state: 'collecting', through: NOW, scannedThrough: NOW, gapCount: 0, nextRetryAt: null },
      ] })
    expect(t.gaps()).toEqual([{ open_id: OWNER, message_id: t.gap.messageId, chat_id: t.gap.chatId, chat_type: 'group',
      window_start_sec: cursor.startSec, reason: 'chat_dissolved', first_seen_at: NOW, last_seen_at: NOW }])
    expect(t.db.prepare('SELECT count(*) AS n FROM personal_collection_receipts WHERE message_id=?').get(t.gap.messageId)?.n).toBe(0)
    expect(t.todos.listForAudience(t.audience()).items).toHaveLength(1)
    expect(t.store.progress('ou_other')).toMatchObject({ state: 'off', gapCount: 0, lanes: [] })
  })
  it('keeps replays idempotent, retains the earliest boundary, and survives a store restart', () => {
    const t = fixture()
    t.commit({ readGaps: [t.gap, t.gap] }); t.commit()
    t.clock.value += 1_000
    const history = t.store.next(OWNER)!
    expect(history.lane).toBe('owner_history')
    t.commit({ readGaps: [t.gap] })
    expect(t.gaps()).toHaveLength(1)
    expect(t.gaps()[0]).toMatchObject({ window_start_sec: history.startSec, first_seen_at: NOW, last_seen_at: NOW + 1_000 })
    expect(t.store.progress(OWNER)).toMatchObject({ state: 'partial', through: NOW - 7 * DAY, scannedThrough: NOW, gapCount: 1 })
    const before = t.gaps()
    expect(new PersonalCollectionStore(t.db, t.todos, t.now).progress(OWNER)).toEqual(t.store.progress(OWNER))
    expect(t.gaps()).toEqual(before)
  })
  it('clears only the same owner and verified source identity, including a seen/history detail read', () => {
    const t = fixture(), other = 'ou_other'
    t.commit({ readGaps: [t.gap] }); t.commit()
    t.store.configure(other, true); t.commit({ readGaps: [t.gap] }, other)
    expect(t.store.next(OWNER)?.lane).toBe('owner_history')
    t.commit({ resolvedReadGaps: [t.gap] })
    expect(t.gaps()).toEqual([]); expect(t.gaps(other)).toHaveLength(1)
    expect(t.store.progress(OWNER)).toMatchObject({ through: NOW, scannedThrough: NOW, gapCount: 0 })
    expect(t.store.progress(other)).toMatchObject({ state: 'partial', gapCount: 1 })
  })
  it('also resolves a gap from a successful message passed for extraction without requiring a task decision', () => {
    const t = fixture(); t.commit({ readGaps: [t.gap] }); t.commit()
    const recovered = { ...t.message, metadata: { ...t.message.metadata, messageId: t.gap.messageId, chatId: t.gap.chatId } }
    t.commit({ messages: [recovered] })
    expect(t.gaps()).toEqual([])
    expect(t.store.seen(OWNER, recovered)).toBe(true)
    expect(t.todos.listForAudience(t.audience()).items).toEqual([])
  })
  it('rolls back gaps, tasks, receipts and page advancement when evidence or final authorization fails', () => {
    for (const failure of ['quote', 'authorization']) {
      const t = fixture(), cursor = t.store.next(OWNER)!, before = t.store.progress(OWNER)
      let assertions = 0
      expect(() => t.commit({ messages: [t.message], decisions: [{ ...t.decision, quote: failure === 'quote' ? 'invented' : t.message.text }],
        readGaps: [t.gap], assertCurrent() { if (failure === 'authorization' && ++assertions === 2) throw new Error('revoked') } })).toThrow()
      expect(t.gaps()).toEqual([]); expect(t.todos.listForAudience(t.audience()).items).toEqual([])
      expect(t.store.seen(OWNER, t.message)).toBe(false); expect(t.store.next(OWNER)).toEqual(cursor)
      expect(t.store.progress(OWNER)).toEqual(before)
    }
  })
  it('preserves a gap when a later successful read transaction is rolled back', () => {
    const t = fixture(); t.commit({ readGaps: [t.gap] }); t.commit()
    const before = t.gaps()
    expect(() => t.commit({ resolvedReadGaps: [t.gap], messages: [t.message], decisions: [{ ...t.decision, quote: 'invented' }] })).toThrow()
    expect(t.gaps()).toEqual(before)
  })
  it('rejects conflicting identities, unsupported reasons and mismatched lanes without altering coverage', () => {
    const t = fixture(), cursor = t.store.next(OWNER)!
    expect(() => t.commit({ readGaps: [t.gap], resolvedReadGaps: [t.gap] })).toThrow('同时')
    expect(() => t.commit({ readGaps: [{ ...t.gap, reason: 'permission_denied' as never }] })).toThrow('范围')
    expect(() => t.commit({ readGaps: [{ ...t.gap, chatType: 'p2p' }] })).toThrow('范围')
    expect(t.store.next(OWNER)).toEqual(cursor); expect(t.gaps()).toEqual([])
    t.commit({ readGaps: [t.gap] })
    const before = t.gaps()
    expect(() => t.commit({ resolvedReadGaps: [{ ...t.gap, chatId: 'oc_unrelated' }] })).toThrow('身份冲突')
    expect(t.gaps()).toEqual(before)
  })
  it('prioritizes authorization and retry failures above partial without blaming the other lane', () => {
    for (const state of ['needs_connection', 'retrying'] as const) {
      const t = fixture(); t.commit({ readGaps: [t.gap] })
      const p2p = t.store.next(OWNER)!
      t.store.fail(t.store.profile(OWNER)!, p2p, state)
      expect(t.store.progress(OWNER)).toMatchObject({ state, gapCount: 1, lanes: [
        { lane: 'group', state: 'partial', gapCount: 1 }, { lane: 'p2p', state, gapCount: 0 },
      ] })
      t.store.configure(OWNER, false)
      expect(t.store.progress(OWNER)).toMatchObject({ state: 'paused', gapCount: 1, lanes: [{ state: 'paused' }, { state: 'paused' }] })
    }
  })
  it('counts only gaps in the current read scope and restores their original boundaries when readmitted', () => {
    const t = fixture(), second = { ...t.gap, messageId: 'om_other_unreadable', chatId: 'oc_other_closed' }
    t.commit({ readGaps: [t.gap, second] }); t.commit()
    const before = t.gaps(), progress = t.store.progress(OWNER)
    expect(progress.gapCount).toBe(2)
    t.readScope.exclude(OWNER, t.gap.chatId)
    expect(t.store.progress(OWNER)).toMatchObject({ state: 'partial', gapCount: 1, through: progress.through })
    expect(t.store.progress(OWNER).lanes[0]?.gapCount).toBe(1)
    t.readScope.exclude(OWNER, second.chatId)
    expect(t.store.progress(OWNER)).toMatchObject({ state: 'history', gapCount: 0, through: NOW, scannedThrough: NOW })
    expect(t.gaps()).toEqual(before)
    expect(t.store.blockedReadGapChats(OWNER)).toEqual(new Set([t.gap.chatId, second.chatId]))
    expect(t.store.blockedReadGapChats('ou_other')).toEqual(new Set())
    t.readScope.restore(OWNER, t.gap.chatId)
    expect(t.store.progress(OWNER)).toMatchObject({ state: 'partial', gapCount: 1, through: progress.through })
    expect(t.gaps()).toEqual(before)
  })
  it.each(['question', 'answer'] as const)('does not expose cached %s text or apply an in-flight reply review after that chat gains a gap', side => {
    const t = fixture(), anchor = 'https://github.com/example/test/pull/41', question = { ...t.message, text: `@owner 请确认 ${anchor} 的测试计划` }, answer: CollectionMessage = { ...t.message,
      metadata: { ...t.message.metadata, messageId: 'om_answer', chatId: 'oc_answer_group', senderOpenId: OWNER,
        createTimeMs: NOW }, text: `${anchor} 测试计划已核对，可以按计划执行。` }
    t.commit({ messages: [question], decisions: [{ ...t.decision, quote: question.text, kind: 'reply' }] }); t.commit()
    t.store.retainReplies(OWNER, [answer])
    const reviews = t.store.replyReviews(OWNER, () => true)
    expect(reviews).toHaveLength(1); expect(reviews[0]?.replies).toHaveLength(1)
    const blockedChat = side === 'question' ? t.message.metadata.chatId : answer.metadata.chatId
    t.commit({ readGaps: [{ ...t.gap, chatId: blockedChat }] })
    const guarded = t.store.replyReviews(OWNER, () => true)
    if (side === 'question') expect(guarded).toEqual([])
    else expect(guarded[0]?.replies).toEqual([])
    expect(t.store.resolveReplies(t.store.profile(OWNER)!, t.audience(), reviews,
      [{ id: reviews[0]!.id, messageId: answer.metadata.messageId, quote: answer.text, anchor }], () => {})).toBe(0)
    if (side === 'question') expect(t.store.resolveReplies(t.store.profile(OWNER)!, t.audience(), reviews, [], () => {},
      [{ id: reviews[0]!.id, quote: reviews[0]!.quote }])).toBe(0)
    expect(t.todos.listForAudience(t.audience()).items[0]?.status).toBe('open')
    expect(t.db.prepare('SELECT count(*) AS n FROM personal_reply_messages').get()?.n).toBe(1)
    expect(t.db.prepare('SELECT count(*) AS n FROM personal_reply_reviews').get()?.n).toBe(0)
  })
})
