import type { Registry } from './registry.js'
import type { RunAttempts } from './run-attempts.js'
import { AUTH_EXPIRED, FEEDBACK_STOPPED, MAX_PAUSE_MS, RoutineControlError, describeSchedule, type Routine, type RoutineControlAction, type RoutineOverlap, type RoutineStore } from './routines.js'
import { dmSpaceId, type Spaces } from './space.js'
import { decisionRef, type Inbox, type PendingItem } from './inbox.js'
import type { PolicyService } from './policy.js'
import { USER_SCOPE_TIERS, type UserTokenStore } from '../feishu/oauth.js'
import type { DatabaseSync } from 'node:sqlite'
import { listDeliveryReceipts, type DeliveryAudience, type DeliveryReconciliationSummary, type DeliveryStatus } from './delivery.js'
import { routineExecutionKey, routineDigestDeliveryKey, taskDeliveryContextRef } from './execution-keys.js'

interface ActiveRoutineRun { runId: string; abort: AbortController }

export class RoutineControlConflictError extends RoutineControlError {}

export interface PersistedRoutineControl {
  routine: Routine | undefined
  changed: boolean
  affectedRunIds: string[]
  /** Invoke only after the outermost transaction commits; discard on rollback. */
  afterCommit(): void
}

/** 提案指针上的标题；提案创建和修改用同一个写法，My Day 与捎带看到的就是卡片上的名字和频率。 */
export function proposalPointerTitle(routine: Pick<Routine, 'name' | 'schedule'>): string {
  return `职责提案「${routine.name}」（${describeSchedule(routine.schedule)}）`
}

/** 待拍板说明里的一句话：两条职责为什么算产出重复。 */
export function describeOverlap(overlap: Pick<RoutineOverlap, 'reason'>): string {
  return overlap.reason === 'same_watch_chats' ? '关注同一组群' : '发给同一受众、写到同一处'
}

export type ProposalDecision = 'accept' | 'ignore'
export type ProposalDenial = 'no_operator' | 'wrong_space' | 'space_inactive' | 'not_self' | 'not_owner' | 'policy' | 'unavailable'

/** 身份和空间都来自宿主核实过的平台回调，不来自卡片 value 或模型参数。 */
export interface ProposalDecisionInput {
  routineId: number
  /** 卡片按钮里的 config_version。旧卡没有这个字段时传 undefined，按过期卡处理。 */
  expectedConfigVersion: number | undefined
  decision: ProposalDecision
  /** 平台回调里的真实点击人 */
  operatorOpenId: string
  /** 宿主按回调所在会话解析出的空间 */
  spaceId: string
  /** 宿主事先取得的验证租约（比如刚核过的群成员身份）；在同一事务里、写入之前调用，失效就抛错，什么都不写。 */
  assertCurrent?: () => void
}

export type ProposalDecisionResult =
  | { outcome: 'accepted' | 'ignored'; changed: true; routine: Routine }
  | { outcome: 'already_accepted' | 'already_ignored'; changed: false; routine: Routine }
  | { outcome: 'expired'; changed: boolean; routine: Routine }
  | { outcome: 'stale_card'; changed: false; routine: Routine; currentConfigVersion: number }
  | { outcome: 'conflict'; changed: false; routine: Routine; current: 'accepted' | 'ignored' }
  | { outcome: 'not_a_proposal'; changed: false }
  | { outcome: 'denied'; changed: false; code: ProposalDenial; reason: string }
  | { outcome: 'not_found'; changed: false }

export type ProposalStatus =
  | { state: 'pending' | 'stale_card'; currentConfigVersion: number; expiresAt: number | null }
  | { state: 'accepted' | 'ignored'; currentConfigVersion: number; decidedBy: string | null; decidedAt: number | null }
  | { state: 'expired'; currentConfigVersion: number }
  | { state: 'not_a_proposal' | 'not_found' }

