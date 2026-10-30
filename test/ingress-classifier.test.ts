import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AcpRuntime, textBlock } from '../src/acp/runtime.js'
import { IngressClassifier, type IngressClassificationInput, type IngressClassifierRuntime } from '../src/acp/ingress-classifier.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'

const log = createLogger('ingress-classifier-test', 'error')
const input = (): IngressClassificationInput => ({
  message: { text: 'How is this going?', replyToRef: 'task-a-v1' },
  candidates: [{ ref: 'task-a-v1', title: 'Review the plan', status: 'running' }],
  recentHumanMessages: [{ authorRef: 'author-1', text: 'Review the plan' }],
})
const progress = { kind: 'progress', targetRef: 'task-a-v1' }
const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }

function stub(output = JSON.stringify(progress)) {
  type Listener = Parameters<IngressClassifierRuntime['subscribe']>[1]
  const listeners = new Map<string, Listener>()
  let ids = 0
  const emit = (sessionId: string, update: SessionUpdate) => listeners.get(sessionId)?.(update, { sessionId, update })
  const runtime = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async (_cwd: string, _mcp: unknown[] = []) => `s-${++ids}`),
    subscribe: vi.fn((sessionId: string, listener: Listener) => {
      listeners.set(sessionId, listener)
      return () => { listeners.delete(sessionId) }
    }),
    prompt: vi.fn(async (sessionId: string) => {
      emit(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output } })
      return { stopReason: 'end_turn' as const }
    }),
    closeSession: vi.fn(async (_sessionId: string) => {}),
    stop: vi.fn(async () => {}),
  }
  return { runtime, emit, listeners }
}

const make = (createRuntime: () => IngressClassifierRuntime, timeoutMs = 1000) =>
  new IngressClassifier({ createRuntime, cwd: '/tmp/friday-router-unit', timeoutMs, log })

afterEach(() => vi.useRealTimers())

