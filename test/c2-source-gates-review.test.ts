import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { spaceDeps } from './helpers/space.js'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
async function waitFor(condition: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Real Orchestrator/ACP SDK, signed HTTP, SQLite, user token store, source receipts and memory runtime.
 * Only the model and platform are synthetic; no private host method is replaced. */
async function fixture(mode: 'managed' | 'workspace' = 'managed', runtimeOptions: { maxConcurrent?: number } = {}) {
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
    exchangeCode: async () => ({ accessToken: 'SYNTHETIC_USER_TOKEN', expiresIn: 600, refreshToken: 'SYNTHETIC_REFRESH', refreshTokenExpiresIn: 86400,
      scope: 'im:chat:readonly im:message:readonly im:message.group_msg:get_as_user' }),
    refresh: vi.fn(async () => { throw new OAuthTokenError('invalid_grant') }),
  }
  const userTokens = new UserTokenStore(registry.db, provider, () => tokenNow)
  await userTokens.complete({ openId: 'ou_owner', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  const listChatsResult = vi.fn(async () => ({ items: [{ chatId: 'oc_group', name: '合成群' }], complete: true }))
  feishu.listChatsResult = listChatsResult
  feishu.whoAmI = vi.fn(async () => ({ openId: 'ou_owner', tenantKey: 'tenant-authority' }))
  fake.userChats.set('SYNTHETIC_USER_TOKEN', [{ chatId: 'oc_group', name: '合成群' }])
  const log = createLogger('personal-memory-host', 'error')
  const execution = managedHostRuntime(registry, home, log, runtimeOptions), { runtime, managed, bindings, workspacePeer } = execution
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
    disconnectPersonalConnection: (openId, expected) => host.disconnectPersonalConnection(openId, expected),
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPersistDerivedState: key => host.canPersistDerivedState(key), canPersistPersonalMemory: key => host.canPersistPersonalMemory(key),
    onCrossSpaceRead: (key, read) => host.noteCrossSpaceRead(key, read),
    onMessageRead: (key, runId, receipt) => host.noteMessageRead(key, runId, receipt),
    abilities: host.abilities,
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
  return { registry, memory, attempts, contexts, sourceContexts, cache, ...sp, dm, group, fake, peer, runtime,
    host, bindings, managed, workspacePeer, userTokens, listChatsResult, post, message, provider, feishu, advanceTokenClock: () => { tokenNow += 400_000 } }
}

describe('C2 source gates across real host and HTTP', () => {
  it.each([true, false])('does not unlock an old cached group body from a global search ID (group list complete=%s)', async complete => {
    const t = await fixture(), request = t.message('再找一下季报材料')
    const old = historyMsg({ messageId: 'om_old', chatId: 'oc_group', text: 'REVOKED_SEARCH_CANARY' })
    t.cache.upsert('oc_group', [old])
    t.fake.messages.set(old.messageId, old)
    t.fake.searchHits = [old.messageId]
    t.listChatsResult.mockResolvedValue({ items: [], complete })
    const get = vi.spyOn(t.feishu, 'getMessage')
    let result: Awaited<ReturnType<typeof t.post>> | undefined
    t.peer.state.script = [{ kind: 'hook', run: async () => { result = await t.post('messages/search', { query: '季报' }) } },
      { kind: 'text', text: '这次没有找到可读取的材料。' }]
    await t.host.handleMessage(request)
    expect(result).toMatchObject({ status: 200, body: { items: [], complete: false, failed_fetches: 1 } })
    expect(get).not.toHaveBeenCalled()
    expect(JSON.stringify(t.fake.sent)).not.toContain('REVOKED_SEARCH_CANARY')
    expect(t.cache.get(old.messageId)?.text).toBe('REVOKED_SEARCH_CANARY')
    const task = t.registry.taskForMessage(request.messageId)!
    expect(t.sourceContexts.get(task.sessionKey)?.chats).toEqual([])
    expect(t.userTokens.get('ou_owner')).toBeDefined()
  })

  it('requires a current user read for cached global hits and never falls back on a failed read', async () => {
    const t = await fixture(), request = t.message('找到旧材料')
    t.cache.upsert('oc_group', [historyMsg({ messageId: 'om_cached', chatId: 'oc_group', text: 'CACHED_PRIVATE_CANARY' })])
    t.fake.searchHits = ['om_cached']
    const get = vi.spyOn(t.feishu, 'getMessage').mockRejectedValue(new Error('current user cannot read this message'))
    let result: Awaited<ReturnType<typeof t.post>> | undefined
    t.peer.state.script = [{ kind: 'hook', run: async () => { result = await t.post('messages/search', { query: '材料' }) } },
      { kind: 'text', text: '这条消息目前没有读到。' }]
    await t.host.handleMessage(request)
    expect(get).toHaveBeenCalledWith('om_cached', { userToken: 'SYNTHETIC_USER_TOKEN' })
    expect(result).toMatchObject({ status: 200, body: { items: [], complete: false, failed_fetches: 1 } })
    expect(JSON.stringify(result)).not.toContain('CACHED_PRIVATE_CANARY')
  })

  it('refreshes a global hit with the actual readable version rather than returning the cached body', async () => {
    const t = await fixture(), request = t.message('查一下最新材料格式')
    t.cache.upsert('oc_group', [historyMsg({ messageId: 'om_current', chatId: 'oc_group', text: 'OLD_FORMAT_CANARY' })])
    t.fake.messages.set('om_current', historyMsg({ messageId: 'om_current', chatId: 'oc_group', text: 'NEW_FORMAT_CANARY' }))
    t.fake.searchHits = ['om_current']
    let result: Awaited<ReturnType<typeof t.post>> | undefined
    t.peer.state.script = [{ kind: 'hook', run: async () => { result = await t.post('messages/search', { query: '格式' }) } },
      { kind: 'text', text: '已读到最新消息。' }]
    await t.host.handleMessage(request)
    expect(result).toMatchObject({ status: 200, body: { items: [{ text: 'NEW_FORMAT_CANARY' }], fetched_from_api: 1 } })
    expect(JSON.stringify(result)).not.toContain('OLD_FORMAT_CANARY')
  })

  it('does not relabel an older cached card body as a freshly authorized search result', async () => {
    const t = await fixture(), request = t.message('找一下季报卡片')
    t.cache.upsert('oc_group', [historyMsg({ messageId: 'om_card', chatId: 'oc_group', msgType: 'interactive',
      text: 'OLD_CARD_BODY_CANARY', fileKey: 'old-card-file' })])
    const current = historyMsg({ messageId: 'om_card', chatId: 'oc_group', msgType: 'interactive',
      text: '[卡片]\n[卡片正文未取得：当前返回结构没有可提取正文；不能据此判断没有回复]' })
    t.fake.messages.set(current.messageId, current)
    t.fake.searchHits = [current.messageId]
    let result: Awaited<ReturnType<typeof t.post>> | undefined
    t.peer.state.script = [{ kind: 'hook', run: async () => { result = await t.post('messages/search', { query: '季报' }) } },
      { kind: 'text', text: '找到了卡片，但这次未读到正文。' }]
    await t.host.handleMessage(request)
    expect(result).toMatchObject({ status: 200, body: { items: [{ text: current.text }], fetched_from_api: 1 } })
    expect(JSON.stringify(result)).not.toContain('OLD_CARD_BODY_CANARY')
    expect(JSON.stringify(result)).not.toContain('old-card-file')
    // Retention is useful for cache-backed history; it cannot upgrade the current read.
    expect(t.cache.get(current.messageId)?.text).toBe('OLD_CARD_BODY_CANARY')
    const task = t.registry.taskForMessage(request.messageId)!
    expect(t.sourceContexts.get(task.sessionKey)?.messageSources).toHaveLength(1)
  })

  it('does not return or cache a global hit after its original user grant changes during getMessage', async () => {
    const t = await fixture(), request = t.message('找那份材料')
    t.fake.searchHits = ['om_late']
    vi.spyOn(t.feishu, 'getMessage').mockImplementation(async () => {
      t.userTokens.disconnect('ou_owner')
      return historyMsg({ messageId: 'om_late', chatId: 'oc_group', text: 'LATE_SEARCH_CANARY' })
    })
    let result: Awaited<ReturnType<typeof t.post>> | undefined
    t.peer.state.script = [{ kind: 'hook', run: async () => { result = await t.post('messages/search', { query: '材料' }) } },
      { kind: 'text', text: '这次没有读到材料。' }]
    await t.host.handleMessage(request)
    expect(result?.status).toBe(403)
    expect(t.cache.get('om_late')).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('LATE_SEARCH_CANARY')
  })

  it.each(['chats','ability'] as const)('keeps %s directory memory managed, blocks cross-repo publishing, and invalidates after group loss', async path => {
    const t = await fixture(), request = t.message('看看群目录并记住'), responses: Awaited<ReturnType<typeof t.post>>[] = []
    let canPublish = true
    t.peer.state.script = [{kind:'hook',run:async()=>{
      responses.push(await t.post(path,path==='ability'?{what:'groups'}:{}))
      canPublish = t.host.canPublishToRepository(t.registry.taskForMessage(request.messageId)!.sessionKey, 'team/repository')
      responses.push(await t.post('memory/save',{kind:'fact',title:'群目录',body:'PRIVATE_GROUP_DIRECTORY_CANARY'}))
    }},{kind:'text',text:'查询结束。'}]
    await t.host.handleMessage(request)
    expect(responses[0]?.status).toBe(200)
    expect(responses[1]?.status).toBe(200)
    const id=responses[1]!.body.note!.id
    expect(t.memory.search(`space:${t.dm.id}`,'PRIVATE_GROUP_DIRECTORY_CANARY')).toEqual([])
    expect(t.memory.getProvenance(id)).toMatchObject({state:'verified',sources:[{chatId:'oc_group',
      readIdentity:{kind:'user',openId:'ou_owner'}}]})
    expect(canPublish).toBe(false)
    t.listChatsResult.mockResolvedValue({items:[],complete:true})
    t.fake.userChats.set('SYNTHETIC_USER_TOKEN',[])
    t.peer.state.script=[{kind:'text',text:'按当前可用资料继续。'}]
    await t.host.handleMessage(t.message('继续',request.messageId))
    expect(t.memory.getProvenance(id)?.state).toBe('unavailable')
    expect(t.peer.state.allPrompts.at(-1)!.text).not.toContain('PRIVATE_GROUP_DIRECTORY_CANARY')
  })

  it('does not use a bot-membership fallback to publish managed memory after an observed invalid grant', async () => {
    const t = await fixture(), request=t.message('MANAGED_FACT'), responses: Awaited<ReturnType<typeof t.post>>[]=[]
    const note=t.memory.add({scope:`space:${t.dm.id}`,kind:'fact',title:'MANAGED_FACT',body:'MANAGED_SECRET_CANARY',
      provenance:{state:'verified',originRunId:'synthetic-origin',sources:[{ref:'message:oc_group:om_source',tenantId:'tenant-authority',
        appId:'app-synthetic',spaceId:t.group.id,chatId:'oc_group',messageId:'om_source',readAt:1,coverage:'complete',
        readIdentity:{kind:'user',openId:'ou_owner'}}]}})
    t.fake.members.set('oc_group',new Set(['ou_owner']))
    t.peer.state.script=[{kind:'hook',run:async()=>{
      expect(t.peer.state.allPrompts.at(-1)!.text).toContain('MANAGED_SECRET_CANARY')
      t.advanceTokenClock()
      responses.push(await t.post('chats',{}))
    }},{kind:'text',text:'MANAGED_SECRET_CANARY'}]
    await t.host.handleMessage(request)
    expect(responses[0]?.status).toBe(403)
    expect(t.provider.refresh).toHaveBeenCalled()
    const task=t.registry.taskForMessage(request.messageId)!
    expect.soft(task.status).not.toBe('done')
    expect.soft(JSON.stringify(t.fake.sent)).not.toContain('MANAGED_SECRET_CANARY')
    expect.soft(t.memory.getProvenance(note.id)?.state).toBe('unavailable')
  })

  it.each(['managed', 'workspace'] as const)('does not publish downloaded bytes after the original user lease is removed (%s)', async mode => {
    const t=await fixture(mode),request=t.message('读取合成附件'),responses:Awaited<ReturnType<typeof t.post>>[]=[]
    t.fake.messages.set('om_file',historyMsg({messageId:'om_file',chatId:'oc_group',msgType:'file',fileKey:'synthetic-file',fileName:'test.txt',text:'test.txt'}))
    let downloadedPath='',finalPath=''
    vi.spyOn(t.feishu,'downloadMessageResource').mockImplementation(async(_message,_key,_type,path)=>{
      downloadedPath=path
      t.userTokens.disconnect('ou_owner')
      writeFileSync(path,'LATE_UNAUTHORIZED_BYTES')
    })
    t.peer.state.script=[{kind:'hook',run:async()=>{
      const task=t.registry.taskForMessage(request.messageId)!,session=t.registry.getSession(task.sessionKey)!
      finalPath=join(session.cwd,'downloads','om_file-test.txt');mkdirSync(join(session.cwd,'downloads'),{recursive:true})
      writeFileSync(finalPath,'EXISTING_APPROVED_BYTES')
      responses.push(await t.post('message/file',{message_id:'om_file'}))
    }},{kind:'text',text:'未取得附件。'}]
    await t.host.handleMessage(request)
    expect(responses[0]?.status).toBe(403)
    expect.soft(readFileSync(finalPath,'utf8')).toBe('EXISTING_APPROVED_BYTES')
    if(downloadedPath!==finalPath)expect.soft(existsSync(downloadedPath)).toBe(false)
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM execution_material_files').get()?.n).toBe(0)
  })
})

describe('source guard between preflight and dispatch on the real host', () => {
  /** The old ACP read a group body through the user's grant but stored no memory note, so RuntimeContexts has no
   * note refs to invalidate; only the source guard can stop that history from being prompted again. */
  it.each(['resume', 'gate'] as const)('never prompts the old ACP after the user grant changes while waiting on %s', async wait => {
    const t = await fixture('managed', { maxConcurrent: 1 }), request = t.message('找一下季报材料')
    const hit = historyMsg({ messageId: 'om_hit', chatId: 'oc_group', text: 'GROUP_BODY_CANARY' })
    t.fake.messages.set(hit.messageId, hit); t.fake.searchHits = [hit.messageId]
    t.peer.state.script = [{ kind: 'hook', run: async () => { await t.post('messages/search', { query: '季报' }) } },
      { kind: 'text', text: '找到了：GROUP_BODY_CANARY' }]
    await t.host.handleMessage(request)
    const task = t.registry.taskForMessage(request.messageId)!, oldAcp = t.registry.getSession(task.sessionKey)!.acpSessionId!
    const firstRun = t.registry.db.prepare('SELECT id FROM run_attempts WHERE task_id = ?').get(task.id) as { id: string }
    expect(t.registry.getTask(task.id)?.status).toBe('done')
    expect(t.sourceContexts.get(task.sessionKey)?.messageSources).toMatchObject([{ chatId: 'oc_group', readIdentity: { kind: 'user' } }])
    expect(t.contexts.get(oldAcp)?.notes).toEqual([])
    const oldPrompts = t.peer.state.allPrompts.length, sentBefore = t.fake.sent.length
    const followup = t.message('继续', request.messageId)
    if (wait === 'resume') {
      t.peer.state.onResume = async () => { t.userTokens.disconnect('ou_owner') }
      t.peer.state.script = [{ kind: 'text', text: '按当前可用资料继续。' }]
      await t.host.handleMessage(followup)
    } else {
      // A different user's DM holds the single prompt slot, so the follow-up waits on the gate after its preflight.
      const hold = deferred(), entered = deferred()
      t.peer.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await hold.promise } }, { kind: 'text', text: '另一件事已处理。' }]
      const blocker = t.host.handleMessage({ ...t.message('另一件事'), chatId: 'oc_dm_other', senderOpenId: 'ou_other' })
      await entered.promise
      const pending = t.host.handleMessage(followup)
      await waitFor(() => t.runtime.load().waiting === 1, 'the follow-up to queue behind the busy gate')
      t.userTokens.disconnect('ou_owner')
      hold.resolve()
      await Promise.all([blocker, pending])
    }
    expect(t.peer.state.allPrompts.slice(oldPrompts).filter(prompt => prompt.sessionId === oldAcp)).toEqual([])
    expect(JSON.stringify(t.peer.state.allPrompts.slice(oldPrompts))).not.toContain('GROUP_BODY_CANARY')
    expect(t.runtime.isSessionActive(oldAcp)).toBe(false)
    expect(JSON.stringify(t.fake.sent.slice(sentBefore))).not.toContain('GROUP_BODY_CANARY')
    expect(t.attempts.get(firstRun.id)?.state).toBe('completed')
    expect(t.registry.getTask(task.id)?.status).toBe('done')
    expect(JSON.stringify(t.registry.db.prepare('SELECT * FROM memory_notes').all())).not.toContain('GROUP_BODY_CANARY')
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM execution_material_files').get()?.n).toBe(0)
    const followupTask = t.registry.taskForMessage(followup.messageId)!
    if (wait === 'resume') {
      // The grant changed inside prepare: the resumed handle is released and the same request continues in a clean context.
      expect(followupTask.status).toBe('done')
      expect(t.registry.getSession(task.sessionKey)?.acpSessionId).not.toBe(oldAcp)
      expect(t.peer.state.allPrompts.slice(oldPrompts)).toHaveLength(1)
    } else {
      // The grant changed after prepare: dispatch is refused and the user gets a fixed notice instead of a reply from the old history.
      expect(followupTask.status).toBe('failed')
      expect(t.fake.sent.slice(sentBefore).map(item => JSON.stringify(item.payload)).join('\n')).toContain('资料读取授权发生了变化')
      expect(t.peer.state.allPrompts.slice(oldPrompts).map(prompt => prompt.sessionId)).not.toContain(oldAcp)
    }
  })
})
