import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { PersonalMcpConnections } from '../src/personal/mcp-connections.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

/** Real host, Run, SQLite, managed ACP routing and permission cards. The model,
 * Feishu network and remote MCP provider are deterministic local substitutes. */
async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-personal-mcp-host-')))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home,
    FRIDAY_PUBLIC_MODE: 'true', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '10000',
    FRIDAY_PERMISSION_POLICY: 'auto', FRIDAY_PERMISSION_TIMEOUT_MS: '10000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(join(home, 'state.sqlite')), log = createLogger('personal-mcp-host', 'error')
  const sp = spaceDeps(registry.db), fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const userTokens = new UserTokenStore(registry.db, fake), tokens = new TokenIssuer('synthetic-key')
  const execution = managedHostRuntime(registry, home, log), state = execution.peer.state
  const remote = { tools: vi.fn(async () => [{ name: 'lookup', description: 'Read one note', inputSchema: { type: 'object' }, readOnly: true }]),
    call: vi.fn(async () => ({ text: 'Confirmed remote result.', isError: false })) }
  const personalMcp = new PersonalMcpConnections({ db: registry.db, key: Buffer.alloc(32, 3), remote, audience: () => {} })
  const connection = (await personalMcp.prepareConnect('alice', { name: 'Notes', url: 'https://mcp.example.test/mcp' }, () => {}))()
  const host = new Orchestrator({ cfg, registry, ...sp, memory, messages, messageCache: cache, userTokens, feishu,
    runtime: execution.runtime, managed: execution.managed, tokens, personalMcp,
    botOpenId: 'bot', log, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent',
    ingressClassifier: { classify: async () => ({ kind: 'work_request' }) } })
  const settle = vi.spyOn(personalMcp, 'settleRun')
  cleanups.push(async () => {
    host.beginShutdown(); personalMcp.beginShutdown()
    await execution.runtime.stop()
    expect(await host.waitForShutdown(3000)).toMatchObject({ drained: true })
    expect(await personalMcp.waitForShutdown(3000)).toMatchObject({ drained: true })
    registry.close(); rmSync(home, { recursive: true, force: true })
  })
  const current = () => {
    const session = registry.getSessionByAcpId(state.allPrompts.at(-1)!.sessionId)!
    const actor = host.resolveActorForSession(session.sessionKey)!
    return { session, actor, signal: host.personalMcpRunSignal(session.sessionKey, actor.runId) }
  }
  let receiptId = '', originalRunId = '', sessionKey = ''
  const start = () => {
    const currentRun = current()
    originalRunId = currentRun.actor.runId; sessionKey = currentRun.session.sessionKey
    const guard = () => {
      if (host.resolveActorForSession(sessionKey)?.runId !== originalRunId) throw new Error('Run authority changed')
    }
    const receipt = personalMcp.start('alice', connection.id, 'lookup', { query: 'example' }, originalRunId, guard,
      details => host.confirmAction({ sessionKey, header: '使用已连接的工具', headline: `${details.name} · ${details.tool}`,
        detail: details.args, approver: 'requester', requesterOnly: true, fullDetail: true, signal: details.signal }), currentRun.signal)
    receiptId = receipt.id
    return receipt
  }
  const read = async () => {
    const live = current()
    expect(live.actor.runId).toBe(originalRunId)
    expect(live.session.sessionKey).toBe(sessionKey)
    return personalMcp.wait('alice', receiptId, originalRunId, () => {
      if (host.resolveActorForSession(sessionKey)?.runId !== originalRunId) throw new Error('Run authority changed')
    }, 0)
  }
  const message: InboundMessage = { eventId: 'request', messageId: 'request', chatId: 'oc_dm_alice', chatType: 'p2p',
    senderOpenId: 'alice', senderType: 'user', tenantId: 'tenant', msgType: 'text', text: '用我的 Notes 查询 example。', mentions: [], createTimeMs: Date.now() }
  const row = () => registry.db.prepare("SELECT id,state,result_json FROM run_attempts WHERE stage='task' ORDER BY rowid DESC LIMIT 1").get()!
  const pending = async () => {
    await expect.poll(() => host.pendingPermissionCount()).toBe(1)
    await expect.poll(() => settle.mock.calls.length).toBeGreaterThan(0)
    const card = fake.of('sendToUser').find(item => JSON.stringify(item.payload).includes('request_id'))!
    const requestId = JSON.stringify(card.payload).match(/"request_id":"([^"]+)"/)?.[1]!
    expect(requestId).toBeTruthy()
    return { operatorOpenId: 'alice', messageId: card.messageId, chatId: message.chatId,
      value: { action: 'perm', request_id: requestId, decision: 'allow' }, raw: {} }
  }
  return { cfg, registry, fake, state, host, personalMcp, remote, settle, start, read, current, message, row, pending,
    get runId() { return originalRunId }, get callId() { return receiptId }, get sessionKey() { return sessionKey } }
}

