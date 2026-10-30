/**
 * 职责接进宿主的四件事：暂停到某时（HTTP / MCP）、到点恢复与恢复不了时的通知、连续失败停用后的通知，
 * 以及定时类职责的读取窗口从上次成功算起。真实 Orchestrator、RoutineStore、投递账本；飞书与 ACP 合成。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { Inbox } from '../src/core/inbox.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { MAX_PAUSE_MS, RoutineScheduler, RoutineStore, type Routine } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { buildServer } from '../src/mcp/server.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const NOW = Date.UTC(2026, 8, 21, 1)
const log = createLogger('routine-host-wiring', 'error')
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

function hostFixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-routine-host-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(join(home, 'test.sqlite'))
  const routines = new RoutineStore(registry.db), inbox = new Inbox(registry.db), sp = spaceDeps(registry.db)
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_alice', title: '合成群' })
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
  const feishu = new FakeFeishu()
  feishu.members.set('oc_group', new Set(['ou_alice']))
  const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: '合成日报正文' }] })
  const clock = { now: NOW }
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, registry, routines, inbox, ...sp, memory: new ChannelMemory(registry.db), feishu: asFeishuClient(feishu),
    runtime, tokens: new TokenIssuer('synthetic'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log, now: () => clock.now })
  cleanup.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const add = (over: Partial<Parameters<RoutineStore['add']>[0]> = {}) => routines.add({ kind: 'schedule', ownerOpenId: 'ou_alice',
    spaceId: dm.id, chatId: 'oc_dm', chatType: 'p2p', deliverTo: 'dm', name: '合成日报', prompt: '总结昨天的讨论',
    schedule: { type: 'daily', at: '09:00' }, now: clock.now, ...over })
  const notices = () => feishu.of('sendToUser').map(item => ({ to: item.target, text: (item.payload as { text?: string }).text ?? '' }))
  return { registry, routines, inbox, ...sp, group, dm, feishu, state, clock, orchestrator, add, notices }
}

describe('pause until an agreed time', () => {
  it('resumes at the agreed time with the same checks as a manual resume, and tells the owner once when it cannot', async () => {
    const t = hostFixture()
    const own = t.add(), grouped = t.add({ name: '群里的周报', spaceId: t.group.id, chatId: 'oc_group', chatType: 'group', deliverTo: 'chat' })
    t.orchestrator.controlRoutine(own.id, 'pause', { resumeAt: NOW + 3600_000 })
    t.orchestrator.controlRoutine(grouped.id, 'pause', { resumeAt: NOW + 3600_000 })
    expect(t.routines.get(own.id)).toMatchObject({ enabled: false, resumeAt: NOW + 3600_000, schedule: { type: 'daily' } })
    expect(await t.orchestrator.resumeDueRoutines()).toBe(0)
    t.spaces.suspend(t.group.id)
    t.clock.now = NOW + 2 * 3600_000
    expect(await t.orchestrator.resumeDueRoutines()).toBe(1)
    expect(t.routines.get(own.id)).toMatchObject({ enabled: true, resumeAt: null })
    expect(t.routines.get(grouped.id)).toMatchObject({ enabled: false, disabledReason: '手动停用', resumeAt: null })
    expect(t.notices()).toEqual([{ to: 'ou_alice', text: expect.stringContaining('「群里的周报」本来约好') }])
    expect(t.notices()[0]!.text).toContain('空间已停用')
    expect(t.notices()[0]!.text).toContain('目前仍暂停')
    // The agreed time was cleared: the same failure is not retried or reported every minute.
    t.clock.now += 60_000
    expect(await t.orchestrator.resumeDueRoutines()).toBe(0)
    expect(t.notices()).toHaveLength(1)
  })

  it('an indefinite pause clears an earlier agreed time; resume_at is only for pause and at most 90 days ahead', async () => {
    const t = hostFixture()
    const r = t.add()
    const menu = async () => {
      await t.orchestrator.handleMenu({ eventKey: 'my_tasks', operatorOpenId: 'ou_alice', raw: {} })
      return (t.feishu.of('sendToUser').at(-1)!.payload as { markdown: string }).markdown
    }
    t.orchestrator.controlRoutine(r.id, 'pause', { resumeAt: NOW + 86_400_000 })
    expect(await menu()).toMatch(/合成日报：已暂停，.* 自动恢复/)
    t.orchestrator.controlRoutine(r.id, 'pause')
    expect(t.routines.get(r.id)).toMatchObject({ enabled: false, resumeAt: null })
    expect(await menu()).not.toContain('自动恢复')
    expect(() => t.orchestrator.controlRoutine(r.id, 'resume', { resumeAt: NOW + 86_400_000 })).toThrow('只有暂停')
    expect(() => t.orchestrator.controlRoutine(r.id, 'pause', { resumeAt: NOW + MAX_PAUSE_MS + 60_000 })).toThrow('90 天')
  })
})

describe('routine stopped after repeated failures', () => {
  it('tells the owner once through the delivery ledger, records a pending item, and settles it when the owner resumes', async () => {
    const t = hostFixture()
    const r = t.add({ schedule: { type: 'interval', everyMinutes: 10 } })
    const pending: Promise<void>[] = []
    const scheduler = new RoutineScheduler({ store: t.routines, log, now: () => t.clock.now,
      run: async () => { throw new Error('模型暂不可用') },
      onDisabled: (routine, reason) => { pending.push(t.orchestrator.notifyRoutineDisabled(routine, reason)) } })
    for (let i = 0; i < 3; i++) {
      t.clock.now = t.routines.get(r.id)!.nextRunAt
      await scheduler.tick()
    }
    await Promise.all(pending)
    expect(t.routines.get(r.id)).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/^连续失败 3 次/) })
    expect(pending).toHaveLength(1)
    expect(t.notices()).toEqual([{ to: 'ou_alice', text: expect.stringContaining('「合成日报」连续失败 3 次') }])
    expect(t.notices()[0]!.text).toContain('已自动停用')
    const version = t.routines.configVersion(r.id)
    expect(t.registry.db.prepare('SELECT status FROM deliveries WHERE delivery_key = ?').get(`routine-disabled:${r.id}:${version}`)).toEqual({ status: 'sent' })
    expect(t.inbox.pending('ou_alice')).toMatchObject([{ kind: 'other', refId: r.id, title: '职责「合成日报」连续失败，已停用' }])
    // A second report of the same stop is not a second message.
    await t.orchestrator.notifyRoutineDisabled(t.routines.get(r.id)!, t.routines.get(r.id)!.disabledReason!)
    expect(t.notices()).toHaveLength(1)
    t.orchestrator.controlRoutine(r.id, 'resume')
    expect(t.inbox.pending('ou_alice')).toEqual([])
  })

  it('does not tell anyone when the routine was already resumed before the notice could go out', async () => {
    const t = hostFixture()
    const r = t.add()
    t.registry.db.prepare("UPDATE routines SET enabled = 0, disabled_reason = '连续失败 3 次：合成' WHERE id = ?").run(r.id)
    const stopped = t.routines.get(r.id)!
    t.orchestrator.controlRoutine(r.id, 'resume')
    await t.orchestrator.notifyRoutineDisabled(stopped, stopped.disabledReason!)
    expect(t.notices()).toEqual([])
    expect(t.inbox.pending('ou_alice')).toEqual([])
  })
})

describe('schedule read window after a failure', () => {
  it('starts from the last successful end, not from the failed run', async () => {
    const t = hostFixture()
    const r = t.add({ schedule: { type: 'interval', everyMinutes: 60 } })
    const success = NOW + 3600_000, failure = NOW + 2 * 3600_000
    t.registry.db.prepare("UPDATE routines SET last_run_at = ?, last_success_at = ?, last_status = 'failed', fail_count = 1 WHERE id = ?").run(failure, success, r.id)
    t.clock.now = NOW + 3 * 3600_000
    await t.orchestrator.runRoutine(t.routines.get(r.id)!, { manualMessageId: 'om_window' })
    const prompt = t.state.allPrompts.at(-1)!.text
    const since = (ms: number) => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    expect(prompt).toContain(`上次成功运行：${since(success)}`)
    expect(prompt).not.toContain(since(failure))
  })
})

describe('resume_at through the signed API and MCP', () => {
  async function apiFixture() {
    const t = hostFixture()
    const tokens = new TokenIssuer('synthetic-resume-at'), messageCache = new MessageCache(t.registry.db)
    const api = createInternalApi({ registry: t.registry, routines: t.routines, feishu: asFeishuClient(t.feishu), memory: new ChannelMemory(t.registry.db),
      messageCache, messages: new MessageService(asFeishuClient(t.feishu), messageCache, log), todos: new Todos(t.registry.db),
      spaces: t.spaces, policy: t.policy, tokens, log, maxHistoryPerCall: 20,
      resolveActorForSession: key => {
        const row = t.registry.db.prepare("SELECT id, task_id, actor_open_id FROM run_attempts WHERE session_key = ? AND state = 'running' ORDER BY started_at DESC LIMIT 1").get(key)
        return row ? { requesterOpenId: String(row.actor_open_id), runId: String(row.id), taskId: Number(row.task_id), stage: 'task' } : undefined
      },
      controlRoutine: (id, action, options) => t.orchestrator.controlRoutine(id, action, options) })
    t.registry.createSession({ sessionKey: 'dm:ou_alice', chatId: 'oc_dm', chatType: 'p2p', requesterOpenId: 'ou_alice', cwd: '/synthetic' })
    const task = t.registry.createTaskOnce({ sessionKey: 'dm:ou_alice', messageId: 'om_resume_at', requesterOpenId: 'ou_alice', prompt: '这周先停一下，下周一再恢复',
      inbound: { eventId: 'ev_resume_at', messageId: 'om_resume_at', chatId: 'oc_dm', chatType: 'p2p', msgType: 'text', text: '这周先停一下，下周一再恢复',
        senderOpenId: 'ou_alice', senderType: 'user', mentions: [], createTimeMs: NOW } }).task
    const run = new RunAttempts(t.registry.db).begin({ sessionKey: 'dm:ou_alice', workKey: t.registry.taskWork.get(task.id)!.key, triggerKey: `task:${task.id}`,
      stage: 'task', taskId: task.id, actorOpenId: 'ou_alice', now: NOW }, () => t.registry.startTask(task.id, NOW, 'dm:ou_alice'))!
    const token = tokens.issue({ sessionKey: 'dm:ou_alice', runId: run.id, spaceId: t.dm.id, chatId: 'oc_dm', chatType: 'p2p', requesterOpenId: 'ou_alice', cwd: '/synthetic', scopes: [...ALL_SCOPES] })
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
    cleanup.push(() => new Promise<void>(resolve => api.server.close(() => resolve())))
    const post = async (body: Record<string, unknown>) => {
      const response = await fetch(`${base}/v1/routine/control`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    const tool = async (name: string, args: Record<string, unknown>) => {
      const server = buildServer({ apiUrl: base, token }), client = new Client({ name: 'resume-at', version: '1' })
      const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
      try {
        const result = await client.callTool({ name, arguments: args })
        return { isError: result.isError, text: (result.content as { text?: string }[]).map(item => item.text ?? '').join('\n') }
      } finally { await client.close(); await server.close() }
    }
    return { ...t, post, tool }
  }

  it('pauses with an agreed resume time and says so, without turning the routine into a one-off', async () => {
    const t = await apiFixture()
    const r = t.add()
    const at = '2026-09-28T09:00:00+08:00'
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const paused = await t.tool('friday_routine_control', { id: r.id, action: 'pause', resume_at: at })
    expect(paused.isError, paused.text).toBeFalsy()
    expect(paused.text).toContain('已暂停「合成日报」')
    expect(paused.text).toContain('自动恢复')
    expect(t.routines.get(r.id)).toMatchObject({ enabled: false, resumeAt: Date.parse(at), schedule: { type: 'daily', at: '09:00' } })
    const listed = await t.tool('friday_routine_list', {})
    expect(listed.text).toContain('约定')
    const cleared = await t.post({ id: r.id, action: 'pause' })
    expect(cleared).toMatchObject({ status: 200, body: { enabled: false, resume_at: null } })
    expect(t.routines.get(r.id)?.resumeAt).toBeNull()
  })

  it.each([
    ['no timezone', { action: 'pause', resume_at: '2026-09-28T09:00:00' }],
    ['in the past', { action: 'pause', resume_at: '2026-09-20T09:00:00+08:00' }],
    ['beyond 90 days', { action: 'pause', resume_at: '2027-09-28T09:00:00+08:00' }],
    ['not a pause', { action: 'resume', resume_at: '2026-09-28T09:00:00+08:00' }],
  ])('rejects %s with 400 and changes nothing', async (_label, body) => {
    const t = await apiFixture()
    const r = t.add()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const before = t.routines.get(r.id)
    const result = await t.post({ id: r.id, ...body })
    expect(result.status).toBe(400)
    expect(t.routines.get(r.id)).toEqual(before)
  })
})
