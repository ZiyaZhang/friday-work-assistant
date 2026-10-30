import { describe, it, expect, vi } from 'vitest'
import { GmailCollector } from '../src/gmail/collector.js'
import { gmailFixture, mailMessage } from './helpers/gmail.js'

const assess = (state = 'needs_reply', messageId = 'a1', quote = 'Please review') => JSON.stringify({ state, messageId, quote, title: 'Review plan', reason: 'Bob is asking for a review' })
describe('continuous Gmail collection', () => {
  it('advances pages, skips unchanged material, and removes a replied request without finishing a project', async () => {
    const f = await gmailFixture(), run = vi.fn(async () => assess()), changed = vi.fn(async () => {})
    const c = new GmailCollector({ ...f, enabled: () => true, assertActive: () => {}, run, onChange: changed })
    await c.tick()
    expect(f.mailbox.items('alice')[0]).toMatchObject({ state: 'needs_reply', title: 'Review plan' })
    expect(f.mailbox.scanStatus('alice')).toMatchObject({ state: 'current', checkedAt: f.now() })
    await c.tick(); expect(run).toHaveBeenCalledTimes(1)
    f.advance(5 * 60_000); await c.tick(); expect(run).toHaveBeenCalledTimes(1)
    f.messages.push(mailMessage('a2', 'Reviewed, thanks.', true))
    run.mockResolvedValue(assess('quiet', 'a2', '')); f.advance(5 * 60_000); await c.tick()
    expect(f.mailbox.items('alice')).toEqual([])
    expect(f.calls.some(call => call.path === '/messages/send')).toBe(false)
    f.db.close()
  })
  it('continues other mail and pagination after a malformed classification, then retries the unresolved thread', async () => {
    const f = await gmailFixture()
    f.intercept(async path => {
      if (path.startsWith('/threads?')) return { status: 200, data: { threads: [{ id: 'abc' }, { id: 'def' }], nextPageToken: 'next' } }
      if (path.startsWith('/threads/def')) return { status: 200, data: { id: 'def', messages: [mailMessage('d1', 'Please review second plan.', false, 'def')] } }
      return undefined
    })
    const run = vi.fn(async (prompt: string) => prompt.includes('"id":"abc"') ? 'bad json' : assess('needs_reply', 'd1', 'Please review second'))
    const c = new GmailCollector({ ...f, enabled: () => true, assertActive: () => {}, run })
    await c.tick()
    expect(f.mailbox.items('alice').map(i => i.thread.id)).toEqual(['def'])
    expect(f.db.prepare('SELECT state,page_token FROM gmail_scan').get()).toMatchObject({ state: 'partial', page_token: 'next' })
    expect(f.mailbox.unassessed('alice').map(t => t.id)).toEqual(['abc'])
    f.advance(30_000); run.mockResolvedValue(assess()); await c.tick()
    expect(f.calls.some(call => call.path.includes('pageToken=next'))).toBe(true)
    expect(f.mailbox.items('alice')).toHaveLength(2)
    f.db.close()
  })
  it('forgets the old page cursor when reconnecting even if the next request fails', async () => {
    const f = await gmailFixture()
    f.db.prepare("INSERT INTO gmail_scan(owner,grant_revision,page_token,state) VALUES ('alice',1,'old-page','history')").run()
    await f.connect()
    f.intercept(async path => { if (path.startsWith('/threads?')) throw new Error('temporary outage'); return undefined })
    const c = new GmailCollector({ ...f, enabled: () => true, assertActive: () => {}, run: async () => assess() })
    await expect(c.tick()).rejects.toThrow('temporary outage')
    expect(f.db.prepare('SELECT grant_revision,page_token,state FROM gmail_scan').get()).toMatchObject({ grant_revision: 2, page_token: null, state: 'retrying' })
    f.db.close()
  })
  it('rotates owners and discards a model result if collection was paused while awaiting it', async () => {
    const f = await gmailFixture(); await f.connect('bob')
    let enabled = true
    const run = vi.fn(async () => { enabled = false; return assess() })
    const c = new GmailCollector({ ...f, enabled: () => enabled, assertActive: () => {}, run })
    await expect(c.tick()).rejects.toThrow('收集已暂停')
    expect(f.mailbox.items('alice')).toEqual([])
    enabled = true; run.mockImplementation(async () => assess()); await c.tick()
    expect(f.mailbox.items('bob')).toHaveLength(1)
    f.db.close()
  })
})
