import type { Registry } from '../core/registry.js'
import type { EmailDraft, EmailDrafts } from '../gmail/drafts.js'
import type { FeishuClient } from './client.js'
import type { CardAction } from './ws.js'

type Card = Record<string, unknown>
const plain = (content: string) => ({ tag: 'plain_text', content })
const escape = (v: string) => v.replace(/</g, '＜').replace(/>/g, '＞').replace(/[\\`*_\[\]()]/g, '\\$&')
const md = (content: string): Card => ({ tag: 'markdown', content })
const row = (elements: Card[]): Card => ({ tag: 'column_set', flex_mode: 'none', columns: elements.map(element => ({ tag: 'column', width: 'auto', elements: [element] })) })
const card = (elements: Card[]): Card => ({ schema: '2.0', config: { update_multi: true, wide_screen_mode: true }, header: { title: plain('Friday · 邮件草稿'), template: 'blue' }, body: { elements } })
type Binding = { owner: string; chatId: string; id: string }

export class EmailCards {
  private readonly busy = new Set<string>()
  constructor(private readonly d: { registry: Registry; drafts: EmailDrafts; feishu: Pick<FeishuClient, 'sendToUserOnce' | 'patchCard'>;
    audience(owner: string): { chatId: string }; assertActive(): void; background(work: () => Promise<void>): void }) {}
  render(draft: EmailDraft, edit = false, busy = false): Card {
    const action = (op: string) => ({ action: 'email_draft', op, id: draft.id, revision: draft.revision })
    const button = (label: string, op: string, primary = false): Card => ({ tag: 'button', text: plain(label), type: primary ? 'primary' : 'default', behaviors: [{ type: 'callback', value: action(op) }] })
    const elements: Card[] = [md(`<font color="grey">${escape(draft.from)} → ${draft.to.map(escape).join('、')}</font>`)]
    if (edit && draft.state === 'draft') {
      if (draft.body.length > 1000) elements.push(md(escape(draft.body)), md('<font color="grey">正文较长，可在对话里继续改稿；这里可以调整收件人和主题。</font>'))
      elements.push({ tag: 'form', name: 'email', elements: [
        { tag: 'input', name: 'to', label: plain('收件人'), default_value: draft.to.join(', '), required: true, max_length: 1000 },
        { tag: 'input', name: 'subject', label: plain('主题'), default_value: draft.subject, required: true, max_length: 200, disabled: Boolean(draft.threadId) },
        ...(draft.body.length <= 1000 ? [{ tag: 'input', name: 'body', label: plain('正文'), default_value: draft.body, input_type: 'multiline_text', required: true, max_length: 1000 }] : []),
        row([{ ...button('保存修改', 'save', true), name: 'save', form_action_type: 'submit' }, button('返回草稿', 'view')]),
      ] })
    } else {
      elements.push(md(`**${escape(draft.subject)}**`), md(escape(draft.body)))
      if (busy) elements.push(md('<font color="grey">正在核对邮件与发送回执…</font>'))
      else if (draft.state === 'draft') elements.push(row([button('发送邮件', 'send', true), button('修改', 'edit'), button('丢弃草稿', 'cancel')]))
      else if (draft.state === 'uncertain' || draft.state === 'sending') elements.push(md('发送结果暂未确认。先核对邮箱中的回执，避免重复发送。'), button('核对发送结果', 'reconcile', true))
      else if (draft.state === 'sent') elements.push(md('**已发送**'))
      else elements.push(md('<font color="grey">草稿已丢弃</font>'))
    }
    const url = this.d.drafts.receiptUrl(draft)
    if (url) elements.push(md(`[${draft.state === 'sent' ? '查看已发邮件' : '查看原邮件'}](${url})`))
    return card(elements)
  }
  async show(owner: string, id: string): Promise<void> {
    this.d.assertActive()
    const audience = this.d.audience(owner), draft = this.d.drafts.get(owner, id)
    const check = await this.d.drafts.authorize(owner, id, () => { this.d.assertActive(); if (this.d.audience(owner).chatId !== audience.chatId) throw new Error('个人空间已变化。') })
    check()
    const existing = this.d.registry.getKv(`email-draft-message:${id}`)
    if (existing) {
      const binding = this.read(existing)
      if (binding?.owner === owner && binding.chatId === audience.chatId) { await this.d.feishu.patchCard(existing, this.render(draft)); return }
    }
    const messageId = await this.d.feishu.sendToUserOnce(owner, { card: this.render(draft) }, `email-draft-${id}`)
    this.d.assertActive()
    if (!messageId || this.d.audience(owner).chatId !== audience.chatId) throw new Error('未取得草稿卡的送达回执。')
    this.d.registry.setKv(`email-card:${messageId}`, JSON.stringify({ owner, chatId: audience.chatId, id } satisfies Binding))
    this.d.registry.setKv(`email-draft-message:${id}`, messageId)
  }
  private read(messageId: string): Binding | undefined {
    const r = this.d.registry.getKv(`email-card:${messageId}`)
    return r ? JSON.parse(r) as Binding : undefined
  }
  handle(action: CardAction): Card {
    try {
      this.d.assertActive()
      const b = action.messageId && this.read(action.messageId)
      if (!b || b.owner !== action.operatorOpenId || b.chatId !== action.chatId || b.id !== action.value.id || this.d.audience(b.owner).chatId !== b.chatId)
        throw new Error('这份草稿只能由本人在 Friday 私聊中操作。')
      const draft = this.d.drafts.get(b.owner, b.id), revision = Number(action.value.revision), op = action.value.op
      if (draft.revision !== revision && op !== 'view') throw new Error('草稿已更新，请使用最新卡片。')
      if (op === 'edit' || op === 'view') return { card: { type: 'raw', data: this.render(draft, op === 'edit') } }
      if (op === 'save') {
        const form = action.formValue
        if (!form || typeof form.to !== 'string' || draft.body.length <= 1000 && typeof form.body !== 'string') throw new Error('没有收到完整的草稿修改。')
        const next = this.d.drafts.edit(b.owner, b.id, revision, { to: form.to.split(/[,;，；]/).map(v => v.trim()).filter(Boolean),
          subject: draft.threadId ? draft.subject : String(form.subject ?? ''), body: draft.body.length <= 1000 ? String(form.body) : draft.body })
        return { card: { type: 'raw', data: this.render(next) } }
      }
      if (op === 'cancel') return { card: { type: 'raw', data: this.render(this.d.drafts.cancel(b.owner, b.id, revision)) } }
      if (op !== 'send' && op !== 'reconcile') throw new Error('请重新打开草稿。')
      if (!this.busy.has(b.id)) {
        this.busy.add(b.id)
        const check = () => { this.d.assertActive(); if (this.d.audience(b.owner).chatId !== b.chatId) throw new Error('个人空间已变化。') }
        this.d.background(async () => {
          let failure: string | undefined
          try { if (op === 'send') await this.d.drafts.humanSend(b.owner, b.id, revision, check); else await this.d.drafts.reconcile(b.owner, b.id, check) }
          catch (e) { failure = e instanceof Error ? e.message : '邮件操作未完成。' }
          finally { this.busy.delete(b.id) }
          check()
          let next: Card
          try { next = this.render(this.d.drafts.get(b.owner, b.id)); if (failure) (next.body as { elements: Card[] }).elements.push(md(escape(failure))) }
          catch { next = card([md('Gmail 连接已变化。请在账号连接中重新连接，再查看邮件状态。')]) }
          await this.d.feishu.patchCard(action.messageId!, next)
        })
      }
      return { card: { type: 'raw', data: this.render(draft, false, true) } }
    } catch (e) { return { toast: { type: 'error', content: e instanceof Error ? e.message : '草稿未更新，请重试。' } } }
  }
}
