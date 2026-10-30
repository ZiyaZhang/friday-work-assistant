import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { GitHubIdentity, loadGitHubConfig, type GitHubHttp } from '../src/github/identity.js'
import { commentIssue, IssueLinks, openIssue } from '../src/github/issues.js'
import { createLogger } from '../src/log.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function setup() {
  const registry = new Registry(':memory:'); cleanup.push(() => registry.close())
  const links = new IssueLinks(registry.db)
  const state = { allowed: true, readFail: false, writes: 0, tokenCount: 0, revokeAtToken: 0 }
  const http: GitHubHttp = { async request(method, path) {
    if (path.startsWith('/search/issues')) return { status: 200, data: { items: [] } as never }
    if (method === 'POST') {
      state.writes++
      return { status: 201, data: { number: 42, html_url: path.endsWith('/comments') ? 'https://github.com/org/demo/issues/42#issuecomment-1' : 'https://github.com/org/demo/issues/42' } as never }
    }
    if (state.readFail) throw new Error('read failed')
    return { status: 200, data: { number: 42, title: 'Bug', html_url: 'https://github.com/org/demo/issues/42', state: 'open', labels: [], assignees: [] } as never }
  } }
  const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'fake-test', FRIDAY_GITHUB_REPOS: 'org/demo' })!, createLogger('write-auth', 'error'), http)
  vi.spyOn(github, 'token').mockImplementation(async () => {
    state.tokenCount++
    await Promise.resolve() // real GitHubIdentity.api still awaits token before its HTTP boundary
    if (state.tokenCount === state.revokeAtToken) state.allowed = false
    return 'fake-test'
  })
  const assertAuthorized = () => { if (!state.allowed) throw new Error('authorization revoked') }
  const input = { repo: 'org/demo', title: 'Bug', body: 'Reproduction', requestKey: 'request-1', assertAuthorized }
  return { registry, links, state, github, input, assertAuthorized }
}

describe('business writes recheck after GitHub token awaits', () => {
  it.each(['open', 'comment'] as const)('does not POST %s after token-time revocation or mislabel it as unknown', async (kind) => {
    const t = setup()
    t.state.revokeAtToken = kind === 'open' ? 2 : 1
    const call = () => kind === 'open'
      ? openIssue(t.github, t.links, t.input)
      : commentIssue(t.github, { ...t.input, number: 42 }, t.links)
    await expect(call()).rejects.toThrow('authorization revoked')
    expect(t.state.writes).toBe(0)
    expect(t.registry.db.prepare('SELECT * FROM github_issue_operations').all()).toEqual([])
    t.state.allowed = true; t.state.revokeAtToken = 0
    await expect(call()).resolves.toMatchObject({ number: 42 })
    expect(t.state.writes).toBe(1)
  })

  it('denies before planning when the writer was already revoked', async () => {
    const t = setup(); t.state.allowed = false
    await expect(commentIssue(t.github, { ...t.input, number: 42 }, t.links)).rejects.toThrow('authorization revoked')
    expect(t.state.writes).toBe(0)
    expect(t.registry.db.prepare('SELECT * FROM github_issue_operations').all()).toEqual([])
  })

  it.each(['open', 'comment'] as const)('can read an already sent %s outcome without making a new authorized write', async (kind) => {
    const t = setup(); t.state.readFail = true
    const call = () => kind === 'open'
      ? openIssue(t.github, t.links, t.input)
      : commentIssue(t.github, { ...t.input, number: 42 }, t.links)
    await expect(call()).rejects.toThrow('read failed')
    expect(t.registry.db.prepare('SELECT status FROM github_issue_operations').get()).toMatchObject({ status: 'sent' })
    t.state.readFail = false; t.state.allowed = false
    await expect(call()).resolves.toMatchObject({ number: 42 })
    expect(t.state.writes).toBe(1)
  })
})
