import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsoleAuth } from '../src/web/console-auth.js'
import { createConsoleRouter } from '../src/web/console-router.js'
import { ConsoleQueries } from '../src/core/console-queries.js'
import { ConsoleCommands } from '../src/core/console-commands.js'
import { ConsoleOperations } from '../src/core/console-operations.js'
import { HumanSpaceAccess } from '../src/core/human-space-access.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Todos } from '../src/core/todos.js'
import { TodoApplication, todoTag } from '../src/core/todo-application.js'
import { SpaceApplication, presentationTag } from '../src/core/space-application.js'
import { RoutineStore } from '../src/core/routines.js'
import { RoutineApplication } from '../src/core/routine-application.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { SkillProposals } from '../src/core/skills.js'
import { DeliveryService } from '../src/core/delivery.js'
import { routineExecutionKey, routineDigestDeliveryKey } from '../src/core/execution-keys.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { spaceScope } from '../src/core/space.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createInternalApi } from '../src/internal/api.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

async function fixture() {
  const registry = new Registry(':memory:'); cleanups.push(() => registry.close())
  const sp = spaceDeps(registry.db)
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'group', openId: 'alice' })
  sp.spaces.addMember(group.id, 'bob', 'member')
  const other = sp.spaces.ensure({ kind: 'group', chatId: 'other', openId: 'bob' })
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'dm-bob', openId: 'bob' })
  const feishu = asFeishuClient(new FakeFeishu()), log = createLogger('console-command-test', 'error')
  const members = vi.spyOn(feishu, 'chatMemberOpenIds').mockResolvedValue(new Set(['alice', 'bob']))
  const auth = new ConsoleAuth({ db: registry.db, appId: 'app', domain: 'feishu', baseUrl: 'https://console.test', tenantKeys: ['tenant'],
    provider: { exchangeCode: async () => ({ accessToken: 'synthetic' }), whoAmI: async () => ({ openId: 'alice', tenantKey: 'tenant' }) } })
  const login = (openId: string) => {
    const credentials = auth.sessions.create({ appId: 'app', tenantKey: 'tenant', openId, name: openId })
    return { ...credentials, headers: { cookie: `${auth.sessionCookieName}=${credentials.token}`, origin: 'https://console.test',
      'content-type': 'application/json', 'x-csrf-token': auth.sessions.csrfFor(credentials.actor)! } }
  }
  const alice = login('alice'), bob = login('bob')
  const access = new HumanSpaceAccess({ ...sp, feishu, assertActor: actor => auth.assertCurrent(actor) })
  const memory = new ChannelMemory(registry.db), todos = new Todos(registry.db), routines = new RoutineStore(registry.db)
  const attempts = new RunAttempts(registry.db), skills = new SkillProposals(registry.db, new Set())
  const activeRuns = new Map<number, { runId: string; abort: AbortController }[]>()
  const userTokens = new UserTokenStore(registry.db, { exchangeCode: async () => ({ accessToken: 'synthetic-delegation', expiresIn: 7200 }),
    refresh: async () => { throw new Error('No external OAuth refresh in this fixture') } })
  const routineApp = new RoutineApplication({ registry, spaces: sp.spaces, routines, attempts, userTokens,
    activeRuns: id => activeRuns.get(id) ?? [], now: Date.now })
  new DeliveryService(registry.db, { ...sp, resolveContext: async () => undefined, send: async () => { throw new Error('No external sends') } })
  const operations = new ConsoleOperations(registry.db, { sessions: auth.sessions })
  const commands = new ConsoleCommands({ access, operations, spaces: sp.spaces, routines, todos,
    spaceApplication: new SpaceApplication({ db: registry.db, spaces: sp.spaces }),
    todoApplication: new TodoApplication({ db: registry.db, todos }), persistRoutineControl: routineApp.persistControl.bind(routineApp),
    // Exact live Run cancellation has its own real Orchestrator suite; these HTTP cases exercise real routine cancellation.
    assertHumanRunTarget: () => { throw new Error('Unexpected Run command in this fixture') },
    persistHumanRunStop: () => { throw new Error('Unexpected Run command in this fixture') },
    assertHumanWorkTarget: () => { throw new Error('Unexpected work command in this fixture') },
    persistHumanWorkCancel: () => { throw new Error('Unexpected work command in this fixture') },
    persistHumanWorkResume: () => { throw new Error('Unexpected work command in this fixture') } })
  const queries = new ConsoleQueries({ access, registry, memory, todos, routines, skills, defaults: { brevity: 'normal', reflect: true } })
  const cache = new MessageCache(registry.db), tokens = new TokenIssuer('synthetic-test')
  const api = createInternalApi({ ...sp, registry, memory, todos, routines, feishu, messageCache: cache,
    messages: new MessageService(feishu, cache, log), tokens, log, maxHistoryPerCall: 100,
    consoleRouter: createConsoleRouter(auth, queries, commands) })
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening')
  cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())) })
  const base = `http://127.0.0.1:${(api.server.address() as { port: number }).port}`
  const path = (spaceId = group.id) => `/console/api/spaces/${encodeURIComponent(spaceId)}/operations`
  const post = (body: unknown, options: { spaceId?: string; headers?: Record<string, string>; as?: typeof alice } = {}) =>
    fetch(base + path(options.spaceId), { method: 'POST', headers: { ...(options.as ?? alice).headers, ...options.headers }, body: JSON.stringify(body) })
  const addRoutine = (schedule: Parameters<RoutineStore['add']>[0]['schedule'] = { type: 'interval', everyMinutes: 10 }) =>
    routines.add({ kind: 'schedule', ownerOpenId: 'bob', spaceId: group.id, chatId: 'group', chatType: 'group',
      name: 'Synthetic reminder', prompt: 'Synthetic task', schedule, now: Date.now() })
  const routineCommand = (r: { id: number }, operation: 'routine.pause' | 'routine.resume' = 'routine.pause', requestId = 'routine_request_0001') =>
    ({ operation, requestId, id: r.id, expectedConfigVersion: routines.configVersion(r.id)! })
  const preferenceCommand = (requestId = 'settings_request_001') => ({ operation: 'space.presentation', requestId,
    expectedTag: presentationTag(sp.spaces.get(group.id)!), patch: { brevity: 'short', ack: 'none' } })
  const operationRows = () => registry.db.prepare('SELECT * FROM console_operations ORDER BY created_at,id').all()
  const business = () => ['space_rooms', 'routines', 'routine_occurrences', 'run_attempts', 'todos', 'deliveries', 'console_operations']
    .map(table => registry.db.prepare(`SELECT * FROM ${table}`).all())
  return { ...sp, registry, group, other, dm, auth, alice, bob, members, commands, operations, routines, routineApp, attempts, activeRuns,
    todos, userTokens, base, path, post, addRoutine, routineCommand, preferenceCommand, operationRows, business }
}

