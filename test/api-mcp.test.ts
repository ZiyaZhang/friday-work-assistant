import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { TokenIssuer, ALL_SCOPES, GROUP_SCOPES } from '../src/internal/tokens.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { RoutineStore } from '../src/core/routines.js'
import { UserTokenStore, USER_SCOPE_TIERS } from '../src/feishu/oauth.js'
import { Inbox } from '../src/core/inbox.js'
import { RoutineApplication } from '../src/core/routine-application.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { chatScope, spaceDeps } from './helpers/space.js'
import { createLogger } from '../src/log.js'
import { buildServer } from '../src/mcp/server.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'
import { FakeBitable, asBitable } from './helpers/fake-bitable.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'

const log = createLogger('test', 'error')

const TOOL_NAMES = [
  'github_search_change_files', 'github_wait_change',
  'github_pr_checks', 'github_pr_followup', 'github_issue_followup', 'github_pr_check_evidence',
  'github_assess_issue', 'github_get_assessment', 'github_execute_assessment',
  'github_run_change_check', 'github_read_change_check', 'github_stop_change_check', 'github_apply_change_check_output',
  'github_list_change_files', 'github_read_change_file', 'github_read_change_files', 'github_write_change_file', 'github_edit_change_file',
  'friday_list_zip_members', 'friday_extract_zip_members', 'friday_pack_files',
  'friday_list_files', 'friday_read_file', 'friday_search_files', 'friday_write_file', 'friday_edit_file', 'friday_send_material',
  'friday_join_meeting', 'friday_leave_meeting', 'friday_list_meetings', 'friday_read_meeting', 'friday_sync_meeting', 'friday_propose_meeting_draft',
  'friday_create_poll', 'friday_list_polls', 'friday_read_poll', 'friday_close_poll',
  'friday_project_repositories',
  'friday_project_view',
  'feishu_read_thread',
  'feishu_list_chats',
  'feishu_read_chat_history',
  'feishu_search_messages',
  'feishu_find_files',
  'feishu_get_message_file',
  'feishu_my_calendar',
  'feishu_my_minutes',
  'feishu_read_minute',
  'feishu_minute_todos',
  'feishu_propose_minute_todos',
  'feishu_create_document',
  'feishu_create_table',
  'feishu_read_document',
  'feishu_send_dm',
  'web_fetch',
  'friday_memory_search',
  'friday_memory_save',
  'friday_memory_forget',
  'friday_todo_add',
  'friday_todo_list',
  'friday_todo_done',
  'friday_todo_update',
  'friday_todo_native_resolve', 'friday_todo_native_reconcile', 'friday_todo_native_abandon_create',
  'friday_my_day',
  'github_pr_diff',
  'github_open_issue',
  'github_comment_issue',
  'friday_work_status',
  'friday_wiki',
  'friday_handover',
  'friday_explain_context',
  'friday_space_settings',
  'friday_proactive',
  'friday_connect_account',
  'friday_visible_groups',
  'friday_watch_issues',
  'friday_self_check',
  'friday_pmo_board',
  'friday_responsibility_propose',
  'friday_routine_add',
  'friday_watch_add',
  'friday_schedule_followup',
  'friday_routine_list',
  'friday_routine_remove',
  'friday_routine_control',
  'friday_routine_update',
  'friday_bug_record',
  'friday_bug_similar',
  'friday_bug_list',
  'friday_bug_update',
  'friday_bug_ask',
  'friday_bug_reply',
  'friday_bug_link_issue',
  'friday_bug_context',
  'friday_bug_intake',
  'friday_bug_control',
  'friday_bug_evidence',
  'friday_needs_decision',
  'friday_decision_list',
  'friday_decision_resolve',
  'friday_github_login',
  'friday_whois',
  'feishu_send_file',
  'friday_propose_skill', 'friday_list_skills', 'friday_load_skill', 'friday_disable_skill',
  'github_list_issues',
  'github_get_issue',
  'github_releases',
  'github_start_change',
  'github_open_pr',
  'github_list_changes',
  'github_pr_ready',
  'github_pr_state',
  'github_update_pr',
]

