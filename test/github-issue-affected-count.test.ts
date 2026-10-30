/**
 * Friday 自己建的 Issue 正文里维护唯一的受影响人数块。
 * 人数 = 关联案件下已核实的真人报告人（原报告、+1、独立重复都算，同一人只算一次，机器人不算）。
 * 只改块内那一行、块外一字不动；块被人改过、删掉、标记不成对或不止一处就登记停止，之后不再读写。
 * 账本与指派同表（github_issue_operations，action='affected_count'）：写前登记、写后回读、结果未知不重写。
 * 真实 SQLite、真实 GitHubIdentity（PAT 模式，GitHubApiError 与 beforeRequest 的顺序照真实实现）；只有 HTTP 是合成的。
 */
import { describe, expect, it, vi } from 'vitest'
import { Bugs } from '../src/core/bugs.js'
import { MessageCache } from '../src/core/message-cache.js'
import { Registry } from '../src/core/registry.js'
import { loadConfig } from '../src/config.js'
import { GitHubApiError, GitHubIdentity, loadGitHubConfig, type GitHubHttp } from '../src/github/identity.js'
import {
  AFFECTED_COUNT_END, AFFECTED_COUNT_INTERVAL_MS, AFFECTED_COUNT_START, affectedCountLine, countAffectedReporters, IssueAffectedCount, parseAffectedCountBlock,
} from '../src/github/issue-affected-count.js'
import { IN_FLIGHT_GRACE_MS, IssueReconciliation } from '../src/github/issue-reconciliation.js'
import { IssueLinks } from '../src/github/issues.js'
import { createLogger } from '../src/log.js'

