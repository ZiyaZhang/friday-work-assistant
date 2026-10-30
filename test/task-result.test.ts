import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createInternalApi } from '../src/internal/api.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent, type FakeTurnStep } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'
import { chatScope, spaceDeps } from './helpers/space.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { ChangeManager } from '../src/github/changes.js'
import { managedHostRuntime } from './helpers/managed-host.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks() })

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    eventId: 'ev_result', messageId: 'om_result', chatId: 'oc_result', chatType: 'group',
    msgType: 'text', text: '@Friday 请用一句话解释会话与任务的区别。',
    senderOpenId: 'ou_alice', senderType: 'user',
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Friday' }],
    createTimeMs: Date.now(), ...over,
  }
}

/** Real host/runtime/stores, existing ACP SDK and Feishu substitutes; no external calls. */
function setup(script: FakeTurnStep[], preparationStatus?: ChangeManager['preparationStatus'], managedMode = false) {
  const home = mkdtempSync(join(tmpdir(), 'friday-task-result-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_DEFAULT_EXECUTION: managedMode ? 'managed' : 'workspace' } as NodeJS.ProcessEnv)
  const registry = new Registry(':memory:')
  const memory = new ChannelMemory(registry.db)
  const routines = new RoutineStore(registry.db)
  const messageCache = new MessageCache(registry.db)
  const sp = spaceDeps(registry.db, { admins: cfg.policy.admins })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_result', openId: 'ou_alice' })
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
  registry.setKv(`welcomed:${dm.id}`, 'test-existing-space')
  const feishu = new FakeFeishu()
  feishu.threadIdForReply = 'omt_result'
  feishu.members.set('oc_result', new Set(['ou_alice']))
  const log = createLogger('task-result-test', 'error')
  const managedExecution = managedMode ? managedHostRuntime(registry, home, log) : undefined
  const { app, state } = managedExecution?.peer ?? createFakeAgent({ script })
  state.script = script
  const tokens = new TokenIssuer('synthetic-only')
  const messages = new MessageService(asFeishuClient(feishu), messageCache, log)
  let orchestrator!: Orchestrator
  const runtime = managedExecution?.runtime ?? new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), maxConcurrent: cfg.policy.maxConcurrentTurns, log })
  orchestrator = new Orchestrator({ cfg, registry, memory, routines, messages, ...sp, runtime, feishu: asFeishuClient(feishu), tokens, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent/server.js', botOpenId: 'ou_bot', log,
    managed: managedExecution?.managed, changes: preparationStatus ? { preparationStatus } as ChangeManager : undefined })
  const resolveActorForSession = vi.fn((key: string) => orchestrator.resolveActorForSession(key))
  const api = createInternalApi({ registry, memory, routines, messages, messageCache, todos: new Todos(registry.db), ...sp, tokens, feishu: asFeishuClient(feishu), log, maxHistoryPerCall: 50,
    resolveActorForSession,
    deliverToolResult: (key, runId, input) => orchestrator.deliverToolResult(key, runId, input),
    onCrossSpaceRead: (key, read) => orchestrator.noteCrossSpaceRead(key, read),
    onRepositoryRead: (key, repo) => orchestrator.noteRepositoryRead(key, repo),
    canPersistDerivedState: (key) => orchestrator.canPersistDerivedState(key),
    github: { repoAllowed: () => true, repoWritable: () => true, api: async (_method: string, path: string) => path.includes('/comments?') ? [] : { number: 1, title: '合成事项', state: 'open', body: '合成仓库资料', html_url: 'https://github.com/example/synthetic/issues/1' } } as unknown as GitHubIdentity,
  })
  const current = () => {
    const sessionId = state.allPrompts.at(-1)!.sessionId
    const session = registry.getSessionByAcpId(sessionId)!
    const servers = state.sessions.get(sessionId)!.mcpServers as { env: { name: string; value: string }[] }[]
    const token = servers[0]!.env.find((item) => item.name === 'FRIDAY_CAP_TOKEN')!.value
    return { session, token }
  }
  let listening: Promise<string> | undefined
  const startApi = () => listening ??= new Promise<string>((resolve) => api.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}`)))
  const post = async (path: string, body: Record<string, unknown>) => {
    const token = current().token
    const response = await fetch(`${await startApi()}/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const file = () => {
    const cwd = current().session.cwd
    mkdirSync(join(cwd, 'downloads'), { recursive: true })
    writeFileSync(join(cwd, 'downloads', '12345678-result.md'), '# synthetic result')
    return { path: 'downloads/12345678-result.md' }
  }
  const records = () => registry.db.prepare('SELECT status, remote_id, delivery_key FROM deliveries WHERE delivery_key LIKE ? ORDER BY created_at, delivery_key').all('%:tool:%') as { status: string; remote_id: string | null; delivery_key: string }[]
  cleanups.push(async () => {
    if (api.server.listening) { api.server.closeAllConnections(); await new Promise<void>((resolve) => api.server.close(() => resolve())) }
    await runtime.stop()
    registry.close()
    rmSync(home, { recursive: true, force: true })
  })
  return { cfg, registry, memory, feishu, state, runtime, orchestrator, routines, ...sp, group, dm, api, current, startApi, post, file, records, resolveActorForSession }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('HTTP tool delivery through the current host run', () => {
  it.each([false, true])('keeps the original preparation obligation in a new status-only Run (resolved=%s)', async resolved => {
    let preparationState: 'retryable' | 'prepared' = 'retryable'
    const t = setup([], () => preparationState, true)
    // The actual domain schema and original host receipt survive the Run boundary.
    new ChangeManager({ db: t.registry.db, cacheDir: '/unused-test-cache', github: {} as GitHubIdentity, log: createLogger('test', 'error') })
    t.state.script = [{ kind: 'hook', run: () => {
      const session = t.current().session, actor = t.orchestrator.resolveActorForSession(session.sessionKey)!
      t.registry.db.prepare(`INSERT INTO github_change_preparations
        (id,operation_key,signature,session_key,requester_open_id,cwd,repo,attempt_key,state,error_code,created_at,updated_at)
        VALUES('original','original','test',?,?,?,?,?,'retryable','timeout',?,?)`)
        .run(session.sessionKey, 'ou_alice', session.cwd, 'org/demo', actor.runId, Date.now(), Date.now())
      const calls = new RunApiCalls(t.registry.db), call = calls.begin(actor.runId, 'POST /v1/github/change/start')
      calls.need(call, 'github:write'); calls.reference(call, { kind: 'github_change_preparation', id: 'original' }); calls.finish(call, 'failed')
    } }, { kind: 'text', text: '仓库还没有准备好。' }]
    const inbound = msg({ chatId: 'oc_dm', chatType: 'p2p', mentions: [] })
    await t.orchestrator.handleMessage(inbound)
    const task = t.registry.taskForMessage(inbound.messageId)!, attempts = new RunAttempts(t.registry.db), original = attempts.latestForTask(task.id)!
    expect(original.result).toMatchObject({ outcome: 'partial', reason: 'operation_incomplete' })
    t.state.script = [{ kind: 'hook', run: () => {
      const current = t.orchestrator.resolveActorForSession(t.current().session.sessionKey)!
      expect(current.runId).not.toBe(original.id)
      expect(new RunApiCalls(t.registry.db).forRun(current.runId)).toEqual([])
      if (resolved) preparationState = 'prepared'
    } }, { kind: 'text', text: '本轮状态说明。' }]
    expect(t.registry.dispatches.resume(task.id, { previousRunId: original.id, reason: 'local_preparation' }, Date.now())).toBe(true)
    await t.orchestrator.recoverHandoffs()
    await vi.waitFor(() => {
      const latest = attempts.latestForTask(task.id)!
      expect(latest.id).not.toBe(original.id); expect(latest.state).toBe('completed')
    })
    expect(attempts.latestForTask(task.id)?.result).toMatchObject(resolved
      ? { outcome: 'handled', reason: 'normal_end' } : { outcome: 'partial', reason: 'operation_incomplete' })
    if (!resolved) {
      expect(t.feishu.reactionsOn(inbound.messageId)).not.toContain(t.cfg.feishu.reactions.done)
      expect(t.memory.recent(chatScope(t.registry.db, inbound.chatId))).toEqual([])
    }
  })
  it.each(['preparing', 'retryable', 'prepared'] as const)('uses the actual %s preparation receipt at model end_turn, not its wording', async status => {
    const t = setup([], () => status)
    t.state.script = [{ kind: 'hook', run: () => {
      const actor = t.orchestrator.resolveActorForSession(t.current().session.sessionKey)!
      const calls = new RunApiCalls(t.registry.db)
      const id = calls.begin(actor.runId, 'POST /v1/github/change/start')
      calls.need(id, 'github:write')
      calls.reference(id, { kind: 'github_change_preparation', id: 'actual-preparation' })
      calls.finish(id, 'failed') // The HTTP outcome is not the concrete preparation outcome.
    } }, { kind: 'text', text: '这次执行的说明。' }]
    const inbound = msg()
    await t.orchestrator.handleMessage(inbound)
    const task = t.registry.taskForMessage(inbound.messageId)!
    const result = new RunAttempts(t.registry.db).latestForTask(task.id)?.result
    if (status === 'prepared') expect(result).toMatchObject({ outcome: 'handled', reason: 'normal_end' })
    else {
      expect(result).toMatchObject({ outcome: 'partial', reason: 'operation_incomplete' })
      expect(t.feishu.reactionsOn(inbound.messageId)).not.toContain(t.cfg.feishu.reactions.done)
      expect(t.memory.recent(chatScope(t.registry.db, inbound.chatId))).toEqual([])
    }
  })
  it.each(['group-file', 'dm-file', 'dm-message'] as const)('accepts a real %s receipt as an empty-text result without placeholder or QA', async (kind) => {
    const t = setup([])
    let response!: Awaited<ReturnType<typeof t.post>>
    t.state.script = [{ kind: 'hook', run: async () => {
      response = await t.post(kind === 'dm-message' ? 'dm' : 'file/send', kind === 'dm-message' ? { text: '给本人的合成结果' } : { ...t.file(), ...(kind === 'dm-file' ? { file_name: '总结.md' } : {}) })
    } }]
    const inbound = msg(kind === 'dm-file' ? { chatId: 'oc_dm', chatType: 'p2p', mentions: [] } : {})
    await t.orchestrator.handleMessage(inbound)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ok: true, message_id: expect.any(String) })
    expect(t.registry.taskForMessage(inbound.messageId)).toMatchObject({ status: 'done', stopReason: 'end_turn' })
    expect(t.feishu.sent).toHaveLength(1)
    expect(t.feishu.sent[0]).toMatchObject({ kind: kind === 'group-file' ? 'replyFile' : kind === 'dm-file' ? 'sendFileToUser' : 'sendToUser', target: kind === 'group-file' ? inbound.messageId : 'ou_alice' })
    if (kind !== 'dm-message') expect(t.feishu.uploads).toMatchObject([{ name: kind === 'dm-file' ? '总结.md' : 'result.md', path: Buffer.from('# synthetic result') }])
    expect(t.records()).toMatchObject([{ status: 'sent', remote_id: response.body.message_id }])
    expect(t.registry.db.prepare('SELECT id FROM memory_notes').all()).toEqual([])
    expect(JSON.stringify(t.feishu.sent)).not.toContain('本轮没有文字回复')
  })

  it('does not accept an ACP completed tool without a host delivery receipt', async () => {
    const t = setup([{ kind: 'tool', text: 'feishu_send_file: 已发送', toolKind: 'other', rawInput: { message_id: 'om_forged' } }])
    const inbound = msg()
    await t.orchestrator.handleMessage(inbound)
    expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('failed')
    expect(t.records()).toEqual([])
    expect(t.feishu.uploads).toEqual([])
    expect(t.feishu.reactionsOn(inbound.messageId)).not.toContain(t.cfg.feishu.reactions.done)
    expect(t.memory.recent(chatScope(t.registry.db, inbound.chatId))).toEqual([])
  })

  it('keeps an unknown file send unknown across an identical HTTP retry and never reports DONE', async () => {
    const t = setup([])
    const send = t.feishu.replyFile.bind(t.feishu)
    const attempted = vi.spyOn(t.feishu, 'replyFile').mockImplementation(async (...args) => { await send(...args); throw new Error('synthetic ACK lost') })
    const replies: Awaited<ReturnType<typeof t.post>>[] = []
    t.state.script = [{ kind: 'hook', run: async () => {
      const body = t.file()
      replies.push(await t.post('file/send', body), await t.post('file/send', body))
    } }]
    const inbound = msg()
    await t.orchestrator.handleMessage(inbound)
    expect(replies.map((r) => r.status)).toEqual([500, 500])
    expect(attempted).toHaveBeenCalledTimes(1)
    expect(t.feishu.uploads).toHaveLength(1)
    expect(t.records()).toMatchObject([{ status: 'unknown', remote_id: null }])
    expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('failed')
    expect(t.feishu.reactionsOn(inbound.messageId)).not.toContain(t.cfg.feishu.reactions.done)
    expect(t.memory.recent(chatScope(t.registry.db, inbound.chatId))).toEqual([])
  })

  it('returns file success plus unknown note status and suppresses a misleading final answer', async () => {
    const t = setup([])
    const send = t.feishu.replyMarkdown.bind(t.feishu)
    vi.spyOn(t.feishu, 'replyMarkdown').mockImplementation(async (...args) => { await send(...args); throw new Error('synthetic note ACK lost') })
    let response!: Awaited<ReturnType<typeof t.post>>
    t.state.script = [
      { kind: 'hook', run: async () => { response = await t.post('file/send', { ...t.file(), note: '合成附言' }) } },
      { kind: 'text', text: '模型声称文件和附言都已送达' },
    ]
    const inbound = msg()
    await t.orchestrator.handleMessage(inbound)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ok: true, message_id: t.feishu.of('replyFile')[0]!.messageId, note_status: 'unknown' })
    expect(t.records().map((r) => r.status).sort()).toEqual(['sent', 'unknown'])
    const task = t.registry.taskForMessage(inbound.messageId)!
    expect(task).toMatchObject({ status: 'done', stopReason: 'end_turn' })
    const outcome = t.registry.db.prepare("SELECT result_json FROM run_attempts WHERE task_id=? AND stage='task'").get(task.id)
    expect(JSON.parse(String(outcome?.result_json))).toMatchObject({ termination: 'end_turn', outcome: 'partial', reason: 'delivery_partial' })
    // An unknown note receipt requires reconciliation; neither DONE nor a
    // partial-success reaction is evidence that this note reached the person.
    expect(t.feishu.reactionsOn(inbound.messageId)).toEqual([])
    expect(JSON.stringify(t.feishu.sent)).not.toContain('模型声称')
    expect(t.memory.recent(chatScope(t.registry.db, inbound.chatId))).toEqual([])
  })

  it('preserves ACP cancellation after a sent file and unknown note instead of reporting partial success', async () => {
    const t = setup([])
    const send = t.feishu.replyMarkdown.bind(t.feishu)
    vi.spyOn(t.feishu, 'replyMarkdown').mockImplementation(async (...args) => { await send(...args); throw new Error('synthetic note ACK lost') })
    let response!: Awaited<ReturnType<typeof t.post>>
    t.state.script = [
      { kind: 'hook', run: async () => {
        response = await t.post('file/send', { ...t.file(), note: '合成附言' })
        t.state.cancelPending.add(t.state.allPrompts.at(-1)!.sessionId)
      } },
      { kind: 'text', text: '取消后的正文不能发布' },
    ]
    const inbound = msg()
    await t.orchestrator.handleMessage(inbound)
    expect(response.body.note_status).toBe('unknown')
    expect(t.records().map((r) => r.status).sort()).toEqual(['sent', 'unknown'])
    expect(t.registry.taskForMessage(inbound.messageId)).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' })
    expect(t.feishu.reactionsOn(inbound.messageId)).not.toContain(t.cfg.feishu.reactions.done)
    expect(t.feishu.reactionsOn(inbound.messageId)).not.toContain(t.cfg.feishu.reactions.partial)
    expect(JSON.stringify(t.feishu.sent)).not.toContain('取消后的正文不能发布')
    expect(t.memory.recent(chatScope(t.registry.db, inbound.chatId))).toEqual([])
  })

  it.each(['p2p', 'group'] as const)('checks real cross-group history provenance before a file to %s', async (chatType) => {
    const t = setup([])
    t.spaces.ensure({ kind: 'group', chatId: 'oc_other', openId: 'ou_alice' })
    t.circles.join('oc_result', 'synthetic')
    t.circles.join('oc_other', 'synthetic')
    t.feishu.chats.push({ chatId: 'oc_other', name: '合成来源群' })
    t.feishu.members.set('oc_other', new Set(['ou_alice']))
    t.feishu.histories.set('oc_other', [historyMsg({ messageId: 'om_source', chatId: 'oc_other', text: '合成来源群资料', createTimeMs: Date.now() - 60_000 })])
    let history!: Awaited<ReturnType<typeof t.post>>
    let response!: Awaited<ReturnType<typeof t.post>>
    t.state.script = [{ kind: 'hook', run: async () => {
      history = await t.post('chat/history', { chat: 'oc_other' })
      response = await t.post('file/send', t.file())
    } }]
    const inbound = msg(chatType === 'p2p' ? { chatId: 'oc_dm', chatType, mentions: [] } : {})
    await t.orchestrator.handleMessage(inbound)
    expect(history.status).toBe(200)
    expect(history.body.items).toMatchObject([{ text: '合成来源群资料' }])
    if (chatType === 'p2p') {
      expect(response.status).toBe(200)
      expect(t.feishu.of('sendFileToUser')).toHaveLength(1)
      expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('done')
    } else {
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(t.feishu.uploads).toEqual([])
      expect(t.feishu.of('replyFile')).toEqual([])
      expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('failed')
    }
    expect(t.registry.db.prepare('SELECT id FROM memory_notes').all()).toEqual([])
  })

  it.each(['file/send', 'dm'] as const)('still denies %s after the GitHub API returned repository material', async (route) => {
    const t = setup([])
    let read!: Awaited<ReturnType<typeof t.post>>
    let response!: Awaited<ReturnType<typeof t.post>>
    t.state.script = [{ kind: 'hook', run: async () => {
      read = await t.post('github/issue', { repo: 'example/synthetic', number: 1 })
      response = await t.post(route, route === 'dm' ? { text: '合成仓库资料' } : t.file())
    } }]
    const inbound = msg({ chatId: 'oc_dm', chatType: 'p2p', mentions: [] })
    await t.orchestrator.handleMessage(inbound)
    expect(read.status).toBe(200)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(t.feishu.uploads).toEqual([])
    expect(t.feishu.of('sendFileToUser')).toEqual([])
    expect(t.feishu.of('sendToUser').filter((s) => JSON.stringify(s.payload).includes('合成仓库资料'))).toEqual([])
    expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('failed')
  })

  it('rechecks repository provenance acquired while delivery awaits current group membership', async () => {
    const t = setup([])
    let readStatus: number | undefined
    vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementation(async () => {
      readStatus = (await t.post('github/issue', { repo: 'example/synthetic', number: 1 })).status
      return new Set(['ou_alice'])
    })
    let response!: Awaited<ReturnType<typeof t.post>>
    t.state.script = [{ kind: 'hook', run: async () => { response = await t.post('file/send', t.file()) } }]
    const inbound = msg()
    await t.orchestrator.handleMessage(inbound)
    expect(readStatus).toBe(200)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(t.feishu.uploads).toEqual([])
    expect(t.feishu.of('replyFile')).toEqual([])
    expect(t.records()).toEqual([])
    expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('failed')
  })

  it('releases a cancelled run before upload resolves and never publishes the late file', async () => {
    const t = setup([])
    const uploaded = deferred(), releaseUpload = deferred()
    const upload = t.feishu.uploadFile.bind(t.feishu)
    vi.spyOn(t.feishu, 'uploadFile').mockImplementation(async (...args) => { uploaded.resolve(); await releaseUpload.promise; return upload(...args) })
    let pending!: ReturnType<typeof t.post>
    t.state.script = [{ kind: 'hook', run: async () => { pending = t.post('file/send', t.file()); await uploaded.promise } }]
    const inbound = msg()
    const run = t.orchestrator.handleMessage(inbound)
    try {
      await uploaded.promise
      await t.orchestrator.handleMessage(msg({ eventId: 'ev_stop_upload', messageId: 'om_stop_upload', rootId: inbound.messageId, text: '@Friday /stop' }))
      await vi.waitFor(() => expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('cancelled'), { timeout: 500 })
      await run
      expect(t.runtime.load().active).toBe(0)
      expect(t.feishu.of('replyFile')).toEqual([])
    } finally { releaseUpload.resolve(); await run }
    expect((await pending).status).toBeGreaterThanOrEqual(400)
    expect(t.feishu.of('replyFile')).toEqual([])
    expect(t.memory.recent(chatScope(t.registry.db, inbound.chatId))).toEqual([])
  })

  it('rejects a slow HTTP body accepted in the previous run despite the same session and actor', async () => {
    const t = setup([])
    const firstReady = deferred(), releaseFirst = deferred(), secondReady = deferred(), releaseSecond = deferred()
    t.state.script = [{ kind: 'hook', run: async () => { firstReady.resolve(); await releaseFirst.promise } }, { kind: 'text', text: '第一轮结束' }]
    const inbound = msg()
    const first = t.orchestrator.handleMessage(inbound)
    await firstReady.promise
    const token = t.current().token
    const url = `${await t.startApi()}/v1/dm`
    const payload = JSON.stringify({ text: '旧运行迟到的消息' })
    const before = t.resolveActorForSession.mock.calls.length
    const req = request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } })
    const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
      req.on('error', reject)
      req.on('response', (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (part) => { body += part }); res.on('end', () => resolve({ status: res.statusCode!, body })) })
    })
    let second: Promise<void> | undefined
    try {
      req.write(payload.slice(0, 1))
      await vi.waitFor(() => expect(t.resolveActorForSession.mock.calls.length).toBeGreaterThan(before))
      releaseFirst.resolve(); await first
      t.state.script = [{ kind: 'hook', run: async () => { secondReady.resolve(); await releaseSecond.promise } }, { kind: 'text', text: '第二轮结束' }]
      second = t.orchestrator.handleMessage(msg({ eventId: 'ev_next', messageId: 'om_next', rootId: inbound.messageId, text: '@Friday 继续下一轮' }))
      await secondReady.promise
      req.end(payload.slice(1))
      const response = await result
      expect(response.status).toBe(403)
      expect(response.body).toContain('运行实例')
      expect(t.feishu.of('sendToUser')).toEqual([])
    } finally {
      req.destroy(); releaseFirst.resolve(); releaseSecond.resolve(); await first; await second
    }
  })

  it('accepts a fresh schedule file receipt with empty text instead of an empty-result notice', async () => {
    const t = setup([])
    let response!: Awaited<ReturnType<typeof t.post>>
    t.state.script = [{ kind: 'hook', run: async () => { response = await t.post('file/send', t.file()) } }]
    const routine = t.routines.add({ kind: 'schedule', ownerOpenId: 'ou_alice', spaceId: t.group.id, chatId: 'oc_result', chatType: 'group', name: '合成文件日报', prompt: '输出文件', schedule: { type: 'interval', everyMinutes: 10 }, deliveryPolicy: 'every_run' })
    expect(await t.orchestrator.runRoutine(routine, { manualMessageId: 'om_run_schedule' })).toBe('ok')
    expect(response.status).toBe(200)
    expect(t.feishu.sent).toMatchObject([{ kind: 'sendFileToChat', target: 'oc_result', messageId: response.body.message_id }])
    expect(t.records()).toMatchObject([{ status: 'sent' }])
    expect(JSON.stringify(t.feishu.sent)).not.toContain('没有生成结果')
    expect(t.registry.db.prepare('SELECT id FROM memory_notes').all()).toEqual([])
  })
})

