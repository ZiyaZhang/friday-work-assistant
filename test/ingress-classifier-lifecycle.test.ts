import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IngressClassifier, type IngressClassifierRuntime } from '../src/acp/ingress-classifier.js'
import { IngressReceipts, ingressFailureCode, type RoutingHandoff } from '../src/core/ingress.js'
import { Registry } from '../src/core/registry.js'
import { createLogger } from '../src/log.js'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const notice = { transient: '请求识别暂时中断，原文已保留。', terminal: '请求未能完成识别，自动尝试已停止。' }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

/** Actual classifier shutdown + durable store; a synthetic ACP peer can hold startup
 * after admission, and lets us observe whether shutdown creates another runtime. */
function classifier(hold?: ReturnType<typeof deferred>) {
  const started = deferred()
  let listener: Parameters<IngressClassifierRuntime['subscribe']>[1] | undefined
  const runtime: IngressClassifierRuntime = {
    start: vi.fn(async () => { started.resolve(); await hold?.promise }),
    newSession: vi.fn(async () => 'synthetic-session'),
    subscribe: vi.fn((_id, next) => { listener = next; return () => { listener = undefined } }),
    prompt: vi.fn(async () => {
      const update = { sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text: '{"kind":"new_work"}' } }
      listener?.(update, { sessionId: 'synthetic-session', update })
      return { stopReason: 'end_turn' }
    }),
    closeSession: vi.fn(async () => {}), stop: vi.fn(async () => {}),
  }
  const factory = vi.fn(() => runtime)
  const router = new IngressClassifier({ createRuntime: factory, cwd: '/tmp/synthetic-router', timeoutMs: 20_000,
    log: createLogger('classifier-lifecycle', 'error') })
  return { router, factory, runtime, started }
}

describe('classifier gateway lifecycle and persistent ingress retry', () => {
  it.each([false, true])('preserves shutdown failure without reviving a human-retired request (retired=%s)', async retired => {
    const home = mkdtempSync(join(tmpdir(), 'friday-classifier-lifecycle-')), path = join(home, 'friday.db')
    let registry = new Registry(path), receipts = new IngressReceipts(registry.db)
    const held = deferred(), old = classifier(held), fresh = classifier()
    closes.push(async () => { held.resolve(); await old.router.stop(); await fresh.router.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
    registry.createSession({ sessionKey: 'original-session', chatId: 'synthetic-chat', chatType: 'p2p', cwd: home, requesterOpenId: 'alice' })
    const handoff: RoutingHandoff = {
      route: { kind: 'task' }, sessionKey: 'original-session', spaceId: 'synthetic-space', targets: [],
      message: { eventId: 'event-original', messageId: 'original', chatId: 'synthetic-chat', chatType: 'p2p',
        senderOpenId: 'alice', senderType: 'user', msgType: 'text', text: '把刚才提供的材料整理成待办。', mentions: [], createTimeMs: 1000 },
      input: { message: { text: '把刚才提供的材料整理成待办。' }, candidates: [],
        materials: [{ ref: 'original-material', kind: 'file', preview: 'synthetic original material', status: 'ready' }] },
    }
    receipts.receive(handoff, 1000)
    const attempt = receipts.beginClassification('original', 1000, 25_000)!
    const pending = old.router.classify(handoff.input).catch(error => {
      const code = ingressFailureCode(error)
      expect(code).toBe('stopped')
      return receipts.classificationFailed('original', attempt, code, 1001, notice)
    })
    await old.started.promise
    if (retired) receipts.retire('original', 'user_requested')
    await old.router.stop()
    const failure = await pending
    expect(registry.taskForMessage('original')).toBeUndefined()
    expect(registry.db.prepare('SELECT decision FROM ingress_routes WHERE message_id=?').get('original')?.decision).toBeNull()
    if (retired) expect(failure).toBeUndefined()
    else expect(failure).toMatchObject({ code: 'stopped', phase: 'transient', retryAt: 61_001, attemptCount: 1 })

    // A late startup completion and a future call cannot restart the closed peer,
    // even if the durable request is still eligible in a fresh gateway.
    held.resolve()
    await expect(old.router.classify(handoff.input)).rejects.toMatchObject({ code: 'stopped' })
    expect(old.factory).toHaveBeenCalledTimes(1)
    expect(old.runtime.newSession).not.toHaveBeenCalled()
    expect(old.runtime.prompt).not.toHaveBeenCalled()
    expect(old.runtime.stop).toHaveBeenCalledTimes(1)

    registry.close(); registry = new Registry(path); receipts = new IngressReceipts(registry.db)
    const resumed = receipts.ready(61_001)
    if (retired) {
      expect(resumed).toEqual([])
      expect(receipts.beginClassification('original', 61_001, 25_000)).toBeUndefined()
      expect(receipts.failureNotices()).toEqual([])
      expect(fresh.factory).not.toHaveBeenCalled()
      return
    }
    expect(resumed).toEqual([handoff])
    const next = receipts.beginClassification('original', 61_001, 25_000)!
    const decision = await fresh.router.classify(resumed[0]!.input)
    expect(receipts.classified('original', decision, next, 61_002)).toBe(true)
    receipts.commit('original', decision, 'new_work', () => registry.createTaskOnce({ sessionKey: handoff.sessionKey,
      messageId: handoff.message.messageId, requesterOpenId: 'alice', prompt: handoff.message.text, inbound: handoff.message }))
    expect(registry.taskForMessage('original')).toMatchObject({ prompt: handoff.message.text, status: 'queued' })
    expect(receipts.ready(100_000)).toEqual([])
    expect(receipts.failureNotices()).toEqual([])
    expect(registry.db.prepare('SELECT attempt_count,last_failure_code FROM ingress_routes WHERE message_id=?').get('original'))
      .toMatchObject({ attempt_count: 2, last_failure_code: null })
    expect(fresh.factory).toHaveBeenCalledTimes(1)
    expect(fresh.runtime.prompt).toHaveBeenCalledTimes(1)
  })
})