const NOW = 1_800_000_000_000
const REPO = 'org/a'
const BOT = 'ou_friday_bot'
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`
const ORIGINAL = '登录页白屏，点登录后一直转圈。\n\n---\n由 Friday 从群「测试群」的讨论整理（提出人：甲），2026/9/27 10:00:00。内容如与实际不符，直接在这里评论纠正即可。'
const block = (n: number) => `${AFFECTED_COUNT_START}\n${affectedCountLine(n)}\n${AFFECTED_COUNT_END}`
const log = createLogger('github-issue-affected-count-test', 'error')

type PatchMode = 'ok' | 'forbidden' | 'bad_gateway' | 'lost_before_apply' | 'lost_after_apply'

function setup(opts: { writeRepos?: string; enabled?: boolean; maxPerRound?: number } = {}) {
  const registry = new Registry(':memory:')
  const cache = new MessageCache(registry.db)
  const bugs = new Bugs(registry.db)
  let clock = NOW
  const links = new IssueLinks(registry.db, () => clock)
  const bodies = new Map<number, string | null>()
  const state = { patch: 'ok' as PatchMode, readError: false, failReadAfterPatch: false, tokenError: false, current: true, loseLockOnPatch: false }
  const calls: { method: string; path: string; body?: unknown }[] = []
  const http: GitHubHttp = { async request(method, path, body) {
    calls.push({ method, path, body })
    const match = path.match(/^\/repos\/org\/a\/issues\/(\d+)$/)
    if (!match) throw new Error(`unexpected ${method} ${path}`)
    const number = Number(match[1])
    if (!bodies.has(number)) return { status: 404, data: { message: 'Not Found' } as never }
    if (method === 'GET') {
      if (state.readError) throw new Error('read unavailable')
      return { status: 200, data: { number, title: '登录页白屏', state: 'open', html_url: url(number), body: bodies.get(number), user: { login: 'friday[bot]', type: 'Bot' } } as never }
    }
    if (method === 'PATCH') {
      if (state.patch === 'forbidden') return { status: 403, data: { message: 'Resource not accessible by integration' } as never }
      if (state.patch === 'bad_gateway') return { status: 502, data: { message: 'Bad Gateway' } as never }
      if (state.patch === 'lost_before_apply') throw new Error('connection reset before GitHub answered')
      bodies.set(number, (body as { body: string }).body)
      if (state.patch === 'lost_after_apply') throw new Error('connection reset after GitHub applied the request')
      if (state.failReadAfterPatch) state.readError = true
      return { status: 200, data: { number, html_url: url(number), body: bodies.get(number) } as never }
    }
    throw new Error(`unexpected ${method} ${path}`)
  } }
  const identity = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'synthetic-token', FRIDAY_GITHUB_REPOS: REPO, FRIDAY_GITHUB_WRITE_REPOS: opts.writeRepos ?? REPO } as NodeJS.ProcessEnv)!, log, http)
  // 换令牌失败发生在 beforeRequest 之前；调度锁在发送前丢失发生在 beforeRequest 里。两者的顺序与真实 GitHubIdentity.api 相同。
  const github = {
    api: ((...args: Parameters<GitHubIdentity['api']>) => {
      if (args[0] === 'PATCH' && state.tokenError) return Promise.reject(new GitHubApiError(401, '换 installation token 失败'))
      if (args[0] === 'PATCH' && state.loseLockOnPatch) state.current = false
      return identity.api(...args)
    }) as GitHubIdentity['api'],
    botLogin: () => identity.botLogin(),
    repoWritable: (repo: string) => identity.repoWritable(repo),
  }
  const sweeper = new IssueAffectedCount({ db: registry.db, links, github, enabled: opts.enabled ?? true, botOpenId: BOT, maxPerRound: opts.maxPerRound,
    assertCurrent: () => { if (!state.current) throw new Error('调度锁已失去') } })
  /** Friday 自己建单的账本行：与 openIssue 一样 planned → sent → confirmed。 */
  const fridayCreated = (number: number, body: string | null = ORIGINAL) => {
    bodies.set(number, body)
    const key = `open-${number}`
    links.planOperation({ requestKey: key, signature: `sig-${number}`, action: 'created', repo: REPO, fingerprint: `fp-${number}` })
    links.sentOperation(key, number, url(number))
    links.confirmOperation(key, { action: 'created', repo: REPO, number, url: url(number), title: '登录页白屏', state: 'open', assignees: [], labels: [], pending: [] })
  }
  let seq = 0
  /** 一条报告：默认是群里真人发的消息（进消息缓存）；task=true 表示宿主绑定的任务消息（私聊不进缓存）。 */
  const report = (input: { bucketId?: number; who?: string; sender?: { type: string; openId?: string }; cached?: boolean; task?: boolean; spaceId?: string }) => {
    const messageId = `om_${++seq}`
    const chatId = input.spaceId === 'space-b' ? 'chat-b' : 'chat-a'
    const sender = input.sender ?? { type: 'user', openId: input.who }
    if (input.cached !== false) cache.upsert(chatId, [{ messageId, createTimeMs: clock, msgType: 'text', senderName: '某人', senderOpenId: sender.openId, senderType: sender.type, text: '我也遇到了' }])
    if (input.task) registry.db.prepare("INSERT INTO tasks (session_key, message_id, requester_open_id, prompt, status, created_at) VALUES ('s', ?, ?, '我也遇到了', 'done', ?)").run(messageId, input.who ?? null, clock)
    return bugs.record({ spaceId: input.spaceId ?? 'space-a', title: '登录页白屏', chatId, text: '我也遇到了', bucketId: input.bucketId, messageId, reporterOpenId: input.who }).bucket.id
  }
  /** 一个案件：给出的每个人各报告一次，并关联到这张 Issue。 */
  const caseWith = (number: number, people: string[], spaceId = 'space-a') => {
    let id: number | undefined
    for (const who of people) id = report({ bucketId: id, who, spaceId })
    bugs.linkIssue(id!, url(number))
    return id!
  }
  const rows = () => registry.db.prepare("SELECT * FROM github_issue_operations WHERE action = 'affected_count' ORDER BY created_at, rowid").all() as Record<string, unknown>[]
  const patches = () => calls.filter(call => call.method === 'PATCH').length
  const lines = () => calls.map(call => `${call.method} ${call.path}`)
  return { registry, cache, bugs, links, github, sweeper, state, calls, bodies, fridayCreated, report, caseWith, rows, patches, lines,
    advance: (ms: number) => { clock += ms } }
}

describe('Friday 建的 Issue：受影响人数块', () => {
  it('两人附议：正文末尾追加唯一的人数块，人数 2，写后回读确认；人数没变的下一轮不读不写', async () => {
    const t = setup()
    t.fridayCreated(42)
    t.caseWith(42, ['ou_alice', 'ou_bob'])
    expect(await t.sweeper.sweep()).toMatchObject({ issues: 1, written: 1, stopped: 0 })
    expect(t.lines()).toEqual([`GET /repos/${REPO}/issues/42`, `PATCH /repos/${REPO}/issues/42`, `GET /repos/${REPO}/issues/42`])
    expect(t.calls[1]!.body).toEqual({ body: `${ORIGINAL}\n\n${block(2)}` })
    expect(t.bodies.get(42)).toBe(`${ORIGINAL}\n\n${block(2)}`)
    expect(affectedCountLine(2)).toBe('受影响人数：2（按飞书真人去重，Friday 自动维护）')
    const [row] = t.rows()
    expect(t.rows()).toHaveLength(1)
    expect(row).toMatchObject({ action: 'affected_count', status: 'confirmed', repo: REPO, number: 42, url: url(42), fingerprint: 'affected:org/a#42:2', error: null, origin_json: null })
    expect(JSON.parse(String(row!.result))).toEqual({ repo: REPO, number: 42, url: url(42), count: 2, block: affectedCountLine(2) })

    t.advance(AFFECTED_COUNT_INTERVAL_MS)
    expect(await t.sweeper.sweep()).toMatchObject({ issues: 1, idle: 1, written: 0 })
    expect(t.calls).toHaveLength(3)
    expect(t.rows()).toHaveLength(1)
  })

  it('同一人重复报告不加；第三个人来了只替换块内那一行，块外（含人改过的换行）一字不动', async () => {
    const t = setup()
    t.fridayCreated(42)
    const id = t.caseWith(42, ['ou_alice', 'ou_alice', 'ou_bob'])
    await t.sweeper.sweep()
    expect(t.bodies.get(42)).toBe(`${ORIGINAL}\n\n${block(2)}`)
    // 有人在网页上改了块外的内容；网页保存会把整篇换成 \r\n，块内同一行不算人工改过
    const edited = `人工补充：只在 Safari 上出现。\r\n\r\n${ORIGINAL.replace(/\n/g, '\r\n')}\r\n\r\n${block(2).replace(/\n/g, '\r\n')}\r\n\r\n人工在块后面也写了一句。`
    t.bodies.set(42, edited)
    t.report({ bucketId: id, who: 'ou_alice' })
    t.report({ bucketId: id, who: 'ou_carol' })
    t.advance(AFFECTED_COUNT_INTERVAL_MS)
    expect(await t.sweeper.sweep()).toMatchObject({ written: 1 })
    const after = t.bodies.get(42)!
    const start = edited.indexOf(AFFECTED_COUNT_START) + AFFECTED_COUNT_START.length
    const end = edited.indexOf(AFFECTED_COUNT_END)
    expect(after.slice(0, start)).toBe(edited.slice(0, start))
    expect(after.slice(after.indexOf(AFFECTED_COUNT_END))).toBe(edited.slice(end))
    expect(parseAffectedCountBlock(after)).toMatchObject({ kind: 'single', text: affectedCountLine(3) })
    expect(t.rows().map(row => [row.status, row.fingerprint])).toEqual([['confirmed', 'affected:org/a#42:2'], ['confirmed', 'affected:org/a#42:3']])
    expect(t.patches()).toBe(2)
  })

  it('只有一个人报告时不加块；不是 Friday 建的单（别人建的、Friday 只补过评论的）不读不写', async () => {
    const t = setup()
    t.fridayCreated(42)
    t.caseWith(42, ['ou_alice'])
    t.bodies.set(43, '别人建的单')
    t.caseWith(43, ['ou_alice', 'ou_bob'])
    t.bodies.set(44, '同名已有 Issue，Friday 只补了评论')
    t.links.planOperation({ requestKey: 'comment-44', signature: 'sig', action: 'commented', repo: REPO, number: 44, url: url(44) })
    t.links.sentOperation('comment-44', 44, url(44), `${url(44)}#issuecomment-1`)
    t.caseWith(44, ['ou_alice', 'ou_bob'])
    expect(await t.sweeper.sweep()).toMatchObject({ issues: 1, idle: 1, written: 0 })
    expect(t.calls).toEqual([])
    expect(t.rows()).toEqual([])
  })

  it('人工改过块内内容：不写，记一条「人工已改，停止自动维护」；之后人数再变也不再读写', async () => {
    const t = setup()
    t.fridayCreated(42)
    const id = t.caseWith(42, ['ou_alice', 'ou_bob'])
    await t.sweeper.sweep()
    const manual = t.bodies.get(42)!.replace(affectedCountLine(2), '受影响人数：5（含线下反馈，人工核实）')
    t.bodies.set(42, manual)
    t.report({ bucketId: id, who: 'ou_carol' })
    t.advance(AFFECTED_COUNT_INTERVAL_MS)
    expect(await t.sweeper.sweep()).toMatchObject({ written: 0, stopped: 1 })
    expect(t.lines().slice(3)).toEqual([`GET /repos/${REPO}/issues/42`])
    expect(t.bodies.get(42)).toBe(manual)
    const stop = t.rows().find(row => row.status === 'conflict')
    expect(stop).toMatchObject({ request_key: 'affected-count-stop:org/a#42', action: 'affected_count', repo: REPO, number: 42, error: '人工已改，停止自动维护' })
    expect(JSON.parse(String(stop!.result))).toMatchObject({ reason: 'manual_edit', expected: affectedCountLine(2), observed: '受影响人数：5（含线下反馈，人工核实）' })

    t.report({ bucketId: id, who: 'ou_dave' })
    t.advance(AFFECTED_COUNT_INTERVAL_MS)
    expect(await t.sweeper.sweep()).toMatchObject({ written: 0, stopped: 0, halted: 1 })
    expect(t.calls).toHaveLength(4)
    expect(t.rows().filter(row => row.status === 'conflict')).toHaveLength(1)
  })

  it('人工删掉整个块：同样停止，不补回去', async () => {
    const t = setup()
    t.fridayCreated(42)
    const id = t.caseWith(42, ['ou_alice', 'ou_bob'])
    await t.sweeper.sweep()
    t.bodies.set(42, ORIGINAL)
    t.report({ bucketId: id, who: 'ou_carol' })
    t.advance(AFFECTED_COUNT_INTERVAL_MS)
    expect(await t.sweeper.sweep()).toMatchObject({ written: 0, stopped: 1 })
    expect(t.patches()).toBe(1)
    expect(t.bodies.get(42)).toBe(ORIGINAL)
    expect(t.rows().find(row => row.status === 'conflict')).toMatchObject({ error: '人工已改，停止自动维护' })
    expect(JSON.parse(String(t.rows().find(row => row.status === 'conflict')!.result))).toMatchObject({ reason: 'block_removed' })
  })

  it('块标记不成对或不止一处：不写并记录；Friday 没写过却已有块：不写并记录', async () => {
    const unpaired = setup()
    unpaired.fridayCreated(42, `${ORIGINAL}\n\n${AFFECTED_COUNT_START}\n受影响人数：9`)
    unpaired.caseWith(42, ['ou_alice', 'ou_bob'])
    expect(await unpaired.sweeper.sweep()).toMatchObject({ written: 0, stopped: 1 })
    expect(unpaired.patches()).toBe(0)
    expect(unpaired.rows()).toEqual([expect.objectContaining({ status: 'conflict', error: '人数块标记不成对或不止一处，停止自动维护' })])

    const twice = setup()
    twice.fridayCreated(42, `${ORIGINAL}\n\n${block(2)}\n\n${block(3)}`)
    twice.caseWith(42, ['ou_alice', 'ou_bob'])
    expect(await twice.sweeper.sweep()).toMatchObject({ written: 0, stopped: 1 })
    expect(twice.patches()).toBe(0)
    expect(JSON.parse(String(twice.rows()[0]!.result))).toMatchObject({ reason: 'malformed' })

    const foreign = setup()
    foreign.fridayCreated(42, `${ORIGINAL}\n\n${block(7)}`)
    foreign.caseWith(42, ['ou_alice', 'ou_bob'])
    expect(await foreign.sweeper.sweep()).toMatchObject({ written: 0, stopped: 1 })
    expect(foreign.patches()).toBe(0)
    expect(foreign.rows()).toEqual([expect.objectContaining({ status: 'conflict', error: '正文里已有不是 Friday 写入的人数块，停止自动维护' })])
  })

  it('开关 off：不读库、不调 GitHub、不记账', async () => {
    const t = setup({ enabled: false })
    t.fridayCreated(42)
    t.caseWith(42, ['ou_alice', 'ou_bob'])
    const prepare = vi.spyOn(t.registry.db, 'prepare')
    expect(await t.sweeper.sweep()).toMatchObject({ skipped: 'disabled', written: 0 })
    expect(prepare).not.toHaveBeenCalled()
    expect(t.calls).toEqual([])
    prepare.mockRestore()
    expect(t.rows()).toEqual([])

    const base = { FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: '/tmp/fh' }
    expect(loadConfig(base as NodeJS.ProcessEnv).issueAffectedCount.enabled).toBe(false)
    expect(loadConfig({ ...base, FRIDAY_ISSUE_AFFECTED_COUNT: 'on' } as NodeJS.ProcessEnv).issueAffectedCount.enabled).toBe(true)
    expect(loadConfig({ ...base, FRIDAY_ISSUE_AFFECTED_COUNT: 'off' } as NodeJS.ProcessEnv).issueAffectedCount.enabled).toBe(false)
    expect(() => loadConfig({ ...base, FRIDAY_ISSUE_AFFECTED_COUNT: 'yes' } as NodeJS.ProcessEnv)).toThrow(/FRIDAY_ISSUE_AFFECTED_COUNT/)
  })

  it('仓库不在可写名单（FRIDAY_GITHUB_WRITE_REPOS）：不读不写', async () => {
    const t = setup({ writeRepos: 'org/other' })
    t.fridayCreated(42)
    t.caseWith(42, ['ou_alice', 'ou_bob'])
    expect(await t.sweeper.sweep()).toMatchObject({ issues: 1, notWritable: 1, written: 0 })
    expect(t.calls).toEqual([])
    expect(t.rows()).toEqual([])
  })
})

