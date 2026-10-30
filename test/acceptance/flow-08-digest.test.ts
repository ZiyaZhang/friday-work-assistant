import { afterEach, describe, expect, it } from 'vitest'
import { routineDigestDeliveryKey, routineExecutionKey } from '../../src/core/execution-keys.js'
import { acceptanceHost, closeAll } from './host.js'

afterEach(closeAll)

/**
 * §11.8 简报：连续多日同一事项只报有意义变化，保留到期项；一屏可读，链接正确，缺来源不编排期。
 * Content quality is a model/product check; the host side verifies one digest per logical window, no duplicate for a
 * configuration edit, no automatic resend of an unacknowledged digest, and a manual re-run as its own request.
 */
describe('acceptance 08 · daily digest windows', () => {
  it('produces one digest per day window, does not repeat it after a configuration edit, and holds new windows behind an unknown send until a person has it checked', async () => {
    const t = await acceptanceHost()
    const created = t.clock.now
    const routine = t.routines.add({ kind: 'schedule', ownerOpenId: 'alice', spaceId: t.group.id, chatId: 'group', chatType: 'group', name: '每日简报',
      prompt: '总结昨天到今天的进展与到期事项', schedule: { type: 'daily', at: '18:00' } as never, now: created })
    const day1 = routine.nextRunAt
    const digests = () => t.fake.sent.filter(item => (item.kind === 'sendToChat' || item.kind === 'replyMarkdown' || item.kind === 'replyText') && JSON.stringify(item.payload).includes('DIGEST_'))
    // Day 1: the scheduler claims the window and the digest goes to the group exactly once.
    t.agent.state.script = [{ kind: 'text', text: 'DIGEST_DAY1：两项进展，一项周五到期。' }]
    t.clock.now = day1 + 1000
    expect(await t.tick()).toBe(1)
    const first = t.routines.getOccurrence(1)!
    expect(first).toMatchObject({ routineId: routine.id, status: 'ok', scheduledAt: day1, windowKey: new Date(day1).toISOString() })
    expect(digests()).toHaveLength(1)
    const firstKey = routineDigestDeliveryKey(routineExecutionKey(routine.id, { occurrenceId: first.id, configVersion: first.configVersion }))
    expect(t.db.prepare('SELECT status FROM deliveries WHERE delivery_key = ?').get(firstKey)).toEqual({ status: 'sent' })
    // A configuration-only edit (longer digest) within the same window neither reopens nor duplicates that window.
    expect(t.routines.update(routine.id, { prompt: '总结昨天到今天的进展与到期事项，写得更详细' } as never, t.clock.now)).toBeTruthy()
    expect(t.routines.claimDueOccurrence(routine.id, day1, t.clock.now)).toBeUndefined()
    expect(await t.tick()).toBe(0)
    expect(t.db.prepare('SELECT count(*) AS n FROM routine_occurrences WHERE routine_id = ?').get(routine.id)).toEqual({ n: 1 })
    expect(digests()).toHaveLength(1)
    // Day 2: the send fails before the platform recorded anything, so the result is unknown. Nothing is resent by itself and,
    // until a person has the original checked against the platform, the routine does not start another window either.
    const day2 = t.routines.get(routine.id)!.nextRunAt
    expect(day2).toBeGreaterThan(day1)
    const originalSend = t.fake.sendToChat.bind(t.fake), originalReply = t.fake.replyMarkdown.bind(t.fake)
    t.fake.sendToChat = async () => { throw new Error('synthetic lost acknowledgement') }
    t.fake.replyMarkdown = async () => { throw new Error('synthetic lost acknowledgement') }
    t.agent.state.script = [{ kind: 'text', text: 'DIGEST_DAY2：到期项仍未完成。' }]
    t.clock.now = day2 + 1000
    expect(await t.tick()).toBe(1)
    t.fake.sendToChat = originalSend; t.fake.replyMarkdown = originalReply
    const second = t.routines.getOccurrence(2)!
    const secondKey = routineDigestDeliveryKey(routineExecutionKey(routine.id, { occurrenceId: second.id, configVersion: second.configVersion }))
    expect(t.db.prepare('SELECT status, remote_id FROM deliveries WHERE delivery_key = ?').get(secondKey)).toEqual({ status: 'unknown', remote_id: null })
    expect(digests()).toHaveLength(1)
    t.agent.state.script = [{ kind: 'text', text: 'DIGEST_DAY3：无新变化。' }]
    t.clock.now = t.routines.get(routine.id)!.nextRunAt + 1000
    expect(await t.tick()).toBe(1)
    expect(t.routines.getOccurrence(3)).toMatchObject({ status: 'failed', error: expect.stringContaining('投递结果未知') })
    expect(digests()).toHaveLength(1)
    // The console shows the unresolved digest with a reconcile affordance; the person, not a retry loop, decides.
    const shownRoutine = async () => ((await t.queries.read(t.login('alice'), t.group.id, 'tasks')).body.data as { routines: { id: number; progress: { managed_delivery: { items: { key: string; status: string; can_reconcile: boolean }[] } } }[] })
      .routines.find(item => item.id === routine.id)!
    expect((await shownRoutine()).progress.managed_delivery.items).toContainEqual(expect.objectContaining({ key: secondKey, status: 'unknown', can_reconcile: true }))
    // The read-back finds no bot message in the send window: the digest provably never went out. It is marked verified absent,
    // not resent, and the routine may take its next window.
    t.fake.histories.set('group', [])
    const receipt = await t.commands.execute(t.login('alice'), t.group.id, { operation: 'delivery.reconcile', requestId: 'digest_reconcile_0001', key: secondKey })
    expect(receipt.body.appliedResult).toMatchObject({ result: 'remote_absent', state: 'unresolved' })
    expect(t.db.prepare('SELECT status, error FROM deliveries WHERE delivery_key = ?').get(secondKey)).toEqual({ status: 'unknown', error: 'verified_absent' })
    t.agent.state.script = [{ kind: 'text', text: 'DIGEST_DAY4：一项已完成。' }]
    t.clock.now = t.routines.get(routine.id)!.nextRunAt + 1000
    expect(await t.tick()).toBe(1)
    expect(t.routines.getOccurrence(4)?.status).toBe('ok')
    expect(digests().map(item => JSON.stringify(item.payload).match(/DIGEST_DAY\d/)![0])).toEqual(['DIGEST_DAY1', 'DIGEST_DAY4'])
    // A manual "run it again" is a separate request with its own identity, never a re-execution of a scheduled window.
    t.agent.state.script = [{ kind: 'text', text: 'DIGEST_MANUAL：按要求重发一份。' }]
    expect(await t.host.runRoutine(t.routines.get(routine.id)!, { manualMessageId: 'om_manual_rerun' })).toBe('ok')
    expect(t.db.prepare('SELECT count(*) AS n FROM routine_occurrences WHERE routine_id = ?').get(routine.id)).toEqual({ n: 4 })
    expect(t.db.prepare('SELECT status FROM deliveries WHERE delivery_key = ?').get(routineDigestDeliveryKey(routineExecutionKey(routine.id, { manualMessageId: 'om_manual_rerun' })))).toEqual({ status: 'sent' })
  })
})
