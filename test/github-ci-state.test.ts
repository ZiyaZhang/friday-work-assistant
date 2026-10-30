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

describe('CI meaningful stages and existing tracking facts', () => {
  function growing(t: ReturnType<typeof fixture>) {
    let completed = 1, failure = false, finalStatuses = false
    t.results = p => {
      const value = checked(p, 'pending')
      value.checks.total = 4
      value.checks.items = [1, 2, 3, 4].map(id => ({ id, name: `arbitrary-${id}`, status: id <= completed ? 'completed' : 'in_progress',
        conclusion: id > completed ? null : failure && id === 2 ? 'failure' : 'success', completedAt: id <= completed ? `t${id}` : null }))
      value.statuses = { available: true, complete: true, total: 2, items: [10, 11].map(id => ({ id, name: `other-${id}`, state: finalStatuses ? 'success' : 'pending' })) }
      return value
    }
    return { complete: (n: number) => { completed = n }, fail: () => { failure = true }, finishStatuses: () => { finalStatuses = true } }
  }
  function prepare() { const t = fixture(); t.ci.arm(t.input); t.finishSource(); t.publication = t.published(); return t }
  function doneEvents(t: ReturnType<typeof fixture>) { for (const task of t.registry.listTasks('session')) if (t.events.get(task.id)) t.registry.updateTask(task.id, { status: 'done', finishedAt: 50 }) }

  it('keeps growing successes quiet across restart, then processes the complete provider stage while another surface waits', async () => {
    const t = prepare(), progress = growing(t)
    expect(await t.ci.sweep()).toBe(0)
    progress.complete(2); t.reopen(); expect(await t.ci.sweep()).toBe(0)
    progress.complete(3); expect(await t.ci.sweep()).toBe(0)
    expect(t.wakes).toEqual([]); expect(t.ci.waitingForWork(t.workKey)).toBe(true)
    progress.complete(4); expect(await t.ci.sweep()).toBe(1)
    expect(t.ci.forTask(t.wakes[0]!)?.conclusion).toBe('checks_partially_completed')
    doneEvents(t); t.reopen(); expect(await t.ci.sweep()).toBe(0)
    progress.finishStatuses(); expect(await t.ci.sweep()).toBe(1)
    expect(t.ci.forTask(t.wakes.at(-1)!)?.conclusion).toBe('reported_checks_passed')
  })

  it('processes a new failure immediately but does not repeat it for growing successes', async () => {
    const t = prepare(), progress = growing(t)
    progress.complete(2); progress.fail(); expect(await t.ci.sweep()).toBe(1)
    expect(t.ci.forTask(t.wakes[0]!)?.conclusion).toBe('failed'); doneEvents(t)
    progress.complete(3); expect(await t.ci.sweep()).toBe(0)
    progress.complete(4); expect(await t.ci.sweep()).toBe(1)
    doneEvents(t); expect(await t.ci.sweep()).toBe(0)
  })

  it('does not call incomplete or unavailable provider enumeration a completed phase', async () => {
    const t = prepare(); t.results = p => { const r = checked(p, 'reported_checks_passed'); r.checks.complete = false; return r }
    expect(await t.ci.sweep()).toBe(0)
    t.results = p => { const r = checked(p, 'reported_checks_passed'); r.statuses.available = false; return r }
    expect(await t.ci.sweep()).toBe(0)
  })

  it('projects durable tracking after the publishing Run finished without a returned publish response', async () => {
    const t = fixture(); t.ci.arm(t.input); t.finishSource()
    const query = { repo: 'org/demo', number: 12, head }
    expect(await t.ci.trackingForWork(t.workKey, query, t.input.assertCurrent)).toMatchObject({ state: 'unavailable', head })
    t.publication = t.published(); t.reopen()
    expect(await t.ci.trackingForWork(t.workKey, query, t.input.assertCurrent)).toEqual({ state: 'tracking', head, lastCheckedAt: null })
  })

  it('never borrows another Work, another PR, an obsolete head or a stale instruction registration', async () => {
    const t = prepare(), query = { repo: 'org/demo', number: 12, head }
    expect(await t.ci.trackingForWork('task:other', query, t.input.assertCurrent)).toMatchObject({ state: 'not_registered' })
    expect(await t.ci.trackingForWork(t.workKey, { ...query, number: 99 }, t.input.assertCurrent)).toMatchObject({ state: 'not_registered' })
    expect(await t.ci.trackingForWork(t.workKey, { ...query, head: nextHead }, t.input.assertCurrent)).toMatchObject({ state: 'unavailable' })
    t.instruction()
    expect(await t.ci.trackingForWork(t.workKey, query, t.input.assertCurrent)).toMatchObject({ state: 'unavailable' })
  })

  it('rechecks the original source and caller lease after awaited authorization', async () => {
    const t = prepare(), query = { repo: 'org/demo', number: 12, head }
    t.state.access = 'denied'
    expect(await t.ci.trackingForWork(t.workKey, query, t.input.assertCurrent)).toMatchObject({ state: 'unavailable' })
    t.state.access = 'allowed'; const wait = deferred(), entered = deferred()
    t.beforeAuthorize = async () => { entered.resolve(); await wait.promise }
    let live = true
    const pending = t.ci.trackingForWork(t.workKey, query, () => { if (!live) throw new Error('request ended') })
    await entered.promise; live = false; wait.resolve()
    await expect(pending).rejects.toThrow('request ended')
  })
  it.each(['work_stop', 'head_changed', 'permission_revoked'] as const)('does not report tracking after %s during source revalidation', async change => {
    const t = prepare(), query = { repo: 'org/demo', number: 12, head }, entered = deferred(), wait = deferred()
    t.beforeAuthorize = async () => { entered.resolve(); await wait.promise }
    const pending = t.ci.trackingForWork(t.workKey, query, t.input.assertCurrent)
    await entered.promise
    if (change === 'head_changed') t.publication = t.published(tree, nextHead)
    else if (change === 'permission_revoked') t.state.access = 'denied'
    else t.registry.workContexts.control(t.workKey, { action: 'pause', reason: 'run_stop', causeRef: 'synthetic-stop' })
    wait.resolve()
    expect(await pending).toMatchObject({ state: 'unavailable' })
  })

})
