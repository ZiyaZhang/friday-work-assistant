import { PollError, type Poll, type PollResult } from '../core/polls.js'
import { measureTodoCard } from './todo-card-pagination.js'

function escape(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_\[\]()~]/g, '\\$&') }
/** Full immutable text is shown. Over-budget questions/options are not silently shortened. */
export function renderPollCard(poll: Poll): Record<string, unknown> {
  const callback = (optionId: string | null) => ({ action: 'poll_ballot', pollId: poll.id, digest: poll.contentDigest, optionId })
  const elements: Record<string, unknown>[] = [
    { tag: 'markdown', content: escape(poll.question) },
    { tag: 'markdown', content: `具名单选，一人一票；截止前可改选或撤回。投票仅表达意见，不自动替任何人建 Issue 或执行结果。\n${poll.closesAt === null ? '未设自动截止，由负责人关闭。' : `截止时间：${new Date(poll.closesAt).toISOString()}（UTC）。`}` },
  ]
  for (const choice of poll.choices) {
    elements.push({ tag: 'markdown', content: escape(choice.text) })
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '选择此项' }, type: 'default', behaviors: [{ type: 'callback', value: callback(choice.id) }] })
  }
  elements.push({ tag: 'button', text: { tag: 'plain_text', content: '撤回我的选择' }, type: 'default', behaviors: [{ type: 'callback', value: callback(null) }] })
  const card = { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: '需求投票' }, template: 'blue' }, body: { elements } }
  if (!measureTodoCard(card, { kind: 'create', receiveId: poll.origin.chatId }).fits) throw new PollError('too_large')
  return card
}

/** Complete named classification. Internal actor IDs never become display labels. */
export function pollResultText(poll: Poll, result: PollResult): string {
  return [`投票已截止：${poll.question}`, `有效选择 ${result.total} 人，已撤回 ${result.withdrawn} 人。`,
    ...result.groups.map(group => `${group.text}：${group.count} 人\n${group.voters.map(value => value.name ?? '姓名暂不可用的参与者').join('、') || '暂无选择'}`),
    '已关联反馈，等待负责人决断；票数不代表所有群成员同意，也没有自动创建 Issue 或执行获选方案。'].join('\n\n')
}
