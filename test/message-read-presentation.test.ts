import { DatabaseSync } from 'node:sqlite'
import { AxiosError } from 'axios'
import { describe, expect, it, vi } from 'vitest'
import { MessageCache } from '../src/core/message-cache.js'
import { prepareMessageReadPresentation } from '../src/core/message-read-presentation.js'
import { captureMessageRead } from '../src/core/message-read-context.js'
import { verifyConversationMessages } from '../src/core/conversation-read-source.js'
import { FeishuApiError } from '../src/feishu/client.js'
import { messageSourceLink } from '../src/feishu/message-links.js'
import { historyMsg } from './helpers/fake-feishu.js'

const message = (id = 'om_source') => historyMsg({ messageId: id, chatId: 'oc_source', senderOpenId: 'ou_author',
  senderName: 'Author', text: 'Synthetic original', createTimeMs: 1_790_000_000_000 })
function setup() {
  const db = new DatabaseSync(':memory:'), cache = new MessageCache(db), as = { userToken: 'synthetic' }
  const getMessage = vi.fn(async (id: string) => ({ ...message(id), messagePosition: '42' }))
  const assertCurrent = vi.fn()
  return { db, cache, as, getMessage, assertCurrent, opts: { cache, as, feishu: { getMessage }, assertCurrent } }
}

