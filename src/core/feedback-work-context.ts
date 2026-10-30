import type { Bugs, BugBucket, BugDeclinedInfo } from './bugs.js'
import type { BugQuestions } from './bug-questions.js'
import type { FeedbackControl } from './feedback-control.js'
import type { Registry, TaskRow } from './registry.js'
import type { RoutineStore, Routine } from './routines.js'

const TASK_LIMIT = 60
const FEEDBACK_LIMIT = 8
const ROUTINE_LIMIT = 12

export interface FeedbackWorkContextInput {
  taskId: number
  sessionKey: string
  spaceId: string
  chatId: string
  chatType: 'group' | 'p2p'
  actorOpenId: string
  /** Current host-approved capability scopes, not model declarations. */
  scopes: readonly string[]
  /** Exact parent / persisted ingress targets supplied by the host. Reading references does not join work. */
  referencedTaskIds?: readonly number[]
}

export interface FeedbackWorkContextSnapshot {
  work_key: string | null
  feedback: Array<{
    id: number
    relation: 'linked' | 'candidate'
    source_task_ids: number[]
    title: string
    status: BugBucket['status']
    intake_phase: BugBucket['intakePhase']
    following_stopped: boolean
    issue_url: string | null
    missing_info: string[]
    /** 用户已表示不提供的材料类别；宿主拒绝同类补问。 */
    declined_info: BugDeclinedInfo['kind'][]
    note: string | null
    note_truncated: boolean
    questions: Array<{ id: number; resolution: string }>
    operations: Array<'read' | 'update_intake' | 'stop_following' | 'capture_user_note'>
  }>
  routines: Array<Pick<Routine, 'id' | 'name' | 'kind' | 'status' | 'enabled'> & {
    disabled_reason: string | null
    feedback_id: number | null
  }>
  coverage: { history_truncated: boolean; work_truncated: boolean; references_truncated: boolean; feedback_truncated: boolean; routines_truncated: boolean; missing_links: boolean }
}

/** Bounded local facts only. The caller owns current membership and Run authorization. */
export class FeedbackWorkContext {
  constructor(private readonly deps: { registry: Registry; bugs: Bugs; feedback: FeedbackControl; questions?: BugQuestions; routines?: RoutineStore }) {}

