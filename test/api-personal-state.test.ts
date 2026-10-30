import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { Inbox, decisionRef } from '../src/core/inbox.js'
import { RoutineStore } from '../src/core/routines.js'
import { Identities } from '../src/core/identities.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { GitHubIdentity } from '../src/github/identity.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { ALL_SCOPES, GROUP_SCOPES, PROACTIVE_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(options: { policy?: 'deny'; noHost?: boolean; noSourceGate?: boolean } = {}) {
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db)
  const memoryHost = memoryRuntimeFixture(registry, memory), sp = spaceDeps(registry.db, { mode: options.policy })
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  sp.spaces.addMember(space.id, 'bob', 'member')
  const inbox = new Inbox(registry.db), routines = new RoutineStore(registry.db)
  const feishu = Object.assign(new FakeFeishu(), { chatMembers: vi.fn(async (): Promise<{ openId: string; name: string }[]> => []) })
  const identities = new Identities(registry.db)
  const tokens = new TokenIssuer('synthetic'), log = createLogger('personal-state-test', 'error')
  const state = { actor: { requesterOpenId: 'alice', runId: 'run-a', stage: 'task' }, safe: true }
  const connect = vi.fn(async () => ({ kind: 'card_sent', text: 'synthetic connection card' }))
  const github = new GitHubIdentity({ apiUrl: 'https://api.github.com', mode: 'pat', token: 'synthetic', allowedRepos: ['org/repo'], writableRepos: [] }, log)
  const noop = async () => ''
  const api = createInternalApi({ registry, memory, memoryRuntime: memoryHost.runtime, ...sp, inbox, routines, github, identities,
    feishu: asFeishuClient(feishu), messageCache: cache, messages: new MessageService(asFeishuClient(feishu), cache, log),
    todos: new Todos(registry.db), tokens, log, maxHistoryPerCall: 50,
    resolveActorForSession: options.noHost ? undefined : () => state.actor,
    canPersistDerivedState: options.noSourceGate ? undefined : () => state.safe,
    abilities: { status: noop, report: noop, wiki: noop, handover: noop, groups: noop, pmo: noop, settings: noop,
      explain: () => '', selfcheck: noop, connect: connect as NonNullable<InternalApiDeps['abilities']>['connect'] },
    // Deliberately no allowedRoutesForSession: the personal-state gate must reject
    // non-task stages even if a capability carries all scopes.
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())); registry.close() })
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const cap: Omit<Capability, 'exp'> = { sessionKey: 'session-a', runId: 'run-a', chatId: space.chatId, chatType: 'group', spaceId: space.id,
    requesterOpenId: 'alice', scopes: [...ALL_SCOPES] }
  const post = async (path: string, body: Record<string, unknown>, patch: Partial<Omit<Capability, 'exp'>> = {}) => {
    const res = await fetch(`${base}/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${tokens.issue({ ...cap, ...patch })}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as Record<string, any> }
  }
  return { registry, sp, space, inbox, routines, identities, feishu, cap, state, post, connect, calls: new RunApiCalls(registry.db) }
}

const personalWrites = [
  ['inbox/decision', { question: 'Which reviewed option should we use?', why: 'Only the requester can decide' }, 'todo:write'],
  ['github/login', { login: 'AliceGitHub' }, 'profile:write'],
] as const

describe('personal business state requires an interactive, authorized writer', () => {
  it.each(personalWrites)('%s records its actual write scope and ignores another owner supplied in the body', async (path, body, scope) => {
    const t = await fixture()
    const result = await t.post(path, { ...body, open_id: 'bob', ownerOpenId: 'bob' }, { scopes: [scope] })
    expect(result.status).toBe(200)
    expect(t.calls.forRun('run-a')).toMatchObject([{ route: `POST /v1/${path}`, state: 'returned', scopes: [scope] }])
    if (path === 'inbox/decision') expect(t.inbox.pending('alice')).toMatchObject([{ id: result.body.id, spaceId: t.space.id }])
    else expect(t.registry.getKv('github_login:alice')).toBe('AliceGitHub')
    expect(t.inbox.pending('bob')).toEqual([])
    expect(t.registry.getKv('github_login:bob')).toBeUndefined()
    expect(t.feishu.sent).toEqual([])
  })

  for (const boundary of ['empty', 'readonly', 'proactive', 'reflect', 'routine', 'stale-run', 'other-actor', 'unsafe-source', 'removed-member', 'suspended', 'deny-policy', 'no-host', 'no-source-gate'] as const) {
    it.each(personalWrites)(`rejects ${boundary} for %s without persistent business writes`, async (path, body) => {
      const t = await fixture({ policy: boundary === 'deny-policy' ? 'deny' : undefined, noHost: boundary === 'no-host', noSourceGate: boundary === 'no-source-gate' })
      const patch: Partial<Omit<Capability, 'exp'>> = {}
      if (boundary === 'empty') patch.scopes = []
      if (boundary === 'readonly') patch.scopes = ['todo:read', 'github:read', 'memory:write']
      if (boundary === 'proactive') patch.scopes = [...PROACTIVE_SCOPES]
      if (boundary === 'reflect' || boundary === 'routine') t.state.actor.stage = boundary
      if (boundary === 'stale-run') t.state.actor.runId = 'run-b'
      if (boundary === 'other-actor') t.state.actor.requesterOpenId = 'bob'
      if (boundary === 'unsafe-source') t.state.safe = false
      if (boundary === 'removed-member') t.sp.spaces.removeMember(t.space.id, 'alice')
      if (boundary === 'suspended') t.sp.spaces.suspend(t.space.id)
      const result = await t.post(path, { ...body, stage: 'task', runId: 'run-b', boundStage: 'task' }, patch)
      expect(result.status).toBe(boundary === 'no-host' || boundary === 'no-source-gate' ? 503 : 403)
      expect(t.inbox.pending('alice')).toEqual([])
      expect(t.registry.getKv('github_login:alice')).toBeUndefined()
      expect(t.feishu.sent).toEqual([])
    })
  }

  it('keeps personal preferences available to a current group member without workspace or repository write authority', async () => {
    const t = await fixture(); t.state.actor.requesterOpenId = 'bob'
    expect((await t.post('github/login', { login: 'BobGitHub' }, { requesterOpenId: 'bob', scopes: ['profile:write'] })).status).toBe(200)
    t.state.safe = false
    expect(await t.post('github/login', {}, { requesterOpenId: 'bob', scopes: ['github:read'] })).toMatchObject({ status: 200, body: { login: 'BobGitHub' } })
    expect((await t.post('github/login', {}, { requesterOpenId: 'bob', scopes: [] })).status).toBe(403)
    expect(GROUP_SCOPES).toContain('profile:write')
    expect(PROACTIVE_SCOPES).not.toContain('profile:write')
  })

  it('deduplicates within one owner and never claims another member’s matching decision', async () => {
    const t = await fixture(), question = 'Choose the launch date'
    const alice = await t.post('inbox/decision', { question })
    expect(await t.post('inbox/decision', { question: ' Choose\n the launch date ' })).toMatchObject({ status: 200, body: { id: alice.body.id, already_open: true } })
    t.state.actor.requesterOpenId = 'bob'
    const bob = await t.post('inbox/decision', { question }, { requesterOpenId: 'bob' })
    expect(bob.status).toBe(200)
    expect(bob.body.id).not.toBe(alice.body.id)
    expect(t.inbox.pending('bob')).toMatchObject([{ id: bob.body.id, ownerOpenId: 'bob' }])
  })

  it.each(['alice', 'bob'])('only reuses an ownerless legacy ref when its existing owner is the requester (%s)', async legacyOwner => {
    const t = await fixture(), question = 'Choose the migration time'
    const old = t.inbox.add({ ownerOpenId: legacyOwner, kind: 'decision', refId: decisionRef(t.space.id, question), spaceId: t.space.id, title: question })
    const before = t.inbox.get(old.id)
    const result = await t.post('inbox/decision', { question })
    expect(result.status).toBe(200)
    expect(result.body.id === old.id).toBe(legacyOwner === 'alice')
    expect(t.inbox.get(old.id)).toEqual(before)
    expect(t.inbox.get(result.body.id)?.ownerOpenId).toBe('alice')
  })
})

describe('adjacent personal and configuration effects share their real gates', () => {
  it('keeps connection repair available for unsafe-source tasks but excludes background and scope-less calls', async () => {
    const t = await fixture(), dm = t.sp.spaces.ensure({ kind: 'p2p', chatId: 'dm-a', openId: 'alice' })
    const cap = { chatId: dm.chatId, chatType: 'p2p' as const, spaceId: dm.id, scopes: ['dm:send'] }
    t.state.safe = false
    expect((await t.post('ability', { what: 'connect' }, cap)).status).toBe(200)
    expect(t.connect).toHaveBeenCalledTimes(1)
    expect((await t.post('ability', { what: 'connect' }, { ...cap, scopes: [] })).status).toBe(403)
    t.state.actor.stage = 'reflect'
    expect((await t.post('ability', { what: 'connect', stage: 'task' }, cap)).status).toBe(403)
    expect(t.connect).toHaveBeenCalledTimes(1)
  })

  it('checks the read capability before explaining injected memory or resolving a GitHub identity', async () => {
    const t = await fixture(), members = vi.spyOn(t.feishu, 'chatMembers')
    expect((await t.post('ability', { what: 'explain' }, { scopes: [] })).status).toBe(403)
    expect((await t.post('ability', { what: 'explain' }, { scopes: ['memory:read'] })).status).toBe(200)
    expect((await t.post('whois', { github_login: 'AliceGitHub' }, { scopes: [] })).status).toBe(403)
    expect(members).not.toHaveBeenCalled()
    expect((await t.post('whois', { github_login: 'AliceGitHub' }, { scopes: ['github:read'] })).status).toBe(200)
    expect(t.calls.forRun('run-a').at(-1)?.scopes).toEqual(['github:read'])
  })

  it('cannot update an identity cache after space membership changes during the provider read', async () => {
    const t = await fixture()
    t.identities.upsertFromRoster([{ login: 'AliceGitHub', name: 'Alice' }])
    vi.spyOn(t.feishu, 'chatMembers').mockImplementation(async () => {
      t.sp.spaces.removeMember(t.space.id, 'alice')
      return [{ openId: 'alice', name: 'Alice' }]
    })
    expect((await t.post('whois', { github_login: 'AliceGitHub' })).status).toBe(403)
    expect(t.identities.byLogin('AliceGitHub')?.openId).toBeNull()
  })

  it.each([{ repo: 'org/repo' }, { off: true }])('requires configuration capability while allowing explicit revocation of issue-watch %j', async body => {
    const t = await fixture(), key = `issue-watch:${t.space.id}`
    t.registry.setKv(key, 'existing binding')
    expect((await t.post('github/issue-watch', body, { scopes: ['github:read'] })).status).toBe(403)
    expect(t.registry.getKv(key)).toBe('existing binding')
    t.state.safe = false
    const disabling = 'off' in body
    expect((await t.post('github/issue-watch', body)).status).toBe(disabling ? 200 : 403)
    expect(t.registry.getKv(key)).toBe(disabling ? '' : 'existing binding')
    t.state.safe = true
    expect((await t.post('github/issue-watch', body)).status).toBe(200)
    expect(t.calls.forRun('run-a').at(-1)?.scopes).toEqual(['github:read', 'space:configure'])
  })

  it('records a sent proposal ACK but cannot add an inbox item after its run stopped during delivery', async () => {
    const t = await fixture()
    let deliver!: (id: string) => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    vi.spyOn(t.feishu, 'sendToChat').mockImplementation(async () => { entered(); return new Promise<string>(resolve => { deliver = resolve }) })
    const request = t.post('responsibility/propose', { name: 'Synthetic review', prompt: 'Read authorized context', schedule: { type: 'daily', at: '09:00' } })
    // If validation unexpectedly rejects before delivery, fail instead of waiting
    // for a delivery hook that will never be reached.
    await Promise.race([started, request.then(result => { throw new Error(`request ended before delivery: ${result.status}`) })])
    t.state.actor.runId = 'next-run'; deliver('sent-card')
    expect((await request).status).toBe(403)
    const proposal = t.routines.proposals(t.space.id)[0]
    expect(proposal?.cardMessageId).toBe('sent-card')
    expect(t.inbox.pending('alice')).toEqual([])
  })
})
