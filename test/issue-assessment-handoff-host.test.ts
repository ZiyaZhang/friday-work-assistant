import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig } from '../src/config.js'
import { Registry } from '../src/core/registry.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { SourceContexts } from '../src/core/source-context.js'
import { TaskEvents } from '../src/core/task-events.js'
import { WorkAssessments } from '../src/core/work-assessment.js'
import { GitHubIdentity, loadGitHubConfig } from '../src/github/identity.js'
import { IssueLinks } from '../src/github/issues.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import type { FakeAgentState, FakeTurnStep } from './helpers/fake-agent.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { FakeFeishu, asFeishuClient, cardText, type SentRecord } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const DAY = 86400_000, ASSESSMENT_PROMPT = '你只判断这项工作是否适合接手', EXECUTION_PROMPT = '继续原工作中已明确授权的 Issue 修复'
type ToolName = 'github_assess_issue' | 'github_get_assessment' | 'github_execute_assessment' | 'github_comment_issue'
type ToolResult = { isError: boolean; text: string; json?: Record<string, unknown> }

/** Real Host + ACP pool + MCP/HTTP + SQLite; GitHub transport, Feishu and the model are synthetic.
 * `admin`: the requester is a deployment admin, so her own task runs in workspace mode while every host-owned Run must stay managed. */
