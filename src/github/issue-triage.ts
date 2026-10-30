/**
 * 建单后的分派与待决断：Issue 建好（或在同名 Issue 下补了评论）后，宿主自己把“谁负责、优先级、是否重复”
 * 记成一条待拍板，不再依赖模型另调 friday_needs_decision。
 *
 * 负责人规则唯一命中（resolved）、发起人没指定负责人、且这次新建了 Issue 时，建单之后直接在 GitHub 上指派这个人（2026-09-25 定；
 * 写门、账本 action='assigned'、写后回读见 issues.ts 的 assignIssue），待拍板只留优先级、疑似重复，都没有就不记。
 * 同标题已有 Issue 只补评论时不指派（调用方不给 assign），“谁负责”照旧只记建议。
 * 多候选、无依据或指派没写成（GitHub 拒绝、回读没有他、结果未知）时照旧把“谁负责”记进待拍板并写明原因。
 * 除指派外不写 GitHub：不打标签、不合并、不关闭。结论由拍板的人用 friday_decision_resolve 记在待拍板上。
 *
 * 负责人候选只看仓库的 CODEOWNERS。模型给出 Issue 涉及的仓库内路径，每条路径按“最后一条匹配的规则”取负责人：
 *   resolved  每条路径都有负责人，合起来只有一个人（不是团队）
 *   ambiguous 合起来多于一人、是团队、或只有部分路径有负责人
 *   unknown   没给路径、没读到 CODEOWNERS、或这些路径都没有负责人
 * 成员表只用来把 GitHub 账号换成飞书里的人，规则与 friday_whois 相同：只有群里、当前成员核验为 resolved 才给出 @ 的写法。
 *
 * 疑似重复：模型给出同一仓库的 Issue 编号，宿主逐个按编号回读，核对编号、不是 PR、链接落在本仓库的 issues 下，
 * 只把核验过的标题、状态和链接写进待拍板。
 */
import type { DatabaseSync } from 'node:sqlite'
import { decisionRef, type Inbox, type PendingItem } from '../core/inbox.js'
import type { Identities } from '../core/identities.js'
import { CODEOWNERS_PATHS, matchesPattern, parseCodeowners } from './codeowners.js'
import type { GitHubIdentity } from './identity.js'
import type { IssueAssignmentOutcome } from './issues.js'

export type TriageQuestion = 'owner' | 'priority' | 'duplicate'

export type OwnerCandidate =
  | { kind: 'resolved'; login: string }
  | { kind: 'ambiguous'; logins: string[]; reason: 'multiple' | 'team' | 'partial' }
  | { kind: 'unknown'; reason: 'no_paths' | 'no_codeowners' | 'unreadable' | 'no_owner' }

/**
 * 负责人候选加上成员表的结果。`person`：resolved = 当前群成员核验通过；name-only / ambiguous / unknown 同 friday_whois；
 * private = 私聊建单，不核验群成员、不 @。`mention` 只在本次新记下、群里且 resolved 时给出。
 */
export type OwnerSuggestion =
  | { kind: 'resolved'; login: string; name?: string; person: 'resolved' | 'name-only' | 'ambiguous' | 'unknown' | 'private'; mention?: { openId: string; name: string } }
  | Exclude<OwnerCandidate, { kind: 'resolved' }>

export interface VerifiedCandidate { number: number; title: string; state: 'open' | 'closed'; url: string }
export interface UnverifiedCandidate { number: number; reason: 'not_found' | 'pull_request' | 'mismatch' | 'unreadable' }
export interface DuplicateCheck { verified: VerifiedCandidate[]; unverified: UnverifiedCandidate[] }

/** 网关返回给工具的建单后处理结果。 */
export interface IssueTriageView {
  state: 'recorded' | 'already_open' | 'already_resolved' | 'not_needed' | 'unavailable' | 'failed'
  decision?: { id: number; version: number }
  /** requester = 发起人本人拍板；admin = 部署管理员拍板（name 为网关查到的姓名） */
  decider?: { role: 'requester' | 'admin'; name?: string }
  questions?: TriageQuestion[]
  owner?: OwnerSuggestion
  /** 负责人唯一命中时网关写 GitHub assignee 的结局；没有尝试时没有这一项 */
  assignment?: IssueAssignmentOutcome
  duplicates?: DuplicateCheck
  resolution?: { resolution: PendingItem['resolution']; note: string | null }
}

