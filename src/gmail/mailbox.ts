import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { GmailError, emailAddress, type GmailConnections } from './connection.js'

export interface MailMessage {
  id: string; at: number; from: string; to: string[]; cc: string[]; replyTo?: string
  subject: string; text: string; rfcId?: string; references?: string; labels: string[]; truncated: boolean
}
export interface MailThread {
  id: string; accountId: string; email: string; grant: number; subject: string; url: string
  messages: MailMessage[]; digest: string; readAt: number; truncated: boolean
}
export type MailState = 'needs_reply' | 'waiting' | 'quiet' | 'unknown'
export interface MailItem { thread: MailThread; state: MailState; title: string; reason: string; quote: string; messageId: string }
type Guard = () => void
type Part = { mimeType?: string; filename?: string; headers?: { name?: string; value?: string }[]; body?: { data?: string; attachmentId?: string }; parts?: Part[] }
type RawMessage = { id?: string; threadId?: string; internalDate?: string; labelIds?: string[]; payload?: Part }

export function ensureMailboxSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS gmail_threads (
    owner TEXT NOT NULL,account_id TEXT NOT NULL,thread_id TEXT NOT NULL,grant_revision INTEGER NOT NULL,
    snapshot TEXT NOT NULL,digest TEXT NOT NULL,read_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'unknown',
    title TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',quote TEXT NOT NULL DEFAULT '',message_id TEXT NOT NULL DEFAULT '',
    assessed_digest TEXT,PRIMARY KEY(owner,account_id,thread_id)
  ); CREATE TABLE IF NOT EXISTS gmail_scan (
    owner TEXT PRIMARY KEY,grant_revision INTEGER NOT NULL,updated_at INTEGER NOT NULL DEFAULT 0,
    page_token TEXT,state TEXT NOT NULL DEFAULT 'initial',through_at INTEGER NOT NULL DEFAULT 0
  );`)
}

/** Parsed provider content stays untrusted. Neither headers nor body can change an owner or invoke tools. */
export class GmailMailbox {
  constructor(private readonly d: { db: DatabaseSync; connections: GmailConnections; now?: () => number }) { ensureMailboxSchema(d.db) }
  private now() { return this.d.now?.() ?? Date.now() }
  async search(owner: string, input: { query?: string; limit?: number; cursor?: string } = {}, guard: Guard = () => {}) {
    const g = this.d.connections.view(owner), limit = input.limit ?? 10
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || (input.query?.length ?? 0) > 500 || (input.cursor?.length ?? 0) > 1000)
      throw new GmailError(400, '邮件搜索参数无效。')
    const check = () => { guard(); this.d.connections.assertCurrent(owner, g.revision) }; check()
    const q = new URLSearchParams({ q: input.query ?? 'newer_than:7d -in:trash -in:spam -in:drafts', maxResults: String(limit) })
    if (input.cursor) q.set('pageToken', input.cursor)
    const page = await this.d.connections.request<{ threads?: { id: string }[]; nextPageToken?: string }>(owner, g.revision, `/threads?${q}`, { assertCurrent: check })
    check()
    if (page.threads && (!Array.isArray(page.threads) || page.threads.length > limit)) throw new GmailError(502, 'Gmail 返回的搜索结果不完整。')
    const threads: MailThread[] = []
    // Bound concurrent provider load, and retain pagination instead of claiming the first page is the whole mailbox.
    for (let i = 0; i < (page.threads?.length ?? 0); i += 4) {
      threads.push(...await Promise.all(page.threads!.slice(i, i + 4).map(t => this.thread(owner, t.id, check))))
      check()
    }
    return { threads, cursor: page.nextPageToken, complete: !page.nextPageToken, checkedAt: this.now() }
  }
  async thread(owner: string, id: string, guard: Guard = () => {}): Promise<MailThread> {
    if (!/^[a-f0-9]{1,40}$/.test(id)) throw new GmailError(400, '邮件会话编号无效。')
    const g = this.d.connections.view(owner)
    const check = () => { guard(); this.d.connections.assertCurrent(owner, g.revision) }; check()
    const raw = await this.d.connections.request<{ id?: string; messages?: RawMessage[] }>(owner, g.revision, `/threads/${id}?format=full`, { assertCurrent: check })
    check()
    if (raw.id !== id || !Array.isArray(raw.messages) || !raw.messages.length || raw.messages.some(m => m.threadId !== id)) throw new GmailError(502, '未能完整读取这封邮件的上下文。')
    const messages = raw.messages.filter(m => !m.labelIds?.includes('DRAFT')).slice(-50).map(parseMessage).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    if (!messages.length) throw new GmailError(404, '这个会话只有尚未发送的草稿。')
    const digest = createHash('sha256').update(JSON.stringify(messages)).digest('hex')
    const thread: MailThread = { id, accountId: g.accountId!, email: g.email!, grant: g.revision, subject: messages.at(-1)!.subject,
      url: gmailLink(g.email!, id), messages, digest, readAt: this.now(), truncated: raw.messages.length > 50 || messages.some(m => m.truncated) }
    this.d.db.prepare(`INSERT INTO gmail_threads(owner,account_id,thread_id,grant_revision,snapshot,digest,read_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(owner,account_id,thread_id) DO UPDATE SET grant_revision=excluded.grant_revision,snapshot=excluded.snapshot,digest=excluded.digest,read_at=excluded.read_at`)
      .run(owner, g.accountId!, id, g.revision, JSON.stringify(thread), digest, thread.readAt)
    return thread
  }
  items(owner: string): MailItem[] {
    const g = this.d.connections.view(owner)
    if (g.status !== 'connected') return []
    return this.d.db.prepare(`SELECT * FROM gmail_threads WHERE owner=? AND account_id=? AND grant_revision=? AND assessed_digest=digest
      AND state IN ('needs_reply','waiting') ORDER BY read_at DESC LIMIT 100`).all(owner, g.accountId!, g.revision)
      .map(r => ({ thread: JSON.parse(String(r.snapshot)) as MailThread, state: r.state as MailState, title: String(r.title), reason: String(r.reason), quote: String(r.quote), messageId: String(r.message_id) }))
  }
  needsAssessment(owner: string, thread: MailThread): boolean {
    return this.d.db.prepare('SELECT assessed_digest FROM gmail_threads WHERE owner=? AND account_id=? AND thread_id=?').get(owner, thread.accountId, thread.id)?.assessed_digest !== thread.digest
  }
  unassessed(owner: string, limit = 4): MailThread[] {
    const g = this.d.connections.view(owner)
    if (g.status !== 'connected') return []
    return this.d.db.prepare(`SELECT snapshot FROM gmail_threads WHERE owner=? AND account_id=? AND grant_revision=?
      AND (assessed_digest IS NULL OR assessed_digest!=digest) ORDER BY read_at ASC LIMIT ?`).all(owner, g.accountId!, g.revision, limit)
      .map(row => JSON.parse(String(row.snapshot)) as MailThread)
  }
  scanStatus(owner: string): { state: string; checkedAt?: number } {
    const g = this.d.connections.view(owner), row = this.d.db.prepare('SELECT * FROM gmail_scan WHERE owner=? AND grant_revision=?').get(owner, g.revision)
    return row ? { state: String(row.state), ...(Number(row.through_at) > 0 ? { checkedAt: Number(row.through_at) } : {}) } : { state: 'initial' }
  }
  assess(owner: string, thread: MailThread, value: { state: MailState; title: string; reason: string; quote: string; messageId: string }): void {
    this.d.connections.assertCurrent(owner, thread.grant)
    const source = thread.messages.find(m => m.id === value.messageId), last = thread.messages.at(-1)!
    if (!['needs_reply', 'waiting', 'quiet', 'unknown'].includes(value.state) || value.title.length > 160 || value.reason.length > 400 || value.quote.length > 600 ||
      value.state !== 'quiet' && value.state !== 'unknown' && (!source || !value.quote.trim() || !source.text.includes(value.quote))) throw new GmailError(400, '邮件事项缺少可核实的原文。')
    // Replying resolves the reply request, not the underlying project. Only the SENT label proves this account sent it.
    if (value.state === 'needs_reply' && (last.labels.includes('SENT') || last.id !== source?.id)) value = { ...value, state: 'unknown' }
    if (value.state === 'waiting' && !last.labels.includes('SENT')) value = { ...value, state: 'unknown' }
    if (thread.truncated && value.state !== 'quiet') value = { ...value, state: 'unknown' }
    this.d.db.prepare(`UPDATE gmail_threads SET state=?,title=?,reason=?,quote=?,message_id=?,assessed_digest=?
      WHERE owner=? AND account_id=? AND thread_id=? AND digest=? AND grant_revision=?`)
      .run(value.state, value.title, value.reason, value.quote, value.messageId, thread.digest, owner, thread.accountId, thread.id, thread.digest, thread.grant)
  }
  markWaiting(owner: string, thread: MailThread, messageId: string): void {
    this.assess(owner, thread, { state: 'waiting', title: thread.subject, reason: '邮件已发送，等待对方回复',
      messageId, quote: thread.messages.find(m => m.id === messageId)?.text.slice(0, 200) ?? '' })
  }
  forget(owner: string): void {
    this.d.db.prepare('DELETE FROM gmail_threads WHERE owner=?').run(owner)
    this.d.db.prepare('DELETE FROM gmail_scan WHERE owner=?').run(owner)
  }
  source(thread: MailThread): string { return `gmail:${thread.accountId}:${thread.grant}:${thread.id}` }
  async checkSource(owner: string, ref: string, guard: Guard = () => {}) {
    const match = /^gmail:(\d{1,40}):(\d+):([a-f0-9]{1,40}|account)$/.exec(ref)
    const g = this.d.connections.view(owner)
    if (!match || g.accountId !== match[1] || g.revision !== Number(match[2])) throw new GmailError(403, '邮件来源的账号授权已变化。')
    const check = () => { guard(); this.d.connections.assertCurrent(owner, Number(match[2])) }
    check(); await this.d.connections.request(owner, g.revision, match[3] === 'account' ? '/profile' : `/threads/${match[3]}?format=minimal`, { assertCurrent: check }); check()
    return check
  }
}

export function gmailLink(email: string, id: string): string { return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${id}` }
export function mailAddressList(value: string): string[] {
  const matches = value.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}/g) ?? []
  return [...new Set(matches.filter(emailAddress).map(v => v.toLowerCase()))].slice(0, 100)
}
function parseMessage(raw: RawMessage): MailMessage {
  if (!/^[a-f0-9]{1,40}$/.test(raw.id ?? '') || !Number.isSafeInteger(Number(raw.internalDate)) || Number(raw.internalDate) < 0) throw new GmailError(502, '邮件来源信息不完整。')
  const headers = raw.payload?.headers ?? []
  const header = (name: string) => decodeHeader(headers.find(h => h.name?.toLowerCase() === name)?.value?.replace(/[\r\n]/g, ' ').slice(0, 2000) ?? '')
  let truncated = false, parts = 0
  const body = (part: Part, depth: number): string => {
    if (++parts > 150 || depth > 15) { truncated = true; return '' }
    if (part.filename) return '' // Attachments are not silently read or executed.
    if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
      if (part.body?.attachmentId) { truncated = true; return '' }
      let text = Buffer.from((part.body?.data ?? '').slice(0, 100000), 'base64url').toString('utf8')
      if ((part.body?.data?.length ?? 0) > 100000) truncated = true
      if (part.mimeType === 'text/html') text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      return text
    }
    const children = part.parts ?? [], plain = children.find(p => p.mimeType === 'text/plain' && !p.filename)
    return part.mimeType === 'multipart/alternative' && plain ? body(plain, depth + 1) : children.map(p => body(p, depth + 1)).join('\n')
  }
  const text = body(raw.payload ?? {}, 0)
  return { id: raw.id!, at: Number(raw.internalDate), from: header('from'), to: mailAddressList(header('to')), cc: mailAddressList(header('cc')),
    replyTo: mailAddressList(header('reply-to'))[0], subject: header('subject') || '（无主题）', text: text.slice(0, 12000),
    rfcId: header('message-id') || undefined, references: header('references') || undefined,
    labels: raw.labelIds ?? [], truncated: truncated || text.length > 12000 }
}

function decodeHeader(value: string): string {
  return value.replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?([A-Za-z0-9_-]+)\?([BQ])\?([^?]*)\?=/gi, (all, charset: string, encoding: string, data: string) => {
    try {
      const bytes = encoding.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1')
      return new TextDecoder(charset).decode(bytes)
    } catch { return all }
  })
}
