/**
 * “等我拍板”的事要能由本人结清，而且只结清那一条。
 *
 * 改造前：POST /v1/inbox/decision 只会记，整个代码库没有任何地方结清 kind='decision' 的行
 * （resolveById 只有测试在用），Issue 有效性确认后记下的“请决定下一步”也一样；My Day 一直显示。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RoutineApplication } from '../src/core/routine-application.js'
import { RoutineStore } from '../src/core/routines.js'
import { Inbox, decisionRef } from '../src/core/inbox.js'
import { DatabaseSync } from 'node:sqlite'
import { DecisionApplication } from '../src/core/decision-application.js'
import { dmSpaceId } from '../src/core/space.js'
import { USER_SCOPE_TIERS, UserTokenStore } from '../src/feishu/oauth.js'
import { spaceDeps } from './helpers/space.js'

const NOW = 1_800_000_000_000
const QUESTION = '插件安装流程的优先级定 P1 还是 P2？'
const registries: Registry[] = []
afterEach(() => { for (const registry of registries.splice(0)) registry.close() })

function setup() {
  const registry = new Registry(':memory:')
  registries.push(registry)
  const inbox = new Inbox(registry.db)
  const routines = new RoutineStore(registry.db)
  const { spaces, policy } = spaceDeps(registry.db)
  const team = spaces.ensure({ kind: 'group', chatId: 'oc_team', openId: 'ou_alice' })
  spaces.addMember(team.id, 'ou_bob', 'member')
  const other = spaces.ensure({ kind: 'group', chatId: 'oc_other', openId: 'ou_alice' })
  const aliceDm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm_alice', openId: 'ou_alice' })
  let now = NOW
  const routineApp = new RoutineApplication({ registry, routines, spaces, policy, inbox, attempts: new RunAttempts(registry.db),
    activeRuns: () => [], now: () => now })
  const application = () => new DecisionApplication({ db: registry.db, inbox, spaces, routines: routineApp, now: () => now })
  const app = application()
  /** Inbox 层登记一条个人待决断（编号与 API 相同：含发起人）。API 先查找、默认不重开已结清的，见接口文档 §6。 */
  function ask(owner: string, spaceId: string, question = QUESTION) {
    return inbox.add({ ownerOpenId: owner, kind: 'decision', refId: decisionRef(spaceId, question, owner), spaceId, title: question, now })
  }
  function snapshot() {
    return ['inbox_items', 'routines'].map(table => registry.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  }
  const inTeam = { spaceId: team.id, chatType: 'group' as const }
  const inDm = { spaceId: aliceDm.id, chatType: 'p2p' as const }
  return { registry, inbox, routines, spaces, team, other, aliceDm, routineApp, app, application, ask, snapshot, inTeam, inDm,
    setNow: (value: number) => { now = value } }
}

