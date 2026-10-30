import { DatabaseSync } from 'node:sqlite'
import { GmailConnections, GMAIL_READ, GMAIL_SEND, type GmailHttp } from '../../src/gmail/connection.js'
import { GmailMailbox } from '../../src/gmail/mailbox.js'
import { EmailDrafts } from '../../src/gmail/drafts.js'

export function mailMessage(id = 'a1', text = 'Please review the plan by Friday.', sent = false, threadId = 'abc') {
  return { id, threadId, internalDate: String(1_790_000_000_000 + parseInt(id, 16)), labelIds: sent ? ['SENT'] : ['INBOX'],
    payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: sent ? 'alice@example.com' : 'Bob <bob@example.com>' },
      { name: 'To', value: sent ? 'bob@example.com' : 'alice@example.com' },
      { name: 'Subject', value: 'Plan review' }, { name: 'Message-ID', value: `<${id}@example.com>` },
    ], body: { data: Buffer.from(text).toString('base64url') } } }
}
export async function gmailFixture(send = true, db = new DatabaseSync(':memory:')) {
  let now = 1_790_000_000_000, email = 'alice@example.com', accountId = '12345'
  const messages = [mailMessage()], calls: { path: string; input: Parameters<GmailHttp>[1] }[] = []
  let handler: ((path: string, input: Parameters<GmailHttp>[1]) => Promise<{ status: number; data: unknown } | undefined>) | undefined
  const connections = new GmailConnections({ db, key: Buffer.alloc(32, 3), now: () => now,
    config: { clientId: 'test-client', clientSecret: 'test-secret', redirectUri: 'https://example.com/gmail/callback', relayToken: 'x'.repeat(32) },
    http: async (path, input) => {
      calls.push({ path, input })
      const override = await handler?.(path, input)
      if (override) return override
      if (path === '/token') return { status: 200, data: { token_type: 'Bearer', access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, scope: [GMAIL_READ, GMAIL_SEND].join(' ') } }
      if (path === '/identity') return { status: 200, data: { sub: accountId, email, email_verified: true } }
      if (path === '/profile') return { status: 200, data: { emailAddress: email } }
      if (path.startsWith('/threads?')) return { status: 200, data: { threads: [{ id: 'abc' }] } }
      if (path.startsWith('/threads/')) return { status: 200, data: { id: 'abc', messages } }
      if (path === '/messages/send') return { status: 200, data: { id: 'b2', threadId: 'abc' } }
      if (path.startsWith('/messages?')) return { status: 200, data: { messages: [] } }
      throw new Error(`Unexpected mock path: ${path}`)
    } })
  const connect = async (owner = 'alice', allowSend = send) => {
    const state = new URL(connections.begin(owner, allowSend).url).searchParams.get('state')!
    return connections.complete(state, owner, 'test-code')
  }
  await connect()
  const mailbox = new GmailMailbox({ db, connections, now: () => now })
  const drafts = new EmailDrafts({ db, connections, mailbox, now: () => now })
  return { db, calls, connections, mailbox, drafts, messages, connect, now: () => now,
    advance: (ms: number) => { now += ms }, intercept: (fn: typeof handler) => { handler = fn },
    account: (id: string, address: string) => { accountId = id; email = address },
    reply: async () => drafts.create('alice', { to: ['bob@example.com'], subject: 'Plan review', body: 'I will review the plan.' }, await mailbox.thread('alice', 'abc')) }
}
