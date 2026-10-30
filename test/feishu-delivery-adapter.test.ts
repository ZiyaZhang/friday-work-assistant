import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { DeliveryService } from '../src/core/delivery.js'
import { FeishuApiError, FeishuClient } from '../src/feishu/client.js'
import { postContent } from '../src/feishu/post.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'

const MARKDOWN = '**合成结果**\n[合成证据](https://example.invalid/evidence)'
const ACK = { code: 0, data: { message_id: 'om_synthetic', thread_id: 'omt_synthetic' } }
const routes = [
  {
    name: 'replyMarkdown', endpoint: 'reply',
    send: (client: FeishuClient) => client.replyMarkdown('om_root', MARKDOWN, false),
    routing: { path: { message_id: 'om_root' }, data: { reply_in_thread: false } },
    result: { messageId: 'om_synthetic', threadId: 'omt_synthetic' },
  },
  {
    name: 'sendToChat', endpoint: 'create',
    send: (client: FeishuClient) => client.sendToChat('oc_synthetic', { markdown: MARKDOWN }),
    routing: { params: { receive_id_type: 'chat_id' }, data: { receive_id: 'oc_synthetic' } },
    result: 'om_synthetic',
  },
  {
    name: 'sendToUser', endpoint: 'create',
    send: (client: FeishuClient) => client.sendToUser('ou_synthetic', { markdown: MARKDOWN }),
    routing: { params: { receive_id_type: 'open_id' }, data: { receive_id: 'ou_synthetic' } },
    result: 'om_synthetic',
  },
] as const

function adapter() {
  const reply = vi.fn().mockResolvedValue(ACK)
  const create = vi.fn().mockResolvedValue(ACK)
  // Stub only the SDK boundary; exercise production payload encoding and send methods.
  // No real credentials, HTTP client or network connection are constructed.
  const client = Object.assign(Object.create(FeishuClient.prototype) as FeishuClient, {
    client: { im: { v1: { message: { reply, create } } } },
    log: createLogger('synthetic-delivery-adapter', 'error'),
  })
  return { client, reply, create }
}

