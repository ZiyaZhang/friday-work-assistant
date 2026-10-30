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
import { WorkAssessments } from '../src/core/work-assessment.js'
import { GitHubIdentity, loadGitHubConfig } from '../src/github/identity.js'
import { IssueLinks } from '../src/github/issues.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import type { FakeTurnStep } from './helpers/fake-agent.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const DAY = 86400_000, ASSESSMENT_PROMPT = '你只判断这项工作是否适合接手'

/** Real managed Host + ACP + MCP/HTTP + SQLite; only the GitHub transport, Feishu and the model are synthetic. */
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-issue-assessment-')), registry = new Registry(':memory:')
  const log = createLogger('issue-assessment', 'error'), cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic',
    FRIDAY_HOME: home, FRIDAY_PUBLIC_MODE: 'true', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'chat', openId: 'alice' })
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
  const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'synthetic', FRIDAY_GITHUB_REPOS: 'org/demo' })!, log, {
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
  const execution = managedHostRuntime(registry, home, log), state = execution.peer.state
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
  /** The human task's prompt is the latest one that carries MCP servers; private evaluation prompts carry none. */
  const current = () => {
    const prompt = [...state.allPrompts].reverse().find(item => (item.mcpServers as unknown[]).length)!, session = registry.getSessionByAcpId(prompt.sessionId)!
    const servers = prompt.mcpServers as { env: { name: string; value: string }[] }[]
    return { session, actor: host.resolveActorForSession(session.sessionKey)!, token: servers[0]!.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value }
  }
  /** The evaluator's answer is derived from the exact prompt it received: literal quote from the snapshot body, real target ref. */
  const answerFor = (prompt: string, verdict: 'recommend' | 'need_info' = 'recommend') => {
    const { snapshot } = JSON.parse(prompt.split('\n').at(-1)!) as { snapshot: { targets: { ref: string }[]; sources: { ref: string; text: string }[] } }
    const body = snapshot.sources.find(source => source.ref.endsWith(':body'))!
    return JSON.stringify({ verdict, summary: verdict === 'recommend' ? 'The reproduction is concrete and nobody is working on it.' : 'The failing version is missing.',
      evidence: [{ ref: body.ref, quote: issue.body }], missingInfo: verdict === 'need_info' ? ['Which build fails?'] : [],
      proposedAction: verdict === 'recommend' ? { kind: 'develop_change', targetRef: snapshot.targets[0]!.ref } : null })
  }
  type EvaluatorMode = 'answer' | 'tool' | 'need_info' | 'interrupt'
  const interrupted = { count: -1 }
  /** Script for the private evaluation session: no tool, one JSON text answer; or a tool attempt; or a gateway restart mid-flight. */
  const evaluator = (mode: EvaluatorMode = 'answer'): FakeTurnStep[] => {
    const steps: FakeTurnStep[] = [{ kind: 'hook', run: () => {
      steps[1]!.text = answerFor(state.allPrompts.at(-1)!.text, mode === 'need_info' ? 'need_info' : 'recommend')
      // What a restarted gateway does before recoverRuns(): the row admitted for this prompt is still running, so it is interrupted.
      if (mode === 'interrupt') interrupted.count = new WorkAssessments(registry.db).recoverInterrupted()
    } }, { kind: 'text', text: '' }]
    if (mode === 'tool') steps.splice(1, 0, { kind: 'tool', text: 'shell', toolKind: 'execute' })
    return steps
  }
  const tool = async (name: 'github_assess_issue' | 'github_get_assessment', args: Record<string, unknown>, mode: EvaluatorMode = 'answer') => {
    const server = buildServer({ apiUrl: base, token: current().token }), client = new Client({ name: 'synthetic', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    const outer = state.script; state.script = evaluator(mode)
    try {
      const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] }
      return { isError: result.isError === true, text: result.content[0]!.text, json: result.isError ? undefined : JSON.parse(result.content[0]!.text) as Record<string, unknown> }
    } finally { state.script = outer; await client.close(); await server.close() }
  }
  const message = (messageId: string, text = '@Friday 评估一下 #42 适不适合你接手'): InboundMessage => ({ eventId: `event-${messageId}`, messageId, chatId: 'chat', chatType: 'group',
    senderOpenId: 'alice', senderType: 'user', threadId: 'synthetic-thread', rootId: 'synthetic-thread', msgType: 'text', text,
    mentions: [{ key: '@Friday', name: 'Friday', openId: 'bot' }], createTimeMs: Date.now() })
  const assessmentPrompts = () => state.allPrompts.filter(prompt => prompt.text.includes(ASSESSMENT_PROMPT))
  const rows = () => registry.db.prepare('SELECT id, state, failure, run_id, session_key FROM work_assessments ORDER BY created_at').all() as
    { id: string; state: string; failure: string | null; run_id: string | null; session_key: string | null }[]
  cleanups.push(async () => { api.beginShutdown(); host.beginShutdown(); await execution.runtime.stop(); api.server.closeAllConnections()
    await new Promise<void>(done => api.server.close(() => done())); await host.waitForShutdown(1000); registry.close(); rmSync(home, { recursive: true, force: true }) })
  return { host, registry, state, fake, provider, tool, current, message, sp, space, binding, issue, comments, timeline, assessments, assessmentPrompts, rows, interrupted }
}

