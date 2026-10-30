import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PersonalDesktopApplication } from '../src/personal/desktop-application.js'
import { PersonalResults, type PersonalResult } from '../src/personal/results.js'
import { PersonalApplication } from '../src/core/personal-application.js'
import { PersonalCollectionStore } from '../src/core/personal-collection.js'
import { PersonalAssistance } from '../src/core/personal-assistance.js'
import { Registry, type SessionRow } from '../src/core/registry.js'
import { Spaces } from '../src/core/space.js'
import { PolicyService } from '../src/core/policy.js'
import { Todos } from '../src/core/todos.js'
import { TodoApplication } from '../src/core/todo-application.js'
import { ChatReadScope } from '../src/core/chat-read-scope.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { dmThreadKey, type InboundMessage } from '../src/feishu/mention.js'
import { sealDevice } from '../src/personal/device-crypto.js'

const registries: Registry[] = []
afterEach(() => registries.splice(0).forEach(registry => registry.close()))
function fixture() {
  const registry = new Registry(':memory:'); registries.push(registry); new RunAttempts(registry.db)
  const spaces = new Spaces(registry.db), policy = new PolicyService(spaces, { admins: [] }), todos = new Todos(registry.db)
  spaces.ensure({ kind: 'p2p', openId: 'alice', chatId: 'alice-dm' })
  const collection = new PersonalCollectionStore(registry.db, todos)
  const application = new PersonalApplication({ registry, spaces, policy, todos, collection,
    application: new TodoApplication({ db: registry.db, todos }), readScope: new ChatReadScope(registry.db), controls: {} as never,
    now: Date.now, assertActive() {}, userTokens: { get: () => undefined, isConnected: () => false, grantId: () => null, begin: () => 'unused' },
    authorizeUrl: () => 'https://example.test' })
  const assistance = new PersonalAssistance({ registry, todos, now: Date.now, audience: owner => application.audience(owner), readable: () => false,
    canReadPr: () => false, createSession: () => { throw new Error('No offer in this test') } })
  const authorize = vi.fn(async (_value: PersonalResult, guard: () => void) => ({ status: 'allowed' as const, assertCurrent: guard }))
  const results = new PersonalResults(registry.db, authorize)
  const domain = new PersonalDesktopApplication({ application, registry, todos, collection, assistance, results,
    now: Date.now, dispatch: vi.fn(), changed: vi.fn() })
  const session = (key: string, owner = 'alice') => registry.createSession({ sessionKey: key, chatId: `${owner}-dm`, chatType: 'p2p', requesterOpenId: owner, cwd: '/synthetic' })
  const main = session(dmThreadKey('alice'))
  const add = (text: string, target: SessionRow = main, desktop = false) => {
    const id = randomUUID(), inbound: InboundMessage = { eventId: id, messageId: id, chatId: target.chatId, chatType: 'p2p',
      senderOpenId: target.requesterOpenId!, senderType: 'user', msgType: 'text', text, mentions: [], createTimeMs: Date.now(),
      ...(desktop ? { personalDevice: { id: 'synthetic-device', requestId: randomUUID() } } : {}) }
    return registry.createTaskOnce({ sessionKey: target.sessionKey, messageId: id, requesterOpenId: target.requesterOpenId!, prompt: text, inbound }).task
  }
  const answer = (taskId: number, body = 'Authorized answer', at = 12345) => results.save({ body, provenance: { sources: {}, memoryRefs: [] },
    origin: { taskId, sessionKey: main.sessionKey, ownerOpenId: 'alice', spaceId: 'sp_dm_alice', chatId: main.chatId, chatType: 'p2p' } } as PersonalResult, at)
  const prepare = () => domain.prepare('alice', { operation: 'conversation' }, () => {})
  const read = async () => (await prepare())!() as any
  return { registry, domain, results, authorize, main, session, add, answer, prepare, read }
}
function gate() {
  let release!: () => void
  return { promise: new Promise<void>(resolve => { release = resolve }), release: () => release() }
}

