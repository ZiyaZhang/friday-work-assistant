import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { ConsoleSessionStore } from '../src/core/console-sessions.js'
import { HumanSpaceAccess } from '../src/core/human-space-access.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator, type HumanRunTarget } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { RunAttempts } from '../src/core/run-attempts.js'
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
  const home = mkdtempSync(join(tmpdir(), 'friday-human-run-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), sp = spaceDeps(registry.db, { admins: ['alice'] })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'group', openId: 'alice' })
  sp.spaces.addMember(group.id, 'bob', 'member')
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  fake.members.set('group', new Set(['alice', 'bob']))
  const bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs), routines = new RoutineStore(registry.db)
  const browser = new ConsoleSessionStore(registry.db)
  const actor = browser.create({ appId: 'synthetic', tenantKey: 'tenant', openId: 'alice', name: 'Alice' }).actor
  const access = new HumanSpaceAccess({ ...sp, feishu, assertActor: current => {
    if (!browser.isCurrent(current)) throw new Error('console session no longer current')
  } })
  const log = createLogger('human-run-control', 'error'), agent = createFakeAgent()
  let host!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: agent.app }, log,
    onPermission: (request, signal) => host.handlePermission(request, signal) })
  host = new Orchestrator({ cfg, registry, ...sp, memory: new ChannelMemory(registry.db), questions, routines,
    feishu, runtime, tokens: new TokenIssuer('synthetic'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log })
  const attempts = new RunAttempts(registry.db), pending: Promise<unknown>[] = [], releases: (() => void)[] = []
  let serial = 0
  const message = (over: Partial<InboundMessage> = {}): InboundMessage => {
    const id = `human-run-${++serial}`
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
  const target = async (run: Awaited<ReturnType<typeof hold>>): Promise<HumanRunTarget> => {
    const grant = await access.authorize(actor, group.id, { operation: 'read' })
    return { actorOpenId: actor.openId, spaceId: group.id, runId: run.runId, taskId: run.task.id, assertCurrent: grant.assertCurrent }
  }
  cleanups.push(async () => {
    releases.forEach(release => release()); await Promise.all(pending); await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true })
  })
  return { registry, ...sp, group, fake, feishu, bugs, questions, routines, browser, actor, access, agent, runtime, host, attempts, hold, target, pending, releases }
}

