import { describe, it, expect } from 'vitest'
import { DesktopEmail } from '../src/personal/desktop-email.js'
import { EmailDrafts } from '../src/gmail/drafts.js'
import { gmailFixture } from './helpers/gmail.js'

async function fixture() {
  const f = await gmailFixture(), draft = await f.reply(), effects: (() => void)[] = [], jobs: Promise<void>[] = []
  let connected = true, sourceAvailable = true
  const guarded = new EmailDrafts({ db: f.db, connections: f.connections, mailbox: f.mailbox,
    authorize: async (_draft, guard) => { guard(); if (!sourceAvailable) throw new Error('source unavailable'); return () => { guard(); if (!sourceAvailable) throw new Error('source unavailable') } } })
  const view = new DesktopEmail({ drafts: guarded, defer: effect => effects.push(effect),
    background: work => { jobs.push(work()) }, changed: async () => {} })
  const guard = () => { if (!connected) throw new Error('device revoked') }
  const prepare = (command: unknown, owner = 'alice') => view.prepare(owner, command, guard)
  const flush = async () => { effects.splice(0).forEach(effect => effect()); await Promise.all(jobs.splice(0)) }
  return { ...f, draft, view, prepare, effects, flush, revoke: () => { connected = false }, denySource: () => { sourceAvailable = false } }
}

describe('same email draft through a paired desktop', () => {
  it('edits the exact Feishu draft, refuses a stale revision and never sends on save', async () => {
    const f = await fixture(), before = await f.prepare({ operation: 'email-get', id: f.draft.id })
    expect(before()).toMatchObject({ id: f.draft.id, revision: 1, body: f.draft.body })
    const save = await f.prepare({ operation: 'email-edit', id: f.draft.id, revision: 1, to: f.draft.to, subject: f.draft.subject, body: 'Desktop revision.' })
    f.db.exec('BEGIN'); expect(save()).toMatchObject({ id: f.draft.id, revision: 2 }); f.db.exec('COMMIT'); await f.flush()
    expect(f.drafts.get('alice', f.draft.id).body).toBe('Desktop revision.')
    expect(() => before()).toThrow('更新')
    const stale = await f.prepare({ operation: 'email-action', id: f.draft.id, revision: 1, action: 'send' })
    expect(stale).toThrow('更新')
    expect(f.calls.filter(c => c.path === '/messages/send')).toHaveLength(0)
    await expect(f.prepare({ operation: 'email-get', id: f.draft.id }, 'bob')).rejects.toThrow('没有找到')
    f.db.close()
  })
  it('rechecks source and device grants for a prepared read and hides unavailable draft content', async () => {
    const f = await fixture(), read = await f.prepare({ operation: 'email-get', id: f.draft.id })
    f.denySource(); expect(read).toThrow('source unavailable')
    const list = await f.prepare({ operation: 'email-list' })
    expect(list()).toMatchObject({ items: [], unavailable: 1 })
    f.revoke(); expect(list).toThrow('device revoked')
    f.db.close()
  })
  it('does not send inside a transaction or after rollback, and reconciles an ambiguous send instead of repeating it', async () => {
    const f = await fixture(), input = { operation: 'email-action', id: f.draft.id, revision: 1, action: 'send' }
    const rejected = await f.prepare(input)
    f.db.exec('BEGIN'); rejected(); f.db.exec('ROLLBACK'); f.effects.splice(0)
    await f.flush(); expect(f.calls.filter(c => c.path === '/messages/send')).toHaveLength(0)
    f.intercept(async path => { if (path === '/messages/send') throw new Error('socket closed') })
    const send = await f.prepare(input)
    f.db.exec('BEGIN'); expect(send()).toEqual({ id: f.draft.id, accepted: true })
    expect(f.calls.filter(c => c.path === '/messages/send')).toHaveLength(0)
    f.db.exec('COMMIT'); await f.flush()
    expect(f.drafts.get('alice', f.draft.id)).toMatchObject({ state: 'uncertain', revision: 2 })
    const again = await f.prepare({ ...input, revision: 2 })
    expect(again).toThrow('回执')
    const check = await f.prepare({ ...input, revision: 2, action: 'reconcile' }); check(); await f.flush()
    expect(f.calls.filter(c => c.path === '/messages/send')).toHaveLength(1)
    f.db.close()
  })
  it('lets device revocation or a newer Feishu edit win before the after-commit dispatch', async () => {
    const f = await fixture(), send = await f.prepare({ operation: 'email-action', id: f.draft.id, revision: 1, action: 'send' })
    send(); f.drafts.edit('alice', f.draft.id, 1, { to: f.draft.to, subject: f.draft.subject, body: 'Edited in Feishu.' }); await f.flush()
    expect(f.calls.filter(c => c.path === '/messages/send')).toHaveLength(0)
    const second = await f.prepare({ operation: 'email-action', id: f.draft.id, revision: 2, action: 'send' })
    second(); f.revoke(); await f.flush()
    expect(f.calls.filter(c => c.path === '/messages/send')).toHaveLength(0)
    expect(f.drafts.get('alice', f.draft.id).state).toBe('draft')
    f.db.close()
  })
  it('returns a real provider receipt after one explicit send and exposes no source manifest or credentials', async () => {
    const f = await fixture(), send = await f.prepare({ operation: 'email-action', id: f.draft.id, revision: 1, action: 'send' })
    send(); await f.flush()
    const read = (await f.prepare({ operation: 'email-get', id: f.draft.id }))() as Record<string, unknown>
    expect(read).toMatchObject({ state: 'sent', url: expect.stringContaining('#all/abc') })
    expect(read.source).toBeUndefined(); expect(read.accountId).toBeUndefined()
    expect(f.calls.filter(c => c.path === '/messages/send')).toHaveLength(1)
    f.db.close()
  })
})
