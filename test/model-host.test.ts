import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpRuntime, textBlock } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Proactive } from '../src/core/proactive.js'
import { ModelApplication } from '../src/core/model-selection.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RunModels } from '../src/core/run-models.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'
import { choiceA, choiceB, deferred, modelAgent } from './helpers/model-agent.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'friday-model-host-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off',
    FRIDAY_ACP_MODEL_PROVIDER: 'provider', FRIDAY_ACP_MODEL: 'a', FRIDAY_PROMPT_TIMEOUT_MS: '5000',
    FRIDAY_ALLOWED_MODELS: JSON.stringify(['a', 'b'].map(modelId => ({ providerId: 'provider', modelId, accountRef: 'deployment' }))) })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), sp = spaceDeps(registry.db, { admins: ['alice'] })
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'group', openId: 'alice' })
  const attempts = new RunAttempts(registry.db), runs = new RunModels(registry.db), peer = modelAgent(), fake = new FakeFeishu()
  fake.members.set('group', new Set(['alice']))
  const log = createLogger('model-host', 'error'), runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: peer.app }, maxConcurrent: 1,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log })
  const models = new ModelApplication({ runtime, ...sp, runs, policy: () => cfg.dsh.models! })
  const cache = new MessageCache(registry.db), messages = new MessageService(asFeishuClient(fake), cache, log)
  const proactive = new Proactive(registry.db, { ...cfg.proactive, minMessages: 2 })
  const host = new Orchestrator({ cfg, registry, ...sp, models, memory: new ChannelMemory(registry.db), feishu: asFeishuClient(fake), runtime,
    messages, proactive, tokens: new TokenIssuer('synthetic'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log })
  closes.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  let serial = 0
  function message(text = '看看这个函数的返回值。'): InboundMessage {
    const id = `model-host-${++serial}`
    return { eventId: id, messageId: id, chatId: 'group', chatType: 'group', threadId: 'topic', tenantId: 'tenant', msgType: 'text', text,
      senderOpenId: 'alice', senderType: 'user', mentions: [{ key: '@Friday', name: 'Friday', openId: 'bot' }], createTimeMs: Date.now() }
  }
  const runFor = (msg: InboundMessage) => {
    const task = registry.taskForMessage(msg.messageId)!
    return { task, run: host.resolveActorForSession(task.sessionKey)! }
  }
  return { cfg, registry, ...sp, space, attempts, runs, peer, fake, runtime, models, host, message, runFor, cache, proactive }
}

describe('host model selection and stop boundaries', () => {
  it('leaves an unconfigured different route untouched and returns the actionable settings message', async () => {
    const t = setup(); t.peer.state.initialValue = choiceB
    await t.host.handleMessage(t.message())
    expect(t.peer.state.setCalls).toHaveLength(0)
    expect(t.peer.state.prompts).toHaveLength(0)
    expect(t.fake.sent.some(item => JSON.stringify(item).includes('空间模型设置里选择'))).toBe(true)
    expect(t.fake.sent.some(item => JSON.stringify(item).includes('详细原因已记录'))).toBe(false)
  })
  it('keeps proactive judgment on the deployment route after changing a space main model', async () => {
    const t = setup(), catalog = await t.models.catalog(t.space.id, () => {})
    t.models.select(t.space.id, { value: choiceB, expectedTag: catalog.tag, generation: catalog.generation })
    const since = t.proactive.enable('group', 'alice').checkedUntil
    t.cache.upsert('group', [1, 2].map(i => historyMsg({ messageId: `discussion-${i}`, text: `分享一下这个用法 ${i}`, createTimeMs: since + i })))
    await t.host.runProactiveCheck('group')
    expect(t.peer.state.prompts).toHaveLength(1)
    expect(t.peer.state.prompts[0]?.value).toBe(choiceA)
  })
  it('sends the selected route to ACP, records context occupancy, and changes the next turn without changing business cwd', async () => {
    const t = setup(), first = t.message()
    await t.host.handleMessage(first)
    const task = t.registry.taskForMessage(first.messageId)!, before = t.registry.getSession(task.sessionKey)!
    expect(t.peer.state.prompts[0]?.value).toBe(choiceA)
    const runId = t.registry.db.prepare('SELECT id FROM run_attempts WHERE task_id=?').get(task.id)!.id as string
    expect(t.runs.get(runId)).toMatchObject({ modelId: 'a', contextUsed: 31, contextSize: 1000, usageStatus: 'unavailable' })
    const catalog = await t.models.catalog(t.space.id, () => {})
    t.models.select(t.space.id, { value: choiceB, expectedTag: catalog.tag, generation: catalog.generation })
    await t.host.handleMessage(t.message('继续看看调用它的地方。'))
    expect(t.peer.state.prompts[1]?.value).toBe(choiceB)
    expect(t.registry.getSession(task.sessionKey)?.cwd).toBe(before.cwd)
  })
  it.each(['stop', 'archive'] as const)('never sends a prompt after %s during model selection', async mode => {
    const t = setup(), entered = deferred(), release = deferred(), msg = t.message()
    t.peer.state.onSet = async () => { entered.resolve(); await release.promise }
    const pending = t.host.handleMessage(msg); await entered.promise
    const { task, run } = t.runFor(msg)
    if (mode === 'stop') {
      const stopped = t.host.persistHumanRunStop({ actorOpenId: 'alice', spaceId: t.space.id, runId: run.runId!, taskId: task.id, assertCurrent: () => t.spaces.get(t.space.id)! })
      stopped.afterCommit()
    } else t.spaces.archive(t.space.id)
    release.resolve(); await pending
    expect(t.peer.state.prompts).toHaveLength(0)
    expect(t.runs.get(run.runId!)).toBeUndefined()
    expect(t.fake.sent.some(item => JSON.stringify(item).includes('结果正常'))).toBe(false)
  })
  it('rechecks a persistent stop at Gate admission even before the abort callback runs', async () => {
    const t = setup(); await t.runtime.start()
    const blocker = await t.runtime.newSession('/synthetic/blocker'), entered = deferred(), release = deferred()
    t.peer.state.onPrompt = async () => { entered.resolve(); await release.promise }
    const occupied = t.runtime.prompt(blocker, [textBlock('hold')]); await entered.promise
    const msg = t.message(), pending = t.host.handleMessage(msg)
    await new Promise<void>((resolve, reject) => {
      let count = 0
      const check = () => { if (t.runtime.load().waiting) resolve(); else if (++count > 200) reject(new Error('did not queue')); else setTimeout(check, 5) }
      check()
    })
    const { task, run } = t.runFor(msg)
    const stopped = t.host.persistHumanRunStop({ actorOpenId: 'alice', spaceId: t.space.id, runId: run.runId!, taskId: task.id, assertCurrent: () => t.spaces.get(t.space.id)! })
    release.resolve(); await occupied; await pending; stopped.afterCommit()
    expect(t.peer.state.prompts).toHaveLength(1)
    expect(t.runs.get(run.runId!)?.admittedAt).toBeNull()
  })
  it('does not fall back or publish a synthetic success when the setter fails', async () => {
    const t = setup(); t.peer.state.rejectSet = true
    const msg = t.message(); await t.host.handleMessage(msg)
    expect(t.peer.state.setCalls).toHaveLength(1); expect(t.peer.state.prompts).toHaveLength(0)
    expect(t.registry.taskForMessage(msg.messageId)?.status).toBe('failed')
    expect(t.fake.sent.some(item => JSON.stringify(item).includes('结果正常'))).toBe(false)
  })
})
