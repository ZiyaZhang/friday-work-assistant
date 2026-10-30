import { AxiosError } from 'axios'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelMemory, type MemoryAddInput } from '../src/core/memory.js'
import { MemoryRevisionConflict, type MemorySourceReference } from '../src/core/memory-provenance.js'
import { ManagedMemoryStorage } from '../src/core/managed-memory-storage.js'
import { PersonalMemoryAccess, PersonalMemoryAccessChanged } from '../src/core/personal-memory-access.js'
import { PersonalMemoryReader } from '../src/core/personal-memory-reader.js'
import { PolicyService } from '../src/core/policy.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RuntimeContexts } from '../src/core/runtime-contexts.js'
import { Spaces } from '../src/core/space.js'
import { UserTokenStore } from '../src/feishu/oauth.js'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
async function setup(db = new DatabaseSync(':memory:')) {
  databases.push(db)
  const memory = new ChannelMemory(db), spaces = new Spaces(db), policy = new PolicyService(spaces, { admins: [] })
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'alice' })
  const actor = { spaceId: dm.id, openId: 'alice', runId: 'run-synthetic' }, scope = `space:${dm.id}`
  const tokens = new UserTokenStore(db, { exchangeCode: async () => ({ accessToken: 'SYNTHETIC_ACCESS', expiresIn: 7200,
    scope: 'im:message:readonly im:message.group_msg:get_as_user' }), refresh: async () => { throw new Error('not expected') } })
  await tokens.complete({ openId: 'alice', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  const feishu = {
    whoAmI: vi.fn(async () => ({ openId: 'alice', tenantKey: 'tenant-a' })),
    listChatsResult: vi.fn(async () => ({ items: [{ chatId: 'chat-a', name: 'PRIVATE_GROUP_CANARY' }], complete: true })),
  }
  const access = new PersonalMemoryAccess({ appId: 'app-a', spaces, policy, userTokens: tokens, feishu })
  const batch = vi.spyOn(access, 'checkMany')
  const storage = new ManagedMemoryStorage(db), reader = new PersonalMemoryReader(storage, access)
  let active = true
  const assertRun = () => { if (!active) throw new Error('run stopped') }
  const source = (patch: Partial<MemorySourceReference> = {}): MemorySourceReference => ({
    ref: 'message:chat-a:message-a', appId: 'app-a', tenantId: 'tenant-a', spaceId: null, chatId: 'chat-a',
    messageId: 'message-a', readIdentity: { kind: 'user', openId: 'alice' }, readAt: 100, coverage: 'complete', ...patch,
  })
  const add = (input: Partial<MemoryAddInput> = {}, sources = [source()]) => memory.add({ scope, kind: 'fact',
    title: 'synthetic match', body: '正文匹配 BODY_CANARY', provenance: { state: 'verified', originRunId: 'origin', sources }, ...input })
  const read = (query = '', limit = 30, purpose: 'history'|'prompt' = 'history') => reader.search(actor, { query, limit, purpose }, assertRun)
  const snapshot = () => ['memory_notes','memory_provenance','memory_changes','memory_tombstones','user_tokens']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
  return { db, memory, spaces, dm, actor, scope, tokens, feishu, access, batch, storage, reader, source, add, read,
    assertRun, snapshot, stop: () => { active = false } }
}

describe('managed-memory authorization before body, count, and limit', () => {
  it.each(['', 'synthetic', '匹配'])('filters before count/limit for query %j without changing old consumers', async query => {
    const t = await setup(), allowed = t.add(), alsoAllowed = t.add()
    for (let i=0; i<31; i++) t.add({}, [t.source({ chatId: 'chat-denied' })])
    t.add({ scope: 'space:someone-else' })
    t.add({ provenance: undefined })
    const before = t.snapshot(), result = await t.read(query, 1)
    expect(result.notes.map(note => note.id)).toEqual([alsoAllowed.id])
    expect(result.total).toBe(2); expect(result.denied).toHaveLength(31)
    expect(result.availability).toEqual({ inactiveNotes: 31, temporarilyUnavailableNotes: 0 })
    expect(result.proof.refs).toEqual([{ id: alsoAllowed.id, revision: 1 }])
    expect(result.proof.runId).toBe(t.actor.runId)
    expect(t.batch).toHaveBeenCalledTimes(1)
    expect(t.feishu.whoAmI).toHaveBeenCalledTimes(1); expect(t.feishu.listChatsResult).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(t.batch.mock.calls[0]![1])).not.toMatch(/BODY_CANARY|synthetic match|PRIVATE_GROUP_CANARY|SYNTHETIC_ACCESS/)
    expect(t.memory.get(allowed.id)).toBeUndefined()
    expect(t.memory.search(t.scope, '')).toHaveLength(1)
    expect(t.snapshot()).toEqual(before)
  })

  it('keeps independent valid entries despite malformed, unsupported, cross-actor/app/tenant, and revoked-source entries', async () => {
    const t = await setup(), good = t.add()
    const missing = t.add({}, [t.source({ chatId: null })])
    const app = t.add({}, [t.source({ readIdentity: { kind: 'app' } })])
    const actor = t.add({}, [t.source({ readIdentity: { kind: 'user', openId: 'bob' } })])
    const wrongApp = t.add({}, [t.source({ appId: 'app-b' })])
    const tenant = t.add({}, [t.source({ tenantId: 'tenant-b' })])
    const mixed = t.add({}, [t.source(), t.source({ chatId: 'chat-missing' })])
    const group = t.spaces.ensure({ kind: 'group', chatId: 'chat-old' }); t.spaces.suspend(group.id)
    const archived = t.add({}, [t.source({ spaceId: group.id, chatId: 'chat-old' })])
    const before = t.snapshot(), result = await t.read()
    expect(result.notes.map(note => note.id)).toEqual([good.id])
    expect(result.unavailable.map(note => note.id)).toEqual([missing.id,app.id])
    expect(result.denied.map(note => note.id)).toEqual([actor.id,wrongApp.id,tenant.id,mixed.id,archived.id])
    expect(t.feishu.whoAmI).toHaveBeenCalledTimes(1); expect(t.feishu.listChatsResult).toHaveBeenCalledTimes(1)
    expect(t.snapshot()).toEqual(before)
  })

  it('uses a partial page only as positive evidence and does not mutate either rejected category', async () => {
    const t = await setup(), good = t.add(), missing = t.add({}, [t.source({ chatId: 'chat-other' })])
    t.feishu.listChatsResult.mockResolvedValue({ items: [{ chatId: 'chat-a', name: 'a' }], complete: false })
    const before = t.snapshot(), result = await t.read()
    expect(result.notes.map(note => note.id)).toEqual([good.id]); expect(result.total).toBe(1)
    expect(result.denied).toEqual([])
    expect(result.unavailable).toEqual([{ id: missing.id, revision: 1, reason: 'chat_list_incomplete' }])
    expect(t.snapshot()).toEqual(before)
    t.feishu.listChatsResult.mockRejectedValue(new AxiosError('PRIVATE_ERROR_CANARY', 'ERR_NETWORK'))
    const failed = await t.read()
    expect(failed.notes).toEqual([]); expect(failed.total).toBe(0); expect(failed.unavailable).toHaveLength(2)
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_ERROR_CANARY')
    expect(t.snapshot()).toEqual(before)
  })

  it('excludes unconfirmed QA before prompt limit while keeping history and candidate facts', async () => {
    const t = await setup(), fact = t.add(), qa = t.add({ kind: 'qa', status: 'confirmed', confirmation: { by: 'alice', messageId: 'om_confirm', at: 1 } })
    for (let i=0; i<10; i++) t.add({ kind: 'qa' })
    const prompt = await t.read('',2,'prompt')
    expect(prompt.notes.map(note => note.id)).toEqual([qa.id,fact.id]); expect(prompt.total).toBe(2)
    const history = await t.read('',100,'history'); expect(history.total).toBe(12)
  })

  it.each(['revision','forget','unavailable','run','disconnect'] as const)('rejects %s changes during authority await before querying bodies', async change => {
    const t = await setup(), note = t.add(), entered = deferred(), release = deferred()
    t.feishu.whoAmI.mockImplementation(async () => { entered.resolve(); await release.promise; return { openId: 'alice', tenantKey: 'tenant-a' } })
    const query = vi.spyOn(t.storage,'search'), pending = t.read()
    await entered.promise
    if (change === 'revision') t.memory.confirm(note.id,t.scope,{by:'alice',messageId:'confirm',at:1,expectedRevision:1})
    else if (change === 'forget') t.memory.remove(note.id,t.scope,{expectedRevision:1})
    else if (change === 'unavailable') t.memory.invalidateSources({kind:'user',openId:'alice'})
    else if (change === 'run') t.stop()
    else t.tokens.disconnect('alice')
    release.resolve()
    await expect(pending).rejects.toThrow()
    expect(query).not.toHaveBeenCalled()
  })

  it('binds proof to captured run/actor and rechecks source, token, and note after return', async () => {
    const t = await setup(), note = t.add(), result = await t.read()
    t.actor.runId='different-run'; t.actor.openId='bob'; t.actor.spaceId='different-space'
    expect(result.proof.runId).toBe('run-synthetic'); result.proof.assertCurrent()
    t.memory.confirm(note.id,t.scope,{by:'alice',messageId:'confirm',at:1,expectedRevision:1})
    expect(() => result.proof.assertCurrent()).toThrow(MemoryRevisionConflict)
    const second = await setup(); second.add(); const read = await second.read()
    second.tokens.disconnect('alice')
    expect(() => read.proof.assertCurrent()).toThrow(PersonalMemoryAccessChanged)
  })

  it.each(['limit', 'query', 'candidate-qa'] as const)('keeps a consuming Run eligible when a note excluded by %s is corrected', async excludedBy => {
    const registry = new Registry(':memory:'), t = await setup(registry.db)
    const excluded = t.add(excludedBy === 'candidate-qa' ? { kind: 'qa' } : { title: 'unrelated', body: 'unrelated body' })
    const consumed = t.add({ title: 'selected-match', body: 'selected-match body' })
    const attempts = new RunAttempts(t.db), contexts = new RuntimeContexts(t.db)
    registry.createSession({ sessionKey: 'session-synthetic', chatId: 'oc_dm', chatType: 'p2p', cwd: '/synthetic', requesterOpenId: 'alice' })
    const task = registry.createTask({ sessionKey: 'session-synthetic', messageId: 'om-synthetic', requesterOpenId: 'alice', prompt: 'synthetic request' })
    const run = attempts.begin({ workKey: `task:${task.id}`, sessionKey: task.sessionKey, triggerKey: `task:${task.id}`,
      stage: 'task', taskId: task.id, actorOpenId: 'alice', now: 100 }, () => registry.startTask(task.id, 100, task.sessionKey))!
    attempts.bindRuntime(run.id, 'acp-synthetic'); contexts.bind(run.id, run.sessionKey, 'acp-synthetic')
    t.actor.runId = run.id
    const result = await t.read(excludedBy === 'query' ? 'selected-match' : '', excludedBy === 'limit' ? 1 : 30,
      excludedBy === 'candidate-qa' ? 'prompt' : 'history')
    expect(result.notes.map(note => note.id)).toEqual([consumed.id])
    contexts.admit(run.id, result.proof); contexts.recordRead(run.id, result.notes)
    t.add({ replaces: excluded.id, title: 'corrected unconsumed note', body: 'corrected body' })
    expect(contexts.isEligible(run.id, true)).toBe(true)
    expect(() => result.proof.assertCurrent()).not.toThrow()
    t.memory.confirm(consumed.id, t.scope, { by: 'alice', messageId: 'om-confirm', at: 101, expectedRevision: 1 })
    expect(contexts.isEligible(run.id, true)).toBe(false)
    expect(() => result.proof.assertCurrent()).toThrow(MemoryRevisionConflict)
  })

  it('still checks the entire metadata snapshot after authorization await, before filtering bodies', async () => {
    const t = await setup(), excluded = t.add({ title: 'unrelated', body: 'unrelated body' })
    t.add({ title: 'selected-match', body: 'selected-match body' })
    const entered = deferred(), release = deferred(), query = vi.spyOn(t.storage, 'search')
    t.feishu.whoAmI.mockImplementation(async () => { entered.resolve(); await release.promise; return { openId: 'alice', tenantKey: 'tenant-a' } })
    const pending = t.read('selected-match')
    await entered.promise
    t.memory.confirm(excluded.id, t.scope, { by: 'alice', messageId: 'om-confirm', at: 101, expectedRevision: 1 })
    release.resolve()
    await expect(pending).rejects.toThrow(MemoryRevisionConflict)
    expect(query).not.toHaveBeenCalled()
  })

  it('does no provider work with no managed rows, and a denied local target never reads bodies', async () => {
    const t = await setup()
    expect(await t.read()).toMatchObject({notes:[],total:0,denied:[],unavailable:[]})
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
    const note = t.add(); t.spaces.removeMember(t.dm.id,'alice')
    expect(await t.read()).toMatchObject({notes:[],total:0,denied:[{id:note.id,reason:'target_forbidden'}]})
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
  })

  it('does not disclose another personal scope even when only inactive notes remain', async () => {
    const t = await setup(), note = t.add({ scope: 'space:sp_dm_bob' })
    t.memory.invalidateSources({ kind: 'notes', refs: [note] })
    const count = vi.spyOn(t.storage, 'countUnavailable')
    await expect(t.reader.search({ ...t.actor, spaceId: 'sp_dm_bob' }, { query: '', limit: 1, purpose: 'history' }, t.assertRun))
      .rejects.toThrow('本人的个人记忆')
    expect(count).not.toHaveBeenCalled()
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
  })

  it.each(['missing','duplicate','foreign'] as const)('fails closed on %s batch decisions without interpreting it as a revocation', async bad => {
    const t = await setup(), note = t.add(), before = t.snapshot(), query = vi.spyOn(t.storage,'search')
    const value = {key:`${note.id}:1`,status:'allowed' as const}
    t.batch.mockResolvedValue({results:bad==='missing'?[]:bad==='duplicate'?[value,value]:[{...value,key:'foreign'}],assertCurrent:()=>{}})
    await expect(t.read()).rejects.toThrow('核验结果不完整')
    expect(query).not.toHaveBeenCalled(); expect(t.snapshot()).toEqual(before)
  })
})

