/**
 * 独立的只读核对：依据原创建操作的账本行读取 GitHub 的实际结果并更新原收据。
 * 不依赖原 Run 存活，没有再次发送能力；平台无法证明时保持 unknown，不编造编号。
 *
 * 证实：搜索结果完整、恰好一个候选（同事项指纹、由本身份创建、未归属于其他创建操作），且按编号回读一致。
 * 证明不存在：搜索结果完整、零候选，且操作已过搜索索引的沉淀窗口。其余情形只记录看到了什么。
 *
 * 指派操作（action='assigned'）不用搜索：按编号回读 Issue，负责人里有账本记下的目标就证实；
 * 没有且操作已过宽限期，记 verified_absent（状态不变）；操作太新只记录看到了什么。
 *
 * 人数块操作（action='affected_count'）同样只按编号回读：正文里唯一的人数块正好是这次要写的那一行就证实；
 * 不是且已过宽限期记 verified_absent（状态不变，也不因此重发）；太新只记录。
 */
import type { GitHubIdentity } from './identity.js'
import { affectedCountLine, affectedCountTarget, normalizeBlockText, parseAffectedCountBlock, readIssueBody } from './issue-affected-count.js'
import { assignmentTarget, fingerprintOf, readIssueAssignees, VERIFIED_ABSENT, type IssueAssignmentResult, type IssueLinks, type IssueOperationRecord, type OpenIssueResult } from './issues.js'

/** A planned row younger than this may still be an HTTP request in progress (client timeouts are 30 s); nothing is read for it. */
export const IN_FLIGHT_GRACE_MS = 5 * 60_000
/** Absence is only recorded once the search index has had this long to include the lost POST's result. */
export const SEARCH_SETTLE_MS = 10 * 60_000
/** The search lower bound starts this much before our recorded time so a clock ahead of GitHub's cannot hide our own issue. */
export const CLOCK_SKEW_ALLOWANCE_MS = 5 * 60_000
const PAGE_SIZE = 100
const MAX_PAGES = 5

export type IssueReconciliationResult =
  /** One own-identity candidate, verified by number; the original operation now carries its number and URL. */
  | 'confirmed'
  /** A complete search after the settle window showed no issue of ours for this fingerprint; the row stays unknown but no longer blocks. */
  | 'verified_absent'
  /** A complete search showed nothing, but the operation is too young for that to prove anything. */
  | 'too_recent'
  /** Two or more own-identity candidates; nothing attributed. */
  | 'ambiguous'
  /** The search was truncated or reported incomplete results; nothing decided. */
  | 'incomplete'
  /** Identity, search or read-back failed, or the read-back disagreed with the candidate; nothing recorded. */
  | 'unavailable'
  /** A planned row inside the in-flight grace period; not read. */
  | 'in_flight'
  /** A sent or confirmed row, or a row another operation updated meanwhile; never touched. */
  | 'already_resolved'

export interface IssueReconciliationReceipt {
  requestKey: string
  result: IssueReconciliationResult
  /** Ledger status after this call. */
  status: IssueOperationRecord['status']
  number: number | null
  url: string | null
  detail?: string
  candidates?: number[]
  checkedAt: number
}

/** The scope the fingerprint was computed with; titles can only be compared inside it. */
export interface IssueReconciliationScope { spaceId?: string }

export interface IssueReconciliationOptions {
  inFlightGraceMs?: number
  searchSettleMs?: number
  clockSkewMs?: number
  maxPages?: number
}

interface SearchItem { number?: unknown; title?: unknown; html_url?: unknown; user?: { login?: unknown } | null; pull_request?: unknown }
interface SearchPage { items?: SearchItem[]; total_count?: unknown; incomplete_results?: unknown }
interface Candidate { number: number }

export class IssueReconciliation {
  private readonly grace: number
  private readonly settle: number
  private readonly skew: number
  private readonly maxPages: number

  constructor(
    private readonly github: Pick<GitHubIdentity, 'api' | 'botLogin'>,
    private readonly links: IssueLinks,
    options: IssueReconciliationOptions = {},
  ) {
    this.grace = options.inFlightGraceMs ?? IN_FLIGHT_GRACE_MS
    this.settle = options.searchSettleMs ?? SEARCH_SETTLE_MS
    this.skew = options.clockSkewMs ?? CLOCK_SKEW_ALLOWANCE_MS
    this.maxPages = options.maxPages ?? MAX_PAGES
  }

