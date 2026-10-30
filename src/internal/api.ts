import { createPersonalMcpRoutes } from './personal-mcp-routes.js'
import type { PersonalMcpConnections } from '../personal/mcp-connections.js'
import { createGmailRoutes } from './gmail-routes.js'
import type { GmailConnections } from '../gmail/connection.js'
import type { GmailMailbox } from '../gmail/mailbox.js'
import type { EmailDrafts, EmailDraft, EmailDraftSource } from '../gmail/drafts.js'
import { followupTitle } from '../core/person-text.js'
import { personalGitHubLane } from '../github/personal-lane.js'
import type { GitHubUserConnections } from '../github/user-connection.js'
import type { ChangePreparationOperations, PreparationQuery } from '../github/preparation-operations.js'
import { readPullRequestChecks } from '../github/pr-checks.js'
import { PullRequestCheckEvidenceError, readPullRequestCheckEvidence } from '../github/pr-check-evidence.js'
import { createGitHubCiRoutes } from './github-ci-routes.js'
import { createGitHubIssueFollowupRoutes } from './github-issue-followup-routes.js'
import { createIssueAssessmentRoutes } from './issue-assessment-routes.js'
import type { IssueAssessmentRuntime } from '../core/issue-assessment-runtime.js'
import { createRepositoryFileRoutes } from './repository-file-routes.js'
import type { SkillProposalReceipt, SkillDisableReceipt } from '../core/skill-application.js'
import { usage } from '../feishu/mention.js'
import { decisionRef } from '../core/inbox.js'
/**
 * 网关内部 API：只监听本机，供 friday-lark-mcp 进程调用。
 * 每个请求带 capability token，作用域锁死在签发它的那个会话/群/发起人上。
 *
 * 跨群读取规则（对齐 Claude Tag "频道用频道的权限、DM 用你自己的权限"）：
 * - 群会话只能读本群（回答对全群可见，不能把别的群的内容带进来）。
 * - 私聊会话可以读机器人所在、且发起人也是成员的群。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { completeConnection, type ConnectCompletionDeps } from '../feishu/connect-completion.js'
import type { ConnectionReply } from '../feishu/connection-capabilities.js'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { AsUser, ChatInfo, FeishuClient, HistoryMessage } from '../feishu/client.js'
import { MINUTES_SCOPES, MinutesError, minutesSourceRef, type FeishuMinutes, type MinutesSource } from '../feishu/minutes.js'
import { FeishuApiError, parseDocRef } from '../feishu/client.js'
import { FIELD_TYPE, type Bitable, type BitableField } from '../feishu/bitable.js'
import { fetchPublicUrl, WebFetchRefused } from '../core/web-fetch.js'
import { WebEgressDenied, type PublicWebRequestLease } from '../core/web-egress.js'
import type { SourceContext } from '../core/source-context.js'
import type { ChatReadScope } from '../core/chat-read-scope.js'
import { USER_SCOPE_TIERS, type UserScopeExtra, type UserToken, type UserTokenStore } from '../feishu/oauth.js'
import { ChannelMemory, ORG_SCOPE, type MemoryAddInput, type MemoryAvailability, type MemoryNote, type NoteKind } from '../core/memory.js'
import { RuntimeContextError } from '../core/runtime-contexts.js'
import type { Registry } from '../core/registry.js'
import { WorkControlError } from '../core/work-contexts.js'
import { CODEOWNERS_PATHS, ownersFor, parseCodeowners } from '../github/codeowners.js'
import { parseIssueTriageParams, recordIssueTriage, type IssueTriageView } from '../github/issue-triage.js'
import { MessageService } from '../core/messages.js'
import { UserMessageReadAccess, UserMessageReadChanged } from '../core/user-message-read-lease.js'
import { assertRequestCurrent, RequestEndedError, withRequestLease, withoutRequestLease } from '../core/request-lease.js'
import { captureChatDirectory, captureMessageFile, captureMessageRead, MessageSourceBindings, type MessageReadContext, type MessageReadReceipt } from '../core/message-read-context.js'
import { prepareMessageReadPresentation } from '../core/message-read-presentation.js'
import type { MessageCache } from '../core/message-cache.js'
import { KIND_LABEL, STATUS_LABEL, stagesFor, type Todo, type TodoAudience, type TodoKind, type Todos, type TodoStatus } from '../core/todos.js'
import type { TodoProvenance } from '../core/todo-provenance.js'
import { proposalPointerTitle, routineProgress, type RoutineApplication } from '../core/routine-application.js'
import type { DecisionContext, ResolveDecisionInput, ResolveDecisionResult } from '../core/decision-application.js'
import type { TodoCompletionHost, TodoCompletionReview } from '../core/todo-completion-host.js'
import type { GitHubItemState, GitHubRef } from '../core/todo-completion-evidence.js'
import { readGitHubLinkState } from '../github/link-state.js'
import { describeDeliveryPolicy, describeSchedule, MAX_PAUSE_MS, parseAlwaysOnMention, parseDeliveryPolicy, parseMinNewMessages, parseQuietHours, parseSchedule, RoutineControlError, TRIGGER_WATCH_ONLY, type Routine, type RoutineControlAction, type RoutineDeliveryPolicy, type RoutineStore, type ScheduleSpec } from '../core/routines.js'
import { Identities } from '../core/identities.js'
import { Bugs, BUG_INFO_KINDS, DECLINABLE_INFO_KINDS, INFO_KIND_LABELS, declinedKinds, isBugInfoKind, parseIssueReference, sameIssueReference,
  type BugBucket, type BugDeclinableInfoKind, type BugDeclinedInfo, type BugInfoKind, type BugStatus, type BugIntakePhase } from '../core/bugs.js'
import { BugQuestionError, type BugQuestions, type BugQuestion, type BugQuestionReply } from '../core/bug-questions.js'
import type { AskBugQuestionInput, AskBugQuestionReceipt, ResolveBugQuestionReplyInput } from '../core/question-types.js'
import type { DomainOperationKind, DomainOperationReceipt, FeedbackControl, FeedbackStopReceipt } from '../core/feedback-control.js'
import type { Inbox, PendingItem } from '../core/inbox.js'
import type { SkillProposals } from '../core/skills.js'
import { BuiltinSkillReadError, type BuiltinSkillReader } from '../core/builtin-skill-bundle.js'
import type { Circles } from '../core/circles.js'
import { dmSpaceId, spaceScope, type Spaces } from '../core/space.js'
import type { PolicyService } from '../core/policy.js'
import type { AbilityActor } from '../core/orchestrator.js'
import type { ToolDeliveryInput, ToolDeliveryResult } from '../core/tool-delivery.js'
import { renderResponsibilityCard, renderSkillProposalCard } from '../feishu/cards.js'
import { GitHubApiError, type GitHubIdentity } from '../github/identity.js'
import { ChangeAccessError, type ChangeManager } from '../github/changes.js'
import { createRepositoryExecutionRoutes } from './repository-execution-routes.js'
import { RepositoryExecutionError, type RepositoryExecutions } from '../github/executions.js'
import type { RepositoryExecutionOutputs } from '../github/execution-output.js'
import { readPullRequestReview } from '../github/pr-review.js'
import { firstReleaseContaining, readReleases } from '../github/releases.js'
import type { GitHubProjectView } from '../github/project-view.js'
import type { ProjectView } from '../github/project-view.js'
import { renderProjectPage } from '../web/project-page.js'
import { assignIssue, commentIssue, fingerprintOf, openIssue, provenanceLine, type IssueAssignmentOutcome, type IssueLinks, type IssueOperationOrigin } from '../github/issues.js'
import type { TokenIssuer, Capability, ALL_SCOPES } from './tokens.js'
import type { Logger } from '../log.js'
import type { ExecutionMaterialApplication } from '../core/execution-material-application.js'
import { createMaterialRoutes } from './material-routes.js'
import { createMeetingRoutes } from './meeting-routes.js'
import type { MeetingApplication } from '../core/meeting-application.js'
import type { MinutesTodoApplication } from '../core/minutes-todos.js'
import { MINUTES_DRAFT_MAX_ITEMS, MinutesDraftAccessError, MinutesDraftError } from '../core/minutes-drafts.js'
import { DeliveryError, type DeliveryRecord } from '../core/delivery.js'
import { createPollRoutes } from './poll-routes.js'
import type { PollRuntime } from '../core/poll-runtime.js'
import { accessFailure, accessFailureText, providerAccessFailure, tokenAccessFailure, type AccessFailure } from '../core/access-failure.js'
import { RunApiCalls } from '../core/run-api-calls.js'
import { TodoApplication, TodoApplicationError, type TodoPatch } from '../core/todo-application.js'
import type { FeishuTaskSync } from '../core/feishu-task-sync.js'
import type { MyDayApplication } from '../core/my-day.js'
import { createMyDayRoutes } from './my-day-routes.js'
import { createTodoNativeRoutes } from './todo-native-routes.js'

export interface InternalApiDeps {
  todoApplication?: TodoApplication
  taskSync?: FeishuTaskSync
  myDay?: MyDayApplication
  materials?: ExecutionMaterialApplication
  /** 会议旁听：部署开关打开时才挂路由（meetingsEnabled）；应用由编排器构造，取值时才读。 */
  meetingsEnabled?: boolean
  meetings?: MeetingApplication
  /** 需求投票：部署开关打开时才挂路由（pollsEnabled）；运行时由编排器构造，取值时才读。 */
  pollsEnabled?: boolean
  polls?: PollRuntime
  isManagedRun?: (runId: string) => boolean
  registerExecutionFile?: (runId: string, input: { name: string; data: Buffer; operationKey: string }, assertCurrent: () => void) => Promise<{
    fileId: string; digest: string; name: string; version: number; size: number
  }>
  /** Independent authenticated human surface, never reuses a worker capability. */
  consoleRouter?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  /** 应用命名空间来自部署配置，不能让模型指定。 */
  appId?: string
  /** Commit the gateway started from; /healthz reports it so a deploy can confirm the new version is the one answering. */
  version?: string
  feishuDomain?: 'feishu' | 'lark'
  /** Bug 收敛桶 */
  bugs?: Bugs
  questions?: BugQuestions
  feedback?: FeedbackControl
  stopFeedback?: (sessionKey: string, runId: string, feedbackId: number, manageRoutines: boolean) => Promise<FeedbackStopReceipt>
  canPersistFeedbackState?: (sessionKey: string, runId: string, feedbackId: number) => boolean
  recordDomainOperation?: (sessionKey: string, runId: string, receipt: DomainOperationReceipt) => void
  askBugQuestion?: (sessionKey: string, runId: string, input: AskBugQuestionInput) => Promise<AskBugQuestionReceipt>
  resolveBugQuestionReply?: (sessionKey: string, runId: string, input: ResolveBugQuestionReplyInput) => Promise<{ question: BugQuestion; reply: BugQuestionReply }>
  /** 查不到人时重新拉一次成员对照表（宿主提供，带节流）。 */
  refreshIdentities?: () => Promise<unknown>
  /** 人的身份映射：GitHub 登录名 ↔ 飞书显示名 */
  identities?: Identities
  feishu: FeishuClient
  /** 多维表格：通用建表用。没配时 /v1/table/create 返回 501，而不是假装成功。 */
  bitable?: Bitable
  /** 出网代理：开发机直连公网不通，抓网页要经它。不配就直连。 */
  webProxyUrl?: string
  authorizePublicWebRequest?: (cap: AbilityActor, url: string) => PublicWebRequestLease
  /**
   * 私聊读取范围：默认全开，本人可以逐个停读某个会话。
   * 不配时就是纯粹的全开。
   */
  readScope?: ChatReadScope
  memory: ChannelMemory
  /** Host-owned application writes and actual reads; never fall back to untracked store access. */
  memoryRuntime?: {
    recordRead: (runId: string, refs: { id: number; revision: number }[]) => void
    search?: (runId: string, scopes: string[], query: string, limit: number) => Promise<{ notes: MemoryNote[]; unavailable: number; sourceDenied: number; availability?: MemoryAvailability }>
    add: (runId: string, input: MemoryAddInput) => MemoryNote | Promise<MemoryNote>
    forget: (runId: string, id: number, scope: string) => Promise<boolean>
  }
  /** Host display of a candidate this Run just committed; a card, not a model-authored confirmation. */
  presentMemoryCandidate?: (actor: AbilityActor, noteId: number, revision: number) => Promise<DeliveryRecord>
  registry: Registry
  messages: MessageService
  messageCache: MessageCache
  todos: Todos
  /** Host derives original Task and selected material receipts before the atomic write. */
  captureTodoProvenance?: (sessionKey: string, runId: string) => Promise<TodoProvenance>
  routines?: RoutineStore
  /** 收件箱：等人拍板的事，之后蹭别的对话捎带提醒 */
  inbox?: Inbox
  /** 个人授权 token；有它私聊会话就以本人身份读群/单聊/文档 */
  userTokens?: UserTokenStore
  disconnectPersonalConnection?: (openId: string, expected: UserToken) => boolean
  /** Host persists the exact Work/Task authorization wait before offering a card. */
  onAccessBlocked?: (actor: AbilityActor, failure: AccessFailure, purpose: string) => Promise<void>
  /** OAuth 回调用：换 token 时要带同一个 redirect_uri */
  oauthRedirectUri?: string
  /** 完成账号核对后，由应用层恢复该用户因授权到期暂停的职责。 */
  onAuthorizationCompleted?: (openId: string) => Promise<{ connected: boolean; resumed: number; stillPaused: number }>
  /** 统一持久停用与在途取消；入口完成当前用户的管理权限检查后调用。 */
  stopRoutine?: (id: number, mode: 'pause' | 'remove') => void
  controlRoutine?: (id: number, action: RoutineControlAction, options?: { resumeAt?: number }) => Routine | undefined
  /** 职责修改走宿主持有的同一个 RoutineApplication（核对版本、提案指针标题同一事务）；未接线时拒绝修改 */
  updateRoutine?: (id: number, patch: Parameters<RoutineApplication['update']>[1], options: { expectedConfigVersion?: number; actorOpenId?: string }) => ReturnType<RoutineApplication['update']>
  /** G9：新建职责之后，与别的职责产出重复时登记一条待拍板（由宿主的 RoutineApplication 做）。 */
  noteRoutineOverlaps?: (id: number, actorOpenId?: string) => ReturnType<RoutineApplication['noteOverlaps']>
  /** 提案被修改后，按当前内容和当前版本刷新提案卡；返回是否刷新成功 */
  refreshProposalCard?: (id: number) => Promise<boolean>
  /** 待拍板事项：宿主持有的同一个 DecisionApplication */
  pendingDecisions?: (ownerOpenId: string, context: DecisionContext) => PendingItem[]
  resolveDecision?: (input: ResolveDecisionInput) => ResolveDecisionResult
  /** 待办按证据标完成（只在本人的交互任务里判断） */
  todoCompletion?: Pick<TodoCompletionHost, 'review'>
  /** 「新提议 · 新增技能」 */
  skills?: SkillProposals
  builtinSkills?: BuiltinSkillReader
  proposeSkill?: (sessionKey: string, runId: string, input: { name: string; description: string; body: string }) => Promise<SkillProposalReceipt>
  disableSkill?: (sessionKey: string, runId: string, input: { name: string; expectedRevision: number }) => Promise<SkillDisableReceipt>
  /** 联盟：同联盟的群互通（群会话可读同联盟其他群） */
  circles?: Circles
  /** 空间：记忆/待办的作用域挂在它上面 */
  spaces: Spaces
  /** 六类动作的判定入口 */
  policy: PolicyService
  /** GitHub 身份（App 或过渡期 PAT）；模型只能经这里读 GitHub */
  github?: GitHubIdentity
  personalGithub?: GitHubUserConnections
  gmail?: GmailConnections
  personalMcp?: PersonalMcpConnections
  mailbox?: GmailMailbox
  emailDrafts?: EmailDrafts
  showEmailDraft?(owner: string, id: string): Promise<void>
  captureEmailDraftSource?(sessionKey: string, runId: string): Promise<{ source: EmailDraftSource; assertCurrent(): void }>
  consumeEmailDraft?(sessionKey: string, runId: string, draft: EmailDraft): void
  projects?: GitHubProjectView
  /** 修复者写侧：准备可写副本、以 App 身份推分支开 draft PR */
  changes?: ChangeManager
  executions?: RepositoryExecutions
  /** Imports a capture job's verified output into its original change. */
  executionOutputs?: RepositoryExecutionOutputs
  /** 本人妙记（只读，个人身份） */
  minutes?: FeishuMinutes
  /** 妙记行动项草稿：只生成草稿并送本人私聊确认，待办由本人点卡后宿主写入；由编排器构造，取值时才读。 */
  minutesTodos?: Pick<MinutesTodoApplication, 'propose'>
  /** Issue 写侧的查重映射（同一件事只开一张 Issue） */
  issueLinks?: IssueLinks
  /** 只读接单评估运行时；由编排器构造，取值时才读。没有时 assess/get 返回 503。 */
  issueAssessment?: IssueAssessmentRuntime
  /** 机器人名字，写进 Issue 正文的出处行 */
  botName?: string
  /** 网关侧写操作前问发起人（开 PR 等）；没有就一律拒绝 */
  /**
   * 网关侧写操作的确认卡。`approver` 决定谁能点：
   * requester（默认）= 发起人自己；space_owner = 群负责人（拉机器人进群的人优先）。
   */
  confirm?: (input: { sessionKey: string; header: string; headline: string; detail?: string; note?: string; approver?: 'requester' | 'space_owner'; requesterOnly?: boolean; fullDetail?: boolean; signal?: AbortSignal }) => Promise<boolean>
  /** 可信用户（open_id）：沙箱升级自动放行。晋升到企业层看的是 policy 里的 admins */
  trustedUsers?: string[]
  /** 这一轮读了别的会话：网关据此在回答末尾披露"引用了 X 群" */
  onCrossSpaceRead?: (sessionKey: string, read: { chatId: string; name: string; what: string }) => void
  /** 本次实际返回的群消息流完整时间段；仅用于职责的消费游标，不代表线程/卡片全文完整。 */
  onChatHistoryRead?: (sessionKey: string, read: { chatId: string; startSec: number; endSec: number }) => void
  /** Host-only actual returned material and a request-scoped authorization check; never serialized. */
  onMessageRead?: (sessionKey: string, runId: string, receipt: MessageReadReceipt) => void
  onExternalSourceRead?: (sessionKey: string, read: SourceContext['external'][number]) => void
  /** 当前运行阶段允许调用的路由；undefined 表示沿用 token，空数组表示全部禁止。 */
  allowedRoutesForSession?: (sessionKey: string) => readonly string[] | undefined
  /** 当前运行用于复验签名 runId/发起人；不能给旧 token 补绑当前身份。 */
  resolveActorForSession?: (sessionKey: string) => { requesterOpenId?: string; runId?: string; stage?: string; taskId?: number; controlRevision?: number } | undefined
  canPersistDerivedState?: (sessionKey: string, purpose?: 'memory') => boolean
  canPersistPersonalMemory?: (sessionKey: string) => boolean
  /** 直接交付也经宿主当前运行、受众和投递账本；模型不能指定身份或发送键。 */
  deliverToolResult?: (sessionKey: string, runId: string, input: ToolDeliveryInput) => Promise<{ messageId: string; noteStatus?: ToolDeliveryResult['noteStatus'] }>
  onRepositoryRead?: (sessionKey: string, repo: string, grant?: { owner: string; revision: number }) => void
  repositoryIssueFollowup?: (sessionKey: string, runId: string, input: import('../github/issue-followups.js').IssueFollowupInput) => Promise<import('../github/issue-followups.js').IssueFollowupView>
  repositoryCiControl?: (sessionKey: string, runId: string, input: import('../github/ci-followups.js').CiControlInput) => Promise<import('../github/ci-followups.js').CiControlResult>
  repositoryCiTracking?: (sessionKey: string, runId: string, input: import('../github/ci-followups.js').CiTrackingQuery) => Promise<import('../github/ci-followups.js').CiTrackingState>
  /** Confirmed repository receipts only; records a result link, never sends another notification. */
  recordRepositoryResult?: (sessionKey: string, runId: string, receipt: { repo: string; url?: string }) => void
  captureRepositoryIssueOrigin?: (sessionKey: string, runId: string, repo: string) => Omit<import('../github/issues.js').IssueOperationOrigin, 'apiCallId'>
  canPublishToRepository?: (sessionKey: string, repo: string) => boolean
  /** 能力入口：让模型用人话就能触发工作状态 / 周报 / wiki / 交接包 / 看板 / 空间配置 */
  abilities?: {
    status: (cap: AbilityActor) => Promise<string>
    report: (cap: AbilityActor) => Promise<string>
    wiki: (cap: AbilityActor) => Promise<string>
    handover: (cap: AbilityActor) => Promise<string>
    /**
     * 缺个人授权时把授权卡发过去，并返回该跟他说的那一句；已连接或不适用时返回空串。
     * **必填**：设成可选的时候，宿主那边漏接了它就会静默失效，真机上正是这么漏掉一张卡的。
     */
    offerConnect: (cap: AbilityActor, extras?: readonly UserScopeExtra[], failure?: AccessFailure) => Promise<string>
    /** Host-owned connection receipt; grants and requested scopes remain distinct. */
    connect: (cap: AbilityActor, extras?: readonly UserScopeExtra[]) => Promise<ConnectionReply>
    groups: (cap: AbilityActor) => Promise<string>
    pmo: (cap: AbilityActor, args?: string) => Promise<string>
    settings: (cap: AbilityActor, args?: string) => Promise<string>
    /** 本群主动接话的查看 / 开 / 关（自然语言入口；与 /proactive 同一套宿主规则）。 */
    proactive: (cap: AbilityActor, args?: string) => Promise<string>
    /**
     * 这轮动过哪几条待办。收下之后这轮的回复会带一张能打勾的清单卡，
     * 而不是「已记下 5 条（#2-#6）：……」这种压成一行的纯文本回执。
     * **必填**：设成可选，宿主漏接就静默退回纯文本，而那正是要修的东西。
     */
    notedTodos: (cap: AbilityActor, ids: readonly number[], mode?: 'read' | 'write') => void
    /**
     * 往真实仓库写了东西之后，私聊抄送一份给部署管理员。
     *
     * **这不是审批**——PR 不拦（它是提议不是改动），拦一道只会让事情停在发起人那儿。
     * 但 Friday 用的是自己的 GitHub 身份往别人的仓库写，署的是它的名；
     * 谁在运维它，就该看得见它以自己的名义做了什么，而不是等哪天在 GitHub 上偶然刷到。
     */
    ccRepositoryWrite: (cap: AbilityActor, what: { repo: string; action: string; url?: string; title?: string; files?: readonly string[] }) => void
    explain: (cap: AbilityActor) => string
    selfcheck: (cap: AbilityActor, args?: string) => Promise<string>
  }
  tokens: TokenIssuer
  log: Logger
  maxHistoryPerCall: number
  armRepositoryCi?: (sessionKey: string, runId: string, input: { changeId: string; expectedSnapshot: string }) => void
  preparations?: ChangePreparationOperations
  preparationRunSignal?: (sessionKey: string, runId: string) => AbortSignal
  personalMcpRunSignal?: (sessionKey: string, runId: string) => AbortSignal
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly failure?: AccessFailure,
  ) {
    super(message)
  }
}

/** 通用建表的硬上限：一次对话整理出来的表不该超过这个规模，超了说明该拆或该分批。 */
const MAX_TABLE_FIELDS = 30
const MAX_TABLE_ROWS = 500

const TABLE_FIELD_TYPES: Record<string, number> = {
  text: FIELD_TYPE.text,
  number: FIELD_TYPE.number,
  select: FIELD_TYPE.singleSelect,
  date: FIELD_TYPE.date,
  checkbox: FIELD_TYPE.checkbox,
}

const FALSEY = new Set(['false', '0', '否', 'no', 'n', ''])

/**
 * 把模型给的列定义和行数据变成多维表格的真实字段与记录。
 *
 * 两条刻意的约束：
 * - 行里只保留**声明过的列**——模型多塞一个键不会悄悄变成一列新字段。
 * - 单选列的候选项由真实行值按出现顺序推出来，模型不用自己列，也就不会列出行里没有的值。
 */
function buildTableSpec(rawFields: unknown[], rawRows: unknown[]): { fields: BitableField[]; records: { fields: Record<string, unknown> }[] } {
  const seen = new Set<string>()
  const declared: { name: string; type: string }[] = []
  for (const raw of rawFields) {
    const f = raw as { name?: unknown; type?: unknown }
    const name = typeof f?.name === 'string' ? f.name.trim().slice(0, 100) : ''
    if (!name) throw new ApiError(400, '每一列都要有 name')
    if (seen.has(name)) throw new ApiError(400, `列名重复：${name}`)
    const type = typeof f?.type === 'string' ? f.type.trim().toLowerCase() : 'text'
    if (!(type in TABLE_FIELD_TYPES)) throw new ApiError(400, `不支持的列类型 ${type}；可用：${Object.keys(TABLE_FIELD_TYPES).join(' / ')}`)
    seen.add(name)
    declared.push({ name, type })
  }

  const rows = rawRows.map((r) => (r && typeof r === 'object' ? r as Record<string, unknown> : {}))
  const records = rows.map((row) => {
    const fields: Record<string, unknown> = {}
    for (const { name, type } of declared) {
      if (!(name in row)) continue
      const v = row[name]
      if (v === null || v === undefined) continue
      if (type === 'number') {
        const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''))
        if (Number.isFinite(n)) fields[name] = n
      } else if (type === 'date') {
        const ms = typeof v === 'number' ? v : Date.parse(String(v))
        if (Number.isFinite(ms)) fields[name] = ms
      } else if (type === 'checkbox') {
        fields[name] = typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : !FALSEY.has(String(v).trim().toLowerCase())
      } else {
        const s = String(v).slice(0, 5000)
        if (s) fields[name] = s
      }
    }
    return { fields }
  })

  const fields: BitableField[] = declared.map(({ name, type }) => {
    if (type !== 'select') return { field_name: name, type: TABLE_FIELD_TYPES[type]! }
    const options: { name: string }[] = []
    const have = new Set<string>()
    for (const rec of records) {
      const v = rec.fields[name]
      if (typeof v !== 'string' || have.has(v)) continue
      have.add(v)
      options.push({ name: v })
    }
    return { field_name: name, type: FIELD_TYPE.singleSelect, property: { options } }
  })
  return { fields, records }
}

// HTTP 入口只复制已经签名并核验的 runId；stage 是该同一运行的初始快照。
type RequestCapability = Capability & { boundRunId?: string; boundStage?: string; boundControlRevision?: number; requestSignal?: AbortSignal }
type CapabilityScope = (typeof ALL_SCOPES)[number]
type Handler = (cap: RequestCapability, body: Record<string, unknown>) => Promise<unknown>

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024

/**
 * 从会话键反推这条待办是怎么来的，给人看。
 * `msg:` 是人当面派的活，不标出处；其余都是我自己挖的，要标。
 */
export function todoSource(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined
  if (sessionKey.startsWith('proactive:')) return '群巡查'
  if (sessionKey.startsWith('routine:')) return '常驻职责'
  if (sessionKey.startsWith('selfcheck:')) return '自检'
  if (sessionKey.startsWith('wiki:')) return 'wiki 整理'
  return undefined
}

/** 私聊里不指定群时，最多逐个回填这么多群；再多就只翻缓存并明说没搜全。 */
const SEARCH_BACKFILL_MAX_CHATS = 6

