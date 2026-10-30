import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IngressClassificationInput, IngressDecision } from '../src/acp/ingress-classifier.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => Promise<void>)[]=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close()})
function deferred(){let resolve!:()=>void; const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}
async function fixture(){
  const home=mkdtempSync(join(tmpdir(),'friday-finished-stop-')), registry=new Registry(join(home,'state.db'))
  const cfg=loadConfig({FEISHU_APP_ID:'synthetic',FEISHU_APP_SECRET:'synthetic',FRIDAY_HOME:home,
    FRIDAY_REFLECT:'off',FRIDAY_DEFAULT_EXECUTION:'managed',FRIDAY_ACK_AFTER_MS:'0'})
  mkdirSync(cfg.workspace.root,{recursive:true})
  const sp=spaceDeps(registry.db,{admins:['alice']}), fake=new FakeFeishu(), log=createLogger('finished-stop','error')
  sp.spaces.ensure({kind:'p2p',chatId:'private-chat',openId:'alice'})
  const execution=managedHostRuntime(registry,home,log)
  const classify=vi.fn<(input:IngressClassificationInput)=>Promise<IngressDecision>>(async()=>({kind:'new_work'}))
  const host=new Orchestrator({cfg,registry,...sp,memory:new ChannelMemory(registry.db),feishu:asFeishuClient(fake),
    runtime:execution.runtime,managed:execution.managed,tokens:new TokenIssuer('synthetic'),ingressClassifier:{classify},
    apiBaseUrl:'http://127.0.0.1:1',mcpServerPath:'/synthetic',botOpenId:'bot',log})
  cleanup.push(async()=>{host.beginShutdown();await execution.runtime.stop();await host.waitForShutdown(1000);registry.close();rmSync(home,{recursive:true,force:true})})
  let serial=0
  const message=(text:string):InboundMessage=>({eventId:`event-${++serial}`,messageId:`message-${serial}`,chatId:'private-chat',chatType:'p2p',
    senderOpenId:'alice',senderType:'user',tenantId:'tenant',msgType:'text',text,mentions:[],createTimeMs:Date.now()+serial})
  execution.peer.state.script=[{kind:'text',text:'这轮已处理。'}]
  const original=message('处理原来的请求');await host.handleMessage(original)
  const task=registry.taskForMessage(original.messageId)!,workKey=registry.taskWork.get(task.id)!.key
  expect(task.status).toBe('done')
  classify.mockImplementation(async input=>({kind:'stop',targetRef:input.candidates[0]!.ref}))
  return {registry,host,fake,classify,message,task,workKey,state:execution.peer.state}
}

describe('finished Task stop is a durable Work control',()=>{
  it('rolls back the Work pause with its ingress receipt and recovers the same stop only once',async()=>{
    const t=await fixture(), before=t.registry.workContexts.get(t.workKey)!, prompts=t.state.allPrompts.length
    const task=t.registry.getTask(t.task.id),run=t.registry.db.prepare('SELECT * FROM run_attempts WHERE task_id=?').get(t.task.id)
    const stop=t.message('这件事先停止，之后需要再继续')
    t.registry.db.exec(`CREATE TRIGGER reject_stop_receipt BEFORE UPDATE OF result ON ingress_routes
      WHEN NEW.result IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic ingress write failure'); END`)
    await expect(t.host.handleMessage(stop)).rejects.toThrow('synthetic ingress write failure')
    expect(t.registry.workContexts.get(t.workKey)).toEqual(before)
    expect(t.registry.taskForMessage(stop.messageId)).toBeUndefined()
    t.registry.db.exec('DROP TRIGGER reject_stop_receipt')
    await t.host.recoverHandoffs()
    const stopped=t.registry.workContexts.get(t.workKey)!
    expect(stopped).toMatchObject({controlEpoch:before.controlEpoch+1,pauseReasons:[{reason:'run_stop',causeRef:`ingress:${stop.messageId}`}]})
    expect(t.registry.getTask(t.task.id)).toEqual(task)
    expect(t.registry.db.prepare('SELECT * FROM run_attempts WHERE task_id=?').get(t.task.id)).toEqual(run)
    expect(t.state.allPrompts).toHaveLength(prompts)
    await t.host.handleMessage(stop)
    expect(t.registry.workContexts.get(t.workKey)).toEqual(stopped)
    expect(JSON.stringify(t.fake.sent)).toContain('后续自动跟进')
  })
  it('does not let an old stop cancel a newer human instruction accepted during classification',async()=>{
    const t=await fixture(),entered=deferred(),release=deferred()
    t.classify.mockImplementation(async input=>{entered.resolve();await release.promise;return {kind:'stop',targetRef:input.candidates[0]!.ref}})
    const pending=t.host.handleMessage(t.message('先停下这件事'));await entered.promise
    const next=t.message('以这条新的要求继续')
    const accepted=t.registry.createTaskOnce({sessionKey:t.task.sessionKey,messageId:next.messageId,requesterOpenId:'alice',
      prompt:next.text,inbound:next,amendsTaskId:t.task.id}).task
    const before=t.registry.workContexts.get(t.workKey)
    release.resolve();await pending
    expect(t.registry.workContexts.get(t.workKey)).toEqual(before)
    expect(t.registry.getTask(accepted.id)?.status).toBe('queued')
    expect(JSON.stringify(t.fake.sent)).toContain('状态已经变化')
  })
})
