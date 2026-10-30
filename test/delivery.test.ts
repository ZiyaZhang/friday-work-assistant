import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeliveryService, deliveryAudienceKey, deliveryPayloadDigest, type DeliveryContext, type DeliveryDependencies } from '../src/core/delivery.js'
import { Registry } from '../src/core/registry.js'
import { spaceDeps } from './helpers/space.js'

const NOW = 1_800_000_000_000
const payload = { markdown: '合成摘要，没有真实用户信息' }

function setup(opts: { path?: string; mode?: 'safe' | 'auto' | 'deny'; verify?: boolean } = {}) {
  const registry = new Registry(opts.path ?? ':memory:')
  const sp = spaceDeps(registry.db, { mode: opts.mode, admins: ['admin'] })
  const a = sp.spaces.ensure({ kind: 'group', chatId: 'chat_a', openId: 'alice' })
  const b = sp.spaces.ensure({ kind: 'group', chatId: 'chat_b', openId: 'bob' })
  sp.spaces.addMember(a.id, 'member', 'member')
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'chat_dm', openId: 'alice' })
  let context: DeliveryContext | undefined = {
    actorOpenId: 'alice', audience: { kind: 'group', spaceId: a.id, chatId: 'chat_a', replyToMessageId: 'root_a' },
    sources: [{ ref: 'trusted-message-a', spaceId: a.id, chatId: 'chat_a' }], provenanceComplete: true, expiresAt: NOW + 60_000,
  }
  const state = { sent: 0, reads: 0, unknown: false, readError: false, readMatches: true }
  let beforeSend: (() => Promise<void>) | undefined
  const deps: DeliveryDependencies = {
    ...sp, now: () => NOW, resolveContext: async () => context,
    send: async () => {
      state.sent++
      await beforeSend?.()
      if (state.unknown) throw new Error('synthetic connection lost after POST accepted')
      return { remoteId: 'remote-1' }
    },
    verify: opts.verify === false ? undefined : async () => {
      state.reads++
      if (state.readError) throw new Error('synthetic GET failure')
      return state.readMatches
    },
  }
  const service = new DeliveryService(registry.db, deps)
  const run = (key = 'run-1:final:0') => service.deliver({ key, contextRef: 'trusted-run-1', payload })
  return { registry, ...sp, a, b, dm, state, deps, service, run, context: () => context!, setContext: (c?: DeliveryContext) => { context = c }, delaySend: (fn: () => Promise<void>) => { beforeSend = fn } }
}

