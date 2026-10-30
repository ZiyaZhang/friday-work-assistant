import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Todos } from '../src/core/todos.js'
import { PersonalCollectionStore, type CollectionMessage } from '../src/core/personal-collection.js'
import { PersonalCollectionHost } from '../src/core/personal-collection-host.js'
import { Spaces } from '../src/core/space.js'
import { PolicyService } from '../src/core/policy.js'
import { ChatReadScope } from '../src/core/chat-read-scope.js'
import { FeishuApiError, type HistoryMessage } from '../src/feishu/client.js'

const databases: DatabaseSync[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()) })
const OWNER = 'ou_owner', NOW = Date.parse('2026-10-13T08:00:00Z')
const gone = () => new FeishuApiError('message.get', 12009, 'Your request involves a chat which has already been dissolved')
const asCollection = (message: HistoryMessage): CollectionMessage => ({
  metadata: { messageId: message.messageId, chatId: message.chatId!, chatType: 'group', senderOpenId: message.senderOpenId!,
    createTimeMs: message.createTimeMs, msgType: message.msgType, link: { status: 'unavailable' } },
  text: message.text, senderName: message.senderName, mentions: [OWNER],
})

function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const todos = new Todos(db), store = new PersonalCollectionStore(db, todos, () => NOW)
  const spaces = new Spaces(db, () => NOW), policy = new PolicyService(spaces, { admins: [] }), readScope = new ChatReadScope(db, () => NOW)
  spaces.ensure({ kind: 'p2p', openId: OWNER, chatId: 'oc_friday' })
  store.configure(OWNER, true)
  const state = { grant: true }, onResult = vi.fn()
  const message = (id = 'om_readable'): HistoryMessage => ({ messageId: id, chatId: id === 'om_dissolved' ? 'oc_dissolved' : 'oc_source', senderOpenId: 'ou_requester',
    senderName: 'Requester', senderType: 'user', createTimeMs: NOW - 1000, msgType: 'text', text: '请确认发布文案', mentions: [{ openId: OWNER, name: 'Owner' }] })
  const getMessage = vi.fn(async (id: string): Promise<HistoryMessage | undefined> => {
    if (id === 'om_dissolved') throw gone()
    return message(id)
  })
  const hit = (id: string) => ({ messageId: id, chatId: id === 'om_dissolved' ? 'oc_dissolved' : 'oc_source', isP2p: false })
  const findMessagesAsUserPage = vi.fn(async (): Promise<{ items: ReturnType<typeof hit>[]; hasMore: boolean; nextPageToken?: string }> => ({
    items: [hit('om_dissolved'), hit('om_readable')], hasMore: false,
  }))
  const run = vi.fn(async (_prompt: string) => JSON.stringify({ decisions: [{ messageId: 'om_readable', quote: '请确认发布文案', existingId: null,
    kind: 'todo', relationship: 'requested', title: '确认发布文案', dueMs: null, operation: 'record' }] }))
  const host = new PersonalCollectionHost({ store, spaces, policy, readScope, domain: 'feishu', enabled: () => true,
    feishu: { getMessage, findMessagesAsUserPage }, run, onResult,
    userTokens: { accessTokenResult: async () => ({ status: 'available', accessToken: 'SYNTHETIC', isCurrent: () => state.grant }) } })
  const cursor = () => db.prepare("SELECT version,page_token,completed_through FROM personal_collection_cursors WHERE open_id=? AND lane='group'").get(OWNER)
  return { db, todos, store, spaces, readScope, host, getMessage, findMessagesAsUserPage, run, state, onResult, message, hit, cursor }
}

