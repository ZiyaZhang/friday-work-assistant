import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { PersonalDevices, type DeviceCredentials } from '../src/personal/devices.js'
import { deviceEnvelopePurpose, openDevice, openPairing, sealDevice, verifyDeviceTicket } from '../src/personal/device-crypto.js'

const KEY = Buffer.alloc(32, 7), TOKEN = 'synthetic-relay-token-device-tests'
const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach(db => db.close()))
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  let now = Date.parse('2026-09-30T00:00:00Z'), active = true
  const deps = { db, encryptionKey: KEY, relayToken: TOKEN, baseUrl: 'https://example.test', lifetimeMs: 86_400_000,
    now: () => now, assertOwner(owner: string) { if (!active || !['alice', 'bob'].includes(owner)) throw new Error('Unavailable owner') } }
  const devices = new PersonalDevices(deps)
  const pair = (owner = 'alice') => {
    const { state } = devices.begin(owner), pending = devices.request(state, { label: 'My Mac', publicKey })
    const approved = devices.approve(owner, state, pending.requestHash!)
    return { state, pending, credentials: openPairing<DeviceCredentials>(privateKey, approved.result!, `friday-device-pair:${state}`) }
  }
  return { db, deps, devices, pair, advance: (ms: number) => { now += ms }, disable: () => { active = false } }
}
describe('personal desktop identity and operations', () => {
  it('requires a matching owner approval, pins the first requesting device and seals credentials to that device', () => {
    const t = fixture(), { state } = t.devices.begin('alice'), request = t.devices.request(state, { label: 'Mac', publicKey })
    expect(state).toMatch(/^dp1\./)
    expect(() => t.devices.approve('bob', state, request.requestHash!)).toThrow('本人')
    expect(() => t.devices.approve('alice', state, 'changed')).toThrow('本人')
    expect(() => t.devices.request(state, { label: 'Other Mac', publicKey })).toThrow('其他设备')
    const result = t.devices.approve('alice', state, request.requestHash!).result!
    expect(t.devices.approve('alice', state, request.requestHash!).result).toEqual(result)
    const credentials = openPairing<DeviceCredentials>(privateKey, result, `friday-device-pair:${state}`)
    expect(verifyDeviceTicket(TOKEN, credentials.ticket, t.deps.now()).id).toBe(credentials.id)
    const stored = JSON.stringify(t.db.prepare('SELECT * FROM personal_devices').all())
    expect(stored).not.toContain(credentials.key)
    expect(JSON.stringify(t.devices.list('alice'))).not.toContain('secret')
    expect(t.devices.list('bob')).toEqual([])
    expect(() => openPairing(privateKey, result, 'another-pair')).toThrow()
  })
  it('rejects declined and expired pairing and does not extend old links on retry', () => {
    const t = fixture(), { state } = t.devices.begin('alice')
    const request = t.devices.request(state, { label: 'Mac', publicKey })
    t.devices.reject('alice', state)
    expect(() => t.devices.approve('alice', state, request.requestHash!)).toThrow('已变化')
    t.advance(11 * 60_000)
    expect(() => t.devices.request(state, { label: 'Mac', publicKey })).toThrow('过期')
    expect(t.devices.list('alice')).toEqual([])
  })
  it('deduplicates an accepted mutation across retries and restarts, and rejects altered ciphertext or request identity', () => {
    const t = fixture(), { credentials: c } = t.pair(), id = randomUUID(), key = Buffer.from(c.key, 'base64url')
    t.db.exec('CREATE TABLE outcomes (id TEXT PRIMARY KEY, owner TEXT)')
    const payload = sealDevice(key, { action: 'complete', todo: 42 }, deviceEnvelopePurpose(c.id, id, 'request'))
    let called = 0
    const run = (actor: { owner: string }, request: unknown) => {
      called++; expect(request).toEqual({ action: 'complete', todo: 42 })
      t.db.prepare('INSERT INTO outcomes VALUES (?,?)').run(id, actor.owner)
      return { ok: true }
    }
    const result = t.devices.execute(c.ticket, id, payload, run)
    expect(openDevice(key, result, deviceEnvelopePurpose(c.id, id, 'response'))).toEqual({ ok: true })
    expect(new PersonalDevices(t.deps).execute(c.ticket, id, payload, run)).toBe(result)
    expect(called).toBe(1)
    expect(t.db.prepare('SELECT owner FROM outcomes').get()).toMatchObject({ owner: 'alice' })
    const changed = sealDevice(key, { action: 'ignore', todo: 42 }, deviceEnvelopePurpose(c.id, id, 'request'))
    expect(() => t.devices.execute(c.ticket, id, changed, run)).toThrow('已提交')
    expect(() => t.devices.execute(c.ticket, randomUUID(), payload, run)).toThrow('验证失败')
  })
  it('rolls back failed local operations; revocation, expiry and owner deactivation take effect before cached results', () => {
    const t = fixture(), { credentials: c } = t.pair(), id = randomUUID(), key = Buffer.from(c.key, 'base64url')
    t.db.exec('CREATE TABLE outcomes (id INTEGER)')
    const payload = sealDevice(key, {}, deviceEnvelopePurpose(c.id, id, 'request'))
    expect(() => t.devices.execute(c.ticket, id, payload, () => { t.db.exec('INSERT INTO outcomes VALUES (1)'); throw new Error('failed') })).toThrow('failed')
    expect(t.db.prepare('SELECT count(*) n FROM outcomes').get()?.n).toBe(0)
    t.devices.execute(c.ticket, id, payload, () => ({ ok: true }))
    expect(() => t.devices.revoke('bob', c.id, 1)).toThrow('变化')
    t.devices.revoke('alice', c.id, 1)
    expect(() => t.devices.execute(c.ticket, id, payload, () => ({}))).toThrow('失效')
    const b = t.pair('bob').credentials
    t.advance(86_400_001)
    expect(() => t.devices.execute(b.ticket, id, payload, () => ({}))).toThrow('失效')
    t.disable()
    expect(() => t.devices.begin('alice')).toThrow('owner')
  })
  it.each(['conversation', 'email-list', 'email-get', 'local-list', 'local-get'])('keeps %s request identity without retaining private bodies and rechecks it on replay', operation => {
    const t = fixture(), { credentials: c } = t.pair(), id = randomUUID(), key = Buffer.from(c.key, 'base64url')
    const payload = sealDevice(key, { operation }, deviceEnvelopePurpose(c.id, id, 'request'))
    const first = t.devices.execute(c.ticket, id, payload, () => ({ body: 'Old answer' }))
    const next = t.devices.execute(c.ticket, id, payload, () => ({ body: 'Updated answer' }))
    expect(openDevice(key, first, deviceEnvelopePurpose(c.id, id, 'response'))).toEqual({ body: 'Old answer' })
    expect(openDevice(key, next, deviceEnvelopePurpose(c.id, id, 'response'))).toEqual({ body: 'Updated answer' })
    expect(t.db.prepare('SELECT result FROM personal_device_operations').get()?.result).toBeNull()
    const changed = sealDevice(key, { operation: 'item' }, deviceEnvelopePurpose(c.id, id, 'request'))
    expect(() => t.devices.execute(c.ticket, id, changed, () => ({}))).toThrow('已提交')
    t.advance(86_400_001); expect(t.devices.hasConnections()).toBe(false)
    expect(t.db.prepare('SELECT count(*) n FROM personal_device_operations').get()?.n).toBe(0)
    expect(t.db.prepare('SELECT secret FROM personal_devices').get()?.secret).toBe('')
  })
})
