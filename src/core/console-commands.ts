import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ConsoleActor } from './console-sessions.js'
import { ConsoleOperations, ConsoleOperationError, type ConsoleAppliedResult } from './console-operations.js'
import { DeliveryError } from './delivery.js'
import type { DeliveryReconciliation, ReconciliationObservation } from './delivery-reconciliation.js'
import type { HumanSpaceAccess } from './human-space-access.js'
import { spaceScope, type Spaces } from './space.js'
import type { RoutineApplication } from './routine-application.js'
import type { RoutineStore } from './routines.js'
import type { Todos } from './todos.js'
import { TodoApplication } from './todo-application.js'
import { SpaceApplication } from './space-application.js'
import type { HumanRunTarget, HumanRunStopResult, HumanWorkCancelResult, HumanWorkResumeResult, HumanWorkTarget } from './human-run-control.js'
import type { WorkPauseReason } from './work-contexts.js'
import { ModelSelectionError, type ModelApplication } from './model-selection.js'

const tag = z.string().regex(/^[a-f0-9]{64}$/)
const requestId = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const consoleCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('space.presentation'), requestId, expectedTag: tag,
    patch: z.object({ brevity: z.enum(['short', 'normal', 'detailed']).optional(), ack: z.enum(['react', 'none']).optional() }).strict() }).strict(),
  z.object({ operation: z.literal('space.model'), requestId, expectedTag: tag,
    generation: z.number().int().positive(), value: z.string().min(1).max(2000).nullable() }).strict(),
  z.object({ operation: z.enum(['routine.pause', 'routine.resume']), requestId, id, expectedConfigVersion: z.number().int().nonnegative() }).strict(),
  z.object({ operation: z.literal('run.stop'), requestId, runId: z.string().min(1).max(256), taskId: id }).strict(),
  z.object({ operation: z.literal('work.cancel'), requestId, workKey: z.string().regex(/^task:\d{1,16}$/), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ operation: z.literal('work.resume'), requestId, workKey: z.string().regex(/^task:\d{1,16}$/), expectedRevision: z.number().int().positive(),
    reason: z.enum(['manual', 'run_stop', 'authorization', 'space_disabled', 'config_invalid', 'executor_unavailable']), causeRef: z.string().min(1).max(200) }).strict(),
  z.object({ operation: z.literal('todo.update'), requestId, id, expectedTag: tag,
    patch: z.object({ title: z.string().optional(), detail: z.string().nullable().optional(), dueMs: z.number().nullable().optional(),
      status: z.enum(['open', 'blocked', 'review', 'done', 'cancelled']).optional(), statusNote: z.string().nullable().optional(), confirm: z.literal(true).optional() }).strict() }).strict(),
  z.object({ operation: z.literal('delivery.reconcile'), requestId, key: z.string().min(1).max(500) }).strict(),
])
export type ConsoleCommand = z.infer<typeof consoleCommandSchema>

/** HTTP is an adapter. Domain applications own writes; the receipt commits in the same transaction. */
export class ConsoleCommands {
  constructor(private readonly deps: {
    access: HumanSpaceAccess; operations: ConsoleOperations; spaces: Spaces; routines: RoutineStore; todos: Todos
    spaceApplication: SpaceApplication; todoApplication: TodoApplication
    models?: Pick<ModelApplication, 'select'>
    /** Read-only platform check of an original receipt; absent when the deployment has no platform reader. */
    reconciliation?: Pick<DeliveryReconciliation, 'observe' | 'commit'>
    persistRoutineControl: RoutineApplication['persistControl']
    assertHumanRunTarget(input: HumanRunTarget): void
    persistHumanRunStop(input: HumanRunTarget): HumanRunStopResult
    assertHumanWorkTarget(input: HumanWorkTarget): void
    persistHumanWorkCancel(input: HumanWorkTarget, opts: { expectedRevision: number }): HumanWorkCancelResult
    persistHumanWorkResume(input: HumanWorkTarget, opts: { reason: WorkPauseReason; causeRef: string; expectedRevision: number }): HumanWorkResumeResult
  }) {}

