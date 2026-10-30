import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { TodoApplication, type TodoPatch } from './todo-application.js'
import { todoTag, type TodoAudience, type Todos } from './todos.js'
import { serializeTodoProvenance, type TodoMessageMetadata, type TodoProvenance, type TodoGitHubSource } from './todo-provenance.js'
import { replyMatch, type ReplyReview, type ReplyResolutionDecision, type UnneededReplyDecision } from './personal-reply-evidence.js'
import type { ChatReadScope } from './chat-read-scope.js'

export type CollectionKind = 'todo' | 'reply'
export type CollectionRelationship = 'requested' | 'committed' | 'uncertain'
export const PERSONAL_COLLECTION_SCOPES = ['search:message', 'im:message:readonly',
  'im:message.group_msg:get_as_user', 'im:message.p2p_msg:get_as_user'] as const
export interface CollectionProfile {
  openId: string; enabled: boolean; revision: number; startedAt: number; state: string; updatedAt: number
}
type CollectionAttentionState = 'paused' | 'needs_connection' | 'retrying' | 'partial'
interface CollectionCoverage {
  through: number | null
  scannedThrough: number | null
  gapCount: number
}
export interface CollectionProgress extends CollectionCoverage {
  state: 'off' | 'today' | 'history' | 'current' | CollectionAttentionState
  messages: number
  lanes: CollectionLaneProgress[]
}
export interface CollectionLaneProgress extends CollectionCoverage {
  lane: 'group' | 'p2p'
  state: 'collecting' | CollectionAttentionState
  nextRetryAt: number | null
}
export interface CollectionReadIdentity {
  messageId: string; chatId: string; chatType: 'group' | 'p2p'
}
export interface CollectionReadGap extends CollectionReadIdentity {
  reason: 'chat_dissolved'
}
export interface CollectionCursor {
  openId: string; lane: 'group' | 'p2p' | 'group_history' | 'p2p_history' | 'owner_history'
  startSec: number; endSec: number; pageToken: string | null; version: number; completedThrough: number | null
}
export interface CollectionMessage {
  metadata: TodoMessageMetadata; text: string; mentions: string[]; senderName: string
  /** Set only by the host from bot identity or an exact persisted inbound receipt. */
  assistantDirected?: boolean
}
export interface CollectionDecision {
  messageId: string; quote: string; existingId: number | null
  kind: CollectionKind; relationship: CollectionRelationship; title: string; dueMs: number | null
  operation: 'record' | 'update' | 'complete' | 'cancel'
  github?: TodoGitHubSource | null
}
export interface CollectionCandidate {
  id: number; title: string; kind: CollectionKind; relationship: CollectionRelationship
  status: string; dueMs: number | null; chatId: string; messageId: string; threadId: string | null
  lastEvidenceMs: number; tag: string | null
}

const DAY = 86_400, OVERLAP = 30 * 60, INTERVAL = 5 * 60_000
const READ_GAPS_SCHEMA = `CREATE TABLE IF NOT EXISTS personal_collection_read_gaps (
 open_id TEXT NOT NULL, message_id TEXT NOT NULL, chat_id TEXT NOT NULL,
 chat_type TEXT NOT NULL CHECK(chat_type IN ('group','p2p')), window_start_sec INTEGER NOT NULL,
 reason TEXT NOT NULL CHECK(reason='chat_dissolved'), first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
 PRIMARY KEY(open_id,message_id)
);`
/** Additive only: no backfill, collection opt-in, or changes to existing task records. */
export function ensurePersonalCollectionReadGapsSchema(db: DatabaseSync): void { db.exec(READ_GAPS_SCHEMA) }
const SCHEMA = `
CREATE TABLE IF NOT EXISTS personal_collection_profiles (
 open_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, revision INTEGER NOT NULL,
 started_at INTEGER NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS personal_collection_cursors (
 open_id TEXT NOT NULL, lane TEXT NOT NULL, start_sec INTEGER NOT NULL, end_sec INTEGER NOT NULL,
 page_token TEXT, version INTEGER NOT NULL DEFAULT 1, completed_through INTEGER, next_at INTEGER NOT NULL,
 failures INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(open_id,lane)
);
CREATE TABLE IF NOT EXISTS personal_collection_pages (
 open_id TEXT NOT NULL, lane TEXT NOT NULL, start_sec INTEGER NOT NULL, end_sec INTEGER NOT NULL,
 token_hash TEXT NOT NULL, PRIMARY KEY(open_id,lane,start_sec,end_sec,token_hash)
);
CREATE TABLE IF NOT EXISTS personal_collection_receipts (
 open_id TEXT NOT NULL, message_id TEXT NOT NULL, digest TEXT NOT NULL, read_at INTEGER NOT NULL,
 PRIMARY KEY(open_id,message_id,digest)
);
CREATE TABLE IF NOT EXISTS personal_collection_items (
 todo_id INTEGER PRIMARY KEY, open_id TEXT NOT NULL, kind TEXT NOT NULL, relationship TEXT NOT NULL,
 title TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, thread_id TEXT,
 last_evidence_ms INTEGER NOT NULL, last_tag TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS personal_collection_items_owner ON personal_collection_items(open_id);
CREATE TABLE IF NOT EXISTS personal_collection_evidence (
 open_id TEXT NOT NULL, message_id TEXT NOT NULL, quote_hash TEXT NOT NULL, todo_id INTEGER NOT NULL,
 PRIMARY KEY(open_id,message_id,quote_hash)
);
CREATE TABLE IF NOT EXISTS personal_reply_messages (
 open_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at INTEGER NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(open_id,message_id)
);
CREATE TABLE IF NOT EXISTS personal_reply_reviews (
 todo_id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, checked_at INTEGER NOT NULL, resolution TEXT
);
`

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const evidenceKey = (decision: CollectionDecision) => digest([decision.quote, decision.kind, decision.title.trim().replace(/\s+/g, ' ')])

