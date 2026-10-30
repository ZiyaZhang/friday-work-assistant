import type { WorkAssessmentRecord } from '../core/work-assessment.js'

/** Callback value of the two buttons; it carries only the assessment id. Operator, chat and card message come from the platform. */
export const ISSUE_ASSESSMENT_CARD_ACTION = 'issue_assessment_handoff'

/** Issue titles and the model's summary are untrusted: escaped for the card's markdown (same rule as the poll card), so they render as text. */
function escape(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_\[\]()~]/g, '\\$&') }
const plain = (content: string) => ({ tag: 'markdown', content: escape(content) })

/** Repository, number, title and link as read into the assessment snapshot (its metadata source), not re-read. */
function issueLine(record: WorkAssessmentRecord): string {
  const target = record.snapshot.targets[0], number = target?.target.kind === 'issue' ? target.target.number : 0
  const metadata = target && record.snapshot.sources.find(source => source.ref === `${target.ref}:metadata`)
  let title = '', url = ''
  try {
    const value = JSON.parse(metadata?.text ?? '{}') as { title?: unknown; url?: unknown }
    if (typeof value.title === 'string') title = value.title
    if (typeof value.url === 'string') url = value.url
  } catch { /* the line below still names repository and number */ }
  return `${record.snapshot.repo}#${number}${title ? `「${title.slice(0, 200)}」` : ''}\n${url || `https://github.com/${record.snapshot.repo}/issues/${number}`}`
}

/** One line of the model's summary: the first line, at most 200 characters. */
function reason(record: WorkAssessmentRecord): string {
  const line = (record.result?.summary ?? '').trim().split('\n')[0]!.trim()
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

/** Sent once per recommend verdict, as a reply to the requester's message in the original conversation. */
export function issueAssessmentConfirmationCard(record: WorkAssessmentRecord): Record<string, unknown> {
  const button = (content: string, decision: 'execute' | 'decline', type: 'primary' | 'default') => ({ tag: 'button', type,
    text: { tag: 'plain_text', content }, behaviors: [{ type: 'callback', value: { action: ISSUE_ASSESSMENT_CARD_ACTION, assessmentId: record.id, decision } }] })
  return { schema: '2.0', config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '要把这条 Issue 交给 Friday 做吗？' }, template: 'blue' },
    body: { elements: [
      plain(issueLine(record)),
      plain(`评估结论：recommend（建议接手）\n原因：${reason(record)}`),
      plain(`评估编号：${record.id}\n快照摘要：${record.snapshot.digest.slice(0, 12)}`),
      plain('只有发起这次评估的人可以在这里确认。确认后在原工作里新建一个修复任务，按现有流程修改代码并提交 Draft PR，CI 结果回到本话题；'
        + '仓库写权限和发布规则不变。确认时会重读 Issue 线程，有变化就不开始，需要重新评估。评估 24 小时内有效。'),
      button('交给 Friday 做', 'execute', 'primary'), button('先不用', 'decline', 'default'),
    ] } }
}

/** Replaces the card after the handoff Task exists. No buttons: a repeated click cannot start anything else anyway. */
export function issueAssessmentHandedOffCard(record: WorkAssessmentRecord, taskId: number): Record<string, unknown> {
  return { schema: '2.0', config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '已交给 Friday' }, template: 'green' },
    body: { elements: [
      plain(issueLine(record)),
      plain(`已在原工作里新建修复任务 #${taskId}，按现有流程修改代码并提交 Draft PR；进展和 CI 结果回到本话题。`),
      plain(`评估编号：${record.id}`),
    ] } }
}

/** Replaces the card when the assessment can no longer be handed off (thread or binding changed, expired). */
export function issueAssessmentClosedCard(record: WorkAssessmentRecord, text: string): Record<string, unknown> {
  return { schema: '2.0', config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '没有交给 Friday' }, template: 'grey' },
    body: { elements: [plain(issueLine(record)), plain(text), plain(`评估编号：${record.id}`)] } }
}
