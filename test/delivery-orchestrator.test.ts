import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Proactive } from '../src/core/proactive.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { FeishuClient } from '../src/feishu/client.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('delivery-integration', 'error')
const SENTINEL = 'SYNTHETIC_PRIVATE_SENTINEL'
function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return { eventId: 'event-a', messageId: 'message-a', chatId: 'chat_a', chatType: 'group', msgType: 'text', text: '@Friday 回答', senderOpenId: 'alice', senderType: 'user', mentions: [{ key: '@Friday', openId: 'bot', name: 'Friday' }], createTimeMs: Date.now(), ...over }
}

function setup(continueWork = false) {
  const home = mkdtempSync(join(tmpdir(), 'friday-delivery-integration-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:')
  const sp = spaceDeps(registry.db)
  const a = sp.spaces.ensure({ kind: 'group', chatId: 'chat_a', openId: 'alice' })
  const b = sp.spaces.ensure({ kind: 'group', chatId: 'chat_b', openId: 'bob' })
  const feishu = new FakeFeishu()
  feishu.threadIdForReply = 'thread-a'
  feishu.members.set('chat_b', new Set(['alice', 'bob']))
  if (continueWork) feishu.members.set('chat_a', new Set(['alice']))
  const userTokens = new UserTokenStore(registry.db, feishu)
  const memory = new ChannelMemory(registry.db)
  const routines = new RoutineStore(registry.db)
  const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: '正常同域答案' }] })
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  // Retained-history cases explicitly amend their original Work. Merely sharing
  // a conversation is not evidence that an independently created Work saw it.
  const ingressClassifier: ConstructorParameters<typeof Orchestrator>[0]['ingressClassifier'] = continueWork ? {
    classify: async input => {
      const target = input.candidates.find(candidate => candidate.ref === input.message.replyToRef)
      return target ? { kind: 'amend', targetRef: target.ref } : { kind: 'work_request' }
    },
  } : undefined
  const deps = { cfg, registry, ...sp, memory, routines, userTokens, feishu: asFeishuClient(feishu), runtime, tokens: new TokenIssuer('test'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log, ingressClassifier }
  orchestrator = new Orchestrator(deps)
  const sessionKey = () => registry.getSessionByAcpId(state.allPrompts.at(-1)!.sessionId)!.sessionKey
  const source = (chatId = 'chat_b') => orchestrator.noteCrossSpaceRead(sessionKey(), { chatId, name: `合成群 ${chatId}`, what: 'history' })
  return { registry, ...sp, a, b, feishu, userTokens, memory, state, runtime, deps, orchestrator, sessionKey, source }
}

