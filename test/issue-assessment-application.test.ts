import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { Spaces } from '../src/core/space.js'
import { PolicyService } from '../src/core/policy.js'
import { TaskEvents } from '../src/core/task-events.js'
import { IssueAssessmentApplication, type IssueAssessmentSourceLease } from '../src/core/issue-assessment-application.js'
import { WorkAssessments, type WorkAssessmentExecution, type WorkAssessmentRequest, type WorkAssessmentResult } from '../src/core/work-assessment.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import type { UpdateListener } from '../src/acp/runtime.js'

const closes: (() => void)[] = [], DAY = 86400_000
afterEach(() => { closes.splice(0).forEach(close => close()); vi.useRealTimers() })
function fixture(options: { intent?: WorkAssessmentRequest['intent']; minimumIdleMs?: number } = {}) {
  const registry = new Registry(':memory:'); closes.push(() => registry.close())
  const now = Date.parse('2026-09-22T00:00:00Z'), spaces = new Spaces(registry.db, () => now)
  const space = spaces.ensure({ kind: 'group', chatId: 'group-a', openId: 'alice' })
  const policy = new PolicyService(spaces, { admins: [] }), store = new WorkAssessments(registry.db, () => now)
  const session = registry.createSession({ sessionKey: 'source-session', chatId: 'group-a', chatType: 'group', requesterOpenId: 'alice', cwd: '/unused' })
  const inbound: InboundMessage = { messageId: 'human-original', eventId: 'evt-human', chatId: 'group-a', chatType: 'group',
    text: '看看这条问题适不适合接。', msgType: 'text', senderType: 'user', senderOpenId: 'alice', mentions: [], createTimeMs: now - DAY }
  const task = registry.createTaskOnce({ sessionKey: session.sessionKey, messageId: inbound.messageId, requesterOpenId: 'alice', prompt: inbound.text, inbound }).task
  const binding = { spaceId: space.id, boundBy: 'alice', repo: 'org/repo', since: now - 20 * DAY, labels: ['bug'], version: 'binding-1' }
  registry.setKv(`issue-watch:${space.id}`, JSON.stringify(binding))
  let sourceCurrent = true, allowed = true, platformCurrent = true, sequence = 0
  const sources: IssueAssessmentSourceLease = { context: { version: 1, acpSessionId: 'source-acp', spaceId: space.id, chatId: 'group-a',
    memoryScopes: [], chats: [], external: [], repositories: [], inboundMaterials: [{ messageId: 'forward-original', chatId: 'group-a',
      actorOpenId: 'alice', digest: 'a'.repeat(64), complete: true }] }, assertCurrent: () => { if (!sourceCurrent) throw new Error('source revoked') } }
  const raw = { number: 7, title: 'Plugin screen is blank', body: 'This remains reproducible after reload.',
    state: 'open', assignees: [] as { login: string }[], labels: [{ name: 'bug' }], comments: 1,
    user: { login: 'reporter' }, created_at: new Date(now - 10 * DAY).toISOString(), updated_at: new Date(now - 3 * DAY).toISOString() }
  const comments = [{ id: 9, body: 'The reproduction is documented.', user: { login: 'reporter', type: 'User' }, created_at: raw.updated_at }]
  const timeline: Record<string, unknown>[] = [{ event: 'commented', id: 9 }]
  const api = vi.fn(async (_method: string, path: string, _body?: unknown, _owner?: string, before?: () => void): Promise<unknown> => {
    before?.()
    if (/^\/repos\/org\/repo\/issues\/(7|8)$/.test(path)) return structuredClone({ ...raw, number: Number(path.split('/').at(-1)) })
    if (/\/comments\?per_page=100&page=1$/.test(path)) return structuredClone(comments)
    if (/\/timeline\?per_page=100&page=1$/.test(path)) return structuredClone(timeline)
    throw new Error(`unexpected path ${path}`)
  })
  const github = { api, repoAllowed: (repo: string) => allowed && repo === 'org/repo' } as Pick<GitHubIdentity, 'api' | 'repoAllowed'>
  let listener: UpdateListener | undefined
  let result: WorkAssessmentResult['verdict'] = 'recommend'
  const execution: WorkAssessmentExecution = {
    prepare: vi.fn(async () => ({ runId: `run-${++sequence}`, sessionKey: `private-${sequence}`, acpSessionId: `acp-${sequence}`, mode: 'managed', fresh: true,
      assertCurrent: () => {} })), modeForSession: () => 'managed',
    subscribe: (_id, callback) => { listener = callback; return () => { listener = undefined } },
    prompt: vi.fn(async (_prepared, content, opts) => {
      opts.beforeDispatch?.()
      const text = content[0]!.type === 'text' ? content[0]!.text : ''
      const snapshot = JSON.parse(text.split('\n').at(-1)!).snapshot
      const body = snapshot.sources.find((source: { ref: string }) => source.ref.endsWith(':body'))
      listener?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ verdict: result,
        summary: result === 'not_suitable' ? 'The thread already has someone working on it.' : 'Read-only evaluation.',
        evidence: [{ ref: body.ref, quote: raw.body }], missingInfo: result === 'need_info' ? ['Please add the failing version.'] : [],
        proposedAction: result === 'recommend' ? { kind: 'develop_change', targetRef: snapshot.targets[0].ref } : null }) } }, {} as never)
      return { stopReason: 'end_turn' }
    }), finish: vi.fn(async () => {}),
  }
  const deps = { registry, spaces, policy, github, assessments: store, execution, now: () => now, minimumIdleMs: options.minimumIdleMs,
    assertSpaceCurrent: () => { if (!platformCurrent) throw new Error('membership revoked') } }
  const app = new IssueAssessmentApplication(deps)
  const assess = (extra: Partial<Parameters<typeof app.assess>[0]> = {}) => app.assess({ taskId: task.id, number: 7,
    intent: options.intent ?? 'assess_only', sources, ...extra })
  const amend = (messageId = 'real-confirmation', openId = 'alice') => registry.createTaskOnce({ sessionKey: session.sessionKey,
    messageId, requesterOpenId: openId, prompt: '同意修复这次评估的版本。', amendsTaskId: task.id,
    inbound: { ...inbound, eventId: messageId, messageId, senderOpenId: openId, text: '同意修复这次评估的版本。' } }).task
  const create = vi.fn((input: { key: string; assessment: { id: string }; authority: { messageId: string } }) => {
    const created = new TaskEvents(registry).admit({ key: input.key, kind: 'issue_assessment',
      sourceTaskId: registry.taskForMessage(input.authority.messageId)!.id, targetSessionKey: session.sessionKey,
      domainId: input.assessment.id, prompt: 'Host-authorized execution input' }).task
    return { taskId: created.id, dispatchKey: input.key }
  })
  return { registry, spaces, space, task, session, store, app, deps, assess, sources, binding, raw, comments, timeline, api, execution, amend, create,
    verdict: (value: typeof result) => { result = value }, deny: () => { allowed = false }, revokeSource: () => { sourceCurrent = false },
    revokePlatform: () => { platformCurrent = false } }
}

