import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bugs, type BugStatus } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { FeedbackControl } from '../src/core/feedback-control.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'

const opened: Registry[] = []
afterEach(() => { for (const r of opened.splice(0)) r.close(); vi.restoreAllMocks() })
function setup() {
  const registry = new Registry(':memory:'); opened.push(registry)
  const bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs), routines = new RoutineStore(registry.db)
  const control = new FeedbackControl(registry, bugs, questions, routines)
  registry.createSession({ sessionKey: 's', chatId: 'chat', chatType: 'group', requesterOpenId: 'alice', cwd: '/synthetic' })
  const task = (messageId: string, amendsTaskId?: number) => registry.createTaskOnce({ sessionKey: 's', messageId, requesterOpenId: 'alice', prompt: messageId, amendsTaskId }).task
  const origin = task('origin')
  const bucket = bugs.record({ spaceId: 'space', chatId: 'chat', messageId: origin.messageId, title: '反馈 A', text: '原始资料' }).bucket
  const question = (bucketId = bucket.id, originTask = origin) => questions.prepare({ bucketId, spaceId: 'space', sessionKey: 's', originTaskId: originTask.id, targetOpenId: 'alice',
    anchor: { tenantId: 'tenant', appId: 'app', chatId: 'chat', messageId: originTask.messageId }, kind: 'info', question: '具体发生了什么？' })
  const followup = (feedbackId: number | null = bucket.id) => routines.add({ kind: 'followup', feedbackId, spaceId: 'space', chatId: 'chat', chatType: 'group', ownerOpenId: 'alice',
    sessionKey: 's', name: '核对', prompt: '已有委托', schedule: { type: 'once', atMs: Date.now() + 60_000 } })
  const stop = (feedbackId = bucket.id, controllerTaskId = -1) => control.stop({ feedbackId, spaceId: 'space', chatId: 'chat', chatType: 'group', openId: 'alice', controllerTaskId, now: 500 })
  const snapshot = () => ['bug_buckets', 'bug_questions', 'tasks', 'routines', 'routine_occurrences'].map(table => registry.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
  return { registry, bugs, questions, routines, control, task, origin, bucket, question, followup, stop, snapshot }
}

