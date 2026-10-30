import { AxiosError } from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelMemory } from '../src/core/memory.js'
import { MemoryRuntime } from '../src/core/memory-runtime.js'
import { ManagedMemoryStorage } from '../src/core/managed-memory-storage.js'
import { PersonalMemoryAccess } from '../src/core/personal-memory-access.js'
import { PersonalMemoryReader } from '../src/core/personal-memory-reader.js'
import { PersonalMemoryContext } from '../src/core/personal-memory-context.js'
import { PolicyService } from '../src/core/policy.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { Spaces } from '../src/core/space.js'
import type { MemorySourceReference } from '../src/core/memory-provenance.js'
import type { SourceContext } from '../src/core/source-context.js'
import { UserTokenStore } from '../src/feishu/oauth.js'

const registries: Registry[]=[]
afterEach(()=>{for(const registry of registries.splice(0))registry.close()})
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes});return {promise,resolve}}
async function setup(){
  const registry=new Registry(':memory:');registries.push(registry)
  const db=registry.db,memory=new ChannelMemory(db),attempts=new RunAttempts(db),spaces=new Spaces(db)
  const dm=spaces.ensure({kind:'p2p',chatId:'dm-alice',openId:'alice'}),scope=`space:${dm.id}`
  const policy=new PolicyService(spaces,{admins:[]})
  const tokens=new UserTokenStore(db,{exchangeCode:async()=>({accessToken:'SYNTHETIC',expiresIn:7200,
    scope:'im:message:readonly im:message.group_msg:get_as_user'}),refresh:async()=>{throw new Error('unexpected refresh')}})
  await tokens.complete({openId:'alice',code:'synthetic',redirectUri:'https://callback.invalid'})
  const feishu={whoAmI:vi.fn(async()=>({openId:'alice',tenantKey:'tenant-a'})),
    listChatsResult:vi.fn(async()=>({items:[{chatId:'chat-a',name:'a'},{chatId:'chat-b',name:'b'}],complete:true}))}
  const access=new PersonalMemoryAccess({appId:'app-a',spaces,policy,userTokens:tokens,feishu})
  const reader=new PersonalMemoryReader(new ManagedMemoryStorage(db),access),aborts=new Map<string,ReturnType<typeof vi.fn>>()
  const newRuntime=()=>new MemoryRuntime({registry,memory,attempts,now:()=>100,activeRun:id=>aborts.has(id)?{runId:id,abort:aborts.get(id)!}:undefined})
  let runtime=newRuntime(),service=new PersonalMemoryContext({memory,runtime,reader,access}),serial=0
  registry.createSession({sessionKey:'session-alice',chatId:'dm-alice',chatType:'p2p',requesterOpenId:'alice',cwd:'/synthetic'})
  const newRun=(acpId=`acp-${serial+1}`,bind=true)=>{
    const task=registry.createTask({sessionKey:'session-alice',messageId:`message-${++serial}`,requesterOpenId:'alice',prompt:'synthetic current input'})
    const run=attempts.begin({workKey:`task:${task.id}`,triggerKey:`task:${task.id}`,sessionKey:'session-alice',taskId:task.id,
      stage:'task',actorOpenId:'alice',now:serial},()=>registry.startTask(task.id,serial,'session-alice'))!
    attempts.bindRuntime(run.id,acpId);if(bind)runtime.contexts.bind(run.id,'session-alice',acpId)
    const abort=vi.fn();aborts.set(run.id,abort)
    const actor={spaceId:dm.id,openId:'alice',runId:run.id},assertRun=()=>{if(!attempts.isCurrent(run.id))throw new Error('run stopped')}
    return {task,run,actor,assertRun,abort,acpId}
  }
  const source=(chatId='chat-a'):MemorySourceReference=>({ref:`message:${chatId}`,tenantId:'tenant-a',appId:'app-a',
    spaceId:null,chatId,messageId:`om-${chatId}`,readIdentity:{kind:'user',openId:'alice'},readAt:1,coverage:'complete'})
  const add=(chatId='chat-a')=>memory.add({scope,kind:'fact',title:`fact ${chatId}`,body:`body ${chatId}`,
    provenance:{state:'verified',originRunId:'synthetic-origin',sources:[source(chatId)]}})
  const sourceContext=(sources=[source()]):SourceContext=>({version:1,acpSessionId:'acp-1',spaceId:dm.id,chatId:'dm-alice',memoryScopes:[scope],
    chats:sources.map(s=>({chatId:s.chatId!})),external:[],repositories:[],personalMemoryComplete:true,messageSources:sources})
  const snapshot=()=>['memory_notes','memory_provenance','memory_changes','runtime_contexts','run_contexts','run_attempts','tasks']
    .map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
  const restart=()=>{runtime=newRuntime();service=new PersonalMemoryContext({memory,runtime,reader,access});return {runtime,service}}
  return {db,registry,memory,attempts,spaces,scope,tokens,feishu,access,reader,runtime,service,newRun,source,add,sourceContext,snapshot,restart}
}

