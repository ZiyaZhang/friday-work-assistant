import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { RoutineStore, type Routine } from '../src/core/routines.js'
import { DeliveryService } from '../src/core/delivery.js'
import { routineExecutionKey, routineDigestDeliveryKey } from '../src/core/execution-keys.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, GROUP_SCOPES, TokenIssuer } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'
import { createFakeAgent } from './helpers/fake-agent.js'

const schedule = { type: 'interval', everyMinutes: 30 }
const draft = { name: '合成每日简报', prompt: '只汇总合成验收材料', schedule }
const log = createLogger('routine-policy-api', 'error')
type PolicyRoutine = Routine & { deliveryPolicy: 'when_nonempty' | 'every_run' }

describe('routine delivery policy through HTTP API and MCP', () => {
  let registry: Registry
  let routines: RoutineStore
  let feishu: FakeFeishu
  let api: ReturnType<typeof createInternalApi>
  let baseUrl: string
  let groupToken: string
  let dmToken: string
  let client: Client
  let dmClient: Client
  let home: string
  let runtime: AcpRuntime
  let spaces: ReturnType<typeof spaceDeps>['spaces']
  let derivedSafe: boolean
  let repositoryReads: string[]
  let now: number

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'friday-routine-policy-'))
    registry = new Registry(':memory:')
    routines = new RoutineStore(registry.db)
    feishu = new FakeFeishu()
    feishu.chats = [{ chatId: 'oc_group', name: '合成测试群' }]
    feishu.members.set('oc_group', new Set(['ou_alice']))
    const tokens = new TokenIssuer('synthetic-routine-policy')
    const messageCache = new MessageCache(registry.db)
    const memory = new ChannelMemory(registry.db)
    const todos = new Todos(registry.db)
    const messages = new MessageService(asFeishuClient(feishu), messageCache, log)
    const sp = spaceDeps(registry.db)
    spaces = sp.spaces
    const group = spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_alice' })
    const dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
    const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
    now = Date.now()
    const { app } = createFakeAgent()
    let orchestrator!: Orchestrator
    runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app },
      onPermission: (request, signal) => orchestrator.handlePermission(request, signal), log })
    orchestrator = new Orchestrator({ cfg, registry, routines, memory, todos, messages, ...sp,
      feishu: asFeishuClient(feishu), runtime, tokens, apiBaseUrl: 'http://127.0.0.1:1',
      mcpServerPath: '/nonexistent/synthetic-mcp', botOpenId: 'ou_bot', log, now: () => now })
    derivedSafe = true
    repositoryReads = []
    const github = {
      repoAllowed: (repo: string) => repo === 'test-org/test-repo', repoWritable: (repo: string) => repo === 'test-org/test-repo',
      async api(_method: string, path: string) {
        return path.includes('/comments?') ? [] : { number: 301, title: '合成只读事项', state: 'open',
          html_url: 'https://github.com/test-org/test-repo/issues/301', assignees: [], labels: [] }
      },
    } as unknown as GitHubIdentity
    api = createInternalApi({ registry, routines, feishu: asFeishuClient(feishu),
      memory, messageCache, messages, todos, ...sp, tokens, log, maxHistoryPerCall: 100, github,
      canPersistDerivedState: () => derivedSafe,
      resolveActorForSession: key => {
        const row = registry.db.prepare("SELECT id, task_id, actor_open_id FROM run_attempts WHERE session_key = ? AND state = 'running' ORDER BY started_at DESC LIMIT 1").get(key)
        return row ? { requesterOpenId: String(row.actor_open_id), runId: String(row.id), taskId: Number(row.task_id), stage: 'task' } : undefined
      },
      onRepositoryRead: (_key, repo) => { repositoryReads.push(repo); derivedSafe = false },
      stopRoutine: (id, mode) => orchestrator.stopRoutine(id, mode),
      controlRoutine: (id, action) => orchestrator.controlRoutine(id, action),
      updateRoutine: (id, patch, options) => orchestrator.updateRoutine(id, patch, options) })
    registry.createSession({ sessionKey: 'msg:om_policy', chatId: 'oc_group', chatType: 'group', requesterOpenId: 'ou_alice', cwd: home, rootMessageId: 'om_policy' })
    registry.createSession({ sessionKey: 'dm:ou_alice', chatId: 'oc_dm', chatType: 'p2p', requesterOpenId: 'ou_alice', cwd: home })
    const attempts = new RunAttempts(registry.db)
    const beginFixture = (sessionKey: string, chatId: string, chatType: 'group' | 'p2p', messageId: string) => {
      const task = registry.createTaskOnce({ sessionKey, messageId, requesterOpenId: 'ou_alice', prompt: '合成职责管理',
        inbound: { eventId: messageId, messageId, chatId, chatType, msgType: 'text', text: '合成职责管理', senderOpenId: 'ou_alice', senderType: 'user', mentions: [], createTimeMs: now } }).task
      const attempt = attempts.begin({ sessionKey, workKey: registry.taskWork.get(task.id)!.key, triggerKey: `task:${task.id}`, stage: 'task', taskId: task.id, actorOpenId: 'ou_alice', now }, () => registry.startTask(task.id, now, sessionKey))!
      return attempt.id
    }
    const groupRunId = beginFixture('msg:om_policy', 'oc_group', 'group', 'om_policy')
    const dmRunId = beginFixture('dm:ou_alice', 'oc_dm', 'p2p', 'om_dm_policy')
    groupToken = tokens.issue({ sessionKey: 'msg:om_policy', runId: groupRunId, spaceId: group.id, chatId: 'oc_group', chatType: 'group', requesterOpenId: 'ou_alice', cwd: home, scopes: [...GROUP_SCOPES] })
    dmToken = tokens.issue({ sessionKey: 'dm:ou_alice', runId: dmRunId, spaceId: dm.id, chatId: 'oc_dm', chatType: 'p2p', requesterOpenId: 'ou_alice', cwd: home, scopes: [...ALL_SCOPES] })
    await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
    client = await connect(groupToken)
    dmClient = await connect(dmToken)
  })

  afterEach(async () => {
    await client.close()
    await dmClient.close()
    await new Promise<void>((resolve, reject) => api.server.close((err) => err ? reject(err) : resolve()))
    await runtime.stop()
    registry.close()
    rmSync(home, { recursive: true, force: true })
  })

  async function connect(token: string): Promise<Client> {
    const server = buildServer({ apiUrl: baseUrl, token })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const c = new Client({ name: 'routine-policy-test', version: '0.0.0' })
    await c.connect(clientTransport)
    return c
  }

  async function post<T = Record<string, unknown>>(path: string, body: Record<string, unknown>, token = groupToken): Promise<{ status: number; body: T }> {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as T }
  }

  async function tool(name: string, args: Record<string, unknown>, c = client) {
    const result = await c.callTool({ name, arguments: args })
    const content = result.content as { type: string; text?: string }[]
    return { isError: result.isError, text: content.map((item) => item.text ?? '').join('\n') }
  }

  function queryWriteSnapshot() {
    const tables = registry.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'run_api_calls' ORDER BY name").all()
    return { business: Object.fromEntries(tables.map(row => {
      const name = String(row.name)
      return [name, registry.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]
    })), calls: registry.db.prepare('SELECT * FROM run_api_calls ORDER BY id').all() }
  }

  function expectOnlyReadAuditWrites(before: ReturnType<typeof queryWriteSnapshot>) {
    const after = queryWriteSnapshot(), priorIds = new Set(before.calls.map(row => row.id))
    expect(after.business).toEqual(before.business) // Includes all task/work/routine/occurrence/inbox state.
    expect(after.calls.filter(row => priorIds.has(row.id))).toEqual(before.calls)
    const added = after.calls.filter(row => !priorIds.has(row.id))
    expect(added).toHaveLength(2) // One HTTP query and one MCP query, both using the real signed Run.
    const run = registry.db.prepare("SELECT id FROM run_attempts WHERE session_key = ? AND state = 'running'").get('msg:om_policy')!
    for (const row of added) expect(row).toMatchObject({ run_id: run.id, route: 'POST /v1/routine/list', scopes_json: '["routine:read"]', state: 'returned', operations_json: '[]' })
  }

  function rows() { return registry.db.prepare('SELECT * FROM routines ORDER BY id').all() }

  it('changes cadence with the same structured schedule through real MCP, including zero disabling', async () => {
    const r = await add()
    const changed = await tool('friday_routine_update', { id: r.id, schedule: { type: 'interval', everyMinutes: 120 }, quiet_hours: { start: '22:00', end: '08:00' } })
    expect(changed.isError, changed.text).toBeFalsy()
    expect(routines.get(r.id)?.schedule).toEqual({ type: 'interval', everyMinutes: 120, quietHours: { start: '22:00', end: '08:00' } })
    expect((await tool('friday_routine_update', { id: r.id, schedule: { type: 'daily', at: '09:00' } })).isError).toBeFalsy()
    expect(routines.get(r.id)?.schedule).toEqual({ type: 'daily', at: '09:00', quietHours: { start: '22:00', end: '08:00' } })
    expect((await tool('friday_routine_update', { id: r.id, quiet_hours: null })).isError).toBeFalsy()
    expect(routines.get(r.id)?.schedule).toEqual({ type: 'daily', at: '09:00' })
    const disabled = await tool('friday_routine_update', { id: r.id, schedule: { type: 'interval', everyMinutes: 0 } })
    expect(disabled.isError, disabled.text).toBeFalsy()
    expect(disabled.text).toContain('没有安排自动运行')
    expect(routines.get(r.id)?.enabled).toBe(false)
    expect((await post('/v1/routine/list', { id: r.id })).body).toMatchObject({ routines: [{ progress: { recovery: 'reconfigure', next_run_at: null } }] })
  })

  it('registers a zero cadence as disabled without inventing a next execution time', async () => {
    const result = await tool('friday_routine_add', { ...draft, schedule: { type: 'interval', everyMinutes: 0 } })
    expect(result.isError, result.text).toBeFalsy()
    expect(result.text).toContain('没有安排自动运行')
    expect(routines.listFor({ chatId: 'oc_group', chatType: 'group' })[0]?.enabled).toBe(false)
  })

  it('uses the same authorized watch resolver for edits without widening group identity', async () => {
    const r = await add({ kind: 'watch', chats: ['oc_group'] })
    const version = routines.configVersion(r.id)!
    expect(routines.advanceMessageCursor(r.id, version, Math.floor(r.createdAt / 1000), Math.floor(r.createdAt / 1000) + 60)).toBe(true)
    const cursor = routines.get(r.id)?.messageCursorSec
    const accepted = await tool('friday_routine_update', { id: r.id, chats: ['合成测试群'], prompt: '也关注发布阻塞' })
    expect(accepted.isError, accepted.text).toBeFalsy()
    expect(routines.get(r.id)).toMatchObject({ watchChatIds: ['oc_group'], messageCursorSec: cursor })
    const before = executionSnapshot(r.id)
    expect((await post('/v1/routine/update', { id: r.id, chats: ['oc_other'], prompt: '不能顺带修改' })).status).toBe(403)
    expect(executionSnapshot(r.id)).toEqual(before)
  })

  it('rejects a stale watch edit after a concurrent control during platform lookup', async () => {
    const r = await add({ kind: 'watch', chats: ['oc_group'] })
    const chatName = vi.spyOn(feishu, 'chatName').mockImplementation(async () => {
      routines.setEnabled(r.id, false)
      return '合成测试群'
    })
    const result = await post('/v1/routine/update', { id: r.id, chats: ['oc_group'], prompt: '不得覆盖暂停后的配置' })
    expect(result.status).toBe(409)
    expect(routines.get(r.id)).toMatchObject({ enabled: false, prompt: draft.prompt })
    chatName.mockRestore()
  })

  async function add(body: Record<string, unknown> = {}): Promise<PolicyRoutine> {
    const result = await post<{ routine: PolicyRoutine }>('/v1/routine/add', { kind: 'schedule', ...draft, ...body })
    expect(result.status).toBe(200)
    return result.body.routine
  }

  async function addFollowup(): Promise<Routine> {
    const added = await tool('friday_schedule_followup', { note: '合成一次性恢复边界', in_minutes: 1 })
    expect(added.isError, added.text).toBeFalsy()
    const [routine] = routines.followupsFor('msg:om_policy')
    expect(routine).toBeDefined()
    return routine!
  }

  function executionSnapshot(id: number) {
    return { rows: rows(), version: routines.configVersion(id),
      occurrences: registry.db.prepare('SELECT * FROM routine_occurrences ORDER BY id').all() }
  }

  async function expectResumeConflict(id: number) {
    const before = executionSnapshot(id)
    expect((await post('/v1/routine/control', { id, action: 'resume' })).status).toBe(409)
    expect(executionSnapshot(id)).toEqual(before)
    expect((await tool('friday_routine_control', { id, action: 'resume' })).isError).toBe(true)
    expect(executionSnapshot(id)).toEqual(before)
  }

  it('defaults schedule and watch to when_nonempty and exposes it in list and detail', async () => {
    const scheduled = await add()
    const watched = await add({ kind: 'watch', name: '合成关注', chats: ['oc_group'] })
    expect(scheduled.deliveryPolicy).toBe('when_nonempty')
    expect(watched.deliveryPolicy).toBe('when_nonempty')
    const listed = await post<{ routines: PolicyRoutine[] }>('/v1/routine/list', {})
    expect(listed.status).toBe(200)
    expect(listed.body.routines).toHaveLength(2)
    expect(listed.body.routines.every((r) => r.deliveryPolicy === 'when_nonempty')).toBe(true)
    for (const r of [scheduled, watched]) {
      const detail = await tool('friday_routine_list', { id: r.id })
      expect(detail.isError).toBeFalsy()
      expect(JSON.parse(detail.text)).toMatchObject({ id: r.id, delivery_policy: 'when_nonempty' })
    }
    expect((await tool('friday_routine_list', {})).text).toContain('有内容才发送')
  })

  it('persists an explicit daily policy from MCP creation and reports the actual policy', async () => {
    const created = await tool('friday_routine_add', { ...draft, delivery_policy: 'every_run' })
    expect(created.isError).toBeFalsy()
    expect(created.text).toContain('每次发送')
    const [r] = routines.listFor({ chatId: 'oc_group', chatType: 'group', ownerOpenId: 'ou_alice' })
    expect(r).toMatchObject({ deliveryPolicy: 'every_run', prompt: draft.prompt, schedule })
    expect(JSON.parse((await tool('friday_routine_list', { id: r!.id })).text)).toMatchObject({ delivery_policy: 'every_run' })
    expect((await tool('friday_routine_list', {})).text).toContain('每次发送')
    const { body } = await post<{ routines: PolicyRoutine[] }>('/v1/routine/list', {})
    expect(body.routines[0]?.deliveryPolicy).toBe('every_run')
  })

  it('reports a paused responsibility cursor and identity without advertising a scheduled run or changing it', async () => {
    const r = await add({ kind: 'watch', chats: ['oc_group'] })
    const version = routines.configVersion(r.id)!
    const cursor = Math.floor(r.createdAt / 1000) + 60
    routines.advanceMessageCursor(r.id, version, Math.floor(r.createdAt / 1000), cursor)
    await tool('friday_routine_control', { id: r.id, action: 'pause' })
    const before = executionSnapshot(r.id)
    const writes = queryWriteSnapshot()
    const response = await post<{ routines: { progress: Record<string, unknown> }[] }>('/v1/routine/list', { id: r.id })
    const detail = JSON.parse((await tool('friday_routine_list', { id: r.id })).text)
    expect(detail.progress).toMatchObject({ run_as: 'ou_alice', message_cursor_at: new Date(cursor * 1000).toISOString(),
      last_status: null, next_run_at: null, latest_occurrence: null, recovery: 'resume',
      can_resume_execution: true, resume_block_reason: null })
    expect(response.body.routines[0]?.progress).toEqual(detail.progress)
    expect(detail.next_run_at).toBeNull()
    expect(executionSnapshot(r.id)).toEqual(before)
    expectOnlyReadAuditWrites(writes)
  })

  it('shows interrupted execution as requiring inspection and does not resume or replay it on read', async () => {
    const r = await add()
    const occurrence = routines.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    routines.startOccurrence(occurrence.id, r.nextRunAt)
    routines.recoverInterruptedOccurrences(r.nextRunAt + 1)
    const before = executionSnapshot(r.id)
    const writes = queryWriteSnapshot()
    const resume = routines.resumeState(r.id)!
    expect(resume.kind).toBe('inspect_previous_run')
    const response = await post<{ routines: { progress: Record<string, unknown> }[] }>('/v1/routine/list', { id: r.id })
    const detail = JSON.parse((await tool('friday_routine_list', { id: r.id })).text)
    expect(detail.progress).toMatchObject({ last_status: null, next_run_at: null,
      latest_occurrence: { id: occurrence.id, status: 'interrupted' }, recovery: 'inspect_previous_run',
      can_resume_execution: false, resume_block_reason: 'reason' in resume ? resume.reason : undefined })
    expect(response.body.routines[0]?.progress).toEqual(detail.progress)
    expect(detail.next_run_at).toBeNull()
    expect(executionSnapshot(r.id)).toEqual(before)
    expectOnlyReadAuditWrites(writes)
    await expectResumeConflict(r.id)
  })

  it('returns a real managed send receipt through HTTP and MCP even after an interrupted occurrence, with no query writes', async () => {
    const r = await add()
    const occurrence = routines.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!
    routines.startOccurrence(occurrence.id, r.nextRunAt)
    const key = routineExecutionKey(r.id, { occurrenceId: occurrence.id, configVersion: occurrence.configVersion })
    const sp = spaceDeps(registry.db), space = spaces.byChat('oc_group')!
    let posts = 0
    const ledger = new DeliveryService(registry.db, { ...sp, now: () => now,
      resolveContext: async () => ({ actorOpenId: 'ou_alice', audience: { kind: 'group', spaceId: space.id, chatId: 'oc_group' },
        sources: [{ ref: 'synthetic-result', spaceId: space.id, chatId: 'oc_group' }], provenanceComplete: true, expiresAt: now + 60_000 }),
      send: async () => { posts++; return { remoteId: 'om_actual_synthetic_ack' } },
    })
    await ledger.deliver({ key: routineDigestDeliveryKey(key), contextRef: key, payload: { text: '合成已投递结果' } })
    routines.recoverInterruptedOccurrences(r.nextRunAt + 1)
    const before = executionSnapshot(r.id), writes = queryWriteSnapshot()
    const response = await post<{ routines: { progress: Record<string, unknown> }[] }>('/v1/routine/list', { id: r.id })
    const detail = JSON.parse((await tool('friday_routine_list', { id: r.id })).text)
    expect(response.body.routines[0]?.progress).toEqual(detail.progress)
    expect(detail.progress).toMatchObject({ last_status: null, can_resume_execution: false,
      latest_occurrence: { status: 'interrupted' }, managed_delivery: { coverage: 'gateway_messages_only', record_status: 'recorded',
        items: [{ kind: 'summary', status: 'sent', remote_id: 'om_actual_synthetic_ack' }] } })
    expect(detail.progress.fact_summary).toContain('已获平台发送回执')
    expect(detail.progress.next_step).toContain('先核对')
    expect(executionSnapshot(r.id)).toEqual(before)
    expectOnlyReadAuditWrites(writes)
    expect(posts).toBe(1)
    expect((await post('/v1/routine/list', { id: r.id }, dmToken)).body).toMatchObject({ routines: [] })
  })

  it.each(['pending', 'running'] as const)('reports waiting for a %s once execution without changing it through HTTP or MCP', async (status) => {
    const r = await addFollowup()
    now = r.nextRunAt + 1
    const occurrence = routines.claimDueOccurrence(r.id, r.nextRunAt, now)!
    if (status === 'running') routines.startOccurrence(occurrence.id, now)
    const before = executionSnapshot(r.id)
    const writes = queryWriteSnapshot()
    const response = await post<{ routines: { progress: { recovery: string } }[] }>('/v1/routine/list', { id: r.id })
    expect(response.status).toBe(200)
    const resume = routines.resumeState(r.id)!
    expect(response.body.routines[0]?.progress).toMatchObject({ recovery: 'wait', latest_occurrence: { id: occurrence.id, status },
      can_resume_execution: false, resume_block_reason: 'reason' in resume ? resume.reason : undefined })
    expect(JSON.parse((await tool('friday_routine_list', { id: r.id })).text).progress).toEqual(response.body.routines[0]?.progress)
    expect(executionSnapshot(r.id)).toEqual(before)
    expectOnlyReadAuditWrites(writes)
    await expectResumeConflict(r.id)
  })

  it('accepts one minute from now even when the clock advances during the HTTP call', async () => {
    let ticking = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => ticking++)
    try {
      const created = await addFollowup()
      expect(created.schedule.type).toBe('once')
      expect(created.nextRunAt).toBeGreaterThan(ticking)
      expect(routines.followupsFor('msg:om_policy')).toHaveLength(1)
    } finally { clock.mockRestore() }
  })

  it('offers resume after a completed once task receives a new schedule, without changing state on either query', async () => {
    const r = await addFollowup()
    now = r.nextRunAt + 1
    const occurrence = routines.claimDueOccurrence(r.id, r.nextRunAt, now)!
    routines.startOccurrence(occurrence.id, now)
    routines.finishOccurrence(occurrence.id, 'ok', now + 1)
    const atMs = now + 86_400_000
    routines.update(r.id, { schedule: { type: 'once', atMs } }, now + 2)
    const before = executionSnapshot(r.id)
    const writes = queryWriteSnapshot()
    const response = await post<{ routines: { progress: { recovery: string } }[] }>('/v1/routine/list', { id: r.id })
    expect(response.status).toBe(200)
    expect(response.body.routines[0]?.progress).toMatchObject({ recovery: 'resume', latest_occurrence: { id: occurrence.id, status: 'ok' },
      can_resume_execution: true, resume_block_reason: null })
    expect(JSON.parse((await tool('friday_routine_list', { id: r.id })).text).progress).toEqual(response.body.routines[0]?.progress)
    expect(executionSnapshot(r.id)).toEqual(before)
    expectOnlyReadAuditWrites(writes)
    expect((await tool('friday_routine_control', { id: r.id, action: 'resume' })).isError).toBeFalsy()
    expect(routines.get(r.id)).toMatchObject({ id: r.id, enabled: true, schedule: { type: 'once', atMs }, nextRunAt: atMs, runs: 1 })
    expect(routines.getOccurrence(occurrence.id)).toMatchObject({ status: 'ok' })
    expect(routines.listOccurrences(r.id)).toHaveLength(1)
  })

  it.each([undefined, 'every_run'] as const)('keeps the watch MCP policy %s instead of silently dropping it', async (policy) => {
    const created = await tool('friday_watch_add', { chats: ['oc_group'], topic: '合成排期', schedule,
      ...(policy ? { delivery_policy: policy } : {}) })
    expect(created.isError).toBeFalsy()
    expect(created.text).toContain(policy ? '每次发送' : '有内容才发送')
    const [r] = routines.listFor({ chatId: 'oc_group', chatType: 'group', ownerOpenId: 'ou_alice' })
    expect(r).toMatchObject({ kind: 'watch', deliveryPolicy: policy ?? 'when_nonempty', watchChatIds: ['oc_group'] })
  })

  it('updates only policy through HTTP without resetting the cursor, prompt, schedule or next run', async () => {
    const created = await add({ kind: 'watch', chats: ['oc_group'] })
    const start = Math.floor(created.createdAt / 1000)
    expect(routines.advanceMessageCursor(created.id, routines.configVersion(created.id)!, start, start + 10)).toBe(true)
    const before = routines.get(created.id)!
    const version = routines.configVersion(created.id)!
    const updated = await post('/v1/routine/update', { id: created.id, delivery_policy: 'every_run' })
    expect(updated.status).toBe(200)
    expect(updated.body).toMatchObject({ delivery_policy: 'every_run', changed: ['deliveryPolicy'] })
    expect(routines.configVersion(created.id)).toBe(version + 1)
    expect(routines.get(created.id)).toMatchObject({ deliveryPolicy: 'every_run', messageCursorSec: before.messageCursorSec,
      name: before.name, prompt: before.prompt, schedule: before.schedule, nextRunAt: before.nextRunAt, watchChatIds: before.watchChatIds })
    expect(JSON.parse((await tool('friday_routine_list', { id: created.id })).text)).toMatchObject({ delivery_policy: 'every_run' })
  })

  it('accepts policy-only MCP updates and preserves the selected policy on later name-only edits', async () => {
    const r = await add()
    const beforeVersion = routines.configVersion(r.id)!
    const updated = await tool('friday_routine_update', { id: r.id, delivery_policy: 'every_run' })
    expect(updated.isError).toBeFalsy()
    expect(updated.text).toContain('每次发送')
    expect(routines.configVersion(r.id)).toBe(beforeVersion + 1)
    expect((await tool('friday_routine_update', { id: r.id, name: '合成新名字' })).isError).toBeFalsy()
    expect(routines.get(r.id)).toMatchObject({ name: '合成新名字', deliveryPolicy: 'every_run', prompt: r.prompt, schedule: r.schedule, nextRunAt: r.nextRunAt })
    const quiet = await tool('friday_routine_update', { id: r.id, delivery_policy: 'when_nonempty' })
    expect(quiet.isError).toBeFalsy()
    expect(quiet.text).toContain('有内容才发送')
    expect(JSON.parse((await tool('friday_routine_list', { id: r.id })).text)).toMatchObject({ delivery_policy: 'when_nonempty' })
  })

  it('retains every_run in a proposed responsibility without activating it', async () => {
    const proposed = await tool('friday_responsibility_propose', { ...draft, reason: '合成重复需求', delivery_policy: 'every_run' })
    expect(proposed.isError).toBeFalsy()
    expect(proposed.text).toContain('每次发送')
    expect(rows()).toHaveLength(1)
    const r = routines.get(Number((rows()[0] as { id: number }).id))!
    expect(r).toMatchObject({ deliveryPolicy: 'every_run', status: 'proposed', prompt: draft.prompt })
    // Existing proposals retain enabled=true; status is the activation and execution gate.
    expect(routines.due(r.nextRunAt + 1).some((item) => item.id === r.id)).toBe(false)
    expect(routines.currentForExecution(r.id, routines.configVersion(r.id)!)).toBeUndefined()
    expect(feishu.of('replyCard')).toHaveLength(1)
    const proposedDetail = await tool('friday_routine_list', { id: r.id })
    expect(JSON.parse(proposedDetail.text)).toMatchObject({ progress: { next_run_at: null, recovery: 'resolve_proposal' } })
    const listed = await post<{ routines: PolicyRoutine[] }>('/v1/routine/list', {})
    expect(listed.body.routines.find((item) => item.id === r.id)?.deliveryPolicy).toBe('every_run')
  })

  it.each(['always', '', null, 1, { every_run: true }])('rejects invalid API policy %j before mutating or publishing', async (value) => {
    const existing = await add()
    const before = rows()
    for (const [path, body] of [
      ['/v1/routine/add', { ...draft, kind: 'schedule' }],
      ['/v1/routine/update', { id: existing.id, prompt: '不得覆盖原指令' }],
      ['/v1/responsibility/propose', { ...draft, reason: '合成提案' }],
    ] as const) {
      const result = await post(path, { ...body, delivery_policy: value })
      expect(result.status, path).toBe(400)
      expect(rows(), path).toEqual(before)
      expect(feishu.sent, path).toHaveLength(0)
    }
  })

  it('rejects invalid MCP policy for every exposed write tool without falling back to defaults', async () => {
    const existing = await add()
    const before = rows()
    const calls = [
      ['friday_routine_add', draft],
      ['friday_watch_add', { chats: ['oc_group'], topic: '合成关注' }],
      ['friday_routine_update', { id: existing.id, prompt: '不得覆盖原指令' }],
      ['friday_responsibility_propose', { ...draft, reason: '合成提案' }],
    ] as const
    for (const [name, args] of calls) {
      const result = await tool(name, { ...args, delivery_policy: 'always' })
      expect(result.isError, name).toBe(true)
      expect(result.text, name).toMatch(/delivery_policy|validation|Invalid/i)
      expect(rows(), name).toEqual(before)
      expect(feishu.sent, name).toHaveLength(0)
    }
  })

  it('keeps followup creation working but rejects policy changes without any mutation', async () => {
    const added = await tool('friday_schedule_followup', { note: '合成一次性跟进', in_minutes: 10 })
    expect(added.isError).toBeFalsy()
    expect(added.text).toContain('已安排跟进')
    const [r] = routines.followupsFor('msg:om_policy')
    expect(r).toMatchObject({ kind: 'followup', prompt: '合成一次性跟进', sessionKey: 'msg:om_policy', schedule: { type: 'once' } })
    const before = rows()
    const denied = await post('/v1/routine/update', { id: r!.id, delivery_policy: 'every_run', prompt: '不得顺带修改' })
    expect(denied.status).toBe(400)
    expect(rows()).toEqual(before)
    expect((await tool('friday_routine_update', { id: r!.id, delivery_policy: 'every_run' })).isError).toBe(true)
    expect(rows()).toEqual(before)
  })

  it('does not let a DM read or change a group responsibility by supplying a policy', async () => {
    const r = await add({ delivery_policy: 'every_run' })
    const before = rows()
    expect((await post('/v1/routine/update', { id: r.id, delivery_policy: 'when_nonempty' }, dmToken)).status).toBe(404)
    expect(rows()).toEqual(before)
    expect((await tool('friday_routine_list', { id: r.id }, dmClient)).text).toBe('当前范围没有这条定时任务')
  })

  it.each(['http', 'mcp'] as const)('pauses, resumes the same record, and deletes only explicitly through %s', async (transport) => {
    const r = await add({ kind: 'watch', chats: ['oc_group'], delivery_policy: 'every_run' })
    const other = await add({ name: '必须保留的另一职责' })
    const start = Math.floor(r.createdAt / 1000)
    expect(routines.advanceMessageCursor(r.id, routines.configVersion(r.id)!, start, start + 45)).toBe(true)
    const before = routines.get(r.id)!
    const control = async (action: string) => {
      if (transport === 'http') expect((await post('/v1/routine/control', { id: r.id, action })).status).toBe(200)
      else expect((await tool('friday_routine_control', { id: r.id, action })).isError).toBeFalsy()
    }
    await control('pause')
    expect(routines.get(r.id)).toMatchObject({ id: r.id, enabled: false, disabledReason: '手动停用', messageCursorSec: start + 45,
      prompt: before.prompt, schedule: before.schedule, deliveryPolicy: before.deliveryPolicy, watchChatIds: before.watchChatIds })
    expect(rows()).toHaveLength(2)
    await control('resume')
    expect(routines.get(r.id)).toMatchObject({ id: r.id, enabled: true, disabledReason: null, messageCursorSec: start + 45,
      prompt: before.prompt, schedule: before.schedule, deliveryPolicy: before.deliveryPolicy, watchChatIds: before.watchChatIds })
    expect(rows()).toHaveLength(2)
    expect(routines.get(other.id)).toEqual(other)
    await control('delete')
    expect(routines.get(r.id)).toBeUndefined()
    expect(rows()).toHaveLength(1)
    expect(routines.get(other.id)).toEqual(other)
  })

  it.each([undefined, '', 'off', null, true])('rejects missing or invalid control action %j in HTTP and MCP without changing state', async (action) => {
    const r = await add()
    const before = rows()
    const args = { id: r.id, ...(action === undefined ? {} : { action }) }
    expect((await post('/v1/routine/control', args)).status).toBe(400)
    expect(rows()).toEqual(before)
    expect((await tool('friday_routine_control', args)).isError).toBe(true)
    expect(rows()).toEqual(before)
  })

  it.each([undefined, 'false', null, 0, {}])('does not delete through legacy remove when disable_only is missing or invalid: %j', async (disableOnly) => {
    const r = await add()
    const before = rows()
    const args = { id: r.id, ...(disableOnly === undefined ? {} : { disable_only: disableOnly }) }
    expect((await post('/v1/routine/remove', args)).status).toBe(400)
    expect(rows()).toEqual(before)
    expect((await tool('friday_routine_remove', args)).isError).toBe(true)
    expect(rows()).toEqual(before)
  })

  it.each(['http', 'mcp'] as const)('keeps legacy explicit true=pause and false=delete compatible through %s', async (transport) => {
    const r = await add()
    const remove = async (disableOnly: boolean) => {
      if (transport === 'http') expect((await post('/v1/routine/remove', { id: r.id, disable_only: disableOnly })).status).toBe(200)
      else expect((await tool('friday_routine_remove', { id: r.id, disable_only: disableOnly })).isError).toBeFalsy()
    }
    await remove(true)
    expect(routines.get(r.id)).toMatchObject({ id: r.id, enabled: false, disabledReason: '手动停用' })
    await remove(false)
    expect(routines.get(r.id)).toBeUndefined()
  })

  it('does not turn an unaccepted responsibility proposal into an active routine via resume', async () => {
    expect((await tool('friday_responsibility_propose', { ...draft, reason: '合成待接受提案' })).isError).toBeFalsy()
    const r = routines.listFor({ chatId: 'oc_group', chatType: 'group', ownerOpenId: 'ou_alice' }).find((item) => item.status === 'proposed')!
    expect(r).toBeDefined()
    const before = rows()
    expect([400, 409]).toContain((await post('/v1/routine/control', { id: r.id, action: 'resume' })).status)
    expect(rows()).toEqual(before)
    expect((await tool('friday_routine_control', { id: r.id, action: 'resume' })).isError).toBe(true)
    expect(rows()).toEqual(before)
    expect(routines.due(r.nextRunAt + 1).some((item) => item.id === r.id)).toBe(false)
  })

  it('does not resume a responsibility after its space was archived', async () => {
    const r = await add()
    expect((await tool('friday_routine_control', { id: r.id, action: 'pause' })).isError).toBeFalsy()
    spaces.archive(spaces.byChat('oc_group')!.id)
    const before = rows()
    expect((await post('/v1/routine/control', { id: r.id, action: 'resume' })).status).toBe(403)
    expect(rows()).toEqual(before)
    expect((await tool('friday_routine_control', { id: r.id, action: 'resume' })).isError).toBe(true)
    expect(rows()).toEqual(before)
    expect(routines.get(r.id)?.enabled).toBe(false)
  })

  it('allows explicit pause after reading GitHub while keeping add and update source restrictions', async () => {
    const r = await add()
    const before = rows()
    expect((await tool('github_get_issue', { repo: 'test-org/test-repo', number: 301 })).isError).toBeFalsy()
    expect(repositoryReads).toEqual(['test-org/test-repo'])
    expect(derivedSafe).toBe(false)
    expect((await post('/v1/routine/add', { ...draft, name: '不得新增' })).status).toBe(403)
    expect((await post('/v1/routine/update', { id: r.id, prompt: '不得覆盖原指令' })).status).toBe(403)
    expect(rows()).toEqual(before)
    expect((await tool('friday_routine_control', { id: r.id, action: 'pause' })).isError).toBeFalsy()
    expect(routines.get(r.id)).toMatchObject({ id: r.id, enabled: false, prompt: r.prompt, schedule: r.schedule })
    expect(rows()).toHaveLength(1)
  })

  it('does not allow a private-chat actor to control a group routine by id', async () => {
    const r = await add()
    const before = rows()
    for (const action of ['pause', 'resume', 'delete']) {
      expect((await post('/v1/routine/control', { id: r.id, action }, dmToken)).status).toBe(404)
      expect((await tool('friday_routine_control', { id: r.id, action }, dmClient)).isError).toBe(true)
      expect(rows()).toEqual(before)
    }
  })

  it.each(['pending', 'running'] as const)('does not cancel or requeue a once occurrence that is %s through resume', async (status) => {
    const r = await addFollowup()
    now = r.nextRunAt + 1
    const occurrence = routines.claimDueOccurrence(r.id, r.nextRunAt, now)!
    expect(occurrence).toBeDefined()
    if (status === 'running') expect(routines.startOccurrence(occurrence.id, now)).toBeDefined()
    expect(routines.getOccurrence(occurrence.id)?.status).toBe(status)
    expect(routines.get(r.id)).toMatchObject({ enabled: false, disabledReason: '一次性任务待执行' })
    await expectResumeConflict(r.id)
    expect(routines.due(now + 60_000).some((item) => item.id === r.id)).toBe(false)
  })

  it('does not requeue a completed once task, including after an explicit pause', async () => {
    const r = await addFollowup()
    now = r.nextRunAt + 1
    const occurrence = routines.claimDueOccurrence(r.id, r.nextRunAt, now)!
    expect(routines.startOccurrence(occurrence.id, now)).toBeDefined()
    routines.finishOccurrence(occurrence.id, 'ok', now + 1)
    expect(routines.get(r.id)).toMatchObject({ enabled: false, lastStatus: 'ok', runs: 1 })
    await expectResumeConflict(r.id)
    expect((await post('/v1/routine/control', { id: r.id, action: 'pause' })).status).toBe(200)
    await expectResumeConflict(r.id)
    expect(routines.due(now + 60_000).some((item) => item.id === r.id)).toBe(false)
  })

  it.each(['interrupted', 'failed_unknown'] as const)('does not turn a once %s result into an automatic retry through resume', async (status) => {
    const r = await addFollowup()
    now = r.nextRunAt + 1
    const occurrence = routines.claimDueOccurrence(r.id, r.nextRunAt, now)!
    expect(routines.startOccurrence(occurrence.id, now)).toBeDefined()
    if (status === 'interrupted') {
      expect(routines.recoverInterruptedOccurrences(now + 1)).toHaveLength(1)
      expect(routines.getOccurrence(occurrence.id)?.status).toBe('interrupted')
    } else {
      // This is the scheduler's persisted failure receipt, not a claim that a network send was exercised here.
      routines.finishOccurrence(occurrence.id, 'failed', now + 1, '投递结果未知：远端可能已接收，需先核对回执')
      expect(routines.getOccurrence(occurrence.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('结果未知') })
    }
    await expectResumeConflict(r.id)
    expect((await post('/v1/routine/control', { id: r.id, action: 'pause' })).status).toBe(200)
    expect(routines.get(r.id)?.disabledReason).toBe('手动停用')
    await expectResumeConflict(r.id)
    expect(routines.due(now + 60_000).some((item) => item.id === r.id)).toBe(false)
  })

  it.each(['http', 'mcp'] as const)('resumes a manually paused unfinished once task under its original id when its time has passed through %s', async (transport) => {
    const r = await addFollowup()
    expect((await post('/v1/routine/control', { id: r.id, action: 'pause' })).status).toBe(200)
    const pausedVersion = routines.configVersion(r.id)!
    now = r.nextRunAt + 60_000
    if (transport === 'http') expect((await post('/v1/routine/control', { id: r.id, action: 'resume' })).status).toBe(200)
    else expect((await tool('friday_routine_control', { id: r.id, action: 'resume' })).isError).toBeFalsy()
    expect(routines.get(r.id)).toMatchObject({ id: r.id, enabled: true, disabledReason: null, nextRunAt: now,
      schedule: r.schedule, sessionKey: r.sessionKey, prompt: r.prompt, messageCursorSec: r.messageCursorSec, runs: 0 })
    expect(routines.configVersion(r.id)).toBe(pausedVersion + 1)
    expect(rows()).toHaveLength(1)
    expect(routines.listOccurrences(r.id)).toEqual([])
    expect(routines.due(now).map((item) => item.id)).toContain(r.id)
    const occurrence = routines.claimDueOccurrence(r.id, now, now)!
    expect(occurrence).toMatchObject({ routineId: r.id, status: 'pending' })
    expect(routines.startOccurrence(occurrence.id, now)).toMatchObject({ id: r.id })
  })

  it('treats repeated resume of an enabled interval as a no-op without cancelling its running occurrence', async () => {
    const r = await add()
    now = r.nextRunAt + 1
    const occurrence = routines.claimDueOccurrence(r.id, r.nextRunAt, now)!
    expect(routines.startOccurrence(occurrence.id, now)).toBeDefined()
    expect(routines.get(r.id)?.enabled).toBe(true)
    const before = executionSnapshot(r.id)
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await post('/v1/routine/control', { id: r.id, action: 'resume' })).status).toBe(200)
      expect(executionSnapshot(r.id)).toEqual(before)
      expect((await tool('friday_routine_control', { id: r.id, action: 'resume' })).isError).toBeFalsy()
      expect(executionSnapshot(r.id)).toEqual(before)
    }
    expect(routines.currentForExecution(r.id, occurrence.configVersion, occurrence.id)).toBeDefined()
    expect(routines.getOccurrence(occurrence.id)?.status).toBe('running')
  })
})
