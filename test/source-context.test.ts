import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { SourceContexts, type SourceContextBinding } from '../src/core/source-context.js'
import type { MemorySourceReference } from '../src/core/memory-provenance.js'
import type { ConversationReadSource } from '../src/core/conversation-read-source.js'

const opened: Registry[] = []
afterEach(() => { for (const registry of opened.splice(0)) registry.close() })
const binding: SourceContextBinding = { sessionKey: 'dm:alice', acpSessionId: 'acp-1', spaceId: 'sp_dm_alice', chatId: 'dm-chat' }
const source: MemorySourceReference = { ref: 'message:app:group:message-1', appId: 'app', tenantId: 'tenant',
  spaceId: null, chatId: 'group', messageId: 'message-1', readIdentity: { kind: 'user', openId: 'alice' },
  readAt: 10, coverage: 'partial', contentDigest: 'original-content' }
const conversation: ConversationReadSource = { kind: 'message', appId: 'app', chatId: 'group', spaceId: null,
  messageId: 'message-1', contentDigest: 'a'.repeat(64), readIdentity: { kind: 'user', openId: 'alice', tenantId: 'tenant' } }
function fixture() {
  const registry = new Registry(':memory:'); opened.push(registry)
  const contexts = new SourceContexts(registry)
  contexts.initialize(binding, ['space:sp_dm_alice'])
  return { registry, contexts }
}

