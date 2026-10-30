/**
 * 成员对照表 → 身份表。
 *
 * 表格是事实源，Friday 跟着它变。这一点很重要：那张表**天天有人改**（新人入职、有人换 GitHub 账号），
 * 所以不能一次性灌进来了事——种子文件的做法一装好就开始过期。
 *
 * 表里给了三样东西：GitHub 登录名、姓名、以及一个**人员字段**（飞书的 type 11），
 * 后者直接带 open_id。有了它，「这个 PR 是谁改的、他在飞书里是谁、能不能 @」才有据可依，
 * 而不是把 `用户(a1b2c3)` 这种东西端到人面前。
 *
 * 只读。Friday 从不回写这张表——它不是我们的账本，是别人维护的名册。
 */
import type { Bitable } from '../feishu/bitable.js'
import type { Identities, RosterRow } from './identities.js'
import type { Logger } from '../log.js'

export interface IdentityDirectoryConfig {
  /** 多维表格的 app_token（成员对照表） */
  appToken: string
  /** 表 id；不填就用这个表格里的第一张表 */
  tableId?: string
  /** 列名可以覆盖——表格是别人维护的，列名被改了不该让整条链路瘫掉 */
  columns?: { login?: string; name?: string; person?: string }
}

const DEFAULT_COLUMNS = {
  login: 'GitHub ID',
  name: '人员',
  person: '人员（用于让小助手知道open_id）',
} as const

/** 飞书人员字段（type 11）的形状：一组 { id, name }，id 就是 open_id。 */
function openIdOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const entry of value) {
    const id = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined
    if (typeof id === 'string' && /^ou_[A-Za-z0-9]+$/.test(id)) return id
  }
  return undefined
}

/** 文本字段在多维表格里可能是字符串，也可能是富文本段数组。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map((seg) => (seg && typeof seg === 'object' && typeof (seg as { text?: unknown }).text === 'string' ? (seg as { text: string }).text : ''))
      .join('')
      .trim()
  }
  if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') return String((value as { text: string }).text).trim()
  return ''
}

export interface RefreshResult {
  /** 读到的行数（不含没有 GitHub 登录名的行） */
  rows: number
  /** 其中带 open_id 的行数 */
  withOpenId: number
  /** 表格一共多少行 */
  scanned: number
  /** 列名没对上时说清楚用了哪些列，便于表格改名后排查 */
  columns: { login: string; name: string; person: string }
  complete: boolean
}

export class IdentityDirectory {
  private lastRefreshMs = 0
  private inFlight?: Promise<RefreshResult>

  constructor(
    private readonly deps: { identities: Identities; bitable: Bitable; log: Logger; now?: () => number },
    private readonly config: IdentityDirectoryConfig,
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * 拉一次对照表。
   *
   * `minIntervalMs` 是给"查不到人就顺手刷一次"那条路用的：一轮里连着问好几个陌生登录名，
   * 不应该就去打好几次表格 API。同一时刻只会有一次真正的拉取在跑。
   */
  async refresh(opts: { minIntervalMs?: number } = {}): Promise<RefreshResult | undefined> {
    const min = opts.minIntervalMs ?? 0
    if (min > 0 && this.lastRefreshMs && this.now() - this.lastRefreshMs < min) return undefined
    if (this.inFlight) return this.inFlight
    this.inFlight = this.load()
    try {
      return await this.inFlight
    } finally {
      this.inFlight = undefined
    }
  }

  private async load(): Promise<RefreshResult> {
    const { identities, bitable, log } = this.deps
    const cols = { ...DEFAULT_COLUMNS, ...this.config.columns }
    let tableId = this.config.tableId
    if (!tableId) {
      const tables = await bitable.listTables(this.config.appToken)
      tableId = tables[0]?.tableId
      if (!tableId) throw new Error('成员对照表里没有任何数据表')
    }
    const { records, complete } = await bitable.listRecords(this.config.appToken, tableId, { limit: 2000 })
    const rows: RosterRow[] = []
    for (const record of records) {
      const login = textOf(record.fields[cols.login])
      if (!login) continue // 没填 GitHub 账号的行就是不参与这件事，不是错误
      const name = textOf(record.fields[cols.name])
      rows.push({ login, name: name || login, openId: openIdOf(record.fields[cols.person]) })
    }
    const written = identities.upsertFromRoster(rows, this.now())
    this.lastRefreshMs = this.now()
    const result: RefreshResult = {
      rows: written,
      withOpenId: rows.filter((r) => r.openId).length,
      scanned: records.length,
      columns: cols,
      complete,
    }
    log.info('identity roster refreshed', { ...result })
    return result
  }
}
