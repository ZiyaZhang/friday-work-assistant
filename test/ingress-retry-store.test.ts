import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IngressClassificationError } from '../src/acp/ingress-classifier.js'
import { IngressReceipts, ingressFailureCode, type RoutingHandoff } from '../src/core/ingress.js'
import { Registry } from '../src/core/registry.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const notice = { transient: '分类暂未完成，原请求已保留，会自动重试。', terminal: '分类未能完成，原请求保留，需要重新发起。' }
const input = (messageId = 'input-1', route?: RoutingHandoff['route']): RoutingHandoff => ({
  route, message: { eventId: `event-${messageId}`, messageId, chatId: 'chat', chatType: 'p2p', senderOpenId: 'alice', senderType: 'user',
    msgType: 'text', text: '保留原始请求，与附件及引用一起处理', mentions: [], createTimeMs: 1000,
    parentId: 'original-material', rootId: 'original-task', threadId: 'original-thread', tenantId: 'synthetic-tenant' },
  spaceId: 'space', sessionKey: 'session', targets: [],
  input: { message: { text: '保留原始请求，与附件及引用一起处理' }, candidates: [],
    materials: [{ ref: 'material-reference', kind: 'file', preview: 'HOST_AUTHORIZED_PREVIEW', status: 'ready' }] },
})
function setup(persisted = false) {
  const home = mkdtempSync(join(tmpdir(), 'friday-ingress-retry-')), path = persisted ? join(home, 'database.db') : ':memory:'
  let registry = new Registry(path), store = new IngressReceipts(registry.db)
  cleanup.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  return { get registry() { return registry }, get store() { return store },
    reopen() { registry.close(); registry = new Registry(path); store = new IngressReceipts(registry.db) },
    row(id = 'input-1') { return registry.db.prepare('SELECT * FROM ingress_routes WHERE message_id=?').get(id) },
  }
}

function preparing(t: ReturnType<typeof setup>) {
  t.registry.createSession({ sessionKey: 'session', chatId: 'chat', chatType: 'p2p', cwd: tmpdir(), requesterOpenId: 'alice' })
  const source = { ...input('original-material').message, msgType: 'file', fileKey: 'synthetic-original-file', createTimeMs: 900 }
  const task = t.registry.createTaskOnce({ sessionKey: 'session', messageId: source.messageId, requesterOpenId: 'alice', prompt: source.text, inbound: source }).task
  const handoff: RoutingHandoff = { ...input('input-1', { kind: 'question', questionId: 7, anchorId: 8, originTaskId: task.id }),
    targets: [{ ref: 'question', task, workInputTaskId: task.id, workControlEpoch: 2 }], materialsPrepared: false,
    materials: [{ ref: 'frozen-file', taskId: task.id, message: source,
      workObservation: { workKey: `task:${task.id}`, inputTaskId: task.id, controlEpoch: 2 } }],
    input: { message: { text: '保留原始请求，与附件及引用一起处理', replyToRef: 'question' },
      candidates: [{ ref: 'question', title: task.prompt, status: 'queued', materialRefs: ['frozen-file'], lastInputAt: 900 }] } }
  const previews: NonNullable<RoutingHandoff['input']['materials']> = [{ ref: 'frozen-file', kind: 'file',
    preview: 'Host-read original file preview', status: 'partial', replied: true, suppliedAt: 900 }]
  t.store.receive(handoff, 1000)
  return { handoff, previews }
}

