/**
 * 职责提案的决定：批准的必须是人刚才看到的那一版。
 *
 * 真实调用链（改造前）：卡片按钮只带 { action:'resp', id, decision }，
 * orchestrator.decideResponsibility 按 id 读当前行就接受；提案期间 /v1/routine/update
 * 可以改 prompt、频率、投递方式，旧卡照样能接受改过的内容。接受与 Inbox 指针结清是两条独立语句。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RoutineApplication } from '../src/core/routine-application.js'
import { RoutineStore, type ScheduleSpec } from '../src/core/routines.js'
import { Inbox } from '../src/core/inbox.js'
import { spaceDeps } from './helpers/space.js'

const NOW = 1_800_000_000_000
const HOUR = 3600_000
const FRIDAY: ScheduleSpec = { type: 'daily', at: '17:00', days: [5] }
const registries: Registry[] = []
afterEach(() => { for (const registry of registries.splice(0)) registry.close() })

function setup() {
  const registry = new Registry(':memory:')
  registries.push(registry)
  const routines = new RoutineStore(registry.db)
  const attempts = new RunAttempts(registry.db)
  const inbox = new Inbox(registry.db)
  const { spaces, policy } = spaceDeps(registry.db)
  const group = spaces.ensure({ kind: 'group', chatId: 'oc_team', openId: 'ou_owner' })
  spaces.addMember(group.id, 'ou_member', 'member')
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm_owner', openId: 'ou_owner' })
  let now = NOW
  const application = () => new RoutineApplication({ registry, routines, spaces, policy, inbox, attempts,
    activeRuns: () => [], now: () => now })
  const app = application()
  /** 照 POST /v1/responsibility/propose 的写法：模型提案 + 发起人的 Inbox 指针。 */
  function propose(where: 'group' | 'dm' = 'group') {
    const space = where === 'group' ? group : dm
    const r = routines.add({ kind: 'schedule', spaceId: space.id, chatId: space.chatId!, chatType: where === 'group' ? 'group' : 'p2p',
      name: '整理项目风险', prompt: '每周五整理本群项目风险，列出负责人和截止时间', schedule: FRIDAY, source: 'model', now })
    inbox.add({ ownerOpenId: 'ou_owner', kind: 'responsibility', refId: r.id, spaceId: space.id,
      title: `职责提案「${r.name}」（每周五 17:00）`, why: '接受后以你的身份定时跑', now })
    return r
  }
  function snapshot() {
    return ['routines', 'routine_occurrences', 'inbox_items'].map(table => registry.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  }
  const pointer = (id: number) => inbox.find('responsibility', id)
  return { registry, routines, inbox, spaces, policy, group, dm, app, application, propose, snapshot, pointer,
    setNow: (value: number) => { now = value } }
}

