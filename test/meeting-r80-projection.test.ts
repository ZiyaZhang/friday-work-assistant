import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliveryContextResolver } from '../src/core/delivery-context.js'
import { ExecutionMaterials, type MaterialContext, type MaterialProvenance } from '../src/core/execution-materials.js'
import { ExecutionSourceAccess, type ExecutionSourceActor, type ExecutionSourceAccessResult } from '../src/core/execution-source-access.js'
import type { MeetingSourceReceipt } from '../src/core/meeting-source.js'
import type { MyDayDomainSourceReceipt } from '../src/core/personal-assistant-sources.js'
import { PersonalMemoryAccess } from '../src/core/personal-memory-access.js'
import type { PollSourceReceipt } from '../src/core/poll-source.js'
import { Registry } from '../src/core/registry.js'
import { SourceContexts } from '../src/core/source-context.js'
import { UserMessageReadAccess } from '../src/core/user-message-read-lease.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(close => close()) })

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'friday-meeting-sources-')), registry = new Registry(join(home, 'db'))
  cleanups.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  const { spaces, policy } = spaceDeps(registry.db)
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm_alice', openId: 'alice' })
  const sources = new SourceContexts(registry), binding = { sessionKey: 'dm:alice', acpSessionId: 'acp-a', spaceId: dm.id, chatId: dm.chatId! }
  sources.initialize(binding, [])
  const meeting: MeetingSourceReceipt = { version: 1, sessionId: 'meeting-session', sessionVersion: 'version-a', meetingId: 'platform-meeting',
    ownerOpenId: 'alice', spaceId: dm.id, chatId: dm.chatId!, revision: 2, eventsDigest: 'e'.repeat(64), complete: true }
  const myDay: MyDayDomainSourceReceipt = { version: 1, kind: 'todo', id: 7, appId: 'app-a', sourceSpaceId: 'group-space', sourceChatId: 'oc_team',
    sourceScope: 'space:group-space', sourceSessionKey: null, viewerOpenId: 'alice', privateSpaceId: dm.id, privateChatId: dm.chatId!, contentDigest: 'd'.repeat(64) }
  const poll: PollSourceReceipt = { version: 2, pollId: 'poll-a', pollVersion: 'poll-version', spaceId: dm.id, chatId: dm.chatId!,
    contentDigest: 'c'.repeat(64), snapshotDigest: 'f'.repeat(64), ballotRevision: 1, state: 'open' }
  return { registry, spaces, policy, dm, sources, binding, meeting, myDay, poll }
}

/** Shared-file behaviour this projection adds on the r80 base, where My Day and poll receipts already live in the same records. */
describe('meeting receipts in r80 source records', () => {
  it('keeps one meeting receipt regardless of key order, next to My Day and poll receipts, and rejects another chat or an invalid receipt', () => {
    const t = setup()
    t.sources.recordMyDaySource(t.binding, t.myDay)
    t.sources.recordMeetingSource(t.binding, t.meeting)
    // Material provenance is stored as canonical JSON, so a consumed receipt comes back with sorted keys.
    const sorted = Object.fromEntries(Object.entries(t.meeting).sort(([a], [b]) => a.localeCompare(b))) as unknown as MeetingSourceReceipt
    t.sources.recordRetained(t.binding, { ...t.sources.get(t.binding.sessionKey)!, meetingSources: [sorted] })
    const context = t.sources.get(t.binding.sessionKey)!
    expect(context.meetingSources).toEqual([t.meeting])
    expect(context.myDaySources).toEqual([t.myDay])
    // A later execution in the same private chat (a CI or Issue continuation) gets the retained receipts back once.
    const later = { ...t.binding, sessionKey: 'dm:alice:later', acpSessionId: 'acp-later' }
    t.sources.initialize(later, [])
    t.sources.recordRetained(later, { ...structuredClone(context), meetingSources: [sorted] })
    t.sources.recordRetained(later, structuredClone(context))
    expect(t.sources.get(later.sessionKey)).toMatchObject({ meetingSources: [t.meeting], myDaySources: [t.myDay] })
    expect(() => t.sources.recordMeetingSource(t.binding, { ...t.meeting, chatId: 'oc_team' })).toThrow('会议来源不属于当前执行空间')
    expect(() => t.sources.recordMeetingSource({ ...t.binding, acpSessionId: 'other-acp' }, t.meeting)).toThrow('会议来源不属于当前执行空间')
    expect(() => t.sources.recordMeetingSource(t.binding, { ...t.meeting, revision: -1 })).toThrow('会议来源不属于当前执行空间')
    t.registry.setKv('delivery-sources:dm:alice', JSON.stringify({ ...context, meetingSources: [{ ...t.meeting, version: 2 }] }))
    expect(t.sources.get(t.binding.sessionKey)).toBeUndefined()
  })

  it('refuses a file edit whose new provenance drops a meeting receipt the old version depended on', () => {
    const home = mkdtempSync(join(tmpdir(), 'friday-meeting-materials-')), db = new DatabaseSync(join(home, 'db'))
    cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }) })
    const t = setup(), store = new ExecutionMaterials(db, join(home, 'private'), { now: () => 1234 })
    const ctx: MaterialContext = { sessionKey: 'dm:alice', spaceId: t.dm.id, generation: 'acp-a', runId: 'run-a', assertCurrent() {} }
    store.openGeneration(ctx)
    const provenance: MaterialProvenance = { sources: { version: 1, acpSessionId: 'acp-a', spaceId: t.dm.id, chatId: t.dm.chatId!,
      memoryScopes: [], chats: [], external: [], repositories: [], meetingSources: [t.meeting] }, memoryRefs: [] }
    const original = store.register(ctx, { operationKey: 'original', name: 'minutes.txt', data: Buffer.from('original'), provenance })
    const edit = (operationKey: string, meetingSources: MeetingSourceReceipt[]) => store.edit(ctx, { fileId: original.fileId, expectedDigest: original.digest,
      operationKey, edits: [{ oldText: 'original', newText: 'changed' }], provenance: { ...structuredClone(provenance), sources: { ...structuredClone(provenance.sources), meetingSources } } })
    expect(() => edit('drop', [])).toThrow(expect.objectContaining({ code: 'provenance_conflict' }))
    expect(() => edit('replace', [{ ...t.meeting, eventsDigest: 'a'.repeat(64) }])).toThrow(expect.objectContaining({ code: 'provenance_conflict' }))
    expect(edit('keep', [t.meeting, { ...t.meeting, eventsDigest: 'a'.repeat(64), revision: 3 }]).provenance.sources.meetingSources).toHaveLength(2)
  })
})

