import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RoutineStore, type Routine } from '../src/core/routines.js'
import { routineProgress } from '../src/core/routine-application.js'
import { routineExecutionKey, routineDigestDeliveryKey, taskDeliveryContextRef } from '../src/core/execution-keys.js'
import { DeliveryService, type DeliveryPayload } from '../src/core/delivery.js'
import { spaceDeps } from './helpers/space.js'

const NOW = 1_800_000_000_000
const registries: Registry[] = []
afterEach(() => { for (const registry of registries.splice(0)) registry.close() })

function setup(kind: Routine['kind'] = 'schedule') {
  const registry = new Registry(':memory:')
  registries.push(registry)
  const store = new RoutineStore(registry.db)
  const sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'oc_progress', openId: 'ou_owner' })
  registry.createSession({ sessionKey: 'shared-session', chatId: space.chatId!, chatType: 'group', requesterOpenId: 'ou_owner', cwd: '/synthetic' })
  const routine = store.add({ kind, ownerOpenId: 'ou_owner', runAs: 'ou_owner', spaceId: space.id, chatId: space.chatId!, chatType: 'group',
    name: '合成职责', prompt: '合成指令', schedule: { type: 'once', atMs: NOW + 1000 }, ...(kind === 'followup' ? { sessionKey: 'shared-session' } : {}), now: NOW })
  let posts = 0
  const service = (options: { send?: () => Promise<{ remoteId: string }>; verify?: boolean } = {}) => new DeliveryService<DeliveryPayload>(registry.db, {
    ...sp, now: () => NOW,
    resolveContext: async () => ({ actorOpenId: 'ou_owner', audience: { kind: 'group', spaceId: space.id, chatId: space.chatId! },
      sources: [{ ref: 'synthetic-source', spaceId: space.id, chatId: space.chatId }], provenanceComplete: true, expiresAt: NOW + 60_000 }),
    send: async () => { posts++; return options.send ? options.send() : { remoteId: `om_remote_${posts}` } },
    ...(options.verify ? { verify: async () => true } : {}),
  })
  const read = () => {
    const before = registry.db.prepare('SELECT total_changes() AS writes').get()
    const result = routineProgress(store, store.get(routine.id)!, registry.db)
    expect(registry.db.prepare('SELECT total_changes() AS writes').get()).toEqual(before)
    return result
  }
  const start = () => {
    const occurrence = store.claimDueOccurrence(routine.id, routine.nextRunAt, routine.nextRunAt)!
    store.startOccurrence(occurrence.id, routine.nextRunAt)
    const key = routineExecutionKey(routine.id, { occurrenceId: occurrence.id, configVersion: occurrence.configVersion })
    return { occurrence, key }
  }
  return { registry, store, routine, service, read, start, posts: () => posts }
}