describe('a responsibility proposal is accepted only in the version the person saw', () => {
  it('rejects an old card after the proposal was edited, and accepts the version on the refreshed card', () => {
    const t = setup(), proposal = t.propose()
    const shown = t.routines.configVersion(proposal.id)!
    const edited = t.app.update(proposal.id, { prompt: '每周五整理项目风险，并附上 GitHub Issue 链接' }, { expectedConfigVersion: shown })
    expect(edited.proposalChanged).toBe(true)
    const before = t.snapshot()

    const old = t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: shown, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id })
    expect(old).toMatchObject({ outcome: 'stale_card', changed: false, currentConfigVersion: shown + 1 })
    expect(t.snapshot()).toEqual(before)
    expect(t.routines.get(proposal.id)).toMatchObject({ status: 'proposed', runAs: null })

    const current = t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: shown + 1, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id })
    expect(current).toMatchObject({ outcome: 'accepted', changed: true })
    expect(t.routines.get(proposal.id)).toMatchObject({ status: 'active', runAs: 'ou_owner', decidedBy: 'ou_owner',
      prompt: '每周五整理项目风险，并附上 GitHub Issue 链接' })
    expect(t.pointer(proposal.id)?.resolvedAt).toBe(NOW)
  })

  it('treats a card without a version (sent before this change) as stale instead of accepting the current row', () => {
    const t = setup(), proposal = t.propose()
    const result = t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: undefined, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id })
    expect(result).toMatchObject({ outcome: 'stale_card', changed: false })
    expect(t.routines.get(proposal.id)?.status).toBe('proposed')
  })

  it('a double click enables once and resolves one pointer; a later ignore does not overwrite the acceptance', () => {
    const t = setup(), proposal = t.propose()
    const version = t.routines.configVersion(proposal.id)!
    const click = () => t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: version, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id })
    expect(click()).toMatchObject({ outcome: 'accepted', changed: true })
    const afterFirst = t.snapshot()
    t.setNow(NOW + 5_000)
    expect(click()).toMatchObject({ outcome: 'already_accepted', changed: false })
    expect(t.snapshot()).toEqual(afterFirst)
    expect(t.registry.db.prepare("SELECT COUNT(*) AS n FROM inbox_items WHERE kind = 'responsibility'").get()).toEqual({ n: 1 })

    const ignore = t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: version, decision: 'ignore', operatorOpenId: 'ou_owner', spaceId: t.group.id })
    expect(ignore).toMatchObject({ outcome: 'conflict', changed: false, current: 'accepted' })
    expect(t.snapshot()).toEqual(afterFirst)
  })

  it('does not accept after an ignore, and a replayed ignore returns the existing result', () => {
    const t = setup(), proposal = t.propose()
    const version = t.routines.configVersion(proposal.id)!
    const decide = (decision: 'accept' | 'ignore') => t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: version, decision, operatorOpenId: 'ou_owner', spaceId: t.group.id })
    expect(decide('ignore')).toMatchObject({ outcome: 'ignored', changed: true })
    const after = t.snapshot()
    expect(decide('ignore')).toMatchObject({ outcome: 'already_ignored', changed: false })
    expect(decide('accept')).toMatchObject({ outcome: 'conflict', changed: false, current: 'ignored' })
    expect(t.snapshot()).toEqual(after)
    expect(t.routines.get(proposal.id)?.status).toBe('ignored')
  })

  it('enables nothing when the space stopped, the owner lost the role, or the proposal was deleted before the click', () => {
    const stopped = setup(), a = stopped.propose(), va = stopped.routines.configVersion(a.id)!
    stopped.spaces.suspend(stopped.group.id)
    const beforeStopped = stopped.snapshot()
    expect(stopped.app.decideProposal({ routineId: a.id, expectedConfigVersion: va, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: stopped.group.id }))
      .toMatchObject({ outcome: 'denied', code: 'space_inactive' })
    expect(stopped.snapshot()).toEqual(beforeStopped)

    const demoted = setup(), b = demoted.propose(), vb = demoted.routines.configVersion(b.id)!
    demoted.spaces.removeMember(demoted.group.id, 'ou_owner')
    demoted.spaces.addMember(demoted.group.id, 'ou_owner', 'member')
    const beforeDemoted = demoted.snapshot()
    expect(demoted.app.decideProposal({ routineId: b.id, expectedConfigVersion: vb, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: demoted.group.id }))
      .toMatchObject({ outcome: 'denied', code: 'not_owner' })
    expect(demoted.snapshot()).toEqual(beforeDemoted)

    const deleted = setup(), c = deleted.propose(), vc = deleted.routines.configVersion(c.id)!
    deleted.app.persistControl(c.id, 'delete').afterCommit()
    // Deleting the proposal is a domain decision: its pointer is settled in the same transaction.
    expect(deleted.pointer(c.id)?.resolvedAt).toBe(NOW)
    expect(deleted.app.decideProposal({ routineId: c.id, expectedConfigVersion: vc, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: deleted.group.id }))
      .toMatchObject({ outcome: 'not_found' })
    expect(deleted.routines.get(c.id)).toBeUndefined()
  })

  it('a card sent before the space was stopped cannot enable the proposal after the space is resumed', () => {
    const t = setup(), proposal = t.propose()
    const shown = t.routines.configVersion(proposal.id)!
    // space-lifecycle.ts 现在的写法：同一事务里停空间、停职责（没有别的调用）
    t.spaces.archive(t.group.id)
    t.routines.pauseForSpace(t.group.id, 'oc_team', NOW)
    // 提案仍在等待、指针仍在，照原来的 72 小时路径作废；只是停用前的卡片从此失效
    expect(t.routines.get(proposal.id)?.status).toBe('proposed')
    expect(t.routines.configVersion(proposal.id)).toBe(shown + 1)
    expect(t.pointer(proposal.id)?.resolvedAt).toBeNull()
    t.spaces.resume('oc_team')
    const before = t.snapshot()
    expect(t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: shown, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id }))
      .toMatchObject({ outcome: 'stale_card', changed: false, currentConfigVersion: shown + 1 })
    expect(t.snapshot()).toEqual(before)
    // 恢复后刷新出来的卡是一次新的决定
    expect(t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: shown + 1, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id }))
      .toMatchObject({ outcome: 'accepted' })
  })

  it('a proposal left waiting in a stopped space is expired by the usual 72-hour sweep, pointer included', () => {
    const t = setup(), proposal = t.propose()
    t.spaces.archive(t.group.id)
    t.routines.pauseForSpace(t.group.id, 'oc_team', NOW)
    t.setNow(NOW + 72 * HOUR)
    expect(t.app.expireProposals().map(r => r.id)).toEqual([proposal.id])
    expect(t.pointer(proposal.id)).toMatchObject({ resolution: 'domain', resolutionNote: 'expired' })
  })

  it('another member of the same group cannot decide, and the database is unchanged', () => {
    const t = setup(), proposal = t.propose()
    const before = t.snapshot()
    const result = t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: t.routines.configVersion(proposal.id), decision: 'accept', operatorOpenId: 'ou_member', spaceId: t.group.id })
    expect(result).toMatchObject({ outcome: 'denied', code: 'not_owner' })
    expect(t.snapshot()).toEqual(before)
  })

  it('a card clicked from another chat cannot decide for the proposal space', () => {
    const t = setup(), proposal = t.propose()
    const other = t.spaces.ensure({ kind: 'group', chatId: 'oc_other', openId: 'ou_owner' })
    const before = t.snapshot()
    expect(t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: t.routines.configVersion(proposal.id), decision: 'accept', operatorOpenId: 'ou_owner', spaceId: other.id }))
      .toMatchObject({ outcome: 'denied', code: 'wrong_space' })
    expect(t.snapshot()).toEqual(before)
  })

  it('a private proposal can be decided only by that person', () => {
    const t = setup(), proposal = t.propose('dm')
    const before = t.snapshot()
    expect(t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: t.routines.configVersion(proposal.id), decision: 'accept', operatorOpenId: 'ou_member', spaceId: t.dm.id }))
      .toMatchObject({ outcome: 'denied' })
    expect(t.snapshot()).toEqual(before)
    expect(t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: t.routines.configVersion(proposal.id), decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.dm.id }))
      .toMatchObject({ outcome: 'accepted' })
  })

  it('checks the host lease inside the transaction and writes nothing when it fails', () => {
    const t = setup(), proposal = t.propose()
    const before = t.snapshot()
    expect(() => t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: t.routines.configVersion(proposal.id), decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id,
      assertCurrent: () => { throw new Error('点击人已不在群里') } })).toThrow('点击人已不在群里')
    expect(t.snapshot()).toEqual(before)
  })

  it('rolls back the routine together with the Inbox pointer when the decision fails midway', () => {
    const t = setup(), proposal = t.propose()
    const before = t.snapshot()
    t.registry.db.exec(`CREATE TRIGGER fail_pointer BEFORE UPDATE ON inbox_items BEGIN SELECT RAISE(ABORT, 'synthetic inbox failure'); END`)
    expect(() => t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: t.routines.configVersion(proposal.id), decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id }))
      .toThrow('synthetic inbox failure')
    t.registry.db.exec('DROP TRIGGER fail_pointer')
    expect(t.snapshot()).toEqual(before)
    expect(t.routines.get(proposal.id)).toMatchObject({ status: 'proposed', runAs: null })
  })

  it('a replay after a restart finds the recorded decision: no second enable, pointer or queued run', () => {
    const t = setup(), proposal = t.propose()
    const version = t.routines.configVersion(proposal.id)!
    expect(t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: version, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id }))
      .toMatchObject({ outcome: 'accepted' })
    const after = t.snapshot()
    t.setNow(NOW + HOUR)
    const restarted = t.application()
    expect(restarted.decideProposal({ routineId: proposal.id, expectedConfigVersion: version, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id }))
      .toMatchObject({ outcome: 'already_accepted', changed: false })
    expect(t.snapshot()).toEqual(after)
  })

  it('a replayed acceptance never re-enables a routine that was paused after it was accepted', () => {
    const t = setup(), proposal = t.propose()
    const version = t.routines.configVersion(proposal.id)!
    t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: version, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id })
    t.app.persistControl(proposal.id, 'pause').afterCommit()
    const paused = t.snapshot()
    expect(t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: version, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id }))
      .toMatchObject({ outcome: 'already_accepted', changed: false })
    expect(t.snapshot()).toEqual(paused)
    expect(t.routines.get(proposal.id)?.enabled).toBe(false)
  })

  it('checks the host lease before expiring an overdue proposal on click', () => {
    const t = setup(), proposal = t.propose()
    t.setNow(NOW + 72 * HOUR)
    const before = t.snapshot()
    expect(() => t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: t.routines.configVersion(proposal.id), decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id,
      assertCurrent: () => { throw new Error('租约失效') } })).toThrow('租约失效')
    expect(t.snapshot()).toEqual(before)
  })

  it('a click after the 72-hour limit expires the proposal once and cannot enable it', () => {
    const t = setup(), proposal = t.propose()
    const version = t.routines.configVersion(proposal.id)!
    t.setNow(NOW + 72 * HOUR)
    const first = t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: version, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id })
    expect(first).toMatchObject({ outcome: 'expired', changed: true })
    expect(t.routines.get(proposal.id)).toMatchObject({ status: 'expired', enabled: false })
    expect(t.pointer(proposal.id)?.resolvedAt).toBe(NOW + 72 * HOUR)
    const after = t.snapshot()
    expect(t.app.decideProposal({ routineId: proposal.id, expectedConfigVersion: version, decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id }))
      .toMatchObject({ outcome: 'expired', changed: false })
    expect(t.snapshot()).toEqual(after)
  })

  it('the expiry sweep settles each proposal and its pointer together and returns what the host must refresh', () => {
    const t = setup(), a = t.propose(), b = t.propose('dm')
    t.setNow(NOW + 72 * HOUR)
    const expired = t.app.expireProposals()
    expect(expired.map(r => r.id).sort()).toEqual([a.id, b.id].sort())
    expect(expired.every(r => r.status === 'expired')).toBe(true)
    expect(t.pointer(a.id)?.resolvedAt).toBe(NOW + 72 * HOUR)
    expect(t.pointer(b.id)?.resolvedAt).toBe(NOW + 72 * HOUR)
    expect(t.app.expireProposals()).toEqual([])
  })

  it('refuses to decide a routine that was never a proposal', () => {
    const t = setup()
    const r = t.routines.add({ kind: 'schedule', ownerOpenId: 'ou_owner', runAs: 'ou_owner', spaceId: t.group.id, chatId: 'oc_team', chatType: 'group',
      name: '人建的职责', prompt: '合成指令', schedule: FRIDAY, now: NOW })
    const before = t.snapshot()
    const result = t.app.decideProposal({ routineId: r.id, expectedConfigVersion: t.routines.configVersion(r.id), decision: 'ignore', operatorOpenId: 'ou_member', spaceId: t.group.id })
    expect(result).toEqual({ outcome: 'not_a_proposal', changed: false })
    expect(t.snapshot()).toEqual(before)
  })
})

