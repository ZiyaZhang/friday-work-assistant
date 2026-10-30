import { AxiosError } from 'axios'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionSourceAccess, type ExecutionSourceActor } from '../src/core/execution-source-access.js'
import { PersonalMemoryAccess } from '../src/core/personal-memory-access.js'
import { UserMessageReadAccess, UserMessageReadChanged } from '../src/core/user-message-read-lease.js'
import { Spaces } from '../src/core/space.js'
import { PolicyService } from '../src/core/policy.js'
import { Circles } from '../src/core/circles.js'
import type { SourceContext } from '../src/core/source-context.js'
import type { MemorySourceReference } from '../src/core/memory-provenance.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { FeishuApiError, type AsUser, type CalendarEvent } from '../src/feishu/client.js'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
async function setup(kind: 'p2p' | 'group' = 'p2p') {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const spaces = new Spaces(db), circles = new Circles(db), policy = new PolicyService(spaces, { admins: [] })
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'alice' })
  const original = spaces.ensure({ kind: 'group', chatId: 'oc_original', openId: 'alice' })
  const allied = spaces.ensure({ kind: 'group', chatId: 'oc_allied', openId: 'other-person' })
  circles.join('oc_original', 'team'); circles.join('oc_allied', 'team')
  const target = kind === 'p2p' ? dm : original
  const tokens = new UserTokenStore(db, { exchangeCode: async () => ({ accessToken: 'SYNTHETIC_SECRET_TOKEN', expiresIn: 7200,
    scope: 'im:message:readonly im:message.group_msg:get_as_user calendar:calendar:readonly docx:document:readonly' }),
    refresh: async () => { throw new Error('not expected') } })
  await tokens.complete({ openId: 'alice', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  const botGroups = ['oc_original', 'oc_allied'], userGroups = ['oc_original', 'oc_allied', 'oc_user_only']
  const feishu = {
    whoAmI: vi.fn(async () => ({ openId: 'alice', tenantKey: 'tenant-a' })),
    listChatsResult: vi.fn(async (as: AsUser = {}) => ({ items: (as.userToken ? userGroups : botGroups).map(chatId => ({ chatId, name: 'PRIVATE_GROUP_NAME' })), complete: true })),
    chatMemberOpenIds: vi.fn(async (chatId: string) => new Set(chatId === 'oc_allied' ? ['other-person'] : ['alice'])),
    readDocument: vi.fn(async () => ({ objType: 'docx', title: 'PRIVATE_DOC_TITLE', content: 'PRIVATE_DOC_BODY' })),
    listMyEvents: vi.fn(async () => [] as CalendarEvent[]),
  }
  const deps = { appId: 'app-a', spaces, policy, userTokens: tokens, feishu }
  const personalMemory = new PersonalMemoryAccess(deps), userReads = new UserMessageReadAccess(deps)
  let live = true, memoryCurrent = true, repoAllowed = true
  const scopes = ['org', `space:${target.id}`, ...(kind === 'group' ? ['circle:team'] : [])]
  const actor: ExecutionSourceActor = { runId: 'run-a', openId: 'alice', spaceId: target.id, chatId: target.chatId!,
    chatType: kind, acpSessionId: 'acp-original', readScopes: () => scopes,
    assertCurrent: () => { if (!live) throw new Error('RUN_STOPPED'); if (!memoryCurrent) throw new Error('MEMORY_REVISION_CHANGED') } }
  const source: SourceContext = { version: 1, acpSessionId: actor.acpSessionId, spaceId: actor.spaceId, chatId: actor.chatId,
    memoryScopes: [...scopes], chats: [], external: [], repositories: [], messageSources: [], personalMemoryComplete: true }
  const access = new ExecutionSourceAccess({ appId: 'app-a', spaces, policy, circles, feishu, personalMemory, userReads,
    repositoryAllowed: () => repoAllowed })
  const userSource = (patch: Partial<MemorySourceReference> = {}): MemorySourceReference => ({ ref: 'message:oc_user_only:om_source',
    appId: 'app-a', tenantId: 'tenant-a', spaceId: null, chatId: 'oc_user_only', messageId: 'om_source',
    readIdentity: { kind: 'user', openId: 'alice' }, coverage: 'complete', readAt: 1, ...patch })
  const addPersonal = () => { source.chats.push({ chatId: 'oc_user_only' }); source.messageSources!.push(userSource()) }
  const check = () => access.check(actor, source)
  const snapshot = () => JSON.stringify(['space_rooms', 'space_members', 'circles', 'user_tokens'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()))
  return { db, spaces, circles, policy, dm, original, allied, target, tokens, botGroups, userGroups, feishu, personalMemory, userReads,
    actor, source, access, scopes, userSource, addPersonal, check, snapshot, stop: () => { live = false },
    forget: () => { memoryCurrent = false }, revokeRepo: () => { repoAllowed = false } }
}

describe('execution source access', () => {
  it('checks Gmail with its own identity, without requiring Feishu OAuth, and retains a live revocation guard', async () => {
    const t = await setup(); t.tokens.disconnect('alice'); let connected = true
    const checkGmailSource = vi.fn(async (owner: string, ref: string, guard: () => void) => {
      expect(owner).toBe('alice'); expect(ref).toBe('gmail:123:1:abc'); guard()
      return () => { guard(); if (!connected) throw new Error('GMAIL_REVOKED') }
    })
    const access = new ExecutionSourceAccess({ appId: 'app-a', spaces: t.spaces, policy: t.policy, circles: t.circles,
      feishu: t.feishu, personalMemory: t.personalMemory, userReads: t.userReads, repositoryAllowed: () => true, checkGmailSource })
    t.source.external.push({ kind: 'gmail', ref: 'gmail:123:1:abc', personalOpenId: 'alice', access: 'user' })
    const allowed = await access.check(t.actor, t.source)
    expect(allowed.status).toBe('allowed'); allowed.assertCurrent()
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
    connected = false; expect(allowed.assertCurrent).toThrow()
    t.source.external[0]!.personalOpenId = 'bob'
    expect(await access.check(t.actor, t.source)).toMatchObject({ status: 'denied', reason: 'source_identity_mismatch' })
    expect(checkGmailSource).toHaveBeenCalledTimes(1)
  })
  it('binds private repository material to the verified owner and connection revision, never the team allowlist', async () => {
    const t = await setup(); let revision = 1
    const access = new ExecutionSourceAccess({ appId: 'app-a', spaces: t.spaces, policy: t.policy, circles: t.circles,
      feishu: t.feishu, personalMemory: t.personalMemory, userReads: t.userReads, repositoryAllowed: () => true,
      personalRepositoryAllowed: (owner, repo, receipts) => receipts?.some(r => r.owner === owner && r.repo === repo && r.revision === revision) ?? false })
    t.source.repositories = ['owner/private']
    expect(await access.check(t.actor, t.source)).toMatchObject({ status: 'denied', reason: 'repository_denied' })
    t.source.personalRepositories = [{ owner: 'bob', repo: 'owner/private', revision }]
    expect(await access.check(t.actor, t.source)).toMatchObject({ status: 'denied' })
    t.source.personalRepositories[0]!.owner = 'alice'
    const allowed = await access.check(t.actor, t.source)
    expect(allowed.status).toBe('allowed'); allowed.assertCurrent()
    revision++
    expect(() => allowed.assertCurrent()).toThrow(UserMessageReadChanged)
    expect(await access.check(t.actor, t.source)).toMatchObject({ status: 'denied', reason: 'repository_denied' })
  })

  it.each(['p2p', 'group'] as const)('authorizes a current %s link receipt without claiming a public page or using personal OAuth', async kind => {
    const t = await setup(kind), url = 'https://example.com/private/opaque?proof=capability'
    t.source.external.push({ kind: 'web', ref: url, access: 'link', linkGrant: { version: 1,
      runId: t.actor.runId, acpSessionId: t.actor.acpSessionId, spaceId: t.actor.spaceId,
      chatId: t.actor.chatId, chatType: kind, actorOpenId: t.actor.openId, messageId: 'original-message', requestUrl: url, fetchedUrl: url } })
    const current = await t.check()
    expect(current.status).toBe('allowed'); current.assertCurrent()
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
    expect(t.feishu.readDocument).not.toHaveBeenCalled()
    t.actor.runId = 'next-run'
    expect(await t.check()).toMatchObject({ status: 'unavailable', reason: 'web_link_grant_unconfirmed' })
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
  })

  it.each(['public', 'link', undefined] as const)('refuses legacy web access=%s for managed material and history import', async access => {
    const t = await setup()
    t.source.external.push({ kind: 'web', ref: 'https://example.com/private/opaque', access })
    expect(await t.check()).toMatchObject({ status: 'unavailable', reason: 'web_link_grant_unconfirmed' })
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
  })

  it('retains current membership and stop checks for current link material', async () => {
    const t = await setup('group'), url = 'https://example.com/page'
    t.source.external.push({ kind: 'web', ref: url, access: 'link', linkGrant: { version: 1,
      runId: t.actor.runId, acpSessionId: t.actor.acpSessionId, spaceId: t.actor.spaceId,
      chatId: t.actor.chatId, chatType: 'group', actorOpenId: t.actor.openId, messageId: 'original-message', requestUrl: url, fetchedUrl: url } })
    const current = await t.check(); expect(current.status).toBe('allowed')
    t.spaces.removeMember(t.actor.spaceId, t.actor.openId)
    expect(() => current.assertCurrent()).toThrow(UserMessageReadChanged)
    expect(await t.check()).toMatchObject({ status: 'denied', reason: 'target_forbidden' })
    t.stop(); await expect(t.check()).rejects.toThrow('RUN_STOPPED')
  })

  it('checks original host binding and read scopes without creating data or requiring memory-write permission', async () => {
    const t = await setup(), before = t.snapshot()
    const decide = t.policy.decide.bind(t.policy)
    vi.spyOn(t.policy, 'decide').mockImplementation(input => input.action === 'remember'
      ? { decision: 'deny', actor: 'owner', reason: 'read-only synthetic policy' } : decide(input))
    t.addPersonal()
    expect(await t.personalMemory.check({ spaceId: t.dm.id, openId: 'alice' }, t.source.messageSources!, t.actor.assertCurrent))
      .toMatchObject({ status: 'denied', reason: 'target_forbidden' })
    const result = await t.check()
    expect(result.status).toBe('allowed'); result.assertCurrent()
    expect(t.feishu.whoAmI).toHaveBeenCalledExactlyOnceWith('SYNTHETIC_SECRET_TOKEN')
    expect(t.feishu.listChatsResult).toHaveBeenCalledExactlyOnceWith({ userToken: 'SYNTHETIC_SECRET_TOKEN' }, { fresh: true, assertCurrent: expect.any(Function) })
    expect(t.snapshot()).toBe(before)
    expect(JSON.stringify(result)).toBe('{"status":"allowed"}')
  })

  it.each(['runId','acpSessionId','spaceId','chatId'] as const)('does not authorize a different %s from recorded material', async key => {
    const t = await setup()
    t.actor[key] = key === 'runId' ? '' : 'wrong-binding'
    expect(await t.check()).toMatchObject({ status: 'denied', reason: 'binding_changed' })
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
  })

  it('checks current memory read scopes and repository allowlist, not historical grants', async () => {
    const t = await setup(); t.source.repositories.push('owner/repo')
    const result = await t.check(); expect(result.status).toBe('allowed')
    t.revokeRepo(); expect(() => result.assertCurrent()).toThrow(UserMessageReadChanged)
    expect(await t.check()).toMatchObject({ status: 'denied', reason: 'repository_denied' })
    t.source.repositories = []; t.scopes.splice(0, 1)
    expect(await t.check()).toMatchObject({ status: 'denied', reason: 'read_scope_changed' })
  })

  it('preserves original-group and current-alliance read access without requiring membership in the other group', async () => {
    const t = await setup('group')
    t.source.chats.push({ chatId: 'oc_original', spaceId: t.original.id }, { chatId: 'oc_allied', spaceId: t.allied.id })
    const result = await t.check(); expect(result.status).toBe('allowed'); result.assertCurrent()
    expect(t.spaces.roleOf(t.allied.id, 'alice')).toBeUndefined()
    expect(t.feishu.chatMemberOpenIds).toHaveBeenCalledExactlyOnceWith('oc_original', { fresh: true })
    expect(t.feishu.listChatsResult).toHaveBeenCalledExactlyOnceWith({}, { fresh: true })
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
    t.circles.leave('oc_allied')
    expect(() => result.assertCurrent()).toThrow(UserMessageReadChanged)
    expect(await t.check()).toMatchObject({ status: 'denied', reason: 'source_outside_circle' })
  })

  it.each([true, false])('does not treat incomplete bot listings as loss of access (complete=%s)', async complete => {
    const t = await setup('group'); t.source.chats.push({ chatId: 'oc_allied', spaceId: t.allied.id })
    t.feishu.listChatsResult.mockResolvedValue({ items: [], complete })
    expect(await t.check()).toMatchObject({ status: complete ? 'denied' : 'unavailable', reason: complete ? 'chat_not_accessible' : 'chat_list_incomplete' })
  })

  it('does not claim actor revocation from the old membership port without completeness evidence', async () => {
    const t = await setup('group'); t.feishu.chatMemberOpenIds.mockResolvedValue(new Set())
    expect(await t.check()).toMatchObject({ status: 'unavailable', reason: 'membership_unconfirmed' })
  })

  it('supports explicit app sources only after current DM member and bot checks, not unknown historical identity', async () => {
    const t = await setup(); t.source.chats.push({ chatId: 'oc_original', spaceId: t.original.id })
    expect(await t.check()).toMatchObject({ status: 'unavailable', reason: 'source_identity_unknown' })
    t.source.messageSources!.push(t.userSource({ chatId: 'oc_original', spaceId: t.original.id, readIdentity: { kind: 'app' } }))
    expect((await t.check()).status).toBe('allowed')
    expect(t.feishu.whoAmI).not.toHaveBeenCalled()
    expect(t.feishu.chatMemberOpenIds).toHaveBeenCalledExactlyOnceWith('oc_original', { fresh: true })
    t.source.messageSources![0]!.appId = 'other-app'
    expect(await t.check()).toMatchObject({ status: 'denied', reason: 'source_app_mismatch' })
  })

  it('does not let another snapshot of a chat erase its older, now-rebound Space reference', async () => {
    const t = await setup('group')
    t.source.chats.push({ chatId: 'oc_allied', spaceId: t.allied.id })
    t.source.messageSources!.push(t.userSource({ chatId: 'oc_allied', spaceId: 'old-removed-space', readIdentity: { kind: 'app' } }),
      t.userSource({ chatId: 'oc_allied', spaceId: t.allied.id, readIdentity: { kind: 'app' } }))
    expect(await t.check()).toMatchObject({ status: 'denied', reason: 'source_binding_changed' })
    expect(t.feishu.chatMemberOpenIds).not.toHaveBeenCalled()
  })

  it('never brings personal-user material into a group runtime or authorizes a different user', async () => {
    const group = await setup('group'); group.addPersonal()
    expect(await group.check()).toMatchObject({ status: 'denied', reason: 'source_identity_mismatch' })
    const personal = await setup(); personal.addPersonal(); personal.source.messageSources![0]!.readIdentity = { kind: 'user', openId: 'bob' }
    expect(await personal.check()).toMatchObject({ status: 'denied', reason: 'source_actor_mismatch' })
    expect(personal.feishu.whoAmI).not.toHaveBeenCalled()
  })

  it('keeps temporary personal-source failures distinct from denial without falling back to the bot', async () => {
    const t = await setup(); t.addPersonal(); const before = t.snapshot()
    t.feishu.listChatsResult.mockRejectedValue(new AxiosError('PRIVATE_TEMPORARY_ERROR', 'ERR_NETWORK'))
    const result = await t.check()
    expect(result).toMatchObject({ status: 'unavailable', reason: 'chat_list_unavailable' })
    expect(t.snapshot()).toBe(before); expect(JSON.stringify(result)).not.toContain('PRIVATE_TEMPORARY_ERROR')
    expect(t.feishu.chatMemberOpenIds).not.toHaveBeenCalled()
    expect(t.feishu.listChatsResult).toHaveBeenCalledTimes(1)
  })

  it.each(['stop','memory','scope','space','token'] as const)('rejects %s changes during personal authorization before returning a guard', async change => {
    const t = await setup(), entered = deferred(), release = deferred(); t.addPersonal()
    t.feishu.whoAmI.mockImplementation(async () => { entered.resolve(); await release.promise; return { openId: 'alice', tenantKey: 'tenant-a' } })
    const pending = t.check(); await entered.promise
    if (change === 'stop') t.stop()
    else if (change === 'memory') t.forget()
    else if (change === 'scope') t.scopes.splice(0, 1)
    else if (change === 'space') t.spaces.suspend(t.dm.id)
    else t.tokens.disconnect('alice')
    release.resolve(); await expect(pending).rejects.toThrow()
    expect(t.feishu.listChatsResult).not.toHaveBeenCalled()
  })

  it('rejects an alliance change during a fresh membership await', async () => {
    const t = await setup('group'), entered = deferred(), release = deferred()
    t.source.chats.push({ chatId: 'oc_allied', spaceId: t.allied.id })
    t.feishu.chatMemberOpenIds.mockImplementation(async () => { entered.resolve(); await release.promise; return new Set(['alice']) })
    const pending = t.check(); await entered.promise; t.circles.leave('oc_allied'); release.resolve()
    await expect(pending).rejects.toThrow(UserMessageReadChanged)
    expect(t.feishu.listChatsResult).not.toHaveBeenCalled()
  })

  it('uses the original user for external docx/wiki/calendar rechecks and returns no retrieved data', async () => {
    const t = await setup(); t.addPersonal()
    t.source.external.push({ kind: 'document', ref: 'wiki:abc123', personalOpenId: 'alice' },
      { kind: 'document', ref: 'docx:xyz789', personalOpenId: 'alice' },
      { kind: 'calendar', ref: 'calendar:alice:100:1000', personalOpenId: 'alice' })
    const result = await t.check(); expect(result.status).toBe('allowed'); result.assertCurrent()
    expect(t.feishu.readDocument).toHaveBeenNthCalledWith(1, { kind: 'wiki', token: 'abc123' }, { userToken: 'SYNTHETIC_SECRET_TOKEN' })
    expect(t.feishu.readDocument).toHaveBeenNthCalledWith(2, { kind: 'docx', token: 'xyz789' }, { userToken: 'SYNTHETIC_SECRET_TOKEN' })
    expect(t.feishu.listMyEvents).toHaveBeenCalledExactlyOnceWith({ userToken: 'SYNTHETIC_SECRET_TOKEN' }, { startSec: 100, endSec: 1000 })
    expect(JSON.stringify(result)).toBe('{"status":"allowed"}')
    t.tokens.disconnect('alice'); expect(() => result.assertCurrent()).toThrow(UserMessageReadChanged)
  })

  it.each(['document','calendar'] as const)('does not require group-message capture scope to read a personal %s', async kind => {
    const t = await setup()
    t.db.prepare("UPDATE user_tokens SET scope='calendar:calendar:readonly docx:document:readonly' WHERE open_id='alice'").run()
    t.source.external.push({ kind, ref: kind === 'document' ? 'docx:abc' : 'calendar:alice:1:10', personalOpenId: 'alice' })
    expect((await t.check()).status).toBe('allowed')
    expect(t.feishu.listChatsResult).not.toHaveBeenCalled()
  })

  it.each(['identity','reference','unsupported-wiki','temporary','permission'] as const)('does not grant external material on %s failure or retry as app', async mode => {
    const t = await setup(); t.source.external.push({ kind: 'document', ref: 'docx:abc', personalOpenId: 'alice' })
    if (mode === 'identity') t.source.external[0]!.personalOpenId = undefined
    if (mode === 'reference') t.source.external[0]!.ref = 'unknown:abc'
    if (mode === 'unsupported-wiki') t.feishu.readDocument.mockResolvedValue({ objType: 'bitable', title: 'private', content: 'unsupported' })
    if (mode === 'temporary') t.feishu.readDocument.mockRejectedValue(new AxiosError('PRIVATE_PLATFORM_ERROR', 'ERR_NETWORK'))
    if (mode === 'permission') t.feishu.readDocument.mockRejectedValue(new FeishuApiError('docx.rawContent', 99991672, 'PRIVATE_PERMISSION_ERROR'))
    const result = await t.check()
    expect(result.status).toBe(mode === 'permission' ? 'denied' : 'unavailable')
    expect(t.feishu.readDocument).toHaveBeenCalledTimes(['identity','reference'].includes(mode) ? 0 : 1)
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|SYNTHETIC_SECRET/)
  })

  it.each(['logout', 'memory'] as const)('rejects %s during external recheck', async change => {
    const t = await setup(), entered = deferred(), release = deferred()
    t.source.external.push({ kind: 'document', ref: 'docx:abc', personalOpenId: 'alice' })
    t.feishu.readDocument.mockImplementation(async () => { entered.resolve(); await release.promise; return { objType: 'docx', content: 'PRIVATE_BODY' } })
    const pending = t.check(); await entered.promise
    if (change === 'logout') t.tokens.disconnect('alice'); else t.forget()
    release.resolve(); await expect(pending).rejects.toThrow()
    expect(t.feishu.readDocument).toHaveBeenCalledTimes(1)
  })

  it('captures actor and source data while retaining the live host guard', async () => {
    const t = await setup(); t.addPersonal()
    const result = await t.check()
    t.actor.openId = 'someone-else'; t.source.chats.push({ chatId: 'new-material' })
    expect(() => result.assertCurrent()).not.toThrow()
    t.stop(); expect(() => result.assertCurrent()).toThrow('RUN_STOPPED')
  })
})
