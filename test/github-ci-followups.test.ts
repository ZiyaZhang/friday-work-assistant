import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { TaskEvents, validTaskEventDispatch } from '../src/core/task-events.js'
import { GITHUB_CI_FOLLOWUPS_SCHEMA, GitHubCiFollowups, type CiChecks, type CiFollowupArm, type CiPublication } from '../src/github/ci-followups.js'
import type { ExecutionSourceAccessResult } from '../src/core/execution-source-access.js'

const tree = 'a'.repeat(40), head = 'b'.repeat(40), nextTree = 'c'.repeat(40), nextHead = 'd'.repeat(40)
const cleanup: (() => void)[] = []
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function checked(publication: CiPublication, status: CiChecks['status'] = 'failed'): CiChecks {
  return { repo: publication.repo, number: publication.number, url: publication.url, head: publication.head,
    currentHead: publication.head, headCurrent: true, open: true, status,
    checks: { available: true, complete: true, total: 1, items: [{ id: 1, name: 'build', status: status === 'pending' ? 'in_progress' : 'completed',
      conclusion: status === 'pending' ? null : status === 'reported_checks_passed' ? 'success' : status === 'completed_with_skips' ? 'skipped' : 'failure', url: 'https://github.com/org/demo/actions/runs/1' }] },
    statuses: { available: true, complete: true, total: 0, items: [] }, note: 'Reported checks only' }
}

