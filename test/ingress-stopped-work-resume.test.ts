import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IngressClassifier, type IngressClassificationInput, type IngressDecision } from '../src/acp/ingress-classifier.js'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { ChangeManager, type ChangePreparationResult } from '../src/github/changes.js'
import { GitHubIdentity } from '../src/github/identity.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

/** Real inbound routing, managed ACP, Work/Run/dispatch and disk SQLite; only the model/platform are synthetic. */
async function fixture(withChange = false) {
  const home = mkdtempSync(join(tmpdir(), 'friday-stopped-work-')), path = join(home, 'friday.db')
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_DEFAULT_EXECUTION: 'managed', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('stopped-work', 'error')
  const classify = vi.fn<(input: IngressClassificationInput) => Promise<IngressDecision>>(async () => ({ kind: 'new_work' }))
  let serial = 0, boots = 0
  const message = (text: string, patch: Partial<InboundMessage> = {}): InboundMessage => ({
    eventId: `event-${++serial}`, messageId: `input-${serial}`, chatId: 'private-chat', chatType: 'p2p', tenantId: 'tenant',
    senderOpenId: 'alice', senderType: 'user', msgType: 'text', text, mentions: [], createTimeMs: Date.now() + serial, ...patch,
  })
  const github = new GitHubIdentity({ apiUrl: 'https://api.github.com', mode: 'pat', token: 'synthetic', allowedRepos: ['org/demo'], writableRepos: ['org/demo'] }, log,
    { request: async () => { throw new Error('No remote HTTP in this test') } })
  function boot() {
    const registry = new Registry(path), sp = spaceDeps(registry.db, { admins: ['alice'] })
    const space = sp.spaces.ensure({ kind: 'p2p', chatId: 'private-chat', openId: 'alice' })
    const execution = managedHostRuntime(registry, home, log)
    execution.peer.state.counter = 100 * boots++
    execution.peer.state.script = [{ kind: 'text', text: 'synthetic task response' }]
    const host = new Orchestrator({ cfg, registry, ...sp, memory: new ChannelMemory(registry.db), feishu,
      runtime: execution.runtime, managed: execution.managed, tokens: new TokenIssuer('synthetic'), ingressClassifier: { classify },
      apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/synthetic', botOpenId: 'bot', log })
    const changes = new ChangeManager({ db: registry.db, github, cacheDir: join(home, 'git'), log,
      remoteUrlFor: () => `file://${join(home, 'remote.git')}` })
    return { registry, ...sp, space, host, changes, runtime: execution.runtime, state: execution.peer.state }
  }
  let k = boot(), prepared: ChangePreparationResult | undefined
  const close = async () => { await k.runtime.stop(); k.registry.close() }
  cleanups.push(async () => { await close(); rmSync(home, { recursive: true, force: true }) })
  const original = message('检查这份代码中的英文单复数')
  await k.host.handleMessage(original)
  const root = k.registry.taskForMessage(original.messageId)!
  const workKey = k.registry.taskWork.get(root.id)!.key
  const next = message('还请把同类的计数文案一起检查')
  classify.mockImplementation(async input => ({ kind: 'amend', targetRef: input.candidates[0]!.ref }))
  const entered = deferred(), release = deferred()
  k.state.script = [{ kind: 'hook', run: async () => {
    if (withChange) {
      const src = join(home, 'seed')
      const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', env: {
        PATH: process.env.PATH, GIT_AUTHOR_NAME: 'synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.test',
        GIT_COMMITTER_NAME: 'synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.test', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      } }).trim()
      git('init', '-q', src); writeFileSync(join(src, 'README.md'), 'one item\n')
      git('-C', src, 'add', 'README.md'); git('-C', src, 'commit', '-qm', 'synthetic')
      git('clone', '--bare', '-q', src, join(home, 'remote.git'))
      const actor = k.host.resolveActorForSession(root.sessionKey)!
      const session = k.registry.getSession(root.sessionKey)!
      prepared = await k.changes.prepare({ repo: 'org/demo', cwd: session.cwd, sessionKey: session.sessionKey,
        requesterOpenId: actor.requesterOpenId, workKey, assertAuthorized: () => {
          expect(k.host.resolveActorForSession(root.sessionKey)?.runId).toBe(actor.runId)
        } })
    }
    entered.resolve(); await release.promise
  } }, { kind: 'text', text: 'must not be delivered after stop' }]
  const running = k.host.handleMessage(next)
  await entered.promise
  const stopped = k.registry.taskForMessage(next.messageId)!
  classify.mockImplementation(async input => ({ kind: 'stop', targetRef: input.candidates.find(item => item.status === 'running')!.ref }))
  await k.host.handleMessage(message('停止这次执行'))
  release.resolve(); await running
  expect(k.registry.getTask(stopped.id)).toMatchObject({ status: 'cancelled', stopReason: 'user_requested' })
  expect(k.registry.workContexts.get(workKey)).toMatchObject({ lifecycle: 'open', inputSeq: 2, pauseReasons: [{ reason: 'run_stop' }] })
  classify.mockClear()
  k.state.script = [{ kind: 'text', text: 'continued original work' }]
  return { home, original, root, stopped, workKey, message, classify, fake, get k() { return k }, get prepared() { return prepared },
    async reboot() { await close(); k = boot() },
    resumeDecision(input: IngressClassificationInput): IngressDecision {
      const stoppedCandidate = input.candidates.find(item => item.status === 'cancelled')
      return stoppedCandidate ? { kind: 'amend', targetRef: stoppedCandidate.ref } : { kind: 'clarify' }
    } }
}

