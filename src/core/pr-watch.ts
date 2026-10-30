/**
 * 盯住 Friday 自己开的 PR。
 *
 * 常驻网关定期轮询 PR 状态，处理通知和 review 升级提醒。
 *
 * 只盯**自己开的**那些：`github_changes` 里有 pr_number 的行。
 * 它们的受众是现成的（哪个会话开的就回哪个会话），不需要额外配通知群，
 * 也不会去播报全仓库的动静——那是另一件事，要先有"发到哪个群"的配置。
 *
 * 说什么、不说什么：
 * - **已合并 / 被关掉**：说。事情结了，不说人不知道。
 * - **就绪太久没人 review**：说。这正是"提了 PR 然后石沉大海"的那个洞。
 * - **第一档提醒过还是没人看、就绪满第二档阈值**：升级一次，提醒对象换成空间负责人（`review_escalated`）。
 * - **合并之后进了某个发布版本**：再说一次"已进入 vX"（`released`）。合并不等于发布，这句才是发布。
 * - **就绪本身**：不说。那是模型刚调完 `github_pr_ready` 在对话里说的，这里再说一遍是复读。
 *
 * 每种话对每个 PR 只说一次，靠 `github_pr_notices` 保证——不是靠记得，是靠写下来。
 * `kind` 是 TEXT 没有 CHECK：加新话不用改表。
 */
