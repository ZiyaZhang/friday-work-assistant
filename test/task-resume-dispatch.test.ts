import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts, type RunAttempt } from '../src/core/run-attempts.js'
import { TaskDispatches } from '../src/core/task-dispatch.js'
import type { InboundMessage } from '../src/feishu/mention.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
function fixture(legacy = false) {
  const home = mkdtempSync(join(tmpdir(), 'friday-resume-')), path = join(home, 'db')
  if (legacy) {
    const old = new DatabaseSync(path)
    old.exec('CREATE TABLE task_dispatches (task_id INTEGER PRIMARY KEY REFERENCES tasks(id), inbound TEXT NOT NULL, steer INTEGER NOT NULL, started_at INTEGER)')
    old.close()
  }
  let registry = new Registry(path), attempts = new RunAttempts(registry.db)
  const inbound: InboundMessage = { messageId: 'message', eventId: 'event', tenantId: 'tenant', chatId: 'chat', chatType: 'p2p',
    senderOpenId: 'alice', senderType: 'user', msgType: 'post', text: '请继续核对这份材料', imageKey: 'original-image',
    imageKeys: ['original-image', 'second-image'], mentions: [{ key: '@person', openId: 'reporter', name: '报告人' }],
    parentId: 'parent', rootId: 'root', threadId: 'thread', createTimeMs: 10 }
  registry.createSession({ sessionKey: 'session', chatId: inbound.chatId, chatType: inbound.chatType, cwd: home, requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey: 'session', messageId: inbound.messageId, requesterOpenId: 'alice',
    prompt: inbound.text, inbound, steer: false }).task
  const work = registry.taskWork.get(task.id)!
  const begin = (time = 20) => {
    const generation = registry.dispatches.get(task.id)!.generation
    return attempts.begin({ workKey: work.key, sessionKey: 'session', taskId: task.id, actorOpenId: 'alice', stage: 'task',
      triggerKey: `task:${task.id}:generation:${generation}`, now: time }, () => registry.startTask(task.id, time))!
  }
  const finish = (run: RunAttempt, time = 30) => {
    attempts.finish(run.id, 'failed', time, 'authorization_required')
    registry.updateTask(task.id, { status: 'failed', error: 'previous error', stopReason: 'authorization_required', finishedAt: time })
  }
  const reopen = () => { registry.close(); registry = new Registry(path); attempts = new RunAttempts(registry.db) }
  cleanups.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  return { home, path, get registry() { return registry }, get attempts() { return attempts }, inbound, task, work, begin, finish, reopen }
}

