/**
 * 第三批第 2 条：建单后的分派与待决断。
 * 网关建单成功、还有待定项时，宿主自己记一条待拍板（谁负责、优先级、是否重复），不依赖模型再调 friday_needs_decision。
 * CODEOWNERS 唯一命中时（2026-09-25 起）网关在建单之后直接写 GitHub assignee 并回读核对，待拍板只留优先级、疑似重复；
 * 多候选、无依据或指派没写成时照旧记“谁负责”。除此之外不写 GitHub（不打标签、不合并、不关闭）。
 * 走真实的内部 API 路由、真实 SQLite 上的 Inbox / 成员表 / 结清逻辑 / Issue 账本；GitHub 与飞书是合成的。
 */
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { Inbox, decisionRef } from '../src/core/inbox.js'
import { Identities } from '../src/core/identities.js'
import { DecisionApplication } from '../src/core/decision-application.js'
import { dmSpaceId } from '../src/core/space.js'
import { GitHubApiError, type GitHubIdentity } from '../src/github/identity.js'
import { fingerprintOf, IssueLinks, type IssueOperationOrigin } from '../src/github/issues.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn() })

const REPO = 'org/demo'
const issueUrl = (n: number) => `https://github.com/${REPO}/issues/${n}`
const URL42 = issueUrl(42)
const TITLE = 'Login page is blank'
const BODY = 'Open the login page; it renders blank. Expected the sign-in form.'

type Json = Record<string, any>

