import { describe, it, expect } from 'vitest'
import { gmailFixture, mailMessage } from './helpers/gmail.js'

describe('Gmail source-grounded mailbox', () => {
  it('preserves source, full thread, actual sender and pagination without treating unread as a task', async () => {
    const f = await gmailFixture()
    f.intercept(async path => path.startsWith('/threads?') ? { status: 200, data: { threads: [{ id: 'abc' }], nextPageToken: 'page-two' } } : undefined)
    const page = await f.mailbox.search('alice', { limit: 10 })
    expect(page).toMatchObject({ complete: false, cursor: 'page-two' })
    expect(page.threads[0]).toMatchObject({ accountId: '12345', grant: 1, messages: [{ from: 'Bob <bob@example.com>', to: ['alice@example.com'] }] })
    expect(page.threads[0]!.url).toBe('https://mail.google.com/mail/u/?authuser=alice%40example.com#all/abc')
    expect(f.mailbox.items('alice')).toEqual([])
    f.db.close()
  })
  it('requires an exact quote and excludes already replied, uncertain and truncated messages', async () => {
    const f = await gmailFixture(), thread = await f.mailbox.thread('alice', 'abc')
    const value = { state: 'needs_reply' as const, title: 'Review plan', reason: 'Bob requested a review', quote: 'Please review', messageId: 'a1' }
    expect(() => f.mailbox.assess('alice', thread, { ...value, quote: 'fabricated request' })).toThrow('原文')
    f.mailbox.assess('alice', thread, value)
    expect(f.mailbox.items('alice')).toHaveLength(1)
    expect(f.mailbox.items('bob')).toEqual([])
    f.messages.push(mailMessage('a2', 'Reviewed, thanks.', true))
    const replied = await f.mailbox.thread('alice', 'abc')
    expect(f.mailbox.items('alice')).toEqual([]) // Stale assessment is hidden as soon as a new message arrives.
    f.mailbox.assess('alice', replied, value)
    expect(f.mailbox.items('alice')).toEqual([])
    f.mailbox.assess('alice', { ...thread, truncated: true }, value)
    expect(f.mailbox.items('alice')).toEqual([])
    f.db.close()
  })
  it('uses SENT evidence for waiting, not a spoofed From header', async () => {
    const f = await gmailFixture()
    f.messages[0]!.payload.headers[0]!.value = 'alice@example.com'
    const thread = await f.mailbox.thread('alice', 'abc')
    f.mailbox.assess('alice', thread, { state: 'waiting', title: 'Plan', reason: 'Asked Bob', quote: 'Please review', messageId: 'a1' })
    expect(f.mailbox.items('alice')).toEqual([])
    f.db.close()
  })
  it('decodes encoded headers and HTML without fetching images or treating attachments as text', async () => {
    const f = await gmailFixture()
    f.intercept(async path => path.startsWith('/threads/') ? { status: 200, data: { id: 'abc', messages: [{ ...mailMessage(), payload: {
      mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: '=?UTF-8?B?5pa55qGI?=\r\n =?UTF-8?B?6K+E5a6h?=' }], parts: [
        { mimeType: 'text/html', body: { data: Buffer.from('<style>hide</style><b>Please confirm.</b><img src="https://tracker.invalid">').toString('base64url') } },
        { mimeType: 'text/plain', filename: 'secret.txt', body: { data: Buffer.from('attachment data').toString('base64url') } },
      ] } }] } } : undefined)
    const thread = await f.mailbox.thread('alice', 'abc')
    expect(thread.subject).toBe('方案评审')
    expect(thread.messages[0]!.text).toContain('Please confirm.')
    expect(thread.messages[0]!.text).not.toMatch(/attachment data|tracker|hide/)
    f.db.close()
  })
  it('binds saved source reads to the account and current grant, including revocation during IO', async () => {
    const f = await gmailFixture(), thread = await f.mailbox.thread('alice', 'abc')
    await expect(f.mailbox.checkSource('bob', f.mailbox.source(thread))).rejects.toThrow('授权已变化')
    const check = await f.mailbox.checkSource('alice', f.mailbox.source(thread))
    f.connections.disconnect('alice', 1)
    expect(check).toThrow('范围已变化')
    expect(f.mailbox.items('alice')).toEqual([])
    await f.connect()
    const revision = f.connections.view('alice').revision
    f.intercept(async path => { if (path.startsWith('/threads/')) f.connections.disconnect('alice', revision); return undefined })
    await expect(f.mailbox.thread('alice', 'abc')).rejects.toThrow('范围已变化')
    f.db.close()
  })
})
