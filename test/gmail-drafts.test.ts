import { describe, it, expect } from 'vitest'
import { EmailDrafts, encodeMessage } from '../src/gmail/drafts.js'
import { GmailError } from '../src/gmail/connection.js'
import { gmailFixture, mailMessage } from './helpers/gmail.js'

describe('persisted personal email drafts and sending', () => {
  it('revalidates retained working context before displaying or sending a draft', async () => {
    const f = await gmailFixture(), draft = await f.reply()
    let permitted = true
    const guarded = new EmailDrafts({ db: f.db, connections: f.connections, mailbox: f.mailbox,
      authorize: async (_draft, guard) => { guard(); if (!permitted) throw new Error('SOURCE_UNAVAILABLE'); return () => { guard(); if (!permitted) throw new Error('SOURCE_UNAVAILABLE') } } })
    const check = await guarded.authorize('alice', draft.id)
    permitted = false; expect(check).toThrow('SOURCE_UNAVAILABLE')
    await expect(guarded.humanSend('alice', draft.id, 1, () => {})).rejects.toThrow('SOURCE_UNAVAILABLE')
    expect(f.calls.some(c => c.path === '/messages/send')).toBe(false)
    expect(guarded.get('alice', draft.id).state).toBe('draft')
    f.db.close()
  })
  it('keeps one editable version, rejects stale edits, malformed headers and another owner', async () => {
    const f = await gmailFixture(), draft = await f.reply()
    const content = { to: draft.to, subject: draft.subject, body: 'Updated draft.' }
    const edited = f.drafts.edit('alice', draft.id, 1, content)
    expect(edited).toMatchObject({ id: draft.id, revision: 2, state: 'draft' })
    expect(() => f.drafts.edit('alice', draft.id, 1, content)).toThrow('已更新')
    expect(() => f.drafts.get('bob', draft.id)).toThrow('没有找到')
    expect(() => f.drafts.create('alice', { ...content, subject: 'Hello\r\nBcc: nobody@example.com' })).toThrow('有效收件人')
    expect(() => f.drafts.create('alice', { ...content, to: ['bob@example.com\r\nBcc: nobody@example.com'] })).toThrow()
    const cancelled = f.drafts.cancel('alice', draft.id, 2)
    await expect(f.drafts.humanSend('alice', draft.id, cancelled.revision, () => {})).rejects.toThrow('已更新')
    expect(f.calls.filter(c => c.path === '/messages/send')).toHaveLength(0)
    f.db.close()
  })
  it('stops an old reply after a new message, and can update the same draft against freshly read context', async () => {
    const f = await gmailFixture(), draft = await f.reply()
    f.messages.push(mailMessage('a2', 'Please use the revised plan.'))
    await expect(f.drafts.humanSend('alice', draft.id, 1, () => {})).rejects.toThrow('新回复')
    expect(f.drafts.get('alice', draft.id).state).toBe('draft')
    const edited = f.drafts.edit('alice', draft.id, 1, { to: draft.to, subject: draft.subject, body: 'I will review the revised plan.' }, await f.mailbox.thread('alice', 'abc'))
    expect(edited.replyMessageId).toBe('a2')
    expect(await f.drafts.humanSend('alice', draft.id, 2, () => {})).toMatchObject({ state: 'sent', messageId: 'b2', id: draft.id })
    f.db.close()
  })
  it('sends only once for concurrent clicks and keeps an actual receipt', async () => {
    const f = await gmailFixture(), draft = await f.reply()
    const results = await Promise.allSettled([f.drafts.humanSend('alice', draft.id, 1, () => {}), f.drafts.humanSend('alice', draft.id, 1, () => {})])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(f.calls.filter(c => c.path === '/messages/send')).toHaveLength(1)
    expect(f.drafts.receiptUrl(f.drafts.get('alice', draft.id))).toContain('#all/abc')
    f.db.close()
  })
  it('does not resend after an ambiguous network result or restart; only an exact sent receipt resolves it', async () => {
    const f = await gmailFixture(), draft = await f.reply()
    f.intercept(async path => { if (path === '/messages/send') throw new Error('socket closed'); return undefined })
    await expect(f.drafts.humanSend('alice', draft.id, 1, () => {})).rejects.toThrow('不会自动重复发送')
    const restarted = new EmailDrafts({ db: f.db, connections: f.connections, mailbox: f.mailbox })
    expect(restarted.get('alice', draft.id).state).toBe('uncertain')
    await expect(restarted.humanSend('alice', draft.id, 2, () => {})).rejects.toThrow('正在发送')
    expect((await restarted.reconcile('alice', draft.id, () => {})).state).toBe('uncertain')
    const sent = mailMessage('b2', draft.body, true)
    sent.payload.headers.find(h => h.name === 'Subject')!.value = draft.subject
    sent.payload.headers.find(h => h.name === 'Message-ID')!.value = draft.rfcId
    f.messages.push(sent)
    f.intercept(async path => path.startsWith('/messages?') ? { status: 200, data: { messages: [{ id: 'b2', threadId: 'abc' }] } } : undefined)
    expect(await restarted.reconcile('alice', draft.id, () => {})).toMatchObject({ state: 'sent', messageId: 'b2' })
    expect(f.calls.filter(c => c.path === '/messages/send')).toHaveLength(1)
    f.db.close()
  })
  it('returns a definitively rejected send to an editable draft', async () => {
    const f = await gmailFixture(), draft = await f.reply()
    f.intercept(async path => path === '/messages/send' ? { status: 429, data: {} } : undefined)
    await expect(f.drafts.humanSend('alice', draft.id, 1, () => {})).rejects.toThrow('未完成')
    expect(f.drafts.get('alice', draft.id)).toMatchObject({ state: 'draft', revision: 2 })
    f.db.close()
  })
  it('keeps a never-dispatched draft editable when token refresh temporarily fails', async () => {
    const f = await gmailFixture(), draft = f.drafts.create('alice', { to: ['alice@example.com'], subject: 'Self check', body: 'Synthetic acceptance only.' })
    f.advance(3600001)
    f.intercept(async path => path === '/token' ? { status: 503, data: {} } : undefined)
    await expect(f.drafts.humanSend('alice', draft.id, 1, () => {})).rejects.toThrow('暂未刷新')
    expect(f.calls.filter(c => c.path === '/messages/send')).toHaveLength(0)
    expect(f.drafts.get('alice', draft.id)).toMatchObject({ state: 'draft', revision: 2 })
    expect(f.connections.view('alice').status).toBe('connected')
    f.intercept(undefined)
    expect(await f.drafts.humanSend('alice', draft.id, 2, () => {})).toMatchObject({ state: 'sent' })
    expect(f.calls.filter(c => c.path === '/messages/send')).toHaveLength(1)
    f.db.close()
  })
  it('does not mistake a local permission refusal after dispatch for a provider rejection', async () => {
    const f = await gmailFixture(), draft = f.drafts.create('alice', { to: ['alice@example.com'], subject: 'Self check', body: 'Synthetic acceptance only.' })
    let permitted = true
    f.intercept(async path => { if (path === '/messages/send') permitted = false; return undefined })
    const guard = () => { if (!permitted) throw new GmailError(403, 'Source permission withdrawn') }
    await expect(f.drafts.humanSend('alice', draft.id, 1, guard)).rejects.toThrow('withdrawn')
    expect(f.drafts.get('alice', draft.id).state).toBe('uncertain')
    await expect(f.drafts.humanSend('alice', draft.id, 2, () => {})).rejects.toThrow('正在发送')
    expect(f.calls.filter(c => c.path === '/messages/send')).toHaveLength(1)
    f.db.close()
  })
  it('keeps the draft when its owner enables sending on the same account, but hides it from a different account', async () => {
    const f = await gmailFixture(false), draft = await f.reply()
    await expect(f.drafts.humanSend('alice', draft.id, 1, () => {})).rejects.toThrow('允许 Gmail 发送')
    await f.connect('alice', true)
    expect(f.drafts.get('alice', draft.id).id).toBe(draft.id)
    await expect(f.drafts.humanSend('alice', draft.id, 1, () => {})).resolves.toMatchObject({ state: 'sent' })
    f.account('98765', 'other@example.com'); await f.connect('alice', true)
    expect(() => f.drafts.get('alice', draft.id)).toThrow('原账号')
    expect(f.drafts.list('alice')).toEqual([])
    f.db.close()
  })
  it('serializes Unicode, long subjects and thread headers as valid MIME', async () => {
    const f = await gmailFixture(), draft = await f.reply()
    draft.subject = '评审方案'.repeat(35); draft.body = '第一行\n第二行 😀'
    const mime = Buffer.from(encodeMessage(draft), 'base64url').toString()
    const [headers, body] = mime.split('\r\n\r\n')
    expect(headers).toContain('In-Reply-To: <a1@example.com>')
    expect(headers).toContain(`Message-ID: ${draft.rfcId}`)
    const encoded = headers!.match(/=\?UTF-8\?B\?[^?]+\?=/g)!
    expect(encoded.every(word => word.length <= 75)).toBe(true)
    expect(encoded.map(word => Buffer.from(word.slice(10, -2), 'base64').toString()).join('')).toBe(draft.subject)
    expect(Buffer.from(body!, 'base64').toString()).toBe('第一行\r\n第二行 😀')
    f.db.close()
  })
})