export function createInternalApi(deps: InternalApiDeps): {
  server: Server; callbackServer: Server; routes: Record<string, Handler>
  beginShutdown(): void
  /** A timeout retains pending handlers and their unresolved effect evidence.
   * The process owner must keep the database open until drained or exit without
   * scheduling further JavaScript; closing sockets is not a drain barrier. */
  waitForShutdown(timeoutMs: number): Promise<{ drained: boolean; pending: number }>
} {
  const { feishu, bitable, readScope, identities, bugs, memory, registry, messages, messageCache, todos, routines, inbox, userTokens, skills, circles, spaces, policy, github: teamGithub, changes, minutes, issueLinks, confirm, tokens, log, maxHistoryPerCall, onCrossSpaceRead, abilities } = deps
  const githubLane = personalGitHubLane(teamGithub, deps.personalGithub), github = githubLane.github
  const recordRepositoryRead = (sessionKey: string, repo: string) => deps.onRepositoryRead?.(sessionKey, repo, githubLane.receipt())
  const todoApplication = deps.todoApplication ?? new TodoApplication({ db: registry.db, todos })
  function changeTodo<T>(change: () => T): T {
    try { return change() } catch (error) {
      if (error instanceof TodoApplicationError) throw new ApiError(error.status, error.message)
      throw error
    }
  }
  // The HTTP dispatcher awaits the route too. Retain its read lease through that final
  // continuation, so a revocation queued after source registration cannot escape as JSON.
  const minutesReadGuards = new WeakMap<RequestCapability, () => void>()
  const runCalls = new RunApiCalls(registry.db)
  const callIds = new WeakMap<RequestCapability, string>()
  const preparationReturns = new WeakMap<RequestCapability, Set<string>>()
  const personalMcpReturns = new WeakMap<RequestCapability, Set<string>>()
  const personalScopeGuards = new WeakMap<RequestCapability, () => void>()
  const publicWebGuards = new WeakMap<RequestCapability, () => void>()
  const readFailureGuards = new WeakMap<RequestCapability, { identity: 'user' | 'app'; assertCurrent(): void; purpose: string; extras?: readonly UserScopeExtra[]; expireAccessToken?(): void }>()
  const botName = (): string => deps.botName ?? 'Friday'
  const trustedUsers = deps.trustedUsers ?? []
  const messageReads = userTokens ? new UserMessageReadAccess({ appId: deps.appId ?? '', userTokens, feishu }) : undefined

  /** 本会话「这里」的写入作用域 = 它所在的空间。token 里带了就用 token 的（换绑后仍指同一个空间）。 */
  function spaceIdOf(cap: Capability): string {
    return cap.spaceId ?? spaces.ensure({ kind: cap.chatType, chatId: cap.chatId, openId: cap.requesterOpenId }).id
  }

  function hereScope(cap: Capability): string {
    return spaceScope(spaceIdOf(cap))
  }

  /** Use the same real audience as cards and the console, including historical session bindings. */
  function todoAudience(cap: Capability): TodoAudience {
    if (cap.chatType === 'p2p' && !cap.requesterOpenId?.trim()) throw new ApiError(403, '私聊待办需要明确的发起人身份')
    // Group proactive reads use application identity. Empty means no personal
    // actor; the common audience filter consults openId only for private chats.
    return { scope: hereScope(cap), chatId: cap.chatId, chatType: cap.chatType, openId: cap.requesterOpenId ?? '' }
  }

  // 网关签发，不接受模型传 requestKey。相同讨论中的同一意图可跨重试/重启复用；
  // 新正文是新操作，出处中变化的时间戳不是。不要用每次重试新建的 task.id。
  function githubRequestKey(cap: Capability, intent: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify({
      spaceId: spaceIdOf(cap), sessionKey: cap.sessionKey,
      actor: cap.requesterOpenId ?? null, intent,
    })).digest('hex')
  }

  /** 会话能读的记忆层：企业 →（群）联盟 → 本空间。顺序即注入顺序。 */
  function memoryReadScopes(cap: Capability): string[] {
    const scopes = [ORG_SCOPE]
    if (cap.chatType === 'group') {
      const circle = circles?.circleOf(cap.chatId)
      if (circle) scopes.push(`circle:${circle}`)
    }
    scopes.push(hereScope(cap))
    return scopes
  }

  /** 检查 capability 与当前执行身份；动作的来源和资源边界由下面的显式写入口决定。 */
  function assertCurrentRun(cap: RequestCapability, checkStage = true): void {
    // Ending one tool request does not cancel the Run or erase a started effect.
    // All ordinary authorization/write/page gates already pass through here.
    assertRequestCurrent(cap.requestSignal)
    if (!deps.resolveActorForSession) return
    const current = deps.resolveActorForSession(cap.sessionKey)
    if (!cap.runId || !current?.runId || current.runId !== cap.runId) throw new ApiError(403, '运行实例已变化或缺少运行授权，请重新发起')
    if (current.requesterOpenId !== cap.requesterOpenId) throw new ApiError(403, '运行已结束或发起人已变化，请重新发起')
    if ((cap.boundRunId !== undefined && cap.boundRunId !== cap.runId) || (checkStage && cap.boundStage !== undefined && current.stage !== cap.boundStage)) throw new ApiError(403, '运行实例或执行阶段已变化，请重新发起')
    if (checkStage && cap.boundControlRevision !== undefined && cap.boundControlRevision !== (current.controlRevision ?? 0)) throw new ApiError(403, '本轮控制状态已变化，请重新发起')
  }

  function need(cap: RequestCapability, scope: CapabilityScope): void {
    if (!cap.scopes.includes(scope)) throw new ApiError(403, `该会话没有 ${scope} 权限`)
    assertCurrentRun(cap)
    if (cap.spaceId) {
      const space = spaces.get(cap.spaceId)
      if (!space || space.status !== 'active' || space.chatId !== cap.chatId || space.kind !== cap.chatType) throw new ApiError(403, '空间已归档或换绑，请重新发起')
      if (cap.requesterOpenId && !spaces.roleOf(space.id, cap.requesterOpenId)) throw new ApiError(403, '发起人已不属于这个空间')
    }
    const callId = callIds.get(cap)
    if (callId) runCalls.need(callId, scope)
  }

  function needSafeDerivedState(cap: RequestCapability, purpose?: 'memory'): void {
    const allowed = !deps.canPersistDerivedState || (purpose ? deps.canPersistDerivedState(cap.sessionKey, purpose) : deps.canPersistDerivedState(cap.sessionKey))
    if (!allowed) {
      throw new ApiError(403, '这一轮已经读过别的群、文档或仓库，之后就不能再把内容记成待办、记忆、定时任务或关注（防止把那些内容带进来）。' +
        '跟本人说一句「这条我下一轮再记，你再发一遍就行」；下一轮收到后先登记、再去读东西。')
    }
  }

  function needDerivedWrite(cap: RequestCapability, scope: CapabilityScope): void {
    need(cap, scope)
    needSafeDerivedState(cap)
  }

  /** 本人持久状态只接受当前交互任务，不能由巡检、反思或模型指定另一个人代写。 */
  function needInteractiveStateWrite(cap: RequestCapability, scope: 'todo:write' | 'profile:write' | 'mail:draft'): string {
    needDerivedWrite(cap, scope)
    if (!deps.resolveActorForSession || !deps.canPersistDerivedState) throw new ApiError(503, '本次执行的个人状态写入入口尚未就绪')
    if (!cap.boundRunId || cap.boundStage !== 'task' || !cap.spaceId || !cap.requesterOpenId?.trim()) {
      throw new ApiError(403, '个人状态只能由当前交互任务为发起人记录')
    }
    const gate = policy.decide({ spaceId: cap.spaceId, openId: cap.requesterOpenId, action: 'remember' })
    if (gate.decision !== 'allow') throw new ApiError(403, gate.reason)
    return cap.requesterOpenId
  }

  function needFeedbackWrite(cap: RequestCapability, id: number): void {
    need(cap, 'bug:write')
    if (cap.boundStage !== 'feedback_control') needSafeDerivedState(cap)
    else if (!cap.boundRunId || !deps.canPersistFeedbackState?.(cap.sessionKey, cap.boundRunId, id)) {
      throw new ApiError(403, '当前控制请求不能修改这条反馈或使用其中的来源')
    }
  }

  function recordDomainOperation(cap: RequestCapability, receipt: DomainOperationReceipt): void {
    if (cap.boundRunId) deps.recordDomainOperation?.(cap.sessionKey, cap.boundRunId, receipt)
  }

  /** 本人的待拍板事项只在当前交互任务里、为发起人本人列出；巡检、职责运行看不到。身份只取 cap。 */
  function needOwnPendingDecisions(cap: RequestCapability): string {
    need(cap, 'todo:read')
    if (!cap.boundRunId || cap.boundStage !== 'task' || !cap.spaceId || !cap.requesterOpenId?.trim()) {
      throw new ApiError(403, '待拍板事项只能由当前交互任务为发起人本人查看')
    }
    const gate = policy.decide({ spaceId: cap.spaceId, openId: cap.requesterOpenId, action: 'read' })
    if (gate.decision !== 'allow') throw new ApiError(403, gate.reason)
    return cap.requesterOpenId
  }

  /** 职责修改只走宿主的 RoutineApplication：同步执行，返回时已提交；版本对不上（入口读到之后又被改过）返回 409。 */
  function applyRoutineUpdate(id: number, patch: Parameters<RoutineApplication['update']>[1], version: number | undefined, actorOpenId?: string): ReturnType<RoutineApplication['update']> {
    if (!deps.updateRoutine) throw new ApiError(503, '职责修改入口尚未就绪')
    try {
      return deps.updateRoutine(id, patch, { expectedConfigVersion: version, actorOpenId })
    } catch (err) {
      if (err instanceof RoutineControlError) throw new ApiError(409, err.message)
      throw err
    }
  }

  /** 提案的内容或状态变了之后刷新提案卡：只在写入提交之后做；刷不成功不影响已提交的结果。 */
  async function refreshProposalCard(id: number): Promise<'refreshed' | 'not_refreshed'> {
    const refreshed = await (deps.refreshProposalCard?.(id) ?? Promise.resolve(false)).catch(() => false)
    return refreshed ? 'refreshed' : 'not_refreshed'
  }

  /** 待办完成证据用：读 Issue / PR 的当前状态（不读正文）。只读允许范围内的仓库；读不到按读不到处理，不当成没做完。 */
  function readTodoLinkState(cap: RequestCapability): ((ref: GitHubRef) => Promise<GitHubItemState>) | undefined {
    if (cap.chatType === 'p2p' && deps.personalGithub && deps.personalGithub.view(cap.requesterOpenId ?? '').status !== 'connected') return undefined
    if (!github || !cap.scopes.includes('github:read')) return undefined
    return async ref => {
      need(cap, 'github:read')
      return readGitHubLinkState(github, ref)
    }
  }

  /**
   * “我还有哪些待办”：列表之前按证据判断本人名下、当前会话能看到的未完成待办。只在本人的当前交互任务里做；
   * 可以直接标完成的，只有本轮能写个人状态时才写，否则和“看起来做完了”的一样只列出来请本人确认。
   */
  async function reviewTodoCompletion(cap: RequestCapability): Promise<{ completion?: TodoCompletionReview }> {
    const host = deps.todoCompletion, owner = cap.requesterOpenId?.trim()
    if (!host || !owner || !cap.boundRunId || cap.boundStage !== 'task') return {}
    const readGitHub = readTodoLinkState(cap)
    const review = await host.review({ owner, audience: todoAudience(cap), ...(readGitHub ? { readGitHub } : {}),
      assertWritable: () => { needInteractiveStateWrite(cap, 'todo:write') } })
    need(cap, 'todo:read')
    return review.applied.length || review.suggested.length ? { completion: review } : {}
  }

  function needConfigure(cap: RequestCapability): void {
    needDerivedWrite(cap, 'space:configure')
    needConfigureControl(cap)
  }

  /** 撤销已有配置不持久化模型派生内容，仍须当前空间的配置权限。 */
  function needConfigureControl(cap: RequestCapability): void {
    need(cap, 'space:configure')
    const gate = policy.decide({ spaceId: spaceIdOf(cap), openId: cap.requesterOpenId, action: 'configure' })
    if (gate.decision !== 'allow') throw new ApiError(403, gate.reason)
  }

  function needRunSkillRead(cap: RequestCapability): void {
    need(cap, 'skill:read')
    if (!skills || !cap.runId || !cap.spaceId) throw new ApiError(403, '本次执行没有空间技能配置')
    if (cap.requesterOpenId) {
      const gate = policy.decide({ spaceId: cap.spaceId, openId: cap.requesterOpenId, action: 'read' })
      if (gate.decision !== 'allow') throw new ApiError(403, gate.reason)
      return
    }
    // Space owners approve these methods for the Space. A host-created background
    // Run may read its pinned methods, without borrowing an owner's identity or
    // gaining permission to propose, configure, or read another Space's data.
    const actor = deps.resolveActorForSession?.(cap.sessionKey)
    if (!actor || actor.runId !== cap.runId || actor.requesterOpenId !== undefined ||
      (actor.stage !== 'routine' && actor.stage !== 'reflect')) throw new ApiError(403, '本次执行没有空间技能读取授权')
  }

  /** 整理只可修改签发时指定且当前仍有效的候选；不能泛化为 memory:write 的来源豁免。 */
  function needMemoryWrite(cap: RequestCapability, candidateId: unknown): void {
    need(cap, 'memory:write')
    if (cap.memoryWritePolicy !== undefined) requireMemoryCandidate(cap, candidateId)
    else {
      if (!deps.canPersistPersonalMemory?.(cap.sessionKey)) needSafeDerivedState(cap, 'memory')
      const stage = cap.boundStage ?? deps.resolveActorForSession?.(cap.sessionKey)?.stage
      if (stage === 'reflect' && typeof candidateId === 'number' && memory.get(candidateId)?.status === 'confirmed') {
        throw new ApiError(403, '自动整理不能修改或删除已确认记忆')
      }
    }
  }

  /** Deleting an existing note carries no model-derived body into another audience. */
  function needMemoryForget(cap: RequestCapability, id: unknown): void {
    need(cap, 'memory:write')
    if (cap.memoryWritePolicy !== undefined) requireMemoryCandidate(cap, id)
    else {
      if (!cap.requesterOpenId) throw new ApiError(403, '缺少记忆管理人身份')
      const stage = cap.boundStage ?? deps.resolveActorForSession?.(cap.sessionKey)?.stage
      if (stage === 'reflect' && typeof id === 'number' && memory.get(id)?.status === 'confirmed') {
        throw new ApiError(403, '自动整理不能修改或删除已确认记忆')
      }
    }
  }

  function memoryRuntime(cap: RequestCapability): NonNullable<InternalApiDeps['memoryRuntime']> {
    if (!deps.memoryRuntime || !cap.runId) throw new ApiError(503, '当前执行未接入记忆上下文管理')
    return deps.memoryRuntime
  }

  /** 目标尚未解析前的能力检查，不代表某个仓库的写操作已经获得授权。 */
  function needRepositoryPermission(cap: RequestCapability): void {
    need(cap, 'github:write')
    if (!deps.canPublishToRepository) needSafeDerivedState(cap)
    const input = { spaceId: spaceIdOf(cap), openId: cap.requesterOpenId }
    const gate = policy.decide({ ...input, action: 'act', target: 'repository-proposal' })
    if (gate.decision === 'deny') throw new ApiError(403, gate.reason)
    const publish = policy.decide({ ...input, action: 'publish', target: 'cross-space' })
    if (publish.decision === 'deny') throw new ApiError(403, publish.reason)
  }

  /** Issue 写入要记下产生它的真人 Work。例行/主动执行（routine 阶段）没有这样的 Work：写入前以 403 拒绝。 */
  function needIssueWriteRun(cap: RequestCapability, action: 'open' | 'comment'): void {
    if (cap.boundRunId && cap.boundStage !== 'task') throw new ApiError(403, action === 'open'
      ? '例行/主动执行不能建 Issue：Issue 只能由真人委托的任务创建，后续跟进才能归到创建它的工作。需要建 Issue 时，请直接向 Friday 发起委托。'
      : '例行/主动执行不能评论 Issue：Issue 评论只能由真人委托的任务发出，后续跟进才能归到发出它的工作。需要评论时，请直接向 Friday 发起委托。')
  }

  /** 占位时由宿主记下产生这次 Issue 写入的 Run/Work；宿主拒绝记录是授权结果（403），不是 GitHub 故障。
   * 没有宿主回调或没有绑定 Run 的独立调用保持不绑定。 */
  function issueOriginCapture(cap: RequestCapability, repo: string, assertAuthorized: () => void): (() => IssueOperationOrigin) | undefined {
    const capture = deps.captureRepositoryIssueOrigin, runId = cap.boundRunId
    if (!capture || !runId) return undefined
    return () => {
      assertAuthorized()
      const apiCallId = callIds.get(cap)
      if (!apiCallId) throw new ApiError(403, '本次操作缺少真实工具调用记录')
      try { return { ...capture(cap.sessionKey, runId, repo), apiCallId } }
      catch (error) {
        if (error instanceof ApiError) throw error
        throw new ApiError(403, `Issue 写入未执行：${error instanceof Error ? error.message : String(error)}。请回到原委托的话题里重新发起。`)
      }
    }
  }

  function repositoryIdentity(cap: RequestCapability, authorize: () => void = () => need(cap, 'github:read')) {
    authorize()
    const base = { cwd: cap.cwd!, sessionKey: cap.sessionKey, requesterOpenId: cap.requesterOpenId, signal: cap.requestSignal }
    // Legacy direct application callers have no Run resolver. The production
    // HTTP host always supplies one; this never upgrades an old bound change.
    if (!deps.resolveActorForSession && !cap.boundRunId) return { ...base, workKey: undefined, assertAuthorized: authorize }
    const actor = deps.resolveActorForSession?.(cap.sessionKey)
    const task = actor?.taskId ? registry.getTask(actor.taskId) : undefined
    const work = task ? registry.taskWork.get(task.id) : undefined
    if (!cap.boundRunId || cap.boundStage !== 'task' || !cap.cwd || !task || !work ||
      task.sessionKey !== cap.sessionKey || task.requesterOpenId !== cap.requesterOpenId) {
      throw new ApiError(403, '仓库操作缺少当前任务的真实委托和工作记录')
    }
    const before = registry.workContexts.get(work.key)
    if (!before || before.lifecycle !== 'open' || before.pauseReasons.length) throw new ApiError(403, '原工作已停止或暂停，请在对应任务中继续')
    const lease = registry.workContexts.claim(work.key)
    const assertAuthorized = () => {
      authorize()
      const current = deps.resolveActorForSession?.(cap.sessionKey)
      const currentWork = current?.taskId ? registry.taskWork.get(current.taskId) : undefined
      const context = registry.workContexts.get(work.key)
      if (currentWork?.key !== work.key || !context || context.authorityOpenId !== cap.requesterOpenId ||
        context.sessionKey !== cap.sessionKey || context.lifecycle !== 'open' || context.pauseReasons.length ||
        context.controlEpoch !== lease.controlEpoch) throw new ApiError(403, '原工作已停止、暂停或发生变化，请在对应任务中继续')
    }
    assertAuthorized()
    return { ...base, workKey: work.key, assertAuthorized }
  }

  function preparationQuery(cap: RequestCapability, repo: string, base: string | undefined, write: boolean): PreparationQuery {
    if (!cap.boundRunId || !deps.resolveActorForSession) throw new ApiError(403, '仓库准备需要当前任务的真实运行')
    const authorize = () => {
      if (write) needRepositoryWrite(cap, repo)
      else {
        need(cap, 'github:read')
        if (!github?.repoAllowed(repo)) throw new ApiError(403, '仓库不在可读范围内')
      }
    }
    const identity = repositoryIdentity(cap, authorize)
    const actor = deps.resolveActorForSession(cap.sessionKey), task = actor?.taskId ? registry.getTask(actor.taskId) : undefined
    if (!task || !identity.workKey) throw new ApiError(403, '准备副本缺少真实委托和工作记录')
    return { cwd: identity.cwd, sessionKey: identity.sessionKey, requesterOpenId: identity.requesterOpenId,
      workKey: identity.workKey, repo, base, attemptKey: cap.boundRunId, assertCurrent: identity.assertAuthorized,
      operationKey: githubRequestKey(cap, { kind: 'prepare_change', workKey: identity.workKey, taskId: task.id, repo, base: base ?? null }) }
  }

  function notePreparationReturn(cap: RequestCapability, id: string): void {
    let ids = preparationReturns.get(cap)
    if (!ids) { ids = new Set(); preparationReturns.set(cap, ids) }
    ids.add(id)
  }

  function invalidatePreparationReturn(cap: RequestCapability): void {
    if (!cap.boundRunId) return
    for (const id of preparationReturns.get(cap) ?? []) deps.preparations?.markUnobservedForRun(cap.boundRunId, id)
    for (const id of personalMcpReturns.get(cap) ?? []) deps.personalMcp?.markUnobservedForRun(cap.boundRunId, id)
  }

  function preparationResponse(cap: RequestCapability, preparation: import('../github/changes.js').ChangePreparation) {
    notePreparationReturn(cap, preparation.id)
    return { ...(preparation.state === 'prepared' ? preparation.result : {}), repo: preparation.repo,
      preparation: { id: preparation.id, state: preparation.state, repo: preparation.repo,
        ...(preparation.result ? { change: preparation.result } : {}), error_code: preparation.errorCode } }
  }

  function observePreparationUse(routes: Record<string, (cap: RequestCapability, body: Record<string, unknown>) => Promise<unknown>>) {
    return Object.fromEntries(Object.entries(routes).map(([route, handler]) => [route, async (cap: RequestCapability, body: Record<string, unknown>) => {
      const result = await handler(cap, body)
      assertCurrentRun(cap)
      if (deps.preparations && changes && cap.boundRunId && cap.cwd && result && typeof result === 'object' &&
        'changeId' in result && typeof result.changeId === 'string') {
        deps.preparations.observeResultForRun(cap.boundRunId, result.changeId)
        for (const preparation of changes.listPreparations({ cwd: cap.cwd, sessionKey: cap.sessionKey, requesterOpenId: cap.requesterOpenId })) {
          if (preparation.state === 'prepared' && preparation.result?.id === result.changeId) notePreparationReturn(cap, preparation.id)
        }
      }
      return result
    }]))
  }

  function requireProjectReader(cap: RequestCapability): void {
    need(cap, 'github:read')
    if (!cap.spaceId || !cap.requesterOpenId || !spaces.roleOf(cap.spaceId, cap.requesterOpenId) ||
      (cap.chatType === 'p2p' && cap.spaceId !== dmSpaceId(cap.requesterOpenId))) throw new ApiError(403, '项目视图需要当前空间成员身份；私聊仅本人可读')
  }

  /**
   * 缺个人授权时的**唯一**出口：先把授权卡真的发过去，再抛错。
   *
   * 曾有这样的情况：Friday 回「授权卡会发到这个私聊里」，然后没有卡。
   * 因为读日历那条路只是抛了一句"跟他说一声，网关会把授权卡发过去"，
   * 而网关那时候根本没被叫去发。模型照着这句话转述，于是说了一件没发生的事。
   *
   * 所以这里是唯一出口：
   * **凡是因为缺个人授权而做不成的，都从这里走**，卡由网关发，错误消息说的是已经发生的事。
   *
   * 发卡失败也照抛，但话要改成"没能发出去"——宁可说得难听，也不能说一件没发生的事。
   */
  async function readAccessFailure(cap: RequestCapability, failure: AccessFailure, purpose: string, extras?: readonly UserScopeExtra[]): Promise<never> {
    assertCurrentRun(cap)
    if (failure.reason === 'access_token_expired') readFailureGuards.get(cap)?.expireAccessToken?.()
    let offered = false
    const needsConnection = failure.next === 'connect' || failure.next === 'grant_scope'
    if (needsConnection && cap.chatType === 'p2p' && cap.requesterOpenId) {
      await deps.onAccessBlocked?.(abilityActor(cap), failure, purpose)
      assertCurrentRun(cap)
      try { offered = Boolean(await abilities?.offerConnect(abilityActor(cap), extras, failure)) }
      catch { log.warn('offer connect failed', { key: purpose }) }
      assertCurrentRun(cap)
    }
    const next = needsConnection ? offered
      ? '授权卡已经发到他的私聊，点「打开授权页面」完成即可。'
      : '这次没有取得授权卡的送达回执；可以在私聊请求连接账号。' : ''
    throw new ApiError(failure.next === 'retry' ? 503 : 403, `${purpose}：${accessFailureText(failure)}${next}`, failure)
  }

  function accessTokenRejection(cap: RequestCapability, token: string | undefined, assertCurrent: () => void): () => void {
    const openId = cap.requesterOpenId, before = openId ? userTokens?.get(openId) : undefined
    return () => {
      assertCurrent()
      if (openId && before && before.accessToken === token) userTokens?.expireAccessToken(openId, before)
    }
  }

  async function requirePersonalConnection(cap: RequestCapability, purpose: string, extras?: readonly UserScopeExtra[],
    failure: AccessFailure = accessFailure('not_connected', { identity: 'user' })): Promise<never> {
    return readAccessFailure(cap, failure, purpose, extras)
  }

  /** A provider scope is necessary, but never evidence that a particular resource is accessible. */
  async function personalScope(cap: RequestCapability, tier: 'calendar' | 'watch', capability: CapabilityScope, purpose: string) {
    // A first connection still waits for the scopes needed by this exact operation;
    // merely acquiring some unrelated core scopes must not wake the request.
    const forUnconnectedOperation = (failure: AccessFailure): AccessFailure => failure.next === 'connect' || failure.next === 'grant_scope'
      ? { ...failure, scopes: [...new Set([...(failure.scopes ?? []), ...USER_SCOPE_TIERS[tier]])] } : failure
    const assertHost = () => {
      need(cap, capability)
      if (cap.chatType !== 'p2p' || !cap.requesterOpenId || cap.spaceId !== dmSpaceId(cap.requesterOpenId) ||
        spaces.roleOf(cap.spaceId, cap.requesterOpenId) !== 'owner') throw new ApiError(403, `${purpose}只允许本人在自己的私聊里使用`)
      if (policy.decide({ spaceId: cap.spaceId, openId: cap.requesterOpenId, action: 'read' }).decision !== 'allow') throw new ApiError(403, '当前空间不允许读取个人资料')
      if (!deps.resolveActorForSession) throw new ApiError(503, '本次个人读取的运行核验尚未就绪')
    }
    assertHost()
    const openId = cap.requesterOpenId!, before = userTokens?.get(openId)
    let access
    try { access = await userTokens?.accessTokenResult(openId) }
    catch (error) { assertHost(); const failure = providerAccessFailure(error, 'user'); if (failure) return readAccessFailure(cap, forUnconnectedOperation(failure), purpose, [tier]); throw error }
    assertHost()
    if (!access || access.status === 'denied') {
      if (JSON.stringify(userTokens?.get(openId)) !== JSON.stringify(before)) throw new ApiError(403, '个人授权已变化，请重新发起')
      if (access?.status === 'denied' && access.reason === 'invalid_grant' && before) deps.disconnectPersonalConnection?.(openId, before)
      try { await requirePersonalConnection(cap, purpose, [tier], forUnconnectedOperation(access ? tokenAccessFailure(access) : accessFailure('not_connected', { identity: 'user' }))) }
      finally { assertHost() }
    }
    if (!access || access.status !== 'available') return readAccessFailure(cap, forUnconnectedOperation(access ? tokenAccessFailure(access) : accessFailure('not_connected', { identity: 'user' })), purpose, [tier])
    const lease = access
    const assertGrant = () => { assertHost(); if (!lease.isCurrent()) throw new ApiError(403, '个人授权已撤销或更新，请重新发起') }
    const missing = () => {
      const granted = new Set((userTokens?.get(openId)?.scope ?? '').split(/[\s,]+/))
      return USER_SCOPE_TIERS[tier].filter(scope => !granted.has(scope))
    }
    assertGrant()
    if (missing().length) {
      try { await requirePersonalConnection(cap, `${purpose}（本次缺少 ${missing().join('、')}）`, [tier], accessFailure('personal_scope_missing', { identity: 'user', scopes: missing() })) }
      finally { assertGrant() }
    }
    const assertCurrent = () => { assertGrant(); if (missing().length) throw new ApiError(403, '本次所需的个人授权范围已变化，请重新发起') }
    assertCurrent()
    personalScopeGuards.set(cap, assertCurrent)
    readFailureGuards.set(cap, { identity: 'user', assertCurrent, purpose, extras: [tier], expireAccessToken: accessTokenRejection(cap, lease.accessToken, assertCurrent) })
    return { as: { userToken: lease.accessToken }, assertCurrent }
  }

  /** Minutes never fall back to tenant identity. One current grant covers the entire read,
   * including every search page and the source receipt, and is never returned to the model. */
  async function personalMinutes(cap: RequestCapability, operations: readonly (keyof typeof MINUTES_SCOPES)[]) {
    const assertHost = () => {
      need(cap, 'chat:read')
      if (cap.chatType !== 'p2p' || !cap.requesterOpenId || cap.spaceId !== dmSpaceId(cap.requesterOpenId) ||
        spaces.roleOf(cap.spaceId, cap.requesterOpenId) !== 'owner') throw new ApiError(403, '妙记只允许本人在自己的私聊里读取')
      if (policy.decide({ spaceId: cap.spaceId, openId: cap.requesterOpenId, action: 'read' }).decision !== 'allow') throw new ApiError(403, '当前空间不允许读取妙记')
      if (!deps.resolveActorForSession || !deps.onExternalSourceRead) throw new ApiError(503, '本次妙记读取的运行与来源核验尚未就绪')
      if (!minutes) throw new ApiError(501, '这个部署没有开启妙记')
    }
    assertHost()
    const openId = cap.requesterOpenId!
    const before = userTokens?.get(openId)
    let access
    try { access = await userTokens?.accessTokenResult(openId) }
    catch (error) { assertHost(); const failure = providerAccessFailure(error, 'user'); if (failure) return readAccessFailure(cap, failure, '读妙记', ['minutes']); throw error }
    assertHost()
    if (!access || access.status === 'denied') {
      const current = userTokens?.get(openId)
      if (JSON.stringify(current) !== JSON.stringify(before)) throw new ApiError(403, '个人授权已变化，请重新发起妙记查询')
      if (access?.status === 'denied' && access.reason === 'invalid_grant' && before) deps.disconnectPersonalConnection?.(openId, before)
      try { await requirePersonalConnection(cap, '读妙记', ['minutes'], access ? tokenAccessFailure(access) : undefined) }
      finally { assertHost() }
    }
    if (!access || access.status !== 'available') return readAccessFailure(cap, access ? tokenAccessFailure(access) : accessFailure('not_connected', { identity: 'user' }), '读妙记', ['minutes'])
    const lease = access
    const assertGrant = () => {
      assertHost()
      if (!lease.isCurrent()) throw new ApiError(403, '个人授权已撤销或更新，请重新发起妙记查询')
    }
    const missingScopes = () => {
      const granted = new Set((userTokens?.get(openId)?.scope ?? '').split(/[\s,]+/))
      return operations.map(operation => MINUTES_SCOPES[operation]).filter(scope => !granted.has(scope))
    }
    assertGrant()
    const missing = missingScopes()
    if (missing.length) {
      try { await requirePersonalConnection(cap, `读妙记（本次缺少 ${missing.join('、')}）`, ['minutes'], accessFailure('personal_scope_missing', { identity: 'user', scopes: missing })) }
      finally { assertGrant() }
    }
    const assertCurrent = () => {
      assertGrant()
      const missing = missingScopes()
      if (missing.length) throw new ApiError(403, `本次查询缺少妙记个人权限：${missing.join('、')}。需要补充妙记授权；应用管理员须先开通这些用户权限并发布，不能把未授权解释成没有会议。`)
    }
    assertCurrent()
    minutesReadGuards.set(cap, assertCurrent)
    readFailureGuards.set(cap, { identity: 'user', assertCurrent, purpose: '读妙记', extras: ['minutes'], expireAccessToken: accessTokenRejection(cap, lease.accessToken, assertCurrent) })
    return { client: minutes!, token: lease.accessToken, assertCurrent, record(source: MinutesSource) {
      assertCurrent()
      deps.onExternalSourceRead!(cap.sessionKey, { kind: 'minutes', ref: minutesSourceRef(source), personalOpenId: openId, access: 'user' })
      assertCurrent()
    } }
  }

  async function readMinutes<T>(cap: RequestCapability, assertCurrent: () => void, read: () => Promise<T>): Promise<T> {
    try {
      const result = await read()
      assertCurrent()
      return result
    } catch (error) {
      assertCurrent()
      if (error instanceof ApiError || error instanceof UserMessageReadChanged) throw error
      const failure = providerAccessFailure(error, 'user')
      if (failure) return readAccessFailure(cap, error instanceof MinutesError && ['personal_scope_missing', 'app_scope_missing'].includes(failure.reason)
        ? { ...failure, scopes: [error.requiredScope] } : failure, '读妙记', ['minutes'])
      if (error instanceof MinutesError) throw new ApiError(error.reason === 'invalid_request' ? 400 :
        error.reason === 'scope' || error.reason === 'authentication' ? 403 : 502, error.message)
      throw new ApiError(502, '妙记服务暂时无法完成读取，不能据此判断内容为空')
    }
  }

  function minuteToken(body: Record<string, unknown>): string {
    if (typeof body.minute_token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.minute_token)) throw new ApiError(400, '请提供有效的妙记标识')
    return body.minute_token
  }

  /** 写操作的共同入口（开 PR、推分支、更新 PR 都走它）。写用的是**写白名单**，不是读白名单。 */
  function needRepositoryWrite(cap: RequestCapability, repo: string): void {
    needRepositoryPermission(cap)
    if (!github?.repoWritable(repo)) throw new ApiError(403, `${repo} 只读：它不在可写仓库名单（FRIDAY_GITHUB_WRITE_REPOS）里。读它回答问题没问题，往里写不行。`)
    if (deps.canPublishToRepository && !deps.canPublishToRepository(cap.sessionKey, repo)) throw new ApiError(403, '本轮资料的来源或读取证明不允许向目标仓库发布，写入未执行。需要为原请求重新准备限定来源的执行上下文；重复授权或原样重试不会解除这项限制。')
  }

  /** 反馈编号是全库递增的；每次按编号访问都必须同时校验 token 的空间。 */
  function bugSpaceId(cap: Capability): string {
    if (!cap.spaceId) throw new ApiError(403, '该会话缺少空间授权，请重新开始会话')
    return cap.spaceId
  }

  function requireBug(cap: Capability, id: unknown) {
    const spaceId = bugSpaceId(cap)
    if (!bugs) throw new ApiError(501, '这个部署没有开启 bug 收敛')
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new ApiError(400, '需要有效的反馈编号')
    const bucket = bugs.get(id)
    if (!bucket || bucket.spaceId !== spaceId) throw new ApiError(404, '没有这条反馈，或它不属于当前空间')
    return bucket
  }

  /** HTTP 入口已在读取正文前固定运行实例；后台职责和记忆整理不能借此补问或判答。 */
  function requireQuestionRun(cap: RequestCapability, allowControl = false): string {
    if (!deps.resolveActorForSession) throw new ApiError(503, '本次执行的问题处理入口尚未就绪')
    if (!cap.boundRunId || !(allowControl ? ['task', 'feedback_control'] : ['task']).includes(cap.boundStage ?? '') || !cap.requesterOpenId?.trim()) throw new ApiError(403, '补问和答复处理只允许当前交互任务调用')
    return cap.boundRunId
  }

  async function stopFeedback(cap: RequestCapability, id: unknown): Promise<FeedbackStopReceipt> {
    need(cap, 'bug:write')
    const bucket = requireBug(cap, id)
    if (!cap.boundRunId || !['task', 'feedback_control'].includes(cap.boundStage ?? '') || !cap.requesterOpenId || !deps.stopFeedback) throw new ApiError(403, '停止跟进需要当前交互任务的控制入口')
    if (routines?.listForFeedback(bucket.id, bugSpaceId(cap)).length) need(cap, 'routine:write')
    try {
      const result = await deps.stopFeedback(cap.sessionKey, cap.boundRunId, bucket.id, cap.scopes.includes('routine:write'))
      // 只有本调用成功提交控制才能更新其绑定；其他在途 HTTP 仍持有旧版本。
      if (result.applied) {
        assertCurrentRun(cap, false)
        const actor = deps.resolveActorForSession?.(cap.sessionKey)
        cap.boundStage = actor?.stage
        cap.boundControlRevision = actor?.controlRevision ?? 0
      }
      return result
    }
    catch (error) { throw new ApiError(409, (error as Error).message) }
  }

  /** 整理会话的授权列表是快照，写入时还要检查候选没有被用户确认或替代。 */
  function requireMemoryCandidate(cap: Capability, id: unknown): void {
    if (cap.memoryWritePolicy === undefined) return
    const ids = cap.memoryWritePolicy?.candidateIds
    if (!cap.spaceId || !Array.isArray(ids) || !ids.every((n) => Number.isSafeInteger(n) && n > 0) || typeof id !== 'number' || !ids.includes(id)) {
      throw new ApiError(403, '整理只能修改本次授权的候选记忆')
    }
    const note = memory.get(id)
    if (!note || note.scope !== hereScope(cap) || note.status !== 'candidate') throw new ApiError(403, '这条记忆已确认、已被替代，或不属于本次整理')
  }

  /**
   * 身份：私聊会话且发起人做过个人授权 → 以本人身份调飞书（能读他所在的所有群、单聊、他有权限的文档）；
   * 否则应用身份（只有机器人在的群）。群会话永远是应用身份——回答对全群可见。
   */
  async function identity(cap: Capability): Promise<AsUser> {
    if (cap.chatType !== 'p2p' || !cap.requesterOpenId || !userTokens) return {}
    const userToken = await userTokens.accessTokenFor(cap.requesterOpenId)
    assertCurrentRun(cap)
    return userToken ? { userToken } : {}
  }

  async function prepareOptionalRead(cap: RequestCapability, scope: CapabilityScope, purpose: string) {
    const assertHost = () => need(cap, scope)
    assertHost()
    const bind = (as: AsUser, assertCurrent: () => void) => {
      readFailureGuards.set(cap, { identity: as.userToken ? 'user' : 'app', assertCurrent, purpose, expireAccessToken: accessTokenRejection(cap, as.userToken, assertCurrent) })
      return { as, assertCurrent }
    }
    if (cap.chatType !== 'p2p' || !cap.requesterOpenId || !userTokens) return bind({}, assertHost)
    const openId = cap.requesterOpenId, before = userTokens.get(openId)
    let access
    try { access = await userTokens.accessTokenResult(openId) }
    catch (error) { assertHost(); const failure = providerAccessFailure(error, 'user'); if (failure) return readAccessFailure(cap, failure, purpose); throw error }
    assertHost()
    if (access.status === 'available') {
      const assertCurrent = () => { assertHost(); if (!access.isCurrent()) throw new ApiError(403, accessFailureText(accessFailure('connection_changed')), accessFailure('connection_changed')) }
      assertCurrent(); return bind({ userToken: access.accessToken }, assertCurrent)
    }
    if (JSON.stringify(userTokens.get(openId)) !== JSON.stringify(before)) return readAccessFailure(cap, accessFailure('connection_changed'), purpose)
    if (access.status === 'denied' && access.reason === 'not_connected' && !before) {
      const assertCurrent = () => { assertHost(); if (userTokens.get(openId)) throw new ApiError(403, accessFailureText(accessFailure('connection_changed')), accessFailure('connection_changed')) }
      return bind({}, assertCurrent)
    }
    if (access.status === 'denied' && access.reason === 'invalid_grant' && before) deps.disconnectPersonalConnection?.(openId, before)
    return readAccessFailure(cap, tokenAccessFailure(access), purpose)
  }

  async function prepareMessageRead(cap: RequestCapability, scope: CapabilityScope): Promise<MessageReadContext> {
    const assertCurrent = () => need(cap, scope)
    const withBindings = (read: MessageReadContext): MessageReadContext => {
      const bindings = new MessageSourceBindings(spaces,
        read.user?.capture.status === 'ready' ? read.user.capture.groups.map(chat => chat.chatId) : [], chatId => {
          // Exclusions govern this person's private cross-conversation reads,
          // not application-identity group work or unrelated directory entries.
          if (readScope && cap.chatType === 'p2p' && cap.requesterOpenId && chatId !== cap.chatId &&
            !readScope.isReadable(cap.requesterOpenId, chatId)) {
            throw new ApiError(403, '这个来源会话已被你停读，本次读取未完成；需要时可让 Friday 恢复读取。')
          }
        })
      const assertCurrent = () => { read.assertCurrent(); bindings.assertCurrent() }
      readFailureGuards.set(cap, { identity: read.as.userToken ? 'user' : 'app', assertCurrent, purpose: '读取会话资料', expireAccessToken: accessTokenRejection(cap, read.as.userToken, assertCurrent) })
      return { ...read, appId: deps.appId, bindings, assertCurrent }
    }
    assertCurrent()
    if (cap.chatType !== 'p2p' || !cap.requesterOpenId || !messageReads) return withBindings({ as: {}, assertCurrent })
    const access = await messageReads.open(cap.requesterOpenId, assertCurrent)
    access.status === 'available' ? access.lease.assertCurrent() : access.assertCurrent()
    if (access.status === 'available') return withBindings({ as: access.lease.as, user: access.lease, assertCurrent: access.lease.assertCurrent })
    if (access.status === 'denied' && (access.reason === 'invalid_grant' || access.reason === 'identity_mismatch')) {
      const grant = userTokens!.get(cap.requesterOpenId)
      if (grant) deps.disconnectPersonalConnection?.(cap.requesterOpenId, grant)
    }
    // An absent personal connection can use the separately authorized bot path. A failed connection cannot.
    if (access.status === 'denied' && access.reason === 'not_connected') return withBindings({ as: {}, assertCurrent: access.assertCurrent })
    if (access.status === 'unavailable' && access.failure?.reason === 'access_token_expired') {
      const before = userTokens?.get(cap.requesterOpenId)
      access.assertCurrent()
      if (before) userTokens?.expireAccessToken(cap.requesterOpenId, before)
    }
    return readAccessFailure(cap, access.status === 'denied'
      ? accessFailure(access.reason === 'invalid_grant' ? 'grant_invalid' : access.reason === 'identity_mismatch' ? 'identity_mismatch' : 'not_connected', { identity: 'user' })
      : access.failure ?? accessFailure(access.reason === 'authorization_changed' ? 'connection_changed' : 'resource_unverified', { identity: 'user' }), '读取会话资料')
  }

  async function finishMessageRead<T extends HistoryMessage>(cap: RequestCapability, read: MessageReadContext, items: readonly T[],
    coverage: 'complete' | 'partial' | 'unknown', fetchedMessages?: readonly HistoryMessage[]) {
    read.assertCurrent()
    for (const item of items) if (item.chatId) read.bindings?.use(item.chatId)
    if (cap.boundRunId && deps.onMessageRead) deps.onMessageRead(cap.sessionKey, cap.boundRunId,
      captureMessageRead(read, items, coverage, chatId => read.bindings?.spaceId(chatId), Date.now()))
    const presented = await prepareMessageReadPresentation(items, { feishu, cache: messageCache, as: read.as,
      domain: deps.feishuDomain, assertCurrent: read.assertCurrent, fetchedMessages })
    read.assertCurrent()
    return presented
  }

  /**
   * 「张三」→ open_id。先查身份表（人员名册），再查这个人所在群的成员名单；一个名字对上不止一个人就说不清，绝不按感觉挑。
   * 昵称（「老沈」）不在任何名单里，就是找不到——让模型去问本人或用 friday_whois，不猜。
   */
  async function resolvePersonOpenIds(name: string, cap: RequestCapability): Promise<{ kind: 'resolved'; openId: string } | { kind: 'ambiguous'; names: string[] } | { kind: 'unknown' }> {
    const wanted = name.trim()
    const hits = new Map<string, string>()
    for (const identity of identities?.byName(wanted) ?? []) if (identity.openId) hits.set(identity.openId, identity.displayName)
    if (!hits.size && cap.chatType === 'group') {
      for (const member of await feishu.chatMembers(cap.chatId).catch(() => [])) if (member.name === wanted) hits.set(member.openId, member.name)
    }
    if (!hits.size) {
      // Friday 自己在的群里翻一遍成员；本人授权读的群不在这里列，避免为了找名字去碰别的群
      const chats = await feishu.listChats().catch(() => [])
      for (const chat of chats.slice(0, 30)) {
        assertCurrentRun(cap)
        for (const member of await feishu.chatMembers(chat.chatId).catch(() => [])) if (member.name === wanted) hits.set(member.openId, member.name)
        if (hits.size > 1) break
      }
    }
    if (hits.size === 1) return { kind: 'resolved', openId: [...hits.keys()][0]! }
    if (hits.size > 1) return { kind: 'ambiguous', names: [...hits.values()] }
    return { kind: 'unknown' }
  }

  async function visibleChats(cap: RequestCapability) {
    need(cap, 'chats:list')
    const read = await prepareMessageRead(cap, 'chats:list')
    const chats = (await allowedChats(cap, read.as, read)).map(c => ({ chat_id: c.chatId, name: c.name, cached_messages: messageCache.count(c.chatId) }))
    read.assertCurrent()
    if (cap.boundRunId && deps.onMessageRead) deps.onMessageRead(cap.sessionKey, cap.boundRunId,
      captureChatDirectory(read, chats, Date.now()))
    return { chats, current_chat_id: cap.chatId, identity: read.as.userToken ? 'user' : 'bot', complete: read.groupsComplete ?? true }
  }

  /** 群会话能读的群：本群 + 同联盟的群（没有联盟就只有本群）。 */
  async function groupChats(cap: Capability): Promise<ChatInfo[]> {
    const ids = [cap.chatId, ...(circles?.mates(cap.chatId) ?? [])]
    const out: ChatInfo[] = []
    for (const chatId of ids) {
      assertCurrentRun(cap)
      out.push({ chatId, name: await feishu.chatName(chatId).catch(() => chatId) })
    }
    assertCurrentRun(cap)
    return out
  }

  /** 这个会话可以读哪些群。 */
  /**
   * 模型可见的会话 = 本人确实在的，**减去他明确停读的那些**。
   *
   * 默认全开：连接之后立刻能用，跨群搜索也是全量的。想收窄就逐个停读，停一个只停这一个。
   * 本会话自己永远可读。
   */
  function filterReadable(cap: Capability, chats: ChatInfo[]): ChatInfo[] {
    const openId = cap.requesterOpenId
    if (!readScope || cap.chatType !== 'p2p' || !openId) return chats
    return chats.filter((c) => c.chatId === cap.chatId || readScope.isReadable(openId, c.chatId))
  }

  /** 本人身份下**确实在**的会话（未经停读过滤）。只给宿主渲染范围卡片用，不直接交给模型。 */
  async function userChatsRaw(cap: Capability, as?: AsUser, read?: MessageReadContext): Promise<ChatInfo[]> {
    if (cap.chatType === 'group' || !cap.scopes.includes('chat:read-others')) return groupChats(cap)
    if (!cap.requesterOpenId) return []
    const id = as ?? (await identity(cap))
    if (id.userToken) {
      if (read?.user) {
        read.assertCurrent()
        if (read.user.capture.status === 'ready') {
          read.groupsComplete = read.user.capture.groupsComplete
          return [...read.user.capture.groups]
        }
        if (read.user.capture.status === 'unavailable' && read.user.capture.reason === 'chat_list_unavailable') {
          return readAccessFailure(cap, read.user.capture.failure ?? accessFailure('resource_unverified', { identity: 'user' }), '读取群列表')
        }
        const result = await feishu.listChatsResult(id, { fresh: true, assertCurrent: read.assertCurrent })
        read.assertCurrent()
        read.groupsComplete = result.complete
        return result.items
      }
      const chats = await feishu.listChats(id, { assertCurrent: () => assertCurrentRun(cap) })
      assertCurrentRun(cap)
      return chats
    } // 本人身份：所在的所有群，天然就是"他能看的"
    const all = await feishu.listChats({}, { assertCurrent: () => assertCurrentRun(cap) })
    assertCurrentRun(cap)
    const out: ChatInfo[] = []
    for (const c of all.slice(0, 80)) {
      try {
        const members = await feishu.chatMemberOpenIds(c.chatId, { assertCurrent: () => assertCurrentRun(cap) })
        assertCurrentRun(cap)
        if (members.has(cap.requesterOpenId)) out.push(c)
      } catch (err) {
        assertCurrentRun(cap)
        log.debug('member check failed', { chatId: c.chatId, err: String(err) })
      }
    }
    return out
  }

  async function allowedChats(cap: Capability, as?: AsUser, read?: MessageReadContext): Promise<ChatInfo[]> {
    return filterReadable(cap, await userChatsRaw(cap, as, read))
  }

  /** 解析 body.chat（id 或名字）为一个允许读取的群；指定越界目标明确拒绝。 */
  async function resolveChat(cap: Capability, ref: unknown, as?: AsUser, read?: MessageReadContext): Promise<ChatInfo> {
    if ((cap.chatType === 'group' || !cap.scopes.includes('chat:read-others')) && !circles?.mates(cap.chatId).length) {
      const name = await feishu.chatName(cap.chatId)
      assertCurrentRun(cap)
      if (typeof ref === 'string' && ref.trim() && ref !== cap.chatId && ref !== name) throw new ApiError(403, '该会话只能读取本群')
      read?.bindings?.use(cap.chatId)
      return { chatId: cap.chatId, name }
    }
    const visible = await userChatsRaw(cap, as, read)
    const candidates = filterReadable(cap, visible)
    read?.assertCurrent()
    assertCurrentRun(cap)
    const fallback = candidates.find((c) => c.chatId === cap.chatId)
    const resolved = MessageService.resolveChat(typeof ref === 'string' ? ref : undefined, candidates, fallback)
    if (!resolved) {
      // Keep the named recovery route for a known group before trying the DM fallback.
      const stopped = candidates.length === visible.length ? undefined
        : MessageService.resolveChat(typeof ref === 'string' ? ref : undefined, visible.filter((c) => !candidates.some((k) => k.chatId === c.chatId)), undefined)
      if (stopped) throw new ApiError(403, `「${stopped.name ?? stopped.chatId}」你之前让我停读了。跟我说一声就能恢复；恢复后我会从上次读到的位置接着读。`)
      // Human DMs are absent from Feishu's group directory. Verify a concrete DM using
      // this request's current personal grant, never a shared message cache or bot identity.
      const chatId = typeof ref === 'string' ? ref.trim() : ''
      if (cap.chatType === 'p2p' && cap.scopes.includes('chat:read-others') && cap.requesterOpenId &&
        as?.userToken && read?.user && /^oc_[a-z0-9_]+$/i.test(chatId)) {
        read.bindings?.use(chatId)
        const hits = await feishu.findMessagesAsUser(as.userToken, { chatIds: [chatId], chatType: 'p2p', limit: 1 }, read.assertCurrent)
        read.assertCurrent()
        if (hits.some(hit => hit.chatId === chatId && hit.isP2p === true && hit.messageId)) {
          onCrossSpaceRead?.(cap.sessionKey, { chatId, name: '私聊', what: '私聊内容' })
          return { chatId, name: '私聊' }
        }
      }
      if (read?.groupsComplete === false) throw new ApiError(503, '群列表还未读取完整，暂时无法确认这个群。')
      throw new ApiError(404, `找不到群「${String(ref ?? '')}」，或你不在这个群里。可用 feishu_list_chats 查看可读的群。`)
    }
    // 读的是别的会话 → 记一笔，回答末尾会披露出处
    if (resolved.chatId !== cap.chatId) onCrossSpaceRead?.(cap.sessionKey, { chatId: resolved.chatId, name: resolved.name, what: '群聊内容' })
    read?.bindings?.use(resolved.chatId)
    return resolved
  }

  function recordReturnedChats(cap: Capability, items: readonly { chatId?: string }[], what: string): void {
    assertCurrentRun(cap)
    for (const chatId of new Set(items.map((m) => m.chatId).filter((id): id is string => Boolean(id && id !== cap.chatId)))) {
      onCrossSpaceRead?.(cap.sessionKey, { chatId, name: chatId, what })
    }
  }

  function timeRange(body: Record<string, unknown>, defaultHours: number): { startSec: number; endSec: number } {
    const nowSec = Math.floor(Date.now() / 1000)
    let startSec = parseTimeSec(body.start_time)
    const endSec = parseTimeSec(body.end_time) ?? nowSec
    if (startSec === undefined) {
      const hours = clampInt(body.hours_back, 1, 24 * 365, defaultHours)
      startSec = endSec - hours * 3600
    }
    if (startSec >= endSec) throw new ApiError(400, 'start_time 必须早于 end_time')
    return { startSec, endSec }
  }

  /**
   * 建单后宿主自己记待拍板（谁负责、优先级、是否重复）；规则见 src/github/issue-triage.ts。
   * 本次新建了 Issue、CODEOWNERS 唯一命中且发起人没指定负责人时，先在 GitHub 上指派（assignIssue：同一写门、账本 action='assigned'、写后回读），
   * 没写成就照旧记“谁负责”；同标题已有 Issue 只补评论时不指派，只记建议。除此之外不写 GitHub。
   * 记在谁名下：发起人是部署管理员就记给他本人；否则记给管理员名单里的第一位；没配管理员时记给发起人。
   * 读取、指派或记录失败不改变已写成的 Issue 结果（回执里照实说）；委托失效照常报错，之后什么都不再写。
   */
  async function withIssueTriage(cap: RequestCapability, r: Awaited<ReturnType<typeof openIssue>>,
    input: { spaceId: string; paths: string[]; duplicateCandidates: number[]; assertAuthorized: () => void; requestKey: string; requestedAssignees: readonly string[] }) {
    const requester = cap.requesterOpenId?.trim() || undefined, firstAdmin = policy.adminOpenIds()[0]
    const decider = requester && policy.isAdmin(requester) ? { openId: requester, role: 'requester' as const }
      : firstAdmin ? { openId: firstAdmin, role: 'admin' as const }
        : requester ? { openId: requester, role: 'requester' as const } : undefined
    if (!inbox || !github || !decider) return { ...r, triage: { state: 'unavailable' } satisfies IssueTriageView }
    // 授权重验失败（任何错误类型）照常抛出；只有本地记录本身出错才回执“没记上”
    let authorityLost = false
    const assertCurrent = () => { try { input.assertAuthorized() } catch (error) { authorityLost = true; throw error } }
    // 只指派本次新建的 Issue：同标题已有 Issue（可能是人开的）只补评论时不指派。
    // 发起人明说了负责人（哪怕 GitHub 没让它生效）时不按 CODEOWNERS 改派，只记建议。
    let assignment: IssueAssignmentOutcome | undefined
    const assign = issueLinks && r.action === 'created' && !input.requestedAssignees.length ? async (login: string) => {
      assignment = await assignIssue(github, issueLinks, { repo: r.repo, number: r.number, url: r.url, login, assertAuthorized: assertCurrent,
        requestKey: githubRequestKey(cap, { kind: 'assign', repo: r.repo, number: r.number, login: login.toLowerCase(), request: input.requestKey }),
        captureOrigin: issueOriginCapture(cap, r.repo, assertCurrent) })
      log.info('github issue assignment', { repo: r.repo, number: r.number, login, state: assignment.state, by: cap.requesterOpenId })
      return assignment
    } : undefined
    try {
      const outcome = await recordIssueTriage({
        db: registry.db, inbox, github, identities, refreshIdentities: deps.refreshIdentities,
        groupMembers: async () => { try { return await feishu.chatMembers(cap.chatId) } catch { return [] } },
        deciderName: async () => { try { return await feishu.userName(decider.openId) } catch { return undefined } },
        assertCurrent, now: () => Date.now(), assign,
      }, { repo: r.repo, issue: r, spaceId: input.spaceId, chatType: cap.chatType, decider, paths: input.paths, duplicateCandidates: input.duplicateCandidates })
      if (outcome.readRepository) recordRepositoryRead(cap.sessionKey, r.repo)
      return { ...r, ...(outcome.assignees ? { assignees: outcome.assignees } : {}), pending: outcome.pending, triage: outcome.view }
    } catch (error) {
      if (authorityLost || error instanceof ApiError || error instanceof RequestEndedError) throw error
      log.warn('issue triage not recorded', { repo: r.repo, number: r.number, error: error instanceof Error ? error.message : String(error) })
      const done: IssueAssignmentOutcome | undefined = assignment
      return { ...r, ...(done && 'assignees' in done && done.assignees ? { assignees: done.assignees } : {}),
        triage: { state: 'failed', ...(done ? { assignment: done } : {}) } satisfies IssueTriageView }
    }
  }

  /** 能力入口和待办路由共用同一个 actor，别在两处各拼一遍。 */
  /**
   * 这几个文件归谁管：仓库的 CODEOWNERS → GitHub 账号 → 飞书 open_id。
   *
   * 中间那一跳靠成员对照表（`identities`）：CODEOWNERS 里写的是 GitHub 账号，
   * 而群里要 @ 的是飞书的人。对不上就只回 login——**宁可说"这块归 alice"，
   * 也不要因为对不上就一个字都不说**，那等于 PR 开出去没人知道该看。
   */
  async function moduleOwners(repo: string, files: readonly string[]): Promise<{ login: string; openId?: string; name?: string }[]> {
    if (!github || !files.length) return []
    const owner = repo.split('/')[0]
    let text: string | undefined
    for (const path of CODEOWNERS_PATHS) {
      try {
        const res = await github.api<{ content?: string; encoding?: string }>('GET', `/repos/${repo}/contents/${path}`, undefined, owner)
        if (typeof res?.content === 'string') { text = Buffer.from(res.content, 'base64').toString('utf8'); break }
      } catch { /* 这个位置没有就试下一个 */ }
    }
    // 大多数仓库没有 CODEOWNERS。
    // 只认 CODEOWNERS 的话，这个功能在真实仓库上等于不存在：PR 开出去照样没人知道该看。
    // 退一步用**最近动过这些文件的人**。这是推断不是声明，所以来源要跟着一起给出去。
    const found = text
      ? ownersFor(parseCodeowners(text), files).map((login) => ({ login, from: 'codeowners' as const }))
      : (await recentAuthors(repo, files)).map((login) => ({ login, from: 'recent-commits' as const }))
    return found.map(({ login, from }) => {
      // 团队（org/team）没法映射到某个人，照原样给出去，由人自己认领
      const person = login.includes('/') ? undefined : identities?.byLogin(login)
      return { login, from, ...(person?.openId ? { openId: person.openId } : {}), ...(person?.displayName ? { name: person.displayName } : {}) }
    })
  }

  /**
   * 最近动过这几个文件的人。**这是推断，不是仓库声明的负责人**，所以调用方必须把来源说出来。
   *
   * 只看前几个文件、每个只看最近几条提交：一个 PR 改二十个文件的话挨个查会打出几十个请求，
   * 而前几个文件通常已经足够指出这是哪一块。机器人的提交跳过——
   * 把 Friday 自己上次的提交认成"负责人"是个自指的笑话。
   */
  async function recentAuthors(repo: string, files: readonly string[]): Promise<string[]> {
    if (!github) return []
    const owner = repo.split('/')[0]
    const seen = new Map<string, number>()
    for (const file of files.slice(0, 3)) {
      try {
        const commits = await github.api<{ author?: { login?: string; type?: string } }[]>(
          'GET', `/repos/${repo}/commits?path=${encodeURIComponent(file)}&per_page=5`, undefined, owner)
        if (!Array.isArray(commits)) continue
        for (const c of commits) {
          const login = c?.author?.login
          if (!login || c.author?.type === 'Bot' || login.endsWith('[bot]')) continue
          seen.set(login, (seen.get(login) ?? 0) + 1)
        }
      } catch { /* 某个文件查不到不影响其余 */ }
    }
    // 动得最多的排前面：一个 PR 只该惊动一两个人
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([login]) => login)
  }

  const abilityActor = (cap: RequestCapability): AbilityActor =>
    ({ runId: cap.boundRunId, sessionKey: cap.sessionKey, chatId: cap.chatId, chatType: cap.chatType, spaceId: cap.spaceId, requesterOpenId: cap.requesterOpenId })

  async function resolveWatchChats(cap: RequestCapability, raw: unknown) {
    const watchChatIds: string[] = []
    let assertWatch: () => void
    const refs = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : []
    if (refs.length > 10) throw new ApiError(400, '一次最多关注 10 个群')
    if (!refs.length) throw new ApiError(400, '关注群聊需要 chats（群名或 chat_id 列表）')
    if (cap.chatType === 'group') {
      // An existing local group watch uses app identity and can only target this group.
      // Circle membership and a requester's personal grant do not widen that audience.
      assertWatch = () => {
        needDerivedWrite(cap, 'routine:write')
        if (!cap.requesterOpenId || policy.decide({ spaceId: spaceIdOf(cap), openId: cap.requesterOpenId, action: 'read' }).decision !== 'allow') throw new ApiError(403, '当前身份不能关注本群')
      }
      assertWatch()
      const name = await feishu.chatName(cap.chatId)
      assertWatch()
      if (refs.some(ref => ref.trim() !== cap.chatId && ref.trim() !== name)) throw new ApiError(403, '群内关注只能使用机器人身份读取本群；代盯其他群请在私聊发起。')
      watchChatIds.push(cap.chatId)
    } else {
      const access = await personalScope(cap, 'watch', 'routine:write', '关注群聊')
      assertWatch = () => { access.assertCurrent(); needDerivedWrite(cap, 'routine:write') }
      assertWatch()
      let directory
      try { directory = await feishu.listChatsResult(access.as, { fresh: true, assertCurrent: assertWatch }) }
      catch (error) {
        assertWatch()
        throw error
      }
      assertWatch()
      const readable = filterReadable(cap, directory.items)
      for (const ref of refs) {
        const chat = MessageService.resolveChat(ref, readable, undefined)
        if (!chat) {
          if (MessageService.resolveChat(ref, directory.items, undefined)) throw new ApiError(403, '这个会话已停读，需要先由你恢复读取。')
          throw new ApiError(directory.complete ? 404 : 503, directory.complete ? '未能确认你在这个群里，没有创建巡检。' : '会话列表尚未读取完整，暂时无法确认目标群。')
        }
        watchChatIds.push(chat.chatId)
      }
    }

    assertWatch()
    return { chatIds: [...new Set(watchChatIds)], assertCurrent: assertWatch }
  }

  const routes: Record<string, Handler> = {
    ...createPersonalMcpRoutes<RequestCapability>({ connections: deps.personalMcp,
      requireRun: (cap, invoke) => {
        const assertCurrent = () => {
          need(cap, invoke ? 'mcp:call' : 'mcp:read')
          if (!cap.boundRunId || cap.boundStage !== 'task' || !cap.requesterOpenId || cap.chatType !== 'p2p' ||
            cap.spaceId !== dmSpaceId(cap.requesterOpenId) || spaces.roleOf(cap.spaceId, cap.requesterOpenId) !== 'owner')
            throw new ApiError(403, '个人 MCP 仅供本人当前任务使用。')
          if (invoke && policy.decide({ spaceId: cap.spaceId, openId: cap.requesterOpenId, action: 'act' }).decision !== 'allow')
            throw new ApiError(403, '当前任务未允许操作外部工具。')
        }
        assertCurrent(); return { owner: cap.requesterOpenId!, runId: cap.boundRunId!, assertCurrent }
      }, operation: cap => {
        if (!deps.personalMcpRunSignal || !cap.boundRunId) throw new ApiError(503, '工具调用的宿主运行入口尚未就绪。')
        return { cap: { ...cap, requestSignal: undefined }, signal: deps.personalMcpRunSignal(cap.sessionKey, cap.boundRunId) }
      }, requestSignal: cap => cap.requestSignal,
      returned: (cap, id) => {
        let ids = personalMcpReturns.get(cap)
        if (!ids) { ids = new Set(); personalMcpReturns.set(cap, ids) }
        ids.add(id)
      },
      capture: async cap => {
        if (!deps.captureEmailDraftSource) throw new ApiError(503, '本次材料来源尚未核实。')
        return deps.captureEmailDraftSource(cap.sessionKey, cap.boundRunId!)
      }, record: (cap, ref) => deps.onExternalSourceRead?.(cap.sessionKey, { kind: 'mcp', personalOpenId: cap.requesterOpenId!, access: 'user', runId: cap.boundRunId!, ref }),
      confirm: async (cap, details) => {
        if (!deps.confirm) throw new ApiError(503, '工具确认入口暂不可用。')
        return deps.confirm({ sessionKey: cap.sessionKey, approver: 'requester', requesterOnly: true, fullDetail: true, signal: details.signal, header: '使用已连接的工具',
          headline: `${details.name} · ${details.tool}`, detail: `服务：${details.url}\n将发送以下参数：\n${details.args}`,
          note: '参数将交给这个服务处理；确认后执行一次。' })
      }, error: (status, message) => new ApiError(status, message) }),
    ...createGmailRoutes<RequestCapability>({ connections: deps.gmail, mailbox: deps.mailbox, drafts: deps.emailDrafts,
      capture: async cap => { if (!deps.captureEmailDraftSource) throw new ApiError(503, '草稿来源检查尚未就绪。'); return deps.captureEmailDraftSource(cap.sessionKey, cap.boundRunId!) },
      consume: (cap, draft) => { if (!deps.consumeEmailDraft) throw new ApiError(503, '草稿来源检查尚未就绪。'); deps.consumeEmailDraft(cap.sessionKey, cap.boundRunId!, draft) },
      requireRun: (cap, write) => {
        const assertCurrent = () => {
          need(cap, write ? 'mail:draft' : 'mail:read')
          if (!cap.boundRunId || cap.boundStage !== 'task' || !cap.requesterOpenId || cap.chatType !== 'p2p' ||
            cap.spaceId !== dmSpaceId(cap.requesterOpenId) || spaces.roleOf(cap.spaceId, cap.requesterOpenId) !== 'owner')
            throw new ApiError(403, '邮件仅在本人私聊的当前任务中使用。')
          if (write) needInteractiveStateWrite(cap, 'mail:draft')
        }
        assertCurrent(); return { owner: cap.requesterOpenId!, assertCurrent }
      }, record: (cap, thread) => {
        const g = deps.gmail!.view(cap.requesterOpenId!)
        deps.onExternalSourceRead?.(cap.sessionKey, { kind: 'gmail', personalOpenId: cap.requesterOpenId!, access: 'user', runId: cap.boundRunId!,
          ref: thread ? deps.mailbox!.source(thread) : `gmail:${g.accountId}:${g.revision}:account` })
      }, showDraft: async (cap, id) => { await deps.showEmailDraft?.(cap.requesterOpenId!, id) }, error: (status, message) => new ApiError(status, message) }),
    ...createMyDayRoutes<RequestCapability>({ get myDay() { return deps.myDay },
      requireRun: cap => {
        const assertCurrent = () => {
          need(cap, 'todo:read'); need(cap, 'calendar:read')
          if (!cap.boundRunId || cap.boundStage !== 'task' || !cap.requesterOpenId || !cap.spaceId || cap.chatType !== 'p2p') {
            throw new ApiError(403, '我的一天只能在本人私聊的当前任务中查看。')
          }
        }
        assertCurrent()
        return { sessionKey: cap.sessionKey, runId: cap.boundRunId!, assertCurrent }
      }, error: (status, message) => new ApiError(status, message),
    }),
    ...createTodoNativeRoutes<RequestCapability>({ todos, taskSync: deps.taskSync,
      requireCurrent: cap => {
        const assertCurrent = () => { needInteractiveStateWrite(cap, 'todo:write') }
        assertCurrent()
        return { audience: todoAudience(cap), assertCurrent }
      }, error: (status, message) => new ApiError(status, message),
    }),
    ...(deps.pollsEnabled ? createPollRoutes<RequestCapability>({ get runtime() { return deps.polls },
      requireRun: (cap, scope) => {
        need(cap, scope)
        if (!cap.boundRunId || cap.boundStage !== 'task' || !cap.requesterOpenId || !cap.spaceId || cap.chatType !== 'group') {
          throw new ApiError(403, '投票操作需要群内当前任务。')
        }
        return { sessionKey: cap.sessionKey, runId: cap.boundRunId }
      }, assertCurrent: cap => assertCurrentRun(cap), error: (status, message) => new ApiError(status, message),
    }) : {}),
    ...(deps.meetingsEnabled ? createMeetingRoutes<RequestCapability>({ get application() { return deps.meetings },
      requireRun: (cap, scope) => {
        need(cap, scope)
        if (!cap.boundRunId || cap.boundStage !== 'task' || !cap.requesterOpenId || !cap.spaceId) throw new ApiError(403, '会议操作需要本人当前任务。')
        if (scope === 'meetings:write' && policy.decide({ spaceId: cap.spaceId, openId: cap.requesterOpenId, action: 'act' }).decision === 'deny') throw new ApiError(403, '本空间未允许会议操作。')
        return { sessionKey: cap.sessionKey, runId: cap.boundRunId }
      }, assertCurrent: cap => assertCurrentRun(cap), error: (status, message) => new ApiError(status, message),
    }) : {}),
    'POST /v1/github/change/wait': async (cap, body) => {
      need(cap, 'github:read')
      if (!github || !changes || !deps.preparations) throw new ApiError(501, '这个部署没有配置可查询的仓库准备')
      const repo = parseRepo(body.repo)
      if (!repo) throw new ApiError(400, '需要 repo（owner/name）')
      const base = typeof body.base === 'string' && body.base.trim() ? body.base.trim() : undefined
      const timeoutMs = body.wait_ms === undefined ? 20_000 : body.wait_ms
      if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 20_000) {
        throw new ApiError(400, '仓库准备每次等待必须在0到20000毫秒之间')
      }
      const query = preparationQuery(cap, repo, base, false)
      const current = changes.preparationForRequest({ ...query, assertAuthorized: query.assertCurrent })
      if (!current) throw new ApiError(404, '当前原请求没有这份仓库准备记录，请保持开始时的仓库与基线参数')
      notePreparationReturn(cap, current.id)
      const callId = callIds.get(cap)
      if (callId) runCalls.reference(callId, { kind: 'github_change_preparation', id: current.id })
      let result
      try { result = await deps.preparations.wait(query, { timeoutMs, signal: cap.requestSignal }) }
      catch (error) { assertCurrentRun(cap); throw error }
      assertCurrentRun(cap)
      if (result.preparation.state === 'prepared') recordRepositoryRead(cap.sessionKey, repo)
      return preparationResponse(cap, result.preparation)
    },
    ...observePreparationUse(createRepositoryFileRoutes<RequestCapability>({ changes,
      requireRun: (cap, write) => {
        const assertAuthorized = () => {
          need(cap, write ? 'github:write' : 'github:read')
          if (!cap.boundRunId || cap.boundStage !== 'task' || !cap.requesterOpenId || !cap.spaceId || !cap.cwd) {
            throw new ApiError(403, '仓库文件操作需要当前任务及其原发起人')
          }
          if (write) needRepositoryPermission(cap)
        }
        assertAuthorized()
        return repositoryIdentity(cap, assertAuthorized)
      },
      authorize: async (cap, access) => {
        const assertCurrent = () => {
          if (access.action === 'write') needRepositoryWrite(cap, access.repo)
          else { need(cap, 'github:read'); if (!github?.repoAllowed(access.repo)) throw new ApiError(403, '仓库不在可读范围内') }
        }
        assertCurrent(); return { assertCurrent }
      },
      recordRead: (cap, repo) => recordRepositoryRead(cap.sessionKey, repo), error: (status, message) => new ApiError(status, message),
    })),
    ...createRepositoryExecutionRoutes<RequestCapability>({ executions: deps.executions, outputs: deps.executionOutputs,
      identity: cap => {
        const identity = repositoryIdentity(cap, () => needRepositoryPermission(cap))
        const actor = deps.resolveActorForSession?.(cap.sessionKey)
        if (!identity.workKey || !identity.requesterOpenId || !actor?.taskId || !cap.boundRunId) throw new ApiError(403, '验证代码需要真实工作和当前执行身份')
        const callId = callIds.get(cap)
        return { ...identity, workKey: identity.workKey, requesterOpenId: identity.requesterOpenId, taskId: actor.taskId, runId: cap.boundRunId,
          onExecution: callId ? (id: string) => runCalls.reference(callId, { kind: 'github_execution', id }) : undefined,
          // Output import writes files: the same gate as the repository file broker's write.
          authorizeFileWrite: async access => {
            const assertCurrent = () => needRepositoryWrite(cap, access.repo)
            assertCurrent(); return { assertCurrent }
          } }
      }, recordRead: (cap, repo) => recordRepositoryRead(cap.sessionKey, repo), error: (status, message) => new ApiError(status, message),
    }),
    'POST /v1/github/pr/checks': async (cap, body) => {
      need(cap, 'github:read')
      if (!github) throw new ApiError(501, '这个部署没有配置 GitHub 身份')
      const repo = parseRepo(body.repo), number = clampInt(body.number, 1, Number.MAX_SAFE_INTEGER, 0)
      if (!repo || !number) throw new ApiError(400, '需要仓库和 PR 编号')
      if (!github.repoAllowed(repo)) throw new ApiError(403, '仓库不在允许范围内')
      try {
        const result = await readPullRequestChecks(github, { repo, number, signal: cap.requestSignal, assertCurrent: () => need(cap, 'github:read') })
        need(cap, 'github:read'); recordRepositoryRead(cap.sessionKey, repo)
        const tracking = !(cap.chatType === 'p2p' && deps.personalGithub) && deps.repositoryCiTracking && cap.boundRunId && cap.boundStage === 'task' && result.open && result.headCurrent
          ? await deps.repositoryCiTracking(cap.sessionKey, cap.boundRunId, { repo, number, head: result.head })
          : { state: 'unavailable' as const, head: result.head }
        need(cap, 'github:read')
        return { ...result, automatic_followup: { ...tracking, note: tracking.state === 'tracking'
          ? '宿主已沿原工作自动跟进此 PR 当前提交，无需另建定时提醒；这不表示检查已通过。'
          : '未核实当前工作对此 PR 提交的有效自动跟进；不能据此承诺自动复查。' } }
      } catch (error) { throw toApiError(error) }
    },
    'POST /v1/github/pr/check-evidence': async (cap, body) => {
      need(cap, 'github:read')
      if (!github) throw new ApiError(501, '这个部署没有配置 GitHub 身份')
      if (Object.keys(body).some(key => !['repo', 'number', 'check_run_id', 'expected_head', 'annotation_page', 'log_start_byte', 'log_max_bytes', 'log_max_lines', 'log_query'].includes(key))) throw new ApiError(400, '检查证据参数不受支持')
      const repo = parseRepo(body.repo), number = body.number, checkRunId = body.check_run_id
      if (!repo || !Number.isSafeInteger(number) || Number(number) < 1 || !Number.isSafeInteger(checkRunId) || Number(checkRunId) < 1 ||
        body.expected_head !== undefined && (typeof body.expected_head !== 'string' || !/^[a-f0-9]{40,64}$/.test(body.expected_head)) ||
        body.annotation_page !== undefined && (!Number.isSafeInteger(body.annotation_page) || Number(body.annotation_page) < 1) ||
        body.log_start_byte !== undefined && (!Number.isSafeInteger(body.log_start_byte) || Number(body.log_start_byte) < 0) ||
        body.log_max_bytes !== undefined && (!Number.isSafeInteger(body.log_max_bytes) || Number(body.log_max_bytes) < 4 || Number(body.log_max_bytes) > 65_536) ||
        body.log_max_lines !== undefined && (!Number.isSafeInteger(body.log_max_lines) || Number(body.log_max_lines) < 1 || Number(body.log_max_lines) > 500) ||
        body.log_query !== undefined && (typeof body.log_query !== 'string' || !body.log_query.trim() || body.log_query.length > 512)) throw new ApiError(400, '需要有效仓库、PR、检查编号和日志窗口')
      if (!github.repoAllowed(repo)) throw new ApiError(403, '仓库不在允许范围内')
      try {
        const result = await readPullRequestCheckEvidence(github, { repo, number: Number(number), checkRunId: Number(checkRunId),
          expectedHead: body.expected_head as string | undefined, annotationPage: body.annotation_page as number | undefined,
          logStartByte: body.log_start_byte as number | undefined, logMaxBytes: body.log_max_bytes as number | undefined,
          logMaxLines: body.log_max_lines as number | undefined,
          logQuery: body.log_query as string | undefined,
          signal: cap.requestSignal, assertCurrent: () => need(cap, 'github:read') })
        need(cap, 'github:read'); recordRepositoryRead(cap.sessionKey, repo)
        return result
      } catch (error) {
        if (error instanceof PullRequestCheckEvidenceError) throw new ApiError(error.code === 'invalid_input' ? 400 :
          error.code === 'repository_denied' ? 403 : error.code === 'invalid_response' ? 502 : 409, error.message)
        throw toApiError(error)
      }
    },
    ...createMaterialRoutes<RequestCapability>({ get application() { return deps.materials },
      requireRun: (cap, scope) => {
        need(cap, scope)
        if (!cap.boundRunId) throw new ApiError(403, '文件操作缺少当前执行身份。')
        return cap.boundRunId
      },
      assertCurrent: cap => assertCurrentRun(cap), error: (status, message) => new ApiError(status, message),
    }),
    // 接单评估：assess/get（P3-3a）与 execute（P3-3b）。execute 只把已由本人在确认卡上批准的评估交给原工作；批准只来自宿主记录的卡片点击。
    ...createIssueAssessmentRoutes<RequestCapability>({ get runtime() { return deps.issueAssessment }, operations: ['assess', 'get', 'execute'],
      requireActor: cap => {
        need(cap, 'github:read')
        if (!github) throw new ApiError(501, '这个部署没有配置 GitHub')
        if (cap.chatType !== 'group') throw new ApiError(400, '接单评估只在群里做——仓库绑定与结论的受众都在群里')
        const actor = deps.resolveActorForSession?.(cap.sessionKey)
        if (!cap.boundRunId || cap.boundStage !== 'task' || !cap.requesterOpenId || !cap.spaceId || !actor?.taskId || actor.taskId < 1 || actor.runId !== cap.boundRunId) {
          throw new ApiError(403, '接单评估只能由当前真人任务发起')
        }
        return { sessionKey: cap.sessionKey, runId: cap.boundRunId, taskId: actor.taskId, actorOpenId: cap.requesterOpenId, spaceId: cap.spaceId }
      },
      assertCurrent: cap => assertCurrentRun(cap), error: (status, message) => new ApiError(status, message),
    }),
    ...createGitHubIssueFollowupRoutes<RequestCapability>({ control: deps.repositoryIssueFollowup,
      requireRun: cap => {
        need(cap, 'github:write')
        if (!cap.boundRunId || cap.boundStage !== 'task' || !cap.requesterOpenId || !cap.spaceId) throw new ApiError(403, 'Issue 跟进只能由当前真人工作控制')
        return { sessionKey: cap.sessionKey, runId: cap.boundRunId }
      }, error: (status, message) => new ApiError(status, message),
    }),
    ...createGitHubCiRoutes<RequestCapability>({ control: deps.repositoryCiControl,
      requireRun: cap => {
        need(cap, 'github:write')
        if (!cap.boundRunId || cap.boundStage !== 'task' || !cap.requesterOpenId || !cap.spaceId) throw new ApiError(403, 'CI 跟进只能由当前真人工作控制')
        return { sessionKey: cap.sessionKey, runId: cap.boundRunId }
      },
      authorize: (cap, changeId, action) => {
        need(cap, 'github:write')
        if (action === 'stop') return // Revocation carries no repository content or new external effect.
        const publication = changes?.confirmedPublication(changeId)
        if (!publication) throw new ApiError(409, '这个修改尚无已确认的 PR 提交')
        needRepositoryWrite(cap, publication.repo)
      }, error: (status, message) => new ApiError(status, message),
    }),
    'POST /v1/project/page': async (cap, body) => {
      const view = await routes['POST /v1/project/view']!(cap, body) as ProjectView
      requireProjectReader(cap)
      const granted = spaces.get(cap.spaceId!)?.config.projectRepos ?? []
      if (view.repositories.some((item) => !granted.includes(item.repo) || !github?.repoAllowed(item.repo))) throw new ApiError(403, '项目授权已撤销')
      return { html: renderProjectPage(view), snapshot: true }
    },
    'POST /v1/project/repositories': async (cap, body) => {
      requireProjectReader(cap)
      if (!cap.spaceId) throw new ApiError(403, '缺少空间授权')
      const space = spaces.get(cap.spaceId)!
      if (body.repos === undefined) return { repos: space.config.projectRepos ?? [] }
      needConfigure(cap)
      if (!policy.isAdmin(cap.requesterOpenId)) throw new ApiError(403, '只有部署管理员能授权仓库向本空间展示')
      if (!github || !Array.isArray(body.repos) || body.repos.length > 20 || body.repos.some((r) => typeof r !== 'string' || parseRepo(r) !== r.trim().toLowerCase() || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(r.trim()) || ['.', '..'].includes(r.trim().split('/')[1]!) || !github.repoAllowed(r.trim()))) throw new ApiError(400, '需要最多 20 个部署允许的 owner/repo')
      const repos = [...new Set(body.repos.map((r) => String(r).trim().toLowerCase()))]
      spaces.patchConfig(space.id, { projectRepos: repos }, cap.requesterOpenId)
      return { repos }
    },
    'POST /v1/project/view': async (cap, body) => {
      requireProjectReader(cap)
      if (!cap.spaceId || !deps.projects) throw new ApiError(501, '项目视图尚未配置')
      const authorized = (): string[] => {
        requireProjectReader(cap)
        return spaces.get(cap.spaceId!)?.config.projectRepos ?? []
      }
      const granted = authorized()
      const selected = body.repo === undefined ? granted : [parseRepo(body.repo)?.toLowerCase() ?? '']
      if (!selected.length) throw new ApiError(409, '本空间尚未授权项目，请由部署管理员指定仓库')
      if (selected.some((repo) => !granted.includes(repo))) throw new ApiError(403, '项目未授权给本空间')
      if (body.refresh === true) for (const repo of selected) {
        if (!authorized().includes(repo)) throw new ApiError(403, '项目授权已撤销')
        await deps.projects.sync(repo)
      }
      if (selected.some((repo) => !authorized().includes(repo))) throw new ApiError(403, '项目授权已撤销')
      for (const repo of selected) recordRepositoryRead(cap.sessionKey, repo)
      return deps.projects.view(selected, typeof body.assignee === 'string' ? body.assignee : undefined)
    },
    'POST /v1/thread/messages': async (cap, body) => {
      need(cap, 'thread:read')
      const limit = clampInt(body.limit, 1, maxHistoryPerCall, 200)
      const row = registry.getSession(cap.sessionKey)
      const explicit = typeof body.thread_id === 'string' && body.thread_id.trim() ? body.thread_id.trim() : undefined
      if (explicit && (typeof body.chat !== 'string' || !body.chat.trim())) throw new ApiError(400, '指定 thread_id 时也必须指定 chat，以验证话题所属群')
      const read = await prepareMessageRead(cap, 'thread:read'), as = read.as
      const chat = explicit ? await resolveChat(cap, body.chat, as, read) : { chatId: cap.chatId }
      read.bindings?.use(chat.chatId)
      const ownSession = row?.chatId === cap.chatId && row.chatType === cap.chatType && (cap.chatType !== 'p2p' || Boolean(cap.requesterOpenId) && row.requesterOpenId === cap.requesterOpenId)
      const threadId = explicit ?? (ownSession ? row?.threadId : undefined)
      if (!threadId) {
        const root = ownSession && row?.rootMessageId ? await feishu.getMessage(row.rootMessageId, as) : undefined
        read.assertCurrent()
        if (root?.chatId && root.chatId !== cap.chatId) throw new ApiError(403, '消息不属于当前会话')
        const presented = await finishMessageRead(cap, read, root ? [root] : [], 'partial', root ? [root] : [])
        return { chat_id: cap.chatId, thread_id: null, ...presented, has_more: false, coverage_complete: false, note: '当前线程还没有话题 id，只返回触发消息；未读取完整讨论' }
      }
      const known = ownSession && row?.threadId === threadId && chat.chatId === cap.chatId
        || Boolean(registry.db.prepare('SELECT 1 FROM messages WHERE chat_id = ? AND thread_id = ? LIMIT 1').get(chat.chatId, threadId))
      const fetched = await feishu.listThread(threadId, limit + 1, as, read.assertCurrent)
      read.assertCurrent()
      if (fetched.some((m) => m.chatId && m.chatId !== chat.chatId)) throw new ApiError(403, '话题不属于指定的可读群')
      let verified = known || fetched.some((m) => m.chatId === chat.chatId)
      if (!verified && fetched[0]) {
        const anchor = await feishu.getMessage(fetched[0].messageId, as)
        verified = anchor?.chatId === chat.chatId
        read.assertCurrent()
      }
      if (!verified) throw new ApiError(403, '无法验证话题归属；请先读取目标群历史，使用其中的 thread_id')
      const items = fetched.slice(0, limit)
      if (items.some((m) => { const cached = messageCache.get(m.messageId); return cached && cached.chatId !== chat.chatId })) throw new ApiError(403, '话题消息与已知来源不一致')
      messageCache.upsert(chat.chatId, items)
      const returned = items.map((m) => messageCache.get(m.messageId) ?? m)
      const presented = await finishMessageRead(cap, read, returned, fetched.length > limit ? 'partial' : 'complete')
      return { chat_id: chat.chatId, thread_id: threadId, ...presented, has_more: fetched.length > limit, coverage_complete: fetched.length <= limit, note: fetched.length > limit ? '话题已截断，请增加 limit；不能把未读内容视为没有回复' : undefined }
    },

    'POST /v1/chats': visibleChats,

    'POST /v1/chat/history': async (cap, body) => {
      need(cap, 'chat:read')
      const read = await prepareMessageRead(cap, 'chat:read'), as = read.as
      const chat = await resolveChat(cap, body.chat, as, read)
      const limit = clampInt(body.limit, 1, maxHistoryPerCall, 200)
      const { startSec, endSec } = timeRange(body, 72)
      const page = await messages.history(chat.chatId, startSec, endSec, limit, as, read.assertCurrent)
      read.assertCurrent()
      const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : ''
      const items = keyword ? page.items.filter((m) => m.text.includes(keyword) || m.senderName.includes(keyword)) : page.items
      const presented = await finishMessageRead(cap, read, items, !keyword && !page.hasMore && page.coverageComplete ? 'complete' : 'partial')
      // 时间游标只认可完整秒：分页下一页会重读边界秒，关键词过滤不能证明看过整段消息。
      const returnedThrough = page.hasMore ? Math.min(page.nextStartTimeSec ?? startSec, page.coveredUntilSec) : page.coverageComplete ? endSec : startSec
      if (!keyword && returnedThrough > startSec) deps.onChatHistoryRead?.(cap.sessionKey, { chatId: chat.chatId, startSec, endSec: returnedThrough })
      return {
        chat_id: chat.chatId,
        chat_name: chat.name,
        start_time: new Date(startSec * 1000).toISOString(),
        end_time: new Date(endSec * 1000).toISOString(),
        ...presented,
        has_more: page.hasMore,
        next_start_time: page.nextStartTimeSec ? new Date(page.nextStartTimeSec * 1000).toISOString() : null,
        fetched_from_api: page.fetchedFromApi,
        coverage_complete: page.coverageComplete,
        covered_until_time: new Date(page.coveredUntilSec * 1000).toISOString(),
        threads_expanded: false,
        filtered_by_keyword: keyword || null,
      }
    },

    'POST /v1/messages/search': async (cap, body) => {
      need(cap, 'chat:read')
      const { startSec, endSec } = timeRange(body, 24 * 30)
      const limit = clampInt(body.limit, 1, 300, 60)
      const query = typeof body.query === 'string' ? body.query : undefined
      const sender = typeof body.sender === 'string' ? body.sender : undefined
      const msgType = typeof body.msg_type === 'string' ? body.msg_type : undefined
      const read = await prepareMessageRead(cap, 'chat:read'), as = read.as
      if (body.chat !== undefined && body.chat !== null && body.chat !== '') {
        const chat = await resolveChat(cap, body.chat, as, read)
        const r = await messages.search({ chatIds: [chat.chatId], query, sender, msgType, limit, startSec, endSec }, as, read.assertCurrent)
        const presented = await finishMessageRead(cap, read, r.items, 'partial')
        return { chats: [chat], ...presented, fetched_from_api: r.fetchedFromApi, incomplete_chats: r.incompleteChats, scope: `群「${chat.name ?? chat.chatId}」`, complete: r.incompleteChats.length === 0, matches_may_be_truncated: r.items.length >= limit, threads_expanded: false }
      }
      if (cap.chatType === 'group' || !cap.scopes.includes('chat:read-others')) {
        const r = await messages.search({ chatIds: [cap.chatId], query, sender, msgType, limit, startSec, endSec }, as, read.assertCurrent)
        const presented = await finishMessageRead(cap, read, r.items, 'partial')
        return { chats: [{ chatId: cap.chatId }], ...presented, fetched_from_api: r.fetchedFromApi, incomplete_chats: r.incompleteChats, scope: '本群', complete: r.incompleteChats.length === 0, matches_may_be_truncated: r.items.length >= limit, threads_expanded: false }
      }
      // 私聊、未指定群、本人已授权：用飞书自己的消息搜索跨他所在的所有群和单聊。
      // 带关键词走 search:message；只按人 / 只看单聊（「老沈给我发的消息」）走 im.message.search 的 from_ids + chat_type——
      // 单聊没有列表接口，一段单聊只能从消息反查到 chat_id，以前这里没有关键词就走不通，模型只能拿群 id 乱试（09-29，10 分钟没结果）。
      const senderOpenId = typeof body.sender_open_id === 'string' && /^ou_[0-9a-z]+$/i.test(body.sender_open_id.trim()) ? body.sender_open_id.trim() : undefined
      const wantsP2p = body.chat_type === 'p2p'
      if (as.userToken && (query || sender || senderOpenId || wantsP2p)) {
        let fromIds: string[] | undefined
        if (senderOpenId) fromIds = [senderOpenId]
        else if (sender) {
          const resolved = await resolvePersonOpenIds(sender, cap)
          read.assertCurrent()
          if (resolved.kind === 'ambiguous') throw new ApiError(400, `叫「${sender}」的不止一个人（${resolved.names.join('、')}），说清楚是哪位，或者给 open_id`)
          if (resolved.kind === 'unknown') throw new ApiError(404, `没找到叫「${sender}」的人。请用飞书里显示的名字；是昵称就先问本人这是谁，或用 friday_whois 查`)
          fromIds = [resolved.openId]
        }
        const chatType = wantsP2p ? 'p2p' as const : body.chat_type === 'group' ? 'group' as const : undefined
        const ids = fromIds || !query
          ? (await feishu.findMessagesAsUser(as.userToken, { query, startSec, endSec, limit, senderOpenIds: fromIds, chatType }, read.assertCurrent)).map(hit => hit.messageId)
          : await feishu.searchMessageIds(as.userToken, { query, startSec, endSec, limit, chatType: chatType === 'p2p' ? 'p2p_chat' : chatType === 'group' ? 'group_chat' : undefined }, read.assertCurrent)
        read.assertCurrent()
        const items = []
        let failedFetches = 0
        let fetchedCount = 0
        const listedGroups = read.user?.capture.status === 'ready'
          ? new Set(read.user.capture.groups.map(chat => chat.chatId)) : undefined
        // 全局搜索是跨群跨单聊的：停读只在读历史那里生效是挡不住的，命中这里必须同样过一遍
        let stoppedHits = 0
        const readableHere = (chatId: string): boolean =>
          chatId === cap.chatId || !readScope || !cap.requesterOpenId || readScope.isReadable(cap.requesterOpenId, chatId)
        const groupAccessKnown = (chatId: string): boolean => {
          if (!readableHere(chatId)) { stoppedHits += 1; return false }
          return !listedGroups || listedGroups.has(chatId)
            || (body.chat_type !== 'group' && spaces.byChat(chatId, true)?.kind !== 'group')
        }
        for (const id of ids) {
          const cached = messageCache.get(id)
          // A search index can outlive membership. Neither a hit ID nor a cached
          // body proves current access. Partial group lists also cannot authorize
          // an absent group; report that hit as unread, without revoking anything.
          if (cached && !groupAccessKnown(cached.chatId)) {
            failedFetches += 1
            continue
          }
          try {
            if (cached) read.bindings?.use(cached.chatId)
            const m = await feishu.getMessage(id, as)
            read.assertCurrent()
            if (m?.chatId && m.messageId === id && groupAccessKnown(m.chatId)
              && (!cached || cached.chatId === m.chatId)) {
              read.bindings?.use(m.chatId)
              messageCache.upsert(m.chatId, [m])
              // The cache deliberately retains older readable card bodies. A
              // successful current GET authorizes only the snapshot it returned.
              items.push({ ...m, chatId: m.chatId })
              fetchedCount += 1
            } else failedFetches += 1
          } catch (err) {
            read.assertCurrent()
            failedFetches += 1
            log.debug('search hit fetch failed', { id, err: String(err) })
          }
        }
        recordReturnedChats(cap, items, '本人搜索结果')
        const presented = await finishMessageRead(cap, read, items, 'partial', items)
        return { chats: [], ...presented, fetched_from_api: fetchedCount, incomplete_chats: [], scope: '你本人身份 · 飞书全局搜索（含单聊）', complete: failedFetches === 0, matches_may_be_truncated: ids.length >= limit, failed_fetches: failedFetches, threads_expanded: false, note: `${ids.length} 条命中${stoppedHits ? `，其中 ${stoppedHits} 条在你让我停读的会话里（私聊 /groups 可以恢复）` : ''}${failedFetches - stoppedHits > 0 ? `，另有 ${failedFetches - stoppedHits} 条正文未取得，结果不完整` : ''}` }
      }
      // 私聊、未指定群。群不多就老老实实逐个回填后再搜——
      // 「按发言人搜」没有 query，走不了上面的飞书全局搜索，以前这里直接退化成"只翻缓存"，
      // 于是返回一个裸的 0 条，人会当成"真的没有"。
      const chats = await allowedChats(cap, as, read)
      read.assertCurrent()
      const names = chats.map((c) => c.name ?? c.chatId)
      for (const chat of chats) read.bindings?.use(chat.chatId)
      if (chats.length && chats.length <= SEARCH_BACKFILL_MAX_CHATS) {
        const r = await messages.search({ chatIds: chats.map((c) => c.chatId), query, sender, msgType, limit, startSec, endSec }, as, read.assertCurrent)
        recordReturnedChats(cap, r.items, '消息搜索结果')
        const presented = await finishMessageRead(cap, read, r.items, 'partial')
        return {
          chats,
          ...presented,
          fetched_from_api: r.fetchedFromApi,
          incomplete_chats: r.incompleteChats,
          scope: `我能读的 ${chats.length} 个群：${names.join('、')}`,
          complete: r.incompleteChats.length === 0,
          matches_may_be_truncated: r.items.length >= limit,
          threads_expanded: false,
          note: r.incompleteChats.length ? `有 ${r.incompleteChats.length} 个群这段时间没回填完` : undefined,
        }
      }
      const items = messageCache.search({ chatIds: chats.map((c) => c.chatId), query, sender, msgType, limit, startMs: startSec * 1000, endMs: endSec * 1000 })
      recordReturnedChats(cap, items, '消息缓存搜索结果')
      const presented = await finishMessageRead(cap, read, items, 'partial')
      return {
        chats,
        ...presented,
        fetched_from_api: 0,
        incomplete_chats: [],
        scope: `已缓存的消息（${chats.length} 个群）`,
        complete: false,
        matches_may_be_truncated: items.length >= limit,
        threads_expanded: false,
        note: `可读的群有 ${chats.length} 个，太多了不逐个回填，只翻了缓存。指定 chat 再搜一次可触发回填；他在私聊里做过个人授权之后，可搜他所在的全部群和单聊`,
      }
    },

    'POST /v1/messages/files': async (cap, body) => {
      need(cap, 'chat:read')
      const read = await prepareMessageRead(cap, 'chat:read'), as = read.as
      const chat = await resolveChat(cap, body.chat, as, read)
      const { startSec, endSec } = timeRange(body, 24 * 30)
      const coverage = await messages.ensureCoverage(chat.chatId, startSec, endSec, undefined, as, read.assertCurrent)
      read.assertCurrent()
      const limit = clampInt(body.limit, 1, 100, 30)
      const items = messageCache.files([chat.chatId], { sender: typeof body.sender === 'string' ? body.sender : undefined, nameLike: typeof body.name === 'string' ? body.name : undefined, startMs: startSec * 1000, endMs: endSec * 1000, limit })
      const presented = await finishMessageRead(cap, read, items, 'partial')
      return { chat, ...presented, start_time: new Date(startSec * 1000).toISOString(), end_time: new Date(endSec * 1000).toISOString(), coverage_complete: coverage.complete, covered_until_time: new Date((coverage.complete ? endSec : coverage.resumeAtSec ?? startSec) * 1000).toISOString(), matches_may_be_truncated: items.length >= limit, threads_expanded: false }
    },

    'POST /v1/message/file': async (cap, body) => {
      need(cap, 'file:read')
      const messageId = typeof body.message_id === 'string' ? body.message_id : ''
      if (!messageId) throw new ApiError(400, 'message_id 不能为空')
      const read = await prepareMessageRead(cap, 'file:read')
      const allowedIds = new Set((await allowedChats(cap, read.as, read)).map((c) => c.chatId))
      let msg = messageCache.get(messageId)
      if (!msg) {
        const fetched = await feishu.getMessage(messageId, read.as)
        read.assertCurrent()
        if (fetched) {
          // 先验证 API 返回的真实来源，再写缓存；不能把未知来源标成本群后放行。
          if (fetched.messageId !== messageId || !fetched.chatId || !allowedIds.has(fetched.chatId)) throw new ApiError(403, '无法确认这条消息属于当前会话可读的群')
          read.bindings?.use(fetched.chatId)
          messageCache.upsert(fetched.chatId, [fetched])
          msg = messageCache.get(messageId)
        }
      }
      if (!msg) throw new ApiError(404, '找不到这条消息（可能不在缓存里，先用 feishu_search_messages 或 feishu_find_files 找到它）')
      if (!allowedIds.has(msg.chatId)) throw new ApiError(403, '这条消息不在当前会话可读的群里')
      read.bindings?.use(msg.chatId)
      recordReturnedChats(cap, [msg], '附件消息')
      const key = msg.fileKey ?? msg.imageKey
      if (!key) throw new ApiError(400, `这条消息（${msg.msgType}）没有可下载的附件`)
      const type: 'file' | 'image' = msg.imageKey && !msg.fileKey ? 'image' : 'file'
      const managedRun = cap.boundRunId && deps.isManagedRun?.(cap.boundRunId)
      if (managedRun) {
        if (!deps.registerExecutionFile) throw new ApiError(503, '本次执行尚未接入附件读取。')
        const staging = mkdtempSync(join(tmpdir(), 'friday-material-import-'))
        try {
          const downloaded = join(staging, 'content')
          await feishu.downloadMessageResource(messageId, key, type, downloaded, read.as)
          read.assertCurrent()
          if (statSync(downloaded).size > MAX_DOWNLOAD_BYTES) throw new ApiError(413, '附件超过 100 MB')
          const data = readFileSync(downloaded), contentDigest = createHash('sha256').update(data).digest('hex')
          deps.onMessageRead?.(cap.sessionKey, cap.boundRunId!, captureMessageFile(read, msg, contentDigest, Date.now()))
          const file = await deps.registerExecutionFile(cap.boundRunId!, {
            name: sanitizeName(msg.fileName ?? (type === 'image' ? `${messageId}.png` : `${messageId}.bin`)), data,
            operationKey: `message:${messageId}:${contentDigest}`,
          }, read.assertCurrent)
          read.assertCurrent()
          return { ...file, msg_type: msg.msgType, sender: msg.senderName, sent_at: new Date(msg.createTimeMs).toISOString() }
        } finally { rmSync(staging, { recursive: true, force: true }) }
      }
      if (!cap.cwd) throw new ApiError(500, '会话没有工作区，无法保存附件')
      const dir = join(cap.cwd, 'downloads')
      mkdirSync(dir, { recursive: true })
      const name = sanitizeName(msg.fileName ?? (type === 'image' ? `${messageId}.png` : `${messageId}.bin`))
      const dest = join(dir, `${messageId.slice(-8)}-${name}`)
      const staging = mkdtempSync(join(tmpdir(), 'friday-message-file-')), pending = join(dir, `.pending-${randomUUID()}`)
      try {
        const downloaded = join(staging, 'content')
        await feishu.downloadMessageResource(messageId, key, type, downloaded, read.as)
        read.assertCurrent()
        const size = statSync(downloaded).size
        if (size > MAX_DOWNLOAD_BYTES) throw new ApiError(413, '附件超过 100 MB')
        const contentDigest = createHash('sha256').update(readFileSync(downloaded)).digest('hex')
        if (cap.boundRunId && deps.onMessageRead) deps.onMessageRead(cap.sessionKey, cap.boundRunId,
          captureMessageFile(read, msg, contentDigest, Date.now()))
        // Publish only after the original Run/identity/binding survived the download await.
        // Copy supports workspaces on a different mount; rename keeps the visible file complete.
        copyFileSync(downloaded, pending)
        renameSync(pending, dest)
        return { path: dest, bytes: size, file_name: name, msg_type: msg.msgType, sender: msg.senderName, sent_at: new Date(msg.createTimeMs).toISOString() }
      } finally {
        rmSync(staging, { recursive: true, force: true })
        rmSync(pending, { force: true })
      }
    },

    /**
     * 建文档：私聊且有个人授权 → 以本人身份建（文档归本人，在他的"我的空间"）；
     * 否则应用身份建，再把发起人加成 full_access、群会话把整个群加成 edit，最后把链接发回。
     */
    'POST /v1/doc/create': async (cap, body) => {
      needDerivedWrite(cap, 'doc:write')
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      const markdown = typeof body.markdown === 'string' ? body.markdown : ''
      if (!title) throw new ApiError(400, '需要 title')
      if (!markdown.trim()) throw new ApiError(400, '需要 markdown 正文')
      if (markdown.length > 200_000) throw new ApiError(413, '正文太长（>200k 字符）')
      const shareWithChat = cap.chatType === 'group' && body.share_with_chat !== false
      const as = await identity(cap)
      try {
        if (as.userToken) {
          needDerivedWrite(cap, 'doc:write')
          const doc = await feishu.createDocument({ title, markdown }, as)
          needDerivedWrite(cap, 'doc:write')
          return { ...doc, title, owner: 'user', shared: [] }
        }
        needDerivedWrite(cap, 'doc:write')
        const doc = await feishu.createDocument({ title, markdown })
        needDerivedWrite(cap, 'doc:write')
        const shared: string[] = []
        if (cap.requesterOpenId) {
          await feishu.grantDocAccess(doc.documentId, { openId: cap.requesterOpenId }, 'full_access').then(() => shared.push('requester')).catch((err) => log.warn('grant doc access to requester failed', { err: String(err) }))
        }
        needDerivedWrite(cap, 'doc:write')
        if (shareWithChat) {
          await feishu.grantDocAccess(doc.documentId, { chatId: cap.chatId }, 'edit').then(() => shared.push('chat')).catch((err) => log.warn('grant doc access to chat failed', { err: String(err) }))
        }
        needDerivedWrite(cap, 'doc:write')
        return { ...doc, title, owner: 'bot', shared }
      } catch (err) {
        if (err instanceof FeishuApiError && err.isPermission) {
          throw new ApiError(403, `没有创建文档的权限：应用需要开通 docx:document（创建/编辑文档）与 drive:drive（管理协作者）权限并发版；或让他在私聊里完成个人授权，用他自己的身份建。原始错误：${err.message}`)
        }
        throw err
      }
    },

    /**
     * 通用建多维表格：把当前对话里整理出来的东西落成一张表（成员名册、反馈汇总、进度表…）。
     *
     * 受众和 /v1/doc/create 同一套：表由 Friday 建，只共享给发起人和**签发 capability 的那个群**；
     * body 里的 chat_id / open_id / folder_token 一律不读——受众不能由模型指定。
     * 没有个人身份路径：个人授权的 scope 里没有 bitable:app，所以一律应用身份建、再加协作者。
     */
    'POST /v1/table/create': async (cap, body) => {
      needDerivedWrite(cap, 'doc:write')
      if (!bitable) throw new ApiError(501, '这个部署没有开启多维表格')
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (!title) throw new ApiError(400, '需要 title（表格名）')
      const tableName = typeof body.table_name === 'string' && body.table_name.trim() ? body.table_name.trim().slice(0, 100) : title.slice(0, 100)
      const rawFields = Array.isArray(body.fields) ? body.fields : []
      const rawRows = Array.isArray(body.rows) ? body.rows : []
      if (!rawFields.length) throw new ApiError(400, '需要 fields（至少一列）')
      if (rawFields.length > MAX_TABLE_FIELDS) throw new ApiError(413, `列太多（最多 ${MAX_TABLE_FIELDS} 列）`)
      if (rawRows.length > MAX_TABLE_ROWS) throw new ApiError(413, `行太多（最多 ${MAX_TABLE_ROWS} 行）；分批或先汇总`)
      const spec = buildTableSpec(rawFields, rawRows)
      const shareWithChat = cap.chatType === 'group' && body.share_with_chat !== false
      try {
        const base = await bitable.createBase(title.slice(0, 100))
        needDerivedWrite(cap, 'doc:write')
        const tableId = await bitable.ensureTable(base.appToken, tableName, spec.fields)
        needDerivedWrite(cap, 'doc:write')
        if (spec.records.length) {
          await bitable.batchCreate(base.appToken, tableId, spec.records)
          needDerivedWrite(cap, 'doc:write')
        }
        // 建成之后才加协作者：半张表不共享出去，失败的那一步要能从回执看出来。
        const shared: string[] = []
        if (cap.requesterOpenId) {
          await feishu.grantDocAccess(base.appToken, { openId: cap.requesterOpenId }, 'full_access', {}, 'bitable')
            .then(() => { shared.push('requester') })
            .catch((err) => log.warn('grant table access to requester failed', { err: String(err) }))
          needDerivedWrite(cap, 'doc:write')
        }
        if (shareWithChat) {
          await feishu.grantDocAccess(base.appToken, { chatId: cap.chatId }, 'edit', {}, 'bitable')
            .then(() => { shared.push('chat') })
            .catch((err) => log.warn('grant table access to chat failed', { err: String(err) }))
          needDerivedWrite(cap, 'doc:write')
        }
        return { appToken: base.appToken, tableId, url: bitable.baseUrl(base.appToken, tableId), title, table: tableName, fields: spec.fields.length, rows: spec.records.length, shared }
      } catch (err) {
        if (err instanceof FeishuApiError && err.isPermission) {
          throw new ApiError(403, `没有创建多维表格的权限：应用需要开通 bitable:app（多维表格读写）与 drive:drive（管理协作者）并发版。原始错误：${err.message}`)
        }
        throw err
      }
    },

    /**
     * 本人的会议妙记：只在私聊 + 个人授权下可用。
     *
     * 会上定的事会后没人会再打一遍，而飞书已经把它整理成结构化产出了——
     * 与其从逐字稿里重新提炼（费模型又不如它准），不如直接读 AI 产出。
     */
    'POST /v1/minutes/recent': async (cap, body) => {
      const access = await personalMinutes(cap, ['search'])
      access.assertCurrent()
      const days = body.days_back ?? 7, limit = body.limit ?? 20
      if (!Number.isSafeInteger(days) || (days as number) < 1 || (days as number) > 30 ||
        !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50 ||
        (body.query !== undefined && (typeof body.query !== 'string' || body.query.length > 50)) ||
        (body.page_token !== undefined && (typeof body.page_token !== 'string' || !body.page_token.trim() || body.page_token.length > 2048))) throw new ApiError(400, '妙记查询参数无效')
      const explicitRange = body.start_time !== undefined || body.end_time !== undefined
      const iso = (value: unknown) => typeof value === 'string' && value.length <= 100 && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN
      const endMs = explicitRange ? iso(body.end_time) : Date.now()
      const startMs = explicitRange ? iso(body.start_time) : endMs - (days as number) * 86_400_000
      if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs ||
        endMs - startMs > 30 * 86_400_000 || (body.page_token !== undefined && !explicitRange)) throw new ApiError(400, '妙记时间范围须带时区且不超过 30 天；翻页须沿用首批返回的起止时间与查询词')
      const query = body.query as string | undefined, pageToken = body.page_token as string | undefined
      const result = await readMinutes(cap, access.assertCurrent, () => access.client.recent(access.token, { startMs, endMs }, limit as number,
        { query, pageToken, assertCurrent: access.assertCurrent }))
      access.assertCurrent()
      access.record({ operation: 'search', range: { startMs, endMs }, limit: limit as number, query, pageToken,
        tokens: result.items.map(item => item.token), complete: result.coverage.complete })
      return { minutes: result.items, coverage: result.coverage,
        start_time: new Date(startMs).toISOString(), end_time: new Date(endMs).toISOString(), ...(query === undefined ? {} : { query }) }
    },

    'POST /v1/minutes/read': async (cap, body) => {
      const token = minuteToken(body), access = await personalMinutes(cap, ['get', 'artifacts'])
      access.assertCurrent()
      const minute = await readMinutes(cap, access.assertCurrent, () => access.client.brief(access.token, token, access.assertCurrent))
      access.assertCurrent()
      const artifacts = await readMinutes(cap, access.assertCurrent, () => access.client.artifacts(access.token, token, access.assertCurrent))
      access.assertCurrent()
      access.record({ operation: 'get', token })
      access.record({ operation: 'artifacts', token })
      return { minute, artifacts }
    },

    'POST /v1/minutes/todos': async (cap, body) => {
      const token = minuteToken(body), access = await personalMinutes(cap, ['artifacts'])
      access.assertCurrent()
      const artifacts = await readMinutes(cap, access.assertCurrent, () => access.client.artifacts(access.token, token, access.assertCurrent))
      access.assertCurrent()
      access.record({ operation: 'artifacts', token })
      return { token, todos: artifacts.todos, coverage: { todos: artifacts.coverage.todos } }
    },

    /**
     * 本人要把一篇妙记里的行动项记成待办：宿主用个人授权重新读这篇妙记，把所选行动项全文送到本人私聊确认。
     * 这里不写待办，也不经过派生状态门禁（读过妙记的执行仍不能直接写待办）；写入只在本人点卡的回调里发生。
     */
    'POST /v1/minutes/todos/propose': async (cap, body) => {
      need(cap, 'todo:write')
      if (!cap.boundRunId || cap.boundStage !== 'task' || cap.chatType !== 'p2p' || !cap.requesterOpenId || cap.spaceId !== dmSpaceId(cap.requesterOpenId)) {
        throw new ApiError(403, '妙记行动项只能由本人在自己和 Friday 的私聊里、在当前任务中交给本人确认；没有读取妙记')
      }
      if (policy.decide({ spaceId: cap.spaceId, openId: cap.requesterOpenId, action: 'remember' }).decision !== 'allow') throw new ApiError(403, '当前私聊不允许记录待办；没有读取妙记')
      const token = minuteToken(body), items = body.items === undefined ? [] : body.items, candidates = body.candidates === undefined ? [] : body.candidates
      if (!Array.isArray(items) || new Set(items).size !== items.length ||
        items.some(item => !Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > 999)) {
        throw new ApiError(400, 'items 须为 feishu_minute_todos 返回的 todos 下标（从 0 开始），不重复')
      }
      if (!Array.isArray(candidates) || candidates.some(candidate => !candidate || typeof candidate !== 'object' ||
        typeof (candidate as { text?: unknown }).text !== 'string' || typeof (candidate as { quote?: unknown }).quote !== 'string')) {
        throw new ApiError(400, 'candidates 每条须有 text（一件事）和 quote（AI 总结里的原句）')
      }
      if ((!items.length && !candidates.length) || items.length + candidates.length > MINUTES_DRAFT_MAX_ITEMS) {
        throw new ApiError(400, `items 与 candidates 合计 1–${MINUTES_DRAFT_MAX_ITEMS} 项`)
      }
      const host = deps.minutesTodos
      if (!host) throw new ApiError(503, '妙记行动项确认尚未接入；没有读取妙记，也没有写入待办')
      const access = await personalMinutes(cap, ['get', 'artifacts'])
      access.assertCurrent()
      const minute = await readMinutes(cap, access.assertCurrent, () => access.client.brief(access.token, token, access.assertCurrent))
      access.assertCurrent()
      const artifacts = await readMinutes(cap, access.assertCurrent, () => access.client.artifacts(access.token, token, access.assertCurrent))
      access.assertCurrent()
      access.record({ operation: 'get', token })
      access.record({ operation: 'artifacts', token })
      try {
        return await host.propose({ sessionKey: cap.sessionKey, runId: cap.boundRunId },
          { minute, artifacts, items: items as number[], candidates: candidates as { text: string; quote: string }[] }, access.assertCurrent)
      } catch (error) {
        if (error instanceof MinutesDraftAccessError) throw new ApiError(error.status === 'unavailable' ? 503 : 403, error.message)
        if (error instanceof MinutesDraftError) throw new ApiError(error.code === 'invalid' ? 400 : error.code === 'denied' ? 403 : error.code === 'not_found' ? 404 : 409, error.message)
        if (error instanceof DeliveryError) throw new ApiError(error.code === 'denied' ? 403 : 409, `妙记行动项没有完整送到本人私聊（${error.message}），没有写入待办`, error.failure)
        throw error
      }
    },

    /** 本人日历：只在私聊 + 个人授权下可用；默认今天，可给 days_ahead / start_time / end_time。 */
    'POST /v1/calendar/events': async (cap, body) => {
      need(cap, 'calendar:read')
      if (cap.chatType !== 'p2p') throw new ApiError(403, '日历只能在私聊里查（涉及个人日程）')
      if (!deps.onExternalSourceRead) throw new ApiError(503, '本次日历读取的来源核验尚未就绪')
      const access = await personalScope(cap, 'calendar', 'calendar:read', '读日历')
      const nowSec = Math.floor(Date.now() / 1000)
      const dayStart = (sec: number): number => {
        const d = new Date(sec * 1000 + 8 * 3600_000)
        return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000) - 8 * 3600
      }
      const startSec = parseTimeSec(body.start_time) ?? dayStart(nowSec)
      const endSec = parseTimeSec(body.end_time) ?? startSec + clampInt(body.days_ahead, 1, 31, 1) * 86400
      if (endSec <= startSec || endSec - startSec > 31 * 86400) throw new ApiError(400, '时间范围要在 1 秒到 31 天之间')
      try {
        access.assertCurrent()
        const events = await feishu.listMyEvents(access.as, { startSec, endSec }, access.assertCurrent)
        access.assertCurrent()
        deps.onExternalSourceRead(cap.sessionKey, { kind: 'calendar', ref: `calendar:${cap.requesterOpenId}:${startSec}:${endSec}`, personalOpenId: cap.requesterOpenId, access: 'user' })
        access.assertCurrent()
        return { start: new Date(startSec * 1000).toISOString(), end: new Date(endSec * 1000).toISOString(), events }
      } catch (err) {
        access.assertCurrent()
        throw err
      }
    },

    'POST /v1/doc': async (cap, body) => {
      need(cap, 'doc:read')
      const url = typeof body.url === 'string' ? body.url : ''
      const ref = parseDocRef(url)
      if (!ref) throw new ApiError(400, '无法识别的文档链接，支持 /docx/<token> 与 /wiki/<token>')
      const read = await prepareOptionalRead(cap, 'doc:read', '读取文档')
      const doc = await feishu.readDocument(ref, read.as)
      read.assertCurrent()
      deps.onExternalSourceRead?.(cap.sessionKey, { kind: 'document', ref: `${ref.kind}:${ref.token}`,
        ...(read.as.userToken ? { personalOpenId: cap.requesterOpenId, access: 'user' as const } : { access: 'app' as const }) })
      read.assertCurrent()
      return { ...doc, url, chars: doc.content.length, identity: read.as.userToken ? 'user' : 'bot' }
    },

    'POST /v1/dm': async (cap, body) => {
      need(cap, 'dm:send')
      if (!cap.requesterOpenId) throw new ApiError(403, '当前会话没有可私聊的发起人')
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) throw new ApiError(400, 'text 不能为空')
      if (!deps.deliverToolResult || !cap.boundRunId) throw new ApiError(503, '本次执行的消息交付入口尚未就绪')
      const { messageId } = await deps.deliverToolResult(cap.sessionKey, cap.boundRunId, { kind: 'message', text: text.slice(0, 8000) })
      return { ok: true, message_id: messageId, to: cap.requesterOpenId }
    },

    /** 把工作区里的文件发回飞书：群会话回到话题里，私聊发给本人。只能发会话自己工作区里的文件。 */
    'POST /v1/file/send': async (cap, body) => {
      need(cap, 'file:send')
      if (cap.boundRunId && deps.isManagedRun?.(cap.boundRunId)) throw new ApiError(400, '请用 friday_send_material 发送本次登记的文件。')
      const rel = typeof body.path === 'string' ? body.path.trim() : ''
      if (!rel) throw new ApiError(400, 'path 不能为空')
      if (!cap.cwd) throw new ApiError(500, '会话没有工作区')
      const root = realpathSync(cap.cwd)
      let abs: string
      try {
        abs = realpathSync(resolve(root, rel))
      } catch {
        throw new ApiError(404, `文件不存在：${rel}`)
      }
      if (!abs.startsWith(root + '/')) throw new ApiError(403, '只能发送当前工作区里的文件（downloads/ 或你自己生成的文件）')
      const st = statSync(abs)
      if (!st.isFile()) throw new ApiError(400, '不是文件')
      if (st.size > MAX_UPLOAD_BYTES) throw new ApiError(413, '文件超过 30 MB')
      const name = typeof body.file_name === 'string' && body.file_name.trim() ? sanitizeName(body.file_name.trim()) : basename(abs).replace(/^[a-z0-9]{8}-/, '')
      if (!deps.deliverToolResult || !cap.boundRunId) throw new ApiError(503, '本次执行的文件交付入口尚未就绪')
      // 将实际待发送字节固定下来，摘要与上传不会读取两个不同版本。
      const data = readFileSync(abs)
      if (data.length > MAX_UPLOAD_BYTES) throw new ApiError(413, '文件超过 30 MB')
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : ''
      const { messageId, noteStatus } = await deps.deliverToolResult(cap.sessionKey, cap.boundRunId, { kind: 'file', data, name, note })
      return { ok: true, message_id: messageId, file_name: name, bytes: data.length, ...(noteStatus ? { note_status: noteStatus } : {}) }
    },

    /** 模型提议一个新 skill：落库 + 发卡片（接受才安装）。 */
    // ---- 能力入口：和斜杠命令同一条实现，只是让模型也能用人话触发 ----

    'POST /v1/ability': async (cap, body) => {
      if (!abilities) throw new ApiError(501, '这个部署没有开启能力入口')
      const what = String(body.what ?? '')
      const args = typeof body.args === 'string' ? body.args : ''
      const actor: AbilityActor = abilityActor(cap)
      switch (what) {
        case 'status':
          need(cap, 'todo:read')
          return { text: await abilities.status(actor) }
        case 'report':
          needDerivedWrite(cap, 'doc:write')
          return { text: await abilities.report(actor) }
        case 'wiki':
          needDerivedWrite(cap, 'doc:write')
          return { text: await abilities.wiki(actor) }
        case 'handover':
          needDerivedWrite(cap, 'doc:write')
          return { text: await abilities.handover(actor) }
        case 'groups': {
          const result = await visibleChats(cap)
          const text = result.chats.length ? result.chats.map(chat => `- ${chat.name}（${chat.chat_id}）`).join('\n')
            : result.complete ? '当前没有可访问的群聊。' : '群列表尚未读完整，请稍后再查。'
          // 私聊里还没做个人授权时，这份清单只是"我自己在的群"，不是"你在的群"。
          // 差别必须说出来，并且把能点的授权卡发过去——由宿主统一处理，和命令那条路共用一份实现。
          const offer = cap.chatType === 'p2p' && result.identity !== 'user' ? await abilities.offerConnect(actor) : ''
          return { text: `${result.identity === 'user' ? '你可访问的群聊' : '当前我自己在的群聊'}：\n${text}${result.complete ? '' : '\n列表尚未读完整。'}${offer ? `\n\n${offer}` : ''}` }
        }
        case 'pmo':
          need(cap, 'todo:read')
          if (['init', 'bind', 'sync'].includes(args.trim().split(/\s+/)[0] ?? '')) needDerivedWrite(cap, 'pmo:write')
          return { text: await abilities.pmo(actor, args) }
        case 'settings':
          need(cap, 'memory:read')
          if (args.trim()) needConfigure(cap)
          return { text: await abilities.settings(actor, args) }
        case 'proactive': {
          need(cap, 'memory:read')
          const verb = args.trim().toLowerCase()
          if (verb && !['status', 'on', 'off'].includes(verb)) throw new ApiError(400, '主动接话只支持 status、on、off')
          if (verb === 'on' || verb === 'off') needConfigure(cap)
          return { text: await abilities.proactive(actor, verb === 'status' ? '' : verb) }
        }
        case 'connect': {
          need(cap, 'dm:send')
          if (!cap.boundRunId || cap.boundStage !== 'task') throw new ApiError(403, '个人连接只能由当前交互任务发起')
          // 人说"连接我的飞书账号""帮我授权"时走这里：**网关直接把卡发出去**。
          // 以前没有这条路，模型只能描述"卡会发过来"——然后并没有卡。
          if (cap.chatType !== 'p2p') return { text: '个人授权只在私聊里做（它用的是你自己的身份）。跟我私聊说一声就行。' }
          if (body.extras !== undefined && (!Array.isArray(body.extras) || body.extras.length > 3 ||
            body.extras.some(extra => typeof extra !== 'string' || !['watch', 'calendar', 'minutes'].includes(extra)))) {
            throw new ApiError(400, '补充授权范围只支持 watch、calendar、minutes')
          }
          return abilities.connect(actor, [...new Set((body.extras ?? []) as UserScopeExtra[])])
        }
        case 'explain':
          need(cap, 'memory:read')
          return { text: abilities.explain(actor) }
        case 'selfcheck':
          need(cap, 'memory:read')
          if (!cap.spaceId || (cap.chatType === 'p2p' && !cap.requesterOpenId)) throw new ApiError(403, '该会话缺少自检所需的空间或个人身份')
          return { text: await abilities.selfcheck(actor, args) }
        default:
          throw new ApiError(400, `不认识的能力 ${what}`)
      }
    },

    'POST /v1/skill/list': async (cap) => {
      needRunSkillRead(cap)
      const available = skills!.listForRun(cap.spaceId!, cap.runId!)
      const pinned = skills!.getRunSkillSet(cap.runId!)!
      let builtin
      try { builtin = deps.builtinSkills?.catalog(pinned.builtinDigest) }
      catch (error) {
        if (error instanceof BuiltinSkillReadError) throw new ApiError(409, error.message)
        throw error
      }
      return { skills: available, ...(builtin ? { builtin } : {}),
        current_bindings: skills!.listInstalled(cap.spaceId!).map(name => skills!.getBinding(cap.spaceId!, name)) }
    },

    'POST /v1/skill/load': async (cap, body) => {
      needRunSkillRead(cap)
      if (body.source === 'builtin') {
        if (body.proposal_id !== undefined || (body.resource !== undefined && typeof body.resource !== 'string')) throw new ApiError(400, '内置技能只接受名称和相对资源名')
        if (!deps.builtinSkills) throw new ApiError(501, '该部署没有内置技能读取入口')
        const pinned = skills!.getRunSkillSet(cap.runId!)
        if (!pinned || pinned.spaceId !== cap.spaceId) throw new ApiError(403, '该运行没有本空间的技能绑定')
        try { return deps.builtinSkills.load(String(body.name ?? ''), body.resource as string | undefined, pinned.builtinDigest) }
        catch (error) {
          if (error instanceof BuiltinSkillReadError) throw new ApiError(error.code === 'not_found' ? 404 : error.code === 'invalid_request' ? 400 : 409, error.message)
          throw error
        }
      }
      if ((body.source !== undefined && body.source !== 'space') || body.resource !== undefined) throw new ApiError(400, '自定义技能请使用本轮目录中的名称和 proposal_id')
      if (!Number.isSafeInteger(body.proposal_id) || Number(body.proposal_id) < 1) throw new ApiError(400, '请提供本轮目录中的 proposal_id')
      return skills!.loadForRun(cap.spaceId!, cap.runId!, String(body.name ?? ''), Number(body.proposal_id))
    },

    'POST /v1/skill/propose': async (cap, body) => {
      needDerivedWrite(cap, 'skill:propose')
      if (!skills) throw new ApiError(501, '这个部署没有开启技能提议')
      if (!cap.spaceId || !cap.runId) throw new ApiError(403, '本次执行没有空间技能配置')
      const input = { name: String(body.name ?? '').trim(), description: String(body.description ?? '').trim(), body: String(body.body ?? '') }
      const problem = skills.validate(input)
      if (problem) throw new ApiError(400, problem)
      if (!deps.proposeSkill) throw new ApiError(503, '技能提议缺少当前执行入口')
      const { proposal, delivery, cardStatus } = await deps.proposeSkill(cap.sessionKey, cap.runId, input)
      return { ok: true, id: proposal.id, name: proposal.name, status: proposal.status, card_status: cardStatus,
        delivery_status: delivery.status, message_id: delivery.remoteId,
        already_installed: skills.isInstalled(cap.spaceId, proposal.name) }
    },

    'POST /v1/skill/disable': async (cap, body) => {
      need(cap, 'space:configure')
      if (!deps.disableSkill || !cap.runId || !cap.spaceId) throw new ApiError(503, '技能设置缺少当前执行入口')
      const gate = policy.decide({ spaceId: cap.spaceId, openId: cap.requesterOpenId, action: 'configure' })
      if (gate.decision !== 'allow') throw new ApiError(403, gate.reason)
      const revision = Number(body.expected_revision)
      if (!Number.isSafeInteger(revision) || revision < 1) throw new ApiError(400, '请先查看技能当前版本')
      return deps.disableSkill(cap.sessionKey, cap.runId, { name: String(body.name ?? ''), expectedRevision: revision })
    },

    // Personal reads use the owner's verified connection. Group work retains the team identity.

    'POST /v1/github/issues': async (cap, body) => {
      need(cap, 'github:read')
      if (!github) throw new ApiError(501, '这个部署没有配置 GitHub 身份（GITHUB_APP_* 或 GITHUB_TOKEN）')
      const repo = parseRepo(body.repo)
      if (repo && !github.repoAllowed(repo)) throw new ApiError(403, `仓库 ${repo} 不在 FRIDAY_GITHUB_REPOS 允许范围内`)
      const state = body.state === 'closed' || body.state === 'all' ? (body.state as string) : 'open'
      const limit = clampInt(body.limit, 1, 50, 20)
      let assignee = typeof body.assignee === 'string' ? body.assignee.trim() : ''
      if (assignee === 'me') {
        if (cap.chatType === 'p2p' && deps.personalGithub && deps.personalGithub.view(cap.requesterOpenId ?? '').status !== 'connected')
          throw new ApiError(401, '请在 Friday 私聊的「账号连接」中连接自己的 GitHub。')
        const login = cap.requesterOpenId ? (cap.chatType === 'p2p' && deps.personalGithub
          ? deps.personalGithub.view(cap.requesterOpenId).login : registry.getKv(`github_login:${cap.requesterOpenId}`)) : undefined
        if (!login) throw new ApiError(400, '还不知道发起人的 GitHub 登录名。直接问他一句"你 GitHub 用户名是什么"，他答了用 friday_github_login 记下来，以后就不用再问。不要让他去敲命令。')
        assignee = login
      }
      const type = body.type === 'pr' ? 'pr' : body.type === 'issue' ? 'issue' : 'all'
      const q: string[] = []
      if (repo) q.push(`repo:${repo}`)
      if (type !== 'all') q.push(`is:${type}`)
      if (state !== 'all') q.push(`state:${state}`)
      if (assignee) q.push(`assignee:${assignee}`)
      if (typeof body.author === 'string' && body.author.trim()) q.push(`author:${body.author.trim()}`)
      if (typeof body.mentions === 'string' && body.mentions.trim()) q.push(`mentions:${body.mentions.trim()}`)
      if (Array.isArray(body.labels)) for (const l of body.labels) q.push(`label:"${String(l)}"`)
      if (typeof body.query === 'string' && body.query.trim()) q.push(body.query.trim())
      if (!q.length) throw new ApiError(400, '至少给 repo、assignee、query 之一')
      try {
        const r = await github.api<{ total_count: number; items: Record<string, unknown>[] }>('GET', `/search/issues?q=${encodeURIComponent(q.join(' '))}&sort=updated&order=desc&per_page=${limit}`, undefined, repo?.split('/')[0])
        need(cap, 'github:read')
        const visible = r.items.filter((it) => {
          const sourceRepo = parseRepo(String(it.repository_url ?? '').replace(/^.*\/repos\//, ''))
          if (!sourceRepo || !github.repoAllowed(sourceRepo)) return false
          recordRepositoryRead(cap.sessionKey, sourceRepo)
          return true
        })
        return {
          total: visible.length === r.items.length ? r.total_count : visible.length,
          restricted_results: visible.length !== r.items.length,
          query: q.join(' '),
          items: visible.map((it) => ({
            number: it.number,
            title: it.title,
            state: it.state,
            is_pr: Boolean(it.pull_request),
            url: it.html_url,
            repo: String(it.repository_url ?? '').replace(/^.*\/repos\//, ''),
            author: (it.user as { login?: string } | undefined)?.login,
            assignees: ((it.assignees as { login: string }[] | undefined) ?? []).map((a) => a.login),
            labels: ((it.labels as { name: string }[] | undefined) ?? []).map((l) => l.name),
            updated_at: it.updated_at,
            comments: it.comments,
          })),
        }
      } catch (err) {
        throw toApiError(err)
      }
    },

    'POST /v1/github/issue': async (cap, body) => {
      need(cap, 'github:read')
      if (!github) throw new ApiError(501, '这个部署没有配置 GitHub 身份')
      const repo = parseRepo(body.repo)
      const number = clampInt(body.number, 1, Number.MAX_SAFE_INTEGER, 0)
      if (!repo || !number) throw new ApiError(400, '需要 repo（owner/name）和 number')
      if (!github.repoAllowed(repo)) throw new ApiError(403, `仓库 ${repo} 不在允许范围内`)
      try {
        const issue = await github.api<Record<string, unknown>>('GET', `/repos/${repo}/issues/${number}`)
        const comments = await github.api<Record<string, unknown>[]>('GET', `/repos/${repo}/issues/${number}/comments?per_page=${clampInt(body.comments, 0, 50, 15)}&sort=created&direction=desc`)
        const isPr = Boolean(issue.pull_request)
        let pr: Record<string, unknown> | undefined
        if (isPr) {
          const p = await github.api<Record<string, unknown>>('GET', `/repos/${repo}/pulls/${number}`)
          const files = await github.api<Record<string, unknown>[]>('GET', `/repos/${repo}/pulls/${number}/files?per_page=50`)
          pr = { head: (p.head as { ref?: string })?.ref, base: (p.base as { ref?: string })?.ref, draft: p.draft, mergeable_state: p.mergeable_state, merged: p.merged, additions: p.additions, deletions: p.deletions, files: files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })) }
        }
        need(cap, 'github:read')
        recordRepositoryRead(cap.sessionKey, repo)
        return {
          repo,
          number,
          title: issue.title,
          state: issue.state,
          is_pr: isPr,
          url: issue.html_url,
          author: (issue.user as { login?: string } | undefined)?.login,
          assignees: ((issue.assignees as { login: string }[] | undefined) ?? []).map((a) => a.login),
          labels: ((issue.labels as { name: string }[] | undefined) ?? []).map((l) => l.name),
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          body: String(issue.body ?? '').slice(0, 8000),
          comments: comments.reverse().map((c) => ({ author: (c.user as { login?: string } | undefined)?.login, created_at: c.created_at, body: String(c.body ?? '').slice(0, 2000) })),
          pr,
        }
      } catch (err) {
        throw toApiError(err)
      }
    },

    /**
     * 版本与发布：回答「最新版是什么」和「这个修复进哪个版本了」。
     *
     * 加这条是因为原来只能回答"合入了"，回答不了"发布了没"——而后者才是提问的人真正想知道的。
     * 三条刻意的克制：预览版单独标出来；未合并的 PR 直接说不可能在任何版本里、不做比对；
     * 查过的版本里没找到就只说查了哪些，不把"没查到"说成"没发布"。
     */
    /**
     * 抓一个公开网页。用于"用户贴了个链接"和"去看一眼公开的发布说明"。
     *
     * URL 由模型给出，而网关在内网里，所以准入在 core/web-fetch.ts：协议白名单、内网主机名黑名单、
     * **解析后的 IP 必须是公网**，且每一次重定向都重新过一遍。拒绝的理由直接讲给人听。
     */
    'POST /v1/web/fetch': async (cap, body) => {
      need(cap, 'web:read')
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      if (!url) throw new ApiError(400, '需要 url')
      const maxChars = clampInt(body.max_chars, 500, 50_000, 12_000)
      try {
        if (!deps.authorizePublicWebRequest || !deps.onExternalSourceRead) throw new WebEgressDenied()
        const lease = deps.authorizePublicWebRequest(cap, url)
        const assertCurrent = () => {
          need(cap, 'web:read')
          try { lease.assertCurrent() } catch { throw new ApiError(403, '本次联网请求的授权已失效，请重新发起') }
        }
        assertCurrent()
        publicWebGuards.set(cap, assertCurrent)
        const page = await fetchPublicUrl(lease.url, { proxyUrl: deps.webProxyUrl, allowedOrigin: lease.allowedOrigin,
          signal: lease.signal, assertCurrent })
        assertCurrent()
        // A capability URL is a credential too. Anonymous HTTP content retains
        // the exact host-issued Run and original audience, never publicness.
        deps.onExternalSourceRead?.(cap.sessionKey, { kind: 'web', ref: page.final_url, access: 'link',
          linkGrant: { ...lease.linkGrant, fetchedUrl: page.final_url } })
        assertCurrent()
        const text = page.text.slice(0, maxChars)
        return { ...page, text, truncated: page.truncated || page.text.length > maxChars }
      } catch (err) {
        publicWebGuards.get(cap)?.()
      readFailureGuards.get(cap)?.assertCurrent()
        if (err instanceof WebEgressDenied) throw new ApiError(403, err.message)
        if (err instanceof ApiError) throw err
        if (err instanceof WebFetchRefused) throw new ApiError(400, err.message)
        // 不把底层异常原样外抛：里面可能带内网地址和代理信息
        log.warn('web fetch failed')
        throw new ApiError(502, '抓不到这个网址（超时、被拒或对方不可达）')
      }
    },

    'POST /v1/github/releases': async (cap, body) => {
      need(cap, 'github:read')
      if (!github) throw new ApiError(501, '这个部署没有配置 GitHub 身份')
      const repo = parseRepo(body.repo) ?? github.defaultRepo()
      if (!repo) throw new ApiError(400, '需要 repo（owner/name）')
      if (!github.repoAllowed(repo)) throw new ApiError(403, `仓库 ${repo} 不在允许范围内`)
      const limit = clampInt(body.limit, 1, 30, 10)
      const containsRef = typeof body.contains === 'string' ? body.contains.trim() : ''
      const prNumber = containsRef ? /^#?(\d+)$/.exec(containsRef)?.[1] : undefined
      if (containsRef && !prNumber && !/^[0-9a-f]{7,40}$/i.test(containsRef)) {
        throw new ApiError(400, 'contains 只接受 PR 号（如 #1202）或 commit sha')
      }
      try {
        // 读取与比对的规则在 releases.ts，与 PR 巡查（合并后自动查"进了哪个版本"）共用
        const listing = await readReleases(github, repo, limit, () => need(cap, 'github:read'))
        const { releases, tags, published } = listing
        const result: Record<string, unknown> = {
          repo, source: listing.source, releases, tags, latest: listing.latest, latest_stable: listing.latest_stable,
        }
        if (containsRef) {
          let sha = prNumber ? '' : containsRef
          let merged = true
          let prUrl: string | null = null
          let note = ''
          if (prNumber) {
            const pr = await github.api<Record<string, unknown>>('GET', `/repos/${repo}/pulls/${prNumber}`)
            need(cap, 'github:read')
            merged = Boolean(pr.merged)
            prUrl = (pr.html_url as string | null) ?? null
            sha = String(pr.merge_commit_sha ?? '')
            if (!merged) note = `PR #${prNumber} 还未合并，因此不可能包含在任何版本里`
          }
          let checked: string[] = []
          let first: string | null = null
          if (merged && sha) {
            const found = await firstReleaseContaining(github, repo, sha, published, () => need(cap, 'github:read'))
            checked = found.checked
            first = found.first?.tag ?? null
            if (!first) note = `在查过的 ${checked.length} 个版本里没有找到包含它的；更早或更新的版本没查，不能据此断定它没有进入任何发布`
          }
          result.contains = { ref: containsRef, merged, sha, pr_url: prUrl, first_release: first, checked, note }
        }
        recordRepositoryRead(cap.sessionKey, repo)
        return result
      } catch (err) {
        throw toApiError(err)
      }
    },

    'POST /v1/github/change/list': async (cap) => {
      need(cap, 'github:read')
      if (!github || !changes) throw new ApiError(501, '这个部署没有配置 GitHub 写侧')
      if (!cap.cwd) throw new ApiError(500, '会话没有工作区')
      const identity = repositoryIdentity(cap), workKey = identity.workKey
      const items = changes.list({ cwd: cap.cwd, sessionKey: cap.sessionKey, requesterOpenId: cap.requesterOpenId, workKey })
        .filter((item) => github.repoAllowed(item.repo) && (workKey === undefined || item.workAccess === 'current'))
      const admitted = workKey === undefined ? undefined : new Set(registry.db.prepare(`SELECT p.id FROM github_change_preparations p
        JOIN run_attempts r ON r.id=p.attempt_key WHERE r.work_key=? AND r.session_key=? AND r.actor_open_id=? AND r.stage='task'`)
        .all(workKey, cap.sessionKey, cap.requesterOpenId!).map(row => String(row.id)))
      const preparations = changes.listPreparations({ cwd: cap.cwd, sessionKey: cap.sessionKey, requesterOpenId: cap.requesterOpenId })
        .filter(item => github.repoAllowed(item.repo) && (admitted === undefined || admitted.has(item.id)))
      identity.assertAuthorized()
      if (cap.boundRunId) {
        for (const item of items.slice(0, 50)) deps.preparations?.observeResultForRun(cap.boundRunId, item.id)
        const visible = new Set(items.slice(0, 50).map(item => item.id))
        for (const preparation of preparations.slice(0, 50)) if (preparation.state === 'prepared' && preparation.result) {
          deps.preparations?.observeResultForRun(cap.boundRunId, preparation.result.id)
          visible.add(preparation.result.id)
        }
        for (const preparation of preparations) if (preparation.result && visible.has(preparation.result.id)) notePreparationReturn(cap, preparation.id)
      }
      return { changes: items.slice(0, 50), total: items.length, truncated: items.length > 50,
        preparations: preparations.slice(0, 50).map(item => ({ id: item.id, repo: item.repo, state: item.state,
          ...(item.result ? { change: item.result } : {}), error_code: item.errorCode })),
        preparations_truncated: preparations.length > 50,
        note: '修改目录和仓库准备是独立事实；preparing 仍在准备，retryable/cancelled/interrupted 尚未完成。不要因目录列表为空反复新建；PR 当前状态请用 github_pr_diff 回读。' }
    },

    'POST /v1/github/change/start': async (cap, body) => {
      needRepositoryPermission(cap)
      if (!github || !changes) throw new ApiError(501, '这个部署没有配置 GitHub 写侧（GITHUB_APP_* 与 FRIDAY_GIT_CACHE）')
      const repo = parseRepo(body.repo)
      if (!repo) throw new ApiError(400, '需要 repo（owner/name）')
      // 准备副本这一步还没碰远端，但它决定了之后往哪写；按写判才有意义——
      // 等到 publish 才拒绝，人已经改完一轮代码了。
      if (!github.repoWritable(repo)) throw new ApiError(403, `${repo} 只读：它不在可写仓库名单（FRIDAY_GITHUB_WRITE_REPOS）里，改动没法提回去。`)
      if (!cap.cwd) throw new ApiError(500, '会话没有工作区')
      try {
        needRepositoryWrite(cap, repo)
        const base = typeof body.base === 'string' && body.base.trim() ? body.base.trim() : undefined
        if (deps.preparations) {
          if (!deps.preparationRunSignal || !cap.boundRunId) throw new ApiError(503, '仓库准备的宿主运行入口尚未就绪')
          // Keep original signed/request admission in the API ledger. Its copy
          // has identical authority but no HTTP lease or completed-call collector.
          const detached: RequestCapability = { ...cap, requestSignal: undefined }
          const owned = withoutRequestLease(() => ({ query: preparationQuery(detached, repo, base, true),
            signal: deps.preparationRunSignal!(cap.sessionKey, cap.boundRunId!) }))
          const callId = callIds.get(cap)
          if (!callId) throw new ApiError(503, '仓库准备缺少本次调用收据')
          const result = await deps.preparations.start({ ...owned.query, runSignal: owned.signal,
            branchHint: typeof body.branch_hint === 'string' ? body.branch_hint : undefined,
            onPreparation: receipt => {
              runCalls.reference(callId, { kind: 'github_change_preparation', id: receipt.id })
              notePreparationReturn(cap, receipt.id)
            } })
          assertCurrentRun(cap)
          if (result.preparation.state === 'prepared') recordRepositoryRead(cap.sessionKey, repo)
          return preparationResponse(cap, result.preparation)
        }
        const actor = deps.resolveActorForSession?.(cap.sessionKey)
        const task = actor?.taskId ? registry.getTask(actor.taskId) : undefined
        const work = task ? registry.taskWork.get(task.id) : undefined
        if (cap.boundRunId && (!task || !work || task.requesterOpenId !== cap.requesterOpenId)) throw new ApiError(403, '准备副本缺少真实委托和工作记录')
        const operationKey = work && task ? githubRequestKey(cap, { kind: 'prepare_change', workKey: work.key, taskId: task.id, repo, base: base ?? null }) : undefined
        const callId = callIds.get(cap)
        const r = await changes.prepare({ repo, ...repositoryIdentity(cap, () => needRepositoryWrite(cap, repo)),
          signal: cap.requestSignal, operationKey, attemptKey: cap.boundRunId,
          onPreparation: callId ? receipt => runCalls.reference(callId, { kind: 'github_change_preparation', id: receipt.id }) : undefined,
          branchHint: typeof body.branch_hint === 'string' ? body.branch_hint : undefined, base })
        recordRepositoryRead(cap.sessionKey, repo)
        return { ...r, repo }
      } catch (err) {
        throw toApiError(err)
      }
    },

    'POST /v1/github/change/publish': async (cap, body) => {
      needRepositoryPermission(cap)
      if (!github || !changes) throw new ApiError(501, '这个部署没有配置 GitHub 写侧')
      if (!cap.cwd) throw new ApiError(500, '会话没有工作区')
      const dir = typeof body.dir === 'string' ? resolve(cap.cwd, body.dir) : ''
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      const prBody = typeof body.body === 'string' ? body.body.trim() : ''
      if (!dir || !title) throw new ApiError(400, '需要 dir（github_start_change 返回的目录）和 title')
      // 来源、base、branch 与审批快照从网关 DB / 可信 gitdir 取，不读取 worker 可改的 marker。
      let summary
      const changeActor = repositoryIdentity(cap, () => needRepositoryPermission(cap))
      try { summary = await changes.inspect({ dir, ...changeActor }) }
      catch (err) { throw toApiError(err) }
      needRepositoryWrite(cap, summary.repo)
      if (!summary.files.length) throw new ApiError(400, '相对准备时的 base 无改动，无法发布')
      // 开 PR **不拦**。它和建 Issue 同级：任何本空间成员都能触发。
      //
      // 原来这里要群负责人点一次头，理由是"改的是别人的东西"。但 PR 不是改动，是**提议**——
      // 它是 draft，要人明确说就绪才可评审，要 review 才能合并，关掉就没了，GitHub 上全程留痕。
      // 一张确认卡防的是"模型理解错了"，而 PR 本身就是拿给人看的，这道卡是多的一层。
      //
      // 真正缺的不是拦，是**送到该看的人手上**：开完之后 @ 这几个文件的模块负责人。
      // 拦一道只会让事情停在发起人那儿，@ 对人才会让它往前走。
      // （能不能写这个仓库仍然由 needRepositoryWrite 管——那是空间级的授权，和这里是两件事。）
      try {
        needRepositoryWrite(cap, summary.repo)
        if (deps.armRepositoryCi) deps.armRepositoryCi(cap.sessionKey, cap.boundRunId!, { changeId: summary.id, expectedSnapshot: summary.snapshot })
        const published = await changes.publish({ dir, ...changeActor,
          assertAuthorized: () => { changeActor.assertAuthorized(); needRepositoryWrite(cap, summary.repo) },
          expectedSnapshot: summary.snapshot, title, body: prBody, draft: true })
        // 查负责人是**发布之后**的事，而且失败不影响已经开出去的 PR：
        // 查不到人只是少 @ 一句，把一个已经存在的 PR 报成失败要糟得多。
        const owners = await moduleOwners(summary.repo, published.files ?? summary.files).catch(() => [])
        abilities?.ccRepositoryWrite(abilityActor(cap), { repo: summary.repo, action: '开了 PR', url: published.url, title, files: published.files ?? summary.files })
        return { ...published, owners }
      } catch (err) {
        throw toApiError(err)
      }
    },

    /**
     * draft → 可评审。
     *
     * **不要确认**：开 PR 本身就不拦了，就绪只是同一件事的后半段，更没有理由在这里拦。
     * 再拦一次的代价是 PR 永远停在 draft——人以为交了，其实没人被叫去看。
     */
    'POST /v1/github/pr/ready': async (cap, body) => {
      needRepositoryPermission(cap)
      if (!changes) throw new ApiError(501, '这个部署没有配置 GitHub 写侧')
      if (!cap.cwd) throw new ApiError(500, '会话没有工作区')
      const dir = typeof body.dir === 'string' ? body.dir : ''
      if (!dir) throw new ApiError(400, '要给 dir')
      try {
        const marker = changes.readMarker(dir)
        if (marker) needRepositoryWrite(cap, marker.repo)
        return await changes.markReady({ dir, ...repositoryIdentity(cap, () => {
          needRepositoryPermission(cap); if (marker) needRepositoryWrite(cap, marker.repo)
        }) })
      } catch (err) {
        throw toApiError(err)
      }
    },

    /** PR 走到哪一段了（draft / 待评审 / 已合并 / 已关闭）。只读。 */
    /**
     * 盯这个仓库里没人接的 issue。绑定是空间级的，只有本空间负责人能改——
     * 它决定了 Friday 会主动在群里说话，这和改空间配置是同一类事。
     */
    'POST /v1/github/issue-watch': async (cap, body) => {
      need(cap, 'github:read')
      if (!github) throw new ApiError(501, '这个部署没有配置 GitHub')
      if (cap.chatType !== 'group') throw new ApiError(400, '盯 issue 只在群里做——它会在群里说话，私聊里没有受众')
      const spaceId = spaceIdOf(cap)
      if (body.off === true) {
        needConfigureControl(cap)
        registry.setKv(`issue-watch:${spaceId}`, '')
        return { ok: true, watching: false }
      }
      needConfigure(cap)
      const repo = parseRepo(body.repo) ?? github.defaultRepo()
      if (!repo) throw new ApiError(400, '要给 repo（owner/name）')
      if (!github.repoAllowed(repo)) throw new ApiError(403, `${repo} 不在允许读取的仓库范围内`)
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string' && Boolean(l.trim())).slice(0, 10) : []
      // since = 绑定这一刻。绑定之前就已经安静的陈年 issue 不翻出来——
      // 一个仓库积压两百条，绑定当天全播一遍，这个功能第一次就被用废了。
      const binding = { spaceId, boundBy: cap.requesterOpenId ?? '', repo, since: Date.now(), labels, version: randomUUID() }
      registry.setKv(`issue-watch:${spaceId}`, JSON.stringify(binding))
      return { ok: true, watching: true, repo, labels }
    },

    'POST /v1/github/pr/state': async (cap, body) => {
      need(cap, 'github:read')
      if (!changes) throw new ApiError(501, '这个部署没有配置 GitHub 写侧')
      if (!cap.cwd) throw new ApiError(500, '会话没有工作区')
      const dir = typeof body.dir === 'string' ? body.dir : ''
      if (!dir) throw new ApiError(400, '要给 dir')
      try {
        return await changes.lifecycle({ dir, ...repositoryIdentity(cap) })
      } catch (err) {
        throw toApiError(err)
      }
    },

    'POST /v1/github/change/update': async (cap, body) => {
      needRepositoryPermission(cap)
      if (!github || !changes) throw new ApiError(501, '这个部署没有配置 GitHub 写侧')
      if (!cap.cwd) throw new ApiError(500, '会话没有工作区')
      const dir = typeof body.dir === 'string' && body.dir.trim() ? resolve(cap.cwd, body.dir) : ''
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      const commitBody = typeof body.body === 'string' ? body.body.trim() : ''
      if (!dir || !title) throw new ApiError(400, '需要原修改目录 dir 和本次提交标题 title')
      try {
        // 先按登记对象检查发布范围，之后才读取远端 PR；等待期间仍重验当前授权。
        const marker = changes.readMarker(dir)
        if (!marker) throw new ApiError(404, '没有这个修改目录的登记')
        needRepositoryWrite(cap, marker.repo)
        const actor = { dir, ...repositoryIdentity(cap, () => needRepositoryWrite(cap, marker.repo)) }
        const summary = await changes.inspectUpdate(actor)
        needRepositoryWrite(cap, summary.repo)
        if (summary.noChanges) return { repo: summary.repo, number: summary.prNumber, url: summary.prUrl,
          branch: summary.branch, base: summary.base, head: summary.expectedHead, files: [],
          phase: 'confirmed', replayed: true, noChanges: true }
        // 更新也不拦。开 PR 那一步已经不拦了，这里是**同一个 PR 的后半段**——
        // 第一次不问、第二次问，讲不通。规则是按"这件事会不会立刻生效"分的：
        // 往自己开的 draft PR 上追加提交仍然只是提议，合并才是生效。
        needRepositoryWrite(cap, summary.repo)
        if (deps.armRepositoryCi) deps.armRepositoryCi(cap.sessionKey, cap.boundRunId!, { changeId: summary.id, expectedSnapshot: summary.snapshot })
        const updated = await changes.updatePr({ ...actor, title, body: commitBody,
          expectedSnapshot: summary.snapshot, expectedHead: summary.expectedHead })
        abilities?.ccRepositoryWrite(abilityActor(cap), { repo: summary.repo, action: '往 PR 追加了提交', url: updated.url, title, files: updated.files })
        return updated
      } catch (err) { throw toApiError(err) }
    },

    /**
     * 开 Issue：查重 → 确认卡 → 写 → 回读。命中已有 Issue 就补评论，不会开第二张。
     * 不猜负责人和优先级；没填的会在返回里说明，让人去认领。
     */
    /** PR 的完整 diff（按文件切片、带上下文），供审阅。只读。 */
    'POST /v1/github/pr/diff': async (cap, body) => {
      need(cap, 'github:read')
      if (!github) throw new ApiError(501, '这个部署没有配置 GitHub 身份')
      const repo = parseRepo(body.repo) ?? github.defaultRepo()
      const number = clampInt(body.number, 1, Number.MAX_SAFE_INTEGER, 0)
      if (!repo || !number) throw new ApiError(400, '需要 repo（owner/name）和 number')
      if (!github.repoAllowed(repo)) throw new ApiError(403, `仓库 ${repo} 不在允许范围内`)
      const maxPatchBytes = clampInt(body.max_patch_bytes, 2000, 400_000, 120_000)
      try {
        const result = await readPullRequestReview(github, { repo, number, maxPatchBytes, assertAuthorized: () => {
          need(cap, 'github:read')
          if (!github.repoAllowed(repo)) throw new ApiError(403, '仓库已不在允许范围内')
        } })
        recordRepositoryRead(cap.sessionKey, repo)
        return result
      } catch (err) {
        throw toApiError(err)
      }
    },

    'POST /v1/github/issue/open': async (cap, body) => {
      needIssueWriteRun(cap, 'open')
      needRepositoryPermission(cap)
      if (!github || !issueLinks) throw new ApiError(501, '这个部署没有配置 GitHub 写侧')
      const repo = parseRepo(body.repo) ?? github.defaultRepo()
      if (!repo) throw new ApiError(400, '需要 repo（owner/name），或者在 FRIDAY_GITHUB_REPOS 里配一个默认仓库')
      if (!github.repoWritable(repo)) throw new ApiError(403, `${repo} 只读：它不在可写仓库名单（FRIDAY_GITHUB_WRITE_REPOS）里，开不了 Issue。`)
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      const detail = typeof body.body === 'string' ? body.body.trim() : ''
      if (!title || !detail) throw new ApiError(400, 'title 和 body 都不能为空')
      const labels = Array.isArray(body.labels) ? body.labels.map(String).slice(0, 8) : undefined
      const assignees = Array.isArray(body.assignees) ? body.assignees.map(String).slice(0, 5) : undefined
      const triage = parseIssueTriageParams(body)
      if ('error' in triage) throw new ApiError(400, triage.error)
      const spaceId = spaceIdOf(cap)
      // The current human Task delegates this write. Reuse the same Work/source
      // lease as other repository writes instead of requesting a second consent.
      const { assertAuthorized } = repositoryIdentity(cap, () => needRepositoryWrite(cap, repo))
      const where = cap.chatType === 'p2p' ? '私聊' : `群「${await feishu.chatName(cap.chatId).catch(() => cap.chatId)}」`
      assertAuthorized()
      const byName = cap.requesterOpenId ? await feishu.userName(cap.requesterOpenId).catch(() => undefined) : undefined
      assertAuthorized()
      const fullBody = `${detail}${provenanceLine({ botName: botName(), where, by: byName, nowMs: Date.now() })}`
      try {
        assertAuthorized()
        const requestKey = githubRequestKey(cap, { kind: 'open', repo, title, body: detail, labels: [...(labels ?? [])].sort(), assignees: [...(assignees ?? [])].sort() })
        const r = await openIssue(github, issueLinks, { repo, title, body: fullBody, labels, assignees, spaceId, source: cap.chatId, createdBy: cap.requesterOpenId, requestKey, assertAuthorized,
          captureOrigin: issueOriginCapture(cap, repo, assertAuthorized) })
        assertAuthorized()
        log.info('github issue written', { action: r.action, repo: r.repo, number: r.number, by: cap.requesterOpenId })
        if (cap.boundRunId) deps.recordRepositoryResult?.(cap.sessionKey, cap.boundRunId, r)
        // 建单后的指派与待拍板由宿主处理，不再依赖模型另调 friday_needs_decision
        return await withIssueTriage(cap, r, { spaceId, ...triage, assertAuthorized, requestKey, requestedAssignees: assignees ?? [] })
      } catch (err) {
        throw toApiError(err)
      }
    },

    'POST /v1/github/issue/comment': async (cap, body) => {
      needIssueWriteRun(cap, 'comment')
      needRepositoryPermission(cap)
      if (!github || !issueLinks) throw new ApiError(501, '这个部署没有配置 GitHub 写侧及持久操作记录')
      const repo = parseRepo(body.repo) ?? github.defaultRepo()
      const number = clampInt(body.number, 1, Number.MAX_SAFE_INTEGER, 0)
      const text = typeof body.body === 'string' ? body.body.trim() : ''
      if (!repo || !number || !text) throw new ApiError(400, '需要 repo、number 和 body')
      if (!github.repoWritable(repo)) throw new ApiError(403, `${repo} 只读：它不在可写仓库名单（FRIDAY_GITHUB_WRITE_REPOS）里，评论不了。`)
      const { assertAuthorized } = repositoryIdentity(cap, () => needRepositoryWrite(cap, repo))
      const where = cap.chatType === 'p2p' ? '私聊' : `群「${await feishu.chatName(cap.chatId).catch(() => cap.chatId)}」`
      assertAuthorized()
      const byName = cap.requesterOpenId ? await feishu.userName(cap.requesterOpenId).catch(() => undefined) : undefined
      assertAuthorized()
      try {
        assertAuthorized()
        const requestKey = githubRequestKey(cap, { kind: 'comment', repo, number, body: text })
        const result = await commentIssue(github, { repo, number, body: `${text}${provenanceLine({ botName: botName(), where, by: byName, nowMs: Date.now() })}`, requestKey, assertAuthorized,
          captureOrigin: issueOriginCapture(cap, repo, assertAuthorized) }, issueLinks)
        assertAuthorized()
        if (cap.boundRunId) deps.recordRepositoryResult?.(cap.sessionKey, cap.boundRunId, { repo: result.repo, url: result.commentUrl || result.url })
        return result
      } catch (err) {
        throw toApiError(err)
      }
    },

    'POST /v1/github/me': async (cap) => {
      need(cap, 'github:read')
      if (cap.chatType === 'p2p' && deps.personalGithub) {
        const connection = deps.personalGithub.view(cap.requesterOpenId ?? '')
        return { connection, login: connection.status === 'connected' ? connection.login : null, mode: 'personal', read_only: true }
      }
      const login = cap.requesterOpenId ? registry.getKv(`github_login:${cap.requesterOpenId}`) : undefined
      return { login: login ?? null, bot: github ? await github.botLogin().catch(() => null) : null, mode: github?.mode ?? null }
    },

    'POST /v1/memory/search': async (cap, body) => {
      need(cap, 'memory:read')
      const runtime = memoryRuntime(cap)
      const scopes = memoryReadScopes(cap)
      const query = typeof body.query === 'string' ? body.query : ''
      const limit = clampInt(body.limit, 1, 30, 8)
      const result = runtime.search ? await runtime.search(cap.runId!, scopes, query, limit)
        : { notes: memory.search(scopes, query, limit), unavailable: 0, sourceDenied: 0 }
      const notes = result.notes.map((n) => ({ ...n, scope_label: ChannelMemory.describeScope(n.scope) }))
      runtime.recordRead(cap.runId!, notes.map(({ id, revision }) => ({ id, revision })))
      return { scope: hereScope(cap), scopes, notes, unavailable_sources: result.unavailable, availability: {
        inactive_notes: result.availability?.inactiveNotes ?? result.sourceDenied,
        temporarily_unavailable_notes: result.availability?.temporarilyUnavailableNotes ?? result.unavailable,
      } }
    },

    'POST /v1/memory/save': async (cap, body) => {
      needMemoryWrite(cap, body.replaces)
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      const text = typeof body.body === 'string' ? body.body.trim() : ''
      if (!title || !text) throw new ApiError(400, 'title 和 body 都不能为空')
      const kind = (['qa', 'fact', 'decision', 'todo', 'profile', 'rule', 'lesson'] as NoteKind[]).includes(body.kind as NoteKind) ? (body.kind as NoteKind) : 'fact'
      // 写到哪一层：默认这里；circle 要本群在联盟里；org 要发起人是管理员。判定统一问 Policy。
      let scope = hereScope(cap)
      const share = body.share === 'circle' || body.share === 'space' ? 'circle' : body.share === 'org' ? 'org' : 'here'
      if (cap.memoryWritePolicy !== undefined) {
        if (share !== 'here') throw new ApiError(403, '整理不能把记忆共享到其他层')
      }
      if (share !== 'here') {
        const gate = policy.decide({ spaceId: spaceIdOf(cap), openId: cap.requesterOpenId, action: 'promote', target: share })
        if (gate.decision !== 'allow') throw new ApiError(403, `${gate.reason}。先存在这里，之后由有权限的人晋升到${share}。`)
        if (share === 'circle') {
          if (cap.chatType !== 'group') throw new ApiError(400, '私聊里没有联盟层；要共享给全公司用 share=org')
          const circle = circles?.circleOf(cap.chatId)
          if (!circle) throw new ApiError(400, '本群不在任何联盟里。要加进某个联盟，在群里跟发起人确认一声即可。')
          scope = `circle:${circle}`
        } else {
          scope = ORG_SCOPE
        }
      }
      // MCP 调用的正文都是模型产物；certainty 兼容旧参数，但不是人的确认凭据。
      const status = 'candidate'
      const replaces = typeof body.replaces === 'number' && body.replaces > 0 ? body.replaces : undefined
      const target = replaces ? memory.metadata(replaces, scope) : undefined
      if (replaces && !target) throw new ApiError(400, `#${replaces} 不在这一层，不能替代`)
      let note
      try {
        note = await memoryRuntime(cap).add(cap.runId!, { scope, sessionKey: cap.sessionKey, kind, title, body: text, status, source: { generatedBy: 'model', by: cap.requesterOpenId, chatId: cap.chatId }, replaces,
          ...(target ? { expectedRevision: target.revision } : {}) })
      } catch (error) {
        // The host's own source rule for memory is a refusal to explain to the person, not a server fault.
        if (error instanceof Error && error.message === '本次材料尚不能写入记忆') throw new ApiError(403, '这一轮读了别的群或外部资料，从里面学到的东西不能直接记成记忆（记忆要带来源）。只跟本人有关、本人自己说的可以记；群里的结论让本人在那个群里确认后再记。')
        throw error
      }
      // 读回实际替代结果；模型提出 replaces 不等于旧确认记录已经失效。
      const previous = replaces ? memory.metadata(replaces, scope) : undefined
      const replacement = previous ? { id: previous.id,
        status: previous.status === 'superseded' && previous.supersededBy === note.id ? 'applied'
          : previous.status === 'confirmed' ? 'pending_confirmation' : 'not_applied' } : undefined
      let presentation: { status: DeliveryRecord['status'] | 'not_presented'; message_id?: string | null } | undefined
      if (cap.boundStage === 'task' && note.status === 'candidate' && deps.presentMemoryCandidate) {
        try {
          const delivery = await deps.presentMemoryCandidate(abilityActor(cap), note.id, note.revision)
          presentation = { status: delivery.status, message_id: delivery.remoteId }
        } catch {
          // Saving and presenting are separate facts. A failed card cannot undo the
          // committed candidate or prompt a second save, including self-invalidating corrections.
          presentation = { status: 'not_presented' }
        }
      }
      return { ok: true, note, scope_label: ChannelMemory.describeScope(scope), replacement, presentation }
    },

    'POST /v1/memory/forget': async (cap, body) => {
      needMemoryForget(cap, body.id)
      const id = body.id
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new ApiError(400, '需要有效的记忆编号')
      const note = memory.metadata(id, hereScope(cap))
      if (!note) throw new ApiError(404, '没有这条记忆，或它不属于这里（只能删本层的）')
      // A correction keeps the old record in force until the person confirms the new one; deleting it first loses both.
      if (memory.pendingReplacementOf(id, note.scope) !== undefined) {
        throw new ApiError(409, '这条正在被更正：本人确认新条目后会自动替换它，在那之前它继续有效，现在不要删')
      }
      const removed = await memoryRuntime(cap).forget(cap.runId!, id, note.scope)
      if (!removed) throw new ApiError(404, '这条记忆已不存在，本次未删除')
      return { ok: true, id }
    },

    'POST /v1/todo/add': async (cap, body) => {
      needDerivedWrite(cap, 'todo:write')
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (!title) throw new ApiError(400, 'title 不能为空')
      const dueSec = body.due ? parseTimeSec(body.due) : undefined
      const kind = (['todo', 'deadline', 'freeze', 'release', 'meeting'] as TodoKind[]).includes(body.kind as TodoKind) ? (body.kind as TodoKind) : 'todo'
      if (kind !== 'todo' && !dueSec) throw new ApiError(400, `${kind} 必须带 due`)
      const ownerOpenId = typeof body.owner_open_id === 'string' && /^ou_[0-9a-f]+$/.test(body.owner_open_id) ? body.owner_open_id : undefined
      if (body.owner !== undefined && body.owner !== null && typeof body.owner !== 'string') throw new ApiError(400, '负责人须为文本')
      if (body.owner_open_id !== undefined && body.owner_open_id !== null && !ownerOpenId) throw new ApiError(400, '负责人标识无效')
      if (deps.captureTodoProvenance && !cap.boundRunId) throw new ApiError(403, '待办来源缺少当前执行身份')
      const provenance = deps.captureTodoProvenance ? await deps.captureTodoProvenance(cap.sessionKey, cap.boundRunId!) : undefined
      needDerivedWrite(cap, 'todo:write')
      const { todo } = changeTodo(() => todoApplication.create(todoAudience(cap), {
        kind, title,
        detail: typeof body.detail === 'string' ? body.detail : null,
        dueMs: dueSec ? dueSec * 1000 : null,
        owner: typeof body.owner === 'string' && body.owner.trim() ? body.owner.trim() : null,
        ownerOpenId: ownerOpenId ?? null,
        confirmed: body.certainty !== 'candidate',
        sessionKey: cap.sessionKey,
        source: todoSource(cap.sessionKey) ?? null,
        ...(provenance ? { provenance } : {}),
      }, cap.requesterOpenId ?? null))
      abilities?.notedTodos(abilityActor(cap), [todo.id], 'write')
      return { ok: true, todo, native: deps.taskSync?.view(todo), kind_label: KIND_LABEL[todo.kind], stages: stagesFor(todo.kind) }
    },

    'POST /v1/todo/list': async (cap, body) => {
      need(cap, 'todo:read')
      const completion = await reviewTodoCompletion(cap)
      const status = (['open', 'done', 'all', 'active', 'blocked', 'review', 'cancelled'] as string[]).includes(String(body.status)) ? (body.status as TodoStatus | 'all' | 'active') : 'active'
      const kind = (['todo', 'deadline', 'freeze', 'release', 'meeting'] as TodoKind[]).includes(body.kind as TodoKind) ? (body.kind as TodoKind) : undefined
      const audience = todoAudience(cap), scope = audience.scope, limit = clampInt(body.limit, 1, 100, 30)
      const filter = { status, kind }
      const { items, total } = todos.listForAudience(audience, { ...filter, limit })
      abilities?.notedTodos(abilityActor(cap), items.map((t) => t.id))
      return { scope, todos: items.map((t) => ({ ...t, native: deps.taskSync?.view(t), kind_label: KIND_LABEL[t.kind], status_label: STATUS_LABEL[t.status] })), total, truncated: total > items.length, limit, ...completion }
    },

    'POST /v1/todo/done': async (cap, body) => {
      needDerivedWrite(cap, 'todo:write')
      const id = clampInt(body.id, 1, Number.MAX_SAFE_INTEGER, 0)
      if (!id) throw new ApiError(400, 'id 不能为空')
      const audience = todoAudience(cap)
      if (!cap.requesterOpenId) throw new ApiError(403, '修改待办需要当前操作人')
      const before = todos.getForAudience(id, audience)
      if (!before) throw new ApiError(404, '没有这条未完成的待办')
      if (before.status === 'done') return { ok: true, todo: before, already: true, native: deps.taskSync?.view(before) }
      const { todo } = changeTodo(() => todoApplication.update(id, audience, { current: true, patch: { status: 'done' } }, cap.requesterOpenId!))
      abilities?.notedTodos(abilityActor(cap), [todo.id], 'write')
      return { ok: true, todo, native: deps.taskSync?.view(todo) }
    },

    'POST /v1/todo/update': async (cap, body) => {
      needDerivedWrite(cap, 'todo:write')
      const id = clampInt(body.id, 1, Number.MAX_SAFE_INTEGER, 0)
      if (!id) throw new ApiError(400, 'id 不能为空')
      const audience = todoAudience(cap), before = todos.getForAudience(id, audience)
      if (!before) throw new ApiError(404, '没有这条待办')
      if (!cap.requesterOpenId) throw new ApiError(403, '修改待办需要当前操作人')
      if (body.remove === true) {
        const result = changeTodo(() => todoApplication.remove(id, audience, { current: true }, cap.requesterOpenId!))
        return result.outcome === 'deleted' ? { ok: true, removed: id, outcome: result.outcome, note: '已删除' }
          : { ok: true, ...result, native: deps.taskSync?.view(result.todo), note: '已改为取消，飞书里的任务会随同步删除。' }
      }
      const patch: TodoPatch = {}
      if (body.confirm === true) patch.confirm = true
      // 状态机迁移：进行中 / 阻塞 / 待验收 / 完成 / 取消
      if (typeof body.status === 'string') {
        const to = body.status as TodoStatus
        if (!(['open', 'blocked', 'review', 'done', 'cancelled'] as string[]).includes(to)) throw new ApiError(400, 'status 只能是 open | blocked | review | done | cancelled')
        patch.status = to
        if (typeof body.status_note === 'string') patch.statusNote = body.status_note
      }
      if (body.due !== undefined) patch.dueMs = body.due === null ? null : (parseTimeSec(body.due) as number) * 1000
      if (body.owner !== undefined || body.owner_open_id !== undefined) {
        if (body.owner !== undefined && body.owner !== null && typeof body.owner !== 'string' ||
          body.owner_open_id !== undefined && body.owner_open_id !== null && (typeof body.owner_open_id !== 'string' || !/^ou_[0-9a-f]+$/.test(body.owner_open_id))) throw new ApiError(400, '负责人参数无效')
        patch.owner = typeof body.owner === 'string' && body.owner.trim() ? body.owner.trim() : null
        patch.ownerOpenId = typeof body.owner_open_id === 'string' ? body.owner_open_id : null
      }
      if (body.title !== undefined) { if (typeof body.title !== 'string') throw new ApiError(400, '标题须为文本'); patch.title = body.title }
      if (body.detail !== undefined) { if (body.detail !== null && typeof body.detail !== 'string') throw new ApiError(400, '详情须为文本'); patch.detail = body.detail as string | null }
      if (!Object.keys(patch).length) return { ok: true, todo: before, native: deps.taskSync?.view(before) }
      let todo: Todo
      try { todo = todoApplication.update(id, audience, { current: true, patch }, cap.requesterOpenId).todo }
      catch (error) {
        if (error instanceof TodoApplicationError && error.code === 'invalid_todo_transition' && patch.status) {
          throw new ApiError(409, `「${STATUS_LABEL[before.status]}」不能直接改成「${STATUS_LABEL[patch.status]}」`)
        }
        return changeTodo(() => { throw error })
      }
      abilities?.notedTodos(abilityActor(cap), [todo.id], 'write')
      return { ok: true, todo, native: deps.taskSync?.view(todo), ...(patch.status ? { status_label: STATUS_LABEL[todo.status], was: STATUS_LABEL[before.status] } : {}) }
    },

    // ---- 定时任务 / 关注群聊：继承会话的作用域（私聊 = 创建者，群 = 本群） ----

    'POST /v1/routine/add': async (cap, body) => {
      needDerivedWrite(cap, 'routine:write')
      if (!routines) throw new ApiError(501, '这个部署没有开启定时任务')
      const kind = body.kind === 'watch' ? 'watch' : 'schedule'
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      if (!name || !prompt) throw new ApiError(400, 'name 和 prompt 都不能为空')
      let schedule
      let deliveryPolicy
      let minNewMessages
      let alwaysOnMention
      try {
        schedule = parseSchedule(body.schedule)
        deliveryPolicy = parseDeliveryPolicy(body.delivery_policy)
        minNewMessages = parseMinNewMessages(body.min_new_messages)
        alwaysOnMention = parseAlwaysOnMention(body.always_on_mention)
      } catch (err) {
        throw new ApiError(400, (err as Error).message)
      }
      // G7：阈值只对关注群聊有意义（数的是关注群里的新消息）。
      if (kind !== 'watch' && (minNewMessages !== 0 || body.always_on_mention !== undefined)) throw new ApiError(400, TRIGGER_WATCH_ONLY)
      const watch = kind === 'watch' ? await resolveWatchChats(cap, body.chats) : undefined
      watch?.assertCurrent()
      const watchChatIds = watch?.chatIds ?? []
      needDerivedWrite(cap, 'routine:write')
      const mine = routines.listFor({ chatId: cap.chatId, chatType: cap.chatType, ownerOpenId: cap.requesterOpenId })
      if (mine.filter((r) => r.enabled).length >= 20) throw new ApiError(429, '定时任务太多了（上限 20），先清掉几条不用的再加。')
      const deliverTo = cap.chatType === 'p2p' ? 'dm' : body.deliver_to === 'dm' && cap.requesterOpenId ? 'dm' : 'chat'
      const r = routines.add({ kind, ownerOpenId: cap.requesterOpenId, spaceId: spaceIdOf(cap), chatId: cap.chatId, chatType: cap.chatType, name, prompt, schedule, watchChatIds, deliverTo, deliveryPolicy,
        ...(kind === 'watch' ? { minNewMessages, alwaysOnMention } : {}) })
      // G9：与已有职责产出重复的，记一条待拍板给发起人；不自动去重，也不拦着新建。
      const overlaps = deps.noteRoutineOverlaps?.(r.id, cap.requesterOpenId) ?? []
      return { ok: true, routine: r, schedule_text: describeSchedule(r.schedule), next_run_at: r.enabled ? new Date(r.nextRunAt).toISOString() : null,
        overlaps: overlaps.map(item => ({ id: item.id, version: item.version, title: item.title })) }
    },

    /**
     * 职责提案：模型自己发现"这件事每次都要做"，提出来，发一张卡片等人点接受。
     * 接受前不会跑；接受后以点的人的身份跑；72 小时没人理就作废。
     */
    'POST /v1/responsibility/propose': async (cap, body) => {
      needDerivedWrite(cap, 'routine:write')
      if (!routines) throw new ApiError(501, '这个部署没有开启定时任务')
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
      if (!name || !prompt) throw new ApiError(400, 'name 和 prompt 都不能为空')
      let schedule
      let deliveryPolicy
      try {
        schedule = parseSchedule(body.schedule)
        deliveryPolicy = parseDeliveryPolicy(body.delivery_policy)
      } catch (err) {
        throw new ApiError(400, (err as Error).message)
      }
      const spaceId = spaceIdOf(cap)
      const pending = routines.proposals(spaceId)
      if (pending.length >= 3) throw new ApiError(429, '这里已经有 3 条还没处理的职责提案了，先让人处理完再提新的')
      if (pending.some((p) => p.name === name)) throw new ApiError(409, `已经提过「${name}」了，还在等人处理`)
      const deliverTo = cap.chatType === 'p2p' ? 'dm' : body.deliver_to === 'dm' && cap.requesterOpenId ? 'dm' : 'chat'
      // 提案阶段不绑身份：谁点接受，就以谁的身份跑
      const r = routines.add({ kind: 'schedule', spaceId, chatId: cap.chatId, chatType: cap.chatType, name, prompt, schedule, deliverTo, deliveryPolicy, source: 'model' })
      const card = renderResponsibilityCard({
        id: r.id,
        name: r.name,
        schedule: `${describeSchedule(r.schedule)} · ${describeDeliveryPolicy(r.deliveryPolicy)}`,
        deliverTo: r.deliverTo === 'dm' ? '私聊发起人' : '发回本群',
        prompt: reason ? `${reason}\n\n---\n${r.prompt}` : r.prompt,
        expiresAt: r.expiresAt,
        configVersion: routines.configVersion(r.id) ?? 0,
      })
      const session = registry.getSession(cap.sessionKey)
      let cardMessageId = ''
      if (cap.chatType === 'p2p' && cap.requesterOpenId) cardMessageId = await feishu.sendToUser(cap.requesterOpenId, { card })
      else if (session?.rootMessageId) cardMessageId = (await feishu.replyCard(session.rootMessageId, card, false)).messageId
      else cardMessageId = await feishu.sendToChat(cap.chatId, { card })
      if (cardMessageId) routines.setCardMessageId(r.id, cardMessageId)
      // Preserve the ACK of the card already sent, but do not create new personal
      // work after the sender, space or source authorization changed in flight.
      needDerivedWrite(cap, 'routine:write')
      // 进收件箱：卡片会被刷走，之后蹭别的对话末尾把它捞回来
      if (inbox && cap.requesterOpenId) inbox.add({ ownerOpenId: cap.requesterOpenId, kind: 'responsibility', refId: r.id, spaceId, title: proposalPointerTitle(r), why: '接受后以你的身份定时跑' })
      return { ok: true, id: r.id, status: r.status, delivery_policy: r.deliveryPolicy, note: '已经把提案发出去了，等人点「接受」才会生效；72 小时没人处理就作废。不要重复提。' }
    },

    'POST /v1/routine/list': async (cap, body) => {
      need(cap, 'routine:read')
      if (!routines) return { routines: [] }
      if (body.id !== undefined && (typeof body.id !== 'number' || !Number.isSafeInteger(body.id) || body.id <= 0)) throw new ApiError(400, 'id 必须是有效职责编号')
      const list = routines.listFor({ chatId: cap.chatId, chatType: cap.chatType, ownerOpenId: cap.requesterOpenId }).filter(r => body.id === undefined || r.id === body.id)
      if (body.id !== undefined && list[0]) recordDomainOperation(cap, { kind: 'routine_observation', id: list[0].id, name: list[0].name, enabled: list[0].enabled })
      return { routines: list.map((r) => ({ ...r, schedule_text: describeSchedule(r.schedule), next_run_at: r.enabled ? new Date(r.nextRunAt).toISOString() : null, progress: routineProgress(routines, r, registry.db) })) }
    },

    // ---- 自我安排（Claude Tag 的 self-schedule）：一次性，到点回到同一会话继续 ----
    'POST /v1/followup/add': async (cap, body) => {
      needDerivedWrite(cap, 'routine:write')
      if (!routines) throw new ApiError(501, '这个部署没有开启定时任务')
      const actor = deps.resolveActorForSession?.(cap.sessionKey)
      const task = actor?.taskId === undefined ? undefined : registry.getTask(actor.taskId)
      const work = task && registry.taskWork.get(task.id)
      const directReceipt = task && registry.db.prepare('SELECT 1 FROM task_receipts WHERE task_id = ? AND dedup_key = ?').get(task.id, task.messageId)
      // A followup may schedule its next occurrence in the same proven Work.
      // Its synthetic trigger is not a new human instruction; retain the real root instead.
      const origin = task && work && registry.getTask(directReceipt ? task.id : work.rootTaskId)
      const originReceipt = origin && registry.db.prepare('SELECT 1 FROM task_receipts WHERE task_id = ? AND dedup_key = ?').get(origin.id, origin.messageId)
      if (!cap.runId || actor?.runId !== cap.runId || actor.stage !== 'task' || !task || task.status !== 'running' || task.stopReason ||
        !work || !origin || !originReceipt || !cap.requesterOpenId || task.requesterOpenId !== cap.requesterOpenId ||
        origin.requesterOpenId !== cap.requesterOpenId || task.sessionKey !== cap.sessionKey || origin.sessionKey !== cap.sessionKey) {
        throw new ApiError(403, '安排跟进需要当前任务及可核对的原始请求')
      }
      try { registry.workContexts.claim(work.key) } catch (error) {
        if (!(error instanceof WorkControlError)) throw error
        throw new ApiError(403, '原工作已停止或暂停，不能安排自动跟进')
      }
      const note = typeof body.note === 'string' ? body.note.trim() : ''
      if (!note) throw new ApiError(400, 'note 不能为空')
      const atSec = body.at ? parseTimeSec(body.at) : undefined
      const inMinutes = typeof body.in_minutes === 'number' ? body.in_minutes : undefined
      const requestedAt = Date.now()
      const atMs = atSec ? atSec * 1000 : inMinutes && inMinutes > 0 ? requestedAt + inMinutes * 60_000 : undefined
      if (!atMs) throw new ApiError(400, '需要 at（ISO 时间）或 in_minutes')
      if (atMs - requestedAt < 60_000) throw new ApiError(400, '至少要一分钟之后')
      if (atMs - requestedAt > 90 * 86_400_000) throw new ApiError(400, '最多安排到 90 天之后')
      const pending = routines.followupsFor(cap.sessionKey)
      if (pending.length >= 5) throw new ApiError(429, '这个会话待执行的跟进太多了（上限 5），先把之前的做完或删掉')
      let feedbackId: number | undefined
      if (body.feedback_id !== undefined) feedbackId = requireBug(cap, body.feedback_id).id
      else if (deps.feedback && cap.boundRunId && cap.boundStage === 'task') {
        const actor = deps.resolveActorForSession?.(cap.sessionKey)
        const ids = actor?.taskId === undefined ? [] : deps.feedback.taskFeedbackIds(actor.taskId)
        if (ids.length > 1) throw new ApiError(400, '当前任务关联多个案件，请明确 feedback_id')
        if (ids[0] !== undefined) feedbackId = requireBug(cap, ids[0]).id
      }
      if (feedbackId !== undefined && bugs?.get(feedbackId)?.intakePhase === 'cancelled') throw new ApiError(409, '本案已停止跟进，不能自动安排新的跟进')
      const r = routines.add({
        kind: 'followup',
        ownerOpenId: cap.requesterOpenId,
        chatId: cap.chatId,
        chatType: cap.chatType,
        // The name is what people see in「我的任务」: the model's short title, or the task part of its note.
        name: typeof body.title === 'string' && body.title.trim() ? body.title.replace(/\s+/g, ' ').trim().slice(0, 40) : followupTitle(note).slice(0, 40),
        prompt: note,
        schedule: { type: 'once', atMs },
        sessionKey: cap.sessionKey,
        originTaskId: origin.id,
        ...(feedbackId === undefined ? {} : { feedbackId, spaceId: bugSpaceId(cap) }),
        deliverTo: cap.chatType === 'p2p' ? 'dm' : 'chat',
      })
      return { ok: true, followup: r, at: new Date(r.nextRunAt).toISOString(), pending: pending.length + 1 }
    },

    /**
     * GitHub 登录名 → 这个会话里能不能 @ 到这个人。
     * 三种结果对应三种说法，**没有"猜"这一档**：@ 错人比不 @ 坏得多。
     */
    /** 归并一条 bug 反馈：先看有没有相近的记录，有就挂上去，没有就开新的。 */
    'POST /v1/bug/record': async (cap, body) => {
      need(cap, cap.scopes.includes('bug:record') ? 'bug:record' : 'bug:write')
      if (!bugs) throw new ApiError(501, '这个部署没有开启 bug 收敛')
      const spaceId = bugSpaceId(cap)
      const bucket = body.bucket_id === undefined ? undefined : requireBug(cap, body.bucket_id)
      const currentOrigin = () => {
        // 默认来源只取当前宿主 Run 绑定的真实入站，不能按正文、会话最新任务或模型身份猜。
        const actor = deps.resolveActorForSession?.(cap.sessionKey)
        const task = actor?.taskId === undefined ? undefined : registry.getTask(actor.taskId)
        const session = registry.getSession(cap.sessionKey)
        const receipt = task && registry.db.prepare('SELECT 1 FROM task_receipts WHERE task_id = ? AND dedup_key = ?').get(task.id, task.messageId)
        if (!cap.boundRunId || !['task', 'feedback_control'].includes(cap.boundStage ?? '') || !cap.requesterOpenId || actor?.runId !== cap.boundRunId || actor.stage !== cap.boundStage || actor.requesterOpenId !== cap.requesterOpenId ||
          !task || task.status !== 'running' || task.stopReason || !task.messageId.trim() || !receipt ||
          task.sessionKey !== cap.sessionKey || task.requesterOpenId !== cap.requesterOpenId || !session || session.status === 'archived' ||
          session.chatId !== cap.chatId || session.chatType !== cap.chatType) {
          throw new ApiError(403, '缺少当前交互任务的真实消息来源；记录历史反馈时请明确提供 message_id')
        }
        const cached = messageCache.get(task.messageId)
        const reporterName = cached?.chatId === cap.chatId && cached.senderOpenId === task.requesterOpenId ? cached.senderName || undefined : undefined
        return { task, reporterName }
      }
      if (bucket?.intakePhase === 'cancelled') {
        if (body.message_id !== undefined) throw new ApiError(409, '已停止反馈只接受当前用户原话；请省略 message_id')
        if (body.declined_info !== undefined) throw new ApiError(409, '已停止反馈只保存当前用户原话，不再记录材料限制；请省略 declined_info')
        const { task, reporterName } = currentOrigin()
        if (cap.boundStage !== 'feedback_control' && deps.feedback?.taskStopped(task.id)) throw new ApiError(403, '原执行已停止，不能用旧任务追加用户补充')
        try {
          const result = bugs.captureUserNote({ bucketId: bucket.id, spaceId, chatId: cap.chatId, messageId: task.messageId,
            reporterOpenId: task.requesterOpenId!, reporterName, text: task.prompt, now: task.createdAt })
          recordDomainOperation(cap, { kind: 'feedback_note', id: bucket.id })
          return { ...result, record_kind: 'user_note', recorded_current_message: true, stopped: true }
        } catch (error) { throw new ApiError(409, (error as Error).message) }
      }
      if (cap.boundStage === 'feedback_control') {
        if (!bucket) throw new ApiError(403, '控制后补充须指定已有反馈，不在本轮新建案件')
        needFeedbackWrite(cap, bucket.id)
      } else needSafeDerivedState(cap)
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!title || !text) throw new ApiError(400, '要给 title（一句话概括）和 text（反馈原文）')
      const declined = declinedInfoInput(body.declined_info)
      let messageId: string
      let reporterOpenId = typeof body.reporter_open_id === 'string' ? body.reporter_open_id : undefined
      let reporterName = typeof body.reporter_name === 'string' ? body.reporter_name : undefined
      if (body.message_id === undefined) {
        const { task, reporterName: currentName } = currentOrigin()
        messageId = task.messageId
        reporterOpenId = task.requesterOpenId ?? undefined
        reporterName = currentName
      } else {
        if (typeof body.message_id !== 'string' || !body.message_id.trim()) throw new ApiError(400, 'message_id 必须是非空消息 ID')
        // 显式历史来源沿用现有路径；本片不把模型提供的历史消息和署名宣称为宿主已核验。
        messageId = body.message_id.trim()
      }
      // record() 的幂等分支按全局 message_id 返回旧记录；返回前同样必须检查空间。
      if (messageId) {
        const seen = registry.db.prepare('SELECT bucket_id FROM bug_reports WHERE message_id = ?').get(messageId) as { bucket_id: number } | undefined
        if (seen) {
          requireBug(cap, Number(seen.bucket_id))
          if (bucket && seen.bucket_id !== bucket.id) throw new ApiError(409, '这条消息已经关联另一条反馈，不能重复作为本案报告')
        }
      }
      // 报告与原话里声明的材料限制在同一事务里写入；类别由调用方给出，宿主不从原文推断。
      registry.db.exec('SAVEPOINT record_feedback')
      let r: ReturnType<Bugs['record']>
      try {
        r = bugs.record({
          spaceId,
          title,
          text,
          bucketId: bucket?.id,
          chatId: cap.chatId,
          messageId,
          reporterOpenId,
          reporterName,
          link: typeof body.link === 'string' ? body.link : undefined,
        })
        if (declined.length) {
          if (r.bucket.intakePhase === 'cancelled') throw new ApiError(409, '本案已停止跟进，不再记录材料限制')
          r = { ...r, bucket: bugs.addDeclinedInfo({ bucketId: r.bucket.id, spaceId, kinds: declined, source: 'statement', messageId }) }
        }
        registry.db.exec('RELEASE SAVEPOINT record_feedback')
      } catch (error) {
        registry.db.exec('ROLLBACK TO SAVEPOINT record_feedback; RELEASE SAVEPOINT record_feedback')
        throw error
      }
      recordDomainOperation(cap, { kind: 'feedback_record', id: r.bucket.id, created: r.isNew, duplicate: r.duplicate })
      return { bucket: r.bucket, isNew: r.isNew, duplicate: r.duplicate }
    },

    /** 相近的已有桶（只给候选，合不合由模型判断）。 */
    'POST /v1/bug/similar': async (cap, body) => {
      need(cap, 'bug:read')
      if (!bugs) throw new ApiError(501, '这个部署没有开启 bug 收敛')
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (!title) throw new ApiError(400, '要给 title')
      return { candidates: bugs.similar(bugSpaceId(cap), title) }
    },

    'POST /v1/bug/list': async (cap, body) => {
      need(cap, 'bug:read')
      if (!bugs) throw new ApiError(501, '这个部署没有开启 bug 收敛')
      const status = typeof body.status === 'string' ? (body.status as BugStatus) : undefined
      const list = bugs.list(bugSpaceId(cap), { status, limit: clampInt(body.limit, 1, 100, 30) })
      return { buckets: list.map((b) => ({ ...b, reports: bugs.reports(b.id, 3) })) }
    },

    'POST /v1/bug/update': async (cap, body) => {
      need(cap, 'bug:write')
      if (!bugs) throw new ApiError(501, '这个部署没有开启 bug 收敛')
      const bucket = requireBug(cap, body.id)
      needFeedbackWrite(cap, bucket.id)
      const { id } = bucket
      if (bucket.intakePhase === 'cancelled') throw new ApiError(409, '本案已停止跟进，只能保留当前用户原话，不能自动改写或恢复')
      if (body.status !== undefined && !['open', 'triaging', 'fixed', 'wontfix'].includes(String(body.status))) throw new ApiError(400, '无效的反馈状态')
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (body.note !== undefined && (typeof body.note !== 'string' || body.status === undefined)) throw new ApiError(400, 'note 仅作为状态变更说明；单独保存处理说明请使用 bug/intake')
      if (!title && body.status === undefined) throw new ApiError(400, '至少提供有效的 title 或 status；没有修改任何字段')
      if (bucket.issueUrl && body.status !== undefined) throw new ApiError(409, '已关联 GitHub Issue，请读取或更新 GitHub 正式状态；本地不能标记为已修复')
      const st = typeof body.status === 'string' ? (body.status as BugStatus) : undefined
      registry.db.exec('SAVEPOINT update_feedback')
      try {
        if (title) bugs.retitle(id, title)
        if (st) bugs.setStatus(id, st, typeof body.note === 'string' ? body.note : undefined)
        registry.db.exec('RELEASE SAVEPOINT update_feedback')
      } catch (error) {
        registry.db.exec('ROLLBACK TO SAVEPOINT update_feedback; RELEASE SAVEPOINT update_feedback')
        throw new ApiError(409, (error as Error).message)
      }
      const updated = bugs.get(id)!
      const changed: ('title' | 'status' | 'note')[] = []
      if (updated.title !== bucket.title) changed.push('title')
      if (updated.status !== bucket.status) changed.push('status')
      if (updated.note !== bucket.note) changed.push('note')
      recordDomainOperation(cap, { kind: 'feedback_update', id, fields: changed })
      return { bucket: updated, changed, applied: changed.length > 0 }
    },

    'POST /v1/bug/intake': async (cap, body) => {
      if (body.phase === 'cancelled') {
        if (Object.keys(body).some((key) => key !== 'id' && key !== 'phase')) throw new ApiError(400, '停止跟进仅接受 id 和 phase，不同时保存正文或缺口')
        return stopFeedback(cap, body.id)
      }
      need(cap, 'bug:write')
      if (!bugs) throw new ApiError(501, '这个部署没有开启反馈记录')
      const bucket = requireBug(cap, body.id)
      needFeedbackWrite(cap, bucket.id)
      if (bucket.issueUrl) throw new ApiError(409, '已转 GitHub，请在那里继续跟进正式状态')
      if (typeof body.phase !== 'string' || (body.missing_info !== undefined && (!Array.isArray(body.missing_info) || !body.missing_info.every((v) => typeof v === 'string')))) throw new ApiError(400, '需要 phase 和可选的 missing_info 字符串列表')
      const declined = declinedInfoInput(body.declined_info)
      try {
        registry.db.exec('SAVEPOINT feedback_intake')
        let updated: BugBucket
        try {
          updated = bugs.setIntake({ bucketId: bucket.id, spaceId: bugSpaceId(cap), phase: body.phase as BugIntakePhase, missingInfo: body.missing_info as string[] | undefined, note: typeof body.note === 'string' ? body.note : undefined })
          // 只追加用户原话里明确不提供的类别；已记录的类别不重复写，也不能在这里删除。
          if (declined.length) updated = bugs.addDeclinedInfo({ bucketId: bucket.id, spaceId: bugSpaceId(cap), kinds: declined, source: 'statement' })
          registry.db.exec('RELEASE SAVEPOINT feedback_intake')
        } catch (error) {
          registry.db.exec('ROLLBACK TO SAVEPOINT feedback_intake; RELEASE SAVEPOINT feedback_intake')
          throw error
        }
        const fields = (['intakePhase', 'missingInfo', 'note', 'status'] as const).filter(key => JSON.stringify(updated[key]) !== JSON.stringify(bucket[key]))
        const changed = updated.declinedInfo.length === bucket.declinedInfo.length ? [...fields] : [...fields, 'declinedInfo' as const]
        recordDomainOperation(cap, { kind: 'feedback_intake', id: bucket.id, phase: updated.intakePhase, missingInfo: updated.missingInfo.length, fields })
        const openQuestion = deps.questions?.list(bucket.id, bugSpaceId(cap)).find((q) => q.resolution === 'open')
        return { bucket: updated, changed, applied: changed.length > 0, message_sent: false,
          ...(deps.questions ? { open_question: openQuestion ? { id: openQuestion.id, question: openQuestion.question } : null } : {}),
          note: `${changed.length ? '已保存列出的变更' : '内容未变'}。本次操作没有发问；若仍需用户补充，用 friday_bug_ask 发送一个关键问题。已问过或已拒绝的内容不重复索取。${declinedNote(updated.declinedInfo)}` }
      } catch (err) { throw new ApiError(400, (err as Error).message) }
    },

    'POST /v1/bug/control': async (cap, body) => {
      need(cap, 'bug:write')
      if (body.action !== 'stop' || Object.keys(body).some((key) => key !== 'id' && key !== 'action')) throw new ApiError(400, '案件控制仅接受 id 和 action:stop')
      return stopFeedback(cap, body.id)
    },

    'POST /v1/bug/context': async (cap, body) => {
      need(cap, 'bug:read')
      if (!bugs) throw new ApiError(501, '这个部署没有开启反馈记录')
      const bucket = requireBug(cap, body.id)
      const context = deps.questions?.readContext(bucket.id, bugSpaceId(cap))
      const reports = context?.reports ?? bugs.reports(bucket.id, 51)
      return { bucket, reports: reports.slice(0, 50), reportsTruncated: context?.reportsTruncated ?? reports.length > 50,
        anchors: bugs.anchors(bucket.id, bugSpaceId(cap)), evidence: bugs.evidence(bucket.id, bugSpaceId(cap)),
        questions: context?.questions ?? [], formal_status_source: bucket.issueUrl ? 'github' : 'local_intake' }
    },

    /** 只登记当前会话中真实消息的引用；不下载附件、不接收模型自报路径或 Session 授权。 */
    'POST /v1/bug/evidence': async (cap, body) => {
      needDerivedWrite(cap, 'bug:write')
      if (!bugs) throw new ApiError(501, '这个部署没有开启反馈记录')
      const bucket = requireBug(cap, body.id)
      if (!deps.appId) throw new ApiError(501, '缺少应用命名空间，不能登记证据锚点')
      const messageId = typeof body.message_id === 'string' ? body.message_id.trim() : ''
      if (!messageId) throw new ApiError(400, '需要本会话的 message_id')
      const msg = await feishu.getMessage(messageId, await identity(cap))
      if (!msg || msg.messageId !== messageId || msg.chatId !== cap.chatId || !msg.tenantId) throw new ApiError(403, '无法验证消息的会话或租户归属，未登记证据')
      // 网络读取后重验权限；不能让等待 API 的旧请求越过空间归档/换绑。
      needDerivedWrite(cap, 'bug:write')
      const spaceId = bugSpaceId(cap)
      const anchor = bugs.addAnchor({ bucketId: bucket.id, spaceId, tenantId: msg.tenantId, appId: deps.appId, chatId: msg.chatId, messageId: msg.messageId, threadId: msg.threadId, rootId: msg.rootId, parentId: msg.parentId })
      const kind = msg.fileKey ? 'user_export' : 'message'
      const evidence = bugs.addEvidence({ bucketId: bucket.id, spaceId, kind, sourceRef: `feishu:${msg.tenantId}:${deps.appId}:${msg.chatId}:${msg.messageId}`, coverage: { state: 'unknown', note: msg.fileKey ? '仅验证附件消息存在；未下载、未检查内容，不能据此声称日志已收到或完整' : '消息引用；不证明整个会话或日志覆盖完整' } })
      return { anchor, evidence, downloaded: false, analyzed: false }
    },

    /** 关联已获授权创建的真实 Issue；补问预算或拒绝信息本身不授予建单许可。 */
    'POST /v1/bug/link_issue': async (cap, body) => {
      needDerivedWrite(cap, 'bug:write')
      if (!bugs) throw new ApiError(501, '这个部署没有开启 bug 收敛')
      const bucket = requireBug(cap, body.id)
      const { id } = bucket
      const url = typeof body.issue_url === 'string' ? body.issue_url.trim() : ''
      const ref = parseIssueReference(url)
      if (!ref) throw new ApiError(400, '需要完整的 HTTPS GitHub Issue 链接（owner/repo/issues/编号）')
      need(cap, 'github:read')
      if (!github) throw new ApiError(501, '尚未配置 GitHub，不能核实 Issue 链接')
      const authorized = (): void => {
        needDerivedWrite(cap, 'bug:write')
        need(cap, 'github:read')
        if (!github.repoAllowed(ref.repo)) throw new ApiError(403, 'Issue 仓库不在部署允许范围内')
      }
      authorized()
      // 只向已配置的 GitHub API 读取固定资源，绝不请求模型传入的 URL。
      // 回读仅验证关联对象，不把 Issue 的正文、评论或其他仓库内容交给模型。
      let issue: { number: number; html_url: string; state: string; pull_request?: unknown }
      try {
        issue = await github.api('GET', `/repos/${ref.repo}/issues/${ref.number}`, undefined, ref.repo.split('/')[0], authorized)
      } catch (err) { throw toApiError(err) }
      authorized()
      const verified = parseIssueReference(issue?.html_url)
      if (!verified || issue.pull_request || issue.number !== ref.number || !['open', 'closed'].includes(issue.state) ||
        verified.url.toLowerCase() !== ref.url.toLowerCase()) {
        throw new ApiError(409, '链接与 GitHub 回读的 Issue 不一致，尚未关联')
      }
      const current = requireBug(cap, id)
      if (current.issueUrl && !sameIssueReference(current.issueUrl, verified.url)) throw new ApiError(409, `#${id} 已关联 ${current.issueUrl}，不能自动改绑`)
      const updated = bugs.linkIssue(id, verified.url, typeof body.note === 'string' ? body.note : undefined)
      return { bucket: updated, issue: { repo: verified.repo, number: verified.number, url: verified.url, state: issue.state }, note: '已核实并关联 GitHub Issue；正式状态以 GitHub 为准。回复时附上链接。' }
    },

    /** 登记与投递由当前任务宿主完成，API 不再单独扣预算或声称已经问过。 */
    'POST /v1/bug/ask': async (cap, body) => {
      needDerivedWrite(cap, 'bug:write')
      if (!bugs) throw new ApiError(501, '这个部署没有开启 bug 收敛')
      const { id } = requireBug(cap, body.id)
      if (body.kind === 'decision') throw new ApiError(400, '暂不支持 decision 决策问题，请使用现有审批入口')
      if (body.kind !== undefined && body.kind !== 'info') throw new ApiError(400, 'kind 必须为 info')
      const infoKind = infoKindInput(body.info_kind)
      const question = typeof body.question === 'string' ? body.question.trim() : ''
      if (!question || question.length > 2000) throw new ApiError(400, '需要 1–2000 字的问题正文 question')
      if (body.missing_info !== undefined && (!Array.isArray(body.missing_info) || body.missing_info.length > 20 || body.missing_info.some((item) => typeof item !== 'string' || !item.trim() || item.trim().length > 300))) throw new ApiError(400, 'missing_info 需要最多 20 项非空字符串，每项不超过 300 字')
      if (!deps.askBugQuestion) throw new ApiError(503, '本次执行的问题投递入口尚未就绪')
      const runId = requireQuestionRun(cap)
      try {
        return await deps.askBugQuestion(cap.sessionKey, runId, { id, question, kind: 'info', ...(body.missing_info === undefined ? {} : { missingInfo: (body.missing_info as string[]).map((item) => item.trim()) }),
          ...(infoKind === undefined ? {} : { infoKind }) })
      } catch (error) {
        if (!(error instanceof BugQuestionError)) throw error
        const kinds = declinedLabels(error.declined)
        if (error.code === 'info_kind_required') throw new ApiError(400, `本次没有发出问题：本案已记录用户不提供的材料（${kinds}），补问须用 info_kind 标明所要材料的类别；这些类别不再索要。`)
        throw new ApiError(409, `declined_before：用户之前已表示不提供${kinds}，宿主不再发出同类补问，本次没有发出问题。直接告诉用户“这项你之前说过不方便给，我不再要了”，然后按现有信息继续，不换一种说法再问。用户之后主动发来的材料照常读取。`)
      }
    },

    'POST /v1/bug/reply': async (cap, body) => {
      need(cap, 'bug:write')
      if (!deps.questions || !deps.resolveBugQuestionReply) throw new ApiError(503, '本次执行的答复处理入口尚未就绪')
      if (typeof body.question_id !== 'number' || !Number.isSafeInteger(body.question_id) || body.question_id <= 0 || typeof body.reply_id !== 'number' || !Number.isSafeInteger(body.reply_id) || body.reply_id <= 0) throw new ApiError(400, '需要有效的 question_id 和 reply_id')
      const question = deps.questions.get(body.question_id)
      if (!question) throw new ApiError(404, '没有这个问题，或它不属于当前空间')
      requireBug(cap, question.bucketId)
      needFeedbackWrite(cap, question.bucketId)
      if (typeof body.outcome !== 'string' || !['answered', 'declined', 'unavailable'].includes(body.outcome)) throw new ApiError(400, 'outcome 必须为 answered、declined 或 unavailable')
      const runId = requireQuestionRun(cap, true)
      const result = await deps.resolveBugQuestionReply(cap.sessionKey, runId, { questionId: question.id, replyId: body.reply_id, outcome: body.outcome as ResolveBugQuestionReplyInput['outcome'] })
      assertCurrentRun(cap)
      if (result.reply.outcome !== 'pending') recordDomainOperation(cap, { kind: 'feedback_reply', id: question.bucketId, questionId: question.id, replyId: result.reply.id, outcome: result.reply.outcome })
      return result
    },

    /**
     * 发起人的 GitHub 登录名：读 / 记。
     *
     * 存在的理由是让"我的 issue"这类问题**用人话就能走通**：模型问一句、他答一句、这里记下来。
     * 以前唯一的入口是 `/github <登录名>`，等于要求他先知道有这么个命令。
     * 只写发起人自己的（`cap.requesterOpenId`），body 里的 open_id 一律不看。
     */
    'POST /v1/github/login': async (cap, body) => {
      const openId = cap.requesterOpenId
      if (!openId) throw new ApiError(400, '认不出是谁在问')
      if (cap.chatType === 'p2p' && deps.personalGithub) {
        need(cap, 'github:read')
        return { connection: deps.personalGithub.view(openId), saved: false, note: '在 Friday 私聊打开「账号连接」，登录自己的 GitHub；填写用户名不授予访问权限。' }
      }
      const raw = typeof body.login === 'string' ? body.login.trim().replace(/^@/, '') : ''
      if (!raw) {
        need(cap, 'github:read')
        const cur = registry.getKv(`github_login:${openId}`)
        return { login: cur ?? null }
      }
      needInteractiveStateWrite(cap, 'profile:write')
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(raw)) {
        throw new ApiError(400, 'GitHub 登录名格式不对（字母、数字、连字符，最多 39 位）。别猜，问清楚再记。')
      }
      registry.setKv(`github_login:${openId}`, raw)
      return { login: raw, saved: true }
    },

    /**
     * 「这一轮我停下来等你定」——把问题记下来。
     *
     * Friday 停下来问一个问题，这一轮就结束了。**问题只存在于那条消息里**，他没当场回，这件事就没了——
     * 没有任何地方记着"有件事在等他"。
     *
     * 所以停下来等人拍板时要留一条，之后蹭一次已有的对话捎带出来。
     * 同一个人在同一个空间里同一句问题只会有一条，问两次不会变成两条。
     */
    'POST /v1/inbox/decision': async (cap, body) => {
      const ownerOpenId = needInteractiveStateWrite(cap, 'todo:write')
      if (!inbox) throw new ApiError(501, '这个部署没有开启待办决定')
      const question = typeof body.question === 'string' ? body.question.replace(/\s+/g, ' ').trim() : ''
      if (!question) throw new ApiError(400, '要给 question：一句话说清楚你要他定什么')
      const why = typeof body.why === 'string' ? body.why.trim() : undefined
      const ref = decisionRef(cap.spaceId, question, ownerOpenId)
      // Old refs lacked an owner. Reuse only this same person's existing row;
      // another member's matching question is never their pending decision.
      const legacy = inbox.find('decision', decisionRef(cap.spaceId, question), ownerOpenId)
      const existing = inbox.find('decision', ref, ownerOpenId) ?? legacy
      if (existing?.resolvedAt === null) return { id: existing.id, version: existing.version, already_open: true }
      if (existing && body.reopen !== true) {
        // 结清过的默认不重开：把上次的结论告诉模型，不再问一遍；重启或重放也不会让它复活
        return { id: existing.id, version: existing.version, already_open: false, already_resolved: true, resolution: existing.resolution, note: existing.resolutionNote }
      }
      if (existing && existing.refId !== null) {
        // 模型判断情况变了、确实要重新问：同一行开新的一版，旧结论不带过来
        const reopened = inbox.add({ ownerOpenId, kind: 'decision', refId: existing.refId, spaceId: cap.spaceId, title: question, why })
        return { id: reopened.id, version: reopened.version, already_open: false, reopened: true }
      }
      const item = inbox.add({ ownerOpenId, kind: 'decision', refId: ref, spaceId: cap.spaceId, title: question, why })
      // 问过的就是问过了——告诉模型一声，免得它在同一轮里又把同一句话重复给人听
      return { id: item.id, version: item.version, already_open: false, created: true }
    },

    /** 等他拍板的事：本人在这个会话里能看到、能结清的（带 id 和 version）。私聊列出本人全部，群里只列本群的。 */
    'POST /v1/decision/list': async (cap) => {
      const owner = needOwnPendingDecisions(cap)
      if (!inbox) throw new ApiError(501, '这个部署没有开启待办决定')
      if (!deps.pendingDecisions) throw new ApiError(503, '待拍板事项入口尚未就绪')
      const items = deps.pendingDecisions(owner, { spaceId: cap.spaceId!, chatType: cap.chatType })
      return { items: items.map(item => ({ id: item.id, version: item.version, kind: item.kind, title: item.title, why: item.why,
        created_at: new Date(item.createdAt).toISOString() })) }
    },

    /**
     * 结清一件等他拍板的事：只针对列表给出的那一版，只结清本人自己的那一条。
     * 职责提案、授权提醒、技能提议由各自领域处理，这里只转告该去哪儿处理。
     */
    'POST /v1/decision/resolve': async (cap, body) => {
      const owner = needInteractiveStateWrite(cap, 'todo:write')
      if (!inbox) throw new ApiError(501, '这个部署没有开启待办决定')
      if (!deps.resolveDecision) throw new ApiError(503, '待拍板事项入口尚未就绪')
      const id = body.id, version = body.version
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
        throw new ApiError(400, '需要 friday_decision_list 给出的 id 和 version')
      }
      if (body.resolution !== 'decided' && body.resolution !== 'dropped') throw new ApiError(400, 'resolution 只能是 decided（定了）或 dropped（不用了）')
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : undefined
      let result: ResolveDecisionResult
      try {
        result = deps.resolveDecision({ itemId: id, expectedVersion: version, resolution: body.resolution, ...(note ? { note } : {}),
          operatorOpenId: owner, context: { spaceId: cap.spaceId!, chatType: cap.chatType } })
      } catch (err) {
        // G9：选了暂停但那条职责已不存在 / 不能暂停：整个结清回滚，如实告诉模型。
        if (err instanceof RoutineControlError) throw new ApiError(409, err.message)
        throw err
      }
      if (result.outcome === 'denied') throw new ApiError(403, result.reason)
      if (result.outcome === 'not_found') throw new ApiError(404, '没有这件待拍板的事')
      recordDomainOperation(cap, { kind: 'decision_resolve', id: result.item.id, title: result.item.title, outcome: result.outcome, changed: result.changed })
      // “不用了”在提案所在的群里忽略了提案（或点的那一刻已过期）：事务已提交，再把提案卡刷成当前状态
      if (result.outcome === 'proposal' && result.proposal.changed && 'routine' in result.proposal) await refreshProposalCard(result.proposal.routine.id)
      return presentDecisionResolution(result)
    },

    'POST /v1/whois': async (cap, body) => {
      need(cap, 'github:read')
      if (!identities) throw new ApiError(501, '这个部署没有人员映射表')
      const login = typeof body.github_login === 'string' ? body.github_login.trim() : ''
      if (!login) throw new ApiError(400, '要给 github_login')
      const members = cap.chatType === 'group' ? await feishu.chatMembers(cap.chatId).catch(() => []) : []
      need(cap, 'github:read')
      let r = identities.resolveForChat(login, members)
      // 查不到就顺手拉一次成员对照表再判一次——新人入职、有人刚填上 GitHub 账号，
      // 这种"表里其实已经有了、只是我还没同步"的情况不该回一句"不知道这个人"。
      // 有节流，所以一轮里问好几个陌生登录名也只会打一次表格。
      if (r.kind === 'unknown' && deps.refreshIdentities) {
        await deps.refreshIdentities().catch(() => undefined)
        need(cap, 'github:read')
        r = identities.resolveForChat(login, members)
      }
      if (r.kind === 'resolved' && cap.chatType === 'group') identities.rememberOpenId(r.login, r.openId)
      return { resolution: r }
    },

    'POST /v1/routine/update': async (cap, body) => {
      needDerivedWrite(cap, 'routine:write')
      if (!routines) throw new ApiError(501, '这个部署没有开启定时任务')
      const id = clampInt(body.id, 1, Number.MAX_SAFE_INTEGER, 0)
      const r = routines.get(id)
      if (!r || !routines.canManage(r, { chatId: cap.chatId, chatType: cap.chatType, openId: cap.requesterOpenId })) throw new ApiError(404, '没有这个定时任务，或它不属于当前会话')
      const version = routines.configVersion(id)
      const patch: Parameters<RoutineStore['update']>[1] = {}
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name
      if (typeof body.prompt === 'string' && body.prompt.trim()) patch.prompt = body.prompt
      if (body.every !== undefined) throw new ApiError(400, '频率请使用 schedule 对象，与创建职责的格式相同')
      if (body.schedule !== undefined || body.quiet_hours !== undefined) {
        try {
          patch.schedule = body.schedule === undefined ? { ...r.schedule } : parseSchedule(body.schedule)
          if (body.quiet_hours !== undefined) {
            const quietHours = parseQuietHours(body.quiet_hours)
            if (patch.schedule.type === 'once') throw new Error('一次性提醒请直接指定允许提醒的时间')
            if (quietHours) patch.schedule.quietHours = quietHours
            else delete patch.schedule.quietHours
          } else if (patch.schedule.type !== 'once' && r.schedule.type !== 'once' && r.schedule.quietHours && !patch.schedule.quietHours) {
            patch.schedule.quietHours = r.schedule.quietHours
          }
        } catch (err) { throw new ApiError(400, (err as Error).message) }
      }
      let watch: Awaited<ReturnType<typeof resolveWatchChats>> | undefined
      if (body.chats !== undefined) {
        if (r.kind !== 'watch') throw new ApiError(400, '只有关注职责可以修改群范围')
        watch = await resolveWatchChats(cap, body.chats)
        patch.watchChatIds = watch.chatIds
      }
      if (body.delivery_policy !== undefined) {
        if (r.kind === 'followup') throw new ApiError(400, 'followup 不支持 delivery_policy')
        try { patch.deliveryPolicy = parseDeliveryPolicy(body.delivery_policy) } catch (err) { throw new ApiError(400, (err as Error).message) }
      }
      // G7：阈值与“被 @ 照常运行”只对关注群聊有意义。
      if (body.min_new_messages !== undefined || body.always_on_mention !== undefined) {
        if (r.kind !== 'watch') throw new ApiError(400, TRIGGER_WATCH_ONLY)
        try {
          if (body.min_new_messages !== undefined) patch.minNewMessages = parseMinNewMessages(body.min_new_messages)
          if (body.always_on_mention !== undefined) patch.alwaysOnMention = parseAlwaysOnMention(body.always_on_mention)
        } catch (err) { throw new ApiError(400, (err as Error).message) }
      }
      // 结果存进长期文档还是直接发群里：这是投递偏好，不进 routines 表，也不参与 config_version。
      // 改它不该让已经排好的那一轮作废——人只是说"以后写进文档"，没有改指令或频率。
      let archive: 'chat' | 'doc' | undefined
      if (body.archive !== undefined) {
        if (body.archive !== 'chat' && body.archive !== 'doc') throw new ApiError(400, 'archive 只能是 chat 或 doc')
        if (r.chatType !== 'group' && body.archive === 'doc') throw new ApiError(400, '私聊的结果直接发给你，不另外建归档文档')
        archive = body.archive
      }
      // 归档偏好不进 config_version，卡片上也看不到：提案期间放行，等于让人接受没看到的输出目标
      if (archive !== undefined && r.status === 'proposed') throw new ApiError(409, '提案还没接受，接受后再设置结果存放位置')
      if (!Object.keys(patch).length && archive === undefined) throw new ApiError(400, '没说要改什么（name / prompt / schedule / chats / quiet_hours / delivery_policy / min_new_messages / always_on_mention / archive 至少给一个）')
      watch?.assertCurrent()
      needDerivedWrite(cap, 'routine:write')
      if (routines.configVersion(id) !== version) throw new ApiError(409, '职责已被修改，请回读当前设置再调整')
      const applied = Object.keys(patch).length ? applyRoutineUpdate(id, patch, version, cap.requesterOpenId) : undefined
      const updated = applied?.routine ?? r
      if (!updated) throw new ApiError(404, '改失败')
      if (archive !== undefined) registry.setKv(`routine-archive:${id}`, archive)
      // 提案被改过：修改已提交，再按新内容和新版本刷新提案卡；旧卡从此只能得到“内容已更新”
      const proposal = applied?.proposalChanged ? { card: await refreshProposalCard(id) } : undefined
      return {
        ok: true,
        id,
        name: updated.name,
        delivery_policy: updated.deliveryPolicy,
        schedule_text: describeSchedule(updated.schedule),
        next_run_at: updated.enabled ? new Date(updated.nextRunAt).toISOString() : null,
        watch_chat_ids: updated.watchChatIds,
        enabled: updated.enabled,
        min_new_messages: updated.minNewMessages,
        always_on_mention: updated.alwaysOnMention,
        archive: archive ?? (registry.getKv(`routine-archive:${id}`) === 'doc' ? 'doc' : 'chat'),
        ...(proposal ? { proposal } : {}),
        // 改完让模型能如实说"下一轮什么时候、会变成什么样"，而不是含糊一句"改好了"
        changed: [...Object.keys(patch), ...(archive !== undefined ? ['archive'] : [])],
        // G9：改完与别的职责产出重复的，已记待拍板；模型告诉发起人一声，不自动去重。
        overlaps: (applied?.overlaps ?? []).map(item => ({ id: item.id, version: item.version, title: item.title })),
      }
    },
    'POST /v1/routine/control': async (cap, body) => {
      need(cap, 'routine:write')
      if (!routines) throw new ApiError(501, '这个部署没有开启定时任务')
      const id = clampInt(body.id, 1, Number.MAX_SAFE_INTEGER, 0)
      const r = routines.get(id)
      if (!r || !routines.canManage(r, { chatId: cap.chatId, chatType: cap.chatType, openId: cap.requesterOpenId })) throw new ApiError(404, '没有这个定时任务，或它不属于当前会话')
      const action = body.action
      if (action !== 'pause' && action !== 'resume' && action !== 'delete') throw new ApiError(400, 'action 必须明确为 pause、resume 或 delete')
      // “先停到某天”：暂停并约定恢复时间，周期不变；到点仍走与手动恢复相同的检查。
      let resumeAt: number | undefined
      if (body.resume_at !== undefined && body.resume_at !== null) {
        if (action !== 'pause') throw new ApiError(400, '只有暂停可以设置恢复时间')
        const at = typeof body.resume_at === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(body.resume_at.trim()) ? Date.parse(body.resume_at.trim()) : Number.NaN
        if (!Number.isSafeInteger(at)) throw new ApiError(400, '恢复时间需要带时区的 ISO 时间，例如 2026-09-28T09:00:00+08:00')
        const now = Date.now()
        if (at <= now || at > now + MAX_PAUSE_MS) throw new ApiError(400, '恢复时间须晚于现在，且不超过 90 天')
        resumeAt = at
      }
      if (!deps.controlRoutine) throw new ApiError(503, '职责控制入口尚未就绪')
      try {
        const updated = deps.controlRoutine(id, action, resumeAt === undefined ? {} : { resumeAt })
        recordDomainOperation(cap, { kind: 'routine_control', id, name: r.name, action, enabled: updated?.enabled ?? false })
        return { ok: true, id, name: r.name, action, enabled: updated?.enabled ?? false,
          next_run_at: updated?.enabled ? new Date(updated.nextRunAt).toISOString() : null,
          resume_at: updated && !updated.enabled && updated.resumeAt !== null ? new Date(updated.resumeAt).toISOString() : null }
      } catch (err) {
        if (err instanceof RoutineControlError) throw new ApiError(409, err.message)
        throw err
      }
    },
    'POST /v1/routine/remove': async (cap, body) => {
      need(cap, 'routine:write')
      if (typeof body.disable_only !== 'boolean') throw new ApiError(400, '请明确 disable_only：true 暂停、false 删除；也可使用 routine/control')
      if (!routines) throw new ApiError(501, '这个部署没有开启定时任务')
      const id = clampInt(body.id, 1, Number.MAX_SAFE_INTEGER, 0)
      const r = routines.get(id)
      if (!r || !routines.canManage(r, { chatId: cap.chatId, chatType: cap.chatType, openId: cap.requesterOpenId })) throw new ApiError(404, '没有这个定时任务，或它不属于当前会话')
      if (!deps.stopRoutine) throw new ApiError(503, '职责停止入口尚未就绪')
      deps.stopRoutine(id, body.disable_only === true ? 'pause' : 'remove')
      recordDomainOperation(cap, { kind: 'routine_control', id, name: r.name, action: body.disable_only ? 'pause' : 'delete', enabled: false })
      return { ok: true, id }
    },
  }

  for (const [route, handler] of Object.entries(routes)) {
    routes[route] = async (cap, body) => {
      try { return await githubLane.run(route, cap, () => handler(cap, body)) }
      catch (error) { throw error instanceof GitHubApiError ? toApiError(error) : error }
    }
  }

  let closing = false
  const pendingRequests = new Set<Promise<void>>()
  const drainedObservers = new Set<() => void>()
  const beginShutdown = (): void => { closing = true; deps.preparations?.beginShutdown(); deps.personalMcp?.beginShutdown() }
  const waitForRequestShutdown = (timeoutMs: number): Promise<{ drained: boolean; pending: number }> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.reject(new Error('HTTP shutdown timeout must be finite and non-negative'))
    if (!closing) return Promise.reject(new Error('HTTP shutdown has not started'))
    if (!pendingRequests.size || timeoutMs === 0) return Promise.resolve({ drained: !pendingRequests.size, pending: pendingRequests.size })
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>
      const finish = () => {
        clearTimeout(timer)
        drainedObservers.delete(finish)
        resolve({ drained: !pendingRequests.size, pending: pendingRequests.size })
      }
      timer = setTimeout(finish, timeoutMs)
      drainedObservers.add(finish)
    })
  }
  const waitForShutdown = async (timeoutMs: number): Promise<{ drained: boolean; pending: number }> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !closing) return waitForRequestShutdown(timeoutMs)
    const [requests, preparations, personalMcp] = await Promise.all([waitForRequestShutdown(timeoutMs),
      deps.preparations?.waitForShutdown(Math.floor(timeoutMs)) ?? Promise.resolve({ drained: true, pending: 0 }),
      deps.personalMcp?.waitForShutdown(Math.floor(timeoutMs)) ?? Promise.resolve({ drained: true, pending: 0 })])
    return { drained: requests.drained && preparations.drained && personalMcp.drained, pending: requests.pending + preparations.pending + personalMcp.pending }
  }
  const dispatchRequest = (req: IncomingMessage, res: ServerResponse,
    handler: (req: IncomingMessage, res: ServerResponse, signal: AbortSignal) => void | Promise<void>): void => {
    if (closing) {
      res.setHeader('connection', 'close')
      json(res, 503, { error: '服务正在重启，请稍后重试。' })
      return
    }
    const request = new AbortController()
    const cancel = () => request.abort()
    const closed = () => { if (!res.writableFinished) cancel() }
    // IncomingMessage.close also fires when a normal POST body is fully read.
    // Only premature request/response termination retires this request's lease.
    req.once('aborted', cancel)
    res.once('close', closed)
    if (req.aborted || res.destroyed && !res.writableFinished) cancel()
    // Track the handler, including its final ledger writes, rather than the
    // response/socket. Destroying an HTTP connection cannot cancel its Promise.
    const pending = Promise.resolve().then(() => {
      if (closing) {
        res.setHeader('connection', 'close')
        json(res, 503, { error: '服务正在重启，请稍后重试。' })
        return
      }
      return handler(req, res, request.signal)
    }).catch(error => {
      log.error('HTTP request handler failed', { path: (req.url ?? '').split('?')[0],
        errorType: error instanceof Error ? error.name : typeof error })
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.end()
        else json(res, 500, { error: '服务暂时无法完成请求，请稍后重试。' })
      }
    }).finally(() => {
      req.off('aborted', cancel)
      res.off('close', closed)
      pendingRequests.delete(pending)
      if (!pendingRequests.size) for (const notify of [...drainedObservers]) notify()
    })
    pendingRequests.add(pending)
    // Response I/O itself may fail after a client disconnect; the finally above
    // still owns release, and no detached rejection may skip process shutdown.
    void pending.catch(() => undefined)
  }

  const server = createServer((req, res) => dispatchRequest(req, res, handle))

  /**
   * 只接 OAuth 回调的那一个 server。
   *
   * 内部 API 绑在 127.0.0.1，这是对的——它是全部能力的入口。
   * 但 OAuth 回调是**浏览器**打开的，而浏览器不在这台机器上：
   * 授权走完之后飞书把人送到 `http://127.0.0.1:7788/oauth/callback?code=...`，
   * 那个地址在任何人的电脑上都打不开。真机上就是这样——授权其实成了，
   * 人看到的却是一个打不开的页面，然后只能手动把地址栏的链接复制回来贴给 Friday。
   * 对内部测试还能忍，对外就是每个人都卡在最后一步。
   *
   * 所以回调单独起一个 server，可以绑到别人到得了的地址上，而**只认这一条路径**：
   * 其余一律 404，内部 API 的任何接口都不在这里。回调本来就是公开端点
   * （code 一次性、state 防 CSRF、换 token 还要 app secret），暴露它不等于暴露能力。
   */
  const health = () => ({ ok: true, ...(deps.version ? { version: deps.version } : {}) })
  const callbackServer = createServer((req, res) => dispatchRequest(req, res, async (req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && path === '/oauth/callback') { await oauthCallback(req, res); return }
    if (req.method === 'GET' && path === '/healthz') { json(res, 200, health()); return }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('这里只处理个人授权的回调。')
  }))

  async function handle(req: IncomingMessage, res: ServerResponse, requestSignal: AbortSignal): Promise<void> {
    const started = Date.now()
    const key = `${req.method} ${(req.url ?? '').split('?')[0]}`
    let requestCap: RequestCapability | undefined
    let domainAttempt: { operation: DomainOperationKind; id: number } | undefined
    try {
      if (deps.consoleRouter && await deps.consoleRouter(req, res)) return
      if (key === 'GET /healthz') return json(res, 200, health())
      if (key === 'GET /oauth/callback') return oauthCallback(req, res)
      const handler = routes[key]
      if (!handler) throw new ApiError(404, `未知接口 ${key}`)
      const auth = req.headers.authorization ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      const verified = token ? tokens.verify(token) : undefined
      let cap: RequestCapability | undefined = verified ? { ...verified, requestSignal } : undefined
      if (!cap) throw new ApiError(401, 'capability token 无效或已过期')
      if (deps.resolveActorForSession) {
        assertCurrentRun(cap)
        const actor = deps.resolveActorForSession(cap.sessionKey)
        if (!actor || actor.runId !== cap.runId || actor.requesterOpenId !== cap.requesterOpenId) throw new ApiError(403, '运行实例已变化，请重新发起')
        cap = { ...cap, boundRunId: cap.runId, boundStage: actor.stage, boundControlRevision: actor.controlRevision ?? 0 }
      }
      const body = await readJson(req)
      assertCurrentRun(cap)
      requestCap = cap
      if (deps.preparations || deps.personalMcp) {
        const captured = cap
        const ended = () => invalidatePreparationReturn(captured)
        const cleanup = () => {
          captured.requestSignal?.removeEventListener('abort', ended)
          res.off('finish', cleanup); res.off('close', closed)
        }
        const closed = () => { if (!res.writableFinished) ended(); cleanup() }
        captured.requestSignal?.addEventListener('abort', ended, { once: true })
        res.once('finish', cleanup); res.once('close', closed)
      }
      const operation: DomainOperationKind | undefined = key === 'POST /v1/bug/control' ? 'feedback_control'
        : key === 'POST /v1/bug/intake' ? (body.phase === 'cancelled' ? 'feedback_control' : 'feedback_intake')
          : key === 'POST /v1/bug/update' ? 'feedback_update' : key === 'POST /v1/bug/record' ? 'feedback_record'
            : key === 'POST /v1/bug/reply' ? 'feedback_reply'
              : ['POST /v1/routine/control', 'POST /v1/routine/remove'].includes(key) ? 'routine_control'
                : key === 'POST /v1/decision/resolve' ? 'decision_resolve' : undefined
      const targetId = operation === 'feedback_reply' ? body.question_id : operation === 'feedback_record' ? body.bucket_id : body.id
      if (operation) domainAttempt = { operation, id: typeof targetId === 'number' && Number.isSafeInteger(targetId) && targetId > 0 ? targetId : 0 }
      if (cap.memoryWritePolicy !== undefined && !['POST /v1/memory/search', 'POST /v1/memory/save', 'POST /v1/memory/forget',
        'POST /v1/skill/list', 'POST /v1/skill/load'].includes(key)) {
        throw new ApiError(403, '整理会话只能读取和整理本次授权的记忆')
      }
      const allowedRoutes = deps.allowedRoutesForSession?.(cap.sessionKey)
      if (allowedRoutes !== undefined && !allowedRoutes.includes(key)) throw new ApiError(403, '当前运行阶段不允许调用这个工具')
      if (cap.boundRunId) callIds.set(cap, runCalls.begin(cap.boundRunId, key))
      // 控制动作本身可将本轮切为 feedback_control；完成回执仍属于同一个 Run。
      const result = await withRequestLease(cap.requestSignal, () => handler(cap, body))
      minutesReadGuards.get(cap)?.()
      personalScopeGuards.get(cap)?.()
      publicWebGuards.get(cap)?.()
      readFailureGuards.get(cap)?.assertCurrent()
      // Memory writes may invalidate their own Run after committing. Return only this
      // operation's host-validated receipt; subsequent requests still require a current Run.
      if (key !== 'POST /v1/memory/save' && key !== 'POST /v1/memory/forget') assertCurrentRun(cap)
      if (key === 'POST /v1/memory/search') {
        need(cap, 'memory:read')
        memoryRuntime(cap).recordRead(cap.runId!, [])
      }
      try { deps.materials?.assertReadResult(result) } catch { throw new ApiError(403, '文件来源、授权或内容版本已变化，请重新核验后读取。') }
      const callId = callIds.get(cap)
      if (callId) runCalls.finish(callId, 'returned')
      json(res, 200, result)
      log.debug('api ok', { key, ms: Date.now() - started, session: cap.sessionKey })
    } catch (err) {
      if (requestCap) invalidatePreparationReturn(requestCap)
      const callId = requestCap && callIds.get(requestCap)
      const read = requestCap ? readFailureGuards.get(requestCap) : undefined
      if (requestCap && read && !(err instanceof ApiError)) {
        try {
          read.assertCurrent()
          const failure = providerAccessFailure(err, read.identity)
          if (failure) await readAccessFailure(requestCap, failure, read.purpose, read.extras)
        } catch (classified) { err = classified }
      }
      if (requestCap && domainAttempt) {
        try {
          assertCurrentRun(requestCap)
          recordDomainOperation(requestCap, { kind: 'operation_failed', ...domainAttempt })
        } catch { /* 旧运行或旧控制版本的迟到失败不记到当前请求。 */ }
      }
      const status = err instanceof ApiError ? err.status : err instanceof RequestEndedError ? 499 : err instanceof RuntimeContextError || err instanceof UserMessageReadChanged ? 403 : 500
      const message = err instanceof Error ? err.message : String(err)
      if (status >= 500) log.error('api failed', { key, err })
      else log.warn('api rejected', { key, status, message })
      if (callId) runCalls.finish(callId, 'failed')
      json(res, status, { error: message, ...(err instanceof ApiError && err.failure ? { failure: err.failure } : {}) })
    }
  }

  /** 飞书授权后浏览器跳回这里：换 token、存起来，给用户一个可以关掉的页面。 */
  async function oauthCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const page = (title: string, body: string, status = 200): void => {
      const escape = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
      const html = `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><body style="font-family:system-ui;max-width:32em;margin:4em auto;line-height:1.6"><h2>${escape(title)}</h2><p>${escape(body)}</p></body>`
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" })
      res.end(html)
    }
    if (!userTokens || !deps.oauthRedirectUri) return page('未开启个人授权', '这个 Friday 没有配置 OAuth。', 404)
    // 换 token 那一段是**共用的**（见 connect-completion.ts）：这里只负责把结果讲成一张网页。
    const r = await completeConnection(connectCompletionDeps(userTokens, deps.oauthRedirectUri), {
      code: url.searchParams.get('code') ?? '',
      state: url.searchParams.get('state') ?? undefined,
      error: url.searchParams.get('error') ?? undefined,
    })
    return r.ok ? page(r.title, `${r.detail}可以关掉这个页面回到飞书。`) : page(r.title, r.detail, r.status)
  }

  /** 两个入口共用的那一份依赖。新增入口照着拿，不要自己再拼一遍。 */
  function connectCompletionDeps(store: UserTokenStore, redirectUri: string): ConnectCompletionDeps {
    return {
      userTokens: store,
      redirectUri,
      whoAmI: (accessToken) => feishu.whoAmI(accessToken),
      onCompleted: deps.onAuthorizationCompleted ? (openId) => deps.onAuthorizationCompleted!(openId) : undefined,
      log,
    }
  }

  return { server, callbackServer, routes, beginShutdown, waitForShutdown }
}