import type { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS github_pr_notices (
  change_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  noticed_at INTEGER NOT NULL,
  PRIMARY KEY (change_id, kind)
);
`

export type PrNoticeKind = 'merged' | 'closed' | 'review_overdue' | 'review_escalated' | 'released'

/** 包含这个 PR 的最早发布版本（由调用方用 releases.ts 查出来） */
export interface ReleaseHit {
  tag: string
  url: string | null
  publishedAt: string | null
  prerelease: boolean
}

/** 一次该说的话。`kind` 同时是去重键。 */
export interface PrNotice {
  changeId: string
  kind: PrNoticeKind
  repo: string
  number: number
  url: string
  sessionKey: string
  requesterOpenId: string
  text: string
  /** 只有 `released` 带 */
  release?: ReleaseHit
}

export interface DecideOptions {
  /** 第二档：就绪满这么久还没人 review 就升级给空间负责人；<= 0 或不传 = 不升级 */
  escalateMs?: number
  /** 合并之后：包含它的发布版本；null / 不传 = 没查到或没查 */
  release?: ReleaseHit | null
}

/** 合并提醒过之后盯多久等它进发布版本：过了这个窗口还没进就不再盯（每轮轮询都要读 GitHub，不能无限期） */
export const MERGED_WATCH_MS = 30 * 24 * 3600_000

export interface WatchedChange {
  id: string
  sessionKey: string
  requesterOpenId: string
  repo: string
  prNumber: number
  prUrl: string | null
}

export interface PrSnapshot {
  merged: boolean
  closed: boolean
  draft: boolean
  url: string
  /** 已经有人提交过 review 没有（含 approve / request changes / comment） */
  reviewed: boolean
  /** 合并提交（查"进了哪个版本"用）；未合并或读不到为 null */
  mergeCommitSha?: string | null
  /** 合并时刻（毫秒）；合并之前发布的版本不用比 */
  mergedAt?: number | null
}

export class PrWatch {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {
    db.exec(SCHEMA)
  }

  /**
   * 自己开的、还值得盯的 PR：有编号，没说过"被关掉"或"已进入发布版本"，
   * 说过"已合并"的只在 `mergedWatchMs` 窗口内继续盯（等它进版本）。
   */
  pending(limit = 50, mergedWatchMs = MERGED_WATCH_MS): WatchedChange[] {
    const rows = this.db.prepare(`
      SELECT c.id, c.session_key, c.requester_open_id, c.repo, c.pr_number, c.pr_url
      FROM github_changes c
      WHERE c.pr_number IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM github_pr_notices n WHERE n.change_id = c.id AND n.kind IN ('closed','released'))
        AND NOT EXISTS (SELECT 1 FROM github_pr_notices n WHERE n.change_id = c.id AND n.kind = 'merged' AND n.noticed_at <= ?)
      ORDER BY c.updated_at DESC LIMIT ?`).all(this.now() - Math.max(0, mergedWatchMs), limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id), sessionKey: String(r.session_key), requesterOpenId: String(r.requester_open_id),
      repo: String(r.repo), prNumber: Number(r.pr_number), prUrl: r.pr_url === null ? null : String(r.pr_url),
    }))
  }

  /** 说过了没有。 */
  said(changeId: string, kind: PrNoticeKind): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM github_pr_notices WHERE change_id = ? AND kind = ?').get(changeId, kind))
  }

  /**
   * 记下"这句说过了"。**先记再发**：宁可漏一条，也不要因为发送重试把同一句话说两遍。
   * 返回 false 表示别人已经记过了，这次不要发。
   */
  claim(changeId: string, kind: PrNoticeKind): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO github_pr_notices (change_id, kind, noticed_at) VALUES (?, ?, ?)')
      .run(changeId, kind, this.now()).changes) > 0
  }

  /** 第一次看见它就绪是什么时候（用自己的观察时间，不假装知道 GitHub 上的精确时刻）。 */
  markReadySeen(changeId: string): number {
    const row = this.db.prepare("SELECT noticed_at FROM github_pr_notices WHERE change_id = ? AND kind = 'ready_seen'").get(changeId) as { noticed_at?: number } | undefined
    if (row?.noticed_at) return Number(row.noticed_at)
    const at = this.now()
    this.db.prepare("INSERT OR IGNORE INTO github_pr_notices (change_id, kind, noticed_at) VALUES (?, 'ready_seen', ?)").run(changeId, at)
    return at
  }

  /** 值不值得去 GitHub 查"进了哪个版本"：合并这句说过了、"已进入"还没说。查是要花请求的，不是每个 PR 每轮都查。 */
  needsReleaseCheck(change: WatchedChange, snapshot: PrSnapshot): boolean {
    return snapshot.merged && this.said(change.id, 'merged') && !this.said(change.id, 'released')
  }

  /**
   * "已进入"的起点：这个版本第一次巡查的时刻，持久在 kv，重启不变。
   * 发布在它之前的版本包含了某个 PR，那是部署前就发生过的事，"已进入"只记不发（一次性回填），不当新闻说一遍。
   */
  releaseNoticeBoundary(): number {
    const row = this.db.prepare("SELECT v FROM kv WHERE k = 'pr-release-notice-boundary'").get() as { v: string } | undefined
    if (row) return Number(row.v)
    const at = this.now()
    this.db.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES ('pr-release-notice-boundary', ?)").run(String(at))
    return at
  }

  /**
   * 这个 PR 现在该说哪句话（或者什么都不说）。
   *
   * `overdueMs` 是"就绪之后多久还没人看就提醒一次"（第一档）。用**我第一次看见它就绪**起算，
   * 措辞上也照实说是"我看到"，不冒充知道 GitHub 上的精确时刻。
   * `opts.escalateMs` 是第二档：第一档说过之后还是没人看、就绪满这么久，再升级一次。
   * `opts.release` 是合并之后查到的发布版本：合并这句说过之后，说一次"已进入"。
   */
  decide(change: WatchedChange, snapshot: PrSnapshot, overdueMs: number, opts: DecideOptions = {}): PrNotice | undefined {
    const base = { changeId: change.id, repo: change.repo, number: change.prNumber, url: snapshot.url || change.prUrl || '',
      sessionKey: change.sessionKey, requesterOpenId: change.requesterOpenId }
    if (snapshot.merged) {
      if (!this.said(change.id, 'merged')) {
        return { ...base, kind: 'merged', text: `PR #${change.prNumber} 已合并。${base.url}\n（合并不等于发布——要回答"我升级就行了吗"，得查它进了哪个版本。）` }
      }
      // 合并这句说过之后才说"已进入"：两句分开，一轮一句
      const release = opts.release
      if (!release || this.said(change.id, 'released')) return undefined
      const label = release.prerelease ? `${release.tag}（预览版）` : release.tag
      return { ...base, kind: 'released', release,
        text: `PR #${change.prNumber} 已进入 ${label}。${release.url ?? base.url}` }
    }
    if (snapshot.closed) {
      return this.said(change.id, 'closed') ? undefined
        : { ...base, kind: 'closed', text: `PR #${change.prNumber} 被关掉了，没有合并。${base.url}` }
    }
    if (snapshot.draft) return undefined // 还没就绪，本来就没人该看
    const readyAt = this.markReadySeen(change.id)
    // overdueMs <= 0 = 关掉这条提醒。**不能当成"立刻提醒"**——0 在配置里一向是"不做"，
    // 把它读成"马上做"会让一个想关掉它的人收到最吵的结果。第一档关着时第二档也不升级。
    if (overdueMs <= 0 || snapshot.reviewed) return undefined
    const waited = this.now() - readyAt
    const hours = Math.max(1, Math.round(waited / 3600_000))
    if (!this.said(change.id, 'review_overdue')) {
      if (waited < overdueMs) return undefined
      return { ...base, kind: 'review_overdue',
        text: `PR #${change.prNumber} 就绪 ${hours} 小时了，还没有人 review。${base.url}\n要我去催谁，说一声就行。` }
    }
    // 第二档：只在第一档说过之后。escalateMs <= 0 同样是"不做"。
    const escalateMs = opts.escalateMs ?? 0
    if (escalateMs <= 0 || this.said(change.id, 'review_escalated') || waited < escalateMs) return undefined
    return { ...base, kind: 'review_escalated',
      text: `PR #${change.prNumber} 就绪 ${hours} 小时了，提醒过一次之后还是没有人 review。${base.url}\n请负责人安排一下 review，或者指定 reviewer。` }
  }
}
