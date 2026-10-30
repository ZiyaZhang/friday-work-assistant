/**
 * C1 只登记版本、可信来源和复制血缘，不执行平台授权查询。
 * 旧记录保留 legacy_unverified 和原有读取行为；verified/unavailable 记录均不进入旧同步读入口。
 * verified 仅表示宿主登记时核验过，不代表现在仍有权限。C2 接入逐次授权和上下文重建前，
 * 不能开放跨群记忆，也不能声称更正/忘记已清除旧 ACP 历史或同 UID 可读文件。
 * 这些类型和查询仅供宿主使用，不应映射为模型可填写的来源字段或公开 MCP 工具。
 */
import type { DatabaseSync } from 'node:sqlite'

export interface MemoryAncestor { id: number; revision: number }
export interface MemorySourceReference {
  ref: string
  tenantId: string
  appId: string
  spaceId: string | null
  chatId: string | null
  messageId?: string
  threadId?: string
  rootId?: string
  readIdentity: { kind: 'user'; openId: string } | { kind: 'app' }
  readAt: number
  coverage: 'complete' | 'partial' | 'unknown'
  revision?: string
  contentDigest?: string
}
/** 未来已核验宿主入口专用；来源不可从 note.source 或 replaces 推导。 */
export interface MemoryProvenanceInput {
  state: 'verified' | 'unavailable'
  originRunId: string
  sources: readonly MemorySourceReference[]
}
export interface MemoryProvenance {
  noteId: number
  state: 'legacy_unverified' | 'verified' | 'unavailable'
  originRunId: string | null
  sources: MemorySourceReference[]
  ancestors: MemoryAncestor[]
}
export type MemoryChangeOperation = 'created' | 'confirmed' | 'superseded' | 'forgotten' | 'copied' | 'source_unavailable'
export interface MemoryChange {
  sequence: number
  noteId: number
  revision: number
  operation: MemoryChangeOperation
  at: number
  relatedNoteId: number | null
}
export interface MemoryTombstone { noteId: number; scope: string; revision: number; forgottenAt: number }

export class MemoryRevisionConflict extends Error {
  constructor(readonly noteId: number, readonly expectedRevision: number, readonly actualRevision: number | null) {
    super(`记忆 #${noteId} 版本已变化，请重新读取后再操作`)
    this.name = 'MemoryRevisionConflict'
  }
}

export class MemoryPromotionConflict extends Error {
  constructor(readonly noteId: number, readonly targetScope: string) {
    super(`记忆 #${noteId} 已有分享记录，但内容或状态不一致，请先查看现有记录`)
    this.name = 'MemoryPromotionConflict'
  }
}

export function migrateMemoryProvenance(db: DatabaseSync): void {
  db.exec('SAVEPOINT memory_provenance_v1')
  try {
    const cols = db.prepare('PRAGMA table_info(memory_notes)').all() as { name: string }[]
    if (!cols.some((col) => col.name === 'revision')) db.exec('ALTER TABLE memory_notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_provenance (
        note_id INTEGER PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('legacy_unverified', 'verified', 'unavailable')),
        origin_run_id TEXT,
        sources_json TEXT NOT NULL,
        ancestor_notes_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_changes (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        operation TEXT NOT NULL,
        at INTEGER NOT NULL,
        related_note_id INTEGER,
        UNIQUE(note_id, revision)
      );
      CREATE TABLE IF NOT EXISTS memory_tombstones (
        note_id INTEGER PRIMARY KEY,
        scope TEXT NOT NULL,
        revision INTEGER NOT NULL,
        forgotten_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO memory_provenance (note_id, state, origin_run_id, sources_json, ancestor_notes_json)
        SELECT id, 'legacy_unverified', NULL, '[]', '[]' FROM memory_notes;
    `)
    db.exec('RELEASE memory_provenance_v1')
  } catch (error) {
    db.exec('ROLLBACK TO memory_provenance_v1; RELEASE memory_provenance_v1')
    throw error
  }
}

/** SQL 固定片段：所有旧消费者须在 LIMIT/COUNT 前排除未接授权入口的受管来源。 */
export function legacyMemoryReadPredicate(alias = 'memory_notes'): string {
  return `EXISTS (SELECT 1 FROM memory_provenance mp WHERE mp.note_id = ${alias}.id AND mp.state = 'legacy_unverified')`
}

export function readMemoryProvenance(db: DatabaseSync, id: number): MemoryProvenance | undefined {
  const row = db.prepare('SELECT * FROM memory_provenance WHERE note_id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return undefined
  return { noteId: Number(row.note_id), state: row.state as MemoryProvenance['state'], originRunId: row.origin_run_id as string | null,
    sources: JSON.parse(String(row.sources_json)) as MemorySourceReference[], ancestors: JSON.parse(String(row.ancestor_notes_json)) as MemoryAncestor[] }
}

export function initialProvenance(input?: MemoryProvenanceInput): Omit<MemoryProvenance, 'noteId'> {
  if (!input) return { state: 'legacy_unverified', originRunId: null, sources: [], ancestors: [] }
  if (!['verified', 'unavailable'].includes(input.state) || !nonempty(input.originRunId) || !input.sources.length) throw new Error('受管记忆须有宿主 Run 和真实来源')
  for (const source of input.sources) {
    if (!nonempty(source.ref) || !nonempty(source.tenantId) || !nonempty(source.appId) || !Number.isFinite(source.readAt)
      || !['complete', 'partial', 'unknown'].includes(source.coverage)
      || !source.readIdentity || !['user', 'app'].includes(source.readIdentity.kind)
      || (source.readIdentity.kind === 'user' && !nonempty(source.readIdentity.openId))) throw new Error('记忆来源元数据不完整')
  }
  // 同步复制，调用方随后修改对象不能更改已登记的来源。
  return { state: input.state, originRunId: input.originRunId, sources: structuredClone([...input.sources]), ancestors: [] }
}

export function writeMemoryProvenance(db: DatabaseSync, noteId: number, value: Omit<MemoryProvenance, 'noteId'>): void {
  db.prepare('INSERT INTO memory_provenance (note_id, state, origin_run_id, sources_json, ancestor_notes_json) VALUES (?, ?, ?, ?, ?)')
    .run(noteId, value.state, value.originRunId, JSON.stringify(value.sources), JSON.stringify(value.ancestors))
}

export function recordMemoryChange(db: DatabaseSync, noteId: number, revision: number, operation: MemoryChangeOperation, at: number, relatedNoteId?: number): void {
  db.prepare('INSERT INTO memory_changes (note_id, revision, operation, at, related_note_id) VALUES (?, ?, ?, ?, ?)')
    .run(noteId, revision, operation, at, relatedNoteId ?? null)
}

function nonempty(value: unknown): value is string { return typeof value === 'string' && !!value.trim() }
