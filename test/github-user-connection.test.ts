import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createHash, publicEncrypt } from 'node:crypto'
import { GitHubUserConnections, type GitHubUserHttp } from '../src/github/user-connection.js'
import { personalGitHubLane } from '../src/github/personal-lane.js'
import { createLogger } from '../src/log.js'
import { GitHubIdentity, type GitHubHttp } from '../src/github/identity.js'

const log = createLogger('test', 'error'), dbs: DatabaseSync[] = []
afterEach(() => dbs.splice(0).forEach(db => db.close()))
function fixture(temporaryReader?: GitHubIdentity) {
  const db = new DatabaseSync(':memory:'); dbs.push(db)
  const clock = { now: Date.parse('2026-09-30T12:00:00Z') }
  const http = vi.fn<GitHubUserHttp>(async (path, input) => {
    if (path === '/login/oauth/access_token') return { status: 200, data: { access_token: `ghu_${input.form?.code ?? 'refreshed'}`, token_type: 'bearer', expires_in: 28800,
      refresh_token: 'ghr_syntheticrefresh', refresh_token_expires_in: 15897600 } }
    if (path === '/user') return { status: 200, data: { id: input.token === 'ghu_alice' ? 101 : 202, login: input.token === 'ghu_alice' ? 'alice' : 'bob' } }
    return { status: 200, data: { using: input.token } }
  })
  const deps = { db, key: Buffer.alloc(32, 7), now: () => clock.now, http, log, temporaryReader, tokenRelay: { baseUrl: 'https://example.test', token: 'synthetic-relay-token' },
    config: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', redirectUri: 'https://example.test/github/callback', relayToken: 'synthetic-relay-token' } }
  const connections = new GitHubUserConnections(deps)
  const connect = async (owner: string, code = owner) => {
    const url = new URL(connections.begin(owner).url)
    await connections.complete(url.searchParams.get('state')!, owner, code)
    return url
  }
  return { db, clock, http, deps, connections, connect }
}
describe('owner-bound GitHub connections', () => {
  it('requires a real code exchange and verified account, uses PKCE and encrypts both tokens and verifiers', async () => {
    const f = fixture(), url = await f.connect('alice')
    const exchange = f.http.mock.calls.find(([path]) => path === '/login/oauth/access_token')![1]
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(exchange.form!.code_verifier!).digest('base64url'))
    expect(url.searchParams.get('scope')).toBeNull()
    expect(url.searchParams.get('state')).toMatch(/^gh1\./)
    expect(f.connections.view('alice')).toMatchObject({ status: 'connected', login: 'alice', accountId: 101, revision: 1 })
    expect(JSON.stringify(f.db.prepare('SELECT * FROM github_user_connections').all())).not.toMatch(/ghu_alice|ghr_syntheticrefresh/)
    expect(f.db.prepare('SELECT count(*) n FROM github_user_attempts').get()?.n).toBe(0)
    expect(() => f.connections.reader('bob')).toThrow('连接自己的 GitHub')
  })
  it('rejects wrong owner, reused, expired and superseded attempts', async () => {
    const f = fixture(), first = new URL(f.connections.begin('alice').url).searchParams.get('state')!
    await expect(f.connections.complete(first, 'bob', 'bob')).rejects.toThrow()
    const next = new URL(f.connections.begin('alice').url).searchParams.get('state')!
    await expect(f.connections.complete(first, 'alice', 'alice')).rejects.toThrow()
    await f.connections.complete(next, 'alice', 'alice')
    await expect(f.connections.complete(next, 'alice', 'bob')).rejects.toThrow()
    const expired = new URL(f.connections.begin('bob').url).searchParams.get('state')!
    f.clock.now += 600001
    await expect(f.connections.complete(expired, 'bob', 'bob')).rejects.toThrow()
    expect(f.http.mock.calls.filter(([p]) => p.includes('access_token'))).toHaveLength(1)
  })
  it('does not accept deployment PATs or let another owner decrypt a copied grant', async () => {
    const f = fixture()
    f.http.mockResolvedValueOnce({ status: 200, data: { access_token: 'ghp_deployment', token_type: 'bearer' } })
    await expect(f.connect('alice')).rejects.toThrow('授权未完成')
    await f.connect('alice'); await f.connect('bob')
    f.db.prepare("UPDATE github_user_connections SET secret=(SELECT secret FROM github_user_connections WHERE owner='alice') WHERE owner='bob'").run()
    await expect(f.connections.reader('bob').api('GET', '/repos/team/private/issues/1')).rejects.toThrow('失效')
  })
  it('cancels a pending replacement without disconnecting the existing account', async () => {
    const f = fixture(); await f.connect('alice')
    const pending = new URL(f.connections.begin('alice').url).searchParams.get('state')!
    f.connections.cancelPending('alice')
    expect(f.connections.view('alice').status).toBe('connected')
    await expect(f.connections.complete(pending, 'alice', 'bob')).rejects.toThrow()
  })
  it('discards in-flight reads and old readers when disconnected or replaced', async () => {
    const f = fixture(); await f.connect('alice')
    const reader = f.connections.reader('alice')
    f.http.mockImplementationOnce(async () => { f.connections.disconnect('alice', 1); return { status: 200, data: { secret: 'must not return' } } })
    await expect(reader.api('GET', '/repos/team/private/issues/1')).rejects.toThrow('连接自己的')
    await f.connect('alice', 'bob')
    await expect(reader.api('GET', '/user')).rejects.toThrow()
    expect(f.connections.view('alice')).toMatchObject({ login: 'bob', revision: 3 })
  })
  it('does not restore a disconnected account after a late OAuth callback', async () => {
    const f = fixture(), state = new URL(f.connections.begin('alice').url).searchParams.get('state')!
    f.http.mockImplementationOnce(async () => { f.connections.disconnect('alice', 0); return { status: 200, data: { access_token: 'ghu_alice', token_type: 'bearer' } } })
    await expect(f.connections.complete(state, 'alice', 'alice')).rejects.toThrow('变化')
    expect(f.connections.view('alice').status).toBe('disconnected')
  })
  it('refreshes once for concurrent readers, preserves grant identity, and revokes on 401 without fallback', async () => {
    const f = fixture(); await f.connect('alice'); f.clock.now += 28800 * 1000
    const reader = f.connections.reader('alice')
    const values = await Promise.all([reader.api('GET', '/repos/team/private/issues/1'), reader.api('GET', '/repos/team/private/issues/2')])
    expect(values).toEqual([{ using: 'ghu_refreshed' }, { using: 'ghu_refreshed' }])
    expect(f.http.mock.calls.filter(([p]) => p.includes('access_token'))).toHaveLength(2)
    expect(f.connections.view('alice').revision).toBe(1)
    f.http.mockResolvedValueOnce({ status: 401, data: { message: 'secret-provider-body' } })
    await expect(reader.api('GET', '/user')).rejects.toThrow('失效')
    expect(f.connections.view('alice').status).toBe('needs_connection')
    expect(f.db.prepare("SELECT secret FROM github_user_connections WHERE owner='alice'").get()?.secret).toBe('')
  })
  it('never exposes a token or permits write requests through the personal reader', async () => {
    const f = fixture(); await f.connect('alice'); f.http.mockClear()
    for (const path of ['/repos/team/private/issues', '//evil.test', '/login/oauth/access_token'])
      await expect(f.connections.reader('alice').api('POST', path, {})).rejects.toThrow()
    expect(f.http).not.toHaveBeenCalled()
    expect(JSON.stringify(f.connections.view('alice'))).not.toMatch(/ghu_|ghr_|secret/)
  })
  it.each([
    { status: 429, data: { message: 'rate limited' } },
    { status: 403, data: { message: 'temporarily forbidden' } },
    { status: 503, data: {} },
    { status: 200, data: { error: 'incorrect_client_credentials' } },
    { status: 200, data: { error: 'unsupported_grant_type' } },
    { status: 200, data: { token_type: 'bearer' } },
  ])('preserves the grant after a transient or configuration refresh failure: %j', async result => {
    const f = fixture(); await f.connect('alice'); f.clock.now += 28800_000
    const before = f.db.prepare("SELECT secret,token_version FROM github_user_connections WHERE owner='alice'").get()
    f.http.mockResolvedValueOnce(result)
    await expect(f.connections.reader('alice').api('GET', '/repos/team/private/issues/1')).rejects.toMatchObject({ status: 503 })
    expect(f.connections.view('alice')).toMatchObject({ status: 'connected', revision: 1 })
    expect(f.db.prepare("SELECT secret,token_version FROM github_user_connections WHERE owner='alice'").get()).toEqual(before)
    await expect(f.connections.reader('alice').api('GET', '/repos/team/private/issues/1')).resolves.toEqual({ using: 'ghu_refreshed' })
  })
  it.each([200, 400])('requires reconnection when GitHub explicitly rejects the refresh token (%i)', async status => {
    const f = fixture(); await f.connect('alice'); f.clock.now += 28800_000
    f.http.mockResolvedValueOnce({ status, data: { error: 'bad_refresh_token' } })
    await expect(f.connections.reader('alice').api('GET', '/user')).rejects.toMatchObject({ status: 401 })
    expect(f.connections.view('alice')).toMatchObject({ status: 'needs_connection', revision: 2 })
    expect(f.db.prepare("SELECT secret FROM github_user_connections WHERE owner='alice'").get()?.secret).toBe('')
  })
  it('keeps the grant when the host temporarily loses OAuth configuration', async () => {
    const f = fixture(); await f.connect('alice'); f.clock.now += 28800_000
    const restarted = new GitHubUserConnections({ ...f.deps, config: undefined })
    await expect(restarted.reader('alice').api('GET', '/user')).rejects.toMatchObject({ status: 503 })
    expect(restarted.view('alice')).toMatchObject({ status: 'connected', revision: 1 })
  })
  it('does not revoke a refreshed credential because an older read returns a late 401', async () => {
    const f = fixture(); await f.connect('alice')
    let entered!: () => void, respond!: (result: { status: number; data: unknown }) => void
    const started = new Promise<void>(resolve => { entered = resolve })
    f.http.mockImplementationOnce(async () => { entered(); return new Promise(resolve => { respond = resolve }) })
    const oldRead = f.connections.reader('alice').api('GET', '/repos/team/private/issues/1')
    await started
    f.clock.now += 28800_000
    await expect(f.connections.reader('alice').api('GET', '/repos/team/private/issues/2')).resolves.toEqual({ using: 'ghu_refreshed' })
    respond({ status: 401, data: {} })
    await expect(oldRead).rejects.toMatchObject({ status: 409 })
    expect(f.connections.view('alice')).toMatchObject({ status: 'connected', revision: 1 })
    await expect(f.connections.reader('alice').api('GET', '/repos/team/private/issues/1')).resolves.toEqual({ using: 'ghu_refreshed' })
  })
})
describe('personal and team GitHub request lanes', () => {
  it('isolates concurrent people and retains the team identity only in group work', async () => {
    const f = fixture(); await f.connect('alice'); await f.connect('bob')
    const team = { api: vi.fn(async () => 'team') } as any, lane = personalGitHubLane(team, f.connections)
    const read = (owner: string) => lane.run('POST /v1/github/issue', { chatType: 'p2p', requesterOpenId: owner }, async () => {
      await Promise.resolve(); const result = await lane.github!.api('GET', '/repos/team/private/issues/1'); return { result, receipt: lane.receipt() }
    })
    expect(await Promise.all([read('alice'), read('bob')])).toEqual([
      { result: { using: 'ghu_alice' }, receipt: { owner: 'alice', revision: 1 } },
      { result: { using: 'ghu_bob' }, receipt: { owner: 'bob', revision: 1 } }])
    expect(team.api).not.toHaveBeenCalled()
    await expect(read('unconnected')).rejects.toThrow()
    expect(await lane.run('POST /v1/github/issue', { chatType: 'group' }, () => lane.github!.api('GET', '/repos/team/private/issues/1'))).toBe('team')
  })
  it.each(['github/change/start', 'github/change/files/read', 'github/pr/followup', 'github/execution/start', 'project/view'])(
    'does not let personal work use a team service: %s', async route => {
      const f = fixture(), lane = personalGitHubLane({} as any, f.connections), run = vi.fn(async () => 'leaked')
      await expect(lane.run(`POST /v1/${route}`, { chatType: 'p2p', requesterOpenId: 'alice' }, run)).rejects.toThrow('本人账号')
      expect(run).not.toHaveBeenCalled()
    })
})

