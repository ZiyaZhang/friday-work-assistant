import type { DatabaseSync } from 'node:sqlite'
import { memoryNoteFromRow, type MemoryNote } from './memory.js'
import { MemoryRevisionConflict, readMemoryProvenance, type MemoryAncestor, type MemoryProvenance } from './memory-provenance.js'

export interface ManagedMemoryMetadata extends MemoryAncestor {
  scope: string
  provenance: MemoryProvenance
}
export interface ManagedMemoryQuery { query: string; limit: number; purpose: 'history' | 'prompt' }

/** Host-only, read-only access to managed rows after authorization. Existing legacy reads stay closed. */
export class ManagedMemoryStorage {
  constructor(private readonly db: DatabaseSync) {}

  /** Intentionally does not SELECT title/body/confirmation/source from memory_notes. */
  metadata(scope: string): ManagedMemoryMetadata[] {
    const rows = this.db.prepare(`SELECT n.id,n.revision,n.scope FROM memory_notes n
      JOIN memory_provenance p ON p.note_id=n.id
      WHERE n.scope=? AND n.status IN ('candidate','confirmed') AND p.state='verified' ORDER BY n.id`)
      .all(scope) as { id: number; revision: number; scope: string }[]
    return rows.map(row => ({ ...row, provenance: readMemoryProvenance(this.db, row.id)! }))
  }

  /** Human display can include the exact replaced version, never a forgotten row. */
  presentationMetadata(scope: string, ids: readonly number[]): ManagedMemoryMetadata[] {
    const rows = this.db.prepare(`SELECT n.id,n.revision,n.scope FROM memory_notes n JOIN memory_provenance p ON p.note_id=n.id
      WHERE n.scope=? AND n.status IN ('candidate','confirmed','superseded') AND p.state='verified'
        AND n.id IN (SELECT value FROM json_each(?))`).all(scope, JSON.stringify(ids)) as {id:number; revision:number; scope:string}[]
    return rows.map(row => ({ ...row, provenance: readMemoryProvenance(this.db, row.id)! }))
  }

  readPresentation(scope: string, refs: readonly MemoryAncestor[]): MemoryNote[] {
    const current = this.presentationMetadata(scope, refs.map(ref => ref.id))
    for (const ref of refs) if (!current.some(note => note.id === ref.id && note.revision === ref.revision)) throw new MemoryRevisionConflict(ref.id, ref.revision, null)
    if (!refs.length) return []
    return this.db.prepare('SELECT * FROM memory_notes WHERE scope=? AND id IN (SELECT value FROM json_each(?))')
      .all(scope, JSON.stringify(refs.map(ref => ref.id))).map(memoryNoteFromRow)
  }

  /** Safe aggregate only. Forgotten/superseded notes and other scopes do not contribute. */
  countUnavailable(scope: string): number {
    return Number((this.db.prepare(`SELECT COUNT(*) total FROM memory_notes n
      JOIN memory_provenance p ON p.note_id=n.id
      WHERE n.scope=? AND n.status IN ('candidate','confirmed') AND p.state='unavailable'`)
      .get(scope) as { total: number }).total)
  }

  /** Warm-context preflight: never substitute a newer version or read a body. */
  metadataForRefs(scope: string, refs: readonly MemoryAncestor[]): ManagedMemoryMetadata[] {
    this.assertCurrent(scope, refs)
    return refs.map(ref => ({ ...ref, scope, provenance: readMemoryProvenance(this.db, ref.id)! }))
  }

  assertCurrent(scope: string, refs: readonly MemoryAncestor[]): void {
    for (const ref of refs) {
      const row = this.db.prepare(`SELECT n.revision,n.status,p.state FROM memory_notes n
        JOIN memory_provenance p ON p.note_id=n.id WHERE n.id=? AND n.scope=?`).get(ref.id, scope) as
        { revision: number; status: string; state: string } | undefined
      if (!Number.isSafeInteger(ref.id) || ref.id < 1 || !Number.isSafeInteger(ref.revision) || ref.revision < 1 ||
        !row || row.revision !== ref.revision || row.state !== 'verified' || !['candidate', 'confirmed'].includes(row.status)) {
        throw new MemoryRevisionConflict(ref.id, ref.revision, row?.revision ?? null)
      }
    }
  }

  search(scope: string, refs: readonly MemoryAncestor[], input: ManagedMemoryQuery): { notes: MemoryNote[]; total: number } {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error('记忆查询条数须为 1–100')
    this.assertCurrent(scope, refs)
    if (!refs.length) return { notes: [], total: 0 }
    const where = `n.scope=$scope AND n.status IN ('candidate','confirmed') AND p.state='verified'
      AND EXISTS (SELECT 1 FROM json_each($refs) allowed
        WHERE json_extract(allowed.value,'$.id')=n.id AND json_extract(allowed.value,'$.revision')=n.revision)
      ${input.purpose === 'prompt' ? "AND (n.kind != 'qa' OR n.status='confirmed')" : ''}`
    const from = 'FROM memory_notes n JOIN memory_provenance p ON p.note_id=n.id'
    const params = { scope, refs: JSON.stringify(refs.map(({ id, revision }) => ({ id, revision }))) }
    const read = (extraFrom: string, extraWhere: string, extraParams: Record<string, string>, order: string) => {
      const sql = `${from} ${extraFrom} WHERE ${where} ${extraWhere}`
      const bound = { ...params, ...extraParams }
      const total = Number((this.db.prepare(`SELECT COUNT(*) total ${sql}`).get(bound) as { total: number }).total)
      const rows = this.db.prepare(`SELECT n.* ${sql} ORDER BY ${order} LIMIT $limit`).all({ ...bound, limit: input.limit })
      return { notes: rows.map(memoryNoteFromRow), total }
    }
    const query = input.query.trim()
    if (!query) return read('', '', {}, 'n.created_at DESC,n.id DESC')
    const terms = query.split(/\s+/).filter(term => term.length >= 3)
    if (terms.length) {
      const match = terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ')
      const result = read('JOIN memory_fts ON memory_fts.rowid=n.id', 'AND memory_fts MATCH $match', { match }, 'bm25(memory_fts),n.id DESC')
      if (result.total) return result
    }
    return read('', 'AND (n.title LIKE $like OR n.body LIKE $like)', { like: `%${query.replace(/[%_]/g, '')}%` }, 'n.created_at DESC,n.id DESC')
  }
}
