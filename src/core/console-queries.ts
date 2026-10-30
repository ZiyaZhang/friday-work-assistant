import type { Registry } from './registry.js'
import type { ChannelMemory } from './memory.js'
import type { Todos } from './todos.js'
import { STATUS_LABEL, canTransition, type TodoStatus } from './todos.js'
import { AUTH_EXPIRED, FEEDBACK_STOPPED, ROUTINE_INTERRUPTED, describeSchedule, type Routine, type RoutineStore } from './routines.js'
import { routineProgress } from './routine-application.js'
import { spaceScope, type Space } from './space.js'
import type { ConsoleActor } from './console-sessions.js'
import type { HumanSpaceAccess } from './human-space-access.js'
import type { GitHubIdentity } from '../github/identity.js'
import type { GitHubProjectView } from '../github/project-view.js'
import type { SkillProposals } from './skills.js'
import { listDeliveryReceipts, type DeliveryAudience } from './delivery.js'
import { taskDeliveryContextRef } from './execution-keys.js'
import { presentationTag } from './space-application.js'
import { todoTag } from './todo-application.js'
import { ModelSelectionError, type ModelApplication } from './model-selection.js'
import type { RunModels } from './run-models.js'
import { parseRunResult, type RunAttempt } from './run-attempts.js'
import { projectWorkProgress } from './work-progress.js'
import type { TaskStatus } from './registry.js'
import { projectWorkAccessConditions, type WorkConnectionReader } from './work-access-waits.js'

export class ConsoleQueryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

const PAGE_SIZE = 100
export type ConsoleSection = 'overview' | 'memory' | 'tasks' | 'executions' | 'project'
export type ConsoleTodoStatus = 'active' | 'done' | 'cancelled'

/** Read models for authenticated people. No worker capability, model call, or business write. */
export class ConsoleQueries {
  constructor(private readonly deps: {
    access: HumanSpaceAccess; registry: Registry; memory: ChannelMemory; todos: Todos
    routines: RoutineStore; skills: SkillProposals; github?: GitHubIdentity; projects?: GitHubProjectView
    models?: Pick<ModelApplication, 'catalog'>; runModels?: Pick<RunModels, 'get'>
    userTokens?: WorkConnectionReader
    waitingRepositoryChecks?: (workKey: string) => boolean
    defaults: { brevity: string; reflect: boolean }
  }) {}

  async spaces(actor: ConsoleActor) {
    const spaces = await this.deps.access.list(actor)
    return { body: { items: spaces.map(entry => ({ ...spaceSummary(entry.assertCurrent()), role: entry.role })) },
      assertCurrent: () => { spaces.forEach(entry => entry.assertCurrent()) } }
  }

