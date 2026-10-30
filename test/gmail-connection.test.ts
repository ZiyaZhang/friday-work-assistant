import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { GmailConnections, GMAIL_READ, GMAIL_SEND, type GmailHttp } from '../src/gmail/connection.js'

function fixture() {
  const db = new DatabaseSync(':memory:'), calls: { path: string; input: Parameters<GmailHttp>[1] }[] = []
  let now = 1_790_000_000_000, sub = '12345', email = 'alice@example.com', scopes = [GMAIL_READ], tokenStatus = 200
  let beforeReply: ((path: string) => void) | undefined
  const http = vi.fn<GmailHttp>(async (path, input) => {
    calls.push({ path, input }); beforeReply?.(path)
    if (path === '/token') return { status: tokenStatus, data: { token_type: 'Bearer', access_token: 'google-test-access', refresh_token: 'google-test-refresh', expires_in: 3600, scope: scopes.join(' ') } }
    if (path === '/identity') return { status: 200, data: { sub, email, email_verified: true } }
    if (path === '/profile') return { status: 200, data: { emailAddress: email } }
    return { status: 200, data: { messages: [], id: 'abc123' } }
  })
  const connections = new GmailConnections({ db, key: Buffer.alloc(32, 2), now: () => now, http,
    config: { clientId: 'client', clientSecret: 'client-secret', redirectUri: 'https://example.com/gmail/callback', relayToken: 'x'.repeat(32) } })
  const begin = (owner = 'alice', send = false) => new URL(connections.begin(owner, send).url).searchParams.get('state')!
  const connect = async (owner = 'alice', send = false) => connections.complete(begin(owner, send), owner, 'code')
  return { db, calls, http, connections, begin, connect, advance: (ms: number) => { now += ms },
    account: (id: string, address: string) => { sub = id; email = address }, scopes: (value: string[]) => { scopes = value },
    status: (value: number) => { tokenStatus = value }, intercept: (fn: (path: string) => void) => { beforeReply = fn } }
}