describe('task result delivery', () => {
  it.each([
    { name: 'empty', script: [] as FakeTurnStep[] },
    { name: 'whitespace-only', script: [{ kind: 'text', text: ' \n\t　 ' }] as FakeTurnStep[] },
  ])('fails an $name end_turn without a delivered result', async ({ script }) => {
    const t = setup(script)
    const inbound = msg()
    await t.orchestrator.handleMessage(inbound)

    expect.soft(t.registry.taskForMessage(inbound.messageId)?.status).toBe('failed')
    expect.soft(t.feishu.reactionLog.filter((r) => r.op === 'add').map((r) => r.emoji)).not.toContain(t.cfg.feishu.reactions.done)
    expect.soft(t.memory.recent(chatScope(t.registry.db, inbound.chatId))).toEqual([])
    expect(t.feishu.sent).toHaveLength(1)
    const sent = t.feishu.sent[0]!
    const text = String(sent.payload)
    expect.soft(sent.kind).toMatch(/^reply(?:Text|Markdown)$/)
    expect.soft(sent.target).toBe(inbound.messageId)
    expect.soft(text).not.toContain('（本轮没有文字回复）')
    expect.soft(text).toMatch(/失败|未能|没能|未完成|没有.*(?:回复|答案|结果)/)
    expect.soft(text.trim().length).toBeGreaterThan(0)
    expect.soft(text.length).toBeLessThanOrEqual(120)
    expect(t.state.allPrompts).toHaveLength(1)
  })

  it('succeeds with a normal answer and retains its candidate QA', async () => {
    const answer = '会话承载连续上下文，任务对应一次需要交付结果的工作。'
    const t = setup([{ kind: 'text', text: answer }])
    const inbound = msg()
    await t.orchestrator.handleMessage(inbound)

    expect(t.registry.taskForMessage(inbound.messageId)).toMatchObject({ status: 'done', stopReason: 'end_turn' })
    expect(t.feishu.answers()).toEqual([answer])
    expect(t.feishu.reactionsOn(inbound.messageId)).toEqual([t.cfg.feishu.reactions.done])
    expect(t.memory.recent(chatScope(t.registry.db, inbound.chatId))).toMatchObject([{ kind: 'qa', body: answer, status: 'candidate', confirmation: null }])
    expect(t.state.allPrompts).toHaveLength(1)
  })

  it('keeps a cancelled draft out of final delivery and QA', async () => {
    let buffered!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => { buffered = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const draft = '尚未完成且未经核对的草稿'
    const t = setup([
      { kind: 'text', text: draft },
      { kind: 'hook', run: async () => { buffered(); await blocked } },
      { kind: 'text', text: '取消后的迟到正文' },
    ])
    const inbound = msg()
    const run = t.orchestrator.handleMessage(inbound)
    try {
      await ready
      await t.orchestrator.handleMessage(msg({ eventId: 'ev_stop', messageId: 'om_stop', rootId: inbound.messageId, text: '@Friday /stop' }))
    } finally {
      release()
      await run
    }

    expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('cancelled')
    expect(t.feishu.answers()).toEqual([])
    expect(JSON.stringify(t.feishu.sent)).not.toContain(draft)
    expect(JSON.stringify(t.feishu.sent)).not.toContain('取消后的迟到正文')
    expect(t.feishu.reactionLog.filter((r) => r.op === 'add').map((r) => r.emoji)).not.toContain(t.cfg.feishu.reactions.done)
    expect(t.memory.recent(chatScope(t.registry.db, inbound.chatId))).toEqual([])
    expect(t.state.allPrompts).toHaveLength(1)
  })
})