  async read(actor: ConsoleActor, spaceId: string, section: ConsoleSection, options?: { todoStatus: ConsoleTodoStatus }) {
    const grant = await this.deps.access.authorize(actor, spaceId, { operation: 'read', allowArchived: true })
    const space = grant.assertCurrent(), scope = spaceScope(space.id)
    const audience: DeliveryAudience = space.kind === 'group' ? { kind: 'group', spaceId: space.id, chatId: space.chatId! }
      : { kind: 'dm', spaceId: space.id, openId: actor.openId }
    let data: unknown
    let checkContent = () => {}
    switch (section) {
      case 'overview': {
        const canConfigure = space.status === 'active' && grant.canConfigure()
        let models: ({ status: 'available' } & Awaited<ReturnType<ModelApplication['catalog']>>) | { status: 'unavailable' | 'read_only'; message: string }
          = { status: 'unavailable', message: '尚未启用模型选择。' }
        const assertModelAccess = () => {
          if (grant.assertCurrent().status !== 'active' || !grant.canConfigure()) {
            throw new ConsoleQueryError(403, 'configuration_forbidden', '当前账号不能修改空间设置。')
          }
        }
        if (!canConfigure) models = { status: 'read_only', message: '当前空间不能在此修改模型；执行记录可查看每次选定的模型。' }
        else if (this.deps.models) {
          try {
            models = { status: 'available', ...await this.deps.models.catalog(spaceId, assertModelAccess) }
            checkContent = assertModelAccess
          }
          catch (error) {
            if (!(error instanceof ModelSelectionError)) throw error
            models = { status: 'unavailable', message: error.message }
          }
        }
        const current = grant.assertCurrent()
        data = { ...spaceSummary(current), role: grant.role, settingsTag: presentationTag(current), canConfigure: current.status === 'active' && grant.canConfigure(), models,
          settings: { brevity: current.config.brevity ?? this.deps.defaults.brevity,
            statusFeedback: current.config.ack === 'none' ? 'none' : 'reaction',
            reflect: current.config.reflect ?? this.deps.defaults.reflect },
          skills: this.deps.skills.listInstalled(space.id).map(name => {
            const binding = this.deps.skills.getBinding(space.id, name)!
            return { name, proposalId: binding.proposalId, revision: binding.revision, contentDigest: this.deps.skills.get(binding.proposalId)?.contentDigest }
          }) }
        break
      }
      case 'memory': {
        // C1's active provenance predicate is retained; no rawGet/admin bypass.
        const page = this.deps.memory.recentForAudience({ scope, chatId: space.chatId, chatType: space.kind, openId: actor.openId }, PAGE_SIZE)
        checkContent = () => {
          const current = this.deps.memory.recentForAudience({ scope, chatId: space.chatId, chatType: space.kind, openId: actor.openId }, PAGE_SIZE)
          if (page.items.some(note => !current.items.some(item => item.id === note.id && item.revision === note.revision))) {
            throw new ConsoleQueryError(409, 'memory_changed', '记忆已变化，请重新读取。')
          }
        }
        const items = page.items.map(note => ({ id: note.id, revision: note.revision,
          kind: note.kind, title: note.title, body: note.body, status: note.status, createdAt: note.createdAt,
          source: note.source ? { messageId: typeof note.source.messageId === 'string' ? note.source.messageId : null,
            chatId: typeof note.source.chatId === 'string' ? note.source.chatId : null } : null }))
        const total = page.total
        data = { items, total, truncated: total > items.length }
        break
      }
      case 'tasks': {
        const todoStatus = options?.todoStatus ?? 'active'
        const page = this.deps.todos.listForAudience({ scope, chatId: space.chatId, chatType: space.kind, openId: actor.openId }, { status: todoStatus, limit: PAGE_SIZE })
        const items = page.items.map(todo => ({ id: todo.id, tag: todoTag(todo), canEdit: space.status === 'active',
          transitions: (Object.keys(STATUS_LABEL) as TodoStatus[]).filter(status => canTransition(todo.status, status)),
          title: todo.title, detail: todo.detail, status: todo.status, statusLabel: STATUS_LABEL[todo.status],
          statusNote: todo.statusNote, confirmed: todo.confirmed, dueMs: todo.dueMs, owner: todo.owner,
          source: todo.source, origin: todo.origin, createdAt: todo.createdAt }))
        const total = page.total
        const routines = this.deps.routines.listFor({ chatId: space.chatId!, chatType: space.kind, ownerOpenId: actor.openId })
          .filter(r => r.chatType === space.kind && r.chatId === space.chatId &&
            (!r.spaceId || r.spaceId === space.id) && (space.kind !== 'p2p' || r.ownerOpenId === actor.openId))
          .map(r => {
            const progress = routineProgress(this.deps.routines, r, this.deps.registry.db, audience)
            return { id: r.id, configVersion: this.deps.routines.configVersion(r.id), name: r.name, enabled: r.enabled, status: r.status, disabledReason: routinePauseReason(r),
              canPause: space.status === 'active' && r.status === 'active' && (r.enabled || ['pending', 'running'].includes(progress.latest_occurrence?.status ?? '')),
              canResume: space.status === 'active' && r.status === 'active' && !r.enabled && progress.recovery === 'resume' && progress.can_resume_execution,
              timezoneOffsetMinutes: this.deps.routines.timezoneOffsetMinutes,
              schedule: describeSchedule(r.schedule, this.deps.routines.timezoneOffsetMinutes), stateLabel: routineStateLabel(r, progress, this.deps.routines),
              progress, nextStep: routineNextStep(progress) }
          })
        data = { items, total, truncated: total > items.length, todoStatus, routines }
        break
      }
      case 'executions': {
        // Only authored request text and persisted status are displayed, never runtime transcripts or paths.
        const rows = this.deps.registry.db.prepare(`SELECT t.id,t.prompt,t.status,t.stop_reason,t.created_at,t.started_at,t.finished_at,t.session_key,t.requester_open_id
          FROM tasks t JOIN sessions s ON s.session_key=t.session_key WHERE s.chat_id=? AND s.chat_type=?
          AND (?='group' OR (s.requester_open_id=? AND t.requester_open_id=?)) ORDER BY t.id DESC LIMIT ?`)
          .all(space.chatId, space.kind, space.kind, actor.openId, actor.openId, PAGE_SIZE + 1)
        const items = rows.slice(0, PAGE_SIZE).map(row => {
          const runRows = this.deps.registry.db.prepare(`SELECT id,state,stage,stop_reason,result_json,started_at,finished_at,actor_open_id
            FROM run_attempts WHERE task_id=? AND session_key=? ORDER BY started_at,rowid`).all(row.id!, row.session_key!) as {
              id: string; state: RunAttempt['state']; stage: RunAttempt['stage']; stop_reason: string | null; result_json: string | null;
              started_at: number; finished_at: number | null; actor_open_id: string | null;
            }[]
          const runs = runRows.map(({ actor_open_id, result_json, ...run }) => {
              const recorded = this.deps.runModels?.get(String(run.id))
              const model = recorded ? { providerId: recorded.providerId, modelId: recorded.modelId, accountRef: recorded.accountRef,
                admittedAt: recorded.admittedAt, contextUsed: recorded.contextUsed, contextSize: recorded.contextSize, usageStatus: recorded.usageStatus } : null
              return { ...run, result: parseRunResult(result_json), model, canStop: space.status === 'active' && run.state === 'running' && run.stage === 'task' &&
                row.requester_open_id === actor.openId && actor_open_id === actor.openId }
            })
          const context = taskDeliveryContextRef(Number(row.id), String(row.session_key))
          const deliveries = listDeliveryReceipts(this.deps.registry.db,
            [context, `${context}:notice`, `${context}:tool:here`, `${context}:tool:dm`], audience)
            .map(({ delivery_key, status, remote_id, reconciliation }) => ({ key: delivery_key, status, remote_id,
              canReconcile: status === 'sent' || status === 'unknown', reconciliation }))
          // Delegation facts are derived at read time; a stopped or paused work is shown as such, not inferred from Task rows.
          const workKey = this.deps.registry.taskWork.get(Number(row.id))?.key
          const view = workKey ? this.deps.registry.workContexts.view(workKey) : undefined
          const accessConditions = workKey ? projectWorkAccessConditions(this.deps.registry.db, workKey, this.deps.userTokens) : []
          const controls = space.status === 'active' && view?.lifecycle === 'open' && view.authorityOpenId === actor.openId
          const work = view ? { key: view.workKey, lifecycle: view.lifecycle, activity: view.activity, revision: view.revision, canCancel: controls,
            pauseReasons: view.pauseReasons.map(pause => pause.reason),
            pauses: view.pauseReasons.map(pause => ({ reason: pause.reason, causeRef: pause.causeRef,
              ...(pause.reason === 'authorization' && accessConditions.some(condition => condition.causeRef === pause.causeRef && condition.satisfied)
                ? { label: '授权已完成，等待恢复检查' } : {}),
              canResume: controls && !accessConditions.some(condition => condition.causeRef === pause.causeRef) })),
            pendingInputs: view.pending.inputs, openQuestions: view.pending.questions, unknownDeliveries: view.pending.unknownDeliveries } : null
          const latest = runs.filter(run => run.stage !== 'reflect').at(-1)
          const progress = projectWorkProgress({ task: { status: row.status as TaskStatus, stopReason: row.stop_reason as string | null }, work: view,
            waitingRepositoryChecks: workKey ? this.deps.waitingRepositoryChecks?.(workKey) : false,
            accessConditions,
            run: latest ? { state: latest.state as RunAttempt['state'], stopReason: latest.stop_reason as string | null, result: latest.result } : null,
            deliveries: deliveries.map(delivery => ({ status: delivery.status, remoteId: delivery.remote_id })) })
          return { id: row.id, request: row.prompt, status: row.status, stopReason: row.stop_reason,
            createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, runs, deliveries, work, progress }
        })
        data = { items, truncated: rows.length > PAGE_SIZE }
        break
      }
      case 'project': {
        if (!this.deps.github || !this.deps.projects) throw new ConsoleQueryError(503, 'github_unavailable', '尚未连接 GitHub。')
        const repos = (space.config.projectRepos ?? []).filter(repo => this.deps.github!.repoAllowed(repo))
        checkContent = () => {
          const current = grant.assertCurrent()
          if (repos.some(repo => !current.config.projectRepos?.includes(repo) || !this.deps.github!.repoAllowed(repo))) {
            throw new ConsoleQueryError(403, 'project_access_changed', '项目授权已变化，请刷新后重试。')
          }
        }
        data = { ...this.deps.projects.view(repos), configured: repos.length > 0 }
        break
      }
    }
    grant.assertCurrent()
    return { body: { space: spaceSummary(space), section, data },
      assertCurrent: () => { grant.assertCurrent(); checkContent() } }
  }
}