/** Overall and per-lane progress share the same attention priority. */
function collectionAttentionState(enabled: boolean, errors: readonly unknown[], gapCount: number): CollectionAttentionState | undefined {
  if (!enabled) return 'paused'
  if (errors.includes('needs_connection')) return 'needs_connection'
  if (errors.some(Boolean)) return 'retrying'
  if (gapCount) return 'partial'
}

/** Scanning can advance past a gap; complete coverage must stop before its window. */
function collectionCoverage(scannedThrough: number | null,
  gaps: readonly { count: number; windowStartSec: number }[]): CollectionCoverage {
  return {
    through: scannedThrough === null ? null : Math.min(scannedThrough, ...gaps.map(gap => gap.windowStartSec * 1000)),
    scannedThrough,
    gapCount: gaps.reduce((total, gap) => total + gap.count, 0),
  }
}

/** A delegation may also contain an explicit personal commitment; preserve that literal clause. */
export function explicitPersonalAction(text: string): boolean {
  return /(?:^|[\s，,。.!！?？;；:：])我(?:来|负责|会|将|要)(?!问|请|让|想|希望|你|求)[^。！？\n]{1,100}/.test(text) ||
    /(?:^|[\s，,。.!！?？;；:：])我(?:今天|明天|后天|本周|这周|下周|周[一二三四五六日天])[^。！？\n]{0,30}(?:给|发|交|做|写|改|确认|评审|完成)/.test(text) ||
    /负责人(?:是|为)我|(?:帮我|给我|替我)(?:记|加|建|添加|记录)(?:个|一条|一个)?(?:待办|提醒)|\bI(?:'ll| will| am going to)\s+(?!ask\b|want\b|need you\b)\w/i.test(text)
}
export function explicitGitHubCommitment(message: CollectionMessage, owner: string): boolean {
  return message.metadata.senderOpenId === owner && /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/(?:pull|issues)\/[1-9]\d*/.test(message.text) &&
    /我(?:来|负责|会)[^。！？\n]{0,30}(?:评审|审查|review|修复|实现|合并|合入|处理)|\bI(?:'ll| will)\s+(?:review|fix|implement|merge)\b/i.test(message.text)
}
export function collectionMessageDigest(message: CollectionMessage, owner = ''): string {
  const fields: unknown[] = [message.metadata.messageId, message.metadata.chatId, message.metadata.senderOpenId,
    message.metadata.createTimeMs, message.text, message.mentions]
  // Revisit previously skipped explicit commitments inside the normal overlap window.
  // Other receipts and every existing task/evidence record remain intact.
  if (explicitGitHubCommitment(message, owner)) fields.push('owner-github-v2')
  if (message.assistantDirected) fields.push('assistant-directed-v1')
  return digest(fields)
}

/** Checkpoints and attribution only. TodoApplication remains the sole task state machine.
 * No profile is created by OAuth or migration: an authenticated personal opt-in must call configure. */
export class PersonalCollectionStore {
  private readonly application: TodoApplication
  constructor(private readonly db: DatabaseSync, private readonly todos: Todos, private readonly now = Date.now,
    private readonly readScope?: Pick<ChatReadScope, 'isReadable'>) {
    db.exec(SCHEMA)
    ensurePersonalCollectionReadGapsSchema(db)
    const columns = db.prepare('PRAGMA table_info(personal_collection_cursors)').all()
    if (!columns.some(row => row.name === 'last_error')) db.exec('ALTER TABLE personal_collection_cursors ADD COLUMN last_error TEXT')
    this.application = new TodoApplication({ db, todos })
  }

  profile(openId: string): CollectionProfile | undefined {
    const row = this.db.prepare('SELECT * FROM personal_collection_profiles WHERE open_id=?').get(openId)
    return row ? { openId, enabled: row.enabled === 1, revision: Number(row.revision), startedAt: Number(row.started_at),
      state: String(row.state), updatedAt: Number(row.updated_at) } : undefined
  }

  /** The provider's chat directory omits human DMs. Keep discovered sources controllable by their owner. */
  discoveredChats(openId: string): { chatId: string; name: string }[] {
    const rows = this.db.prepare(`SELECT i.todo_id,i.chat_id FROM personal_collection_items i
      JOIN todos t ON t.id=i.todo_id WHERE i.open_id=? ORDER BY i.updated_at DESC,i.todo_id DESC`).all(openId)
    const chats = new Map<string, string>()
    for (const row of rows) {
      const source = this.todos.getProvenance(Number(row.todo_id))?.collection
      const todo = this.todos.get(Number(row.todo_id))
      if (!source || source.ownerOpenId !== openId || !todo || chats.has(String(row.chat_id))) continue
      chats.set(String(row.chat_id), `${source.message.chatType === 'p2p' ? '私聊' : '群聊'} · ${todo.title.slice(0, 60)}`)
    }
    return [...chats].map(([chatId, name]) => ({ chatId, name }))
  }

  configure(openId: string, enabled: boolean): CollectionProfile {
    if (!openId.trim()) throw new Error('个人收集缺少本人身份')
    const now = this.now(), end = Math.floor(now / 1000)
    // The current product uses Beijing workdays; a configurable timezone belongs to personal onboarding.
    const today = Math.floor((end + 8 * 3600) / DAY) * DAY - 8 * 3600
    this.db.exec('SAVEPOINT collection_configure')
    try {
      this.db.prepare(`INSERT INTO personal_collection_profiles VALUES(?,?,1,?,?,?)
        ON CONFLICT(open_id) DO UPDATE SET enabled=excluded.enabled,revision=revision+1,state=excluded.state,updated_at=excluded.updated_at`)
        .run(openId, enabled ? 1 : 0, now, enabled ? 'pending' : 'paused', now)
      for (const lane of ['group', 'p2p', 'group_history', 'p2p_history']) {
        const history = lane.endsWith('_history')
        this.db.prepare(`INSERT OR IGNORE INTO personal_collection_cursors
          (open_id,lane,start_sec,end_sec,page_token,version,completed_through,next_at,failures) VALUES(?,?,?,?,NULL,1,NULL,?,0)`)
          .run(openId, lane, history ? end - 7 * DAY : today, history ? today : Math.max(today + 1, end), now)
      }
      this.db.exec('RELEASE collection_configure')
    } catch (error) { this.db.exec('ROLLBACK TO collection_configure; RELEASE collection_configure'); throw error }
    return this.profile(openId)!
  }

  progress(openId: string): CollectionProgress {
    const profile = this.profile(openId)
    const rows = this.db.prepare('SELECT lane,completed_through,last_error,next_at FROM personal_collection_cursors WHERE open_id=?').all(openId)
    const gaps = this.db.prepare(`SELECT chat_type,chat_id,count(*) AS count,min(window_start_sec) AS earliest
      FROM personal_collection_read_gaps WHERE open_id=? GROUP BY chat_type,chat_id`).all(openId)
      .filter(row => this.readScope?.isReadable(openId, String(row.chat_id)) ?? true)
      .map(row => ({ chatType: String(row.chat_type), count: Number(row.count), windowStartSec: Number(row.earliest) }))
    const messages = Number(this.db.prepare('SELECT count(DISTINCT message_id) AS n FROM personal_collection_receipts WHERE open_id=?').get(openId)?.n ?? 0)
    const live = rows.filter(row => !String(row.lane).endsWith('_history'))
    const scannedThrough = live.length === 2 && live.every(row => row.completed_through !== null)
      ? Math.min(...live.map(row => Number(row.completed_through))) * 1000 : null
    const coverage = collectionCoverage(scannedThrough, gaps)
    // History failures affect the overall status, but must not mark a healthy live lane as failed.
    const state = !profile ? 'off' : collectionAttentionState(profile.enabled, rows.map(row => row.last_error), coverage.gapCount)
      ?? (scannedThrough === null ? 'today' : rows.some(row => row.completed_through === null) ? 'history' : 'current')
    const lanes: CollectionLaneProgress[] = profile ? (['group', 'p2p'] as const).flatMap(lane => {
      const row = rows.find(row => row.lane === lane)
      if (!row) return []
      const laneScannedThrough = row.completed_through === null ? null : Number(row.completed_through) * 1000
      const laneCoverage = collectionCoverage(laneScannedThrough, gaps.filter(gap => gap.chatType === lane))
      const laneState = collectionAttentionState(profile.enabled, [row.last_error], laneCoverage.gapCount) ?? 'collecting'
      return [{ lane, state: laneState, ...laneCoverage,
        nextRetryAt: laneState === 'retrying' || laneState === 'needs_connection' ? Number(row.next_at) : null }]
    }) : []
    return { state, messages, ...coverage, lanes }
  }

  /** Explicitly retry without skipping a failed window. Existing continuation receipts remain authoritative. */
  retry(openId: string): void {
    if (!this.profile(openId)?.enabled) return
    this.db.prepare("UPDATE personal_collection_cursors SET next_at=min(next_at,?) WHERE open_id=? AND (completed_through IS NULL OR lane IN ('group','p2p'))").run(this.now(), openId)
  }

  /** Re-admitting a previously excluded chat needs backfill, not merely the next five-minute window. */
  recheckRange(openId: string): void {
    if (!this.profile(openId)?.enabled) return
    const end = Math.floor(this.now() / 1000), today = Math.floor((end + 8 * 3600) / DAY) * DAY - 8 * 3600
    this.db.exec('SAVEPOINT collection_range')
    try {
      for (const lane of ['group', 'p2p', 'group_history', 'p2p_history']) {
        const history = lane.endsWith('_history')
        this.db.prepare(`UPDATE personal_collection_cursors SET start_sec=?,end_sec=?,page_token=NULL,version=version+1,
          completed_through=NULL,next_at=?,failures=0,last_error=NULL WHERE open_id=? AND lane=?`)
          .run(history ? end - 7 * DAY : today, history ? today : Math.max(today + 1, end), this.now(), openId, lane)
      }
      this.db.prepare('DELETE FROM personal_collection_pages WHERE open_id=?').run(openId)
      this.db.prepare("UPDATE personal_collection_profiles SET revision=revision+1,state='pending',updated_at=? WHERE open_id=?").run(this.now(), openId)
      this.db.exec('RELEASE collection_range')
    } catch (error) { this.db.exec('ROLLBACK TO collection_range; RELEASE collection_range'); throw error }
  }

  /** Fairness is persistent: a long backfill or one failed person cannot occupy every tick. */
  readyOwners(limit = 4): string[] {
    return (this.db.prepare(`SELECT p.open_id FROM personal_collection_profiles p
      JOIN personal_collection_cursors c ON c.open_id=p.open_id WHERE p.enabled=1 AND c.next_at<=?
      GROUP BY p.open_id ORDER BY min(c.next_at),p.open_id LIMIT ?`).all(this.now(), limit) as { open_id: string }[]).map(r => r.open_id)
  }

  next(openId: string): CollectionCursor | undefined {
    if (!this.profile(openId)?.enabled) return
    // Runtime backfill for already opted-in owners. Schema upgrades never start collection.
    const end = Math.floor(this.now() / 1000)
    this.db.prepare(`INSERT OR IGNORE INTO personal_collection_cursors
      (open_id,lane,start_sec,end_sec,page_token,version,completed_through,next_at,failures)
      VALUES(?,'owner_history',?,?,NULL,1,NULL,?,0)`).run(openId, end - 7 * DAY, end, this.now())
    const row = this.db.prepare(`SELECT * FROM personal_collection_cursors c WHERE open_id=? AND next_at<=?
      AND (lane NOT LIKE '%_history' OR NOT EXISTS (SELECT 1 FROM personal_collection_cursors live
        WHERE live.open_id=c.open_id AND live.lane IN ('group','p2p') AND live.completed_through IS NULL))
      ORDER BY next_at,CASE lane WHEN 'owner_history' THEN 0 ELSE 1 END,lane LIMIT 1`).get(openId, this.now())
    if (!row) return
    return { openId, lane: String(row.lane) as CollectionCursor['lane'], startSec: Number(row.start_sec), endSec: Number(row.end_sec),
      pageToken: row.page_token as string | null, version: Number(row.version), completedThrough: row.completed_through as number | null }
  }

  assertCurrent(profile: CollectionProfile, cursor: CollectionCursor): void {
    const current = this.profile(profile.openId)
    const row = this.db.prepare('SELECT version FROM personal_collection_cursors WHERE open_id=? AND lane=?').get(profile.openId, cursor.lane)
    if (!current?.enabled || current.revision !== profile.revision || row?.version !== cursor.version || cursor.openId !== profile.openId) {
      throw new Error('个人收集设置或读取位置已变化')
    }
  }

  seen(openId: string, message: CollectionMessage): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM personal_collection_receipts WHERE open_id=? AND message_id=? AND digest=?')
      .get(openId, message.metadata.messageId, collectionMessageDigest(message, openId)))
  }

  candidates(openId: string): CollectionCandidate[] {
    // Tombstones intentionally survive Todo deletion. Do not turn an ignored item back into a new one.
    const rows = this.db.prepare(`SELECT i.*,t.status,t.due_ms FROM personal_collection_items i LEFT JOIN todos t ON t.id=i.todo_id
      WHERE i.open_id=? AND (t.status IN ('open','blocked','review') OR i.updated_at>=?) ORDER BY i.updated_at DESC LIMIT 401`)
      .all(openId, this.now() - 8 * DAY * 1000)
    if (rows.length > 400) throw new Error('个人收集待核对事项超出单次容量')
    return rows.map(r => { const todo = this.todos.get(Number(r.todo_id)); return {
      id: Number(r.todo_id), title: todo?.title ?? String(r.title), kind: r.kind as CollectionKind,
      relationship: r.relationship as CollectionRelationship, status: todo?.status ?? 'ignored', dueMs: todo?.dueMs ?? null,
      chatId: String(r.chat_id), messageId: String(r.message_id), threadId: r.thread_id as string | null,
      lastEvidenceMs: Number(r.last_evidence_ms), tag: todo ? todoTag(todo) : null,
    } })
  }
  source(id: number) { return this.todos.getProvenance(id)?.collection }

  /** Server-only source guard. Exclusion changes visibility, not the durable evidence that a chat is unreadable. */
  blockedReadGapChats(openId: string): Set<string> {
    return new Set(this.db.prepare('SELECT DISTINCT chat_id FROM personal_collection_read_gaps WHERE open_id=?').all(openId).map(row => String(row.chat_id)))
  }

  /** Retain only the owner's recent replies; this cache is private and never grants read permission. */
  retainReplies(openId: string, messages: CollectionMessage[]): void {
    for (const message of messages) if (message.metadata.senderOpenId === openId && message.text.length <= 16_000) {
      this.db.prepare('INSERT INTO personal_reply_messages VALUES(?,?,?,?) ON CONFLICT(open_id,message_id) DO UPDATE SET record=excluded.record')
        .run(openId, message.metadata.messageId, message.metadata.createTimeMs, JSON.stringify(message))
    }
    this.db.prepare('DELETE FROM personal_reply_messages WHERE open_id=? AND created_at<?').run(openId, this.now() - 8 * DAY * 1000)
    this.db.prepare(`DELETE FROM personal_reply_messages WHERE open_id=? AND message_id NOT IN
      (SELECT message_id FROM personal_reply_messages WHERE open_id=? ORDER BY created_at DESC LIMIT 2000)`).run(openId, openId)
  }

  /** Host-read source enrichment preserves the original statement and all user edits. */
  enrichSource(openId: string, message: CollectionMessage): void {
    for (const row of this.db.prepare('SELECT todo_id FROM personal_collection_items WHERE open_id=? AND message_id=?')
      .all(openId, message.metadata.messageId)) {
      const source = this.todos.getProvenance(Number(row.todo_id)), original = source?.collection
      if (!source || !original || original.ownerOpenId !== openId || original.message.chatId !== message.metadata.chatId ||
        original.message.senderOpenId !== message.metadata.senderOpenId) continue
      source.collection = { ...original, message: { ...original.message,
        ...(message.metadata.senderName ? { senderName: message.metadata.senderName } : {}),
        ...(message.metadata.chatName ? { chatName: message.metadata.chatName } : {}),
        ...(message.metadata.link.status === 'available' ? { link: message.metadata.link } : {}) } }
      this.db.prepare('UPDATE todos SET provenance_json=? WHERE id=?').run(serializeTodoProvenance(source), Number(row.todo_id))
    }
  }

  /** Reversible correction of untouched inferred tasks, never manual tasks or user overrides. */
  correctDelegatedSource(audience: TodoAudience, message: CollectionMessage): number {
    if (!this.profile(audience.openId)?.enabled || audience.chatType !== 'p2p' ||
      audience.scope !== `space:sp_dm_${audience.openId}` || !message.assistantDirected ||
      message.metadata.senderOpenId !== audience.openId) return 0
    let updated = 0
    for (const row of this.db.prepare('SELECT todo_id,last_tag FROM personal_collection_items WHERE open_id=? AND message_id=?')
      .all(audience.openId, message.metadata.messageId)) {
      const todo = this.todos.getForAudience(Number(row.todo_id), audience), source = this.todos.getProvenance(Number(row.todo_id))?.collection
      if (!todo || todo.confirmed || !['open', 'blocked', 'review'].includes(todo.status) || todoTag(todo) !== row.last_tag ||
        source?.ownerOpenId !== audience.openId || source.message.senderOpenId !== audience.openId ||
        source.message.chatId !== message.metadata.chatId || !message.text.includes(source.quote) || explicitPersonalAction(source.quote)) continue
      const result = this.application.update(todo.id, audience, { expectedTag: todoTag(todo), patch: {
        status: 'cancelled', statusNote: '已更正：原消息是在交办 Friday，不是你本人承诺的待办。' } }, audience.openId, { statusBy: 'personal-collection' })
      this.db.prepare('UPDATE personal_collection_items SET last_tag=?,updated_at=? WHERE todo_id=?').run(result.tag, this.now(), todo.id)
      updated++
    }
    return updated
  }

  replyReviews(openId: string, readable: (chatId: string) => boolean): ReplyReview[] {
    const blocked = this.blockedReadGapChats(openId)
    const canRead = (chatId: string) => !blocked.has(chatId) && readable(chatId) && (this.readScope?.isReadable(openId, chatId) ?? true)
    const messages = this.db.prepare('SELECT record FROM personal_reply_messages WHERE open_id=? ORDER BY created_at DESC').all(openId)
      .map(row => JSON.parse(String(row.record)) as CollectionMessage).filter(m => canRead(m.metadata.chatId))
    const reviews: (ReplyReview & { checkedAt: number })[] = []
    for (const item of this.candidates(openId)) {
      const todo = this.todos.get(item.id), source = this.todos.getProvenance(item.id)?.collection
      if (!todo || !source || item.kind !== 'reply' || item.relationship === 'uncertain' || !['open', 'blocked', 'review'].includes(item.status) ||
        !canRead(item.chatId) || todoTag(todo) !== this.db.prepare('SELECT last_tag FROM personal_collection_items WHERE todo_id=?').get(item.id)?.last_tag) continue
      const replies = messages.filter(m => m.text.trim().length <= 2000 && m.metadata.senderOpenId === openId && m.metadata.createTimeMs > item.lastEvidenceMs && m.metadata.messageId !== item.messageId)
        .map(message => ({ message, ...replyMatch(source.message, source.quote, message) })).filter(m => m.direct || m.nearby || m.anchors.length).slice(0, 20)
      const fingerprint = digest(['reply-quality-v2', item.tag, source, replies]), prior = this.db.prepare('SELECT fingerprint,checked_at FROM personal_reply_reviews WHERE todo_id=?').get(item.id)
      if (prior?.fingerprint === fingerprint) continue
      reviews.push({ id: item.id, tag: todoTag(todo), fingerprint, title: todo.title, quote: source.quote, source: source.message, replies,
        checkedAt: Number(prior?.checked_at ?? 0) })
    }
    return reviews.sort((a, b) => a.checkedAt - b.checkedAt || a.id - b.id).slice(0, 5)
  }

  resolveReplies(profile: CollectionProfile, audience: TodoAudience, reviews: ReplyReview[], decisions: ReplyResolutionDecision[], assertCurrent: () => void,
    notRequired: UnneededReplyDecision[] = []): number {
    let updated = 0
    this.db.exec('SAVEPOINT personal_reply_resolution')
    try {
      assertCurrent()
      if (audience.openId !== profile.openId || audience.scope !== `space:sp_dm_${profile.openId}` || audience.chatType !== 'p2p') throw new Error('回复核对不属于本人')
      const blocked = this.blockedReadGapChats(profile.openId)
      const canRead = (chatId: string) => !blocked.has(chatId) && (this.readScope?.isReadable(profile.openId, chatId) ?? true)
      const resolved = new Set<number>()
      if (notRequired.some(item => decisions.some(other => other.id === item.id))) throw new Error('回复核对结果冲突')
      for (const decision of notRequired) {
        const review = reviews.find(item => item.id === decision.id), todo = this.todos.getForAudience(decision.id, audience)
        const item = this.db.prepare('SELECT kind,last_tag FROM personal_collection_items WHERE todo_id=? AND open_id=?').get(decision.id, profile.openId)
        if (!review || decision.quote !== review.quote) throw new Error('纠正误收缺少完整原文')
        if (!canRead(review.source.chatId)) continue
        if (!todo || todo.confirmed || !item || item.kind !== 'reply' || !['open', 'blocked', 'review'].includes(todo.status) ||
          todoTag(todo) !== review.tag || item.last_tag !== review.tag) continue
        const result = this.application.update(todo.id, audience, { expectedTag: review.tag, patch: {
          status: 'cancelled', statusNote: '已更正：原消息没有需要你回答的问题或处理请求。' } }, profile.openId, { statusBy: 'personal-collection' })
        this.db.prepare('UPDATE personal_collection_items SET last_tag=?,updated_at=? WHERE todo_id=?').run(result.tag, this.now(), todo.id)
        updated++
      }
      for (const decision of decisions) {
        const review = reviews.find(item => item.id === decision.id), reply = review?.replies.find(item => item.message.metadata.messageId === decision.messageId)
        if (review && (!canRead(review.source.chatId) || (reply && !canRead(reply.message.metadata.chatId)))) continue
        if (!review || !reply || resolved.has(decision.id) || reply.message.metadata.senderOpenId !== profile.openId ||
          reply.message.text.trim() !== decision.quote || (!reply.direct && !reply.nearby && (!decision.anchor || !reply.anchors.includes(decision.anchor))) ||
          /^(?:收到|好的?|明白|谢谢|我看看|稍后回复|ok|thanks)[!！。\s]*$/i.test(decision.quote) ||
          !decision.quote.replace(/https?:\/\/\S+/g, '').trim()) throw new Error('回复核对缺少本人回答原问题的证据')
        const todo = this.todos.getForAudience(decision.id, audience), item = this.db.prepare('SELECT kind,last_tag,last_evidence_ms FROM personal_collection_items WHERE todo_id=? AND open_id=?').get(decision.id, profile.openId)
        if (!todo || !item || item.kind !== 'reply' || !['open', 'blocked', 'review'].includes(todo.status) || todoTag(todo) !== review.tag ||
          item.last_tag !== review.tag || reply.message.metadata.createTimeMs <= Number(item.last_evidence_ms)) continue
        const result = this.application.update(todo.id, audience, { expectedTag: review.tag,
          patch: { status: 'done', statusNote: `已在${reply.message.metadata.chatName || (reply.message.metadata.chatType === 'p2p' ? '私聊' : '群聊')}回复：${decision.quote}` } }, profile.openId, { statusBy: 'personal-collection' })
        this.db.prepare('UPDATE personal_collection_items SET last_tag=?,last_evidence_ms=?,updated_at=? WHERE todo_id=?')
          .run(result.tag, reply.message.metadata.createTimeMs, this.now(), todo.id)
        this.db.prepare(`INSERT INTO personal_reply_reviews VALUES(?,?,?,?) ON CONFLICT(todo_id) DO UPDATE SET
          fingerprint=excluded.fingerprint,checked_at=excluded.checked_at,resolution=excluded.resolution`)
          .run(todo.id, review.fingerprint, this.now(), JSON.stringify({ tag: result.tag, message: reply.message.metadata, quote: decision.quote }))
        resolved.add(todo.id); updated++
      }
      for (const review of reviews) if (!resolved.has(review.id) && canRead(review.source.chatId) && review.replies.every(reply => canRead(reply.message.metadata.chatId))) this.db.prepare(`INSERT INTO personal_reply_reviews VALUES(?,?,?,NULL)
        ON CONFLICT(todo_id) DO UPDATE SET fingerprint=excluded.fingerprint,checked_at=excluded.checked_at`).run(review.id, review.fingerprint, this.now())
      assertCurrent()
      this.db.exec('RELEASE personal_reply_resolution'); return updated
    } catch (error) { this.db.exec('ROLLBACK TO personal_reply_resolution; RELEASE personal_reply_resolution'); throw error }
  }

  replyResolution(id: number): { message: TodoMessageMetadata; quote: string } | undefined {
    const value = this.db.prepare('SELECT resolution FROM personal_reply_reviews WHERE todo_id=?').get(id)?.resolution
    if (!value) return
    const resolution = JSON.parse(String(value)), todo = this.todos.get(id)
    return todo && todo.status === 'done' && todoTag(todo) === resolution.tag ? resolution : undefined
  }

  fail(profile: CollectionProfile, cursor: CollectionCursor, state: 'needs_connection' | 'retrying'): void {
    try { this.assertCurrent(profile, cursor) } catch { return }
    this.db.prepare('UPDATE personal_collection_profiles SET state=?,updated_at=? WHERE open_id=?').run(state, this.now(), profile.openId)
    this.db.prepare('UPDATE personal_collection_cursors SET next_at=?,failures=failures+1,last_error=? WHERE open_id=? AND lane=?')
      .run(this.now() + INTERVAL, state, profile.openId, cursor.lane)
    const row = this.db.prepare('SELECT failures FROM personal_collection_cursors WHERE open_id=? AND lane=?').get(profile.openId, cursor.lane)
    // A provider continuation may expire while paused/offline. Replay the same window, never skip ahead.
    // Persisted message/evidence receipts make already-committed pages harmless to replay.
    if (Number(row?.failures) >= 3 && cursor.pageToken) {
      this.db.prepare('UPDATE personal_collection_cursors SET page_token=NULL,version=version+1,failures=0 WHERE open_id=? AND lane=?').run(profile.openId, cursor.lane)
      this.db.prepare('DELETE FROM personal_collection_pages WHERE open_id=? AND lane=?').run(profile.openId, cursor.lane)
    }
  }

  /** Writes, evidence receipts and page advancement commit together; every await happened before this transaction. */
  commit(input: { profile: CollectionProfile; cursor: CollectionCursor; audience: TodoAudience; messages: CollectionMessage[];
    decisions: CollectionDecision[]; candidates: CollectionCandidate[]; nextPageToken?: string;
    readGaps?: CollectionReadGap[]; resolvedReadGaps?: CollectionReadIdentity[]; assertCurrent(): void }): { created: number; updated: number } {
    const { profile, cursor, audience, messages, decisions, candidates } = input
    if (audience.openId !== profile.openId || audience.scope !== `space:sp_dm_${profile.openId}` || audience.chatType !== 'p2p' || !audience.chatId) {
      throw new Error('个人收集只能写入本人的私聊清单')
    }
    const byId = new Map(messages.map(m => [m.metadata.messageId, m])), offered = new Map(candidates.map(c => [c.id, c]))
    let created = 0, updated = 0
    this.db.exec('SAVEPOINT collection_page')
    try {
      this.assertCurrent(profile, cursor); input.assertCurrent()
      this.recordReadCoverage(profile.openId, cursor, input.readGaps ?? [], [
        ...messages.map(message => message.metadata), ...(input.resolvedReadGaps ?? []),
      ])
      for (const message of messages) updated += this.correctDelegatedSource(audience, message)
      // Older extraction could treat the owner's outgoing statement as an
      // incoming question. Correct only untouched inferred replies, retaining
      // a reversible explanation and every manually edited/confirmed item.
      for (const row of this.db.prepare("SELECT todo_id,last_tag FROM personal_collection_items WHERE open_id=? AND kind='reply' AND relationship='requested'").all(profile.openId)) {
        if (!offered.has(Number(row.todo_id))) continue
        const todo = this.todos.getForAudience(Number(row.todo_id), audience), source = this.todos.getProvenance(Number(row.todo_id))?.collection
        if (!todo || todo.confirmed || !['open', 'blocked', 'review'].includes(todo.status) || todoTag(todo) !== row.last_tag ||
          source?.ownerOpenId !== profile.openId || source.message.senderOpenId !== profile.openId || source.relationship !== 'requested') continue
        const result = this.application.update(todo.id, audience, { expectedTag: todoTag(todo), patch: {
          status: 'cancelled', statusNote: '已更正：原消息由你发出，不是别人请你回复。' } }, profile.openId, { statusBy: 'personal-collection' })
        this.db.prepare('UPDATE personal_collection_items SET last_tag=?,updated_at=? WHERE todo_id=?').run(result.tag, this.now(), todo.id)
        updated++
      }
      if (input.nextPageToken && (input.nextPageToken === cursor.pageToken || this.db.prepare(`SELECT 1 FROM personal_collection_pages
        WHERE open_id=? AND lane=? AND start_sec=? AND end_sec=? AND token_hash=?`)
        .get(profile.openId, cursor.lane, cursor.startSec, cursor.endSec, digest(input.nextPageToken)))) throw new Error('个人收集分页循环')
      for (const decision of decisions) {
        const source = byId.get(decision.messageId)
        if (!source || !decision.quote.trim() || !source.text.includes(decision.quote)) throw new Error('事项缺少本轮读取的原文证据')
        if (decision.operation === 'record' && source.assistantDirected && source.metadata.senderOpenId === profile.openId &&
          !explicitPersonalAction(decision.quote)) continue
        const evidence = this.db.prepare('SELECT todo_id FROM personal_collection_evidence WHERE open_id=? AND message_id=? AND quote_hash=?')
          .get(profile.openId, decision.messageId, evidenceKey(decision))
        if (evidence && decision.existingId !== null && decision.existingId !== Number(evidence.todo_id)) throw new Error('事项证据归属冲突')
        const id = evidence ? Number(evidence.todo_id) : decision.existingId
        if (id === null) {
          const own = source.metadata.senderOpenId === profile.openId
          // The sender is provider metadata, not model output. An outgoing
          // request is for the other participant; a self-commitment has its own
          // relationship. Skip a misclassification without stalling the page.
          if (own && decision.relationship === 'requested' && decision.operation === 'record') continue
          // Search pages are not chronological. Retain a named, explicit owner completion as a
          // terminal item so a request on an older page cannot resurrect already-finished work.
          if (decision.operation === 'update' || (decision.operation !== 'record' && !own)) throw new Error('新事项缺少本人状态依据')
          if ((decision.relationship === 'committed' && !own) ||
            (source.metadata.chatType === 'group' && !own && !source.mentions.includes(profile.openId) && decision.relationship !== 'uncertain')) {
            throw new Error('事项负责人缺少身份依据')
          }
          const provenance: TodoProvenance = { version: 1, originRunId: `collection:${profile.openId}:${cursor.lane}:${cursor.version}`,
            taskId: null, workKey: `collection:${decision.messageId}`, request: null, selectedInputs: [],
            collection: { ownerOpenId: profile.openId, message: { ...source.metadata, ...(source.senderName && !/^用户\(|^未知$/.test(source.senderName) ? { senderName: source.senderName } : {}) }, quote: decision.quote,
              kind: decision.kind, relationship: decision.relationship, ...(decision.github ? { github: decision.github } : {}) },
            contextSnapshot: { version: 1, acpSessionId: `collection:${profile.openId}`, spaceId: `sp_dm_${profile.openId}`,
              chatId: audience.chatId, memoryScopes: [], chats: [{ chatId: source.metadata.chatId }], external: [], repositories: [] } }
          let result = this.application.create(audience, { title: decision.title, detail: decision.quote, dueMs: decision.dueMs,
            ownerOpenId: profile.openId, confirmed: false, source: decision.kind === 'reply' ? '自动收集 · 待回复' : '自动收集 · 待办', provenance }, null)
          if (decision.operation === 'complete' || decision.operation === 'cancel') {
            result = this.application.update(result.todo.id, audience, { expectedTag: result.tag,
              patch: { status: decision.operation === 'complete' ? 'done' : 'cancelled', statusNote: decision.quote } }, profile.openId, { statusBy: 'personal-collection' })
          }
          this.db.prepare('INSERT INTO personal_collection_items VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(result.todo.id, profile.openId,
            decision.kind, decision.relationship, decision.title, source.metadata.chatId, decision.messageId,
            source.metadata.threadId ?? source.metadata.rootId ?? null, source.metadata.createTimeMs, result.tag, this.now())
          this.evidence(profile.openId, source, decision, result.todo.id)
          created++
          continue
        }
        const item = this.db.prepare('SELECT * FROM personal_collection_items WHERE todo_id=? AND open_id=?').get(id, profile.openId)
        if (!item || (!evidence && !offered.has(id))) throw new Error('事项不属于本人或不在本轮核对范围')
        const todo = this.todos.getForAudience(id, audience)
        // Manual edits, completed/deleted records and older backfill evidence can never overwrite newer state.
        if (!todo || !['open','blocked','review'].includes(todo.status) || todoTag(todo) !== item.last_tag ||
          source.metadata.createTimeMs < Number(item.last_evidence_ms) || (offered.has(id) && offered.get(id)!.tag !== todoTag(todo))) {
          this.evidence(profile.openId, source, decision, id)
          continue
        }
        if (decision.kind !== item.kind) throw new Error('待回复与交付待办不能互相完成')
        if (decision.operation === 'record') { this.evidence(profile.openId, source, decision, id); continue }
        // Reply completion compares the original question with the full answer separately.
        // A cross-chat answer must not strand the entire collection page here.
        if (decision.kind === 'reply' && decision.operation === 'complete') continue
        if (source.metadata.chatId !== item.chat_id || (item.thread_id && item.thread_id !==
          (source.metadata.threadId ?? source.metadata.rootId ?? null))) throw new Error('状态变更缺少同一会话或话题依据')
        const requester = this.todos.getProvenance(id)?.collection?.message.senderOpenId
        if (source.metadata.senderOpenId !== profile.openId && source.metadata.senderOpenId !== requester) throw new Error('状态变更不来自本人或原交办人')
        // Completion needs an explicit statement by the owner. Silence, reactions and someone else's progress cannot close it.
        if (decision.operation === 'complete' && source.metadata.senderOpenId !== profile.openId) throw new Error('完成证据不来自本人')
        const patch: TodoPatch = decision.operation === 'complete' ? { status: 'done', statusNote: decision.quote }
          : decision.operation === 'cancel' ? { status: 'cancelled', statusNote: decision.quote }
          : { title: decision.title, detail: decision.quote, dueMs: decision.dueMs }
        const result = this.application.update(id, audience, { expectedTag: todoTag(todo), patch }, profile.openId, { statusBy: 'personal-collection' })
        this.db.prepare(`UPDATE personal_collection_items SET title=?,relationship=?,last_evidence_ms=?,last_tag=?,updated_at=? WHERE todo_id=?`)
          .run(result.todo.title, decision.relationship, source.metadata.createTimeMs, result.tag, this.now(), id)
        this.evidence(profile.openId, source, decision, id)
        if (result.changed) updated++
      }
      for (const message of messages) this.db.prepare('INSERT OR IGNORE INTO personal_collection_receipts VALUES(?,?,?,?)')
        .run(profile.openId, message.metadata.messageId, collectionMessageDigest(message, profile.openId), this.now())
      this.db.prepare('INSERT OR IGNORE INTO personal_collection_pages VALUES(?,?,?,?,?)')
        .run(profile.openId, cursor.lane, cursor.startSec, cursor.endSec, digest(cursor.pageToken))
      if (input.nextPageToken) {
        this.db.prepare('UPDATE personal_collection_cursors SET page_token=?,version=version+1,next_at=?,failures=0,last_error=NULL WHERE open_id=? AND lane=?')
          .run(input.nextPageToken, this.now(), profile.openId, cursor.lane)
      } else {
        const history = cursor.lane.endsWith('_history'), nextEnd = Math.max(cursor.endSec + 1, Math.floor((this.now() + INTERVAL) / 1000))
        this.db.prepare(`UPDATE personal_collection_cursors SET start_sec=?,end_sec=?,page_token=NULL,version=version+1,
          completed_through=?,next_at=?,failures=0,last_error=NULL WHERE open_id=? AND lane=?`).run(history ? cursor.startSec : Math.max(0, cursor.endSec - OVERLAP),
            history ? cursor.endSec : nextEnd, cursor.endSec, history ? Number.MAX_SAFE_INTEGER : this.now() + INTERVAL, profile.openId, cursor.lane)
        this.db.prepare('DELETE FROM personal_collection_pages WHERE open_id=? AND lane=?').run(profile.openId, cursor.lane)
      }
      this.db.prepare('UPDATE personal_collection_profiles SET state=?,updated_at=? WHERE open_id=?').run('collecting', this.now(), profile.openId)
      input.assertCurrent()
      this.db.exec('RELEASE collection_page')
      return { created, updated }
    } catch (error) { this.db.exec('ROLLBACK TO collection_page; RELEASE collection_page'); throw error }
  }

  private evidence(openId: string, source: CollectionMessage, decision: CollectionDecision, todoId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO personal_collection_evidence VALUES(?,?,?,?)').run(openId, source.metadata.messageId, evidenceKey(decision), todoId)
  }

  /** Only the host's verified detail reads may close a gap; search hits and model decisions never do. */
  private recordReadCoverage(openId: string, cursor: CollectionCursor, gaps: CollectionReadGap[], resolved: CollectionReadIdentity[]): void {
    if (!gaps.length && !resolved.length) return
    const identities = new Map<string, CollectionReadIdentity>()
    for (const source of [...gaps, ...resolved]) {
      if (!source.messageId?.trim() || !source.chatId?.trim() || !['group', 'p2p'].includes(source.chatType)) throw new Error('读取覆盖缺少消息或会话身份')
      const previous = identities.get(source.messageId)
      if (previous && (previous.chatId !== source.chatId || previous.chatType !== source.chatType)) throw new Error('读取覆盖来源身份冲突')
      identities.set(source.messageId, source)
      const stored = this.db.prepare('SELECT chat_id,chat_type FROM personal_collection_read_gaps WHERE open_id=? AND message_id=?').get(openId, source.messageId)
      if (stored && (stored.chat_id !== source.chatId || stored.chat_type !== source.chatType)) throw new Error('读取覆盖来源身份冲突')
    }
    const resolvedIds = new Set(resolved.map(source => source.messageId))
    // Derive the boundary from the persisted, version-checked cursor, never a provider error or caller-supplied timestamp.
    const window = this.db.prepare('SELECT start_sec FROM personal_collection_cursors WHERE open_id=? AND lane=? AND version=?').get(openId, cursor.lane, cursor.version)
    if (!window) throw new Error('读取覆盖位置已变化')
    for (const gap of gaps) {
      if (gap.reason !== 'chat_dissolved' || (cursor.lane !== 'owner_history' && gap.chatType !== (cursor.lane.startsWith('group') ? 'group' : 'p2p'))) throw new Error('读取缺口不属于当前范围')
      if (resolvedIds.has(gap.messageId)) throw new Error('同一消息不能同时读取成功和存在缺口')
      this.db.prepare(`INSERT INTO personal_collection_read_gaps VALUES(?,?,?,?,?,'chat_dissolved',?,?)
        ON CONFLICT(open_id,message_id) DO UPDATE SET
          window_start_sec=min(window_start_sec,excluded.window_start_sec),last_seen_at=max(last_seen_at,excluded.last_seen_at)`)
        .run(openId, gap.messageId, gap.chatId, gap.chatType, Number(window.start_sec), this.now(), this.now())
    }
    for (const source of resolved) this.db.prepare('DELETE FROM personal_collection_read_gaps WHERE open_id=? AND message_id=? AND chat_id=? AND chat_type=?')
      .run(openId, source.messageId, source.chatId, source.chatType)
  }
}
