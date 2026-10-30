import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ChannelMemory, type MemoryNote } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RuntimeContexts } from '../src/core/runtime-contexts.js'
import { SourceContexts } from '../src/core/source-context.js'
import { Todos } from '../src/core/todos.js'
import { OAuthTokenError, UserTokenStore } from '../src/feishu/oauth.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { deferred } from './helpers/model-agent.js'
import { spaceDeps } from './helpers/space.js'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

/** Real Orchestrator/ACP SDK, signed HTTP, SQLite, user token store, source receipts and memory runtime.
 * Only the model and platform are synthetic; no private host method is replaced. */
async function fixture(mode: 'managed' | 'workspace' = 'managed') {
  const home = mkdtempSync(join(tmpdir(), 'friday-personal-memory-host-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'app-synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000',
    ...(mode === 'managed' ? { FRIDAY_DEFAULT_EXECUTION: 'managed' } : {}) })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), attempts = new RunAttempts(registry.db)
  const contexts = new RuntimeContexts(registry.db), sourceContexts = new SourceContexts(registry)
  const sp = spaceDeps(registry.db), dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_owner' })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_other' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), cache = new MessageCache(registry.db)
  let tokenNow = Date.now()
  const provider = {
    exchangeCode: vi.fn(async () => ({ accessToken: 'SYNTHETIC_USER_TOKEN', refreshToken: 'SYNTHETIC_REFRESH', expiresIn: 7200,
      scope: 'im:chat:readonly im:message:readonly im:message.group_msg:get_as_user' })),
    refresh: vi.fn(async () => { throw new Error('synthetic refresh temporarily unavailable') }),
  }
  const userTokens = new UserTokenStore(registry.db, provider, () => tokenNow)
  await userTokens.complete({ openId: 'ou_owner', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  const listChatsResult = vi.fn(async () => ({ items: [{ chatId: 'oc_group', name: '合成群' }], complete: true }))
  feishu.listChatsResult = listChatsResult
  feishu.whoAmI = vi.fn(async () => ({ openId: 'ou_owner', tenantKey: 'tenant-authority' }))
  fake.userChats.set('SYNTHETIC_USER_TOKEN', [{ chatId: 'oc_group', name: '合成群' }])
  const log = createLogger('personal-memory-host', 'error')
  const execution = managedHostRuntime(registry, home, log), { runtime, managed, bindings, workspacePeer } = execution
  const peer = mode === 'managed' ? execution.peer : workspacePeer
  const messages = new MessageService(feishu, cache, log), todos = new Todos(registry.db), tokens = new TokenIssuer('synthetic-signing')
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, feishu, userTokens, runtime, managed, messages, tokens,
    ingressClassifier: { classify: async input => input.message.replyToRef
      ? { kind: 'amend', targetRef: input.message.replyToRef } : { kind: 'new_work' } },
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  closes.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const api = createInternalApi({ registry, ...sp, memory, messageCache: cache, messages, todos, feishu, userTokens,
    appId: cfg.feishu.appId, tokens, log, maxHistoryPerCall: 20,
    isManagedRun: runId => host.isManagedRun(runId),
    registerExecutionFile: (runId, file, guard) => host.registerExecutionFile(runId, file, guard),
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPersistDerivedState: (key, purpose) => host.canPersistDerivedState(key, purpose), canPersistPersonalMemory: key => host.canPersistPersonalMemory(key),
    onCrossSpaceRead: (key, read) => host.noteCrossSpaceRead(key, read),
    onMessageRead: (key, runId, receipt) => host.noteMessageRead(key, runId, receipt),
    memoryRuntime: { recordRead: (runId, refs) => host.recordMemoryRead(runId, refs),
      search: (runId, scopes, query, limit) => host.searchMemory(runId, scopes, query, limit),
      add: (runId, input) => host.addMemory(runId, input), forget: (runId, id, scope) => host.forgetMemory(runId, id, scope) },
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  closes.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())) })
  const post = async (path: string, body: unknown) => {
    const servers = peer.state.allPrompts.at(-1)!.mcpServers as { env: { name: string; value: string }[] }[]
    const token = servers[0]!.env.find(entry => entry.name === 'FRIDAY_CAP_TOKEN')!.value
    const response = await fetch(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as { note?: MemoryNote; notes?: MemoryNote[]; items?: unknown[]; error?: string } }
  }
  let serial = 0
  const message = (text: string, parentId?: string): InboundMessage => {
    const messageId = `personal-memory-${++serial}`
    return { eventId: messageId, messageId, chatId: 'oc_dm', chatType: 'p2p', senderOpenId: 'ou_owner',
      senderType: 'user', tenantId: 'tenant-authority', msgType: 'text', text, mentions: [], createTimeMs: Date.now(),
      ...(parentId ? { parentId } : {}) }
  }
  return { registry, memory, attempts, contexts, sourceContexts, ...sp, dm, group, fake, peer, runtime,
    host, bindings, managed, workspacePeer, userTokens, provider, listChatsResult, post, message, tokenTime: (value: number) => { tokenNow = value } }
}

