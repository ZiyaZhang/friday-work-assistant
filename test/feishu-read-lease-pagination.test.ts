import { describe, expect, it, vi } from 'vitest'
import { FeishuClient } from '../src/feishu/client.js'

function fixture(page: () => Promise<unknown>) {
  const list = vi.fn(page)
  const client = Object.assign(Object.create(FeishuClient.prototype) as FeishuClient, {
    client: { im: { v1: { message: { list }, chat: { list }, chatMembers: { get: list } } }, search: { v2: { message: { create: list } } } },
    nameCache: new Map(), chatListCache: new Map(), memberCache: new Map(),
  })
  return { client, list }
}
const calls = {
  history: (client: FeishuClient, current: () => void) => client.listChatHistory('oc_source', 1, 10, 500, 1, {}, current),
  thread: (client: FeishuClient, current: () => void) => client.listThread('omt_source', 500, {}, current),
  search: (client: FeishuClient, current: () => void) => client.searchMessageIds('SYNTHETIC', { query: 'Synthetic', limit: 500 }, current),
  chats: (client: FeishuClient, current: () => void) => client.listChats({}, { fresh: true, assertCurrent: current }),
  members: (client: FeishuClient, current: () => void) => client.chatMemberOpenIds('oc_source', { fresh: true, assertCurrent: current }),
}
describe('Feishu read pagination keeps the same caller lease', () => {
  it.each(Object.keys(calls) as (keyof typeof calls)[])('does not start another %s page after the awaited page invalidates the lease', async kind => {
    const expired = new Error('synthetic request ended'), state = { live: true }
    const t = fixture(async () => { state.live = false; return { code: 0, data: { has_more: true, page_token: 'next', items: [] } } })
    await expect(calls[kind](t.client, () => { if (!state.live) throw expired })).rejects.toBe(expired)
    expect(t.list).toHaveBeenCalledTimes(1)
  })
  it('preserves the original provider failure for a current request instead of relabelling it as lost authority', async () => {
    const network = new TypeError('synthetic network exception'), current = vi.fn()
    const t = fixture(async () => { throw network })
    await expect(calls.history(t.client, current)).rejects.toBe(network)
    expect(t.list).toHaveBeenCalledTimes(1)
  })
})
