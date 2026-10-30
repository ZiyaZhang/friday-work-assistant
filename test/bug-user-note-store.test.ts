import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { FeedbackControl } from '../src/core/feedback-control.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function setup() {
  const registry = new Registry(':memory:'); cleanup.push(() => registry.close())
  const bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs), routines = new RoutineStore(registry.db)
  const feedback = new FeedbackControl(registry, bugs, questions, routines)
  registry.createSession({ sessionKey: 's', chatId: 'chat', chatType: 'group', requesterOpenId: 'alice', cwd: '/synthetic' })
  const task = (messageId: string, amendsTaskId?: number) => registry.createTaskOnce({ sessionKey: 's', messageId, requesterOpenId: 'alice', prompt: `原话 ${messageId}`, amendsTaskId }).task
  const origin = task('origin')
  const bucket = bugs.record({ spaceId: 'space', chatId: 'chat', messageId: origin.messageId, title: '原问题', text: '初次反馈', now: 100 }).bucket
  const stop = (id = bucket.id) => feedback.stop({ feedbackId: id, spaceId: 'space', chatId: 'chat', chatType: 'group', openId: 'alice', controllerTaskId: -1, now: 200 })
  const note = (messageId = 'correction', patch: Partial<Parameters<Bugs['captureUserNote']>[0]> = {}) => bugs.captureUserNote({ bucketId: bucket.id, spaceId: 'space', chatId: 'chat', messageId,
    reporterOpenId: 'alice', reporterName: 'Alice', text: '更正：已经恢复，请只保存原话。', now: 300, ...patch })
  return { registry, bugs, questions, routines, feedback, task, origin, bucket, stop, note }
}