function setup(opts: { chatType?: 'group' | 'p2p'; admins?: string[]; captureOrigin?: boolean } = {}) {
  const registry = new Registry(':memory:')
  cleanup.push(() => registry.close())
  const requester = 'ou_alice', chatType = opts.chatType ?? 'group'
  const chatId = chatType === 'group' ? 'oc_team' : 'oc_dm_alice'
  const { spaces, policy, circles } = spaceDeps(registry.db, { admins: opts.admins })
  const space = spaces.ensure({ kind: chatType, chatId, openId: requester })
  const fake = Object.assign(new FakeFeishu(), {
    chatMembers: vi.fn(async (_chatId: string) => [{ name: 'Alice', openId: 'ou_alice' }, { name: 'Carol', openId: 'ou_carol' }]),
  })
  fake.rememberName('ou_admin', '陆知行')
  const feishu = asFeishuClient(fake)
  const log = createLogger('issue-triage', 'error'), messageCache = new MessageCache(registry.db)
  const inbox = new Inbox(registry.db), identities = new Identities(registry.db)
  identities.upsertFromRoster([{ login: 'carol', name: 'Carol', openId: 'ou_carol' }, { login: 'dave', name: 'Dave', openId: 'ou_dave' }])
  registry.createSession({ sessionKey: 'session-a', chatId, chatType, cwd: '/test', requesterOpenId: requester })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', requesterOpenId: requester, messageId: 'om_issue', prompt: '这个问题提个 issue',
    inbound: { eventId: 'event_issue', messageId: 'om_issue', chatId, chatType, senderOpenId: requester, senderType: 'user', msgType: 'text',
      text: '这个问题提个 issue', mentions: [], createTimeMs: Date.now() } }).task
  const gh = {
    calls: [] as { method: string; path: string; body?: unknown }[],
    issue: { assignees: [] as string[], labels: [] as string[] },
    codeowners: undefined as string | undefined,
    candidates: new Map<number, Json>(),
    onRead: undefined as ((path: string) => void) | undefined,
    /** POST /issues/42/assignees：ok 照写；ignore 返回 201 但不生效（GitHub 对无权被指派的人就是这样）；forbidden 返回 403 */
    assign: 'ok' as 'ok' | 'ignore' | 'forbidden',
  }
  const github = {
    mode: 'app', repoAllowed: (repo: string) => repo === REPO, repoWritable: (repo: string) => repo === REPO, defaultRepo: () => REPO,
    async api(method: string, path: string, body?: unknown, _owner?: string, beforeRequest?: () => void) {
      beforeRequest?.()
      gh.calls.push({ method, path, body })
      if (method === 'GET') gh.onRead?.(path)
      if (path.startsWith('/search/issues')) return { items: [], total_count: 0, incomplete_results: false }
      if (method === 'POST' && path === `/repos/${REPO}/issues`) return { number: 42, html_url: URL42 }
      if (method === 'POST' && path === `/repos/${REPO}/issues/42/comments`) return { html_url: `${URL42}#issuecomment-1` }
      if (method === 'POST' && path === `/repos/${REPO}/issues/42/assignees`) {
        if (gh.assign === 'forbidden') throw new GitHubApiError(403, 'Resource not accessible by integration')
        if (gh.assign === 'ok') gh.issue.assignees = [...new Set([...gh.issue.assignees, ...(body as { assignees: string[] }).assignees])]
        return { number: 42, html_url: URL42, assignees: gh.issue.assignees.map(login => ({ login })) }
      }
      if (method === 'GET' && path === `/repos/${REPO}/issues/42`) {
        return { number: 42, title: TITLE, state: 'open', html_url: URL42,
          assignees: gh.issue.assignees.map(login => ({ login })), labels: gh.issue.labels.map(name => ({ name })) }
      }
      const file = /^\/repos\/org\/demo\/contents\/(.+)$/.exec(path)
      if (method === 'GET' && file) {
        if (file[1] === '.github/CODEOWNERS' && gh.codeowners !== undefined) return { content: Buffer.from(gh.codeowners).toString('base64'), encoding: 'base64' }
        throw new GitHubApiError(404, 'Not Found')
      }
      const other = /^\/repos\/org\/demo\/issues\/(\d+)$/.exec(path)
      if (method === 'GET' && other) {
        const hit = gh.candidates.get(Number(other[1]))
        if (hit) return hit
        throw new GitHubApiError(404, 'Not Found')
      }
      throw new Error(`unexpected GitHub request ${method} ${path}`)
    },
  } as unknown as GitHubIdentity
  const reads: string[] = []
  const decisions = new DecisionApplication({ db: registry.db, inbox, spaces, now: () => Date.now() })
  const state = { actor: requester as string | undefined, plainFailure: false }
  const tokens = new TokenIssuer('test-secret')
  // 宿主登记的出处（与 r78 的 captureRepositoryIssueOrigin 同形）；apiCallId 由网关在真实 HTTP 调用里补上
  const savedOrigin = (runId: string): Omit<IssueOperationOrigin, 'apiCallId'> => ({ version: 1,
    origin: { runId, taskId: task.id, workKey: `task:${task.id}`, sessionKey: 'session-a', ownerOpenId: requester, spaceId: space.id, chatId, chatType },
    provenance: { memoryRefs: [], sources: { version: 1, acpSessionId: 'acp-a', spaceId: space.id, chatId, memoryScopes: [], chats: [], external: [], repositories: [REPO] } } })
  const api = createInternalApi({
    registry, spaces, policy, circles, appId: 'app-test', feishu, messageCache, memory: new ChannelMemory(registry.db),
    messages: new MessageService(feishu, messageCache, log), todos: new Todos(registry.db), github, issueLinks: new IssueLinks(registry.db),
    inbox, identities,
    ...(opts.captureOrigin ? { captureRepositoryIssueOrigin: (_sessionKey: string, runId: string) => savedOrigin(runId) } : {}),
    resolveActorForSession: () => {
      // 模拟授权重验时抛出的普通错误（例如本次工具调用已结束），不是 ApiError
      if (state.plainFailure) throw new Error('本次工具调用已结束')
      return state.actor ? { requesterOpenId: state.actor, runId: 'run-1', stage: 'task', taskId: task.id } : undefined
    },
    canPersistDerivedState: () => true, canPublishToRepository: () => true, onRepositoryRead: (_key, repo) => { reads.push(repo) },
    pendingDecisions: (owner, context) => decisions.pendingFor(owner, context),
    resolveDecision: input => decisions.resolve(input),
    tokens, log, maxHistoryPerCall: 100,
  })
  const cap: Capability & { boundRunId: string; boundStage: string } = { boundRunId: 'run-1', boundStage: 'task', runId: 'run-1', sessionKey: 'session-a',
    spaceId: space.id, chatId, chatType, requesterOpenId: requester, scopes: [...ALL_SCOPES], cwd: '/test', exp: 9999999999 }
  const open = (extra: Json = {}) => api.routes['POST /v1/github/issue/open']!(cap, { repo: REPO, title: TITLE, body: BODY, ...extra }) as Promise<Json>
  const route = (path: string, body: Json = {}) => api.routes[`POST /v1/${path}`]!(cap, body) as Promise<Json>
  const rows = () => registry.db.prepare("SELECT * FROM inbox_items WHERE kind = 'decision'").all() as Json[]
  const writes = () => gh.calls.filter(call => call.method !== 'GET').map(call => `${call.method} ${call.path}`)
  const ref = decisionRef(space.id, `issue-triage:${REPO}#42`)
  const assignments = () => registry.db.prepare("SELECT * FROM github_issue_operations WHERE action = 'assigned'").all() as Json[]
  /** 走真实的签名 HTTP 入口（网关在这里登记本次工具调用），与 MCP 工具一致 */
  const openOverHttp = async (extra: Json = {}) => {
    await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done))
    cleanup.push(() => new Promise<void>((done, fail) => api.server.close(err => err ? fail(err) : done())))
    const response = await fetch(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/github/issue/open`, { method: 'POST',
      headers: { authorization: `Bearer ${tokens.issue(cap)}`, 'content-type': 'application/json' }, body: JSON.stringify({ repo: REPO, title: TITLE, body: BODY, ...extra }) })
    return { status: response.status, body: await response.json() as Json }
  }
  return { registry, space, fake, inbox, decisions, gh, reads, state, cap, open, route, rows, writes, ref, assignments, openOverHttp }
}

/** 真实的 MCP 工具（buildServer）渲染网关返回的结果；网关响应用上面路由的真实输出。 */
async function tool(response: unknown, args: Json = { title: TITLE, body: BODY }) {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } }))
  const server = buildServer({ apiUrl: 'http://offline.invalid', token: 'offline' }), client = new Client({ name: 'issue-triage-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a); await client.connect(b)
  try {
    const result = await client.callTool({ name: 'github_open_issue', arguments: args }) as { content: { text: string }[]; isError?: boolean }
    return { text: result.content.map(item => item.text).join('\n'), sent: JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Json, isError: result.isError }
  } finally { await client.close(); await server.close(); fetch.mockRestore() }
}

describe('建单后宿主记待拍板', () => {
  it('records one decision with the Issue link and open questions; repeated calls on the same Issue add nothing', async () => {
    const t = setup()
    const first = await t.open()
    expect(first).toMatchObject({ action: 'created', number: 42, url: URL42,
      triage: { state: 'recorded', questions: ['owner', 'priority'], decider: { role: 'requester' } } })
    expect(t.rows()).toHaveLength(1)
    const row = t.rows()[0]!
    expect(row).toMatchObject({ owner_open_id: 'ou_alice', ref_id: t.ref, space_id: t.space.id, resolved_at: null })
    expect(row.title).toContain('org/demo#42 谁负责、优先级待你定')
    expect(`${row.title} ${row.why}`).toContain(URL42)
    expect(first.triage.decision).toEqual({ id: row.id, version: 1 })

    // 同一意图重放、同标题再来一次（补评论）：都不再记第二条
    const replay = await t.open()
    expect(replay).toMatchObject({ replayed: true, triage: { state: 'already_open', decision: { id: row.id, version: 1 } } })
    const comment = await t.open({ body: 'Another member saw the same blank login page today.' })
    expect(comment).toMatchObject({ action: 'commented', number: 42, triage: { state: 'already_open' } })
    expect(t.rows()).toHaveLength(1)
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`, `POST /repos/${REPO}/issues/42/comments`])

    // 私聊“等我拍板的有哪些”：本人的待拍板里有这一条
    const mine = t.decisions.pendingFor('ou_alice', { spaceId: dmSpaceId('ou_alice'), chatType: 'p2p' })
    expect(mine.map(item => item.title)).toEqual([expect.stringContaining('#42 谁负责、优先级')])
  })

  it('does not record when the Issue already carries the owner and labels a person gave', async () => {
    const t = setup()
    t.gh.issue = { assignees: ['carol'], labels: ['P2'] }
    const r = await t.open({ assignees: ['carol'], labels: ['P2'] })
    expect(r.pending).toEqual([])
    expect(r.triage).toMatchObject({ state: 'not_needed' })
    expect(t.rows()).toEqual([])
  })

  it('asks only for the priority when the owner was given', async () => {
    const t = setup()
    t.gh.issue = { assignees: ['carol'], labels: [] }
    const r = await t.open({ assignees: ['carol'] })
    expect(r.triage).toMatchObject({ state: 'recorded', questions: ['priority'] })
    expect(r.triage.owner).toBeUndefined()
    expect(t.rows()[0]!.title).toContain('#42 优先级待你定')
  })

  it('verifies duplicate candidates by number and lists them without merging or closing anything', async () => {
    const t = setup()
    t.gh.candidates.set(40, { number: 40, title: 'Blank login page on Safari', state: 'open', html_url: issueUrl(40) })
    t.gh.candidates.set(41, { number: 41, title: 'Login renders nothing', state: 'closed', html_url: issueUrl(41) })
    t.gh.candidates.set(43, { number: 43, title: 'Fix login', state: 'open', html_url: `https://github.com/${REPO}/pull/43`, pull_request: { url: 'synthetic' } })
    const r = await t.open({ duplicate_candidates: [40, 41, 43, 99, 42] })
    expect(r.triage.duplicates).toEqual({
      verified: [
        { number: 40, title: 'Blank login page on Safari', state: 'open', url: issueUrl(40) },
        { number: 41, title: 'Login renders nothing', state: 'closed', url: issueUrl(41) },
      ],
      unverified: [{ number: 43, reason: 'pull_request' }, { number: 99, reason: 'not_found' }],
    })
    expect(r.triage.questions).toEqual(['owner', 'priority', 'duplicate'])
    expect(r.pending.at(-1)).toContain('#40、#41')
    const row = t.rows()[0]!
    expect(row.title).toContain('谁负责、优先级、是否重复待你定')
    for (const expected of ['#40「Blank login', `」打开 ${issueUrl(40)}`, '#41「Login renders', `」已关闭 ${issueUrl(41)}`, '未能核验：#43（是 PR）、#99（读不到）']) expect(row.why).toContain(expected)
    expect(row.why).not.toContain('pull/43')
    // 自己（#42）不当候选；每个候选只读一次；除建单外没有任何写
    expect(t.gh.calls.filter(call => /\/issues\/(40|41|43|99)$/.test(call.path)).map(call => `${call.method} ${call.path}`))
      .toEqual([40, 41, 43, 99].map(n => `GET /repos/${REPO}/issues/${n}`))
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`])
    expect(t.reads).toContain(REPO)

    // 回读的编号或链接对不上：不算重复，也不加“是否重复”
    const other = setup()
    other.gh.candidates.set(44, { number: 45, title: 'Wrong number', state: 'open', html_url: issueUrl(45) })
    const mismatch = await other.open({ duplicate_candidates: [44] })
    expect(mismatch.triage).toMatchObject({ questions: ['owner', 'priority'], duplicates: { verified: [], unverified: [{ number: 44, reason: 'mismatch' }] } })
    expect(other.rows()[0]!.title).not.toContain('是否重复')
  })

  it('rejects malformed triage parameters before anything is written', async () => {
    const t = setup()
    await expect(t.open({ duplicate_candidates: ['40'] })).rejects.toMatchObject({ status: 400 })
    await expect(t.open({ paths: 'src/a.ts' })).rejects.toMatchObject({ status: 400 })
    expect(t.writes()).toEqual([])
    expect(t.rows()).toEqual([])
  })
})

describe('负责人候选只按 CODEOWNERS；唯一命中才写 GitHub assignee', () => {
  it('one owner: assigns that person on GitHub after the Issue is created, gives the group @ once, and the decision keeps only the priority', async () => {
    const t = setup()
    t.gh.codeowners = '* @lead\n/src/github/ @carol\n'
    const r = await t.open({ paths: ['src/github/issues.ts', './src/github/codeowners.ts'] })
    expect(r.triage.owner).toEqual({ kind: 'resolved', login: 'carol', name: 'Carol', person: 'resolved', mention: { openId: 'ou_carol', name: 'Carol' } })
    expect(r.triage).toMatchObject({ state: 'recorded', questions: ['priority'], assignment: { state: 'assigned', login: 'carol', assignees: ['carol'] } })
    expect(r).toMatchObject({ action: 'created', number: 42, url: URL42, assignees: ['carol'] })
    expect(r.pending.join('；')).not.toContain('负责人没填')
    expect(t.rows()[0]!.title).toContain('org/demo#42 优先级待你定')
    expect(t.rows()[0]!.why ?? '').not.toMatch(/carol|建议/i)
    const shown = await tool(r, { title: TITLE, body: BODY, paths: ['src/github/issues.ts'] })
    expect(shown.sent).toMatchObject({ paths: ['src/github/issues.ts'] })
    expect(shown.text.match(/<at open_id="ou_carol">Carol<\/at>/g)).toHaveLength(1)
    expect(shown.text).toContain('不要再调 friday_needs_decision')
    expect(shown.text).toContain('已按 CODEOWNERS 在 GitHub 上把这张 Issue 指派给 Carol（GitHub carol）')
    expect(shown.text).toContain('负责人：carol')
    expect(shown.text).not.toContain('负责人仍待')
    // 建单写成并回读之后才指派；指派前读一次、指派后回读一次
    const order = t.gh.calls.map(call => `${call.method} ${call.path}`)
    expect(order.indexOf(`POST /repos/${REPO}/issues/42/assignees`)).toBeGreaterThan(order.indexOf(`POST /repos/${REPO}/issues`))
    expect(order.slice(order.indexOf(`POST /repos/${REPO}/issues/42/assignees`) - 1, order.indexOf(`POST /repos/${REPO}/issues/42/assignees`) + 2))
      .toEqual([`GET /repos/${REPO}/issues/42`, `POST /repos/${REPO}/issues/42/assignees`, `GET /repos/${REPO}/issues/42`])
    expect(t.gh.calls.find(call => call.path.endsWith('/assignees'))!.body).toEqual({ assignees: ['carol'] })
    expect(t.assignments()).toEqual([expect.objectContaining({ status: 'confirmed', repo: REPO, number: 42, url: URL42, fingerprint: 'assignee:carol' })])

    // 第二次调用：待拍板已在，不再给 @，也不重新读 CODEOWNERS，不再写
    const reads = t.gh.calls.length
    const again = await t.open({ paths: ['src/github/issues.ts'] })
    expect(again.triage).toMatchObject({ state: 'already_open' })
    expect(again.triage.owner).toBeUndefined()
    expect((await tool(again)).text).not.toContain('<at')
    expect(t.gh.calls.slice(reads).map(call => call.path)).not.toContain(`/repos/${REPO}/contents/.github/CODEOWNERS`)
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`, `POST /repos/${REPO}/issues/42/assignees`])
  })

  it.each([
    ['several owners', '/src/github/ @carol\n/src/core/ @dave\n', ['src/github/issues.ts', 'src/core/inbox.ts'], { kind: 'ambiguous', logins: ['carol', 'dave'], reason: 'multiple' }, 'CODEOWNERS 有多个负责人'],
    ['no CODEOWNERS', undefined, ['src/github/issues.ts'], { kind: 'unknown', reason: 'no_codeowners' }, '仓库里没有 CODEOWNERS'],
    ['no paths', '/src/github/ @carol\n', [], { kind: 'unknown', reason: 'no_paths' }, '没有给出涉及的文件路径'],
  ])('%s: no suggestion and no @; the owner is left to the decider', async (_name, codeowners, paths, owner, why) => {
    const t = setup()
    t.gh.codeowners = codeowners
    const r = await t.open({ paths })
    expect(r.triage.owner).toEqual(owner)
    expect(t.rows()[0]!.why).toContain(why)
    expect(t.rows()[0]!.why).not.toContain('建议')
    expect((await tool(r)).text).not.toContain('<at')
    expect(t.fake.chatMembers).not.toHaveBeenCalled()
  })

  it('a private-chat Issue assigns the owner but carries no group @ prompt', async () => {
    const t = setup({ chatType: 'p2p' })
    t.gh.codeowners = '/src/github/ @carol\n'
    const r = await t.open({ paths: ['src/github/issues.ts'] })
    expect(r.triage).toMatchObject({ state: 'recorded', questions: ['priority'], owner: { kind: 'resolved', login: 'carol', name: 'Carol', person: 'private' },
      assignment: { state: 'assigned', login: 'carol', assignees: ['carol'] } })
    expect(r.triage.owner.mention).toBeUndefined()
    expect(t.fake.chatMembers).not.toHaveBeenCalled()
    expect(t.rows()[0]!).toMatchObject({ space_id: dmSpaceId('ou_alice') })
    expect(t.rows()[0]!.title).toContain('#42 优先级待你定')
    expect(t.rows()[0]!.why ?? '').not.toMatch(/carol|建议/i)
    const shown = await tool(r)
    expect(shown.text).not.toContain('<at')
    expect(shown.text).not.toContain('群里')
    expect(shown.text).toContain('已按 CODEOWNERS 在 GitHub 上把这张 Issue 指派给 Carol（GitHub carol）')
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`, `POST /repos/${REPO}/issues/42/assignees`])
  })

  it('a unique owner who is not a current member of the group is named, not @-ed', async () => {
    const t = setup()
    t.gh.codeowners = '/src/core/ @dave\n'
    const r = await t.open({ paths: ['src/core/inbox.ts'] })
    expect(r.triage.owner).toEqual({ kind: 'resolved', login: 'dave', name: 'Dave', person: 'name-only' })
    expect(r.triage.assignment).toEqual({ state: 'assigned', login: 'dave', assignees: ['dave'] })
    const shown = await tool(r)
    expect(shown.text).not.toContain('<at')
    expect(shown.text).toContain('未能确认他是当前群成员：写名字，不要 @')
  })
})

describe('记在谁名下、怎么结清', () => {
  it('goes to the first deployment administrator when the requester is not one; an administrator requester decides herself', async () => {
    const t = setup({ admins: ['ou_admin'] })
    const r = await t.open()
    expect(r.triage.decider).toEqual({ role: 'admin', name: '陆知行' })
    expect(t.rows()[0]!.owner_open_id).toBe('ou_admin')
    expect((await tool(r)).text).toContain('陆知行')
    const own = setup({ admins: ['ou_admin', 'ou_alice'] })
    expect((await own.open()).triage.decider).toEqual({ role: 'requester' })
    expect(own.rows()[0]!.owner_open_id).toBe('ou_alice')
  })

  it('“负责人定 Carol，P2” settles it with that note through the existing decision routes; later calls never reopen it', async () => {
    const t = setup()
    await t.open()
    const listed = (await t.route('decision/list')).items as Json[]
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toContain('#42 谁负责、优先级')
    const settled = await t.route('decision/resolve', { id: listed[0]!.id, version: listed[0]!.version, resolution: 'decided', note: '负责人定 Carol，P2' })
    expect(settled).toMatchObject({ outcome: 'resolved', note: '负责人定 Carol，P2' })
    expect(t.inbox.get(listed[0]!.id)).toMatchObject({ resolution: 'decided', resolutionNote: '负责人定 Carol，P2', resolvedBy: 'ou_alice' })
    const again = await t.open()
    expect(again.triage).toMatchObject({ state: 'already_resolved', resolution: { resolution: 'decided', note: '负责人定 Carol，P2' } })
    expect(t.inbox.get(listed[0]!.id)!.resolvedAt).not.toBeNull()
    expect((await tool(again)).text).toContain('负责人定 Carol，P2')
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`])
  })

  it('rechecks the delegation after the triage reads: a lost delegation records nothing, and a later replay records once', async () => {
    const t = setup()
    t.gh.codeowners = '/src/github/ @carol\n'
    t.gh.onRead = path => { if (path.endsWith('/CODEOWNERS')) t.state.actor = undefined }
    await expect(t.open({ paths: ['src/github/issues.ts'] })).rejects.toMatchObject({ status: 403 })
    expect(t.rows()).toEqual([])
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`])
    t.gh.onRead = undefined; t.state.actor = 'ou_alice'
    const replay = await t.open({ paths: ['src/github/issues.ts'] })
    expect(replay).toMatchObject({ replayed: true, triage: { state: 'recorded' } })
    expect(t.rows()).toHaveLength(1)
    // 重放时 CODEOWNERS 唯一命中：指派只在这次（委托有效时）写一次
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`, `POST /repos/${REPO}/issues/42/assignees`])
    expect(t.assignments()).toEqual([expect.objectContaining({ status: 'confirmed' })])
  })

  it('a local write failure keeps the Issue result and says so; an authorization failure of any error type still fails the call', async () => {
    const t = setup()
    vi.spyOn(t.inbox, 'add').mockImplementation(() => { throw new Error('synthetic disk I/O error') })
    const r = await t.open()
    expect(r).toMatchObject({ action: 'created', number: 42, url: URL42, triage: { state: 'failed' } })
    expect(t.rows()).toEqual([])
    expect((await tool(r)).text).toContain('没能记上待拍板')

    const u = setup()
    u.gh.codeowners = '/src/github/ @carol\n'
    u.gh.onRead = path => { if (path.endsWith('/CODEOWNERS')) u.state.plainFailure = true }
    await expect(u.open({ paths: ['src/github/issues.ts'] })).rejects.toThrow('本次工具调用已结束')
    expect(u.rows()).toEqual([])
    expect(u.writes()).toEqual([`POST /repos/${REPO}/issues`])
  })

  it('a deployment without the inbox still opens the Issue and says nothing was recorded', async () => {
    const t = setup()
    const response = { action: 'created', repo: REPO, number: 42, url: URL42, state: 'open', assignees: [], pending: ['负责人没填——我不替人指派'], triage: { state: 'unavailable' } }
    const shown = await tool(response)
    expect(shown.text).toContain(URL42)
    expect(shown.text).toContain('没有记待拍板')
    expect(t.rows()).toEqual([])
  })
})