describe('the owner settles exactly one pending decision', () => {
  it('“按 P2，不用再挂着了” settles only that item; the same question elsewhere and another person’s copy stay', () => {
    const t = setup()
    const mine = t.ask('ou_alice', t.team.id)
    const mineElsewhere = t.ask('ou_alice', t.other.id)
    const bobs = t.ask('ou_bob', t.team.id)
    const result = t.app.resolve({ itemId: mine.id, expectedVersion: mine.version, resolution: 'decided', note: '按 P2',
      operatorOpenId: 'ou_alice', context: t.inTeam })
    expect(result).toMatchObject({ outcome: 'resolved', changed: true,
      item: { id: mine.id, resolution: 'decided', resolvedBy: 'ou_alice', resolutionNote: '按 P2', resolvedAt: NOW } })
    expect(t.inbox.pending('ou_alice').map(i => i.id)).toEqual([mineElsewhere.id])
    expect(t.inbox.pending('ou_bob').map(i => i.id)).toEqual([bobs.id])
  })

  it('another member of the same group cannot close my item, and nothing changes', () => {
    const t = setup(), mine = t.ask('ou_alice', t.team.id)
    const before = t.snapshot()
    expect(t.app.resolve({ itemId: mine.id, expectedVersion: mine.version, resolution: 'dropped', operatorOpenId: 'ou_bob', context: t.inTeam }))
      .toMatchObject({ outcome: 'denied', code: 'not_owner', changed: false })
    expect(t.snapshot()).toEqual(before)
  })

  it('an item from one group cannot be closed from another group, but can from the owner’s private chat', () => {
    const t = setup(), mine = t.ask('ou_alice', t.team.id)
    const before = t.snapshot()
    expect(t.app.resolve({ itemId: mine.id, expectedVersion: mine.version, resolution: 'dropped', operatorOpenId: 'ou_alice',
      context: { spaceId: t.other.id, chatType: 'group' } })).toMatchObject({ outcome: 'denied', code: 'wrong_space' })
    expect(t.snapshot()).toEqual(before)
    expect(t.app.resolve({ itemId: mine.id, expectedVersion: mine.version, resolution: 'dropped', operatorOpenId: 'ou_alice', context: t.inDm }))
      .toMatchObject({ outcome: 'resolved', item: { resolution: 'dropped' } })
  })

  it('someone else’s private chat is not the owner’s private chat', () => {
    const t = setup(), mine = t.ask('ou_alice', t.team.id)
    const before = t.snapshot()
    expect(t.app.resolve({ itemId: mine.id, expectedVersion: mine.version, resolution: 'dropped', operatorOpenId: 'ou_alice',
      context: { spaceId: dmSpaceId('ou_bob'), chatType: 'p2p' } })).toMatchObject({ outcome: 'denied', code: 'wrong_space' })
    expect(t.snapshot()).toEqual(before)
  })

  it('from the group itself the space must still be active and the owner still a member', () => {
    const t = setup(), mine = t.ask('ou_alice', t.team.id)
    t.spaces.removeMember(t.team.id, 'ou_alice')
    const before = t.snapshot()
    expect(t.app.resolve({ itemId: mine.id, expectedVersion: mine.version, resolution: 'decided', operatorOpenId: 'ou_alice', context: t.inTeam }))
      .toMatchObject({ outcome: 'denied', code: 'not_member' })
    t.spaces.addMember(t.team.id, 'ou_alice', 'owner')
    t.spaces.suspend(t.team.id)
    expect(t.app.resolve({ itemId: mine.id, expectedVersion: mine.version, resolution: 'decided', operatorOpenId: 'ou_alice', context: t.inTeam }))
      .toMatchObject({ outcome: 'denied', code: 'space_inactive' })
    expect(t.snapshot()).toEqual(before)
  })

  it('a replay returns the recorded result; the opposite conclusion afterwards is a conflict, not an overwrite', () => {
    const t = setup(), mine = t.ask('ou_alice', t.team.id)
    const settle = (resolution: 'decided' | 'dropped', note?: string) => t.app.resolve({ itemId: mine.id, expectedVersion: mine.version, resolution, note,
      operatorOpenId: 'ou_alice', context: t.inDm })
    expect(settle('decided', '按 P2')).toMatchObject({ outcome: 'resolved', changed: true })
    const after = t.snapshot()
    t.setNow(NOW + 60_000)
    expect(settle('decided', '按 P2')).toMatchObject({ outcome: 'already_resolved', changed: false, item: { resolutionNote: '按 P2' } })
    expect(settle('dropped')).toMatchObject({ outcome: 'conflict', changed: false, item: { resolution: 'decided' } })
    expect(t.snapshot()).toEqual(after)
  })

  it('after a restart the same request finds the recorded result and the item does not come back', () => {
    const t = setup(), mine = t.ask('ou_alice', t.team.id)
    t.app.resolve({ itemId: mine.id, expectedVersion: mine.version, resolution: 'dropped', operatorOpenId: 'ou_alice', context: t.inDm })
    const after = t.snapshot()
    const restarted = t.application()
    expect(restarted.resolve({ itemId: mine.id, expectedVersion: mine.version, resolution: 'dropped', operatorOpenId: 'ou_alice', context: t.inDm }))
      .toMatchObject({ outcome: 'already_resolved', changed: false })
    expect(t.snapshot()).toEqual(after)
    expect(t.inbox.pending('ou_alice')).toEqual([])
    expect(restarted.pendingFor('ou_alice', t.inDm)).toEqual([])
  })

  it('the same question asked again opens a new version, and a reference to the old version cannot close it', () => {
    const t = setup(), first = t.ask('ou_alice', t.team.id)
    t.app.resolve({ itemId: first.id, expectedVersion: first.version, resolution: 'decided', note: '按 P2', operatorOpenId: 'ou_alice', context: t.inDm })
    t.setNow(NOW + 86400_000)
    const again = t.ask('ou_alice', t.team.id)
    expect(again).toMatchObject({ id: first.id, version: first.version + 1, resolvedAt: null, resolution: null, resolutionNote: null, nudges: 0, createdAt: NOW + 86400_000 })
    const before = t.snapshot()
    expect(t.app.resolve({ itemId: first.id, expectedVersion: first.version, resolution: 'decided', note: '按 P2', operatorOpenId: 'ou_alice', context: t.inDm }))
      .toMatchObject({ outcome: 'stale', changed: false })
    expect(t.snapshot()).toEqual(before)
    expect(t.app.resolve({ itemId: again.id, expectedVersion: again.version, resolution: 'decided', note: '这次按 P1', operatorOpenId: 'ou_alice', context: t.inDm }))
      .toMatchObject({ outcome: 'resolved', item: { resolutionNote: '这次按 P1' } })
  })

  it('a row settled before this change (no recorded conclusion) is reported as already handled, not as a conflict', () => {
    const t = setup(), mine = t.ask('ou_alice', t.team.id)
    // 改造前唯一的结清写法：只写 resolved_at。生产上这些行都来自领域结清（提案、技能、授权），个人待决断从没被结清过。
    t.registry.db.prepare('UPDATE inbox_items SET resolved_at = ? WHERE id = ?').run(NOW, mine.id)
    const before = t.snapshot()
    expect(t.app.resolve({ itemId: mine.id, expectedVersion: mine.version, resolution: 'dropped', operatorOpenId: 'ou_alice', context: t.inDm }))
      .toMatchObject({ outcome: 'settled_by_domain', changed: false })
    expect(t.snapshot()).toEqual(before)
  })

  it('checks the host lease inside the transaction and writes nothing when it fails', () => {
    const t = setup(), mine = t.ask('ou_alice', t.team.id)
    const before = t.snapshot()
    expect(() => t.app.resolve({ itemId: mine.id, expectedVersion: mine.version, resolution: 'decided', operatorOpenId: 'ou_alice', context: t.inTeam,
      assertCurrent: () => { throw new Error('已不在群里') } })).toThrow('已不在群里')
    expect(t.snapshot()).toEqual(before)
  })

  it('lists only what the context may show, with the id and version needed to settle it', () => {
    const t = setup()
    const team = t.ask('ou_alice', t.team.id), other = t.ask('ou_alice', t.other.id), dm = t.ask('ou_alice', t.aliceDm.id, '周报发给谁？')
    t.ask('ou_bob', t.team.id)
    expect(t.app.pendingFor('ou_alice', t.inTeam).map(i => [i.id, i.version])).toEqual([[team.id, 1]])
    expect(t.app.pendingFor('ou_alice', t.inDm).map(i => i.id).sort()).toEqual([team.id, other.id, dm.id].sort())
    expect(t.app.pendingFor('ou_alice', { spaceId: dmSpaceId('ou_bob'), chatType: 'p2p' })).toEqual([])
  })
})

