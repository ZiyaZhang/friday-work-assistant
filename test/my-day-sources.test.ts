/**
 * 我的一天读到别的群里的待办 / 待拍板事项后，这些来源怎样随本次私聊执行保存、投递和续接。
 * 全部用真实 SQLite 领域表与真实的来源复核；只有飞书的群成员查询是合成的。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Registry } from '../src/core/registry.js'
import { SourceContexts, type SourceContext } from '../src/core/source-context.js'
import { DeliveryContextResolver } from '../src/core/delivery-context.js'
import { ExecutionSourceAccess, type ExecutionSourceActor } from '../src/core/execution-source-access.js'
import { PersonalMemoryAccess } from '../src/core/personal-memory-access.js'
import { UserMessageReadAccess } from '../src/core/user-message-read-lease.js'
import { createPersonalAssistantSources } from '../src/core/personal-assistant-sources.js'
import { Inbox } from '../src/core/inbox.js'
import { Todos } from '../src/core/todos.js'
import { spaceScope } from '../src/core/space.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { spaceDeps } from './helpers/space.js'

const NOW = 1_800_000_000_000
const opened: { close(): void }[] = []
afterEach(() => { for (const item of opened.splice(0)) item.close() })

function setup() {
  const registry = new Registry(':memory:'); opened.push(registry)
  const { spaces, policy } = spaceDeps(registry.db)
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm_alice', openId: 'alice' })
  const group = spaces.ensure({ kind: 'group', chatId: 'oc_team', openId: 'bob', title: '产品群' })
  spaces.addMember(group.id, 'alice', 'member')
  const todos = new Todos(registry.db), inbox = new Inbox(registry.db)
  const todo = todos.add({ scope: spaceScope(group.id), title: '评审群内方案', ownerOpenId: 'alice', createdBy: 'bob' })
  const decision = inbox.add({ ownerOpenId: 'alice', kind: 'decision', spaceId: group.id, title: '要不要延期发布', now: NOW - 3600_000 })
  const members = new Map([['oc_team', new Set(['alice', 'bob'])]])
  const memberRead = vi.fn(async (chatId: string, assertCurrent: () => void) => { assertCurrent(); return members.get(chatId) ?? new Set<string>() })
  let readable = true
  const domain = createPersonalAssistantSources({ appId: 'app-a', spaces, policy, todos, inbox,
    readable: () => readable, members: memberRead })
  const binding = { sessionKey: 'dm:alice', acpSessionId: 'acp-day', spaceId: dm.id, chatId: dm.chatId! }
  const sources = new SourceContexts(registry)
  sources.initialize(binding, [])
  const audience = { openId: 'alice', spaceId: dm.id, chatId: dm.chatId!, chatType: 'p2p' as const }
  const record = (read: Parameters<typeof domain.capture>[0]) => sources.recordMyDaySource(binding, domain.capture(read, audience, () => {}))
  return { registry, spaces, policy, dm, group, todos, inbox, todo, decision, members, memberRead, domain, sources, binding, audience, record,
    stopReading: () => { readable = false } }
}

describe('My Day domain receipts in the private run context', () => {
  it('records exact group receipts once, only for the viewer’s own private execution', () => {
    const t = setup()
    t.record({ kind: 'todo', todoId: t.todo.id, chatId: 'oc_team', spaceId: t.group.id })
    t.record({ kind: 'todo', todoId: t.todo.id, chatId: 'oc_team', spaceId: t.group.id })
    t.record({ kind: 'decision', inboxId: t.decision.id, chatId: 'oc_team', spaceId: t.group.id })
    const context = t.sources.get(t.binding.sessionKey)!
    expect(context.myDaySources).toMatchObject([
      { kind: 'todo', id: t.todo.id, sourceChatId: 'oc_team', viewerOpenId: 'alice', privateChatId: 'oc_dm_alice' },
      { kind: 'decision', id: t.decision.id, sourceChatId: 'oc_team', viewerOpenId: 'alice' },
    ])
    // A later binding (another ACP or another private chat) cannot take over these receipts.
    const receipt = context.myDaySources![0]!
    expect(() => t.sources.recordMyDaySource({ ...t.binding, acpSessionId: 'other-acp' }, receipt)).toThrow('不属于当前执行空间')
    expect(() => t.sources.recordMyDaySource(t.binding, { ...receipt, privateChatId: 'oc_other_dm' })).toThrow('不属于当前执行空间')
    expect(() => t.sources.recordMyDaySource(t.binding, { ...receipt, contentDigest: 'not-a-digest' })).toThrow('不属于当前执行空间')
    // Retained contexts replay the same receipts idempotently.
    t.sources.recordRetained(t.binding, structuredClone(context))
    expect(t.sources.get(t.binding.sessionKey)!.myDaySources).toHaveLength(2)
  })

  it('does not capture a row the viewer no longer owns or can no longer see in the original group', () => {
    const t = setup()
    t.todos.update(t.todo.id, t.todo.scope, { ownerOpenId: 'bob' })
    expect(() => t.record({ kind: 'todo', todoId: t.todo.id, chatId: 'oc_team', spaceId: t.group.id })).toThrow()
    t.stopReading()
    expect(() => t.record({ kind: 'decision', inboxId: t.decision.id, chatId: 'oc_team', spaceId: t.group.id })).toThrow()
    expect(t.sources.get(t.binding.sessionKey)!.myDaySources).toBeUndefined()
  })

  it('treats a reminder nudge as no content change, but a changed decision or todo as a changed source', async () => {
    const t = setup()
    t.record({ kind: 'todo', todoId: t.todo.id, chatId: 'oc_team', spaceId: t.group.id })
    t.record({ kind: 'decision', inboxId: t.decision.id, chatId: 'oc_team', spaceId: t.group.id })
    const receipts = t.sources.get(t.binding.sessionKey)!.myDaySources!
    t.inbox.markNudged([t.decision.id], NOW)
    expect((await t.domain.check(receipts, t.audience, () => {})).status).toBe('allowed')
    t.registry.db.prepare('UPDATE inbox_items SET title = ? WHERE id = ?').run('改了的问题', t.decision.id)
    expect(await t.domain.check(receipts, t.audience, () => {})).toMatchObject({ status: 'denied', reason: 'domain_source_or_audience_changed' })
    t.registry.db.prepare('UPDATE inbox_items SET title = ? WHERE id = ?').run('要不要延期发布', t.decision.id)
    t.todos.update(t.todo.id, t.todo.scope, { title: '评审群内方案（改）' })
    expect((await t.domain.check(receipts, t.audience, () => {})).status).toBe('denied')
  })
})

describe('delivery of a My Day answer', () => {
  function resolverFor(t: ReturnType<typeof setup>, withChecker = true) {
    return new DeliveryContextResolver({ sources: t.sources, spaces: t.spaces, appId: 'app-a',
      feishu: { listChats: vi.fn(async () => []), chatMemberOpenIds: vi.fn(async () => new Set<string>()) },
      ...(withChecker ? { checkMyDaySources: (items, audience, guard) => t.domain.check(items, audience, guard) } : {}),
      disconnectPersonalConnection: () => false, now: () => NOW })
  }
  const execution = (t: ReturnType<typeof setup>) => ({ ...t.binding, actorOpenId: 'alice', chatType: 'p2p' as const,
    isLive: () => true, isCurrent: () => true, readScopes: () => [] })

  it('goes back only to the viewer’s private chat, with each receipt rechecked and cited', async () => {
    const t = setup()
    t.record({ kind: 'todo', todoId: t.todo.id, chatId: 'oc_team', spaceId: t.group.id })
    const ready = await resolverFor(t).resolveResult(execution(t), { audience: { kind: 'dm', spaceId: t.dm.id, openId: 'alice' } })
    expect(ready.status).toBe('ready')
    const receipt = t.sources.get(t.binding.sessionKey)!.myDaySources![0]!
    if (ready.status === 'ready') expect(ready.context.sources.map(source => source.ref)).toContain(`my-day:todo:${t.todo.id}:${receipt.contentDigest}`)
    expect(t.memberRead).toHaveBeenCalledWith('oc_team', expect.any(Function))
    const toGroup = await resolverFor(t).resolveResult(execution(t), { audience: { kind: 'group', spaceId: t.group.id, chatId: 'oc_team' } })
    expect(toGroup).toMatchObject({ status: 'blocked', failure: { reason: 'audience_mismatch' } })
  })

  it('is blocked when the viewer left the original group or the checker is not wired', async () => {
    const t = setup()
    t.record({ kind: 'todo', todoId: t.todo.id, chatId: 'oc_team', spaceId: t.group.id })
    const dm = { audience: { kind: 'dm' as const, spaceId: t.dm.id, openId: 'alice' } }
    expect(await resolverFor(t, false).resolveResult(execution(t), dm)).toMatchObject({ status: 'blocked', failure: { reason: 'source_unverifiable' } })
    t.members.set('oc_team', new Set(['bob']))
    expect(await resolverFor(t).resolveResult(execution(t), dm)).toMatchObject({ status: 'blocked', failure: { reason: 'source_unverifiable' } })
  })
})

describe('history reuse after a My Day read', () => {
  async function access(t: ReturnType<typeof setup>, withChecker = true) {
    const db = t.registry.db as DatabaseSync
    const userTokens = new UserTokenStore(db, { exchangeCode: async () => { throw new Error('not expected') }, refresh: async () => { throw new Error('not expected') } })
    const feishu = { listChatsResult: vi.fn(async () => ({ items: [], complete: true })), chatMemberOpenIds: vi.fn(async () => new Set<string>()),
      readDocument: vi.fn(), listMyEvents: vi.fn(async () => []) }
    const deps = { appId: 'app-a', spaces: t.spaces, policy: t.policy, userTokens, feishu }
    return new ExecutionSourceAccess({ ...deps, personalMemory: new PersonalMemoryAccess(deps), userReads: new UserMessageReadAccess(deps),
      repositoryAllowed: () => false, ...(withChecker ? { checkMyDaySources: (items, audience, guard) => t.domain.check(items, audience, guard) } : {}) })
  }
  const actor = (t: ReturnType<typeof setup>): ExecutionSourceActor => ({ runId: 'run-next', openId: 'alice', spaceId: t.dm.id, chatId: t.dm.chatId!,
    chatType: 'p2p', acpSessionId: t.binding.acpSessionId, readScopes: () => [], assertCurrent: () => {} })

  it('reuses the conversation only while every receipt still holds', async () => {
    const t = setup()
    t.record({ kind: 'todo', todoId: t.todo.id, chatId: 'oc_team', spaceId: t.group.id })
    const source = t.sources.get(t.binding.sessionKey)! as SourceContext
    expect((await (await access(t)).check(actor(t), source)).status).toBe('allowed')
    expect(await (await access(t, false)).check(actor(t), source)).toMatchObject({ status: 'unavailable', reason: 'my_day_source_unverified' })
    t.members.set('oc_team', new Set(['bob']))
    expect(await (await access(t)).check(actor(t), source)).toMatchObject({ status: 'denied', reason: 'domain_membership_denied' })
  })
})
