import { describe, it, expect, vi } from 'vitest'
import { createGmailRoutes } from '../src/internal/gmail-routes.js'
import { gmailFixture, mailMessage } from './helpers/gmail.js'

async function setup() {
  const f = await gmailFixture(), record = vi.fn(), showDraft = vi.fn(async () => {})
  let current = true
  const routes = createGmailRoutes<string>({ ...f, requireRun: owner => ({ owner, assertCurrent: () => { if (!current) throw new Error('run stopped') } }),
    record, showDraft, error: (status, message) => Object.assign(new Error(message), { status }) })
  const call = (op: string, body: Record<string, unknown> = {}, owner = 'alice') => routes[`POST /v1/gmail/${op}`]!(owner, body)
  return { ...f, routes, call, record, showDraft, stop: () => { current = false } }
}

describe('Gmail model boundary', () => {
  it('has no send route, takes ownership from the run and rejects injected owner or recipient overrides', async () => {
    const f = await setup()
    expect(Object.keys(f.routes).some(key => key.includes('/send'))).toBe(false)
    await expect(f.call('search', { owner: 'bob' })).rejects.toMatchObject({ status: 400 })
    await expect(f.call('drafts', { owner: 'bob' })).rejects.toMatchObject({ status: 400 })
    await expect(f.call('inbox', {}, 'bob')).rejects.toMatchObject({ status: 409 })
    f.db.close()
  })
  it('preserves draft identity, records real source evidence, and requires the newest message when rebasing a reply', async () => {
    const f = await setup(), content = { to: ['bob@example.com'], subject: 'Plan review', body: 'I will review.', thread_id: 'abc' }
    const first = await f.call('draft', content) as { draft: { id: string; subject: string } }
    expect(f.showDraft).toHaveBeenCalledWith('alice', first.draft.id)
    expect(f.record).toHaveBeenCalledWith('alice', expect.objectContaining({ id: 'abc' }))
    f.messages.push(mailMessage('a2', 'Use the revised plan.'))
    const edit = { ...content, subject: first.draft.subject, id: first.draft.id, revision: 1 }
    await expect(f.call('draft', edit)).rejects.toMatchObject({ status: 409 })
    expect(f.drafts.get('alice', first.draft.id).revision).toBe(1)
    const result = await f.call('draft', { ...edit, source_message_id: 'a2', body: 'I will use the revised plan.' }) as { draft: { id: string; revision: number } }
    expect(result.draft).toMatchObject({ id: first.draft.id, revision: 2 })
    f.db.close()
  })
  it('does not persist or deliver after the run stops while reading the original thread', async () => {
    const f = await setup()
    f.intercept(async path => { if (path.startsWith('/threads/')) f.stop(); return undefined })
    await expect(f.call('draft', { to: ['bob@example.com'], subject: 'Plan', body: 'Reply', thread_id: 'abc' })).rejects.toThrow('run stopped')
    expect(f.drafts.list('alice')).toEqual([])
    expect(f.showDraft).not.toHaveBeenCalled()
    f.db.close()
  })
})
