import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { createRelayState } from '../feishu/oauth-relay.js'
import { deviceEnvelopePurpose, devicePublicKey, deviceTicket, openDevice, sealDevice, sealPairing, verifyDeviceTicket } from './device-crypto.js'

const PAIR_TTL = 10 * 60_000
export interface PersonalDevice { id: string; owner: string; label: string; fingerprint: string; revision: number; createdAt: number; expiresAt: number; revokedAt: number | null; lastSeenAt: number | null }
export interface DeviceCredentials { id: string; key: string; ticket: string; expiresAt: number }
export interface DevicePair { state: string; owner: string; expiresAt: number; status: 'waiting' | 'requested' | 'approved' | 'rejected'; label?: string; publicKey?: string; fingerprint?: string; requestHash?: string; result?: { key: string; body: string } }
interface DeviceRow extends PersonalDevice { secret: string }
export interface DeviceActor { owner: string; deviceId: string; assertCurrent(): void; disconnect(): void }
export class DeviceError extends Error {
  constructor(readonly code: 'invalid' | 'expired' | 'denied' | 'conflict' | 'unavailable', message: string) { super(message); this.name = 'DeviceError' }
}
export function ensurePersonalDeviceSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS personal_devices (
    id TEXT PRIMARY KEY,owner TEXT NOT NULL,label TEXT NOT NULL,fingerprint TEXT NOT NULL,
    revision INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,last_seen_at INTEGER,secret TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS personal_devices_owner ON personal_devices(owner);
  CREATE TABLE IF NOT EXISTS personal_device_pairs (state TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL,data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS personal_device_operations (
    device_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,
    PRIMARY KEY(device_id,request_id)
  );`)
}

/** Pairing starts in an authenticated private Friday surface. A desktop request still needs the owner's approval. */
export class PersonalDevices {
  private cleanupAt = 0
  constructor(private readonly d: { db: DatabaseSync; encryptionKey: Buffer; relayToken: string; baseUrl: string; now?: () => number;
    lifetimeMs: number; assertOwner(owner: string): void }) {
    if (d.encryptionKey.length !== 32 || d.relayToken.length < 24 || !Number.isSafeInteger(d.lifetimeMs) || d.lifetimeMs < 60_000 || d.lifetimeMs > 90 * 86_400_000)
      throw new Error('Invalid desktop connection configuration')
    const url = new URL(d.baseUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Desktop relay requires an HTTPS origin')
    ensurePersonalDeviceSchema(d.db)
  }
  private now() { return this.d.now?.() ?? Date.now() }
  begin(owner: string): { state: string; url: string; expiresAt: number } {
    this.d.assertOwner(owner)
    const existing = this.pendingFor(owner)
    if (existing && ['waiting', 'requested'].includes(existing.status)) return { state: existing.state, expiresAt: existing.expiresAt, url: this.pairUrl(existing) }
    if (this.list(owner).filter(d => !d.revokedAt && d.expiresAt > this.now()).length >= 10) throw new DeviceError('conflict', '已连接 10 台设备，请先断开不再使用的设备。')
    const state = createRelayState(this.d.relayToken, this.now(), 'desktop'), expiresAt = this.now() + PAIR_TTL
    this.d.db.prepare('DELETE FROM personal_device_pairs WHERE owner=? OR expires_at<=?').run(owner, this.now())
    this.savePair({ state, owner, expiresAt, status: 'waiting' })
    return { state, expiresAt, url: `${new URL(this.d.baseUrl).origin}/desktop/pair#${state}` }
  }
  pending(): DevicePair[] {
    return this.d.db.prepare('SELECT data FROM personal_device_pairs WHERE expires_at>?').all(this.now()).map(row => JSON.parse(String(row.data)))
  }
  pendingFor(owner: string): DevicePair | undefined {
    this.d.assertOwner(owner)
    return this.pending().find(pair => pair.owner === owner)
  }
  pairUrl(pair: DevicePair): string { return `${new URL(this.d.baseUrl).origin}/desktop/pair#${pair.state}` }
  hasConnections(): boolean {
    if (this.now() >= this.cleanupAt) {
      this.d.db.prepare('DELETE FROM personal_device_operations WHERE device_id IN (SELECT id FROM personal_devices WHERE expires_at<=?)').run(this.now())
      this.d.db.prepare("UPDATE personal_devices SET secret='' WHERE expires_at<=? AND secret!=''").run(this.now())
      this.cleanupAt = this.now() + 3_600_000
    }
    // A revoked ticket may still reach the relay until its transport expiry.
    // Drain it with an explicit refusal, even if this was the last device.
    return Boolean(this.d.db.prepare('SELECT 1 FROM personal_devices WHERE expires_at>? LIMIT 1').get(this.now()))
  }
  private pair(state: string): DevicePair {
    const row = this.d.db.prepare('SELECT data FROM personal_device_pairs WHERE state=? AND expires_at>?').get(state, this.now())
    if (!row) throw new DeviceError('expired', '设备连接已过期，请重新发起。')
    const pair = JSON.parse(String(row.data)) as DevicePair
    this.d.assertOwner(pair.owner); return pair
  }
  private savePair(pair: DevicePair) {
    this.d.db.prepare('INSERT INTO personal_device_pairs(state,owner,expires_at,data) VALUES (?,?,?,?) ON CONFLICT(state) DO UPDATE SET data=excluded.data')
      .run(pair.state, pair.owner, pair.expiresAt, JSON.stringify(pair))
  }
  request(state: string, input: { label: string; publicKey: string }): DevicePair {
    const pair = this.pair(state)
    if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80 || /[\u0000-\u001f]/.test(input.label)) throw new DeviceError('invalid', '设备名称无效。')
    let fingerprint: string
    try { fingerprint = devicePublicKey(input.publicKey).fingerprint } catch { throw new DeviceError('invalid', '设备连接请求无效。') }
    const requestHash = digest(JSON.stringify([input.label, input.publicKey]))
    if (pair.requestHash) {
      if (pair.requestHash !== requestHash) throw new DeviceError('conflict', '已有其他设备请求使用这条连接，请重新发起。')
      return pair
    }
    const next = { ...pair, status: 'requested' as const, label: input.label.trim(), publicKey: input.publicKey, fingerprint, requestHash }
    this.savePair(next); return next
  }
  /** owner comes from the verified card/desktop actor; the request fingerprint is displayed before this operation. */
  approve(owner: string, state: string, requestHash: string): DevicePair {
    const pair = this.pair(state)
    if (owner !== pair.owner || !pair.requestHash || pair.requestHash !== requestHash) throw new DeviceError('denied', '这条连接只能由本人确认。')
    if (pair.status === 'approved') return pair
    if (pair.status !== 'requested' || !pair.publicKey || !pair.label || !pair.fingerprint) throw new DeviceError('conflict', '设备请求已变化，请重新打开。')
    if (this.list(owner).filter(d => !d.revokedAt && d.expiresAt > this.now()).length >= 10) throw new DeviceError('conflict', '已连接 10 台设备，请先断开不再使用的设备。')
    const id = randomUUID(), key = randomBytes(32), now = this.now(), expiresAt = now + this.d.lifetimeMs
    const credentials: DeviceCredentials = { id, key: key.toString('base64url'), ticket: deviceTicket(this.d.relayToken, id, expiresAt), expiresAt }
    const result = sealPairing(pair.publicKey, credentials, `friday-device-pair:${state}`)
    this.d.db.exec('SAVEPOINT approve_personal_device')
    try {
      this.d.db.prepare('INSERT INTO personal_devices(id,owner,label,fingerprint,revision,created_at,expires_at,secret) VALUES (?,?,?,?,1,?,?,?)')
        .run(id, owner, pair.label, pair.fingerprint, now, expiresAt, sealDevice(this.d.encryptionKey, credentials.key, `personal-device:${id}`))
      const next: DevicePair = { ...pair, status: 'approved', result }; this.savePair(next)
      this.d.db.exec('RELEASE approve_personal_device'); return next
    } catch (error) { this.d.db.exec('ROLLBACK TO approve_personal_device; RELEASE approve_personal_device'); throw error }
  }
  reject(owner: string, state: string): void {
    const pair = this.pair(state)
    if (owner !== pair.owner || pair.status === 'approved') throw new DeviceError('denied', '请在已连接设备中断开这台设备。')
    this.savePair({ ...pair, status: 'rejected' })
  }
  list(owner: string): PersonalDevice[] {
    this.d.assertOwner(owner)
    return this.d.db.prepare('SELECT * FROM personal_devices WHERE owner=? ORDER BY created_at DESC LIMIT 100').all(owner).map(row => visible(row))
  }
  revoke(owner: string, id: string, revision: number): void {
    this.d.assertOwner(owner)
    if (!this.d.db.prepare('UPDATE personal_devices SET revoked_at=?,revision=revision+1,secret=? WHERE id=? AND owner=? AND revision=? AND revoked_at IS NULL')
      .run(this.now(), '', id, owner, revision).changes) throw new DeviceError('conflict', '设备状态已变化，请刷新。')
  }
  private authenticate(ticket: string): DeviceRow {
    let transport: { id: string; expires: number }
    try { transport = verifyDeviceTicket(this.d.relayToken, ticket, this.now()) } catch { throw new DeviceError('expired', '设备连接已失效，请重新连接。') }
    const row = this.d.db.prepare('SELECT * FROM personal_devices WHERE id=?').get(transport.id)
    if (!row) throw new DeviceError('denied', '设备未连接。')
    const device = { ...visible(row), secret: String(row.secret) }
    this.d.assertOwner(device.owner)
    if (device.revokedAt !== null || device.expiresAt <= this.now() || device.expiresAt !== transport.expires) throw new DeviceError('expired', '设备连接已失效，请重新连接。')
    return device
  }
  /** Authorize a read preparation before its awaits; execute rechecks the same
   * device and encrypted command again before committing or releasing bytes. */
  prepare(ticket: string, requestId: string, payload: string) {
    if (!/^[0-9a-f-]{36}$/.test(requestId) || payload.length > 90_000) throw new DeviceError('invalid', '设备请求无效。')
    const device = this.authenticate(ticket)
    const key = Buffer.from(openDevice<string>(this.d.encryptionKey, device.secret, `personal-device:${device.id}`), 'base64url')
    let request: unknown
    try { request = openDevice(key, payload, deviceEnvelopePurpose(device.id, requestId, 'request')) } catch { throw new DeviceError('denied', '设备请求验证失败。') }
    const assertCurrent = () => { if (this.authenticate(ticket).revision !== device.revision) throw new DeviceError('expired', '设备已断开。') }
    return { request, owner: device.owner, assertCurrent }
  }
  /** Atomic local queries/mutations only. Async work must first persist an admission record and return its id. */
  execute(ticket: string, requestId: string, payload: string,
    run: (actor: DeviceActor, request: unknown) => unknown): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId) || typeof payload !== 'string' || payload.length > 90_000) throw new DeviceError('invalid', '设备请求无效。')
    const device = this.authenticate(ticket), hash = digest(payload)
    const key = Buffer.from(openDevice<string>(this.d.encryptionKey, device.secret, `personal-device:${device.id}`), 'base64url')
    let request: unknown
    try { request = openDevice(key, payload, deviceEnvelopePurpose(device.id, requestId, 'request')) } catch { throw new DeviceError('denied', '设备请求验证失败。') }
    // Polling may read a large conversation every fifteen seconds. Keep the
    // request identity but recompute read results under current access instead
    // of accumulating full encrypted conversation copies in the local database.
    const readOnly = request !== null && typeof request === 'object' && !Array.isArray(request) &&
      ['list', 'works', 'result', 'conversation', 'email-list', 'email-get', 'local-list', 'local-get', 'mcp-list', 'account-list'].includes(String((request as { operation?: unknown }).operation))
    const check = () => { const current = this.authenticate(ticket); if (current.revision !== device.revision) throw new DeviceError('expired', '设备已断开。') }
    const prior = this.d.db.prepare('SELECT * FROM personal_device_operations WHERE device_id=? AND request_id=?').get(device.id, requestId)
    if (prior) {
      if (prior.request_hash !== hash || prior.state !== 'complete') throw new DeviceError('conflict', '设备操作已提交，请查看当前状态。')
      check(); if (prior.result !== null) return String(prior.result)
    }
    this.d.db.exec('SAVEPOINT personal_device_operation')
    try {
      this.d.db.prepare('INSERT INTO personal_device_operations(device_id,request_id,request_hash,state,created_at) VALUES (?,?,?,\'running\',?) ON CONFLICT(device_id,request_id) DO NOTHING').run(device.id, requestId, hash, this.now())
      let disconnect = false
      const result = run({ owner: device.owner, deviceId: device.id, assertCurrent: check, disconnect: () => { disconnect = true } }, request)
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Desktop operations must persist before asynchronous execution')
      check()
      const response = sealDevice(key, result, deviceEnvelopePurpose(device.id, requestId, 'response'))
      if (response.length > 600_000) throw new DeviceError('invalid', '结果过长，请缩小读取范围。')
      this.d.db.prepare('UPDATE personal_device_operations SET state=\'complete\',result=? WHERE device_id=? AND request_id=?').run(readOnly ? null : response, device.id, requestId)
      this.d.db.prepare('UPDATE personal_devices SET last_seen_at=? WHERE id=?').run(this.now(), device.id)
      if (disconnect) this.revoke(device.owner, device.id, device.revision)
      this.d.db.exec('RELEASE personal_device_operation'); return response
    } catch (error) { this.d.db.exec('ROLLBACK TO personal_device_operation; RELEASE personal_device_operation'); throw error }
  }
}
function visible(row: Record<string, unknown>): PersonalDevice {
  return { id: String(row.id), owner: String(row.owner), label: String(row.label), fingerprint: String(row.fingerprint), revision: Number(row.revision),
    createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), revokedAt: row.revoked_at === null ? null : Number(row.revoked_at), lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at) }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
