import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { BugQuestions, type BugQuestion, type BugQuestionInput } from '../src/core/bug-questions.js'
import { Bugs } from '../src/core/bugs.js'
import { DeliveryService } from '../src/core/delivery.js'
import { Registry } from '../src/core/registry.js'
import { FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

function setup(path = ':memory:') {
  const registry = new Registry(path)
  cleanups.push(() => registry.close())
  const bugs = new Bugs(registry.db)
  const questions = new BugQuestions(registry.db, bugs)
  const sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat_a', openId: 'alice' })
  const bucket = bugs.record({ spaceId: space.id, chatId: 'chat_a', title: '合成反馈', text: '仅测试，无真实业务信息' }).bucket
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat_a', chatType: 'group', cwd: '/synthetic', requesterOpenId: 'alice', rootMessageId: 'origin', threadId: 'thread_a' })
  const feishu = new FakeFeishu()
  const input = (messageId = 'origin', patch: Partial<BugQuestionInput> = {}): BugQuestionInput => {
    const task = registry.createTaskOnce({ sessionKey: 'session-a', messageId, requesterOpenId: 'alice', prompt: `真实合成请求 ${messageId}` }).task
    return {
      bucketId: bucket.id, spaceId: space.id, sessionKey: 'session-a', originTaskId: task.id, targetOpenId: 'alice',
      anchor: { tenantId: 'tenant_a', appId: 'app_a', chatId: 'chat_a', messageId, threadId: 'thread_a', rootId: 'origin' },
      kind: 'info', question: '发生问题前最后做了什么？', missingInfo: ['触发操作'], ...patch,
    }
  }
  const namespace = { spaceId: space.id, tenantId: 'tenant_a', appId: 'app_a', chatId: 'chat_a', targetOpenId: 'alice' }
  const send = async (q: BugQuestion, opts: { beforeAck?: () => Promise<void>; fail?: boolean; confirm?: boolean; remoteId?: string } = {}) => {
    const service = new DeliveryService(registry.db, {
      ...sp, resolveContext: async () => ({
        actorOpenId: 'alice', audience: { kind: 'group', spaceId: space.id, chatId: 'chat_a', replyToMessageId: 'origin', threadId: 'thread_a' },
        sources: [{ ref: 'synthetic-question-source', spaceId: space.id, chatId: 'chat_a' }], provenanceComplete: true, expiresAt: Date.now() + 60_000,
      }),
      send: async () => {
        const sent = await feishu.replyMarkdown('origin', q.question, false)
        await opts.beforeAck?.()
        if (opts.fail) throw new Error('synthetic lost ACK')
        return { remoteId: opts.remoteId ?? sent.messageId }
      },
      verify: opts.confirm ? async ({ remoteId }) => feishu.sent.some((s) => s.messageId === remoteId && s.target === 'origin' && s.payload === q.question) : undefined,
    })
    return service.deliver({ key: q.deliveryKey, contextRef: `question-run:${q.id}`, payload: { markdown: q.question } })
  }
  const reply = (q: BugQuestion, messageId = 'reply-1', text = '这是我的合成答复') => {
    const task = registry.createTaskOnce({ sessionKey: q.sessionKey, messageId, requesterOpenId: q.targetOpenId, prompt: text }).task
    const record = questions.acceptReply(q.id, { messageId, senderOpenId: q.targetOpenId, taskId: task.id })
    return { task, record }
  }
  return { registry, bugs, questions, ...sp, space, bucket, feishu, input, send, reply, namespace }
}

describe('bug question preparation and budget', () => {
  it('persists a namespaced anchor and stable key, deduplicating the same task without touching intake or old asks', () => {
    const t = setup(), input = t.input()
    const before = t.bugs.get(t.bucket.id)
    const first = t.questions.prepare(input)
    expect(first).toMatchObject({ bucketId: t.bucket.id, originTaskId: input.originTaskId, targetOpenId: 'alice', resolution: 'open', kind: 'info', question: input.question, missingInfo: ['触发操作'] })
    expect(first.deliveryKey).toBe(`question:${first.id}`)
    expect(t.questions.prepare(input)).toEqual(first)
    expect(new BugQuestions(t.registry.db, t.bugs).prepare(input)).toEqual(first)
    expect(t.questions.budget(t.bucket.id)).toEqual({ occupied: 1, max: 3 })
    expect(t.questions.list(t.bucket.id, t.space.id)).toEqual([first])
    expect(t.questions.listForTask(input.originTaskId)).toEqual([first])
    expect(t.questions.forTask(input.originTaskId)).toEqual([])
    expect(t.questions.getAnchor(first.anchorId)).toMatchObject({ bucketId: t.bucket.id, tenantId: 'tenant_a', appId: 'app_a', chatId: 'chat_a', messageId: input.anchor.messageId, threadId: 'thread_a' })
    expect(t.bugs.get(t.bucket.id)).toEqual(before)
  })

  it.each(['question', 'missingInfo', 'targetOpenId', 'anchor'] as const)('rejects changed %s for a task already bound to a question', (field) => {
    const t = setup(), input = t.input()
    const first = t.questions.prepare(input)
    const changed = { ...input }
    if (field === 'question') changed.question = '另一个问题'
    if (field === 'missingInfo') changed.missingInfo = ['版本']
    if (field === 'targetOpenId') changed.targetOpenId = 'bob'
    if (field === 'anchor') changed.anchor = { ...input.anchor, threadId: 'another_thread' }
    expect(() => t.questions.prepare(changed)).toThrow()
    expect(t.questions.get(first.id)).toEqual(first)
    expect(t.bugs.anchors(t.bucket.id, t.space.id)).toHaveLength(1)
  })

  it('refuses decision and foreign/system origins before creating an anchor or reserving budget', () => {
    const t = setup(), input = t.input()
    const system = t.registry.createTask({ sessionKey: input.sessionKey, messageId: 'system-trigger', requesterOpenId: 'alice', prompt: '不是用户消息' })
    for (const bad of [
      { ...input, kind: 'decision' },
      { ...input, spaceId: 'other-space' },
      { ...input, originTaskId: system.id, anchor: { ...input.anchor, messageId: system.messageId } },
      { ...input, targetOpenId: 'bob' },
      { ...input, anchor: { ...input.anchor, chatId: 'other-chat' } },
    ]) expect(() => t.questions.prepare(bad as BugQuestionInput)).toThrow()
    expect(t.questions.list(t.bucket.id, t.space.id)).toEqual([])
    expect(t.bugs.anchors(t.bucket.id, t.space.id)).toEqual([])
    expect(t.questions.budget(t.bucket.id)).toEqual({ occupied: 0, max: 3 })
    expect(() => t.questions.list(t.bucket.id, 'other-space')).toThrow()
  })

  it('permits only one open question even from another task and releases a definitely unsent cancellation', () => {
    const t = setup()
    const first = t.questions.prepare(t.input('origin-a'))
    const next = t.input('origin-b')
    expect(() => new BugQuestions(t.registry.db, t.bugs).prepare(next)).toThrow('已有未处理')
    t.questions.cancel(first.id)
    expect(t.questions.budget(t.bucket.id).occupied).toBe(0)
    expect(t.questions.prepare(next)).toMatchObject({ originTaskId: next.originTaskId, resolution: 'open' })
    expect(t.questions.prepare(t.input('origin-a')).resolution).toBe('cancelled')
  })

  it('counts historical asks without inventing historical questions or exceeding three occupied slots', async () => {
    const t = setup()
    t.bugs.tryAsk(t.bucket.id); t.bugs.tryAsk(t.bucket.id)
    expect(t.questions.list(t.bucket.id, t.space.id)).toEqual([])
    const q = t.questions.prepare(t.input())
    await t.send(q)
    t.questions.cancel(q.id)
    expect(t.questions.budget(t.bucket.id)).toEqual({ occupied: 3, max: 3 })
    expect(t.bugs.get(t.bucket.id)?.asks).toBe(2)
    expect(() => t.questions.prepare(t.input('fourth-attempt'))).toThrow('额度已用完')
    expect(t.feishu.sent).toHaveLength(1)
  })

  it.each(['sent', 'confirmed', 'unknown'] as const)('keeps the reservation for a cancelled %s delivery', async (status) => {
    const t = setup(), q = t.questions.prepare(t.input())
    if (status === 'unknown') await expect(t.send(q, { fail: true })).rejects.toMatchObject({ code: 'unknown' })
    else expect((await t.send(q, { confirm: status === 'confirmed' })).status).toBe(status)
    t.questions.cancel(q.id)
    expect(t.questions.budget(t.bucket.id)).toEqual({ occupied: 1, max: 3 })
    expect(t.registry.db.prepare('SELECT status FROM deliveries WHERE delivery_key = ?').get(q.deliveryKey)).toMatchObject({ status })
  })

  it('stops after three persisted deliveries and still reuses the exact earlier question at the limit', async () => {
    const t = setup()
    const inputs: BugQuestionInput[] = [], rows: BugQuestion[] = []
    for (const status of ['sent', 'unknown', 'confirmed']) {
      const input = t.input(`origin-${status}`), q = t.questions.prepare(input)
      inputs.push(input); rows.push(q)
      if (status === 'unknown') await expect(t.send(q, { fail: true })).rejects.toMatchObject({ code: 'unknown' })
      else await t.send(q, { confirm: status === 'confirmed' })
      t.questions.cancel(q.id)
    }
    expect(t.questions.budget(t.bucket.id)).toEqual({ occupied: 3, max: 3 })
    expect(t.questions.prepare(inputs[0]!)).toMatchObject({ id: rows[0]!.id, resolution: 'cancelled' })
    expect(() => t.questions.prepare(t.input('origin-fourth'))).toThrow('额度已用完')
    expect(t.questions.list(t.bucket.id, t.space.id)).toHaveLength(3)
    expect(t.feishu.sent).toHaveLength(3)
  })

  it('keeps planned occupied and a late ACK cannot reopen the cancelled question', async () => {
    const t = setup(), q = t.questions.prepare(t.input())
    const entered = deferred(), release = deferred()
    const sending = t.send(q, { beforeAck: async () => { entered.resolve(); await release.promise } })
    await entered.promise
    expect(t.questions.unsettled(t.namespace)).toEqual([q])
    expect(t.questions.cancelForTask(q.originTaskId)).toBe(1)
    expect(t.questions.budget(q.bucketId).occupied).toBe(1)
    expect(t.questions.unsettled(t.namespace)).toEqual([])
    release.resolve()
    const sent = await sending
    expect(t.questions.get(q.id)?.resolution).toBe('cancelled')
    expect(t.questions.findForReply({ ...t.namespace, parentId: sent.remoteId! })).toBeUndefined()
    expect(t.questions.findForReply({ ...t.namespace, parentId: sent.remoteId!, includeCancelled: true })?.id).toBe(q.id)
  })

  it('recovers only unsent open reservations without altering already sent or unknown deliveries', async () => {
    const t = setup()
    const first = t.questions.prepare(t.input())
    // 初始化阶段甚至还没有 deliveries 表，仍可恢复未发送预占。
    expect(t.questions.recoverUnsent()).toBe(1)
    expect(t.questions.get(first.id)?.resolution).toBe('cancelled')
    expect(t.questions.budget(t.bucket.id).occupied).toBe(0)
    const sent = t.questions.prepare(t.input('sent'))
    await t.send(sent)
    expect(t.questions.recoverUnsent()).toBe(0)
    t.questions.cancel(sent.id)
    const unknown = t.questions.prepare(t.input('unknown'))
    await expect(t.send(unknown, { fail: true })).rejects.toMatchObject({ code: 'unknown' })
    expect(t.questions.recoverUnsent()).toBe(0)
    expect(t.questions.get(unknown.id)?.resolution).toBe('open')
    expect(t.questions.budget(t.bucket.id).occupied).toBe(2)
  })

  it('rolls anchor creation back if question insertion fails, and can join a caller transaction', () => {
    const t = setup(), input = t.input()
    t.registry.db.exec("CREATE TRIGGER fail_question BEFORE INSERT ON bug_questions BEGIN SELECT RAISE(ABORT, 'synthetic question failure'); END")
    expect(() => t.questions.prepare(input)).toThrow('synthetic question failure')
    expect(t.bugs.anchors(t.bucket.id, t.space.id)).toEqual([])
    expect(t.questions.budget(t.bucket.id).occupied).toBe(0)
    t.registry.db.exec('DROP TRIGGER fail_question; SAVEPOINT outer_question')
    t.questions.prepare(input)
    t.registry.db.exec('ROLLBACK TO outer_question; RELEASE outer_question')
    expect(t.questions.list(t.bucket.id, t.space.id)).toEqual([])
    expect(t.bugs.anchors(t.bucket.id, t.space.id)).toEqual([])
  })
})

describe('real question replies', () => {
  it('finds only the exact sent message and namespace, independent of session aliases', async () => {
    const t = setup(), q = t.questions.prepare(t.input())
    expect(t.questions.findForReply({ ...t.namespace, parentId: 'not-sent' })).toBeUndefined()
    const sent = await t.send(q)
    t.registry.createSession({ sessionKey: 'unrelated', chatId: 'chat_a', chatType: 'group', cwd: '/synthetic/other', requesterOpenId: 'alice' })
    t.registry.addAlias(`thread:thread_a`, 'unrelated')
    t.registry.addAlias(sent.remoteId!, 'unrelated')
    expect(t.questions.findForReply({ ...t.namespace, parentId: sent.remoteId! })).toEqual(q)
    for (const key of ['spaceId', 'tenantId', 'appId', 'chatId', 'targetOpenId', 'parentId'] as const) {
      expect(t.questions.findForReply({ ...t.namespace, parentId: sent.remoteId!, [key]: 'wrong' }), key).toBeUndefined()
    }
  })

  it('keeps unknown deliveries unsettled and refuses to guess a reply before a real ACK', async () => {
    const t = setup(), q = t.questions.prepare(t.input())
    await expect(t.send(q, { fail: true })).rejects.toMatchObject({ code: 'unknown' })
    expect(t.questions.unsettled(t.namespace)).toEqual([q])
    for (const key of ['spaceId', 'tenantId', 'appId', 'chatId', 'targetOpenId'] as const) expect(t.questions.unsettled({ ...t.namespace, [key]: 'wrong' })).toEqual([])
    expect(t.questions.findForReply({ ...t.namespace, parentId: t.feishu.sent[0]!.messageId })).toBeUndefined()
    expect(() => t.reply(q)).toThrow('尚无真实发送回执')
    expect(t.questions.replies(q.id)).toEqual([])
  })

  it('does not pick the first question if the same remote ID ambiguously matches two cases', async () => {
    const t = setup(), first = t.questions.prepare(t.input())
    const other = t.bugs.record({ spaceId: t.space.id, chatId: 'chat_a', title: '另一合成案件', text: '另一问题' }).bucket
    const second = t.questions.prepare(t.input('other-origin', { bucketId: other.id }))
    await t.send(first, { remoteId: 'same-remote-id' })
    await t.send(second, { remoteId: 'same-remote-id' })
    expect(t.questions.findForReply({ ...t.namespace, parentId: 'same-remote-id' })).toBeUndefined()
  })

  it('keeps multiple original replies on Tasks and links each message once without auto-answering', async () => {
    const t = setup(), q = t.questions.prepare(t.input())
    await t.send(q)
    const first = t.reply(q, 'reply-a', '我暂时不提供日志')
    const second = t.reply(q, 'reply-b', '后来找到了一个合成片段')
    expect(t.questions.acceptReply(q.id, { messageId: first.task.messageId, senderOpenId: 'alice', taskId: first.task.id })).toEqual(first.record)
    expect(t.questions.replies(q.id)).toEqual([first.record, second.record])
    expect(first.record).toMatchObject({ outcome: 'pending', resolvedAt: null })
    expect(t.questions.get(q.id)?.resolution).toBe('open')
    expect(t.registry.getTask(first.task.id)?.prompt).toBe('我暂时不提供日志')
    expect(t.registry.getTask(second.task.id)?.prompt).toBe('后来找到了一个合成片段')
    expect(JSON.stringify(t.registry.db.prepare('SELECT * FROM bug_question_replies').all())).not.toContain('后来找到了')
    expect(t.questions.forTask(second.task.id)).toEqual([{ question: q, reply: second.record }])
    expect(t.questions.forTask(q.originTaskId)).toEqual([])
  })

  it('requires a real reply receipt, same session, target sender, and unique question association', async () => {
    const t = setup(), q = t.questions.prepare(t.input())
    await t.send(q)
    expect(() => t.questions.acceptReply(q.id, { messageId: 'origin', senderOpenId: 'alice', taskId: q.originTaskId })).toThrow('提问后')
    const system = t.registry.createTask({ sessionKey: q.sessionKey, messageId: 'system', requesterOpenId: 'alice', prompt: '系统文字' })
    const foreignPerson = t.registry.createTaskOnce({ sessionKey: q.sessionKey, messageId: 'bob-msg', requesterOpenId: 'bob', prompt: '其他人' }).task
    t.registry.createSession({ sessionKey: 'different-session', chatId: 'chat_a', chatType: 'group', cwd: '/synthetic', requesterOpenId: 'alice' })
    const otherSession = t.registry.createTaskOnce({ sessionKey: 'different-session', messageId: 'elsewhere', requesterOpenId: 'alice', prompt: '同人另一事项' }).task
    for (const [task, sender] of [[system, 'alice'], [foreignPerson, 'bob'], [otherSession, 'alice']] as const) {
      expect(() => t.questions.acceptReply(q.id, { messageId: task.messageId, senderOpenId: sender, taskId: task.id })).toThrow()
    }
    const other = t.bugs.record({ spaceId: t.space.id, chatId: 'chat_a', title: '另案', text: '合成' }).bucket
    const otherQuestion = t.questions.prepare(t.input('other-case', { bucketId: other.id }))
    await t.send(otherQuestion)
    const first = t.reply(q)
    expect(() => t.questions.acceptReply(otherQuestion.id, { messageId: first.task.messageId, senderOpenId: 'alice', taskId: first.task.id })).toThrow('已经绑定')
    expect(t.questions.replies(otherQuestion.id)).toEqual([])
  })

  it.each(['answered', 'declined', 'unavailable'] as const)('records %s only through its own running reply task without changing intake or GitHub state', async (outcome) => {
    const t = setup()
    t.bugs.setIntake({ bucketId: t.bucket.id, spaceId: t.space.id, phase: 'awaiting_info', missingInfo: ['日志'] })
    t.bugs.linkIssue(t.bucket.id, 'https://github.com/test-org/test-repo/issues/1')
    const before = t.bugs.get(t.bucket.id)
    const q = t.questions.prepare(t.input())
    const sent = await t.send(q)
    const { task, record } = t.reply(q)
    expect(() => t.questions.resolveReply(q.id, record.id, q.originTaskId, outcome)).toThrow('当前任务')
    expect(() => t.questions.resolveReply(q.id, record.id, task.id, outcome)).toThrow('已结束或停止')
    t.registry.updateTask(task.id, { status: 'running' })
    const resolved = t.questions.resolveReply(q.id, record.id, task.id, outcome)
    expect(resolved).toMatchObject({ outcome, resolvedAt: expect.any(Number) })
    expect(t.questions.resolveReply(q.id, record.id, task.id, outcome)).toEqual(resolved)
    expect(t.questions.get(q.id)?.resolution).toBe(outcome === 'declined' ? 'declined' : 'answered')
    expect(t.bugs.get(t.bucket.id)).toEqual(before)
    expect(t.questions.findForReply({ ...t.namespace, parentId: sent.remoteId! })?.id).toBe(q.id)
    // 已回答 / 拒绝后仍可追加真实材料，旧的处理结果不被新消息覆盖。
    const later = t.reply(q, 'later-material', '补一段材料')
    expect(t.questions.replies(q.id)).toEqual([resolved, later.record])
    expect(t.questions.cancelForTask(later.task.id)).toBe(1)
    expect(t.questions.get(q.id)?.resolution).toBe('cancelled')
    expect(() => t.reply(q, 'after-stop')).toThrow('已取消')
    expect(t.questions.findForReply({ ...t.namespace, parentId: sent.remoteId! })).toBeUndefined()
    expect(t.questions.findForReply({ ...t.namespace, parentId: sent.remoteId!, includeCancelled: true })?.resolution).toBe('cancelled')
  })

  it('rolls reply/task creation back together under the caller transaction and preserves pending on resolution failure', async () => {
    const t = setup(), q = t.questions.prepare(t.input())
    await t.send(q)
    t.registry.db.exec("CREATE TRIGGER fail_reply BEFORE INSERT ON bug_question_replies BEGIN SELECT RAISE(ABORT, 'synthetic reply failure'); END; SAVEPOINT inbound")
    const task = t.registry.createTaskOnce({ sessionKey: q.sessionKey, messageId: 'atomic-reply', requesterOpenId: 'alice', prompt: '合成答复' }).task
    expect(() => t.questions.acceptReply(q.id, { messageId: task.messageId, senderOpenId: 'alice', taskId: task.id })).toThrow('synthetic reply failure')
    t.registry.db.exec('ROLLBACK TO inbound; RELEASE inbound; DROP TRIGGER fail_reply')
    expect(t.registry.taskForMessage('atomic-reply')).toBeUndefined()
    expect(t.questions.replies(q.id)).toEqual([])
    const accepted = t.reply(q)
    t.registry.updateTask(accepted.task.id, { status: 'running' })
    t.registry.db.exec("CREATE TRIGGER fail_question_resolution BEFORE UPDATE ON bug_questions BEGIN SELECT RAISE(ABORT, 'synthetic resolution failure'); END")
    expect(() => t.questions.resolveReply(q.id, accepted.record.id, accepted.task.id, 'answered')).toThrow('synthetic resolution failure')
    expect(t.questions.replies(q.id)).toEqual([accepted.record])
    expect(t.questions.get(q.id)?.resolution).toBe('open')
  })

  it('does not cancel an unrelated case and cannot resolve a stopped reply task', async () => {
    const t = setup(), q = t.questions.prepare(t.input())
    const other = t.bugs.record({ spaceId: t.space.id, chatId: 'chat_a', title: '另一案', text: '合成' }).bucket
    const untouched = t.questions.prepare(t.input('untouched', { bucketId: other.id }))
    await t.send(q)
    const { task, record } = t.reply(q)
    t.registry.updateTask(task.id, { status: 'running' })
    t.registry.requestStop(task.id)
    expect(() => t.questions.resolveReply(q.id, record.id, task.id, 'answered')).toThrow('已结束或停止')
    expect(t.questions.cancelForTask(task.id)).toBe(1)
    expect(t.questions.get(untouched.id)).toEqual(untouched)
    expect(t.questions.replies(q.id)).toEqual([record])
  })

  it('reopens persistent question/reply relations without replaying a worker or a message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-bug-questions-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const t = setup(join(dir, 'state.sqlite'))
    const q = t.questions.prepare(t.input())
    const sent = await t.send(q)
    const { task, record } = t.reply(q, 'kept-reply', '保留在真实任务里的原话')
    const reopened = new Registry(join(dir, 'state.sqlite'))
    cleanups.push(() => reopened.close())
    const store = new BugQuestions(reopened.db, new Bugs(reopened.db))
    expect(store.get(q.id)).toEqual(q)
    expect(store.findForReply({ ...t.namespace, parentId: sent.remoteId! })).toEqual(q)
    expect(store.forTask(task.id)).toEqual([{ question: q, reply: record }])
    expect(store.recoverUnsent()).toBe(0)
    expect(reopened.getTask(task.id)?.status).toBe('queued')
    expect(reopened.getTask(task.id)?.prompt).toBe('保留在真实任务里的原话')
    expect(t.feishu.sent).toHaveLength(1)
  })

  it('reads current case state and exact historical Task text without writes or cross-space access, marking lost sources null', async () => {
    const t = setup()
    const originalText = '原始请求：刷新后已经恢复。只核查已知线索，不要假定仍能复现。'
    t.registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'origin', requesterOpenId: 'alice', prompt: originalText })
    const input = t.input()
    const q = t.questions.prepare(input)
    await t.send(q)
    const answerText = '我没有日志，并不是不愿提供。\n补充：版本 synthetic-1。'
    const { task, record } = t.reply(q, 'context-reply', answerText)
    t.registry.updateTask(task.id, { status: 'running' })
    t.questions.resolveReply(q.id, record.id, task.id, 'unavailable')
    t.bugs.setIntake({ bucketId: q.bucketId, spaceId: q.spaceId, phase: 'awaiting_info', missingInfo: ['日志'], note: '已核对版本，缺日志仍待验证' })
    const issueUrl = 'https://github.com/test-org/test-repo/issues/17'
    t.bugs.linkIssue(q.bucketId, issueUrl)
    const before = t.registry.db.prepare('SELECT total_changes() AS n').get()
    const context = t.questions.readContext(q.bucketId, q.spaceId)
    expect(context.bucket).toMatchObject({ intakePhase: 'linked_issue', issueUrl, missingInfo: ['日志'], note: '已核对版本，缺日志仍待验证' })
    expect(context.questions).toEqual([expect.objectContaining({
      id: q.id, resolution: 'answered', missingInfo: ['触发操作'],
      origin: { taskId: q.originTaskId, messageId: input.anchor.messageId, text: originalText },
      replies: [expect.objectContaining({ id: record.id, taskId: task.id, outcome: 'unavailable', text: answerText })],
    })])
    expect(() => t.questions.readContext(q.bucketId, 'foreign-space')).toThrow('不属于当前空间')
    expect(t.registry.db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
    // 模拟旧备份缺失 Task：读取只报告缺源，不能拿问题文字或别案内容填补。
    t.registry.db.exec('PRAGMA foreign_keys = OFF')
    t.registry.db.prepare('DELETE FROM tasks WHERE id IN (?, ?)').run(q.originTaskId, task.id)
    const afterLoss = t.registry.db.prepare('SELECT total_changes() AS n').get()
    expect(t.questions.readContext(q.bucketId, q.spaceId).questions[0]).toMatchObject({
      origin: { taskId: q.originTaskId, messageId: null, text: null },
      replies: [expect.objectContaining({ id: record.id, messageId: 'context-reply', text: null })],
    })
    expect(t.registry.db.prepare('SELECT total_changes() AS n').get()).toEqual(afterLoss)
  })
})
