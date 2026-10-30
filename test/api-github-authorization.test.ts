import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { Bugs } from '../src/core/bugs.js'
import type { ChangeManager } from '../src/github/changes.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { IssueLinks } from '../src/github/issues.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const writeCases = [
  ['github/change/start', { repo: 'org/demo' }],
  ['github/change/publish', { dir: '/test/work/change', title: 'Fix', body: 'Approved details' }],
  ['github/issue/open', { repo: 'org/demo', title: 'Bug', body: 'Approved details' }],
  ['github/issue/comment', { repo: 'org/demo', number: 42, body: 'Approved details' }],
] as const
function setup(mode: 'safe' | 'deny' = 'safe', opts: { repositoryGuard?: boolean } = {}) {
  const registry = new Registry(':memory:')
  cleanup.push(() => registry.close())
  const { spaces, policy, circles } = spaceDeps(registry.db, { mode })
  const space = spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  const feishu = new FakeFeishu()
  const log = createLogger('api-github-authorization', 'error')
  const messageCache = new MessageCache(registry.db)
  const bugs = new Bugs(registry.db)
  const state = { actor: 'alice' as string | undefined, derivedSafe: true, runId: 'run-1', stage: 'task', sourceRepo: 'org/demo', taskId: undefined as number | undefined }
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', cwd: '/test', requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', requesterOpenId: 'alice', messageId: 'om_write', prompt: '处理仓库反馈',
    inbound: { eventId: 'event_write', messageId: 'om_write', chatId: 'chat-a', chatType: 'group', senderOpenId: 'alice',
      senderType: 'user', msgType: 'text', text: '处理仓库反馈', mentions: [], createTimeMs: Date.now() } }).task
  state.taskId = task.id
  const hooks = { confirm: () => {}, search: () => {}, inspect: () => {}, name: () => {}, write: () => {} }
  vi.spyOn(feishu, 'userName').mockImplementation(async () => { hooks.name(); return 'Alice' })
  const githubCalls: { method: string; path: string; body?: unknown }[] = []
  const github = {
    mode: 'app', repoAllowed: (repo: string) => repo === 'org/demo', repoWritable: (repo: string) => repo === 'org/demo', defaultRepo: () => 'org/demo',
    async api(method: string, path: string, body?: Record<string, unknown>, _owner?: string, beforeRequest?: () => void) {
      beforeRequest?.()
      githubCalls.push({ method, path, body })
      if (method === 'POST') hooks.write()
      if (path.startsWith('/search/issues')) { hooks.search(); return { items: [] } }
      if (method === 'POST' && path.endsWith('/comments')) return { html_url: 'https://github.com/org/demo/issues/42#issuecomment-1' }
      return { number: 42, title: 'Bug', state: 'open', html_url: 'https://github.com/org/demo/issues/42', assignees: [], labels: [] }
    },
  } as unknown as GitHubIdentity
  const prepare = vi.fn(async () => ({ id: 'change', dir: '/test/work/change', branch: 'friday/change', base: 'main', head: 'base' }))
  const inspect = vi.fn(async () => { hooks.inspect(); return ({ id: 'change', dir: '/test/work/change', repo: 'org/demo', branch: 'friday/change', base: 'main', baseCommit: 'base', head: 'base', snapshot: 'approved-tree', files: ['fix.ts'], stat: 'fix.ts | 1 +', createdAt: 1 }) })
  const publish = vi.fn(async () => ({ number: 1, url: 'https://github.com/org/demo/pull/1' }))
  const confirm = vi.fn(async () => { hooks.confirm(); return true })
  const canPublishToRepository = vi.fn((_sessionKey: string, repo: string) => state.derivedSafe && state.sourceRepo === repo)
  const tokens = new TokenIssuer('test-secret')
  const api = createInternalApi({
    registry, spaces, policy, circles, bugs, appId: 'app-test', feishu: asFeishuClient(feishu), messageCache,
    memory: new ChannelMemory(registry.db), messages: new MessageService(asFeishuClient(feishu), messageCache, log), todos: new Todos(registry.db),
    github, issueLinks: new IssueLinks(registry.db), changes: { prepare, inspect, publish } as unknown as ChangeManager,
    confirm, resolveActorForSession: () => state.actor ? { requesterOpenId: state.actor, runId: state.runId, stage: state.stage, taskId: state.taskId } : undefined,
    canPersistDerivedState: () => state.derivedSafe,
    canPublishToRepository: opts.repositoryGuard === false ? undefined : canPublishToRepository,
    tokens, log, maxHistoryPerCall: 100,
  })
  const cap: Capability & { boundRunId: string; boundStage: string } = { boundRunId: 'run-1', boundStage: 'task', runId: 'run-1', sessionKey: 'session-a', spaceId: space.id, chatId: 'chat-a', chatType: 'group', requesterOpenId: 'alice', scopes: [...ALL_SCOPES], cwd: '/test', exp: 9999999999 }
  const call = (path: string, body: Record<string, unknown>) => api.routes[`POST /v1/${path}`]!(cap, body)
  return { registry, task, spaces, space, policy, bugs, feishu, state, hooks, github, githubCalls, prepare, publish, confirm, canPublishToRepository, cap, call, api, tokens }
}
function expectNoExternalWrites(t: ReturnType<typeof setup>) {
  expect(t.githubCalls.filter((c) => c.method === 'POST')).toEqual([])
  expect(t.publish).not.toHaveBeenCalled()
}

