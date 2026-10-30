import { describe, expect, it, vi } from 'vitest'
import { FeishuApiError, FeishuClient } from '../src/feishu/client.js'

function adapter() {
  const list = vi.fn().mockRejectedValue(new Error('unexpected SDK request'))
  // Exercise the production pagination/cache methods, replacing only the SDK boundary.
  const client = Object.assign(Object.create(FeishuClient.prototype) as FeishuClient, {
    client: { im: { v1: { chat: { list } } } }, chatListCache: new Map(),
  })
  return { client, list }
}

const asUser = { userToken: 'SYNTHETIC_CHAT_ACCESS' }
const item = (id: string) => ({ chat_id: `oc_${id}`, name: `Synthetic ${id}` })
const page = (items: ReturnType<typeof item>[], hasMore: boolean, next?: string) =>
  ({ code: 0, data: { items, has_more: hasMore, ...(next ? { page_token: next } : {}) } })

describe('Feishu chat access completeness at the SDK boundary', () => {
  it('fresh reads every page and reports complete only at the final page', async () => {
    const t = adapter()
    t.list.mockResolvedValueOnce(page([item('a')], true, 'next-a'))
      .mockResolvedValueOnce(page([item('b')], false))
    expect(await t.client.listChatsResult(asUser, { fresh: true })).toEqual({
      items: [{ chatId: 'oc_a', name: 'Synthetic a' }, { chatId: 'oc_b', name: 'Synthetic b' }], complete: true,
    })
    expect(t.list.mock.calls.map(([request]) => request.params)).toEqual([
      { page_size: 100, page_token: undefined, sort_type: 'ByActiveTimeDesc' },
      { page_size: 100, page_token: 'next-a', sort_type: 'ByActiveTimeDesc' },
    ])
    expect(t.list.mock.calls.every(([, options]) => options !== undefined)).toBe(true)
  })

  it('stops at the 2000-chat cap without turning an unfinished listing into denied access', async () => {
    const t = adapter()
    for (let i = 0; i < 20; i++) {
      t.list.mockResolvedValueOnce(page(Array.from({ length: 100 }, (_, j) => item(`${i}-${j}`)), true, `next-${i}`))
    }
    const result = await t.client.listChatsResult(asUser, { fresh: true })
    expect(result.items).toHaveLength(2000)
    expect(result.complete).toBe(false)
    expect(result.items.at(-1)?.chatId).toBe('oc_19-99')
    expect(t.list).toHaveBeenCalledTimes(20)
  })

  it('keeps has_more without a continuation token incomplete', async () => {
    const t = adapter()
    t.list.mockResolvedValueOnce(page([item('a')], true))
    expect(await t.client.listChatsResult(asUser, { fresh: true })).toEqual({
      items: [{ chatId: 'oc_a', name: 'Synthetic a' }], complete: false,
    })
    expect(t.list).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('preserves cached completeness=%s through the result and legacy wrappers', async complete => {
    const t = adapter()
    t.list.mockResolvedValueOnce(page([item('cached')], !complete))
    const first = await t.client.listChatsResult(asUser, { fresh: true })
    expect(first.complete).toBe(complete)
    expect(await t.client.listChatsResult(asUser)).toEqual(first)
    expect(await t.client.listChats(asUser)).toEqual(first.items)
    expect(t.list).toHaveBeenCalledTimes(1)
  })

  it('fresh bypasses a complete cache and replaces its items and completeness', async () => {
    const t = adapter()
    t.list.mockResolvedValueOnce(page([item('old')], false))
      .mockResolvedValueOnce(page([item('new')], true))
    expect((await t.client.listChatsResult(asUser)).complete).toBe(true)
    const refreshed = await t.client.listChatsResult(asUser, { fresh: true })
    expect(refreshed).toEqual({ items: [{ chatId: 'oc_new', name: 'Synthetic new' }], complete: false })
    expect(await t.client.listChatsResult(asUser)).toEqual(refreshed)
    expect(t.list).toHaveBeenCalledTimes(2)
  })

  it.each(['api', 'transport'] as const)('propagates a second-page %s error instead of caching a complete empty or partial listing', async kind => {
    const t = adapter()
    const failure = new Error('synthetic transport failure')
    t.list.mockResolvedValueOnce(page([item('partial')], true, 'next'))
    if (kind === 'api') t.list.mockResolvedValueOnce({ code: 123456, msg: 'synthetic API failure' })
    else t.list.mockRejectedValueOnce(failure)
    const request = t.client.listChatsResult(asUser, { fresh: true })
    if (kind === 'api') await expect(request).rejects.toBeInstanceOf(FeishuApiError)
    else await expect(request).rejects.toBe(failure)

    // A normal retry must reach the SDK; no incomplete response was cached as a success.
    t.list.mockResolvedValueOnce(page([item('recovered')], false))
    expect(await t.client.listChatsResult(asUser)).toEqual({
      items: [{ chatId: 'oc_recovered', name: 'Synthetic recovered' }], complete: true,
    })
    expect(t.list).toHaveBeenCalledTimes(3)
  })

  it('does not claim an unacknowledged final page is complete', async () => {
    const t = adapter()
    t.list.mockResolvedValueOnce({ code: 0, data: { items: [item('unverified-end')] } })
    expect((await t.client.listChatsResult(asUser, { fresh: true })).complete).toBe(false)
    expect(t.list).toHaveBeenCalledTimes(1)
  })

  it('rejects missing/malformed items instead of proving a complete empty list; a real empty array remains complete', async () => {
    for (const response of [{ code: 0 }, { code: 0, data: { has_more: false } },
      { code: 0, data: { items: {}, has_more: false } }, { code: 0, data: { items: [null], has_more: false } },
      { code: 0, data: { items: [{}], has_more: false } }]) {
      const t = adapter()
      t.list.mockResolvedValueOnce(response).mockResolvedValueOnce(page([], false))
      await expect(t.client.listChatsResult(asUser, { fresh: true })).rejects.toThrow('chat.list 返回的群列表无效')
      expect(await t.client.listChatsResult(asUser)).toEqual({ items: [], complete: true })
      expect(t.list).toHaveBeenCalledTimes(2)
    }
  })
})
