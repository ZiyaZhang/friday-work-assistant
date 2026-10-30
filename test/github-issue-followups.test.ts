import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { TaskEvents, validTaskEventDispatch } from '../src/core/task-events.js'
import { IssueLinks } from '../src/github/issues.js'
import { ensureDeliverySchema } from '../src/core/delivery.js'
import { GitHubIssueFollowups, ensureGitHubIssueFollowupSchema, type IssueFollowupActor, type IssueFollowupSource } from '../src/github/issue-followups.js'
import type { IssueThread } from '../src/github/issue-thread.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const request = { repo:'org/demo',number:12,action:'start' as const }, url = 'https://github.com/org/demo/issues/12'
function comment(id: number, body = `human reply ${id}`, author = 'developer', authorType: 'User' | 'Bot' = 'User') {
  return { id,body,author,authorType,at:1000+id,updatedAt:1000+id,url:`${url}#issuecomment-${id}` }
}
function thread(comments: IssueThread['comments']): IssueThread {
  const value = { repo:'org/demo',author:'reporter',body:'original reported issue',comments,timeline:[],snapshot:{ repo:'org/demo',number:12,
    title:'original issue',url,state:'open' as const,isPullRequest:false,assignees:[],labels:[],createdAt:1,updatedAt:100,
    linkedPullRequests:0,lastCommentAt:comments.at(-1)?.at,lastCommentAuthor:comments.at(-1)?.author } }
  return { ...value,digest:createHash('sha256').update(JSON.stringify(value)).digest('hex') }
}
/** Real SQLite, human receipt/dispatch, Run/Work and TaskEvents. Only platform and permission providers are synthetic. */
function fixture() {
  const home=mkdtempSync(join(tmpdir(),'friday-issue-followup-')),file=join(home,'db')
  const t={ registry:new Registry(file), runs:undefined as unknown as RunAttempts,events:undefined as unknown as TaskEvents,
    followups:undefined as unknown as GitHubIssueFollowups,now:100,current:true,access:true,accessVersion:1,reads:0,wakes:[] as number[],
    own:'friday-service-user',thread:thread([]),wakeFails:false,readFails:false,
    beforeRead:undefined as (()=>Promise<void>)|undefined,beforeAccess:undefined as (()=>Promise<void>)|undefined }
  cleanup.push(()=>{t.registry.close();rmSync(home,{recursive:true,force:true})})
  const inbound={eventId:'event',messageId:'human',chatId:'chat',chatType:'group' as const,senderOpenId:'alice',senderType:'user' as const,
    msgType:'text',text:'建这条 Issue，有新回复告诉我',mentions:[],createTimeMs:1}
  t.registry.createSession({sessionKey:'session',chatId:'chat',chatType:'group',requesterOpenId:'alice',cwd:'/tmp/synthetic'})
  const task=t.registry.createTaskOnce({sessionKey:'session',messageId:'human',requesterOpenId:'alice',prompt:inbound.text,inbound}).task
  const workKey=t.registry.taskWork.get(task.id)!.key
  function mount(){
    t.runs=new RunAttempts(t.registry.db);t.events=new TaskEvents(t.registry)
    t.followups=new GitHubIssueFollowups({registry:t.registry,events:t.events,now:()=>++t.now,
      assertHostCurrent:()=>{if(!t.current)throw new Error('closing')},
      authorizeSaved:async(_p,_o,guard)=>{guard();const version=t.accessVersion;await t.beforeAccess?.();guard()
        const current=()=>{guard();if(version!==t.accessVersion)throw new Error('permission changed')}
        return t.access?{status:'allowed',assertCurrent:current}:{status:'unavailable',reason:'synthetic',assertCurrent:current}},
      readThread:async(_repo,_number,guard)=>{guard();t.reads++;await t.beforeRead?.();guard();if(t.readFails)throw new Error('private provider detail');return structuredClone(t.thread)},
      wakeQueuedTask:id=>{if(t.wakeFails)throw new Error('process ended before wake');t.wakes.push(id)}})
  }
  mount()
  const run=t.runs.begin({taskId:task.id,sessionKey:'session',workKey,actorOpenId:'alice',triggerKey:'task:first',stage:'task',now:2},()=>t.registry.startTask(task.id,2,'session'))!
  t.runs.bindRuntime(run.id,'acp')
  const actor:IssueFollowupActor={taskId:task.id,runId:run.id,sessionKey:'session',workKey,ownerOpenId:'alice',assertCurrent:()=>{if(!t.current)throw new Error('closing')}}
  const source:IssueFollowupSource={origin:{...actor,spaceId:'group:chat',chatId:'chat',chatType:'group'},
    provenance:{sources:{version:1,acpSessionId:'acp',spaceId:'group:chat',chatId:'chat',memoryScopes:['space:group:chat'],
      chats:[],external:[],repositories:['org/demo'],conversationReads:{complete:true,items:[]}},memoryRefs:[]}}
  // Functions are not part of durable origin metadata.
  delete (source.origin as unknown as {assertCurrent?:()=>void}).assertCurrent
  const finish=(who=actor)=>{t.runs.finish(who.runId,'completed',++t.now);t.registry.updateTask(who.taskId,{status:'done',finishedAt:t.now})}
  const human=(sameWork=true,owner='alice'):IssueFollowupActor=>{
    const messageId=`human-${++t.now}`,m={...inbound,messageId,eventId:messageId,senderOpenId:owner,text:'继续关注这条 Issue 的新回复'}
    const next=t.registry.createTaskOnce({sessionKey:'session',messageId,requesterOpenId:owner,prompt:m.text,inbound:m,...(sameWork?{workFromTaskId:task.id}:{})}).task
    const key=t.registry.taskWork.get(next.id)!.key
    const attempt=t.runs.begin({taskId:next.id,sessionKey:'session',workKey:key,actorOpenId:owner,triggerKey:`task:${next.id}`,stage:'task',now:++t.now},()=>t.registry.startTask(next.id,t.now,'session'))!
    t.runs.bindRuntime(attempt.id,`acp-${next.id}`)
    return {taskId:next.id,runId:attempt.id,sessionKey:'session',workKey:key,ownerOpenId:owner,assertCurrent:actor.assertCurrent}
  }
  const start=()=>t.followups.control(actor,request,source)
  const completeEvent=(id:number)=>{const current=t.registry.getTask(id)!,attempt=t.runs.begin({taskId:id,sessionKey:current.sessionKey,workKey,
    actorOpenId:'alice',triggerKey:`task:${id}`,stage:'task',now:++t.now},()=>t.registry.startTask(id,t.now,current.sessionKey))!
    t.runs.bindRuntime(attempt.id,`event-acp-${id}`);t.runs.finish(attempt.id,'completed',++t.now);t.registry.updateTask(id,{status:'done',finishedAt:t.now})}
  return Object.assign(t,{actor,source,task,run,workKey,start,finish,human,completeEvent,reopen:()=>{t.registry.close();t.registry=new Registry(file);mount()}})
}

