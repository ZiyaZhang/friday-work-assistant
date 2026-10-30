import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ensureDeliverySchema } from '../src/core/delivery.js'
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

describe('explicit human CI continuation control', () => {
  function prepare() { const t = fixture(); const old = t.ci.arm(t.input); t.finishSource(); t.publication = t.published(); return Object.assign(t, { old }) }
  function human(t: ReturnType<typeof fixture>, text = '按原要求继续，完成后告诉我') {
    const task = t.instruction(text)
    const run = t.runs.begin({ taskId: task.id, sessionKey: 'session', workKey: t.workKey, actorOpenId: 'alice', triggerKey: `task:${task.id}`, stage: 'task', now: 200 },
      () => t.registry.startTask(task.id, 200, 'session'))!
    t.runs.bindRuntime(run.id, 'control-acp')
    return { taskId: task.id, runId: run.id, workKey: t.workKey, sessionKey: 'session', ownerOpenId: 'alice', assertCurrent: t.input.assertCurrent }
  }
  it('requires an explicit real human continuation and retains original proof while advancing the instruction version', async () => {
    const t = prepare(), actor = human(t)
    expect(await t.ci.trackingForWork(t.workKey, {repo:'org/demo',number:12,head},actor.assertCurrent)).toMatchObject({state:'unavailable'})
    const result = await t.ci.control(actor, {changeId:'change',expectedHead:head,action:'continue',notification:'completion'})
    expect(result).toMatchObject({state:'tracking',policy:{handling:'repair',notification:'completion'}})
    const next = t.ci.get(result.id)!
    expect(next.provenance).toEqual(t.old.provenance); expect(next.origin).toEqual(t.old.origin)
    expect(next.instructionSeq).toBe(2)
    expect(await t.ci.trackingForWork(t.workKey,{repo:'org/demo',number:12,head},actor.assertCurrent)).toMatchObject({state:'tracking'})
    t.registry.updateTask(actor.taskId,{status:'done'}); t.runs.finish(actor.runId,'completed',201)
    expect(await t.ci.sweep()).toBe(1)
  })
  it('projects a host Work stop without forging a model control or reviving it after restart', async () => {
    const t = prepare(), before = t.registry.workContexts.get(t.workKey)!
    t.registry.workContexts.control(t.workKey, { action: 'pause', reason: 'run_stop', causeRef: 'ingress:real-stop' })
    expect(await t.ci.trackingForWork(t.workKey, {repo:'org/demo',number:12,head}, t.input.assertCurrent))
      .toMatchObject({state:'stopped',stopReason:'work_stopped'})
    expect(t.ci.get(t.old.id)).toEqual(t.old)
    expect(t.registry.workContexts.get(t.workKey)!.controlEpoch).toBeGreaterThan(before.controlEpoch)
    t.reopen()
    expect(await t.ci.sweep()).toBe(0)
    expect(t.ci.waitingForWork(t.workKey)).toBe(false)
    expect(await t.ci.trackingForWork(t.workKey, {repo:'org/demo',number:12,head}, t.input.assertCurrent)).toMatchObject({state:'stopped'})
    const actor = human(t)
    expect(t.registry.workContexts.get(t.workKey)!.pauseReasons).toEqual([])
    expect(await t.ci.sweep()).toBe(0)
    expect(await t.ci.trackingForWork(t.workKey, {repo:'org/demo',number:12,head}, t.input.assertCurrent)).toMatchObject({state:'unavailable'})
    await t.ci.control(actor,{changeId:'change',expectedHead:head,action:'continue'})
    t.registry.updateTask(actor.taskId,{status:'done'});t.runs.finish(actor.runId,'completed',201)
    expect(await t.ci.sweep()).toBe(1)
  })
  it.each(['none','started','planned','unknown','sent','confirmed'] as const)('reauthorizes a never-started stopped event only without prior Run or delivery (%s)', async prior => {
    const t=prepare();expect(await t.ci.sweep()).toBe(1)
    const event=t.registry.getTask(t.wakes[0]!)!
    if(prior==='started'){
      const run=t.runs.begin({taskId:event.id,sessionKey:'session',workKey:t.workKey,actorOpenId:'alice',triggerKey:`task:${event.id}`,stage:'task',now:10},()=>t.registry.startTask(event.id,10,'session'))!
      t.runs.finish(run.id,'cancelled',11,'user_requested')
      t.registry.updateTask(event.id,{status:'cancelled',stopReason:'user_requested'})
    }else t.registry.cancelQueuedTask(event.id,10)
    if(!['none','started'].includes(prior)){
      ensureDeliverySchema(t.registry.db)
      t.registry.db.prepare(`INSERT INTO deliveries(delivery_key,context_ref,signature,status,actor_open_id,audience,source_refs,grant_ids,payload_digest,remote_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(`task:${event.id}:final:0`,`task:${event.id}:session:session`,'synthetic-signature',prior,'alice','{}','[]','[]','synthetic-digest',prior==='sent'||prior==='confirmed'?'synthetic-remote':null,10,10)
    }
    t.registry.workContexts.control(t.workKey,{action:'pause',reason:'run_stop',causeRef:'ingress:queued-stop'})
    expect(await t.ci.sweep()).toBe(0)
    const actor=human(t)
    expect(await t.ci.sweep()).toBe(0)
    await t.ci.control(actor,{changeId:'change',expectedHead:head,action:'continue'})
    t.registry.updateTask(actor.taskId,{status:'done'});t.runs.finish(actor.runId,'completed',201)
    expect(await t.ci.sweep()).toBe(prior==='none'?1:0)
    expect(await t.ci.sweep()).toBe(0)
    expect(t.registry.getTask(event.id)?.status).toBe('cancelled')
  })
  it('does not return tracking when a host stop lands during its source authorization await', async () => {
    const t = prepare()
    t.beforeAuthorize=async()=>{t.registry.workContexts.control(t.workKey,{action:'pause',reason:'run_stop',causeRef:'ingress:during-read'})}
    expect(await t.ci.trackingForWork(t.workKey,{repo:'org/demo',number:12,head},t.input.assertCurrent)).toMatchObject({state:'unavailable'})
    expect(await t.ci.sweep()).toBe(0)
  })
  it('does not borrow an invalid origin or another Work to project a stopped publication', async () => {
    const t = prepare()
    t.registry.workContexts.control(t.workKey, {action:'pause',reason:'run_stop',causeRef:'ingress:stop'})
    t.state.access='denied'
    expect(await t.ci.trackingForWork(t.workKey,{repo:'org/demo',number:12,head},t.input.assertCurrent)).toMatchObject({state:'stopped'})
    expect(await t.ci.trackingForWork('task:other',{repo:'org/demo',number:12,head},t.input.assertCurrent)).toMatchObject({state:'not_registered'})
    t.registry.db.prepare('UPDATE work_contexts SET authority_open_id=? WHERE work_key=?').run('bob',t.workKey)
    expect(await t.ci.trackingForWork(t.workKey,{repo:'org/demo',number:12,head},t.input.assertCurrent)).toMatchObject({state:'unavailable'})
  })
  it('does not renew from a system event or borrow another Work', async () => {
    const t = prepare(); await t.ci.sweep(); const eventTask = t.registry.getTask(t.wakes[0]!)!
    const run = t.runs.begin({taskId:eventTask.id,sessionKey:'session',workKey:t.workKey,actorOpenId:'alice',triggerKey:`task:${eventTask.id}`,stage:'task',now:200},()=>t.registry.startTask(eventTask.id,200,'session'))!
    await expect(t.ci.control({taskId:eventTask.id,runId:run.id,workKey:t.workKey,sessionKey:'session',ownerOpenId:'alice',assertCurrent:t.input.assertCurrent},
      {changeId:'change',expectedHead:head,action:'continue',handling:'repair'})).rejects.toThrow()
    t.runs.finish(run.id,'completed',201); t.registry.updateTask(eventTask.id,{status:'done'})
    const actor = human(t)
    await expect(t.ci.control({...actor,workKey:'task:other'},{changeId:'change',expectedHead:head,action:'continue'})).rejects.toThrow()
  })
  it('persists stop without resuming it at restart, and only a later real human continue may renew', async () => {
    const t = prepare(), actor=human(t)
    const result=await t.ci.control(actor,{changeId:'change',expectedHead:head,action:'stop'})
    expect(result.state).toBe('stopped'); t.reopen()
    expect(await t.ci.sweep()).toBe(0)
    expect(await t.ci.trackingForWork(t.workKey,{repo:'org/demo',number:12,head},actor.assertCurrent)).toMatchObject({state:'stopped'})
    t.runs.finish(actor.runId,'completed',201);t.registry.updateTask(actor.taskId,{status:'done'})
    const next=human(t)
    expect(await t.ci.control(next,{changeId:'change',expectedHead:head,action:'continue'})).toMatchObject({state:'tracking'})
  })
  it.each(['source','new_input','head','pause'] as const)('does not persist continuation after %s changes across authorization await',async change=>{
    const t=prepare(),actor=human(t),entered=deferred(),release=deferred()
    t.beforeAuthorize=async()=>{entered.resolve();await release.promise}
    const pending=t.ci.control(actor,{changeId:'change',expectedHead:head,action:'continue'})
    await entered.promise
    if(change==='source')t.state.accessVersion++
    else if(change==='new_input')t.instruction()
    else if(change==='head')t.publication=t.published(tree,nextHead)
    else t.registry.workContexts.control(t.workKey,{action:'pause',reason:'run_stop',causeRef:'human'})
    release.resolve();await expect(pending).rejects.toThrow()
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_ci_followups').get()?.n).toBe(1)
  })
  it('does not consume a queued cancelled observation forever, but does not repeat a completed observation',async()=>{
    const t=prepare(); await t.ci.sweep(); const queued=t.wakes[0]!
    const actor=human(t);await t.ci.control(actor,{changeId:'change',expectedHead:head,action:'continue'})
    t.registry.updateTask(actor.taskId,{status:'done'});t.runs.finish(actor.runId,'completed',201)
    expect(t.registry.getTask(queued)).toMatchObject({status:'cancelled',stopReason:'input_superseded'})
    expect(await t.ci.sweep()).toBe(1)
    const replacement=t.wakes.at(-1)!;expect(replacement).not.toBe(queued)
    t.registry.updateTask(replacement,{status:'done'});expect(await t.ci.sweep()).toBe(0)
  })
  it('upgrades populated legacy arms twice without changing old fields or inventing policy', () => {
    const t=prepare()
    t.registry.db.exec('ALTER TABLE github_ci_followups DROP COLUMN policy_json')
    const before=t.registry.db.prepare('SELECT * FROM github_ci_followups').all()
    t.reopen();t.reopen()
    expect(t.registry.db.prepare('SELECT * FROM github_ci_followups').all().map(row=>{const {policy_json,...old}=row;expect(policy_json).toBeNull();return old})).toEqual(before)
    expect(t.ci.get(t.old.id)?.policy).toBeUndefined()
  })
  it('renews a completed Work at its real new human epoch without rewriting the old source',async()=>{
    const t=prepare();t.registry.workContexts.control(t.workKey,{action:'complete',causeRef:'completed'})
    const actor=human(t),result=await t.ci.control(actor,{changeId:'change',expectedHead:head,action:'continue'})
    expect(t.ci.get(result.id)?.controlEpoch).toBe(t.registry.workContexts.get(t.workKey)?.controlEpoch)
    expect(t.ci.get(result.id)?.origin).toEqual(t.old.origin)
    expect(t.ci.get(t.old.id)?.policy).toBeUndefined()
  })
  it('does not let a publishing system event upgrade explicit notify-only handling',async()=>{
    const t=prepare(),actor=human(t)
    await t.ci.control(actor,{changeId:'change',expectedHead:head,action:'continue',handling:'notify_only'})
    t.runs.finish(actor.runId,'completed',201);t.registry.updateTask(actor.taskId,{status:'done'})
    await t.ci.sweep();const taskId=t.wakes.at(-1)!,event=t.registry.getTask(taskId)!
    const run=t.runs.begin({taskId,sessionKey:'session',workKey:t.workKey,actorOpenId:'alice',triggerKey:`task:${taskId}`,stage:'task',now:210},()=>t.registry.startTask(taskId,210,'session'))!
    t.runs.bindRuntime(run.id,'ci-acp')
    expect(()=>t.ci.arm({...t.input,producerTaskId:taskId,sourceRunId:run.id,expectedSnapshot:nextTree,
      origin:{...t.input.origin,taskId,runId:run.id},provenance:{...t.input.provenance,sources:{...t.input.provenance.sources,acpSessionId:'ci-acp'}}})).toThrow()
    expect(event.prompt).toContain('"handling":"notify_only"')
    expect(event.prompt).toContain('"requiresAnotherUserMessage":false')
  })
  it('routing output identities require the original source lease and never renew an arm',async()=>{
    const t=prepare()
    expect((await t.ci.publicationsForWork(t.workKey,t.input.assertCurrent)).map(({assertCurrent,...publication})=>{assertCurrent();return publication})).toEqual([t.publication])
    expect(await t.ci.publicationsForWork('task:other',t.input.assertCurrent)).toEqual([])
    t.state.access='denied'
    expect(await t.ci.publicationsForWork(t.workKey,t.input.assertCurrent)).toEqual([])
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_ci_followups').get()?.n).toBe(1)
    expect(t.ci.get(t.old.id)?.policy).toBeUndefined()
  })

})
