import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime, AcpRuntimeError } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator, type AbilityActor } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const pr = 'https://github.com/org/demo/pull/5066'
const issue = 'https://github.com/org/demo/issues/5065'
const privateError = '/private/example/session.log Authorization: Bearer TEST_SENTINEL'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-failure-receipt-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat', openId: 'alice' })
  const fake = new FakeFeishu(), agent = createFakeAgent(), log = createLogger('failure-receipt', 'error')
  fake.members.set('chat', new Set(['alice']))
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: agent.app }, log, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  const host = new Orchestrator({ cfg, registry, memory, ...sp, runtime, feishu: asFeishuClient(fake), tokens: new TokenIssuer('synthetic'),
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log })
  cleanup.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const message: InboundMessage = { eventId: 'event', messageId: 'message', chatId: 'chat', chatType: 'group', senderOpenId: 'alice', senderType: 'user',
    msgType: 'text', text: '@Friday 修复并交付 PR', mentions: [{ key: '@Friday', name: 'Friday', openId: 'bot' }], createTimeMs: Date.now() }
  const actor = (): AbilityActor => {
    const task = registry.taskForMessage(message.messageId)!, current = host.resolveActorForSession(task.sessionKey)!
    return { runId: current.runId, sessionKey: task.sessionKey, requesterOpenId: 'alice', spaceId: space.id, chatId: 'chat', chatType: 'group' }
  }
  const confirmed = (url = pr) => host.abilities.ccRepositoryWrite(actor(), { repo: 'org/demo', action: '已发布', url })
  const failAfterPrompt = (error: Error = new AcpRuntimeError(privateError, 'timeout')) => {
    const prompt = runtime.prompt.bind(runtime)
    vi.spyOn(runtime, 'prompt').mockImplementation(async (...args) => { await prompt(...args); throw error })
  }
  const task = () => registry.taskForMessage(message.messageId)!
  const attempt = () => new RunAttempts(registry.db).latestForTask(task().id)!
  const receipts = () => registry.db.prepare('SELECT delivery_key, status, remote_id FROM deliveries ORDER BY created_at').all() as { delivery_key: string; status: string; remote_id: string | null }[]
  return { host, registry, memory, fake, agent, message, actor, confirmed, failAfterPrompt, task, attempt, receipts, space, spaces: sp.spaces }
}

