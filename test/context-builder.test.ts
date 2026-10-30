import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { TurnContextBuilder, type TurnContextInput } from '../src/core/context-builder.js'
import { DeliveryService } from '../src/core/delivery.js'
import { ChannelMemory } from '../src/core/memory.js'
import { circleScope } from '../src/core/circles.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { spaceScope } from '../src/core/space.js'
import { spaceDeps } from './helpers/space.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0)) close() })

function setup() {
  const registry = new Registry(':memory:')
  cleanups.push(() => registry.close())
  const memory = new ChannelMemory(registry.db), bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs)
  const sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' }), scope = spaceScope(space.id)
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', cwd: '/synthetic', requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'origin-a', requesterOpenId: 'alice', prompt: '刷新后已经恢复，请查合成卡住问题' }).task
  const input: TurnContextInput = {
    taskId: task.id, session: { key: 'session-a', chatId: 'chat-a', chatType: 'group' },
    actor: { openId: 'alice', name: '测试小林', description: '负责人' }, space: { id: space.id, prefs: { notes: [] } },
    botName: 'Friday', chatName: '合成群 A', messageId: task.messageId, body: task.prompt, nowMs: 1_800_000_000_000,
    isFirstTurn: true, memoryScopes: [{ scope, label: '本群' }], prior: { items: [], complete: true }, excludedSources: [],
  }
  const builder = new TurnContextBuilder({ memory, registry, questions })
  const prepareReply = async () => {
    const bucket = bugs.record({ spaceId: space.id, chatId: 'chat-a', title: '合成卡住', text: task.prompt }).bucket
    const question = questions.prepare({ bucketId: bucket.id, spaceId: space.id, sessionKey: 'session-a', originTaskId: task.id,
      targetOpenId: 'alice', anchor: { tenantId: 'tenant-test', appId: 'app-test', chatId: 'chat-a', messageId: task.messageId }, kind: 'info', question: '能提供日志吗？' })
    await new DeliveryService(registry.db, {
      ...sp, resolveContext: async () => ({ actorOpenId: 'alice', audience: { kind: 'group', spaceId: space.id, chatId: 'chat-a', replyToMessageId: task.messageId },
        sources: [{ ref: task.messageId, spaceId: space.id, chatId: 'chat-a' }], provenanceComplete: true, expiresAt: Date.now() + 60_000 }),
      send: async () => ({ remoteId: 'sent-question-a' }),
    }).deliver({ key: question.deliveryKey, contextRef: 'question-a', payload: { text: question.question } })
    const replyTask = registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'reply-a', requesterOpenId: 'alice', prompt: '不导出日志；补充：只是转圈，文字还在。' }).task
    const reply = questions.acceptReply(question.id, { messageId: replyTask.messageId, senderOpenId: 'alice', taskId: replyTask.id })
    return { bucket, question, replyTask, reply, replyInput: { ...input, taskId: replyTask.id, messageId: replyTask.messageId, body: replyTask.prompt, isFirstTurn: false } }
  }
  return { ...sp, registry, memory, bugs, questions, space, scope, task, input, builder, prepareReply }
}