async function fixture(options: { admin?: boolean; writeRepos?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-issue-handoff-')), registry = new Registry(':memory:')
  const log = createLogger('issue-handoff', 'error'), cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic',
    FRIDAY_HOME: home, FRIDAY_PUBLIC_MODE: 'true', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', ...(options.admin ? { FRIDAY_ADMINS: 'alice' } : {}) })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const sp = spaceDeps(registry.db, options.admin ? { admins: ['alice'] } : {}), space = sp.spaces.ensure({ kind: 'group', chatId: 'chat', openId: 'alice' })
  sp.spaces.touchMember(space.id, 'bob')
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake); fake.members.set('chat', new Set(['alice', 'bob']))
  const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const todos = new Todos(registry.db), tokens = new TokenIssuer('synthetic-only'), links = new IssueLinks(registry.db)
  const now = Date.now(), binding = { spaceId: space.id, boundBy: 'alice', repo: 'org/demo', since: now - 30 * DAY, labels: [], version: 'binding-v1' }
  registry.setKv(`issue-watch:${space.id}`, JSON.stringify(binding))
  const issue = { number: 42, title: 'Plugin page stays blank', body: 'Opening the plugin page shows nothing after reload.', state: 'open',
    html_url: 'https://github.com/org/demo/issues/42', assignees: [] as { login: string }[], labels: [] as { name: string }[], comments: 1,
    user: { login: 'reporter' }, created_at: new Date(now - 10 * DAY).toISOString(), updated_at: new Date(now - 3 * DAY).toISOString() }
  const comments = [{ id: 9, body: 'Still reproducible on the latest build.', user: { login: 'reporter', type: 'User' }, created_at: issue.updated_at }]
  const timeline: Record<string, unknown>[] = [{ event: 'commented', id: 9 }]
  const provider = { writes: 0, calls: [] as string[] }
  const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'synthetic', FRIDAY_GITHUB_REPOS: 'org/demo,org/other',
    ...(options.writeRepos ? { FRIDAY_GITHUB_WRITE_REPOS: options.writeRepos } : {}) })!, log, {
    async request<T>(method: string, path: string) {
      provider.calls.push(`${method} ${path}`)
      if (method !== 'GET') { provider.writes++; return { status: 500, data: {} as T } }
      const url = new URL(path, 'https://api.github.com'), page = Number(url.searchParams.get('page') ?? 1)
      if (url.pathname.endsWith('/comments')) return { status: 200, data: structuredClone(comments.slice((page - 1) * 100, page * 100)) as T }
      if (url.pathname.endsWith('/timeline')) return { status: 200, data: structuredClone(timeline.slice((page - 1) * 100, page * 100)) as T }
      if (url.pathname === '/repos/org/demo/issues/42') return { status: 200, data: structuredClone(issue) as T }
      return { status: 404, data: { message: 'not found' } as T }
    },
  })
  const assessments = new WorkAssessments(registry.db)
  const execution = managedHostRuntime(registry, home, log), state = execution.peer.state, workspace = execution.workspacePeer.state
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, messages, feishu, tokens, github, assessments,
    runtime: execution.runtime, managed: execution.managed, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent',
    botOpenId: 'bot', log, repositoryAllowed: repo => github.repoAllowed(repo), ingressClassifier: { classify: async () => ({ kind: 'work_request' }) } })
  const api = createInternalApi({ appId: cfg.feishu.appId, registry, ...sp, memory, todos, messages, messageCache: cache, feishu, github, issueLinks: links,
    get issueAssessment() { return host.issueAssessment },
    tokens, log, maxHistoryPerCall: 20, resolveActorForSession: key => host.resolveActorForSession(key),
    allowedRoutesForSession: key => host.allowedRoutesForSession(key), canPublishToRepository: (key, repo) => host.canPublishToRepository(key, repo),
    onRepositoryRead: (key, repo) => host.noteRepositoryRead(key, repo) })
  await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  /** The task's own prompt is the latest one that carries MCP servers on that peer; private evaluation prompts carry none. */
  const current = (peer: FakeAgentState = state) => {
    const prompt = [...peer.allPrompts].reverse().find(item => (item.mcpServers as unknown[]).length)!, session = registry.getSessionByAcpId(prompt.sessionId)!
    const servers = prompt.mcpServers as { env: { name: string; value: string }[] }[]
    return { session, prompt, token: servers[0]!.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value }
  }
  const answerFor = (prompt: string, verdict: 'recommend' | 'need_info' = 'recommend') => {
    const { snapshot } = JSON.parse(prompt.split('\n').at(-1)!) as { snapshot: { targets: { ref: string }[]; sources: { ref: string; text: string }[] } }
    const body = snapshot.sources.find(source => source.ref.endsWith(':body'))!
    return JSON.stringify({ verdict, summary: verdict === 'recommend' ? 'The reproduction is concrete and nobody is working on it.' : 'The failing version is missing.',
      evidence: [{ ref: body.ref, quote: issue.body }], missingInfo: verdict === 'need_info' ? ['Which build fails?'] : [],
      proposedAction: verdict === 'recommend' ? { kind: 'develop_change', targetRef: snapshot.targets[0]!.ref } : null })
  }
  /** Script for the private evaluation session (always the managed peer): no tool, one JSON text answer. */
  const evaluator = (verdict: 'recommend' | 'need_info'): FakeTurnStep[] => {
    const steps: FakeTurnStep[] = [{ kind: 'hook', run: () => { steps[1]!.text = answerFor(state.allPrompts.at(-1)!.text, verdict) } }, { kind: 'text', text: '' }]
    return steps
  }
  /** A tool call from the Run whose prompt is the latest one with MCP servers on `peer`. */
  const tool = async (name: ToolName, args: Record<string, unknown>, options: { verdict?: 'recommend' | 'need_info'; peer?: FakeAgentState } = {}): Promise<ToolResult> => {
    const server = buildServer({ apiUrl: base, token: current(options.peer).token }), client = new Client({ name: 'synthetic', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    const outer = state.script; state.script = evaluator(options.verdict ?? 'recommend')
    try {
      const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] }
      return { isError: result.isError === true, text: result.content[0]!.text, json: result.isError ? undefined : JSON.parse(result.content[0]!.text) as Record<string, unknown> }
    } finally { state.script = outer; await client.close(); await server.close() }
  }
  const message = (messageId: string, text = '@Friday 评估一下 #42 适不适合你接手'): InboundMessage => ({ eventId: `event-${messageId}`, messageId, chatId: 'chat', chatType: 'group',
    senderOpenId: 'alice', senderType: 'user', threadId: 'synthetic-thread', rootId: 'synthetic-thread', msgType: 'text', text,
    mentions: [{ key: '@Friday', name: 'Friday', openId: 'bot' }], createTimeMs: Date.now() })
  /** The human asks; the model (on the requester's peer) calls github_assess_issue once and answers. */
  const assess = async (messageId = 'request', verdict: 'recommend' | 'need_info' = 'recommend', extra?: (first: ToolResult) => Promise<void>) => {
    const peer = options.admin ? workspace : state
    let result: ToolResult | undefined
    peer.script = [{ kind: 'hook', run: async () => { result = await tool('github_assess_issue', { number: 42 }, { verdict, peer }); await extra?.(result) } },
      { kind: 'text', text: '评估结果如下。' }]
    await host.handleMessage(message(messageId))
    return result!
  }
  const cards = () => fake.of('replyCard').filter(item => JSON.stringify(item.payload).includes('issue_assessment_handoff'))
  const buttonValue = (card: SentRecord, decision: 'execute' | 'decline') => {
    const found: Record<string, unknown>[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return }
      if (!value || typeof value !== 'object') return
      const record = value as Record<string, unknown>
      if (record.action === 'issue_assessment_handoff') found.push(record)
      Object.values(record).forEach(walk)
    }
    walk(card.payload)
    return found.find(item => item.decision === decision)!
  }
  const click = (card: SentRecord, operatorOpenId: string, decision: 'execute' | 'decline' = 'execute', messageId = card.messageId) =>
    host.handleCardAction({ operatorOpenId, messageId, chatId: 'chat', value: buttonValue(card, decision), raw: {} }) as Promise<{ toast?: { type: string; content: string }; card?: { type: string; data: Record<string, unknown> } }>
  const rows = () => registry.db.prepare('SELECT id, state, handoff, authority FROM work_assessments ORDER BY created_at').all() as
    { id: string; state: string; handoff: string | null; authority: string | null }[]
  const eventRows = () => registry.db.prepare("SELECT task_id, kind, source_task_id, domain_id, event_key FROM task_event_sources WHERE kind='issue_assessment'").all() as
    { task_id: number; kind: string; source_task_id: number; domain_id: string; event_key: string }[]
  const executionPrompts = () => [...state.allPrompts, ...workspace.allPrompts].filter(prompt => prompt.text.includes(EXECUTION_PROMPT))
  const settle = async (taskId: number) => { await expect.poll(() => registry.getTask(taskId)?.status, { timeout: 4000 }).toMatch(/^(done|failed|cancelled)$/) }
  cleanups.push(async () => { api.beginShutdown(); host.beginShutdown(); await execution.runtime.stop(); api.server.closeAllConnections()
    await new Promise<void>(done => api.server.close(() => done())); await host.waitForShutdown(1000); registry.close(); rmSync(home, { recursive: true, force: true }) })
  return { host, registry, state, workspace, fake, provider, tool, current, message, sp, space, binding, issue, comments, timeline, assessments,
    assess, cards, click, buttonValue, rows, eventRows, executionPrompts, settle }
}

