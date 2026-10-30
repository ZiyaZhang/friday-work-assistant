import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RuntimeContextError, RuntimeContexts } from '../src/core/runtime-contexts.js'
import { Spaces } from '../src/core/space.js'
import { PolicyService } from '../src/core/policy.js'
import { ManagedMemoryStorage } from '../src/core/managed-memory-storage.js'
import { PersonalMemoryReader } from '../src/core/personal-memory-reader.js'
import { PersonalMemoryAccess } from '../src/core/personal-memory-access.js'
import { UserTokenStore, type TokenExchange } from '../src/feishu/oauth.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

/** Real SQLite, token lease, authorization service and reader; only platform replies are synthetic. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-managed-context-')), path = join(dir, 'db')
  let now = 1_000_000, serial = 0
  let registry = new Registry(path), memory = new ChannelMemory(registry.db), attempts = new RunAttempts(registry.db)
  let contexts = new RuntimeContexts(registry.db, () => now), spaces = new Spaces(registry.db, () => now)
  const grant: TokenExchange = { accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH',
    expiresIn: 7200, refreshTokenExpiresIn: 86400,
    scope: 'im:message:readonly im:message.group_msg:get_as_user im:chat:readonly' }
  const provider = { exchangeCode: vi.fn(async () => grant), refresh: vi.fn(async () => grant) }
  let tokens = new UserTokenStore(registry.db, provider, () => now)
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm_alice', openId: 'ou_alice' })
  const actor = { spaceId: dm.id, openId: 'ou_alice' }, scope = `space:${dm.id}`
  const feishu = { whoAmI: vi.fn(async () => ({ openId: 'ou_alice', tenantKey: 'tenant-synthetic' })),
    listChatsResult: vi.fn(async () => ({ items: [{ chatId: 'oc_group', name: 'SYNTHETIC_GROUP' }], complete: true })) }
  const connect = () => tokens.complete({ openId: actor.openId, code: 'synthetic-code', redirectUri: 'https://callback.invalid' })
  await connect()
  cleanup.push(() => { registry.close(); rmSync(dir, { recursive: true, force: true }) })
  const run = (sessionKey = 'session-alice', acpId = 'acp-alice', openId = actor.openId) => {
    if (!registry.getSession(sessionKey)) registry.createSession({ sessionKey, chatId: 'oc_dm_alice', chatType: 'p2p', cwd: dir, requesterOpenId: openId })
    const task = registry.createTask({ sessionKey, messageId: `om-${++serial}`, prompt: 'synthetic request', requesterOpenId: openId })
    const attempt = attempts.begin({ workKey: `task:${task.id}`, sessionKey, triggerKey: `task:${task.id}`,
      stage: 'task', taskId: task.id, actorOpenId: openId, now }, () => registry.startTask(task.id, now, sessionKey))!
    attempts.bindRuntime(attempt.id, acpId)
    return attempt
  }
  const note = (title = 'managed note') => memory.add({ scope, kind: 'fact', title, body: `SYNTHETIC_BODY ${title}`,
    provenance: { state: 'verified', originRunId: 'synthetic-origin', sources: [{ ref: `message:${title}`,
      appId: 'app-synthetic', tenantId: 'tenant-synthetic', spaceId: null, chatId: 'oc_group',
      readIdentity: { kind: 'user', openId: actor.openId }, readAt: now, coverage: 'complete' }] } })
  const read = (runId: string, query = '', limit = 8) => {
    const access = new PersonalMemoryAccess({ appId: 'app-synthetic', spaces, policy: new PolicyService(spaces, { admins: [] }), userTokens: tokens, feishu })
    const reader = new PersonalMemoryReader(new ManagedMemoryStorage(registry.db), access)
    return reader.search({ ...actor, runId }, { query, limit, purpose: 'history' }, () => {
      if (!attempts.isCurrent(runId)) throw new RuntimeContextError('run_ineligible')
    })
  }
  return { get db() { return registry.db }, get memory() { return memory }, get attempts() { return attempts },
    get contexts() { return contexts }, get tokens() { return tokens }, get spaces() { return spaces },
    actor, scope, run, note, read, connect, provider, grant, feishu, time: (value: number) => { now = value },
    reopen() {
      registry.close(); registry = new Registry(path); memory = new ChannelMemory(registry.db)
      attempts = new RunAttempts(registry.db); contexts = new RuntimeContexts(registry.db, () => now)
      spaces = new Spaces(registry.db, () => now); tokens = new UserTokenStore(registry.db, provider, () => now)
    } }
}

describe('managed memory proofs bound to actual runtime consumption', () => {
  it('rejects a mixed read without proof atomically, then admits an actual authorized reader result', async () => {
    const t = await fixture(), run = t.run(), managed = t.note()
    const legacy = t.memory.add({ scope: t.scope, kind: 'fact', title: 'legacy', body: 'legacy body' })
    t.contexts.bind(run.id, run.sessionKey, 'acp-alice')
    expect(() => t.contexts.recordRead(run.id, [legacy, managed])).toThrow(RuntimeContextError)
    expect(t.contexts.get('acp-alice')?.notes).toEqual([])
    const read = await t.read(run.id)
    expect(read.proof.refs).toEqual([{ id: managed.id, revision: 1 }])
    t.contexts.admit(run.id, read.proof)
    t.contexts.recordRead(run.id, [legacy, managed])
    expect(t.contexts.get('acp-alice')?.notes).toEqual([managed, legacy].map(({ id, revision }) => ({ id, revision })))
    expect(t.contexts.isEligible(run.id, true)).toBe(true)
    expect(t.contexts.canResume(run.sessionKey, 'acp-alice', run.id)).toBe(true)
    expect(t.contexts.canResume(run.sessionKey, 'acp-alice')).toBe(false)
    expect(JSON.stringify(t.contexts.get('acp-alice'))).not.toMatch(/SYNTHETIC_BODY|SYNTHETIC_ACCESS/)
  })

  it('does not treat authorization of all metadata as permission to consume a note outside the returned proof', async () => {
    const t = await fixture(), run = t.run(), first = t.note('first'), second = t.note('second')
    t.contexts.bind(run.id, run.sessionKey, 'acp-alice')
    const read = await t.read(run.id, '', 1)
    expect(read.total).toBe(2)
    expect(read.notes).toHaveLength(1)
    t.contexts.admit(run.id, read.proof)
    const uncovered = read.notes[0].id === first.id ? second : first
    expect(() => t.contexts.recordRead(run.id, [read.notes[0], uncovered])).toThrow(RuntimeContextError)
    expect(t.contexts.get('acp-alice')?.notes).toEqual([])
    t.contexts.recordRead(run.id, read.notes)
    expect(t.contexts.get('acp-alice')?.notes).toEqual(read.proof.refs)
  })

  it.each(['token-expiry', 'grant-replaced', 'disconnected'] as const)('rechecks the real authorization lease after %s without changing durable consumption', async change => {
    const t = await fixture(), run = t.run(), note = t.note()
    t.contexts.bind(run.id, run.sessionKey, 'acp-alice')
    const read = await t.read(run.id)
    t.contexts.admit(run.id, read.proof); t.contexts.recordRead(run.id, [note])
    const before = t.contexts.get('acp-alice')
    if (change === 'token-expiry') t.time(t.tokens.get(t.actor.openId)!.expiresAt)
    else if (change === 'disconnected') t.tokens.disconnect(t.actor.openId)
    else { t.provider.exchangeCode.mockResolvedValue({ ...t.grant, accessToken: 'SYNTHETIC_REPLACEMENT' }); await t.connect() }
    expect(() => read.proof.assertCurrent()).toThrow()
    expect(t.contexts.isEligible(run.id, true)).toBe(false)
    expect(t.contexts.canResume(run.sessionKey, 'acp-alice', run.id)).toBe(false)
    expect(() => t.contexts.recordRead(run.id, [])).toThrow(RuntimeContextError)
    expect(() => t.contexts.admit(run.id, read.proof)).toThrow()
    expect(t.contexts.get('acp-alice')).toEqual(before)
  })

  it('requires a fresh proof for the next Run and release removes eligibility without deleting history', async () => {
    const t = await fixture(), first = t.run(), note = t.note()
    t.contexts.bind(first.id, first.sessionKey, 'acp-alice')
    const old = await t.read(first.id)
    t.contexts.admit(first.id, old.proof); t.contexts.recordRead(first.id, [note])
    t.attempts.finish(first.id, 'completed', 2_000_000)
    const next = t.run()
    expect(t.contexts.canResume(next.sessionKey, 'acp-alice', next.id)).toBe(false)
    expect(() => t.contexts.bind(next.id, next.sessionKey, 'acp-alice')).toThrow(RuntimeContextError)
    expect(() => t.contexts.admit(next.id, old.proof)).toThrow()
    expect(t.contexts.contextForRun(next.id)).toBeUndefined()
    const fresh = await t.read(next.id)
    t.contexts.admit(next.id, fresh.proof)
    expect(t.contexts.canResume(next.sessionKey, 'acp-alice', next.id)).toBe(true)
    t.contexts.bind(next.id, next.sessionKey, 'acp-alice')
    t.contexts.release(next.id)
    expect(t.contexts.isEligible(next.id, true)).toBe(false)
    expect(t.contexts.contextForRun(next.id)?.notes).toEqual([{ id: note.id, revision: 1 }])
  })

  it('cannot lend a still-current proof from one Run to another simultaneously active Session', async () => {
    const t = await fixture(), first = t.run(), other = t.run('session-other', 'acp-other', 'ou_other'), note = t.note()
    t.contexts.bind(first.id, first.sessionKey, 'acp-alice')
    t.contexts.bind(other.id, other.sessionKey, 'acp-other')
    const read = await t.read(first.id)
    read.proof.assertCurrent()
    expect(() => t.contexts.admit(other.id, read.proof)).toThrow()
    expect(() => t.contexts.recordRead(other.id, [note])).toThrow(RuntimeContextError)
    expect(t.contexts.get('acp-other')?.notes).toEqual([])
  })

  it('persists consumed versions across SQLite reopen but restores no authorization from the database', async () => {
    const t = await fixture(), run = t.run(), note = t.note()
    t.contexts.bind(run.id, run.sessionKey, 'acp-alice')
    const old = await t.read(run.id)
    t.contexts.admit(run.id, old.proof); t.contexts.recordRead(run.id, [note])
    const before = t.contexts.get('acp-alice')
    t.reopen()
    expect(t.contexts.get('acp-alice')).toEqual(before)
    expect(t.contexts.canResume(run.sessionKey, 'acp-alice', run.id)).toBe(false)
    expect(t.contexts.isEligible(run.id, true)).toBe(false)
    expect(() => t.contexts.recordRead(run.id, [])).toThrow(RuntimeContextError)
    const fresh = await t.read(run.id)
    t.contexts.admit(run.id, fresh.proof)
    expect(t.contexts.canResume(run.sessionKey, 'acp-alice', run.id)).toBe(true)
    expect(t.contexts.isEligible(run.id, true)).toBe(true)
    t.contexts.recordRead(run.id, [])
  })

  it('rejects a revision changed after authorization and never revives an explicitly invalidated context', async () => {
    const t = await fixture(), run = t.run(), note = t.note()
    t.contexts.bind(run.id, run.sessionKey, 'acp-alice')
    const stale = await t.read(run.id)
    t.memory.confirm(note.id, t.scope, { by: t.actor.openId, messageId: 'om_confirm' })
    expect(() => t.contexts.admit(run.id, stale.proof)).toThrow()
    expect(() => t.contexts.recordRead(run.id, [note])).toThrow(RuntimeContextError)
    expect(t.contexts.get('acp-alice')?.notes).toEqual([])
    const fresh = await t.read(run.id)
    t.contexts.admit(run.id, fresh.proof); t.contexts.recordRead(run.id, fresh.notes)
    expect(t.contexts.get('acp-alice')?.notes).toEqual([{ id: note.id, revision: 2 }])
    t.memory.remove(note.id, t.scope)
    expect(t.contexts.invalidate(t.memory.changes())).toEqual([run.id])
    expect(t.contexts.get('acp-alice')?.state).toBe('invalidated')
    const empty = await t.read(run.id)
    t.contexts.admit(run.id, empty.proof)
    expect(t.contexts.canResume(run.sessionKey, 'acp-alice', run.id)).toBe(false)
    expect(() => t.contexts.bind(run.id, run.sessionKey, 'acp-alice')).toThrow(RuntimeContextError)
  })

  it('retains the existing legacy read path without managed proof, including after reopen', async () => {
    const t = await fixture(), run = t.run()
    const note = t.memory.add({ scope: t.scope, kind: 'fact', title: 'legacy', body: 'not reclassified as verified' })
    t.contexts.bind(run.id, run.sessionKey, 'acp-alice'); t.contexts.recordRead(run.id, [note])
    t.contexts.release(run.id)
    t.reopen()
    expect(t.contexts.canResume(run.sessionKey, 'acp-alice')).toBe(true)
    expect(t.contexts.isEligible(run.id, true)).toBe(true)
    expect(t.memory.getProvenance(note.id)?.state).toBe('legacy_unverified')
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
  })
})