describe('routine progress reads exact managed delivery history without side effects', () => {
  it('does not create a ledger or infer non-delivery from absent execution records', () => {
    const t = setup()
    t.store.setEnabled(t.routine.id, false, NOW)
    const progress = t.read()
    expect(progress).toMatchObject({ last_status: null, next_run_at: null, latest_occurrence: null,
      managed_delivery: { coverage: 'gateway_messages_only', record_status: 'not_recorded', items: [] } })
    expect(t.registry.db.prepare("SELECT 1 FROM sqlite_master WHERE name='deliveries'").get()).toBeUndefined()
    expect(progress.fact_summary).toContain('暂无调度执行记录')
    expect(progress.fact_summary).toContain('不能据此认定未发送')
  })

  it('keeps interrupted execution unknown when the ledger did not exist', () => {
    const t = setup()
    t.start()
    t.store.recoverInterruptedOccurrences(NOW + 2000)
    expect(t.read()).toMatchObject({ last_status: null, can_resume_execution: false, recovery: 'inspect_previous_run',
      latest_occurrence: { status: 'interrupted' }, managed_delivery: { record_status: 'not_recorded' } })
    expect(t.read().next_step).toContain('结果未明时不要补发')
    expect(t.posts()).toBe(0)
  })

  it('reports an actual send ACK even when the occurrence later recovers as interrupted', async () => {
    const t = setup(), { occurrence, key } = t.start()
    await t.service().deliver({ key: routineDigestDeliveryKey(key), contextRef: key, payload: { text: '合成结果' } })
    t.store.recoverInterruptedOccurrences(NOW + 2000)
    const progress = t.read()
    expect(progress).toMatchObject({ last_status: null, latest_occurrence: { id: occurrence.id, status: 'interrupted', window_key: new Date(NOW + 1000).toISOString() },
      managed_delivery: { record_status: 'recorded', items: [{ kind: 'summary', status: 'sent', remote_id: 'om_remote_1' }] } })
    expect(progress.fact_summary).toContain('已获平台发送回执')
    expect(progress.managed_delivery.summary).toContain('不证明用户已读、任务完成')
    expect(t.posts()).toBe(1)
  })

  it('observes a pending POST without resolving or replaying it', async () => {
    const t = setup(), { key } = t.start()
    let release!: (value: { remoteId: string }) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const sent = t.service({ send: () => { entered(); return new Promise(resolve => { release = resolve }) } })
      .deliver({ key: routineDigestDeliveryKey(key), contextRef: key, payload: { text: '等待 ACK' } })
    await started
    expect(t.read().managed_delivery.items).toEqual([{ kind: 'summary', key: routineDigestDeliveryKey(key), status: 'planned', remote_id: null, can_reconcile: false, reconciliation: null }])
    expect(t.read().next_step).toContain('结果未明时不要补发')
    expect(t.posts()).toBe(1)
    release({ remoteId: 'om_late_ack' })
    await sent
    expect(t.read().managed_delivery.items[0]).toMatchObject({ status: 'sent', remote_id: 'om_late_ack' })
  })

  it('does not retry an unknown delivery or turn absent remoteId into a failed-send claim', async () => {
    const t = setup(), { key } = t.start()
    await expect(t.service({ send: async () => { throw new Error('synthetic ACK lost') } })
      .deliver({ key: routineDigestDeliveryKey(key), contextRef: key, payload: { text: '可能已经发出' } })).rejects.toMatchObject({ code: 'unknown' })
    expect(t.read().managed_delivery.items).toEqual([{ kind: 'summary', key: routineDigestDeliveryKey(key), status: 'unknown', remote_id: null, can_reconcile: true, reconciliation: null }])
    expect(t.read().fact_summary).toContain('发送结果未知')
    expect(t.posts()).toBe(1)
  })

  it('keeps successful file and uncertain note distinct instead of collapsing partial delivery', async () => {
    const t = setup(), { key } = t.start()
    const fileKey = `${key}:tool:here:file:${'a'.repeat(64)}`
    await t.service({ verify: true }).deliver({ key: fileKey, contextRef: `${key}:tool:here`,
      payload: { file: { name: 'synthetic.txt', sha256: 'a'.repeat(64), size: 4 } } })
    await expect(t.service({ send: async () => { throw new Error('note ACK lost') } }).deliver({
      key: `${fileKey}:note:${'b'.repeat(64)}`, contextRef: `${key}:tool:here`, payload: { text: '附言' },
    })).rejects.toMatchObject({ code: 'unknown' })
    expect(t.read().managed_delivery.items).toEqual([
      { kind: 'file', key: fileKey, status: 'confirmed', remote_id: 'om_remote_1', can_reconcile: false, reconciliation: null },
      { kind: 'note', key: `${fileKey}:note:${'b'.repeat(64)}`, status: 'unknown', remote_id: null, can_reconcile: true, reconciliation: null },
    ])
    expect(t.read().next_step).toContain('先核对')
  })

  it('uses the occurrence configVersion after rescheduling, never the latest routine version', async () => {
    const t = setup(), { occurrence, key } = t.start()
    const service = t.service()
    await service.deliver({ key: routineDigestDeliveryKey(key), contextRef: key, payload: { text: '真实原执行' } })
    t.store.finishOccurrence(occurrence.id, 'ok', NOW + 2000)
    t.store.update(t.routine.id, { schedule: { type: 'once', atMs: NOW + 90_000 } }, NOW + 3000)
    const unrelated = routineExecutionKey(t.routine.id, { occurrenceId: occurrence.id, configVersion: t.store.configVersion(t.routine.id)! })
    await service.deliver({ key: routineDigestDeliveryKey(unrelated), contextRef: unrelated, payload: { text: '不能混入的新版本记录' } })
    expect(t.read()).toMatchObject({ can_resume_execution: true, managed_delivery: { items: [{ status: 'sent', remote_id: 'om_remote_1' }] } })
  })

  it('follows the exact followup task receipt and excludes other work in the same session', async () => {
    const t = setup('followup'), { key } = t.start()
    const task = t.registry.createTaskOnce({ sessionKey: 'shared-session', messageId: 'om_same_root', requesterOpenId: 'ou_owner', prompt: '真实跟进' }, key).task
    const other = t.registry.createTaskOnce({ sessionKey: 'shared-session', messageId: 'om_other', requesterOpenId: 'ou_owner', prompt: '另一个工作' }).task
    const service = t.service()
    const ref = taskDeliveryContextRef(task.id, task.sessionKey)
    await service.deliver({ key: `task:${task.id}:final:0`, contextRef: ref, payload: { text: '跟进结果' } })
    await service.deliver({ key: `task:${other.id}:final:0`, contextRef: taskDeliveryContextRef(other.id, other.sessionKey), payload: { text: '不可串进本次结果' } })
    await service.deliver({ key: `task:${task.id}:tool:dm:message:${'c'.repeat(64)}`, contextRef: `${ref}:tool:dm`, payload: { text: '跟进工具结果' } })
    expect(t.read().managed_delivery.items).toEqual([
      { kind: 'summary', key: `task:${task.id}:final:0`, status: 'sent', remote_id: 'om_remote_1', can_reconcile: true, reconciliation: null },
      { kind: 'message', key: `task:${task.id}:tool:dm:message:${'c'.repeat(64)}`, status: 'sent', remote_id: 'om_remote_3', can_reconcile: true, reconciliation: null },
    ])
  })

  it('reads a followup that used the fresh-run fallback without creating a synthetic task association', async () => {
    const t = setup('followup'), { key } = t.start()
    await t.service().deliver({ key: routineDigestDeliveryKey(key), contextRef: key, payload: { text: '原会话归档后的结果' } })
    expect(t.read().managed_delivery.items).toEqual([{ kind: 'summary', key: routineDigestDeliveryKey(key), status: 'sent', remote_id: 'om_remote_1', can_reconcile: true, reconciliation: null }])
    expect(t.registry.db.prepare('SELECT * FROM task_receipts').all()).toHaveLength(0)
  })
})