describe('IngressClassifier', () => {
  // 生产 2026-09-28：「记住：…」被判 invalid_output——模型算不准 UTF-16 下标。改为逐字原句 quotes，由宿主定位。
  describe('memory_save_preference 用逐字原句定位', () => {
    const text = '记住：我习惯周五下午写周报，周五上午不要给我安排别的事'
    const request = () => ({ ...input(), message: { text }, allowExplicitPreference: true })
    it('quotes 在原文里按顺序定位成 spans；与模型自己给的错误下标相比以 quotes 为准', async () => {
      const s = stub(JSON.stringify({ kind: 'memory_save_preference', quotes: ['我习惯周五下午写周报', '周五上午不要给我安排别的事'], spans: [{ start: 0, end: 99 }], continueWork: false }))
      const classifier = make(() => s.runtime)
      const decision = await classifier.classify(request())
      expect(decision).toMatchObject({ kind: 'memory_save_preference', continueWork: false })
      const spans = (decision as { spans: { start: number; end: number }[] }).spans
      expect(spans.map(span => text.slice(span.start, span.end))).toEqual(['我习惯周五下午写周报', '周五上午不要给我安排别的事'])
      await classifier.stop()
    })
    it('漏写 continueWork 时按 false 处理，不让整条请求失败', async () => {
      const s = stub(JSON.stringify({ kind: 'memory_save_preference', quotes: ['我习惯周五下午写周报'] }))
      const classifier = make(() => s.runtime)
      expect(await classifier.classify(request())).toMatchObject({ kind: 'memory_save_preference', continueWork: false })
      await classifier.stop()
    })
    it('只容忍首尾空白、引号和句末标点；不在原文里的话（改写过的）判无效', async () => {
      const ok = stub(JSON.stringify({ kind: 'memory_save_preference', quotes: [' “我习惯周五下午写周报。” '], continueWork: false }))
      const c1 = make(() => ok.runtime)
      const decision = await c1.classify(request()) as { spans: { start: number; end: number }[] }
      expect(text.slice(decision.spans[0]!.start, decision.spans[0]!.end)).toBe('我习惯周五下午写周报')
      await c1.stop()
      for (const quotes of [['我喜欢周五写周报'], [], ['我习惯周五下午写周报', '记住：']]) {
        const bad = stub(JSON.stringify({ kind: 'memory_save_preference', quotes, continueWork: false }))
        const c2 = make(() => bad.runtime)
        await expect(c2.classify(request())).rejects.toMatchObject({ code: 'invalid_output' })
        await c2.stop()
      }
    })
  })

  it.each([
    { kind: 'memory_save_preference', spans: [{ start: 0, end: 10 }], continueWork: false },
    { kind: 'memory_save_preference', spans: [{ start: 0, end: 10 }], continueWork: true, targetRef: 'displayed-v1' },
    { kind: 'memory_confirm', targetRef: 'displayed-v1', continueWork: true },
  ])('accepts a current human memory control without fabricated identity: $kind', async decision => {
    const s = stub(JSON.stringify(decision)), classifier = make(() => s.runtime)
    const request = { ...input(), allowExplicitPreference: true,
      memoryTargets: [{ ref: 'displayed-v1', title: '本人偏好', body: '完整原句，不截断', replied: true }] }
    expect(await classifier.classify(request)).toEqual(decision)
    await classifier.stop()
  })

  it.each([
    { kind: 'memory_confirm', targetRef: 'global-latest', continueWork: false },
    { kind: 'memory_confirm', targetRef: 'displayed-v1', continueWork: false, actor: 'alice' },
    { kind: 'memory_confirm', targetRef: 'displayed-v1' },
    { kind: 'memory_forget', targetRef: 'displayed-v1' },
    { kind: 'memory_save_preference', spans: [{ start: 0, end: 999 }], continueWork: false },
    { kind: 'memory_save_preference', spans: [{ start: 0, end: 5 }, { start: 4, end: 8 }], continueWork: false },
    { kind: 'memory_save_preference', spans: [{ start: 0, end: 5 }], body: 'rewritten', continueWork: false },
  ])('rejects unauthorized memory targets, identity, rewritten content, host-only kinds and invalid spans: %j', async decision => {
    const s = stub(JSON.stringify(decision)), classifier = make(() => s.runtime)
    await expect(classifier.classify({ ...input(), allowExplicitPreference: true,
      memoryTargets: [{ ref: 'displayed-v1', title: '本人偏好', body: '完整原句', replied: false }] })).rejects.toMatchObject({ code: 'invalid_output' })
    await classifier.stop()
  })

  it('does not enable direct preference saving without the host own-DM eligibility flag', async () => {
    const s = stub(JSON.stringify({ kind: 'memory_save_preference', spans: [{ start: 0, end: 5 }], continueWork: false }))
    const classifier = make(() => s.runtime)
    await expect(classifier.classify(input())).rejects.toMatchObject({ code: 'invalid_output' })
    await classifier.stop()
  })
  it.each([
    { kind: 'progress', targetRef: 'task-a-v1' },
    { kind: 'stop', targetRef: 'task-a-v1' },
    { kind: 'amend', targetRef: 'task-a-v1' },
    { kind: 'new_work' },
    { kind: 'work_request' },
    { kind: 'clarify' },
  ])('accepts the exact $kind contract and closes its empty-MCP session', async decision => {
    const s = stub(JSON.stringify(decision))
    const classifier = make(() => s.runtime)
    expect(await classifier.classify(input())).toEqual(decision)
    expect(s.runtime.newSession).toHaveBeenCalledWith('/tmp/friday-router-unit', [])
    expect(s.runtime.closeSession).toHaveBeenCalledWith('s-1')
    expect(s.listeners.size).toBe(0)
    await classifier.stop()
  })

  it('uses the real ACP subscription path, ignores thoughts and creates a fresh session each time', async () => {
    const { app, state } = createFakeAgent({ script: [
      { kind: 'thought', text: '{"kind":"stop","targetRef":"forged"}' },
      { kind: 'text', text: JSON.stringify(progress) },
    ] })
    const factory = vi.fn(() => new AcpRuntime({ transport: { kind: 'inproc', agent: app }, maxConcurrent: 1,
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log }))
    const classifier = make(factory)
    try {
      expect(await classifier.classify(input())).toEqual(progress)
      expect(await classifier.classify(input())).toEqual(progress)
      expect(factory).toHaveBeenCalledTimes(1)
      expect(state.allPrompts.map(p => p.sessionId)).toEqual(['fake-session-1', 'fake-session-2'])
      expect(state.allPrompts.every(p => p.mcpServers.length === 0)).toBe(true)
      expect(state.sessions.size).toBe(0)
      expect(state.resumed).toEqual([])
    } finally { await classifier.stop() }
  })

  it.each([
    '{"kind":"stop","targetRef":"other-task"}',
    '{"kind":"stop"}',
    '{"kind":"progress","targetRef":"task-a-v1","actor":"admin"}',
    '{"kind":"new_work","targetRef":"task-a-v1"}',
    '{"kind":"work_request","targetRef":"task-a-v1"}',
    '{"kind":"clarify","reason":"extra"}',
    '[{"kind":"new_work"}]',
    '```json\n{"kind":"new_work"}\n```',
    '{"kind":"delete","targetRef":"task-a-v1"}',
  ])('rejects malformed or out-of-scope output %s', async output => {
    const s = stub(output)
    const classifier = make(() => s.runtime)
    await expect(classifier.classify(input())).rejects.toMatchObject({ code: 'invalid_output' })
    expect(s.runtime.stop).toHaveBeenCalledOnce()
    await classifier.stop()
  })

  it('does not expose non-contract identity fields or accept caller changes made during classification', async () => {
    const s = stub('{"kind":"stop","targetRef":"inserted-later"}')
    const start = deferred()
    s.runtime.start.mockImplementation(() => start.promise)
    const classifier = make(() => s.runtime)
    const data = Object.assign(input(), { credentials: 'must-not-be-forwarded' })
    const pending = classifier.classify(data)
    data.candidates.push({ ref: 'inserted-later', title: 'Injected later', status: 'running' })
    start.resolve()
    await expect(pending).rejects.toMatchObject({ code: 'invalid_output' })
    const sent = s.runtime.prompt.mock.calls[0] as unknown as [string, { text: string }[]]
    expect(sent[1][0]!.text).not.toContain('must-not-be-forwarded')
    expect(sent[1][0]!.text).not.toContain('inserted-later')
    await classifier.stop()
  })

  it('rejects duplicate candidate references before creating any runtime', async () => {
    const factory = vi.fn(() => stub().runtime)
    const classifier = make(factory)
    const data = input()
    data.candidates.push({ ...data.candidates[0]! })
    await expect(classifier.classify(data)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(factory).not.toHaveBeenCalled()
    await classifier.stop()
  })

  it('keeps independent work and an exact human-material reference as separate decisions', async () => {
    const decision = { kind: 'new_work', contextRefs: ['material-one'] }
    const s = stub(JSON.stringify(decision)), classifier = make(() => s.runtime)
    try {
      expect(await classifier.classify({ message: { text: '把刚才的内容记成待办' }, candidates: [],
        materials: [{ ref: 'material-one', kind: 'merge_forward', preview: '修复后通知报告人', status: 'ready' }] })).toEqual(decision)
      const sent = s.runtime.prompt.mock.calls[0] as unknown as [string, { text: string }[]]
      expect(sent[1][0]!.text).toContain('修复后通知报告人')
      expect(sent[1][0]!.text).toContain('Execution relationship and material references are separate')
      expect(sent[1][0]!.text).toContain('is not a progress query and must not receive the execution receipt')
    } finally { await classifier.stop() }
  })

  it.each([['forged'], ['material-one', 'material-one'], [12]])('rejects unknown, repeated or malformed material references %j', async contextRefs => {
    const s = stub(JSON.stringify({ kind: 'new_work', contextRefs })), classifier = make(() => s.runtime)
    try {
      await expect(classifier.classify({ message: { text: '处理这份材料' }, candidates: [],
        materials: [{ ref: 'material-one', kind: 'merge_forward', preview: '原文', status: 'ready' }] })).rejects.toMatchObject({ code: 'invalid_output' })
    } finally { await classifier.stop() }
  })

  it('keeps a task amendment and its bound material together through the real ACP contract', async () => {
    const decision = { kind: 'amend', targetRef: 'current-result', contextRefs: ['forwarded-report'] }
    const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: JSON.stringify(decision) }] })
    const classifier = make(() => new AcpRuntime({ transport: { kind: 'inproc', agent: app }, maxConcurrent: 1,
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log }))
    const data: IngressClassificationInput = {
      message: { text: '补上出处，负责人和截止没有写的留空。' },
      candidates: [
        { ref: 'old-records', title: '记录其他项目的事项', status: 'done', materialRefs: ['old-project'], lastInputAt: 10 },
        { ref: 'current-result', title: '整理这份报告中的跟进事项', status: 'done', materialRefs: ['forwarded-report'], lastInputAt: 30 },
      ],
      materials: [
        { ref: 'old-project', kind: 'text', preview: '其他项目事项', status: 'ready', suppliedAt: 10 },
        { ref: 'forwarded-report', kind: 'merge_forward', preview: '当前报告与报告人的跟进请求', status: 'partial', suppliedAt: 20 },
      ],
    }
    try {
      expect(await classifier.classify(data)).toEqual(decision)
      expect(JSON.parse(state.allPrompts[0]!.text.split('Input data:\n')[1]!)).toEqual(data)
    } finally { await classifier.stop() }
  })

  it.each([
    { kind: 'amend', targetRef: 'task-a-v1', contextRefs: ['unknown'] },
    { kind: 'amend', targetRef: 'task-a-v1', contextRefs: ['material-one', 'material-one'] },
    { kind: 'amend', targetRef: 'unknown', contextRefs: ['material-one'] },
    { kind: 'amend', targetRef: 'task-a-v1', contextRefs: null },
    { kind: 'amend', targetRef: 'task-a-v1', contextRefs: ['material-one'], actor: 'user' },
    { kind: 'stop', targetRef: 'task-a-v1', contextRefs: ['material-one'] },
    { kind: 'progress', targetRef: 'task-a-v1', contextRefs: ['material-one'] },
  ])('rejects invalid amendment refs and material-bearing control decisions %j', async decision => {
    const s = stub(JSON.stringify(decision)), classifier = make(() => s.runtime)
    try {
      await expect(classifier.classify({ ...input(), materials: [
        { ref: 'material-one', kind: 'text', preview: '原文', status: 'ready' },
      ] })).rejects.toMatchObject({ code: 'invalid_output' })
    } finally { await classifier.stop() }
  })

  it.each([
    { materialRefs: ['unknown'] },
    { materialRefs: ['material-one', 'material-one'] },
    { materialRefs: null },
    { materialRefs: [1] },
    { lastInputAt: -1 },
    { lastInputAt: 0.5 },
    { lastInputAt: Number.MAX_SAFE_INTEGER + 1 },
    { lastInputAt: '100' },
  ])('rejects unsupported host material relationships before starting a runtime %j', async fields => {
    const factory = vi.fn(() => stub().runtime), classifier = make(factory)
    const data = input()
    Object.assign(data.candidates[0]!, fields)
    data.materials = [{ ref: 'material-one', kind: 'text', preview: '原文', status: 'ready' }]
    await expect(classifier.classify(data)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(factory).not.toHaveBeenCalled()
    await classifier.stop()
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '100', null])('rejects a fabricated material time %j', async suppliedAt => {
    const factory = vi.fn(() => stub().runtime), classifier = make(factory)
    const data = input()
    data.materials = [{ ref: 'material-one', kind: 'text', preview: '原文', status: 'ready', suppliedAt: suppliedAt as number }]
    await expect(classifier.classify(data)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(factory).not.toHaveBeenCalled()
    await classifier.stop()
  })

  it('snapshots host associations and original timestamps before awaiting admission', async () => {
    const s = stub(JSON.stringify({ kind: 'amend', targetRef: 'task-a-v1', contextRefs: ['material-one'] }))
    const start = deferred()
    s.runtime.start.mockImplementation(() => start.promise)
    const classifier = make(() => s.runtime)
    const data = input()
    Object.assign(data.candidates[0]!, { materialRefs: ['material-one'], lastInputAt: 0, actor: 'hidden' })
    data.materials = [{ ref: 'material-one', kind: 'text', preview: '原文', status: 'ready', suppliedAt: 0 }]
    const pending = classifier.classify(data)
    data.candidates[0]!.materialRefs!.push('later-material')
    data.candidates[0]!.lastInputAt = 9
    data.materials[0]!.suppliedAt = 9
    data.materials[0]!.preview = 'changed later'
    start.resolve()
    try {
      expect(await pending).toEqual({ kind: 'amend', targetRef: 'task-a-v1', contextRefs: ['material-one'] })
      const sent = s.runtime.prompt.mock.calls[0] as unknown as [string, { text: string }[]]
      const snapshot = JSON.parse(sent[1][0]!.text.split('Input data:\n')[1]!)
      expect(snapshot.candidates).toEqual([{ ref: 'task-a-v1', title: 'Review the plan', status: 'running', materialRefs: ['material-one'], lastInputAt: 0 }])
      expect(snapshot.materials).toEqual([{ ref: 'material-one', kind: 'text', preview: '原文', status: 'ready', suppliedAt: 0 }])
    } finally { await classifier.stop() }
  })

  it('rejects a tool event even when valid JSON follows it', async () => {
    const s = stub()
    s.runtime.prompt.mockImplementation(async id => {
      s.emit(id, { sessionUpdate: 'tool_call', toolCallId: 'unexpected', title: 'bash', status: 'pending' })
      s.emit(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(progress) } })
      return { stopReason: 'end_turn' }
    })
    const classifier = make(() => s.runtime)
    await expect(classifier.classify(input())).rejects.toMatchObject({ code: 'tool_use' })
    await flush()
    expect(s.runtime.stop).toHaveBeenCalledOnce()
    expect(s.runtime.closeSession).not.toHaveBeenCalled()
    await classifier.stop()
  })

  it('rejects partial cancelled output', async () => {
    const s = stub()
    s.runtime.prompt.mockImplementation(async id => {
      s.emit(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(progress) } })
      return { stopReason: 'cancelled' } as never
    })
    const classifier = make(() => s.runtime)
    await expect(classifier.classify(input())).rejects.toMatchObject({ code: 'invalid_output' })
    await classifier.stop()
  })

  it('holds the single control slot through session close', async () => {
    const s = stub()
    const close = deferred()
    s.runtime.closeSession.mockImplementationOnce(() => close.promise)
    const classifier = make(() => s.runtime)
    const first = classifier.classify(input())
    const second = classifier.classify(input())
    await flush()
    expect(s.runtime.newSession).toHaveBeenCalledTimes(1)
    close.resolve()
    expect(await first).toEqual(progress)
    expect(await second).toEqual(progress)
    expect(s.runtime.start).toHaveBeenCalledTimes(1)
    expect(s.runtime.newSession).toHaveBeenCalledTimes(2)
    await classifier.stop()
  })

  it.each(['start', 'newSession', 'prompt', 'closeSession'] as const)('applies the total deadline during %s and discards late completion', async stage => {
    vi.useFakeTimers()
    const s = stub()
    const held = deferred<any>()
    s.runtime[stage].mockImplementationOnce(() => held.promise)
    const next = stub()
    const factory = vi.fn().mockReturnValueOnce(s.runtime).mockReturnValue(next.runtime)
    const classifier = make(factory, 50)
    const pending = classifier.classify(input()).catch(error => error)
    await vi.advanceTimersByTimeAsync(51)
    expect(await pending).toMatchObject({ code: 'timeout' })
    expect(s.runtime.stop).toHaveBeenCalledOnce()
    held.resolve(stage === 'newSession' ? 'late-session' : stage === 'prompt' ? { stopReason: 'end_turn' } : undefined)
    await flush()
    if (stage === 'start') expect(s.runtime.newSession).not.toHaveBeenCalled()
    if (stage === 'newSession') expect(s.runtime.prompt).not.toHaveBeenCalled()
    if (stage === 'prompt') expect(s.runtime.closeSession).not.toHaveBeenCalled()
    expect(await classifier.classify(input())).toEqual(progress)
    expect(factory).toHaveBeenCalledTimes(2)
    await classifier.stop()
  })

  it('returns at deadline but does not release the control slot until the old runtime is stopped', async () => {
    vi.useFakeTimers()
    const old = stub()
    const prompting = deferred<{ stopReason: 'end_turn' }>()
    const stopping = deferred()
    old.runtime.prompt.mockImplementation(() => prompting.promise)
    old.runtime.stop.mockImplementation(() => stopping.promise)
    const fresh = stub()
    const factory = vi.fn().mockReturnValueOnce(old.runtime).mockReturnValue(fresh.runtime)
    const classifier = make(factory, 50)
    const timedOut = classifier.classify(input()).catch(error => error)
    await vi.advanceTimersByTimeAsync(51)
    expect(await timedOut).toMatchObject({ code: 'timeout' })
    const queued = classifier.classify(input()).catch(error => error)
    await vi.advanceTimersByTimeAsync(51)
    expect(await queued).toMatchObject({ code: 'timeout' })
    expect(factory).toHaveBeenCalledTimes(1)
    stopping.resolve()
    prompting.resolve({ stopReason: 'end_turn' })
    await flush()
    expect(await classifier.classify(input())).toEqual(progress)
    expect(factory).toHaveBeenCalledTimes(2)
    await classifier.stop()
  })

  it('caller cancellation while queued does not stop another classification', async () => {
    const s = stub()
    const start = deferred()
    s.runtime.start.mockImplementation(() => start.promise)
    const classifier = make(() => s.runtime)
    const first = classifier.classify(input())
    const controller = new AbortController()
    const second = classifier.classify(input(), controller.signal).catch(error => error)
    controller.abort()
    expect(await second).toMatchObject({ code: 'aborted' })
    expect(s.runtime.stop).not.toHaveBeenCalled()
    start.resolve()
    expect(await first).toEqual(progress)
    await flush()
    expect(s.runtime.newSession).toHaveBeenCalledTimes(1)
    await classifier.stop()
  })

  it('admits the next request after a five-second runtime teardown within its own deadline', async () => {
    vi.useFakeTimers()
    const old = stub()
    old.runtime.prompt.mockImplementation(() => new Promise(() => {}))
    old.runtime.stop.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 5000)))
    const fresh = stub()
    const factory = vi.fn().mockReturnValueOnce(old.runtime).mockReturnValue(fresh.runtime)
    const classifier = make(factory, 15000)
    const first = classifier.classify(input()).catch(error => error)
    await vi.advanceTimersByTimeAsync(15001)
    expect(await first).toMatchObject({ code: 'timeout' })
    const second = classifier.classify(input())
    await vi.advanceTimersByTimeAsync(5000)
    expect(await second).toEqual(progress)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(old.runtime.stop).toHaveBeenCalledOnce()
    await classifier.stop()
  })

  it('does not create a replacement process when runtime teardown fails', async () => {
    const old = stub('invalid output')
    old.runtime.stop.mockRejectedValue(new Error('stop failed'))
    const factory = vi.fn(() => old.runtime)
    const classifier = make(factory)
    const first = classifier.classify(input()).catch(error => error)
    const queued = classifier.classify(input()).catch(error => error)
    expect(await first).toMatchObject({ code: 'stopped' })
    expect(await queued).toMatchObject({ code: 'stopped' })
    await expect(classifier.classify(input())).rejects.toMatchObject({ code: 'stopped' })
    expect(factory).toHaveBeenCalledTimes(1)
    await classifier.stop()
  })

  it('shutdown rejects active, queued and future requests without restarting a runtime', async () => {
    const s = stub()
    const start = deferred()
    s.runtime.start.mockImplementation(() => start.promise)
    const factory = vi.fn(() => s.runtime)
    const classifier = make(factory)
    const first = classifier.classify(input()).catch(error => error)
    const second = classifier.classify(input()).catch(error => error)
    await flush()
    await classifier.stop()
    expect(await first).toMatchObject({ code: 'stopped' })
    expect(await second).toMatchObject({ code: 'stopped' })
    start.resolve()
    await flush()
    await expect(classifier.classify(input())).rejects.toMatchObject({ code: 'stopped' })
    expect(factory).toHaveBeenCalledTimes(1)
    expect(s.runtime.newSession).not.toHaveBeenCalled()
    expect(s.runtime.stop).toHaveBeenCalledOnce()
  })

  it('classifies while the independent worker ACP Gate is occupied', async () => {
    const hold = deferred()
    const workerAgent = createFakeAgent({ script: [{ kind: 'hook', run: () => hold.promise }, { kind: 'text', text: 'worker result' }] })
    const worker = new AcpRuntime({ transport: { kind: 'inproc', agent: workerAgent.app }, maxConcurrent: 1,
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log })
    const routerAgent = createFakeAgent({ script: [{ kind: 'text', text: JSON.stringify(progress) }] })
    const classifier = make(() => new AcpRuntime({ transport: { kind: 'inproc', agent: routerAgent.app }, maxConcurrent: 1,
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log }))
    await worker.start()
    const session = await worker.newSession('/tmp/independent-worker')
    const task = worker.prompt(session, [textBlock('existing work')])
    try {
      await flush()
      expect(worker.load().active).toBe(1)
      expect(await classifier.classify(input())).toEqual(progress)
      expect(worker.load().active).toBe(1)
      expect(workerAgent.state.cancelled).toEqual([])
      expect(workerAgent.state.allPrompts).toHaveLength(1)
    } finally {
      hold.resolve()
      await task
      await classifier.stop()
      await worker.stop()
    }
  })
})
