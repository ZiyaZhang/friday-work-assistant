/**
 * Issue 受影响人数块（部署开关 FRIDAY_ISSUE_AFFECTED_COUNT，默认 off）。
 *
 * 只对 **Friday 自己建的 Issue** 做：以本身份的建单账本为准（github_issue_operations 里 action='created' 且 POST 已返回编号），
 * 不按标题或作者猜。其他身份创建的 Issue 不由 Friday 维护该块。
 *
 * 人数：关联到这张 Issue 的全部案件（已停止跟进的除外）里，已核实的真人报告人去重后的人数。原报告、+1、独立重复在账本里
 * 都是 bug_reports 的一行 record_kind='report'；同一人只算一次，机器人、没有报告人的汇总、核实不了发送者的记录都不算。
 *
 * 正文里只有一段人数块，用 HTML 注释标记包住；没有块时追加到正文末尾，有块时只替换块内那一行，块外一字不动。
 * 保留人工修改：上次写入的内容取自同表最近一条 confirmed 行（写后回读确认过的那一行）。写前回读正文，块内与上次写入不一致、
 * 块被删掉、标记不成对或不止一处、Friday 没写过却已有块，都不写，登记一行停止记录（status='conflict'），之后这张 Issue 不再读写。
 * 人数没变不读不写。
 *
 * 写入沿用指派的做法（issues.ts 的 assignIssue）：同一张 Issue 串行；写前读取；先登记（planned）再 PATCH；发送前重验写门；
 * GitHub 明确拒绝记 operation_failed（请求没发出则撤销占位，下一轮再试）；发出后结果未知记 unknown，只读核对（IssueReconciliation），
 * 不重发；写后回读确认。
 * 同一次变化（上次写入 → 这次人数）只尝试一次：失败或核对证明没生效后，等人数再变化才写新值。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { parseIssueReference } from '../core/bugs.js'
import type { Logger } from '../log.js'
import { GitHubApiError, type GitHubIdentity } from './identity.js'
import { IssueReconciliation } from './issue-reconciliation.js'
import { VERIFIED_ABSENT, type IssueLinks, type IssueOperationRecord } from './issues.js'

export const AFFECTED_COUNT_START = '<!-- friday:affected-count -->'
export const AFFECTED_COUNT_END = '<!-- /friday:affected-count -->'
/** 轮询间隔。挂在 5 分钟一次的 GitHub 定时器上，到期才跑。 */
export const AFFECTED_COUNT_INTERVAL_MS = 10 * 60_000
/** 每轮最多处理几张需要读写 GitHub 的 Issue；其余留到下一轮。 */
export const AFFECTED_COUNT_MAX_PER_ROUND = 5
/** 首次加块至少几个人：只有一人时 Issue 本身就是那份报告。已有块之后人数怎么变就怎么改。 */
export const AFFECTED_COUNT_FIRST_MIN = 2
/** 定时器早到几毫秒时，10 分钟的间隔不会因此拖到下一个 5 分钟。 */
const DUE_SLACK_MS = 30_000
/** 飞书用户 open_id；union_id（on_）、user_id、应用 ID 不在同一个去重口径里。 */
const FEISHU_OPEN_ID = /^ou_[A-Za-z0-9_-]+$/
const OBSERVED_MAX = 200

export type AffectedCountStopReason = 'manual_edit' | 'block_removed' | 'malformed' | 'foreign_block' | 'readback_mismatch'

const STOP_TEXT: Record<AffectedCountStopReason, string> = {
  manual_edit: '人工已改，停止自动维护',
  block_removed: '人工已改，停止自动维护',
  malformed: '人数块标记不成对或不止一处，停止自动维护',
  foreign_block: '正文里已有不是 Friday 写入的人数块，停止自动维护',
  readback_mismatch: '写后回读的人数块与写入内容不一致，停止自动维护',
}

/** 块内那一行。 */
export function affectedCountLine(count: number): string {
  return `受影响人数：${count}（按飞书真人去重，Friday 自动维护）`
}