describe('one private delivery chains My Day, meeting and poll guards', () => {
  function resolver(t: ReturnType<typeof setup>, checkers: Partial<Record<'myDay' | 'meeting' | 'poll', (items: readonly unknown[], audience: unknown, assertPrior: () => void) => Promise<ExecutionSourceAccessResult>>>) {
    return new DeliveryContextResolver({ sources: t.sources, spaces: t.spaces, appId: 'app-a',
      feishu: { listChats: vi.fn(async () => []), chatMemberOpenIds: vi.fn(async () => new Set<string>()) },
      ...(checkers.myDay ? { checkMyDaySources: checkers.myDay } : {}), ...(checkers.meeting ? { checkMeetingSources: checkers.meeting } : {}),
      ...(checkers.poll ? { checkPollSources: checkers.poll } : {}), disconnectPersonalConnection: () => false, now: () => 1_800_000_000_000 })
  }
  const execution = (t: ReturnType<typeof setup>) => ({ ...t.binding, actorOpenId: 'alice', chatType: 'p2p' as const,
    isLive: () => true, isCurrent: () => true, readScopes: () => [] })
  const dmAudience = (t: ReturnType<typeof setup>) => ({ audience: { kind: 'dm' as const, spaceId: t.dm.id, openId: 'alice' } })

  it('checks each class in order, cites the meeting snapshot, and every later guard includes the earlier leases without calling itself', async () => {
    const t = setup()
    t.sources.recordMyDaySource(t.binding, t.myDay); t.sources.recordMeetingSource(t.binding, t.meeting); t.sources.recordPollSource(t.binding, t.poll)
    const live = { myDay: true, meeting: true, poll: true }, order: string[] = [], prior: Record<string, () => void> = {}
    const checker = (name: keyof typeof live) => async (_items: readonly unknown[], _audience: unknown, assertPrior: () => void): Promise<ExecutionSourceAccessResult> => {
      order.push(name); prior[name] = assertPrior; assertPrior()
      return { status: 'allowed', assertCurrent: () => { assertPrior(); if (!live[name]) throw new Error(`${name} lease revoked`) } }
    }
    const ready = await resolver(t, { myDay: checker('myDay'), meeting: checker('meeting'), poll: checker('poll') }).resolveResult(execution(t), dmAudience(t))
    expect(ready.status).toBe('ready')
    if (ready.status !== 'ready') return
    expect(order).toEqual(['myDay', 'meeting', 'poll'])
    expect(ready.context.sources.map(source => source.ref)).toEqual(expect.arrayContaining([`meeting:${t.meeting.sessionId}:${t.meeting.eventsDigest}`]))
    expect(ready.context.isCurrent?.()).toBe(true)
    live.myDay = false
    expect(ready.context.isCurrent?.()).toBe(false)
    expect(() => prior.meeting!()).toThrow('会议资料投递上下文已变化')
    expect(() => prior.poll!()).toThrow('投票资料投递上下文已变化')
    live.myDay = true; live.meeting = false
    expect(ready.context.isCurrent?.()).toBe(false)
    expect(() => prior.meeting!()).not.toThrow()
    expect(() => prior.poll!()).toThrow('投票资料投递上下文已变化')
    live.meeting = true
    expect(ready.context.isCurrent?.()).toBe(true)
  })

  it('never sends meeting events to a group and fails closed without a meeting checker or with a denied receipt', async () => {
    const t = setup()
    t.sources.recordMeetingSource(t.binding, t.meeting)
    const allow = async (_items: readonly unknown[], _audience: unknown, assertPrior: () => void): Promise<ExecutionSourceAccessResult> => ({ status: 'allowed', assertCurrent: assertPrior })
    expect(await resolver(t, { meeting: allow }).resolveResult(execution(t), { audience: { kind: 'group', spaceId: t.dm.id, chatId: t.dm.chatId! } }))
      .toMatchObject({ status: 'blocked', failure: { reason: 'audience_mismatch' } })
    expect(await resolver(t, {}).resolveResult(execution(t), dmAudience(t))).toMatchObject({ status: 'blocked', failure: { reason: 'source_unverifiable' } })
    const deny = async (_items: readonly unknown[], _audience: unknown, assertPrior: () => void): Promise<ExecutionSourceAccessResult> =>
      ({ status: 'denied', reason: 'meetings_closed', assertCurrent: assertPrior })
    expect(await resolver(t, { meeting: deny }).resolveResult(execution(t), dmAudience(t))).toMatchObject({ status: 'blocked', failure: { reason: 'source_unverifiable' } })
    // With only meeting receipts, the delivery stays current exactly while the meeting lease holds.
    let live = true
    const revocable = async (_items: readonly unknown[], _audience: unknown, assertPrior: () => void): Promise<ExecutionSourceAccessResult> =>
      ({ status: 'allowed', assertCurrent: () => { assertPrior(); if (!live) throw new Error('meeting lease revoked') } })
    const ready = await resolver(t, { meeting: revocable }).resolveResult(execution(t), dmAudience(t))
    expect(ready.status).toBe('ready')
    if (ready.status !== 'ready') return
    expect(ready.context.isCurrent?.()).toBe(true)
    live = false
    expect(ready.context.isCurrent?.()).toBe(false)
  })
})

