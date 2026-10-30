import type { TaskRow } from './registry.js'
import type { RunAttempt, RunResult } from './run-attempts.js'
import type { WorkView } from './work-contexts.js'
import type { DeliveryStatus } from './delivery.js'
import type { WorkAccessCondition } from './work-access-waits.js'

export type WorkProgressState = 'received' | 'queued' | 'running' | 'stopping' | 'stopped' | 'paused' | 'waiting_user'
  | 'waiting_authorization' | 'waiting_checks' | 'needs_attention' | 'partial' | 'failed' | 'interrupted' | 'handled' | 'completed' | 'unknown'
export interface WorkProgress {
  state: WorkProgressState
  label: string
  detail: string
  nextAction: 'none' | 'wait' | 'provide_information' | 'connect' | 'confirm_permission' | 'request_access' | 'resume' | 'reconcile' | 'continue' | 'retry'
  reaction: 'queued' | 'working' | 'waiting' | 'done' | 'partial' | 'failed' | null
}
export interface WorkProgressInput {
  task?: Pick<TaskRow, 'status' | 'stopReason'> | null
  /** The relevant attempt, not an unrelated reflection or a different work's latest Session turn. */
  run?: Pick<RunAttempt, 'state' | 'stopReason' | 'result'> | null
  work?: Pick<WorkView, 'lifecycle' | 'activity' | 'pauseReasons' | 'pending'> | null
  /** Live executor state; persisted conditions below remain authoritative after this process restarts. */
  runtimePhase?: 'queued' | 'working' | 'waiting_permission'
  /** Current conditions read from their owner stores. Do not infer these from model text. */
  waiting?: readonly { kind: 'authorization' | 'permission' | 'information'; causeRef: string }[]
  /** Required primary deliveries for this result. Exclude optional notifications and receipts for older results. */
  deliveries?: readonly { status: DeliveryStatus; remoteId?: string | null; required?: boolean }[]
  /** Unresolved business writes (Issue/PR/artifact etc.), in addition to the Delivery ledger. */
  unresolvedEffects?: number
  /** Current grant and recovery facts for each persisted authorization admission pause. */
  accessConditions?: readonly WorkAccessCondition[]
  /** A confirmed publication with a durable CI continuation; no running model is needed while waiting. */
  waitingRepositoryChecks?: boolean
}

