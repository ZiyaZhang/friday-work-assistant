import { describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { TaskEvents, validTaskEventDispatch } from '../src/core/task-events.js'
import { RunAttempts } from '../src/core/run-attempts.js'

function setup(group = false) {
  const registry = new Registry(':memory:')
  registry.createSession({ sessionKey: 'origin', chatId: group ? 'group' : 'dm', chatType: group ? 'group' : 'p2p', requesterOpenId: 'alice', cwd: '/tmp' })
  registry.createSession({ sessionKey: 'review', chatId: 'dm', chatType: 'p2p', requesterOpenId: 'alice', cwd: '/tmp' })
  const inbound = { eventId: 'e', messageId: 'actual-message', senderType: 'user' as const, senderOpenId: 'alice', chatId: group ? 'group' : 'dm',
    chatType: group ? 'group' as const : 'p2p' as const, text: '会后把行动项发我确认', msgType: 'text', mentions: [], createTimeMs: 1 }
  const source = registry.createTaskOnce({ sessionKey: 'origin', messageId: inbound.messageId, requesterOpenId: 'alice', prompt: inbound.text, inbound }).task
  const events = new TaskEvents(registry), parent = registry.taskWork.get(source.id)!
  const input = { key: 'meeting:m1:ended:digest', kind: 'meeting_draft' as const, domainId: 'm1', sourceTaskId: source.id,
    targetSessionKey: group ? 'review' : 'origin', prompt: '根据已取得的会议事件准备待审稿' }
  return { registry, events, parent, source, input }
}

describe('host events use the existing Task/Work dispatch', () => {
  it('extends the previous event-kind constraint while preserving all existing origins across two migrations', () => {
    const t = setup(), admitted = t.events.admit(t.input)
    const before = t.registry.db.prepare('SELECT * FROM task_event_sources').all()
    const sql = String(t.registry.db.prepare("SELECT sql FROM sqlite_master WHERE name='task_event_sources'").get()!.sql)
    t.registry.db.exec('ALTER TABLE task_event_sources RENAME TO saved_events')
    t.registry.db.exec(sql.replace(",'github_ci'", ''))
    t.registry.db.exec('INSERT INTO task_event_sources SELECT * FROM saved_events; DROP TABLE saved_events')
    const upgraded = new TaskEvents(t.registry); new TaskEvents(t.registry)
    expect(t.registry.db.prepare('SELECT * FROM task_event_sources').all()).toEqual(before)
    expect(upgraded.get(admitted.task.id)?.kind).toBe('meeting_draft')
    const ci = upgraded.admit({ ...t.input, key: 'ci:change:head', kind: 'github_ci', domainId: 'followup' })
    expect(validTaskEventDispatch(t.registry.db, ci.task.id, t.registry.dispatches.get(ci.task.id)!.inbound)).toBe(true)
    t.registry.close()
  })
  it('keeps one event in the original DM work with an honest bot envelope', () => {
    const t = setup(), first = t.events.admit(t.input), again = t.events.admit(t.input)
    expect(first.created).toBe(true); expect(again).toMatchObject({ task: { id: first.task.id }, created: false })
    expect(t.registry.taskWork.get(first.task.id)).toEqual(t.parent)
    expect(t.registry.workContexts.inputs(t.parent.key).at(-1)?.kind).toBe('evidence')
    const inbound = t.registry.dispatches.get(first.task.id)!.inbound
    expect(inbound.senderType).toBe('bot'); expect(validTaskEventDispatch(t.registry.db, first.task.id, inbound)).toBe(true)
    t.registry.close()
  })
  it('derives a DM work from a group request while retaining its original stop authority', () => {
    const t = setup(true), { task } = t.events.admit(t.input), check = t.events.lease(task.id)!
    expect(t.registry.taskWork.get(task.id)?.key).not.toBe(t.parent.key)
    check()
    t.registry.workContexts.control(t.parent.key, { action: 'pause', reason: 'run_stop', causeRef: 'human-stop' })
    expect(check).toThrow('暂停')
    expect(validTaskEventDispatch(t.registry.db, task.id, t.registry.dispatches.get(task.id)!.inbound)).toBe(false)
    t.registry.close()
  })
  it.each(['cancel', 'complete'] as const)('does not revive a work that was %s before its event', action => {
    const t = setup(); t.registry.workContexts.control(t.parent.key, { action, causeRef: 'human-control' })
    expect(() => t.events.admit(t.input)).toThrow('已结束')
    expect(t.registry.listTasks('origin')).toHaveLength(1)
    t.registry.close()
  })
  it('restores a interrupted host Task through the same durable dispatch generation', () => {
    const t = setup(), { task } = t.events.admit(t.input), runs = new RunAttempts(t.registry.db)
    const run = runs.begin({ taskId: task.id, sessionKey: task.sessionKey, workKey: t.parent.key, actorOpenId: 'alice',
      triggerKey: `task:${task.id}`, stage: 'task', now: 2 }, () => t.registry.startTask(task.id, 2, task.sessionKey))!
    runs.interruptActive(3); t.registry.updateTask(task.id, { status: 'failed', finishedAt: 3 })
    expect(t.registry.dispatches.resume(task.id, { previousRunId: run.id, reason: 'restart' }, 4)).toBe(true)
    expect(t.registry.dispatches.get(task.id)).toMatchObject({ generation: 1, inbound: { senderType: 'bot', messageId: task.messageId } })
    t.registry.close()
  })
  it('cannot use a tampered parent envelope or a different recipient as a human delegation', () => {
    const t = setup(true)
    t.registry.createSession({ sessionKey: 'other', chatId: 'other-dm', chatType: 'p2p', requesterOpenId: 'bob', cwd: '/tmp' })
    expect(() => t.events.admit({ ...t.input, targetSessionKey: 'other' })).toThrow('本人受众')
    const { task } = t.events.admit(t.input)
    t.registry.db.prepare("UPDATE task_dispatches SET inbound=json_set(inbound,'$.messageId','forged') WHERE task_id=?").run(t.source.id)
    expect(validTaskEventDispatch(t.registry.db, task.id, t.registry.dispatches.get(task.id)!.inbound)).toBe(false)
    t.registry.close()
  })
})
