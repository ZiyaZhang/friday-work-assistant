import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IngressClassificationInput, IngressDecision } from '../src/acp/ingress-classifier.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { TaskEvents, type TaskEventKind } from '../src/core/task-events.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Real human ingress, SQLite/TaskEvents, managed ACP and control receipts.
 * Classification and the platform are synthetic; no natural-model acceptance claim. */
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-work-candidates-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_DEFAULT_EXECUTION: 'managed', FRIDAY_PROMPT_TIMEOUT_MS: '10000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(join(home, 'state.sqlite')), log = createLogger('work-candidates', 'error')
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'group', openId: 'alice' })
  sp.spaces.addMember(space.id, 'bob', 'member')
  const fake = new FakeFeishu(); fake.chats = [{ chatId: 'group', name: 'Synthetic group' }]
  fake.members.set('group', new Set(['alice', 'bob']))
  const execution = managedHostRuntime(registry, home, log), state = execution.peer.state
  state.script = [{ kind: 'text', text: '合成执行结果' }]
  const classify = vi.fn<(input: IngressClassificationInput) => Promise<IngressDecision>>(async () => ({ kind: 'clarify' }))
  const host = new Orchestrator({ cfg, registry, ...sp, memory: new ChannelMemory(registry.db), feishu: asFeishuClient(fake),
    runtime: execution.runtime, managed: execution.managed, tokens: new TokenIssuer('synthetic'), ingressClassifier: { classify },
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/synthetic', botOpenId: 'bot', log })
  let serial = 0
  const message = (text: string, patch: Partial<InboundMessage> = {}): InboundMessage => ({
    eventId: `event-${++serial}`, messageId: `input-${serial}`, chatId: 'group', chatType: 'group', tenantId: 'tenant',
    senderOpenId: 'alice', senderType: 'user', msgType: 'text', text: `@Friday ${text}`,
    mentions: [{ key: '@Friday', name: 'Friday', openId: 'bot' }], createTimeMs: 1_700_000_000_000 + serial, ...patch,
  })
  const original = message('修改原来的术语并提交草稿', { threadId: 'thread' })
  await host.handleMessage(original)
  const root = registry.taskForMessage(original.messageId)!
  expect(root.status).toBe('done')
  const workKey = registry.taskWork.get(root.id)!.key
  const followup = (text: string, patch: Partial<InboundMessage> = {}) => message(text,
    { threadId: 'thread', parentId: original.messageId, rootId: original.messageId, ...patch })
  classify.mockImplementationOnce(async input => ({ kind: 'amend', targetRef: input.message.replyToRef! }))
  const addition = followup('最新真人要求：保留链接和原来的校验结果')
  await host.handleMessage(addition)
  const human = registry.taskForMessage(addition.messageId)!
  expect(registry.taskWork.get(human.id)?.key).toBe(workKey)
  const releases: (() => void)[] = []
  cleanups.push(async () => { for (const release of releases) release(); host.beginShutdown(); await execution.runtime.stop()
    await host.waitForShutdown(2000); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const event = (kind: TaskEventKind = 'github_ci') => new TaskEvents(registry).admit({ key: `synthetic-${++serial}`,
    kind, sourceTaskId: human.id, targetSessionKey: root.sessionKey, domainId: `domain-${serial}`, prompt: 'SYSTEM EVENT: terminal check evidence, not a human instruction' }).task
  const activeEvent = async () => {
    // The generic TaskEvents execution path has the same candidate/control binding
    // as CI; its provider-specific CI authorization is exercised in CI host tests.
    // meeting_draft is the kind without its own admission: since P3-3b, issue_assessment
    // Tasks are re-verified against their assessment at admission and fail closed here.
    const task = event('meeting_draft'), entered = barrier(), release = barrier(); releases.push(release.resolve)
    state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } }, { kind: 'text', text: '系统续接完成' }]
    host.wakeQueuedTask(task.id); await entered.promise
    expect(registry.getTask(task.id)?.status).toBe('running')
    return { task, release }
  }
  return { registry, host, classify, state, fake, sp, space, original, root, human, addition, workKey, followup, event, activeEvent }
}

