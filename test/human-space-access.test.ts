import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HumanSpaceAccess, type HumanSpaceActor } from '../src/core/human-space-access.js'
import { ConsoleSessionStore } from '../src/core/console-sessions.js'
import { PolicyService, type PolicyOptions } from '../src/core/policy.js'
import { dmSpaceId, Spaces } from '../src/core/space.js'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

const actor: HumanSpaceActor = { sessionId: 'browser-session', appId: 'app', tenantKey: 'tenant', openId: 'alice', name: 'Alice', createdAt: 1, expiresAt: 100_000 }
function setup(options: PolicyOptions = { admins: [] }) {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const spaces = new Spaces(db), policy = new PolicyService(spaces, options)
  const members = new Map<string, Set<string>>()
  let sessionValid = true
  const sessionError = Object.assign(new Error('请重新登录'), { status: 401, code: 'session_expired' })
  const assertActor = vi.fn((current: HumanSpaceActor) => {
    if (!sessionValid || current.sessionId !== actor.sessionId || current.openId !== actor.openId ||
      current.appId !== actor.appId || current.tenantKey !== actor.tenantKey) throw sessionError
  })
  const feishu = { chatMemberOpenIds: vi.fn(async (chatId: string, _opts?: { fresh?: boolean }) => members.get(chatId) ?? new Set<string>()) }
  const access = new HumanSpaceAccess({ spaces, policy, feishu, assertActor })
  const group = (chatId = 'group-a', role: 'member' | 'owner' = 'member') => {
    const space = spaces.ensure({ kind: 'group', chatId, openId: 'original-owner', title: `PRIVATE_${chatId}` })
    spaces.addMember(space.id, actor.openId, role)
    members.set(chatId, new Set([actor.openId, 'original-owner']))
    return space
  }
  const snapshot = () => JSON.stringify({
    rooms: db.prepare('SELECT * FROM space_rooms ORDER BY id').all(),
    members: db.prepare('SELECT * FROM space_members ORDER BY space_id,open_id').all(),
    defaults: db.prepare('SELECT * FROM user_defaults ORDER BY open_id').all(),
  })
  return { db, spaces, policy, members, access, feishu, group, snapshot, assertActor, sessionError,
    logout: () => { sessionValid = false } }
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('authenticated human Space access', () => {
  it('reads only existing own DM/local group and performs no GET-time business writes', async () => {
    const t = setup(), group = t.group(), dm = t.spaces.dm(actor.openId)
    const before = t.snapshot()
    const dmRead = await t.access.authorize(actor, dm.id, { operation: 'read' })
    expect(dmRead).toMatchObject({ space: { id: dm.id, chatId: null }, role: 'owner' })
    expect(t.feishu.chatMemberOpenIds).not.toHaveBeenCalled()
    expect(await t.access.authorize(actor, group.id, { operation: 'read' })).toMatchObject({ role: 'member', space: { id: group.id } })
    expect(t.feishu.chatMemberOpenIds).toHaveBeenCalledExactlyOnceWith(group.chatId, { fresh: true })
    expect(t.snapshot()).toBe(before)
    const noDm = setup()
    expect(await noDm.access.list(actor)).toEqual([])
    expect(noDm.spaces.get(dmSpaceId(actor.openId))).toBeUndefined()
  })

  it('conceals another person DM even with a local role, deployment admin and auto policy', async () => {
    const t = setup({ admins: [actor.openId], mode: 'auto' }), other = t.spaces.dm('bob')
    t.spaces.addMember(other.id, actor.openId, 'owner')
    await expect(t.access.authorize(actor, other.id, { operation: 'read' })).rejects.toMatchObject({ status: 404, code: 'space_not_found' })
    await expect(t.access.authorize(actor, 'unknown-space', { operation: 'read' })).rejects.toMatchObject({ status: 404 })
    expect(await t.access.list(actor)).toEqual([])
    expect(t.feishu.chatMemberOpenIds).not.toHaveBeenCalled()
  })

  it('requires both local membership and fresh remote membership despite admin/auto', async () => {
    const t = setup({ admins: [actor.openId], mode: 'auto' }), group = t.group()
    t.spaces.removeMember(group.id, actor.openId)
    await expect(t.access.authorize(actor, group.id, { operation: 'configure' })).rejects.toMatchObject({ status: 404 })
    expect(t.feishu.chatMemberOpenIds).not.toHaveBeenCalled()
    t.spaces.addMember(group.id, actor.openId, 'member')
    t.members.set(group.chatId!, new Set())
    await expect(t.access.authorize(actor, group.id, { operation: 'configure' })).rejects.toMatchObject({ status: 403, code: 'not_group_member' })
    expect(await t.access.list(actor)).toEqual([])
  })

  it('keeps member read rights but does not let auto grant member configuration or recovery', async () => {
    const t = setup({ admins: [], mode: 'auto' }), group = t.group()
    expect((await t.access.authorize(actor, group.id, { operation: 'read' })).role).toBe('member')
    await expect(t.access.authorize(actor, group.id, { operation: 'configure' })).rejects.toMatchObject({ code: 'operation_forbidden' })
    t.spaces.suspend(group.id)
    await expect(t.access.authorize(actor, group.id, { operation: 'resume' })).rejects.toMatchObject({ code: 'operation_forbidden' })
    t.spaces.addMember(group.id, actor.openId, 'owner')
    expect((await t.access.authorize(actor, group.id, { operation: 'resume' })).space.status).toBe('archived')
    const admin = setup({ admins: [actor.openId] }), adminGroup = admin.group()
    expect((await admin.access.authorize(actor, adminGroup.id, { operation: 'configure' })).role).toBe('member')
  })

  it('makes archived reads explicit, permits authorized recovery and never resumes on read', async () => {
    const t = setup(), group = t.group('archived', 'owner')
    t.spaces.suspend(group.id)
    const before = t.snapshot()
    await expect(t.access.authorize(actor, group.id, { operation: 'read' })).rejects.toMatchObject({ status: 409, code: 'space_archived' })
    await expect(t.access.authorize(actor, group.id, { operation: 'configure' })).rejects.toMatchObject({ code: 'space_archived' })
    expect((await t.access.authorize(actor, group.id, { operation: 'read', allowArchived: true })).space.status).toBe('archived')
    expect((await t.access.authorize(actor, group.id, { operation: 'resume' })).space.status).toBe('archived')
    expect(t.snapshot()).toBe(before)
  })

  it('lists existing active and archived memberships while excluding left/unrelated groups', async () => {
    const t = setup(), active = t.group('active'), archived = t.group('archived'), left = t.group('left')
    t.spaces.suspend(archived.id)
    t.members.set(left.chatId!, new Set())
    const unrelated = t.spaces.ensure({ kind: 'group', chatId: 'unrelated', openId: 'bob', title: 'SECRET_UNRELATED' })
    t.members.set(unrelated.chatId!, new Set([actor.openId]))
    const before = t.snapshot(), rows = await t.access.list(actor)
    expect(rows.map(row => row.space.id).sort()).toEqual([active.id, archived.id].sort())
    expect(JSON.stringify(rows)).not.toContain('SECRET_UNRELATED')
    expect(t.feishu.chatMemberOpenIds.mock.calls.every(([, options]) => options?.fresh === true)).toBe(true)
    expect(t.feishu.chatMemberOpenIds).toHaveBeenCalledTimes(3)
    expect(t.snapshot()).toBe(before)
  })

  it('distinguishes unavailable membership from a successful empty list without leaking platform errors', async () => {
    const t = setup(), group = t.group()
    t.feishu.chatMemberOpenIds.mockRejectedValue(new Error('PLATFORM_TOKEN_AND_PRIVATE_GROUP_NAME'))
    const result = await t.access.list(actor).catch(error => error)
    expect(result).toMatchObject({ status: 503, code: 'membership_unavailable' })
    expect(result.message).not.toContain('PLATFORM_')
    expect(result.message).not.toContain(group.title)
    t.feishu.chatMemberOpenIds.mockResolvedValue(new Set())
    expect(await t.access.list(actor)).toEqual([])
  })

  it.each(['resolve', 'reject'] as const)('rejects logout while membership is waiting (%s)', async outcome => {
    const t = setup(), group = t.group(), wait = deferred<Set<string>>()
    t.feishu.chatMemberOpenIds.mockReturnValue(wait.promise)
    const pending = t.access.authorize(actor, group.id, { operation: 'read' })
    t.logout()
    if (outcome === 'resolve') wait.resolve(new Set([actor.openId]))
    else wait.reject(new Error('platform error'))
    await expect(pending).rejects.toBe(t.sessionError)
  })

  it.each(['logout', 'expire'] as const)('checks the actual browser session store after a membership await (%s)', async change => {
    const t = setup(), group = t.group(), wait = deferred<Set<string>>()
    let now = 1_000
    const sessions = new ConsoleSessionStore(t.db, { now: () => now, ttlMs: 500 })
    const { actor: browserActor } = sessions.create({ appId: 'app', tenantKey: 'tenant', openId: 'alice', name: null })
    const access = new HumanSpaceAccess({ spaces: t.spaces, policy: t.policy, feishu: t.feishu,
      assertActor: current => { if (!sessions.isCurrent(current)) throw t.sessionError } })
    t.feishu.chatMemberOpenIds.mockReturnValue(wait.promise)
    const pending = access.authorize(browserActor, group.id, { operation: 'read' })
    if (change === 'logout') sessions.revoke(browserActor.sessionId)
    else now = 1_500
    wait.resolve(new Set(['alice']))
    await expect(pending).rejects.toBe(t.sessionError)
  })

  it('rejects a changed binding after checking membership of the old chat', async () => {
    const t = setup(), group = t.group(), wait = deferred<Set<string>>()
    t.feishu.chatMemberOpenIds.mockReturnValue(wait.promise)
    const pending = t.access.authorize(actor, group.id, { operation: 'read' })
    t.spaces.rebind(group.id, 'replacement-chat')
    wait.resolve(new Set([actor.openId]))
    await expect(pending).rejects.toMatchObject({ status: 409, code: 'space_changed' })
  })

  it.each(['remove', 'change'] as const)('rejects local role %s during membership lookup', async change => {
    const t = setup(), group = t.group(), wait = deferred<Set<string>>()
    t.feishu.chatMemberOpenIds.mockReturnValue(wait.promise)
    const pending = t.access.authorize(actor, group.id, { operation: 'read' })
    if (change === 'remove') t.spaces.removeMember(group.id, actor.openId)
    else t.spaces.addMember(group.id, actor.openId, 'owner')
    wait.resolve(new Set([actor.openId]))
    await expect(pending).rejects.toMatchObject({ code: change === 'remove' ? 'space_not_found' : 'space_changed' })
  })

  it('rejects archive during an allowed archived read, but accepts fresh config/title updates', async () => {
    const t = setup(), group = t.group(), wait = deferred<Set<string>>()
    t.feishu.chatMemberOpenIds.mockReturnValueOnce(wait.promise)
    const pending = t.access.authorize(actor, group.id, { operation: 'read', allowArchived: true })
    t.spaces.suspend(group.id)
    wait.resolve(new Set([actor.openId]))
    await expect(pending).rejects.toMatchObject({ code: 'space_changed' })
    t.spaces.resume(group.chatId!)
    t.feishu.chatMemberOpenIds.mockImplementationOnce(async () => {
      t.spaces.patchConfig(group.id, { brevity: 'short' })
      t.db.prepare('UPDATE space_rooms SET title=? WHERE id=?').run('Latest title', group.id)
      return new Set([actor.openId])
    })
    const allowed = await t.access.authorize(actor, group.id, { operation: 'read' })
    expect(allowed.space).toMatchObject({ config: { brevity: 'short' }, title: 'Latest title' })
    t.spaces.patchConfig(group.id, { ack: 'none' })
    expect(allowed.assertCurrent().config).toEqual({ brevity: 'short', ack: 'none' })
    t.spaces.removeMember(group.id, actor.openId)
    expect(() => allowed.assertCurrent()).toThrowError(expect.objectContaining({ code: 'space_not_found' }))
  })

  it('revalidates earlier authorized list entries after later remote awaits', async () => {
    const t = setup(), first = t.group('first'), second = t.group('second')
    t.feishu.chatMemberOpenIds.mockImplementation(async chatId => {
      if (chatId === second.chatId) t.spaces.rebind(first.id, 'new-first-chat')
      return new Set([actor.openId])
    })
    await expect(t.access.list(actor)).rejects.toMatchObject({ code: 'space_changed' })
  })

  it('applies deployment policy after hard resource checks and rechecks the browser before returning a cached grant', async () => {
    const denied = setup({ admins: [actor.openId], mode: 'deny' }), group = denied.group('denied', 'owner')
    await expect(denied.access.authorize(actor, group.id, { operation: 'read' })).rejects.toMatchObject({ code: 'operation_forbidden' })
    expect(denied.feishu.chatMemberOpenIds).not.toHaveBeenCalled()
    const t = setup(), dm = t.spaces.dm(actor.openId)
    const access = await t.access.authorize(actor, dm.id, { operation: 'read' })
    t.logout()
    expect(() => access.assertCurrent()).toThrow(t.sessionError)
  })
})
