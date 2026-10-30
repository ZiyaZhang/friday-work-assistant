import { describe, expect, it, vi } from 'vitest'
import { PollHost, type PollHostBinding } from '../src/core/poll-host.js'
import { Polls } from '../src/core/polls.js'
import { RuntimeContexts } from '../src/core/runtime-contexts.js'
import { SourceContexts } from '../src/core/source-context.js'
import { normalizeCardAction } from '../src/feishu/ws.js'
import { EventDispatcher } from '@larksuiteoapi/node-sdk'
import type { PollSourceReceipt } from '../src/core/poll-source.js'
import { pollRuntimeFixture } from './helpers/poll-runtime.js'

/** Real admission/source/Work stores and actual normalized wire callbacks;
 * platform delivery and the external source provider remain synthetic. */
function fixture() {
  const t = pollRuntimeFixture(), contexts = new RuntimeContexts(t.registry.db), sources = new SourceContexts(t.registry)
  contexts.bind(t.run.id, t.run.sessionKey, 'acp-a')
  t.registry.updateSession(t.run.sessionKey, { acpSessionId: 'acp-a' })
  const binding: PollHostBinding = { ...t.ref, taskId: t.task.id, workKey: t.run.workKey, openId: 'alice', acpSessionId: 'acp-a',
    spaceId: t.group.id, chatId: t.group.chatId!, chatType: 'group', assertCurrent: t.current }
  const state = { allowed: true, proofChecks: 0 }, recordSource = vi.fn()
  const build = () => new PollHost({ registry: t.registry, attempts: t.attempts, contexts, sources,
    polls: new Polls(t.registry.db, () => t.state.now), bugs: t.bugs, ...t.sp, now: () => t.state.now,
    feishu: { sendToChat: t.send, chatMemberOpenIds: async () => { await t.state.beforeMembers?.(); return t.state.members } },
    participantName: async id => { await t.state.beforeName?.(); return id === 'bob' ? { status: 'known', name: 'Bob' } : { status: 'unknown' } },
    binding: ref => { if (ref.sessionKey !== binding.sessionKey || ref.runId !== binding.runId) throw new Error('wrong host Run'); return binding },
    assertChatAllowed: chatId => { if (!state.allowed || chatId !== t.group.chatId) throw new Error('group not allowed') },
    async authorizeSavedContext(_context, _origin, guard) {
      const version = t.state.sourceRevision
      await t.state.beforeSource?.(); guard()
      const current = () => { guard(); state.proofChecks++; if (version !== t.state.sourceRevision) throw new Error('source changed') }
      return t.state.sourceStatus === 'allowed' ? { status: 'allowed', assertCurrent: current }
        : { status: t.state.sourceStatus, reason: 'synthetic_source_failure', assertCurrent: current }
    },
    resolveDelivery: async (poll, _ref, guard) => { guard(); return { actorOpenId: poll.origin.ownerOpenId,
      audience: { kind: 'group', spaceId: poll.origin.spaceId, chatId: poll.origin.chatId },
      sources: [{ ref: 'original-source', spaceId: poll.origin.spaceId, chatId: poll.origin.chatId }],
      provenanceComplete: true, expiresAt: t.state.now + 60_000, isCurrent: () => { guard(); return true } } },
    recordSource, assertLifecycleCurrent: t.current,
  })
  const host = build()
  const wire = (pollId: string, optionId: string | null = '1', time = '1000000') => {
    const poll = t.polls.get(pollId)!
    return { event_id: `event-${time}`, create_time: time, operator: { open_id: 'bob' },
      context: { open_chat_id: t.group.chatId!, open_message_id: poll.messageId! },
      action: { tag: 'button', value: { action: 'poll_ballot', pollId, digest: poll.contentDigest, optionId } } }
  }
  return { ...t, host, build, binding, state, sourceState: t.state, contexts, recordSource, wire,
    create: () => host.runtime.create(t.ref, t.input) }
}