describe('message source location presentation', () => {
  it('migrates old cache bodies additively and preserves platform positions through every cache reader', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE messages (message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, create_time INTEGER NOT NULL,
      msg_type TEXT NOT NULL, sender_name TEXT NOT NULL, sender_open_id TEXT, sender_type TEXT NOT NULL, text TEXT NOT NULL,
      thread_id TEXT, root_id TEXT, parent_id TEXT, file_key TEXT, file_name TEXT, image_key TEXT, cached_at INTEGER NOT NULL);
      INSERT INTO messages VALUES ('om_old','oc_source',1,'text','Author','ou_author','user','Old body',NULL,NULL,NULL,NULL,NULL,NULL,2)`)
    const cache = new MessageCache(db)
    expect(cache.get('om_old')?.text).toBe('Old body')
    const linked = { ...message(), messagePosition: '9007199254740993', threadId: 'omt_source', threadMessagePosition: '-1',
      messageAppLink: 'https://applink.feishu.cn/client/message/link/open?token=synthetic', fileKey: 'file', fileName: 'report.txt' }
    cache.upsert('oc_source', [linked]); cache.upsert('oc_source', [message()])
    for (const read of [cache.get(linked.messageId), cache.search({ chatIds: ['oc_source'], query: 'Synthetic' })[0], cache.files(['oc_source'])[0]]) {
      expect(read).toMatchObject({ messagePosition: linked.messagePosition, threadMessagePosition: '-1', messageAppLink: linked.messageAppLink })
    }
    expect(() => new MessageCache(db)).not.toThrow()
    db.close()
  })

  it('uses trusted existing locations without an extra GET and does not mutate original inputs', async () => {
    const t = setup(), item = { ...message(), messagePosition: '9' }, before = structuredClone(item)
    const result = await prepareMessageReadPresentation([item], t.opts)
    expect(result.items[0]?.sourceLink).toEqual({ status: 'available', url: messageSourceLink(item) })
    expect(t.getMessage).not.toHaveBeenCalled()
    expect(item).toEqual(before)
    t.db.close()
  })

  it('repairs an old covered row via one exact GET, keeping the old body and original source digest', async () => {
    const t = setup(), item = message()
    t.cache.upsert('oc_source', [item]); t.cache.markCovered('oc_source', 1, 2)
    const original = t.cache.get(item.messageId)!
    const receipt = captureMessageRead({ as: t.as, appId: 'app-reader', assertCurrent: t.assertCurrent,
      user: { as: t.as, authority: { appId: 'app-reader', tenantId: 'tenant', openId: 'ou_reader' },
        capture: { status: 'denied', reason: 'scope_missing' }, assertCurrent: t.assertCurrent } }, [original], 'partial', () => undefined, 1)
    const result = await prepareMessageReadPresentation([original, original], t.opts)
    expect(t.getMessage).toHaveBeenCalledExactlyOnceWith(item.messageId, t.as)
    expect(result.items.every(item => item.sourceLink.status === 'available')).toBe(true)
    expect(original).not.toHaveProperty('sourceLink')
    expect(receipt.conversationReads!.items[0]).not.toHaveProperty('sourceLink')
    expect(await verifyConversationMessages(receipt.conversationReads, 'oc_source', { appId: 'app-reader', openId: 'ou_reader',
      tenantId: 'tenant', as: t.as, feishu: { getMessage: t.getMessage }, assertCurrent: t.assertCurrent })).toBeUndefined()
    t.getMessage.mockClear()
    await prepareMessageReadPresentation([original], t.opts)
    expect(t.getMessage).not.toHaveBeenCalled()
    expect(t.cache.coverage('oc_source')).toEqual([{ startSec: 1, endSec: 2 }])
    expect(t.cache.get(item.messageId)?.text).toBe(item.text)
    t.db.close()
  })

  it('enriches only location metadata when the fresh GET body has changed', async () => {
    const t = setup(), item = message()
    t.cache.upsert('oc_source', [item])
    t.getMessage.mockResolvedValue({ ...item, text: 'New body', senderName: 'New name', messagePosition: '42' })
    const result = await prepareMessageReadPresentation([item], t.opts)
    expect(result.items[0]?.text).toBe('Synthetic original')
    expect(t.cache.get(item.messageId)?.text).toBe('Synthetic original')
    expect(t.cache.get(item.messageId)?.senderName).toBe('Author')
    t.db.close()
  })

  it.each(['wrong-chat', 'wrong-id'] as const)('does not attach unrelated %s location evidence', async mismatch => {
    const t = setup(), item = message()
    t.cache.upsert('oc_source', [item])
    t.getMessage.mockResolvedValue({ ...item, messagePosition: '42', ...(mismatch === 'wrong-chat' ? { chatId: 'oc_other' } : { messageId: 'om_other' }) })
    const result = await prepareMessageReadPresentation([item], t.opts)
    expect(result.items[0]?.sourceLink).toEqual({ status: 'unavailable', reason: 'identity_mismatch' })
    expect(t.cache.get(item.messageId)?.messagePosition).toBeUndefined()
    t.db.close()
  })

  it('never invents a location from the open message ID', async () => {
    const t = setup(), item = message()
    t.getMessage.mockResolvedValue(item as never)
    const result = await prepareMessageReadPresentation([item], t.opts)
    expect(result.items[0]?.sourceLink).toEqual({ status: 'unavailable', reason: 'missing_location' })
    t.db.close()
  })

  it('reuses a same-request exact GET with missing location instead of repeating it', async () => {
    const t = setup(), item = message()
    const result = await prepareMessageReadPresentation([item], { ...t.opts, fetchedMessages: [item] })
    expect(result.items[0]?.sourceLink).toEqual({ status: 'unavailable', reason: 'missing_location' })
    expect(t.getMessage).not.toHaveBeenCalled()
    expect(result.linkCoverage.lookups).toBe(0)
    t.db.close()
  })

  it('bounds legacy GET work while keeping every output item and cached link', async () => {
    const t = setup(), items = Array.from({ length: 300 }, (_, i) => message(`om_${i}`))
    const result = await prepareMessageReadPresentation([...items, { ...message('om_linked'), messagePosition: '7' }], t.opts)
    expect(t.getMessage).toHaveBeenCalledTimes(20)
    expect(result.items).toHaveLength(301)
    expect(result.linkCoverage).toEqual({ lookupBudget: 20, lookups: 20, available: 21, unavailable: 280, deferred: 280 })
    expect(result.items.at(-1)?.sourceLink.status).toBe('available')
    t.db.close()
  })

  it('leaves admitted bodies available on a typed network outage without claiming a link', async () => {
    const t = setup()
    t.getMessage.mockRejectedValue(new AxiosError('synthetic outage', 'ERR_NETWORK'))
    const result = await prepareMessageReadPresentation([message()], t.opts)
    expect(result.items[0]?.sourceLink).toEqual({ status: 'unavailable', reason: 'lookup_failed' })
    expect(result.items[0]?.text).toBe('Synthetic original')
    t.db.close()
  })

  it.each([new FeishuApiError('message.get', 99991677, 'expired'), new FeishuApiError('message.get', 230050, 'forbidden'), new TypeError('synthetic bug')])(
    'propagates permission failures and programmer errors', async error => {
      const t = setup(); t.getMessage.mockRejectedValue(error)
      await expect(prepareMessageReadPresentation([message()], t.opts)).rejects.toBe(error)
      t.db.close()
    })

  it('rejects a lookup completed after lease revocation before persisting or presenting the location', async () => {
    const t = setup(); t.cache.upsert('oc_source', [message()])
    t.getMessage.mockImplementation(async id => { t.assertCurrent.mockImplementation(() => { throw new Error('revoked') }); return { ...message(id), messagePosition: '42' } })
    await expect(prepareMessageReadPresentation([message()], t.opts)).rejects.toThrow('revoked')
    expect(t.cache.get('om_source')?.messagePosition).toBeUndefined()
    t.db.close()
  })
})