describe('bound issue assessment application', () => {
  it('reads the complete thread with a GET-only broker and retains original Work/material sources in its durable recommendation', async () => {
    const t = fixture(), record = await t.assess()
    expect(record).toMatchObject({ state: 'completed', request: { messageId: 'human-original', origin: { taskId: t.task.id, workKey: `task:${t.task.id}`,
      sources: { inboundMaterials: [{ messageId: 'forward-original' }] } } }, result: { verdict: 'recommend' }, handoff: null })
    expect(record.snapshot.sources.find(source => source.ref.endsWith(':comment:9'))).toMatchObject({ author: 'reporter', text: t.comments[0]!.body })
    expect(t.execution.prepare).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: [], executionAllowed: false, requireManaged: true }))
    expect(t.api.mock.calls.every(([method, , body]) => method === 'GET' && body === undefined)).toBe(true)
    expect(t.registry.listTasks(t.session.sessionKey)).toHaveLength(1)
    const restarted = new IssueAssessmentApplication({ ...t.deps, assessments: new WorkAssessments(t.registry.db) })
    expect((await restarted.assess({ taskId: t.task.id, number: 7, intent: 'assess_only', sources: t.sources })).id).toBe(record.id)
    expect(t.execution.prompt).toHaveBeenCalledTimes(1)
  })
  it('admits different issues under one real request without buying duplicate assessments', async () => {
    const t = fixture(), first = await t.assess(), second = await t.assess({ number: 8 })
    expect(first.id).not.toBe(second.id)
    expect(second.request.messageId).toBe(first.request.messageId)
    expect((await t.assess()).id).toBe(first.id)
    expect(t.execution.prompt).toHaveBeenCalledTimes(2)
  })
  it.each(['closed', 'assigned', 'linked_pr', 'label', 'fresh', 'before_binding'] as const)('persists %s rules and evidence without invoking the model', async reason => {
    const t = fixture()
    if (reason === 'closed') t.raw.state = 'closed'
    if (reason === 'assigned') t.raw.assignees = [{ login: 'maintainer' }]
    if (reason === 'linked_pr') t.timeline.push({ event: 'cross-referenced', source: { issue: { number: 22, state: 'open', pull_request: {}, html_url: 'https://github.com/org/repo/pull/22' } } })
    if (reason === 'label') t.raw.labels = [{ name: 'docs' }]
    if (reason === 'fresh') t.raw.updated_at = new Date(t.deps.now() - 1000).toISOString()
    if (reason === 'before_binding') t.registry.setKv(`issue-watch:${t.space.id}`, JSON.stringify({ ...t.binding, since: t.deps.now() - DAY }))
    const record = await t.assess()
    expect(record).toMatchObject({ state: 'completed', runId: null, result: { verdict: 'not_suitable', proposedAction: null } })
    expect(record.result!.evidence).toHaveLength(1)
    expect(t.execution.prepare).not.toHaveBeenCalled()
    expect(t.execution.prompt).not.toHaveBeenCalled()
  })
  it('treats a 0 waiting-window configuration as disabled, before any repository reads or admission', async () => {
    const t = fixture({ minimumIdleMs: 0 })
    await expect(t.assess()).rejects.toThrow('not_authorized')
    expect(t.api).not.toHaveBeenCalled()
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM work_assessments').get()?.n).toBe(0)
  })
  it('does not equate missing assignees with nobody working; passes attributed full comments to the evaluator', async () => {
    const t = fixture(); t.comments[0]!.body = 'I have started implementing the fix.'; t.verdict('not_suitable')
    const record = await t.assess()
    expect(record.result?.verdict).toBe('not_suitable')
    expect(JSON.stringify(vi.mocked(t.execution.prompt).mock.calls[0]![1])).toContain(t.comments[0]!.body)
    expect(record.handoff).toBeNull()
  })
  it('persists a specific needs-information proposal without creating a Todo, Inbox item or execution Task', async () => {
    const t = fixture(); t.verdict('need_info')
    const record = await t.assess()
    expect(record.result).toMatchObject({ verdict: 'need_info', missingInfo: ['Please add the failing version.'], proposedAction: null })
    expect(t.registry.listTasks(t.session.sessionKey)).toHaveLength(1)
  })
  it.each(['binding', 'owner', 'actor', 'archive', 'allowlist', 'source', 'platform', 'new_input', 'stop'] as const)('revokes an in-flight assessment when %s changes', async change => {
    const t = fixture(), original = t.api.getMockImplementation()!
    t.api.mockImplementationOnce(async (...args) => {
      const value = await original(...args)
      if (change === 'binding') t.registry.setKv(`issue-watch:${t.space.id}`, JSON.stringify({ ...t.binding, version: 'off-then-on' }))
      if (change === 'owner' || change === 'actor') t.spaces.removeMember(t.space.id, 'alice')
      if (change === 'archive') t.spaces.suspend(t.space.id)
      if (change === 'allowlist') t.deny()
      if (change === 'source') t.revokeSource()
      if (change === 'platform') t.revokePlatform()
      if (change === 'new_input') t.amend('change-direction')
      if (change === 'stop') t.registry.workContexts.control(`task:${t.task.id}`, { action: 'cancel', causeRef: 'human-stop' })
      return value
    })
    await expect(t.assess()).rejects.toThrow()
    expect(t.api).toHaveBeenCalledTimes(1)
    expect(t.execution.prompt).not.toHaveBeenCalled()
  })
  it('rejects incomplete or malformed claim evidence without interpreting it as unclaimed', async () => {
    const t = fixture(); t.raw.assignees = [{} as { login: string }]
    await expect(t.assess()).rejects.toThrow('incomplete')
    expect(t.execution.prompt).not.toHaveBeenCalled()
  })
  it('rejects a source lease from another space before issuing a GitHub request', async () => {
    const t = fixture(); t.sources.context.chatId = 'other-chat'
    await expect(t.assess()).rejects.toThrow('not_current')
    expect(t.api).not.toHaveBeenCalled()
  })
  it('settles invalid model output once and leaves a subsequent candidate assessable', async () => {
    const t = fixture()
    vi.mocked(t.execution.prompt).mockResolvedValueOnce({ stopReason: 'end_turn' })
    await expect(t.assess()).rejects.toThrow('invalid_result')
    expect((await t.assess()).state).toBe('failed')
    expect((await t.assess({ number: 8 })).result?.verdict).toBe('recommend')
    expect(t.execution.prompt).toHaveBeenCalledTimes(2)
  })
  it('does not start assessing an old original input after a newer input already took over the same Work', async () => {
    const t = fixture(); t.amend('newer-input')
    await expect(t.assess()).rejects.toThrow('not_current')
    expect(t.api).not.toHaveBeenCalled()
    expect(t.execution.prepare).not.toHaveBeenCalled()
  })
  it('finds a linked PR on the second timeline page and retains comments from the final page', async () => {
    const t = fixture(); t.raw.comments = 101
    const original = t.api.getMockImplementation()!
    t.api.mockImplementation(async (...args) => {
      args[4]?.()
      const path = args[1]
      if (path.endsWith('/comments?per_page=100&page=1')) return Array.from({ length: 100 }, (_, i) => ({ ...t.comments[0], id: i + 1 }))
      if (path.endsWith('/comments?per_page=100&page=2')) return [{ ...t.comments[0], id: 101, body: 'Final page says there is a PR.' }]
      if (path.endsWith('/timeline?per_page=100&page=1')) return Array.from({ length: 100 }, (_, i) => ({ event: 'commented', id: i + 1 }))
      if (path.endsWith('/timeline?per_page=100&page=2')) return [{ event: 'connected', subject: { number: 3, state: 'open', pull_request: {}, html_url: 'https://github.com/org/repo/pull/3' } }]
      return original(...args)
    })
    const record = await t.assess()
    expect(record.result).toMatchObject({ verdict: 'not_suitable', summary: expect.stringContaining('关联 PR') })
    expect(record.snapshot.sources.some(source => source.ref.endsWith(':comment:101'))).toBe(true)
    expect(t.execution.prepare).not.toHaveBeenCalled()
  })
})