function spaceSummary(space: Space) {
  return { id: space.id, kind: space.kind, title: space.kind === 'p2p' ? '我的私聊' : space.title || '未命名群空间', status: space.status }
}

function routineNextStep(progress: ReturnType<typeof routineProgress>): string | null {
  if (progress.managed_delivery.items.some(item => item.status === 'planned' || item.status === 'unknown') || progress.recovery === 'inspect_previous_run') {
    return '上次结果待核对，暂不重新执行。'
  }
  switch (progress.recovery) {
    case 'reauthorize': return '重新授权后继续。'
    case 'restore_space': return '先恢复这个空间。'
    case 'wait': return progress.latest_occurrence?.status === 'pending' ? '等待开始。' : '正在执行。'
    case 'resume': return '可告诉 Friday 恢复这条职责。'
    case 'resolve_proposal': return '提案还未接受。'
    case 'feedback_stopped': return '原反馈已停止跟进。'
    case 'inspect_feedback': return '请先查看原反馈的状态。'
    default: return null
  }
}

function routineStateLabel(routine: Routine, progress: ReturnType<typeof routineProgress>, store: RoutineStore): string {
  if (routine.status !== 'active') return ({ proposed: '待接受', ignored: '已忽略', expired: '提案已过期' })[routine.status]
  if (progress.latest_occurrence?.status === 'pending') return '等待开始'
  if (progress.latest_occurrence?.status === 'running') return '执行中'
  if (routine.enabled) return '已启用'
  if (store.resumeState(routine.id)?.kind === 'completed') return routine.lastStatus === 'failed' ? '执行失败' : '本次已执行'
  return '已暂停'
}

/** Older stop reasons can include raw platform errors. Only known user-facing reasons leave the host. */
function routinePauseReason(routine: Routine): string | null {
  const reason = routine.disabledReason
  if (!reason) return null
  const known: Record<string, string> = { [AUTH_EXPIRED]: '授权到期', [FEEDBACK_STOPPED]: '原反馈已停止跟进',
    [ROUTINE_INTERRUPTED]: '上次执行中断，结果待核对', '手动停用': '手动暂停', '空间已停用': '空间已停用',
    '一次性任务待执行': '本次任务已领取', '一次性任务已执行': '本次任务已执行', '一次性任务执行失败': '本次执行失败',
    '提案被忽略': '提案已忽略', '提案 72 小时没人处理，已作废': '提案已过期' }
  return known[reason] ?? (routine.failCount > 0 ? '执行失败后暂停' : '已暂停')
}
