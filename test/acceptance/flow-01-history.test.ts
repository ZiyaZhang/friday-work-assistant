import { afterEach, describe, expect, it } from 'vitest'
import { historyMsg } from '../helpers/fake-feishu.js'
import { acceptanceHost, closeAll } from './host.js'

afterEach(closeAll)
const DAY = 86_400_000

/** §11.1 历史检索：两周前的资料 → 继续翻更早 → 发原文件；核对真实作者、时间窗、未读部分和附件来源。 */
describe('acceptance 01 · history retrieval', () => {
  it('pages real history by time window, reports unread coverage, downloads from the verified source message and delivers the original file in the topic', async () => {
    const t = await acceptanceHost(), now = Date.now()
    const report = historyMsg({ messageId: 'om_report', chatId: 'group', text: '上周的评审报告', msgType: 'file', fileKey: 'fk_report', fileName: 'review-report.pdf',
      senderOpenId: 'bob', senderName: '李四', createTimeMs: now - 14 * DAY })
    t.fake.histories.set('group', [
      historyMsg({ messageId: 'om_old', chatId: 'group', text: '更早的讨论', senderOpenId: 'bob', senderName: '李四', createTimeMs: now - 20 * DAY }),
      historyMsg({ messageId: 'om_mention', chatId: 'group', text: '报告我稍后发', senderOpenId: 'bob', senderName: '李四', createTimeMs: now - 14 * DAY - 3_600_000 }),
      report,
      historyMsg({ messageId: 'om_recent', chatId: 'group', text: '今天的闲聊', senderOpenId: 'alice', senderName: '张三', createTimeMs: now - 3_600_000 }),
    ])
    t.fake.messages.set('om_report', report)
    const seen: Record<string, unknown>[] = []
    let sent!: { status: number; body: Record<string, unknown> }
    const { task } = await t.run([{ kind: 'hook', run: async () => {
      // First page of the requested window: one item per call so the host must report what is still unread.
      const first = await t.tool('chat/history', { start_time: new Date(now - 15 * DAY).toISOString(), end_time: new Date(now - 13 * DAY).toISOString(), limit: 1 })
      seen.push(first.body)
      expect(first.status).toBe(200)
      expect(first.body).toMatchObject({ has_more: true, next_start_time: expect.stringMatching(/^\d{4}-/), items: [{ messageId: 'om_mention', senderOpenId: 'bob', senderName: '李四' }] })
      // Continue from where the host said it stopped, not from a guessed time.
      const second = await t.tool('chat/history', { start_time: first.body.next_start_time, end_time: new Date(now - 13 * DAY).toISOString(), limit: 5 })
      seen.push(second.body)
      expect(second.body).toMatchObject({ has_more: false, coverage_complete: true, items: [{ messageId: 'om_report', fileName: 'review-report.pdf', senderOpenId: 'bob' }] })
      // Going further back is a separate window; the older discussion is not silently merged into the first answer.
      const earlier = await t.tool('chat/history', { start_time: new Date(now - 21 * DAY).toISOString(), end_time: new Date(now - 15 * DAY).toISOString() })
      expect(earlier.body).toMatchObject({ coverage_complete: true, items: [{ messageId: 'om_old' }] })
      const file = await t.tool<{ path: string; file_name: string }>('message/file', { message_id: 'om_report' })
      expect(file.status).toBe(200)
      expect(t.fake.downloads).toEqual([{ messageId: 'om_report', fileKey: 'fk_report', type: 'file', dest: expect.any(String) }])
      expect(file.body.path).toContain('/downloads/')
      sent = await t.tool('file/send', { path: file.body.path, note: '这是李四两周前发的评审报告' })
      expect(sent.status).toBe(200)
    } }, { kind: 'text', text: '已把报告发在上面。' }])
    expect(task?.status).toBe('done')
    // The file went to the origin topic as a reply, from the downloaded bytes, with a delivery ledger row the host can reconcile later.
    const files = t.fake.sent.filter(item => item.kind === 'replyFile')
    expect(files).toHaveLength(1)
    expect(files[0]!.target).toBe(task!.messageId)
    const ledger = t.db.prepare("SELECT delivery_key, status, remote_id, source_refs FROM deliveries WHERE delivery_key LIKE ? ORDER BY created_at").all(`task:${task!.id}:%`) as { delivery_key: string; status: string; remote_id: string | null; source_refs: string }[]
    const toolRow = ledger.find(row => row.delivery_key.includes(':tool:'))
    // The ledger row carries the source space the material came from; a later reconcile or audience check reads it from here.
    expect(toolRow).toMatchObject({ status: 'sent', remote_id: sent.body.message_id, source_refs: JSON.stringify([`space:${t.group.id}`]) })
    expect(seen[0]).toMatchObject({ chat_id: 'group', filtered_by_keyword: null })
  })
})