describe('personal memory context with real authorization, storage and runtime',()=>{
  it('reads managed and legacy notes through one authority check and records exact consumed versions',async()=>{
    const t=await setup(),active=t.newRun(),managed=t.add()
    const legacy=t.memory.add({scope:t.scope,kind:'fact',title:'legacy',body:'legacy'})
    const result=await t.service.search(active.actor,[t.scope],'',10,active.assertRun)
    expect(result.notes.map(note=>note.id)).toEqual([managed.id,legacy.id])
    expect(t.runtime.contexts.contextForRun(active.run.id)?.notes).toEqual([{id:managed.id,revision:1},{id:legacy.id,revision:1}])
    expect(t.runtime.contexts.isEligible(active.run.id,true)).toBe(true)
    expect(t.feishu.whoAmI).toHaveBeenCalledTimes(1);expect(t.feishu.listChatsResult).toHaveBeenCalledTimes(1)
    expect(t.memory.get(managed.id)).toBeUndefined()
  })

  it('saves actual source metadata and consumed ancestors without admitting managed reads through the legacy entry',async()=>{
    const t=await setup(),active=t.newRun(),original=t.add()
    await t.service.search(active.actor,[t.scope],'',10,active.assertRun)
    const note=await t.service.add(active.actor,{scope:t.scope,kind:'fact',title:'derived',body:'derived'},t.sourceContext([t.source('chat-b')]),active.assertRun)
    expect(t.memory.getProvenance(note.id)).toMatchObject({state:'verified',originRunId:active.run.id,
      sources:[t.source('chat-b'),t.source()],ancestors:[{id:original.id,revision:1}]})
    expect(t.runtime.contexts.contextForRun(active.run.id)?.notes).toEqual([{id:original.id,revision:1},{id:note.id,revision:1}])
    expect(t.memory.get(note.id)).toBeUndefined()
  })

  it('corrects an actually consumed source without losing its source or retaining the replaced version as an ancestor',async()=>{
    const t=await setup(),active=t.newRun(),original=t.add()
    await t.service.search(active.actor,[t.scope],'',10,active.assertRun)
    const correction=await t.service.add(active.actor,{scope:t.scope,kind:'fact',title:'corrected',body:'corrected',replaces:original.id,expectedRevision:1},
      t.sourceContext([t.source('chat-b')]),active.assertRun)
    expect(t.memory.getProvenance(correction.id)).toMatchObject({state:'verified',sources:[t.source('chat-b'),t.source()],ancestors:[]})
    expect(t.db.prepare('SELECT status FROM memory_notes WHERE id=?').get(original.id)).toMatchObject({status:'superseded'})
    expect(t.runtime.contexts.contextForRun(active.run.id)?.state).toBe('invalidated')
    expect(t.attempts.get(active.run.id)?.stopReason).toBe('memory_context_invalidated')
    expect(active.abort).toHaveBeenCalledOnce()
  })

  it.each(['managed-other-source','legacy'] as const)('rejects %s replacement that omits the untouched target source, even when it was not consumed',async mode=>{
    const t=await setup(),original=t.add(),before=t.snapshot()
    expect(()=>t.memory.add({scope:t.scope,kind:'fact',title:'wrong',body:'wrong',replaces:original.id,expectedRevision:1,
      ...(mode==='managed-other-source'?{provenance:{state:'verified' as const,originRunId:'new-run',sources:[t.source('chat-b')]}}:{})}))
      .toThrow()
    expect(t.snapshot()).toEqual(before)
  })

  it('rechecks an unseen replacement target source and denies a revoked target without changing the original or aborting',async()=>{
    const t=await setup(),active=t.newRun(),original=t.add(),before=t.snapshot()
    t.feishu.listChatsResult.mockResolvedValue({items:[{chatId:'chat-b',name:'b'}],complete:true})
    await expect(t.service.add(active.actor,{scope:t.scope,kind:'fact',title:'wrong',body:'wrong',replaces:original.id,expectedRevision:1},
      t.sourceContext([t.source('chat-b')]),active.assertRun)).rejects.toThrow()
    expect(t.snapshot()).toEqual(before);expect(active.abort).not.toHaveBeenCalled()
  })

  it('preserves the source of an unseen target when all old and new sources are freshly allowed',async()=>{
    const t=await setup(),active=t.newRun(),original=t.add()
    const next=await t.service.add(active.actor,{scope:t.scope,kind:'fact',title:'new',body:'new',replaces:original.id,expectedRevision:1},
      t.sourceContext([t.source('chat-b')]),active.assertRun)
    expect(t.memory.getProvenance(next.id)).toMatchObject({state:'verified',sources:[t.source('chat-b'),t.source()],ancestors:[]})
    expect(t.runtime.contexts.isEligible(active.run.id,true)).toBe(true)
    expect(active.abort).not.toHaveBeenCalled()
  })

  it('rejects a changed material manifest after authorization await before storing any note',async()=>{
    const t=await setup(),active=t.newRun(),entered=deferred(),release=deferred(),before=t.snapshot()
    let materialCurrent=true
    t.feishu.whoAmI.mockImplementation(async()=>{entered.resolve();await release.promise;return {openId:'alice',tenantKey:'tenant-a'}})
    const pending=t.service.add(active.actor,{scope:t.scope,kind:'fact',title:'new',body:'new'},t.sourceContext(),active.assertRun,
      ()=>{if(!materialCurrent)throw new Error('materials changed')})
    await entered.promise;materialCurrent=false;release.resolve()
    await expect(pending).rejects.toThrow('materials changed')
    expect(t.snapshot()).toEqual(before);expect(active.abort).not.toHaveBeenCalled()
  })

  it('stops an execution which has already consumed the now-revoked material',async()=>{
    const t=await setup(),active=t.newRun(),note=t.add()
    await t.service.search(active.actor,[t.scope],'',10,active.assertRun)
    t.feishu.listChatsResult.mockResolvedValue({items:[],complete:true})
    await expect(t.service.search(active.actor,[t.scope],'',10,active.assertRun)).rejects.toThrow()
    expect(t.memory.getProvenance(note.id)?.state).toBe('unavailable')
    expect(t.attempts.get(active.run.id)?.stopReason).toBe('memory_context_invalidated')
    expect(active.abort).toHaveBeenCalledOnce()
  })

  it('records only exact denied notes and leaves independent groups usable',async()=>{
    const t=await setup(),active=t.newRun(),denied=t.add(),good=t.add('chat-b')
    t.feishu.listChatsResult.mockResolvedValue({items:[{chatId:'chat-b',name:'b'}],complete:true})
    const result=await t.service.search(active.actor,[t.scope],'',10,active.assertRun)
    expect(result.notes.map(note=>note.id)).toEqual([good.id]);expect(result.sourceDenied).toBe(1)
    expect(t.memory.getProvenance(denied.id)?.state).toBe('unavailable');expect(t.memory.getProvenance(good.id)?.state).toBe('verified')
    expect(t.runtime.contexts.isEligible(active.run.id,true)).toBe(true);expect(active.abort).not.toHaveBeenCalled()
  })

  it('clears an already consumed context on temporary verification failure without permanently disabling the note',async()=>{
    const t=await setup(),active=t.newRun(),note=t.add()
    await t.service.search(active.actor,[t.scope],'',10,active.assertRun)
    expect(t.runtime.contexts.isEligible(active.run.id,true)).toBe(true)
    t.feishu.listChatsResult.mockRejectedValue(new AxiosError('temporary synthetic failure', 'ERR_NETWORK'))
    await t.service.search(active.actor,[t.scope],'',10,active.assertRun).catch(()=>{})
    expect(t.runtime.contexts.isEligible(active.run.id,true)).toBe(false)
    expect(t.memory.getProvenance(note.id)?.state).toBe('verified')
    expect(t.db.prepare('SELECT revision FROM memory_notes WHERE id=?').get(note.id)).toMatchObject({revision:1})
  })

  it('requires fresh authority after runtime reconstruction before rebinding the same ACP',async()=>{
    const t=await setup(),first=t.newRun(),note=t.add()
    await t.service.search(first.actor,[t.scope],'',10,first.assertRun)
    t.attempts.finish(first.run.id,'completed',100)
    const restored=t.restart(),second=t.newRun(first.acpId,false)
    expect(restored.runtime.contexts.canResume('session-alice',first.acpId,second.run.id)).toBe(false)
    const calls=t.feishu.whoAmI.mock.calls.length
    expect(await restored.service.resume(second.actor,first.acpId,second.assertRun)).toBe(true)
    expect(t.feishu.whoAmI).toHaveBeenCalledTimes(calls+1)
    expect(restored.runtime.contexts.bind(second.run.id,'session-alice',first.acpId).notes).toEqual([{id:note.id,revision:1}])
  })

  it('does not reuse a warm ACP after restart when its source is temporarily unavailable',async()=>{
    const t=await setup(),first=t.newRun(),note=t.add()
    await t.service.search(first.actor,[t.scope],'',10,first.assertRun);t.attempts.finish(first.run.id,'completed',100)
    const restored=t.restart(),second=t.newRun(first.acpId,false)
    t.feishu.listChatsResult.mockRejectedValue(new AxiosError('temporary', 'ERR_NETWORK'))
    expect(await restored.service.resume(second.actor,first.acpId,second.assertRun)).toBe(false)
    expect(restored.runtime.contexts.canResume('session-alice',first.acpId,second.run.id)).toBe(false)
    expect(t.memory.getProvenance(note.id)?.state).toBe('verified')
  })

  it('rolls back a late persistent failure before source correction changes context or aborts a run',async()=>{
    const t=await setup(),active=t.newRun(),note=t.add()
    await t.service.search(active.actor,[t.scope],'',10,active.assertRun)
    const before=t.snapshot()
    t.db.exec("CREATE TRIGGER reject_correction BEFORE INSERT ON memory_changes WHEN NEW.operation='superseded' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    await expect(t.service.add(active.actor,{scope:t.scope,kind:'fact',title:'fix',body:'fix',replaces:note.id,expectedRevision:1},
      t.sourceContext(),active.assertRun)).rejects.toThrow('synthetic failure')
    expect(t.snapshot()).toEqual(before);expect(active.abort).not.toHaveBeenCalled()
  })
})

it('does not erase an unintegrated meeting source into an ordinary personal memory', async () => {
  const t = await setup(), active = t.newRun(), context = t.sourceContext()
  context.meetingSources = [{ version: 1, sessionId: 'meeting-session', sessionVersion: 'meeting-v1', meetingId: 'platform-meeting',
    ownerOpenId: 'alice', spaceId: active.actor.spaceId, chatId: 'dm-alice', revision: 1, eventsDigest: 'a'.repeat(64), complete: true }]
  const before = t.snapshot()
  await expect(t.service.add(active.actor, { scope: t.scope, kind: 'fact', title: 'Meeting-derived', body: 'must retain meeting proof' }, context, active.assertRun))
    .rejects.toThrow('会议材料尚未接入长期记忆来源核验')
  expect(t.snapshot()).toEqual(before)
  expect(t.feishu.whoAmI).not.toHaveBeenCalled()
})