describe('explicit Issue reply followups',()=>{
  it('uses the complete initial thread as baseline, then admits a real same-Work evidence task exactly once',async()=>{
    const t=fixture();t.thread=thread([comment(1)])
    const result=await t.start();expect(result.state).toBe('tracking');t.finish()
    expect(await t.followups.sweep()).toBe(0)
    t.thread=thread([comment(1),comment(2)])
    expect(await t.followups.sweep()).toBe(1)
    const event=t.registry.getTask(t.wakes[0]!)!,source=t.events.get(event.id)!,dispatch=t.registry.dispatches.get(event.id)!
    expect(source).toMatchObject({kind:'github_issue_reply',sourceTaskId:t.task.id,sourceWorkKey:t.workKey,targetSessionKey:'session'})
    expect(t.registry.taskWork.get(event.id)?.key).toBe(t.workKey)
    expect(dispatch.inbound).toMatchObject({senderType:'bot',messageId:event.messageId})
    expect(validTaskEventDispatch(t.registry.db,event.id,dispatch.inbound)).toBe(true)
    expect(t.registry.workContexts.inputs(t.workKey).at(-1)?.kind).toBe('evidence')
    const read=await t.followups.authorizeTask(event.id)
    expect(read.observation.comments.map(c=>c.id)).toEqual([2]);expect(event.prompt).toContain(comment(2).url)
    t.completeEvent(event.id);t.reopen()
    expect(await t.followups.sweep()).toBe(0)
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_issue_observations').get()?.n).toBe(1)
  })
  it('does not exclude assigned, linked-PR or closed Issues from their explicitly registered reply followup',async()=>{
    const t=fixture();await t.start();t.finish()
    t.thread=thread([comment(2)]);t.thread.snapshot.assignees=['developer'];t.thread.snapshot.linkedPullRequests=1;t.thread.snapshot.state='closed'
    expect(await t.followups.sweep()).toBe(1)
  })
  it('only excludes exact acknowledged own comment IDs, not the real person sharing Friday’s login',async()=>{
    const t=fixture();t.thread=thread([comment(1)]);await t.start();t.finish()
    const links=new IssueLinks(t.registry.db)
    links.planOperation({requestKey:'own',signature:'synthetic',action:'commented',repo:'org/demo',number:12})
    links.sentOperation('own',12,url,'https://github.com/Org/Demo/issues/12#issuecomment-2')
    links.confirmOperation('own',{repo:'org/demo',number:12,url,commentUrl:'https://github.com/Org/Demo/issues/12#issuecomment-2'})
    t.thread=thread([comment(1),comment(2,'own ACK',t.own),comment(3,'bot','other[bot]','Bot')])
    expect(await t.followups.sweep()).toBe(0)
    t.thread=thread([...t.thread.comments,comment(4,'real person via GitHub UI',t.own)])
    expect(await t.followups.sweep()).toBe(1)
    expect(t.followups.forTask(t.wakes.at(-1)!)?.comments.map(c=>c.id)).toEqual([4])
    t.completeEvent(t.wakes.at(-1)!)
    t.thread=thread([{...comment(1,'corrected reply'),updatedAt:2000},...t.thread.comments.slice(1)])
    expect(await t.followups.sweep()).toBe(1)
    expect(t.followups.forTask(t.wakes.at(-1)!)?.comments[0]?.body).toBe('corrected reply')
  })
  it('keeps two independent Work subscriptions to the same Issue separate',async()=>{
    const t=fixture();await t.start();t.finish();const other=t.human(false)
    const source={origin:{...t.source.origin,taskId:other.taskId,runId:other.runId,workKey:other.workKey},
      provenance:{...t.source.provenance,sources:{...t.source.provenance.sources,acpSessionId:`acp-${other.taskId}`}}}
    await t.followups.control(other,request,source);t.finish(other);t.thread=thread([comment(2)])
    expect(await t.followups.sweep()).toBe(2)
    expect(new Set(t.wakes.map(id=>t.registry.taskWork.get(id)?.key))).toEqual(new Set([t.workKey,other.workKey]))
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_issue_followups').get()?.n).toBe(2)
  })
  it('cannot use another Work source or a system event as registration authority',async()=>{
    const t=fixture();await t.start();t.finish();const other=t.human(false)
    await expect(t.followups.control(other,request,t.source)).rejects.toMatchObject({code:'binding_changed'})
    t.finish(other);t.thread=thread([comment(2)]);await t.followups.sweep()
    const id=t.wakes[0]!,event=t.registry.getTask(id)!,attempt=t.runs.begin({taskId:id,sessionKey:'session',workKey:t.workKey,actorOpenId:'alice',
      triggerKey:`task:${id}`,stage:'task',now:++t.now},()=>t.registry.startTask(id,t.now,'session'))!
    await expect(t.followups.control({...t.actor,taskId:event.id,runId:attempt.id},request)).rejects.toMatchObject({code:'binding_changed'})
  })
  it('requires explicit renewal after a new human input and preserves the original retained proof',async()=>{
    const t=fixture(),first=await t.start();t.finish();const actor=t.human()
    t.thread=thread([comment(2)])
    expect(await t.followups.sweep()).toBe(0)
    expect((await t.followups.trackingForWork(t.workKey,'org/demo',12,actor.assertCurrent)).state).toBe('unavailable')
    const renewed=await t.followups.control(actor,request)
    expect(renewed.version).toBe(2);expect(t.followups.get(first.id!)?.origin).toEqual(t.source.origin)
    t.finish(actor);expect(await t.followups.sweep()).toBe(1)
  })
  it('stops without reading revoked original sources and never resumes from a read or restart',async()=>{
    const t=fixture();const first=await t.start();t.finish();const actor=t.human();t.access=false
    const reads=t.reads
    expect((await t.followups.control(actor,{...request,action:'stop'})).state).toBe('stopped')
    expect(t.reads).toBe(reads);t.finish(actor);t.reopen();t.thread=thread([comment(2)])
    expect(await t.followups.sweep()).toBe(0)
    expect((await t.followups.trackingForWork(t.workKey,'org/demo',12,t.actor.assertCurrent)).state).toBe('stopped')
    expect(t.followups.get(first.id!)?.state).toBe('stopped')
  })
  it('honors Work stop and refuses a late provider result after stop during await',async()=>{
    const t=fixture();await t.start();t.finish();t.thread=thread([comment(2)])
    t.beforeRead=async()=>{t.registry.workContexts.control(t.workKey,{action:'pause',reason:'run_stop',causeRef:'real-stop'})}
    expect(await t.followups.sweep()).toBe(0);expect(t.wakes).toEqual([])
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_issue_observations').get()?.n).toBe(0)
    expect((await t.followups.trackingForWork(t.workKey,'org/demo',12,t.actor.assertCurrent)).state).toBe('stopped')
  })
  it.each(['not-started','run','planned','unknown','sent'] as const)('only renews an unstarted undelivered cancelled observation (%s)',async prior=>{
    const t=fixture();await t.start();t.finish();t.thread=thread([comment(2)]);expect(await t.followups.sweep()).toBe(1)
    const id=t.wakes[0]!
    if(prior==='run')t.completeEvent(id)
    else t.registry.cancelQueuedTask(id,++t.now)
    if(['planned','unknown','sent'].includes(prior)){
      ensureDeliverySchema(t.registry.db)
      t.registry.db.prepare(`INSERT INTO deliveries(delivery_key,context_ref,signature,status,actor_open_id,audience,source_refs,grant_ids,payload_digest,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(`task:${id}:final:0`,`task:${id}:session:session`,'sig',prior,'alice','{}','[]','[]','digest',1,1)
    }
    const actor=t.human();await t.followups.control(actor,request);t.finish(actor)
    expect(await t.followups.sweep()).toBe(prior==='not-started'?1:0)
  })
  it('does not advance evidence or disguise incomplete/failed provider reads as no comments',async()=>{
    const t=fixture();const first=await t.start();t.finish();t.thread=thread([comment(2)])
    t.readFails=true;expect(await t.followups.sweep()).toBe(0);expect(t.followups.get(first.id!)?.lastError).toBe('provider_unavailable')
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_issue_observations').get()?.n).toBe(0)
    t.readFails=false;t.thread.comments[0]!.authorType=undefined
    expect(await t.followups.sweep()).toBe(0);expect(t.followups.get(first.id!)?.lastError).toBe('thread_unavailable')
    t.thread=thread([comment(2)]);expect(await t.followups.sweep()).toBe(1)
  })
  it('rechecks source permission after provider await and before recording a Task',async()=>{
    const t=fixture();await t.start();t.finish();t.thread=thread([comment(2)]);t.beforeRead=async()=>{t.accessVersion++}
    expect(await t.followups.sweep()).toBe(0);expect(t.wakes).toEqual([])
  })
  it('retains a queued event across a failed wake and a database reopen without creating another event',async()=>{
    const t=fixture();await t.start();t.finish();t.thread=thread([comment(2)]);t.wakeFails=true
    expect(await t.followups.sweep()).toBe(1);expect(t.wakes).toEqual([]);t.reopen();t.wakeFails=false
    expect(await t.followups.sweep()).toBe(0);expect(t.wakes).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_issue_observations').get()?.n).toBe(1)
  })
  it('replaces an edited queued snapshot without losing other still-unhandled comments from that observation',async()=>{
    const t=fixture();await t.start();t.finish();t.thread=thread([comment(2),comment(3)]);await t.followups.sweep();const old=t.wakes[0]!
    t.thread=thread([{...comment(2,'corrected'),updatedAt:2000},comment(3)])
    await expect(t.followups.authorizeTask(old)).rejects.toMatchObject({code:'evidence_changed'})
    expect(await t.followups.sweep()).toBe(1)
    expect(t.registry.getTask(old)?.status).toBe('cancelled')
    const observation=t.followups.forTask(t.wakes.at(-1)!)!
    expect(observation.comments.map(item=>item.id)).toEqual([2,3])
    expect(observation.comments[0]?.body).toBe('corrected')
  })
  it.each(['run','planned','unknown','sent'] as const)('does not repeat the other comment when replaced evidence already has %s',async prior=>{
    const t=fixture();await t.start();t.finish();t.thread=thread([comment(2),comment(3)]);await t.followups.sweep();const old=t.wakes[0]!
    if(prior==='run') t.completeEvent(old)
    else {
      ensureDeliverySchema(t.registry.db)
      t.registry.db.prepare(`INSERT INTO deliveries(delivery_key,context_ref,signature,status,actor_open_id,audience,source_refs,grant_ids,payload_digest,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(`task:${old}:final:0`,`task:${old}:session:session`,'sig',prior,'alice','{}','[]','[]','digest',1,1)
    }
    t.registry.updateTask(old,{status:'cancelled',stopReason:'issue_evidence_changed',finishedAt:++t.now})
    t.thread=thread([{...comment(2,'corrected'),updatedAt:2000},comment(3)])
    expect(await t.followups.sweep()).toBe(1)
    expect(t.followups.forTask(t.wakes.at(-1)!)?.comments.map(item=>item.id)).toEqual([2])
  })
  it('rolls back Task admission and evidence together if observation persistence fails',async()=>{
    const t=fixture();await t.start();t.finish();t.thread=thread([comment(2)])
    t.registry.db.exec("CREATE TRIGGER fail_observation BEFORE INSERT ON github_issue_observations BEGIN SELECT RAISE(ABORT,'synthetic disk'); END")
    expect(await t.followups.sweep()).toBe(0)
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM task_event_sources').get()?.n).toBe(0)
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM tasks').get()?.n).toBe(1)
    t.registry.db.exec('DROP TRIGGER fail_observation');expect(await t.followups.sweep()).toBe(1)
  })
  it('upgrades the TaskEvents kind without changing existing events, and schema initialization is idempotent',()=>{
    const t=fixture()
    const prior=t.events.admit({key:'old-ci',kind:'github_ci',sourceTaskId:t.task.id,targetSessionKey:'session',domainId:'old',prompt:'old evidence'})
    t.registry.db.exec(`ALTER TABLE task_event_sources RENAME TO newer;
      CREATE TABLE task_event_sources(task_id INTEGER PRIMARY KEY REFERENCES tasks(id),event_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('meeting_draft','issue_assessment','github_ci')),source_task_id INTEGER NOT NULL REFERENCES tasks(id),
      source_work_key TEXT NOT NULL REFERENCES work_contexts(work_key),target_session_key TEXT NOT NULL,domain_id TEXT NOT NULL);
      INSERT INTO task_event_sources SELECT * FROM newer;DROP TABLE newer;`)
    const links=new IssueLinks(t.registry.db)
    links.planOperation({requestKey:'old-unknown',signature:'synthetic',action:'created',repo:'org/demo'})
    links.unknownOperation('old-unknown','synthetic lost acknowledgement')
    t.registry.db.exec('DROP TABLE github_issue_observations; DROP TABLE github_issue_followups')
    const tables=t.registry.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>String(row.name))
    const rows=()=>Object.fromEntries(tables.map(name=>[name,t.registry.db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all()]))
    const before=rows()
    new TaskEvents(t.registry);ensureGitHubIssueFollowupSchema(t.registry.db);new TaskEvents(t.registry);ensureGitHubIssueFollowupSchema(t.registry.db)
    expect(rows()).toEqual(before)
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_issue_followups').get()?.n).toBe(0)
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM github_issue_observations').get()?.n).toBe(0)
    expect(t.registry.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(String(t.registry.db.prepare("SELECT sql FROM sqlite_master WHERE name='task_event_sources'").get()?.sql)).toContain("'github_issue_reply'")
    expect(validTaskEventDispatch(t.registry.db,prior.task.id,t.registry.dispatches.get(prior.task.id)!.inbound)).toBe(true)
  })
})