describe('pointers owned by another domain are settled by that domain', () => {
  function proposal(t: ReturnType<typeof setup>) {
    const r = t.routines.add({ kind: 'schedule', spaceId: t.team.id, chatId: 'oc_team', chatType: 'group', name: '整理项目风险',
      prompt: '每周五整理项目风险', schedule: { type: 'daily', at: '17:00', days: [5] }, source: 'model', now: NOW })
    const item = t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'responsibility', refId: r.id, spaceId: t.team.id, title: '职责提案「整理项目风险」', now: NOW })
    return { r, item }
  }

  it('“不用了” on a responsibility proposal, said in the proposal’s own group, ignores it and settles its pointer together', () => {
    const t = setup(), { r, item } = proposal(t)
    const result = t.app.resolve({ itemId: item.id, expectedVersion: item.version, resolution: 'dropped', operatorOpenId: 'ou_alice', context: t.inTeam })
    expect(result).toMatchObject({ outcome: 'proposal', changed: true, proposal: { outcome: 'ignored' }, item: { resolution: 'domain', resolutionNote: 'ignored' } })
    expect(t.routines.get(r.id)).toMatchObject({ status: 'ignored', decidedBy: 'ou_alice' })
    // 同一句话重放（比如重启后）：已由提案自己结清，不是冲突
    const after = t.snapshot()
    expect(t.app.resolve({ itemId: item.id, expectedVersion: item.version, resolution: 'dropped', operatorOpenId: 'ou_alice', context: t.inTeam }))
      .toMatchObject({ outcome: 'settled_by_domain', changed: false, item: { resolutionNote: 'ignored' } })
    expect(t.snapshot()).toEqual(after)
  })

  it('“不用了” from a private chat does not decide a group proposal: that stays with the proposal’s own conversation', () => {
    const t = setup(), { r, item } = proposal(t)
    const before = t.snapshot()
    expect(t.app.resolve({ itemId: item.id, expectedVersion: item.version, resolution: 'dropped', operatorOpenId: 'ou_alice', context: t.inDm }))
      .toMatchObject({ outcome: 'use_domain', changed: false, domain: { kind: 'responsibility', routineId: r.id } })
    expect(t.snapshot()).toEqual(before)
  })

  it('checks the host lease before settling a pointer left behind by its domain', () => {
    const t = setup(), { r, item } = proposal(t)
    t.routines.accept(r.id, 'ou_alice', NOW)
    const before = t.snapshot()
    expect(() => t.app.resolve({ itemId: item.id, expectedVersion: item.version, resolution: 'dropped', operatorOpenId: 'ou_alice', context: t.inDm,
      assertCurrent: () => { throw new Error('租约失效') } })).toThrow('租约失效')
    expect(t.snapshot()).toEqual(before)
  })

  it('“定了” on a proposal does not guess accept or ignore', () => {
    const t = setup(), { r, item } = proposal(t)
    const before = t.snapshot()
    expect(t.app.resolve({ itemId: item.id, expectedVersion: item.version, resolution: 'decided', operatorOpenId: 'ou_alice', context: t.inDm }))
      .toMatchObject({ outcome: 'use_domain', changed: false, domain: { kind: 'responsibility', routineId: r.id } })
    expect(t.snapshot()).toEqual(before)
  })

  it('the proposal and its pointer roll back together when ignoring fails midway', () => {
    const t = setup(), { r, item } = proposal(t)
    const before = t.snapshot()
    t.registry.db.exec(`CREATE TRIGGER fail_pointer BEFORE UPDATE ON inbox_items BEGIN SELECT RAISE(ABORT, 'synthetic inbox failure'); END`)
    expect(() => t.app.resolve({ itemId: item.id, expectedVersion: item.version, resolution: 'dropped', operatorOpenId: 'ou_alice', context: t.inTeam }))
      .toThrow('synthetic inbox failure')
    t.registry.db.exec('DROP TRIGGER fail_pointer')
    expect(t.snapshot()).toEqual(before)
    expect(t.routines.get(r.id)?.status).toBe('proposed')
  })

  it('a pointer owner who is not the space owner cannot ignore the proposal through the pointer', () => {
    const t = setup()
    // Bob asked for the proposal in the group, so the pointer is his; only the space owner (Alice) may decide it.
    const r = t.routines.add({ kind: 'schedule', spaceId: t.team.id, chatId: 'oc_team', chatType: 'group', name: 'Bob 提的职责', prompt: 'p',
      schedule: { type: 'daily', at: '09:00' }, source: 'model', now: NOW })
    const bobsPointer = t.inbox.add({ ownerOpenId: 'ou_bob', kind: 'responsibility', refId: r.id, spaceId: t.team.id, title: '职责提案「Bob 提的职责」', now: NOW })
    const before = t.snapshot()
    const result = t.app.resolve({ itemId: bobsPointer.id, expectedVersion: bobsPointer.version, resolution: 'dropped', operatorOpenId: 'ou_bob', context: t.inTeam })
    expect(result).toMatchObject({ outcome: 'proposal', changed: false, proposal: { outcome: 'denied', code: 'not_owner' } })
    expect(t.snapshot()).toEqual(before)
  })

  function suspendedWatch(t: ReturnType<typeof setup>) {
    const watch = t.routines.add({ kind: 'watch', ownerOpenId: 'ou_alice', runAs: 'ou_alice', spaceId: t.aliceDm.id, chatId: 'oc_dm_alice', chatType: 'p2p',
      name: '盯产品群', prompt: '有人提到发布就告诉我', schedule: { type: 'interval', everyMinutes: 30 }, watchChatIds: ['oc_team'], now: NOW })
    t.routines.suspendForExpiredAuth('ou_alice', NOW)
    return { watch, item: t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'auth', refId: watch.id, title: '1 个盯群停了：委托授权到期', now: NOW }) }
  }

  it('an authorization pointer whose watch still waits is handed back to the routine domain without writing', () => {
    const t = setup(), { watch, item } = suspendedWatch(t)
    const before = t.snapshot()
    expect(t.app.resolve({ itemId: item.id, expectedVersion: item.version, resolution: 'dropped', operatorOpenId: 'ou_alice', context: t.inDm }))
      .toMatchObject({ outcome: 'use_domain', changed: false, domain: { kind: 'auth', routineId: watch.id } })
    expect(t.snapshot()).toEqual(before)
  })

  it.each([
    ['skill', { kind: 'skill', proposalId: 42 }],
    ['bug', { kind: 'unsupported', pendingKind: 'bug' }],
  ] as const)('a %s pointer is handed back without writing', (kind, domain) => {
    const t = setup()
    const item = t.inbox.add({ ownerOpenId: 'ou_alice', kind, refId: 42, title: '合成指针', now: NOW })
    const before = t.snapshot()
    expect(t.app.resolve({ itemId: item.id, expectedVersion: item.version, resolution: 'dropped', operatorOpenId: 'ou_alice', context: t.inDm }))
      .toMatchObject({ outcome: 'use_domain', changed: false, domain })
    expect(t.snapshot()).toEqual(before)
  })

  it('a pointer left behind by a domain that no longer waits is settled by that domain', () => {
    const t = setup(), { r, item } = proposal(t)
    // 旧代码先接受、再单独结清指针；两步之间中断会留下这种状态。
    t.routines.accept(r.id, 'ou_alice', NOW)
    const gone = t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'auth', refId: 4242, title: '1 个盯群停了：委托授权到期', now: NOW })
    for (const pointer of [item, gone]) {
      expect(t.app.resolve({ itemId: pointer.id, expectedVersion: pointer.version, resolution: 'dropped', operatorOpenId: 'ou_alice', context: t.inDm }))
        .toMatchObject({ outcome: 'settled_by_domain', changed: true, item: { resolution: 'domain' } })
    }
    expect(t.inbox.find('responsibility', r.id)?.resolutionNote).toBe('accepted')
    expect(t.inbox.find('auth', 4242)?.resolutionNote).toBe('no_longer_waiting')
    expect(t.inbox.pending('ou_alice')).toEqual([])
  })
})

