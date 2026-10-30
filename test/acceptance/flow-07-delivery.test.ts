import { afterEach, describe, expect, it } from 'vitest'
import { historyMsg } from '../helpers/fake-feishu.js'
import { acceptanceHost, closeAll } from './host.js'

afterEach(closeAll)

/** §11.7 投递：远端已成功但本地未记住 → 重启核对；不能重复发、重复建单或假报失败。 */
describe('acceptance 07 · deliveries and external writes whose acknowledgement was lost', () => {
  it('keeps a lost-ack answer as unknown across a restart, never resends it, and only a platform read-back may change the ledger', async () => {
    const t = await acceptanceHost()
    // The platform accepts the message but the acknowledgement never arrives.
    const original = t.fake.replyMarkdown.bind(t.fake)
    t.fake.replyMarkdown = async (messageId, markdown, replyInThread) => {
      const sent = await original(messageId, markdown, replyInThread)
      t.fake.histories.set('group', [...(t.fake.histories.get('group') ?? []), historyMsg({ messageId: sent.messageId, chatId: 'group', text: markdown, msgType: 'post', senderOpenId: 'bot', senderType: 'app', createTimeMs: Date.now() })])
      throw new Error('synthetic lost acknowledgement')
    }
    const { task } = await t.run([{ kind: 'text', text: 'LOST_ACK_ANSWER' }])
    const key = `task:${task!.id}:final:0`
    const row = () => t.db.prepare('SELECT status, remote_id FROM deliveries WHERE delivery_key = ?').get(key) as { status: string; remote_id: string | null }
    expect(row()).toEqual({ status: 'unknown', remote_id: null })
    expect(t.fake.sent.filter(item => item.kind === 'replyMarkdown')).toHaveLength(1)
    // Restart: recovery does not turn unknown into a resend or into a failure.
    t.fake.replyMarkdown = original
    const restarted = await t.restart()
    expect(row()).toEqual({ status: 'unknown', remote_id: null })
    expect(t.fake.sent.filter(item => item.kind === 'replyMarkdown')).toHaveLength(1)
    expect(restarted.agent.state.allPrompts).toHaveLength(0)
    // Only a read-back of what the platform actually shows changes the ledger, through the console command.
    const item = (await t.executions()).items.find(entry => entry.id === task!.id)!
    expect(item.deliveries).toContainEqual(expect.objectContaining({ key, status: 'unknown' }))
    // A rich-text answer has no verifiable content digest: the window shows a bot message but it cannot be attributed, so the
    // ledger stays unknown and says so, instead of being marked sent or failed.
    const receipt = await t.commands.execute(t.login('alice'), t.group.id, { operation: 'delivery.reconcile', requestId: 'delivery_reconcile_0001', key })
    expect(receipt.body.appliedResult).toMatchObject({ changed: false, state: 'unresolved', result: 'unverifiable' })
    expect(row()).toEqual({ status: 'unknown', remote_id: null })
    expect(t.fake.sent.filter(item => item.kind === 'replyMarkdown')).toHaveLength(1)
    // A text delivery with a lost acknowledgement is attributable by digest and becomes confirmed from the read-back alone.
    const sendText = t.fake.replyText.bind(t.fake)
    t.fake.replyText = async (messageId, text, replyInThread) => {
      const sent = await sendText(messageId, text, replyInThread)
      t.fake.histories.set('group', [...(t.fake.histories.get('group') ?? []), historyMsg({ messageId: sent.messageId, chatId: 'group', text, msgType: 'text', senderOpenId: 'bot', senderType: 'app', createTimeMs: Date.now() })])
      throw new Error('synthetic lost acknowledgement')
    }
    const before = t.fake.sent.length
    await t.host.handleMessage(t.message({ text: '进展如何', mentions: [], parentId: task!.messageId, rootId: task!.messageId }))
    t.fake.replyText = sendText
    const control = t.fake.sent.slice(before).find(item => item.kind === 'replyText')!
    const controlKey = (t.db.prepare("SELECT delivery_key FROM deliveries WHERE status = 'unknown' AND delivery_key != ? ORDER BY created_at DESC LIMIT 1").get(key) as { delivery_key: string } | undefined)?.delivery_key
    expect(controlKey).toBeDefined()
    const confirmed = await t.commands.execute(t.login('alice'), t.group.id, { operation: 'delivery.reconcile', requestId: 'delivery_reconcile_0002', key: controlKey! })
    expect(confirmed.body.appliedResult).toMatchObject({ changed: true, state: 'confirmed', result: 'confirmed' })
    expect(t.db.prepare('SELECT status, remote_id FROM deliveries WHERE delivery_key = ?').get(controlKey!)).toEqual({ status: 'confirmed', remote_id: control.messageId })
  })

  it('an issue creation whose response was lost is never repeated: the next attempt reconciles the original and reuses it', async () => {
    const t = await acceptanceHost()
    t.spaces.patchConfig(t.group.id, { repos: true })
    t.github.state.unknownOnCreate = true
    const first = await t.run([{ kind: 'hook', run: async () => {
      const opened = await t.tool('github/issue/open', { repo: 'org/a', title: '登录失败后无法恢复', body: '刷新后仍停留在空白页' })
      expect(opened.status).toBeGreaterThanOrEqual(400)
      expect(JSON.stringify(opened.body)).toMatch(/未知|核对/)
    } }, { kind: 'text', text: '建单结果未知，稍后核对。' }])
    expect(first.task?.status).toBe('done')
    expect(t.github.state.issues).toHaveLength(1)
    expect(t.db.prepare("SELECT status FROM github_issue_operations WHERE action = 'created'").all()).toEqual([{ status: 'unknown' }])
    // A later Run in the same space asks for the same issue: the ledger is reconciled against GitHub, not bypassed.
    t.github.state.unknownOnCreate = false
    const second = await t.run([{ kind: 'hook', run: async () => {
      const opened = await t.tool<{ action: string; number: number }>('github/issue/open', { repo: 'org/a', title: '登录失败后无法恢复', body: '刷新后仍停留在空白页' })
      expect(opened.status).toBe(200)
      expect(opened.body).toMatchObject({ action: expect.stringMatching(/existing|created|reused|comment/), number: 101 })
    } }, { kind: 'text', text: '已关联到原 Issue。' }], { text: '@Friday 再帮我把这个问题建单', threadId: 'topic-2' })
    expect(second.task?.status).toBe('done')
    expect(t.github.state.issues).toHaveLength(1)
    expect(t.github.state.calls.filter(call => call.method === 'POST' && /\/issues$/.test(call.path))).toHaveLength(1)
    expect(t.db.prepare("SELECT status, number FROM github_issue_operations WHERE action = 'created'").all()).toEqual([{ status: 'confirmed', number: 101 }])
  })
})
