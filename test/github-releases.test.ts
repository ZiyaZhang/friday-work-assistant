/**
 * 版本与发布查询（POST /v1/github/releases）。
 *
 * 版本查询需要回答「公开最新版是什么」和
 * 「这个修复进哪个版本了」，而 Friday 的 GitHub 工具里原来没有 releases/tags，
 * 只能回答"合入了"，回答不了"发布了没"。
 *
 * 结果应准确反映发布状态：
 * - 预览版要标出来
 * - 没合并的 PR 不可能在任何版本里，不去比对
 * - 在查过的版本里没找到 ≠ 没发布：要说清查了哪些
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

const RELEASES = [
  { tag_name: '0.1.6-alpha.2', name: '0.1.6-alpha.2', published_at: '2026-09-18T00:00:00Z', draft: false, prerelease: true, html_url: 'https://github.com/o/r/releases/tag/0.1.6-alpha.2' },
  { tag_name: '0.1.6-alpha.1', name: '0.1.6-alpha.1', published_at: '2026-09-10T00:00:00Z', draft: false, prerelease: true, html_url: 'https://github.com/o/r/releases/tag/0.1.6-alpha.1' },
  { tag_name: '0.1.5', name: '0.1.5', published_at: '2026-09-01T00:00:00Z', draft: false, prerelease: false, html_url: 'https://github.com/o/r/releases/tag/0.1.5' },
]

function setup(api: (method: string, path: string) => unknown) {
  const registry = new Registry(':memory:')
  const cwd = mkdtempSync(join(tmpdir(), 'friday-gh-releases-'))
  cleanups.push(() => { registry.close(); rmSync(cwd, { recursive: true, force: true }) })
  const sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  const feishu = new FakeFeishu()
  const memory = new ChannelMemory(registry.db)
  const log = createLogger('gh-releases', 'error')
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', cwd, requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'om_current', requesterOpenId: 'alice', prompt: 'alpha.3 发了吗' }).task
  registry.updateTask(task.id, { status: 'running' })
  const memoryHost = memoryRuntimeFixture(registry, memory)
  memoryHost.pin({ runId: 'current-run', sessionKey: 'session-a', actorOpenId: 'alice', taskId: task.id })
  const calls: string[] = []
  const github = {
    repoAllowed: (repo: string) => repo === 'o/r', repoWritable: (repo: string) => repo === 'o/r',
    defaultRepo: () => 'o/r',
    api: vi.fn(async (method: string, path: string) => { calls.push(`${method} ${path}`); return api(method, path) }),
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
  const call = (body: Record<string, unknown>, actor = cap) => created.routes['POST /v1/github/releases']!(actor, body)
  return { call, cap, calls, github }
}

const listOnly = (_m: string, path: string): unknown => (path.includes('/releases') ? RELEASES : [])

describe('版本与发布查询', () => {
  it('按新到旧列出发布，并标出预览版', async () => {
    const t = setup(listOnly)
    const r = await t.call({}) as { repo: string; releases: { tag: string; prerelease: boolean }[]; latest: string; latest_stable: string | null }
    expect(r.repo).toBe('o/r')
    expect(r.releases.map(x => x.tag)).toEqual(['0.1.6-alpha.2', '0.1.6-alpha.1', '0.1.5'])
    expect(r.releases[0]!.prerelease).toBe(true)
    // 最新的是预览版时，正式版要单独给出来——不能让人以为 alpha 是正式发布
    expect(r.latest).toBe('0.1.6-alpha.2')
    expect(r.latest_stable).toBe('0.1.5')
  })

  it('没有 release 时退回 tag，并说明这是 tag 不是发布', async () => {
    const t = setup((_m, path) => (path.includes('/releases') ? [] : [{ name: 'v9', commit: { sha: 'abc' } }]))
    const r = await t.call({}) as { releases: unknown[]; tags: string[]; source: string }
    expect(r.releases).toEqual([])
    expect(r.tags).toEqual(['v9'])
    expect(r.source).toBe('tags')
  })

  it('contains 给已合并 PR：解析出 merge commit，给出最早包含它的版本', async () => {
    const t = setup((_m, path) => {
      if (path.includes('/pulls/4751')) return { merged: true, merge_commit_sha: 'deadbeef', html_url: 'https://github.com/o/r/pull/4751' }
      if (path.includes('/releases')) return RELEASES
      if (path.includes('/compare/0.1.5...')) return { status: 'diverged' }
      if (path.includes('/compare/0.1.6-alpha.1...')) return { status: 'behind' }
      if (path.includes('/compare/0.1.6-alpha.2...')) return { status: 'behind' }
      return []
    })
    const r = await t.call({ contains: '#4751' }) as { contains: { ref: string; merged: boolean; sha: string; first_release: string | null; checked: string[] } }
    expect(r.contains.merged).toBe(true)
    expect(r.contains.sha).toBe('deadbeef')
    // 最早包含 = 按时间从旧到新第一个包含的，不是列表里第一个
    expect(r.contains.first_release).toBe('0.1.6-alpha.1')
    expect(r.contains.checked).toEqual(['0.1.5', '0.1.6-alpha.1', '0.1.6-alpha.2'])
  })

  it('contains 给未合并 PR：直接说没合并，不做任何版本比对', async () => {
    const t = setup((_m, path) => {
      if (path.includes('/pulls/980')) return { merged: false, html_url: 'https://github.com/o/r/pull/980', state: 'closed' }
      if (path.includes('/releases')) return RELEASES
      return []
    })
    const r = await t.call({ contains: '980' }) as { contains: { merged: boolean; first_release: string | null; note: string } }
    expect(r.contains.merged).toBe(false)
    expect(r.contains.first_release).toBeNull()
    expect(r.contains.note).toContain('未合并')
    expect(t.calls.filter(c => c.includes('/compare/'))).toEqual([])
  })

  it('查过的版本里都不包含时，说清查了哪些，不断言"没发布"', async () => {
    const t = setup((_m, path) => {
      if (path.includes('/releases')) return RELEASES
      if (path.includes('/compare/')) return { status: 'diverged' }
      return []
    })
    const r = await t.call({ contains: 'abc1234' }) as { contains: { first_release: string | null; checked: string[]; note: string } }
    expect(r.contains.first_release).toBeNull()
    expect(r.contains.checked).toHaveLength(3)
    expect(r.contains.note).toContain('没有找到')
    expect(r.contains.note).not.toContain('尚未发布')
  })

  it('仓库不在白名单时 403，且不发任何请求', async () => {
    const t = setup(listOnly)
    await expect(t.call({ repo: 'evil/repo' })).rejects.toMatchObject({ status: 403 })
    expect(t.calls).toEqual([])
  })

  it('没有 github:read 时拒绝', async () => {
    const t = setup(listOnly)
    const noScope = { ...t.cap, scopes: ALL_SCOPES.filter(s => s !== 'github:read') }
    await expect(t.call({}, noScope)).rejects.toMatchObject({ status: 403 })
    expect(t.calls).toEqual([])
  })
})
