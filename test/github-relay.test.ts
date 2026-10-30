import { createServer, Agent } from 'node:https'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import axios from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubTransport, githubRelay } from '../src/github/transport.js'
import { GitHubIdentity, loadGitHubConfig } from '../src/github/identity.js'
import { ChangeManager } from '../src/github/changes.js'
import { Registry } from '../src/core/registry.js'
import { createLogger } from '../src/log.js'

const cleanups:(()=>void|Promise<void>)[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const cleanup of cleanups.splice(0).reverse())await cleanup()})
const relayToken='SYNTHETIC_RELAY_SECRET_AT_LEAST_32_CHARS',githubToken='synthetic-github-token'
const log=createLogger('github-relay-test','error')
function git(cwd:string,...args:string[]){return execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',env:{PATH:process.env.PATH,LANG:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.test',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.test'}}).trim()}

async function fixture(){
  const home=mkdtempSync(join(tmpdir(),'friday-github-relay-'));cleanups.push(()=>rmSync(home,{recursive:true,force:true}))
  const key=join(home,'key.pem'),cert=join(home,'cert.pem')
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'],{stdio:'ignore'})
  const src=join(home,'source'),bare=join(home,'origin.git');mkdirSync(src)
  git(src,'init','-q');git(src,'symbolic-ref','HEAD','refs/heads/main');writeFileSync(join(src,'README.md'),'initial\n')
  git(src,'add','-A');git(src,'commit','-qm','initial');git(home,'clone','--quiet','--bare',src,bare);git(bare,'config','http.receivepack','true')
  const requests:{method:string;url:string;headers:Record<string,unknown>}[]=[]
  let branch='',number=0,holdEntered!:()=>void,holdClosed!:()=>void,gitHoldEntered!:()=>void,gitHoldClosed!:()=>void
  const held=new Promise<void>(resolve=>{holdEntered=resolve}),closed=new Promise<void>(resolve=>{holdClosed=resolve})
  const gitHeld=new Promise<void>(resolve=>{gitHoldEntered=resolve}),gitClosed=new Promise<void>(resolve=>{gitHoldClosed=resolve})
  const state={dropPost:false,rejectGitPush:false,holdGitPush:false}
  const pr=()=>({number,html_url:`https://github.com/Org/Demo/pull/${number}`,draft:true,state:'open',merged:false,
    head:{ref:branch,sha:git(bare,'rev-parse',branch),repo:{full_name:'Org/Demo'}},base:{ref:'main',repo:{full_name:'Org/Demo'}}})
  const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},async(req,res)=>{
    const path=req.url!;requests.push({method:req.method!,url:path,headers:{...req.headers}})
    if(req.headers['x-friday-relay-token']!==relayToken){res.writeHead(403);res.end();return}
    if(path==='/api/hold'){res.on('close',holdClosed);holdEntered();return}
    if(path==='/api/redirect'){res.writeHead(302,{location:'/api/should-not-follow'});res.end();return}
    if(path.startsWith('/api/')){
      if(req.headers.authorization!==`Bearer ${githubToken}`){res.writeHead(401);res.end();return}
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk))
      if(state.dropPost&&req.method==='POST'){req.socket.destroy();return}
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{}
      let data:unknown={ok:true}
      if(path==='/api/repos/org/demo')data={default_branch:'main'}
      if(path.includes('/pulls?'))data=number?[pr()]:[]
      else if(path.endsWith('/pulls')&&req.method==='POST'){branch=body.head;number++;data=pr()}
      else if(/\/pulls\/\d+$/.test(path))data=pr()
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));return
    }
    if(!path.startsWith('/git/org/demo.git/')||req.headers.authorization!==`basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`){res.writeHead(403);res.end();return}
    if(state.holdGitPush&&path.endsWith('/git-receive-pack')){req.resume();res.on('close',gitHoldClosed);gitHoldEntered();return}
    if(state.rejectGitPush&&path.endsWith('/git-receive-pack')){res.writeHead(503);res.end();return}
    const url=new URL(path,'https://localhost'),backend=spawn('git',['http-backend'],{env:{PATH:process.env.PATH,LANG:'C',GIT_PROJECT_ROOT:home,GIT_HTTP_EXPORT_ALL:'1',
      PATH_INFO:url.pathname.replace('/git/org/demo.git','/origin.git'),REQUEST_METHOD:req.method!,QUERY_STRING:url.search.slice(1),
      CONTENT_TYPE:String(req.headers['content-type']??''),CONTENT_LENGTH:String(req.headers['content-length']??''),REMOTE_USER:'synthetic',GIT_PROTOCOL:String(req.headers['git-protocol']??'')}})
    const data:Buffer[]=[];backend.stdout.on('data',chunk=>data.push(chunk));backend.stderr.resume();req.pipe(backend.stdin)
    backend.on('close',()=>{const out=Buffer.concat(data),separator=out.indexOf('\r\n\r\n');if(separator<0){res.writeHead(500);res.end();return}
      const headers=out.subarray(0,separator).toString().split('\r\n');let status=200
      for(const header of headers){const colon=header.indexOf(':');if(colon<0)continue;const name=header.slice(0,colon),value=header.slice(colon+1).trim();if(name.toLowerCase()==='status')status=Number(value.slice(0,3));else res.setHeader(name,value)}
      res.writeHead(status);res.end(out.subarray(separator+4))})
  })
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const origin=`https://127.0.0.1:${(server.address() as AddressInfo).port}`
  cleanups.push(()=>new Promise<void>(done=>{server.closeAllConnections();server.close(()=>done())}))
  // Only trust roots are injected; routing, headers, redirect and cancellation use actual axios transport.
  const create=axios.create.bind(axios),agent=new Agent({ca:readFileSync(cert)})
  cleanups.push(()=>agent.destroy());vi.spyOn(axios,'create').mockImplementation(options=>create({...options,httpsAgent:agent,proxy:false}))
  const cfg=loadGitHubConfig({GITHUB_TOKEN:githubToken,FRIDAY_GITHUB_REPOS:'org/demo',FRIDAY_GITHUB_WRITE_REPOS:'org/demo',FRIDAY_GITHUB_RELAY_URL:origin,FRIDAY_GITHUB_RELAY_TOKEN:relayToken})!
  const github=new GitHubIdentity(cfg,log),registry=new Registry(':memory:');cleanups.push(()=>registry.close())
  const changes=new ChangeManager({db:registry.db,cacheDir:join(home,'trusted-git'),github,transport:github.transport,log,author:{name:'Test',email:'test@example.test'}})
  type Runner={git(args:string[],cwd?:string,env?:Record<string,string>,before?:()=>void,signal?:AbortSignal):Promise<string>}
  const runner=changes as unknown as Runner,originalGit=runner.git.bind(changes)
  vi.spyOn(runner,'git').mockImplementation((args,...rest)=>originalGit(['-c',`http.sslCAInfo=${cert}`,...args],...rest))
  const actor={cwd:join(home,'workspace'),sessionKey:'synthetic-run',requesterOpenId:'alice',assertAuthorized:()=>{if(!github.repoWritable('org/demo'))throw new Error('denied')}}
  return{home,bare,requests,origin,cfg,github,registry,changes,actor,state,held,closed,gitHeld,gitClosed,runner,originalGit}
}

