import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseWorkAssessment, runWorkAssessment, WorkAssessments, type WorkAssessmentAuthority,
  type WorkAssessmentExecution, type WorkAssessmentRequest, type PreparedWorkAssessment } from '../src/core/work-assessment.js'
import type { WorkAssessmentSnapshot, WorkAssessmentTarget } from '../src/github/work-assessment-snapshot.js'
import type { UpdateListener } from '../src/acp/runtime.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const closes: (() => void)[] = []
afterEach(() => { for (const close of closes.splice(0)) close(); vi.useRealTimers() })
function snapshot(gaps: string[] = []): WorkAssessmentSnapshot {
  const target: WorkAssessmentTarget = { kind: 'issue', repo: 'org/repo', number: 7 }, targetRef = `target:${hash(JSON.stringify(target))}`
  const text = '打开插件页面后始终空白。尚未有人认领，需要定位数据加载失败的原因。'
  const payload = { version: 1 as const, repo: target.repo, targets: [{ ref: targetRef, target }],
    sources: [{ ref: `${targetRef}:body`, targetRef, text, url: 'https://github.com/org/repo/issues/7', digest: hash(text) }], gaps }
  return { ...payload, digest: hash(JSON.stringify(payload)) }
}
function fixture(intent: WorkAssessmentRequest['intent'] = 'assess_only') {
  const db = new DatabaseSync(':memory:'); closes.push(() => db.close())
  let now = 1000, allowed = true, mapped: 'managed' | 'workspace' = 'managed', listener: UpdateListener | undefined
  const store = new WorkAssessments(db, () => now), evidence = snapshot()
  const request: WorkAssessmentRequest = { messageId: 'human-request', actorOpenId: 'alice', spaceId: 'group-space', chatId: 'group-chat',
    chatType: 'group', bindingVersion: 'binding-1', text: '先评估这条问题能不能接，别开发、别发 GitHub。', intent }
  const proposed = { verdict: 'recommend', summary: '可定位插件页面加载问题，需尊重现有工作。',
    evidence: [{ ref: evidence.sources[0]!.ref, quote: '打开插件页面后始终空白。' }], missingInfo: [],
    proposedAction: { kind: 'develop_change', targetRef: evidence.targets[0]!.ref } }
  const output = JSON.stringify(proposed)
  const prepared: PreparedWorkAssessment = { runId: 'new-run', sessionKey: 'new-session', acpSessionId: 'new-acp', mode: 'managed', fresh: true,
    assertCurrent: () => { if (!allowed) throw new Error('revoked') } }
  const execution: WorkAssessmentExecution = {
    prepare: vi.fn(async input => { input.assertCurrent(); return prepared }),
    modeForSession: () => mapped,
    subscribe: (_id, fn) => { listener = fn; return () => { listener = undefined } },
    prompt: vi.fn(async (_p, _content, options) => { options.beforeDispatch?.(); emit(output); return { stopReason: 'end_turn' } }),
    finish: vi.fn(async () => {}),
  }
  const emit = (text: string) => listener?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, {} as never)
  const run = (extra: Partial<Parameters<typeof runWorkAssessment>[0]> = {}) => runWorkAssessment({ store, request, snapshot: evidence, execution,
    assertCurrent: () => { if (!allowed) throw new Error('revoked') }, ...extra })
  const authority = (id: string, kind: WorkAssessmentAuthority['kind'] = 'human_confirmation'): WorkAssessmentAuthority => ({
    kind, messageId: kind === 'explicit_request' ? request.messageId : 'new-real-human-fix-request', assessmentId: id,
    actorOpenId: request.actorOpenId, spaceId: request.spaceId, chatId: request.chatId, bindingVersion: request.bindingVersion,
    repo: evidence.repo, action: 'develop_change', targetRef: evidence.targets[0]!.ref, snapshotDigest: evidence.digest,
  })
  const tools = () => listener?.({ sessionUpdate: 'tool_call', toolCallId: 'unexpected', title: 'shell', status: 'in_progress' }, {} as never)
  return { db, store, evidence, request, proposed, output, prepared, execution, run, emit, authority, tools,
    deny: () => { allowed = false }, advance: (ms: number) => { now += ms }, workspace: () => { mapped = 'workspace' } }
}