describe('actual ACP source context', () => {
  it('keeps ordinary message proof independent from persistent memory eligibility', () => {
    const { contexts } = fixture()
    expect(contexts.get(binding.sessionKey)?.conversationReads).toEqual({ complete: true, items: [] })
    contexts.recordMessages(binding, [], false)
    contexts.recordConversationReads(binding, { complete: true, items: [conversation] })
    expect(contexts.get(binding.sessionKey)).toMatchObject({
      conversationReads: { complete: true, items: [conversation] }, messageSources: [], personalMemoryComplete: false,
    })
  })

  it('cannot certify old unknown material using a later exact read from the same chat', () => {
    const { registry, contexts } = fixture(), old = contexts.get(binding.sessionKey)!
    old.chats = [{ chatId: conversation.chatId }]
    delete old.conversationReads
    registry.setKv(`delivery-sources:${binding.sessionKey}`, JSON.stringify(old))
    contexts.recordConversationReads(binding, { complete: true, items: [conversation] })
    expect(contexts.get(binding.sessionKey)?.conversationReads).toEqual({ complete: false, items: [conversation] })
    contexts.recordConversationReads(binding, { complete: true, items: [{ ...conversation, messageId: 'message-2' }] })
    expect(contexts.get(binding.sessionKey)?.conversationReads?.complete).toBe(false)
  })

  it('stores detached exact snapshots and canonical deduplication retains distinct content, readers and bindings', () => {
    const { contexts } = fixture(), input = structuredClone(conversation)
    contexts.recordConversationReads(binding, { complete: true, items: [input] })
    input.contentDigest = 'b'.repeat(64)
    const reordered = Object.fromEntries(Object.entries(conversation).reverse()) as ConversationReadSource
    const edited = { ...conversation, contentDigest: 'c'.repeat(64) }
    const otherReader: ConversationReadSource = { ...conversation, readIdentity: { kind: 'user', openId: 'bob', tenantId: 'tenant' } }
    const otherBinding = { ...conversation, spaceId: 'changed-source-space' }
    contexts.recordConversationReads(binding, { complete: true, items: [reordered, edited, otherReader, otherBinding] })
    expect(contexts.get(binding.sessionKey)?.conversationReads).toEqual({ complete: true, items: [conversation, edited, otherReader, otherBinding] })
    expect(contexts.get(binding.sessionKey)?.chats).toEqual([{ chatId: 'group' }])
  })

  it('retains an incomplete ordinary read after later success', () => {
    const { contexts } = fixture()
    contexts.recordConversationReads(binding, { complete: false, items: [] })
    contexts.recordConversationReads(binding, { complete: true, items: [conversation] })
    expect(contexts.get(binding.sessionKey)?.conversationReads).toEqual({ complete: false, items: [conversation] })
  })

  it('rejects mismatched late conversation bindings without changing persistent data', () => {
    const { registry, contexts } = fixture(), before = registry.getKv(`delivery-sources:${binding.sessionKey}`)
    for (const changed of [{ acpSessionId: 'old-acp' }, { spaceId: 'another-space' }, { chatId: 'another-chat' }]) {
      expect(() => contexts.recordConversationReads({ ...binding, ...changed }, { complete: true, items: [conversation] })).toThrow('执行上下文已变化')
      expect(registry.getKv(`delivery-sources:${binding.sessionKey}`)).toBe(before)
    }
  })

  it.each([null, { complete: 'true', items: [] }, { complete: true, items: [{}] }])('rejects malformed persisted conversation proof rather than treating it as legacy: %j', malformed => {
    const { registry, contexts } = fixture(), original = contexts.get(binding.sessionKey)!
    registry.setKv(`delivery-sources:${binding.sessionKey}`, JSON.stringify({ ...original, conversationReads: malformed }))
    expect(contexts.get(binding.sessionKey)).toBeUndefined()
    expect(() => contexts.recordConversationReads(binding, { complete: true, items: [conversation] })).toThrow('执行上下文已变化')
  })

  it('does not retroactively prove material in a legacy persisted context', () => {
    const { registry, contexts } = fixture()
    const old = contexts.get(binding.sessionKey)!
    delete old.messageSources; delete old.personalMemoryComplete
    const raw = JSON.stringify(old)
    registry.setKv(`delivery-sources:${binding.sessionKey}`, raw)
    expect(contexts.get(binding.sessionKey)).toEqual(old)
    expect(registry.getKv(`delivery-sources:${binding.sessionKey}`)).toBe(raw)
    contexts.recordMessages(binding, [source], true)
    expect(contexts.get(binding.sessionKey)?.personalMemoryComplete).toBe(false)
  })

  it('does not let a late read from the previous ACP populate its successor', () => {
    const { registry, contexts } = fixture()
    contexts.recordMessages(binding, [source], true)
    contexts.initialize({ ...binding, acpSessionId: 'acp-2' }, ['space:sp_dm_alice'])
    const before = registry.getKv(`delivery-sources:${binding.sessionKey}`)
    expect(() => contexts.recordMessages(binding, [source], true)).toThrow('执行上下文已变化')
    expect(registry.getKv(`delivery-sources:${binding.sessionKey}`)).toBe(before)
    expect(contexts.get(binding.sessionKey)?.messageSources).toEqual([])
  })

  it('keeps an unsupported input incomplete after later authorized reads', () => {
    const { contexts } = fixture()
    contexts.recordMessages(binding, [], false)
    contexts.recordMessages(binding, [source], true)
    expect(contexts.get(binding.sessionKey)).toMatchObject({ messageSources: [source], personalMemoryComplete: false })
  })

  it('retains changed contents and reading identities while deduplicating repeat snapshots', () => {
    const { contexts } = fixture()
    contexts.recordMessages(binding, [source], true)
    contexts.recordMessages(binding, [{ ...source, readAt: 20 }], true)
    const edited = { ...source, readAt: 30, contentDigest: 'edited-content' }
    const otherReader: MemorySourceReference = { ...source, readIdentity: { kind: 'user', openId: 'bob' } }
    contexts.recordMessages(binding, [edited, otherReader], true)
    expect(contexts.get(binding.sessionKey)?.messageSources).toEqual([source, edited, otherReader])
    // Previously accumulated publishing boundaries remain alongside exact message evidence.
    contexts.addChat(binding.sessionKey, { chatId: 'group' })
    contexts.addRepository(binding.sessionKey, 'TEAM/REPO')
    contexts.addExternal(binding.sessionKey, { kind: 'document', ref: 'doc-1' })
    expect(contexts.get(binding.sessionKey)).toMatchObject({ chats: [{ chatId: 'group' }], repositories: ['team/repo'],
      external: [{ kind: 'document', ref: 'doc-1' }], messageSources: [source, edited, otherReader] })
  })

  it('commits message snapshots and their original chat binding together in one source-context write', () => {
    const { registry, contexts } = fixture(), write = vi.spyOn(registry, 'setKv')
    const bound = { ...source, spaceId: 'original-group-space' }
    contexts.recordMessages(binding, [bound, { ...bound, readAt: 20 }], true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(contexts.get(binding.sessionKey)).toMatchObject({
      chats: [{ chatId: 'group', spaceId: 'original-group-space' }], messageSources: [bound],
    })
    const before = registry.getKv(`delivery-sources:${binding.sessionKey}`)
    write.mockImplementationOnce(() => { throw new Error('synthetic persistence failure') })
    expect(() => contexts.recordMessages(binding, [{ ...source, chatId: 'other-group' }], false)).toThrow('synthetic persistence failure')
    expect(registry.getKv(`delivery-sources:${binding.sessionKey}`)).toBe(before)
  })
})
