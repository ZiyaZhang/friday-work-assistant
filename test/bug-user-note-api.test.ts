import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { FeedbackControl } from '../src/core/feedback-control.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

/** Real HTTP, SQLite and stores; the resolver is an explicit trusted-host fixture, not a model or live Feishu. */
async function setup(prompt = '补充一下，文字还在是指输入框里的草稿，不是已发出的消息。', withQuestions = true) {
  const registry = new Registry(':memory:'), bugs = new Bugs(registry.db)
  const questions = new BugQuestions(registry.db, bugs), routines = new RoutineStore(registry.db)
  const feedback = new FeedbackControl(registry, bugs, questions, routines)
  const sp = spaceDeps(registry.db), feishu = new FakeFeishu(), cache = new MessageCache(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-synthetic', openId: 'alice' })
  const session = registry.createSession({ sessionKey: 'synthetic-session', chatId: space.chatId, chatType: 'group', cwd: '/synthetic', requesterOpenId: 'alice' })
  const origin = registry.createTaskOnce({ sessionKey: session.sessionKey, messageId: 'om_original', requesterOpenId: 'alice', prompt: '图片上传一直发送中，刷新后消失。' }).task
  registry.updateTask(origin.id, { status: 'running' })
  const bucket = bugs.record({ spaceId: space.id, chatId: space.chatId, messageId: origin.messageId, reporterOpenId: 'alice', title: '合成图片反馈', text: origin.prompt }).bucket
  const task = registry.createTaskOnce({ sessionKey: session.sessionKey, messageId: 'om_correction', requesterOpenId: 'alice', prompt }).task
  registry.updateTask(task.id, { status: 'running' })
  feedback.stop({ feedbackId: bucket.id, spaceId: space.id, chatId: space.chatId, chatType: 'group', openId: 'alice', controllerTaskId: task.id })
  cache.upsert(space.chatId, [historyMsg({ messageId: task.messageId, chatId: space.chatId, senderOpenId: 'alice', senderName: 'Alice Verified', text: prompt })])
  const state: { derivedSafe: boolean; actor: ReturnType<NonNullable<InternalApiDeps['resolveActorForSession']>>; onResolve?: () => void } = {
    derivedSafe: true, actor: { requesterOpenId: 'alice', runId: 'run-current', stage: 'task', taskId: task.id },
  }
  const actor = vi.fn(() => { state.onResolve?.(); return state.actor })
  const sourceGuard = vi.fn(() => state.derivedSafe)
  const tokens = new TokenIssuer('synthetic-user-note-secret'), log = createLogger('user-note-api-test', 'error')
  const api = createInternalApi({ registry, bugs, questions: withQuestions ? questions : undefined, routines, feedback, ...sp, feishu: asFeishuClient(feishu), messageCache: cache,
    memory: new ChannelMemory(registry.db), messages: new MessageService(asFeishuClient(feishu), cache, log), todos: new Todos(registry.db),
    tokens, log, maxHistoryPerCall: 50, resolveActorForSession: actor, canPersistDerivedState: sourceGuard,
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())); registry.close() })
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const cap: Omit<Capability, 'exp'> = { runId: 'run-current', sessionKey: session.sessionKey, chatId: space.chatId, chatType: 'group', requesterOpenId: 'alice', spaceId: space.id, scopes: ['bug:record', 'routine:write'] }
  const headers = { authorization: `Bearer ${tokens.issue(cap)}`, 'content-type': 'application/json' }
  const post = async (path: string, body: Record<string, unknown>, patch: Partial<typeof cap> = {}) => {
    const res = await fetch(`${base}/v1/${path}`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${tokens.issue({ ...cap, ...patch })}` }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const snapshot = () => ['bug_buckets', 'bug_reports', 'bug_questions', 'tasks', 'routines', 'routine_occurrences'].map(table => registry.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
  return { registry, bugs, questions, routines, feedback, ...sp, space, session, origin, task, bucket, cache, feishu, state, actor, sourceGuard, base, headers, post, snapshot, token: tokens.issue(cap) }
}

describe('stopped feedback user notes through real HTTP', () => {
  it.each([true, false])('returns full recent corrections and marks context truncation (questions=%s)', async withQuestions => {
    const t = await setup(undefined, withQuestions)
    for (let i = 0; i < 51; i++) t.bugs.captureUserNote({ bucketId: t.bucket.id, spaceId: t.space.id, chatId: t.space.chatId,
      messageId: `om_note_${i}`, reporterOpenId: 'alice', text: `${'完整补充'.repeat(550)}-${i}`, now: Date.now() + i })
    const result = await t.post('bug/context', { id: t.bucket.id }, { scopes: ['bug:read'] })
    expect(result.status).toBe(200)
    expect(result.body.reportsTruncated).toBe(true)
    const reports = result.body.reports as { messageId: string; text: string; recordKind: string }[]
    expect(reports).toHaveLength(50)
    expect(reports[0]).toMatchObject({ messageId: 'om_note_50', recordKind: 'user_note', text: `${'完整补充'.repeat(550)}-50` })
    expect(reports.at(-1)?.messageId).toBe('om_note_1')
    expect(result.body.questions).toEqual([])
  })

  it('accepts only bucket_id through the actual MCP schema and HTTP API, with a receipt that preserves the stopped state', async () => {
    const t = await setup(); t.state.derivedSafe = false
    const server = buildServer({ apiUrl: t.base, token: t.token })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'synthetic-user-note-test', version: '0.0.0' })
    await client.connect(clientTransport)
    cleanups.push(async () => { await client.close(); await server.close() })
    const result = await client.callTool({ name: 'friday_bug_record', arguments: { bucket_id: t.bucket.id } })
    expect(result.isError).not.toBe(true)
    const text = (result.content as { type: string; text?: string }[]).map(item => item.text ?? '').join('\n')
    expect(text).toContain(`[bug:${t.bucket.id}]`)
    expect(text).toContain('仍保持停止跟进')
    expect(t.bugs.reports(t.bucket.id).filter(report => report.recordKind === 'user_note')).toMatchObject([{ messageId: t.task.messageId, text: t.task.prompt }])
    expect(t.bugs.get(t.bucket.id)).toMatchObject({ intakePhase: 'cancelled', count: 1 })
    expect(t.routines.followupsFor(t.session.sessionKey)).toEqual([])
  })

  it('stores the entire current Task prompt after dirty reads, ignoring all model-written content and attribution', async () => {
    const prompt = `  更正：这里的文字是草稿。\n${'保留原话，不作诊断。'.repeat(250)}\n尾部原文  `
    const t = await setup(prompt); t.state.derivedSafe = false
    const before = t.bugs.get(t.bucket.id), original = t.bugs.reports(t.bucket.id)
    t.registry.createTaskOnce({ sessionKey: t.session.sessionKey, requesterOpenId: 'alice', messageId: 'om_newer', prompt: '另一条排队内容，不能替代本轮来源' })
    const result = await t.post('bug/record', { bucket_id: t.bucket.id, title: 'MODEL_TITLE', text: 'MODEL_TEXT', link: 'https://model.invalid', reporter_open_id: 'mallory', reporter_name: 'MODEL_NAME' })
    expect(result).toMatchObject({ status: 200, body: { isNew: false, duplicate: false, record_kind: 'user_note', recorded_current_message: true, stopped: true } })
    expect(t.sourceGuard).not.toHaveBeenCalled()
    expect(t.bugs.get(t.bucket.id)).toEqual(before)
    expect(t.bugs.reports(t.bucket.id)).toEqual([
      expect.objectContaining({ recordKind: 'user_note', messageId: t.task.messageId, reporterOpenId: 'alice', reporterName: 'Alice Verified', text: prompt, link: null, createdAt: t.task.createdAt }),
      ...original,
    ])
    expect(t.feishu.sent).toEqual([])
    expect(t.routines.listForFeedback(t.bucket.id, t.space.id)).toEqual([])
  })

  it('accepts just the stopped bucket id, deduplicates without changing its statistics, and rejects reassignment to another case', async () => {
    const t = await setup(), before = t.bugs.get(t.bucket.id)
    expect((await t.post('bug/record', { bucket_id: t.bucket.id })).status).toBe(200)
    const afterFirst = t.snapshot()
    expect(await t.post('bug/record', { bucket_id: t.bucket.id, text: '另一份模型改写' })).toMatchObject({ status: 200, body: { duplicate: true } })
    expect(t.snapshot()).toEqual(afterFirst)
    expect(t.bugs.get(t.bucket.id)).toEqual(before)
    const other = t.bugs.record({ spaceId: t.space.id, chatId: t.space.chatId, title: '不同合成问题', text: '另一个现象' }).bucket
    t.bugs.stopFollowing(other.id, t.space.id)
    const beforeConflict = t.snapshot()
    expect((await t.post('bug/record', { bucket_id: other.id })).status).toBe(409)
    expect(t.snapshot()).toEqual(beforeConflict)
  })

  it.each(['current', 'historical'] as const)('rejects an explicit %s message id, rather than treating it as trusted current input', async kind => {
    const t = await setup(), before = t.snapshot()
    const messageId = kind === 'current' ? t.task.messageId : 'om_historical'
    expect((await t.post('bug/record', { bucket_id: t.bucket.id, message_id: messageId, title: '模型标题', text: '模型声称的原文' })).status).toBe(409)
    expect(t.snapshot()).toEqual(before)
  })

  it.each(['stopped-worker', 'done-task', 'queued-task', 'no-receipt', 'reflect', 'routine', 'missing-run', 'missing-task', 'other-author', 'other-session'] as const)('rejects %s before recording any user note', async invalid => {
    const t = await setup()
    if (invalid === 'stopped-worker') t.state.actor!.taskId = t.origin.id
    if (invalid === 'done-task') t.registry.updateTask(t.task.id, { status: 'done', stopReason: 'end_turn' })
    if (invalid === 'queued-task') t.registry.updateTask(t.task.id, { status: 'queued' })
    if (invalid === 'no-receipt') t.registry.db.prepare('DELETE FROM task_receipts WHERE task_id = ?').run(t.task.id)
    if (invalid === 'reflect' || invalid === 'routine') t.state.actor!.stage = invalid
    if (invalid === 'missing-run') t.state.actor!.runId = undefined
    if (invalid === 'missing-task') t.state.actor!.taskId = undefined
    if (invalid === 'other-author') {
      const task = t.registry.createTaskOnce({ sessionKey: t.session.sessionKey, messageId: 'om_bob', requesterOpenId: 'bob', prompt: '别人原文' }).task
      t.registry.updateTask(task.id, { status: 'running' }); t.state.actor!.taskId = task.id
    }
    if (invalid === 'other-session') {
      t.registry.createSession({ sessionKey: 'other-session', chatId: t.space.chatId, chatType: 'group', cwd: '/synthetic', requesterOpenId: 'alice' })
      const task = t.registry.createTaskOnce({ sessionKey: 'other-session', messageId: 'om_other', requesterOpenId: 'alice', prompt: '别的会话' }).task
      t.registry.updateTask(task.id, { status: 'running' }); t.state.actor!.taskId = task.id
    }
    const before = t.snapshot()
    expect((await t.post('bug/record', { bucket_id: t.bucket.id })).status).toBe(403)
    expect(t.snapshot()).toEqual(before)
  })

  it('does not treat a system followup receipt as human input even when its actor stage is task', async () => {
    const t = await setup()
    const task = t.registry.createTaskOnce({ sessionKey: t.session.sessionKey, messageId: t.task.messageId, requesterOpenId: 'alice', prompt: '系统自动核查，不是新的用户原文' }, 'routine:9:occurrence:7:v1').task
    t.registry.updateTask(task.id, { status: 'running' }); t.state.actor!.taskId = task.id
    const before = t.snapshot()
    expect((await t.post('bug/record', { bucket_id: t.bucket.id })).status).toBe(403)
    expect(t.snapshot()).toEqual(before)
  })

  it('rejects an execution linked to a stopped report even if its Task has no stopReason yet', async () => {
    const t = await setup()
    const related = t.bugs.record({ spaceId: t.space.id, chatId: t.space.chatId, messageId: t.task.messageId, reporterOpenId: 'alice', title: '真实委托关联', text: t.task.prompt }).bucket
    t.bugs.stopFollowing(related.id, t.space.id)
    expect(t.registry.getTask(t.task.id)?.stopReason).toBeNull()
    expect(t.feedback.taskStopped(t.task.id)).toBe(true)
    const before = t.snapshot()
    expect((await t.post('bug/record', { bucket_id: t.bucket.id })).status).toBe(403)
    expect(t.snapshot()).toEqual(before)
  })

  it('rejects a body arriving after its captured run changes', async () => {
    const t = await setup(), bound = deferred()
    t.state.onResolve = bound.resolve
    const body = JSON.stringify({ bucket_id: t.bucket.id })
    let req!: ReturnType<typeof request>
    const response = new Promise<number>((resolve, reject) => {
      req = request(`${t.base}/v1/bug/record`, { method: 'POST', headers: { ...t.headers, 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
      req.on('error', reject); req.flushHeaders()
    })
    await bound.promise; t.state.onResolve = undefined
    t.state.actor!.runId = 'replacement-run'
    const before = t.snapshot()
    req.end(body)
    expect(await response).toBe(403)
    expect(t.snapshot()).toEqual(before)
  })

  it('keeps scope and space boundaries on the special user-note path', async () => {
    const t = await setup()
    const otherSpace = t.spaces.ensure({ kind: 'group', chatId: 'chat-other', openId: 'alice' })
    const other = t.bugs.record({ spaceId: otherSpace.id, chatId: otherSpace.chatId, title: 'PRIVATE_TITLE', text: 'PRIVATE_TEXT' }).bucket
    t.bugs.stopFollowing(other.id, otherSpace.id)
    const before = t.snapshot()
    expect((await t.post('bug/record', { bucket_id: t.bucket.id }, { scopes: [] })).status).toBe(403)
    const result = await t.post('bug/record', { bucket_id: other.id })
    expect(result.status).toBe(404)
    expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE_TITLE|PRIVATE_TEXT/)
    expect(t.snapshot()).toEqual(before)
  })

  it('does not extend the dirty-source exception to active cases or new reports', async () => {
    const t = await setup(); t.state.derivedSafe = false
    const active = t.bugs.record({ spaceId: t.space.id, chatId: t.space.chatId, title: '活动反馈', text: '合成' }).bucket
    const before = t.snapshot()
    for (const body of [{ title: '新报告', text: '不应写入' }, { bucket_id: active.id, title: '活动案补充', text: '不应写入' }]) {
      expect((await t.post('bug/record', body)).status).toBe(403)
    }
    expect(t.snapshot()).toEqual(before)
  })

  it('associates a factual note without cancelling its execution, but cannot schedule an unbound followup to escape the stopped case', async () => {
    const t = await setup()
    expect((await t.post('bug/record', { bucket_id: t.bucket.id })).status).toBe(200)
    expect(t.feedback.taskFeedbackIds(t.task.id)).toEqual([t.bucket.id])
    expect(t.feedback.taskStopped(t.task.id)).toBe(false)
    expect(t.feedback.taskStopped(t.origin.id)).toBe(true)
    const result = t.feedback.stop({ feedbackId: t.bucket.id, spaceId: t.space.id, chatId: t.space.chatId, chatType: 'group', openId: 'alice', controllerTaskId: -1 })
    expect(result.stoppedTaskIds).not.toContain(t.task.id)
    expect(t.registry.getTask(t.task.id)).toMatchObject({ status: 'running', stopReason: null })
    const before = t.snapshot()
    expect((await t.post('followup/add', { in_minutes: 10, note: '稍后核查这条反馈' })).status).toBe(409)
    expect(t.snapshot()).toEqual(before)
    expect(t.routines.followupsFor(t.session.sessionKey)).toEqual([])
  })
})