const SETTLED_BY_DOMAIN: Record<string, string> = {
  accepted: '提案已被接受', ignored: '提案已被忽略', expired: '提案已过期作废', deleted: '原来的事项已删除',
  no_longer_waiting: '这个人名下已经没有在等授权的关注',
  routine_paused: '那两条职责里已有一条暂停，不再产出重复', routine_deleted: '那两条职责里已有一条删除，不再产出重复',
}
const USE_DOMAIN: Record<string, string> = {
  responsibility: '这是职责提案：请在提案所在的会话里，在提案卡上选“接受”或“忽略”。“定了”不替他判断接受还是忽略；私聊里说的“不用了”也不代替群里的决定。',
  auth: '这是授权提醒：请重新授权，或暂停 / 删除那几条关注。他名下已经没有在等授权的关注时，提醒会自动结清。',
  skill: '这是技能提议：请到技能提议卡上处理。',
  unsupported: '这类事项暂不支持在这里结清。',
}

/** 待拍板事项结清的结果：给模型一句照实转告的话，不透露别人的事项。 */
function presentDecisionResolution(result: Exclude<ResolveDecisionResult, { outcome: 'denied' | 'not_found' }>) {
  const item = result.item
  const base = { outcome: result.outcome, changed: result.changed, id: item.id, version: item.version }
  const said = (resolution: PendingItem['resolution']) => resolution === 'dropped' ? '不用了' : '定了'
  switch (result.outcome) {
    case 'resolved': {
      const paused = result.paused ? `已暂停职责 #${result.paused.id}「${result.paused.name}」（另一条照常运行；恢复用 friday_routine_control）。` : ''
      return { ...base, resolution: item.resolution, note: item.resolutionNote, ...(result.paused ? { paused_routine: { id: result.paused.id, name: result.paused.name } } : {}),
        message: `已结清（${said(item.resolution)}）${item.resolutionNote ? `，结论记为「${item.resolutionNote}」` : ''}。${paused}` }
    }
    case 'needs_choice':
      return { ...base, options: result.options,
        message: `这是两条职责产出重复的问题，结论要是三项之一：${result.options.keep}${result.options.pause.map(r => ` / 暂停 #${r.id}「${r.name}」`).join('')}。没有改动；请问清他选哪一项，把原话写进 note 再结清（dropped = 保留两条）。` }
    case 'settled_by_domain': {
      const why = SETTLED_BY_DOMAIN[item.resolutionNote ?? ''] ?? '原来的事项已经处理过'
      return { ...base, message: result.changed ? `这件事已经不用处理了：${why}，已一并结清。` : `这件事之前就已经不用处理了：${why}。` }
    }
    case 'already_resolved':
      return { ...base, resolution: item.resolution, note: item.resolutionNote, message: '已经按同样的结论处理过，没有改动。' }
    case 'conflict':
      return { ...base, resolution: item.resolution, note: item.resolutionNote, message: `之前已按“${said(item.resolution)}”处理，没有改动。` }
    case 'stale':
      return { ...base, message: '这件事后来又重新在等他了，请先用 friday_decision_list 列出最新的一版再处理。' }
    case 'proposal': {
      const proposal = result.proposal
      const message = proposal.outcome === 'ignored' ? '已忽略这条职责提案，提醒一并结清。'
        : proposal.outcome === 'already_ignored' ? '这条职责提案之前已经忽略了。'
          : proposal.outcome === 'conflict' ? `这条职责提案已被${proposal.current === 'accepted' ? '接受' : '忽略'}，没有改动。`
            : proposal.outcome === 'expired' ? '这条职责提案已经过期作废了。'
              : proposal.outcome === 'stale_card' ? '提案内容刚被改过，请在提案卡上看清新内容后再处理。'
                : proposal.outcome === 'denied' ? `不能替这条职责提案做决定：${proposal.reason}`
                  : '找不到这条职责提案。'
      return { ...base, proposal: { outcome: proposal.outcome, ...(proposal.outcome === 'denied' ? { code: proposal.code } : {}) }, message }
    }
    case 'use_domain':
      return { ...base, domain: result.domain.kind, message: USE_DOMAIN[result.domain.kind] ?? USE_DOMAIN.unsupported }
  }
}

function parseRepo(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const m = v.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined
}

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  if (err instanceof ChangeAccessError) return new ApiError(403, err.message)
  if (err instanceof RepositoryExecutionError) return new ApiError(409, err.message)
  if (err instanceof GitHubApiError) return new ApiError(err.status === 404 ? 404 : err.status === 403 || err.status === 401 ? 403 : 502, `GitHub：${err.message}`)
  return new ApiError(502, `GitHub：${err instanceof Error ? err.message : String(err)}`)
}

