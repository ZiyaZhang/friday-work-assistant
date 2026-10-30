import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { ConsoleAuth } from '../src/web/console-auth.js'
import { createConsoleRouter } from '../src/web/console-router.js'
import { ConsoleQueries } from '../src/core/console-queries.js'
import { ConsoleCommands } from '../src/core/console-commands.js'
import { ConsoleOperations } from '../src/core/console-operations.js'
import { HumanSpaceAccess } from '../src/core/human-space-access.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Todos } from '../src/core/todos.js'
import { TodoApplication } from '../src/core/todo-application.js'
import { SpaceApplication } from '../src/core/space-application.js'
import { RoutineStore } from '../src/core/routines.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RunModels } from '../src/core/run-models.js'
import { ModelApplication } from '../src/core/model-selection.js'
import { SkillProposals } from '../src/core/skills.js'
import { DeliveryService } from '../src/core/delivery.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createInternalApi } from '../src/internal/api.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { choiceA, choiceB, deferred, modelAgent } from './helpers/model-agent.js'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture() {
  const registry = new Registry(':memory:'); cleanups.push(() => registry.close())
  const sp = spaceDeps(registry.db), group = sp.spaces.ensure({ kind: 'group', chatId: 'group', openId: 'alice' })
  sp.spaces.addMember(group.id, 'bob', 'member')
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'dm-bob', openId: 'bob' })
  const feishu = asFeishuClient(new FakeFeishu()), log = createLogger('console-model-test', 'error')
  const members = vi.spyOn(feishu, 'chatMemberOpenIds').mockResolvedValue(new Set(['alice', 'bob']))
  const auth = new ConsoleAuth({ db: registry.db, appId: 'app', domain: 'feishu', baseUrl: 'https://console.test', tenantKeys: ['tenant'],
    provider: { exchangeCode: async () => ({ accessToken: 'synthetic' }), whoAmI: async () => ({ openId: 'alice', tenantKey: 'tenant' }) } })
  const login = (openId: string) => {
    const session = auth.sessions.create({ appId: 'app', tenantKey: 'tenant', openId, name: openId })
    return { ...session, headers: { cookie: `${auth.sessionCookieName}=${session.token}`, origin: 'https://console.test',
      'content-type': 'application/json', 'x-csrf-token': auth.sessions.csrfFor(session.actor)! } }
  }
  const alice = login('alice'), bob = login('bob')
  const access = new HumanSpaceAccess({ ...sp, feishu, assertActor: actor => auth.assertCurrent(actor) })
  const memory = new ChannelMemory(registry.db), todos = new Todos(registry.db), routines = new RoutineStore(registry.db)
  const attempts = new RunAttempts(registry.db), runs = new RunModels(registry.db), skills = new SkillProposals(registry.db, new Set())
  const peer = modelAgent(), runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: peer.app }, log,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) }); cleanups.push(() => runtime.stop())
  const models = new ModelApplication({ runtime, spaces: sp.spaces, runs, policy: () => ({
    defaultRoute: { providerId: 'provider', modelId: 'a', accountRef: 'primary' },
    allowed: [{ providerId: 'provider', modelId: 'a', accountRef: 'primary' }, { providerId: 'provider', modelId: 'b', accountRef: 'secondary' }],
  }) })
  new DeliveryService(registry.db, { ...sp, resolveContext: async () => undefined, send: async () => { throw Error('No external sends') } })
  const operations = new ConsoleOperations(registry.db, { sessions: auth.sessions })
  const commands = new ConsoleCommands({ access, operations, spaces: sp.spaces, routines, todos, models,
    spaceApplication: new SpaceApplication({ db: registry.db, spaces: sp.spaces }), todoApplication: new TodoApplication({ db: registry.db, todos }),
    persistRoutineControl: () => { throw Error('Unexpected routine mutation') },
    assertHumanRunTarget: () => { throw Error('Unexpected run command') }, persistHumanRunStop: () => { throw Error('Unexpected run command') },
    assertHumanWorkTarget: () => { throw Error('Unexpected work command') }, persistHumanWorkCancel: () => { throw Error('Unexpected work command') },
    persistHumanWorkResume: () => { throw Error('Unexpected work command') } })
  const queries = new ConsoleQueries({ access, registry, memory, todos, routines, skills, models, runModels: runs, defaults: { brevity: 'normal', reflect: true } })
  const cache = new MessageCache(registry.db)
  const api = createInternalApi({ ...sp, registry, memory, todos, routines, feishu, messageCache: cache,
    messages: new MessageService(feishu, cache, log), tokens: new TokenIssuer('synthetic'), log, maxHistoryPerCall: 100,
    consoleRouter: createConsoleRouter(auth, queries, commands) })
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening')
  cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>(r => api.server.close(() => r())) })
  const base = `http://127.0.0.1:${(api.server.address() as { port: number }).port}`
  const page = (section = 'overview', as = alice, spaceId = group.id) => fetch(`${base}/console/api/spaces/${spaceId}/${section}`, { headers: as.headers })
  const post = (body: unknown, as = alice, headers: Record<string, string> = {}) => fetch(`${base}/console/api/spaces/${group.id}/operations`,
    { method: 'POST', headers: { ...as.headers, ...headers }, body: JSON.stringify(body) })
  const selection = async (value: string | null = choiceB, requestId = 'model_request_0001') => {
    const catalog = (await (await page()).json()).data.models
    return { operation: 'space.model', value, requestId, generation: catalog.generation, expectedTag: catalog.tag }
  }
  const rows = () => registry.db.prepare('SELECT * FROM console_operations').all()
  const task = (space = group, actor = 'alice') => {
    const key = `session-${space.id}`
    registry.createSession({ sessionKey: key, chatId: space.chatId!, chatType: space.kind, requesterOpenId: actor, cwd: '/PRIVATE_WORKSPACE' })
    const task = registry.createTask({ sessionKey: key, messageId: key, requesterOpenId: actor, prompt: 'Synthetic request' })
    const run = attempts.begin({ sessionKey: key, workKey: key, triggerKey: key, stage: 'task', taskId: task.id, actorOpenId: actor, now: 1 })!
    return { task, run }
  }
  return { ...sp, registry, group, dm, auth, alice, bob, members, runtime, peer, models, runs, attempts, page, post, selection, rows, task }
}

