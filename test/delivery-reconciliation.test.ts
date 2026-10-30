import { describe, expect, it, vi } from 'vitest'
import { DeliveryError, DeliveryService, deliveryPayloadDigest, type DeliveryContext } from '../src/core/delivery.js'
import { DeliveryReconciliation } from '../src/core/delivery-reconciliation.js'
import { Registry } from '../src/core/registry.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const NOW = 1_800_000_000_000
const BOT = 'ou_bot'

/** The sending Run is gone: nothing here resolves a run context. Only the ledger row, current Space state and the platform remain. */
function setup() {
  const registry = new Registry(':memory:'), db = registry.db
  const sp = spaceDeps(db, { admins: [] })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'chat_a', openId: 'alice' })
  sp.spaces.addMember(group.id, 'member', 'member')
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'chat_dm', openId: 'alice' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  fake.members.set('chat_a', new Set(['alice', 'member']))
  let clock = NOW
  const service = new DeliveryService(db, {
    ...sp, now: () => clock, resolveContext: async () => context,
    send: async () => { if (sendFails) throw new Error('synthetic connection lost after POST accepted'); return { remoteId: 'om_sent' } },
  })
  let sendFails = false
  let context: DeliveryContext = { actorOpenId: 'alice', audience: { kind: 'group', spaceId: group.id, chatId: 'chat_a' },
    sources: [{ ref: 'trusted-a', spaceId: group.id, chatId: 'chat_a' }], provenanceComplete: true, expiresAt: NOW + 60_000 }
  const seed = async (key: string, payload: { text: string } | { markdown: string }, outcome: 'sent' | 'unknown') => {
    sendFails = outcome === 'unknown'
    await service.deliver({ key, contextRef: 'task:1:finished', payload }).catch(error => { if (!(error instanceof DeliveryError) || error.code !== 'unknown') throw error })
    sendFails = false
    return service.get(key)!
  }
  const reconciliation = new DeliveryReconciliation(db, { ...sp, feishu, botOpenId: BOT, now: () => clock })
  const viewer = (openId: string) => ({ openId, assertCurrent: () => undefined })
  const row = (key: string) => db.prepare('SELECT * FROM deliveries WHERE delivery_key = ?').get(key) as Record<string, unknown>
  return { db, sp, group, dm, fake, service, seed, reconciliation, viewer, row, setContext: (c: DeliveryContext) => { context = c }, advance: (ms: number) => { clock += ms } }
}