export const MAX_TRIAGE_PATHS = 20
export const MAX_DUPLICATE_CANDIDATES = 5

/** 同一空间里同一张 Issue 只有一条待拍板。仓库名按小写算。 */
export function issueTriageRef(spaceId: string, repo: string, number: number): number {
  return decisionRef(spaceId, `issue-triage:${repo.toLowerCase()}#${number}`)
}

/** 工具参数：仓库内路径与 Issue 编号。格式不对返回 error，由调用方回 400。 */
export function parseIssueTriageParams(body: Record<string, unknown>): { paths: string[]; duplicateCandidates: number[] } | { error: string } {
  const paths: string[] = []
  if (body.paths !== undefined) {
    if (!Array.isArray(body.paths) || body.paths.length > MAX_TRIAGE_PATHS) return { error: `paths 是最多 ${MAX_TRIAGE_PATHS} 个仓库内路径的列表` }
    for (const raw of body.paths) {
      const path = typeof raw === 'string' ? raw.trim().replace(/^\.?\/+/, '') : ''
      if (!path || path.length > 300 || /[\u0000-\u001f\u007f]/.test(path)) return { error: 'paths 里每一项都要是仓库内的相对路径，例如 src/github/issues.ts' }
      if (!paths.includes(path)) paths.push(path)
    }
  }
  const duplicateCandidates: number[] = []
  if (body.duplicate_candidates !== undefined) {
    if (!Array.isArray(body.duplicate_candidates) || body.duplicate_candidates.length > MAX_DUPLICATE_CANDIDATES) {
      return { error: `duplicate_candidates 是最多 ${MAX_DUPLICATE_CANDIDATES} 个 Issue 编号的列表` }
    }
    for (const raw of body.duplicate_candidates) {
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) return { error: 'duplicate_candidates 只能是同一仓库的 Issue 编号' }
      if (!duplicateCandidates.includes(raw)) duplicateCandidates.push(raw)
    }
  }
  return { paths, duplicateCandidates }
}

/** 每条路径按“最后一条匹配的规则”取负责人，再判断是否唯一。GitHub 登录名不分大小写。 */
export function ownerFromCodeowners(text: string | undefined, paths: readonly string[]): OwnerCandidate {
  if (!paths.length) return { kind: 'unknown', reason: 'no_paths' }
  if (text === undefined) return { kind: 'unknown', reason: 'no_codeowners' }
  const rules = parseCodeowners(text)
  const owners = new Map<string, string>()
  let uncovered = false
  for (const raw of paths) {
    const path = raw.replace(/^\/+/, '')
    let matched: string[] = []
    for (const rule of rules) if (matchesPattern(rule.pattern, path)) matched = rule.owners
    if (!matched.length) uncovered = true
    for (const owner of matched) if (!owners.has(owner.toLowerCase())) owners.set(owner.toLowerCase(), owner)
  }
  const logins = [...owners.values()]
  if (!logins.length) return { kind: 'unknown', reason: 'no_owner' }
  if (logins.length > 1) return { kind: 'ambiguous', logins, reason: 'multiple' }
  if (logins[0]!.includes('/')) return { kind: 'ambiguous', logins, reason: 'team' }
  if (uncovered) return { kind: 'ambiguous', logins, reason: 'partial' }
  return { kind: 'resolved', login: logins[0]! }
}

/** 只认 P0–P4、priority…、优先级… 这几种标签名；别的标签不当作已定优先级。 */
export function hasPriorityLabel(labels: readonly string[]): boolean {
  return labels.some(label => /^(?:p[0-4]|priority(?:[\s:/_-].*)?|优先级.*)$/i.test(label.trim()))
}

const QUESTION_TEXT: Record<TriageQuestion, string> = { owner: '谁负责', priority: '优先级', duplicate: '是否重复' }
const AMBIGUOUS_TEXT = { multiple: 'CODEOWNERS 有多个负责人', team: 'CODEOWNERS 指向团队，没有具体的人', partial: 'CODEOWNERS 只覆盖部分路径' } as const
const UNKNOWN_TEXT = { no_paths: '没有给出涉及的文件路径，未按 CODEOWNERS 判断', no_codeowners: '仓库里没有 CODEOWNERS', unreadable: 'CODEOWNERS 读取失败', no_owner: 'CODEOWNERS 里这些路径没有负责人' } as const
const UNVERIFIED_TEXT = { not_found: '读不到', pull_request: '是 PR', mismatch: '回读结果对不上', unreadable: '读取失败' } as const

