import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import type { IngressClassificationInput, IngressDecision } from '../src/acp/ingress-classifier.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineControlError, RoutineScheduler, RoutineStore, type Routine } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { createInternalApi } from '../src/internal/api.js'
import { GROUP_SCOPES, TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const NOW = Date.UTC(2026, 8, 20)
const ROOT = 'om_followup_origin'
const TOPIC = 'omt_followup_origin'
const RESULT = 'SYNTHETIC_FOLLOWUP_MUST_NOT_LEAK'
const log = createLogger('followup-cancellation', 'error')
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

// Observe rejection immediately: a cancelled queued run may settle before its
// test releases an unrelated ACP prompt. Avoid unhandled promise rejections.
function settled<T>(promise: Promise<T>) {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
}

async function setup(options: { hostStop?: boolean; sourceGuard?: boolean; actorBinding?: boolean; maxSteps?: number; ingressControl?: boolean; persisted?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-followup-cancel-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000',
    ...(options.maxSteps === undefined ? {} : { FRIDAY_MAX_STEPS_PER_TURN: String(options.maxSteps) }) } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const databasePath = options.persisted ? join(home, 'test.sqlite') : ':memory:'
  const registry = new Registry(databasePath)
  const routines = new RoutineStore(registry.db)
  const memory = new ChannelMemory(registry.db)
  const todos = new Todos(registry.db)
  const sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_alice' })
  const feishu = new FakeFeishu()
  feishu.threadIdForReply = TOPIC
  feishu.members.set('oc_group', new Set(['ou_alice']))
  const messageCache = new MessageCache(registry.db)
  const messages = new MessageService(asFeishuClient(feishu), messageCache, log)
  const tokens = new TokenIssuer('synthetic-followup-cancellation')
  const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: '已建立合成原话题' }] })
  const clock = { now: NOW }
  const classify = vi.fn<(input: IngressClassificationInput, signal?: AbortSignal) => Promise<IngressDecision>>(async () => ({ kind: 'clarify' }))
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app },
    onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, registry, routines, memory, todos, messages, ...sp,
    feishu: asFeishuClient(feishu), runtime, tokens, apiBaseUrl: 'http://127.0.0.1:1',
    mcpServerPath: '/nonexistent/synthetic-mcp', botOpenId: 'ou_bot', log, now: () => clock.now,
    ...(options.ingressControl ? { ingressClassifier: { classify } } : {}) })
  let serial = 0
  const message = (text: string, over: Partial<InboundMessage> = {}): InboundMessage => {
    const id = `om_control_${++serial}`
    return { eventId: `event_${id}`, messageId: id, chatId: 'oc_group', chatType: 'group', msgType: 'text',
      text: `@Friday ${text}`, senderOpenId: 'ou_alice', senderType: 'user', rootId: ROOT, threadId: TOPIC,
      mentions: [{ key: '@Friday', openId: 'ou_bot', name: 'Friday' }], createTimeMs: clock.now, ...over }
  }
  const command = (text: string) => orchestrator.handleMessage(message(text))
  await orchestrator.handleMessage(message('建立原话题', { messageId: ROOT, rootId: undefined, threadId: undefined }))
  const session = registry.resolveSession([`msg:${ROOT}`])!
  expect(session.acpSessionId).toBeTruthy()
  state.allPrompts.length = 0
  feishu.sent.length = 0

  const github = {
    repoAllowed: (repo: string) => repo === 'test-org/test-repo', repoWritable: (repo: string) => repo === 'test-org/test-repo',
    async api(_method: string, path: string) {
      if (path.includes('/comments?')) return []
      return { number: 301, title: '合成事项', state: 'open', html_url: 'https://github.com/test-org/test-repo/issues/301', assignees: [], labels: [] }
    },
  } as unknown as GitHubIdentity
  const api = createInternalApi({ registry, routines, memory, todos, messages, messageCache, ...sp,
    feishu: asFeishuClient(feishu), tokens, log, maxHistoryPerCall: 100, github,
    ...(options.hostStop === false ? {} : { stopRoutine: (id: number, mode: 'pause' | 'remove') => orchestrator.stopRoutine(id, mode) }),
    ...(options.actorBinding ? { resolveActorForSession: (key: string) => orchestrator.resolveActorForSession(key) } : {}),
    ...(options.sourceGuard ? { canPersistDerivedState: (key: string) => orchestrator.canPersistDerivedState(key) } : {}),
    onRepositoryRead: (key, repo) => orchestrator.noteRepositoryRead(key, repo) })
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const controlSession = registry.createSession({ sessionKey: 'msg:om_control_api', chatId: 'oc_group', chatType: 'group',
    requesterOpenId: 'ou_alice', cwd: home, rootMessageId: 'om_control_api' })
  const token = tokens.issue({ sessionKey: controlSession.sessionKey, chatId: 'oc_group', chatType: 'group',
    requesterOpenId: 'ou_alice', cwd: home, scopes: [...GROUP_SCOPES] })
  const originToken = () => {
    const acpId = state.allPrompts.at(-1)?.sessionId
    if (!acpId) throw new Error('工具夹具必须在真实 ACP 本轮开始后读取 token')
    const servers = state.sessions.get(acpId)!.mcpServers as { env?: { name: string; value: string }[] }[]
    const value = servers.flatMap(server => server.env ?? []).find(item => item.name === 'FRIDAY_CAP_TOKEN')?.value
    if (!value) throw new Error('本轮 ACP 未收到宿主签发 token')
    return value
  }
  const request = async (path: string, body: Record<string, unknown>, capability = token) => {
    const response = await fetch(`${baseUrl}/v1/${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const post = (body: Record<string, unknown>) => request('routine/remove', body)
  cleanups.push(async () => {
    await runtime.stop()
    await new Promise<void>((resolve, reject) => api.server.close((error) => error ? reject(error) : resolve()))
    registry.close()
    rmSync(home, { recursive: true, force: true })
  })
  const add = (over: Partial<Parameters<RoutineStore['add']>[0]> = {}) => routines.add({
    kind: 'followup', spaceId: space.id, ownerOpenId: 'ou_alice', chatId: 'oc_group', chatType: 'group',
    sessionKey: session.sessionKey, ...(over.kind && over.kind !== 'followup' ? {} : { originTaskId: registry.taskForMessage(ROOT)!.id }), name: '合成原话题跟进', prompt: '检查原话题并返回合成结果',
    schedule: { type: 'once', atMs: NOW + 60_000 }, now: NOW, ...over,
  })
  const start = (routine: Routine) => {
    clock.now = routine.nextRunAt
    const claimed = routines.claimDueOccurrence(routine.id, routine.nextRunAt, clock.now)!
    const current = routines.startOccurrence(claimed.id, clock.now)!
    return { routine: current, occurrence: routines.getOccurrence(claimed.id)! }
  }
  const run = (execution: ReturnType<typeof start>) => settled(orchestrator.runRoutine(execution.routine, { occurrence: execution.occurrence }))
  const tasks = () => registry.db.prepare('SELECT id, status, prompt FROM tasks WHERE session_key = ? ORDER BY id').all(session.sessionKey) as { id: number; status: string; prompt: string }[]
  return { registry, routines, feishu, runtime, state, session, clock, command, message, post, request, originToken, tokens, home, databasePath, add, start, run, tasks, orchestrator, classify }
}

describe('followup cancellation in the original topic', () => {
  it('keeps the original task ahead of a followup queued while its initial ACK is awaiting', async () => {
    const t = await setup({ ingressControl: true })
    const original = t.registry.taskForMessage(ROOT)!
    t.classify.mockImplementationOnce(async input => ({ kind: 'amend', targetRef: input.candidates.find(candidate => candidate.title === original.prompt)!.ref }))
    const ackAccepted = deferred()
    const releaseAck = deferred()
    const modelEntered = deferred()
    const releaseModel = deferred()
    const currentMessage = t.message('ACK_PENDING_ORIGINAL_MUST_EXECUTE_FIRST')
    const actualReaction = t.feishu.addReaction.bind(t.feishu)
    vi.spyOn(t.feishu, 'addReaction').mockImplementation(async (messageId, emoji) => {
      const id = await actualReaction(messageId, emoji)
      if (messageId === currentMessage.messageId && emoji === 'OnIt') {
        ackAccepted.resolve()
        await releaseAck.promise
      }
      return id
    })
    t.state.script = [{ kind: 'hook', run: async () => { modelEntered.resolve(); await releaseModel.promise } },
      { kind: 'text', text: '合成顺序执行结果' }]
    const current = settled(t.orchestrator.handleMessage(currentMessage))
    await ackAccepted.promise
    const execution = t.start(t.add({ prompt: 'QUEUED_FOLLOWUP_MUST_EXECUTE_SECOND' }))
    const followup = t.run(execution)
    try {
      await vi.waitFor(() => expect(t.tasks().some((task) => task.prompt === execution.routine.prompt && task.status === 'queued')).toBe(true))
      expect(t.registry.taskForMessage(currentMessage.messageId)?.status).toBe('queued')
      expect(t.state.allPrompts).toHaveLength(0)
      releaseAck.resolve()
      await modelEntered.promise
      expect(t.state.allPrompts).toHaveLength(1)
      expect(t.state.allPrompts[0]?.text).toContain('ACK_PENDING_ORIGINAL_MUST_EXECUTE_FIRST')
      expect(t.state.allPrompts[0]?.text).not.toContain('QUEUED_FOLLOWUP_MUST_EXECUTE_SECOND')
    } finally { releaseAck.resolve(); releaseModel.resolve() }
    expect((await current).ok).toBe(true)
    expect((await followup).ok).toBe(true)
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.state.allPrompts[1]?.text).toContain('QUEUED_FOLLOWUP_MUST_EXECUTE_SECOND')
    expect(t.state.allPrompts.map((prompt) => prompt.sessionId)).toEqual([t.session.acpSessionId, t.session.acpSessionId])
    expect(t.tasks().map(task => t.registry.taskWork.get(task.id)?.key)).toEqual([t.registry.taskWork.get(original.id)!.key, t.registry.taskWork.get(original.id)!.key, t.registry.taskWork.get(original.id)!.key])
    expect(t.tasks().slice(-2).map((task) => task.status)).toEqual(['done', 'done'])
    expect(t.state.cancelled).toEqual([])
    expect(t.feishu.reactionsOn(currentMessage.messageId)).not.toContain('OnIt')
  })

  it.each(['once', 'interval'] as const)('stops only the queued %s followup and persists occurrence cancellation before the original worker returns', async (scheduleType) => {
    const t = await setup({ ingressControl: true, persisted: true })
    const entered = deferred()
    const release = deferred()
    t.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } }, { kind: 'text', text: 'ORIGINAL_WORKER_SURVIVES_QUEUED_STOP' }]
    const currentMessage = t.message('继续当前工作，另一个跟进先排队')
    t.classify.mockResolvedValueOnce({ kind: 'work_request' }) // Existing text is offered as material; this is still the current Session.
    const current = settled(t.orchestrator.handleMessage(currentMessage))
    await entered.promise
    const currentTask = t.registry.taskForMessage(currentMessage.messageId)!
    const future = t.add({ kind: 'schedule', sessionKey: undefined, name: '不可误停的未来职责', schedule: { type: 'interval', everyMinutes: 30 } })
    const execution = t.start(t.add({ schedule: scheduleType === 'once'
      ? { type: 'once', atMs: NOW + 60_000 } : { type: 'interval', everyMinutes: 10 } }))
    const before = t.routines.get(execution.routine.id)!
    const version = t.routines.configVersion(execution.routine.id)
    const followup = t.run(execution)
    await vi.waitFor(() => expect(t.tasks().some((task) => task.prompt === execution.routine.prompt && task.status === 'queued')).toBe(true))
    const followupTask = t.tasks().find((task) => task.prompt === execution.routine.prompt)!
    t.classify.mockImplementationOnce(async (input) => {
      expect(input.candidates).toHaveLength(2) // Current independent Work and original Work with its queued followup.
      const queued = input.candidates.find(candidate => candidate.status === 'queued')
      expect(queued?.title).toBe('建立原话题') // A scheduled event is not a newer human instruction.
      expect(queued?.lastInputAt).toBe(t.registry.dispatches.get(t.registry.taskForMessage(ROOT)!.id)?.inbound.createTimeMs)
      return { kind: 'stop', targetRef: queued!.ref }
    })
    try {
      await t.orchestrator.handleMessage(t.message('只停排队的那次跟进，当前工作和以后的安排保留'))
      expect(t.registry.getTask(followupTask.id)).toMatchObject({ status: 'cancelled', stopReason: 'user_requested', startedAt: null })
      expect(t.routines.getOccurrence(execution.occurrence.id)?.status).toBe('cancelled')
      expect(t.registry.getTask(currentTask.id)?.status).toBe('running')
      expect(t.state.cancelled).toEqual([])
      expect(t.state.allPrompts).toHaveLength(1)
      expect(t.tasks()).toHaveLength(3) // original topic, current worker, queued followup
      expect(t.routines.configVersion(execution.routine.id)).toBe(version)
      expect(t.routines.get(future.id)).toEqual(future)

      // Reopen the persisted database while the cancelled task still sits behind
      // the held worker: startup recovery must not reinterpret it as interrupted.
      const reopened = new Registry(t.databasePath)
      try {
        const store = new RoutineStore(reopened.db)
        expect(store.recoverInterruptedOccurrences(t.clock.now + 1)).toEqual([])
        expect(store.getOccurrence(execution.occurrence.id)?.status).toBe('cancelled')
        expect(store.get(future.id)).toEqual(future)
        expect(store.get(execution.routine.id)).toMatchObject({ enabled: before.enabled, schedule: before.schedule,
          nextRunAt: before.nextRunAt, messageCursorSec: before.messageCursorSec, runs: 0, failCount: 0 })
        if (scheduleType === 'interval') {
          expect(store.get(execution.routine.id)).toEqual(before)
          expect(store.due(before.nextRunAt).some((routine) => routine.id === execution.routine.id)).toBe(true)
        } else {
          expect(store.get(execution.routine.id)?.disabledReason).toMatch(/本次.*(?:停止|取消|中止)/)
        }
      } finally { reopened.close() }
    } finally { release.resolve() }
    expect((await current).ok).toBe(true)
    expect((await followup).ok).toBe(false)
    expect(t.registry.getTask(currentTask.id)?.status).toBe('done')
    expect(t.registry.getTask(followupTask.id)?.status).toBe('cancelled')
    expect(t.routines.getOccurrence(execution.occurrence.id)?.status).toBe('cancelled')
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.answers()).toContain('ORIGINAL_WORKER_SURVIVES_QUEUED_STOP')
    expect(JSON.stringify(t.feishu.sent)).not.toContain(RESULT)
  })

  it.each(['progress', 'stop'] as const)('handles natural-language %s for an active followup without changing future responsibilities', async (kind) => {
    const t = await setup({ ingressControl: true })
    const future = t.add({ kind: 'schedule', sessionKey: undefined, name: '不可误停的未来职责', schedule: { type: 'interval', everyMinutes: 30 } })
    const execution = t.start(t.add())
    const before = t.routines.get(execution.routine.id)!
    const version = t.routines.configVersion(execution.routine.id)
    const entered = deferred()
    const release = deferred()
    t.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } }, { kind: 'text', text: RESULT }]
    t.classify.mockImplementation(async (input) => {
      expect(input.candidates).toHaveLength(1) // One Work, with its active followup as execution target.
      const active = input.candidates[0]
      expect(active).toMatchObject({ status: 'running', title: '建立原话题' })
      expect(active?.lastInputAt).toBe(t.registry.dispatches.get(t.registry.taskForMessage(ROOT)!.id)?.inbound.createTimeMs)
      return { kind, targetRef: active!.ref }
    })
    const running = t.run(execution)
    await entered.promise
    try {
      await t.orchestrator.handleMessage(t.message(kind === 'progress' ? '这个跟进做到哪了？不用停' : '停下这次执行，之后的安排保留'))
      expect(t.classify).toHaveBeenCalledTimes(1)
      expect(t.tasks()).toHaveLength(2) // bootstrap + followup; control is not a new task
      expect(t.state.allPrompts).toHaveLength(1)
      expect(t.routines.get(future.id)).toEqual(future)
      expect(t.routines.configVersion(execution.routine.id)).toBe(version)
      if (kind === 'progress') {
        expect(JSON.stringify(t.feishu.sent)).toContain('执行中')
        expect(t.state.cancelled).toEqual([])
        expect(t.routines.get(execution.routine.id)).toEqual(before)
        expect(t.routines.getOccurrence(execution.occurrence.id)?.status).toBe('running')
      } else {
        expect(t.state.cancelled).toContain(t.session.acpSessionId)
        expect(t.routines.getOccurrence(execution.occurrence.id)?.status).toBe('cancelled')
        expect(t.routines.get(execution.routine.id)).toMatchObject({ enabled: before.enabled, schedule: before.schedule,
          nextRunAt: before.nextRunAt, messageCursorSec: before.messageCursorSec, failCount: 0, runs: 0 })
        expect(t.routines.get(execution.routine.id)?.disabledReason).toMatch(/本次.*(?:停止|取消|中止)/)
        expect(t.routines.due(t.clock.now).some((routine) => routine.id === execution.routine.id)).toBe(false)
      }
    } finally { release.resolve() }
    const result = await running
    expect(result.ok).toBe(kind === 'progress')
    expect(t.tasks().at(-1)?.status).toBe(kind === 'progress' ? 'done' : 'cancelled')
    if (kind === 'stop') expect(JSON.stringify(t.feishu.sent)).not.toContain(RESULT)
  })

  it('continues an active one-shot in the original ACP session and replies to its original message', async () => {
    const t = await setup()
    const execution = t.start(t.add())
    t.state.script = [{ kind: 'text', text: RESULT }]
    expect(await t.run(execution)).toMatchObject({ ok: true, value: 'ok' })
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.state.allPrompts[0]?.sessionId).toBe(t.session.acpSessionId)
    expect(t.feishu.of('replyMarkdown')).toMatchObject([{ target: ROOT, payload: RESULT }])
    expect(t.feishu.of('sendToChat')).toHaveLength(0)
  })

  it('can schedule the next followup from its proven Work without inventing another human input', async () => {
    const t = await setup({ actorBinding: true, sourceGuard: true }), original = t.registry.taskForMessage(ROOT)!
    const execution = t.start(t.add())
    let next!: Routine
    t.state.script = [{ kind: 'hook', run: async () => {
      const result = await t.request('followup/add', { note: '下一轮继续原工作', in_minutes: 1, origin_task_id: 99999 }, t.originToken())
      expect(result.status).toBe(200)
      next = (result.body as { followup: Routine }).followup
      expect(next.originTaskId).toBe(original.id)
    } }, { kind: 'text', text: '第一轮已经核对' }]
    expect((await t.run(execution)).ok).toBe(true)
    t.state.script = [{ kind: 'text', text: '第二轮已经核对' }]
    expect((await t.run(t.start(next))).ok).toBe(true)
    const tasks = t.tasks()
    expect(tasks).toHaveLength(3)
    expect(tasks.map(task => t.registry.taskWork.get(task.id)?.key)).toEqual(Array(3).fill(t.registry.taskWork.get(original.id)!.key))
    expect(t.state.allPrompts.map(prompt => prompt.sessionId)).toEqual([t.session.acpSessionId, t.session.acpSessionId])
    for (const task of tasks.slice(1)) {
      expect(t.registry.dispatches.get(task.id)).toBeUndefined()
      expect(t.registry.db.prepare('SELECT 1 FROM task_receipts WHERE task_id = ? AND dedup_key = ?').get(task.id, ROOT)).toBeUndefined()
    }
  })

  it('does not attach an old followup to a newer independent Work in the same session', async () => {
    const t = await setup(), original = t.registry.taskForMessage(ROOT)!, routine = t.add()
    t.state.script = [{ kind: 'text', text: '独立工作已经核对' }]
    const unrelated = t.message('UNRELATED_FOLLOWUP_WORK_MUST_NOT_LEAK')
    await t.orchestrator.handleMessage(unrelated)
    const other = t.registry.taskForMessage(unrelated.messageId)!
    expect(t.registry.taskWork.get(other.id)?.key).not.toBe(t.registry.taskWork.get(original.id)?.key)
    t.state.script = [{ kind: 'text', text: RESULT }]
    expect((await t.run(t.start(routine))).ok).toBe(true)
    const task = t.tasks().at(-1)!
    expect(t.registry.taskWork.get(task.id)?.key).toBe(t.registry.taskWork.get(original.id)?.key)
    const prompt = t.state.allPrompts.at(-1)!
    expect(prompt.sessionId).not.toBe(t.state.allPrompts[0]?.sessionId)
    expect(prompt.text).not.toContain('UNRELATED_FOLLOWUP_WORK_MUST_NOT_LEAK')
    expect(prompt.text).toContain('建立原话题')
  })

  it.each(['pause', 'cancel', 'complete', 'archive-session'] as const)('does not revive a linked followup after original Work %s', async action => {
    const t = await setup()
    const original = t.registry.taskForMessage(ROOT)!, work = t.registry.taskWork.get(original.id)!
    const execution = t.start(t.add())
    if (action === 'archive-session') t.registry.updateSession(t.session.sessionKey, { status: 'archived' })
    else t.registry.workContexts.control(work.key, action === 'pause'
      ? { action: 'pause', reason: 'run_stop', causeRef: 'synthetic-stop' }
      : { action: action === 'cancel' ? 'cancel' : 'complete', causeRef: 'synthetic-control' })
    const before = t.registry.workContexts.get(work.key)
    expect((await t.run(execution)).ok).toBe(false)
    expect(t.registry.workContexts.get(work.key)).toEqual(before)
    expect(t.state.allPrompts).toHaveLength(0)
  })

  it('rechecks the original Work while the followup model is awaiting', async () => {
    const t = await setup(), work = t.registry.taskWork.get(t.registry.taskForMessage(ROOT)!.id)!
    const execution = t.start(t.add()), entered = deferred(), release = deferred()
    t.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } }, { kind: 'text', text: RESULT }]
    const running = t.run(execution)
    await entered.promise
    t.registry.workContexts.control(work.key, { action: 'pause', reason: 'manual', causeRef: 'synthetic-await-stop' })
    release.resolve()
    expect((await running).ok).toBe(false)
    expect(JSON.stringify(t.feishu.sent)).not.toContain(RESULT)
    expect(t.registry.workContexts.get(work.key)?.pauseReasons).toContainEqual(expect.objectContaining({ reason: 'manual' }))
  })

  it('keeps a legacy followup without a source independent instead of borrowing the newest Work', async () => {
    const t = await setup(), original = t.registry.taskForMessage(ROOT)!
    const execution = t.start(t.add({ originTaskId: null }))
    t.state.script = [{ kind: 'text', text: RESULT }]
    expect((await t.run(execution)).ok).toBe(true)
    const task = t.tasks().at(-1)!
    expect(t.registry.taskWork.get(task.id)?.key).not.toBe(t.registry.taskWork.get(original.id)?.key)
    expect(t.state.allPrompts[0]?.sessionId).not.toBe(t.session.acpSessionId)
    expect(t.feishu.of('replyMarkdown')).toMatchObject([{ target: ROOT, payload: RESULT }])
  })

  it.each(['version', 'another-routine'] as const)('rejects a mismatched %s occurrence before an ACP prompt', async (mismatch) => {
    const t = await setup()
    const execution = t.start(t.add())
    const occurrence = mismatch === 'version' ? { ...execution.occurrence, configVersion: execution.occurrence.configVersion + 1 }
      : t.start(t.add({ name: '其他职责' })).occurrence
    t.state.script = [{ kind: 'text', text: RESULT }]
    const result = await settled(t.orchestrator.runRoutine(execution.routine, { occurrence }))
    expect(result.ok).toBe(false)
    expect(t.state.allPrompts).toHaveLength(0)
    expect(t.feishu.sent).toHaveLength(0)
  })

  it.each(['command', 'api-disable', 'api-remove'] as const)('does not start a queued followup after %s and keeps the unrelated current task running', async (method) => {
    const t = await setup()
    const entered = deferred()
    const release = deferred()
    t.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } }, { kind: 'text', text: 'CURRENT_TASK_SURVIVES' }]
    const current = t.orchestrator.handleMessage(t.message('继续当前独立工作'))
    await entered.promise
    const execution = t.start(t.add())
    const followup = t.run(execution)
    await vi.waitFor(() => expect(t.tasks().some((task) => task.prompt === execution.routine.prompt && task.status === 'queued')).toBe(true))
    let apiStatus: number | undefined
    let cancelledBeforeRelease: string[] = []
    try {
      if (method === 'command') await t.command(`/routine off ${execution.routine.id}`)
      else apiStatus = (await t.post({ id: execution.routine.id, disable_only: method === 'api-disable' })).status
      cancelledBeforeRelease = [...t.state.cancelled]
    } finally { release.resolve() }
    await current
    const result = await followup
    if (method !== 'command') expect(apiStatus).toBe(200)
    expect(cancelledBeforeRelease).toEqual([])
    expect(result.ok).toBe(false)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.answers()).toEqual(['CURRENT_TASK_SURVIVES'])
    expect(t.tasks().find((task) => task.prompt === execution.routine.prompt)?.status).toBe('cancelled')
    if (method !== 'api-remove') expect(t.routines.getOccurrence(execution.occurrence.id)?.status).toBe('cancelled')
  })

  it('aborts an executing original-topic followup through the command without sending accumulated or late text', async () => {
    const t = await setup()
    const execution = t.start(t.add())
    const entered = deferred()
    const release = deferred()
    const prompt = vi.spyOn(t.runtime, 'prompt')
    t.state.script = [{ kind: 'text', text: RESULT }, { kind: 'hook', run: async () => { entered.resolve(); await release.promise } },
      { kind: 'text', text: 'LATE_RESULT' }]
    const running = t.run(execution)
    await entered.promise
    let aborted = false
    try {
      await t.command(`/routine off ${execution.routine.id}`)
      aborted = prompt.mock.calls[0]?.[2]?.signal?.aborted === true
    } finally { release.resolve() }
    const result = await running
    expect(aborted).toBe(true)
    expect(result.ok).toBe(false)
    expect(t.feishu.answers()).toEqual([])
    expect(JSON.stringify(t.feishu.sent)).not.toContain(RESULT)
    expect(t.tasks().at(-1)?.status).toBe('cancelled')
    expect(t.routines.getOccurrence(execution.occurrence.id)?.status).toBe('cancelled')
  })

  it.each([true, false])('cancels an executing followup through the natural-language tool HTTP route, disable_only=%s', async (disableOnly) => {
    const t = await setup()
    const execution = t.start(t.add())
    const other = t.add({ name: '保留的其他职责', schedule: { type: 'interval', everyMinutes: 10 } })
    const otherBefore = t.routines.get(other.id)
    const entered = deferred()
    const release = deferred()
    const prompt = vi.spyOn(t.runtime, 'prompt')
    t.state.script = [{ kind: 'text', text: RESULT }, { kind: 'hook', run: async () => { entered.resolve(); await release.promise } }]
    const running = t.run(execution)
    await entered.promise
    let aborted = false
    let response: Awaited<ReturnType<typeof t.post>> | undefined
    try {
      response = await t.post({ id: execution.routine.id, disable_only: disableOnly })
      aborted = prompt.mock.calls[0]?.[2]?.signal?.aborted === true
    } finally { release.resolve() }
    const result = await running
    expect(response?.status).toBe(200)
    expect(aborted).toBe(true)
    expect(result.ok).toBe(false)
    expect(t.feishu.sent).toHaveLength(0)
    expect(t.routines.get(other.id)).toEqual(otherBefore)
    if (disableOnly) expect(t.routines.get(execution.routine.id)).toMatchObject({ enabled: false, disabledReason: '手动停用' })
    else expect(t.routines.get(execution.routine.id)).toBeUndefined()
    t.state.script = [{ kind: 'text', text: 'OTHER_ROUTINE_SURVIVES' }]
    expect(await t.run(t.start(other))).toMatchObject({ ok: true, value: 'ok' })
    expect(t.feishu.answers()).toEqual(['OTHER_ROUTINE_SURVIVES'])
  })

  it('does not publish a completed followup if paused while awaiting fresh delivery membership', async () => {
    const t = await setup()
    const execution = t.start(t.add())
    const checking = deferred()
    const release = deferred()
    vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementation(async () => {
      checking.resolve()
      await release.promise
      return new Set(['ou_alice'])
    })
    t.state.script = [{ kind: 'text', text: `<at open_id="ou_alice">合成人甲</at> ${RESULT}` }]
    const running = t.run(execution)
    await checking.promise
    try { await t.command(`/routine off ${execution.routine.id}`) } finally { release.resolve() }
    expect((await running).ok).toBe(false)
    expect(t.feishu.answers()).toEqual([])
    expect(JSON.stringify(t.feishu.sent)).not.toContain(RESULT)
    const sent = t.registry.db.prepare("SELECT status FROM deliveries WHERE status IN ('sent', 'confirmed')").all()
    // Only the bootstrap answer predates this cancelled execution.
    expect(sent).toHaveLength(1)
  })

  it('keeps a different in-flight routine running when the target followup is paused', async () => {
    const t = await setup()
    const target = t.start(t.add())
    const other = t.start(t.add({ kind: 'schedule', name: '并行合成日报', schedule: { type: 'interval', everyMinutes: 10 }, sessionKey: undefined }))
    const targetEntered = deferred()
    const otherEntered = deferred()
    const targetRelease = deferred()
    const otherRelease = deferred()
    const prompt = vi.spyOn(t.runtime, 'prompt')
    t.state.script = [{ kind: 'hook', run: async () => { targetEntered.resolve(); await targetRelease.promise } }, { kind: 'text', text: RESULT }]
    const targetRun = t.run(target)
    await targetEntered.promise
    t.state.script = [{ kind: 'hook', run: async () => { otherEntered.resolve(); await otherRelease.promise } }, { kind: 'text', text: 'OTHER_INFLIGHT_SURVIVES' }]
    const otherRun = t.run(other)
    await otherEntered.promise
    let targetAborted = false
    let otherAborted = true
    let apiStatus: number | undefined
    try {
      apiStatus = (await t.post({ id: target.routine.id, disable_only: true })).status
      targetAborted = prompt.mock.calls[0]?.[2]?.signal?.aborted === true
      otherAborted = prompt.mock.calls[1]?.[2]?.signal?.aborted === true
    } finally { targetRelease.resolve(); otherRelease.resolve() }
    const [targetResult, otherResult] = await Promise.all([targetRun, otherRun])
    expect(apiStatus).toBe(200)
    expect(targetAborted).toBe(true)
    expect(otherAborted).toBe(false)
    expect(targetResult.ok).toBe(false)
    expect(otherResult).toMatchObject({ ok: true, value: 'ok' })
    expect(t.routines.configVersion(other.routine.id)).toBe(other.occurrence.configVersion)
    expect(JSON.stringify(t.feishu.sent)).not.toContain(RESULT)
    expect(JSON.stringify(t.feishu.sent)).toContain('OTHER_INFLIGHT_SURVIVES')
  })

  it('fails closed without the host stop operation instead of reporting an effective pause', async () => {
    const t = await setup({ hostStop: false })
    const routine = t.add()
    const before = t.routines.get(routine.id)
    expect((await t.post({ id: routine.id, disable_only: true })).status).toBe(503)
    expect(t.routines.get(routine.id)).toEqual(before)
  })

  it('can pause after a real GitHub read while add and update retain their derived-source boundary', async () => {
    const t = await setup({ sourceGuard: true })
    const target = t.add()
    const untouched = t.add({ name: '不能被改写的另一个职责' })
    const checks: { github?: number; pause?: number; add?: number; update?: number; source?: boolean } = {}
    t.state.script = [{ kind: 'hook', run: async () => {
      checks.github = (await t.request('github/issue', { repo: 'test-org/test-repo', number: 301 }, t.originToken())).status
      checks.source = JSON.parse(t.registry.getKv(`delivery-sources:${t.session.sessionKey}`)!).repositories.includes('test-org/test-repo')
      checks.pause = (await t.request('routine/remove', { id: target.id, disable_only: true }, t.originToken())).status
      checks.add = (await t.request('routine/add', { name: '不应新增', prompt: '不应保存仓库派生内容',
        schedule: { type: 'interval', everyMinutes: 10 } }, t.originToken())).status
      checks.update = (await t.request('routine/update', { id: untouched.id, prompt: '不应覆盖原指令' }, t.originToken())).status
    } }, { kind: 'text', text: '合成暂停操作已完成' }]
    await t.orchestrator.handleMessage(t.message('看过这个事项后，先停掉原来的跟进'))
    expect(checks).toEqual({ github: 200, source: true, pause: 200, add: 403, update: 403 })
    expect(t.routines.get(target.id)?.disabledReason).toBe('手动停用')
    expect(t.routines.get(untouched.id)).toEqual(untouched)
    expect(t.routines.listFor({ chatId: 'oc_group', chatType: 'group', ownerOpenId: 'ou_alice' })).toHaveLength(2)
  })

  it('still requires scope and current-chat ownership for cancellation', async () => {
    const t = await setup()
    const here = t.add()
    const elsewhere = t.add({ chatId: 'oc_other', name: '其他群职责' })
    const readonlyToken = t.tokens.issue({ sessionKey: t.session.sessionKey, chatId: 'oc_group', chatType: 'group',
      requesterOpenId: 'ou_alice', cwd: t.home, scopes: ['routine:read'] })
    expect((await t.request('routine/remove', { id: here.id, disable_only: true }, readonlyToken)).status).toBe(403)
    expect((await t.post({ id: elsewhere.id, disable_only: true })).status).toBe(404)
    expect(t.routines.get(here.id)).toEqual(here)
    expect(t.routines.get(elsewhere.id)).toEqual(elsewhere)
  })

  it('does not create another task, model turn or delivery for concurrent and repeated occurrence entry', async () => {
    const t = await setup()
    const execution = t.start(t.add())
    const entered = deferred()
    const release = deferred()
    t.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } }, { kind: 'text', text: 'ONE_OCCURRENCE_ONLY' }]
    const first = t.run(execution)
    await entered.promise
    let concurrent: Awaited<ReturnType<typeof t.run>> | undefined
    try { concurrent = await t.run(execution) } finally { release.resolve() }
    expect(await first).toMatchObject({ ok: true, value: 'ok' })
    expect(concurrent?.ok).toBe(false)
    expect(await t.run(execution)).toMatchObject({ ok: true, value: 'ok' })
    // The scheduler's finalization must not make the same occurrence executable again.
    expect(t.routines.finishOccurrence(execution.occurrence.id, 'ok', t.clock.now)?.runs).toBe(1)
    await t.run(execution)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.tasks().filter((task) => task.prompt === execution.routine.prompt)).toHaveLength(1)
    expect(t.feishu.answers()).toEqual(['ONE_OCCURRENCE_ONLY'])
    expect(t.routines.get(execution.routine.id)?.runs).toBe(1)
  })

  it('does not retry the same occurrence after the platform may have accepted its answer but lost the ACK', async () => {
    const t = await setup()
    const execution = t.start(t.add())
    const actualReply = t.feishu.replyMarkdown.bind(t.feishu)
    const reply = vi.spyOn(t.feishu, 'replyMarkdown').mockImplementation(async (...args) => {
      await actualReply(...args)
      throw new Error('synthetic acknowledgement lost')
    })
    t.state.script = [{ kind: 'text', text: 'UNKNOWN_POST_RESULT' }]
    expect((await t.run(execution)).ok).toBe(false)
    expect((await t.run(execution)).ok).toBe(false)
    expect(reply).toHaveBeenCalledTimes(1)
    expect(t.state.allPrompts).toHaveLength(1)
    // Read by state rather than trusting a model's claim about the failed POST.
    const unknown = t.registry.db.prepare("SELECT status FROM deliveries WHERE status = 'unknown'").all()
    expect(unknown).toHaveLength(1)
  })

  it('cannot resume a once followup paused after the platform accepted its answer but before its ACK arrived', async () => {
    const t = await setup()
    const execution = t.start(t.add())
    const accepted = deferred()
    const releaseAcknowledgement = deferred()
    const actualReply = t.feishu.replyMarkdown.bind(t.feishu)
    const reply = vi.spyOn(t.feishu, 'replyMarkdown').mockImplementation(async (...args) => {
      const acknowledgement = await actualReply(...args)
      accepted.resolve()
      await releaseAcknowledgement.promise
      return acknowledgement
    })
    t.state.script = [{ kind: 'text', text: 'ALREADY_ACCEPTED_ONCE_ONLY' }]
    const running = t.run(execution)
    await accepted.promise
    try {
      expect(t.feishu.answers()).toEqual(['ALREADY_ACCEPTED_ONCE_ONLY'])
      expect(t.registry.db.prepare("SELECT status FROM deliveries WHERE status = 'planned'").all()).toHaveLength(1)
      t.orchestrator.controlRoutine(execution.routine.id, 'pause')
      expect(t.routines.getOccurrence(execution.occurrence.id)).toMatchObject({ status: 'cancelled', startedAt: t.clock.now })
    } finally { releaseAcknowledgement.resolve() }
    await running
    expect(t.routines.get(execution.routine.id)).toMatchObject({ enabled: false, lastRunAt: null, runs: 0 })
    const deliveries = t.registry.db.prepare('SELECT * FROM deliveries ORDER BY delivery_key').all()
    // The bootstrap answer is the first receipt; the accepted followup is the second.
    expect(deliveries).toHaveLength(2)
    expect(deliveries.every((row) => (row as { status: string }).status === 'sent')).toBe(true)
    expect(deliveries).toContainEqual(expect.objectContaining({ status: 'sent', remote_id: t.feishu.of('replyMarkdown')[0]!.messageId }))
    const before = t.routines.get(execution.routine.id)
    const version = t.routines.configVersion(execution.routine.id)
    const occurrences = t.routines.listOccurrences(execution.routine.id)
    expect(occurrences).toHaveLength(1)
    expect(() => t.orchestrator.controlRoutine(execution.routine.id, 'resume')).toThrow(RoutineControlError)
    expect(t.routines.get(execution.routine.id)).toEqual(before)
    expect(t.routines.configVersion(execution.routine.id)).toBe(version)
    expect(t.routines.claimDueOccurrence(execution.routine.id, t.clock.now, t.clock.now + 1)).toBeUndefined()
    expect(t.routines.listOccurrences(execution.routine.id)).toEqual(occurrences)
    expect(t.registry.db.prepare('SELECT * FROM deliveries ORDER BY delivery_key').all()).toEqual(deliveries)
    expect(reply).toHaveBeenCalledTimes(1)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.answers()).toEqual(['ALREADY_ACCEPTED_ONCE_ONLY'])
  })

  it('revokes the old tool actor and permission requests after a configuration change during execution', async () => {
    const t = await setup({ actorBinding: true, sourceGuard: true })
    const execution = t.start(t.add())
    const checks: { before?: number; after?: number; actorBefore?: boolean; actorAfter?: boolean; derivedAfter?: boolean } = {}
    t.state.script = [{ kind: 'hook', run: async () => {
      const signedRunToken = t.originToken()
      checks.actorBefore = Boolean(t.orchestrator.resolveActorForSession(t.session.sessionKey))
      checks.before = (await t.request('routine/list', {}, signedRunToken)).status
      t.routines.update(execution.routine.id, { prompt: '配置已变更，旧轮不能继续' }, t.clock.now)
      checks.actorAfter = Boolean(t.orchestrator.resolveActorForSession(t.session.sessionKey))
      checks.derivedAfter = t.orchestrator.canPersistDerivedState(t.session.sessionKey)
      checks.after = (await t.request('routine/list', {}, signedRunToken)).status
    } }, { kind: 'permission', text: '读取合成文件', toolKind: 'read' }, { kind: 'text', text: RESULT }]
    expect((await t.run(execution)).ok).toBe(false)
    expect(checks).toEqual({ before: 200, after: 403, actorBefore: true, actorAfter: false, derivedAfter: false })
    expect(t.state.permissionDecisions).toEqual(['reject'])
    expect(t.tasks().at(-1)?.status).toBe('cancelled')
    expect(t.routines.getOccurrence(execution.occurrence.id)?.status).toBe('cancelled')
    expect(t.feishu.sent).toHaveLength(0)
  })

  it.each(['command', 'api'] as const)('keeps cancellation out of failure statistics and retains the manual pause reason after %s', async (method) => {
    const t = await setup()
    const routine = t.add()
    t.clock.now = routine.nextRunAt
    let apiStatus: number | undefined
    t.state.script = [{ kind: 'text', text: RESULT }, { kind: 'hook', run: async () => {
      if (method === 'command') await t.command(`/routine off ${routine.id}`)
      else apiStatus = (await t.post({ id: routine.id, disable_only: true })).status
    } }]
    const scheduler = new RoutineScheduler({ store: t.routines, now: () => t.clock.now, log,
      run: (current, occurrence) => t.orchestrator.runRoutine(current, { occurrence }) })
    expect(await scheduler.tick()).toBe(1)
    if (method === 'api') expect(apiStatus).toBe(200)
    expect(await scheduler.tick()).toBe(0)
    expect(t.routines.listOccurrences(routine.id)).toMatchObject([{ status: 'cancelled', error: '职责启用状态已改变' }])
    const paused = t.routines.get(routine.id)!
    expect(paused).toMatchObject({ enabled: false, disabledReason: '手动停用', failCount: 0, runs: 0, lastStatus: null, lastRunAt: null, lastError: null })
    const occurrence = t.routines.listOccurrences(routine.id)[0]!
    expect(t.routines.finishOccurrence(occurrence.id, 'failed', t.clock.now + 1000, 'synthetic late failure')).toBeUndefined()
    expect(t.routines.get(routine.id)).toEqual(paused)
    expect(t.feishu.answers()).toEqual([])
    expect(JSON.stringify(t.feishu.sent)).not.toContain(RESULT)
  })

  it('aborts the new wrap-up prompt when paused after the main prompt exhausted its step budget', async () => {
    const t = await setup({ maxSteps: 1 })
    const execution = t.start(t.add())
    const wrapEntered = deferred()
    const releaseWrap = deferred()
    const prompt = vi.spyOn(t.runtime, 'prompt')
    t.state.script = [
      { kind: 'hook', run: () => {
        // The fake ACP agent keeps the current script iterator. This replacement
        // applies only to the genuine second prompt created by the orchestrator.
        t.state.script = [
          { kind: 'text', text: RESULT },
          { kind: 'hook', run: async () => { wrapEntered.resolve(); await releaseWrap.promise } },
          { kind: 'text', text: 'WRAP_UP_LATE_RESULT' },
        ]
      } },
      { kind: 'tool', text: '合成读取一', toolKind: 'read' },
      { kind: 'tool', text: '合成读取二', toolKind: 'read' },
      { kind: 'text', text: 'MAIN_PROMPT_MUST_BE_CUT_OFF' },
    ]
    const running = t.run(execution)
    await wrapEntered.promise
    const mainSignal = prompt.mock.calls[0]?.[2]?.signal
    const wrapSignal = prompt.mock.calls[1]?.[2]?.signal
    const wrapWasAborted = wrapSignal?.aborted
    let response: Awaited<ReturnType<typeof t.post>> | undefined
    let wrapAbortedAfterPause = false
    try {
      response = await t.post({ id: execution.routine.id, disable_only: true })
      wrapAbortedAfterPause = wrapSignal?.aborted === true
    } finally { releaseWrap.resolve() }
    const result = await running
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.state.allPrompts[1]?.text).toContain('[收尾｜网关自动发起')
    expect(mainSignal?.aborted).toBe(true)
    expect(wrapSignal).toBeDefined()
    expect(wrapSignal).not.toBe(mainSignal)
    expect(wrapWasAborted).toBe(false)
    expect(response?.status).toBe(200)
    expect(wrapAbortedAfterPause).toBe(true)
    expect(result.ok).toBe(false)
    expect(t.tasks().at(-1)?.status).toBe('cancelled')
    expect(t.routines.getOccurrence(execution.occurrence.id)?.status).toBe('cancelled')
    expect(t.feishu.sent).toHaveLength(0)
    expect(t.routines.get(execution.routine.id)).toMatchObject({ disabledReason: '手动停用', failCount: 0 })
  })

  it('keeps a long followup in chat and does not publish it after pause during final audience verification', async () => {
    const t = await setup(), execution = t.start(t.add())
    const checking = deferred(), release = deferred()
    vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementation(async () => {
      checking.resolve(); await release.promise
      return new Set(['ou_alice'])
    })
    const create = vi.spyOn(t.feishu, 'createDocument'), grant = vi.spyOn(t.feishu, 'grantDocAccess')
    const longAnswer = [`<at open_id="ou_alice">合成人甲</at> ${RESULT}`, '', ...Array.from({ length: 1200 }, (_, index) =>
      `合成明细 ${index + 1}：这段文字只用于检验长正文交付中停止职责的时序，不对应任何真实业务。`)].join('\n')
    t.state.script = [{ kind: 'text', text: longAnswer }]
    const running = t.run(execution)
    await checking.promise
    let response: Awaited<ReturnType<typeof t.post>> | undefined
    try { response = await t.post({ id: execution.routine.id, disable_only: true }) } finally { release.resolve() }
    expect((await running).ok).toBe(false)
    expect(response?.status).toBe(200)
    expect(create).not.toHaveBeenCalled()
    expect(t.feishu.createdDocs).toEqual([])
    expect(grant).not.toHaveBeenCalled()
    expect(t.feishu.grants).toEqual([])
    expect(t.feishu.sent).toHaveLength(0)
    expect(t.tasks().at(-1)?.status).toBe('cancelled')
    expect(t.routines.getOccurrence(execution.occurrence.id)?.status).toBe('cancelled')
  })
})