describe('human stops an exact task Run', () => {
  it('persists the Task, Run and question stop together, signals only after commit, and suppresses late output', async () => {
    const t = fixture(), run = await t.hold(), input = await t.target(run)
    const bucket = t.bugs.record({ spaceId: t.group.id, title: '合成案件', chatId: 'group', text: run.task.prompt,
      messageId: run.msg.messageId, reporterOpenId: 'alice' }).bucket
    const q = t.questions.prepare({ bucketId: bucket.id, spaceId: t.group.id, sessionKey: run.task.sessionKey,
      originTaskId: run.task.id, targetOpenId: 'alice', anchor: { tenantId: 'tenant', appId: 'synthetic', chatId: 'group', messageId: run.msg.messageId }, kind: 'info', question: '合成补问？' })
    const bucketBefore = t.bugs.get(bucket.id), sentBefore = t.fake.sent.length
    t.registry.db.exec('BEGIN IMMEDIATE')
    const stopped = t.host.persistHumanRunStop(input)
    expect(stopped.result).toBe('stop_requested')
    expect(t.attempts.get(run.runId)?.state).toBe('stop_requested')
    expect(t.registry.getTask(run.task.id)).toMatchObject({ status: 'running', stopReason: 'user_requested' })
    expect(t.questions.get(q.id)?.resolution).toBe('cancelled')
    expect(t.agent.state.cancelled).toEqual([])
    expect(t.fake.sent).toHaveLength(sentBefore)
    t.registry.db.exec('COMMIT')
    const repeated = t.host.persistHumanRunStop(input)
    expect(repeated.result).toBe('already_stopping')
    stopped.afterCommit(); repeated.afterCommit()
    run.release(); await run.result
    expect(t.registry.getTask(run.task.id)?.status).toBe('cancelled')
    expect(t.attempts.get(run.runId)?.state).toBe('cancelled')
    expect(t.fake.answers().join('\n')).not.toContain('SYNTHETIC_FINAL')
    expect(t.bugs.get(bucket.id)).toEqual(bucketBefore) // stopping this execution is not stopping future case followup
    expect(t.host.persistHumanRunStop(input).result).toBe('already_finished')
  })

  it('allows the caller receipt transaction to roll back all stop state without signalling the runtime', async () => {
    const t = fixture(), run = await t.hold(), input = await t.target(run)
    const before = t.registry.getTask(run.task.id), attemptBefore = t.attempts.get(run.runId)
    t.registry.db.exec('BEGIN IMMEDIATE')
    const stopped = t.host.persistHumanRunStop(input)
    t.registry.db.exec('ROLLBACK')
    stopped.afterCommit() // a stale closure cannot convert a rolled-back stop into an actual cancellation
    expect(t.registry.getTask(run.task.id)).toEqual(before)
    expect(t.attempts.get(run.runId)).toEqual(attemptBefore)
    expect(t.agent.state.cancelled).toEqual([])
    run.release(); await run.result
    expect(t.registry.getTask(run.task.id)?.status).toBe('done')
    expect(t.fake.answers().join('\n')).toContain('SYNTHETIC_FINAL')
  })

  it('keeps an old afterCommit closure and a finished target from stopping the next Run in that Session', async () => {
    const t = fixture(), a = await t.hold(), input = await t.target(a)
    const stopped = t.host.persistHumanRunStop(input)
    // Persistent stop already blocks A output, even if runtime signalling was delayed.
    a.release(); await a.result
    expect(t.registry.getTask(a.task.id)).toMatchObject({ status: 'cancelled', stopReason: 'user_requested', error: null })
    expect(t.attempts.get(a.runId)?.state).toBe('cancelled')
    expect(t.fake.answers().join('\n')).not.toContain('处理失败')
    // The late A update observes its committed stop and cancels A promptly;
    // the invariant is that the old closure never sends a new cancel to B.
    expect(t.agent.state.cancelled).toEqual([a.session.acpSessionId])
    const cancelledBeforeB = [...t.agent.state.cancelled]
    const b = await t.hold({ parentId: a.msg.messageId, rootId: a.msg.messageId })
    expect(b.task.sessionKey).toBe(a.task.sessionKey)
    expect(b.runId).not.toBe(a.runId)
    stopped.afterCommit()
    expect(t.host.persistHumanRunStop(input).result).toBe('already_finished')
    expect(t.registry.getTask(b.task.id)?.stopReason).toBeNull()
    expect(t.attempts.get(b.runId)?.state).toBe('running')
    expect(t.agent.state.cancelled).toEqual(cancelledBeforeB)
    b.release(); await b.result
    expect(t.registry.getTask(b.task.id)?.status).toBe('done')
    expect(t.agent.state.cancelled).toEqual(cancelledBeforeB)
  })

  it('does not substitute a new Run when A finishes during fresh membership authorization', async () => {
    const t = fixture(), a = await t.hold(), entered = deferred(), release = deferred()
    const read = vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementation(async () => { entered.resolve(); await release.promise; return new Set(['alice', 'bob']) })
    const authorizing = t.target(a)
    await entered.promise
    a.release(); await a.result
    read.mockRestore()
    const b = await t.hold({ parentId: a.msg.messageId, rootId: a.msg.messageId })
    release.resolve()
    const input = await authorizing
    expect(t.host.persistHumanRunStop(input).result).toBe('already_finished')
    expect(t.attempts.get(b.runId)?.state).toBe('running')
    expect(t.agent.state.cancelled).toEqual([])
    b.release(); await b.result
    expect(t.registry.getTask(b.task.id)?.status).toBe('done')
  })

  it('keeps a committed human stop pending when Space access is lost before its late update', async () => {
    const t = fixture(), run = await t.hold(), input = await t.target(run)
    const stopped = t.host.persistHumanRunStop(input)
    t.spaces.archive(t.group.id)
    run.release(); await run.result
    stopped.afterCommit()
    expect(t.registry.getTask(run.task.id)).toMatchObject({ status: 'cancelled', stopReason: 'user_requested' })
    expect(t.attempts.get(run.runId)).toMatchObject({ state: 'cancelled', stopReason: 'user_requested' })
    const key = t.registry.taskWork.get(run.task.id)!.key
    expect(t.registry.workContexts.view(key)).toMatchObject({ activity: 'paused', handledSeq: 0,
      pauseReasons: [{ reason: 'run_stop', causeRef: `run:${run.runId}` }] })
    expect(t.agent.state.cancelled).toEqual([run.session.acpSessionId])
    expect(t.fake.answers().join('\n')).not.toContain('SYNTHETIC_FINAL')
  })

  it('revalidates login and Space binding and refuses another member even when the caller is an admin', async () => {
    const t = fixture(), run = await t.hold(), input = await t.target(run)
    expect(() => t.host.persistHumanRunStop({ ...input, taskId: run.task.id + 1 })).toThrowError(expect.objectContaining({ status: 404 }))
    expect(() => t.host.persistHumanRunStop({ ...input, actorOpenId: 'bob' })).toThrowError(expect.objectContaining({ status: 403 }))
    t.spaces.rebind(t.group.id, 'new-chat')
    expect(() => t.host.persistHumanRunStop(input)).toThrow()
    t.spaces.rebind(t.group.id, 'group')
    const fresh = await t.target(run)
    t.browser.revoke(t.actor.sessionId)
    expect(() => t.host.persistHumanRunStop(fresh)).toThrow('console session no longer current')
    expect(t.attempts.get(run.runId)?.state).toBe('running')
    expect(t.registry.getTask(run.task.id)?.stopReason).toBeNull()
  })

  it('validates finished targets for receipt replay without rewriting facts or cancelling another person’s Run', async () => {
    const t = fixture(), a = await t.hold(), input = await t.target(a)
    a.release(); await a.result
    const before = t.attempts.get(a.runId)
    const b = await t.hold({ senderOpenId: 'bob', parentId: a.msg.messageId, rootId: a.msg.messageId })
    const changes = t.registry.db.prepare('SELECT total_changes() AS n').get()!.n
    t.host.assertHumanRunTarget(input)
    expect(t.registry.db.prepare('SELECT total_changes() AS n').get()!.n).toBe(changes)
    expect(t.attempts.get(a.runId)).toEqual(before)
    expect(() => t.host.persistHumanRunStop({ ...input, runId: b.runId, taskId: b.task.id })).toThrowError(expect.objectContaining({ status: 403 }))
    expect(t.attempts.get(b.runId)?.state).toBe('running')
    b.release(); await b.result
  })

  it('allows authorized historical receipt reads in an archived Space and Session but rejects a new stop mutation', async () => {
    const t = fixture(), run = await t.hold()
    run.release(); await run.result
    t.spaces.archive(t.group.id)
    t.registry.updateSession(run.task.sessionKey, { status: 'archived' })
    const grant = await t.access.authorize(t.actor, t.group.id, { operation: 'read', allowArchived: true })
    const input: HumanRunTarget = { actorOpenId: 'alice', spaceId: t.group.id, runId: run.runId,
      taskId: run.task.id, assertCurrent: grant.assertCurrent }
    const before = t.attempts.get(run.runId), changes = t.registry.db.prepare('SELECT total_changes() AS n').get()!.n
    expect(() => t.host.assertHumanRunTarget(input)).not.toThrow()
    expect(() => t.host.persistHumanRunStop(input)).toThrowError(expect.objectContaining({ status: 403 }))
    expect(t.attempts.get(run.runId)).toEqual(before)
    expect(t.registry.db.prepare('SELECT total_changes() AS n').get()!.n).toBe(changes)
  })

  it('stops only a followup occurrence while leaving its responsibility and next schedule intact', async () => {
    const t = fixture(), initial = await t.hold(); initial.release(); await initial.result
    const routine = t.routines.add({ kind: 'followup', ownerOpenId: 'alice', runAs: 'alice', spaceId: t.group.id,
      chatId: 'group', chatType: 'group', sessionKey: initial.task.sessionKey, name: '合成跟进', prompt: '继续检查',
      schedule: { type: 'interval', everyMinutes: 10 }, now: Date.now() - 600_001 })
    const occurrence = t.routines.claimDueOccurrence(routine.id, routine.nextRunAt, Date.now())!
    const current = t.routines.startOccurrence(occurrence.id, Date.now())!
    const entered = deferred(), release = deferred(); t.releases.push(release.resolve)
    t.agent.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } }, { kind: 'text', text: 'FOLLOWUP_LATE_RESULT' }]
    const result = t.host.runRoutine(current, { occurrence }).catch(error => ({ error })); t.pending.push(result)
    await entered.promise
    const identity = t.host.resolveActorForSession(initial.task.sessionKey)!
    const grant = await t.access.authorize(t.actor, t.group.id, { operation: 'read' })
    const routineBefore = t.routines.get(routine.id)
    const stopped = t.host.persistHumanRunStop({ actorOpenId: 'alice', spaceId: t.group.id, runId: identity.runId,
      taskId: identity.taskId, assertCurrent: grant.assertCurrent })
    expect(t.routines.getOccurrence(occurrence.id)?.status).toBe('cancelled')
    expect(t.routines.get(routine.id)).toEqual(routineBefore)
    stopped.afterCommit(); release.resolve(); await result
    expect(t.routines.get(routine.id)).toEqual(routineBefore)
    expect(t.fake.answers().join('\n')).not.toContain('FOLLOWUP_LATE_RESULT')
  })
})