  async execute(actor: ConsoleActor, spaceId: string, raw: unknown) {
    const parsed = consoleCommandSchema.safeParse(raw)
    if (!parsed.success) throw new ConsoleOperationError(400, 'invalid_command', '操作内容无效，请刷新后重试。')
    const command = parsed.data
    const grant = await this.deps.access.authorize(actor, spaceId, { operation: 'read', allowArchived: true })
    const target = () => ({ scope: spaceScope(spaceId), chatId: grant.assertCurrent().chatId, chatType: grant.space.kind, openId: actor.openId })
    const runInput = command.operation === 'run.stop' ? { actorOpenId: actor.openId, spaceId,
      runId: command.runId, taskId: command.taskId, assertCurrent: grant.assertCurrent } : undefined
    const workInput = command.operation === 'work.cancel' || command.operation === 'work.resume'
      ? { actorOpenId: actor.openId, spaceId, workKey: command.workKey, assertCurrent: grant.assertCurrent } : undefined
    // The platform read happens before the receipt transaction; the commit is conditional on what was observed.
    // A replayed request returns its stored receipt, so the platform is not read again.
    const observation = command.operation === 'delivery.reconcile' && !this.deps.operations.recorded(actor, command.requestId)
      ? await this.observeDelivery(actor, spaceId, command.key, grant.assertCurrent) : undefined
    const resourceId = command.operation === 'space.presentation' || command.operation === 'space.model' ? spaceId : command.operation === 'run.stop' ? command.runId
      : command.operation === 'work.cancel' || command.operation === 'work.resume' ? command.workKey
      : command.operation === 'delivery.reconcile' ? createHash('sha256').update(command.key).digest('hex') : String(command.id)
    const { requestId: key, ...input } = command
    const assertTarget = () => {
      const space = grant.assertCurrent()
      if (command.operation === 'routine.pause' || command.operation === 'routine.resume') {
        const routine = this.deps.routines.get(command.id)
        if (!routine || routine.chatId !== space.chatId || routine.chatType !== space.kind ||
          routine.spaceId && routine.spaceId !== space.id || !this.deps.routines.canManage(routine, { chatId: space.chatId!, chatType: space.kind, openId: actor.openId })) {
          throw new ConsoleOperationError(404, 'resource_not_found', '当前空间未找到这条职责。')
        }
      } else if (command.operation === 'todo.update') {
        if (!this.deps.todos.getForAudience(command.id, target())) throw new ConsoleOperationError(404, 'resource_not_found', '当前空间未找到这条待办。')
      } else if (runInput) this.deps.assertHumanRunTarget(runInput)
      else if (workInput) this.deps.assertHumanWorkTarget(workInput)
    }
    const receipt = await this.deps.operations.execute({ actor, requestId: key, spaceId, operation: command.operation, resourceId, input }, {
      authorize: context => {
        if (context.spaceId !== spaceId || context.operation !== command.operation || context.resourceId !== resourceId) {
          throw new ConsoleOperationError(409, 'request_conflict', '同一请求标识已用于不同操作，请重新提交。')
        }
        assertTarget()
        if (context.mode === 'apply') {
          if (grant.assertCurrent().status !== 'active') throw new ConsoleOperationError(409, 'space_archived', '空间已停用。')
          if ((command.operation === 'space.presentation' || command.operation === 'space.model') && !grant.canConfigure()) {
            throw new ConsoleOperationError(403, 'configuration_forbidden', '当前账号不能修改空间设置。')
          }
        }
      },
      persist: () => {
        if (command.operation === 'delivery.reconcile') {
          const receipt = this.deps.reconciliation!.commit(observation!)
          return { appliedResult: { changed: receipt.status !== observation!.before.status || receipt.remoteId !== observation!.before.remoteId,
            state: receipt.status === 'confirmed' ? 'confirmed' : 'unresolved', result: receipt.result } }
        }
        if (command.operation === 'space.model') {
          if (!this.deps.models) throw new ConsoleOperationError(503, 'models_unavailable', '尚未启用模型选择。')
          try {
            const result = this.deps.models.select(spaceId, command)
            return { appliedResult: { changed: result.changed, state: 'updated', tag: result.tag } }
          } catch (error) {
            if (error instanceof ModelSelectionError) throw new ConsoleOperationError(error.status, error.code, error.message)
            throw error
          }
        }
        if (command.operation === 'space.presentation') {
          const result = this.deps.spaceApplication.configurePresentation(spaceId, command.patch, { actorOpenId: actor.openId, expectedTag: command.expectedTag })
          return { appliedResult: { changed: result.changed, state: 'updated', tag: result.tag } }
        }
        if (command.operation === 'todo.update') {
          const result = this.deps.todoApplication.update(command.id, target(), command, actor.openId)
          return { appliedResult: { changed: result.changed, state: 'updated', tag: result.tag } }
        }
        if (command.operation === 'routine.pause' || command.operation === 'routine.resume') {
          const result = this.deps.persistRoutineControl(command.id, command.operation === 'routine.pause' ? 'pause' : 'resume', { expectedConfigVersion: command.expectedConfigVersion })
          const routine = result.routine!
          const appliedResult: ConsoleAppliedResult = { changed: result.changed, state: routine.enabled ? 'enabled' : 'paused',
            version: this.deps.routines.configVersion(routine.id)!, enabled: routine.enabled, nextRunAt: routine.enabled ? routine.nextRunAt : null, affectedRunIds: result.affectedRunIds }
          return { appliedResult, afterCommit: result.afterCommit }
        }
        if (command.operation === 'work.resume') {
          const result = this.deps.persistHumanWorkResume(workInput!, { reason: command.reason, causeRef: command.causeRef, expectedRevision: command.expectedRevision })
          return { appliedResult: { changed: result.result === 'resumed', state: result.result, version: result.revision }, afterCommit: result.afterCommit }
        }
        if (command.operation === 'work.cancel') {
          const result = this.deps.persistHumanWorkCancel(workInput!, { expectedRevision: command.expectedRevision })
          return { appliedResult: { changed: result.result === 'cancelled', state: result.result, version: result.revision, affectedRunIds: result.affectedRunIds }, afterCommit: result.afterCommit }
        }
        const result = this.deps.persistHumanRunStop(runInput!)
        return { appliedResult: { changed: result.result === 'stop_requested', state: result.result, affectedRunIds: [result.runId] }, afterCommit: result.afterCommit }
      },
    })
    // afterCommit may await runtime cleanup. Never disclose its receipt after loss of access.
    assertTarget()
    return { body: receipt, assertCurrent: assertTarget }
  }

  /** The receipt must belong to the space being viewed; identity and platform checks are the reconciliation's own. */
  private async observeDelivery(actor: ConsoleActor, spaceId: string, key: string, assertGrant: () => unknown): Promise<ReconciliationObservation> {
    if (!this.deps.reconciliation) throw new ConsoleOperationError(503, 'reconciliation_unavailable', '这个部署不能核对发送结果。')
    try {
      return await this.deps.reconciliation.observe({ openId: actor.openId, assertCurrent: () => { assertGrant() } }, key, { expectedSpaceId: spaceId })
    } catch (error) {
      if (!(error instanceof DeliveryError)) throw error
      if (error.code === 'invalid') throw new ConsoleOperationError(404, 'resource_not_found', '当前空间未找到这条发送回执。')
      if (error.code === 'denied') throw new ConsoleOperationError(403, 'delivery_forbidden', '当前账号不能核对这条发送回执。')
      if (error.code === 'unknown') throw new ConsoleOperationError(409, 'delivery_in_progress', '这条发送可能仍在进行，暂不能核对。')
      throw new ConsoleOperationError(409, 'delivery_unconfirmed', '暂时无法核实成员身份或会话，请稍后重试。')
    }
  }
}
