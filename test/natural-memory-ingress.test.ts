import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import type { IngressClassifier } from '../src/acp/ingress-classifier.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { dmSpaceId, spaceScope } from '../src/core/space.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu, type SentRecord } from './helpers/fake-feishu.js'
import { deferred } from './helpers/model-agent.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-human-memory-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'p2p', chatId: 'dm', openId: 'alice' })
  const fake = new FakeFeishu(), log = createLogger('natural-memory', 'error'), peer = createFakeAgent({ script: [{ kind: 'text', text: '其他事项的完整答案' }] })
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: peer.app }, log,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  const classify = vi.fn<IngressClassifier['classify']>(async () => ({ kind: 'new_work' }))
  const deps = { cfg, registry, memory, ...sp, runtime, feishu: asFeishuClient(fake), ingressClassifier: { classify },
    tokens: new TokenIssuer('synthetic'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log }
  const host = new Orchestrator(deps)
  cleanup.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  let serial = 0
  const message = (text: string, parentId?: string): InboundMessage => { const id = `memory-human-${++serial}`; return {
    eventId: id, messageId: id, chatId: 'dm', chatType: 'p2p', senderOpenId: 'alice', senderType: 'user', msgType: 'text',
    text, mentions: [], createTimeMs: Date.now(), parentId } }
  /** Button value exactly as the platform callback would carry it back from the displayed card. */
  const button = (sent: SentRecord, action: 'memory_confirm' | 'memory_correct' | 'memory_forget') => {
    const card = (sent.payload as { card: { elements: { actions?: { value: Record<string, unknown> }[] }[] } }).card
    return card.elements.find(item => item.actions)!.actions!.find(item => item.value.action === action)!.value
  }
  return { registry, memory, space, fake, peer, runtime, host, classify, message, button, deps }
}