describe('failed Run repository receipts', () => {
  it.each(['timeout', 'dead'] as const)('delivers current confirmed links through the final ledger after %s, keeping the Run failed', async kind => {
    const t = fixture()
    t.agent.state.script = [{ kind: 'text', text: '未核验的内部草稿' }, { kind: 'tool', text: 'publish' },
      { kind: 'hook', run: async () => { await t.confirmed(issue); await t.confirmed(); await t.confirmed() } }]
    t.failAfterPrompt(new AcpRuntimeError(privateError, kind))
    await t.host.handleMessage(t.message)
    const answer = t.fake.answers().join('\n')
    expect(answer).toContain(`](${pr})`)
    expect(answer).toContain(`](${issue})`)
    expect(answer.split(pr)).toHaveLength(2)
    expect(answer).toContain('未能完成')
    expect(answer).not.toMatch(/任务\s*#\d+/)
    expect(answer).not.toContain('内部草稿')
    expect(JSON.stringify(t.fake.sent)).not.toContain('TEST_SENTINEL')
    expect(t.fake.of('replyText')).toHaveLength(0)
    expect(t.receipts()).toEqual([expect.objectContaining({ delivery_key: `task:${t.task().id}:final:0`, status: 'sent' })])
    expect(t.registry.resolveSession([`msg:${t.task().cardMessageId}`])?.sessionKey).toBe(t.task().sessionKey)
    expect(t.task()).toMatchObject({ status: 'failed', error: privateError })
    expect(t.attempt()).toMatchObject({ state: 'failed', result: { termination: 'runtime_error', outcome: 'failed', reason: 'runtime_error' } })
  })

  it('does not invent a publication from drafts or expose an internal Task number without a confirmed result', async () => {
    const t = fixture()
    t.agent.state.script = [{ kind: 'text', text: `打算创建 [PR](${pr})，本地未发布改动。` }]
    t.failAfterPrompt()
    await t.host.handleMessage(t.message)
    const sent = JSON.stringify(t.fake.sent)
    expect(sent).toContain('未能完成')
    expect(sent).not.toContain(pr)
    expect(sent).not.toContain('本地未发布')
    expect(sent).not.toContain('TEST_SENTINEL')
    expect(sent).not.toMatch(/任务\s*#\d+/)
    expect(t.task().status).toBe('failed')
  })

  it('does not bypass accumulated source permission by sending the confirmed URL as a notice', async () => {
    const t = fixture()
    t.agent.state.script = [{ kind: 'hook', run: async () => {
      await t.confirmed()
      t.host.noteCrossSpaceRead(t.actor().sessionKey, { chatId: 'private-other-group', name: '合成私密群', what: 'history' })
    } }]
    t.failAfterPrompt()
    await t.host.handleMessage(t.message)
    expect(JSON.stringify(t.fake.sent)).not.toContain(pr)
    expect(t.receipts().some(r => r.delivery_key.includes(':final:'))).toBe(false)
    expect(t.task().status).toBe('failed')
  })

  it.each(['stop', 'archive', 'remove-actor'] as const)('does not disclose even a confirmed URL after %s', async change => {
    const t = fixture()
    t.agent.state.script = [{ kind: 'hook', run: async () => {
      await t.confirmed()
      if (change === 'archive') t.spaces.archive(t.space.id)
      else if (change === 'remove-actor') t.spaces.removeMember(t.space.id, 'alice')
      else t.host.persistHumanRunStop({ actorOpenId: 'alice', spaceId: t.space.id, runId: t.actor().runId!, taskId: t.task().id,
        assertCurrent: () => t.spaces.get(t.space.id)! }).afterCommit()
    } }]
    t.failAfterPrompt()
    await t.host.handleMessage(t.message)
    expect(JSON.stringify(t.fake.sent)).not.toContain(pr)
    expect(t.receipts().some(r => r.delivery_key.includes(':final:'))).toBe(false)
    if (change === 'stop') expect(t.task().status).toBe('cancelled')
  })

  it('records an unknown failure-receipt POST without sending a replacement notice', async () => {
    const t = fixture(), reply = t.fake.replyMarkdown.bind(t.fake)
    vi.spyOn(t.fake, 'replyMarkdown').mockImplementation(async (...args) => { await reply(...args); throw new Error('synthetic ACK lost') })
    t.agent.state.script = [{ kind: 'hook', run: () => t.confirmed() }]
    t.failAfterPrompt()
    await t.host.handleMessage(t.message)
    expect(t.fake.of('replyMarkdown')).toHaveLength(1)
    expect(t.fake.of('replyText')).toHaveLength(0)
    expect(t.receipts()).toEqual([expect.objectContaining({ delivery_key: `task:${t.task().id}:final:0`, status: 'unknown' })])
    expect(t.attempt()).toMatchObject({ state: 'failed', result: { termination: 'runtime_error', outcome: 'failed', reason: 'runtime_error' } })
  })

  it('does not supplement an already unknown tool delivery after an unrelated runtime failure', async () => {
    const t = fixture(), reply = t.fake.replyFile.bind(t.fake)
    vi.spyOn(t.fake, 'replyFile').mockImplementation(async (...args) => { await reply(...args); throw new Error('synthetic file ACK lost') })
    t.agent.state.script = [{ kind: 'hook', run: async () => {
      await t.confirmed()
      const a = t.actor()
      await t.host.deliverToolResult(a.sessionKey, a.runId!, { kind: 'file', name: 'result.txt', data: Buffer.from('synthetic') }).catch(() => undefined)
    } }]
    t.failAfterPrompt()
    await t.host.handleMessage(t.message)
    expect(t.fake.of('replyFile')).toHaveLength(1)
    expect(t.receipts()).toEqual([expect.objectContaining({ status: 'unknown' })])
    expect(t.fake.of('replyMarkdown')).toHaveLength(0)
    expect(t.fake.of('replyText')).toHaveLength(0)
    expect(t.task().status).toBe('failed')
  })

  it('preserves a late tool ACK without posting a failure receipt while its result is still pending', async () => {
    const t = fixture(), reply = t.fake.replyFile.bind(t.fake)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let pending: Promise<unknown> | undefined
    vi.spyOn(t.fake, 'replyFile').mockImplementation(async (...args) => {
      const ack = await reply(...args)
      entered.resolve()
      await release.promise
      return ack
    })
    t.agent.state.script = [{ kind: 'hook', run: async () => {
      await t.confirmed()
      const a = t.actor()
      pending = t.host.deliverToolResult(a.sessionKey, a.runId!, { kind: 'file', name: 'result.txt', data: Buffer.from('synthetic') }).catch(() => undefined)
      await entered.promise
    } }]
    t.failAfterPrompt()
    try {
      await t.host.handleMessage(t.message)
      expect(t.receipts()).toEqual([expect.objectContaining({ status: 'planned' })])
      expect(t.fake.of('replyMarkdown')).toHaveLength(0)
      expect(t.fake.of('replyText')).toHaveLength(0)
    } finally { release.resolve(); await pending }
    expect(t.receipts()).toEqual([expect.objectContaining({ status: 'sent' })])
    expect(t.task().status).toBe('failed')
  })

  it('does not hide an unknown attachment note behind a fresh failure result', async () => {
    const t = fixture(), reply = t.fake.replyMarkdown.bind(t.fake)
    vi.spyOn(t.fake, 'replyMarkdown').mockImplementation(async (...args) => { await reply(...args); throw new Error('synthetic note ACK lost') })
    t.agent.state.script = [{ kind: 'hook', run: async () => {
      await t.confirmed()
      const a = t.actor()
      await t.host.deliverToolResult(a.sessionKey, a.runId!, { kind: 'file', name: 'result.txt', data: Buffer.from('synthetic'), note: '文件附言' })
    } }]
    t.failAfterPrompt()
    await t.host.handleMessage(t.message)
    expect(t.receipts().map(r => r.status)).toEqual(['sent', 'unknown'])
    expect(t.fake.of('replyMarkdown')).toHaveLength(1)
    expect(t.fake.of('replyText')).toHaveLength(0)
    expect(JSON.stringify(t.fake.sent)).not.toContain(pr)
  })

  it('does not replace an already sent final if a later local step fails', async () => {
    const t = fixture()
    vi.spyOn(t.memory, 'add').mockImplementation(() => { throw new Error('synthetic post-delivery memory failure') })
    t.agent.state.script = [{ kind: 'hook', run: () => t.confirmed() }, { kind: 'text', text: '代码已提交，待核对 CI。' }]
    await t.host.handleMessage(t.message)
    expect(t.fake.of('replyMarkdown')).toHaveLength(1)
    expect(t.fake.of('replyText')).toHaveLength(0)
    expect(t.receipts()).toEqual([expect.objectContaining({ delivery_key: `task:${t.task().id}:final:0`, status: 'sent' })])
    expect(t.task().status).toBe('failed')
  })

  it('does not reuse another Run publication on a later failed request', async () => {
    const t = fixture()
    t.agent.state.script = [{ kind: 'hook', run: () => t.confirmed() }, { kind: 'text', text: '结果已提交。' }]
    await t.host.handleMessage(t.message)
    const before = t.fake.sent.length
    t.agent.state.script = [{ kind: 'text', text: '另一个未完成的草稿。' }]
    t.failAfterPrompt()
    await t.host.handleMessage({ ...t.message, eventId: 'other-event', messageId: 'other-message', text: '@Friday 另一个独立问题' })
    expect(JSON.stringify(t.fake.sent.slice(before))).not.toContain(pr)
    expect(t.registry.taskForMessage('other-message')?.status).toBe('failed')
  })
})