describe('ordinary turn context assembly from current local facts', () => {
  it('reads confirmed corrections on a warm turn and keeps candidate facts visibly unconfirmed', () => {
    const t = setup()
    const original = t.memory.add({ scope: t.scope, kind: 'rule', title: '旧偏好甲', body: '先输出长篇过程' })
    t.memory.confirm(original.id, t.scope, { by: 'alice', messageId: 'confirm-original' })
    expect(t.builder.build(t.input).prompt).toContain('旧偏好甲')
    const corrected = t.memory.add({ scope: t.scope, kind: 'rule', title: '新偏好乙', body: '仅结果与下一步', replaces: original.id })
    t.memory.confirm(corrected.id, t.scope, { by: 'alice', messageId: 'confirm-correction' })
    const candidate = t.memory.add({ scope: t.scope, kind: 'fact', title: '合成卡住暂未知原因', body: '仍待验证' })
    const next = t.builder.build({ ...t.input, isFirstTurn: false, body: '合成卡住' })
    expect(next.prompt).toContain('新偏好乙')
    expect(next.prompt).not.toContain('旧偏好甲')
    expect(next.prompt).toContain('自动记录未确认')
    expect(next.receipt.memory.notes).toContainEqual(expect.objectContaining({ id: candidate.id, status: 'candidate', scope: t.scope }))
    expect(t.memory.get(original.id)?.status).toBe('superseded')
  })

  it('includes only the actual task amendment chain, retaining original words and latest run states', () => {
    const t = setup()
    const unrelated = t.registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'other', requesterOpenId: 'alice', prompt: 'UNRELATED_WORK_CANARY' }).task
    const second = t.registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'second', requesterOpenId: 'alice', prompt: '应加手动隐藏按钮', amendsTaskId: t.task.id }).task
    const third = t.registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'third', requesterOpenId: 'alice', prompt: '补充优先级 P3', amendsTaskId: second.id }).task
    t.registry.updateTask(second.id, { status: 'cancelled', stopReason: 'steered' })
    const result = t.builder.build({ ...t.input, taskId: third.id, messageId: third.messageId, body: third.prompt, isFirstTurn: false })
    expect(result.prompt).toContain(t.task.prompt)
    expect(result.prompt).toContain(second.prompt)
    expect(result.prompt).toContain(third.prompt)
    expect(result.prompt).toContain('"run_status":"cancelled","stop_reason":"steered"')
    expect(result.prompt).not.toContain(unrelated.prompt)
  })

  it('rereads case phase, Issue, resolved refusal and original reply text for an existing bound reply', async () => {
    const t = setup(), q = await t.prepareReply()
    const before = t.builder.build(q.replyInput)
    expect(before.prompt).toContain('"outcome":"pending"')
    expect(before.prompt).toContain('"issue_url":null')
    t.registry.updateTask(q.replyTask.id, { status: 'running' })
    t.questions.resolveReply(q.question.id, q.reply.id, q.replyTask.id, 'declined')
    t.bugs.setIntake({ bucketId: q.bucket.id, spaceId: t.space.id, phase: 'awaiting_info', missingInfo: ['触发条件'] })
    t.bugs.linkIssue(q.bucket.id, 'https://github.com/test-org/test-repo/issues/7')
    const stored = t.questions.readContext(q.bucket.id, t.space.id)
    const after = t.builder.build(q.replyInput)
    expect(after.prompt).toContain('"intake_phase":"linked_issue"')
    expect(after.prompt).toContain('https://github.com/test-org/test-repo/issues/7')
    expect(after.prompt).toContain('"resolution":"declined"')
    expect(after.prompt).toContain('"outcome":"declined"')
    expect(after.prompt).toContain(t.task.prompt)
    expect(after.prompt).toContain(q.replyTask.prompt)
    expect(after.prompt).not.toContain('"outcome":"pending"')
    expect(t.questions.readContext(q.bucket.id, t.space.id)).toEqual(stored)
  })

  it('preserves history coverage gaps and downloaded attachment notes in prompt and receipt', () => {
    const t = setup(), note = '仅载入最近 60 条，更早内容未载入；卡片正文未取得。'
    const result = t.builder.build({ ...t.input, space: { ...t.input.space, prefs: { brevity: 'short', notes: ['只给下一步'] }, circle: '合成联盟' },
      circleNote: '合成联盟的可读群已由宿主核实', attachmentsNote: '本消息 files/session.jsonl 已下载；是合成片段，完整性未知。',
      prior: { items: [{ messageId: 'prior-1', chatId: 'chat-a', createTimeMs: 1_700_000_000_000, senderName: '测试小陈', msgType: 'interactive', text: '[卡片正文未取得]' }], complete: false, note },
      excludedSources: ['其他群未读取'],
    })
    expect(result.prompt).toContain(note)
    expect(result.prompt).toContain('[卡片正文未取得]')
    expect(result.prompt).toContain('files/session.jsonl')
    expect(result.prompt).toContain('完整性未知')
    expect(result.receipt).toMatchObject({ where: '群「合成群 A」', priorMessages: 1, attachments: 1, prefs: 2, circle: '合成联盟', crossSpace: [], excluded: ['其他群未读取', note] })
  })

  it('queries only host-approved memory scopes, including empty queried layers without adding another space', () => {
    const t = setup(), other = t.spaces.ensure({ kind: 'group', chatId: 'chat-b', openId: 'bob' })
    const hidden = t.memory.add({ scope: spaceScope(other.id), kind: 'rule', title: 'PRIVATE_OTHER_SPACE_CANARY', body: '不得进入本轮' })
    t.memory.confirm(hidden.id, spaceScope(other.id), { by: 'bob', messageId: 'other-confirm' })
    const result = t.builder.build(t.input)
    expect(result.prompt).not.toContain('PRIVATE_OTHER_SPACE_CANARY')
    expect(result.receipt.memory.layers).toEqual([{ scope: t.scope, label: '本群', total: 0, rules: 0, hits: 0 }])
    expect(result.memoryScopes).toEqual([t.scope])
  })

  it('refuses a bound question from another space or work instead of injecting its facts', async () => {
    const t = setup(), q = await t.prepareReply()
    expect(() => t.builder.build({ ...q.replyInput, space: { ...t.input.space, id: 'other-space' } })).toThrow('不属于当前空间或工作')
    expect(() => t.builder.build({ ...q.replyInput, session: { ...t.input.session, key: 'other-session' } })).toThrow('不属于当前空间或工作')
    expect(t.questions.get(q.question.id)?.resolution).toBe('open')
    expect(t.questions.replies(q.question.id)).toHaveLength(1)
  })

  it('host refreshes scope after attachment await without erasing the conservative accumulated source gate', async () => {
    const home = mkdtempSync(join(tmpdir(), 'friday-context-builder-'))
    const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), sp = spaceDeps(registry.db)
    const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
    sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
    sp.circles.join('chat-a', 'old-circle', 'alice')
    const feishu = new FakeFeishu(), log = createLogger('context-builder-test', 'error')
    feishu.members.set('chat-a', new Set(['alice']))
    const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: '已查看合成转发。' }] })
    const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log })
    const orchestrator = new Orchestrator({ cfg, registry, memory, ...sp, feishu: asFeishuClient(feishu), runtime, tokens: new TokenIssuer('synthetic'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
    feishu.getMessageItems = async () => {
      sp.circles.leave('chat-a')
      const note = memory.add({ scope: circleScope('old-circle'), kind: 'rule', title: 'REVOKED_CIRCLE_NEW_MEMORY', body: '授权撤销后才加入的记忆' })
      memory.confirm(note.id, circleScope('old-circle'), { by: 'alice', messageId: 'synthetic-confirmation' })
      return [{ messageId: 'forwarded-child', chatId: 'chat-a', createTimeMs: Date.now(), msgType: 'text', senderName: '测试小林', text: '本次转发原文' }]
    }
    try {
      await orchestrator.handleMessage({ eventId: 'ev-attachment', messageId: 'om-attachment', chatId: 'chat-a', chatType: 'group', msgType: 'merge_forward', text: '@Friday 看这段转发', senderOpenId: 'alice', senderType: 'user', mentions: [{ key: '@Friday', openId: 'ou_bot', name: 'Friday' }], createTimeMs: Date.now() })
      expect(state.allPrompts).toHaveLength(1)
      expect(state.allPrompts[0]!.text).toContain('本次转发原文')
      expect(state.allPrompts[0]!.text).not.toContain('REVOKED_CIRCLE_NEW_MEMORY')
      const task = registry.taskForMessage('om-attachment')!
      const manifest = JSON.parse(registry.getKv(`delivery-sources:${task.sessionKey}`)!)
      // ACP initialization had already conservatively recorded this scope. A1 must not erase it.
      expect(manifest.memoryScopes).toContain(circleScope('old-circle'))
      expect(task.status).toBe('failed')
      expect(feishu.answers()).not.toContain('已查看合成转发。')
    } finally { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) }
  })
})