describe('history reuse after a meeting read', () => {
  function access(t: ReturnType<typeof setup>, checkMeetingSources?: (items: readonly MeetingSourceReceipt[], audience: unknown, assertPrior: () => void) => Promise<ExecutionSourceAccessResult>) {
    const userTokens = new UserTokenStore(t.registry.db, { exchangeCode: async () => { throw new Error('not expected') }, refresh: async () => { throw new Error('not expected') } })
    const feishu = { listChatsResult: vi.fn(async () => ({ items: [], complete: true })), chatMemberOpenIds: vi.fn(async () => new Set<string>()),
      readDocument: vi.fn(), listMyEvents: vi.fn(async () => []), whoAmI: vi.fn(async () => { throw new Error('not expected') }) }
    const deps = { appId: 'app-a', spaces: t.spaces, policy: t.policy, userTokens, feishu }
    return new ExecutionSourceAccess({ ...deps, personalMemory: new PersonalMemoryAccess(deps), userReads: new UserMessageReadAccess(deps),
      repositoryAllowed: () => false, ...(checkMeetingSources ? { checkMeetingSources } : {}) })
  }
  const actor = (t: ReturnType<typeof setup>): ExecutionSourceActor => ({ runId: 'run-next', openId: 'alice', spaceId: t.dm.id, chatId: t.dm.chatId!,
    chatType: 'p2p', acpSessionId: t.binding.acpSessionId, readScopes: () => [], assertCurrent: () => {} })

  it('reuses the conversation only while the meeting receipt still holds, and never without a checker', async () => {
    const t = setup()
    t.sources.recordMeetingSource(t.binding, t.meeting)
    const source = t.sources.get(t.binding.sessionKey)!
    let current = true
    const checker = vi.fn(async (_items: readonly MeetingSourceReceipt[], _audience: unknown, assertPrior: () => void): Promise<ExecutionSourceAccessResult> =>
      current ? { status: 'allowed', assertCurrent: assertPrior } : { status: 'denied', reason: 'meetings_closed', assertCurrent: assertPrior })
    expect((await access(t, checker).check(actor(t), source)).status).toBe('allowed')
    expect(checker).toHaveBeenCalledWith([t.meeting], expect.objectContaining({ openId: 'alice', spaceId: t.dm.id }), expect.any(Function))
    expect(await access(t).check(actor(t), source)).toMatchObject({ status: 'unavailable', reason: 'meeting_source_unverified' })
    current = false
    expect(await access(t, checker).check(actor(t), source)).toMatchObject({ status: 'denied', reason: 'meetings_closed' })
    expect(await access(t, checker).check(actor(t), { ...source, meetingSources: [{ ...t.meeting, eventsDigest: '' }] }))
      .toMatchObject({ status: 'unavailable', reason: 'source_incomplete' })
  })
})