/** Persisted progress only; a completed model run does not prove an external delivery. */
export function routineProgress(store: RoutineStore, routine: Routine, db: DatabaseSync, audience?: DeliveryAudience) {
  const occurrence = store.listOccurrences(routine.id, 1)[0]
  const resume = store.resumeState(routine.id)
  const recovery = routine.status === 'proposed' ? 'resolve_proposal'
    : routine.status !== 'active' ? 'none'
    : routine.disabledReason === AUTH_EXPIRED ? 'reauthorize'
    : resume?.kind === 'feedback_blocked' ? (resume.reason === FEEDBACK_STOPPED ? 'feedback_stopped' : 'inspect_feedback')
    : resume?.kind === 'schedule_disabled' ? 'reconfigure'
    : routine.disabledReason === '空间已停用' ? 'restore_space'
    : resume?.kind === 'waiting' ? 'wait'
    : resume?.kind === 'inspect_previous_run' ? 'inspect_previous_run'
    : resume?.kind === 'ready' ? 'resume'
    : 'none'
  const managedDelivery = routineDeliveryProgress(db, routine, occurrence, audience)
  const nextRunAt = routine.status === 'active' && routine.enabled ? new Date(routine.nextRunAt).toISOString() : null
  // Only a manual pause is resumed automatically (dueResumes); never promise it for any other stop.
  const resumeAt = !routine.enabled && routine.disabledReason === '手动停用' && routine.resumeAt !== null ? new Date(routine.resumeAt).toISOString() : null
  const executionFact = occurrence?.status === 'interrupted' ? '最近一次调度执行中断，完成结果未知。'
    : occurrence?.status === 'running' ? '最近一次调度执行仍在进行。'
    : occurrence?.status === 'pending' ? '最近一次调度执行还在等待开始。'
    : occurrence ? `最近一次调度执行${({ ok: '已结束', skipped: '已跳过', failed: '失败', cancelled: '已取消' } as const)[occurrence.status]}；运行结束不等于结果已送达。`
    : '暂无调度执行记录。'
  const blocked = managedDelivery.items.some(item => item.status === 'planned' || item.status === 'unknown') ||
    resume?.kind === 'inspect_previous_run'
  const nextStep = blocked ? '先核对原执行实际产生的消息或产物，结果未明时不要补发；聊天或当前工作区没有记录也不能排除其他外部操作。'
    : recovery === 'wait' ? '等待当前执行结束，不重复启动。'
    : recovery === 'reauthorize' ? '先恢复本人授权，再核对实际恢复了哪些职责。'
    : recovery === 'restore_space' ? '先恢复原空间，再核对职责是否可执行。'
    : resume && 'reason' in resume ? resume.reason
    : recovery === 'resume' ? '目前保持暂停；如需恢复或调整安排，仍须明确委托并核验当前授权。'
    : '本次查询没有更改职责安排。'
  return {
    run_as: routine.runAs,
    message_cursor_at: routine.messageCursorSec === null ? null : new Date(routine.messageCursorSec * 1000).toISOString(),
    last_run_at: routine.lastRunAt === null ? null : new Date(routine.lastRunAt).toISOString(),
    last_status: routine.lastStatus,
    next_run_at: nextRunAt,
    /** 约定的自动恢复时间；到点仍按手动恢复的同一套检查执行，检查不过就保持暂停并说明原因。 */
    resume_at: resumeAt,
    latest_occurrence: occurrence ? { id: occurrence.id, status: occurrence.status, window_key: occurrence.windowKey,
      scheduled_at: new Date(occurrence.scheduledAt).toISOString(), started_at: occurrence.startedAt,
      finished_at: occurrence.finishedAt } : null,
    // Execution-state eligibility only; control still checks the current caller, space and authorization.
    can_resume_execution: resume?.kind === 'ready' || resume?.kind === 'enabled',
    resume_block_reason: resume && 'reason' in resume ? resume.reason : null,
    recovery,
    managed_delivery: managedDelivery,
    fact_summary: `${nextRunAt === null ? (resumeAt ? `已暂停至 ${resumeAt}，到时自动恢复。` : '当前没有安排下一次运行。') : `下次安排：${nextRunAt}。`}${executionFact}${managedDelivery.summary}`,
    next_step: nextStep,
  }
}