describe('personal collection confirmed dissolved-chat gaps', () => {
  it('collects readable messages, persists the gap atomically, and never offers the unread source to the model', async () => {
    const t = fixture(), commit = vi.spyOn(t.store, 'commit')
    await t.host.tick()
    expect(t.cursor()?.completed_through).toBe(NOW / 1000)
    expect(t.store.progress(OWNER).gapCount).toBe(1)
    expect(t.run).toHaveBeenCalledTimes(1)
    expect(t.run.mock.calls[0]![0]).toContain('om_readable')
    expect(t.run.mock.calls[0]![0]).not.toContain('om_dissolved')
    expect(commit.mock.calls[0]![0].readGaps).toEqual([{ messageId: 'om_dissolved', chatId: 'oc_dissolved', chatType: 'group', reason: 'chat_dissolved' }])
    expect(t.db.prepare('SELECT count(*) AS n FROM personal_collection_receipts WHERE message_id=?').get('om_dissolved')?.n).toBe(0)
    expect(t.db.prepare('SELECT count(*) AS n FROM todos').get()?.n).toBe(1)
    expect(t.onResult).toHaveBeenCalledWith(expect.objectContaining({ state: 'collected', messages: 1, created: 1 }))
    expect(t.getMessage).toHaveBeenCalledWith('om_dissolved', { userToken: 'SYNTHETIC' })
  })

  it.each([
    ['other code', () => new FeishuApiError('message.get', 230006, 'Your request involves a chat which has already been dissolved')],
    ['other API', () => new FeishuApiError('message.search', 12009, 'Your request involves a chat which has already been dissolved')],
    ['unknown 12009', () => new FeishuApiError('message.get', 12009, 'Permission denied')],
    ['non-provider error', () => new Error('Your request involves a chat which has already been dissolved')],
    ['transport error', () => new TypeError('fetch failed')],
    ['unconfirmed dissolution text', () => new FeishuApiError('message.get', 12009, 'Check whether the chat has been dissolved or your permissions changed')],
  ])('keeps the entire page pending for %s', async (_name, error) => {
    const t = fixture(), before = t.cursor(), commit = vi.spyOn(t.store, 'commit')
    t.getMessage.mockImplementation(async id => { if (id === 'om_dissolved') throw error(); return t.message(id) })
    await t.host.tick()
    expect(commit).not.toHaveBeenCalled()
    expect(t.cursor()).toEqual(before)
    expect(t.store.progress(OWNER).gapCount).toBe(0)
    expect(t.run).not.toHaveBeenCalled()
    expect(t.onResult).toHaveBeenCalledWith(expect.objectContaining({ state: 'retrying', stage: 'message_read' }))
  })

  it.each(['grant', 'range', 'settings'] as const)('rechecks %s before accepting even the confirmed provider error', async mode => {
    const t = fixture(), commit = vi.spyOn(t.store, 'commit')
    t.getMessage.mockImplementation(async () => {
      if (mode === 'grant') t.state.grant = false
      if (mode === 'range') t.readScope.exclude(OWNER, 'oc_source')
      if (mode === 'settings') t.store.configure(OWNER, false)
      throw gone()
    })
    await t.host.tick()
    expect(commit).not.toHaveBeenCalled()
    expect(t.store.progress(OWNER).gapCount).toBe(0)
    expect(t.run).not.toHaveBeenCalled()
  })

  it('does not persist a gap if a later model failure prevents page commit', async () => {
    const t = fixture(), before = t.cursor()
    t.run.mockRejectedValue(new Error('model temporarily unavailable'))
    await t.host.tick()
    expect(t.cursor()).toEqual(before)
    expect(t.store.progress(OWNER).gapCount).toBe(0)
    expect(t.db.prepare('SELECT count(*) AS n FROM personal_collection_receipts').get()?.n).toBe(0)
  })

  it('does not extend the dissolved-group exception to a private chat', async () => {
    const t = fixture(), commit = vi.spyOn(t.store, 'commit')
    t.findMessagesAsUserPage.mockResolvedValueOnce({ items: [], hasMore: false })
    await t.host.tick()
    const before = t.db.prepare("SELECT version,completed_through FROM personal_collection_cursors WHERE lane='p2p'").get()
    t.findMessagesAsUserPage.mockResolvedValue({ items: [{ ...t.hit('om_dissolved'), isP2p: true }], hasMore: false })
    await t.host.tick()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(t.db.prepare("SELECT version,completed_through FROM personal_collection_cursors WHERE lane='p2p'").get()).toEqual(before)
    expect(t.store.progress(OWNER).gapCount).toBe(0)
    expect(t.onResult).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'retrying', stage: 'message_read' }))
  })

  it('does not persist a detected gap after authorization changes during extraction', async () => {
    const t = fixture(), before = t.cursor()
    t.run.mockImplementation(async () => { t.state.grant = false; return '{"decisions":[]}' })
    await t.host.tick()
    expect(t.cursor()).toEqual(before)
    expect(t.store.progress(OWNER).gapCount).toBe(0)
    expect(t.db.prepare('SELECT count(*) AS n FROM personal_collection_receipts').get()?.n).toBe(0)
  })

  it('clears a previous gap only after reading the matching detail, even when it is a bot message', async () => {
    const t = fixture(), commit = vi.spyOn(t.store, 'commit')
    t.findMessagesAsUserPage.mockResolvedValueOnce({ items: [t.hit('om_dissolved')], hasMore: true, nextPageToken: 'SYNTHETIC_NEXT' })
    await t.host.tick()
    expect(t.store.progress(OWNER).gapCount).toBe(1)
    t.findMessagesAsUserPage.mockResolvedValue({ items: [t.hit('om_dissolved')], hasMore: false })
    t.getMessage.mockResolvedValue({ ...t.message('om_dissolved'), senderType: 'app', senderOpenId: undefined })
    await t.host.tick()
    expect(commit.mock.calls[1]![0].resolvedReadGaps).toEqual([{ messageId: 'om_dissolved', chatId: 'oc_dissolved', chatType: 'group' }])
    expect(t.store.progress(OWNER).gapCount).toBe(0)
    expect(t.run).not.toHaveBeenCalled()
  })

  it('cannot clear a gap with an empty or mismatched message body', async () => {
    for (const mismatch of ['empty', 'id', 'chat'] as const) {
      const t = fixture()
      t.findMessagesAsUserPage.mockResolvedValueOnce({ items: [t.hit('om_dissolved')], hasMore: true, nextPageToken: 'SYNTHETIC_NEXT' })
      await t.host.tick()
      const before = t.cursor()
      t.findMessagesAsUserPage.mockResolvedValue({ items: [t.hit('om_dissolved')], hasMore: false })
      t.getMessage.mockResolvedValue(mismatch === 'empty' ? undefined : { ...t.message('om_dissolved'),
        ...(mismatch === 'id' ? { messageId: 'om_other' } : { chatId: 'oc_other' }) })
      await t.host.tick()
      expect(t.cursor()).toEqual(before)
      expect(t.store.progress(OWNER).gapCount).toBe(1)
    }
  })

  it('retains a freshly authorized sibling detail even while the same chat has an unread gap', async () => {
    const t = fixture()
    t.findMessagesAsUserPage.mockResolvedValue({ items: [t.hit('om_dissolved'), { ...t.hit('om_readable'), chatId: 'oc_dissolved' }], hasMore: false })
    t.getMessage.mockImplementation(async id => {
      if (id === 'om_dissolved') throw gone()
      return { ...t.message(id), chatId: 'oc_dissolved', senderOpenId: OWNER, text: 'SYNTHETIC_SIBLING_EVIDENCE' }
    })
    t.run.mockResolvedValue('{"decisions":[]}')
    await t.host.tick()
    expect(t.store.progress(OWNER).gapCount).toBe(1)
    expect(t.run).toHaveBeenCalledTimes(1)
    expect(t.run.mock.calls[0]![0]).toContain('SYNTHETIC_SIBLING_EVIDENCE')
    expect(t.run.mock.calls[0]![0]).not.toContain('om_dissolved')
    expect(t.db.prepare('SELECT count(*) AS n FROM personal_reply_messages').get()?.n).toBe(1)
    expect(t.db.prepare('SELECT count(*) AS n FROM personal_collection_receipts').get()?.n).toBe(1)
  })

  it('extracts and receipts a recovered user message before clearing its last gap and advancing', async () => {
    const t = fixture()
    t.findMessagesAsUserPage.mockResolvedValueOnce({ items: [t.hit('om_dissolved')], hasMore: true, nextPageToken: 'NEXT' })
    await t.host.tick()
    expect(t.store.progress(OWNER).gapCount).toBe(1)
    t.findMessagesAsUserPage.mockResolvedValue({ items: [t.hit('om_dissolved')], hasMore: false })
    t.getMessage.mockResolvedValue(t.message('om_dissolved'))
    t.run.mockResolvedValue(JSON.stringify({ decisions: [{ messageId: 'om_dissolved', quote: '请确认发布文案', existingId: null,
      kind: 'todo', relationship: 'requested', title: '恢复后确认文案', dueMs: null, operation: 'record' }] }))
    await t.host.tick()
    expect(t.run).toHaveBeenCalledTimes(1)
    expect(t.run.mock.calls[0]![0]).toContain('om_dissolved')
    expect(t.store.progress(OWNER).gapCount).toBe(0)
    expect(t.db.prepare('SELECT count(*) AS n FROM personal_collection_receipts WHERE message_id=?').get('om_dissolved')?.n).toBe(1)
    expect(t.db.prepare('SELECT count(*) AS n FROM todos').get()?.n).toBe(1)
    expect(t.cursor()?.completed_through).toBe(NOW / 1000)
  })

  it.each(['this page', 'persisted gap'] as const)('never uses a cached answer from a dissolved chat (%s) to close a reply', async mode => {
    const t = fixture()
    const request = asCollection({ ...t.message('om_source'), text: '@owner 请确认 https://github.com/team/repo/pull/41 是否默认开启' })
    t.store.commit({ profile: t.store.profile(OWNER)!, cursor: t.store.next(OWNER)!,
      audience: { openId: OWNER, scope: `space:sp_dm_${OWNER}`, chatId: 'oc_friday', chatType: 'p2p' },
      messages: [request], candidates: [], decisions: [{ messageId: request.metadata.messageId, quote: request.text, existingId: null,
        kind: 'reply', relationship: 'requested', title: '确认默认开关', dueMs: null, operation: 'record' }], nextPageToken: 'NEXT', assertCurrent() {} })
    const id = t.store.candidates(OWNER)[0]!.id
    const answer = asCollection({ ...t.message('om_answer'), senderOpenId: OWNER, chatId: 'oc_dissolved', createTimeMs: NOW,
      text: 'https://github.com/team/repo/pull/41 选 A，可以默认开启。' })
    t.store.retainReplies(OWNER, [answer])
    if (mode === 'persisted gap') {
      t.store.commit({ profile: t.store.profile(OWNER)!, cursor: t.store.next(OWNER)!,
        audience: { openId: OWNER, scope: `space:sp_dm_${OWNER}`, chatId: 'oc_friday', chatType: 'p2p' },
        messages: [], decisions: [], candidates: [], readGaps: [{ messageId: 'om_other_gap', chatId: 'oc_dissolved', chatType: 'group', reason: 'chat_dissolved' }],
        nextPageToken: 'NEXT_AGAIN', assertCurrent() {} })
      t.findMessagesAsUserPage.mockResolvedValue({ items: [], hasMore: false })
    } else t.findMessagesAsUserPage.mockResolvedValue({ items: [{ messageId: 'om_answer', chatId: 'oc_dissolved', isP2p: false }], hasMore: false })
    t.getMessage.mockImplementation(async messageId => {
      if (messageId === 'om_answer') throw gone()
      return { ...request.metadata, senderType: 'user', senderName: request.senderName, text: request.text } as HistoryMessage
    })
    t.run.mockImplementation(async prompt => prompt.includes('<reply_review>')
      ? JSON.stringify({ resolved: [{ id, messageId: 'om_answer', quote: answer.text, anchor: 'https://github.com/team/repo/pull/41' }] })
      : '{"decisions":[]}')
    await t.host.tick()
    expect(t.run.mock.calls.every(([prompt]) => !prompt.includes(answer.text))).toBe(true)
    expect(t.todos.get(id)?.status).toBe('open')
    expect(t.store.progress(OWNER).gapCount).toBe(1)
    expect(t.db.prepare('SELECT count(*) AS n FROM personal_reply_messages').get()?.n).toBe(1)
  })
})
