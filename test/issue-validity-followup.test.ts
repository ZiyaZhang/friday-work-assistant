/**
 * P3-6 陈旧核实补全：确认卡 @ 成员表能对应到本群成员的提出者与参与者；“仍有效”的待决断交给负责人规则唯一命中的人，
 * 判断不了交给部署配置的第一位可信用户，没配可信用户回退绑定负责人；Friday 提醒之后人改了标签，记下来，不按旧判断重复提醒。
 * 只读 GitHub；成员表、群成员、CODEOWNERS 都是合成的。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Inbox } from '../src/core/inbox.js'
import { Identities } from '../src/core/identities.js'
import { IssueWatch } from '../src/core/issue-watch.js'
import { IssueValidityRequests, issueLabelCorrectionKey, issueValidityCard, issueValidityDecisionText, labelCorrectionStep, parseLabelCorrection,
  type IssueLabelCorrection, type IssueValidityRequest } from '../src/core/issue-validity.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { parseIssueValidityAssessment, readIssueThread } from '../src/github/issue-thread.js'
import { GitHubApiError, type GitHubIdentity } from '../src/github/identity.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const DAY = 86400_000, HOUR = 3600_000, NOW = Date.UTC(2026, 8, 22)
const PATH = 'src/plugin/page.ts'
const body = `启动之后 ${PATH} 渲染的插件页面一直空白，我还在等待如何排查。`
const ISSUE_URL = 'https://github.com/org/demo/issues/7'
const closes: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close() })

/** 卡片里所有文字：标题、plain_text 的 text.content、markdown 的 content、按钮文字。 */
function cardWords(card: Record<string, unknown> | undefined): string {
  const parts: string[] = []
  const walk = (el: unknown): void => {
    if (!el || typeof el !== 'object') return
    const o = el as Record<string, unknown>
    if (typeof o.content === 'string') parts.push(o.content)
    for (const key of ['header', 'title', 'body', 'text', 'elements', 'columns']) {
      const child = o[key]
      if (Array.isArray(child)) child.forEach(walk); else walk(child)
    }
  }
  walk(card)
  return parts.join('\n')
}

interface Options {
  /** 不传成员表（目录未配置） */
  directory?: boolean
  trustedUsers?: string
  codeowners?: string
  /** 模型输出里的 paths；默认给线程里真实出现的那条 */
  paths?: string[]
  /** 群成员：名字 + open_id */
  members?: { name: string; openId: string }[]
  /** 成员表行 */
  roster?: { login: string; name: string; openId?: string }[]
  refreshIdentities?: () => Promise<unknown>
}