describe('human model selection via HTTP, SQLite and the ACP protocol', () => {
  it('shows only deployment-approved actual catalog choices without starting a worker or model prompt', async () => {
    const t = await fixture()
    const response = await t.page(), body = await response.json()
    expect(response.status).toBe(200)
    expect(body.data.models).toMatchObject({ status: 'available', selected: null, generation: 1,
      choices: [{ value: choiceA, providerId: 'provider', modelId: 'a', accountRef: 'primary' }, { value: choiceB, modelId: 'b' }] })
    expect(JSON.stringify(body)).not.toContain('unapproved-provider')
    expect(t.peer.state.newCalls).toHaveLength(1)
    expect(t.peer.state.newCalls[0]!.mcpServers).toEqual([])
    expect(t.peer.state.prompts).toEqual([])
    expect(t.registry.db.prepare('SELECT * FROM tasks').all()).toEqual([])
    expect(t.registry.db.prepare('SELECT * FROM run_models').all()).toEqual([])
    expect(t.rows()).toEqual([])
  })

  it('persists exact selection and default restoration, while a replay needs no new directory or CAS', async () => {
    const t = await fixture(), command = await t.selection()
    const first = await t.post(command), receipt = await first.json()
    expect(first.status).toBe(200); expect(receipt).toMatchObject({ replayed: false, appliedResult: { changed: true } })
    expect(t.spaces.get(t.group.id)!.config.modelSelection).toEqual({ value: choiceB })
    await t.runtime.stop(); await t.runtime.start() // The original generation is now stale.
    const discover = vi.spyOn(t.models, 'catalog')
    const replay = await t.post(command)
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ ...receipt, replayed: true })
    expect(discover).not.toHaveBeenCalled(); expect(t.rows()).toHaveLength(1)
    expect((await t.post({ ...command, value: choiceA })).status).toBe(409)
    const restore = await t.selection(null, 'restore_request_0001')
    expect((await t.post(restore)).status).toBe(200)
    expect(t.spaces.get(t.group.id)!.config.modelSelection).toBeNull()
    expect(t.peer.state.setCalls).toEqual([]) // Saving a preference never changes an active ACP session.
  })

  it('retains an existing Run pin while a later space selection changes', async () => {
    const t = await fixture(), command = await t.selection(), { run } = t.task()
    const sessionId = await t.runtime.newSession('/synthetic/run')
    t.attempts.bindRuntime(run.id, sessionId)
    const pin = await t.models.prepare(run.id, t.group.id, sessionId, () => undefined)
    expect(pin.modelId).toBe('a')
    expect((await t.post(command)).status).toBe(200)
    expect(t.runs.get(run.id)!.modelId).toBe('a')
    expect(t.peer.state.setCalls).toHaveLength(1)
    expect((await (await t.page()).json()).data.models.selected).toBe(choiceB)
  })

  it('requires current configuration authority and human mutation credentials, not an actor field', async () => {
    const t = await fixture()
    const readOnly = await t.page('overview', t.bob)
    expect(readOnly.status).toBe(200)
    expect((await readOnly.json()).data.models.status).toBe('read_only')
    expect(t.peer.state.newCalls).toEqual([])
    const command = await t.selection()
    expect((await t.post(command, t.bob)).status).toBe(403)
    expect((await t.post(command, t.alice, { 'x-csrf-token': 'wrong' })).status).toBe(403)
    expect((await t.post({ ...command, actorOpenId: 'alice' }, t.bob)).status).toBe(400)
    expect((await t.post(command, t.alice, { cookie: '', authorization: 'Bearer worker-token' })).status).toBe(401)
    expect(t.rows()).toEqual([]); expect(t.spaces.get(t.group.id)!.config.modelSelection).toBeUndefined()
  })

  it.each(['logout', 'rebind', 'role-change'] as const)('does not disclose a catalog after %s during the ACP await', async mutation => {
    const t = await fixture(), entered = deferred(), release = deferred(), original = t.runtime.newSession.bind(t.runtime)
    vi.spyOn(t.runtime, 'newSession').mockImplementation(async (...args) => { const id = await original(...args); entered.resolve(); await release.promise; return id })
    const response = t.page(); await entered.promise
    if (mutation === 'logout') t.auth.sessions.revoke(t.alice.actor.sessionId)
    else if (mutation === 'rebind') t.spaces.rebind(t.group.id, 'new-group')
    else { t.spaces.removeMember(t.group.id, 'alice'); t.spaces.addMember(t.group.id, 'alice', 'member') }
    release.resolve()
    const result = await response
    expect(result.status).toBe(mutation === 'logout' ? 401 : 409)
    expect(await result.text()).not.toContain('choices')
    expect(t.rows()).toEqual([])
  })

  it('rejects a lost session during mutation membership lookup without saving configuration', async () => {
    const t = await fixture(), command = await t.selection(), entered = deferred(), release = deferred()
    t.members.mockImplementation(async () => { entered.resolve(); await release.promise; return new Set(['alice', 'bob']) })
    const response = t.post(command); await entered.promise
    t.auth.sessions.revoke(t.alice.actor.sessionId); release.resolve()
    expect((await response).status).toBe(401); expect(t.rows()).toEqual([])
    expect(t.spaces.get(t.group.id)!.config.modelSelection).toBeUndefined()
  })

  it('rejects stale generation, stale space selection, and unapproved values without a receipt', async () => {
    const t = await fixture(), command = await t.selection()
    expect((await t.post({ ...command, value: '["unapproved-provider","a"]' })).status).toBe(400)
    await t.runtime.stop(); await t.runtime.start()
    expect((await t.post(command)).status).toBe(409)
    const fresh = await t.selection()
    t.spaces.patchConfig(t.group.id, { modelSelection: { value: choiceA } })
    expect((await t.post(fresh)).status).toBe(409)
    expect(t.rows()).toEqual([])
  })

  it('rolls back the preference with a failed receipt, and allows only historical replay after archival', async () => {
    const t = await fixture(), command = await t.selection()
    t.registry.db.exec("CREATE TRIGGER fail_model_receipt BEFORE UPDATE OF result_json ON console_operations BEGIN SELECT RAISE(ABORT, 'INTERNAL_CANARY'); END")
    const failure = await t.post(command)
    expect(failure.status).toBe(500); expect(await failure.text()).not.toContain('INTERNAL_CANARY')
    expect(t.spaces.get(t.group.id)!.config.modelSelection).toBeUndefined(); expect(t.rows()).toEqual([])
    t.registry.db.exec('DROP TRIGGER fail_model_receipt')
    const first = await (await t.post(command)).json()
    t.spaces.archive(t.group.id)
    const catalog = vi.spyOn(t.models, 'catalog')
    expect((await (await t.page()).json()).data.models.status).toBe('read_only')
    expect(catalog).not.toHaveBeenCalled()
    expect(await (await t.post(command)).json()).toEqual({ ...first, replayed: true })
    expect((await t.post({ ...command, requestId: 'another_model_request' })).status).toBe(409)
    expect(t.rows()).toHaveLength(1)
  })

  it('returns explicit unavailability when the real agent does not advertise configuration', async () => {
    const t = await fixture(); t.peer.state.omitCatalog = true
    const response = await t.page(), body = await response.json()
    expect(response.status).toBe(200)
    expect(body.data.models).toMatchObject({ status: 'unavailable' })
    expect(body.data.models).not.toHaveProperty('choices')
    expect(t.peer.state.prompts).toEqual([])
  })

  it('shows only persisted model and occupancy facts for visible Runs, never selectors, ACP IDs or billing estimates', async () => {
    const t = await fixture(), { run } = t.task(), hidden = t.task(t.dm, 'bob')
    for (const [r, modelId] of [[run, 'a'], [hidden.run, 'PRIVATE_MODEL']] as const) {
      const acpSessionId = `PRIVATE_ACP_${r.id}`; t.attempts.bindRuntime(r.id, acpSessionId)
      const pin = t.runs.prepare({ runId: r.id, acpSessionId, runtimeGeneration: 1, selector: 'PRIVATE_SELECTOR',
        providerId: 'provider', modelId, accountRef: 'primary', preparedAt: 2 })
      t.runs.admit(r.id, pin, 3); t.runs.observeContext(r.id, pin, { used: 0, size: 1000, observedAt: 4 })
    }
    const response = await t.page('executions'), bodyText = await response.text(), body = JSON.parse(bodyText)
    expect(response.status).toBe(200); expect(body.data.items).toHaveLength(1)
    expect(body.data.items[0].runs[0].model).toEqual({ providerId: 'provider', modelId: 'a', accountRef: 'primary',
      admittedAt: 3, contextUsed: 0, contextSize: 1000, usageStatus: 'unavailable' })
    expect(bodyText).not.toMatch(/PRIVATE_|selector|acpSessionId|billingTokens|inputTokens/)
  })
})
