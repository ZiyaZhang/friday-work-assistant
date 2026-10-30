import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { GitHubProjectView } from '../src/github/project-view.js'
import { GitHubIdentity } from '../src/github/identity.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach((f) => f()) })
function setup() {
  const registry = new Registry(':memory:'); cleanup.push(() => registry.close())
  const { spaces, circles, policy } = spaceDeps(registry.db, { admins: ['admin'] })
  const a = spaces.ensure({ kind: 'group', chatId: 'a', openId: 'admin' })
  const b = spaces.ensure({ kind: 'group', chatId: 'b', openId: 'bob' })
  spaces.touchMember(a.id, 'alice')
  const log = createLogger('project-api', 'error')
  const calls: string[] = []; const hooks = { read: () => {} }
  const allowedRepos = ['org/a', 'org/b']
  const rows = new Map<string, Record<string, unknown>[]>()
  const github = new GitHubIdentity({ apiUrl: 'https://api.github.com', token: 'synthetic', allowedRepos }, log, {
    async request(method, path) {
      calls.push(`${method} ${path}`); hooks.read()
      const match = /^\/repos\/([^/]+\/[^/]+)\/issues\?/.exec(path)
      return { status: 200, data: match && new URL(path, 'https://api.github.com').searchParams.get('page') === '1' ? rows.get(match[1]!) ?? [] : [] } as never
    },
  })
  const projects = new GitHubProjectView(registry.db, github)
  const feishu = asFeishuClient(new FakeFeishu()), messageCache = new MessageCache(registry.db)
  const api = createInternalApi({ registry, spaces, circles, policy, github, projects, feishu, messageCache,
    memory: new ChannelMemory(registry.db), messages: new MessageService(feishu, messageCache, log), todos: new Todos(registry.db),
    tokens: new TokenIssuer('synthetic'), log, maxHistoryPerCall: 100 })
  const cap: Capability = { sessionKey: 's', chatId: 'a', chatType: 'group', spaceId: a.id, requesterOpenId: 'admin', scopes: [...ALL_SCOPES], exp: 9999999999 }
  const call = (route: string, body = {}, actor = cap) => api.routes[`POST /v1/project/${route}`]!(actor, body)
  const seed = async (repo: string, title: string) => {
    rows.set(repo, [{ number: 1, title, state: 'open', assignees: [{ login: 'Alice' }], html_url: `https://github.com/${repo}/issues/1`, created_at: '2026-09-18T00:00:00Z', updated_at: '2026-09-19T00:00:00Z', closed_at: null }])
    await projects.sync(repo)
  }
  return { registry, spaces, a, b, calls, hooks, cap, call, projects, allowedRepos, seed }
}

