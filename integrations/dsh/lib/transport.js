import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { devicePublicKey, deviceEnvelopePurpose, openDevice, openPairing, sealDevice } from './device-crypto.js'

export const RELAY = 'https://friday-oauth.example.workers.dev'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const errors = { expired: '这台设备的连接已失效，请重新连接。', denied: '当前连接不能读取这项内容。', conflict: '内容已经更新，请刷新后再操作。',
  unavailable: 'Friday 暂时未能完成这次操作，请刷新查看当前状态。', busy: '还有操作在处理，稍后再试。', invalid: '这个操作暂不可用，请刷新。' }
export class FridayClient {
  constructor({ directory, fetch = globalThis.fetch, relay = RELAY, now = Date.now }) {
    const origin = new URL(relay)
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid Friday origin')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Friday storage must be a directory')
    chmodSync(directory, 0o700)
    this.directory = directory; this.fetch = fetch; this.relay = origin.origin; this.now = now; this.inflight = new Map(); this.closed = false
    this.cleanup()
  }
  file(name) { return join(this.directory, name + '.json') }
  read(name) {
    try {
      if (lstatSync(this.file(name)).isSymbolicLink()) throw new Error('Invalid Friday storage')
      return JSON.parse(readFileSync(this.file(name), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
  save(name, value) {
    const temporary = this.file(name) + '.' + randomUUID()
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.file(name))
  }
  remove(name) {
    try { unlinkSync(this.file(name)) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  cleanup() {
    for (const file of readdirSync(this.directory)) {
      if (!/^request-[0-9a-f-]{36}\.json$/.test(file)) continue
      const path = join(this.directory, file)
      try {
        const info = lstatSync(path)
        if (info.isFile() && !info.isSymbolicLink() && info.mtimeMs < this.now() - 86_400_000) unlinkSync(path)
      } catch (error) {
        // Another desktop process may have already removed the same receipt.
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
  status() {
    const connection = this.read('connection')
    if (connection) return { state: connection.expiresAt > this.now() ? 'connected' : 'expired', label: connection.label, expiresAt: connection.expiresAt }
    const pair = this.read('pair')
    return pair && pair.expiresAt > this.now() ? { state: 'pairing', label: pair.label, fingerprint: pair.fingerprint, expiresAt: pair.expiresAt } : { state: 'disconnected' }
  }
  async post(path, input, ticket) {
    if (this.closed) throw new Error('Friday 已关闭。')
    let response
    try { response = await this.fetch(this.relay + '/desktop/' + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { 'content-type': 'application/json', ...(ticket ? { authorization: 'Bearer ' + ticket } : {}) }, body: JSON.stringify(input) }) }
    catch { throw new Error('暂时连不上 Friday，已提交的操作会保留原编号。') }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Friday 返回的数据不完整。')
    const parts = []; let size = 0
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 650_000) { await reader.cancel(); throw new Error('Friday 返回的内容过长。') }; parts.push(value) }
    let body
    try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { throw new Error('Friday 返回的数据不完整。') }
    if (this.closed) throw new Error('Friday 已关闭。')
    if (!response.ok || body.error) throw Object.assign(new Error(errors[body.error] ?? 'Friday 暂时不可用，请稍后再试。'), { code: body.error ?? 'unavailable' })
    return body
  }
  async pair(link, label = hostname()) {
    if (this.status().state === 'connected') throw new Error('请先断开当前账号，再连接另一个 Friday。')
    let url
    try { url = new URL(link) } catch { throw new Error('请粘贴 Friday 飞书私聊中的完整配对链接。') }
    const state = url.hash.slice(1), expiresAt = Number(state.split('.')[1])
    if (url.origin !== this.relay || url.pathname !== '/desktop/pair' || url.search || !/^dp1\.\d{13}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(state) || expiresAt <= this.now())
      throw new Error('配对链接无效或已过期，请在 Friday 飞书私聊重新连接 DSH。')
    if (typeof label !== 'string' || !label.trim() || label.length > 80 || /[\u0000-\u001f]/.test(label)) throw new Error('请填写有效的设备名称。')
    let pair = this.read('pair')
    if (!pair || pair.state !== state) {
      const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
      pair = { state, publicKey, privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), label: label.trim(), expiresAt,
        fingerprint: devicePublicKey(publicKey).fingerprint }
      pair.requestHash = hash([pair.label, pair.publicKey]); this.save('pair', pair)
    }
    const response = await this.post('pair', { state, publicKey: pair.publicKey, label: pair.label })
    if (response.requestHash !== pair.requestHash) throw new Error('设备验证不一致，请重新配对。')
    await this.consumePair(pair, response)
    return this.status()
  }
  async finishPair() {
    const pair = this.read('pair')
    if (!pair || pair.expiresAt <= this.now()) return this.status()
    // An offline first submission may have persisted locally without reaching
    // the relay. Re-submit the same key, not a new device, until acknowledged.
    const response = await this.post('pair', { state: pair.state, publicKey: pair.publicKey, label: pair.label })
    if (response.requestHash !== pair.requestHash) throw new Error('设备验证不一致，请重新配对。')
    await this.consumePair(pair, response); return this.status()
  }
  async consumePair(pair, response) {
    if (response.state === 'rejected') { this.remove('pair'); throw new Error('这次设备连接已取消。') }
    if (response.state !== 'approved') return
    const credentials = openPairing(pair.privateKey, response, `friday-device-pair:${pair.state}`)
    if (!UUID.test(credentials.id) || Buffer.from(credentials.key, 'base64url').length !== 32 || credentials.ticket.split('.')[1] !== credentials.id || credentials.expiresAt <= this.now())
      throw new Error('未能核实设备连接。')
    this.save('connection', { ...credentials, label: pair.label }); this.remove('pair')
  }
  request(requestId, command) {
    if (!UUID.test(requestId) || Buffer.byteLength(JSON.stringify(command)) > 60_000) return Promise.reject(new Error('操作无效。'))
    const digest = hash(command), prior = this.inflight.get(requestId)
    if (prior) return prior.digest === digest ? prior.promise : Promise.reject(new Error('同一个操作编号不能用于另一项操作。'))
    if (this.inflight.size >= 4) return Promise.reject(new Error('还有操作在处理，稍后再试。'))
    const task = this.execute(requestId, command).finally(() => this.inflight.delete(requestId))
    this.inflight.set(requestId, { digest, promise: task }); return task
  }
  async execute(requestId, command) {
    const c = this.read('connection')
    if (!c || c.expiresAt <= this.now()) throw new Error('请先连接 Friday。')
    const key = Buffer.from(c.key, 'base64url'), record = 'request-' + requestId, digest = hash(command)
    let pending = this.read(record)
    if (pending && (pending.digest !== digest || pending.deviceId !== c.id)) throw new Error('同一个操作编号不能用于另一项操作。')
    if (!pending) {
      pending = { digest, deviceId: c.id, createdAt: this.now(), payload: sealDevice(key, command, deviceEnvelopePurpose(c.id, requestId, 'request')) }
      this.save(record, pending)
    }
    let response
    try {
      // Revalidating saved conversation sources can exceed 25 short polls.
      // Keep waiting for the same receipt instead of abandoning it and adding
      // another request to the relay queue. This is still a bounded wait.
      const deadline = this.now() + 60_000
      response = await this.post('request', { requestId, payload: pending.payload }, c.ticket)
      while (!response.payload && this.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 700))
        response = await this.post('result', { requestId }, c.ticket)
      }
    } catch (error) {
      if (error.code === 'expired' && this.read('connection')?.id === c.id) this.save('connection', { ...c, expiresAt: this.now() })
      if (error.code === 'unavailable' && command.operation === 'mcp-connect') error.message = '没有读到 MCP 工具。请核对公网 HTTPS 地址与访问令牌，再重试连接。'
      throw error
    }
    if (!response.payload) throw new Error('暂未收到 Friday 的结果，请稍后刷新。已提交的操作会保留原编号。')
    const result = openDevice(key, response.payload, deviceEnvelopePurpose(c.id, requestId, 'response'))
    if (this.read('connection')?.id !== c.id) throw new Error('设备连接已变化。')
    // Keep ciphertext as the retry receipt; it contains no plaintext work context.
    if (command.operation === 'disconnect' && result.disconnected === true) this.remove('connection')
    if (this.inflight.size <= 1) this.cleanup()
    return result
  }
  forgetExpired() {
    if (this.status().state === 'connected') throw new Error('连接仍有效，请先断开设备。')
    this.remove('connection'); this.remove('pair')
    return this.status()
  }
  close() { this.closed = true }
}