describe('new human instruction resumes a stopped execution, not a cancelled delegation', () => {
  it.each([false, true])('keeps original Work and prepared change across an explicit continuation (reboot=%s)', async reboot => {
    const t = await fixture(true)
    if (reboot) await t.reboot()
    const beforeRecovery = t.k.state.allPrompts.length
    await t.k.host.recoverHandoffs()
    expect(t.k.state.allPrompts.length).toBe(beforeRecovery)
    const count = t.k.state.allPrompts.length
    expect(t.k.registry.workContexts.get(t.workKey)?.pauseReasons).toHaveLength(1)
    const resume = t.message('恢复刚才那件英文单复数工作，并沿用已准备副本')
    t.classify.mockImplementation(async input => t.resumeDecision(input))
    await t.k.host.handleMessage(resume)
    const task = t.k.registry.taskForMessage(resume.messageId)
    expect(task).toBeDefined()
    expect(task).toMatchObject({ sessionKey: t.root.sessionKey, status: 'done', stopReason: 'end_turn' })
    expect(t.k.registry.taskWork.get(task!.id)?.key).toBe(t.workKey)
    expect(t.k.registry.listAmendedTasks(task!.id).map(item => item.id)).toContain(t.stopped.id)
    expect(t.k.registry.workContexts.get(t.workKey)).toMatchObject({ lifecycle: 'open', inputSeq: 3, pauseReasons: [] })
    const offered = t.classify.mock.calls[0]![0].candidates.find(item => item.status === 'cancelled')
    expect(offered).toMatchObject({ status: 'cancelled', work: { lifecycle: 'open', pauseReasons: ['run_stop'] } })
    expect(t.k.state.allPrompts.length).toBe(count + 1)
    const session = t.k.registry.getSession(task!.sessionKey)!
    expect(t.k.changes.list({ cwd: session.cwd, sessionKey: session.sessionKey, requesterOpenId: 'alice', workKey: t.workKey }))
      .toEqual([expect.objectContaining({ id: t.prepared!.id, dir: t.prepared!.dir, workAccess: 'current' })])
    await t.k.host.handleMessage(resume)
    expect(t.k.state.allPrompts.length).toBe(count + 1)
    expect(t.k.registry.workContexts.get(t.workKey)?.inputSeq).toBe(3)
  })

  it('progress and duplicate stop never lift the original pause', async () => {
    const t = await fixture(), before = t.k.registry.workContexts.get(t.workKey)!, count = t.k.state.allPrompts.length
    for (const kind of ['progress', 'stop'] as const) {
      t.classify.mockImplementation(async input => ({ kind, targetRef: input.message.replyToRef! }))
      await t.k.host.handleMessage(t.message(kind === 'progress' ? '刚才那件事现在是什么状态' : '保持停止', { parentId: t.stopped.messageId }))
      expect(t.k.registry.workContexts.get(t.workKey)).toEqual(before)
      expect(t.k.state.allPrompts.length).toBe(count)
    }
  })

  it.each(['manual', 'authorization', 'cancelled', 'owner', 'new_instruction', 'new_stop', 'space_disabled'] as const)(
    'does not clear a changed %s state while classification is pending', async change => {
      const t = await fixture(), entered = deferred(), release = deferred(), count = t.k.state.allPrompts.length
      t.classify.mockImplementation(async input => { entered.resolve(); await release.promise; return t.resumeDecision(input) })
      const msg = t.message('继续完成原来的修改', { parentId: t.stopped.messageId })
      const pending = t.k.host.handleMessage(msg)
      await entered.promise
      if (change === 'cancelled') t.k.registry.workContexts.control(t.workKey, { action: 'cancel' })
      else if (change === 'owner') t.k.registry.db.prepare('UPDATE work_contexts SET authority_open_id=? WHERE work_key=?').run('bob', t.workKey)
      else if (change === 'space_disabled') t.k.spaces.archive(t.k.space.id)
      else if (change === 'new_instruction') {
        const newer = t.message('先不要执行，补充新范围')
        t.k.registry.createTaskOnce({ sessionKey: t.root.sessionKey, messageId: newer.messageId, requesterOpenId: 'alice',
          prompt: newer.text, inbound: newer, amendsTaskId: t.stopped.id })
      } else t.k.registry.workContexts.control(t.workKey, { action: 'pause', reason: change === 'new_stop' ? 'run_stop' : change, causeRef: 'new-control' })
      const current = t.k.registry.workContexts.get(t.workKey)
      release.resolve(); await pending
      expect(t.k.registry.taskForMessage(msg.messageId)).toBeUndefined()
      expect(t.k.registry.workContexts.get(t.workKey)).toEqual(current)
      expect(t.k.state.allPrompts.length).toBe(count)
    })

  it('rolls back pause removal with a failed Task receipt and applies the same original input only once after recovery', async () => {
    const t = await fixture(), before = t.k.registry.workContexts.get(t.workKey), count = t.k.state.allPrompts.length
    const msg = t.message('请继续原来的修改')
    t.classify.mockImplementation(async input => t.resumeDecision(input))
    // Registration clears run_stop before inserting its receipt. Abort that last
    // insert to verify the existing ingress/createTask transaction owns both facts.
    t.k.registry.db.exec(`CREATE TRIGGER fail_resume_receipt BEFORE INSERT ON task_receipts
      BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END`)
    await expect(t.k.host.handleMessage(msg)).rejects.toThrow('synthetic receipt failure')
    expect(t.k.registry.workContexts.get(t.workKey)).toEqual(before)
    expect(t.k.registry.taskForMessage(msg.messageId)).toBeUndefined()
    expect(t.k.state.allPrompts.length).toBe(count)
    t.k.registry.db.exec('DROP TRIGGER fail_resume_receipt')
    await t.k.host.recoverHandoffs()
    expect(t.k.registry.taskForMessage(msg.messageId)).toMatchObject({ status: 'done', sessionKey: t.root.sessionKey })
    expect(t.k.registry.workContexts.get(t.workKey)).toMatchObject({ inputSeq: 3, pauseReasons: [] })
    expect(t.k.state.allPrompts.length).toBe(count + 1)
    expect(t.classify).toHaveBeenCalledTimes(1)
  })

  it('does not resume a cancelled Work or a different person through an explicit old reply', async () => {
    const t = await fixture(), count = t.k.state.allPrompts.length
    t.k.registry.workContexts.control(t.workKey, { action: 'cancel' })
    const cancelledWork = t.k.registry.workContexts.get(t.workKey)
    const stoppedTask = t.k.registry.getTask(t.stopped.id)
    const originalRuns = t.k.registry.db.prepare('SELECT id, state FROM run_attempts WHERE work_key = ? ORDER BY id').all(t.workKey)
    t.classify.mockImplementation(async input => input.message.replyToRef && input.message.replyToRef !== 'unavailable'
      ? { kind: 'amend', targetRef: input.message.replyToRef } : { kind: 'clarify' })
    const ownerReply = t.message('恢复原请求', { parentId: t.stopped.messageId })
    await t.k.host.handleMessage(ownerReply)
    expect(t.k.registry.taskForMessage(ownerReply.messageId)).toBeUndefined()
    expect(t.k.state.allPrompts.length).toBe(count)
    expect(t.k.registry.workContexts.get(t.workKey)).toEqual(cancelledWork)

    const otherReply = t.message('恢复原请求', { senderOpenId: 'bob', parentId: t.stopped.messageId })
    await t.k.host.handleMessage(otherReply)
    // An unrelated person's message may be clarified or admitted as their own
    // task. The old reply reference must never grant Alice's Work to that task.
    const independent = t.k.registry.taskForMessage(otherReply.messageId)
    if (independent) {
      expect(independent.requesterOpenId).toBe('bob')
      expect(independent.sessionKey).not.toBe(t.root.sessionKey)
      const work = t.k.registry.taskWork.get(independent.id)!
      expect(work.key).not.toBe(t.workKey)
      expect(work.rootTaskId).toBe(independent.id)
      expect(t.k.registry.workContexts.get(work.key)).toMatchObject({ authorityOpenId: 'bob', sessionKey: independent.sessionKey })
      expect(t.k.registry.listAmendedTasks(independent.id)).toEqual([])
    }
    expect(t.k.registry.workContexts.get(t.workKey)).toEqual(cancelledWork)
    expect(t.k.registry.workContexts.get(t.workKey)).toMatchObject({ lifecycle: 'cancelled', inputSeq: 2, pauseReasons: [{ reason: 'run_stop' }] })
    expect(t.k.registry.getTask(t.stopped.id)).toEqual(stoppedTask)
    expect(t.k.registry.db.prepare('SELECT id, state FROM run_attempts WHERE work_key = ? ORDER BY id').all(t.workKey)).toEqual(originalRuns)
  })
})

it('carries real Task status and Work pause facts through the classifier ACP snapshot', async () => {
  const log = createLogger('paused-classifier', 'error')
  const peer = createFakeAgent({ script: [{ kind: 'text', text: '{"kind":"amend","targetRef":"paused-original"}' }] })
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: peer.app }, log,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  const classifier = new IngressClassifier({ createRuntime: () => runtime, cwd: tmpdir(), timeoutMs: 1000, log })
  cleanups.push(() => classifier.stop())
  const candidate = { ref: 'paused-original', title: '原委托', status: 'cancelled', work: { lifecycle: 'open' as const, pauseReasons: ['run_stop'] } }
  expect(await classifier.classify({ message: { text: '请继续完成原委托' }, candidates: [candidate] })).toEqual({ kind: 'amend', targetRef: candidate.ref })
  expect(peer.state.allPrompts[0]!.text).toContain('"work":{"lifecycle":"open","pauseReasons":["run_stop"]}')
})