/** Only this occurrence's host-managed messages, never a claim about native/external side effects. */
function routineDeliveryProgress(db: DatabaseSync, routine: Routine, occurrence: ReturnType<RoutineStore['listOccurrences']>[number] | undefined, audience?: DeliveryAudience) {
  const items: { kind: 'summary' | 'file' | 'message' | 'question' | 'note' | 'notice'; key: string; status: DeliveryStatus; remote_id: string | null
    /** A human with current space access may ask the platform what actually happened to sent/unknown receipts. */
    can_reconcile: boolean; reconciliation: DeliveryReconciliationSummary | null }[] = []
  const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
  if (occurrence && hasTable('deliveries')) {
    const executionKey = routineExecutionKey(routine.id, { occurrenceId: occurrence.id, configVersion: occurrence.configVersion })
    const contexts = [executionKey, `${executionKey}:tool:here`, `${executionKey}:tool:dm`]
    if (routine.kind === 'followup' && hasTable('task_receipts')) {
      const task = db.prepare(`SELECT t.id,t.session_key FROM task_receipts r JOIN tasks t ON t.id=r.task_id
        JOIN sessions s ON s.session_key=t.session_key
        WHERE r.dedup_key=? AND s.chat_id=? AND s.chat_type=?`).get(executionKey, routine.chatId, routine.chatType)
      if (task) {
        const ref = taskDeliveryContextRef(Number(task.id), String(task.session_key))
        contexts.push(ref, `${ref}:notice`, `${ref}:tool:here`, `${ref}:tool:dm`)
      }
    }
    // Receipts of earlier windows that still hold this routine (planned/unknown, not proven absent) stay visible until resolved.
    const unresolvedContexts = (db.prepare(`SELECT DISTINCT context_ref FROM deliveries WHERE context_ref LIKE ? AND status IN ('planned', 'unknown')
      AND (error IS NULL OR error <> 'verified_absent')`).all(`routine:${routine.id}:%`) as { context_ref: string }[]).map(row => row.context_ref)
    const rows = listDeliveryReceipts(db, [...new Set([...contexts, ...unresolvedContexts])], audience)
    for (const row of rows) {
      const key = row.delivery_key
      const kind = key === routineDigestDeliveryKey(executionKey) || /:digest$/.test(key) || /:final:\d+$/.test(key) ? 'summary'
        : key.startsWith('question:') ? 'question' : key.includes(':note:') ? 'note'
        : key.includes(':file:') ? 'file' : key.endsWith(':notice') ? 'notice' : 'message'
      items.push({ kind, key, status: row.status, remote_id: row.remote_id,
        can_reconcile: row.status === 'sent' || row.status === 'unknown', reconciliation: row.reconciliation })
    }
  }
  const counts = (status: DeliveryStatus) => items.filter(item => item.status === status).length
  const descriptions = [counts('confirmed') && `${counts('confirmed')} 条消息已回读核实`, counts('sent') && `${counts('sent')} 条消息已获平台发送回执`,
    counts('planned') && `${counts('planned')} 条消息已登记发送但尚无结果`, counts('unknown') && `${counts('unknown')} 条消息发送结果未知`].filter(Boolean)
  return { coverage: 'gateway_messages_only' as const, audience_filtered: Boolean(audience), record_status: items.length ? 'recorded' as const : 'not_recorded' as const, items,
    summary: items.length ? `${audience ? '当前受众可查看的' : ''}网关记录：${descriptions.join('；')}。这些回执只覆盖网关管理的消息，不证明用户已读、任务完成或其他外部操作的结果。`
      : audience ? '当前受众可查看的网关回执中没有记录；不能据此认定未发送。'
        : '网关没有这次调度执行的消息投递回执；不能据此认定未发送或没有其他外部操作。' }
}

/** Shared domain operations. Entrypoints verify the real caller before invoking control. */
export class RoutineApplication {
  constructor(private readonly deps: {
    registry: Registry
    spaces: Spaces
    routines?: RoutineStore
    userTokens?: UserTokenStore
    inbox?: Inbox
    /** 提案决定需要；缺失时决定一律拒绝，不退回到只看空间角色。 */
    policy?: PolicyService
    attempts: RunAttempts
    activeRuns(id: number): ActiveRoutineRun[]
    now(): number
  }) {}

  /**
   * 接受 / 忽略一条职责提案。同步短事务：核对空间、点击人、卡片版本和提案状态，
   * 写职责状态并结清同一条 Inbox 指针；任何一步失败都整体回滚。发卡、改卡由宿主在提交后做。
   */
  decideProposal(input: ProposalDecisionInput): ProposalDecisionResult {
    const { registry } = this.deps
    registry.db.exec('SAVEPOINT decide_routine_proposal')
    try {
      const result = this.decideProposalNow(input)
      registry.db.exec('RELEASE SAVEPOINT decide_routine_proposal')
      return result
    } catch (error) {
      registry.db.exec('ROLLBACK TO SAVEPOINT decide_routine_proposal; RELEASE SAVEPOINT decide_routine_proposal')
      throw error
    }
  }