describe('production poll host assembly', () => {
  it('uses the real original request and exposes create/list/read/close with actual normalized ballots and feedback linkage', async () => {
    const t = fixture(), created = await t.create(), poll = t.polls.get(created.pollId)!
    expect(poll.origin).toMatchObject({ taskId: t.task.id, runId: t.run.id, workKey: t.run.workKey, requestMessageId: t.task.messageId })
    expect(poll.context.sources.acpSessionId).toBe('acp-a')
    expect((await t.host.runtime.list(t.ref)).polls.map(item => item.pollId)).toEqual([poll.id])
    expect(await t.host.handleCardAction(normalizeCardAction(t.wire(poll.id)))).toMatchObject({ toast: { type: 'success' } })
    const read = await t.host.runtime.read(t.ref, { pollId: poll.id })
    expect(read.results[0]).toMatchObject({ count: 1, voters: [{ name: 'Bob' }] })
    const closed = await t.host.runtime.close(t.ref, { pollId: poll.id })
    expect(t.bugs.get(closed.feedbackId!)).toMatchObject({ intakePhase: 'triaged', issueUrl: null })
    expect(t.bugs.reports(closed.feedbackId!)).toHaveLength(1)
    expect(t.recordSource).toHaveBeenLastCalledWith({ sessionKey: t.ref.sessionKey, acpSessionId: 'acp-a',
      spaceId: t.group.id, chatId: t.group.chatId }, expect.objectContaining({ pollId: poll.id, state: 'closed', ballotRevision: 1 }))
    expect(t.send).toHaveBeenCalledTimes(2)
  })

  it('does not take actor, sequence or provenance from card values or inconsistent normalized identities', async () => {
    const t = fixture(), { pollId } = await t.create()
    const forged = normalizeCardAction(t.wire(pollId)); forged.operatorOpenId = 'alice'
    expect(await t.host.handleCardAction(forged)).toMatchObject({ toast: { type: 'error' } })
    const supplied = t.wire(pollId); Object.assign(supplied.action.value, { event_id: 'pretend', operatorOpenId: 'alice' })
    expect(await t.host.handleCardAction(normalizeCardAction(supplied))).toMatchObject({ toast: { type: 'error' } })
    const missing = t.wire(pollId) as Record<string, unknown>; delete missing.create_time
    expect(await t.host.handleCardAction(normalizeCardAction(missing))).toMatchObject({ toast: { type: 'error' } })
    expect(t.polls.ballots(pollId)).toEqual([])
  })

  it('accepts retained SDK headers and preserves latest human choice across a new host instance', async () => {
    const t = fixture(), { pollId } = await t.create(), raw = t.wire(pollId)
    const { event_id, create_time, ...event } = raw
    await t.host.handleCardAction(normalizeCardAction({ ...event, header: { event_id, create_time } }))
    const next = t.build()
    await next.handleCardAction(normalizeCardAction(t.wire(pollId, '2', '3000000')))
    await next.handleCardAction(normalizeCardAction(t.wire(pollId, '1', '2000000')))
    expect(t.polls.tally(pollId).groups.map(group => group.count)).toEqual([0, 1])
    await next.handleCardAction(normalizeCardAction(t.wire(pollId, null, '4000000')))
    expect(t.polls.tally(pollId)).toMatchObject({ total: 0, withdrawn: 1 })
    const conflict = t.wire(pollId, '1', '5000000')
    expect(await next.handleCardAction(normalizeCardAction({ ...conflict, header: { create_time: '1' } })))
      .toMatchObject({ toast: { type: 'error' } })
    expect(t.polls.tally(pollId).total).toBe(0)
  })

  it('accepts the official SDK flattened event, without requiring invented callback fields', async () => {
    const t = fixture(), { pollId } = await t.create(), wire = t.wire(pollId)
    const { event_id, create_time, ...event } = wire
    const received = vi.fn(async data => t.host.handleCardAction(normalizeCardAction(data)))
    const dispatcher = new EventDispatcher({}).register({ 'card.action.trigger': received })
    // Synthetic authenticated transport; the SDK itself performs schema/header
    // normalization. Real WS authenticity remains the shared platform boundary.
    await dispatcher.invoke({ schema: '2.0', header: { event_id, create_time, event_type: 'card.action.trigger',
      app_id: 'synthetic-app', tenant_key: 'synthetic-tenant' }, event }, { needCheck: false })
    expect(received).toHaveBeenCalledOnce()
    expect(received.mock.calls[0]![0]).toMatchObject({ event_id, create_time, operator: { open_id: 'bob' } })
    expect(t.polls.tally(pollId).groups[0]?.count).toBe(1)
  })

  it('supports same-group derived state only while the exact poll and saved-source lease remain valid', async () => {
    const t = fixture(), { pollId } = await t.create(), source = t.recordSource.mock.lastCall![1] as PollSourceReceipt
    const audience = { openId: 'alice', spaceId: t.group.id, chatId: t.group.chatId!, chatType: 'group' as const }
    expect(t.host.runtime.sourcesCurrent([source], audience)).toBe(true)
    expect(t.build().runtime.sourcesCurrent([source], audience)).toBe(false)
    expect(t.host.runtime.sourcesCurrent([source], { ...audience, openId: 'bob' })).toBe(false)
    expect(t.host.runtime.sourcesCurrent([source], { ...audience, chatType: 'p2p' })).toBe(false)
    await t.host.handleCardAction(normalizeCardAction(t.wire(pollId)))
    expect(t.host.runtime.sourcesCurrent([source], audience)).toBe(true)
    await t.host.runtime.read(t.ref, { pollId })
    const updated = t.recordSource.mock.lastCall![1] as PollSourceReceipt
    expect(t.host.runtime.sourcesCurrent([source, updated], audience)).toBe(true)
    t.sourceState.sourceRevision++
    expect(t.host.runtime.sourcesCurrent([updated], audience)).toBe(false)
  })

  it('re-authorizes source receipts on the new host, preserving denial and withdrawal of the returned lease', async () => {
    const t = fixture(); await t.create(); const source = t.recordSource.mock.lastCall![1] as PollSourceReceipt
    const audience = { openId: 'bob', spaceId: t.group.id, chatId: t.group.chatId!, chatType: 'group' as const }, fresh = t.build()
    const result = await fresh.runtime.checkSources([source], audience, t.current)
    expect(result.status).toBe('allowed'); expect(fresh.runtime.sourcesCurrent([source], audience)).toBe(true)
    t.sp.spaces.removeMember(t.group.id, 'bob')
    expect(fresh.runtime.sourcesCurrent([source], audience)).toBe(false)
    expect(() => result.assertCurrent()).toThrow()
  })

  it('validates every retained permission proof once per pass without recursive expansion across observed revisions', async () => {
    const t = fixture(), { pollId } = await t.create()
    for (let revision = 1; revision <= 5; revision++) {
      await t.host.handleCardAction(normalizeCardAction(t.wire(pollId, revision % 2 ? '1' : '2', String(revision * 1_000_000))))
      await t.host.runtime.read(t.ref, { pollId })
    }
    const sources = t.recordSource.mock.calls.map(call => call[1] as PollSourceReceipt)
    expect(sources).toHaveLength(6)
    const access = await t.build().runtime.checkSources(sources,
      { openId: 'alice', spaceId: t.group.id, chatId: t.group.chatId!, chatType: 'group' }, t.current)
    t.state.proofChecks = 0; access.assertCurrent()
    expect(t.state.proofChecks).toBe(sources.length)
    t.sourceState.sourceRevision++
    expect(() => access.assertCurrent()).toThrow('source changed')
  })

  it.each(['actor', 'task', 'source', 'acp', 'closed_run'] as const)('rejects a host binding inconsistent with real %s facts', async kind => {
    const t = fixture()
    if (kind === 'actor') t.binding.openId = 'bob'
    if (kind === 'task') t.binding.taskId = 999
    if (kind === 'source') t.binding.spaceId = 'foreign-space'
    if (kind === 'acp') t.registry.updateSession(t.ref.sessionKey, { acpSessionId: 'replacement' })
    if (kind === 'closed_run') t.attempts.finish(t.run.id, 'completed', Date.now())
    await expect(t.create()).rejects.toThrow()
    expect(t.polls.list()).toEqual([]); expect(t.send).not.toHaveBeenCalled()
  })

  it('rechecks Work control after saved-source authorization and admits no late publication', async () => {
    const t = fixture()
    t.sourceState.beforeSource = async () => { t.registry.workContexts.control(t.run.workKey, { action: 'cancel', causeRef: 'real-stop' }) }
    await expect(t.create()).rejects.toThrow()
    expect(t.send).not.toHaveBeenCalled(); expect(t.polls.list()[0]?.state).toBe('draft')
  })

  it('keeps human ballots independent of the completed creating Run but respects current group allow-list', async () => {
    const t = fixture(), { pollId } = await t.create()
    t.attempts.finish(t.run.id, 'completed', Date.now()); t.registry.updateTask(t.task.id, { status: 'done' })
    expect(await t.build().handleCardAction(normalizeCardAction(t.wire(pollId)))).toMatchObject({ toast: { type: 'success' } })
    t.state.allowed = false
    await expect(t.host.handleCardAction(normalizeCardAction(t.wire(pollId, '2', '2000000')))).rejects.toThrow('group not allowed')
    expect(t.polls.tally(pollId).groups.map(group => group.count)).toEqual([1, 0])
  })

  it('preserves unknown publication on a new host; another create never sends it twice', async () => {
    const t = fixture(); t.sourceState.failSend = true
    await expect(t.create()).rejects.toThrow()
    t.sourceState.failSend = false
    await expect(t.build().runtime.create(t.ref, t.input)).rejects.toThrow()
    expect(t.polls.list()).toHaveLength(1); expect(t.send).toHaveBeenCalledTimes(1)
  })
})