describe('project audience authorization', () => {
  it('requires an explicit space grant and never grants all GitHub-visible repositories by default', async () => {
    const t = setup()
    await expect(t.call('view', { refresh: true })).rejects.toMatchObject({ status: 409 })
    expect(t.calls).toEqual([])
    await expect(t.call('repositories', { repos: ['org/a'] }, { ...t.cap, requesterOpenId: 'alice' })).rejects.toMatchObject({ status: 403 })
    await t.call('repositories', { repos: ['Org/A'] })
    expect(t.spaces.get(t.a.id)?.config.projectRepos).toEqual(['org/a'])
    await expect(t.call('view', { repo: 'org/b', refresh: true })).rejects.toMatchObject({ status: 403 })
    const result = await t.call('view', { refresh: true })
    expect(result).toMatchObject({ items: [], coverageComplete: true, repositories: [{ repo: 'org/a' }] })
    expect(t.calls.every((x) => x.startsWith('GET '))).toBe(true)
  })
  it('does not inherit audience grants through user defaults or group rebind', async () => {
    const t = setup()
    await t.call('repositories', { repos: ['org/a'] })
    expect(t.spaces.ensure({ kind: 'group', chatId: 'c', openId: 'admin' }).config.projectRepos).toBeUndefined()
    t.spaces.rebind(t.a.id, 'new-a')
    expect(t.spaces.get(t.a.id)?.config.projectRepos).toEqual([])
    await expect(t.call('view')).rejects.toMatchObject({ status: 403 })
  })
  it('does not release refreshed data when the project grant is revoked during the request', async () => {
    const t = setup(); await t.call('repositories', { repos: ['org/a'] })
    t.hooks.read = () => { t.spaces.patchConfig(t.a.id, { projectRepos: [] }) }
    await expect(t.call('view', { refresh: true })).rejects.toMatchObject({ status: 403 })
  })
  it('keeps cached project rows inaccessible from a different space', async () => {
    const t = setup(); await t.call('repositories', { repos: ['org/a'] }); await t.call('view', { refresh: true })
    await expect(t.call('view', { repo: 'org/a' }, { ...t.cap, chatId: 'b', spaceId: t.b.id, requesterOpenId: 'bob' })).rejects.toMatchObject({ status: 403 })
  })

  it('the HTML endpoint delegates exactly the same audience and scope restrictions as the JSON view', async () => {
    const t = setup()
    await t.call('repositories', { repos: ['org/a'] })
    await t.seed('org/a', 'A_PROJECT_SENTINEL')
    await t.seed('org/b', 'B_PRIVATE_SENTINEL')
    const page = await t.call('page', { repos: ['org/b'], space_id: t.b.id }, { ...t.cap, requesterOpenId: 'alice' }) as { html: string; snapshot: boolean }
    expect(page.snapshot).toBe(true)
    expect(page.html).toContain('A_PROJECT_SENTINEL')
    expect(page.html).not.toContain('B_PRIVATE_SENTINEL')
    expect(page.html).not.toContain('synthetic')
    for (const actor of [
      { ...t.cap, requesterOpenId: 'outsider' },
      { ...t.cap, scopes: ['space:configure'] },
      { ...t.cap, spaceId: t.b.id },
      { ...t.cap, chatId: 'b' },
      { ...t.cap, chatType: 'p2p' as const },
    ]) await expect(t.call('page', {}, actor)).rejects.toMatchObject({ status: 403 })
    await expect(t.call('page', { repo: 'org/b' })).rejects.toMatchObject({ status: 403 })
  })

  it.each(['view', 'page'])('requires an identified current audience member before returning %s data', async (route) => {
    const t = setup()
    await t.call('repositories', { repos: ['org/a'] })
    await t.seed('org/a', 'IDENTIFIED_MEMBER_ONLY')
    const before = t.calls.length
    await expect(t.call(route, { refresh: true }, { ...t.cap, requesterOpenId: undefined })).rejects.toMatchObject({ status: 403 })
    expect(t.calls).toHaveLength(before)
  })

  it.each(['view', 'page'])('does not let an extra DM member row substitute for the actual private-space owner in %s', async (route) => {
    const t = setup()
    const dm = t.spaces.ensure({ kind: 'p2p', chatId: 'dm-alice', openId: 'alice' })
    t.spaces.patchConfig(dm.id, { projectRepos: ['org/a'] })
    t.spaces.addMember(dm.id, 'bob', 'member', 'alice')
    await t.seed('org/a', 'ALICE_PRIVATE_PROJECT')
    await expect(t.call(route, {}, { ...t.cap, chatId: 'dm-alice', chatType: 'p2p', spaceId: dm.id, requesterOpenId: 'bob' })).rejects.toMatchObject({ status: 403 })
    const mine = await t.call(route, {}, { ...t.cap, chatId: 'dm-alice', chatType: 'p2p', spaceId: dm.id, requesterOpenId: 'alice' })
    expect(JSON.stringify(mine)).toContain('ALICE_PRIVATE_PROJECT')
  })

  it('strips project grants from legacy saved defaults as well as new saved preferences', () => {
    const t = setup()
    t.registry.db.prepare('INSERT INTO user_defaults (open_id, config, updated_at) VALUES (?, ?, ?)')
      .run('legacy-owner', JSON.stringify({ projectRepos: ['org/a'], repos: true, brevity: 'short', notes: ['简短回答'] }), 1)
    expect(t.spaces.defaultsFor('legacy-owner')).toEqual({ brevity: 'short' })
    const inherited = t.spaces.ensure({ kind: 'group', chatId: 'legacy-new-group', openId: 'legacy-owner' })
    expect(inherited.config).toEqual({ brevity: 'short' })
    t.spaces.rememberDefaults('legacy-owner', { projectRepos: ['org/b'], repos: true, brevity: 'detailed' })
    const saved = t.registry.db.prepare('SELECT config FROM user_defaults WHERE open_id = ?').get('legacy-owner') as { config: string }
    expect(JSON.parse(saved.config)).toEqual({ brevity: 'detailed' })
  })

  it.each(['grant', 'membership', 'archive', 'rebind'] as const)('does not render or expose cached data after %s revocation during refresh', async (change) => {
    const t = setup()
    await t.call('repositories', { repos: ['org/a'] })
    await t.seed('org/a', 'CACHE_MUST_NOT_LEAK')
    const actor = { ...t.cap, requesterOpenId: 'alice' }
    t.hooks.read = () => {
      if (change === 'grant') t.spaces.patchConfig(t.a.id, { projectRepos: [] })
      if (change === 'membership') t.spaces.removeMember(t.a.id, 'alice')
      if (change === 'archive') t.spaces.archive(t.a.id)
      if (change === 'rebind') t.spaces.rebind(t.a.id, 'moved-a')
    }
    await expect(t.call('page', { repo: 'org/a', refresh: true }, actor)).rejects.toMatchObject({ status: 403 })
    t.hooks.read = () => {}
    for (const route of ['view', 'page']) await expect(t.call(route, { repo: 'org/a' }, actor)).rejects.toMatchObject({ status: 403 })
    // 缓存确实还在，拒绝来自当前权限检查，不是刚好没有数据。
    expect(t.projects.view(['org/a']).items[0]?.title).toBe('CACHE_MUST_NOT_LEAK')
  })

  it('rechecks the deployment repo allowlist for cached JSON and HTML, independently from the space grant', async () => {
    const t = setup()
    await t.call('repositories', { repos: ['org/a'] })
    await t.seed('org/a', 'REVOKED_REPO_SENTINEL')
    t.allowedRepos.splice(0, t.allowedRepos.length, 'org/b')
    for (const route of ['view', 'page']) await expect(t.call(route)).rejects.toThrow('允许范围')
  })

  it.each(['space grant', 'deployment allowlist'] as const)('rechecks %s after awaiting the JSON view and before releasing rendered HTML', async (revoked) => {
    const t = setup()
    await t.call('repositories', { repos: ['org/a'] })
    await t.seed('org/a', 'REVOKED_BETWEEN_VIEW_AND_RENDER')
    const original = t.projects.view.bind(t.projects)
    t.projects.view = (...args) => {
      const result = original(...args)
      queueMicrotask(() => {
        if (revoked === 'space grant') t.spaces.patchConfig(t.a.id, { projectRepos: [] })
        else t.allowedRepos.splice(0, t.allowedRepos.length, 'org/b')
      })
      return result
    }
    const outcome = await t.call('page').then(
      (result) => ({ status: 200, disclosed: (result as { html: string }).html.includes('REVOKED_BETWEEN_VIEW_AND_RENDER') }),
      (error: { status: number }) => ({ status: error.status }),
    )
    expect(outcome).toEqual({ status: 403 })
  })
})