describe('passive user notes on stopped feedback', () => {
  it('migrates existing rows as reports without changing original fields or counters', () => {
    const t = setup()
    t.registry.db.exec('ALTER TABLE bug_reports DROP COLUMN record_kind')
    const before = t.registry.db.prepare('SELECT * FROM bug_reports').all(), bucket = t.bugs.get(t.bucket.id)
    const migrated = new Bugs(t.registry.db)
    expect(t.registry.db.prepare('SELECT * FROM bug_reports').all()).toEqual(before.map(row => ({ ...row, record_kind: 'report' })))
    expect(migrated.reports(t.bucket.id)[0]?.recordKind).toBe('report')
    expect(migrated.get(t.bucket.id)).toEqual(bucket)
    expect(new Bugs(t.registry.db).reports(t.bucket.id)).toEqual(migrated.reports(t.bucket.id))
  })

  it('stores the complete source text and provenance without changing the case, questions, routines or report statistics', () => {
    const t = setup()
    const q = t.questions.prepare({ bucketId: t.bucket.id, spaceId: 'space', sessionKey: 's', originTaskId: t.origin.id, targetOpenId: 'alice',
      anchor: { tenantId: 'tenant', appId: 'app', chatId: 'chat', messageId: 'origin' }, kind: 'info', question: '版本是什么？' })
    t.routines.add({ kind: 'followup', feedbackId: t.bucket.id, spaceId: 'space', chatId: 'chat', chatType: 'group', sessionKey: 's', ownerOpenId: 'alice', name: '核对', prompt: '已委托的事', schedule: { type: 'once', atMs: 1000 }, now: 100 })
    t.bugs.setIntake({ bucketId: t.bucket.id, spaceId: 'space', phase: 'awaiting_info', missingInfo: ['版本'], note: '已有案件笔记' })
    t.bugs.linkIssue(t.bucket.id, 'https://github.com/synthetic/repo/issues/7')
    t.stop()
    const bucket = t.bugs.get(t.bucket.id), questions = t.questions.list(t.bucket.id, 'space'), routines = t.routines.listForFeedback(t.bucket.id, 'space'), stats = t.bugs.stats('space', 0)
    const raw = `  用户原话\n${'一段真实补充。'.repeat(450)}\n结尾更正：不要恢复跟进。  `
    expect(t.note('correction', { text: raw })).toEqual({ bucket, isNew: false, duplicate: false })
    expect(t.bugs.reports(t.bucket.id)[0]).toMatchObject({ recordKind: 'user_note', text: raw, messageId: 'correction', reporterOpenId: 'alice', reporterName: 'Alice', link: null, createdAt: 300 })
    expect(t.bugs.get(t.bucket.id)).toEqual(bucket)
    expect(t.questions.list(t.bucket.id, 'space')).toEqual(questions)
    expect(t.questions.get(q.id)?.resolution).toBe('cancelled')
    expect(t.routines.listForFeedback(t.bucket.id, 'space')).toEqual(routines)
    expect(t.bugs.stats('space', 0)).toEqual(stats)
  })

  it('keeps duplicate notes immutable and refuses cross-case, actor, text or original-report kind changes', () => {
    const t = setup(); t.stop()
    const first = t.note(), before = t.bugs.reports(t.bucket.id)
    expect(t.note()).toEqual({ ...first, duplicate: true })
    const other = t.bugs.record({ spaceId: 'space', chatId: 'chat', title: '另一案', text: '另一个现象' }).bucket
    t.stop(other.id)
    for (const patch of [{ bucketId: other.id }, { spaceId: 'foreign' }, { chatId: 'foreign' }, { reporterOpenId: 'bob' }, { text: '改写旧消息' }]) expect(() => t.note('correction', patch)).toThrow()
    expect(() => t.note('origin', { text: '初次反馈' })).toThrow('记录类型')
    expect(t.bugs.reports(t.bucket.id)).toEqual(before)
    expect(t.bugs.reports(t.bucket.id).filter(r => r.recordKind === 'report')).toHaveLength(1)
  })

  it('requires an existing stopped case and a non-empty real message, actor and body', () => {
    const t = setup()
    expect(() => t.note()).toThrow('已停止')
    t.stop()
    for (const patch of [{ bucketId: 999 }, { spaceId: 'other' }, { messageId: '' }, { reporterOpenId: '' }, { text: '  ' }]) expect(() => t.note('correction', patch)).toThrow()
    expect(t.bugs.reports(t.bucket.id)).toHaveLength(1)
  })

  it('keeps passive notes and their amendments associated but outside the stop execution graph', () => {
    const t = setup(); t.registry.updateTask(t.origin.id, { status: 'done' }); t.stop()
    const noteTask = t.task('correction'), child = t.task('later-correction', noteTask.id)
    t.registry.updateTask(noteTask.id, { status: 'running' })
    t.note(noteTask.messageId, { text: noteTask.prompt })
    expect(t.feedback.taskFeedbackIds(noteTask.id)).toEqual([t.bucket.id])
    expect(t.feedback.taskFeedbackIds(child.id)).toEqual([t.bucket.id])
    expect(t.feedback.taskStopped(noteTask.id)).toBe(false)
    expect(t.feedback.taskStopped(child.id)).toBe(false)
    expect(t.stop().receipt).toMatchObject({ queued_tasks_cancelled: 0, running_tasks_stop_requested: 0 })
    expect(t.registry.getTask(noteTask.id)).toMatchObject({ status: 'running', stopReason: null })
    expect(t.registry.getTask(child.id)?.status).toBe('queued')
    expect(() => t.routines.add({ kind: 'followup', feedbackId: t.feedback.taskFeedbackIds(noteTask.id)[0], spaceId: 'space', chatId: 'chat', chatType: 'group', name: '不能恢复', prompt: '后续', schedule: { type: 'once', atMs: 1000 } })).toThrow('停止')
  })

  it('does not let a note erase a real stopped ancestor or create a false cross-case stop conflict', () => {
    const t = setup(), oldAmendment = t.task('old-amendment', t.origin.id)
    t.registry.updateTask(t.origin.id, { status: 'done' }); t.stop()
    t.note(oldAmendment.messageId, { text: oldAmendment.prompt })
    expect(t.feedback.taskStopped(oldAmendment.id)).toBe(true)

    const newTask = t.task('another-case'), other = t.bugs.record({ spaceId: 'space', chatId: 'chat', title: '另一案', text: '另一个问题' }).bucket
    t.note(newTask.messageId, { text: newTask.prompt })
    t.questions.prepare({ bucketId: other.id, spaceId: 'space', sessionKey: 's', originTaskId: newTask.id, targetOpenId: 'alice',
      anchor: { tenantId: 'tenant', appId: 'app', chatId: 'chat', messageId: newTask.messageId }, kind: 'info', question: '另一案的信息？' })
    expect(t.feedback.taskFeedbackIds(newTask.id)).toEqual([t.bucket.id, other.id])
    expect(t.stop(other.id).receipt).toMatchObject({ applied: true, queued_tasks_cancelled: 1 })
  })

  it('retains complete notes after SQLite reopen and orders equal-time entries by their recorded sequence', () => {
    const home = mkdtempSync(join(tmpdir(), 'feedback-notes-')), path = join(home, 'notes.db')
    let registry = new Registry(path)
    cleanup.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
    let bugs = new Bugs(registry.db)
    const bucket = bugs.record({ spaceId: 'space', chatId: 'chat', title: '重启记录', text: '原文', messageId: 'origin', now: 100 }).bucket
    bugs.stopFollowing(bucket.id, 'space', 200)
    const input = { bucketId: bucket.id, spaceId: 'space', chatId: 'chat', reporterOpenId: 'alice', text: '原话\n完整保留', now: 300 }
    bugs.captureUserNote({ ...input, messageId: 'first' }); bugs.captureUserNote({ ...input, messageId: 'second' })
    const before = bugs.reports(bucket.id)
    expect(before.map(r => r.messageId)).toEqual(['second', 'first', 'origin'])
    registry.close(); registry = new Registry(path); bugs = new Bugs(registry.db)
    expect(bugs.reports(bucket.id)).toEqual(before)
    expect(bugs.captureUserNote({ ...input, messageId: 'second' }).duplicate).toBe(true)
    expect(bugs.get(bucket.id)).toMatchObject({ intakePhase: 'cancelled', count: 1, lastSeenAt: 100 })
  })
})
