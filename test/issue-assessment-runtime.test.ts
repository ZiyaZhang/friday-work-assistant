import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { TaskEvents, validTaskEventDispatch } from '../src/core/task-events.js'
import { Spaces } from '../src/core/space.js'
import { PolicyService } from '../src/core/policy.js'
import { WorkAssessments, type WorkAssessmentExecution, type WorkAssessmentRecord } from '../src/core/work-assessment.js'
import { IssueAssessmentApplication, type IssueAssessmentSourceLease } from '../src/core/issue-assessment-application.js'
import { IssueAssessmentRuntime, type IssueAssessmentActor, type IssueAssessmentIntent } from '../src/core/issue-assessment-runtime.js'
import { createIssueAssessmentRoutes } from '../src/internal/issue-assessment-routes.js'
import { registerIssueAssessmentTools } from '../src/mcp/issue-assessment-tools.js'
import { withRequestLease, currentRequestSignal } from '../src/core/request-lease.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import type { UpdateListener } from '../src/acp/runtime.js'
import type { Capability } from '../src/internal/tokens.js'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function fixture(intent: IssueAssessmentIntent = 'assess_only') {
  const registry = new Registry(':memory:'); cleanup.push(() => registry.close())
  const now = Date.parse('2026-09-22T12:00:00Z'), spaces = new Spaces(registry.db), policy = new PolicyService(spaces, { admins: [] })
  const space = spaces.ensure({ kind: 'group', chatId: 'group-a', openId: 'alice' })
  const session = registry.createSession({ sessionKey: 'source-a', chatId: 'group-a', chatType: 'group', requesterOpenId: 'alice', cwd: '/unused' })
  const inbound: InboundMessage = { messageId: 'om_origin', eventId: 'evt_origin', senderType: 'user', senderOpenId: 'alice',
    chatId: session.chatId, chatType: 'group', msgType: 'text', text: '原始评估或修复委托', mentions: [], createTimeMs: now }
  const task = registry.createTaskOnce({ sessionKey: session.sessionKey, requesterOpenId: 'alice', messageId: inbound.messageId, prompt: inbound.text, inbound }).task
  const attempts = new RunAttempts(registry.db), assessments = new WorkAssessments(registry.db, () => now)
  const run = attempts.begin({ taskId: task.id, sessionKey: session.sessionKey, workKey: registry.taskWork.get(task.id)!.key,
    actorOpenId: 'alice', triggerKey: `task:${task.id}`, stage: 'task', now })!
  let actor: IssueAssessmentActor = { taskId: task.id, sessionKey: session.sessionKey, runId: run.id, actorOpenId: 'alice', spaceId: space.id }
  const state = { live: true, sources: true, intent, invalidOutput: false, snapshotChanged: false, wakeSignal: undefined as AbortSignal | undefined }
  const sources: IssueAssessmentSourceLease = { context: { version: 1, acpSessionId: 'parent-acp', spaceId: space.id, chatId: space.chatId!,
    memoryScopes: [], chats: [], external: [], repositories: [] }, assertCurrent() { if (!state.sources) throw new Error('source revoked') } }
  registry.setKv(`issue-watch:${space.id}`, JSON.stringify({ spaceId: space.id, boundBy: 'alice', repo: 'org/demo', since: now - 30 * 86400_000,
    labels: [], version: 'version-1' }))
  const raw = { number: 7, title: 'Plugin broken', body: 'Reproducible with the supplied sample.', state: 'open', assignees: [], labels: [], comments: 0,
    user: { login: 'reporter' }, created_at: new Date(now - 10 * 86400_000).toISOString(), updated_at: new Date(now - 3 * 86400_000).toISOString() }
  const github = { repoAllowed: (repo: string) => repo === 'org/demo', api: vi.fn(async (_method: string, path: string, _body: unknown, _owner: string, check?: () => void) => {
    check?.()
    if (path.includes('/comments?') || path.includes('/timeline?')) return []
    return { ...raw, ...(state.snapshotChanged ? { body: 'The issue has changed since assessment.' } : {}) }
  }) } as unknown as Pick<GitHubIdentity, 'api' | 'repoAllowed'>
  let listener: UpdateListener | undefined, sequence = 0
  const execution: WorkAssessmentExecution = { prepare: vi.fn(async () => ({ runId: `private-run-${++sequence}`, sessionKey: `private-session-${sequence}`,
    acpSessionId: `private-acp-${sequence}`, mode: 'managed', fresh: true, assertCurrent() {} })), modeForSession: () => 'managed',
    subscribe: (_id, value) => { listener = value; return () => { listener = undefined } }, finish: vi.fn(async () => {}),
    prompt: vi.fn(async (_prepared, content, options) => {
      options.beforeDispatch?.()
      const text = content[0]!.type === 'text' ? content[0]!.text : '', snapshot = JSON.parse(text.split('\n').at(-1)!).snapshot
      listener?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: state.invalidOutput ? 'invalid json'
        : JSON.stringify({ verdict: 'recommend', summary: 'The supplied reproduction is concrete.',
          evidence: [{ ref: snapshot.sources.find((source: { ref: string }) => source.ref.endsWith(':body')).ref, quote: raw.body }],
          missingInfo: [], proposedAction: { kind: 'develop_change', targetRef: snapshot.targets[0].ref } }) } }, {} as never)
      return { stopReason: 'end_turn' }
    }) }
  const application = new IssueAssessmentApplication({ registry, spaces, policy, github, assessments, execution, now: () => now,
    assertSpaceCurrent() { if (!state.live) throw new Error('space changed') } })
  const assertCurrent = (value: IssueAssessmentActor) => { if (!state.live || JSON.stringify(value) !== JSON.stringify(actor)) throw new Error('host lease changed') }
  const captureSources = vi.fn(async (_value: IssueAssessmentActor, previous?: WorkAssessmentRecord) => {
    return { context: structuredClone(previous?.request.origin?.sources ?? sources.context), assertCurrent: sources.assertCurrent }
  })
  const intentFor = vi.fn(async () => state.intent), read = vi.fn(), wake = vi.fn(() => { state.wakeSignal = currentRequestSignal() })
  const deps = { registry, assessments, application, assertCurrent, captureSources, executionIntent: intentFor,
    recordRepositoryRead: read, wakeQueuedTask: wake }
  const runtime = new IssueAssessmentRuntime(deps)
  const confirm = () => {
    attempts.finish(actor.runId, 'completed', now, 'end_turn')
    const next = registry.createTaskOnce({ sessionKey: session.sessionKey, requesterOpenId: 'alice', messageId: 'om_approval',
      prompt: '真实批准这份评估', amendsTaskId: task.id, inbound: { ...inbound, messageId: 'om_approval', text: '真实批准这份评估' } }).task
    const run = attempts.begin({ taskId: next.id, sessionKey: session.sessionKey, workKey: registry.taskWork.get(next.id)!.key,
      actorOpenId: 'alice', triggerKey: `task:${next.id}`, stage: 'task', now: now + 1 })!
    actor = { ...actor, taskId: next.id, runId: run.id }; state.intent = 'human_confirmation'
  }
  return { registry, space, task, inbound, attempts, assessments, state, sources, execution, application, runtime, deps, captureSources, intentFor,
    read, wake, confirm, get actor() { return actor } }
}