describe('唯一命中写 GitHub assignee：没写成就回退为待拍板', () => {
  it('GitHub accepts the request but the read-back does not show the person: conflict, 谁负责 stays in the decision, nothing is resent', async () => {
    const t = setup()
    t.gh.codeowners = '/src/github/ @carol\n'; t.gh.assign = 'ignore'
    const r = await t.open({ paths: ['src/github/issues.ts'] })
    expect(r.triage).toMatchObject({ state: 'recorded', questions: ['owner', 'priority'], assignment: { state: 'conflict', login: 'carol', assignees: [] } })
    expect(r.assignees).toEqual([])
    expect(t.assignments()).toEqual([expect.objectContaining({ status: 'conflict', number: 42 })])
    const row = t.rows()[0]!
    expect(row.title).toContain('#42 谁负责、优先级待你定')
    expect(row.why).toContain('CODEOWNERS 唯一负责人是 Carol（GitHub carol），已请求指派，但 GitHub 回读的负责人为空，指派没有生效，待你定')
    expect(r.pending[0]).toContain('指派没有生效')
    const shown = await tool(r)
    // 没写成时照 P3-2：群里 @ 一次请他评估，负责人仍待拍板的人定
    expect(shown.text.match(/<at open_id="ou_carol">Carol<\/at>/g)).toHaveLength(1)
    expect(shown.text).toContain('负责人仍待')
    expect(shown.text).toContain('不要说成已指派')
    expect(shown.text).toContain('GitHub 会忽略指派而不报错')
    expect(shown.text).not.toContain('已按 CODEOWNERS 在 GitHub 上把这张 Issue 指派给')
    await t.open({ paths: ['src/github/issues.ts'] })
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`, `POST /repos/${REPO}/issues/42/assignees`])
  })

  it('403 from GitHub: operation_failed in the ledger, the Issue result stands, and 谁负责 falls back to the decision with the reason', async () => {
    const t = setup()
    t.gh.codeowners = '/src/github/ @carol\n'; t.gh.assign = 'forbidden'
    const r = await t.open({ paths: ['src/github/issues.ts'] })
    expect(r).toMatchObject({ action: 'created', number: 42, url: URL42, assignees: [] })
    expect(r.triage).toMatchObject({ state: 'recorded', questions: ['owner', 'priority'], assignment: { state: 'failed', login: 'carol', httpStatus: 403 } })
    expect(t.assignments()).toEqual([expect.objectContaining({ status: 'operation_failed', error: 'HTTP 403: Resource not accessible by integration' })])
    expect(t.rows()[0]!.title).toContain('#42 谁负责、优先级待你定')
    expect(t.rows()[0]!.why).toContain('指派被 GitHub 拒绝（403，GitHub App 可能没有 Issues 写权限）')
    expect(r.pending[0]).toContain('403')
    const shown = await tool(r)
    expect(shown.text).toContain('Issues 读写权限')
    expect(shown.text).toContain('不要说成已指派')
    expect(shown.text).not.toContain('已按 CODEOWNERS 在 GitHub 上把这张 Issue 指派给')
    // 同一请求重放：待拍板已在，不再请求指派
    expect(await t.open({ paths: ['src/github/issues.ts'] })).toMatchObject({ replayed: true, triage: { state: 'already_open' } })
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`, `POST /repos/${REPO}/issues/42/assignees`])
  })

  it.each([
    ['several owners', '/src/github/ @carol\n/src/core/ @dave\n', ['src/github/issues.ts', 'src/core/inbox.ts']],
    ['a team', '/src/github/ @org/platform\n', ['src/github/issues.ts']],
    ['partial coverage', '/src/github/ @carol\n', ['src/github/issues.ts', 'docs/readme.md']],
    ['no CODEOWNERS', undefined, ['src/github/issues.ts']],
    ['no paths', '/src/github/ @carol\n', []],
  ])('%s: nothing is written to GitHub and 谁负责 stays in the decision', async (_name, codeowners, paths) => {
    const t = setup()
    t.gh.codeowners = codeowners
    const r = await t.open({ paths })
    expect(r.triage).toMatchObject({ state: 'recorded', questions: ['owner', 'priority'] })
    expect(r.triage.assignment).toBeUndefined()
    expect(t.rows()[0]!.title).toContain('#42 谁负责、优先级待你定')
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`])
    expect(t.assignments()).toEqual([])
    expect((await tool(r)).text).toContain('宿主没有在 GitHub 上指派、打标签、合并或关闭任何 Issue')
  })

  it('when the requester named an assignee that did not take effect, the CODEOWNERS owner is only suggested, not assigned', async () => {
    const t = setup()
    t.gh.codeowners = '/src/github/ @carol\n'
    const r = await t.open({ paths: ['src/github/issues.ts'], assignees: ['erin'] })
    expect(r.pending).toContain('指派 erin 没生效（多半是他不在这个仓库的协作者里），需要人工处理')
    expect(r.triage).toMatchObject({ state: 'recorded', questions: ['owner', 'priority'] })
    expect(r.triage.assignment).toBeUndefined()
    expect(t.rows()[0]!.why).toContain('建议 Carol（GitHub carol），待你确认')
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`])
    expect(t.assignments()).toEqual([])
  })

  it('owner assigned and a priority label present: nothing is left to decide, no decision is recorded; a replay neither writes nor @s again', async () => {
    const t = setup()
    t.gh.codeowners = '/src/github/ @carol\n'; t.gh.issue.labels = ['P2']
    const r = await t.open({ paths: ['src/github/issues.ts'], labels: ['P2'] })
    expect(r.triage).toMatchObject({ state: 'not_needed', assignment: { state: 'assigned', login: 'carol', assignees: ['carol'] } })
    expect(r.pending).toEqual([])
    expect(t.rows()).toEqual([])
    const shown = await tool(r)
    expect(shown.text.match(/<at open_id="ou_carol">Carol<\/at>/g)).toHaveLength(1)
    expect(shown.text).toContain('没有另记待拍板')
    expect(shown.text).not.toContain('已有人给的负责人')
    const replay = await t.open({ paths: ['src/github/issues.ts'], labels: ['P2'] })
    expect(replay).toMatchObject({ replayed: true, triage: { state: 'not_needed', assignment: { state: 'assigned', replayed: true } } })
    expect((await tool(replay)).text).not.toContain('<at')
    expect(t.rows()).toEqual([])
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`, `POST /repos/${REPO}/issues/42/assignees`])
  })

  it('a delegation lost at the assignment write gate fails the call and writes nothing more; a later replay assigns once', async () => {
    const t = setup()
    t.gh.codeowners = '/src/github/ @carol\n'
    let issueReads = 0
    // 第 1 次读 #42 是建单回读，第 2 次是指派前的读取；读完之后委托失效
    t.gh.onRead = path => { if (path === `/repos/${REPO}/issues/42` && ++issueReads === 2) t.state.actor = undefined }
    await expect(t.open({ paths: ['src/github/issues.ts'] })).rejects.toMatchObject({ status: 403 })
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`])
    expect(t.assignments()).toEqual([])
    expect(t.rows()).toEqual([])
    t.gh.onRead = undefined; t.state.actor = 'ou_alice'
    expect(await t.open({ paths: ['src/github/issues.ts'] })).toMatchObject({ replayed: true, triage: { state: 'recorded', assignment: { state: 'assigned' } } })
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`, `POST /repos/${REPO}/issues/42/assignees`])
    expect(t.rows()).toHaveLength(1)
  })

  it('a same-title Issue that already exists without an assignee: Friday only comments; the unique owner is suggested in the decision, not assigned on GitHub', async () => {
    const t = setup()
    t.gh.codeowners = '/src/github/ @carol\n'
    // 本空间以前记住的同标题 Issue（例如人手工开的 #42）：这次走补评论。自动指派只对本次新建的 Issue 生效，这里照 P3-2 只记建议。
    new IssueLinks(t.registry.db).remember({ fingerprint: fingerprintOf({ spaceId: t.space.id, repo: REPO, title: TITLE }), repo: REPO, number: 42, url: URL42, spaceId: t.space.id, source: 'oc_team' })
    const r = await t.open({ paths: ['src/github/issues.ts'] })
    expect(r).toMatchObject({ action: 'commented', number: 42, assignees: [] })
    expect(r.triage).toMatchObject({ state: 'recorded', questions: ['owner', 'priority'],
      owner: { kind: 'resolved', login: 'carol', name: 'Carol', person: 'resolved', mention: { openId: 'ou_carol', name: 'Carol' } } })
    expect(r.triage.assignment).toBeUndefined()
    expect(r.pending).toContain('负责人没填——我不替人指派')
    expect(t.rows()[0]!.title).toContain('#42 谁负责、优先级待你定')
    expect(t.rows()[0]!.why).toContain('负责人：建议 Carol（GitHub carol），待你确认')
    const shown = await tool(r)
    expect(shown.text.match(/<at open_id="ou_carol">Carol<\/at>/g)).toHaveLength(1)
    expect(shown.text).toContain('负责人仍待')
    expect(shown.text).toContain('宿主没有在 GitHub 上指派、打标签、合并或关闭任何 Issue')
    expect(shown.text).not.toContain('已按 CODEOWNERS 在 GitHub 上把这张 Issue 指派给')
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues/42/comments`])
    expect(t.gh.calls.map(call => call.path)).not.toContain(`/repos/${REPO}/issues/42/assignees`)
    expect(t.assignments()).toEqual([])
  })

  it('a same-title Issue that already has a priority label but no assignee: Friday only comments and 谁负责 stays the one open question', async () => {
    const t = setup()
    t.gh.codeowners = '/src/github/ @carol\n'; t.gh.issue.labels = ['P2']
    new IssueLinks(t.registry.db).remember({ fingerprint: fingerprintOf({ spaceId: t.space.id, repo: REPO, title: TITLE }), repo: REPO, number: 42, url: URL42, spaceId: t.space.id, source: 'oc_team' })
    const r = await t.open({ paths: ['src/github/issues.ts'] })
    // 按新建时的规则这里会指派 carol 并且不记待拍板；补评论时不指派，“谁负责”仍交给拍板的人
    expect(r).toMatchObject({ action: 'commented', number: 42, assignees: [], labels: ['P2'] })
    expect(r.triage).toMatchObject({ state: 'recorded', questions: ['owner'], owner: { kind: 'resolved', login: 'carol', name: 'Carol', person: 'resolved' } })
    expect(r.triage.assignment).toBeUndefined()
    expect(t.rows()).toHaveLength(1)
    expect(t.rows()[0]!.title).toContain('org/demo#42 谁负责待你定')
    expect(t.rows()[0]!.why).toContain('负责人：建议 Carol（GitHub carol），待你确认')
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues/42/comments`])
    expect(t.assignments()).toEqual([])
  })

  it('after a human removed the assignee Friday wrote, a later call on the Issue only comments, records 谁负责 with the CODEOWNERS suggestion and does not assign again', async () => {
    const t = setup()
    t.gh.codeowners = '/src/github/ @carol\n'; t.gh.issue.labels = ['P2']
    expect((await t.open({ paths: ['src/github/issues.ts'], labels: ['P2'] })).triage).toMatchObject({ state: 'not_needed', assignment: { state: 'assigned' } })
    t.gh.issue.assignees = []
    const again = await t.open({ paths: ['src/github/issues.ts'], labels: ['P2'], body: 'Another member saw the same blank login page today.' })
    // 补评论不走指派：连“之前已发起过指派”的核对都不需要
    expect(again).toMatchObject({ action: 'commented', triage: { state: 'recorded', questions: ['owner'], owner: { kind: 'resolved', login: 'carol' } } })
    expect(again.triage.assignment).toBeUndefined()
    expect(t.rows()[0]!.why).toContain('负责人：建议 Carol（GitHub carol），待你确认')
    expect(t.writes()).toEqual([`POST /repos/${REPO}/issues`, `POST /repos/${REPO}/issues/42/assignees`, `POST /repos/${REPO}/issues/42/comments`])
    expect(t.assignments()).toHaveLength(1)
  })

  it('the assigned ledger row carries the same host origin as the Issue creation, bound to the real tool call', async () => {
    const t = setup({ captureOrigin: true })
    t.gh.codeowners = '/src/github/ @carol\n'
    const { status, body } = await t.openOverHttp({ paths: ['src/github/issues.ts'] })
    expect(status).toBe(200)
    expect(body.triage).toMatchObject({ assignment: { state: 'assigned', login: 'carol' } })
    const rows = t.registry.db.prepare('SELECT action, status, origin_json FROM github_issue_operations ORDER BY created_at, rowid').all() as Json[]
    expect(rows.map(row => [row.action, row.status])).toEqual([['created', 'confirmed'], ['assigned', 'confirmed']])
    const [created, assigned] = rows.map(row => JSON.parse(String(row.origin_json)))
    expect(assigned).toEqual(created)
    expect(assigned.origin).toMatchObject({ runId: 'run-1', sessionKey: 'session-a', ownerOpenId: 'ou_alice', spaceId: t.space.id })
    expect(t.registry.db.prepare('SELECT run_id, route FROM run_api_calls WHERE id = ?').get(assigned.apiCallId)).toEqual({ run_id: 'run-1', route: 'POST /v1/github/issue/open' })
  })
})