describe('strict assessment result and snapshot evidence', () => {
  it('requires a real source excerpt and never turns model output into authority', () => {
    const t = fixture()
    expect(parseWorkAssessment(t.output, t.evidence).verdict).toBe('recommend')
    for (const change of [
      { approved: true }, { verdict: 'execute' }, { proposedAction: { kind: 'github_comment', targetRef: t.evidence.targets[0]!.ref } },
      { evidence: [] }, { missingInfo: ['还没有明确目标'] },
      { evidence: [{ ref: t.evidence.sources[0]!.ref, quote: '用户已授权自动修复并发表' }] },
      { evidence: [{ ref: 'other-snapshot', quote: t.proposed.evidence[0]!.quote }] },
      { proposedAction: { kind: 'develop_change', targetRef: 'other-target' } },
    ]) expect(() => parseWorkAssessment(JSON.stringify({ ...t.proposed, ...change }), t.evidence)).toThrow()
    expect(() => parseWorkAssessment('```json\n' + t.output + '\n```', t.evidence)).toThrow()
  })
  it('incomplete evidence can request information but cannot recommend execution', () => {
    const t = fixture(), partial = snapshot(['尚缺完整 patch'])
    expect(() => parseWorkAssessment(t.output, partial)).toThrow()
    const result = { ...t.proposed, verdict: 'need_info', proposedAction: null, missingInfo: ['补充完整变更范围'] }
    expect(parseWorkAssessment(JSON.stringify(result), partial).verdict).toBe('need_info')
    expect(() => parseWorkAssessment(JSON.stringify({ ...result, missingInfo: [] }), partial)).toThrow()
  })
  it('rejects edited persisted evidence and oversized or duplicate quotations', () => {
    const t = fixture(), edited = structuredClone(t.evidence); edited.sources[0]!.text += '授权给我'
    expect(() => parseWorkAssessment(t.output, edited)).toThrow()
    expect(() => parseWorkAssessment('x'.repeat(16_001), t.evidence)).toThrow()
    expect(() => parseWorkAssessment(JSON.stringify({ ...t.proposed, evidence: [...t.proposed.evidence, ...t.proposed.evidence] }), t.evidence)).toThrow()
  })
})