describe('personal MCP Run ownership after a model end_turn', () => {
  it('retains the confirmation, then consumes its one result in the same Run and ACP session', async () => {
    const t = await fixture()
    t.state.script = [{ kind: 'hook', run: () => {
      expect(t.start()).toMatchObject({ state: 'checking' })
      t.state.script = [{ kind: 'hook', run: async () => {
        expect(await t.read()).toMatchObject({ state: 'completed', result: 'Confirmed remote result.' })
      } }, { kind: 'text', text: '已查到确认后的结果。' }]
    } }, { kind: 'text', text: '等待你确认。' }]
    const turn = t.host.handleMessage(t.message), approval = await t.pending()
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.host.resolveActorForSession(t.sessionKey)?.runId).toBe(t.runId)
    expect(t.remote.call).not.toHaveBeenCalled()
    expect(t.fake.answers()).toEqual([])
    expect(await t.host.handleCardAction(approval)).toMatchObject({ toast: { type: 'success' } })
    await turn
    expect(t.state.allPrompts).toHaveLength(2)
    expect(new Set(t.state.allPrompts.map(prompt => prompt.sessionId)).size).toBe(1)
    expect(t.state.allPrompts[1]!.text).toContain(t.callId)
    expect(t.remote.call).toHaveBeenCalledOnce()
    expect(t.fake.answers().join('\n')).toContain('已查到确认后的结果。')
    expect(t.fake.answers().join('\n')).not.toContain('等待你确认。')
    expect(t.row().state).toBe('completed')
    expect(JSON.parse(String(t.row().result_json))).toMatchObject({ outcome: 'handled', reason: 'normal_end' })
  })

  it.each(['human-stop', 'shutdown'] as const)('keeps %s effective while parked, and rejects late approval', async reason => {
    const t = await fixture()
    t.state.script = [{ kind: 'hook', run: () => { t.start() } }, { kind: 'text', text: '等待你确认。' }]
    const turn = t.host.handleMessage(t.message), approval = await t.pending()
    if (reason === 'shutdown') t.host.beginShutdown()
    else await t.host.handleMessage({ ...t.message, eventId: 'stop', messageId: 'stop', text: '/stop' })
    await turn
    expect(t.host.pendingPermissionCount()).toBe(0)
    expect(await t.host.handleCardAction(approval)).toMatchObject({ toast: { type: 'info' } })
    expect(t.remote.call).not.toHaveBeenCalled()
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT state FROM personal_mcp_calls').get()?.state).toBe('cancelled')
    expect(t.row().state).toBe(reason === 'shutdown' ? 'interrupted' : 'cancelled')
    expect(JSON.parse(String(t.row().result_json))).toMatchObject(reason === 'shutdown'
      ? { outcome: 'interrupted', termination: 'gateway_shutdown' } : { outcome: 'cancelled', reason: 'user_requested' })
  })

  it('limits continuation nudges and reports partial when the model never reads the receipt', async () => {
    const t = await fixture()
    t.state.script = [{ kind: 'hook', run: () => {
      t.start()
      t.state.script = [{ kind: 'text', text: '我已经全部完成了。' }]
    } }, { kind: 'text', text: '等待你确认。' }]
    const turn = t.host.handleMessage(t.message), approval = await t.pending()
    await t.host.handleCardAction(approval); await turn
    expect(t.remote.call).toHaveBeenCalledOnce()
    expect(t.state.allPrompts).toHaveLength(3)
    expect(t.row().state).toBe('completed')
    expect(JSON.parse(String(t.row().result_json))).toMatchObject({ outcome: 'partial', reason: 'operation_incomplete' })
    expect(t.fake.answers().join('\n')).not.toContain('我已经全部完成了。')
    expect(t.fake.answers().join('\n')).not.toContain('等待你确认。')
  })

  it('cancels the pending card after a model failure instead of resuming a failed turn', async () => {
    const t = await fixture()
    t.state.script = [{ kind: 'hook', run: async () => {
      t.start()
      await expect.poll(() => t.host.pendingPermissionCount()).toBe(1)
      throw new Error('synthetic model transport failed')
    } }]
    await t.host.handleMessage(t.message)
    await expect.poll(() => t.host.pendingPermissionCount()).toBe(0)
    expect(t.remote.call).not.toHaveBeenCalled()
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT state FROM personal_mcp_calls').get()?.state).toBe('cancelled')
    expect(t.row().state).toBe('failed')
    expect(JSON.parse(String(t.row().result_json))).toMatchObject({ outcome: 'failed', reason: 'runtime_error' })
  })

  it('does not revive a confirmation when the step budget replaces the Run controller for wrap-up', async () => {
    const t = await fixture(); t.cfg.policy.maxStepsPerTurn = 1
    let originalSignal: AbortSignal | undefined, wrapSignal: AbortSignal | undefined
    t.state.script = [{ kind: 'hook', run: async () => {
      originalSignal = t.current().signal; t.start()
      await expect.poll(() => t.host.pendingPermissionCount()).toBe(1)
      t.state.script = [{ kind: 'hook', run: () => { wrapSignal = t.current().signal } }, { kind: 'text', text: '本轮没有执行查询。' }]
    } }, { kind: 'tool', text: 'first' }, { kind: 'tool', text: 'second' }]
    await t.host.handleMessage(t.message)
    expect(originalSignal?.aborted).toBe(true)
    expect(wrapSignal).toBeDefined(); expect(wrapSignal).not.toBe(originalSignal)
    expect(t.host.pendingPermissionCount()).toBe(0)
    expect(t.remote.call).not.toHaveBeenCalled()
    expect(t.registry.db.prepare('SELECT state FROM personal_mcp_calls').get()?.state).toBe('cancelled')
    expect(t.state.allPrompts).toHaveLength(2)
    expect(JSON.parse(String(t.row().result_json))).toMatchObject({ outcome: 'partial', reason: 'step_budget' })
  })
})
