import { randomUUID } from 'node:crypto'
import type { Registry, SessionRow } from '../core/registry.js'
import type { PersonalApplication } from '../core/personal-application.js'
import type { InboundMessage } from '../feishu/mention.js'
import type { DeviceActor } from './devices.js'
import { DeviceError } from './devices.js'

export function ensurePersonalInputSchema(db: Registry['db']) {
  db.exec(`CREATE TABLE IF NOT EXISTS personal_inputs (
    device_id TEXT NOT NULL,request_id TEXT NOT NULL,owner TEXT NOT NULL,task_id INTEGER UNIQUE NOT NULL,
    body TEXT NOT NULL,target_task_id INTEGER,created_at INTEGER NOT NULL,PRIMARY KEY(device_id,request_id))`)
}
export class PersonalConversation {
  constructor(private readonly d: { registry: Registry; application: PersonalApplication; createSession(message: InboundMessage): SessionRow; now(): number }) {
    ensurePersonalInputSchema(d.registry.db)
  }
  accept(actor: DeviceActor, requestId: string, text: string, targetTaskId?: number) {
    actor.assertCurrent()
    const { registry, application } = this.d, audience = application.audience(actor.owner)
    if (!text.trim() || text.length > 12_000) throw new DeviceError('invalid', '请填写要交给 Friday 的事情。')
    const prior = registry.db.prepare('SELECT * FROM personal_inputs WHERE device_id=? AND request_id=?').get(actor.deviceId, requestId)
    if (prior) {
      if (prior.owner !== actor.owner || prior.body !== text || prior.target_task_id !== (targetTaskId ?? null)) throw new DeviceError('conflict', '这条消息已经提交。')
      return Number(prior.task_id)
    }
    // This is a real owner-authenticated desktop input, never a Feishu message
    // or an instruction received from another chat. Its durable receipt owns it.
    const id = `desktop:${randomUUID()}`, message: InboundMessage = {
      eventId: id, messageId: id, chatId: audience.chatId!, chatType: 'p2p', senderOpenId: actor.owner, senderType: 'user',
      msgType: 'text', text, mentions: [], createTimeMs: this.d.now(), personalDevice: { id: actor.deviceId, requestId } }
    let session: SessionRow
    if (targetTaskId) {
      const target = registry.getTask(targetTaskId), current = target && registry.getSession(target.sessionKey), reference = target && registry.taskWork.get(target.id)
      const work = reference && registry.workContexts.get(reference.key)
      if (!target || target.requesterOpenId !== actor.owner || !current || current.requesterOpenId !== actor.owner || current.chatType !== 'p2p' ||
        current.chatId !== audience.chatId || current.status === 'archived' || !work || work.lifecycle !== 'open' || work.authorityOpenId !== actor.owner ||
        work.pauseReasons.some(p => p.reason !== 'run_stop')) throw new DeviceError('denied', '这项工作暂时不能继续，请先处理所需授权。')
      for (const pause of work.pauseReasons) registry.workContexts.control(work.workKey, { action: 'resume', reason: pause.reason, causeRef: pause.causeRef })
      session = current
    } else session = this.d.createSession(message)
    const { task } = registry.createTaskOnce({ sessionKey: session.sessionKey, messageId: id, requesterOpenId: actor.owner, prompt: text,
      inbound: message, steer: false, ...(targetTaskId ? { workFromTaskId: targetTaskId } : {}) })
    registry.db.prepare('INSERT INTO personal_inputs VALUES(?,?,?,?,?,?,?)').run(actor.deviceId, requestId, actor.owner, task.id, text, targetTaskId ?? null, this.d.now())
    return task.id
  }
  valid(taskId: number, message: InboundMessage): boolean {
    const identity = message.personalDevice
    if (!identity || message.chatType !== 'p2p' || message.senderType !== 'user') return false
    const row = this.d.registry.db.prepare('SELECT * FROM personal_inputs WHERE task_id=? AND device_id=? AND request_id=?').get(taskId, identity.id, identity.requestId)
    return Boolean(row && row.owner === message.senderOpenId && row.body === message.text && this.d.registry.getTask(taskId)?.messageId === message.messageId)
  }
}