export type AffectedCountBlock =
  | { kind: 'absent' }
  /** innerStart/innerEnd：两个标记之间（不含标记）在正文里的位置；text：块内文字按 normalizeBlockText 处理后的结果 */
  | { kind: 'single'; innerStart: number; innerEnd: number; text: string }
  | { kind: 'malformed'; starts: number; ends: number }

/** 找正文里的人数块。只认完全一致的标记；恰好一个开始、一个结束且开始在前才算一块。 */
export function parseAffectedCountBlock(body: string): AffectedCountBlock {
  const starts = occurrences(body, AFFECTED_COUNT_START)
  const ends = occurrences(body, AFFECTED_COUNT_END)
  if (!starts.length && !ends.length) return { kind: 'absent' }
  const innerStart = (starts[0] ?? 0) + AFFECTED_COUNT_START.length
  const innerEnd = ends[0] ?? -1
  if (starts.length !== 1 || ends.length !== 1 || innerEnd < innerStart) return { kind: 'malformed', starts: starts.length, ends: ends.length }
  return { kind: 'single', innerStart, innerEnd, text: normalizeBlockText(body.slice(innerStart, innerEnd)) }
}

/** 块内文字的比较口径：换行统一为 \n（网页上保存会把整篇存成 \r\n），去掉首尾空白。 */
export function normalizeBlockText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim()
}

/** 把块内换成 line；没有块时追加到正文末尾（与原文之间空一行）。块外原样保留。 */
export function withAffectedCountLine(body: string, block: AffectedCountBlock, line: string): string {
  if (block.kind === 'malformed') throw new Error('人数块标记不成对或不止一处，不能改写')
  if (block.kind === 'single') return `${body.slice(0, block.innerStart)}\n${line}\n${body.slice(block.innerEnd)}`
  const separator = !body ? '' : body.endsWith('\n') ? '\n' : '\n\n'
  return `${body}${separator}${AFFECTED_COUNT_START}\n${line}\n${AFFECTED_COUNT_END}`
}

