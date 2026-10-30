import type { Bugs, BugStatus } from './bugs.js'
import type { BugQuestions } from './bug-questions.js'
import type { Registry } from './registry.js'
import type { RoutineStore } from './routines.js'

export type FeedbackStopReceipt = {
  applied: true; feedback_id: number; intake_phase: 'cancelled'; status: BugStatus; records_preserved: true
  questions_cancelled: number; queued_tasks_cancelled: number; running_tasks_stop_requested: number
  followups_paused: number; unbound_followup_ids: number[]; followup_scope_complete: boolean
} | {
  applied: false; feedback_id: number; reason: 'shared_active_task'; scope_complete: false; shared_task_ids: number[]
}

/** 宿主读取持久结果后生成，不接收模型的完成声明。 */
export type DomainOperationKind = 'feedback_control' | 'feedback_record' | 'feedback_update' | 'feedback_intake' | 'feedback_reply' | 'routine_control' | 'decision_resolve'
export type DomainOperationReceipt =
  | { kind: 'feedback_update'; id: number; fields: ('title' | 'status' | 'note')[] }
  | { kind: 'feedback_intake'; id: number; phase: string; missingInfo: number; fields: ('intakePhase' | 'missingInfo' | 'note' | 'status')[] }
  | { kind: 'feedback_note'; id: number }
  | { kind: 'feedback_record'; id: number; created: boolean; duplicate: boolean }
  | { kind: 'feedback_reply'; id: number; questionId: number; replyId: number; outcome: 'answered' | 'declined' | 'unavailable' }
  | { kind: 'routine_control'; id: number; name: string; action: 'pause' | 'resume' | 'delete'; enabled: boolean }
  | { kind: 'routine_observation'; id: number; name: string; enabled: boolean }
  | { kind: 'decision_resolve'; id: number; title: string; outcome: string; changed: boolean }
  | { kind: 'operation_failed'; operation: DomainOperationKind; id: number }

/** 本地反馈停止的持久部分；身份来自调用它的宿主，不接收模型正文或运行选择器。 */
export class FeedbackControl {
  constructor(private readonly registry: Registry, readonly bugs: Bugs, private readonly questions: BugQuestions, private readonly routines?: RoutineStore) {}

  /** 沿真实消息收据和 amendment 继承，不根据 Session 或文字猜案件。 */
  taskFeedbackIds(taskId: number): number[] {
    return this.relatedFeedbackIds(taskId, true)
  }

  /** 用户补充可关联案件，但不能作为停止执行的起点。祖先中的真实委托仍生效。 */
  private relatedFeedbackIds(taskId: number, includeUserNotes: boolean): number[] {
    const routineSources = this.routines ? `UNION SELECT r.feedback_id FROM ancestors a JOIN task_receipts tr ON tr.task_id = a.id
      JOIN routines r ON tr.dedup_key LIKE 'routine:' || r.id || ':%' WHERE r.feedback_id IS NOT NULL` : ''
    return (this.registry.db.prepare(`WITH RECURSIVE ancestors(id) AS (
      SELECT ? UNION SELECT m.prior_task_id FROM task_amendments m JOIN ancestors a ON m.task_id = a.id
    ) SELECT b.bucket_id FROM ancestors a JOIN tasks t ON t.id = a.id
      JOIN task_receipts tr ON tr.task_id = t.id AND tr.dedup_key = t.message_id
      JOIN sessions s ON s.session_key = t.session_key
      JOIN bug_reports b ON b.message_id = t.message_id AND b.chat_id = s.chat_id
      ${includeUserNotes ? '' : "WHERE b.record_kind = 'report'"}
    UNION SELECT q.bucket_id FROM ancestors a JOIN bug_questions q ON q.origin_task_id = a.id
    UNION SELECT q.bucket_id FROM ancestors a JOIN bug_question_replies r ON r.task_id = a.id JOIN bug_questions q ON q.id = r.question_id
    ${routineSources} ORDER BY bucket_id`).all(taskId) as { bucket_id: number }[]).map(row => row.bucket_id)
  }

  taskStopped(taskId: number, controlledFeedbackIds: readonly number[] = []): boolean {
    return this.relatedFeedbackIds(taskId, false).some((id) => !controlledFeedbackIds.includes(id) && this.bugs.get(id)?.intakePhase === 'cancelled')
  }