describe('delivery authorization', () => {
  it('allows same-space members and confirms only after real read-back', async () => {
    const t = setup()
    t.context().actorOpenId = 'member'
    expect(await t.run()).toMatchObject({ status: 'confirmed', replayed: false, remoteId: 'remote-1' })
    expect(await t.run()).toMatchObject({ status: 'confirmed', replayed: true })
    expect(t.state).toMatchObject({ sent: 1, reads: 1 })
    const stored = JSON.stringify(t.registry.db.prepare('SELECT * FROM deliveries').all())
    expect(stored).not.toContain(payload.markdown)
    expect(t.service.get('run-1:final:0')?.payloadDigest).toBe(deliveryPayloadDigest(payload))
  })

  it('allows the real owner in their DM', async () => {
    const t = setup()
    t.setContext({ ...t.context(), audience: { kind: 'dm', spaceId: t.dm.id, openId: 'alice' }, sources: [{ ref: 'trusted-dm', spaceId: t.dm.id, chatId: 'chat_dm' }] })
    expect(await t.run()).toMatchObject({ status: 'confirmed' })
  })

  it('allows a fresh personal reading proof only for the same person DM, never a group audience', async () => {
    const t = setup()
    const c = t.context()
    c.audience = { kind: 'dm', spaceId: t.dm.id, openId: 'alice' }
    c.sources = [{ ref: 'external-group', spaceId: t.b.id, chatId: 'chat_b' }]
    c.personalRead = { actorOpenId: 'alice', chatIds: ['chat_b'], expiresAt: NOW + 1000 }
    expect(await t.run()).toMatchObject({ status: 'confirmed' })
    c.audience = { kind: 'group', spaceId: t.a.id, chatId: 'chat_a' }
    await expect(t.run('to-group')).rejects.toMatchObject({ code: 'denied' })
    c.audience = { kind: 'dm', spaceId: t.dm.id, openId: 'alice' }
    c.personalRead.expiresAt = NOW
    await expect(t.run('expired-proof')).rejects.toMatchObject({ code: 'denied' })
    expect(t.state.sent).toBe(1)
  })

  it.each(['missing-context', 'empty-actor', 'blank-actor', 'incomplete', 'no-sources', 'expired', 'archived-target', 'rebound-target', 'wrong-target-kind', 'outsider', 'admin-outsider', 'foreign-dm', 'forged-source'] as const)('fails closed before send for %s even under auto policy', async (bad) => {
    const t = setup({ mode: 'auto' })
    const c = t.context()
    if (bad === 'missing-context') t.setContext(undefined)
    if (bad === 'empty-actor') c.actorOpenId = ''
    if (bad === 'blank-actor') c.actorOpenId = '   '
    if (bad === 'incomplete') c.provenanceComplete = false
    if (bad === 'no-sources') c.sources = []
    if (bad === 'expired') c.expiresAt = NOW
    if (bad === 'archived-target') t.spaces.archive(t.a.id)
    if (bad === 'rebound-target') t.spaces.rebind(t.a.id, 'new_chat')
    if (bad === 'wrong-target-kind') c.audience = { kind: 'group', spaceId: t.dm.id, chatId: 'chat_dm' }
    if (bad === 'outsider') c.actorOpenId = 'outsider'
    if (bad === 'admin-outsider') c.actorOpenId = 'admin'
    if (bad === 'foreign-dm') c.audience = { kind: 'dm', spaceId: t.dm.id, openId: 'bob' }
    if (bad === 'forged-source') c.sources = [{ ref: 'forged', spaceId: t.b.id, chatId: 'chat_a' }]
    await expect(t.run()).rejects.toMatchObject({ code: 'denied' })
    expect(t.state.sent).toBe(0)
    expect(t.service.get('run-1:final:0')).toBeUndefined()
  })

  it('does not trust sources supplied with the model payload instead of host context', async () => {
    const t = setup()
    t.context().provenanceComplete = false
    await expect(t.service.deliver({ key: 'model-input', contextRef: 'trusted-run-1', payload, ...{ provenanceComplete: true, sources: [t.context().sources[0]] } })).rejects.toMatchObject({ code: 'denied' })
    expect(t.state.sent).toBe(0)
  })

  it('deployment deny still blocks an owner', async () => {
    const t = setup({ mode: 'deny' })
    await expect(t.run()).rejects.toMatchObject({ code: 'denied' })
    expect(t.state.sent).toBe(0)
  })

  it('uses the current actor and membership on replay, not the first actor or confirmed receipt', async () => {
    const t = setup()
    await t.run()
    t.context().actorOpenId = 'bob'
    await expect(t.run()).rejects.toMatchObject({ code: 'denied' })
    t.context().actorOpenId = 'alice'
    t.spaces.removeMember(t.a.id, 'alice')
    await expect(t.run()).rejects.toMatchObject({ code: 'denied' })
    expect(t.state).toMatchObject({ sent: 1, reads: 1 })
  })

  it('requires a precise current source-owner disclosure grant; an already granted member needs no extra confirmation', async () => {
    const t = setup()
    t.spaces.addMember(t.b.id, 'member', 'member')
    const c = t.context()
    c.actorOpenId = 'member'
    c.sources = [...c.sources, { ref: 'trusted-message-b', spaceId: t.b.id, chatId: 'chat_b' }]
    await expect(t.run()).rejects.toThrow('披露许可')
    c.grants = [{ id: 'grant-1', sourceRef: 'trusted-message-b', actorOpenId: 'member', audienceKey: deliveryAudienceKey(c.audience), grantedByOpenId: 'bob', expiresAt: NOW + 1000 }]
    expect(await t.run()).toMatchObject({ status: 'confirmed', grantIds: ['grant-1'] })
    expect(t.state.sent).toBe(1)
  })

  it.each(['expired', 'other-source', 'other-actor', 'other-audience', 'not-owner', 'revoked-owner', 'source-archived', 'source-rebound'] as const)('rejects a cross-space grant when %s', async (bad) => {
    const t = setup()
    t.spaces.addMember(t.b.id, 'alice', 'member')
    const c = t.context()
    c.sources = [...c.sources, { ref: 'trusted-message-b', spaceId: t.b.id, chatId: 'chat_b' }]
    const g = { id: 'grant-1', sourceRef: 'trusted-message-b', actorOpenId: 'alice', audienceKey: deliveryAudienceKey(c.audience), grantedByOpenId: 'bob', expiresAt: NOW + 1000 }
    c.grants = [g]
    if (bad === 'expired') g.expiresAt = NOW
    if (bad === 'other-source') g.sourceRef = 'not-this-source'
    if (bad === 'other-actor') g.actorOpenId = 'other'
    if (bad === 'other-audience') g.audienceKey = 'not-this-audience'
    if (bad === 'not-owner') g.grantedByOpenId = 'alice'
    if (bad === 'revoked-owner') t.spaces.removeMember(t.b.id, 'bob')
    if (bad === 'source-archived') t.spaces.archive(t.b.id)
    if (bad === 'source-rebound') t.spaces.rebind(t.b.id, 'new_b')
    await expect(t.run()).rejects.toMatchObject({ code: 'denied' })
    expect(t.state.sent).toBe(0)
  })
})

