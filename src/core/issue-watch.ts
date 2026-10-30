/**
 * 没人接的 issue，别让它一直躺着。
 *
 * 排期里这条写的是「一天无人认领 + 无关联 PR + 允许名单 + 接单规则」。
 * 但「无人认领」这四个字最容易做错：assignee 是空的，不等于没人在做——
 * 有人在评论里说了「我来」，有人已经开了分支，都不会体现在 assignee 上。
 * 照着空字段就去接单，是从同事手里抢活。
 *
 * 所以这里**不判断「没人认领」**，只判断「值不值得问一句」，然后把看到的事实摆出来让人定：
 * 开了多少天、有没有 assignee、有没有关联 PR、最后一次有人说话是什么时候。
 * 每一句都指着一个日期或一个空字段——和 PMO 那两列同一条规矩：观察是挣来的，判断是人的。
 *
 * 接单本身仍然走原来那条路：人说一声「你接」，模型去开 PR，开 PR 照样弹确认卡片。
 * 这里一行代码都不碰写操作——一个定时任务自己决定改别人的仓库，是不该存在的东西。
 *
 * 还有一条是为了**绑定当天不炸群**：只看「在我盯着的这段时间里安静下来」的 issue。
 * 一个仓库积压两百条陈年 issue，绑定的那一刻全播一遍，等于把这个功能第一次就用废。
 * 起算点记在绑定里；谁在老 issue 下面留了新评论，它自然重新进入视野。
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS github_issue_notices (
  space_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  noticed_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, repo, number, kind)
);
CREATE TABLE IF NOT EXISTS github_issue_assessments (
  space_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  identity TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  status TEXT NOT NULL,
  retry_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, repo, number)
);
`

export interface IssueAssessmentAttempt {
  spaceId: string; repo: string; number: number; identity: string; attemptId: string
}

/** 一个空间盯一个仓库。没有绑定就什么都不做——不知道说给谁听的话不要说。 */
export interface IssueWatchBinding {
  spaceId: string
  boundBy: string
  repo: string
  /** 从这一刻起盯；更早就没动静的陈年 issue 不翻出来。 */
  since: number
  /** 接单规则：只看带这些标签的；空数组表示不限。 */
  labels: string[]
  /** 新绑定使用新版本；旧扫描不能跨过关闭再开启的边界。 */
  version?: string
}

/** GitHub 那边现在的样子，只取判断用得上的部分。 */
export interface IssueSnapshot {
  number: number
  title: string
  url: string
  /** PR 也会从 /issues 出来，必须能认出来 */
  isPullRequest: boolean
  state: 'open' | 'closed'
  assignees: string[]
  labels: string[]
  createdAt: number
  /** GitHub 的 updated_at：有人评论、改标签、改标题都会动 */
  updatedAt: number
  /** 有没有已经关联上的 PR（时间线里的 cross-reference / closing keyword） */
  linkedPullRequests: number
  /** 最后一条评论的时间；没有评论就是 undefined */
  lastCommentAt?: number
  /** 最后说话的人是不是 Friday 自己——它自己的留言不算"有人在跟进" */
  lastCommentByBot?: boolean
  /** 已完整核验评论后，最近一次真人回复；最后一条是 bot 时仍保留前面的真人回复。 */
  lastHumanCommentAt?: number
}

export interface IssueNotice {
  spaceId: string
  repo: string
  number: number
  kind: 'unclaimed'
  url: string
  title: string
  text: string
  /** 这是"又安静下来了"的第二次问，不是第一次。占位时要用 claim(..., { again: true })。 */
  again?: boolean
  /** 生成这条提醒时看到的旧占位，用于原子竞争，不能无条件覆盖。 */
  previousNoticeAt?: number
}

/** 不问的理由。留着是为了能解释「为什么它没提这条」，而不是只看到一片安静。 */
export type SkipReason =
  | 'pull_request' | 'closed' | 'assigned' | 'linked_pr' | 'label_mismatch'
  | 'quiet_before_watch' | 'too_fresh' | 'already_asked' | 'watch_disabled'

export interface IssueDecision {
  notice?: IssueNotice
  skip?: SkipReason
}

const DAY = 24 * 3600_000

function days(ms: number): number {
  return Math.max(1, Math.round(ms / DAY))
}

