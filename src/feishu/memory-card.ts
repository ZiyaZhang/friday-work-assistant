import type { MemoryNote } from '../core/memory.js'
import type { OutboundPayload } from './client.js'

/** Feishu interactive message body budget; a candidate that does not fit is not displayed at all. */
const MEMORY_CARD_BYTES = 30_000

/** Plain text renders the whole supplied text literally, including Markdown-looking content. */
export function memoryCandidatePayload(note: MemoryNote, previous: MemoryNote | undefined, targetRef: string): OutboundPayload {
  const payload: OutboundPayload = { card: { config: { wide_screen_mode: true }, header: { template: 'blue', title: { tag: 'plain_text', content: '要记住这条吗？' } },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: `${note.title}\n\n${note.body}` } },
      ...(previous ? [{ tag: 'div', text: { tag: 'plain_text', content: `确认后替换原来这条：${previous.body || previous.title}` } }] : []),
      { tag: 'div', text: { tag: 'plain_text', content: '确认后生效；原来那条在你确认前照常有效。内容不对点「更正」，不该记点「忘记」。' } },
      { tag: 'action', actions: [
        { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '确认' }, value: { action: 'memory_confirm', targetRef } },
        { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '更正' }, value: { action: 'memory_correct', targetRef } },
        { tag: 'button', type: 'danger', text: { tag: 'plain_text', content: '忘记' }, value: { action: 'memory_forget', targetRef } },
      ] },
    ] } }
  if (Buffer.byteLength(JSON.stringify({ receive_id: 'x'.repeat(128), msg_type: 'interactive', content: JSON.stringify(payload.card) }), 'utf8') > MEMORY_CARD_BYTES) throw new Error('这条候选全文超过卡片容量，请拆成多条后展示；尚未展示，不能确认。')
  return payload
}

/** Replaces the candidate card in place after a button click. The confirmed body is the one the clicker just read on this card. */
export function memoryDecidedCard(input: { noteId: number; decision: 'confirmed' | 'forgotten'; note?: { title: string; body: string }; previousId?: number }): Record<string, unknown> {
  const confirmed = input.decision === 'confirmed'
  const elements: Record<string, unknown>[] = []
  if (confirmed && input.note) elements.push({ tag: 'div', text: { tag: 'plain_text', content: `${input.note.title}\n\n${input.note.body}` } })
  elements.push({ tag: 'div', text: { tag: 'plain_text', content: confirmed
    ? (input.previousId ? '已生效，原来那条已替换。' : '已生效。')
    : (input.previousId ? '没有记，原来那条保持不变。' : '没有记。') } })
  return { config: { wide_screen_mode: true },
    header: { template: confirmed ? 'green' : 'grey', title: { tag: 'plain_text', content: confirmed ? '已记住' : '已忘记' } },
    elements }
}