describe('写入结果未知：不重写，按只读核对处理', () => {
  it('请求发出后连接断开且没生效：记 unknown；过了宽限期核对证明没生效，同一人数也不重发；人数再变才写新值', async () => {
    const t = setup()
    t.fridayCreated(42)
    const id = t.caseWith(42, ['ou_alice', 'ou_bob'])
    t.state.patch = 'lost_before_apply'
    expect(await t.sweeper.sweep()).toMatchObject({ written: 0, unknown: 1 })
    expect(t.lines()).toEqual([`GET /repos/${REPO}/issues/42`, `PATCH /repos/${REPO}/issues/42`, `GET /repos/${REPO}/issues/42`])
    expect(t.rows()).toEqual([expect.objectContaining({ status: 'unknown', fingerprint: 'affected:org/a#42:2' })])
    expect(JSON.parse(String(t.rows()[0]!.reconciliation))).toMatchObject({ result: 'too_recent' })

    t.state.patch = 'ok'
    t.advance(IN_FLIGHT_GRACE_MS - 60_000)
    expect(await t.sweeper.sweep()).toMatchObject({ skipped: 'not_due' })
    t.advance(AFFECTED_COUNT_INTERVAL_MS)
    expect(await t.sweeper.sweep()).toMatchObject({ written: 0 })
    expect(t.patches()).toBe(1)
    expect(t.rows()).toEqual([expect.objectContaining({ status: 'unknown', error: 'verified_absent' })])
    expect(t.calls).toHaveLength(4)
    t.advance(AFFECTED_COUNT_INTERVAL_MS)
    await t.sweeper.sweep()
    expect(t.calls).toHaveLength(4)
    expect(t.patches()).toBe(1)
    expect(t.bodies.get(42)).toBe(ORIGINAL)

    t.report({ bucketId: id, who: 'ou_carol' })
    t.advance(AFFECTED_COUNT_INTERVAL_MS)
    expect(await t.sweeper.sweep()).toMatchObject({ written: 1 })
    expect(t.patches()).toBe(2)
    expect(t.bodies.get(42)).toBe(`${ORIGINAL}\n\n${block(3)}`)
  })

  it('请求其实已生效但响应丢了：当场只读核对确认，不再发第二次', async () => {
    const t = setup()
    t.fridayCreated(42)
    t.caseWith(42, ['ou_alice', 'ou_bob'])
    t.state.patch = 'lost_after_apply'
    expect(await t.sweeper.sweep()).toMatchObject({ written: 1, unknown: 0 })
    expect(t.patches()).toBe(1)
    expect(t.rows()).toEqual([expect.objectContaining({ status: 'confirmed', fingerprint: 'affected:org/a#42:2' })])
    expect(JSON.parse(String(t.rows()[0]!.reconciliation))).toMatchObject({ result: 'confirmed' })
    t.state.patch = 'ok'
    t.advance(AFFECTED_COUNT_INTERVAL_MS)
    expect(await t.sweeper.sweep()).toMatchObject({ idle: 1 })
    expect(t.patches()).toBe(1)
  })

  it('502 算结果未知（不是明确拒绝）；403 是明确拒绝，记 operation_failed，同一人数不再试', async () => {
    const gateway = setup()
    gateway.fridayCreated(42)
    gateway.caseWith(42, ['ou_alice', 'ou_bob'])
    gateway.state.patch = 'bad_gateway'
    expect(await gateway.sweeper.sweep()).toMatchObject({ unknown: 1 })
    expect(gateway.rows()).toEqual([expect.objectContaining({ status: 'unknown' })])

    const denied = setup()
    denied.fridayCreated(42)
    denied.caseWith(42, ['ou_alice', 'ou_bob'])
    denied.state.patch = 'forbidden'
    expect(await denied.sweeper.sweep()).toMatchObject({ failed: 1 })
    expect(denied.rows()).toEqual([expect.objectContaining({ status: 'operation_failed', error: expect.stringContaining('HTTP 403') })])
    denied.advance(AFFECTED_COUNT_INTERVAL_MS)
    expect(await denied.sweeper.sweep()).toMatchObject({ idle: 1 })
    expect(denied.patches()).toBe(1)
  })

  it('发送前写门失效（调度锁丢了）：撤销占位、不发 PATCH、本轮中止；换令牌失败没发出：撤销占位，下一轮照常写', async () => {
    const t = setup()
    t.fridayCreated(42)
    t.caseWith(42, ['ou_alice', 'ou_bob'])
    t.state.loseLockOnPatch = true
    await expect(t.sweeper.sweep()).rejects.toThrow(/调度锁已失去/)
    expect(t.patches()).toBe(0)
    expect(t.rows()).toEqual([])
    t.state.loseLockOnPatch = false
    t.state.current = true
    t.state.tokenError = true
    t.advance(AFFECTED_COUNT_INTERVAL_MS)
    expect(await t.sweeper.sweep()).toMatchObject({ waiting: 1, written: 0, failed: 0 })
    expect(t.rows()).toEqual([])
    t.state.tokenError = false
    t.advance(AFFECTED_COUNT_INTERVAL_MS)
    expect(await t.sweeper.sweep()).toMatchObject({ written: 1 })
    expect(t.patches()).toBe(1)
    expect(t.bodies.get(42)).toBe(`${ORIGINAL}\n\n${block(2)}`)
  })

  it('写后回读失败：行停在 sent；下一轮只回读确认，不重发', async () => {
    const t = setup()
    t.fridayCreated(42)
    t.caseWith(42, ['ou_alice', 'ou_bob'])
    t.state.failReadAfterPatch = true
    expect(await t.sweeper.sweep()).toMatchObject({ written: 0, waiting: 1 })
    expect(t.rows()).toEqual([expect.objectContaining({ status: 'sent' })])
    t.state.readError = false
    t.state.failReadAfterPatch = false
    t.advance(AFFECTED_COUNT_INTERVAL_MS)
    expect(await t.sweeper.sweep()).toMatchObject({ written: 1 })
    expect(t.patches()).toBe(1)
    expect(t.rows()).toEqual([expect.objectContaining({ status: 'confirmed' })])
  })

  it('IssueReconciliation 对人数块行：块内是这次要写的内容则确认；宽限期后仍不是则 verified_absent；评论行仍拒绝', async () => {
    const t = setup()
    t.fridayCreated(42, `${ORIGINAL}\n\n${block(2)}`)
    t.links.planOperation({ requestKey: 'affected-planned', signature: 'sig', action: 'affected_count', repo: REPO, fingerprint: 'affected:org/a#42:2', number: 42, url: url(42) })
    const reconciliation = new IssueReconciliation(t.github, t.links)
    expect(await reconciliation.reconcile('affected-planned', {})).toMatchObject({ result: 'in_flight' })
    expect(t.calls).toEqual([])
    t.advance(IN_FLIGHT_GRACE_MS)
    expect(await reconciliation.reconcile('affected-planned', {})).toMatchObject({ result: 'confirmed', status: 'confirmed' })
    expect(JSON.parse(String(t.rows()[0]!.result))).toEqual({ repo: REPO, number: 42, url: url(42), count: 2, block: affectedCountLine(2) })

    t.links.planOperation({ requestKey: 'affected-other', signature: 'sig', action: 'affected_count', repo: REPO, fingerprint: 'affected:org/a#42:3', number: 42, url: url(42) })
    t.advance(IN_FLIGHT_GRACE_MS)
    expect(await reconciliation.reconcile('affected-other', {})).toMatchObject({ result: 'verified_absent', status: 'planned' })
    expect(await reconciliation.reconcile('affected-planned', {})).toMatchObject({ result: 'already_resolved' })
  })
})