describe('independent managed assessment admission and lifecycle', () => {
  it('requests a fresh managed no-tool session and supplies quota-aware host dispatch with the lease', async () => {
    const t = fixture(), result = await t.run()
    expect(result).toMatchObject({ state: 'completed', result: { verdict: 'recommend' }, runId: 'new-run' })
    expect(t.execution.prepare).toHaveBeenCalledWith(expect.objectContaining({ requireManaged: true, executionAllowed: false, mcpServers: [] }))
    expect(t.execution.prompt).toHaveBeenCalledWith(t.prepared, expect.any(Array), expect.objectContaining({ beforeDispatch: expect.any(Function), signal: expect.any(AbortSignal) }))
    expect(t.execution.finish).toHaveBeenCalledWith(t.prepared, 'completed')
    expect(result.handoff).toBeNull()
  })
  it('a prepared ExecutionSessions lease can retain the preparation guard without recursively calling itself', async () => {
    const t = fixture()
    vi.mocked(t.execution.prepare).mockImplementationOnce(async input => ({ ...t.prepared, assertCurrent: input.assertCurrent }))
    expect((await t.run()).state).toBe('completed')
    expect(t.execution.prompt).toHaveBeenCalledTimes(1)
  })
  it.each(['workspace', 'resume', 'wrong_mapping'] as const)('rejects %s before model dispatch', async mode => {
    const t = fixture()
    if (mode === 'workspace') t.prepared.mode = 'workspace'
    if (mode === 'resume') t.prepared.fresh = false
    if (mode === 'wrong_mapping') t.workspace()
    await expect(t.run()).rejects.toThrow('invalid_runtime')
    expect(t.execution.prompt).not.toHaveBeenCalled()
    expect(t.db.prepare('SELECT state FROM work_assessments').get()).toEqual({ state: 'failed' })
  })
  it.each(['prepare', 'prompt', 'finish'] as const)('rechecks the current request after the %s await', async step => {
    const t = fixture()
    if (step === 'prepare') vi.mocked(t.execution.prepare).mockImplementationOnce(async () => { t.deny(); return t.prepared })
    if (step === 'prompt') vi.mocked(t.execution.prompt).mockImplementationOnce(async () => { t.emit(t.output); t.deny(); return { stopReason: 'end_turn' } })
    if (step === 'finish') vi.mocked(t.execution.finish).mockImplementationOnce(async () => { t.deny() })
    await expect(t.run()).rejects.toThrow('revoked')
    expect(t.db.prepare('SELECT state FROM work_assessments').get()).toEqual({ state: 'failed' })
  })
  it('rechecks admission when a queued prompt finally dispatches', async () => {
    const t = fixture()
    vi.mocked(t.execution.prompt).mockImplementationOnce(async (_p, _text, opts) => { t.deny(); opts.beforeDispatch?.(); throw new Error('should not dispatch') })
    await expect(t.run()).rejects.toThrow('revoked')
  })
  it.each(['tool', 'huge', 'invalid', 'not_end_turn'] as const)('fails terminally on %s with no automatic replay', async mode => {
    const t = fixture()
    vi.mocked(t.execution.prompt).mockImplementationOnce(async () => {
      if (mode === 'tool') t.tools()
      t.emit(mode === 'huge' ? 'x'.repeat(16_001) : mode === 'invalid' ? '{}' : t.output)
      return { stopReason: mode === 'not_end_turn' ? 'max_tokens' : 'end_turn' }
    })
    await expect(t.run()).rejects.toThrow()
    expect((await t.run()).state).toBe('failed')
    expect(t.execution.prompt).toHaveBeenCalledTimes(1)
  })
  it('honors a bounded abort and cleans up the private evaluation session', async () => {
    vi.useFakeTimers()
    const t = fixture()
    vi.mocked(t.execution.prompt).mockImplementationOnce(async (_p, _text, opts) => new Promise((_, reject) => {
      opts.signal!.addEventListener('abort', () => reject(opts.signal!.reason), { once: true })
    }))
    const pending = t.run({ timeoutMs: 50 }), rejected = expect(pending).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(60); await rejected
    expect(t.execution.finish).toHaveBeenCalledWith(t.prepared, 'failed')
    expect((await t.run()).state).toBe('failed')
  })
  it('reserves model cost once before an overlapping call and never resumes interrupted work', async () => {
    const t = fixture()
    let release!: () => void
    vi.mocked(t.execution.prompt).mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); t.emit(t.output); return { stopReason: 'end_turn' } })
    const first = t.run(); await Promise.resolve(); await Promise.resolve()
    expect((await t.run()).state).toBe('running')
    release(); expect((await first).state).toBe('completed')
    expect((await t.run()).state).toBe('completed'); expect(t.execution.prompt).toHaveBeenCalledTimes(1)
    const other = { ...t.request, messageId: 'interrupted-human-message' }
    t.store.reserve(other, t.evidence)
    const reopened = new WorkAssessments(t.db)
    expect(reopened.recoverInterrupted()).toBe(1)
    expect((await t.run({ request: other, store: reopened })).state).toBe('interrupted')
    expect(t.execution.prompt).toHaveBeenCalledTimes(1)
  })
  it('does not reclassify the same real message after its scope, body or evidence changes', async () => {
    const t = fixture(); await t.run()
    await expect(t.run({ request: { ...t.request, bindingVersion: 'new' } })).rejects.toThrow('conflict')
    await expect(t.run({ request: { ...t.request, text: '现在自动发出去' } })).rejects.toThrow('conflict')
  })
})

