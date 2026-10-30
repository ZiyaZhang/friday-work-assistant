import { afterEach, describe, expect, it, vi } from 'vitest'
import { publicEncrypt } from 'node:crypto'
import { Registry } from '../src/core/registry.js'
import { Todos } from '../src/core/todos.js'
import { TodoApplication, todoTag } from '../src/core/todo-application.js'
import { GitHubPersonalDiscovery } from '../src/core/github-personal-discovery.js'
import { GitHubUserConnections, type GitHubUserHttp } from '../src/github/user-connection.js'
import { createLogger } from '../src/log.js'

const dbs: Registry[] = [], NOW = Date.parse('2026-09-30T12:00:00Z')
afterEach(() => dbs.splice(0).forEach(db => db.close()))
const pr = (number: number, extra = {}) => ({ html_url: `https://github.com/team/private/pull/${number}`, state: 'open', title: `PR ${number}`,
  updated_at: new Date(NOW).toISOString(), user: { login: 'alice' }, draft: false, ...extra })
async function fixture() {
  const registry = new Registry(':memory:'); dbs.push(registry)
  const todos = new Todos(registry.db), clock = { now: NOW, enabled: true }
  const audience = (owner: string) => ({ openId: owner, chatId: `dm_${owner}`, chatType: 'p2p' as const, scope: `space:sp_dm_${owner}` })
  const sets = { review: [pr(1)], assigned: [pr(2, { html_url: 'https://github.com/team/private/issues/2', assignees: [{ login: 'alice' }] })], authored: [pr(3)] }
  const http = vi.fn<GitHubUserHttp>(async (path, input) => {
    if (path.includes('access_token')) return { status: 200, data: { access_token: `ghu_${input.form!.code}`, token_type: 'bearer' } }
    const login = input.token!.startsWith('ghp_') ? 'alice' : input.token!.slice(4)
    if (path === '/user') return { status: 200, data: { id: login === 'alice' ? 1 : 2, login } }
    if (path.startsWith('/user/installations')) return { status: 200, data: { total_count: 1 } }
    const query = new URL(`https://api.github.com${path}`).searchParams.get('q')!
    const items = login === 'bob' ? [pr(8, { title: 'Only Bob', assignees: [{ login: 'bob' }], user: { login: 'bob' } })]
      : query.includes('review-requested:') ? sets.review : query.includes('assignee:') ? sets.assigned : sets.authored
    return { status: 200, data: { total_count: items.length, incomplete_results: false, items } }
  })
  const connections = new GitHubUserConnections({ db: registry.db, key: Buffer.alloc(32, 5), now: () => clock.now, http, log: createLogger('test', 'error'),
    tokenRelay: { baseUrl: 'https://example.test', token: 'synthetic' },
    config: { clientId: 'synthetic', clientSecret: 'synthetic', relayToken: 'synthetic', redirectUri: 'https://test.invalid/github/callback' } })
  const connect = async (owner: string) => connections.complete(new URL(connections.begin(owner).url).searchParams.get('state')!, owner, owner)
  await connect('alice')
  const onChange = vi.fn(async () => {})
  const discovery = new GitHubPersonalDiscovery({ registry, todos, connections, now: () => clock.now, enabled: () => clock.enabled, audience, onChange })
  const items = (owner = 'alice') => todos.listForAudience(audience(owner), { status: 'all' }).items
  return { registry, todos, clock, sets, http, connections, connect, discovery, items, audience, onChange }
}
describe('personal GitHub discovery with real owner-bound storage', () => {
  it('discovers personal-token work without an App installation, with the token grant in provenance', async () => {
    const f = await fixture(), url = new URL(f.connections.beginToken('alice').url), state = url.searchParams.get('state')!
    const code = publicEncrypt({ key: Buffer.from(url.searchParams.get('key')!, 'base64url'), format: 'der', type: 'spki', oaepHash: 'sha256',
      oaepLabel: Buffer.from(state) }, Buffer.from(`ghp_${'a'.repeat(36)}`)).toString('base64url')
    await f.connections.complete(state, 'alice', code)
    f.http.mockClear(); await f.discovery.refresh('alice')
    expect(f.items()).toHaveLength(2)
    expect(f.http.mock.calls.some(([path]) => path.startsWith('/user/installations'))).toBe(false)
    expect(f.todos.getProvenance(f.items()[0]!.id)?.github).toMatchObject({ ownerOpenId: 'alice', login: 'alice', revision: 2 })
    expect(f.discovery.view('alice')?.state).toBe('current')
  })
  it('collects review requests and assignments, keeps authored PRs separate, and preserves native evidence', async () => {
    const f = await fixture(); await f.discovery.refresh('alice')
    expect(f.items()).toHaveLength(2)
    expect(f.items().every(t => !t.confirmed && t.dueMs === null && t.status === 'open')).toBe(true)
    const review = f.items().find(t => t.title.startsWith('评审'))!, source = f.todos.getProvenance(review.id)!
    expect(source.github).toMatchObject({ ownerOpenId: 'alice', login: 'alice', accountId: 1, revision: 1, relationship: 'review_requested', completion: 'reviewed' })
    expect(source.collection).toBeUndefined()
    expect(source.contextSnapshot.personalRepositories).toEqual([{ repo: 'team/private', owner: 'alice', revision: 1 }])
    expect(review.origin?.selectedInputs).toContainEqual(expect.objectContaining({ kind: 'github', link: { status: 'available', url: pr(1).html_url } }))
    expect(f.discovery.view('alice')?.waiting).toEqual([{ title: 'PR 3', url: pr(3).html_url, draft: false }])
    expect(f.onChange).toHaveBeenCalledTimes(1)
  })
  it('does not resurrect ignored work or complete missing search results', async () => {
    const f = await fixture(); await f.discovery.refresh('alice')
    const review = f.items().find(t => t.title.startsWith('评审'))!
    new TodoApplication({ db: f.registry.db, todos: f.todos }).update(review.id, f.audience('alice'),
      { expectedTag: todoTag(review), patch: { status: 'cancelled' } }, 'alice')
    await f.discovery.refresh('alice')
    expect(f.items()).toHaveLength(2)
    expect(f.todos.get(review.id)?.status).toBe('cancelled')
    f.sets.assigned = []; await f.discovery.refresh('alice')
    expect(f.items().find(t => t.id !== review.id)?.status).toBe('open')
  })
  it('isolates two verified users and discards an in-flight response after disconnect', async () => {
    const f = await fixture(); await f.connect('bob')
    await Promise.all([f.discovery.refresh('alice'), f.discovery.refresh('bob')])
    expect(f.items('alice').some(t => t.title.includes('Only Bob'))).toBe(false)
    expect(f.items('bob').every(t => t.title.includes('Only Bob'))).toBe(true)
    const before = f.items().length
    f.http.mockImplementationOnce(async () => { f.connections.disconnect('alice', 1); return { status: 200, data: { total_count: 1 } } })
    await expect(f.discovery.refresh('alice')).rejects.toThrow('连接自己的')
    expect(f.items()).toHaveLength(before)
    expect(f.discovery.view('alice')).toBeUndefined()
  })
  it('keeps the successful timestamp on failure, reports installation/partial state, and respects pauses', async () => {
    const f = await fixture(); await f.discovery.refresh('alice'); f.clock.now += 600_000
    f.http.mockRejectedValueOnce(new Error('provider temporarily unavailable'))
    await expect(f.discovery.refresh('alice')).rejects.toThrow()
    expect(f.discovery.view('alice')).toMatchObject({ state: 'retrying', checkedAt: NOW, attemptedAt: f.clock.now, partial: true })
    f.http.mockResolvedValueOnce({ status: 200, data: { total_count: 0 } })
    await f.discovery.refresh('alice')
    expect(f.discovery.view('alice')).toMatchObject({ state: 'needs_installation' })
    f.http.mockResolvedValueOnce({ status: 200, data: { total_count: 1 } }).mockResolvedValueOnce({ status: 200, data: { total_count: 100, incomplete_results: true, items: [pr(1)] } })
    await f.discovery.refresh('alice'); expect(f.discovery.view('alice')?.partial).toBe(true)
    f.clock.enabled = false; f.http.mockClear(); await f.discovery.tick(); await f.discovery.refresh('alice')
    expect(f.http).not.toHaveBeenCalled()
  })
})