/** One read model for chat, cards, reactions and console; it writes no parallel lifecycle. */
export function projectWorkProgress(input: WorkProgressInput): WorkProgress {
  const { task, run, work } = input
  const result = run?.result
  const show = (state: WorkProgressState, label: string, detail: string, nextAction: WorkProgress['nextAction'], reaction: WorkProgress['reaction']): WorkProgress =>
    ({ state, label, detail, nextAction, reaction })
  const stopped = () => show('stopped', '已停止', '不会自动继续这项工作。', 'none', null)
  if (work?.lifecycle === 'cancelled') return stopped()
  if (run?.state === 'stop_requested' || work?.activity === 'stopping' || (task?.status === 'running' && task.stopReason === 'user_requested')) {
    return show('stopping', '正在停止', '已收到停止请求，正在收尾。', 'wait', null)
  }
  const active = run?.state === 'running' || work?.activity === 'running' || task?.status === 'running'
  if (active) {
    if (input.runtimePhase === 'waiting_permission') return show('waiting_user', '等待确认', '确认后才能继续当前操作。', 'confirm_permission', 'waiting')
    if (input.runtimePhase === 'queued') return show('queued', '排队中', '轮到这项请求时会开始处理。', 'wait', 'queued')
    return show('running', '执行中', '正在处理这项请求。', 'wait', 'working')
  }
  if ((run?.state === 'cancelled' && run.stopReason === 'user_requested') || (task?.status === 'cancelled' && task.stopReason === 'user_requested')) return stopped()
  if (work?.pauseReasons.length) {
    const access = work.pauseReasons.filter(pause => pause.reason === 'authorization').map(pause =>
      input.accessConditions?.find(condition => condition.causeRef === pause.causeRef))
    if (access.some(condition => !condition?.satisfied)) return show('waiting_authorization', '等待授权', '连接所需账号后可继续原请求。', 'connect', 'waiting')
    if (work.pauseReasons.some(pause => pause.reason !== 'authorization')) return show('paused', '已暂停', '解除对应暂停原因后，可继续剩余工作。', 'resume', null)
    const blocked = access.flatMap(condition => condition?.recovery?.allowed === false ? condition.recovery.reasons : [])
    if (blocked.some(reason => reason === 'effect_unresolved' || reason === 'effect_unverifiable')) return show('needs_attention', '结果待核对',
      '所需授权已完成，但此前操作或发送的结果尚未核对，暂不重复执行。请先核对已有结果，再继续原请求。', 'reconcile', null)
    if (blocked.some(reason => reason === 'coverage_missing' || reason === 'coverage_invalid' || reason === 'ledger_missing')) return show('needs_attention', '执行记录待核对',
      '所需授权已完成，但原执行记录不足以确认哪些操作已完成。请先核对已有结果，再继续原请求。', 'reconcile', null)
    if (blocked.some(reason => reason !== 'attempt_not_terminal')) return show('needs_attention', '原请求状态已变化',
      '所需授权已完成，但原请求的状态已变化。请查看后续补充或当前工作状态后继续。', 'continue', null)
    return show('queued', '等待恢复', '所需授权已完成，原请求正在等待恢复检查。', 'wait', 'queued')
  }
  if (result?.reason === 'recovery_context_missing') return show('needs_attention', '执行记录待核对',
    '原执行没有足够记录确认哪些操作已完成，暂不重复执行。请先核对已有结果，再继续原请求。', 'reconcile', null)
  if (task?.status === 'queued' || work?.activity === 'queued') return show('queued', '排队中', '请求已保存，等待开始处理。', 'wait', 'queued')
  const deliveries = input.deliveries?.filter(delivery => delivery.required !== false) ?? []
  if ((input.unresolvedEffects ?? 0) > 0 || (work?.pending.unknownDeliveries ?? 0) > 0
    || deliveries.some(delivery => delivery.status === 'planned' || delivery.status === 'unknown'
      || ((delivery.status === 'sent' || delivery.status === 'confirmed') && !delivery.remoteId))) {
    return show('needs_attention', '结果待核对', '有操作或消息的结果尚未确认，核对后再决定如何继续。', 'reconcile', null)
  }
  if (input.waiting?.some(condition => condition.kind === 'authorization')) return show('waiting_authorization', '等待授权', '连接所需账号后可继续原请求。', 'connect', 'waiting')
  if (input.waiting?.some(condition => condition.kind === 'permission')) return show('waiting_user', '等待确认', '确认后才能继续当前操作。', 'confirm_permission', 'waiting')
  if ((work?.pending.questions ?? 0) > 0 || input.waiting?.some(condition => condition.kind === 'information')) {
    return show('waiting_user', '等待补充', '已发出提问，等待答复；不依赖该信息的工作仍可继续。', 'provide_information', 'waiting')
  }
  if (result?.reason === 'access_changed' || run?.stopReason === 'access_changed' || task?.stopReason === 'access_changed') {
    return show('interrupted', '资料权限已变化', '处理期间资料权限发生变化，需要重新核验后继续原请求。', 'continue', null)
  }
  if (input.waitingRepositoryChecks && work?.lifecycle === 'open') return show('waiting_checks', '等待仓库检查',
    'PR 已提交，检查结束后会继续原任务；当前还不能确认修改完成。', 'wait', 'waiting')
  if (run?.state === 'cancelled' || result?.outcome === 'cancelled' || task?.status === 'cancelled') return stopped()
  if (run?.state === 'interrupted' || result?.outcome === 'interrupted' || task?.stopReason === 'gateway_restarted') {
    return show('interrupted', '执行中断', '执行因重启而中断；可以核对已有结果后继续。', 'continue', null)
  }
  if (result?.outcome === 'partial') {
    return show('partial', '尚未完成', partialDetail(result), 'continue', 'partial')
  }
  if (run?.state === 'failed' || result?.outcome === 'failed' || task?.status === 'failed') {
    if (result?.reason === 'access_denied') return show('failed', '资料不可访问', '当前身份没有这份资料的访问权，请资料负责人授予权限后继续。', 'request_access', 'failed')
    if (result?.reason === 'authorization_required') return show('failed', '此前处理未完成', '此前处理缺少所需授权；满足对应条件后可继续原请求。', 'continue', 'failed')
    if (result?.reason === 'network_error') return show('failed', '连接失败', '服务连接失败，本次处理未完成，可以稍后重试。', 'retry', 'failed')
    return show('failed', '处理失败', result?.reason === 'empty_result' ? '这次没有形成可交付结果，可以继续处理。' : '本次处理未完成，可以继续排查。', 'continue', 'failed')
  }
  if ((work?.pending.inputs ?? 0) > 0) return show('received', '已收到', '补充已保存，尚未处理。', 'wait', null)
  if (work?.lifecycle === 'completed') return show('completed', '工作已完成', '这项工作的完成状态已经确认。', 'none', 'done')
  const acknowledged = deliveries.length > 0 && deliveries.every(delivery =>
    (delivery.status === 'sent' || delivery.status === 'confirmed') && Boolean(delivery.remoteId))
  if (result?.outcome === 'handled') {
    return show('handled', acknowledged ? '本次回复已送达' : '本次处理已结束',
      acknowledged ? '这次请求的回复已交付。' : '执行已结束，尚未确认回复的交付结果。', 'none', acknowledged ? 'done' : null)
  }
  if (task?.status === 'done' || run?.state === 'completed') {
    return show('unknown', '已有处理记录', '旧执行没有完整结果记录，不能据此确认工作已完成。', 'continue', null)
  }
  return show('received', '已收到', '请求已保存。', 'wait', null)
}

function partialDetail(result: RunResult): string {
  if (result.reason === 'step_budget') return '这轮只完成了一部分，已查实的内容保留，可以继续剩余工作。'
  if (result.reason === 'model_limit') return '这轮输出被截断，已有内容不是完整结果，可以继续剩余工作。'
  if (result.reason === 'delivery_partial') return '部分内容已交付，仍有内容没有完成交付。'
  return '已有部分结果，剩余工作尚未完成。'
}
