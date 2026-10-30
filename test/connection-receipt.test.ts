import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { UserTokenStore, USER_SCOPE_TIERS, type UserScopeExtra } from '../src/feishu/oauth.js'
import type { ConnectionReply } from '../src/feishu/connection-capabilities.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent, type FakeTurnStep } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** Actual coordinator, ACP, signed HTTP and delivery ledger; only the model/platform are synthetic. */
async function setup(granted?: string, enabled = true) {
  const home = mkdtempSync(join(tmpdir(), 'friday-connect-receipt-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), sp = spaceDeps(registry.db)
  sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
  registry.setKv('connect-invited:ou_alice', '1')
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('connection-receipt', 'error')
  const userTokens = new UserTokenStore(registry.db, { exchangeCode: async () => ({ accessToken: 'SYNTHETIC_TOKEN', expiresIn: 7200, scope: granted ?? '' }), refresh: async () => { throw new Error('unexpected') } })
  if (granted) await userTokens.complete({ openId: 'ou_alice', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  const { app, state } = createFakeAgent(), runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, log,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  const tokens = new TokenIssuer('synthetic-capability-key')
  const host = new Orchestrator({ cfg, registry, memory, ...sp, feishu, runtime, userTokens: enabled ? userTokens : undefined,
    tokens, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  const api = createInternalApi({ registry, memory, ...sp, feishu, tokens, log, maxHistoryPerCall: 10,
    resolveActorForSession: key => host.resolveActorForSession(key), abilities: host.abilities })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve()));
    await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const post = async (extras?: unknown) => {
    const server = state.allPrompts.at(-1)!.mcpServers[0] as { env: { name: string; value: string }[] }
    const token = server.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value
    const response = await fetch(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/ability`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ what: 'connect', extras }) })
    return { status: response.status, body: await response.json() as ConnectionReply }
  }
  let serial = 0
  const message = (text = '连接我的飞书账号'): InboundMessage => ({ eventId: `event-${++serial}`, messageId: `message-${serial}`, chatId: 'oc_dm',
    chatType: 'p2p', senderOpenId: 'ou_alice', senderType: 'user', msgType: 'text', text, mentions: [], createTimeMs: Date.now() })
  return { host, fake, userTokens, registry, state, post, message }
}

describe('host connection receipt', () => {
  it('delivers one factual receipt via the ledger and suppresses an exact duplicate model reply', async () => {
    const t = await setup(), final: FakeTurnStep = { kind: 'text', text: '' }
    let receipt!: ConnectionReply
    t.state.script = [{ kind: 'hook', run: async () => {
      const result = await t.post(); expect(result.status).toBe(200); receipt = result.body
      expect((await t.post()).body).toEqual(receipt)
      final.text = receipt.text
    } }, final]
    await t.host.handleMessage(t.message())
    expect(receipt.facts.state).toBe('not_connected')
    expect(receipt.facts.capabilities.every(item => !item.scopeGranted)).toBe(true)
    expect(receipt.delivery.status).toBe('sent')
    expect(t.fake.of('sendToUser').filter(item => 'card' in (item.payload as object))).toHaveLength(1)
    expect(t.fake.answers()).toEqual([receipt.text])
    expect(t.registry.db.prepare("SELECT status,remote_id FROM deliveries WHERE remote_id = ?").get(receipt.delivery.messageId))
      .toEqual({ status: 'sent', remote_id: receipt.delivery.messageId })
  })

  it.each(([[], ['watch'], ['calendar'], ['minutes'], ['watch', 'calendar', 'minutes']] as UserScopeExtra[][]).map(tiers => ({ tiers })))
    ('reports only actual accepted tiers $tiers while preserving another task answer', async ({ tiers }) => {
      const t = await setup([...USER_SCOPE_TIERS.core, ...tiers.flatMap(tier => USER_SCOPE_TIERS[tier])].join(' '))
      let receipt!: ConnectionReply
      t.state.script = [{ kind: 'hook', run: async () => { const r = await t.post(); expect(r.status).toBe(200); receipt = r.body } },
        { kind: 'text', text: '另一件事的答案：2 + 2 = 4。' }]
      await t.host.handleMessage(t.message('连接账号，再算一下 2 + 2'))
      expect(receipt.facts.state).toBe('connected')
      for (const [id, tier] of [['group_history', 'watch'], ['calendar', 'calendar'], ['minutes', 'minutes']] as const) {
        expect(receipt.facts.capabilities.find(item => item.id === id)?.scopeGranted).toBe(tiers.includes(tier))
      }
      expect(receipt.facts.github.authorization).toBe('independent')
      expect(receipt.facts.github.identity).toBe('not_checked')
      expect(t.fake.answers()).toEqual([receipt.text, '另一件事的答案：2 + 2 = 4。'])
      expect(t.fake.of('sendToUser').filter(item => 'card' in (item.payload as object))).toHaveLength(0)
    })

  it('accepts an explicit tier without changing current grants and rejects arbitrary scope inputs', async () => {
    const t = await setup(USER_SCOPE_TIERS.core.join(' '))
    t.state.script = [{ kind: 'hook', run: async () => {
      expect((await t.post(['im:message'])).status).toBe(400)
      const r = await t.post(['calendar'])
      expect(r.status).toBe(200)
      expect(r.body.facts.capabilities.find(item => item.id === 'calendar')).toMatchObject({ requested: true, scopeGranted: false })
      expect(r.body.facts.capabilities.find(item => item.id === 'minutes')).toMatchObject({ requested: false, scopeGranted: false })
    } }]
    await t.host.handleMessage(t.message('连接日历'))
    expect(t.userTokens.get('ou_alice')?.scope).toBe(USER_SCOPE_TIERS.core.join(' '))
  })

  it('truthfully reports disabled authorization without sending a card', async () => {
    const t = await setup(undefined, false)
    t.state.script = [{ kind: 'hook', run: async () => {
      const r = await t.post(); expect(r.status).toBe(200); expect(r.body.facts.state).toBe('disabled')
      expect(r.body.text).toContain('没有开启个人授权')
    } }]
    await t.host.handleMessage(t.message())
    expect(t.fake.of('sendToUser').filter(item => 'card' in (item.payload as object))).toHaveLength(0)
  })

  it('does not send a success receipt when a card send returns after the task was stopped', async () => {
    const t = await setup()
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    const original = t.fake.sendToUser.bind(t.fake)
    vi.spyOn(t.fake, 'sendToUser').mockImplementation(async (openId, payload) => {
      if ('card' in payload) { entered(); await waiting }
      return original(openId, payload)
    })
    let status = 0
    t.state.script = [{ kind: 'hook', run: async () => { status = (await t.post()).status } }]
    const pending = t.host.handleMessage(t.message())
    try { await started; await t.host.handleMessage(t.message('/stop')) }
    finally { release(); await pending }
    expect(status).not.toBe(200)
    expect(t.fake.answers().some(answer => answer.includes('授权卡已经发到这个私聊'))).toBe(false)
  })

  it('rechecks grant facts after awaiting delivery authorization before publishing a connected receipt', async () => {
    const t = await setup(USER_SCOPE_TIERS.core.join(' '))
    const target = t.host as unknown as { deliveryContext: (...args: unknown[]) => Promise<unknown> }
    const original = target.deliveryContext.bind(target)
    vi.spyOn(target, 'deliveryContext').mockImplementation(async (...args) => {
      const context = await original(...args)
      t.userTokens.disconnect('ou_alice')
      return context
    })
    t.state.script = [{ kind: 'hook', run: async () => { expect((await t.post()).status).not.toBe(200) } }]
    await t.host.handleMessage(t.message())
    expect(t.fake.answers().some(answer => answer.includes('已连接飞书账号'))).toBe(false)
  })
})