describe('feedback stop atomic storage boundary', () => {
  it.each(['open', 'triaging', 'fixed', 'wontfix', 'linked'] as const)('keeps %s business status, report and Issue link while stopping only local followup', (status) => {
    const t = setup()
    if (status === 'linked') t.bugs.linkIssue(t.bucket.id, 'https://github.com/synthetic/repo/issues/7')
    else if (status !== 'open') t.bugs.setStatus(t.bucket.id, status as BugStatus)
    const before = t.bugs.get(t.bucket.id)!, reports = t.bugs.reports(t.bucket.id)
    expect(t.stop().receipt).toMatchObject({ applied: true, status: before.status, records_preserved: true, intake_phase: 'cancelled' })
    expect(t.bugs.get(t.bucket.id)).toEqual({ ...before, intakePhase: 'cancelled', intakeUpdatedAt: 500 })
    expect(t.bugs.reports(t.bucket.id)).toEqual(reports)
    expect(() => t.bugs.setIntake({ bucketId: t.bucket.id, spaceId: 'space', phase: 'diagnosing' })).toThrow()
    expect(() => t.bugs.retitle(t.bucket.id, '迟到标题')).toThrow('已停止')
    expect(() => t.bugs.linkIssue(t.bucket.id, 'https://github.com/synthetic/repo/issues/8')).toThrow('已停止')
    expect(() => t.question()).toThrow('已停止')
  })

  it('follows two amendments and a bound occurrence but preserves unrelated tasks and unbound legacy work in the same session', () => {
    const t = setup(), a = t.task('amend-1', t.origin.id), b = t.task('amend-2', a.id), other = t.task('other')
    t.registry.updateTask(t.origin.id, { status: 'done' }); t.registry.updateTask(a.id, { status: 'done' }); t.registry.updateTask(b.id, { status: 'running' })
    const queued = t.task('amend-3', b.id), r = t.followup(), legacy = t.followup(null)
    const occurrence = t.routines.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    t.routines.startOccurrence(occurrence.id, r.nextRunAt)
    const followupTask = t.registry.createTaskOnce({ sessionKey: 's', messageId: 'origin', requesterOpenId: 'alice', prompt: '跟进' }, `routine:${r.id}:occurrence:${occurrence.id}`).task
    expect(t.control.taskFeedbackIds(b.id)).toEqual([t.bucket.id])
    expect(t.control.taskFeedbackIds(other.id)).toEqual([])
    expect(t.control.taskFeedbackIds(followupTask.id)).toEqual([t.bucket.id])
    const result = t.stop()
    expect(result.receipt).toMatchObject({ applied: true, queued_tasks_cancelled: 2, running_tasks_stop_requested: 1, followups_paused: 1, unbound_followup_ids: [legacy.id], followup_scope_complete: false })
    expect(t.registry.getTask(b.id)).toMatchObject({ status: 'running', stopReason: 'user_requested' })
    expect(t.registry.getTask(queued.id)?.status).toBe('cancelled')
    expect(t.registry.getTask(followupTask.id)?.status).toBe('cancelled')
    expect(t.registry.getTask(other.id)).toEqual(other)
    expect(t.routines.get(legacy.id)).toEqual(legacy)
    expect(t.routines.getOccurrence(occurrence.id)?.status).toBe('cancelled')
    const before = t.snapshot()
    expect(t.stop().receipt).toMatchObject({ applied: true, queued_tasks_cancelled: 0, running_tasks_stop_requested: 0, followups_paused: 0 })
    expect(t.snapshot()).toEqual(before)
    expect(new FeedbackControl(t.registry, t.bugs, t.questions, t.routines).taskStopped(b.id)).toBe(true)
  })

  it('refuses a shared active task including inherited case associations without mutating either case', () => {
    const t = setup(), other = t.bugs.record({ spaceId: 'space', chatId: 'chat', title: '反馈 B', text: '另一案' }).bucket
    const q = t.question(other.id), child = t.task('both', t.origin.id)
    t.registry.updateTask(t.origin.id, { status: 'done' }); t.registry.updateTask(child.id, { status: 'running' })
    t.followup()
    expect(t.control.taskFeedbackIds(child.id)).toEqual([t.bucket.id, other.id])
    const before = t.snapshot()
    expect(t.stop().receipt).toEqual({ applied: false, feedback_id: t.bucket.id, reason: 'shared_active_task', scope_complete: false, shared_task_ids: [child.id] })
    expect(t.snapshot()).toEqual(before)
    expect(t.questions.get(q.id)?.resolution).toBe('open')
  })

  it('rolls back the case, questions and queued task when pausing a bound routine fails', () => {
    const t = setup(); t.question(); t.followup()
    const before = t.snapshot(), work = t.registry.workContexts.get(`task:${t.origin.id}`)
    vi.spyOn(t.routines, 'pauseForFeedback').mockImplementation(() => { throw new Error('synthetic failure') })
    expect(() => t.stop()).toThrow('synthetic failure')
    expect(t.snapshot()).toEqual(before)
    expect(t.registry.workContexts.get(`task:${t.origin.id}`)).toEqual(work)
  })

  it('cancels the delegations behind the case and leaves unrelated work open; a late note is recorded without reviving', () => {
    const t = setup(), amend = t.task('amend', t.origin.id), unrelated = t.task('unrelated')
    t.registry.updateTask(t.origin.id, { status: 'done' })
    const key = `task:${t.origin.id}` as const
    expect(t.registry.workContexts.get(key)).toMatchObject({ lifecycle: 'open', inputSeq: 2 })
    expect(t.stop().receipt).toMatchObject({ applied: true, queued_tasks_cancelled: 1 })
    expect(t.registry.workContexts.get(key)).toMatchObject({ lifecycle: 'cancelled', pauseReasons: [] })
    expect(t.registry.workContexts.get(`task:${unrelated.id}`)).toMatchObject({ lifecycle: 'open' })
    expect(() => t.registry.workContexts.claim(key)).toThrow(/cancelled/)
    const late = t.task('late-note', amend.id)
    expect(t.registry.workContexts.get(key)).toMatchObject({ lifecycle: 'cancelled', inputSeq: 3 })
    expect(t.registry.workContexts.inputs(key).at(-1)).toMatchObject({ taskId: late.id })
    expect(t.registry.workContexts.view(key)).toMatchObject({ activity: 'idle' })
  })

  it('excludes only the explicit control invocation and blocks later mutations on the stopped case', () => {
    const t = setup(), other = t.task('amend', t.origin.id), unrelated = t.task('unrelated')
    t.registry.updateTask(t.origin.id, { status: 'running' })
    const q = t.question()
    expect(t.stop(t.bucket.id, t.origin.id).receipt).toMatchObject({ applied: true, questions_cancelled: 1, queued_tasks_cancelled: 1 })
    expect(t.registry.getTask(t.origin.id)).toMatchObject({ status: 'running', stopReason: null })
    expect(t.registry.getTask(other.id)?.status).toBe('cancelled')
    expect(t.registry.getTask(unrelated.id)).toEqual(unrelated)
    expect(t.questions.get(q.id)?.resolution).toBe('cancelled')
    expect(() => t.bugs.record({ bucketId: t.bucket.id, spaceId: 'space', chatId: 'chat', title: 'late', text: '迟到资料', messageId: 'late' })).toThrow('已停止')
    expect(t.bugs.record({ bucketId: t.bucket.id, spaceId: 'space', chatId: 'chat', title: 'replay', text: '重复事件', messageId: 'origin' }).duplicate).toBe(true)
  })
})