describe('editing a proposal while it waits', () => {
  it('produces a new version, keeps it waiting and retitles its pointer in the same transaction', () => {
    const t = setup(), proposal = t.propose()
    const version = t.routines.configVersion(proposal.id)!
    const result = t.app.update(proposal.id, { name: '整理项目风险和阻塞', schedule: { type: 'daily', at: '10:00', days: [1] } }, { expectedConfigVersion: version })
    expect(result).toMatchObject({ proposalChanged: true, routine: { status: 'proposed', name: '整理项目风险和阻塞' } })
    expect(t.routines.configVersion(proposal.id)).toBe(version + 1)
    expect(t.pointer(proposal.id)).toMatchObject({ resolvedAt: null })
    expect(t.pointer(proposal.id)?.title).toContain('整理项目风险和阻塞')
  })

  it('rejects an edit based on an older version', () => {
    const t = setup(), proposal = t.propose()
    const version = t.routines.configVersion(proposal.id)!
    t.app.update(proposal.id, { prompt: '第一次修改' }, { expectedConfigVersion: version })
    const before = t.snapshot()
    expect(() => t.app.update(proposal.id, { prompt: '基于旧版本的修改' }, { expectedConfigVersion: version })).toThrow('已修改')
    expect(t.snapshot()).toEqual(before)
  })
})

