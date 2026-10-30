import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PendingQuestionReplies } from '../src/core/pending-question-replies.js'
import { Registry } from '../src/core/registry.js'
import type { InboundMessage } from '../src/feishu/mention.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function inbound(patch: Partial<InboundMessage> = {}): InboundMessage {
  return {
    eventId: 'event-reply-a', tenantId: 'tenant-a', messageId: 'reply-a', chatId: 'chat-a', chatType: 'group',
    threadId: 'thread-a', rootId: 'root-a', parentId: 'question-platform-id', msgType: 'media',
    text: '这是原始补充：刷新后恢复。\n附件是合成片段，不证明根因。', senderOpenId: 'alice', senderType: 'user',
    mentions: [{ key: '@_user_1', openId: 'bot', name: 'Friday' }], createTimeMs: 1_800_000_000_123,
    fileKey: 'synthetic-file-key', fileName: 'synthetic-session.jsonl', imageKey: 'synthetic-thumbnail', ...patch,
  }
}

function setup() {
  const registry = new Registry(':memory:')
  cleanups.push(() => registry.close())
  return { registry, store: new PendingQuestionReplies(registry.db) }
}

describe('pending question replies', () => {
  it('preserves raw reply, attachments, author and exact parent across a real SQLite close/reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-pending-question-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'state.sqlite')
    let registry = new Registry(path)
    cleanups.push(() => registry.close())
    const original = inbound(), snapshot = structuredClone(original)
    new PendingQuestionReplies(registry.db).save('space-a', original)
    original.text = '不应覆盖的后来修改'
    original.fileKey = 'mutated-key'
    original.mentions[0]!.name = '后来修改的展示名'
    registry.close()
    registry = new Registry(path)
    const reopened = new PendingQuestionReplies(registry.db)
    expect(reopened.list('space-a', 'alice')).toEqual([snapshot])
    expect(registry.db.prepare('SELECT count(*) AS n FROM tasks').get()).toMatchObject({ n: 0 })
    expect(registry.db.prepare('SELECT count(*) AS n FROM task_receipts').get()).toMatchObject({ n: 0 })
  })

  it('does not overwrite or reroute the original message when a duplicate event changes text, sender or parent', () => {
    const { store } = setup()
    const original = inbound()
    store.save('space-a', original)
    store.save('space-a', inbound({ eventId: 'redelivered-event', text: '重复事件不能修改原文', parentId: 'other-question', fileKey: 'other-file' }))
    store.save('space-b', inbound({ senderOpenId: 'bob', chatId: 'chat-b', tenantId: 'tenant-b' }))
    expect(store.list('space-a', 'alice')).toEqual([original])
    expect(store.list('space-a', 'bob')).toEqual([])
    expect(store.list('space-b', 'alice')).toEqual([])
    expect(store.list('space-b', 'bob')).toEqual([])
  })

  it('lists only the exact space and target, preserving multiple replies to the same question', () => {
    const { store } = setup()
    const a = inbound(), next = inbound({ messageId: 'reply-a-next', text: '同一人第二条原始补充' })
    const bob = inbound({ messageId: 'reply-bob', senderOpenId: 'bob' })
    const elsewhere = inbound({ messageId: 'reply-elsewhere', chatId: 'chat-b' })
    store.save('space-a', a); store.save('space-a', next)
    store.save('space-a', bob); store.save('space-b', elsewhere)
    expect(store.list('space-a', 'alice')).toEqual([a, next])
    expect(store.list('space-a', 'bob')).toEqual([bob])
    expect(store.list('space-b', 'alice')).toEqual([elsewhere])
    expect(store.list('space-b', 'bob')).toEqual([])
    expect(store.list('missing-space', 'alice')).toEqual([])
  })

  it('removes only the exact message, not other replies sharing its parent, author or space', () => {
    const { store } = setup()
    const next = inbound({ messageId: 'reply-next' }), elsewhere = inbound({ messageId: 'reply-elsewhere', chatId: 'chat-b' })
    store.save('space-a', inbound()); store.save('space-a', next); store.save('space-b', elsewhere)
    store.remove('reply-a')
    store.remove('reply-a')
    store.remove("' OR 1=1 --")
    expect(store.list('space-a', 'alice')).toEqual([next])
    expect(store.list('space-b', 'alice')).toEqual([elsewhere])
  })

  it.each(['parentId', 'senderOpenId', 'tenantId'] as const)('refuses missing %s without retaining a guessed reply', (field) => {
    const { store } = setup()
    expect(() => store.save('space-a', inbound({ [field]: undefined }))).toThrow('缺少真实消息身份')
    expect(store.list('space-a', 'alice')).toEqual([])
  })

  it('participates in the shared inbound transaction so a failed continuation does not lose its pending message', () => {
    const { registry, store } = setup()
    const msg = inbound()
    store.save('space-a', msg)
    registry.createSession({ sessionKey: 'session-a', chatId: msg.chatId, chatType: msg.chatType, cwd: '/synthetic', requesterOpenId: 'alice' })
    registry.db.exec('SAVEPOINT reply_transaction')
    registry.createTaskOnce({ sessionKey: 'session-a', messageId: msg.messageId, requesterOpenId: msg.senderOpenId, prompt: msg.text })
    store.remove(msg.messageId)
    registry.db.exec('ROLLBACK TO reply_transaction; RELEASE reply_transaction')
    expect(store.list('space-a', 'alice')).toEqual([msg])
    expect(registry.taskForMessage(msg.messageId)).toBeUndefined()
  })
})
