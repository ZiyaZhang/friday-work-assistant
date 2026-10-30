/**
 * 记忆（分层笔记）。每条笔记有作用域、类型、状态和来源：
 *
 *   作用域   space:sp_dm_<open_id>（私聊空间：只有本人可见）
 *            space:sp_xxxxxxxx（群空间；和 chat 解耦，换绑不丢）
 *            circle:<name>（联盟：同联盟的群共享）
 *            org（企业：全员可读，写入要晋升）
 *   状态     candidate（自动抽取、还没人确认）→ confirmed（网关记录了人的显式确认）
 *            superseded（被新条目替代，不再注入、不再检索）
 *   来源     记的时候是谁、哪条消息（source JSON），晋升时记从哪个作用域来
 *
 * 读取按会话身份：私聊 = 本人空间 + org；群 = 本空间 + 所在联盟 + org。写入时打作用域，读取时不推断。
 * 放在网关而不是 dsh：dsh 0.1.6 没有跨会话记忆，Claude Tag 的记忆同样是产品层实现。
 */
import type { DatabaseSync } from 'node:sqlite'
import { initialProvenance, legacyMemoryReadPredicate, MemoryPromotionConflict, MemoryRevisionConflict, migrateMemoryProvenance, readMemoryProvenance, recordMemoryChange, writeMemoryProvenance,
  type MemoryAncestor, type MemoryChange, type MemoryChangeOperation, type MemoryProvenance, type MemoryProvenanceInput,
  type MemorySourceReference, type MemoryTombstone } from './memory-provenance.js'

export type NoteKind = 'qa' | 'fact' | 'decision' | 'todo' | 'profile' | 'rule' | 'lesson' | 'selfnote'

/**
 * 「知道的事」里给人看的类型。
 *
 * 刻意排除两类：`qa` 是一次性问答，
 * `selfnote` 是助手自己的工具限制（「本机 bash 被沙箱拒绝」这种）。
 * 两者都还存着、还能被检索到，只是不占人的视线——人打开"你知道我什么"不该看到这些。
 */
export const USER_VISIBLE_NOTE_KINDS: readonly NoteKind[] = ['fact', 'decision', 'todo', 'profile', 'rule', 'lesson']
export type NoteStatus = 'candidate' | 'confirmed' | 'superseded'

/** Shared row decoding only; this grants no permission to query a memory row. */
export { toNote as memoryNoteFromRow }

/** 由网关从当前人的确认消息记录；不是模型自报的 certainty 或 source.by。 */
export interface MemoryConfirmation {
  by: string
  messageId: string
  at: number
}

export interface MemoryNote {
  id: number
  revision: number
  scope: string
  sessionKey: string | null
  kind: NoteKind
  title: string
  body: string
  status: NoteStatus
  confirmation: MemoryConfirmation | null
  /** 来源：{ by?: open_id, messageId?, chatId?, promotedFrom?: scope, noteId?: number } */
  source: Record<string, unknown> | null
  supersededBy: number | null
  createdAt: number
}