describe('delivery ledger', () => {
  it('records ACK as sent when no read-back adapter exists', async () => {
    const t = setup({ verify: false })
    expect(await t.run()).toMatchObject({ status: 'sent', replayed: false })
    expect(await t.run()).toMatchObject({ status: 'sent', replayed: true })
    expect(t.state).toMatchObject({ sent: 1, reads: 0 })
  })

  it('retries only GET after a read failure, never the accepted POST', async () => {
    const t = setup()
    t.state.readError = true
    await expect(t.run()).rejects.toMatchObject({ code: 'unconfirmed' })
    expect(t.service.get('run-1:final:0')).toMatchObject({ status: 'sent', remoteId: 'remote-1' })
    t.state.readError = false
    expect(await t.run()).toMatchObject({ status: 'confirmed', replayed: true })
    expect(t.state).toMatchObject({ sent: 1, reads: 2 })
  })

  it('does not call a different body or target the same delivery', async () => {
    const t = setup()
    await t.run()
    await expect(t.service.deliver({ key: 'run-1:final:0', contextRef: 'trusted-run-1', payload: { text: 'changed' } })).rejects.toMatchObject({ code: 'conflict' })
    t.context().audience = { kind: 'group', spaceId: t.a.id, chatId: 'chat_a', replyToMessageId: 'another-thread' }
    await expect(t.run()).rejects.toMatchObject({ code: 'conflict' })
    expect(t.state.sent).toBe(1)
  })

  it('lets only one independent service instance send the same key', async () => {
    const t = setup()
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    t.delaySend(() => blocked)
    const first = t.run()
    while (t.state.sent === 0) await new Promise((r) => setTimeout(r, 1))
    const second = new DeliveryService(t.registry.db, t.deps)
    await expect(second.deliver({ key: 'run-1:final:0', contextRef: 'trusted-run-1', payload })).rejects.toMatchObject({ code: 'unknown' })
    release()
    await first
    expect(t.state.sent).toBe(1)
  })

  it('persists unknown across reopening; explicit verified reconciliation never resends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-delivery-'))
    const path = join(dir, 'db.sqlite')
    const t = setup({ path })
    try {
      t.state.unknown = true
      await expect(t.run()).rejects.toMatchObject({ code: 'unknown' })
      t.registry.close()
      const reopened = new Registry(path)
      try {
        const service = new DeliveryService(reopened.db, { ...t.deps, ...spaceDeps(reopened.db) })
        await expect(service.deliver({ key: 'run-1:final:0', contextRef: 'trusted-run-1', payload })).rejects.toMatchObject({ code: 'unknown' })
        expect(t.state).toMatchObject({ sent: 1, reads: 0 })
        t.state.readMatches = false
        await expect(service.reconcile('run-1:final:0', 'remote-1')).rejects.toMatchObject({ code: 'unconfirmed' })
        expect(service.get('run-1:final:0')?.status).toBe('unknown')
        t.state.readMatches = true
        expect(await service.reconcile('run-1:final:0', 'remote-1')).toMatchObject({ status: 'confirmed' })
        expect(t.state.sent).toBe(1)
      } finally { reopened.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('recovers abandoned planned records as unknown and keeps acknowledged sends', async () => {
    const t = setup({ verify: false })
    await t.run()
    t.registry.db.prepare("UPDATE deliveries SET status = 'planned', remote_id = NULL WHERE delivery_key = ?").run('run-1:final:0')
    expect(t.service.recoverInterrupted()).toBe(1)
    await expect(t.run()).rejects.toMatchObject({ code: 'unknown' })
    expect(t.state.sent).toBe(1)
    await t.run('another-effect')
    expect(t.service.recoverInterrupted()).toBe(0)
    expect(t.service.get('another-effect')?.status).toBe('sent')
  })
})
