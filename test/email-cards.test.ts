import { describe, it, expect, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { EmailCards } from '../src/feishu/email-cards.js'
import type { CardAction } from '../src/feishu/ws.js'
import { gmailFixture } from './helpers/gmail.js'

describe('personal email cards', () => {
  it('keeps actions horizontal, preserves a recovery action after restart, and never labels sending as completion', async () => {
    const f = await gmailFixture(), registry = new Registry(':memory:'), draft = await f.reply()
    const feishu = { sendToUserOnce: vi.fn(async () => 'card-1'), patchCard: vi.fn(async () => {}) }
    const pending: (() => Promise<void>)[] = []
    const cards = new EmailCards({ registry, drafts: f.drafts, feishu, audience: () => ({ chatId: 'dm-alice' }), assertActive: () => {}, background: fn => pending.push(fn) })
    await cards.show('alice', draft.id); await cards.show('alice', draft.id)
    expect(feishu.sendToUserOnce).toHaveBeenCalledTimes(1)
    expect(feishu.sendToUserOnce.mock.calls[0]![2]).toBe(`email-draft-${draft.id}`)
    const rendered = cards.render(draft)
    expect(JSON.stringify(rendered)).toContain('column_set')
    expect(JSON.stringify(cards.render({ ...draft, state: 'sending' }))).toContain('核对发送结果')
    expect(JSON.stringify(cards.render({ ...draft, state: 'sent' }))).not.toContain('等待对方回复')
    const event = { operatorOpenId: 'alice', chatId: 'dm-alice', messageId: 'card-1', value: { action: 'email_draft', op: 'send', id: draft.id, revision: 1 } } as CardAction
    expect(cards.handle({ ...event, operatorOpenId: 'bob' })).toMatchObject({ toast: { type: 'error' } })
    expect(cards.handle({ ...event, chatId: 'group' })).toMatchObject({ toast: { type: 'error' } })
    cards.handle(event); cards.handle(event)
    expect(pending).toHaveLength(1)
    await pending[0]!()
    expect(f.calls.filter(c => c.path === '/messages/send')).toHaveLength(1)
    expect(JSON.stringify(feishu.patchCard.mock.calls.at(-1))).toContain('已发送')
    registry.close(); f.db.close()
  })
  it('takes edits only from actual form values, not the callback payload', async () => {
    const f = await gmailFixture(), registry = new Registry(':memory:'), draft = await f.reply()
    const cards = new EmailCards({ registry, drafts: f.drafts, feishu: { sendToUserOnce: async () => 'card-1', patchCard: async () => {} },
      audience: () => ({ chatId: 'dm-alice' }), assertActive: () => {}, background: () => {} })
    await cards.show('alice', draft.id)
    const event = { operatorOpenId: 'alice', chatId: 'dm-alice', messageId: 'card-1', value: { action: 'email_draft', op: 'save', id: draft.id, revision: 1, body: 'not form data' } } as CardAction
    expect(cards.handle(event)).toMatchObject({ toast: { type: 'error' } })
    cards.handle({ ...event, formValue: { to: 'bob@example.com', subject: 'ignored reply subject', body: 'Shorter reply.' } })
    expect(f.drafts.get('alice', draft.id)).toMatchObject({ revision: 2, body: 'Shorter reply.', subject: draft.subject })
    registry.close(); f.db.close()
  })
  it('preserves a long body when the native form can only edit its envelope', async () => {
    const f = await gmailFixture(), registry = new Registry(':memory:')
    const body = '邮件正文。'.repeat(250)
    const draft = f.drafts.create('alice', { to: ['bob@example.com'], subject: 'Long draft', body })
    const cards = new EmailCards({ registry, drafts: f.drafts, feishu: { sendToUserOnce: async () => 'long-card', patchCard: async () => {} },
      audience: () => ({ chatId: 'dm-alice' }), assertActive: () => {}, background: () => {} })
    await cards.show('alice', draft.id)
    const rendered = JSON.stringify(cards.render(draft, true))
    expect(rendered).toContain(body)
    expect(rendered).not.toContain('"name":"body"')
    cards.handle({ operatorOpenId: 'alice', chatId: 'dm-alice', messageId: 'long-card',
      value: { action: 'email_draft', op: 'save', id: draft.id, revision: 1 },
      formValue: { to: 'carol@example.com', subject: 'New subject' } } as CardAction)
    expect(f.drafts.get('alice', draft.id)).toMatchObject({ revision: 2, body, to: ['carol@example.com'], subject: 'New subject' })
    registry.close(); f.db.close()
  })
})
