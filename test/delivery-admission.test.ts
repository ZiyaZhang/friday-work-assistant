import { afterEach, describe, expect, it } from 'vitest'
import { DeliveryError, DeliveryService, type DeliveryContext, type DeliveryDependencies } from '../src/core/delivery.js'
import { Registry } from '../src/core/registry.js'
import { spaceDeps } from './helpers/space.js'

const registries: Registry[] = []
afterEach(() => { for (const registry of registries.splice(0)) registry.close() })
function fixture() {
  const registry = new Registry(':memory:'); registries.push(registry)
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'chat', openId: 'alice' })
  const context: DeliveryContext = { actorOpenId: 'alice', audience: { kind: 'group', spaceId: space.id, chatId: 'chat' },
    sources: [{ ref: 'origin', spaceId: space.id, chatId: 'chat' }], expiresAt: Date.now() + 60_000, provenanceComplete: true }
  let sends = 0
  const deps: DeliveryDependencies = { ...sp, resolveContext: async () => context, send: async () => ({ remoteId: `remote-${++sends}` }) }
  const service = new DeliveryService(registry.db, deps)
  const deliver = (key = 'intent:1') => service.deliver({ key, contextRef: key, payload: { text: '合成提醒' } })
  return { registry, deps, service, deliver, sends: () => sends }
}

describe('synchronous Delivery admission', () => {
  it('rolls back a rejected application claim without planned/unknown records or a POST', async () => {
    const t = fixture()
    t.registry.db.exec('CREATE TABLE admission_probe (id INTEGER)')
    t.deps.admit = () => { t.registry.db.exec('INSERT INTO admission_probe VALUES (1)'); throw new DeliveryError('denied', 'cancelled before admission') }
    await expect(t.deliver()).rejects.toMatchObject({ code: 'denied' })
    expect(t.service.get('intent:1')).toBeUndefined()
    expect(t.registry.db.prepare('SELECT * FROM admission_probe').all()).toEqual([])
    expect(t.sends()).toBe(0)
  })

  it('checks the application state after the resolver await rather than relying on its earlier snapshot', async () => {
    const t = fixture(), resolve = t.deps.resolveContext
    let active = true
    t.deps.resolveContext = async ref => { const c = await resolve(ref); queueMicrotask(() => { active = false }); return c }
    t.deps.admit = () => { if (!active) throw new DeliveryError('denied', 'revoked') }
    await expect(t.deliver()).rejects.toMatchObject({ code: 'denied' })
    expect(t.sends()).toBe(0)
    expect(t.service.get('intent:1')).toBeUndefined()
  })

  it('does not admit a second conflicting stage while another service has already claimed the same logical resource', async () => {
    const t = fixture()
    let release!: () => void, started!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { started = resolve })
    t.deps.admit = () => {
      if (t.registry.db.prepare("SELECT 1 FROM deliveries WHERE status IN ('planned','unknown')").get()) throw new DeliveryError('denied', 'prior stage unresolved')
    }
    const realSend = t.deps.send
    t.deps.send = async input => { const sent = await realSend(input); started(); await waiting; return sent }
    const first = t.deliver('todo:1:24h'); await entered
    const other = new DeliveryService(t.registry.db, t.deps)
    await expect(other.deliver({ key: 'todo:1:2h', contextRef: 'todo:1:2h', payload: { text: 'later stage' } })).rejects.toMatchObject({ code: 'denied' })
    expect(other.get('todo:1:2h')).toBeUndefined()
    release(); await first
    expect(t.sends()).toBe(1)
  })

  it('does not re-admit an already acknowledged intent', async () => {
    const t = fixture()
    await t.deliver()
    t.deps.admit = () => { throw new Error('must not re-admit sent receipt') }
    expect(await t.deliver()).toMatchObject({ status: 'sent', replayed: true, remoteId: 'remote-1' })
    expect(t.sends()).toBe(1)
  })

  it.each([false, true])('rejects an accidentally asynchronous admission (rejects=%s) before claiming or sending', async (rejects) => {
    const t = fixture()
    t.deps.admit = async () => { if (rejects) throw new Error('async rejection'); return undefined }
    await expect(t.deliver()).rejects.toMatchObject({ code: 'invalid' })
    expect(t.sends()).toBe(0)
    expect(t.service.get('intent:1')).toBeUndefined()
  })
})
