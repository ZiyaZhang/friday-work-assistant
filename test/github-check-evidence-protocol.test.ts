import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { SourceContexts } from '../src/core/source-context.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { GitHubIdentity, type GitHubHttp } from '../src/github/identity.js'
import type { PullRequestCheckEvidence } from '../src/github/pr-check-evidence.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer, type CapabilityScope } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { buildServer } from '../src/mcp/server.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const HEAD = 'a'.repeat(40), OTHER_HEAD = 'b'.repeat(40), PR = '/repos/org/repo/pulls/9', CHECK = '/repos/org/repo/check-runs/101'
const args = { repo: 'org/repo', number: 9, check_run_id: 101 }
type Reply = { isError?: boolean; content: { type: string; text?: string }[] }
const text = (reply: Reply) => reply.content.map(item => item.text ?? '').join('\n')
const decoded = (reply: Reply): PullRequestCheckEvidence => { expect(reply.isError, text(reply)).not.toBe(true); return JSON.parse(text(reply)) }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

/** Real SDK tools, signed HTTP, GitHubIdentity, Task/Run and provenance stores.
 * Only GitHub/Feishu network transports are synthetic; no credentials are read. */
async function fixture(scopes: CapabilityScope[] = ['github:read']) {
  const registry = new Registry(':memory:'), sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'p2p', chatId: 'dm-a', openId: 'alice' })
  const log = createLogger('check-evidence-protocol', 'error'), attempts = new RunAttempts(registry.db), calls = new RunApiCalls(registry.db)
  const sources = new SourceContexts(registry), cache = new MessageCache(registry.db), fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  const tokens = new TokenIssuer('synthetic-check-evidence-signing'), providerCalls: string[] = []
  const hooks = { before: undefined as ((path: string) => Promise<void> | void) | undefined,
    annotationStatus: 200, headChanged: false, annotations: 1, checkHead: HEAD, actions: false,
    beforeLog: undefined as (() => Promise<void> | void) | undefined }
  const logReads: { jobId: number; maxBytes: number; startByte?: number }[] = []
  let heads = 0
  const http: GitHubHttp = { async request<T>(method: string, path: string) {
    expect(method).toBe('GET'); providerCalls.push(path); await hooks.before?.(path)
    let data: unknown
    if (path === PR) data = { head: { sha: ++heads > 1 && hooks.headChanged ? OTHER_HEAD : HEAD } }
    else if (path === CHECK) data = { id: 101, url: `https://api.github.com${CHECK}`, head_sha: hooks.checkHead,
      name: 'Typecheck', status: 'completed', conclusion: 'failure', completed_at: '2026-09-23T01:00:00Z',
      ...(hooks.actions ? { details_url: 'https://github.com/org/repo/actions/runs/77/job/201' } : {}),
      output: { title: 'Failure evidence', summary: 'Synthetic compiler failure', text: 'TS2322', annotations_count: hooks.annotations } }
    else if (path === '/repos/org/repo/actions/jobs/201') data = { id: 201, run_id: 77, head_sha: HEAD,
      name: 'Compile job', check_run_url: `https://api.github.com${CHECK}`, status: 'completed', conclusion: 'failure',
      steps: [{ name: 'Compile', number: 1, status: 'completed', conclusion: 'failure' }] }
    else if (path.startsWith(`${CHECK}/annotations?`)) {
      if (hooks.annotationStatus !== 200) return { status: hooks.annotationStatus, data: { message: 'synthetic annotation denial' } as T }
      const page = Number(new URL(path, 'https://api.github.com').searchParams.get('page'))
      data = Array.from({ length: Math.min(100, Math.max(0, hooks.annotations - (page - 1) * 100)) }, (_, index) => ({
        path: `src/example-${(page - 1) * 100 + index}.ts`, start_line: 4, end_line: 4,
        annotation_level: 'failure', message: 'Expected string, got number', title: null, raw_details: null }))
    } else throw new Error(`Unexpected synthetic GitHub path ${path}`)
    return { status: 200, data: data as T }
  }, async readActionsJobLog(input, authorization) {
    input.assertCurrent(); expect(authorization).toBe('Bearer synthetic-github-token')
    logReads.push({ jobId: input.jobId, maxBytes: input.maxBytes, startByte: input.startByte })
    await hooks.beforeLog?.(); input.assertCurrent()
    const all = Buffer.from('build starts\ncompiler rejected src/example.ts\nexit 1\n')
    const startByte = input.startByte ?? Math.max(0, all.length - input.maxBytes)
    const data = all.subarray(startByte, Math.min(all.length, startByte + input.maxBytes))
    return { data, startByte, endByte: startByte + data.length, totalBytes: all.length,
      sha256: createHash('sha256').update(data).digest('hex') }
  } }
  const github = new GitHubIdentity({ mode: 'pat', token: 'synthetic-github-token', apiUrl: 'https://api.github.com',
    allowedRepos: ['org/repo'], writableRepos: [] }, log, http)
  registry.createSession({ sessionKey: 's1', chatId: space.chatId, chatType: space.kind, requesterOpenId: 'alice', cwd: '/tmp/synthetic-evidence' })
  const task = registry.createTaskOnce({ sessionKey: 's1', messageId: 'om-evidence', requesterOpenId: 'alice', prompt: '定位这个 PR 的检查失败',
    inbound: { eventId: 'event-evidence', messageId: 'om-evidence', chatId: space.chatId, chatType: space.kind, senderOpenId: 'alice',
      senderType: 'user', msgType: 'text', text: '定位这个 PR 的检查失败', mentions: [], createTimeMs: Date.now() } }).task
  expect(registry.startTask(task.id, Date.now(), 's1')).toBe(true)
  const workKey = registry.taskWork.get(task.id)!.key
  const run = attempts.begin({ sessionKey: 's1', taskId: task.id, workKey, actorOpenId: 'alice', triggerKey: 'check-evidence', stage: 'task', now: Date.now() })!
  attempts.bindExecutionBoundary(run.id, 'managed_api_v1'); attempts.bindRuntime(run.id, 'acp-evidence')
  sources.initialize({ sessionKey: 's1', acpSessionId: 'acp-evidence', spaceId: space.id, chatId: space.chatId }, [])
  const current = { runId: run.id, actor: 'alice', stage: 'task' }
  const api = createInternalApi({ registry, ...sp, github, tokens, log, feishu, messageCache: cache,
    memory: new ChannelMemory(registry.db), messages: new MessageService(feishu, cache, log), todos: new Todos(registry.db), maxHistoryPerCall: 20,
    resolveActorForSession: sessionKey => sessionKey === 's1' && attempts.isCurrent(current.runId)
      ? { requesterOpenId: current.actor, taskId: task.id, runId: current.runId, stage: current.stage } : undefined,
    allowedRoutesForSession: () => current.stage === 'reflect' ? ['POST /v1/memory/search'] : undefined,
    onRepositoryRead: (key, repo) => sources.addRepository(key, repo),
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const token = tokens.issue({ sessionKey: 's1', runId: run.id, requesterOpenId: 'alice', chatId: space.chatId, chatType: space.kind, spaceId: space.id, scopes })
  const server = buildServer({ apiUrl, token }), client = new Client({ name: 'check-evidence-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
  cleanups.push(async () => { await client.close(); await server.close(); api.beginShutdown(); api.server.closeAllConnections()
    expect((await api.waitForShutdown(3000)).drained).toBe(true)
    await new Promise<void>(resolve => api.server.close(() => resolve())); registry.close() })
  const call = async (extra: Record<string, unknown> = {}) => await client.callTool({ name: 'github_pr_check_evidence', arguments: { ...args, ...extra } }) as Reply
  const post = async (extra: Record<string, unknown> = {}) => {
    const response = await fetch(`${apiUrl}/v1/github/pr/check-evidence`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...args, ...extra }) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  return { registry, attempts, run, task, calls, sources, space, sp, current, hooks, providerCalls, logReads, call, post }
}

describe('failure check evidence over SDK and signed HTTP', () => {
  it('carries the chosen byte and line window through SDK and signed HTTP to the verified Actions job', async () => {
    const t = await fixture(); t.hooks.actions = true
    const evidence = decoded(await t.call({ expected_head: HEAD, log_start_byte: 13, log_max_bytes: 64, log_max_lines: 1 }))
    expect(t.logReads).toEqual([{ jobId: 201, maxBytes: 64, startByte: 13 }])
    expect(evidence).toMatchObject({ status: 'partial', actions: { logs: {
      status: 'available', text: 'compiler rejected src/example.ts\n', startByte: 13,
      maxBytes: 64, maxLines: 1, complete: false, nextStartByte: 46 } } })
    expect(t.sources.get('s1')?.repositories).toEqual(['org/repo'])
    const continued = await t.post({ expected_head: HEAD, log_start_byte: 46, log_max_bytes: 64, log_max_lines: 5 })
    expect(continued.status).toBe(200)
    expect(continued.body).toMatchObject({ actions: { logs: { text: 'exit 1\n', nextStartByte: null } } })
    expect(JSON.stringify(evidence)).not.toContain('synthetic-github-token')
  })

  it('reads the failed job log by default so a bare red check is no longer the entire diagnostic evidence', async () => {
    const t = await fixture(); t.hooks.actions = true
    expect(decoded(await t.call())).toMatchObject({ actions: { logs: { status: 'available', complete: true,
      text: 'build starts\ncompiler rejected src/example.ts\nexit 1\n' } } })
    expect(t.logReads).toHaveLength(1)
  })

  it('lets the caller search actual log text through the same scoped read, with bounded original-text windows', async () => {
    const t = await fixture(); t.hooks.actions = true
    const evidence = decoded(await t.call({ log_query: 'src/example.ts', log_max_bytes: 64, log_max_lines: 3 }))
    expect(evidence).toMatchObject({ actions: { logs: { status: 'available', mode: 'search', query: 'src/example.ts',
      matches: 1, complete: true, nextStartByte: null,
      windows: [{ text: 'build starts\ncompiler rejected src/example.ts\nexit 1\n' }] } } })
    expect(t.logReads).toHaveLength(1)
    expect(t.logReads[0]?.jobId).toBe(201)
    const missing = await t.post({ log_query: 'not in this log', log_max_bytes: 64 })
    expect(missing.status).toBe(200)
    expect(missing.body).toMatchObject({ actions: { logs: { mode: 'search', matches: 0, complete: true, windows: [] } } })
  })

  it.each([{ log_start_byte: -1 }, { log_start_byte: 0.5 }, { log_start_byte: '0' },
    { log_max_bytes: 0 }, { log_max_bytes: 1 }, { log_max_bytes: 3 }, { log_max_bytes: 65_537 }, { log_max_lines: 0 }, { log_max_lines: 501 },
    { log_query: '' }, { log_query: '  ' }, { log_query: 'x'.repeat(513) }, { log_query: 42 }])(
    'rejects an invalid log window before network access at both boundaries (%j)', async extra => {
      const t = await fixture(); t.hooks.actions = true
      expect((await t.post(extra)).status).toBe(400)
      expect((await t.call(extra)).isError).toBe(true)
      expect(t.providerCalls).toEqual([]); expect(t.logReads).toEqual([])
    })

  it('drops log bytes and source proof if the run stops while the log transport is in flight', async () => {
    const t = await fixture(); t.hooks.actions = true
    const entered = deferred(), release = deferred()
    t.hooks.beforeLog = async () => { entered.resolve(); await release.promise }
    const pending = t.call()
    try {
      await Promise.race([entered.promise, pending.then(result => { throw new Error(`Log read was not reached: ${text(result)}`) })])
      t.attempts.requestStop(t.run.id, 'user_requested')
    } finally { release.resolve() }
    const result = await pending
    expect(result.isError).toBe(true); expect(text(result)).not.toContain('compiler rejected')
    expect(t.sources.get('s1')?.repositories).toEqual([])
  })

  it('returns the real failed evidence and persists only its repository source and read-only API receipt', async () => {
    const t = await fixture(), evidence = decoded(await t.call())
    expect(evidence).toMatchObject({ status: 'ready', head: HEAD, headCurrent: true, check: { id: 101, outcome: 'failed' },
      output: { text: { text: 'TS2322' } }, annotations: { complete: true, items: [{ path: { text: 'src/example-0.ts' }, startLine: 4 }] } })
    expect(t.sources.get('s1')?.repositories).toEqual(['org/repo'])
    expect(t.calls.forRun(t.run.id)).toMatchObject([{ route: 'POST /v1/github/pr/check-evidence', state: 'returned', scopes: ['github:read'] }])
    expect(t.registry.getTask(t.task.id)?.status).toBe('running')
    expect(JSON.stringify(evidence)).not.toMatch(/synthetic-github-token|synthetic-check-evidence-signing/)
  })

  it('cannot read checks without the signed github:read scope', async () => {
    const t = await fixture(['todo:read'])
    expect((await t.call()).isError).toBe(true)
    expect((await t.post()).status).toBe(403)
    expect(t.providerCalls).toEqual([])
    expect(t.sources.get('s1')?.repositories).toEqual([])
  })

  it.each(['stopped', 'different_actor', 'reflection', 'suspended'] as const)('rejects %s before any provider read', async reason => {
    const t = await fixture()
    if (reason === 'stopped') t.attempts.requestStop(t.run.id, 'user_requested')
    if (reason === 'different_actor') t.current.actor = 'bob'
    if (reason === 'reflection') t.current.stage = 'reflect'
    if (reason === 'suspended') t.sp.spaces.suspend(t.space.id)
    expect((await t.call()).isError).toBe(true)
    expect(t.providerCalls).toEqual([])
    expect(t.sources.get('s1')?.repositories).toEqual([])
  })

  it('does not rebind an old signed request to a new Run in the same session', async () => {
    const t = await fixture()
    t.attempts.finish(t.run.id, 'completed', Date.now(), 'end_turn')
    t.current.runId = t.attempts.begin({ sessionKey: 's1', taskId: t.task.id, workKey: t.run.workKey,
      actorOpenId: 'alice', triggerKey: 'next-check-run', stage: 'task', now: Date.now() })!.id
    expect((await t.call()).isError).toBe(true)
    expect(t.providerCalls).toEqual([])
  })

  it('drops late evidence and its provenance when the active Run stops during annotation I/O', async () => {
    const t = await fixture(), entered = deferred(), release = deferred()
    t.hooks.before = async path => { if (path.includes('/annotations?')) { entered.resolve(); await release.promise } }
    const pending = t.call()
    try { await entered.promise; t.attempts.requestStop(t.run.id, 'user_requested') } finally { release.resolve() }
    const reply = await pending
    expect(reply.isError).toBe(true)
    expect(text(reply)).not.toContain('Expected string, got number')
    expect(t.sources.get('s1')?.repositories).toEqual([])
    expect(t.calls.forRun(t.run.id)).toMatchObject([{ state: 'failed', scopes: ['github:read'] }])
    expect(t.providerCalls).toHaveLength(3)
  })

  it.each([{ requesterOpenId: 'bob' }, { runId: 'forged' }, { scopes: ['github:write'] }, { token: 'forged' },
    { annotations_url: 'https://attacker.example' }])('rejects extra authority/target fields at both protocol boundaries (%j)', async extra => {
    const t = await fixture()
    expect((await t.post(extra)).status).toBe(400)
    expect((await t.call(extra)).isError).toBe(true)
    expect(t.providerCalls).toEqual([])
    expect(t.sources.get('s1')?.repositories).toEqual([])
  })

  it('keeps incomplete evidence explicit and still records the repository actually read', async () => {
    const t = await fixture(); t.hooks.annotationStatus = 403
    expect(decoded(await t.call())).toMatchObject({ status: 'partial', check: { outcome: 'failed' },
      annotations: { available: false, complete: false, reason: 'permission_denied' } })
    expect(t.sources.get('s1')?.repositories).toEqual(['org/repo'])
  })

  it('returns head_changed instead of describing old-head failures as the current revision', async () => {
    const t = await fixture(); t.hooks.headChanged = true
    expect(decoded(await t.call())).toMatchObject({ status: 'head_changed', head: HEAD, currentHead: OTHER_HEAD, headCurrent: false })
    expect(t.sources.get('s1')?.repositories).toEqual(['org/repo'])
  })

  it('exposes bounded page coverage and reads the requested continuation instead of silently restarting page one', async () => {
    const t = await fixture(); t.hooks.annotations = 301
    expect(decoded(await t.call())).toMatchObject({ status: 'partial', annotations: { complete: false, nextPage: 4, reason: 'page_limit', pagesRead: 3 } })
    const continuation = decoded(await t.call({ expected_head: HEAD, annotation_page: 4 }))
    expect(continuation.annotations).toMatchObject({ complete: false, pageStart: 4, pagesRead: 1, nextPage: null, reason: 'partial_range' })
    expect(continuation.annotations.items).toHaveLength(1)
    expect(continuation.annotations.items[0]?.path.text).toBe('src/example-300.ts')
  })

  it('maps a stale selected head/check to conflict rather than a GitHub transport failure', async () => {
    const t = await fixture()
    expect((await t.post({ expected_head: OTHER_HEAD })).status).toBe(409)
    t.hooks.checkHead = OTHER_HEAD
    expect((await t.post()).status).toBe(409)
    expect(t.sources.get('s1')?.repositories).toEqual([])
  })

  it('rejects an out-of-range page as invalid input and an unauthorized repository before provider requests', async () => {
    const t = await fixture()
    expect((await t.post({ annotation_page: 10_001 })).status).toBe(400)
    expect((await t.post({ repo: 'other/repo' })).status).toBe(403)
    expect(t.providerCalls).toEqual([])
  })
})
