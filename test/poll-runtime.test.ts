import { describe, expect, it } from 'vitest'
import { pollRuntimeFixture } from './helpers/poll-runtime.js'
import { measureTodoCard } from '../src/feishu/todo-card-pagination.js'

describe('poll host composition (synthetic platform, real Work/Delivery/Feedback stores)', () => {
  it('publishes the full card, accepts real named changes, and atomically links the closed result to a pending decision', async () => {
    const t = pollRuntimeFixture(), opened = await t.open(), poll = t.polls.get(opened.pollId)!
    await t.vote(poll.id, '1'); await t.vote(poll.id, '2', '2000000'); await t.vote(poll.id, '1', '3000000', 'carol')
    const read = await t.runtime.read(t.ref, { pollId: poll.id })
    expect(read.results.map(group => group.count)).toEqual([1, 1]); expect(read.results[1]?.voters).toEqual([{ name: 'Bob' }])
    const closed = await t.runtime.close(t.ref, { pollId: poll.id })
    expect(closed).toMatchObject({ state: 'closed', resultDelivered: true })
    expect(t.bugs.get(closed.feedbackId!)).toMatchObject({ intakePhase: 'triaged', issueUrl: null })
    expect(t.bugs.reports(closed.feedbackId!)).toHaveLength(1)
    await t.runtime.close(t.ref, { pollId: poll.id }); await t.runtime.tick()
    expect(t.bugs.reports(closed.feedbackId!)).toHaveLength(1); expect(t.send).toHaveBeenCalledTimes(2)
    expect(t.fake.sent.every(item => item.target === t.group.chatId)).toBe(true)
    const final = JSON.stringify(t.fake.sent[1]?.payload)
    expect(final).toContain('Bob'); expect(final).toContain('Carol'); expect(final).not.toContain('bob'); expect(final).not.toContain('carol')
    const card = (t.fake.sent[0]!.payload as { card: Record<string, unknown> }).card
    expect(measureTodoCard(card, { kind: 'create', receiveId: t.group.chatId! }).fits).toBe(true)
    for (const option of t.input.choices) expect(JSON.stringify(card)).toContain(option)
  })
  it('prevents model-created votes and refuses forged event bindings, wrong members, stale actor and closed votes', async () => {
    const t = pollRuntimeFixture(), opened = await t.open(), poll = t.polls.get(opened.pollId)!
    const callback = { pollId: poll.id, digest: poll.contentDigest, optionId: '1', operatorOpenId: 'bob', chatId: t.group.chatId!, messageId: poll.messageId!, eventId: 'e', eventTimeMicros: '100' }
    for (const patch of [{ chatId: 'other' }, { messageId: 'other' }, { digest: 'other' }, { operatorOpenId: 'outsider' }, { eventTimeMicros: '' }])
      await expect(t.runtime.vote({ ...callback, ...patch }, t.current)).rejects.toThrow()
    t.state.members.delete('bob'); await expect(t.runtime.vote(callback, t.current)).rejects.toThrow(); expect(t.polls.ballots(poll.id)).toEqual([])
    t.state.members.add('bob'); await t.runtime.vote(callback, t.current); await t.runtime.close(t.ref, { pollId: poll.id })
    await expect(t.vote(poll.id, null, '200')).rejects.toThrow(expect.objectContaining({ code: 'closed' }))
  })
  it('admits a real first-time group participant only after fresh membership proof', async () => {
    const t = pollRuntimeFixture(), opened = await t.open()
    await expect(t.vote(opened.pollId, '1', '100', 'new-member')).rejects.toThrow()
    expect(t.sp.spaces.roleOf(t.group.id, 'new-member')).toBeUndefined()
    t.state.members.add('new-member'); await t.vote(opened.pollId, '1', '200', 'new-member')
    expect(t.sp.spaces.roleOf(t.group.id, 'new-member')).toBe('member')
    const read = await t.runtime.read(t.ref, { pollId: opened.pollId })
    expect(read.results[0]?.voters).toEqual([{ name: null }])
    expect(JSON.stringify(read)).not.toContain('new-member')
  })
  it.each(['source', 'members', 'name'] as const)('rechecks permissions after the %s await before committing a ballot', async stage => {
    const t = pollRuntimeFixture(), opened = await t.open()
    const revoke = async () => { t.sp.spaces.removeMember(t.group.id, 'bob') }
    if (stage === 'source') t.state.beforeSource = revoke
    if (stage === 'members') t.state.beforeMembers = revoke
    if (stage === 'name') t.state.beforeName = revoke
    await expect(t.vote(opened.pollId, '1')).rejects.toThrow(); expect(t.polls.ballots(opened.pollId)).toEqual([])
  })
  it('keeps a real publication ACK on stop and does not resend when create is retried', async () => {
    const t = pollRuntimeFixture(); t.state.beforeSend = async () => { t.state.live = false }
    await expect(t.open()).rejects.toThrow('host stopped')
    const poll = t.polls.list()[0]!; expect(poll).toMatchObject({ state: 'open', messageId: expect.any(String) })
    t.state.live = true; t.state.beforeSend = undefined; await t.open(); expect(t.send).toHaveBeenCalledTimes(1)
  })
  it('does not resend an unknown publication or advance to result fragments after an unknown ACK', async () => {
    const t = pollRuntimeFixture(); t.state.failSend = true
    await expect(t.open()).rejects.toThrow(); t.state.failSend = false
    await expect(t.open()).rejects.toThrow(); expect(t.send).toHaveBeenCalledTimes(1); expect(t.polls.list()[0]?.state).toBe('draft')
  })
  it('retains observed snapshots after votes change, while audience and source permissions stay live', async () => {
    const t = pollRuntimeFixture(), opened = await t.open(), source = t.sources.at(-1)!
    const audience = { spaceId: t.group.id, chatId: t.group.chatId!, chatType: 'group' as const, openId: 'bob' }
    const access = await t.runtime.checkSources([source], audience, t.current)
    expect(access.status).toBe('allowed')
    for (const patch of [{ chatType: 'p2p' as const }, { chatId: 'other' }, { openId: 'outsider' }]) {
      try { expect((await t.runtime.checkSources([source], { ...audience, ...patch }, t.current)).status).toBe('denied') }
      catch (error) { expect(error).toMatchObject({ code: 'denied' }) }
    }
    await t.vote(opened.pollId, '1'); expect(() => access.assertCurrent()).not.toThrow()
    expect((await t.runtime.checkSources([source], audience, t.current)).status).toBe('allowed')
    await t.runtime.read(t.ref, { pollId: opened.pollId })
    const newer = t.sources.at(-1)!
    t.state.sourceStatus = 'unavailable'
    expect(await t.runtime.checkSources([newer], audience, t.current)).toMatchObject({ status: 'unavailable', reason: 'synthetic_source_failure' })
  })
  it('honors manual zero deadline and automatically closes a real deadline once', async () => {
    const t = pollRuntimeFixture(), manual = await t.runtime.create(t.ref, { ...t.input, closesAt: 0 })
    t.state.now += 86_400_000; await t.runtime.tick(); expect(t.polls.get(manual.pollId)?.state).toBe('open')
    // A separate actual user request, not a guessed default deadline.
    t.origin.requestMessageId = 'second-message'
    const timed = await t.runtime.create(t.ref, { ...t.input, closesAt: t.state.now + 1000 })
    await t.vote(timed.pollId, '1'); t.state.now += 1000
    await t.runtime.tick(); await t.runtime.tick()
    expect(t.polls.get(timed.pollId)?.state).toBe('closed'); expect(t.bugs.list(t.group.id)).toHaveLength(1)
  })
  it('rejects oversized complete cards and cross-audience publication without sending a truncated or leaked card', async () => {
    const t = pollRuntimeFixture()
    await expect(t.runtime.create(t.ref, { question: '完整'.repeat(20_000), choices: ['A', 'B'] })).rejects.toThrow(expect.objectContaining({ code: 'too_large' }))
    await expect(t.runtime.create(t.ref, { question: 'many options', choices: Array.from({ length: 100 }, (_, i) => String(i)) })).rejects.toThrow(expect.objectContaining({ code: 'too_large' }))
    expect(t.polls.list()).toEqual([]); expect(t.send).not.toHaveBeenCalled()
    t.state.audienceChat = 'other-group'; await expect(t.open()).rejects.toThrow(); expect(t.send).not.toHaveBeenCalled()
  })
})
