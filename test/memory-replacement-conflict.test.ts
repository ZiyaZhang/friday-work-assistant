import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const scope = 'space:sp_dm_ou_owner'
const proof = (messageId: string) => ({ by: 'ou_owner', messageId })
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

function storage() {
  const registry = new Registry(':memory:')
  cleanup.push(() => registry.close())
  return { registry, memory: new ChannelMemory(registry.db) }
}

function scenario(memory: ChannelMemory, kind: 'competing' | 'deleted' | 'own-candidate') {
  const original = memory.add({ scope, kind: 'rule', title: '原要求 A', body: '原要求 A' })
  if (kind !== 'own-candidate') expect(memory.confirm(original.id, scope, proof('confirm-a'))).toBe(true)
  const next = memory.add({ scope, kind: 'rule', title: '更正 B', body: '更正 B', replaces: original.id })
  if (kind === 'competing') {
    const competing = memory.add({ scope, kind: 'rule', title: '更正 C', body: '更正 C', replaces: original.id })
    expect(memory.confirm(next.id, scope, proof('confirm-b'))).toBe(true)
    return { original, next: competing, winner: next }
  }
  if (kind === 'deleted') expect(memory.remove(original.id, scope)).toBe(true)
  return { original, next, winner: undefined }
}

describe('memory replacement confirmation rejects stale targets', () => {
  it('keeps a competing correction unconfirmed after another correction won', () => {
    const { registry, memory } = storage()
    const { original, next, winner } = scenario(memory, 'competing')
    const before = registry.db.prepare('SELECT * FROM memory_notes ORDER BY id').all()
    expect(memory.confirm(next.id, scope, proof('confirm-c'))).toBe(false)
    expect(registry.db.prepare('SELECT * FROM memory_notes ORDER BY id').all()).toEqual(before)
    expect(memory.get(next.id)).toMatchObject({ status: 'candidate', confirmation: null })
    expect(memory.get(original.id)).toMatchObject({ status: 'superseded', supersededBy: winner!.id })
    expect(memory.rules(scope).map((note) => note.id)).toEqual([winner!.id])
    expect(memory.renderForPrompt(scope, '')).toContain('更正 B')
    expect(memory.renderForPrompt(scope, '')).not.toContain('更正 C')
  })

  it('preserves the candidate without a confirmation proof when its original was deleted', () => {
    const { registry, memory } = storage()
    const { next } = scenario(memory, 'deleted')
    const before = registry.db.prepare('SELECT * FROM memory_notes ORDER BY id').all()
    expect(memory.confirm(next.id, scope, proof('confirm-deleted'))).toBe(false)
    expect(registry.db.prepare('SELECT * FROM memory_notes ORDER BY id').all()).toEqual(before)
    expect(memory.get(next.id)).toMatchObject({ status: 'candidate', confirmation: null })
    expect(memory.rules(scope)).toEqual([])
  })

  it('confirms a replacement that already superseded its own candidate target', () => {
    const { memory } = storage()
    const { original, next } = scenario(memory, 'own-candidate')
    const previous = memory.get(original.id)
    expect(previous).toMatchObject({ status: 'superseded', supersededBy: next.id })
    expect(memory.confirm(next.id, scope, proof('confirm-own-replacement'))).toBe(true)
    expect(memory.get(original.id)).toEqual(previous)
    expect(memory.get(next.id)).toMatchObject({ status: 'confirmed', confirmation: proof('confirm-own-replacement') })
    expect(memory.rules(scope).map((note) => note.id)).toEqual([next.id])
  })

  it.each(['competing', 'deleted', 'own-candidate'] as const)('returns the real /memory confirm result for %s', async (kind) => {
    const { registry, memory } = storage()
    const { next } = scenario(memory, kind)
    const home = mkdtempSync(join(tmpdir(), 'friday-memory-conflict-'))
    cleanup.push(() => rmSync(home, { recursive: true, force: true }))
    const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
      FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
    mkdirSync(cfg.workspace.root, { recursive: true })
    const sp = spaceDeps(registry.db)
    sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_synthetic_dm', openId: 'ou_owner' })
    const feishu = new FakeFeishu()
    const { app, state } = createFakeAgent()
    const log = createLogger('memory-conflict', 'error')
    const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, log })
    cleanup.push(() => runtime.stop())
    const orchestrator = new Orchestrator({ cfg, registry, ...sp, memory, runtime, feishu: asFeishuClient(feishu),
      tokens: new TokenIssuer('synthetic'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent/synthetic-mcp.js',
      botOpenId: 'ou_bot', log })
    const before = memory.get(next.id)
    await orchestrator.handleMessage({ eventId: `event-${kind}`, messageId: `om_confirm_${kind}`, chatId: 'oc_synthetic_dm', chatType: 'p2p',
      msgType: 'text', text: `/memory confirm ${next.id}`, senderOpenId: 'ou_owner', senderType: 'user', mentions: [], createTimeMs: Date.now() })
    const reply = feishu.sent.find((sent) => sent.kind === 'replyMarkdown' && sent.target === `om_confirm_${kind}`)?.payload
    if (kind === 'own-candidate') {
      // The numeric command first shows the exact full version; the click on that card confirms it.
      expect(reply).toBeUndefined()
      expect(memory.get(next.id)?.status).toBe('candidate')
      const card = feishu.sent.find(sent => sent.kind === 'sendToChat')!
      const payload = card.payload as { card: { elements: { actions?: { value: Record<string, unknown> }[] }[] } }
      const value = payload.card.elements.find(item => item.actions)?.actions![0]!.value
      await orchestrator.handleCardAction({ operatorOpenId: 'ou_owner', chatId: 'oc_synthetic_dm', messageId: card.messageId, value: value!, raw: {} })
      expect(memory.get(next.id)).toMatchObject({ status: 'confirmed', confirmation: { by: 'ou_owner' } })
    } else {
      expect(reply).toBe('这条记忆已更新、删除或当前无法核验，请先查看当前版本。')
      expect(memory.get(next.id)).toEqual(before)
    }
    expect(state.allPrompts).toHaveLength(0)
  })
})