describe('read-only issue assessment wired into the real host', () => {
  it('assesses a bound issue in a private managed no-tool Run, persists the verdict with literal evidence, and never writes GitHub', async () => {
    const t = await fixture()
    let result: Awaited<ReturnType<typeof t.tool>> | undefined
    t.state.script = [{ kind: 'hook', run: async () => { result = await t.tool('github_assess_issue', { number: 42 }) } }, { kind: 'text', text: '评估结果如下。' }]
    await t.host.handleMessage(t.message('request'))
    expect(result?.isError, result?.text).toBe(false)
    expect(result!.json).toMatchObject({ state: 'completed', repo: 'org/demo', number: 42, reused: false, requiresExecutionAuthorization: true, handoff: null,
      result: { verdict: 'recommend', evidence: [{ quote: t.issue.body }], proposedAction: { kind: 'develop_change' } } })
    // One persisted row bound to its own routine-stage Run; that Run is completed and its session archived.
    const [row] = t.rows(); expect(t.rows()).toHaveLength(1)
    expect(row).toMatchObject({ id: result!.json!.assessmentId, state: 'completed', failure: null })
    expect(row!.run_id).toBeTruthy(); expect(row!.session_key).toMatch(/^issue-assessment:/)
    expect(t.registry.db.prepare('SELECT stage, state, actor_open_id FROM run_attempts WHERE id=?').get(row!.run_id!)).toEqual({ stage: 'routine', state: 'completed', actor_open_id: 'alice' })
    expect(t.registry.getSession(row!.session_key!)?.status).toBe('archived')
    // The evaluator saw the assessment prompt with no MCP server; the human task kept its own tools.
    const prompts = t.assessmentPrompts(); expect(prompts).toHaveLength(1)
    expect(prompts[0]!.mcpServers).toEqual([])
    expect(t.state.allPrompts).toHaveLength(2)
    expect((t.state.allPrompts[0]!.mcpServers as unknown[]).length).toBeGreaterThan(0)
    // GitHub was only read (issue, comments, timeline, re-read); no comment, no Issue operation row, no message to anyone else.
    expect(t.provider.writes).toBe(0)
    expect(t.provider.calls.every(call => call.startsWith('GET '))).toBe(true)
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_issue_operations').get()?.n).toBe(0)
    expect(t.fake.of('sendToChat')).toHaveLength(0); expect(t.fake.of('sendToUser')).toHaveLength(0)
    expect(t.fake.answers().join('\n')).toContain('评估结果如下')
  })

  it('repeated tool calls in the same task and the same sentence in a new task return the same record without another model Run', async () => {
    const t = await fixture()
    const seen: Record<string, unknown>[] = []
    t.state.script = [{ kind: 'hook', run: async () => {
      seen.push((await t.tool('github_assess_issue', { number: 42 })).json!)
      seen.push((await t.tool('github_assess_issue', { number: 42 })).json!)
      seen.push((await t.tool('github_get_assessment', { assessmentId: seen[0]!.assessmentId })).json!)
    } }, { kind: 'text', text: '已评估。' }]
    await t.host.handleMessage(t.message('first'))
    expect(seen).toHaveLength(3)
    expect(seen[1]).toEqual(seen[0]); expect(seen[2]).toEqual(seen[0])
    expect(t.assessmentPrompts()).toHaveLength(1)
    // The same person asks the same sentence again: a new Task and Work, the thread is re-read and found unchanged,
    // so the earlier record is presented (reused) instead of buying a second evaluation.
    const reads = t.provider.calls.length
    t.state.script = [{ kind: 'hook', run: async () => {
      seen.push((await t.tool('github_assess_issue', { number: 42 })).json!)
      seen.push((await t.tool('github_get_assessment', { assessmentId: seen[0]!.assessmentId })).json!)
    } }, { kind: 'text', text: '还是那条评估。' }]
    await t.host.handleMessage(t.message('second'))
    expect(seen).toHaveLength(5)
    expect(seen[3]).toEqual({ ...seen[0], reused: true }); expect(seen[4]).toEqual(seen[0])
    expect(t.assessmentPrompts()).toHaveLength(1)
    expect(t.rows()).toHaveLength(1)
    expect(t.provider.calls.length).toBeGreaterThan(reads); expect(t.provider.writes).toBe(0)
    const first = t.registry.taskForMessage('first')!, second = t.registry.taskForMessage('second')!
    expect(t.registry.taskWork.get(first.id)?.key).not.toBe(t.registry.taskWork.get(second.id)?.key)
    // A changed thread is a new assessment under the new Task: a second row and a second evaluation.
    t.comments.push({ id: 10, body: 'I will take this one.', user: { login: 'maintainer', type: 'User' }, created_at: new Date(Date.now() - 2 * DAY).toISOString() })
    t.issue.comments = 2; t.timeline.push({ event: 'commented', id: 10 })
    t.state.script = [{ kind: 'hook', run: async () => { seen.push((await t.tool('github_assess_issue', { number: 42 }, 'need_info')).json!) } }, { kind: 'text', text: '线程有变化，重新评估。' }]
    await t.host.handleMessage(t.message('third'))
    expect(seen[5]).toMatchObject({ reused: false, result: { verdict: 'need_info' } })
    expect(seen[5]!.assessmentId).not.toBe(seen[0]!.assessmentId)
    expect(t.assessmentPrompts()).toHaveLength(2); expect(t.rows()).toHaveLength(2)
  })

  it('fails the assessment when the evaluator attempts a tool call, keeps the failure, and does not buy it again in that task', async () => {
    const t = await fixture()
    let attempt: Awaited<ReturnType<typeof t.tool>> | undefined, repeated: Awaited<ReturnType<typeof t.tool>> | undefined
    t.state.script = [{ kind: 'hook', run: async () => {
      attempt = await t.tool('github_assess_issue', { number: 42 }, 'tool')
      repeated = await t.tool('github_assess_issue', { number: 42 })
    } }, { kind: 'text', text: '评估没有完成。' }]
    await t.host.handleMessage(t.message('request'))
    expect(attempt?.isError).toBe(true)
    expect(repeated?.isError, repeated?.text).toBe(false)
    expect(repeated!.json).toMatchObject({ state: 'failed', failure: 'execution_failed', result: null, handoff: null })
    expect(t.rows()).toEqual([expect.objectContaining({ state: 'failed', failure: 'execution_failed' })])
    expect(t.assessmentPrompts()).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT state FROM run_attempts WHERE id=?').get(t.rows()[0]!.run_id!)?.state).toBe('cancelled')
    expect(t.provider.writes).toBe(0)
  })

  it('refuses without a current binding and refuses a member who is not the group owner when the binding owner left', async () => {
    const t = await fixture()
    let unbound: Awaited<ReturnType<typeof t.tool>> | undefined, gone: Awaited<ReturnType<typeof t.tool>> | undefined
    t.state.script = [{ kind: 'hook', run: async () => {
      const raw = t.registry.getKv(`issue-watch:${t.space.id}`)!
      t.registry.setKv(`issue-watch:${t.space.id}`, '')
      unbound = await t.tool('github_assess_issue', { number: 42 })
      t.registry.setKv(`issue-watch:${t.space.id}`, raw)
      t.fake.members.set('chat', new Set(['bob']))
      gone = await t.tool('github_assess_issue', { number: 42 })
    } }, { kind: 'text', text: '没有评估。' }]
    await t.host.handleMessage(t.message('request'))
    expect(unbound?.isError).toBe(true); expect(unbound?.text).toContain('not_authorized')
    expect(gone?.isError).toBe(true)
    expect(t.rows()).toHaveLength(0); expect(t.assessmentPrompts()).toHaveLength(0)
    expect(t.provider.writes).toBe(0)
  })

  it('refuses a private-chat request before any GitHub read', async () => {
    const t = await fixture()
    let dm: Awaited<ReturnType<typeof t.tool>> | undefined
    t.state.script = [{ kind: 'hook', run: async () => { dm = await t.tool('github_assess_issue', { number: 42 }) } }, { kind: 'text', text: '私聊里不评估。' }]
    await t.host.handleMessage({ ...t.message('dm-request', '评估一下 #42 适不适合你接手'), chatId: 'dm-alice', chatType: 'p2p', threadId: undefined, rootId: undefined, mentions: [] })
    expect(dm?.isError).toBe(true); expect(dm?.text).toContain('只在群里')
    expect(t.rows()).toHaveLength(0); expect(t.provider.calls).toHaveLength(0)
  })

  it('marks a running assessment interrupted on restart and does not replay it', async () => {
    const t = await fixture()
    let first: Awaited<ReturnType<typeof t.tool>> | undefined, repeated: Awaited<ReturnType<typeof t.tool>> | undefined
    t.state.script = [{ kind: 'hook', run: async () => {
      first = await t.tool('github_assess_issue', { number: 42 }, 'interrupt')
      repeated = await t.tool('github_assess_issue', { number: 42 })
    } }, { kind: 'text', text: '被中断。' }]
    await t.host.handleMessage(t.message('request'))
    expect(t.interrupted.count).toBe(1)
    expect(first?.isError).toBe(true)
    expect(repeated?.isError, repeated?.text).toBe(false)
    expect(repeated!.json).toMatchObject({ state: 'interrupted', failure: 'interrupted', result: null })
    expect(t.rows()).toEqual([expect.objectContaining({ state: 'interrupted', failure: 'interrupted' })])
    expect(t.assessmentPrompts()).toHaveLength(1)
  })
})
