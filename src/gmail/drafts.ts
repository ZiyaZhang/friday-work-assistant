import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { emailAddress, GmailError, type GmailConnections } from './connection.js'
import { gmailLink, type GmailMailbox, type MailThread } from './mailbox.js'
import type { MaterialProvenance } from '../core/execution-materials.js'
import type { RetainedSourceOrigin } from '../core/retained-source-access.js'

export interface EmailDraftSource { origin: RetainedSourceOrigin; provenance: MaterialProvenance }

export interface EmailDraft {
  id: string; owner: string; revision: number; grant: number; accountId: string; from: string; to: string[]
  subject: string; body: string; threadId?: string; replyMessageId?: string; sourceUrl?: string
  rfcReplyId?: string; references?: string
  state: 'draft' | 'sending' | 'sent' | 'uncertain' | 'cancelled'; createdAt: number; updatedAt: number
  rfcId: string; messageId?: string; sentThreadId?: string; sentAt?: number
  source?: EmailDraftSource
}
export interface DraftContent { to: string[]; subject: string; body: string }
export function ensureEmailDraftSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS email_drafts (
    id TEXT PRIMARY KEY,owner TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,data TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS email_drafts_owner ON email_drafts(owner,updated_at);`)
}

/** Channel-independent draft state. Neither an LLM tool nor a scheduler gets the humanSend entry point. */
export class EmailDrafts {
  constructor(private readonly d: { db: DatabaseSync; connections: GmailConnections; mailbox: GmailMailbox; now?: () => number;
    authorize?(draft: EmailDraft, guard: () => void): Promise<() => void> }) { ensureEmailDraftSchema(d.db) }
  private now() { return this.d.now?.() ?? Date.now() }
  private persist(draft: EmailDraft, expected?: { revision: number; state: EmailDraft['state'] }): void {
    draft.updatedAt = this.now()
    if (expected) {
      if (!this.d.db.prepare('UPDATE email_drafts SET revision=?,state=?,updated_at=?,data=? WHERE id=? AND owner=? AND revision=? AND state=?')
        .run(draft.revision, draft.state, draft.updatedAt, JSON.stringify(draft), draft.id, draft.owner, expected.revision, expected.state).changes)
        throw new GmailError(409, '草稿已经更新，请查看最新版本。')
    } else this.d.db.prepare('INSERT INTO email_drafts(id,owner,revision,state,created_at,updated_at,data) VALUES (?,?,?,?,?,?,?)')
      .run(draft.id, draft.owner, draft.revision, draft.state, draft.createdAt, draft.updatedAt, JSON.stringify(draft))
  }
  private raw(owner: string, id: string): EmailDraft {
    const row = this.d.db.prepare('SELECT data FROM email_drafts WHERE owner=? AND id=?').get(owner, id)
    if (!row) throw new GmailError(404, '没有找到你的这份草稿。')
    return JSON.parse(String(row.data)) as EmailDraft
  }
  get(owner: string, id: string): EmailDraft {
    const draft = this.raw(owner, id), g = this.d.connections.view(owner)
    if (g.status !== 'connected' || g.accountId !== draft.accountId) throw new GmailError(409, '草稿使用的 Gmail 连接已变化，请重新连接原账号。')
    return draft
  }
  async authorize(owner: string, id: string, guard: () => void = () => {}): Promise<() => void> {
    guard()
    const draft = this.get(owner, id), revision = draft.revision, grant = this.d.connections.view(owner).revision
    const check = () => { guard(); this.d.connections.assertCurrent(owner, grant); if (this.get(owner, id).revision !== revision) throw new GmailError(409, '草稿已更新。') }
    const source = await this.d.authorize?.(draft, check)
    const current = () => { check(); source?.() }; current(); return current
  }
  list(owner: string): EmailDraft[] {
    const g = this.d.connections.view(owner)
    if (g.status !== 'connected') return []
    return this.d.db.prepare("SELECT data FROM email_drafts WHERE owner=? AND state!='cancelled' ORDER BY updated_at DESC LIMIT 30").all(owner)
      .map(r => JSON.parse(String(r.data)) as EmailDraft).filter(d => d.accountId === g.accountId)
  }
  create(owner: string, content: DraftContent, thread?: MailThread, source?: EmailDraftSource): EmailDraft {
    validateContent(content)
    const g = this.d.connections.view(owner); this.d.connections.assertCurrent(owner, g.revision)
    if (thread && (thread.grant !== g.revision || thread.accountId !== g.accountId || thread.truncated)) throw new GmailError(409, '原邮件上下文不完整或授权已变化，请重新读取。')
    const last = thread?.messages.at(-1)
    if (thread && !safeRfcId(last?.rfcId)) throw new GmailError(409, '这封邮件缺少可核实的回复标识，暂不能在线程中发送。')
    const id = randomUUID(), now = this.now()
    const draft: EmailDraft = { ...content, to: content.to.map(t => t.toLowerCase()), id, owner, revision: 1, grant: g.revision,
      accountId: g.accountId!, from: g.email!, state: 'draft', createdAt: now, updatedAt: now, ...(source ? { source: structuredClone(source) } : {}),
      rfcId: `<friday.${id}@${g.email!.split('@')[1]}>`, ...(thread ? { threadId: thread.id, replyMessageId: last!.id,
        sourceUrl: thread.url, rfcReplyId: last!.rfcId, references: safeReferences(last!.references, last!.rfcId!) } : {}) }
    if (thread) draft.subject = replySubject(thread.subject)
    validateContent(draft)
    this.persist(draft); return draft
  }
  edit(owner: string, id: string, revision: number, content: DraftContent, thread?: MailThread, source?: EmailDraftSource): EmailDraft {
    validateContent(content)
    const draft = this.get(owner, id)
    if (draft.revision !== revision || draft.state !== 'draft') throw new GmailError(409, '这份草稿已更新或已进入发送流程。')
    if (draft.threadId && content.subject !== draft.subject) throw new GmailError(400, '回复原邮件时保留原主题；新主题请另起一封草稿。')
    if (thread && (thread.id !== draft.threadId || thread.accountId !== draft.accountId || thread.grant !== this.d.connections.view(owner).revision ||
      thread.truncated || !safeRfcId(thread.messages.at(-1)?.rfcId))) throw new GmailError(409, '原邮件上下文不完整或授权已变化，请重新读取。')
    const last = thread?.messages.at(-1)
    const next = { ...draft, ...content, to: content.to.map(t => t.toLowerCase()), revision: revision + 1, ...(source ? { source: structuredClone(source) } : {}),
      ...(last ? { grant: thread!.grant, replyMessageId: last.id, rfcReplyId: last.rfcId, references: safeReferences(last.references, last.rfcId!) } : {}) }
    this.persist(next, draft); return next
  }
  cancel(owner: string, id: string, revision: number): EmailDraft {
    const draft = this.get(owner, id)
    if (draft.revision !== revision || draft.state !== 'draft') throw new GmailError(409, '邮件已进入发送流程，不能当作未发送撤销。')
    const next = { ...draft, revision: revision + 1, state: 'cancelled' as const }
    this.persist(next, draft); return next
  }
  /** The caller supplies identity from a verified Feishu card or paired-device user action, never tool arguments. */
  async humanSend(owner: string, id: string, revision: number, guard: () => void): Promise<EmailDraft> {
    guard()
    const draft = this.get(owner, id)
    if (draft.revision !== revision || draft.state !== 'draft') throw new GmailError(409, '这份草稿已更新或正在发送，请查看最新状态。')
    if (!this.d.connections.view(owner).canSend) throw new GmailError(403, '请先在账号连接里允许 Gmail 发送。')
    const grant = this.d.connections.view(owner).revision
    const sourceCheck = await this.d.authorize?.(draft, guard)
    const check = () => { guard(); sourceCheck?.(); this.d.connections.assertCurrent(owner, grant) }
    if (draft.threadId) {
      const latest = await this.d.mailbox.thread(owner, draft.threadId, check); check()
      if (latest.truncated || latest.messages.at(-1)?.id !== draft.replyMessageId) throw new GmailError(409, '原邮件已有新回复，请先更新草稿再发送。')
    }
    // Claim before network I/O. A crash after this point can only reconcile, never automatically resend.
    const sending: EmailDraft = { ...draft, grant, revision: revision + 1, state: 'sending' }
    check(); this.persist(sending, draft)
    let attempted = false
    try {
      check()
      const sent = await this.d.connections.request<{ id?: string; threadId?: string }>(owner, grant, '/messages/send', {
        body: { raw: encodeMessage(draft), ...(draft.threadId ? { threadId: draft.threadId } : {}) }, assertCurrent: check,
        onSendDispatch: () => { attempted = true } })
      if (!/^[a-f0-9]{1,40}$/.test(sent.id ?? '') || !/^[a-f0-9]{1,40}$/.test(sent.threadId ?? '')) throw new Error('missing receipt')
      check()
      const complete: EmailDraft = { ...sending, state: 'sent', messageId: sent.id, sentThreadId: sent.threadId, sentAt: this.now() }
      this.persist(complete, sending)
      return complete
    } catch (error) {
      const definite = !attempted || error instanceof GmailError && error.providerRejectedSend
      // A definite provider rejection remains editable; timeouts/5xx and changed grants require receipt reconciliation.
      this.persist({ ...sending, state: definite ? 'draft' : 'uncertain' }, sending)
      throw error instanceof GmailError ? error : new GmailError(503, definite
        ? '发送前检查未完成，邮件尚未发出；请稍后重新确认发送。'
        : '发送结果暂未确认，请点“核对发送结果”；不会自动重复发送。')
    }
  }
  async reconcile(owner: string, id: string, guard: () => void): Promise<EmailDraft> {
    const draft = this.get(owner, id)
    if (!['uncertain', 'sending'].includes(draft.state)) return draft
    const grant = this.d.connections.view(owner).revision
    const sourceCheck = await this.d.authorize?.(draft, guard)
    const check = () => { guard(); sourceCheck?.(); this.d.connections.assertCurrent(owner, grant) }; check()
    const q = new URLSearchParams({ q: `in:sent rfc822msgid:${draft.rfcId.slice(1, -1)}`, maxResults: '10' })
    const result = await this.d.connections.request<{ messages?: { id: string; threadId: string }[] }>(owner, grant, `/messages?${q}`, { assertCurrent: check })
    check()
    const candidates = result.messages ?? []
    for (const m of candidates) {
      if (!/^[a-f0-9]{1,40}$/.test(m.threadId)) continue
      const thread = await this.d.mailbox.thread(owner, m.threadId, check), sent = thread.messages.find(item => item.id === m.id)
      if (!sent || sent.rfcId !== draft.rfcId || !sent.labels.includes('SENT') || sent.subject !== draft.subject ||
        sent.to.slice().sort().join() !== draft.to.slice().sort().join() || sent.text.replace(/\r\n/g, '\n').trim() !== draft.body.replace(/\r\n/g, '\n').trim()) continue
      const complete: EmailDraft = { ...draft, state: 'sent', messageId: sent.id, sentThreadId: thread.id, sentAt: sent.at }
      check(); this.persist(complete, draft); return complete
    }
    return draft // An empty search does not prove an earlier send failed.
  }
  receiptUrl(draft: EmailDraft) { return draft.sentThreadId ? gmailLink(draft.from, draft.sentThreadId) : draft.sourceUrl }
}

function validateContent(content: DraftContent) {
  if (!Array.isArray(content.to) || !content.to.length || content.to.length > 10 || !content.to.every(emailAddress) || content.to.join(', ').length > 1000 || new Set(content.to.map(v => v.toLowerCase())).size !== content.to.length ||
    !content.subject.trim() || content.subject.length > 200 || /[\r\n\u0000]/.test(content.subject) || !content.body.trim() || content.body.length > 6000 || /\u0000/.test(content.body))
    throw new GmailError(400, '请提供有效收件人、主题和正文（最多 6000 字）。')
}
function safeRfcId(value?: string): boolean { return Boolean(value && /^<[^<>\s]{1,240}@[^<>\s]{1,240}>$/.test(value)) }
function safeReferences(value: string | undefined, last: string): string { return [...new Set([...(value?.match(/<[^<>\s]+@[^<>\s]+>/g) ?? []).filter(safeRfcId).slice(-8), last])].join(' ') }
function replySubject(subject: string): string { return /^re:/i.test(subject) ? subject : `Re: ${subject}` }
export function encodeMessage(draft: EmailDraft): string {
  validateContent(draft)
  if (!emailAddress(draft.from) || !safeRfcId(draft.rfcId) || draft.rfcReplyId && !safeRfcId(draft.rfcReplyId)) throw new GmailError(400, '邮件头无效。')
  const chars = Array.from(draft.subject), words: string[] = []
  for (let i = 0; i < chars.length; i += 10) words.push(`=?UTF-8?B?${Buffer.from(chars.slice(i, i + 10).join('')).toString('base64')}?=`)
  const subject = words.join('\r\n ')
  const headers = [`From: ${draft.from}`, `To: ${draft.to.join(', ')}`, `Subject: ${subject}`, `Message-ID: ${draft.rfcId}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64']
  if (draft.rfcReplyId) headers.push(`In-Reply-To: ${draft.rfcReplyId}`, `References: ${safeReferences(draft.references, draft.rfcReplyId)}`)
  const body = Buffer.from(draft.body.replace(/\r?\n/g, '\r\n')).toString('base64').match(/.{1,76}/g)!.join('\r\n')
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`).toString('base64url')
}