describe('explicit temporary reads for the same verified account', () => {
  function bridge() {
    const account = { id: 101, login: 'alice' }
    const request = vi.fn(async (_method: string, path: string) => ({ status: 200, data: path === '/user' ? account : { from: 'temporary', path } }))
    const identity = new GitHubIdentity({ apiUrl: 'https://api.github.com', mode: 'pat', token: 'synthetic-pat', allowedRepos: ['team/private'], writableRepos: [] }, log, { request: request as GitHubHttp['request'] })
    const f = fixture(identity)
    const enable = () => f.connections.enableTemporaryRead('alice', { repositories: ['team/private'], expiresAt: f.clock.now + 3600_000 })
    return { ...f, request, account, enable }
  }
  it('is opt-in per owner and verifies credential identity before granting a bounded repository', async () => {
    const f = bridge(); await f.connect('alice'); await f.connect('bob')
    f.http.mockResolvedValue({ status: 404, data: {} })
    await expect(f.connections.reader('alice').api('GET', '/repos/team/private/pulls/1')).rejects.toThrow()
    expect(f.request).not.toHaveBeenCalled()
    await expect(f.connections.enableTemporaryRead('bob', { repositories: ['team/private'], expiresAt: f.clock.now + 3600_000 })).rejects.toThrow('账号不一致')
    await f.enable(); f.request.mockClear()
    expect(f.connections.view('alice').revision).toBe(2)
    await expect(f.connections.reader('alice').api('GET', '/repos/team/private/pulls/1')).resolves.toMatchObject({ from: 'temporary' })
    await expect(f.connections.reader('bob').api('GET', '/repos/team/private/pulls/1')).rejects.toThrow()
    expect(f.request.mock.calls.map(c => c[1])).toEqual(['/user', '/repos/team/private/pulls/1'])
  })
  it('prefers successful App reads and never falls back for writes, other repos, traversal, authentication or rate/policy errors', async () => {
    const f = bridge(); await f.connect('alice'); await f.enable(); f.request.mockClear()
    const read = () => f.connections.reader('alice')
    await expect(read().api('GET', '/repos/team/private/pulls/1')).resolves.toEqual({ using: 'ghu_alice' })
    for (const path of ['/repos/other/private/pulls/1', '/repos/team/private/../other/issues/1', '/repos/team/private/%2e%2e/other/issues/1', '/repos/team/private/..%2Fother/issues/1']) {
      f.http.mockResolvedValueOnce({ status: 404, data: {} })
      await expect(read().api('GET', path)).rejects.toThrow()
    }
    await expect(read().api('POST', '/repos/team/private/issues', {})).rejects.toThrow()
    for (const status of [403, 429, 503, 401]) {
      f.http.mockResolvedValueOnce({ status, data: {} })
      await expect(read().api('GET', '/repos/team/private/pulls/1')).rejects.toThrow()
    }
    expect(f.request).not.toHaveBeenCalled()
    expect(f.connections.view('alice').status).toBe('needs_connection')
  })
  it('invalidates old readers when scope is enabled, stopped or expires without removing the App connection', async () => {
    const f = bridge(); await f.connect('alice'); const old = f.connections.reader('alice')
    await f.enable(); await expect(old.api('GET', '/user')).rejects.toThrow()
    const temporary = f.connections.reader('alice')
    f.clock.now += 3600_001
    expect(f.connections.temporaryAccess('alice')).toBeUndefined()
    expect(f.connections.view('alice')).toMatchObject({ status: 'connected', revision: 3 })
    await expect(temporary.api('GET', '/user')).rejects.toThrow()
    await f.enable(); const next = f.connections.reader('alice')
    f.connections.disableTemporaryRead('alice', 4)
    await expect(next.api('GET', '/user')).rejects.toThrow()
    expect(f.connections.view('alice').revision).toBe(5)
  })
  it('discards late temporary data after disconnect and stops if the relay identity changes', async () => {
    const f = bridge(); await f.connect('alice'); await f.enable()
    f.http.mockResolvedValue({ status: 404, data: {} })
    f.account.id = 202
    await expect(f.connections.reader('alice').api('GET', '/repos/team/private/issues/1')).rejects.toThrow('账号不一致')
    expect(f.connections.temporaryAccess('alice')).toBeUndefined()
    f.account.id = 101; await f.enable()
    f.request.mockImplementationOnce(async () => ({ status: 200, data: f.account }))
      .mockImplementationOnce(async () => { f.connections.disconnect('alice', f.connections.view('alice').revision); return { status: 200, data: { from: 'must-not-return', path: '' } } })
    await expect(f.connections.reader('alice').api('GET', '/repos/team/private/issues/1')).rejects.toThrow('连接自己的')
  })
  it('only augments the three known discovery queries, scopes them, bounds results and de-duplicates', async () => {
    const f = bridge(); await f.connect('alice'); await f.enable(); f.request.mockClear()
    const item = (repo: string, n: number) => ({ html_url: `https://github.com/${repo}/pull/${n}`, updated_at: '2026-09-30T12:00:00Z' })
    f.http.mockResolvedValue({ status: 200, data: { total_count: 1, items: [item('team/private', 1)], incomplete_results: false } })
    f.request.mockImplementation(async (_method, path) => ({ status: 200, data: (path === '/user' ? f.account :
      { total_count: 3, items: [item('team/private', 1), item('team/private', 2), item('other/secret', 3)], incomplete_results: false }) as any }))
    const query = (q: string) => `/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=50`
    const result = await f.connections.reader('alice').api<any>('GET', query('is:open is:pr review-requested:alice'))
    expect(result.items).toEqual([item('team/private', 1), item('team/private', 2)])
    expect(result.incomplete_results).toBe(true)
    expect(new URL(`https://api.github.com${f.request.mock.calls[1]![1]}`).searchParams.get('q')).toBe('is:open is:pr review-requested:alice repo:team/private')
    f.request.mockClear()
    for (const q of ['is:open is:pr review-requested:bob', 'is:open is:pr review-requested:alice OR repo:other/secret', 'is:open is:issue assignee:bob'])
      await f.connections.reader('alice').api('GET', query(q))
    expect(f.request).not.toHaveBeenCalled()
  })
  it('rejects unbounded grants and retains the opt-in through OAuth token refresh', async () => {
    const f = bridge(); await f.connect('alice')
    for (const input of [{ repositories: ['other/private'], expiresAt: f.clock.now + 1000 },
      { repositories: ['team/private'], expiresAt: f.clock.now + 8 * 86400_000 }, { repositories: [], expiresAt: f.clock.now + 1000 }])
      await expect(f.connections.enableTemporaryRead('alice', input)).rejects.toThrow()
    await f.connections.enableTemporaryRead('alice', { repositories: ['team/private'], expiresAt: f.clock.now + 86400_000 })
    f.clock.now += 28800_000
    await f.connections.reader('alice').api('GET', '/repos/team/private/pulls/1')
    expect(f.connections.temporaryAccess('alice')?.repositories).toEqual(['team/private'])
  })
})