describe('personal Gmail authorization', () => {
  it('binds the verified account to one owner and encrypts all credentials', async () => {
    const f = fixture(), view = await f.connect()
    expect(view).toMatchObject({ status: 'connected', revision: 1, accountId: '12345', email: 'alice@example.com', canSend: false })
    expect(f.connections.view('bob').status).toBe('disconnected')
    expect(String(f.db.prepare('SELECT secret FROM gmail_connections').get()!.secret)).not.toContain('google-test')
    expect(f.calls.find(c => c.path === '/token')!.input.form!.code_verifier).toHaveLength(43)
    expect(f.connections.pending()).toHaveLength(0)
  })
  it('does not enable sending from a broader cached Google grant without the sending choice', async () => {
    const f = fixture(); f.scopes([GMAIL_READ, GMAIL_SEND]); await f.connect()
    await expect(f.connections.request('alice', 1, '/messages/send', { body: { raw: 'YWJj' } })).rejects.toThrow('不允许')
    expect(f.calls.some(c => c.path === '/messages/send')).toBe(false)
    await f.connect('alice', true)
    await expect(f.connections.request('alice', 2, '/messages/send', { body: { raw: 'YWJj' } })).resolves.toMatchObject({ id: 'abc123' })
  })
  it('rejects cross-owner, callback replay, expired attempts and cancelled setup', async () => {
    const f = fixture(), state = f.begin()
    await expect(f.connections.complete(state, 'bob', 'code')).rejects.toThrow('失效')
    await f.connections.complete(state, 'alice', 'code')
    await expect(f.connections.complete(state, 'alice', 'code')).rejects.toThrow('失效')
    const expired = f.begin(); f.advance(10 * 60_000)
    await expect(f.connections.complete(expired, 'alice', 'code')).rejects.toThrow('失效')
    const cancelled = f.begin(); f.connections.cancelPending('alice')
    await expect(f.connections.complete(cancelled, 'alice', 'code')).rejects.toThrow('失效')
  })
  it('does not replace the working connection when a new account fails authorization', async () => {
    const f = fixture(); await f.connect(); f.status(400)
    await expect(f.connect()).rejects.toThrow('授权暂不可用')
    expect(f.connections.view('alice')).toMatchObject({ status: 'connected', revision: 1 })
  })
  it('rejects a late callback or data reply after disconnect', async () => {
    const f = fixture(); await f.connect()
    f.intercept(path => { if (path === '/identity') f.connections.disconnect('alice', 1) })
    await expect(f.connect()).rejects.toThrow('设置已变化')
    expect(f.connections.view('alice').status).toBe('disconnected')
    f.intercept(() => {}); await f.connect()
    const revision = f.connections.view('alice').revision
    f.intercept(path => { if (path === '/messages') f.connections.disconnect('alice', revision) })
    await expect(f.connections.request('alice', revision, '/messages')).rejects.toThrow('范围已变化')
  })
  it('refreshes once for concurrent reads; a revoked refresh stops future reads', async () => {
    const f = fixture(); await f.connect(); f.advance(3600_000)
    await Promise.all([f.connections.request('alice', 1, '/messages'), f.connections.request('alice', 1, '/threads')])
    expect(f.calls.filter(c => c.input.form?.grant_type === 'refresh_token')).toHaveLength(1)
    f.advance(3600_000); f.http.mockResolvedValueOnce({ status: 400, data: { error: 'invalid_grant' } })
    await expect(f.connections.request('alice', 1, '/messages')).rejects.toThrow('已过期')
    expect(f.connections.view('alice').status).toBe('needs_connection')
  })
  it.each([
    { status: 429, data: {} }, { status: 503, data: {} },
    { status: 401, data: { error: 'invalid_client' } },
    { status: 400, data: { error: 'unsupported_grant_type' } },
    { status: 200, data: {} },
  ])('preserves the mailbox connection after a temporary or configuration failure: %j', async reply => {
    const f = fixture(); await f.connect(); f.advance(3600_000)
    const before = f.db.prepare('SELECT secret,token_version FROM gmail_connections').get()
    f.http.mockResolvedValueOnce(reply)
    await expect(f.connections.request('alice', 1, '/messages')).rejects.toMatchObject({ status: 503 })
    expect(f.connections.view('alice')).toMatchObject({ status: 'connected', revision: 1 })
    expect(f.db.prepare('SELECT secret,token_version FROM gmail_connections').get()).toEqual(before)
    await expect(f.connections.request('alice', 1, '/messages')).resolves.toMatchObject({ messages: [] })
  })
  it('does not revoke a refreshed connection when an older request receives a late 401', async () => {
    const f = fixture(); await f.connect()
    let entered!: () => void, respond!: (reply: { status: number; data: unknown }) => void
    const started = new Promise<void>(resolve => { entered = resolve })
    f.http.mockImplementationOnce(async () => { entered(); return new Promise(resolve => { respond = resolve }) })
    const oldRead = f.connections.request('alice', 1, '/messages')
    await started; f.advance(3600_000)
    await expect(f.connections.request('alice', 1, '/threads')).resolves.toMatchObject({ messages: [] })
    respond({ status: 401, data: {} })
    await expect(oldRead).rejects.toMatchObject({ status: 409 })
    expect(f.connections.view('alice')).toMatchObject({ status: 'connected', revision: 1 })
    await expect(f.connections.request('alice', 1, '/messages')).resolves.toMatchObject({ messages: [] })
  })
  it('refuses user-selected hosts, other users, mutations and missing read scopes', async () => {
    const f = fixture(); await f.connect()
    for (const path of ['https://example.com', '//evil.test', '/../users/bob/messages', '/messages/send', '/settings/filters'])
      await expect(f.connections.request('alice', 1, path)).rejects.toThrow()
    f.scopes([GMAIL_SEND])
    await expect(f.connect()).rejects.toThrow('允许读取')
    expect(f.connections.view('alice').revision).toBe(1)
  })
})