async function saveGroupCandidate(t: Awaited<ReturnType<typeof fixture>>) {
  const start = Math.floor((Date.now() - 60_000) / 1000) * 1000
  t.fake.userHistories.set('oc_group', [historyMsg({ messageId: 'om_source', chatId: 'oc_group',
    text: 'GROUP_MEMORY_BODY_CANARY', tenantId: 'tenant-sender', createTimeMs: start + 1000 })])
  const first = t.message('读取群资料并记住 GroupConstraint'), responses: Awaited<ReturnType<typeof t.post>>[] = []
  let savedId = 0, originalRunId = ''
  t.peer.state.script = [{ kind: 'hook', run: async () => {
    const task = t.registry.taskForMessage(first.messageId)!
    originalRunId = t.host.resolveActorForSession(task.sessionKey)!.runId
    responses.push(await t.post('chat/history', { chat: 'oc_group', start_time: new Date(start).toISOString(), end_time: new Date(start + 5000).toISOString() }))
    const saved = await t.post('memory/save', { kind: 'fact', title: 'GroupConstraint', body: 'GROUP_MEMORY_BODY_CANARY',
      provenance: { state: 'legacy_unverified', sources: [] } })
    responses.push(saved); savedId = saved.body.note?.id ?? 0
  } }, { kind: 'text', text: '已保存本人的群资料候选。' }]
  await t.host.handleMessage(first)
  expect(responses.map(result => result.status)).toEqual([200, 200])
  return { first, responses, savedId, originalRunId }
}