describe('internal API + friday-lark-mcp', () => {
  const registry = new Registry(':memory:')
  const memory = new ChannelMemory(registry.db)
  const memoryHost = memoryRuntimeFixture(registry, memory)
  const messageCache = new MessageCache(registry.db)
  const todos = new Todos(registry.db)
  const { circles, spaces, policy } = spaceDeps(registry.db, { admins: ['ou_admin'] })
  const feishu = new FakeFeishu()
  const messages = new MessageService(asFeishuClient(feishu), messageCache, log, { windowSec: 3600 })
  const tokens = new TokenIssuer('secret')
  const routines = new RoutineStore(registry.db)
  const userTokens = new UserTokenStore(registry.db, feishu)
  const inbox = new Inbox(registry.db)
  // 职责修改只走 RoutineApplication（生产里由宿主持有同一个实例）
  const routineApplication = new RoutineApplication({ registry, spaces, routines, inbox, policy, attempts: new RunAttempts(registry.db), activeRuns: () => [], now: () => Date.now() })
  const bugs = new Bugs(registry.db)
  const questions = new BugQuestions(registry.db, bugs)
  // API/MCP 夹具只验宿主委托协议；真实账本与发送分别在 tool-delivery/宿主集成测试覆盖。
  const hostDelivery = vi.fn<NonNullable<InternalApiDeps['deliverToolResult']>>(async () => ({ messageId: 'host-delivery-receipt' }))
  const hostQuestion = vi.fn<NonNullable<InternalApiDeps['askBugQuestion']>>(async (_key, _run, input) => ({ question_id: 7, question: input.question, resolution: 'open', delivery_status: 'sent', message_id: 'host-question-receipt', budget: { occupied: 1, max: 3 }, next: 'continue_independent_work' }))
  const hostReply = vi.fn<NonNullable<InternalApiDeps['resolveBugQuestionReply']>>(async (_key, _run, input) => ({ question: questions.get(input.questionId)!, reply: { id: input.replyId, questionId: input.questionId, messageId: 'host-bound-reply', senderOpenId: 'ou_alice', taskId: 123, outcome: input.outcome, createdAt: 1, resolvedAt: 2 } }))
  const bitable = new FakeBitable()
  const api = createInternalApi({ version: 'a'.repeat(40), feishu: asFeishuClient(feishu), bitable: asBitable(bitable), memory, memoryRuntime: memoryHost.runtime, registry, messages, messageCache, todos, routines, inbox, bugs, questions, circles, spaces, policy, tokens, log, maxHistoryPerCall: 3,
    userTokens, onExternalSourceRead: vi.fn(),
    resolveActorForSession: (sessionKey) => {
      const session = registry.getSession(sessionKey)
      return session ? { requesterOpenId: session.requesterOpenId ?? undefined, runId: `run:${sessionKey}`, stage: 'task' } : undefined
    },
    deliverToolResult: hostDelivery,
    askBugQuestion: hostQuestion,
    resolveBugQuestionReply: hostReply,
    // 此夹具只验 MCP/API 映射；真实在途取消另由 followup-cancellation 集成测试覆盖。
    stopRoutine: (id, mode) => { if (mode === 'pause') routines.setEnabled(id, false); else routines.remove(id) },
    updateRoutine: (id, patch, options) => routineApplication.update(id, patch, options) })
  const workDir = mkdtempSync(join(tmpdir(), 'friday-test-'))
  let baseUrl = ''
  let groupToken = ''
  let dmToken = ''
  let client: Client
  let dmClient: Client
  const now = Date.now()

  beforeAll(async () => {
    registry.createSession({ sessionKey: 'msg:om_root', chatId: 'oc_1', chatType: 'group', cwd: workDir, requesterOpenId: 'ou_alice', rootMessageId: 'om_root', threadId: 'omt_1' })
    registry.createSession({ sessionKey: 'dm:ou_alice', chatId: 'oc_dm', chatType: 'p2p', cwd: workDir, requesterOpenId: 'ou_alice' })
    memoryHost.pin({ runId: 'run:msg:om_root', sessionKey: 'msg:om_root', actorOpenId: 'ou_alice' })
    memoryHost.pin({ runId: 'run:dm:ou_alice', sessionKey: 'dm:ou_alice', actorOpenId: 'ou_alice' })
    const groupSpace = spaces.ensure({ kind: 'group', chatId: 'oc_1', openId: 'ou_alice' })
    const dmSpace = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
    feishu.threads.set('omt_1', [historyMsg({ text: '话题第一条', senderName: 'A' }), historyMsg({ text: '话题第二条', senderName: 'B' })])
    feishu.chats = [
      { chatId: 'oc_1', name: 'alpine 讨论群' },
      { chatId: 'oc_2', name: '数仓对接群' },
      { chatId: 'oc_secret', name: '管理层群' },
    ]
    feishu.members.set('oc_1', new Set(['ou_alice', 'ou_bob']))
    feishu.members.set('oc_2', new Set(['ou_alice', 'ou_carol']))
    feishu.members.set('oc_secret', new Set(['ou_boss']))
    feishu.histories.set('oc_1', [
      ...[1, 2, 3, 4, 5].map((i) => historyMsg({ messageId: `om_g1_${i}`, text: `群消息 ${i}${i === 3 ? ' 关键词' : ''}`, senderName: i % 2 ? '陆知行' : '李雷', createTimeMs: now - i * 3600_000 })),
      historyMsg({ messageId: 'om_file_1', msgType: 'file', text: '[文件] SKILL.md', fileKey: 'fk_1', fileName: 'SKILL.md', senderName: '陆知行', createTimeMs: now - 2 * 3600_000 - 60_000 }),
      historyMsg({ messageId: 'om_img_1', msgType: 'image', text: '[图片]', imageKey: 'ik_1', senderName: '李雷', createTimeMs: now - 5 * 3600_000 - 60_000 }),
    ])
    feishu.histories.set('oc_2', [historyMsg({ messageId: 'om_g2_1', text: '月度报表 8/11 排期 3 天', senderName: '陆知行', createTimeMs: now - 3600_000 })])
    feishu.histories.set('oc_secret', [historyMsg({ messageId: 'om_s_1', text: '年终奖方案', senderName: '老板', createTimeMs: now - 3600_000 })])
    feishu.docs.set('DocTok', { title: '需求文档', content: '正文内容', objType: 'docx' })
    await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', () => resolve()))
    baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
    groupToken = tokens.issue({ runId: 'run:msg:om_root', sessionKey: 'msg:om_root', chatId: 'oc_1', chatType: 'group', spaceId: groupSpace.id, requesterOpenId: 'ou_alice', cwd: workDir, scopes: [...GROUP_SCOPES] })
    dmToken = tokens.issue({ runId: 'run:dm:ou_alice', sessionKey: 'dm:ou_alice', chatId: 'oc_dm', chatType: 'p2p', spaceId: dmSpace.id, requesterOpenId: 'ou_alice', cwd: workDir, scopes: [...ALL_SCOPES] })

    client = await connect(groupToken)
    dmClient = await connect(dmToken)
  })

  afterAll(async () => {
    await client.close()
    await dmClient.close()
    api.server.close()
    registry.close()
    rmSync(workDir, { recursive: true, force: true })
  })

  async function connect(token: string): Promise<Client> {
    const server = buildServer({ apiUrl: baseUrl, token })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const c = new Client({ name: 'test-client', version: '0.0.0' })
    await c.connect(clientTransport)
    return c
  }

  async function callTool(name: string, args: Record<string, unknown> = {}, c: Client = client): Promise<string> {
    const res = (await c.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean }
    return res.content.map((x) => x.text).join('\n')
  }

  it('expands an explicitly selected readable group thread from DM and retains cached card text', async () => {
    feishu.threads.set('omt_g2_context', [historyMsg({ messageId: 'om_g2_card', chatId: 'oc_2', threadId: 'omt_g2_context', msgType: 'interactive', text: '[卡片]' })])
    messageCache.upsert('oc_2', [historyMsg({ messageId: 'om_g2_card', chatId: 'oc_2', threadId: 'omt_g2_context', msgType: 'interactive', text: '此前 Friday 已确认修复' })])
    const out = await callTool('feishu_read_thread', { chat: 'oc_2', thread_id: 'omt_g2_context' }, dmClient)
    expect(out).toContain('此前 Friday 已确认修复')
    // 卡片正文只代表发出时的样子：提示状态可能已变、以查询工具为准
    expect(out).toContain('按钮和状态之后可能已变')
    expect(out).toContain('om_g2_card')
    expect(out).toContain('omt_g2_context')
  })

  it('rejects forbidden, mismatched and unverifiable thread ids without caching them', async () => {
    feishu.threads.set('omt_secret', [historyMsg({ messageId: 'om_hidden_thread', chatId: 'oc_secret', text: '私密话题内容' })])
    for (const [c, chat] of [[client, 'oc_secret'], [dmClient, 'oc_secret'], [dmClient, 'oc_2']] as const) {
      const out = await callTool('feishu_read_thread', { chat, thread_id: 'omt_secret' }, c)
      expect(out).toContain('工具调用失败')
      expect(out).not.toContain('私密话题内容')
    }
    feishu.threads.set('omt_unverified', [historyMsg({ messageId: 'om_unverified', text: '未经验证的消息' })])
    const unverified = await callTool('feishu_read_thread', { chat: 'oc_2', thread_id: 'omt_unverified' }, dmClient)
    expect(unverified).toContain('无法验证话题归属')
    expect(messageCache.get('om_hidden_thread')).toBeUndefined()
    expect(messageCache.get('om_unverified')).toBeUndefined()
  })

  it('marks a long thread as incomplete and rejects a thread id without its chat', async () => {
    feishu.threads.set('omt_g2_long', Array.from({ length: 5 }, (_, i) => historyMsg({ messageId: `om_g2_long_${i}`, chatId: 'oc_2', text: `长话题 ${i}` })))
    const out = await callTool('feishu_read_thread', { chat: 'oc_2', thread_id: 'omt_g2_long', limit: 2 }, dmClient)
    expect(out).toContain('截断')
    expect(out).not.toContain('长话题 2')
    const invalid = await callTool('feishu_read_thread', { thread_id: 'omt_g2_long' }, dmClient)
    expect(invalid).toContain('chat')
  })

  it('lists all tools', async () => {
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
  })

  it('exposes the issue assessment tools including execute; without GitHub or a wired runtime every call fails before any evaluation or handoff', async () => {
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['github_assess_issue', 'github_get_assessment', 'github_execute_assessment']))
    // The execute route now exists (P3-3b); this fixture has no GitHub, so it is refused before any runtime work instead of 404.
    const res = await fetch(`${baseUrl}/v1/github/assessment/execute`, { method: 'POST', headers: { authorization: `Bearer ${groupToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ assessmentId: 'x' }) })
    expect(res.status).toBe(501)
    // This fixture wires GitHub-less deps and no runtime: the tools fail before any evaluation and never invent a record or a Task.
    for (const [name, args] of [['github_assess_issue', { number: 7 }], ['github_execute_assessment', { assessmentId: 'x' }]] as const) {
      const out = await callTool(name, args)
      expect(out).toContain('工具调用失败')
      expect(out).toMatch(/github|接单评估/i)
    }
    expect(registry.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='work_assessments'").get()?.n).toBe(0)
  })

  it('lists poll tools only for host-issued poll scopes; an API built without the deployment switch has no poll route', async () => {
    const pollTools = ['friday_close_poll', 'friday_create_poll', 'friday_list_polls', 'friday_read_poll']
    const withoutPolls = tokens.issue({ runId: 'run:msg:om_root', sessionKey: 'msg:om_root', chatId: 'oc_1', chatType: 'group', spaceId: spaces.byChat('oc_1')!.id,
      requesterOpenId: 'ou_alice', cwd: workDir, scopes: GROUP_SCOPES.filter((scope) => !scope.startsWith('polls:')) })
    const limited = await connect(withoutPolls)
    try { expect((await limited.listTools()).tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES.filter((name) => !pollTools.includes(name)).sort()) }
    finally { await limited.close() }
    expect((await client.listTools()).tools.map((t) => t.name).filter((name) => pollTools.includes(name)).sort()).toEqual(pollTools)
    const res = await fetch(`${baseUrl}/v1/polls/list`, { method: 'POST', headers: { authorization: `Bearer ${groupToken}`, 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(404)
  })

  it('lists meeting tools only for host-issued meeting scopes; an API built without the deployment switch has no meeting route', async () => {
    const meetingTools = ['friday_join_meeting', 'friday_leave_meeting', 'friday_list_meetings', 'friday_propose_meeting_draft', 'friday_read_meeting', 'friday_sync_meeting']
    const withoutMeetings = tokens.issue({ runId: 'run:dm:ou_alice', sessionKey: 'dm:ou_alice', chatId: 'oc_dm', chatType: 'p2p', spaceId: spaces.byChat('oc_dm')!.id,
      requesterOpenId: 'ou_alice', cwd: workDir, scopes: ALL_SCOPES.filter((scope) => !scope.startsWith('meetings:')) })
    const limited = await connect(withoutMeetings)
    try { expect((await limited.listTools()).tools.map((t) => t.name).filter((name) => name.includes('meeting'))).toEqual([]) }
    finally { await limited.close() }
    expect((await dmClient.listTools()).tools.map((t) => t.name).filter((name) => meetingTools.includes(name)).sort()).toEqual(meetingTools)
    for (const operation of ['list', 'join']) {
      const res = await fetch(`${baseUrl}/v1/meetings/${operation}`, { method: 'POST', headers: { authorization: `Bearer ${dmToken}`, 'content-type': 'application/json' }, body: operation === 'join' ? '{"meetingNumber":"123456789"}' : '{}' })
      expect(res.status).toBe(404)
    }
  })

  it('delegates the exact info question and preserves sent or unknown delivery facts', async () => {
    const bucket = bugs.record({ spaceId: spaces.byChat('oc_1')!.id, chatId: 'oc_1', title: 'question API contract', text: 'synthetic feedback' }).bucket
    const out = JSON.parse(await callTool('friday_bug_ask', { id: bucket.id, question: '上一步做了什么？', missing_info: ['last action'] }))
    expect(out).toMatchObject({ question: '上一步做了什么？', delivery_status: 'sent', message_id: 'host-question-receipt', budget: { occupied: 1, max: 3 }, next: 'continue_independent_work' })
    expect(hostQuestion).toHaveBeenLastCalledWith('msg:om_root', 'run:msg:om_root', { id: bucket.id, question: '上一步做了什么？', kind: 'info', missingInfo: ['last action'] })
    const unknown = { question_id: 7, question: '上一步做了什么？', resolution: 'open' as const, delivery_status: 'unknown' as const, budget: { occupied: 1, max: 3 }, next: 'continue_independent_work' as const }
    hostQuestion.mockResolvedValueOnce(unknown)
    expect(JSON.parse(await callTool('friday_bug_ask', { id: bucket.id, question: unknown.question, kind: 'info' }))).toEqual(unknown)
    expect(bugs.get(bucket.id)?.asks).toBe(0)
  })

  it('rejects legacy counter-only asks and unsupported decisions at the MCP schema', async () => {
    const before = hostQuestion.mock.calls.length
    for (const args of [{ id: 1 }, { id: 1, question: '批准发布吗？', kind: 'decision' }]) {
      const result = await client.callTool({ name: 'friday_bug_ask', arguments: args })
      expect(result.isError).toBe(true)
    }
    expect(hostQuestion.mock.calls.length).toBe(before)
    const tools = await client.listTools()
    const ask = tools.tools.find((tool) => tool.name === 'friday_bug_ask')!
    expect(ask.description).toContain('不依赖答案的独立工作')
    expect(ask.description).not.toMatch(/问完就停|骚扰|调用即算/)
    expect(tools.tools.find((tool) => tool.name === 'friday_bug_link_issue')!.description).toContain('本身不授予建单许可')
  })

  it('friday_propose_skill 只在用户明确要求时提议，不再建议“完成可复用流程后沉淀”（P5-1b）', async () => {
    const tools = await client.listTools()
    const propose = tools.tools.find((tool) => tool.name === 'friday_propose_skill')!
    expect(propose.description).toContain('用户明确说')
    expect(propose.description).not.toContain('沉淀')
  })

  it('maps an explicit reply outcome to the host using trusted run identity', async () => {
    const spaceId = spaces.byChat('oc_1')!.id
    const bucket = bugs.record({ spaceId, chatId: 'oc_1', title: 'reply API contract', text: 'synthetic feedback' }).bucket
    const task = registry.createTaskOnce({ sessionKey: 'msg:om_root', messageId: 'om_question_origin', requesterOpenId: 'ou_alice', prompt: 'synthetic feedback' }).task
    const question = questions.prepare({ bucketId: bucket.id, spaceId, sessionKey: 'msg:om_root', originTaskId: task.id, targetOpenId: 'ou_alice', anchor: { tenantId: 'synthetic-tenant', appId: 'synthetic-app', chatId: 'oc_1', messageId: task.messageId }, kind: 'info', question: '可以提供日志吗？' })
    const out = JSON.parse(await callTool('friday_bug_reply', { question_id: question.id, reply_id: 5, outcome: 'declined' }))
    expect(out).toMatchObject({ question: { id: question.id }, reply: { id: 5, outcome: 'declined' } })
    expect(hostReply).toHaveBeenCalledExactlyOnceWith('msg:om_root', 'run:msg:om_root', { questionId: question.id, replyId: 5, outcome: 'declined' })
    expect(questions.get(question.id)?.resolution).toBe('open') // protocol stub is not real host execution
  })

  it('reads the thread bound to the session (and caches it)', async () => {
    const out = await callTool('feishu_read_thread', {})
    expect(out).toContain('A: 话题第一条')
    expect(out).toContain('B: 话题第二条')
    expect(messageCache.count('oc_1')).toBeGreaterThanOrEqual(2)
  })

  it('reads chat history with limit paging and keyword filter, backfilling from the API once', async () => {
    const before = feishu.calls.listChatHistory
    // Both reads cover the same interval; a rolling window may legitimately need a new second of history.
    const range = { start_time: new Date(now - 10 * 3600_000).toISOString(), end_time: new Date(now).toISOString() }
    const out = await callTool('feishu_read_chat_history', { ...range, limit: 2 })
    expect(out).toContain('共 2 条')
    expect(out).toContain('还有更多')
    expect(feishu.calls.listChatHistory).toBeGreaterThan(before)
    const after = feishu.calls.listChatHistory
    const filtered = await callTool('feishu_read_chat_history', { ...range, keyword: '关键词' })
    expect(filtered).toContain('群消息 3 关键词')
    expect(filtered).not.toContain('群消息 1')
    expect(feishu.calls.listChatHistory).toBe(after) // 第二次全走缓存
  })

  it('searches messages by query and sender', async () => {
    const out = await callTool('feishu_search_messages', { query: '关键词', hours_back: 48 })
    expect(out).toContain('1 条命中')
    expect(out).toContain('群消息 3 关键词')
    const bySender = await callTool('feishu_search_messages', { sender: '陆知行', hours_back: 48 })
    expect(bySender).toContain('陆知行')
    expect(bySender).not.toContain('李雷:')
  })

  it('finds files and downloads them into the workspace', async () => {
    const files = await callTool('feishu_find_files', { name: 'SKILL', hours_back: 48 })
    expect(files).toContain('SKILL.md')
    expect(files).toContain('message_id=om_file_1')
    const dl = await callTool('feishu_get_message_file', { message_id: 'om_file_1' })
    expect(dl).toContain('已下载 SKILL.md')
    const path = dl.split('→ ')[1]?.trim() as string
    expect(path.startsWith(join(workDir, 'downloads'))).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('fk_1')
    expect(feishu.downloads[0]?.type).toBe('file')
    const img = await callTool('feishu_get_message_file', { message_id: 'om_img_1' })
    expect(img).toContain('已下载')
    expect(feishu.downloads[1]?.type).toBe('image')
    const none = await callTool('feishu_get_message_file', { message_id: 'om_g1_1' })
    expect(none).toContain('没有可下载的附件')
  })

  it('creates documents: as the bot in groups (shared with requester + chat), explains missing scopes', async () => {
    const out = await callTool('feishu_create_document', { title: '发布纪要', markdown: '# 结论\n- 周五发版' })
    expect(out).toContain('https://test.feishu.cn/docx/doxcn1')
    expect(out).toContain('已共享给：requester、chat')
    expect(feishu.createdDocs[0]).toMatchObject({ title: '发布纪要', asUser: false })
    expect(feishu.grants.map((g) => `${g.member.openId ?? g.member.chatId}:${g.perm}`)).toEqual(['ou_alice:full_access', 'oc_1:edit'])
    feishu.failDocCreate = true
    try {
      const denied = await callTool('feishu_create_document', { title: 'x', markdown: 'y' })
      expect(denied).toContain('docx:document')
    } finally {
      feishu.failDocCreate = false
    }
    const bad = await callTool('feishu_create_document', { title: '', markdown: 'y' })
    expect(bad).toContain('title')
  })

  it('creates tables: bot-owned, shared with requester + chat, keeps only declared columns', async () => {
    const out = await callTool('feishu_create_table', {
      title: '成员档案',
      fields: [{ name: '成员', type: 'text' }, { name: '城市', type: 'select' }],
      rows: [{ 成员: '陆知行', 城市: '北京', 手机号: '13800000000' }],
    })
    expect(out).toContain('https://test.feishu.cn/base/bascn1')
    expect(out).toContain('2 列 × 1 行')
    expect(out).toContain('已共享给：requester、chat')
    // 行里多给的「手机号」不会变成一列
    expect(Object.keys(bitable.created[0]!.records[0]!.fields)).toEqual(['成员', '城市'])
    expect(feishu.grants.filter((g) => g.type === 'bitable').map((g) => `${g.member.openId ?? g.member.chatId}:${g.perm}`)).toEqual(['ou_alice:full_access', 'oc_1:edit'])
    const dup = await callTool('feishu_create_table', { title: '重复列', fields: [{ name: 'A' }, { name: 'A' }] })
    expect(dup).toContain('列名重复')
  })

  it('calendar: DM only, needs personal auth, lists events in range', async () => {
    const denied = await callTool('feishu_my_calendar', {})
    expect(denied).toContain('calendar:read') // 群会话没有这个作用域
    const noAuth = await callTool('feishu_my_calendar', {}, dmClient)
    // 拒绝要说清缺的是什么，并且把下一步指向"网关把授权卡发过去"，而不是让人去敲命令。
    expect(noAuth).toContain('先连接你的飞书账号')
    expect(noAuth).toContain('没有取得授权卡的送达回执')
    expect(noAuth).not.toMatch(/敲\s*\/connect|发\s*\/connect/)
  })

  it('group sessions only see their own chat', async () => {
    const chats = await callTool('feishu_list_chats')
    expect(chats).toContain('alpine 讨论群')
    expect(chats).not.toContain('数仓对接群')
    // 群会话里指定别的群明确拒绝，不静默换成本群
    const out = await callTool('feishu_read_chat_history', { chat: '数仓对接群', hours_back: 48 })
    expect(out).toContain('只能读取本群')
    expect(out).not.toContain('月度报表')
  })

  it('a group in a circle can read the other groups of that circle (and nothing else)', async () => {
    circles.join('oc_1', 'harness', 'ou_alice')
    circles.join('oc_2', 'harness', 'ou_alice')
    try {
      const chats = await callTool('feishu_list_chats')
      expect(chats).toContain('alpine 讨论群')
      expect(chats).toContain('数仓对接群')
      expect(chats).not.toContain('管理层群')
      const out = await callTool('feishu_read_chat_history', { chat: '数仓对接群', hours_back: 48 })
      expect(out).toContain('月度报表')
      const denied = await callTool('feishu_read_chat_history', { chat: '管理层群', hours_back: 48 })
      expect(denied).toContain('找不到群')
      // 不指定群仍是本群
      const own = await callTool('feishu_read_chat_history', { hours_back: 48 })
      expect(own).toContain('alpine 讨论群')
    } finally {
      circles.leave('oc_1')
      circles.leave('oc_2')
    }
    expect(await callTool('feishu_list_chats')).not.toContain('数仓对接群')
  })

  it('DM sessions can read groups the requester is in, but not others', async () => {
    const chats = await callTool('feishu_list_chats', {}, dmClient)
    expect(chats).toContain('alpine 讨论群')
    expect(chats).toContain('数仓对接群')
    expect(chats).not.toContain('管理层群')
    const out = await callTool('feishu_read_chat_history', { chat: '数仓', hours_back: 48 }, dmClient)
    expect(out).toContain('月度报表 8/11 排期 3 天')
    const denied = await callTool('feishu_read_chat_history', { chat: '管理层群', hours_back: 48 }, dmClient)
    expect(denied).toContain('找不到群')
    const search = await callTool('feishu_search_messages', { query: '排期', chat: '数仓对接群', hours_back: 48 }, dmClient)
    expect(search).toContain('陆知行')
    // 不指定群：只搜缓存（oc_2 已回填），且不会碰管理层群
    const all = await callTool('feishu_search_messages', { query: '年终奖', hours_back: 48 }, dmClient)
    expect(all).toContain('0 条命中')
  })

  it('reads a document and explains permission failures', async () => {
    expect(await callTool('feishu_read_document', { url: 'https://x.feishu.cn/docx/DocTok' })).toContain('正文内容')
    const denied = await callTool('feishu_read_document', { url: 'https://x.feishu.cn/docx/Unknown12345' })
    expect(denied).toContain('应用后台尚未开通本次所需权限')
    expect(denied).toContain('重新个人授权不能解决')
  })

  it('delegates requester DMs to the bound host run without a direct-send fallback', async () => {
    const before = hostDelivery.mock.calls.length
    const sentBefore = feishu.sent.length
    const out = await callTool('feishu_send_dm', { text: '汇报' })
    expect(out).toContain('已私聊发送')
    expect(out).toContain('host-delivery-receipt')
    expect(hostDelivery).toHaveBeenCalledTimes(before + 1)
    expect(hostDelivery.mock.lastCall).toEqual(['msg:om_root', 'run:msg:om_root', { kind: 'message', text: '汇报' }])
    expect(feishu.sent).toHaveLength(sentBefore)
  })

  it('reports a successful file separately from its unknown note receipt', async () => {
    writeFileSync(join(workDir, 'synthetic-note.txt'), 'synthetic file body')
    hostDelivery.mockResolvedValueOnce({ messageId: 'host-file-receipt', noteStatus: 'unknown' })
    const before = hostDelivery.mock.calls.length
    const sentBefore = feishu.sent.length
    const out = await callTool('feishu_send_file', { path: 'synthetic-note.txt', note: '合成附言' })
    expect(out).toContain('已发送 synthetic-note.txt')
    expect(out).toContain('host-file-receipt')
    expect(out).toContain('附言发送结果待核对')
    expect(out).not.toMatch(/附言(?:已发送|发送成功)/)
    expect(hostDelivery).toHaveBeenCalledTimes(before + 1)
    expect(hostDelivery.mock.lastCall).toEqual(['msg:om_root', 'run:msg:om_root', { kind: 'file', data: Buffer.from('synthetic file body'), name: 'synthetic-note.txt', note: '合成附言' }])
    expect(feishu.uploads).toHaveLength(0)
    expect(feishu.sent).toHaveLength(sentBefore)
  })

  it('saves and searches memory in the chat scope', async () => {
    expect(await callTool('friday_memory_save', { title: '数仓对接人是陆知行', body: '8/4 确认', kind: 'fact' })).toContain('已保存')
    expect(await callTool('friday_memory_search', { query: '陆知行' })).toContain('数仓对接人')
    expect(memory.count(chatScope(registry.db, 'oc_1'))).toBe(1)
  })

  it('tracks todos per scope', async () => {
    const added = await callTool('friday_todo_add', { title: '月度报表交付', detail: '8/11 排期 3 天', due: '2026-08-14T18:00:00+08:00', owner: '陆知行' })
    expect(added).toMatch(/已记录待办「月度报表交付」/)
    const id = Number(added.match(/\[todo:(\d+)\]/)?.[1])
    const list = await callTool('friday_todo_list', {})
    expect(list).toContain('月度报表交付')
    expect(list).toContain('@陆知行')
    // 私聊作用域看不到群里的待办
    expect(await callTool('friday_todo_list', {}, dmClient)).toContain('没有待办')
    expect(await callTool('friday_todo_done', { id }, dmClient)).toContain('没有这条未完成的待办')
    expect(await callTool('friday_todo_done', { id })).toContain(`待办已完成 [todo:${id}]`)
    expect(await callTool('friday_todo_list', {})).toContain('没有待办')
    expect(await callTool('friday_todo_list', { status: 'done' })).toContain('[待办·done] 月度报表交付')
  })

  it('提职责提案时顺手进收件箱——卡片会被群里的消息刷走，收件箱是兜底', async () => {
    const out = await callTool('friday_responsibility_propose', {
      name: '每天核对发布清单',
      prompt: '每天早上看一遍发布清单里还没勾的项',
      schedule: { type: 'daily', at: '09:00' },
      reason: '你这周问了三次',
    })
    expect(out).toContain('已提出职责提案')
    const items = inbox.pending('ou_alice')
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('responsibility')
    expect(items[0]?.title).toContain('每天核对发布清单')
    // 指针指回 routines，内容不重复存——两份内容迟早会不一致
    expect(items[0]?.refId).toBe(routines.proposals(items[0]!.spaceId!)[0]?.id)
  })

  it('reads the original routine instruction before editing and keeps its cursor and audience', async () => {
    feishu.nextToken = { accessToken: 'synthetic-watch-token', expiresIn: 7200, scope: [...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.watch].join(' ') }
    await userTokens.complete({ openId: 'ou_alice', code: 'synthetic', redirectUri: 'https://callback.invalid' })
    feishu.userChats.set('synthetic-watch-token', [{ chatId: 'oc_1', name: 'alpine 讨论群' }])
    const added = await callTool('friday_watch_add', {
      name: '发布关注', chats: ['oc_1'], topic: '只报告发布阻塞，无变化保持安静',
      schedule: { type: 'interval', everyMinutes: 60 },
    }, dmClient)
    const id = Number(added.match(/\[routine:(\d+)\]/)?.[1])
    expect(id).toBeGreaterThan(0)
    const before = routines.get(id)!
    const detail = JSON.parse(await callTool('friday_routine_list', { id }, dmClient))
    expect(detail).toMatchObject({
      id, prompt: '只报告发布阻塞，无变化保持安静', watch_chat_ids: ['oc_1'], deliver_to: 'dm',
      status: 'active', enabled: true,
    })
    expect(await callTool('friday_routine_list', { id })).toBe('当前范围没有这条定时任务')
    expect(await callTool('friday_routine_list', { id: 999999 })).toBe('当前范围没有这条定时任务')

    expect(await callTool('friday_routine_update', { id, prompt: `${detail.prompt}；报告带产物链接` }, dmClient)).toContain('已改')
    const after = routines.get(id)!
    expect(after.prompt).toBe('只报告发布阻塞，无变化保持安静；报告带产物链接')
    expect(after.id).toBe(before.id)
    expect(after.lastRunAt).toBe(before.lastRunAt)
    expect(after.watchChatIds).toEqual(before.watchChatIds)
    expect(after.deliverTo).toBe(before.deliverTo)
    expect(await callTool('friday_routine_remove', { id, disable_only: true }, dmClient)).toContain('已停用')
    const stopped = JSON.parse(await callTool('friday_routine_list', { id }, dmClient))
    expect(stopped.enabled).toBe(false)
    expect(stopped.prompt).toBe(after.prompt)
  })

  it('rejects bad tokens and missing scopes', async () => {
    const res = await fetch(`${baseUrl}/v1/thread/messages`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })
    expect(res.status).toBe(401)
    const limited = tokens.issue({ runId: 'run:msg:om_root', sessionKey: 'msg:om_root', chatId: 'oc_1', chatType: 'group', scopes: ['thread:read'] })
    const res2 = await fetch(`${baseUrl}/v1/dm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${limited}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    })
    expect(res2.status).toBe(403)
    const health = await fetch(`${baseUrl}/healthz`)
    expect(health.status).toBe(200)
    // The gateway reports the commit it started from, so a deploy can confirm the new version is the one answering.
    expect(await health.json()).toEqual({ ok: true, version: 'a'.repeat(40) })
  })
})
