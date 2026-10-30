import { DatabaseSync } from 'node:sqlite'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { IssueLinks, type IssueOperationOrigin } from '../src/github/issues.js'
import { IngressClassifier, type IngressClassifierRuntime } from '../src/acp/ingress-classifier.js'
import { createLogger } from '../src/log.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { GitHubIdentity, loadGitHubConfig } from '../src/github/identity.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer, GROUP_SCOPES, PROACTIVE_SCOPES } from '../src/internal/tokens.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const origin = (runId = 'run-a'): IssueOperationOrigin => ({ version: 1, apiCallId: 'call-a',
  origin: { runId, taskId: 1, workKey: 'task:1', sessionKey: 'session-a', ownerOpenId: 'alice', spaceId: 'space-a', chatId: 'chat-a', chatType: 'group' },
  provenance: { memoryRefs: [], sources: { version: 1, acpSessionId: 'acp-a', spaceId: 'space-a', chatId: 'chat-a',
    memoryScopes: [], chats: [], external: [], repositories: ['org/demo'] } } })

function database() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE github_issue_operations (
    request_key TEXT PRIMARY KEY,signature TEXT NOT NULL,fingerprint TEXT,status TEXT NOT NULL,action TEXT NOT NULL,
    repo TEXT NOT NULL,number INTEGER,url TEXT,comment_url TEXT,result TEXT,error TEXT,created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,reconciliation TEXT);
    INSERT INTO github_issue_operations VALUES ('legacy','sig','fingerprint','confirmed','created','org/demo',42,
      'https://github.com/org/demo/issues/42',NULL,'{"repo":"org/demo","number":42}','old_error',1,2,'old_note')`)
  return db
}

describe('Issue origin migration and ACK ownership', () => {
  it('adds a nullable origin twice without changing old rows or inferring their owner', () => {
    const db = database()
    try {
      const before = db.prepare('SELECT * FROM github_issue_operations').all()
      new IssueLinks(db); new IssueLinks(db)
      const after = db.prepare('SELECT * FROM github_issue_operations').all().map(({ origin_json, ...row }) => {
        expect(origin_json).toBeNull(); return row
      })
      expect(after).toEqual(before)
      expect(db.prepare('PRAGMA table_info(github_issue_operations)').all().filter(row => row.name === 'origin_json')).toEqual([
        expect.objectContaining({ type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }) ])
      expect(db.prepare('PRAGMA index_list(github_issue_operations)').all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'idx_issue_operations_work' }), expect.objectContaining({ unique: 1, origin: 'pk' }) ]))
      expect(() => db.prepare('INSERT INTO github_issue_operations SELECT * FROM github_issue_operations LIMIT 1').run()).toThrow()
    } finally { db.close() }
  })

  it('reserves a frozen origin before ACK and never transfers it to a replaying caller', () => {
    const db = database(), links = new IssueLinks(db), saved = origin()
    try {
      const plan = { requestKey: 'new', signature: 'new-sig', action: 'created' as const, repo: 'org/demo', origin: saved }
      expect(links.planOperation(plan)).toBe(true)
      const json = db.prepare("SELECT origin_json FROM github_issue_operations WHERE request_key='new'").get()!.origin_json
      saved.origin.workKey = 'unrelated'
      expect(links.planOperation({ ...plan, origin: origin('another-run') })).toBe(false)
      links.sentOperation('new',42,'https://github.com/org/demo/issues/42')
      links.confirmOperation('new', { repo:'org/demo',number:42,url:'https://github.com/org/demo/issues/42',commentUrl:'' })
      expect(db.prepare("SELECT origin_json,status FROM github_issue_operations WHERE request_key='new'").get()).toEqual({ origin_json:json,status:'confirmed' })
      expect(JSON.parse(String(json))).toEqual(origin())
    } finally { db.close() }
  })

  it('retains the original reservation on unknown writes and releases only provably unsent operations', () => {
    const db=database(), links=new IssueLinks(db)
    try {
      for(const id of ['unknown','unsent']) links.planOperation({requestKey:id,signature:id,action:'created',repo:'org/demo',origin:origin()})
      links.unknownOperation('unknown','synthetic transport outcome')
      links.releaseUnsentOperation('unknown'); links.releaseUnsentOperation('unsent')
      expect(db.prepare("SELECT status,origin_json FROM github_issue_operations WHERE request_key='unknown'").get()).toEqual({status:'unknown',origin_json:JSON.stringify(origin())})
      expect(db.prepare("SELECT 1 FROM github_issue_operations WHERE request_key='unsent'").get()).toBeUndefined()
    } finally { db.close() }
  })
})

/** Run the actual classifier input snapshot and ACP protocol, not a mock schema. */
function classifier() {
  let listener: Parameters<IngressClassifierRuntime['subscribe']>[1] | undefined
  const runtime: IngressClassifierRuntime = {
    start: async () => {}, newSession: async () => 'router', stop: async () => {}, closeSession: async () => {},
    subscribe: (_id, next) => { listener=next;return ()=>{} },
    prompt: vi.fn(async () => {
      const update={sessionUpdate:'agent_message_chunk' as const,content:{type:'text' as const,text:JSON.stringify({kind:'amend',targetRef:'original'})}}
      listener?.(update,{sessionId:'router',update})
      return {stopReason:'end_turn' as const}
    }),
  }
  return new IngressClassifier({createRuntime:()=>runtime,cwd:'/tmp/synthetic-router',timeoutMs:1000,log:createLogger('issue-routing','error')})
}

describe('Issue and PR identities share the classifier contract', () => {
  it.each(['issue','pull_request'] as const)('accepts only the canonical host %s identity',async kind=>{
    const c=classifier()
    try {
      expect(await c.classify({message:{text:'继续这个交付物'},candidates:[{ref:'original',title:'original input',status:'done',deliverables:[{
        kind,repo:'org/demo',number:42,url:`https://github.com/org/demo/${kind==='issue'?'issues':'pull'}/42`}]}]})).toEqual({kind:'amend',targetRef:'original'})
    }finally{await c.stop()}
  })
  it.each([
    'https://github.com/other/repo/issues/42','https://github.com/org/demo/issues/43',
    'https://github.com/org/demo/pull/42','https://github.com/org/demo/issues/42?token=not-a-token',
    'https://evil.invalid/org/demo/issues/42',
  ])('rejects a mismatched Issue reference %s',async url=>{
    const c=classifier()
    try {
      await expect(c.classify({message:{text:'继续'},candidates:[{ref:'original',title:'original',status:'done',deliverables:[{
        kind:'issue',repo:'org/demo',number:42,url}]}]})).rejects.toMatchObject({code:'invalid_input'})
    }finally{await c.stop()}
  })
})