describe('status query for proposal cards', () => {
  it('tells accepted, ignored and expired apart (waiting and outdated cards are in the next case)', () => {
    const t = setup()
    const editedThenExpired = t.propose(), accepted = t.propose(), ignored = t.propose(), expiring = t.propose()
    const v = (id: number) => t.routines.configVersion(id)!
    t.app.decideProposal({ routineId: accepted.id, expectedConfigVersion: v(accepted.id), decision: 'accept', operatorOpenId: 'ou_owner', spaceId: t.group.id })
    t.app.decideProposal({ routineId: ignored.id, expectedConfigVersion: v(ignored.id), decision: 'ignore', operatorOpenId: 'ou_owner', spaceId: t.group.id })
    const shownBeforeEdit = v(editedThenExpired.id)
    t.app.update(editedThenExpired.id, { prompt: '改过的内容' }, { expectedConfigVersion: shownBeforeEdit })
    t.setNow(NOW + 72 * HOUR)
    t.app.expireProposals()
    expect(t.app.proposalStatus(accepted.id, v(accepted.id))).toMatchObject({ state: 'accepted', decidedBy: 'ou_owner' })
    expect(t.app.proposalStatus(ignored.id, v(ignored.id))).toMatchObject({ state: 'ignored' })
    expect(t.app.proposalStatus(expiring.id, v(expiring.id))).toMatchObject({ state: 'expired' })
    expect(t.app.proposalStatus(editedThenExpired.id, shownBeforeEdit)).toMatchObject({ state: 'expired' })
    expect(t.app.proposalStatus(12345, 1)).toMatchObject({ state: 'not_found' })
  })

  it('reports an outdated card for a proposal still waiting', () => {
    const t = setup(), proposal = t.propose()
    const shown = t.routines.configVersion(proposal.id)!
    t.app.update(proposal.id, { prompt: '改过的内容' }, { expectedConfigVersion: shown })
    expect(t.app.proposalStatus(proposal.id, shown)).toMatchObject({ state: 'stale_card', currentConfigVersion: shown + 1 })
    expect(t.app.proposalStatus(proposal.id, shown + 1)).toMatchObject({ state: 'pending', currentConfigVersion: shown + 1 })
  })
})