describe('personal token configuration without credentials in chat or relay', () => {
  const token = `github_pat_${'a'.repeat(72)}`
  function encrypted(url: URL, value = token) {
    return publicEncrypt({ key: Buffer.from(url.searchParams.get('key')!, 'base64url'), format: 'der', type: 'spki',
      oaepHash: 'sha256', oaepLabel: Buffer.from(url.searchParams.get('state')!) }, Buffer.from(value)).toString('base64url')
  }
  it('binds a one-use encryption key to the owner and verifies the PAT account, independently of App setup', async () => {
    const f = fixture(), c = new GitHubUserConnections({ ...f.deps, config: undefined })
    const url = new URL(c.beginToken('alice').url), state = url.searchParams.get('state')!
    expect(c.available).toBe(false); expect(c.tokenAvailable).toBe(true)
    expect(c.pendingTokenUrl('alice')).toBe(url.href)
    expect(state).toMatch(/^gp1\./)
    const body = encrypted(url)
    await expect(c.complete(state, 'bob', body)).rejects.toThrow()
    f.http.mockResolvedValueOnce({ status: 200, data: { id: 101, login: 'alice' } })
    await c.complete(state, 'alice', body)
    expect(c.view('alice')).toMatchObject({ status: 'connected', login: 'alice', method: 'personal_token', revision: 1 })
    expect(JSON.stringify(f.db.prepare('SELECT * FROM github_user_connections').all())).not.toContain(token)
    expect(c.pendingTokenUrl('alice')).toBeUndefined()
    expect(c.pending()).toHaveLength(0)
    await expect(c.complete(state, 'alice', body)).rejects.toThrow()
    f.http.mockClear()
    await expect(c.reader('alice').api('GET', '/repos/team/private/pulls/1')).resolves.toEqual({ using: token })
    expect(f.http.mock.calls[0]![1].token).toBe(token)
    await expect(c.reader('alice').api('POST', '/repos/team/private/issues', {})).rejects.toThrow()
  })
  it('preserves the previous account when replacement fails and rejects ciphertext from another attempt', async () => {
    const f = fixture(); await f.connect('alice')
    const old = new URL(f.connections.beginToken('alice').url), oldCipher = encrypted(old)
    const next = new URL(f.connections.beginToken('alice').url)
    await expect(f.connections.complete(next.searchParams.get('state')!, 'alice', oldCipher)).rejects.toThrow('有效的令牌')
    expect(f.connections.view('alice')).toMatchObject({ revision: 1, login: 'alice', method: 'github_app' })
    const third = new URL(f.connections.beginToken('alice').url)
    f.http.mockResolvedValueOnce({ status: 401, data: {} })
    await expect(f.connections.complete(third.searchParams.get('state')!, 'alice', encrypted(third))).rejects.toThrow('未能核实')
    expect(f.connections.view('alice').revision).toBe(1)
  })
  it('rejects expired, cancelled and late submissions after disconnect; never accepts a token in plaintext', async () => {
    const f = fixture(), c = f.connections
    let url = new URL(c.beginToken('alice').url)
    await expect(c.complete(url.searchParams.get('state')!, 'alice', token)).rejects.toThrow()
    c.cancelPending('alice')
    await expect(c.complete(url.searchParams.get('state')!, 'alice', encrypted(url))).rejects.toThrow()
    url = new URL(c.beginToken('alice').url); f.clock.now += 600001
    await expect(c.complete(url.searchParams.get('state')!, 'alice', encrypted(url))).rejects.toThrow()
    url = new URL(c.beginToken('alice').url)
    f.http.mockImplementationOnce(async () => { c.disconnect('alice', 0); return { status: 200, data: { id: 101, login: 'alice' } } })
    await expect(c.complete(url.searchParams.get('state')!, 'alice', encrypted(url))).rejects.toThrow('变化')
    expect(c.view('alice').status).toBe('disconnected')
  })
})