describe('assessment-to-execution handoff stays tied to real authority and original work', () => {
  it('a recommendation cannot manufacture repair authority from an assessment-only request', async () => {
    const t = fixture(), record = await t.assess()
    await expect(t.app.handoff({ assessmentId: record.id, authorityTaskId: t.task.id, kind: 'explicit_request', sources: t.sources, create: t.create })).rejects.toThrow('not_authorized')
    expect(t.create).not.toHaveBeenCalled()
  })
  it.each(['explicit_request', 'human_confirmation'] as const)('uses a real %s once and creates a new input in the original Work', async kind => {
    const t = fixture({ intent: kind === 'explicit_request' ? 'execute_if_suitable' : 'assess_only' }), record = await t.assess()
    const authority = kind === 'explicit_request' ? t.task : t.amend()
    const input = { assessmentId: record.id, authorityTaskId: authority.id, kind, sources: t.sources, create: t.create }
    const handoff = await t.app.handoff(input)
    expect(t.registry.taskWork.get(handoff.taskId)?.key).toBe(`task:${t.task.id}`)
    expect(t.create.mock.calls[0]![0]).toMatchObject({ assessment: { id: record.id, snapshot: { digest: record.snapshot.digest },
      request: { origin: { taskId: t.task.id } } }, authority: { messageId: authority.messageId, action: 'develop_change' } })
    expect(await t.app.handoff(input)).toEqual(handoff)
    expect(t.create).toHaveBeenCalledTimes(1)
    expect(t.api.mock.calls.every(([method]) => method === 'GET')).toBe(true)
  })
  it.each(['thread', 'binding', 'different_work', 'newer_input', 'pause', 'source'] as const)('does not hand off stale %s evidence or authorization', async change => {
    const t = fixture(), record = await t.assess(), authority = t.amend()
    let authorityTaskId = authority.id
    if (change === 'thread') t.comments[0]!.body = 'Someone already fixed this.'
    if (change === 'binding') t.registry.setKv(`issue-watch:${t.space.id}`, JSON.stringify({ ...t.binding, version: 'different' }))
    if (change === 'different_work') authorityTaskId = t.registry.createTaskOnce({ sessionKey: t.session.sessionKey, requesterOpenId: 'alice', messageId: 'other', prompt: 'different work' }).task.id
    if (change === 'newer_input') t.amend('newer-change')
    if (change === 'pause') t.registry.workContexts.control(`task:${t.task.id}`, { action: 'pause', reason: 'manual', causeRef: 'pause' })
    if (change === 'source') t.revokeSource()
    await expect(t.app.handoff({ assessmentId: record.id, authorityTaskId, kind: 'human_confirmation', sources: t.sources, create: t.create })).rejects.toThrow()
    expect(t.create).not.toHaveBeenCalled()
  })
  it('rolls back a returned execution Task that secretly belongs to a different Work', async () => {
    const t = fixture({ intent: 'execute_if_suitable' }), record = await t.assess()
    const count = t.registry.listTasks(t.session.sessionKey).length
    await expect(t.app.handoff({ assessmentId: record.id, authorityTaskId: t.task.id, kind: 'explicit_request', sources: t.sources,
      create: ({ key }) => ({ taskId: t.registry.createTaskOnce({ sessionKey: t.session.sessionKey, messageId: key, requesterOpenId: 'alice', prompt: 'wrong root' }).task.id, dispatchKey: key }) })).rejects.toThrow()
    expect(t.registry.listTasks(t.session.sessionKey)).toHaveLength(count)
    expect(t.store.get(record.id)?.handoff).toBeNull()
  })
  it('rolls back a same-Work Task when its promised durable dispatch is missing', async () => {
    const t = fixture({ intent: 'execute_if_suitable' }), record = await t.assess()
    await expect(t.app.handoff({ assessmentId: record.id, authorityTaskId: t.task.id, kind: 'explicit_request', sources: t.sources,
      create: ({ key }) => ({ taskId: t.registry.createTaskOnce({ sessionKey: t.session.sessionKey, messageId: key, requesterOpenId: 'alice',
        prompt: 'Missing dispatch', workFromTaskId: t.task.id }).task.id, dispatchKey: key }) })).rejects.toThrow('conflict')
    expect(t.registry.listTasks(t.session.sessionKey)).toHaveLength(1)
    expect(t.store.get(record.id)?.handoff).toBeNull()
  })
})

