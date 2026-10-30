import { z } from 'zod'
import type { EmailDraft, EmailDrafts } from '../gmail/drafts.js'
import { GmailError } from '../gmail/connection.js'
import { DeviceError } from './devices.js'

const identity = { id: z.uuid(), revision: z.number().int().positive() }
const command = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('email-list'), page: z.number().int().min(0).max(5).default(0) }).strict(),
  z.object({ operation: z.literal('email-get'), id: z.uuid() }).strict(),
  z.object({ operation: z.literal('email-edit'), ...identity, to: z.array(z.string().max(254)).min(1).max(10),
    subject: z.string().min(1).max(200), body: z.string().min(1).max(6000) }).strict(),
  z.object({ operation: z.literal('email-action'), ...identity, action: z.enum(['send', 'cancel', 'reconcile']) }).strict(),
])

/** The authenticated device action edits the same draft as Feishu. Network
 * sending starts only after commit; EmailDrafts owns its durable send claim. */
export class DesktopEmail {
  private busy = new Set<string>()
  private failures = new Map<string, { revision: number; message: string }>()
  constructor(private readonly d: { drafts: EmailDrafts; defer(effect: () => void): void;
    background(work: () => Promise<void>): void; changed(owner: string, id: string): Promise<void> }) {}

  async prepare(owner: string, raw: unknown, guard: () => void): Promise<() => unknown> {
    const parsed = command.safeParse(raw)
    if (!parsed.success) throw new DeviceError('invalid', '邮件操作格式无效。')
    const input = parsed.data
    guard()
    if (input.operation === 'email-list') {
      const all = this.d.drafts.list(owner), page = Math.min(input.page, Math.max(0, Math.ceil(all.length / 5) - 1))
      const rows = all.slice(page * 5, (page + 1) * 5)
      const checks = await Promise.all(rows.map(async draft => {
        try { return await this.d.drafts.authorize(owner, draft.id, guard) }
        catch { guard(); return undefined }
      }))
      return () => {
        guard()
        const items = rows.flatMap((draft, index) => {
          if (!checks[index]) return []
          try { checks[index]!(); return [this.visible(this.d.drafts.get(owner, draft.id))] }
          catch { guard(); return [] }
        })
        return { items, page, pages: Math.ceil(all.length / 5), unavailable: rows.length - items.length }
      }
    }
    const current = await this.d.drafts.authorize(owner, input.id, guard)
    return () => {
      current()
      const draft = this.d.drafts.get(owner, input.id)
      if (input.operation === 'email-get') return this.visible(draft)
      if (draft.revision !== input.revision) throw new DeviceError('conflict', '草稿已更新，请查看最新内容。')
      if (this.busy.has(input.id)) throw new DeviceError('conflict', '正在核对邮件，请稍后查看结果。')
      if (input.operation === 'email-edit' || input.action === 'cancel') {
        const next = input.operation === 'email-edit'
          ? this.d.drafts.edit(owner, input.id, input.revision, { to: input.to, subject: input.subject, body: input.body })
          : this.d.drafts.cancel(owner, input.id, input.revision)
        this.d.defer(() => { this.failures.delete(input.id); this.d.background(() => this.d.changed(owner, input.id)) })
        // Mutation receipts never retain message bodies for later replay.
        return { id: next.id, revision: next.revision, state: next.state }
      }
      if (input.action === 'send' && draft.state !== 'draft') throw new DeviceError('conflict', '邮件已进入发送流程，请查看回执。')
      if (input.action === 'reconcile' && !['sending', 'uncertain'].includes(draft.state)) throw new DeviceError('conflict', '请刷新邮件状态。')
      this.d.defer(() => {
        if (this.busy.has(input.id)) return
        this.busy.add(input.id); this.failures.delete(input.id)
        this.d.background(async () => {
          try {
            // A newer edit, grant change or device disconnection wins before
            // dispatch. After sending begins, EmailDrafts advances its revision.
            current()
            if (input.action === 'send') await this.d.drafts.humanSend(owner, input.id, input.revision, guard)
            else await this.d.drafts.reconcile(owner, input.id, guard)
          } catch (error) {
            try {
              const latest = this.d.drafts.get(owner, input.id)
              this.failures.set(input.id, { revision: latest.revision,
                message: error instanceof GmailError ? error.message : '这次邮件操作未完成，请刷新状态后重试。' })
            } catch { /* A disconnected account cannot expose its old draft. */ }
          } finally { this.busy.delete(input.id) }
          try { guard(); await this.d.changed(owner, input.id) } catch { /* The durable draft remains authoritative. */ }
        })
      })
      return { id: draft.id, accepted: true }
    }
  }
  private visible(draft: EmailDraft) {
    const failure = this.failures.get(draft.id)
    return { id: draft.id, revision: draft.revision, state: draft.state, from: draft.from, to: draft.to,
      subject: draft.subject, body: draft.body, reply: Boolean(draft.threadId), updatedAt: draft.updatedAt,
      url: this.d.drafts.receiptUrl(draft), busy: this.busy.has(draft.id),
      error: failure?.revision === draft.revision ? failure.message : undefined }
  }
}