describe('real input → isolated assessment → same-Work durable execution runtime', () => {
  it('keeps recommendation read-only, queryable and idempotent for repeated tools', async () => {
    const t = fixture(), result = await t.runtime.assess(t.actor, 7)
    expect(result).toMatchObject({ state: 'completed', requiresExecutionAuthorization: true, handoff: null })
    expect(await t.runtime.assess(t.actor, 7)).toEqual(result)
    expect(await t.runtime.get(t.actor, result.assessmentId)).toEqual(result)
    expect(t.execution.prompt).toHaveBeenCalledTimes(1); expect(t.wake).not.toHaveBeenCalled()
    expect(t.registry.listTasks(t.actor.sessionKey)).toHaveLength(1)
    await expect(t.runtime.execute(t.actor, result.assessmentId)).rejects.toThrow('not_authorized')
  })
  it('original explicit repair authority hands off once, keeps original input, and detaches the queue from HTTP cancellation', async () => {
    const t = fixture('execute_if_suitable'), request = new AbortController()
    const result = await withRequestLease(request.signal, () => t.runtime.assess(t.actor, 7))
    expect(result).toMatchObject({ state: 'handed_off', requiresExecutionAuthorization: false, handoff: { taskStatus: 'queued' } })
    const next = t.registry.getTask(result.handoff!.taskId)!
    expect(t.registry.taskWork.get(next.id)?.key).toBe(t.registry.taskWork.get(t.task.id)?.key)
    const dispatch = t.registry.dispatches.get(next.id)!
    expect(dispatch.inbound.senderType).toBe('bot')
    expect(dispatch.inbound.messageId).toBe(next.messageId)
    expect(validTaskEventDispatch(t.registry.db, next.id, dispatch.inbound)).toBe(true)
    expect(new TaskEvents(t.registry).get(next.id)?.sourceTaskId).toBe(t.task.id)
    expect(next.prompt).toContain(result.assessmentId); expect(next.prompt).toContain(result.snapshotDigest)
    expect(t.assessments.forHandoff(next.id)?.id).toBe(result.assessmentId)
    expect(t.state.wakeSignal).toBeUndefined()
    expect(await t.runtime.assess(t.actor, 7)).toEqual(result)
    expect(t.registry.listTasks(t.actor.sessionKey)).toHaveLength(2); expect(t.execution.prompt).toHaveBeenCalledTimes(1)
    // Projection follows actual Task status, not an immutable 'queued' label.
    t.registry.updateTask(next.id, { status: 'done' })
    expect((await t.runtime.get(t.actor, result.assessmentId)).handoff?.taskStatus).toBe('done')
  })
  it('reconstructs a committed handoff after queue wakeup failed without creating another Task or buying another evaluation', async () => {
    const t = fixture('execute_if_suitable')
    t.wake.mockImplementationOnce(() => { throw new Error('queue temporarily unavailable') })
    await expect(t.runtime.assess(t.actor, 7)).rejects.toThrow('queue temporarily unavailable')
    const original = t.assessments.forTaskIssue(t.task.id, 'org/demo', 7)!
    expect(original.state).toBe('handed_off'); expect(original.handoff).not.toBeNull()
    const restarted = new IssueAssessmentRuntime({ ...t.deps, assessments: new WorkAssessments(t.registry.db) })
    const result = await restarted.assess(t.actor, 7)
    expect(result.handoff?.taskId).toBe(original.handoff!.taskId)
    expect(t.registry.listTasks(t.actor.sessionKey)).toHaveLength(2)
    expect(t.execution.prompt).toHaveBeenCalledTimes(1)
    expect(t.wake).toHaveBeenLastCalledWith(original.handoff!.taskId)
  })
  it('later explicit confirmation binds the exact assessment and a real same-Work input, not another target', async () => {
    const t = fixture(), result = await t.runtime.assess(t.actor, 7); t.confirm()
    const done = await t.runtime.execute(t.actor, result.assessmentId)
    expect(done.state).toBe('handed_off')
    const event = new TaskEvents(t.registry).get(done.handoff!.taskId)!
    expect(t.registry.getTask(event.sourceTaskId)?.messageId).toBe('om_approval')
    expect(t.registry.listTasks(t.actor.sessionKey)).toHaveLength(3)
    expect(t.execution.prompt).toHaveBeenCalledTimes(1)
  })
  it('a real event execution can resume its original dispatch after host interruption without a forged human message', async () => {
    const t = fixture('execute_if_suitable'), result = await t.runtime.assess(t.actor, 7), next = t.registry.getTask(result.handoff!.taskId)!
    t.attempts.finish(t.actor.runId, 'completed', Date.now(), 'end_turn')
    const run = t.attempts.begin({ taskId: next.id, sessionKey: next.sessionKey, workKey: t.registry.taskWork.get(next.id)!.key,
      actorOpenId: 'alice', triggerKey: `task:${next.id}`, stage: 'task', now: Date.now() })!
    t.registry.startTask(next.id, Date.now(), next.sessionKey)
    t.attempts.interruptActive(Date.now())
    t.registry.updateTask(next.id, { status: 'failed', stopReason: 'gateway_shutdown' })
    expect(t.registry.dispatches.resume(next.id, { previousRunId: run.id, reason: 'restart' }, Date.now())).toBe(true)
    expect(t.registry.dispatches.get(next.id)).toMatchObject({ generation: 1, inbound: { senderType: 'bot', messageId: next.messageId } })
    t.registry.workContexts.control(t.registry.taskWork.get(t.task.id)!.key, { action: 'cancel', causeRef: 'real-stop' })
    expect(validTaskEventDispatch(t.registry.db, next.id, t.registry.dispatches.get(next.id)!.inbound)).toBe(false)
  })
  it('does not manufacture an input or buy an evaluation for an unapproved scheduled scan', async () => {
    const t = fixture()
    expect(await t.runtime.assessScannedIssue({ number: 7 })).toMatchObject({ status: 'needs_authorization' })
    expect(t.execution.prompt).not.toHaveBeenCalled(); expect(t.registry.listTasks(t.actor.sessionKey)).toHaveLength(1)
  })
  it('retains invalid-result failure and does not purchase it again', async () => {
    const t = fixture(); t.state.invalidOutput = true
    await expect(t.runtime.assess(t.actor, 7)).rejects.toThrow('invalid_result')
    const repeated = await t.runtime.assess(t.actor, 7)
    expect(repeated).toMatchObject({ state: 'failed', failure: 'invalid_result', handoff: null })
    expect(t.execution.prompt).toHaveBeenCalledTimes(1)
  })
  it.each(['source', 'actor', 'work', 'thread'] as const)('does not hand off after %s authority/evidence changes', async kind => {
    const t = fixture(), result = await t.runtime.assess(t.actor, 7); t.confirm()
    if (kind === 'source') t.state.sources = false
    if (kind === 'actor') t.state.live = false
    if (kind === 'work') t.registry.workContexts.control(t.registry.taskWork.get(t.task.id)!.key, { action: 'cancel', causeRef: 'real-stop' })
    if (kind === 'thread') t.state.snapshotChanged = true
    await expect(t.runtime.execute(t.actor, result.assessmentId)).rejects.toThrow()
    expect(t.wake).not.toHaveBeenCalled(); expect(t.registry.listTasks(t.actor.sessionKey)).toHaveLength(2)
  })
  it('rejects another actor or unrelated Work before returning proposal contents', async () => {
    const t = fixture(), result = await t.runtime.assess(t.actor, 7)
    await expect(t.runtime.get({ ...t.actor, actorOpenId: 'mallory' }, result.assessmentId)).rejects.toThrow()
    const foreign = { ...t.assessments.get(result.assessmentId)!.request, assessmentKey: 'foreign', actorOpenId: 'mallory' }
    const record = t.assessments.reserve(foreign, t.assessments.get(result.assessmentId)!.snapshot).record
    await expect(t.runtime.get(t.actor, record.id)).rejects.toThrow('not_authorized')
  })
  it('does not wake a new execution when the original request is cancelled during source authorization', async () => {
    const t = fixture('execute_if_suitable'), abort = new AbortController()
    t.captureSources.mockImplementationOnce(async () => { abort.abort(); return t.sources })
    await expect(withRequestLease(abort.signal, () => t.runtime.assess(t.actor, 7))).rejects.toThrow()
    expect(t.execution.prompt).not.toHaveBeenCalled(); expect(t.wake).not.toHaveBeenCalled()
  })
  it('real MCP tools expose strict reference inputs, never host identity, intent, repository or approval booleans', async () => {
    const t = fixture(), cap = { sessionKey: t.actor.sessionKey, runId: t.actor.runId, chatId: 'group-a', chatType: 'group',
      requesterOpenId: 'alice', spaceId: t.space.id, scopes: ['github:read'], exp: 9999999999 } as Capability
    // The leaf modules default to the read-only pair; this protocol test opts all three in, as the P3-3b root will.
    const routes = createIssueAssessmentRoutes({ runtime: t.runtime, requireActor: () => t.actor, assertCurrent() {},
      error: (_status, message) => new Error(message), operations: ['assess', 'get', 'execute'] })
    const server = new McpServer({ name: 'assessment-protocol', version: '1' }), client = new Client({ name: 'test', version: '1' })
    registerIssueAssessmentTools(server, (path, body) => routes[`POST ${path}`]!(cap, body), error => ({ isError: true,
      content: [{ type: 'text', text: String(error) }] }), ['assess', 'get', 'execute'])
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    cleanup.push(async () => { await client.close(); await server.close() })
    const result = await client.callTool({ name: 'github_assess_issue', arguments: { number: 7 } })
    expect(result.isError).not.toBe(true)
    const record = JSON.parse((result.content as { text: string }[])[0]!.text)
    expect(record.requiresExecutionAuthorization).toBe(true)
    expect((await client.callTool({ name: 'github_execute_assessment', arguments: { assessmentId: record.assessmentId } })).isError).toBe(true)
    for (const extra of [{ approved: true }, { repo: 'other/private' }, { actorOpenId: 'mallory' }, { intent: 'execute_if_suitable' }]) {
      await expect(routes['POST /v1/github/assessment/assess']!(cap, { number: 7, ...extra })).rejects.toThrow('参数无效')
    }
    expect(t.execution.prompt).toHaveBeenCalledTimes(1); expect(t.wake).not.toHaveBeenCalled()
  })
})

