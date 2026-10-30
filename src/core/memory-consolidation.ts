import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { MAX_NOTE_BODY, MemoryOriginConflict, type ChannelMemory, type MemoryNote, type NoteKind } from './memory.js'
import type { MemoryApplication, MemoryOperationResult } from './memory-application.js'

const noteKinds = ['qa', 'fact', 'decision', 'todo', 'profile', 'rule', 'lesson'] as const satisfies readonly NoteKind[]
const ids = z.array(z.number().int().positive()).max(40)
const planSchema = z.object({
  merges: z.array(z.object({
    ids: ids.min(2), kind: z.enum(noteKinds), title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(MAX_NOTE_BODY),
  }).strict()).max(20),
  remove: ids,
  review: ids,
}).strict()

export type MemoryConsolidationPlan = z.infer<typeof planSchema>
export interface MemoryConsolidationReceipt {
  mergedGroups: number
  /** Original candidates consumed by the merges, including each replaced first entry. */
  mergedNotes: number
  /** Explicit removals only; merged duplicates are counted in mergedNotes. */
  removed: number
  reviewIds: number[]
  newNoteIds: number[]
}

export class MemoryConsolidationError extends Error {
  constructor(readonly code: 'invalid_plan' | 'snapshot_changed' | 'source_conflict' | 'async_guard') {
    super(code === 'invalid_plan' ? '整理计划格式或编号无效，本次未修改记忆。'
      : code === 'snapshot_changed' ? '待整理记忆已变化，请在下次整理时重新读取。'
        : code === 'source_conflict' ? '候选的来源范围不同，本次未合并。'
        : '整理提交须同步复验当前执行。')
    this.name = 'MemoryConsolidationError'
  }
}

/** Only the JSON plan is accepted. Prose, code fences and model-supplied source fields are not actions. */
export function parseMemoryConsolidationPlan(text: string): MemoryConsolidationPlan {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new MemoryConsolidationError('invalid_plan') }
  return validatePlan(value)
}

/**
 * The host owns the snapshot and checks end_turn/Run/Space before calling this synchronous commit.
 * All candidates are rechecked, including untouched/review entries. Application writes may stop
 * their own consumer, but that does not interrupt this already admitted atomic batch.
 * This SAVEPOINT may run inside Delivery.admit: releasing it does not commit that outer transaction.
 * Call MemoryRuntime.complete(result) only after the outermost commit (in Delivery.send), never here.
 */