describe('DeliveryReconciliation: read-only receipt update without the original run', () => {
  it('confirms an acknowledged text delivery after reading back the same chat, app sender and content', async () => {
    const t = setup(), record = await t.seed('task:1:final', { text: 'RESULT_TEXT' }, 'sent')
    expect(record).toMatchObject({ status: 'sent', remoteId: 'om_sent' })
    t.fake.messages.set('om_sent', historyMsg({ messageId: 'om_sent', chatId: 'chat_a', senderType: 'app', senderOpenId: BOT, text: 'RESULT_TEXT' }))
    t.advance(5_000)
    const receipt = await t.reconciliation.reconcile(t.viewer('member'), 'task:1:final')
    expect(receipt).toMatchObject({ key: 'task:1:final', status: 'confirmed', remoteId: 'om_sent', result: 'confirmed', checkedAt: NOW + 5_000 })
    expect(t.service.get('task:1:final')).toMatchObject({ status: 'confirmed', remoteId: 'om_sent', error: null })
    expect(JSON.parse(String(t.row('task:1:final').reconciliation))).toMatchObject({ result: 'confirmed', viewerOpenId: 'member', checkedAt: NOW + 5_000 })
    expect(JSON.stringify(t.row('task:1:final'))).not.toContain('RESULT_TEXT')
  })

  it('keeps sent when the remote message exists but this payload type cannot be compared', async () => {
    const t = setup(); await t.seed('task:2:final', { markdown: '**RICH**' }, 'sent')
    t.fake.messages.set('om_sent', historyMsg({ messageId: 'om_sent', chatId: 'chat_a', senderType: 'app', senderOpenId: BOT, text: 'RICH' }))
    const receipt = await t.reconciliation.reconcile(t.viewer('alice'), 'task:2:final')
    expect(receipt).toMatchObject({ status: 'sent', remoteId: 'om_sent', result: 'acknowledged' })
    expect(t.service.get('task:2:final')?.status).toBe('sent')
    expect(JSON.parse(String(t.row('task:2:final').reconciliation))).toMatchObject({ result: 'acknowledged' })
  })

  it('records a mismatch, not a confirmation, when the acknowledged ID now lives in another chat or sender', async () => {
    const t = setup(); await t.seed('task:3:final', { text: 'RESULT_TEXT' }, 'sent')
    t.fake.messages.set('om_sent', historyMsg({ messageId: 'om_sent', chatId: 'chat_b', senderType: 'app', senderOpenId: BOT, text: 'RESULT_TEXT' }))
    expect(await t.reconciliation.reconcile(t.viewer('alice'), 'task:3:final')).toMatchObject({ status: 'sent', result: 'remote_mismatch' })
    t.fake.messages.set('om_sent', historyMsg({ messageId: 'om_sent', chatId: 'chat_a', senderType: 'user', senderOpenId: 'ou_someone', text: 'RESULT_TEXT' }))
    expect(await t.reconciliation.reconcile(t.viewer('alice'), 'task:3:final')).toMatchObject({ status: 'sent', result: 'remote_mismatch' })
    expect(t.service.get('task:3:final')?.status).toBe('sent')
  })

  it('finds an unacknowledged send in the chat window by content and records its remote ID', async () => {
    const t = setup(), record = await t.seed('task:4:final', { text: 'LOST_ACK_TEXT' }, 'unknown')
    expect(record).toMatchObject({ status: 'unknown', remoteId: null })
    t.fake.histories.set('chat_a', [
      historyMsg({ messageId: 'om_user', chatId: 'chat_a', senderType: 'user', senderOpenId: 'alice', text: 'LOST_ACK_TEXT', createTimeMs: NOW - 30_000 }),
      historyMsg({ messageId: 'om_found', chatId: 'chat_a', senderType: 'app', senderOpenId: BOT, text: 'LOST_ACK_TEXT', createTimeMs: NOW + 2_000 }),
    ])
    const receipt = await t.reconciliation.reconcile(t.viewer('alice'), 'task:4:final')
    expect(receipt).toMatchObject({ status: 'confirmed', remoteId: 'om_found', result: 'confirmed' })
    expect(t.service.get('task:4:final')).toMatchObject({ status: 'confirmed', remoteId: 'om_found', error: null })
  })

  it('proves absence only from a complete window with no app message, and stays unknown otherwise', async () => {
    const t = setup()
    await t.seed('task:5:final', { text: 'NEVER_SENT' }, 'unknown')
    t.fake.histories.set('chat_a', [historyMsg({ messageId: 'om_u', chatId: 'chat_a', senderType: 'user', text: 'chatter', createTimeMs: NOW + 1_000 })])
    expect(await t.reconciliation.reconcile(t.viewer('alice'), 'task:5:final')).toMatchObject({ status: 'unknown', remoteId: null, result: 'remote_absent' })
    expect(t.service.get('task:5:final')).toMatchObject({ status: 'unknown', error: 'verified_absent' })

    await t.seed('task:6:final', { markdown: '**CARD_LIKE**' }, 'unknown')
    t.fake.histories.set('chat_a', [historyMsg({ messageId: 'om_other', chatId: 'chat_a', senderType: 'app', senderOpenId: BOT, text: 'something else', createTimeMs: NOW + 1_000 })])
    expect(await t.reconciliation.reconcile(t.viewer('alice'), 'task:6:final')).toMatchObject({ status: 'unknown', remoteId: null, result: 'unverifiable' })
    expect(t.service.get('task:6:final')?.status).toBe('unknown')

    await t.seed('task:7:final', { text: 'TRUNCATED_WINDOW' }, 'unknown')
    t.fake.histories.set('chat_a', Array.from({ length: 260 }, (_, index) =>
      historyMsg({ messageId: `om_bulk_${index}`, chatId: 'chat_a', senderType: 'user', text: `bulk ${index}`, createTimeMs: NOW + index })))
    expect(await t.reconciliation.reconcile(t.viewer('alice'), 'task:7:final')).toMatchObject({ status: 'unknown', result: 'remote_absent_incomplete' })
    expect(t.service.get('task:7:final')?.error).not.toBe('verified_absent')
  })

  it('leaves the receipt untouched and never resends when the platform read fails', async () => {
    const t = setup(); await t.seed('task:8:final', { text: 'RESULT_TEXT' }, 'sent')
    vi.spyOn(t.fake, 'getMessage').mockRejectedValue(new Error('synthetic platform outage'))
    const before = t.row('task:8:final'), sentBefore = t.fake.sent.length
    expect(await t.reconciliation.reconcile(t.viewer('alice'), 'task:8:final')).toMatchObject({ status: 'sent', result: 'read_unavailable' })
    expect(t.row('task:8:final')).toEqual(before)
    expect(t.fake.sent).toHaveLength(sentBefore)
  })

  it('returns an already confirmed receipt without touching the platform and refuses a send still in progress', async () => {
    const t = setup(); await t.seed('task:9:final', { text: 'RESULT_TEXT' }, 'sent')
    t.fake.messages.set('om_sent', historyMsg({ messageId: 'om_sent', chatId: 'chat_a', senderType: 'app', senderOpenId: BOT, text: 'RESULT_TEXT' }))
    await t.reconciliation.reconcile(t.viewer('alice'), 'task:9:final')
    const get = vi.spyOn(t.fake, 'getMessage')
    expect(await t.reconciliation.reconcile(t.viewer('alice'), 'task:9:final')).toMatchObject({ status: 'confirmed', result: 'already_confirmed' })
    expect(get).not.toHaveBeenCalled()
    t.db.prepare("UPDATE deliveries SET status = 'planned' WHERE delivery_key = ?").run('task:9:final')
    await expect(t.reconciliation.reconcile(t.viewer('alice'), 'task:9:final')).rejects.toMatchObject({ code: 'unknown' })
  })

  it('authorizes the viewer from current Space state, not from the original run', async () => {
    const t = setup(); await t.seed('task:10:final', { text: 'RESULT_TEXT' }, 'sent')
    t.fake.messages.set('om_sent', historyMsg({ messageId: 'om_sent', chatId: 'chat_a', senderType: 'app', senderOpenId: BOT, text: 'RESULT_TEXT' }))
    await expect(t.reconciliation.reconcile(t.viewer('stranger'), 'task:10:final')).rejects.toMatchObject({ code: 'denied' })
    // A recorded role without fresh platform membership is not enough.
    t.fake.members.set('chat_a', new Set(['alice']))
    await expect(t.reconciliation.reconcile(t.viewer('member'), 'task:10:final')).rejects.toMatchObject({ code: 'unconfirmed' })
    // A rebound target chat invalidates the recorded audience for everyone.
    t.sp.spaces.rebind(t.group.id, 'chat_moved')
    await expect(t.reconciliation.reconcile(t.viewer('alice'), 'task:10:final')).rejects.toMatchObject({ code: 'denied' })
    expect(t.service.get('task:10:final')?.status).toBe('sent')
    await expect(t.reconciliation.reconcile(t.viewer('alice'), 'missing-key')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('lets only the recipient reconcile a DM delivery and reads the DM chat recorded on the Space', async () => {
    const t = setup()
    t.setContext({ actorOpenId: 'alice', audience: { kind: 'dm', spaceId: t.dm.id, openId: 'alice' },
      sources: [{ ref: 'trusted-dm', spaceId: t.dm.id, chatId: 'chat_dm' }], provenanceComplete: true, expiresAt: NOW + 60_000 })
    await t.seed('task:11:final', { text: 'DM_TEXT' }, 'unknown')
    t.fake.histories.set('chat_dm', [historyMsg({ messageId: 'om_dm', chatId: 'chat_dm', senderType: 'app', senderOpenId: BOT, text: 'DM_TEXT', createTimeMs: NOW + 1_000 })])
    await expect(t.reconciliation.reconcile(t.viewer('member'), 'task:11:final')).rejects.toMatchObject({ code: 'denied' })
    expect(await t.reconciliation.reconcile(t.viewer('alice'), 'task:11:final')).toMatchObject({ status: 'confirmed', remoteId: 'om_dm' })
  })

  it('does not overwrite a receipt that changed while the platform was being read', async () => {
    const t = setup(); await t.seed('task:12:final', { text: 'RESULT_TEXT' }, 'sent')
    vi.spyOn(t.fake, 'getMessage').mockImplementation(async () => {
      t.db.prepare("UPDATE deliveries SET status = 'unknown', remote_id = NULL, error = 'operator_reset', updated_at = updated_at + 1 WHERE delivery_key = ?").run('task:12:final')
      return historyMsg({ messageId: 'om_sent', chatId: 'chat_a', senderType: 'app', senderOpenId: BOT, text: 'RESULT_TEXT' })
    })
    await expect(t.reconciliation.reconcile(t.viewer('alice'), 'task:12:final')).rejects.toMatchObject({ code: 'conflict' })
    expect(t.service.get('task:12:final')).toMatchObject({ status: 'unknown', remoteId: null, error: 'operator_reset' })
  })

  it('stops when the viewer grant lapses during the platform read', async () => {
    const t = setup(); await t.seed('task:13:final', { text: 'RESULT_TEXT' }, 'sent')
    let current = true
    vi.spyOn(t.fake, 'getMessage').mockImplementation(async () => {
      current = false
      return historyMsg({ messageId: 'om_sent', chatId: 'chat_a', senderType: 'app', senderOpenId: BOT, text: 'RESULT_TEXT' })
    })
    await expect(t.reconciliation.reconcile({ openId: 'alice', assertCurrent: () => { if (!current) throw new DeliveryError('denied', 'VIEWER_GRANT_LAPSED') } }, 'task:13:final'))
      .rejects.toThrow('VIEWER_GRANT_LAPSED')
    expect(t.service.get('task:13:final')?.status).toBe('sent')
  })

  it('exposes the digest of a text payload the same way the ledger computed it', () => {
    expect(deliveryPayloadDigest({ text: 'RESULT_TEXT' })).toBe(deliveryPayloadDigest({ text: 'RESULT_TEXT' }))
    expect(deliveryPayloadDigest({ text: 'RESULT_TEXT' })).not.toBe(deliveryPayloadDigest({ markdown: 'RESULT_TEXT' }))
  })
})
