import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliveryService, type DeliveryContext } from '../src/core/delivery.js'
import { applyMemoryConsolidation, parseMemoryConsolidationPlan, type MemoryConsolidationPlan,
  type MemoryConsolidationReceipt } from '../src/core/memory-consolidation.js'
import type { MemoryOperationResult } from '../src/core/memory-application.js'
import { ChannelMemory, type MemoryNote } from '../src/core/memory.js'
import { MemoryRuntime } from '../src/core/memory-runtime.js'
import { buildConsolidatePrompt } from '../src/core/prompt.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { spaceScope } from '../src/core/space.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
const empty = (): MemoryConsolidationPlan => ({ merges: [], remove: [], review: [] })
function fixture() {
  const registry = new Registry(':memory:'); cleanup.push(() => registry.close())
  const db = registry.db, memory = new ChannelMemory(db), attempts = new RunAttempts(db)
  const sp = spaceDeps(db), space = sp.spaces.ensure({ kind: 'group', chatId: 'chat', openId: 'alice' }), scope = spaceScope(space.id)
  const aborts = new Map<string, ReturnType<typeof vi.fn>>()
  const runtime = new MemoryRuntime({ registry, memory, attempts, now: () => 100,
    activeRun: runId => aborts.has(runId) ? { runId, abort: aborts.get(runId)! } : undefined })
  let serial = 0
  const add = (over: Partial<Parameters<ChannelMemory['add']>[0]> = {}) => memory.add({ scope, kind: 'fact', title: `合成候选${++serial}`,
    body: `完整合成正文${serial}`, source: { chatId: 'chat', messageId: `source-${serial}`, by: 'alice' }, ...over })
  const begin = (notes: readonly MemoryNote[]) => {
    const sessionKey = `synthetic-${++serial}`
    registry.createSession({ sessionKey, chatId: 'chat', chatType: 'group', cwd: '/synthetic', requesterOpenId: 'alice' })
    const task = registry.createTask({ sessionKey, messageId: sessionKey, prompt: 'synthetic', requesterOpenId: 'alice' })
    const run = attempts.begin({ workKey: `task:${task.id}`, sessionKey, triggerKey: sessionKey, stage: 'task', taskId: task.id,
      actorOpenId: 'alice', now: 1 }, () => registry.startTask(task.id, 1, sessionKey))!
    const acp = `acp-${serial}`
    attempts.bindRuntime(run.id, acp); runtime.contexts.bind(run.id, sessionKey, acp); runtime.recordRead(run.id, notes)
    const abort = vi.fn(); aborts.set(run.id, abort)
    return { ...run, abort }
  }
  const snapshot = () => ['memory_notes', 'memory_provenance', 'memory_changes', 'memory_tombstones', 'runtime_contexts',
    'run_contexts', 'run_attempts', 'tasks', 'sqlite_sequence'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
  const apply = (notes: readonly MemoryNote[], plan: MemoryConsolidationPlan, run = begin(notes), guard?: () => void) =>
    applyMemoryConsolidation({ db, memory, application: runtime.application }, { scope, sessionKey: run.sessionKey,
      runId: run.id, snapshot: notes, plan, assertCurrent: guard ?? (() => {
        if (!attempts.isCurrent(run.id) || !runtime.contexts.isEligible(run.id, true) || sp.spaces.get(space.id)?.status !== 'active') throw new Error('run or space stopped')
      }) })
  return { registry, db, memory, attempts, runtime, ...sp, space, scope, add, begin, snapshot, apply }
}

describe('read-only consolidation plans', () => {
  it('provides complete candidate bodies as data and accepts a strict empty plan', () => {
    const t = fixture(), body = `前半段${'完整正文'.repeat(250)}\n末尾限制：默认不自动隐藏。`, note = t.add({ body })
    const prompt = buildConsolidatePrompt({ botName: 'Friday', where: '合成空间', nowMs: 100, notes: [note] })
    const data = JSON.parse(prompt.split('[候选快照 JSON]\n')[1]!.split('\n\n')[0]!)
    expect(data).toEqual([{ id: note.id, revision: note.revision, kind: note.kind, title: note.title, body: note.body, createdAt: note.createdAt }])
    expect(data[0].body).toContain('末尾限制：默认不自动隐藏。')
    expect(parseMemoryConsolidationPlan('{"merges":[],"remove":[],"review":[]}')).toEqual(empty())
  })

  it.each([
    'NOTHING', '```json\n{"merges":[],"remove":[],"review":[]}\n```',
    '{"merges":[],"remove":[],"review":[],"source":{"by":"model"}}',
    '{"remove":[],"review":[]}', '{"merges":[],"remove":["1"],"review":[]}',
    JSON.stringify({ merges: [{ ids: [1], kind: 'fact', title: 'a', body: 'b' }], remove: [], review: [] }),
    JSON.stringify({ merges: [{ ids: [1, 2], kind: 'confirmed', title: 'a', body: 'b' }], remove: [], review: [] }),
    JSON.stringify({ merges: [{ ids: [1, 2], kind: 'fact', title: 'a', body: 'b', status: 'confirmed' }], remove: [], review: [] }),
    JSON.stringify({ merges: [{ ids: [1, 2], kind: 'fact', title: 'a', body: 'x'.repeat(1501) }], remove: [], review: [] }),
  ])('rejects malformed/unbounded model output without turning it into an action (%#)', text => {
    expect(() => parseMemoryConsolidationPlan(text)).toThrowError(expect.objectContaining({ code: 'invalid_plan' }))
  })
})

describe('one atomic candidate consolidation', () => {
  it('retains live upstream dependencies through consolidation, then invalidates the consolidated result on source correction', () => {
    const t = fixture(), source = t.add({ title: '原始称呼', body: '轻舟' })
    const a = t.add({ title: '称呼提炼', body: '轻舟', derivedFrom: [source] })
    const b = t.add({ title: '称呼提炼二', body: '轻舟', derivedFrom: [source] })
    const result = t.apply([a, b], { ...empty(), merges: [{ ids: [a.id, b.id], kind: 'profile', title: '称呼', body: '轻舟' }] })
    const id = result.value.newNoteIds[0]!
    expect(t.memory.get(id)?.body).toBe('轻舟')
    expect(t.memory.getProvenance(id)?.ancestors).toEqual([{ id: source.id, revision: source.revision }])
    t.runtime.add({ scope: t.scope, kind: 'profile', title: '称呼', body: '远山', replaces: source.id })
    expect(t.memory.get(id)).toBeUndefined()
    expect(t.memory.search(t.scope, '轻舟')).toEqual([])
  })

  it('commits multiple merges/removals together and only then aborts exact consumers; merged candidates remain available', () => {
    const t = fixture(), notes = Array.from({ length: 7 }, () => t.add()), [a, b, c, d, removed, review] = notes as [MemoryNote, MemoryNote, MemoryNote, MemoryNote, MemoryNote, MemoryNote, MemoryNote]
    const run = t.begin(notes), another = t.begin([removed]), unaffected = t.begin([t.add()])
    const plan = parseMemoryConsolidationPlan(JSON.stringify({ merges: [
      { ids: [a.id, b.id], kind: 'fact', title: '合并甲', body: '甲完整结果' },
      { ids: [c.id, d.id], kind: 'decision', title: '合并乙', body: '乙完整结果' },
    ], remove: [removed.id], review: [review.id] }))
    const result = t.apply(notes, plan, run)
    expect(result.value).toEqual({ mergedGroups: 2, mergedNotes: 4, removed: 1, reviewIds: [review.id], newNoteIds: expect.any(Array) })
    expect(result.invalidatedRunIds).toEqual([run.id, another.id].sort())
    expect(run.abort).not.toHaveBeenCalled(); expect(another.abort).not.toHaveBeenCalled()
    expect(t.attempts.get(run.id)?.state).toBe('stop_requested')
    const merged = result.value.newNoteIds.map(id => t.memory.get(id)!)
    expect(merged.map(n => n.status)).toEqual(['candidate', 'candidate'])
    expect(t.memory.get(a.id)).toMatchObject({ status: 'superseded', supersededBy: merged[0]!.id })
    expect(t.memory.get(c.id)).toMatchObject({ status: 'superseded', supersededBy: merged[1]!.id })
    for (const id of [b.id, d.id, removed.id]) expect(t.memory.get(id)).toBeUndefined()
    expect(t.memory.get(review.id)).toEqual(review)
    expect(merged[0]!.source).toMatchObject({ originRunId: run.id, consolidatedFrom: [
      { id: a.id, revision: a.revision, scope: a.scope, source: a.source },
      { id: b.id, revision: b.revision, scope: b.scope, source: b.source },
    ] })
    expect(t.memory.getProvenance(merged[0]!.id)).toMatchObject({ state: 'legacy_unverified', ancestors: [] })
    expect(t.runtime.complete(result)).toEqual(result.value)
    expect(run.abort).toHaveBeenCalledOnce(); expect(another.abort).toHaveBeenCalledOnce(); expect(unaffected.abort).not.toHaveBeenCalled()
    expect(t.runtime.contexts.isEligible(unaffected.id, true)).toBe(true)
    expect(t.memory.confirm(merged[0]!.id, t.scope, { by: 'alice', messageId: 'human-confirm' })).toBe(true)
  })

  it.each(['empty', 'review'] as const)('keeps %s plans read-only and does not confirm or stop the consumer', mode => {
    const t = fixture(), notes = [t.add()], run = t.begin(notes), before = t.snapshot()
    const result = t.apply(notes, { ...empty(), review: mode === 'review' ? [notes[0]!.id] : [] }, run)
    expect(result.invalidatedRunIds).toEqual([])
    expect(t.runtime.complete(result).newNoteIds).toEqual([])
    expect(t.snapshot()).toEqual(before); expect(run.abort).not.toHaveBeenCalled()
  })

  it('preserves equal foreign origin labels so the merged candidate stays excluded from the current audience', () => {
    const t = fixture(), source = { chatId: 'foreign-chat', promotedFrom: 'space:foreign', messageId: 'synthetic-original' }
    const notes = [t.add({ source }), t.add({ source: { ...source, messageId: 'synthetic-second' } })], run = t.begin(notes)
    const audience = { scope: t.scope, chatId: 'chat', chatType: 'group' as const, openId: 'alice' }
    expect(t.memory.recentForAudience(audience).total).toBe(0)
    const result = t.apply(notes, { merges: [{ ids: notes.map(n => n.id), kind: 'fact', title: '合并', body: '正文' }], remove: [], review: [] }, run)
    expect(t.memory.get(result.value.newNoteIds[0]!)?.source).toMatchObject({ chatId: source.chatId, promotedFrom: source.promotedFrom,
      consolidatedFrom: notes.map(({ id, revision, scope, source }) => ({ id, revision, scope, source })) })
    expect(t.memory.recentForAudience(audience)).toEqual({ items: [], total: 0 })
  })

  it('keeps a real old-session origin hidden after consolidating in the rebound current chat', () => {
    const t = fixture()
    t.registry.createSession({ sessionKey: 'original-chat-session', chatId: 'previous-chat', chatType: 'group', cwd: '/synthetic' })
    const notes = [t.add({ sessionKey: 'original-chat-session', source: {} }), t.add({ sessionKey: 'original-chat-session', source: {} })]
    const run = t.begin(notes), audience = { scope: t.scope, chatId: 'chat', chatType: 'group' as const, openId: 'alice' }
    expect(t.memory.recentForAudience(audience)).toEqual({ items: [], total: 0 })
    const result = t.apply(notes, { merges: [{ ids: notes.map(n => n.id), kind: 'fact', title: '合并', body: '原群合成内容' }], remove: [], review: [] }, run)
    expect(t.memory.recentForAudience(audience)).toEqual({ items: [], total: 0 })
    expect(t.memory.get(result.value.newNoteIds[0]!)?.sessionKey).toBe('original-chat-session')
  })

  it('still merges different original sessions from the same group without inventing a new origin', () => {
    const t = fixture()
    for (const [sessionKey, requesterOpenId] of [['origin-a', 'alice'], ['origin-b', 'bob']]) {
      t.registry.createSession({ sessionKey: sessionKey!, requesterOpenId, chatId: 'chat', chatType: 'group', cwd: '/synthetic' })
    }
    const notes = [t.add({ sessionKey: 'origin-a', source: {} }), t.add({ sessionKey: 'origin-b', source: {} })], run = t.begin(notes)
    const result = t.apply(notes, { merges: [{ ids: notes.map(n => n.id), kind: 'fact', title: '合并', body: '同群合成内容' }], remove: [], review: [] }, run)
    const merged = t.memory.get(result.value.newNoteIds[0]!)!
    expect(merged.sessionKey).toBe('origin-a')
    expect(t.memory.recentForAudience({ scope: t.scope, chatId: 'chat', chatType: 'group', openId: 'alice' }).items).toEqual([merged])
  })

  it.each(['chat', 'chat type', 'DM owner', 'missing session'] as const)('rolls back all merges if real session origins differ by %s', difference => {
    const t = fixture(), base = { chatId: 'source-chat', chatType: 'p2p' as const, requesterOpenId: 'alice', cwd: '/synthetic' }
    t.registry.createSession({ sessionKey: 'origin-a', ...base })
    if (difference !== 'missing session') t.registry.createSession({ sessionKey: 'origin-b', ...base,
      ...(difference === 'chat' ? { chatId: 'other-chat' } : difference === 'chat type' ? { chatType: 'group' as const } : { requesterOpenId: 'bob' }) })
    const notes = [t.add(), t.add(), t.add({ sessionKey: 'origin-a', source: {} }), t.add({ sessionKey: 'origin-b', source: {} })]
    const run = t.begin(notes), before = t.snapshot()
    expect(() => t.apply(notes, { merges: [
      { ids: [notes[0]!.id, notes[1]!.id], kind: 'fact', title: '先合并', body: '本群内容' },
      { ids: [notes[2]!.id, notes[3]!.id], kind: 'fact', title: '来源冲突', body: '旧来源内容' },
    ], remove: [], review: [] }, run)).toThrowError(expect.objectContaining({ code: 'source_conflict' }))
    expect(t.snapshot()).toEqual(before); expect(run.abort).not.toHaveBeenCalled()
  })

  it('rolls back the whole batch when origin labels differ, including missing versus known labels', () => {
    for (const key of ['chatId', 'promotedFrom'] as const) for (const other of [undefined, 'other-origin']) {
      const t = fixture(), notes = [t.add(), t.add(), t.add({ source: { [key]: 'known-origin' } }), t.add({ source: other ? { [key]: other } : {} })]
      const run = t.begin(notes), before = t.snapshot()
      expect(() => t.apply(notes, { merges: [
        { ids: [notes[0]!.id, notes[1]!.id], kind: 'fact', title: '先合并', body: '正文一' },
        { ids: [notes[2]!.id, notes[3]!.id], kind: 'fact', title: '来源冲突', body: '正文二' },
      ], remove: [], review: [] }, run)).toThrowError(expect.objectContaining({ code: 'source_conflict' }))
      expect(t.snapshot()).toEqual(before); expect(run.abort).not.toHaveBeenCalled()
    }
  })

  it.each(['duplicate merge', 'cross merges', 'merge/remove', 'remove/review', 'duplicate review', 'unknown'] as const)('rejects %s references before changing any state', mode => {
    const t = fixture(), notes = [t.add(), t.add(), t.add()], run = t.begin(notes), ids = notes.map(n => n.id), before = t.snapshot()
    const merge = { ids: [ids[0]!, ids[1]!], kind: 'fact' as const, title: '合并', body: '合并正文' }
    const plan: MemoryConsolidationPlan = mode === 'duplicate merge' ? { ...empty(), merges: [{ ...merge, ids: [ids[0]!, ids[0]!] }] }
      : mode === 'cross merges' ? { ...empty(), merges: [merge, { ...merge, ids: [ids[1]!, ids[2]!] }] }
        : mode === 'merge/remove' ? { ...empty(), merges: [merge], remove: [ids[0]!] }
          : mode === 'remove/review' ? { ...empty(), remove: [ids[0]!], review: [ids[0]!] }
            : mode === 'duplicate review' ? { ...empty(), review: [ids[0]!, ids[0]!] }
              : { ...empty(), remove: [999999] }
    expect(() => t.apply(notes, plan, run)).toThrowError(expect.objectContaining({ code: 'invalid_plan' }))
    expect(t.snapshot()).toEqual(before); expect(run.abort).not.toHaveBeenCalled()
  })

  it.each(['confirmed', 'deleted', 'revision', 'foreign', 'managed'] as const)('rechecks the entire snapshot, even an unmodified %s entry', change => {
    const t = fixture(), notes = [t.add(), t.add()], run = t.begin(notes), untouched = notes[1]!
    if (change === 'confirmed') t.memory.confirm(untouched.id, t.scope, { by: 'alice', messageId: 'real-confirm' })
    if (change === 'deleted') t.memory.remove(untouched.id, t.scope)
    if (change === 'revision') t.db.prepare('UPDATE memory_notes SET revision=revision+1 WHERE id=?').run(untouched.id)
    if (change === 'foreign') t.db.prepare("UPDATE memory_notes SET scope='space:foreign' WHERE id=?").run(untouched.id)
    if (change === 'managed') t.db.prepare("UPDATE memory_provenance SET state='unavailable' WHERE note_id=?").run(untouched.id)
    const before = t.snapshot()
    // Keep the host guard independent here so the batch's all-snapshot CAS itself is exercised.
    expect(() => t.apply(notes, { ...empty(), remove: [notes[0]!.id] }, run, () => {}))
      .toThrowError(expect.objectContaining({ code: 'snapshot_changed' }))
    expect(t.snapshot()).toEqual(before); expect(run.abort).not.toHaveBeenCalled()
  })

  it('rejects invalid host snapshot bounds, a confirmed snapshot and a stopped Run/Space without writes', () => {
    const t = fixture(), notes = [t.add()], run = t.begin(notes), before = t.snapshot()
    for (const snapshot of [[...notes, ...notes], Array.from({ length: 41 }, (_, i) => ({ ...notes[0]!, id: i + 1 })), [{ ...notes[0]!, status: 'confirmed' as const }]]) {
      expect(() => t.apply(snapshot, empty(), run)).toThrowError(expect.objectContaining({ code: 'snapshot_changed' }))
    }
    expect(() => t.apply(notes, { ...empty(), remove: [notes[0]!.id] }, run, () => { throw new Error('space archived during await') })).toThrow('space archived')
    expect(t.snapshot()).toEqual(before); expect(run.abort).not.toHaveBeenCalled()
  })

  it('rolls back earlier merges and every context/Task stop if a late remove fails', () => {
    const t = fixture(), notes = [t.add(), t.add(), t.add()], run = t.begin(notes), before = t.snapshot()
    t.db.exec(`CREATE TRIGGER fail_final_remove BEFORE DELETE ON memory_notes WHEN old.id=${notes[2]!.id} BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END`)
    expect(() => t.apply(notes, { merges: [{ ids: [notes[0]!.id, notes[1]!.id], kind: 'fact', title: '合并', body: '新正文' }], remove: [notes[2]!.id], review: [] }, run)).toThrow('synthetic late failure')
    expect(t.snapshot()).toEqual(before); expect(run.abort).not.toHaveBeenCalled()
    expect(t.memory.search(t.scope, notes[1]!.title).map(n => n.id)).toContain(notes[1]!.id)
  })

  it('leaves its caller transaction open and performs no abort before an outer commit', () => {
    const t = fixture(), notes = [t.add()], run = t.begin(notes), before = t.snapshot()
    t.db.exec('BEGIN')
    const result = t.apply(notes, { ...empty(), remove: [notes[0]!.id] }, run)
    expect(result.invalidatedRunIds).toEqual([run.id]); expect(run.abort).not.toHaveBeenCalled()
    t.db.exec('ROLLBACK')
    expect(t.snapshot()).toEqual(before)
  })
})

describe('consolidation and actual Delivery admission share one transaction', () => {
  function deliveryFixture() {
    const t = fixture(), notes = [t.add(), t.add()], run = t.begin(notes)
    const context: DeliveryContext = { actorOpenId: 'alice', audience: { kind: 'group', spaceId: t.space.id, chatId: 'chat' },
      sources: [{ ref: 'origin', spaceId: t.space.id, chatId: 'chat' }], expiresAt: Date.now() + 60_000, provenanceComplete: true }
    let result: MemoryOperationResult<MemoryConsolidationReceipt> | undefined
    const admit = vi.fn(() => { result = t.apply(notes, { merges: [{ ids: notes.map(n => n.id), kind: 'fact', title: '合并', body: '合并完整正文' }], remove: [], review: [] }, run) })
    const send = vi.fn(async () => {
      expect(service.get('consolidation:1')?.status).toBe('planned')
      expect(t.memory.get(result!.value.newNoteIds[0]!)).toBeDefined()
      t.runtime.complete(result!)
      return { remoteId: 'synthetic-remote' }
    })
    const service = new DeliveryService(t.db, { spaces: t.spaces, policy: t.policy, resolveContext: async () => context, admit, send })
    const deliver = () => service.deliver({ key: 'consolidation:1', contextRef: 'consolidation', payload: { text: '合并 2 条候选。' } })
    return { ...t, notes, run, admit, send, service, deliver }
  }

  it('rolls every memory/context/Task write back if the planned receipt cannot be stored; zero abort and zero POST', async () => {
    const t = deliveryFixture(), before = t.snapshot()
    t.db.exec("CREATE TRIGGER fail_planned BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'synthetic ledger failure'); END")
    await expect(t.deliver()).rejects.toThrow('synthetic ledger failure')
    expect(t.snapshot()).toEqual(before)
    expect(t.service.get('consolidation:1')).toBeUndefined()
    expect(t.run.abort).not.toHaveBeenCalled(); expect(t.send).not.toHaveBeenCalled()
  })

  it('aborts after committed batch+planned receipt, then replay does not reapply the old snapshot or POST again', async () => {
    const t = deliveryFixture()
    expect(await t.deliver()).toMatchObject({ status: 'sent', replayed: false })
    expect(t.run.abort).toHaveBeenCalledOnce()
    const after = t.snapshot()
    expect(await t.deliver()).toMatchObject({ status: 'sent', replayed: true })
    expect(t.snapshot()).toEqual(after); expect(t.admit).toHaveBeenCalledOnce(); expect(t.send).toHaveBeenCalledOnce()
  })

  it('preserves the committed correction on unknown send, without reapplying or resending it', async () => {
    const t = deliveryFixture(), original = t.send.getMockImplementation()!
    t.send.mockImplementation(async () => { await original(); throw new Error('synthetic lost ACK') })
    await expect(t.deliver()).rejects.toMatchObject({ code: 'unknown' })
    expect(t.service.get('consolidation:1')?.status).toBe('unknown')
    expect(t.run.abort).toHaveBeenCalledOnce()
    const after = t.snapshot()
    await expect(t.deliver()).rejects.toMatchObject({ code: 'unknown' })
    expect(t.snapshot()).toEqual(after); expect(t.admit).toHaveBeenCalledOnce(); expect(t.send).toHaveBeenCalledOnce()
  })
})