export function applyMemoryConsolidation(deps: { db: DatabaseSync; memory: ChannelMemory; application: MemoryApplication },
  input: { scope: string; sessionKey: string; runId: string; snapshot: readonly MemoryNote[];
    plan: MemoryConsolidationPlan; assertCurrent: () => void }): MemoryOperationResult<MemoryConsolidationReceipt> {
  const plan = validatePlan(input.plan)
  const snapshotIds = new Set(input.snapshot.map(note => note.id))
  if (!input.scope || !input.sessionKey || !input.runId || input.snapshot.length > 40 || snapshotIds.size !== input.snapshot.length
    || input.snapshot.some(note => !Number.isSafeInteger(note.id) || note.id < 1 || !Number.isSafeInteger(note.revision)
      || note.revision < 1 || note.scope !== input.scope || note.status !== 'candidate')) throw new MemoryConsolidationError('snapshot_changed')
  const used = [...plan.merges.flatMap(merge => merge.ids), ...plan.remove, ...plan.review]
  if (new Set(used).size !== used.length || used.some(id => !snapshotIds.has(id))) throw new MemoryConsolidationError('invalid_plan')

  deps.db.exec('SAVEPOINT memory_consolidation')
  try {
    const guard: unknown = input.assertCurrent()
    if (guard && typeof (guard as { then?: unknown }).then === 'function') {
      void Promise.resolve(guard).catch(() => {})
      throw new MemoryConsolidationError('async_guard')
    }
    const current = new Map<number, MemoryNote>()
    for (const original of input.snapshot) {
      const note = deps.memory.get(original.id)
      if (!note || note.scope !== input.scope || note.status !== 'candidate' || note.revision !== original.revision) {
        throw new MemoryConsolidationError('snapshot_changed')
      }
      current.set(note.id, note)
    }
    const invalidated = new Set<string>(), newNoteIds: number[] = []
    const collect = <T>(operation: MemoryOperationResult<T>): T => {
      for (const id of operation.invalidatedRunIds) invalidated.add(id)
      return operation.value
    }
    const remove = (id: number): void => {
      // The entire input snapshot was checked before any write, without an await. Earlier
      // writes in this same transaction can invalidate a consumed descendant's revision.
      const row = deps.db.prepare('SELECT revision FROM memory_notes WHERE id = ? AND scope = ?').get(id, input.scope) as { revision: number } | undefined
      if (!row || !collect(deps.application.remove(id, input.scope, { expectedRevision: row.revision }))) {
        throw new MemoryConsolidationError('snapshot_changed')
      }
    }
    const consumed = new Set([...plan.merges.flatMap(merge => merge.ids), ...plan.remove])
    // Each merge is self-contained. An upstream changed by another operation cannot be
    // silently discarded, and plan order must not change which sources survive.
    const inherited = plan.merges.map(merge => {
      const group = new Set(merge.ids), originals = merge.ids.map(id => current.get(id)!)
      const expanded = deps.memory.dependenciesForDerivation(originals)
      if (expanded.some(ref => consumed.has(ref.id) && !group.has(ref.id))) throw new MemoryConsolidationError('invalid_plan')
      try {
        return deps.memory.dependenciesForDerivation(expanded, merge.ids)
      } catch (error) {
        if (error instanceof MemoryOriginConflict) throw new MemoryConsolidationError('source_conflict')
        throw error
      }
    })
    for (const [index, merge] of plan.merges.entries()) {
      const originals = merge.ids.map(id => current.get(id)!)
      const first = originals[0]!
      // Existing audience readers understand these top-level labels. Keep missing labels distinct
      // from known ones; a consolidation Session must not replace a foreign origin with its own.
      const sourceLabels: Record<string, unknown> = {}
      for (const key of ['chatId', 'promotedFrom'] as const) {
        const value = first.source?.[key]
        if (value !== undefined) sourceLabels[key] = value
      }
      const note = collect(deps.application.add({ scope: input.scope, sessionKey: first.sessionKey ?? undefined,
        kind: merge.kind, title: merge.title, body: merge.body, status: 'candidate', replaces: first.id,
        expectedRevision: first.revision,
        derivedFrom: inherited[index],
        // Audit references to the actual old versions, not live copy ancestors. Replacing/removing
        // those old versions must not immediately make the new corrected candidate unavailable.
        source: { ...sourceLabels, generatedBy: 'memory_consolidation', originRunId: input.runId,
          consolidatedFrom: originals.map(({ id, revision, scope, sessionKey, source }) => ({ id, revision, scope, sessionKey, source })) },
      }))
      newNoteIds.push(note.id)
      for (const id of merge.ids.slice(1)) remove(id)
    }
    for (const id of plan.remove) remove(id)
    const result = { value: { mergedGroups: plan.merges.length, mergedNotes: plan.merges.reduce((sum, merge) => sum + merge.ids.length, 0),
      removed: plan.remove.length, reviewIds: [...plan.review], newNoteIds }, invalidatedRunIds: [...invalidated].sort() }
    deps.db.exec('RELEASE memory_consolidation')
    return result
  } catch (error) {
    deps.db.exec('ROLLBACK TO memory_consolidation; RELEASE memory_consolidation')
    throw error
  }
}

function validatePlan(value: unknown): MemoryConsolidationPlan {
  const parsed = planSchema.safeParse(value)
  if (!parsed.success) throw new MemoryConsolidationError('invalid_plan')
  return parsed.data
}
