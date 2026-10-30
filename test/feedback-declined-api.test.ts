import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { Bugs, type BugBucket, type BugEvidenceRef } from '../src/core/bugs.js'
import { BugQuestions, type BugQuestion, type BugQuestionReply } from '../src/core/bug-questions.js'
import { FeedbackControl } from '../src/core/feedback-control.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import type { AskBugQuestionReceipt } from '../src/core/question-types.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createInternalApi } from '../src/internal/api.js'
import { IssueLinks } from '../src/github/issues.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { buildServer } from '../src/mcp/server.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const STEPS = '点按钮之前最后一步做了什么？'
const LOG_ASK = '能把出问题的会话日志导出来发我吗？'
const REFUSAL = '这项你之前说过不方便给，我不再要了'
type Context = { bucket: BugBucket; questions: (BugQuestion & { replies: BugQuestionReply[] })[] }
function msg(id = 'origin', patch: Partial<InboundMessage> = {}): InboundMessage {
  return { eventId: `ev_${id}`, messageId: id, chatId: 'chat', chatType: 'group', tenantId: 'tenant-synthetic', threadId: 'thread', msgType: 'text',
    text: '@Friday 这个按钮点了没反应，帮我记个反馈；日志我导不出来', senderOpenId: 'alice', senderType: 'user',
    mentions: [{ key: '@Friday', openId: 'bot', name: 'Friday' }], createTimeMs: Date.now(), ...patch }
}

