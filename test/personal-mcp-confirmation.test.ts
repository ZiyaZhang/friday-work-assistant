import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { withRequestLease } from '../src/core/request-lease.js'
import { renderPermissionCard } from '../src/feishu/cards.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function setup(policy: 'safe' | 'auto' | 'deny' = 'auto') {
  const home = mkdtempSync(join(tmpdir(), 'friday-personal-confirm-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_TRUSTED_USERS: 'trusted', FRIDAY_PERMISSION_POLICY: policy, FRIDAY_PERMISSION_TIMEOUT_MS: '2000' })
  const registry = new Registry(':memory:'), feishu = new FakeFeishu(), log = createLogger('test', 'error')
  const spaces = spaceDeps(registry.db)
  spaces.spaces.ensure({ kind: 'p2p', chatId: 'dm-alice', openId: 'alice' })
  registry.createSession({ sessionKey: 'personal', chatId: 'dm-alice', chatType: 'p2p', cwd: home, requesterOpenId: 'alice' })
  const { app } = createFakeAgent()
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, log,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  const host = new Orchestrator({ cfg, registry, ...spaces, memory: new ChannelMemory(registry.db),
    feishu: asFeishuClient(feishu), runtime, tokens: new TokenIssuer('synthetic'), apiBaseUrl: 'http://127.0.0.1:1',
    mcpServerPath: '/nonexistent', botOpenId: 'bot', log })
  cleanups.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  return { cfg, registry, feishu, host }
}

const input = { sessionKey: 'personal', header: '使用已连接的工具', headline: 'Test MCP · submit',
  approver: 'requester' as const, requesterOnly: true, fullDetail: true }

async function pending(t: ReturnType<typeof setup>) {
  await expect.poll(() => t.host.pendingPermissionCount()).toBe(1)
  const record = t.feishu.sent.find(item => item.kind === 'sendToUser')!
  const requestId = JSON.stringify(record.payload).match(/"request_id":"([^"]+)"/)?.[1]!
  expect(requestId).toBeTruthy()
  return { requestId, messageId: record.messageId, card: record.payload }
}

describe('personal MCP owner confirmation', () => {
  it('requires the exact owner and original private card even under deployment auto policy', async () => {
    const t = setup(), result = t.host.confirmAction({ ...input, detail: '{"operation":"synthetic"}' })
    const card = await pending(t)
    for (const change of [{ operatorOpenId: 'trusted' }, { operatorOpenId: undefined },
      { messageId: 'forwarded-card' }, { chatId: 'another-chat' }, { messageId: undefined }, { chatId: undefined }]) {
      const response = await t.host.handleCardAction({ operatorOpenId: 'alice', messageId: card.messageId, chatId: 'dm-alice',
        ...change, value: { action: 'perm', request_id: card.requestId, decision: 'allow', operatorOpenId: 'alice' }, raw: {} })
      expect(response).toMatchObject({ toast: { type: 'error' } })
      expect(t.host.pendingPermissionCount()).toBe(1)
    }
    const action = { operatorOpenId: 'alice', messageId: card.messageId, chatId: 'dm-alice',
      value: { action: 'perm', request_id: card.requestId, decision: 'allow' }, raw: {} }
    expect(await t.host.handleCardAction(action)).toMatchObject({ toast: { type: 'success' } })
    expect(await result).toBe(true)
    expect(await t.host.handleCardAction(action)).toMatchObject({ toast: { type: 'info' } })
    expect(t.feishu.of('patchCard')).toHaveLength(1)
  })

  it('keeps ordinary auto approvals and deny policy unchanged', async () => {
    const automatic = setup()
    expect(await automatic.host.confirmAction({ ...input, requesterOnly: false })).toBe(true)
    expect(automatic.feishu.sent).toHaveLength(0)
    const denied = setup('deny')
    expect(await denied.host.confirmAction(input)).toBe(false)
    expect(denied.feishu.sent).toHaveLength(0)
  })

  it('cancels and invalidates the original card when the operation Run signal ends', async () => {
    const t = setup(), run = new AbortController()
    const result = t.host.confirmAction({ ...input, signal: run.signal })
    const card = await pending(t)
    run.abort()
    expect(await result).toBe(false)
    expect(t.host.pendingPermissionCount()).toBe(0)
    expect(JSON.stringify(t.feishu.of('patchCard')[0]!.payload)).toContain('确认已取消')
    expect(await t.host.handleCardAction({ operatorOpenId: 'alice', messageId: card.messageId, chatId: 'dm-alice',
      value: { action: 'perm', request_id: card.requestId, decision: 'allow' }, raw: {} })).toMatchObject({ toast: { type: 'info' } })
    expect(await t.host.confirmAction({ ...input, signal: run.signal })).toBe(false)
    expect(t.feishu.of('sendToUser')).toHaveLength(1)
  })

  it('still cancels a non-detached HTTP request rather than silently bypassing its lease', async () => {
    const t = setup(), request = new AbortController()
    const result = withRequestLease(request.signal, () => t.host.confirmAction(input))
    await pending(t); request.abort()
    expect(await result).toBe(false)
    expect(t.host.pendingPermissionCount()).toBe(0)
  })

  it('refuses personal approval outside the original private identity', async () => {
    const t = setup()
    t.registry.createSession({ sessionKey: 'group', chatId: 'group', chatType: 'group', cwd: t.cfg.workspace.root, requesterOpenId: 'alice' })
    expect(await t.host.confirmAction({ ...input, sessionKey: 'group' })).toBe(false)
    expect(t.feishu.sent).toHaveLength(0)
  })

  it('shows complete large parameters as literal text and rejects over-budget approvals before sending', async () => {
    const t = setup(), detail = '服务：https://example.test/mcp\n参数：' + JSON.stringify({ text: '中'.repeat(3000), tail: '```<at id="all"></at>tail' })
    const result = t.host.confirmAction({ ...input, detail }), card = await pending(t)
    const elements = (card.card as { card: { body: { elements: any[] } } }).card.body.elements
    expect(elements.find(element => element.tag === 'div')?.text).toEqual({ tag: 'plain_text', content: detail })
    await t.host.handleCardAction({ operatorOpenId: 'alice', messageId: card.messageId, chatId: 'dm-alice',
      value: { action: 'perm', request_id: card.requestId, decision: 'deny' }, raw: {} })
    expect(await result).toBe(false)
    await expect(t.host.confirmAction({ ...input, detail: '中'.repeat(5334) })).rejects.toThrow('无法完整展示')
    expect(t.feishu.of('sendToUser')).toHaveLength(1)
    expect(t.host.pendingPermissionCount()).toBe(0)
  })

  it('retains clipping for existing ordinary cards and enforces serialized size for full details', () => {
    const ordinary = renderPermissionCard({ requestId: 'synthetic', toolTitle: 'ordinary', detail: 'x'.repeat(850) + 'tail', expiresInMinutes: 10 })
    expect(JSON.stringify(ordinary)).not.toContain('tail')
    expect(() => renderPermissionCard({ requestId: 'synthetic', toolTitle: 'external', detail: '\\'.repeat(15000),
      fullDetail: true, expiresInMinutes: 10 })).toThrow('确认卡片过长')
  })
})
