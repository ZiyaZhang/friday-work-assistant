import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { PersonalLocalWork } from '../src/personal/local-work.js'
import { PersonalResults } from '../src/personal/results.js'
import { DesktopLocalWork } from '../src/personal/desktop-local.js'
import { LocalWorkCards } from '../src/feishu/local-work-cards.js'
import { Registry } from '../src/core/registry.js'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(fn => fn()))
function fixture() {
  const db = new DatabaseSync(':memory:'); cleanups.push(() => db.close())
  let now = Date.now(), allowed = true, revoked = false
  const id = randomUUID(), audience = (owner: string) => { if (owner !== 'alice') throw new Error('owner denied'); return { chatId: 'alice-dm' } }
  const guard = () => { if (revoked) throw new Error('device revoked') }
  const actor = { owner: 'alice', deviceId: id, assertCurrent: guard, disconnect() {} }
  const results = new PersonalResults(db, async (_value, current) => {
    const assertCurrent = () => { current(); if (!allowed) throw new Error('source denied') }
    assertCurrent(); return { status: 'allowed', assertCurrent }
  })
  results.save({ body: 'Review [PR #7](https://github.com/example/demo/pull/7).', provenance: { sources: {}, memoryRefs: [] },
    origin: { taskId: 7, ownerOpenId: 'alice', spaceId: 'sp_dm_alice', chatType: 'p2p' } } as any, now)
  const store = new PersonalLocalWork({ db, results, audience, now: () => now,
    devices: { list: () => [{ id, label: 'Alice Mac', revokedAt: revoked ? now : null, expiresAt: now + 100000 }] } as any })
  const changed = vi.fn(), desktop = new DesktopLocalWork({ work: store, changed })
  const run = async (input: unknown, caller = actor) => (await desktop.prepare(caller.owner, input, caller.assertCurrent))(caller)
  const create = async () => (await run({ operation: 'local-create', text: 'Check implementation', sourceTaskId: 7 })) as any
  const claim = async (work: { id: string; revision: number }) => {
    const current = store.get('alice', work.id), input = { operation: 'local-claim', ...work, attempt: randomUUID(), sessionId: randomUUID(),
      fingerprint: store.fingerprint(current), directory: '/synthetic/repo', model: 'current / model' }
    await run(input); return input
  }
  return { db, store, results, actor, run, create, claim, changed, audience, advance(ms: number) { now += ms }, deny() { allowed = false }, revoke() { revoked = true } }
}
describe('personal local execution lifecycle', () => {
  it('previews only the owner’s chosen material, fixes one device and refuses duplicate or altered claims', async () => {
    const f = fixture(), created = await f.create()
    const preview = await f.run({ operation: 'local-get', id: created.id }) as any
    expect(preview).toMatchObject({ state: 'queued', material: expect.stringContaining('PR #7'), deviceId: f.actor.deviceId })
    expect(preview).not.toHaveProperty('provenance')
    const claim = await f.claim(created)
    await expect(f.run(claim)).rejects.toThrow('已开始')
    await expect(f.run({ operation: 'local-get', id: created.id }, { ...f.actor, owner: 'bob' })).rejects.toThrow('owner')
    const second = await f.create()
    await expect(f.claim(second)).rejects.toThrow('还有工作')
    expect(f.store.list('alice')).toHaveLength(2)
  })
  it('stop and deadline defeat a late completion, while silence remains an unknown state', async () => {
    const f = fixture(), created = await f.create(), claim = await f.claim(created)
    f.advance(46000)
    expect(f.store.view(f.store.get('alice', created.id)).label).toContain('待核实')
    f.store.stop('alice', created.id, 2)
    expect(await f.run({ operation: 'local-event', id: created.id, attempt: claim.attempt, state: 'completed', body: 'Late answer' })).toMatchObject({ state: 'stopped' })
    expect(f.store.get('alice', created.id).result).toBeUndefined()
    const second = await f.create(), other = await f.claim(second)
    f.advance(600001)
    expect(await f.run({ operation: 'local-event', id: second.id, attempt: other.attempt, state: 'heartbeat' })).toMatchObject({ state: 'stopping', stop: true })
    expect(f.store.get('alice', second.id).state).not.toBe('completed')
  })
  it('withdrawn context stops only its own running attempt and hides old context on a fresh read', async () => {
    const f = fixture(), created = await f.create(), claim = await f.claim(created)
    f.deny()
    await expect(f.run({ operation: 'local-get', id: created.id })).rejects.toThrow('source denied')
    expect(await f.run({ operation: 'local-list' })).toEqual({ items: [] })
    await expect(f.run({ operation: 'local-event', id: created.id, attempt: claim.attempt, state: 'heartbeat' }, { ...f.actor, deviceId: randomUUID() })).rejects.toThrow('不属于')
    expect(f.store.get('alice', created.id).state).toBe('running')
    expect(await f.run({ operation: 'local-event', id: created.id, attempt: claim.attempt, state: 'heartbeat' })).toMatchObject({ state: 'stopped', stop: true })
  })
  it('does not accept empty completion, overwrite a delivered result, or read after device revocation', async () => {
    const f = fixture(), created = await f.create(), claim = await f.claim(created)
    const event = { operation: 'local-event', id: created.id, attempt: claim.attempt, state: 'completed' }
    await expect(f.run(event)).rejects.toThrow('有效结果')
    await f.run({ ...event, body: 'Final answer.' }); await f.run({ ...event, body: 'Changed answer.' })
    expect(f.store.get('alice', created.id).result).toBe('Final answer.')
    f.revoke(); await expect(f.run({ operation: 'local-get', id: created.id })).rejects.toThrow('revoked')
  })
  it('updates the same Feishu card with working links and horizontal actions; another user cannot stop it', async () => {
    const f = fixture(), created = await f.create(), claim = await f.claim(created), registry = new Registry(':memory:')
    cleanups.push(() => registry.close())
    const feishu = { sendToUserOnce: vi.fn(async () => 'card1'), patchCard: vi.fn(async () => {}) }
    const cards = new LocalWorkCards({ work: f.store, registry, feishu, audience: f.audience, assertActive() {}, background() {} })
    await cards.show('alice', created.id)
    const card = feishu.sendToUserOnce.mock.calls[0]![1] as any
    expect(card.card.body.elements.at(-1)).toMatchObject({ tag: 'column_set', columns: expect.any(Array) })
    expect(cards.handle({ messageId: 'card1', chatId: 'alice-dm', operatorOpenId: 'bob', value: { action: 'local_work', id: created.id, revision: 2, op: 'stop' } } as any)).toHaveProperty('toast')
    await f.run({ operation: 'local-event', id: created.id, attempt: claim.attempt, state: 'completed', body: '[PR #7](https://github.com/example/demo/pull/7)' })
    await cards.show('alice', created.id)
    expect(feishu.sendToUserOnce).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(feishu.patchCard.mock.calls)).toContain('[PR #7](https://github.com/example/demo/pull/7)')
  })
})