describe('Inbox pointers follow their routine', () => {
  it('pausing or deleting a watch that waits for authorization settles its authorization pointer', () => {
    const t = setup()
    const watch = t.routines.add({ kind: 'watch', ownerOpenId: 'ou_alice', runAs: 'ou_alice', spaceId: t.aliceDm.id, chatId: 'oc_dm_alice', chatType: 'p2p',
      name: '盯产品群', prompt: '有人提到发布就告诉我', schedule: { type: 'interval', everyMinutes: 30 }, watchChatIds: ['oc_team'], now: NOW })
    t.routines.suspendForExpiredAuth('ou_alice', NOW)
    t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'auth', refId: watch.id, title: '1 个盯群停了：委托授权到期', now: NOW })
    t.routineApp.persistControl(watch.id, 'pause').afterCommit()
    expect(t.inbox.find('auth', watch.id)).toMatchObject({ resolution: 'domain', resolutionNote: 'no_longer_waiting', resolvedAt: NOW })
  })

  it('the authorization pointer stands for every watch of that person still waiting, not just the one that raised it', () => {
    const t = setup()
    const watches = ['盯产品群', '盯研发群', '盯发布群'].map(name => t.routines.add({ kind: 'watch', ownerOpenId: 'ou_alice', runAs: 'ou_alice',
      spaceId: t.aliceDm.id, chatId: 'oc_dm_alice', chatType: 'p2p', name, prompt: '有人提到发布就告诉我', schedule: { type: 'interval', everyMinutes: 30 },
      watchChatIds: ['oc_team'], now: NOW }))
    t.routines.suspendForExpiredAuth('ou_alice', NOW)
    // orchestrator 的写法：指针挂在触发的那一条上，标题说的是全部
    const pointer = t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'auth', refId: watches[0]!.id, title: '3 个盯群停了：委托授权到期', now: NOW })
    t.routineApp.persistControl(watches[0]!.id, 'delete').afterCommit()
    expect(t.inbox.get(pointer.id)?.resolvedAt).toBeNull()
    expect(t.app.resolve({ itemId: pointer.id, expectedVersion: pointer.version, resolution: 'dropped', operatorOpenId: 'ou_alice', context: t.inDm }))
      .toMatchObject({ outcome: 'use_domain', domain: { kind: 'auth' } })
    t.routineApp.persistControl(watches[1]!.id, 'pause').afterCommit()
    expect(t.inbox.get(pointer.id)?.resolvedAt).toBeNull()
    t.routineApp.persistControl(watches[2]!.id, 'delete').afterCommit()
    expect(t.inbox.get(pointer.id)).toMatchObject({ resolution: 'domain', resolutionNote: 'no_longer_waiting' })
  })

  it('stopping a space settles the authorization pointer once none of that person’s watches still waits for authorization', () => {
    const t = setup()
    const watch = (spaceId: string, chatId: string) => t.routines.add({ kind: 'watch', ownerOpenId: 'ou_alice', runAs: 'ou_alice', spaceId, chatId, chatType: 'group',
      name: '盯群', prompt: '有人提到发布就告诉我', schedule: { type: 'interval', everyMinutes: 30 }, watchChatIds: [chatId], now: NOW })
    const inTeam = watch(t.team.id, 'oc_team'), inOther = watch(t.other.id, 'oc_other')
    t.routines.suspendForExpiredAuth('ou_alice', NOW)
    const pointer = t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'auth', refId: inTeam.id, title: '2 个盯群停了：委托授权到期', now: NOW })
    // 接线后 space-lifecycle.ts 应在 pauseForSpace 之后、同一事务里结清指针（接口文档 §7；目前尚未接线）
    t.routines.pauseForSpace(t.team.id, 'oc_team', NOW)
    expect(t.routineApp.settlePointersForSpace(t.team.id, 'oc_team')).toBe(0)
    expect(t.inbox.get(pointer.id)?.resolvedAt).toBeNull()
    // 另一个空间也停了：这个人已经没有在等授权的关注，挂在 team 那条上的指针随之结清
    t.routines.pauseForSpace(t.other.id, 'oc_other', NOW)
    expect(t.routines.get(inOther.id)?.disabledReason).toBe('空间已停用')
    expect(t.routineApp.settlePointersForSpace(t.other.id, 'oc_other')).toBe(1)
    expect(t.inbox.get(pointer.id)).toMatchObject({ resolution: 'domain', resolutionNote: 'no_longer_waiting' })
  })

  it('only authorization pointers of watches are settled per person', () => {
    const t = setup()
    const schedule = t.routines.add({ kind: 'schedule', ownerOpenId: 'ou_alice', runAs: 'ou_alice', spaceId: t.aliceDm.id, chatId: 'oc_dm_alice', chatType: 'p2p',
      name: '日报', prompt: '合成指令', schedule: { type: 'daily', at: '09:00' }, now: NOW })
    const foreign = t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'auth', refId: schedule.id, title: '别的授权待办', now: NOW })
    const gone = t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'auth', refId: 777, title: '1 个盯群停了：委托授权到期', now: NOW })
    expect(t.routineApp.settlePointers([777], ['auth'])).toBe(1)
    expect(t.inbox.get(gone.id)?.resolvedAt).toBe(NOW)
    expect(t.inbox.get(foreign.id)?.resolvedAt).toBeNull()
  })

  it('authorization that grants only the basic scopes keeps the pointer while a watch still waits; granting the watch scopes settles it', async () => {
    const t = setup()
    let scope = USER_SCOPE_TIERS.core.join(' ')
    const userTokens = new UserTokenStore(t.registry.db, { exchangeCode: async () => ({ accessToken: 'SYNTHETIC_TOKEN', expiresIn: 7200, scope }),
      refresh: async () => { throw new Error('unexpected refresh') } }, () => NOW)
    const app = new RoutineApplication({ registry: t.registry, routines: t.routines, spaces: t.spaces, inbox: t.inbox, userTokens,
      attempts: new RunAttempts(t.registry.db), activeRuns: () => [], now: () => NOW })
    const watch = t.routines.add({ kind: 'watch', ownerOpenId: 'ou_alice', runAs: 'ou_alice', spaceId: t.aliceDm.id, chatId: 'oc_dm_alice', chatType: 'p2p',
      name: '盯产品群', prompt: '有人提到发布就告诉我', schedule: { type: 'interval', everyMinutes: 30 }, watchChatIds: ['oc_team'], now: NOW })
    t.routines.suspendForExpiredAuth('ou_alice', NOW)
    const pointer = t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'auth', refId: watch.id, title: '1 个盯群停了：缺少群历史权限', now: NOW })
    await userTokens.complete({ openId: 'ou_alice', code: 'synthetic', redirectUri: 'https://callback.invalid' })
    expect(await app.authorizationCompleted('ou_alice')).toMatchObject({ connected: true, resumed: 0, stillPaused: 1 })
    expect(t.inbox.get(pointer.id)?.resolvedAt).toBeNull()
    scope = [...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.watch].join(' ')
    await userTokens.complete({ openId: 'ou_alice', code: 'synthetic-2', redirectUri: 'https://callback.invalid' })
    expect(await app.authorizationCompleted('ou_alice')).toMatchObject({ connected: true, resumed: 1, stillPaused: 0 })
    expect(t.inbox.get(pointer.id)).toMatchObject({ resolution: 'domain', resolutionNote: 'no_longer_waiting' })
  })

  it('a second authorization expiry after recovery raises the pointer again as a new version', () => {
    const t = setup()
    const first = t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'auth', refId: 7, title: '1 个盯群停了：委托授权到期', now: NOW })
    t.inbox.resolve('auth', 7, NOW + 1000)
    const again = t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'auth', refId: 7, title: '1 个盯群停了：委托授权到期', now: NOW + 86400_000 })
    expect(again).toMatchObject({ id: first.id, version: 2, resolvedAt: null, resolution: null })
    expect(t.inbox.pending('ou_alice').map(i => i.id)).toEqual([first.id])
  })

  it('never hands a resolved row to a different person', () => {
    const t = setup()
    const alice = t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'decision', refId: 5, title: '同一个旧编号', now: NOW })
    t.inbox.resolve('decision', 5, NOW + 1)
    const bob = t.inbox.add({ ownerOpenId: 'ou_bob', kind: 'decision', refId: 5, title: '同一个旧编号', now: NOW + 2 })
    expect(bob).toMatchObject({ id: alice.id, ownerOpenId: 'ou_alice', resolvedAt: NOW + 1, version: 1 })
    expect(t.inbox.pending('ou_bob')).toEqual([])
  })
})

