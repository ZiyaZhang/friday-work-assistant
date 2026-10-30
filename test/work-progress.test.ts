import { describe, expect, it } from 'vitest'
import { projectWorkProgress, type WorkProgressInput } from '../src/core/work-progress.js'
import type { RunResult } from '../src/core/run-attempts.js'

const handled: RunResult = { version: 1, termination: 'end_turn', outcome: 'handled', reason: 'normal_end' }
const normal = (): WorkProgressInput => ({ task: { status: 'done', stopReason: 'end_turn' },
  run: { state: 'completed', stopReason: 'end_turn', result: handled },
  work: { lifecycle: 'open', activity: 'idle', pauseReasons: [], pending: { inputs: 0, questions: 0, unknownDeliveries: 0 } },
  deliveries: [{ status: 'sent', remoteId: 'real-message-ack' }] })

describe('one factual work progress projection for all human surfaces', () => {
  it('keeps a delivered Draft PR waiting for its durable CI continuation without a DONE reaction', () => {
    const input = { ...normal(), waitingRepositoryChecks: true }
    expect(projectWorkProgress(input)).toMatchObject({ state: 'waiting_checks', nextAction: 'wait', reaction: 'waiting' })
    input.work!.lifecycle = 'cancelled'
    expect(projectWorkProgress(input)).toMatchObject({ state: 'stopped', reaction: null })
    input.work!.lifecycle = 'open'; input.work!.pauseReasons = [{ reason: 'manual', causeRef: 'user' }]
    expect(projectWorkProgress(input)).toMatchObject({ state: 'paused', reaction: null })
  })
  it('distinguishes handled input and acknowledged reply from completed domain work', () => {
    expect(projectWorkProgress(normal())).toMatchObject({ state: 'handled', label: '本次回复已送达', reaction: 'done' })
    const input = normal()
    input.work!.lifecycle = 'completed'
    expect(projectWorkProgress(input)).toMatchObject({ state: 'completed', label: '工作已完成' })
    expect(normal().work!.lifecycle).toBe('open')
  })

  it('does not fabricate delivery confirmation from successful model termination', () => {
    const input = normal()
    delete input.deliveries
    expect(projectWorkProgress(input)).toMatchObject({ state: 'handled', label: '本次处理已结束', reaction: null })
    input.deliveries = [{ status: 'sent' }]
    expect(projectWorkProgress(input)).toMatchObject({ state: 'needs_attention', reaction: null, nextAction: 'reconcile' })
  })

  it.each(['model_limit', 'step_budget', 'delivery_partial'] as const)('keeps %s visibly partial after a normal summary turn', reason => {
    const input = normal()
    input.run!.result = { version: 1, termination: reason === 'model_limit' ? 'max_tokens' : 'cancelled', outcome: 'partial', reason }
    expect(projectWorkProgress(input)).toMatchObject({ state: 'partial', reaction: 'partial', nextAction: 'continue' })
  })

  it('uses an open persisted question instead of Task.done after asking for information', () => {
    const input = normal()
    input.work!.pending.questions = 1
    expect(projectWorkProgress(input)).toMatchObject({ state: 'waiting_user', label: '等待补充', nextAction: 'provide_information', reaction: 'waiting' })
  })

  it.each(['planned', 'unknown'] as const)('does not claim waiting-for-reply when the question delivery is %s', status => {
    const input = normal()
    input.work!.pending.questions = 1
    input.deliveries = [{ status }]
    expect(projectWorkProgress(input)).toMatchObject({ state: 'needs_attention', nextAction: 'reconcile', reaction: null })
  })

  it('includes unresolved old deliveries or business writes across the whole work', () => {
    const input = normal()
    input.work!.pending.unknownDeliveries = 1
    expect(projectWorkProgress(input).state).toBe('needs_attention')
    input.work!.pending.unknownDeliveries = 0
    input.unresolvedEffects = 1
    expect(projectWorkProgress(input).state).toBe('needs_attention')
  })

  it('does not make an optional notification failure erase an acknowledged primary result', () => {
    const input = normal()
    input.deliveries = [...input.deliveries!, { status: 'unknown', required: false }]
    expect(projectWorkProgress(input)).toMatchObject({ state: 'handled', reaction: 'done' })
  })

  it.each(['authorization', 'permission', 'information'] as const)('reads current %s conditions independently of terminal Run state', kind => {
    const input = normal()
    input.waiting = [{ kind, causeRef: 'stored-condition' }]
    expect(projectWorkProgress(input)).toMatchObject({ state: kind === 'authorization' ? 'waiting_authorization' : 'waiting_user', reaction: 'waiting' })
    input.waiting = []
    expect(projectWorkProgress(input).state).toBe('handled')
  })

  it('keeps waiting authorization independent from missing resource ACL and connection failures', () => {
    const input = normal()
    input.run!.state = 'failed'
    input.task!.status = 'failed'
    input.run!.result = { version: 1, termination: 'error', outcome: 'failed', reason: 'access_denied' }
    expect(projectWorkProgress(input)).toMatchObject({ state: 'failed', label: '资料不可访问', nextAction: 'request_access' })
    input.run!.result.reason = 'network_error'
    expect(projectWorkProgress(input)).toMatchObject({ state: 'failed', label: '连接失败', nextAction: 'retry' })
    input.waiting = [{ kind: 'authorization', causeRef: 'real-grant-condition' }]
    expect(projectWorkProgress(input)).toMatchObject({ state: 'waiting_authorization', nextAction: 'connect' })
  })

  it('shows a persisted authorization pause and does not lose independent manual pauses', () => {
    const input = normal()
    input.work!.pauseReasons = [{ reason: 'manual', causeRef: 'human' }, { reason: 'authorization', causeRef: 'grant' }]
    expect(projectWorkProgress(input).state).toBe('waiting_authorization')
    input.work!.pauseReasons = [{ reason: 'manual', causeRef: 'human' }]
    expect(projectWorkProgress(input)).toMatchObject({ state: 'paused', nextAction: 'resume', reaction: null })
  })

  it('keeps explicit cancellation above stale waiting and completed result evidence', () => {
    const input = normal()
    input.work!.lifecycle = 'cancelled'
    input.waiting = [{ kind: 'information', causeRef: 'old-question' }]
    expect(projectWorkProgress(input)).toMatchObject({ state: 'stopped', reaction: null, nextAction: 'none' })
  })

  it('does not ask again for stale information after the user explicitly stopped its attempt', () => {
    const input = normal()
    input.run = { state: 'cancelled', stopReason: 'user_requested', result: { version: 1, termination: 'cancelled', outcome: 'cancelled', reason: 'user_requested' } }
    input.task = { status: 'cancelled', stopReason: 'user_requested' }
    input.work!.pending.questions = 1
    expect(projectWorkProgress(input)).toMatchObject({ state: 'stopped', reaction: null, nextAction: 'none' })
  })

  it('distinguishes a grant-change abort from a human stop and retains a path to continue', () => {
    const input = normal()
    input.run = { state: 'cancelled', stopReason: 'access_changed', result: { version: 1, termination: 'cancelled', outcome: 'cancelled', reason: 'access_changed' } }
    input.task = { status: 'cancelled', stopReason: 'access_changed' }
    expect(projectWorkProgress(input)).toMatchObject({ state: 'interrupted', label: '资料权限已变化', nextAction: 'continue', reaction: null })
  })

  it('shows real running, queued and permission wait phases without writing lifecycle state', () => {
    const input = normal()
    input.run!.state = 'running'
    input.run!.result = null
    input.task!.status = 'running'
    expect(projectWorkProgress(input)).toMatchObject({ state: 'running', reaction: 'working' })
    input.runtimePhase = 'queued'
    expect(projectWorkProgress(input)).toMatchObject({ state: 'queued', reaction: 'queued' })
    input.runtimePhase = 'waiting_permission'
    expect(projectWorkProgress(input)).toMatchObject({ state: 'waiting_user', nextAction: 'confirm_permission', reaction: 'waiting' })
    input.run!.state = 'stop_requested'
    expect(projectWorkProgress(input)).toMatchObject({ state: 'stopping', reaction: null })
    expect(input.work!.lifecycle).toBe('open')
  })

  it('separates a never-started queue from an interrupted admitted attempt after restart', () => {
    const input = normal()
    input.task = { status: 'queued', stopReason: null }
    input.run = null
    expect(projectWorkProgress(input).state).toBe('queued')
    input.task = { status: 'failed', stopReason: null }
    input.run = { state: 'interrupted', stopReason: 'gateway_restarted', result: null }
    expect(projectWorkProgress(input)).toMatchObject({ state: 'interrupted', reaction: null, nextAction: 'continue' })
  })

  it('does not infer completion for old done rows without new result evidence', () => {
    const input = normal()
    input.run!.result = null
    expect(projectWorkProgress(input)).toMatchObject({ state: 'unknown', reaction: null, nextAction: 'continue' })
    input.run = null
    expect(projectWorkProgress(input).state).toBe('unknown')
  })

  it('does not hide accepted but unhandled supplements behind the preceding successful result', () => {
    const input = normal()
    input.work!.pending.inputs = 1
    expect(projectWorkProgress(input)).toMatchObject({ state: 'received', reaction: null, nextAction: 'wait' })
  })

  it.each(['effect_unresolved', 'effect_unverifiable', 'coverage_missing'] as const)('shows the actual recovery blocker after a grant satisfies authorization: %s', reason => {
    const input = normal()
    input.work!.pauseReasons = [{ reason: 'authorization', causeRef: 'read-condition' }]
    input.accessConditions = [{ causeRef: 'read-condition', satisfied: true, recovery: { allowed: false, reasons: [reason] } }]
    const progress = projectWorkProgress(input)
    expect(progress).toMatchObject({ state: 'needs_attention', nextAction: 'reconcile', reaction: null })
    expect(progress.detail).toContain('所需授权已完成')
    input.accessConditions = [{ causeRef: 'read-condition', satisfied: false }]
    expect(projectWorkProgress(input)).toMatchObject({ state: 'waiting_authorization', nextAction: 'connect' })
  })

  it('keeps a real manual pause after authorization, without asking to connect again', () => {
    const input = normal()
    input.work!.pauseReasons = [{ reason: 'authorization', causeRef: 'read-condition' }, { reason: 'manual', causeRef: 'human' }]
    input.accessConditions = [{ causeRef: 'read-condition', satisfied: true, recovery: { allowed: true, reasons: [] } }]
    expect(projectWorkProgress(input)).toMatchObject({ state: 'paused', nextAction: 'resume' })
    input.work!.pauseReasons.pop()
    expect(projectWorkProgress(input)).toMatchObject({ state: 'queued', nextAction: 'wait' })
  })

  it('does not present a missing durable mutation result as a new authorization requirement', () => {
    const input = normal()
    input.run!.result = { version: 1, termination: 'host_cancelled', outcome: 'failed', reason: 'recovery_context_missing' }
    expect(projectWorkProgress(input)).toMatchObject({ state: 'needs_attention', nextAction: 'reconcile' })
  })
})
