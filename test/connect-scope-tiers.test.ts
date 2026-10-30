/**
 * 个人授权的 scope 分层。
 *
 * 起因：个人授权这条路曾经走不通。
 * 原因是一把要 13 个 scope，其中 `im:message.group_msg:get_as_user` 要后台单独开通，
 * 没开通时**整个授权页 20027 报错**。于是跨群搜索、历史检索、我的一天全被一项没批的权限拖死。
 *
 * 分层之后：core 都是免审的只读项，先把这条路打通；盯群和日历各自一组，后台批了再打开。
 * 配套的义务是**别骗人**：连上之后要按飞书实际给的 scope 说清楚哪些能用、哪些还不能。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_USER_SCOPES,
  EXTRA_LABEL,
  USER_SCOPE_EXTRAS,
  USER_SCOPE_TIERS,
  grantedCapabilities,
  userScopesFor,
} from '../src/feishu/oauth.js'

const WATCH = 'im:message.group_msg:get_as_user'
const CALENDAR = 'calendar:calendar:readonly'

describe('个人授权的 scope 分层', () => {
  it('默认只要免审的 core：不含要后台开通的那两项', () => {
    expect(DEFAULT_USER_SCOPES).not.toContain(WATCH)
    expect(DEFAULT_USER_SCOPES).not.toContain(CALENDAR)
    // 但读群历史和搜索必须在——少了它们，连上了也没意义
    expect(DEFAULT_USER_SCOPES).toContain('im:chat:readonly')
    expect(DEFAULT_USER_SCOPES).toContain('im:message:readonly')
    expect(DEFAULT_USER_SCOPES).toContain('search:message')
    expect(DEFAULT_USER_SCOPES).toContain('offline_access')
  })

  it('**不要**以用户身份发消息的权限：从来没用过，也不该用', () => {
    // 个人授权只放大眼睛，不放大嘴；群里永远只用机器人身份说话。
    expect(userScopesFor([...USER_SCOPE_EXTRAS])).not.toContain('im:message')
  })

  it('打开某一组才请求那一组，且不重复', () => {
    expect(userScopesFor(['watch'])).toContain(WATCH)
    expect(userScopesFor(['watch'])).not.toContain(CALENDAR)
    const both = userScopesFor(['watch', 'calendar'])
    expect(both).toContain(WATCH)
    expect(both).toContain(CALENDAR)
    expect(new Set(both).size).toBe(both.length)
    expect(both.length).toBe(USER_SCOPE_TIERS.core.length + 2)
  })

  it('每个附加组都有一句人话，好在卡片和回执里说', () => {
    for (const extra of USER_SCOPE_EXTRAS) expect(EXTRA_LABEL[extra]).toBeTruthy()
  })
})

describe('按实际拿到的 scope 判断能力，而不是按请求过什么', () => {
  it('只拿到 core：跨群搜索可用，盯群和日历明确标为缺', () => {
    const r = grantedCapabilities(DEFAULT_USER_SCOPES.join(' '))
    expect(r.core).toBe(true)
    expect(r.extras).toEqual([])
    expect(r.missing).toEqual(expect.arrayContaining(['watch', 'calendar']))
  })

  it('拿到盯群那一项就认它，日历仍然算缺', () => {
    const r = grantedCapabilities([...DEFAULT_USER_SCOPES, WATCH].join(' '))
    expect(r.extras).toEqual(['watch'])
    expect(r.missing).toContain('calendar')
    expect(r.missing).not.toContain('watch')
  })

  it('请求了但飞书没给，就不算有——这是整条判断的意义', () => {
    // 请求清单里有 watch，返回的 scope 里没有：不能当成能用
    const requested = userScopesFor(['watch'])
    expect(requested).toContain(WATCH)
    const granted = grantedCapabilities(requested.filter((s) => s !== WATCH).join(' '))
    expect(granted.extras).toEqual([])
    expect(granted.missing).toContain('watch')
  })

  it('连读群历史都没给的时候，如实说跨群搜索用不了', () => {
    const r = grantedCapabilities('offline_access contact:user.base:readonly')
    expect(r.core).toBe(false)
  })

  it('空的 scope 串不当成"全都有"', () => {
    const r = grantedCapabilities('')
    expect(r.core).toBe(false)
    expect(r.extras).toEqual([])
    expect(r.missing).toEqual(expect.arrayContaining(['watch', 'calendar']))
  })

  it('逗号分隔和多空格都认', () => {
    expect(grantedCapabilities(`im:chat:readonly,im:message:readonly,  ${WATCH}`)).toMatchObject({ core: true, extras: ['watch'] })
  })
})

describe('申请的 scope 要和实际调的 API 对得上', () => {
  /**
   * 2026-09-22 核对时发现两个缺口：`im:resource` 和 `docx:document` 代码里一直在用，
   * core 档里却没有。表现是盯群读不到图、私聊建不了文档——而且报错指向别处，
   * 很难看出根因是缺一个 scope。
   *
   * 完整的静态核对（调用 → scope）没法自动做，所以这里钉住的是**有据可查的那几项**：
   * 每一条都能指着 `client.ts` 里一个真实的调用点。漏了就是又一个"能力在、权限没申请"。
   */
  const client = readFileSync(join(import.meta.dirname, '..', 'src', 'feishu', 'client.ts'), 'utf8')
  const core = USER_SCOPE_TIERS.core as readonly string[]

  it('私聊建文档是以本人身份建的，所以要写权限不是只读', () => {
    // spillToDoc / archiveRoutineRun 都传 userToken；只有 readonly 的话会失败。
    expect(client).toContain('async createDocument(')
    expect(core).toContain('docx:document')
  })

  it('读别人群里的图和附件要 im:resource', () => {
    expect(client).toContain('async downloadMessageResource(')
    expect(core).toContain('im:resource')
  })

  it('翻历史、搜消息、列群各自的那一项都在', () => {
    expect(client).toContain('this.client.im.v1.message.list')
    expect(client).toContain('this.client.search.v2.message.create')
    expect(client).toContain('this.client.im.v1.chat.list')
    // 用户身份**没有** im:message.history:readonly 这个 scope（对着应用实际可选的清单核过）。
    // 读历史靠 p2p_msg / group_msg 那两个 get_as_user：单聊免审进 core，群那个要开通，在 watch 档。
    for (const s of ['im:message.p2p_msg:get_as_user', 'search:message', 'im:chat:readonly']) expect(core).toContain(s)
    expect(core).not.toContain('im:message.history:readonly')
  })

  it('要审批的两项仍然不在 core 里——一个没开通的 scope 会让整张授权页失败', () => {
    // 这正是分档的全部理由：20027 会让**所有**授权都失败，不只是那一项失效。
    expect(core).not.toContain('im:message.group_msg:get_as_user')
    expect(core).not.toContain('calendar:calendar:readonly')
  })

  it('以用户身份发消息始终不申请——那是身份边界，不是省一个权限', () => {
    const all = Object.values(USER_SCOPE_TIERS).flat() as string[]
    expect(all).not.toContain('im:message')
  })
})
