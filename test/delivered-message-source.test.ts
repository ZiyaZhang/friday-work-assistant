import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { SourceContexts } from '../src/core/source-context.js'
import { DeliveryContextResolver, type DeliveryExecution } from '../src/core/delivery-context.js'
import { ExecutionSourceAccess, type ExecutionSourceActor } from '../src/core/execution-source-access.js'
import { hasCurrentDeliveredMessages, type DeliveredMessageSource } from '../src/core/delivered-message-source.js'
import { UserMessageReadChanged } from '../src/core/user-message-read-lease.js'
import { spaceDeps } from './helpers/space.js'

const opened: Registry[] = []
afterEach(() => { for (const registry of opened.splice(0)) registry.close() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function setup(kind: 'p2p' | 'group' = 'p2p', verifier = true) {
  const registry = new Registry(':memory:'); opened.push(registry)
  const { spaces, policy } = spaceDeps(registry.db)
  const space = spaces.ensure({ kind, chatId: 'original-chat', openId: 'alice' })
  const binding = { sessionKey: 'session', acpSessionId: 'acp', spaceId: space.id, chatId: space.chatId! }
  const source: DeliveredMessageSource = { ref: 'question:1', deliveryKey: 'question:1', messageId: 'confirmed-remote',
    tenantId: 'tenant', appId: 'app', spaceId: space.id, chatId: space.chatId!, chatType: kind,
    targetOpenId: 'alice', contentDigest: 'a'.repeat(64) }
  let acknowledged = true
  const expected = JSON.stringify(source)
  const verifyDeliveredMessage = vi.fn((value: DeliveredMessageSource) => acknowledged && JSON.stringify(value) === expected)
  const sources = new SourceContexts(registry); sources.initialize(binding, [])
  sources.recordDeliveredMessage(binding, source)
  const feishu = {
    listChats: vi.fn(async () => []),
    listChatsResult: vi.fn(async () => ({ items: [{ chatId: space.chatId!, name: 'current' }], complete: true })),
    chatMemberOpenIds: vi.fn(async () => new Set(['alice'])),
    readDocument: vi.fn(async () => { throw new Error('unexpected resource read') }),
    listMyEvents: vi.fn(async () => []),
  }
  const personalMemory = { checkRead: vi.fn(async () => { throw new Error('unexpected personal source') }) }
  const userReads = { open: vi.fn(async () => { throw new Error('unexpected personal identity') }) }
  const proof = verifier ? { verifyDeliveredMessage } : {}
  const delivery = new DeliveryContextResolver({ appId: 'app', ...proof, sources, spaces, feishu,
    disconnectPersonalConnection: () => false, now: () => 1 })
  const access = new ExecutionSourceAccess({ appId: 'app', ...proof, spaces, policy, feishu,
    personalMemory, userReads, repositoryAllowed: () => false })
  const execution: DeliveryExecution = { ...binding, actorOpenId: 'alice', chatType: kind,
    isLive: () => true, isCurrent: () => true, readScopes: () => [] }
  const actor: ExecutionSourceActor = { runId: 'run', acpSessionId: binding.acpSessionId, spaceId: space.id,
    chatId: space.chatId!, chatType: kind, openId: 'alice', assertCurrent: () => {}, readScopes: () => [] }
  const audience = kind === 'p2p' ? { kind: 'dm' as const, spaceId: space.id, openId: 'alice' }
    : { kind: 'group' as const, spaceId: space.id, chatId: space.chatId! }
  const check = () => access.check(actor, sources.get(binding.sessionKey)!)
  const resolve = () => delivery.resolveResult(execution, { audience })
  const replace = (patch: Partial<DeliveredMessageSource>) => {
    sources.initialize(binding, []); sources.recordDeliveredMessage(binding, { ...source, ...patch })
  }
  return { registry, spaces, space, binding, source, sources, verifyDeliveredMessage, feishu, personalMemory, userReads,
    access, delivery, actor, execution, audience, check, resolve, replace, revoke: () => { acknowledged = false } }
}

describe('host-confirmed outgoing source proof', () => {
  it('uses a current proof for the same DM recipient without personal OAuth or group membership fiction', async () => {
    const t = setup()
    expect(await t.check()).toMatchObject({ status: 'allowed' })
    const result = await t.resolve()
    expect(result).toMatchObject({ status: 'ready', context: { provenanceComplete: true,
      sources: [{ ref: `space:${t.space.id}` }, { ref: 'question:1' }] } })
    expect(t.sources.get('session')).toMatchObject({ chats: [], messageSources: [], deliveredMessages: [t.source] })
    expect(t.feishu.chatMemberOpenIds).not.toHaveBeenCalled()
    expect(t.feishu.listChatsResult).not.toHaveBeenCalled()
    expect(t.personalMemory.checkRead).not.toHaveBeenCalled()
    expect(t.userReads.open).not.toHaveBeenCalled()
  })

  it.each(['ref', 'deliveryKey', 'messageId', 'tenantId', 'appId', 'targetOpenId', 'contentDigest'] as const)(
    'rejects altered %s in both resolvers and the compatibility delivery adapter', async field => {
      const t = setup(); t.replace({ [field]: field === 'contentDigest' ? 'b'.repeat(64) : 'other' })
      expect(await t.check()).toMatchObject({ status: 'unavailable', reason: 'delivered_message_unverified' })
      expect(await t.resolve()).toMatchObject({ status: 'blocked', failure: { reason: 'source_unverifiable' } })
      expect(await t.delivery.resolve(t.execution, { audience: t.audience })).toBeUndefined()
    })

  it('requires a concrete host verifier, and does not infer proof from a legacy app message', async () => {
    const t = setup('p2p', false)
    expect(await t.check()).toMatchObject({ status: 'unavailable', reason: 'delivered_message_unverified' })
    expect(await t.delivery.resolve(t.execution, { audience: t.audience })).toBeUndefined()
    t.sources.initialize(t.binding, [])
    t.sources.recordMessages(t.binding, [{ ref: 'message:confirmed-remote', appId: 'app', tenantId: 'tenant',
      chatId: t.space.chatId!, spaceId: t.space.id, messageId: 'confirmed-remote', readIdentity: { kind: 'app' },
      readAt: 1, coverage: 'complete', contentDigest: 'a'.repeat(64) }], true)
    expect(t.sources.get('session')!.deliveredMessages).toBeUndefined()
    expect(await t.check()).toMatchObject({ status: 'denied', reason: 'source_binding_changed' })
  })

  it.each(['spaceId', 'chatId', 'appId', 'actorOpenId', 'chatType'] as const)(
    'binds the proof to the current %s rather than trusting a successful ACK alone', field => {
      const t = setup(), binding = { spaceId: t.space.id, chatId: t.space.chatId!, appId: 'app', actorOpenId: 'alice', chatType: 'p2p' as const }
      expect(hasCurrentDeliveredMessages([t.source], { ...binding, [field]: field === 'chatType' ? 'group' : 'other' }, () => true)).toBe(false)
    })

  it('does not publish to a new audience even if the host delivery remains acknowledged', async () => {
    const t = setup(), audience = { kind: 'dm' as const, spaceId: t.space.id, openId: 'bob' }
    expect(await t.delivery.resolveResult(t.execution, { audience })).toMatchObject({ status: 'blocked', failure: { reason: 'audience_mismatch' } })
    expect(await t.delivery.resolve(t.execution, { audience })).toBeUndefined()
  })

  it('rechecks proof in returned execution and delivery guards', async () => {
    const t = setup(), execution = await t.check(), delivery = await t.resolve()
    expect(execution.status).toBe('allowed'); expect(delivery.status).toBe('ready')
    t.revoke()
    expect(() => execution.assertCurrent()).toThrow(UserMessageReadChanged)
    expect(delivery.status === 'ready' && delivery.context.isCurrent!()).toBe(false)
    expect(await t.resolve()).toMatchObject({ status: 'blocked' })
  })

  it.each(['execution', 'delivery'] as const)('rechecks ACK after an awaited %s group membership check', async operation => {
    const t = setup('group'), entered = deferred(), release = deferred()
    t.feishu.chatMemberOpenIds.mockImplementation(async () => { entered.resolve(); await release.promise; return new Set(['alice']) })
    const pending = operation === 'execution' ? t.check()
      : t.delivery.resolveResult(t.execution, { audience: t.audience, prepareMentions: true })
    await entered.promise; t.revoke(); release.resolve()
    if (operation === 'execution') await expect(pending).rejects.toThrow(UserMessageReadChanged)
    else expect(await pending).toMatchObject({ status: 'blocked', failure: { reason: 'source_unverifiable' } })
  })
})
