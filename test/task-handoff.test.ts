import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { IngressReceipts, type RoutingHandoff } from '../src/core/ingress.js'
import type { InboundMessage } from '../src/feishu/mention.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-handoff-'))
  const path = join(dir, 'old.sqlite')
  let registry = new Registry(path)
  const inbound: InboundMessage = { eventId: 'event-1', messageId: 'message-1', tenantId: 'tenant-1',
    chatId: 'chat-1', chatType: 'group', msgType: 'file', text: '补上日志，你接着看', senderOpenId: 'alice',
    senderType: 'user', mentions: [], threadId: 'thread-1', parentId: 'question-1', rootId: 'root-1',
    createTimeMs: 10, fileKey: 'file-1', fileName: 'logs.zip' }
  registry.createSession({ sessionKey: 'work-1', chatId: inbound.chatId, chatType: 'group', cwd: dir, requesterOpenId: 'alice' })
  const accept = (messageId = inbound.messageId) => registry.createTaskOnce({ sessionKey: 'work-1',
    messageId, requesterOpenId: 'alice', prompt: inbound.text, inbound: { ...inbound, messageId }, steer: false }).task
  const reopen = () => { registry.close(); registry = new Registry(path); return registry }
  cleanups.push(() => { registry.close(); rmSync(dir, { recursive: true, force: true }) })
  return { get registry() { return registry }, accept, reopen, inbound }
}

describe('durable task handoff', () => {
  it('retains original envelope and never-started work across reopen while marking started and legacy work interrupted', () => {
    const t = setup()
    const pending = t.accept(), started = t.accept('started'), cancelled = t.accept('cancelled')
    const legacy = t.registry.createTask({ sessionKey: 'work-1', messageId: 'legacy', prompt: '旧任务' })
    expect(t.registry.startTask(started.id, 20)).toBe(true)
    t.registry.cancelQueuedTask(cancelled.id, 21)
    t.reopen()
    expect(t.registry.failStaleTasks('restart')).toBe(2)
    expect(t.registry.dispatches.pending()).toEqual([{ taskId: pending.id, inbound: t.inbound, steer: false, generation: 0, resume: null }])
    expect(t.registry.getTask(started.id)?.status).toBe('failed')
    expect(t.registry.getTask(legacy.id)?.status).toBe('failed')
    expect(t.registry.getTask(cancelled.id)?.status).toBe('cancelled')
    expect(t.registry.startTask(pending.id, 30)).toBe(true)
    expect(t.registry.startTask(pending.id, 31)).toBe(false)
    t.reopen()
    expect(t.registry.dispatches.pending()).toEqual([])
  })

  it('rolls back the task claim if persisting execution admission fails', () => {
    const t = setup(), task = t.accept()
    t.registry.db.exec(`CREATE TRIGGER reject_admission BEFORE UPDATE ON task_dispatches BEGIN SELECT RAISE(ABORT, 'disk fault'); END`)
    expect(() => t.registry.startTask(task.id, 20)).toThrow('disk fault')
    expect(t.registry.getTask(task.id)).toMatchObject({ status: 'queued', startedAt: null })
    expect(t.registry.dispatches.pending()).toHaveLength(1)
  })

  it('rolls back task, receipt and amendment when durable handoff cannot be stored', () => {
    const t = setup(), original = t.accept('original')
    t.registry.db.exec(`CREATE TRIGGER reject_handoff BEFORE INSERT ON task_dispatches BEGIN SELECT RAISE(ABORT, 'disk fault'); END`)
    expect(() => t.registry.createTaskOnce({ sessionKey: 'work-1', messageId: t.inbound.messageId, prompt: t.inbound.text,
      requesterOpenId: 'alice', inbound: t.inbound, amendsTaskId: original.id, replaceQueued: true })).toThrow('disk fault')
    expect(t.registry.taskForMessage(t.inbound.messageId)).toBeUndefined()
    expect(t.registry.listTasks('work-1')).toHaveLength(1)
    expect(t.registry.getTask(original.id)?.status).toBe('queued')
  })

  it('persists classification before applying it and atomically commits routing with its accepted task', () => {
    const t = setup(), original = t.accept('original')
    let receipts = new IngressReceipts(t.registry.db)
    const handoff: RoutingHandoff = { message: t.inbound, spaceId: 'space-1', sessionKey: 'work-1',
      targets: [{ ref: 'target-1', task: original }],
      input: { message: { text: t.inbound.text, replyToRef: 'target-1' }, candidates: [{ ref: 'target-1', title: '原事项', status: 'queued' }] } }
    receipts.receive(handoff, 1)
    const decision = { kind: 'amend' as const, targetRef: 'target-1' }
    receipts.classified(t.inbound.messageId, decision)
    t.reopen(); receipts = new IngressReceipts(t.registry.db)
    expect(receipts.has(t.inbound.messageId)).toBe(false)
    expect(receipts.pending()).toEqual([{ ...handoff, decision }])
    expect(receipts.receive({ ...handoff, targets: [], input: { message: { text: 'different' }, candidates: [] } }, 2)?.targets).toEqual(handoff.targets)
    expect(() => receipts.commit(t.inbound.messageId, decision, 'amend', () => { t.accept(); throw new Error('crash') })).toThrow('crash')
    expect(t.registry.taskForMessage(t.inbound.messageId)).toBeUndefined()
    expect(receipts.pending()).toHaveLength(1)
    const task = receipts.commit(t.inbound.messageId, decision, 'amend', () => t.accept())
    t.reopen(); receipts = new IngressReceipts(t.registry.db)
    expect(receipts.pending()).toEqual([])
    expect(receipts.has(t.inbound.messageId)).toBe(true)
    expect(t.registry.dispatches.pending().map(row => row.taskId)).toContain(task.id)
    expect(() => receipts.commit(t.inbound.messageId, decision, 'again', () => t.accept())).toThrow('已应用')
  })

  it('preserves legacy route rows without pretending their missing inbound can be reconstructed', () => {
    const t = setup(), receipts = new IngressReceipts(t.registry.db)
    receipts.claim('old-message', 'space-1', 'alice', [{ taskId: 42 }], 1)
    t.reopen()
    const restored = new IngressReceipts(t.registry.db)
    expect(restored.has('old-message')).toBe(true)
    expect(restored.pending()).toEqual([])
    expect(t.registry.db.prepare('SELECT snapshot, decision, result FROM ingress_routes').get()).toEqual({ snapshot: '[{"taskId":42}]', decision: null, result: null })
  })
})
