import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { ConsoleCommands } from '../src/core/console-commands.js'
import { ConsoleOperations } from '../src/core/console-operations.js'
import { ConsoleQueries } from '../src/core/console-queries.js'
import { ConsoleSessionStore } from '../src/core/console-sessions.js'
import { HumanSpaceAccess } from '../src/core/human-space-access.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator, type HumanWorkTarget } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { SkillProposals } from '../src/core/skills.js'
import { SpaceApplication } from '../src/core/space-application.js'
import { TodoApplication } from '../src/core/todo-application.js'
import { Todos } from '../src/core/todos.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Real host, SQLite, browser-session/grant checks and ACP protocol; platform and model are synthetic. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-human-work-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), sp = spaceDeps(registry.db, { admins: ['alice'] })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'group', openId: 'alice' })
  sp.spaces.addMember(group.id, 'bob', 'member')
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  fake.members.set('group', new Set(['alice', 'bob']))
  const bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs), routines = new RoutineStore(registry.db)
  const memory = new ChannelMemory(registry.db), browser = new ConsoleSessionStore(registry.db)
  const login = (openId: string) => browser.create({ appId: 'synthetic', tenantKey: 'tenant', openId, name: openId }).actor
  const access = new HumanSpaceAccess({ ...sp, feishu, assertActor: current => {
    if (!browser.isCurrent(current)) throw new Error('console session no longer current')
  } })
  const log = createLogger('human-work-control', 'error'), agent = createFakeAgent()
  let host!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: agent.app }, log,
    onPermission: (request, signal) => host.handlePermission(request, signal) })
  host = new Orchestrator({ cfg, registry, ...sp, memory, questions, routines,
    feishu, runtime, tokens: new TokenIssuer('synthetic'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log,
    ingressClassifier: { classify: async input => !input.message.replyToRef ? { kind: 'new_work' }
      : input.message.text.includes('停止') ? { kind: 'stop', targetRef: input.candidates.find(c => c.status === 'running')?.ref ?? input.message.replyToRef }
      : input.message.text.includes('进展') ? { kind: 'progress', targetRef: input.message.replyToRef }
      : { kind: 'amend', targetRef: input.message.replyToRef } } })
  const attempts = new RunAttempts(registry.db), pending: Promise<unknown>[] = [], releases: (() => void)[] = []
  let serial = 0
  const message = (over: Partial<InboundMessage> = {}): InboundMessage => {
    const id = `human-work-${++serial}`
    return { eventId: id, messageId: id, chatId: 'group', chatType: 'group', threadId: 'topic', tenantId: 'tenant',
      msgType: 'text', text: '@Friday 检查合成任务', senderOpenId: 'alice', senderType: 'user',
      mentions: [{ key: '@Friday', name: 'Friday', openId: 'bot' }], createTimeMs: Date.now(), ...over }
  }
  const hold = async (over: Partial<InboundMessage> = {}) => {
    const entered = deferred(), release = deferred(); releases.push(release.resolve)
    agent.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } }, { kind: 'text', text: 'SYNTHETIC_FINAL' }]
    const msg = message(over), result = host.handleMessage(msg).catch(error => ({ error })); pending.push(result)
    await entered.promise
    const task = registry.taskForMessage(msg.messageId)!, session = registry.getSession(task.sessionKey)!
    const runId = host.resolveActorForSession(task.sessionKey)!.runId
    return { msg, task, session, runId, release: release.resolve, result }
  }
  /** Reply while the Run is busy: the Run is steered (asked to stop) and the reply queues as the next input of the same delegation. */
  const steer = async (root: Awaited<ReturnType<typeof hold>>, text = '再补充一点') => {
    const key = registry.taskWork.get(root.task.id)!.key, before = registry.workContexts.get(key)!.inputSeq
    const msg = message({ text, mentions: [], parentId: root.msg.messageId, rootId: root.msg.messageId })
    const result = host.handleMessage(msg).catch(error => ({ error })); pending.push(result)
    await vi.waitFor(() => { if (registry.workContexts.get(key)?.inputSeq !== before + 1) throw new Error('follow-up not registered yet') })
    return { msg, taskId: registry.workContexts.inputs(key).at(-1)!.taskId, result }
  }
  const target = async (workKey: string, openId = 'alice'): Promise<HumanWorkTarget> => {
    const grant = await access.authorize(login(openId), group.id, { operation: 'read' })
    return { actorOpenId: openId, spaceId: group.id, workKey, assertCurrent: grant.assertCurrent }
  }
  const todos = new Todos(registry.db)
  const queries = new ConsoleQueries({ access, registry, memory, todos, routines, skills: new SkillProposals(registry.db, new Set()), defaults: { brevity: 'normal', reflect: false } })
  const executions = async (openId = 'alice') => (await queries.read(login(openId), group.id, 'executions')).body.data as { items: { id: number; work: Record<string, unknown> | null; runs: { canStop: boolean }[] }[] }
  const commands = new ConsoleCommands({ access, operations: new ConsoleOperations(registry.db, { sessions: browser }), spaces: sp.spaces, routines, todos,
    spaceApplication: new SpaceApplication({ db: registry.db, spaces: sp.spaces }), todoApplication: new TodoApplication({ db: registry.db, todos }),
    persistRoutineControl: () => { throw new Error('not used') },
    assertHumanRunTarget: host.assertHumanRunTarget.bind(host), persistHumanRunStop: host.persistHumanRunStop.bind(host),
    assertHumanWorkTarget: host.assertHumanWorkTarget.bind(host), persistHumanWorkCancel: host.persistHumanWorkCancel.bind(host),
    persistHumanWorkResume: (input, opts) => host.persistHumanWorkResume(input, opts) })
  cleanups.push(async () => {
    releases.forEach(release => release()); await Promise.all(pending); await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true })
  })
  return { registry, ...sp, group, fake, feishu, bugs, questions, routines, browser, login, access, agent, runtime, host, attempts, hold, steer, target, message, pending, releases, commands, executions, cfg, log, sp, home }
}