/** 注入 prompt 时每个作用域的说明 */
export interface ScopeSpec {
  scope: string
  label: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  session_key TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',
  source TEXT,
  superseded_by INTEGER,
  confirmation TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_notes(scope, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(title, body, content='memory_notes', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_notes BEGIN
  INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_notes BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
`

export const MAX_NOTE_BODY = 1500
export const ORG_SCOPE = 'org'
const LIVE = `status IN ('candidate', 'confirmed')`
const LEGACY_READ = legacyMemoryReadPredicate()
export interface MemoryWriteOptions { expectedRevision?: number }
/** Selected by an authenticated host after Space authorization; this is not a read grant. */
export interface MemoryAudience {
  scope: string
  chatId: string | null
  chatType: 'group' | 'p2p'
  openId: string
}
export interface MemoryAddInput extends MemoryWriteOptions {
  scope: string; sessionKey?: string; kind: NoteKind; title: string; body: string; status?: NoteStatus
  confirmation?: MemoryConfirmation; source?: Record<string, unknown>; replaces?: number
  /** 仅未来宿主专用入口可传；此字段不接 API/MCP。expectedRevision 校验 replaces 原条目。 */
  provenance?: MemoryProvenanceInput
  /** Actual host-observed memory dependencies; never accepted from API/MCP input. */
  derivedFrom?: readonly MemoryAncestor[]
}

export class MemoryOriginConflict extends Error {
  constructor() {
    super('记忆的来源范围不同，不能在更正或合并时去掉原来源。')
    this.name = 'MemoryOriginConflict'
  }
}

/** Host-confirmed loss of a source; never use this for a temporary verification failure. */
export type MemorySourceSelector =
  | { kind: 'user'; openId: string }
  | { kind: 'space'; spaceId: string }
  | { kind: 'message'; appId: string; chatId: string; messageId: string }
  | { kind: 'notes'; refs: readonly MemoryAncestor[] }

export class ChannelMemory {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA)
    const cols = (db.prepare('PRAGMA table_info(memory_notes)').all() as { name: string }[]).map((c) => c.name)
    if (!cols.includes('confirmation')) {
      // 旧版本的 confirmed 同时用于自动 QA、模型抽取和手工确认，source.by 不能区分它们。
      // 先留完整原表快照，再保守降为候选；不猜测确认人，也不修改原文、来源或历史时间。
      db.exec('SAVEPOINT memory_confirmation_v1')
      try {
        db.exec('CREATE TABLE IF NOT EXISTS memory_notes_before_confirmation_v1 AS SELECT * FROM memory_notes')
        if (!cols.includes('status')) db.exec(`ALTER TABLE memory_notes ADD COLUMN status TEXT NOT NULL DEFAULT 'candidate'`)
        if (!cols.includes('source')) db.exec('ALTER TABLE memory_notes ADD COLUMN source TEXT')
        if (!cols.includes('superseded_by')) db.exec('ALTER TABLE memory_notes ADD COLUMN superseded_by INTEGER')
        db.exec(`ALTER TABLE memory_notes ADD COLUMN confirmation TEXT;
          UPDATE memory_notes SET status = 'candidate' WHERE status = 'confirmed'`)
        db.exec('RELEASE memory_confirmation_v1')
      } catch (error) {
        db.exec('ROLLBACK TO memory_confirmation_v1; RELEASE memory_confirmation_v1')
        throw error
      }
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_notes(scope, status, kind)')
    migrateMemoryProvenance(db)
  }

  /**
   * 作用域串给人看的名字。新格式：`space:sp_dm_<open_id>` 个人、`space:sp_xxx` 空间、
   * `circle:<名字>` 联盟、`org` 企业；`chat:` / `user:` 是迁移前的老格式，兜底认一下。
   */
  static describeScope(scope: string): string {
    if (scope === ORG_SCOPE) return '企业'
    if (scope.startsWith('circle:')) return `联盟 ${scope.slice('circle:'.length)}`
    if (scope.startsWith('space:')) return scope.startsWith('space:sp_dm_') ? '个人' : '本空间'
    if (scope.startsWith('user:')) return '个人'
    return '本群'
  }

  add(input: MemoryAddInput): MemoryNote {
    return this.transaction(() => {
      if (input.expectedRevision !== undefined && input.replaces === undefined) throw new Error('expectedRevision 须指定被更正的记忆')
      const previous = input.replaces === undefined ? undefined : this.checkRevision(input.replaces, input.scope, input.expectedRevision)
      const provenance = initialProvenance(input.provenance)
      if (previous) {
        const original = this.getProvenance(previous.id)!
        const carried = new Set(provenance.sources.map(source => JSON.stringify(source)))
        if (original.state === 'unavailable' || original.state === 'verified' &&
          (provenance.state !== 'verified' || original.sources.some(source => !carried.has(JSON.stringify(source))))) {
          throw new MemoryOriginConflict()
        }
      }
      if (input.derivedFrom?.length) {
        provenance.ancestors = this.dependenciesForDerivation(input.derivedFrom, input.replaces ? [input.replaces] : [], input.provenance)
      }
      if (!previous) return this.insert(input, provenance)
      // Replacing a version is not permission to relabel its material as coming from this Run.
      // Keep the reader's original boundaries, including missing legacy metadata. The current
      // correction's actor/message is separate audit information, never a new read grant.
      const source: Record<string, unknown> = { ...input.source }
      for (const key of ['chatId', 'promotedFrom'] as const) {
        if (Object.hasOwn(previous.source ?? {}, key)) source[key] = previous.source![key]
        else delete source[key]
      }
      if (input.sessionKey !== undefined || input.source) {
        source.correction = { sessionKey: input.sessionKey ?? null, by: input.source?.by,
          messageId: input.source?.messageId, chatId: input.source?.chatId,
          generatedBy: input.source?.generatedBy }
      }
      return this.insert({ ...input, sessionKey: previous.sessionKey ?? undefined, source }, provenance)
    })
  }

  private insert(input: MemoryAddInput, provenance: Omit<MemoryProvenance, 'noteId'>, copiedFrom?: number): MemoryNote {
    const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 200)
    const body = input.body.trim().slice(0, MAX_NOTE_BODY)
    const now = Date.now()
    const confirmation = input.status === 'confirmed' && validConfirmation(input.confirmation, input.scope) ? input.confirmation : null
    const status = input.status === 'superseded' ? 'superseded' : confirmation ? 'confirmed' : 'candidate'
    const source = input.source || input.replaces ? JSON.stringify({ ...input.source, ...(input.replaces ? { replaces: input.replaces } : {}) }) : null
    const res = this.db
      .prepare('INSERT INTO memory_notes (scope, session_key, kind, title, body, created_at, status, source, confirmation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.scope, input.sessionKey ?? null, input.kind, title, body, now, status, source, confirmation ? JSON.stringify(confirmation) : null)
    const id = Number(res.lastInsertRowid)
    writeMemoryProvenance(this.db, id, provenance)
    recordMemoryChange(this.db, id, 1, copiedFrom === undefined ? 'created' : 'copied', now, copiedFrom)
    // 自动整理可以替代候选，但不能让派生条目撤销已确认事实；后者等人确认新条目。
    if (input.replaces) {
      const changed = this.db.prepare(`UPDATE memory_notes SET status = 'superseded', superseded_by = ?, revision = revision + 1 WHERE id = ? AND scope = ? AND (status = 'candidate' OR (status = 'confirmed' AND ? = 'confirmed'))`).run(id, input.replaces, input.scope, status)
      if (Number(changed.changes)) this.changed(input.replaces, 'superseded', now, id)
    }
    return this.rawGet(id)!
  }

  /** 旧消费者的读取入口；受管来源须等 C2 已授权读取入口接入。 */
  get(id: number): MemoryNote | undefined {
    const r = this.db.prepare(`SELECT * FROM memory_notes WHERE id = ? AND ${LEGACY_READ}`).get(id) as Record<string, unknown> | undefined
    return r ? toNote(r) : undefined
  }

  private rawGet(id: number): MemoryNote | undefined {
    const r = this.db.prepare('SELECT * FROM memory_notes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? toNote(r) : undefined
  }

  getProvenance(id: number): MemoryProvenance | undefined { return readMemoryProvenance(this.db, id) }

  /** Host control lookup: confirms the exact scoped target without exposing its remembered content. */
  /** The candidate that would replace this record once confirmed, if one is pending in the same scope. */
  pendingReplacementOf(id: number, scope: string): number | undefined {
    const row = this.db.prepare(`SELECT id FROM memory_notes WHERE scope = ? AND status = 'candidate' AND superseded_by IS NULL
      AND json_valid(source) AND json_extract(source, '$.replaces') = ? ORDER BY id DESC LIMIT 1`).get(scope, id) as { id: number } | undefined
    return row ? Number(row.id) : undefined
  }

  metadata(id: number, scope: string): Pick<MemoryNote, 'id' | 'scope' | 'revision' | 'status' | 'supersededBy'> | undefined {
    const row = this.db.prepare('SELECT id,scope,revision,status,superseded_by FROM memory_notes WHERE id=? AND scope=?').get(id, scope)
    return row ? { id: Number(row.id), scope: String(row.scope), revision: Number(row.revision),
      status: row.status as NoteStatus, supersededBy: row.superseded_by === null ? null : Number(row.superseded_by) } : undefined
  }

  /** Stops using every note containing the exact source, without deleting its stored history.
   * Only host-recorded provenance participates. Legacy source/by/messageId fields are not proof.
   * Descendants and their revision changes share this transaction; no external abort happens here.
   */
  invalidateSources(selector: MemorySourceSelector): number[] {
    const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
    let predicate = '', values: string[] = []
    switch (selector.kind) {
      case 'user':
        if (!nonempty(selector.openId)) throw new Error('来源失效需要明确的用户编号')
        predicate = "json_extract(s.value, '$.readIdentity.kind') = 'user' AND json_extract(s.value, '$.readIdentity.openId') = ?"
        values = [selector.openId]
        break
      case 'space':
        if (!nonempty(selector.spaceId)) throw new Error('来源失效需要明确的空间编号')
        predicate = "json_extract(s.value, '$.spaceId') = ?"
        values = [selector.spaceId]
        break
      case 'message':
        if (![selector.appId, selector.chatId, selector.messageId].every(nonempty)) throw new Error('来源失效需要完整的应用、群和消息编号')
        predicate = "json_extract(s.value, '$.appId') = ? AND json_extract(s.value, '$.chatId') = ? AND json_extract(s.value, '$.messageId') = ?"
        values = [selector.appId, selector.chatId, selector.messageId]
        break
      case 'notes':
        if (!Array.isArray(selector.refs) || selector.refs.some(ref => !Number.isSafeInteger(ref.id) || ref.id < 1 ||
          !Number.isSafeInteger(ref.revision) || ref.revision < 1)) throw new Error('来源失效需要准确的记忆编号和版本')
        break
      default: throw new Error('未知的来源失效类型')
    }
    return this.transaction(() => {
      const before = this.db.prepare('SELECT COALESCE(MAX(sequence),0) n FROM memory_changes').get() as { n: number }
      // A denial of one group's material must not invalidate every note owned by this user.
      // Validate the complete supplied snapshot before changing any direct note or descendant.
      if (selector.kind === 'notes') for (const ref of selector.refs) {
        const row = this.db.prepare(`SELECT n.revision,n.status,p.state FROM memory_notes n
          JOIN memory_provenance p ON p.note_id=n.id WHERE n.id=?`).get(ref.id) as
          { revision: number; status: string; state: string } | undefined
        if (!row || row.revision !== ref.revision || row.state === 'legacy_unverified' || row.status === 'superseded') {
          throw new MemoryRevisionConflict(ref.id, ref.revision, row?.revision ?? null)
        }
      }
      const matches = selector.kind === 'notes' ? [...new Set(selector.refs.map(ref => ref.id))].map(note_id => ({ note_id })) :
        this.db.prepare(`SELECT p.note_id FROM memory_provenance p JOIN memory_notes n ON n.id = p.note_id
        WHERE p.state != 'unavailable' AND EXISTS (SELECT 1 FROM json_each(p.sources_json) s WHERE ${predicate})
        ORDER BY p.note_id`).all(...values) as { note_id: number }[]
      const at = Date.now()
      for (const { note_id: id } of matches) {
        // An earlier original in this batch may already have invalidated this copy.
        const changed = this.db.prepare("UPDATE memory_provenance SET state = 'unavailable' WHERE note_id = ? AND state != 'unavailable'").run(id)
        if (!Number(changed.changes)) continue
        this.db.prepare('UPDATE memory_notes SET revision = revision + 1 WHERE id = ?').run(id)
        this.changed(id, 'source_unavailable', at)
      }
      return [...new Set(this.changes(Number(before.n)).filter(change => change.operation === 'source_unavailable')
        .map(change => change.noteId))].sort((a, b) => a - b)
    })
  }

  /** Host-only: compare exactly the boundaries understood by the existing audience reader.
   * Unknown legacy origins remain unknown; a known origin cannot be discarded into an unknown one.
   * Different group Sessions/requesters with the same real chat are the same audience.
   */
  assertSameMemoryOrigin(anchor: MemoryNote, others: readonly MemoryNote[]): void {
    const hasSessions = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get())
    const sessionOrigin = hasSessions ? this.db.prepare(`SELECT chat_id, chat_type,
      CASE WHEN chat_type = 'p2p' THEN requester_open_id ELSE NULL END AS requester_open_id
      FROM sessions WHERE session_key = ?`) : undefined
    const label = (note: MemoryNote, key: 'chatId' | 'promotedFrom') => {
      const value = note.source?.[key]
      return typeof value === 'string' && value !== '' ? value : null
    }
    const origin = (note: MemoryNote) => JSON.stringify({ scope: note.scope,
      chatId: label(note, 'chatId'), promotedFrom: label(note, 'promotedFrom'),
      session: note.sessionKey ? sessionOrigin?.get(note.sessionKey) ?? null : null })
    const expected = origin(anchor)
    if (others.some(note => origin(note) !== expected)) throw new MemoryOriginConflict()
  }

  /** Host-only: expand real dependencies before excluding claims consumed by a correction/merge. */
  dependenciesForDerivation(refs: readonly MemoryAncestor[], consumedIds: readonly number[] = [], managed?: MemoryProvenanceInput): MemoryAncestor[] {
    const carriedSources = new Set(managed?.sources.map(source => JSON.stringify(source)))
    const read = (id: number): MemoryNote | undefined => {
      const lineage = this.getProvenance(id)
      if (!lineage || lineage.state === 'unavailable') return undefined
      if (lineage.state === 'verified' && (managed?.state !== 'verified' || lineage.sources.some(source => !carriedSources.has(JSON.stringify(source))))) {
        throw new Error('派生记忆缺少原始来源')
      }
      return managed ? this.rawGet(id) : this.get(id)
    }
    const expanded = new Map<number, MemoryAncestor>()
    for (const ref of refs) {
      const note = read(ref.id), lineage = this.getProvenance(ref.id)
      if (!note || note.status === 'superseded' || note.revision !== ref.revision) {
        throw new MemoryRevisionConflict(ref.id, ref.revision, note?.revision ?? null)
      }
      for (const ancestor of [...lineage!.ancestors, ref]) {
        const current = read(ancestor.id)
        if (!current || current.status === 'superseded' || current.revision !== ancestor.revision) {
          throw new MemoryRevisionConflict(ancestor.id, ancestor.revision, current?.revision ?? null)
        }
        expanded.set(ancestor.id, { id: ancestor.id, revision: ancestor.revision })
      }
    }
    const consumed = new Set(consumedIds)
    const excluded = [...expanded.values()].filter(ref => consumed.has(ref.id)
      || this.getProvenance(ref.id)!.ancestors.some(ancestor => consumed.has(ancestor.id)))
    // A correction may stop depending on the old claim and its summaries, but cannot lose
    // a distinct source boundary carried by one of those summaries.
    const anchors = consumedIds.map(id => read(id)).filter((note): note is MemoryNote => Boolean(note))
    if (anchors.length) this.assertSameMemoryOrigin(anchors[0]!, [...anchors.slice(1), ...excluded.map(ref => read(ref.id)!)])
    const excludedIds = new Set(excluded.map(ref => ref.id))
    return [...expanded.values()].filter(ref => !excludedIds.has(ref.id))
      .sort((a, b) => a.id - b.id)
  }

  getTombstone(id: number): MemoryTombstone | undefined {
    const row = this.db.prepare('SELECT * FROM memory_tombstones WHERE note_id = ?').get(id) as Record<string, unknown> | undefined
    return row ? { noteId: Number(row.note_id), scope: String(row.scope), revision: Number(row.revision), forgottenAt: Number(row.forgotten_at) } : undefined
  }

  /** 宿主失效检查用的无正文变化记录，不对模型暴露。 */
  changes(afterSequence = 0): MemoryChange[] {
    const rows = this.db.prepare('SELECT * FROM memory_changes WHERE sequence > ? ORDER BY sequence').all(afterSequence) as Record<string, unknown>[]
    return rows.map((r) => ({ sequence: Number(r.sequence), noteId: Number(r.note_id), revision: Number(r.revision), operation: r.operation as MemoryChangeOperation,
      at: Number(r.at), relatedNoteId: r.related_note_id === null ? null : Number(r.related_note_id) }))
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('SAVEPOINT memory_write')
    try { const value = action(); this.db.exec('RELEASE memory_write'); return value }
    catch (error) { this.db.exec('ROLLBACK TO memory_write; RELEASE memory_write'); throw error }
  }

  private checkRevision(id: number, scope: string, expected?: number): MemoryNote | undefined {
    const note = this.rawGet(id)
    const current = note?.scope === scope ? note : undefined
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 1 || current?.revision !== expected)) {
      throw new MemoryRevisionConflict(id, expected, current?.revision ?? null)
    }
    return current
  }

  private changed(id: number, operation: MemoryChangeOperation, at: number, relatedId?: number): void {
    const note = this.rawGet(id)!
    recordMemoryChange(this.db, id, note.revision, operation, at, relatedId)
    this.invalidateCopies(id, note.revision, at)
  }

  /** 新复制品已展开祖先；原条目版本变化后停用所有范围的旧副本，不抄正文进日志。 */
  private invalidateCopies(id: number, revision: number, at: number): void {
    const rows = this.db.prepare(`SELECT n.id FROM memory_notes n JOIN memory_provenance p ON p.note_id = n.id
      WHERE p.state != 'unavailable' AND EXISTS (SELECT 1 FROM json_each(p.ancestor_notes_json) a
        WHERE json_extract(a.value, '$.id') = ? AND json_extract(a.value, '$.revision') < ?)`)
      .all(id, revision) as { id: number }[]
    for (const row of rows) {
      this.db.prepare(`UPDATE memory_provenance SET state = 'unavailable' WHERE note_id = ?`).run(row.id)
      this.db.prepare('UPDATE memory_notes SET revision = revision + 1 WHERE id = ?').run(row.id)
      recordMemoryChange(this.db, row.id, this.rawGet(row.id)!.revision, 'source_unavailable', at, id)
    }
  }

  /** 全文检索（一个或多个作用域）；查询词短于 3 个字符时退化为 LIKE。 */
  search(scope: string | string[], query: string, limit = 8): MemoryNote[] {
    return this.searchNotes(scope, query, limit, 'history')
  }

  private searchNotes(scope: string | string[], query: string, limit: number, purpose: 'history' | 'prompt'): MemoryNote[] {
    const scopes = Array.isArray(scope) ? scope : [scope]
    if (!scopes.length) return []
    const q = query.trim()
    const marks = scopes.map(() => '?').join(', ')
    // 旧回答保留为可查询历史，但未经确认的模型答案不自动回流为下一轮依据。
    // 在 LIMIT 前筛选，避免大量旧 QA 挤掉仍可用的事实和已确认答案。
    const eligible = purpose === 'prompt' ? `${LIVE} AND (kind != 'qa' OR status = 'confirmed')` : LIVE
    if (!q) {
      const rows = this.db.prepare(`SELECT * FROM memory_notes WHERE scope IN (${marks}) AND ${eligible} AND ${LEGACY_READ} ORDER BY created_at DESC LIMIT ?`)
        .all(...scopes, limit) as Record<string, unknown>[]
      return rows.map(toNote)
    }
    const terms = q.split(/\s+/).filter((t) => t.length >= 3)
    if (terms.length) {
      const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
      try {
        const rows = this.db
          .prepare(
            `SELECT n.* FROM memory_fts f JOIN memory_notes n ON n.id = f.rowid
             WHERE memory_fts MATCH ? AND n.scope IN (${marks}) AND n.${eligible} AND ${legacyMemoryReadPredicate('n')} ORDER BY bm25(memory_fts) LIMIT ?`,
          )
          .all(match, ...scopes, limit) as Record<string, unknown>[]
        if (rows.length) return rows.map(toNote)
      } catch {
        /* 语法错误退化为 LIKE */
      }
    }
    const like = `%${q.replace(/[%_]/g, '')}%`
    const rows = this.db
      .prepare(`SELECT * FROM memory_notes WHERE scope IN (${marks}) AND ${eligible} AND ${LEGACY_READ} AND (title LIKE ? OR body LIKE ?) ORDER BY created_at DESC LIMIT ?`)
      .all(...scopes, like, like, limit) as Record<string, unknown>[]
    return rows.map(toNote)
  }

  recent(scope: string | string[], limit = 8): MemoryNote[] {
    const scopes = Array.isArray(scope) ? scope : [scope]
    if (!scopes.length) return []
    const marks = scopes.map(() => '?').join(', ')
    const rows = this.db.prepare(`SELECT * FROM memory_notes WHERE scope IN (${marks}) AND ${LIVE} AND ${LEGACY_READ} ORDER BY created_at DESC LIMIT ?`).all(...scopes, limit) as Record<string, unknown>[]
    return rows.map(toNote)
  }

  /**
   * Browser disclosure keeps the legacy compatibility boundary, but excludes known
   * foreign origins before pagination/count. Missing legacy source/session evidence
   * is still unverified, not proof of source authorization. Managed sources remain closed.
   */
  recentForAudience(audience: MemoryAudience, limit = 100): { items: MemoryNote[]; total: number } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('记忆分页条数须为 1–1000')
    const hasSessions = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get())
    // These are fixed SQL aliases. Neither identifiers nor SQL come from caller input.
    const foreignOrigin = (alias: string): string => {
      const source = `(CASE WHEN json_valid(${alias}.source) THEN ${alias}.source ELSE '{}' END)`
      const chat = `json_extract(${source}, '$.chatId')`, promoted = `json_extract(${source}, '$.promotedFrom')`
      return `(
        (json_type(${source}, '$.chatId') = 'text' AND ${chat} != '' AND ${chat} IS NOT $chatId)
        OR (json_type(${source}, '$.promotedFrom') = 'text' AND ${promoted} != '' AND ${promoted} != $scope)
        ${hasSessions ? `OR EXISTS (SELECT 1 FROM sessions origin WHERE origin.session_key = ${alias}.session_key
          AND (origin.chat_id IS NOT $chatId OR origin.chat_type != $chatType
            OR ($chatType = 'p2p' AND origin.requester_open_id IS NOT $openId)))` : ''}
      )`
    }
    const where = `n.scope = $scope AND n.${LIVE} AND ${legacyMemoryReadPredicate('n')}
      AND NOT COALESCE(${foreignOrigin('n')}, 0)
      AND NOT EXISTS (SELECT 1 FROM memory_provenance lineage, json_each(lineage.ancestor_notes_json) ancestor_ref
        JOIN memory_notes ancestor ON ancestor.id = json_extract(ancestor_ref.value, '$.id')
        WHERE lineage.note_id = n.id AND (ancestor.scope != $scope OR ${foreignOrigin('ancestor')}))`
    const params = { scope: audience.scope, chatId: audience.chatId,
      ...(hasSessions ? { chatType: audience.chatType, openId: audience.openId } : {}) }
    const rows = this.db.prepare(`SELECT n.* FROM memory_notes n WHERE ${where} ORDER BY n.created_at DESC,n.id DESC LIMIT $limit`)
      .all({ ...params, limit }) as Record<string, unknown>[]
    const count = this.db.prepare(`SELECT COUNT(*) total FROM memory_notes n WHERE ${where}`).get(params) as { total: number }
    return { items: rows.map(toNote), total: Number(count.total) }
  }

  count(scope: string): number {
    const r = this.db.prepare(`SELECT COUNT(*) c FROM memory_notes WHERE scope = ? AND ${LIVE} AND ${LEGACY_READ}`).get(scope) as { c: number }
    return Number(r.c)
  }

  /** 常驻规则（"以后遇到 xx 都要 yy"）：不按相关性筛，每个新会话都带上。只取已确认的。 */
  rules(scope: string, limit = 12): MemoryNote[] {
    const rows = this.db.prepare(`SELECT * FROM memory_notes WHERE scope = ? AND kind = 'rule' AND status = 'confirmed' AND ${LEGACY_READ} ORDER BY created_at DESC LIMIT ?`).all(scope, limit) as Record<string, unknown>[]
    return rows.map(toNote).filter((note) => note.status === 'confirmed')
  }

  /** 有界的近期偏好；不升级候选状态，受管来源仍须通过专用 reader。 */
  profiles(scope: string, limit = 3): MemoryNote[] {
    const rows = this.db.prepare(`SELECT * FROM memory_notes WHERE scope = ? AND kind = 'profile'
      AND ${LIVE} AND ${LEGACY_READ} ORDER BY created_at DESC, id DESC LIMIT ?`).all(scope, limit) as Record<string, unknown>[]
    return rows.map(toNote)
  }

  /**
   * 哪些作用域攒了够多待确认的记录，值得夜间整理一次。
   * 只看 candidate：confirmed 是人说过的，不该被半夜的自动整理动。
   */
  scopesNeedingReview(minCount = 3, olderThanMs?: number): { scope: string; count: number }[] {
    const rows = (olderThanMs === undefined
      ? this.db.prepare(`SELECT scope, COUNT(*) c FROM memory_notes WHERE status = 'candidate' AND ${LEGACY_READ} GROUP BY scope HAVING c >= ?`).all(minCount)
      : this.db.prepare(`SELECT scope, COUNT(*) c FROM memory_notes WHERE status = 'candidate' AND ${LEGACY_READ} AND created_at <= ? GROUP BY scope HAVING c >= ?`).all(olderThanMs, minCount)) as { scope: string; c: number }[]
    return rows.map((r) => ({ scope: String(r.scope), count: Number(r.c) }))
  }

  /** 某段时间内新确认的笔记（周报用）。按人的确认时间取，两端都含；创建时间不代表确认。 */
  confirmedBetween(scope: string | string[], fromMs: number, toMs: number, kinds?: NoteKind[], limit = 50): MemoryNote[] {
    const scopes = Array.isArray(scope) ? scope : [scope]
    if (!scopes.length) return []
    const marks = scopes.map(() => '?').join(', ')
    const kindFilter = kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : ''
    const confirmedAt = `CASE WHEN json_valid(confirmation) THEN json_extract(confirmation, '$.at') END`
    const rows = this.db
      .prepare(`SELECT * FROM memory_notes WHERE scope IN (${marks}) AND status = 'confirmed' AND ${LEGACY_READ} AND ${confirmedAt} >= ? AND ${confirmedAt} <= ?${kindFilter} ORDER BY ${confirmedAt} DESC LIMIT ?`)
      .all(...scopes, fromMs, toMs, ...(kinds ?? []), limit) as Record<string, unknown>[]
    return rows.map(toNote).filter((note) => note.status === 'confirmed')
  }

  /** 待确认的自动记录（夜间整理 / !memory 里给人看）。 */
  candidates(scope: string, limit = 50): MemoryNote[] {
    const rows = this.db.prepare(`SELECT * FROM memory_notes WHERE scope = ? AND status = 'candidate' AND ${LEGACY_READ} ORDER BY created_at DESC LIMIT ?`).all(scope, limit) as Record<string, unknown>[]
    return rows.map(toNote)
  }

  confirm(id: number, scope: string, input: { by: string; messageId: string } & MemoryWriteOptions): boolean {
    const confirmation = { by: input.by, messageId: input.messageId, at: Date.now() }
    if (!validConfirmation(confirmation, scope)) return false
    return this.transaction(() => {
      const note = this.checkRevision(id, scope, input.expectedRevision)
      if (!note || note.status !== 'candidate') return false
      // Confirmation records a person's decision; it cannot restore revoked
      // source authority or supersede a still-valid rule with an unusable draft.
      if (this.getProvenance(id)?.state === 'unavailable') return false
      // 复制保留原 source 供追溯，但原作用域的更正关系不是新副本的更正操作。
      const copied = this.db.prepare("SELECT 1 FROM memory_changes WHERE note_id = ? AND operation = 'copied'").get(id)
      const replaces = copied ? undefined : note.source?.replaces
      if (typeof replaces === 'number') {
        const previous = this.rawGet(replaces)
        // 旧候选可已被本条替代；其他更正先获确认或原记录被删除后，不能再确认这条过期更正。
        if (!previous || previous.scope !== scope || (previous.status === 'superseded' && previous.supersededBy !== id)) {
          return false
        }
      }
      const changed = Number(this.db.prepare(`UPDATE memory_notes SET status = 'confirmed', confirmation = ?, revision = revision + 1 WHERE id = ? AND scope = ? AND status = 'candidate'`).run(JSON.stringify(confirmation), id, scope).changes) > 0
      if (changed) {
        this.changed(id, 'confirmed', confirmation.at)
        if (typeof replaces === 'number') {
          const previousChanged = this.db.prepare(`UPDATE memory_notes SET status = 'superseded', superseded_by = ?, revision = revision + 1 WHERE id = ? AND scope = ? AND ${LIVE}`).run(id, replaces, scope)
          if (Number(previousChanged.changes)) this.changed(replaces, 'superseded', confirmation.at, id)
        }
      }
      return changed
    })
  }

  remove(id: number, scope: string, options: MemoryWriteOptions = {}): boolean {
    return this.transaction(() => {
      const note = this.checkRevision(id, scope, options.expectedRevision)
      if (!note) return false
      const revision = note.revision + 1, at = Date.now()
      this.db.prepare('INSERT INTO memory_tombstones (note_id, scope, revision, forgotten_at) VALUES (?, ?, ?, ?)').run(id, scope, revision, at)
      recordMemoryChange(this.db, id, revision, 'forgotten', at)
      this.invalidateCopies(id, revision, at)
      this.db.prepare('DELETE FROM memory_notes WHERE id = ?').run(id)
      this.db.prepare('DELETE FROM memory_provenance WHERE note_id = ?').run(id)
      return true
    })
  }

  /**
   * 这条记忆能不能进**企业层**（全公司可见）。
   *
   * 规则：组织公共知识只接收逐个批准的完全公开空间，私聊和私密群不进入。
   * 原来只实现了"逐个批准"那一半——`promote` 只问"你是不是全局管理员"，
   * 不问这条记忆里的内容是从哪来的。
   *
   * 缺的那一半按**来源**判，不按空间判，因为真正会出事的是内容而不是位置：
   * 私聊里 Friday 能用你的身份读你有权限的一切——你在的群、你的文档、你的妙记。
   * 那些东西"你看得到"，不等于"全公司看得到"。把它们晋升上去，
   * 等于用你的权限给所有人开了一扇窗，而原来那个群里的人根本不知道。
   *
   * 反过来，私聊里总结出来的通用东西（"我们的发布流程是这样"）没有外部来源，
   * 拦住它是没道理的。所以判的是来源，不是"私聊一律不许"。
   *
   * 这和自动路径上的 `hasExternalContext` 是**同一条规则**——那边读了外部内容就不存派生记忆，
   * 只是手动晋升这条路当初漏了。
   *
   * 没有来源记录的旧条目（`legacy_unverified` 且 sources 为空）放行，但调用方要把
   * "这条没有来源记录"说给人听：证明不了不等于有问题，但也不该假装核对过。
   */
  externalSourcesFor(id: number, homeChatId?: string | null): { blocked: MemorySourceReference[]; unverified: boolean } {
    const provenance = this.getProvenance(id)
    if (!provenance) return { blocked: [], unverified: true }
    if (!provenance.sources.length) return { blocked: [], unverified: provenance.state === 'legacy_unverified' }
    const blocked = provenance.sources.filter((source) => {
      // 以**某个人的身份**读到的，本质上是"他有权限看见的"，不是公共的
      if (source.readIdentity?.kind === 'user') return true
      // 从别的会话读来的：那个会话里的人并不知道这件事会进全公司
      return Boolean(source.chatId && homeChatId && source.chatId !== homeChatId)
    })
    return { blocked, unverified: false }
  }

  /** 晋升：把一条笔记复制到更大的作用域（群 → 空间 / 企业），原条目保留；来源里记从哪来。 */
  promote(id: number, fromScope: string, toScope: string, by?: string, options: MemoryWriteOptions = {}): MemoryNote | undefined {
    return this.transaction(() => {
      const note = this.checkRevision(id, fromScope, options.expectedRevision)
      if (!note || note.status === 'superseded') return undefined
      const provenance = this.getProvenance(id)
      if (!provenance || provenance.state === 'unavailable') return undefined
      // 新记录去重只信本 store 登记的复制血缘；旧记录在下一步单独核对内容等价。
      const dup = this.db.prepare(`SELECT n.id FROM memory_notes n JOIN memory_provenance p ON p.note_id = n.id
        WHERE n.scope = ? AND n.${LIVE} AND p.state != 'unavailable' AND json_extract(n.source, '$.noteId') = ?
        AND EXISTS (SELECT 1 FROM json_each(p.ancestor_notes_json) a WHERE json_extract(a.value, '$.id') = ? AND json_extract(a.value, '$.revision') = ?)`)
        .get(toScope, id, id, note.revision) as { id: number } | undefined
      if (dup) return this.rawGet(Number(dup.id))
      const legacy = this.legacyPromotion(note, toScope)
      if (legacy) return legacy
      const ancestors = [...provenance.ancestors.filter((a) => a.id !== id), { id, revision: note.revision }]
      return this.insert({ scope: toScope, sessionKey: note.sessionKey ?? undefined, kind: note.kind, title: note.title, body: note.body,
        status: note.status, confirmation: note.confirmation ?? undefined, source: { ...note.source, promotedFrom: fromScope, noteId: id, by } },
      { ...provenance, ancestors }, id)
    })
  }

  /** 旧分享只做内容等价的零写复用，不追认可信来源或祖先。冲突不能靠再建一份掩盖。 */
  private legacyPromotion(note: MemoryNote, toScope: string): MemoryNote | undefined {
    const rows = this.db.prepare(`SELECT n.* FROM memory_notes n WHERE n.scope = ?
      AND CASE WHEN json_valid(n.source) THEN json_extract(n.source, '$.noteId') END = ?
      AND NOT EXISTS (SELECT 1 FROM memory_changes c WHERE c.note_id = n.id AND c.operation IN ('created', 'copied'))`)
      .all(toScope, note.id) as Record<string, unknown>[]
    if (!rows.length) return undefined
    if (rows.length !== 1) throw new MemoryPromotionConflict(note.id, toScope)
    const row = rows[0]!, copy = toNote(row), provenance = this.getProvenance(copy.id)
    const hasChanges = this.db.prepare('SELECT 1 FROM memory_changes WHERE note_id = ? LIMIT 1').get(copy.id)
    const expectedProof = note.status === 'confirmed' && validConfirmation(note.confirmation, toScope) ? note.confirmation : null
    const sameProof = expectedProof === null ? copy.confirmation === null && row.confirmation === null
      : copy.confirmation?.by === expectedProof.by && copy.confirmation.messageId === expectedProof.messageId && copy.confirmation.at === expectedProof.at
    if (!hasChanges && provenance?.state === 'legacy_unverified' && !provenance.ancestors.length
      && !provenance.sources.length && provenance.originRunId === null
      && copy.source?.promotedFrom === note.scope && copy.source?.noteId === note.id
      && copy.sessionKey === note.sessionKey && copy.kind === note.kind && copy.title === note.title && copy.body === note.body
      && row.status === (expectedProof ? 'confirmed' : 'candidate') && sameProof && copy.supersededBy === null) return copy
    throw new MemoryPromotionConflict(note.id, toScope)
  }

  /**
   * 注入各层的常驻规则、有界近期偏好，再加与本次问题相关的笔记。
   * 未确认的 QA 不自动注入；其他未确认条目标出来，模型引用时要说明"未经确认"。
   */
  renderForPrompt(scopes: ScopeSpec[] | string, query: string, limit = 6): string {
    return this.composeForPrompt(scopes, query, limit).text
  }

  /**
   * 同上，但连"这次用了什么"一起返回（ContextReceipt 的记忆部分，`!why` 用它回答"你怎么知道的"）。
   */
  composeForPrompt(scopes: ScopeSpec[] | string, query: string, limit = 6): { text: string; used: MemoryUsage } {
    const specs: ScopeSpec[] = typeof scopes === 'string' ? [{ scope: scopes, label: ChannelMemory.describeScope(scopes) }] : scopes
    const parts: string[] = []
    const layers: MemoryUsage['layers'] = []
    const usedRules: MemoryNote[] = []
    const usedProfiles = new Map<number, MemoryNote>()
    for (const s of specs) {
      const rules = this.rules(s.scope)
      const profiles = this.profiles(s.scope, 4)
      for (const note of profiles.slice(0, 3)) usedProfiles.set(note.id, note)
      usedRules.push(...rules)
      layers.push({ scope: s.scope, label: s.label, rules: rules.length, hits: 0, total: this.count(s.scope),
        ...(profiles.length ? { profiles: Math.min(3, profiles.length), profilesTruncated: profiles.length > 3 } : {}) })
      if (rules.length) parts.push(`[常驻要求（${s.label}）：每次都要遵守]\n${rules.map((n) => `- ${n.title}${n.body && n.body !== n.title ? `：${n.body.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`).join('\n')}`)
      if (profiles.length > 3) parts.push(`[${s.label}的近期偏好仅取最新 3 条；其余可按需检索。]`)
    }
    const hits = this.searchNotes(
      specs.map((s) => s.scope),
      query,
      limit,
      'prompt',
    ).filter((n) => n.kind !== 'rule' && !usedProfiles.has(n.id))
    const labelOf = new Map(specs.map((s) => [s.scope, s.label]))
    for (const n of hits) {
      const layer = layers.find((l) => l.scope === n.scope)
      if (layer) layer.hits += 1
    }
    const notes = [...usedProfiles.values(), ...hits]
    if (notes.length) {
      const lines = notes.map((n) => `- [${fmtDate(n.createdAt)} · ${n.kind}${specs.length > 1 ? ` · ${labelOf.get(n.scope) ?? n.scope}` : ''}${n.status === 'candidate' ? ' · 自动记录未确认' : ''}] ${n.title}\n  ${n.body.replace(/\s+/g, ' ').slice(0, 300)}`)
      parts.push(`[记忆：过去相关的问答与结论，仅供参考，以最新信息为准]\n${lines.join('\n')}\n` +
        '标了"自动记录未确认"的是你自己从聊天里推断、本人没确认过的：用到时顺口带一句（「我记着…，你没确认过」），不把"未确认"当标签念、不在开头先说明这件事。' +
        '本人问「你记得我哪些事」时，开头就是第一条，不写总述句；每条一行，用本人自己的话，不带编号、种类和时间。')
    }
    return {
      text: parts.join('\n\n'),
      used: { layers, notes: [...new Map([...usedRules, ...notes].map((note) => [note.id, note])).values()]
        .map((n) => ({ id: n.id, revision: n.revision, title: n.title, scope: n.scope, label: labelOf.get(n.scope) ?? n.scope, status: n.status })) },
    }
  }
}

/** Count-only availability for the authenticated user's personal memory; never includes inactive content. */
export interface MemoryAvailability {
  inactiveNotes: number
  temporarilyUnavailableNotes: number
}

/** 这一轮实际用到的记忆（写进 ContextReceipt） */
export interface MemoryUsage {
  layers: { scope: string; label: string; rules: number; hits: number; total: number; profiles?: number; profilesTruncated?: boolean }[]
  notes: { id: number; revision: number; title: string; scope: string; label: string; status: NoteStatus }[]
  availability?: MemoryAvailability
}

function toNote(r: Record<string, unknown>): MemoryNote {
  let source: Record<string, unknown> | null = null
  if (typeof r.source === 'string' && r.source) {
    try {
      source = JSON.parse(r.source) as Record<string, unknown>
    } catch {
      source = null
    }
  }
  let confirmation: MemoryConfirmation | null = null
  try {
    const parsed = typeof r.confirmation === 'string' ? JSON.parse(r.confirmation) : null
    if (validConfirmation(parsed, String(r.scope))) confirmation = parsed
  } catch { /* 无可信确认记录时保留为候选。 */ }
  return {
    id: Number(r.id),
    revision: Number(r.revision),
    scope: String(r.scope),
    sessionKey: (r.session_key as string | null) ?? null,
    kind: r.kind as NoteKind,
    title: String(r.title),
    body: String(r.body),
    status: r.status === 'superseded' ? 'superseded' : r.status === 'confirmed' && confirmation ? 'confirmed' : 'candidate',
    confirmation,
    source,
    supersededBy: r.superseded_by === null || r.superseded_by === undefined ? null : Number(r.superseded_by),
    createdAt: Number(r.created_at),
  }
}

function validConfirmation(value: unknown, scope: string): value is MemoryConfirmation {
  if (!value || typeof value !== 'object') return false
  const proof = value as Partial<MemoryConfirmation>
  if (typeof proof.by !== 'string' || !proof.by.trim() || typeof proof.messageId !== 'string' || !proof.messageId.trim() || !Number.isFinite(proof.at)) return false
  const owner = scope.startsWith('space:sp_dm_') ? scope.slice('space:sp_dm_'.length) : scope.startsWith('user:') ? scope.slice('user:'.length) : undefined
  return !owner || proof.by === owner
}

export function fmtDate(ms: number, tz = 'Asia/Shanghai'): string {
  return new Date(ms).toLocaleString('zh-CN', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