describe('durable resumption of the original inbound Task', () => {
  it('migrates the old dispatch table and retains original generation zero across reopen', () => {
    const t = fixture(true)
    expect(t.registry.dispatches.get(t.task.id)).toEqual({ taskId: t.task.id, inbound: t.inbound, steer: false, generation: 0, resume: null })
    t.reopen()
    expect(t.registry.dispatches.pending()).toEqual([{ taskId: t.task.id, inbound: t.inbound, steer: false, generation: 0, resume: null }])
    const columns = t.registry.db.prepare('PRAGMA table_info(task_dispatches)').all().map(row => row.name)
    expect(columns.filter(name => name === 'generation')).toHaveLength(1)
    expect(columns.filter(name => name === 'resume_json')).toHaveLength(1)
  })

  it('queues one new generation once across callback stores and restart without changing the real envelope or creating tasks', () => {
    const t = fixture(), first = t.begin(); t.finish(first)
    const original = t.registry.db.prepare('SELECT inbound FROM task_dispatches WHERE task_id = ?').get(t.task.id)!.inbound
    const other = new TaskDispatches(t.registry.db)
    expect(t.registry.dispatches.resume(t.task.id, { previousRunId: first.id, reason: 'authorization' }, 40)).toBe(true)
    expect(other.resume(t.task.id, { previousRunId: first.id, reason: 'authorization' }, 41)).toBe(false)
    expect(other.resume(t.task.id, { previousRunId: first.id, reason: 'restart' }, 42)).toBe(false)
    t.reopen()
    expect(t.registry.dispatches.resume(t.task.id, { previousRunId: first.id, reason: 'authorization' }, 43)).toBe(false)
    expect(t.registry.dispatches.get(t.task.id)).toEqual({ taskId: t.task.id, inbound: t.inbound, steer: false, generation: 1,
      resume: { previousRunId: first.id, reason: 'authorization', resumedAt: 40 } })
    expect(t.registry.dispatches.pending()).toHaveLength(1)
    expect(t.registry.getTask(t.task.id)).toMatchObject({ status: 'queued', error: null, finishedAt: null, stopReason: null, startedAt: null })
    expect(t.registry.listTasks('session')).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT inbound FROM task_dispatches WHERE task_id = ?').get(t.task.id)!.inbound).toBe(original)
    expect(t.registry.workContexts.inputs(t.work.key)).toHaveLength(1)
  })

  it('rejects old callbacks before, during and after the next attempt; only the newest terminal attempt can resume', () => {
    const t = fixture(), first = t.begin(); t.finish(first)
    expect(t.registry.dispatches.resume(t.task.id, { previousRunId: first.id, reason: 'authorization' }, 40)).toBe(true)
    const second = t.begin(50)
    expect(second.id).not.toBe(first.id)
    expect(t.registry.dispatches.resume(t.task.id, { previousRunId: first.id, reason: 'authorization' }, 51)).toBe(false)
    expect(t.registry.dispatches.resume(t.task.id, { previousRunId: second.id, reason: 'authorization' }, 52)).toBe(false)
    t.finish(second, 60)
    expect(t.registry.dispatches.resume(t.task.id, { previousRunId: first.id, reason: 'authorization' }, 61)).toBe(false)
    expect(t.registry.dispatches.resume(t.task.id, { previousRunId: second.id, reason: 'restart' }, 62)).toBe(true)
    expect(t.registry.dispatches.get(t.task.id)).toMatchObject({ generation: 2, resume: { previousRunId: second.id, resumedAt: 62 } })
  })

  it.each(['task_cancelled', 'stop_requested', 'work_cancelled', 'work_completed', 'manual_pause', 'authorization_pause', 'archived'])('does not revive %s', reason => {
    const t = fixture(), run = t.begin(); t.finish(run)
    if (reason === 'task_cancelled') t.registry.updateTask(t.task.id, { status: 'cancelled' })
    if (reason === 'stop_requested') t.registry.updateTask(t.task.id, { stopReason: 'user_requested' })
    if (reason === 'work_cancelled' || reason === 'work_completed') t.registry.workContexts.control(t.work.key,
      { action: reason === 'work_cancelled' ? 'cancel' : 'complete', causeRef: 'human-control' })
    if (reason === 'manual_pause' || reason === 'authorization_pause') t.registry.workContexts.control(t.work.key,
      { action: 'pause', reason: reason === 'manual_pause' ? 'manual' : 'authorization', causeRef: 'pause-ref' })
    if (reason === 'archived') t.registry.updateSession('session', { status: 'archived' })
    const before = t.registry.getTask(t.task.id)
    expect(t.registry.dispatches.resume(t.task.id, { previousRunId: run.id, reason: 'authorization' }, 40)).toBe(false)
    expect(t.registry.getTask(t.task.id)).toEqual(before)
    expect(t.registry.dispatches.get(t.task.id)?.generation).toBe(0)
    expect(t.registry.dispatches.pending()).toEqual([])
  })

  it('requires all pause causes to be cleared rather than letting OAuth clear unrelated human pauses', () => {
    const t = fixture(), run = t.begin(); t.finish(run)
    for (const reason of ['manual', 'authorization'] as const) t.registry.workContexts.control(t.work.key, { action: 'pause', reason, causeRef: reason })
    t.registry.workContexts.control(t.work.key, { action: 'resume', reason: 'authorization', causeRef: 'authorization' })
    expect(t.registry.dispatches.resume(t.task.id, { previousRunId: run.id, reason: 'authorization' }, 40)).toBe(false)
    t.registry.workContexts.control(t.work.key, { action: 'resume', reason: 'manual', causeRef: 'manual' })
    expect(t.registry.dispatches.resume(t.task.id, { previousRunId: run.id, reason: 'authorization' }, 41)).toBe(true)
  })

  it('preserves a stop committed to the Run even if an older task status callback has not caught up', () => {
    const t = fixture(), run = t.begin()
    t.attempts.requestStop(run.id, 'user_requested')
    t.finish(run)
    expect(t.attempts.get(run.id)).toMatchObject({ state: 'cancelled', stopReason: 'user_requested' })
    expect(t.registry.dispatches.resume(t.task.id, { previousRunId: run.id, reason: 'authorization' }, 40)).toBe(false)
    expect(t.registry.dispatches.pending()).toEqual([])
  })

  it.each(['unknown_run', 'different_task', 'no_receipt', 'no_inbound', 'different_actor', 'different_chat'])('rejects %s without manufacturing a request', reason => {
    const t = fixture(), run = t.begin(); t.finish(run)
    let previousRunId = run.id
    if (reason === 'unknown_run') previousRunId = 'not-a-run'
    if (reason === 'different_task') t.registry.db.prepare('UPDATE run_attempts SET task_id = NULL WHERE id = ?').run(run.id)
    if (reason === 'no_receipt') t.registry.db.prepare('DELETE FROM task_receipts WHERE task_id = ?').run(t.task.id)
    if (reason === 'no_inbound') t.registry.db.prepare('DELETE FROM task_dispatches WHERE task_id = ?').run(t.task.id)
    if (reason === 'different_actor' || reason === 'different_chat') t.registry.db.prepare('UPDATE task_dispatches SET inbound = ? WHERE task_id = ?')
      .run(JSON.stringify({ ...t.inbound, ...(reason === 'different_actor' ? { senderOpenId: 'bob' } : { chatId: 'other-chat' }) }), t.task.id)
    expect(t.registry.dispatches.resume(t.task.id, { previousRunId, reason: 'authorization' }, 40)).toBe(false)
    expect(t.registry.getTask(t.task.id)?.status).toBe('failed')
    expect(t.registry.dispatches.pending()).toEqual([])
  })

  it('rolls the generation and pending claim back if the task state write fails', () => {
    const t = fixture(), run = t.begin(); t.finish(run)
    t.registry.db.exec("CREATE TRIGGER fail_resume BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'synthetic disk fault'); END")
    expect(() => t.registry.dispatches.resume(t.task.id, { previousRunId: run.id, reason: 'restart' }, 40)).toThrow('synthetic disk fault')
    expect(t.registry.dispatches.get(t.task.id)).toMatchObject({ generation: 0, resume: null })
    expect(t.registry.getTask(t.task.id)?.status).toBe('failed')
    expect(t.registry.dispatches.pending()).toEqual([])
  })
})