describe('final answer delivery integration', () => {
  function postAdapter(t: ReturnType<typeof setup>) {
    const reply = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'om_native', thread_id: 'thread-a' } })
    const create = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'om_native_dm' } })
    const client = Object.assign(Object.create(FeishuClient.prototype) as FeishuClient, {
      client: { im: { v1: { message: { reply, create } } } },
      getMessage: vi.fn().mockRejectedValue(new Error('ledger sender must not look up the message again')),
      chatMemberOpenIds: vi.fn().mockRejectedValue(new Error('ledger sender must not await members again')),
    })
    t.feishu.replyMarkdown = (...args: Parameters<FeishuClient['replyMarkdown']>) => client.replyMarkdown(...args)
    t.feishu.sendToChat = (...args: Parameters<FeishuClient['sendToChat']>) => client.sendToChat(...args)
    return { reply, create, client }
  }

  it('delivers native proposer/owner mentions through the ledger using one fresh destination membership lookup', async () => {
    const t = setup()
    const wire = postAdapter(t)
    t.feishu.chatMemberOpenIds = vi.fn().mockResolvedValue(new Set(['alice', 'ou_proposer', 'ou_owner']))
    t.state.script = [{ kind: 'text', text: '<at open_id="ou_proposer">提出人</at> 已记到 [Issue](https://example.invalid/9)：建议。请 <at open_id="ou_owner">负责人</at> 评估。' }]
    await t.orchestrator.handleMessage(msg())
    expect(t.feishu.chatMemberOpenIds).toHaveBeenCalledExactlyOnceWith('chat_a', { fresh: true })
    expect(wire.client.getMessage).not.toHaveBeenCalled()
    expect(wire.client.chatMemberOpenIds).not.toHaveBeenCalled()
    expect(wire.reply).toHaveBeenCalledTimes(1)
    const request = wire.reply.mock.calls[0]![0]
    expect(request.path.message_id).toBe('message-a')
    const nodes = JSON.parse(request.data.content).zh_cn.content.flat()
    expect(nodes.filter((n: { tag: string }) => n.tag === 'at')).toEqual([{ tag: 'at', user_id: 'ou_proposer' }, { tag: 'at', user_id: 'ou_owner' }])
    expect(t.registry.db.prepare('SELECT status FROM deliveries').all()).toEqual([{ status: 'sent' }])
  })

  it.each(['archive', 'rebind', 'remove-actor', 'stop'] as const)('does not publish when %s happens while awaiting mention membership', async (change) => {
    const t = setup()
    const wire = postAdapter(t)
    t.state.script = [{ kind: 'text', text: `<at open_id="ou_owner">负责人</at> ${SENTINEL}` }]
    t.feishu.chatMemberOpenIds = vi.fn().mockImplementation(async () => {
      await Promise.resolve()
      if (change === 'archive') t.spaces.archive(t.a.id)
      else if (change === 'rebind') t.spaces.rebind(t.a.id, 'chat_rebound')
      else if (change === 'remove-actor') t.spaces.removeMember(t.a.id, 'alice')
      else await t.orchestrator.handleMessage(msg({ messageId: 'om_stop', rootId: 'message-a', text: '@Friday /stop' }))
      return new Set(['alice', 'ou_owner'])
    })
    await t.orchestrator.handleMessage(msg())
    expect(t.feishu.chatMemberOpenIds).toHaveBeenCalledTimes(1)
    expect(wire.reply).not.toHaveBeenCalled()
    expect(wire.create).not.toHaveBeenCalled()
    expect(JSON.stringify(t.feishu.sent)).not.toContain(SENTINEL)
  })

  it('does not create a native mention for a target removed from the actual group', async () => {
    const t = setup()
    const wire = postAdapter(t)
    t.feishu.chatMemberOpenIds = vi.fn().mockResolvedValue(new Set(['alice']))
    t.state.script = [{ kind: 'text', text: '<at open_id="ou_owner">负责人</at> 请评估。' }]
    await t.orchestrator.handleMessage(msg())
    const encoded = wire.reply.mock.calls[0]![0].data.content
    expect(encoded).not.toContain('"tag":"at"')
    expect(encoded).toContain('负责人（未通知）')
  })

  it('uses only the current DM owner and adds no membership lookup to a normal answer', async () => {
    const t = setup()
    const wire = postAdapter(t)
    t.feishu.chatMemberOpenIds = vi.fn()
    await t.orchestrator.handleMessage(msg())
    expect(t.feishu.chatMemberOpenIds).not.toHaveBeenCalled()
    t.state.script = [{ kind: 'text', text: '<at open_id="ou_dm">本人</at> <at open_id="ou_other">其他人</at> 请看。' }]
    await t.orchestrator.handleMessage(msg({ messageId: 'dm-mention', chatId: 'chat_dm', chatType: 'p2p', senderOpenId: 'ou_dm', mentions: [] }))
    const nodes = JSON.parse(wire.create.mock.calls[0]![0].data.content).zh_cn.content.flat()
    expect(nodes.filter((n: { tag: string }) => n.tag === 'at')).toEqual([{ tag: 'at', user_id: 'ou_dm' }])
    expect(t.feishu.chatMemberOpenIds).not.toHaveBeenCalled()
  })

  it('allows a same-repository fix but rejects cross-repository publication and untracked derived writes', async () => {
    const t = setup()
    const decisions: boolean[] = []
    t.state.script = [{ kind: 'hook', run: () => {
      const key = t.sessionKey()
      decisions.push(t.orchestrator.canPublishToRepository(key, 'team/a'))
      t.orchestrator.noteRepositoryRead(key, 'Team/A')
      t.orchestrator.noteRepositoryRead(key, 'team/a')
      decisions.push(t.orchestrator.canPublishToRepository(key, 'team/a'))
      decisions.push(t.orchestrator.canPublishToRepository(key, 'team/b'))
      decisions.push(t.orchestrator.canPublishToRepository(key, '../team/a'))
      decisions.push(t.orchestrator.canPersistDerivedState(key))
      t.orchestrator.noteRepositoryRead(key, 'team/b')
      decisions.push(t.orchestrator.canPublishToRepository(key, 'team/a'))
    } }, { kind: 'text', text: '合成代码说明' }]
    await t.orchestrator.handleMessage(msg())
    expect(decisions).toEqual([true, true, false, false, false, false])
    expect(JSON.parse(t.registry.getKv(`delivery-sources:${t.sessionKey()}`)!).repositories).toEqual(['team/a', 'team/b'])
    expect(t.memory.count(`space:${t.a.id}`)).toBe(0)
    expect(t.orchestrator.canPublishToRepository(t.sessionKey(), 'team/a')).toBe(false)
  })

  it('retains repository sources across a resumed ACP and still requires the common source boundary for same-repository writes', async () => {
    const t = setup(true)
    t.state.script = [{ kind: 'hook', run: () => t.orchestrator.noteRepositoryRead(t.sessionKey(), 'team/private-a') }, { kind: 'text', text: '合成代码说明' }]
    await t.orchestrator.handleMessage(msg())
    await t.runtime.stop()
    const restarted = new Orchestrator(t.deps)
    const decisions: boolean[] = []
    t.state.script = [{ kind: 'hook', run: () => {
      const key = t.sessionKey()
      decisions.push(restarted.canPublishToRepository(key, 'team/private-a'))
      decisions.push(restarted.canPublishToRepository(key, 'team/b'))
      restarted.noteCrossSpaceRead(key, { chatId: 'chat_b', name: '别群', what: 'history' })
      decisions.push(restarted.canPublishToRepository(key, 'team/private-a'))
    } }, { kind: 'text', text: SENTINEL }]
    await restarted.handleMessage(msg({ messageId: 'next', parentId: 'message-a', threadId: 'thread-a' }))
    expect(t.registry.taskWork.get(2)?.key).toBe(t.registry.taskWork.get(1)?.key)
    expect(t.state.resumed).toEqual(['fake-session-1'])
    expect(decisions).toEqual([true, false, false])
    expect(JSON.stringify(t.feishu.sent)).not.toContain(SENTINEL)
  })

  it('refuses a legacy manifest without repository history and starts a new ACP before trusting sources again', async () => {
    const t = setup()
    const decisions: boolean[] = []
    t.state.script = [{ kind: 'hook', run: () => {
      const key = t.sessionKey()
      const manifest = JSON.parse(t.registry.getKv(`delivery-sources:${key}`)!)
      delete manifest.repositories
      t.registry.setKv(`delivery-sources:${key}`, JSON.stringify(manifest))
      decisions.push(t.orchestrator.canPublishToRepository(key, 'team/a'))
      decisions.push(t.orchestrator.canPersistDerivedState(key))
    } }, { kind: 'text', text: SENTINEL }]
    await t.orchestrator.handleMessage(msg())
    expect(decisions).toEqual([false, false])
    expect(JSON.stringify(t.feishu.sent)).not.toContain(SENTINEL)
    t.state.script = [{ kind: 'text', text: '新会话答案' }]
    await t.orchestrator.handleMessage(msg({ messageId: 'next', threadId: 'thread-a' }))
    expect(t.registry.getSession(t.sessionKey())?.acpSessionId).toBe('fake-session-2')
    expect(t.state.sessions.has('fake-session-1')).toBe(false)
    expect(JSON.parse(t.registry.getKv(`delivery-sources:${t.sessionKey()}`)!).repositories).toEqual([])
  })

  it('identifies each live run instance, stays stable inside a run, and invalidates it while idle', async () => {
    const t = setup()
    const actors: unknown[] = []
    const repeats: unknown[] = []
    t.state.script = [{ kind: 'hook', run: () => {
      const actor = t.orchestrator.resolveActorForSession(t.sessionKey())!
      actors.push(actor)
      repeats.push(t.orchestrator.resolveActorForSession(t.sessionKey()))
    } }, { kind: 'text', text: '正常答案' }]
    await t.orchestrator.handleMessage(msg())
    expect(t.orchestrator.resolveActorForSession(t.sessionKey())).toBeUndefined()
    await t.orchestrator.handleMessage(msg({ messageId: 'next', threadId: 'thread-a' }))
    expect(actors).toEqual([1, 2].map((taskId) => ({ requesterOpenId: 'alice', runId: expect.any(String), taskId, stage: 'task', controlRevision: 0 })))
    expect(repeats).toEqual(actors)
    expect(new Set(actors.map((a) => (a as { runId: string }).runId)).size).toBe(2)
  })

  it('tracks fresh owned routines but does not grant derived writes to an ownerless routine', async () => {
    const t = setup()
    const routines = new RoutineStore(t.registry.db, 'UTC')
    const owned = routines.add({ kind: 'schedule', chatId: 'chat_a', chatType: 'group', ownerOpenId: 'alice', name: '检查', prompt: '检查', schedule: { type: 'daily', at: '09:00' } })
    t.state.script = [{ kind: 'hook', run: () => {
      expect(t.orchestrator.resolveActorForSession(t.sessionKey())?.stage).toBe('routine')
      expect(t.orchestrator.canPersistDerivedState(t.sessionKey())).toBe(true)
      t.source()
      expect(t.orchestrator.canPersistDerivedState(t.sessionKey())).toBe(false)
    } }, { kind: 'text', text: 'NOTHING' }]
    expect(await t.orchestrator.runRoutine(owned, { manualMessageId: 'om_owned_routine' })).toBe('skipped')
    const orphan = routines.add({ kind: 'schedule', chatId: 'chat_a', chatType: 'group', name: '无主检查', prompt: '检查', schedule: { type: 'daily', at: '09:00' } })
    t.state.script = [{ kind: 'hook', run: () => expect(t.orchestrator.canPersistDerivedState(t.sessionKey())).toBe(false) }, { kind: 'text', text: 'NOTHING' }]
    expect(await t.orchestrator.runRoutine(orphan, { manualMessageId: 'om_orphan_routine' })).toBe('skipped')
  })

  it('records a no-actor proactive manifest without lending an owner identity or allowing cross-source persistence', async () => {
    const t = setup()
    const cache = new MessageCache(t.registry.db)
    const messages = new MessageService(asFeishuClient(t.feishu), cache, log)
    const enabledAt = Date.now() - 1000
    const proactive = new Proactive(t.registry.db, { ...t.deps.cfg.proactive, minMessages: 1, now: () => enabledAt })
    const orchestrator = new Orchestrator({ ...t.deps, messages, proactive })
    proactive.enable('chat_a', 'alice')
    messages.remember('chat_a', { messageId: 'om_signal', chatId: 'chat_a', createTimeMs: Date.now(), senderOpenId: 'alice', senderType: 'user', senderName: 'Alice', msgType: 'text', text: '合成线索' })
    t.state.script = [{ kind: 'hook', run: () => {
      expect(orchestrator.resolveActorForSession(t.sessionKey())).toEqual({ requesterOpenId: undefined, runId: expect.any(String), stage: 'routine' })
      expect(orchestrator.canPersistDerivedState(t.sessionKey())).toBe(true)
      orchestrator.noteCrossSpaceRead(t.sessionKey(), { chatId: 'chat_b', name: '合成别群', what: 'history' })
      expect(orchestrator.canPersistDerivedState(t.sessionKey())).toBe(false)
    } }, { kind: 'text', text: 'NOTHING' }]
    expect(await orchestrator.runProactiveCheck('chat_a')).toBe('silent')
    expect(orchestrator.canPersistDerivedState(t.sessionKey())).toBe(false)
  })

  it.each(['archive', 'rebind'] as const)('rejects %s during a run without creating a replacement source space', async (action) => {
    const t = setup()
    let persisted: boolean | undefined
    t.state.script = [{ kind: 'hook', run: () => {
      if (action === 'archive') t.spaces.archive(t.a.id)
      else t.spaces.rebind(t.a.id, 'chat_rebound')
      persisted = t.orchestrator.canPersistDerivedState(t.sessionKey())
    } }, { kind: 'text', text: SENTINEL }]
    await t.orchestrator.handleMessage(msg())
    expect(t.spaces.byChat('chat_a')).toBeUndefined()
    expect(persisted).toBe(false)
    expect(t.spaces.listAll(true)).toHaveLength(2)
    expect(JSON.stringify(t.feishu.sent)).not.toContain(SENTINEL)
  })

  it('ignores a repeated inbound message before it can steer or ACK the in-flight task', async () => {
    const t = setup()
    t.state.script = [{ kind: 'sleep', ms: 80 }, { kind: 'text', text: '唯一回答' }]
    const first = t.orchestrator.handleMessage(msg())
    while (!t.state.allPrompts.length) await new Promise((r) => setTimeout(r, 1))
    await t.orchestrator.handleMessage(msg({ eventId: 'redelivered-event' }))
    await first
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.state.cancelled).toHaveLength(0)
    expect(t.feishu.of('replyMarkdown')).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT id FROM tasks').all()).toHaveLength(1)
  })

  it('does not rerun or redeliver an inbound message after orchestrator restart', async () => {
    const t = setup()
    await t.orchestrator.handleMessage(msg())
    await t.runtime.stop()
    const restarted = new Orchestrator(t.deps)
    await restarted.handleMessage(msg({ eventId: 'after-restart-redelivery' }))
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.of('replyMarkdown')).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT delivery_key FROM deliveries').all()).toHaveLength(1)
  })

  it('permits derived writes only while the active run has known same-domain gateway sources', async () => {
    const t = setup()
    const decisions: boolean[] = []
    t.state.script = [{ kind: 'hook', run: () => {
      decisions.push(t.orchestrator.canPersistDerivedState(t.sessionKey()))
      t.source()
      decisions.push(t.orchestrator.canPersistDerivedState(t.sessionKey()))
    } }, { kind: 'text', text: SENTINEL }]
    await t.orchestrator.handleMessage(msg())
    expect(decisions).toEqual([true, false])
    expect(t.orchestrator.canPersistDerivedState(t.sessionKey())).toBe(false)
    expect(t.orchestrator.canPersistDerivedState('unknown-session')).toBe(false)
  })

  it('delivers ordinary group and personal DM answers through the durable ledger', async () => {
    const t = setup()
    await t.orchestrator.handleMessage(msg())
    await t.orchestrator.handleMessage(msg({ messageId: 'dm-1', chatId: 'chat_dm', chatType: 'p2p', mentions: [], text: '回答' }))
    const rows = t.registry.db.prepare('SELECT status, remote_id FROM deliveries').all()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'sent' && typeof r.remote_id === 'string')).toBe(true)
    expect(t.feishu.of('replyMarkdown')).toHaveLength(1)
    expect(t.feishu.of('sendToChat').some((s) => String(JSON.stringify(s.payload)).includes('正常同域答案'))).toBe(true)
  })

  it('blocks cross-group content before long-answer document creation and before memory write', async () => {
    const t = setup()
    t.state.script = [{ kind: 'hook', run: () => t.source() }, { kind: 'text', text: SENTINEL.repeat(4000) }]
    await t.orchestrator.handleMessage(msg())
    expect(JSON.stringify(t.feishu.sent)).not.toContain(SENTINEL)
    expect(t.feishu.createdDocs).toHaveLength(0)
    expect(t.memory.search([`space:${t.a.id}`], SENTINEL, 10)).toHaveLength(0)
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toMatch(/核验不了来源/)
    expect(t.registry.db.prepare('SELECT delivery_key FROM deliveries').all()).toEqual([{ delivery_key: 'task:1:notice' }])
  })

  it('persists every source beyond ten entries and rechecks it in a later turn after orchestrator/runtime restart', async () => {
    const t = setup(true)
    t.state.script = [{ kind: 'hook', run: () => { for (let n = 0; n < 12; n++) t.source(`private-${n}`) } }, { kind: 'text', text: SENTINEL }]
    await t.orchestrator.handleMessage(msg())
    const key = t.sessionKey()
    const manifest = JSON.parse(t.registry.getKv(`delivery-sources:${key}`)!)
    expect(manifest.chats).toHaveLength(12)
    await t.runtime.stop()
    const restarted = new Orchestrator(t.deps)
    t.state.script = [{ kind: 'text', text: `旧上下文中还有 ${SENTINEL}` }]
    await restarted.handleMessage(msg({ messageId: 'followup', parentId: 'message-a', threadId: 'thread-a' }))
    expect(t.registry.taskWork.get(2)?.key).toBe(t.registry.taskWork.get(1)?.key)
    expect(t.state.resumed).toEqual(['fake-session-1'])
    expect(JSON.stringify(t.feishu.sent)).not.toContain(SENTINEL)
    expect(t.feishu.of('replyText')).toHaveLength(2)
  })

  it('rebuilds a legacy ACP with no complete manifest once, then keeps the newly tracked session', async () => {
    const t = setup(true)
    await t.orchestrator.handleMessage(msg())
    const key = t.sessionKey()
    t.registry.setKv(`delivery-sources:${key}`, 'null')
    await t.orchestrator.handleMessage(msg({ messageId: 'followup-1', parentId: 'message-a', threadId: 'thread-a' }))
    expect(t.registry.getSession(key)?.acpSessionId).toBe('fake-session-2')
    expect(t.state.sessions.has('fake-session-1')).toBe(false)
    await t.orchestrator.handleMessage(msg({ messageId: 'followup-2', parentId: 'followup-1', threadId: 'thread-a' }))
    expect(t.registry.getSession(key)?.acpSessionId).toBe('fake-session-2')
    expect(t.state.counter).toBe(2)
    expect(new Set([1, 2, 3].map(id => t.registry.taskWork.get(id)?.key)).size).toBe(1)
  })

  it('preserves personal group-reading replies, then blocks a later answer after platform membership is revoked', async () => {
    const t = setup(true)
    const memberChecks: unknown[] = []
    const members = t.feishu.chatMemberOpenIds.bind(t.feishu)
    t.feishu.chatMemberOpenIds = async (chatId, opts?: { fresh?: boolean }) => { memberChecks.push(opts); return members(chatId) }
    const dm = msg({ messageId: 'dm-1', chatId: 'chat_dm', chatType: 'p2p', mentions: [], text: '只发给我' })
    t.state.script = [{ kind: 'hook', run: () => t.source() }, { kind: 'text', text: SENTINEL }]
    await t.orchestrator.handleMessage(dm)
    expect(JSON.stringify(t.feishu.of('sendToChat'))).toContain(SENTINEL)
    expect(t.memory.count('space:sp_dm_alice')).toBe(0)
    const before = t.feishu.sent.length
    t.feishu.members.set('chat_b', new Set(['bob']))
    t.state.script = [{ kind: 'text', text: `旧材料 ${SENTINEL}` }]
    await t.orchestrator.handleMessage({ ...dm, messageId: 'dm-2', parentId: dm.messageId })
    expect(t.registry.taskWork.get(2)?.key).toBe(t.registry.taskWork.get(1)?.key)
    expect(t.state.resumed).toEqual(['fake-session-1'])
    expect(JSON.stringify(t.feishu.sent.slice(before))).not.toContain(SENTINEL)
    expect(t.feishu.calls.chatMemberOpenIds).toBeGreaterThanOrEqual(3)
    expect(memberChecks).toEqual(memberChecks.map(() => ({ fresh: true })))
  })

  it('refreshes the personal OAuth chat list before publishing retained group content', async () => {
    const t = setup(true)
    const tokenState = t.userTokens.begin('alice')
    await t.userTokens.complete({ code: 'synthetic', state: tokenState, redirectUri: 'local-test', openId: 'alice' })
    t.feishu.userChats.set('uat-1', [{ chatId: 'chat_b', name: '合成群' }])
    const listChecks: unknown[] = []
    const chats = t.feishu.listChatsResult.bind(t.feishu)
    t.feishu.listChatsResult = async (as, opts?: { fresh?: boolean; assertCurrent?: () => void }) => { listChecks.push(opts); return chats(as) }
    t.state.script = [{ kind: 'hook', run: () => t.source() }, { kind: 'text', text: SENTINEL }]
    const dm = msg({ chatId: 'chat_dm', chatType: 'p2p', mentions: [] })
    await t.orchestrator.handleMessage(dm)
    expect(JSON.stringify(t.feishu.of('sendToChat'))).toContain(SENTINEL)
    const before = t.feishu.sent.length
    t.feishu.userChats.set('uat-1', [])
    t.state.script = [{ kind: 'text', text: SENTINEL }]
    await t.orchestrator.handleMessage({ ...dm, messageId: 'dm-next', parentId: dm.messageId })
    expect(t.registry.taskWork.get(2)?.key).toBe(t.registry.taskWork.get(1)?.key)
    expect(t.state.resumed).toEqual(['fake-session-1'])
    expect(JSON.stringify(t.feishu.sent.slice(before))).not.toContain(SENTINEL)
    expect(listChecks.length).toBeGreaterThanOrEqual(3)
    for (const check of listChecks) expect(check).toMatchObject({ fresh: true })
    expect(listChecks).toContainEqual(expect.objectContaining({ assertCurrent: expect.any(Function) }))
  })

  it('does not blindly send another body after the remote accepted a message but its ACK was lost', async () => {
    const t = setup()
    const original = t.feishu.replyMarkdown.bind(t.feishu)
    let sends = 0
    t.feishu.replyMarkdown = async (...args) => {
      sends++
      await original(...args)
      throw new Error('synthetic ACK lost')
    }
    await t.orchestrator.handleMessage(msg())
    expect(sends).toBe(1)
    expect(t.feishu.of('replyText')).toHaveLength(0)
    expect(t.registry.db.prepare('SELECT status FROM deliveries').all()).toEqual([{ status: 'unknown' }])
  })

  it('blocks third-party application-readable documents from group replies and subsequent turns', async () => {
    const t = setup(true)
    t.state.script = [{ kind: 'hook', run: () => t.orchestrator.noteExternalSource(t.sessionKey(), { kind: 'document', ref: 'doc-private' }) }, { kind: 'text', text: SENTINEL }]
    await t.orchestrator.handleMessage(msg())
    t.state.script = [{ kind: 'text', text: SENTINEL }]
    await t.orchestrator.handleMessage(msg({ messageId: 'later', parentId: 'message-a', threadId: 'thread-a' }))
    expect(t.registry.taskWork.get(2)?.key).toBe(t.registry.taskWork.get(1)?.key)
    expect(t.state.resumed).toEqual(['fake-session-1'])
    expect(JSON.stringify(t.feishu.sent)).not.toContain(SENTINEL)
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toMatch(/只允许回到原会话或原接收人/)
  })

  it('returns personally authorized document/calendar content only to that DM owner, and rejects after disconnect', async () => {
    const t = setup(true)
    const tokenState = t.userTokens.begin('alice')
    await t.userTokens.complete({ code: 'synthetic', state: tokenState, redirectUri: 'local-test', openId: 'alice' })
    t.state.script = [{ kind: 'hook', run: () => t.orchestrator.noteExternalSource(t.sessionKey(), { kind: 'calendar', ref: 'personal-events', personalOpenId: 'alice' }) }, { kind: 'text', text: SENTINEL }]
    const dm = msg({ chatId: 'chat_dm', chatType: 'p2p', mentions: [] })
    await t.orchestrator.handleMessage(dm)
    expect(JSON.stringify(t.feishu.of('sendToChat'))).toContain(SENTINEL)
    const before = t.feishu.sent.length
    t.userTokens.disconnect('alice')
    t.state.script = [{ kind: 'text', text: SENTINEL }]
    await t.orchestrator.handleMessage({ ...dm, messageId: 'dm-next', parentId: dm.messageId })
    expect(t.registry.taskWork.get(2)?.key).toBe(t.registry.taskWork.get(1)?.key)
    expect(t.state.resumed).toEqual(['fake-session-1'])
    expect(JSON.stringify(t.feishu.sent.slice(before))).not.toContain(SENTINEL)
  })
})
