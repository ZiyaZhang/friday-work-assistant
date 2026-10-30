import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { SourceContexts } from '../src/core/source-context.js'
import { DeliveryContextResolver } from '../src/core/delivery-context.js'
import { DeliveryService } from '../src/core/delivery.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { spaceDeps } from './helpers/space.js'

const NOW = 1_800_000_000_000
const opened: Registry[] = []
afterEach(() => { for (const registry of opened.splice(0)) registry.close() })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function setup(audience: 'dm' | 'group' = 'dm', notice = false) {
  const registry = new Registry(':memory:'); opened.push(registry)
  const { spaces, policy } = spaceDeps(registry.db)
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'dm-chat', openId: 'alice' })
  const group = spaces.ensure({ kind: 'group', chatId: 'group-chat', openId: 'alice' })
  const other = spaces.ensure({ kind: 'group', chatId: 'other-chat', openId: 'bob' })
  const origin = audience === 'dm' ? dm : group
  const binding = { sessionKey: 'session', acpSessionId: 'acp', spaceId: origin.id, chatId: origin.chatId! }
  const sources = new SourceContexts(registry)
  sources.initialize(binding, [])
  if (audience === 'dm') sources.addChat(binding.sessionKey, { chatId: group.chatId!, spaceId: group.id })
  const userTokens = new UserTokenStore(registry.db, {
    exchangeCode: async () => ({ accessToken: 'synthetic-token', expiresIn: 7200 }),
    refresh: async () => { throw new Error('unexpected refresh') },
  }, () => NOW)
  await userTokens.complete({ code: 'synthetic-code', openId: 'alice', redirectUri: 'http://localhost/callback' })
  const entered = deferred<void>(), release = deferred<void>()
  const feishu = {
    listChats: vi.fn(async () => { entered.resolve(); await release.promise; return [{ chatId: group.chatId!, name: 'group' }] }),
    chatMemberOpenIds: vi.fn(async () => { entered.resolve(); await release.promise; return new Set(['alice']) }),
  }
  const resolver = new DeliveryContextResolver({ sources, spaces, feishu, userTokens,
    disconnectPersonalConnection: () => false, now: () => NOW })
  const send = vi.fn(async () => ({ remoteId: 'synthetic-remote' }))
  const execution = { current: true }
  let afterResolve: (() => void) | undefined
  const service = new DeliveryService(registry.db, { spaces, policy, now: () => NOW, send,
    resolveContext: async () => {
      const context = await resolver.resolve({ ...binding, actorOpenId: 'alice', chatType: audience === 'dm' ? 'p2p' : 'group',
        isLive: () => execution.current, isCurrent: () => execution.current, readScopes: () => [] }, {
        audience: audience === 'dm' ? { kind: 'dm', spaceId: dm.id, openId: 'alice' }
          : { kind: 'group', spaceId: group.id, chatId: group.chatId! }, prepareMentions: true, notice,
      })
      // A sibling tool/stop may settle in the Promise handoff after the resolver's last check.
      queueMicrotask(() => afterResolve?.())
      return context
    },
  })
  const deliver = () => service.deliver({ key: 'run:tool:message', contextRef: 'run-context', payload: { markdown: '合成固定正文' } })
  return { sources, binding, group, other, entered, release, send, service, deliver, execution, userTokens,
    afterResolve: (callback: () => void) => { afterResolve = callback } }
}

describe('delivery source snapshot across authorization awaits', () => {
  it.each(['chat', 'external', 'repository', 'memory', 'message', 'incomplete'] as const)(
    'does not admit or send with a stale snapshot after %s material is registered', async kind => {
      const t = await setup()
      const pending = t.deliver()
      await t.entered.promise
      if (kind === 'chat') t.sources.addChat(t.binding.sessionKey, { chatId: t.other.chatId!, spaceId: t.other.id })
      if (kind === 'external') t.sources.addExternal(t.binding.sessionKey, { kind: 'document', ref: 'synthetic-doc' })
      if (kind === 'repository') t.sources.addRepository(t.binding.sessionKey, 'synthetic/repo')
      if (kind === 'memory') t.sources.addMemoryScopes(t.binding.sessionKey, ['space:other'])
      if (kind === 'message') t.sources.recordMessages(t.binding, [{ ref: 'message:other', appId: 'synthetic-app',
        tenantId: 'synthetic-tenant', spaceId: t.other.id, chatId: t.other.chatId, messageId: 'synthetic-message',
        readIdentity: { kind: 'user', openId: 'alice' }, readAt: NOW, coverage: 'complete', contentDigest: 'synthetic-digest' }], true)
      if (kind === 'incomplete') t.sources.recordMessages(t.binding, [], false)
      t.release.resolve()
      await expect(pending).rejects.toMatchObject({ code: 'denied' })
      expect(t.send).not.toHaveBeenCalled()
      expect(t.service.get('run:tool:message')).toBeUndefined()
    })

  it('checks the snapshot after group mention membership, too', async () => {
    const t = await setup('group')
    const pending = t.deliver()
    await t.entered.promise
    t.sources.addChat(t.binding.sessionKey, { chatId: t.other.chatId!, spaceId: t.other.id })
    t.release.resolve()
    await expect(pending).rejects.toMatchObject({ code: 'denied' })
    expect(t.send).not.toHaveBeenCalled()
    expect(t.service.get('run:tool:message')).toBeUndefined()
  })

  it('keeps an unchanged source snapshot usable and replays its receipt without another send', async () => {
    const t = await setup()
    const pending = t.deliver()
    await t.entered.promise
    // A duplicate registration is not a new source or authority.
    t.sources.addChat(t.binding.sessionKey, { chatId: t.group.chatId!, spaceId: t.group.id })
    t.release.resolve()
    expect(await pending).toMatchObject({ status: 'sent', replayed: false })
    expect(await t.deliver()).toMatchObject({ status: 'sent', replayed: true })
    expect(t.send).toHaveBeenCalledTimes(1)
  })

  it.each(['source', 'stop', 'authorization'] as const)('rejects %s changes after resolve but before synchronous admission', async kind => {
    const t = await setup()
    t.afterResolve(() => {
      if (kind === 'source') t.sources.addChat(t.binding.sessionKey, { chatId: t.other.chatId!, spaceId: t.other.id })
      if (kind === 'stop') t.execution.current = false
      if (kind === 'authorization') t.userTokens.disconnect('alice')
    })
    t.release.resolve()
    await expect(t.deliver()).rejects.toMatchObject({ code: 'denied' })
    expect(t.service.get('run:tool:message')).toBeUndefined()
    expect(t.send).not.toHaveBeenCalled()
  })

  it('keeps a fixed notice tied to the live execution through the Promise handoff', async () => {
    const t = await setup('dm', true)
    t.afterResolve(() => { t.execution.current = false })
    await expect(t.deliver()).rejects.toMatchObject({ code: 'denied' })
    expect(t.service.get('run:tool:message')).toBeUndefined()
    expect(t.send).not.toHaveBeenCalled()
  })
})
