import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Todos } from '../src/core/todos.js'
import { PersonalCollectionStore } from '../src/core/personal-collection.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { PersonalDevices } from '../src/personal/devices.js'
import { createLogger } from '../src/log.js'
import { dmThreadKey } from '../src/feishu/mention.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

it('continues the actual Feishu personal conversation through desktop input and returns a sourced final answer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-desktop-host-')), registry = new Registry(':memory:')
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home,
    FRIDAY_PUBLIC_MODE: 'true', FRIDAY_DEFAULT_EXECUTION: 'managed', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const log = createLogger('desktop-host-test', 'error'), sp = spaceDeps(registry.db), memory = new ChannelMemory(registry.db), todos = new Todos(registry.db)
  const space = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_friday', openId: 'alice' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  feishu.sendToUserOnce = (owner, payload) => fake.sendToUser(owner, payload)
  const userTokens = new UserTokenStore(registry.db, fake), execution = managedHostRuntime(registry, home, log)
  const personalCollection = new PersonalCollectionStore(registry.db, todos)
  const devices = new PersonalDevices({ db: registry.db, encryptionKey: Buffer.alloc(32, 1), relayToken: 'synthetic-desktop-relay-token', baseUrl: 'https://test.example', lifetimeMs: 86_400_000, assertOwner() {} })
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, personalCollection, userTokens, devices,
    feishu, runtime: execution.runtime, managed: execution.managed, tokens: new TokenIssuer('synthetic-test-key'), botOpenId: 'ou_bot', log,
    ingressClassifier: { classify: async () => ({ kind: 'work_request' }) }, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent' })
  const actor = { owner: 'alice', deviceId: 'synthetic-device', assertCurrent() {}, disconnect() {} }
  const inbound = { eventId: 'first-dm', messageId: 'first-dm', chatId: 'oc_friday', chatType: 'p2p' as const, senderType: 'user' as const,
    senderOpenId: 'alice', msgType: 'text', text: '帮我起草一段说明，主题是合成测试。', mentions: [], createTimeMs: Date.now() }
  try {
    execution.peer.state.script = [{ kind: 'text', text: '第一版说明：合成测试。' }]
    fake.messages.set(inbound.messageId, historyMsg({ ...inbound, senderName: 'Alice' }))
    await host.handleMessage(inbound)
    const first = registry.taskForMessage(inbound.messageId)!, main = registry.resolveSession([dmThreadKey('alice')])!
    expect(first.status).toBe('done')
    expect(main.sessionKey).toBe(first.sessionKey)
    const noFakeMessage = vi.spyOn(feishu, 'getMessage')
    execution.peer.state.script = [{ kind: 'text', text: '第二版说明：[合成 PR](https://github.com/example/test/pull/1)。' }]
    const requestId = randomUUID(), command = { operation: 'message', text: '把刚才的说明缩短。' }
    const received = host.personalDesktop!.execute(actor, command, requestId) as { taskId: number }
    expect(host.personalDesktop!.execute(actor, command, requestId)).toEqual(received)
    host.personalDesktop!.afterCommit()
    await expect.poll(() => registry.getTask(received.taskId)?.status, { timeout: 6000 }).toBe('done')
    const next = registry.getTask(received.taskId)!
    expect(next.sessionKey).toBe(first.sessionKey)
    expect(execution.peer.state.allPrompts.at(-1)!.sessionId).toBe(execution.peer.state.allPrompts[0]!.sessionId)
    expect(noFakeMessage.mock.calls.every(([id]) => !String(id).startsWith('desktop:'))).toBe(true)
    expect(fake.reactionLog.every(record => !record.messageId.startsWith('desktop:'))).toBe(true)
    const read = await host.personalDesktop!.prepare('alice', { operation: 'result', taskId: next.id }, () => {})
    expect(read!()).toMatchObject({ body: '第二版说明：[合成 PR](https://github.com/example/test/pull/1)。', taskId: next.id })
    const chat = await host.personalDesktop!.prepare('alice', { operation: 'conversation' }, () => {})
    expect((chat!() as any).items.map((item: any) => item.id)).toEqual([first.id, next.id])
    expect(fake.answers().at(-1)).toContain('第二版说明')
    // Independent work cannot steal the main alias.
    ;(host as any).createSessionFor({ ...inbound, messageId: 'separate-work', eventId: 'separate-work' }, { independent: true })
    expect(registry.resolveSession([dmThreadKey('alice')])?.sessionKey).toBe(main.sessionKey)
    // Continuing an existing work reuses its identity; a rolled-back stop must
    // not signal the runtime. A committed stop suppresses its unfinished answer.
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(done => { entered = done }), blocked = new Promise<void>(done => { release = done })
    execution.peer.state.script = [{ kind: 'hook', run: async () => { entered(); await blocked } }, { kind: 'text', text: 'STOPPED_ANSWER_MUST_NOT_APPEAR' }]
    const follow = host.personalDesktop!.execute(actor, { operation: 'message', text: '补充该工作的说明。', taskId: next.id }, randomUUID()) as { taskId: number }
    host.personalDesktop!.afterCommit(); await started
    const confirmation = host.confirmAction({ sessionKey: main.sessionKey, header: '工具验收', headline: '公开文档读取', approver: 'requester' })
    await expect.poll(() => {
      const works = host.personalDesktop!.execute(actor, { operation: 'works' }, randomUUID()) as any
      return works.items.find((item: any) => item.id === follow.taskId)?.progress
    }).toMatchObject({ state: 'waiting_user', nextAction: 'confirm_permission', detail: expect.stringContaining('飞书私聊') })
    const key = registry.taskWork.get(next.id)!.key
    expect(registry.taskWork.get(follow.taskId)?.key).toBe(key)
    const revision = registry.workContexts.get(key)!.revision
    registry.db.exec('BEGIN')
    host.personalDesktop!.execute(actor, { operation: 'work', taskId: follow.taskId, revision, action: 'stop' }, randomUUID())
    registry.db.exec('ROLLBACK'); host.personalDesktop!.discardEffects()
    expect(execution.peer.state.cancelled).toEqual([])
    expect(registry.workContexts.get(key)!.revision).toBe(revision)
    host.personalDesktop!.execute(actor, { operation: 'work', taskId: follow.taskId, revision, action: 'stop' }, randomUUID())
    host.personalDesktop!.afterCommit(); release()
    expect(await confirmation).toBe(false)
    await expect.poll(() => registry.getTask(follow.taskId)?.status).toBe('cancelled')
    expect(fake.answers().join('\n')).not.toContain('STOPPED_ANSWER_MUST_NOT_APPEAR')
    execution.peer.state.script = [{ kind: 'text', text: '继续补充后的最终说明。' }]
    const continued = host.personalDesktop!.execute(actor, { operation: 'message', text: '继续，保留来源。', taskId: follow.taskId }, randomUUID()) as { taskId: number }
    host.personalDesktop!.afterCommit()
    await expect.poll(() => registry.getTask(continued.taskId)?.status).toBe('done')
    expect(registry.taskWork.get(continued.taskId)?.key).toBe(key)
    expect(registry.workContexts.get(key)!.pauseReasons).toEqual([])
    // Completed outputs remain readable after the work is closed. It does not
    // grant permission to execute or continue a cancelled work.
    const work = registry.workContexts.get(key)!
    host.personalDesktop!.execute(actor, { operation: 'work', taskId: continued.taskId, revision: work.revision, action: 'cancel' }, randomUUID())
    host.personalDesktop!.afterCommit()
    const closed = await host.personalDesktop!.prepare('alice', { operation: 'result', taskId: continued.taskId }, () => {})
    expect((closed!() as any).body).toBe('继续补充后的最终说明。')
    expect(() => host.personalDesktop!.execute(actor, { operation: 'message', text: '不应重新启动。', taskId: continued.taskId }, randomUUID())).toThrow('不能继续')
    sp.spaces.archive(space.id)
    expect(() => read!()).toThrow()
    await expect(host.personalDesktop!.prepare('alice', { operation: 'result', taskId: next.id }, () => {})).rejects.toThrow()
  } finally {
    host.beginShutdown(); await execution.runtime.stop(); await host.waitForShutdown(1000)
    registry.close(); rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks()
  }
}, 15_000)