describe('Inbox schema upgrade', () => {
  it('adds the version and resolution columns once, keeps old rows as they were and never guesses a past conclusion', () => {
    const db = new DatabaseSync(':memory:')
    try {
      // 生产现有的表形状（加列之前）
      db.exec(`CREATE TABLE inbox_items (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_open_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id INTEGER,
        space_id TEXT, title TEXT NOT NULL, why TEXT, created_at INTEGER NOT NULL, last_nudged_at INTEGER, nudges INTEGER NOT NULL DEFAULT 0, resolved_at INTEGER);
        CREATE UNIQUE INDEX idx_inbox_ref ON inbox_items(kind, ref_id) WHERE ref_id IS NOT NULL;
        INSERT INTO inbox_items (owner_open_id, kind, ref_id, space_id, title, created_at, nudges, resolved_at) VALUES
          ('ou_old', 'decision', 11, 'sp_x', '旧的待决断', 100, 2, NULL),
          ('ou_old', 'responsibility', 12, 'sp_x', '旧的提案指针', 100, 0, 200);`)
      const before = db.prepare('SELECT id, owner_open_id, kind, ref_id, space_id, title, created_at, nudges, resolved_at FROM inbox_items ORDER BY id').all()
      new Inbox(db)
      const once = db.prepare('SELECT * FROM inbox_items ORDER BY id').all()
      new Inbox(db)
      expect(db.prepare('SELECT * FROM inbox_items ORDER BY id').all()).toEqual(once)
      expect(db.prepare('SELECT id, owner_open_id, kind, ref_id, space_id, title, created_at, nudges, resolved_at FROM inbox_items ORDER BY id').all()).toEqual(before)
      expect(once.map(row => [row.version, row.resolution, row.resolved_by, row.resolution_note])).toEqual([[1, null, null, null], [1, null, null, null]])
    } finally { db.close() }
  })
})