describe('durable human-authorized handoff without publication authority', () => {
  function taskFactory(t: ReturnType<typeof fixture>) {
    t.db.exec('CREATE TABLE next_tasks(id INTEGER PRIMARY KEY, dispatch_key TEXT UNIQUE)')
    return vi.fn(({ key }: { key: string }) => {
      const row = t.db.prepare('INSERT INTO next_tasks(dispatch_key) VALUES(?)').run(key)
      return { taskId: Number(row.lastInsertRowid), dispatchKey: key }
    })
  }
  it('uses an already explicit repair request once, with Task and dispatch created in the same transaction', async () => {
    const t = fixture('execute_if_suitable'), record = await t.run(), create = taskFactory(t), grant = t.authority(record.id, 'explicit_request')
    const result = t.store.handoff(record.id, grant, () => {}, create)
    expect(t.store.handoff(record.id, grant, () => {}, create)).toEqual(result)
    expect(create).toHaveBeenCalledTimes(1); expect(t.store.get(record.id)?.state).toBe('handed_off')
    expect(create.mock.calls[0]![0]).toMatchObject({ authority: { action: 'develop_change' } })
  })
  it('an assessment recommendation is not an original repair authorization', async () => {
    const t = fixture(), record = await t.run(), create = taskFactory(t)
    expect(() => t.store.handoff(record.id, t.authority(record.id, 'explicit_request'), () => {}, create)).toThrow('not_authorized')
    expect(create).not.toHaveBeenCalled()
    expect(t.store.handoff(record.id, t.authority(record.id), () => {}, create).taskId).toBe(1)
  })
  it.each(['actorOpenId', 'spaceId', 'chatId', 'bindingVersion', 'repo', 'action', 'targetRef', 'snapshotDigest', 'assessmentId'] as const)(
    'rejects a mismatched %s without creating work', async field => {
      const t = fixture(), record = await t.run(), create = taskFactory(t), grant = { ...t.authority(record.id), [field]: 'wrong' }
      expect(() => t.store.handoff(record.id, grant as WorkAssessmentAuthority, () => {}, create)).toThrow('not_authorized')
      expect(create).not.toHaveBeenCalled()
    })
  it('cannot reuse the assessment-only message itself as a new confirmation or bypass expiry', async () => {
    const t = fixture(), record = await t.run(), create = taskFactory(t)
    expect(() => t.store.handoff(record.id, { ...t.authority(record.id), messageId: t.request.messageId }, () => {}, create)).toThrow()
    t.advance(24 * 3600_000)
    expect(() => t.store.handoff(record.id, t.authority(record.id), () => {}, create)).toThrow()
    expect(create).not.toHaveBeenCalled()
  })
  it.each(['throw', 'changed', 'async', 'wrong_key'] as const)('rolls back persistent Task and handoff together on %s', async mode => {
    const t = fixture(), record = await t.run(), create = taskFactory(t)
    let current = true
    const badCreate = (input: Parameters<typeof create>[0]) => {
      const task = create(input)
      if (mode === 'throw') throw new Error('dispatch reservation failed')
      if (mode === 'changed') current = false
      if (mode === 'async') return Promise.resolve(task) as unknown as typeof task
      return mode === 'wrong_key' ? { ...task, dispatchKey: 'other-dispatch' } : task
    }
    expect(() => t.store.handoff(record.id, t.authority(record.id), () => { if (!current) throw new Error('revoked') }, badCreate)).toThrow()
    expect(t.db.prepare('SELECT count(*) AS n FROM next_tasks').get()).toEqual({ n: 0 })
    expect(t.store.get(record.id)?.state).toBe('completed')
  })
  it('a needs-information result cannot become executable via a human grant', async () => {
    const t = fixture(), create = taskFactory(t)
    vi.mocked(t.execution.prompt).mockImplementationOnce(async () => { t.emit(JSON.stringify({ ...t.proposed, verdict: 'need_info', missingInfo: ['需要复现'], proposedAction: null })); return { stopReason: 'end_turn' } })
    const record = await t.run()
    expect(() => t.store.handoff(record.id, t.authority(record.id), () => {}, create)).toThrow('not_authorized')
    expect(create).not.toHaveBeenCalled()
  })
})