describe('desktop personal conversation snapshots', () => {
  it('selects the latest 20 main-chat turns before limiting other work and preserves full requests, origin and answer time', async () => {
    const t = fixture(), main = Array.from({ length: 24 }, (_, i) => t.add(`Feishu input ${i}`))
    const text = '完整请求'.repeat(3000), last = t.add(text, t.main, true); main.push(last); t.answer(last.id, 'Final answer', 56789)
    const side = t.session('separate-work')
    for (let i = 0; i < 110; i++) t.add(`Independent input ${i}`, side)
    t.add('Other owner', t.session('bob-main', 'bob'))
    const snapshot = await t.read()
    expect(snapshot.items.map((item: any) => item.id)).toEqual(main.slice(-20).map(task => task.id))
    expect(snapshot.hasMore).toBe(true)
    expect(snapshot.items[0].origin).toBe('feishu')
    expect(snapshot.items.at(-1)).toMatchObject({ request: text, origin: 'desktop', body: 'Final answer', answerAt: 56789 })
    const result = await t.domain.prepare('alice', { operation: 'result', taskId: last.id }, () => {})
    expect(result!()).toEqual({ taskId: last.id, body: 'Final answer', answerAt: 56789, resultVersion: snapshot.items.at(-1).resultVersion })
  })

  it('returns metadata without waiting for any source lookup or disclosing saved answer text', async () => {
    const t = fixture(), turns = Array.from({ length: 20 }, (_, i) => t.add(`Question ${i}`))
    for (const turn of turns) t.answer(turn.id, 'BODY_REQUIRES_ITS_OWN_SOURCE_CHECK', 12345)
    t.authorize.mockImplementation(async () => { throw new Error('Metadata must not initiate provider I/O') })
    const prepared = await t.domain.prepare('alice', { operation: 'conversation', includeResults: false }, () => {})
    const snapshot = prepared!() as any
    expect(snapshot).toMatchObject({ resultsValidated: false, conversationId: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(snapshot.items).toHaveLength(20)
    expect(snapshot.items.every((item: any) => item.resultAvailable && item.resultPending && !item.unavailable &&
      !item.body && item.answerAt === 12345 && /^[a-f0-9]{64}$/.test(item.resultVersion))).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('BODY_REQUIRES_ITS_OWN_SOURCE_CHECK')
    expect(t.authorize).not.toHaveBeenCalled()
  })

  it('treats result versions as identity only and rechecks sources for every progressive body read', async () => {
    const t = fixture(), task = t.add('Question'); t.answer(task.id, 'PRIVATE_ANSWER', 23456)
    let allowed = true
    t.authorize.mockImplementation(async (_value, guard) => {
      const current = () => { guard(); if (!allowed) throw new Error('Source revoked') }
      current(); return { status: 'allowed', assertCurrent: current }
    })
    const metadata = (await t.domain.prepare('alice', { operation: 'conversation', includeResults: false }, () => {}))!() as any
    const command = { operation: 'result', taskId: task.id, conversationId: metadata.conversationId }
    allowed = false
    await expect(t.domain.prepare('alice', command, () => {})).rejects.toThrow('Source revoked')
    allowed = true
    const prepared = await t.domain.prepare('alice', command, () => {})
    expect(prepared!()).toEqual({ taskId: task.id, body: 'PRIVATE_ANSWER', answerAt: 23456, resultVersion: metadata.items[0].resultVersion })
    allowed = false
    expect(() => prepared!()).toThrow('Source revoked')
    await expect(t.domain.prepare('alice', command, () => {})).rejects.toThrow('Source revoked')
    expect(t.authorize).toHaveBeenCalledTimes(3)
    expect((await t.domain.prepare('alice', { operation: 'conversation', includeResults: false }, () => {}))!()).toMatchObject({ resultsValidated: false })
    expect(t.authorize).toHaveBeenCalledTimes(3)
  })

  it.each(['new conversation', 'different owner', 'archived'])('rejects a progressive body when its main conversation becomes %s', async change => {
    const t = fixture(), task = t.add('Old question'), wait = gate(); t.answer(task.id, 'OLD_PRIVATE_ANSWER')
    const metadata = (await t.domain.prepare('alice', { operation: 'conversation', includeResults: false }, () => {}))!() as any
    t.authorize.mockImplementation(async (_value, guard) => { await wait.promise; return { status: 'allowed', assertCurrent: guard } })
    const prepared = t.domain.prepare('alice', { operation: 'result', taskId: task.id, conversationId: metadata.conversationId }, () => {})
    const rejected = expect(prepared).rejects.toThrow('对话已变化')
    await vi.waitFor(() => expect(t.authorize).toHaveBeenCalledOnce())
    if (change === 'new conversation') t.registry.addAlias(dmThreadKey('alice'), t.session('replacement').sessionKey)
    if (change === 'different owner') t.registry.db.prepare('UPDATE sessions SET requester_open_id=? WHERE session_key=?').run('bob', t.main.sessionKey)
    if (change === 'archived') t.registry.updateSession(t.main.sessionKey, { status: 'archived' })
    wait.release(); await rejected
  })

  it('refuses a conversation-bound read for another work and changes the version when the saved result changes', async () => {
    const t = fixture(), task = t.add('Main question'), other = t.add('Independent question', t.session('independent'))
    t.answer(task.id, 'Original answer'); t.answer(other.id)
    const metadata = (await t.domain.prepare('alice', { operation: 'conversation', includeResults: false }, () => {}))!() as any
    await expect(t.domain.prepare('alice', { operation: 'result', taskId: other.id, conversationId: metadata.conversationId }, () => {})).rejects.toThrow('对话已变化')
    await expect(t.domain.prepare('alice', { operation: 'result', taskId: task.id, conversationId: 'f'.repeat(64) }, () => {})).rejects.toThrow('对话已变化')
    expect(t.authorize).not.toHaveBeenCalled()
    t.registry.db.prepare('UPDATE personal_results SET created_at=created_at+1 WHERE task_id=?').run(task.id)
    const value = (await t.domain.prepare('alice', { operation: 'result', taskId: task.id, conversationId: metadata.conversationId }, () => {}))!() as any
    expect(value.resultVersion).not.toBe(metadata.items[0].resultVersion)
    expect(value.body).toBe('Original answer')
  })

  it('refreshes running state and new inputs after slow validation without exposing a newly completed unchecked body', async () => {
    const t = fixture(), first = t.add('Earlier request'), pending = t.add('Still queued'), wait = gate()
    t.answer(first.id)
    t.authorize.mockImplementation(async (_value, guard) => { await wait.promise; return { status: 'allowed', assertCurrent: guard } })
    const prepared = t.prepare()
    await vi.waitFor(() => expect(t.authorize).toHaveBeenCalledOnce())
    t.registry.updateTask(pending.id, { status: 'running' }); t.answer(pending.id, 'NEW_BODY_MUST_WAIT_FOR_ITS_OWN_CHECK')
    const next = t.add('New Feishu input')
    wait.release()
    const snapshot = (await prepared)!() as any
    expect(snapshot.items.map((item: any) => item.id)).toEqual([first.id, pending.id, next.id])
    expect(snapshot.items.find((item: any) => item.id === pending.id)).toMatchObject({ progress: { state: 'running' }, resultAvailable: true, resultPending: true, unavailable: false })
    expect(JSON.stringify(snapshot)).not.toContain('NEW_BODY_MUST_WAIT_FOR_ITS_OWN_CHECK')
    expect(t.authorize).toHaveBeenCalledOnce()
    expect((await t.read()).items.find((item: any) => item.id === pending.id).body).toBe('NEW_BODY_MUST_WAIT_FOR_ITS_OWN_CHECK')
  })

  it.each(['new conversation', 'different owner', 'archived'])('rejects a slow answer when its main conversation becomes %s', async change => {
    const t = fixture(), task = t.add('Old question'), wait = gate(); t.answer(task.id, 'OLD_PRIVATE_ANSWER')
    t.authorize.mockImplementation(async (_value, guard) => { await wait.promise; return { status: 'allowed', assertCurrent: guard } })
    const prepared = t.prepare(), rejected = expect(prepared).rejects.toThrow('对话已变化')
    await vi.waitFor(() => expect(t.authorize).toHaveBeenCalledOnce())
    if (change === 'new conversation') t.registry.addAlias(dmThreadKey('alice'), t.session('replacement').sessionKey)
    if (change === 'different owner') t.registry.db.prepare('UPDATE sessions SET requester_open_id=? WHERE session_key=?').run('bob', t.main.sessionKey)
    if (change === 'archived') t.registry.updateSession(t.main.sessionKey, { status: 'archived' })
    wait.release(); await rejected
  })

  it('rechecks the main session and sources at delivery and on subsequent history reads', async () => {
    const t = fixture(), task = t.add('Question'); t.answer(task.id, 'SOURCE_PRIVATE_ANSWER')
    let allowed = true
    t.authorize.mockImplementation(async (_value, guard) => {
      if (!allowed) throw new Error('Source revoked')
      return { status: 'allowed', assertCurrent: () => { guard(); if (!allowed) throw new Error('Source revoked') } }
    })
    const prepared = await t.prepare(); expect((prepared!() as any).items[0].body).toBe('SOURCE_PRIVATE_ANSWER')
    allowed = false
    expect(() => prepared!()).toThrow('Source revoked')
    const revoked = await t.read()
    expect(revoked.items[0]).toMatchObject({ unavailable: true, resultPending: false })
    expect(JSON.stringify(revoked)).not.toContain('SOURCE_PRIVATE_ANSWER')
    allowed = true
    const beforeNew = await t.prepare()
    t.registry.addAlias(dmThreadKey('alice'), t.session('replacement').sessionKey)
    expect(() => beforeNew!()).toThrow('对话已变化')
    expect((await t.read()).items).toEqual([])
  })

  it('bounds long Chinese history to the existing encrypted envelope while keeping recent request text intact', async () => {
    const t = fixture(), text = '中'.repeat(12000), turns = Array.from({ length: 20 }, () => t.add(text))
    for (const turn of turns) t.answer(turn.id, '答'.repeat(8000))
    const snapshot = await t.read()
    expect(snapshot.hasMore).toBe(true)
    expect(snapshot.items.at(-1).id).toBe(turns.at(-1)!.id)
    expect(snapshot.items.every((item: any) => item.request === text)).toBe(true)
    expect(snapshot.items.at(-1)).toMatchObject({ body: '答'.repeat(500), truncated: true })
    expect(sealDevice(Buffer.alloc(32, 7), snapshot, 'synthetic-conversation').length).toBeLessThan(600000)
  })
})