  private taskIdsForFeedback(feedbackId: number): number[] {
    const routineSeeds = this.routines ? `UNION SELECT tr.task_id FROM routines r JOIN task_receipts tr
      ON tr.dedup_key LIKE 'routine:' || r.id || ':%' WHERE r.feedback_id = :feedback` : ''
    return (this.registry.db.prepare(`WITH RECURSIVE related(task_id) AS (
      SELECT t.id FROM bug_reports b JOIN task_receipts tr ON tr.dedup_key = b.message_id
        JOIN tasks t ON t.id = tr.task_id AND t.message_id = b.message_id
        JOIN sessions s ON s.session_key = t.session_key AND s.chat_id = b.chat_id
        WHERE b.bucket_id = :feedback AND b.record_kind = 'report'
      UNION SELECT origin_task_id FROM bug_questions WHERE bucket_id = :feedback
      UNION SELECT r.task_id FROM bug_question_replies r JOIN bug_questions q ON q.id = r.question_id WHERE q.bucket_id = :feedback
      ${routineSeeds}
      UNION SELECT a.task_id FROM task_amendments a JOIN related b ON b.task_id = a.prior_task_id
    ) SELECT task_id FROM related ORDER BY task_id`).all({ feedback: feedbackId }) as { task_id: number }[]).map(row => row.task_id)
  }

  stop(input: { feedbackId: number; spaceId: string; chatId: string; chatType: 'group' | 'p2p'; openId: string; controllerTaskId: number; now?: number }) {
    const { registry, bugs, questions, routines } = this
    const bucket = bugs.get(input.feedbackId)
    if (!bucket || bucket.spaceId !== input.spaceId) throw new Error('没有这条反馈，或它不属于当前空间')
    const ids = this.taskIdsForFeedback(bucket.id)
    // 控制者可在同一请求中处理多个对象；它不属于需要终止的执行集合。
    const tasks = ids.map((id) => registry.getTask(id)!).filter((task) => task && task.id !== input.controllerTaskId && ['queued', 'running'].includes(task.status))
    for (const task of tasks) {
      const session = registry.getSession(task.sessionKey)
      if (!session || session.chatId !== input.chatId || session.chatType !== input.chatType ||
        (input.chatType === 'p2p' && task.requesterOpenId !== input.openId)) throw new Error('关联执行不属于当前可管理范围')
    }
    const shared = tasks.filter((task) => this.relatedFeedbackIds(task.id, false).some((id) => id !== bucket.id)).map((task) => task.id)
    if (shared.length) return { receipt: { applied: false, feedback_id: bucket.id, reason: 'shared_active_task', scope_complete: false, shared_task_ids: shared } as FeedbackStopReceipt, stoppedTaskIds: [] as number[], routineIds: [] as number[] }
    const linked = routines?.listForFeedback(bucket.id, input.spaceId) ?? []
    if (linked.some((routine) => !routines!.canManage(routine, input))) throw new Error('关联职责不属于当前可管理范围')
    // 旧未绑定职责仅列当前可管理候选，不能因 Session 相同而暂停。
    const unbound = (routines?.listFor({ chatId: input.chatId, chatType: input.chatType, ownerOpenId: input.openId }) ?? [])
      .filter((r) => r.kind === 'followup' && r.feedbackId === null && routines!.canManage(r, input)).map((r) => r.id)
    const now = input.now ?? Date.now()
    let queued = 0, running = 0, cancelled = 0, paused = 0
    const stoppedTaskIds: number[] = []
    registry.db.exec('SAVEPOINT stop_feedback')
    try {
      bugs.stopFollowing(bucket.id, input.spaceId, now)
      cancelled = questions.cancelForFeedback(bucket.id, input.spaceId)
      for (const task of tasks) {
        if (task.id === input.controllerTaskId) continue
        if (task.status === 'queued' && registry.cancelQueuedTask(task.id, now)) { queued++; stoppedTaskIds.push(task.id) }
        else if (task.status === 'running' && task.stopReason !== 'user_requested' && registry.requestStop(task.id)) { running++; stoppedTaskIds.push(task.id) }
      }
      // The delegations behind this case end with it; late user notes stay on record without reviving them.
      for (const workKey of new Set(ids.map(id => registry.taskWork.get(id)?.key).filter((key): key is `task:${number}` => Boolean(key)))) {
        registry.workContexts.control(workKey, { action: 'cancel', causeRef: `feedback:${bucket.id}` })
      }
      paused = routines?.pauseForFeedback(bucket.id, input.spaceId, now) ?? 0
      registry.db.exec('RELEASE SAVEPOINT stop_feedback')
    } catch (error) {
      registry.db.exec('ROLLBACK TO SAVEPOINT stop_feedback')
      registry.db.exec('RELEASE SAVEPOINT stop_feedback')
      throw error
    }
    return { receipt: { applied: true, feedback_id: bucket.id, intake_phase: 'cancelled', status: bucket.status, records_preserved: true,
      questions_cancelled: cancelled, queued_tasks_cancelled: queued, running_tasks_stop_requested: running, followups_paused: paused,
      unbound_followup_ids: unbound, followup_scope_complete: unbound.length === 0 } as FeedbackStopReceipt,
    stoppedTaskIds, routineIds: linked.map((r) => r.id) }
  }
}
