/**
 * 成员对照表 → 身份表。
 *
 * 起因是真机上群成员显示成 `用户(a1b2c3)`：身份表是从一份 TSV 种子导进来的，装好那天就开始过期。
 * 用户的判断是对的——「因为这个表格实时更新，最好让 Friday 自己做」。
 *
 * 那张表（飞书多维表格，82 行）里有一列是**人员字段**，直接带 open_id。
 * 有了它，"这个 PR 是谁改的、他在飞书里是谁、能不能 @" 才有据可依。
 *
 * 这组用例守四件事：
 * 1. 人员字段里的 open_id 要用上，不是只认姓名；
 * 2. 表格是事实源，改了名字要跟着改；
 * 3. 但**没填人员字段不许清掉已有的 open_id**——宁可用旧的可用值，也不要把能 @ 的人变成不能 @；
 * 4. 列名被人改了要能配置，而且报告用了哪几列，便于排查。
 */
import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Identities } from '../src/core/identities.js'
import { IdentityDirectory } from '../src/core/identity-directory.js'
import type { Bitable } from '../src/feishu/bitable.js'
import { createLogger } from '../src/log.js'

const log = createLogger('identity-roster', 'error')

/** 照真表的形状造记录：文本列是字符串，人员列是 [{ id, name }]。 */
function row(login: string, name: string, openId?: string) {
  return {
    fields: {
      'GitHub ID': login,
      人员: name,
      ...(openId ? { '人员（用于让小助手知道open_id）': [{ id: openId, name }] } : {}),
    },
  }
}

function setup(records: { fields: Record<string, unknown> }[], opts: { tableId?: string } = {}) {
  const db = new DatabaseSync(':memory:')
  const identities = new Identities(db)
  const listRecords = vi.fn(async () => ({ records, complete: true }))
  const listTables = vi.fn(async () => [{ tableId: 'tblSyntheticRost', name: '数据表' }])
  const bitable = { listRecords, listTables } as unknown as Bitable
  let now = 1_000
  const directory = new IdentityDirectory({ identities, bitable, log, now: () => now },
    { appToken: 'bascnSyntheticRosterBase000', tableId: opts.tableId })
  return { db, identities, directory, listRecords, listTables, at: (ms: number) => { now = ms } }
}