describe('persistent classifier attempts reuse the original ingress receipt', () => {
  it.each(['timeout', 'unavailable', 'stopped'] as const)('persists %s without a clarify decision and enforces the original retry time', code => {
    const t = setup(), handoff = input()
    t.store.receive(handoff, 1000)
    const attempt = t.store.beginClassification('input-1', 1000, 20_000)!
    expect(attempt).toEqual({ messageId: 'input-1', attempt: 1, expiresAt: 21_000 })
    expect(t.store.beginClassification('input-1', 1001, 20_000)).toBeUndefined()
    expect(t.store.ready(1002)).toEqual([])
    const failure = t.store.classificationFailed('input-1', attempt, code, 5000, notice)
    expect(failure).toEqual({ code, attemptCount: 1, retryAt: 65_000, phase: 'transient' })
    expect(t.row()).toMatchObject({ decision: null, result: null, attempt_count: 1, last_failure_code: code, retry_at: 65_000 })
    expect(t.store.pending()[0]).toEqual(handoff)
    expect(t.store.has('input-1')).toBe(false)
    expect(t.store.ready(64_999)).toEqual([])
    expect(t.store.beginClassification('input-1', 64_999, 20_000)).toBeUndefined()
    expect(t.store.ready(65_000)).toEqual([handoff])
  })

  it('preserves the exact envelope and attempt budget after reopening the database', () => {
    const t = setup(true), handoff = input()
    t.store.receive(handoff, 1000)
    const attempt = t.store.beginClassification('input-1', 1000, 20_000)!
    t.store.classificationFailed('input-1', attempt, 'timeout', 20_000, notice)
    const original = t.row()!.handoff
    t.reopen()
    expect(t.store.receive({ ...handoff, message: { ...handoff.message, text: 'UNTRUSTED_DUPLICATE_CHANGE' } }, 50_000)).toEqual(handoff)
    expect(t.row()!.handoff).toBe(original)
    expect(t.store.ready(79_999)).toEqual([])
    const second = t.store.beginClassification('input-1', 80_000, 20_000)!
    expect(second.attempt).toBe(2)
    expect(t.store.classified('input-1', { kind: 'new_work' }, second, 80_001)).toBe(true)
    expect(t.row()).toMatchObject({ attempt_count: 2, last_failure_code: null, retry_at: null, notice: null, result: null,
      decision: '{"kind":"new_work"}' })
    expect(t.store.failureNotices()).toEqual([])
    expect(t.store.ready(80_002)[0]).toMatchObject({ decision: { kind: 'new_work' }, message: handoff.message })
  })

  it('counts a process-lost attempt only after its saved deadline and never resets the budget', () => {
    const t = setup(true)
    t.store.receive(input(), 1000)
    t.store.beginClassification('input-1', 1000, 20_000)
    t.reopen()
    t.store.recoverClassifications(20_999, notice)
    expect(t.store.classificationFailure('input-1')).toBeUndefined()
    expect(t.store.beginClassification('input-1', 21_000, 20_000)).toBeUndefined() // recovery records the lost result first
    t.store.recoverClassifications(21_000, notice)
    expect(t.store.classificationFailure('input-1')).toMatchObject({ code: 'timeout', attemptCount: 1, retryAt: 81_000 })
    t.store.recoverClassifications(30_000, notice)
    expect(t.store.classificationFailure('input-1')?.retryAt).toBe(81_000)
    expect(t.store.beginClassification('input-1', 81_000, 20_000)?.attempt).toBe(2)
  })

  it('gives at most two automatic retries and a distinct terminal notice when exhausted', () => {
    const t = setup()
    t.store.receive(input(), 1000)
    let now = 1000
    for (let number = 1; number <= 3; number++) {
      const attempt = t.store.beginClassification('input-1', now, 20_000)!
      expect(attempt.attempt).toBe(number)
      const failure = t.store.classificationFailed('input-1', attempt, 'unavailable', now + 1, notice)!
      expect(failure.phase).toBe(number === 3 ? 'terminal' : 'transient')
      now = failure.retryAt ?? now + 1
    }
    expect(t.row()).toMatchObject({ decision: null, result: 'classification_failed', attempt_count: 3, retry_at: null, notice: notice.terminal })
    expect(t.store.has('input-1')).toBe(true)
    expect(t.store.ready(now + 1_000_000)).toEqual([])
    expect(t.store.beginClassification('input-1', now + 1_000_000, 20_000)).toBeUndefined()
    expect(t.store.notices()).toEqual([])
    expect(t.store.failureNotices()).toMatchObject([{ phase: 'terminal', text: notice.terminal, failure: { attemptCount: 3 } }])
  })

  it.each(['invalid_input', 'invalid_output', 'tool_use', 'aborted', 'unexpected'] as const)('%s does not become an automatic retry or a model clarification', code => {
    const t = setup()
    t.store.receive(input(), 1000)
    const attempt = t.store.beginClassification('input-1', 1000, 20_000)!
    expect(t.store.classificationFailed('input-1', attempt, code, 1001, notice)).toMatchObject({ phase: 'terminal', retryAt: null })
    expect(t.row()).toMatchObject({ decision: null, result: 'classification_failed' })
    expect(t.store.pending()).toEqual([])
    expect(t.store.ready(500_000)).toEqual([])
  })

  it('rejects an expired result, duplicate failure, wrong message and late results from an earlier attempt', () => {
    const t = setup()
    t.store.receive(input(), 1000)
    const first = t.store.beginClassification('input-1', 1000, 20_000)!
    expect(t.store.classified('input-1', { kind: 'clarify' }, first, first.expiresAt)).toBe(false)
    expect(t.store.classificationFailed('different-message', first, 'timeout', 21_000, notice)).toBeUndefined()
    t.store.classificationFailed('input-1', first, 'timeout', 21_000, notice)
    expect(t.store.classificationFailed('input-1', first, 'unavailable', 30_000, notice)).toBeUndefined()
    const second = t.store.beginClassification('input-1', 81_000, 20_000)!
    expect(t.store.classified('input-1', { kind: 'clarify' })).toBe(false)
    expect(t.store.classified('input-1', { kind: 'stop', targetRef: 'stale' }, first, 81_001)).toBe(false)
    expect(t.store.classificationFailed('input-1', first, 'timeout', 81_001, notice)).toBeUndefined()
    expect(t.store.classified('input-1', { kind: 'work_request' }, second, 81_001)).toBe(true)
    expect(t.store.classificationFailed('input-1', second, 'timeout', 81_002, notice)).toBeUndefined()
  })

  it.each(['access_changed', 'superseded', 'stopped'] as const)('cannot revive a handoff retired by the host for %s', reason => {
    const t = setup()
    t.store.receive(input(), 1000)
    const attempt = t.store.beginClassification('input-1', 1000, 20_000)!
    expect(t.store.retire('input-1', reason)).toBe(true)
    expect(t.store.classified('input-1', { kind: 'work_request' }, attempt, 1001)).toBe(false)
    expect(t.store.classificationFailed('input-1', attempt, 'timeout', 1001, notice)).toBeUndefined()
    expect(t.store.classificationFailed('input-1', attempt, 'stopped', 1001, notice)).toBeUndefined()
    expect(t.store.failureNotices()).toEqual([])
    expect(t.store.ready(30_000)).toEqual([])
    expect(t.row()).toMatchObject({ result: reason, decision: null })
  })

  it('keeps committed control decisions and accepted task receipts outside retry admission', () => {
    const t = setup()
    t.store.receive(input(), 1000)
    t.store.commit('input-1', { kind: 'stop', targetRef: 'captured' }, 'already stopped', () => {}, true)
    expect(t.store.beginClassification('input-1', 1001, 20_000)).toBeUndefined()
    expect(t.store.ready(1001)).toEqual([])
    expect(t.store.notices()).toHaveLength(1)
    expect(t.store.failureNotices()).toEqual([])
    t.store.receive(input('input-2'), 1000)
    t.registry.createSession({ sessionKey: 'session', chatId: 'chat', chatType: 'p2p', cwd: tmpdir(), requesterOpenId: 'alice' })
    t.registry.createTaskOnce({ sessionKey: 'session', messageId: 'input-2', prompt: 'accepted', requesterOpenId: 'alice', inbound: input('input-2').message })
    expect(t.store.beginClassification('input-2', 1001, 20_000)).toBeUndefined()
    expect(t.store.ready(1001)).toEqual([])
  })

  it('can suppress an unsent terminal failure notice after host invalidation without changing an applied control', () => {
    const t = setup()
    t.store.receive(input(), 1000)
    const attempt = t.store.beginClassification('input-1', 1000, 20_000)!
    t.store.classificationFailed('input-1', attempt, 'invalid_output', 1001, notice)
    expect(t.store.retire('input-1', 'superseded')).toBe(true)
    expect(t.store.failureNotices()).toEqual([])
    expect(t.store.classificationFailure('input-1')).toBeUndefined()
    expect(t.row()).toMatchObject({ result: 'superseded', last_failure_code: 'invalid_output', decision: null })
    t.store.receive(input('input-2'), 1000)
    t.store.commit('input-2', { kind: 'stop', targetRef: 'captured' }, 'stopped', () => {}, true)
    expect(t.store.retire('input-2', 'superseded')).toBe(false)
    expect(t.row('input-2')).toMatchObject({ result: 'stopped', notice: 'stopped' })
  })

  it('uses separate reserve-before-send delivery identities for transient and terminal notices', () => {
    const t = setup(true)
    t.registry.db.exec('CREATE TABLE deliveries(delivery_key TEXT PRIMARY KEY,status TEXT)')
    t.store.receive(input(), 1000)
    const first = t.store.beginClassification('input-1', 1000, 20_000)!
    t.store.classificationFailed('input-1', first, 'timeout', 1001, notice)
    expect(t.store.failureNotices()).toMatchObject([{ phase: 'transient', text: notice.transient }])
    t.registry.db.prepare('INSERT INTO deliveries VALUES (?, ?)').run('route-failure:input-1:transient', 'planned')
    t.reopen()
    expect(t.store.failureNotices()).toEqual([])
    const next = t.store.beginClassification('input-1', 61_001, 20_000)!
    t.store.classificationFailed('input-1', next, 'invalid_output', 61_002, notice)
    expect(t.store.failureNotices()).toMatchObject([{ phase: 'terminal', text: notice.terminal }])
    t.registry.db.prepare('INSERT INTO deliveries VALUES (?, ?)').run('route-failure:input-1:terminal', 'unknown')
    expect(t.store.failureNotices()).toEqual([])
    expect(t.store.notices()).toEqual([])
  })

  it.each([
    { kind: 'question', questionId: 7, anchorId: 8, originTaskId: 9 },
    { kind: 'stopped_feedback', feedbackId: 4, originSessionKey: 'original-session' },
  ] satisfies NonNullable<RoutingHandoff['route']>[])('retains the captured $kind binding without reinterpreting it as task routing', route => {
    const t = setup(true), handoff = input('input-1', route)
    t.store.receive(handoff, 1000)
    const first = t.store.beginClassification('input-1', 1000, 20_000)!
    t.store.classificationFailed('input-1', first, 'timeout', 1001, notice)
    t.reopen()
    expect(t.store.pending()).toEqual([handoff])
    expect(t.store.ready(61_001)).toEqual([handoff])
    const second = t.store.beginClassification('input-1', 61_001, 20_000)!
    // The host checked the actual question/feedback identity and found that it changed.
    t.store.retire('input-1', 'target_changed')
    expect(t.store.classified('input-1', { kind: 'amend', targetRef: route.kind }, second, 61_002)).toBe(false)
    expect(t.store.ready(1_000_000)).toEqual([])
    expect(JSON.parse(String(t.row()!.handoff))).toEqual(handoff)
    expect(t.row()).toMatchObject({ decision: null, result: 'target_changed', attempt_count: 2 })
  })

  it('finishes with a terminal failure when the last automatic attempt is lost on process restart', () => {
    const t = setup(true)
    t.store.receive(input(), 1000)
    let now = 1000
    for (let number = 1; number <= 3; number++) {
      const attempt = t.store.beginClassification('input-1', now, 20_000)!
      t.reopen()
      t.store.recoverClassifications(attempt.expiresAt, notice)
      const failure = t.store.classificationFailure('input-1')!
      expect(failure.attemptCount).toBe(number)
      now = failure.retryAt ?? now
    }
    expect(t.row()).toMatchObject({ result: 'classification_failed', decision: null, last_failure_code: 'timeout', notice: notice.terminal })
    expect(t.store.ready(now + 1_000_000)).toEqual([])
    expect(t.store.failureNotices()).toMatchObject([{ phase: 'terminal' }])
  })

  it('retains the gateway-stop cause and finite attempt budget across repeated graceful restarts', () => {
    const t = setup(true), handoff = input()
    t.store.receive(handoff, 1000)
    let now = 1000
    for (let number = 1; number <= 3; number++) {
      const attempt = t.store.beginClassification('input-1', now, 20_000)!
      const failed = t.store.classificationFailed('input-1', attempt, 'stopped', now + 1, notice)!
      expect(failed).toMatchObject({ code: 'stopped', attemptCount: number, phase: number === 3 ? 'terminal' : 'transient' })
      t.reopen()
      expect(JSON.parse(String(t.row()!.handoff))).toEqual(handoff)
      expect(t.row()).toMatchObject({ decision: null, last_failure_code: 'stopped', attempt_count: number })
      now = failed.retryAt ?? now + 1
    }
    expect(t.row()).toMatchObject({ result: 'classification_failed', retry_at: null, notice: notice.terminal })
    expect(t.store.ready(now + 1_000_000)).toEqual([])
  })

  it('classifies errors by their typed code, not an error-message keyword', () => {
    expect(ingressFailureCode(new IngressClassificationError('timeout'))).toBe('timeout')
    expect(ingressFailureCode(new TypeError('timeout unavailable secret'))).toBe('unexpected')
  })
})