/** GitHub 标题和成员表姓名是外部文字：去掉尖括号，免得在回复里拼出 <at> 标记。 */
function plain(text: string): string {
  return text.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
  const one = plain(text)
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** 指派之后负责人算有着落：GitHub 回读确认是他，或 Issue 本来就有负责人。 */
export function ownerSettled(assignment: IssueAssignmentOutcome): boolean {
  return assignment.state === 'assigned' || (assignment.state === 'skipped' && assignment.reason === 'already_assigned')
}

/** 唯一负责人没能指派上的原因，写进待拍板、pending 与回执。 */
function assignmentReason(a: IssueAssignmentOutcome): string {
  if (a.state === 'failed') return a.httpStatus === 403 ? '指派被 GitHub 拒绝（403，GitHub App 可能没有 Issues 写权限）' : a.httpStatus ? `指派被 GitHub 拒绝（${a.httpStatus}）` : '指派请求没有发出'
  if (a.state === 'conflict') {
    const shown = a.assignees.slice(0, 3).map(login => clip(login, 39)).join('、') + (a.assignees.length > 3 ? ` 等 ${a.assignees.length} 人` : '')
    return `已请求指派，但 GitHub 回读的负责人${a.assignees.length ? `是 ${shown}` : '为空'}，指派没有生效`
  }
  if (a.state === 'unknown') return '指派结果未核实（没有自动重发，以 Issue 上的负责人为准）'
  if (a.state === 'skipped') return a.reason === 'assigned_before' ? '这张 Issue 之前已发起过指派，没有再写' : a.reason === 'not_a_login' ? 'CODEOWNERS 写的是邮箱，不能直接指派' : '读不到 Issue 当前负责人，没有写入指派'
  return '已指派'
}

/** 没有唯一负责人时的原因短语（待拍板说明与陈旧核实的待决断说明共用）。 */
export function ownerCandidateReason(candidate: Exclude<OwnerCandidate, { kind: 'resolved' }>): string {
  return candidate.kind === 'ambiguous' ? `${AMBIGUOUS_TEXT[candidate.reason]}（${candidate.logins.join('、')}）` : UNKNOWN_TEXT[candidate.reason]
}

function ownerLine(owner: OwnerSuggestion, assignment?: IssueAssignmentOutcome): string {
  if (owner.kind === 'resolved') {
    const named = owner.name && owner.person !== 'ambiguous' && owner.person !== 'unknown'
    if (assignment && !ownerSettled(assignment)) return `负责人：CODEOWNERS 唯一负责人是 ${named ? `${plain(owner.name!)}（GitHub ${owner.login}）` : `GitHub ${owner.login}`}，${assignmentReason(assignment)}，待你定`
    if (owner.name && owner.person !== 'ambiguous' && owner.person !== 'unknown') return `负责人：建议 ${plain(owner.name)}（GitHub ${owner.login}），待你确认`
    return `负责人：建议 GitHub ${owner.login}（${owner.person === 'ambiguous' ? '成员表里身份有冲突' : '成员表里没有这个账号'}），待你确认`
  }
  if (owner.kind === 'ambiguous') return `负责人：${AMBIGUOUS_TEXT[owner.reason]}（${owner.logins.join('、')}），没有唯一人选`
  return `负责人：${UNKNOWN_TEXT[owner.reason]}`
}

/**
 * 待拍板的标题与说明。标题 ≤ 200、说明 ≤ 300（Inbox 的上限），链接只整条放或不放，不截断。
 * 放不下的疑似重复先去掉标题，再只留编号。
 */
export function triageDecisionText(input: { repo: string; issue: { number: number; url: string; title: string }; questions: readonly TriageQuestion[]; owner?: OwnerSuggestion; assignment?: IssueAssignmentOutcome; duplicates: DuplicateCheck }): { title: string; why: string } {
  const head = `${input.repo}#${input.issue.number} ${input.questions.map(q => QUESTION_TEXT[q]).join('、')}待你定：「${clip(input.issue.title, 30)}」`
  const withLink = `${head} ${input.issue.url}`
  const title = withLink.length <= 200 ? withLink : head
  const parts: string[] = []
  if (title === head) parts.push(input.issue.url)
  if (input.owner) parts.push(ownerLine(input.owner, input.assignment))
  const used = () => parts.join('；').length + (parts.length ? 1 : 0)
  const { verified, unverified } = input.duplicates
  if (verified.length) {
    const prefix = '疑似重复（未合并、未关闭）：'
    const room = 300 - used()
    const state = (d: VerifiedCandidate) => d.state === 'closed' ? '已关闭' : '打开'
    const full = verified.map(d => `#${d.number}「${clip(d.title, 16)}」${state(d)} ${d.url}`)
    const bare = verified.map(d => `#${d.number} ${state(d)} ${d.url}`)
    let line = prefix + full.join('；')
    if (line.length > room) line = prefix + bare.join('；')
    // 还放不下：前 k 条带链接，其余只写编号（k 从多到少试）
    for (let k = bare.length - 1; line.length > room && k >= 0; k--) {
      line = `${prefix}${[...bare.slice(0, k), `另有 ${verified.slice(k).map(d => `#${d.number}`).join('、')}`].join('；')}`
    }
    if (line.length <= room) parts.push(line)
  }
  if (unverified.length) {
    const line = `未能核验：${unverified.map(u => `#${u.number}（${UNVERIFIED_TEXT[u.reason]}）`).join('、')}`
    if (used() + line.length <= 300) parts.push(line)
  }
  return { title, why: parts.join('；') }
}

/** 按编号回读候选 Issue；不接受模型给的链接，也不写任何东西。 */
async function verifyDuplicateCandidates(github: Pick<GitHubIdentity, 'api'>, repo: string, numbers: readonly number[], self: number, assertCurrent: () => void): Promise<DuplicateCheck> {
  const owner = repo.split('/')[0]
  const result: DuplicateCheck = { verified: [], unverified: [] }
  for (const number of numbers.filter(n => n !== self).slice(0, MAX_DUPLICATE_CANDIDATES)) {
    let raw: Record<string, unknown> | undefined, failure: unknown
    try { raw = await github.api<Record<string, unknown>>('GET', `/repos/${repo}/issues/${number}`, undefined, owner) } catch (error) { failure = error }
    assertCurrent()
    if (!raw) {
      const status = (failure as { status?: unknown } | undefined)?.status
      result.unverified.push({ number, reason: status === 404 || status === 410 ? 'not_found' : 'unreadable' })
      continue
    }
    if (raw.pull_request) { result.unverified.push({ number, reason: 'pull_request' }); continue }
    const url = typeof raw.html_url === 'string' ? raw.html_url : ''
    let path = ''
    try { const parsed = new URL(url); if (parsed.protocol === 'https:') path = parsed.pathname } catch { /* 没有可用链接 */ }
    if (raw.number !== number || typeof raw.title !== 'string' || path.toLowerCase() !== `/${repo}/issues/${number}`.toLowerCase()) {
      result.unverified.push({ number, reason: 'mismatch' })
      continue
    }
    result.verified.push({ number, title: raw.title, state: raw.state === 'closed' ? 'closed' : 'open', url })
  }
  return result
}

/** GitHub 按 CODEOWNERS_PATHS 的顺序用第一个存在的文件；某个位置读取失败（不是 404）时不再往后找，结果算读取失败。 */
async function readCodeowners(github: Pick<GitHubIdentity, 'api'>, repo: string, assertCurrent: () => void): Promise<{ text?: string; failed: boolean }> {
  const owner = repo.split('/')[0]
  for (const path of CODEOWNERS_PATHS) {
    let res: { content?: string; encoding?: string } | undefined, failure: unknown
    try { res = await github.api<{ content?: string; encoding?: string }>('GET', `/repos/${repo}/contents/${path}`, undefined, owner) } catch (error) { failure = error }
    assertCurrent()
    if (failure) {
      if ((failure as { status?: unknown }).status === 404) continue
      return { failed: true }
    }
    if (typeof res?.content !== 'string' || (res.encoding && res.encoding !== 'base64')) return { failed: true }
    return { text: Buffer.from(res.content, 'base64').toString('utf8'), failed: false }
  }
  return { failed: false }
}

export interface IssueTriageRequest {
  repo: string
  /** 建单结果（回读的负责人、标签和 pending） */
  issue: { number: number; url: string; title: string; assignees: readonly string[]; labels: readonly string[]; pending: readonly string[] }
  spaceId: string
  chatType: 'p2p' | 'group'
  decider: { openId: string; role: 'requester' | 'admin' }
  paths: readonly string[]
  duplicateCandidates: readonly number[]
}

export interface IssueTriageDeps {
  db: DatabaseSync
  inbox: Inbox
  github: Pick<GitHubIdentity, 'api'>
  identities?: Pick<Identities, 'byLogin' | 'resolveForChat'>
  refreshIdentities?: () => Promise<unknown>
  /** 当前群成员（名字 + open_id）；只在唯一负责人、群里时读 */
  groupMembers: () => Promise<{ name: string; openId: string }[]>
  /** 拍板人是部署管理员时查姓名，给工具回执用 */
  deciderName?: () => Promise<string | undefined>
  /** 每次 await 之后重验本轮委托；失败直接抛出，不记任何东西 */
  assertCurrent: () => void
  now: () => number
  /** 负责人唯一命中时在 GitHub 上指派（网关的写门与账本在里面）；不给就只记建议（发起人自己指定了负责人时不给） */
  assign?: (login: string) => Promise<IssueAssignmentOutcome>
}

export interface IssueTriageOutcome {
  view: IssueTriageView
  /** 建单结果的 pending，加上核验过的疑似重复 */
  pending: string[]
  /** 这次是否读了仓库内容（CODEOWNERS 或候选 Issue） */
  readRepository: boolean
  /** 指派前后 GitHub 读回的负责人（有回读时才有），替换建单结果里的 assignees */
  assignees?: string[]
}

function existingView(item: PendingItem): IssueTriageView {
  return item.resolvedAt === null
    ? { state: 'already_open', decision: { id: item.id, version: item.version } }
    : { state: 'already_resolved', decision: { id: item.id, version: item.version }, resolution: { resolution: item.resolution, note: item.resolutionNote } }
}

/** 负责人规则本身（CODEOWNERS 唯一命中 + 成员表 + 当前群成员核验）。陈旧核实的“仍有效”交接也用它，不另抄一份规则。 */
export async function suggestOwner(deps: Pick<IssueTriageDeps, 'github' | 'identities' | 'refreshIdentities' | 'groupMembers' | 'assertCurrent'>,
  req: Pick<IssueTriageRequest, 'repo' | 'paths' | 'chatType'>): Promise<{ owner: OwnerSuggestion; read: boolean }> {
  if (!req.paths.length) return { owner: { kind: 'unknown', reason: 'no_paths' }, read: false }
  const file = await readCodeowners(deps.github, req.repo, deps.assertCurrent)
  const candidate = file.failed ? { kind: 'unknown' as const, reason: 'unreadable' as const } : ownerFromCodeowners(file.text, req.paths)
  if (candidate.kind !== 'resolved') return { owner: candidate, read: true }
  const login = candidate.login
  let identity = deps.identities?.byLogin(login)
  if (!identity && deps.identities && deps.refreshIdentities && !login.includes('@')) {
    // 与 friday_whois 相同：表里其实已有、只是还没同步的新人，拉一次对照表再判（宿主节流）
    await deps.refreshIdentities().catch(() => undefined)
    deps.assertCurrent()
    identity = deps.identities.byLogin(login)
  }
  if (!identity || !deps.identities) return { owner: { kind: 'resolved', login, person: 'unknown' }, read: true }
  if (req.chatType !== 'group') return { owner: { kind: 'resolved', login, name: identity.displayName, person: 'private' }, read: true }
  const members = await deps.groupMembers()
  deps.assertCurrent()
  const person = deps.identities.resolveForChat(login, members)
  const name = person.kind === 'unknown' ? undefined : person.name
  return {
    owner: { kind: 'resolved', login, ...(name ? { name } : {}), person: person.kind,
      ...(person.kind === 'resolved' ? { mention: { openId: person.openId, name: person.name } } : {}) },
    read: true,
  }
}

/** issues.ts 的 issueResult 没填负责人时写“负责人没填——我不替人指派”；尝试过指派之后换成实际结果。 */
function assignmentPending(pending: readonly string[], login: string, assignment: IssueAssignmentOutcome): string[] {
  const rest = pending.filter(line => !line.startsWith('负责人没填'))
  return ownerSettled(assignment) ? rest : [`负责人没填——CODEOWNERS 唯一负责人是 GitHub ${login}，${assignmentReason(assignment)}，交给拍板的人定`, ...rest]
}

/**
 * 建单后记待拍板。同一空间同一张 Issue 已有一条（在等或已结清）就不再记、不重开，也不再读仓库。
 * 负责人唯一命中时先在 GitHub 上指派（deps.assign），再按结果决定待拍板里还剩什么。
 * 所有读取与指派在前；最后一次重验委托之后，在同一个事务里核对并写 inbox_items。
 */
export async function recordIssueTriage(deps: IssueTriageDeps, req: IssueTriageRequest): Promise<IssueTriageOutcome> {
  const ref = issueTriageRef(req.spaceId, req.repo, req.issue.number)
  const prior = deps.inbox.find('decision', ref)
  if (prior) return { view: existingView(prior), pending: [...req.issue.pending], readRepository: false }
  let readRepository = false
  const duplicates: DuplicateCheck = req.duplicateCandidates.length
    ? await verifyDuplicateCandidates(deps.github, req.repo, req.duplicateCandidates, req.issue.number, deps.assertCurrent)
    : { verified: [], unverified: [] }
  if (req.duplicateCandidates.some(n => n !== req.issue.number)) readRepository = true
  let pending = [...req.issue.pending]
  if (duplicates.verified.length) pending.push(`疑似与 ${duplicates.verified.map(d => `#${d.number}`).join('、')} 重复——已按编号读回核验，没有合并或关闭，待确认`)
  const questions: TriageQuestion[] = [
    ...(req.issue.assignees.length ? [] : ['owner' as const]),
    ...(hasPriorityLabel(req.issue.labels) ? [] : ['priority' as const]),
    ...(duplicates.verified.length ? ['duplicate' as const] : []),
  ]
  if (!pending.length || !questions.length) {
    return { view: { state: 'not_needed', ...(req.duplicateCandidates.length ? { duplicates } : {}) }, pending, readRepository }
  }
  let owner: OwnerSuggestion | undefined
  let assignment: IssueAssignmentOutcome | undefined
  if (questions.includes('owner')) {
    const suggested = await suggestOwner(deps, req)
    owner = suggested.owner
    readRepository ||= suggested.read
    if (owner.kind === 'resolved' && deps.assign) {
      // 唯一命中：建单之后直接在 GitHub 上指派；没写成就照旧把“谁负责”记进待拍板
      assignment = await deps.assign(owner.login)
      deps.assertCurrent()
      pending = assignmentPending(pending, owner.login, assignment)
      if (ownerSettled(assignment)) {
        questions.splice(questions.indexOf('owner'), 1)
        // 群里的 @ 只跟着这次新写成的指派给一次；重放、本来就有负责人时不再 @
        if (!(assignment.state === 'assigned' && !assignment.replayed)) owner = { kind: 'resolved', login: owner.login, ...(owner.name ? { name: owner.name } : {}), person: owner.person }
      }
    }
  }
  const assignees = assignment && 'assignees' in assignment ? assignment.assignees : undefined
  const readBack = assignees ? { assignees } : {}
  if (!questions.length) {
    return { view: { state: 'not_needed', ...(owner ? { owner } : {}), ...(assignment ? { assignment } : {}), ...(req.duplicateCandidates.length ? { duplicates } : {}) },
      pending, readRepository, ...readBack }
  }
  const deciderName = req.decider.role === 'admin' && deps.deciderName ? await deps.deciderName().catch(() => undefined) : undefined
  deps.assertCurrent()
  const text = triageDecisionText({ repo: req.repo, issue: req.issue, questions, owner: questions.includes('owner') ? owner : undefined, assignment, duplicates })
  deps.db.exec('SAVEPOINT record_issue_triage')
  try {
    // 读取期间可能有同一张 Issue 的另一次调用先记下了：以先记的为准，这次不再给 @。
    const raced = deps.inbox.find('decision', ref)
    const item = raced ?? deps.inbox.add({ ownerOpenId: req.decider.openId, kind: 'decision', refId: ref, spaceId: req.spaceId,
      title: text.title, why: text.why, now: deps.now() })
    deps.db.exec('RELEASE SAVEPOINT record_issue_triage')
    if (raced) return { view: { ...existingView(raced), ...(assignment ? { assignment } : {}) }, pending, readRepository, ...readBack }
    return {
      view: { state: 'recorded', decision: { id: item.id, version: item.version },
        decider: { role: req.decider.role, ...(deciderName ? { name: deciderName } : {}) },
        questions, ...(owner ? { owner } : {}), ...(assignment ? { assignment } : {}), ...(req.duplicateCandidates.length ? { duplicates } : {}) },
      pending, readRepository, ...readBack,
    }
  } catch (error) {
    deps.db.exec('ROLLBACK TO SAVEPOINT record_issue_triage; RELEASE SAVEPOINT record_issue_triage')
    throw error
  }
}

/** 负责人唯一命中时的回执：写成了说已指派（@ 只跟着新写成的这一次）；没写成照 P3-2 的建议写法，再说明没写成的原因。 */
function resolvedOwnerLines(owner: Extract<OwnerSuggestion, { kind: 'resolved' }>, assignment: IssueAssignmentOutcome | undefined, who: string): string[] {
  const person = owner.name ? `${plain(owner.name)}（GitHub ${owner.login}）` : `GitHub ${owner.login}`
  if (assignment?.state === 'assigned') {
    if (assignment.replayed) return [`这张 Issue 之前已按 CODEOWNERS 指派给 ${person}：不要再 @ 他。`]
    if (owner.mention) return [`已按 CODEOWNERS 在 GitHub 上把这张 Issue 指派给 ${person}。在群里回话时原样带上一次：<at open_id="${owner.mention.openId}">${plain(owner.mention.name)}</at>，告诉他 Issue 已指派给他；不要说成他已认领。`]
    if (owner.person === 'private') return [`已按 CODEOWNERS 在 GitHub 上把这张 Issue 指派给 ${person}。`]
    if (owner.person === 'name-only') return [`已按 CODEOWNERS 在 GitHub 上把这张 Issue 指派给 ${person}，但未能确认他是当前群成员：写名字，不要 @。`]
    return [`已按 CODEOWNERS 在 GitHub 上把这张 Issue 指派给 GitHub ${owner.login}，成员表里${owner.person === 'ambiguous' ? '身份有冲突' : '没有这个账号'}：不要猜是谁，不要 @。`]
  }
  if (assignment?.state === 'skipped' && assignment.reason === 'already_assigned') {
    return [`GitHub 上这张 Issue 已有负责人（${(assignment.assignees ?? []).map(plain).join('、')}），宿主没有再指派：不要 @。`]
  }
  const lines: string[] = []
  if (owner.mention) lines.push(`按 CODEOWNERS，涉及的路径归 ${person}。在群里回话时原样带上一次：<at open_id="${owner.mention.openId}">${plain(owner.mention.name)}</at>，请他评估；负责人仍待${who}确认，不要说成已认领或已指派。`)
  else if (owner.person === 'private') lines.push(assignment ? `按 CODEOWNERS，涉及的路径归 ${person}。` : `按 CODEOWNERS，涉及的路径归 ${person}；已在待拍板里写“建议 ${plain(owner.name ?? owner.login)}，待你确认”。`)
  else if (owner.person === 'name-only') lines.push(`按 CODEOWNERS，涉及的路径归 ${person}，但未能确认他是当前群成员：写名字，不要 @。`)
  else if (owner.person === 'ambiguous') lines.push(`按 CODEOWNERS，涉及的路径归 GitHub ${owner.login}，成员表里身份有冲突：不要 @。`)
  else lines.push(`按 CODEOWNERS，涉及的路径归 GitHub ${owner.login}，成员表里没有这个账号：不要猜是谁，不要 @。`)
  if (assignment) {
    const permission = assignment.state === 'failed' && assignment.httpStatus === 403 ? '（网关要能指派，GitHub App 需要 Issues 读写权限：管理员在 App 设置里改权限，并在安装处接受）'
      : assignment.state === 'conflict' ? '（此人不能被指派到这个仓库，或网关身份没有写权限时，GitHub 会忽略指派而不报错）' : ''
    lines.push(`网关没有指派成功：${assignmentReason(assignment)}${permission}。谁负责已留给${who}定，不要说成已指派。`)
  }
  return lines
}

/** 待拍板没记成（已记过、已结清、写入失败）但这次尝试过指派：只照实说指派结果，不给 @。 */
function assignmentOnlyLine(assignment: IssueAssignmentOutcome): string {
  if (assignment.state === 'assigned') return `GitHub 上这张 Issue 已指派给 ${assignment.login}（写后回读确认）：不要再 @。`
  if (assignment.state === 'skipped' && assignment.reason === 'already_assigned') return `GitHub 上这张 Issue 已有负责人（${(assignment.assignees ?? []).map(plain).join('、')}），宿主没有再指派。`
  return `网关没有指派成功：${assignmentReason(assignment)}。不要说成已指派。`
}

/** github_open_issue 回执里给模型看的几行：记在谁名下、有没有指派、要不要 @、疑似重复。 */
export function issueTriageLines(view: IssueTriageView | undefined): string[] {
  if (!view) return []
  const lines: string[] = []
  const who = view.decider?.role === 'admin' ? `${view.decider.name ? plain(view.decider.name) : '部署管理员'}（部署管理员）` : '发起人本人'
  const assignment = view.assignment
  if (view.state === 'recorded') {
    const questions = (view.questions ?? []).map(q => QUESTION_TEXT[q]).join('、')
    // 指派结果由下面负责人那几行说；这里只说没做的事
    const effect = assignment ? '宿主没有打标签、合并或关闭任何 Issue。' : '宿主没有在 GitHub 上指派、打标签、合并或关闭任何 Issue。'
    lines.push(`宿主已把「${questions}」记进${who}的待拍板${view.decision ? `（decision:${view.decision.id}）` : ''}。不要再调 friday_needs_decision 记同一件事；对方给了结论（例如“负责人定 X，P2”）再用 friday_decision_list 找到这一条、friday_decision_resolve 结清。${effect}`)
    const owner = view.owner
    if (owner?.kind === 'resolved') {
      lines.push(...resolvedOwnerLines(owner, assignment, who))
    } else if (owner?.kind === 'ambiguous') {
      lines.push(`${AMBIGUOUS_TEXT[owner.reason]}（${owner.logins.join('、')}）：不要自己挑一个人 @，负责人交给${who}定。`)
    } else if (owner) {
      lines.push(`${UNKNOWN_TEXT[owner.reason]}：不要猜负责人，交给${who}定。`)
    }
  } else if (view.state === 'already_open') {
    lines.push('这张 Issue 的待拍板之前已记过，还在等：不要再记一次，也不要再 @ 负责人。')
  } else if (view.state === 'already_resolved') {
    lines.push(`这张 Issue 的待拍板之前已结清${view.resolution?.note ? `：「${plain(view.resolution.note)}」` : ''}。按已定的结论说，不要重新问。`)
  } else if (view.state === 'not_needed') {
    if (assignment && ownerSettled(assignment) && view.owner?.kind === 'resolved') {
      lines.push(...resolvedOwnerLines(view.owner, assignment, who))
      lines.push('标签里已有优先级，也没有核验过的疑似重复，没有另记待拍板。')
    } else lines.push('这张 Issue 已有人给的负责人和标签，没有另记待拍板。')
  } else if (view.state === 'unavailable') {
    lines.push('这个部署没有开启待拍板，没有记待拍板：谁负责、优先级照实说还没定。')
  } else {
    lines.push('宿主这次没能记上待拍板（写入失败）。可以用 friday_needs_decision 记一次“这张 Issue 谁负责、优先级”。')
  }
  if (assignment && (view.state === 'already_open' || view.state === 'already_resolved' || view.state === 'failed')) lines.push(assignmentOnlyLine(assignment))
  const dups = view.duplicates
  if (dups?.verified.length) {
    lines.push('疑似重复（宿主已按编号读回核验；没有合并或关闭）：')
    for (const d of dups.verified) lines.push(`- #${d.number}「${clip(d.title, 80)}」${d.state === 'closed' ? '已关闭' : '打开'} ${d.url}`)
  }
  if (dups?.unverified.length) lines.push(`未能核验：${dups.unverified.map(u => `#${u.number}（${UNVERIFIED_TEXT[u.reason]}）`).join('、')}——不要把它们说成重复。`)
  return lines
}