describe('GitHub relay configuration and routing',()=>{
  it.each([
    {FRIDAY_GITHUB_RELAY_URL:'https://relay.example'},
    {FRIDAY_GITHUB_RELAY_TOKEN:relayToken},
    {FRIDAY_GITHUB_RELAY_URL:'http://relay.example',FRIDAY_GITHUB_RELAY_TOKEN:relayToken},
    {FRIDAY_GITHUB_RELAY_URL:'https://a:b@relay.example',FRIDAY_GITHUB_RELAY_TOKEN:relayToken},
    {FRIDAY_GITHUB_RELAY_URL:'https://relay.example?x=1',FRIDAY_GITHUB_RELAY_TOKEN:relayToken},
    {FRIDAY_GITHUB_RELAY_URL:'https://relay.example#x',FRIDAY_GITHUB_RELAY_TOKEN:relayToken},
    {FRIDAY_GITHUB_RELAY_URL:'https://relay.example',FRIDAY_GITHUB_RELAY_TOKEN:'short'},
    {FRIDAY_GITHUB_RELAY_URL:'https://relay.example',FRIDAY_GITHUB_RELAY_TOKEN:relayToken+'\n'},
  ])('rejects invalid relay config %# before credentials can be used',env=>expect(()=>loadGitHubConfig({GITHUB_TOKEN:githubToken,...env})).toThrow())
  it('defaults to direct and maps only a fixed GitHub repository identity to the configured relay',()=>{
    const direct=new GitHubTransport(),relay=new GitHubTransport('https://api.github.com',githubRelay('https://relay.example/',relayToken))
    expect(direct.api('/user')).toEqual({url:'https://api.github.com/user',headers:{}})
    expect(relay.api('/repos/org/demo/issues?state=open')).toEqual({url:'https://relay.example/api/repos/org/demo/issues?state=open',headers:{'x-friday-relay-token':relayToken}})
    expect(relay.gitRequest('org/demo','https://github.com/org/demo.git').url).toBe('https://relay.example/git/org/demo.git')
    expect(()=>relay.gitRequest('org/demo','https://github.com/other/repo.git')).toThrow()
    for(const path of['https://evil.example/x','//evil.example/x','/../user','/repos\\evil'])expect(()=>relay.api(path)).toThrow()
  })
})

