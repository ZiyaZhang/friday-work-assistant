import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { FeedbackControl } from '../src/core/feedback-control.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { IssueLinks } from '../src/github/issues.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
type Actor = { requesterOpenId?: string; runId?: string; stage: string; taskId: number }
async function setup(kind: 'group' | 'p2p' = 'group', hostConnected = true) {
  const registry = new Registry(':memory:'); cleanups.push(() => registry.close())
  const sp = spaceDeps(registry.db)
  const chatId = kind === 'group' ? 'oc_synthetic_group' : 'oc_synthetic_dm_alice'
  const space = sp.spaces.ensure({ kind, chatId, openId: 'ou_alice' })
  const bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs), routines = new RoutineStore(registry.db)
  const feedback = new FeedbackControl(registry, bugs, questions, routines)
  const feishu = new FakeFeishu(), cache = new MessageCache(registry.db)
  const log = createLogger('feedback-control-api', 'error')
  const actors = new Map<string, Actor>()
  const state = { derivedSafe: true, onResolve: undefined as (() => void) | undefined, confirm: undefined as (() => Promise<boolean>) | undefined }
  function session(key: string, owner = 'ou_alice', sessionChat = chatId, sessionKind = kind) {
    registry.createSession({ sessionKey: key, chatId: sessionChat, chatType: sessionKind, cwd: '/synthetic', requesterOpenId: owner })
    const task = registry.createTaskOnce({ sessionKey: key, requesterOpenId: owner, messageId: `om_${key}`, prompt: `合成请求 ${key}` }).task
    registry.updateTask(task.id, { status: 'running' })
    actors.set(key, { requesterOpenId: owner, runId: `run_${key}`, stage: 'task', taskId: task.id })
    return registry.getTask(task.id)!
  }
  const origin = session('origin'), controller = session('controller')
  const bucket = bugs.record({ spaceId: space.id, chatId, messageId: origin.messageId, title: '合成反馈', text: '仅合成症状，不含真实数据' }).bucket
  const resolver = (key: string) => {
    const actor = actors.get(key), task = actor && registry.getTask(actor.taskId)
    state.onResolve?.()
    return task?.status === 'running' && !task.stopReason ? actor : undefined
  }
  // Explicit application boundary: HTTP must delegate its bound run, never mutate the case directly.
  const hostStopFeedback = vi.fn<NonNullable<InternalApiDeps['stopFeedback']>>(async (key, runId, id, manageRoutines) => {
    const actor = resolver(key), current = registry.getSession(key)
    if (!actor?.requesterOpenId || actor.runId !== runId || actor.stage !== 'task' || !current) throw new Error('host current run mismatch')
    if (routines.listForFeedback(id, space.id).length && !manageRoutines) throw new Error('host routine scope missing')
    return feedback.stop({ feedbackId: id, spaceId: space.id, chatId: current.chatId, chatType: current.chatType,
      openId: actor.requesterOpenId, controllerTaskId: actor.taskId }).receipt
  })
  const githubWrites: string[] = []
  const github = { mode: 'app', repoAllowed: (repo: string) => repo === 'test-org/test-repo', repoWritable: (repo: string) => repo === 'test-org/test-repo', defaultRepo: () => 'test-org/test-repo',
    async api(method: string, path: string, _body?: unknown, _owner?: string, beforeRequest?: () => void) {
      beforeRequest?.()
      if (method !== 'GET') githubWrites.push(`${method} ${path}`)
      if (path.startsWith('/search/issues')) return { items: [] }
      return { number: 1, title: 'Synthetic', state: 'open', html_url: 'https://github.com/test-org/test-repo/issues/1', assignees: [], labels: [] }
    },
  } as unknown as GitHubIdentity
  const tokens = new TokenIssuer('synthetic-api-feedback-secret')
  const sourceGuard = vi.fn(() => state.derivedSafe)
  const api = createInternalApi({ registry, bugs, questions, routines, feedback, ...sp, appId: 'app_synthetic', feishu: asFeishuClient(feishu), messageCache: cache,
    messages: new MessageService(asFeishuClient(feishu), cache, log), memory: new ChannelMemory(registry.db), todos: new Todos(registry.db),
    tokens, log, maxHistoryPerCall: 50, resolveActorForSession: resolver, canPersistDerivedState: sourceGuard,
    stopFeedback: hostConnected ? hostStopFeedback : undefined,
    github, issueLinks: new IssueLinks(registry.db), confirm: async () => state.confirm ? state.confirm() : true,
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => { api.server.closeAllConnections(); api.server.close(error => error ? reject(error) : resolve()) }))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const cap: Omit<Capability, 'exp'> = { runId: 'run_controller', sessionKey: 'controller', spaceId: space.id, chatId, chatType: kind, requesterOpenId: 'ou_alice', cwd: '/synthetic', scopes: ['bug:write'] }
  const post = async (path: string, body: Record<string, unknown>, patch: Partial<typeof cap> = {}) => {
    const response = await fetch(`${base}/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${tokens.issue({ ...cap, ...patch })}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const snapshot = () => ['bug_buckets', 'bug_reports', 'bug_questions', 'tasks', 'routines', 'routine_occurrences'].map(table => registry.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
  const followup = (feedbackId: number | null = bucket.id) => routines.add({ kind: 'followup', feedbackId, spaceId: space.id, chatId, chatType: kind, ownerOpenId: 'ou_alice',
    sessionKey: origin.sessionKey, name: '合成后续核对', prompt: '核对本案', schedule: { type: 'once', atMs: Date.now() + 60_000 } })
  return { registry, bugs, questions, routines, feedback, feishu, ...sp, space, chatId, origin, controller, bucket, session, actors, state, sourceGuard,
    hostStopFeedback, githubWrites, tokens, cap, base, post, snapshot, followup }
}

const stopPaths = ['bug/control', 'bug/intake'] as const
const stopBody = (path: typeof stopPaths[number], id: number) => path === 'bug/control' ? { id, action: 'stop' } : { id, phase: 'cancelled' }

describe('feedback stop HTTP authorization and application delegation', () => {
  it.each(stopPaths)('%s stops with bug:write alone after a cross-source read and preserves the original report', async path => {
    const t = await setup(); t.state.derivedSafe = false
    const before = t.bugs.get(t.bucket.id), reports = t.bugs.reports(t.bucket.id)
    const result = await t.post(path, stopBody(path, t.bucket.id))
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ applied: true, feedback_id: t.bucket.id, intake_phase: 'cancelled', status: 'open', records_preserved: true, followups_paused: 0 })
    expect(t.hostStopFeedback).toHaveBeenCalledExactlyOnceWith('controller', 'run_controller', t.bucket.id, false)
    expect(t.sourceGuard).not.toHaveBeenCalled()
    expect(t.bugs.get(t.bucket.id)).toMatchObject({ ...before, intakePhase: 'cancelled', intakeUpdatedAt: expect.any(Number) })
    expect(t.bugs.reports(t.bucket.id)).toEqual(reports)
    expect(t.registry.getTask(t.origin.id)?.stopReason).toBe('user_requested')
    expect(t.registry.getTask(t.controller.id)?.stopReason).toBeNull()
    expect(t.feishu.sent).toEqual([])
  })

  it.each(stopPaths.flatMap(path => ['note', 'missing_info'].map(field => ({ path, field }))))('$path refuses $field instead of using stop to smuggle derived content', async ({ path, field }) => {
    const t = await setup(); t.state.derivedSafe = false
    const before = t.snapshot()
    expect((await t.post(path, { ...stopBody(path, t.bucket.id), [field]: field === 'note' ? '不应保存的其他群内容' : ['不应保存的缺口'] })).status).toBe(400)
    expect(t.hostStopFeedback).not.toHaveBeenCalled()
    expect(t.snapshot()).toEqual(before)
  })

  it('still rejects content edits with unsafe sources, and does not require routine scope for unrelated legacy followups', async () => {
    const t = await setup(); const legacy = t.followup(null); t.state.derivedSafe = false
    const before = t.bugs.get(t.bucket.id)
    expect((await t.post('bug/intake', { id: t.bucket.id, phase: 'awaiting_info', missing_info: ['版本'] })).status).toBe(403)
    expect(t.bugs.get(t.bucket.id)).toEqual(before)
    const result = await t.post('bug/control', { id: t.bucket.id, action: 'stop' })
    expect(result).toMatchObject({ status: 200, body: { applied: true, unbound_followup_ids: [legacy.id], followup_scope_complete: false } })
    expect(t.routines.get(legacy.id)).toEqual(legacy)
    expect(t.hostStopFeedback).toHaveBeenCalledExactlyOnceWith('controller', 'run_controller', t.bucket.id, false)
  })

  it.each(['absent_actor', 'no_run', 'reflect', 'no_host', 'no_scope'] as const)('rejects %s before applying a control operation', async boundary => {
    const t = await setup('group', boundary !== 'no_host')
    if (boundary === 'absent_actor') t.actors.delete('controller')
    if (boundary === 'no_run') t.actors.get('controller')!.runId = undefined
    if (boundary === 'reflect') t.actors.get('controller')!.stage = 'reflect'
    const before = t.snapshot()
    const result = await t.post('bug/control', { id: t.bucket.id, action: 'stop' }, boundary === 'no_scope' ? { scopes: [] } : {})
    expect([403, 503]).toContain(result.status)
    expect(t.hostStopFeedback).not.toHaveBeenCalled()
    expect(t.snapshot()).toEqual(before)
  })

  it.each(['actor', 'run', 'stage'] as const)('rejects a changed %s between HTTP capability binding and body arrival', async boundary => {
    const t = await setup()
    t.spaces.touchMember(t.space.id, 'ou_bob')
    const bound = deferred(); t.state.onResolve = bound.resolve
    const body = JSON.stringify({ id: t.bucket.id, action: 'stop' })
    let request!: ReturnType<typeof httpRequest>
    const response = new Promise<number>((resolve, reject) => {
      request = httpRequest(`${t.base}/v1/bug/control`, { method: 'POST', headers: { authorization: `Bearer ${t.tokens.issue(t.cap)}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
      request.on('error', reject); request.flushHeaders()
    })
    await bound.promise; t.state.onResolve = undefined
    const before = t.snapshot(), actor = t.actors.get('controller')!
    if (boundary === 'actor') actor.requesterOpenId = 'ou_bob'
    else if (boundary === 'run') actor.runId = 'run_replacement'
    else actor.stage = 'routine'
    request.end(body)
    expect(await response).toBe(403)
    expect(t.hostStopFeedback).not.toHaveBeenCalled()
    expect(t.snapshot()).toEqual(before)
  })

  it('rejects another space even when its sequential feedback id is known', async () => {
    const t = await setup()
    const other = t.spaces.ensure({ kind: 'group', chatId: 'oc_other', openId: 'ou_alice' })
    const bucket = t.bugs.record({ spaceId: other.id, chatId: other.chatId, title: '外部案件', text: '不可泄露内容' }).bucket
    const before = t.snapshot()
    const result = await t.post('bug/control', { id: bucket.id, action: 'stop' })
    expect(result.status).toBe(404)
    expect(JSON.stringify(result.body)).not.toContain('不可泄露内容')
    expect(t.hostStopFeedback).not.toHaveBeenCalled()
    expect(t.snapshot()).toEqual(before)
  })

  it('rejects another DM owner instead of trusting the signed token requester or model fields', async () => {
    const t = await setup('p2p')
    t.actors.get('controller')!.requesterOpenId = 'ou_bob'
    const before = t.snapshot()
    expect((await t.post('bug/control', { id: t.bucket.id, action: 'stop' })).status).toBe(403)
    expect(t.hostStopFeedback).not.toHaveBeenCalled()
    expect(t.snapshot()).toEqual(before)
  })

  it.each(['enabled', 'once_pending', 'disabled'] as const)('requires routine:write for a bound %s followup, then delegates the granted scope', async state => {
    const t = await setup(); const followup = t.followup()
    if (state === 'once_pending') t.routines.claimDueOccurrence(followup.id, followup.nextRunAt, followup.nextRunAt)
    if (state === 'disabled') t.routines.setEnabled(followup.id, false)
    const before = t.snapshot()
    expect((await t.post('bug/control', { id: t.bucket.id, action: 'stop' })).status).toBe(403)
    expect(t.hostStopFeedback).not.toHaveBeenCalled()
    expect(t.snapshot()).toEqual(before)
    const result = await t.post('bug/control', { id: t.bucket.id, action: 'stop' }, { scopes: ['bug:write', 'routine:write'] })
    expect(result).toMatchObject({ status: 200, body: { applied: true, followups_paused: 1 } })
    expect(t.hostStopFeedback).toHaveBeenCalledExactlyOnceWith('controller', 'run_controller', t.bucket.id, true)
    expect(t.routines.get(followup.id)?.enabled).toBe(false)
    if (state === 'once_pending') expect(t.routines.listOccurrences(followup.id)[0]?.status).toBe('cancelled')
  })

  it('does not resume an old evidence request after stop commits during its awaited message lookup', async () => {
    const t = await setup(); const entered = deferred(), release = deferred()
    vi.spyOn(t.feishu, 'getMessage').mockImplementation(async () => { entered.resolve(); await release.promise; return historyMsg({ messageId: 'om_evidence', chatId: t.chatId, tenantId: 'tenant_synthetic', text: '合成附件', fileKey: 'file_synthetic' }) })
    const pending = t.post('bug/evidence', { id: t.bucket.id, message_id: 'om_evidence' }, { sessionKey: 'origin', runId: 'run_origin', scopes: [...ALL_SCOPES] })
    await entered.promise
    expect((await t.post('bug/control', { id: t.bucket.id, action: 'stop' })).status).toBe(200)
    expect(t.registry.getTask(t.origin.id)?.stopReason).toBe('user_requested')
    release.resolve()
    expect((await pending).status).toBe(403)
    expect(t.bugs.anchors(t.bucket.id, t.space.id)).toEqual([])
    expect(t.bugs.evidence(t.bucket.id, t.space.id)).toEqual([])
    expect(t.feishu.downloads).toEqual([])
    expect(t.bugs.get(t.bucket.id)?.intakePhase).toBe('cancelled')
  })

  it('does not publish an old Issue request when attribution lookup returns after the related feedback was stopped', async () => {
    const t = await setup(); const entered = deferred(), release = deferred()
    vi.spyOn(t.feishu, 'chatName').mockImplementationOnce(async () => { entered.resolve(); await release.promise; return '合成反馈群' })
    const pending = t.post('github/issue/open', { repo: 'test-org/test-repo', title: '合成反馈', body: '合成建单请求' }, { sessionKey: 'origin', runId: 'run_origin', scopes: [...ALL_SCOPES] })
    await entered.promise
    expect((await t.post('bug/control', { id: t.bucket.id, action: 'stop' })).status).toBe(200)
    release.resolve()
    expect((await pending).status).toBe(403)
    expect(t.githubWrites).toEqual([])
    expect(t.bugs.get(t.bucket.id)).toMatchObject({ intakePhase: 'cancelled', issueUrl: null })
  })
})
