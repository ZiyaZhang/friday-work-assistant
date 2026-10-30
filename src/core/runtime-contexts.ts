import type { DatabaseSync } from 'node:sqlite'
import type { MemoryChange } from './memory-provenance.js'
import type { ManagedMemoryProof } from './personal-memory-reader.js'

/** Exact note versions delivered to this ACP history; no note body is duplicated here. */
export interface RuntimeMemoryRef { id: number; revision: number }
export interface RuntimeContext {
  acpId: string
  sessionKey: string
  notes: RuntimeMemoryRef[]
  state: 'valid' | 'invalidated'
  reason: 'memory_context_invalidated' | null
  createdAt: number
  invalidatedAt: number | null
}

export class RuntimeContextError extends Error {
  constructor(readonly code: 'run_ineligible' | 'binding_conflict' | 'unbound' | 'invalidated' | 'note_changed') {
    super('运行上下文已变化，请重新准备本轮材料')
    this.name = 'RuntimeContextError'
  }
}

/**
 * Tracks actual memory consumption, not read authorization. The host must only bind a
 * freshly created ACP or one admitted by canResume, and only record authorized reads.
 * Unknown pre-migration ACP histories are deliberately not backfilled as valid.
 */
export class RuntimeContexts {
  /** Live authorization is intentionally not persisted: each resumed Run must obtain a fresh proof. */
  private readonly managed = new Map<string, Map<number, { revision: number; proof: ManagedMemoryProof }>>()
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_contexts (
        acp_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        notes_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(notes_json) AND json_type(notes_json) = 'array'),
        state TEXT NOT NULL CHECK(state IN ('valid','invalidated')),
        reason TEXT CHECK(reason IS NULL OR reason = 'memory_context_invalidated'),
        created_at INTEGER NOT NULL,
        invalidated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_context_session ON runtime_contexts(session_key);
      CREATE TABLE IF NOT EXISTS run_contexts (
        run_id TEXT PRIMARY KEY REFERENCES run_attempts(id),
        acp_id TEXT NOT NULL REFERENCES runtime_contexts(acp_id)
      );
      CREATE INDEX IF NOT EXISTS idx_run_context_acp ON run_contexts(acp_id);
    `)
  }

  get(acpId: string): RuntimeContext | undefined {
    const row = this.db.prepare('SELECT * FROM runtime_contexts WHERE acp_id = ?').get(acpId)
    return row ? toContext(row) : undefined
  }

  contextForRun(runId: string): RuntimeContext | undefined {
    const row = this.db.prepare(`SELECT c.* FROM runtime_contexts c JOIN run_contexts r ON r.acp_id = c.acp_id
      WHERE r.run_id = ?`).get(runId)
    return row ? toContext(row) : undefined
  }

  canResume(sessionKey: string, acpId: string, runId?: string): boolean {
    const context = this.get(acpId)
    return Boolean(context && context.sessionKey === sessionKey && this.current(context, runId))
  }

  admit(runId: string, proof: ManagedMemoryProof): void {
    if (proof.runId !== runId) throw new RuntimeContextError('binding_conflict')
    if (this.run(runId)?.state !== 'running') throw new RuntimeContextError('run_ineligible')
    proof.assertCurrent()
    const next = new Map(this.managed.get(runId))
    for (const ref of proof.refs) next.set(ref.id, { revision: ref.revision, proof })
    this.managed.set(runId, next)
  }

  release(runId: string): void { this.managed.delete(runId) }
  withdraw(runId: string, refs: readonly RuntimeMemoryRef[]): void {
    const admitted = this.managed.get(runId)
    for (const ref of refs) if (admitted?.get(ref.id)?.revision === ref.revision) admitted.delete(ref.id)
  }

  /** Existing RunAttempts.bindRuntime must succeed first. One Run cannot change its context. */
  bind(runId: string, sessionKey: string, acpId: string): RuntimeContext {
    return this.transaction(() => {
      const run = this.run(runId)
      if (!run || run.state !== 'running') throw new RuntimeContextError('run_ineligible')
      if (!sessionKey || !acpId || run.session_key !== sessionKey || run.acp_session_id !== acpId) {
        throw new RuntimeContextError('binding_conflict')
      }
      const bound = this.contextForRun(runId)
      if (bound && (bound.acpId !== acpId || bound.sessionKey !== sessionKey)) throw new RuntimeContextError('binding_conflict')
      const existing = this.get(acpId)
      if (existing && existing.sessionKey !== sessionKey) throw new RuntimeContextError('binding_conflict')
      if (existing && !this.current(existing, runId)) throw new RuntimeContextError('invalidated')
      if (!existing) {
        this.db.prepare("INSERT INTO runtime_contexts (acp_id,session_key,state,created_at) VALUES (?,?,'valid',?)")
          .run(acpId, sessionKey, this.now())
      }
      this.db.prepare('INSERT OR IGNORE INTO run_contexts (run_id,acp_id) VALUES (?,?)').run(runId, acpId)
      return this.get(acpId)!
    })
  }

  /**
   * Context validity only: a completed parent may still be used by reflection.
   * The host separately checks Run state; recordRead/bind always require running.
   */
  isEligible(runId: string, requireBound = false): boolean {
    const run = this.run(runId)
    if (!run) return false
    const context = this.contextForRun(runId)
    if (!context) return !requireBound
    return context.sessionKey === run.session_key && context.acpId === run.acp_session_id && this.current(context, runId)
  }

  /** Recheck after any material-fetch await, before prompt/API admission; accumulate across Runs. */
  recordRead(runId: string, notes: readonly RuntimeMemoryRef[]): void {
    this.transaction(() => {
      const run = this.run(runId)
      if (!run || run.state !== 'running') throw new RuntimeContextError('run_ineligible')
      const context = this.contextForRun(runId)
      if (!context) throw new RuntimeContextError('unbound')
      if (context.sessionKey !== run.session_key || context.acpId !== run.acp_session_id) throw new RuntimeContextError('binding_conflict')
      if (!this.current(context, runId)) throw new RuntimeContextError('invalidated')
      if (!notes.every(note => this.currentNote(note, runId))) throw new RuntimeContextError('note_changed')
      const accumulated = new Map(context.notes.map(note => [note.id, note]))
      for (const note of notes) accumulated.set(note.id, { id: note.id, revision: note.revision })
      this.db.prepare("UPDATE runtime_contexts SET notes_json = ? WHERE acp_id = ? AND state = 'valid'")
        .run(JSON.stringify([...accumulated.values()].sort((a, b) => a.id - b.id)), context.acpId)
    })
  }

  /** Returns exact still-active Runs newly affected by these changes, without aborting anything. */
  invalidate(changes: readonly MemoryChange[]): string[] {
    return this.transaction(() => {
      const changed = new Map<number, number>()
      for (const change of changes) {
        if (change.operation === 'created' || change.operation === 'copied') continue
        changed.set(change.noteId, Math.max(changed.get(change.noteId) ?? 0, change.revision))
      }
      if (!changed.size) return []
      const contexts = this.db.prepare("SELECT * FROM runtime_contexts WHERE state = 'valid'").all().map(toContext)
      const runIds = new Set<string>()
      for (const context of contexts) {
        if (!context.notes.some(note => note.revision < (changed.get(note.id) ?? 0))) continue
        this.db.prepare(`UPDATE runtime_contexts SET state = 'invalidated', reason = 'memory_context_invalidated', invalidated_at = ?
          WHERE acp_id = ? AND state = 'valid'`).run(this.now(), context.acpId)
        const rows = this.db.prepare(`SELECT a.id FROM run_attempts a JOIN run_contexts r ON r.run_id = a.id
          WHERE r.acp_id = ? AND a.session_key = ? AND a.acp_session_id = ? AND a.state IN ('running','stop_requested')`)
          .all(context.acpId, context.sessionKey, context.acpId) as { id: string }[]
        for (const row of rows) runIds.add(row.id)
      }
      return [...runIds].sort()
    })
  }

  private current(context: RuntimeContext, runId?: string): boolean {
    return context.state === 'valid' && context.notes.every(note => this.currentNote(note, runId))
  }

  private currentNote(note: RuntimeMemoryRef, runId?: string): boolean {
    if (!Number.isSafeInteger(note.id) || note.id < 1 || !Number.isSafeInteger(note.revision) || note.revision < 1) return false
    const row = this.db.prepare(`SELECT p.state FROM memory_notes n JOIN memory_provenance p ON p.note_id = n.id
      WHERE n.id = ? AND n.revision = ? AND n.status IN ('candidate','confirmed')`)
      .get(note.id, note.revision)
    if (row?.state === 'legacy_unverified') return true
    if (row?.state !== 'verified' || !runId) return false
    const admitted = this.managed.get(runId)?.get(note.id)
    if (!admitted || admitted.revision !== note.revision) return false
    try { admitted.proof.assertCurrent(); return true } catch { return false }
  }

  private run(id: string): { state: string; session_key: string; acp_session_id: string | null } | undefined {
    return this.db.prepare('SELECT state,session_key,acp_session_id FROM run_attempts WHERE id = ?').get(id) as
      { state: string; session_key: string; acp_session_id: string | null } | undefined
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('SAVEPOINT runtime_context_write')
    try { const value = action(); this.db.exec('RELEASE runtime_context_write'); return value }
    catch (error) { this.db.exec('ROLLBACK TO runtime_context_write; RELEASE runtime_context_write'); throw error }
  }
}

function toContext(row: Record<string, unknown>): RuntimeContext {
  return { acpId: String(row.acp_id), sessionKey: String(row.session_key), notes: JSON.parse(String(row.notes_json)) as RuntimeMemoryRef[],
    state: row.state as RuntimeContext['state'], reason: row.reason as RuntimeContext['reason'], createdAt: Number(row.created_at),
    invalidatedAt: row.invalidated_at === null ? null : Number(row.invalidated_at) }
}
