import { describe, expect, it, vi } from 'vitest'
import { FeishuClient } from '../src/feishu/client.js'

function fixture(responses: unknown[]) {
  const search = vi.fn(async () => responses.shift())
  return { search, client: Object.assign(Object.create(FeishuClient.prototype) as FeishuClient,
    { client: { im: { v1: { message: { search } } } } }) }
}
const page = (token?: string) => ({ code: 0, data: { items: [{ id: 'om_one', meta_data: { message_id: 'om_one', chat_id: 'oc_p2p', is_p2p_chat: true, position: 42 } }],
  has_more: Boolean(token), ...(token ? { page_token: token } : {}) } })

describe('personal search provider contract', () => {
  it('uses provider-accepted ISO seconds, retaining zero timestamps and exact continuation', async () => {
    const t = fixture([page('next')])
    const result = await t.client.findMessagesAsUserPage('SYNTHETIC_TOKEN', { chatType: 'p2p', startSec: 0, endSec: 100 }, { pageSize: 20, pageToken: 'before' })
    expect(t.search.mock.calls[0]?.[0]).toMatchObject({ params: { page_size: 20, page_token: 'before' },
      data: { filter: { chat_type: 'p2p', time_range: { start_time: '1970-01-01T00:00:00Z', end_time: '1970-01-01T00:01:40Z' } } } })
    expect(result).toMatchObject({ hasMore: true, nextPageToken: 'next', items: [{ messageId: 'om_one', chatId: 'oc_p2p', isP2p: true, messagePosition: '42' }] })
  })
  it.each([{ items: [], has_more: true }, { items: [], has_more: true, page_token: 'same' }, { items: [] }])('rejects incomplete or stalled pages', async data => {
    const t = fixture([{ code: 0, data }])
    await expect(t.client.findMessagesAsUserPage('SYNTHETIC', {}, { pageToken: 'same' })).rejects.toThrow('分页')
  })
  it('preserves legacy list results while stopping at the requested count', async () => {
    const t = fixture([page('next'), page()])
    expect(await t.client.findMessagesAsUser('SYNTHETIC', { limit: 2 })).toHaveLength(2)
    expect(t.search).toHaveBeenCalledTimes(2)
  })
  it('rejects a repeated continuation across multiple pages', async () => {
    const t = fixture([page('a'), page('b'), page('a')])
    await expect(t.client.findMessagesAsUser('SYNTHETIC', { limit: 10 })).rejects.toThrow('重复')
  })
  it('revalidates the grant after provider resolution', async () => {
    const t = fixture([page()]); let calls = 0
    await expect(t.client.findMessagesAsUserPage('SYNTHETIC', {}, {}, () => { if (++calls === 2) throw new Error('revoked') })).rejects.toThrow('revoked')
  })
})
