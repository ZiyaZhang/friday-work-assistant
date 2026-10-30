import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MemoryRuntime } from '../src/core/memory-runtime.js'
import { MemoryCardAccessError, MemoryConfirmation, preferenceText, type MemoryHumanEnvelope } from '../src/core/memory-confirmation.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { spaceScope } from '../src/core/space.js'
import { FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'
import { deferred } from './helpers/model-agent.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
function fixture(group = false) {
  let now = 100_000, serial = 0
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), attempts = new RunAttempts(registry.db)
  cleanup.push(() => registry.close())
  const { spaces, policy } = spaceDeps(registry.db)
  const space = spaces.ensure({ kind: group ? 'group' : 'p2p', chatId: 'chat', openId: 'alice' })
  const feishu = new FakeFeishu(); feishu.members.set('chat', new Set(['alice', 'bob', 'carol']))
  const abort = vi.fn(), runtime = new MemoryRuntime({ registry, memory, attempts, now: () => now,
    activeRun: runId => ({ runId, abort }) })
  const deps = { db: registry.db, memory, runtime, spaces, policy, feishu, now: () => now }
  const app = new MemoryConfirmation(deps)
  const envelope = (text = '确认这条', parentId?: string): MemoryHumanEnvelope => {
    const messageId = `human-${++serial}`
    return { spaceId: space.id, message: { eventId: messageId, messageId, chatId: 'chat', chatType: group ? 'group' : 'p2p',
      senderOpenId: 'alice', senderType: 'user', msgType: 'text', text, mentions: [], createTimeMs: now, parentId,
      ...(group ? { threadId: 'thread', rootId: 'root' } : {}) } }
  }
  const note = (body = '完整偏好：不要自动隐藏，完成后仍在这里显示。', replaces?: number) => memory.add({
    scope: spaceScope(space.id), kind: 'rule', title: '完整标题', body, source: { chatId: 'chat' }, ...(replaces ? { replaces } : {}) })
  const run = (refs: { id: number; revision: number }[]) => {
    const key = `session-${++serial}`
    registry.createSession({ sessionKey: key, chatId: 'chat', chatType: group ? 'group' : 'p2p', requesterOpenId: 'alice', cwd: '/synthetic' })
    const task = registry.createTask({ sessionKey: key, messageId: `task-${serial}`, prompt: 'synthetic', requesterOpenId: 'alice' })
    const attempt = attempts.begin({ workKey: `task:${task.id}`, triggerKey: `task:${task.id}`, sessionKey: key, taskId: task.id,
      stage: 'task', actorOpenId: 'alice', now }, () => registry.startTask(task.id, now, key))!
    attempts.bindRuntime(attempt.id, `acp-${serial}`); runtime.contexts.bind(attempt.id, key, `acp-${serial}`); runtime.recordRead(attempt.id, refs)
    return attempt
  }
  /** The button value exactly as the platform would send it back from the displayed card. */
  const button = (sentIndex: number, action: 'memory_confirm' | 'memory_correct' | 'memory_forget') => {
    const sent = feishu.sent[sentIndex]!
    const card = (sent.kind === 'sendToChat' ? (sent.payload as { card: Record<string, unknown> }).card : sent.payload) as { elements: { actions?: { value: { action: string; targetRef: string } }[] }[] }
    const value = card.elements.find(item => item.actions)!.actions!.find(item => item.value.action === action)!.value
    return { targetRef: value.targetRef, messageId: sent.messageId }
  }
  return { registry, memory, attempts, spaces, policy, space, feishu, runtime, app, deps, abort, envelope, note, run, button,
    advance: (ms: number) => { now += ms } }
}