const unknownResults = [
  { name: 'timeout', error: () => Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' }) },
  { name: 'ACK lost after remote acceptance', error: () => Object.assign(new Error('synthetic accepted message lost its ACK'), { code: 'ECONNRESET' }) },
  ...[500, 502, 503].map((status) => ({ name: `HTTP ${status}`, error: () => Object.assign(new Error(`synthetic HTTP ${status}`), { response: { status } }) })),
]

describe('native mentions at the real Feishu adapter', () => {
  const body = '<at open_id="ou_owner">负责人</at> 已记到 [Issue](https://example.invalid/1)。<at open_id="ou_outside">群外人</at>'
  const content = (mock: ReturnType<typeof vi.fn>) => JSON.parse(mock.mock.calls[0]![0].data.content) as { zh_cn: { content: { tag: string; user_id?: string; text?: string }[][] } }

  it('uses only fresh members of the actual reply chat, encoding native at nodes', async () => {
    const t = adapter()
    t.client.getMessage = vi.fn().mockResolvedValue({ messageId: 'om_root', chatId: 'oc_actual' })
    t.client.chatMemberOpenIds = vi.fn().mockResolvedValue(new Set(['ou_owner']))
    await t.client.replyMarkdown('om_root', body)
    expect(t.client.getMessage).toHaveBeenCalledWith('om_root')
    expect(t.client.chatMemberOpenIds).toHaveBeenCalledWith('oc_actual', { fresh: true })
    const nodes = content(t.reply).zh_cn.content.flat()
    expect(nodes.filter((n) => n.tag === 'at')).toEqual([{ tag: 'at', user_id: 'ou_owner' }])
    expect(nodes.map((n) => n.text).join('')).toContain('群外人（未通知）')
    expect(t.reply).toHaveBeenCalledTimes(1)
  })

  it.each(['missing-message', 'member-error'])('sends readable text without mentions when verification fails: %s', async (reason) => {
    const t = adapter()
    t.client.getMessage = vi.fn().mockResolvedValue(reason === 'missing-message' ? undefined : { chatId: 'oc_actual' })
    t.client.chatMemberOpenIds = vi.fn().mockRejectedValue(new Error('synthetic unavailable'))
    await t.client.replyMarkdown('om_root', body)
    expect(content(t.reply).zh_cn.content.flat().every((n) => n.tag === 'md')).toBe(true)
    expect(t.reply).toHaveBeenCalledTimes(1)
  })

  it('uses a ledger-prepared allowlist synchronously without a second network await', async () => {
    const t = adapter()
    t.client.getMessage = vi.fn().mockRejectedValue(new Error('must not be called'))
    t.client.chatMemberOpenIds = vi.fn().mockRejectedValue(new Error('must not be called'))
    const sent = t.client.replyMarkdown('om_root', body, false, { mentionOpenIds: ['ou_owner'] })
    expect(t.reply).toHaveBeenCalledTimes(1) // SDK call already started before yielding.
    await sent
    expect(t.client.getMessage).not.toHaveBeenCalled()
    expect(t.client.chatMemberOpenIds).not.toHaveBeenCalled()
    expect(content(t.reply).zh_cn.content.flat().filter((n) => n.tag === 'at')).toEqual([{ tag: 'at', user_id: 'ou_owner' }])
  })

  it('keeps a DM mention restricted to its recipient and does not fetch group members', async () => {
    const t = adapter()
    t.client.chatMemberOpenIds = vi.fn()
    await t.client.sendToUser('ou_owner', { markdown: body })
    expect(content(t.create).zh_cn.content.flat().filter((n) => n.tag === 'at')).toEqual([{ tag: 'at', user_id: 'ou_owner' }])
    expect(t.client.chatMemberOpenIds).not.toHaveBeenCalled()
  })

  it('does not carry a group mention allowlist into a direct-message recipient', async () => {
    const t = adapter()
    await t.client.sendToUser('ou_owner', { markdown: body }, { mentionOpenIds: ['ou_owner', 'ou_outside'] })
    expect(content(t.create).zh_cn.content.flat().filter((n) => n.tag === 'at')).toEqual([{ tag: 'at', user_id: 'ou_owner' }])
  })

  it('does not add membership queries for ordinary Markdown', async () => {
    const t = adapter()
    t.client.getMessage = vi.fn()
    t.client.chatMemberOpenIds = vi.fn()
    await t.client.replyMarkdown('om_root', MARKDOWN)
    await t.client.sendToChat('oc_actual', { markdown: MARKDOWN })
    expect(t.client.getMessage).not.toHaveBeenCalled()
    expect(t.client.chatMemberOpenIds).not.toHaveBeenCalled()
  })
})

describe.each(routes)('Feishu delivery adapter $name', (route) => {
  it.each(unknownResults)('propagates $name without a second POST or another message type', async ({ error }) => {
    const t = adapter()
    const err = error()
    const send = t[route.endpoint]
    // A second SDK call would succeed, exposing a hidden text fallback as a duplicate.
    send.mockRejectedValueOnce(err)
    await expect(route.send(t.client)).rejects.toBe(err)
    expect(send).toHaveBeenCalledTimes(1)
    expect(t.reply.mock.calls.length + t.create.mock.calls.length).toBe(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({ ...route.routing, data: { ...route.routing.data, msg_type: 'post' } })
  })

  it.each([230006, -1])('does not invent a safe fallback for remote rejection code %s', async (code) => {
    const t = adapter()
    const send = t[route.endpoint]
    send.mockResolvedValueOnce({ code, msg: 'synthetic rejection; no validated format-error allowlist' })
    const error = await route.send(t.client).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(FeishuApiError)
    expect(error).toMatchObject({ code, api: `message.${route.endpoint}` })
    expect(send).toHaveBeenCalledTimes(1)
    expect(t.reply.mock.calls.length + t.create.mock.calls.length).toBe(1)
  })

  it('keeps the original destination, Markdown payload and successful ACK', async () => {
    const t = adapter()
    expect(await route.send(t.client)).toEqual(route.result)
    const send = t[route.endpoint]
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      ...route.routing,
      data: { ...route.routing.data, msg_type: 'post', content: JSON.stringify(postContent(MARKDOWN)) },
    })
  })
})

it('records a lost ACK as unknown and never POSTs again for the same delivery key', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const t = adapter()
    const sp = spaceDeps(db)
    const space = sp.spaces.ensure({ kind: 'group', chatId: 'oc_synthetic', openId: 'ou_synthetic' })
    const accepted: unknown[] = []
    t.reply.mockImplementation(async (request) => {
      accepted.push(request)
      throw new Error('synthetic remote accepted the POST, then connection closed')
    })
    const deliveries = new DeliveryService(db, {
      ...sp,
      resolveContext: async () => ({
        actorOpenId: 'ou_synthetic',
        audience: { kind: 'group', spaceId: space.id, chatId: 'oc_synthetic', replyToMessageId: 'om_root' },
        sources: [{ ref: 'message:om_root', spaceId: space.id, chatId: 'oc_synthetic' }],
        provenanceComplete: true, expiresAt: Date.now() + 60_000,
      }),
      send: async ({ audience, payload }) => {
        if (audience.kind !== 'group' || !audience.replyToMessageId || !('markdown' in payload)) throw new Error('unexpected synthetic routing')
        const result = await t.client.replyMarkdown(audience.replyToMessageId, payload.markdown)
        return { remoteId: result.messageId }
      },
    })
    const input = { key: 'synthetic-run:final', contextRef: 'synthetic-run', payload: { markdown: MARKDOWN } }
    await expect(deliveries.deliver(input)).rejects.toMatchObject({ code: 'unknown' })
    expect(deliveries.get(input.key)).toMatchObject({ status: 'unknown', remoteId: null })
    await expect(deliveries.deliver(input)).rejects.toMatchObject({ code: 'unknown' })
    expect(accepted).toHaveLength(1)
    expect(t.reply).toHaveBeenCalledTimes(1)
    expect(t.create).not.toHaveBeenCalled()
  } finally { db.close() }
})