describe('confirmation card click → same-Work handoff → handoff Task admission (P3-3b)', () => {
  /** Host deps the P3-3b root supplies: the delivered card (from the delivery ledger) and a lease over the saved origin sources. */
  const withCard = (t: ReturnType<typeof fixture>, card: { status: 'sent' | 'unknown'; remoteId: string | null } | null = { status: 'sent', remoteId: 'om_card' }) => {
    const retainedSources = vi.fn(async (record: WorkAssessmentRecord) => ({ context: structuredClone(record.request.origin!.sources), assertCurrent: t.sources.assertCurrent }))
    const runtime = new IssueAssessmentRuntime({ ...t.deps, retainedSources, confirmationCard: () => card ?? undefined })
    return { runtime, retainedSources }
  }
  const click = (assessmentId: string, operatorOpenId = 'alice', cardMessageId = 'om_card') => ({ assessmentId, operatorOpenId, chatId: 'group-a', cardMessageId })
  it('the original requester’s click on the delivered card hands off once into the original Work with the original Task as source', async () => {
    const t = fixture(), { runtime } = withCard(t), result = await runtime.assess(t.actor, 7)
    expect(result).toMatchObject({ state: 'completed', confirmationCard: 'sent', handoff: null })
    const done = await runtime.confirm(click(result.assessmentId))
    expect(done).toMatchObject({ state: 'handed_off', requiresExecutionAuthorization: false, handoff: { taskStatus: 'queued' } })
    const event = new TaskEvents(t.registry).get(done.handoff!.taskId)!
    expect(event).toMatchObject({ kind: 'issue_assessment', sourceTaskId: t.task.id, domainId: result.assessmentId, key: `assessment:${result.assessmentId}:execute` })
    expect(t.registry.taskWork.get(done.handoff!.taskId)?.key).toBe(t.registry.taskWork.get(t.task.id)?.key)
    expect(t.registry.getTask(done.handoff!.taskId)!.prompt).toContain('card:om_card')
    expect(await runtime.confirm(click(result.assessmentId))).toEqual(done)
    expect(t.registry.listTasks(t.actor.sessionKey)).toHaveLength(2)
    expect(t.wake).toHaveBeenLastCalledWith(done.handoff!.taskId)
    expect(t.execution.prompt).toHaveBeenCalledTimes(1)
  })
  it('refuses another person, another message, an undelivered card and a changed thread', async () => {
    const t = fixture(), { runtime } = withCard(t), result = await runtime.assess(t.actor, 7)
    await expect(runtime.confirm(click(result.assessmentId, 'bob'))).rejects.toThrow('not_authorized')
    await expect(runtime.confirm(click(result.assessmentId, 'alice', 'om_other'))).rejects.toThrow('not_authorized')
    await expect(withCard(t, { status: 'unknown', remoteId: null }).runtime.confirm(click(result.assessmentId))).rejects.toThrow('not_authorized')
    await expect(withCard(t, null).runtime.confirm(click(result.assessmentId))).rejects.toThrow('not_authorized')
    t.state.snapshotChanged = true
    await expect(runtime.confirm(click(result.assessmentId))).rejects.toThrow('thread_changed')
    expect(t.registry.listTasks(t.actor.sessionKey)).toHaveLength(1); expect(t.wake).not.toHaveBeenCalled()
    expect(t.assessments.get(result.assessmentId)?.state).toBe('completed')
  })
  it('a tool call with the host’s card confirmation returns the same Task; without it the call is refused', async () => {
    const t = fixture(), { runtime } = withCard(t), result = await runtime.assess(t.actor, 7)
    await expect(runtime.execute(t.actor, result.assessmentId)).rejects.toThrow('not_authorized')
    const done = await runtime.confirm(click(result.assessmentId))
    t.state.intent = 'human_confirmation'
    expect((await runtime.execute(t.actor, result.assessmentId)).handoff?.taskId).toBe(done.handoff!.taskId)
    expect(t.registry.listTasks(t.actor.sessionKey)).toHaveLength(2)
  })
  it('admits the handoff Task only while its event row, binding and original sources are current', async () => {
    const t = fixture(), { runtime, retainedSources } = withCard(t), result = await runtime.assess(t.actor, 7)
    const done = await runtime.confirm(click(result.assessmentId)), taskId = done.handoff!.taskId
    await expect(runtime.admitHandoffTask(t.task.id)).rejects.toThrow('not_current')
    const admission = await runtime.admitHandoffTask(taskId)
    expect(admission.record).toMatchObject({ id: result.assessmentId, state: 'handed_off', handoff: { taskId } })
    expect(retainedSources).toHaveBeenLastCalledWith(expect.objectContaining({ id: result.assessmentId }))
    admission.assertCurrent()
    t.state.sources = false
    expect(() => admission.assertCurrent()).toThrow()
    t.state.sources = true
    t.registry.setKv(`issue-watch:${t.space.id}`, JSON.stringify({ spaceId: t.space.id, boundBy: 'alice', repo: 'org/demo', since: 0, labels: [], version: 'version-2' }))
    expect(() => admission.assertCurrent()).toThrow()
    await expect(runtime.admitHandoffTask(taskId)).rejects.toThrow()
  })
})