describe('raw material preparation stays on the original ingress receipt', () => {
  it('keeps legacy handoffs ready without requiring a new marker', () => {
    const t = setup(), handoff = input()
    t.store.receive(handoff, 1000)
    expect(t.store.ready(1000)).toEqual([handoff])
    expect(t.store.markMaterialsPrepared('input-1', [])).toBe(false)
    expect(t.store.beginClassification('input-1', 1000, 20_000)?.attempt).toBe(1)
  })

  it('returns unfinished preparation to recovery but denies classifier admission and fallback decisions', () => {
    const t = setup(), { handoff } = preparing(t)
    expect(t.store.ready(1000)).toEqual([handoff])
    expect(t.store.beginClassification('input-1', 1000, 20_000)).toBeUndefined()
    expect(t.store.classified('input-1', { kind: 'clarify' })).toBe(false)
    expect(t.row()).toMatchObject({ attempt_count: 0, decision: null, result: null })
    expect(t.store.failureNotices()).toEqual([])
  })

  it('reopens the original envelope and frozen refs, then fills only their previews once', () => {
    const t = setup(true), { handoff, previews } = preparing(t), snapshot = t.row()!.snapshot
    t.reopen()
    const duplicate: RoutingHandoff = { ...handoff, message: { ...handoff.message, text: 'changed duplicate' },
      route: { kind: 'task' }, targets: [], materials: [], input: { message: { text: 'changed input' }, candidates: [] } }
    expect(t.store.receive(duplicate, 1001)).toEqual(handoff)
    expect(t.store.markMaterialsPrepared('input-1', previews)).toBe(true)
    const prepared = t.store.pending('input-1')[0]!
    expect(prepared).toEqual({ ...handoff, materialsPrepared: true, input: { ...handoff.input, materials: previews } })
    expect(t.row()!.snapshot).toBe(snapshot)
    expect(t.store.markMaterialsPrepared('input-1', [{ ...previews[0]!, preview: 'late replacement' }])).toBe(false)
    const attempt = t.store.beginClassification('input-1', 1002, 20_000)!
    expect(attempt.attempt).toBe(1)
    expect(t.store.markMaterialsPrepared('input-1', previews)).toBe(false)
    expect(t.store.classified('input-1', { kind: 'amend', targetRef: 'question' }, attempt, 1003)).toBe(true)
    expect(t.store.markMaterialsPrepared('input-1', previews)).toBe(false)
    expect(t.store.pending('input-1')[0]!.input.materials).toEqual(previews)
  })

  it.each([
    { ref: 'other-file' }, { kind: 'merge_forward' }, { suppliedAt: 1001 }, { replied: false },
    { status: 'invented' }, { preview: 5 }, { actorOpenId: 'other-user' },
  ])('rejects changed source metadata or unsupported preview fields %j', patch => {
    const t = setup(), { handoff, previews } = preparing(t)
    expect(t.store.markMaterialsPrepared('input-1', [{ ...previews[0]!, ...patch }] as typeof previews)).toBe(false)
    expect(t.store.pending('input-1')).toEqual([handoff])
  })

  it('does not accept missing, duplicate or wholesale replacement inputs', () => {
    const t = setup(), { handoff, previews } = preparing(t)
    expect(t.store.markMaterialsPrepared('input-1', [])).toBe(false)
    expect(t.store.markMaterialsPrepared('input-1', [previews[0]!, previews[0]!])).toBe(false)
    expect(t.store.markMaterialsPrepared('input-1', handoff.input as unknown as typeof previews)).toBe(false)
    expect(t.store.pending('input-1')).toEqual([handoff])
  })

  it('cannot fill a human-retired or already accepted request', () => {
    const t = setup(), { previews } = preparing(t)
    t.store.retire('input-1', 'user_requested')
    expect(t.store.markMaterialsPrepared('input-1', previews)).toBe(false)
    expect(t.row()).toMatchObject({ result: 'user_requested', decision: null, attempt_count: 0 })
    const next = { ...input('input-2'), materialsPrepared: false, materials: [] }
    t.store.receive(next, 1000)
    t.registry.createTaskOnce({ sessionKey: 'session', messageId: 'input-2', requesterOpenId: 'alice', prompt: next.message.text, inbound: next.message })
    expect(t.store.markMaterialsPrepared('input-2', [])).toBe(false)
  })

  it('refuses a stale preparation if the host binding changes before the CAS write', () => {
    const t = setup(), { handoff, previews } = preparing(t)
    const changed = { ...handoff, route: { kind: 'question' as const, questionId: 9, anchorId: 10, originTaskId: 11 } }
    const concurrent = { ...previews[0]! }
    Object.defineProperty(concurrent, 'preview', { enumerable: true, get: () => {
      t.registry.db.prepare('UPDATE ingress_routes SET handoff=? WHERE message_id=?').run(JSON.stringify(changed), 'input-1')
      return previews[0]!.preview
    } })
    expect(t.store.markMaterialsPrepared('input-1', [concurrent])).toBe(false)
    expect(t.store.pending('input-1')).toEqual([changed])
  })
})