  read(input: FeedbackWorkContextInput): FeedbackWorkContextSnapshot {
    const { registry, bugs, feedback, questions, routines } = this.deps
    const session = registry.getSession(input.sessionKey), task = registry.getTask(input.taskId)
    if (!session || session.status === 'archived' || session.chatId !== input.chatId || session.chatType !== input.chatType ||
      !task || task.sessionKey !== input.sessionKey || !input.actorOpenId || task.requesterOpenId !== input.actorOpenId) {
      throw new Error('事项上下文不属于当前任务或身份')
    }
    const work = registry.taskWork.get(task.id)
    const result: FeedbackWorkContextSnapshot = {
      work_key: work?.key ?? null, feedback: [], routines: [],
      coverage: { history_truncated: false, work_truncated: false, references_truncated: false, feedback_truncated: false, routines_truncated: false, missing_links: !work },
    }
    const genuine = (candidate: TaskRow | undefined): candidate is TaskRow => {
      if (!candidate || candidate.id > task.id || candidate.requesterOpenId !== input.actorOpenId) return false
      const owner = registry.getSession(candidate.sessionKey)
      return Boolean(owner && owner.status !== 'archived' && owner.chatId === input.chatId && owner.chatType === input.chatType &&
        candidate.messageId && registry.taskReceiptKeys(candidate.id).includes(candidate.messageId))
    }
    if (input.scopes.includes('bug:read')) {
      const related = new Map<number, { relation: 'linked' | 'candidate'; taskIds: Set<number> }>()
      const include = (candidate: TaskRow, relation: 'linked' | 'candidate') => {
        if (!registry.taskWork.get(candidate.id)) { result.coverage.missing_links = true; return }
        for (const id of feedback.taskFeedbackIds(candidate.id)) {
          if (bugs.get(id)?.spaceId !== input.spaceId) continue
          const previous = related.get(id)
          if (previous) { previous.taskIds.add(candidate.id); if (relation === 'linked') previous.relation = 'linked' }
          else related.set(id, { relation, taskIds: new Set([candidate.id]) })
        }
      }
      // A synthetic followup receipt does not become a genuine human message.
      if (genuine(task)) include(task, 'linked')
      if (work) {
        const rows = registry.db.prepare(`SELECT id FROM tasks WHERE work_root_task_id = ? AND session_key = ?
          AND requester_open_id = ? AND id <= ? ORDER BY id DESC LIMIT ?`)
          .all(work.rootTaskId, input.sessionKey, input.actorOpenId, task.id, TASK_LIMIT + 1) as { id: number }[]
        result.coverage.work_truncated = rows.length > TASK_LIMIT
        for (const row of rows.slice(0, TASK_LIMIT)) {
          const candidate = registry.getTask(row.id)
          if (genuine(candidate) && registry.taskWork.get(candidate.id)?.key === work.key) include(candidate, 'linked')
        }
      }
      result.coverage.references_truncated = (input.referencedTaskIds?.length ?? 0) > TASK_LIMIT
      for (const id of input.referencedTaskIds?.slice(0, TASK_LIMIT) ?? []) {
        const candidate = registry.getTask(id)
        if (genuine(candidate)) include(candidate, 'candidate')
        else result.coverage.missing_links = true
      }
      const history = registry.listInboundWorkTasksBefore(task.id, TASK_LIMIT + 1)
      result.coverage.history_truncated = history.length > TASK_LIMIT
      for (const candidate of history.slice(-TASK_LIMIT).reverse()) if (genuine(candidate)) include(candidate, 'candidate')
      const entries = [...related].sort((a, b) => Number(b[1].relation === 'linked') - Number(a[1].relation === 'linked'))
      result.coverage.feedback_truncated = entries.length > FEEDBACK_LIMIT
      result.feedback = entries.slice(0, FEEDBACK_LIMIT).map(([id, association]) => {
        const bucket = bugs.get(id)!
        const operations: FeedbackWorkContextSnapshot['feedback'][number]['operations'] = ['read']
        if (bucket.intakePhase === 'cancelled') {
          if (input.scopes.includes('bug:record') || input.scopes.includes('bug:write')) operations.push('capture_user_note')
        } else if (input.scopes.includes('bug:write')) {
          if (input.scopes.includes('routine:write') || !routines?.listForFeedback(id, input.spaceId).length) operations.push('stop_following')
          if (!bucket.issueUrl) operations.push('update_intake')
        }
        return { id, relation: association.relation, source_task_ids: [...association.taskIds], title: bucket.title,
          status: bucket.status, intake_phase: bucket.intakePhase, following_stopped: bucket.intakePhase === 'cancelled', issue_url: bucket.issueUrl,
          missing_info: bucket.missingInfo, declined_info: bucket.declinedInfo.map(entry => entry.kind), note: bucket.note?.slice(0, 600) ?? null, note_truncated: Boolean(bucket.note && bucket.note.length > 600),
          questions: (questions?.list(id, input.spaceId) ?? []).map(q => ({ id: q.id, resolution: q.resolution })), operations }
      })
    }
    if (routines && input.scopes.includes('routine:read')) {
      const allowed = routines.listFor({ chatId: input.chatId, chatType: input.chatType, ownerOpenId: input.actorOpenId })
        .filter(r => (r.spaceId === null || r.spaceId === input.spaceId) && routines.canManage(r, { chatId: input.chatId, chatType: input.chatType, openId: input.actorOpenId }))
      result.coverage.routines_truncated = allowed.length > ROUTINE_LIMIT
      result.routines = allowed.slice(0, ROUTINE_LIMIT).map(r => ({ id: r.id, name: r.name, kind: r.kind, status: r.status,
        enabled: r.enabled, disabled_reason: r.disabledReason, feedback_id: r.feedbackId }))
    }
    return result
  }
}
