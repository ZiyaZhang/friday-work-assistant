#!/usr/bin/env node
// Schema-only adapter. Never boot the app or invoke task/delivery recovery.
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const supplied = process.argv[2]
if (!supplied || lstatSync(supplied).isSymbolicLink()) throw new Error('Expected migration-guard candidate copy')
const candidate = realpathSync(supplied), runDir = dirname(candidate)
if (basename(candidate) !== 'candidate.db' || !basename(runDir).startsWith('verification-') || !existsSync(join(dirname(runDir), 'backup-receipt.json'))) {
  throw new Error('Only a migration-guard candidate copy may be upgraded')
}
const repo = fileURLToPath(new URL('..', import.meta.url)), req = createRequire(join(repo, 'package.json'))
const { register } = await import(pathToFileURL(req.resolve('tsx/esm/api')).href)
register()
const [{ Registry }, { IngressReceipts }, { RunAttempts }, { ChannelMemory }, { SkillProposals },
  { ConsoleSessionStore }, { ConsoleOperations }, { RunModels }, { RuntimeContexts }, { ExecutionMaterials }, { ensureDeliverySchema }, { RoutineStore }, { IssueLinks }, { ChatReadScope }, { PmoStore }, { IssueValidityRequests }, { TaskQuota }, { IssueWatch },
  { ensureUserTokenSchema }, { WorkAccessWaits }, { RunApiCalls }, { Todos }, { MessageCache }, { ensureGitHubChangeSchema },
  { TaskEvents }, { ensureFeishuTaskSyncSchema }, { Inbox }, { ensureTodoCompletionEvidenceSchema }, { ensureKudosSchema }, { ensureGitHubExecutionSchema }, { ensureGitHubCiFollowupSchema }, { ensureGitHubIssueFollowupSchema }, { MeetingSessions }, { ensurePollSchema }] = await Promise.all([
  import(pathToFileURL(join(repo, 'src/core/registry.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/ingress.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/run-attempts.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/memory.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/skills.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/console-sessions.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/console-operations.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/run-models.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/runtime-contexts.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/execution-materials.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/delivery.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/routines.ts')).href),
  import(pathToFileURL(join(repo, 'src/github/issues.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/chat-read-scope.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/pmo.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/issue-validity.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/task-quota.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/issue-watch.ts')).href),
  import(pathToFileURL(join(repo, 'src/feishu/oauth.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/work-access-waits.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/run-api-calls.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/todos.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/message-cache.ts')).href),
  import(pathToFileURL(join(repo, 'src/github/changes.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/task-events.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/feishu-task-sync.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/inbox.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/todo-completion-evidence.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/kudos.ts')).href),
  import(pathToFileURL(join(repo, 'src/github/executions.ts')).href),
  import(pathToFileURL(join(repo, 'src/github/ci-followups.ts')).href),
  import(pathToFileURL(join(repo, 'src/github/issue-followups.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/meeting-sessions.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/polls.ts')).href),
])
// Feedback cases and questions (P3-1) are imported separately so the shared destructuring above stays unchanged.
const [{ Bugs }, { BugQuestions }] = await Promise.all([
  import(pathToFileURL(join(repo, 'src/core/bugs.ts')).href),
  import(pathToFileURL(join(repo, 'src/core/bug-questions.ts')).href),
])
// Minutes action-item drafts (P5-3b), imported separately for the same reason.
const { ensureMinutesDraftSchema } = await import(pathToFileURL(join(repo, 'src/core/minutes-drafts.ts')).href)
// Reported refs (P4-2 G8), imported separately for the same reason.
const { ensureReportedRefsSchema } = await import(pathToFileURL(join(repo, 'src/core/reported-refs.ts')).href)
// Issue assessment ledger (P3-3a), imported separately for the same reason.
const { WorkAssessments } = await import(pathToFileURL(join(repo, 'src/core/work-assessment.ts')).href)
const { PersonalCollectionStore } = await import(pathToFileURL(join(repo, 'src/core/personal-collection.ts')).href)
const { ensureGitHubUserSchema } = await import(pathToFileURL(join(repo, 'src/github/user-connection.ts')).href)
const { ensurePersonalAssistanceSchema } = await import(pathToFileURL(join(repo, 'src/core/personal-assistance.ts')).href)
const { ensureGmailSchema } = await import(pathToFileURL(join(repo, 'src/gmail/connection.ts')).href)
const { ensureMailboxSchema } = await import(pathToFileURL(join(repo, 'src/gmail/mailbox.ts')).href)
const { ensureEmailDraftSchema } = await import(pathToFileURL(join(repo, 'src/gmail/drafts.ts')).href)
const { ensurePersonalMcpSchema } = await import(pathToFileURL(join(repo, 'src/personal/mcp-connections.ts')).href)
const { ensurePersonalDeviceSchema } = await import(pathToFileURL(join(repo, 'src/personal/devices.ts')).href)
const { ensurePersonalResultSchema } = await import(pathToFileURL(join(repo, 'src/personal/results.ts')).href)
const { ensurePersonalInputSchema } = await import(pathToFileURL(join(repo, 'src/personal/conversation.ts')).href)
const { ensureLocalWorkSchema } = await import(pathToFileURL(join(repo, 'src/personal/local-work.ts')).href)
const registry = new Registry(candidate)
try {
  new IngressReceipts(registry.db)
  new RunAttempts(registry.db)
  // Includes migrateMemoryProvenance; constructors only, no application startup.
  new ChannelMemory(registry.db)
  new SkillProposals(registry.db)
  const sessions = new ConsoleSessionStore(registry.db)
  new ConsoleOperations(registry.db, { sessions })
  new RunModels(registry.db)
  new RuntimeContexts(registry.db)
  new ExecutionMaterials(registry.db, join(runDir, 'materials'))
  // Registry already ran the WorkContexts backfill; the delivery ledger only gains its additive reconciliation column.
  ensureDeliverySchema(registry.db)
  // Occurrence window identity: additive columns, SQL backfill from scheduled_at, duplicate marking, partial unique index.
  // Also adds nullable followup origin_task_id; legacy origins remain unknown (no backfill).
  new RoutineStore(registry.db)
  // GitHub issue ledger: additive reconciliation column only; unresolved creations stay unknown until a real read-back.
  new IssueLinks(registry.db)
  // Per-chat read exclusions: a new empty table; an empty table means nothing is excluded.
  new ChatReadScope(registry.db)
  // Unknown PMO writes gain an empty durable reconciliation ledger; never read or write Feishu here.
  new PmoStore(registry.db)
  // Empty issue validity ledger only: no model evaluation, recovery, platform access or old-row changes.
  new IssueValidityRequests(registry.db)
  // No historic usage is invented: this ledger starts empty.
  new TaskQuota(registry.db)
  // Empty assessment-attempt ledger only; no issue scans or model calls.
  new IssueWatch(registry.db)
  // Persist grant attempts, original-work authorization waits and before-handler
  // effect receipts. Constructors only: never poll callbacks or resume old work.
  ensureUserTokenSchema(registry.db)
  new WorkAccessWaits(registry.db, registry.workContexts)
  new RunApiCalls(registry.db)
  // Schema only; never prepare a checkout, recover a task or contact GitHub.
  ensureGitHubChangeSchema(registry.db)
  // Empty provider-operation ledger only; never start/replay an execution.
  ensureGitHubExecutionSchema(registry.db)
  ensureGitHubCiFollowupSchema(registry.db)
  ensureGitHubIssueFollowupSchema(registry.db)
  new TaskEvents(registry)
  // Nullable creation provenance only; old Todos retain their content and unknown origins.
  const todos = new Todos(registry.db)
  // Add empty collection state only. Never enable anyone or infer historical tasks during migration.
  new PersonalCollectionStore(registry.db, todos)
  ensurePersonalAssistanceSchema(registry.db)
  ensureGitHubUserSchema(registry.db)
  ensureGmailSchema(registry.db)
  ensureMailboxSchema(registry.db)
  ensureEmailDraftSchema(registry.db)
  ensurePersonalMcpSchema(registry.db)
  ensurePersonalDeviceSchema(registry.db)
  ensurePersonalResultSchema(registry.db)
  ensurePersonalInputSchema(registry.db)
  ensureLocalWorkSchema(registry.db)
  // Preserve existing bodies and coverage; old rows have unknown platform location.
  new MessageCache(registry.db)
  // Native Task mirror, created unconditionally like github_executions (startup creates it only when FRIDAY_FEISHU_TASKS=1).
  // Link/operation ledgers only; never a Feishu call. Old links gain nullable columns and generation 0, operations attempts 1.
  ensureFeishuTaskSyncSchema(registry.db)
  // Pending-decision pointers gain version/resolution columns; old rows keep version 1 and no recorded resolution.
  new Inbox(registry.db)
  // Evidence already used to mark a Todo done: a new empty table; no Todo is assessed or changed here.
  ensureTodoCompletionEvidenceSchema(registry.db)
  // Proactive-check kudos ledger (message_kudos): a new empty table; the Orchestrator creates it at startup. No Feishu call.
  ensureKudosSchema(registry.db)
  // Meeting attendance (meeting_sessions, meeting_drafts): two new empty tables and one index. The constructor only creates
  // them, as startup does whether or not FRIDAY_MEETINGS is on; never joins, syncs, drafts or calls Feishu.
  new MeetingSessions(registry.db)
  // Demand polls (polls, poll_ballots, poll_read_snapshots): new empty tables and two indexes. Created unconditionally,
  // as startup does whether or not FRIDAY_POLLS is on; never closes polls, handles callbacks or calls Feishu.
  ensurePollSchema(registry.db)
  // Feedback cases gain declined_info (NOT NULL DEFAULT '[]') and questions a nullable info_kind; old rows are never backfilled.
  // Constructors only: no question is sent, recovered, answered or cancelled here (recoverUnsent is a startup call, not run).
  new BugQuestions(registry.db, new Bugs(registry.db))
  // Minutes action-item drafts (minutes_drafts): one new empty table and one index, created unconditionally as startup does.
  // Schema only: no Minutes read, draft, Todo or message; appended last so every earlier statement keeps its order.
  ensureMinutesDraftSchema(registry.db)
  // Reported refs (reported_refs, P4-2 G8): one new empty table, created at startup by the Orchestrator constructor.
  // Schema only: no reminder is sent or recorded here. The two routines columns (min_new_messages, always_on_mention)
  // are added by the RoutineStore constructor above. Appended last so every earlier statement keeps its order.
  ensureReportedRefsSchema(registry.db)
  // Issue assessment ledger (work_assessments): one new empty table, created unconditionally at startup (src/index.ts). The
  // constructor only creates the schema; recoverInterrupted() is a startup call and is not run here. No model call, no GitHub read.
  new WorkAssessments(registry.db)
}
finally { registry.close() }
process.stdout.write('{"schema_only_upgrade":"C1b+C2+C3+E1+E2+execution-materials+work-contexts+delivery-reconciliation+routine-windows+github-reconciliation+chat-read-scope+pmo-projection-writes+issue-validity-requests","completed":true}\n')
