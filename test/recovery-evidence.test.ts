import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { inspectRecoveryEvidence, type RecoveryEvidenceInput } from '../src/core/recovery-evidence.js'
import { duePreparationRecovery } from '../src/core/local-preparation-recovery.js'
import { ensureDeliverySchema } from '../src/core/delivery.js'
import { taskDeliveryContextRef } from '../src/core/execution-keys.js'
import { ChangeManager } from '../src/github/changes.js'
import { IssueLinks } from '../src/github/issues.js'
import { Todos } from '../src/core/todos.js'
import { PmoStore } from '../src/core/pmo.js'
import { FeishuTaskSync } from '../src/core/feishu-task-sync.js'
import { createLogger } from '../src/log.js'
import type { GitHubIdentity } from '../src/github/identity.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const NOW = 1_800_000_000_000
function setup(options: { terminal?: boolean; boundary?: 'managed_api_v1' | 'workspace' | null; sessionKey?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'friday-recovery-evidence-')), registry = new Registry(join(dir, 'db'))
  cleanups.push(() => { registry.close(); rmSync(dir, { recursive: true, force: true }) })
  const db = registry.db, runs = new RunAttempts(db), calls = new RunApiCalls(db)
  const sessionKey = options.sessionKey ?? 's', actorOpenId = 'alice'
  registry.createSession({ sessionKey, chatId: 'chat', chatType: 'p2p', cwd: dir, requesterOpenId: actorOpenId })
  const inbound = { eventId: 'e', messageId: 'm', chatId: 'chat', chatType: 'p2p' as const,
    senderOpenId: actorOpenId, senderType: 'user' as const, msgType: 'text', text: '合成请求', mentions: [], createTimeMs: NOW }
  const task = registry.createTaskOnce({ sessionKey, messageId: 'm', requesterOpenId: actorOpenId, prompt: inbound.text, inbound }).task
  const run = runs.begin({ taskId: task.id, sessionKey, actorOpenId, workKey: registry.taskWork.get(task.id)!.key,
    triggerKey: `task:${task.id}`, stage: 'task', now: NOW }, () => registry.startTask(task.id, NOW, sessionKey))!
  if (options.boundary !== null) runs.bindExecutionBoundary(run.id, options.boundary ?? 'managed_api_v1')
  if (options.terminal !== false) { runs.finish(run.id, 'failed', NOW + 50, 'authorization_required'); registry.updateTask(task.id, { status: 'failed', finishedAt: NOW + 50 }) }
  const input: RecoveryEvidenceInput = { taskId: task.id, runId: run.id, sessionKey, actorOpenId }
  const inspect = (extra: Partial<RecoveryEvidenceInput> = {}) => inspectRecoveryEvidence(db, { ...input, ...extra })
  const humanInput = (options: { separate?: boolean; synthetic?: boolean; control?: boolean; status?: 'queued' | 'done' } = {}) => {
    const messageId = `m-${registry.listTasks(sessionKey).length + 1}`
    const next = { ...inbound, eventId: messageId, messageId, text: '后续的真实补充',
      senderType: options.synthetic ? 'bot' as const : 'user' as const }
    const task = registry.createTaskOnce({ sessionKey, messageId, requesterOpenId: actorOpenId, prompt: next.text, inbound: next,
      ...(!options.separate ? { amendsTaskId: input.taskId } : {}) }).task
    if (options.control) db.prepare("UPDATE work_inputs SET kind='control' WHERE task_id=?").run(task.id)
    if (options.status === 'done') registry.updateTask(task.id, { status: 'done', finishedAt: NOW + 90 })
    return task
  }
  const continuation = () => {
    expect(registry.dispatches.resume(task.id, { previousRunId: run.id, reason: 'restart' }, NOW + 100)).toBe(true)
    const next = runs.begin({ taskId: task.id, sessionKey, actorOpenId, workKey: run.workKey,
      triggerKey: `task:${task.id}:resume:1`, stage: 'task', now: NOW + 101 }, () => registry.startTask(task.id, NOW + 101, sessionKey))!
    runs.bindExecutionBoundary(next.id, 'managed_api_v1')
    return next
  }
  const call = (scopes: string[], state: 'started' | 'returned' | 'failed', runId = run.id) => {
    const id = calls.begin(runId, 'POST /v1/synthetic', NOW + 1)
    for (const scope of scopes) calls.need(id, scope)
    if (state !== 'started') calls.finish(id, state, NOW + 2)
    return id
  }
  const delivery = (key: string, status: string, remoteId: string | null, context = taskDeliveryContextRef(task.id, sessionKey), actor = actorOpenId) => {
    ensureDeliverySchema(db)
    db.prepare(`INSERT INTO deliveries (delivery_key,context_ref,signature,status,actor_open_id,audience,source_refs,grant_ids,payload_digest,remote_id,error,created_at,updated_at)
      VALUES (?,?,'secret-signature',?,?,'{}','secret-body','secret-token','secret-digest',?,'secret-error',?,?)`).run(key, context, status, actor, remoteId, NOW, NOW)
  }
  const changes = () => new ChangeManager({ db, cacheDir: join(dir, 'git'), github: {} as GitHubIdentity, log: createLogger('test', 'error') })
  const change = (id: string, state: string, session = sessionKey, actor = actorOpenId) => {
    changes()
    db.prepare(`INSERT INTO github_changes (id,session_key,requester_open_id,cwd,dir,repo,base,base_commit,branch,remote_url,git_dir,state,commit_id,result,created_at,updated_at)
      VALUES (?,?,?,'secret-cwd',?,'synthetic/repo','master','base','branch','secret-url','secret-dir',?,'sha','secret-result',?,?)`)
      .run(id, session, actor, `/synthetic/${id}`, state, NOW, NOW)
  }
  return { registry, db, runs, calls, task, run, input, inspect, call, delivery, change, humanInput, continuation }
}

