/**
 * Issue 写侧：群里聊出来的问题，一句话变成正式 Issue。
 *
 * 写入操作遵守以下规则：
 * - **写前读取**：先按指纹搜一遍，同一件事已经有 Issue 就去补评论，不再开一张。
 * - **幂等**：本地映射复用 Issue；有 requestKey 的写请求另记 planned/sent/confirmed，结果未知时不自动重发。
 * - **只读核对**：结果未知的创建先由 `IssueReconciliation` 按本身份读平台补齐原收据或证明不存在（见 docs/github-reconciliation-design.md）；证明不了就继续阻止同一事项的新建。
 * - **写后回读**：写完再 GET 一次，回报真实的编号、状态和链接，不拿请求体当结果。
 * - **证据不足就留空**：猜不出负责人 / 优先级就不填，在正文里写明"待确认"，不替人做决定。
 * - **不覆盖人的修改**：只追加评论，不改别人写过的正文。唯一例外是 Friday 自己建的 Issue 里由它自己维护的受影响人数块
 *   （issue-affected-count.ts，默认关）：只改块内那一行，块被人改过就停止维护。
 *
 * 身份：走 GitHub App 时所有动作记在 `xxx[bot]` 名下（审计清楚、token 一小时过期）；
 * 过渡期用个人 token 时，所有动作会显示成那个人做的——这一点要在确认卡片上写给人看。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { SerialQueue } from '../core/queue.js'
import { GitHubApiError, type GitHubIdentity } from './identity.js'
import { IssueReconciliation } from './issue-reconciliation.js'
import type { RetainedSourceOrigin } from '../core/retained-source-access.js'
import type { MaterialProvenance } from '../core/execution-materials.js'

/** Host-only binding, reserved with the operation and never inferred for old rows. */
export interface IssueOperationOrigin {
  version: 1
  apiCallId: string
  origin: RetainedSourceOrigin
  provenance: MaterialProvenance
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS github_issue_links (
  fingerprint TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  space_id TEXT,
  source TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issue_links_repo ON github_issue_links(repo, number);
CREATE TABLE IF NOT EXISTS github_issue_operations (
  request_key TEXT PRIMARY KEY,
  signature TEXT NOT NULL,
  fingerprint TEXT,
  status TEXT NOT NULL,
  action TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER,
  url TEXT,
  comment_url TEXT,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`

interface IssueOperation {
  requestKey: string
  signature: string
  /** conflict / operation_failed 只出现在 action='assigned'（见 assignIssue）与 action='affected_count'（见 issue-affected-count.ts）的行上 */
  status: 'planned' | 'sent' | 'confirmed' | 'unknown' | 'conflict' | 'operation_failed'
  action: 'created' | 'commented' | 'assigned' | 'affected_count'
  repo: string
  number: number | null
  url: string
  commentUrl: string
  result: OpenIssueResult | CommentIssueResult | IssueAssignmentResult | null
}

/** One ledger row as the read-only reconciliation sees it: no signature check, because the reader is not the original caller. */
export interface IssueOperationRecord {
  requestKey: string
  status: IssueOperation['status']
  action: IssueOperation['action']
  repo: string
  fingerprint: string | null
  number: number | null
  url: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  /** JSON note written by the last reconciliation, null before any. */
  reconciliation: string | null
}

const UNKNOWN_RESULT = 'GitHub 写入结果未知，须核对远端；不会自动重发此请求'
/** Written into `error` when a complete platform read proved the lost POST created nothing; such a row no longer blocks new creations. */
export const VERIFIED_ABSENT = 'verified_absent'

export interface IssueLink {
  fingerprint: string
  repo: string
  number: number
  url: string
  spaceId: string | null
  source: string | null
  createdAt: number
}

/** 同一件事的指纹：空间 + 仓库 + 标题（归一化后）。标题改几个字仍然算同一件事。 */
export function fingerprintOf(input: { spaceId?: string; repo: string; title: string }): string {
  const norm = input.title
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '')
    .slice(0, 80)
  return createHash('sha1').update(`${input.spaceId ?? ''}|${input.repo}|${norm}`).digest('hex').slice(0, 16)
}

export class IssueLinks {
  /** 只串行这个 store 中同一事项的写入；不同 fingerprint / DB 实例互不阻塞。 */
  private readonly openQueue = new SerialQueue()

  constructor(
    private readonly db: DatabaseSync,
    readonly now: () => number = () => Date.now(),
  ) {
    db.exec(SCHEMA)
    const columns = db.prepare('PRAGMA table_info(github_issue_operations)').all() as { name: string }[]
    if (!columns.some((column) => column.name === 'fingerprint')) db.exec('ALTER TABLE github_issue_operations ADD COLUMN fingerprint TEXT')
    if (!columns.some((column) => column.name === 'reconciliation')) db.exec('ALTER TABLE github_issue_operations ADD COLUMN reconciliation TEXT')
    if (!columns.some((column) => column.name === 'origin_json')) db.exec('ALTER TABLE github_issue_operations ADD COLUMN origin_json TEXT')
    db.exec('CREATE INDEX IF NOT EXISTS idx_issue_operations_fingerprint ON github_issue_operations(fingerprint, action, status)')
    db.exec("CREATE INDEX IF NOT EXISTS idx_issue_operations_work ON github_issue_operations(json_extract(origin_json,'$.origin.workKey'), created_at)")
  }

  get(fingerprint: string): IssueLink | undefined {
    const r = this.db.prepare('SELECT * FROM github_issue_links WHERE fingerprint = ?').get(fingerprint) as Record<string, unknown> | undefined
    return r ? { fingerprint: String(r.fingerprint), repo: String(r.repo), number: Number(r.number), url: String(r.url), spaceId: (r.space_id as string | null) ?? null, source: (r.source as string | null) ?? null, createdAt: Number(r.created_at) } : undefined
  }

  remember(link: Omit<IssueLink, 'createdAt'> & { createdBy?: string }): void {
    this.db
      .prepare('INSERT INTO github_issue_links (fingerprint, repo, number, url, space_id, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET repo = excluded.repo, number = excluded.number, url = excluded.url')
      .run(link.fingerprint, link.repo, link.number, link.url, link.spaceId ?? null, link.source ?? null, link.createdBy ?? null, this.now())
  }

  serializeOpen<T>(fingerprint: string, write: () => Promise<T>): Promise<T> {
    return this.openQueue.run(fingerprint, write)
  }

  /** 创建结果未知属于同一事项，不能通过改正文/换 requestKey 绕过。旧签名只可精确关联，不能反推标题。已由核对证明不存在的创建不再阻止。 */
  hasUnresolvedCreation(fingerprint: string, signature: string): boolean {
    this.db.prepare("UPDATE github_issue_operations SET fingerprint = ? WHERE fingerprint IS NULL AND signature = ? AND action = 'created' AND status IN ('planned', 'unknown')").run(fingerprint, signature)
    return !!this.db.prepare("SELECT 1 FROM github_issue_operations WHERE fingerprint = ? AND action = 'created' AND status IN ('planned', 'unknown') AND error IS NOT ? LIMIT 1").get(fingerprint, VERIFIED_ABSENT)
  }

  /** 仍在阻止该事项新建的创建操作，按发起顺序。 */
  unresolvedCreations(fingerprint: string): IssueOperationRecord[] {
    const rows = this.db.prepare("SELECT * FROM github_issue_operations WHERE fingerprint = ? AND action = 'created' AND status IN ('planned', 'unknown') AND error IS NOT ? ORDER BY created_at, request_key").all(fingerprint, VERIFIED_ABSENT) as Record<string, unknown>[]
    return rows.map(operationRecord)
  }

  operationRecord(requestKey: string): IssueOperationRecord | undefined {
    const r = this.db.prepare('SELECT * FROM github_issue_operations WHERE request_key = ?').get(requestKey) as Record<string, unknown> | undefined
    return r ? operationRecord(r) : undefined
  }

  /** 同仓库里已归属于其他创建操作的 Issue 编号；核对时不能把它们算作本操作的结果。 */
  attributedCreationNumbers(repo: string, exceptRequestKey: string): Set<number> {
    const rows = this.db.prepare("SELECT number FROM github_issue_operations WHERE repo = ? AND action = 'created' AND number IS NOT NULL AND request_key != ?").all(repo, exceptRequestKey) as { number: number }[]
    return new Set(rows.map((r) => Number(r.number)))
  }

  /** 核对证实旧 POST 的真实结果：只改仍无编号的 planned/unknown 创建行；返回 false 表示行已被别的操作改过。 */
  confirmReconciledCreation(requestKey: string, input: { number: number; url: string; result: OpenIssueResult; note: string }): boolean {
    const changed = this.db.prepare("UPDATE github_issue_operations SET status = 'confirmed', number = ?, url = ?, result = ?, error = NULL, reconciliation = ?, updated_at = ? WHERE request_key = ? AND action = 'created' AND status IN ('planned', 'unknown') AND number IS NULL")
      .run(input.number, input.url, JSON.stringify(input.result), input.note, this.now(), requestKey)
    return Number(changed.changes) > 0
  }

  /** 记录一次核对看到了什么；`absent` 为 true 时把 error 置为 verified_absent，解除对新建的阻止。状态本身不变。 */
  noteReconciliation(requestKey: string, note: string, options: { absent: boolean }): boolean {
    const changed = options.absent
      ? this.db.prepare("UPDATE github_issue_operations SET error = ?, reconciliation = ?, updated_at = ? WHERE request_key = ? AND action = 'created' AND status IN ('planned', 'unknown') AND number IS NULL").run(VERIFIED_ABSENT, note, this.now(), requestKey)
      : this.db.prepare("UPDATE github_issue_operations SET reconciliation = ?, updated_at = ? WHERE request_key = ? AND action = 'created' AND status IN ('planned', 'unknown') AND number IS NULL").run(note, this.now(), requestKey)
    return Number(changed.changes) > 0
  }

  /** 这个空间开过的 Issue（`/status` 里可以带一行）。 */
  forSpace(spaceId: string, limit = 20): IssueLink[] {
    const rows = this.db.prepare('SELECT * FROM github_issue_links WHERE space_id = ? ORDER BY created_at DESC LIMIT ?').all(spaceId, limit) as Record<string, unknown>[]
    return rows.map((r) => ({ fingerprint: String(r.fingerprint), repo: String(r.repo), number: Number(r.number), url: String(r.url), spaceId: (r.space_id as string | null) ?? null, source: (r.source as string | null) ?? null, createdAt: Number(r.created_at) }))
  }

  operation(requestKey: string, signature: string): IssueOperation | undefined {
    const r = this.db.prepare('SELECT * FROM github_issue_operations WHERE request_key = ?').get(requestKey) as Record<string, unknown> | undefined
    if (!r) return undefined
    if (r.signature !== signature) throw new Error('GitHub requestKey 已用于不同的操作，请检查请求标识')
    return {
      requestKey, signature, status: r.status as IssueOperation['status'], action: r.action as IssueOperation['action'],
      repo: String(r.repo), number: r.number == null ? null : Number(r.number), url: String(r.url ?? ''), commentUrl: String(r.comment_url ?? ''),
      result: r.result ? JSON.parse(String(r.result)) as OpenIssueResult | CommentIssueResult : null,
    }
  }

  /** 在 POST 之前占位；同一进程的并发调用也只能有一个调用者拿到发送资格。 */
  planOperation(input: { requestKey: string; signature: string; action: IssueOperation['action']; repo: string; fingerprint?: string; number?: number; url?: string; origin?: IssueOperationOrigin }): boolean {
    const now = this.now()
    return Number(this.db.prepare("INSERT OR IGNORE INTO github_issue_operations (request_key, signature, fingerprint, status, action, repo, number, url, created_at, updated_at, origin_json) VALUES (?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?)").run(input.requestKey, input.signature, input.fingerprint ?? null, input.action, input.repo, input.number ?? null, input.url ?? null, now, now, input.origin ? JSON.stringify(input.origin) : null).changes) > 0
  }

  sentOperation(requestKey: string, number: number, url: string, commentUrl?: string): void {
    const changed = this.db.prepare("UPDATE github_issue_operations SET status = 'sent', number = ?, url = ?, comment_url = ?, updated_at = ? WHERE request_key = ? AND status = 'planned'").run(number, url, commentUrl ?? null, this.now(), requestKey)
    if (!Number(changed.changes)) throw new Error(UNKNOWN_RESULT)
  }

  unknownOperation(requestKey: string, error: string): void {
    this.db.prepare("UPDATE github_issue_operations SET status = 'unknown', error = ?, updated_at = ? WHERE request_key = ? AND status = 'planned'").run(error.slice(0, 500), this.now(), requestKey)
  }

  /** 仅在调用方确认 HTTP 尚未开始时撤销自己的占位；已发送/未知记录不可清除。 */
  releaseUnsentOperation(requestKey: string): void {
    this.db.prepare("DELETE FROM github_issue_operations WHERE request_key = ? AND status = 'planned'").run(requestKey)
  }

  /** 指派：GitHub 明确拒绝或请求没有发出（远端没有变化）时，planned → operation_failed，记下原因。 */
  failOperation(requestKey: string, error: string, result: IssueAssignmentResult): boolean {
    return Number(this.db.prepare("UPDATE github_issue_operations SET status = 'operation_failed', result = ?, error = ?, updated_at = ? WHERE request_key = ? AND action = 'assigned' AND status = 'planned'")
      .run(JSON.stringify(result), error.slice(0, 500), this.now(), requestKey).changes) > 0
  }

  /** 指派：请求已被接受但回读的负责人里没有目标，sent → conflict，记下回读结果。 */
  conflictOperation(requestKey: string, result: IssueAssignmentResult, error: string): boolean {
    return Number(this.db.prepare("UPDATE github_issue_operations SET status = 'conflict', result = ?, error = ?, updated_at = ? WHERE request_key = ? AND action = 'assigned' AND status = 'sent'")
      .run(JSON.stringify(result), error.slice(0, 500), this.now(), requestKey).changes) > 0
  }

  /** 同一张 Issue 上别的请求发起过的指派；只有 operation_failed（证明远端没变）不算。 */
  otherAssignments(repo: string, number: number, exceptRequestKey: string): IssueOperationRecord[] {
    const rows = this.db.prepare("SELECT * FROM github_issue_operations WHERE action = 'assigned' AND lower(repo) = lower(?) AND number = ? AND request_key != ? AND status != 'operation_failed' ORDER BY created_at, request_key")
      .all(repo, number, exceptRequestKey) as Record<string, unknown>[]
    return rows.map(operationRecord)
  }

  /** 核对证实结果未知的指派已生效：planned/unknown → confirmed。返回 false 表示行已被别的操作改过。 */
  confirmReconciledAssignment(requestKey: string, input: { result: IssueAssignmentResult; note: string }): boolean {
    return Number(this.db.prepare("UPDATE github_issue_operations SET status = 'confirmed', result = ?, error = NULL, reconciliation = ?, updated_at = ? WHERE request_key = ? AND action = 'assigned' AND status IN ('planned', 'unknown')")
      .run(JSON.stringify(input.result), input.note, this.now(), requestKey).changes) > 0
  }

  /** 记录一次指派核对看到了什么；`absent` 为 true 时 error 置为 verified_absent。状态不变，也不因此重发。 */
  noteAssignmentReconciliation(requestKey: string, note: string, options: { absent: boolean }): boolean {
    const changed = options.absent
      ? this.db.prepare("UPDATE github_issue_operations SET error = ?, reconciliation = ?, updated_at = ? WHERE request_key = ? AND action = 'assigned' AND status IN ('planned', 'unknown')").run(VERIFIED_ABSENT, note, this.now(), requestKey)
      : this.db.prepare("UPDATE github_issue_operations SET reconciliation = ?, updated_at = ? WHERE request_key = ? AND action = 'assigned' AND status IN ('planned', 'unknown')").run(note, this.now(), requestKey)
    return Number(changed.changes) > 0
  }

  /** Friday 自己建的 Issue：action='created' 且 POST 已返回编号（sent/confirmed）。只认本账本，不按标题或作者猜；同名已有 Issue 只补过评论的不算。 */
  createdIssueNumbers(): { repo: string; number: number }[] {
    return (this.db.prepare("SELECT repo, number FROM github_issue_operations WHERE action = 'created' AND status IN ('sent', 'confirmed') AND number IS NOT NULL ORDER BY created_at, request_key").all() as { repo: string; number: number }[])
      .map((r) => ({ repo: String(r.repo), number: Number(r.number) }))
  }

  /** 这张 Issue 的人数块操作（action='affected_count'），按发起顺序；result 是账本原样的 JSON 文本。 */
  affectedCountRecords(repo: string, number: number): (IssueOperationRecord & { result: string | null })[] {
    const rows = this.db.prepare("SELECT * FROM github_issue_operations WHERE action = 'affected_count' AND lower(repo) = lower(?) AND number = ? ORDER BY created_at, rowid")
      .all(repo, number) as Record<string, unknown>[]
    return rows.map((r) => ({ ...operationRecord(r), result: (r.result as string | null) ?? null }))
  }

  /** 人数块操作的状态推进：只改 action='affected_count' 且当前处于 from 之一的行；返回 false 表示行已被别的操作改过。 */
  settleAffectedCount(requestKey: string, from: readonly IssueOperation['status'][], to: { status?: IssueOperation['status']; result?: unknown; error?: string | null; reconciliation?: string }): boolean {
    const sets = ['updated_at = ?']
    const values: (string | number | null)[] = [this.now()]
    if (to.status) { sets.push('status = ?'); values.push(to.status) }
    if (to.result !== undefined) { sets.push('result = ?'); values.push(JSON.stringify(to.result)) }
    if (to.error !== undefined) { sets.push('error = ?'); values.push(to.error === null ? null : to.error.slice(0, 500)) }
    if (to.reconciliation !== undefined) { sets.push('reconciliation = ?'); values.push(to.reconciliation) }
    return Number(this.db.prepare(`UPDATE github_issue_operations SET ${sets.join(', ')} WHERE request_key = ? AND action = 'affected_count' AND status IN (${from.map(() => '?').join(', ')})`)
      .run(...values, requestKey, ...from).changes) > 0
  }

  /** 停止维护这张 Issue 的人数块：记一行 status='conflict'（按 requestKey INSERT OR IGNORE，每张 Issue 只记一次），error 写原因。 */
  stopAffectedCount(input: { requestKey: string; signature: string; fingerprint: string; repo: string; number: number; url: string; error: string; result: unknown }): boolean {
    const now = this.now()
    return Number(this.db.prepare("INSERT OR IGNORE INTO github_issue_operations (request_key, signature, fingerprint, status, action, repo, number, url, result, error, created_at, updated_at) VALUES (?, ?, ?, 'conflict', 'affected_count', ?, ?, ?, ?, ?, ?, ?)")
      .run(input.requestKey, input.signature, input.fingerprint, input.repo, input.number, input.url, JSON.stringify(input.result), input.error.slice(0, 500), now, now).changes) > 0
  }

  confirmOperation(requestKey: string, result: OpenIssueResult | CommentIssueResult | IssueAssignmentResult): void {
    const changed = this.db.prepare("UPDATE github_issue_operations SET status = 'confirmed', result = ?, updated_at = ? WHERE request_key = ? AND status = 'sent'").run(JSON.stringify(result), this.now(), requestKey)
    if (!Number(changed.changes)) {
      const row = this.db.prepare('SELECT status FROM github_issue_operations WHERE request_key = ?').get(requestKey) as { status: string } | undefined
      // 两个 sent 状态的回读可以并发；第二个不重复写，也不把已确认结果误报为未知。
      if (row?.status !== 'confirmed') throw new Error(UNKNOWN_RESULT)
    }
  }
}

export interface OpenIssueInput {
  repo: string
  title: string
  body: string
  labels?: string[]
  assignees?: string[]
  spaceId?: string
  source?: string
  createdBy?: string
  /** 入口按 actor/来源请求/原始意图签发的稳定 key，必须包含正文语义；不含追加的出处时间戳。 */
  requestKey?: string
  /** 可信网关提供，在异步查重/取 token 后、每次写入前重验本轮身份和来源。 */
  assertAuthorized?: () => void
  /** Captured at reservation, after any lookup awaits; never accepted from tool arguments. */
  captureOrigin?: () => IssueOperationOrigin
}

export interface OpenIssueResult {
  action: 'created' | 'commented'
  repo: string
  number: number
  url: string
  title: string
  state: string
  assignees: string[]
  labels: string[]
  /** 没填的字段和原因，给人看的一行 */
  pending: string[]
  /** 重复请求的已有确认结果；没有再次写入，不表示刚刚回读了远端。 */
  replayed?: boolean
}

/** 正文末尾的出处行：从哪个空间、谁、什么时候提出来的。人点开 Issue 能追回聊天。 */
export function provenanceLine(input: { botName: string; where: string; by?: string; nowMs: number }): string {
  const when = new Date(input.nowMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  return `\n\n---\n由 ${input.botName} 从${input.where}的讨论整理${input.by ? `（提出人：${input.by}）` : ''}，${when}。内容如与实际不符，直接在这里评论纠正即可。`
}

/**
 * 开 Issue：先查重（本地映射 + 远端搜索），命中就补一条评论，否则新建；写完回读一次。
 * 不猜负责人和优先级——没给就留空，并在 `pending` 里说明。
 */
export async function openIssue(github: GitHubIdentity, links: IssueLinks, input: OpenIssueInput): Promise<OpenIssueResult> {
  const owner = input.repo.split('/')[0]
  const fingerprint = fingerprintOf({ spaceId: input.spaceId, repo: input.repo, title: input.title })
  const key = requestKey(input.requestKey)
  // 正文语义由入口签发的 key 覆盖；这里检查静态目标，不能把变化的出处时间戳混进重试身份。
  const signature = operationSignature({ kind: 'open', repo: input.repo, title: input.title, spaceId: input.spaceId ?? null, createdBy: input.createdBy ?? null, labels: [...(input.labels ?? [])].sort(), assignees: [...(input.assignees ?? [])].sort() })
  const finish = async (operation: Pick<IssueOperation, 'number' | 'url'> & { action: OpenIssueResult['action'] }): Promise<OpenIssueResult> => {
    if (!operation.number) throw new Error(UNKNOWN_RESULT)
    const readBack = await github.api<Record<string, unknown>>('GET', `/repos/${input.repo}/issues/${operation.number}`, undefined, owner)
    const url = String(readBack.html_url ?? operation.url)
    links.remember({ fingerprint, repo: input.repo, number: operation.number, url, spaceId: input.spaceId ?? null, source: input.source ?? null, createdBy: input.createdBy })
    const result = issueResult(operation.action, input, operation.number, url, readBack)
    if (key) links.confirmOperation(key, result)
    return result
  }
  const replay = async (): Promise<OpenIssueResult> => {
    const operation = links.operation(key!, signature)
    if (operation?.status === 'confirmed' && operation.result) return { ...operation.result as OpenIssueResult, replayed: true }
    if (operation?.status === 'sent' && (operation.action === 'created' || operation.action === 'commented')) return finish({ ...operation, action: operation.action })
    // planned 也可能是“POST 成功后进程退出”；没有远端 ID 就不猜是否成功。
    throw new Error(UNKNOWN_RESULT)
  }
  if (key && links.operation(key, signature)) return replay()

  return links.serializeOpen(fingerprint, async () => {
    // 等待前一个同事项请求后重查；不同正文仍会进入补评论，同 key 只恢复已有操作。
    if (key && links.operation(key, signature)) return replay()
    let unresolvedCreation = links.hasUnresolvedCreation(fingerprint, signature)
    let existing: IssueLink | undefined
    try {
      if (unresolvedCreation) {
        // 先只读核对每条未决创建：证实则原收据补齐编号并记住链接；证明不存在则不再阻止。其余保持 unknown，进入下面的候选核验。
        const reconciliation = new IssueReconciliation(github, links)
        for (const operation of links.unresolvedCreations(fingerprint)) await reconciliation.reconcile(operation.requestKey, { spaceId: input.spaceId })
        unresolvedCreation = links.hasUnresolvedCreation(fingerprint, signature)
      }
      // ① 写前读取：本地映射优先，其次远端按标题搜一遍（有人手工开过同名的也能认出来）
      existing = links.get(fingerprint)
      if (!existing) {
        const q = `repo:${input.repo} is:issue in:title ${input.title.slice(0, 60)}`
        // 查重失败必须向上报告，不能当成“没有同名 Issue”继续创建。
        const found = await github.api<{ items: { number: number; title: string; html_url: string; state: string }[]; total_count?: number; incomplete_results?: boolean }>('GET', `/search/issues?q=${encodeURIComponent(q)}&per_page=5`, undefined, owner)
        if (unresolvedCreation && (found.incomplete_results !== false || found.total_count !== found.items.length)) throw new Error(UNKNOWN_RESULT)
        const matches = found.items.filter((it) => fingerprintOf({ spaceId: input.spaceId, repo: input.repo, title: it.title }) === fingerprint && (unresolvedCreation || it.state === 'open'))
        if (unresolvedCreation && matches.length !== 1) throw new Error(UNKNOWN_RESULT)
        const hit = matches[0]
        if (hit) existing = { fingerprint, repo: input.repo, number: hit.number, url: hit.html_url, spaceId: input.spaceId ?? null, source: input.source ?? null, createdAt: Date.now() }
      }
      if (unresolvedCreation) {
        if (!existing || !Number.isSafeInteger(existing.number) || existing.number <= 0 || existing.repo !== input.repo) throw new Error(UNKNOWN_RESULT)
        // 只从配置的 GitHub API 按编号核验，不请求搜索结果/model 提供的 URL。
        const verified = await github.api<Record<string, unknown>>('GET', `/repos/${input.repo}/issues/${existing.number}`, undefined, owner)
        const url = new URL(String(verified.html_url ?? ''))
        if (verified.number !== existing.number || verified.pull_request || typeof verified.title !== 'string' ||
          fingerprintOf({ spaceId: input.spaceId, repo: input.repo, title: verified.title }) !== fingerprint ||
          url.pathname.toLowerCase() !== `/${input.repo}/issues/${existing.number}`.toLowerCase()) throw new Error(UNKNOWN_RESULT)
        existing.url = String(verified.html_url)
        // 只证明该事项当前存在；旧 POST 仍可能未获确认，不把旧 unknown 改成 confirmed。
      }
    } catch (error) {
      if (unresolvedCreation) throw new Error(UNKNOWN_RESULT, { cause: error })
      throw error
    }

    const action = existing ? 'commented' : 'created'
    input.assertAuthorized?.()
    if (key && !links.planOperation({ requestKey: key, signature, fingerprint, action, repo: input.repo, number: existing?.number, url: existing?.url, origin: input.captureOrigin?.() })) return replay()
    let number: number
    let url: string
    let requestStarted = !input.assertAuthorized
    const beforeRequest = (): void => { input.assertAuthorized?.(); requestStarted = true }
    try {
      if (existing) {
        // 已经有了：只追加评论，绝不改别人写过的正文。
        links.remember({ ...existing, createdBy: input.createdBy })
        const comment = await github.api<Record<string, unknown>>('POST', `/repos/${existing.repo}/issues/${existing.number}/comments`, { body: input.body }, owner, beforeRequest)
        requestStarted = true
        number = existing.number
        url = existing.url
        if (key) links.sentOperation(key, number, url, String(comment.html_url ?? ''))
      } else {
        const created = await github.api<Record<string, unknown>>('POST', `/repos/${input.repo}/issues`, {
          title: input.title.slice(0, 250), body: input.body,
          ...(input.labels?.length ? { labels: input.labels } : {}), ...(input.assignees?.length ? { assignees: input.assignees } : {}),
        }, owner, beforeRequest)
        requestStarted = true
        number = Number(created.number)
        if (!Number.isSafeInteger(number) || number <= 0) throw new Error('建 Issue 没有返回编号')
        url = String(created.html_url ?? '')
        // 编号已经由 POST 确认，先落库；回读失败也不能遗忘这个外部动作。
        links.remember({ fingerprint, repo: input.repo, number, url, spaceId: input.spaceId ?? null, source: input.source ?? null, createdBy: input.createdBy })
        if (key) links.sentOperation(key, number, url)
      }
    } catch (err) {
      if (!requestStarted) {
        if (key) links.releaseUnsentOperation(key)
        throw err
      }
      if (!key) throw err
      try { links.unknownOperation(key, err instanceof Error ? err.message : String(err)) } catch { /* DB 不可写时 planned 本身也禁止重放。 */ }
      throw new Error(UNKNOWN_RESULT, { cause: err })
    }
    return finish({ action, number, url })
  })
}

function requestKey(key?: string): string | undefined {
  if (key !== undefined && !key.trim()) throw new Error('GitHub requestKey 不能为空')
  return key
}

function operationRecord(r: Record<string, unknown>): IssueOperationRecord {
  return {
    requestKey: String(r.request_key), status: r.status as IssueOperation['status'], action: r.action as IssueOperation['action'], repo: String(r.repo),
    fingerprint: (r.fingerprint as string | null) ?? null, number: r.number == null ? null : Number(r.number), url: (r.url as string | null) ?? null,
    error: (r.error as string | null) ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), reconciliation: (r.reconciliation as string | null) ?? null,
  }
}

function operationSignature(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function issueResult(action: OpenIssueResult['action'], input: OpenIssueInput, number: number, url: string, readBack: Record<string, unknown>): OpenIssueResult {
  const pending: string[] = []
  // 谁负责、优先级由网关建单后另记待拍板（src/github/issue-triage.ts），这里只说明没填。
  if (!input.assignees?.length) pending.push('负责人没填——我不替人指派')
  if (!input.labels?.length) pending.push('标签没填——不确定该归哪类，人工补一个更准')
  const gotAssignees = ((readBack.assignees as { login: string }[] | undefined) ?? []).map((a) => a.login)
  for (const want of action === 'created' ? input.assignees ?? [] : []) {
    if (!gotAssignees.includes(want)) pending.push(`指派 ${want} 没生效（多半是他不在这个仓库的协作者里），需要人工处理`)
  }
  return {
    action,
    repo: input.repo,
    number,
    url,
    title: String(readBack.title ?? input.title),
    state: String(readBack.state ?? 'open'),
    assignees: gotAssignees,
    labels: ((readBack.labels as { name: string }[] | undefined) ?? []).map((l) => l.name),
    pending,
  }
}

export interface CommentIssueResult {
  repo: string
  number: number
  url: string
  commentUrl: string
  replayed?: boolean
}

/** 在已有 Issue / PR 下追加一条评论（只追加，不改正文）。 */
export async function commentIssue(github: GitHubIdentity, input: { repo: string; number: number; body: string; requestKey?: string; assertAuthorized?: () => void; captureOrigin?: () => IssueOperationOrigin }, links?: IssueLinks): Promise<CommentIssueResult> {
  const owner = input.repo.split('/')[0]
  const key = requestKey(input.requestKey)
  if (key && !links) throw new Error('GitHub 幂等评论需要持久操作记录')
  const signature = operationSignature({ kind: 'comment', repo: input.repo, number: input.number })
  const finish = async (commentUrl: string): Promise<CommentIssueResult> => {
    const issue = await github.api<Record<string, unknown>>('GET', `/repos/${input.repo}/issues/${input.number}`, undefined, owner)
    const result = { repo: input.repo, number: input.number, url: String(issue.html_url ?? ''), commentUrl }
    if (key) links!.confirmOperation(key, result)
    return result
  }
  const replay = async (): Promise<CommentIssueResult> => {
    const operation = links!.operation(key!, signature)
    if (operation?.status === 'confirmed' && operation.result) return { ...operation.result as CommentIssueResult, replayed: true }
    if (operation?.status === 'sent') return finish(operation.commentUrl)
    throw new Error(UNKNOWN_RESULT)
  }
  if (key && links!.operation(key, signature)) return replay()
  input.assertAuthorized?.()
  if (key && !links!.planOperation({ requestKey: key, signature, action: 'commented', repo: input.repo, number: input.number, origin: input.captureOrigin?.() })) return replay()
  let commentUrl: string
  let requestStarted = !input.assertAuthorized
  const beforeRequest = (): void => { input.assertAuthorized?.(); requestStarted = true }
  try {
    const comment = await github.api<Record<string, unknown>>('POST', `/repos/${input.repo}/issues/${input.number}/comments`, { body: input.body }, owner, beforeRequest)
    requestStarted = true
    commentUrl = String(comment.html_url ?? '')
    if (key) links!.sentOperation(key, input.number, '', commentUrl)
  } catch (err) {
    if (!requestStarted) {
      if (key) links!.releaseUnsentOperation(key)
      throw err
    }
    if (!key) throw err
    try { links!.unknownOperation(key, err instanceof Error ? err.message : String(err)) } catch { /* 保留 planned，不能重放。 */ }
    throw new Error(UNKNOWN_RESULT, { cause: err })
  }
  return finish(commentUrl)
}

/** 账本 result 列里的指派结果：GitHub 回读到的负责人；没生效时为空，GitHub 拒绝时带 HTTP 状态。 */
export interface IssueAssignmentResult {
  repo: string
  number: number
  url: string
  login: string
  assignees: string[]
  httpStatus?: number
  error?: string
}

/** 一次指派的结局。只有 assigned 表示 GitHub 回读确认他已是负责人。 */
export type IssueAssignmentOutcome =
  | { state: 'assigned'; login: string; assignees: string[]; replayed?: boolean }
  /** GitHub 接受了请求，但回读的负责人里没有他（GitHub 对无权被指派的人不报错，只是不加） */
  | { state: 'conflict'; login: string; assignees: string[]; replayed?: boolean }
  /** operation_failed：GitHub 明确拒绝（带 HTTP 状态），或请求没有发出；远端没有变化 */
  | { state: 'failed'; login: string; httpStatus?: number; error: string; replayed?: boolean }
  /** 请求可能已到 GitHub，回读没能确认；不会自动重发 */
  | { state: 'unknown'; login: string }
  /** 没有写：Issue 已有负责人 / 这张 Issue 之前发起过指派 / CODEOWNERS 写的是邮箱 / 写前读不到 Issue */
  | { state: 'skipped'; login: string; reason: 'already_assigned' | 'assigned_before' | 'not_a_login' | 'unreadable'; assignees?: string[] }

export interface IssueAssignmentInput {
  repo: string
  number: number
  /** 建单回读的 Issue 链接，记进账本行 */
  url: string
  /** 要指派的 GitHub 登录名 */
  login: string
  /** 入口按本次请求签发的稳定 key；重放只恢复已有操作，不再发送 */
  requestKey: string
  /** 写门：写前与发送前重验本轮委托和仓库写权限，失败直接抛出 */
  assertAuthorized: () => void
  /** 宿主在占位时登记产生这次写入的 Run/Work（与建单同一次工具调用） */
  captureOrigin?: () => IssueOperationOrigin
}

/** GitHub 登录名：字母、数字、连字符，不以连字符开头，最长 39。CODEOWNERS 里的邮箱不能直接指派。 */
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
/** action='assigned' 的行在 fingerprint 列记指派目标（小写登录名）；其余 action 的 fingerprint 含义不变。 */
const ASSIGNEE_TARGET = 'assignee:'

/** 账本行记下的指派目标；不是指派行或格式不对时没有。 */
export function assignmentTarget(record: Pick<IssueOperationRecord, 'action' | 'fingerprint'>): string | undefined {
  if (record.action !== 'assigned' || !record.fingerprint?.startsWith(ASSIGNEE_TARGET)) return undefined
  const login = record.fingerprint.slice(ASSIGNEE_TARGET.length)
  return GITHUB_LOGIN.test(login) ? login : undefined
}

/** 按编号从配置的 GitHub API 读 Issue 的负责人；编号、类型（不是 PR）、链接路径对不上就抛错。 */
export async function readIssueAssignees(github: Pick<GitHubIdentity, 'api'>, repo: string, number: number): Promise<{ url: string; assignees: string[] }> {
  const issue = await github.api<Record<string, unknown>>('GET', `/repos/${repo}/issues/${number}`, undefined, repo.split('/')[0])
  const url = typeof issue.html_url === 'string' ? issue.html_url : ''
  let path = ''
  try { path = new URL(url).pathname.toLowerCase() } catch { /* 下面判为不一致 */ }
  if (issue.number !== number || issue.pull_request || path !== `/${repo}/issues/${number}`.toLowerCase()) throw new Error(`按编号读回的 #${number} 与请求的 Issue 不一致`)
  return { url, assignees: ((issue.assignees as { login?: unknown }[] | undefined) ?? []).map((a) => String(a?.login ?? '')).filter(Boolean) }
}

/**
 * 把一个人指派到 Issue 上（POST /repos/{repo}/issues/{n}/assignees），与建单同一套门禁：
 * - **写前读取**：同一张 Issue 已由别的请求发起过指派（没被证明失败）就不再写；Issue 已有负责人也不写。
 * - **账本**：github_issue_operations 记 action='assigned'，planned → sent → confirmed | conflict；GitHub 明确拒绝记 operation_failed；
 *   发送后结果未知记 unknown，只按回读判定（IssueReconciliation），不重发。
 * - **写后回读**：以 GitHub 回读的负责人为准，请求体不算结果。
 * 只有写门（委托失效）的错误向上抛；GitHub 的失败都变成结局返回，不影响已写成的 Issue。
 */
export async function assignIssue(github: Pick<GitHubIdentity, 'api' | 'botLogin'>, links: IssueLinks, input: IssueAssignmentInput): Promise<IssueAssignmentOutcome> {
  const { repo, number, url, login } = input
  if (!GITHUB_LOGIN.test(login)) return { state: 'skipped', login, reason: 'not_a_login' }
  const key = requestKey(input.requestKey)!
  const signature = operationSignature({ kind: 'assign', repo, number, login: login.toLowerCase() })
  const isTarget = (who: string) => who.toLowerCase() === login.toLowerCase()
  const result = (assignees: string[], extra: Pick<IssueAssignmentResult, 'httpStatus' | 'error'> = {}): IssueAssignmentResult => ({ repo, number, url, login, assignees, ...extra })
  const finish = async (): Promise<IssueAssignmentOutcome> => {
    try {
      const { assignees } = await readIssueAssignees(github, repo, number)
      if (assignees.some(isTarget)) {
        links.confirmOperation(key, result(assignees))
        return { state: 'assigned', login, assignees }
      }
      links.conflictOperation(key, result(assignees), `回读的负责人里没有 ${login}`)
      return { state: 'conflict', login, assignees }
    } catch {
      // 回读失败时行停在 sent：GitHub 已接受请求，重放时再读，不重发。
      return { state: 'unknown', login }
    }
  }
  const settle = async (): Promise<IssueAssignmentOutcome> => {
    const receipt = await new IssueReconciliation(github, links).reconcile(key, {})
    const saved = links.operation(key, signature)
    if (receipt.result === 'confirmed' && saved?.status === 'confirmed') return { state: 'assigned', login, assignees: (saved.result as IssueAssignmentResult).assignees }
    return { state: 'unknown', login }
  }
  const replay = async (operation: IssueOperation): Promise<IssueAssignmentOutcome> => {
    const saved = operation.result as IssueAssignmentResult | null
    if (operation.status === 'confirmed' && saved) return { state: 'assigned', login, assignees: saved.assignees, replayed: true }
    if (operation.status === 'conflict' && saved) return { state: 'conflict', login, assignees: saved.assignees, replayed: true }
    if (operation.status === 'operation_failed') return { state: 'failed', login, ...(saved?.httpStatus ? { httpStatus: saved.httpStatus } : {}), error: saved?.error ?? '', replayed: true }
    if (operation.status === 'sent') return finish()
    return settle()
  }
  const existing = links.operation(key, signature)
  if (existing) return replay(existing)
  // 同一张 Issue 的指派在本进程内串行：后到的请求能看到先到的账本行。
  return links.serializeOpen(`assign:${repo.toLowerCase()}#${number}`, async (): Promise<IssueAssignmentOutcome> => {
    const current = links.operation(key, signature)
    if (current) return replay(current)
    // 人可能已经改过这张 Issue 的负责人（例如移除了之前的指派）：别的请求发起过的指派不再重复写。
    if (links.otherAssignments(repo, number, key).length) return { state: 'skipped', login, reason: 'assigned_before' }
    let before: string[]
    try { before = (await readIssueAssignees(github, repo, number)).assignees } catch {
      input.assertAuthorized()
      return { state: 'skipped', login, reason: 'unreadable' }
    }
    input.assertAuthorized()
    if (before.length) return { state: 'skipped', login, reason: 'already_assigned', assignees: before }
    if (!links.planOperation({ requestKey: key, signature, fingerprint: `${ASSIGNEE_TARGET}${login.toLowerCase()}`, action: 'assigned', repo, number, url, origin: input.captureOrigin?.() })) {
      return replay(links.operation(key, signature)!)
    }
    let requestStarted = false
    let authorityLost = false
    const beforeRequest = (): void => {
      try { input.assertAuthorized() } catch (error) { authorityLost = true; throw error }
      requestStarted = true
    }
    try {
      await github.api('POST', `/repos/${repo}/issues/${number}/assignees`, { assignees: [login] }, repo.split('/')[0], beforeRequest)
    } catch (err) {
      if (authorityLost) {
        links.releaseUnsentOperation(key)
        throw err
      }
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 200)
      // 4xx（除 408 与中转的 499）是 GitHub 明确拒绝，远端没有变化；请求没发出去同样没有变化。
      const rejected = err instanceof GitHubApiError && requestStarted && err.status >= 400 && err.status < 499 && err.status !== 408
      if (!requestStarted || rejected) {
        const httpStatus = rejected ? (err as GitHubApiError).status : undefined
        links.failOperation(key, httpStatus ? `HTTP ${httpStatus}: ${message}` : `未发出：${message}`, result([], { ...(httpStatus ? { httpStatus } : {}), error: message }))
        return { state: 'failed', login, ...(httpStatus ? { httpStatus } : {}), error: message }
      }
      try { links.unknownOperation(key, message) } catch { /* 行停在 planned 同样不会重发 */ }
      return settle()
    }
    try { links.sentOperation(key, number, url) } catch { return { state: 'unknown', login } }
    return finish()
  })
}