describe('成员对照表是事实源', () => {
  it('人员字段里的 open_id 直接用上，姓名和登录名一起进表', async () => {
    const t = setup([row('ZhixingLu', '陆知行', 'ou_alice'), row('mingyuanzhou', '周明远', 'ou_bob')])
    const result = await t.directory.refresh()
    expect(result).toMatchObject({ rows: 2, withOpenId: 2, scanned: 2, complete: true })
    expect(t.identities.byLogin('ZhixingLu')).toMatchObject({ githubLogin: 'ZhixingLu', displayName: '陆知行', openId: 'ou_alice' })
    // 有了 open_id，在群里就能确定是哪一个人，而不是退回"知道名字但不敢 @"
    expect(t.identities.resolveForChat('ZhixingLu', [{ name: '陆知行', openId: 'ou_alice' }]))
      .toMatchObject({ kind: 'resolved', openId: 'ou_alice' })
  })

  it('没填 GitHub 账号的行跳过，不当成错误', async () => {
    const t = setup([row('ZhixingLu', '陆知行', 'ou_alice'), { fields: { 人员: '还没填账号的人' } }])
    expect(await t.directory.refresh()).toMatchObject({ rows: 1, scanned: 2 })
    expect(t.identities.count()).toBe(1)
  })

  it('表里改了名字，身份表跟着改', async () => {
    const t = setup([row('ZhixingLu', '陆知行', 'ou_alice')])
    await t.directory.refresh()
    const t2 = setup([row('ZhixingLu', '陆知行（新名字）', 'ou_alice')])
    await t2.directory.refresh()
    expect(t2.identities.byLogin('ZhixingLu')?.displayName).toBe('陆知行（新名字）')
  })

  it('人员字段空着时不清掉已有的 open_id', async () => {
    const t = setup([row('ZhixingLu', '陆知行', 'ou_alice')])
    await t.directory.refresh()
    // 有人把人员列清空了（或者那一行本来就没填）——不能因此让他从"能 @"退回"不能 @"
    t.listRecords.mockResolvedValue({ records: [row('ZhixingLu', '陆知行')], complete: true })
    expect(await t.directory.refresh()).toMatchObject({ rows: 1, withOpenId: 0 })
    expect(t.identities.byLogin('ZhixingLu')?.openId).toBe('ou_alice')
  })

  it('运行时查到的 open_id 会被表里的覆盖——表是人亲手挑的，比我们撞出来的准', async () => {
    const t = setup([row('ZhixingLu', '陆知行', 'ou_fromroster')])
    t.identities.seedFrom('/nonexistent')
    t.identities.upsertFromRoster([{ login: 'ZhixingLu', name: '陆知行' }])
    t.identities.rememberOpenId('ZhixingLu', 'ou_guessedatruntime')
    expect(t.identities.byLogin('ZhixingLu')?.openId).toBe('ou_guessedatruntime')
    await t.directory.refresh()
    expect(t.identities.byLogin('ZhixingLu')?.openId).toBe('ou_fromroster')
  })

  it('不给 tableId 就用表格里的第一张表', async () => {
    const t = setup([row('ZhixingLu', '陆知行', 'ou_alice')])
    await t.directory.refresh()
    expect(t.listTables).toHaveBeenCalledTimes(1)
    expect(t.listRecords).toHaveBeenCalledWith('bascnSyntheticRosterBase000', 'tblSyntheticRost', { limit: 2000 })
  })

  it('列名可以覆盖，并且回报用了哪几列', async () => {
    const db = new DatabaseSync(':memory:')
    const identities = new Identities(db)
    const bitable = {
      listRecords: vi.fn(async () => ({ records: [{ fields: { gh: 'ZhixingLu', who: '陆知行' } }], complete: true })),
      listTables: vi.fn(async () => [{ tableId: 'tbl', name: '数据表' }]),
    } as unknown as Bitable
    const directory = new IdentityDirectory({ identities, bitable, log },
      { appToken: 'app', tableId: 'tbl', columns: { login: 'gh', name: 'who' } })
    const result = await directory.refresh()
    expect(result?.columns).toMatchObject({ login: 'gh', name: 'who' })
    expect(identities.byLogin('ZhixingLu')?.displayName).toBe('陆知行')
  })

  it('节流：短时间内连着问，只真的拉一次', async () => {
    const t = setup([row('ZhixingLu', '陆知行', 'ou_alice')])
    await t.directory.refresh()
    expect(t.listRecords).toHaveBeenCalledTimes(1)
    expect(await t.directory.refresh({ minIntervalMs: 60_000 })).toBeUndefined()
    expect(t.listRecords).toHaveBeenCalledTimes(1)
    t.at(1_000 + 61_000)
    await t.directory.refresh({ minIntervalMs: 60_000 })
    expect(t.listRecords).toHaveBeenCalledTimes(2)
  })

  it('富文本段数组的文本列也读得出来', async () => {
    const t = setup([{ fields: { 'GitHub ID': [{ text: 'ZhixingLu' }], 人员: [{ text: '陆' }, { text: '知行' }] } }])
    await t.directory.refresh()
    expect(t.identities.byLogin('ZhixingLu')?.displayName).toBe('陆知行')
  })

  it('人员字段里不是 open_id 形状的值一律不要', async () => {
    const t = setup([{ fields: { 'GitHub ID': 'ZhixingLu', 人员: '陆知行', '人员（用于让小助手知道open_id）': [{ id: 'not-an-open-id', name: '陆知行' }] } }])
    expect(await t.directory.refresh()).toMatchObject({ withOpenId: 0 })
    expect(t.identities.byLogin('ZhixingLu')?.openId).toBeNull()
  })
})
