import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsoleAuth } from '../src/web/console-auth.js'
import { ConsoleQueries } from '../src/core/console-queries.js'
import { HumanSpaceAccess } from '../src/core/human-space-access.js'
import { createConsoleRouter } from '../src/web/console-router.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Todos } from '../src/core/todos.js'
import { MAX_CONSECUTIVE_FAILURES, RoutineStore } from '../src/core/routines.js'
import { routineProgress } from '../src/core/routine-application.js'
import { SkillProposals } from '../src/core/skills.js'
import { DeliveryService, type DeliveryAudience } from '../src/core/delivery.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { spaceScope } from '../src/core/space.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createInternalApi } from '../src/internal/api.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { taskDeliveryContextRef, routineExecutionKey } from '../src/core/execution-keys.js'
import { GitHubIdentity } from '../src/github/identity.js'
import { GitHubProjectView } from '../src/github/project-view.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { WorkAccessWaits } from '../src/core/work-access-waits.js'
import { accessFailure } from '../src/core/access-failure.js'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(timezoneOffsetMinutes?: number) {
  const registry = new Registry(':memory:'); cleanup.push(() => registry.close())
  const sp = spaceDeps(registry.db, { admins: ['alice'] })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'group', openId: 'alice', title: 'Group' })
  const bob = sp.spaces.ensure({ kind: 'p2p', chatId: 'dm-bob', openId: 'bob' })
  const other = sp.spaces.ensure({ kind: 'group', chatId: 'other', openId: 'bob', title: 'PRIVATE_GROUP' })
  const log = createLogger('console-test', 'error'), fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  const members = vi.spyOn(feishu, 'chatMemberOpenIds').mockResolvedValue(new Set(['alice','bob']))
  const auth = new ConsoleAuth({ db: registry.db, appId: 'app', domain: 'feishu', baseUrl: 'https://console.test', tenantKeys: ['tenant'],
    provider: { exchangeCode: async () => ({ accessToken: 'fake' }), whoAmI: async () => ({ openId: 'alice', tenantKey: 'tenant' }) } })
  const session = auth.sessions.create({ appId: 'app', tenantKey: 'tenant', openId: 'alice', name: 'Alice' })
  const cookie = `${auth.sessionCookieName}=${session.token}`
  const access = new HumanSpaceAccess({ ...sp, feishu, assertActor: actor => auth.assertCurrent(actor) })
  const memory = new ChannelMemory(registry.db), todos = new Todos(registry.db), routines = new RoutineStore(registry.db, timezoneOffsetMinutes)
  const skills = new SkillProposals(registry.db, new Set()), attempts = new RunAttempts(registry.db)
  new DeliveryService(registry.db, { ...sp, resolveContext: async () => undefined, send: async () => { throw new Error('No sends') } })
  const github = new GitHubIdentity({ apiUrl: 'https://api.github.com', token: 'synthetic', allowedRepos: ['org/a','org/b'] }, log,
    { request: async () => ({ status: 200, data: [] }) as never })
  const projects = new GitHubProjectView(registry.db, github)
  const userTokens = new UserTokenStore(registry.db, fake)
  const queries = new ConsoleQueries({ access, registry, memory, todos, routines, skills, github, projects, userTokens, defaults: { brevity: 'normal', reflect: true } })
  const cache = new MessageCache(registry.db)
  const api = createInternalApi({ ...sp, registry, memory, todos, routines, feishu, messages: new MessageService(feishu, cache, log),
    messageCache: cache, tokens: new TokenIssuer('test'), log, maxHistoryPerCall: 100, consoleRouter: createConsoleRouter(auth, queries) })
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening')
  cleanup.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())) })
  const base = `http://127.0.0.1:${(api.server.address() as { port: number }).port}`
  const call = (path: string, opts: RequestInit = {}) => fetch(base + path, { ...opts, headers: { cookie, ...opts.headers } })
  const page = (section: string, id=group.id) => call(`/console/api/spaces/${encodeURIComponent(id)}/${section}`)
  const task = (key: string, chatId: string, chatType: 'group'|'p2p', actor: string, prompt: string) => {
    registry.createSession({ sessionKey: key, chatId, chatType, requesterOpenId: actor, cwd: '/PRIVATE_PATH' })
    return registry.createTask({ sessionKey: key, messageId: key, requesterOpenId: actor, prompt })
  }
  const receipt = (key: string, context: string, audience: DeliveryAudience, remoteId: string, status='unknown') => {
    registry.db.prepare(`INSERT INTO deliveries (delivery_key,context_ref,signature,status,actor_open_id,audience,source_refs,grant_ids,payload_digest,remote_id,created_at,updated_at)
      VALUES (?,?,'sig',?,'bob',?,'[]','[]','digest',?,1,1)`).run(key,context,status,JSON.stringify(audience),remoteId)
  }
  return { ...sp, registry, group, bob, other, members, auth, session, queries, memory, todos, routines, attempts, skills, projects, userTokens, fake, call, page, task, receipt, base }
}