describe('GitHub API uses current authority and complete source context', () => {
  it.each(writeCases)('keeps the derived-state boundary without a repository-specific guard in %s', async (path, body) => {
    const denied = setup('safe', { repositoryGuard: false })
    denied.state.derivedSafe = false
    await expect(denied.call(path, body)).rejects.toMatchObject({ status: 403 })
    expectNoExternalWrites(denied)
    expect(denied.prepare).not.toHaveBeenCalled()
    expect(denied.confirm).not.toHaveBeenCalled()
    const allowed = setup('safe', { repositoryGuard: false })
    await expect(allowed.call(path, body)).resolves.toBeDefined()
    expect(allowed.canPublishToRepository).not.toHaveBeenCalled()
  })

  it('allows preparation, Issue creation/comment and PR publishing to the same source repository', async () => {
    for (const [path, body] of writeCases) {
      const t = setup()
      await expect(t.call(path, body)).resolves.toBeDefined()
      expect(t.canPublishToRepository).toHaveBeenCalledWith(t.cap.sessionKey, 'org/demo')
      if (path === 'github/change/start') expect(t.prepare).toHaveBeenCalledOnce()
      else if (path === 'github/change/publish') expect(t.publish).toHaveBeenCalledOnce()
      else expect(t.githubCalls.filter((c) => c.method === 'POST')).toHaveLength(1)
    }
  })

  it('rejects cross-repository preparation, Issue creation/comment and PR publishing before any write', async () => {
    for (const [path, body] of writeCases) {
      const t = setup(); t.state.sourceRepo = 'org/private-source'
      await expect(t.call(path, body)).rejects.toMatchObject({ status: 403 })
      expect(t.canPublishToRepository).toHaveBeenCalledWith(t.cap.sessionKey, 'org/demo')
      expectNoExternalWrites(t)
      expect(t.prepare).not.toHaveBeenCalled()
      expect(t.confirm).not.toHaveBeenCalled()
    }
  })

  it.each(writeCases)('enforces deployment policy before %s', async (path, body) => {
    const t = setup('deny')
    await expect(t.call(path, body)).rejects.toMatchObject({ status: 403 })
    expectNoExternalWrites(t)
    expect(t.prepare).not.toHaveBeenCalled()
    expect(t.confirm).not.toHaveBeenCalled()
  })

  it.each(writeCases)('does not export incomplete or external-source context through %s', async (path, body) => {
    const t = setup(); t.state.derivedSafe = false
    await expect(t.call(path, body)).rejects.toMatchObject({ status: 403,
      message: '本轮资料的来源或读取证明不允许向目标仓库发布，写入未执行。需要为原请求重新准备限定来源的执行上下文；重复授权或原样重试不会解除这项限制。' })
    expectNoExternalWrites(t)
    expect(t.prepare).not.toHaveBeenCalled()
  })

  it.each(writeCases.slice(2))('rechecks a cancelled run after the awaited attribution lookup in %s', async (path, body) => {
    const t = setup(); t.hooks.name = () => { t.state.actor = undefined }
    await expect(t.call(path, body)).rejects.toMatchObject({ status: 403 })
    expectNoExternalWrites(t)
  })

  it.each(writeCases.slice(2))('does not start another attribution read after cancellation during chat-name lookup in %s', async (path, body) => {
    const t = setup()
    vi.spyOn(t.feishu, 'chatName').mockImplementation(async () => { t.state.actor = undefined; return 'Reported group' })
    await expect(t.call(path, body)).rejects.toMatchObject({ status: 403 })
    expect(t.feishu.userName).not.toHaveBeenCalled()
    expectNoExternalWrites(t)
  })

  it('rechecks a cancelled run after the awaited inspect in github/change/publish', async () => {
    // 去掉确认卡并没有少一次授权核验：inspect 是这条路上真正的 await，
    // 它之后紧跟着 needRepositoryWrite。注入点换了，守的是同一件事。
    const t = setup(); t.hooks.inspect = () => { t.state.actor = undefined }
    await expect(t.call('github/change/publish', { dir: '/test/work/change', title: 'Fix', body: 'Approved details' }))
      .rejects.toMatchObject({ status: 403 })
    expectNoExternalWrites(t)
  })

  it('开 PR 不需要任何人先点头——它是提议，不是改动', async () => {
    const t = setup()
    await expect(t.call('github/change/publish', { dir: '/test/work/change', title: 'Fix', body: 'Approved details' }))
      .resolves.toMatchObject({ number: 1 })
    expect(t.confirm).not.toHaveBeenCalled()
  })

  it.each(['actor', 'membership', 'rebind', 'sources', 'repository', 'work'] as const)('rejects %s changes during awaited Issue attribution', async (kind) => {
    for (const [path, body] of writeCases.slice(2)) {
      const t = setup()
      t.hooks.name = () => {
        if (kind === 'actor') { t.spaces.touchMember(t.space.id, 'bob'); t.state.actor = 'bob' }
        if (kind === 'membership') t.spaces.removeMember(t.space.id, 'alice')
        if (kind === 'rebind') t.spaces.rebind(t.space.id, 'chat-b')
        if (kind === 'sources') t.state.derivedSafe = false
        if (kind === 'repository') vi.spyOn(t.github, 'repoWritable').mockReturnValue(false)
        if (kind === 'work') t.registry.workContexts.control(t.registry.taskWork.get(t.task.id)!.key, { action: 'cancel' })
      }
      await expect(t.call(path, body)).rejects.toMatchObject({ status: 403 })
      expectNoExternalWrites(t)
      expect(t.confirm).not.toHaveBeenCalled()
    }
  })

  it('rechecks again at the Issue side-effect boundary after an awaited remote search', async () => {
    const t = setup()
    t.hooks.search = () => { t.state.actor = undefined }
    await expect(t.call('github/issue/open', { repo: 'org/demo', title: 'Bug', body: 'Approved details' })).rejects.toThrow()
    expectNoExternalWrites(t)
  })

  it.each(['run', 'stage'] as const)('binds HTTP requests to the accepted %s even when the actor stays the same', async (kind) => {
    const t = setup()
    await new Promise<void>((resolve) => t.api.server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve, reject) => t.api.server.close((err) => err ? reject(err) : resolve())))
    t.hooks.search = () => { if (kind === 'run') t.state.runId = 'run-2'; else t.state.stage = 'reflect' }
    const response = await fetch(`http://127.0.0.1:${(t.api.server.address() as AddressInfo).port}/v1/github/issue/open`, {
      method: 'POST', headers: { authorization: `Bearer ${t.tokens.issue(t.cap)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'org/demo', title: 'Bug', body: 'Approved details' }),
    })
    expect(response.status).toBe(403)
    expectNoExternalWrites(t)
  })

  it.each(writeCases.slice(2))('executes the signed current Task delegation without a second confirmation in %s', async (path, body) => {
    const t = setup()
    const runs = new RunAttempts(t.registry.db)
    const work = t.registry.taskWork.get(t.task.id)!
    const run = runs.begin({ workKey: work.key, sessionKey: t.cap.sessionKey, triggerKey: `task:${t.task.id}`,
      stage: 'task', taskId: t.task.id, actorOpenId: 'alice', now: Date.now() }, () => t.registry.startTask(t.task.id, Date.now()))!
    t.state.runId = t.cap.runId = t.cap.boundRunId = run.id
    t.confirm.mockRejectedValue(new Error('No second confirmation is authorized'))
    await new Promise<void>((resolve) => t.api.server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve, reject) => t.api.server.close((err) => err ? reject(err) : resolve())))
    const response = await fetch(`http://127.0.0.1:${(t.api.server.address() as AddressInfo).port}/v1/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${t.tokens.issue(t.cap)}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ repo: 'org/demo', number: 42, url: 'https://github.com/org/demo/issues/42' })
    expect(t.confirm).not.toHaveBeenCalled()
    expect(t.githubCalls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT status FROM github_issue_operations').all()).toEqual([{ status: 'confirmed' }])
    expect(runs.get(run.id)?.state).toBe('running')
  })

  it.each(['missing_task', 'other_task', 'reflect', 'scope'] as const)('rejects Issue writes outside the current human delegation: %s', async (kind) => {
    for (const [path, body] of writeCases.slice(2)) {
      const t = setup()
      if (kind === 'missing_task') t.state.taskId = undefined
      if (kind === 'other_task') t.state.taskId = t.registry.createTaskOnce({ sessionKey: 'session-a', requesterOpenId: 'bob', messageId: 'om_bob', prompt: 'Other delegation' }).task.id
      if (kind === 'reflect') t.state.stage = t.cap.boundStage = 'reflect'
      if (kind === 'scope') t.cap.scopes = t.cap.scopes.filter(scope => scope !== 'github:write')
      await expect(t.call(path, body)).rejects.toMatchObject({ status: 403 })
      expectNoExternalWrites(t)
      expect(t.confirm).not.toHaveBeenCalled()
    }
  })

  it.each(writeCases.slice(2))('preserves unknown write receipts and never repeats the POST in %s', async (path, body) => {
    const t = setup()
    t.hooks.write = () => { throw new Error('Connection ended after provider accepted the request') }
    await expect(t.call(path, body)).rejects.toThrow('写入结果未知')
    expect(t.registry.db.prepare('SELECT status FROM github_issue_operations').all()).toEqual([{ status: 'unknown' }])
    await expect(t.call(path, body)).rejects.toThrow('写入结果未知')
    expect(t.githubCalls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(t.confirm).not.toHaveBeenCalled()
  })

  it.each(writeCases.slice(2))('retains the actual provider ACK even when authority ends during the POST in %s', async (path, body) => {
    const t = setup()
    t.hooks.write = () => { t.state.actor = undefined }
    await expect(t.call(path, body)).rejects.toMatchObject({ status: 403 })
    expect(t.registry.db.prepare('SELECT status FROM github_issue_operations').all()).toEqual([{ status: 'confirmed' }])
    t.state.actor = 'alice'
    await expect(t.call(path, body)).resolves.toMatchObject({ replayed: true })
    expect(t.githubCalls.filter(call => call.method === 'POST')).toHaveLength(1)
  })
})

describe('bug evidence authorization after awaited message lookup', () => {
  it.each(['actor', 'membership', 'archive', 'rebind', 'sources'] as const)('does not persist an anchor after %s was revoked during lookup', async (kind) => {
    const t = setup()
    const bucket = t.bugs.record({ spaceId: t.space.id, chatId: 'chat-a', title: 'Bug', text: 'feedback' }).bucket
    vi.spyOn(t.feishu, 'getMessage').mockImplementation(async () => {
      if (kind === 'actor') t.state.actor = undefined
      if (kind === 'membership') t.spaces.removeMember(t.space.id, 'alice')
      if (kind === 'archive') t.spaces.archive(t.space.id)
      if (kind === 'rebind') t.spaces.rebind(t.space.id, 'chat-b')
      if (kind === 'sources') t.state.derivedSafe = false
      return historyMsg({ messageId: 'om_evidence', chatId: 'chat-a', tenantId: 'tenant-a', text: '[file]', fileKey: 'export' })
    })
    await expect(t.call('bug/evidence', { id: bucket.id, message_id: 'om_evidence' })).rejects.toMatchObject({ status: 403 })
    expect(t.bugs.anchors(bucket.id, t.space.id)).toEqual([])
    expect(t.bugs.evidence(bucket.id, t.space.id)).toEqual([])
  })
})

describe('feedback links refer to a verified GitHub Issue', () => {
  const url = 'https://github.com/org/demo/issues/42'
  function feedback(t: ReturnType<typeof setup>) {
    return t.bugs.record({ spaceId: t.space.id, chatId: 'chat-a', title: 'Synthetic feedback', text: 'User report' }).bucket
  }

  it('reads the configured API and stores its canonical Issue URL, without a remote write', async () => {
    const t = setup(); const bucket = feedback(t)
    const result = await t.call('bug/link_issue', { id: bucket.id, issue_url: url + '/#issuecomment-1' })
    expect(result).toMatchObject({ bucket: { issueUrl: url, intakePhase: 'linked_issue' }, issue: { repo: 'org/demo', number: 42, url, state: 'open' } })
    expect(t.githubCalls).toEqual([{ method: 'GET', path: '/repos/org/demo/issues/42', body: undefined }])
    expect(t.confirm).not.toHaveBeenCalled()
    await expect(t.call('bug/link_issue', { id: bucket.id, issue_url: url })).resolves.toMatchObject({ bucket: { id: bucket.id, issueUrl: url } })
    expectNoExternalWrites(t)
  })

  it.each([
    ['fragment', url + '#issuecomment-1'],
    ['trailing slash', url + '/'],
    ['repository case', 'https://github.com/Org/Demo/issues/42'],
  ])('normalizes an existing %s link only after verifying the same Issue', async (_kind, legacyUrl) => {
    const t = setup(); const bucket = feedback(t)
    t.bugs.linkIssue(bucket.id, legacyUrl, 'Existing note')
    await expect(t.call('bug/link_issue', { id: bucket.id, issue_url: url })).resolves.toMatchObject({
      bucket: { id: bucket.id, issueUrl: url, note: 'Existing note' }, issue: { url },
    })
    expect(t.githubCalls).toEqual([{ method: 'GET', path: '/repos/org/demo/issues/42', body: undefined }])
    expect(t.bugs.get(bucket.id)?.issueUrl).toBe(url)
    await expect(t.call('bug/link_issue', { id: bucket.id, issue_url: url })).resolves.toMatchObject({ bucket: { issueUrl: url } })
    expectNoExternalWrites(t)
  })

  it.each([
    'https://github.example.internal/org/demo/issues/42',
    'https://github.com/org/other/issues/42',
    'https://github.com/org/demo/issues/41',
  ])('preserves an existing link to a different Issue: %s', async (existingUrl) => {
    const t = setup(); const bucket = feedback(t)
    t.bugs.linkIssue(bucket.id, existingUrl)
    const before = t.bugs.get(bucket.id)
    await expect(t.call('bug/link_issue', { id: bucket.id, issue_url: url })).rejects.toMatchObject({ status: 409 })
    expect(t.bugs.get(bucket.id)).toEqual(before)
    expectNoExternalWrites(t)
  })

  it.each([
    'http://github.com/org/demo/issues/42',
    'https://user:password@github.com/org/demo/issues/42',
    'https://github.com/org/demo/pull/42',
    'https://github.com/org/demo/issues/0',
    'https://github.com/org/demo/issues/42?token=untrusted',
  ])('rejects a non-Issue reference before a lookup: %s', async (issue_url) => {
    const t = setup(); const bucket = feedback(t)
    await expect(t.call('bug/link_issue', { id: bucket.id, issue_url })).rejects.toMatchObject({ status: 400 })
    expect(t.githubCalls).toEqual([])
    expect(t.bugs.get(bucket.id)).toEqual(bucket)
  })

  it('does not fetch an arbitrary URL or accept a forged host for a real Issue number', async () => {
    const t = setup(); const bucket = feedback(t)
    await expect(t.call('bug/link_issue', { id: bucket.id, issue_url: 'https://forged.example/org/demo/issues/42' })).rejects.toMatchObject({ status: 409 })
    expect(t.githubCalls).toEqual([{ method: 'GET', path: '/repos/org/demo/issues/42', body: undefined }])
    expect(t.bugs.get(bucket.id)).toEqual(bucket)
  })

  it('uses the configured Enterprise API response rather than a hardcoded github.com host', async () => {
    const t = setup(); const bucket = feedback(t)
    const enterprise = 'https://github.example.internal/org/demo/issues/42'
    vi.spyOn(t.github, 'api').mockResolvedValue({ number: 42, html_url: enterprise, state: 'closed' })
    await expect(t.call('bug/link_issue', { id: bucket.id, issue_url: enterprise })).resolves.toMatchObject({ issue: { url: enterprise, state: 'closed' } })
    expect(t.bugs.get(bucket.id)?.issueUrl).toBe(enterprise)
    // 关联本身不能把本地案件状态当成 GitHub 的已修复状态。
    expect(t.bugs.get(bucket.id)?.status).toBe('triaging')
  })

  it.each([
    null,
    { number: 99, html_url: url, state: 'open' },
    { number: 42, html_url: url, state: 'open', pull_request: { url: 'synthetic' } },
    { number: 42, html_url: url, state: 'unknown' },
    { number: 42, html_url: 'https://github.com/org/demo/issues/99', state: 'open' },
  ])('does not persist a malformed or mismatched remote object: %j', async (response) => {
    const t = setup(); const bucket = feedback(t)
    vi.spyOn(t.github, 'api').mockResolvedValue(response)
    await expect(t.call('bug/link_issue', { id: bucket.id, issue_url: url })).rejects.toMatchObject({ status: 409 })
    expect(t.bugs.get(bucket.id)).toEqual(bucket)
  })

  it('requires read permission and an allowed repository before making a lookup', async () => {
    const t = setup(); const bucket = feedback(t)
    t.cap.scopes = t.cap.scopes.filter((s) => s !== 'github:read')
    await expect(t.call('bug/link_issue', { id: bucket.id, issue_url: url })).rejects.toMatchObject({ status: 403 })
    t.cap.scopes.push('github:read')
    await expect(t.call('bug/link_issue', { id: bucket.id, issue_url: 'https://github.com/org/other/issues/42' })).rejects.toMatchObject({ status: 403 })
    expect(t.githubCalls).toEqual([])
    expect(t.bugs.get(bucket.id)).toEqual(bucket)
  })

  it.each(['actor', 'membership', 'archive', 'rebind', 'sources', 'repository'] as const)('rechecks %s after the awaited lookup', async (kind) => {
    const t = setup(); const bucket = feedback(t)
    vi.spyOn(t.github, 'api').mockImplementationOnce(async () => {
      if (kind === 'actor') t.state.actor = undefined
      if (kind === 'membership') t.spaces.removeMember(t.space.id, 'alice')
      if (kind === 'archive') t.spaces.archive(t.space.id)
      if (kind === 'rebind') t.spaces.rebind(t.space.id, 'other-chat')
      if (kind === 'sources') t.state.derivedSafe = false
      if (kind === 'repository') vi.spyOn(t.github, 'repoAllowed').mockReturnValue(false)
      return { number: 42, html_url: url, state: 'open' } as never
    })
    await expect(t.call('bug/link_issue', { id: bucket.id, issue_url: url })).rejects.toMatchObject({ status: 403 })
    expect(t.bugs.get(bucket.id)).toEqual(bucket)
  })

  it('preserves another link recorded during the lookup', async () => {
    const t = setup(); const bucket = feedback(t)
    const currentUrl = 'https://github.com/org/demo/issues/41'
    vi.spyOn(t.github, 'api').mockImplementationOnce(async () => {
      t.bugs.linkIssue(bucket.id, currentUrl)
      return { number: 42, html_url: url, state: 'open' } as never
    })
    await expect(t.call('bug/link_issue', { id: bucket.id, issue_url: url })).rejects.toMatchObject({ status: 409 })
    expect(t.bugs.get(bucket.id)?.issueUrl).toBe(currentUrl)
  })
})
