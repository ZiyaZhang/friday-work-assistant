import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { TurnContextBuilder, type TurnContextInput } from '../src/core/context-builder.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { DeliveryService } from '../src/core/delivery.js'
import { spaceDeps } from './helpers/space.js'
import { historyMsg } from './helpers/fake-feishu.js'

const registries: Registry[] = []
afterEach(() => { for (const registry of registries.splice(0)) registry.close() })
function setup() {
  const registry = new Registry(':memory:'); registries.push(registry)
  const memory = new ChannelMemory(registry.db), bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs)
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  const scope = `space:${space.id}`
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', cwd: '/synthetic/original-work', requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'original', requesterOpenId: 'alice', prompt: 'HUMAN_ORIGINAL：刷新后恢复' }).task
  const input: TurnContextInput = { taskId: task.id, session: { key: task.sessionKey, chatId: 'chat-a', chatType: 'group' },
    actor: { openId: 'alice', name: 'Alice', description: '负责人' }, space: { id: space.id, prefs: { notes: [] } }, botName: 'Friday', chatName: 'A',
    messageId: task.messageId, body: task.prompt, nowMs: Date.now(), isFirstTurn: true, memoryScopes: [{ scope, label: '本群' }],
    prior: { items: [], complete: true }, excludedSources: [], historyMode: 'rebuild' }
  return { registry, memory, bugs, questions, ...sp, space, scope, task, input, builder: new TurnContextBuilder({ registry, memory, questions }) }
}

describe('memory material supplied by the host and context reconstruction', () => {
  it('uses exactly prepared memory for prompt and receipt without an unregistered second query', () => {
    const t = setup(), note = t.memory.add({ scope: t.scope, kind: 'rule', title: 'CURRENT_RULE', body: 'short result' })
    t.memory.confirm(note.id, t.scope, { by: 'alice', messageId: 'confirmation' })
    const preparedMemory = t.memory.composeForPrompt(t.input.memoryScopes, t.input.body)
    vi.spyOn(t.memory, 'composeForPrompt').mockImplementation(() => { throw new Error('unregistered read') })
    const result = t.builder.build({ ...t.input, preparedMemory })
    expect(result.prompt).toContain('CURRENT_RULE')
    expect(result.receipt.memory).toEqual(preparedMemory.used)
    expect(result.memoryScopes).toEqual([t.scope])
    expect(t.memory.composeForPrompt).not.toHaveBeenCalled()
  })

  it('removes old app messages only on rebuild, preserving user wording and incomplete history coverage', () => {
    const t = setup(), prior = { complete: false, note: '只取得最近一页，之前尚未读取', items: [
      historyMsg({ senderType: 'app', senderName: 'Friday', text: 'OLD_ASSISTANT_MEMORY' }),
      historyMsg({ senderType: 'user', senderName: 'Alice', text: 'USER_ORIGINAL：不是刚才那个现象' }),
    ] }
    const result = t.builder.build({ ...t.input, prior })
    expect(result.prompt).not.toContain('OLD_ASSISTANT_MEMORY')
    expect(result.prompt).toContain('USER_ORIGINAL：不是刚才那个现象')
    expect(result.prompt).toContain(prior.note)
    expect(result.receipt.priorMessages).toBe(1)
    expect(result.receipt.excluded).toContain(prior.note)
    expect(result.receipt.excluded.some(text => text.includes('1 条旧助手消息'))).toBe(true)
    expect(t.builder.build({ ...t.input, prior, historyMode: 'continue' }).prompt).toContain('OLD_ASSISTANT_MEMORY')
    expect(prior.items).toHaveLength(2)
  })

  it('retains the exact human amendment and Question reply while rereading the latest case facts', async () => {
    const t = setup()
    const bucket = t.bugs.record({ spaceId: t.space.id, chatId: 'chat-a', title: '记录仍在', text: t.task.prompt }).bucket
    const q = t.questions.prepare({ bucketId: bucket.id, spaceId: t.space.id, sessionKey: t.task.sessionKey, originTaskId: t.task.id,
      targetOpenId: 'alice', anchor: { tenantId: 'tenant-synthetic', appId: 'app-synthetic', chatId: 'chat-a', messageId: t.task.messageId },
      kind: 'info', question: 'CURRENT_QUESTION：上一步是什么？' })
    await new DeliveryService(t.registry.db, { spaces: t.spaces, policy: t.policy,
      resolveContext: async () => ({ actorOpenId: 'alice', audience: { kind: 'group', spaceId: t.space.id, chatId: 'chat-a' },
        sources: [{ ref: t.task.messageId, spaceId: t.space.id, chatId: 'chat-a' }], provenanceComplete: true, expiresAt: Date.now() + 60000 }),
      send: async () => ({ remoteId: 'question-sent' }),
    }).deliver({ key: q.deliveryKey, contextRef: 'q', payload: { text: q.question } })
    const replyTask = t.registry.createTaskOnce({ sessionKey: t.task.sessionKey, messageId: 'reply', requesterOpenId: 'alice', prompt: 'HUMAN_REPLY：刷新后恢复，不导出日志', amendsTaskId: t.task.id }).task
    t.questions.acceptReply(q.id, { messageId: replyTask.messageId, senderOpenId: 'alice', taskId: replyTask.id })
    t.bugs.setIntake({ bucketId: bucket.id, spaceId: t.space.id, phase: 'awaiting_info', missingInfo: ['CURRENT_GAP'] })
    t.bugs.linkIssue(bucket.id, 'https://github.com/example/synthetic/issues/7')
    const before = t.questions.readContext(bucket.id, t.space.id)
    const result = t.builder.build({ ...t.input, taskId: replyTask.id, messageId: replyTask.messageId, body: replyTask.prompt })
    for (const text of [t.task.prompt, replyTask.prompt, q.question, 'CURRENT_GAP', 'linked_issue', 'https://github.com/example/synthetic/issues/7']) expect(result.prompt).toContain(text)
    expect(t.questions.readContext(bucket.id, t.space.id)).toEqual(before)
    expect(t.registry.taskWork.get(replyTask.id)?.rootTaskId).toBe(t.task.id)
    expect(t.registry.getSession(t.task.sessionKey)?.cwd).toBe('/synthetic/original-work')
  })
})
