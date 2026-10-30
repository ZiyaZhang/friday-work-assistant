import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import worker from '../cloudflare/friday-oauth/src/worker.js'
import { createRelayState } from '../src/feishu/oauth-relay.js'
import { deviceEnvelopePurpose, deviceTicket, openDevice, openPairing, sealDevice } from '../src/personal/device-crypto.js'
import { DeviceError, PersonalDevices, type DeviceCredentials } from '../src/personal/devices.js'
import { PersonalDesktopBridge } from '../src/personal/desktop-bridge.js'

const BASE = 'https://friday.test', TOKEN = 'synthetic-desktop-transport-secret'
const databases: DatabaseSync[] = []
const bridges: PersonalDesktopBridge[] = [], releases: (() => void)[] = []
afterEach(async () => {
  releases.splice(0).forEach(release => release())
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()))
  databases.splice(0).forEach(db => db.close())
})
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  return { promise, release }
}
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  db.exec(readFileSync(new URL('../cloudflare/friday-oauth/schema.sql', import.meta.url), 'utf8'))
  const env = { RELAY_TOKEN: TOKEN, DB: { prepare(sql: string) {
    let args: unknown[] = []
    const stmt = { bind(...values: unknown[]) { args = values; return stmt },
      async run() { return { success: true, results: db.prepare(sql).all(...args as never[]) } },
      async first() { return db.prepare(sql).get(...args as never[]) },
      async all() { return { results: db.prepare(sql).all(...args as never[]) } } }
    return stmt
  } } }
  const post = (path: string, body: unknown, token?: string, origin?: string) => worker.fetch(new Request(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
    body: JSON.stringify(body) }), env)
  return { db, env, post }
}
const bridgeKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
function bridgeFixture(prepare: NonNullable<ConstructorParameters<typeof PersonalDesktopBridge>[0]['prepare']> = async () => undefined) {
  const t = fixture(), devices = new PersonalDevices({ db: t.db, encryptionKey: Buffer.alloc(32, 5), relayToken: TOKEN,
    baseUrl: BASE, lifetimeMs: 86_400_000, assertOwner(owner) { if (owner !== 'alice') throw new DeviceError('denied', 'Wrong owner') } })
  const link = devices.begin('alice'), pair = devices.request(link.state, { label: 'Alice Mac',
    publicKey: bridgeKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') })
  const approved = devices.approve('alice', pair.state, pair.requestHash!)
  const credentials = openPairing<DeviceCredentials>(bridgeKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    approved.result!, `friday-device-pair:${pair.state}`)
  const key = Buffer.from(credentials.key, 'base64url')
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => worker.fetch(new Request(String(url), init), t.env))
  const execute = vi.fn((actor, request) => { actor.assertCurrent(); return { accepted: request.operation } })
  const afterCommit = vi.fn(), afterRollback = vi.fn(), warn = vi.fn()
  let enabled = true
  const preparing = vi.fn(prepare)
  const bridge = new PersonalDesktopBridge({ devices, baseUrl: BASE, token: TOKEN, fetch: fetch as typeof globalThis.fetch,
    enabled: () => enabled, changed: async () => {}, prepare: preparing, execute, afterCommit, afterRollback, warn })
  bridges.push(bridge)
  const submit = async (command: unknown) => {
    const requestId = randomUUID(), payload = sealDevice(key, command, deviceEnvelopePurpose(credentials.id, requestId, 'request'))
    expect((await t.post('/desktop/request', { requestId, payload }, credentials.ticket)).status).toBe(202)
    return requestId
  }
  const receipt = async (requestId: string) => {
    await vi.waitFor(() => expect(t.db.prepare('SELECT result FROM desktop_requests WHERE request_id=?').get(requestId)?.result).toBeTruthy())
    const reply = await (await t.post('/desktop/result', { requestId }, credentials.ticket)).json() as { payload?: string; error?: string }
    return reply.payload ? openDevice(key, reply.payload, deviceEnvelopePurpose(credentials.id, requestId, 'response')) : reply
  }
  return { ...t, bridge, devices, credentials, submit, receipt, prepare: preparing, execute, afterCommit, afterRollback, warn, fetch,
    disable: () => { enabled = false } }
}
describe('encrypted desktop relay', () => {
  it('admits only signed desktop pairs and pins the first desktop key through a lost response', async () => {
    const t = fixture(), state = createRelayState(TOKEN, Date.now(), 'desktop')
    const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
    const input = { state, label: 'Alice Mac', publicKey }
    expect((await t.post('/desktop/pair', { ...input, state: createRelayState(TOKEN) })).status).toBe(410)
    expect((await t.post('/desktop/pair', input, undefined, 'https://attacker.test')).status).toBe(403)
    const reply = await (await t.post('/desktop/pair', input)).json() as any
    expect(reply).toMatchObject({ state: 'pending' })
    expect(await (await t.post('/desktop/pair', input)).json()).toEqual(reply)
    expect((await t.post('/desktop/pair', { ...input, label: 'Other machine' })).status).toBe(409)
    expect((await t.post('/desktop/relay/pairs', { states: [state] })).status).toBe(401)
    const requests = await (await t.post('/desktop/relay/pairs', { states: [state] }, TOKEN)).json() as any
    expect(requests.pairs).toEqual([{ ...input, requestHash: reply.requestHash }])
    expect((await t.post('/desktop/relay/pair-result', { state, requestHash: reply.requestHash, result: { state: 'approved', key: 'plaintext-secret', body: 'bad' } }, TOKEN)).status).toBe(400)
    await t.post('/desktop/relay/pair-result', { state, requestHash: reply.requestHash, result: { state: 'rejected' } }, TOKEN)
    expect(await (await t.post('/desktop/pair/status', { state, requestHash: reply.requestHash })).json()).toMatchObject({ state: 'rejected' })
  })
  it('isolates device queues, retries without duplication and never stores plaintext transport tickets', async () => {
    const t = fixture(), device = randomUUID(), requestId = randomUUID(), token = deviceTicket(TOKEN, device, Date.now() + 3_600_000)
    const payload = sealDevice(Buffer.alloc(32, 1), { privateText: 'Alice-only body' }, 'test')
    expect((await t.post('/desktop/request', { requestId, payload }, 'forged')).status).toBe(401)
    expect((await t.post('/desktop/request', { requestId, payload }, token)).status).toBe(202)
    expect((await t.post('/desktop/request', { requestId, payload }, token)).status).toBe(202)
    expect(t.db.prepare('SELECT count(*) n FROM desktop_requests').get()?.n).toBe(1)
    const stored = JSON.stringify(t.db.prepare('SELECT * FROM desktop_requests').all())
    expect(stored).not.toContain(token); expect(stored).not.toContain('Alice-only body')
    const other = deviceTicket(TOKEN, randomUUID(), Date.now() + 3_600_000)
    expect((await t.post('/desktop/result', { requestId }, other)).status).toBe(404)
    expect((await t.post('/desktop/relay/requests', {})).status).toBe(401)
    const claimed = await (await t.post('/desktop/relay/requests', {}, TOKEN)).json() as any
    expect(claimed.requests).toEqual([{ deviceId: device, requestId, ticket: token, payload }])
    const result = { payload: sealDevice(Buffer.alloc(32, 1), { ok: true }, 'response') }
    await t.post('/desktop/relay/result', { deviceId: device, requestId, result }, TOKEN)
    expect(await (await t.post('/desktop/result', { requestId }, token)).json()).toEqual(result)
    expect((await t.post('/desktop/request', { requestId, payload: payload + 'x' }, token)).status).toBe(409)
    expect((await (await t.post('/desktop/relay/requests', {}, TOKEN)).json() as any).requests).toEqual([])
  })
  it('caps a device queue, expires requests and removes old encrypted material', async () => {
    const t = fixture(), token = deviceTicket(TOKEN, randomUUID(), Date.now() + 3_600_000), payload = 'a.b.c'
    for (let n = 0; n < 16; n++) expect((await t.post('/desktop/request', { requestId: randomUUID(), payload }, token)).status).toBe(202)
    expect((await t.post('/desktop/request', { requestId: randomUUID(), payload }, token)).status).toBe(429)
    // A delivered response frees queue capacity immediately. Fifteen-second
    // UI refreshes must not exhaust the queue during receipt retention.
    const first = t.db.prepare('SELECT device_id,request_id FROM desktop_requests LIMIT 1').get()!
    await t.post('/desktop/relay/result', { deviceId: first.device_id, requestId: first.request_id, result: { error: 'denied' } }, TOKEN)
    expect((await t.post('/desktop/request', { requestId: randomUUID(), payload }, token)).status).toBe(202)
    expect((await t.post('/desktop/request', { requestId: randomUUID(), payload: 'x'.repeat(100_000) }, token)).status).toBe(400)
    t.db.prepare('UPDATE desktop_requests SET expires_at=?').run(Date.now() - 1000)
    await worker.scheduled({}, t.env)
    expect(t.db.prepare("SELECT count(*) n FROM desktop_requests WHERE request!=''").get()?.n).toBe(0)
    t.db.prepare('UPDATE desktop_requests SET expires_at=0').run()
    await worker.scheduled({}, t.env)
    expect(t.db.prepare('SELECT count(*) n FROM desktop_requests').get()?.n).toBe(0)
  })
})

describe('bounded desktop bridge preparation', () => {
  it('delivers same-page and later-page messages while an earlier result is still preparing', async () => {
    const slow = gate(), t = bridgeFixture(async (_owner, input, current) => {
      if ((input as { operation: string }).operation !== 'result') return
      await slow.promise
      return () => { current(); return { body: 'Authorized answer' } }
    })
    const read = await t.submit({ operation: 'result', taskId: 1 }), first = await t.submit({ operation: 'message', text: 'First' })
    await t.bridge.tick()
    expect(await t.receipt(first)).toEqual({ accepted: 'message' })
    const second = await t.submit({ operation: 'message', text: 'Second' })
    await t.bridge.tick()
    expect(await t.receipt(second)).toEqual({ accepted: 'message' })
    expect(t.db.prepare('SELECT result FROM desktop_requests WHERE request_id=?').get(read)?.result).toBeNull()
    expect(t.prepare.mock.calls.filter(([, input]) => (input as { operation: string }).operation === 'result')).toHaveLength(1)
    slow.release()
    expect(await t.receipt(read)).toEqual({ body: 'Authorized answer' })
  })

  it('caps in-flight work across polls and leaves excess requests in the durable relay queue', async () => {
    const slow = gate(), t = bridgeFixture(async () => { await slow.promise })
    const ids = await Promise.all(Array.from({ length: 7 }, () => t.submit({ operation: 'message', text: 'Queued' })))
    await t.bridge.tick(); await t.bridge.tick()
    expect(t.prepare).toHaveBeenCalledTimes(4)
    expect(t.execute).not.toHaveBeenCalled()
    expect(t.db.prepare('SELECT count(*) n FROM desktop_requests WHERE result IS NULL').get()?.n).toBe(7)
    slow.release()
    await vi.waitFor(() => expect(t.afterCommit).toHaveBeenCalledTimes(4))
    // Response uploads keep their slot until they settle; a later poll picks up the remainder.
    await vi.waitFor(async () => { await t.bridge.tick(); expect(t.afterCommit).toHaveBeenCalledTimes(7) })
    for (const id of ids) expect(await t.receipt(id)).toEqual({ accepted: 'message' })
    expect(t.prepare).toHaveBeenCalledTimes(7)
  })

  it('deduplicates overlapping polls and retries a failed upload without executing the mutation twice', async () => {
    const slow = gate(), t = bridgeFixture(async () => { await slow.promise })
    const id = await t.submit({ operation: 'message', text: 'Exactly once' }), original = t.fetch.getMockImplementation()!
    let failUpload = true
    t.fetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/desktop/relay/result') && failUpload) { failUpload = false; throw new Error('Upload lost') }
      return original(url, init)
    })
    await Promise.all([t.bridge.tick(), t.bridge.tick()]); await t.bridge.tick()
    expect(t.prepare).toHaveBeenCalledTimes(1)
    slow.release()
    await vi.waitFor(() => expect(t.warn).toHaveBeenCalledWith('Desktop relay request deferred'))
    await t.bridge.tick()
    expect(await t.receipt(id)).toEqual({ accepted: 'message' })
    expect(t.execute).toHaveBeenCalledTimes(1)
    expect(t.db.prepare('SELECT count(*) n FROM personal_device_operations WHERE request_id=?').get(id)?.n).toBe(1)
  })

  it('rechecks the device after an overlapping preparation and rejects a revoked device', async () => {
    const slow = gate(), commit = vi.fn(() => ({ body: 'Private answer' }))
    const t = bridgeFixture(async () => { await slow.promise; return commit })
    const id = await t.submit({ operation: 'result', taskId: 1 })
    await t.bridge.tick()
    t.devices.revoke('alice', t.credentials.id, 1)
    slow.release()
    expect(await t.receipt(id)).toEqual({ error: 'expired' })
    expect(commit).not.toHaveBeenCalled()
    expect(t.afterCommit).not.toHaveBeenCalled()
    expect(t.db.prepare('SELECT count(*) n FROM personal_device_operations').get()?.n).toBe(0)
  })

  it('revalidates a read on upload retry and never retains its authorized body as a mutation receipt', async () => {
    let allowed = true
    const t = bridgeFixture(async (_owner, _input, current) => {
      current()
      if (!allowed) throw new DeviceError('denied', 'Source revoked')
      return () => { current(); return { body: 'Private answer' } }
    })
    const original = t.fetch.getMockImplementation()!, id = await t.submit({ operation: 'result', taskId: 1 })
    let failUpload = true
    t.fetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/desktop/relay/result') && failUpload) { failUpload = false; throw new Error('Upload lost') }
      return original(url, init)
    })
    await t.bridge.tick()
    await vi.waitFor(() => expect(t.warn).toHaveBeenCalledWith('Desktop relay request deferred'))
    expect(t.db.prepare('SELECT result FROM personal_device_operations WHERE request_id=?').get(id)?.result).toBeNull()
    allowed = false
    await t.bridge.tick()
    expect(await t.receipt(id)).toEqual({ error: 'denied' })
    expect(t.prepare).toHaveBeenCalledTimes(2)
    expect(t.afterCommit).toHaveBeenCalledTimes(1)
  })

  it.each(['close', 'disable'])('does not commit a late preparation after %s', async state => {
    const slow = gate(), commit = vi.fn(() => ({ body: 'Private answer' }))
    const t = bridgeFixture(async () => { await slow.promise; return commit })
    const id = await t.submit({ operation: 'result', taskId: 1 })
    await t.bridge.tick()
    let drained = false
    const closing = state === 'close' ? t.bridge.close().then(() => { drained = true }) : (t.disable(), undefined)
    await Promise.resolve()
    expect(drained).toBe(false)
    slow.release()
    if (closing) await closing
    else await vi.waitFor(() => expect(t.afterRollback).toHaveBeenCalledTimes(1))
    expect(commit).not.toHaveBeenCalled()
    expect(t.afterCommit).not.toHaveBeenCalled()
    expect(t.db.prepare('SELECT result FROM desktop_requests WHERE request_id=?').get(id)?.result).toBeNull()
    expect(t.db.prepare('SELECT count(*) n FROM personal_device_operations').get()?.n).toBe(0)
  })
})