  private decideProposalNow(input: ProposalDecisionInput): ProposalDecisionResult {
    const { routines, spaces, policy, inbox } = this.deps
    const denied = (code: ProposalDenial, reason: string): ProposalDecisionResult => ({ outcome: 'denied', changed: false, code, reason })
    const operator = input.operatorOpenId?.trim()
    if (!operator) return denied('no_operator', '认不出是谁点的，不能处理职责提案')
    const r = routines?.get(input.routineId)
    if (!routines || !r) return { outcome: 'not_found', changed: false }
    // 不是提案就不往下判断，也不把这一行交给调用方
    if (r.source !== 'model') return { outcome: 'not_a_proposal', changed: false }
    const space = r.spaceId ? spaces.get(r.spaceId) : spaces.byChat(r.chatId)
    if (!space) return denied('space_inactive', '提案所属空间已失效，不能处理')
    if (input.spaceId !== space.id) return denied('wrong_space', '只能在提案所在的会话里处理')
    if (space.status !== 'active' || space.kind !== r.chatType || space.chatId !== r.chatId) return denied('space_inactive', '提案所属空间已失效，不能处理')
    if (space.kind === 'p2p' && space.id !== dmSpaceId(operator)) return denied('not_self', '只有本人能决定')
    // 部署 auto / 全局可信身份也不能替别的空间决定。
    if (spaces.roleOf(space.id, operator) !== 'owner') return denied('not_owner', '只有本空间负责人能决定提议')
    if (!policy) return denied('unavailable', '权限判定未就绪，暂不能处理提议')
    const gate = policy.decide({ spaceId: space.id, openId: operator, action: 'configure' })
    if (gate.decision !== 'allow') return denied('policy', gate.reason)
    const now = this.deps.now()
    if (r.status === 'expired') return { outcome: 'expired', changed: false, routine: r }
    if (r.status === 'ignored') {
      return input.decision === 'ignore' ? { outcome: 'already_ignored', changed: false, routine: r } : { outcome: 'conflict', changed: false, routine: r, current: 'ignored' }
    }
    if (r.status === 'active') {
      return input.decision === 'accept' ? { outcome: 'already_accepted', changed: false, routine: r } : { outcome: 'conflict', changed: false, routine: r, current: 'accepted' }
    }
    if (r.expiresAt !== null && r.expiresAt <= now) {
      // 调度器每分钟才扫一次；过了 72 小时的点击不能抢在作废之前接受。任何写入之前先核对租约。
      input.assertCurrent?.()
      const changed = routines.expireProposal(r.id, now)
      if (changed) inbox?.resolve('responsibility', r.id, now, { note: 'expired' })
      return { outcome: 'expired', changed, routine: routines.get(r.id) ?? r }
    }
    const version = routines.configVersion(r.id)!
    if (input.expectedConfigVersion !== version) return { outcome: 'stale_card', changed: false, routine: r, currentConfigVersion: version }
    input.assertCurrent?.()
    const decided = input.decision === 'accept' ? routines.accept(r.id, operator, now) : routines.ignore(r.id, operator, now)
    if (!decided) throw new RoutineControlError('这条提案已无法处理')
    inbox?.resolve('responsibility', r.id, now, { by: operator, note: input.decision === 'accept' ? 'accepted' : 'ignored' })
    // G9：提案接受后才真正生效；这时与别的职责产出重复的，同一事务里记一条待拍板给点接受的人。
    if (input.decision === 'accept') this.noteOverlaps(r.id, operator)
    return { outcome: input.decision === 'accept' ? 'accepted' : 'ignored', changed: true, routine: decided }
  }

