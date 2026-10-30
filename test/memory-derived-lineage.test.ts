import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelMemory, type MemoryAddInput, type MemoryNote } from '../src/core/memory.js'
import { applyMemoryConsolidation, type MemoryConsolidationPlan } from '../src/core/memory-consolidation.js'
import { MemoryRuntime } from '../src/core/memory-runtime.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const scope = 'space:lineage-fixture'
const ref = ({ id, revision }: { id: number; revision: number }) => ({ id, revision })

function fixture() {
  const registry = new Registry(':memory:'), db = registry.db, memory = new ChannelMemory(db), attempts = new RunAttempts(db)
  cleanup.push(() => registry.close())
  const handles = new Map<string, ReturnType<typeof vi.fn>>()
  const runtime = new MemoryRuntime({ registry, memory, attempts, now: () => 100,
    activeRun: runId => handles.has(runId) ? { runId, abort: handles.get(runId)! } : undefined })
  let serial = 0
  const add = (title: string, extra: Partial<MemoryAddInput> = {}) => runtime.add({ scope, kind: 'fact', title,
    body: `${title} 完整合成正文`, source: { chatId: 'lineage-chat', generatedBy: 'fixture' }, ...extra })
  const begin = (notes: readonly MemoryNote[]) => {
    const sessionKey = `lineage-session-${++serial}`, acpId = `lineage-acp-${serial}`
    registry.createSession({ sessionKey, chatId: 'lineage-chat', chatType: 'group', cwd: '/synthetic', requesterOpenId: 'alice' })
    const task = registry.createTask({ sessionKey, messageId: `om-lineage-${serial}`, prompt: '请处理这些材料', requesterOpenId: 'alice' })
    const run = attempts.begin({ workKey: `task:${task.id}`, sessionKey, triggerKey: `task:${task.id}`, stage: 'task',
      taskId: task.id, actorOpenId: 'alice', now: serial }, () => registry.startTask(task.id, serial, sessionKey))!
    attempts.bindRuntime(run.id, acpId); runtime.contexts.bind(run.id, sessionKey, acpId); runtime.recordRead(run.id, notes)
    const abort = vi.fn(); handles.set(run.id, abort)
    return { ...run, abort }
  }
  const snapshot = () => ['memory_notes', 'memory_provenance', 'memory_changes', 'memory_tombstones',
    'runtime_contexts', 'run_contexts', 'run_attempts', 'tasks', 'sqlite_sequence']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
  const apply = (notes: readonly MemoryNote[], plan: MemoryConsolidationPlan, run: ReturnType<typeof begin>) =>
    applyMemoryConsolidation({ db, memory, application: runtime.application }, {
      scope, sessionKey: run.sessionKey, runId: run.id, snapshot: notes, plan,
      assertCurrent: () => {
        if (!attempts.isCurrent(run.id) || !runtime.contexts.isEligible(run.id, true)) throw new Error('stopped')
      },
    })
  return { registry, db, memory, attempts, runtime, add, begin, snapshot, apply }
}

