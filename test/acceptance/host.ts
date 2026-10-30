import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { AcpRuntime } from '../../src/acp/runtime.js'
import { loadConfig } from '../../src/config.js'
import { Bugs } from '../../src/core/bugs.js'
import { BugQuestions } from '../../src/core/bug-questions.js'
import { ConsoleCommands } from '../../src/core/console-commands.js'
import { ConsoleOperations } from '../../src/core/console-operations.js'
import { ConsoleQueries } from '../../src/core/console-queries.js'
import { ConsoleSessionStore } from '../../src/core/console-sessions.js'
import { DeliveryReconciliation } from '../../src/core/delivery-reconciliation.js'
import { FeedbackControl } from '../../src/core/feedback-control.js'
import { HumanSpaceAccess } from '../../src/core/human-space-access.js'
import { ChannelMemory } from '../../src/core/memory.js'
import { MessageCache } from '../../src/core/message-cache.js'
import { MessageService } from '../../src/core/messages.js'
import { Orchestrator, type HumanWorkTarget } from '../../src/core/orchestrator.js'
import { Registry } from '../../src/core/registry.js'
import { RoutineScheduler, RoutineStore } from '../../src/core/routines.js'
import { RunAttempts } from '../../src/core/run-attempts.js'
import { SkillProposals } from '../../src/core/skills.js'
import { SpaceApplication } from '../../src/core/space-application.js'
import { TodoApplication } from '../../src/core/todo-application.js'
import { Todos } from '../../src/core/todos.js'
import type { InboundMessage } from '../../src/feishu/mention.js'
import { UserTokenStore } from '../../src/feishu/oauth.js'
import { GitHubIdentity, loadGitHubConfig, type GitHubHttp } from '../../src/github/identity.js'
import { IssueLinks } from '../../src/github/issues.js'
import { createInternalApi, type InternalApiDeps } from '../../src/internal/api.js'
import { TokenIssuer } from '../../src/internal/tokens.js'
import { createLogger } from '../../src/log.js'
import { createFakeAgent, type FakeAgentState } from '../helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from '../helpers/fake-feishu.js'
import { spaceDeps } from '../helpers/space.js'

export const cleanups: (() => Promise<void> | void)[] = []
export async function closeAll(): Promise<void> { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() }
export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
export const waitUntil = (check: () => boolean, what: string) => vi.waitFor(() => { if (!check()) throw new Error(what) }, { timeout: 5000 })

/** Every GitHub call the host makes, answered from an in-memory model; `unknownOnCreate` drops the response after the remote accepted. */
export function fakeGitHub() {
  const state = { issues: [] as { number: number; title: string; body: string; author: string }[], unknownOnCreate: false, calls: [] as { method: string; path: string; body?: unknown }[], login: 'friday-bot' }
  const http: GitHubHttp = { async request(method, path, body) {
    state.calls.push({ method, path, body })
    const url = (n: number) => `https://github.com/org/a/issues/${n}`
    if (method === 'GET' && path === '/user') return { status: 200, data: { login: state.login } as never }
    if (path.startsWith('/search/issues')) {
      const params = new URLSearchParams(path.slice(path.indexOf('?') + 1)), q = params.get('q') ?? ''
      const items = state.issues.filter(issue => q.includes('in:title') ? q.includes(issue.title) : true)
        .map(issue => ({ number: issue.number, title: issue.title, html_url: url(issue.number), state: 'open', user: { login: issue.author }, created_at: new Date().toISOString() }))
      return { status: 200, data: { items, total_count: items.length, incomplete_results: false } as never }
    }
    if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(path)) {
      const input = body as { title: string; body: string }
      const issue = { number: 101 + state.issues.length, title: input.title, body: input.body, author: state.login }
      state.issues.push(issue)
      if (state.unknownOnCreate) throw new Error('connection lost after the remote created the issue')
      return { status: 201, data: { number: issue.number, html_url: url(issue.number) } as never }
    }
    const one = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path)
    if (method === 'GET' && one) {
      const issue = state.issues.find(candidate => candidate.number === Number(one[1]))
      if (!issue) return { status: 404, data: {} as never }
      return { status: 200, data: { number: issue.number, title: issue.title, body: issue.body, state: 'open', html_url: url(issue.number), user: { login: issue.author }, labels: [], assignees: [] } as never }
    }
    if (method === 'POST' && path.endsWith('/comments')) return { status: 201, data: { id: state.calls.length, html_url: `${url(101)}#issuecomment-${state.calls.length}` } as never }
    throw new Error(`unexpected GitHub call ${method} ${path}`)
  } }
  return { state, http }
}

