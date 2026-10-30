import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { Todos } from '../src/core/todos.js'
import { TodoApplication } from '../src/core/todo-application.js'
import { spaceScope } from '../src/core/space.js'
import { presentTodoOrigin } from '../src/core/todo-origin-presentation.js'
import { parseTodoProvenance, serializeTodoProvenance, todoOrigin, type TodoProvenance } from '../src/core/todo-provenance.js'
import { MINUTES_DRAFT_TTL_MS, MinutesDraftAccessError, MinutesDraftError, MinutesDrafts, NOTHING_TICKED } from '../src/core/minutes-drafts.js'
import { MinutesTodoApplication, minutesDecidedCard, minutesDraftCard, type MinutesTodoBinding } from '../src/core/minutes-todos.js'
import type { MinuteArtifacts, MinuteBrief } from '../src/feishu/minutes.js'
import { renderTodoCard } from '../src/feishu/cards.js'
import { FakeFeishu, asFeishuClient, type SentRecord } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

const MINUTE_URL = 'https://synthetic.feishu.cn/minutes/minute_a'
const CREATED = Date.parse('2026-09-24T02:00:00Z')

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-minutes-todos-')), registry = new Registry(join(home, 'db'))
  cleanups.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  const sp = spaceDeps(registry.db), dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'dm-alice', openId: 'alice' })
  const clock = { now: Date.parse('2026-09-25T00:00:00Z') }
  const drafts = new MinutesDrafts(registry.db, () => clock.now), todos = new Todos(registry.db)
  const todoApplication = new TodoApplication({ db: registry.db, todos })
  const fake = new FakeFeishu()
  const state = { current: true, access: 'allowed' as 'allowed' | 'denied' | 'unavailable', accessCalls: 0, requestMessageId: 'om_request_1' }
  const binding = (): MinutesTodoBinding => ({ sessionKey: 'dm:alice', runId: 'run-a', taskId: 7, workKey: 'task:7', requestMessageId: state.requestMessageId,
    openId: 'alice', spaceId: dm.id, chatId: dm.chatId!, assertCurrent: () => { if (!state.current) throw new Error('run stopped') } })
  const provenance = (): TodoProvenance => ({ version: 1, originRunId: 'run-a', taskId: 7, workKey: 'task:7',
    request: { messageId: state.requestMessageId, chatId: dm.chatId!, chatType: 'p2p', senderOpenId: 'alice', msgType: 'text', createTimeMs: 1000, link: { status: 'unavailable' } },
    selectedInputs: [], contextSnapshot: { version: 1, acpSessionId: 'acp-a', spaceId: dm.id, chatId: dm.chatId!, memoryScopes: [], chats: [], repositories: [],
      external: [{ kind: 'minutes', ref: 'minutes:v1:synthetic', personalOpenId: 'alice', access: 'user' }] } })
  const app = new MinutesTodoApplication({ drafts, db: registry.db, todoApplication, todos, ...sp, feishu: asFeishuClient(fake), now: () => clock.now,
    binding: ref => { if (ref.runId !== 'run-a' || ref.sessionKey !== 'dm:alice') throw new Error('wrong run'); return binding() },
    captureProvenance: async () => provenance(),
    resolveDelivery: async (_ref, guard) => { guard(); return { actorOpenId: 'alice', audience: { kind: 'dm', spaceId: dm.id, openId: 'alice' },
      sources: [{ ref: 'minutes-synthetic-read', spaceId: dm.id, chatId: dm.chatId! }], provenanceComplete: true, expiresAt: Date.now() + 60_000,
      isCurrent: () => { guard(); return true } } },
    authorizeMinute: async (_draft, guard) => {
      state.accessCalls++; guard()
      return state.access === 'allowed' ? { status: 'allowed', assertCurrent: guard } : { status: state.access, reason: 'synthetic_minutes_access', assertCurrent: guard }
    } })
  const minute: MinuteBrief = { token: 'minute_a', title: '周会纪要', url: MINUTE_URL, createdAtMs: CREATED }
  const artifacts: MinuteArtifacts = { token: 'minute_a', summary: 'PRIVATE_SUMMARY', chapters: [], keywords: [], coverage: { summary: 'present', todos: 'present' },
    todos: [{ content: '整理发布清单', assignees: ['alice'], isDone: false }, { content: '跟进接口变更', assignees: ['ou_bob'], isDone: false },
      { content: '补充验收用例', isDone: false }, { content: '已完成的旧事项', assignees: ['alice'], isDone: true }] }
  const ref = { sessionKey: 'dm:alice', runId: 'run-a' }
  const propose = (items: number[], input: { minute?: MinuteBrief; artifacts?: MinuteArtifacts } = {}) =>
    app.propose(ref, { minute: input.minute ?? minute, artifacts: input.artifacts ?? artifacts, items }, () => {})
  const cards = () => fake.sent.filter(item => JSON.stringify(item.payload).includes('minutes_draft_decide'))
  const texts = () => fake.sent.filter(item => 'text' in (item.payload as object)).map(item => (item.payload as { text: string }).text).join('\n')
  const buttons = (card: SentRecord) => JSON.stringify(card.payload)
  const decide = (draftId: string, decision: 'accept' | 'ignore', patch: Partial<{ operatorOpenId: string; chatId: string; messageId: string; digest: string }> = {}) => {
    const draft = drafts.get(draftId)!
    return app.decide({ draftId, digest: draft.digest, decision, operatorOpenId: 'alice', chatId: dm.chatId!, messageId: draft.reviewMessageId ?? 'missing', ...patch }, () => {})
  }
  /** The owner's checker clicks on the delivered card, one position at a time. */
  const tick = (draftId: string, positions: number[], checked = true, patch: Partial<{ operatorOpenId: string; chatId: string; messageId: string; digest: string }> = {}) => {
    for (const position of positions) {
      const draft = drafts.get(draftId)!
      app.select({ draftId, digest: draft.digest, position, checked, operatorOpenId: 'alice', chatId: dm.chatId!, messageId: draft.reviewMessageId ?? 'missing', ...patch }, () => {})
    }
    return drafts.get(draftId)!
  }
  const checkers = (card: SentRecord) => ((card.payload as { card: { body: { elements: Record<string, unknown>[] } } }).card.body.elements)
    .filter(element => element.tag === 'checker')
  const all = () => todos.list(spaceScope(dm.id), { status: 'all' }).sort((a, b) => a.id - b.id)
  const row = (id: string) => registry.db.prepare('SELECT * FROM minutes_drafts WHERE id=?').get(id) as Record<string, unknown>
  return { registry, sp, dm, clock, drafts, todos, todoApplication, fake, state, app, minute, artifacts, ref, propose, cards, texts, buttons, decide, tick, checkers, all, row }
}