function fixture(opts: Options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-issue-followup-')), registry = new Registry(':memory:')
  let clock = NOW
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off',
    ...(opts.trustedUsers !== undefined ? { FRIDAY_TRUSTED_USERS: opts.trustedUsers } : {}) })
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'oc_synthetic', openId: 'alice' })
  const binding = { spaceId: space.id, boundBy: 'alice', repo: 'org/demo', labels: [], version: 'original', since: NOW - 30 * DAY }
  registry.setKv(`issue-watch:${space.id}`, JSON.stringify(binding))
  const raw = { number: 7, title: '插件页面空白', body, user: { login: 'reporter' }, html_url: ISSUE_URL,
    state: 'open', assignees: [] as { login: string }[], labels: [] as { name: string }[], comments: 1,
    created_at: new Date(NOW - 20 * DAY).toISOString(), updated_at: new Date(NOW - 2 * DAY).toISOString() }
  const comments: { id: number; body: string; user: { login: string; type: string }; created_at: string }[] =
    [{ id: 19, body: '目前我这边仍然可以稳定复现这个问题。', user: { login: 'reporter', type: 'User' }, created_at: raw.updated_at }]
  const timeline: Record<string, unknown>[] = [{ id: 1, event: 'commented' }]
  const gh = { codeowners: opts.codeowners, reads: [] as string[] }
  const api = vi.fn(async (method: string, path: string): Promise<unknown> => {
    expect(method).toBe('GET')
    gh.reads.push(path)
    const url = new URL(path, 'https://api.github.com'), page = Number(url.searchParams.get('page') ?? 1)
    const file = /^\/repos\/org\/demo\/contents\/(.+)$/.exec(url.pathname)
    if (file) {
      if (file[1] === '.github/CODEOWNERS' && gh.codeowners !== undefined) return { content: Buffer.from(gh.codeowners).toString('base64'), encoding: 'base64' }
      throw new GitHubApiError(404, 'Not Found')
    }
    if (url.pathname.endsWith('/timeline')) return structuredClone(timeline.slice((page - 1) * 100, page * 100))
    if (url.pathname.endsWith('/comments')) return structuredClone(comments.slice((page - 1) * 100, page * 100))
    if (/\/issues\/7$/.test(url.pathname)) return structuredClone(raw)
    return structuredClone([raw])
  })
  const github = { api, botLogin: async () => 'friday[bot]', repoAllowed: () => true } as unknown as GitHubIdentity
  const watch = new IssueWatch(registry.db, () => clock), inbox = new Inbox(registry.db), requests = new IssueValidityRequests(registry.db, () => clock)
  const members = opts.members ?? [{ name: '负责人甲', openId: 'alice' }, { name: '张三', openId: 'ou_reporter' }, { name: '李四', openId: 'ou_c1' }, { name: 'Carol', openId: 'ou_carol' }]
  const fake = Object.assign(new FakeFeishu(), { chatMembers: vi.fn(async (_chatId: string) => members) })
  fake.members.set(space.chatId!, new Set(members.map(m => m.openId)))
  const identities = new Identities(registry.db)
  identities.upsertFromRoster(opts.roster ?? [
    { login: 'reporter', name: '张三', openId: 'ou_reporter' },
    { login: 'c1', name: '李四', openId: 'ou_c1' },
    { login: 'c2', name: '王五', openId: 'ou_c2' },
    { login: 'c3', name: '赵六' },
    { login: 'carol', name: 'Carol', openId: 'ou_carol' },
    { login: 'dave', name: 'Dave', openId: 'ou_dave' },
  ])
  const log = createLogger('issue-followup-test', 'error'), execution = managedHostRuntime(registry, home, log)
  const output = JSON.stringify({ verdict: 'ask', evidence: [{ ref: 'comment:19', quote: comments[0]!.body }], paths: opts.paths ?? [PATH] })
  execution.peer.state.script = [{ kind: 'text', text: output }]
  const host = new Orchestrator({ cfg, registry, ...sp, issueWatch: watch, inbox, github,
    ...(opts.directory === false ? {} : { identities }), ...(opts.refreshIdentities ? { refreshIdentities: opts.refreshIdentities } : {}),
    feishu: asFeishuClient(fake), runtime: execution.runtime, managed: execution.managed,
    memory: new ChannelMemory(registry.db), tokens: new TokenIssuer('synthetic'), botOpenId: 'bot',
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/unused', log, now: () => clock })
  closes.push(async () => { await execution.runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const latest = () => {
    const row = registry.db.prepare('SELECT snapshot FROM issue_validity_requests ORDER BY rowid DESC LIMIT 1').get() as { snapshot: string } | undefined
    return row ? requests.get(JSON.parse(row.snapshot).id)! : undefined
  }
  const action = (choice = 'effective') => {
    const request = latest()!
    return { operatorOpenId: 'alice', chatId: space.chatId!, messageId: request.messageId,
      value: { action: 'issue_validity', id: request.id, digest: request.digest, choice }, raw: {} }
  }
  const lastCard = () => cardWords((fake.sent.at(-1)?.payload as { card?: Record<string, unknown> } | undefined)?.card)
  const comment = (id: number, login: string, text: string, at: number, type = 'User') => {
    comments.push({ id, body: text, user: { login, type }, created_at: new Date(at).toISOString() })
    raw.comments = comments.length
    raw.updated_at = new Date(Math.max(at, Date.parse(raw.updated_at))).toISOString()
  }
  const label = (names: string[], at: number) => { raw.labels = names.map(name => ({ name })); raw.updated_at = new Date(at).toISOString() }
  const correction = () => parseLabelCorrection(registry.getKv(issueLabelCorrectionKey('org/demo', 7)))
  return { cfg, registry, ...sp, space, binding, raw, comments, timeline, gh, api, github, watch, inbox, requests, fake, execution, host, output, identities,
    latest, action, lastCard, comment, label, correction, prompts: () => execution.peer.state.allPrompts.length,
    now: () => clock, advance: (ms: number) => { clock += ms } }
}

describe('确认卡 @ 成员表能对应到本群成员的提出者与参与者', () => {
  it('mentions the reporter and a participant who map to current group members; names the rest; skips bots', async () => {
    const t = fixture()
    t.comment(20, 'c1', '我在 2.3 版本上也能复现。', NOW - 2 * DAY + HOUR)
    t.comment(21, 'c2', '我这边看到同样的空白页。', NOW - 2 * DAY + 2 * HOUR)
    t.comment(22, 'c3', '排查了一下，可能与缓存有关。', NOW - 2 * DAY + 3 * HOUR)
    t.comment(23, 'c4', '同样的问题，等修复。', NOW - 2 * DAY + 4 * HOUR)
    t.comment(24, 'friday[bot]', '已记录。', NOW - 2 * DAY + 5 * HOUR, 'Bot')
    expect(await t.host.sweepIssues(DAY)).toBe(1)
    const card = t.lastCard()
    expect(card).toContain('提出者：<at id="ou_reporter"></at>')
    expect(card).toContain('<at id="ou_c1"></at>')
    // c2 在成员表里有 open_id，但不在本群：写名字，不 @；c3 只有名字；c4 成员表里没有
    expect(card).toContain('王五（GitHub c2）'); expect(card).not.toContain('ou_c2')
    expect(card).toContain('赵六（GitHub c3）'); expect(card).toContain('GitHub c4')
    expect(card).not.toContain('friday[bot]')
    expect(card).toContain('向提出者核实'); expect(card).toContain('已按成员表把提出者、参与者对应到本群成员并 @')
    expect(t.latest()?.people).toEqual([
      { role: 'author', login: 'reporter', name: '张三', openId: 'ou_reporter' },
      { role: 'participant', login: 'c4' },
      { role: 'participant', login: 'c3', name: '赵六' },
      { role: 'participant', login: 'c2', name: '王五' },
      { role: 'participant', login: 'c1', name: '李四', openId: 'ou_c1' },
    ])
    expect(t.latest()).toMatchObject({ labels: [], paths: [PATH] })
    expect(t.fake.chatMembers).toHaveBeenCalledTimes(1)
  })

  it('a reporter who is in the directory but not in the group is named, not mentioned', async () => {
    const t = fixture({ members: [{ name: '负责人甲', openId: 'alice' }] })
    expect(await t.host.sweepIssues(DAY)).toBe(1)
    const card = t.lastCard()
    expect(card).toContain('提出者：张三（GitHub reporter）'); expect(card).not.toContain('<at ')
    expect(card).toContain('只写名字，不 @')
    expect(t.latest()?.people).toEqual([{ role: 'author', login: 'reporter', name: '张三' }])
  })

  it('without a configured directory the card still goes out with GitHub logins only, and nothing is refreshed', async () => {
    const refresh = vi.fn(async () => undefined)
    const t = fixture({ directory: false, refreshIdentities: refresh })
    t.comment(20, 'c1', '我在 2.3 版本上也能复现。', NOW - 2 * DAY + HOUR)
    expect(await t.host.sweepIssues(DAY)).toBe(1)
    const card = t.lastCard()
    expect(card).toContain('提出者：GitHub reporter；参与者：GitHub c1'); expect(card).not.toContain('<at ')
    expect(card).toContain('向提出者核实')
    expect(t.latest()?.people).toEqual([{ role: 'author', login: 'reporter' }, { role: 'participant', login: 'c1' }])
    expect(refresh).not.toHaveBeenCalled(); expect(t.fake.chatMembers).not.toHaveBeenCalled()
  })

  it('refreshes the directory once for an unknown login and mentions the person if the refresh adds them', async () => {
    let directory: Identities | undefined
    const refresh = vi.fn(async () => { directory?.upsertFromRoster([{ login: 'reporter', name: '张三', openId: 'ou_reporter' }]) })
    const t = fixture({ roster: [{ login: 'carol', name: 'Carol', openId: 'ou_carol' }], refreshIdentities: refresh })
    directory = t.identities
    t.comment(20, 'c1', '我在 2.3 版本上也能复现。', NOW - 2 * DAY + HOUR)
    expect(await t.host.sweepIssues(DAY)).toBe(1)
    expect(t.lastCard()).toContain('提出者：<at id="ou_reporter"></at>；参与者：GitHub c1')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('a card rendered from a snapshot without people (pre-existing rows) keeps the old shape', () => {
    const request = { id: 'r1', spaceId: 's', chatId: 'oc', requesterOpenId: 'alice', binding: '{}', repo: 'org/demo', number: 7, title: 't', url: ISSUE_URL,
      digest: 'd', evidence: [{ ref: 'body', quote: '一段原文一段原文一段原文' }], state: 'sent', createdAt: NOW, expiresAt: NOW + DAY, decisionRef: 1 } satisfies IssueValidityRequest
    const text = cardWords(issueValidityCard(request))
    expect(text).not.toContain('提出者：'); expect(text).toContain('向提出者核实'); expect(text).toContain('只写名字，不 @')
  })
})

describe('“仍有效”：待决断交给按规则找到的负责人', () => {
  it('a unique CODEOWNERS owner who is a current group member receives the decision with the quote and the link', async () => {
    const t = fixture({ codeowners: '/src/plugin/ @carol\n', trustedUsers: 'ou_ziya ou_other' })
    await t.host.sweepIssues(DAY)
    const result = await t.host.handleCardAction(t.action())
    expect(JSON.stringify(result)).toContain('Carol（GitHub carol）')
    expect(t.latest()).toMatchObject({ state: 'confirmed', decisionOwnerOpenId: 'ou_carol' })
    expect(t.inbox.pending('alice')).toEqual([]); expect(t.inbox.pending('ou_ziya')).toEqual([])
    const [item] = t.inbox.pending('ou_carol')
    expect(t.inbox.pending('ou_carol')).toHaveLength(1)
    expect(item).toMatchObject({ kind: 'decision', spaceId: t.space.id, title: '已核实仍有效：org/demo#7，请决定下一步' })
    expect(item!.why).toContain(`按 CODEOWNERS，涉及的路径（${PATH}）归你（GitHub carol）`)
    expect(item!.why).toContain(`评论原文：「${t.comments[0]!.body}」`)
    expect(item!.why).toContain(`${ISSUE_URL}#issuecomment-19`)
    expect(item!.why!.length).toBeLessThanOrEqual(300)
    expect(t.gh.reads).toContain('/repos/org/demo/contents/.github/CODEOWNERS')
    expect(t.api.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    // 重放不再创建第二条，也不换人
    await t.host.handleCardAction(t.action())
    expect(t.inbox.pending('ou_carol')).toHaveLength(1)
  })

  it('several CODEOWNERS owners: the decision goes to the first configured trusted user with the reason', async () => {
    const t = fixture({ codeowners: '/src/plugin/ @carol @dave\n', trustedUsers: 'ou_ziya ou_other' })
    await t.host.sweepIssues(DAY)
    const result = await t.host.handleCardAction(t.action())
    expect(JSON.stringify(result)).toContain('可信用户')
    expect(t.inbox.pending('ou_carol')).toEqual([]); expect(t.inbox.pending('ou_other')).toEqual([]); expect(t.inbox.pending('alice')).toEqual([])
    const [item] = t.inbox.pending('ou_ziya')
    expect(item).toMatchObject({ kind: 'decision', spaceId: t.space.id })
    expect(item!.why).toContain('没有唯一负责人（CODEOWNERS 有多个负责人（carol、dave）），交给你定')
    expect(item!.why).toContain(`${ISSUE_URL}#issuecomment-19`)
    expect(t.latest()?.decisionOwnerOpenId).toBe('ou_ziya')
  })

  it('without a trusted user configured, the decision falls back to the binding owner and says why', async () => {
    const t = fixture()
    await t.host.sweepIssues(DAY)
    const result = await t.host.handleCardAction(t.action())
    expect(JSON.stringify(result)).toContain('也没有配置可信用户')
    const [item] = t.inbox.pending('alice')
    expect(t.inbox.pending('alice')).toHaveLength(1)
    expect(item!.why).toContain('没有唯一负责人（仓库里没有 CODEOWNERS），也没有配置可信用户')
    expect(item!.why).toContain(`${ISSUE_URL}#issuecomment-19`)
    expect(t.latest()?.decisionOwnerOpenId).toBe('alice')
  })

  it.each([
    ['a unique owner who is not in the group', '/src/plugin/ @dave\n', 'CODEOWNERS 唯一负责人是 GitHub dave，未能确认他是当前群成员'],
    ['a unique owner missing from the directory', '/src/plugin/ @erin\n', 'CODEOWNERS 唯一负责人是 GitHub erin，成员表里没有这个账号'],
    ['a team owner', '/src/plugin/ @org/plugins\n', 'CODEOWNERS 指向团队，没有具体的人'],
  ])('%s: the decision goes to the trusted user, never to a guessed person', async (_name, codeowners, reason) => {
    const t = fixture({ codeowners, trustedUsers: 'ou_ziya' })
    await t.host.sweepIssues(DAY)
    await t.host.handleCardAction(t.action())
    expect(t.inbox.pending('ou_dave')).toEqual([]); expect(t.inbox.pending('alice')).toEqual([])
    expect(t.inbox.pending('ou_ziya')[0]?.why).toContain(reason)
  })

  it('model paths that do not appear verbatim in the thread are dropped, so CODEOWNERS is not consulted', async () => {
    const t = fixture({ codeowners: '/src/plugin/ @carol\n', trustedUsers: 'ou_ziya', paths: ['src/plugin/other.ts', '../etc/passwd'] })
    await t.host.sweepIssues(DAY)
    expect(t.latest()?.paths).toEqual([])
    await t.host.handleCardAction(t.action())
    expect(t.inbox.pending('ou_carol')).toEqual([])
    expect(t.inbox.pending('ou_ziya')[0]?.why).toContain('没有给出涉及的文件路径，未按 CODEOWNERS 判断')
    expect(t.gh.reads).not.toContain('/repos/org/demo/contents/.github/CODEOWNERS')
  })

  it('not needed records nothing for anyone and reads no CODEOWNERS', async () => {
    const t = fixture({ codeowners: '/src/plugin/ @carol\n', trustedUsers: 'ou_ziya' })
    await t.host.sweepIssues(DAY)
    await t.host.handleCardAction(t.action('not_needed'))
    expect(t.latest()?.state).toBe('not_needed'); expect(t.latest()?.decisionOwnerOpenId).toBeUndefined()
    for (const who of ['alice', 'ou_carol', 'ou_ziya']) expect(t.inbox.pending(who)).toEqual([])
    expect(t.gh.reads).not.toContain('/repos/org/demo/contents/.github/CODEOWNERS')
  })

  it('a binding that changes during the CODEOWNERS read invalidates the card and records nothing', async () => {
    const t = fixture({ codeowners: '/src/plugin/ @carol\n', trustedUsers: 'ou_ziya' })
    await t.host.sweepIssues(DAY)
    const original = t.api.getMockImplementation()!
    t.api.mockImplementation(async (...args) => {
      if (args[1].includes('/contents/')) t.registry.setKv(`issue-watch:${t.space.id}`, '')
      return original(...args)
    })
    await t.host.handleCardAction(t.action())
    expect(t.latest()?.state).toBe('invalidated')
    for (const who of ['alice', 'ou_carol', 'ou_ziya']) expect(t.inbox.pending(who)).toEqual([])
  })
})

describe('Friday 提醒之后人改了标签', () => {
  it('a changed label set after the notice is recorded; the issue is not re-asked this round or while it stays corrected', async () => {
    const t = fixture()
    expect(await t.host.sweepIssues(DAY)).toBe(1)
    const first = t.latest()!
    expect(first.labels).toEqual([])
    // 提出者又说了话（让它重新进入视野），有人把标签改成 wontfix
    t.comment(20, 'reporter', '补充：升级到 2.4 之后还是空白。', NOW + HOUR)
    t.label(['wontfix'], NOW + 2 * HOUR)
    t.advance(DAY + 3 * HOUR)
    expect(await t.host.sweepIssues(DAY)).toBe(0)
    expect(t.prompts()).toBe(1); expect(t.fake.sent).toHaveLength(1)
    expect(t.correction()).toEqual({ repo: 'org/demo', number: 7, spaceId: t.space.id, requestId: first.id, remindedAt: NOW, remindedLabels: [],
      correctedAt: t.now(), correctedLabels: ['wontfix'], state: 'open' })
    // 之后每一轮都不重新评估
    t.advance(DAY)
    expect(await t.host.sweepIssues(DAY)).toBe(0)
    expect(t.prompts()).toBe(1); expect(t.fake.sent).toHaveLength(1)
    // 标签再次变化：重新评估，评估仍是 ask 就再问一次，新提醒记下新的标签集合
    t.label(['bug'], t.now())
    t.advance(HOUR)
    expect(await t.host.sweepIssues(DAY)).toBe(1)
    expect(t.prompts()).toBe(2); expect(t.fake.sent).toHaveLength(2)
    expect(t.latest()?.id).not.toBe(first.id); expect(t.latest()?.labels).toEqual(['bug'])
    // 新提醒之后没有新回复：闭嘴
    t.advance(DAY)
    expect(await t.host.sweepIssues(DAY)).toBe(0); expect(t.prompts()).toBe(2)
  })

  it('a close-and-reopen after the correction counts as a state change and triggers re-evaluation', async () => {
    const t = fixture()
    await t.host.sweepIssues(DAY)
    t.comment(20, 'reporter', '补充：升级到 2.4 之后还是空白。', NOW + HOUR)
    t.label(['wontfix'], NOW + 2 * HOUR)
    t.advance(DAY + 3 * HOUR)
    expect(await t.host.sweepIssues(DAY)).toBe(0)
    const recorded = t.correction()!
    t.timeline.push({ id: 2, event: 'closed', created_at: new Date(recorded.correctedAt + HOUR).toISOString() },
      { id: 3, event: 'reopened', created_at: new Date(recorded.correctedAt + 2 * HOUR).toISOString() })
    t.raw.updated_at = new Date(recorded.correctedAt + 2 * HOUR).toISOString()
    t.advance(3 * HOUR)
    expect(await t.host.sweepIssues(DAY)).toBe(1)
    expect(t.prompts()).toBe(2)
  })

  it('labels unchanged after the notice: a later human reply and a quiet window still lead to the second question as before', async () => {
    const t = fixture()
    await t.host.sweepIssues(DAY)
    t.comment(20, 'reporter', '补充：升级到 2.4 之后还是空白。', NOW + HOUR)
    t.advance(DAY + 2 * HOUR)
    expect(await t.host.sweepIssues(DAY)).toBe(1)
    expect(t.prompts()).toBe(2); expect(t.fake.sent).toHaveLength(2)
    expect(t.correction()).toBeUndefined()
  })

  it('a label change with no new human reply stays out of view, exactly as before', async () => {
    const t = fixture()
    await t.host.sweepIssues(DAY)
    t.label(['wontfix'], NOW + HOUR)
    t.advance(2 * DAY)
    expect(await t.host.sweepIssues(DAY)).toBe(0)
    expect(t.prompts()).toBe(1); expect(t.correction()).toBeUndefined()
  })

  it('labelCorrectionStep: old snapshots without labels, first change, unchanged correction, second change, state change', async () => {
    const t = fixture()
    const thread = (await readIssueThread(t.github, 'org/demo', 7, () => {}))!
    const reminder = { id: 'r1', spaceId: 's', chatId: 'oc', requesterOpenId: 'alice', binding: '{}', repo: 'org/demo', number: 7, title: 't', url: ISSUE_URL,
      digest: 'd', evidence: [], state: 'sent', createdAt: NOW, expiresAt: NOW + DAY, decisionRef: 1 } satisfies IssueValidityRequest
    expect(labelCorrectionStep({ reminder: undefined, record: undefined, thread, now: NOW })).toEqual({ action: 'evaluate' })
    expect(labelCorrectionStep({ reminder, record: undefined, thread, now: NOW })).toEqual({ action: 'evaluate' })
    const reminded = { ...reminder, labels: ['bug'] }
    expect(labelCorrectionStep({ reminder: reminded, record: undefined, thread: { ...thread, snapshot: { ...thread.snapshot, labels: ['bug'] } }, now: NOW })).toEqual({ action: 'evaluate' })
    const step = labelCorrectionStep({ reminder: reminded, record: undefined, thread: { ...thread, snapshot: { ...thread.snapshot, labels: [' wontfix ', 'wontfix'] } }, now: NOW + 1 })
    expect(step).toEqual({ action: 'record', record: { repo: 'org/demo', number: 7, spaceId: 's', requestId: 'r1', remindedAt: NOW, remindedLabels: ['bug'],
      correctedAt: NOW + 1, correctedLabels: ['wontfix'], state: 'open' } })
    const record = (step as { record: IssueLabelCorrection }).record
    expect(labelCorrectionStep({ reminder: reminded, record, thread: { ...thread, snapshot: { ...thread.snapshot, labels: ['wontfix'] } }, now: NOW + 2 })).toEqual({ action: 'skip' })
    expect(labelCorrectionStep({ reminder: reminded, record, thread: { ...thread, snapshot: { ...thread.snapshot, labels: ['wontfix', 'p1'] } }, now: NOW + 2 })).toEqual({ action: 'evaluate' })
    const reopened = { ...thread, snapshot: { ...thread.snapshot, labels: ['wontfix'] }, timeline: [...thread.timeline, { event: 'reopened', created_at: new Date(NOW + 5).toISOString() }] }
    expect(labelCorrectionStep({ reminder: reminded, record, thread: reopened, now: NOW + 6 })).toEqual({ action: 'evaluate' })
    const closedBefore = { ...reopened, timeline: [{ event: 'closed', created_at: new Date(NOW - 5).toISOString() }] }
    expect(labelCorrectionStep({ reminder: reminded, record, thread: closedBefore, now: NOW + 6 })).toEqual({ action: 'skip' })
    // 记录属于另一次提醒：按当前提醒重新比较
    const other = { ...record, requestId: 'r0' }
    expect(labelCorrectionStep({ reminder: reminded, record: other, thread: { ...thread, snapshot: { ...thread.snapshot, labels: ['wontfix'] } }, now: NOW + 2 }).action).toBe('record')
    expect(parseLabelCorrection(undefined)).toBeUndefined(); expect(parseLabelCorrection('not json')).toBeUndefined(); expect(parseLabelCorrection('{"requestId":1}')).toBeUndefined()
  })
})

describe('评估里的路径与待决断文案', () => {
  it('parseIssueValidityAssessment keeps only verbatim relative paths, at most five, and tolerates a missing field', async () => {
    const t = fixture()
    t.comment(20, 'c1', '相关的还有 src/plugin/loader.ts 和 docs/plugin.md，以及 a/b/c/d.ts、e.ts、f/g.ts 这些。', NOW - DAY)
    const thread = (await readIssueThread(t.github, 'org/demo', 7, () => {}))!
    const evidence = [{ ref: 'body', quote: body }]
    const parsed = parseIssueValidityAssessment(JSON.stringify({ verdict: 'ask', evidence,
      paths: [`./${PATH}`, PATH, 'src/plugin/loader.ts', 'src/nowhere.ts', '/etc/passwd', 'docs/plugin.md', 'bad path.ts', 'a/b/c/d.ts', 'e.ts', 'f/g.ts'] }), thread)
    expect(parsed).toEqual({ verdict: 'ask', evidence, paths: [PATH, 'src/plugin/loader.ts', 'docs/plugin.md', 'a/b/c/d.ts', 'e.ts'] })
    expect(parseIssueValidityAssessment(JSON.stringify({ verdict: 'ask', evidence }), thread)).toEqual({ verdict: 'ask', evidence, paths: [] })
    expect(parseIssueValidityAssessment(JSON.stringify({ verdict: 'ask', evidence, paths: 'src/plugin/page.ts' }), thread)).toEqual({ verdict: 'ask', evidence, paths: [] })
    expect(parseIssueValidityAssessment(JSON.stringify({ verdict: 'skip', paths: [PATH] }), thread)).toEqual({ verdict: 'skip' })
  })

  it('the decision text keeps the link whole within 300 characters, shortening or dropping the quote first', () => {
    const base = { id: 'r1', spaceId: 's', chatId: 'oc', requesterOpenId: 'alice', binding: '{}', repo: 'org/demo', number: 7, title: 't', url: ISSUE_URL,
      digest: 'd', evidence: [{ ref: 'comment:19', quote: '证'.repeat(500) }], state: 'sent' as const, createdAt: NOW, expiresAt: NOW + DAY, decisionRef: 1, paths: [PATH] }
    const rule = issueValidityDecisionText(base, { ownerOpenId: 'ou_carol', basis: 'rule', owner: { login: 'carol', name: 'Carol' } })
    expect(rule.title).toBe('已核实仍有效：org/demo#7，请决定下一步')
    expect(rule.why.length).toBeLessThanOrEqual(300); expect(rule.why.endsWith(`${ISSUE_URL}#issuecomment-19`)).toBe(true)
    expect(rule.why).toContain('评论原文：「证'); expect(rule.why).toContain('…」')
    const legacy = issueValidityDecisionText({ ...base, evidence: [{ ref: 'body', quote: '一段原文一段原文一段原文' }] }, { ownerOpenId: 'alice', basis: 'requester' })
    expect(legacy.why).toBe(`负责人已向提出者核实；完整线程证据见原群确认卡。提出者正文原文：「一段原文一段原文一段原文」 ${ISSUE_URL}`)
    const longReason = issueValidityDecisionText(base, { ownerOpenId: 'ou_ziya', basis: 'trusted', reason: '原'.repeat(260) })
    // 说明本身就放不下评论锚点时退回整条 Issue 链接，不截链接
    expect(longReason.why.length).toBeLessThanOrEqual(300); expect(longReason.why.endsWith(ISSUE_URL)).toBe(true); expect(longReason.why).not.toContain('原文：「')
    const hostile = issueValidityDecisionText({ ...base, evidence: [{ ref: 'body', quote: '<at open_id="ou_x">谁</at> 请看这个问题' }] }, { ownerOpenId: 'alice', basis: 'requester' })
    expect(hostile.why).not.toContain('<at')
  })
})