describe('console command integration over real HTTP and shared domain applications', () => {
  it.each(['中文标题', '🚀进度'])('preserves UTF-8 across HTTP body chunks: %s', async title => {
    const t = await fixture(), todo = t.todos.add({ scope: spaceScope(t.group.id), title: 'Original title' })
    const entered = deferred<void>(), requireMutation = t.auth.requireMutation.bind(t.auth)
    vi.spyOn(t.auth, 'requireMutation').mockImplementation((req, actor) => {
      requireMutation(req, actor)
      // Observe the first body chunk only after authentication; do not consume the stream ahead of the router.
      req.once('data', () => entered.resolve())
    })
    const bytes = Buffer.from(JSON.stringify({ operation: 'todo.update', requestId: 'utf8_chunk_request_001',
      id: todo.id, expectedTag: todoTag(todo), patch: { title } }))
    const cut = bytes.indexOf(Buffer.from(title)) + 1
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(t.base + t.path(), { method: 'POST', headers: t.alice.headers }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode!, body }))
      })
      req.on('error', reject)
      req.write(bytes.subarray(0, cut))
      void entered.promise.then(() => req.end(bytes.subarray(cut)))
    })
    expect(response.status).toBe(200)
    expect(t.todos.get(todo.id)?.title).toBe(title)
    expect(JSON.parse(response.body)).toMatchObject({ appliedResult: { changed: true }, replayed: false })
    expect(t.operationRows()).toHaveLength(1)
  })

  it.each([16_384, 16_385])('enforces the HTTP body limit in bytes, including UTF-8: %i bytes', async byteLength => {
    const t = await fixture(), todo = t.todos.add({ scope: spaceScope(t.group.id), title: 'Original title' })
    const json = JSON.stringify({ operation: 'todo.update', requestId: 'utf8_limit_request_001',
      id: todo.id, expectedTag: todoTag(todo), patch: { title: '中文🚀' } })
    const body = json + ' '.repeat(byteLength - Buffer.byteLength(json))
    expect(Buffer.byteLength(body)).toBe(byteLength)
    expect(body.length).toBeLessThan(byteLength)
    const response = await fetch(t.base + t.path(), { method: 'POST', headers: t.alice.headers, body })
    expect(response.status).toBe(byteLength === 16_384 ? 200 : 413)
    expect(t.todos.get(todo.id)?.title).toBe(byteLength === 16_384 ? '中文🚀' : 'Original title')
    expect(t.operationRows()).toHaveLength(byteLength === 16_384 ? 1 : 0)
  })

  it('does not accept an Agent bearer token or browser cookie at the other identity boundary', async () => {
    const t = await fixture(), command = t.preferenceCommand(), before = t.business()
    const response = await fetch(t.base + t.path(), { method: 'POST', headers: { authorization: 'Bearer worker-token',
      origin: 'https://console.test', 'content-type': 'application/json' }, body: JSON.stringify(command) })
    expect(response.status).toBe(401)
    expect((await fetch(t.base + '/v1/todo/list', { method: 'POST', headers: t.alice.headers, body: '{}' })).status).toBe(401)
    expect(t.business()).toEqual(before)
  })

  it.each([{ origin: 'https://attacker.test' }, { 'x-csrf-token': 'wrong' }, { 'content-type': 'text/plain' }])('rejects invalid mutation headers before any domain work: %j', async headers => {
    const t = await fixture(), before = t.business()
    expect((await t.post(t.preferenceCommand(), { headers })).status).toBe(403)
    expect(t.members).not.toHaveBeenCalled(); expect(t.business()).toEqual(before)
  })

  it('uses only the authenticated actor and refuses unknown body fields and non-owner presentation writes', async () => {
    const t = await fixture(), before = t.business()
    expect((await t.post({ ...t.preferenceCommand(), actorOpenId: 'alice' }, { as: t.bob })).status).toBe(400)
    expect((await t.post(t.preferenceCommand(), { as: t.bob })).status).toBe(403)
    expect(t.business()).toEqual(before)
    // Existing group management semantics allow current group members to pause a shared responsibility.
    const routine = t.addRoutine()
    expect((await t.post(t.routineCommand(routine), { as: t.bob })).status).toBe(200)
    expect(t.routines.get(routine.id)?.enabled).toBe(false)
  })

  it.each(['outage', 'not_member'] as const)('fails closed on fresh membership %s with no operation receipt', async failure => {
    const t = await fixture(), before = t.business()
    if (failure === 'outage') t.members.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_PLATFORM_ERROR'))
    else t.members.mockResolvedValue(new Set(['bob']))
    const response = await t.post(t.preferenceCommand())
    expect(response.status).toBe(failure === 'outage' ? 503 : 403)
    expect(await response.text()).not.toContain('PRIVATE_PLATFORM_ERROR')
    expect(t.business()).toEqual(before)
  })

  it.each(['logout', 'rebind'] as const)('rejects %s during the membership await before starting a transaction', async mutation => {
    const t = await fixture(), entered = deferred<void>(), release = deferred<Set<string>>()
    const command = t.preferenceCommand()
    t.members.mockImplementation(async () => { entered.resolve(); return release.promise })
    const response = t.post(command); await entered.promise
    if (mutation === 'logout') t.auth.sessions.revoke(t.alice.actor.sessionId)
    else t.spaces.rebind(t.group.id, 'rebound-group')
    const before = t.business(); release.resolve(new Set(['alice', 'bob']))
    expect((await response).status).toBe(mutation === 'logout' ? 401 : 409)
    expect(t.business()).toEqual(before)
  })

  it('revalidates authentication after the HTTP body await', async () => {
    const t = await fixture(), entered = deferred<void>(), real = t.auth.requireMutation.bind(t.auth)
    vi.spyOn(t.auth, 'requireMutation').mockImplementation((...args) => { real(...args); entered.resolve() })
    const response = new Promise<number>((resolve, reject) => {
      const req = httpRequest(t.base + t.path(), { method: 'POST', headers: t.alice.headers }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode!))
      }); req.on('error', reject); req.flushHeaders()
      void entered.promise.then(() => { t.auth.sessions.revoke(t.alice.actor.sessionId); req.end(JSON.stringify(t.preferenceCommand())) })
    })
    expect(await response).toBe(401); expect(t.members).not.toHaveBeenCalled(); expect(t.operationRows()).toEqual([])
    expect(t.spaces.get(t.group.id)?.config).toEqual({})
  })

  it('replays the original fact without old CAS or another mutation, while changed input conflicts', async () => {
    const t = await fixture(), r = t.addRoutine(), command = t.routineCommand(r)
    const firstResponse = await t.post(command), first = await firstResponse.json()
    expect(firstResponse.status).toBe(200); expect(first).toMatchObject({ replayed: false, appliedResult: { changed: true, state: 'paused' } })
    // A different entrypoint changes current state. Retry must preserve the historical receipt.
    t.routineApp.control(r.id, 'resume')
    const current = t.routines.get(r.id), before = t.business()
    const replay = await (await t.post(command)).json()
    expect(replay).toEqual({ ...first, replayed: true }); expect(t.routines.get(r.id)).toEqual(current)
    expect(t.business()).toEqual(before)
    expect((await t.post({ ...command, operation: 'routine.resume' })).status).toBe(409)
    expect(t.operationRows()).toHaveLength(1)
    t.members.mockResolvedValue(new Set(['bob']))
    expect((await t.post(command)).status).toBe(403)
    expect(t.operationRows()).toHaveLength(1)
  })

  it.each(['routine', 'todo'] as const)('returns a historical %s receipt after archive but rejects any new command', async kind => {
    const t = await fixture(), r = t.addRoutine(), todo = t.todos.add({ scope: spaceScope(t.group.id), title: 'Synthetic' })
    const command = kind === 'routine' ? t.routineCommand(r) : { operation: 'todo.update', requestId: 'todo_request_0001',
      id: todo.id, expectedTag: todoTag(todo), patch: { title: 'Updated' } }
    const first = await (await t.post(command)).json()
    expect(first.replayed).toBe(false)
    t.spaces.archive(t.group.id)
    const before = t.business(), response = await t.post(command)
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ...first, replayed: true })
    expect((await t.post({ ...command, requestId: 'another_request_0001' })).status).toBe(409)
    expect(t.business()).toEqual(before)
  })

  it('rolls back routine, occurrence, Run stop and receipt together if the final receipt write fails; no abort before commit', async () => {
    const t = await fixture(), r = t.addRoutine()
    const occurrence = t.routines.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    t.routines.startOccurrence(occurrence.id, r.nextRunAt)
    const attempt = t.attempts.begin({ workKey: `routine:${r.id}`, sessionKey: 'routine-session', triggerKey: 'occurrence',
      stage: 'routine', actorOpenId: 'bob', now: Date.now() })!
    const abort = new AbortController(); t.activeRuns.set(r.id, [{ runId: attempt.id, abort }])
    const command = t.routineCommand(r), before = t.business()
    t.registry.db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE OF result_json ON console_operations BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_INTERNAL'); END")
    const response = await t.post(command)
    expect(response.status).toBe(500); expect(await response.text()).not.toContain('SYNTHETIC_INTERNAL')
    expect(t.business()).toEqual(before); expect(abort.signal.aborted).toBe(false)
    t.registry.db.exec('DROP TRIGGER fail_receipt')
    abort.signal.addEventListener('abort', () => {
      expect(t.operationRows()).toHaveLength(1)
      expect(t.routines.getOccurrence(occurrence.id)?.status).toBe('cancelled')
      expect(t.attempts.get(attempt.id)?.state).toBe('stop_requested')
    })
    expect((await t.post(command)).status).toBe(200); expect(abort.signal.aborted).toBe(true)
    expect(t.operationRows()).toHaveLength(1)
  })

  it('does not resume a started/interrupted once responsibility or reset its delivery uncertainty', async () => {
    const t = await fixture(), r = t.addRoutine({ type: 'once', atMs: Date.now() + 1000 })
    const occurrence = t.routines.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    t.routines.startOccurrence(occurrence.id, r.nextRunAt)
    t.routines.recoverInterruptedOccurrences(r.nextRunAt + 1)
    const context = routineExecutionKey(r.id, { occurrenceId: occurrence.id, configVersion: occurrence.configVersion })
    t.registry.db.prepare(`INSERT INTO deliveries (delivery_key,context_ref,signature,status,actor_open_id,audience,source_refs,grant_ids,payload_digest,created_at,updated_at)
      VALUES (?,?,'synthetic','unknown','bob',?,'[]','[]','digest',1,1)`).run(routineDigestDeliveryKey(context), context,
        JSON.stringify({ kind: 'group', spaceId: t.group.id, chatId: 'group' }))
    const before = t.business(), response = await t.post(t.routineCommand(r, 'routine.resume'))
    expect(response.status).toBe(409); expect((await response.json()).code).toBe('routine_unavailable')
    expect(t.business()).toEqual(before); expect(t.routines.due(r.nextRunAt + 10_000)).toEqual([])
  })

  it('preserves a watch cursor through pause and explicit resume, and rejects a stale configuration', async () => {
    const t = await fixture(), now = Date.now()
    const r = t.routines.add({ kind: 'watch', ownerOpenId: 'bob', runAs: 'bob', spaceId: t.group.id, chatId: 'group', chatType: 'group',
      name: 'Synthetic watch', prompt: 'Synthetic watch', schedule: { type: 'interval', everyMinutes: 10 }, now })
    const cursor = Math.floor(now / 1000)
    expect(t.routines.advanceMessageCursor(r.id, t.routines.configVersion(r.id)!, cursor, cursor + 15)).toBe(true)
    const old = t.routineCommand(r), pause = await t.post(old)
    expect(pause.status).toBe(200)
    expect((await t.post({ ...old, requestId: 'stale_request_0001' })).status).toBe(409)
    const paused = t.business()
    expect((await t.post(t.routineCommand(r, 'routine.resume', 'resume_no_auth_0001'))).status).toBe(409)
    expect(t.business()).toEqual(paused)
    await t.userTokens.complete({ code: 'synthetic', openId: 'bob', redirectUri: 'https://example.invalid' })
    expect((await t.post(t.routineCommand(r, 'routine.resume', 'resume_request_001'))).status).toBe(200)
    expect(t.routines.get(r.id)).toMatchObject({ enabled: true, messageCursorSec: cursor + 15 })
  })

  it('shares exact preference CAS, rejects hidden configuration fields, and keeps receipts free of form body', async () => {
    const t = await fixture(), command = t.preferenceCommand()
    expect((await t.post(command)).status).toBe(200)
    expect(t.spaces.get(t.group.id)?.config).toEqual({ brevity: 'short', ack: 'none' })
    expect((await t.post({ ...command, requestId: 'new_settings_00001', patch: { brevity: 'detailed' } })).status).toBe(409)
    expect((await t.post({ ...t.preferenceCommand('hidden_settings_001'), patch: { models: { main: 'OTHER' } } })).status).toBe(400)
    const serialized = JSON.stringify(t.operationRows())
    expect(serialized).not.toMatch(/brevity|csrf|cookie|OTHER/)
    expect(t.spaces.ensure({ kind: 'group', chatId: 'later', openId: 'alice' }).config).toEqual({ brevity: 'short', ack: 'none' })
  })

  it('rejects a Todo from another known audience even if its scope was copied into the group', async () => {
    const t = await fixture()
    t.registry.createSession({ sessionKey: 'foreign', chatId: 'dm-bob', chatType: 'p2p', requesterOpenId: 'bob', cwd: '/synthetic' })
    const hidden = t.todos.add({ scope: spaceScope(t.group.id), sessionKey: 'foreign', title: 'PRIVATE_TODO' })
    const response = await t.post({ operation: 'todo.update', requestId: 'foreign_todo_0001', id: hidden.id, expectedTag: todoTag(hidden), patch: { status: 'done' } })
    expect(response.status).toBe(404); expect(await response.text()).not.toContain('PRIVATE_TODO')
    expect(t.todos.get(hidden.id)).toEqual(hidden); expect(t.operationRows()).toEqual([])
    // The other person's actual DM also remains inaccessible, including to a group owner.
    expect((await t.post(t.preferenceCommand(), { spaceId: t.dm.id })).status).toBe(404)
  })

  it('does not disclose a committed receipt if the login is revoked in the final HTTP continuation', async () => {
    const t = await fixture(), execute = t.commands.execute.bind(t.commands)
    vi.spyOn(t.commands, 'execute').mockImplementation(async (...args) => {
      const result = await execute(...args); t.auth.sessions.revoke(t.alice.actor.sessionId); return result
    })
    const response = await t.post(t.preferenceCommand())
    expect(response.status).toBe(401); expect(await response.text()).not.toContain('operationId')
    expect(t.operationRows()).toHaveLength(1); expect(t.spaces.get(t.group.id)?.config.brevity).toBe('short')
  })

  it('reads completed and cancelled Todos and reopens each through the existing command into the default active list', async () => {
    const t = await fixture(), scope = spaceScope(t.group.id)
    const read = async (filter = '') => {
      const before = t.business()
      const response = await fetch(`${t.base}/console/api/spaces/${t.group.id}/tasks${filter}`, { headers: t.alice.headers })
      expect(response.status).toBe(200); expect(t.business()).toEqual(before)
      return (await response.json()).data
    }
    for (const status of ['done', 'cancelled'] as const) {
      const todo = t.todos.add({ scope, title: `Synthetic ${status}` })
      t.todos.transition(todo.id, scope, status, { by: 'alice' })
      const active = await read()
      expect(active.todoStatus).toBe('active'); expect(active.items.map((item: { id: number }) => item.id)).not.toContain(todo.id)
      const closed = await read(`?todoStatus=${status}`)
      expect(closed).toMatchObject({ todoStatus: status, total: 1, truncated: false,
        items: [{ id: todo.id, status, canEdit: true, transitions: ['open'] }] })
      expect((await t.post({ operation: 'todo.update', requestId: `reopen_${status}_request_001`, id: todo.id,
        expectedTag: closed.items[0].tag, patch: { status: 'open' } })).status).toBe(200)
      expect((await read()).items.map((item: { id: number }) => item.id)).toContain(todo.id)
      expect(await read(`?todoStatus=${status}`)).toMatchObject({ todoStatus: status, items: [], total: 0, truncated: false })
      expect(t.todos.get(todo.id)).toMatchObject({ status: 'open', doneAt: null, statusBy: 'alice' })
    }
  })

  it('filters closed Todo rows and totals by the same audience before the page limit', async () => {
    const t = await fixture(), scope = spaceScope(t.group.id)
    t.registry.createSession({ sessionKey: 'foreign-closed', chatId: 'dm-bob', chatType: 'p2p', requesterOpenId: 'bob', cwd: '/synthetic' })
    for (let i = 0; i < 101; i++) {
      const todo = t.todos.add({ scope, title: `Visible ${i}` })
      t.todos.transition(todo.id, scope, 'done')
    }
    for (const hidden of [
      t.todos.add({ scope, sessionKey: 'foreign-closed', title: 'PRIVATE_FROM_DM' }),
      t.todos.add({ scope: spaceScope(t.other.id), title: 'PRIVATE_OTHER_SPACE' }),
    ]) t.todos.transition(hidden.id, hidden.scope, 'done')
    const cancelled = t.todos.add({ scope, title: 'Cancelled' }); t.todos.transition(cancelled.id, scope, 'cancelled')
    const before = t.business()
    const response = await fetch(`${t.base}/console/api/spaces/${t.group.id}/tasks?todoStatus=done`, { headers: t.alice.headers })
    expect(response.status).toBe(200)
    const raw = await response.text(), data = JSON.parse(raw).data
    expect(data).toMatchObject({ todoStatus: 'done', total: 101, truncated: true }); expect(data.items).toHaveLength(100)
    expect(data.items.every((item: { status: string }) => item.status === 'done')).toBe(true)
    expect(raw).not.toContain('PRIVATE_'); expect(raw).not.toContain('Cancelled')
    expect(t.business()).toEqual(before)
  })

  it('rejects invalid task filters without writes and does not add Todo filtering to other sections', async () => {
    const t = await fixture(), before = t.business()
    for (const filter of ['all', 'open', '', 'unknown', 'done&todoStatus=cancelled']) {
      const response = await fetch(`${t.base}/console/api/spaces/${t.group.id}/tasks?todoStatus=${filter}`, { headers: t.alice.headers })
      expect(response.status).toBe(400); expect((await response.json()).code).toBe('invalid_todo_status')
    }
    const overview = await fetch(`${t.base}/console/api/spaces/${t.group.id}/overview?todoStatus=not-a-filter-here`, { headers: t.alice.headers })
    expect(overview.status).toBe(200); expect((await overview.json()).data).not.toHaveProperty('todoStatus')
    expect(t.business()).toEqual(before)
  })
})
