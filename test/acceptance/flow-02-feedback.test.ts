import { afterEach, describe, expect, it } from 'vitest'
import type { AskBugQuestionReceipt } from '../../src/core/question-types.js'
import { acceptanceHost, closeAll } from './host.js'

afterEach(closeAll)

/**
 * §11.2 反馈到交付：建议带两个限定 → 查重并保留原意 → 信息性补问 → 用户拒绝日志 → 继续核查 → 同一 Issue → 原话题短回执。
 * The PR half (branch, publish, review update) needs a real repository and is verified on the devbox, not here.
 */
describe('acceptance 02 · feedback to delivery', () => {
  it('keeps the original wording and qualifiers, asks once, continues on the explicit refusal in the same delegation, and opens exactly one linked Issue', async () => {
    const t = await acceptanceHost()
    t.spaces.patchConfig(t.group.id, { repos: true })
    const original = '登录后偶发白屏，仅在 Safari 且开了隐私模式时出现；不要假设能稳定复现。'
    let bucketId = 0, asked!: AskBugQuestionReceipt
    const first = await t.run([{ kind: 'hook', run: async () => {
      const recorded = await t.tool<{ bucket: { id: number; count: number } }>('bug/record', { title: '登录后 Safari 隐私模式白屏', text: original })
      expect(recorded.status).toBe(200); bucketId = recorded.body.bucket.id
      // Dedupe keeps the first record; a near-duplicate title is reported as a candidate instead of a second case.
      const similar = await t.tool<{ candidates: { id: number }[] }>('bug/similar', { title: '登录后 Safari 隐私模式 白屏' })
      expect(similar.body.candidates.map(candidate => candidate.id)).toContain(bucketId)
      const again = await t.tool<{ bucket: { id: number; count: number } }>('bug/record', { title: '登录后 Safari 隐私模式白屏', text: '同一件事再报一次' })
      expect(again.body.bucket.id).toBe(bucketId)
      const question = await t.tool<AskBugQuestionReceipt>('bug/ask', { id: bucketId, kind: 'info', question: '能否导出当时的控制台日志？', missing_info: ['console log'] })
      expect(question.status).toBe(200); asked = question.body
      expect(asked).toMatchObject({ resolution: 'open', next: 'continue_independent_work', message_id: expect.any(String) })
    } }, { kind: 'text', text: '已记录，等你的日志再继续核查。' }], { text: `@Friday ${original}` })
    expect(first.task?.status).toBe('done')
    // One origin message is one report, however many times the model records it; the original wording stays verbatim.
    expect(t.bugs.get(bucketId)).toMatchObject({ count: 1, issueUrl: null })
    expect(t.bugs.reports(bucketId).map(report => report.text)).toEqual([original])
    const key = t.registry.taskWork.get(first.task!.id)!.key
    expect(t.registry.workContexts.view(key)).toMatchObject({ activity: 'waiting', pending: { questions: 1 } })
    // The person declines the logs by replying to the question message. The reply is kept verbatim and continues the same delegation.
    const refusal = '我不想导出日志，先按现有信息查。'
    let opened!: { status: number; body: { action: string; number: number; url?: string; html_url?: string } }
    t.agent.state.script = [{ kind: 'hook', run: async () => {
      const context = await t.tool<{ questions: { id: number; replies: { id: number; text: string; outcome: string }[] }[] }>('bug/context', { id: bucketId })
      const question = context.body.questions[0]!, reply = question.replies.at(-1)!
      expect(reply).toMatchObject({ text: refusal, outcome: 'pending' })
      expect((await t.tool('bug/reply', { question_id: question.id, reply_id: reply.id, outcome: 'declined' })).status).toBe(200)
      // Code inspection continues on the case; the Issue is opened once and linked to the case.
      opened = await t.tool('github/issue/open', { repo: 'org/a', title: '登录后 Safari 隐私模式白屏', body: `${original}\n用户已明确不提供日志。` })
      expect(opened.status).toBe(200)
      expect((await t.tool('bug/link_issue', { id: bucketId, issue_url: `https://github.com/org/a/issues/${opened.body.number}` })).status).toBe(200)
    } }, { kind: 'text', text: `已建 Issue #101 并关联到反馈。` }]
    const replyMessage = t.message({ text: refusal, mentions: [], parentId: asked.message_id, rootId: first.msg.messageId })
    await t.host.handleMessage(replyMessage)
    const continuation = t.registry.taskForMessage(replyMessage.messageId)!
    expect(continuation).toMatchObject({ sessionKey: first.task!.sessionKey, status: 'done' })
    expect(t.registry.workContexts.inputs(key).map(input => input.taskId)).toEqual([first.task!.id, continuation.id])
    expect(t.questions.get(asked.question_id)).toMatchObject({ resolution: 'declined' })
    expect(t.questions.replies(asked.question_id)).toMatchObject([{ messageId: replyMessage.messageId, taskId: continuation.id, outcome: 'declined' }])
    expect(continuation.prompt).toBe(refusal)
    expect(t.github.state.issues).toHaveLength(1)
    expect(t.github.state.issues[0]!.body).toContain(original)
    expect(t.bugs.get(bucketId)?.issueUrl).toBe('https://github.com/org/a/issues/101')
    expect(t.db.prepare("SELECT status, number FROM github_issue_operations WHERE action = 'created'").all()).toEqual([{ status: 'confirmed', number: 101 }])
    // The receipt goes back to the original topic as a short reply; nothing is sent elsewhere.
    const answers = t.fake.sent.filter(item => item.kind === 'replyMarkdown' || item.kind === 'replyText')
    expect(answers.every(item => [first.msg.messageId, replyMessage.messageId, asked.message_id].includes(item.target))).toBe(true)
    expect(t.fake.answers().join('\n')).toContain('Issue #101')
    expect(t.registry.workContexts.view(key)).toMatchObject({ activity: 'idle', handledSeq: 2, pending: { questions: 0 } })
  })
})