describe('minutes action items become Todos only after the owner accepts the host-read draft', () => {
  it('shows short items whole on one tick-box card, pre-ticking only the ones the minute gives the owner, and writes no Todo', async () => {
    const t = fixture()
    const result = await t.propose([0, 1, 2])
    expect(result).toMatchObject({ state: 'pending', reviewDelivered: true, items: 3 })
    const draft = t.drafts.get(result.draftId)!
    expect(draft).toMatchObject({ state: 'pending', expiresAt: t.clock.now + MINUTES_DRAFT_TTL_MS, minuteToken: 'minute_a' })
    expect(MINUTES_DRAFT_TTL_MS).toBe(72 * 3600_000)
    // Short items need no separate text message: the card carries them whole.
    expect(t.texts()).toBe('')
    const cards = t.cards()
    expect(cards).toHaveLength(1)
    expect(t.fake.sent).toHaveLength(1)
    const card = t.buttons(cards[0]!)
    expect(card).toContain('哪些算你的？'); expect(card).toContain('妙记「周会纪要」 · 9月24日'); expect(card).toContain(MINUTE_URL)
    expect(t.checkers(cards[0]!).map(checker => [(checker.text as { content: string }).content, checker.checked])).toEqual([
      ['整理发布清单（标注：你）', true], ['跟进接口变更（标注：其他人）', false], ['补充验收用例（未标注负责人）', false]])
    expect(card).toContain('记录勾选的 1 项'); expect(card).toContain('都不是我的')
    // Only the selected items; no summary, no provider IDs.
    expect(card).not.toContain('已完成的旧事项'); expect(card).not.toContain('PRIVATE_SUMMARY'); expect(card).not.toContain('ou_bob')
    expect(t.fake.sent.every(item => item.kind === 'sendToUser' && item.target === 'alice')).toBe(true)
    expect(t.buttons(cards[0]!)).toContain(`"draftId":"${draft.id}"`); expect(t.buttons(cards[0]!)).toContain(`"digest":"${draft.digest}"`)
    expect(draft.reviewMessageId).toBe(cards[0]!.messageId)
    expect(t.all()).toEqual([])
    // The same request with the same content is the same draft and is not sent again.
    const again = await t.propose([0, 1, 2])
    expect(again).toMatchObject({ draftId: draft.id, state: 'pending', reviewDelivered: true })
    expect(t.cards()).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM minutes_drafts').get()?.n).toBe(1)
  })

  it('sends a long item in full before the card and points the card at it', async () => {
    const t = fixture()
    const long = `长${'很'.repeat(250)}的事项`
    const result = await t.propose([0], { artifacts: { ...t.artifacts, todos: [{ content: long, assignees: ['alice'], isDone: false }] } })
    expect(result).toMatchObject({ reviewDelivered: true })
    const text = t.texts()
    for (const value of ['妙记：周会纪要', `链接：${MINUTE_URL}`, '2026-09-24 10:00（北京时间', long, '负责人（妙记标注）：你本人']) expect(text).toContain(value)
    expect(t.fake.sent.at(-1)).toBe(t.cards()[0])
    expect(t.buttons(t.cards()[0]!)).toContain('（见上方第 1 项）')
    expect(t.buttons(t.cards()[0]!)).toContain('完整原文在上面')
  })

  it('on acceptance writes every ticked item through TodoApplication in one transaction, each citing the minute as a minutes origin', async () => {
    const t = fixture()
    const { draftId } = await t.propose([0, 1, 2])
    expect(t.tick(draftId, [1, 2]).items.map(item => item.selected)).toEqual([true, true, true])
    const decided = await t.decide(draftId, 'accept')
    expect(decided).toMatchObject({ state: 'accepted', todoIds: [expect.any(Number), expect.any(Number), expect.any(Number)] })
    expect(t.state.accessCalls).toBe(1)
    const items = t.all()
    // A tick is the owner's own claim, even where the minute named someone else; that note stays in the source.
    expect(items.map(item => [item.title, item.confirmed])).toEqual([['整理发布清单', true], ['跟进接口变更', true], ['补充验收用例', true]])
    expect(items[1]!.source).toContain('妙记标注为其他人负责')
    expect(items.map(item => item.id)).toEqual(decided.todoIds)
    expect(items.every(item => item.source?.includes('本人勾选的妙记行动项') && item.source.includes('周会纪要'))).toBe(true)
    expect(items.every(item => item.createdBy === 'alice' && item.sessionKey === 'dm:alice')).toBe(true)
    const provenance = items.map(item => t.todos.getProvenance(item.id)!)
    expect(provenance.map(value => value.minutes)).toEqual([0, 1, 2].map(index => ({ token: 'minute_a', title: '周会纪要', createdAtMs: CREATED,
      link: { status: 'available', url: MINUTE_URL }, item: index, contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/), draftId })))
    // The original private request stays the request; the minute is its own origin kind.
    expect(provenance[0]!.request?.messageId).toBe('om_request_1')
    expect(items[0]!.origin?.minutes).toEqual({ kind: 'minutes', label: '妙记：周会纪要（2026-09-24）', suppliedAt: CREATED, link: { status: 'available', url: MINUTE_URL } })
    expect(presentTodoOrigin(items[0]!.origin)!.items).toEqual([{ label: '原请求' }, { label: '妙记：周会纪要（2026-09-24）', url: MINUTE_URL }])
    expect(JSON.stringify(renderTodoCard({ items: [{ id: items[0]!.id, title: items[0]!.title, done: false, origin: items[0]!.origin }] }))).toContain(`[妙记：周会纪要（2026-09-24）](${MINUTE_URL})`)
    // A repeated click returns the same decision and writes nothing more.
    expect(await t.decide(draftId, 'accept')).toMatchObject({ state: 'accepted', todoIds: decided.todoIds })
    expect(await t.decide(draftId, 'ignore')).toMatchObject({ state: 'accepted' })
    expect(t.all()).toHaveLength(3)
    // Only the decision record remains in the draft store; the text lives in the accepted Todos.
    const stored = JSON.stringify(t.row(draftId))
    for (const value of ['整理发布清单', '周会纪要', MINUTE_URL]) expect(stored).not.toContain(value)
  })

  it('ignoring discards the draft content and never writes a Todo, even if accept is clicked later', async () => {
    const t = fixture()
    const { draftId } = await t.propose([0, 2])
    expect(await t.decide(draftId, 'ignore')).toMatchObject({ state: 'ignored', todoIds: [] })
    expect(t.state.accessCalls).toBe(0)
    expect(await t.decide(draftId, 'accept')).toMatchObject({ state: 'ignored', todoIds: [] })
    expect(t.all()).toEqual([])
    const stored = JSON.stringify(t.row(draftId))
    for (const value of ['整理发布清单', '补充验收用例', '周会纪要', MINUTE_URL, 'contextSnapshot']) expect(stored).not.toContain(value)
    expect(t.row(draftId)).toMatchObject({ state: 'ignored', owner_open_id: 'alice', minute_token: 'minute_a' })
  })

  it('expires a draft after 72 hours: the sweep and a late click write nothing and discard the content', async () => {
    const t = fixture()
    const first = await t.propose([0])
    t.clock.now += MINUTES_DRAFT_TTL_MS - 1
    expect(t.app.expire()).toBe(0)
    t.clock.now += 1
    expect(t.app.expire()).toBe(1)
    expect(t.drafts.get(first.draftId)).toMatchObject({ state: 'expired', todoIds: [] })
    expect(await t.decide(first.draftId, 'accept')).toMatchObject({ state: 'expired' })
    expect(JSON.stringify(t.row(first.draftId))).not.toContain('整理发布清单')
    // Without a sweep, the click itself observes the expiry.
    t.state.requestMessageId = 'om_request_2'
    const second = await t.propose([2])
    t.clock.now += MINUTES_DRAFT_TTL_MS
    expect(await t.decide(second.draftId, 'accept')).toMatchObject({ state: 'expired', todoIds: [] })
    expect(t.state.accessCalls).toBe(0)
    expect(t.all()).toEqual([])
    // A new request for the same expired draft content reports the expiry instead of resending.
    const retried = await t.propose([2])
    expect(retried).toMatchObject({ draftId: second.draftId, state: 'expired', reviewDelivered: false })
  })

  it('accepts only the owner clicking the delivered card in their own private chat', async () => {
    const t = fixture()
    const { draftId } = await t.propose([0, 1])
    const draft = t.drafts.get(draftId)!
    for (const patch of [{ operatorOpenId: 'bob' }, { chatId: 'oc_synthetic_group' }, { messageId: 'om_forwarded_copy' }, { digest: 'f'.repeat(64) }]) {
      await expect(t.decide(draftId, 'accept', patch), JSON.stringify(patch)).rejects.toMatchObject({ code: 'denied' })
      await expect(t.decide(draftId, 'ignore', patch), JSON.stringify(patch)).rejects.toBeInstanceOf(MinutesDraftError)
    }
    expect(t.state.accessCalls).toBe(0)
    expect(t.drafts.get(draftId)).toMatchObject({ state: 'pending', digest: draft.digest })
    expect(t.all()).toEqual([])
    t.tick(draftId, [1])
    expect(await t.decide(draftId, 'accept')).toMatchObject({ state: 'accepted' })
    expect(t.all()).toHaveLength(2)
  })

  it('keeps ticks only from the owner on the delivered card and refuses to record with nothing ticked', async () => {
    const t = fixture()
    const { draftId } = await t.propose([0, 1])
    for (const patch of [{ operatorOpenId: 'bob' }, { chatId: 'oc_synthetic_group' }, { messageId: 'om_forwarded_copy' }, { digest: 'f'.repeat(64) }]) {
      expect(() => t.tick(draftId, [1], true, patch), JSON.stringify(patch)).toThrow(MinutesDraftError)
    }
    expect(t.drafts.get(draftId)!.items.map(item => item.selected)).toEqual([true, false])
    expect(t.tick(draftId, [0], false).items.map(item => item.selected)).toEqual([false, false])
    await expect(t.decide(draftId, 'accept')).rejects.toMatchObject({ code: 'invalid', message: NOTHING_TICKED })
    expect(t.state.accessCalls).toBe(0)
    expect(t.all()).toEqual([])
    expect(JSON.stringify(minutesDraftCard(t.tick(draftId, [1])))).toContain('记录勾选的 1 项')
    const decided = await t.decide(draftId, 'accept')
    expect(t.all().map(item => item.title)).toEqual(['跟进接口变更'])
    expect(JSON.stringify(minutesDecidedCard(decided))).toContain('没勾的 1 项没有记')
    // A tick after the decision changes nothing.
    expect(t.tick(draftId, [0]).state).toBe('accepted')
    expect(t.all()).toHaveLength(1)
  })

  it('offers candidates from the AI summary only on a verbatim quote, unticked, and records a ticked one with the quote as its basis', async () => {
    const t = fixture()
    const artifacts: MinuteArtifacts = { ...t.artifacts, summary: '会上确认：周五前由产品组完成发布清单。另外需要补一轮兼容性测试。',
      coverage: { summary: 'present', todos: 'absent' }, todos: [] }
    const propose = (input: { items?: number[]; candidates?: { text: string; quote: string }[] }) => t.app.propose(t.ref, { minute: t.minute, artifacts, ...input }, () => {})
    expect(await propose({ candidates: [{ text: '补兼容性测试', quote: '需要补两轮兼容性测试' }] }).then(() => undefined, (error: unknown) => error))
      .toMatchObject({ code: 'invalid', message: expect.stringContaining('原句') })
    expect(await propose({ items: [0] }).then(() => undefined, (error: unknown) => error)).toMatchObject({ code: 'invalid', message: expect.stringContaining('candidates') })
    expect(t.fake.sent).toEqual([])
    const result = await propose({ candidates: [{ text: '补一轮兼容性测试', quote: '「另外需要补一轮兼容性测试。」' }] })
    const card = t.buttons(t.cards()[0]!)
    expect(card).toContain('补一轮兼容性测试（从总结里找到）'); expect(card).toContain('依据：「另外需要补一轮兼容性测试」')
    expect(t.checkers(t.cards()[0]!).map(checker => checker.checked)).toEqual([false])
    await expect(t.decide(result.draftId, 'accept')).rejects.toMatchObject({ code: 'invalid' })
    t.tick(result.draftId, [0])
    await t.decide(result.draftId, 'accept')
    const [todo] = t.all()
    expect(todo).toMatchObject({ title: '补一轮兼容性测试', detail: '依据（妙记 AI 总结原句）：「另外需要补一轮兼容性测试」', confirmed: true })
    expect(todo!.source).toContain('本人勾选的妙记总结事项')
    expect(t.todos.getProvenance(todo!.id)!.minutes).toMatchObject({ item: 0, basis: 'summary', token: 'minute_a' })
    const stored = JSON.stringify(t.row(result.draftId))
    expect(stored).not.toContain('兼容性测试')
  })

  it('writes nothing and keeps the draft pending when the owner can no longer read the minute or record Todos', async () => {
    const t = fixture()
    const { draftId } = await t.propose([0, 1])
    t.state.access = 'denied'
    await expect(t.decide(draftId, 'accept')).rejects.toBeInstanceOf(MinutesDraftAccessError)
    t.state.access = 'unavailable'
    await expect(t.decide(draftId, 'accept')).rejects.toMatchObject({ status: 'unavailable' })
    expect(t.drafts.get(draftId)?.state).toBe('pending')
    expect(t.all()).toEqual([])
    t.state.access = 'allowed'
    const decide = t.sp.policy.decide.bind(t.sp.policy)
    vi.spyOn(t.sp.policy, 'decide').mockImplementation(input => input.action === 'remember' ? { decision: 'deny', actor: 'owner', reason: 'synthetic policy' } : decide(input))
    await expect(t.decide(draftId, 'accept')).rejects.toMatchObject({ code: 'denied' })
    expect(t.drafts.get(draftId)?.state).toBe('pending')
    expect(t.all()).toEqual([])
  })

  it('rolls back every Todo of the draft when one item cannot be written', async () => {
    const t = fixture()
    const { draftId } = await t.propose([0, 1, 2])
    t.tick(draftId, [1, 2])
    const create = t.todoApplication.create.bind(t.todoApplication)
    let calls = 0
    vi.spyOn(t.todoApplication, 'create').mockImplementation((...args) => { if (++calls === 2) throw new Error('synthetic write failure'); return create(...args) })
    await expect(t.decide(draftId, 'accept')).rejects.toThrow('synthetic write failure')
    expect(t.all()).toEqual([])
    expect(t.drafts.get(draftId)?.state).toBe('pending')
  })

  it('does not record an item again that an earlier accepted draft of the same minute still holds', async () => {
    const t = fixture()
    const first = await t.propose([0, 1])
    t.tick(first.draftId, [1])
    await t.decide(first.draftId, 'accept')
    t.state.requestMessageId = 'om_request_2'
    const second = await t.propose([1, 2])
    expect(second.draftId).not.toBe(first.draftId)
    t.tick(second.draftId, [0, 1])
    const decided = await t.decide(second.draftId, 'accept')
    expect(decided.todoIds).toHaveLength(1)
    expect(decided.items?.map(item => item.duplicate === true)).toEqual([true, false])
    expect(t.all().map(item => item.title)).toEqual(['整理发布清单', '跟进接口变更', '补充验收用例'])
    // A cancelled earlier Todo is not a reason to skip.
    const cancelled = t.all().find(item => item.title === '整理发布清单')!
    t.todos.transition(cancelled.id, cancelled.scope, 'cancelled', { by: 'alice' })
    t.state.requestMessageId = 'om_request_3'
    const third = await t.propose([0])
    expect((await t.decide(third.draftId, 'accept')).todoIds).toHaveLength(1)
    expect(t.all().filter(item => item.title === '整理发布清单')).toHaveLength(2)
  })

  it('rejects a selection the minute cannot support before sending or storing anything', async () => {
    const t = fixture()
    const refused = async (items: number[], input: { minute?: MinuteBrief; artifacts?: MinuteArtifacts } = {}) => {
      const error = await t.propose(items, input).then(() => undefined, (value: unknown) => value)
      expect(error, JSON.stringify(items)).toMatchObject({ code: 'invalid' })
      return (error as Error).message
    }
    expect(await refused([4])).toContain('第 5 项')
    expect(await refused([3])).toContain('已标记完成')
    expect(await refused([0, 0])).toContain('重复')
    await refused([0], { artifacts: { ...t.artifacts, coverage: { summary: 'present', todos: 'absent' } } })
    await refused([0], { artifacts: { ...t.artifacts, todos: [{ content: '   ' }] } })
    await refused([0], { artifacts: { ...t.artifacts, todos: [{ content: '长'.repeat(2001) }] } })
    await refused([0], { minute: { ...t.minute, token: 'minute_b' } })
    expect(t.fake.sent).toEqual([])
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM minutes_drafts').get()?.n).toBe(0)
  })

  it('does not issue the confirmation card when the full text was not delivered, so the draft cannot be accepted', async () => {
    const t = fixture()
    vi.spyOn(t.fake, 'sendToUser').mockRejectedValueOnce(new Error('synthetic transport failure'))
    await expect(t.propose([0])).rejects.toThrow()
    expect(t.cards()).toEqual([])
    const [draft] = t.registry.db.prepare('SELECT id FROM minutes_drafts').all() as { id: string }[]
    expect(t.drafts.get(draft!.id)).toMatchObject({ state: 'pending' })
    expect(t.drafts.get(draft!.id)?.reviewMessageId).toBeUndefined()
    await expect(t.decide(draft!.id, 'accept', { messageId: 'om_guess' })).rejects.toMatchObject({ code: 'denied' })
    expect(t.all()).toEqual([])
  })

  it('stops before recording a draft when the proposing run is no longer current', async () => {
    const t = fixture()
    t.state.current = false
    await expect(t.propose([0])).rejects.toThrow('run stopped')
    expect(t.fake.sent).toEqual([])
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM minutes_drafts').get()?.n).toBe(0)
  })
})