/** 用户原话里明确不提供的材料类别；只接受固定取值，不解析自由文字。 */
function declinedInfoInput(value: unknown): BugDeclinableInfoKind[] {
  if (value === undefined) return []
  const invalid = `declined_info 需要最多 4 项的列表，取值为 ${DECLINABLE_INFO_KINDS.join('、')}`
  if (!Array.isArray(value) || value.length > 4) throw new ApiError(400, invalid)
  try { return declinedKinds(value) } catch { throw new ApiError(400, invalid) }
}

function infoKindInput(value: unknown): BugInfoKind | undefined {
  if (value === undefined) return undefined
  if (!isBugInfoKind(value)) throw new ApiError(400, `info_kind 必须是 ${BUG_INFO_KINDS.join('、')} 之一`)
  return value
}

function declinedLabels(entries: readonly Pick<BugDeclinedInfo, 'kind'>[]): string {
  return [...new Set(entries.map((entry) => INFO_KIND_LABELS[entry.kind]))].join('、')
}

function declinedNote(entries: readonly BugDeclinedInfo[]): string {
  return entries.length ? `用户已表示不提供：${declinedLabels(entries)}；宿主会拒绝同类补问，不再索要。` : ''
}


function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\0-]/g, '_').slice(0, 120) || 'file'
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > 1_000_000) throw new ApiError(413, '请求体过大')
    chunks.push(buf)
  }
  if (!chunks.length) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON')
  }
}

export function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** 接受 ISO 字符串、秒或毫秒时间戳；返回秒。 */
export function parseTimeSec(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v)
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return parseTimeSec(Number(v))
    const ms = Date.parse(v)
    if (Number.isFinite(ms)) return Math.floor(ms / 1000)
  }
  throw new ApiError(400, `无法解析时间：${String(v)}`)
}
