import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { Spaces } from '../src/core/space.js'
import { PolicyService } from '../src/core/policy.js'
import { Todos } from '../src/core/todos.js'
import { TodoApplication } from '../src/core/todo-application.js'
import { ChatReadScope } from '../src/core/chat-read-scope.js'
import { RoutineStore } from '../src/core/routines.js'
import { RoutineApplication } from '../src/core/routine-application.js'
import { PersonalCollectionStore, PERSONAL_COLLECTION_SCOPES } from '../src/core/personal-collection.js'
import { PersonalOnboarding } from '../src/core/personal-onboarding.js'
import { PersonalApplication } from '../src/core/personal-application.js'
import { PersonalAssistance, validPersonalAssistanceDispatch } from '../src/core/personal-assistance.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import type { CardAction } from '../src/feishu/ws.js'
import { measureTodoCard } from '../src/feishu/todo-card-pagination.js'
import type { PersonalGitHubState } from '../src/github/personal-work.js'
import { GitHubUserConnections } from '../src/github/user-connection.js'
import { PersonalDevices } from '../src/personal/devices.js'
import { createLogger } from '../src/log.js'

const OWNER = 'ou_owner', NOW = Date.parse('2026-09-30T04:00:00Z')
const registries: Registry[] = []
afterEach(() => registries.splice(0).forEach(registry => registry.close()))
function all(value: unknown): Record<string, any>[] {
  if (!value || typeof value !== 'object') return []
  return [value as Record<string, any>, ...Object.values(value).flatMap(all)]
}
function behavior(card: unknown, op: string, extra: Record<string, unknown> = {}) {
  const found = all(card).find(node => node.value?.op === op && Object.entries(extra).every(([key, val]) => node.value[key] === val))
  if (!found) throw new Error(`Missing action ${op}`)
  return found.value
}
function fixture(verifyPr = false) {
  const registry = new Registry(':memory:'); registries.push(registry)
  const clock = { now: NOW, active: true }, now = () => clock.now
  const spaces = new Spaces(registry.db, now), policy = new PolicyService(spaces, { admins: ['ou_admin'] })
  spaces.ensure({ kind: 'p2p', openId: OWNER, chatId: 'oc_friday' })
  spaces.ensure({ kind: 'p2p', openId: 'ou_other', chatId: 'oc_other_dm' })
  const todos = new Todos(registry.db), application = new TodoApplication({ db: registry.db, todos })
  const readScope = new ChatReadScope(registry.db, now), collection = new PersonalCollectionStore(registry.db, todos, now, readScope)
  const routines = new RoutineStore(registry.db), attempts = new RunAttempts(registry.db)
  let granted: readonly string[] = [...PERSONAL_COLLECTION_SCOPES, 'calendar:calendar:readonly']
  const userTokens = new UserTokenStore(registry.db, { exchangeCode: async () => ({ accessToken: 'synthetic-only', scope: granted.join(' '), expiresIn: 7200 }),
    refresh: async () => { throw new Error('no refresh fixture') } }, now)
  const controls = new RoutineApplication({ registry, spaces, policy, routines, attempts, userTokens, now, activeRuns: () => [] })
  const deliveries: { openId: string; card: unknown; uuid: string; messageId: string }[] = [], seen = new Map<string, string>()
  const feishu = {
    sendToUserOnce: vi.fn(async (openId: string, payload: { card: unknown }, uuid: string) => {
      if (seen.has(uuid)) return seen.get(uuid)!
      const messageId = `om_${deliveries.length + 1}`; seen.set(uuid, messageId)
      deliveries.push({ openId, card: payload.card, uuid, messageId }); return messageId
    }), getMessage: vi.fn(async () => undefined), patchCard: vi.fn(async () => {}),
  }
  const deps = { registry, spaces, policy, collection, todos, application, readScope, routines, controls, userTokens, feishu: feishu as any,
    oauth: { appId: 'test-app', redirectUri: 'https://example.test/oauth', domain: 'feishu' as const }, now,
    assertActive: () => { if (!clock.active) throw new Error('host closing') } }
  const audience = { scope: `space:sp_dm_${OWNER}`, openId: OWNER, chatId: 'oc_friday', chatType: 'p2p' as const }
  const dispatchAssistance = vi.fn()
  const prState = vi.fn((): PersonalGitHubState | undefined => ({ url: 'https://github.com/team/repo/pull/41', state: 'open', head: 'a'.repeat(40),
    updatedAt: new Date(NOW).toISOString(), note: 'PR #41 仍开放' }))
  const assistance = new PersonalAssistance({ registry, todos, now, audience: owner => {
    if (owner !== OWNER || !clock.active) throw new Error('wrong owner'); return audience
  }, readable: (owner, source) => userTokens.isConnected(owner) && readScope.isReadable(owner, source.collection!.message.chatId),
    canReadPr: (_owner, repo) => repo === 'team/repo', ...(verifyPr ? { prState } : {}), createSession: msg => registry.createSession({
      sessionKey: msg.messageId, chatId: msg.chatId, chatType: 'p2p', requesterOpenId: msg.senderOpenId, cwd: '/synthetic-only' }) })
  Object.assign(deps, { assistance, dispatchAssistance })
  const setup = new PersonalOnboarding(deps)
  const grant = async (state = userTokens.begin(OWNER), scopes?: readonly string[]) => {
    if (scopes) granted = scopes
    await userTokens.complete({ code: `synthetic-code-${state}`, state, openId: OWNER, redirectUri: deps.oauth.redirectUri,
      verify: async () => ({ openId: OWNER }) })
  }
  const click = (messageId: string, value: Record<string, unknown>, more: Partial<CardAction> = {}) => setup.handle({
    operatorOpenId: OWNER, chatId: 'oc_friday', messageId, value, raw: {}, ...more })
  const start = async () => {
    await grant()
    const id = await setup.show(OWNER, 'setup')
    const response = click(id, behavior(deliveries.at(-1)!.card, 'start'))
    expect(response.toast).toBeUndefined()
    return id
  }
  const add = (title = '确认发布文案') => application.create(audience, { title, dueMs: NOW + 4 * 3600_000, ownerOpenId: OWNER }, OWNER).todo
  const collect = (text = '@owner 请 review https://github.com/team/repo/pull/41', kind: 'todo' | 'reply' = 'todo', relationship: 'requested' | 'uncertain' = 'requested') => {
    const messageId = `om_source_${todos.listForAudience(audience, { status: 'all' }).total}`
    collection.commit({ profile: collection.profile(OWNER)!, cursor: collection.next(OWNER)!, audience, candidates: [], assertCurrent() {},
      messages: [{ text, mentions: [OWNER], metadata: { messageId, chatId: 'oc_product', chatType: 'group', senderOpenId: 'ou_requester', msgType: 'text',
        createTimeMs: NOW - 1000, link: { status: 'available', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_product&position=20' } } }],
      decisions: [{ messageId, quote: text, existingId: null, kind, relationship, title: text, dueMs: null, operation: 'record' }] })
    return todos.listForAudience(audience, { status: 'active' }).items.find(todo =>
      todos.getProvenance(todo.id)?.collection?.message.messageId === messageId)!
  }
  return { registry, clock, spaces, collection, todos, application, routines, readScope, userTokens, setup, deps, deliveries, feishu, grant, click, start, add, collect, audience, assistance, dispatchAssistance, prState }
}

describe('personal application without a card entry point', () => {
  it('shows partial coverage with separate group and private-chat progress on Feishu, respecting current scope', () => {
    const t = fixture(); t.collection.configure(OWNER, true)
    const commit = (readGaps: Parameters<typeof t.collection.commit>[0]['readGaps'] = []) => t.collection.commit({
      profile: t.collection.profile(OWNER)!, cursor: t.collection.next(OWNER)!, audience: t.audience,
      messages: [], decisions: [], candidates: [], readGaps, assertCurrent() {},
    })
    commit([{ messageId: 'om_gap', chatId: 'oc_dissolved', chatType: 'group', reason: 'chat_dissolved' }]); commit()
    const text = t.setup.statusText(OWNER)
    expect(text).toContain('1 条读取缺口'); expect(text).toContain('群聊：1 条读取缺口')
    expect(text).toContain('私聊：持续收集中'); expect(text).toContain('已扫描至'); expect(text).toContain('完整覆盖至')
    expect(text).not.toContain('undefined')
    t.readScope.exclude(OWNER, 'oc_dissolved')
    expect(t.setup.statusText(OWNER)).not.toContain('读取缺口')
    t.readScope.restore(OWNER, 'oc_dissolved')
    expect(t.setup.statusText(OWNER)).toContain('1 条读取缺口')
  })
  it('prepares a general source-backed item once and leaves completion to the owner', async () => {
    const t = fixture(); await t.start()
    const todo = t.collect('@owner 请在周五前核对发布清单'), sent = t.deliveries.length
    expect(t.assistance.suggest(OWNER, [todo])).toBeUndefined()
    const offer = t.assistance.suggest(OWNER, [todo], { general: true })!
    expect(offer).toMatchObject({ kind: 'preparation', label: '帮我准备', todoId: todo.id })
    expect(t.assistance.suggest(OWNER, [todo], { general: true })?.id).toBe(offer.id)
    const input = { id: offer.id, version: offer.version, actorId: OWNER, decision: 'start' as const,
      requestId: 'desktop-prepare', source: { surface: 'desktop' as const, reference: 'device:request' } }
    const task = t.assistance.decide(input)!
    expect(t.assistance.decide({ ...input, requestId: 'second-click' })?.id).toBe(task.id)
    expect(task.prompt).toContain('处理建议：核实当前进展')
    expect(task.prompt).toContain('不替用户做决定、承诺交期或向他人发消息')
    expect(task.prompt).toContain('完成准备工作不等于用户完成了原待办')
    expect(t.todos.get(todo.id)?.status).toBe('open')
    expect(t.deliveries).toHaveLength(sent)
    expect(validPersonalAssistanceDispatch(t.registry.db, task.id, t.registry.dispatches.get(task.id)!.inbound)).toBe(true)
    const current = t.todos.get(todo.id)!
    t.setup.application.updateItem(OWNER, { id: todo.id, version: t.setup.application.itemVersion(OWNER, current), operation: 'done' })
    expect(t.setup.application.query(OWNER, 'active').items).toEqual([])
    expect(t.setup.application.query(OWNER, 'closed').items.map(item => item.id)).toContain(todo.id)
    expect(() => t.assistance.decide(input)).toThrow('事项或读取范围')
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM tasks').get()?.n).toBe(1)
  })
  it('does not offer general preparation for uncertain attribution or sources the owner excluded', async () => {
    const t = fixture(); await t.start()
    const uncertain = t.collect('下周核对这份清单', 'todo', 'uncertain')
    expect(t.assistance.suggest(OWNER, [uncertain], { general: true })).toBeUndefined()
    const todo = t.collect('@owner 请核对发布清单')
    const offer = t.assistance.suggest(OWNER, [todo], { general: true })!
    t.readScope.exclude(OWNER, 'oc_product')
    expect(t.assistance.suggest(OWNER, [todo], { general: true })).toBeUndefined()
    expect(() => t.assistance.decide({ id: offer.id, version: offer.version, actorId: OWNER, decision: 'start', requestId: 'after-revoke',
      source: { surface: 'desktop', reference: 'device:request' } })).toThrow('读取范围')
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM tasks').get()?.n).toBe(0)
  })
  it('binds device approval and revocation to the private card owner and the displayed request', async () => {
    const t = fixture()
    const devices = new PersonalDevices({ db: t.registry.db, encryptionKey: Buffer.alloc(32, 9), relayToken: 'synthetic-desktop-relay-token',
      baseUrl: 'https://example.test', lifetimeMs: 86_400_000, now: () => NOW,
      assertOwner: owner => { if (owner !== OWNER) throw new Error('Unavailable owner') } })
    Object.assign(t.deps, { devices })
    const id = await t.setup.show(OWNER, 'connections'), begin = behavior(t.deliveries.at(-1)!.card, 'desktop_begin')
    expect(t.click(id, begin, { operatorOpenId: 'ou_other' }).toast).toMatchObject({ type: 'error' })
    expect(devices.pending()).toHaveLength(0)
    const started = t.click(id, begin), pending = devices.pendingFor(OWNER)!
    expect(JSON.stringify(started)).toContain(devices.pairUrl(pending))
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const request = devices.request(pending.state, { label: 'My Mac', publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') })
    await t.setup.githubConnectionChanged(OWNER)
    const approvalCard = t.feishu.patchCard.mock.calls.at(-1)![1]
    expect(JSON.stringify(approvalCard)).toContain(request.fingerprint)
    const approve = behavior(approvalCard, 'desktop_approve')
    expect(t.click(id, { ...approve, requestHash: 'changed' }).toast).toMatchObject({ type: 'error' })
    expect(t.click(id, approve, { operatorOpenId: 'ou_other' }).toast).toMatchObject({ type: 'error' })
    expect(devices.list(OWNER)).toHaveLength(0)
    const connected = t.click(id, approve)
    t.click(id, approve)
    expect(devices.list(OWNER)).toHaveLength(1)
    expect(JSON.stringify(connected)).not.toMatch(/fd1\.|\"secret\"|\"publicKey\"/)
    const revoke = behavior(connected, 'desktop_revoke')
    expect(t.click(id, revoke, { operatorOpenId: 'ou_other' }).toast).toMatchObject({ type: 'error' })
    expect(devices.list(OWNER)[0].revokedAt).toBeNull()
    expect(t.click(id, revoke).toast).toBeUndefined()
    expect(devices.list(OWNER)[0].revokedAt).toBe(NOW)
    expect(t.deliveries).toHaveLength(1)
  })

  it('opens a private token configuration page only for the card owner, retains it on refresh and cancels safely', async () => {
    const t = fixture()
    const personalGithub = new GitHubUserConnections({ db: t.registry.db, key: Buffer.alloc(32, 4), now: () => NOW, log: createLogger('test', 'error'),
      tokenRelay: { baseUrl: 'https://example.test', token: 'synthetic' }, http: async () => ({ status: 401, data: {} }) })
    Object.assign(t.deps, { personalGithub })
    const id = await t.setup.show(OWNER, 'connections')
    const action = behavior(t.deliveries.at(-1)!.card, 'token')
    expect(t.click(id, action, { operatorOpenId: 'ou_other' }).toast).toMatchObject({ type: 'error' })
    expect(personalGithub.pending()).toHaveLength(0)
    const response = t.click(id, action), link = all(response).find(n => String(n.default_url).includes('/github/token?'))!.default_url
    expect(response.toast).toBeUndefined()
    expect(personalGithub.pendingTokenUrl(OWNER)).toBe(link)
    const refreshed = t.click(id, { action: 'personal_connections', op: 'view' })
    expect(JSON.stringify(refreshed)).toContain(link)
    expect(personalGithub.pending()).toHaveLength(1)
    t.click(id, { action: 'personal_connections', op: 'cancel' })
    expect(personalGithub.pending()).toHaveLength(0)
    expect(personalGithub.view(OWNER).status).toBe('disconnected')
  })
  it('connects GitHub with one external link, protects card ownership and shares the live list pointer', async () => {
    const t = fixture()
    const personalGithub = new GitHubUserConnections({ db: t.registry.db, key: Buffer.alloc(32, 4), now: () => NOW, log: createLogger('test', 'error'),
      config: { clientId: 'synthetic', clientSecret: 'synthetic', relayToken: 'synthetic', redirectUri: 'https://test.invalid/github/callback' },
      http: async path => ({ status: 200, data: path === '/user' ? { id: 123, login: 'owner' } : { access_token: 'ghu_owner', token_type: 'bearer' } }) })
    Object.assign(t.deps, { personalGithub, githubDiscovery: { view: () => ({ revision: 1, checkedAt: NOW, partial: false, state: 'current', waiting: [] }) } })
    const id = await t.setup.show(OWNER, 'connections')
    const target = all(t.deliveries.at(-1)!.card).find(node => String(node.default_url).startsWith('https://github.com/login/oauth/authorize'))!
    expect(target).toBeDefined()
    const state = new URL(target.default_url).searchParams.get('state')!
    expect(t.click(id, { action: 'personal_connections', op: 'connect' }, { operatorOpenId: 'ou_other' }).toast).toMatchObject({ type: 'error' })
    expect(personalGithub.pending()).toHaveLength(1)
    await personalGithub.complete(state, OWNER, 'synthetic')
    await t.setup.githubConnectionChanged(OWNER)
    expect(JSON.stringify(t.feishu.patchCard.mock.calls.at(-1))).toContain('[owner](https://github.com/owner)')
    // Native GitHub results do not wait for optional Feishu calendar authorization.
    expect(t.userTokens.isConnected(OWNER)).toBe(false)
    await t.setup.githubProgress(OWNER); await t.setup.githubProgress(OWNER)
    expect(t.deliveries).toHaveLength(2)
    expect(t.registry.getKv(`personal-tasks-message:${OWNER}`)).toBe(t.deliveries.at(-1)!.messageId)
    expect(t.click(id, { action: 'personal_tasks', op: 'view', view: 'active' }).toast).toBeUndefined()
    expect(t.registry.getKv(`personal-tasks-message:${OWNER}`)).toBe(id)
    const revision = personalGithub.view(OWNER).revision
    expect(t.click(id, { action: 'personal_connections', op: 'disconnect', revision: revision - 1 }).toast).toMatchObject({ type: 'error' })
    expect(personalGithub.view(OWNER).status).toBe('connected')
    t.click(id, { action: 'personal_connections', op: 'disconnect', revision })
    expect(personalGithub.view(OWNER).status).toBe('disconnected')
  })

  it('dismisses one preparation suggestion without silencing help on another item', async () => {
    const t = fixture(); await t.start()
    const first = t.collect('请确认明天发布文案。', 'reply'), second = t.collect('请反馈测试方案的选择。', 'reply')
    const offer = t.assistance.suggest(OWNER, [first, second])!
    expect(offer).toBeDefined()
    t.assistance.decide({ id: offer.id, version: offer.version, actorId: OWNER, decision: 'dismiss', requestId: 'dismiss-one', source: { surface: 'console', reference: 'personal' } })
    const next = t.assistance.suggest(OWNER, [first, second])!
    expect(next).toBeDefined(); expect(next.todoId).not.toBe(offer.todoId)
  })

  it('starts and updates the same personal state without sending or constructing a card', async () => {
    const t = fixture(); await t.grant()
    const app = new PersonalApplication({ ...t.deps, authorizeUrl: () => 'https://example.test/authorize' })
    app.changeSettings(OWNER, { operation: 'start', revision: app.settings(OWNER).revision })
    expect(t.collection.profile(OWNER)?.enabled).toBe(true)
    expect(app.brief(OWNER)?.enabled).toBe(true)
    const todo = t.add(), version = app.itemVersion(OWNER, todo)
    expect(app.query(OWNER, 'active').items.map(item => item.id)).toEqual([todo.id])
    expect(app.query('ou_other', 'active').items).toEqual([])
    expect(() => app.updateItem('ou_other', { id: todo.id, version, operation: 'done' })).toThrow('不可用')
    expect(() => app.updateItem(OWNER, { id: todo.id, version: undefined as any, operation: 'done' })).toThrow('已更新')
    app.updateItem(OWNER, { id: todo.id, version, operation: 'done' })
    expect(() => app.updateItem(OWNER, { id: todo.id, version, operation: 'ignore' })).toThrow('已更新')
    const restarted = new PersonalApplication({ ...t.deps, authorizeUrl: () => 'https://example.test/authorize' })
    expect(restarted.query(OWNER, 'active').items).toEqual([])
    expect(restarted.query(OWNER, 'closed').items.map(item => item.id)).toEqual([todo.id])
    expect(t.registry.getKv(`personal-work-manual:${OWNER}:${todo.id}`)).toBe('true')
    expect(t.feishu.sendToUserOnce).not.toHaveBeenCalled()
    expect(t.feishu.patchCard).not.toHaveBeenCalled()
  })

  it('shares source exclusions and snooze state with the existing Feishu adapter', async () => {
    const t = fixture(); await t.start(); const todo = t.collect(), app = t.setup.application
    app.updateItem(OWNER, { id: todo.id, version: app.itemVersion(OWNER, todo), operation: 'hour' })
    expect(app.query(OWNER, 'active').items).toEqual([])
    expect(app.query(OWNER, 'later').items.map(item => item.id)).toEqual([todo.id])
    expect(t.setup.snoozedUntil(OWNER, todo.id)).toBe(NOW + 3600_000)
    expect(t.todos.get(todo.id)?.dueMs).toBe(todo.dueMs)
    t.readScope.exclude(OWNER, 'oc_product')
    expect(app.query(OWNER, 'later').items).toEqual([])
    expect(() => app.updateItem(OWNER, { id: todo.id, version: app.itemVersion(OWNER, todo), operation: 'undo' })).toThrow('不可用')
  })

  it('keeps one accepted Work when retried from another trusted entry, and keeps the original todo open', async () => {
    const t = fixture(); await t.start(); const todo = t.collect()
    const offer = t.assistance.suggest(OWNER, [todo])!, sent = t.deliveries.length
    const task = t.assistance.decide({ id: offer.id, version: offer.version, actorId: OWNER, requestId: 'console-request-1',
      source: { surface: 'console', reference: 'console-session-1' }, decision: 'start' })!
    const again = t.assistance.decide({ id: offer.id, version: offer.version, actorId: OWNER, requestId: 'desktop-request-2',
      source: { surface: 'desktop', reference: 'paired-device-session-1' }, decision: 'start' })!
    expect(again.id).toBe(task.id)
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM tasks').get()?.n).toBe(1)
    expect(t.registry.taskWork.get(task.id)?.rootTaskId).toBe(task.id)
    expect(t.assistance.get(offer.id)?.acceptance).toMatchObject({ actorId: OWNER, requestId: 'console-request-1', source: { surface: 'console' } })
    expect(() => t.assistance.assertTask(task.id)).not.toThrow()
    expect(validPersonalAssistanceDispatch(t.registry.db, task.id, t.registry.dispatches.get(task.id)!.inbound)).toBe(true)
    expect(t.todos.get(todo.id)?.status).toBe('open')
    expect(t.deliveries).toHaveLength(sent)
  })

  it('recovers deployed card acceptances without rewriting them, and keeps new card records readable by the old host', async () => {
    const t = fixture(); await t.start(); const todo = t.collect()
    const id = await t.setup.show(OWNER, 'tasks'), action = behavior(t.deliveries.at(-1)!.card, 'assist')
    t.click(id, action)
    const read = () => String(t.registry.db.prepare('SELECT record FROM personal_assistance WHERE id=?').get(action.offer)?.record)
    const stored = JSON.parse(read()), task = t.registry.getTask(stored.taskId)!
    expect(stored).toMatchObject({ chatId: 'oc_friday', cardMessageId: id })
    delete stored.target; delete stored.acceptance
    const legacy = JSON.stringify(stored)
    t.registry.db.prepare('UPDATE personal_assistance SET record=? WHERE id=?').run(legacy, action.offer)
    expect(t.assistance.get(action.offer)).toMatchObject({ target: { scope: t.audience.scope, conversationId: 'oc_friday' },
      acceptance: { actorId: OWNER, source: { surface: 'feishu', reference: id } } })
    expect(t.assistance.suggest(OWNER, [todo])?.taskId).toBe(task.id)
    expect(() => t.assistance.assertTask(task.id)).not.toThrow()
    expect(validPersonalAssistanceDispatch(t.registry.db, task.id, t.registry.dispatches.get(task.id)!.inbound)).toBe(true)
    const again = t.assistance.decide({ id: action.offer, version: stored.version, actorId: OWNER, requestId: 'console-retry',
      source: { surface: 'console', reference: 'console-session' }, decision: 'start' })!
    expect(again.id).toBe(task.id)
    expect(read()).toBe(legacy)
  })

  it('still checks the actor and current source access for acceptance outside Feishu', async () => {
    const t = fixture(); await t.start(); const todo = t.collect(), offer = t.assistance.suggest(OWNER, [todo])!
    const request = { id: offer.id, version: offer.version, actorId: OWNER, requestId: 'console-request',
      source: { surface: 'console' as const, reference: 'console-session' }, decision: 'start' as const }
    expect(() => t.assistance.decide({ ...request, actorId: 'ou_other' })).toThrow()
    t.readScope.exclude(OWNER, 'oc_product')
    expect(() => t.assistance.decide(request)).toThrow('读取范围')
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM tasks').get()?.n).toBe(0)
  })
})

describe('personal start and authorization', () => {
  it('recommends two features in one card without enabling before consent; matching OAuth starts both', async () => {
    const t = fixture(), id = await t.setup.show(OWNER, 'setup'), body = t.deliveries[0]!.card
    expect(all(body).filter(node => node.tag === 'checker').map(node => node.checked)).toEqual([true, true])
    expect(JSON.stringify(body)).toContain('连接飞书并开启')
    expect(t.collection.readyOwners()).toEqual([])
    expect(t.routines.listFor({ chatId: '', chatType: 'p2p', ownerOpenId: OWNER })).toHaveLength(0)
    const intent = t.setup.settings(OWNER).awaiting!
    await t.grant(intent.state)
    expect(await t.setup.authorizationCompleted(OWNER)).toBe(true)
    expect(t.collection.profile(OWNER)?.enabled).toBe(true)
    const brief = t.routines.listFor({ chatId: '', chatType: 'p2p', ownerOpenId: OWNER })[0]!
    expect(brief).toMatchObject({ enabled: true, runAs: OWNER, spaceId: `sp_dm_${OWNER}`, deliverTo: 'dm', schedule: { type: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] } })
    expect(t.setup.isReadOnlyRoutine(brief.id)).toBe(true)
    expect(t.feishu.patchCard).toHaveBeenCalledWith(id, expect.anything())
    expect(t.setup.authorizationPresented(OWNER)).toBe(true)
    const version = t.collection.profile(OWNER)?.revision
    await t.setup.authorizationCompleted(OWNER)
    expect(t.collection.profile(OWNER)?.revision).toBe(version)
    expect(t.deliveries).toHaveLength(1)
    expect(t.routines.listFor({ chatId: '', chatType: 'p2p', ownerOpenId: OWNER })).toHaveLength(1)
  })

  it('old selection OAuth and unrelated authorization do not opt the person in', async () => {
    const t = fixture(), id = await t.setup.show(OWNER, 'setup'), old = t.setup.settings(OWNER).awaiting!.state
    // OAuth exchange finishes first, but its host completion arrives after the person changes their selection.
    await t.grant(old)
    t.click(id, behavior(t.deliveries[0]!.card, 'select', { feature: 'brief' }), { tag: 'checker', checked: false })
    expect(await t.setup.authorizationCompleted(OWNER)).toBe(false)
    expect(t.collection.profile(OWNER)).toBeUndefined()
    await t.grant()
    expect(await t.setup.authorizationCompleted(OWNER)).toBe(false)
  })

  it('already connected starts without another OAuth; turning collection off persists silently across restart', async () => {
    const t = fixture(), id = await t.start()
    const body = t.setup.setupCard(OWNER)
    expect(JSON.stringify(body)).not.toContain('open_url')
    const result = t.click(id, behavior(body, 'select', { feature: 'collection' }), { tag: 'checker', checked: false })
    expect(result.toast).toBeUndefined()
    expect(t.collection.profile(OWNER)?.enabled).toBe(false)
    expect(t.deliveries).toHaveLength(1)
    const restarted = new PersonalOnboarding(t.deps)
    expect(restarted.settings(OWNER)).toMatchObject({ started: true, collection: false, brief: true })
    await t.grant()
    await restarted.authorizationCompleted(OWNER)
    expect(t.collection.profile(OWNER)?.enabled).toBe(false)
    const resume = t.click(id, behavior(restarted.setupCard(OWNER), 'select', { feature: 'collection' }), { tag: 'checker', checked: true })
    expect(resume.toast).toBeUndefined()
    expect(t.collection.profile(OWNER)?.enabled).toBe(true)
  })

  it('partial grants report waiting and do not pretend collection or briefing is enabled', async () => {
    const t = fixture(); await t.setup.show(OWNER, 'setup')
    await t.grant(t.setup.settings(OWNER).awaiting!.state, ['search:message'])
    await t.setup.authorizationCompleted(OWNER)
    expect(t.collection.profile(OWNER)?.enabled).not.toBe(true)
    expect(t.routines.listFor({ chatId: '', chatType: 'p2p', ownerOpenId: OWNER })).toHaveLength(0)
    expect(JSON.stringify(t.setup.setupCard(OWNER))).toContain('等待所需授权')
  })

  it('changing collection does not resume a briefing paused through another entry', async () => {
    const t = fixture(), id = await t.start()
    const briefId = Number(t.registry.getKv(`personal-brief:${OWNER}`))
    t.deps.controls.persistControl(briefId, 'pause', { expectedConfigVersion: t.routines.configVersion(briefId) }).afterCommit()
    t.click(id, behavior(t.setup.setupCard(OWNER), 'select', { feature: 'collection' }), { tag: 'checker', checked: false })
    expect(t.routines.get(briefId)?.enabled).toBe(false)
  })

  it('authenticates actor, original message, actual DM, and current selection revision', async () => {
    const t = fixture(), id = await t.start(), value = behavior(t.setup.setupCard(OWNER), 'select', { feature: 'collection' })
    for (const override of [{ operatorOpenId: 'ou_other' }, { operatorOpenId: 'ou_admin' }, { chatId: 'oc_shared_group' }, { messageId: 'om_forwarded' }]) {
      expect(t.click(id, value, { tag: 'checker', checked: false, ...override }).toast).toBeDefined()
    }
    expect(t.collection.profile(OWNER)?.enabled).toBe(true)
    t.click(id, value, { tag: 'checker', checked: false })
    expect(t.click(id, value, { tag: 'checker', checked: true }).toast).toBeDefined()
    expect(t.collection.profile(OWNER)?.enabled).toBe(false)
    t.spaces.suspend(`sp_dm_${OWNER}`)
    expect(t.click(id, value, { tag: 'checker', checked: true }).toast).toBeDefined()
  })

  it('delivery failure cannot bind a card or claim it arrived', async () => {
    const t = fixture(); t.feishu.sendToUserOnce.mockResolvedValueOnce('')
    await expect(t.setup.show(OWNER, 'setup')).rejects.toThrow('送达回执')
    expect(t.registry.getKv(`personal-setup-message:${OWNER}`)).toBeUndefined()
  })
})

describe('a concrete useful offer from observed personal work', () => {
  it('withholds PR offers until current facts exist, and rejects an old click after the head changes', async () => {
    const t = fixture(true); await t.start(); t.collect()
    const fresh = t.prState()
    t.prState.mockReturnValue(undefined)
    await t.setup.show(OWNER, 'tasks')
    expect(JSON.stringify(t.deliveries.at(-1)!.card)).not.toContain('梳理评审要点')
    t.prState.mockReturnValue(fresh)
    const id = await t.setup.show(OWNER, 'tasks'), action = behavior(t.deliveries.at(-1)!.card, 'assist')
    t.prState.mockReturnValue({ ...fresh!, head: 'b'.repeat(40) })
    expect(t.click(id, action).toast).toBeDefined()
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM tasks').get()?.n).toBe(0)
  })
  it('updates a completed PR preparation in the same Work after a new commit, with duplicate clicks still idempotent', async () => {
    const t = fixture(true); await t.start(); t.collect()
    const id = await t.setup.show(OWNER, 'tasks'), first = behavior(t.deliveries.at(-1)!.card, 'assist')
    t.click(id, first)
    const prior = t.assistance.get(String(first.offer))!.taskId!
    t.registry.updateTask(prior, { status: 'done' })
    t.prState.mockReturnValue({ ...t.prState()!, head: 'b'.repeat(40) })
    const next = await t.setup.show(OWNER, 'tasks'), second = behavior(t.deliveries.at(-1)!.card, 'assist')
    expect(second.offer).not.toBe(first.offer)
    expect(JSON.stringify(t.deliveries.at(-1)!.card)).toContain('更新评审要点')
    expect(t.click(next, second).toast).toBeUndefined()
    expect(t.click(next, second).toast).toBeUndefined()
    const updated = t.assistance.get(String(second.offer))!.taskId!
    expect(t.registry.taskWork.get(updated)?.rootTaskId).toBe(prior)
    expect(t.registry.getTask(updated)?.sessionKey).toBe(t.registry.getTask(prior)?.sessionKey)
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM tasks').get()?.n).toBe(2)
  })
  it('accepts a sourced PR preparation once, preserving a durable Work across cards and restart; does not complete the original todo', async () => {
    const t = fixture(); await t.start(); const todo = t.collect()
    const id = await t.setup.show(OWNER, 'tasks'), original = t.deliveries.at(-1)!.card, action = behavior(original, 'assist')
    expect(JSON.stringify(original)).toContain('梳理评审要点')
    expect(JSON.stringify(original)).toContain('先核对 PR 的当前状态')
    expect(t.click(id, action).toast).toBeUndefined()
    const accepted = t.assistance.get(String(action.offer))!, task = t.registry.getTask(accepted.taskId!)!
    expect(task.status).toBe('queued')
    expect(t.registry.taskWork.get(task.id)?.rootTaskId).toBe(task.id)
    expect(t.registry.dispatches.get(task.id)?.inbound.senderType).toBe('app')
    expect(validPersonalAssistanceDispatch(t.registry.db, task.id, t.registry.dispatches.get(task.id)!.inbound)).toBe(true)
    expect(task.prompt).toContain('原消息和相关材料核对现状')
    expect(task.prompt).toContain('https://github.com/team/repo/pull/41')
    expect(task.prompt).toContain('不评论、批准、合并 PR')
    expect(t.todos.get(todo.id)?.status).toBe('open')
    expect(t.click(id, action).toast).toBeUndefined()
    const restarted = new PersonalOnboarding(t.deps), second = await restarted.show(OWNER, 'tasks')
    const again = restarted.handle({ messageId: second, chatId: 'oc_friday', operatorOpenId: OWNER, value: action, raw: {} })
    expect(again.toast).toBeUndefined()
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM tasks').get()?.n).toBe(1)
    expect(t.assistance.get(String(action.offer))?.taskId).toBe(task.id)
  })

  it('a suggestion dismissal leaves the task open, survives refresh, and does not immediately pitch another task', async () => {
    const t = fixture(); await t.start(); const todo = t.collect()
    const id = await t.setup.show(OWNER, 'tasks'), action = behavior(t.deliveries.at(-1)!.card, 'assist_dismiss')
    const result = t.click(id, action)
    expect(result.toast).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('梳理评审要点')
    expect(t.todos.get(todo.id)?.status).toBe('open')
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM tasks').get()?.n).toBe(0)
    await new PersonalOnboarding(t.deps).show(OWNER, 'tasks')
    expect(JSON.stringify(t.deliveries.at(-1)!.card)).not.toContain('梳理评审要点')
  })

  it.each(['other_person', 'changed', 'completed', 'excluded', 'snoozed'])('does not accept a stale or unauthorized offer: %s', async mode => {
    const t = fixture(); await t.start(); const todo = t.collect()
    const id = await t.setup.show(OWNER, 'tasks'), body = t.deliveries.at(-1)!.card, action = behavior(body, 'assist')
    if (mode === 'changed') t.todos.update(todo.id, t.audience.scope, { title: '请先暂停' })
    if (mode === 'completed') t.click(id, behavior(body, 'done'))
    if (mode === 'excluded') t.readScope.exclude(OWNER, 'oc_product')
    if (mode === 'snoozed') t.click(id, behavior(t.click(id, behavior(body, 'snooze_menu')), 'hour'))
    const result = t.click(id, action, mode === 'other_person' ? { operatorOpenId: 'ou_other' } : {})
    expect(result.toast).toBeDefined()
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM tasks').get()?.n).toBe(0)
  })

  it('does not infer a PR URL or pick an uncertain task; supports a concrete reply draft beyond PRs', async () => {
    const t = fixture(); await t.start()
    t.collect('@owner 供参考，可能需要 review PR #41', 'todo', 'uncertain')
    await t.setup.show(OWNER, 'tasks')
    expect(JSON.stringify(t.deliveries.at(-1)!.card)).not.toContain('梳理评审要点')
    t.collect('@owner 发布方案选 A 还是 B？', 'reply')
    const id = await t.setup.show(OWNER, 'tasks'), body = t.deliveries.at(-1)!.card
    expect(JSON.stringify(body)).toContain('起草回复')
    expect(t.click(id, behavior(body, 'assist')).toast).toBeUndefined()
    const prompt = t.registry.db.prepare('SELECT prompt FROM tasks').get()?.prompt
    expect(prompt).toContain('需要用户决定的内容用占位说明')
  })
})

describe('personal task actions and first results', () => {
  it('puts source-backed PR and Issue links in checklist titles and assistance, outside collapsed details', async () => {
    const t = fixture(); await t.start()
    const pr = t.collect()
    t.todos.update(pr.id, t.audience.scope, { title: '评审独立定时任务 PR #41' })
    const issue = t.collect('@owner 请处理 https://github.com/team/repo/issues/42')
    t.todos.update(issue.id, t.audience.scope, { title: '处理登录问题 #42' })
    t.add('确认 PR #99')
    await t.setup.show(OWNER, 'tasks')
    const body = t.deliveries.at(-1)!.card as any
    const checks = body.body.elements.filter((node: any) => node.tag === 'checker')
    expect(checks.find((node: any) => node.name === `todo_${pr.id}`)).toMatchObject({ overall_checkable: false,
      text: { tag: 'lark_md', content: '评审独立定时任务 [PR #41](https://github.com/team/repo/pull/41)' } })
    expect(checks.find((node: any) => node.name === `todo_${issue.id}`).text.content)
      .toBe('处理登录问题 [#42](https://github.com/team/repo/issues/42)')
    expect(checks.find((node: any) => node.text.content.includes('#99')).text.content).toBe('确认 PR #99')
    expect(body.body.elements.some((node: any) => node.tag === 'markdown' && node.content.includes('可以先帮你推进这件事') &&
      node.content.includes('[PR #41](https://github.com/team/repo/pull/41)'))).toBe(true)
  })

  it('does not guess the repository for ambiguous titles and escapes title formatting', async () => {
    const t = fixture(); await t.start()
    const ambiguous = t.collect('@owner 对照 https://github.com/team/repo/pull/41 和 https://github.com/other/repo/pull/41')
    t.todos.update(ambiguous.id, t.audience.scope, { title: '确认 PR #41' })
    const unique = t.collect()
    t.todos.update(unique.id, t.audience.scope, { title: '评审 [恶意](https://example.test) <at id=all>' })
    await t.setup.show(OWNER, 'tasks')
    const checks = all(t.deliveries.at(-1)!.card).filter(node => node.tag === 'checker')
    expect(checks.find(node => node.name === `todo_${ambiguous.id}`)?.text.content).toBe('确认 PR #41')
    expect(checks.find(node => node.name === `todo_${unique.id}`)?.text.content).toBe('评审 \\[恶意\\]\\(https://example.test\\) ＜at id=all＞')
  })

  it('renders paged native actions, completes silently, and can undo on the same card', async () => {
    const t = fixture(); await t.start()
    for (let i = 0; i < 8; i++) t.add(`确认文案 ${i}`)
    const id = await t.setup.show(OWNER, 'tasks'), body = t.deliveries.at(-1)!.card
    expect(measureTodoCard(body as any).fits).toBe(true)
    expect(all(body).filter(node => node.tag === 'checker')).toHaveLength(5)
    expect(all(body).filter(node => node.tag === 'button' && node.text?.content === '完成')).toHaveLength(0)
    expect(all(body).filter(node => node.tag === 'collapsible_panel').every(node => node.expanded === false)).toBe(true)
    const action = behavior(body, 'done'), done = t.click(id, action, { tag: 'checker', checked: true })
    expect(done.toast).toBeUndefined()
    expect(t.todos.get(action.id)?.status).toBe('done')
    const undone = t.click(id, behavior(done, 'undo'))
    expect(undone.toast).toBeUndefined()
    expect(t.todos.get(action.id)?.status).toBe('open')
    expect(t.deliveries).toHaveLength(2)
    expect(t.click(id, behavior(undone, 'page')).toast).toBeUndefined()
  })

  it('snooze changes display time, not the real deadline; expires and supports undo', async () => {
    const t = fixture(); await t.start(); const todo = t.add()
    const id = await t.setup.show(OWNER, 'tasks')
    const expanded = t.click(id, behavior(t.deliveries.at(-1)!.card, 'snooze_menu'))
    const snoozed = t.click(id, behavior(expanded, 'hour'))
    expect(snoozed.toast).toBeUndefined()
    expect(t.setup.snoozedUntil(OWNER, todo.id)).toBe(NOW + 3600_000)
    expect(t.todos.get(todo.id)?.dueMs).toBe(todo.dueMs)
    expect(all(snoozed).filter(node => node.value?.op === 'done')).toHaveLength(0)
    const undone = t.click(id, behavior(snoozed, 'undo'))
    expect(undone.toast).toBeUndefined()
    expect(t.setup.snoozedUntil(OWNER, todo.id)).toBe(0)
    const expandedAgain = t.click(id, behavior(undone, 'snooze_menu'))
    const later = t.click(id, behavior(expandedAgain, 'tomorrow'))
    expect(t.setup.snoozedUntil(OWNER, todo.id)).toBe(Date.parse('2026-10-01T01:00:00Z'))
    t.clock.now = Date.parse('2026-10-01T01:01:00Z')
    const refreshed = t.click(id, behavior(later, 'view', { view: 'active' }))
    expect(all(refreshed).filter(node => node.value?.op === 'done')).toHaveLength(1)
  })

  it('rejects a stale task action after an edit; another person cannot inspect task content', async () => {
    const t = fixture(); await t.start(); const todo = t.add('owner-only private task')
    const id = await t.setup.show(OWNER, 'tasks'), action = behavior(t.deliveries.at(-1)!.card, 'done')
    t.application.update(todo.id, t.audience, { current: true, patch: { title: '更新后的任务' } }, OWNER)
    expect(t.click(id, action).toast).toBeDefined()
    expect(t.todos.get(todo.id)?.status).toBe('open')
    const denied = t.click(id, action, { operatorOpenId: 'ou_other', chatId: 'oc_other_dm' })
    expect(denied.card).toBeUndefined()
    expect(JSON.stringify(denied)).not.toContain('更新后的任务')
  })

  it('does not let a missing card version bypass the current-item check', async () => {
    const t = fixture(); await t.start(); const todo = t.add()
    const id = await t.setup.show(OWNER, 'tasks'), action = behavior(t.deliveries.at(-1)!.card, 'done')
    for (const op of ['done', 'ignore', 'hour', 'snooze_menu']) {
      const response = t.click(id, { ...action, op, version: undefined })
      expect(response.toast).toBeDefined()
    }
    expect(t.todos.get(todo.id)?.status).toBe('open')
    expect(t.setup.snoozedUntil(OWNER, todo.id)).toBe(0)
  })

  it('shows collection attribution/source; ignoring persists a terminal item and source exclusions hide it', async () => {
    const t = fixture(); await t.start()
    const message = { metadata: { messageId: 'om_source', chatId: 'oc_product', chatType: 'group' as const, senderOpenId: 'ou_requester',
      msgType: 'text', createTimeMs: NOW - 10_000, link: { status: 'available' as const, url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_product&position=20' } },
      text: '@owner 请确认发布文案', mentions: [OWNER], senderName: 'requester' }
    const decision = { messageId: 'om_source', quote: message.text, existingId: null, kind: 'reply' as const, relationship: 'requested' as const,
      title: '确认发布文案', dueMs: null, operation: 'record' as const }
    t.collection.commit({ profile: t.collection.profile(OWNER)!, cursor: t.collection.next(OWNER)!, audience: t.audience,
      messages: [message], decisions: [decision], candidates: [], assertCurrent() {} })
    const id = await t.setup.show(OWNER, 'tasks'), body = t.deliveries.at(-1)!.card
    const visible = (body as any).body.elements.filter((element: any) => element.tag === 'markdown').map((element: any) => element.content).join('\n')
    expect(visible).toContain('requester · 群聊')
    expect(visible).toContain('@owner 请确认发布文案')
    expect(visible).toContain('[原消息](https://applink.feishu.cn/client/chat/open?openChatId=oc_product&position=20)')
    expect(JSON.stringify(body)).not.toContain('对方请你处理')
    expect(JSON.stringify(body)).toContain('position=20')
    expect(JSON.stringify(body)).not.toContain('待确认')
    const ignored = t.click(id, behavior(body, 'ignore'))
    expect(ignored.toast).toBeUndefined()
    expect(t.todos.listForAudience(t.audience, { status: 'all' }).items[0]).toMatchObject({ status: 'cancelled', statusNote: '本人忽略' })
    t.readScope.exclude(OWNER, 'oc_product')
    const denied = t.click(id, behavior(ignored, 'undo'))
    expect(denied.toast).toBeDefined()
    expect(JSON.stringify(denied.card)).not.toContain('position=20')
    expect(t.collection.candidates(OWNER)[0]?.status).toBe('cancelled')
  })

  it('initial delivery retries with the same UUID and then patches without duplicate messages', async () => {
    const t = fixture(); await t.start(); t.add()
    t.feishu.sendToUserOnce.mockRejectedValueOnce(new Error('unknown send result'))
    await expect(t.setup.collectionProgress(OWNER)).rejects.toThrow('unknown')
    const uuid = t.feishu.sendToUserOnce.mock.calls.at(-1)![2]
    await new PersonalOnboarding(t.deps).collectionProgress(OWNER)
    expect(t.feishu.sendToUserOnce.mock.calls.at(-1)![2]).toBe(uuid)
    const sent = t.deliveries.length
    await t.setup.collectionProgress(OWNER)
    expect(t.deliveries).toHaveLength(sent)
    expect(t.feishu.patchCard.mock.calls.filter(call => call[0] === t.deliveries.at(-1)!.messageId)).toHaveLength(0)
    t.add('新出现的事项')
    await t.setup.collectionProgress(OWNER)
    expect(t.feishu.patchCard).toHaveBeenCalledWith(t.deliveries.at(-1)!.messageId, expect.anything())
  })

  it('does not replay an unknown initial delivery outside Feishu deduplication window', async () => {
    const t = fixture(); await t.start(); t.add()
    t.feishu.sendToUserOnce.mockRejectedValueOnce(new Error('timeout'))
    await expect(t.setup.collectionProgress(OWNER)).rejects.toThrow('timeout')
    const calls = t.feishu.sendToUserOnce.mock.calls.length
    t.clock.now += 61 * 60_000
    await t.setup.collectionProgress(OWNER)
    expect(t.feishu.sendToUserOnce).toHaveBeenCalledTimes(calls)
  })

  it('keeps a failing lane visible even after the other lane succeeds; range restore keeps source receipts', () => {
    const t = fixture(); t.collection.configure(OWNER, true)
    t.collection.fail(t.collection.profile(OWNER)!, t.collection.next(OWNER)!, 'needs_connection')
    expect(t.collection.next(OWNER)?.lane).toBe('p2p')
    t.collection.commit({ profile: t.collection.profile(OWNER)!, cursor: t.collection.next(OWNER)!, audience: t.audience,
      messages: [], decisions: [], candidates: [], assertCurrent() {} })
    expect(t.collection.progress(OWNER).state).toBe('needs_connection')
    t.collection.recheckRange(OWNER)
    expect(t.collection.progress(OWNER).state).toBe('today')
    expect(t.collection.next(OWNER)?.startSec).toBe(Date.parse('2026-09-29T16:00:00Z') / 1000)
  })
})
