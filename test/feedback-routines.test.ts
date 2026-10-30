import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Bugs } from '../src/core/bugs.js'
import { Registry } from '../src/core/registry.js'
import { FEEDBACK_STOPPED, RoutineStore } from '../src/core/routines.js'

const NOW = Date.UTC(2026, 8, 20)
const SPACE = 'space_synthetic_a'
const CHAT = 'oc_synthetic_a'
const opened: Registry[] = []
afterEach(() => { for (const registry of opened.splice(0)) registry.close() })
function setup() {
  const registry = new Registry(':memory:')
  opened.push(registry)
  const bugs = new Bugs(registry.db)
  const store = new RoutineStore(registry.db)
  const bucket = bugs.record({ spaceId: SPACE, chatId: CHAT, title: '合成上传反馈', text: '图片刷新后消失', messageId: 'om_report_a', now: NOW }).bucket
  const input = { kind: 'followup' as const, ownerOpenId: 'ou_synthetic_owner', spaceId: SPACE, chatId: CHAT, chatType: 'group' as const,
    name: '核对反馈', prompt: '按原反馈核对结果', schedule: { type: 'once' as const, atMs: NOW + 60_000 }, sessionKey: 'msg:om_synthetic_root', feedbackId: bucket.id, now: NOW }
  const cancelBucket = () => registry.db.prepare("UPDATE bug_buckets SET intake_phase = 'cancelled' WHERE id = ?").run(bucket.id)
  return { registry, bugs, store, bucket, input, cancelBucket }
}

function snapshot(t: ReturnType<typeof setup>) {
  return {
    routines: t.registry.db.prepare('SELECT * FROM routines ORDER BY id').all(),
    occurrences: t.registry.db.prepare('SELECT * FROM routine_occurrences ORDER BY id').all(),
    buckets: t.registry.db.prepare('SELECT * FROM bug_buckets ORDER BY id').all(),
  }
}