export class IssueWatch {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {
    db.exec(SCHEMA)
  }

  /** Reserve model cost before dispatch. A lost result gets the same bounded backoff as an explicit failure. */
  claimAssessment(spaceId: string, repo: string, number: number, identity: string): IssueAssessmentAttempt | undefined {
    const now = this.now(), attemptId = randomUUID()
    const result = this.db.prepare(`INSERT INTO github_issue_assessments
      (space_id, repo, number, identity, attempt_id, attempts, status, retry_at)
      VALUES (?, ?, ?, ?, ?, 1, 'pending', ?)
      ON CONFLICT(space_id, repo, number) DO UPDATE SET
        identity = excluded.identity, attempt_id = excluded.attempt_id,
        attempts = CASE WHEN github_issue_assessments.identity = excluded.identity THEN github_issue_assessments.attempts + 1 ELSE 1 END,
        status = 'pending',
        retry_at = CASE WHEN github_issue_assessments.identity = excluded.identity THEN ? ELSE excluded.retry_at END
      WHERE github_issue_assessments.identity <> excluded.identity OR
        (github_issue_assessments.status IN ('pending', 'failed') AND github_issue_assessments.attempts < 3 AND github_issue_assessments.retry_at <= ?)`)
      .run(spaceId, repo, number, identity, attemptId, now + 3600_000, now + 6 * 3600_000, now)
    return Number(result.changes) ? { spaceId, repo, number, identity, attemptId } : undefined
  }

  /** Only the exact admitted snapshot/attempt can settle itself; late results cannot overwrite a replacement. */
  finishAssessment(attempt: IssueAssessmentAttempt, completed: boolean): void {
    this.db.prepare(`UPDATE github_issue_assessments SET status = ?
      WHERE space_id = ? AND repo = ? AND number = ? AND identity = ? AND attempt_id = ? AND status = 'pending'`)
      .run(completed ? 'done' : 'failed', attempt.spaceId, attempt.repo, attempt.number, attempt.identity, attempt.attemptId)
  }

  /** 问过了没有。 */
  asked(spaceId: string, repo: string, number: number): boolean {
    return this.askedAt(spaceId, repo, number) !== undefined
  }

  /** 上一次问是什么时候；没问过就是 undefined。 */
  askedAt(spaceId: string, repo: string, number: number): number | undefined {
    const r = this.db.prepare("SELECT noticed_at FROM github_issue_notices WHERE space_id = ? AND repo = ? AND number = ? AND kind = 'unclaimed'")
      .get(spaceId, repo, number) as { noticed_at?: number } | undefined
    return r?.noticed_at === undefined ? undefined : Number(r.noticed_at)
  }

  /**
   * 记下"这条问过了"。**先记再发**——发送重试把同一句问两遍，比漏一条难受得多。
   * 返回 false 表示别人已经记过了，这次别发。
   */
  claim(spaceId: string, repo: string, number: number, opts: { again?: boolean; previousNoticeAt?: number } = {}): boolean {
    if (opts.again) {
      // 新的一轮沉寂，把时间戳往前推。不是"再问一遍同一件事"，
      // 是"上次问完之后有人说了话，然后又安静了这么久"——那是一件新的事实。
      if (!Number.isFinite(opts.previousNoticeAt)) return false
      const previous = opts.previousNoticeAt!
      return Number(this.db.prepare("UPDATE github_issue_notices SET noticed_at = ? WHERE space_id = ? AND repo = ? AND number = ? AND kind = 'unclaimed' AND noticed_at = ?")
        .run(Math.max(this.now(), previous + 1), spaceId, repo, number, previous).changes) > 0
    }
    return Number(this.db.prepare("INSERT OR IGNORE INTO github_issue_notices (space_id, repo, number, kind, noticed_at) VALUES (?, ?, ?, 'unclaimed', ?)")
      .run(spaceId, repo, number, this.now()).changes) > 0
  }