/** A second process over the same database: what startup recovery does with inputs that were parked before the restart. */
function restarted(t: ReturnType<typeof fixture>) {
  const agent = createFakeAgent({ script: [{ kind: 'text', text: 'RESTARTED_FINAL' }] })
  let host!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: agent.app }, log: t.log, onPermission: (request, signal) => host.handlePermission(request, signal) })
  host = new Orchestrator({ cfg: t.cfg, registry: t.registry, ...t.sp, memory: new ChannelMemory(t.registry.db), questions: t.questions, routines: t.routines,
    feishu: t.feishu, runtime, tokens: new TokenIssuer('synthetic'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log: t.log })
  cleanups.push(async () => { await runtime.stop() })
  return { host, agent }
}

describe('human cancels a whole delegation', () => {
  it('cancels the work with its open question and running Run inside the caller transaction, signalling only after commit', async () => {
    const t = fixture(), run = await t.hold(), key = t.registry.taskWork.get(run.task.id)!.key
    const bucket = t.bugs.record({ spaceId: t.group.id, title: '合成案件', chatId: 'group', text: run.task.prompt,
      messageId: run.msg.messageId, reporterOpenId: 'alice' }).bucket
    const q = t.questions.prepare({ bucketId: bucket.id, spaceId: t.group.id, sessionKey: run.task.sessionKey,
      originTaskId: run.task.id, targetOpenId: 'alice', anchor: { tenantId: 'tenant', appId: 'synthetic', chatId: 'group', messageId: run.msg.messageId }, kind: 'info', question: '合成补问？' })
    const input = await t.target(key), sentBefore = t.fake.sent.length
    t.registry.db.exec('BEGIN IMMEDIATE')
    const cancelled = t.host.persistHumanWorkCancel(input, { expectedRevision: 1 })
    expect(cancelled).toMatchObject({ result: 'cancelled', workKey: key, revision: 2, affectedRunIds: [run.runId], cancelledTaskIds: [] })
    expect(t.registry.workContexts.get(key)).toMatchObject({ lifecycle: 'cancelled', revision: 2, controlEpoch: 2 })
    expect(t.registry.getTask(run.task.id)).toMatchObject({ status: 'running', stopReason: 'user_requested' })
    expect(t.attempts.get(run.runId)?.state).toBe('stop_requested')
    expect(t.questions.get(q.id)?.resolution).toBe('cancelled')
    expect(t.agent.state.cancelled).toEqual([])
    t.registry.db.exec('COMMIT')
    const repeated = t.host.persistHumanWorkCancel(input)
    expect(repeated).toMatchObject({ result: 'already_cancelled', revision: 2, affectedRunIds: [], cancelledTaskIds: [] })
    expect(t.registry.workContexts.get(key)?.revision).toBe(2)
    cancelled.afterCommit(); repeated.afterCommit()
    run.release(); await run.result
    expect(t.registry.getTask(run.task.id)?.status).toBe('cancelled')
    expect(t.attempts.get(run.runId)?.state).toBe('cancelled')
    expect(t.fake.answers().join('\n')).not.toContain('SYNTHETIC_FINAL')
    expect(t.fake.sent.slice(sentBefore).map(item => JSON.stringify(item.payload)).join('\n')).not.toContain('SYNTHETIC_FINAL')
    expect(t.registry.workContexts.view(key)).toMatchObject({ lifecycle: 'cancelled', activity: 'idle', pending: { questions: 0 } })
    // A later reply to the cancelled delegation gets the ingress receipt and never becomes a new input of it.
    const late = t.message({ text: '还有一点', mentions: [], parentId: run.msg.messageId, rootId: run.msg.messageId })
    await t.host.handleMessage(late)
    expect(t.registry.taskForMessage(late.messageId)).toBeUndefined()
    expect(t.registry.workContexts.get(key)).toMatchObject({ lifecycle: 'cancelled', inputSeq: 1 })
    expect(t.fake.sent.slice(sentBefore).map(item => JSON.stringify(item.payload)).join('\n')).toContain('状态已经变化')
  })

  it('cancels the queued follow-up of a steered delegation without touching a Run that is already stopping', async () => {
    const t = fixture(), run = await t.hold(), key = t.registry.taskWork.get(run.task.id)!.key
    // A reply while the Run is busy steers it: the Run is asked to stop and the reply queues as the next input of the same delegation.
    const followup = t.host.handleMessage(t.message({ text: '再补充一点', mentions: [], parentId: run.msg.messageId, rootId: run.msg.messageId })).catch(error => ({ error }))
    t.pending.push(followup)
    await vi.waitFor(() => { if (t.registry.workContexts.get(key)?.inputSeq !== 2) throw new Error('follow-up not registered yet') })
    const queued = t.registry.workContexts.inputs(key)[1]!.taskId
    expect(t.registry.getTask(queued)?.status).toBe('queued')
    expect(t.attempts.get(run.runId)?.state).toBe('stop_requested')
    const input = await t.target(key), sentBefore = t.fake.sent.length
    const cancelled = t.host.persistHumanWorkCancel(input)
    expect(cancelled).toMatchObject({ result: 'cancelled', revision: 2, affectedRunIds: [], cancelledTaskIds: [queued] })
    expect(t.registry.getTask(queued)).toMatchObject({ status: 'cancelled', stopReason: 'user_requested' })
    expect(t.registry.getTask(run.task.id)).toMatchObject({ status: 'running', stopReason: null })
    expect(t.attempts.get(run.runId)).toMatchObject({ state: 'stop_requested', stopReason: 'steered' })
    cancelled.afterCommit()
    run.release(); await run.result; await followup
    expect(t.registry.getTask(run.task.id)).toMatchObject({ status: 'cancelled', stopReason: 'steered' })
    expect(t.attempts.get(run.runId)?.state).toBe('cancelled')
    expect(t.registry.db.prepare('SELECT task_id FROM run_attempts WHERE session_key = ? ORDER BY started_at').all(run.task.sessionKey)).toEqual([{ task_id: run.task.id }])
    expect(t.fake.sent.slice(sentBefore).map(item => JSON.stringify(item.payload)).join('\n')).not.toContain('SYNTHETIC_FINAL')
    expect(t.registry.workContexts.view(key)).toMatchObject({ lifecycle: 'cancelled', activity: 'idle',
      inputSeq: 2, handledSeq: 0, pending: { inputs: 0 } })
    expect(t.registry.workContexts.inputs(key).map(input => input.taskId)).toEqual([run.task.id, queued])
  })

  it('rolls back the whole cancellation with the caller transaction and never signals the runtime', async () => {
    const t = fixture(), run = await t.hold(), key = t.registry.taskWork.get(run.task.id)!.key
    const input = await t.target(key), before = t.registry.workContexts.get(key), taskBefore = t.registry.getTask(run.task.id), attemptBefore = t.attempts.get(run.runId)
    t.registry.db.exec('BEGIN IMMEDIATE')
    const cancelled = t.host.persistHumanWorkCancel(input)
    expect(cancelled.affectedRunIds).toEqual([run.runId])
    t.registry.db.exec('ROLLBACK')
    cancelled.afterCommit()
    expect(t.registry.workContexts.get(key)).toEqual(before)
    expect(t.registry.getTask(run.task.id)).toEqual(taskBefore)
    expect(t.attempts.get(run.runId)).toEqual(attemptBefore)
    expect(t.agent.state.cancelled).toEqual([])
    run.release(); await run.result
    expect(t.registry.getTask(run.task.id)?.status).toBe('done')
    expect(t.fake.answers().join('\n')).toContain('SYNTHETIC_FINAL')
    expect(t.registry.workContexts.view(key)).toMatchObject({ lifecycle: 'open', activity: 'idle', handledSeq: 1 })
  })

  it('authorizes from the current grant: only the delegating person in the right space, with a current revision', async () => {
    const t = fixture(), run = await t.hold(), key = t.registry.taskWork.get(run.task.id)!.key
    await expect(t.target(key, 'bob').then(input => t.host.persistHumanWorkCancel(input))).rejects.toMatchObject({ status: 403, code: 'work_actor_forbidden' })
    const alice = await t.target(key)
    expect(() => t.host.persistHumanWorkCancel({ ...alice, workKey: 'task:999' })).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => t.host.persistHumanWorkCancel({ ...alice, workKey: 'routine:1' })).toThrow(expect.objectContaining({ status: 400 }))
    expect(() => t.host.persistHumanWorkCancel(alice, { expectedRevision: 7 })).toThrow(expect.objectContaining({ status: 409 }))
    expect(() => t.host.assertHumanWorkTarget(alice)).not.toThrow()
    expect(t.registry.workContexts.get(key)).toMatchObject({ lifecycle: 'open', revision: 1 })
    expect(t.attempts.get(run.runId)?.state).toBe('running')
    run.release(); await run.result
    expect(t.registry.getTask(run.task.id)?.status).toBe('done')
  })

  it('exposes the cancellation as the idempotent console command work.cancel with the revision as its version', async () => {
    const t = fixture(), run = await t.hold(), key = t.registry.taskWork.get(run.task.id)!.key
    const alice = t.login('alice'), sentBefore = t.fake.sent.length
    const command = { operation: 'work.cancel', requestId: 'work_cancel_request_0001', workKey: key, expectedRevision: 1 }
    await expect(t.commands.execute(t.login('bob'), t.group.id, command)).rejects.toMatchObject({ status: 403, code: 'work_actor_forbidden' })
    await expect(t.commands.execute(alice, t.group.id, { ...command, expectedRevision: 7 })).rejects.toMatchObject({ status: 409 })
    await expect(t.commands.execute(alice, t.group.id, { ...command, workKey: 'task:999' })).rejects.toMatchObject({ status: 404 })
    expect(t.registry.workContexts.get(key)).toMatchObject({ lifecycle: 'open', revision: 1 })
    expect(t.attempts.get(run.runId)?.state).toBe('running')
    const first = await t.commands.execute(alice, t.group.id, command)
    expect(first.body).toMatchObject({ replayed: false, appliedResult: { changed: true, state: 'cancelled', version: 2, affectedRunIds: [run.runId] } })
    expect(t.registry.workContexts.get(key)).toMatchObject({ lifecycle: 'cancelled', revision: 2 })
    run.release(); await run.result
    expect(t.registry.getTask(run.task.id)).toMatchObject({ status: 'cancelled', stopReason: 'user_requested' })
    expect(t.attempts.get(run.runId)?.state).toBe('cancelled')
    expect(t.fake.sent.slice(sentBefore).map(item => JSON.stringify(item.payload)).join('\n')).not.toContain('SYNTHETIC_FINAL')
    // The same request replays its stored receipt; a new request against the cancelled work is an idempotent no-op fact.
    expect((await t.commands.execute(alice, t.group.id, command)).body).toEqual({ ...first.body, replayed: true })
    const again = await t.commands.execute(alice, t.group.id, { ...command, requestId: 'work_cancel_request_0002', expectedRevision: 2 })
    expect(again.body).toMatchObject({ replayed: false, appliedResult: { changed: false, state: 'already_cancelled', version: 2, affectedRunIds: [] } })
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM console_operations').get()).toEqual({ n: 2 })
  })

  it('shows the delegation facts with the cancel affordance only to its authority while it is open', async () => {
    const t = fixture(), run = await t.hold(), key = t.registry.taskWork.get(run.task.id)!.key
    const [mine] = (await t.executions()).items, [theirs] = (await t.executions('bob')).items
    expect(mine!.work).toEqual({ key, lifecycle: 'open', activity: 'running', revision: 1, canCancel: true, pauseReasons: [], pauses: [], pendingInputs: 1, openQuestions: 0, unknownDeliveries: 0 })
    expect(mine!.runs.map(r => r.canStop)).toEqual([true])
    expect(theirs!.work).toMatchObject({ key, lifecycle: 'open', canCancel: false })
    const cancelled = t.host.persistHumanWorkCancel(await t.target(key), { expectedRevision: 1 }); cancelled.afterCommit()
    expect((await t.executions()).items[0]!.work).toMatchObject({ lifecycle: 'cancelled', activity: 'stopping', revision: 2, canCancel: false })
    run.release(); await run.result
    expect((await t.executions()).items[0]!.work).toMatchObject({ lifecycle: 'cancelled', activity: 'idle', canCancel: false })
  })

  it('pauses the delegation when its Run is stopped: queued follow-ups wait instead of starting, and resume from the console', async () => {
    const t = fixture(), run = await t.hold(), key = t.registry.taskWork.get(run.task.id)!.key
    const followup = await t.steer(run)
    await t.host.handleMessage(t.message({ text: '停止', mentions: [], parentId: run.msg.messageId, rootId: run.msg.messageId }))
    expect(t.registry.getTask(run.task.id)).toMatchObject({ status: 'running', stopReason: 'user_requested' })
    expect(t.registry.workContexts.get(key)).toMatchObject({ lifecycle: 'open', pauseReasons: [{ reason: 'run_stop', causeRef: `run:${run.runId}` }] })
    run.release(); await run.result; await followup.result
    // The follow-up reached the queue head while the work was paused: it stays a durable pending input, not a cancelled Task.
    expect(t.registry.getTask(followup.taskId)).toMatchObject({ status: 'queued', stopReason: null })
    expect(t.registry.dispatches.pending().map(d => d.taskId)).toEqual([followup.taskId])
    expect(t.registry.workContexts.view(key)).toMatchObject({ activity: 'paused', inputSeq: 2, handledSeq: 0, pending: { inputs: 1 } })
    expect(t.registry.workContexts.inputs(key).map(input => input.taskId)).toEqual([run.task.id, followup.taskId])
    expect(t.agent.state.allPrompts).toHaveLength(1)
    const [item] = (await t.executions()).items.filter(i => i.id === run.task.id)
    expect(item!.work).toMatchObject({ activity: 'paused', canCancel: true, pauses: [{ reason: 'run_stop', causeRef: `run:${run.runId}`, canResume: true }] })
    // Progress asked in chat names the pause instead of pretending the follow-up is running or lost.
    const sentBefore = t.fake.sent.length
    await t.host.handleMessage(t.message({ text: '进展如何', mentions: [], parentId: followup.msg.messageId, rootId: run.msg.messageId }))
    expect(t.fake.sent.slice(sentBefore).map(item => JSON.stringify(item.payload)).join('\n')).toMatch(/暂停/)
    t.agent.state.script = [{ kind: 'text', text: 'RESUMED_FINAL' }]
    const alice = t.login('alice'), revision = t.registry.workContexts.get(key)!.revision
    const resumed = await t.commands.execute(alice, t.group.id, { operation: 'work.resume', requestId: 'work_resume_request_0001', workKey: key,
      reason: 'run_stop', causeRef: `run:${run.runId}`, expectedRevision: revision })
    expect(resumed.body).toMatchObject({ replayed: false, appliedResult: { changed: true, state: 'resumed', version: revision + 1 } })
    await vi.waitFor(() => { if (t.registry.getTask(followup.taskId)?.status !== 'done') throw new Error('follow-up not finished yet') }, { timeout: 5000 })
    expect(t.fake.answers().join('\n')).toContain('RESUMED_FINAL')
    expect(t.registry.workContexts.view(key)).toMatchObject({ lifecycle: 'open', activity: 'idle', pauseReasons: [], handledSeq: 2, pending: { inputs: 0 } })
    expect(t.agent.state.allPrompts).toHaveLength(2)
    // Resuming a pause that no longer exists is an idempotent fact, not an error and not another epoch bump.
    const again = await t.commands.execute(alice, t.group.id, { operation: 'work.resume', requestId: 'work_resume_request_0002', workKey: key,
      reason: 'run_stop', causeRef: `run:${run.runId}`, expectedRevision: revision + 1 })
    expect(again.body).toMatchObject({ appliedResult: { changed: false, state: 'already_resumed', version: revision + 1 } })
  })

  it('lets the next real instruction from the delegating person lift a stop pause and continue in order', async () => {
    const t = fixture(), run = await t.hold(), key = t.registry.taskWork.get(run.task.id)!.key
    const followup = await t.steer(run)
    await t.host.handleMessage(t.message({ text: '停止', mentions: [], parentId: run.msg.messageId, rootId: run.msg.messageId }))
    run.release(); await run.result; await followup.result
    expect(t.registry.getTask(followup.taskId)?.status).toBe('queued')
    t.agent.state.script = [{ kind: 'text', text: 'CONTINUED_FINAL' }]
    // A correction to the parked follow-up replaces it (existing amend-on-queued semantics) and is itself the resume.
    await t.host.handleMessage(t.message({ text: '改成检查另一项', mentions: [], parentId: followup.msg.messageId, rootId: run.msg.messageId }))
    const inputs = t.registry.workContexts.inputs(key)
    expect(inputs).toHaveLength(3)
    expect(t.registry.getTask(followup.taskId)).toMatchObject({ status: 'cancelled', stopReason: 'steered' })
    expect(t.registry.getTask(inputs[2]!.taskId)?.status).toBe('done')
    expect(t.registry.workContexts.view(key)).toMatchObject({ pauseReasons: [], activity: 'idle', handledSeq: 3 })
    expect(t.fake.answers().join('\n')).toContain('CONTINUED_FINAL')
    expect(t.agent.state.allPrompts).toHaveLength(2)
  })

  it('keeps a parked input across a restart: recovery parks it again and a later resume runs it exactly once', async () => {
    const t = fixture(), run = await t.hold(), key = t.registry.taskWork.get(run.task.id)!.key
    const followup = await t.steer(run)
    await t.host.handleMessage(t.message({ text: '停止', mentions: [], parentId: run.msg.messageId, rootId: run.msg.messageId }))
    run.release(); await run.result; await followup.result
    expect(t.registry.getTask(followup.taskId)?.status).toBe('queued')
    const second = restarted(t)
    await second.host.recoverHandoffs()
    expect(t.registry.getTask(followup.taskId)?.status).toBe('queued')
    expect(second.agent.state.allPrompts).toHaveLength(0)
    const input = await t.target(key)
    const resumed = second.host.persistHumanWorkResume(input, { reason: 'run_stop', causeRef: `run:${run.runId}`, expectedRevision: t.registry.workContexts.get(key)!.revision })
    expect(resumed.result).toBe('resumed'); resumed.afterCommit()
    await vi.waitFor(() => { if (t.registry.getTask(followup.taskId)?.status !== 'done') throw new Error('follow-up not finished yet') }, { timeout: 5000 })
    expect(second.agent.state.allPrompts).toHaveLength(1)
    expect(t.agent.state.allPrompts).toHaveLength(1)
    expect(t.fake.answers().join('\n')).toContain('RESTARTED_FINAL')
    expect(t.registry.workContexts.view(key)).toMatchObject({ activity: 'idle', handledSeq: 2 })
  })

  it('refuses to dispatch a Run admitted before a pause; the input ends with a notice because a started Task is never replayed', async () => {
    const t = fixture(), entered = deferred(), release = deferred()
    t.agent.state.onNewSession = async () => { entered.resolve(); await release.promise }
    t.agent.state.script = [{ kind: 'text', text: 'MUST_NOT_RUN' }]
    const msg = t.message(), result = t.host.handleMessage(msg).catch(error => ({ error })); t.pending.push(result)
    await entered.promise
    const task = t.registry.taskForMessage(msg.messageId)!, key = t.registry.taskWork.get(task.id)!.key
    expect(task.status).toBe('running')
    t.registry.workContexts.control(key, { action: 'pause', reason: 'manual', causeRef: 'console:alice' })
    const sentBefore = t.fake.sent.length
    release.resolve(); await result
    expect(t.agent.state.allPrompts).toHaveLength(0)
    expect(t.registry.getTask(task.id)).toMatchObject({ status: 'cancelled', stopReason: 'work_paused' })
    expect(t.registry.db.prepare('SELECT state, stop_reason FROM run_attempts WHERE task_id = ?').all(task.id)).toEqual([{ state: 'cancelled', stop_reason: 'work_paused' }])
    expect(t.registry.workContexts.view(key)).toMatchObject({ activity: 'paused', inputSeq: 1, handledSeq: 0, pending: { inputs: 0 } })
    expect(t.registry.workContexts.inputs(key).map(input => input.taskId)).toEqual([task.id])
    const sent = t.fake.sent.slice(sentBefore).map(item => JSON.stringify(item.payload)).join('\n')
    expect(sent).toContain('准备期间被暂停'); expect(sent).not.toContain('MUST_NOT_RUN')
    // Resuming does not resurrect the ended input; the next instruction from the person is the continuation.
    const resumed = t.host.persistHumanWorkResume(await t.target(key), { reason: 'manual', causeRef: 'console:alice', expectedRevision: t.registry.workContexts.get(key)!.revision })
    resumed.afterCommit()
    expect(t.registry.workContexts.view(key)).toMatchObject({ lifecycle: 'open', activity: 'idle', pauseReasons: [],
      inputSeq: 1, handledSeq: 0, pending: { inputs: 0 } })
    expect(t.registry.getTask(task.id)?.status).toBe('cancelled')
  })
})