  /**
   * 改职责。提案期间也可以改，但每次修改都产生新的 config_version，旧卡片因此不能再接受；
   * 同一事务里更新提案指针的标题。宿主据 proposalChanged 把卡片刷成新版本。
   */
  update(id: number, patch: Parameters<RoutineStore['update']>[1], options: { expectedConfigVersion?: number; actorOpenId?: string } = {}): { routine: Routine; changed: boolean; proposalChanged: boolean; overlaps: PendingItem[] } {
    const { routines, registry, inbox } = this.deps
    if (!routines) throw new RoutineControlError('这条职责已不存在')
    registry.db.exec('SAVEPOINT update_routine')
    try {
      const version = routines.configVersion(id)
      if (version === undefined) throw new RoutineControlError('这条职责已不存在')
      if (options.expectedConfigVersion !== undefined && options.expectedConfigVersion !== version) {
        throw new RoutineControlConflictError('这条职责已修改，请刷新后重试')
      }
      const routine = routines.update(id, patch, this.deps.now())
      if (!routine) throw new RoutineControlError('这条职责已不存在')
      const changed = routines.configVersion(id) !== version
      const proposalChanged = changed && routine.status === 'proposed'
      if (proposalChanged) inbox?.retitle('responsibility', id, proposalPointerTitle(routine))
      // G9：改完之后与别的职责产出重复的，在同一事务里登记待拍板；没改（原样返回）不重新问。
      const overlaps = changed ? this.noteOverlaps(id, options.actorOpenId) : []
      registry.db.exec('RELEASE SAVEPOINT update_routine')
      return { routine, changed, proposalChanged, overlaps }
    } catch (error) {
      registry.db.exec('ROLLBACK TO SAVEPOINT update_routine; RELEASE SAVEPOINT update_routine')
      throw error
    }
  }

  /** 到期没人理的提案作废，指针在同一事务里结清；返回作废后的行，宿主据此改卡。 */
  expireProposals(): Routine[] {
    const { routines, registry, inbox } = this.deps
    if (!routines) return []
    const now = this.deps.now()
    registry.db.exec('SAVEPOINT expire_routine_proposals')
    try {
      const stale = routines.expireProposals(now)
      for (const r of stale) inbox?.resolve('responsibility', r.id, now, { note: 'expired' })
      registry.db.exec('RELEASE SAVEPOINT expire_routine_proposals')
      return stale.map(r => routines.get(r.id) ?? r)
    } catch (error) {
      registry.db.exec('ROLLBACK TO SAVEPOINT expire_routine_proposals; RELEASE SAVEPOINT expire_routine_proposals')
      throw error
    }
  }

  /** 卡片 / 状态查询：待决定、已接受、已忽略、已作废和“卡片已过期”分开说。只读。 */
  proposalStatus(id: number, cardConfigVersion: number | undefined): ProposalStatus {
    const { routines } = this.deps
    const r = routines?.get(id), version = routines?.configVersion(id)
    if (!r || version === undefined) return { state: 'not_found' }
    if (r.source !== 'model') return { state: 'not_a_proposal' }
    if (r.status === 'active' || r.status === 'ignored') {
      return { state: r.status === 'active' ? 'accepted' : 'ignored', currentConfigVersion: version, decidedBy: r.decidedBy, decidedAt: r.decidedAt }
    }
    if (r.status === 'expired' || r.expiresAt !== null && r.expiresAt <= this.deps.now()) return { state: 'expired', currentConfigVersion: version }
    return { state: cardConfigVersion === version ? 'pending' : 'stale_card', currentConfigVersion: version, expiresAt: r.expiresAt }
  }

  /**
   * 指针跟着职责走：提案不再等决定（已删除 / 已决定 / 已作废），或关注职责不再等授权（已删除 / 已暂停 / 已恢复），
   * 就在调用方的事务里结清对应指针。已结清的不动，可重复调用。
   */
  /** 空间停用（pauseForSpace）之后在同一事务里调用：这个空间里的职责不再等授权或决定的，指针一起结清。 */
  settlePointersForSpace(spaceId: string, chatId: string): number {
    const ids = (this.deps.registry.db.prepare('SELECT id FROM routines WHERE space_id = ? OR (space_id IS NULL AND chat_id = ?)').all(spaceId, chatId) as { id: number }[])
      .map(row => Number(row.id))
    return this.settlePointers(ids)
  }

  settlePointers(ids: readonly number[], kinds: readonly ('responsibility' | 'auth')[] = ['responsibility', 'auth'], people: readonly string[] = []): number {
    const { routines, inbox } = this.deps
    if (!routines || !inbox) return 0
    const now = this.deps.now()
    let settled = 0
    const waiting = new Set(kinds.includes('auth') ? people : [])
    for (const id of ids) {
      const r = routines.get(id)
      if (kinds.includes('responsibility') && (!r || r.status !== 'proposed')) settled += Number(inbox.resolve('responsibility', id, now, { note: !r ? 'deleted' : r.status === 'active' ? 'accepted' : r.status }))
      if (kinds.includes('auth')) {
        if (r?.kind === 'watch' && r.runAs) waiting.add(r.runAs)
        const pointer = inbox.find('auth', id)
        if (pointer && pointer.resolvedAt === null) waiting.add(pointer.ownerOpenId)
      }
    }
    // 授权指针挂在触发的那一条上，但说的是这个人所有停下来等授权的关注：一条都不在等了才结清，而且结清这个人全部的授权指针。
    for (const openId of waiting) {
      if (this.waitsForAuthorization(openId)) continue
      for (const item of inbox.pending(openId)) {
        if (item.kind !== 'auth' || item.refId === null) continue
        // 只动关注职责的授权指针（或职责已删除的）；别的用途的授权指针不归这条规则管
        const ref = routines.get(item.refId)
        if (!ref || ref.kind === 'watch') settled += Number(inbox.resolve('auth', item.refId, now, { note: 'no_longer_waiting' }))
      }
    }
    return settled
  }