/** Signed HTTP with the actual Run ledger. A routine or proactive Run has no human Work that could own an Issue. */
describe('Issue writes require a task-stage Run', () => {
  it.each([['routine', 'open'], ['routine', 'comment'], ['proactive', 'open'], ['proactive', 'comment']] as const)(
    'refuses a %s Run %s with 403 and the reason, before any GitHub request or reservation', async (kind, route) => {
      const registry = new Registry(':memory:'), attempts = new RunAttempts(registry.db), sp = spaceDeps(registry.db)
      const space = sp.spaces.ensure({ kind: 'group', chatId: 'background-chat', openId: 'alice' })
      const actor = kind === 'routine' ? 'alice' : undefined, sessionKey = `${kind}:issue-write`
      registry.createSession({ sessionKey, chatId: space.chatId!, chatType: 'group', requesterOpenId: actor, cwd: '/tmp/issue-background-fixture' })
      const run = attempts.begin({ sessionKey, workKey: `${kind}:work`, triggerKey: `${kind}:issue`, stage: 'routine', actorOpenId: actor, now: Date.now() })!
      attempts.bindExecutionBoundary(run.id, 'managed_api_v1'); attempts.bindRuntime(run.id, `${kind}:acp`)
      const log = createLogger('issue-background-write', 'error'), feishu = asFeishuClient(new FakeFeishu()), cache = new MessageCache(registry.db)
      const tokens = new TokenIssuer('synthetic-background-signing')
      let providerRequests = 0, captures = 0
      const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'synthetic', FRIDAY_GITHUB_REPOS: 'org/demo', FRIDAY_GITHUB_WRITE_REPOS: 'org/demo' })!, log, {
        async request<T>(): Promise<{ status: number; data: T }> { providerRequests++; throw new Error('Unexpected provider request') },
      })
      const api = createInternalApi({ registry, ...sp, feishu, github, issueLinks: new IssueLinks(registry.db), tokens, log, messageCache: cache,
        memory: new ChannelMemory(registry.db), messages: new MessageService(feishu, cache, log), todos: new Todos(registry.db), maxHistoryPerCall: 20,
        resolveActorForSession: key => key === sessionKey && attempts.isCurrent(run.id) ? { runId: run.id, requesterOpenId: actor, stage: 'routine' } : undefined,
        canPublishToRepository: () => true,
        captureRepositoryIssueOrigin: () => { captures++; throw new Error('Unexpected origin capture') },
      })
      await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done))
      try {
        const token = tokens.issue({ sessionKey, runId: run.id, requesterOpenId: actor, spaceId: space.id, chatId: space.chatId!, chatType: 'group',
          scopes: kind === 'proactive' ? [...PROACTIVE_SCOPES] : [...GROUP_SCOPES] })
        const response = await fetch(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/github/issue/${route}`, { method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(route === 'open' ? { repo: 'org/demo', title: 'Synthetic issue', body: 'Synthetic body.' } : { repo: 'org/demo', number: 42, body: 'Synthetic comment.' }) })
        expect(response.status).toBe(403)
        expect(String((await response.json() as { error?: unknown }).error)).toContain(route === 'open' ? '例行/主动执行不能建 Issue' : '例行/主动执行不能评论 Issue')
        expect(providerRequests).toBe(0); expect(captures).toBe(0)
        expect(registry.db.prepare('SELECT count(*) AS n FROM github_issue_operations').get()?.n).toBe(0)
      } finally {
        api.beginShutdown(); api.server.closeAllConnections(); await new Promise<void>(done => api.server.close(() => done())); registry.close()
      }
    })
})