describe('human console read surfaces over the real internal server', () => {
  it('public shell is generic; human cookies and worker bearer tokens cannot replace each other', async () => {
    const t = await fixture()
    const shell = await fetch(t.base+'/console')
    expect(shell.status).toBe(200); expect(shell.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(await shell.text()).not.toContain('PRIVATE_GROUP')
    expect((await fetch(t.base+'/console/api/spaces', { headers: { authorization: 'Bearer worker-token' } })).status).toBe(401)
    expect((await t.call('/v1/todo/list', { method: 'POST', body: '{}' })).status).toBe(401)
    const list = await (await t.call('/console/api/spaces')).json()
    expect(list.items.map((s: {id:string})=>s.id)).toEqual([t.group.id])
  })
  it('filters resources and counts to the selected space without business writes', async () => {
    const t = await fixture()
    for (const space of [t.group,t.bob,t.other]) {
      t.memory.add({ scope: spaceScope(space.id), kind: 'fact', title: space.id, body: 'Only in '+space.id })
      t.todos.add({ scope: spaceScope(space.id), title: space.id })
    }
    const before = t.registry.db.prepare('SELECT total_changes() AS n').get()!.n as number
    const memory = await t.queries.read(t.session.actor,t.group.id,'memory'); memory.assertCurrent()
    expect(memory.body.data).toMatchObject({ total: 1, items: [{ title: t.group.id }] })
    expect(t.registry.db.prepare('SELECT total_changes() AS n').get()!.n).toBe(before)
    expect((await (await t.page('tasks')).json()).data.total).toBe(1)
    for (const section of ['overview','memory','tasks','executions','project']) expect((await t.page(section,t.bob.id)).status).toBe(404)
  })
  it('membership outage is a 503, not an empty list or leaked title; unsupported writes do not change state', async () => {
    const t = await fixture(); t.members.mockRejectedValue(new Error('PRIVATE_PLATFORM_DETAIL'))
    const response = await t.call('/console/api/spaces'), body = await response.text()
    expect(response.status).toBe(503); expect(body).not.toContain('PRIVATE'); expect(body).not.toContain('items')
    const before = t.spaces.get(t.group.id)
    expect((await t.call(`/console/api/spaces/${t.group.id}/settings`,{method:'PATCH',body:'{}'})).status).toBe(405)
    expect(t.spaces.get(t.group.id)).toEqual(before)
  })
  it('revalidates the space after the query promise resolves and before returning HTTP content', async () => {
    const t = await fixture(), read = t.queries.read.bind(t.queries)
    vi.spyOn(t.queries,'read').mockImplementation(async (...args) => { const result = await read(...args); t.spaces.rebind(t.group.id,'changed'); return result })
    const res = await t.page('overview'); expect(res.status).toBe(409); expect(await res.text()).not.toContain('Group')
  })
  it('revalidates the project grant in the final HTTP continuation', async () => {
    const t = await fixture(); t.spaces.patchConfig(t.group.id,{projectRepos:['org/a']})
    const read = t.queries.read.bind(t.queries)
    vi.spyOn(t.queries,'read').mockImplementation(async (...args)=>{const result=await read(...args);t.spaces.patchConfig(t.group.id,{projectRepos:[]});return result})
    const res = await t.page('project'); expect(res.status).toBe(403);expect(await res.text()).not.toContain('org/a')
  })
  it('logout while the query is returning prevents the response', async () => {
    const t = await fixture(), read = t.queries.read.bind(t.queries)
    vi.spyOn(t.queries,'read').mockImplementation(async (...args)=>{const result=await read(...args);t.auth.sessions.revoke(t.session.actor.sessionId);return result})
    expect((await t.page('overview')).status).toBe(401)
  })
  it('does not return a memory forgotten between query and HTTP reply', async () => {
    const t = await fixture(), note = t.memory.add({ scope: spaceScope(t.group.id), kind: 'fact', title: 'FORGOTTEN', body: 'OLD_BODY' })
    const read = t.queries.read.bind(t.queries)
    vi.spyOn(t.queries,'read').mockImplementation(async (...args)=>{const result=await read(...args);expect(t.memory.remove(note.id,spaceScope(t.group.id))).toBe(true);return result})
    const res=await t.page('memory'); expect(res.status).toBe(409); expect(await res.text()).not.toContain('OLD_BODY')
  })
  it('shows execution facts without paths, platform errors or another audience’s receipts', async () => {
    const t = await fixture(), task = t.task('s','group','group','bob','A group request')
    t.task('private','dm-bob','p2p','bob','PRIVATE_REQUEST')
    t.registry.db.prepare("UPDATE tasks SET error='PRIVATE_ERROR' WHERE id=?").run(task.id)
    t.attempts.begin({workKey:'w',sessionKey:'s',triggerKey:'x',stage:'task',taskId:task.id,actorOpenId:'bob',now:1})
    const context=taskDeliveryContextRef(task.id,'s')
    t.receipt('a',context,{kind:'group',spaceId:t.group.id,chatId:'group'},'GROUP_RECEIPT')
    t.receipt('b',context+':tool:dm',{kind:'dm',spaceId:t.bob.id,openId:'bob'},'PRIVATE_DM_RECEIPT')
    t.receipt('c',context,{kind:'group',spaceId:t.group.id,chatId:'old-group'},'OLD_GROUP_RECEIPT')
    const res=await t.page('executions'), body=await res.text();expect(res.status).toBe(200)
    expect(body).toContain('GROUP_RECEIPT');expect(body).toContain('unknown');expect(body).not.toMatch(/PRIVATE_|OLD_GROUP_/)
    expect(JSON.parse(body).data.items).toHaveLength(1)
  })

  it('projects persisted partial results and current authorization pauses without treating Task done as completion', async () => {
    const t = await fixture(), task = t.task('partial-session', 'group', 'group', 'alice', 'Partial request')
    const workKey = t.registry.taskWork.get(task.id)!.key
    const run = t.attempts.begin({ workKey, sessionKey: task.sessionKey, triggerKey: `task:${task.id}`, stage: 'task', taskId: task.id, actorOpenId: 'alice', now: 1 })!
    t.attempts.finish(run.id, 'completed', 2, 'max_tokens', { version: 1, termination: 'max_tokens', outcome: 'partial', reason: 'model_limit' })
    t.registry.updateTask(task.id, { status: 'done', stopReason: 'max_tokens', finishedAt: 2 })
    t.registry.workContexts.markHandled(workKey, task.id)
    t.receipt('partial-reply', taskDeliveryContextRef(task.id, task.sessionKey), { kind: 'group', spaceId: t.group.id, chatId: 'group' }, 'ack', 'sent')
    let item = (await (await t.page('executions')).json()).data.items[0]
    expect(item).toMatchObject({ status: 'done', progress: { state: 'partial', label: '尚未完成', reaction: 'partial' },
      runs: [{ result: { termination: 'max_tokens', outcome: 'partial' } }] })
    t.registry.workContexts.control(workKey, { action: 'pause', reason: 'authorization', causeRef: 'stored-grant-condition' })
    item = (await (await t.page('executions')).json()).data.items[0]
    expect(item.progress).toMatchObject({ state: 'waiting_authorization', nextAction: 'connect', reaction: 'waiting' })
  })

  it('reads an accepted grant and its actual recovery blocker without clearing the pause or asking to connect again', async () => {
    const t = await fixture(), dm = t.spaces.ensure({ kind: 'p2p', chatId: 'dm-alice', openId: 'alice' })
    const task = t.task('authorized-request', 'dm-alice', 'p2p', 'alice', 'Read my calendar'), workKey = t.registry.taskWork.get(task.id)!.key
    const run = t.attempts.begin({ workKey, sessionKey: task.sessionKey, triggerKey: `task:${task.id}`, stage: 'task', taskId: task.id, actorOpenId: 'alice', now: 1 })!
    const waits = new WorkAccessWaits(t.registry.db, t.registry.workContexts)
    waits.record(workKey, accessFailure('not_connected', { identity: 'user', scopes: ['calendar:calendar.event:read'] }),
      { taskId: task.id, runId: run.id, openId: 'alice', grantId: null, purpose: 'calendar' })
    t.attempts.finish(run.id, 'completed', 2, 'end_turn', { version: 1, termination: 'end_turn', outcome: 'partial', reason: 'authorization_required' })
    t.registry.updateTask(task.id, { status: 'done', finishedAt: 2 })
    const read = async () => (await (await t.page('executions', dm.id)).json()).data.items[0]
    expect((await read()).progress).toMatchObject({ state: 'waiting_authorization', nextAction: 'connect' })
    t.fake.nextToken.scope = 'calendar:calendar.event:read'
    await t.userTokens.complete({ openId: 'alice', code: 'synthetic-accepted-grant', redirectUri: 'https://synthetic/callback' })
    const before = t.registry.db.prepare('SELECT total_changes() AS n').get()!.n
    const item = (await t.queries.read(t.session.actor, dm.id, 'executions')).body.data as { items: { progress: unknown; work: unknown }[] }
    expect(item.items[0]).toMatchObject({ progress: { state: 'needs_attention', nextAction: 'reconcile', detail: expect.stringContaining('所需授权已完成') },
      work: { pauses: [{ reason: 'authorization', label: '授权已完成，等待恢复检查', canResume: false }] } })
    expect(t.registry.db.prepare('SELECT total_changes() AS n').get()!.n).toBe(before)
    expect(t.registry.workContexts.get(workKey)?.pauseReasons).toHaveLength(1)
    t.userTokens.disconnect('alice')
    expect((await read()).progress).toMatchObject({ state: 'waiting_authorization', nextAction: 'connect' })
  })

  it('keeps a legacy done task without result evidence distinguishable from completed work', async () => {
    const t = await fixture(), task = t.task('legacy-session', 'group', 'group', 'alice', 'Legacy request')
    t.registry.updateTask(task.id, { status: 'done', stopReason: 'end_turn', finishedAt: 2 })
    t.registry.workContexts.markHandled(t.registry.taskWork.get(task.id)!.key, task.id)
    const item = (await (await t.page('executions')).json()).data.items[0]
    expect(item.progress).toMatchObject({ state: 'unknown', reaction: null })
    expect(item.work.lifecycle).toBe('open')
  })
  it('routine progress counts only receipts visible to this audience',async()=>{
    const t=await fixture(), now=Date.now()
    const r=t.routines.add({kind:'schedule',ownerOpenId:'bob',spaceId:t.group.id,chatId:'group',chatType:'group',name:'Group routine',prompt:'Do work',schedule:{type:'once',atMs:now+1000},now})
    const occurrence=t.routines.claimDueOccurrence(r.id,r.nextRunAt,r.nextRunAt)!
    const context=routineExecutionKey(r.id,{occurrenceId:occurrence.id,configVersion:occurrence.configVersion})
    t.receipt('a',context,{kind:'group',spaceId:t.group.id,chatId:'group'},'VISIBLE')
    t.receipt('b',context+':tool:dm',{kind:'dm',spaceId:t.bob.id,openId:'bob'},'PRIVATE_DM_RECEIPT')
    const res=await t.page('tasks'),body=await res.json();expect(res.status).toBe(200)
    expect(body.data.routines[0].progress.managed_delivery.items).toEqual([{kind:'message',key:'a',status:'unknown',remote_id:'VISIBLE',can_reconcile:true,reconciliation:null}])
    expect(JSON.stringify(body)).not.toContain('PRIVATE')
  })
  it('does not turn a private-only routine receipt into a claim that the gateway sent nothing', async () => {
    const t = await fixture(), now = Date.now()
    const r = t.routines.add({ kind: 'schedule', ownerOpenId: 'bob', spaceId: t.group.id, chatId: 'group', chatType: 'group',
      name: 'Group routine', prompt: 'Synthetic work', schedule: { type: 'once', atMs: now + 1000 }, now })
    const occurrence = t.routines.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    const context = routineExecutionKey(r.id, { occurrenceId: occurrence.id, configVersion: occurrence.configVersion })
    t.receipt('private-only', context + ':tool:dm', { kind: 'dm', spaceId: t.bob.id, openId: 'bob' }, 'PRIVATE_DM_RECEIPT', 'sent')
    const before = t.registry.db.prepare('SELECT * FROM deliveries').all()
    // The underlying application read model still knows the successful managed send.
    expect(routineProgress(t.routines, r, t.registry.db).managed_delivery).toMatchObject({
      audience_filtered: false, record_status: 'recorded', items: [{ status: 'sent', remote_id: 'PRIVATE_DM_RECEIPT' }],
    })
    const response = await t.page('tasks'), body = await response.json()
    expect(response.status).toBe(200)
    const delivery = body.data.routines[0].progress.managed_delivery
    expect(delivery).toMatchObject({ audience_filtered: true, record_status: 'not_recorded', items: [] })
    expect(delivery.summary).toMatch(/当前受众.*可查看/)
    expect(delivery.summary).toMatch(/不能.*认定未发送/)
    expect(JSON.stringify(body)).not.toContain('PRIVATE_DM_RECEIPT')
    expect(t.registry.db.prepare('SELECT * FROM deliveries').all()).toEqual(before)
  })
  it('distinguishes a claimed once responsibility from running and finished without claiming delivery', async () => {
    const t = await fixture(), now = Date.now()
    const r = t.routines.add({ kind: 'schedule', ownerOpenId: 'bob', spaceId: t.group.id, chatId: 'group', chatType: 'group',
      name: 'Synthetic once reminder', prompt: 'Synthetic work', schedule: { type: 'once', atMs: now + 1000 }, now })
    const occurrence = t.routines.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    const read = async () => {
      const before = [t.routines.get(r.id), t.routines.listOccurrences(r.id)]
      const response = await t.page('tasks'), body = await response.json()
      expect(response.status).toBe(200)
      expect([t.routines.get(r.id), t.routines.listOccurrences(r.id)]).toEqual(before)
      return body.data.routines.find((item: { id: number }) => item.id === r.id)
    }
    expect(t.routines.get(r.id)?.enabled).toBe(false)
    const pending = await read()
    expect(pending).toMatchObject({ stateLabel: '等待开始', nextStep: '等待开始。',
      progress: { latest_occurrence: { status: 'pending' }, next_run_at: null } })
    expect(t.routines.startOccurrence(occurrence.id, r.nextRunAt + 1)).toBeDefined()
    const running = await read()
    expect(running).toMatchObject({ stateLabel: '执行中', nextStep: '正在执行。',
      progress: { latest_occurrence: { status: 'running' } } })
    expect(t.routines.finishOccurrence(occurrence.id, 'ok', r.nextRunAt + 2)).toBeDefined()
    const finished = await read()
    expect(finished).toMatchObject({ stateLabel: '本次已执行', progress: { last_status: 'ok', next_run_at: null,
      latest_occurrence: { status: 'ok' }, managed_delivery: { record_status: 'not_recorded', items: [] } } })
    expect(finished.stateLabel).not.toMatch(/送达|已完成/)
    expect(finished.progress.fact_summary).toContain('运行结束不等于结果已送达')
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM deliveries').get()?.n).toBe(0)
  })
  it('summarizes automatic failure pauses without returning the raw platform error anywhere in HTTP', async () => {
    const t = await fixture(), now = Date.now()
    const canary = 'SYNTHETIC_PRIVATE_PLATFORM_ERROR__token=not-a-real-token__path=/private/example'
    const r = t.routines.add({ kind: 'schedule', ownerOpenId: 'bob', spaceId: t.group.id, chatId: 'group', chatType: 'group',
      name: 'Synthetic failing responsibility', prompt: 'Synthetic work', schedule: { type: 'interval', everyMinutes: 5 }, now })
    for (let n = 0; n < MAX_CONSECUTIVE_FAILURES; n += 1) {
      const due = t.routines.get(r.id)!.nextRunAt
      const occurrence = t.routines.claimDueOccurrence(r.id, due, due)!
      expect(t.routines.startOccurrence(occurrence.id, due + 1)).toBeDefined()
      expect(t.routines.finishOccurrence(occurrence.id, 'failed', due + 2, canary)).toBeDefined()
    }
    const stored = t.routines.get(r.id)!
    expect(stored.enabled).toBe(false)
    expect(stored.disabledReason).toContain(canary)
    const response = await t.page('tasks'), raw = await response.text()
    expect(response.status).toBe(200)
    expect(raw).not.toContain(canary)
    expect(raw).not.toContain('/private/example')
    expect(JSON.parse(raw).data.routines).toMatchObject([{ id: r.id, stateLabel: '已暂停', disabledReason: '执行失败后暂停',
      progress: { last_status: 'failed', next_run_at: null, latest_occurrence: { status: 'failed' } } }])
    expect(t.routines.get(r.id)).toEqual(stored)
  })
  it('archived spaces remain readable without restoring them or their routines',async()=>{
    const t=await fixture();t.spaces.archive(t.group.id)
    const res=await t.page('overview');expect(res.status).toBe(200);expect((await res.json()).space.status).toBe('archived')
    expect(t.spaces.get(t.group.id)?.status).toBe('archived')
  })

  it('returns the actual scheduler offset with consistent daily and once descriptions without changing stored times', async () => {
    const t = await fixture(-420), now = Date.UTC(2026, 8, 20)
    expect(t.routines.timezoneOffsetMinutes).toBe(-420)
    const daily = t.routines.add({ kind: 'schedule', ownerOpenId: 'alice', spaceId: t.group.id, chatId: 'group', chatType: 'group',
      name: 'Daily', prompt: 'Synthetic', schedule: { type: 'daily', at: '09:30' }, now })
    const once = t.routines.add({ kind: 'schedule', ownerOpenId: 'alice', spaceId: t.group.id, chatId: 'group', chatType: 'group',
      name: 'Once', prompt: 'Synthetic', schedule: { type: 'once', atMs: now + 30 * 60_000 }, now })
    const before = t.registry.db.prepare('SELECT * FROM routines ORDER BY id').all()
    const response = await t.page('tasks'), body = await response.json()
    expect(response.status).toBe(200)
    expect(body.data.routines.find((item: { id: number }) => item.id === daily.id)).toMatchObject({ timezoneOffsetMinutes: -420,
      schedule: '每天 09:30', progress: { next_run_at: '2026-09-20T16:30:00.000Z' } })
    expect(body.data.routines.find((item: { id: number }) => item.id === once.id)).toMatchObject({ timezoneOffsetMinutes: -420,
      schedule: '一次性 2026/9/19 17:30:00', progress: { next_run_at: '2026-09-20T00:30:00.000Z' } })
    expect(t.registry.db.prepare('SELECT * FROM routines ORDER BY id').all()).toEqual(before)
  })
})