describe('one conversational candidate per real Work', () => {
  it('projects a queued CI event and an explicit original reply as one Work with the latest human instruction', async () => {
    const t = await fixture(), event = t.event()
    const msg = t.followup('结果的链接在哪里')
    await t.host.handleMessage(msg)
    const input = t.classify.mock.calls.at(-1)![0]
    expect(input.candidates).toHaveLength(1)
    const target = input.candidates[0]!
    expect(input.message.replyToRef).toBe(target.ref)
    expect(target).toMatchObject({ status: 'queued', lastInputAt: t.addition.createTimeMs })
    expect(target.title).toContain('修改原来的术语并提交草稿')
    expect(target.title).toContain('最新真人要求')
    expect(target.title).not.toContain('SYSTEM EVENT')
    const handoff = JSON.parse(String(t.registry.db.prepare('SELECT handoff FROM ingress_routes WHERE message_id=?').get(msg.messageId)!.handoff))
    expect(handoff.targets).toHaveLength(1)
    expect(handoff.targets[0].task.id).toBe(event.id)
    expect(t.registry.taskForMessage(msg.messageId)).toBeUndefined() // clarify remains a real no-op.
    expect(t.registry.getTask(event.id)?.status).toBe('queued')
  })

  it('keeps the active system Run as the stop target instead of stopping the old human attempt', async () => {
    const t = await fixture(), active = await t.activeEvent()
    t.classify.mockImplementationOnce(async input => ({ kind: 'stop', targetRef: input.message.replyToRef! }))
    const msg = t.followup('停止这次执行')
    await t.host.handleMessage(msg)
    active.release.resolve()
    await expect.poll(() => t.registry.getTask(active.task.id)?.status).toBe('cancelled')
    expect(t.registry.getTask(active.task.id)?.stopReason).toBe('user_requested')
    expect(t.registry.getTask(t.human.id)?.status).toBe('done')
    expect(t.registry.workContexts.get(t.workKey)?.pauseReasons.map(item => item.reason)).toContain('run_stop')
    const reply = JSON.stringify(t.fake.sent.filter(item => item.target === msg.messageId))
    expect(reply).toContain('修改原来的术语')
    expect(reply).not.toContain('SYSTEM EVENT')
  })

  it('reports the current system execution without admitting work or lifting controls', async () => {
    const t = await fixture(), active = await t.activeEvent()
    const before = t.registry.workContexts.get(t.workKey)
    t.classify.mockImplementationOnce(async input => ({ kind: 'progress', targetRef: input.message.replyToRef! }))
    const msg = t.followup('这次执行现在到哪了')
    await t.host.handleMessage(msg)
    expect(t.classify.mock.calls.at(-1)![0].candidates).toHaveLength(1)
    expect(t.registry.taskForMessage(msg.messageId)).toBeUndefined()
    expect(t.registry.getTask(active.task.id)?.status).toBe('running')
    expect(t.registry.workContexts.get(t.workKey)).toEqual(before)
    const reply = JSON.stringify(t.fake.sent.filter(item => item.target === msg.messageId))
    expect(reply).toContain('执行中')
    expect(reply).toContain('修改原来的术语')
    expect(reply).not.toContain('SYSTEM EVENT')
    active.release.resolve()
  })

  it('admits a real amendment to the same Work while the system event runs, without fabricating a human event', async () => {
    const t = await fixture(), active = await t.activeEvent()
    t.classify.mockImplementationOnce(async input => ({ kind: 'amend', targetRef: input.message.replyToRef! }))
    const msg = t.followup('请把这个结果的链接补给我')
    const pending = t.host.handleMessage(msg)
    await expect.poll(() => t.registry.taskForMessage(msg.messageId)?.id).toBeDefined()
    active.release.resolve(); await pending
    const next = t.registry.taskForMessage(msg.messageId)!
    expect(t.registry.taskWork.get(next.id)?.key).toBe(t.workKey)
    expect(t.registry.dispatches.get(next.id)?.inbound).toEqual(msg)
    expect(new TaskEvents(t.registry).get(next.id)).toBeUndefined()
    expect(t.registry.getTask(active.task.id)?.status).toBe('cancelled')
    expect(next.status).toBe('done')
    expect(t.state.allPrompts.at(-1)?.text).toContain('请把这个结果的链接补给我')
    expect(t.registry.db.prepare('SELECT decision FROM ingress_routes WHERE message_id=?').get(msg.messageId)?.decision)
      .toContain('"kind":"amend"')
  })

  it('continues after the system event finished using the latest real human input and the same Work', async () => {
    const t = await fixture(), active = await t.activeEvent()
    active.release.resolve()
    await expect.poll(() => t.registry.getTask(active.task.id)?.status).toBe('done')
    t.classify.mockImplementationOnce(async input => ({ kind: 'amend', targetRef: input.message.replyToRef! }))
    const msg = t.followup('再核对这个交付里的一个细节')
    await t.host.handleMessage(msg)
    const input = t.classify.mock.calls.at(-1)![0], next = t.registry.taskForMessage(msg.messageId)!
    expect(input.candidates).toHaveLength(1)
    expect(input.candidates[0]).toMatchObject({ lastInputAt: t.addition.createTimeMs, status: 'done' })
    expect(input.candidates[0]!.title).toContain('最新真人要求')
    expect(input.candidates[0]!.title).not.toContain('SYSTEM EVENT')
    expect(t.registry.listAmendedTasks(next.id).map(task => task.id)).toContain(t.human.id)
    expect(t.registry.taskWork.get(next.id)?.key).toBe(t.workKey)
  })

  it('keeps genuinely different Works separate and does not expose another actor’s request', async () => {
    const t = await fixture()
    t.classify.mockResolvedValueOnce({ kind: 'work_request' })
    const other = t.followup('完全独立的问题 B')
    await t.host.handleMessage(other)
    const second = t.registry.taskForMessage(other.messageId)!
    expect(second.sessionKey).toBe(t.root.sessionKey)
    expect(t.registry.taskWork.get(second.id)?.key).not.toBe(t.workKey)
    const bob = t.followup('另一成员的独立问题 C', { senderOpenId: 'bob' })
    await t.host.handleMessage(bob)
    expect(t.registry.taskForMessage(bob.messageId)?.requesterOpenId).toBe('bob')
    t.event()
    const msg = t.followup('原来那个交付的链接')
    await t.host.handleMessage(msg)
    const input = t.classify.mock.calls.at(-1)![0]
    expect(input.candidates).toHaveLength(2)
    const a = input.candidates.find(candidate => candidate.title.includes('最新真人要求'))!
    expect(input.message.replyToRef).toBe(a.ref)
    expect(input.candidates.some(candidate => candidate.title.includes('独立的问题 B'))).toBe(true)
    expect(input.candidates.some(candidate => candidate.title.includes('独立问题 C'))).toBe(false)
  })

  it.each(['stop', 'new_input', 'space_access'] as const)('rejects a stale amendment if %s changes while classification awaits', async changed => {
    const t = await fixture(), active = await t.activeEvent(), entered = barrier(), release = barrier()
    t.classify.mockImplementationOnce(async input => { entered.resolve(); await release.promise
      return { kind: 'amend', targetRef: input.message.replyToRef! } })
    const msg = t.followup('请继续核对原来的交付')
    const pending = t.host.handleMessage(msg); await entered.promise
    if (changed === 'stop') t.registry.workContexts.control(t.workKey, { action: 'pause', reason: 'manual', causeRef: 'new-stop' })
    else if (changed === 'space_access') t.sp.spaces.archive(t.space.id)
    else {
      const newer = t.followup('更新的真实范围')
      t.registry.createTaskOnce({ sessionKey: t.root.sessionKey, messageId: newer.messageId, requesterOpenId: 'alice',
        prompt: newer.text, inbound: newer, amendsTaskId: t.human.id })
    }
    release.resolve(); await pending
    expect(t.registry.taskForMessage(msg.messageId)).toBeUndefined()
    active.release.resolve()
  })
})
