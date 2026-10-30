import { z } from 'zod'
import { DeviceError, type DeviceActor } from './devices.js'
import type { PersonalLocalWork } from './local-work.js'

const identity = { id: z.uuid(), revision: z.number().int().positive() }
const command = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('local-list') }).strict(),
  z.object({ operation: z.literal('local-get'), id: z.uuid() }).strict(),
  z.object({ operation: z.literal('local-create'), text: z.string().trim().min(1).max(6000), sourceTaskId: z.number().int().positive().optional() }).strict(),
  z.object({ operation: z.literal('local-stop'), ...identity }).strict(),
  z.object({ operation: z.literal('local-claim'), ...identity, attempt: z.uuid(), sessionId: z.uuid(), fingerprint: z.string().length(64),
    directory: z.string().min(1).max(2000), model: z.string().min(1).max(300) }).strict(),
  z.object({ operation: z.literal('local-event'), id: z.uuid(), attempt: z.uuid(),
    state: z.enum(['heartbeat', 'completed', 'failed', 'stopped', 'interrupted']), body: z.string().max(16000).optional() }).strict(),
])
export class DesktopLocalWork {
  constructor(private readonly d: { work: PersonalLocalWork; changed(owner: string, id: string): void }) {}
  async prepare(owner: string, raw: unknown, guard: () => void): Promise<(actor?: DeviceActor) => unknown> {
    const parsed = command.safeParse(raw)
    if (!parsed.success) throw new DeviceError('invalid', '本机工作操作格式无效。')
    guard(); const input = parsed.data, store = this.d.work
    const actor = (value?: DeviceActor) => {
      guard(); if (!value || value.owner !== owner) throw new DeviceError('denied', '请从已连接的设备操作。')
      value.assertCurrent(); return value
    }
    if (input.operation === 'local-create') {
      const create = await store.prepareCreate(owner, input.text, input.sourceTaskId, guard)
      return value => { const result = create(actor(value).deviceId); this.d.changed(owner, result.id); return result }
    }
    if (input.operation === 'local-list') {
      const rows = store.list(owner), reads = await Promise.all(rows.map(async work => {
        try { return await store.authorize(owner, work.id, guard) } catch { guard(); return undefined }
      }))
      return () => { guard(); return { items: reads.flatMap(read => { try { return read ? [store.view(read())] : [] } catch { guard(); return [] } }) } }
    }
    if (input.operation === 'local-stop') return () => {
      guard(); const result = store.stop(owner, input.id, input.revision); this.d.changed(owner, input.id); return result
    }
    let current: Awaited<ReturnType<PersonalLocalWork['authorize']>>
    try { current = await store.authorize(owner, input.id, guard) }
    catch (error) {
      guard()
      if (input.operation !== 'local-event') throw error
      // A withdrawn source stops the current device without exposing material.
      return value => {
        const caller = actor(value), existing = store.get(owner, input.id)
        if (existing.deviceId !== caller.deviceId || existing.attempt !== input.attempt) throw new DeviceError('denied', '这次执行不属于当前设备。')
        store.stop(owner, input.id, existing.revision)
        const result = store.event(caller, input.id, input.attempt, 'stopped')
        this.d.changed(owner, input.id); return { ...result, stop: true }
      }
    }
    return value => {
      guard(); const work = current()
      if (input.operation === 'local-get') return store.view(work, true)
      const caller = actor(value)
      const result = input.operation === 'local-claim' ? store.claim(caller, input.id, input.revision, input)
        : store.event(caller, input.id, input.attempt, input.state, input.body)
      if (input.operation === 'local-claim' || input.state !== 'heartbeat') this.d.changed(owner, input.id)
      return result
    }
  }
}
