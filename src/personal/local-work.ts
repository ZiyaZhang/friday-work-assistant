import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DeviceActor, PersonalDevices } from './devices.js'
import { DeviceError } from './devices.js'
import type { PersonalResult, PersonalResults } from './results.js'

type State = 'queued' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted'
export interface LocalWork {
  id: string; owner: string; deviceId: string; deviceName: string; revision: number; state: State
  text: string; material?: PersonalResult; createdAt: number; updatedAt: number
  sourceTaskId?: number; attempt?: string; sessionId?: string; directory?: string; model?: string
  heartbeatAt?: number; deadline?: number; result?: string
}
const active = (value: LocalWork) => ['queued', 'running', 'stopping'].includes(value.state)
export function ensureLocalWorkSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS personal_local_work (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, device_id TEXT NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS personal_local_work_owner ON personal_local_work(owner)`)
}

/** A local attempt never enters the cloud worker queue. Its UUID, chosen device
 * and local session remain fixed through reconnects; silence is not completion. */
export class PersonalLocalWork {
  constructor(private readonly d: { db: DatabaseSync; devices: PersonalDevices; results: PersonalResults;
    audience(owner: string): unknown; now(): number }) { ensureLocalWorkSchema(d.db) }
  private save(value: LocalWork) {
    this.d.db.prepare('INSERT INTO personal_local_work VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record')
      .run(value.id, value.owner, value.deviceId, JSON.stringify(value))
  }
  get(owner: string, id: string): LocalWork {
    this.d.audience(owner)
    const row = this.d.db.prepare('SELECT record FROM personal_local_work WHERE owner=? AND id=?').get(owner, id)
    if (!row) throw new DeviceError('denied', '没有找到这项本机工作。')
    return JSON.parse(String(row.record)) as LocalWork
  }
  list(owner: string) {
    this.d.audience(owner)
    return this.d.db.prepare('SELECT record FROM personal_local_work WHERE owner=? ORDER BY rowid DESC LIMIT 50').all(owner)
      .map(row => JSON.parse(String(row.record)) as LocalWork)
  }
  private device(owner: string, id: string) {
    this.d.audience(owner)
    const device = this.d.devices.list(owner).find(value => value.id === id && value.revokedAt === null && value.expiresAt > this.d.now())
    if (!device) throw new DeviceError('denied', '这台设备已断开，请重新连接。')
    return device
  }
  async prepareCreate(owner: string, text: string, sourceTaskId: number | undefined, guard: () => void) {
    guard(); this.d.audience(owner)
    if (!text.trim() || text.length > 6000) throw new DeviceError('invalid', '请填写这次要完成的工作。')
    const material = sourceTaskId ? await this.d.results.material(owner, sourceTaskId, guard) : undefined
    return (deviceId: string) => {
      guard(); const device = this.device(owner, deviceId), source = material?.()
      if (this.list(owner).filter(active).length >= 3) throw new DeviceError('conflict', '请先完成或停止已有的本机工作。')
      if (source && source.body.length > 16000) throw new DeviceError('invalid', '这份材料较长，请先让 Friday 整理本次工作需要的部分。')
      const now = this.d.now(), work: LocalWork = { id: randomUUID(), owner, deviceId, deviceName: device.label,
        revision: 1, state: 'queued', text: text.trim(), createdAt: now, updatedAt: now,
        ...(source ? { sourceTaskId, material: source } : {}) }
      this.save(work); return { id: work.id, revision: 1 }
    }
  }
  async authorize(owner: string, id: string, guard: () => void) {
    guard(); const before = this.get(owner, id)
    const source = before.sourceTaskId ? await this.d.results.material(owner, before.sourceTaskId, guard) : undefined
    return () => {
      guard(); const current = this.get(owner, id)
      if (current.revision !== before.revision) throw new DeviceError('conflict', '工作已更新，请刷新。')
      if (source && JSON.stringify(source()) !== JSON.stringify(current.material)) throw new DeviceError('denied', '这项工作的来源已经变化。')
      return current
    }
  }
  view(work: LocalWork, includeMaterial = false) {
    const disconnected = !this.d.devices.list(work.owner).some(value => value.id === work.deviceId && !value.revokedAt && value.expiresAt > this.d.now())
    const unavailable = disconnected || work.heartbeatAt !== undefined && this.d.now() - work.heartbeatAt > 45000
    const label = work.state === 'queued' ? disconnected ? '设备已断开，尚未开始' : '等待在设备上开始'
      : ['running', 'stopping'].includes(work.state) && unavailable ? '设备暂未回报，执行状态待核实'
        : ({ running: '正在本机处理', stopping: '等待设备确认停止', completed: '已完成', failed: '本次执行失败', stopped: '已停止', interrupted: '执行已中断，未自动重跑' })[work.state]
    return { id: work.id, revision: work.revision, title: work.text.slice(0, 160), deviceId: work.deviceId, deviceName: work.deviceName,
      state: work.state, label, at: work.updatedAt, sourceTaskId: work.sourceTaskId, sessionId: work.sessionId,
      directory: work.directory, model: work.model, canStop: active(work),
      ...(includeMaterial ? { text: work.text, material: work.material?.body, result: work.result,
        fingerprint: this.fingerprint(work), deadline: work.deadline } : {}) }
  }
  fingerprint(work: LocalWork) {
    return createHash('sha256').update(JSON.stringify([work.id, work.owner, work.deviceId, work.text, work.material])).digest('hex')
  }
  claim(actor: DeviceActor, id: string, revision: number, input: { attempt: string; sessionId: string; fingerprint: string; directory: string; model: string }) {
    actor.assertCurrent(); this.device(actor.owner, actor.deviceId)
    const work = this.get(actor.owner, id)
    if (work.deviceId !== actor.deviceId || work.revision !== revision || work.state !== 'queued' || this.fingerprint(work) !== input.fingerprint)
      throw new DeviceError('conflict', '这项工作已开始或内容有变化，请刷新。')
    if (this.list(actor.owner).some(value => value.id !== id && value.deviceId === actor.deviceId && ['running', 'stopping'].includes(value.state)))
      throw new DeviceError('conflict', '这台设备还有工作在运行或等待核实。')
    const now = this.d.now()
    Object.assign(work, input, { state: 'running', revision: work.revision + 1, updatedAt: now, heartbeatAt: now, deadline: now + 10 * 60_000 })
    this.save(work)
    return { id: work.id, attempt: work.attempt, deadline: work.deadline }
  }
  stop(owner: string, id: string, revision: number) {
    const work = this.get(owner, id)
    if (work.revision !== revision) throw new DeviceError('conflict', '工作已更新，请刷新。')
    if (!active(work)) return { id, state: work.state }
    work.state = work.state === 'queued' ? 'stopped' : 'stopping'
    work.revision++; work.updatedAt = this.d.now(); this.save(work)
    return { id, state: work.state }
  }
  event(actor: DeviceActor, id: string, attempt: string, state: 'heartbeat' | 'completed' | 'failed' | 'stopped' | 'interrupted', body?: string) {
    actor.assertCurrent()
    const work = this.get(actor.owner, id)
    if (work.deviceId !== actor.deviceId || work.attempt !== attempt) throw new DeviceError('denied', '这次执行不属于当前设备。')
    if (!['running', 'stopping'].includes(work.state)) return { state: work.state, stop: true }
    const now = this.d.now(), stopping = work.state === 'stopping' || now >= work.deadline!
    if (state === 'heartbeat') {
      work.heartbeatAt = now
      if (stopping && work.state !== 'stopping') { work.state = 'stopping'; work.revision++; work.updatedAt = now }
    } else {
      if (state === 'completed' && (!body?.trim() || body.length > 16000)) throw new DeviceError('invalid', '执行缺少有效结果。')
      work.state = stopping ? 'stopped' : state
      // A stopped attempt cannot publish a late result over the stop decision.
      if (!stopping && body?.trim()) work.result = body.slice(0, 16000)
      work.revision++; work.updatedAt = now; work.heartbeatAt = now
    }
    this.save(work); return { state: work.state, stop: stopping || state !== 'heartbeat' }
  }
}