describe('handoff after a recommend assessment: confirmation card → original Work → managed execution', () => {
  it('sends one confirmation card in the original conversation for recommend, and none for need_info or a rule rejection', async () => {
    const t = await fixture()
    const first = await t.assess('request', 'recommend', async () => {
      // A repeated call in the same task returns the same record and does not deliver a second card.
      const again = await t.tool('github_assess_issue', { number: 42 })
      expect(again.json).toMatchObject({ confirmationCard: 'sent' })
    })
    expect(first.isError, first.text).toBe(false)
    expect(first.json).toMatchObject({ state: 'completed', result: { verdict: 'recommend' }, requiresExecutionAuthorization: true, confirmationCard: 'sent', handoff: null })
    const cards = t.cards(); expect(cards).toHaveLength(1)
    const [card] = cards, text = cardText(card!.payload as Record<string, unknown>)
    // Replies to the requester's own message; shows the snapshot summary and the two decisions.
    expect(card!.target).toBe('request')
    for (const fact of ['org/demo#42', 'Plugin page stays blank', 'recommend', 'The reproduction is concrete and nobody is working on it.',
      String(first.json!.assessmentId), String(first.json!.snapshotDigest).slice(0, 12)]) expect(text).toContain(fact)
    expect(JSON.stringify(card!.payload)).toContain('交给 Friday 做'); expect(JSON.stringify(card!.payload)).toContain('先不用')
    expect(t.buttonValue(card!, 'execute')).toEqual({ action: 'issue_assessment_handoff', assessmentId: first.json!.assessmentId, decision: 'execute' })
    // Delivered through the existing ledger under a key bound to the assessment id.
    const ledger = t.registry.db.prepare('SELECT delivery_key, status, remote_id, actor_open_id FROM deliveries WHERE delivery_key LIKE ?').all('%issue-assessment%')
    expect(ledger).toEqual([{ delivery_key: `issue-assessment:${first.json!.assessmentId}:confirm`, status: 'sent', remote_id: card!.messageId, actor_open_id: 'alice' }])
    expect(t.fake.of('sendToChat')).toHaveLength(0); expect(t.provider.writes).toBe(0)

    // need_info: a new evaluation (thread changed) with no recommendation sends no card.
    t.comments.push({ id: 10, body: 'Which build?', user: { login: 'maintainer', type: 'User' }, created_at: new Date(Date.now() - 2 * 86400_000).toISOString() })
    t.issue.comments = 2; t.timeline.push({ event: 'commented', id: 10 })
    const info = await t.assess('second', 'need_info')
    expect(info.json).toMatchObject({ result: { verdict: 'need_info' }, confirmationCard: null })
    // A host rule rejection (someone is assigned) is not_suitable and sends no card either.
    t.issue.assignees = [{ login: 'maintainer' }]
    const rejected = await t.assess('third')
    expect(rejected.json).toMatchObject({ result: { verdict: 'not_suitable' }, confirmationCard: null })
    expect(t.cards()).toHaveLength(1)
  })

  it('refuses a click from anyone but the original requester, or on another message; declining changes nothing', async () => {
    const t = await fixture()
    const assessed = await t.assess(), [card] = t.cards()
    const other = await t.click(card!, 'bob')
    expect(other.toast).toMatchObject({ type: 'error' }); expect(other.toast!.content).toContain('只有发起这次评估的人')
    const elsewhere = await t.click(card!, 'alice', 'execute', 'om_not_the_card')
    expect(elsewhere.toast).toMatchObject({ type: 'error' })
    const declined = await t.click(card!, 'alice', 'decline')
    expect(declined.toast).toMatchObject({ type: 'info' }); expect(declined.toast!.content).toContain('没有开始修复')
    expect(t.rows()).toEqual([expect.objectContaining({ id: assessed.json!.assessmentId, state: 'completed', handoff: null, authority: null })])
    expect(t.eventRows()).toHaveLength(0)
    expect(t.registry.listTasks(t.current().session.sessionKey)).toHaveLength(1)
  })

  it('the requester’s click creates one issue_assessment Task in the original Work and marks handed_off; repeated clicks return the same Task', async () => {
    const t = await fixture()
    const assessed = await t.assess(), [card] = t.cards(), origin = t.registry.taskForMessage('request')!
    t.state.script = [{ kind: 'text', text: '开始修复。' }]
    const done = await t.click(card!, 'alice')
    expect(done.toast, JSON.stringify(done)).toMatchObject({ type: 'success' })
    const [row] = t.rows(); expect(row).toMatchObject({ id: assessed.json!.assessmentId, state: 'handed_off' })
    const handoff = JSON.parse(row!.handoff!) as { taskId: number; dispatchKey: string }, authority = JSON.parse(row!.authority!)
    expect(authority).toMatchObject({ kind: 'human_confirmation', messageId: `card:${card!.messageId}`, actorOpenId: 'alice', assessmentId: row!.id })
    expect(t.eventRows()).toEqual([{ task_id: handoff.taskId, kind: 'issue_assessment', source_task_id: origin.id, domain_id: row!.id, event_key: `assessment:${row!.id}:execute` }])
    const next = t.registry.getTask(handoff.taskId)!
    expect(t.registry.taskWork.get(next.id)?.key).toBe(t.registry.taskWork.get(origin.id)?.key)
    expect(t.registry.dispatches.get(next.id)?.inbound).toMatchObject({ senderType: 'bot', senderOpenId: 'alice', chatId: 'chat' })
    expect(JSON.stringify(done.card?.data ?? {})).toContain(`#${next.id}`)
    await t.settle(next.id)
    // Clicking again, even after the Task finished, never admits a second Task or a second execution.
    const again = await t.click(card!, 'alice')
    expect(again.toast).toMatchObject({ type: 'success' }); expect(JSON.stringify(again.card?.data ?? {})).toContain(`#${next.id}`)
    expect(t.eventRows()).toHaveLength(1)
    expect(t.registry.listTasks(next.sessionKey)).toHaveLength(2)
    expect(t.executionPrompts()).toHaveLength(1)
    expect(t.provider.writes).toBe(0)
  })

  it('refuses the click after the Issue thread changed and asks to assess again', async () => {
    const t = await fixture()
    await t.assess(); const [card] = t.cards()
    t.comments.push({ id: 11, body: 'I already have a fix locally.', user: { login: 'maintainer', type: 'User' }, created_at: new Date().toISOString() })
    t.issue.comments = 2; t.timeline.push({ event: 'commented', id: 11 })
    const result = await t.click(card!, 'alice')
    expect(result.toast).toMatchObject({ type: 'error' }); expect(result.toast!.content).toContain('线程有变化，请重新评估')
    expect(cardText(result.card!.data)).toContain('线程有变化，请重新评估')
    expect(JSON.stringify(result.card!.data)).not.toContain('issue_assessment_handoff')
    expect(t.rows()).toEqual([expect.objectContaining({ state: 'completed', handoff: null })])
    expect(t.eventRows()).toHaveLength(0); expect(t.executionPrompts()).toHaveLength(0)
  })

  it('the model cannot hand off by itself; after the requester confirms, the tool only returns that same Task', async () => {
    const t = await fixture()
    let own: ToolResult | undefined, confirmed: ToolResult | undefined, before = 0, after = 0
    await t.assess('request', 'recommend', async first => {
      own = await t.tool('github_execute_assessment', { assessmentId: first.json!.assessmentId })
      before = t.registry.listTasks(t.current().session.sessionKey).length
      // The requester clicks while this task is still running; the execution Task waits for it in the same Work.
      t.state.script = [{ kind: 'text', text: '开始修复。' }]
      const clicked = await t.click(t.cards()[0]!, 'alice')
      expect(clicked.toast, JSON.stringify(clicked)).toMatchObject({ type: 'success' })
      confirmed = await t.tool('github_execute_assessment', { assessmentId: first.json!.assessmentId })
      after = t.registry.listTasks(t.current().session.sessionKey).length
    })
    // Without the requester's click the model's own call is refused and admits nothing.
    expect(own?.isError).toBe(true); expect(own?.text).toContain('not_authorized')
    expect(before).toBe(1)
    const [row] = t.rows(), handoff = JSON.parse(row!.handoff!) as { taskId: number }
    expect(confirmed?.isError, confirmed?.text).toBe(false)
    expect(confirmed!.json).toMatchObject({ state: 'handed_off', handoff: { taskId: handoff.taskId } })
    expect(after).toBe(2)
    await t.settle(handoff.taskId)
    expect(t.eventRows()).toHaveLength(1); expect(t.executionPrompts()).toHaveLength(1)
  })

  it('runs the handed-off Task in a managed Run with the original sources registered, once, and without widening repository writes', async () => {
    const t = await fixture({ admin: true, writeRepos: 'org/other' })
    const assessed = await t.assess()
    // The requester is a deployment admin: her own task ran in the workspace runtime.
    expect(t.workspace.allPrompts.filter(prompt => prompt.text.includes('评估一下'))).toHaveLength(1)
    const origin = t.registry.taskForMessage('request')!
    const seen: { manifest?: ReturnType<SourceContexts['get']>; sameRepo?: boolean; otherRepo?: boolean; comment?: ToolResult; boundary?: unknown } = {}
    t.state.script = [{ kind: 'hook', run: async () => {
      const { session } = t.current()
      seen.manifest = new SourceContexts(t.registry).get(session.sessionKey)
      seen.sameRepo = t.host.canPublishToRepository(session.sessionKey, 'org/demo')
      seen.otherRepo = t.host.canPublishToRepository(session.sessionKey, 'org/other')
      seen.boundary = t.registry.db.prepare("SELECT execution_boundary FROM run_attempts WHERE task_id != ? AND stage='task' ORDER BY started_at DESC LIMIT 1").get(origin.id)
      seen.comment = await t.tool('github_comment_issue', { repo: 'org/demo', number: 42, body: 'Working on it.' })
    } }, { kind: 'text', text: '已按现有流程开始修复。' }]
    const clicked = await t.click(t.cards()[0]!, 'alice')
    expect(clicked.toast, JSON.stringify(clicked)).toMatchObject({ type: 'success' })
    const taskId = JSON.parse(t.rows()[0]!.handoff!).taskId as number
    await t.settle(taskId)
    expect(t.registry.getTask(taskId)?.status).toBe('done')
    // Native tools unavailable: the execution prompt reached only the managed runtime.
    const prompts = t.executionPrompts(); expect(prompts).toHaveLength(1)
    expect(t.state.allPrompts).toContainEqual(prompts[0]); expect(t.workspace.allPrompts).not.toContainEqual(prompts[0])
    expect(prompts[0]!.text).toContain(String(assessed.json!.assessmentId)); expect(prompts[0]!.text).toContain(String(assessed.json!.snapshotDigest))
    expect(seen.boundary).toEqual({ execution_boundary: 'managed_api_v1' })
    // Source registration: the original Work's sources and the assessed repository are in this Run's ledger.
    expect(seen.manifest?.repositories).toEqual(['org/demo'])
    // The audience is the original conversation, and every chat source the assessment saved in origin.sources is carried over.
    const saved = t.registry.db.prepare('SELECT request FROM work_assessments WHERE id=?').get(String(assessed.json!.assessmentId)) as { request: string }
    const originSources = (JSON.parse(saved.request) as { origin: { sources: { chatId: string; chats: { chatId: string }[] } } }).origin.sources
    expect(seen.manifest?.chatId).toBe('chat'); expect(originSources.chatId).toBe('chat')
    expect(seen.manifest?.chats.map(chat => chat.chatId)).toEqual(expect.arrayContaining(originSources.chats.map(chat => chat.chatId)))
    expect(seen.otherRepo).toBe(false)
    // Publishing stays independent: org/demo is readable but not in FRIDAY_GITHUB_WRITE_REPOS, so the write is refused.
    expect(seen.comment?.isError).toBe(true); expect(seen.comment?.text).toContain('FRIDAY_GITHUB_WRITE_REPOS')
    expect(t.provider.writes).toBe(0)
    // Once: waking or clicking again does not run it a second time.
    t.host.wakeQueuedTask(taskId)
    await t.click(t.cards()[0]!, 'alice')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(t.executionPrompts()).toHaveLength(1)
    expect(new TaskEvents(t.registry).get(taskId)).toMatchObject({ kind: 'issue_assessment', sourceTaskId: origin.id })
  })

  it('re-verifies a queued handoff at admission: a revoked repository binding cancels it before any execution prompt', async () => {
    const t = await fixture()
    await t.assess('request', 'recommend', async () => {
      t.state.script = [{ kind: 'text', text: '不应执行。' }]
      const clicked = await t.click(t.cards()[0]!, 'alice')
      expect(clicked.toast, JSON.stringify(clicked)).toMatchObject({ type: 'success' })
      // The owner stops watching the repository while the execution Task is still queued behind this task.
      t.registry.setKv(`issue-watch:${t.space.id}`, '')
      t.state.script = [{ kind: 'text', text: '评估结果如下。' }]
    })
    const taskId = JSON.parse(t.rows()[0]!.handoff!).taskId as number
    await t.settle(taskId)
    expect(t.registry.getTask(taskId)).toMatchObject({ status: 'cancelled', stopReason: 'assessment_changed' })
    expect(t.executionPrompts()).toHaveLength(0)
  })
})