/** 账本行记下的写入目标：fingerprint = affected:<小写仓库>#<编号>:<人数>。停止记录与格式不对的行没有。 */
export function affectedCountTarget(record: Pick<IssueOperationRecord, 'action' | 'fingerprint'>): { issue: string; count: number } | undefined {
  if (record.action !== 'affected_count' || !record.fingerprint) return undefined
  const match = /^affected:(.+#[1-9]\d*):([1-9]\d*)$/.exec(record.fingerprint)
  const count = Number(match?.[2])
  return match && Number.isSafeInteger(count) ? { issue: match[1]!, count } : undefined
}

/** 按编号从配置的 GitHub API 读 Issue 正文；编号、类型（不是 PR）、链接路径对不上就抛错。body 为 null 时是空正文。 */
export async function readIssueBody(github: Pick<GitHubIdentity, 'api'>, repo: string, number: number): Promise<{ url: string; body: string }> {
  const issue = await github.api<Record<string, unknown>>('GET', `/repos/${repo}/issues/${number}`, undefined, repo.split('/')[0])
  const url = typeof issue.html_url === 'string' ? issue.html_url : ''
  let path = ''
  try { path = new URL(url).pathname.toLowerCase() } catch { /* 下面判为不一致 */ }
  if (issue.number !== number || issue.pull_request || path !== `/${repo}/issues/${number}`.toLowerCase()) throw new Error(`按编号读回的 #${number} 与请求的 Issue 不一致`)
  if (issue.body != null && typeof issue.body !== 'string') throw new Error(`#${number} 的正文不是文本`)
  return { url, body: typeof issue.body === 'string' ? issue.body : '' }
}

/**
 * 已核实的真人报告人数（去重）。只数 record_kind='report' 的行；报告人须是飞书 open_id 且不是 Friday 自己，并且宿主能核实发送者：
 * - 这条消息在消息缓存里，发送者类型是 user 且就是记下的报告人（机器人消息 sender_type=app，不算；对不上也不算）；或
 * - 消息不在缓存里（私聊消息不进缓存），但它是这个人发起的任务消息（tasks 按 message_id 与 requester_open_id 对上）。
 * 没有报告人的汇总（例如投票结果）和核实不了发送者的历史记录都不算。
 */
export function countAffectedReporters(db: DatabaseSync, bucketIds: readonly number[], botOpenId?: string): number {
  if (!bucketIds.length) return 0
  const cache = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get()
    ? db.prepare('SELECT sender_type, sender_open_id FROM messages WHERE message_id = ?') : undefined
  const task = db.prepare('SELECT 1 FROM tasks WHERE message_id = ? AND requester_open_id = ? LIMIT 1')
  const rows = db.prepare(`SELECT reporter_open_id, message_id FROM bug_reports WHERE record_kind = 'report' AND bucket_id IN (${bucketIds.map(() => '?').join(', ')}) ORDER BY id`)
    .all(...bucketIds) as { reporter_open_id: string | null; message_id: string | null }[]
  const people = new Set<string>()
  for (const row of rows) {
    const who = row.reporter_open_id
    if (!who || !FEISHU_OPEN_ID.test(who) || who === botOpenId || !row.message_id) continue
    const cached = cache?.get(row.message_id) as { sender_type: string; sender_open_id: string | null } | undefined
    if (cached ? cached.sender_type === 'user' && cached.sender_open_id === who : task.get(row.message_id, who)) people.add(who)
  }
  return people.size
}

export interface IssueAffectedCountDeps {
  db: DatabaseSync
  links: IssueLinks
  github: Pick<GitHubIdentity, 'api' | 'botLogin' | 'repoWritable'>
  /** 部署开关 FRIDAY_ISSUE_AFFECTED_COUNT；关着时 sweep 不读库、不调 GitHub。 */
  enabled: boolean
  /** Friday 自己的飞书 open_id：它发的消息不算人数。 */
  botOpenId?: string
  /** 宿主仍在调度（持有调度锁、没在关闭）；写前与发送前都查，失败直接抛出，本轮停止。 */
  assertCurrent?: () => void
  now?: () => number
  intervalMs?: number
  maxPerRound?: number
  log?: Pick<Logger, 'info' | 'warn'>
}

export interface AffectedCountSweepResult {
  /** disabled：开关关着；not_due：没到间隔；running：上一轮还没结束。 */
  skipped?: 'disabled' | 'not_due' | 'running'
  /** Friday 建的、有关联案件的 Issue。 */
  issues: number
  /** 没有要写的：人数与上次写入相同、首次不到 2 人、或这次变化已经试过。 */
  idle: number
  /** 仓库不在可写名单：不读不写。 */
  notWritable: number
  /** 之前已登记停止维护：不读不写。 */
  halted: number
  /** 本轮写入（或核对出之前的写入）并回读确认。 */
  written: number
  /** 本轮新登记停止维护。 */
  stopped: number
  /** 读不到 Issue、有未决写入仍在核对、或请求没发出（已撤销占位）：本轮不写。 */
  waiting: number
  /** 本轮写入结果未知（已记 unknown，不重发）。 */
  unknown: number
  /** GitHub 明确拒绝（记 operation_failed）。 */
  failed: number
  /** 超出本轮上限，留到下一轮。 */
  deferred: number
}

type Outcome = 'idle' | 'written' | 'stopped' | 'waiting' | 'unknown' | 'failed' | 'halted'
type Row = IssueOperationRecord & { result: string | null }
interface Candidate { key: string; repo: string; number: number; bucketIds: number[] }
interface Baseline { requestKey: string; count: number; line: string }
interface Plan { count: number; baseline?: Baseline; requestKey: string; fingerprint: string; signature: string }

export class IssueAffectedCount {
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly maxPerRound: number
  private nextRunAt?: number
  private running = false
  /** 上次处理某张 Issue 的时间；超出上限时没处理过、处理得早的先来，读不到的 Issue 不会一直占着名额。 */
  private readonly lastTried = new Map<string, number>()

  constructor(private readonly deps: IssueAffectedCountDeps) {
    this.now = deps.now ?? deps.links.now
    this.intervalMs = deps.intervalMs ?? AFFECTED_COUNT_INTERVAL_MS
    this.maxPerRound = deps.maxPerRound ?? AFFECTED_COUNT_MAX_PER_ROUND
  }

  async sweep(): Promise<AffectedCountSweepResult> {
    const result: AffectedCountSweepResult = { issues: 0, idle: 0, notWritable: 0, halted: 0, written: 0, stopped: 0, waiting: 0, unknown: 0, failed: 0, deferred: 0 }
    if (!this.deps.enabled) return { ...result, skipped: 'disabled' }
    if (this.running) return { ...result, skipped: 'running' }
    const now = this.now()
    if (this.nextRunAt !== undefined && now < this.nextRunAt) return { ...result, skipped: 'not_due' }
    this.running = true
    this.nextRunAt = now + this.intervalMs - DUE_SLACK_MS
    try {
      const due: Candidate[] = []
      for (const issue of this.candidates()) {
        result.issues++
        const rows = this.deps.links.affectedCountRecords(issue.repo, issue.number)
        if (rows.some((row) => row.status === 'conflict')) result.halted++
        else if (!this.deps.github.repoWritable(issue.repo)) result.notWritable++
        else if (!pending(rows).length && !this.plan(issue, rows)) result.idle++
        else due.push(issue)
      }
      due.sort((a, b) => (this.lastTried.get(a.key) ?? 0) - (this.lastTried.get(b.key) ?? 0) || a.key.localeCompare(b.key))
      for (const [index, issue] of due.entries()) {
        if (index >= this.maxPerRound) { result.deferred++; continue }
        this.lastTried.set(issue.key, now)
        result[await this.deps.links.serializeOpen(`affected-count:${issue.key}`, () => this.update(issue))]++
      }
      if (result.written || result.stopped || result.unknown || result.failed) this.deps.log?.info('issue affected count sweep', { ...result })
      return result
    } finally {
      this.running = false
    }
  }

  /** Friday 建的、有案件关联（未停止跟进）的 Issue；几个案件关联同一张 Issue 时合并成一项。 */
  private candidates(): Candidate[] {
    const created = new Map<string, { repo: string; number: number }>()
    for (const issue of this.deps.links.createdIssueNumbers()) created.set(`${issue.repo.toLowerCase()}#${issue.number}`, issue)
    if (!created.size) return []
    const byIssue = new Map<string, Candidate>()
    const buckets = this.deps.db.prepare("SELECT id, issue_url FROM bug_buckets WHERE issue_url IS NOT NULL AND intake_phase <> 'cancelled' ORDER BY id").all() as { id: number; issue_url: string }[]
    for (const bucket of buckets) {
      const ref = parseIssueReference(bucket.issue_url)
      const key = ref && `${ref.repo.toLowerCase()}#${ref.number}`
      const issue = key ? created.get(key) : undefined
      if (!key || !issue) continue
      const candidate = byIssue.get(key) ?? { key, repo: issue.repo, number: issue.number, bucketIds: [] }
      candidate.bucketIds.push(Number(bucket.id))
      byIssue.set(key, candidate)
    }
    return [...byIssue.values()]
  }

  /** 这一轮要不要写：人数与上次写入相同、首次不到门槛、或这次变化已经试过（失败或证明没生效）都不写。 */
  private plan(issue: Candidate, rows: readonly Row[]): Plan | undefined {
    const count = countAffectedReporters(this.deps.db, issue.bucketIds, this.deps.botOpenId)
    const base = baseline(rows)
    if (base ? count === base.count || count < 1 : count < AFFECTED_COUNT_FIRST_MIN) return undefined
    const from = base ? createHash('sha256').update(base.requestKey).digest('hex').slice(0, 12) : 'none'
    const requestKey = `affected-count:${issue.key}:${count}:${from}`
    if (rows.some((row) => row.requestKey === requestKey)) return undefined
    return { count, ...(base ? { baseline: base } : {}), requestKey, fingerprint: `affected:${issue.key}:${count}`,
      signature: createHash('sha256').update(JSON.stringify({ kind: 'affected_count', issue: issue.key, count, from })).digest('hex') }
  }

  private async update(issue: Candidate): Promise<Outcome> {
    const { links, github } = this.deps
    // ① 未决的写入先核对清楚：有结论之前不写新值，也不重发
    let confirmed = false
    for (const row of pending(links.affectedCountRecords(issue.repo, issue.number))) {
      if (row.status === 'sent') {
        const outcome = await this.finish(issue, row.requestKey)
        if (outcome !== 'written') return outcome
        confirmed = true
        continue
      }
      const receipt = await new IssueReconciliation(github, links).reconcile(row.requestKey, {})
      if (receipt.result === 'confirmed') confirmed = true
      else if (receipt.result !== 'verified_absent') return 'waiting'
    }
    const rows = links.affectedCountRecords(issue.repo, issue.number)
    if (rows.some((row) => row.status === 'conflict')) return 'halted'
    const plan = this.plan(issue, rows)
    if (!plan) return confirmed ? 'written' : 'idle'
    // ② 写前读取：块内必须还是上次写入的内容
    this.assertWritable(issue.repo)
    let read: { url: string; body: string }
    try { read = await readIssueBody(github, issue.repo, issue.number) } catch (error) {
      this.deps.log?.warn('issue affected count read failed', { repo: issue.repo, number: issue.number, error: message(error) })
      return 'waiting'
    }
    this.assertWritable(issue.repo)
    const block = parseAffectedCountBlock(read.body)
    if (block.kind === 'malformed') return this.stop(issue, read.url, 'malformed', { starts: block.starts, ends: block.ends })
    if (plan.baseline) {
      if (block.kind === 'absent') return this.stop(issue, read.url, 'block_removed', { expected: plan.baseline.line })
      if (block.text !== normalizeBlockText(plan.baseline.line)) return this.stop(issue, read.url, 'manual_edit', { expected: plan.baseline.line, observed: block.text })
    } else if (block.kind === 'single') return this.stop(issue, read.url, 'foreign_block', { observed: block.text })
    const line = affectedCountLine(plan.count)
    const body = withAffectedCountLine(read.body, block, line)
    // ③ 先登记再发送
    if (!links.planOperation({ requestKey: plan.requestKey, signature: plan.signature, action: 'affected_count', repo: issue.repo, fingerprint: plan.fingerprint, number: issue.number, url: read.url })) return 'waiting'
    let requestStarted = false
    let authorityLost = false
    const beforeRequest = (): void => {
      try { this.assertWritable(issue.repo) } catch (error) { authorityLost = true; throw error }
      requestStarted = true
    }
    try {
      await github.api('PATCH', `/repos/${issue.repo}/issues/${issue.number}`, { body }, issue.repo.split('/')[0], beforeRequest)
    } catch (err) {
      if (authorityLost) {
        links.releaseUnsentOperation(plan.requestKey)
        throw err
      }
      const text = message(err).slice(0, 200)
      // 请求没发出去（例如换令牌失败）：远端没有变化，撤销占位，下一轮照常再试。
      if (!requestStarted) {
        links.releaseUnsentOperation(plan.requestKey)
        this.deps.log?.warn('issue affected count not sent', { repo: issue.repo, number: issue.number, error: text })
        return 'waiting'
      }
      // 4xx（除 408 与中转的 499）是 GitHub 明确拒绝，正文没有变化；同一次变化不再试，人数再变时才写新值。
      if (err instanceof GitHubApiError && err.status >= 400 && err.status < 499 && err.status !== 408) {
        links.settleAffectedCount(plan.requestKey, ['planned'], { status: 'operation_failed', error: `HTTP ${err.status}: ${text}`,
          result: { repo: issue.repo, number: issue.number, url: read.url, count: plan.count, httpStatus: err.status } })
        return 'failed'
      }
      try { links.unknownOperation(plan.requestKey, text) } catch { /* 行停在 planned 同样不会重发 */ }
      const receipt = await new IssueReconciliation(github, links).reconcile(plan.requestKey, {})
      return receipt.result === 'confirmed' ? 'written' : 'unknown'
    }
    try { links.sentOperation(plan.requestKey, issue.number, read.url) } catch { return 'unknown' }
    // ④ 写后回读
    return this.finish(issue, plan.requestKey)
  }

  /** 已发出（sent）的写入：回读块内容，是这次写的就确认；不是就登记停止（发出后有人改了块）；读不到留到下一轮，不重发。 */
  private async finish(issue: Candidate, requestKey: string): Promise<'written' | 'stopped' | 'waiting'> {
    const { links, github } = this.deps
    const row = links.affectedCountRecords(issue.repo, issue.number).find((record) => record.requestKey === requestKey)
    const target = row && affectedCountTarget(row)
    if (!target) return 'waiting'
    let read: { url: string; body: string }
    try { read = await readIssueBody(github, issue.repo, issue.number) } catch { return 'waiting' }
    const line = affectedCountLine(target.count)
    const block = parseAffectedCountBlock(read.body)
    if (block.kind === 'single' && block.text === normalizeBlockText(line)) {
      const saved = links.settleAffectedCount(requestKey, ['sent'], { status: 'confirmed', error: null,
        result: { repo: issue.repo, number: issue.number, url: read.url, count: target.count, block: line } })
      return saved ? 'written' : 'waiting'
    }
    const observed = (block.kind === 'single' ? block.text : block.kind).slice(0, OBSERVED_MAX)
    links.settleAffectedCount(requestKey, ['sent'], { status: 'conflict', error: STOP_TEXT.readback_mismatch, result: { reason: 'readback_mismatch', expected: line, observed } })
    this.deps.log?.info('issue affected count stopped', { repo: issue.repo, number: issue.number, reason: 'readback_mismatch' })
    return 'stopped'
  }

  /** 登记停止维护（每张 Issue 一行 status='conflict'），之后这张 Issue 不再读写。 */
  private stop(issue: Candidate, url: string, reason: AffectedCountStopReason, detail: { expected?: string; observed?: string; starts?: number; ends?: number }): 'stopped' {
    const requestKey = `affected-count-stop:${issue.key}`
    this.deps.links.stopAffectedCount({ requestKey, signature: createHash('sha256').update(requestKey).digest('hex'), fingerprint: `affected:${issue.key}:stop`,
      repo: issue.repo, number: issue.number, url, error: STOP_TEXT[reason],
      result: { reason, ...detail, ...(detail.observed === undefined ? {} : { observed: detail.observed.slice(0, OBSERVED_MAX) }) } })
    this.deps.log?.info('issue affected count stopped', { repo: issue.repo, number: issue.number, reason })
    return 'stopped'
  }

  /** 写门：开关开着、宿主仍在调度（调度锁、没在关闭）、仓库仍在可写名单。 */
  private assertWritable(repo: string): void {
    if (!this.deps.enabled) throw new Error('受影响人数块已关闭（FRIDAY_ISSUE_AFFECTED_COUNT）')
    this.deps.assertCurrent?.()
    if (!this.deps.github.repoWritable(repo)) throw new Error(`${repo} 不在可写仓库名单（FRIDAY_GITHUB_WRITE_REPOS）里`)
  }
}

/** 还没有结论的写入：planned/unknown（没被核对证明没生效），或 sent（已发出，待回读）。 */
function pending(rows: readonly Row[]): Row[] {
  return rows.filter((row) => row.status === 'sent' || ((row.status === 'planned' || row.status === 'unknown') && row.error !== VERIFIED_ABSENT))
}

/** 上次写入并回读确认的内容：最近一条 confirmed 行；result 解析不了的行不当基线。 */
function baseline(rows: readonly Row[]): Baseline | undefined {
  for (const row of [...rows].reverse()) {
    if (row.status !== 'confirmed' || !row.result) continue
    try {
      const saved = JSON.parse(row.result) as { count?: unknown; block?: unknown }
      if (typeof saved.block === 'string' && typeof saved.count === 'number' && Number.isSafeInteger(saved.count)) return { requestKey: row.requestKey, count: saved.count, line: saved.block }
    } catch { /* 跳过 */ }
  }
  return undefined
}

function occurrences(text: string, marker: string): number[] {
  const found: number[] = []
  for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + marker.length)) found.push(at)
  return found
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