describe('personal group memory across real host Runs', () => {
  it('captures actual group reads, saves and reads in a later Run, then rebuilds the same business session after access is removed', async () => {
    const t = await fixture(), { first, responses, savedId, originalRunId } = await saveGroupCandidate(t)
    const firstTask = t.registry.taskForMessage(first.messageId)!, session = t.registry.getSession(firstTask.sessionKey)!
    expect(firstTask.status).toBe('done')
    expect(t.bindings.get(session.acpSessionId!)).toBe('managed')
    expect(t.peer.state.sessions.get(session.acpSessionId!)!.cwd).not.toBe(session.cwd)
    expect(t.workspacePeer.state.allPrompts).toEqual([])
    expect(t.memory.metadata(savedId, `space:${t.dm.id}`)).toMatchObject({ status: 'candidate', scope: `space:${t.dm.id}` })
    expect(t.memory.get(savedId)).toBeUndefined() // Legacy callers cannot reveal managed rows.
    expect(t.memory.getProvenance(savedId)).toMatchObject({ state: 'verified', originRunId: originalRunId,
      sources: [{ messageId: 'om_source', spaceId: t.group.id, tenantId: 'tenant-authority', readIdentity: { kind: 'user', openId: 'ou_owner' } }] })
    expect(t.memory.search(`space:${t.dm.id}`, 'GroupConstraint')).toEqual([]) // No unguarded legacy read.
    expect(t.sourceContexts.get(session.sessionKey)?.personalMemoryComplete).toBe(true)

    const second = t.message('GroupConstraint', first.messageId)
    t.peer.state.script = [{ kind: 'hook', run: async () => { responses.push(await t.post('memory/search', { query: 'GroupConstraint' })) } },
      { kind: 'text', text: '仍是待确认的群资料。' }]
    await t.host.handleMessage(second)
    const secondTask = t.registry.taskForMessage(second.messageId)!
    expect(secondTask.status).toBe('done')
    expect(secondTask.sessionKey).toBe(firstTask.sessionKey)
    expect(t.registry.taskWork.get(secondTask.id)).toEqual(t.registry.taskWork.get(firstTask.id))
    expect(responses.at(-1)).toMatchObject({ status: 200, body: { notes: [{ id: savedId }] } })
    expect(t.peer.state.allPrompts).toHaveLength(2)
    expect(t.peer.state.allPrompts[1]!.sessionId).toBe(t.peer.state.allPrompts[0]!.sessionId)
    expect(t.peer.state.allPrompts[1]!.text).toContain('GROUP_MEMORY_BODY_CANARY')

    t.listChatsResult.mockResolvedValue({ items: [], complete: true })
    t.fake.userChats.set('SYNTHETIC_USER_TOKEN', [])
    const third = t.message('继续处理当前工作', second.messageId)
    t.peer.state.script = [{ kind: 'text', text: '按本轮仍可用的材料继续。' }]
    await t.host.handleMessage(third)
    const thirdTask = t.registry.taskForMessage(third.messageId)!
    expect(thirdTask.status).toBe('done')
    expect(thirdTask.sessionKey).toBe(firstTask.sessionKey)
    expect(t.registry.taskWork.get(thirdTask.id)).toEqual(t.registry.taskWork.get(firstTask.id))
    expect(t.registry.getSession(thirdTask.sessionKey)!.cwd).toBe(session.cwd)
    expect(t.peer.state.allPrompts).toHaveLength(3)
    expect(t.peer.state.allPrompts[2]!.sessionId).not.toBe(t.peer.state.allPrompts[1]!.sessionId)
    expect(t.peer.state.allPrompts[2]!.text).not.toContain('GROUP_MEMORY_BODY_CANARY')
    expect(t.memory.getProvenance(savedId)?.state).toBe('unavailable')
    expect(t.contexts.get(t.peer.state.allPrompts[0]!.sessionId)?.state).toBe('invalidated')
    expect(t.attempts.get(originalRunId)?.state).toBe('completed')
  })

  it('keeps default workspace Runs outside managed memory reads and derived group-memory saves', async () => {
    const t = await fixture('workspace')
    const note = t.memory.add({ scope: `space:${t.dm.id}`, kind: 'fact', title: 'WORKSPACE_MEMORY_QUERY', body: 'MANAGED_ONLY_BODY',
      provenance: { state: 'verified', originRunId: 'synthetic-original-run', sources: [{ ref: 'message:oc_group:source',
        appId: 'app-synthetic', tenantId: 'tenant-authority', spaceId: t.group.id, chatId: 'oc_group', messageId: 'source',
        readAt: 1, coverage: 'complete', readIdentity: { kind: 'user', openId: 'ou_owner' } }] } })
    const start = Math.floor((Date.now() - 60_000) / 1000) * 1000
    t.fake.userHistories.set('oc_group', [historyMsg({ messageId: 'workspace-source', chatId: 'oc_group',
      text: 'WORKSPACE_GROUP_BODY', createTimeMs: start + 1000 })])
    const message = t.message('WORKSPACE_MEMORY_QUERY'), results: Awaited<ReturnType<typeof t.post>>[] = []
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      results.push(await t.post('memory/search', { query: 'WORKSPACE_MEMORY_QUERY' }))
      results.push(await t.post('chat/history', { chat: 'oc_group', start_time: new Date(start).toISOString(), end_time: new Date(start + 5000).toISOString() }))
      results.push(await t.post('memory/save', { kind: 'fact', title: 'WORKSPACE_SAVE_ATTEMPT', body: 'WORKSPACE_GROUP_BODY' }))
    } }, { kind: 'text', text: '本轮读取了群资料，未保存为个人记忆。' }]
    await t.host.handleMessage(message)
    expect(results.map(result => result.status)).toEqual([200, 200, 403])
    expect(results[0]?.body.notes).toEqual([])
    const task = t.registry.taskForMessage(message.messageId)!, session = t.registry.getSession(task.sessionKey)!
    expect(t.bindings.get(session.acpSessionId!)).toBe('workspace')
    expect(t.peer.state.sessions.get(session.acpSessionId!)!.cwd).toBe(session.cwd)
    expect(t.peer.state.allPrompts[0]!.text).not.toContain('MANAGED_ONLY_BODY')
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM memory_notes').get()?.n).toBe(1)
    expect(t.memory.getProvenance(note.id)?.state).toBe('verified')
    expect(task.status).toBe('done')
  })

  it('disconnects an admitted reader during final audience verification without delivering late text or re-sending', async () => {
    const t = await fixture(), { first, savedId } = await saveGroupCandidate(t)
    const second = t.message('GroupConstraint', first.messageId), entered = deferred(), release = deferred()
    const alreadySent = t.fake.sent.length
    const listing = t.listChatsResult
    t.peer.state.script = [{ kind: 'hook', run: () => {
      // Admission has completed; hold the real final-delivery verification adapter.
      listing.mockClear().mockImplementationOnce(async () => {
        entered.resolve(); await release.promise
        return { items: [{ chatId: 'oc_group', name: '合成群' }], complete: true }
      })
    } }, { kind: 'text', text: 'LATE_PRIVATE_MEMORY_OUTPUT' }]
    const pending = t.host.handleMessage(second)
    await entered.promise
    try {
      const task = t.registry.taskForMessage(second.messageId)!, actor = t.host.resolveActorForSession(task.sessionKey)!
      expect(actor).toBeDefined()
      expect(t.contexts.contextForRun(actor.runId)?.notes).toContainEqual({ id: savedId, revision: 1 })
      expect(t.host.disconnectPersonalConnection('ou_owner', t.userTokens.get('ou_owner'))).toBe(true)
      expect(t.host.resolveActorForSession(task.sessionKey)).toBeUndefined()
      expect((await t.post('memory/search', { query: 'GroupConstraint' })).status).toBe(403)
      release.resolve(); await pending
      expect(t.registry.getTask(task.id)).toMatchObject({ status: 'cancelled', stopReason: 'memory_context_invalidated' })
      expect(t.attempts.get(actor.runId)).toMatchObject({ state: 'cancelled', stopReason: 'memory_context_invalidated' })
      expect(t.memory.getProvenance(savedId)?.state).toBe('unavailable')
      expect(t.fake.sent).toHaveLength(alreadySent)
      expect(JSON.stringify(t.fake.sent)).not.toContain('LATE_PRIVATE_MEMORY_OUTPUT')
      expect(t.memory.recent(`space:${t.dm.id}`, 20).filter(note => note.kind === 'qa')).toEqual([])
      await t.host.handleMessage(second)
      expect(t.peer.state.allPrompts).toHaveLength(2)
      expect(t.fake.sent).toHaveLength(alreadySent)
      expect(listing).toHaveBeenCalledTimes(1)
    } finally { release.resolve(); await pending }
  })

  it.each(['unavailable', 'invalid_grant'] as const)('does not fall back to app membership when final delivery alone observes %s', async result => {
    const t = await fixture(), { first, savedId } = await saveGroupCandidate(t)
    t.fake.members.set('oc_group', new Set(['ou_owner'])) // The app path would pass, but it is not this read identity.
    if (result === 'invalid_grant') t.provider.refresh.mockRejectedValue(new OAuthTokenError('invalid_grant'))
    const members = vi.spyOn(t.fake, 'chatMemberOpenIds')
    const second = t.message('GroupConstraint', first.messageId)
    t.peer.state.script = [{ kind: 'hook', run: () => { t.tokenTime(t.userTokens.get('ou_owner')!.expiresAt - 60_000) } },
      { kind: 'text', text: 'MUST_NOT_SEND_AFTER_TEMPORARY_REFRESH_FAILURE' }]
    await t.host.handleMessage(second)
    expect.soft(t.provider.refresh).toHaveBeenCalledTimes(1)
    expect.soft(members).not.toHaveBeenCalled()
    expect.soft(JSON.stringify(t.fake.sent)).not.toContain('MUST_NOT_SEND_AFTER_TEMPORARY_REFRESH_FAILURE')
    expect(t.memory.getProvenance(savedId)?.state).toBe(result === 'unavailable' ? 'verified' : 'unavailable')
    if (result === 'unavailable') expect(t.userTokens.get('ou_owner')).toBeDefined()
    else {
      expect(t.userTokens.get('ou_owner')).toBeUndefined()
      expect(t.registry.taskForMessage(second.messageId)).toMatchObject({ status: 'cancelled', stopReason: 'memory_context_invalidated' })
    }
  })

  it('keeps the original personal delivery lease when a grant is replaced during fresh group lookup', async () => {
    const t = await fixture(), entered = deferred(), release = deferred()
    const start = Math.floor((Date.now() - 60_000) / 1000) * 1000
    t.fake.userHistories.set('oc_group', [historyMsg({ messageId: 'om_raw_source', chatId: 'oc_group', text: 'RAW_GROUP_MATERIAL', createTimeMs: start + 1000 })])
    const listing = t.listChatsResult
    const msg = t.message('读群后回复本次内容'), responses: number[] = []
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      responses.push((await t.post('chat/history', { chat: 'oc_group', start_time: new Date(start).toISOString(), end_time: new Date(start + 5000).toISOString() })).status)
      listing.mockClear().mockImplementationOnce(async () => {
        entered.resolve(); await release.promise
        return { items: [{ chatId: 'oc_group', name: '合成群' }], complete: true }
      })
    } }, { kind: 'text', text: 'MUST_NOT_SEND_UNDER_REPLACED_GRANT' }]
    const pending = t.host.handleMessage(msg)
    await entered.promise
    try {
      const task = t.registry.taskForMessage(msg.messageId)!, actor = t.host.resolveActorForSession(task.sessionKey)!
      expect(t.contexts.contextForRun(actor.runId)?.notes).toEqual([]) // No memory proof hides a delivery-lease defect.
      t.provider.exchangeCode.mockResolvedValue({ accessToken: 'SYNTHETIC_REPLACEMENT', refreshToken: 'SYNTHETIC_NEW_REFRESH', expiresIn: 7200,
        scope: 'im:chat:readonly im:message:readonly im:message.group_msg:get_as_user' })
      await t.userTokens.complete({ openId: 'ou_owner', code: 'replacement', redirectUri: 'https://callback.invalid' })
      release.resolve(); await pending
      expect(responses).toEqual([200])
      expect(JSON.stringify(t.fake.sent)).not.toContain('MUST_NOT_SEND_UNDER_REPLACED_GRANT')
      expect(listing).toHaveBeenCalledWith({ userToken: 'SYNTHETIC_USER_TOKEN' }, expect.objectContaining({ fresh: true, assertCurrent: expect.any(Function) }))
      expect(t.userTokens.get('ou_owner')?.accessToken).toBe('SYNTHETIC_REPLACEMENT')
    } finally { release.resolve(); await pending }
  })

  it('retains the authorized app-member delivery path when there was no personal connection or personal material', async () => {
    const t = await fixture(), start = Math.floor((Date.now() - 60_000) / 1000) * 1000
    t.host.disconnectPersonalConnection('ou_owner')
    t.fake.chats = [{ chatId: 'oc_group', name: '应用所在群' }]
    t.fake.members.set('oc_group', new Set(['ou_owner']))
    t.fake.histories.set('oc_group', [historyMsg({ messageId: 'om_app_source', chatId: 'oc_group', text: 'APP_GROUP_MATERIAL', createTimeMs: start + 1000 })])
    const history = vi.spyOn(t.fake, 'listChatHistory'), responses: number[] = []
    const msg = t.message('以已获准的应用群资料回复本人')
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      responses.push((await t.post('chat/history', { chat: 'oc_group', start_time: new Date(start).toISOString(), end_time: new Date(start + 5000).toISOString() })).status)
    } }, { kind: 'text', text: 'APP_MEMBER_PATH_ALLOWED' }]
    await t.host.handleMessage(msg)
    expect(responses).toEqual([200])
    expect(history.mock.calls[0]![5]).toEqual({})
    expect(t.registry.taskForMessage(msg.messageId)?.status).toBe('done')
    expect(JSON.stringify(t.fake.sent)).toContain('APP_MEMBER_PATH_ALLOWED')
    expect(t.provider.refresh).not.toHaveBeenCalled()
  })
})