/** Real HTTP -> MCP tool -> host -> SQLite/Delivery/ACP, wired like src/index.ts; model, classifier and Feishu transport are substitutes. */
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'feedback-declined-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)
  const registry = new Registry(join(home, 'friday.db')), bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs), routines = new RoutineStore(registry.db)
  const feedback = new FeedbackControl(registry, bugs, questions, routines), memory = new ChannelMemory(registry.db), messageCache = new MessageCache(registry.db)
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'chat', openId: 'alice' })
  const feishu = new FakeFeishu(); feishu.members.set('chat', new Set(['alice', 'bob']))
  const log = createLogger('feedback-declined-test', 'error'), messages = new MessageService(asFeishuClient(feishu), messageCache, log), tokens = new TokenIssuer('synthetic')
  const { app, state } = createFakeAgent({ script: [] })
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  // Fixed decisions, no keyword matching: explicit replies amend their target, everything else is new work.
  orchestrator = new Orchestrator({ cfg, registry, feedback, memory, messages, questions, routines, ...sp, feishu: asFeishuClient(feishu), runtime,
    ingressClassifier: { classify: async (input) => input.message.replyToRef ? { kind: 'amend', targetRef: input.message.replyToRef } : { kind: 'new_work' } }, tokens, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/synthetic', botOpenId: 'bot', log })
  const api = createInternalApi({ registry, feedback, bugs, questions, routines, memory, messageCache, messages, issueLinks: new IssueLinks(registry.db), todos: new Todos(registry.db), ...sp,
    feishu: asFeishuClient(feishu), tokens, log, maxHistoryPerCall: 50, appId: cfg.feishu.appId,
    resolveActorForSession: key => orchestrator.resolveActorForSession(key), allowedRoutesForSession: key => orchestrator.allowedRoutesForSession(key),
    canPersistDerivedState: key => orchestrator.canPersistDerivedState(key), stopFeedback: (key, runId, id, manage) => orchestrator.stopFeedback(key, runId, id, manage),
    canPersistFeedbackState: (key, runId, id) => orchestrator.canPersistFeedbackState(key, runId, id),
    recordDomainOperation: (key, runId, receipt) => orchestrator.recordDomainOperation(key, runId, receipt),
    resolveBugQuestionReply: (key, runId, input) => orchestrator.resolveBugQuestionReply(key, runId, input),
    askBugQuestion: (key, runId, input) => orchestrator.askBugQuestion(key, runId, input), deliverToolResult: (key, runId, input) => orchestrator.deliverToolResult(key, runId, input) })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const token = () => {
    const sessionId = state.allPrompts.at(-1)!.sessionId
    const servers = state.sessions.get(sessionId)!.mcpServers as { env: { name: string; value: string }[] }[]
    return servers[0]!.env.find(entry => entry.name === 'FRIDAY_CAP_TOKEN')!.value
  }
  const post = async <T = Record<string, unknown>>(route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${url}/v1/${route}`, { method: 'POST', headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as T & { error?: string } }
  }
  /** The model-facing MCP tool, bound to the current Run's capability token exactly as the worker receives it. */
  const tool = async (name: string, args: Record<string, unknown>) => {
    const server = buildServer({ apiUrl: url, token: token() })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'declined-test', version: '0.0.0' })
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({ name, arguments: args }) as { content: { type: string; text: string }[]; isError?: boolean }
      return { isError: result.isError === true, text: result.content.map(item => item.text).join('\n') }
    } finally { await client.close() }
  }
  cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())); await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  return { registry, bugs, questions, feishu, state, space, orchestrator, post, tool }
}

describe('materials the user said they will not provide, through the real host', () => {
  it('follows the four acceptance steps: stated refusal, one non-log question, a declined reply, a later upload still read', async () => {
    const t = await setup()
    let bucketId = 0
    // ① The report and the stated limit are recorded together from the original words.
    t.state.script = [{ kind: 'hook', run: async () => {
      const recorded = await t.tool('friday_bug_record', { title: '按钮点击无响应', text: '这个按钮点了没反应，帮我记个反馈；日志我导不出来', declined_info: ['session_log'] })
      expect(recorded.isError).toBe(false)
      expect(recorded.text).toContain('会话日志')
      bucketId = Number(/\[bug:(\d+)\]/.exec(recorded.text)?.[1])
    } }, { kind: 'text', text: '已记下，不需要你导出日志。' }]
    await t.orchestrator.handleMessage(msg())
    expect(t.bugs.get(bucketId)).toMatchObject({ count: 1, declinedInfo: [{ kind: 'session_log', source: 'statement', messageId: 'origin', at: expect.any(Number) }] })

    // ② “还需要什么信息？”: the host facts carry the record, a log question is refused, one other question is sent.
    let steps!: AskBugQuestionReceipt
    t.state.script = [{ kind: 'hook', run: async () => {
      expect(t.state.allPrompts.at(-1)!.text).toContain('"declined_info":["session_log"]')
      const context = await t.post<Context>('bug/context', { id: bucketId })
      expect(context.body.bucket.declinedInfo).toMatchObject([{ kind: 'session_log', source: 'statement' }])
      const unclassified = await t.post('bug/ask', { id: bucketId, kind: 'info', question: '还有别的材料吗？' })
      expect(unclassified.status).toBe(400)
      expect(unclassified.body.error).toContain('info_kind')
      const refused = await t.post('bug/ask', { id: bucketId, kind: 'info', info_kind: 'session_log', question: LOG_ASK })
      expect(refused.status).toBe(409)
      expect(refused.body.error).toContain('declined_before')
      expect(refused.body.error).toContain(REFUSAL)
      expect(await t.tool('friday_bug_ask', { id: bucketId, info_kind: 'session_log', question: LOG_ASK })).toEqual({ isError: true, text: expect.stringContaining(REFUSAL) })
      expect(t.questions.budget(bucketId).occupied).toBe(0)
      const sent = await t.tool('friday_bug_ask', { id: bucketId, info_kind: 'repro_steps', question: STEPS })
      expect(sent.isError).toBe(false)
      steps = JSON.parse(sent.text) as AskBugQuestionReceipt
    } }]
    // A follow-up in the same thread continues the recorded Work (the fixed classifier amends the replied-to request).
    await t.orchestrator.handleMessage(msg('more-info', { parentId: 'origin', text: '@Friday 还需要什么信息？' }))
    expect(steps).toMatchObject({ delivery_status: 'sent', question: STEPS, budget: { occupied: 1, max: 3 } })
    expect(t.feishu.answers()).toEqual(['已记下，不需要你导出日志。', STEPS])
    expect(t.questions.list(bucketId, t.space.id)).toMatchObject([{ id: steps.question_id, infoKind: 'repro_steps', question: STEPS }])

    // ③ Reply “这个不方便给” to that question: the outcome is declined and the case refuses the same kind afterwards.
    t.state.script = [{ kind: 'hook', run: async () => {
      const context = await t.post<Context>('bug/context', { id: bucketId })
      const question = context.body.questions[0]!, reply = question.replies.at(-1)!
      expect(await t.tool('friday_bug_reply', { question_id: question.id, reply_id: reply.id, outcome: 'declined' })).toMatchObject({ isError: false })
      const again = await t.post('bug/ask', { id: bucketId, kind: 'info', info_kind: 'repro_steps', question: '能再描述一下操作步骤吗？' })
      expect(again.status).toBe(409)
      expect(again.body.error).toContain(REFUSAL)
      const intake = await t.post<{ bucket: BugBucket; note: string }>('bug/intake', { id: bucketId, phase: 'awaiting_info', missing_info: ['版本'] })
      expect(intake.status).toBe(200)
      expect(intake.body.note).toContain('会话日志')
      expect(intake.body.note).toContain('复现步骤')
    } }, { kind: 'text', text: '好的，这项不再要了。' }]
    await t.orchestrator.handleMessage(msg('declined-reply', { parentId: steps.message_id, text: '这个不方便给', mentions: [] }))
    expect(t.registry.db.prepare('SELECT outcome FROM bug_question_replies WHERE message_id = ?').get('declined-reply')).toEqual({ outcome: 'declined' })
    const declined = t.bugs.get(bucketId)!.declinedInfo
    expect(declined).toEqual([
      { kind: 'session_log', source: 'statement', messageId: 'origin', at: expect.any(Number) },
      { kind: 'repro_steps', source: 'reply', questionId: steps.question_id, outcome: 'declined', messageId: 'declined-reply', at: expect.any(Number) },
    ])
    expect(t.feishu.answers()).toEqual(['已记下，不需要你导出日志。', STEPS, '好的，这项不再要了。'])

    // ④ The user later uploads the log anyway: it is downloaded and can be linked to the case as usual.
    const upload = msg('log-upload', { parentId: steps.message_id, msgType: 'file', fileKey: 'fk_log', fileName: 'session.log', text: '[文件] session.log', mentions: [] })
    t.feishu.messages.set('log-upload', historyMsg({ messageId: 'log-upload', chatId: 'chat', tenantId: 'tenant-synthetic', senderOpenId: 'alice', msgType: 'file',
      fileKey: 'fk_log', fileName: 'session.log', text: '[文件] session.log', threadId: 'thread', parentId: steps.message_id }))
    let evidence: { status: number; body: { evidence: BugEvidenceRef } } | undefined
    t.state.script = [{ kind: 'hook', run: async () => {
      expect(t.state.allPrompts.at(-1)!.text).toContain('附件已下载')
      evidence = await t.post<{ evidence: BugEvidenceRef }>('bug/evidence', { id: bucketId, message_id: 'log-upload' })
    } }, { kind: 'text', text: '收到日志，我看一下。' }]
    await t.orchestrator.handleMessage(upload)
    expect(t.feishu.downloads).toMatchObject([{ messageId: 'log-upload', fileKey: 'fk_log', type: 'file' }])
    expect(evidence).toMatchObject({ status: 200, body: { evidence: { kind: 'user_export' } } })
    expect(t.questions.replies(steps.question_id)).toMatchObject([{ messageId: 'declined-reply', outcome: 'declined' }, { messageId: 'log-upload', outcome: 'pending' }])
    expect(t.bugs.get(bucketId)!.declinedInfo).toEqual(declined)
    expect(t.feishu.answers().at(-1)).toBe('收到日志，我看一下。')
  })

  it('validates the structured fields, adds statements through intake and keeps a stopped case closed to new limits', async () => {
    const t = await setup()
    let bucketId = 0
    t.state.script = [{ kind: 'hook', run: async () => {
      for (const declined_info of ['session_log', ['logs'], ['other'], [1], ['session_log', 'screenshot', 'repro_steps', 'version', 'session_log']]) {
        expect((await t.post('bug/record', { title: '合成反馈', text: '截图不方便', declined_info })).status, JSON.stringify(declined_info)).toBe(400)
      }
      expect(t.bugs.list(t.space.id)).toEqual([])
      const recorded = await t.post<{ bucket: BugBucket }>('bug/record', { title: '合成反馈', text: '刷新后恢复' })
      expect(recorded.body.bucket.declinedInfo).toEqual([])
      bucketId = recorded.body.bucket.id
      expect((await t.post('bug/ask', { id: bucketId, kind: 'info', info_kind: 'logs', question: '日志？' })).status).toBe(400)
      expect((await t.post('bug/intake', { id: bucketId, phase: 'awaiting_info', missing_info: ['版本'], declined_info: ['日志'] })).status).toBe(400)
      expect((await t.post('bug/intake', { id: bucketId, phase: 'cancelled', declined_info: ['screenshot'] })).status).toBe(400)
      expect(t.bugs.get(bucketId)).toMatchObject({ intakePhase: 'new', declinedInfo: [] })
      const intake = await t.post<{ bucket: BugBucket; changed: string[]; applied: boolean; note: string }>('bug/intake', { id: bucketId, phase: 'new', declined_info: ['screenshot', 'version'] })
      expect(intake.status).toBe(200)
      expect(intake.body).toMatchObject({ changed: ['declinedInfo'], applied: true })
      expect(intake.body.bucket.declinedInfo).toEqual([
        { kind: 'screenshot', source: 'statement', at: expect.any(Number) },
        { kind: 'version', source: 'statement', at: expect.any(Number) },
      ])
      expect(intake.body.note).toContain('截图')
      const repeated = await t.post<{ changed: string[]; applied: boolean }>('bug/intake', { id: bucketId, phase: 'new', declined_info: ['version'] })
      expect(repeated.body).toMatchObject({ changed: [], applied: false })
    } }, { kind: 'text', text: '已记录。' }]
    await t.orchestrator.handleMessage(msg('validation', { text: '@Friday 帮我记个反馈' }))
    t.state.script = [{ kind: 'hook', run: async () => { expect((await t.post('bug/control', { id: bucketId, action: 'stop' })).status).toBe(200) } }]
    await t.orchestrator.handleMessage(msg('stop', { threadId: 'stop-thread', text: '@Friday 这条反馈别再跟了' }))
    const stopped = t.bugs.get(bucketId)
    expect(stopped).toMatchObject({ intakePhase: 'cancelled' })
    t.state.script = [{ kind: 'hook', run: async () => {
      expect((await t.post('bug/record', { bucket_id: bucketId, declined_info: ['session_log'] })).status).toBe(409)
      // Without the field the stopped case still keeps the user's own words.
      expect((await t.post('bug/record', { bucket_id: bucketId })).status).toBe(200)
    } }, { kind: 'text', text: '补充已记录，仍停止跟进。' }]
    await t.orchestrator.handleMessage(msg('stopped-note', { threadId: 'note-thread', text: '@Friday 补充：日志也不方便给' }))
    expect(t.bugs.get(bucketId)).toEqual(stopped)
    expect(t.bugs.reports(bucketId).find(report => report.messageId === 'stopped-note')).toMatchObject({ recordKind: 'user_note' })
  })

  it('describes the fields and the refusal on the model-facing tools', async () => {
    const server = buildServer({ apiUrl: 'http://127.0.0.1:1', token: 'synthetic' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'declined-schema', version: '0.0.0' })
    await client.connect(clientTransport)
    try {
      const tools = (await client.listTools()).tools
      const find = (name: string) => tools.find(item => item.name === name)!
      const properties = (name: string) => find(name).inputSchema.properties as Record<string, { enum?: string[]; items?: { enum?: string[] } }>
      expect(properties('friday_bug_ask').info_kind?.enum).toEqual(['session_log', 'screenshot', 'repro_steps', 'version', 'other'])
      for (const name of ['friday_bug_record', 'friday_bug_intake']) expect(properties(name).declined_info?.items?.enum).toEqual(['session_log', 'screenshot', 'repro_steps', 'version'])
      expect(find('friday_bug_ask').description).toContain(REFUSAL)
      expect(find('friday_bug_context').description).toContain('declinedInfo')
      expect(find('friday_bug_reply').description).toContain('info_kind')
    } finally { await client.close() }
  })
})
