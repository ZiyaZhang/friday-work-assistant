import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry, type TaskRow } from '../src/core/registry.js'
import { RunAttempts, parseRunResult, type RunResult } from '../src/core/run-attempts.js'
import { Bugs } from '../src/core/bugs.js'
import { RoutineStore } from '../src/core/routines.js'
import { DeliveryService } from '../src/core/delivery.js'
import { IssueLinks } from '../src/github/issues.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { spaceDeps } from './helpers/space.js'

const NOW = 1_800_000_000_000
const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-run-attempts-')), path = join(dir, 'registry.db')
  let registry = new Registry(path), runs = new RunAttempts(registry.db)
  cleanups.push(() => { registry.close(); rmSync(dir, { recursive: true, force: true }) })
  const accept = (messageId: string, sessionKey = 'session-a', amendsTaskId?: number) => {
    if (!registry.getSession(sessionKey)) registry.createSession({ sessionKey, chatId: 'chat-a', chatType: 'group', cwd: dir, requesterOpenId: 'alice' })
    const inbound: InboundMessage = { eventId: `event:${messageId}`, messageId, chatId: 'chat-a', chatType: 'group',
      senderOpenId: 'alice', senderType: 'user', msgType: 'text', text: `合成任务 ${messageId}`, mentions: [], createTimeMs: NOW }
    return registry.createTaskOnce({ sessionKey, messageId, requesterOpenId: 'alice', prompt: inbound.text, inbound, amendsTaskId }).task
  }
  const input = (task: TaskRow, triggerKey = `task:${task.id}`) => ({ workKey: registry.taskWork.get(task.id)!.key,
    sessionKey: task.sessionKey, triggerKey, stage: 'task' as const, taskId: task.id, actorOpenId: task.requesterOpenId!, now: NOW })
  const begin = (task: TaskRow) => runs.begin(input(task), () => registry.startTask(task.id, NOW, task.sessionKey))!
  const allRuns = () => registry.db.prepare('SELECT * FROM run_attempts ORDER BY started_at,id').all()
  return { get registry() { return registry }, get runs() { return runs }, accept, input, begin, allRuns,
    reopen() { registry.close(); registry = new Registry(path); runs = new RunAttempts(registry.db) } }
}

function expectUnclaimed(t: ReturnType<typeof setup>, task: TaskRow) {
  expect(t.registry.getTask(task.id)).toMatchObject({ status: 'queued', startedAt: null })
  expect(t.registry.dispatches.pending().map(item => item.taskId)).toContain(task.id)
}