describe('minutes as a Todo origin kind', () => {
  const base = (): TodoProvenance => ({ version: 1, originRunId: 'run-a', taskId: null, workKey: 'task:1', request: null, selectedInputs: [],
    contextSnapshot: { version: 1, acpSessionId: 'acp-a', spaceId: 'sp_dm_alice', chatId: 'dm-alice', memoryScopes: [], chats: [], external: [], repositories: [] } })
  const minutes = { token: 'minute_a', title: '周会纪要', createdAtMs: CREATED, link: { status: 'available' as const, url: MINUTE_URL }, item: 0, contentDigest: 'a'.repeat(64), draftId: 'draft-a' }

  it('round-trips a minutes citation and rejects malformed or non-HTTPS ones', () => {
    const value = { ...base(), minutes }
    expect(parseTodoProvenance(serializeTodoProvenance(value))).toEqual(value)
    for (const bad of [{ token: '../minute' }, { link: { status: 'available', url: 'http://synthetic.feishu.cn/minutes/a' } }, { item: -1 },
      { contentDigest: 'not-a-digest' }, { draftId: '' }, { createdAtMs: -5 }]) {
      expect(() => serializeTodoProvenance({ ...base(), minutes: { ...minutes, ...bad } as typeof minutes }), JSON.stringify(bad)).toThrow('待办来源记录不完整或不匹配')
    }
    // Legacy provenance keeps its exact projection: no empty minutes entry appears.
    expect(todoOrigin(base())).toEqual({ request: null, selectedInputs: [], attachments: [] })
  })

  it('presents the minute without a guessed link when none was available, and without a date when the time is unknown', () => {
    const origin = todoOrigin({ ...base(), minutes: { ...minutes, title: undefined, createdAtMs: undefined, link: { status: 'unavailable' } } })!
    expect(origin.minutes).toEqual({ kind: 'minutes', label: '妙记', link: { status: 'unavailable' } })
    expect(presentTodoOrigin(origin)).toEqual({ items: [{ label: '妙记' }], notice: '来源链接暂不可用。' })
  })
})