describe('host natural memory controls with real SQLite and delivery admission', () => {
  it('saves exact original preference directly with real actor/message and one receipt, including restart replay', async () => {
    const t = fixture(), env = t.envelope('帮我记住，以后请叫我轻舟，不要用全名。')
    const intent = { kind: 'memory_save_preference' as const, spans: [{ start: 0, end: env.message.text.length }], continueWork: false }
    const result = await t.app.saveExplicitPreference(env, intent)
    expect(t.memory.get(result.noteId)).toMatchObject({ status: 'confirmed', body: env.message.text,
      confirmation: { by: 'alice', messageId: env.message.messageId }, source: { messageId: env.message.messageId, generatedBy: 'human_preference' } })
    expect(t.feishu.sent).toHaveLength(1)
    expect(JSON.stringify(t.feishu.sent)).not.toContain('确认这条记忆')
    expect(t.registry.taskForMessage(env.message.messageId)).toBeUndefined()
    const restart = new MemoryConfirmation(t.deps)
    expect((await restart.saveExplicitPreference(env, intent)).replayed).toBe(true)
    expect(t.feishu.sent).toHaveLength(1)
    expect(t.memory.rules(spaceScope(t.space.id))).toHaveLength(1)
  })

  it('requires a full host ACKed display and confirms only its exact current version', async () => {
    const t = fixture(), note = t.note(), origin = t.envelope('记住这个')
    expect((await t.app.targetsFor(t.envelope()))).toEqual([])
    const display = await t.app.present(note.id, note.revision, origin)
    expect(display.status).toBe('sent')
    expect(JSON.stringify(t.feishu.sent[0]?.payload)).toContain(note.body)
    const confirm = t.envelope('就是这条，确认。', display.remoteId!)
    expect((await t.app.targetsFor(confirm))).toMatchObject([{ ref: display.key, body: note.body, replied: true }])
    const affected = t.run([note]), unaffected = t.run([t.note('其他记忆')])
    await t.app.confirm(display.key, confirm)
    expect(t.memory.get(note.id)).toMatchObject({ status: 'confirmed', revision: 2, confirmation: { by: 'alice', messageId: confirm.message.messageId } })
    expect(t.attempts.get(affected.id)?.state).toBe('stop_requested')
    expect(t.attempts.get(unaffected.id)?.state).toBe('running')
    expect(t.abort).toHaveBeenCalledOnce()
    expect(t.feishu.sent).toHaveLength(2)
    await t.app.confirm(display.key, confirm)
    expect(t.abort).toHaveBeenCalledOnce()
    expect(t.feishu.sent).toHaveLength(2)
  })

  it('does not pick the latest candidate, another actor, another thread or automatic QA', async () => {
    const t = fixture(true), a = t.note('候选 A'), b = t.note('候选 B')
    const da = await t.app.present(a.id, a.revision, t.envelope()), db = await t.app.present(b.id, b.revision, t.envelope())
    t.note('比展示更晚的 automatic QA')
    expect((await t.app.targetsFor(t.envelope())).map(x => x.noteId).sort()).toEqual([a.id, b.id])
    expect((await t.app.targetsFor(t.envelope('', da.remoteId!))).map(x => x.noteId)).toEqual([a.id])
    const other = t.envelope(); other.message.senderOpenId = 'bob'
    t.spaces.addMember(t.space.id, 'bob', 'member')
    expect((await t.app.targetsFor(other))).toEqual([])
    await expect(t.app.confirm(db.key, other)).rejects.toThrow()
    const thread = t.envelope(); thread.message.threadId = 'another-thread'
    expect((await t.app.targetsFor(thread))).toEqual([])
  })

  it('allows a current ordinary group member, with actual operator and exact display ID mandatory', async () => {
    const t = fixture(true), note = t.note()
    t.spaces.addMember(t.space.id, 'bob', 'member'); t.spaces.addMember(t.space.id, 'carol', 'member')
    const env = t.envelope(); env.message.senderOpenId = 'bob'
    const display = await t.app.present(note.id, note.revision, env)
    await expect(t.app.confirmCard({ targetRef: display.key, chatId: 'chat', messageId: display.remoteId! })).rejects.toThrow('身份')
    // Another ordinary member is not the person this card was presented to (the owner case is tested separately).
    await expect(t.app.confirmCard({ targetRef: display.key, operatorOpenId: 'carol', chatId: 'chat', messageId: display.remoteId! })).rejects.toThrow(MemoryCardAccessError)
    await expect(t.app.confirmCard({ targetRef: display.key, operatorOpenId: 'bob', chatId: 'chat', messageId: 'forged' })).rejects.toThrow()
    const input = { targetRef: display.key, operatorOpenId: 'bob', chatId: 'chat', messageId: display.remoteId! }
    await t.app.confirmCard(input); await t.app.confirmCard(input)
    expect(t.memory.get(note.id)?.confirmation?.by).toBe('bob')
    expect(t.feishu.sent).toHaveLength(2)
  })

  it('shows replacement old and new full bodies and refuses a changed replacement relation', async () => {
    const t = fixture(), old = t.note('旧正文全文')
    t.runtime.confirm(old.id, old.scope, { by: 'alice', messageId: 'old-proof' })
    const correction = t.note('新正文全文', old.id)
    const display = await t.app.present(correction.id, correction.revision, t.envelope())
    const payload = JSON.stringify(t.feishu.sent[0]?.payload)
    expect(payload).toContain('旧正文全文'); expect(payload).toContain('新正文全文'); expect(payload).toContain('确认后替换原来这条')
    t.runtime.remove(old.id, old.scope)
    await expect(t.app.confirm(display.key, t.envelope('', display.remoteId!))).rejects.toThrow()
    expect(t.memory.get(correction.id)?.status).toBe('candidate')
  })

  it('rechecks revision and live membership after awaited platform lookup', async () => {
    const t = fixture(true), note = t.note(), display = await t.app.present(note.id, note.revision, t.envelope())
    const gate = deferred(), entered = deferred()
    vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementation(async () => { entered.resolve(); await gate.promise; return new Set(['alice']) })
    const pending = t.app.confirm(display.key, t.envelope('', display.remoteId!))
    await entered.promise
    t.runtime.remove(note.id, note.scope)
    gate.resolve()
    await expect(pending).rejects.toThrow()
    expect(t.feishu.sent).toHaveLength(1)
  })

  it('cannot present after a captured worker lease ends; an already displayed candidate is independent of original execution', async () => {
    const t = fixture(), note = t.note(), env = t.envelope()
    await expect(t.app.present(note.id, 1, { ...env, isCurrent: () => false })).rejects.toThrow()
    const display = await t.app.present(note.id, 1, { ...env, isCurrent: () => true })
    await t.app.confirm(display.key, t.envelope('', display.remoteId!))
    expect(t.memory.get(note.id)?.status).toBe('confirmed')
  })

  it('rolls confirmation, ingress result, durable stops and invalidation back when Delivery reservation fails; zero abort', async () => {
    const t = fixture(), note = t.note(), display = await t.app.present(note.id, 1, t.envelope()), affected = t.run([note])
    const env = t.envelope('', display.remoteId!)
    t.registry.db.exec(`CREATE TRIGGER reject_memory_receipt BEFORE INSERT ON deliveries WHEN NEW.delivery_key LIKE 'memory-result:%'
      BEGIN SELECT RAISE(ABORT, 'synthetic reservation failed'); END`)
    await expect(t.app.confirm(display.key, env)).rejects.toThrow('synthetic reservation failed')
    expect(t.memory.get(note.id)).toMatchObject({ status: 'candidate', revision: 1 })
    expect(t.attempts.get(affected.id)?.state).toBe('running')
    expect(t.runtime.contexts.isEligible(affected.id, true)).toBe(true)
    expect(t.abort).not.toHaveBeenCalled()
    expect(t.registry.db.prepare('SELECT * FROM ingress_routes WHERE message_id = ?').get(env.message.messageId)).toBeUndefined()
  })

  it('unknown display is not confirmable and unknown committed fact is never resent after restart', async () => {
    const t = fixture(), note = t.note()
    const send = vi.spyOn(t.feishu, 'sendToChat').mockRejectedValue(new Error('synthetic lost ACK'))
    expect((await t.app.present(note.id, 1, t.envelope())).status).toBe('unknown')
    expect((await t.app.targetsFor(t.envelope()))).toEqual([])
    const env = t.envelope('帮我记住，以后请用中文。'), intent = { kind: 'memory_save_preference' as const,
      spans: [{ start: 0, end: env.message.text.length }], continueWork: false }
    const fact = await t.app.saveExplicitPreference(env, intent)
    expect(fact.delivery.status).toBe('unknown')
    expect(t.memory.get(fact.noteId)?.status).toBe('confirmed')
    await new MemoryConfirmation(t.deps).saveExplicitPreference(env, intent)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not expose cross-space, promoted or source-unavailable notes through presentation', async () => {
    const t = fixture(), foreign = t.memory.add({ scope: 'org', kind: 'rule', title: 'private', body: 'OTHER_BODY' })
    await expect(t.app.present(foreign.id, 1, t.envelope())).rejects.toThrow()
    const local = t.memory.add({ scope: spaceScope(t.space.id), kind: 'rule', title: 'source', body: 'OTHER_BODY', source: { chatId: 'elsewhere' } })
    await expect(t.app.present(local.id, 1, t.envelope())).rejects.toThrow()
    expect(t.feishu.sent).toHaveLength(0)
  })

  it('expires unanchored recent targets without losing an exact reply anchor', async () => {
    const t = fixture(), note = t.note(), display = await t.app.present(note.id, 1, t.envelope())
    t.advance(31 * 60_000)
    expect((await t.app.targetsFor(t.envelope()))).toEqual([])
    expect((await t.app.targetsFor(t.envelope('', display.remoteId!)))).toHaveLength(1)
  })
})