describe('人数口径与轮询', () => {
  it('只数已核实的真人：机器人消息、Friday 自己、没有报告人的汇总、核实不了的、报告人与消息发送者对不上的都不算', () => {
    const t = setup()
    const id = t.report({ who: 'ou_alice' })
    t.report({ bucketId: id, who: 'ou_alice' })
    t.report({ bucketId: id, who: 'ou_helper_bot', sender: { type: 'app' } })
    t.report({ bucketId: id, who: 'ou_other_bot', sender: { type: 'app', openId: 'ou_other_bot' } })
    t.report({ bucketId: id, who: BOT })
    t.report({ bucketId: id })
    t.report({ bucketId: id, who: 'ou_ghost', cached: false })
    t.report({ bucketId: id, who: 'ou_dm_user', cached: false, task: true })
    t.report({ bucketId: id, who: 'ou_claimed', sender: { type: 'user', openId: 'ou_real_sender' } })
    t.report({ bucketId: id, who: 'on_union_id_not_open_id' })
    expect(countAffectedReporters(t.registry.db, [id], BOT)).toBe(2)
    expect(t.bugs.get(id)!.count).toBe(10)
  })

  it('几个案件关联同一张 Issue：按人合并；已停止跟进的案件不算', async () => {
    const t = setup()
    t.fridayCreated(42)
    t.caseWith(42, ['ou_alice', 'ou_bob'])
    t.caseWith(42, ['ou_bob', 'ou_carol'], 'space-b')
    const stopped = t.caseWith(42, ['ou_dave', 'ou_erin'])
    t.bugs.stopFollowing(stopped, 'space-a')
    expect(await t.sweeper.sweep()).toMatchObject({ issues: 1, written: 1 })
    expect(parseAffectedCountBlock(t.bodies.get(42)!)).toMatchObject({ kind: 'single', text: affectedCountLine(3) })
  })

  it('每轮有上限：超出的留到下一轮；没到间隔的调用直接返回', async () => {
    const t = setup({ maxPerRound: 2 })
    for (const n of [42, 43, 44]) {
      t.fridayCreated(n)
      t.caseWith(n, ['ou_alice', 'ou_bob'])
    }
    expect(await t.sweeper.sweep()).toMatchObject({ issues: 3, written: 2, deferred: 1 })
    expect(await t.sweeper.sweep()).toMatchObject({ skipped: 'not_due' })
    expect(t.patches()).toBe(2)
    t.advance(AFFECTED_COUNT_INTERVAL_MS)
    expect(await t.sweeper.sweep()).toMatchObject({ written: 1, idle: 2, deferred: 0 })
    expect(t.patches()).toBe(3)
    for (const n of [42, 43, 44]) expect(t.bodies.get(n)).toBe(`${ORIGINAL}\n\n${block(2)}`)
  })

  it('空正文：块就是全文；读不到 Issue 时本轮不写也不记账', async () => {
    const t = setup()
    t.fridayCreated(42, null)
    t.caseWith(42, ['ou_alice', 'ou_bob'])
    t.state.readError = true
    expect(await t.sweeper.sweep()).toMatchObject({ written: 0, waiting: 1 })
    expect(t.rows()).toEqual([])
    t.state.readError = false
    t.advance(AFFECTED_COUNT_INTERVAL_MS)
    expect(await t.sweeper.sweep()).toMatchObject({ written: 1 })
    expect(t.bodies.get(42)).toBe(block(2))
  })
})