describe('natural memory uses real host ingress, SQLite and ACP boundaries (synthetic model/platform)', () => {
  it('idle own-DM explicit original preference creates no worker Task and is used by the next real prompt', async () => {
    const t = fixture(), msg = t.message('帮我记住：以后叫我轻舟，不要用全名。')
    t.classify.mockResolvedValueOnce({ kind: 'memory_save_preference', spans: [{ start: 0, end: msg.text.length }], continueWork: false })
    await t.host.handleMessage(msg); await t.host.handleMessage(msg)
    const notes = t.memory.rules(spaceScope(dmSpaceId('alice')))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ body: msg.text, status: 'confirmed', confirmation: { by: 'alice', messageId: msg.messageId } })
    expect(t.registry.taskForMessage(msg.messageId)).toBeUndefined()
    expect(t.peer.state.allPrompts).toHaveLength(0)
    expect(t.fake.sent).toHaveLength(1)
    expect(t.classify).toHaveBeenCalledOnce()
    await t.host.handleMessage(t.message('给我一条问候。'))
    expect(t.peer.state.allPrompts[0]?.text).toContain(msg.text)
    await t.host.handleMessage(t.message(`/forget ${notes[0]!.id}`))
    await t.host.handleMessage(t.message('再给我一条问候。'))
    expect(t.peer.state.allPrompts.at(-1)?.text).not.toContain(msg.text)
  })

  it('retains the full mixed request as durable work while acknowledging the preference exactly once', async () => {
    const t = fixture(), preference = '请记住我喜欢简短回答。', msg = t.message(`${preference}再解释一下什么是事务。`)
    t.classify.mockResolvedValueOnce({ kind: 'memory_save_preference', spans: [{ start: 0, end: preference.length }], continueWork: true })
    await t.host.handleMessage(msg)
    expect(t.memory.rules(spaceScope(t.space.id))[0]?.body).toBe(preference)
    expect(t.registry.taskForMessage(msg.messageId)?.prompt).toContain(msg.text)
    expect(t.registry.dispatches.get(t.registry.taskForMessage(msg.messageId)!.id)?.inbound.text).toBe(msg.text)
    expect(t.peer.state.allPrompts[0]?.text).toContain('不要重复保存或复述')
    expect(t.peer.state.allPrompts[0]?.text).toContain('再解释一下什么是事务')
    expect(t.fake.sent.filter(s => JSON.stringify(s.payload).includes('已记住这条个人偏好'))).toHaveLength(1)
    expect(t.fake.answers()).toContain('其他事项的完整答案')
  })

  it('uses the actual displayed ref after restart and never lets a newer background candidate steal confirmation', async () => {
    const t = fixture(), note = t.memory.add({ scope: spaceScope(t.space.id), kind: 'rule', title: '称呼', body: '叫我轻舟' })
    await t.host.handleMessage(t.message(`/memory confirm ${note.id}`))
    const card = t.fake.sent[0]!
    const other = t.memory.add({ scope: note.scope, kind: 'rule', title: '新候选', body: '不该确认这个' })
    const restart = new Orchestrator(t.deps)
    t.classify.mockImplementationOnce(async input => {
      expect(input.memoryTargets).toHaveLength(1)
      expect(input.memoryTargets![0]?.body).toBe(note.body)
      return { kind: 'memory_confirm', targetRef: input.memoryTargets![0]!.ref, continueWork: false }
    })
    const reply = t.message('对，按这条记住。', card.messageId)
    await restart.handleMessage(reply)
    expect(t.memory.get(note.id)).toMatchObject({ status: 'confirmed', confirmation: { messageId: reply.messageId } })
    expect(t.memory.get(other.id)?.status).toBe('candidate')
    expect(t.registry.taskForMessage(reply.messageId)).toBeUndefined()
    expect(t.peer.state.allPrompts).toHaveLength(0)
  })

  it('does not confirm a display whose version changed while classification awaited', async () => {
    const t = fixture(), note = t.memory.add({ scope: spaceScope(t.space.id), kind: 'rule', title: '称呼', body: '叫我轻舟' })
    await t.host.handleMessage(t.message(`/memory confirm ${note.id}`))
    const entered = deferred(), release = deferred()
    t.classify.mockImplementationOnce(async input => { entered.resolve(); await release.promise; return {
      kind: 'memory_confirm', targetRef: input.memoryTargets![0]!.ref, continueWork: false } })
    const pending = t.host.handleMessage(t.message('确认。', t.fake.sent[0]!.messageId))
    await entered.promise
    t.memory.remove(note.id, note.scope)
    release.resolve(); await pending
    expect(t.memory.get(note.id)).toBeUndefined()
    expect(t.peer.state.allPrompts).toHaveLength(0)
    expect(JSON.stringify(t.fake.sent)).not.toContain('已记住')
  })

  it('retains selected original materials for the independent work inside a mixed preference message', async () => {
    const t = fixture(), report = t.message('REPORT_MATERIAL_CANARY：本周应交付可复验的结果。')
    await t.host.handleMessage(report)
    const preference = '请记住我喜欢简短回答。', msg = t.message(`${preference}再把刚才报告总结一下。`)
    t.classify.mockImplementationOnce(async input => ({ kind: 'memory_save_preference',
      spans: [{ start: 0, end: preference.length }], continueWork: true,
      contextRefs: [input.materials!.find(material => material.preview.includes('REPORT_MATERIAL_CANARY'))!.ref] }))
    await t.host.handleMessage(msg)
    const task = t.registry.taskForMessage(msg.messageId)!
    expect(JSON.parse(t.registry.getKv(`task-input-materials:${task.id}`)!)).toMatchObject([{ message: { messageId: report.messageId } }])
    expect(t.peer.state.allPrompts.at(-1)!.text).toContain('REPORT_MATERIAL_CANARY')
    expect(t.memory.rules(spaceScope(t.space.id))[0]?.body).toBe(preference)
  })

  it('card buttons through the host callback: stranger rejected, confirm replaces the card once, forget removes, correct hint then a reply corrects', async () => {
    const t = fixture(), scope = spaceScope(t.space.id)
    const first = t.memory.add({ scope, kind: 'rule', title: '称呼', body: '叫我轻舟' })
    await t.host.handleMessage(t.message(`/memory confirm ${first.id}`))
    const card = t.fake.sent[0]!
    const click = (operatorOpenId: string, action: 'memory_confirm' | 'memory_correct' | 'memory_forget', sent = card) =>
      t.host.handleCardAction({ operatorOpenId, chatId: 'dm', messageId: sent.messageId, value: t.button(sent, action), raw: {} })
    expect(await click('bob', 'memory_confirm')).toMatchObject({ toast: { type: 'error', content: expect.stringContaining('本人') } })
    expect(await click('bob', 'memory_forget')).toMatchObject({ toast: { type: 'error' } })
    expect(t.memory.get(first.id)).toMatchObject({ status: 'candidate', revision: 1 })
    expect(t.fake.sent).toHaveLength(1)
    const confirmed = await click('alice', 'memory_confirm')
    expect(confirmed).toMatchObject({ toast: { type: 'success', content: '已记住。' }, card: { type: 'raw' } })
    expect(JSON.stringify(confirmed)).toContain('已记住')
    expect(t.memory.get(first.id)).toMatchObject({ status: 'confirmed', confirmation: { by: 'alice' } })
    expect(t.fake.sent).toHaveLength(2)
    const again = await click('alice', 'memory_confirm')
    expect(again).toMatchObject({ toast: { type: 'success', content: '已记住。' } })
    expect(again).not.toHaveProperty('card')
    expect(t.fake.sent).toHaveLength(2)
    expect(await click('alice', 'memory_forget')).toMatchObject({ toast: { type: 'error' } })

    const second = t.memory.add({ scope, kind: 'fact', title: '发布日期', body: '这期周三发布' })
    await t.host.handleMessage(t.message(`/memory confirm ${second.id}`))
    const secondCard = t.fake.sent[2]!
    expect(await click('alice', 'memory_forget', secondCard)).toMatchObject({ toast: { type: 'success', content: '已忘记。' }, card: { type: 'raw' } })
    expect(t.memory.get(second.id)).toBeUndefined()
    expect(t.fake.sent).toHaveLength(4)
    expect(await click('alice', 'memory_forget', secondCard)).toMatchObject({ toast: { type: 'success', content: '已忘记。' } })
    expect(t.fake.sent).toHaveLength(4)

    const third = t.memory.add({ scope, kind: 'rule', title: '称呼', body: '叫我全名' })
    await t.host.handleMessage(t.message(`/memory confirm ${third.id}`))
    const thirdCard = t.fake.sent[4]!
    expect(await click('alice', 'memory_correct', thirdCard)).toMatchObject({ toast: { type: 'info', content: expect.stringContaining('回复这张记忆卡') } })
    expect(t.fake.sent).toHaveLength(6)
    const hint = t.fake.sent[5]!
    expect(JSON.stringify(hint.payload)).toContain(`#${third.id}`)
    expect(await click('alice', 'memory_correct', thirdCard)).toMatchObject({ toast: { type: 'info' } })
    expect(t.fake.sent).toHaveLength(6)
    expect(t.memory.get(third.id)).toMatchObject({ status: 'candidate', revision: 1 })
    const reply = t.message('以后请叫我轻舟，不要用全名。', hint.messageId)
    t.classify.mockImplementationOnce(async input => {
      expect(input.allowExplicitPreference).toBe(true)
      expect(input.memoryTargets).toMatchObject([{ body: '叫我全名', replied: true }])
      return { kind: 'memory_save_preference', spans: [{ start: 0, end: reply.text.length }], targetRef: input.memoryTargets![0]!.ref, continueWork: false }
    })
    await t.host.handleMessage(reply)
    expect(t.memory.get(third.id)).toMatchObject({ status: 'superseded' })
    const corrected = t.memory.rules(scope).find(note => note.body === reply.text)!
    expect(corrected).toMatchObject({ status: 'confirmed', confirmation: { by: 'alice', messageId: reply.messageId }, source: { replaces: third.id } })
    expect(t.memory.get(third.id)?.supersededBy).toBe(corrected.id)
    expect(t.fake.sent).toHaveLength(7)
    expect(JSON.stringify(t.fake.sent[6]!.payload)).toContain('已记住这条个人偏好')
    expect(t.peer.state.allPrompts).toHaveLength(0)
    expect(t.registry.taskForMessage(reply.messageId)).toBeUndefined()
  })
})
