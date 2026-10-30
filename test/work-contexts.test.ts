import { describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { WorkContexts, WorkControlError, type WorkInputKind } from '../src/core/work-contexts.js'
import type { InboundMessage } from '../src/feishu/mention.js'

const NOW = 1_800_000_000_000
const inbound = (messageId: string): InboundMessage => ({ eventId: messageId, messageId, chatId: 'oc_dm', chatType: 'p2p', senderOpenId: 'alice',
  senderType: 'user', msgType: 'text', text: 'request', mentions: [], createTimeMs: NOW })

/** Registry creates Tasks and their work roots; WorkContexts adds the thin delegation lifecycle on top of them. */
function setup() {
  const registry = new Registry(':memory:'), db = registry.db, attempts = new RunAttempts(db)
  registry.createSession({ sessionKey: 'dm:alice', chatId: 'oc_dm', chatType: 'p2p', requesterOpenId: 'alice', cwd: '/synthetic' })
  const works = registry.workContexts
  const task = (messageId: string, extra: { amendsTaskId?: number; workFromTaskId?: number; inputKind?: WorkInputKind } = {}) =>
    registry.createTaskOnce({ sessionKey: 'dm:alice', messageId, requesterOpenId: 'alice', prompt: `request ${messageId}`, inbound: inbound(messageId), ...extra }).task
  return { registry, db, attempts, works, task }
}

describe('WorkContexts: thin delegation lifecycle over existing Task roots', () => {
  it('creates one open context per work root when the Task is created and numbers every real input', () => {
    const t = setup(), root = t.task('m1')
    const context = t.works.get(`task:${root.id}`)
    expect(context).toMatchObject({ workKey: `task:${root.id}`, rootTaskId: root.id, sessionKey: 'dm:alice', authorityOpenId: 'alice',
      lifecycle: 'open', revision: 1, controlEpoch: 1, inputSeq: 1, handledSeq: 0, pauseReasons: [] })
    const amendment = t.task('m2', { amendsTaskId: root.id })
    expect(t.works.get(`task:${root.id}`)).toMatchObject({ inputSeq: 2, handledSeq: 0 })
    expect(t.works.inputs(`task:${root.id}`)).toEqual([{ seq: 1, taskId: root.id, kind: 'instruction' }, { seq: 2, taskId: amendment.id, kind: 'instruction' }])
    const other = t.task('m3')
    expect(t.works.get(`task:${other.id}`)).toMatchObject({ inputSeq: 1 })
    expect(t.works.get(`task:${root.id}`)).toMatchObject({ inputSeq: 2 })
  })

  it('rolls the context back together with a failed Task creation and stays idempotent for duplicate events', () => {
    const t = setup(), root = t.task('m1')
    t.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON task_receipts BEGIN SELECT RAISE(ABORT,'SYNTHETIC_RECEIPT_FAIL'); END;")
    expect(() => t.task('m2', { amendsTaskId: root.id })).toThrow('SYNTHETIC_RECEIPT_FAIL')
    t.db.exec('DROP TRIGGER fail_receipt')
    expect(t.works.get(`task:${root.id}`)).toMatchObject({ inputSeq: 1 })
    expect(t.works.inputs(`task:${root.id}`)).toHaveLength(1)
    expect(t.task('m1').id).toBe(root.id)
    expect(t.works.get(`task:${root.id}`)).toMatchObject({ inputSeq: 1, revision: 1 })
  })

  it('claims a Run only while the work is open and unpaused, and reports what blocks it otherwise', () => {
    const t = setup(), root = t.task('m1'), key = `task:${root.id}` as const
    expect(t.works.claim(key)).toEqual({ controlEpoch: 1, inputSeq: 1 })
    t.works.control(key, { action: 'pause', reason: 'authorization', causeRef: 'user-token:alice' })
    expect(() => t.works.claim(key)).toThrow(WorkControlError)
    expect(() => t.works.claim(key)).toThrow(/authorization/)
    t.works.control(key, { action: 'resume', reason: 'authorization', causeRef: 'user-token:alice' })
    expect(t.works.claim(key)).toEqual({ controlEpoch: 3, inputSeq: 1 })
    t.works.control(key, { action: 'cancel', causeRef: 'feedback:7' })
    expect(() => t.works.claim(key)).toThrow(/cancelled/)
    expect(() => t.works.claim('task:999')).toThrow(/unknown/)
  })

  it('keeps pause reasons independent: resuming one cause leaves other causes and a manual pause in place', () => {
    const t = setup(), root = t.task('m1'), key = `task:${root.id}` as const
    t.works.control(key, { action: 'pause', reason: 'authorization', causeRef: 'user-token:alice' })
    t.works.control(key, { action: 'pause', reason: 'manual', causeRef: 'message:om_stop' })
    t.works.control(key, { action: 'pause', reason: 'authorization', causeRef: 'user-token:alice' })
    expect(t.works.get(key)?.pauseReasons).toEqual([{ reason: 'authorization', causeRef: 'user-token:alice' }, { reason: 'manual', causeRef: 'message:om_stop' }])
    t.works.control(key, { action: 'resume', reason: 'authorization', causeRef: 'user-token:alice' })
    expect(t.works.get(key)?.pauseReasons).toEqual([{ reason: 'manual', causeRef: 'message:om_stop' }])
    expect(() => t.works.claim(key)).toThrow(/manual/)
    t.works.control(key, { action: 'resume', reason: 'manual', causeRef: 'message:om_stop' })
    expect(t.works.claim(key)).toMatchObject({ inputSeq: 1 })
  })

  it('bumps the control epoch on every control so an admission taken before the control is stale', () => {
    const t = setup(), root = t.task('m1'), key = `task:${root.id}` as const
    const admitted = t.works.claim(key)
    t.works.control(key, { action: 'pause', reason: 'manual', causeRef: 'message:om_stop' })
    expect(t.works.isCurrentEpoch(key, admitted.controlEpoch)).toBe(false)
    t.works.control(key, { action: 'resume', reason: 'manual', causeRef: 'message:om_stop' })
    expect(t.works.isCurrentEpoch(key, admitted.controlEpoch)).toBe(false)
    expect(t.works.isCurrentEpoch(key, t.works.claim(key).controlEpoch)).toBe(true)
  })

  it('rejects a control with a stale expected revision without touching the context', () => {
    const t = setup(), root = t.task('m1'), key = `task:${root.id}` as const
    const before = t.works.get(key)!
    t.works.control(key, { action: 'pause', reason: 'manual', causeRef: 'a' })
    expect(() => t.works.control(key, { action: 'cancel', causeRef: 'b', expectedRevision: before.revision })).toThrow(WorkControlError)
    expect(t.works.get(key)).toMatchObject({ lifecycle: 'open', revision: before.revision + 1, pauseReasons: [{ reason: 'manual', causeRef: 'a' }] })
  })

  it('tracks handled inputs per work and never moves the handled sequence backwards', () => {
    const t = setup(), root = t.task('m1'), key = `task:${root.id}` as const
    const second = t.task('m2', { amendsTaskId: root.id })
    expect(t.works.markHandled(key, second.id)).toMatchObject({ handledSeq: 2 })
    expect(t.works.markHandled(key, root.id)).toMatchObject({ handledSeq: 2 })
    expect(t.works.get(key)).toMatchObject({ inputSeq: 2, handledSeq: 2 })
    expect(() => t.works.markHandled(key, 999)).toThrow(WorkControlError)
  })

  it.each(['instruction', 'evidence', 'control'] as const)('excludes a cancelled %s without consuming an earlier queued human request', inputKind => {
    const t = setup(), human = t.task('human'), key = `task:${human.id}`
    const later = t.task('later', { workFromTaskId: human.id, inputKind })
    const unrelated = t.task('other-work')
    const before = t.works.get(key)!, inputs = t.works.inputs(key)
    expect(t.registry.cancelQueuedTask(later.id, NOW + 1, 'input_superseded')).toBe(true)
    expect(t.works.view(key)).toMatchObject({ activity: 'queued', pending: { inputs: 1 } })
    expect(t.works.get(key)).toEqual(before)
    expect(t.works.inputs(key)).toEqual(inputs)
    expect(t.registry.getTask(human.id)?.status).toBe('queued')
    expect(t.works.view(`task:${unrelated.id}`)?.pending.inputs).toBe(1)
    expect(t.registry.cancelQueuedTask(human.id, NOW + 2)).toBe(true)
    expect(t.works.view(key)).toMatchObject({ activity: 'idle', pending: { inputs: 0 }, handledSeq: 0 })
  })

  it.each(['done', 'failed'] as const)('a normal %s attempt is terminal, not a phantom pending input before its consumption watermark is updated', status => {
    const t = setup(), task = t.task('m1'), key = `task:${task.id}`
    const run = t.attempts.begin({ workKey: key, sessionKey: task.sessionKey, triggerKey: `task:${task.id}`,
      stage: 'task', taskId: task.id, actorOpenId: 'alice', now: NOW }, () => t.registry.startTask(task.id, NOW, task.sessionKey))!
    expect(t.works.view(key)).toMatchObject({ activity: 'running', pending: { inputs: 1 } })
    t.registry.updateTask(task.id, { status, finishedAt: NOW + 1 })
    t.attempts.finish(run.id, status === 'done' ? 'completed' : 'failed', NOW + 1)
    expect(t.works.view(key)).toMatchObject({ activity: 'idle', pending: { inputs: 0 }, inputSeq: 1, handledSeq: 0 })
    t.works.markHandled(key, task.id)
    expect(t.works.view(key)).toMatchObject({ pending: { inputs: 0 }, handledSeq: 1 })
  })

  it('counts a host-authorized resumed generation even when its original input was already consumed', () => {
    const t = setup(), task = t.task('m1'), key = `task:${task.id}`
    const begin = (generation: number) => t.attempts.begin({ workKey: key, sessionKey: task.sessionKey,
      triggerKey: `task:${task.id}:generation:${generation}`, stage: 'task', taskId: task.id, actorOpenId: 'alice', now: NOW + generation },
      () => t.registry.startTask(task.id, NOW + generation, task.sessionKey))!
    const first = begin(0)
    t.registry.updateTask(task.id, { status: 'failed', finishedAt: NOW + 1 })
    t.attempts.finish(first.id, 'failed', NOW + 1)
    t.works.markHandled(key, task.id)
    expect(t.works.view(key)?.pending.inputs).toBe(0)
    expect(t.registry.dispatches.resume(task.id, { previousRunId: first.id, reason: 'authorization' }, NOW + 2)).toBe(true)
    expect(t.registry.dispatches.get(task.id)?.generation).toBe(1)
    expect(t.works.view(key)).toMatchObject({ activity: 'queued', pending: { inputs: 1 }, inputSeq: 1, handledSeq: 1 })
    const resumed = begin(3)
    expect(t.works.view(key)).toMatchObject({ activity: 'running', pending: { inputs: 1 } })
    t.attempts.requestStop(resumed.id, 'user_requested')
    expect(t.works.view(key)).toMatchObject({ activity: 'stopping', pending: { inputs: 1 } })
    t.registry.updateTask(task.id, { status: 'cancelled', stopReason: 'user_requested', finishedAt: NOW + 4 })
    t.attempts.finish(resumed.id, 'cancelled', NOW + 4, 'user_requested')
    expect(t.works.view(key)).toMatchObject({ activity: 'idle', pending: { inputs: 0 }, inputSeq: 1, handledSeq: 1 })
  })

  it('preserves an earlier queued request when legacy backfill has a later terminal task watermark', () => {
    const t = setup(), human = t.task('human'), key = `task:${human.id}`
    const later = t.task('later', { workFromTaskId: human.id })
    t.registry.updateTask(later.id, { status: 'cancelled', stopReason: 'input_superseded', finishedAt: NOW })
    t.db.exec('DROP TABLE work_inputs; DROP TABLE work_pause_reasons; DROP TABLE work_contexts')
    const works = new WorkContexts(t.db, () => NOW)
    expect(works.view(key)).toMatchObject({ activity: 'queued', pending: { inputs: 1 }, inputSeq: 2, handledSeq: 2 })
    expect(t.registry.getTask(human.id)?.status).toBe('queued')
    const prior = works.get(key)
    expect(new WorkContexts(t.db, () => NOW + 1).view(key)?.pending.inputs).toBe(1)
    expect(works.get(key)).toEqual(prior)
  })

  it('completes a work only after a control, and a later real input reopens the delegation explicitly', () => {
    const t = setup(), root = t.task('m1'), key = `task:${root.id}` as const
    t.works.control(key, { action: 'complete', causeRef: `run:finished:${root.id}` })
    expect(t.works.get(key)?.lifecycle).toBe('completed')
    expect(() => t.works.claim(key)).toThrow(/completed/)
    // A new real amendment is an explicit continuation of a completed work. A late amendment to a cancelled work is
    // kept as an input for the record but does not revive the delegation.
    t.task('m2', { amendsTaskId: root.id })
    expect(t.works.get(key)).toMatchObject({ lifecycle: 'open', inputSeq: 2 })
    t.works.control(key, { action: 'cancel', causeRef: 'feedback:7' })
    t.task('m3', { amendsTaskId: root.id })
    expect(t.works.get(key)).toMatchObject({ lifecycle: 'cancelled', inputSeq: 3 })
    expect(() => t.works.claim(key)).toThrow(/cancelled/)
  })

  it('derives activity from the real Run, queued Task and open question facts instead of storing it', () => {
    const t = setup(), root = t.task('m1'), key = `task:${root.id}` as const
    expect(t.works.view(key)).toMatchObject({ lifecycle: 'open', activity: 'queued', pending: { inputs: 1 } })
    const run = t.attempts.begin({ workKey: key, sessionKey: 'dm:alice', triggerKey: `task:${root.id}`, stage: 'task', taskId: root.id, actorOpenId: 'alice', now: NOW },
      () => t.registry.startTask(root.id, NOW, 'dm:alice'))!
    expect(t.works.view(key)).toMatchObject({ activity: 'running', runId: run.id })
    t.attempts.requestStop(run.id, 'user_requested')
    expect(t.works.view(key)).toMatchObject({ activity: 'stopping', runId: run.id })
    t.attempts.finish(run.id, 'completed', NOW + 1)
    t.registry.updateTask(root.id, { status: 'done', finishedAt: NOW + 1 })
    t.works.markHandled(key, root.id)
    expect(t.works.view(key)).toMatchObject({ activity: 'idle', pending: { inputs: 0 } })
    t.task('m2', { amendsTaskId: root.id })
    expect(t.works.view(key)).toMatchObject({ activity: 'queued', pending: { inputs: 1 } })
    t.works.control(key, { action: 'cancel', causeRef: 'feedback:7' })
    expect(t.works.view(key)).toMatchObject({ lifecycle: 'cancelled', activity: 'idle' })
  })

  it('shows a paused open work as paused while nothing runs, whatever else is queued or asked', () => {
    const t = setup(), root = t.task('m1'), key = `task:${root.id}` as const
    t.works.control(key, { action: 'pause', reason: 'run_stop', causeRef: 'run:synthetic' })
    expect(t.works.view(key)).toMatchObject({ lifecycle: 'open', activity: 'paused', pending: { inputs: 1 } })
    // A Run that is still finishing is reported as such; the pause only decides what may start next.
    const run = t.attempts.begin({ workKey: key, sessionKey: 'dm:alice', triggerKey: `task:${root.id}`, stage: 'task', taskId: root.id, actorOpenId: 'alice', now: NOW },
      () => t.registry.startTask(root.id, NOW, 'dm:alice'))!
    t.attempts.requestStop(run.id, 'user_requested')
    expect(t.works.view(key)).toMatchObject({ activity: 'stopping' })
    t.attempts.finish(run.id, 'cancelled', NOW + 1)
    t.registry.updateTask(root.id, { status: 'cancelled', stopReason: 'user_requested', finishedAt: NOW + 1 })
    // The stopped input is retained, but no longer queued for execution. Its
    // run_stop pause and unconsumed historical watermark remain independent.
    expect(t.works.view(key)).toMatchObject({ activity: 'paused', pending: { inputs: 0 }, inputSeq: 1, handledSeq: 0 })
    // A queued follow-up registered as evidence (not an instruction) waits behind the pause until the cause is resumed.
    t.registry.db.exec("INSERT INTO tasks (session_key, message_id, requester_open_id, prompt, status, created_at) VALUES ('dm:alice', 'm-evidence', 'alice', 'evidence', 'queued', 1)")
    const evidence = Number(t.registry.db.prepare("SELECT id FROM tasks WHERE message_id = 'm-evidence'").get()!.id)
    t.works.registerTask({ taskId: evidence, workKey: key, rootTaskId: root.id, sessionKey: 'dm:alice', authorityOpenId: 'alice', kind: 'evidence' })
    expect(t.works.view(key)).toMatchObject({ activity: 'paused', pending: { inputs: 1 }, inputSeq: 2, handledSeq: 0 })
    t.works.control(key, { action: 'resume', reason: 'run_stop', causeRef: 'run:synthetic' })
    expect(t.works.view(key)).toMatchObject({ activity: 'queued', pauseReasons: [] })
  })

  it('lets a new real instruction lift a stop-caused pause, but not pauses that another authority or system caused', () => {
    const t = setup(), root = t.task('m1'), key = `task:${root.id}` as const
    t.works.control(key, { action: 'pause', reason: 'run_stop', causeRef: 'run:a' })
    t.works.control(key, { action: 'pause', reason: 'run_stop', causeRef: 'run:b' })
    const before = t.works.get(key)!
    t.task('m2', { amendsTaskId: root.id })
    expect(t.works.get(key)).toMatchObject({ lifecycle: 'open', pauseReasons: [], inputSeq: 2, revision: before.revision + 1, controlEpoch: before.controlEpoch + 1 })
    expect(() => t.works.claim(key)).not.toThrow()
    t.works.control(key, { action: 'pause', reason: 'authorization', causeRef: 'grant:9' })
    t.works.control(key, { action: 'pause', reason: 'run_stop', causeRef: 'run:c' })
    const paused = t.works.get(key)!
    t.task('m3', { amendsTaskId: root.id })
    expect(t.works.get(key)).toMatchObject({ pauseReasons: [{ reason: 'authorization', causeRef: 'grant:9' }], inputSeq: 3, revision: paused.revision + 1 })
    expect(() => t.works.claim(key)).toThrow(expect.objectContaining({ code: 'paused' }))
    // Another input while no stop pause exists changes nothing about control state.
    const untouched = t.works.get(key)!
    t.task('m4', { amendsTaskId: root.id })
    expect(t.works.get(key)).toMatchObject({ revision: untouched.revision, controlEpoch: untouched.controlEpoch, inputSeq: 4 })
  })

  it('migrates existing work roots as open contexts without inventing inputs beyond the recorded Tasks', () => {
    const registry = new Registry(':memory:'), db = registry.db
    registry.createSession({ sessionKey: 'dm:alice', chatId: 'oc_dm', chatType: 'p2p', requesterOpenId: 'alice', cwd: '/synthetic' })
    const root = registry.createTaskOnce({ sessionKey: 'dm:alice', messageId: 'legacy-1', requesterOpenId: 'alice', prompt: 'legacy' }).task
    const follow = registry.createTaskOnce({ sessionKey: 'dm:alice', messageId: 'legacy-2', requesterOpenId: 'alice', prompt: 'legacy follow', amendsTaskId: root.id }).task
    registry.updateTask(root.id, { status: 'done', finishedAt: NOW })
    registry.updateTask(follow.id, { status: 'done', finishedAt: NOW })
    db.exec('DROP TABLE work_inputs; DROP TABLE work_pause_reasons; DROP TABLE work_contexts')
    const works = new WorkContexts(db, () => NOW)
    expect(works.get(`task:${root.id}`)).toMatchObject({ lifecycle: 'open', inputSeq: 2, handledSeq: 2, revision: 1, controlEpoch: 1 })
    expect(works.inputs(`task:${root.id}`)).toEqual([{ seq: 1, taskId: root.id, kind: 'instruction' }, { seq: 2, taskId: follow.id, kind: 'instruction' }])
    const again = new WorkContexts(db, () => NOW + 5)
    expect(again.get(`task:${root.id}`)).toEqual(works.get(`task:${root.id}`))
  })
})