describe('read-only recovery evidence', () => {
  function preparation(t: ReturnType<typeof setup>, state: string, options: { route?: string; actor?: string; attemptKey?: string; callState?: 'returned' | 'failed'; mixedScope?: boolean } = {}) {
    t.change('copy', 'prepared')
    t.db.prepare(`INSERT INTO github_change_preparations(id,operation_key,signature,session_key,requester_open_id,cwd,repo,attempt_key,state,result,created_at,updated_at)
      VALUES('prepare','prepare-key','signature',?,?,'secret-cwd','synthetic/repo',?,?,?, ?,?)`)
      .run(t.input.sessionKey, options.actor ?? t.input.actorOpenId, options.attemptKey ?? t.run.id, state,
        state === 'prepared' ? JSON.stringify({ id: 'copy', operationId: 'prepare' }) : null, NOW, NOW + 5)
    const call = t.calls.begin(t.run.id, options.route ?? 'POST /v1/github/change/start')
    t.calls.need(call, 'github:write')
    if (options.mixedScope) t.calls.need(call, 'doc:write')
    t.calls.reference(call, { kind: 'github_change_preparation', id: 'prepare' })
    t.calls.finish(call, options.callState ?? 'failed')
    return call
  }

  it.each(['retryable', 'cancelled', 'interrupted', 'prepared'])('can reuse a settled local preparation (%s) without treating it as a PR write', state => {
    const t = setup(); preparation(t, state)
    t.db.exec('PRAGMA query_only=ON')
    expect(t.inspect()).toMatchObject({ allowed: true, reasons: [] })
    expect(t.inspect().receipts).toContainEqual({ kind: 'github_change_preparation', ref: 'prepare', state: state === 'prepared' ? 'prepared' : 'not_sent' })
  })
  it('waits for an actually running preparation to settle before recovery', () => {
    const t = setup(); preparation(t, 'preparing')
    expect(t.inspect().reasons).toContain('effect_unresolved')
    t.db.prepare("UPDATE github_change_preparations SET state='interrupted'").run()
    expect(t.inspect().allowed).toBe(true)
  })
  it.each([{ route: 'POST /v1/github/change/publish' }, { actor: 'other-person' }, { attemptKey: 'other-run' }, { mixedScope: true }])(
    'does not borrow a local preparation to bypass another operation: %j', options => {
      const t = setup(); preparation(t, 'prepared', options)
      expect(t.inspect().allowed).toBe(false)
    })
  it('keeps remote publication uncertainty despite a reusable preparation in the same Run', () => {
    const t = setup(); preparation(t, 'prepared', { callState: 'returned' })
    t.call(['github:write'], 'failed')
    expect(t.inspect().reasons).toContain('effect_unresolved')
  })
  it('cannot claim a prepared result without its matching same-actor checkout receipt', () => {
    const t = setup(); preparation(t, 'prepared')
    t.db.prepare("UPDATE github_changes SET requester_open_id='other-person' WHERE id='copy'").run()
    expect(t.inspect().reasons).toContain('effect_unverifiable')
  })
  it('continues to read an old API ledger conservatively without migration', () => {
    const t = setup(); t.call(['github:write'], 'failed')
    t.db.exec('ALTER TABLE run_api_calls DROP COLUMN operations_json; PRAGMA query_only=ON')
    expect(t.inspect().reasons).toContain('effect_unresolved')
  })
  it('schedules bounded delayed recovery from the persisted local operation, with zero disabling it', () => {
    const t = setup({ terminal: false }); preparation(t, 'retryable')
    t.db.prepare("UPDATE github_change_preparations SET error_code='timeout'").run()
    t.runs.finish(t.run.id, 'completed', NOW + 20, 'end_turn', { version: 1, termination: 'end_turn', outcome: 'partial', reason: 'operation_incomplete' })
    t.registry.updateTask(t.task.id, { status: 'done', finishedAt: NOW + 20 })
    expect(duePreparationRecovery(t.db, NOW + 1000, 2)).toEqual([])
    expect(duePreparationRecovery(t.db, NOW + 31_000, 0)).toEqual([])
    expect(duePreparationRecovery(t.db, NOW + 31_000, 2)).toEqual([{ taskId: t.task.id, runId: t.run.id }])
    expect(t.registry.dispatches.resume(t.task.id, { previousRunId: t.run.id, reason: 'local_preparation' }, NOW + 31_000)).toBe(true)
    const next = t.runs.begin({ taskId: t.task.id, sessionKey: t.input.sessionKey, actorOpenId: t.input.actorOpenId,
      workKey: t.run.workKey, triggerKey: `task:${t.task.id}:resume:1`, stage: 'task', now: NOW + 31_001 },
      () => t.registry.startTask(t.task.id, NOW + 31_001, t.input.sessionKey))!
    t.runs.bindExecutionBoundary(next.id, 'managed_api_v1')
    const call = t.calls.begin(next.id, 'POST /v1/github/change/start'); t.calls.need(call, 'github:write')
    t.calls.reference(call, { kind: 'github_change_preparation', id: 'prepare' }); t.calls.finish(call, 'failed')
    t.db.prepare('UPDATE github_change_preparations SET attempt_key=?,updated_at=?').run(next.id, NOW + 32_000)
    t.runs.finish(next.id, 'completed', NOW + 32_001, 'end_turn', { version: 1, termination: 'end_turn', outcome: 'partial', reason: 'operation_incomplete' })
    t.registry.updateTask(t.task.id, { status: 'done', finishedAt: NOW + 32_001 })
    expect(duePreparationRecovery(t.db, NOW + 93_000, 1)).toEqual([])
    expect(duePreparationRecovery(t.db, NOW + 93_000, 2)).toEqual([{ taskId: t.task.id, runId: next.id }])
  })
  it('continues an explicitly incomplete Run whose prepared result was not consumed, without changing its operation receipt', () => {
    const t = setup({ terminal: false }); preparation(t, 'prepared', { callState: 'returned' })
    t.runs.finish(t.run.id, 'completed', NOW + 20, 'end_turn', { version: 1, termination: 'end_turn', outcome: 'partial', reason: 'operation_incomplete' })
    t.registry.updateTask(t.task.id, { status: 'done', finishedAt: NOW + 20 })
    const before = t.db.prepare('SELECT * FROM github_change_preparations').all()
    t.db.exec('PRAGMA query_only=ON')
    expect(duePreparationRecovery(t.db, NOW + 30_019, 2)).toEqual([])
    expect(duePreparationRecovery(t.db, NOW + 30_020, 0)).toEqual([])
    expect(duePreparationRecovery(t.db, NOW + 30_020, 2)).toEqual([{ taskId: t.task.id, runId: t.run.id }])
    expect(t.db.prepare('SELECT * FROM github_change_preparations').all()).toEqual(before)
  })
  it.each(['step_budget', 'normal_end'] as const)('does not turn a prepared result into automatic recovery after %s', reason => {
    const t = setup({ terminal: false }); preparation(t, 'prepared', { callState: 'returned' })
    t.runs.finish(t.run.id, 'completed', NOW + 20, 'end_turn', { version: 1, termination: 'end_turn',
      outcome: reason === 'normal_end' ? 'handled' : 'partial', reason })
    t.registry.updateTask(t.task.id, { status: 'done', finishedAt: NOW + 20 })
    expect(duePreparationRecovery(t.db, NOW + 10_000_000, 2)).toEqual([])
  })
  it.each(['failed-write', 'returned-write', 'unknown-delivery', 'new-input', 'stopped', 'paused', 'wrong-actor'] as const)(
    'keeps the recovery gate for a prepared but unconsumed result: %s', blocker => {
      const t = setup({ terminal: false })
      preparation(t, 'prepared', { callState: 'returned', ...(blocker === 'wrong-actor' ? { actor: 'another-person' } : {}) })
      if (blocker === 'failed-write') t.call(['github:write'], 'failed')
      if (blocker === 'returned-write') t.call(['github:write'], 'returned')
      if (blocker === 'unknown-delivery') t.delivery('uncertain-send', 'unknown', null)
      t.runs.finish(t.run.id, 'completed', NOW + 20, 'end_turn', { version: 1, termination: 'end_turn', outcome: 'partial', reason: 'operation_incomplete' })
      t.registry.updateTask(t.task.id, { status: 'done', finishedAt: NOW + 20 })
      if (blocker === 'new-input') t.humanInput()
      if (blocker === 'stopped') t.registry.workContexts.control(t.run.workKey!, { action: 'cancel', causeRef: 'message:stop' })
      if (blocker === 'paused') t.registry.workContexts.control(t.run.workKey!, { action: 'pause', reason: 'manual', causeRef: 'message:pause' })
      expect(duePreparationRecovery(t.db, NOW + 10_000_000, 2)).toEqual([])
    })
  it.each([
    { tool: 'none', state: 'retryable' }, { tool: 'list', state: 'retryable' }, { tool: 'none', state: 'prepared' },
  ] as const)('keeps the original $state operation after a $tool-only continuation and charges that Run to the finite budget', ({ tool, state }) => {
    const t = setup({ terminal: false }); preparation(t, state)
    if (state === 'retryable') t.db.prepare("UPDATE github_change_preparations SET error_code='timeout'").run()
    const finish = (runId: string, at: number) => {
      t.runs.finish(runId, 'completed', at, 'end_turn', { version: 1, termination: 'end_turn', outcome: 'partial', reason: 'operation_incomplete' })
      t.registry.updateTask(t.task.id, { status: 'done', finishedAt: at })
    }
    const resume = (previousRunId: string, generation: number, at: number) => {
      expect(t.registry.dispatches.resume(t.task.id, { previousRunId, reason: 'local_preparation' }, at)).toBe(true)
      const run = t.runs.begin({ taskId: t.task.id, sessionKey: t.input.sessionKey, actorOpenId: t.input.actorOpenId,
        workKey: t.run.workKey, triggerKey: `task:${t.task.id}:resume:${generation}`, stage: 'task', now: at + 1 },
        () => t.registry.startTask(t.task.id, at + 1, t.input.sessionKey))!
      t.runs.bindExecutionBoundary(run.id, 'managed_api_v1'); return run
    }
    finish(t.run.id, NOW + 20)
    const next = resume(t.run.id, 1, NOW + 31_000)
    if (tool === 'list') {
      const call = t.calls.begin(next.id, 'POST /v1/github/change/list'); t.calls.need(call, 'github:read'); t.calls.finish(call, 'returned')
    }
    finish(next.id, NOW + 32_000)
    expect(t.calls.forRun(next.id).flatMap(call => call.operations ?? [])).toEqual([])
    expect(duePreparationRecovery(t.db, NOW + 91_999, 2)).toEqual([])
    expect(duePreparationRecovery(t.db, NOW + 92_000, 1)).toEqual([])
    expect(duePreparationRecovery(t.db, NOW + 92_000, 2)).toEqual([{ taskId: t.task.id, runId: next.id }])
    const last = resume(next.id, 2, NOW + 92_000); finish(last.id, NOW + 93_000)
    expect(duePreparationRecovery(t.db, NOW + 10_000_000, 2)).toEqual([])
    expect(t.db.prepare('SELECT count(*) AS n FROM github_change_preparations').get()?.n).toBe(1)
    expect(t.inspect({ runId: last.id }).receipts).toContainEqual({ kind: 'github_change_preparation', ref: 'prepare', state: state === 'prepared' ? 'prepared' : 'not_sent' })
  })
  it('does not mix another Task\'s preparations, failed writes or attempt count into this recovery', () => {
    const t = setup({ terminal: false }); preparation(t, 'retryable')
    t.db.prepare("UPDATE github_change_preparations SET error_code='timeout'").run()
    t.runs.finish(t.run.id, 'completed', NOW + 20, 'end_turn', { version: 1, termination: 'end_turn', outcome: 'partial', reason: 'operation_incomplete' })
    t.registry.updateTask(t.task.id, { status: 'done', finishedAt: NOW + 20 })
    const otherTask = t.humanInput({ separate: true }), other = t.runs.begin({ taskId: otherTask.id, sessionKey: t.input.sessionKey,
      actorOpenId: t.input.actorOpenId, workKey: t.registry.taskWork.get(otherTask.id)!.key, triggerKey: `task:${otherTask.id}`, stage: 'task', now: NOW + 21 })!
    t.runs.bindExecutionBoundary(other.id, 'managed_api_v1')
    t.db.prepare(`INSERT INTO github_change_preparations(id,operation_key,signature,session_key,requester_open_id,cwd,repo,attempt_key,state,created_at,updated_at)
      SELECT 'other-prepare','other-key',signature,session_key,requester_open_id,cwd,repo,?,'preparing',created_at,updated_at FROM github_change_preparations WHERE id='prepare'`).run(other.id)
    const call = t.calls.begin(other.id, 'POST /v1/github/change/start'); t.calls.need(call, 'github:write')
    t.calls.reference(call, { kind: 'github_change_preparation', id: 'other-prepare' }); t.calls.finish(call, 'failed')
    t.call(['doc:write'], 'failed', other.id)
    t.runs.finish(other.id, 'failed', NOW + 22, 'runtime_error'); t.registry.updateTask(otherTask.id, { status: 'failed', finishedAt: NOW + 22 })
    expect(duePreparationRecovery(t.db, NOW + 31_000, 1)).toEqual([{ taskId: t.task.id, runId: t.run.id }])
    expect(t.inspect().receipts.map(receipt => receipt.ref)).not.toContain('other-prepare')
  })
  it('cannot reset the recovery budget by preparing a different local copy in a later Run', () => {
    const t = setup({ terminal: false }); preparation(t, 'prepared')
    t.runs.finish(t.run.id, 'completed', NOW + 20, 'end_turn', { version: 1, termination: 'end_turn', outcome: 'partial', reason: 'operation_incomplete' })
    t.registry.updateTask(t.task.id, { status: 'done', finishedAt: NOW + 20 })
    const next = t.continuation()
    t.db.prepare(`INSERT INTO github_change_preparations(id,operation_key,signature,session_key,requester_open_id,cwd,repo,attempt_key,state,error_code,created_at,updated_at)
      SELECT 'next-prepare','next-key',signature,session_key,requester_open_id,cwd,repo,?,'retryable','timeout',created_at,?
      FROM github_change_preparations WHERE id='prepare'`).run(next.id, NOW + 102)
    const call = t.calls.begin(next.id, 'POST /v1/github/change/start'); t.calls.need(call, 'github:write')
    t.calls.reference(call, { kind: 'github_change_preparation', id: 'next-prepare' }); t.calls.finish(call, 'failed')
    t.runs.finish(next.id, 'completed', NOW + 103, 'end_turn', { version: 1, termination: 'end_turn', outcome: 'partial', reason: 'operation_incomplete' })
    t.registry.updateTask(t.task.id, { status: 'done', finishedAt: NOW + 103 })
    expect(duePreparationRecovery(t.db, NOW + 100_000, 1)).toEqual([])
    expect(duePreparationRecovery(t.db, NOW + 100_000, 2)).toEqual([{ taskId: t.task.id, runId: next.id }])
  })
  it.each(['authentication_or_access', 'tls', 'git_failed', 'preparation_failed', 'receipt_unavailable'])('does not automatically retry %s until its condition changes', code => {
    const t = setup({ terminal: false }); preparation(t, 'retryable')
    t.db.prepare('UPDATE github_change_preparations SET error_code=?').run(code)
    t.runs.finish(t.run.id, 'completed', NOW + 20, 'end_turn', { version: 1, termination: 'end_turn', outcome: 'partial', reason: 'operation_incomplete' })
    t.registry.updateTask(t.task.id, { status: 'done', finishedAt: NOW + 20 })
    expect(duePreparationRecovery(t.db, NOW + 100_000, 2)).toEqual([])
  })
  it.each(['sent', 'confirmed'] as const)('does not replay a host-interrupted final answer with a %s ACK', status => {
    const t = setup({ terminal: false }); t.call(['chat:read'], 'returned')
    t.delivery(`task:${t.task.id}:final:0`, status, 'actual-remote-id')
    t.runs.interruptActive(NOW + 20)
    expect(t.inspect().reasons).toContain('effect_unverifiable')
  })
  it.each(['notice', 'tool:here:stable', 'final:not-a-part', 'resume:99:final:0'] as const)
    ('does not confuse %s with the interrupted attempt final ACK', suffix => {
      const t = setup({ terminal: false }); t.call(['chat:read'], 'returned')
      t.delivery(`task:${t.task.id}:${suffix}`, 'sent', 'actual-remote-id')
      t.runs.interruptActive(NOW + 20)
      expect(t.inspect()).toMatchObject({ allowed: true, reasons: [] })
    })
  it('keeps an explicit authorization partial answer eligible for the same authorized continuation', () => {
    const t = setup({ terminal: false }); t.call(['chat:read'], 'returned')
    t.delivery(`task:${t.task.id}:final:0`, 'sent', 'authorization-explanation')
    t.runs.finish(t.run.id, 'completed', NOW + 10, 'end_turn', { version: 1, termination: 'end_turn', outcome: 'partial', reason: 'authorization_required' })
    t.registry.updateTask(t.task.id, { status: 'done', finishedAt: NOW + 10 })
    t.runs.interruptActive(NOW + 20)
    expect(t.inspect()).toMatchObject({ allowed: true, reasons: [] })
  })

  it('allows a fully covered managed Run with no side effects without changing any database row', () => {
    const t = setup()
    t.db.exec('PRAGMA query_only=ON')
    expect(t.inspect()).toEqual({ allowed: true, reasons: [], receipts: [] })
  })
  it.each(['workspace', null] as const)('does not infer coverage for boundary %s', boundary => {
    const t = setup({ boundary })
    expect(t.inspect()).toMatchObject({ allowed: false, reasons: ['coverage_missing'] })
  })
  it('reads an old schema conservatively without migrating or backfilling it', () => {
    const t = setup()
    t.db.exec('ALTER TABLE run_attempts DROP COLUMN execution_boundary; PRAGMA query_only=ON')
    expect(t.inspect()).toMatchObject({ allowed: false, reasons: ['coverage_missing'] })
  })
  it('requires the actual API ledger even when the runtime boundary is marked managed', () => {
    const t = setup(); t.db.exec('DROP TABLE run_api_calls')
    expect(t.inspect()).toMatchObject({ allowed: false, reasons: ['coverage_missing'] })
  })
  it.each(['taskId', 'runId', 'sessionKey', 'actorOpenId'] as const)('rejects a mismatched %s without returning references', field => {
    const t = setup(); t.delivery('private-key', 'sent', 'om_private')
    const wrong = { ...t.input, [field]: field === 'taskId' ? t.task.id + 100 : 'different' }
    expect(inspectRecoveryEvidence(t.db, wrong)).toEqual({ allowed: false, reasons: ['identity_mismatch'], receipts: [] })
  })
  it('rejects an active attempt and a user-stopped work', () => {
    const t = setup({ terminal: false })
    expect(t.inspect().reasons).toContain('attempt_not_terminal')
    t.runs.requestStop(t.run.id, 'user_requested'); t.runs.finish(t.run.id, 'cancelled', NOW + 50)
    expect(t.inspect().reasons).toContain('work_stopped')
  })
  it('does not revive a superseded older attempt', () => {
    const t = setup()
    t.runs.begin({ taskId: t.task.id, sessionKey: t.input.sessionKey, actorOpenId: t.input.actorOpenId, workKey: t.run.workKey,
      triggerKey: `task:${t.task.id}:resume:1`, stage: 'task', now: NOW + 100 })
    expect(t.inspect().reasons).toContain('attempt_superseded')
  })
  it.each(['started', 'failed'] as const)('permits a %s read call but blocks any mixed mutation scope', state => {
    const t = setup(); t.call(['chat:read', 'chat:read-others'], state)
    expect(t.inspect().allowed).toBe(true)
    t.call(['chat:read', 'doc:write'], state)
    expect(t.inspect().reasons).toContain('effect_unresolved')
  })
  it('retains a returned write ACK but requires reconciliation before replay, even if ACP history may still exist', () => {
    const t = setup(); const id = t.call(['doc:write'], 'returned')
    expect(t.inspect()).toEqual({ allowed: false, reasons: ['effect_unverifiable'], receipts: [{ kind: 'api_call', ref: id, state: 'acknowledged' }] })
    const resumed = t.continuation()
    expect(t.inspect({ continuationRunId: resumed.id }).reasons).toEqual(['effect_unverifiable'])
  })
  it('rechecks read-only recovery only for its exact durably admitted successor Run', () => {
    const t = setup(); t.call(['chat:read'], 'returned')
    const resumed = t.continuation()
    expect(t.inspect({ continuationRunId: resumed.id }).allowed).toBe(true)
    expect(t.inspect({ continuationRunId: 'other-run' }).reasons).toContain('attempt_superseded')
    t.db.prepare('UPDATE task_dispatches SET resume_json=? WHERE task_id=?').run(JSON.stringify({ previousRunId: 'other' }), t.task.id)
    expect(t.inspect({ continuationRunId: resumed.id }).allowed).toBe(false)
  })
  it.each(['queued', 'done'] as const)('does not resume an earlier input when later same-Work input is %s', status => {
    const t = setup(); t.humanInput({ status })
    expect(t.inspect().reasons).toContain('input_superseded')
  })
  it.each([{ separate: true }, { synthetic: true }, { control: true }])('does not treat an unrelated or non-human/control task as takeover: %j', options => {
    const t = setup(); t.humanInput(options)
    expect(t.inspect().allowed).toBe(true)
  })
  it('rechecks takeover after ACP preparation and does not mistake the new generation for a new human input', () => {
    const t = setup(), resumed = t.continuation()
    expect(t.inspect({ continuationRunId: resumed.id }).allowed).toBe(true)
    t.humanInput()
    expect(t.inspect({ continuationRunId: resumed.id }).reasons).toContain('input_superseded')
  })
  it('keeps returned mutations from earlier generations visible when a later generation only read data', () => {
    const t = setup(); const id = t.call(['doc:write'], 'returned'), resumed = t.continuation()
    t.runs.bindExecutionBoundary(resumed.id, 'managed_api_v1')
    t.call(['chat:read'], 'returned', resumed.id)
    t.runs.finish(resumed.id, 'interrupted', NOW + 200)
    t.registry.updateTask(t.task.id, { status: 'failed', finishedAt: NOW + 200 })
    const evidence = t.inspect({ runId: resumed.id })
    expect(evidence.reasons).toContain('effect_unverifiable')
    expect(evidence.receipts).toContainEqual({ kind: 'api_call', ref: id, state: 'acknowledged' })
  })
  it('cannot cover an earlier workspace generation with a later managed generation', () => {
    const t = setup({ boundary: 'workspace' }), resumed = t.continuation()
    t.runs.finish(resumed.id, 'interrupted', NOW + 200)
    t.registry.updateTask(t.task.id, { status: 'failed', finishedAt: NOW + 200 })
    expect(t.inspect({ runId: resumed.id }).reasons).toContain('coverage_missing')
  })
  it.each(['started', 'failed', 'returned'] as const)('does not infer read-only from an empty scope list (%s)', state => {
    const t = setup(); t.call([], state)
    expect(t.inspect().reasons).toContain('coverage_invalid')
  })
  it('treats malformed scope JSON as unknown instead of throwing or inventing coverage', () => {
    const t = setup(); const id = t.call(['chat:read'], 'returned')
    t.db.prepare('UPDATE run_api_calls SET scopes_json=? WHERE id=?').run('not json', id)
    expect(t.inspect().allowed).toBe(false)
  })
  it('does not include another Run’s failed mutation', () => {
    const t = setup(); t.call(['doc:write'], 'failed', 'other-run')
    expect(t.inspect()).toEqual({ allowed: true, reasons: [], receipts: [] })
  })
  it.each(['planned', 'unknown'] as const)('blocks a %s message without resending or exposing payload data', status => {
    const t = setup(); t.delivery('delivery-1', status, null)
    const result = t.inspect()
    expect(result.reasons).toContain('effect_unresolved')
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(t.db.prepare('SELECT status FROM deliveries').get()?.status).toBe(status)
  })
  it('accepts ACKed delivery and detects missing or mismatched remote identity', () => {
    const t = setup(); t.delivery('acked', 'sent', 'om_acked')
    expect(t.inspect().allowed).toBe(true)
    t.delivery('missing', 'sent', null)
    expect(t.inspect().reasons).toContain('effect_unverifiable')
  })
  it('matches task context boundaries literally, including wildcard characters and subcontexts', () => {
    const t = setup({ sessionKey: 's_%' })
    const context = taskDeliveryContextRef(t.task.id, t.input.sessionKey)
    t.delivery('other-session', 'unknown', null, context.replace('s_%', 'sAX'))
    t.delivery('other-task', 'unknown', null, taskDeliveryContextRef(t.task.id + 10, t.input.sessionKey))
    expect(t.inspect().allowed).toBe(true)
    t.delivery('same-subcontext', 'unknown', null, `${context}:tool:dm`)
    expect(t.inspect().receipts.map(receipt => receipt.ref)).toEqual(['same-subcontext'])
  })
  it('does not scan unscoped Issue operations belonging to unrelated people', () => {
    const t = setup(), issues = new IssueLinks(t.db)
    issues.planOperation({ requestKey: 'other-person', signature: 'secret', action: 'created', repo: 'synthetic/repo' })
    expect(t.inspect()).toEqual({ allowed: true, reasons: [], receipts: [] })
    t.call(['github:write'], 'failed')
    expect(t.inspect().reasons).toContain('effect_unresolved')
  })
  it('scopes GitHub unknown publication to the same Session and actor', () => {
    const t = setup()
    t.change('other-session', 'pr_unknown', 'other-session')
    t.change('other-actor', 'pr_unknown', undefined, 'bob')
    expect(t.inspect().allowed).toBe(true)
    t.change('mine', 'pr_unknown')
    expect(t.inspect()).toMatchObject({ allowed: false, receipts: [{ kind: 'github_change', ref: 'mine', state: 'unresolved' }] })
  })
  it('permits prepared or confirmed changes and blocks a pending update without changing the original business key', () => {
    const t = setup(); t.change('change-a', 'confirmed'); t.change('prepared-b', 'prepared')
    expect(t.inspect().allowed).toBe(true)
    t.db.prepare(`INSERT INTO github_change_updates (id,change_id,parent_commit,snapshot,intent,commit_id,state,created_at,updated_at)
      VALUES ('update-a','change-a','parent','secret-snapshot','secret-intent','sha','push_planned',?,?)`).run(NOW, NOW)
    expect(t.inspect().receipts).toContainEqual({ kind: 'github_change_update', ref: 'update-a', state: 'unresolved' })
    expect(JSON.stringify(t.inspect())).not.toContain('secret')
  })
  it('finds pending PMO writes for this actor’s Session without returning base tokens or row contents', () => {
    const t = setup(), todos = new Todos(t.db), pmo = new PmoStore(t.db)
    const mine = todos.add({ title: 'secret-title', scope: 'space:s', sessionKey: t.input.sessionKey, createdBy: 'alice' })
    const other = todos.add({ title: 'secret-title', scope: 'space:s', sessionKey: 'other', createdBy: 'alice' })
    const binding = { spaceId: 's', boundBy: 'alice', appToken: 'secret-app-token', tableId: 'secret-table', url: 'secret-url' }
    pmo.reserveCreate(binding, other.id, 'pending-create:secret')
    expect(t.inspect().allowed).toBe(true)
    pmo.remember(binding, mine.id, 'record', 'fingerprint')
    expect(t.inspect().allowed).toBe(true)
    pmo.reserveWrite(binding, mine.id, { recordId: 'record', fingerprint: 'new', fields: { title: 'secret-body' } })
    const result = t.inspect()
    expect(result.receipts).toEqual([{ kind: 'pmo', ref: String(mine.id), state: 'unresolved' }])
    expect(JSON.stringify(result)).not.toContain('secret')
  })
  it('can report an existing Feishu task ACK without claiming that absent mirror rows prove no write', () => {
    const t = setup(), todos = new Todos(t.db)
    new FeishuTaskSync({ db: t.db, todos, tasks: {} as never, log: createLogger('test', 'error') })
    const mine = todos.add({ title: 'secret-title', scope: 'space:s', sessionKey: t.input.sessionKey, createdBy: 'alice' })
    expect(t.inspect().receipts).toEqual([])
    t.db.prepare('INSERT INTO feishu_task_links(todo_id,guid,created_at,synced_at) VALUES (?,?,?,?)').run(mine.id, 'guid', NOW, NOW)
    expect(t.inspect().receipts).toEqual([{ kind: 'feishu_task', ref: String(mine.id), state: 'acknowledged' }])
  })
})