  private waitsForAuthorization(openId: string): boolean {
    return Boolean(this.deps.registry.db.prepare(`SELECT 1 FROM routines WHERE kind = 'watch' AND status = 'active' AND run_as = ? AND disabled_reason = ? LIMIT 1`)
      .get(openId, AUTH_EXPIRED))
  }

  // ---- G9：重叠的职责交给人决定 ----

  /** 只读：结清待拍板时要看两条职责现在的名字和状态。 */
  routine(id: number): Routine | undefined {
    return this.deps.routines?.get(id)
  }

  /** 一对职责的待拍板编号：与顺序无关，同一空间里同一对只登记一次。 */
  private overlapRef(spaceId: string | undefined, a: number, b: number): number {
    return decisionRef(spaceId, `routine-overlap:${Math.min(a, b)}:${Math.max(a, b)}`)
  }

  /**
   * 新建 / 修改 / 接受之后在调用方的事务里调用：与 id 这条产出重复的每一条（RoutineStore.overlaps），登记一条 Inbox 待决定
   * 「「A」和「B」产出重复，保留还是暂停其中一个？」。同一对按 decisionRef 只登记一次，登记过（不论结清与否）就不再问；
   * 不自动去重，人的决定走待拍板结清（保留两条 / 暂停 A / 暂停 B）。谁来定：这次操作的人，没有就是这条职责的负责人。
   */
  noteOverlaps(id: number, actorOpenId?: string): PendingItem[] {
    const { routines, inbox, registry, spaces } = this.deps
    if (!routines || !inbox) return []
    const a = routines.get(id)
    if (!a) return []
    const registered: PendingItem[] = []
    for (const overlap of routines.overlaps(id)) {
      const b = overlap.routine
      const spaceId = a.spaceId ?? spaces.byChat(a.chatId)?.id
      const ref = this.overlapRef(spaceId, a.id, b.id)
      if (inbox.find('decision', ref)) continue
      const owner = actorOpenId?.trim() || a.ownerOpenId || a.runAs || b.ownerOpenId || b.runAs
      if (!owner) continue
      const [first, second] = a.id < b.id ? [a, b] : [b, a]
      const item = inbox.add({ ownerOpenId: owner, kind: 'decision', refId: ref, spaceId,
        title: `「${first.name}」和「${second.name}」产出重复，保留还是暂停其中一个？`,
        why: `${describeOverlap(overlap)}，下次运行只差 ${Math.round(overlap.gapMs / 60_000)} 分钟。结清时写：保留两条 / 暂停 #${first.id} / 暂停 #${second.id}`,
        now: this.deps.now() })
      registry.setKv(`routine-overlap:${ref}`, JSON.stringify({ version: 1, a: first.id, b: second.id, spaceId: spaceId ?? null }))
      registered.push(item)
    }
    return registered
  }