describe('persistent Run attempts', () => {
  it('adds nullable result evidence to an old schema without rewriting any terminal record', () => {
    const t = setup(), run = t.begin(t.accept('legacy'))
    t.runs.finish(run.id, 'completed', NOW + 1, 'end_turn')
    t.registry.db.exec('ALTER TABLE run_attempts DROP COLUMN result_json')
    const before = t.registry.db.prepare('SELECT * FROM run_attempts').all()
    new RunAttempts(t.registry.db)
    new RunAttempts(t.registry.db)
    const after = t.registry.db.prepare('SELECT * FROM run_attempts').all().map(({ result_json, ...row }) => {
      expect(result_json).toBeNull()
      return row
    })
    expect(after).toEqual(before)
    expect(t.runs.get(run.id)?.result).toBeNull()
  })

  it('persists original truncation and partial outcome even when a summary turn ended normally', () => {
    const t = setup(), run = t.begin(t.accept('limited'))
    const result: RunResult = { version: 1, termination: 'max_tokens', outcome: 'partial', reason: 'model_limit' }
    t.runs.finish(run.id, 'completed', NOW + 1, 'max_tokens', result)
    t.reopen()
    expect(t.runs.get(run.id)).toMatchObject({ state: 'completed', stopReason: 'max_tokens', result })
    const before = t.allRuns()
    t.runs.finish(run.id, 'completed', NOW + 2, 'end_turn', { version: 1, termination: 'end_turn', outcome: 'handled', reason: 'normal_end' })
    expect(t.allRuns()).toEqual(before)
  })

  it('keeps the original model termination but a committed stop wins over its late handled result', () => {
    const t = setup(), run = t.begin(t.accept('late-answer'))
    t.runs.requestStop(run.id, 'user_requested')
    t.runs.finish(run.id, 'completed', NOW + 1, 'end_turn', { version: 1, termination: 'end_turn', outcome: 'handled', reason: 'normal_end' })
    expect(t.runs.get(run.id)).toMatchObject({ state: 'cancelled', stopReason: 'user_requested',
      result: { version: 1, termination: 'end_turn', outcome: 'cancelled', reason: 'user_requested' } })
  })

  it('persists host interruption once, preserves user-stop precedence and terminal history', () => {
    const t = setup(), completed = t.begin(t.accept('completed'))
    t.runs.finish(completed.id, 'completed', NOW, 'end_turn', { version: 1, termination: 'end_turn', outcome: 'handled', reason: 'normal_end' })
    const original = t.runs.get(completed.id)
    const running = t.begin(t.accept('running')), stopped = t.begin(t.accept('stopped', 'other-session'))
    t.runs.requestStop(stopped.id, 'user_requested')
    expect(t.runs.interruptActive(NOW + 1)).toBe(2)
    expect(t.runs.get(running.id)).toMatchObject({ state: 'interrupted', stopReason: 'gateway_shutdown',
      result: { version: 1, termination: 'gateway_shutdown', outcome: 'interrupted', reason: 'interrupted' } })
    expect(t.runs.get(stopped.id)).toMatchObject({ state: 'cancelled', stopReason: 'user_requested',
      result: { version: 1, termination: 'gateway_shutdown', outcome: 'cancelled', reason: 'user_requested' } })
    t.runs.finish(running.id, 'failed', NOW + 2, 'runtime_error')
    expect(t.runs.interruptActive(NOW + 2)).toBe(0)
    t.reopen(); expect(t.runs.recoverInterrupted(NOW + 3)).toBe(0)
    expect(t.runs.get(completed.id)).toEqual(original)
    expect(t.runs.get(running.id)?.state).toBe('interrupted')
  })

  it('records fresh restart evidence once and never backfills old terminal results', () => {
    const t = setup(), old = t.begin(t.accept('old-terminal'))
    t.runs.finish(old.id, 'completed', NOW, 'end_turn')
    const current = t.begin(t.accept('current')), stopped = t.begin(t.accept('stopped', 'session-b'))
    t.runs.requestStop(stopped.id, 'user_requested')
    t.runs.recoverInterrupted(NOW + 1)
    expect(t.runs.get(old.id)?.result).toBeNull()
    expect(t.runs.get(current.id)?.result).toEqual({ version: 1, termination: 'gateway_restarted', outcome: 'interrupted', reason: 'interrupted' })
    expect(t.runs.get(stopped.id)?.result).toEqual({ version: 1, termination: 'gateway_restarted', outcome: 'cancelled', reason: 'user_requested' })
    const before = t.allRuns()
    t.runs.recoverInterrupted(NOW + 2)
    expect(t.allRuns()).toEqual(before)
  })

  it.each([
    { version: 1, termination: 'max_tokens', outcome: 'handled', reason: 'normal_end' },
    { version: 1, termination: 'end_turn', outcome: 'handled', reason: 'step_budget' },
    { version: 1, termination: 'end_turn', outcome: 'failed', reason: 'runtime_error' },
    { version: 1, termination: 'error with sensitive details', outcome: 'partial', reason: 'runtime_error' },
  ])('rejects an inconsistent or non-code result without changing the running attempt: %j', result => {
    const t = setup(), run = t.begin(t.accept('invalid'))
    expect(() => t.runs.finish(run.id, 'completed', NOW + 1, undefined, result as RunResult)).toThrow('Invalid Run result')
    expect(t.runs.get(run.id)).toMatchObject({ state: 'running', result: null, finishedAt: null })
  })

  it.each([null, '{', '{}', '{"version":2}', JSON.stringify({ version: 1, termination: 'end_turn', outcome: 'handled', reason: 'normal_end', complete: true })])
    ('does not turn unknown persisted result formats into success: %j', value => {
      expect(parseRunResult(value)).toBeNull()
    })

  it('does not invent attempts for old tasks or mutate state merely by constructing twice', () => {
    const t = setup(), old = t.accept('old'), pending = t.accept('pending')
    t.registry.startTask(old.id, NOW, old.sessionKey)
    t.reopen()
    expect(t.allRuns()).toEqual([])
    expect(t.registry.getTask(old.id)?.status).toBe('running')
    expectUnclaimed(t, pending)
    new RunAttempts(t.registry.db)
    expect(t.allRuns()).toEqual([])
  })

  it('commits the exact Task and dispatch claim with the attempt before runtime binding', () => {
    const t = setup(), task = t.accept('first'), run = t.begin(task)
    expect(run).toMatchObject({ workKey: `task:${task.id}`, taskId: task.id, triggerKey: `task:${task.id}`,
      sessionKey: task.sessionKey, actorOpenId: 'alice', stage: 'task', state: 'running', acpSessionId: null, startedAt: NOW, finishedAt: null })
    expect(t.registry.getTask(task.id)).toMatchObject({ status: 'running', startedAt: NOW })
    expect(t.registry.dispatches.pending()).toEqual([])
    expect(t.runs.bindRuntime(run.id, 'acp-original')).toBe(true)
    const before = t.runs.get(run.id)
    t.reopen()
    expect(t.runs.get(run.id)).toEqual(before) // Constructor is not startup recovery.
    expect(t.runs.begin(t.input(task), () => t.registry.startTask(task.id, NOW + 1, task.sessionKey))).toBeUndefined()
    expect(t.allRuns()).toHaveLength(1)
  })

  it('rolls back admission writes when a later admission condition returns false', () => {
    const t = setup(), task = t.accept('denied')
    expect(t.runs.begin(t.input(task), () => {
      expect(t.registry.startTask(task.id, NOW, task.sessionKey)).toBe(true)
      return false
    })).toBeUndefined()
    expectUnclaimed(t, task)
    expect(t.allRuns()).toEqual([])
  })

  it('rolls back a thrown admission and a failing attempt insert, then permits a fresh claim', () => {
    const t = setup(), task = t.accept('retry')
    expect(() => t.runs.begin(t.input(task), () => {
      t.registry.startTask(task.id, NOW, task.sessionKey)
      throw new Error('last admission check failed')
    })).toThrow('last admission check failed')
    expectUnclaimed(t, task)
    t.registry.db.exec("CREATE TRIGGER reject_run BEFORE INSERT ON run_attempts BEGIN SELECT RAISE(ABORT, 'disk fault'); END")
    expect(() => t.begin(task)).toThrow('disk fault')
    expectUnclaimed(t, task)
    expect(t.allRuns()).toEqual([])
    t.registry.db.exec('DROP TRIGGER reject_run')
    expect(t.begin(task).state).toBe('running')
  })

  it.each(['running', 'stop_requested'] as const)('does not admit a second Task while the same Session has a %s attempt', state => {
    const t = setup(), first = t.accept('first'), run = t.begin(first), next = t.accept('next')
    if (state === 'stop_requested') t.runs.requestStop(run.id, 'user_requested')
    expect(() => t.begin(next)).toThrow(/UNIQUE/)
    expectUnclaimed(t, next)
    expect(t.runs.get(run.id)?.state).toBe(state)
    expect(t.allRuns()).toHaveLength(1)
    t.runs.finish(run.id, 'completed', NOW + 1)
    expect(t.begin(next).state).toBe('running')
  })

  it('rolls back admission on duplicate trigger even when its old attempt is terminal and the Session differs', () => {
    const t = setup(), first = t.accept('first'), run = t.begin(first)
    t.runs.finish(run.id, 'failed', NOW + 1, 'network unknown')
    const next = t.accept('different-message', 'session-b')
    expect(() => t.runs.begin(t.input(next, run.triggerKey), () => t.registry.startTask(next.id, NOW + 2, next.sessionKey))).toThrow(/UNIQUE/)
    expectUnclaimed(t, next)
    expect(t.allRuns()).toHaveLength(1)
    expect(t.runs.get(run.id)).toMatchObject({ state: 'failed', stopReason: 'network unknown' })
  })

  it('does not commit its parent application transaction', () => {
    const t = setup(), task = t.accept('outer')
    t.registry.db.exec('BEGIN')
    const run = t.begin(task)
    t.registry.db.exec('ROLLBACK')
    expect(t.runs.get(run.id)).toBeUndefined()
    expectUnclaimed(t, task)
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('records a durable stop as cancelled despite late %s', late => {
    const t = setup(), run = t.begin(t.accept('stop'))
    expect(t.runs.requestStop(run.id, 'user_requested')).toBe(true)
    expect(t.runs.isCurrent(run.id)).toBe(false)
    expect(t.runs.requestStop(run.id, 'replace_reason')).toBe(false)
    t.runs.finish(run.id, late, NOW + 20, 'late result')
    expect(t.runs.get(run.id)).toMatchObject({ state: 'cancelled', stopReason: 'user_requested', finishedAt: NOW + 20 })
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('does not rewrite terminal %s, its time or original reason', state => {
    const t = setup(), run = t.begin(t.accept('terminal'))
    t.runs.finish(run.id, state, NOW + 10, 'original outcome')
    const terminal = t.runs.get(run.id)
    t.runs.finish(run.id, 'failed', NOW + 30, 'late outcome')
    expect(t.runs.requestStop(run.id, 'late stop')).toBe(false)
    expect(t.runs.bindRuntime(run.id, 'acp-late')).toBe(false)
    expect(t.runs.get(run.id)).toEqual(terminal)
    expect(t.runs.isCurrent(run.id)).toBe(false)
  })

  it('refuses runtime binding after stop, leaving the original ACP identity intact', () => {
    const t = setup(), run = t.begin(t.accept('runtime'))
    expect(t.runs.bindRuntime(run.id, 'acp-before')).toBe(true)
    expect(t.runs.requestStop(run.id, 'space_disabled')).toBe(true)
    expect(t.runs.bindRuntime(run.id, 'acp-after')).toBe(false)
    expect(t.runs.get(run.id)?.acpSessionId).toBe('acp-before')
    expect(t.runs.bindRuntime('missing', 'acp-other')).toBe(false)
  })

  it('recovers only interrupted/cancelled records without reopening attempts or consuming never-started handoffs', () => {
    const t = setup(), active = t.accept('active'), stopping = t.accept('stopping', 'session-b'), pending = t.accept('pending', 'session-c')
    const a = t.begin(active), b = t.begin(stopping)
    t.runs.requestStop(b.id, 'user_requested')
    t.reopen()
    expect(t.runs.get(a.id)?.state).toBe('running')
    expect(t.registry.failStaleTasks('gateway restarted')).toBe(2)
    expect(t.runs.recoverInterrupted(NOW + 100)).toBe(2)
    expect(t.runs.get(a.id)).toMatchObject({ state: 'interrupted', stopReason: 'gateway_restarted', finishedAt: NOW + 100 })
    expect(t.runs.get(b.id)).toMatchObject({ state: 'cancelled', stopReason: 'user_requested', finishedAt: NOW + 100 })
    expectUnclaimed(t, pending)
    expect(t.registry.dispatches.pending().map(item => item.taskId)).toEqual([pending.id])
    const recovered = t.allRuns()
    t.reopen()
    expect(t.runs.recoverInterrupted(NOW + 200)).toBe(0)
    t.runs.finish(a.id, 'completed', NOW + 300)
    expect(t.allRuns()).toEqual(recovered)
    expect(() => t.runs.begin(t.input(active))).toThrow(/UNIQUE/)
    expect(t.begin(pending).state).toBe('running')
  })

  it('keeps multiple attempts on the same work from changing domain state or an unknown delivery receipt', async () => {
    const t = setup(), task = t.accept('first')
    const bugs = new Bugs(t.registry.db), routines = new RoutineStore(t.registry.db), issues = new IssueLinks(t.registry.db)
    const sp = spaceDeps(t.registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
    bugs.record({ spaceId: space.id, chatId: space.chatId, messageId: task.messageId, reporterOpenId: 'alice', title: '合成反馈', text: task.prompt, now: NOW })
    const routine = routines.add({ kind: 'schedule', chatId: space.chatId, chatType: 'group', spaceId: space.id, ownerOpenId: 'alice',
      name: '原职责', prompt: '保留原安排', schedule: { type: 'once', atMs: NOW + 60_000 }, now: NOW })
    routines.setEnabled(routine.id, false, NOW)
    issues.remember({ fingerprint: 'synthetic-fingerprint', repo: 'synthetic/repo', number: 7, url: 'https://github.com/synthetic/repo/issues/7', spaceId: space.id, source: 'chat-a' })
    let posts = 0
    const delivery = new DeliveryService(t.registry.db, { ...sp, now: () => NOW,
      resolveContext: () => ({ actorOpenId: 'alice', audience: { kind: 'group', spaceId: space.id, chatId: space.chatId },
        sources: [{ ref: task.messageId, spaceId: space.id, chatId: space.chatId }], provenanceComplete: true, expiresAt: NOW + 60_000 }),
      send: async () => { posts++; throw new Error('POST accepted; ACK lost') } })
    await expect(delivery.deliver({ key: 'original-operation', contextRef: `task:${task.id}`, payload: { text: '合成结果' } })).rejects.toThrow()
    expect(delivery.get('original-operation')?.status).toBe('unknown')
    const domain = () => ['bug_buckets', 'bug_reports', 'routines', 'routine_occurrences', 'github_issue_links', 'deliveries']
      .map(table => t.registry.db.prepare(`SELECT * FROM ${table}`).all())
    const before = domain(), first = t.begin(task)
    t.runs.finish(first.id, 'completed', NOW + 1)
    const amendment = t.accept('amendment', task.sessionKey, task.id), second = t.begin(amendment)
    expect(second.id).not.toBe(first.id)
    expect(second.workKey).toBe(first.workKey)
    t.runs.requestStop(second.id, 'user_requested')
    t.runs.recoverInterrupted(NOW + 2)
    expect(domain()).toEqual(before)
    expect(posts).toBe(1)
    expect(delivery.get('original-operation')?.status).toBe('unknown')
  })
})