describe('real HTTPS GitHub relay transport',()=>{
  it('passes GitHub and relay authentication separately and does not follow redirects or replay a lost POST',async()=>{
    const t=await fixture();expect(await t.github.api('GET','/user')).toEqual({ok:true})
    expect(t.requests[0]).toMatchObject({url:'/api/user',headers:{authorization:`Bearer ${githubToken}`,'x-friday-relay-token':relayToken}})
    await expect(t.github.api('GET','/redirect')).rejects.toMatchObject({status:302})
    expect(t.requests.some(request=>request.url.includes('should-not-follow'))).toBe(false)
    t.state.dropPost=true;await expect(t.github.api('POST','/repos/org/demo/issues',{title:'synthetic'})).rejects.toThrow()
    expect(t.requests.filter(request=>request.method==='POST')).toHaveLength(1)
  })
  it('aborts the real relay socket when the caller cancels',async()=>{
    const t=await fixture(),abort=new AbortController(),pending=t.github.api('GET','/hold',undefined,undefined,undefined,abort.signal)
    const rejected=expect(pending).rejects.toThrow();await t.held;abort.abort();await rejected;await t.closed
    expect(t.requests).toHaveLength(1)
  })
  it.each([false,true])('fetches, ls-remotes, pushes and updates the same PR over real Git HTTP (legacy direct binding=%s)',async legacy=>{
    const t=await fixture(),prepared=await t.changes.prepare({...t.actor,repo:'Org/Demo',operationKey:'prepare-one'})
    const registered=legacy?'https://github.com/org/demo.git':t.github.transport.gitRemote('org/demo')
    if(legacy){t.registry.db.prepare('UPDATE github_changes SET remote_url=? WHERE id=?').run(registered,prepared.id);git(prepared.dir,'remote','set-url','origin',registered)}
    writeFileSync(join(prepared.dir,'README.md'),'first change\n')
    const initial=await t.changes.inspect({...t.actor,dir:prepared.dir})
    const first=await t.changes.publish({...t.actor,dir:prepared.dir,expectedSnapshot:initial.snapshot,title:'test: relay',body:'synthetic'})
    writeFileSync(join(prepared.dir,'README.md'),'second change\n');const inspect=await t.changes.inspectUpdate({...t.actor,dir:prepared.dir})
    const second=await t.changes.updatePr({...t.actor,dir:prepared.dir,title:'test: followup',body:'synthetic',expectedHead:inspect.expectedHead,expectedSnapshot:inspect.snapshot})
    expect(second.number).toBe(first.number);expect(git(t.bare,'rev-parse',`${second.head}^`)).toBe(first.head)
    expect(git(t.bare,'show',`${second.head}:README.md`)).toBe('second change')
    expect(t.requests.filter(request=>request.url==='/git/org/demo.git/git-receive-pack')).toHaveLength(2)
    expect(t.requests.filter(request=>request.method==='POST'&&request.url==='/api/repos/org/demo/pulls')).toHaveLength(1)
    expect(git(prepared.dir,'remote','get-url','origin')).toBe(registered)
    expect(t.registry.db.prepare('SELECT remote_url FROM github_changes WHERE id=?').get(prepared.id)?.remote_url).toBe(registered)
    const config=readFileSync(join(prepared.dir,'.git/config'),'utf8');expect(config).not.toContain(githubToken);expect(config).not.toContain(relayToken);expect(config).not.toContain('extraHeader')
    expect(readdirSync(join(t.home,'trusted-git')).filter(name=>name.startsWith('.auth-'))).toEqual([])
  },20000)
  it('Git credentials apply only to the exact relay repository, never direct GitHub or another relay path',async()=>{
    const t=await fixture(),auth=await(t.changes as unknown as {authEnv(repo:string):Promise<Record<string,string>>}).authEnv('org/demo')
    const target=t.github.transport.gitRemote('org/demo')
    const headers=await t.originalGit(['config','--get-urlmatch','http.extraheader',target],undefined,auth)
    expect(headers).toBe('x-friday-relay-token: '+relayToken)
    const all=await t.originalGit(['config','--get-all',`http.${target}.extraheader`],undefined,auth)
    expect(all).toContain('AUTHORIZATION: basic ');expect(all).toContain('x-friday-relay-token: '+relayToken)
    for(const wrong of['https://github.com/org/demo.git',t.origin+'/git/other/repo.git',t.origin+'/api/user'])
      await expect(t.originalGit(['config','--get-urlmatch','http.extraheader',wrong],undefined,auth)).rejects.toThrow()
    expect(t.requests).toEqual([])
  })
  it.each(['publish','update'] as const)('cancels a real held %s Git POST, preserves uncertainty, and never starts a second transport',async operation=>{
    const t=await fixture(),prepared=await t.changes.prepare({...t.actor,repo:'org/demo'}),abort=new AbortController()
    writeFileSync(join(prepared.dir,'README.md'),'first\n');const first=await t.changes.inspect({...t.actor,dir:prepared.dir})
    const publish={...t.actor,dir:prepared.dir,title:'test: relay',body:'synthetic',expectedSnapshot:first.snapshot}
    let input:Parameters<ChangeManager['updatePr']>[0]|undefined
    if(operation==='update'){
      await t.changes.publish(publish);writeFileSync(join(prepared.dir,'README.md'),'second\n')
      const inspected=await t.changes.inspectUpdate({...t.actor,dir:prepared.dir})
      input={...t.actor,dir:prepared.dir,title:'test: update',body:'synthetic',expectedSnapshot:inspected.snapshot,expectedHead:inspected.expectedHead,signal:abort.signal}
    }
    const before=t.requests.filter(request=>request.url.endsWith('/git-receive-pack')).length;t.state.holdGitPush=true
    const pending=operation==='publish'?t.changes.publish({...publish,signal:abort.signal}):t.changes.updatePr(input!)
    const rejected=expect(pending).rejects.toThrow();await t.gitHeld;abort.abort();await rejected;await t.gitClosed
    expect(t.requests.filter(request=>request.url.endsWith('/git-receive-pack'))).toHaveLength(before+1)
    const row=operation==='publish'?t.registry.db.prepare('SELECT state FROM github_changes WHERE id=?').get(prepared.id):t.registry.db.prepare('SELECT state FROM github_change_updates').get()
    expect(row?.state).toBe(operation==='publish'?'push_planned':'unknown')
    expect(readdirSync(join(t.home,'trusted-git')).filter(name=>name.startsWith('.auth-'))).toEqual([])
  },20000)
  it('preserves a real successful PR POST receipt when cancellation happens immediately after its ACK',async()=>{
    const t=await fixture(),prepared=await t.changes.prepare({...t.actor,repo:'org/demo'}),abort=new AbortController()
    writeFileSync(join(prepared.dir,'README.md'),'change\n');const inspected=await t.changes.inspect({...t.actor,dir:prepared.dir})
    const original=t.github.api.bind(t.github)
    vi.spyOn(t.github,'api').mockImplementation(async(...args)=>{const result=await original(...args);if(args[0]==='POST'&&args[1].endsWith('/pulls'))abort.abort();return result})
    await expect(t.changes.publish({...t.actor,dir:prepared.dir,title:'test: real ACK',body:'synthetic',expectedSnapshot:inspected.snapshot,signal:abort.signal})).rejects.toThrow()
    expect(t.registry.db.prepare('SELECT state,pr_number FROM github_changes WHERE id=?').get(prepared.id)).toMatchObject({state:'pr_sent',pr_number:1})
    expect(t.requests.filter(request=>request.method==='POST'&&request.url.endsWith('/pulls'))).toHaveLength(1)
  })
})
