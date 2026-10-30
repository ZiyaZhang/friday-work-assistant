import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { GitHubIdentity, loadGitHubConfig, type GitHubHttp } from '../src/github/identity.js'
import type { ChangeManager } from '../src/github/changes.js'
import { IssueLinks } from '../src/github/issues.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const closes: (() => void)[] = []
afterEach(() => { for (const close of closes.splice(0)) close() })
const writes = [
  ['github/issue/open', { repo: 'org/demo', title: '合成缺陷', body: '合成复现说明' }],
  ['github/issue/comment', { repo: 'org/demo', number: 1, body: '合成评论' }],
  ['github/change/start', { repo: 'org/demo' }],
  ['github/change/publish', { dir: '/synthetic/change', title: '合成修复', body: '合成变更说明' }],
  ['github/change/update', { dir: '/synthetic/change', title: '合成追加' }],
  ['github/pr/ready', { dir: '/synthetic/change' }],
] as const

function fixture(env: NodeJS.ProcessEnv) {
  const registry = new Registry(':memory:'), sp = spaceDeps(registry.db)
  closes.push(() => registry.close())
  const space = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
  const log = createLogger('github-default-write-test', 'error'), fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  const messageCache = new MessageCache(registry.db)
  const request = vi.fn(async (_method: string, path: string) => ({ status: 200, data: path.startsWith('/search/issues') ? { items: [] }
    : path.includes('comments') ? [] : { number: 1, title: '合成缺陷', state: 'open', html_url: 'https://github.com/org/demo/issues/1', labels: [], assignees: [] } }))
  const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'synthetic', ...env })!, log, { request } as GitHubHttp)
  const effects = { prepare: vi.fn(), publish: vi.fn(), update: vi.fn(), markReady: vi.fn() }
  const changes = { ...effects, readMarker: () => ({ repo: 'org/demo' }),
    inspect: async () => ({ repo: 'org/demo', snapshot: 'synthetic', files: ['fix.ts'] }),
    inspectUpdate: async () => ({ repo: 'org/demo', files: ['fix.ts'], snapshot: 'synthetic' }) } as unknown as ChangeManager
  const confirm = vi.fn(async () => true)
  const api = createInternalApi({ registry, ...sp, github, changes, issueLinks: new IssueLinks(registry.db), confirm,
    feishu, memory: new ChannelMemory(registry.db), todos: new Todos(registry.db), messageCache,
    messages: new MessageService(feishu, messageCache, log), tokens: new TokenIssuer('synthetic'), log, maxHistoryPerCall: 10,
    canPersistDerivedState: () => true, canPublishToRepository: () => true })
  const cap = { sessionKey: 'synthetic-session', chatId: 'oc_dm', chatType: 'p2p' as const, spaceId: space.id,
    requesterOpenId: 'ou_alice', scopes: [...ALL_SCOPES], cwd: '/synthetic', exp: 9999999999 }
  return { github, effects, request, confirm, call: (path: string, body: Record<string, unknown>) => api.routes[`POST /v1/${path}`]!(cap, body) }
}

describe('real GitHub identity cannot borrow write authority from a read list', () => {
  it.each(writes)('denies %s before confirmation or writes when the write list is missing, empty or outside read access', async (path, body) => {
    for (const env of [{ FRIDAY_GITHUB_REPOS: 'org/demo' }, {},
      { FRIDAY_GITHUB_REPOS: 'org/demo', FRIDAY_GITHUB_WRITE_REPOS: ' , ' },
      { FRIDAY_GITHUB_REPOS: 'org/other', FRIDAY_GITHUB_WRITE_REPOS: 'org/demo' }]) {
      const t = fixture(env)
      await expect(t.call(path, body)).rejects.toMatchObject({ status: 403 })
      expect(t.confirm).not.toHaveBeenCalled()
      expect(t.request).not.toHaveBeenCalled()
      for (const effect of Object.values(t.effects)) expect(effect).not.toHaveBeenCalled()
    }
  })

  it('retains reads without an explicit write list and prepares a branch only when both lists allow it', async () => {
    const readOnly = fixture({ FRIDAY_GITHUB_REPOS: 'org/demo' })
    await expect(readOnly.call('github/issue', { repo: 'org/demo', number: 1 })).resolves.toMatchObject({ number: 1 })
    expect(readOnly.request.mock.calls.every(call => call[0] === 'GET')).toBe(true)
    const writable = fixture({ FRIDAY_GITHUB_REPOS: 'org/demo', FRIDAY_GITHUB_WRITE_REPOS: 'org/demo' })
    writable.effects.prepare.mockResolvedValue({ dir: '/synthetic/change', branch: 'friday/test' })
    await expect(writable.call('github/change/start', { repo: 'org/demo' })).resolves.toMatchObject({ branch: 'friday/test' })
    expect(writable.effects.prepare).toHaveBeenCalledOnce()
  })
})
