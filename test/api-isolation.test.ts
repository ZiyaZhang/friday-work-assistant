import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { ALL_SCOPES, GROUP_SCOPES, PROACTIVE_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import type { AbilityActor } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { DeliveryService } from '../src/core/delivery.js'
import { GitHubIdentity } from '../src/github/identity.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setup(abilities?: InternalApiDeps['abilities'], allowedRoutesForSession?: InternalApiDeps['allowedRoutesForSession'], resolveActorForSession?: InternalApiDeps['resolveActorForSession'], deliverToolResult?: InternalApiDeps['deliverToolResult'], questionDeps: Partial<Pick<InternalApiDeps, 'askBugQuestion' | 'resolveBugQuestionReply' | 'canPersistDerivedState'>> = {}) {
  const registry = new Registry(':memory:')
  const cwd = mkdtempSync(join(tmpdir(), 'friday-isolation-'))
  cleanups.push(() => { registry.close(); rmSync(cwd, { recursive: true, force: true }) })
  const feishu = new FakeFeishu()
  const messageCache = new MessageCache(registry.db)
  const log = createLogger('isolation-test', 'error')
  const bugs = new Bugs(registry.db)
  const questions = new BugQuestions(registry.db, bugs)
  const { spaces, circles, policy } = spaceDeps(registry.db)
  const a = spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  const b = spaces.ensure({ kind: 'group', chatId: 'chat-b', openId: 'bob' })
  const memory = new ChannelMemory(registry.db)
  const memoryHost = memoryRuntimeFixture(registry, memory)
  const memoryRunId = resolveActorForSession?.('session-a')?.runId ?? 'memory-fixture-run'
  memoryHost.pin({ runId: memoryRunId, sessionKey: 'session-a', actorOpenId: 'alice' })
  const tokens = new TokenIssuer('test-secret')
  const github = new GitHubIdentity({ apiUrl: 'https://api.github.com', token: 'synthetic', allowedRepos: ['test/repo'] }, log, {
    async request<T>() { return { status: 200, data: { number: 1, html_url: 'https://github.com/test/repo/issues/1', state: 'open' } as T } },
  })
  const api = createInternalApi({
    registry, bugs, questions, github, spaces, circles, policy, messageCache, abilities, allowedRoutesForSession, resolveActorForSession, deliverToolResult, ...questionDeps, appId: 'app-test',
    feishu: asFeishuClient(feishu),
    memory, memoryRuntime: memoryHost.runtime,
    messages: new MessageService(asFeishuClient(feishu), messageCache, log),
    todos: new Todos(registry.db), tokens, log, maxHistoryPerCall: 100,
  })
  const cap: Capability = { runId: memoryRunId, sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', requesterOpenId: 'alice', spaceId: a.id, cwd, scopes: [...ALL_SCOPES], exp: 9999999999 }
  const call = (path: string, body: Record<string, unknown>, actor = cap) => api.routes[`POST /v1/${path}`]!(actor, body)
  const http = async () => {
    await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve, reject) => api.server.close((err) => err ? reject(err) : resolve())))
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
    return (path: string, body: Record<string, unknown>, actor = cap, token = tokens.issue(actor)) => fetch(`${base}/v1/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
  }
  return { registry, bugs, questions, memory, spaces, circles, policy, feishu, messageCache, a, b, cap, call, http, tokens }
}

/** Real question/reply rows and DeliveryService ACK; API host callbacks remain a protocol stub. */
async function recordedQuestion(t: ReturnType<typeof setup>, cap = t.cap) {
  t.registry.createSession({ sessionKey: cap.sessionKey, chatId: cap.chatId, chatType: cap.chatType, cwd: cap.cwd!, requesterOpenId: cap.requesterOpenId })
  const origin = t.registry.createTaskOnce({ sessionKey: cap.sessionKey, messageId: `origin:${cap.sessionKey}`, requesterOpenId: cap.requesterOpenId, prompt: '原始合成反馈' }).task
  const bucket = t.bugs.record({ spaceId: cap.spaceId!, chatId: cap.chatId, title: '合成反馈', text: '原始合成反馈' }).bucket
  const question = t.questions.prepare({ bucketId: bucket.id, spaceId: cap.spaceId!, sessionKey: cap.sessionKey, originTaskId: origin.id, targetOpenId: cap.requesterOpenId!, anchor: { tenantId: 'tenant-test', appId: 'app-test', chatId: cap.chatId, messageId: origin.messageId }, kind: 'info', question: '上一步是什么？', missingInfo: ['last action'] })
  const delivery = new DeliveryService(t.registry.db, {
    spaces: t.spaces, policy: t.policy,
    resolveContext: async () => ({ actorOpenId: cap.requesterOpenId!, audience: { kind: 'group', spaceId: cap.spaceId!, chatId: cap.chatId }, sources: [{ ref: `space:${cap.spaceId}`, spaceId: cap.spaceId!, chatId: cap.chatId }], provenanceComplete: true, expiresAt: Date.now() + 60_000 }),
    send: async () => ({ remoteId: (await t.feishu.replyMarkdown(origin.messageId, question.question)).messageId }),
  })
  await delivery.deliver({ key: question.deliveryKey, contextRef: `question:${question.id}`, payload: { markdown: question.question } })
  const task = t.registry.createTaskOnce({ sessionKey: cap.sessionKey, messageId: `reply:${cap.sessionKey}`, requesterOpenId: cap.requesterOpenId, prompt: '我没有这些材料' }).task
  t.registry.updateTask(task.id, { status: 'running' })
  const reply = t.questions.acceptReply(question.id, { messageId: task.messageId, senderOpenId: cap.requesterOpenId!, taskId: task.id })
  return { bucket, question, reply, task }
}

describe('information-question API delegation', () => {
  const actor = () => ({ requesterOpenId: 'alice', runId: 'run-current', stage: 'task' })
  const receipt = { question_id: 7, question: '上一步是什么？', resolution: 'open' as const, delivery_status: 'sent' as const, message_id: 'om_question', budget: { occupied: 2, max: 3 }, next: 'continue_independent_work' as const }

  it.each([
    {}, { question: '  ' }, { question: 'Q', kind: 'decision' },
    { question: 'Q', kind: 'unsupported' }, { question: 'Q', missing_info: [''] },
  ])('rejects invalid or unsupported asks without spending legacy budget: %j', async (input) => {
    const ask = vi.fn(async () => receipt)
    const t = setup(undefined, undefined, actor, undefined, { askBugQuestion: ask })
    const bucket = t.bugs.record({ spaceId: t.a.id, chatId: 'chat-a', title: 'synthetic', text: 'synthetic' }).bucket
    const post = await t.http()
    expect((await post('bug/ask', { id: bucket.id, ...input })).status).toBe(400)
    expect(ask).not.toHaveBeenCalled()
    expect(t.bugs.get(bucket.id)?.asks).toBe(0)
    expect(t.questions.list(bucket.id, t.a.id)).toEqual([])
  })

  it.each(['sent', 'unknown', 'not_started'] as const)('preserves the host %s facts and ignores model-supplied identity', async (status) => {
    const facts = { ...receipt, delivery_status: status, next: status === 'not_started' ? 'not_sent' as const : 'continue_independent_work' as const, ...(status === 'sent' ? {} : { message_id: undefined }) }
    const ask = vi.fn(async () => facts)
    const t = setup(undefined, undefined, actor, undefined, { askBugQuestion: ask })
    const bucket = t.bugs.record({ spaceId: t.a.id, chatId: 'chat-a', title: 'synthetic', text: 'synthetic' }).bucket
    const post = await t.http()
    const res = await post('bug/ask', { id: bucket.id, question: ' 上一步是什么？ ', missing_info: [' last action '], runId: 'forged', targetOpenId: 'bob', sessionKey: 'forged', kind: 'info' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(facts)))
    expect(ask).toHaveBeenCalledExactlyOnceWith('session-a', 'run-current', { id: bucket.id, question: '上一步是什么？', kind: 'info', missingInfo: ['last action'] })
    expect(t.bugs.get(bucket.id)?.asks).toBe(0)
  })

  it.each(['routine', 'reflect', undefined] as const)('rejects a non-task stage %s even with bug:write', async (stage) => {
    const ask = vi.fn(async () => receipt)
    const t = setup(undefined, undefined, () => ({ ...actor(), stage }), undefined, { askBugQuestion: ask })
    const bucket = t.bugs.record({ spaceId: t.a.id, chatId: 'chat-a', title: 'synthetic', text: 'synthetic' }).bucket
    const post = await t.http()
    expect((await post('bug/ask', { id: bucket.id, question: 'Q', boundStage: 'task' })).status).toBe(403)
    expect(ask).not.toHaveBeenCalled()
  })

  it('requires the host callback, captured run, and safe sources', async () => {
    const ask = vi.fn(async () => receipt)
    for (const mode of ['no-host', 'no-actor', 'unsafe-sources'] as const) {
      const t = setup(undefined, undefined, mode === 'no-actor' ? undefined : actor, undefined, { ...(mode === 'no-host' ? {} : { askBugQuestion: ask }), canPersistDerivedState: () => mode !== 'unsafe-sources' })
      const bucket = t.bugs.record({ spaceId: t.a.id, chatId: 'chat-a', title: 'synthetic', text: 'synthetic' }).bucket
      const post = await t.http()
      expect((await post('bug/ask', { id: bucket.id, question: 'Q' })).status).toBe(mode === 'unsafe-sources' ? 403 : 503)
      expect(t.bugs.get(bucket.id)?.asks).toBe(0)
    }
    expect(ask).not.toHaveBeenCalled()
  })

  it('returns only authorized question/reply context and delegates the current reply outcome', async () => {
    let t!: ReturnType<typeof setup>
    let binding!: Awaited<ReturnType<typeof recordedQuestion>>
    const resolve = vi.fn<NonNullable<InternalApiDeps['resolveBugQuestionReply']>>(async (_key, _run, input) => ({
      reply: t.questions.resolveReply(input.questionId, input.replyId, binding.task.id, input.outcome),
      question: t.questions.get(input.questionId)!,
    }))
    t = setup(undefined, undefined, actor, undefined, { resolveBugQuestionReply: resolve })
    binding = await recordedQuestion(t)
    const post = await t.http()
    const context = await post('bug/context', { id: binding.bucket.id })
    expect(await context.json()).toMatchObject({ questions: [{ id: binding.question.id, question: '上一步是什么？', replies: [{ id: binding.reply.id, outcome: 'pending', messageId: binding.task.messageId }] }] })
    const response = await post('bug/reply', { question_id: binding.question.id, reply_id: binding.reply.id, outcome: 'unavailable', taskId: 999, runId: 'forged' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ question: { id: binding.question.id }, reply: { id: binding.reply.id, outcome: 'unavailable', taskId: binding.task.id } })
    expect(resolve).toHaveBeenCalledExactlyOnceWith('session-a', 'run-current', { questionId: binding.question.id, replyId: binding.reply.id, outcome: 'unavailable' })
    const foreign = { ...t.cap, spaceId: t.b.id, chatId: 'chat-b', requesterOpenId: 'bob' }
    await expect(t.call('bug/context', { id: binding.bucket.id }, foreign)).rejects.toMatchObject({ status: 403 })
  })

  it('rejects foreign questions and malformed reply outcomes before invoking the host', async () => {
    const resolve = vi.fn<NonNullable<InternalApiDeps['resolveBugQuestionReply']>>()
    const t = setup(undefined, undefined, actor, undefined, { resolveBugQuestionReply: resolve })
    const own = await recordedQuestion(t)
    const foreign = await recordedQuestion(t, { ...t.cap, sessionKey: 'session-b', chatId: 'chat-b', spaceId: t.b.id, requesterOpenId: 'bob' })
    const post = await t.http()
    for (const input of [
      { question_id: own.question.id, reply_id: '1', outcome: 'answered' },
      { question_id: own.question.id, reply_id: own.reply.id, outcome: ['answered'] },
      { question_id: own.question.id, reply_id: own.reply.id, outcome: 'cancelled' },
    ]) expect((await post('bug/reply', input)).status).toBe(400)
    expect((await post('bug/reply', { question_id: foreign.question.id, reply_id: foreign.reply.id, outcome: 'declined' })).status).toBe(404)
    expect((await post('bug/context', { id: foreign.bucket.id })).status).toBe(404)
    expect(resolve).not.toHaveBeenCalled()
    expect(t.questions.replies(own.question.id)[0]?.outcome).toBe('pending')
  })
})

describe('feedback API space isolation', () => {
  it('keeps the intake gap through follow-ups and stops local status changes after GitHub handoff', async () => {
    const t = setup()
    const bucket = t.bugs.record({ spaceId: t.a.id, chatId: 'chat-a', title: 'UI stuck', text: 'synthetic' }).bucket
    await expect(t.call('bug/intake', { id: bucket.id, phase: 'awaiting_info', missing_info: [] })).rejects.toMatchObject({ status: 400 })
    await t.call('bug/intake', { id: bucket.id, phase: 'awaiting_info', missing_info: ['version', 'last action'] })
    expect(await t.call('bug/context', { id: bucket.id })).toMatchObject({ bucket: { intakePhase: 'awaiting_info', missingInfo: ['version', 'last action'] }, formal_status_source: 'local_intake' })
    await expect(t.call('bug/intake', { id: bucket.id, phase: 'diagnosing' })).rejects.toMatchObject({ status: 400 })
    await t.call('bug/intake', { id: bucket.id, phase: 'diagnosing', missing_info: [] })
    await t.call('bug/link_issue', { id: bucket.id, issue_url: 'https://github.com/test/repo/issues/1' })
    await expect(t.call('bug/intake', { id: bucket.id, phase: 'resolved_without_issue' })).rejects.toMatchObject({ status: 409 })
    expect(await t.call('bug/context', { id: bucket.id })).toMatchObject({ bucket: { intakePhase: 'linked_issue' }, formal_status_source: 'github' })
    await expect(t.call('bug/context', { id: bucket.id }, { ...t.cap, chatId: 'chat-b', spaceId: t.b.id, requesterOpenId: 'bob' })).rejects.toMatchObject({ status: 404 })
  })

  it('anchors only verified same-chat evidence and never downloads the referenced export', async () => {
    const t = setup()
    const bucket = t.bugs.record({ spaceId: t.a.id, chatId: 'chat-a', title: 'UI stuck', text: 'synthetic' }).bucket
    t.feishu.messages.set('upload-1', historyMsg({ messageId: 'upload-1', chatId: 'chat-a', tenantId: 'tenant-a', text: '[file]', fileKey: 'zip-key', threadId: 'thread-1' }))
    const result = await t.call('bug/evidence', { id: bucket.id, message_id: 'upload-1', tenant_id: 'spoof', app_id: 'spoof', coverage: 'complete', path: '/private/log.zip' })
    expect(result).toMatchObject({ anchor: { appId: 'app-test', tenantId: 'tenant-a', chatId: 'chat-a', threadId: 'thread-1' }, evidence: { coverage: { state: 'unknown' } }, downloaded: false, analyzed: false })
    await t.call('bug/evidence', { id: bucket.id, message_id: 'upload-1' })
    expect(t.bugs.evidence(bucket.id, t.a.id)).toHaveLength(1)
    expect(t.feishu.downloads).toHaveLength(0)
    for (const chatId of ['chat-b', undefined]) {
      t.feishu.messages.set('foreign', historyMsg({ messageId: 'foreign', chatId, tenantId: 'tenant-a', text: 'private' }))
      await expect(t.call('bug/evidence', { id: bucket.id, message_id: 'foreign' })).rejects.toMatchObject({ status: 403 })
    }
    t.feishu.messages.set('no-tenant', historyMsg({ messageId: 'no-tenant', chatId: 'chat-a', text: 'no tenant' }))
    await expect(t.call('bug/evidence', { id: bucket.id, message_id: 'no-tenant' })).rejects.toMatchObject({ status: 403 })
    expect(t.bugs.anchors(bucket.id, t.a.id)).toHaveLength(1)
  })

  it.each([
    ['bug/update', { status: 'fixed', title: 'overwritten' }],
    ['bug/link_issue', { issue_url: 'https://example.test/issues/1' }],
    ['bug/ask', {}],
  ])('rejects another space in %s without mutation or disclosure', async (path, body) => {
    const t = setup()
    const victim = t.bugs.record({ spaceId: t.b.id, chatId: 'chat-b', title: 'private issue', text: 'private report' }).bucket
    await expect(t.call(path, { id: victim.id, ...body })).rejects.toMatchObject({ status: 404 })
    expect(t.bugs.get(victim.id)).toEqual(victim)
    expect(t.bugs.reports(victim.id)).toHaveLength(1)
  })

  it('rejects foreign bucket IDs and duplicate message IDs before recording anything', async () => {
    const t = setup()
    const victim = t.bugs.record({ spaceId: t.b.id, chatId: 'chat-b', messageId: 'foreign-message', title: 'private issue', text: 'private report' }).bucket
    const mine = t.bugs.record({ spaceId: t.a.id, chatId: 'chat-a', title: 'own issue', text: 'own report' }).bucket
    const body = { title: 'new issue', text: 'new report' }
    await expect(t.call('bug/record', { ...body, bucket_id: victim.id })).rejects.toMatchObject({ status: 404 })
    await expect(t.call('bug/record', { ...body, message_id: 'foreign-message' })).rejects.toMatchObject({ status: 404 })
    await expect(t.call('bug/record', { ...body, bucket_id: mine.id, message_id: 'foreign-message' })).rejects.toMatchObject({ status: 404 })
    expect(t.bugs.get(victim.id)).toEqual(victim)
    expect(t.bugs.get(mine.id)).toEqual(mine)
    expect(t.bugs.list(t.a.id)).toHaveLength(1)
  })

  it('keeps same-space recording, idempotency and state changes working', async () => {
    const t = setup()
    const body = { title: 'own issue', text: 'own report', message_id: 'own-message' }
    const first = await t.call('bug/record', body)
    const repeated = await t.call('bug/record', body)
    expect(repeated).toMatchObject({ duplicate: true, bucket: { id: first.bucket.id, count: 1 } })
    await t.call('bug/record', { ...body, message_id: 'own-message-2', bucket_id: first.bucket.id })
    await expect(t.call('bug/ask', { id: first.bucket.id })).rejects.toMatchObject({ status: 400 })
    expect(t.bugs.get(first.bucket.id)?.asks).toBe(0)
    expect(await t.call('bug/update', { id: first.bucket.id, status: 'fixed' })).toMatchObject({ bucket: { spaceId: t.a.id, status: 'fixed', count: 2 } })
    expect(await t.call('bug/link_issue', { id: first.bucket.id, issue_url: 'https://github.com/test/repo/issues/1' })).toMatchObject({ bucket: { intakePhase: 'linked_issue' } })
    await expect(t.call('bug/update', { id: first.bucket.id, status: 'fixed', title: 'unapproved retitle' })).rejects.toMatchObject({ status: 409 })
    expect(t.bugs.get(first.bucket.id)?.title).toBe('own issue')
  })

  it.each(['bug/record', 'bug/update', 'bug/link_issue', 'bug/ask', 'bug/list', 'bug/similar'])('fails closed with no space or capability permission in %s', async (path) => {
    const t = setup()
    const own = t.bugs.record({ spaceId: t.a.id, chatId: 'chat-a', title: 'own issue', text: 'report' }).bucket
    const body = { id: own.id, title: 'own issue', text: 'report', issue_url: 'https://example.test/issues/1' }
    await expect(t.call(path, body, { ...t.cap, spaceId: undefined })).rejects.toMatchObject({ status: 403 })
    await expect(t.call(path, body, { ...t.cap, scopes: [] })).rejects.toMatchObject({ status: 403 })
    expect(t.bugs.get(own.id)).toEqual(own)
  })
})

describe('attachment source validation', () => {
  it.each(['chat-b', undefined])('does not cache or download an uncached message from %s', async (chatId) => {
    const t = setup()
    t.feishu.messages.set('file-1', historyMsg({ text: '[文件] report.txt', messageId: 'file-1', chatId, fileKey: 'resource-1', fileName: 'report.txt', msgType: 'file' }))
    await expect(t.call('message/file', { message_id: 'file-1' })).rejects.toMatchObject({ status: 403 })
    expect(t.messageCache.get('file-1')).toBeUndefined()
    expect(t.feishu.downloads).toHaveLength(0)
  })

  it('validates cached messages against their recorded source too', async () => {
    const t = setup()
    t.messageCache.upsert('chat-b', [historyMsg({ text: '[文件] report.txt', messageId: 'file-1', fileKey: 'resource-1', msgType: 'file' })])
    const get = vi.spyOn(t.feishu, 'getMessage')
    await expect(t.call('message/file', { message_id: 'file-1' })).rejects.toMatchObject({ status: 403 })
    expect(t.feishu.downloads).toHaveLength(0)
    expect(get).not.toHaveBeenCalled()
  })

  it('downloads an allowed uncached message and preserves its actual circle chat', async () => {
    const t = setup()
    t.circles.join('chat-a', 'shared', 'alice')
    t.circles.join('chat-b', 'shared', 'bob')
    t.feishu.messages.set('file-1', historyMsg({ text: '[文件] report.txt', messageId: 'file-1', chatId: 'chat-b', fileKey: 'resource-1', fileName: 'report.txt', msgType: 'file' }))
    expect(await t.call('message/file', { message_id: 'file-1' })).toMatchObject({ file_name: 'report.txt' })
    expect(t.messageCache.get('file-1')?.chatId).toBe('chat-b')
    expect(t.feishu.downloads).toHaveLength(1)
  })

  it('rejects a private caller who does not belong to the source group', async () => {
    const t = setup()
    t.feishu.chats = [{ chatId: 'chat-b', name: 'other group' }]
    t.feishu.members.set('chat-b', new Set(['bob']))
    t.feishu.messages.set('file-1', historyMsg({ text: '[文件] report.txt', messageId: 'file-1', chatId: 'chat-b', fileKey: 'resource-1', msgType: 'file' }))
    await expect(t.call('message/file', { message_id: 'file-1' }, { ...t.cap, chatId: 'dm-alice', chatType: 'p2p' })).rejects.toMatchObject({ status: 403 })
    expect(t.messageCache.get('file-1')).toBeUndefined()
    expect(t.feishu.downloads).toHaveLength(0)
  })
})

describe('selfcheck capability forwarding', () => {
  function abilities() {
    const empty = async () => ''
    return { status: empty, report: empty, wiki: empty, handover: empty, groups: empty, pmo: empty, settings: empty, explain: () => '', selfcheck: vi.fn(async () => 'scoped result') }
  }

  it('passes the authenticated space and actor to the selfcheck ability', async () => {
    const a = abilities()
    const t = setup(a)
    expect(await t.call('ability', { what: 'selfcheck', args: '7' })).toEqual({ text: 'scoped result' })
    expect(a.selfcheck).toHaveBeenCalledWith({ sessionKey: t.cap.sessionKey, chatId: t.cap.chatId, chatType: 'group', spaceId: t.a.id, requesterOpenId: 'alice' }, '7')
  })

  it('does not call the ability with missing scope, space or private identity', async () => {
    const a = abilities()
    const t = setup(a)
    for (const cap of [{ ...t.cap, scopes: [] }, { ...t.cap, spaceId: undefined }, { ...t.cap, chatType: 'p2p' as const, requesterOpenId: undefined }]) {
      await expect(t.call('ability', { what: 'selfcheck' }, cap)).rejects.toMatchObject({ status: 403 })
    }
    expect(a.selfcheck).not.toHaveBeenCalled()
  })
})

describe('automatic sessions have narrower write capabilities', () => {
  it('cannot turn read access into ability writes even if the ability would allow them', async () => {
    const invoke = vi.fn(async () => 'would write')
    const abilities = { status: invoke, report: invoke, wiki: invoke, handover: invoke, groups: invoke, pmo: invoke, settings: invoke, explain: () => '', selfcheck: invoke }
    const t = setup(abilities)
    for (const scopes of [['todo:read', 'memory:read'], [...PROACTIVE_SCOPES]]) {
      const actor = { ...t.cap, requesterOpenId: undefined, scopes }
      for (const body of [
        { what: 'settings', args: 'note change configuration' },
        { what: 'pmo', args: 'init' },
        { what: 'pmo', args: 'bind https://example.test/base/new' },
        { what: 'pmo', args: 'sync' },
        { what: 'report' }, { what: 'wiki' }, { what: 'handover' },
      ]) await expect(t.call('ability', body, actor)).rejects.toMatchObject({ status: 403 })
    }
    expect(invoke).not.toHaveBeenCalled()
    for (const what of ['status', 'settings', 'pmo']) {
      expect(await t.call('ability', { what }, { ...t.cap, scopes: ['todo:read', 'memory:read'] })).toEqual({ text: 'would write' })
    }
    for (const scopes of [[...ALL_SCOPES], [...GROUP_SCOPES]]) {
      for (const [what, args] of [['settings', 'note change'], ['pmo', 'sync'], ['report', ''], ['wiki', ''], ['handover', '']]) {
        expect(await t.call('ability', { what, args }, { ...t.cap, scopes })).toEqual({ text: 'would write' })
      }
    }
  })

  it('proactive assessment cannot record business state even with an otherwise authorized actor', async () => {
    const t = setup()
    const proactive = { ...t.cap, scopes: [...PROACTIVE_SCOPES] }
    for (const [path, body] of [
      ['bug/record', { title: 'observed issue', text: 'first report', message_id: 'observed-message-1' }],
      ['todo/add', { title: 'not delegated' }],
      ['memory/save', { text: 'not delegated' }],
      ['bug/update', { id: 1, status: 'fixed' }],
      ['bug/link_issue', { id: 1, issue_url: 'https://example.test/issues/1' }],
      ['bug/ask', { id: 1 }],
    ] as const) {
      await expect(t.call(path, body, proactive)).rejects.toMatchObject({ status: 403 })
    }
    expect(t.bugs.get(1)).toBeUndefined()
  })

  it('round-trips the memory restriction in signed tokens', () => {
    const t = setup()
    const issuer = new TokenIssuer('test-secret')
    const token = issuer.issue({ ...t.cap, memoryWritePolicy: { candidateIds: [1, 2] } })
    expect(issuer.verify(token)?.memoryWritePolicy).toEqual({ candidateIds: [1, 2] })
  })

  it('only replaces listed current candidates and keeps replacements unconfirmed', async () => {
    const t = setup()
    const scope = `space:${t.a.id}`
    const candidate = t.memory.add({ scope, kind: 'fact', title: 'candidate', body: 'original', status: 'candidate' })
    const confirmed = t.memory.add({ scope, kind: 'fact', title: 'confirmed', body: 'human fact', status: 'confirmed', confirmation: { by: 'alice', messageId: 'confirm-original', at: 1 } })
    const cap = { ...t.cap, memoryWritePolicy: { candidateIds: [candidate.id, confirmed.id] } }
    const result = await t.call('memory/save', { title: 'merged', body: 'improved', replaces: candidate.id, certainty: 'confirmed' }, cap)
    expect(result.note).toMatchObject({ status: 'candidate', scope })
    expect(t.memory.get(candidate.id)).toMatchObject({ status: 'superseded', supersededBy: result.note.id })
    expect(t.memory.get(confirmed.id)).toEqual(confirmed)
    await expect(t.call('memory/save', { title: 'again', body: 'again', replaces: candidate.id }, cap)).rejects.toMatchObject({ status: 403 })
  })

  it('rejects new notes, promotions, confirmed, foreign and unlisted candidates before writing', async () => {
    const t = setup()
    const scope = `space:${t.a.id}`
    const confirmed = t.memory.add({ scope, kind: 'fact', title: 'confirmed', body: 'human fact', status: 'confirmed', confirmation: { by: 'alice', messageId: 'confirm-original', at: 1 } })
    const candidate = t.memory.add({ scope, kind: 'fact', title: 'candidate', body: 'local candidate', status: 'candidate' })
    const unlisted = t.memory.add({ scope, kind: 'fact', title: 'unlisted', body: 'not in batch', status: 'candidate' })
    const foreign = t.memory.add({ scope: `space:${t.b.id}`, kind: 'fact', title: 'foreign', body: 'other space', status: 'candidate' })
    const cap = { ...t.cap, memoryWritePolicy: { candidateIds: [confirmed.id, candidate.id, foreign.id] } }
    const save = { title: 'new', body: 'body' }
    for (const body of [save, { ...save, replaces: confirmed.id }, { ...save, replaces: foreign.id }, { ...save, replaces: unlisted.id }, { ...save, replaces: candidate.id, share: 'org' }]) {
      await expect(t.call('memory/save', body, cap)).rejects.toMatchObject({ status: 403 })
    }
    for (const id of [confirmed.id, foreign.id, unlisted.id]) {
      await expect(t.call('memory/forget', { id }, cap)).rejects.toMatchObject({ status: 403 })
    }
    for (const note of [confirmed, candidate, unlisted, foreign]) expect(t.memory.get(note.id)).toEqual(note)
    expect(t.memory.count(scope)).toBe(3)
  })

  it('keeps a confirmed record under correction: it cannot be deleted until the person decides on the new version', async () => {
    const t = setup()
    const scope = `space:${t.a.id}`
    const original = t.memory.add({ scope, kind: 'rule', title: '个人偏好', body: '周五下午写周报', status: 'confirmed', confirmation: { by: 'alice', messageId: 'said-it', at: 1 } })
    const correction = t.memory.add({ scope, kind: 'rule', title: '个人偏好', body: '周四下午写周报', status: 'candidate', replaces: original.id })
    // The correction does not replace the confirmed record before the person confirms it, and deleting the old one is refused.
    expect(t.memory.get(original.id)?.status).toBe('confirmed')
    await expect(t.call('memory/forget', { id: original.id })).rejects.toMatchObject({ status: 409 })
    expect(t.memory.get(original.id)?.status).toBe('confirmed')
    // Once the candidate is gone, the old record can be forgotten when the person asks.
    expect(await t.call('memory/forget', { id: correction.id })).toMatchObject({ ok: true })
    expect(await t.call('memory/forget', { id: original.id })).toMatchObject({ ok: true })
  })

  it('rechecks candidate status after token issuance and permits deleting only remaining candidates', async () => {
    const t = setup()
    const scope = `space:${t.a.id}`
    const changed = t.memory.add({ scope, kind: 'fact', title: 'changed', body: 'candidate', status: 'candidate' })
    const kept = t.memory.add({ scope, kind: 'fact', title: 'kept', body: 'candidate', status: 'candidate' })
    const cap = { ...t.cap, memoryWritePolicy: { candidateIds: [changed.id, kept.id] } }
    t.memory.confirm(changed.id, scope, { by: 'alice', messageId: 'confirm-current' })
    await expect(t.call('memory/forget', { id: changed.id }, cap)).rejects.toMatchObject({ status: 403 })
    await expect(t.call('memory/save', { title: 'overwrite', body: 'body', replaces: changed.id }, cap)).rejects.toMatchObject({ status: 403 })
    expect(await t.call('memory/forget', { id: kept.id }, cap)).toMatchObject({ ok: true })
    expect(t.memory.get(kept.id)).toBeUndefined()
    expect(t.memory.get(changed.id)?.status).toBe('confirmed')
  })
})

describe('HTTP dispatch enforces the current execution phase', () => {
  it('rejects reusing a signed token for another actor or an idle session', async () => {
    let current: { requesterOpenId?: string; runId: string } | undefined = { requesterOpenId: 'alice', runId: 'run-current' }
    const resolveActor = vi.fn(() => current)
    const empty = async () => ''
    const configure = vi.fn(async (actor: AbilityActor): Promise<string> => {
      return t.policy.decide({ spaceId: actor.spaceId!, openId: actor.requesterOpenId, action: 'configure' }).decision
    })
    const abilities = { status: empty, report: empty, wiki: empty, handover: empty, groups: empty, pmo: configure, settings: configure, explain: () => '', selfcheck: empty }
    const t = setup(abilities, undefined, resolveActor)
    t.spaces.addMember(t.a.id, 'bob', 'member')
    const token = t.tokens.issue(t.cap)
    const request = await t.http()
    for (const what of ['settings', 'pmo']) {
      const body = { what, args: what === 'settings' ? 'note change config' : 'sync', requesterOpenId: 'alice', openId: 'alice', actor: { requesterOpenId: 'alice' } }
      for (const [actor, decision] of [
        [{ requesterOpenId: 'alice' }, 'allow'],
        [{ requesterOpenId: 'bob' }, 'deny'],
        [{}, 'deny'],
      ] as const) {
        current = { ...actor, runId: 'run-current' }
        const before = configure.mock.calls.length
        const res = await request('ability', body, t.cap, token)
        if (decision === 'deny') {
          expect(res.status).toBe(403)
          await res.json()
          expect(configure).toHaveBeenCalledTimes(before)
          continue
        }
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ text: decision })
        expect(configure.mock.lastCall?.[0].requesterOpenId).toBe('requesterOpenId' in actor ? actor.requesterOpenId : undefined)
      }
      current = undefined
      const before = configure.mock.calls.length
      const idle = await request('ability', body, t.cap, token)
      expect(idle.status).toBe(403)
      await idle.json()
      expect(configure).toHaveBeenCalledTimes(before)
    }
    expect(resolveActor).toHaveBeenCalledWith(t.cap.sessionKey)
  })

  it('rejects tokens without an explicit valid scope list', async () => {
    const t = setup()
    const request = await t.http()
    for (const scopes of [undefined, null, 'memory:read', [123]]) {
      const actor = { ...t.cap, scopes: scopes as unknown as string[] }
      expect(t.tokens.verify(t.tokens.issue(actor))).toBeUndefined()
      const res = await request('memory/search', {}, actor)
      expect(res.status).toBe(401)
      await res.json()
    }
    const empty = await request('memory/search', {}, { ...t.cap, scopes: [] })
    expect(empty.status).toBe(403)
    await empty.json()
  })

  it('checks the live session restriction even when a token grants the requested tool', async () => {
    let allowed: readonly string[] | undefined
    const hook = vi.fn(() => allowed)
    const hostDelivery = vi.fn<NonNullable<InternalApiDeps['deliverToolResult']>>(async () => ({ messageId: 'host-dm-receipt' }))
    const t = setup(undefined, hook, () => ({ requesterOpenId: 'alice', runId: 'foreground-run' }), hostDelivery)
    const request = await t.http()
    allowed = ['POST /v1/memory/search']
    const denied = await request('dm', { text: 'must not send' })
    expect(denied.status).toBe(403)
    await denied.json()
    expect(t.feishu.sent).toHaveLength(0)
    expect(hostDelivery).not.toHaveBeenCalled()
    const readable = await request('memory/search', {})
    expect(readable.status).toBe(200)
    await readable.json()
    expect(hook).toHaveBeenCalledWith(t.cap.sessionKey)

    allowed = []
    const allDenied = await request('memory/search', {})
    expect(allDenied.status).toBe(403)
    await allDenied.json()

    allowed = undefined
    const restored = await request('dm', { text: 'foreground message' })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toEqual({ ok: true, message_id: 'host-dm-receipt', to: 'alice' })
    expect(hostDelivery).toHaveBeenCalledExactlyOnceWith(t.cap.sessionKey, 'foreground-run', { kind: 'message', text: 'foreground message' })
    expect(t.feishu.sent).toHaveLength(0)
  })

  it('limits consolidation to memory routes, including routes with no scope check or shared memory scope', async () => {
    const t = setup()
    const request = await t.http()
    const actor = { ...t.cap, memoryWritePolicy: { candidateIds: [] } }
    for (const [path, body] of [
      ['ability', { what: 'settings', args: 'note unrelated mutation' }],
      ['whois', { github_login: 'someone' }],
      ['dm', { text: 'must not send' }],
      ['todo/add', { title: 'must not create' }],
    ] as const) {
      const res = await request(path, body, actor)
      expect(res.status).toBe(403)
      await res.json()
    }
    const readable = await request('memory/search', {}, actor)
    expect(readable.status).toBe(200)
    await readable.json()
    expect(t.feishu.sent).toHaveLength(0)
  })

  it('intersects token and phase restrictions rather than letting either override the other', async () => {
    const t = setup(undefined, () => ['POST /v1/todo/list'])
    const request = await t.http()
    const actor = { ...t.cap, memoryWritePolicy: { candidateIds: [] } }
    for (const path of ['todo/list', 'memory/search']) {
      const res = await request(path, {}, actor)
      expect(res.status).toBe(403)
      await res.json()
    }
  })
})
