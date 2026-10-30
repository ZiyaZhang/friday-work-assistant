import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { FeedbackControl, type FeedbackStopReceipt } from '../src/core/feedback-control.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import type { AskBugQuestionReceipt } from '../src/core/question-types.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { IssueLinks } from '../src/github/issues.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const QUESTION = '发生前最后做了什么？'
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function msg(id = 'origin', patch: Partial<InboundMessage> = {}): InboundMessage {
  return { eventId: `ev_${id}`, messageId: id, chatId: 'chat', chatType: 'group', tenantId: 'tenant-synthetic', threadId: 'thread', msgType: 'text',
    text: '@Friday 排查这条合成反馈', senderOpenId: 'alice', senderType: 'user', mentions: [{ key: '@Friday', openId: 'bot', name: 'Friday' }], createTimeMs: Date.now(), ...patch }
}

/** Real HTTP -> host -> SQLite/Delivery/ACP. The model, classifier and Feishu transport are deterministic substitutes. */
async function setup(over: Partial<InternalApiDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'feedback-control-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)
  const registry = new Registry(join(home, 'friday.db')), bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs), routines = new RoutineStore(registry.db)
  const feedback = new FeedbackControl(registry, bugs, questions, routines), memory = new ChannelMemory(registry.db), messageCache = new MessageCache(registry.db)
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'chat', openId: 'alice' })
  const feishu = new FakeFeishu(); feishu.members.set('chat', new Set(['alice', 'bob']))
  const log = createLogger('feedback-control-test', 'error'), messages = new MessageService(asFeishuClient(feishu), messageCache, log), tokens = new TokenIssuer('synthetic')
  const { app, state } = createFakeAgent({ script: [] })
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, registry, feedback, memory, messages, questions, routines, ...sp, feishu: asFeishuClient(feishu), runtime,
    ingressClassifier: { classify: async (input) => input.message.replyToRef ? { kind: 'amend', targetRef: input.message.replyToRef } : { kind: 'new_work' } }, tokens, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/synthetic', botOpenId: 'bot', log })
  const api = createInternalApi({ registry, feedback, bugs, questions, routines, memory, messageCache, messages, issueLinks: new IssueLinks(registry.db), todos: new Todos(registry.db), ...sp, feishu: asFeishuClient(feishu), tokens, log, maxHistoryPerCall: 50,
    resolveActorForSession: key => orchestrator.resolveActorForSession(key), allowedRoutesForSession: key => orchestrator.allowedRoutesForSession(key),
    canPersistDerivedState: key => orchestrator.canPersistDerivedState(key), stopFeedback: (key, runId, id, manage) => orchestrator.stopFeedback(key, runId, id, manage),
    canPersistFeedbackState: (key, runId, id) => orchestrator.canPersistFeedbackState(key, runId, id),
    recordDomainOperation: (key, runId, receipt) => orchestrator.recordDomainOperation(key, runId, receipt),
    controlRoutine: (id, action) => orchestrator.controlRoutine(id, action),
    resolveBugQuestionReply: (key, runId, input) => orchestrator.resolveBugQuestionReply(key, runId, input),
    askBugQuestion: (key, runId, input) => orchestrator.askBugQuestion(key, runId, input), deliverToolResult: (key, runId, input) => orchestrator.deliverToolResult(key, runId, input), ...over })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const current = () => {
    const sessionId = state.allPrompts.at(-1)!.sessionId, session = registry.getSessionByAcpId(sessionId)!
    const servers = state.sessions.get(sessionId)!.mcpServers as { env: { name: string; value: string }[] }[]
    return { sessionId, session, token: servers[0]!.env.find(entry => entry.name === 'FRIDAY_CAP_TOKEN')!.value }
  }
  const post = async <T = Record<string, unknown>>(route: string, body: Record<string, unknown>, token = current().token) => {
    const response = await fetch(`${url}/v1/${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as T }
  }
  const record = async () => { const r = await post<{ bucket: { id: number } }>('bug/record', { title: '合成反馈', text: '刷新后恢复' }); expect(r.status).toBe(200); return r.body.bucket.id }
  const ask = (id: number) => post<AskBugQuestionReceipt>('bug/ask', { id, kind: 'info', question: QUESTION })
  const stop = (id: number, route = 'bug/control') => post<FeedbackStopReceipt>(route, route === 'bug/control' ? { id, action: 'stop' } : { id, phase: 'cancelled' })
  const notices = () => feishu.sent.filter(s => s.kind === 'replyText').map(s => String(s.payload))
  cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())); await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  return { ...sp, cfg, registry, bugs, questions, routines, feedback, memory, feishu, state, space, runtime, orchestrator, current, post, record, ask, stop, notices, url }
}

describe('feedback control host boundary', () => {
  it.each(['bug/control', 'bug/intake'])('%s stops the bound followup, preserves the explicit controller only until its factual receipt, and rejects later tools', async (route) => {
    const t = await setup(); let id = 0, followupId = 0
    t.state.script = [{ kind: 'hook', run: async () => {
      id = await t.record()
      const f = await t.post<{ followup: { id: number; feedbackId: number } }>('followup/add', { note: '之后核查结果', in_minutes: 5 })
      expect(f.status).toBe(200); expect(f.body.followup.feedbackId).toBe(id); followupId = f.body.followup.id
      const stopped = await t.stop(id, route)
      expect(stopped).toMatchObject({ status: 200, body: { applied: true, status: 'open', followups_paused: 1 } })
      expect((await t.stop(id)).body).toEqual(stopped.body)
      expect((await t.ask(id)).status).toBe(403)
      expect((await t.post('followup/add', { note: '不可重启', in_minutes: 5 })).status).toBe(403)
    } }, { kind: 'text', text: '不应发送的模型旧内容' }]
    await t.orchestrator.handleMessage(msg())
    expect(t.bugs.get(id)).toMatchObject({ status: 'open', intakePhase: 'cancelled', count: 1 })
    expect(t.routines.get(followupId)?.enabled).toBe(false)
    expect(t.registry.taskForMessage('origin')).toMatchObject({ status: 'done', stopReason: 'feedback_control' })
    expect(t.notices()).toHaveLength(1); expect(t.notices()[0]).toContain('「合成反馈」已停止跟进')
    expect(t.feishu.answers()).toEqual([]); expect(t.memory.recent(`space:${t.space.id}`)).toEqual([])
  })

  it('permits fixed control after a repository read, while derived writes and extra body fields remain denied', async () => {
    const t = await setup(); let id = 0
    t.state.script = [{ kind: 'hook', run: async () => {
      id = await t.record(); t.orchestrator.noteRepositoryRead(t.current().session.sessionKey, 'synthetic/private')
      expect(t.orchestrator.canPersistDerivedState(t.current().session.sessionKey)).toBe(false)
      expect((await t.post('bug/intake', { id, phase: 'diagnosing' })).status).toBe(403)
      expect((await t.post('bug/control', { id, action: 'stop', note: 'private source' })).status).toBe(400)
      expect((await t.stop(id)).status).toBe(200)
    } }, { kind: 'text', text: 'private source body' }]
    await t.orchestrator.handleMessage(msg())
    expect(t.notices()).toHaveLength(1); expect(t.notices()[0]).not.toContain('private')
    expect(t.feishu.answers()).toEqual([])
  })

  it('preserves new raw replies to a stopped question or report without resuming execution', async () => {
    const t = await setup(); let id = 0, q!: AskBugQuestionReceipt
    t.state.script = [{ kind: 'hook', run: async () => { id = await t.record(); q = (await t.ask(id)).body } }]
    await t.orchestrator.handleMessage(msg())
    t.state.script = [{ kind: 'hook', run: async () => { expect((await t.stop(id)).status).toBe(200) } }]
    await t.orchestrator.handleMessage(msg('control', { threadId: 'control-thread' }))
    expect(t.questions.get(q.question_id)?.resolution).toBe('cancelled')
    const stopped = t.bugs.get(id)
    const prompts = t.state.allPrompts.length
    for (const [index, parentId] of [q.message_id!, 'origin'].entries()) {
      const inbound = msg(`late-${index}`, { parentId, text: `补充 ${index}：文字是草稿，不是已发送的消息`, mentions: [] })
      await t.orchestrator.handleMessage(inbound)
      await t.orchestrator.handleMessage(inbound)
    }
    expect(t.state.allPrompts).toHaveLength(prompts)
    expect(t.questions.replies(q.question_id)).toEqual([])
    expect(t.bugs.get(id)).toEqual(stopped)
    expect(t.bugs.reports(id).filter(r => r.recordKind === 'user_note')).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: 'late-0', reporterOpenId: 'alice', text: '补充 0：文字是草稿，不是已发送的消息' }),
      expect.objectContaining({ messageId: 'late-1', reporterOpenId: 'alice', text: '补充 1：文字是草稿，不是已发送的消息' }),
    ]))
    expect(t.bugs.reports(id)).toHaveLength(3)
    expect(t.questions.readContext(id, t.space.id)).toMatchObject({
      reportsTruncated: false,
      reports: expect.arrayContaining([expect.objectContaining({ messageId: 'late-1', recordKind: 'user_note', text: '补充 1：文字是草稿，不是已发送的消息' })]),
    })
    expect(t.notices().filter(text => text.includes('补充已记到'))).toHaveLength(2)
    expect(t.registry.taskForMessage('late-0')).toBeUndefined()
    expect(t.registry.db.prepare('SELECT * FROM task_amendments').all()).toEqual([])
  })

  it('keeps a new model turn alive after recording a stopped-case note, without allowing a new followup', async () => {
    const t = await setup(); let id = 0
    t.state.script = [{ kind: 'hook', run: async () => { id = await t.record(); expect((await t.stop(id)).status).toBe(200) } }]
    await t.orchestrator.handleMessage(msg())
    const stopped = t.bugs.get(id)
    t.state.script = [{ kind: 'hook', run: async () => {
      const note = await t.post('bug/record', { bucket_id: id, title: '模型不应改标题', text: '模型派生的其他内容', link: 'https://example.invalid/private' })
      expect(note.status).toBe(200)
      const task = t.registry.taskForMessage('new-note')!
      expect(t.feedback.taskFeedbackIds(task.id)).toContain(id)
      expect(t.feedback.taskStopped(task.id)).toBe(false)
      expect((await t.post('followup/add', { note: '晚点继续', in_minutes: 5 })).status).toBe(409)
    } }, { kind: 'text', text: '补充已记录，仍停止跟进。' }]
    await t.orchestrator.handleMessage(msg('new-note', { threadId: 'note-thread', text: '@Friday 补充：文字是草稿' }))
    expect(t.registry.taskForMessage('new-note')?.status).toBe('done')
    expect(t.bugs.get(id)).toEqual(stopped)
    expect(t.bugs.reports(id).find(r => r.messageId === 'new-note')).toMatchObject({ recordKind: 'user_note', text: '补充：文字是草稿', link: null })
    expect(t.feishu.answers().at(-1)).toBe('补充已记录，仍停止跟进。')
  })

  it('does not archive progress queries as corrections, and routes a new request independently', async () => {
    const t = await setup(); let id = 0
    t.state.script = [{ kind: 'hook', run: async () => { id = await t.record(); await t.stop(id) } }]
    await t.orchestrator.handleMessage(msg())
    const classify = vi.spyOn((t.orchestrator as any).deps.ingressClassifier, 'classify')
    classify.mockResolvedValueOnce({ kind: 'progress', targetRef: 'feedback' })
    await t.orchestrator.handleMessage(msg('status', { parentId: 'origin', text: '这条现在什么状态', mentions: [] }))
    expect(t.bugs.reports(id)).toHaveLength(1)
    const prompts = t.state.allPrompts.length
    classify.mockResolvedValueOnce({ kind: 'new_work' })
    t.state.script = [{ kind: 'text', text: '处理另一项请求。' }]
    await t.orchestrator.handleMessage(msg('other-work', { parentId: 'origin', text: '另外帮我看这个新问题', mentions: [] }))
    expect(t.state.allPrompts).toHaveLength(prompts + 1)
    expect(t.registry.taskForMessage('other-work')?.sessionKey).not.toBe(t.registry.taskForMessage('origin')?.sessionKey)
    expect(t.bugs.reports(id)).toHaveLength(1)
  })

  it('retains the classified ingress and rolls back the note when archiving fails, so redelivery applies it once', async () => {
    const t = await setup(); let id = 0
    t.state.script = [{ kind: 'hook', run: async () => { id = await t.record(); await t.stop(id) } }]
    await t.orchestrator.handleMessage(msg())
    const classify = vi.spyOn((t.orchestrator as any).deps.ingressClassifier, 'classify')
    const originalCapture = t.bugs.captureUserNote.bind(t.bugs)
    const capture = vi.spyOn(t.bugs, 'captureUserNote').mockImplementationOnce(input => {
      originalCapture(input)
      throw new Error('synthetic storage failure after writing the note')
    })
    const inbound = msg('retry-note', { parentId: 'origin', text: '文字只是草稿', mentions: [] })
    await expect(t.orchestrator.handleMessage(inbound)).rejects.toThrow('synthetic storage failure')
    const pending = t.registry.db.prepare('SELECT handoff,decision,result,attempt_count,notice FROM ingress_routes WHERE message_id = ?')
      .get('retry-note') as { handoff: string; decision: string; result: string | null; attempt_count: number; notice: string | null }
    expect(pending).toMatchObject({ result: null, attempt_count: 1, notice: null })
    expect(JSON.parse(pending.handoff).message).toEqual(inbound)
    expect(JSON.parse(pending.decision)).toEqual({ kind: 'amend', targetRef: 'feedback' })
    expect(t.bugs.reports(id).filter(r => r.messageId === 'retry-note')).toEqual([])
    expect(t.notices().filter(text => text.includes('补充已记到'))).toEqual([])
    await t.orchestrator.handleMessage(inbound)
    await t.orchestrator.handleMessage(inbound)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(classify).toHaveBeenCalledTimes(1)
    expect(t.bugs.reports(id).filter(r => r.messageId === 'retry-note')).toMatchObject([{ text: inbound.text, recordKind: 'user_note' }])
    expect(t.registry.db.prepare('SELECT result FROM ingress_routes WHERE message_id = ?').get('retry-note')?.result).toContain('补充已记到')
    expect(t.notices().filter(text => text.includes('补充已记到'))).toHaveLength(1)
  })

  it('rechecks membership after classifying a stopped-case correction', async () => {
    const t = await setup(); let id = 0
    t.state.script = [{ kind: 'hook', run: async () => { id = await t.record(); await t.stop(id) } }]
    await t.orchestrator.handleMessage(msg())
    vi.spyOn((t.orchestrator as any).deps.ingressClassifier, 'classify').mockImplementationOnce(async () => {
      t.feishu.members.set('chat', new Set(['bob']))
      return { kind: 'amend', targetRef: 'feedback' }
    })
    const before = t.notices().length
    await t.orchestrator.handleMessage(msg('not-member', { parentId: 'origin', text: '补充已失去成员权限', mentions: [] }))
    expect(t.bugs.reports(id)).toHaveLength(1)
    expect(t.notices()).toHaveLength(before)
  })

  it('rechecks membership after await and leaves the case unchanged when the controller leaves the group', async () => {
    const t = await setup(), waiting = deferred(), release = deferred(); let id = 0
    t.state.script = [{ kind: 'hook', run: async () => {
      id = await t.record()
      vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementationOnce(async () => { waiting.resolve(); await release.promise; return new Set(['bob']) })
      const stopping = t.stop(id); await waiting.promise; release.resolve()
      expect((await stopping).status).toBe(409)
    } }, { kind: 'text', text: '控制未执行。' }]
    await t.orchestrator.handleMessage(msg())
    expect(t.bugs.get(id)?.intakePhase).toBe('new')
  })

  it('blocks an upload already awaiting its result when control succeeds, without a late file POST', async () => {
    const t = await setup(), uploading = deferred(), release = deferred()
    vi.spyOn(t.feishu, 'uploadFile').mockImplementation(async () => { uploading.resolve(); await release.promise; return 'uploaded' })
    t.state.script = [{ kind: 'hook', run: async () => {
      const id = await t.record(); writeFileSync(join(t.current().session.cwd, 'result.txt'), 'synthetic old result')
      const pending = t.post('file/send', { path: 'result.txt' }); await uploading.promise
      expect((await t.stop(id)).status).toBe(200); release.resolve()
      expect((await pending).status).not.toBe(200)
    } }]
    try { await t.orchestrator.handleMessage(msg()) } finally { release.resolve() }
    expect(t.feishu.sent.filter(s => /File/.test(s.kind))).toEqual([])
    expect(t.notices()).toHaveLength(1); expect(t.notices()[0]).toContain('已停止跟进')
  })

  it('returns the committed control fact if the model fails after the tool receipt', async () => {
    const t = await setup(); let id = 0
    t.state.script = [{ kind: 'hook', run: async () => { id = await t.record(); expect((await t.stop(id)).status).toBe(200); throw new Error('synthetic model failure after commit') } }]
    await t.orchestrator.handleMessage(msg())
    expect(t.bugs.get(id)?.intakePhase).toBe('cancelled')
    expect(t.registry.taskForMessage('origin')).toMatchObject({ status: 'done', stopReason: 'feedback_control' })
    expect(t.notices()).toHaveLength(1); expect(t.notices()[0]).toContain('已停止跟进')
  })

  it('denies a native-tool approval that resolves after successful control', async () => {
    const t = await setup(), requested = deferred(), release = deferred()
    // Approval decision is a substitute; the ACP permission method and its waiting boundary are real.
    vi.spyOn(t.orchestrator as any, 'askApproval').mockImplementation(async () => { requested.resolve(); await release.promise; return { decision: 'allow', requestId: 'synthetic' } })
    t.state.script = [{ kind: 'hook', run: async () => {
      const id = await t.record()
      const permission = t.orchestrator.handlePermission({ sessionId: t.current().sessionId,
        toolCall: { toolCallId: 'late-tool', title: 'bash', kind: 'execute', rawInput: { command: 'true' } },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] }, new AbortController().signal)
      await requested.promise
      expect((await t.stop(id)).status).toBe(200); release.resolve()
      expect(await permission).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    } }]
    try { await t.orchestrator.handleMessage(msg()) } finally { release.resolve() }
    expect(t.registry.taskForMessage('origin')?.stopReason).toBe('feedback_control')
  })

  it('rejects an already-dispatched GitHub write whose attribution lookup returns after control', async () => {
    const requested = deferred(), release = deferred(), apiCall = vi.fn()
    let responseStatus = 0
    const github = { mode: 'app', repoAllowed: () => true, repoWritable: () => true, defaultRepo: () => 'synthetic/repo', api: apiCall } as unknown as GitHubIdentity
    const t = await setup({ github })
    // The real API/comment operation uses this gateway DB; no network or GitHub mutation is performed.
    t.state.script = [{ kind: 'hook', run: async () => {
      const id = await t.record()
      vi.spyOn(t.feishu, 'userName').mockImplementationOnce(async () => { requested.resolve(); await release.promise; return 'Alice' })
      const pending = t.post('github/issue/comment', { repo: 'synthetic/repo', number: 7, body: 'approved earlier' })
      await requested.promise; expect((await t.stop(id)).status).toBe(200); release.resolve()
      responseStatus = (await pending).status
    } }]
    try { await t.orchestrator.handleMessage(msg()) } finally { release.resolve() }
    expect(apiCall).not.toHaveBeenCalled()
    expect(responseStatus).toBe(403)
  })

  it('does not overwrite a later explicit stop with done while the control receipt ACK is pending', async () => {
    const t = await setup(), accepted = deferred(), release = deferred()
    const send = t.feishu.replyText.bind(t.feishu)
    vi.spyOn(t.feishu, 'replyText').mockImplementation(async (...args) => {
      const result = await send(...args)
      if (args[1].includes('已停止跟进')) { accepted.resolve(); await release.promise }
      return result
    })
    let id = 0
    t.state.script = [{ kind: 'hook', run: async () => { id = await t.record(); expect((await t.stop(id)).status).toBe(200) } }]
    const original = t.orchestrator.handleMessage(msg())
    try {
      await accepted.promise
      await t.orchestrator.handleMessage(msg('stop-controller', { parentId: 'origin', text: '/stop' }))
    } finally { release.resolve(); await original }
    expect(t.bugs.get(id)?.intakePhase).toBe('cancelled')
    expect(t.registry.taskForMessage('origin')).toMatchObject({ status: 'cancelled', stopReason: 'user_requested' })
    expect(t.feishu.reactionsOn('origin')).not.toContain('DONE')
  })

  it('keeps an accepted question send as a single fact when stop happens before its ACK', async () => {
    const t = await setup(), accepted = deferred(), release = deferred(); let id = 0, remoteId = ''
    const send = t.feishu.replyMarkdown.bind(t.feishu)
    vi.spyOn(t.feishu, 'replyMarkdown').mockImplementation(async (...args) => {
      const result = await send(...args)
      if (args[1] === QUESTION) { remoteId = result.messageId; accepted.resolve(); await release.promise }
      return result
    })
    t.state.script = [{ kind: 'hook', run: async () => { id = await t.record(); await t.ask(id) } }]
    const original = t.orchestrator.handleMessage(msg())
    try {
      await accepted.promise
      t.state.script = [{ kind: 'hook', run: async () => { expect((await t.stop(id)).status).toBe(200) } }]
      await t.orchestrator.handleMessage(msg('control', { threadId: 'control-thread' }))
    } finally { release.resolve(); await original }
    const q = t.questions.list(id, t.space.id)[0]!
    expect(q.resolution).toBe('cancelled'); expect(t.feishu.answers()).toEqual([QUESTION])
    expect(t.registry.db.prepare('SELECT status, remote_id FROM deliveries WHERE delivery_key = ?').get(q.deliveryKey)).toMatchObject({ status: 'sent', remote_id: remoteId })
    const prompts = t.state.allPrompts.length
    await t.orchestrator.handleMessage(msg('late', { parentId: remoteId, text: '新材料', mentions: [] }))
    expect(t.state.allPrompts).toHaveLength(prompts)
  })

  it('makes no question POST when control commits during audience membership lookup', async () => {
    const t = await setup(), waiting = deferred(), release = deferred(); let id = 0, held = false
    const members = t.feishu.chatMemberOpenIds.bind(t.feishu)
    vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementation(async (...args) => {
      if (id && !held && t.questions.list(id, t.space.id).length) { held = true; waiting.resolve(); await release.promise }
      return members(...args)
    })
    t.state.script = [{ kind: 'hook', run: async () => { id = await t.record(); await t.ask(id) } }]
    const original = t.orchestrator.handleMessage(msg())
    try {
      await waiting.promise
      t.state.script = [{ kind: 'hook', run: async () => { expect((await t.stop(id)).status).toBe(200) } }]
      await t.orchestrator.handleMessage(msg('control', { threadId: 'control-thread' }))
    } finally { release.resolve(); await original }
    expect(t.questions.list(id, t.space.id)).toMatchObject([{ resolution: 'cancelled' }])
    expect(t.feishu.answers()).toEqual([])
    expect(t.registry.taskForMessage('origin')?.status).toBe('cancelled')
  })

  it('does not start a queued reply after control commits during its final membership lookup', async () => {
    const t = await setup(), waiting = deferred(), release = deferred(); let id = 0, q!: AskBugQuestionReceipt, held = false
    t.state.script = [{ kind: 'hook', run: async () => { id = await t.record(); q = (await t.ask(id)).body } }]
    await t.orchestrator.handleMessage(msg())
    const members = t.feishu.chatMemberOpenIds.bind(t.feishu)
    vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementation(async (...args) => {
      if (!held && t.registry.taskForMessage('reply')?.status === 'queued') { held = true; waiting.resolve(); await release.promise }
      return members(...args)
    })
    t.state.script = [{ kind: 'text', text: '不能执行迟到资料' }]
    const continuation = t.orchestrator.handleMessage(msg('reply', { parentId: q.message_id!, text: '找到材料了', mentions: [] }))
    try {
      await waiting.promise
      t.state.script = [{ kind: 'hook', run: async () => { expect((await t.stop(id)).status).toBe(200) } }]
      await t.orchestrator.handleMessage(msg('control', { threadId: 'control-thread' }))
    } finally { release.resolve(); await continuation }
    expect(t.registry.taskForMessage('reply')?.status).toBe('cancelled')
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.feishu.answers()).toEqual([QUESTION])
  })

  it('does not treat the multi-case controller as a shared target execution', async () => {
    const t = await setup(), other = t.bugs.record({ spaceId: t.space.id, chatId: 'chat', title: '另一案', text: '另一个请求' }).bucket
    let id = 0, result: FeedbackStopReceipt | undefined
    t.state.script = [{ kind: 'hook', run: async () => { id = await t.record(); await t.ask(other.id); result = (await t.stop(id)).body } }]
    await t.orchestrator.handleMessage(msg())
    expect(result).toMatchObject({ applied: true, feedback_id: id })
    expect(t.state.cancelled).toEqual([])
    expect(t.bugs.get(id)?.intakePhase).toBe('cancelled')
    expect(t.questions.list(other.id, t.space.id)[0]?.resolution).toBe('open')
    expect(t.feishu.answers()).toEqual([QUESTION]); expect(t.notices()).toHaveLength(1)
  })

  it.each(['stop-first', 'update-first'] as const)('keeps both real results for stop A and update B (%s), with unrelated writes still closed', async order => {
    const t = await setup()
    const b = t.bugs.record({ spaceId: t.space.id, chatId: 'chat', title: '另一条建议', text: '保持独立' }).bucket
    const reminder = t.routines.add({ kind: 'reminder', spaceId: t.space.id, chatId: 'chat', chatType: 'group', ownerOpenId: 'alice',
      name: '独立提醒', prompt: '检查演示稿', schedule: { type: 'once', atMs: Date.now() + 100_000 } })
    t.orchestrator.controlRoutine(reminder.id, 'pause')
    const before = t.routines.get(reminder.id)!
    let a = 0
    t.state.script = [{ kind: 'hook', run: async () => {
      a = await t.record()
      const update = async () => expect(await t.post('bug/intake', { id: b.id, phase: 'new', note: '优先级低，保留独立需求' }))
        .toMatchObject({ status: 200, body: { applied: true, bucket: { id: b.id, note: '优先级低，保留独立需求' } } })
      if (order === 'update-first') await update()
      expect((await t.stop(a)).status).toBe(200)
      if (order === 'stop-first') await update()
      expect((await t.post('routine/control', { id: reminder.id, action: 'pause' })).status).toBe(200)
      expect((await t.post('bug/context', { id: b.id })).status).toBe(200)
      expect((await t.post('memory/save', { title: '不可开放', body: '不可开放' })).status).toBe(403)
      expect((await t.post('dm/send', { text: '不可开放' })).status).toBe(403)
    } }, { kind: 'text', text: '未经工具支持的额外完成声明' }]
    await t.orchestrator.handleMessage(msg('mixed', { text: '@Friday 停掉 A，B 优先级低，提醒继续暂停' }))
    expect(t.bugs.get(a)?.intakePhase).toBe('cancelled')
    expect(t.bugs.get(b.id)).toMatchObject({ intakePhase: 'new', note: '优先级低，保留独立需求', count: 1 })
    expect(t.routines.get(reminder.id)).toEqual(before)
    expect(t.notices()).toHaveLength(1)
    expect(t.notices()[0]).toContain('「合成反馈」已停止跟进')
    expect(t.notices()[0]).toContain('「另一条建议」已更新备注')
    expect(t.notices()[0]).toContain('「独立提醒」已暂停')
    expect(t.notices()[0]).not.toContain('额外完成声明')
    expect(t.registry.taskForMessage('mixed')?.status).toBe('done')
  })

  it('keeps control receipts per object and invalidates a body awaiting a second control revision', async () => {
    const t = await setup(), received = deferred()
    const b = t.bugs.record({ spaceId: t.space.id, chatId: 'chat', title: 'B', text: 'B' }).bucket
    let a = 0
    t.state.script = [{ kind: 'hook', run: async () => {
      a = await t.record(); expect((await t.stop(a)).status).toBe(200)
      const rev = t.orchestrator.resolveActorForSession(t.current().session.sessionKey)!.controlRevision
      expect((await t.stop(a)).status).toBe(200)
      expect(t.orchestrator.resolveActorForSession(t.current().session.sessionKey)!.controlRevision).toBe(rev)
      const resolveActor = t.orchestrator.resolveActorForSession.bind(t.orchestrator)
      const spy = vi.spyOn(t.orchestrator, 'resolveActorForSession').mockImplementation(key => { received.resolve(); return resolveActor(key) })
      let request!: ReturnType<typeof httpRequest>
      const response = new Promise<number>((resolve, reject) => {
        request = httpRequest(`${t.url}/v1/bug/update`, { method: 'POST', headers: { authorization: `Bearer ${t.current().token}`, 'content-type': 'application/json' } }, r => { r.resume(); r.on('end', () => resolve(r.statusCode!)) })
        request.on('error', reject); request.write('{"id":')
      })
      await received.promise; spy.mockRestore()
      expect((await t.stop(b.id)).status).toBe(200)
      request.end(`${b.id},"title":"不得迟到改写"}`)
      expect(await response).toBe(403)
      expect((await t.stop(a)).body).toMatchObject({ feedback_id: a, applied: true })
    } }]
    await t.orchestrator.handleMessage(msg())
    expect(t.bugs.get(b.id)).toMatchObject({ title: 'B', intakePhase: 'cancelled' })
    expect(t.notices()[0]).toContain('「合成反馈」已停止跟进')
    expect(t.notices()[0]).toContain('「B」已停止跟进')
  })

  it('rejects note-only and invalid multi-field updates without claiming or partially applying changes', async () => {
    const t = await setup()
    t.state.script = [{ kind: 'hook', run: async () => {
      const id = await t.record(), before = t.bugs.get(id)
      expect((await t.post('bug/update', { id, note: '已停止' })).status).toBe(400)
      expect((await t.post('bug/update', { id, title: '不得部分保存', status: 'invented' })).status).toBe(400)
      expect(t.bugs.get(id)).toEqual(before)
      expect(await t.post('bug/update', { id, title: before!.title })).toMatchObject({ status: 200, body: { applied: false, changed: [] } })
    } }, { kind: 'text', text: '没有修改。' }]
    await t.orchestrator.handleMessage(msg())
  })

  it('reports an explicitly inspected reminder as still paused without manufacturing another pause', async () => {
    const t = await setup()
    const r = t.routines.add({ kind: 'reminder', spaceId: t.space.id, chatId: 'chat', chatType: 'group', ownerOpenId: 'alice',
      name: '检查演示文稿', prompt: '检查演示文稿', schedule: { type: 'once', atMs: Date.now() + 100_000 } })
    t.orchestrator.controlRoutine(r.id, 'pause')
    const before = t.routines.get(r.id), pause = vi.spyOn(t.orchestrator, 'controlRoutine')
    t.state.script = [{ kind: 'hook', run: async () => {
      const id = await t.record()
      expect((await t.stop(id)).status).toBe(200)
      expect(await t.post('routine/list', { id: r.id })).toMatchObject({ status: 200, body: { routines: [{ id: r.id, enabled: false }] } })
    } }]
    await t.orchestrator.handleMessage(msg())
    expect(pause).not.toHaveBeenCalled(); expect(t.routines.get(r.id)).toEqual(before)
    expect(t.notices()[0]).toContain('「检查演示文稿」仍暂停')
    expect(t.notices()[0]).not.toContain('「检查演示文稿」已暂停')
  })

  it('reports the actual appended report on B after stopping A without double-counting its original message', async () => {
    const t = await setup()
    const a = t.bugs.record({ spaceId: t.space.id, chatId: 'chat', title: '建议 A', text: 'A' }).bucket
    const b = t.bugs.record({ spaceId: t.space.id, chatId: 'chat', title: '建议 B', text: 'B' }).bucket
    t.state.script = [{ kind: 'hook', run: async () => {
      expect((await t.stop(a.id)).status).toBe(200)
      expect(await t.post('bug/record', { bucket_id: b.id, title: '建议 B', text: 'B 的新情况' }))
        .toMatchObject({ status: 200, body: { bucket: { id: b.id }, duplicate: false } })
      expect(await t.post('bug/record', { bucket_id: b.id, title: '建议 B', text: '重试' })).toMatchObject({ status: 200, body: { duplicate: true } })
    } }]
    await t.orchestrator.handleMessage(msg('mixed-report', { text: '@Friday 停 A，B 的新情况是…' }))
    expect(t.bugs.get(b.id)?.count).toBe(2)
    expect(t.bugs.reports(b.id).filter(r => r.messageId === 'mixed-report')).toHaveLength(1)
    expect(t.notices()[0]).toContain('「建议 B」已有本次记录，未重复登记')
    expect(t.registry.taskForMessage('mixed-report')?.status).toBe('done')
  })

  it('keeps a successful stop but reports a later typed failure as partial, without exposing its error or claiming B changed', async () => {
    const t = await setup()
    const b = t.bugs.record({ spaceId: t.space.id, chatId: 'chat', title: '建议 B', text: '原 B' }).bucket
    t.state.script = [{ kind: 'hook', run: async () => {
      const a = await t.record(); expect((await t.stop(a)).status).toBe(200)
      t.orchestrator.noteRepositoryRead(t.current().session.sessionKey, 'synthetic/private')
      expect((await t.post('bug/intake', { id: b.id, phase: 'new', note: '不得保存的私密来源' })).status).toBe(403)
    } }, { kind: 'text', text: '都完成了，B 已修改' }]
    await t.orchestrator.handleMessage(msg())
    expect(t.bugs.get(b.id)?.note).toBeNull()
    expect(t.notices()).toHaveLength(1)
    expect(t.notices()[0]).toContain('已停止跟进')
    expect(t.notices()[0]).toContain('另有操作未完成')
    expect(t.notices()[0]).not.toMatch(/private|私密|都完成|B 已修改/)
    expect(t.registry.taskForMessage('origin')).toMatchObject({ status: 'failed', stopReason: 'feedback_control_partial' })
    expect(t.feishu.reactionsOn('origin')).not.toContain('DONE')
  })

  it.each([false, true])('keeps the shared-task refusal visible unless that exact stop later succeeds (retry=%s)', async retry => {
    const t = await setup(), running = deferred(), release = deferred()
    const c = t.bugs.record({ spaceId: t.space.id, chatId: 'chat', title: '共享执行里的 C', text: 'C' }).bucket
    let a = 0, b = 0, question!: AskBugQuestionReceipt
    t.state.script = [{ kind: 'hook', run: async () => {
      b = await t.record(); question = (await t.ask(c.id)).body
      running.resolve(); await release.promise
    } }]
    const worker = t.orchestrator.handleMessage(msg('worker-b', { threadId: 'thread-b' }))
    try {
      await running.promise
      t.state.script = [{ kind: 'hook', run: async () => {
        a = await t.record(); expect((await t.stop(a)).status).toBe(200)
        expect(await t.stop(b)).toMatchObject({ status: 200, body: { applied: false, feedback_id: b, reason: 'shared_active_task' } })
        if (retry) {
          release.resolve(); await worker
          expect(await t.stop(b)).toMatchObject({ status: 200, body: { applied: true, feedback_id: b } })
        }
      } }, { kind: 'text', text: '两项都停好了' }]
      await t.orchestrator.handleMessage(msg('controller', { threadId: 'thread-control', text: '@Friday 停 A 和 B' }))
      expect(t.bugs.get(a)?.intakePhase).toBe('cancelled')
      expect(t.bugs.get(b)?.intakePhase).toBe(retry ? 'cancelled' : 'new')
      expect(t.questions.get(question.question_id)?.resolution).toBe('open')
      if (!retry) expect(t.registry.taskForMessage('worker-b')).toMatchObject({ status: 'running', stopReason: null })
      expect(t.registry.taskForMessage('controller')).toMatchObject({ status: retry ? 'done' : 'failed', stopReason: retry ? 'feedback_control' : 'feedback_control_partial' })
      expect(t.notices()).toHaveLength(1)
      expect(t.notices()[0]).toContain('已停止跟进')
      if (retry) expect(t.notices()[0]).not.toContain('另有操作未完成')
      else expect(t.notices()[0]).toContain('另有操作未完成')
      expect(t.notices()[0]).not.toContain('两项都停好了')
      if (!retry) expect(t.feishu.reactionsOn('controller')).not.toContain('DONE')
    } finally { release.resolve(); await worker }
  })

  it.each(['stop-first', 'reply-first'] as const)('processes the current exact reply to B while stopping A (%s)', async order => {
    const t = await setup()
    const a = t.bugs.record({ spaceId: t.space.id, chatId: 'chat', title: '反馈 A', text: 'A' }).bucket
    let b = 0, question!: AskBugQuestionReceipt
    t.state.script = [{ kind: 'hook', run: async () => { b = await t.record(); question = (await t.ask(b)).body } }]
    await t.orchestrator.handleMessage(msg())
    vi.spyOn((t.orchestrator as any).deps.ingressClassifier, 'classify').mockResolvedValueOnce({ kind: 'work_request' })
    t.state.script = [{ kind: 'hook', run: async () => {
      const task = t.registry.taskForMessage('mixed-reply')!, reply = t.questions.forTask(task.id)[0]?.reply
      expect(reply).toMatchObject({ messageId: 'mixed-reply', outcome: 'pending' })
      const applyReply = async () => expect(await t.post('bug/reply', { question_id: question.question_id, reply_id: reply!.id, outcome: 'unavailable' }))
        .toMatchObject({ status: 200, body: { reply: { taskId: task.id, outcome: 'unavailable' } } })
      if (order === 'reply-first') await applyReply()
      expect((await t.stop(a.id)).status).toBe(200)
      if (order === 'stop-first') await applyReply()
      // A successful control never grants access to another Task's historical reply.
      expect((await t.post('bug/reply', { question_id: question.question_id, reply_id: reply!.id + 999, outcome: 'answered' })).status).not.toBe(200)
    } }]
    await t.orchestrator.handleMessage(msg('mixed-reply', { parentId: question.message_id, text: '日志拿不到；反馈 A 先不跟了', mentions: [] }))
    expect(t.questions.replies(question.question_id)).toMatchObject([{ outcome: 'unavailable' }])
    expect(t.bugs.get(b)?.intakePhase).not.toBe('cancelled')
    expect(t.bugs.get(a.id)?.intakePhase).toBe('cancelled')
    expect(t.notices().at(-1)).toContain('「反馈 A」已停止跟进')
    expect(t.notices().at(-1)).toContain('「合成反馈」已记录暂时无法提供')
  })

  it('does not resend an unknown control receipt or claim delivery succeeded', async () => {
    const t = await setup(), send = t.feishu.replyText.bind(t.feishu); let id = 0
    vi.spyOn(t.feishu, 'replyText').mockImplementation(async (...args) => { await send(...args); throw new Error('synthetic lost ACK') })
    t.state.script = [{ kind: 'hook', run: async () => { id = await t.record(); await t.stop(id) } }]
    await t.orchestrator.handleMessage(msg())
    expect(t.bugs.get(id)?.intakePhase).toBe('cancelled')
    expect(t.notices()).toHaveLength(1)
    expect(t.registry.taskForMessage('origin')?.status).toBe('failed')
    expect(t.feishu.reactionsOn('origin')).not.toContain('DONE')
    expect(t.registry.db.prepare("SELECT status FROM deliveries WHERE delivery_key LIKE 'task:%:notice'").all()).toEqual([{ status: 'unknown' }])
    expect(t.memory.recent(`space:${t.space.id}`)).toEqual([])
  })
})