export interface HostOptions { classifier?: (input: { text: string; replyToRef?: string; candidates: { ref: string; status: string }[] }) => Record<string, unknown> }

/**
 * The acceptance host: real Orchestrator, SQLite file, internal tool API over HTTP, console commands/queries, ACP protocol in-process.
 * The model (fake agent scripts), Feishu and GitHub are deterministic substitutes; every assertion is about host facts.
 */
export async function acceptanceHost(options: HostOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-acceptance-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off',
    FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_GITHUB_REPOS: 'org/a' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(join(home, 'friday.db')), db = registry.db, sp = spaceDeps(db, { admins: ['alice'] })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'group', openId: 'alice' })
  sp.spaces.addMember(group.id, 'bob', 'member')
  sp.spaces.ensure({ kind: 'p2p', chatId: 'dm-alice', openId: 'alice' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  fake.members.set('group', new Set(['alice', 'bob'])); fake.names.set('alice', '张三'); fake.names.set('bob', '李四')
  fake.chats.push({ chatId: 'group', name: '合成群' } as never)
  const log = createLogger('acceptance', 'error')
  const bugs = new Bugs(db), questions = new BugQuestions(db, bugs), routines = new RoutineStore(db), todos = new Todos(db)
  const feedback = new FeedbackControl(registry, bugs, questions, routines), memory = new ChannelMemory(db)
  const messageCache = new MessageCache(db), messages = new MessageService(feishu, messageCache, log)
  const attempts = new RunAttempts(db), skills = new SkillProposals(db, new Set()), issueLinks = new IssueLinks(db)
  // Personal authorization tokens follow their own clock so expiry can be simulated without waiting.
  const clock = { now: Date.now() }
  const userTokens = new UserTokenStore(db, fake, () => clock.now)
  const github = fakeGitHub()
  const identity = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'fake-test-token', FRIDAY_GITHUB_REPOS: 'org/a', FRIDAY_GITHUB_WRITE_REPOS: 'org/a' } as NodeJS.ProcessEnv)!, log, github.http)
  const tokens = new TokenIssuer('synthetic'), agent = createFakeAgent({ script: [] })
  const classify = options.classifier ?? (input => !input.replyToRef ? { kind: 'new_work' }
    : input.text.includes('停止') ? { kind: 'stop', targetRef: ['running', 'queued'].includes(input.candidates.find(c => c.ref === input.replyToRef)?.status ?? '') ? input.replyToRef : input.candidates.find(c => c.status === 'running')?.ref ?? input.replyToRef }
    : input.text.includes('进展') ? { kind: 'progress', targetRef: input.replyToRef }
    : { kind: 'amend', targetRef: input.replyToRef })
  let host!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: agent.app }, log, onPermission: (request, signal) => host.handlePermission(request, signal) })
  const orchestratorDeps = () => ({ cfg, registry, ...sp, memory, messages, questions, routines, todos, feedback, userTokens, skills, builtinSkillDigest: 'builtin-acceptance', feishu, tokens,
    repositoryAllowed: (repo: string) => identity.repoAllowed(repo), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/synthetic', botOpenId: 'bot', log,
    ingressClassifier: { classify: async (input: { message: { text: string; replyToRef?: string }; candidates: { ref: string; status: string }[] }) =>
      classify({ text: input.message.text, replyToRef: input.message.replyToRef, candidates: input.candidates }) as never } })
  host = new Orchestrator({ ...orchestratorDeps(), runtime } as never)
  const apiDeps = (target: () => Orchestrator): InternalApiDeps => ({
    registry, feedback, bugs, questions, routines, memory, messageCache, messages, todos, userTokens, skills, issueLinks, ...sp, feishu, tokens, log, maxHistoryPerCall: 50,
    github: identity, botName: 'Friday', appId: 'synthetic',
    confirm: async () => true,
    memoryRuntime: { recordRead: (runId, refs) => target().recordMemoryRead(runId, refs), search: (runId, scopes, query, limit) => target().searchMemory(runId, scopes, query, limit),
      add: (runId, input) => target().addMemory(runId, input), forget: (runId, id, scope) => target().forgetMemory(runId, id, scope) },
    resolveActorForSession: key => target().resolveActorForSession(key), allowedRoutesForSession: key => target().allowedRoutesForSession(key),
    canPersistDerivedState: (key, purpose) => target().canPersistDerivedState(key, purpose), canPersistPersonalMemory: key => target().canPersistPersonalMemory(key),
    stopFeedback: (key, runId, id, manage) => target().stopFeedback(key, runId, id, manage), canPersistFeedbackState: (key, runId, id) => target().canPersistFeedbackState(key, runId, id),
    recordDomainOperation: (key, runId, receipt) => target().recordDomainOperation(key, runId, receipt),
    controlRoutine: (id, action) => target().controlRoutine(id, action), stopRoutine: (id, mode) => target().stopRoutine(id, mode),
    onAuthorizationCompleted: openId => target().resumeAuthorizedRoutines(openId),
    resolveBugQuestionReply: (key, runId, input) => target().resolveBugQuestionReply(key, runId, input), askBugQuestion: (key, runId, input) => target().askBugQuestion(key, runId, input),
    deliverToolResult: (key, runId, input) => target().deliverToolResult(key, runId, input),
    onCrossSpaceRead: (key, read) => target().noteCrossSpaceRead(key, read), onChatHistoryRead: (key, read) => target().noteChatHistoryRead(key, read),
    onMessageRead: (key, runId, receipt) => target().noteMessageRead(key, runId, receipt), onExternalSourceRead: (key, read) => target().noteExternalSource(key, read),
    authorizePublicWebRequest: (cap, url) => target().authorizePublicWebRequest(cap, url),
    onRepositoryRead: (key, repo) => target().noteRepositoryRead(key, repo), canPublishToRepository: (key, repo) => target().canPublishToRepository(key, repo),
  })
  let current = () => host
  const api = createInternalApi(apiDeps(() => current()))
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const browser = new ConsoleSessionStore(db)
  const login = (openId: string) => browser.create({ appId: 'synthetic', tenantKey: 'tenant', openId, name: openId }).actor
  const access = new HumanSpaceAccess({ ...sp, feishu, assertActor: actor => { if (!browser.isCurrent(actor)) throw new Error('console session no longer current') } })
  const commands = new ConsoleCommands({ access, operations: new ConsoleOperations(db, { sessions: browser }), spaces: sp.spaces, routines, todos,
    spaceApplication: new SpaceApplication({ db, spaces: sp.spaces }), todoApplication: new TodoApplication({ db, todos }),
    reconciliation: new DeliveryReconciliation(db, { ...sp, feishu, botOpenId: 'bot' }),
    persistRoutineControl: (id, action, opts) => current().persistRoutineControl(id, action, opts),
    assertHumanRunTarget: input => current().assertHumanRunTarget(input), persistHumanRunStop: input => current().persistHumanRunStop(input),
    assertHumanWorkTarget: input => current().assertHumanWorkTarget(input), persistHumanWorkCancel: (input, opts) => current().persistHumanWorkCancel(input, opts),
    persistHumanWorkResume: (input, opts) => current().persistHumanWorkResume(input, opts) })
  const queries = new ConsoleQueries({ access, registry, memory, todos, routines, skills, defaults: { brevity: 'normal', reflect: false } })
  const pending: Promise<unknown>[] = [], releases: (() => void)[] = []
  let serial = 0
  const message = (over: Partial<InboundMessage> = {}): InboundMessage => {
    const id = `om_acceptance_${++serial}`
    return { eventId: id, messageId: id, chatId: 'group', chatType: 'group', threadId: 'topic', tenantId: 'tenant', msgType: 'text', text: '@Friday 检查合成任务',
      senderOpenId: 'alice', senderType: 'user', mentions: [{ key: '@Friday', name: 'Friday', openId: 'bot' }], createTimeMs: Date.now(), ...over }
  }
  const dm = (over: Partial<InboundMessage> = {}) => message({ chatId: 'dm-alice', chatType: 'p2p', threadId: undefined, mentions: [], text: '帮我看一下', ...over })
  /** A Run whose model turn is held open until released; returns the persisted Task, Run and a release handle. */
  const hold = async (over: Partial<InboundMessage> = {}, finalText = 'SYNTHETIC_FINAL') => {
    const entered = deferred(), release = deferred(); releases.push(release.resolve)
    agent.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } }, { kind: 'text', text: finalText }]
    const msg = message(over), result = current().handleMessage(msg).catch(error => ({ error })); pending.push(result)
    await entered.promise
    const task = registry.taskForMessage(msg.messageId)!
    return { msg, task, session: registry.getSession(task.sessionKey)!, runId: current().resolveActorForSession(task.sessionKey)!.runId!, release: release.resolve, result }
  }
  /** Run one message to completion with the given model script; hooks may call tools with `tool()`. */
  const run = async (script: FakeAgentState['script'], over: Partial<InboundMessage> = {}) => {
    // A failed expectation inside a model hook must surface as the test failure, not as an opaque ACP internal error.
    let hookError: unknown
    agent.state.script = script.map(step => step.kind === 'hook' ? { ...step, run: async () => { try { await step.run() } catch (error) { hookError ??= error; throw error } } } : step)
    const msg = message(over)
    await current().handleMessage(msg)
    if (hookError) throw hookError
    return { msg, task: registry.taskForMessage(msg.messageId) }
  }
  const currentToken = () => {
    const sessionId = agent.state.allPrompts.at(-1)?.sessionId ?? [...agent.state.sessions.keys()].at(-1)!
    const servers = agent.state.sessions.get(sessionId)!.mcpServers as { env: { name: string; value: string }[] }[]
    return servers[0]!.env.find(entry => entry.name === 'FRIDAY_CAP_TOKEN')!.value
  }
  const tool = async <T = Record<string, unknown>>(route: string, body: Record<string, unknown> = {}, token = currentToken()) => {
    const response = await fetch(`${url}/v1/${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as T }
  }
  const target = async (workKey: string, openId = 'alice'): Promise<HumanWorkTarget> => {
    const grant = await access.authorize(login(openId), group.id, { operation: 'read' })
    return { actorOpenId: openId, spaceId: group.id, workKey, assertCurrent: grant.assertCurrent }
  }
  /** The real scheduler entry: due → claim window → start → run → finish, driven by the test clock. */
  const scheduler = new RoutineScheduler({ store: routines, log, now: () => clock.now, run: (routine, occurrence) => current().runRoutine(routine, { occurrence }) })
  const tick = () => scheduler.tick()
  const executions = async (openId = 'alice', spaceId = group.id) =>
    (await queries.read(login(openId), spaceId, 'executions')).body.data as { items: { id: number; status: string; work: Record<string, unknown> | null; runs: { id: string; state: string; canStop: boolean }[]; deliveries: { key: string; status: string }[] }[] }
  const texts = (from = 0) => fake.sent.slice(from).map(item => typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload))
  /** A second process over the same database: startup recovery as index.ts performs it. */
  const restart = async () => {
    releases.forEach(release => release()); await Promise.allSettled(pending); pending.length = 0
    await runtime.stop()
    const next = createFakeAgent({ script: [{ kind: 'text', text: 'RESTARTED_FINAL' }] })
    let second!: Orchestrator
    const nextRuntime = new AcpRuntime({ transport: { kind: 'inproc', agent: next.app }, log, onPermission: (request, signal) => second.handlePermission(request, signal) })
    second = new Orchestrator({ ...orchestratorDeps(), runtime: nextRuntime } as never)
    cleanups.push(async () => { await nextRuntime.stop() })
    current = () => second
    const interrupted = second.recoverRuns()
    await second.recoverHandoffs()
    return { host: second, agent: next, interrupted }
  }
  cleanups.push(async () => {
    releases.forEach(release => release()); await Promise.allSettled(pending)
    api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve()))
    await runtime.stop().catch(() => undefined); registry.close(); rmSync(home, { recursive: true, force: true })
  })
  return { home, cfg, registry, db, ...sp, group, fake, feishu, bugs, questions, routines, todos, feedback, memory, messageCache, attempts, skills, issueLinks, userTokens, clock, github, identity,
    agent, runtime, get host() { return current() }, url, browser, login, access, commands, queries, message, dm, hold, run, tool, currentToken, target, executions, texts, restart, tick, pending, releases, expect }
}
export type AcceptanceHost = Awaited<ReturnType<typeof acceptanceHost>>