  /**
   * 这条 issue 现在值不值得问一句。
   *
   * `overdueMs` 是"安静多久就问一句"。`<= 0` 是**关掉**，不是"立刻问"——
   * 0 在配置里一向是"不做"，读成"马上做"会让一个想关掉它的人收到最吵的结果。
   */
  decide(binding: IssueWatchBinding, issue: IssueSnapshot, overdueMs: number): IssueDecision {
    if (overdueMs <= 0) return { skip: 'watch_disabled' }
    // /issues 会把 PR 一起返回。不认出来的话，Friday 会对着自己刚开的 PR 问"这个没人接吗"。
    if (issue.isPullRequest) return { skip: 'pull_request' }

    // 下面这三件事是**三个不同的状态**，不是一个。
    // 以前它们在代码里长得一模一样——都只是 skip——于是「有人说了句话」
    // 和「有人真的接手了」变得没有区别，而没有区别就意味着：
    // 谁在底下回一句「我也遇到了」，Friday 就当这件事有人管了，从此不再提。
    //
    //   事情解决了 → 关掉了。真的结束。
    //   有人接手了 → 有 assignee，或者已经有 PR 在做。别去打扰。
    //   有人说话了 → 只说明它还活着。**不代表有人在做。**
    //
    // 前两个是终局，第三个不是——它只是让"安静"重新计时。
    if (issue.state !== 'open') return { skip: 'closed' }
    if (issue.assignees.length) return { skip: 'assigned' }
    if (issue.linkedPullRequests > 0) return { skip: 'linked_pr' }
    if (binding.labels.length && !issue.labels.some((l) => binding.labels.includes(l))) return { skip: 'label_mismatch' }

    // 最后一次有人动它是什么时候：评论优先，没有评论就用 updated_at。
    // Friday 自己的留言不算——不然它问完一句，就把自己那句当成"有人在跟进"。
    const lastHumanComment = issue.lastHumanCommentAt
      ?? (issue.lastCommentAt !== undefined && !issue.lastCommentByBot ? issue.lastCommentAt : undefined)
    // updated_at 也会被机器人留言抬高，不能拿它证明有人回复过。
    const lastHuman = lastHumanComment !== undefined ? Math.max(lastHumanComment, issue.createdAt)
      : issue.lastCommentByBot ? issue.createdAt : Math.max(issue.updatedAt, issue.createdAt)

    // 问过一次不是终局。
    //
    // 原来是：问过就永远不再问。听起来克制，实际后果是——有人在底下回了句
    // 「我看看」，然后一个月没动静，Friday 全程沉默，因为它"已经问过了"。
    // 那正好是最该再问一句的情形。
    //
    // 所以判据换成：上次问完之后**有人说过话**（说明它还活着，但仍然没人接手），
    // 而且从那以后又安静了整整一个窗口。那是一件新的事实，不是把同一句重复一遍。
    // 反过来，问完之后一点动静都没有，就闭嘴。
    const askedAt = this.askedAt(binding.spaceId, binding.repo, issue.number)
    const again = askedAt !== undefined
    if (again && (lastHumanComment === undefined || lastHumanComment <= askedAt)) return { skip: 'already_asked' }

    // 绑定之前就已经安静的陈年 issue 不翻出来：绑定当天不该炸群。
    if (lastHuman < binding.since) return { skip: 'quiet_before_watch' }
    const quiet = this.now() - lastHuman
    if (quiet < overdueMs) return { skip: 'too_fresh' }

    const facts = [
      `开了 ${days(this.now() - issue.createdAt)} 天`,
      '没有 assignee',
      '没有关联 PR',
      lastHumanComment !== undefined ? `最后一次有人说话是 ${days(quiet)} 天前`
        : issue.lastCommentAt === undefined ? '一条评论都没有' : '目前只看到机器人评论，尚不能据此确认有人跟进',
    ]
    // 再问的时候说清楚"上次问过之后有人说过话"——
    // 否则看起来像在重复同一句，而事实上中间确实发生了事情，只是没人接手。
    const lead = again ? `上次问过之后有人说过话，但仍未设置 assignee 或关联 PR：` : ''
    return {
      notice: {
        spaceId: binding.spaceId, repo: binding.repo, number: issue.number, kind: 'unclaimed', again, previousNoticeAt: askedAt,
        url: issue.url, title: issue.title,
        // 只说看得见的，不替人下"没人认领"这个结论——有人在评论里说过"我来"是看不出来的。
        text: `${lead}${binding.repo}#${issue.number}「${issue.title}」${facts.join('、')}。${issue.url}\n`
          + '要我接就说一声，我去看一眼再动手；已经有人在做的话，跟我说是谁，我就不提了。',
      },
    }
  }
}
