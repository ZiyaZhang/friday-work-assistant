import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { GitHubUserConnections, type GitHubUserHttp } from '../src/github/user-connection.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const registry = new Registry(':memory:'), sp = spaceDeps(registry.db), log = createLogger('test', 'error')
  const memory = new ChannelMemory(registry.db), feishu = asFeishuClient(new FakeFeishu()), memoryHost = memoryRuntimeFixture(registry, memory)
  const tokens = new TokenIssuer('synthetic'), caps = new Map<string, Omit<Capability, 'exp'>>()
  for (const owner of ['alice', 'bob', 'unconnected']) {
    const sessionKey = `session-${owner}`, runId = `run-${owner}`, chatId = `dm-${owner}`, cwd = '/synthetic'
    const space = sp.spaces.ensure({ kind: 'p2p', chatId, openId: owner })
    registry.createSession({ sessionKey, chatId, chatType: 'p2p', cwd, requesterOpenId: owner })
    const task = registry.createTaskOnce({ sessionKey, messageId: `request-${owner}`, requesterOpenId: owner, prompt: '查看 GitHub' }).task
    registry.updateTask(task.id, { status: 'running' })
    memoryHost.pin({ runId, sessionKey, actorOpenId: owner, taskId: task.id })
    caps.set(owner, { sessionKey, runId, chatId, chatType: 'p2p', spaceId: space.id, requesterOpenId: owner, cwd, scopes: [...ALL_SCOPES] })
  }
  const http = vi.fn<GitHubUserHttp>(async (path, input) => {
    if (path.includes('access_token')) return { status: 200, data: { access_token: `ghu_${input.form!.code}`, token_type: 'bearer' } }
    const login = input.token!.slice(4)
    if (path === '/user') return { status: 200, data: { id: login === 'alice' ? 1 : 2, login } }
    if (path.includes('/comments?')) return { status: 200, data: [] }
    return { status: 200, data: { number: 1, title: `${login}'s private issue`, state: 'open', html_url: 'https://github.com/team/private/issues/1' } }
  })
  const personalGithub = new GitHubUserConnections({ db: registry.db, key: Buffer.alloc(32, 3), http, log,
    config: { clientId: 'synthetic', clientSecret: 'synthetic', redirectUri: 'https://test.invalid/github/callback', relayToken: 'synthetic' } })
  for (const owner of ['alice', 'bob']) await personalGithub.complete(new URL(personalGithub.begin(owner).url).searchParams.get('state')!, owner, owner)
  const teamApi = vi.fn(async () => { throw new Error('TEAM CREDENTIAL MUST NOT BE USED') }), record = vi.fn()
  const server = createInternalApi({ registry, ...sp, feishu, messageCache: new MessageCache(registry.db), memory, memoryRuntime: memoryHost.runtime,
    todos: new Todos(registry.db), messages: new MessageService(feishu, new MessageCache(registry.db), log), tokens, log, maxHistoryPerCall: 50,
    github: { api: teamApi, repoAllowed: () => true } as any, personalGithub, onRepositoryRead: record,
    resolveActorForSession: sessionKey => { const cap = [...caps.values()].find(c => c.sessionKey === sessionKey)!
      const task = registry.db.prepare('SELECT id FROM tasks WHERE session_key=?').get(sessionKey)!
      return { requesterOpenId: cap.requesterOpenId!, runId: cap.runId!, stage: 'task' as const, taskId: Number(task.id) } }, canPersistDerivedState: () => true }).server
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); registry.close() })
  const call = async (owner: string, route: string, body: object = {}) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/${route}`, { method: 'POST',
      headers: { authorization: `Bearer ${tokens.issue(caps.get(owner)!)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, data: await response.json() as any }
  }
  return { registry, personalGithub, teamApi, record, call }
}
describe('personal GitHub through the real internal HTTP API', () => {
  it('uses each capability owner’s account under concurrency and records the exact grant used', async () => {
    const f = await fixture()
    const [alice, bob] = await Promise.all(['alice', 'bob'].map(owner => f.call(owner, 'github/issue', { repo: 'team/private', number: 1, open_id: 'unconnected' })))
    expect(alice).toMatchObject({ status: 200, data: { title: "alice's private issue" } })
    expect(bob).toMatchObject({ status: 200, data: { title: "bob's private issue" } })
    expect(f.record).toHaveBeenCalledWith('session-alice', 'team/private', { owner: 'alice', revision: 1 })
    expect(f.record).toHaveBeenCalledWith('session-bob', 'team/private', { owner: 'bob', revision: 1 })
    expect(f.teamApi).not.toHaveBeenCalled()
  })
  it('never treats a supplied username as an authorization and blocks team checkout services in DM', async () => {
    const f = await fixture(); f.registry.setKv('github_login:unconnected', 'alice')
    expect(await f.call('unconnected', 'github/login', { login: 'alice' })).toMatchObject({ status: 200, data: { saved: false, connection: { status: 'disconnected' } } })
    expect(await f.call('unconnected', 'github/issue', { repo: 'team/private', number: 1 })).toMatchObject({ status: 403 })
    expect(await f.call('alice', 'github/change/start', { repo: 'team/private' })).toMatchObject({ status: 403 })
    expect(await f.call('alice', 'github/me')).toMatchObject({ status: 200, data: { login: 'alice', mode: 'personal', connection: { accountId: 1 } } })
    f.personalGithub.disconnect('alice', 1)
    expect(await f.call('alice', 'github/issue', { repo: 'team/private', number: 1 })).toMatchObject({ status: 403 })
    expect(f.teamApi).not.toHaveBeenCalled()
  })
})
