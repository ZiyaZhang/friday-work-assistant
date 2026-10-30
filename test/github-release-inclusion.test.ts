/**
 * 发布版本读取与"某个提交进了哪个版本"的比对：共享函数（src/github/releases.ts）。
 *
 * 这套比对原来只在 POST /v1/github/releases 里（按需查询）。P3-5 让 PR 巡查在合并之后
 * 自动查"进了哪个版本"，同一套规则抽出来两处共用，不复制：
 * - 只比已发布（非 draft）的版本，从旧到新，第一个包含的就是最早包含的；比完是为了确认后续版本也带着它
 * - 最多比最新 12 个
 * - "查过的版本里没找到" ≠ "没发布"：调用方要说清查了哪些
 *
 * 第二部分证明路由确实在调这两个函数（用同一个假 GitHub，路由结果与共享函数直接调用的结果一致）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as releasesModule from '../src/github/releases.js'
import { firstReleaseContaining, readReleases, releasesPublishedSince, RELEASE_COMPARE_LIMIT, type ReleaseSummary } from '../src/github/releases.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { Bugs } from '../src/core/bugs.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'
import { spaceDeps } from './helpers/space.js'

vi.mock('../src/github/releases.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/github/releases.js')>()
  return { ...actual, readReleases: vi.fn(actual.readReleases), firstReleaseContaining: vi.fn(actual.firstReleaseContaining) }
})

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.mocked(releasesModule.readReleases).mockClear(); vi.mocked(releasesModule.firstReleaseContaining).mockClear() })

const RAW = [
  { tag_name: '0.1.6-alpha.2', name: '0.1.6-alpha.2', published_at: '2026-09-18T00:00:00Z', draft: false, prerelease: true, html_url: 'https://github.com/o/r/releases/tag/0.1.6-alpha.2' },
  { tag_name: '0.1.6-alpha.1', name: '0.1.6-alpha.1', published_at: '2026-09-10T00:00:00Z', draft: false, prerelease: true, html_url: 'https://github.com/o/r/releases/tag/0.1.6-alpha.1' },
  { tag_name: '', name: 'untagged draft', published_at: null, draft: true, prerelease: false, html_url: null },
  { tag_name: '0.1.7-draft', name: '0.1.7', published_at: null, draft: true, prerelease: false, html_url: null },
  { tag_name: '0.1.5', name: '0.1.5', published_at: '2026-09-01T00:00:00Z', draft: false, prerelease: false, html_url: 'https://github.com/o/r/releases/tag/0.1.5' },
]

function fakeGithub(handler: (method: string, path: string) => unknown) {
  const calls: string[] = []
  const api = vi.fn(async (method: string, path: string) => { calls.push(`${method} ${path}`); return handler(method, path) })
  return { github: { api } as unknown as Pick<GitHubIdentity, 'api'>, calls }
}

describe('readReleases：列出发布版本', () => {
  it('按 GitHub 返回顺序（新到旧）列出，去掉没有 tag 的；published 只含非 draft；最新正式版单独给', async () => {
    const t = fakeGithub((_m, path) => (path.includes('/releases') ? RAW : []))
    const listing = await readReleases(t.github, 'o/r', 10)
    expect(listing.source).toBe('releases')
    expect(listing.releases.map((r) => r.tag)).toEqual(['0.1.6-alpha.2', '0.1.6-alpha.1', '0.1.7-draft', '0.1.5'])
    expect(listing.published.map((r) => r.tag)).toEqual(['0.1.6-alpha.2', '0.1.6-alpha.1', '0.1.5'])
    expect(listing.latest).toBe('0.1.6-alpha.2')
    expect(listing.latest_stable).toBe('0.1.5')
    expect(listing.tags).toEqual([])
    expect(t.calls).toEqual(['GET /repos/o/r/releases?per_page=10'])
  })

  it('没有 release 时退回 tag，并说明来源是 tags', async () => {
    const t = fakeGithub((_m, path) => (path.includes('/releases') ? [] : [{ name: 'v9', commit: { sha: 'abc' } }, { name: '' }]))
    const listing = await readReleases(t.github, 'o/r', 5)
    expect(listing.source).toBe('tags')
    expect(listing.releases).toEqual([])
    expect(listing.published).toEqual([])
    expect(listing.tags).toEqual(['v9'])
    expect(listing.latest).toBeNull()
    expect(t.calls).toEqual(['GET /repos/o/r/releases?per_page=5', 'GET /repos/o/r/tags?per_page=5'])
  })

  it('每次拿到响应之后都调一次 check——授权在等待期间可能撤销', async () => {
    const t = fakeGithub((_m, path) => (path.includes('/releases') ? [] : [{ name: 'v1' }]))
    const check = vi.fn()
    await readReleases(t.github, 'o/r', 5, check)
    expect(check).toHaveBeenCalledTimes(2)
    const revoked = vi.fn(() => { throw new Error('revoked') })
    await expect(readReleases(t.github, 'o/r', 5, revoked)).rejects.toThrow('revoked')
  })
})

describe('firstReleaseContaining：最早包含某个提交的版本', () => {
  const published: ReleaseSummary[] = [
    { tag: '0.1.6-alpha.2', name: '0.1.6-alpha.2', published_at: '2026-09-18T00:00:00Z', draft: false, prerelease: true, url: 'u2' },
    { tag: '0.1.6-alpha.1', name: '0.1.6-alpha.1', published_at: '2026-09-10T00:00:00Z', draft: false, prerelease: true, url: 'u1' },
    { tag: '0.1.5', name: '0.1.5', published_at: '2026-09-01T00:00:00Z', draft: false, prerelease: false, url: 'u0' },
  ]

  it('从旧到新比；第一个包含它的是最早包含的版本；后面的也比完', async () => {
    const t = fakeGithub((_m, path) => {
      if (path.includes('/compare/0.1.5...')) return { status: 'diverged' }
      if (path.includes('/compare/0.1.6-alpha.1...')) return { status: 'behind' }
      if (path.includes('/compare/0.1.6-alpha.2...')) return { status: 'behind' }
      return []
    })
    const result = await firstReleaseContaining(t.github, 'o/r', 'deadbeef', published)
    expect(result.first?.tag).toBe('0.1.6-alpha.1')
    expect(result.checked).toEqual(['0.1.5', '0.1.6-alpha.1', '0.1.6-alpha.2'])
    expect(result.containing).toEqual(['0.1.6-alpha.1', '0.1.6-alpha.2'])
    expect(t.calls).toEqual([
      'GET /repos/o/r/compare/0.1.5...deadbeef',
      'GET /repos/o/r/compare/0.1.6-alpha.1...deadbeef',
      'GET /repos/o/r/compare/0.1.6-alpha.2...deadbeef',
    ])
  })

  it('identical 也算包含（tag 正好打在这个提交上）', async () => {
    const t = fakeGithub((_m, path) => ({ status: path.includes('0.1.6-alpha.2') ? 'identical' : 'diverged' }))
    const result = await firstReleaseContaining(t.github, 'o/r', 'deadbeef', published)
    expect(result.first?.tag).toBe('0.1.6-alpha.2')
  })

  it('都不包含时 first 为空，checked 列出查过的', async () => {
    const t = fakeGithub(() => ({ status: 'diverged' }))
    const result = await firstReleaseContaining(t.github, 'o/r', 'deadbeef', published)
    expect(result.first).toBeNull()
    expect(result.checked).toHaveLength(3)
    expect(result.containing).toEqual([])
  })

  it('最多比最新 12 个；候选为空或 sha 为空时不发请求', async () => {
    const many: ReleaseSummary[] = Array.from({ length: 15 }, (_, i) => ({
      tag: `v${i}`, name: `v${i}`, published_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, draft: false, prerelease: false, url: null,
    }))
    const t = fakeGithub(() => ({ status: 'diverged' }))
    const result = await firstReleaseContaining(t.github, 'o/r', 'deadbeef', many)
    expect(RELEASE_COMPARE_LIMIT).toBe(12)
    expect(result.checked).toEqual(many.slice(3).map((r) => r.tag))
    expect(t.calls).toHaveLength(12)
    const none = fakeGithub(() => ({ status: 'behind' }))
    expect(await firstReleaseContaining(none.github, 'o/r', 'deadbeef', [])).toEqual({ first: null, checked: [], containing: [] })
    expect(await firstReleaseContaining(none.github, 'o/r', '', published)).toEqual({ first: null, checked: [], containing: [] })
    expect(none.calls).toEqual([])
  })

  it('每次比对响应之后都调一次 check', async () => {
    const t = fakeGithub(() => ({ status: 'diverged' }))
    const check = vi.fn()
    await firstReleaseContaining(t.github, 'o/r', 'deadbeef', published, check)
    expect(check).toHaveBeenCalledTimes(3)
  })
})

describe('releasesPublishedSince：合并之前发布的版本不可能包含合并提交', () => {
  it('只留发布时间不早于给定时刻的；发布时间未知的保留（宁可多比一次）', () => {
    const published: ReleaseSummary[] = [
      { tag: 'new', name: 'new', published_at: '2026-09-18T00:00:00Z', draft: false, prerelease: false, url: null },
      { tag: 'old', name: 'old', published_at: '2026-09-01T00:00:00Z', draft: false, prerelease: false, url: null },
      { tag: 'unknown', name: 'unknown', published_at: null, draft: false, prerelease: false, url: null },
    ]
    expect(releasesPublishedSince(published, Date.parse('2026-09-10T00:00:00Z')).map((r) => r.tag)).toEqual(['new', 'unknown'])
    // 没有时刻可依据时全部保留
    expect(releasesPublishedSince(published, null).map((r) => r.tag)).toEqual(['new', 'old', 'unknown'])
  })
})

describe('POST /v1/github/releases 复用共享函数（不复制比对逻辑）', () => {
  function setup(api: (method: string, path: string) => unknown) {
    const registry = new Registry(':memory:')
    const cwd = mkdtempSync(join(tmpdir(), 'friday-gh-releases-shared-'))
    cleanups.push(() => { registry.close(); rmSync(cwd, { recursive: true, force: true }) })
    const sp = spaceDeps(registry.db)
    const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
    const feishu = new FakeFeishu()
    const memory = new ChannelMemory(registry.db)
    const log = createLogger('gh-releases-shared', 'error')
    registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', cwd, requesterOpenId: 'alice' })
    const task = registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'om_current', requesterOpenId: 'alice', prompt: '进哪个版本了' }).task
    registry.updateTask(task.id, { status: 'running' })
    const memoryHost = memoryRuntimeFixture(registry, memory)
    memoryHost.pin({ runId: 'current-run', sessionKey: 'session-a', actorOpenId: 'alice', taskId: task.id })
    const github = {
      repoAllowed: (repo: string) => repo === 'o/r', repoWritable: (repo: string) => repo === 'o/r', defaultRepo: () => 'o/r',
      api: vi.fn(async (method: string, path: string) => api(method, path)),
    } as unknown as GitHubIdentity
    const created = createInternalApi({
      registry, ...sp, feishu: asFeishuClient(feishu), messageCache: new MessageCache(registry.db),
      memory, memoryRuntime: memoryHost.runtime, bugs: new Bugs(registry.db), todos: new Todos(registry.db),
      messages: new MessageService(asFeishuClient(feishu), new MessageCache(registry.db), log),
      github, tokens: new TokenIssuer('synthetic'), log, maxHistoryPerCall: 50,
      resolveActorForSession: () => ({ requesterOpenId: 'alice', runId: 'current-run', stage: 'task', taskId: task.id }),
    } as InternalApiDeps)
    const cap: Capability & { boundRunId?: string; boundStage?: string } = {
      runId: 'current-run', sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', spaceId: space.id,
      requesterOpenId: 'alice', cwd, boundRunId: 'current-run', boundStage: 'task', scopes: [...ALL_SCOPES], exp: 9999999999,
    }
    return { call: (body: Record<string, unknown>) => created.routes['POST /v1/github/releases']!(cap, body), github }
  }

  it('列表走 readReleases，contains 走 firstReleaseContaining，路由结果与共享函数一致', async () => {
    const handler = (_m: string, path: string): unknown => {
      if (path.includes('/pulls/4751')) return { merged: true, merge_commit_sha: 'deadbeef', html_url: 'https://github.com/o/r/pull/4751' }
      if (path.includes('/releases')) return RAW
      if (path.includes('/compare/0.1.5...')) return { status: 'diverged' }
      if (path.includes('/compare/')) return { status: 'behind' }
      return []
    }
    const t = setup(handler)
    const r = await t.call({ contains: '#4751' }) as { releases: { tag: string }[]; latest_stable: string | null; contains: { first_release: string | null; checked: string[] } }
    expect(vi.mocked(releasesModule.readReleases)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(releasesModule.readReleases).mock.calls[0]!.slice(1, 3)).toEqual(['o/r', 10])
    expect(vi.mocked(releasesModule.firstReleaseContaining)).toHaveBeenCalledTimes(1)
    const [, repo, sha, published] = vi.mocked(releasesModule.firstReleaseContaining).mock.calls[0]!
    expect([repo, sha, published.map((p) => p.tag)]).toEqual(['o/r', 'deadbeef', ['0.1.6-alpha.2', '0.1.6-alpha.1', '0.1.5']])
    const direct = fakeGithub(handler)
    const listing = await readReleases(direct.github, 'o/r', 10)
    const contains = await firstReleaseContaining(direct.github, 'o/r', 'deadbeef', listing.published)
    expect(r.releases.map((x) => x.tag)).toEqual(listing.releases.map((x) => x.tag))
    expect(r.latest_stable).toBe(listing.latest_stable)
    expect(r.contains.first_release).toBe(contains.first!.tag)
    expect(r.contains.checked).toEqual(contains.checked)
  })

  it('未合并的 PR 不进入比对：firstReleaseContaining 不被调用', async () => {
    const t = setup((_m, path) => {
      if (path.includes('/pulls/980')) return { merged: false, html_url: 'https://github.com/o/r/pull/980', state: 'closed' }
      if (path.includes('/releases')) return RAW
      return []
    })
    await t.call({ contains: '980' })
    expect(vi.mocked(releasesModule.readReleases)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(releasesModule.firstReleaseContaining)).not.toHaveBeenCalled()
  })
})
