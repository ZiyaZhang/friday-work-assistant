import { it, expect, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { SourceContexts } from '../src/core/source-context.js'
import { DeliveryContextResolver } from '../src/core/delivery-context.js'
import { spaceDeps } from './helpers/space.js'

it.each(['gmail', 'mcp'] as const)('delivers %s-derived content only to its owner and rechecks source access before delivery', async kind => {
  const registry = new Registry(':memory:'), { spaces } = spaceDeps(registry.db)
  const space = spaces.ensure({ kind: 'p2p', chatId: 'dm-alice', openId: 'alice' })
  const binding = { sessionKey: 'session', acpSessionId: 'acp', spaceId: space.id, chatId: 'dm-alice' }, sources = new SourceContexts(registry)
  sources.initialize(binding, [])
  sources.addExternal('session', { kind, ref: 'gmail:123:1:abc', personalOpenId: 'alice', access: 'user' })
  let allowed = true
  const checkGmailSource = vi.fn(async (_owner: string, _ref: string, guard: () => void) => {
    guard(); if (!allowed) throw new Error('revoked')
    return () => { guard(); if (!allowed) throw new Error('revoked') }
  })
  const resolver = new DeliveryContextResolver({ sources, spaces, feishu: { listChats: vi.fn(async () => []), chatMemberOpenIds: vi.fn(async () => new Set<string>()) },
    ...(kind === 'gmail' ? { checkGmailSource } : { checkMcpSource: checkGmailSource }), disconnectPersonalConnection: () => false, now: () => 1000 })
  const execution = { ...binding, runId: 'run', actorOpenId: 'alice', chatType: 'p2p' as const, isLive: () => true, isCurrent: () => true, readScopes: () => [] }
  const audience = { kind: 'dm' as const, spaceId: space.id, openId: 'alice' }
  const result = await resolver.resolveResult(execution, { audience })
  expect(result.status).toBe('ready')
  if (result.status !== 'ready') throw new Error('not ready')
  expect(result.context.isCurrent()).toBe(true)
  allowed = false
  expect(result.context.isCurrent()).toBe(false)
  expect(await resolver.resolveResult(execution, { audience })).toMatchObject({ status: 'blocked' })
  for (const bad of [{ ...audience, openId: 'bob' }, { kind: 'group' as const, spaceId: space.id, chatId: 'group' }])
    expect(await resolver.resolveResult(execution, { audience: bad })).toMatchObject({ status: 'blocked', failure: { reason: 'audience_mismatch' } })
  registry.close()
})