describe('confirmation-card handoff on the original request (P3-3b)', () => {
  const cardCreate = (t: ReturnType<typeof fixture>) => vi.fn((input: { key: string; assessment: { id: string }; authority: { messageId: string } }) => {
    const created = new TaskEvents(t.registry).admit({ key: input.key, kind: 'issue_assessment', sourceTaskId: t.task.id,
      targetSessionKey: t.session.sessionKey, domainId: input.assessment.id, prompt: 'Host-authorized execution input' }).task
    return { taskId: created.id, dispatchKey: input.key }
  })
  it('uses the click on the delivered card as the human confirmation, keeps the original Task as the source, and hands off once', async () => {
    const t = fixture(), record = await t.assess(), create = cardCreate(t)
    const input = { assessmentId: record.id, authorityTaskId: t.task.id, kind: 'human_confirmation' as const, confirmation: { messageId: 'om_card' },
      sources: t.sources, create }
    const handoff = await t.app.handoff(input)
    expect(create.mock.calls[0]![0].authority).toMatchObject({ kind: 'human_confirmation', messageId: 'card:om_card', actorOpenId: 'alice' })
    expect(new TaskEvents(t.registry).get(handoff.taskId)).toMatchObject({ kind: 'issue_assessment', sourceTaskId: t.task.id, domainId: record.id })
    expect(t.registry.taskWork.get(handoff.taskId)?.key).toBe(`task:${t.task.id}`)
    expect(await t.app.handoff(input)).toEqual(handoff)
    expect(create).toHaveBeenCalledTimes(1)
    expect(t.store.get(record.id)?.state).toBe('handed_off')
  })
  it('accepts a card only as a human confirmation on the original Task, and never the original message itself', async () => {
    const t = fixture({ intent: 'execute_if_suitable' }), record = await t.assess(), create = cardCreate(t)
    await expect(t.app.handoff({ assessmentId: record.id, authorityTaskId: t.task.id, kind: 'explicit_request', confirmation: { messageId: 'om_card' },
      sources: t.sources, create })).rejects.toThrow('not_authorized')
    const later = t.amend()
    await expect(t.app.handoff({ assessmentId: record.id, authorityTaskId: later.id, kind: 'human_confirmation', confirmation: { messageId: 'om_card' },
      sources: t.sources, create })).rejects.toThrow('not_authorized')
    expect(create).not.toHaveBeenCalled()
  })
  it('without a card, the original Task cannot be its own human confirmation', async () => {
    const t = fixture(), record = await t.assess(), create = cardCreate(t)
    await expect(t.app.handoff({ assessmentId: record.id, authorityTaskId: t.task.id, kind: 'human_confirmation', sources: t.sources, create }))
      .rejects.toThrow('not_authorized')
    expect(create).not.toHaveBeenCalled()
  })
  it('reports a changed Issue thread as thread_changed and creates nothing', async () => {
    const t = fixture(), record = await t.assess(), create = cardCreate(t)
    t.comments[0]!.body = 'Someone already fixed this.'
    await expect(t.app.handoff({ assessmentId: record.id, authorityTaskId: t.task.id, kind: 'human_confirmation', confirmation: { messageId: 'om_card' },
      sources: t.sources, create })).rejects.toThrow('thread_changed')
    expect(create).not.toHaveBeenCalled(); expect(t.store.get(record.id)?.state).toBe('completed')
  })
})
