/**
 * 团队协作的两处宿主接线：PMO 看板写入被平台明确拒绝时告诉绑定人一次；
 * 自然语言开启主动协助记录开启人，巡检只有真的看过才进退避。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator, type AbilityActor } from '../src/core/orchestrator.js'
import { PmoStore } from '../src/core/pmo.js'
import { Proactive } from '../src/core/proactive.js'
import { Registry } from '../src/core/registry.js'
import { Signals } from '../src/core/signals.js'
import { spaceScope } from '../src/core/space.js'
import { Todos } from '../src/core/todos.js'
import type { Bitable } from '../src/feishu/bitable.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('pmo-proactive-host', 'error')
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

function pmoFixture() {
  const registry = new Registry(':memory:'); cleanup.push(() => registry.close())
  const cfg = loadConfig({ FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test', FRIDAY_REFLECT: 'off' })
  const sp = spaceDeps(registry.db)
  const a = sp.spaces.ensure({ kind: 'group', chatId: 'group-a', openId: 'alice', title: 'A群' })
  sp.spaces.dm('alice')
  const todos = new Todos(registry.db), pmo = new PmoStore(registry.db), feishu = new FakeFeishu()
  let record = 0
  const bitable = {
    baseUrl: (app: string, table?: string) => `https://example.invalid/base/${app}${table ? `?table=${table}` : ''}`,
    createBase: vi.fn(async () => ({ appToken: 'base1', url: 'https://example.invalid/base/base1' })),
    ensureTable: vi.fn(async () => 'table'), ensureFields: vi.fn(async () => undefined),
    listRecords: vi.fn(async () => ({ records: [] as { recordId: string; fields: Record<string, unknown> }[], complete: true })),
    batchCreate: vi.fn(async (_app: string, _table: string, rows: unknown[]) => rows.map(() => `record${++record}`)),
    batchUpdate: vi.fn(async () => 0),
  }
  const orchestrator = new Orchestrator({ cfg, registry, todos, pmo, ...sp, feishu: asFeishuClient(feishu), bitable: bitable as unknown as Bitable,
    runtime: {} as AcpRuntime, memory: new ChannelMemory(registry.db), tokens: new TokenIssuer('test'), apiBaseUrl: 'http://127.0.0.1:1',
    mcpServerPath: '/unused', botOpenId: 'bot', log })
  const actor: AbilityActor = { sessionKey: 'test', chatId: 'group-a', requesterOpenId: 'alice', chatType: 'group' }
  return { registry, a, todos, pmo, feishu, bitable, orchestrator, actor }
}

describe('PMO writes the platform explicitly rejected', () => {
  it('tells the binding owner once per binding and error set, and the manual sync says so too', async () => {
    const t = pmoFixture()
    await t.orchestrator.abilities.pmo(t.actor, 'init')
    t.todos.add({ scope: spaceScope(t.a.id), title: '新加的事项' })
    t.bitable.batchCreate.mockRejectedValue(Object.assign(new Error('synthetic bitable refusal'), { code: 1254302 }))
    const dms = () => t.feishu.of('sendToUser').map(item => ({ to: item.target, text: (item.payload as { text?: string }).text ?? '' }))
    await t.orchestrator.syncPmo()
    expect(dms()).toEqual([{ to: 'alice', text: expect.stringContaining('写入被拒（code=1254302）') }])
    expect(dms()[0]!.text).toContain('修好后下一轮会重新写入')
    // The same refusal on the next rounds is not repeated.
    await t.orchestrator.syncPmo()
    const manual = await t.orchestrator.abilities.pmo(t.actor, 'sync')
    expect(manual).toContain('写入被拒（code=1254302）')
    expect(manual).not.toContain('不会自动重发')
    expect(dms()).toHaveLength(1)
    expect(t.pmo.pendingWrite({ spaceId: t.a.id, appToken: 'base1', tableId: 'table', url: '', boundBy: 'alice' } as never, 1)).toBeUndefined()
  })
})

function proactiveFixture(script = [{ kind: 'text' as const, text: 'NOTHING' }]) {
  const home = mkdtempSync(join(tmpdir(), 'friday-proactive-host-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_REFLECT: 'off',
    FRIDAY_PROACTIVE_QUIET_MS: '30', FRIDAY_PROACTIVE_MIN_MESSAGES: '2' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), sp = spaceDeps(registry.db)
  const feishu = new FakeFeishu(); feishu.chats = [{ chatId: 'oc_group', name: '研发群' }]
  const messages = new MessageService(asFeishuClient(feishu), new MessageCache(registry.db), log)
  const proactive = new Proactive(registry.db, cfg.proactive)
  let signalNow = Date.now()
  const signals = new Signals(registry.db, () => signalNow)
  const { app, state } = createFakeAgent({ script })
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory: new ChannelMemory(registry.db), messages,
    todos: new Todos(registry.db), ...sp, proactive, signals, tokens: new TokenIssuer('s'), apiBaseUrl: 'http://127.0.0.1:1',
    mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_alice' })
  cleanup.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const say = (messageId: string, text: string, at: number) => orchestrator.handleMessage({ eventId: `ev_${messageId}`, messageId, chatId: 'oc_group',
    chatType: 'group', msgType: 'text', text, senderOpenId: 'ou_alice', senderType: 'user', mentions: [], createTimeMs: at })
  return { registry, sp, space, feishu, proactive, signals, state, orchestrator, say, tick: (ms: number) => (signalNow += ms) }
}

describe('proactive assistance', () => {
  it('a natural-language “turn on” records who turned it on', async () => {
    const t = proactiveFixture()
    const result = await t.orchestrator.abilities.settings({ sessionKey: 'settings', chatId: 'oc_group', chatType: 'group', requesterOpenId: 'ou_alice', spaceId: t.space.id }, 'set proactive on')
    expect(result).toContain('主动模式已开')
    expect(t.proactive.get('oc_group')).toMatchObject({ enabled: true, enabledBy: 'ou_alice' })
  })

  it('backs signals off only after a round that actually looked', async () => {
    const t = proactiveFixture()
    t.proactive.enable('oc_group', 'ou_alice')
    const noted = vi.spyOn(t.signals, 'noteAlerted')
    const t0 = Date.now()
    await t.say('om_q1', '数仓权限找谁申请啊？', t0)
    await t.say('om_q2', '有人知道吗', t0 + 1000)
    t.tick(11 * 60_000)
    // The person who turned it on is no longer an owner: the round is skipped, nothing was looked at.
    t.sp.spaces.removeMember(t.space.id, 'ou_alice')
    expect(await t.orchestrator.sweepSignals()).toBe(1)
    expect(t.state.allPrompts).toHaveLength(0)
    expect(noted).not.toHaveBeenCalled()
    expect(t.signals.due().size).toBe(1)
    // Authority restored: the round looks (and stays silent); now the batch backs off.
    t.sp.spaces.addMember(t.space.id, 'ou_alice', 'owner')
    expect(await t.orchestrator.sweepSignals()).toBe(1)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(noted).toHaveBeenCalled()
    expect(t.signals.due().size).toBe(0)
  })
})
