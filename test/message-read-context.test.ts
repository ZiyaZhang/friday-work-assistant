import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { captureChatDirectory, captureMessageFile, captureMessageRead, type MessageReadContext } from '../src/core/message-read-context.js'
import { conversationDigest, validConversationReads, verifyConversationMessages } from '../src/core/conversation-read-source.js'
import { MessageCache } from '../src/core/message-cache.js'
import { UserMessageReadChanged, type UserMessageReadLease } from '../src/core/user-message-read-lease.js'
import type { HistoryMessage } from '../src/feishu/client.js'
import { historyMsg } from './helpers/fake-feishu.js'

// These are transformation tests. Actual identity/token/Space checks use the HTTP integration fixture.
function setup() {
  const assertCurrent = vi.fn()
  const user: UserMessageReadLease = {
    as: { userToken: 'SYNTHETIC_TOKEN' },
    authority: { appId: 'app-reader', tenantId: 'tenant-reader', openId: 'ou_reader' },
    capture: { status: 'ready', groups: [{ chatId: 'oc_group', name: '合成群' }], groupsComplete: true },
    assertCurrent,
  }
  const read: MessageReadContext = { as: user.as, user, assertCurrent }
  const spaceForChat = vi.fn((chatId: string) => chatId === 'oc_group' ? 'space-group' : undefined)
  const item = (text: string) => historyMsg({ messageId: 'om_material', chatId: 'oc_group', text,
    tenantId: 'tenant-sender', senderOpenId: 'ou_sender', threadId: 'omt_topic', rootId: 'om_root', createTimeMs: 123_000 })
  return { read, user, assertCurrent, spaceForChat, item }
}
const digest = conversationDigest

function cachedSnapshot(message: HistoryMessage) {
  const db = new DatabaseSync(':memory:')
  try {
    const cache = new MessageCache(db)
    expect(cache.upsert(message.chatId!, [message])).toBe(1)
    const actual = cache.get(message.messageId)
    expect(actual).toBeDefined()
    return actual!
  } finally { db.close() }
}