describe('card buttons: 确认 / 更正 / 忘记 on the displayed candidate', () => {
  it('rejects a click by someone the card was not presented to, in a DM and by a plain group member; nothing changes', async () => {
    const dm = fixture(), note = dm.note(), display = await dm.app.present(note.id, note.revision, dm.envelope())
    const stranger = { targetRef: display.key, operatorOpenId: 'bob', chatId: 'chat', messageId: display.remoteId! }
    await expect(dm.app.confirmCard(stranger)).rejects.toThrow(MemoryCardAccessError)
    await expect(dm.app.forgetCard(stranger)).rejects.toThrow(MemoryCardAccessError)
    await expect(dm.app.correctCard(stranger)).rejects.toThrow('本人')
    expect(dm.memory.get(note.id)).toMatchObject({ status: 'candidate', revision: 1 })
    expect(dm.feishu.sent).toHaveLength(1)

    const group = fixture(true), shared = group.note('群里的候选')
    group.spaces.addMember(group.space.id, 'bob', 'member'); group.spaces.addMember(group.space.id, 'carol', 'member')
    const env = group.envelope(); env.message.senderOpenId = 'bob'
    const card = await group.app.present(shared.id, shared.revision, env)
    const member = { targetRef: card.key, operatorOpenId: 'carol', chatId: 'chat', messageId: card.remoteId! }
    await expect(group.app.confirmCard(member)).rejects.toThrow(MemoryCardAccessError)
    await expect(group.app.forgetCard(member)).rejects.toThrow(MemoryCardAccessError)
    await expect(group.app.correctCard(member)).rejects.toThrow(MemoryCardAccessError)
    expect(group.memory.get(shared.id)).toMatchObject({ status: 'candidate', revision: 1 })
    expect(group.feishu.sent).toHaveLength(1)
    expect(group.registry.db.prepare('SELECT COUNT(*) n FROM ingress_routes').get()).toEqual({ n: 0 })
  })

  it('confirm button writes the confirmation once, sends one receipt, replaces the card, and a second click replays', async () => {
    const t = fixture(), note = t.note(), display = await t.app.present(note.id, note.revision, t.envelope()), reader = t.run([note])
    const click = { targetRef: display.key, operatorOpenId: 'alice', chatId: 'chat', messageId: display.remoteId! }
    const first = await t.app.confirmCard(click)
    expect(first).toMatchObject({ noteId: note.id, text: '已记住。', replayed: false })
    expect(JSON.stringify(first.card)).toContain('已记住')
    expect(JSON.stringify(first.card)).toContain(note.body)
    expect(JSON.stringify(first.card)).not.toContain('memory_confirm')
    expect(t.memory.get(note.id)).toMatchObject({ status: 'confirmed', revision: 2, confirmation: { by: 'alice' } })
    expect(t.feishu.sent).toHaveLength(2)
    expect(t.feishu.sent[1]).toMatchObject({ kind: 'sendToChat', payload: { text: '已记住。' } })
    expect(t.attempts.get(reader.id)?.state).toBe('stop_requested')
    expect(t.abort).toHaveBeenCalledOnce()
    const again = await t.app.confirmCard(click)
    expect(again).toMatchObject({ noteId: note.id, text: first.text, replayed: true })
    expect(again.card).toBeUndefined()
    expect(t.feishu.sent).toHaveLength(2)
    expect(t.abort).toHaveBeenCalledOnce()
    // The same person's later reply to that card no longer finds a candidate.
    expect(await t.app.targetsFor(t.envelope('确认', display.remoteId!))).toEqual([])
  })

  it('forget button removes the exact displayed candidate once, keeps the confirmed original, stops only the consuming run', async () => {
    const t = fixture(), old = t.note('旧正文全文')
    t.runtime.confirm(old.id, old.scope, { by: 'alice', messageId: 'old-proof' })
    const correction = t.note('新正文全文', old.id)
    const display = await t.app.present(correction.id, correction.revision, t.envelope())
    const reader = t.run([correction]), other = t.run([t.memory.get(old.id)!])
    const click = { targetRef: display.key, operatorOpenId: 'alice', chatId: 'chat', messageId: display.remoteId! }
    const first = await t.app.forgetCard(click)
    expect(first).toMatchObject({ noteId: correction.id, text: '没有记，原来那条保持不变。', replayed: false })
    expect(JSON.stringify(first.card)).toContain('已忘记')
    expect(t.memory.get(correction.id)).toBeUndefined()
    expect(t.memory.getTombstone(correction.id)).toMatchObject({ scope: old.scope })
    expect(t.memory.get(old.id)).toMatchObject({ status: 'confirmed', revision: 2 })
    expect(t.feishu.sent).toHaveLength(2)
    expect(t.feishu.sent[1]).toMatchObject({ payload: { text: first.text } })
    expect(t.attempts.get(reader.id)?.state).toBe('stop_requested')
    expect(t.attempts.get(other.id)?.state).toBe('running')
    expect(t.abort).toHaveBeenCalledOnce()
    const again = await t.app.forgetCard(click)
    expect(again).toMatchObject({ noteId: correction.id, replayed: true })
    expect(again.card).toBeUndefined()
    expect(t.feishu.sent).toHaveLength(2)
    // A plain candidate without a replacement relation reads as a plain forget.
    const plain = t.note('单独的候选'), plainCard = await t.app.present(plain.id, plain.revision, t.envelope())
    expect((await t.app.forgetCard({ ...click, targetRef: plainCard.key, messageId: plainCard.remoteId! })).text).toBe('已忘记。')
    expect(t.memory.get(plain.id)).toBeUndefined()
  })

  it('correct button sends one idempotent hint; the reply to that hint corrects through the existing replacement operation', async () => {
    const t = fixture(), note = t.note('叫我全名'), display = await t.app.present(note.id, note.revision, t.envelope())
    const click = { targetRef: display.key, operatorOpenId: 'alice', chatId: 'chat', messageId: display.remoteId! }
    const hint = await t.app.correctCard(click)
    expect(hint.replayed).toBe(false)
    expect(hint.text).toContain(`#${note.id}`)
    expect(t.feishu.sent).toHaveLength(2)
    expect(t.feishu.sent[1]).toMatchObject({ kind: 'sendToChat', payload: { text: hint.text } })
    expect((await t.app.correctCard(click)).replayed).toBe(true)
    expect(t.feishu.sent).toHaveLength(2)
    expect(t.memory.get(note.id)).toMatchObject({ status: 'candidate', revision: 1 })
    // The person replies to the hint (not to the card). That reply still resolves to the displayed version.
    const reply = t.envelope('以后请叫我轻舟，不要用全名。', hint.delivery.remoteId!)
    expect(t.app.isDisplayReply(reply.message)).toBe(true)
    const targets = await t.app.targetsFor(reply)
    expect(targets).toMatchObject([{ ref: display.key, noteId: note.id, replied: true }])
    const saved = await t.app.saveExplicitPreference(reply, { kind: 'memory_save_preference', spans: [{ start: 0, end: reply.message.text.length }],
      targetRef: display.key, continueWork: false })
    expect(t.memory.get(saved.noteId)).toMatchObject({ status: 'confirmed', body: reply.message.text, confirmation: { by: 'alice', messageId: reply.message.messageId },
      source: { replaces: note.id, generatedBy: 'human_preference' } })
    expect(t.memory.get(note.id)).toMatchObject({ status: 'superseded', supersededBy: saved.noteId })
    expect(t.feishu.sent).toHaveLength(3)
    expect(t.feishu.sent[2]).toMatchObject({ payload: { text: '已记住这条个人偏好。' } })
    expect(await t.app.targetsFor(t.envelope('', display.remoteId!))).toEqual([])
    // A stale correct click on the replaced card fails closed without a new hint.
    await expect(t.app.correctCard(click)).rejects.toThrow()
    expect(t.feishu.sent).toHaveLength(3)
  })

  it('lets the group space owner decide a member card, while the natural-language path stays with the presented person', async () => {
    const t = fixture(true), note = t.note('群候选')
    t.spaces.addMember(t.space.id, 'bob', 'member')
    expect(t.spaces.roleOf(t.space.id, 'alice')).toBe('owner')
    const env = t.envelope(); env.message.senderOpenId = 'bob'
    const display = await t.app.present(note.id, note.revision, env)
    // Replying to the card as the owner is not the same as the presented member replying.
    await expect(t.app.confirm(display.key, t.envelope('确认', display.remoteId!))).rejects.toThrow()
    expect(await t.app.targetsFor(t.envelope('确认', display.remoteId!))).toEqual([])
    const owner = { targetRef: display.key, operatorOpenId: 'alice', chatId: 'chat', messageId: display.remoteId! }
    const result = await t.app.confirmCard(owner)
    expect(result.replayed).toBe(false)
    expect(t.memory.get(note.id)).toMatchObject({ status: 'confirmed', confirmation: { by: 'alice' } })
    expect(t.feishu.sent).toHaveLength(2)
    expect(t.feishu.sent[1]).toMatchObject({ kind: 'replyText', target: display.remoteId, payload: '已记住。' })
    expect((await t.app.confirmCard(owner)).replayed).toBe(true)
    // The owner's forget on another member card also goes through the same ledger.
    const second = t.note('第二条群候选'), secondCard = await t.app.present(second.id, second.revision, env)
    await t.app.forgetCard({ ...owner, targetRef: secondCard.key, messageId: secondCard.remoteId! })
    expect(t.memory.get(second.id)).toBeUndefined()
    // In a DM the owner rule does not apply: only the person.
    const dm = fixture(), mine = dm.note(), myCard = await dm.app.present(mine.id, mine.revision, dm.envelope())
    await expect(dm.app.forgetCard({ targetRef: myCard.key, operatorOpenId: 'bob', chatId: 'chat', messageId: myCard.remoteId! })).rejects.toThrow(MemoryCardAccessError)
  })

  it('confirm after forget and forget after confirm both fail closed without a second receipt', async () => {
    const t = fixture(), a = t.note('先确认'), b = t.note('先忘记')
    const ca = await t.app.present(a.id, a.revision, t.envelope()), cb = await t.app.present(b.id, b.revision, t.envelope())
    const clickA = { targetRef: ca.key, operatorOpenId: 'alice', chatId: 'chat', messageId: ca.remoteId! }
    const clickB = { targetRef: cb.key, operatorOpenId: 'alice', chatId: 'chat', messageId: cb.remoteId! }
    await t.app.confirmCard(clickA)
    await expect(t.app.forgetCard(clickA)).rejects.toThrow()
    await expect(t.app.correctCard(clickA)).rejects.toThrow()
    expect(t.memory.get(a.id)?.status).toBe('confirmed')
    await t.app.forgetCard(clickB)
    await expect(t.app.confirmCard(clickB)).rejects.toThrow()
    expect(t.memory.get(b.id)).toBeUndefined()
    expect(t.feishu.sent).toHaveLength(4)
    expect(t.registry.db.prepare("SELECT COUNT(*) n FROM deliveries WHERE delivery_key LIKE 'memory-result:%'").get()).toEqual({ n: 2 })
  })
})

describe('literal preference span validation', () => {
  it('preserves qualifiers and negation and excludes other request spans without rewriting', () => {
    const text = '记住：日常回答别太长；解释代码时可以详细。另查天气。'
    expect(preferenceText(text, [{ start: 0, end: text.indexOf('另查') }])).toBe('记住：日常回答别太长；解释代码时可以详细。')
  })
  it.each([
    [], [{ start: -1, end: 3 }], [{ start: 1, end: 1 }], [{ start: 0, end: 99 }], [{ start: 0, end: 4 }, { start: 2, end: 5 }],
  ])('rejects invalid or overlapping intervals %j', spans => { expect(() => preferenceText('123456', spans)).toThrow() })
  it('does not split UTF-16 surrogate pairs or silently truncate long text', () => {
    expect(() => preferenceText('叫我😀', [{ start: 0, end: 3 }])).toThrow()
    expect(() => preferenceText('长'.repeat(1501), [{ start: 0, end: 1501 }])).toThrow()
  })
})