  async reconcile(requestKey: string, scope: IssueReconciliationScope): Promise<IssueReconciliationReceipt> {
    const record = this.links.operationRecord(requestKey)
    if (!record) throw new Error('找不到该 GitHub 操作记录')
    if (record.action === 'assigned') return this.reconcileAssignment(record)
    if (record.action === 'affected_count') return this.reconcileAffectedCount(record)
    if (record.action !== 'created') throw new Error('该操作不是创建 Issue，没有创建结果可核对')
    const checkedAt = this.links.now()
    const receipt = (result: IssueReconciliationResult, extra: Partial<IssueReconciliationReceipt> = {}): IssueReconciliationReceipt => {
      const current = this.links.operationRecord(requestKey) ?? record
      return { requestKey, result, status: current.status, number: current.number, url: current.url, checkedAt, ...extra }
    }
    if (record.status === 'sent' || record.status === 'confirmed' || record.number != null) return receipt('already_resolved')
    if (record.status === 'planned' && checkedAt - record.createdAt < this.grace) return receipt('in_flight', { detail: '占位仍在发送宽限期内，可能尚在请求中' })
    if (!record.fingerprint) return receipt('unavailable', { detail: '操作没有事项指纹，无法比对标题' })

    let login: string
    try { login = await this.github.botLogin() } catch (error) { return receipt('unavailable', { detail: `本身份登录名不可用：${message(error)}` }) }
    if (!login) return receipt('unavailable', { detail: '本身份登录名为空' })

    const owner = record.repo.split('/')[0]
    const since = new Date(Math.max(0, record.createdAt - this.skew)).toISOString().replace(/\.\d{3}Z$/, '+00:00')
    const q = `repo:${record.repo} is:issue created:>=${since}`
    const items: SearchItem[] = []
    let total: number | null = null
    let pages = 0
    let complete = false
    try {
      for (let page = 1; page <= this.maxPages; page += 1) {
        const found = await this.github.api<SearchPage>('GET', `/search/issues?q=${encodeURIComponent(q)}&sort=created&order=asc&per_page=${PAGE_SIZE}&page=${page}`, undefined, owner)
        pages = page
        if (found.incomplete_results !== false || !Array.isArray(found.items) || typeof found.total_count !== 'number') break
        total = found.total_count
        items.push(...found.items)
        if (items.length >= total) { complete = true; break }
        if (!found.items.length) break
      }
    } catch (error) {
      return receipt('unavailable', { detail: `搜索失败：${message(error)}` })
    }
    const previousError = record.error === VERIFIED_ABSENT ? previousNote(record)?.previousError : record.error
    const base = { checkedAt, login, searched: { since, total, pages, complete }, ...(previousError ? { previousError } : {}) }
    if (!complete) {
      this.links.noteReconciliation(requestKey, JSON.stringify({ result: 'incomplete', ...base }), { absent: false })
      return receipt('incomplete', { detail: total == null ? '搜索结果不完整' : `搜索结果不完整：共 ${total} 条，只读到 ${items.length} 条` })
    }
    const attributed = this.links.attributedCreationNumbers(record.repo, requestKey)
    const candidates: Candidate[] = []
    for (const item of items) {
      if (item.pull_request || typeof item.title !== 'string' || typeof item.number !== 'number' || !Number.isSafeInteger(item.number) || item.number <= 0) continue
      if (item.user?.login !== login || attributed.has(item.number)) continue
      if (fingerprintOf({ spaceId: scope.spaceId, repo: record.repo, title: item.title }) === record.fingerprint) candidates.push({ number: item.number })
    }
    const numbers = candidates.map((c) => c.number).sort((a, b) => a - b)
    if (candidates.length > 1) {
      this.links.noteReconciliation(requestKey, JSON.stringify({ result: 'ambiguous', ...base, candidates: numbers }), { absent: false })
      return receipt('ambiguous', { candidates: numbers, detail: `本身份下有 ${numbers.length} 个同事项 Issue：${numbers.map((n) => `#${n}`).join('、')}` })
    }
    if (!candidates.length) {
      if (checkedAt - record.createdAt < this.settle) {
        this.links.noteReconciliation(requestKey, JSON.stringify({ result: 'too_recent', ...base }), { absent: false })
        return receipt('too_recent', { detail: '搜索无结果，但操作太新，索引可能尚未包含它' })
      }
      this.links.noteReconciliation(requestKey, JSON.stringify({ result: 'verified_absent', ...base }), { absent: true })
      return receipt('verified_absent')
    }

    // 只按编号从配置的 GitHub API 回读核验，不信任搜索结果自带的 URL。
    const number = candidates[0]!.number
    let verified: Record<string, unknown>
    try { verified = await this.github.api<Record<string, unknown>>('GET', `/repos/${record.repo}/issues/${number}`, undefined, owner) }
    catch (error) { return receipt('unavailable', { detail: `按编号回读 #${number} 失败：${message(error)}` }) }
    const mismatch = readBackMismatch(verified, number, record, scope, login)
    if (mismatch) return receipt('unavailable', { detail: `候选 #${number} 回读不一致：${mismatch}` })
    const url = String(verified.html_url)
    const result: OpenIssueResult = {
      action: 'created', repo: record.repo, number, url, title: String(verified.title), state: String(verified.state ?? 'open'),
      assignees: ((verified.assignees as { login: string }[] | undefined) ?? []).map((a) => a.login),
      labels: ((verified.labels as { name: string }[] | undefined) ?? []).map((l) => l.name),
      pending: ['这条结果由事后核对补齐：原请求要求的负责人/标签是否生效，以 Issue 当前内容为准'],
    }
    const link = this.links.get(record.fingerprint)
    const note = JSON.stringify({ result: 'confirmed', ...base, number, ...(link && link.number !== number ? { linkKept: link.number } : {}) })
    if (!this.links.confirmReconciledCreation(requestKey, { number, url, result, note })) return receipt('already_resolved', { detail: '核对期间该记录已被其他操作更新，未覆盖' })
    // An existing link to another issue stays the dedupe target; a late confirmation must not redirect later comments.
    if (!link || link.number === number) this.links.remember({ fingerprint: record.fingerprint, repo: record.repo, number, url, spaceId: scope.spaceId ?? null, source: link?.source ?? null })
    return receipt('confirmed')
  }

  /** 结果未知的指派：只按编号回读 Issue 的负责人，不搜索、不写 GitHub。sent 及已有结局的行不读不改。 */
  private async reconcileAssignment(record: IssueOperationRecord): Promise<IssueReconciliationReceipt> {
    const { requestKey } = record
    const checkedAt = this.links.now()
    const receipt = (result: IssueReconciliationResult, extra: Partial<IssueReconciliationReceipt> = {}): IssueReconciliationReceipt => {
      const current = this.links.operationRecord(requestKey) ?? record
      return { requestKey, result, status: current.status, number: current.number, url: current.url, checkedAt, ...extra }
    }
    if (record.status !== 'planned' && record.status !== 'unknown') return receipt('already_resolved')
    if (record.status === 'planned' && checkedAt - record.createdAt < this.grace) return receipt('in_flight', { detail: '占位仍在发送宽限期内，可能尚在请求中' })
    const target = assignmentTarget(record)
    if (!target || record.number == null) return receipt('unavailable', { detail: '操作没有记下指派目标或 Issue 编号' })
    let read: { url: string; assignees: string[] }
    try { read = await readIssueAssignees(this.github, record.repo, record.number) }
    catch (error) { return receipt('unavailable', { detail: `按编号回读 #${record.number} 失败：${message(error)}` }) }
    const previousError = record.error === VERIFIED_ABSENT ? previousNote(record)?.previousError : record.error
    const base = { checkedAt, target, assignees: read.assignees, ...(previousError ? { previousError } : {}) }
    if (read.assignees.some((login) => login.toLowerCase() === target)) {
      const result: IssueAssignmentResult = { repo: record.repo, number: record.number, url: read.url, login: target, assignees: read.assignees }
      if (!this.links.confirmReconciledAssignment(requestKey, { result, note: JSON.stringify({ result: 'confirmed', ...base }) })) {
        return receipt('already_resolved', { detail: '核对期间该记录已被其他操作更新，未覆盖' })
      }
      return receipt('confirmed')
    }
    // 回读是强一致的，但刚断开的请求可能还在 GitHub 处理：宽限期内的“没有”不算证明。
    if (checkedAt - record.createdAt < this.grace) {
      this.links.noteAssignmentReconciliation(requestKey, JSON.stringify({ result: 'too_recent', ...base }), { absent: false })
      return receipt('too_recent', { detail: '回读的负责人里还没有他，操作太新，请求可能仍在处理' })
    }
    this.links.noteAssignmentReconciliation(requestKey, JSON.stringify({ result: 'verified_absent', ...base }), { absent: true })
    return receipt('verified_absent')
  }

  /** 结果未知的人数块写入：只按编号回读正文，不搜索、不写 GitHub。sent 及已有结局的行不读不改（sent 由轮询回读补齐）。 */
  private async reconcileAffectedCount(record: IssueOperationRecord): Promise<IssueReconciliationReceipt> {
    const { requestKey } = record
    const checkedAt = this.links.now()
    const receipt = (result: IssueReconciliationResult, extra: Partial<IssueReconciliationReceipt> = {}): IssueReconciliationReceipt => {
      const current = this.links.operationRecord(requestKey) ?? record
      return { requestKey, result, status: current.status, number: current.number, url: current.url, checkedAt, ...extra }
    }
    if (record.status !== 'planned' && record.status !== 'unknown') return receipt('already_resolved')
    if (record.status === 'planned' && checkedAt - record.createdAt < this.grace) return receipt('in_flight', { detail: '占位仍在发送宽限期内，可能尚在请求中' })
    const target = affectedCountTarget(record)
    if (!target || record.number == null) return receipt('unavailable', { detail: '操作没有记下人数或 Issue 编号' })
    let read: { url: string; body: string }
    try { read = await readIssueBody(this.github, record.repo, record.number) }
    catch (error) { return receipt('unavailable', { detail: `按编号回读 #${record.number} 失败：${message(error)}` }) }
    const line = affectedCountLine(target.count)
    const block = parseAffectedCountBlock(read.body)
    const previousError = record.error === VERIFIED_ABSENT ? previousNote(record)?.previousError : record.error
    const base = { checkedAt, count: target.count, block: block.kind === 'single' ? block.text.slice(0, 200) : block.kind, ...(previousError ? { previousError } : {}) }
    if (block.kind === 'single' && block.text === normalizeBlockText(line)) {
      const result = { repo: record.repo, number: record.number, url: read.url, count: target.count, block: line }
      if (!this.links.settleAffectedCount(requestKey, ['planned', 'unknown'], { status: 'confirmed', result, error: null, reconciliation: JSON.stringify({ result: 'confirmed', ...base }) })) {
        return receipt('already_resolved', { detail: '核对期间该记录已被其他操作更新，未覆盖' })
      }
      return receipt('confirmed')
    }
    // 回读是强一致的，但刚断开的请求可能还在 GitHub 处理：宽限期内的“不是”不算证明。
    if (checkedAt - record.createdAt < this.grace) {
      this.links.settleAffectedCount(requestKey, ['planned', 'unknown'], { reconciliation: JSON.stringify({ result: 'too_recent', ...base }) })
      return receipt('too_recent', { detail: '块内还不是这次要写的内容，操作太新，请求可能仍在处理' })
    }
    this.links.settleAffectedCount(requestKey, ['planned', 'unknown'], { error: VERIFIED_ABSENT, reconciliation: JSON.stringify({ result: 'verified_absent', ...base }) })
    return receipt('verified_absent')
  }
}

function readBackMismatch(verified: Record<string, unknown>, number: number, record: IssueOperationRecord, scope: IssueReconciliationScope, login: string): string | null {
  if (verified.number !== number) return '编号不同'
  if (verified.pull_request) return '是 Pull Request'
  if (typeof verified.title !== 'string' || fingerprintOf({ spaceId: scope.spaceId, repo: record.repo, title: verified.title }) !== record.fingerprint) return '标题不属于同一事项'
  if ((verified.user as { login?: unknown } | undefined)?.login !== login) return '创建者不是本身份'
  let path: string
  try { path = new URL(String(verified.html_url ?? '')).pathname.toLowerCase() } catch { return '链接无效' }
  if (path !== `/${record.repo}/issues/${number}`.toLowerCase()) return '链接不指向该仓库的这个编号'
  return null
}

function previousNote(record: IssueOperationRecord): { previousError?: string } | undefined {
  if (!record.reconciliation) return undefined
  try { return JSON.parse(record.reconciliation) as { previousError?: string } } catch { return undefined }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