describe('actual returned material source receipts', () => {
  it('hashes the complete delivered snapshot and uses reading authority, not sender identity', () => {
    const t = setup(), item = t.item(`${'长正文'.repeat(1000)}；最后一句：不要发布。`)
    const receipt = captureMessageRead(t.read, [item], 'partial', t.spaceForChat, 456_000)
    expect(receipt).toMatchObject({ complete: true, sources: [{ ref: 'feishu-message:oc_group:om_material',
      appId: 'app-reader', tenantId: 'tenant-reader', spaceId: 'space-group',
      chatId: 'oc_group', messageId: 'om_material', threadId: 'omt_topic', rootId: 'om_root',
      readIdentity: { kind: 'user', openId: 'ou_reader' }, readAt: 456_000, coverage: 'partial', contentDigest: digest(item) }] })
    expect(receipt.sources[0]!.contentDigest).not.toBe(digest({ ...item, text: item.text.slice(0, 2000) }))
    expect(receipt.sources[0]!.contentDigest).toBe(receipt.conversationReads!.items[0]!.contentDigest)
    expect(JSON.stringify(receipt)).not.toContain('SYNTHETIC_TOKEN')
    expect(JSON.stringify(receipt)).not.toContain(item.text)
  })

  it('preserves repeated material and different returned versions of the same message', () => {
    const t = setup(), first = t.item('前一版'), second = { ...first, text: '后一版' }
    const receipt = captureMessageRead(t.read, [first, first, second], 'unknown', t.spaceForChat, 456_000)
    expect(receipt.sources.map(source => source.messageId)).toEqual(['om_material', 'om_material', 'om_material'])
    expect(receipt.sources.map(source => source.contentDigest)).toEqual([digest(first), digest(first), digest(second)])
    expect(receipt.complete).toBe(true)
  })

  it('marks mixed or unsupported material incomplete without inventing a group source', () => {
    const t = setup(), supported = t.item('群消息')
    const unknown = { ...supported, messageId: 'om_unknown', chatId: 'oc_unknown' }
    const unlocated = { ...supported, messageId: 'om_unlocated', chatId: undefined }
    const receipt = captureMessageRead(t.read, [supported, unknown, unlocated], 'partial', t.spaceForChat, 456_000)
    expect(receipt.complete).toBe(false)
    expect(receipt.sources.map(source => source.messageId)).toEqual(['om_material'])
    expect(t.spaceForChat.mock.calls).toEqual([['oc_group'], ['oc_unknown']])
    expect(receipt.conversationReads).toMatchObject({ complete: false,
      items: [{ kind: 'message', messageId: 'om_material' }, { kind: 'message', messageId: 'om_unknown' }] })
    expect(captureMessageRead({ as: {}, assertCurrent: t.assertCurrent }, [supported], 'unknown', t.spaceForChat, 456_000))
      .toMatchObject({ complete: false, sources: [] })
    const noProof = { ...t.user, capture: { status: 'unavailable', reason: 'scope_unknown' } as const }
    expect(captureMessageRead({ ...t.read, user: noProof }, [supported], 'unknown', t.spaceForChat, 456_000))
      .toMatchObject({ complete: false, sources: [] })
  })

  it('rejects stale authority before constructing sources and keeps a live final-check closure', () => {
    const t = setup(), receipt = captureMessageRead(t.read, [t.item('已返回资料')], 'complete', t.spaceForChat, 456_000)
    t.assertCurrent.mockImplementation(() => { throw new UserMessageReadChanged() })
    expect(() => receipt.assertCurrent()).toThrow(UserMessageReadChanged)
    t.spaceForChat.mockClear()
    expect(() => captureMessageRead(t.read, [t.item('迟到资料')], 'complete', t.spaceForChat, 456_001)).toThrow(UserMessageReadChanged)
    expect(t.spaceForChat).not.toHaveBeenCalled()
  })

  it('records every ordinary user message without manufacturing group-memory eligibility', () => {
    const t = setup(), user = { ...t.user, capture: { status: 'denied', reason: 'scope_missing' } as const }
    const first = t.item('本人读取的群消息'), second = { ...first, messageId: 'om_private', chatId: 'oc_private' }
    const receipt = captureMessageRead({ ...t.read, user, appId: 'app-reader' }, [first, second], 'partial', t.spaceForChat, 456_000)
    expect(receipt).toMatchObject({ complete: false, sources: [], conversationReads: { complete: true, items: [
      { kind: 'message', appId: 'app-reader', chatId: 'oc_group', spaceId: 'space-group', messageId: first.messageId,
        readIdentity: { kind: 'user', openId: 'ou_reader', tenantId: 'tenant-reader' }, contentDigest: conversationDigest(first) },
      { kind: 'message', chatId: 'oc_private', spaceId: null, messageId: second.messageId, contentDigest: conversationDigest(second) },
    ] } })
    expect(validConversationReads(receipt.conversationReads)).toBe(true)
    const serialized = JSON.stringify(receipt.conversationReads)
    expect(serialized).not.toContain('SYNTHETIC_TOKEN')
    expect(serialized).not.toContain('tenant-sender')
    expect(serialized).not.toContain(first.text)
    expect(serialized).not.toContain(second.text)
  })

  it('records application reads without borrowing a message sender tenant or user identity', () => {
    const t = setup(), item = t.item('应用读取消息')
    const receipt = captureMessageRead({ as: {}, appId: 'app-reader', assertCurrent: t.assertCurrent }, [item], 'unknown', t.spaceForChat, 456_000)
    expect(receipt).toMatchObject({ complete: false, sources: [], conversationReads: { complete: true,
      items: [{ kind: 'message', appId: 'app-reader', chatId: item.chatId, readIdentity: { kind: 'app' }, contentDigest: conversationDigest(item) }] } })
    expect(receipt.conversationReads!.items[0]!.readIdentity).toEqual({ kind: 'app' })
    expect(validConversationReads(receipt.conversationReads)).toBe(true)
  })

  it.each(['app-id', 'user-lease', 'app-mismatch', 'chat-id', 'message-id'] as const)(
    'cannot manufacture complete ordinary read receipts without %s', mode => {
      const t = setup(), item = t.item('未核验资料')
      let read: MessageReadContext = t.read
      if (mode === 'app-id') read = { as: {}, assertCurrent: t.assertCurrent }
      if (mode === 'user-lease') read = { as: { userToken: 'SYNTHETIC_TOKEN' }, appId: 'app-reader', assertCurrent: t.assertCurrent }
      if (mode === 'app-mismatch') read = { ...t.read, appId: 'other-app' }
      if (mode === 'chat-id') item.chatId = undefined
      if (mode === 'message-id') item.messageId = ''
      const receipt = captureMessageRead(read, [item], 'complete', t.spaceForChat, 456_000)
      expect(receipt.conversationReads).toEqual({ complete: false, items: [] })
    })

  it('records actual directory entries separately from message receipts and catalog completeness', () => {
    const t = setup(), user = { ...t.user, capture: { status: 'unavailable', reason: 'scope_unknown' } as const }
    const rows = [{ chat_id: 'oc_group', name: '合成目录项', cached_messages: 3 }]
    const receipt = captureChatDirectory({ ...t.read, user, groupsComplete: false }, rows, 456_000)
    expect(receipt).toMatchObject({ complete: false, sources: [], conversationReads: { complete: true,
      items: [{ kind: 'directory', chatId: 'oc_group', readIdentity: { kind: 'user', tenantId: 'tenant-reader' }, contentDigest: conversationDigest(rows[0]) }] } })
    expect(receipt.conversationReads!.items[0]).not.toHaveProperty('messageId')
    const eligible = captureChatDirectory(t.read, rows, 456_000)
    expect(eligible.sources[0]!.contentDigest).toBe(eligible.conversationReads!.items[0]!.contentDigest)
    const incomplete = captureChatDirectory(t.read, [...rows, { chat_id: '', name: '没有会话锚点', cached_messages: 0 }], 456_000)
    expect(incomplete.conversationReads?.complete).toBe(false)
    expect(incomplete.conversationReads?.items).toHaveLength(1)
  })

  it.each(['file', 'image'] as const)('keeps downloaded %s bytes, parent snapshot and resource identity distinct', type => {
    const t = setup(), key = 'SYNTHETIC_RESOURCE_KEY'
    const message = { ...t.item('附件父消息'), ...(type === 'file' ? { fileKey: key } : { imageKey: key }) }
    const bytesDigest = createHash('sha256').update('synthetic downloaded bytes').digest('hex')
    const receipt = captureMessageFile(t.read, message, bytesDigest, 456_000)
    expect(receipt.conversationReads).toMatchObject({ complete: true, items: [{ kind: 'file', messageId: message.messageId,
      parentDigest: conversationDigest(message), resourceDigest: conversationDigest({ messageId: message.messageId, key, type }),
      contentDigest: bytesDigest, readIdentity: { kind: 'user', openId: 'ou_reader', tenantId: 'tenant-reader' } }] })
    expect(receipt.conversationReads?.items).toHaveLength(1)
    expect(receipt.conversationReads!.items[0]).not.toHaveProperty('contentFields')
    expect(receipt.sources[0]!.contentDigest).toBe(bytesDigest)
    expect(JSON.stringify(receipt.conversationReads)).not.toContain(key)
    expect(validConversationReads(receipt.conversationReads)).toBe(true)
    expect(captureMessageFile(t.read, t.item('没有附件的消息'), bytesDigest, 456_000).conversationReads).toEqual({ complete: false, items: [] })
    expect(captureMessageFile(t.read, message, 'not-a-byte-digest', 456_000).conversationReads).toEqual({ complete: false, items: [] })
  })

  it('verifies an actual cache snapshot when GET adds previously unseen mention and position fields', async () => {
    const t = setup()
    const stored = cachedSnapshot({ ...t.item('缓存实际正文'), mentions: [{ key: '@reader', openId: 'ou_reader', name: 'Reader' }], messagePosition: '123' })
    // Location fields are retained; mentions are still absent from old cache snapshots.
    expect(stored).not.toHaveProperty('mentions')
    expect(stored.messagePosition).toBe('123')
    expect(stored.fileKey).toBeUndefined()
    const receipt = captureMessageRead(t.read, [stored], 'complete', t.spaceForChat, 456_000)
    expect(receipt.conversationReads!.items[0]).toMatchObject({ kind: 'message',
      contentFields: Object.entries(stored).filter(([, value]) => value !== undefined).map(([key]) => key),
      contentDigest: conversationDigest(stored) })
    expect(receipt.sources[0]!.contentDigest).toBe(receipt.conversationReads!.items[0]!.contentDigest)
    const current = { ...stored, mentions: [{ key: '@reader', openId: 'ou_reader', name: 'Reader' }],
      messagePosition: '123', threadMessagePosition: '456', tenantId: 'tenant-sender' }
    expect(conversationDigest(current)).not.toBe(conversationDigest(stored))
    const getMessage = vi.fn(async () => current)
    expect(await verifyConversationMessages(receipt.conversationReads, stored.chatId, { appId: 'app-reader', openId: 'ou_reader',
      tenantId: 'tenant-reader', as: t.user.as, feishu: { getMessage }, assertCurrent: t.assertCurrent })).toBeUndefined()
    expect(getMessage).toHaveBeenCalledWith(stored.messageId, t.user.as)
  })

  it.each(['text', 'senderOpenId', 'mentions'] as const)('rejects a changed %s that was present in the captured snapshot', async field => {
    const t = setup(), cached = cachedSnapshot(t.item('实际读到的正文'))
    const original: HistoryMessage = field === 'mentions' ? { ...cached, mentions: [{ key: '@reader', openId: 'ou_reader', name: 'Reader' }] } : cached
    const receipt = captureMessageRead(t.read, [original], 'complete', t.spaceForChat, 456_000)
    const current = { ...original, messagePosition: '123' }
    if (field === 'text') current.text = '已更正的另一段正文'
    if (field === 'senderOpenId') current.senderOpenId = 'ou_other_sender'
    if (field === 'mentions') current.mentions = [{ key: '@reader', openId: 'ou_other_reader', name: 'Reader' }]
    expect(receipt.conversationReads!.items[0]).toMatchObject({ contentFields: expect.arrayContaining([field]) })
    const getMessage = vi.fn(async () => current)
    expect(await verifyConversationMessages(receipt.conversationReads, cached.chatId, { appId: 'app-reader', openId: 'ou_reader',
      tenantId: 'tenant-reader', as: t.user.as, feishu: { getMessage }, assertCurrent: t.assertCurrent }))
      .toMatchObject({ reason: 'source_unverifiable' })
    expect(getMessage).toHaveBeenCalledTimes(1)
  })
})