describe('warm-context managed-memory preflight', () => {
  it('authorizes exact refs without reading any body and never widens to unrelated rows', async () => {
    const t = await setup(), note = t.add(), other=t.add(), query=vi.spyOn(t.storage,'search')
    const result = await t.reader.authorizeRefs(t.actor,[{id:note.id,revision:1}],t.assertRun)
    expect(result.proof.refs).toEqual([{id:note.id,revision:1}]); expect(result.proof.runId).toBe('run-synthetic')
    expect(result).not.toHaveProperty('notes'); expect(query).not.toHaveBeenCalled()
    expect(t.batch.mock.calls[0]![1].map(entry=>entry.key)).toEqual([`${note.id}:1`])
    expect(t.storage.metadata(t.scope).map(entry=>entry.id)).toEqual([note.id,other.id])
    expect(JSON.stringify(t.storage.metadata(t.scope))).not.toMatch(/BODY_CANARY|synthetic match/)
  })

  it.each(['newer','missing','legacy','other-scope'] as const)('never upgrades or admits a %s ref', async mode => {
    const t = await setup(), note=t.add(mode==='legacy'?{provenance:undefined}:mode==='other-scope'?{scope:'org'}:{})
    if(mode==='newer') t.memory.confirm(note.id,t.scope,{by:'alice',messageId:'om',at:1})
    if(mode==='missing') t.memory.remove(note.id,t.scope)
    await expect(t.reader.authorizeRefs(t.actor,[{id:note.id,revision:1}],t.assertRun)).rejects.toBeInstanceOf(MemoryRevisionConflict)
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
  })

  it('returns one denial separately from an allowed warm note, with no automatic invalidation', async () => {
    const t=await setup(), good=t.add(), bad=t.add({},[t.source({chatId:'missing'})]), before=t.snapshot()
    const result=await t.reader.authorizeRefs(t.actor,[good,bad],t.assertRun)
    expect(result.proof.refs).toEqual([{id:good.id,revision:1}])
    expect(result.denied).toEqual([{id:bad.id,revision:1,reason:'chat_not_accessible'}])
    expect(t.snapshot()).toEqual(before)
    t.tokens.disconnect('alice'); expect(()=>result.proof.assertCurrent()).toThrow(PersonalMemoryAccessChanged)
  })
})