  /** 结清时用：这条待决定是不是一对重叠职责的问题；是就给出两条的编号。 */
  overlapDecision(refId: number | null): { a: number; b: number; spaceId: string | null } | undefined {
    if (refId === null) return undefined
    const raw = this.deps.registry.getKv(`routine-overlap:${refId}`)
    if (!raw) return undefined
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; a?: unknown; b?: unknown; spaceId?: unknown }
      if (parsed.version !== 1 || !Number.isSafeInteger(parsed.a) || !Number.isSafeInteger(parsed.b)) return undefined
      return { a: Number(parsed.a), b: Number(parsed.b), spaceId: typeof parsed.spaceId === 'string' ? parsed.spaceId : null }
    } catch { return undefined }
  }

  /** 暂停 / 删除其中一条之后，这对职责的待决定按领域结清（已结清的不动）。返回结清的条数。 */
  private settleOverlapPointers(id: number, note: 'routine_paused' | 'routine_deleted'): number {
    const { inbox, registry } = this.deps
    if (!inbox) return 0
    const rows = registry.db.prepare("SELECT k, v FROM kv WHERE k LIKE 'routine-overlap:%'").all() as { k: string; v: string }[]
    let settled = 0
    for (const row of rows) {
      let parsed: { a?: unknown; b?: unknown }
      try { parsed = JSON.parse(row.v) as { a?: unknown; b?: unknown } } catch { continue }
      if (parsed.a !== id && parsed.b !== id) continue
      const ref = Number(row.k.slice('routine-overlap:'.length))
      if (Number.isSafeInteger(ref)) settled += Number(inbox.resolve('decision', ref, this.deps.now(), { note }))
    }
    return settled
  }

  control(id: number, action: RoutineControlAction, options: { resumeAt?: number } = {}): Routine | undefined {
    const result = this.persistControl(id, action, options)
    result.afterCommit()
    return result.routine
  }

  /** Callers compose this synchronous mutation with their own operation receipt transaction. */
  persistControl(id: number, action: RoutineControlAction, options: { expectedConfigVersion?: number; resumeAt?: number } = {}): PersistedRoutineControl {
    if (options.resumeAt !== undefined) {
      if (action !== 'pause') throw new RoutineControlError('只有暂停可以设置恢复时间')
      const now = this.deps.now()
      if (!Number.isSafeInteger(options.resumeAt) || options.resumeAt <= now || options.resumeAt > now + MAX_PAUSE_MS) {
        throw new RoutineControlError('恢复时间须晚于现在，且不超过 90 天')
      }
    }
    return this.persist(id, action, options.expectedConfigVersion, false, options.resumeAt)
  }

  /**
   * Manual pauses whose agreed time has come (“这周先停一下，下周一再恢复”). Each goes through the same
   * resume checks as a person's explicit resume. A failed check keeps the routine paused, clears the
   * agreed time so it is not retried every tick, and is returned for the host to tell the owner once.
   */
  resumeDue(): { resumed: Routine[]; stillPaused: { routine: Routine; reason: string; resumeAt: number }[] } {
    const { routines } = this.deps
    const resumed: Routine[] = [], stillPaused: { routine: Routine; reason: string; resumeAt: number }[] = []
    if (!routines) return { resumed, stillPaused }
    for (const id of routines.dueResumes(this.deps.now())) {
      // The agreed time is cleared below when the checks fail; keep it for the owner's notice.
      const agreed = routines.get(id)?.resumeAt ?? this.deps.now()
      try {
        const result = this.persist(id, 'resume', undefined, false)
        result.afterCommit()
        if (result.routine?.enabled) resumed.push(result.routine)
      } catch (error) {
        if (!(error instanceof RoutineControlError)) throw error
        const routine = routines.setResumeAt(id, null)
        if (routine) stillPaused.push({ routine, reason: error.message, resumeAt: agreed })
      }
    }
    return { resumed, stillPaused }
  }

  /** Legacy stop also accepts proposals and missing rows; keep that contract separate from control. */
  stop(id: number, mode: 'pause' | 'remove'): void {
    if (!this.deps.routines) throw new Error('这个部署没有开启定时任务')
    this.persist(id, mode === 'pause' ? 'pause' : 'delete', undefined, true).afterCommit()
  }

  private persist(id: number, action: RoutineControlAction, expectedConfigVersion: number | undefined, legacyStop: boolean, resumeAt?: number): PersistedRoutineControl {
    const { routines, registry, attempts, spaces, userTokens } = this.deps
    if (!routines) throw new RoutineControlError('这条职责已不存在')
    registry.db.exec('SAVEPOINT control_routine_runs')
    try {
      const before = routines.get(id)
      if (!legacyStop && !before) throw new RoutineControlError('这条职责已不存在')
      const version = routines.configVersion(id)
      if (expectedConfigVersion !== undefined && expectedConfigVersion !== version) {
        throw new RoutineControlConflictError('这条职责已修改，请刷新后重试')
      }
      if (!legacyStop && action !== 'delete' && before?.status !== 'active') {
        throw new RoutineControlError('这条职责尚未生效，请先接受提案')
      }
      // Capture handles now, never look up a later Run in afterCommit.
      const runs = action === 'resume' ? [] : this.deps.activeRuns(id).map(run => ({ runId: run.runId, abort: run.abort }))
      if (action === 'resume' && before) {
        const space = before.spaceId ? spaces.get(before.spaceId) : spaces.byChat(before.chatId)
        if (!space || space.status !== 'active' || space.chatId !== before.chatId || space.kind !== before.chatType) {
          throw new RoutineControlError('这条职责的空间已停用或换绑，请先恢复空间')
        }
        if (before.kind === 'watch' && before.runAs && userTokens && !userTokens.isConnected(before.runAs)) {
          throw new RoutineControlError('关注群聊的授权已到期，请先重新授权')
        }
        routines.resume(id, this.deps.now())
      } else if (action === 'delete') {
        routines.remove(id)
      } else if (before) {
        const outstanding = registry.db.prepare("SELECT 1 FROM routine_occurrences WHERE routine_id = ? AND status IN ('pending', 'running') LIMIT 1").get(id)
        // Claiming a once occurrence sets enabled=false before it starts; that is not a user pause.
        if (before.enabled || before.disabledReason !== '手动停用' || outstanding) routines.setEnabled(id, false, this.deps.now(), { resumeAt })
        else if (!legacyStop && before.resumeAt !== (resumeAt ?? null)) routines.setResumeAt(id, resumeAt ?? null)
      }
      let changed = routines.configVersion(id) !== version
      // 删除后读不到这条属于谁，用操作前的那一行
      this.settlePointers([id], undefined, before?.kind === 'watch' && before.runAs ? [before.runAs] : [])
      // A notice pointer for a routine stopped after repeated failures ends when the owner resumes or deletes it.
      if (action !== 'pause') this.deps.inbox?.resolve('other', id, this.deps.now())
      // G9：暂停或删除其中一条之后，“保留还是暂停其中一个”这个问题已经没有了，按领域结清。
      if (action !== 'resume') this.settleOverlapPointers(id, action === 'delete' ? 'routine_deleted' : 'routine_paused')
      for (const run of runs) if (attempts.requestStop(run.runId, `routine_${action === 'delete' ? 'remove' : 'pause'}`)) changed = true
      const result: PersistedRoutineControl = {
        routine: routines.get(id), changed, affectedRunIds: runs.map(run => run.runId),
        afterCommit: () => { for (const run of runs) run.abort.abort() },
      }
      registry.db.exec('RELEASE SAVEPOINT control_routine_runs')
      return result
    } catch (error) {
      registry.db.exec('ROLLBACK TO SAVEPOINT control_routine_runs; RELEASE SAVEPOINT control_routine_runs')
      throw error
    }
  }

  /** OAuth callback, pasted callback and card all use the same recovery operation. */
  async authorizationCompleted(openId: string): Promise<{ connected: boolean; resumed: number; stillPaused: number }> {
    const { userTokens, routines, spaces, registry, inbox } = this.deps
    const accessToken = await userTokens?.accessTokenFor(openId)
    if (!accessToken || userTokens?.get(openId)?.accessToken !== accessToken) return { connected: false, resumed: 0, stillPaused: 0 }
    const now = this.deps.now()
    let stillPaused = 0
    registry.db.exec('SAVEPOINT resume_authorized_routines')
    try {
      const resumed = routines?.resumeAfterAuth(openId, now, routine => {
        const space = routine.spaceId ? spaces.get(routine.spaceId) : spaces.byChat(routine.chatId)
        const granted = new Set((userTokens?.get(openId)?.scope ?? '').split(/[\s,]+/))
        const eligible = (routine.kind !== 'watch' || routine.chatType !== 'p2p' || USER_SCOPE_TIERS.watch.every(scope => granted.has(scope))) &&
          space?.status === 'active' && space.chatId === routine.chatId && space.kind === routine.chatType &&
          (space.kind !== 'p2p' || (space.id === dmSpaceId(openId) && routine.ownerOpenId === openId))
        if (!eligible) stillPaused++
        return eligible
      }) ?? []
      // 按人结清：权限仍不够（比如只给了基础权限）而还有关注在等授权时，指针保留
      this.settlePointers(resumed.map(routine => routine.id), ['auth'], [openId])
      registry.setKv(`authcard:${openId}`, '')
      registry.db.exec('RELEASE SAVEPOINT resume_authorized_routines')
      return { connected: true, resumed: resumed.length, stillPaused }
    } catch (error) {
      registry.db.exec('ROLLBACK TO SAVEPOINT resume_authorized_routines; RELEASE SAVEPOINT resume_authorized_routines')
      throw error
    }
  }
}
