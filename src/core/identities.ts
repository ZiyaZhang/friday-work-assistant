/**
 * 人的身份映射：GitHub 登录名 ↔ 飞书里的显示名。
 *
 * open_id 有两个来源，优先级不同：
 * - **成员对照表的人员字段**（飞书 type 11）：人亲手挑的飞书账号，最准，`source='roster'`；
 * - 运行时按姓名在群成员里撞出来的：次之，只当下次消歧的线索。
 * 无论哪种，**要 @ 的那一刻仍须在当前群成员集合里验证一遍**——存下来的只是线索，不是成员证明。
 * 这套仍然**不依赖通讯录权限**：对照表是普通多维表格，群成员列表是本来就有的能力。
 *
 * 事实源是飞书那张多维表格（Friday 自己定时读，见 identity-directory.ts）；
 * data/members.tsv 只是没配对照表时的兜底种子，装好那天就开始过期。
 * 身份映射保持单一事实源，避免多处复制后更新不一致。
 */
import { existsSync, readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

export interface Identity {
  githubLogin: string
  displayName: string
  /** 曾匹配过的身份线索；每次 @ 仍须在当前群成员集合中验证，不能单独作为成员证明。 */
  openId: string | null
  source: string
  updatedAt: number
}

/** 解析结果。**没有"猜"这一档**：要么确定，要么明说不知道。 */
export type Resolution =
  | { kind: 'resolved'; login: string; name: string; openId: string }
  | { kind: 'name-only'; login: string; name: string }
  | { kind: 'ambiguous'; login: string; name: string }
  | { kind: 'unknown'; login: string }

/** 成员对照表里的一行：GitHub 登录名、姓名，以及人员字段给出的 open_id（可能没填）。 */
export interface RosterRow {
  login: string
  name: string
  openId?: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS identities (
  github_login TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  open_id TEXT,
  source TEXT NOT NULL DEFAULT 'seed',
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identities_login ON identities(lower(github_login));
CREATE INDEX IF NOT EXISTS idx_identities_name ON identities(display_name);
`

export class Identities {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA)
  }

  /**
   * 从 TSV 种子文件导入。已有的行**不覆盖 open_id**（那是运行时查到的，比种子新）。
   * 姓名以种子为准：表格是 SoT，人改了名字应该跟着变。
   */
  seedFrom(path: string, nowMs = Date.now()): number {
    if (!existsSync(path)) return 0
    let n = 0
    for (const raw of readFileSync(path, 'utf-8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const [login, name] = line.split('\t').map((s) => s?.trim())
      if (!login || !name) continue
      this.db
        .prepare(
          `INSERT INTO identities (github_login, display_name, open_id, source, updated_at) VALUES (?, ?, NULL, 'seed', ?)
           ON CONFLICT(github_login) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
        )
        .run(login, name, nowMs)
      n += 1
    }
    return n
  }

  /**
   * 从成员对照表写入。表格是事实源，所以姓名**和 open_id 都以它为准**——
   * 这跟 `seedFrom` 不一样：种子文件里没有 open_id，运行时查到的比它新；
   * 而对照表里的人员字段是人亲手挑的飞书账号，比我们靠姓名撞出来的准。
   * 表里没填人员字段的行不清空已有 open_id：宁可留着旧的可用值，也不要把能 @ 的人变成不能 @。
   */
  upsertFromRoster(rows: readonly RosterRow[], nowMs = Date.now()): number {
    let n = 0
    for (const row of rows) {
      const login = row.login.trim()
      const name = row.name.trim()
      if (!login || !name) continue
      if (row.openId) {
        this.db.prepare(
          `INSERT INTO identities (github_login, display_name, open_id, source, updated_at) VALUES (?, ?, ?, 'roster', ?)
           ON CONFLICT(github_login) DO UPDATE SET display_name = excluded.display_name,
             open_id = excluded.open_id, source = 'roster', updated_at = excluded.updated_at`,
        ).run(login, name, row.openId, nowMs)
      } else {
        this.db.prepare(
          `INSERT INTO identities (github_login, display_name, open_id, source, updated_at) VALUES (?, ?, NULL, 'roster', ?)
           ON CONFLICT(github_login) DO UPDATE SET display_name = excluded.display_name,
             source = 'roster', updated_at = excluded.updated_at`,
        ).run(login, name, nowMs)
      }
      n += 1
    }
    return n
  }

  byLogin(login: string): Identity | undefined {
    const r = this.db.prepare('SELECT * FROM identities WHERE lower(github_login) = lower(?)').get(login.trim()) as Record<string, unknown> | undefined
    return r ? toIdentity(r) : undefined
  }

  byName(name: string): Identity[] {
    const rows = this.db.prepare('SELECT * FROM identities WHERE display_name = ?').all(name.trim()) as Record<string, unknown>[]
    return rows.map(toIdentity)
  }

  /** 明确匹配后保留 open_id 供下次消歧；下次仍须读取目标群成员。 */
  rememberOpenId(login: string, openId: string, nowMs = Date.now()): void {
    this.db.prepare('UPDATE identities SET open_id = ?, updated_at = ? WHERE lower(github_login) = lower(?)').run(openId, nowMs, login.trim())
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) c FROM identities').get() as { c: number }).c)
  }

  all(): Identity[] {
    return (this.db.prepare('SELECT * FROM identities ORDER BY display_name').all() as Record<string, unknown>[]).map(toIdentity)
  }

  /**
   * GitHub 登录名 → 这个群里能 @ 的那个人。
   *
   * `members` 必须由调用者取得目标群的当前成员；本方法不能验证其新鲜度。
   * 姓名只在身份表和本群都唯一时匹配；已有 open_id 必须仍在本群，不能回退到另一个同名人。
   *   resolved  → 可以 @
   *   name-only → 知道名字，但没有确认本群成员资格：写名字，不 @
   *   ambiguous → 同名或已知身份与本群名字冲突：不能确定，不 @
   *   unknown   → 表里没有这个登录名：**照实说不知道，绝不按感觉猜**
   */
  resolveForChat(login: string, members: { name: string; openId: string }[]): Resolution {
    const clean = login.trim().replace(/^@/, '')
    if (!clean) return { kind: 'unknown', login }
    const id = this.byLogin(clean)
    if (!id) return { kind: 'unknown', login: clean }
    const person = { login: id.githubLogin, name: id.displayName }
    const named = members.filter((m) => m.name.trim() === id.displayName)
    const knownOpenId = id.openId?.trim()
    if (knownOpenId) {
      if (members.some((m) => m.openId.trim() === knownOpenId)) return { kind: 'resolved', ...person, openId: knownOpenId }
      // 原身份不在本群时，同名者也不能代替他；不能把跨群缓存直接做成 @。
      return { kind: named.length ? 'ambiguous' : 'name-only', ...person }
    }
    if (!named.length) return { kind: 'name-only', ...person }
    const openIds = new Set(named.map((m) => m.openId.trim()))
    if (openIds.has('')) return { kind: 'name-only', ...person }
    if (openIds.size !== 1 || this.byName(id.displayName).length !== 1) return { kind: 'ambiguous', ...person }
    return { kind: 'resolved', ...person, openId: [...openIds][0]! }
  }

  /** 非 resolved 结果均不能产生 mention；“查不到”不等于断言此人不在群中。 */
  static describe(r: Resolution): string {
    if (r.kind === 'resolved') return `<at open_id="${r.openId}"></at>`
    if (r.kind === 'name-only') return `${r.name}（GitHub \`${r.login}\`，未能确认他是当前群成员，暂不 @）`
    if (r.kind === 'ambiguous') return `${r.name}（GitHub \`${r.login}\`，存在同名或身份映射冲突，无法确定当前群里是哪位，不能直接 @）`
    return `这块最近是 GitHub 账号 \`${r.login}\` 改的，但我不知道他在飞书里是谁`
  }
}

function toIdentity(r: Record<string, unknown>): Identity {
  return {
    githubLogin: String(r.github_login),
    displayName: String(r.display_name),
    openId: (r.open_id as string | null) ?? null,
    source: String(r.source ?? 'seed'),
    updatedAt: Number(r.updated_at ?? 0),
  }
}