describe('feedback-bound followups', () => {
  it('migrates legacy routines without binding by session or requiring bug tables', () => {
    const registry = new Registry(':memory:'); opened.push(registry)
    let store = new RoutineStore(registry.db)
    const input = { kind: 'followup' as const, chatId: CHAT, chatType: 'group' as const, name: '旧记录', prompt: '保留旧任务',
      sessionKey: 'msg:legacy', schedule: { type: 'once' as const, atMs: NOW + 60_000 }, now: NOW }
    const old = store.add(input)
    const version = store.configVersion(old.id)
    registry.db.exec('DROP INDEX idx_routines_feedback; ALTER TABLE routines DROP COLUMN feedback_id')
    store = new RoutineStore(registry.db)
    expect(store.get(old.id)).toEqual(old)
    expect(store.get(old.id)?.feedbackId).toBeNull()
    expect(store.configVersion(old.id)).toBe(version)
    expect(() => store.add({ ...input, feedbackId: 1 })).toThrow('反馈记录不可用')
    const occurrence = store.claimDueOccurrence(old.id, old.nextRunAt, old.nextRunAt)!
    expect(store.startOccurrence(occurrence.id, old.nextRunAt)?.id).toBe(old.id)
  })

  it('accepts only followups whose feedback belongs to the same space and real source chat', () => {
    const t = setup()
    const before = snapshot(t)
    for (const patch of [{ kind: 'watch' as const }, { kind: 'schedule' as const }, { spaceId: 'other_space' }, { chatId: 'oc_other' }, { feedbackId: 0 }, { feedbackId: 999 }, { feedbackId: 1.5 }]) {
      expect(() => t.store.add({ ...t.input, ...patch })).toThrow()
      expect(snapshot(t)).toEqual(before)
    }
    const bound = t.store.add(t.input)
    expect(bound.feedbackId).toBe(t.bucket.id)
    t.bugs.addAnchor({ bucketId: t.bucket.id, spaceId: SPACE, tenantId: 'tenant_synthetic', appId: 'app_synthetic', chatId: 'oc_anchor', messageId: 'om_anchor' })
    expect(t.store.add({ ...t.input, chatId: 'oc_anchor' }).feedbackId).toBe(t.bucket.id)
    expect(() => t.store.listForFeedback(t.bucket.id, 'other_space')).toThrow('当前空间')
    expect(() => t.store.pauseForFeedback(t.bucket.id, 'other_space')).toThrow('当前空间')
    expect(t.store.get(bound.id)).toEqual(bound)
  })

  it('lists every bound state without pulling another case or an unbound followup from the same session', () => {
    const t = setup()
    const active = t.store.add(t.input)
    const paused = t.store.add(t.input); t.store.setEnabled(paused.id, false, NOW)
    const pending = t.store.add(t.input); t.store.claimDueOccurrence(pending.id, pending.nextRunAt, pending.nextRunAt)
    const proposed = t.store.add({ ...t.input, source: 'model' })
    const unbound = t.store.add({ ...t.input, feedbackId: null })
    const other = t.bugs.record({ spaceId: SPACE, chatId: CHAT, title: '另一合成反馈', text: '输入框错位', now: NOW }).bucket
    const another = t.store.add({ ...t.input, feedbackId: other.id })
    expect(t.store.get(pending.id)?.enabled).toBe(false)
    expect(t.store.listForFeedback(t.bucket.id, SPACE).map(r => r.id)).toEqual([active.id, paused.id, pending.id, proposed.id])
    expect(t.store.listForFeedback(other.id, SPACE).map(r => r.id)).toEqual([another.id])
    expect(t.store.get(unbound.id)?.feedbackId).toBeNull()
  })

  it('pauses pending/running once followups idempotently, preserving records, cursor and unrelated work', () => {
    const t = setup()
    const pending = t.store.add(t.input), running = t.store.add(t.input)
    const pendingOccurrence = t.store.claimDueOccurrence(pending.id, pending.nextRunAt, pending.nextRunAt)!
    const runningOccurrence = t.store.claimDueOccurrence(running.id, running.nextRunAt, running.nextRunAt)!
    t.store.startOccurrence(runningOccurrence.id, running.nextRunAt)
    // A retained legacy cursor is data to preserve even though new followups do not consume watch history.
    t.registry.db.prepare('UPDATE routines SET message_cursor_sec = ? WHERE id = ?').run(NOW / 1000 - 100, running.id)
    const other = t.bugs.record({ spaceId: SPACE, chatId: CHAT, title: '另一案', text: '另一现象', now: NOW }).bucket
    const unrelated = t.store.add({ ...t.input, feedbackId: other.id })
    const legacy = t.store.add({ ...t.input, feedbackId: null })
    const before = [pending, running].map(r => t.store.get(r.id)!)
    t.cancelBucket()
    expect(t.store.pauseForFeedback(t.bucket.id, SPACE, NOW + 61_000)).toBe(2)
    for (const old of before) {
      expect(t.store.get(old.id)).toEqual({ ...old, enabled: false, disabledReason: FEEDBACK_STOPPED })
      expect(t.store.configVersion(old.id)).toBe(2)
      expect(t.store.currentForExecution(old.id, 1)).toBeUndefined()
    }
    for (const occurrence of [pendingOccurrence, runningOccurrence]) {
      expect(t.store.getOccurrence(occurrence.id)).toMatchObject({ status: 'cancelled', error: FEEDBACK_STOPPED, finishedAt: NOW + 61_000 })
      expect(t.store.startOccurrence(occurrence.id, NOW + 62_000)).toBeUndefined()
      expect(t.store.finishOccurrence(occurrence.id, 'ok', NOW + 62_000)).toBeUndefined()
    }
    expect(t.store.get(unrelated.id)).toEqual(unrelated)
    expect(t.store.get(legacy.id)).toEqual(legacy)
    const stopped = snapshot(t)
    expect(t.store.pauseForFeedback(t.bucket.id, SPACE, NOW + 70_000)).toBe(0)
    expect(snapshot(t)).toEqual(stopped)
    expect(t.store.recordRun(running.id, 'failed', NOW + 70_000, 'late cancelled error')).toBeUndefined()
    expect(snapshot(t)).toEqual(stopped)
  })

  it('composes with the whole-case transaction and rolls back both versions and occurrences on failure', () => {
    const t = setup()
    const a = t.store.add(t.input), b = t.store.add(t.input)
    for (const r of [a, b]) t.store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)
    const before = snapshot(t)
    t.registry.db.exec(`CREATE TRIGGER reject_second_stop BEFORE UPDATE ON routine_occurrences WHEN NEW.routine_id = ${b.id} AND NEW.status = 'cancelled' BEGIN SELECT RAISE(ABORT, 'synthetic stop failure'); END`)
    expect(() => t.store.pauseForFeedback(t.bucket.id, SPACE, NOW + 61_000)).toThrow('synthetic stop failure')
    expect(snapshot(t)).toEqual(before)
    t.registry.db.exec('DROP TRIGGER reject_second_stop; SAVEPOINT stop_case')
    t.cancelBucket()
    expect(t.store.pauseForFeedback(t.bucket.id, SPACE, NOW + 61_000)).toBe(2)
    t.registry.db.exec('ROLLBACK TO SAVEPOINT stop_case; RELEASE SAVEPOINT stop_case')
    expect(snapshot(t)).toEqual(before)
  })

  it('rejects creation, accepting a proposal, resuming and reconfiguring a stopped case without any write', () => {
    const t = setup()
    const active = t.store.add(t.input)
    const paused = t.store.add(t.input); t.store.setEnabled(paused.id, false, NOW)
    const proposed = t.store.add({ ...t.input, source: 'model' })
    t.cancelBucket()
    const before = snapshot(t)
    const mutations = [() => t.store.add(t.input), () => t.store.accept(proposed.id, 'ou_owner', NOW), () => t.store.resume(active.id, NOW),
      () => t.store.resume(paused.id, NOW), () => t.store.setEnabled(paused.id, true, NOW), () => t.store.update(active.id, { prompt: '不应重启', schedule: { type: 'once', atMs: NOW + 120_000 } }, NOW)]
    for (const mutate of mutations) {
      expect(mutate).toThrow(FEEDBACK_STOPPED)
      expect(snapshot(t)).toEqual(before)
    }
  })

  it('rechecks the case at claim, start, publishing and completion even if a stale routine remains enabled', () => {
    const t = setup()
    const due = t.store.add(t.input), pending = t.store.add(t.input), running = t.store.add(t.input)
    const pendingOccurrence = t.store.claimDueOccurrence(pending.id, pending.nextRunAt, pending.nextRunAt)!
    const runningOccurrence = t.store.claimDueOccurrence(running.id, running.nextRunAt, running.nextRunAt)!
    t.store.startOccurrence(runningOccurrence.id, running.nextRunAt)
    t.cancelBucket()
    expect(t.store.claimDueOccurrence(due.id, due.nextRunAt, due.nextRunAt)).toBeUndefined()
    expect(t.store.listOccurrences(due.id)).toEqual([])
    expect(t.store.startOccurrence(pendingOccurrence.id, NOW + 61_000)).toBeUndefined()
    expect(t.store.getOccurrence(pendingOccurrence.id)?.status).toBe('cancelled')
    expect(t.store.currentForExecution(running.id, 1, runningOccurrence.id)).toBeUndefined()
    expect(t.store.currentForExecution(due.id, 1)).toBeUndefined()
    expect(t.store.finishOccurrence(runningOccurrence.id, 'ok', NOW + 62_000)).toBeUndefined()
    expect(t.store.getOccurrence(runningOccurrence.id)?.status).toBe('cancelled')
    expect(t.store.get(running.id)).toMatchObject({ runs: 0, failCount: 0, lastRunAt: null })
  })

  it('invalidates a bound execution after its feedback no longer belongs to that space', () => {
    const t = setup()
    const r = t.store.add(t.input)
    const occurrence = t.store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    t.store.startOccurrence(occurrence.id, r.nextRunAt)
    t.registry.db.prepare('UPDATE bug_buckets SET space_id = ? WHERE id = ?').run('moved_space', t.bucket.id)
    expect(t.store.currentForExecution(r.id, 1, occurrence.id)).toBeUndefined()
    expect(() => t.store.setEnabled(r.id, true, NOW)).toThrow('当前空间')
  })

  it('keeps stopped feedback cancelled after a real SQLite reopen while other unfinished work is interrupted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-feedback-routines-'))
    const path = join(dir, 'registry.sqlite')
    let registry = new Registry(path)
    try {
      let store = new RoutineStore(registry.db)
      const bugs = new Bugs(registry.db)
      const bucket = bugs.record({ spaceId: SPACE, chatId: CHAT, title: '重启合成反馈', text: '合成现象', now: NOW }).bucket
      const input = { kind: 'followup' as const, spaceId: SPACE, chatId: CHAT, chatType: 'group' as const, name: '检查', prompt: '跟进', schedule: { type: 'once' as const, atMs: NOW + 60_000 }, now: NOW }
      const pending = store.add({ ...input, feedbackId: bucket.id }), running = store.add({ ...input, feedbackId: bucket.id }), legacy = store.add(input)
      for (const r of [pending, running, legacy]) {
        const occurrence = store.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
        if (r.id !== pending.id) store.startOccurrence(occurrence.id, r.nextRunAt)
      }
      registry.db.prepare("UPDATE bug_buckets SET intake_phase = 'cancelled' WHERE id = ?").run(bucket.id)
      registry.close(); registry = new Registry(path); store = new RoutineStore(registry.db)
      expect(store.recoverInterruptedOccurrences(NOW + 65_000).map(o => o.routineId)).toEqual([legacy.id])
      for (const r of [pending, running]) {
        expect(store.get(r.id)).toMatchObject({ feedbackId: bucket.id, enabled: false, disabledReason: FEEDBACK_STOPPED, runs: 0 })
        expect(store.listOccurrences(r.id)[0]?.status).toBe('cancelled')
        expect(() => store.resume(r.id, NOW + 70_000)).toThrow(FEEDBACK_STOPPED)
      }
      expect(store.listOccurrences(legacy.id)[0]?.status).toBe('interrupted')
      expect(store.recoverInterruptedOccurrences(NOW + 70_000)).toEqual([])
    } finally { registry.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