/** Real SQLite, Task/Work/Run stores and TaskEvents; only GitHub/permission providers are synthetic. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-ci-followup-')), file = join(home, 'db')
  const f = {
    registry: new Registry(file), events: undefined as unknown as TaskEvents, runs: undefined as unknown as RunAttempts,
    ci: undefined as unknown as GitHubCiFollowups, publication: undefined as CiPublication | undefined,
    state: { now: 100, current: true, access: 'allowed' as ExecutionSourceAccessResult['status'], accessVersion: 1, wakeFails: false },
    reads: [] as string[], wakes: [] as number[], beforeRead: undefined as (() => Promise<void>) | undefined,
    beforeAuthorize: undefined as (() => Promise<void>) | undefined,
    results: (value: CiPublication) => checked(value),
  }
  cleanup.push(() => { f.registry.close(); rmSync(home, { recursive: true, force: true }) })
  f.registry.createSession({ sessionKey: 'session', chatId: 'chat', chatType: 'group', requesterOpenId: 'alice', cwd: '/tmp/ci-fixture' })
  const inbound = { eventId: 'event', messageId: 'human-message', chatId: 'chat', chatType: 'group' as const,
    senderOpenId: 'alice', senderType: 'user' as const, msgType: 'text', text: '完成修复并核验 PR', mentions: [], createTimeMs: 1 }
  const source = f.registry.createTaskOnce({ sessionKey: 'session', messageId: inbound.messageId, requesterOpenId: 'alice', prompt: inbound.text, inbound }).task
  const workKey = f.registry.taskWork.get(source.id)!.key
  function mount() {
    f.events = new TaskEvents(f.registry); f.runs = new RunAttempts(f.registry.db)
    f.ci = new GitHubCiFollowups({ registry: f.registry, events: f.events,
      publication: () => f.publication && { ...f.publication },
      assertHostCurrent: () => { if (!f.state.current) throw new Error('host closing') }, now: () => ++f.state.now,
      authorizeSaved: async (_proof, _origin, assertCurrent) => {
        assertCurrent(); const version = f.state.accessVersion
        await f.beforeAuthorize?.(); assertCurrent()
        const check = () => { assertCurrent(); if (version !== f.state.accessVersion) throw new Error('source changed') }
        return f.state.access === 'allowed' ? { status: 'allowed', assertCurrent: check }
          : { status: f.state.access, reason: 'synthetic-access', assertCurrent: check }
      },
      readChecks: async (publication, assertCurrent) => {
        assertCurrent(); f.reads.push(publication.changeId); await f.beforeRead?.(); assertCurrent(); return f.results(publication)
      },
      wakeQueuedTask: id => { if (f.state.wakeFails) throw new Error('crash before wake'); f.wakes.push(id) },
    })
  }
  mount()
  const run = f.runs.begin({ taskId: source.id, sessionKey: 'session', workKey, actorOpenId: 'alice', triggerKey: `task:${source.id}`, stage: 'task', now: 2 },
    () => f.registry.startTask(source.id, 2, 'session'))!
  f.runs.bindRuntime(run.id, 'acp')
  const input: CiFollowupArm = { changeId: 'change', expectedSnapshot: tree, sourceTaskId: source.id, producerTaskId: source.id, sourceRunId: run.id,
    origin: { taskId: source.id, runId: run.id, workKey, sessionKey: 'session', ownerOpenId: 'alice', spaceId: 'group:chat', chatId: 'chat', chatType: 'group' },
    provenance: { sources: { version: 1, acpSessionId: 'acp', spaceId: 'group:chat', chatId: 'chat', memoryScopes: ['space:group:chat'],
      chats: [], external: [], repositories: ['org/demo'], conversationReads: { complete: true, items: [] } }, memoryRefs: [] },
    assertCurrent: () => { if (!f.state.current) throw new Error('host closing') } }
  function published(snapshot = tree, sha = head): CiPublication {
    return { changeId: 'change', repo: 'org/demo', number: 12, url: 'https://github.com/org/demo/pull/12', head: sha,
      snapshot, workKey, sessionKey: 'session', requesterOpenId: 'alice' }
  }
  function finishSource() { f.runs.finish(run.id, 'completed', 3); f.registry.updateTask(source.id, { status: 'done', finishedAt: 3 }) }
  function reopen() { f.registry.close(); f.registry = new Registry(file); mount() }
  function instruction(text = '改按最新要求处理') {
    const messageId = `next-${f.state.now++}`, msg = { ...inbound, messageId, eventId: messageId, text }
    return f.registry.createTaskOnce({ sessionKey: 'session', messageId, requesterOpenId: 'alice', prompt: text, inbound: msg, workFromTaskId: source.id }).task
  }
  return Object.assign(f, { input, source, run, workKey, published, finishSource, reopen, instruction })
}

describe('durable PR CI followups use the original Work', () => {
  it.each(['check_run', 'commit_status'] as const)('hands a terminal %s failure to the original Work while the other provider surface is pending', async surface => {
    const t = fixture(), row = t.ci.arm(t.input); t.finishSource(); t.publication = t.published()
    t.results = p => {
      const result = checked(p)
      result.statuses = { available: true, complete: true, total: 1,
        items: [{ id: 21, name: 'independent-condition', state: surface === 'check_run' ? 'pending' : 'failure', url: undefined }] }
      if (surface === 'commit_status') { result.checks.items[0].status = 'in_progress'; result.checks.items[0].conclusion = null }
      return result
    }
    expect(await t.ci.sweep()).toBe(1)
    const id = t.ci.get(row.id)!.eventTaskId!
    expect(t.ci.forTask(id)?.conclusion).toBe('failed')
    const fresh = await t.ci.authorizeTask(id)
    expect(fresh.checks).toEqual(t.results(t.publication))
    t.registry.updateTask(id, { status: 'done', finishedAt: 10 })
    expect(t.ci.waitingForWork(t.workKey)).toBe(true)
    expect(await t.ci.sweep()).toBe(0)
  })

  it.each(['check_run', 'commit_status'] as const)('reports partial terminal %s success while still waiting, and admits the other real terminal result once', async surface => {
    const t = fixture(), row = t.ci.arm(t.input); t.finishSource(); t.publication = t.published()
    let allDone = false
    t.results = p => {
      const result = checked(p, 'reported_checks_passed')
      result.statuses = { available: true, complete: true, total: 1,
        items: [{ id: 21, name: 'arbitrary-condition', state: surface === 'commit_status' || allDone ? 'success' : 'pending', url: undefined }] }
      if (surface === 'commit_status' && !allDone) { result.checks.items[0].status = 'in_progress'; result.checks.items[0].conclusion = null }
      if (!allDone) result.status = 'pending'
      return result
    }
    expect(await t.ci.sweep()).toBe(1)
    const first = t.ci.get(row.id)!.eventTaskId!
    expect(t.ci.forTask(first)?.conclusion).toBe('checks_partially_completed')
    expect(t.registry.getTask(first)?.prompt).toContain('保留 Draft 和等待状态')
    t.registry.updateTask(first, { status: 'done', finishedAt: 10 })
    expect(t.ci.waitingForWork(t.workKey)).toBe(true)
    expect(await t.ci.sweep()).toBe(0)
    allDone = true; expect(await t.ci.sweep()).toBe(1)
    const second = t.registry.listTasks('session').find(task => task.id !== first && t.events.get(task.id)?.kind === 'github_ci')!
    expect(t.ci.forTask(second.id)?.conclusion).toBe('reported_checks_passed')
    t.registry.updateTask(second.id, { status: 'done', finishedAt: 20 })
    expect(t.ci.waitingForWork(t.workKey)).toBe(false)
    expect(await t.ci.sweep()).toBe(0)
  })

  it('does not repeat a handled failure for pending status heartbeats or provider replacement ids', async () => {
    const t = fixture(), row = t.ci.arm(t.input); t.finishSource(); t.publication = t.published()
    let statusId = 21
    t.results = p => ({ ...checked(p), statuses: { available: true, complete: true, total: 1,
      items: [{ id: statusId, name: 'external-condition', state: 'pending', url: undefined, updatedAt: `provider-version-${statusId}` }] } })
    await t.ci.sweep(); const first = t.ci.get(row.id)!.eventTaskId!
    t.registry.updateTask(first, { status: 'done', finishedAt: 10 })
    for (statusId = 22; statusId < 25; statusId++) { t.reopen(); expect(await t.ci.sweep()).toBe(0) }
    expect(t.registry.listTasks('session')).toHaveLength(2)
    expect(t.ci.waitingForWork(t.workKey)).toBe(true)
  })

  it('does not manufacture terminal evidence when a failed check starts rerunning and only an old success remains', async () => {
    const t = fixture(), row = t.ci.arm(t.input); t.finishSource(); t.publication = t.published()
    let rerunning = false, completedAgain = false
    t.results = p => {
      const result = checked(p)
      result.checks.items[0].completedAt = completedAgain ? '2026-09-23T10:10:00Z' : '2026-09-23T10:00:00Z'
      result.checks.items.push({ id: 2, name: 'other-result', status: 'completed', conclusion: 'success', url: undefined }); result.checks.total = 2
      if (rerunning) { result.status = 'pending'; result.checks.items[0].status = 'in_progress'; result.checks.items[0].conclusion = null }
      return result
    }
    await t.ci.sweep(); const first = t.ci.get(row.id)!.eventTaskId!
    rerunning = true
    const fresh = await t.ci.authorizeTask(first)
    expect(fresh.checks.status).toBe('pending')
    expect(fresh.checks.checks.items[0].conclusion).toBeNull()
    t.registry.updateTask(first, { status: 'done', finishedAt: 10 }); t.reopen()
    expect(await t.ci.sweep()).toBe(0)
    expect(t.registry.listTasks('session')).toHaveLength(2)
    expect(t.ci.waitingForWork(t.workKey)).toBe(true)
    rerunning = false; completedAgain = true
    expect(await t.ci.sweep()).toBe(1)
    expect(t.registry.listTasks('session')).toHaveLength(3)
  })

  it('continues a completed failed observation after a same-head rerun, retaining both immutable event receipts across restart', async () => {
    const t = fixture(), arm = t.ci.arm(t.input); t.finishSource(); t.publication = t.published()
    expect(await t.ci.sweep()).toBe(1)
    const first = t.ci.get(arm.id)!.eventTaskId!, original = t.ci.forTask(first)!
    t.registry.updateTask(first, { status: 'done', finishedAt: 10 })
    t.results = p => { const result = checked(p); result.status = 'pending'; result.checks.items[0] = {
      ...result.checks.items[0], id: 2, status: 'in_progress', conclusion: null }; return result }
    expect(await t.ci.sweep()).toBe(0); expect(t.ci.waitingForWork(t.workKey)).toBe(true)
    t.reopen()
    t.results = p => { const result = checked(p, 'reported_checks_passed'); result.checks.items[0].id = 2; return result }
    expect(await t.ci.sweep()).toBe(1)
    const tasks = t.registry.listTasks('session').filter(task => t.events.get(task.id)?.kind === 'github_ci')
    expect(tasks).toHaveLength(2)
    const second = tasks.find(task => task.id !== first)!
    expect(t.registry.taskWork.get(second.id)?.key).toBe(t.workKey)
    expect(t.ci.forTask(first)).toEqual({ ...original, lastCheckedAt: expect.any(Number) })
    expect(t.ci.forTask(second.id)).toMatchObject({ sourceTaskId: t.source.id, conclusion: 'reported_checks_passed' })
    expect((await t.ci.authorizeTask(second.id)).checks.checks.items[0].id).toBe(2)
    t.registry.updateTask(second.id, { status: 'done', finishedAt: 20 }); t.reopen()
    expect(await t.ci.sweep()).toBe(0)
    expect(t.ci.waitingForWork(t.workKey)).toBe(false)
    expect(t.registry.listTasks('session')).toHaveLength(3)
  })

  it('does not start a concurrent same-head worker, but retains an observation not handed to the running worker', async () => {
    const t = fixture(), row = t.ci.arm(t.input); t.finishSource(); t.publication = t.published(); await t.ci.sweep()
    const first = t.ci.get(row.id)!.eventTaskId!
    t.registry.startTask(first, 10, 'session')
    t.results = p => { const result = checked(p, 'reported_checks_passed'); result.checks.items[0].id = 2; return result }
    expect(await t.ci.sweep()).toBe(0); expect(t.registry.listTasks('session')).toHaveLength(2)
    t.registry.updateTask(first, { status: 'done', finishedAt: 20 })
    expect(await t.ci.sweep()).toBe(1)
    expect(t.registry.listTasks('session')).toHaveLength(3)
  })

  it('does not enqueue again when preflight actually handed the rerun observation to the existing queued Task', async () => {
    const t = fixture(), row = t.ci.arm(t.input); t.finishSource(); t.publication = t.published(); await t.ci.sweep()
    const first = t.ci.get(row.id)!.eventTaskId!, original = t.ci.forTask(first)
    t.results = p => { const result = checked(p, 'reported_checks_passed'); result.checks.items[0].id = 2; return result }
    expect(await t.ci.sweep()).toBe(0)
    expect((await t.ci.authorizeTask(first)).checks.checks.items[0].id).toBe(2)
    t.registry.updateTask(first, { status: 'done', finishedAt: 20 }); t.reopen()
    expect(await t.ci.sweep()).toBe(0); expect(t.registry.listTasks('session')).toHaveLength(2)
    expect(t.ci.forTask(first)).toEqual({ ...original, lastCheckedAt: expect.any(Number) })
  })

  it.each(['check_id', 'check_completion', 'status_id', 'status_update'] as const)('distinguishes a same-conclusion rerun by actual provider %s', async version => {
    const t = fixture(), row = t.ci.arm(t.input); t.finishSource(); t.publication = t.published()
    let changed = false
    t.results = p => {
      const result = checked(p, 'reported_checks_passed')
      result.checks.items[0] = { ...result.checks.items[0], id: version === 'check_id' && changed ? 2 : 1,
        completedAt: version === 'check_completion' && changed ? '2026-09-23T10:10:00Z' : '2026-09-23T10:00:00Z' }
      result.statuses = { available: true, complete: true, total: 1, items: [{ id: version === 'status_id' && changed ? 102 : 101,
        name: 'external', state: 'success', url: undefined,
        updatedAt: version === 'status_update' && changed ? '2026-09-23T10:10:00Z' : '2026-09-23T10:00:00Z' }] }
      return result
    }
    await t.ci.sweep(); const first = t.ci.get(row.id)!.eventTaskId!
    t.registry.updateTask(first, { status: 'done', finishedAt: 10 }); changed = true
    expect(await t.ci.sweep()).toBe(1)
    const second = t.registry.listTasks('session').find(task => task.id !== first && t.events.get(task.id)?.kind === 'github_ci')!
    t.registry.updateTask(second.id, { status: 'done', finishedAt: 20 }); t.reopen()
    expect(await t.ci.sweep()).toBe(0); expect(t.registry.listTasks('session')).toHaveLength(3)
  })

  it('does not turn item order, labels, URLs or newly present legacy metadata into a new run', async () => {
    const t = fixture(), row = t.ci.arm(t.input); t.finishSource(); t.publication = t.published()
    let presentationChanged = false
    t.results = p => {
      const result = checked(p, 'reported_checks_passed')
      result.checks.items.push({ ...result.checks.items[0], id: 2 }); result.checks.total = 2
      if (presentationChanged) result.checks.items = result.checks.items.reverse().map(item => ({ ...item,
        name: 'renamed', url: 'https://github.com/org/demo/actions/runs/100/attempts/999', completedAt: '2026-09-23T10:00:00Z' }))
      return result
    }
    await t.ci.sweep(); const first = t.ci.get(row.id)!.eventTaskId!
    t.registry.updateTask(first, { status: 'done', finishedAt: 10 }); presentationChanged = true
    t.reopen(); expect(await t.ci.sweep()).toBe(0)
    expect(t.registry.listTasks('session')).toHaveLength(2)
    expect(t.ci.forTask(first)?.checks?.checks.items[0]).not.toHaveProperty('completedAt')
  })

  it.each(['done', 'running'] as const)('learns missing legacy comparison fields once, then detects a real same-id rerun after restart while the old Task is %s', async status => {
    const t = fixture(), row = t.ci.arm(t.input); t.finishSource(); t.publication = t.published(); await t.ci.sweep()
    const first = t.ci.get(row.id)!.eventTaskId!, original = t.ci.forTask(first)!.checks
    if (status === 'done') t.registry.updateTask(first, { status: 'done', finishedAt: 10 })
    else t.registry.startTask(first, 10, 'session')
    let completedAt = '2026-09-23T10:00:00Z'
    t.results = p => { const result = checked(p); result.checks.items[0].completedAt = completedAt; return result }
    expect(await t.ci.sweep()).toBe(0)
    expect(t.ci.forTask(first)?.checks).toEqual(original)
    t.reopen(); completedAt = '2026-09-23T10:10:00Z'
    if (status === 'running') {
      expect(await t.ci.sweep()).toBe(0)
      t.registry.updateTask(first, { status: 'done', finishedAt: 20 })
      t.reopen()
    }
    expect(await t.ci.sweep()).toBe(1)
    expect(t.registry.listTasks('session')).toHaveLength(3)
    expect(t.ci.forTask(first)?.checks).toEqual(original)
    const second = t.registry.listTasks('session').find(task => task.id !== first && t.events.get(task.id)?.kind === 'github_ci')!
    expect(t.ci.forTask(second.id)?.checks?.checks.items[0].completedAt).toBe(completedAt)
    t.registry.updateTask(second.id, { status: 'done', finishedAt: 30 }); expect(await t.ci.sweep()).toBe(0)
  })

  it('fills legacy comparison metadata through actual preflight without allowing its older partial receipt to mask the next rerun', async () => {
    const t = fixture(), row = t.ci.arm(t.input); t.finishSource(); t.publication = t.published(); await t.ci.sweep()
    const first = t.ci.get(row.id)!.eventTaskId!
    let completedAt = '2026-09-23T10:00:00Z'
    t.results = p => { const result = checked(p); result.checks.items[0].completedAt = completedAt; return result }
    await t.ci.authorizeTask(first)
    t.registry.updateTask(first, { status: 'done', finishedAt: 10 }); t.reopen()
    expect(await t.ci.sweep()).toBe(0)
    completedAt = '2026-09-23T10:10:00Z'
    expect(await t.ci.sweep()).toBe(1)
    expect(t.ci.forTask(first)?.checks?.checks.items[0]).not.toHaveProperty('completedAt')
  })

  it('does not weaken a known comparison version when a later preflight response omits metadata', async () => {
    const t = fixture(), row = t.ci.arm(t.input); t.finishSource(); t.publication = t.published()
    let completedAt: string | undefined = '2026-09-23T10:00:00Z'
    t.results = p => { const result = checked(p); if (completedAt) result.checks.items[0].completedAt = completedAt; return result }
    await t.ci.sweep(); const first = t.ci.get(row.id)!.eventTaskId!
    completedAt = undefined; await t.ci.authorizeTask(first)
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_ci_observations').get()?.n).toBe(1)
    t.registry.updateTask(first, { status: 'done', finishedAt: 10 }); t.reopen()
    completedAt = '2026-09-23T10:10:00Z'
    expect(await t.ci.sweep()).toBe(1)
  })

  it.each(['stop', 'new_instruction', 'source', 'closed', 'unknown_publication'] as const)('does not revive a finished CI task for a newer rerun after %s', async reason => {
    const t = fixture(), row = t.ci.arm(t.input); t.finishSource(); t.publication = t.published(); await t.ci.sweep()
    const first = t.ci.get(row.id)!.eventTaskId!
    t.registry.updateTask(first, { status: 'done', finishedAt: 10 })
    t.results = p => { const result = checked(p, 'reported_checks_passed'); result.checks.items[0].id = 2; if (reason === 'closed') result.open = false; return result }
    if (reason === 'stop') t.registry.workContexts.control(t.workKey, { action: 'cancel', causeRef: 'human-stop' })
    if (reason === 'new_instruction') t.instruction()
    if (reason === 'source') t.state.access = 'unavailable'
    if (reason === 'unknown_publication') t.publication = undefined
    const count = t.registry.listTasks('session').length
    expect(await t.ci.sweep()).toBe(0); expect(t.registry.listTasks('session')).toHaveLength(count)
    if (reason === 'source') { t.state.access = 'allowed'; expect(await t.ci.sweep()).toBe(1) }
  })

  it('retires a stale second rerun event as well as the first historical event', async () => {
    const t = fixture(), row = t.ci.arm(t.input); t.finishSource(); t.publication = t.published(); await t.ci.sweep()
    const first = t.ci.get(row.id)!.eventTaskId!; t.registry.updateTask(first, { status: 'done', finishedAt: 10 })
    t.results = p => { const result = checked(p, 'reported_checks_passed'); result.checks.items[0].id = 2; return result }
    await t.ci.sweep()
    const second = t.registry.listTasks('session').find(task => task.id !== first && t.events.get(task.id)?.kind === 'github_ci')!
    t.instruction(); await t.ci.sweep()
    expect(t.registry.getTask(first)?.status).toBe('done')
    expect(t.registry.getTask(second.id)).toMatchObject({ status: 'cancelled', stopReason: 'input_superseded' })
    expect(() => t.ci.lease(second.id)()).toThrow()
  })

  it('arms before publication, survives a real database reopen, admits one bot evidence Task and preserves the source snapshot', async () => {
    const t = fixture(), row = t.ci.arm(t.input)
    expect(t.ci.arm(t.input).id).toBe(row.id)
    t.input.provenance.sources.repositories.push('not-in-original-proof')
    expect(t.ci.get(row.id)?.provenance.sources.repositories).toEqual(['org/demo'])
    expect(await t.ci.sweep()).toBe(0); expect(t.reads).toEqual([])
    t.finishSource(); t.publication = t.published(); t.reopen()
    expect(await t.ci.sweep()).toBe(1)
    const saved = t.ci.get(row.id)!, task = t.registry.getTask(saved.eventTaskId!)!
    expect(t.registry.taskWork.get(task.id)?.key).toBe(t.workKey)
    expect(t.registry.workContexts.inputs(t.workKey).at(-1)?.kind).toBe('evidence')
    const dispatch = t.registry.dispatches.get(task.id)!
    expect(dispatch.inbound.senderType).toBe('bot')
    expect(validTaskEventDispatch(t.registry.db, task.id, dispatch.inbound)).toBe(true)
    expect(t.ci.forTask(task.id)?.sourceTaskId).toBe(t.source.id)
    expect(await t.ci.sweep()).toBe(0); expect(t.registry.listTasks('session')).toHaveLength(2)
    expect(t.wakes).toEqual([task.id, task.id])
    expect((await t.ci.authorizeTask(task.id)).record.head).toBe(head)
  })

  it.each(['reported_checks_passed', 'completed_with_skips'] as const)('hands %s back to the worker for remaining verification, without completing the Work', async status => {
    const t = fixture(); t.results = p => checked(p, status); const row = t.ci.arm(t.input); t.publication = t.published()
    expect(await t.ci.sweep()).toBe(1)
    const saved = t.ci.get(row.id)!, task = t.registry.getTask(saved.eventTaskId!)!
    expect(saved.conclusion).toBe(status); expect(task.prompt).toContain('视觉和行为验收')
    expect(t.registry.workContexts.get(t.workKey)?.lifecycle).toBe('open')
  })

  it.each(['pending', 'no_checks', 'unavailable', 'partial', 'head_changed', 'closed'] as const)('does not admit %s as complete CI evidence', async scenario => {
    const t = fixture(); t.ci.arm(t.input); t.publication = t.published()
    t.results = p => {
      const result = checked(p)
      if (scenario === 'pending') {
        result.checks.items.push({ id: 2, name: 'later', status: 'in_progress', conclusion: null, url: '' }); result.checks.total = 2
        result.status = 'pending'; result.checks.items[0]!.status = 'in_progress'; result.checks.items[0]!.conclusion = null
      } else if (scenario === 'no_checks') { result.checks.items = []; result.checks.total = 0; result.status = 'no_checks' }
      else if (scenario === 'unavailable') { result.statuses.available = false; result.status = 'unavailable' }
      else if (scenario === 'partial') result.checks.complete = false
      else if (scenario === 'head_changed') { result.headCurrent = false; result.currentHead = nextHead; result.status = 'head_changed' }
      else result.open = false
      return result
    }
    expect(await t.ci.sweep()).toBe(0); expect(t.wakes).toEqual([])
  })

  it('recovers transient provider and source failures without a retry cutoff or duplicate event', async () => {
    const t = fixture(), row = t.ci.arm(t.input); t.publication = t.published()
    t.beforeRead = async () => { throw new Error('network unavailable') }
    for (let i = 0; i < 4; i++) expect(await t.ci.sweep()).toBe(0)
    t.beforeRead = undefined; t.state.access = 'unavailable'; expect(await t.ci.sweep()).toBe(0)
    t.state.access = 'allowed'; expect(await t.ci.sweep()).toBe(1)
    expect(t.ci.get(row.id)?.eventTaskId).toBeTruthy()
  })

  it('keeps an admitted event and wakes it after restart when the process failed before wake', async () => {
    const t = fixture(), row = t.ci.arm(t.input); t.publication = t.published(); t.state.wakeFails = true
    await t.ci.sweep(); const taskId = t.ci.get(row.id)!.eventTaskId!
    expect(taskId).toBeTruthy(); expect(t.wakes).toEqual([])
    t.reopen(); t.state.wakeFails = false; await t.ci.sweep()
    expect(t.ci.get(row.id)?.eventTaskId).toBe(taskId); expect(t.wakes).toEqual([taskId])
  })

  it.each(['cancel', 'pause', 'new_instruction', 'archive', 'head', 'source'] as const)('rejects %s during an awaited read and does not revive the request', async change => {
    const t = fixture(); t.ci.arm(t.input); t.publication = t.published()
    const blocked = deferred(), entered = deferred(); t.beforeRead = async () => { entered.resolve(); await blocked.promise }
    const polling = t.ci.sweep(); await entered.promise
    if (change === 'cancel') t.registry.workContexts.control(t.workKey, { action: 'cancel', causeRef: 'user' })
    if (change === 'pause') t.registry.workContexts.control(t.workKey, { action: 'pause', reason: 'run_stop', causeRef: 'user' })
    if (change === 'new_instruction') t.instruction()
    if (change === 'archive') t.registry.updateSession('session', { status: 'archived' })
    if (change === 'head') t.publication = t.published(tree, nextHead)
    if (change === 'source') t.state.accessVersion++
    blocked.resolve(); expect(await polling).toBe(0); expect(t.wakes).toEqual([])
  })

  it('does not let an already queued event survive a new instruction, unknown update, or changed head', async () => {
    const t = fixture(), row = t.ci.arm(t.input); t.publication = t.published(); await t.ci.sweep()
    const taskId = t.ci.get(row.id)!.eventTaskId!, lease = t.ci.lease(taskId)
    lease(); t.publication = undefined; expect(lease).toThrow(expect.objectContaining({ code: 'publication_pending' }))
    t.publication = t.published(tree, nextHead); expect(lease).toThrow(expect.objectContaining({ code: 'binding_changed' }))
    t.publication = t.published(); lease(); t.instruction(); expect(lease).toThrow()
    await expect(t.ci.authorizeTask(taskId)).rejects.toThrow(); expect(await t.ci.sweep()).toBe(0)
    expect(t.registry.getTask(taskId)).toMatchObject({ status: 'cancelled', stopReason: 'input_superseded' })
  })

  it('records the second bot producer Run separately from the original human and only observes its new confirmed head', async () => {
    const t = fixture(), first = t.ci.arm(t.input); t.finishSource(); t.publication = t.published(); await t.ci.sweep()
    const taskId = t.ci.get(first.id)!.eventTaskId!, task = t.registry.getTask(taskId)!
    let admittedRunId: string | undefined
    const preflight = await t.ci.authorizeTask(taskId, () => admittedRunId)
    const run = t.runs.begin({ taskId, sessionKey: 'session', workKey: t.workKey, actorOpenId: 'alice', triggerKey: `task:${taskId}`, stage: 'task', now: 20 },
      () => t.registry.startTask(taskId, 20, 'session'))!
    t.runs.bindRuntime(run.id, 'acp')
    admittedRunId = run.id; preflight.assertCurrent()
    const runLease = t.ci.lease(taskId, run.id), queuedLease = t.ci.lease(taskId)
    runLease(); const authorized = await t.ci.authorizeTask(taskId, run.id)
    const second = t.ci.arm({ ...t.input, expectedSnapshot: nextTree, producerTaskId: taskId, sourceRunId: run.id,
      origin: { ...t.input.origin, taskId, runId: run.id } })
    expect(second.sourceTaskId).toBe(t.source.id); expect(second.producerTaskId).toBe(taskId)
    expect(second.instructionSeq).toBe(first.instructionSeq)
    t.publication = undefined; runLease(); authorized.assertCurrent(); preflight.assertCurrent(); expect(queuedLease).toThrow()
    expect(t.ci.lease(taskId, t.run.id)).toThrow()
    expect(await t.ci.sweep()).toBe(0)
    t.publication = t.published(nextTree, nextHead); expect(await t.ci.sweep()).toBe(1)
    runLease(); authorized.assertCurrent(); preflight.assertCurrent(); expect(queuedLease).toThrow()
    const next = t.ci.get(second.id)!
    expect(next.head).toBe(nextHead); expect(next.eventTaskId).not.toBe(taskId)
    expect(t.events.get(next.eventTaskId!)?.sourceTaskId).toBe(t.source.id)
    expect(t.registry.taskWork.get(next.eventTaskId!)?.key).toBe(t.workKey)
    t.publication = t.published('e'.repeat(40), 'f'.repeat(40)); expect(runLease).toThrow()
    t.publication = t.published(nextTree, nextHead); runLease()
    t.runs.finish(run.id, 'completed', 30); expect(runLease).toThrow()
  })

  it('does not accept a forged human authority, another Work or a mismatched producer Run', () => {
    const t = fixture()
    expect(() => t.ci.arm({ ...t.input, producerTaskId: 987 })).toThrow()
    expect(() => t.ci.arm({ ...t.input, origin: { ...t.input.origin, workKey: 'task:987' } })).toThrow()
    t.registry.db.prepare("UPDATE task_dispatches SET inbound=json_set(inbound,'$.senderType','bot') WHERE task_id=?").run(t.source.id)
    expect(() => t.ci.arm(t.input)).toThrow()
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM github_ci_followups').get()!.n).toBe(0)
  })

  it('cycles unavailable publication rows fairly and treats a zero poll budget as disabled', async () => {
    const t = fixture(), first = t.ci.arm(t.input), second = t.ci.arm({ ...t.input, changeId: 'another' })
    expect(await t.ci.sweep(0)).toBe(0); expect(t.ci.get(first.id)?.lastCheckedAt).toBe(0)
    await t.ci.sweep(1); const firstTime = t.ci.get(first.id)!.lastCheckedAt
    await t.ci.sweep(1)
    expect(t.ci.get(first.id)?.lastCheckedAt).toBe(firstTime); expect(t.ci.get(second.id)!.lastCheckedAt).toBeGreaterThan(firstTime)
  })

  it('distinguishes temporary checks from a closed PR and keeps the original observation when a same-head rerun succeeds', async () => {
    const t = fixture(), row = t.ci.arm(t.input); t.publication = t.published(); await t.ci.sweep()
    const taskId = t.ci.get(row.id)!.eventTaskId!
    t.results = p => checked(p, 'pending')
    await expect(t.ci.authorizeTask(taskId)).rejects.toMatchObject({ code: 'checks_pending' })
    t.results = p => ({ ...checked(p), open: false })
    await expect(t.ci.authorizeTask(taskId)).rejects.toMatchObject({ code: 'pr_closed' })
    t.results = p => checked(p, 'reported_checks_passed'); await t.ci.sweep()
    const result = await t.ci.authorizeTask(taskId)
    expect(result.record.conclusion).toBe('failed'); expect(result.checks.status).toBe('reported_checks_passed')
    expect(t.registry.listTasks('session')).toHaveLength(2)
  })

  it('commits the event and observation atomically when Task admission throws after writing its own rows', async () => {
    const t = fixture(), row = t.ci.arm(t.input); t.publication = t.published()
    const original = t.events.admit.bind(t.events)
    t.events.admit = input => { original(input); throw new Error('synthetic failure after event admission') }
    expect(await t.ci.sweep()).toBe(0); expect(t.ci.get(row.id)?.eventTaskId).toBeNull()
    expect(t.registry.listTasks('session')).toHaveLength(1)
    t.events.admit = original; expect(await t.ci.sweep()).toBe(1)
    expect(t.registry.listTasks('session')).toHaveLength(2)
  })

  it('projects only a published current Work as waiting and removes closed/head-changed or handed-off checks', async () => {
    const t = fixture(); t.ci.arm(t.input)
    expect(t.ci.waitingForWork(t.workKey)).toBe(false)
    t.publication = t.published(); expect(t.ci.waitingForWork(t.workKey)).toBe(true)
    t.results = p => checked(p, 'pending'); await t.ci.sweep()
    expect(t.ci.waitingForWork(t.workKey)).toBe(true)
    t.results = p => ({ ...checked(p), open: false }); await t.ci.sweep()
    expect(t.ci.waitingForWork(t.workKey)).toBe(false)
    t.results = p => ({ ...checked(p), currentHead: nextHead, headCurrent: false }); await t.ci.sweep()
    expect(t.ci.waitingForWork(t.workKey)).toBe(false)
    t.results = p => checked(p); await t.ci.sweep()
    expect(t.ci.waitingForWork(t.workKey)).toBe(false)
  })

  it.each(['pending_update', 'network', 'source_unavailable', 'closed', 'new_head'] as const)('keeps temporary queued %s recoverable, but retires definitive stale events', async reason => {
    const t = fixture(), row = t.ci.arm(t.input); t.publication = t.published(); await t.ci.sweep()
    const taskId = t.ci.get(row.id)!.eventTaskId!
    if (reason === 'pending_update') t.publication = undefined
    if (reason === 'network') t.beforeRead = async () => { throw new Error('ECONNRESET') }
    if (reason === 'source_unavailable') t.state.access = 'unavailable'
    if (reason === 'closed') t.results = p => ({ ...checked(p), open: false })
    if (reason === 'new_head') t.publication = t.published(tree, nextHead)
    await t.ci.sweep()
    expect(t.registry.getTask(taskId)?.status).toBe(['closed', 'new_head'].includes(reason) ? 'cancelled' : 'queued')
  })

  it('admits an explicit human continuation of the same Work/tree after an armed publication failed, preserving the original source', async () => {
    const t = fixture(), original = t.ci.arm(t.input)
    const oldProof = t.registry.db.prepare('SELECT origin_json,provenance_json FROM github_ci_followups WHERE id=?').get(original.id)
    t.runs.finish(t.run.id, 'failed', 3); t.registry.updateTask(t.source.id, { status: 'failed', finishedAt: 3 })
    expect(() => t.ci.arm(t.input)).toThrow()
    const task = t.instruction('继续刚才的发布，保留已有修改')
    const run = t.runs.begin({ taskId: task.id, sessionKey: 'session', workKey: t.workKey, actorOpenId: 'alice',
      triggerKey: `task:${task.id}`, stage: 'task', now: 5 }, () => t.registry.startTask(task.id, 5, 'session'))!
    t.runs.bindRuntime(run.id, 'acp-new')
    const input = { ...t.input, sourceTaskId: task.id, producerTaskId: task.id, sourceRunId: run.id,
      origin: { ...t.input.origin, taskId: task.id, runId: run.id },
      provenance: { ...t.input.provenance, sources: { ...t.input.provenance.sources, acpSessionId: 'acp-new' } } }
    const fresh = t.ci.arm(input)
    expect(fresh.id).not.toBe(original.id); expect(fresh.expectedSnapshot).toBe(original.expectedSnapshot)
    expect(fresh.instructionSeq).toBeGreaterThan(original.instructionSeq)
    expect(t.ci.arm(input).id).toBe(fresh.id)
    expect(t.registry.db.prepare('SELECT origin_json,provenance_json FROM github_ci_followups WHERE id=?').get(original.id)).toEqual(oldProof)
    t.reopen(); expect(t.ci.arm(input).id).toBe(fresh.id)
    t.publication = t.published(); expect(await t.ci.sweep()).toBe(1)
    expect(t.ci.get(original.id)?.eventTaskId).toBeNull()
    expect(t.events.get(t.ci.get(fresh.id)!.eventTaskId!)?.sourceTaskId).toBe(task.id)
  })

  it('separates an explicit pause/resume authority revision without allowing a paused background arm', async () => {
    const t = fixture(), original = t.ci.arm(t.input)
    t.runs.finish(t.run.id, 'failed', 3); t.registry.updateTask(t.source.id, { status: 'failed', finishedAt: 3 })
    t.registry.workContexts.control(t.workKey, { action: 'pause', reason: 'manual', causeRef: 'human-pause' })
    expect(() => t.ci.arm(t.input)).toThrow(); expect(await t.ci.sweep()).toBe(0)
    t.registry.workContexts.control(t.workKey, { action: 'resume', reason: 'manual', causeRef: 'human-pause' })
    expect(t.registry.dispatches.resume(t.source.id, { previousRunId: t.run.id, reason: 'restart' }, 5)).toBe(true)
    const run = t.runs.begin({ taskId: t.source.id, sessionKey: 'session', workKey: t.workKey, actorOpenId: 'alice',
      triggerKey: `task:${t.source.id}:resume:1`, stage: 'task', now: 5 }, () => t.registry.startTask(t.source.id, 5, 'session'))!
    t.runs.bindRuntime(run.id, 'acp-resumed')
    const input = { ...t.input, sourceRunId: run.id, origin: { ...t.input.origin, runId: run.id },
      provenance: { ...t.input.provenance, sources: { ...t.input.provenance.sources, acpSessionId: 'acp-resumed' } } }
    const fresh = t.ci.arm(input)
    expect(fresh.id).not.toBe(original.id); expect(fresh.controlEpoch).toBeGreaterThan(original.controlEpoch)
    expect(fresh.instructionSeq).toBe(original.instructionSeq)
    expect(t.ci.arm(input).id).toBe(fresh.id)
    t.publication = t.published(); expect(await t.ci.sweep()).toBe(1)
  })

  it('reuses the original immutable record when a failed Run resumes without changing human authority', () => {
    const t = fixture(), original = t.ci.arm(t.input)
    t.runs.finish(t.run.id, 'failed', 3); t.registry.updateTask(t.source.id, { status: 'failed', finishedAt: 3 })
    expect(() => t.ci.arm(t.input)).toThrow()
    expect(t.registry.dispatches.resume(t.source.id, { previousRunId: t.run.id, reason: 'restart' }, 5)).toBe(true)
    const run = t.runs.begin({ taskId: t.source.id, sessionKey: 'session', workKey: t.workKey, actorOpenId: 'alice',
      triggerKey: `task:${t.source.id}:resume:1`, stage: 'task', now: 5 }, () => t.registry.startTask(t.source.id, 5, 'session'))!
    t.runs.bindRuntime(run.id, 'acp-resumed')
    const again = t.ci.arm({ ...t.input, sourceRunId: run.id, origin: { ...t.input.origin, runId: run.id },
      provenance: { ...t.input.provenance, sources: { ...t.input.provenance.sources, acpSessionId: 'acp-resumed' } } })
    expect(again).toEqual(original)
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM github_ci_followups').get()!.n).toBe(1)
  })

  it('does not emit the same confirmed-head event again after a new human authorization', async () => {
    const t = fixture(), original = t.ci.arm(t.input); t.publication = t.published(); await t.ci.sweep()
    const eventTask = t.ci.get(original.id)!.eventTaskId!
    t.finishSource(); const task = t.instruction('继续核验现有 PR，不改代码')
    const run = t.runs.begin({ taskId: task.id, sessionKey: 'session', workKey: t.workKey, actorOpenId: 'alice',
      triggerKey: `task:${task.id}`, stage: 'task', now: 5 }, () => t.registry.startTask(task.id, 5, 'session'))!
    t.runs.bindRuntime(run.id, 'acp')
    const fresh = t.ci.arm({ ...t.input, sourceTaskId: task.id, producerTaskId: task.id, sourceRunId: run.id,
      origin: { ...t.input.origin, taskId: task.id, runId: run.id } })
    expect(await t.ci.sweep()).toBe(0)
    expect(t.ci.get(original.id)?.eventTaskId).toBe(eventTask); expect(t.ci.get(fresh.id)?.eventTaskId).toBeNull()
    expect(t.ci.waitingForWork(t.workKey)).toBe(false)
    expect(t.registry.db.prepare("SELECT COUNT(*) AS n FROM task_event_sources WHERE kind='github_ci'").get()!.n).toBe(1)
  })

  it('upgrades the former two-column unique key twice without rewriting source ids, event bindings or existing row bytes', async () => {
    const t = fixture(), first = t.ci.arm(t.input), legacyId = 'legacy-ci-record'
    t.registry.db.prepare('UPDATE github_ci_followups SET id=? WHERE id=?').run(legacyId, first.id)
    t.publication = t.published(); await t.ci.sweep()
    const taskId = t.ci.get(legacyId)!.eventTaskId!, event = t.events.get(taskId)!
    const before = t.registry.db.prepare('SELECT * FROM github_ci_followups ORDER BY rowid').all().map(row => ({ ...row, latest_checks_json: null }))
    const oldSchema = GITHUB_CI_FOLLOWUPS_SCHEMA.replace('UNIQUE(change_id,expected_snapshot,control_epoch,instruction_seq)', 'UNIQUE(change_id,expected_snapshot)')
      .replace(', latest_checks_json TEXT', '')
    const oldColumns = 'id,change_id,expected_snapshot,source_task_id,producer_task_id,source_run_id,origin_json,provenance_json,control_epoch,instruction_seq,created_at,last_checked_at,head,conclusion,checks_json,event_task_id'
    t.registry.db.exec(`SAVEPOINT test_previous_ci_schema;
      DROP TABLE github_ci_observations;
      ALTER TABLE github_ci_followups RENAME TO ci_rows_before_downgrade;
      DROP INDEX idx_github_ci_followups_poll; DROP INDEX idx_github_ci_followups_event;`)
    t.registry.db.exec(oldSchema)
    t.registry.db.exec(`INSERT INTO github_ci_followups(${oldColumns}) SELECT ${oldColumns} FROM ci_rows_before_downgrade;
      DROP TABLE ci_rows_before_downgrade; RELEASE test_previous_ci_schema;`)
    for (let pass = 0; pass < 2; pass++) {
      t.reopen()
      expect(t.registry.db.prepare('SELECT * FROM github_ci_followups ORDER BY rowid').all()).toEqual(before)
      expect(t.events.get(taskId)).toEqual(event)
      expect(t.ci.arm(t.input).id).toBe(legacyId)
      t.ci.lease(taskId)()
      expect(t.registry.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    }
    const keys = t.registry.db.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique"=1').all('github_ci_followups')
      .map(index => t.registry.db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(String(index.name)).map(column => column.name))
    expect(keys).toContainEqual(['change_id', 'expected_snapshot', 'control_epoch', 'instruction_seq'])
    expect(keys).not.toContainEqual(['change_id', 'expected_snapshot'])
    expect(t.registry.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='github_ci_followups_previous'").get()!.n).toBe(0)
  })

  it('upgrades the previous four-column candidate twice, preserves its old Task event key and does not reissue its observation', async () => {
    const t = fixture(), first = t.ci.arm(t.input); t.finishSource(); t.publication = t.published(); await t.ci.sweep()
    const id = t.ci.get(first.id)!.eventTaskId!, event = t.events.get(id)!, checks = t.ci.forTask(id)!.checks
    t.registry.db.exec(`DROP TABLE github_ci_observations;
      ALTER TABLE github_ci_followups DROP COLUMN latest_checks_json;
      DROP INDEX idx_github_ci_followups_event;
      CREATE UNIQUE INDEX idx_github_ci_followups_event ON github_ci_followups(change_id,head) WHERE event_task_id IS NOT NULL;`)
    const before = t.registry.db.prepare('SELECT * FROM github_ci_followups').get()!
    for (let pass = 0; pass < 2; pass++) {
      t.reopen()
      const { latest_checks_json, ...preserved } = t.registry.db.prepare('SELECT * FROM github_ci_followups').get()!
      expect(preserved).toEqual(before); expect(latest_checks_json).toBeNull()
      expect(t.events.get(id)).toEqual(event)
      expect(t.ci.forTask(id)?.checks).toEqual(checks); t.ci.lease(id)()
      expect(t.registry.db.prepare('SELECT count(*) AS n FROM github_ci_observations').get()?.n).toBe(1)
      expect(t.registry.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    }
    t.registry.updateTask(id, { status: 'done', finishedAt: 20 })
    expect(await t.ci.sweep()).toBe(0)
    t.results = p => { const result = checked(p); result.checks.items[0].id = 2; return result }
    expect(await t.ci.sweep()).toBe(1)
  })
})