describe('actual consumed memory lineage survives correction and consolidation', () => {
  it('expands A/B → Q before replacing A, retaining B even when the Run only consumed A and Q', () => {
    const t = fixture(), a = t.add('原称呼'), b = t.add('独立格式偏好')
    const q = t.add('旧总结', { kind: 'qa', derivedFrom: [a, b] }), run = t.begin([a, q])
    const corrected = t.runtime.addDerived(run.id, { scope, kind: 'profile', title: '新称呼', body: '远山',
      replaces: a.id, expectedRevision: a.revision })
    expect(t.memory.getProvenance(corrected.id)?.ancestors).toEqual([ref(b)])
    expect(t.memory.get(corrected.id)).toMatchObject({ status: 'candidate', body: '远山' })
    expect(t.memory.get(a.id)).toMatchObject({ status: 'superseded', supersededBy: corrected.id })
    expect(t.memory.get(q.id)).toBeUndefined()
    expect(t.memory.getProvenance(q.id)?.state).toBe('unavailable')
    const consumer = t.begin([corrected])
    t.runtime.remove(b.id, scope)
    expect(t.memory.get(corrected.id)).toBeUndefined()
    expect(t.runtime.contexts.isEligible(consumer.id, true)).toBe(false)
    expect(consumer.abort).toHaveBeenCalledOnce()
  })

  it('still applies a confirmed replacement when its new candidate has an independent live ancestor', () => {
    const t = fixture(), a = t.add('已确认称呼', { kind: 'profile', status: 'confirmed',
      confirmation: { by: 'alice', messageId: 'om-confirm-original', at: 10 } }), b = t.add('独立格式偏好')
    const run = t.begin([a, b])
    const corrected = t.runtime.addDerived(run.id, { scope, kind: 'profile', title: '新称呼', body: '远山', replaces: a.id })
    expect(t.memory.getProvenance(corrected.id)?.ancestors).toEqual([ref(b)])
    expect(t.memory.get(a.id)?.status).toBe('confirmed')
    expect(t.runtime.confirm(corrected.id, scope, { by: 'alice', messageId: 'om-confirm-correction' })).toBe(true)
    expect(t.memory.get(a.id)).toMatchObject({ status: 'superseded', supersededBy: corrected.id })
    expect(t.memory.get(corrected.id)).toMatchObject({ status: 'confirmed' })
    t.runtime.remove(b.id, scope)
    expect(t.memory.get(corrected.id)).toBeUndefined()
  })

  it('stops actual consumers of both QA hops on source forget, leaving unrelated work and history rows intact', () => {
    const t = fixture(), source = t.add('轻舟'), unrelated = t.add('独立材料')
    const first = t.begin([source])
    const qa1 = t.runtime.addDerived(first.id, { scope, kind: 'qa', title: '轻舟第一份回答', body: '第一份派生回答' })
    t.attempts.finish(first.id, 'completed', 20)
    const second = t.begin([qa1])
    const qa2 = t.runtime.addDerived(second.id, { scope, kind: 'qa', title: '轻舟第二份回答', body: '第二份派生回答' })
    t.attempts.finish(second.id, 'completed', 21)
    expect(t.memory.getProvenance(qa1.id)?.ancestors).toEqual([ref(source)])
    expect(t.memory.getProvenance(qa2.id)?.ancestors).toEqual([ref(source), ref(qa1)])
    const c1 = t.begin([qa1]), c2 = t.begin([qa2]), safe = t.begin([unrelated])
    expect(t.runtime.remove(source.id, scope)).toBe(true)
    for (const note of [qa1, qa2]) {
      expect(t.memory.get(note.id)).toBeUndefined()
      expect(t.memory.getProvenance(note.id)?.state).toBe('unavailable')
      expect(t.db.prepare('SELECT body FROM memory_notes WHERE id=?').get(note.id)).toEqual({ body: note.body })
    }
    for (const run of [c1, c2]) {
      expect(t.attempts.get(run.id)).toMatchObject({ state: 'stop_requested', stopReason: 'memory_context_invalidated' })
      expect(run.abort).toHaveBeenCalledOnce()
    }
    expect(t.memory.search(scope, '轻舟', 1)).toEqual([])
    expect(t.memory.recent(scope, 1).map(n => n.id)).toEqual([unrelated.id])
    expect(t.runtime.contexts.isEligible(safe.id, true)).toBe(true)
    expect(safe.abort).not.toHaveBeenCalled()
  })

  it('rejects the whole merge-and-remove plan when deleting an upstream dependency outside the merge group', () => {
    const t = fixture(), a = t.add('将删除的上游'), b = t.add('仍保留的上游')
    const q = t.add('中间总结', { kind: 'qa', derivedFrom: [a, b] })
    const left = t.add('左候选', { derivedFrom: [q] }), right = t.add('右候选', { derivedFrom: [q] })
    const notes = [left, right, a], run = t.begin(notes), before = t.snapshot()
    expect(() => t.apply(notes, {
      merges: [{ ids: [left.id, right.id], kind: 'fact', title: '合并结果', body: '不能绕过上游的内容' }], remove: [a.id], review: [],
    }, run)).toThrow()
    expect(t.snapshot()).toEqual(before)
    expect(run.abort).not.toHaveBeenCalled()
    expect(t.runtime.contexts.isEligible(run.id, true)).toBe(true)
  })

  it('does not launder a foreign source by merging its local descendants while deleting the ancestor', () => {
    const t = fixture()
    const foreign = t.add('外部来源', { source: { chatId: 'other-chat', generatedBy: 'fixture' } })
    const parent = t.add('本群提炼', { derivedFrom: [foreign] })
    const left = t.add('提炼左', { derivedFrom: [parent] }), right = t.add('提炼右', { derivedFrom: [parent] })
    const audience = { scope, chatId: 'lineage-chat', chatType: 'group' as const, openId: 'alice' }
    expect(t.memory.recentForAudience(audience).items).toEqual([])
    const notes = [left, right, foreign], run = t.begin(notes), before = t.snapshot()
    expect(() => t.apply(notes, {
      merges: [{ ids: [left.id, right.id], kind: 'fact', title: '错误本群摘要', body: '仍属于外部来源' }], remove: [foreign.id], review: [],
    }, run)).toThrow()
    expect(t.snapshot()).toEqual(before)
    expect(t.memory.recentForAudience(audience).items).toEqual([])
    expect(t.memory.getProvenance(left.id)?.ancestors).toContainEqual(ref(foreign))
    expect(run.abort).not.toHaveBeenCalled()
  })

  it.each([false, true])('rejects two dependent merge groups atomically in either order (reverse=%s)', reverse => {
    const t = fixture(), a = t.add('组一原条目'), aDerived = t.add('组一派生', { derivedFrom: [a] })
    const b = t.add('组二左', { derivedFrom: [a] }), bDerived = t.add('组二右', { derivedFrom: [a] })
    const notes = [a, aDerived, b, bDerived], run = t.begin(notes), before = t.snapshot()
    const merges: MemoryConsolidationPlan['merges'] = [
      { ids: [a.id, aDerived.id], kind: 'fact', title: '组一合并', body: '组一内容' },
      { ids: [b.id, bDerived.id], kind: 'fact', title: '组二合并', body: '仍依赖组一旧版本' },
    ]
    if (reverse) merges.reverse()
    expect(() => t.apply(notes, { merges, remove: [], review: [] }, run)).toThrow()
    expect(t.snapshot()).toEqual(before)
    expect(run.abort).not.toHaveBeenCalled()
    expect(t.runtime.contexts.isEligible(run.id, true)).toBe(true)
  })

  it.each([false, true])('merges one original and its same-source derivative within the same group without self-invalidation (reverse=%s)', reverse => {
    const t = fixture(), a = t.add('同源原条目'), derived = t.add('同源派生', { derivedFrom: [a] })
    const notes = [a, derived], run = t.begin(notes)
    const ids = reverse ? [derived.id, a.id] : [a.id, derived.id]
    const result = t.apply(notes, { merges: [{ ids, kind: 'fact', title: '同源合并', body: '仍然可用的原意' }], remove: [], review: [] }, run)
    const mergedId = result.value.newNoteIds[0]!
    expect(t.memory.get(mergedId)).toMatchObject({ status: 'candidate', body: '仍然可用的原意' })
    expect(t.memory.getProvenance(mergedId)).toMatchObject({ state: 'legacy_unverified', ancestors: [] })
    expect(t.memory.get(mergedId)?.source).toMatchObject({ consolidatedFrom: ids.map(id => expect.objectContaining({ id, revision: 1 })) })
    expect(t.memory.search(scope, '同源合并').map(n => n.id)).toEqual([mergedId])
    expect(run.abort).not.toHaveBeenCalled()
    t.runtime.complete(result)
    expect(run.abort).toHaveBeenCalledOnce()
  })

  it('rejects an obsolete dependency before inserting any note, lineage, or journal entry', () => {
    const t = fixture(), source = t.add('旧版本'), second = t.add('另一个有效版本')
    t.runtime.confirm(source.id, scope, { by: 'alice', messageId: 'new-confirmation' })
    const before = t.snapshot()
    expect(() => t.add('不得创建', { derivedFrom: [second, source] })).toThrow()
    expect(t.snapshot()).toEqual(before)
  })

  it('does not fabricate dependencies for pre-lineage QA from matching text, source.noteId or a repeated migration', () => {
    const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close())
    db.exec(`CREATE TABLE memory_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,session_key TEXT,kind TEXT NOT NULL,
      title TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL,
      source TEXT,superseded_by INTEGER,confirmation TEXT
    );
    CREATE VIRTUAL TABLE memory_fts USING fts5(title,body,content='memory_notes',content_rowid='id',tokenize='trigram');
    CREATE TRIGGER memory_ai AFTER INSERT ON memory_notes BEGIN
      INSERT INTO memory_fts(rowid,title,body) VALUES(new.id,new.title,new.body);
    END;
    CREATE TRIGGER memory_ad AFTER DELETE ON memory_notes BEGIN
      INSERT INTO memory_fts(memory_fts,rowid,title,body) VALUES('delete',old.id,old.title,old.body);
    END;`)
    const insert = db.prepare('INSERT INTO memory_notes VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    insert.run(11, scope, 'old-session', 'profile', '旧称呼', '轻舟', 10, 'candidate', null, null, null)
    insert.run(12, scope, 'old-session', 'qa', '旧问答', '记住了，轻舟', 11, 'candidate',
      JSON.stringify({ generatedBy: 'automatic_qa', noteId: 11 }), null, null)
    const columns = 'id,scope,session_key,kind,title,body,created_at,status,source,superseded_by,confirmation'
    const before = db.prepare(`SELECT ${columns} FROM memory_notes ORDER BY id`).all()
    const memory = new ChannelMemory(db)
    new ChannelMemory(db)
    expect(db.prepare(`SELECT ${columns} FROM memory_notes ORDER BY id`).all()).toEqual(before)
    expect(memory.getProvenance(12)).toMatchObject({ state: 'legacy_unverified', ancestors: [], originRunId: null })
    expect(memory.changes()).toEqual([])
    memory.remove(11, scope)
    expect(memory.get(12)).toMatchObject({ body: '记住了，轻舟', status: 'candidate', revision: 1 })
    expect(memory.getProvenance(12)?.ancestors).toEqual([])
    expect(memory.search(scope, '轻舟').map(n => n.id)).toEqual([12])
  })
})
